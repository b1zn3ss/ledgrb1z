import { NextResponse } from "next/server";
import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import { parseToolSpendingComparisonParams } from "@/lib/tools/spending-comparison-params";
import { getToolSpendingComparison } from "@/queries/reports";

/** Read-only comparison of two canonical Spending report periods. */
export async function GET(request: Request) {
  const parsed = parseToolSpendingComparisonParams(
    new URL(request.url).searchParams,
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: parsed.message },
      { status: 400 },
    );
  }

  const householdId = await getHouseholdId();
  const { filters, comparisonFilters } = parsed.data;
  const comparison = await withHousehold(householdId, (tx) =>
    getToolSpendingComparison(
      householdId,
      filters,
      comparisonFilters,
      tx,
    ),
  );

  return NextResponse.json(comparison, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
