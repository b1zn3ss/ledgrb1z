import {
  invalidFinanceToolRequest,
  resolveFinanceToolCaller,
  runFinanceToolRead,
} from "@/lib/tools/finance-tool-auth";
import { parseToolSpendingComparisonParams } from "@/lib/tools/spending-comparison-params";
import { getToolSpendingComparison } from "@/queries/reports";

/** Read-only comparison of two canonical Spending report periods. */
export async function GET(request: Request) {
  const resolved = await resolveFinanceToolCaller(request);
  if (!resolved.success) return resolved.response;

  const parsed = parseToolSpendingComparisonParams(
    new URL(request.url).searchParams,
  );
  if (!parsed.success) {
    return invalidFinanceToolRequest(parsed.message);
  }

  const { filters, comparisonFilters } = parsed.data;
  return runFinanceToolRead(resolved.caller, (householdId, tx) =>
    getToolSpendingComparison(
      householdId,
      filters,
      comparisonFilters,
      tx,
    ),
  );
}
