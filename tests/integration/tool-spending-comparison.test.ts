import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { LedgrDb } from "../../src/db";
import { transactions } from "../../src/db/schema";
import { getToolSpendingComparison } from "../../src/queries/reports";
import {
  insertAccount,
  insertCategory,
  insertCategoryGroup,
  insertHousehold,
  insertTransaction,
  insertTransactionSplit,
} from "./helpers";
import { createTestDb } from "./setup";

const PRIMARY = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };
const COMPARISON = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };

describe("getToolSpendingComparison", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  afterAll(async () => close());

  test("merges both canonical summaries with spending, split, transfer, and visibility semantics", async () => {
    const { householdId } = await insertHousehold(db, "Comparison semantics");
    const { accountId } = await insertAccount(db, householdId);
    const { groupId } = await insertCategoryGroup(db, householdId, {
      name: "Living",
    });

    const category = async (
      id: string,
      values: Parameters<typeof insertCategory>[3] = {},
    ) =>
      insertCategory(db, householdId, groupId, {
        name: id,
        ...values,
      });

    const increase = await category("increase");
    const decrease = await category("decrease");
    const unchanged = await category("unchanged");
    const currentOnly = await category("current-only");
    const comparisonOnly = await category("comparison-only");
    const splitA = await category("split-a");
    const splitB = await category("split-b");
    const includedTransfer = await category("included-transfer", {
      includeTransferInSpending: true,
    });
    const cashFlowOnly = await category("cash-flow-only", {
      includeTransferInCashFlow: true,
      includeTransferInSpending: false,
    });
    const income = await category("income", { isIncome: true });

    const spend = async (
      date: string,
      normalizedAmount: number,
      categoryId: string | null,
      values: Partial<Parameters<typeof insertTransaction>[3]> = {},
    ) =>
      insertTransaction(db, householdId, accountId, {
        date,
        normalizedAmount,
        amount: -normalizedAmount,
        categoryId,
        ...values,
      });

    await spend("2026-08-02", -1000, increase.categoryId);
    await spend("2026-09-02", -2000, increase.categoryId);
    await spend("2026-08-03", -3000, decrease.categoryId);
    await spend("2026-09-03", -1000, decrease.categoryId);
    await spend("2026-08-04", -1500, unchanged.categoryId);
    await spend("2026-09-04", -1500, unchanged.categoryId);
    await spend("2026-09-05", -700, currentOnly.categoryId);
    await spend("2026-08-05", -900, comparisonOnly.categoryId);
    await spend("2026-08-06", -200, includedTransfer.categoryId, {
      isTransfer: true,
    });
    await spend("2026-09-06", -400, includedTransfer.categoryId, {
      isTransfer: true,
    });
    await spend("2026-08-07", -300, null);
    await spend("2026-09-07", -500, null);

    const comparisonSplit = await spend(
      "2026-08-08",
      -1000,
      splitA.categoryId,
      { name: "Comparison split" },
    );
    await insertTransactionSplit(
      db,
      comparisonSplit.transactionId,
      splitA.categoryId,
      600,
    );
    await insertTransactionSplit(
      db,
      comparisonSplit.transactionId,
      splitB.categoryId,
      400,
    );
    const currentSplit = await spend(
      "2026-09-08",
      -2000,
      splitA.categoryId,
      { name: "Current split" },
    );
    await insertTransactionSplit(
      db,
      currentSplit.transactionId,
      splitA.categoryId,
      1200,
    );
    await insertTransactionSplit(
      db,
      currentSplit.transactionId,
      splitB.categoryId,
      800,
    );

    await spend("2026-09-09", -5000, increase.categoryId, {
      isTransfer: true,
      name: "Ordinary transfer",
    });
    await spend("2026-09-10", -6000, cashFlowOnly.categoryId, {
      isTransfer: true,
      name: "Cash-flow-only transfer",
    });
    await spend("2026-09-11", -7000, increase.categoryId, {
      isHidden: true,
      name: "Hidden",
    });
    await spend("2026-09-12", -8000, increase.categoryId, {
      deletedAt: new Date(),
      name: "Deleted",
    });
    await spend("2026-09-13", -9000, increase.categoryId, {
      pending: true,
      name: "Pending",
    });
    await spend("2026-09-14", 1000, increase.categoryId, {
      name: "Positive non-income",
    });
    await spend("2026-09-15", 10000, income.categoryId, {
      name: "Income",
    });

    const other = await insertHousehold(db, "Other household");
    const otherAccount = await insertAccount(db, other.householdId);
    const otherGroup = await insertCategoryGroup(db, other.householdId);
    const otherCategory = await insertCategory(
      db,
      other.householdId,
      otherGroup.groupId,
    );
    await insertTransaction(db, other.householdId, otherAccount.accountId, {
      date: "2026-09-16",
      normalizedAmount: -99999,
      amount: 99999,
      categoryId: otherCategory.categoryId,
    });

    const result = await getToolSpendingComparison(
      householdId,
      PRIMARY,
      COMPARISON,
      db,
    );

    expect(result).toMatchObject({
      ...PRIMARY,
      comparisonDateFrom: COMPARISON.dateFrom,
      comparisonDateTo: COMPARISON.dateTo,
      totalSpendingCents: 8100,
      comparisonTotalSpendingCents: 7900,
      changeCents: 200,
    });
    expect(result.changePct).toBeCloseTo((200 / 7900) * 100);

    const byId = new Map(
      result.categories.map((row) => [row.categoryId, row]),
    );
    expect(byId.get(increase.categoryId)).toMatchObject({
      amountCents: 2000,
      comparisonAmountCents: 1000,
      changeCents: 1000,
      changePct: 100,
    });
    expect(byId.get(decrease.categoryId)).toMatchObject({
      amountCents: 1000,
      comparisonAmountCents: 3000,
      changeCents: -2000,
    });
    expect(byId.get(unchanged.categoryId)).toMatchObject({
      amountCents: 1500,
      comparisonAmountCents: 1500,
      changeCents: 0,
      changePct: 0,
    });
    expect(byId.get(currentOnly.categoryId)).toMatchObject({
      amountCents: 700,
      comparisonAmountCents: null,
      changeCents: 700,
      changePct: null,
    });
    expect(byId.get(comparisonOnly.categoryId)).toMatchObject({
      amountCents: null,
      comparisonAmountCents: 900,
      changeCents: -900,
      changePct: -100,
    });
    expect(byId.get(splitA.categoryId)).toMatchObject({
      amountCents: 1200,
      comparisonAmountCents: 600,
    });
    expect(byId.get(splitB.categoryId)).toMatchObject({
      amountCents: 800,
      comparisonAmountCents: 400,
    });
    expect(byId.get(includedTransfer.categoryId)).toMatchObject({
      amountCents: 400,
      comparisonAmountCents: 200,
    });
    expect(byId.get(null)).toMatchObject({
      amountCents: 500,
      comparisonAmountCents: 300,
    });
    expect(byId.has(cashFlowOnly.categoryId)).toBe(false);
    expect(byId.has(income.categoryId)).toBe(false);
    expect(result.categories).toHaveLength(9);
  });

  test("applies identical filters and reports canonical comparison coverage", async () => {
    const { householdId } = await insertHousehold(db, "Comparison filters");
    const first = await insertAccount(db, householdId, { name: "First" });
    const second = await insertAccount(db, householdId, { name: "Second" });
    const { groupId } = await insertCategoryGroup(db, householdId);
    const target = await insertCategory(db, householdId, groupId, {
      name: "Target",
    });
    const other = await insertCategory(db, householdId, groupId, {
      name: "Other",
    });

    await insertTransaction(db, householdId, first.accountId, {
      date: "2026-07-15",
      normalizedAmount: -50,
      amount: 50,
      categoryId: other.categoryId,
    });
    for (const [accountId, date, amount, categoryId] of [
      [first.accountId, "2026-08-10", -1000, target.categoryId],
      [first.accountId, "2026-09-10", -2000, target.categoryId],
      [first.accountId, "2026-09-11", -500, other.categoryId],
      [second.accountId, "2026-08-10", -3000, target.categoryId],
      [second.accountId, "2026-09-10", -4000, target.categoryId],
    ] as const) {
      await insertTransaction(db, householdId, accountId, {
        date,
        normalizedAmount: amount,
        amount: -amount,
        categoryId,
      });
    }

    const accountFiltered = await getToolSpendingComparison(
      householdId,
      { ...PRIMARY, accountIds: [first.accountId], categoryIds: [target.categoryId] },
      { ...COMPARISON, accountIds: [first.accountId], categoryIds: [target.categoryId] },
      db,
    );
    expect(accountFiltered).toMatchObject({
      totalSpendingCents: 2000,
      comparisonTotalSpendingCents: 1000,
      comparisonCoverage: {
        lateAccountCount: 0,
        accountCount: 1,
        isPartial: false,
      },
    });

    const categoryFiltered = await getToolSpendingComparison(
      householdId,
      { ...PRIMARY, categoryIds: [target.categoryId] },
      { ...COMPARISON, categoryIds: [target.categoryId] },
      db,
    );
    expect(categoryFiltered).toMatchObject({
      totalSpendingCents: 6000,
      comparisonTotalSpendingCents: 4000,
      comparisonCoverage: {
        lateAccountCount: 1,
        accountCount: 2,
        isPartial: true,
      },
    });
    expect(categoryFiltered.categories.map((row) => row.categoryId)).toEqual([
      target.categoryId,
    ]);
  });

  test("uses null and -100 for top-level zero-baseline edge cases", async () => {
    const currentHousehold = await insertHousehold(db, "Zero comparison");
    const currentAccount = await insertAccount(db, currentHousehold.householdId);
    const currentGroup = await insertCategoryGroup(
      db,
      currentHousehold.householdId,
    );
    const currentCategory = await insertCategory(
      db,
      currentHousehold.householdId,
      currentGroup.groupId,
    );
    await insertTransaction(
      db,
      currentHousehold.householdId,
      currentAccount.accountId,
      {
        date: "2026-09-10",
        normalizedAmount: -1000,
        amount: 1000,
        categoryId: currentCategory.categoryId,
      },
    );

    const newSpending = await getToolSpendingComparison(
      currentHousehold.householdId,
      PRIMARY,
      COMPARISON,
      db,
    );
    expect(newSpending).toMatchObject({
      totalSpendingCents: 1000,
      comparisonTotalSpendingCents: 0,
      changeCents: 1000,
      changePct: null,
    });

    const priorHousehold = await insertHousehold(db, "Zero current");
    const priorAccount = await insertAccount(db, priorHousehold.householdId);
    const priorGroup = await insertCategoryGroup(db, priorHousehold.householdId);
    const priorCategory = await insertCategory(
      db,
      priorHousehold.householdId,
      priorGroup.groupId,
    );
    await insertTransaction(
      db,
      priorHousehold.householdId,
      priorAccount.accountId,
      {
        date: "2026-08-10",
        normalizedAmount: -1000,
        amount: 1000,
        categoryId: priorCategory.categoryId,
      },
    );

    const stoppedSpending = await getToolSpendingComparison(
      priorHousehold.householdId,
      PRIMARY,
      COMPARISON,
      db,
    );
    expect(stoppedSpending).toMatchObject({
      totalSpendingCents: 0,
      comparisonTotalSpendingCents: 1000,
      changeCents: -1000,
      changePct: -100,
    });
  });

  test("orders ties deterministically and does not write", async () => {
    const { householdId } = await insertHousehold(db, "Comparison ordering");
    const { accountId } = await insertAccount(db, householdId);
    const { groupId } = await insertCategoryGroup(db, householdId);
    await insertCategory(db, householdId, groupId, {
      id: "order-z",
      name: "Zulu",
    });
    await insertCategory(db, householdId, groupId, {
      id: "order-a",
      name: "Alpha",
    });

    for (const categoryId of ["order-z", "order-a"]) {
      await insertTransaction(db, householdId, accountId, {
        date: "2026-08-10",
        normalizedAmount: -1000,
        amount: 1000,
        categoryId,
      });
      await insertTransaction(db, householdId, accountId, {
        date: "2026-09-10",
        normalizedAmount: -2000,
        amount: 2000,
        categoryId,
      });
    }
    const before = await db.select().from(transactions);

    const result = await getToolSpendingComparison(
      householdId,
      PRIMARY,
      COMPARISON,
      db,
    );

    expect(result.categories.map((row) => row.categoryId)).toEqual([
      "order-a",
      "order-z",
    ]);
    expect(result.changeCents).toBe(
      result.totalSpendingCents - result.comparisonTotalSpendingCents,
    );
    expect(await db.select().from(transactions)).toEqual(before);
  });
});
