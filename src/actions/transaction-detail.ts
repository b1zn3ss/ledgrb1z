"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { db as defaultDb, type LedgrDb } from "@/db";
import { categories, transactions, transactionSplits } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { notDeleted, countRows } from "@/lib/query-helpers";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { getHouseholdId } from "@/lib/auth/session";
import { withHousehold } from "@/lib/household-context";
import {
  applyClassificationDecisionInTransaction,
  CLASSIFICATION_PRIORITY,
  recordSplitDeletionDecisionInTransaction,
} from "@/lib/categorization/decision-writer";
import { getTransactionDetail, type TransactionDetail } from "@/queries/transactions";

const transactionIdSchema = z.string().min(1);

const updateFieldsSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    notes: z.string().max(2000).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
      .optional(),
    isTransfer: z.boolean().optional(),
    isHidden: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field required",
  });

const splitSchema = z.object({
  categoryId: z.string().min(1),
  amount: z.number().int().positive(),
  notes: z.string().max(500).nullable(),
});


export async function fetchTransactionDetail(
  transactionId: string,
  db: LedgrDb = defaultDb,
): Promise<{ data: TransactionDetail } | { error: string }> {
  const householdId = await getHouseholdId();
  const parsed = transactionIdSchema.safeParse(transactionId);
  if (!parsed.success) return { error: "Invalid input" };

  const detail = await withHousehold(householdId, (tx) => getTransactionDetail(householdId, parsed.data, tx), db);
  if (!detail) return { error: "deleted" };

  return { data: detail };
}


export async function updateTransactionFields(
  transactionId: string,
  data: z.input<typeof updateFieldsSchema>,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;

  const parsedId = transactionIdSchema.safeParse(transactionId);
  const parsedData = updateFieldsSchema.safeParse(data);
  if (!parsedId.success || !parsedData.success) return { error: "Invalid input" };

  const fields = parsedData.data;

  return withHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [existing] = await tx
      .select({
        id: transactions.id,
        externalId: transactions.externalId,
        transferPairId: transactions.transferPairId,
      })
      .from(transactions)
      .where(
        scoped.where(transactions, eq(transactions.id, parsedId.data), notDeleted(transactions)),
      )
      .limit(1);

    if (!existing) return { error: "Transaction not found" };

    if (fields.date && existing.externalId) {
      return { error: "Cannot edit date on bank-synced transactions" };
    }

    if (fields.isTransfer === false && existing.transferPairId) {
      // Record the rejection on both legs so auto-detection and Plaid's PFC
      // tagging can't silently re-pair them on the next sync.
      const rejected = {
        isTransfer: false,
        transferPairId: null,
        transferSource: "manual_rejected" as const,
        updatedAt: new Date(),
      };
      await tx.update(transactions)
        .set(rejected)
        .where(eq(transactions.id, existing.id));
      await tx.update(transactions)
        .set(rejected)
        .where(eq(transactions.id, existing.transferPairId));
      if (Object.keys(fields).length === 1) return { success: true };
    }

    const updates: Partial<typeof transactions.$inferInsert> = { updatedAt: new Date() };
    if (fields.name !== undefined) updates.name = fields.name;
    if (fields.notes !== undefined) updates.notes = fields.notes;
    if (fields.date !== undefined) updates.date = fields.date;
    if (fields.isTransfer !== undefined) {
      updates.isTransfer = fields.isTransfer;
      updates.transferSource = fields.isTransfer ? "manual" : "manual_rejected";
    }
    if (fields.isHidden !== undefined) updates.isHidden = fields.isHidden;

    await tx.update(transactions)
      .set(updates)
      .where(eq(transactions.id, existing.id));

    return { success: true };
  }, db);
}


/**
 * Confirms a low-confidence transfer suggestion (transferSource="suggested",
 * set by the single-leg pattern pass in transfer-detection.ts) from the
 * review queue. Split into a *Scoped core + session-authorized wrapper, same
 * shape as updateTransactionCategoryScoped/updateTransactionCategory, so the
 * MCP transfer tool can call the core directly with its own householdId.
 */
