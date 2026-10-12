import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { createTestDb } from "./setup";
import { server } from "../mocks/server";
import { provisionHousehold } from "@/lib/auth/provision";
import { encrypt } from "@/lib/encryption";
import { accounts, bankConnections, plaidOnboardingAttempts } from "@/db/schema";
import { recoverIncompletePlaidConnection } from "@/actions/plaid";
import { getAccountsByInstitution, getPlaidOnboardingAttempts } from "@/queries/accounts";
import { resetPlaidClient } from "@/lib/plaid/client";
import { getHouseholdId } from "@/lib/auth/session";
import type { LedgrDb } from "@/db";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(() => Promise.resolve({ user: { id: "test-user-id" } })),
  getHouseholdId: vi.fn(),
}));
vi.mock("@/lib/demo-mode", () => ({ guardDemoMode: vi.fn(() => null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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

describe("Plaid incomplete connection recovery", () => {
  let db: LedgrDb;
  let close: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    resetPlaidClient();
    ({ db, close } = await createTestDb());
  });

  afterEach(async () => {
    server.resetHandlers();
    await close?.();
    close = undefined;
  });

  async function insertFailedConnection(householdId: string, id = "failed-connection") {
    await db.insert(bankConnections).values({
      id,
      householdId,
      provider: "plaid",
      credential: encrypt(`access-${id}`),
      plaidItemId: `item-${id}`,
      institutionName: "Incomplete Chase connection",
      status: "error",
      errorCode: "CONNECTION_SETUP_FAILED",
    });
    return id;
  }

  it("requires confirmation and removes an accountless failed reservation", async () => {
    const householdId = await provisionHousehold("recovery-success", db);
    vi.mocked(getHouseholdId).mockResolvedValue(householdId);
    const connectionId = await insertFailedConnection(householdId);
    let removeCalls = 0;
    server.use(
      http.post("https://sandbox.plaid.com/item/remove", () => {
        removeCalls += 1;
        return HttpResponse.json({ request_id: "req-remove" });
      }),
    );

    expect(await recoverIncompletePlaidConnection(connectionId, false, db)).toEqual({
      error: "Confirm removal before retrying cleanup",
    });
    expect(removeCalls).toBe(0);

    expect(await recoverIncompletePlaidConnection(connectionId, true, db)).toEqual({
      success: true,
    });
    expect(removeCalls).toBe(1);
    expect(await db.select().from(bankConnections)).toHaveLength(0);
  });

  it("retains the encrypted credential after failure and allows a repeated recovery", async () => {
    const householdId = await provisionHousehold("recovery-repeat", db);
    vi.mocked(getHouseholdId).mockResolvedValue(householdId);
    const connectionId = await insertFailedConnection(householdId);
    let removeCalls = 0;
    server.use(
      http.post("https://sandbox.plaid.com/item/remove", () => {
        removeCalls += 1;
        if (removeCalls === 1) {
          return HttpResponse.json({
            error_type: "API_ERROR",
            error_code: "INTERNAL_SERVER_ERROR",
            error_message: "temporary failure",
            request_id: "req-failed-remove",
          }, { status: 500 });
        }
        return HttpResponse.json({ request_id: "req-remove-retry" });
      }),
    );

    const first = await recoverIncompletePlaidConnection(connectionId, true, db);
    expect(first).toHaveProperty("error");
    const [retained] = await db.select().from(bankConnections);
    expect(retained.credential).not.toContain(`access-${connectionId}`);
    expect(retained.errorCode).toBe("CONNECTION_SETUP_FAILED");

    expect(await recoverIncompletePlaidConnection(connectionId, true, db)).toEqual({
      success: true,
    });
    expect(removeCalls).toBe(2);
    expect(await db.select().from(bankConnections)).toHaveLength(0);
  });

  it("treats ITEM_NOT_FOUND as confirmed remote removal", async () => {
    const householdId = await provisionHousehold("recovery-already-removed", db);
    vi.mocked(getHouseholdId).mockResolvedValue(householdId);
    const connectionId = await insertFailedConnection(householdId);
    server.use(
      http.post("https://sandbox.plaid.com/item/remove", () =>
        HttpResponse.json({
          error_type: "ITEM_ERROR",
          error_code: "ITEM_NOT_FOUND",
          error_message: "already removed",
          request_id: "req-not-found",
        }, { status: 400 }),
      ),
    );

    expect(await recoverIncompletePlaidConnection(connectionId, true, db)).toEqual({
      success: true,
    });
    expect(await db.select().from(bankConnections)).toHaveLength(0);
  });

  it("does not reveal or recover another household's reservation", async () => {
    const authorizedHousehold = await provisionHousehold("recovery-authorized", db);
    const otherHousehold = await provisionHousehold("recovery-other", db);
    vi.mocked(getHouseholdId).mockResolvedValue(authorizedHousehold);
    const connectionId = await insertFailedConnection(otherHousehold);
    let removeCalls = 0;
    server.use(
      http.post("https://sandbox.plaid.com/item/remove", () => {
        removeCalls += 1;
        return HttpResponse.json({ request_id: "should-not-run" });
      }),
    );

    const result = await recoverIncompletePlaidConnection(connectionId, true, db);

    expect(result).toHaveProperty("error");
    expect(removeCalls).toBe(0);
    expect(await db.select().from(bankConnections)).toHaveLength(1);
  });

  it("allows only one concurrent recovery to call Plaid", async () => {
    const householdId = await provisionHousehold("recovery-concurrent", db);
    vi.mocked(getHouseholdId).mockResolvedValue(householdId);
    const connectionId = await insertFailedConnection(householdId);
    let removeCalls = 0;
    let signalStarted!: () => void;
    let releaseRemoval!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    server.use(
      http.post("https://sandbox.plaid.com/item/remove", async () => {
        removeCalls += 1;
        signalStarted();
        await release;
        return HttpResponse.json({ request_id: "req-concurrent" });
      }),
    );

    const first = recoverIncompletePlaidConnection(connectionId, true, db);
    await started;
    const second = await recoverIncompletePlaidConnection(connectionId, true, db);
    releaseRemoval();
    const firstResult = await first;

    expect(firstResult).toEqual({ success: true });
    expect(second).toHaveProperty("error");
    expect(removeCalls).toBe(1);
  });

  it("reclaims a stale cleanup claim after a process crash", async () => {
    const householdId = await provisionHousehold("recovery-stale-cleanup", db);
    vi.mocked(getHouseholdId).mockResolvedValue(householdId);
    const connectionId = await insertFailedConnection(householdId);
    await db.update(bankConnections)
      .set({
        errorCode: "CONNECTION_CLEANUP_IN_PROGRESS",
        updatedAt: new Date(Date.now() - 20 * 60 * 1000),
      })
      .where(eq(bankConnections.id, connectionId));
    server.use(
      http.post("https://sandbox.plaid.com/item/remove", () =>
        HttpResponse.json({
          error_type: "ITEM_ERROR",
          error_code: "ITEM_NOT_FOUND",
          error_message: "removed before the process terminated",
          request_id: "req-stale-cleanup",
        }, { status: 400 }),
      ),
    );

    expect(await recoverIncompletePlaidConnection(connectionId, true, db)).toEqual({
      success: true,
    });
    expect(await db.select().from(bankConnections)).toHaveLength(0);
  });

  it("keeps active connections and connections with imported accounts ineligible", async () => {
    const householdId = await provisionHousehold("recovery-guards", db);
    vi.mocked(getHouseholdId).mockResolvedValue(householdId);
    const activeId = await insertFailedConnection(householdId, "active-connection");
    await db.update(bankConnections)
      .set({ status: "active", errorCode: null })
      .where(eq(bankConnections.id, activeId));
    const accountId = await insertFailedConnection(householdId, "connection-with-account");
    await db.insert(accounts).values({
      id: "imported-account",
      householdId,
      bankConnectionId: accountId,
      externalAccountId: "plaid-account",
      name: "Imported account",
      type: "checking",
    });
    let removeCalls = 0;
    server.use(
      http.post("https://sandbox.plaid.com/item/remove", () => {
        removeCalls += 1;
        return HttpResponse.json({ request_id: "should-not-run" });
      }),
    );

    expect(await recoverIncompletePlaidConnection(activeId, true, db)).toHaveProperty("error");
    expect(await recoverIncompletePlaidConnection(accountId, true, db)).toHaveProperty("error");
    expect(removeCalls).toBe(0);
  });

  it("exposes incomplete states without exposing encrypted credentials", async () => {
    const householdId = await provisionHousehold("recovery-observable", db);
    const otherHousehold = await provisionHousehold("recovery-observable-other", db);
    await insertFailedConnection(householdId);
    await db.insert(plaidOnboardingAttempts).values([
      {
        id: "attempt-visible",
        householdId,
        encryptedPublicToken: encrypt("public-visible-secret"),
        status: "exchange_started",
      },
      {
        id: "attempt-other",
        householdId: otherHousehold,
        encryptedPublicToken: encrypt("public-other-secret"),
        status: "exchange_failed",
      },
    ]);

    const groups = await getAccountsByInstitution(householdId, db);
    const attempts = await getPlaidOnboardingAttempts(householdId, db);

    expect(groups).toMatchObject([{
      institutionName: "Incomplete Chase connection",
      status: "error",
      errorCode: "CONNECTION_SETUP_FAILED",
      accounts: [],
    }]);
    expect(attempts).toMatchObject([{
      id: "attempt-visible",
      status: "exchange_started",
    }]);
    expect(JSON.stringify(attempts)).not.toContain("public-visible-secret");
    expect(JSON.stringify(attempts)).not.toContain("encryptedPublicToken");
  });
});
