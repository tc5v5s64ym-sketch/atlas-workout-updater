# Atlas — Agent & Automated-Review Contract

This file is read by coding agents (Codex and others) and by the automated
**contract-guard** review gate. It defines the review guidelines that the gate
enforces on every pull request.

## Source of truth

`CODEX.md` defines the full Codex reviewer / agent behavior and remains
authoritative. This file is the *machine-checkable rule subset* the automated
gate scores. Its substance is sourced from the contract docs:

- `CLAUDE.md` — operating brief + the "critical behaviours" table
- `docs/INVARIANTS.md` — rules that must never break (P1–P3, W1–W7, S1–S4, T1–T3, PR1–PR4)
- `docs/CONSTITUTION.md` — mission, scope, and the trust loop
- `BACKLOG.md` / `docs/ACTIVE_ROADMAP.md` — scope and roadmap fit

If this file and `CODEX.md` ever conflict, **`CODEX.md` wins** — fix this file in
a docs-only PR.

## How the gate scores a PR

The automated Codex review classifies every finding by severity. The check is
**GREEN only when all three of these hold**:

1. a review actually executed,
2. the review completed successfully, and
3. no **P0** or **P1** findings exist.

A skipped, errored, or API-unavailable run is **RED**, never green. "The job did
not fail" is *not* "the review passed."

- **P0 / P1 → RED (blocking).** The PR must not merge until the finding is
  resolved or the owner explicitly overrides.
- **P2 → non-blocking note.** Recorded for the owner; does not fail the gate.

## Review guidelines

### P0 — Contract & safety violations (always blocking)

A finding is **P0** if the diff does any of the following:

1. **Invariant violation.** Breaks any rule in `docs/INVARIANTS.md`, or changes
   any row of the "Critical behaviours — never change without owner approval"
   table in `CLAUDE.md`:
   - slash notation `225 5/2` = 225 lb × 5 reps @ RIR 2 (never reps × set-count);
   - `test_mode` absent = live write;
   - dry-run proof fields `sheet_written:false` + `no_write_confirmed:true`;
   - live-write proof `sheet_write:'success'` + `log_rows_written>0`;
   - undo read-back returns 409 on a missing/empty/mismatched row;
   - undo is restricted to the `Log_Cleaned` tab;
   - deload uses the predefined protocol, never invented numbers.
2. **Schema change without migration.** Adds, removes, or reorders columns in
   `Log_Cleaned` (12 cols), `Effort` (9 cols), `Constraints` (5 cols), or
   `Deload_State` (7 cols) without an explicit schema migration **and** owner
   approval.
3. **Write-path idempotency loss.** Any code path that writes to Google Sheets
   that does not route through `beginWrite` / `completeWrite` / `failWrite`
   (write_id dedup).
4. **Read-only path writing or inventing numbers.** The coach or chat paths
   (`writeCapable:false` in `config/routes.js`) writing to Google Sheets, or any
   LLM path inventing numbers the deterministic engine should own.
5. **Secret / credential exposure.** Committed `.env`, Google service-account
   credentials, API keys, screenshots, or private workout data; `ATLAS_API_KEY`
   printed to logs or any externally visible response; `GOOGLE_SHEETS_ID` changed
   in a routine (non-cutover) PR.

### P1 — Correctness & process violations (blocking)

1. **Trust-loop deviation.** Any change to the preview → approve → write loop
   (`public/app.js`) that weakens explicit-approval-before-write, or a write that
   bypasses the dry-run preview.
2. **Process-consistency violations.** A docs-only PR that also changes
   production code, tests, or config (Invariant PR2). A new Express route without
   the matching `config/routes.js` entry (Invariant PR3). *(PR bundling / number
   of concerns is NOT a blocking finding — Invariant PR1 is advisory; see "What
   the guard must NOT do" below.)*
3. **Missing tests.** Parser changes without golden tests (P2 invariant);
   write-path changes without live-path / closest-integration coverage; tests
   that reach a real spreadsheet instead of stubs (T1–T3).
4. **Correctness / bugs.** Logic errors, regressions, or unsafe handling in the
   changed code.

### P2 — Non-blocking notes

Style, minor cleanups, opportunistic improvements, and future-scope
observations. Route future-scope work to `BACKLOG.md` per `CODEX.md`; do not
build it inside the current PR.

## What the guard must NOT do

- Must not report GREEN on a PR it could not actually review — treat a
  non-executed or errored run as RED.
- Must not invent findings to appear useful; absence of P0/P1 is a valid GREEN.
- Must not expand scope, write to Google Sheets, or print secrets.
- Must not block a PR for bundling multiple concerns or for size. Invariant PR1
  (focused PRs) is advisory, not gate-enforced — the owner's roadmap workflow
  intentionally batches related items. Judge the whole diff on its safety and
  correctness regardless of how many concerns it covers. (This does **not** relax
  "scope creep" in the sense of accidental future-PR work, which `CODEX.md` still
  flags.)
