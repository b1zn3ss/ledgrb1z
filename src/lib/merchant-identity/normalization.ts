import { createHash } from "node:crypto";

export const MERCHANT_ALIAS_NORMALIZATION_VERSION = 1;

export function normalizeMerchantAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

/**
 * Plaid entity IDs are high-entropy opaque values, so a domain-separated SHA-256
 * digest prevents needless duplication without requiring a rotatable secret.
 * Predictable aliases are never represented as though this digest encrypted them.
 */
export function merchantIdentifierHash(
  provider: string,
  identifierType: string,
  value: string,
): string {
  return createHash("sha256")
    .update(`merchant-id-v1\0${provider}\0${identifierType}\0${value}`)
    .digest("hex");
}

export function merchantEvidenceHash(value: string): string {
  return createHash("sha256")
    .update(`merchant-evidence-v1\0${normalizeMerchantAlias(value)}`)
    .digest("hex");
}
