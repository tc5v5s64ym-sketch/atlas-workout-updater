# Atlas — Fix Plan (model-sequenced, hand-to-agent ready)

**Audience:** Claude Code (or any AI agent) working on `tc5v5s64ym-sketch/atlas-workout-updater`.
**Author:** generated from a full repo audit on 2026-06-15, cross-checked against the existing `AUDIT.md` (2026-06-14), the current `HEAD`, and **two external reviews** (ChatGPT + a fresh Claude instance).
**Owner:** Dale. First app — keep explanations plain, do less, ask when unsure.

---

## Revision note — three independent audits agree

This plan was cross-checked against two outside reviews. The signal:

- **All three audits (this one, ChatGPT's, the fresh Claude's) independently put the write-path integrity fix as #1.** Three blind reads agreeing is strong confirmation: do Step 1A first, full stop.
- **All three flag the same root inefficiency:** too many coach-voice / deload micro-PRs on a few shared "hot" files. One review found a single branch merged **8 times** (#202–#218) and coach-voice as the dominant theme (24 merges). Your "too many PRs on one thing" instinct was correct.

**What the external reviews ADDED (folded in below):**
- The **`/api/bodyweight`** write route *also* has optional `write_id` — added to Step 1A.
- **HI-8** — `recommendNextSet` compares two *sets* not two *sessions* (false progression) — added to Step 1D.
- **ME-8** — `buildWeeklyReport` zeroes out on object-shaped rows — added to Step 2D.
- **HI-5** — the service-worker cache (`CACHE_NAME`) footgun — added to Step 2E. **This may be why your deload changes "disappeared" after deploy** — a stale cached shell on your iPad/device.
- **Extract deload into a dedicated `deloadPolicy.js` module with fixtures** — both reviews recommend it; added as Step 1C. It's the implementation half of the deload-spec cure.
- **Branch protection + golden-output coach rubric** — added as "Process changes."
- Concrete hygiene: a **duplicate `test/` and `tests/` directory**, and a **README that says the dashboard is "intentionally absent" then lists one** — added as optional cleanup.

**What was already DONE (do NOT let any agent redo these — the ChatGPT plan is stale here):**
- ✅ **HI-6** secret scan IS wired into CI (`.github/workflows/ci.yml` has a `secret-scan` job).
- ✅ **HI-7** lint now globs all `*.js` (no more hand-maintained list).
- ✅ **HI-4** the Excel-serial date branch now checks `typeof === 'number'` first.
- ✅ **HI-3** one parser path already has the set-count cap (the other may not — see Step 2B).

**What was in the reviews but is deliberately NOT here:** a wholesale split of the big files, a home-screen redesign, multi-user/database work. See "Out of scope" — these are owner decisions, and some conflict with your Constitution.

---

## Your workflow — how to run this without thrash

You're juggling Claude Code, this chat, ChatGPT, and Grok, and it feels messy because there's no rule for who does what. Here's the rule. The thing you put your finger on — *"every time I bring something out, another agent finds something"* — has one cause and one fix.

**The cause:** a fresh agent will *always* find something. That's what they do — they pattern-match to "be critical." If you treat every find as must-fix, you never finish. (That's literally what the deload spiral was.)

**The fix:** findings are a **backlog**, not a **to-do list**. Every new find gets ranked against this plan's priority order. If it doesn't beat what you're already doing, log it and keep going. Most finds are real-but-low-priority and will never get done, because something more important always exists. That's healthy, not negligent.

### Assign each tool ONE job

- **Claude Code = the builder *and* the tester.** It implements each step, writes the acceptance tests, runs them. ~90% of the work lives here and should never leave. Tell it: *"Do Step X. Write the tests. Run them. Show me the diff and the test output."*
- **The test suite = the verifier.** Not another chatbot. Green tests + the step's acceptance criteria = "done." Tests are objective; a second agent's opinion is subjective and usually just re-litigates. **This is the verifier you've been looking for — you already have it.**
- **One assistant (this chat) = the planner / decision desk.** Bring things here only for a *judgment call* (like "auto deload or on-demand"), not a correctness check. Decide it, write it into this doc, go back to Claude Code.
- **ChatGPT / Grok / a fresh Claude = the periodic auditor.** Use them at *milestones* (end of a phase), once, for fresh eyes — exactly like the audit we just did. **Never per-PR.** Per-PR cross-checking is what creates the endless back-and-forth.

