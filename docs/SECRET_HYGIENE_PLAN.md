# Atlas Secret Hygiene Plan

This plan exists so Atlas can clean up secrets safely without exposing values in pull requests, logs, screenshots, or chat.

Related docs:

- [SECRET_ROTATION_RUNBOOK.md](SECRET_ROTATION_RUNBOOK.md)
- [SECRET_HYGIENE_CHECKLIST.md](SECRET_HYGIENE_CHECKLIST.md)

## Current Phase

- Phase 1: documented plan - complete after PR #29.
- Phase 2: stop tracking `.env` - complete after PR #30.
- Phase 3: manual rotation - owner action, not Codex.
- Phase 4: optional history cleanup - explicit owner approval only.

## Current Finding

- `.env` is ignored by `.gitignore`.
- `.env` is also tracked in Git history.
- The tracked file contents were not inspected for this plan.
- Do not expose `.env` contents in a normal PR, log, screenshot, chat, or documentation.

## Why This Matters

If a secret or credential was committed at any point, removing it in a later commit does not make the old value safe. Treat any committed secret as exposed until it has been rotated or revoked at the source.

## Hard Rules

- Do not print secret values.
- Do not paste secret values into docs, PRs, issues, logs, or chat.
- Do not commit `.env`, Google credentials, API keys, screenshots, spreadsheets, or private workout data.
- Do not change Render environment variables without explicit owner approval.
- Do not change `GOOGLE_SHEETS_ID` without explicit owner approval.
- Do not perform real Google Sheets writes while doing secret cleanup.

## Safe Cleanup Sequence

1. Inventory secret names privately.
   - Identify which services may have had values in `.env`.
   - Record only variable names and owning service, not values.

2. Rotate or revoke exposed secrets at the source.
   - Render production secrets.
   - GitHub Actions secrets.
   - Google service account keys.
   - OpenAI or other API keys.
   - Any local-only test credentials.

3. Confirm production still works after rotation.
   - Run Mission Control `read-only`.
   - Run Mission Control `full` only when a `test_mode=true` dry-run is appropriate.
   - Confirm no-write proof: `test_mode:true`, `sheet_written:false`, `no_write_confirmed:true`.

4. Remove `.env` from Git tracking in a dedicated cleanup PR.
   - Do not include replacement secret values.
   - Keep `.env.example` limited to placeholder names.
   - Preserve the local `.env` file where possible.

5. Purge old secret history only with an owner-approved history rewrite plan.
   - Coordinate because force-pushing rewritten history affects every clone and open branch.
   - Prefer `git filter-repo` or BFG Repo-Cleaner.
   - Rotate secrets before the rewrite; history cleanup is not a substitute for rotation.

6. Verify after cleanup.
   - Check `git status` and `git ls-files -- .env`.
   - Run a repository secret scan if available.
   - Run tests and Mission Control.
   - Confirm `.env` remains ignored.

## Owner Approval Gates

The owner must explicitly approve before:

- Rotating production credentials.
- Changing Render environment variables.
- Changing GitHub Actions secrets.
- Removing tracked `.env`.
- Rewriting Git history.
- Force-pushing any branch.
- Running any real write against Google Sheets.

## Recommended PR Sequence

1. Secret hygiene plan PR.
   - Docs only.
   - No secret values.
   - No `.env` diff.

2. `.env` tracking cleanup PR.
   - Remove `.env` from Git tracking.
   - Add or update `.env.example` with placeholders only.
   - Preserve the local `.env` file.

3. Secret rotation runbook and checklist PR.
   - Document owner-only rotation steps.
   - Document Mission Control verification.
   - Do not rotate secrets from Codex.

4. Optional history cleanup issue.
   - Prepare the exact history rewrite steps.
   - Run only after owner approval.

## Phase 2 - Stop Tracking Local Secret Files

PR #30 removes `.env` from Git tracking going forward and adds ignore rules for local secret files.

This does not remove secrets from Git history. This does not rotate or revoke any exposed secret. Treat any value that was ever committed as exposed until it has been rotated at the source.

The owner must rotate secrets manually in:

- Render.
- GitHub Actions secrets.
- OpenAI.
- Google Cloud service account.

After rotation:

1. Run Mission Control `read-only` against the cleaned production sheet.
2. Run Mission Control `full` only when a `test_mode=true` dry-run is appropriate.
3. Confirm no-write proof: `test_mode:true`, `sheet_written:false`, and `no_write_confirmed:true`.
4. Confirm the dry-run session does not appear in recent history.

Only consider Git history cleanup after successful rotation and explicit owner approval. Do not rewrite history as part of routine cleanup.

## What Good Looks Like

- Production still passes Mission Control.
- `.env` is not tracked by Git.
- `.env.example` contains placeholders only.
- No secrets appear in docs, tests, logs, PRs, or screenshots.
- Any previously committed secrets have been rotated or revoked.
- Dashboard remains optional and absent from required tab checks.
