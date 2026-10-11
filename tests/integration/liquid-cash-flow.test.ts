import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { LedgrDb } from "../../src/db";
import { balanceHistory } from "../../src/db/schema";
import { getCashFlowMovements, summarizeCashFlow } from "../../src/queries/cash-flow";
import {
  getCashFlowSankey,
  getCashFlowSummary,
  getDrillDownTransactions,
  getSpendingByCategory,
} from "../../src/queries/reports";
import {
  insertAccount,
  insertCategory,
  insertCategoryGroup,
  insertHousehold,
  insertTransaction,
  insertTransactionSplit,
} from "./helpers";
import { createTestDb } from "./setup";

const RANGE = { dateFrom: "2026-10-01", dateTo: "2026-10-31" };

describe("canonical liquid cash flow", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;

  beforeAll(async () => { ({ db, close } = await createTestDb()); });
  afterAll(async () => close());

  test("counts liquid movements by sign and excludes liability-account activity", async () => {
    const { householdId } = await insertHousehold(db, "Movement matrix");
    const checking = await insertAccount(db, householdId, { name: "Checking", type: "checking" });
    const card = await insertAccount(db, householdId, { name: "Card", type: "credit" });
    const loan = await insertAccount(db, householdId, { name: "Loan", type: "loan" });
    const { groupId } = await insertCategoryGroup(db, householdId);
    const expense = await insertCategory(db, householdId, groupId, { name: "Expense" });
    const income = await insertCategory(db, householdId, groupId, { name: "Income", isIncome: true });

    const entries = [
      [checking.accountId, "Salary", 100000, income.categoryId, false],
      [checking.accountId, "Debit purchase", -5000, expense.categoryId, false],
      [card.accountId, "Card purchase", -20000, expense.categoryId, false],
      [checking.accountId, "Payment to disconnected card", -15000, expense.categoryId, true],
      [card.accountId, "Card payment credit", 15000, expense.categoryId, true],
      [checking.accountId, "Loan payment", -7000, expense.categoryId, false],
      [loan.accountId, "Loan payment credit", 7000, expense.categoryId, false],
      [checking.accountId, "Loan proceeds", 30000, expense.categoryId, false],
      [checking.accountId, "Cash advance", 12000, expense.categoryId, false],
      [card.accountId, "Card refund", 2500, expense.categoryId, false],
      [checking.accountId, "Checking refund", 1800, expense.categoryId, false],
      [checking.accountId, "ATM", -4000, expense.categoryId, false],
    ] as const;
    for (const [accountId, name, normalizedAmount, categoryId, isTransfer] of entries) {
      await insertTransaction(db, householdId, accountId, {
        date: "2026-10-10",
        name,
        normalizedAmount,
        amount: -normalizedAmount,
        categoryId,
        isTransfer,
      });
    }

    const [summary] = await getCashFlowSummary(householdId, RANGE, db);
    expect(summary).toEqual({
      period: "2026-10",
      income: 143800,
      expenses: 31000,
      net: 112800,
    });
    const movements = await getCashFlowMovements(householdId, RANGE, db);
    expect(summary.net).toBe(movements.reduce((sum, row) => sum + row.contributionCents, 0));
    expect(movements.some((row) => row.accountId === card.accountId)).toBe(false);
    expect(movements.some((row) => row.accountId === loan.accountId)).toBe(false);

    const spending = await getSpendingByCategory(householdId, RANGE, db);
    expect(spending.find((row) => row.categoryId === expense.categoryId)?.total).toBe(36000);
  });

  test("uses the selected liquid boundary for paired, unpaired, and split transfers", async () => {
    const { householdId } = await insertHousehold(db, "Transfer boundary");
    const checking = await insertAccount(db, householdId, { name: "Checking", type: "checking" });
    const savings = await insertAccount(db, householdId, { name: "Savings", type: "savings" });
    const brokerage = await insertAccount(db, householdId, { name: "Brokerage", type: "investment" });
    const { groupId } = await insertCategoryGroup(db, householdId);
    const category = await insertCategory(db, householdId, groupId);

    await insertTransaction(db, householdId, checking.accountId, {
      id: "checking-to-savings",
      date: "2026-10-11",
      normalizedAmount: -10000,
      amount: 10000,
      categoryId: category.categoryId,
      isTransfer: true,
      transferPairId: "savings-from-checking",
    });
    await insertTransaction(db, householdId, savings.accountId, {
      id: "savings-from-checking",
      date: "2026-10-11",
      normalizedAmount: 10000,
      amount: -10000,
      categoryId: category.categoryId,
      isTransfer: true,
      transferPairId: "checking-to-savings",
    });
    await insertTransaction(db, householdId, checking.accountId, {
      date: "2026-10-12",
      normalizedAmount: -6000,
      amount: 6000,
      categoryId: category.categoryId,
      isTransfer: true,
      name: "Unpaired brokerage transfer",
    });
    await insertTransaction(db, householdId, brokerage.accountId, {
      date: "2026-10-12",
      normalizedAmount: 6000,
      amount: -6000,
      categoryId: category.categoryId,
      isTransfer: true,
    });
    await insertTransaction(db, householdId, checking.accountId, {
      id: "ambiguous-source",
      date: "2026-10-12",
      normalizedAmount: -2000,
      amount: 2000,
      categoryId: category.categoryId,
      isTransfer: true,
      transferPairId: "ambiguous-target",
      name: "Ambiguous transfer out",
    });
    await insertTransaction(db, householdId, savings.accountId, {
      id: "ambiguous-target",
      date: "2026-10-12",
      normalizedAmount: 2000,
      amount: -2000,
      categoryId: category.categoryId,
      isTransfer: true,
      transferPairId: "missing-third-leg",
      name: "Ambiguous transfer in",
    });
    const split = await insertTransaction(db, householdId, checking.accountId, {
      date: "2026-10-13",
      normalizedAmount: -3000,
      amount: 3000,
      categoryId: category.categoryId,
    });
    await insertTransactionSplit(db, split.transactionId, category.categoryId, 1000);
    await insertTransactionSplit(db, split.transactionId, category.categoryId, 2000);

    const globalSummary = summarizeCashFlow(
      await getCashFlowMovements(householdId, RANGE, db),
    );
    expect(globalSummary).toEqual([
      { period: "2026-10", cashIn: 2000, cashOut: 11000, net: -9000 },
    ]);
    expect(summarizeCashFlow(await getCashFlowMovements(
      householdId,
      { ...RANGE, accountIds: [checking.accountId] },
      db,
    ))[0]).toMatchObject({ cashIn: 0, cashOut: 21000, net: -21000 });
    expect(summarizeCashFlow(await getCashFlowMovements(
      householdId,
      { ...RANGE, accountIds: [savings.accountId] },
      db,
    ))[0]).toMatchObject({ cashIn: 12000, cashOut: 0, net: 12000 });

    await db.insert(balanceHistory).values([
      { id: randomUUID(), accountId: checking.accountId, date: "2026-09-30", balance: 100000 },
      { id: randomUUID(), accountId: savings.accountId, date: "2026-09-30", balance: 50000 },
      { id: randomUUID(), accountId: checking.accountId, date: "2026-10-31", balance: 81000 },
      { id: randomUUID(), accountId: savings.accountId, date: "2026-10-31", balance: 60000 },
    ]);
    const snapshots = await db
      .select({ date: balanceHistory.date, balance: balanceHistory.balance })
      .from(balanceHistory)
      .where(inArray(balanceHistory.accountId, [checking.accountId, savings.accountId]));
    const totalAt = (date: string) =>
      snapshots
        .filter((snapshot) => snapshot.date === date)
        .reduce((sum, snapshot) => sum + snapshot.balance, 0);
    expect(totalAt("2026-10-31") - totalAt("2026-09-30")).toBe(globalSummary[0].net);
  });

  test("keeps summary, Sankey, drill-down, visibility, and household scope aligned", async () => {
    const { householdId } = await insertHousehold(db, "Parity");
    const { accountId } = await insertAccount(db, householdId, { type: "checking" });
    const { groupId } = await insertCategoryGroup(db, householdId);
    const category = await insertCategory(db, householdId, groupId, { name: "Movement" });
    await insertTransaction(db, householdId, accountId, {
      date: "2026-10-15", normalizedAmount: 9000, amount: -9000, categoryId: category.categoryId,
    });
    await insertTransaction(db, householdId, accountId, {
      date: "2026-10-16", normalizedAmount: -4000, amount: 4000, categoryId: category.categoryId,
    });
    for (const excluded of [
      { name: "Pending", pending: true },
      { name: "Hidden", isHidden: true },
      { name: "Deleted", deletedAt: new Date() },
    ]) {
      await insertTransaction(db, householdId, accountId, {
        date: "2026-10-17",
        normalizedAmount: -1000,
        amount: 1000,
        categoryId: category.categoryId,
        ...excluded,
      });
    }
    const other = await insertHousehold(db, "Other");
    const otherAccount = await insertAccount(db, other.householdId, { type: "checking" });
    await insertTransaction(db, other.householdId, otherAccount.accountId, {
      date: "2026-10-18", normalizedAmount: -99000, amount: 99000,
    });

    expect(await getCashFlowSummary(householdId, RANGE, db)).toEqual([
      { period: "2026-10", income: 9000, expenses: 4000, net: 5000 },
    ]);
    const { links } = await getCashFlowSankey(householdId, RANGE, db);
    expect(links.filter((link) => link.source === `income-${category.categoryId}`)
      .reduce((sum, link) => sum + link.value, 0)).toBe(9000);
    const drill = await getDrillDownTransactions(
      householdId,
      { ...RANGE, categoryId: category.categoryId, type: "expense", reportContext: "cash-flow" },
      50,
      db,
    );
    expect(drill).toMatchObject({ total: 4000, matchCount: 1 });
  });
});