### The loop (repeat per step)

1. In Claude Code: *"Do Step X from this plan. Write the acceptance tests. Run them. Show me the diff + test output."*
2. Tests pass → tick the step's acceptance boxes yourself → commit/merge. **Done. Next step.**
3. Do **not** paste routine steps into another chat for a second opinion. The tests already are that opinion.

### The only three reasons to "bring something out"

1. **A real design decision** → this chat. Decide, write it into the plan, return.
2. **A milestone audit** (a phase finished) → one external fresh-eyes pass → triage finds into the backlog → act only on ones that beat your current top priority.
3. **Something smells wrong** — tests pass but behavior's off, or you're stuck → bring that *specific* thing out.

### Stop doing these

- **Two architects.** You have one plan. ChatGPT-as-architect *and* this-as-architect = two sources of truth = the confusion you feel. Plan in one place.
- **Copy-pasting for reassurance.** Chat has no memory of your repo; every paste loses context and invites a new agent to find new things. The repo is the truth; the tests are the check.
- **Chasing every find.** Log it, rank it, move on.

**One source of truth:** this document (committed to the repo) + your test suite. Not chat history, not scattered audit files. When in doubt, the committed code and the green tests win.

---

## 0. How to use this document

Split into **phases**. Each phase uses **one Claude model start to finish**. Between phases is a **HOLD POINT** — a hard stop where you run the tests, tick the boxes, commit, then switch models.

**Switch models in Claude Code:** type `/model`, pick the phase's model. Only at a HOLD POINT.

**A HOLD POINT in practice:** (1) `npm test` green → (2) confirm each acceptance box by hand → (3) commit → (4) `/model` switch → (5) continue.

---

## 1. Operating rules for the agent (read before any code)

1. **Read `CLAUDE.md`, `docs/CONSTITUTION.md`, `docs/INVARIANTS.md` first.** This plan never overrides them.
2. **Verify before you fix.** Each step starts with a *"Confirm it's still open"* check. If already fixed, **skip it** and note "already fixed" in the PR. (See the ✅ list above — several items are already done.)
3. **Find code by anchor, not line number.** Line numbers drift in this fast-moving repo; use the function/string anchors.
4. **One concern per PR** (Invariant PR1). No "cleanup" mega-PRs.
5. **Never call a real Sheets write in a test.** Use the `require.cache` stub in `test/api-smoke.test.js`.
6. **Never commit** `.env`, keys, credentials, screenshots, or workout data.
7. **No wholesale refactors.** `CLAUDE.md` forbids "big refactors to clean things up." **Exception, explicitly allowed:** the *targeted* deload-module extraction in Step 1C — that creates one clean domain concept, which the Constitution's spirit favors. It is NOT a license to split `index.js` or `analytics.js`.
8. Branch with the `claude/` prefix. Never push to `main`.

---

## 2. Model strategy (which model, and why)

| Phase | Model | Why |
|---|---|---|
| **Phase 1** | **Claude Opus 4.8** | High-stakes reasoning: the write path to your permanent Sheet, the deload spec + module, and recommendation correctness. Mistakes corrupt data or restart the deload spiral. |
| **Phase 2** | **Claude Sonnet 4.6** | Mechanical, well-specified fixes (styles, a cap, friendly errors, a weekly-report shape bug, a cache-name bump). |
| **Phase 3 (optional)** | **Claude Haiku 4.5** | Trivial dead-code deletions only. Skip the switch unless there's a real batch. |

> **One mandatory model switch** (Opus → Sonnet). Haiku optional.

---

## 3. The deload cure has TWO halves

You spent ~8 PRs nudging deload and it still didn't land — because there was no single written definition, so every PR re-guessed your intent. The cure is two steps, both in Phase 1:

1. **Step 1B — freeze the spec** (`docs/DELOAD_SPEC.md`, with worked examples at 205 lb). The *what*.
2. **Step 1C — extract `deloadPolicy.js`** so the behavior lives in one module with fixtures, not scattered across `analytics.js` / `coach.js`. The *where*.

After this, deload is one concept in one file with one spec. If it's wrong, you change the spec, the fixtures catch the change, the module follows. **No more eight-PR spirals.** Until 1B is approved, the agent must not touch deload code.

