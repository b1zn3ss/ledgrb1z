import { z } from "zod";
import { createHash } from "node:crypto";

const categorySnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const baseEvidenceSchema = z.object({
  version: z.literal(1),
  category: categorySnapshotSchema.nullable(),
});

export const classificationEvidenceSchema = z.discriminatedUnion("kind", [
  baseEvidenceSchema.extend({
    kind: z.literal("manual"),
    trigger: z.enum(["single", "bulk", "split_create", "split_update", "split_delete"]),
  }),
  baseEvidenceSchema.extend({
    kind: z.literal("rule"),
    rule: z.object({
      id: z.string(),
      matchField: z.enum(["name", "merchant"]),
      matchPattern: z.string(),
      matchedValueHash: z.string().regex(/^[a-f0-9]{64}$/),
      priority: z.number().int(),
      tieBreaker: z.string(),
    }),
  }),
  baseEvidenceSchema.extend({
    kind: z.literal("merchant_default"),
    merchant: z.object({ id: z.string(), name: z.string() }),
  }),
  baseEvidenceSchema.extend({
    kind: z.literal("pfc"),
    detailedCode: z.string(),
    mappedCategoryName: z.string(),
  }),
  baseEvidenceSchema.extend({
    kind: z.literal("inheritance"),
    pendingTransactionId: z.string(),
    sourceDecisionId: z.string().nullable(),
    sourceFingerprint: z.string().nullable(),
    inheritedCategorySource: z.string().nullable(),
    pendingHadSplits: z.boolean(),
    splitAllocationsMigrated: z.literal(false),
  }),
  baseEvidenceSchema.extend({
    kind: z.literal("legacy"),
    observedCategorySource: z.string().nullable(),
    historicalDecisionTimeKnown: z.literal(false),
  }),
]);

export type ClassificationEvidence = z.infer<typeof classificationEvidenceSchema>;

export function parseClassificationEvidence(value: unknown): ClassificationEvidence {
  return classificationEvidenceSchema.parse(value);
}

/** Hashes normalized match input so evidence proves the match without storing bank text. */
export function classificationMatchValueHash(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}
