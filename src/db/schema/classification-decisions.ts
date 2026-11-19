import { check, index, integer, jsonb, pgPolicy, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { households } from "./households";
import { transactions } from "./transactions";

export const CLASSIFICATION_DECISION_SOURCES = [
  "manual", "rule", "merchant_default", "pfc",
  // Historical values only. Runtime AI categorization is intentionally disabled.
  "ai", "ai_low_confidence", "legacy_unknown",
] as const;
export type ClassificationDecisionSource = (typeof CLASSIFICATION_DECISION_SOURCES)[number];

export const CLASSIFICATION_DECISION_OUTCOMES = [
  "applied", "inherited", "legacy_snapshot", "inheritance_limited",
] as const;
export type ClassificationDecisionOutcome = (typeof CLASSIFICATION_DECISION_OUTCOMES)[number];

export const CLASSIFICATION_SUBJECT_TYPES = ["transaction", "split"] as const;
export type ClassificationSubjectType = (typeof CLASSIFICATION_SUBJECT_TYPES)[number];

/** Immutable audit rows. Mutable source identifiers are snapshots, not FKs. */
export const transactionClassificationDecisions = pgTable(
  "transaction_classification_decisions",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id").notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull()
      .references((): AnyPgColumn => transactions.id, { onDelete: "cascade" }),
    subjectType: text("subject_type", { enum: CLASSIFICATION_SUBJECT_TYPES }).notNull(),
    transactionSplitId: text("transaction_split_id"),
    categoryId: text("category_id"),
    source: text("source").notNull(),
    ruleId: text("rule_id"),
    merchantId: text("merchant_id"),
    decisionPriority: integer("decision_priority").notNull(),
    outcome: text("outcome", { enum: CLASSIFICATION_DECISION_OUTCOMES }).notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    engineVersion: text("engine_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_classification_decisions_household_transaction")
      .on(table.householdId, table.transactionId, table.recordedAt, table.id),
    uniqueIndex("uq_classification_decision_transaction_fingerprint")
      .on(table.householdId, table.transactionId, table.fingerprint)
      .where(sql`${table.subjectType} = 'transaction' AND ${table.transactionSplitId} IS NULL`),
    uniqueIndex("uq_classification_decision_split_fingerprint")
      .on(table.householdId, table.transactionId, table.transactionSplitId, table.fingerprint)
      .where(sql`${table.subjectType} = 'split' AND ${table.transactionSplitId} IS NOT NULL`),
    check("classification_decision_subject_check", sql`
      (${table.subjectType} = 'transaction' AND ${table.transactionSplitId} IS NULL)
      OR (${table.subjectType} = 'split' AND ${table.transactionSplitId} IS NOT NULL)`),
    pgPolicy("household_isolation", {
      for: "all",
      using: sql`household_id = current_setting('app.household_id', true)`,
      withCheck: sql`household_id = current_setting('app.household_id', true)`,
    }),
  ],
).enableRLS();
