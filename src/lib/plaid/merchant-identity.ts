import type { PlaidTransaction } from "./schemas";
import type { ProviderIdentifierCandidate } from "@/lib/merchant-identity/resolver";

export function plaidMerchantIdentityCandidates(
  transaction: PlaidTransaction,
): ProviderIdentifierCandidate[] {
  const merchantEntityId = transaction.merchant_entity_id?.trim();
  if (merchantEntityId) {
    return [{
      identifierType: "plaid_merchant_entity_id",
      value: merchantEntityId,
      source: "provider_merchant",
      role: "merchant",
      // PFC confidence describes category quality, not merchant identity.
      confidence: null,
    }];
  }

  return (transaction.counterparties ?? [])
    .filter((counterparty) =>
      counterparty.entity_id?.trim()
      && counterparty.type === "merchant"
      && ["HIGH", "VERY_HIGH"].includes(counterparty.confidence_level ?? ""))
    .map((counterparty) => ({
      identifierType: "plaid_counterparty_entity_id",
      value: counterparty.entity_id!.trim(),
      source: "provider_counterparty" as const,
      role: counterparty.type,
      confidence: counterparty.confidence_level ?? null,
    }));
}
