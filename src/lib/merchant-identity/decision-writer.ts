import { eq, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { LedgrDb } from "@/db";
import {
  merchants,
  transactionMerchantIdentityDecisions,
  transactions,
  type MerchantIdentityOutcome,
  type MerchantIdentitySource,
} from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import { scopedQuery } from "@/lib/scoped-query";
import { canonicalJson } from "@/lib/categorization/fingerprint";
import { createHash } from "node:crypto";
import {
  parseMerchantIdentityEvidence,
  type MerchantIdentityEvidence,
} from "./evidence";

export const MERCHANT_IDENTITY_ENGINE_VERSION = "merchant-identity-v1";
export const MERCHANT_IDENTITY_PRIORITY = {
  unresolved: 0,
  legacy: 100,
  canonicalName: 300,
  globalAlias: 390,
  providerAlias: 400,
  providerCounterparty: 490,
  providerMerchant: 500,
  manual: 600,
} as const;

export interface MerchantIdentityDecisionInput {
  transactionId: string;
  merchantId: string | null;
  source: MerchantIdentitySource;
  outcome: MerchantIdentityOutcome;
  identifierId?: string | null;
  aliasId?: string | null;
  decisionPriority: number;
  evidence: MerchantIdentityEvidence;
  engineVersion?: string;
  decidedAt?: Date | null;
}

export type MerchantIdentityDecisionResult =
  | { applied: true; decisionId: string }
  | { applied: false; reason: "manual" | "unchanged" };

function fingerprint(value: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateDecisionSemantics(
  input: MerchantIdentityDecisionInput,
  evidence: MerchantIdentityEvidence,
): void {
  const merchantAssigned = input.merchantId !== null;
  const valid =
    (evidence.kind === "manual"
      && input.source === "manual"
      && ((input.outcome === "assigned" && merchantAssigned)
        || (input.outcome === "cleared" && !merchantAssigned)))
    || (evidence.kind === "provider"
      && ["provider_merchant", "provider_counterparty"].includes(input.source)
      && input.outcome === "assigned"
      && merchantAssigned)
    || (evidence.kind === "alias"
      && input.source === "approved_alias"
      && input.outcome === "assigned"
      && merchantAssigned)
    || (evidence.kind === "canonical_name"
      && input.source === "verified_canonical_name"
      && input.outcome === "assigned"
      && merchantAssigned)
    || (evidence.kind === "inheritance"
      && ["manual", "pending_inheritance"].includes(input.source)
      && input.outcome === "inherited")
    || (evidence.kind === "legacy"
      && input.source === "legacy_unknown"
      && ["legacy_snapshot", "conflict_preserved"].includes(input.outcome)
      && merchantAssigned)
    || (evidence.kind === "unresolved"
      && input.source === "legacy_unknown"
      && ["unresolved", "ambiguous"].includes(input.outcome)
      && !merchantAssigned);
  if (!valid) throw new Error("Merchant identity source, outcome, and evidence do not agree");
}

export async function applyMerchantIdentityDecision(
  householdId: string,
  input: MerchantIdentityDecisionInput,
  db: LedgrDb,
): Promise<MerchantIdentityDecisionResult> {
  return withHousehold(
    householdId,
    (tx) => applyMerchantIdentityDecisionInTransaction(householdId, input, tx),
    db,
  );
}

export async function applyMerchantIdentityDecisionInTransaction(
  householdId: string,
  input: MerchantIdentityDecisionInput,
  db: LedgrDb,
): Promise<MerchantIdentityDecisionResult> {
  const scoped = scopedQuery(householdId, db);
  const evidence = parseMerchantIdentityEvidence(input.evidence);
  validateDecisionSemantics(input, evidence);
  const [txn] = await db.select({
    id: transactions.id,
    merchantId: transactions.merchantId,
    decisionId: transactions.merchantIdentityDecisionId,
  }).from(transactions)
    .where(scoped.where(
      transactions,
      eq(transactions.id, input.transactionId),
      input.source === "manual" ? isNull(transactions.deletedAt) : undefined,
    ))
    .for("update")
    .limit(1);
  if (!txn) throw new Error("Transaction not found");

  const [current] = txn.decisionId
    ? await db.select().from(transactionMerchantIdentityDecisions)
      .where(scoped.where(
        transactionMerchantIdentityDecisions,
        eq(transactionMerchantIdentityDecisions.id, txn.decisionId),
      )).limit(1)
    : [];

  if (current?.source === "manual" && input.source !== "manual") {
    return { applied: false, reason: "manual" };
  }

  // Automated evidence may refine an equal-or-weaker decision, but must never
  // downgrade a stronger current identity (for example provider ID -> alias or
  // assigned identity -> unresolved).
  if (current
    && input.source !== "manual"
    && input.decisionPriority < current.decisionPriority) {
    return { applied: false, reason: "unchanged" };
  }

  let merchantName: string | null = null;
  if (input.merchantId) {
    const [ownedMerchant] = await db.select({
      id: merchants.id,
      name: merchants.name,
    }).from(merchants)
      .where(scoped.where(merchants, eq(merchants.id, input.merchantId)))
      .for("share")
      .limit(1);
    if (!ownedMerchant) throw new Error("Merchant not found");
    merchantName = ownedMerchant.name;
  }

  const evidenceMerchant = "merchant" in evidence ? evidence.merchant : undefined;
  if (evidenceMerchant !== undefined) {
    if ((evidenceMerchant?.id ?? null) !== input.merchantId
      || (evidenceMerchant?.name ?? null) !== merchantName) {
      throw new Error("Merchant identity evidence does not match owned merchant");
    }
  }

  const engineVersion = input.engineVersion ?? MERCHANT_IDENTITY_ENGINE_VERSION;
  const identifierId = input.identifierId ?? null;
  const aliasId = input.aliasId ?? null;
  if (current
    && current.merchantId === input.merchantId
    && current.source === input.source
    && current.outcome === input.outcome
    && current.identifierId === identifierId
    && current.aliasId === aliasId
    && current.decisionPriority === input.decisionPriority
    && current.engineVersion === engineVersion
    && canonicalJson(current.evidence) === canonicalJson(evidence)) {
    return { applied: false, reason: "unchanged" };
  }

  const decisionFingerprint = fingerprint({
    version: 1,
    transactionId: txn.id,
    previousDecisionId: txn.decisionId,
    merchantId: input.merchantId,
    source: input.source,
    outcome: input.outcome,
    identifierId,
    aliasId,
    decisionPriority: input.decisionPriority,
    evidence,
    engineVersion,
  });
  const decisionId = uuid();
  await db.insert(transactionMerchantIdentityDecisions).values({
    id: decisionId,
    householdId,
    transactionId: txn.id,
    merchantId: input.merchantId,
    source: input.source,
    outcome: input.outcome,
    identifierId,
    aliasId,
    decisionPriority: input.decisionPriority,
    evidence,
    engineVersion,
    previousDecisionId: txn.decisionId,
    fingerprint: decisionFingerprint,
    decidedAt: input.decidedAt === undefined ? new Date() : input.decidedAt,
  });
  await db.update(transactions).set({
    merchantId: input.merchantId,
    merchantIdentityDecisionId: decisionId,
    updatedAt: new Date(),
  }).where(scoped.where(transactions, eq(transactions.id, txn.id)));

  return { applied: true, decisionId };
}
