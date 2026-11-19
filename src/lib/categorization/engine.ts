import { eq, isNull, inArray, ne, or } from "drizzle-orm";
import type { LedgrDb } from "@/db";
import { transactions, merchants, categoryRules, accounts, categories } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { notDeleted } from "@/lib/query-helpers";
import { withHousehold } from "@/lib/household-context";
import { PFC_DETAILED_TO_CATEGORY } from "./pfc-map";
import {
  applyClassificationDecisionInTransaction,
  CLASSIFICATION_PRIORITY,
} from "./decision-writer";
import { classificationMatchValueHash, type ClassificationEvidence } from "./evidence";

export interface CategorizableTransaction {
  id: string;
  name: string;
  merchantId: string | null;
  merchantName: string | null;
  merchantCategoryId: string | null;
  merchantCategoryName?: string | null;
  pfcDetailed: string | null;
}

export interface CategoryRule {
  id: string;
  categoryId: string;
  matchField: "name" | "merchant";
  matchPattern: string;
  priority: number;
  categoryName?: string;
}

export interface CategoryAssignment {
  transactionId: string;
  categoryId: string;
  source: "rule" | "merchant_default" | "pfc";
  ruleId: string | null;
  merchantId: string | null;
  decisionPriority: number;
  evidence: ClassificationEvidence;
}

type PfcTarget = string | { id: string; name: string };

export function categorizeTransactions(
  transactions: CategorizableTransaction[],
  rules: CategoryRule[],
  pfcCategoryMap: Map<string, PfcTarget> = new Map(),
): CategoryAssignment[] {
  // Lowercase each rule's pattern once (R work) rather than per transaction.
  const sorted = [...rules]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map((rule) => ({ ...rule, patternLower: rule.matchPattern.toLowerCase() }));
  const assignments: CategoryAssignment[] = [];

  for (const txn of transactions) {
    let matched = false;
    // Lowercase each candidate field once per transaction, not once per rule.
    const nameLower = txn.name?.toLowerCase() ?? null;
    const merchantLower = txn.merchantName?.toLowerCase() ?? null;

    for (const rule of sorted) {
      const target = rule.matchField === "merchant" ? merchantLower : nameLower;
      if (!target) continue;

      if (target.includes(rule.patternLower)) {
        const matchedValue = rule.matchField === "merchant" ? txn.merchantName! : txn.name;
        assignments.push({
          transactionId: txn.id,
          categoryId: rule.categoryId,
          source: "rule",
          ruleId: rule.id,
          merchantId: null,
          decisionPriority: CLASSIFICATION_PRIORITY.rule,
          evidence: {
            version: 1,
            kind: "rule",
            category: { id: rule.categoryId, name: rule.categoryName ?? rule.categoryId },
            rule: {
              id: rule.id,
              matchField: rule.matchField,
              matchPattern: rule.matchPattern,
              matchedValueHash: classificationMatchValueHash(matchedValue),
              priority: rule.priority,
              tieBreaker: rule.id,
            },
          },
        });
        matched = true;
        break;
      }
    }

    if (!matched && txn.merchantCategoryId) {
      assignments.push({
        transactionId: txn.id,
        categoryId: txn.merchantCategoryId,
        source: "merchant_default",
        ruleId: null,
        merchantId: txn.merchantId,
        decisionPriority: CLASSIFICATION_PRIORITY.merchantDefault,
        evidence: {
          version: 1,
          kind: "merchant_default",
          category: { id: txn.merchantCategoryId, name: txn.merchantCategoryName ?? txn.merchantCategoryId },
          merchant: { id: txn.merchantId!, name: txn.merchantName ?? txn.merchantId! },
        },
      });
      matched = true;
    }

    if (!matched && txn.pfcDetailed) {
      const pfcTarget = pfcCategoryMap.get(txn.pfcDetailed);
      if (pfcTarget) {
        const pfcCategoryId = typeof pfcTarget === "string" ? pfcTarget : pfcTarget.id;
        const pfcCategoryName = typeof pfcTarget === "string" ? pfcTarget : pfcTarget.name;
        assignments.push({
          transactionId: txn.id,
          categoryId: pfcCategoryId,
          source: "pfc",
          ruleId: null,
          merchantId: null,
          decisionPriority: CLASSIFICATION_PRIORITY.pfc,
          evidence: {
            version: 1,
            kind: "pfc",
            category: { id: pfcCategoryId, name: pfcCategoryName },
            detailedCode: txn.pfcDetailed,
            mappedCategoryName: pfcCategoryName,
          },
        });
      }
    }
  }

  return assignments;
}

