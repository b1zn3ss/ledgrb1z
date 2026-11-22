import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
import path from "node:path";
import type { LedgrDb } from "../../src/db";
import {
  merchants,
  transactionClassificationDecisions,
  transactionMerchantIdentityDecisions,
  transactions,
} from "../../src/db/schema";
import { backfillMerchantIdentitySnapshots } from "../../src/lib/jobs/backfill-merchant-identities";
import { createTestDb } from "./setup";

describe("merchant identity migration and backfill", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb({ migrationThrough: 15 }));
    await db.execute(sql`
      INSERT INTO households (id, name)
        VALUES ('hh-identity-migration', 'Identity migration household');
      INSERT INTO accounts (
        id, household_id, name, type, currency, current_balance, available_balance
      ) VALUES (
        'acct-identity-migration', 'hh-identity-migration', 'Checking', 'checking',
        'USD', 987654, 876543
      );
      INSERT INTO category_groups (id, household_id, name)
        VALUES ('group-identity-migration', 'hh-identity-migration', 'Spending');
      INSERT INTO categories (
        id, household_id, group_id, name,
        include_transfer_in_spending, include_transfer_in_cash_flow
      ) VALUES (
        'cat-identity-migration', 'hh-identity-migration',
        'group-identity-migration', 'Existing category', true, false
      );
      INSERT INTO merchants (id, household_id, name, category_id, raw_names)
        VALUES (
          'merchant-identity-legacy', 'hh-identity-migration',
          'Legacy Merchant', 'cat-identity-migration', '["Legacy raw name"]'
        );
      INSERT INTO transactions (
        id, account_id, household_id, date, original_name, name, amount,
        normalized_amount, merchant_id, category_id, category_source,
        is_transfer, transfer_source, provider
      ) VALUES (
        'txn-identity-provenance', 'acct-identity-migration',
        'hh-identity-migration', '2026-10-01', 'Existing raw',
        'Existing display', 1234, -1234, 'merchant-identity-legacy',
        'cat-identity-migration', 'manual', true, 'manual', 'plaid'
      );
      INSERT INTO transaction_classification_decisions (
        id, household_id, transaction_id, subject_type, category_id, source,
        decision_priority, outcome, evidence, engine_version, fingerprint,
        decided_at
      ) VALUES (
        'classification-existing', 'hh-identity-migration',
        'txn-identity-provenance', 'transaction', 'cat-identity-migration',
        'manual', 400, 'applied',
        '{"version":1,"kind":"manual","trigger":"single","category":{"id":"cat-identity-migration","name":"Existing category"}}',
        'classification-v1', 'classification-existing-fingerprint', now()
      );
      UPDATE transactions
      SET classification_decision_id = 'classification-existing'
      WHERE id = 'txn-identity-provenance';
      INSERT INTO transactions (
        id, account_id, household_id, date, original_name, name, amount,
        normalized_amount, merchant_id, is_transfer, provider
      )
      SELECT
        'txn-identity-bulk-' || lpad(g::text, 5, '0'),
        'acct-identity-migration', 'hh-identity-migration', '2026-10-02',
        'Bulk raw ' || g, 'Bulk display', 100, -100,
        'merchant-identity-legacy', (g % 2 = 0), 'plaid'
      FROM generate_series(1, 2000) g;
    `);

    await migrate(db, { migrationsFolder: path.join(process.cwd(), "src/db/migrations") });
  }, 120_000);

  afterAll(async () => close());

  it("adds only legacy-unverified schema state and preserves existing financial state", async () => {
    const [merchant] = await db.select().from(merchants)
      .where(eq(merchants.id, "merchant-identity-legacy"));
    expect(merchant).toMatchObject({
      categoryId: "cat-identity-migration",
      categoryDefaultApprovedAt: null,
      identityStatus: "legacy_unverified",
      rawNames: "[\"Legacy raw name\"]",
    });

    const [transaction] = await db.select().from(transactions)
      .where(eq(transactions.id, "txn-identity-provenance"));
    expect(transaction).toMatchObject({
      merchantId: "merchant-identity-legacy",
      categoryId: "cat-identity-migration",
      categorySource: "manual",
      classificationDecisionId: "classification-existing",
      merchantIdentityDecisionId: null,
      amount: 1234,
      normalizedAmount: -1234,
      isTransfer: true,
      transferSource: "manual",
    });
    const [classification] = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.id, "classification-existing"));
    expect(classification.fingerprint).toBe("classification-existing-fingerprint");

    const [{ decisionCount }] = await db.select({
      decisionCount: sql<number>`count(*)::int`,
    }).from(transactionMerchantIdentityDecisions);
    expect(decisionCount).toBe(0);
  });

  it("backfills in resumable batches with honest timestamps and is replay-idempotent", async () => {
    const progress: Array<{ complete: boolean; lastTransactionId: string | null }> = [];
    const first = await backfillMerchantIdentitySnapshots({
      householdId: "hh-identity-migration",
      batchSize: 137,
      onProgress: (entry) => progress.push({
        complete: entry.complete,
        lastTransactionId: entry.lastTransactionId,
      }),
    }, db);
    expect(first).toEqual({ processed: 2001, remaining: 0 });
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)?.complete).toBe(true);

    const [{ decisionCount, unknownTimes }] = await db.select({
      decisionCount: sql<number>`count(*)::int`,
      unknownTimes: sql<number>`count(*) filter (where decided_at is null)::int`,
    }).from(transactionMerchantIdentityDecisions);
    expect(decisionCount).toBe(2001);
    expect(unknownTimes).toBe(2001);

    const second = await backfillMerchantIdentitySnapshots({
      householdId: "hh-identity-migration",
      batchSize: 137,
    }, db);
    expect(second).toEqual({ processed: 0, remaining: 0 });
    const [{ afterReplay }] = await db.select({
      afterReplay: sql<number>`count(*)::int`,
    }).from(transactionMerchantIdentityDecisions);
    expect(afterReplay).toBe(2001);
  }, 120_000);

  it("is a no-op when the migration runner is invoked again", async () => {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "src/db/migrations") });
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(transactionMerchantIdentityDecisions);
    expect(count).toBe(2001);
  });
});
