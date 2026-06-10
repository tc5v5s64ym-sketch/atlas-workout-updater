The app uses `INSERT_ROWS` semantics to append data at the bottom.
- Before promoting a cleaned sheet, back up production, validate the test copy with read-only checks, run a `test_mode=true` complete-workout dry run, then switch `GOOGLE_SHEETS_ID`.
- Never commit `.env`, API keys, Google credentials, screenshots, `.xlsx` exports, or private workout data.

## Running Atlas Smoke Tests from iPhone (Mission Control)

GitHub Actions is now your primary iPhone-safe control panel for validating the current production sheet and the cleaned candidate sheet before/after switching `GOOGLE_SHEETS_ID` in Render.

### How to run
1. Open GitHub (app or Safari).
2. Go to `tc5v5s64ym-sketch/atlas-workout-updater`.
3. Tap **Actions** → **CI**.
4. Tap **Run workflow**.
5. Select branch `main`.
6. Choose:
   - **smoke_mode**:
     - `read-only` or `contract` before any switch
     - `full` or `post-switch` after switching to cleaned sheet (includes safe test_mode dry-run)
   - **expected_sheet_label**: `current` before switch, `cleaned` after switch
   - Leave booleans at defaults unless you have a specific need.
7. Tap **Run workflow**.
8. Open the latest run and check both **Unit tests** and **Render smoke test (Mission Control)** jobs.
9. Tap the job → open **Summary** tab for the clean pass/fail table (readable on mobile).

### Recommended cutover sequence
**A. Before switching GOOGLE_SHEETS_ID**
- Run `smoke_mode=read-only` + `expected_sheet_label=current`
- Must be green.

**B. Switch in Render**
- Note/save the current GOOGLE_SHEETS_ID privately.
- Replace with cleaned sheet ID: `1XQaKGJL5uoE3yFw4Z0wiSfAlc-JnufS2Z7psODuDcA0`
- Redeploy the Render service.

**C. After switch**
- Run `smoke_mode=read-only` + `expected_sheet_label=cleaned`
- Must be green.
- Then run `smoke_mode=full` + `expected_sheet_label=cleaned` (safe dry-run + no-mutation check).

**D. Rollback (if anything fails after switch)**
1. In Render, restore the previous GOOGLE_SHEETS_ID.
2. Redeploy.
3. Run `smoke_mode=read-only` + `expected_sheet_label=current`.
4. Do not perform real writes until green again.

**Safety notes**
- Only `test_mode=true` dry-runs are performed — no real data is ever written by the smoke test.
- ATLAS_API_KEY is used securely via GitHub secret (never exposed).
- Dashboard tab is treated as optional.
- Clear rollback guidance is printed on failure when `expected_sheet_label=cleaned` or mode=`post-switch`.

This system lets you safely validate and cut over from your iPhone without curl or exposing secrets.