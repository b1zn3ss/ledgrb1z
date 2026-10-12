"use server";

import { v4 as uuid } from "uuid";
import { eq, and, isNotNull, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { Products, CountryCode } from "plaid";
import { getPlaidClient } from "@/lib/plaid/client";
import { encrypt, decrypt } from "@/lib/encryption";
import { plaidAmountToCents, plaidBalanceToCents } from "@/lib/money";
import { mapPlaidAccountType, extractPlaidErrorCode } from "@/lib/plaid/utils";
import { logPlaidError } from "@/lib/plaid/safe-error";
import { todayDateString } from "@/lib/date-utils";
import { getHouseholdId } from "@/lib/auth/session";
import { authorizeAction } from "@/lib/auth/authorize-action";
import { db as defaultDb, type LedgrDb } from "@/db";
import { bankConnections, plaidOnboardingAttempts, accounts, balanceHistory, institutionLogos } from "@/db/schema";
import { scopedQuery } from "@/lib/scoped-query";
import { syncInstitution } from "@/lib/plaid/sync";
import { syncInvestments } from "@/lib/plaid/investments";

export async function createLinkToken() {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;

  try {
    const response = await getPlaidClient().linkTokenCreate({
      user: { client_user_id: auth.userId },
      client_name: "Ledgr",
      products: [Products.Transactions],
      optional_products: [Products.Investments],
      country_codes: [CountryCode.Us],
      language: "en",
      ...(process.env.PLAID_WEBHOOK_URL
        ? { webhook: process.env.PLAID_WEBHOOK_URL }
        : {}),
      ...(process.env.PLAID_OAUTH_REDIRECT_URI
        ? { redirect_uri: process.env.PLAID_OAUTH_REDIRECT_URI }
        : {}),
    });
    return { linkToken: response.data.link_token };
  } catch (e: unknown) {
    logPlaidError("link token creation failed", "link/token/create", e);
    return { error: "Failed to initialize bank connection" };
  }
}

export async function exchangeAndStoreAccounts(
  publicToken: string,
  householdId: string,
  db: LedgrDb = defaultDb
): Promise<
  | { success: true; accountCount: number; plaidItemId: string; error?: never }
  | { success: false; error: string; accountCount?: never; plaidItemId?: never }
> {
  const auth = await authorizeAction();
  if ("error" in auth) return { success: false, error: auth.error };
  if (auth.householdId !== householdId) {
    return { success: false, error: "Not authorized for this household" };
  }
  const scoped = scopedQuery(householdId, db);

  const onboardingAttemptId = uuid();
  try {
    await db.insert(plaidOnboardingAttempts).values({
      id: onboardingAttemptId,
      householdId,
      encryptedPublicToken: encrypt(publicToken),
      status: "exchange_pending",
    });
  } catch {
    console.error("[plaid] could not create durable onboarding attempt");
    return { success: false, error: "Failed to start a secure bank connection" };
  }

  let reservedConnectionId: string | null = null;
  let exchangedAccessToken: string | null = null;
  let failedEndpoint = "item/public_token/exchange";

  try {
    await db
      .update(plaidOnboardingAttempts)
      .set({ status: "exchange_started", updatedAt: new Date() })
      .where(
        scoped.where(
          plaidOnboardingAttempts,
          eq(plaidOnboardingAttempts.id, onboardingAttemptId),
        ),
      );

    const exchangeRes = await getPlaidClient().itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = exchangeRes.data.access_token;
    const exchangedPlaidItemId = exchangeRes.data.item_id;
    exchangedAccessToken = accessToken;

    const plaidItemId = uuid();
    failedEndpoint = "local/reservation";
    const reservationCreated = await db.transaction(async (tx) => {
      const [reserved] = await tx
        .insert(bankConnections)
        .values({
          id: plaidItemId,
          householdId,
          provider: "plaid",
          credential: encrypt(accessToken),
          plaidItemId: exchangedPlaidItemId,
          institutionName: "Connecting institution",
          status: "error",
          errorCode: "CONNECTION_SETUP_IN_PROGRESS",
        })
        .onConflictDoNothing({ target: bankConnections.plaidItemId })
        .returning({ id: bankConnections.id });

      await tx
        .delete(plaidOnboardingAttempts)
        .where(
          scoped.where(
            plaidOnboardingAttempts,
            eq(plaidOnboardingAttempts.id, onboardingAttemptId),
          ),
        );

      return reserved !== undefined;
    });

    if (!reservationCreated) {
      return { success: false, error: "This bank connection is already connected" };
    }

    reservedConnectionId = plaidItemId;

    failedEndpoint = "item/get";
    const itemRes = await getPlaidClient().itemGet({ access_token: accessToken });
    const institutionId = itemRes.data.item.institution_id ?? null;

    let institutionName = "Unknown Institution";
    let institutionLogo: string | null = null;
    let institutionPrimaryColor: string | null = null;
    if (institutionId) {
      try {
        const instRes = await getPlaidClient().institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us],
          options: { include_optional_metadata: true },
        });
        institutionName = instRes.data.institution.name;
        institutionLogo = instRes.data.institution.logo ?? null;
        institutionPrimaryColor = instRes.data.institution.primary_color ?? null;
      } catch {
        // Fall back to "Unknown Institution" if lookup fails
      }
    }

    failedEndpoint = "accounts/get";
    const accountsRes = await getPlaidClient().accountsGet({
      access_token: accessToken,
    });
    const plaidAccounts = accountsRes.data.accounts;

    const today = todayDateString();

    failedEndpoint = "local/account_persistence";
    await db.transaction(async (tx) => {
      const [activated] = await tx.update(bankConnections)
        .set({
          plaidInstitutionId: institutionId,
          institutionName,
          primaryColor: institutionPrimaryColor,
          status: "active",
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(
          scoped.where(
            bankConnections,
            eq(bankConnections.id, plaidItemId),
            eq(bankConnections.status, "error"),
            eq(bankConnections.errorCode, "CONNECTION_SETUP_IN_PROGRESS"),
          ),
        )
        .returning({ id: bankConnections.id });

      if (!activated) {
        throw new Error("Plaid reservation is no longer available for activation");
      }

      if (institutionLogo) {
        await tx.insert(institutionLogos)
          .values({
            id: uuid(),
            connectionId: plaidItemId,
            logo: institutionLogo,
          });
      }

      for (const acct of plaidAccounts) {
        const accountType = mapPlaidAccountType(acct.type, acct.subtype ?? null);
        const accountFields = {
          name: acct.name,
          officialName: acct.official_name ?? null,
          type: accountType,
          subtype: acct.subtype ?? null,
          // Plaid reports credit/loan balances positive when owed; Ledgr
          // stores owed as negative. See db/schema/accounts.ts.
          currentBalance: plaidBalanceToCents(acct.balances.current ?? null, accountType),
          availableBalance: plaidAmountToCents(acct.balances.available ?? null),
          creditLimit: plaidAmountToCents(acct.balances.limit ?? null),
          currency: acct.balances.iso_currency_code ?? "USD",
        };

        const [existingDeleted] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.externalAccountId, acct.account_id),
              eq(accounts.householdId, householdId),
              isNotNull(accounts.deletedAt),
            ),
          )
          .orderBy(desc(accounts.deletedAt))
          .limit(1);

        let accountId: string;

        if (existingDeleted) {
          accountId = existingDeleted.id;
          await tx.update(accounts)
            .set({ ...accountFields, deletedAt: null, bankConnectionId: plaidItemId, updatedAt: new Date() })
            .where(eq(accounts.id, existingDeleted.id));
        } else {
          accountId = uuid();
          await tx.insert(accounts)
            .values({
              id: accountId,
              householdId,
              bankConnectionId: plaidItemId,
              externalAccountId: acct.account_id,
              ...accountFields,
            });
        }

        if (accountFields.currentBalance !== null) {
          await tx.insert(balanceHistory)
            .values({
              id: uuid(),
              accountId,
              date: today,
              balance: accountFields.currentBalance,
            })
            .onConflictDoUpdate({
              target: [balanceHistory.accountId, balanceHistory.date],
              set: { balance: accountFields.currentBalance },
            });
        }
      }
    });

    reservedConnectionId = null;
    return { success: true, accountCount: plaidAccounts.length, plaidItemId };
  } catch (e: unknown) {
    logPlaidError("onboarding failed", failedEndpoint, e);
    const errorCode = extractPlaidErrorCode(e);
    if (reservedConnectionId && exchangedAccessToken) {
      const cleanedUp = await removeReservedPlaidItem(
        reservedConnectionId,
        householdId,
        db,
      );
      if (cleanedUp) {
        if (
          errorCode === "INSTITUTION_DOWN" ||
          errorCode === "INSTITUTION_NOT_RESPONDING"
        ) {
          return {
            success: false,
            error: "This bank is temporarily unavailable. The incomplete connection was removed; please try again later.",
          };
        }
        return {
          success: false,
          error: "Plaid connected, but Ledgr could not save the connection. The incomplete connection was removed; please try again.",
        };
      }
      return {
        success: false,
        error: "Plaid connected, but Ledgr could not finish setup or remove the incomplete connection. Open Accounts to retry cleanup.",
      };
    }

    await db
      .update(plaidOnboardingAttempts)
      .set({
        status: "exchange_failed",
        errorCode: exchangedAccessToken
          ? "ACCESS_TOKEN_NOT_RESERVED"
          : errorCode ?? "TOKEN_EXCHANGE_FAILED",
        updatedAt: new Date(),
      })
      .where(
        scoped.where(
          plaidOnboardingAttempts,
          eq(plaidOnboardingAttempts.id, onboardingAttemptId),
        ),
      )
      .catch(() => {
        console.error("[plaid] could not update failed onboarding attempt");
      });

    if (exchangedAccessToken) {
      return {
        success: false,
        error: "Plaid connected, but Ledgr could not safely save or remove the connection. Open Accounts for recovery guidance.",
      };
    }
    if (
      errorCode === "INSTITUTION_DOWN" ||
      errorCode === "INSTITUTION_NOT_RESPONDING"
    ) {
      return {
        success: false,
        error: "This bank is temporarily unavailable. Please try again later.",
      };
    }
    return { success: false, error: "Failed to connect account" };
  }
}

