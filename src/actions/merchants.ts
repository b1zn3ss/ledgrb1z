"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db as defaultDb, type LedgrDb } from "@/db";
import { categories, merchants } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { withHousehold } from "@/lib/household-context";

const merchantIdSchema = z.string().min(1);
const categoryIdSchema = z.string().min(1);

export async function updateMerchantDefaultCategoryScoped(
  householdId: string,
  merchantId: string,
  categoryId: string,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const parsedMerchantId = merchantIdSchema.safeParse(merchantId);
  const parsedCategoryId = categoryIdSchema.safeParse(categoryId);
  if (!parsedMerchantId.success || !parsedCategoryId.success) {
    return { error: "Invalid input" };
  }

  const result = await withHousehold(householdId, async (tx) => {
    const scoped = scopedQuery(householdId, tx);
    const [category] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(scoped.where(categories, eq(categories.id, parsedCategoryId.data)))
      .limit(1);
    if (!category) return { error: "Category not found" } as const;

    const updated = await tx.update(merchants)
      .set({ categoryId: parsedCategoryId.data, updatedAt: new Date() })
      .where(scoped.where(merchants, eq(merchants.id, parsedMerchantId.data)))
      .returning({ id: merchants.id });
    if (updated.length === 0) return { error: "Merchant not found" } as const;
    return { success: true } as const;
  }, db);

  if ("error" in result) return result;

  revalidatePath("/transactions");
  return result;
}

export async function updateMerchantDefaultCategory(
  merchantId: string,
  categoryId: string,
  db: LedgrDb = defaultDb,
): Promise<{ success: true } | { error: string }> {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  return updateMerchantDefaultCategoryScoped(auth.householdId, merchantId, categoryId, db);
}
