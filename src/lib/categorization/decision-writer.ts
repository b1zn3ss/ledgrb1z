import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { LedgrDb } from "@/db";
import {
  categories,
  categoryRules,
  merchants,
  transactionClassificationDecisions,
  transactionSplits,
  transactions,
  type ClassificationDecisionOutcome,
  type ClassificationDecisionSource,
} from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import { scopedQuery } from "@/lib/scoped-query";
import { isMerchantIdentityResolutionEnabled } from "@/lib/merchant-identity/flags";
import { canonicalJson, classificationDecisionFingerprint } from "./fingerprint";
import {
  classificationMatchValueHash,
  parseClassificationEvidence,
  type ClassificationEvidence,
} from "./evidence";

export const CLASSIFICATION_ENGINE_VERSION = "deterministic-v1";
export const CLASSIFICATION_PRIORITY = {
  legacy: 0,
  pfc: 100,
  merchantDefault: 200,
  rule: 300,
  manual: 400,
} as const;

export interface ClassificationDecisionInput {
  transactionId: string;
  subjectType?: "transaction" | "split";
  transactionSplitId?: string | null;
  categoryId: string | null;
  source: ClassificationDecisionSource;
  /** Preserve an observed legacy state when it differs from the audit source. */
  categorySourceValue?: string | null;
  ruleId?: string | null;
  merchantId?: string | null;
  decisionPriority: number;
  outcome?: ClassificationDecisionOutcome;
  evidence: ClassificationEvidence;
  engineVersion?: string;
  decidedAt?: Date | null;
  reviewed?: boolean;
  onlyIfUncategorized?: boolean;
}

export type ClassificationDecisionResult =
  | { applied: true; decisionId: string }
  | { applied: false; reason: "manual" | "already_classified" | "unchanged" };

function sameCurrentDecision(
  current: typeof transactionClassificationDecisions.$inferSelect | undefined,
  input: Required<Pick<ClassificationDecisionInput, "categoryId" | "source" | "decisionPriority">> &
    ClassificationDecisionInput,
  evidence: ClassificationEvidence,
): boolean {
  return !!current
    && current.categoryId === input.categoryId
    && current.source === input.source
    && current.ruleId === (input.ruleId ?? null)
    && current.merchantId === (input.merchantId ?? null)
    && current.decisionPriority === input.decisionPriority
    && current.outcome === (input.outcome ?? "applied")
    && current.engineVersion === (input.engineVersion ?? CLASSIFICATION_ENGINE_VERSION)
    && canonicalJson(current.evidence) === canonicalJson(evidence);
}

export async function applyClassificationDecision(
  householdId: string,
  input: ClassificationDecisionInput,
  db: LedgrDb,
): Promise<ClassificationDecisionResult> {
  return withHousehold(
    householdId,
    (tx) => applyClassificationDecisionInTransaction(householdId, input, tx),
    db,
  );
}

