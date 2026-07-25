# Phase 4 — Golden Session evidence (2026-07-25)

**Overall verdict: NOT YET.**

Phase 4 ("The canonical proof") **remains open**. Phase 5 does not begin. This document records what the
Golden Session run proved, what it did not, and the dispositions ruled on the results. It is
documentation only — it changes no production code, enables no flag, and makes no product decision.

Companion document: [`PHASE_4_OWNER_GATE_HANDOFF.md`](PHASE_4_OWNER_GATE_HANDOFF.md) (the readiness
statement written before the run, listing the exact gate sequence this run followed).

## 1. What was run, and under what conditions

A **mock Golden Session** — the scripted two-exercise session from the handoff document's §9 beat list, run
as an ordinary session rather than a real training session. It was a rehearsal of the gate sequence against
production, not owner gym evidence.

| Condition | Value during the run |
|---|---|
| Session type | **Mock** — scripted beats, not a genuine training session |
| `ATLAS_TURN_PRECEDENCE` | `1` — the staged live packet-consumption seams active |
| `SESSION_PLAN_SETS_WRITE_ENABLED` | `1` for the duration of the run (the owner gate) |
| `ATLAS_INTERACTION_TRACE` | `shadow` — packet/trace logged for review |

**Data disposition.** The run appended temporary rows to `Log_Cleaned`. Those rows were **removed through
the verified undo path**, which is itself part of the evidence below: the undo executed, its read-back
fail-closed behaviour held, and the temporary rows are gone. No owner training data was altered, no manual
Sheet edit was made, and no historical rewrite occurred.

**Current production state.** `SESSION_PLAN_SETS_WRITE_ENABLED` is back to **`0`** — owner-confirmed
2026-07-25, before this document was written. Planned-set checkpoints and seals are therefore back to
dry-run, returning the W1–W3 no-write proof. `ATLAS_TURN_PRECEDENCE=1` may remain enabled; the seams it
gates are proven byte-identical to the prior path.

## 2. Evidence provenance and bounds

The findings below are **owner-reported from the run**. This document deliberately carries no Sheet ID, no
credentials or keys, no tab ranges, and no workout-history detail beyond what a finding cannot be stated
without. Where a specific value is quoted, it is a diagnostic counter, not training data.

This document also records **no trace or session identifier**. That is not an omission for brevity — see
criterion 7: the end-to-end trace the gate asked for does not exist to cite, for architectural reasons.

## 3. Dispositions

| # | Item | Disposition |
|---|---|---|
| 1 | H-03 — recommendation-explanation | **live-proven** |
| 2 | H-03 — recovery-routing | **live-proven** |
| 3 | H-08A — `packet.session` | **live-observed, schema-valid** — not route-consumed, not live-proven |
| 4 | D10 — discussion referent | **open** |
| 5 | H-09 — planned-vs-actual capture | **partial** |
| 6 | Closeout / seal | **forward path proven once**; undo → re-save/re-seal failed |
| 7 | InteractionTrace end-to-end | **gate requirement not met** (architectural) |
| — | **Phase 4 overall** | **open — NOT YET** |

### 1–2. H-03 — recommendation-explanation and recovery-routing: live-proven

Both canonical-decision consumption seams landed in PRs #1156–#1160 were exercised live with
`ATLAS_TURN_PRECEDENCE=1`, at both reply sites each, and both produced the expected replies from the
canonical decision. These are the two capabilities the phase staged for the canonical proof, and they
carried it.

This is a **seam-level** disposition: the live route read `packet.decision` and the reply it served was
the canonical one. It is not a claim about any other decision type — every other decision type remains
shadow-only, unchanged from the handoff document's §5 inventory.

### 3. H-08A — `packet.session`: live-observed and schema-valid, but not consumed

`packet.session` was populated in production and **validated against its canonical contract** on live
turns. That is a genuine result and it is recorded as such.

