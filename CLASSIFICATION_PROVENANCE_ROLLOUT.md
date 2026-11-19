# Classification provenance rollout and recovery

This document applies to migration `0015_glamorous_santa_claus.sql`. The
migration is additive to accounting state: it does not rewrite transaction
categories, splits, transfer flags, category reporting flags, merchant
defaults, balances, or amounts.

## Before deployment

1. Stop import/sync workers and take a verified PostgreSQL backup.
2. Record counts for transactions, categorized transactions, manual-null
   transactions, and transaction splits.
3. Estimate the provenance backfill at one row per observed parent
   classification plus one row per split. Test the migration on a restored
   production-sized copy and record its duration and database growth.
   The migration deliberately aborts, without partial schema changes, if any
   legacy transaction or split references a category owned by another household;
   investigate and correct that source-data violation before retrying.
4. Deploy the migration and application together during a maintenance window.
   Do not allow an older writer to run concurrently with the new application.

## Migration characteristics

Migration `0015` runs as one migration transaction. Adding nullable pointer
columns is metadata-only on supported PostgreSQL versions, but the foreign-key
and trigger `ALTER TABLE` statements require strong table locks. The legacy
decision insert scans classified transactions and splits, and the pointer
backfill updates every observed classified row, producing row locks, WAL, and
new transaction-table versions. The decision indexes are created
non-concurrently because the table is new and unavailable until commit.

On the local test PostgreSQL instance, a disposable synthetic benchmark with
100,000 categorized transactions took 10.4 seconds for migration `0015`, grew
the database by 119,234,560 bytes (about 113.7 MiB), and produced an
87,375,872-byte (about 83.3 MiB) decision relation. These figures are hardware-
and data-dependent, not a production forecast. Before deployment, benchmark a
restored production-sized copy and reserve headroom for the decision table,
indexes, rewritten transaction rows, WAL, and the pre-migration backup.

## Post-migration validation

- Existing `category_id`, `category_source`, split amounts, transfer fields,
  reporting flags, merchant defaults, and balances must match their preflight
  counts and checksums.
- Every observed parent classification must have a valid current pointer,
  except an unclassified split parent whose manual source is only the existing
  split safety marker.
- Every split must have a valid split-level current pointer.
- Legacy decisions must have `outcome = 'legacy_snapshot'` and
  `decided_at IS NULL`.
- An unchanged sync replay must not increase the decision count.

## Rollback and recovery

The preferred application rollback is to redeploy the previous application
while leaving the additive table and nullable pointer columns in place. The old
application ignores them, preserving audit rows for a forward fix. While that
older application is active, pause transaction category edits and automatic
categorization: its writers do not advance provenance pointers. If any such
writes occur, stop writers and create a forward recovery migration that records
new unknown-time observed snapshots before re-enabling the Phase 2 application.

Do not drop the decision table after the new application has accepted writes:
that would destroy append-only history. If the migration or backfill is found
to be incorrect, stop writers and either:

1. restore the verified pre-migration backup, or
2. deploy a forward migration that repairs pointers or adds corrected legacy
   snapshots without updating or deleting historical decision rows.

A schema-only reversal is acceptable only before any post-upgrade
classification write and only from a verified backup. It must remove pointer
foreign keys and triggers before dropping the nullable pointer columns and
decision table. Migration journal entries must never be edited in place on a
deployed database.

Hard deletion of a transaction or household intentionally cascades its audit
history as part of the same data-lifecycle operation. Direct decision updates
and deletes remain prohibited by database triggers.
