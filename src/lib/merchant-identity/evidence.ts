import { z } from "zod";

const base = z.object({ version: z.literal(1) });
const merchant = z.object({ id: z.string().min(1), name: z.string().min(1) });

export const MerchantIdentityEvidenceSchema = z.discriminatedUnion("kind", [
  base.extend({
    kind: z.literal("manual"),
    trigger: z.enum(["single", "clear"]),
    merchant: merchant.nullable(),
  }),
  base.extend({
    kind: z.literal("provider"),
    provider: z.string().min(1),
    identifierType: z.string().min(1),
    identifierHash: z.string().length(64),
    role: z.string().nullable(),
    confidence: z.string().nullable(),
    merchant: merchant.nullable(),
  }),
  base.extend({
    kind: z.literal("alias"),
    provider: z.string().nullable(),
    aliasId: z.string().min(1),
    aliasHash: z.string().length(64),
    normalizationVersion: z.number().int().positive(),
    merchant,
  }),
  base.extend({
    kind: z.literal("canonical_name"),
    nameHash: z.string().length(64),
    merchant,
  }),
  base.extend({
    kind: z.literal("unresolved"),
    provider: z.string().nullable(),
    reason: z.enum([
      "no_match", "ambiguous_identifier", "ambiguous_alias",
      "unsafe_provider_identity", "legacy_link_conflict",
    ]),
    observationHash: z.string().length(64).nullable(),
    candidateCount: z.number().int().nonnegative(),
  }),
  base.extend({
    kind: z.literal("inheritance"),
    pendingTransactionId: z.string().min(1),
    sourceDecisionId: z.string().nullable(),
    sourceFingerprint: z.string().nullable(),
    merchant: merchant.nullable(),
  }),
  base.extend({
    kind: z.literal("legacy"),
    reason: z.enum(["observed_before_phase3", "legacy_provider_conflict"]),
    merchant: merchant,
    providerIdentifierHash: z.string().length(64).nullable(),
  }),
]);

export type MerchantIdentityEvidence = z.infer<typeof MerchantIdentityEvidenceSchema>;

export function parseMerchantIdentityEvidence(value: unknown): MerchantIdentityEvidence {
  return MerchantIdentityEvidenceSchema.parse(value);
}
