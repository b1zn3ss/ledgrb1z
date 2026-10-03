import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdId: vi.fn(),
  getToolSpendingComparison: vi.fn(),
  withHousehold: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getHouseholdId: mocks.getHouseholdId }));
vi.mock("@/lib/household-context", () => ({ withHousehold: mocks.withHousehold }));
vi.mock("@/queries/reports", () => ({
  getToolSpendingComparison: mocks.getToolSpendingComparison,
}));

const VALID_QUERY =
  "dateFrom=2026-09-01&dateTo=2026-09-30" +
  "&comparisonDateFrom=2026-08-01&comparisonDateTo=2026-08-31";

describe("GET /api/tools/spending-comparison", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHouseholdId.mockResolvedValue("household-active");
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
    mocks.withHousehold.mockImplementation(async (householdId, work) =>
      work({ householdId }),
    );
  });

  it("passes both periods and the same filters through the household context", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `http://localhost/api/tools/spending-comparison?${VALID_QUERY}&accountId=account-1&categoryId=category-1`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getToolSpendingComparison).toHaveBeenCalledWith(
      "household-active",
      {
        dateFrom: "2026-09-01",
        dateTo: "2026-09-30",
        accountIds: ["account-1"],
        categoryIds: ["category-1"],
      },
      {
        dateFrom: "2026-08-01",
        dateTo: "2026-08-31",
        accountIds: ["account-1"],
        categoryIds: ["category-1"],
      },
      { householdId: "household-active" },
    );
  });

  it.each([
    ["missing dates", ""],
    [
      "missing one date",
      "dateFrom=2026-09-01&dateTo=2026-09-30&comparisonDateFrom=2026-08-01",
    ],
    [
      "invalid calendar date",
      "dateFrom=2026-09-31&dateTo=2026-10-01&comparisonDateFrom=2026-08-01&comparisonDateTo=2026-08-31",
    ],
    [
      "reversed primary period",
      "dateFrom=2026-09-30&dateTo=2026-09-01&comparisonDateFrom=2026-08-01&comparisonDateTo=2026-08-31",
    ],
    [
      "reversed comparison period",
      "dateFrom=2026-09-01&dateTo=2026-09-30&comparisonDateFrom=2026-08-31&comparisonDateTo=2026-08-01",
    ],
    [
      "overlapping period",
      "dateFrom=2026-09-01&dateTo=2026-09-30&comparisonDateFrom=2026-08-01&comparisonDateTo=2026-09-01",
    ],
    [
      "non-prior comparison period",
      "dateFrom=2026-09-01&dateTo=2026-09-30&comparisonDateFrom=2026-10-01&comparisonDateTo=2026-10-31",
    ],
    ["unknown parameter", `${VALID_QUERY}&metric=spending`],
    ["duplicate parameter", `${VALID_QUERY}&dateFrom=2026-09-02`],
    ["empty account", `${VALID_QUERY}&accountId=`],
    ["empty category", `${VALID_QUERY}&categoryId=`],
    ["oversized identifier", `${VALID_QUERY}&accountId=${"a".repeat(256)}`],
  ])("returns 400 for %s", async (_label, query) => {
    const { GET } = await import("./route");
    const suffix = query ? `?${query}` : "";
    const response = await GET(
      new Request(`http://localhost/api/tools/spending-comparison${suffix}`),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      message: expect.any(String),
    });
    expect(mocks.getHouseholdId).not.toHaveBeenCalled();
    expect(mocks.getToolSpendingComparison).not.toHaveBeenCalled();
  });
});
