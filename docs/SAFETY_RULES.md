# Atlas Safety Rules

This is the source of truth for Atlas safety rules.

## Real Writes

- No real Google Sheets writes without explicit owner approval.
- Do not run real workout ingestion without explicit owner approval.
- Do not run non-test-mode write endpoints during routine validation.
- A green dry-run does not authorize a real write.

## `test_mode` Contract

Dry-runs must use:

```text
test_mode=true
```

Dry-runs may validate, enrich, and preview rows. They must not append or update Google Sheets.

## No-Write Proof

`would_write:true` is not proof of no-write safety.

Valid no-write proof requires:

```json
{
  "test_mode": true,
  "sheet_written": false,
  "no_write_confirmed": true
}
```

Legacy compatibility may accept:

```json
{
  "test_mode": true,
  "sheet_write": "skipped"
}
```

A dry-run session must not appear in recent history.

## Secret Handling

- Never expose secrets or API keys.
- Never print `ATLAS_API_KEY`.
- Never commit `.env`.
- Never commit Google credentials.
- Never commit service account JSON files.
- Never commit private key files.
- Never commit screenshots, spreadsheets, or private workout data.
- Redact secrets in logs, docs, PR bodies, tests, and summaries.
- Follow [SECRET_HYGIENE_PLAN.md](SECRET_HYGIENE_PLAN.md) before rotating, removing, or rewriting any committed secret history.

## Render Environment Variables

- Do not change Render environment variables without explicit owner approval.
- Do not change `GOOGLE_SHEETS_ID` without explicit owner approval.
- If rollback is needed, restore the previous sheet ID privately in Render.
- Do not paste private sheet IDs into public docs unless they are already intentionally public.

## Dashboard Rule

Dashboard is optional only.

- Do not restore Dashboard as required.
- Do not fail health checks because Dashboard is absent.
- Do not add Dashboard to required tab lists.
- Do not write tests that require Dashboard.

## PR And Merge Rules

- Prefer small safe PRs.
- Create PRs only unless the owner explicitly asks for merge.
- Do not merge without owner approval.
- Branch from latest `main`.
- Do not stage unrelated changes.
- Include tests run and safety notes in every PR.

## First Real Write Policy

The first real write requires explicit owner approval in that session.

Before a first real write:

1. `read-only` Mission Control must be green.
2. `full` Mission Control must be green.
3. Dry-run must prove no-write safety.
4. The owner must approve a tiny real write.

The first real write should use a unique session ID, clear test notes, and a verification plan.
