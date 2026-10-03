import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdId: vi.fn(),
  getToolDebtSummary: vi.fn(),
  withHousehold: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getHouseholdId: mocks.getHouseholdId }));
vi.mock("@/lib/household-context", () => ({ withHousehold: mocks.withHousehold }));
vi.mock("@/queries/accounts", () => ({ getToolDebtSummary: mocks.getToolDebtSummary }));

describe("GET /api/tools/debt-summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHouseholdId.mockResolvedValue("household-active");
    mocks.getToolDebtSummary.mockResolvedValue({
      totalLiabilityBalanceCents: 0,
      totalDebtCents: 0,
      groups: [],
      accounts: [],
    });
    mocks.withHousehold.mockImplementation(async (householdId, work) =>
      work({ householdId }),
    );
  });

  it("runs the read-only summary in the active household context", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/tools/debt-summary"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getToolDebtSummary).toHaveBeenCalledWith(
      "household-active",
      { householdId: "household-active" },
    );
  });

  it.each(["foo=bar", "accountId=one", "foo=one&foo=two"])(
    "rejects every query parameter: %s",
    async (query) => {
      const { GET } = await import("./route");
      const response = await GET(
        new Request(`http://localhost/api/tools/debt-summary?${query}`),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_request",
        message: expect.any(String),
      });
      expect(mocks.getHouseholdId).not.toHaveBeenCalled();
      expect(mocks.getToolDebtSummary).not.toHaveBeenCalled();
    },
  );
});
