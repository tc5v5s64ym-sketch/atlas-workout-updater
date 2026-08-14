# S4 backup and restore readiness — 2026-08-14

Evidence for §8.4 and the S4 rollback-window prerequisite in
`docs/SUPABASE_HOT_PATH_MIGRATION.md` §7.3. It records what is proven locally
and what still requires owner-privileged action. It authorizes nothing and
performs no production operation.

## Split: local proof vs production proof

| Requirement | Local / CI (this repository) | Owner / privileged (still outstanding) |
|---|---|---|
| From-empty schema reconstruction | **PROVEN** — `npm run test:pg` (`scripts/run-pg-proof.js`) | N/A |
| Migration ordering | **PROVEN** — `scripts/apply-supabase-migrations.js` on disposable Postgres | Applying S4 files to `Atlas Production` (gate 1(c)) |
| Restore verification logic | **PROVEN** — `npm run atlas:supabase-restore-proof` + `test/supabaseRestoreProof.test.js` | Running against a real production dump |
| Row/count checks after restore | **PROVEN** — seven `atlas.*` tables in restore proof script | Full production row inventory |
| Production backup file | **NOT CLAIMED** | Owner takes Supabase backup or `pg_dump` before S4 step 5 |
| Scratch restore of production dump | **NOT CLAIMED** | Owner restores dump to scratch DB and re-runs verification |

**A local from-empty test is not equivalent to a real production backup/restore.**
The local proof exercises migration order, export/import, and count verification
on disposable infrastructure only.

## What `npm run atlas:supabase-restore-proof` proves

On a disposable server (`ATLAS_PG_ADMIN_URL`, same constraint as `test:pg`):

1. Creates database A, applies every `supabase/migrations/` file from empty.
2. Seeds fixture rows in `atlas.write_receipts` and `atlas.coaching_notes`.
3. Exports the seven core `atlas.*` tables, creates database B, reapplies migrations
   from empty, imports, and asserts identical row counts.

Refuses hosted Supabase hosts (same rule as `apply-supabase-migrations.js`).

## Failure-path proof (code level)

`test/supabaseRestoreProof.test.js` proves:

- `verifyCountsMatch` fails closed on table mismatch (`RESTORE_COUNT_MISMATCH`).
- `assertBackupCoversReceipts` refuses a backup older than the newest receipt
  obligation (`BACKUP_TOO_OLD`) — the P19d fail-closed case at verification time.

## Exact smallest owner dependency (not requested yet)

When autonomous prep is complete and Dale reaches the S4 backup gate:

1. **Take one Atlas Production backup** through the Supabase Dashboard (Database →
   Backups) **or** `pg_dump` from an owner workstation using credentials that
   already exist for maintenance — not from Render runtime.
2. **Store the artifact privately** (never in git, PRs, or evidence files with
   workout data).
3. **Restore once to a scratch database** and run the same count/invariant checks
   the local proof uses (or re-run `atlas:supabase-restore-proof` logic against
   that scratch URL with the imported dump).

No paid project, no new provider resource, and no production dump are created by
this repository work.

## Authority accounting

| Item | Record |
|---|---|
| Classification | missing capability closure (verification tooling), not authority transfer |
| Current live authority | S3 / Google Sheets in production |
| Intended sole authority | Supabase after authorized §5.5 cutover |
| Competing authority removed | none |
| Bridge | none |
| Net complexity | small bounded script reusing existing migration applier |
