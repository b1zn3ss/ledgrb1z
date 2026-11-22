"use server";

import { eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { db as defaultDb, type LedgrDb } from "@/db";
import { merchantAliases, merchants } from "@/db/schema";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { withHousehold } from "@/lib/household-context";
import {
  applyMerchantIdentityDecisionInTransaction,
  MERCHANT_IDENTITY_PRIORITY,
} from "@/lib/merchant-identity/decision-writer";
import {
  MERCHANT_ALIAS_NORMALIZATION_VERSION,
  normalizeMerchantAlias,
} from "@/lib/merchant-identity/normalization";
import { scopedQuery } from "@/lib/scoped-query";

const idSchema = z.string().min(1);
const aliasSchema = z.string().min(1).max(500);
const providerSchema = z.enum(["plaid", "simplefin", "csv", "ofx"]).nullable();

export async function assignTransactionMerchantScoped(
  householdId: string,
  transactionId: string,
  merchantId: string | null,
  db: LedgrDb = defaultDb,
): Promise<{ success: true; decisionId?: string } | { error: string }> {
  const parsedTransactionId = idSchema.safeParse(transactionId);
  const parsedMerchantId = merchantId === null
    ? { success: true as const, data: null }
    : idSchema.safeParse(merchantId);
  if (!parsedTransactionId.success || !parsedMerchantId.success) return { error: "Invalid input" };

  const result = await withHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    let selected: { id: string; name: string } | null = null;
    if (parsedMerchantId.data) {
      [selected] = await tx.select({ id: merchants.id, name: merchants.name })
        .from(merchants)
        .where(scoped.where(merchants, eq(merchants.id, parsedMerchantId.data)))
        .limit(1);
      if (!selected) return { error: "Merchant not found" } as const;
    }

    try {
      const decision = await applyMerchantIdentityDecisionInTransaction(householdId, {
        transactionId: parsedTransactionId.data,
        merchantId: selected?.id ?? null,
        source: "manual",
        outcome: selected ? "assigned" : "cleared",
        decisionPriority: MERCHANT_IDENTITY_PRIORITY.manual,
        evidence: {
          version: 1,
          kind: "manual",
          trigger: selected ? "single" : "clear",
          merchant: selected,
        },
      }, tx);
      return {
        success: true,
        ...(decision.applied ? { decisionId: decision.decisionId } : {}),
      } as const;
    } catch (error) {
      if (error instanceof Error && error.message === "Transaction not found") {
        return { error: "Transaction not found" } as const;
      }
      throw error;
    }
  }, db);

  if ("success" in result) revalidatePath("/transactions");
  return result;
}

export async function assignTransactionMerchant(
  transactionId: string,
  merchantId: string | null,
  db: LedgrDb = defaultDb,
) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return assignTransactionMerchantScoped(auth.householdId, transactionId, merchantId, db);
}

export async function approveMerchantAliasScoped(
  householdId: string,
  userId: string,
  merchantId: string,
  alias: string,
  provider: "plaid" | "simplefin" | "csv" | "ofx" | null,
  db: LedgrDb = defaultDb,
): Promise<{ success: true; aliasId: string } | { error: string }> {
  const parsedMerchantId = idSchema.safeParse(merchantId);
  const parsedAlias = aliasSchema.safeParse(alias);
  const parsedProvider = providerSchema.safeParse(provider);
  if (!parsedMerchantId.success || !parsedAlias.success || !parsedProvider.success) {
    return { error: "Invalid input" };
  }
  const normalizedAlias = normalizeMerchantAlias(parsedAlias.data);
  if (!normalizedAlias) return { error: "Alias cannot be empty" };

  return withHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [merchant] = await tx.select({ id: merchants.id })
      .from(merchants)
      .where(scoped.where(merchants, eq(merchants.id, parsedMerchantId.data)))
      .for("update")
      .limit(1);
    if (!merchant) return { error: "Merchant not found" } as const;

    const providerCondition = parsedProvider.data === null
      ? isNull(merchantAliases.provider)
      : eq(merchantAliases.provider, parsedProvider.data);
    const existing = await tx.select({
      id: merchantAliases.id,
      merchantId: merchantAliases.merchantId,
    }).from(merchantAliases)
      .where(scoped.where(
        merchantAliases,
        providerCondition,
        eq(merchantAliases.normalizationVersion, MERCHANT_ALIAS_NORMALIZATION_VERSION),
        eq(merchantAliases.normalizedAlias, normalizedAlias),
        isNull(merchantAliases.revokedAt),
      ));
    if (existing.length > 0) {
      if (existing.length === 1 && existing[0].merchantId === merchant.id) {
        return { success: true, aliasId: existing[0].id } as const;
      }
      return { error: "Alias is already assigned to another merchant" } as const;
    }

    const aliasId = uuid();
    await tx.insert(merchantAliases).values({
      id: aliasId,
      householdId,
      merchantId: merchant.id,
      provider: parsedProvider.data,
      normalizedAlias,
      normalizationVersion: MERCHANT_ALIAS_NORMALIZATION_VERSION,
      source: "user_approved",
      approvedBy: userId,
      approvedAt: new Date(),
      createdAt: new Date(),
    });
    await tx.update(merchants).set({
      identityStatus: "user_verified",
      updatedAt: new Date(),
    }).where(scoped.where(merchants, eq(merchants.id, merchant.id)));
    return { success: true, aliasId } as const;
  }, db);
}

export async function approveMerchantAlias(
  merchantId: string,
  alias: string,
  provider: "plaid" | "simplefin" | "csv" | "ofx" | null,
  db: LedgrDb = defaultDb,
) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return approveMerchantAliasScoped(
    auth.householdId,
    auth.userId,
    merchantId,
    alias,
    provider,
    db,
  );
}

export async function revokeMerchantAliasScoped(
  householdId: string,
  aliasId: string,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const parsedAliasId = idSchema.safeParse(aliasId);
  if (!parsedAliasId.success) return { error: "Invalid input" };

  return withHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const updated = await tx.update(merchantAliases).set({ revokedAt: new Date() })
      .where(scoped.where(
        merchantAliases,
        eq(merchantAliases.id, parsedAliasId.data),
        isNull(merchantAliases.revokedAt),
      ))
      .returning({ id: merchantAliases.id });
    if (updated.length === 0) return { error: "Alias not found" } as const;
    return { success: true } as const;
  }, db);
}

export async function revokeMerchantAlias(aliasId: string, db: LedgrDb = defaultDb) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return revokeMerchantAliasScoped(auth.householdId, aliasId, db);
}
