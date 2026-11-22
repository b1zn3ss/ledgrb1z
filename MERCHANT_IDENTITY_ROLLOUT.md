# Merchant Identity Rollout and Recovery

Phase 3 is additive, but it changes write-time integrity enforcement. Treat the
schema migration, legacy snapshot backfill, and resolver activation as separate
operator-controlled steps.

## Preconditions

- Production currently lacks both Phase 2 and Phase 3. The migration runner
  must apply `0015_glamorous_santa_claus` before
  `0016_massive_guardian`; never apply 0016 by itself. A normal container
  startup applies them in journal order, but both must be treated as one
  maintenance event.
- Rehearse backup restoration into an isolated database and run the integrity
  checks below against that restored copy before scheduling production.
- Take a fresh, verified PostgreSQL backup immediately before applying 0015.
- Record row counts for households, merchants, transactions, transaction
  splits, classification decisions, and transactions with non-null merchant
  links.
- Verify there are no existing cross-household transaction/merchant links.
  The new ownership trigger intentionally rejects them.
- Leave `MERCHANT_IDENTITY_RESOLUTION_ENABLED` unset or set to `false`.
- Measure free database space and WAL capacity. Migration 0015 creates an audit
  row for every observable transaction/split classification and updates current
  pointers; size and time it on a representative restored copy.

## Schema deployment

Use a maintenance window and pause Plaid, SimpleFIN, recurring, file-import,
scheduler, backfill, and any other application or operator database writers
while both migrations run. Terminate or wait for long-lived transactions before
starting. Do not start the new application until both migrations have committed.

Migration 0015 performs the production classification snapshot backfill inside
its migration transaction. Its runtime and storage growth are proportional to
classified transactions and splits. Verify its decision/pointer integrity
before allowing 0016 or the application to proceed.

The migration creates three initially empty tables and their indexes, adds
`merchants.identity_status` with the legacy default, adds a nullable merchant
default approval timestamp, and adds the nullable
`transactions.merchant_identity_decision_id` pointer. It does not scan or
backfill transaction history.

PostgreSQL takes ACCESS EXCLUSIVE locks for the two `ALTER TABLE ... ADD
COLUMN` operations and while adding the merchant status check. The constant
default is metadata-only on supported PostgreSQL versions, but validating the
status check still scans the merchants table. Foreign keys and triggers take
shorter table locks. Indexes are created only on new empty tables, so
`CREATE INDEX CONCURRENTLY` is unnecessary. Lock time is expected to be
dominated by waiting for pre-existing transactions, not data rewriting.

After migration, verify:

1. Every existing merchant has `identity_status = 'legacy_unverified'` and
   legacy category defaults have null approval timestamps.
2. Existing merchant/category links, classification pointers, split rows,
   transfer flags, account balances, and reporting flags are unchanged.
3. The three identity tables are empty and every identity pointer is null.
4. The migration journal contains `0016_massive_guardian` exactly once.

Resume the application with identity resolution still disabled.

## Legacy snapshot backfill

Run:

```bash
pnpm backfill-merchant-identities
```

The job is household-scoped, ordered, batched, and retry-safe. It only snapshots
transactions that already have a merchant link and lack an identity pointer.
Historical `decided_at` remains null. Progress logs include household,
processed count, and the last transaction ID. A failed run can be rerun without
deleting decisions or resetting pointers.

Before activation, verify:

- The job reports `remaining=0`.
- Every non-null legacy merchant link has a current identity pointer.
- Each current pointer references a decision for the same transaction and
  household and has the same nullable merchant ID.
- Backfilled decisions use `legacy_unknown / legacy_snapshot`, with null
  `decided_at`; they do not mark merchants provider-verified.
- Classification decision counts and fingerprints are unchanged.

## Resolver activation

Set `MERCHANT_IDENTITY_RESOLUTION_ENABLED=true` only after the schema and
backfill checks pass. Restart one worker/application instance first, then the
remaining instances.

Monitor:

- unresolved and ambiguous decision rates;
- legacy provider conflicts;
- provider identifier uniqueness violations;
- sync transaction rollbacks;
- unexpected changes in merchant creation volume;
- classification, transfer, spending, cash-flow, and balance regression
  metrics.

Alias approval remains an explicit user action. Approval does not retroactively
relink historical transactions or approve the merchant's category default.
Legacy defaults require an explicit default-category save before Phase 3 will
use them on new transactions.

## Rollback and recovery

If activation causes problems, first disable
`MERCHANT_IDENTITY_RESOLUTION_ENABLED` and restart workers. This stops new
automatic identity decisions while preserving manual decisions and the
append-only audit history.

Do not roll application writers back to a pre-Phase-3 binary after identity
pointers have been populated. Older code ignores the pointer and provenance
tables, and a legacy merchant-link update can then be rejected by the pointer
integrity trigger or omit required identity provenance. The supported
operational rollback is to disable the feature flag while continuing to run a
Phase-3-capable build. A pre-Phase-3 binary is safe only before any identity
pointers exist, or while all database writers remain paused/read-only. Never
run mixed old/new writers.

The disabled path preserves transactions that already have identity pointers;
legacy name-based merchant assignment remains available only for rows that have
never entered the Phase 3 identity system.

Do not drop identity tables, clear current pointers, or delete append-only
decisions as a routine rollback. If schema deployment fails, keep workers
paused, inspect the migration journal and PostgreSQL transaction state, and
retry only after confirming whether the migration committed. Drizzle runs the
migration transactionally; a normal failure should leave no partial migration.
If a manually altered or non-transactional environment is partially applied,
restore the verified pre-migration backup into a separate database and compare
state before choosing recovery.

A full database restore is the last-resort recovery for confirmed data
corruption. It discards all writes after the backup and therefore requires an
explicit operator decision and a new maintenance window.