const STALE_SETUP_RESERVATION_MS = 15 * 60 * 1000;

async function removeReservedPlaidItem(
  connectionId: string,
  householdId: string,
  db: LedgrDb,
  requireStaleSetup = false,
): Promise<boolean> {
  const scoped = scopedQuery(householdId, db);
  const staleBefore = new Date(Date.now() - STALE_SETUP_RESERVATION_MS);
  const claim = await db.transaction(async (tx) => {
    const [connection] = await tx
      .select({
        credential: bankConnections.credential,
        status: bankConnections.status,
        errorCode: bankConnections.errorCode,
        updatedAt: bankConnections.updatedAt,
      })
      .from(bankConnections)
      .where(scoped.where(bankConnections, eq(bankConnections.id, connectionId)))
      .limit(1)
      .for("update");

    if (!connection || connection.status !== "error") return null;

    const failedReservation =
      connection.errorCode === "CONNECTION_SETUP_FAILED" ||
      connection.errorCode === "CONNECTION_REMOTE_REMOVED_LOCAL_CLEANUP_FAILED";
    const setupReservation =
      connection.errorCode === "CONNECTION_SETUP_IN_PROGRESS" &&
      (!requireStaleSetup || connection.updatedAt < staleBefore);
    const abandonedCleanup =
      requireStaleSetup &&
      connection.errorCode === "CONNECTION_CLEANUP_IN_PROGRESS" &&
      connection.updatedAt < staleBefore;
    if (!failedReservation && !setupReservation && !abandonedCleanup) return null;

    const [importedAccount] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        scoped.where(accounts, eq(accounts.bankConnectionId, connectionId)),
      )
      .limit(1);
    if (importedAccount) return null;

    const [claimed] = await tx
      .update(bankConnections)
      .set({
        errorCode: "CONNECTION_CLEANUP_IN_PROGRESS",
        updatedAt: new Date(),
      })
      .where(
        scoped.where(
          bankConnections,
          eq(bankConnections.id, connectionId),
          eq(bankConnections.status, "error"),
          eq(bankConnections.errorCode, connection.errorCode!),
        ),
      )
      .returning({ credential: bankConnections.credential });

    return claimed ?? null;
  });

  if (!claim) return false;

  try {
    // The unique reservation remains in place during this call, so another
    // request cannot persist or activate the same Plaid Item concurrently.
    await getPlaidClient().itemRemove({
      access_token: decrypt(claim.credential),
    });
  } catch (error) {
    const errorCode = extractPlaidErrorCode(error);
    logPlaidError("incomplete Item removal failed", "item/remove", error);
    if (errorCode !== "ITEM_NOT_FOUND") {
      await db
        .update(bankConnections)
        .set({ errorCode: "CONNECTION_SETUP_FAILED", updatedAt: new Date() })
        .where(
          scoped.where(
            bankConnections,
            eq(bankConnections.id, connectionId),
            eq(bankConnections.status, "error"),
            eq(bankConnections.errorCode, "CONNECTION_CLEANUP_IN_PROGRESS"),
          ),
        )
        .catch(() => {
          console.error("[plaid] could not restore failed cleanup state");
        });
      return false;
    }
  }

  try {
    await db
      .delete(bankConnections)
      .where(
        scoped.where(
          bankConnections,
          eq(bankConnections.id, connectionId),
          eq(bankConnections.status, "error"),
          eq(bankConnections.errorCode, "CONNECTION_CLEANUP_IN_PROGRESS"),
        ),
      );
    return true;
  } catch {
    await db
      .update(bankConnections)
      .set({
        errorCode: "CONNECTION_REMOTE_REMOVED_LOCAL_CLEANUP_FAILED",
        updatedAt: new Date(),
      })
      .where(
        scoped.where(
          bankConnections,
          eq(bankConnections.id, connectionId),
          eq(bankConnections.status, "error"),
          eq(bankConnections.errorCode, "CONNECTION_CLEANUP_IN_PROGRESS"),
        ),
      )
      .catch(() => {});
    console.error("[plaid] remote Item removed but local reservation cleanup failed");
    return false;
  }
}

