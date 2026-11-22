import { describe, expect, it } from "vitest";
import {
  merchantEvidenceHash,
  merchantIdentifierHash,
  normalizeMerchantAlias,
} from "./normalization";

describe("merchant identity normalization", () => {
  it("normalizes Unicode, case, and whitespace conservatively", () => {
    expect(normalizeMerchantAlias("  ＡＣＭＥ\t  Store #42  ")).toBe("acme store #42");
    expect(normalizeMerchantAlias("ACME-42")).not.toBe(normalizeMerchantAlias("ACME 42"));
    expect(normalizeMerchantAlias("Shop 12")).not.toBe(normalizeMerchantAlias("Shop 13"));
  });

  it("domain-separates stable identifier digests", () => {
    const plaidMerchant = merchantIdentifierHash("plaid", "merchant_entity_id", "entity-123");
    expect(plaidMerchant).toHaveLength(64);
    expect(plaidMerchant).toBe(
      merchantIdentifierHash("plaid", "merchant_entity_id", "entity-123"),
    );
    expect(plaidMerchant).not.toBe(
      merchantIdentifierHash("plaid", "counterparty_entity_id", "entity-123"),
    );
    expect(plaidMerchant).not.toBe(
      merchantIdentifierHash("simplefin", "merchant_entity_id", "entity-123"),
    );
    expect(plaidMerchant).not.toContain("entity-123");
  });

  it("hashes normalized observations without persisting their plaintext", () => {
    expect(merchantEvidenceHash(" ACME   STORE ")).toBe(merchantEvidenceHash("acme store"));
    expect(merchantEvidenceHash("acme store")).not.toContain("acme");
  });
});
