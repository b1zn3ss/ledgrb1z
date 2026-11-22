/**
 * Idempotent operator job for Phase 3 merchant identity snapshots.
 * Usage: pnpm backfill-merchant-identities
 * Safe to resume after failure; only linked transactions without a pointer are selected.
 */
import { backfillMerchantIdentitySnapshots } from "@/lib/jobs/backfill-merchant-identities";

async function main() {
  const result = await backfillMerchantIdentitySnapshots({
    onProgress: (progress) => {
      console.log(
        `[merchant-identity-backfill] household=${progress.householdId} processed=${progress.processed} last=${progress.lastTransactionId ?? "-"} complete=${progress.complete}`,
      );
    },
  });
  console.log(
    `[merchant-identity-backfill] finished processed=${result.processed} remaining=${result.remaining}`,
  );
  if (result.remaining !== 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[merchant-identity-backfill] failed; rerun to resume safely", error);
  process.exit(1);
});
