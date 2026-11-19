import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
import path from "node:path";
import type { LedgrDb } from "../../src/db";
import {
  categories,
  merchants,
  transactionClassificationDecisions,
  transactionSplits,
  transactions,
} from "../../src/db/schema";
import { createTestDb } from "./setup";

describe("classification provenance migration", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb({ migrationThrough: 14 }));
    await db.execute(sql`
      INSERT INTO households (id, name) VALUES ('hh-migration', 'Migration Household');
      INSERT INTO accounts (id, household_id, name, type, currency)
        VALUES ('acct-migration', 'hh-migration', 'Checking', 'checking', 'USD');
      INSERT INTO category_groups (id, household_id, name)
        VALUES ('group-migration', 'hh-migration', 'Migration Group');
      INSERT INTO categories
        (id, household_id, group_id, name, include_transfer_in_spending, include_transfer_in_cash_flow)
        VALUES
        ('cat-a', 'hh-migration', 'group-migration', 'Duplicate', false, true),
        ('cat-b', 'hh-migration', 'group-migration', 'Duplicate', true, false);
      INSERT INTO merchants (id, household_id, name, category_id)
        VALUES ('merchant-legacy', 'hh-migration', 'Legacy Merchant', 'cat-a');
      INSERT INTO transactions
        (id, account_id, household_id, date, original_name, name, amount, normalized_amount,
         category_id, category_source, is_transfer)
        VALUES
        ('txn-manual-null', 'acct-migration', 'hh-migration', '2026-01-01', 'Manual null', 'Manual null', 100, -100, NULL, 'manual', false),
        ('txn-ai', 'acct-migration', 'hh-migration', '2026-01-02', 'AI', 'AI', 200, -200, 'cat-a', 'ai', false),
        ('txn-rule', 'acct-migration', 'hh-migration', '2026-01-03', 'Rule', 'Rule', 300, -300, 'cat-b', 'rule', true),
        ('txn-split', 'acct-migration', 'hh-migration', '2026-01-04', 'Split', 'Split', 400, -400, NULL, 'manual', false),
        ('txn-unclassified', 'acct-migration', 'hh-migration', '2026-01-05', 'None', 'None', 500, -500, NULL, NULL, false);
      INSERT INTO transaction_splits (id, transaction_id, category_id, amount)
        VALUES ('split-legacy', 'txn-split', 'cat-a', 250);
      INSERT INTO transactions
        (id, account_id, household_id, date, original_name, name, amount, normalized_amount,
         category_id, category_source, is_transfer)
      SELECT 'txn-bulk-' || g, 'acct-migration', 'hh-migration', '2026-02-01',
        'Bulk', 'Bulk', 100, -100, 'cat-a', 'rule', false
      FROM generate_series(1, 10000) g;
    `);

    await migrate(db, { migrationsFolder: path.join(process.cwd(), "src/db/migrations") });
  }, 60_000);

  afterAll(async () => close());

  it("backfills observed state without changing accounting or merchant defaults", async () => {
    const [manualNull] = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.transactionId, "txn-manual-null"));
    expect(manualNull).toMatchObject({
      categoryId: null,
      source: "manual",
      outcome: "legacy_snapshot",
      decidedAt: null,
    });

    const [ai] = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.transactionId, "txn-ai"));
    expect(ai.source).toBe("ai");
    expect(ai.ruleId).toBeNull();

    const [ruleTxn] = await db.select().from(transactions)
      .where(eq(transactions.id, "txn-rule"));
    expect(ruleTxn.categoryId).toBe("cat-b");
    expect(ruleTxn.categorySource).toBe("rule");
    expect(ruleTxn.isTransfer).toBe(true);

    const [merchant] = await db.select().from(merchants)
      .where(eq(merchants.id, "merchant-legacy"));
    expect(merchant.categoryId).toBe("cat-a");
    const duplicateCategories = await db.select().from(categories)
      .where(eq(categories.name, "Duplicate"));
    expect(duplicateCategories).toHaveLength(2);
    expect(duplicateCategories.find((c) => c.id === "cat-a")?.includeTransferInCashFlow).toBe(true);
  });

  it("preserves split allocation without inventing a parent manual-null decision", async () => {
    const [split] = await db.select().from(transactionSplits)
      .where(eq(transactionSplits.id, "split-legacy"));
    expect(split.amount).toBe(250);
    expect(split.classificationDecisionId).toBe("legacy-split:split-legacy");

    const decisions = await db.select().from(transactionClassificationDecisions)
      .where(eq(transactionClassificationDecisions.transactionId, "txn-split"));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ subjectType: "split", categoryId: "cat-a" });
  });

  it("backfills a production-sized history and leaves unclassified rows untouched", async () => {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(transactionClassificationDecisions);
    expect(count).toBe(10004);

    const [unclassified] = await db.select().from(transactions)
      .where(eq(transactions.id, "txn-unclassified"));
    expect(unclassified.classificationDecisionId).toBeNull();
    expect(unclassified.categoryId).toBeNull();
    expect(unclassified.categorySource).toBeNull();
  });

  it("is a no-op when the migration runner is invoked again", async () => {
    const [{ beforeCount }] = await db.select({
      beforeCount: sql<number>`count(*)::int`,
    }).from(transactionClassificationDecisions);

    await migrate(db, { migrationsFolder: path.join(process.cwd(), "src/db/migrations") });

    const [{ afterCount }] = await db.select({
      afterCount: sql<number>`count(*)::int`,
    }).from(transactionClassificationDecisions);
    expect(afterCount).toBe(beforeCount);
  });

  it("fails closed and rolls back when legacy category ownership is invalid", async () => {
    const invalid = await createTestDb({ migrationThrough: 14 });
    try {
      await invalid.db.execute(sql`
        INSERT INTO households (id, name) VALUES
          ('hh-invalid-a', 'Invalid A'),
          ('hh-invalid-b', 'Invalid B');
        INSERT INTO accounts (id, household_id, name, type, currency)
          VALUES ('acct-invalid-a', 'hh-invalid-a', 'Checking', 'checking', 'USD');
        INSERT INTO category_groups (id, household_id, name)
          VALUES ('group-invalid-b', 'hh-invalid-b', 'Other household');
        INSERT INTO categories (id, household_id, group_id, name)
          VALUES ('cat-invalid-b', 'hh-invalid-b', 'group-invalid-b', 'Foreign category');
        INSERT INTO transactions
          (id, account_id, household_id, date, original_name, name, amount, normalized_amount,
           category_id, category_source, is_transfer)
          VALUES
          ('txn-invalid-a', 'acct-invalid-a', 'hh-invalid-a', '2026-01-01',
           'Invalid', 'Invalid', 100, -100, 'cat-invalid-b', 'manual', false);
      `);

      await expect(migrate(invalid.db, {
        migrationsFolder: path.join(process.cwd(), "src/db/migrations"),
      })).rejects.toThrow("legacy classification category/household mismatch");

      const relationResult = await invalid.db.execute(sql`
        SELECT to_regclass('transaction_classification_decisions') AS relation
      `);
      const relation = (relationResult.rows ?? relationResult)[0] as { relation: string | null };
      expect(relation.relation).toBeNull();
    } finally {
      await invalid.close();
    }
  });
});
