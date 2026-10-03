import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { LedgrDb } from "../../src/db";
import { transactions } from "../../src/db/schema";
import { getToolCashFlowSummary } from "../../src/queries/reports";
import { insertAccount, insertCategory, insertCategoryGroup, insertHousehold, insertTransaction } from "./helpers";
import { createTestDb } from "./setup";

const RANGE = { dateFrom: "2026-07-01", dateTo: "2026-08-31" };

describe("getToolCashFlowSummary", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ db, close } = await createTestDb()); });
  afterAll(async () => close());

  test("uses canonical Cash Flow transfer, visibility, and household semantics", async () => {
    const { householdId } = await insertHousehold(db, "Active cash flow");
    const { accountId } = await insertAccount(db, householdId);
    const { groupId } = await insertCategoryGroup(db, householdId, { name: "Cash flow" });
    const ordinary = await insertCategory(db, householdId, groupId, { name: "Ordinary" });
    const income = await insertCategory(db, householdId, groupId, { name: "Income", isIncome: true });
    const cashFlowTransfer = await insertCategory(db, householdId, groupId, { name: "Card payment", includeTransferInCashFlow: true, includeTransferInSpending: false });
    const excludedTransfer = await insertCategory(db, householdId, groupId, { name: "Excluded transfer", includeTransferInCashFlow: false });
    const spendingOnlyTransfer = await insertCategory(db, householdId, groupId, { name: "Spending only", includeTransferInSpending: true, includeTransferInCashFlow: false });
    const loanPayment = await insertCategory(db, householdId, groupId, { name: "Loan payment", includeTransferInSpending: true, includeTransferInCashFlow: true });

    const rows = [
      { name: "Ordinary expense", normalizedAmount: -1000, categoryId: ordinary.categoryId },
      { name: "Ordinary income", normalizedAmount: 5000, categoryId: income.categoryId },
      { name: "Internal transfer", normalizedAmount: -2000, categoryId: ordinary.categoryId, isTransfer: true },
      { name: "Positive transfer", normalizedAmount: 3000, categoryId: cashFlowTransfer.categoryId, isTransfer: true },
      { name: "Card payment", normalizedAmount: -400, categoryId: cashFlowTransfer.categoryId, isTransfer: true },
      { name: "Flag disabled", normalizedAmount: -500, categoryId: excludedTransfer.categoryId, isTransfer: true },
      { name: "Spending flag only", normalizedAmount: -600, categoryId: spendingOnlyTransfer.categoryId, isTransfer: true },
      { name: "Student loan payment", normalizedAmount: -700, categoryId: loanPayment.categoryId, isTransfer: true },
      { name: "Hidden", normalizedAmount: -800, categoryId: ordinary.categoryId, isHidden: true },
      { name: "Deleted", normalizedAmount: -900, categoryId: ordinary.categoryId, deletedAt: new Date() },
      { name: "Pending", normalizedAmount: -1000, categoryId: ordinary.categoryId, pending: true },
    ];
    for (const row of rows) {
      await insertTransaction(db, householdId, accountId, { date: "2026-07-15", amount: -row.normalizedAmount, ...row });
    }
    await insertTransaction(db, householdId, accountId, { date: "2026-08-10", name: "August expense", normalizedAmount: -1100, amount: 1100, categoryId: ordinary.categoryId });

    const other = await insertHousehold(db, "Other cash flow");
    const otherAccount = await insertAccount(db, other.householdId);
    const otherGroup = await insertCategoryGroup(db, other.householdId);
    const otherCategory = await insertCategory(db, other.householdId, otherGroup.groupId);
    await insertTransaction(db, other.householdId, otherAccount.accountId, { date: "2026-07-15", normalizedAmount: -9999, amount: 9999, categoryId: otherCategory.categoryId });

    const result = await getToolCashFlowSummary(householdId, RANGE, db);
    expect(result.periods).toEqual([
      { period: "2026-07", incomeCents: 5000, outflowCents: 2100, netCashFlowCents: 2900 },
      { period: "2026-08", incomeCents: 0, outflowCents: 1100, netCashFlowCents: -1100 },
    ]);
    expect(result).toMatchObject({ dateFrom: RANGE.dateFrom, dateTo: RANGE.dateTo, incomeCents: 5000, outflowCents: 3200, netCashFlowCents: 1800, savingsRatePct: 36 });
    expect(result.incomeCents).toBe(result.periods.reduce((sum, row) => sum + row.incomeCents, 0));
    expect(result.outflowCents).toBe(result.periods.reduce((sum, row) => sum + row.outflowCents, 0));
    expect(result.netCashFlowCents).toBe(result.periods.reduce((sum, row) => sum + row.netCashFlowCents, 0));
  });

  test("applies date, account, and category filters supported by the canonical query", async () => {
    const { householdId } = await insertHousehold(db, "Cash flow filters");
    const firstAccount = await insertAccount(db, householdId, { name: "First" });
    const secondAccount = await insertAccount(db, householdId, { name: "Second" });
    const { groupId } = await insertCategoryGroup(db, householdId);
    const firstCategory = await insertCategory(db, householdId, groupId, { name: "First" });
    const secondCategory = await insertCategory(db, householdId, groupId, { name: "Second" });
    await insertTransaction(db, householdId, firstAccount.accountId, { date: "2026-07-10", normalizedAmount: -1100, amount: 1100, categoryId: firstCategory.categoryId });
    await insertTransaction(db, householdId, secondAccount.accountId, { date: "2026-07-10", normalizedAmount: -2200, amount: 2200, categoryId: firstCategory.categoryId });
    await insertTransaction(db, householdId, firstAccount.accountId, { date: "2026-07-10", normalizedAmount: -3300, amount: 3300, categoryId: secondCategory.categoryId });
    await insertTransaction(db, householdId, firstAccount.accountId, { date: "2026-06-30", normalizedAmount: -4400, amount: 4400, categoryId: firstCategory.categoryId });

    const result = await getToolCashFlowSummary(householdId, { dateFrom: "2026-07-01", dateTo: "2026-07-31", accountIds: [firstAccount.accountId], categoryIds: [firstCategory.categoryId] }, db);
    expect(result.periods).toEqual([{ period: "2026-07", incomeCents: 0, outflowCents: 1100, netCashFlowCents: -1100 }]);
    expect(result.outflowCents).toBe(1100);
    expect(result.savingsRatePct).toBeNull();
  });

  test("returns periods deterministically and derives every top-level total from them", async () => {
    const { householdId } = await insertHousehold(db, "Cash flow ordering");
    const { accountId } = await insertAccount(db, householdId);
    const { groupId } = await insertCategoryGroup(db, householdId);
    const expense = await insertCategory(db, householdId, groupId);
    for (const [date, amount] of [["2026-08-02", -800], ["2026-07-02", -700]] as const) {
      await insertTransaction(db, householdId, accountId, { date, normalizedAmount: amount, amount: -amount, categoryId: expense.categoryId });
    }
    const result = await getToolCashFlowSummary(householdId, RANGE, db);
    expect(result.periods.map((row) => row.period)).toEqual(["2026-07", "2026-08"]);
    expect(result).toMatchObject({ incomeCents: 0, outflowCents: 1500, netCashFlowCents: -1500, savingsRatePct: null });
  });

  test("does not write while producing the summary", async () => {
    const { householdId } = await insertHousehold(db, "Read-only cash flow");
    const { accountId } = await insertAccount(db, householdId);
    const { groupId } = await insertCategoryGroup(db, householdId);
    const { categoryId } = await insertCategory(db, householdId, groupId);
    const { transactionId } = await insertTransaction(db, householdId, accountId, { date: "2026-07-12", normalizedAmount: -1000, amount: 1000, categoryId, updatedAt: new Date("2026-07-12T12:00:00Z") });
    const before = await db.select().from(transactions);
    await getToolCashFlowSummary(householdId, RANGE, db);
    const after = await db.select().from(transactions);
    expect(after).toEqual(before);
    expect(after.find((row) => row.id === transactionId)).toBeDefined();
  });
});
