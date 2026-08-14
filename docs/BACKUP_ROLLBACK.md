# Atlas Backup and Rollback Plan

This runbook covers backing up the production Google Sheet and recovering from bad writes or a bad deploy. It completes the "Backup / rollback plan" milestone on the product status board.

## What needs protecting

| Asset | Where it lives | Loss impact |
| --- | --- | --- |
| Workout history (`Log_Cleaned`, `Effort`) | Production Google Sheet | High — irreplaceable training data |
| Exercise catalog (`Exercise_Catalog`) | Production Google Sheet | Medium — rebuildable but tedious |
| Formula tabs (`Metadata`, `Logic`, `Session_Summary`) | Production Google Sheet | Medium — user-maintained formulas |
| Backend code | GitHub `main` | Low — git history covers it |
| Secrets | Render env vars | Medium — see [SECRET_ROTATION_RUNBOOK.md](SECRET_ROTATION_RUNBOOK.md) |

## Backup methods

### 1. Scripted export (preferred, read-only)

```bash
node scripts/export-sheets-backup.js              # all tabs
node scripts/export-sheets-backup.js Log_Cleaned Effort   # specific tabs
```

- Exports every tab to timestamped JSON + CSV under `backups/<timestamp>/` with a `manifest.json` row-count summary.
- Uses the **read-only** Sheets scope (`spreadsheets.readonly`) — the script cannot write even by accident.
- `backups/` is gitignored. Never commit backups; they contain private workout data.
- npm shortcut: `npm run backup:sheets`.

### 2. Google Sheets native copy

In Google Sheets: **File → Make a copy**, name it `Atlas Backup YYYY-MM-DD`. This preserves formulas in `Logic`/`Session_Summary`/`Metadata`, which the scripted export captures only as computed values.

### 3. Google Drive version history

**File → Version history → See version history** lets you restore the whole spreadsheet to any prior point. This is the fastest full-sheet rollback and requires no preparation.

## Backup cadence

- Before any first-of-its-kind real write: run a scripted export **and** make a native copy.
- Before a sheet cutover or schema change: native copy (formulas matter).
- Routine: scripted export weekly, or before any batch ingestion.

## Rollback scenarios

### A. Bad rows written to `Log_Cleaned` or `Effort`

1. Do not write anything else.
2. Identify the bad rows: `POST /api/admin/preview-test-rows` finds test-flagged rows; otherwise filter by `session_id` in the sheet.
3. Delete the bad rows manually in Google Sheets (the backend has no delete endpoint by design).
4. Verify with `GET /api/session/:sessionId` that the session no longer appears.
5. Run Mission Control `read-only` mode to confirm contract health.

### B. Whole sheet corrupted

1. **Drive version history** restore to the last good version, or
2. Restore tabs from the most recent `backups/<timestamp>/` export (paste CSV into the tab), or
3. Promote the most recent native copy: this changes `GOOGLE_SHEETS_ID`, which requires explicit owner approval and the full cutover checklist.

### C. Bad deploy

1. Render: roll back to the previous deploy in the Render dashboard, or
2. GitHub: revert the offending merge on `main` (`git revert -m 1 <merge-sha>`). **Do not
   rely on Render auto-deploy during an authority-changing window** — auto-deploy must stay
   off until the owner explicitly re-enables it after a successful authorized cutover
   (`docs/SUPABASE_HOT_PATH_MIGRATION.md` §5.5). If auto-deploy is off, a revert on `main`
   does not move production until Dale deploys or rolls back through Render.
3. Run Mission Control `read-only` then `full` (dry-run) to confirm recovery.

### D. Leaked secret

Follow [SECRET_ROTATION_RUNBOOK.md](SECRET_ROTATION_RUNBOOK.md).

## Verification after any rollback

1. `GET /health` returns ok.
2. `GET /api/health/sheets` shows all required tabs and no missing required tabs.
3. Mission Control `read-only` passes.
4. Mission Control `full` (test_mode dry-run) proves no-write safety.
5. Spot-check one known historical session via `GET /api/session/:sessionId/summary`.

## Rules

- Backups must never be committed to git.
- The export script must stay read-only scope.
- A restore that changes `GOOGLE_SHEETS_ID` is a cutover and needs explicit owner approval.
- Never delete the old sheet after a cutover until the new one is verified for at least one full workout cycle.
