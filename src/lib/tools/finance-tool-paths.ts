export const FINANCE_TOOL_PATHS = [
  "/api/tools/accounts",
  "/api/tools/transactions",
  "/api/tools/spending-summary",
  "/api/tools/cash-flow-summary",
  "/api/tools/debt-summary",
  "/api/tools/spending-comparison",
] as const;

const financeToolPathSet = new Set<string>(FINANCE_TOOL_PATHS);

export function isFinanceToolPath(pathname: string): boolean {
  return financeToolPathSet.has(pathname);
}
