import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import { households, merchants, transactions } from "@/db/schema";
import { withHousehold } from "@/lib/household-context";
import {
  applyMerchantIdentityDecisionInTransaction,
  MERCHANT_IDENTITY_PRIORITY,
} from "@/lib/merchant-identity/decision-writer";
import { scopedQuery } from "@/lib/scoped-query";

export interface MerchantIdentityBackfillProgress {
  householdId: string;
  processed: number;
  lastTransactionId: string | null;
  complete: boolean;
}

export async function backfillMerchantIdentitySnapshots(
  options: {
    batchSize?: number;
    householdId?: string;
    onProgress?: (progress: MerchantIdentityBackfillProgress) => void;
  } = {},
  db: LedgrDb = defaultDb,
): Promise<{ processed: number; remaining: number }> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 5_000));
  const householdRows = options.householdId
    ? [{ id: options.householdId }]
    : await db.select({ id: households.id }).from(households).orderBy(asc(households.id));

  let processed = 0;
  for (const { id: householdId } of householdRows) {
    let cursor: string | null = null;
    while (true) {
      const result = await withHousehold(householdId, async (tx) => {
        const scoped = scopedQuery(householdId, tx);
        const rows = await tx.select({
          id: transactions.id,
          merchantId: merchants.id,
          merchantName: merchants.name,
        }).from(transactions)
          .innerJoin(merchants, eq(merchants.id, transactions.merchantId))
          .where(scoped.where(
            transactions,
            isNotNull(transactions.merchantId),
            isNull(transactions.merchantIdentityDecisionId),
            cursor ? gt(transactions.id, cursor) : undefined,
            eq(merchants.householdId, householdId),
          ))
          .orderBy(asc(transactions.id))
          .limit(batchSize);

        for (const row of rows) {
          await applyMerchantIdentityDecisionInTransaction(householdId, {
            transactionId: row.id,
            merchantId: row.merchantId,
            source: "legacy_unknown",
            outcome: "legacy_snapshot",
            decisionPriority: MERCHANT_IDENTITY_PRIORITY.legacy,
            decidedAt: null,
            evidence: {
              version: 1,
              kind: "legacy",
              reason: "observed_before_phase3",
              merchant: { id: row.merchantId, name: row.merchantName },
              providerIdentifierHash: null,
            },
          }, tx);
        }
        return {
          count: rows.length,
          lastId: rows.at(-1)?.id ?? cursor,
        };
      }, db);

      processed += result.count;
      cursor = result.lastId;
      options.onProgress?.({
        householdId,
        processed,
        lastTransactionId: cursor,
        complete: result.count < batchSize,
      });
      if (result.count < batchSize) break;
    }
  }

  let remaining = 0;
  for (const { id: householdId } of householdRows) {
    remaining += await withHousehold(householdId, async (tx) => {
      const [row] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(transactions)
        .where(and(
          eq(transactions.householdId, householdId),
          isNotNull(transactions.merchantId),
          isNull(transactions.merchantIdentityDecisionId),
        ));
      return row?.count ?? 0;
    }, db);
  }

  return { processed, remaining };
}
