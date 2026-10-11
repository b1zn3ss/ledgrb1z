import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "./setup";
import {
  insertAccount,
  insertCategory,
  insertCategoryGroup,
  insertHousehold,
  insertPlaidItem,
  insertSimplefinConnection,
  insertTransaction,
  insertTransactionSplit,
} from "./helpers";
import type { LedgrDb } from "../../src/db";

let db: LedgrDb;
let close: () => Promise<void>;
let householdId: string;
let checkingId: string;
let creditCardId: string;
let groceriesId: string;
let splitTransactionId: string;

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];

    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function records(csv: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(csv);
  return rows.map((row) =>
    Object.fromEntries(header.map((column, index) => [column, row[index] ?? ""])),
  );
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());

  ({ householdId } = await insertHousehold(db));
  ({ accountId: checkingId } = await insertAccount(db, householdId, { name: "Checking" }));
  ({ accountId: creditCardId } = await insertAccount(db, householdId, {
    name: "Credit Card",
    type: "credit",
  }));
  const { groupId } = await insertCategoryGroup(db, householdId, { name: "Food" });
  ({ categoryId: groceriesId } = await insertCategory(db, householdId, groupId, {
    name: "Groceries",
  }));
  const { categoryId: diningId } = await insertCategory(db, householdId, groupId, {
    name: "Dining",
  });

  await insertTransaction(db, householdId, checkingId, {
    date: "2026-03-15",
    normalizedAmount: -1250,
    amount: 1250,
    categoryId: groceriesId,
    name: "Test Store",
    originalName: "TEST STORE #123",
    externalId: "plaid-transaction-1",
    provider: "plaid",
  });
  await insertTransaction(db, householdId, creditCardId, {
    date: "2026-04-01",
    normalizedAmount: -2000,
    amount: 2000,
    categoryId: groceriesId,
    name: "Other Store",
    originalName: "OTHER STORE",
  });
  ({ transactionId: splitTransactionId } = await insertTransaction(
    db,
    householdId,
    checkingId,
    {
      date: "2026-03-20",
      normalizedAmount: -3000,
      amount: 3000,
      categoryId: groceriesId,
      name: "Split Purchase",
      originalName: "SPLIT PURCHASE",
    },
  ));
  await insertTransactionSplit(db, splitTransactionId, groceriesId, 1000);
  await insertTransactionSplit(db, splitTransactionId, diningId, 2000);

  await insertTransaction(db, householdId, creditCardId, {
    date: "2026-03-25",
    normalizedAmount: -5000,
    amount: 5000,
    categoryId: groceriesId,
    name: "Transfer Payment",
    originalName: "TRANSFER PAYMENT",
    isTransfer: true,
    transferPairId: "paired-transaction",
    transferSource: "auto",
  });
  await insertTransaction(db, householdId, checkingId, {
    date: "2026-03-28",
    normalizedAmount: -700,
    amount: 700,
    categoryId: groceriesId,
    name: "Pending Charge",
    originalName: "PENDING CHARGE",
    pending: true,
  });
  await insertTransaction(db, householdId, checkingId, {
    date: "2026-03-30",
    normalizedAmount: -900,
    amount: 900,
    categoryId: groceriesId,
    name: "Hidden Charge",
    originalName: "HIDDEN CHARGE",
    isHidden: true,
  });

  const { householdId: otherHouseholdId } = await insertHousehold(db, "Other Household");
  const { accountId: otherAccountId } = await insertAccount(db, otherHouseholdId);
  await insertTransaction(db, otherHouseholdId, otherAccountId, {
    name: "Other Household Secret",
    originalName: "OTHER HOUSEHOLD SECRET",
  });

  await insertPlaidItem(db, householdId);
  await insertSimplefinConnection(db, householdId);
});

afterAll(async () => {
  await close();
});

describe("transaction CSV export", () => {
  test("standard export returns real rows from every selected household account", async () => {
    const { buildCsvString } = await import("../../src/app/api/export/transactions/route");

    const csv = await buildCsvString(householdId, {}, db);
    const exported = records(csv);

    expect(parseCsv(csv)[0]).toEqual([
      "Date",
      "Account",
      "Merchant",
      "Amount",
      "Category",
      "Category Group",
      "Notes",
      "Original Description",
    ]);
    expect(exported).toHaveLength(5);
    expect(new Set(exported.map((row) => row.Account))).toEqual(
      new Set(["Checking", "Credit Card"]),
    );
    expect(exported.find((row) => row.Merchant === "Test Store")?.Amount).toBe("-12.50");
    expect(csv).not.toContain("Hidden Charge");
    expect(csv).not.toContain("Other Household Secret");
  });

  test("standard export respects the same combined filters as the Transactions page", async () => {
    const { buildCsvString } = await import("../../src/app/api/export/transactions/route");

    const csv = await buildCsvString(
      householdId,
      {
        accountId: checkingId,
        dateFrom: "2026-03-01",
        dateTo: "2026-03-31",
        search: "test store",
        amountMin: 1200,
        amountMax: 1300,
        transactionType: "expense",
      },
      db,
    );

    expect(records(csv).map((row) => row.Merchant)).toEqual(["Test Store"]);
  });

  test("hidden audit view exports only hidden transactions", async () => {
    const { buildCsvString } = await import("../../src/app/api/export/transactions/route");

    const csv = await buildCsvString(householdId, { hidden: true }, db, "audit");

    expect(records(csv).map((row) => row.Description)).toEqual(["Hidden Charge"]);
  });

  test("audit export exposes reconciliation metadata and canonical report contributions", async () => {
    const { buildCsvString } = await import("../../src/app/api/export/transactions/route");

    const csv = await buildCsvString(householdId, {}, db, "audit");
    const exported = records(csv);
    const split = exported.find((row) => row["Transaction ID"] === splitTransactionId);
    const transfer = exported.find((row) => row.Description === "Transfer Payment");
    const pending = exported.find((row) => row.Description === "Pending Charge");

    expect(split).toMatchObject({
      "Account ID": checkingId,
      "Category ID": groceriesId,
      "Raw Amount Cents": "3000",
      "Normalized Amount Cents": "-3000",
      "Split Count": "2",
      "Split Amount Cents": "3000",
      "Split Difference Cents": "0",
      "Included In Spending": "true",
      "Spending Contribution Cents": "3000",
      "Included In Cash Flow": "true",
      "Cash Flow Expense Contribution Cents": "3000",
      "Cash Flow Net Contribution Cents": "-3000",
    });
    expect(JSON.parse(split?.Splits ?? "[]")).toHaveLength(2);
    expect(transfer).toMatchObject({
      "Is Transfer": "true",
      "Included In Spending": "false",
      "Spending Contribution Cents": "0",
      "Included In Cash Flow": "false",
    });
    expect(pending).toMatchObject({
      Pending: "true",
      "Included In Spending": "false",
      "Included In Cash Flow": "false",
    });
  });

  test("response is Excel-compatible and never exports household credentials", async () => {
    const { buildCsvResponse } = await import("../../src/app/api/export/transactions/route");

    const response = await buildCsvResponse(householdId, {}, db, "audit");
    const buffer = Buffer.from(await response.arrayBuffer());
    const body = buffer.subarray(3).toString("utf8");

    expect([...buffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="ledgr-transactions-audit-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(body).not.toMatch(/credential|access[-_ ]?token|plaid token/i);
    expect(body).not.toContain("access-sandbox-test-token");
    expect(body).not.toContain("https://demo:demo@bridge.simplefin.test/simplefin");
    expect(body).not.toContain("Other Household Secret");
  });
});
