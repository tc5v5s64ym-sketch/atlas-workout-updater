# Workout Sheet — Chat-First Shell + Pull-Down Workout Surface (Design)

> **Status:** DESIGN PROPOSAL — owner-directed direction (2026-07-11 brief, below); docs + mockup only, no runtime change. Implementation lands as the tiny PRs of §7 after an explicit owner go.
> **Decision class:** The *direction* is owner-initiated (new interaction model → vision-layer, owner-reserved category 2 — satisfied here because the owner requested it directly). The *details* below are PM-authority wording/rendering/UX derivable from governance (`docs/OWNER_CHECKIN_RULES.md`, Escalation Policy v3).
> **Trigger (owner brief, 2026-07-11):** "Super simple, very text box driven, like ChatGPT or Claude. A side menu that can pop out with all the extra bells and whistles, but that's not at the forefront. Once in workout mode, you should be able to pull down from the top and a window kind of appears with the current workout. Once you pull it down to center, it should snap in place and stay, and you should be able to move around the workouts by tapping and dragging."
> **Mockup:** `design/mockups/10-workout-sheet.html` — interactive; the pull gesture, the center snap, and drag-to-reorder all work in the browser. It is the visual spec for this design (same convention as mockups 01–09).
> **Governance grounding:** `docs/COMPOSER_FIRST_MIGRATION.md` (owner-adopted 2026-07-02), `docs/COACH_FIRST_HOME_SCREEN_DESIGN.md` (owner-decided 2026-07-03), `docs/CONVERSATION_FIRST_DESIGN_REVIEW.md`, Invariant I1 (*the conversation is the product*), `design/README.md` (design system).

---

## 1. The one-line finding

**Two-thirds of this brief is already Atlas's adopted direction — the new work is one thing: the Workout Sheet, a pull-down, snap-in-place view of the current workout with direct-manipulation reordering, layered over the chat shell that already exists.**

| Owner brief | Status in the current app |
|---|---|
| "Super simple, very text box driven, like ChatGPT or Claude" | **Already adopted and shipped.** Composer-first migration (owner, 2026-07-02) + the "one text box, LLM-free home" directive (owner, 2026-07-03). The home is a single composer; tiles are retired. |
| "A side menu that pops out with all the extra bells and whistles, not at the forefront" | **Already shipped.** `src/app/drawer.js` — hamburger → drawer with readiness ticker, Views (Today / Trends / History / Body), recent sessions, settings. §5 finishes the job by moving the remaining header chrome into it. |
| "In workout mode, pull down from the top → the current workout appears, snaps at center, stays" | **New.** This is the Workout Sheet (§3–§4). |
| "Move the workouts around by tapping and dragging" | **New surface, existing semantics.** Plan reordering already exists in the canonical ActiveSession state (the P0 session-state unification repaired reorder trust — Roadmap Steps 372–379). Drag-to-reorder is a *gesture front-end* to that same mutation path (§4). |

So this design threatens nothing structural: it adds a display + gesture layer over state and mutation machinery that already exists and is already tested.

---

## 2. Design philosophy

1. **The conversation is the product; the sheet is a glance.** The composer stays the one lane for everything that *means* something (logging, questions, plan changes by sentence). The Workout Sheet is the in-gym equivalent of the drawer: pulled into view when you want to *see* the session, dismissed when you want to talk. It never becomes a second home screen.
2. **Direct manipulation is a first-class way to state intent — not a second brain.** Dragging a card to a new slot expresses exactly one intent ("do this one later/sooner"), the same intent "let's do lateral raises next" expresses in the composer. Both must land on the **same canonical ActiveSession mutation path** — one state owner, two input surfaces. The sheet never computes its own plan.
3. **Gestures follow platform physics.** Pull-down with the finger, rubber-band past the last detent, snap to the nearest stop on release, flick to skip a stop. The sheet behaves like a native sheet, not like a web modal.

---

## 3. The Workout Sheet — interaction spec

### States and detents

Three detents, one gesture:

- **Closed (default).** Nothing on screen but the chat shell. In workout mode the **session pin** (the existing one persistent in-workout strip: current lift · sets done · next up) doubles as the pull handle and carries a quiet "pull down · today's workout" hint.
- **Center (the snap the owner described).** Pull the pin down; the sheet follows the finger. Released past the midpoint (or flicked down), it **snaps to ~58% of the viewport and stays** — chat dims below, composer still visible. This is the primary reading position: the whole session at a glance.
- **Full (~92%).** Keep pulling: the full plan with room for every exercise. Same gesture continues; no new control.

Release logic: flick velocity > threshold → next detent in the flick direction; otherwise nearest detent. Pulling past Full rubber-bands (0.25 resistance). Tapping the dim below the sheet, or flicking up, closes it. A grabber bar at the sheet's bottom edge re-arms the drag once settled.

### What the sheet shows

One card per plan item, in plan order, from the **same canonical session selectors** the session pin and plan card already read — no new data source:

- **Done** — check, muted, struck name, top-set summary (`4 sets · top 225×5 @2`). Not draggable.
- **Current** — ember load-line edge + ember-tinted ground, live set counter (`set 2/3 · next 70×8 @2`). Not draggable (moving the exercise you're mid-way through is a composer conversation, not a drag).
- **Pending** — slot number, last-session summary, and a **≡ drag handle**. Draggable.

Header: `TODAY · PUSH` + progress (`2 of 6 · 5 sets in`) + a thin session progress bar (the load-line signature). Footer note, always visible: *"drag ≡ to reorder · plan change only — nothing is written to Sheets."* RIR renders in ember everywhere (design-system rule).

### Drag-to-reorder rules

- Drag starts **only from the ≡ handle** (44px hit target) — so scrolling the plan never accidentally lifts a card.
- Only **pending** items reorder; done/skipped/current are pinned (mirrors the existing rule that completed/skipped slots are never re-matched by plan mutations — `planMutationIntent.js`).
- The lifted card scales up with a shadow; displaced cards animate apart; drop commits; slot numbers renumber; a toast confirms (*"Lateral Raise moved to slot 3 — plan updated"*).
- The drop dispatches the **existing canonical reorder mutation** on ActiveSession — the identical code path a typed reorder takes, so the session cursor, "next up" cue, and Session_Plans capture all stay consistent for free. The sheet contains **zero plan logic**.
- Accessibility: reduced-motion disables the spring/hint animations; a non-drag fallback (per-card up/down controls, or the composer sentence — which always works) ships in the same PR that ships drag.

### What the sheet is NOT

- Not a write surface. No save button, no approve button, nothing that touches Sheets. The preview→approve→write trust loop lives in the thread, untouched.
- Not a second recommendation engine. It renders state; it never computes.
- Not present outside workout mode. No active session → the pin is hidden → there is nothing to pull (the owner's brief scopes the gesture to workout mode).

---

## 4. Trust boundaries (why this is safe)

- **Reordering is a plan mutation, not a data write.** It changes the in-memory ActiveSession only — same as saying "do lateral raises next" today. No `write_id`, no Sheets call, no proof fields involved. Where plan events are captured (Session_Plans shadow lane), the reorder flows through whatever the canonical state already emits — the sheet adds no event vocabulary.
- **One state owner.** `activeSession` state remains the single source of truth; the sheet subscribes and renders. This is the same discipline that fixed the 372–379 reorder/cursor trust bugs — two views, one state, zero duplicated logic.
- **`test_mode`, proof fields, slash notation, undo:** untouched. The sheet never calls a write-capable route.

---

## 5. Finishing the shell (the "not at the forefront" clause)

Small, separable cleanup so the chrome matches the brief: the header's legacy settings gear and the Progress sub-tab bar stop competing with the conversation — Settings is already a drawer row; the subnav rows already live in the drawer as Views. Result: topbar = hamburger · wordmark · avatar, and *everything* else is behind the drawer. (Display-only; every existing element ID and tab-engine hook is preserved per `design/README.md` global rules.)

---

## 6. Design system

Everything uses the committed tokens (`design/README.md` / mockup 01): `#0A0B0E` ground, `#131419` surface, ember `#E8772E` accent + load-line signature, `#34C77B` for done, Space Grotesk display / JetBrains Mono numerals / Inter body, self-hosted fonts, CSP-safe (no inline `style=""` in the live build — the mockup's inline transforms become CSSOM writes, the pattern `drawer.js` already uses).

---

## 7. Phasing (tiny PRs, engine-before-surface, one concern each)

- **PR-0 (this): docs + mockup + backlog.** No code.
- **PR-1 — Sheet shell, display-only.** The pull gesture, three detents, snap physics, dim layer, and the read-only card list rendered from the existing canonical session selectors. No reorder yet. (High-risk file `src/app/app.js` is touched only for the mount point; the sheet is its own module like `drawer.js`.)
- **PR-2 — Drag-to-reorder.** The ≡ handle, lift/shift animation, drop → dispatch the existing canonical reorder mutation. Includes the reduced-motion + non-drag fallback and tests proving the composer path and the drag path produce identical state.
- **PR-3 — Shell cleanup (§5).** Header chrome into the drawer. Display-only.
- **Explicitly deferred (backlog, not built here):** swipe-on-card actions (skip/substitute by gesture), sheet-initiated substitutions, any peek/third-detent tuning beyond the three stops, haptics.

Each PR: `npm run lint && npm test`, Playwright coverage for the gesture states, `/review` before opening, `/qa` after PR-1 and PR-2 (frontend behavior changed).

---

## 8. Owner decisions required

None blocking the design — the direction is the owner's own brief. Two small forks are pre-decided here under PM authority and flagged for veto rather than asked:

1. **Current exercise is not draggable** (moving mid-exercise = a conversation). Veto → make it draggable in PR-2.
2. **The sheet exists only in workout mode** (per the brief's wording). Veto → a no-session variant could show today's *recommended* plan later; filed to backlog, not built.

The **go/no-go to start PR-1** is the owner's (code on the high-risk trust surface starts only from an explicitly authorized item).

---

## 9. What this explicitly does NOT change

- The preview→approve→write trust loop, proof fields, `test_mode` semantics, slash-notation parser, undo flow.
- The one-composer input model and the coach-first opener (this design *depends* on them).
- The engine's ownership of every number; the drawer's role as navigation.
- Google Sheets as the only store; no new endpoints; no schema change.
