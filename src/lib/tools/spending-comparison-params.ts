import type { ReportFilters } from "@/queries/reports";

const ALLOWED_PARAMS = new Set([
  "dateFrom",
  "dateTo",
  "comparisonDateFrom",
  "comparisonDateTo",
  "accountId",
  "categoryId",
]);
const MAX_IDENTIFIER_LENGTH = 255;

export interface ToolSpendingComparisonRequest {
  filters: ReportFilters;
  comparisonFilters: ReportFilters;
}

export type ToolSpendingComparisonParseResult =
  | { success: true; data: ToolSpendingComparisonRequest }
  | { success: false; message: string };

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim()
  );
}

function invalid(message: string): ToolSpendingComparisonParseResult {
  return { success: false, message };
}

export function parseToolSpendingComparisonParams(
  params: URLSearchParams,
): ToolSpendingComparisonParseResult {
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return invalid(`Unsupported query parameter: ${key}`);
    }
    if (params.getAll(key).length !== 1) {
      return invalid(`Query parameter must appear once: ${key}`);
    }
  }

  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  const comparisonDateFrom = params.get("comparisonDateFrom");
  const comparisonDateTo = params.get("comparisonDateTo");
  if (dateFrom === null) return invalid("dateFrom is required");
  if (dateTo === null) return invalid("dateTo is required");
  if (comparisonDateFrom === null) {
    return invalid("comparisonDateFrom is required");
  }
  if (comparisonDateTo === null) {
    return invalid("comparisonDateTo is required");
  }

  for (const [name, value] of [
    ["dateFrom", dateFrom],
    ["dateTo", dateTo],
    ["comparisonDateFrom", comparisonDateFrom],
    ["comparisonDateTo", comparisonDateTo],
  ] as const) {
    if (!isCalendarDate(value)) {
      return invalid(`${name} must be a real date in YYYY-MM-DD format`);
    }
  }

  if (dateFrom > dateTo) {
    return invalid("dateFrom must be on or before dateTo");
  }
  if (comparisonDateFrom > comparisonDateTo) {
    return invalid("comparisonDateFrom must be on or before comparisonDateTo");
  }
  if (comparisonDateTo >= dateFrom) {
    return invalid("comparisonDateTo must be before dateFrom");
  }

  const accountId = params.get("accountId");
  if (accountId !== null && !isIdentifier(accountId)) {
    return invalid("accountId must be a non-empty identifier");
  }
  const categoryId = params.get("categoryId");
  if (categoryId !== null && !isIdentifier(categoryId)) {
    return invalid("categoryId must be a non-empty identifier");
  }

  const sharedFilters = {
    accountIds: accountId === null ? undefined : [accountId],
    categoryIds: categoryId === null ? undefined : [categoryId],
  };
  return {
    success: true,
    data: {
      filters: { dateFrom, dateTo, ...sharedFilters },
      comparisonFilters: {
        dateFrom: comparisonDateFrom,
        dateTo: comparisonDateTo,
        ...sharedFilters,
      },
    },
  };
}
