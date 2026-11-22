import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { LedgrDb } from "../../src/db";
import {
  accounts,
  merchantAliases,
  merchantIdentifiers,
  merchants,
  transactionMerchantIdentityDecisions,
  transactions,
  transactionSplits,
} from "../../src/db/schema";
import {
  approveMerchantAliasScoped,
  assignTransactionMerchantScoped,
  revokeMerchantAliasScoped,
} from "../../src/actions/merchant-identity";
import {
  applyClassificationDecision,
  CLASSIFICATION_PRIORITY,
} from "../../src/lib/categorization/decision-writer";
import {
  applyMerchantIdentityDecision,
  MERCHANT_IDENTITY_PRIORITY,
} from "../../src/lib/merchant-identity/decision-writer";
import {
  resolveMerchantIdentityInTransaction,
  type ResolveMerchantIdentityInput,
} from "../../src/lib/merchant-identity/resolver";
import { withHousehold } from "../../src/lib/household-context";
import {
  getCurrentMerchantIdentityDecision,
  getMerchantIdentityDecisionHistory,
} from "../../src/queries/merchant-identity-decisions";
import { createTestDb } from "./setup";
import {
  insertAccount,
  insertCategory,
  insertCategoryGroup,
  insertHousehold,
  insertMerchant,
  insertTransaction,
  insertTransactionSplit,
} from "./helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("merchant identity", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  let householdId: string;
  let accountId: string;
  let otherHouseholdId: string;
  let otherAccountId: string;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    ({ householdId } = await insertHousehold(db, "Identity household"));
    ({ accountId } = await insertAccount(db, householdId, { currentBalance: 123_456 }));
    ({ householdId: otherHouseholdId } = await insertHousehold(db, "Other household"));
    ({ accountId: otherAccountId } = await insertAccount(db, otherHouseholdId));
  });

  afterAll(async () => close());

  function providerInput(
    transactionId: string,
    identifier: string,
    displayName = "Stable Merchant",
  ): ResolveMerchantIdentityInput {
    return {
      transactionId,
      provider: "plaid",
      displayName,
      aliasObservation: `${displayName} raw bank text`,
      identifiers: [{
        identifierType: "plaid_merchant_entity_id",
        value: identifier,
        source: "provider_merchant",
        role: "merchant",
        confidence: "VERY_HIGH",
      }],
    };
  }

  function resolve(
    targetHouseholdId: string,
    input: ResolveMerchantIdentityInput,
  ) {
    return withHousehold(
      targetHouseholdId,
      (tx) => resolveMerchantIdentityInTransaction(targetHouseholdId, input, tx),
      db,
    );
  }

  it("protects manual assignment and manual null without changing classification or accounting", async () => {
    const { groupId } = await insertCategoryGroup(db, householdId);
    const { categoryId } = await insertCategory(db, householdId, groupId);
    const { merchantId } = await insertMerchant(db, householdId, { name: "Chosen merchant" });
    const { transactionId } = await insertTransaction(db, householdId, accountId, {
      amount: 4_321,
      normalizedAmount: -4_321,
      isTransfer: true,
      transferSource: "manual",
    });
    await applyClassificationDecision(householdId, {
      transactionId,
      categoryId,
      source: "manual",
      decisionPriority: CLASSIFICATION_PRIORITY.manual,
      evidence: {
        version: 1,
        kind: "manual",
        trigger: "single",
        category: { id: categoryId, name: "Test Category" },
      },
    }, db);
    const { splitId } = await insertTransactionSplit(db, transactionId, categoryId, 1_234);
    const [classifiedBefore] = await db.select().from(transactions)
      .where(eq(transactions.id, transactionId));

    await expect(assignTransactionMerchantScoped(
      householdId,
      transactionId,
      merchantId,
      db,
    )).resolves.toMatchObject({ success: true });
    const automated = await resolve(householdId, providerInput(
      transactionId,
      "different-provider-merchant",
    ));
    expect(automated.status).toBe("protected");

    const [after] = await db.select().from(transactions)
      .where(eq(transactions.id, transactionId));
    const [split] = await db.select().from(transactionSplits)
      .where(eq(transactionSplits.id, splitId));
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(after).toMatchObject({
      merchantId,
      categoryId,
      categorySource: "manual",
      classificationDecisionId: classifiedBefore.classificationDecisionId,
      amount: 4_321,
      normalizedAmount: -4_321,
      isTransfer: true,
      transferSource: "manual",
    });
    expect(split).toMatchObject({ categoryId, amount: 1_234 });
    expect(account.currentBalance).toBe(123_456);
    const [manuallySelectedMerchant] = await db.select().from(merchants)
      .where(eq(merchants.id, merchantId));
    expect(manuallySelectedMerchant.identityStatus).toBe("legacy_unverified");

    const { transactionId: clearedId } = await insertTransaction(db, householdId, accountId);
    await expect(assignTransactionMerchantScoped(
      householdId,
      clearedId,
      null,
      db,
    )).resolves.toMatchObject({ success: true });
    await resolve(householdId, providerInput(clearedId, "must-not-assign"));
    const [cleared] = await db.select().from(transactions)
      .where(eq(transactions.id, clearedId));
    const [clearDecision] = await db.select().from(transactionMerchantIdentityDecisions)
      .where(eq(
        transactionMerchantIdentityDecisions.id,
        cleared.merchantIdentityDecisionId!,
      ));
    expect(cleared.merchantId).toBeNull();
    expect(clearDecision).toMatchObject({ source: "manual", outcome: "cleared" });

    const { transactionId: deletedId } = await insertTransaction(db, householdId, accountId);
    await db.update(transactions).set({ deletedAt: new Date() })
      .where(eq(transactions.id, deletedId));
    await expect(assignTransactionMerchantScoped(
      householdId,
      deletedId,
      merchantId,
      db,
    )).resolves.toEqual({ error: "Transaction not found" });
    const [deleted] = await db.select().from(transactions)
      .where(eq(transactions.id, deletedId));
    expect(deleted.merchantId).toBeNull();
    expect(deleted.merchantIdentityDecisionId).toBeNull();
  });

  it("uses stable provider IDs across descriptions, separates identical names, and is replay-safe", async () => {
    const { transactionId: firstId } = await insertTransaction(db, householdId, accountId);
    const { transactionId: secondId } = await insertTransaction(db, householdId, accountId);

    await Promise.all([
      resolve(householdId, providerInput(firstId, "stable-entity", "ACME #1001")),
      resolve(householdId, providerInput(secondId, "stable-entity", "Acme purchase")),
    ]);

    const [first] = await db.select().from(transactions).where(eq(transactions.id, firstId));
    const [second] = await db.select().from(transactions).where(eq(transactions.id, secondId));
    expect(first.merchantId).toBeTruthy();
    expect(second.merchantId).toBe(first.merchantId);
    const identifiers = await db.select().from(merchantIdentifiers)
      .where(eq(merchantIdentifiers.merchantId, first.merchantId!));
    expect(identifiers).toHaveLength(1);

    const { merchantId: takeoverMerchantId } = await insertMerchant(db, householdId, {
      name: "Identifier takeover attempt",
    });
    await expect(db.update(merchantIdentifiers)
      .set({ merchantId: takeoverMerchantId })
      .where(eq(merchantIdentifiers.id, identifiers[0].id)))
      .rejects.toThrow();
    await expect(db.insert(merchantIdentifiers).values({
      id: "duplicate-active-identifier",
      householdId,
      merchantId: takeoverMerchantId,
      provider: identifiers[0].provider,
      identifierType: identifiers[0].identifierType,
      identifierHash: identifiers[0].identifierHash,
      source: "provider_merchant",
    })).rejects.toThrow();

    await resolve(householdId, providerInput(firstId, "stable-entity", "Changed again"));
    const firstHistory = await db.select().from(transactionMerchantIdentityDecisions)
      .where(eq(transactionMerchantIdentityDecisions.transactionId, firstId));
    expect(firstHistory).toHaveLength(1);

    const { transactionId: distinctId } = await insertTransaction(db, householdId, accountId);
    await resolve(householdId, providerInput(distinctId, "different-entity", "ACME #1001"));
    const [distinct] = await db.select().from(transactions)
      .where(eq(transactions.id, distinctId));
    expect(distinct.merchantId).not.toBe(first.merchantId);
    const sameNamedMerchants = await db.select().from(merchants)
      .where(eq(merchants.name, "ACME #1001"));
    expect(sameNamedMerchants).toHaveLength(2);
  });

  it("preserves legacy links, records conflicts, rejects ambiguity, and prevents downgrades", async () => {
    const { merchantId: legacyMerchantId } = await insertMerchant(db, householdId, {
      name: "Legacy linked merchant",
    });
    const { transactionId: legacyTransactionId } = await insertTransaction(
      db,
      householdId,
      accountId,
      { merchantId: legacyMerchantId },
    );
    await resolve(householdId, providerInput(legacyTransactionId, "conflicting-entity"));
    await resolve(householdId, providerInput(legacyTransactionId, "conflicting-entity"));
    const [legacy] = await db.select().from(transactions)
      .where(eq(transactions.id, legacyTransactionId));
    const legacyHistory = await db.select().from(transactionMerchantIdentityDecisions)
      .where(eq(transactionMerchantIdentityDecisions.transactionId, legacyTransactionId));
    expect(legacy.merchantId).toBe(legacyMerchantId);
    expect(legacyHistory).toHaveLength(1);
    expect(legacyHistory[0]).toMatchObject({
      source: "legacy_unknown",
      outcome: "conflict_preserved",
      decidedAt: null,
    });

    const { transactionId: mappedCounterpartyId } = await insertTransaction(
      db,
      householdId,
      accountId,
    );
    await resolve(householdId, {
      transactionId: mappedCounterpartyId,
      provider: "plaid",
      displayName: "Known marketplace",
      aliasObservation: "KNOWN MARKETPLACE",
      identifiers: [{
        identifierType: "plaid_counterparty_entity_id",
        value: "marketplace",
        source: "provider_counterparty",
        role: "merchant",
        confidence: "VERY_HIGH",
      }],
    });

    const { transactionId: ambiguousId } = await insertTransaction(db, householdId, accountId);
    const ambiguous = await resolve(householdId, {
      transactionId: ambiguousId,
      provider: "plaid",
      displayName: "Marketplace purchase",
      aliasObservation: "MARKETPLACE*SELLER",
      identifiers: [
        {
          identifierType: "plaid_counterparty_entity_id",
          value: "marketplace",
          source: "provider_counterparty",
          role: "merchant",
          confidence: "VERY_HIGH",
        },
        {
          identifierType: "plaid_counterparty_entity_id",
          value: "seller",
          source: "provider_counterparty",
          role: "merchant",
          confidence: "HIGH",
        },
      ],
    });
    expect(ambiguous.status).toBe("ambiguous");
    const [ambiguousRow] = await db.select().from(transactions)
      .where(eq(transactions.id, ambiguousId));
    expect(ambiguousRow.merchantId).toBeNull();

    const { transactionId: strongId } = await insertTransaction(db, householdId, accountId);
    await resolve(householdId, providerInput(strongId, "strong-entity", "Strong merchant"));
    const [strongBefore] = await db.select().from(transactions)
      .where(eq(transactions.id, strongId));
    await resolve(householdId, {
      transactionId: strongId,
      provider: "plaid",
      displayName: "Unknown changed text",
      aliasObservation: "UNKNOWN CHANGED TEXT",
    });
    const [strongAfter] = await db.select().from(transactions)
      .where(eq(transactions.id, strongId));
    expect(strongAfter.merchantId).toBe(strongBefore.merchantId);
    expect(strongAfter.merchantIdentityDecisionId).toBe(strongBefore.merchantIdentityDecisionId);
  });

  it("requires approved exact aliases and honors provider scope and revocation", async () => {
    const { merchantId } = await insertMerchant(db, householdId, { name: "Alias merchant" });
    const { transactionId: historicalId } = await insertTransaction(db, householdId, accountId);
    await resolve(householdId, {
      transactionId: historicalId,
      provider: "simplefin",
      displayName: "Unreviewed name",
      aliasObservation: "ACME   PAY",
    });

    const approved = await approveMerchantAliasScoped(
      householdId,
      "user-identity-owner",
      merchantId,
      " Acme Pay ",
      "simplefin",
      db,
    );
    expect(approved).toMatchObject({ success: true });
    const [historical] = await db.select().from(transactions)
      .where(eq(transactions.id, historicalId));
    expect(historical.merchantId).toBeNull();
    const [historicalDecision] = await db.select()
      .from(transactionMerchantIdentityDecisions)
      .where(eq(
        transactionMerchantIdentityDecisions.id,
        historical.merchantIdentityDecisionId!,
      ));
    expect(historicalDecision.evidence).toMatchObject({
      kind: "unresolved",
      observationHash: null,
    });
    expect(JSON.stringify(historicalDecision.evidence)).not.toContain("ACME");

    const { transactionId: matchedId } = await insertTransaction(db, householdId, accountId);
    await resolve(householdId, {
      transactionId: matchedId,
      provider: "simplefin",
      displayName: "Changed display",
      aliasObservation: "  ACME\tPAY ",
    });
    const [matched] = await db.select().from(transactions)
      .where(eq(transactions.id, matchedId));
    expect(matched.merchantId).toBe(merchantId);
    const [matchedDecision] = await db.select().from(transactionMerchantIdentityDecisions)
      .where(eq(
        transactionMerchantIdentityDecisions.id,
        matched.merchantIdentityDecisionId!,
      ));
    expect(matchedDecision.source).toBe("approved_alias");
    expect(JSON.stringify(matchedDecision.evidence)).not.toContain("ACME");

    const { merchantId: conflictingMerchantId } = await insertMerchant(db, householdId);
    await expect(approveMerchantAliasScoped(
      householdId,
      "user-identity-owner",
      conflictingMerchantId,
      "acme pay",
      "simplefin",
      db,
    )).resolves.toEqual({ error: "Alias is already assigned to another merchant" });

    expect("aliasId" in approved).toBe(true);
    if (!("aliasId" in approved)) throw new Error("Expected approved alias");
    await revokeMerchantAliasScoped(householdId, approved.aliasId, db);
    await expect(approveMerchantAliasScoped(
      householdId,
      "user-identity-owner",
      conflictingMerchantId,
      "acme pay",
      "simplefin",
      db,
    )).resolves.toMatchObject({ success: true });
    const { transactionId: revokedId } = await insertTransaction(db, householdId, accountId);
    await resolve(householdId, {
      transactionId: revokedId,
      provider: "simplefin",
      displayName: "No canonical match",
      aliasObservation: "ACME PAY",
    });
    const [revoked] = await db.select().from(transactions)
      .where(eq(transactions.id, revokedId));
    expect(revoked.merchantId).toBe(conflictingMerchantId);

    const globalAlias = await approveMerchantAliasScoped(
      householdId,
      "user-identity-owner",
      merchantId,
      "Global exact",
      null,
      db,
    );
    expect(globalAlias).toMatchObject({ success: true });
    const { transactionId: csvId } = await insertTransaction(db, householdId, accountId);
    await resolve(householdId, {
      transactionId: csvId,
      provider: "csv",
      displayName: "CSV row",
      aliasObservation: "GLOBAL EXACT",
    });
    const [csv] = await db.select().from(transactions).where(eq(transactions.id, csvId));
    expect(csv.merchantId).toBe(merchantId);
    const { transactionId: ofxId } = await insertTransaction(db, householdId, accountId);
    await resolve(householdId, {
      transactionId: ofxId,
      provider: "ofx",
      displayName: "OFX row",
      aliasObservation: "GLOBAL EXACT",
    });
    const [ofx] = await db.select().from(transactions).where(eq(transactions.id, ofxId));
    expect(ofx.merchantId).toBe(merchantId);
    const activeAliases = await db.select().from(merchantAliases)
      .where(eq(merchantAliases.merchantId, merchantId));
    expect(activeAliases).toHaveLength(2);
  });

  it("supports A -> B -> A, rejects cross-household references, and enforces immutable history", async () => {
    const { merchantId: merchantA } = await insertMerchant(db, householdId, { name: "Merchant A" });
    const { merchantId: merchantB } = await insertMerchant(db, householdId, { name: "Merchant B" });
    const { merchantId: foreignMerchant } = await insertMerchant(
      db,
      otherHouseholdId,
      { name: "Foreign merchant" },
    );
    const { transactionId } = await insertTransaction(db, householdId, accountId);
    await assignTransactionMerchantScoped(householdId, transactionId, merchantA, db);
    await assignTransactionMerchantScoped(householdId, transactionId, merchantB, db);
    await assignTransactionMerchantScoped(householdId, transactionId, merchantA, db);

    const history = await db.select().from(transactionMerchantIdentityDecisions)
      .where(eq(transactionMerchantIdentityDecisions.transactionId, transactionId));
    expect(history).toHaveLength(3);
    expect(new Set(history.map((decision) => decision.fingerprint)).size).toBe(3);
    await expect(getMerchantIdentityDecisionHistory(
      householdId,
      transactionId,
      db,
    )).resolves.toHaveLength(3);
    await expect(getCurrentMerchantIdentityDecision(
      householdId,
      transactionId,
      db,
    )).resolves.toMatchObject({ merchantId: merchantA, source: "manual" });
    await expect(getMerchantIdentityDecisionHistory(
      otherHouseholdId,
      transactionId,
      db,
    )).resolves.toEqual([]);
    await expect(getCurrentMerchantIdentityDecision(
      otherHouseholdId,
      transactionId,
      db,
    )).resolves.toBeNull();
    await expect(assignTransactionMerchantScoped(
      householdId,
      transactionId,
      foreignMerchant,
      db,
    )).resolves.toEqual({ error: "Merchant not found" });
    await expect(approveMerchantAliasScoped(
      householdId,
      "user-identity-owner",
      foreignMerchant,
      "foreign alias",
      null,
      db,
    )).resolves.toEqual({ error: "Merchant not found" });

    await expect(db.update(transactionMerchantIdentityDecisions)
      .set({ outcome: "cleared" })
      .where(eq(transactionMerchantIdentityDecisions.id, history[0].id)))
      .rejects.toThrow();

    const { transactionId: otherTransactionId } = await insertTransaction(
      db,
      householdId,
      accountId,
    );
    const otherAssignment = await assignTransactionMerchantScoped(
      householdId,
      otherTransactionId,
      merchantA,
      db,
    );
    if (!("decisionId" in otherAssignment) || !otherAssignment.decisionId) {
      throw new Error("Expected identity decision");
    }
    await expect(db.update(transactions).set({
      merchantId: merchantA,
      merchantIdentityDecisionId: otherAssignment.decisionId,
    }).where(eq(transactions.id, transactionId)))
      .rejects.toThrow();

    const { transactionId: foreignTransactionId } = await insertTransaction(
      db,
      otherHouseholdId,
      otherAccountId,
    );
    await expect(applyMerchantIdentityDecision(householdId, {
      transactionId: foreignTransactionId,
      merchantId: merchantA,
      source: "manual",
      outcome: "assigned",
      decisionPriority: MERCHANT_IDENTITY_PRIORITY.manual,
      evidence: {
        version: 1,
        kind: "manual",
        trigger: "single",
        merchant: { id: merchantA, name: "Merchant A" },
      },
    }, db)).rejects.toThrow("Transaction not found");
  });

  it("rolls back state when evidence validation fails", async () => {
    const { merchantId } = await insertMerchant(db, householdId, { name: "Actual name" });
    const { transactionId } = await insertTransaction(db, householdId, accountId);
    await expect(applyMerchantIdentityDecision(householdId, {
      transactionId,
      merchantId,
      source: "manual",
      outcome: "assigned",
      decisionPriority: MERCHANT_IDENTITY_PRIORITY.manual,
      evidence: {
        version: 1,
        kind: "manual",
        trigger: "single",
        merchant: { id: merchantId, name: "Fabricated name" },
      },
    }, db)).rejects.toThrow("Merchant identity evidence does not match owned merchant");

    const [transaction] = await db.select().from(transactions)
      .where(eq(transactions.id, transactionId));
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(transactionMerchantIdentityDecisions)
      .where(eq(transactionMerchantIdentityDecisions.transactionId, transactionId));
    expect(transaction.merchantId).toBeNull();
    expect(transaction.merchantIdentityDecisionId).toBeNull();
    expect(count).toBe(0);

    await expect(applyMerchantIdentityDecision(householdId, {
      transactionId,
      merchantId,
      source: "manual",
      outcome: "assigned",
      decisionPriority: MERCHANT_IDENTITY_PRIORITY.manual,
      evidence: {
        version: 1,
        kind: "provider",
        provider: "plaid",
        identifierType: "plaid_merchant_entity_id",
        identifierHash: "a".repeat(64),
        role: "merchant",
        confidence: null,
        merchant: { id: merchantId, name: "Actual name" },
      },
    }, db)).rejects.toThrow("source, outcome, and evidence do not agree");

    await expect(db.insert(transactionMerchantIdentityDecisions).values({
      id: "invalid-semantic-decision",
      householdId,
      transactionId,
      merchantId,
      source: "legacy_unknown",
      outcome: "unresolved",
      decisionPriority: 0,
      evidence: {
        version: 1,
        kind: "unresolved",
        provider: "plaid",
        reason: "no_match",
        observationHash: null,
        candidateCount: 0,
      },
      engineVersion: "merchant-identity-v1",
      fingerprint: "invalid-semantic-fingerprint",
    })).rejects.toThrow();

    const [{ afterSemanticFailures }] = await db.select({
      afterSemanticFailures: sql<number>`count(*)::int`,
    }).from(transactionMerchantIdentityDecisions)
      .where(eq(transactionMerchantIdentityDecisions.transactionId, transactionId));
    expect(afterSemanticFailures).toBe(0);
  });

  it("leaves a concurrent manual assignment in control of automated resolution", async () => {
    const { merchantId } = await insertMerchant(db, householdId, {
      name: "Concurrent manual merchant",
    });
    const { transactionId } = await insertTransaction(db, householdId, accountId);

    await Promise.all([
      resolve(householdId, providerInput(transactionId, "concurrent-provider-entity")),
      assignTransactionMerchantScoped(householdId, transactionId, merchantId, db),
    ]);

    const [transaction] = await db.select().from(transactions)
      .where(eq(transactions.id, transactionId));
    const [decision] = await db.select().from(transactionMerchantIdentityDecisions)
      .where(eq(
        transactionMerchantIdentityDecisions.id,
        transaction.merchantIdentityDecisionId!,
      ));
    expect(transaction.merchantId).toBe(merchantId);
    expect(decision).toMatchObject({ source: "manual", outcome: "assigned" });
  });

  it("blocks direct history deletion but permits a transaction hard-delete cascade", async () => {
    const { merchantId } = await insertMerchant(db, householdId, {
      name: "Cascade merchant",
    });
    const { transactionId } = await insertTransaction(db, householdId, accountId);
    const assignment = await assignTransactionMerchantScoped(
      householdId,
      transactionId,
      merchantId,
      db,
    );
    if (!("decisionId" in assignment) || !assignment.decisionId) {
      throw new Error("Expected identity decision");
    }

    await expect(db.delete(transactionMerchantIdentityDecisions)
      .where(eq(transactionMerchantIdentityDecisions.id, assignment.decisionId)))
      .rejects.toThrow();
    await expect(db.delete(transactions).where(eq(transactions.id, transactionId)))
      .resolves.toBeDefined();
    const remaining = await db.select().from(transactionMerchantIdentityDecisions)
      .where(eq(transactionMerchantIdentityDecisions.transactionId, transactionId));
    expect(remaining).toHaveLength(0);
  });
});
