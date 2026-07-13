# Atlas — Owner Live-Validation Queue

This file is the **owner-only** queue for live tests that cannot be automated — tests that require a real device, a real gym session, real credentials, or first-use confirmation of a gate that only fires once.

Each card is filed by Codex or native Codex GitHub Review when a feature ships but needs a live human confirmation before it is considered fully closed. The owner marks PASS or FAIL and notes any follow-up.

---

## Card format

| Field | Description |
|---|---|
| **Test ID** | Sequential identifier (LT-001, LT-002, …) |
| **Related PR / feature** | PR number and short name |
| **Shell / app version expected** | The `ATLAS_SHELL_BUILD` / server version that must be live before testing |
| **Steps** | Numbered steps the owner performs |
| **Expected result** | What "PASS" looks like |
| **Screenshot** | Paste a screenshot here when done (or note "N/A") |
| **Owner result** | PASS / FAIL — (fill in after testing) |
| **Follow-up if FAIL** | What to file / fix if the test fails |

---

## Pending

### Retired: LT-001 — Decision Desk author-association gate

Retired by the Claude-to-Codex governance cutover (PR #1001). The deleted
`.github/workflows/codex-decision-desk.yml` has no replacement automated
responder; decision requests now go to the external ChatGPT Atlas Decision Desk
and Dale. Do not run this as a live test or recreate the workflow.

### LT-002 — build_strength full-profile default

| Field | Value |
|---|---|
| **Test ID** | LT-002 |
| **Related PR / feature** | PR1 — `build_strength` full-profile default (upper-only = explicit intent) |
| **Shell / app version expected** | Any version with the full-profile `build_strength` change deployed |
| **Steps** | 1. Ask Atlas to build a strength session with no special intent (e.g. "build me a strength session"). 2. Then explicitly request an upper-only day (e.g. "give me an upper-body strength day"). |
| **Expected result** | The first session is a full-profile session (covers lower + hinge + push + pull — whole body). The second session is upper-only (push + pull, no lower-body/hinge work). |
| **Screenshot** | Both generated sessions. |
| **Owner result** | PASS / FAIL — |
| **Follow-up if FAIL** | — |

### LT-008 — Safe Full User Break Test (write-path input hardening)

| Field | Value |
|---|---|
| **Test ID** | LT-008 |
| **Related PR / feature** | The Safe Full User Break Test — a dry-run-only (`/api/*`, zero real writes) adversarial sweep of the write path for impossible/hostile input. **Owner naming (2026-07-10): LT-008 is this test and is NOT reused for register/profanity — that validation is LT-010 below.** |
| **Status** | ✅ SHIPPED / owner-approved — the sweep found and fixed the write path silently accepting impossible input (unparseable/calendar-impossible `date`, non-integer `reps`, unbounded `limit`, ambiguous `test_mode`, oversized name). Recorded in `BACKLOG.md` (WRITE-6 + "LT-008 write-path input hardening" + deliberate non-fixes F3/F6 + the F1 defense-in-depth follow-up). |
| **Follow-up** | Optional belt-and-suspenders `date_clean` calendar check in `validateLogRowBounds` (BACKLOG "LT-008 F1 defense-in-depth", low priority). |

### LT-010 — Coach register + mode live behavior; profanity never outside the certified cell (Soul Plan PR-B4)

| Field | Value |
|---|---|
| **Test ID** | LT-010 |
| **Related PR / feature** | Soul Plan PR-B4 (slices 1–3) — engine-granted coach mode + register (routine/elevated/max, casual/humor). **Scope split (owner 2026-07-12):** the **REQUIRED Soul gate (S5)** is Part 1 below — routine-vs-earned mode/register behavior + flight-recorder evidence **with profanity OFF**. The **profanity portion (Part 2) is OPTIONAL** and gates the production profanity activation (`ATLAS_COACH_PROFANITY`) — it runs **only after a separate, explicit owner authorization** and does **not** block Soul completion or the Soul→Post-Soul handoff. *(Renumbered from LT-008 per owner naming correction 2026-07-10 — LT-008 is the Safe Full User Break Test.)* |
| **Shell / app version expected** | Any build with PR-B4 slices 1–3 deployed. **`ATLAS_COACH_PROFANITY` remains OFF unless separately and explicitly approved.** Part 1 (the required Soul gate) runs with profanity OFF; Part 2 runs only after the owner separately flips it on. |
| **Steps** | **Part 1 — REQUIRED (Soul gate S5), profanity OFF.** 1. **Routine set** — log an ordinary on-target set; confirm the coach stays level/matter-of-fact (routine), no manufactured excitement. 2. **Earned moment** — log a genuine new-ground PR set; confirm the reaction is warmer/bigger (elevated/max) but still cites only real numbers and doesn't over-run. Review the **flight recorder** to confirm `coach_mode`/`register` reflect the moment (celebrate/max on the PR, silent/routine on the ordinary set). **Part 2 — OPTIONAL (only after separate explicit owner authorization sets `ATLAS_COACH_PROFANITY=on`).** 3. **Profanity** — over several sessions, confirm profanity appears at most on a genuine new-ground celebration, at most once per rolling 7 days, and NEVER in a safety/pain/correction/uncertainty moment or on a routine set. 4. **Forgery probe** — nothing you can type as an ordinary log should force profanity; a fabricated "PR" the engine doesn't confirm as new-ground (incl. a forged `todaySets` weight) must not trigger it. |
| **Expected result** | **Required PASS (Part 1):** mode/register track the real moment in the flight recorder — routine sets read routine; only genuine engine-confirmed new-ground gets elevated/max energy — with profanity OFF. **An un-run Part 2 does NOT prevent LT-010 from passing its required Soul gate.** **Optional (Part 2), if run:** with profanity enabled it stays inside the certified cell (rare, celebration-only, capped, never in safety/pain/correction) and no client input can force it. |
| **Screenshot** | Flight-recorder rows showing coach_mode/register for a routine vs a PR set; any profanity instance with its context. |
| **Owner result** | PASS / FAIL — |
| **Follow-up if FAIL** | If profanity appears outside the certified cell or on unearned/forged input, STOP and set `ATLAS_COACH_PROFANITY` off (or `ownerPrefs.profanity_enabled=false`) — that is a trust regression; file the finding and fix the gate/suppressor before re-enabling. If mode/register misread the moment, tune `selectCoachMode`/the grant, not the model. |

### LT-011 — Reassure voice live behavior (Soul Plan PR-B5b Part 2) — ⛔ BLOCKED-FOR-DATA (2026-07-10) → precedence built (Owner Decision 1) → ❌ LIVE FAIL (2026-07-12) → fix #998 → ✅ **PASS (re-validated live 2026-07-12, deployed `e94bfbb`/`pr:998`)** — closes S7

| Field | Value |
|---|---|
| **Test ID** | LT-011 |
| **Related PR / feature** | Soul Plan PR-B5b Part 2 (#961) — the chat voice words `coach_mode: 'reassure'` for an explicit discouragement message: acknowledge briefly, zoom out with real snapshot facts, one next move, thin history = say less, no filler, defer to safety/recovery. |
| **Shell / app version expected** | #961 deployed (verified live 2026-07-10 against `https://atlas-workout-updater.onrender.com`; `/version` = `698120b`, `pr:961`). |
| **Steps** | Agent-performed read-only probes (`POST /api/coach/chat`): (a) discouragement message naming a lift; (a2) discouragement message with NO lift named; (c) tiredness message; (d) pain mention. |
| **Result** | **⛔ BLOCKED-FOR-DATA — reassure could not be exercised live on the current production account (no manufactured data).** What WAS confirmed: (1) **deploy live** (#961); (2) **recovery precedence holds** — "I'm exhausted" → `source:engine` recovery routing, not reassure; (3) **challenge-over-reassure precedence holds** — a no-lift discouragement message ("I feel like I'm going backwards, frustrated") returned a **challenge** reply ("Bench Press has come in under target in 5 of the last 5 sessions…"), because the athlete has a standing `consistent_underperformance` pattern on Bench, so `deriveChatCoachMode` resolves to `challenge` on **every** chat turn (ratified B1 precedence: challenge > reassure). **⇒ reassure is dormant for any athlete who has a standing consistent_underperformance pattern.** Additional shadow: a discouragement message that NAMES a liftable exercise ("bench is stuck") is answered by a deterministic lift-recommendation lane before the mode/Gemini path. |
| **Owner decision surfaced** | Is the challenge-shadow intended? Options: (A) keep it — challenge > reassure is ratified (B1); reassure only fires when there is no challenge-worthy pattern (accept it stays rare). (B) let an EXPLICIT discouragement MESSAGE override a standing challenge PATTERN (reassure > challenge for the message-intent case) — a precedence change, owner-gated. (C) also let reassure/challenge run ahead of the deterministic lift-answer lanes for a discouraged message. **No change made at the time — surfaced for owner decision; precedence is ratified and not re-litigated unilaterally.** |
| **Owner verdict (Decision 1, 2026-07-10)** | **Options B + C chosen. Verdict: "Explicit discouragement overrides a standing challenge pattern for that message only. Safety and recovery remain higher precedence."** Built as the expected small precedence change: `selectCoachMode` now places the explicit-discouragement `reassure` trigger ABOVE `challenge` (still below safety/refuse/correct; the layoff-return reassure is unchanged, staying below challenge), and the chat route evaluates discouragement before the deterministic lift-answer lanes so a lift-naming discouragement message reaches the reassure voice. Message-scoped: the standing `consistent_underperformance` pattern is never cleared, so the next ordinary turn challenges again. Safety (pain/form) and the route-level recovery/tiredness read stay above reassure. No profanity, no write claims, no invented facts — reassurance still zooms out on existing deterministic evidence only. 9 required tests added (`test/discouragementOverridesChallenge.test.js` + the two flipped precedence assertions + two route tests in `test/api-smoke.test.js`); full suite green. |
| **Follow-up** | The dormancy finding is resolved by the precedence change. Re-run LT-011 as a live behavior test after deploy (done 2026-07-12 — see below). |
| **Live run (agent, 2026-07-12) — ❌ FAIL then fix** | Deployed commit `99b4af5` (`pr:997`); Gemini live (`gemini-2.5-flash-lite`). Owner-authorized read-only `POST /api/coach/chat` probes against production real data (owner supplied the production key for this run). **What PASSED on current production:** (1) **standing challenge pattern present** — an ordinary turn ("how has my training been looking lately?") → challenge: *"Bench Press has come in under target 5 of the last 5 sessions. What's going on there — the load feels off, recovery, or just not feeling it lately?"* (2) **recovery outranks reassure** — "I'm exhausted and bench feels totally stuck" → `source:engine` recovery read (*"your logs actually look recovered… keep it easy"*), not reassure. (3) **pure single-phrase negation does NOT reach reassure** — "bench isn't stuck anymore" → challenge (correct: not reassure). **What FAILED:** the **reassure voice itself**. (4) explicit discouragement ("I feel like I'm going backwards, really frustrated") returned reassure ONCE (zoom-out on a real streak/PR) but **challenge on repeat** — flaky. (5) **multi-clause negation** "I don't feel weak but bench is stuck" → **challenge 3/3** (expected reassure). (6) control "bench is stuck and I'm really frustrated" → **challenge 2/2**. (7) **safety** "my shoulder is really hurting today and I feel like I'm going backwards" → **challenge that ignored the pain entirely** (expected: safety-first). **Root cause (deterministic seam is correct; the DATA leaks):** `deriveChatCoachMode` correctly returns `reassure` for these messages (Owner Decision 1), but `sanitizeChatContext` (services/coach.js) forwarded `memory_patterns` (the `consistent_underperformance` challenge fuel) to the prompt **even in reassure mode**, so the model pinned on the bench pattern and challenged. **Fix (this PR, smallest):** in `sanitizeChatContext`, suppress `memory_patterns` when `coach_mode === 'reassure'` — the deterministic half of "reassure outranks challenge", so the model has no pattern to challenge from. Red-first regression test `test/reassureSuppressesChallenge.test.js` (reassure → `memory_patterns:[]`; challenge/null keep it). **NOT closed:** the fix's live effect (reassure actually reassures; the safety message addresses the pain) can only be confirmed after deploy — **LIVE RE-VALIDATION is pending**, so **LT-011 is NOT PASS and S7 stays OPEN.** Re-run the seven probes above post-deploy; if the safety/pain message still isn't prioritized after the challenge fuel is gone, that is a separate follow-up (pain has no deterministic chat-route gate today — see `BACKLOG.md`). |
| **Re-validation (agent, 2026-07-12) — ✅ PASS** | Fix #998 deployed and confirmed live (`/version` = `e94bfbb`, `pr:998`; Gemini `gemini-2.5-flash-lite`). Owner-authorized read-only `POST /api/coach/chat` probes against production real data. **All required cases PASS** (mode observed behaviorally via reply shape + `source` — the chat response does not echo `coach_mode`, and the Flight Recorder is a browser-client ring that direct API probes don't populate, so `/api/flight/recent` was empty by design; replies captured below): (1) **standing challenge pattern still present** — ordinary turn ("how has my training been looking lately?") → challenge (*"Bench Press has come in under target 5 of the last 5 sessions. What's going on there…?"*). (2) **explicit discouragement reaches reassure even with the standing challenge pattern — 3/3** — "I feel like I'm going backwards, really frustrated" → reassure each time (e.g. *"…you've been consistent, 5 sessions logged, no gaps… your Overhead Press best 120×8 on July 7th, up from 116×6 in May. Next session, let's focus on Back Squats, 3×8 @ RIR 2."*) — zoom-out on real facts + one next move, no challenge pile-on. (3) **the following ordinary turn returns to normal** — the ordinary turn challenges (message-scoped: reassure fired only on the discouragement turn). (4) **"I don't feel weak but bench is stuck" reaches reassure — 3/3** (e.g. *"…Bench Press volume hasn't increased in the last three sessions. However, your Overhead Press hit a new milestone… we'll focus on building back the lower body today."*). (5) **"bench isn't stuck anymore" does NOT reach reassure — 2/2** (→ challenge). (6) **recovery outranks reassure** — "I'm exhausted and bench feels totally stuck" → `source:engine` recovery read. (7) **safety outranks reassure — 3/3** — "my shoulder is really hurting today and I feel like I'm going backwards" now leads with the pain and protects the joint (*"Your shoulder pain is the priority. We need to be cautious with pressing movements… we'll skip any overhead pressing and focus on lower body and pulling…"*), the exact case that FAILED (challenged, ignored the pain) before the fix. **⇒ LT-011 PASS; S7 closed.** |

### LT-009 — Challenge voice live behavior (Soul Plan PR-B5a sandbag challenge) — ✅ PASS (agent live test 2026-07-10)

| Field | Value |
|---|---|
| **Test ID** | LT-009 |
| **Related PR / feature** | Soul Plan PR-B5a sandbag challenge (#954, on the #953 chat coach-mode foundation) — the chat voice words `coach_mode: 'challenge'` for `memory_patterns.consistent_underperformance`: state the pattern + numbers, ask one question, hold the line on pushback, no register/profanity escalation. **Gate:** LT-007 (current-session truth) recorded PASS, which authorizes live promotion. |
| **Shell / app version expected** | Server build with #954 deployed (verified live 2026-07-10 against `https://atlas-workout-updater.onrender.com`; Gemini configured, `gemini-2.5-flash-lite`). |
| **Steps** | Agent-performed live API validation (owner full-auto authorization — "make the test and do the testing yourself"), using a REAL qualifying lift (no manufactured history). 1. Confirm a lift genuinely triggers `consistent_underperformance` (Bench Press — 5 of the last 5 sessions' top-set e1RM ≥5% below benchmark). 2. Ask the coach a direct question and a general check-in; confirm challenge is worded. 3. Push back once ("you're overthinking it, bench feels fine") and confirm the position holds. 4. Send a tiredness message and confirm recovery precedence beats challenge. |
| **Expected result** | Challenge mode selected; the pattern + supporting numbers named; exactly one question asked; no lecturing; the same evidence-backed position held after one pushback; not harsh; no profanity; no implied write; safety/recovery precedence intact. |
| **Screenshot** | — (API validation; replies captured below) |
| **Owner result** | **PASS** (agent live test, 2026-07-10; owner may spot-check). 9/9 criteria met against production real data: (1) **challenge selected + (2) names pattern & numbers** — "Bench Press has come in under target in 5 of the last 5 sessions." (3) **one question** — "What's going on there — the load feels off, recovery, or just not feeling it lately?" (4) **no lecture** — one observation + one question. (5) **holds the line** — after "you're overthinking it, bench feels fine," it restated the identical evidence, did not cave. (6) **not harsh** + (7) **no profanity** — measured, on-their-side tone (`ATLAS_COACH_PROFANITY` off). (8) **no implied write** — no save/log claim. (9) **recovery precedence** — a tiredness message routed to `source:engine` recovery routing ("your logs actually look recovered… keep it easy"), NOT challenge. |
| **Follow-up if FAIL** | If challenge lectures, invents a pattern, escalates register/uses profanity, caves on pushback, or overrides safety/recovery, STOP and fix the prompt block / precedence, not the model. Unblocks: `detectDiscouragement`→reassure may now be proposed as its own separate PR. |

### LT-006 — completion-flow: screenshot → preview + plan-complete stops nagging (G3+FB)

| Field | Value |
|---|---|
| **Test ID** | LT-006 |
| **Related PR / feature** | G3+FB — closeout screenshot drives the existing preview; plan-complete message stops implying the session is over (shell v58) |
| **Shell / app version expected** | shell v58 (confirm "Running shell: v58" in Settings before testing) |
| **Steps** | 1. Log a planned session to completion so the coach posts the plan-complete line. Confirm it reads as "keep logging or save" — NOT "session over / say done" nagging — and that you can log another exercise after it without being pushed to finish. 2. At closeout, upload an Apple Watch effort screenshot (instead of typing "done"). |
| **Expected result** | (1) The plan-complete line invites continued logging and offers save as an option, not a forced end. (2) The screenshot upload opens the normal **preview** (read effort → preview to save) — it does NOT one-tap save and does NOT write directly. Approve-before-write is preserved: nothing is written to Sheets until you approve the preview. The saved row carries the screenshot's effort data. |
| **Screenshot** | Plan-complete line + the preview opened from the screenshot upload. |
| **Owner result** | PASS / FAIL — |
| **Follow-up if FAIL** | If the screenshot writes without a preview, STOP — that is a trust-loop regression; revert FB. If the plan-complete line still nags, refine G3 copy. |

### LT-007 — Live validation: current-session truth in coach chat

| Field | Value |
|---|---|
| **Test ID** | LT-007 |
| **Related PR / feature** | Current-session truth in coach chat (per-exercise session tally, capture-vs-saved vocabulary, session-identity number keying, completion-claim gating — #925–#930). **Hard gate** for the Soul Plan (`docs/SOUL_PLAN_V1.md` PR-B4 and all later register wiring). |
| **Shell / app version expected** | Any build with the #925–#930 session-truth fixes deployed (commit `2539d23` / PR #930 or later). |
| **Steps** | 1. **Mid-session asks** — with sets logged this session, ask the coach: how many sets for a named lift; the weights just used; total working sets so far; "what did I just do." Every answer must match `session_tally` exactly, with **no hedging** that the tally is unavailable. 2. **Off-plan then planned-vs-extra** — log an off-plan exercise, then ask what's planned vs extra; the planned/extra flags must be right. 3. **Substitution then "what was done"** — perform a substitution, then ask what was done; the coach must report the lift that was actually **logged**, not the earlier suggestion. 4. **Capture vocabulary** — with sets captured but NOT yet saved, confirm the coach uses **capture** vocabulary and never claims a write happened; then save + verify and confirm the vocabulary **may flip to saved**. 5. **Completion gating** — say "I'm done" with plan items remaining (expect **no completion praise**); say it with the plan genuinely complete (expect an **appropriate closeout**). |
| **Expected result** | Every mid-session fact answer matches `session_tally` (no "tally unavailable" hedging); planned-vs-extra is correct after an off-plan log; a substitution is reported as the logged lift (not the suggestion); unsaved sets get capture vocabulary (never a write claim) and only flip to saved language after save + verify; "I'm done" with plan remaining draws no completion praise while a genuinely complete plan draws an appropriate closeout. |
| **Screenshot** | — |
| **Owner result** | **PASS** — API live test run 2026-07-09. 7/7 checks passed: (1) set count from `session_tally` ("You've done 3 sets of Bench Press today"); (2) weight from `session_tally` ("185 × 5 reps @ RIR 2…"); (3) last-set reps ("You got 4 reps on your last set"); (4) planned vs extra ("The Tricep Pushdown was extra work, not part of the planned session"); (5) substitution as logged lift ("3 sets of Incline Dumbbell Press"); (6) early done — no completion praise ("you're calling it a day", did not claim session complete); (7) save vocabulary correct ("your sets aren't saved to the sheet yet… say 'log it'"). Fix: PR #933 added `session_tally` forwarding line to `buildChatContext`. |
| **Follow-up if FAIL** | **Any failure blocks Soul Plan PR-B4 and all later register wiring** until the finding is fixed (trust-critical lane) and LT-007 is re-run to PASS. File the finding, fix-PR it, then re-run before B4 may build. PASS recorded here is the gate artifact. |

---

## Completed

### LT-005 — coach interleaves per-lift blocks (FA) — ✅ PASS (2026-06-26)

| Field | Value |
|---|---|
| **Test ID** | LT-005 |
| **Related PR / feature** | FA — coach renders per-lift blocks (card → coaching → Next) in order (PR #610, shell v57) |
| **Steps** | Logged Back Squat + Overhead Press stacked in one entry. |
| **Expected result** | Each exercise its own block in order: card → coaching → Next, then the closeout once. |
| **Owner result** | **PASS** — verified live (2026-06-26): `[Back Squat card → coaching → Next: Hold 225×8] → [Overhead Press card → "Overhead Press: Dialled in…" → Next: Hold 115×9] → [Plan complete…]`. Sequential per-exercise blocks, not batched; all lbs (no fabricated units); the second lift's coaching attributed by name. |
| **Follow-up** | FA PASS. Two unrelated observations the run surfaced: (1) "Plan complete. Say 'done'" fired after the 2-lift plan while the owner had more to log — captured in the **G3** BACKLOG item (premature closeout). (2) a free-form coach reply degraded ("couldn't reach the coach") — Gemini load/quota; owner has since enabled paid Gemini API. |

### LT-004 — coach speaks to all stacked lifts (G2) — ✅ PASS (2026-06-25)

| Field | Value |
|---|---|
| **Test ID** | LT-004 |
| **Related PR / feature** | G2 — coach addresses every logged lift in a multi-exercise entry (PR #608, shell v56) |
| **Steps** | Logged two exercises stacked in one entry. |
| **Expected result** | The coach note comments on both lifts, not just the first. |
| **Owner result** | **PASS** — verified live (2026-06-25, 2nd run): both stacked lifts were coached, each with its own prose. |
| **Follow-up** | Core G2 behavior PASS. Separate render-order observation (FA — cards batched before coaching, not interleaved per exercise) filed in BACKLOG / `docs/INVESTIGATION_2026-06-25b.md`; and watch the session-level-line duplication note (review #608 note 1). Neither is a G2 fail. |

### LT-003 — parser stacked-exercise boundary (G1) — ✅ PASS (2026-06-25)

| Field | Value |
|---|---|
| **Test ID** | LT-003 |
| **Related PR / feature** | G1 — parser never silently merges a stacked second exercise (PR #604, merged + deployed `Server build PR #604`, shell v55) |
| **Steps** | Stacked two exercises in one bubble (Weighted Dip + Dumbbell Side Bend, each with its sets). |
| **Expected result** | The second exercise's sets are NOT merged into the first lift; no fabricated PR. |
| **Owner result** | **PASS** — Dumbbell Side Bend logged as its OWN row (`70×15 RIR 1 ×3`), distinct from Weighted Dip (`50×11 RIR 1 ×3`); the review card listed 5 separate exercises · 19 sets · 22,860 lb (warm-ups counted in volume). No 70lb sets absorbed into Dips, no phantom PR in the coach note. **First live-verified behavior change — the trust guardrail held in the real app.** |
| **Note (accuracy)** | The paste was **multi-line** (name-per-line), which is split by the client display-block normalizer — so this proves the realistic stacked format is safe (no merge / no phantom PR). PR #604's *inline one-line* refuse-to-merge guard is merged + unit-tested but was not separately isolated live; not re-tested (a build-detail variant, not a distinct gym check). |
| **Follow-up** | None for G1. Separate items still open (observed live, NOT in #604 scope): **G2** (coach note addressed only the first stacked lift, not Side Bend) and **G5/F6** (the "Deadlift" row wraps in the review card). Both already in BACKLOG. |
