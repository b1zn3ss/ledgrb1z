import { extractPlaidErrorCode } from "./utils";

interface PlaidErrorResponse {
  status?: unknown;
  data?: {
    request_id?: unknown;
  };
}

/**
 * Log only fields that are safe and useful for Plaid support. Plaid SDK errors
 * are Axios errors and may contain request bodies, headers, and plaintext
 * credentials, so callers must never pass the original error to console.
 */
export function logPlaidError(
  event: string,
  endpoint: string,
  error: unknown,
): void {
  const response = error && typeof error === "object" && "response" in error
    ? (error as { response?: PlaidErrorResponse }).response
    : undefined;
  const requestId = typeof response?.data?.request_id === "string"
    ? response.data.request_id
    : undefined;
  const httpStatus = typeof response?.status === "number"
    ? response.status
    : undefined;

  console.error(`[plaid] ${event}`, {
    endpoint,
    errorCode: extractPlaidErrorCode(error),
    requestId,
    httpStatus,
  });
}
