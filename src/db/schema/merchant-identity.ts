import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { households } from "./households";
import { merchants } from "./merchants";
import { transactions } from "./transactions";

export const MERCHANT_IDENTITY_SOURCES = [
  "manual", "provider_merchant", "provider_counterparty", "approved_alias",
  "verified_canonical_name", "pending_inheritance", "legacy_unknown",
] as const;
export type MerchantIdentitySource = (typeof MERCHANT_IDENTITY_SOURCES)[number];

export const MERCHANT_IDENTITY_OUTCOMES = [
  "assigned", "cleared", "unresolved", "ambiguous", "conflict_preserved",
  "inherited", "legacy_snapshot",
] as const;
export type MerchantIdentityOutcome = (typeof MERCHANT_IDENTITY_OUTCOMES)[number];

export const merchantIdentifiers = pgTable(
  "merchant_identifiers",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    merchantId: text("merchant_id").notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    identifierType: text("identifier_type").notNull(),
    identifierHash: text("identifier_hash").notNull(),
    source: text("source").notNull(),
    confidence: text("confidence"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_active_merchant_identifier")
      .on(table.householdId, table.provider, table.identifierType, table.identifierHash)
      .where(sql`${table.revokedAt} IS NULL`),
    index("idx_merchant_identifiers_household_merchant")
      .on(table.householdId, table.merchantId),
    pgPolicy("household_isolation", {
      for: "all",
      using: sql`household_id = current_setting('app.household_id', true)`,
      withCheck: sql`household_id = current_setting('app.household_id', true)`,
    }),
  ],
).enableRLS();

export const merchantAliases = pgTable(
  "merchant_aliases",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    merchantId: text("merchant_id").notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    provider: text("provider"),
    normalizedAlias: text("normalized_alias").notNull(),
    normalizationVersion: integer("normalization_version").notNull(),
    source: text("source").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_active_global_merchant_alias")
      .on(table.householdId, table.normalizationVersion, table.normalizedAlias)
      .where(sql`${table.provider} IS NULL AND ${table.revokedAt} IS NULL`),
    uniqueIndex("uq_active_provider_merchant_alias")
      .on(table.householdId, table.provider, table.normalizationVersion, table.normalizedAlias)
      .where(sql`${table.provider} IS NOT NULL AND ${table.revokedAt} IS NULL`),
    index("idx_merchant_aliases_household_merchant")
      .on(table.householdId, table.merchantId),
    pgPolicy("household_isolation", {
      for: "all",
      using: sql`household_id = current_setting('app.household_id', true)`,
      withCheck: sql`household_id = current_setting('app.household_id', true)`,
    }),
  ],
).enableRLS();

/** Immutable identity audit rows. Mutable registry identifiers are snapshots, not FKs. */
export const transactionMerchantIdentityDecisions = pgTable(
  "transaction_merchant_identity_decisions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull()
      .references((): AnyPgColumn => transactions.id, { onDelete: "cascade" }),
    merchantId: text("merchant_id"),
    source: text("source", { enum: MERCHANT_IDENTITY_SOURCES }).notNull(),
    outcome: text("outcome", { enum: MERCHANT_IDENTITY_OUTCOMES }).notNull(),
    identifierId: text("identifier_id"),
    aliasId: text("alias_id"),
    decisionPriority: integer("decision_priority").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    engineVersion: text("engine_version").notNull(),
    previousDecisionId: text("previous_decision_id"),
    fingerprint: text("fingerprint").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "merchant_identity_decision_semantics_check",
      sql`(
        (${table.source} = 'manual'
          AND ${table.evidence}->>'kind' = 'manual'
          AND ((${table.outcome} = 'assigned' AND ${table.merchantId} IS NOT NULL)
            OR (${table.outcome} = 'cleared' AND ${table.merchantId} IS NULL)))
        OR (${table.source} IN ('provider_merchant', 'provider_counterparty')
          AND ${table.evidence}->>'kind' = 'provider'
          AND ${table.outcome} = 'assigned'
          AND ${table.merchantId} IS NOT NULL)
        OR (${table.source} = 'approved_alias'
          AND ${table.evidence}->>'kind' = 'alias'
          AND ${table.outcome} = 'assigned'
          AND ${table.merchantId} IS NOT NULL)
        OR (${table.source} = 'verified_canonical_name'
          AND ${table.evidence}->>'kind' = 'canonical_name'
          AND ${table.outcome} = 'assigned'
          AND ${table.merchantId} IS NOT NULL)
        OR (${table.source} IN ('manual', 'pending_inheritance')
          AND ${table.evidence}->>'kind' = 'inheritance'
          AND ${table.outcome} = 'inherited')
        OR (${table.source} = 'legacy_unknown'
          AND ${table.evidence}->>'kind' = 'legacy'
          AND ${table.outcome} IN ('legacy_snapshot', 'conflict_preserved')
          AND ${table.merchantId} IS NOT NULL)
        OR (${table.source} = 'legacy_unknown'
          AND ${table.evidence}->>'kind' = 'unresolved'
          AND ${table.outcome} IN ('unresolved', 'ambiguous')
          AND ${table.merchantId} IS NULL)
      )`,
    ),
    index("idx_merchant_identity_decisions_household_transaction")
      .on(table.householdId, table.transactionId, table.recordedAt, table.id),
    uniqueIndex("uq_merchant_identity_decision_fingerprint")
      .on(table.householdId, table.transactionId, table.fingerprint),
    pgPolicy("household_isolation", {
      for: "all",
      using: sql`household_id = current_setting('app.household_id', true)`,
      withCheck: sql`household_id = current_setting('app.household_id', true)`,
    }),
  ],
).enableRLS();