---

## PHASE 0 — Pre-flight (any model)

- [ ] `git checkout main && git pull`
- [ ] `npm ci`
- [ ] `npm test` — record passing count: **______** (≈768).
- [ ] `git checkout -b claude/fix-plan-phase-1`

---

## PHASE 1 — Claude Opus 4.8

> Switch to **Opus 4.8**. Four steps, four separate PRs.

### Step 1A — Close the write-path double-write window

**Why:** the "don't write twice" ID is *optional*, and on an error the system *forgets* the write — so a retry can append the same sets to your Sheet again. The only place Atlas can corrupt your permanent record. **Do this first.**

**One PR covering CR-1, CR-2, HI-1 — across all THREE write routes.**

**Confirm it's still open:**
- `services/idempotency.js` → `function failWrite`. If it calls `writeRecords.delete(...)`, CR-1 is open.
- `index.js` → `/api/log-workout` (`const writeId = payload.write_id;`), `/api/complete-workout` (`const writeId = formFields.write_id;`), **and `/api/bodyweight`** (anchor: `write_id` in the bodyweight handler). If any does NOT 400 on missing `write_id`, HI-1 is open there.
- `index.js` → the **Effort** append in `/api/complete-workout` (anchor: `appendRows('Effort'`). If unguarded against an existing `session_id`, CR-2 is open. `getEffortSessionIds` is already imported.

**Key precision (verified against current code, 2026-06-15):** `/api/complete-workout` is **already hardened** — it uses `writeCommitted` + `liveWriteRecorded` flags and, on a post-append error, records the write as completed instead of calling `failWrite` ("never failWrite a committed write"). **Do NOT touch it — it's your reference implementation; copy its pattern.** The still-exposed paths are **`/api/log-workout` and `/api/bodyweight`**, which use the old `catch → failWrite` pattern with no committed-guard. `/api/bodyweight` also has optional `write_id` (`req.body?.write_id`).

**The change:**
1. **HI-1:** 400 if `write_id` missing on `/api/log-workout` and `/api/bodyweight` (and complete-workout if not already) — mirror the existing `/api/coaching-notes` pattern (`if (!writeId) return standardError(req, res, 'write_id is required', null, 400);`).
2. **CR-1:** in `failWrite`, mark `status:'failed'` instead of deleting; `beginWrite` treats `failed` as retryable. AND port complete-workout's `writeCommitted` / `liveWriteRecorded` guard to **log-workout and bodyweight** so a post-append throw records completion instead of releasing the record.
3. **CR-2:** guard the Effort append against a duplicate `session_id` (use `getEffortSessionIds`).

**Acceptance criteria:**
- [ ] Missing `write_id` → 400 on log-workout, complete-workout, **and bodyweight** (one test each).
- [ ] Simulated failure mid-write, retry with same `write_id` → **exactly one** append (new test; must fail before the fix, pass after).
- [ ] Duplicate `session_id` to the Effort path → no second Effort row (new test).
- [ ] `npm test` green.

**PR title:** `fix(write): require write_id on all 3 routes, mark-not-delete on failure, guard Effort dup (CR-1/CR-2/HI-1)`

---

### Step 1B — Freeze the deload spec (owner sign-off)

**Why:** see §3. Writing + judgment → Opus.

**The change:** the full deload spec is **Appendix A at the bottom of this document.** Committing it to the repo as `docs/DELOAD_SPEC.md` *is* this task. It's already drafted — review the worked examples and approve (or edit until they match what you'd want to see).

**HOLD (owner approval):** Dale approves the worked examples before any deload code is touched. Wrong behavior → edit the spec, not the code.

**Acceptance:**
- [ ] `docs/DELOAD_SPEC.md` committed with the sections + two examples.
- [ ] Dale approved the examples.
- [ ] `CLAUDE.md` "Critical behaviours" table points to it.

**PR title:** `docs(deload): freeze the deload spec with worked examples (owner-approved)`

---

### Step 1C — Extract `deloadPolicy.js` (behavior-preserving, with fixtures)

**Why:** deload logic is scattered across `analytics.js`, `coach.js`, and client files, so every model "fixes" the same nerves and regressions multiply. Both external reviews call for one dedicated module. This is the *where* half of the cure (§3). **Allowed under rule 7** — it's a targeted domain extraction, not a cleanup refactor.