export async function confirmTransferSuggestionScoped(
  householdId: string,
  transactionId: string,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const parsedId = transactionIdSchema.safeParse(transactionId);
  if (!parsedId.success) return { error: "Invalid input" };

  return withHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [existing] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(scoped.where(transactions, eq(transactions.id, parsedId.data), notDeleted(transactions)))
      .limit(1);

    if (!existing) return { error: "Transaction not found" };

    await tx.update(transactions)
      .set({ isTransfer: true, transferSource: "manual", updatedAt: new Date() })
      .where(eq(transactions.id, existing.id));

    return { success: true };
  }, db);
}

export async function confirmTransferSuggestion(
  transactionId: string,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return confirmTransferSuggestionScoped(auth.householdId, transactionId, db);
}

/**
 * Rejects a transfer suggestion — keeps it as real spending/income and, via
 * transferSource="manual_rejected", stops it from ever being re-suggested by
 * a later sync (same guard applyTransferDetection already honors for pairs).
 */
export async function rejectTransferSuggestionScoped(
  householdId: string,
  transactionId: string,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const parsedId = transactionIdSchema.safeParse(transactionId);
  if (!parsedId.success) return { error: "Invalid input" };

  return withHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [existing] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(scoped.where(transactions, eq(transactions.id, parsedId.data), notDeleted(transactions)))
      .limit(1);

    if (!existing) return { error: "Transaction not found" };

    await tx.update(transactions)
      .set({ isTransfer: false, transferSource: "manual_rejected", updatedAt: new Date() })
      .where(eq(transactions.id, existing.id));

    return { success: true };
  }, db);
}

export async function rejectTransferSuggestion(
  transactionId: string,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return rejectTransferSuggestionScoped(auth.householdId, transactionId, db);
}

export async function upsertSplit(
  transactionId: string,
  splitId: string | null,
  data: z.input<typeof splitSchema>,
  db: LedgrDb = defaultDb,
): Promise<
  | { data: { id: string; categoryId: string; amount: number; notes: string | null } }
  | { error: string }
> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;

  const parsedId = transactionIdSchema.safeParse(transactionId);
  const parsedData = splitSchema.safeParse(data);
  if (!parsedId.success || !parsedData.success) return { error: "Invalid input" };

  const fields = parsedData.data;

  return withHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [txn] = await tx
      .select({
        id: transactions.id,
        normalizedAmount: transactions.normalizedAmount,
        categoryId: transactions.categoryId,
      })
      .from(transactions)
      .where(scoped.where(transactions, eq(transactions.id, parsedId.data), notDeleted(transactions)))
      .for("update")
      .limit(1);
    if (!txn) return { error: "Transaction not found" };

    const [category] = await tx
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(scoped.where(categories, eq(categories.id, fields.categoryId)))
      .limit(1);
    if (!category) return { error: "Category not found" };

    const maxAmount = Math.abs(txn.normalizedAmount);
    const existingSplits = await tx
      .select({ id: transactionSplits.id, amount: transactionSplits.amount })
      .from(transactionSplits)
      .where(eq(transactionSplits.transactionId, txn.id));

    const otherSplitsTotal = existingSplits
      .filter((s) => s.id !== splitId)
      .reduce((sum, s) => sum + s.amount, 0);

    if (otherSplitsTotal + fields.amount > maxAmount) {
      return { error: "Splits exceed transaction amount" };
    }

    let savedId: string;

    if (splitId) {
      const updated = await tx.update(transactionSplits)
        .set({
          categoryId: fields.categoryId,
          amount: fields.amount,
          notes: fields.notes,
        })
        .where(and(
          eq(transactionSplits.id, splitId),
          eq(transactionSplits.transactionId, txn.id),
        ))
        .returning({ id: transactionSplits.id });
      if (updated.length === 0) return { error: "Split not found" };
      savedId = splitId;
    } else {
      savedId = uuid();
      await tx.insert(transactionSplits)
        .values({
          id: savedId,
          transactionId: txn.id,
          categoryId: fields.categoryId,
          amount: fields.amount,
          notes: fields.notes,
        });
    }

    if (existingSplits.length === 0 && !splitId) {
      let parentCategoryName: string | null = null;
      if (txn.categoryId) {
        const [parentCategory] = await tx.select({ name: categories.name })
          .from(categories)
          .where(scoped.where(categories, eq(categories.id, txn.categoryId)))
          .limit(1);
        if (!parentCategory) throw new Error("Parent category not found");
        parentCategoryName = parentCategory.name;
      }
      await applyClassificationDecisionInTransaction(householdId, {
        transactionId: txn.id,
        categoryId: txn.categoryId,
        source: "manual",
        decisionPriority: CLASSIFICATION_PRIORITY.manual,
        evidence: {
          version: 1,
          kind: "manual",
          trigger: "split_create",
          category: txn.categoryId ? { id: txn.categoryId, name: parentCategoryName! } : null,
        },
      }, tx);
    }

    await applyClassificationDecisionInTransaction(householdId, {
      transactionId: txn.id,
      subjectType: "split",
      transactionSplitId: savedId,
      categoryId: fields.categoryId,
      source: "manual",
      decisionPriority: CLASSIFICATION_PRIORITY.manual,
      evidence: {
        version: 1,
        kind: "manual",
        trigger: splitId ? "split_update" : "split_create",
        category: { id: fields.categoryId, name: category.name },
      },
    }, tx);

    return {
      data: {
        id: savedId,
        categoryId: fields.categoryId,
        amount: fields.amount,
        notes: fields.notes ?? null,
      },
    };
  }, db);
}


export async function deleteSplit(
  splitId: string,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;

  const parsedSplitId = transactionIdSchema.safeParse(splitId);
  if (!parsedSplitId.success) return { error: "Invalid input" };

  return withHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [split] = await tx
      .select({ id: transactionSplits.id, transactionId: transactionSplits.transactionId })
      .from(transactionSplits)
      .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
      .where(scoped.where(
        transactions,
        eq(transactionSplits.id, parsedSplitId.data),
        notDeleted(transactions),
      ))
      .limit(1);

    if (!split) return { error: "Split not found" };

    const [txn] = await tx
      .select({
        id: transactions.id,
        categoryId: transactions.categoryId,
        categorySource: transactions.categorySource,
      })
      .from(transactions)
      .where(scoped.where(transactions, eq(transactions.id, split.transactionId), notDeleted(transactions)))
      .for("update")
      .limit(1);

    if (!txn) return { error: "Transaction not found" };

    await recordSplitDeletionDecisionInTransaction(householdId, txn.id, split.id, tx);

    await tx.delete(transactionSplits)
      .where(eq(transactionSplits.id, split.id));

    const [remaining] = await tx
      .select({ count: countRows() })
      .from(transactionSplits)
      .where(eq(transactionSplits.transactionId, txn.id))
      .limit(1);

    if (remaining && remaining.count === 0) {
      let categoryName: string | null = null;
      if (txn.categoryId) {
        const [category] = await tx.select({ name: categories.name })
          .from(categories)
          .where(scoped.where(categories, eq(categories.id, txn.categoryId)))
          .limit(1);
        categoryName = category?.name ?? null;
      }
      await applyClassificationDecisionInTransaction(householdId, {
        transactionId: txn.id,
        categoryId: txn.categoryId,
        source: "manual",
        decisionPriority: CLASSIFICATION_PRIORITY.manual,
        evidence: {
          version: 1,
          kind: "manual",
          trigger: "split_delete",
          category: txn.categoryId ? { id: txn.categoryId, name: categoryName! } : null,
        },
      }, tx);
    }

    return { success: true };
  }, db);
}
