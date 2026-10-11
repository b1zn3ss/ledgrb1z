import { eq, gte, inArray, lte } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { accounts, categories, transactions } from "@/db/schema";
import { notDeleted, notHidden } from "@/lib/query-helpers";
import { scopedQuery } from "@/lib/scoped-query";

export const LIQUID_ACCOUNT_TYPES = ["checking", "savings"] as const;
export const CASH_FLOW_EXCLUSION_REASONS = [
  "Non-liquid account",
  "Internal liquid-account transfer",
  "Pending",
  "Hidden",
  "Deleted",
  "Outside selected scope",
] as const;
export type CashFlowExclusionReason = (typeof CASH_FLOW_EXCLUSION_REASONS)[number];

export interface CashFlowFilters {
  dateFrom: string;
  dateTo: string;
  accountIds?: string[];
  categoryIds?: string[];
}

export interface CashFlowDecision {
  transactionId: string;
  accountId: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  date: string;
  categoryId: string | null;
  categoryName: string | null;
  normalizedAmount: number;
  transferPairId: string | null;
  pairedAccountId: string | null;
  isLiquidAccount: boolean;
  included: boolean;
  contributionCents: number;
  exclusionReason: CashFlowExclusionReason | null;
}

export interface CashFlowPeriod {
  period: string;
  cashIn: number;
  cashOut: number;
  net: number;
}

interface DecisionOptions {
  includeExcluded?: boolean;
  transactionIds?: string[];
}

export function isLiquidAccountType(type: string): boolean {
  return (LIQUID_ACCOUNT_TYPES as readonly string[]).includes(type);
}

/**
 * Canonical liquid-account cash movement. Splits are intentionally absent:
 * cash crosses the boundary once at the parent transaction amount.
 */
export async function getCashFlowDecisions(
  householdId: string,
  filters: CashFlowFilters,
  db: LedgrDb = defaultDb,
  options: DecisionOptions = {},
): Promise<CashFlowDecision[]> {
  const scoped = scopedQuery(householdId, db);
  const accountRows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
    })
    .from(accounts)
    // Disconnected accounts retain reportable transaction history.
    .where(scoped.where(accounts));

  const selectedFilter = filters.accountIds ? new Set(filters.accountIds) : null;
  const selectedLiquidIds = new Set(
    accountRows
      .filter((account) =>
        isLiquidAccountType(account.type) &&
        (selectedFilter === null || selectedFilter.has(account.id)),
      )
      .map((account) => account.id),
  );

  if (!options.includeExcluded && selectedLiquidIds.size === 0) return [];
  if (options.transactionIds?.length === 0) return [];

  const conditions = [
    gte(transactions.date, filters.dateFrom),
    lte(transactions.date, filters.dateTo),
  ];
  if (filters.categoryIds?.length) {
    conditions.push(inArray(transactions.categoryId, filters.categoryIds));
  }
  if (options.transactionIds) {
    conditions.push(inArray(transactions.id, options.transactionIds));
  }
  if (!options.includeExcluded) {
    conditions.push(inArray(transactions.accountId, [...selectedLiquidIds]));
    conditions.push(notDeleted(transactions));
    conditions.push(notHidden(transactions));
    conditions.push(eq(transactions.pending, false));
  }

  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      date: transactions.date,
      categoryId: transactions.categoryId,
      normalizedAmount: transactions.normalizedAmount,
      pending: transactions.pending,
      isHidden: transactions.isHidden,
      deletedAt: transactions.deletedAt,
      transferPairId: transactions.transferPairId,
    })
    .from(transactions)
    .where(scoped.where(transactions, ...conditions))
    .orderBy(transactions.date, transactions.id);

  const pairIds = [...new Set(rows.flatMap((row) => row.transferPairId ? [row.transferPairId] : []))];
  const pairRows = pairIds.length > 0
    ? await db
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          transferPairId: transactions.transferPairId,
        })
        .from(transactions)
        .where(scoped.where(transactions, inArray(transactions.id, pairIds)))
    : [];
  const pairedTransactionById = new Map(pairRows.map((row) => [row.id, row]));

  const categoryIds = [...new Set(rows.flatMap((row) => row.categoryId ? [row.categoryId] : []))];
  const categoryRows = categoryIds.length > 0
    ? await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(scoped.where(categories, inArray(categories.id, categoryIds)))
    : [];
  const categoryNameById = new Map(categoryRows.map((row) => [row.id, row.name]));
  const accountById = new Map(accountRows.map((account) => [account.id, account]));

  return rows.map((row) => {
    const account = accountById.get(row.accountId);
    const liquid = account ? isLiquidAccountType(account.type) : false;
    const selected = liquid && selectedLiquidIds.has(row.accountId);
    const pairedTransaction = row.transferPairId
      ? pairedTransactionById.get(row.transferPairId)
      : undefined;
    const pairedAccountId = pairedTransaction?.accountId ?? null;
    const hasReciprocalPair = pairedTransaction?.transferPairId === row.id;

    let exclusionReason: CashFlowExclusionReason | null = null;
    if (row.deletedAt !== null) exclusionReason = "Deleted";
    else if (row.isHidden) exclusionReason = "Hidden";
    else if (row.pending) exclusionReason = "Pending";
    else if (!liquid) exclusionReason = "Non-liquid account";
    else if (!selected) exclusionReason = "Outside selected scope";
    else if (hasReciprocalPair && pairedAccountId && selectedLiquidIds.has(pairedAccountId)) {
      exclusionReason = "Internal liquid-account transfer";
    }

    const included = exclusionReason === null;
    return {
      transactionId: row.id,
      accountId: row.accountId,
      accountName: account?.name ?? "",
      accountType: account?.type ?? "other",
      accountSubtype: account?.subtype ?? null,
      date: row.date,
      categoryId: row.categoryId,
      categoryName: row.categoryId ? categoryNameById.get(row.categoryId) ?? null : null,
      normalizedAmount: row.normalizedAmount,
      transferPairId: row.transferPairId,
      pairedAccountId,
      isLiquidAccount: liquid,
      included,
      contributionCents: included ? row.normalizedAmount : 0,
      exclusionReason,
    };
  });
}

export async function getCashFlowMovements(
  householdId: string,
  filters: CashFlowFilters,
  db: LedgrDb = defaultDb,
): Promise<CashFlowDecision[]> {
  return getCashFlowDecisions(householdId, filters, db);
}

export function summarizeCashFlow(movements: CashFlowDecision[]): CashFlowPeriod[] {
  const periods = new Map<string, CashFlowPeriod>();
  for (const movement of movements) {
    const period = movement.date.slice(0, 7);
    const row = periods.get(period) ?? { period, cashIn: 0, cashOut: 0, net: 0 };
    if (movement.contributionCents > 0) row.cashIn += movement.contributionCents;
    if (movement.contributionCents < 0) row.cashOut += Math.abs(movement.contributionCents);
    row.net += movement.contributionCents;
    periods.set(period, row);
  }
  return [...periods.values()].sort((a, b) => a.period.localeCompare(b.period));
}