**The change:**
1. Locate all deload logic (anchors: `deload`, `deload_reset`, `deloadFillerWeight`, the deload branches in `recommendFromJustLoggedSet`).
2. Add fixtures that pin **current** expected behavior per `DELOAD_SPEC.md`: volume-first holds working weight; cuts sets/effort not load; an active deload does not recommend progression; a logged deload set is narrated as a deload; accessory fillers don't overshoot real history.
3. Extract the decision logic into `services/deloadPolicy.js`. **Keep behavior identical** except where a fixture exposes a real bug (note those separately).
4. **No coaching-copy changes in this PR.**

**Acceptance:**
- [ ] `services/deloadPolicy.js` exists; deload decisions route through it.
- [ ] Fixtures cover the five behaviors above and pass.
- [ ] No change to coach wording; `npm test` green.

**PR title:** `refactor(deload): extract deloadPolicy module + fixtures, behavior-preserving`

---

### Step 1D — Recommendation correctness (don't misread progress)

**Why:** two bugs make the engine push false progressions/deloads — the exact thing that drove your deload frustration.

**Confirm it's still open:**
- **ME-7:** `services/analytics.js` → `function detectStalls`. If it decides a stall from `best_weight` alone (ignoring reps/volume/e1RM), open.
- **HI-8:** `services/analytics.js` → `recommendNextSet`. If "stable reps over two sessions" actually compares two adjacent *sets* (often same session) instead of two distinct `session_id`s, open.

**The change:**
- **ME-7:** factor reps/volume/e1RM into stall detection so rep progress at a fixed weight is NOT a stall. Align with `DELOAD_SPEC.md` (and per the productization decision, a stall should suggest "add a rep / nudge load," **not** auto-recommend a deload).
- **HI-8:** compare best sets across the last two **distinct sessions**, not adjacent sets.

**Acceptance (use hand-computed golden fixtures, NOT output generated by the code under test):**
- [ ] Same-weight, increasing-rep sessions → **not** a stall (golden fixture).
- [ ] A genuine flat plateau → still flagged.
- [ ] HI-8 progression trigger requires two distinct sessions (golden fixture).
- [ ] `npm test` green.

**PR title:** `fix(analytics): stall + progression read distinct sessions and reps/volume (ME-7/HI-8)`

---

## 🛑 HOLD POINT 1 — end of Opus phase

- [ ] `npm test` green. All Phase 1 boxes ticked. `DELOAD_SPEC.md` approved. Commit.
- [ ] **`/model` → Claude Sonnet 4.6.** New branch: `git checkout -b claude/fix-plan-phase-2`

---

## PHASE 2 — Claude Sonnet 4.6

> Switch to **Sonnet 4.6**. Mechanical, well-specified. Separate PR each.

### Step 2A — Fix CSP so the UI stops leaking/breaking
**Why:** the page CSP blocks inline `style=`, so hidden legacy forms leak onto Trends and recovery bars don't fill.
**Confirm:** `public/index.html` CSP meta has no `style-src` → open.
**Change (preferred):** move inline styles to classes in `public/styles.css` — `.hidden{display:none}` for the legacy wrapper, a width utility/CSS var for recovery fills, and the stray `font-size`/`margin`/`white-space` spots in `public/app.js`.
**Acceptance:** no CSP console warnings on Trends/Today/History/Body; forms stay hidden; bars fill; tests green.
**PR title:** `fix(ui): inline styles → classes so CSP stops breaking Trends/recovery (HI-2)`

### Step 2B — Finish the parser set-count cap
**Confirm:** `services/workoutTextParser.js` → an `Array.from({ length: setCount })` path lacking the `if (setCount > 10) return null;` guard a sibling already has. If all capped, **skip.**
**Change:** add the guard to any uncapped path; valid input unchanged.
**Acceptance:** absurd set count rejected on every path; golden parser tests still pass; tests green.
**PR title:** `fix(parser): cap set-count on all paths (HI-3)`

