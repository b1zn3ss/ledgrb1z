# Plaid onboarding recovery

Plaid public-token exchange and Ledgr's database are separate systems, so they
cannot participate in one atomic transaction. Ledgr records an encrypted
onboarding attempt before exchange and reserves the returned access token and
Item ID in one database transaction immediately after exchange.

A process termination after Plaid returns but before that transaction commits
can still lose the access token. The attempt remains visible as
`exchange_started`, but neither Plaid nor Ledgr can reconstruct the access
token from the consumed public token. This is an unavoidable residual window,
not a state that an automatic retry can safely repair.

## Investigating incomplete attempts

1. In Ledgr's Accounts page, identify stale Plaid onboarding attempts and note
   their reference, status, and timestamp. Credentials are never shown.
2. In the Plaid Dashboard for the configured environment, compare Items created
   near the attempt timestamp. Use only non-secret identifiers and Plaid request
   IDs in tickets and application logs.
3. If a matching orphan exists, remove it in the Plaid Dashboard. Do not delete
   the local attempt first; it is the audit trail for the investigation.
4. After confirming the Item is absent, an operator may remove the stale attempt
   through a future dedicated maintenance workflow or directly during scheduled
   database maintenance. Never copy encrypted or plaintext tokens into tickets,
   chat, or logs.
5. Ask the household operator to start Link again.

Failed reservations that already have an encrypted access token are different:
the Accounts page offers a confirmation-gated cleanup action. It claims the
reservation, verifies that it is not active and has no imported accounts, calls
`/item/remove`, and deletes the local reservation only after Plaid succeeds or
returns `ITEM_NOT_FOUND`. Any other failure retains the encrypted credential
and actionable error state for another retry.

On Plaid Trial plans, removing an Item does not restore a consumed Trial Item
slot. Orphans should still be removed to end access and any applicable product
billing.
