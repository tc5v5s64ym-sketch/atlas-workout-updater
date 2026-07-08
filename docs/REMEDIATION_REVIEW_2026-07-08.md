# Atlas Remediation Review — Independent Engineering Assessment

**Date:** 2026-07-08
**Requested by:** Owner
**Scope:** Post-remediation trajectory review (PR-10, PR-11, #907, #908, ADD batch). Owner-requested analysis; no code changes, no PR.
**Status:** Reference (point-in-time assessment at commit `04597c6`)

---

## Executive summary

Atlas's remediation sprint worked. In roughly 48 hours (~20 merged PRs, Jul 7–8) the project fixed all three live bugs, landed the safety nets, split 1,700 lines of routes out of `index.js`, shipped a partial state store, hardened the conversation layer, and fixed 6 of 7 live-session regressions — with the seventh correctly escalated to the Decision Desk rather than silently built. The write path — the thing Atlas exists to protect — is genuinely production-quality and battle-tested.

But the remediation plan should **not** be continued verbatim to its written end. Three of its five remaining items are speculative (PR-19 SQLite cache, PR-20 Preact island) or high-risk-for-modest-benefit (PR-18 write-path router split), while the plan **omits the single worst mechanical risk in the repo** — a byte-identical, fully committed duplicate of the entire ~12.7K-line frontend (`public/` + `src/app/`) — and underweights the finding the live evidence points at most strongly: the v116 gym session surfaced **7 real state bugs that ~4,600 passing tests missed**, and the state-store migration that addresses that bug class is only ~40% complete.

**Recommendation in one line:** declare Remediation v2.1 substantially complete, cut its speculative tail, run the governance diet *now* instead of last, and pivot to a short consolidation milestone (frontend single-source, finish the state store, build a Flight-Recorder replay harness) before returning to the coaching-intelligence product track.

---

## Current project maturity assessment

| Dimension | Assessment |
|---|---|
| Write-path / data integrity | **Mature.** Preview/write dedup parity, two-layer idempotency (`write_id` replay guard + row-level composite keys), read-back-before-delete undo, header-contract drift guard, partial-failure contract. Hardened against real, documented incidents. |
| Trust loop | **Mature and well-isolated.** Satellite view layers (coach conversation, chat) delegate to `#approve-btn` and consume read-only events; they cannot write. |
| Parser | **Functional, high-complexity.** 1,457 lines, ~450 regex sites, hand-rolled cascade. Strong golden/fuzz coverage; refuses to guess on ambiguity. A maintenance liability, not a correctness one. |
| Session/conversation state | **Immature — the active risk area.** Store is an explicit partial slice (7 signals, non-reactive, live mutable refs); `sharedState.js` still carries a `TODO(PR-10/PR-11)`; every ADD fix added another ad-hoc flag outside the store (e.g. `coachDiscussionSinceLog`). |
| Frontend architecture | **Fragile at scale.** `public/app.js` is 6,654 lines / 194 functions; the whole frontend tree is committed twice. |
| Backend service layer | **Sprawling.** 132 service modules for a single-user app, with visible near-duplicate pairs and a known orphan problem (wiring CI exists because of it). |
| Test suite | **Broad but not deep where it matters.** ~4,600 cases / 57K LOC — larger than the source — yet all 7 v116 bugs escaped it. No coverage instrumentation. Fragile `require.cache` stub pattern. |
| Process/governance | **Disciplined but heavy.** ~150 markdown files / ~18K doc LOC, a 526 KB `BACKLOG.md`, dual escalation policies carried in full, and live contradictions between docs and code. |

**Phase verdict:** Atlas has exited the "stabilize" phase. It is mid-way through two straddled migrations (state store, exercise identity) and should enter a **consolidation** phase, not more remediation and not yet new product surface.

## Health score: 7 / 10

- Trust/write core: 9
- Test effectiveness (not volume): 6
- Frontend/service architecture: 5
- Process & docs hygiene: 6
- Velocity & automation: 8 (with a gate-erosion caveat, below)

---

## Biggest strengths

1. **The write path.** `POST /api/log-workout` and `undo-last` in `index.js` are the work of a system that got burned and hardened: shared `partitionLogRowsByExisting` enforcing preview/write parity (traceable to a real "30 previewed / 22 written" failure), idempotency that survives client-minted `write_id`s, undo that read-backs `session_id` ownership on every target row before deleting. Do not rewrite this.
2. **The live-evidence loop.** One owner gym session (v116) produced `docs/PR10_REGRESSION_ADDENDUM.md` — 7 concrete, named bugs — which became 6 merged regression-locked fixes and 1 correctly escalated decision within ~24 hours. Most teams never build a loop this tight.
3. **Safety-invariant culture.** Frozen-enum LLM sanitizers in `services/coach.js` (~20 `sanitize*` functions), "engine owns the numbers," the inertness guard test on the identity bridge, the "skipped review = FAILURE" principle, the Decision Desk instead of silent scope creep (ADD-3 → #914).
4. **Tiny, current dependency set** (express, googleapis, openai, @google/genai, multer, dotenv) and a real CI belt: lint, wiring check, secret scan, e2e.
5. **The regression-lock habit.** Every ADD fix shipped with tests that pin the bug shut (`identityCorrectionWiring.test.js` +162, etc.).

## Biggest weaknesses

1. **The duplicated frontend tree.** `src/app/` and `public/` are 25/25 byte-identical committed copies (~12.7K LOC duplicated). `vite.config.js` confirms this is a "Stage-1 pass-through" with no scheduled end. ADD-5's diff touched both `app.js` copies (+61 each). Every frontend PR doubles its diff and one missed mirror produces silent divergence between what's reviewed and what's served. **This is not on the remediation plan at all.**
2. **`public/app.js` at 6,654 lines**, plus three more files over 1,400 lines (`analytics.js` 2,760, `coach-conversation.js` 2,088, `coach.js` 1,434).
3. **The half-finished state store.** PR-10 consolidated ~180 scatter sites into a 170-line store — but only the session/plan slice, non-reactive, handing out live mutable references. The v116 bug class (restored-pin, skip-state, substitution-slot, identity-targeting, recap reconciliation) is precisely scattered-state disease, and the fixes so far are point patches adding *more* scattered flags.
4. **Service sprawl:** 132 modules with near-duplicate pairs (`objectiveScorer.js`/`objectiveScoring.js`, `expectedPerformance.js`/`expectedPerformanceModule.js`, a whole `*Module.js` shadow family) and 3 modules no test imports.
5. **Docs-as-program staleness.** In an agent-driven repo, the docs are executable context — and they currently contain live contradictions: Invariant **W7 says undo ≤10 rows while the code caps at 200** (flagged as WRITE-4, unreconciled); `REMEDIATION_PLAN_V2.md` says "29 PRs / 8 phases" while `DOCS_INDEX.md` and `BACKLOG.md` say "25 / 7"; the plan's status/calendar sections lag the backlog by a full phase; `OWNER_CHECKIN_RULES.md` carries the superseded Escalation Policy v2 in full alongside v3.

## Biggest risks

1. **Trust erosion from the session-state bug class.** ADD-5 was one utterance away from silently corrupting a completed Bench Press in the permanent record. The class is only point-patched; until session state is store-owned and recap/skip/substitution are *derived* from it, each live session risks minting a new variant.
2. **Merge-gate erosion at sprint velocity.** ADD-5 (#909) is labeled `trust-sensitive` yet its merge card records "Codex status: not-run (pending CI)" and "Claude status: not-run" — merged 21 minutes after opening. That directly contradicts `AUTOMATION_PROTOCOL.md`'s own pass/fail principle ("a review that was skipped… is a FAILURE, not a pass"). At 20 PRs per 48 hours the gates exist on paper and get skipped in practice. Also notable: ADD-5's *first* test only passed because it hand-injected state the real flow never produces — the review-fix commit caught it, but that is exactly the failure mode unreviewed trust-critical merges invite.
3. **Silent frontend divergence** (weakness #1 as an ongoing hazard, not just debt).
4. **Test mass without measured effectiveness.** 57K LOC of tests is a maintenance drag that creates false confidence — the suite's size did not prevent any of the 7 live bugs, and nothing measures what it actually covers.
5. **Google Sheets write quota as an unbudgeted shared resource.** The Flight Recorder incident (telemetry appends exhausted the 60/min quota and 500'd a real save mid-session) was fixed by batching, but nothing systemic prevents the next feature from re-creating it, and the SIGTERM-flush follow-ups are still open.

## Highest-leverage opportunities

1. **Flight-Recorder replay harness.** The single best QA instrument Atlas has is an owner gym session — one session outperformed 4,600 tests. The Flight Recorder already records the user-visible experience and decision trail for replay. Building a harness that converts recorded sessions into permanent regression fixtures turns every workout into an accumulating integration-test corpus. This is the highest-ROI testing investment available, and it makes future refactors (PR-18, any store work) verifiable.
2. **Finishing the state store** kills the dominant bug class *and* organically shrinks `app.js` — the approach PR-09's failed extraction proved is the only viable one (the coupling *is* the trust loop; you can't extract around it, you can drain state out of it).
3. **Governance diet done first, not last.** Every agent session pays the doc corpus as context cost and inherits its contradictions as potential bugs. PR-21 is the cheapest item in the plan with compounding returns; scheduling it terminal was backwards.

---

## Answers to the review questions

### 1. Is the remediation plan still the correct plan?

It **was** correct, and ~85% of it is executed. I would materially change the remainder:

- **Cut PR-20** (Preact island for the coach conversation). A framework migration for a working surface in a single-user app is speculative. The stated prereq ("stable through at least two real gym weeks") hasn't elapsed; the store it must "read/write exclusively through" isn't finished. Nothing user-facing improves. Re-file as evidence-gated with a concrete trigger (e.g. a conversation-UI feature the vanilla layer demonstrably can't carry).
- **Keep PR-19 dormant.** Its own trigger (slow dashboards / >5k rows / 429s) hasn't fired. The plan already gates it correctly — the change is simply: don't schedule it, and resist the pull to build it because it's interesting.
- **Demote and re-gate PR-18** (write-path router split). It touches the single highest-risk file to achieve a mechanical reorganization of code that already works and is already the best-tested in the repo. Do it, if at all, *after* a replay harness exists to verify behavior-identity, with the verbatim-move discipline the prompt already specifies.
- **Promote PR-21 (governance diet) to immediate** and fold in the W7 invariant reconciliation and the stale-plan-doc cleanup.
- **Add the missing item: frontend de-duplication.** Make `public/` pure build output (gitignored, built at deploy) or collapse the trees; either way, one committed source of truth. Evidence: 25/25 byte-identical files, dual-touch diffs in ADD-5, an explicitly open-ended "Stage-1" in `vite.config.js`.

### 2. Are we solving problems in the right order?

Historically, yes — live bugs → safety nets → plumbing → extraction was the right sequence, and shipping PR-13's wiring CI before pruning was smart. Going forward, no: the plan's remaining effort points at speculative infrastructure while the live evidence (v116) points at session state. Highest-leverage order from today: governance diet → frontend dedup → state-store completion → replay harness → identity PR-B → GATE A evidence. (The first two are days, not weeks.)

### 3. Has the project crossed an architectural milestone?

**Yes.** The 6.5/10 external-review findings that motivated the plan are substantially addressed: ESLint/CI belt, idempotency, route extraction (PR-16/17), parser alias data (PR-14/15), conversation hardening (PR-11), orphan guard (PR-13). The write path was already strong and is now stronger. The correct shift is from *remediation* (fixing what the review found) to *consolidation* (finishing the two migrations remediation started and left straddled: state store ~40%, identity bridge inert-data-only), and then back to the product track — the One-Brain observation window and the GATE A promotion decision, which is the actual product bottleneck.

### 4. What major risks is the plan missing?

Listed fully under "Biggest risks" above. In plan terms: (a) frontend duplication has no owning PR; (b) no cadence rule pairs autonomous merge batches with an owner live session before the next batch — the one instrument proven to find what tests miss; (c) no coverage instrumentation exists to distinguish the 57K LOC of tests that earn their keep from those that don't; (d) no central Sheets write-budget abstraction post-FR-incident; (e) no mechanism keeps invariants and code reconciled (W7 has been false in the repo for days — an INVARIANT, the document class agents are told never to violate).

### 5. What would I build next? (Top 10)

| # | Initiative | Impact | Effort | Risk | Dependencies | Why now |
|---|---|---|---|---|---|---|
| 1 | **Frontend single-source** (`public/` becomes build output; deploy runs `vite build`) | High | Low | Low (byte-identical copy verified by CI diff) | Deploy pipeline tweak | Every frontend PR pays the duplication tax today; divergence risk compounds |
| 2 | **Complete the PR-10 state store** (all session state store-owned; recap/skip/substitution *derived*; retire ad-hoc flags incl. `coachDiscussionSinceLog`; fold `sharedState.js`) | High | Med-High | Med | #1 (halves the diff) | Directly attacks the v116 bug class; only viable path to shrinking `app.js` |
| 3 | **Flight-Recorder replay harness** (recorded live sessions → regression fixtures; start with the 7 addendum cases) | High | Med | Low (read-only telemetry) | FR production enable (owner) | Converts the proven-best QA instrument into permanent automation; unblocks safe refactors |
| 4 | **PR-21 governance diet, now** + W7 reconciliation + stale-doc sweep + byte caps | Med-High | Low | Low | Owner one-liner for W7 | Docs are agent context; contradictions are live bugs; cheapest compounding win |
| 5 | **GATE A evidence package** (One-Brain shadow-window analysis vs. `ONE_BRAIN_PROMOTION_CRITERIA.md`) | High (product) | Low-Med | Low | Observation window data | The owner decision is the product bottleneck; unblocks PR-12A/B |
| 6 | **Identity bridge PR-B** (lift-code read path) | Med | Low | Low | None (PR-A shipped) | Keeps unification moving through its only non-owner-gated step |
| 7 | **Service pruning** (orphans + near-duplicate pairs, via existing `check:wiring`) | Med | Med | Low | None | 132 modules is drag on every agent search; tooling already exists |
| 8 | **Central Sheets write-budget module** + FR SIGTERM flush | Med | Low | Low | None | Systemic fix for the quota-exhaustion class, not just the FR instance |
| 9 | **PR-18 write-path router** (verbatim move) | Low-Med | Med | **High** | #3 strongly recommended first | Only for maintainability; sequence after replay coverage exists |
| 10 | **Coverage instrumentation + test rationalization** | Med | Med | Low | None | Distinguish real coverage from mass; prune the drag |

### 6. What should we stop doing?

- **PR-20** — cut (see Q1).
- **PR-19** — leave dormant until its own trigger fires.
- **Unbounded autonomous sprint batches.** Institute a cadence rule: after each merged batch that touches session state or the conversation layer, the next batch waits for one owner live session (or, once #3 exists, a replay-suite pass). v116 is the proof this gate finds what CI cannot.
- **Carrying superseded policy text.** Escalation Policy v2 should be a one-line pointer, not a full inline copy.
- **Growing `BACKLOG.md`** — enforce the PR-21 byte caps in CI.
- **The `*Module.js` shadow family** — pick a winner per pair and delete the loser (item #7).

### 7. Does the remediation plan end in the right place?

The terminal *item* is right (governance diet); its *position* is wrong — it should run first among the remaining work, not last. The plan should **terminate early**: after PR-21 + frontend dedup + W7 reconciliation, declare Remediation v2.1 complete. PR-12A/12B move to the product track (they are gated on GATE A, a product decision, not technical debt). PR-18 becomes an optional, replay-gated housekeeping item; PR-19/PR-20 become evidence-gated backlog lines. What replaces it: a short **Consolidation & Product Return** roadmap (the M-CONSOLIDATE milestone below), then the One-Brain era resumes as `ACTIVE_ROADMAP.md` already frames it.

### 8. Long-term architecture (one year out)

Mostly, yes — I would still build Atlas this way, with three qualifications:

- **Sheets-as-DB remains correct** for one user whose trust contract is "the sheet is the record." PR-19's trigger is the honest escape hatch; don't preempt it.
- **Vanilla JS remains viable only if `app.js` shrinks.** The cheap-now move is #2 (drain state into the store); the expensive-later alternative is a framework rewrite under pressure. PR-09's failure already demonstrated big-bang extraction doesn't work here.
- **Don't rewrite the parser; route around it.** A 1,457-line regex cascade with 450 match sites is at its complexity ceiling, but it works and is golden-tested. The long-term shape is already in flight: a small deterministic grammar core for slash-notation sets + the NL Intent Router (currently in shadow) for everything conversational — let GATE A evidence decide the promotion. The one identity decision that matters for the next year is already right: **`lift_code` as the immutable join key** (the unification plan's linchpin). Hold that line and the PR-C…F sequence stays cheap and reversible.

Things that are cheap now and expensive in a year: frontend dedup (#1), store completion (#2), replay harness (#3). Everything else — Preact, SQLite, parser evolution, even multi-user someday — gets cheaper once those three are done.

---

## Recommended roadmap adjustments (delta, in order)

1. Close out Remediation v2.1 early: run PR-21 now (+ W7 amendment, stale-doc sweep, 25-vs-29 fix); add and execute the frontend-dedup item; mark the plan complete.
2. Open **M-CONSOLIDATE** (below).
3. Move PR-12A/B under the product track, gated on GATE A; prepare the GATE A evidence package.
4. Re-file PR-18 (replay-gated, optional), PR-19 (trigger-gated, unchanged), PR-20 (cut → evidence-gated backlog line).
5. Add the cadence rule: no consecutive autonomous batches on session-state/conversation surfaces without an interleaved owner live session or replay-suite pass.

## Recommended next engineering milestone — **M-CONSOLIDATE**

Definition of done:

- One committed frontend tree; `public/` is build output; CI proves the served app is byte-identical to the built source.
- Session state 100% store-owned; recap/skip/substitution derived from the store; ad-hoc flags retired; `sharedState.js` folded.
- All 7 v116 addendum cases exist as replayable Flight-Recorder fixtures and run in CI.
- Docs corpus under PR-21 byte caps with zero known code/doc contradictions (W7 reconciled).
- GATE A evidence package delivered to the owner.

Estimated shape: 8–12 tiny PRs, no owner gates except the W7 one-liner, the FR production-enable, and the GATE A decision itself.

## Final recommendation

**Atlas is on the right trajectory, and the remediation investment paid off — but do not continue the plan verbatim.** The plan's remaining tail optimizes for problems Atlas doesn't have yet (scale, framework ergonomics) while the live evidence points at problems it demonstrably does have (scattered session state, a duplicated frontend, doc drift, and review gates that skip under sprint velocity). Declare remediation complete, spend a short consolidation milestone finishing what it started, convert live sessions into a permanent regression corpus, and then return the engineering budget to the product bottleneck: the One-Brain promotion decision. The write path — the heart of the trust contract — needs no rescue; protect it by refactoring around it only when replay coverage can prove behavior-identity.
