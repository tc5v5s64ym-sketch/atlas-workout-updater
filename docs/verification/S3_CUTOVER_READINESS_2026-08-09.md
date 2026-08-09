# PR S3 — cutover-readiness evidence (2026-08-09)

Evidence for the `S3` gate of
[`docs/SUPABASE_HOT_PATH_MIGRATION.md`](../SUPABASE_HOT_PATH_MIGRATION.md) §6.2. It records
measurements; it authorizes nothing, moves no authority, and starts no cutover.

**Read the level of each item before quoting it.** Two kinds of evidence appear below, and they
are not interchangeable:

| Level | What it proves | Where it comes from |
|---|---|---|
| **CODE** | the implementation behaves as specified | the from-empty Postgres proof and the unit suite, on every CI run |
| **DEPLOYMENT** | `Atlas Production` behaves as specified | owner-run, after the owner applies the `S3` migration |

**No DEPLOYMENT evidence exists yet, and none may be claimed.** `atlas.write_freeze` does not
exist in `Atlas Production`: applying the `S3` migration is an owner gate (§6.2 P8b, §5.3 owner
gate 2), and it is outstanding. Everything below is CODE-level unless it says otherwise.

---

## §6.2 P4(a) — the residual in-request Sheets read count, per range

**MEASURED, not asserted.** Produced by replaying the captured client manifest
`test/fixtures/liveSessionManifest.json` — 113 real requests, in order, nothing compressed and
nothing dropped — through the real application, counting every range at the googleapis
boundary. Emitted by `test/liveSessionReadBudget.test.js`
(`S3/P4(a): the residual in-request Sheets reads on the migrated Save path are MEASURED, per range`).

```
manifest requests driven ......... 113
total in-request range reads ..... 255
on MIGRATED tabs (S4 removes) .... 204
     34 × Log_Cleaned!A:Z
     17 × Session_Plan_Sets!A:Z
     17 × Session_Plan_Sets!A1:A1
     17 × Session_Plan_Sets!A1:P1
     16 × Session_Plans!A1:M1
     16 × Session_Plans!A:Z
     16 × Session_Plans!A1:A1
     14 × Log_Cleaned!B:G
     14 × Log_Cleaned!1:1
     14 × Effort!B:B
     14 × Effort!1:1
     12 × Effort!A:Z
      2 × Exercise_Catalog!A:Z
      1 × Log_Cleaned!A2:L13
on UNMIGRATED tabs (they stay) ... 51
     26 × Constraints!A:Z
     24 × Deload_State!A:Z
      1 × Coaching_Notes!A:Z
```

**Residual after the `S4` cutover, on the migrated concepts: 0 of 204.** Every migrated-tab
range above is served by a declared prospective Supabase read in
`services/migrationReadParity.js`, and the test FAILS if a migrated-tab range appears with no
declared moved read covering it — a read `S4` could not delete would otherwise be invisible
inside a total.

**What this does NOT say.** It does not say a read has moved. `S3` moves none (ruling D5). It
does not certify quota independence — see P4(b), which forbids that claim.

## §6.2 P4(b) — the bounded background dependency, stated and gated

The catalog mirror converts a per-request Sheets dependency into a **bounded background** one.
Reported by `npm run atlas:readiness`.

| Field | Value |
|---|---|
| `CATALOG_MIRROR_MAX_AGE` | `ATLAS_CATALOG_MIRROR_MAX_AGE_SEC`, default **3600 s** |
| Declared sync interval | `ATLAS_CATALOG_MIRROR_SYNC_INTERVAL_SEC`, default **600 s** (`npm run atlas:catalog-sync`) |
| Behaviour past the bound | **fail closed** — an explicit 503 with a stated reason; stale content is never served |
| Residual: how long a TOTAL Sheets outage may last before a Save fails | **3000 s – 3600 s** (worst case `max_age − interval`, best case `max_age`) |
| Gate | a single missed sync must not reach the bound: `2 × interval < max_age` |

**The claim, in the only form the evidence supports:** the migrated Save path issues no
**in-request** Sheets read. Save availability is **not** independent of the Sheets quota — it
depends on a background sync succeeding inside the age bound above.

## §6.2 P3, P5, P6, P7 — backfill, reconciliation, parity, sweep, repair

CODE level, from the from-empty Postgres proof `test-pg/backfillReadiness.pgproof.js`
(`npm run test:pg`, a real disposable Postgres database created from empty and destroyed for
the exact run, with every file in `supabase/migrations/` applied from scratch).

