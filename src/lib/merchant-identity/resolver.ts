import { eq, inArray, isNull, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { LedgrDb } from "@/db";
import {
  merchantAliases,
  merchantIdentifiers,
  merchants,
  transactionMerchantIdentityDecisions,
  transactions,
  type MerchantIdentitySource,
} from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import {
  applyMerchantIdentityDecisionInTransaction,
  MERCHANT_IDENTITY_PRIORITY,
  type MerchantIdentityDecisionResult,
} from "./decision-writer";
import {
  MERCHANT_ALIAS_NORMALIZATION_VERSION,
  merchantEvidenceHash,
  merchantIdentifierHash,
  normalizeMerchantAlias,
} from "./normalization";

export interface ProviderIdentifierCandidate {
  identifierType: string;
  value: string;
  source: "provider_merchant" | "provider_counterparty";
  role: string | null;
  confidence: string | null;
}

export interface ResolveMerchantIdentityInput {
  transactionId: string;
  provider: "plaid" | "simplefin" | "csv" | "ofx" | "manual";
  displayName: string;
  aliasObservation: string;
  identifiers?: ProviderIdentifierCandidate[];
}

export type ResolveMerchantIdentityResult =
  | { status: "assigned"; merchantId: string; decision: MerchantIdentityDecisionResult }
  | { status: "protected"; merchantId: string | null; decision: MerchantIdentityDecisionResult }
  | { status: "unresolved" | "ambiguous"; decision: MerchantIdentityDecisionResult };

async function recordUnresolved(
  householdId: string,
  input: ResolveMerchantIdentityInput,
  reason: "no_match" | "ambiguous_identifier" | "ambiguous_alias" | "unsafe_provider_identity",
  candidateCount: number,
  db: LedgrDb,
): Promise<ResolveMerchantIdentityResult> {
  const outcome = reason.startsWith("ambiguous") ? "ambiguous" : "unresolved";
  const decision = await applyMerchantIdentityDecisionInTransaction(householdId, {
    transactionId: input.transactionId,
    merchantId: null,
    source: "legacy_unknown",
    outcome,
    decisionPriority: MERCHANT_IDENTITY_PRIORITY.unresolved,
    evidence: {
      version: 1,
      kind: "unresolved",
      provider: input.provider,
      reason,
      // An unresolved decision does not need a stable derivative of private
      // bank text. The reason and candidate count are sufficient to explain it.
      observationHash: null,
      candidateCount,
    },
  }, db);
  return { status: outcome, decision };
}

async function applyResolved(
  householdId: string,
  input: ResolveMerchantIdentityInput,
  merchant: { id: string; name: string },
  source: MerchantIdentitySource,
  priority: number,
  evidence: Parameters<typeof applyMerchantIdentityDecisionInTransaction>[1]["evidence"],
  db: LedgrDb,
  identifierId?: string | null,
  aliasId?: string | null,
): Promise<ResolveMerchantIdentityResult> {
  const decision = await applyMerchantIdentityDecisionInTransaction(householdId, {
    transactionId: input.transactionId,
    merchantId: merchant.id,
    source,
    outcome: "assigned",
    identifierId,
    aliasId,
    decisionPriority: priority,
    evidence,
  }, db);
  return { status: "assigned", merchantId: merchant.id, decision };
}

export async function resolveMerchantIdentityInTransaction(
  householdId: string,
  input: ResolveMerchantIdentityInput,
  db: LedgrDb,
): Promise<ResolveMerchantIdentityResult> {
  const scoped = scopedQuery(householdId, db);
  const [txn] = await db.select({
    merchantId: transactions.merchantId,
    decisionId: transactions.merchantIdentityDecisionId,
  }).from(transactions)
    .where(scoped.where(transactions, eq(transactions.id, input.transactionId)))
    .for("update")
    .limit(1);
  if (!txn) throw new Error("Transaction not found");

  const [current] = txn.decisionId
    ? await db.select({
      source: transactionMerchantIdentityDecisions.source,
      outcome: transactionMerchantIdentityDecisions.outcome,
    })
      .from(transactionMerchantIdentityDecisions)
      .where(scoped.where(
        transactionMerchantIdentityDecisions,
        eq(transactionMerchantIdentityDecisions.id, txn.decisionId),
      )).limit(1)
    : [];
  if (current?.source === "manual") {
    return {
      status: "protected",
      merchantId: txn.merchantId,
      decision: { applied: false, reason: "manual" },
    };
  }

  const candidates = (input.identifiers ?? [])
    .filter((candidate) => candidate.value.trim().length > 0)
    .map((candidate) => ({
      ...candidate,
      hash: merchantIdentifierHash(input.provider, candidate.identifierType, candidate.value),
    }));

  // A legacy snapshot records observed state, not verification. Even after
  // backfill installs a current pointer, provider evidence must not silently
  // certify, replace, or clear that pre-existing link.
  if (current?.source === "legacy_unknown" && txn.merchantId) {
    const [legacyMerchant] = await db.select({ id: merchants.id, name: merchants.name })
      .from(merchants)
      .where(scoped.where(merchants, eq(merchants.id, txn.merchantId)))
      .limit(1);
    if (!legacyMerchant) throw new Error("Legacy merchant not found");

    if (candidates.length > 0) {
      const decision = await applyMerchantIdentityDecisionInTransaction(householdId, {
        transactionId: input.transactionId,
        merchantId: legacyMerchant.id,
        source: "legacy_unknown",
        outcome: "conflict_preserved",
        decisionPriority: MERCHANT_IDENTITY_PRIORITY.legacy,
        decidedAt: null,
        evidence: {
          version: 1,
          kind: "legacy",
          reason: "legacy_provider_conflict",
          merchant: legacyMerchant,
          providerIdentifierHash: candidates[0].hash,
        },
      }, db);
      return { status: "protected", merchantId: legacyMerchant.id, decision };
    }

    return {
      status: "protected",
      merchantId: legacyMerchant.id,
      decision: { applied: false, reason: "unchanged" },
    };
  }

  if (!txn.decisionId && txn.merchantId) {
    const [legacyMerchant] = await db.select({ id: merchants.id, name: merchants.name })
      .from(merchants)
      .where(scoped.where(merchants, eq(merchants.id, txn.merchantId)))
      .limit(1);
    if (!legacyMerchant) throw new Error("Legacy merchant not found");
    const decision = await applyMerchantIdentityDecisionInTransaction(householdId, {
      transactionId: input.transactionId,
      merchantId: legacyMerchant.id,
      source: "legacy_unknown",
      outcome: candidates.length ? "conflict_preserved" : "legacy_snapshot",
      decisionPriority: MERCHANT_IDENTITY_PRIORITY.legacy,
      decidedAt: null,
      evidence: {
        version: 1,
        kind: "legacy",
        reason: candidates.length ? "legacy_provider_conflict" : "observed_before_phase3",
        merchant: legacyMerchant,
        providerIdentifierHash: candidates[0]?.hash ?? null,
      },
    }, db);
    return { status: "protected", merchantId: legacyMerchant.id, decision };
  }

  if (candidates.length > 0) {
    // Plaid emits multiple qualified counterparties for marketplace/processor
    // transactions. An existing mapping for one candidate is not evidence that
    // it is the unique merchant for this transaction.
    if (candidates.length > 1) {
      return recordUnresolved(householdId, input, "ambiguous_identifier", candidates.length, db);
    }

    const mapped: Array<{
      identifierId: string;
      merchantId: string;
      merchantName: string;
      candidateType: string;
      candidateHash: string;
      candidateSource: string;
      candidateRole: string | null;
      candidateConfidence: string | null;
    }> = [];
    for (const candidate of candidates) {
      const rows = await db.select({
        identifierId: merchantIdentifiers.id,
        merchantId: merchants.id,
        merchantName: merchants.name,
        candidateType: sql<string>`${candidate.identifierType}`,
        candidateHash: sql<string>`${candidate.hash}`,
        candidateSource: sql<string>`${candidate.source}`,
        candidateRole: sql<string | null>`${candidate.role}`,
        candidateConfidence: sql<string | null>`${candidate.confidence}`,
      }).from(merchantIdentifiers)
        .innerJoin(merchants, eq(merchants.id, merchantIdentifiers.merchantId))
        .where(scoped.where(
          merchantIdentifiers,
          eq(merchantIdentifiers.provider, input.provider),
          eq(merchantIdentifiers.identifierType, candidate.identifierType),
          eq(merchantIdentifiers.identifierHash, candidate.hash),
          isNull(merchantIdentifiers.revokedAt),
          eq(merchants.householdId, householdId),
        ));
      mapped.push(...rows);
    }
    const merchantIds = new Set(mapped.map((row) => row.merchantId));
    if (merchantIds.size > 1) {
      return recordUnresolved(householdId, input, "ambiguous_identifier", merchantIds.size, db);
    }
    if (mapped.length > 0) {
      const match = mapped.sort((a, b) => a.identifierId.localeCompare(b.identifierId))[0];
      const source = match.candidateSource as "provider_merchant" | "provider_counterparty";
      return applyResolved(
        householdId,
        input,
        { id: match.merchantId, name: match.merchantName },
        source,
        source === "provider_merchant"
          ? MERCHANT_IDENTITY_PRIORITY.providerMerchant
          : MERCHANT_IDENTITY_PRIORITY.providerCounterparty,
        {
          version: 1,
          kind: "provider",
          provider: input.provider,
          identifierType: match.candidateType,
          identifierHash: match.candidateHash,
          role: match.candidateRole,
          confidence: match.candidateConfidence,
          merchant: { id: match.merchantId, name: match.merchantName },
        },
        db,
        match.identifierId,
      );
    }

    const establish = candidates[0];
    if (input.provider === "plaid"
      && input.displayName.trim()
      && (establish.source === "provider_merchant"
        || (establish.role === "merchant"
          && ["HIGH", "VERY_HIGH"].includes(establish.confidence ?? "")))) {
      const lockKey = [householdId, input.provider, establish.identifierType, establish.hash].join(":");
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [raced] = await db.select({
        identifierId: merchantIdentifiers.id,
        merchantId: merchants.id,
        merchantName: merchants.name,
      }).from(merchantIdentifiers)
        .innerJoin(merchants, eq(merchants.id, merchantIdentifiers.merchantId))
        .where(scoped.where(
          merchantIdentifiers,
          eq(merchantIdentifiers.provider, input.provider),
          eq(merchantIdentifiers.identifierType, establish.identifierType),
          eq(merchantIdentifiers.identifierHash, establish.hash),
          isNull(merchantIdentifiers.revokedAt),
        )).limit(1);
      if (raced) {
        return applyResolved(
          householdId,
          input,
          { id: raced.merchantId, name: raced.merchantName },
          establish.source,
          establish.source === "provider_merchant"
            ? MERCHANT_IDENTITY_PRIORITY.providerMerchant
            : MERCHANT_IDENTITY_PRIORITY.providerCounterparty,
          {
            version: 1,
            kind: "provider",
            provider: input.provider,
            identifierType: establish.identifierType,
            identifierHash: establish.hash,
            role: establish.role,
            confidence: establish.confidence,
            merchant: { id: raced.merchantId, name: raced.merchantName },
          },
          db,
          raced.identifierId,
        );
      }
      const merchantId = uuid();
      const identifierId = uuid();
      const name = input.displayName.trim();
      const now = new Date();
      await db.insert(merchants).values({
        id: merchantId,
        householdId,
        name,
        identityStatus: "provider_verified",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(merchantIdentifiers).values({
        id: identifierId,
        householdId,
        merchantId,
        provider: input.provider,
        identifierType: establish.identifierType,
        identifierHash: establish.hash,
        source: establish.source,
        confidence: establish.confidence,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
      });
      return applyResolved(
        householdId,
        input,
        { id: merchantId, name },
        establish.source,
        establish.source === "provider_merchant"
          ? MERCHANT_IDENTITY_PRIORITY.providerMerchant
          : MERCHANT_IDENTITY_PRIORITY.providerCounterparty,
        {
          version: 1,
          kind: "provider",
          provider: input.provider,
          identifierType: establish.identifierType,
          identifierHash: establish.hash,
          role: establish.role,
          confidence: establish.confidence,
          merchant: { id: merchantId, name },
        },
        db,
        identifierId,
      );
    }
  }

  const normalized = normalizeMerchantAlias(input.aliasObservation);
  if (normalized) {
    const providerAliases = await db.select({
      id: merchantAliases.id,
      merchantId: merchants.id,
      merchantName: merchants.name,
    }).from(merchantAliases)
      .innerJoin(merchants, eq(merchants.id, merchantAliases.merchantId))
      .where(scoped.where(
        merchantAliases,
        eq(merchantAliases.provider, input.provider),
        eq(merchantAliases.normalizationVersion, MERCHANT_ALIAS_NORMALIZATION_VERSION),
        eq(merchantAliases.normalizedAlias, normalized),
        isNull(merchantAliases.revokedAt),
        eq(merchants.householdId, householdId),
      ));
    if (providerAliases.length > 1) {
      return recordUnresolved(householdId, input, "ambiguous_alias", providerAliases.length, db);
    }
    if (providerAliases.length === 1) {
      const match = providerAliases[0];
      return applyResolved(
        householdId,
        input,
        { id: match.merchantId, name: match.merchantName },
        "approved_alias",
        MERCHANT_IDENTITY_PRIORITY.providerAlias,
        {
          version: 1,
          kind: "alias",
          provider: input.provider,
          aliasId: match.id,
          aliasHash: merchantEvidenceHash(normalized),
          normalizationVersion: MERCHANT_ALIAS_NORMALIZATION_VERSION,
          merchant: { id: match.merchantId, name: match.merchantName },
        },
        db,
        null,
        match.id,
      );
    }

    const globalAliases = await db.select({
      id: merchantAliases.id,
      merchantId: merchants.id,
      merchantName: merchants.name,
    }).from(merchantAliases)
      .innerJoin(merchants, eq(merchants.id, merchantAliases.merchantId))
      .where(scoped.where(
        merchantAliases,
        isNull(merchantAliases.provider),
        eq(merchantAliases.normalizationVersion, MERCHANT_ALIAS_NORMALIZATION_VERSION),
        eq(merchantAliases.normalizedAlias, normalized),
        isNull(merchantAliases.revokedAt),
        eq(merchants.householdId, householdId),
      ));
    if (globalAliases.length > 1) {
      return recordUnresolved(householdId, input, "ambiguous_alias", globalAliases.length, db);
    }
    if (globalAliases.length === 1) {
      const match = globalAliases[0];
      return applyResolved(
        householdId,
        input,
        { id: match.merchantId, name: match.merchantName },
        "approved_alias",
        MERCHANT_IDENTITY_PRIORITY.globalAlias,
        {
          version: 1,
          kind: "alias",
          provider: null,
          aliasId: match.id,
          aliasHash: merchantEvidenceHash(normalized),
          normalizationVersion: MERCHANT_ALIAS_NORMALIZATION_VERSION,
          merchant: { id: match.merchantId, name: match.merchantName },
        },
        db,
        null,
        match.id,
      );
    }
  }

  const canonicalMatches = await db.select({ id: merchants.id, name: merchants.name })
    .from(merchants)
    .where(scoped.where(
      merchants,
      eq(merchants.name, input.displayName.trim()),
      inArray(merchants.identityStatus, ["provider_verified", "user_verified"]),
    ));
  if (canonicalMatches.length === 1) {
    const match = canonicalMatches[0];
    return applyResolved(
      householdId,
      input,
      match,
      "verified_canonical_name",
      MERCHANT_IDENTITY_PRIORITY.canonicalName,
      {
        version: 1,
        kind: "canonical_name",
        nameHash: merchantEvidenceHash(input.displayName),
        merchant: match,
      },
      db,
    );
  }
  if (canonicalMatches.length > 1) {
    return recordUnresolved(householdId, input, "ambiguous_alias", canonicalMatches.length, db);
  }

  return recordUnresolved(
    householdId,
    input,
    candidates.length ? "unsafe_provider_identity" : "no_match",
    candidates.length,
    db,
  );
}