/** Provider-agnostic: `connectionId` is a bank_connections id, Plaid or SimpleFIN alike. */
export async function categorizeSyncedTransactions(
  connectionId: string,
  householdId: string,
  db: LedgrDb,
): Promise<void> {
  return withHousehold(householdId, (tx) => doCategorizeSyncedTransactions(connectionId, householdId, tx), db);
}

async function doCategorizeSyncedTransactions(
  connectionId: string,
  householdId: string,
  db: LedgrDb,
): Promise<void> {
  const scoped = scopedQuery(householdId, db);

  const rawRules = await db
    .select({
      id: categoryRules.id,
      categoryId: categoryRules.categoryId,
      matchField: categoryRules.matchField,
      matchPattern: categoryRules.matchPattern,
      priority: categoryRules.priority,
    })
    .from(categoryRules)
    .where(scoped.where(categoryRules));

  const allCategories = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(scoped.where(categories));
  const categoryById = new Map(allCategories.map((c) => [c.id, c.name]));
  const rules: CategoryRule[] = rawRules
    .filter((rule) => categoryById.has(rule.categoryId))
    .map((rule) => ({
      ...rule,
      matchField: rule.matchField ?? "name",
      priority: rule.priority ?? 0,
      categoryName: categoryById.get(rule.categoryId)!,
    }));

  const categoryIdsByName = new Map<string, string[]>();
  for (const category of allCategories) {
    const ids = categoryIdsByName.get(category.name) ?? [];
    ids.push(category.id);
    categoryIdsByName.set(category.name, ids);
  }
  const pfcCategoryMap = new Map<string, PfcTarget>();
  for (const [pfcCode, catName] of Object.entries(PFC_DETAILED_TO_CATEGORY)) {
    const ids = categoryIdsByName.get(catName);
    // A duplicate name is ambiguous. Leaving it unclassified is deterministic
    // and safer than inheriting database row order.
    if (ids?.length === 1) pfcCategoryMap.set(pfcCode, { id: ids[0], name: catName });
  }

  const itemAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(scoped.where(accounts, eq(accounts.bankConnectionId, connectionId)));

  if (itemAccounts.length === 0) return;

  const accountIds = itemAccounts.map((a) => a.id);

  const uncategorized = await db
    .select({
      id: transactions.id,
      name: transactions.name,
      merchantId: transactions.merchantId,
      pfcDetailed: transactions.pfcDetailed,
    })
    .from(transactions)
    .where(scoped.where(
      transactions,
      inArray(transactions.accountId, accountIds),
      isNull(transactions.categoryId),
      or(isNull(transactions.categorySource), ne(transactions.categorySource, "manual")),
      notDeleted(transactions),
    ));

  if (uncategorized.length === 0) return;

  const merchantIds = [...new Set(
    uncategorized.map((t) => t.merchantId).filter((id): id is string => id !== null),
  )];
  const merchantMap = new Map<string, { name: string; categoryId: string | null; categoryName: string | null }>();
  if (merchantIds.length > 0) {
    const merchantRows = await db
      .select({ id: merchants.id, name: merchants.name, categoryId: merchants.categoryId })
      .from(merchants)
      .where(scoped.where(merchants, inArray(merchants.id, merchantIds)));
    for (const m of merchantRows) {
      merchantMap.set(m.id, {
        name: m.name,
        categoryId: m.categoryId && categoryById.has(m.categoryId) ? m.categoryId : null,
        categoryName: m.categoryId ? categoryById.get(m.categoryId) ?? null : null,
      });
    }
  }

  const categorizableTxns: CategorizableTransaction[] = uncategorized.map((txn) => {
    const merchant = txn.merchantId ? merchantMap.get(txn.merchantId) : undefined;
    return {
      id: txn.id,
      name: txn.name,
      merchantId: txn.merchantId,
      merchantName: merchant?.name ?? null,
      merchantCategoryId: merchant?.categoryId ?? null,
      merchantCategoryName: merchant?.categoryName ?? null,
      pfcDetailed: txn.pfcDetailed ?? null,
    };
  });

  const assignments = categorizeTransactions(categorizableTxns, rules, pfcCategoryMap);
  if (assignments.length === 0) return;

  for (const assignment of assignments.sort((a, b) => a.transactionId.localeCompare(b.transactionId))) {
    await applyClassificationDecisionInTransaction(householdId, {
      transactionId: assignment.transactionId,
      categoryId: assignment.categoryId,
      source: assignment.source,
      ruleId: assignment.ruleId,
      merchantId: assignment.merchantId,
      decisionPriority: assignment.decisionPriority,
      evidence: assignment.evidence,
      onlyIfUncategorized: true,
    }, db);
  }
}
