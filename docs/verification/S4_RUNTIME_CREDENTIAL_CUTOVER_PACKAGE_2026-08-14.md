# S4 runtime credential cutover package — 2026-08-14

Mechanical owner checklist for the future credential gate. It configures nothing,
stores no secrets, and authorizes no production change. Authority:
`docs/SUPABASE_HOT_PATH_MIGRATION.md` §8.1–§8.2 and
`services/supabaseAdapter.js`.

## Connection model (all four roles)

| Property | Value |
|---|---|
| Transport | Supavisor **session mode** (not transaction mode) |
| Port | **5432** |
| Host | `*.pooler.supabase.com` (IPv4-reachable from Render) |
| Username shape | `[role].[project-ref]` (e.g. `atlas_app.<ref>`) |
| TLS | Required (standard Postgres SSL) |
| Direct DB endpoint | Owner workstation / IPv6-proven environments only — **not** Render runtime |

Render is IPv4-only; the session pooler is the executable choice (§8.1).

## Role map

| Environment variable | Database role | Where it belongs | Never on Render? |
|---|---|---|---|
| `ATLAS_SUPABASE_APP_URL` | `atlas_app` | **Render runtime** (Express server) | — |
| `ATLAS_SUPABASE_READONLY_URL` | `atlas_readonly` | Owner workstation: `npm run atlas:status`, `npm run atlas:review-live` | Optional on Render; not required for workout path |
| `ATLAS_SUPABASE_MIGRATE_URL` | `atlas_migrate` | Owner workstation only: migrations, coaching-input `--apply`, receipt carry DDL, prune job | **Yes — never Render** |
| `ATLAS_SUPABASE_REBUILD_URL` | `atlas_rebuild` | Owner workstation only: §5.7 mirror rebuild window | **Yes — never Render** |

### `atlas_app` (runtime)

- **Grants:** `SELECT` all `atlas` tables; scoped `INSERT`/`UPDATE`/`DELETE` per §8.2; **no DDL**; `write_freeze` **SELECT only** (cannot lift freeze).
- **Consumer:** `services/supabaseAdapter.js` default role; all seven `beginWrite` routes after S4.
- **Arming write freeze:** not this role — owner updates `atlas.write_freeze` via Supabase SQL editor / project owner role (§5.3).

### `atlas_readonly` (tooling)

- **Grants:** `SELECT` only on every `atlas` table.
- **Consumer:** `scripts/atlas-status.js`, `scripts/atlas-review-live.js` when set; falls back to `atlas_app` if readonly unset.

### `atlas_migrate` (maintenance)

- **Grants:** DDL on `atlas` (except `write_freeze` ownership boundary); one declared DML surface on `write_receipts` for §5.5a carry.
- **Consumers:** `npm run supabase:migrate` (owner apply), `npm run atlas:coaching-inputs-transition -- --apply`, receipt prune, owner-run SQL files under `supabase/operations/`.

### `atlas_rebuild` (§5.7 only)

- **Grants:** `SELECT` all tables; `DELETE`/`INSERT` on `sheets_mirror_allocations`; scoped `UPDATE` on mirror cursor and export columns — **no** workout tables beyond `SELECT`.
- **Sunset of credential:** remove from workstation when rebuild completes.

## Render runtime — exact configuration boundary

**Set on Render (one variable) during handover step 6, after steps 1–5:**

1. `ATLAS_SUPABASE_APP_URL` — session-pooler URL for `atlas_app`.

**Do not set on Render:**

- `ATLAS_SUPABASE_MIGRATE_URL`
- `ATLAS_SUPABASE_REBUILD_URL`
- Supabase service-role key, anon key, or Data API credentials (design uses none)

**Do not set during quarantine or before authorized step 6.** Production today has
`ATLAS_SUPABASE_APP_URL` unset (`supabase_migration.configured: false`).

### Render env-save modes (mandatory)

Render offers **Save only**, **Save and deploy**, and **Save, rebuild, and deploy**.
When adding or updating `ATLAS_SUPABASE_APP_URL` during the S4 handover:

