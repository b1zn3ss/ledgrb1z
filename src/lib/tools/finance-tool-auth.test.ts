import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdId: vi.fn(),
  withReadOnlyHousehold: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getHouseholdId: mocks.getHouseholdId,
}));
vi.mock("@/lib/household-context", () => ({
  withReadOnlyHousehold: mocks.withReadOnlyHousehold,
}));

const TOKEN = "test-machine-token-with-at-least-32-characters";

function machineRequest(
  authorization = `Bearer ${TOKEN}`,
  init: { origin?: string; url?: string; cookie?: string } = {},
) {
  const headers = new Headers({ Authorization: authorization });
  if (init.origin !== undefined) headers.set("Origin", init.origin);
  if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
  return new Request(
    init.url ?? "http://localhost/api/tools/accounts",
    { headers },
  );
}

describe("finance tool caller authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("FINANCE_TOOL_API_ENABLED", "true");
    vi.stubEnv("FINANCE_TOOL_API_TOKEN", TOKEN);
    vi.stubEnv("FINANCE_TOOL_HOUSEHOLD_ID", "household-machine");
    mocks.getHouseholdId.mockResolvedValue("household-browser");
    mocks.withReadOnlyHousehold.mockImplementation(
      async (householdId, work) => work({ householdId }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a valid bearer token and uses only the configured household", async () => {
    const { resolveFinanceToolCaller } = await import("./finance-tool-auth");
    const result = await resolveFinanceToolCaller(
      machineRequest(undefined, {
        url: "http://localhost/api/tools/accounts?householdId=attacker",
      }),
    );

    expect(result).toEqual({
      success: true,
      caller: { kind: "machine", householdId: "household-machine" },
    });
    expect(mocks.getHouseholdId).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid token", `Bearer ${TOKEN}-wrong`],
    ["wrong scheme", `Basic ${TOKEN}`],
    ["missing token", "Bearer"],
    ["extra fields", `Bearer ${TOKEN} extra`],
  ])("returns a generic 401 for %s", async (_label, authorization) => {
    const { resolveFinanceToolCaller } = await import("./finance-tool-auth");
    const result = await resolveFinanceToolCaller(
      machineRequest(authorization, { cookie: "better-auth.session_token=valid" }),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected authentication failure");
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.response.json()).toEqual({
      error: "unauthorized",
      message: "Unauthorized",
    });
    expect(mocks.getHouseholdId).not.toHaveBeenCalled();
  });

  it("preserves browser-session household resolution when Authorization is absent", async () => {
    const { resolveFinanceToolCaller } = await import("./finance-tool-auth");
    const result = await resolveFinanceToolCaller(
      new Request("http://localhost/api/tools/accounts", {
        headers: { Cookie: "better-auth.session_token=valid" },
      }),
    );

    expect(result).toEqual({
      success: true,
      caller: { kind: "browser", householdId: "household-browser" },
    });
    expect(mocks.getHouseholdId).toHaveBeenCalledOnce();
  });

  it.each([
    ["disabled API", "false", TOKEN, "household-machine", undefined],
    ["missing token", "true", undefined, "household-machine", undefined],
    ["missing household", "true", TOKEN, undefined, undefined],
    ["browser Origin", "true", TOKEN, "household-machine", "http://localhost"],
  ])(
    "fails closed for %s",
    async (_label, enabled, token, householdId, origin) => {
      vi.stubEnv("FINANCE_TOOL_API_ENABLED", enabled);
      vi.stubEnv("FINANCE_TOOL_API_TOKEN", token);
      vi.stubEnv("FINANCE_TOOL_HOUSEHOLD_ID", householdId);

      const { resolveFinanceToolCaller } = await import("./finance-tool-auth");
      const result = await resolveFinanceToolCaller(
        machineRequest(undefined, { origin }),
      );

      expect(result.success).toBe(false);
      if (result.success) throw new Error("Expected authentication failure");
      expect(result.response.status).toBe(401);
      expect(mocks.getHouseholdId).not.toHaveBeenCalled();
    },
  );

  it("rejects bearer authentication outside the exact six-route scope", async () => {
    const { resolveFinanceToolCaller } = await import("./finance-tool-auth");
    const result = await resolveFinanceToolCaller(
      machineRequest(undefined, { url: "http://localhost/api/search" }),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected authentication failure");
    expect(result.response.status).toBe(401);
  });

  it("uses the read-only household executor and sanitizes internal failures", async () => {
    const leaked = `${TOKEN} household-machine SELECT secret FROM plaid_tokens`;
    mocks.withReadOnlyHousehold.mockRejectedValueOnce(new Error(leaked));

    const { runFinanceToolRead } = await import("./finance-tool-auth");
    const response = await runFinanceToolRead({ kind: "machine", householdId: "household-machine" }, async () => ({
      ok: true,
    }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toBe(
      '{"error":"internal_error","message":"Internal server error"}',
    );
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("household-machine");
    expect(body).not.toContain("SELECT");
  });
});
