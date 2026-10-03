import {
  invalidFinanceToolRequest,
  resolveFinanceToolCaller,
  runFinanceToolRead,
} from "@/lib/tools/finance-tool-auth";
import { parseToolSpendingSummaryParams } from "@/lib/tools/spending-summary-params";
import { getToolSpendingSummary } from "@/queries/reports";

/**
 * Read-only spending totals using the canonical Spending report semantics.
 * All amounts are positive integer cents.
 */
export async function GET(request: Request) {
  const resolved = await resolveFinanceToolCaller(request);
  if (!resolved.success) return resolved.response;

  const parsed = parseToolSpendingSummaryParams(
    new URL(request.url).searchParams,
  );
  if (!parsed.success) {
    return invalidFinanceToolRequest(parsed.message);
  }

  return runFinanceToolRead(resolved.caller, (householdId, tx) =>
    getToolSpendingSummary(householdId, parsed.data, tx),
  );
}
