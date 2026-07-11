# One-Brain Promotion Criteria

> **Status:** Governance (active). Owner document.
> **Governs:** how any Atlas Brain — Brian v1 today, every Brain version after it — earns the right to become the primary production coach, and how that promotion is reversed.
> **Relationship to other governance:** promotion is an owner-reserved decision under `docs/OWNER_CHECKIN_RULES.md` (criterion 2 — a change to the product's coaching model). This document defines the *evidence standard* that decision requires. It does not amend the Constitution or Invariants; the preview→approve→write trust loop, proof fields, and schema rules are untouched by anything here.
> **Audience:** future maintainers. If you are reading this two years from now to decide whether a new Brain may serve users, this document is the process. The *implementation details* referenced in bracketed "Current implementation" notes describe 2026-07 Atlas and may have evolved; the process itself should not need to.

---

## 1. Purpose

Atlas never promotes a Brain because it feels better, demos well, or embodies a cleaner architecture. Architecture opinions do not promote software. Measured performance does.

A Brain is a decision engine that tells a real person what weight to put on a bar. The cost of a wrong promotion is not a bad metric — it is a bad set, a bad week of training, or an injury, delivered with the full confidence of the coach surface. So promotion is an evidence question, and this document defines what counts as evidence, what constitutes success, what blocks promotion, who approves it, and how it is undone.

Every future Brain version (Brian v2, v3, a rebuilt engine, a re-tuned one) passes through this same process. There is no seniority exemption: a Brain that was once primary and was substantially changed re-earns promotion the same way.

## 2. Promotion Philosophy

**Safety first. Users are never test subjects.**

Atlas runs a candidate Brain in **hybrid shadow mode**: the legacy engine continues to produce every number the user sees, while the candidate Brain composes its own decision for the same request in parallel. The Brain's output is recorded and attached for observation; it is never served. The user's experience is byte-identical to legacy — this is pinned by tests, not by convention.

Shadow mode is not an experiment. It is an **evidence collection phase**. An experiment implies the outcome is applied to the subject; here it never is. The user gets the proven engine; the observer gets a reviewable record of what the candidate *would have said*, including the times it declined to answer and the times it failed.

Two consequences of this philosophy:

- **Observation before opinion.** No amount of code review, test coverage, or architectural confidence substitutes for watching the Brain's decisions against real training history over a real window.
- **The candidate must earn each surface separately.** A Brain that is trustworthy for one decision type (e.g. single-lift progression) is not thereby trustworthy for another (e.g. whole-workout generation). Promotion is granted per decision type through the serve-eligibility rail, never wholesale.

> Current implementation: `ATLAS_COACH_ENGINE` selects the mode (`legacy` default · `hybrid` = shadow-only observation · `brian` = the candidate drives serve-eligible decision types, with automatic legacy fallback for everything else). The serve-eligibility allowlist lives in `services/coachEnginePromotion.js` (`SERVE_ELIGIBLE_DECISION_TYPES`); expanding it is itself an owner-gated promotion under this document.

## 3. Observation Window

Promotion requires meaningful real-world usage. Synthetic traffic, replayed fixtures, and simulation harness runs are useful for development but do not count toward the window — only orchestrations triggered by real training activity do.

**Sample size:**

- **Minimum: 50 real recommendation events** (recorded orchestrations at the live coach-engine gates, produced by genuine usage).
- **Preferred: 100 or more.**

**What a "real event" is — deterministic provenance (PR-GATEA1).** A recorded orchestration counts toward the 50-event floor **only** when its `Brain_Shadow` row is `evidence_eligible = TRUE` **and** `evidence_class = athlete_ui` — i.e. it was positively identified as genuine athlete-UI activity in production. "Positively identified" is deliberately more than a client-set marker: the request must carry the first-party UI marker **and** browser-enforced same-origin fetch provenance (`Sec-Fetch-Site: same-origin`, which page JavaScript cannot forge, plus a host-matched `Origin`/`Referer`), **and** the client must not be under browser automation (`navigator.webdriver`), **and** the runtime must be known production. A bare `x-atlas-request-origin: athlete_ui` header on a direct API call or a script — with no browser provenance — classifies `unknown`, not `athlete_ui`. This is honest **first-party UI provenance** designed to exclude known automated and direct-API traffic; it is **not** authentication or cryptographic user attestation. Every other row is recorded for engineering evidence but **never counts**:

- `evidence_class = synthetic` — `test_mode`, or a known automated source (CI / Playwright / simulation / canary / smoke / probe / a non-production runtime). Marked by the source or by the runtime; always ineligible.
- `evidence_class = unknown` — an untagged direct API call, missing/malformed provenance, or **any old row written before PR-GATEA1** (the three provenance columns are absent → reads back as `unknown`). Fail-closed; always ineligible.

Classification is deterministic — derived solely from the request's provenance signals (`x-atlas-request-origin`, the simulation marker, `test_mode`, and the production runtime), **never inferred from traffic volume or timestamp patterns** — and is telemetry-only: it never changes a served coaching response. The classifier and its rules live in `services/evidenceProvenance.js`. Because the pre-PR-GATEA1 window mixed genuine and synthetic traffic without this provenance, that window is archived as engineering evidence and **does not count**; the floor is counted from a fresh window collected after the provenance fields deploy (see the PR-GATEA1 owner runbook, `docs/verification/GATEA1_WINDOW_RESET_RUNBOOK.md`).

**Sample variety matters more than raw count.** Fifty refreshes of the same lift on the same day are one data point wearing fifty hats. A valid window should span:

- multiple distinct training sessions (different days, different readiness states),
- multiple lifts and muscle groups, upper and lower body,
- the scenario spread the Brain claims to handle (normal progression, plateau, post-gap return, active deload, thin history),
- at least some in-workout traffic (just-logged-set conditions), not only planning-time requests.

If the window closes without variety, extend the window rather than lowering the bar. There is no calendar deadline on evidence collection; there is a floor on its quality.

## 4. Evidence Collected

Every promotion decision draws on the following sources. Any future telemetry extends this list; nothing here is intended to cap it.

| Source | What it shows |
|---|---|
| **Brain_Shadow** (durable shadow record) | Every orchestration at the coach-engine gates: wins (decision type, status, confidence tier, skipped capabilities, legacy-vs-Brain divergence), declines (`ok:false` with reason), and crashes (orchestrator/assembly errors). This is the primary evidence stream — it captures the Brain's *hit rate* and *failure rate*, not just its successes. |
| **Intent_Shadow** (durable intent-router record) | The natural-language intent classifier's shadow accuracy on real typed messages. This measures the *router*, not the Brain's coaching decisions — its promotion (letting classifications route anything) is a separate evidence-gated decision. Within *this* document it contributes one thing: proof that shadow telemetry infrastructure is functioning. |
| **Hybrid comparison** (owner side-by-side review) | Human judgment on representative cases: Legacy vs Brain summaries compared decision-by-decision, with preference feedback. |
| **Comparable decisions** | Orchestrations where both engines prescribed at least one shared numeric field — the population on which agreement and divergence statistics are computed. |
| **Non-comparable decisions** | Orchestrations recorded but excluded from divergence statistics (see §6). Their *count* is still evidence: a window that is mostly non-comparable is not a valid window for the decision type in question. |
| **Latency** | Per-orchestration elapsed time, and the felt responsiveness of in-workout surfaces while shadow composition runs. |
| **Errors** | Orchestrator and assembly errors, shadow-persistence failures, and anything surfaced in server logs during the window. |
| **User-visible regressions** | Any observed difference in the served experience while in hybrid mode. The expected count is zero; byte-identity is test-pinned. |
| **Clarification requests** | How often, and on what inputs, the Brain declines to answer (`needs_clarification`). Honest declines are a feature; their *pattern* tells you where the Brain's competence ends. |

> Current implementation: `services/brainShadow.js` (in-memory ring + `GET /api/debug/brain-shadow` aggregates + best-effort append to the optional `Brain_Shadow` tab under `ATLAS_BRAIN_SHADOW_PERSIST`); `services/intentShadow.js` (+ `Intent_Shadow` tab); the Settings → Debug "Hybrid Coach Compare" panel (`public/hybridCompare.js`). The in-memory rings reset on deploy — the Sheets tabs are the durable record, which is why persistence must be on for the window to count.

## 5. Promotion Acceptance Criteria

Promotion of a decision type requires **all** of the following. Each item needs positive evidence — the absence of a recorded failure is not a pass if the recorder wasn't running.

- [ ] **Hybrid mode produced no intentional user-visible behavior changes.** The served responses stayed legacy-driven for the entire window; byte-identity tests remained green throughout.
- [ ] **Brain_Shadow wrote successfully for the entire window.** The durable record is complete — no gaps attributable to persistence failures, disabled flags, or deploys that silently reset an in-memory-only record.
- [ ] **Intent_Shadow wrote successfully.** (Telemetry-health check: the shadow infrastructure as a whole is functioning, not just the Brain lane.)
- [ ] **Zero unsafe coaching recommendations** in the shadow record. Unsafe means: a load or rep target a competent coach would refuse (violates an active deload protocol, ignores a stored injury constraint, prescribes a physically implausible jump), regardless of whether it was within numeric tolerance of anything.
- [ ] **Zero orchestrator errors.** `orchestrator_error` / `assembly_error` entries are engine crashes, not coaching judgments. Any occurrence requires root-cause and fix before the window can conclude (a fixed cause may justify restarting the count for the affected scenario rather than the whole window — owner's call, documented).
- [ ] **Comparable Brain decisions agree with Legacy at least 90% of the time.** "Agree" means every shared prescribed field is within the coaching tolerance below. The remaining ≤10% are not automatically failures — a candidate may legitimately out-coach the incumbent — but **every** out-of-tolerance divergence must be individually reviewed in §8 and judged coaching-defensible. One indefensible divergence is an unsafe recommendation (see above).
- [ ] **Load divergence remains within acceptable coaching tolerance.** Initial calibration values (owner may revise with evidence; record revisions here):
  - Upper-body barbell lifts: **±5 lb**
  - Lower-body barbell lifts: **±10 lb**
  - Repetition targets: **±1 rep**
- [ ] **`ok:false` decisions are explainable.** Every decline maps to honest uncertainty (thin history, missing check-in data, genuinely ambiguous intent) rather than engine failure. A decline pattern that blankets a scenario the Brain is *supposed* to handle is a capability gap, not noise.
- [ ] **Workout logging responsiveness remained acceptable.** Shadow composition runs on hot in-workout routes; if the gym experience got sluggish, that is a regression to fix before promotion, not a footnote.
- [ ] **No trust-critical regressions.** Nothing in the window touched or degraded the preview→approve→write loop, proof fields, undo, or idempotency behavior.

## 6. Known Exceptions

Situations that do **not** block promotion. Each is recorded evidence, deliberately excluded from the statistics above. Future engine capabilities are expected to move items *out* of this section; nothing should move in without the same scrutiny.

- **Coach's Pick (`workout` decisions) reports `comparable:false`.** Whole-workout prescriptions carry their numbers in per-exercise blocks; block-level divergence comparison has not been implemented. These events are recorded but excluded from agreement/divergence statistics — which also means **this document cannot currently be satisfied for the `workout` decision type**. Building block-level comparison is a prerequisite for ever opening that promotion window, not a blocker for the `progression` window.
- **Skipped capabilities in provenance.** The orchestrator honestly records declared capabilities it did not run (unwired or missing modules). A skip is not an error; the promotion question is whether the decisions *produced* were good, and §5's unsafe/agreement bars already answer that. (Expanding runner coverage is engine roadmap work, tracked in `BACKLOG.md`.)
- **Declines on thin history.** `needs_clarification` on a lift with almost no logged sets is correct behavior and counts in the Brain's favor under the `ok:false` criterion, not against the agreement rate (declines are non-comparable by definition).
- **Known cosmetic gaps in the shadow record** (e.g. a blank metadata column pending a wiring follow-up) — provided the substantive fields are intact and the gap is filed in `BACKLOG.md`.

## 7. Automatic Promotion Blockers

Any of the following **immediately halts** the promotion path. The window does not conclude, the flag does not flip, and the item requires investigation and a documented resolution before evidence collection resumes:

- An **unsafe recommendation** in the shadow record (as defined in §5).
- **Data corruption** anywhere near the training record — a malformed write, a wrong-tab append, a schema violation.
- **Trust-loop failures** — any deviation in preview→approve→write, proof fields, undo, or idempotency, whether or not the Brain caused it.
- **Shadow persistence failures** — the evidence stream itself proving unreliable invalidates the evidence.
- **Repeated orchestrator errors** — one crash is a bug; a pattern is an engine that is not ready to be observed, let alone promoted.
- **Any regression in user-visible behavior** while in hybrid mode.
- **Anything affecting workout logging integrity** — the logging path outranks the coaching path; a coaching engine that endangers the log has failed the mission, not just the metric.

A blocker is not a verdict on the Brain's future — it is a stop sign on the current window. Fix, then re-observe.

## 8. Promotion Review

Promotion is an **explicit owner decision. Never automatic.** No threshold crossing, green dashboard, or agent recommendation flips the flag — the metrics in §5 make the owner's review *possible*; they do not make it *unnecessary*.

The owner review examines:

- **Shadow metrics** — the §5 checklist, each item with its evidence.
- **Representative examples** — a hand-picked spread of real decisions: routine ones, edge cases, the largest divergences, every out-of-tolerance case.
- **Failure patterns** — what the `ok:false` reasons and any errors say about where the Brain's competence ends.
- **Edge cases** — deload weeks, post-layoff returns, just-logged in-workout states, substituted exercises.
- **Latency** — the felt experience, not just the measured one.
- **Trust behavior** — confirmation that nothing near the write path moved.

The review answers one question:

> **"Would I trust this Brain to coach every athlete, on every one of these decisions, without Legacy standing behind it?"**

If the honest answer carries a "mostly" or an "except when," the answer is no — and the exception is the next engineering item.

**Granting promotion** means: the owner flips the serve mode for the reviewed decision type(s) only. Decision types outside the reviewed evidence stay on legacy fallback via the serve-eligibility rail. The decision, its date, the window's evidence summary, and any revised tolerances are recorded (in this document's revision history or a linked decision record) so the *next* promotion inherits precedent instead of re-deriving it.

## 9. Rollback Plan

Promotion is designed to be **trivially reversible** — that reversibility is itself a promotion criterion (if rolling back ever requires more than a configuration change, that is a P0 defect in the rollout design).

If the promoted Brain shows significant issues in production:

1. **Return to Legacy.** Revert the engine mode (single configuration change; the legacy path is byte-identity pinned and never stopped being exercised). No deploy of new code, no data migration, no schema change is involved.
2. **Keep collecting evidence.** Return to hybrid shadow, not to silence — the failure that triggered rollback is exactly the scenario the next window must cover.
3. **Fix.** Root-cause the failure; file and ship the correction as normal scoped PRs.
4. **Repeat observation.** A rolled-back Brain re-enters at §3 with a fresh window. There is no fast-track for a second attempt.

The legacy engine is not deleted, starved of tests, or allowed to rot until a promoted Brain has survived long enough — across enough varied real usage — that the owner explicitly retires it. That retirement is its own owner decision with its own evidence bar.

**Promotion is reversible. User trust is not.** Every asymmetry in this document — the conservative tolerances, the per-decision-type rail, the human review, the standing fallback — exists because of that one-way door.

## 10. Future Evolution

This document intentionally defines the **process**, not today's implementation. As Atlas evolves, the following are expected to improve and may be revised without weakening the governance:

- **Metrics** — richer divergence measures (block-level workout comparison, outcome-anchored scoring against subsequent logged performance).
- **Thresholds** — the 90% agreement floor, the tolerance bands, and the window sizes are initial calibrations; the owner may tighten or adjust them as evidence accumulates. Revisions are recorded in place, with dates.
- **Telemetry** — new shadow lanes, sampling controls, and comparison surfaces extend §4 naturally.
- **Comparison logic** — what counts as "comparable" will widen as the engine's decision types mature.

What stays stable is the philosophy: **evidence over opinion, shadow before serve, per-decision-type earning, an explicit human owner decision, and a rollback path cheaper than the mistake it undoes.** A future maintainer proposing to change *those* is proposing a Constitution-level conversation, not an edit to this file.