It is **not** `route_consumed` and **not** `live_proven`, because the live response still does not read
`packet.session` — the reply is composed from the pre-existing session inputs, and the packet's session
rides alongside it. A fact that is assembled correctly but never read has not been consumed. Under the
understate-when-unsure rule this stays at observation, and the phrase "route-consumed" is not used for it
anywhere in this document.

### 4. D10 — discussion referent: remains open

The run proved **one-turn** alignment: within a single turn, the referent the route resolved and the
referent carried on the packet agreed. That is worth having and it is the limit of what was shown.

It did **not** deliver cross-turn referent persistence, and it did **not** retire the in-memory referent
store or the history-scan fallback — both remain in place and remain the actual source of truth across
turns. D10 stays open on the Phase-3 divergence punch list. Retiring the fallback needs a client-protocol
round-trip (the same seam the trace-correlation successor issue needs), not a server-only change.

### 5. H-09 — planned-vs-actual capture: partial only

**Proven:** plan acceptance, per-movement outcomes, closeout, and sealing. The append-only `Session_Plans`
persistence recorded the accepted plan's identity, the substitution that occurred, the outcome of each
planned movement, and the closeout state — end to end, through the live path, with the write flag on.

**Failed:** capture of an **explicit user-endorsed mid-session revision to the remaining sets of a movement
already in the plan** — a load/rep change rather than a movement swap. The substitution lane captures a
movement→movement change; there is no equivalent capture for an endorsed revision within a movement, so
the later sets were logged against a plan item whose recorded prescription no longer matched what was
agreed. Filed as #1163.

H-09 is therefore **partial**, not passed.

### 6. Closeout and seal: forward once, reverse unproven

The **forward** path was proven once: close out → seal → the sealed state persisted and survived a reload.

The **reverse** path failed. After a session is sealed, an undo of the logged rows leaves the sealed
closeout stranded, and re-saving and re-sealing that session is unproven and currently fails — the seal can
assert a completed session whose sets no longer exist. Because `Session_Plans` is append-only, this is a
semantics question before it is a coding one (what supersedes a seal, what the idempotency key is for a
second seal, what a reader sees mid-way). Filed as #1164, with the adjacent session-working-state question
filed separately as #1166.

One forward pass is not a proven closeout contract.

### 7. InteractionTrace — the gate requirement was not met

The gate asks for **one reviewable trace spanning first word → sealed write**. That was not produced, and
the reason is architectural rather than evidential:

> `write_proof` is absent from the InteractionTrace **by current architecture**, not because a log record
> was missing.

The InteractionTrace is minted and closed on the **coach** turn, which terminates on a read-only route —
`/api/coach/message`, `/chat`, and `/ask` are all declared `readOnly: true, writeCapable: false` in
[`config/routes.js`](../../config/routes.js). The write happens afterwards, on a **different request to a
different route**. Nothing today carries the coach turn's canonical `turn_id` across that boundary, so no
amount of additional logging on the coach route could yield a `write_proof`: there is no write on that
route to prove.

This document does not describe the result as "missing log evidence", because that framing would imply a
fix that does not exist. The correlation seam has to be built. Filed as **#1165** (cross-route trace/write
correlation through `write_proof`), which is the successor issue this criterion requires.

## 4. Issue #952 — ruling: CLOSE as completed