- **Use Save only.** The credential is saved without starting a deployment.
- **Never use Save and deploy** or **Save, rebuild, and deploy** for this credential setup.
  Either option triggers a hidden S3 redeploy/restart and breaks the one-deploy cutover
  boundary in §5.5.

After **Save only**, verify `GET /version` still reports the expected S3 SHA before the
manual cutover deploy.

## Owner workstation — temporary configuration

For the cutover window only, Dale may export (never commit):

```bash
export ATLAS_SUPABASE_APP_URL='…'        # only if testing runtime against staging
export ATLAS_SUPABASE_READONLY_URL='…'   # status / review-live
export ATLAS_SUPABASE_MIGRATE_URL='…'    # schema apply, coaching-input --apply, receipt carry
export ATLAS_SUPABASE_REBUILD_URL='…'    # only during §5.7 rebuild
export ATLAS_COACHING_INPUTS_EXPECTED_SHEETS_ID='…'  # production GOOGLE_SHEETS_ID for coaching-input --apply
```

Unset `MIGRATE`, `REBUILD`, and coaching-input expected id when the window closes.

## Preflight commands (before step 6 deploy)

Run from owner workstation with migrate/readonly URLs set locally (not on Render):

```bash
# Hosted four-role + session-lock checkpoint (already PASSED 2026-08-08; re-run if roles rotated)
npm run atlas:p8b -- --json

# Coaching-input dry run (after gate 1(c) schema applied; set expected sheets id for verified-absent)
npm run atlas:coaching-inputs-transition -- --json
```

Production backup/restore proof is **not** this package. Before write reopening, take a real
Atlas Production backup (`pg_dump` or Supabase dashboard export), perform one scratch restore,
and verify row counts and invariants — see §5.5 gate P19d and `docs/BACKUP_ROLLBACK.md`.

## Post-configuration health evidence (after step 6, before write reopen)

Read-only public checks (no write routes):

```bash
curl -sS https://atlas-workout-updater.onrender.com/version
curl -sS https://atlas-workout-updater.onrender.com/.well-known/atlas-status.json
```

Expected after successful runtime wiring (values only — no secrets in logs/PRs):

| Field | Expected |
|---|---|
| `deployed_commit` | S4 cutover SHA (not S3 `da16cd4b…`) |
| `supabase_migration.configured` | `true` |
| `supabase_migration.observed` | may remain `false` on public endpoint until observed fields populate |
| Write routes | still frozen until §5.5 step 8 — freeze row or operational hold |

Authenticated owner check when API key available:

```bash
# Read-only Sheets health; does not write
curl -sS -H "x-atlas-api-key: $ATLAS_API_KEY" \
  https://atlas-workout-updater.onrender.com/api/health/sheets
```

## Single smallest owner action at the credential gate

When steps 1–5 of §5.5 are complete and Dale authorizes step 6:

1. Add **`ATLAS_SUPABASE_APP_URL`** (`atlas_app`, session pooler, port 5432) to Render using
   **Save only** (not Save and deploy; not Save, rebuild, and deploy).
2. Verify **no deployment occurred** — `GET /version` still shows the S3 SHA.
3. **Manually deploy** the exact reviewed S4 cutover commit (auto-deploy still off). This one
   deploy activates both the S4 code and the already-saved credential.
4. Verify `/version` and `/.well-known/atlas-status.json` show `configured: true`.
5. Complete step 7 proof workout before step 8 write reopening.

Separate owner actions (not Render runtime): apply S4 schema (gate 1(c)), run
coaching-input `--apply` with `ATLAS_SUPABASE_MIGRATE_URL` on workstation, activate
freeze via SQL editor, take production backup.

## Authority accounting

| Item | Record |
|---|---|
| Classification | preparation doc — no authority change |
| Current live authority | S3 / Google Sheets |
| Intended sole authority | Supabase after authorized §5.5 |
| Competing authority | none introduced |
| Net complexity | none — consolidates existing §8.1–§8.2 rules |
