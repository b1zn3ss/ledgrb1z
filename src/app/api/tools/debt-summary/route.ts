import {
  invalidFinanceToolRequest,
  resolveFinanceToolCaller,
  runFinanceToolRead,
} from "@/lib/tools/finance-tool-auth";
import { getToolDebtSummary } from "@/queries/accounts";

/** Current debt snapshot using the canonical Accounts-page semantics. */
export async function GET(request: Request) {
  const resolved = await resolveFinanceToolCaller(request);
  if (!resolved.success) return resolved.response;

  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    return invalidFinanceToolRequest(`Unsupported query parameter: ${key}`);
  }

  return runFinanceToolRead(resolved.caller, (householdId, tx) =>
    getToolDebtSummary(householdId, tx),
  );
}
