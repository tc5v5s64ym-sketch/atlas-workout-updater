# Phase 4 — readiness report (2026-07-29)

Successor to [`PHASE_4_OWNER_GATE_HANDOFF.md`](PHASE_4_OWNER_GATE_HANDOFF.md) (2026-07-24) and to the
gate-run-1 evidence in [`PHASE_4_GOLDEN_SESSION_EVIDENCE_2026-07-25.md`](PHASE_4_GOLDEN_SESSION_EVIDENCE_2026-07-25.md)
(verdict **NOT YET**).

This report states what moved since gate run 1, what still blocks the gate, and the exact owner action.
It selects no work, reorders no phase, and changes no gate. Documentation only.

**Phase 4 remains OPEN. Phase 5 does not begin. `SESSION_PLAN_SETS_WRITE_ENABLED` stays `0`.**

---

## 1. Exact state

| Item | Value |
|---|---|
| `main` | `013ddc9` |
| Deployed and live | `013ddc9083c6` — deploy finished `2026-07-29T07:06:31Z` |
| Node suite | **6792 pass / 0 fail / 0 skipped** |
| Playwright | 242 |
| Deterministic gates | 8, all pass |
| `SESSION_PLAN_SETS_WRITE_ENABLED` | **`0`** — verified read-only against Render on 2026-07-29 |
| `ATLAS_TURN_PRECEDENCE` | **`1`** — enabled, under the standing owner authorization recorded in the execution plan (2026-07-25) |
| `ATLAS_INTERACTION_TRACE` | `shadow` |

No flag was changed by this run. No Render resource was modified. No Sheet write occurred.

## 2. Merged since gate run 1

All `auto-safe`, all green on the exact merged head, all advisory findings dispositioned before merge.

| PR | Merge SHA | Concern |
|---|---|---|
| #1183 | `83ae57d` | the confirmed-empty seal reports `sealed_ok`, so a write-disabled posture stops reading as `seal_not_verified` |
| #1185 | `0f67e57` | fail-closed finalized-undo guard — an undo after a finalized closeout is refused, and an unverifiable check is `unknown`/503, never `false` |
| #1188 | `2cc8b0d` | the set-level revision capture entry point (#1163 proof 1) |
| #1191 | `013ddc9` | the prescription-only proposal lane — propose → explicit approve → revise (#1189) |

Issue **#1165 closed complete** on merged-main artifact evidence. That matters for criterion 7 below.

### Advisory findings fixed before merge (all real)

- #1183 — a `test_mode` seal reason was producer-impossible; narrowed to `write_disabled` only.
- #1185 — case-sensitive `session_id` against a case-insensitive route ownership check (a full guard
  bypass); malformed rows with a blank `plan_version` silently dropped by the fold.
- #1188 — borrowed consent ("I can't say yes yet" contains `yes`); a no-op emit reported as captured.
- #1191 — a proposal survived a substitution of its own slot (`applySessionSubstitution` preserves both
  `plan_item_id` and `plan_version`); no-op and RIR-only proposals accepted because the check tested
  presence rather than change.

No test was weakened to accommodate an implementation.

## 3. The seven gate criteria, restated against current `main`

Gate run 1 (2026-07-25) recorded criteria 1–2 holding, 3 as observation not consumption, 4–6 open/partial/
half-proven, and 7 unmeetable. Current state:

| # | Criterion | Gate run 1 | Now |
|---|---|---|---|
| 1–2 | H-03 — recommendation-explanation and recovery-routing consume the canonical decision | live-proven | unchanged, holds |
| 3 | H-08A — `packet.session` consumed by the live response | observed, not consumed | **still not consumed** — see §4 |
| 4 | D10 — discussion referent | open | **still open**, and dependent on criterion 3 — see §5 |
| 5 | H-09 — planned-vs-actual capture of an endorsed set-level revision | partial | **proofs 1 and 2 delivered** (#1188, #1191); proof 3 needs the flag |
| 6 | closeout and seal, both directions | forward once, reverse unproven | **reverse now has a tested contract** (#1185); forward seal honesty fixed (#1183) |
| 7 | one trace spanning first word → sealed write | blocked on the #1165 correlation seam | **unblocked** — #1165 closed complete; unproven live |

## 4. Criterion 3 — a correction to an earlier reading

An earlier note in this campaign reported that the live coach route neither builds nor reads a packet,
on the strength of a grep against `index.js`. That grep was against the wrong file. **The coach route is
`routes/coachOps.js`.** The accurate picture:

- The route **does** build a canonical `WorkoutSession` — `buildCanonicalSessionSnapshot(clientCtx)`
  at `routes/coachOps.js:1372`, gated on `ATLAS_TURN_PRECEDENCE`, which is enabled in production.
- Two **live, visible** answers consume it: "are we done?" (`buildSessionCloseAnswerFromSession`,
  H-08C, landed `f6e370e`) and "what's next?" (`buildNextUpAnswerFromSession`, H-08B, landed `befa44a`).
- What the route does **not** do is consume the **CoachTurnPacket**. It builds session truth
  route-locally, and the shadow lane builds a second, independent copy.

So gate run 1's wording — `packet.session` is observed and schema-valid but unconsumed — is correct and
remains correct. The remaining work is **retiring the duplicate route-local build so the packet is the
single source**, not introducing session consumption from zero. That is the Phase 4 headline work
("make the live coach route consume the CoachTurnPacket, retiring route-local recomputation"). It is not
a small change and was not attempted here.

## 5. Criterion 4 — why no bounded slice was taken

The referent lane is live-wired: `routes/coachOps.js:1513` reads the freshness-bounded referent and
`:1525` records the turn's referent, backed by `services/coachDiscussionReferent.js` and resolved through
`coachResponseGrounding.resolveDisputedLiftEntry`.

Three candidate slices were examined and each was rejected on its merits:

1. **Widen the read side** so a bare non-dispute follow-up ("why that weight?", "drop those") binds to the
   referent. The referent is currently read **only** on a dispute turn. Widening it means deciding new
   deterministic answers for new turn classes — new coaching surface, which is owner-reserved.
2. **Widen the record side** by recording the lift Atlas's own reply named. This requires parsing Atlas's
   generated prose to recover identity, which the engine/LLM boundary forbids. Trust-regressive.
3. **Pass the referent into the live snapshot build**, since `buildCanonicalSessionSnapshot` already
   accepts `discussion_referent` and the shadow lane already passes it. Rejected twice over: the referent
   is computed at line 1513 while the snapshot is built inside `deterministicAnswer`, which is invoked at
   both line 1427 (**before** the referent exists) and line 1672 (after) — so the field would be
   truthful on one path and null-for-ordering-reasons on the other, exactly the dishonest-flag shape
   Drift Guard 5 exists to catch. And no answer builder reads the field, so it would change nothing
   visible.

**Conclusion: no genuinely bounded slice of criterion 4 exists that does not depend on criterion 3.**
Per the run mandate, criterion 3 was not started on a whim.

## 6. What still gates the owner

Two are code work; one is the gate itself.

- **Criterion 3** — the packet-consumption retirement. Headline Phase 4 work, unstarted.
- **Criterion 4** — depends on criterion 3; the punch list's own fix ("set `discussion_referent` on the
  packet/WorkoutSession at answer time so the resolver collapses to a single state read") presupposes it.
- **The Approve / Reject / Ask-Why affordance is unbuilt.** The #1189 lane on `main` is reachable by the
  UI layer, but no card renders it and no in-conversation trigger opens a proposal, so an ordinary
  session never exercises it. PR #1192 — an unmerged parallel duplicate of #1189, based on the now-stale
  `2cc8b0d` and reported `dirty` — carries a candidate card and trigger; the triage comment on that PR
  proposes reducing it to that delta rather than rebasing 1,063 lines of duplicate implementation.

## 7. The exact owner action

**Gate script (a), verbatim from the execution plan:**

> "Everything is staged. Set `SESSION_PLAN_SETS_WRITE_ENABLED=1` on Render, then say go."

**Gate script (b), after the gate workout:**

> "Tell me: pass or not yet; what held up or didn't in the transcript and trace; and your Issue #952
> ruling — close, supersede, or rewrite."

The #952 ruling was made at gate run 1 (close as completed); (b) stands as written.

### The exact Render change

One environment variable, on service `srv-d86vs9f7f7vs73b1smdg`:

```
SESSION_PLAN_SETS_WRITE_ENABLED : 0 → 1
```

`ATLAS_TURN_PRECEDENCE` is already `1` and needs no change. Nothing else is touched.

### The Golden Session script

The reusable fixture is `test/fixtures/goldenSession.js`. Beats, in order:

plan from history → accept → log exercise 1 routine (×2, silence) → ask "why?" → log exercise 2 opening
set (silence) → redline top set (safety surfaces) → fatigue substitution (acknowledged) → revise →
close out once → seal → reload → review.

Run as a normal session. One addition worth attempting this time, because it is what criterion 5's third
proof needs: at the **revise** beat, endorse a **load or rep change that keeps the movement** rather than
a movement swap.

### Expected rows and fields

| Tab | Expect |
|---|---|
| `Session_Plans` | `plan_accepted` (with `outcome:'planned'` and a `planned_lift_code` per item), one `item_outcome` per movement, exactly one `session_closeout` with `closeout_status:'finalized'`. Append-only, deterministic idempotency key. |
| `Session_Plan_Sets` | planned-set checkpoints for the accepted plan, and — if the set-level endorsement is exercised — **one revision row** carrying the new prescription with `planned_lift_code` **unchanged**. This row is criterion 5's third proof and cannot exist while the flag is `0`. |
| `Log_Cleaned` | one row per logged set, 12 columns, `volume_calc` populated. |
| `Coach_Shadow` | one `[coach-turn-shadow]`-derived record per coach turn, carrying the packet, its embedded-presence flags, and the route's referent pick. |
| `Flight_Recorder` | the session transcript — one row per event, keyed by `flight_session_id`. **It carries no `turn_id`** (`docs/FLIGHT_RECORDER_SPEC.md` §1, `config/columns.js`), so it is not where criterion 7 is verified. |

**Criterion 7 is verified off-tab, not on `Flight_Recorder`.** Run `npm run atlas:turn-write-artifact` over
the captured deployment log: it joins the `[interaction-trace]` and `[turn-write-proof]` records under one
canonical `turn_id`, which is the seam #1165 closed on. `Flight_Recorder` is the transcript alongside it.

### Expected visible responses

A live gate session runs **model-up**, so state the two cases separately. Expecting a deterministic
"what's next?" from a configured model would fail the gate on behaviour the route is designed to have.

- **Model-up (the normal gate session).** "what's next?" and "are we done?" reach the coach and return
  `source:'gemini'` — the model's richer answer is deliberately not overridden
  (`test/api-smoke.test.js`: *"turn precedence ON, model UP: 'what's next?' still reaches the coach — no
  model-up regression"*). What to check here is that the model's answer **agrees with session truth**,
  not that it is deterministic.
- **Model-down (the fallback path, where H-08B/H-08C live).** "what's next?" answers `Next up: <slot>.`
  and "are we done?" answers from the canonical session's own slots, both `source:'engine'` — instead of
  the pre-flag dead-end to "coach unavailable". `deterministicAnswer` is reached only on the
  unconfigured path (`configured:false`) and the model-threw/empty-reply fallback.
- A factual plan dispute is answered from the current plan with the model bypassed **in both cases** —
  that lane is fail-closed by design, independent of model availability — and states plainly that
  nothing was changed.
- A redline top set surfaces the safety decision ahead of stylistic voice.
- An undo attempted **after** the closeout is finalized is refused: *"This workout has already been
  completed and saved, so Atlas cannot undo it. Nothing was changed."* If finality cannot be verified,
  Atlas says so and refuses rather than guessing.

### Rollback

Both flags are pure environment toggles. No deploy, no revert, no code change.

- `SESSION_PLAN_SETS_WRITE_ENABLED` → `0`: every planned-set checkpoint and seal returns to dry-run,
  proving `sheet_written:false` / `no_write_confirmed:true`.
- `ATLAS_TURN_PRECEDENCE` → unset: the live route reverts to the signals/snapshot path.

### Cleanup after the run — decide this *before* starting, not after

Gate run 1 was a **mock**, and its temporary `Log_Cleaned` rows were removed through the verified undo.
That option no longer exists at the end of a completed run, and the change is this report's own doing:
the Golden Session ends `close out once → seal`, and the #1185 guard refuses an undo once a closeout is
finalized. After the final beat there is **no undo path**, by design.

So the two runs are now genuinely different procedures, and the choice is the owner's:

- **A real gate workout** — the intended run. The rows are real training data and **stay**. Nothing to
  clean up; the finalized closeout is the correct end state.
- **A mock or rehearsal** — undo **before** the closeout is finalized, which means deliberately stopping
  short of the `close out once → seal` beats and accepting that criterion 6's forward seal and criterion
  7's sealed-write trace are **not** exercised. A mock that runs to completion leaves its rows in
  `Log_Cleaned` permanently.

There is no third option. Removing rows after a finalized closeout would require a manual Sheet edit,
which agents never make and which is owner-reserved in any case.

### Stop conditions during the gate

Stop and report immediately on: a production data-integrity anomaly of any kind; a write without a
matching preview and approval; a seal that reports success without positive row evidence; a coach reply
claiming a write, a number, or a history it cannot ground; or a trace that cannot be joined to its turn.

## 8. PASS / NOT YET checklist for Phase 5

Phase 5 begins only when every line is checked.

- [ ] The owner says **pass** on a live Golden Session (gate script b).
- [ ] One reviewable trace spans first word → sealed write, packet and trace sharing one turn id.
- [ ] `packet.session` is consumed by the live visible response; the route-local recomputation is retired.
- [ ] The discussion referent is carried on the packet at answer time, and the in-memory store plus the
      history scan retire.
- [ ] One durable `Session_Plan_Sets` revision row exists for an endorsed set-level change, and a replay
      shows the revised prescription as planned truth for the sets that followed (#1163 proof 3).
- [ ] The closeout seal holds forward, and the finalized-undo refusal holds in a real session.
- [ ] `npm run atlas:divergence` over the gate session's records reports no unexplained bypass.
- [ ] No capability claims `live_proven` without a linked trace id (Drift Guard 4).
- [ ] `SESSION_PLAN_SETS_WRITE_ENABLED` is returned to `0` if the gate verdict is not yet.

## 9. Production safety

- No production flag was enabled or changed by this run; the two flag values above were **read**, not written.
- No Render resource was deployed, restarted, suspended, or modified.
- No Sheet write, no manual Sheet edit, no schema change, no migration, no proof-field change.
- No preview → approve → write change.
- No raw production logs, secrets, Sheet IDs, or workout data are committed here.
- `npm run audit:finalized-orphans` has still **never been run against production** — it needs credentials,
  and its unrun state is `UNKNOWN`, not "none found".
