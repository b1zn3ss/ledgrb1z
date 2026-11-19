import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { LedgrDb } from "../../src/db";
import {
  transactionClassificationDecisions,
  transactions,
  categoryRules,
  categories,
  transactionSplits,
  households,
} from "../../src/db/schema";
import {
  applyClassificationDecision,
  CLASSIFICATION_PRIORITY,
} from "../../src/lib/categorization/decision-writer";
import { classificationMatchValueHash } from "../../src/lib/categorization/evidence";
import { withHousehold } from "../../src/lib/household-context";
import { createTestDb } from "./setup";
import {
  getClassificationDecisionHistory,
  getCurrentClassificationDecisions,
} from "../../src/queries/classification-decisions";
import {
  insertAccount,
  insertCategory,
  insertCategoryGroup,
  insertCategoryRule,
  insertHousehold,
  insertTransaction,
  insertTransactionSplit,
} from "./helpers";

describe("classification provenance", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;
  let accountId: string;
  let categoryA: string;
  let categoryB: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db));
    ({ accountId } = await insertAccount(db, householdId));
    const { groupId } = await insertCategoryGroup(db, householdId);
    ({ categoryId: categoryA } = await insertCategory(db, householdId, groupId, { name: "Category A" }));
    ({ categoryId: categoryB } = await insertCategory(db, householdId, groupId, { name: "Category B" }));
  });

  afterAll(async () => close());

  function manualInput(transactionId: string, categoryId: string, name: string) {
    return {
      transactionId,
      categoryId,
      source: "manual" as const,
      decisionPriority: CLASSIFICATION_PRIORITY.manual,
      evidence: {
        version: 1 as const,
        kind: "manual" as const,
        trigger: "single" as const,
        category: { id: categoryId, name },
      },
    };
  }

  it("is retry-idempotent while allowing A -> B -> A", async () => {
    const { transactionId } = await insertTransaction(db, householdId, accountId);

    await applyClassificationDecision(householdId, manualInput(transactionId, categoryA, "Category A"), db);
    const replay = await applyClassificationDecision(
      householdId,
      manualInput(transactionId, categoryA, "Category A"),
      db,
    );
    expect(replay).toEqual({ applied: false, reason: "unchanged" });

    await applyClassificationDecision(householdId, manualInput(transactionId, categoryB, "Category B"), db);
    await applyClassificationDecision(householdId, manualInput(transactionId, categoryA, "Category A"), db);

    const decisions = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.transactionId, transactionId));
    expect(decisions).toHaveLength(3);
    expect(new Set(decisions.map((row) => row.fingerprint)).size).toBe(3);
    const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    expect(row.categoryId).toBe(categoryA);
    expect(row.categorySource).toBe("manual");
    const current = decisions.find((decision) => decision.id === row.classificationDecisionId);
    const firstA = decisions.find((decision) => decision.categoryId === categoryA
      && decision.id !== row.classificationDecisionId);
    expect(current?.categoryId).toBe(categoryA);
    expect(current?.fingerprint).not.toBe(firstA?.fingerprint);
  });

  it("uses split-level uniqueness and skips an unchanged split replay", async () => {
    const { transactionId } = await insertTransaction(db, householdId, accountId);
    const { splitId } = await insertTransactionSplit(db, transactionId, categoryA, 500);
    const input = {
      transactionId,
      subjectType: "split" as const,
      transactionSplitId: splitId,
      categoryId: categoryA,
      source: "manual" as const,
      decisionPriority: CLASSIFICATION_PRIORITY.manual,
      evidence: {
        version: 1 as const,
        kind: "manual" as const,
        trigger: "split_create" as const,
        category: { id: categoryA, name: "Category A" },
      },
    };
    await applyClassificationDecision(householdId, input, db);
    await expect(applyClassificationDecision(householdId, input, db))
      .resolves.toEqual({ applied: false, reason: "unchanged" });

    const decisions = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.transactionSplitId, splitId));
    const [split] = await db.select().from(transactionSplits)
      .where(eq(transactionSplits.id, splitId));
    expect(decisions).toHaveLength(1);
    expect(split.classificationDecisionId).toBe(decisions[0].id);
  });

  it("serializes manual and automated writes so manual always wins", async () => {
    const { ruleId } = await insertCategoryRule(db, householdId, categoryB, {
      matchPattern: "race",
      priority: 10,
    });
    const { transactionId } = await insertTransaction(db, householdId, accountId, { name: "race merchant" });

    const automated = applyClassificationDecision(householdId, {
      transactionId,
      categoryId: categoryB,
      source: "rule",
      ruleId,
      decisionPriority: CLASSIFICATION_PRIORITY.rule,
      onlyIfUncategorized: true,
      evidence: {
        version: 1,
        kind: "rule",
        category: { id: categoryB, name: "Category B" },
        rule: {
          id: ruleId,
          matchField: "name",
          matchPattern: "race",
          matchedValueHash: classificationMatchValueHash("race merchant"),
          priority: 10,
          tieBreaker: ruleId,
        },
      },
    }, db);
    const manual = applyClassificationDecision(
      householdId,
      manualInput(transactionId, categoryA, "Category A"),
      db,
    );
    await Promise.all([automated, manual]);

    const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    const [current] = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.id, row.classificationDecisionId!));
    expect(row.categoryId).toBe(categoryA);
    expect(row.categorySource).toBe("manual");
    expect(current.source).toBe("manual");
    expect(current.categoryId).toBe(categoryA);
  });

  it("rejects state changes when provenance validation fails", async () => {
    const { transactionId } = await insertTransaction(db, householdId, accountId);
    const invalid = manualInput(transactionId, categoryA, "Wrong historical name");
    await expect(applyClassificationDecision(householdId, invalid, db)).rejects.toThrow(
      "Classification evidence category does not match owned category",
    );

    const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    const decisions = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.transactionId, transactionId));
    expect(row.categoryId).toBeNull();
    expect(row.classificationDecisionId).toBeNull();
    expect(decisions).toHaveLength(0);

    const { ruleId } = await insertCategoryRule(db, householdId, categoryA, {
      matchPattern: "actual",
      priority: 3,
    });
    await expect(applyClassificationDecision(householdId, {
      transactionId,
      categoryId: categoryA,
      source: "rule",
      ruleId,
      decisionPriority: CLASSIFICATION_PRIORITY.rule,
      evidence: {
        version: 1,
        kind: "rule",
        category: { id: categoryA, name: "Category A" },
        rule: {
          id: ruleId,
          matchField: "name",
          matchPattern: "actual",
          matchedValueHash: classificationMatchValueHash("fabricated actual match"),
          priority: 3,
          tieBreaker: ruleId,
        },
      },
    }, db)).rejects.toThrow("Rule evidence does not match the owned rule");

    const afterRuleFailure = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.transactionId, transactionId));
    expect(afterRuleFailure).toHaveLength(0);

    await expect(applyClassificationDecision(householdId, {
      ...manualInput(transactionId, categoryA, "Category A"),
      source: "rule",
    }, db)).rejects.toThrow("Classification source does not match its evidence");
  });

  it("keeps rule evidence after the mutable rule is changed and deleted", async () => {
    const { ruleId } = await insertCategoryRule(db, householdId, categoryA, {
      matchPattern: "original pattern",
      priority: 7,
    });
    const { transactionId } = await insertTransaction(db, householdId, accountId, {
      name: "original pattern charge",
    });
    const result = await applyClassificationDecision(householdId, {
      transactionId,
      categoryId: categoryA,
      source: "rule",
      ruleId,
      decisionPriority: CLASSIFICATION_PRIORITY.rule,
      onlyIfUncategorized: true,
      evidence: {
        version: 1,
        kind: "rule",
        category: { id: categoryA, name: "Category A" },
        rule: {
          id: ruleId,
          matchField: "name",
          matchPattern: "original pattern",
          matchedValueHash: classificationMatchValueHash("original pattern charge"),
          priority: 7,
          tieBreaker: ruleId,
        },
      },
    }, db);
    if (!result.applied) throw new Error("expected decision");

    await db.update(categoryRules).set({ matchPattern: "changed" })
      .where(eq(categoryRules.id, ruleId));
    await db.delete(categoryRules).where(eq(categoryRules.id, ruleId));
    const [decision] = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.id, result.decisionId));
    expect(decision.ruleId).toBe(ruleId);
    expect(decision.evidence).toMatchObject({
      kind: "rule",
      rule: { matchPattern: "original pattern", priority: 7 },
    });
  });

  it("keeps category snapshots after a no-longer-current category is deleted", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId, { name: "Deletion group" });
    const oldCategory = await insertCategory(db, householdId, groupId, { name: "Old category" });
    const newCategory = await insertCategory(db, householdId, groupId, { name: "New category" });
    const { transactionId } = await insertTransaction(db, householdId, accountId);
    await applyClassificationDecision(
      householdId,
      manualInput(transactionId, oldCategory.categoryId, "Old category"),
      db,
    );
    await applyClassificationDecision(
      householdId,
      manualInput(transactionId, newCategory.categoryId, "New category"),
      db,
    );
    await db.delete(categories).where(eq(categories.id, oldCategory.categoryId));

    const [historical] = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.categoryId, oldCategory.categoryId));
    expect(historical.categoryId).toBe(oldCategory.categoryId);
    expect(historical.evidence).toMatchObject({
      category: { id: oldCategory.categoryId, name: "Old category" },
    });
  });

  it("enforces immutable history while permitting hard-transaction cascades", async () => {
    const { transactionId } = await insertTransaction(db, householdId, accountId);
    const applied = await applyClassificationDecision(
      householdId,
      manualInput(transactionId, categoryA, "Category A"),
      db,
    );
    if (!applied.applied) throw new Error("expected decision");

    await expect(db.update(transactionClassificationDecisions)
      .set({ source: "pfc" })
      .where(eq(transactionClassificationDecisions.id, applied.decisionId)))
      .rejects.toMatchObject({
        cause: { message: expect.stringContaining("classification decision history is immutable") },
      });
    await expect(db.delete(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.id, applied.decisionId)))
      .rejects.toMatchObject({
        cause: { message: expect.stringContaining("classification decision history is append-only") },
      });

    await db.delete(transactions).where(eq(transactions.id, transactionId));
    const decisions = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.transactionId, transactionId));
    expect(decisions).toHaveLength(0);
  });

  it("cascades decision history only as part of hard household lifecycle deletion", async () => {
    const isolated = await insertHousehold(db, "Cascade Household");
    const isolatedAccount = await insertAccount(db, isolated.householdId);
    const isolatedGroup = await insertCategoryGroup(db, isolated.householdId);
    const isolatedCategory = await insertCategory(
      db,
      isolated.householdId,
      isolatedGroup.groupId,
      { name: "Cascade Category" },
    );
    const isolatedTxn = await insertTransaction(db, isolated.householdId, isolatedAccount.accountId);
    const applied = await applyClassificationDecision(
      isolated.householdId,
      manualInput(isolatedTxn.transactionId, isolatedCategory.categoryId, "Cascade Category"),
      db,
    );
    if (!applied.applied) throw new Error("expected decision");

    await db.delete(households).where(eq(households.id, isolated.householdId));

    const decisions = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.id, applied.decisionId));
    expect(decisions).toHaveLength(0);
  });

  it("rejects cross-transaction pointers and cross-household categories", async () => {
    const first = await insertTransaction(db, householdId, accountId);
    const second = await insertTransaction(db, householdId, accountId);
    const applied = await applyClassificationDecision(
      householdId,
      manualInput(first.transactionId, categoryA, "Category A"),
      db,
    );
    if (!applied.applied) throw new Error("expected decision");

    await expect(db.update(transactions)
      .set({ classificationDecisionId: applied.decisionId })
      .where(eq(transactions.id, second.transactionId)))
      .rejects.toMatchObject({
        cause: { message: expect.stringContaining("invalid transaction classification decision pointer") },
      });

    const other = await insertHousehold(db, "Other Household");
    const otherAccount = await insertAccount(db, other.householdId);
    const otherGroup = await insertCategoryGroup(db, other.householdId);
    const otherCategory = await insertCategory(db, other.householdId, otherGroup.groupId, {
      name: "Other Category",
    });
    const otherTxn = await insertTransaction(db, other.householdId, otherAccount.accountId);
    await expect(db.update(transactions)
      .set({ householdId: other.householdId })
      .where(eq(transactions.id, first.transactionId)))
      .rejects.toMatchObject({
        cause: { message: expect.stringContaining("invalid transaction classification decision pointer") },
      });
    await expect(applyClassificationDecision(other.householdId, {
      ...manualInput(otherTxn.transactionId, categoryA, "Category A"),
      transactionId: otherTxn.transactionId,
    }, db)).rejects.toThrow("Category not found");

    const [row] = await db.select().from(transactions)
      .where(eq(transactions.id, otherTxn.transactionId));
    expect(row.categoryId).toBeNull();
    expect(row.classificationDecisionId).toBeNull();
    expect(otherCategory.categoryId).not.toBe(categoryA);

    const ownedHistory = await getClassificationDecisionHistory(
      householdId,
      first.transactionId,
      db,
    );
    expect(ownedHistory).toHaveLength(1);
    await expect(getClassificationDecisionHistory(
      other.householdId,
      first.transactionId,
      db,
    )).resolves.toEqual([]);
    await expect(getCurrentClassificationDecisions(
      other.householdId,
      first.transactionId,
      db,
    )).resolves.toBeNull();
  });

  it("rolls back a decision insert when its pointer update fails", async () => {
    const source = await insertTransaction(db, householdId, accountId);
    const wrongTarget = await insertTransaction(db, householdId, accountId);
    const decisionId = uuid();

    await expect(withHousehold(householdId, async (tx) => {
      await tx.insert(transactionClassificationDecisions).values({
        id: decisionId,
        householdId,
        transactionId: source.transactionId,
        subjectType: "transaction",
        transactionSplitId: null,
        categoryId: categoryA,
        source: "manual",
        decisionPriority: CLASSIFICATION_PRIORITY.manual,
        outcome: "applied",
        evidence: {
          version: 1,
          kind: "manual",
          trigger: "single",
          category: { id: categoryA, name: "Category A" },
        },
        engineVersion: "rollback-test-v1",
        fingerprint: `rollback-test:${decisionId}`,
        decidedAt: new Date(),
      });
      await tx.update(transactions)
        .set({ classificationDecisionId: decisionId })
        .where(eq(transactions.id, wrongTarget.transactionId));
    }, db)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("invalid transaction classification decision pointer") },
    });

    const decisions = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.id, decisionId));
    const [target] = await db.select().from(transactions)
      .where(eq(transactions.id, wrongTarget.transactionId));
    expect(decisions).toHaveLength(0);
    expect(target.classificationDecisionId).toBeNull();
  });
});
