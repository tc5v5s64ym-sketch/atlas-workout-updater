# BACKLOG archive reconciliation — 2026-07-20

**Owner-instructed pass (Recovery Campaign, Phase 2, Session 1 of the 2026-07-20 fresh-session pair).**
Rule as given: *reconcile item by item against `docs/BUG_TRIAGE_LEDGER.md` + the execution plan + `git`;
move only ✅ items that are **unambiguously fully closed with no open follow-up**; anything uncertain
stays in the backlog — when in doubt, leave it, because a mis-archived item is invisible open work.*

This is the deferred "backlog archive editorial pass" the config `_note` and `BACKLOG.md`'s own header
point at. It is a **whole-item** conservative pass, not the risky split-the-prose surgery (see
"Conclusion" for why that stays deferred).

## Scope & method

- Read **all 1263 lines** / every top-level item of `BACKLOG.md` (byte-level, not a mechanical grep).
- Cross-checked shipped-vs-open status against `docs/BUG_TRIAGE_LEDGER.md` (all 24 `Bug_Reports` rows
  are ✅/🟡-awaiting-live-retest/⚪-noise — 0 open), `docs/ATLAS_V1_EXECUTION_PLAN.md`, and the
  merged-PR history in `git log`.
- Classified each item: **MOVE** (fully closed, no open follow-up, safe to extract) vs **KEEP**.

## Result — 0 whole items moved

**No item met the bar of "unambiguously fully closed with no open follow-up **and** safe to extract."**
Every ✅ item fell into at least one KEEP category below. The genuinely clean, self-contained items were
already swept into `BACKLOG_ARCHIVE.md` by the 2026-07-08 PR-21 governance-diet pass (~57 KB moved);
what remains is, by construction, open-work-with-shipped-context. `BACKLOG.md`'s own header (the
`🗂️` note) and `BACKLOG_ARCHIVE.md`'s header both already state this.

The paper-weight cap therefore stays at **1263** — the honest current size is the trimmed size, because
nothing was safely trimmable. "Clean baseline" for Guard 6 = **reconciled/verified**, not smaller.

## Why every ✅ item is a KEEP (categories, with examples)

1. **✅ parent with an open follow-up child** — the dominant case. The shipped prose is kept *alongside*
   its still-open `Deferred`/`Open follow-up`/`[ ]`/`watch`/review-nit sub-note; the sub-note is the real
   open work. Splitting them is the editorial judgment a mechanical pass can't safely do.
   *Examples:* every dated bug-remediation section (`B4` → deferred `compactPrescription`; recovery-scold
   `#788` → two deferred intent-RIR items; `Leg Extension` substitution → deferred sibling families);
   nearly every "Near-term"/"Strategic direction" ramp/session-builder ✅ carries a `[polish]` deferred child.
2. **Live `[ ]`/`[x]`/`◼︎`/`◐` checklist tracked by an index** — moving a checked row breaks the accounting
   and the top-of-file "Open P0 / P1 index," which explicitly references the checkboxes.
   *Examples:* "Deep-review audit — 2026-07-07 — open findings" (CLIENT-1/PARSE-1..3 `[x]` alongside
   open INFRA-3/SESS-4/5/6/7); "PR-10 addendum" (ADD-1..7); "PR-11" (PR11-1..5);
   "Test-coverage hardening" (PR2a–d/PR4a–d `◼︎`/`◐`); "Owner live-validation checklist" (all `[ ]`).
3. **Cross-reference anchor** — another item points at it as "the entry above/below."
   *Example:* the ✅ "Session_Plans PR-I — production-validated … No open sub-item" line is the evidence
   anchor that the Session_Plans lane's PR-I entry (`…reconciled to it`) points back to. Moving it breaks
   that reference **and** the lane still has an owner-gated open tail (enabling the
   `skipped_pattern_streak`/`plan_deviation` detectors).
4. **Member of an active lane / gate whose other parts are open** — extracting a ✅ discovery removes
   context an in-flight lane depends on. *Examples:* the F10S-gate discoveries (F10D is paused pending the
   F10S-GATE rerun); F10B/F10C ✅ sit in the F10 family with SESS-4/SESS-5 still `[ ]`.
5. **Interior step of a numbered completed-roadmap ledger with salted-in open items** — moving individual
   ✅ steps leaves a confusing gap and can orphan an interspersed `Deferred`/`Open decision`.
   *Examples:* "Future epic" (PR 1.1 → 4.2, session-execution steps) with deferred children throughout;
   "One-Brain" build sequence 1→10 (contracts 1–4 ✅ but referenced by open steps 5–10); PR 477–486 slices.

## Borderline candidates explicitly evaluated and **left** (the "anything ambiguous, with a note" list)

| Item (BACKLOG) | Status | Why left |
|---|---|---|
| "Extra next-up handoff … FIXED (gate-hardening PR, 2026-07-18)" | ✅, no child | Entangled with the **active** F10S-GATE lane (F10D paused pending the rerun); removing it strips context from a live gate. |
| `F10B-REVISION-WIRING-1` / `F10C-IMPLICIT-WIRING-1` ✅ FIXED | ✅, "(COMPLETE)" | F10 family still has open `SESS-4`/`SESS-5` (`[ ]`, "Tracked as canonical card F10"). Active lane. |
| "Session_Plans PR-I — production-validated … No open sub-item" | ✅, explicitly no sub-item | **Cross-ref anchor** (the lane's PR-I entry points to it) + the lane's detector-enablement tail is owner-gated open. |
| `PR-07 — introduce Vite` (+ its ✅ follow-up) | ✅, both children ✅ | Genuinely fully closed, but embedded in the PR-04/06/08 build-infra cluster (those carry open children); extraction saves ~2 lines while fragmenting the sequence — net-negative, not worth the risk. |
| One-Brain contracts 1–4 (IntentEnvelope/CapabilityManifest/CoachingDecision/StateAssembly) | ✅, no child | Foundational, referenced by open steps 5–10 of the same numbered build sequence. |

None cleared the bar with high confidence **and** zero entanglement, so all were kept per "when in doubt,
leave it."

## Conclusion → how Guard 6's staleness/auto-archive is built safely (Session 1, PR 2)

This reconciliation is the empirical proof of the config `_note`'s stated deferral reason: **you cannot
reliably tell a fully-shipped item from a ✅-with-open-follow-up item by free-text heuristics** — it is
per-item editorial judgment, and even the genuinely-clean items are entangled by cross-refs and active
lanes a script can't see.

Therefore the completed Guard 6 does **not** auto-detect archivability from free text. It gates on an
**explicit, human-confirmed signal**: an item is eligible only when someone tags its bullet
`[archive-ready: YYYY-MM-DD]`. The staleness check fails CI when such a tag lingers > 7 days; the
auto-archive job (`npm run archive:backlog`) moves tagged items to `BACKLOG_ARCHIVE.md` and ratchets the
cap down. Today **no** item is tagged (this pass moved nothing), so the staleness check passes and the job
is a no-op — an honest clean baseline.

The deeper "split each shipped item's historical prose from its live follow-up note" pass remains
deliberately deferred as owner-visible editorial judgment (as `BACKLOG.md`'s `[housekeeping]`
"Deeper BACKLOG re-section" item already records).
