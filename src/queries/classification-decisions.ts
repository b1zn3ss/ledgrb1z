import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb, type LedgrDb } from "@/db";
import {
  transactionClassificationDecisions,
  transactionSplits,
  transactions,
} from "@/db/schema";
import { withReadOnlyHousehold } from "@/lib/household-context";
import { scopedQuery } from "@/lib/scoped-query";

export async function getClassificationDecisionHistory(
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
    return tx.select().from(transactionClassificationDecisions)
      .where(scoped.where(
        transactionClassificationDecisions,
        eq(transactionClassificationDecisions.transactionId, transactionId),
      ))
      .orderBy(
        asc(transactionClassificationDecisions.recordedAt),
        asc(transactionClassificationDecisions.id),
      );
  }, db);
}

export async function getCurrentClassificationDecisions(
  householdId: string,
  transactionId: string,
  db: LedgrDb = defaultDb,
) {
  return withReadOnlyHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [transactionDecision] = await tx.select({
      decision: transactionClassificationDecisions,
    }).from(transactions)
      .leftJoin(
        transactionClassificationDecisions,
        and(
          eq(transactionClassificationDecisions.id, transactions.classificationDecisionId),
          eq(transactionClassificationDecisions.householdId, householdId),
          eq(transactionClassificationDecisions.transactionId, transactionId),
        ),
      )
      .where(scoped.where(transactions, eq(transactions.id, transactionId)))
      .limit(1);
    if (!transactionDecision) return null;

    const splitDecisions = await tx.select({
      splitId: transactionSplits.id,
      decision: transactionClassificationDecisions,
    }).from(transactionSplits)
      .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
      .leftJoin(
        transactionClassificationDecisions,
        and(
          eq(transactionClassificationDecisions.id, transactionSplits.classificationDecisionId),
          eq(transactionClassificationDecisions.householdId, householdId),
          eq(transactionClassificationDecisions.transactionId, transactionId),
        ),
      )
      .where(scoped.where(transactions, eq(transactions.id, transactionId)));

    return {
      transaction: transactionDecision.decision?.id ? transactionDecision.decision : null,
      splits: splitDecisions.map((row) => ({
        splitId: row.splitId,
        decision: row.decision?.id ? row.decision : null,
      })),
    };
  }, db);
}