export async function applyClassificationDecisionInTransaction(
  householdId: string,
  input: ClassificationDecisionInput,
  db: LedgrDb,
): Promise<ClassificationDecisionResult> {
  const scoped = scopedQuery(householdId, db);
  const subjectType = input.subjectType ?? "transaction";
  const splitId = input.transactionSplitId ?? null;
  const evidence = parseClassificationEvidence(input.evidence);

  const [txn] = await db.select({
    id: transactions.id,
    name: transactions.name,
    merchantId: transactions.merchantId,
    categoryId: transactions.categoryId,
    categorySource: transactions.categorySource,
    classificationDecisionId: transactions.classificationDecisionId,
    pfcDetailed: transactions.pfcDetailed,
  }).from(transactions)
    .where(scoped.where(transactions, eq(transactions.id, input.transactionId)))
    .for("update")
    .limit(1);
  if (!txn) throw new Error("Transaction not found");

  let previousDecisionId = txn.classificationDecisionId;
  if (subjectType === "split") {
    if (!splitId || input.categoryId === null) throw new Error("Split classification requires a category");
    const [split] = await db.select({
      id: transactionSplits.id,
      classificationDecisionId: transactionSplits.classificationDecisionId,
    }).from(transactionSplits)
      .where(and(eq(transactionSplits.id, splitId), eq(transactionSplits.transactionId, txn.id)))
      .for("update")
      .limit(1);
    if (!split) throw new Error("Split not found");
    previousDecisionId = split.classificationDecisionId;
  } else if (input.onlyIfUncategorized) {
    if (txn.categorySource === "manual") return { applied: false, reason: "manual" };
    if (txn.categoryId !== null) return { applied: false, reason: "already_classified" };
  }

  let categoryName: string | null = null;
  if (input.categoryId !== null) {
    const [category] = await db.select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(scoped.where(categories, eq(categories.id, input.categoryId)))
      .for("share")
      .limit(1);
    if (!category) throw new Error("Category not found");
    categoryName = category.name;
  }
  if ((evidence.category?.id ?? null) !== input.categoryId
    || (evidence.category?.name ?? null) !== categoryName) {
    throw new Error("Classification evidence category does not match owned category");
  }

  const outcome = input.outcome ?? "applied";
  if (outcome === "inherited" || outcome === "inheritance_limited") {
    if (evidence.kind !== "inheritance") {
      throw new Error("Inherited classification requires inheritance evidence");
    }
  } else if (outcome === "legacy_snapshot") {
    if (evidence.kind !== "legacy" || input.decidedAt !== null) {
      throw new Error("Legacy snapshot requires unknown-time legacy evidence");
    }
  } else if (
    (input.source === "manual" && evidence.kind !== "manual")
    || (input.source === "rule" && (!input.ruleId || evidence.kind !== "rule"))
    || (input.source === "merchant_default" && (!input.merchantId || evidence.kind !== "merchant_default"))
    || (input.source === "pfc" && evidence.kind !== "pfc")
    || input.source === "ai"
    || input.source === "ai_low_confidence"
    || input.source === "legacy_unknown"
  ) {
    throw new Error("Classification source does not match its evidence");
  }

  if (input.ruleId) {
    const [rule] = await db.select({
      id: categoryRules.id,
      categoryId: categoryRules.categoryId,
      matchField: categoryRules.matchField,
      matchPattern: categoryRules.matchPattern,
      priority: categoryRules.priority,
    })
      .from(categoryRules)
      .where(scoped.where(categoryRules, eq(categoryRules.id, input.ruleId)))
      .for("share")
      .limit(1);
    if (!rule || rule.categoryId !== input.categoryId) throw new Error("Rule not found");
    let matchedValue = txn.name;
    if (rule.matchField === "merchant") {
      if (!txn.merchantId) throw new Error("Rule evidence does not match the transaction");
      const [matchedMerchant] = await db.select({ name: merchants.name })
        .from(merchants)
        .where(scoped.where(merchants, eq(merchants.id, txn.merchantId)))
        .for("share")
        .limit(1);
      if (!matchedMerchant) throw new Error("Rule evidence does not match the transaction");
      matchedValue = matchedMerchant.name;
    }
    if (evidence.kind !== "rule"
      || evidence.rule.id !== rule.id
      || evidence.rule.matchField !== (rule.matchField ?? "name")
      || evidence.rule.matchPattern !== rule.matchPattern
      || evidence.rule.matchedValueHash !== classificationMatchValueHash(matchedValue)
      || evidence.rule.priority !== (rule.priority ?? 0)
      || evidence.rule.tieBreaker !== rule.id
      || !matchedValue.toLowerCase().includes(rule.matchPattern.toLowerCase())) {
      throw new Error("Rule evidence does not match the owned rule");
    }
  }
  if (input.merchantId) {
    const [merchant] = await db.select({
      id: merchants.id,
      name: merchants.name,
      categoryId: merchants.categoryId,
      categoryDefaultApprovedAt: merchants.categoryDefaultApprovedAt,
    })
      .from(merchants)
      .where(scoped.where(merchants, eq(merchants.id, input.merchantId)))
      .for("share")
      .limit(1);
    if (!merchant || merchant.categoryId !== input.categoryId || txn.merchantId !== merchant.id) {
      throw new Error("Merchant not found");
    }
    if (input.source === "merchant_default"
      && isMerchantIdentityResolutionEnabled()
      && !merchant.categoryDefaultApprovedAt) {
      throw new Error("Merchant default is not explicitly approved");
    }
    if (evidence.kind !== "merchant_default"
      || evidence.merchant.id !== merchant.id
      || evidence.merchant.name !== merchant.name
      || (evidence.defaultApprovedAt ?? null)
        !== (merchant.categoryDefaultApprovedAt?.toISOString() ?? null)) {
      throw new Error("Merchant evidence does not match the owned merchant");
    }
  }
  if (input.source === "pfc" && (input.outcome ?? "applied") === "applied") {
    if (evidence.kind !== "pfc"
      || evidence.detailedCode !== txn.pfcDetailed
      || evidence.mappedCategoryName !== categoryName) {
      throw new Error("PFC evidence does not match the transaction");
    }
  }

  const [current] = previousDecisionId
    ? await db.select().from(transactionClassificationDecisions)
      .where(scoped.where(
        transactionClassificationDecisions,
        eq(transactionClassificationDecisions.id, previousDecisionId),
      )).limit(1)
    : [];
  if (sameCurrentDecision(current, input, evidence)) {
    return { applied: false, reason: "unchanged" };
  }

  const engineVersion = input.engineVersion ?? CLASSIFICATION_ENGINE_VERSION;
  const fingerprint = classificationDecisionFingerprint({
    transactionId: txn.id,
    subjectType,
    transactionSplitId: splitId,
    categoryId: input.categoryId,
    source: input.source,
    ruleId: input.ruleId ?? null,
    merchantId: input.merchantId ?? null,
    decisionPriority: input.decisionPriority,
    outcome,
    evidence,
    engineVersion,
    previousDecisionId,
  });
  const decisionId = uuid();

  await db.insert(transactionClassificationDecisions).values({
    id: decisionId,
    householdId,
    transactionId: txn.id,
    subjectType,
    transactionSplitId: splitId,
    categoryId: input.categoryId,
    source: input.source,
    ruleId: input.ruleId ?? null,
    merchantId: input.merchantId ?? null,
    decisionPriority: input.decisionPriority,
    outcome,
    evidence,
    engineVersion,
    fingerprint,
    decidedAt: input.decidedAt === undefined ? new Date() : input.decidedAt,
  });

  if (subjectType === "split") {
    await db.update(transactionSplits).set({
      categoryId: input.categoryId!,
      classificationDecisionId: decisionId,
    }).where(and(eq(transactionSplits.id, splitId!), eq(transactionSplits.transactionId, txn.id)));
  } else {
    await db.update(transactions).set({
      categoryId: input.categoryId,
      categorySource: input.categorySourceValue === undefined ? input.source : input.categorySourceValue,
      classificationDecisionId: decisionId,
      ...(input.reviewed === undefined ? {} : { reviewed: input.reviewed }),
      updatedAt: new Date(),
    }).where(scoped.where(transactions, eq(transactions.id, txn.id)));
  }
  return { applied: true, decisionId };
}

