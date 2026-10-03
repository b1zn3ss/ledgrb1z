import {
  resolveFinanceToolCaller,
  runFinanceToolRead,
} from "@/lib/tools/finance-tool-auth";
import { getToolAccounts } from "@/queries/accounts";

/**
 * Read-only account data for trusted local finance tools.
 * Balance fields are signed integer cents.
 */
export async function GET(request: Request) {
  const resolved = await resolveFinanceToolCaller(request);
  if (!resolved.success) return resolved.response;

  return runFinanceToolRead(resolved.caller, async (householdId, tx) => ({
    accounts: await getToolAccounts(householdId, tx),
  }));
}