### Step 2C — Friendly errors, no contradictory panels
**Why:** raw dev strings and literal `undefined` reach the user; sections fail independently and can contradict (e.g. "log a few sessions" next to "48 total sessions").
**Confirm:** `public/app.js` handlers piping `json.message`/`err.message` into the DOM; bespoke tables not coalescing; independent empty-states.
**Change:** friendly copy via `el()`/`setStatus()` (not `innerHTML`); guard array shapes before `.filter`/`.map`; coalesce missing cells to `—`; derive the top-of-screen empty-state from the same signal the populated cards use (ME-3).
**Acceptance:** a Playwright e2e feeding empty + partial + error responses asserts no raw error text, no `undefined`, no contradictory panels; tests green.
**PR title:** `fix(ui): friendly fallbacks + no contradictory states (ME-1/ME-2/ME-3)`

### Step 2D — Weekly report handles object-shaped rows
**Confirm:** `services/analytics.js` → `buildWeeklyReport`. If it indexes rows positionally (`row[7]`, `row[8]`…) without normalizing, object rows silently zero it out → open.
**Change:** normalize rows up front like the sibling builders (or branch on array vs object).
**Acceptance:** object-shaped rows produce the same report as array rows (new test); tests green.
**PR title:** `fix(analytics): weekly report normalizes row shape (ME-8)`

### Step 2E — Service-worker cache bump (the "it disappeared after deploy" fix)
**Why:** likely the cause of changes not showing on your device. The SW precache rejects the whole install if one asset 404s, and the shell only refreshes when `CACHE_NAME` changes — so a stale shell can persist.
**Confirm:** `public/sw.js` → `cache.addAll(SHELL_ASSETS)` + a static `CACHE_NAME` (e.g. `atlas-shell-v2`).
**Change:** switch precache to per-asset `cache.add` in a loop (one 404 no longer voids the shell); bump `CACHE_NAME` on every asset-affecting deploy (ideally a build hash); surface install failures instead of swallowing them.
**Acceptance:** a missing asset doesn't void the cache; a deploy reliably serves the new shell; tests green.
**PR title:** `fix(pwa): resilient precache + cache-name bump so deploys aren't masked (HI-5)`

---

## 🛑 HOLD POINT 2 — end of Sonnet phase

- [ ] Tests green; all Phase 2 boxes ticked; commit.
- [ ] **Decision:** real batch of dead-code deletions? Yes → Haiku. Two or three → stay on Sonnet, skip the switch.

---

## PHASE 3 — Claude Haiku 4.5 (optional, trivial only)

Verify each is still present, then delete: dead `loadTodaysPlan()`; the client-side fallback parser duplicating the backend parser; duplicated greeting logic with disagreeing cutoffs (`coach-conversation.js` vs `nav.js`); the redundant condition in `recommendationPolicy.js`; dead imports in `index.js`. One concern per PR.
**PR title pattern:** `chore: remove dead <thing> (LO-x)`

---

## Process changes (do once — GitHub settings + a test rule, not an agent code PR)

These directly kill the "same branch merged 8 times / stale branch clobbering" thrash all three audits flagged:

- **Turn on branch protection on `main`:** require PRs, required status checks (CI), and **"require branches to be up to date before merging."** (Settings → Branches.) This stops stale branches from silently clobbering shared files.
- **Give coach-voice an objective "done" bar.** Extend `test/coach.test.js` into a **golden-output rubric**: a voice change must update the rubric, not just re-litigate a sentence. When the rubric passes, phrasing work stops. This is what ends the 24-PR coach-voice loop.
- **Adopt the golden-test discipline for bad recommendations:** "here is a bad Atlas recommendation → add a failing test → make the engine produce the right one → do **not** just change wording."

---

## Additional verified items (from the external-review cross-check)

Surfaced by the ChatGPT/Grok reviews and **verified against current code**. Fold in opportunistically.