/** Records the terminal state of a split before its canonical row is deleted. */
export async function recordSplitDeletionDecisionInTransaction(
  householdId: string,
  transactionId: string,
  splitId: string,
  db: LedgrDb,
): Promise<string> {
  const scoped = scopedQuery(householdId, db);
  const [txn] = await db.select({ id: transactions.id })
    .from(transactions)
    .where(scoped.where(transactions, eq(transactions.id, transactionId)))
    .for("update")
    .limit(1);
  if (!txn) throw new Error("Transaction not found");

  const [split] = await db.select({
    id: transactionSplits.id,
    categoryId: transactionSplits.categoryId,
    classificationDecisionId: transactionSplits.classificationDecisionId,
    categoryName: categories.name,
  }).from(transactionSplits)
    .innerJoin(categories, eq(categories.id, transactionSplits.categoryId))
    .where(and(
      eq(transactionSplits.id, splitId),
      eq(transactionSplits.transactionId, transactionId),
      eq(categories.householdId, householdId),
    ))
    .for("update")
    .limit(1);
  if (!split) throw new Error("Split not found");

  const evidence: ClassificationEvidence = {
    version: 1,
    kind: "manual",
    trigger: "split_delete",
    category: { id: split.categoryId, name: split.categoryName },
  };
  const fingerprint = classificationDecisionFingerprint({
    transactionId,
    subjectType: "split",
    transactionSplitId: splitId,
    categoryId: split.categoryId,
    source: "manual",
    ruleId: null,
    merchantId: null,
    decisionPriority: CLASSIFICATION_PRIORITY.manual,
    outcome: "applied",
    evidence,
    engineVersion: CLASSIFICATION_ENGINE_VERSION,
    previousDecisionId: split.classificationDecisionId,
  });
  const decisionId = uuid();
  await db.insert(transactionClassificationDecisions).values({
    id: decisionId,
    householdId,
    transactionId,
    subjectType: "split",
    transactionSplitId: splitId,
    categoryId: split.categoryId,
    source: "manual",
    decisionPriority: CLASSIFICATION_PRIORITY.manual,
    outcome: "applied",
    evidence,
    engineVersion: CLASSIFICATION_ENGINE_VERSION,
    fingerprint,
    decidedAt: new Date(),
  });
  return decisionId;
}