export async function recoverIncompletePlaidConnection(
  connectionId: string,
  confirmed: boolean,
  db: LedgrDb = defaultDb,
) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  if (!confirmed) {
    return { error: "Confirm removal before retrying cleanup" };
  }

  const removed = await removeReservedPlaidItem(
    connectionId,
    auth.householdId,
    db,
    true,
  );
  revalidatePath("/accounts");

  return removed
    ? { success: true }
    : {
        error: "This connection is active, has imported accounts, is still being set up, was not found, or Plaid cleanup failed. The encrypted credential was retained when cleanup failed.",
      };
}

export async function exchangePublicToken(publicToken: string) {
  const householdId = await getHouseholdId();
  const result = await exchangeAndStoreAccounts(publicToken, householdId);
  if (result.success && result.plaidItemId) {
    const itemId = result.plaidItemId;
    try {
      await syncInstitution(itemId, householdId, defaultDb);
      syncInvestments(itemId, householdId, defaultDb).catch(() => {});
    } catch (err) {
      logPlaidError("post-link sync failed", "local/post_link_sync", err);
    }
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/transactions");
    revalidatePath("/investments");
  }
  return result;
}

export async function disconnectPlaidItem(
  plaidItemId: string,
  db: LedgrDb = defaultDb,
) {
  const auth = await authorizeAction();
  if ("error" in auth) return auth;
  const { householdId } = auth;

  const scoped = scopedQuery(householdId, db);

  const [item] = await db
    .select({
      id: bankConnections.id,
      credential: bankConnections.credential,
    })
    .from(bankConnections)
    .where(scoped.where(bankConnections, eq(bankConnections.id, plaidItemId)))
    .limit(1);

  if (!item) {
    return { error: "Item not found" };
  }

  try {
    await getPlaidClient().itemRemove({
      access_token: decrypt(item.credential),
    });
  } catch {
    // Best-effort — continue with local cleanup even if Plaid call fails
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(accounts)
      .set({ deletedAt: now, bankConnectionId: null })
      .where(eq(accounts.bankConnectionId, plaidItemId));

    await tx.delete(bankConnections)
      .where(eq(bankConnections.id, plaidItemId));
  });

  revalidatePath("/accounts");
  revalidatePath("/investments");
  return { success: true };
}