- **In-memory pending-exercise state (reliability).** `index.js:159` — `const pendingExercisesMemory = [];` with a `TODO(persistence-layer)`. A redeploy/restart drops the pending-exercise review queue. Low blast radius, but real. **Decision:** persist to a small Sheet tab (on-brand with "Sheets is the record"), or explicitly document the limitation. Sonnet-tier once decided.
- **Lift-code fallback collision (issue #2, latent).** `services/exerciseEnrichment.js` → `generateLiftCode` always emits `<3-letter-prefix>01` with **no collision check and no increment** — two different exercises can produce the same code and merge their analytics. Self-flagged (it writes an "add to Exercise_Catalog to lock it" note), so low-frequency, but identity bugs poison analytics. Add a collision check / increment. *(Couldn't confirm the issue's open/closed state — API rate-limited — check the tracker.)*
- **Flaky e2e (issue #262).** A test that fails only under parallel load erodes CI trust. Isolate/stabilize it before it trains you to ignore red. *(Same caveat — verify on the tracker.)*
- **API key in `localStorage` (security note, NOT urgent).** `public/app.js:9` stores the key in `localStorage`. Fine for single-user; an XSS would expose it. No action now — but it becomes a real item the day you productize (accounts/multi-user). Logged so it's not a surprise.

---

## Out of scope (owner decision required — do NOT start unprompted)

- **Splitting the big files.** `index.js` is 2,592 lines; **`analytics.js` is ~2,149.** Real maintainability cost, and your own build plan warns shared files clobber each other across branches — but a wholesale split is the "big refactor" `CLAUDE.md` forbids. **The targeted `deloadPolicy.js` extraction (Step 1C) is the sanctioned exception; everything else here waits for an explicit green-light.**
- **Cheap hygiene (optional, owner discretion):** a single PR could fold the duplicate `test/` + `tests/` dirs into one convention and fix the README "dashboard is intentionally absent" contradiction. Small, safe, not urgent.
- **Doc consolidation** (≈40 markdown files, several audit docs). Low priority. *Do not add a new audit doc* — that makes it worse.
- **`CLAUDE.md` "What not to build" list** (nutrition, voice interface, multi-user, a database, autonomous agent, Dashboard) — intentional scope, leave alone unless Dale decides to productize (a separate, larger decision).

---

## Product ideas parked (NOT hardening — Dale's call, later)

Surfaced by the reviews; good, but not part of this stabilization pass:
- **End-of-session verdict:** one tight readout after a workout — strongest lift, weakest lift, fatigue read, next-session decision. Likely more valuable than another per-set note tweak.
- **Dead-simple home flow:** one screen, big prompt, two buttons (Coaches Pick / Freestyle). A deliberate UX direction, not a fix — and you've already been over-investing in UI, so treat it as an explicit product decision, not drift.

---

## One-screen summary

| Order | Step | Model | PR |
|---|---|---|---|
| 1 | Write integrity, all 3 routes (CR-1/CR-2/HI-1) | **Opus 4.8** | `fix(write): require write_id…` |
| 2 | Freeze deload spec (approved) | **Opus 4.8** | `docs(deload): freeze the spec…` |
| 3 | Extract deloadPolicy module + fixtures | **Opus 4.8** | `refactor(deload): extract deloadPolicy…` |
| 4 | Stall + progression correctness (ME-7/HI-8) | **Opus 4.8** | `fix(analytics): stall + progression…` |
| — | 🛑 HOLD 1 → Sonnet | | |
| 5 | CSP / inline styles (HI-2) | **Sonnet 4.6** | `fix(ui): inline styles → classes…` |
| 6 | Parser set-count cap (HI-3) | **Sonnet 4.6** | `fix(parser): cap set-count…` |
| 7 | Friendly errors + no contradictions (ME-1/2/3) | **Sonnet 4.6** | `fix(ui): friendly fallbacks…` |
| 8 | Weekly report row shape (ME-8) | **Sonnet 4.6** | `fix(analytics): weekly report shape…` |
| 9 | Service-worker cache bump (HI-5) | **Sonnet 4.6** | `fix(pwa): resilient precache…` |
| — | 🛑 HOLD 2 → optional Haiku | | |
| 10 | Dead-code cleanup (optional) | **Haiku 4.5** | `chore: remove dead…` |
| — | Process (GitHub settings) | — | branch protection + coach rubric |

**The point:** fix the thing that touches your real data first, freeze + house the deload so it stops eating PRs, then sweep the mechanical stuff — including the cache bug that was probably hiding your deploys. One model switch. A hold point guarding each handoff.

---

# Appendix A — Deload Spec (becomes `docs/DELOAD_SPEC.md`)

> **Status: DRAFT — awaiting owner (Dale) approval.** Single source of truth for what a deload *is* in Atlas. Code follows this; if behavior is ever wrong, change this section first, then the code. Committing this as `docs/DELOAD_SPEC.md` is Step 1B.

## 0. Design decision: a real feature, recommended *intelligently*

Deload is a first-class Atlas feature (Atlas is becoming a product, not just Dale's logger). But the recommendation is **conditional on training stress, not on a naive weight stall** — because the need for a deload scales with frequency, volume, and fatigue:

- A high-frequency user (4–6x/week) grinding low-RIR for weeks → Atlas **recommends** a deload.
- A low-frequency user (1–3x/week, e.g. current-Dale) with a flat weight → Atlas **stays quiet** and suggests "add a rep / nudge load." Their rest days already are their deload.
- Any user can **invoke** a deload on demand ("ease me off," "deload week").

Same feature, same code, correct behavior for both. It must **never** fire just because the top weight was flat for N sessions.

## Decisions to confirm (the knobs)

| Knob | Default | Change if… |
|---|---|---|
| How a deload starts | owner-invoked, **or** recommended when frequency + fatigue warrant | you want different gating |
| Recommendation gate | trains ~4+ days/week **and** effort grinding (RIR ≤ 1) over several sessions, **or** a pain flag | too eager / too shy |
| Movements in a deload session | keep the normal **4–6** | you want fewer |
| Weight | **held** (no drop) | you'd rather drop load |
| Volume | cut working sets ~in half (e.g. 3 → 1–2 per movement) | bigger/smaller cut |
| Effort | easy — **RIR 4+** | harder/easier |
| Duration | **1 session**, re-evaluate | you want a full week |

## 1. When a deload happens (and when it must NOT)

**Owner-invoked (always available):** Dale/the user asks — "deload week," "ease me off," "I'm wiped."

**Recommended (conditional):** Atlas *offers* a deload only when training stress is genuinely high — roughly **4+ sessions/week AND effort grinding (RIR ≤ 1) across several sessions**, or a logged **pain flag**. Even then it's a question, never an automatic prescription.

**Must NOT trigger on:**
- ❌ a flat top weight for N sessions (NOT a deload signal — especially at low frequency),
- ❌ rep progress at the same weight (that's progress),
- ❌ a single hard session or a PR.

## 2. What a deload prescribes (volume-first)

**Keep your movements, hold the weight, cut the sets, keep it easy.**
- Same **4–6 movements** you'd train that day — a full session, not a stripped one.
- **Same working weight** per movement (no drop).
- **Fewer working sets** — roughly half (3 → 1–2).
- **RIR 4+** — comfortably easy.
- **One session**, then re-evaluate.

## 3. What the coach says during a deload

While a deload is active, the coach must: know it's a deload **for the whole session**, **name the held weight**, **frame easy sets as the point**, and **never** say "you left a lot in the tank, bump it next time."

- *"Deload set — 205 held, RIR 4, nice and easy. Banking recovery, not chasing reps."*
- *"That's the deload doing its job — light dose this week so next week's sharp."*

## 4. How a lift returns to normal

After the deload session: next session returns to the **same pre-deload working weight** (205, not lower), **full working-set count**, **progression target unchanged** (chase 10 clean reps @ RIR 3, then 215).

## 5. Worked examples (real numbers — these are the acceptance tests)

### Example A — Owner-invoked, Bench Press @ 205
Dale types *"give me a deload this week."* → prescription: normal bench day, `205 × 1–2 sets × ~5 @ RIR 4+`, other movements cut the same. → logs `205 5/4` → coach: *"Deload set — 205 held, 4 in reserve. Easy week so bench comes back fresh."* → next bench day: `205 × full sets`, resume toward 10 @ RIR 3 → 215.

### Example B — Recommendation correctly STAYS QUIET, Back Squat @ 205
Current-Dale (1–3x/week) hits `205 × 7` after a few flat sessions. Weight flat, but reps progressing and frequency low → Atlas does **NOT** recommend a deload; it says *"add a rep / hold for 10 @ RIR 3."* (For a 5x/week user grinding RIR ≤ 1 for weeks, the same engine *would* offer one — that's the conditional gate working.)

## 6. What this spec deliberately does NOT do

- ❌ recommend deloads from a flat-weight stall,
- ❌ drop the working weight (volume-first, not load-cut),
- ❌ reset progression or the 215 target,
- ❌ strip the session below the normal 4–6 movements,
- ❌ let the coach push for more during a deload.

*When approved: remove the DRAFT banner and add a `CLAUDE.md` "Critical behaviours" row pointing here.*
