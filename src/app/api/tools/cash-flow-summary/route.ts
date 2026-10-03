import {
  invalidFinanceToolRequest,
  resolveFinanceToolCaller,
  runFinanceToolRead,
} from "@/lib/tools/finance-tool-auth";
import { parseToolCashFlowSummaryParams } from "@/lib/tools/cash-flow-summary-params";
import { getToolCashFlowSummary } from "@/queries/reports";

/**
 * Read-only cash-flow totals using the canonical Cash Flow report semantics.
 * All money fields are signed or positive integer cents, as named.
 */
export async function GET(request: Request) {
  const resolved = await resolveFinanceToolCaller(request);
  if (!resolved.success) return resolved.response;

  const parsed = parseToolCashFlowSummaryParams(
    new URL(request.url).searchParams,
  );
  if (!parsed.success) {
    return invalidFinanceToolRequest(parsed.message);
  }

  return runFinanceToolRead(resolved.caller, (householdId, tx) =>
    getToolCashFlowSummary(householdId, parsed.data, tx),
  );
}
