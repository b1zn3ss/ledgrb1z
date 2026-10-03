import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdId: vi.fn(),
  getToolAccounts: vi.fn(),
  getToolDebtSummary: vi.fn(),
  getToolTransactions: vi.fn(),
  getToolSpendingSummary: vi.fn(),
  getToolCashFlowSummary: vi.fn(),
  getToolSpendingComparison: vi.fn(),
  withReadOnlyHousehold: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getHouseholdId: mocks.getHouseholdId,
}));
vi.mock("@/lib/household-context", () => ({
  withReadOnlyHousehold: mocks.withReadOnlyHousehold,
}));
vi.mock("@/queries/accounts", () => ({
  getToolAccounts: mocks.getToolAccounts,
  getToolDebtSummary: mocks.getToolDebtSummary,
}));
vi.mock("@/queries/transactions", () => ({
  getToolTransactions: mocks.getToolTransactions,
}));
vi.mock("@/queries/reports", () => ({
  getToolSpendingSummary: mocks.getToolSpendingSummary,
  getToolCashFlowSummary: mocks.getToolCashFlowSummary,
  getToolSpendingComparison: mocks.getToolSpendingComparison,
}));

const TOKEN = "test-machine-token-with-at-least-32-characters";
const CASES = [
  ["accounts", "/api/tools/accounts", () => import("./accounts/route")],
  ["transactions", "/api/tools/transactions", () => import("./transactions/route")],
  ["spending summary", "/api/tools/spending-summary", () => import("./spending-summary/route")],
  ["cash-flow summary", "/api/tools/cash-flow-summary", () => import("./cash-flow-summary/route")],
  ["debt summary", "/api/tools/debt-summary", () => import("./debt-summary/route")],
  [
    "spending comparison",
    "/api/tools/spending-comparison?dateFrom=2026-09-01&dateTo=2026-09-30&comparisonDateFrom=2026-08-01&comparisonDateTo=2026-08-31",
    () => import("./spending-comparison/route"),
  ],
] as const;

describe("machine authentication on the trusted finance routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("FINANCE_TOOL_API_ENABLED", "true");
    vi.stubEnv("FINANCE_TOOL_API_TOKEN", TOKEN);
    vi.stubEnv("FINANCE_TOOL_HOUSEHOLD_ID", "household-machine");
    mocks.withReadOnlyHousehold.mockImplementation(
      async (householdId, work) => work({ householdId }),
    );
    mocks.getToolAccounts.mockResolvedValue([]);
    mocks.getToolDebtSummary.mockResolvedValue({
      totalLiabilityBalanceCents: 0,
      totalDebtCents: 0,
      groups: [],
      accounts: [],
    });
    mocks.getToolTransactions.mockResolvedValue({
      transactions: [],
      nextCursor: null,
    });
    mocks.getToolSpendingSummary.mockResolvedValue({
      dateFrom: "2026-07-01",
      dateTo: "2026-09-30",
      totalSpendingCents: 0,
      categories: [],
    });
    mocks.getToolCashFlowSummary.mockResolvedValue({
      dateFrom: "2026-07-01",
      dateTo: "2026-09-30",
      incomeCents: 0,
      outflowCents: 0,
      netCashFlowCents: 0,
      savingsRatePct: null,
      periods: [],
    });
    mocks.getToolSpendingComparison.mockResolvedValue({
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      comparisonDateFrom: "2026-08-01",
      comparisonDateTo: "2026-08-31",
      totalSpendingCents: 0,
      comparisonTotalSpendingCents: 0,
      changeCents: 0,
      changePct: null,
      comparisonCoverage: {
        lateAccountCount: 0,
        accountCount: 0,
        isPartial: false,
      },
      categories: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(CASES)("supports machine auth for %s", async (_name, path, load) => {
    const { GET } = await load();
    const response = await GET(
      new Request(`http://localhost${path}`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Cookie: "better-auth.session_token=must-not-be-used",
          "X-Household-Id": "household-attacker",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.withReadOnlyHousehold).toHaveBeenLastCalledWith(
      "household-machine",
      expect.any(Function),
    );
    expect(mocks.getHouseholdId).not.toHaveBeenCalled();
  });
  it("rejects malformed bearer auth before validating query parameters", async () => {
    const { GET } = await import("./transactions/route");
    const response = await GET(
      new Request("http://localhost/api/tools/transactions?limit=invalid", {
        headers: {
          Authorization: "Bearer malformed token",
          Cookie: "better-auth.session_token=must-not-be-used",
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "unauthorized",
      message: "Unauthorized",
    });
    expect(mocks.getHouseholdId).not.toHaveBeenCalled();
    expect(mocks.getToolTransactions).not.toHaveBeenCalled();
  });

});
