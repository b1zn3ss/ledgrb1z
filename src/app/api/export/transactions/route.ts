import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { categories, transactionSplits, transactions } from "@/db/schema";
import { getHouseholdId } from "@/lib/auth/session";
import { todayDateString } from "@/lib/date-utils";
import { withReadOnlyHousehold } from "@/lib/household-context";
import { parseTransactionFilters } from "@/lib/parse-transaction-filters";
import {
  baseTransactionQuery,
  buildTransactionConditions,
  type TransactionFilters,
} from "@/queries/transactions";

export type ExportMode = "standard" | "audit";

const STANDARD_HEADER = [
  "Date",
  "Account",
  "Merchant",
  "Amount",
  "Category",
  "Category Group",
  "Notes",
  "Original Description",
];

const AUDIT_HEADER = [
  "Transaction ID",
  "External ID",
  "Provider",
  "Date",
  "Account ID",
  "Account",
  "Merchant ID",
  "Merchant",
  "Description",
  "Original Description",
  "Raw Amount Cents",
  "Normalized Amount Cents",
  "Currency",
  "Pending",
  "Reviewed",
  "Category ID",
  "Category",
  "Category Group",
  "Category Source",
  "PFC Primary",
  "PFC Detailed",
  "Notes",
  "Tags",
  "Is Transfer",
  "Transfer Pair ID",
  "Transfer Source",
  "Is Hidden",
  "Pending Transaction ID",
  "Recurring Transaction ID",
  "Deleted At",
  "Created At",
  "Updated At",
  "AI Categorization Attempted At",
  "Merchant Resolution Attempted At",
  "Split Count",
  "Split Amount Cents",
  "Split Difference Cents",
  "Splits",
  "Category Is Income",
  "Include Transfer In Spending",
  "Include Transfer In Cash Flow",
  "Included In Spending",
  "Spending Contribution Cents",
  "Included In Cash Flow",
  "Cash Flow Income Contribution Cents",
  "Cash Flow Expense Contribution Cents",
  "Cash Flow Net Contribution Cents",
];

interface AuditSplit {
  id: string;
  categoryId: string;
  categoryName: string | null;
  amountCents: number;
  notes: string | null;
}

