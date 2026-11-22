import { describe, expect, it } from "vitest";
import type { PlaidTransaction } from "./schemas";
import { plaidMerchantIdentityCandidates } from "./merchant-identity";

function transaction(
  overrides: Partial<PlaidTransaction>,
): PlaidTransaction {
  return {
    transaction_id: "txn-1",
    account_id: "account-1",
    amount: 12.34,
    iso_currency_code: "USD",
    date: "2026-11-01",
    name: "Raw description",
    merchant_name: "Display merchant",
    logo_url: null,
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: null,
    ...overrides,
  };
}

describe("Plaid merchant identity candidates", () => {
  it("prefers merchant_entity_id over every counterparty", () => {
    const candidates = plaidMerchantIdentityCandidates(transaction({
      merchant_entity_id: "merchant-entity",
      counterparties: [{
        name: "Processor",
        entity_id: "counterparty-entity",
        type: "merchant",
        confidence_level: "VERY_HIGH",
      }],
    }));

    expect(candidates).toEqual([expect.objectContaining({
      identifierType: "plaid_merchant_entity_id",
      value: "merchant-entity",
      source: "provider_merchant",
    })]);
  });

  it("accepts only high-confidence merchant counterparties", () => {
    const candidates = plaidMerchantIdentityCandidates(transaction({
      counterparties: [
        {
          name: "Qualified merchant",
          entity_id: "qualified",
          type: "merchant",
          confidence_level: "HIGH",
        },
        {
          name: "Weak merchant",
          entity_id: "weak",
          type: "merchant",
          confidence_level: "MEDIUM",
        },
        {
          name: "Payment app",
          entity_id: "processor",
          type: "payment_app",
          confidence_level: "VERY_HIGH",
        },
        {
          name: "No entity",
          entity_id: null,
          type: "merchant",
          confidence_level: "VERY_HIGH",
        },
      ],
    }));

    expect(candidates).toEqual([expect.objectContaining({
      value: "qualified",
      source: "provider_counterparty",
    })]);
  });

  it("returns every qualified counterparty so ambiguity is explicit", () => {
    const candidates = plaidMerchantIdentityCandidates(transaction({
      counterparties: [
        {
          name: "Marketplace",
          entity_id: "marketplace",
          type: "merchant",
          confidence_level: "VERY_HIGH",
        },
        {
          name: "Seller",
          entity_id: "seller",
          type: "merchant",
          confidence_level: "HIGH",
        },
      ],
    }));

    expect(candidates.map((candidate) => candidate.value)).toEqual(["marketplace", "seller"]);
  });
});
