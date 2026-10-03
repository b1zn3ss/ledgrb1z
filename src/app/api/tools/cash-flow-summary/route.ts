import { NextResponse } from "next/server";
import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import { parseToolCashFlowSummaryParams } from "@/lib/tools/cash-flow-summary-params";
import { getToolCashFlowSummary } from "@/queries/reports";

/**
 * Read-only cash-flow totals using the canonical Cash Flow report semantics.
 * All money fields are signed or positive integer cents, as named.
 */
export async function GET(request: Request) {
  const parsed = parseToolCashFlowSummaryParams(
    new URL(request.url).searchParams,
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: parsed.message },
      { status: 400 },
    );
  }

  const householdId = await getHouseholdId();
  const summary = await withHousehold(householdId, (tx) =>
    getToolCashFlowSummary(householdId, parsed.data, tx),
  );

  return NextResponse.json(summary, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