export async function buildCsvString(
  householdId: string,
  filters: TransactionFilters,
  db: LedgrDb = defaultDb,
  mode: ExportMode = "standard",
): Promise<string> {
  const base = baseTransactionQuery(db, householdId);
  const rows = await base.joins(
    db
      .select({
        ...base.select,
        pendingTransactionId: transactions.pendingTransactionId,
        recurringTransactionId: transactions.recurringTransactionId,
        tags: transactions.tags,
        provider: transactions.provider,
        pfcDetailed: transactions.pfcDetailed,
        deletedAt: transactions.deletedAt,
        createdAt: transactions.createdAt,
        updatedAt: transactions.updatedAt,
        aiCategorizationAttemptedAt: transactions.aiCategorizationAttemptedAt,
        merchantResolutionAttemptedAt: transactions.merchantResolutionAttemptedAt,
        categoryIsIncome: categories.isIncome,
        includeTransferInSpending: categories.includeTransferInSpending,
        includeTransferInCashFlow: categories.includeTransferInCashFlow,
      })
      .from(base.from),
  )
    .where(base.scoped.where(transactions, ...buildTransactionConditions(filters)))
    .orderBy(desc(transactions.date), desc(transactions.id));

  if (mode === "standard") {
    const dataRows = rows.map((row: (typeof rows)[0]) =>
      toCsvRow([
        row.date,
        row.accountName ?? "",
        row.merchantName ?? row.name ?? "",
        (row.normalizedAmount / 100).toFixed(2),
        row.categoryName ?? "",
        row.categoryGroupName ?? "",
        row.notes ?? "",
        row.originalName ?? "",
      ]),
    );

    return [toCsvRow(STANDARD_HEADER), ...dataRows].join("\n") + "\n";
  }

  const splitsByTransaction = new Map<string, AuditSplit[]>();
  if (rows.length > 0) {
    const splitRows = await db
      .select({
        id: transactionSplits.id,
        transactionId: transactionSplits.transactionId,
        categoryId: transactionSplits.categoryId,
        categoryName: categories.name,
        amountCents: transactionSplits.amount,
        notes: transactionSplits.notes,
      })
      .from(transactionSplits)
      .innerJoin(transactions, eq(transactionSplits.transactionId, transactions.id))
      .leftJoin(
        categories,
        and(
          eq(transactionSplits.categoryId, categories.id),
          eq(categories.householdId, householdId),
        ),
      )
      .where(base.scoped.where(transactions, ...buildTransactionConditions(filters)));

    for (const split of splitRows) {
      const existing = splitsByTransaction.get(split.transactionId) ?? [];
      existing.push({
        id: split.id,
        categoryId: split.categoryId,
        categoryName: split.categoryName,
        amountCents: split.amountCents,
        notes: split.notes,
      });
      splitsByTransaction.set(split.transactionId, existing);
    }
  }

  const dataRows = rows.map((row: (typeof rows)[0]) => {
    const splits = splitsByTransaction.get(row.id) ?? [];
    const splitAmountCents = splits.reduce((total, split) => total + split.amountCents, 0);
    const ordinaryReportTransaction = !row.isTransfer && row.transferPairId === null;
    const includedBySpendingTransferOverride =
      Boolean(row.isTransfer) &&
      row.normalizedAmount < 0 &&
      Boolean(row.includeTransferInSpending);
    const includedByCashFlowTransferOverride =
      Boolean(row.isTransfer) &&
      row.normalizedAmount < 0 &&
      Boolean(row.includeTransferInCashFlow);
    const includedInSpending =
      !row.pending &&
      row.normalizedAmount < 0 &&
      !row.categoryIsIncome &&
      (ordinaryReportTransaction || includedBySpendingTransferOverride);
    const includedInCashFlow =
      !row.pending &&
      (ordinaryReportTransaction || includedByCashFlowTransferOverride);
    const isCashFlowIncome =
      Boolean(row.categoryIsIncome) ||
      (row.categoryId === null && row.normalizedAmount > 0);
    const spendingContributionCents = includedInSpending
      ? splits.length > 0
        ? splitAmountCents
        : Math.abs(row.normalizedAmount)
      : 0;
    const cashFlowIncomeContributionCents =
      includedInCashFlow && isCashFlowIncome ? row.normalizedAmount : 0;
    const cashFlowExpenseContributionCents =
      includedInCashFlow && !isCashFlowIncome && row.normalizedAmount < 0
        ? Math.abs(row.normalizedAmount)
        : 0;

    return toCsvRow([
      row.id,
      row.externalId ?? "",
      row.provider ?? "",
      row.date,
      row.accountId,
      row.accountName ?? "",
      row.merchantId ?? "",
      row.merchantName ?? "",
      row.name,
      row.originalName,
      row.amount,
      row.normalizedAmount,
      row.currency ?? "USD",
      Boolean(row.pending),
      Boolean(row.reviewed),
      row.categoryId ?? "",
      row.categoryName ?? "",
      row.categoryGroupName ?? "",
      row.categorySource ?? "",
      row.pfcPrimary ?? "",
      row.pfcDetailed ?? "",
      row.notes ?? "",
      row.tags ?? "",
      Boolean(row.isTransfer),
      row.transferPairId ?? "",
      row.transferSource ?? "",
      Boolean(row.isHidden),
      row.pendingTransactionId ?? "",
      row.recurringTransactionId ?? "",
      formatTimestamp(row.deletedAt),
      formatTimestamp(row.createdAt),
      formatTimestamp(row.updatedAt),
      formatTimestamp(row.aiCategorizationAttemptedAt),
      formatTimestamp(row.merchantResolutionAttemptedAt),
      splits.length,
      splitAmountCents,
      splits.length > 0 ? splitAmountCents - Math.abs(row.normalizedAmount) : 0,
      splits.length > 0 ? JSON.stringify(splits) : "",
      Boolean(row.categoryIsIncome),
      Boolean(row.includeTransferInSpending),
      Boolean(row.includeTransferInCashFlow),
      includedInSpending,
      spendingContributionCents,
      includedInCashFlow,
      cashFlowIncomeContributionCents,
      cashFlowExpenseContributionCents,
      cashFlowIncomeContributionCents - cashFlowExpenseContributionCents,
    ]);
  });

  return [toCsvRow(AUDIT_HEADER), ...dataRows].join("\n") + "\n";
}

function formatTimestamp(value: Date | null): string {
  return value?.toISOString() ?? "";
}

function toCsvRow(values: Array<string | number | boolean>): string {
  return values.map((value) => csvEscape(String(value))).join(",");
}

function csvEscape(value: string): string {
  if (
    value.includes(",") ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export async function buildCsvResponse(
  householdId: string,
  filters: TransactionFilters,
  db: LedgrDb = defaultDb,
  mode: ExportMode = "standard",
): Promise<Response> {
  const csv = await buildCsvString(householdId, filters, db, mode);
  const encoder = new TextEncoder();
  const csvBytes = encoder.encode(csv);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const body = new Uint8Array(bom.length + csvBytes.length);
  body.set(bom, 0);
  body.set(csvBytes, bom.length);
  const auditSuffix = mode === "audit" ? "-audit" : "";
  const filename = "ledgr-transactions" + auditSuffix + "-" + todayDateString() + ".csv";

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + filename + '"',
    },
  });
}

export async function GET(request: NextRequest) {
  const householdId = await getHouseholdId();
  const sp = request.nextUrl.searchParams;
  const { filters } = parseTransactionFilters(Object.fromEntries(sp.entries()));
  const mode: ExportMode = sp.get("exportMode") === "audit" ? "audit" : "standard";

  return withReadOnlyHousehold(
    householdId,
    (tx) => buildCsvResponse(householdId, filters, tx, mode),
  );
}
