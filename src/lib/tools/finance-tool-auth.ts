import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { LedgrDb } from "@/db";
import { getHouseholdId } from "@/lib/auth/session";
import { withReadOnlyHousehold } from "@/lib/household-context";
import { isFinanceToolPath } from "./finance-tool-paths";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export interface FinanceToolCaller {
  kind: "browser" | "machine";
  householdId: string;
}

type FinanceToolCallerResult =
  | { success: true; caller: FinanceToolCaller }
  | { success: false; response: NextResponse };

function unauthorized(): FinanceToolCallerResult {
  return {
    success: false,
    response: NextResponse.json(
      { error: "unauthorized", message: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS },
    ),
  };
}

function tokenMatches(provided: string, configured: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const configuredDigest = createHash("sha256").update(configured).digest();
  return timingSafeEqual(providedDigest, configuredDigest);
}

export async function resolveFinanceToolCaller(
  request: Request,
): Promise<FinanceToolCallerResult> {
  const authorization = request.headers.get("Authorization");

  if (authorization === null) {
    return {
      success: true,
      caller: { kind: "browser", householdId: await getHouseholdId() },
    };
  }

  if (!isFinanceToolPath(new URL(request.url).pathname)) return unauthorized();
  if (request.headers.get("Origin") !== null) return unauthorized();
  if (process.env.FINANCE_TOOL_API_ENABLED !== "true") return unauthorized();

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  const configuredToken = process.env.FINANCE_TOOL_API_TOKEN;
  const householdId = process.env.FINANCE_TOOL_HOUSEHOLD_ID?.trim();

  if (!match || !configuredToken || !householdId) return unauthorized();
  if (!tokenMatches(match[1], configuredToken)) return unauthorized();

  return {
    success: true,
    caller: { kind: "machine", householdId },
  };
}

export async function runFinanceToolRead<T>(
  caller: FinanceToolCaller,
  work: (householdId: string, tx: LedgrDb) => Promise<T>,
): Promise<NextResponse> {
  try {
    const result = await withReadOnlyHousehold(
      caller.householdId,
      (tx) => work(caller.householdId, tx),
    );
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json(
      { error: "internal_error", message: "Internal server error" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export function invalidFinanceToolRequest(message: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_request", message },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}
