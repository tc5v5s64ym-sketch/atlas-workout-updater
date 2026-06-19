# Codex Contract Guard — Canary Runbook

The Codex contract guard (`.github/workflows/codex-review.yml`, enforcing
`AGENTS.md`) is only trustworthy if we periodically prove it still **blocks real
violations** and **passes clean work** — and that a non-run shows **RED, never a
fake green**. This is the monthly canary runbook.

> **No faith-based promotion.** Run these canaries, watch each RED/GREEN with your
> own eyes in the GitHub UI, then close the canary PRs **without merging** and
> delete the branches. Never merge a canary.

---

## What each canary proves

| Canary | Proves | Expected |
|---|---|---|
| **(a) Generic violation** | The gate goes RED on an obvious correctness bug, and GREEN once fixed. | RED → (fix) → GREEN |
| **(b) Contract-specific violation** | Codex does **contract** work, not just generic lint — it blocks a breach a normal review would wave through. | RED with a **P0** |
| **(c) Non-executed review** | A run that can't execute (no API key, proxy down, API error) fails **RED**, never green. | RED ("REVIEW DID NOT RUN") |

A green Codex check must mean **all three**: a review actually executed, it
completed, and there are no P0/P1 findings.

---

## How to run the canaries

All canary branches are prefixed `canary/` and the PRs are titled `[CANARY] DO
NOT MERGE`. (Phase 5's return-loop, when enabled, skips `canary`-labeled PRs.)

### (a) Generic violation → RED → GREEN
1. Branch off `main`. Add a small helper with an obvious correctness bug whose
   doc comment contradicts the code (e.g. a volume helper documented as
   `weight × reps` that actually subtracts).
2. Open a PR. **Confirm the Codex contract guard goes 🔴 RED** with a P1
   correctness finding.
3. Push a commit fixing the bug. **Confirm the check flips to 🟢 GREEN.**

### (b) Contract-specific violation → RED
1. Branch off `main`. Introduce a breach a generic lint pass would *miss* but the
   Atlas contract must block — e.g. make a **read-only path** (`services/coach.js`,
   `/api/coach/*`, `writeCapable:false`) call `appendRows()` to write to Sheets,
   dressed up as "analytics logging."
2. Open a PR. **Confirm the Codex contract guard goes 🔴 RED** with a **P0**
   finding citing the read-only-path-writes-to-Sheets rule (AGENTS.md P0.4).

### (c) Non-executed review → RED
This is proven automatically whenever the OpenAI key is unavailable: the
responses-API proxy can't start, and the gate's fail-closed guard reports
🔴 "REVIEW DID NOT RUN". To force it deliberately, temporarily point the
workflow at a non-existent secret on a scratch branch (never on `main`).

### Cleanup
Close every canary PR **without merging** and delete its branch.

---

## ⚠️ A RED check only *blocks* merge once it is required (Phase 4)

Until the **Codex contract guard** is promoted to a **required status check** on
`main` (Phase 4 — done manually in branch protection), a RED result is *visible*
but does **not** physically block the merge button. So the canaries prove Codex
**detects and flags** a violation; making RED actually **stop the merge** is what
Phase 4 wires up. To witness the literal block, run one canary **after**
promotion and confirm the merge button is disabled by the failing check.

---

## Latest run — 2026-06-19 (initial proving run)

| Canary | PR | Result |
|---|---|---|
| (a) generic | #371 | 🔴 RED → 🟢 GREEN (see below) |
| (b) contract-specific | #370 | 🔴 RED — 2× **P0** |
| (c) non-executed | #369 (Phase 2) | 🔴 RED — "REVIEW DID NOT RUN" |

**(a) #371 — `canary/volume-calc-bug`**
- `2a4fe2f` (`(weight - reps) * sets`): 🔴 RED — **P1** `services/volumeMath.js:4`, AGENTS.md P1.4 correctness (doc says `weight × reps × sets`, code subtracts).
- `9fa19a5` (`weight * reps * sets`): 🔴 RED — **P1**, the `sets` multiplier would overstate the per-row `Log_Cleaned` `volume_calc` (contract = `weight × reps` per row).
- `e2c695f` (`weight * reps`): 🟢 **GREEN** — matches the per-row contract.

**(b) #370 — `canary/coach-writes-to-sheets`**
- `6862559` (`appendRows('Coach_Analytics', …)` inside `generateChatReply`): 🔴 RED — two **P0** findings: (1) AGENTS.md P0.4, read-only coach path (`/api/coach/chat`, `writeCapable:false`) writing to Sheets; (2) AGENTS.md P0.3, the write bypasses `beginWrite`/`completeWrite`/`failWrite` idempotency. Codex traced `generateChatReply` to its read-only route on its own.

**(c) #369 — non-executed run**
- During Phase 2, runs with a missing/empty OpenAI key (`OPEN_API_KEY`) hit the
  proxy "Failed to read server info" path; the fail-closed gate reported
  🔴 "REVIEW DID NOT RUN — failing closed: a non-run is RED, never green."

### Telemetry — Codex vs. Claude disagreements (record who was right)

- **`9fa19a5` (`weight * reps * sets`):** Codex flagged **P1** — the `sets`
  multiplier overstates the per-row `volume_calc` contract. The parallel Claude
  review on the same commit reported *"no correctness bug found."* **Codex was
  right** — a genuine 12-column-contract nuance a generic correctness pass missed.
  This is exactly the contract-specific value the guard is meant to add.

> Keep logging real-world Codex/Claude disagreements here during the parallel-run
> proving period (Phase 6). They are telemetry, not blockers.
