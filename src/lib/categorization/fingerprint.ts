import { createHash } from "node:crypto";
import type { ClassificationEvidence } from "./evidence";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export interface FingerprintInput {
  transactionId: string;
  subjectType: "transaction" | "split";
  transactionSplitId: string | null;
  categoryId: string | null;
  source: string;
  ruleId: string | null;
  merchantId: string | null;
  decisionPriority: number;
  outcome: string;
  evidence: ClassificationEvidence;
  engineVersion: string;
  previousDecisionId: string | null;
}

export function classificationDecisionFingerprint(input: FingerprintInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
