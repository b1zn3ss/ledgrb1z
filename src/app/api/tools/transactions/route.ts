import {
  invalidFinanceToolRequest,
  resolveFinanceToolCaller,
  runFinanceToolRead,
} from "@/lib/tools/finance-tool-auth";
import { parseToolTransactionParams } from "@/lib/tools/transaction-params";
import { getToolTransactions } from "@/queries/transactions";

/**
 * Read-only transaction facts for trusted local finance tools.
 * Amounts are signed integer cents using normalizedAmount's display convention.
 */
export async function GET(request: Request) {
  const resolved = await resolveFinanceToolCaller(request);
  if (!resolved.success) return resolved.response;

  const parsed = parseToolTransactionParams(new URL(request.url).searchParams);
  if (!parsed.success) {
    return invalidFinanceToolRequest(parsed.message);
  }

  const { filters, limit, cursor } = parsed.data;
  return runFinanceToolRead(resolved.caller, (householdId, tx) =>
    getToolTransactions(householdId, filters, limit, cursor, tx),
  );
}
