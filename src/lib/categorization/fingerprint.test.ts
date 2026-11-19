import { describe, expect, it } from "vitest";
import { canonicalJson, classificationDecisionFingerprint, type FingerprintInput } from "./fingerprint";

function input(previousDecisionId: string | null): FingerprintInput {
  return {
    transactionId: "txn-1",
    subjectType: "transaction",
    transactionSplitId: null,
    categoryId: "cat-a",
    source: "manual",
    ruleId: null,
    merchantId: null,
    decisionPriority: 400,
    outcome: "applied",
    evidence: {
      version: 1,
      kind: "manual",
      trigger: "single",
      category: { id: "cat-a", name: "A" },
    },
    engineVersion: "deterministic-v1",
    previousDecisionId,
  };
}

describe("classification decision fingerprints", () => {
  it("canonicalizes object keys recursively", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } }))
      .toBe(canonicalJson({ a: { b: 3, y: 2 }, z: 1 }));
  });

  it("is stable for the same event", () => {
    expect(classificationDecisionFingerprint(input("decision-1")))
      .toBe(classificationDecisionFingerprint(input("decision-1")));
  });

  it("includes the predecessor so A -> B -> A remains distinct", () => {
    expect(classificationDecisionFingerprint(input(null)))
      .not.toBe(classificationDecisionFingerprint(input("decision-b")));
  });
});