| Gate | Requirement | Proof |
|---|---|---|
| P3 | equal counts, every row matched by export identity, field-by-field zero differences after §4.7 | `after the backfill every tab reconciles by count, identity AND content`; the negative `a COUNT match with a CONTENT difference is reported as NOT reconciled` proves counts alone cannot pass |
| P5 | every read `S4` will move returns what the Sheets read returns today | `every read S4 will move returns what the Sheets read returns today`, plus three negatives (a changed row, a missing row caught by the derived duplicate-guard projection, a stale catalog) |
| P6 | the open-divergence count reaches zero **and** the sweep ran to completion | `after the backfill a COMPLETE sweep finds zero divergences`; the negative `an INCOMPLETE sweep is not a zero, even when its counters read zero` |
| P7 | a divergence closes only on a passing re-comparison | `a repaired omission closes ONLY after the re-comparison passes` (asserts `closure_proof`), plus `a divergence the worker CANNOT fix stays OPEN` |
| P1 | deterministic tests for every read path the cutover moves | `every declared moved read has a prospective Supabase implementation` |

**Redaction.** The reconciliation report emits field names and **shapes** — `int(3)`,
`decimal`, `text(len=12)`, `null` — never loads, reps or notes, and the proof asserts that no
workout value appears in it (§3.8, §8.4).

**The reconciliation of `Atlas Production` is OWNER-EVIDENCE-PENDING.** The backfill is a
one-way script run once per environment, it requires a configured runtime Supabase role, and no
connection string is set in any live Atlas environment. Its report is produced by the owner
when the backfill is run, not by this PR.

## §6.2 P8a, P8, P9, P10, P11, P12, P13 — the write freeze and the receipt seam

Owner ruling **D7 — APPROVED 2026-08-09**: `atlas.write_freeze` is permanent Atlas safety
infrastructure with no sunset. The authorization is recorded in
[`docs/ATLAS_V1_EXECUTION_PLAN.md`](../ATLAS_V1_EXECUTION_PLAN.md).

| Gate | Level | Proof |
|---|---|---|
| P8a | CODE | `test-pg/writeFreeze.pgproof.js` — the §3.10 shape; a second row rejected by the primary key **and** by the `CHECK`; the seeded dormant row present; `atlas_app` **can** `SELECT`; `atlas_app` **refused** `INSERT`/`UPDATE`/`DELETE` and refused DDL, executed **as the real role** |
| P8 | CODE | a real separate server process serves, the owner updates the row, and **that same process** — proven by pid and process identity, never restarted — refuses on its next request; a receipt minted before activation is still in its live map afterwards |
| P9 | CODE | a replacement instance started while frozen refuses on its **first** request and appends nothing, ever |
| P10 | CODE | `test/writeFreezeRoutes.test.js` — **all seven** `beginWrite` routes, each proven separately: 503 with a stated reason, zero Sheets appends, zero deletes, zero cell updates, and **no receipt claimed** (`peekWrite` returns null, and the same `write_id` still writes normally once the freeze lifts) |
| P11 | CODE | a failed read, a deleted row, a killed database session, and an instance that never read successfully all refuse; **no environment variable and no file** opens writes while the row says frozen; clearing the connection string does not disarm a live process |
| P12 | CODE | dormant issues **no freeze read at all**, and each of the seven routes answers identically dormant and armed-open — same status, same body, same appended rows |
| P13 | CODE | `test/receiptMigrationSeam.test.js` — a memory-only receipt exported after a **real** persistence failure; import restores into an **already-running** process, while writing `/tmp` instead **fails**; both routes inert unless frozen; **the auth negative** — a valid `atlas_session` cookie with no `x-atlas-api-key` is refused even inside the window, and the same cookie is proven to be a working `/api` credential; the single-instance invariant proven three ways, including the loss it prevents; and a source scan proving **no second secret exists to configure** |
| P8b | **NOT CLAIMED** | the owner must apply the `S3` migration to `Atlas Production` first. No deployed-system freeze evidence exists. |

## What this PR does not claim

- It does not claim any read or write authority moved. Sheets, plus the file-backed store in
  `services/idempotency.js`, decides everything until `S4`.
- It does not claim `atlas.write_freeze` exists in `Atlas Production`.
- It does not claim the backfill has been run against any live environment.
- It does not claim quota independence.
- It does not claim the migration is closed, or that `S4` may begin.
