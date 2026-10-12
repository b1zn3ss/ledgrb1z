import { afterEach, describe, expect, it, vi } from "vitest";
import { logPlaidError } from "./safe-error";

describe("logPlaidError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only allowlisted Plaid error fields", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sensitive = {
      accessToken: "access-secret-sentinel",
      publicToken: "public-secret-sentinel",
      clientSecret: "client-secret-sentinel",
      authorization: "Bearer authorization-secret-sentinel",
    };
    const sdkError = {
      message: `request failed with ${sensitive.accessToken}`,
      response: {
        status: 400,
        data: {
          error_code: "ITEM_NOT_FOUND",
          request_id: "safe-request-id",
          error_message: sensitive.publicToken,
        },
      },
      config: {
        data: JSON.stringify({
          access_token: sensitive.accessToken,
          public_token: sensitive.publicToken,
          secret: sensitive.clientSecret,
        }),
        headers: { Authorization: sensitive.authorization },
      },
    };

    logPlaidError("cleanup failed", "item/remove", sdkError);

    expect(errorSpy).toHaveBeenCalledWith("[plaid] cleanup failed", {
      endpoint: "item/remove",
      errorCode: "ITEM_NOT_FOUND",
      requestId: "safe-request-id",
      httpStatus: 400,
    });
    const output = JSON.stringify(errorSpy.mock.calls);
    for (const value of Object.values(sensitive)) {
      expect(output).not.toContain(value);
    }
  });

  it("does not serialize arbitrary non-Plaid errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logPlaidError("exchange failed", "item/public_token/exchange", {
      message: "public-secret-sentinel",
      stack: "access-secret-sentinel",
    });

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret-sentinel");
  });
});
