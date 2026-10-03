import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { LedgrDb } from "../../src/db";
import { accounts, bankConnections } from "../../src/db/schema";
import { getToolDebtSummary } from "../../src/queries/accounts";
import { insertAccount, insertHousehold } from "./helpers";
import { createTestDb } from "./setup";

describe("getToolDebtSummary", () => {
  let db: LedgrDb;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });

  afterAll(async () => close());

  test("uses canonical liability, visibility, sign, and household semantics", async () => {
    const { householdId } = await insertHousehold(db, "Debt household");
    const connectionId = "debt-bank-connection";
    await db.insert(bankConnections).values({
      id: connectionId,
      householdId,
      provider: "plaid",
      credential: "encrypted-sensitive-credential",
      institutionName: "Debt Bank",
      plaidItemId: "sensitive-plaid-item-id",
    });

    await insertAccount(db, householdId, {
      id: "credit-a",
      bankConnectionId: connectionId,
      name: "Alpha Card",
      officialName: "Alpha Rewards Credit Card",
      type: "credit",
      subtype: "credit card",
      currentBalance: -50000,
      availableBalance: 150000,
      creditLimit: 200000,
      currency: "USD",
    });
    await insertAccount(db, householdId, {
      id: "credit-z",
      name: "Zulu Card",
      type: "credit",
      currentBalance: -50000,
      availableBalance: null,
      creditLimit: null,
    });
    await insertAccount(db, householdId, {
      id: "loan-main",
      name: "Student Loan",
      type: "loan",
      subtype: null,
      currentBalance: -100000,
      availableBalance: null,
      creditLimit: null,
      isManual: true,
    });
    await insertAccount(db, householdId, {
      id: "credit-positive",
      name: "Overpaid Card",
      type: "credit",
      currentBalance: 5000,
    });
    await insertAccount(db, householdId, {
      id: "credit-null",
      name: "Unknown Balance",
      type: "credit",
      currentBalance: null,
      availableBalance: null,
      creditLimit: null,
      subtype: null,
    });

    for (const [id, type] of [
      ["checking", "checking"],
      ["savings", "savings"],
      ["investment", "investment"],
      ["other", "other"],
    ] as const) {
      await insertAccount(db, householdId, { id, type, currentBalance: 999999 });
    }
    await insertAccount(db, householdId, {
      id: "hidden-credit",
      type: "credit",
      currentBalance: -900000,
      isHidden: true,
    });
    await insertAccount(db, householdId, {
      id: "deleted-loan",
      type: "loan",
      currentBalance: -800000,
      deletedAt: new Date(),
    });

    const other = await insertHousehold(db, "Other household");
    await insertAccount(db, other.householdId, {
      id: "other-household-loan",
      type: "loan",
      currentBalance: -700000,
    });

    const result = await getToolDebtSummary(householdId, db);

    expect(result.totalLiabilityBalanceCents).toBe(-195000);
    expect(result.totalDebtCents).toBe(195000);
    expect(result.groups).toEqual([
      {
        type: "credit",
        label: "Credit cards",
        liabilityBalanceCents: -95000,
        debtCents: 95000,
      },
      {
        type: "loan",
        label: "Loans",
        liabilityBalanceCents: -100000,
        debtCents: 100000,
      },
    ]);
    expect(result.accounts.map((account) => account.id)).toEqual([
      "loan-main",
      "credit-a",
      "credit-z",
      "credit-positive",
      "credit-null",
    ]);
    expect(result.accounts.find((account) => account.id === "credit-positive")?.currentBalanceCents).toBe(5000);
    expect(result.accounts.find((account) => account.id === "credit-null")).toMatchObject({
      subtype: null,
      currentBalanceCents: null,
      availableBalanceCents: null,
      creditLimitCents: null,
    });
    expect(result.accounts.find((account) => account.id === "credit-a")).toEqual({
      id: "credit-a",
      name: "Alpha Card",
      officialName: "Alpha Rewards Credit Card",
      type: "credit",
      subtype: "credit card",
      institution: "Debt Bank",
      currentBalanceCents: -50000,
      availableBalanceCents: 150000,
      creditLimitCents: 200000,
      currency: "USD",
      isManual: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /credential|bankConnectionId|externalAccountId|plaidItemId|syncCursor|encrypted-sensitive|sensitive-plaid/i,
    );
  });

  test("uses an ID tie-break for equal absolute balances", async () => {
    const { householdId } = await insertHousehold(db, "Debt ordering");
    await insertAccount(db, householdId, { id: "order-loan-z", type: "loan", currentBalance: -1000 });
    await insertAccount(db, householdId, { id: "order-credit-z", type: "credit", currentBalance: 1000 });
    await insertAccount(db, householdId, { id: "order-credit-a", type: "credit", currentBalance: -1000 });

    const result = await getToolDebtSummary(householdId, db);

    expect(result.accounts.map((account) => account.id)).toEqual([
      "order-credit-a",
      "order-credit-z",
      "order-loan-z",
    ]);
    expect(result.groups.map((group) => group.type)).toEqual(["credit", "loan"]);
  });

  test("does not write while producing the summary", async () => {
    const { householdId } = await insertHousehold(db, "Read-only debt");
    const { accountId } = await insertAccount(db, householdId, {
      type: "credit",
      currentBalance: -1234,
      updatedAt: new Date("2026-09-12T12:00:00Z"),
    });
    const before = await db.select().from(accounts);

    await getToolDebtSummary(householdId, db);

    const after = await db.select().from(accounts);
    expect(after).toEqual(before);
    expect(after.find((account) => account.id === accountId)).toBeDefined();
  });
});
