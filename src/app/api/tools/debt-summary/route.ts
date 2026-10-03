import { NextResponse } from "next/server";
import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import { getToolDebtSummary } from "@/queries/accounts";

/** Current debt snapshot using the canonical Accounts-page semantics. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: `Unsupported query parameter: ${key}`,
      },
      { status: 400 },
    );
  }

  const householdId = await getHouseholdId();
  const summary = await withHousehold(householdId, (tx) =>
    getToolDebtSummary(householdId, tx),
  );

  return NextResponse.json(summary, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
