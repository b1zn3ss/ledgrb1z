import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import {
  transactionMerchantIdentityDecisions,
  transactions,
} from "@/db/schema";
import { withReadOnlyHousehold } from "@/lib/household-context";
import { scopedQuery } from "@/lib/scoped-query";

export async function getMerchantIdentityDecisionHistory(
  householdId: string,
  transactionId: string,
  db: LedgrDb = defaultDb,
) {
  return withReadOnlyHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [owned] = await tx.select({ id: transactions.id }).from(transactions)
      .where(scoped.where(transactions, eq(transactions.id, transactionId)))
      .limit(1);
    if (!owned) return [];

    return tx.select().from(transactionMerchantIdentityDecisions)
      .where(scoped.where(
        transactionMerchantIdentityDecisions,
        eq(transactionMerchantIdentityDecisions.transactionId, transactionId),
      ))
      .orderBy(
        asc(transactionMerchantIdentityDecisions.recordedAt),
        asc(transactionMerchantIdentityDecisions.id),
      );
  }, db);
}

export async function getCurrentMerchantIdentityDecision(
  householdId: string,
  transactionId: string,
  db: LedgrDb = defaultDb,
) {
  return withReadOnlyHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [row] = await tx.select({
      decision: transactionMerchantIdentityDecisions,
    }).from(transactions)
      .leftJoin(
        transactionMerchantIdentityDecisions,
        and(
          eq(
            transactionMerchantIdentityDecisions.id,
            transactions.merchantIdentityDecisionId,
          ),
          eq(transactionMerchantIdentityDecisions.householdId, householdId),
          eq(transactionMerchantIdentityDecisions.transactionId, transactionId),
        ),
      )
      .where(scoped.where(transactions, eq(transactions.id, transactionId)))
      .limit(1);
    if (!row) return null;
    return row.decision?.id ? row.decision : null;
  }, db);
}