**[#952](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/952)** ("Persisted plan history —
the data prerequisite for drift's `skipped_pattern_streak` & `plan_deviation` kinds") is **closed as
completed**.

**Evidence.** #952 asked for one thing: a persistence layer supplying, per session, which **planned
movements** were completed versus skipped or substituted. Its own statement of the minimum facts is
explicit that plan loads and reps are not required — "movement/pattern identity + completed-or-not is
enough". The approved append-only `Session_Plans` persistence now captures exactly that, and this run
proved it live: accepted plan identity, substitutions, per-movement outcomes, and closeout state, written
through the append-only system-state path (never through the logged-set preview → approve → write loop),
under the owner-approved 13-column contract. That is the movement-level planned-versus-completed data the
original drift contract required.

**#952 is NOT superseded by the set-level revision defect.** The defect in criterion 5 is a *set-level*
prescription-revision gap. The `plan_deviation` detector in
[`services/driftSignal.js`](../../services/driftSignal.js) compares **planned movement names against
completed movement names**; it does not consume target loads or reps at any point. A missing set-level
revision therefore cannot weaken the movement-level contract #952 was filed for. Rewriting or superseding
#952 with that defect would misattribute a later capability gap to a prerequisite that was genuinely met.
The set-level capture is filed on its own terms as #1163.

## 5. Successor issues opened

Each is a separate concern with its own PR. **None of these fixes belong in this documentation PR**, and
none of them are started by it.

| Issue | Concern |
|---|---|
| [#1163](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1163) | Explicit user-endorsed future-set revision capture, outside the substitution lane |
| [#1164](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1164) | Undo after a sealed closeout — re-save / re-seal semantics |
| [#1165](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1165) | End-to-end trace correlation through `write_proof` (cross-route) |
| [#1166](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1166) | Session recovery / re-save after undo |
| [#1167](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1167) | Incoherent `sandbag_persistence` evidence (`sessions_below:5`, `sessions_checked:5`, `sessions_considered:1`) |
| [#1168](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1168) | Diagnostic append-range concurrency and reporting |
| [#1169](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1169) | Redline safety decision not embedded in the packet |
| [#1170](https://github.com/tc5v5s64ym-sketch/atlas-workout-updater/issues/1170) | Duplicate `Intent_Shadow` records; recurring `/api/log-modality` 422 |

## 6. Capability completion ladder — unchanged by this run

**No capability in [`config/coaching/manifests/capabilities.json`](../../config/coaching/manifests/capabilities.json)
is promoted by this document, and the manifest is not edited by this PR.**

That is the accurate outcome, not a conservative one. The ladder's capabilities are the Brain modules the
One-Brain Coach Orchestrator runs (`scenario_classifier`, `progression`, `safety`, …). The two seams proven
live in criteria 1–2 are **canonical-decision consumption seams on the coach route**; neither is a manifest
capability, and neither the recommendation-explanation nor the recovery-routing seam has a manifest entry
to promote. The published table
([`docs/CAPABILITY_COMPLETION_LADDER.md`](../CAPABILITY_COMPLETION_LADDER.md)) correctly continues to read
**zero capabilities at `route_consumed` or higher**.

Two consequences follow, and both are deliberate:

- The seam-level phrase **"live-proven"** in criteria 1–2 is not a ladder rung claim. Rung 8 (`live_proven`)
  is a property of a manifest capability and requires a linked trace id under Drift Guard 4; nothing here
  claims it.
- `packet.session` (criterion 3) is explicitly held below `route_consumed` for the reason given there, so
  no ladder movement is implied by it either.
- `owner_accepted` remains false everywhere. It is owner-gate-only and no agent may self-assign it.

## 7. What Phase 4 still needs

Phase 4 closes when the Golden Session passes with the owner satisfied **and** one reviewable trace spans
first word → sealed write. Against that bar:

- criteria 1–2 hold;
- criterion 3 is observation, not consumption;
- criteria 4–6 are open, partial, and half-proven respectively;
- criterion 7 cannot be met without the correlation seam in #1165.

**Phase 4 remains open. Phase 5 does not begin.** The next work is the successor issues above, each on its
own branch and its own PR.

## 8. Production safety at the time of writing

- `SESSION_PLAN_SETS_WRITE_ENABLED` = **`0`** (owner-confirmed 2026-07-25). Planned-set checkpoints and
  seals are dry-run, returning `sheet_written:false` / `no_write_confirmed:true`.
- The run's temporary `Log_Cleaned` rows were removed through the verified undo. No owner training data was
  altered; no manual Sheet edit was made.
- No schema change, no migration, no proof-field change, no preview → approve → write change was made by
  the run or by this document.
- This PR is documentation only. It touches no production code path.
