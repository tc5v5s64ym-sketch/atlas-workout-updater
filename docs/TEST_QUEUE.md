# Atlas — Owner Live-Validation Queue

This file is the **owner-only** queue for live tests that cannot be automated — tests that require a real device, a real gym session, real credentials, or first-use confirmation of a gate that only fires once.

Each card is filed by Claude Code (or CODEX Review) when a feature ships but needs a live human confirmation before it is considered fully closed. The owner marks PASS or FAIL and notes any follow-up.

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

### LT-001 — Decision Desk author-association gate

| Field | Value |
|---|---|
| **Test ID** | LT-001 |
| **Related PR / feature** | Decision Desk author-association gate (`.github/workflows/codex-decision-desk.yml`) |
| **Shell / app version expected** | Any version with the Codex Decision Desk workflow active |
| **Steps** | 1. Open (or create) a PR that contains a `## 🧭 Codex Decision Request` comment posted by the Claude Code builder identity. 2. Observe whether the `codex-decision-desk` workflow triggers and responds. 3. Note the `author_association` value logged in the workflow run (visible in Actions → the triggered run). |
| **Expected result** | The gate correctly allows the builder identity (`OWNER`, `MEMBER`, or `COLLABORATOR` association) and the desk fires and returns a verdict. If the builder posts as `NONE`/`CONTRIBUTOR`, the desk is silently inert (fail-closed, never an implicit "yes") — in that case the fix is a precise login allowlist (do NOT loosen to `NONE` broadly). |
| **Screenshot** | — |
| **Owner result** | PASS / FAIL — |
| **Follow-up if FAIL** | If gate silently inert: add the builder bot's exact GitHub login to the `if` condition allowlist in the workflow. File a PR (workflow-only change, `[infrastructure]`). |

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
