import { describe, it, expect, afterEach, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { createTestDb } from "./setup";
import { server } from "../mocks/server";
import { provisionHousehold } from "@/lib/auth/provision";
import { decrypt } from "@/lib/encryption";
import { bankConnections, accounts, balanceHistory, transactions } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { exchangeAndStoreAccounts } from "@/actions/plaid";
import { mapPlaidAccountType } from "@/lib/plaid/utils";
import { resetPlaidClient } from "@/lib/plaid/client";
import { getHouseholdId } from "@/lib/auth/session";
import { insertSoftDeletedAccount, insertTransaction } from "./helpers";
import type { LedgrDb } from "@/db";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(() => Promise.resolve({ user: { id: "test-user-id" } })),
  getHouseholdId: vi.fn(),
}));
vi.mock("@/lib/demo-mode", () => ({ guardDemoMode: vi.fn(() => null) }));

beforeAll(() => {
  vi.stubEnv("PLAID_CLIENT_ID", "test-id");
  vi.stubEnv("PLAID_SECRET", "test-secret");
  vi.stubEnv("PLAID_ENV", "sandbox");
  vi.stubEnv("ENCRYPTION_KEY", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2");
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

describe("plaid exchange flow", () => {
  let db: LedgrDb;
  let close: (() => Promise<void>) | undefined;

  beforeEach(() => {
    resetPlaidClient();
  });

  afterEach(async () => {
    server.resetHandlers();
    // Null out after closing: the pure-unit "maps account types" test never
    // calls setup(), so without this the stale (already ended) pool from the
    // previous test would be closed a second time and throw.
    await close?.();
    close = undefined;
  });

  async function setup() {
    ({ db, close } = await createTestDb());
    return db;
  }

  async function connectPlaid(publicToken: string, householdId: string, testDb: LedgrDb) {
    vi.mocked(getHouseholdId).mockResolvedValue(householdId);
    return exchangeAndStoreAccounts(publicToken, householdId, testDb);
  }

  function mockPlaidItems(
    items: Record<string, { accessToken: string; itemId: string; accountId: string }>,
  ) {
    const byAccessToken = Object.values(items).reduce<Record<string, (typeof items)[string]>>(
      (result, item) => ({ ...result, [item.accessToken]: item }),
      {},
    );

    server.use(
      http.post("https://sandbox.plaid.com/item/public_token/exchange", async ({ request }) => {
        const { public_token: publicToken } = await request.json() as { public_token: string };
        const item = items[publicToken];
        if (!item) return HttpResponse.json({ error_code: "INVALID_PUBLIC_TOKEN" }, { status: 400 });
        return HttpResponse.json({
          access_token: item.accessToken,
          item_id: item.itemId,
          request_id: "req-exchange",
        });
      }),
      http.post("https://sandbox.plaid.com/item/get", async ({ request }) => {
        const { access_token: accessToken } = await request.json() as { access_token: string };
        const item = byAccessToken[accessToken];
        return HttpResponse.json({
          item: {
            item_id: item.itemId,
            institution_id: "ins_1",
            webhook: "",
            available_products: ["transactions"],
            billed_products: ["transactions"],
            consent_expiration_time: null,
            error: null,
          },
          request_id: "req-item",
        });
      }),
      http.post("https://sandbox.plaid.com/accounts/get", async ({ request }) => {
        const { access_token: accessToken } = await request.json() as { access_token: string };
        const item = byAccessToken[accessToken];
        return HttpResponse.json({
          accounts: [{
            account_id: item.accountId,
            name: "Plaid Checking",
            official_name: null,
            type: "depository",
            subtype: "checking",
            mask: "0000",
            balances: {
              current: 100,
              available: 90,
              limit: null,
              iso_currency_code: "USD",
            },
          }],
          request_id: "req-accounts",
        });
      }),
    );
  }

  it("stores plaid item with encrypted token and creates accounts with correct balances", async () => {
    await setup();
    const hh = await provisionHousehold("user-1", db);

    const result = await connectPlaid("public-sandbox-token", hh, db);
    expect(result.success).toBe(true);
    expect(result.accountCount).toBe(4);

    const items = await db.select().from(bankConnections).where(eq(bankConnections.householdId, hh));
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("active");
    expect(items[0].institutionName).toBe("Chase");
    expect(items[0].plaidInstitutionId).toBe("ins_1");

    const decrypted = decrypt(items[0].credential);
    expect(decrypted).toBe("access-sandbox-test-token-abc123");

    const accts = await db.select().from(accounts).where(eq(accounts.householdId, hh));
    expect(accts).toHaveLength(4);

    const checking = accts.find((a) => a.externalAccountId === "plaid-acc-checking")!;
    expect(checking.currentBalance).toBe(100000);
    expect(checking.availableBalance).toBe(90000);
    expect(checking.type).toBe("checking");

    const credit = accts.find((a) => a.externalAccountId === "plaid-acc-credit")!;
    // Plaid reports $450.50 owed as +45050; Ledgr stores owed as negative so
    // net worth is the plain sum of balances. See db/schema/accounts.ts.
    expect(credit.currentBalance).toBe(-45050);
    // Credit limit is a capacity, not a debt — not sign-flipped.
    expect(credit.creditLimit).toBe(100000);
    expect(credit.type).toBe("credit");

    // The same normalized value must reach balance_history, or the net-worth
    // chart and the live figure would disagree by twice the debt.
    const creditHistory = await db
      .select()
      .from(balanceHistory)
      .where(eq(balanceHistory.accountId, credit.id));
    expect(creditHistory).toHaveLength(1);
    expect(creditHistory[0].balance).toBe(-45050);
  });

  it("rejects a household outside the authenticated scope before token exchange", async () => {
    await setup();
    const authorizedHousehold = await provisionHousehold("user-authorized", db);
    const otherHousehold = await provisionHousehold("user-other", db);
    let exchangeCalls = 0;
    vi.mocked(getHouseholdId).mockResolvedValue(authorizedHousehold);
    server.use(
      http.post("https://sandbox.plaid.com/item/public_token/exchange", () => {
        exchangeCalls += 1;
        return HttpResponse.json({
          access_token: "should-not-be-used",
          item_id: "should-not-be-created",
          request_id: "req-unauthorized",
        });
      }),
    );

    const result = await exchangeAndStoreAccounts("public-unauthorized", otherHousehold, db);

    expect(result).toEqual({ success: false, error: "Not authorized for this household" });
    expect(exchangeCalls).toBe(0);
    expect(await db.select().from(bankConnections)).toHaveLength(0);
  });

  it("connects two different Chase Items to the same household", async () => {
    await setup();
    const hh = await provisionHousehold("user-two-chase-items", db);
    mockPlaidItems({
      "public-chase-a": {
        accessToken: "access-chase-a",
        itemId: "plaid-item-chase-a",
        accountId: "plaid-account-chase-a",
      },
      "public-chase-b": {
        accessToken: "access-chase-b",
        itemId: "plaid-item-chase-b",
        accountId: "plaid-account-chase-b",
      },
    });

    const first = await connectPlaid("public-chase-a", hh, db);
    const second = await connectPlaid("public-chase-b", hh, db);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const connections = await db
      .select()
      .from(bankConnections)
      .where(eq(bankConnections.householdId, hh));
    expect(connections).toHaveLength(2);
    expect(connections.map((connection) => connection.plaidInstitutionId)).toEqual(["ins_1", "ins_1"]);
    expect(new Set(connections.map((connection) => connection.plaidItemId))).toEqual(
      new Set(["plaid-item-chase-a", "plaid-item-chase-b"]),
    );
  });

  it("stores null balances as null, not zero", async () => {
    await setup();
    const hh = await provisionHousehold("user-null", db);

    await connectPlaid("public-sandbox-token", hh, db);

    const accts = await db.select().from(accounts).where(eq(accounts.householdId, hh));
    const investment = accts.find((a) => a.externalAccountId === "plaid-acc-null")!;
    expect(investment.currentBalance).toBeNull();
    expect(investment.availableBalance).toBeNull();
    expect(investment.type).toBe("investment");
  });

  it("creates balance_history for accounts with non-null balances only", async () => {
    await setup();
    const hh = await provisionHousehold("user-history", db);

    await connectPlaid("public-sandbox-token", hh, db);

    const history = await db.select().from(balanceHistory);
    expect(history.length).toBe(3);
  });

  it("isolates distinct Plaid Items and accounts between households", async () => {
    await setup();
    const hhA = await provisionHousehold("user-a", db);
    const hhB = await provisionHousehold("user-b", db);
    mockPlaidItems({
      "public-household-a": {
        accessToken: "access-household-a",
        itemId: "plaid-item-household-a",
        accountId: "plaid-account-household-a",
      },
      "public-household-b": {
        accessToken: "access-household-b",
        itemId: "plaid-item-household-b",
        accountId: "plaid-account-household-b",
      },
    });

    await connectPlaid("public-household-a", hhA, db);
    await connectPlaid("public-household-b", hhB, db);

    const scopeA = scopedQuery(hhA, db);
    const scopeB = scopedQuery(hhB, db);
    const [connectionsA, connectionsB, accountsA, accountsB] = await Promise.all([
      db.select().from(bankConnections).where(scopeA.where(bankConnections)),
      db.select().from(bankConnections).where(scopeB.where(bankConnections)),
      db.select().from(accounts).where(scopeA.where(accounts)),
      db.select().from(accounts).where(scopeB.where(accounts)),
    ]);

    expect(connectionsA.map((connection) => connection.plaidItemId)).toEqual(["plaid-item-household-a"]);
    expect(connectionsB.map((connection) => connection.plaidItemId)).toEqual(["plaid-item-household-b"]);
    expect(accountsA.map((account) => account.externalAccountId)).toEqual(["plaid-account-household-a"]);
    expect(accountsB.map((account) => account.externalAccountId)).toEqual(["plaid-account-household-b"]);
  });

  it("rejects the same Plaid Item twice without duplicating or revoking it", async () => {
    await setup();
    const hh = await provisionHousehold("user-dup", db);
    let removeCalls = 0;
    server.use(
      http.post("https://sandbox.plaid.com/item/remove", () => {
        removeCalls += 1;
        return HttpResponse.json({ request_id: "req-remove" });
      }),
    );

    await connectPlaid("public-sandbox-token", hh, db);
    const result = await connectPlaid("public-sandbox-token", hh, db);

    expect(result.success).toBe(false);
    expect(result.error).toContain("already connected");
    expect(removeCalls).toBe(0);
    expect(await db.select().from(bankConnections).where(eq(bankConnections.householdId, hh))).toHaveLength(1);
    expect(await db.select().from(accounts).where(eq(accounts.householdId, hh))).toHaveLength(4);
  });

  it("removes a reserved Plaid Item when account insertion fails", async () => {
    await setup();
    const hh = await provisionHousehold("user-insert-failure", db);
    let removedAccessToken: string | null = null;
    server.use(
      http.post("https://sandbox.plaid.com/accounts/get", () =>
        HttpResponse.json({
          accounts: [{
            account_id: "invalid-account",
            name: null,
            official_name: null,
            type: "depository",
            subtype: "checking",
            mask: "9999",
            balances: {
              current: 100,
              available: 100,
              limit: null,
              iso_currency_code: "USD",
            },
          }],
          request_id: "req-invalid-account",
        }),
      ),
      http.post("https://sandbox.plaid.com/item/remove", async ({ request }) => {
        const body = await request.json() as { access_token: string };
        removedAccessToken = body.access_token;
        return HttpResponse.json({ request_id: "req-remove" });
      }),
    );

    const result = await connectPlaid("public-sandbox-token", hh, db);

    expect(result.success).toBe(false);
    expect(result.error).toContain("incomplete connection was removed");
    expect(removedAccessToken).toBe("access-sandbox-test-token-abc123");
    expect(await db.select().from(bankConnections).where(eq(bankConnections.householdId, hh))).toHaveLength(0);
    expect(await db.select().from(accounts).where(eq(accounts.householdId, hh))).toHaveLength(0);
  });

  it("maps account types correctly", () => {
    expect(mapPlaidAccountType("depository", "checking")).toBe("checking");
    expect(mapPlaidAccountType("depository", "savings")).toBe("savings");
    expect(mapPlaidAccountType("depository", "money market")).toBe("checking");
    expect(mapPlaidAccountType("credit", "credit card")).toBe("credit");
    expect(mapPlaidAccountType("loan", "mortgage")).toBe("loan");
    expect(mapPlaidAccountType("investment", "401k")).toBe("investment");
    expect(mapPlaidAccountType("other", null)).toBe("other");
  });

  it("resurrects soft-deleted accounts on re-link instead of creating new ones", async () => {
    await setup();
    const hh = await provisionHousehold("user-relink", db);

    const { accountId: oldCheckingId } = await insertSoftDeletedAccount(db, hh, {
      externalAccountId: "plaid-acc-checking",
      name: "Old Checking",
      type: "checking",
    });
    await insertTransaction(db, hh, oldCheckingId, {
      name: "Old Transaction",
      notes: "user-edited-note",
    });

    const result = await connectPlaid("public-sandbox-token", hh, db);
    expect(result.success).toBe(true);

    const allAccts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.householdId, hh));
    const activeAccts = allAccts.filter((a) => a.deletedAt === null);

    const checking = activeAccts.find((a) => a.externalAccountId === "plaid-acc-checking")!;
    expect(checking).toBeDefined();
    expect(checking.id).toBe(oldCheckingId);
    expect(checking.deletedAt).toBeNull();
    expect(checking.bankConnectionId).not.toBeNull();

    const txns = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, oldCheckingId));
    expect(txns).toHaveLength(1);
    expect(txns[0].notes).toBe("user-edited-note");
  });

  it("resurrects the most recently deleted account when duplicates exist", async () => {
    await setup();
    const hh = await provisionHousehold("user-dup-deleted", db);

    const olderDate = new Date("2026-01-01");
    const newerDate = new Date("2026-05-01");

    const { accountId: olderId } = await insertSoftDeletedAccount(db, hh, {
      externalAccountId: "plaid-acc-checking",
      name: "Older Checking",
      type: "checking",
      deletedAt: olderDate,
    });
    const { accountId: newerId } = await insertSoftDeletedAccount(db, hh, {
      externalAccountId: "plaid-acc-checking",
      name: "Newer Checking",
      type: "checking",
      deletedAt: newerDate,
    });

    const result = await connectPlaid("public-sandbox-token", hh, db);
    expect(result.success).toBe(true);

    const allAccts = await db.select().from(accounts).where(eq(accounts.householdId, hh));
    const checking = allAccts.find(
      (a) => a.externalAccountId === "plaid-acc-checking" && a.deletedAt === null,
    )!;
    expect(checking.id).toBe(newerId);

    const older = allAccts.find((a) => a.id === olderId)!;
    expect(older.deletedAt).not.toBeNull();
  });
});
