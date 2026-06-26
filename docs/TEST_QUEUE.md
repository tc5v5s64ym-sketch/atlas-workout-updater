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

### LT-005 — coach interleaves per-lift blocks (FA)

| Field | Value |
|---|---|
| **Test ID** | LT-005 |
| **Related PR / feature** | FA — coach renders per-lift blocks (card → coaching → Next) in order |
| **Shell / app version expected** | Shell v57+ (server build with the FA coach-render change deployed) |
| **Steps** | Log two exercises in one entry (e.g. Back Squat + Overhead Press). |
| **Expected result** | Back Squat card, then its coaching, then its "Next"; THEN Overhead Press card, its coaching, its "Next"; then "Moving on — next up: X." once at the end. Each exercise is its own complete block in logged order — NOT both cards then a combined coaching paragraph. Single-exercise entries read exactly as before. |
| **Screenshot** | The ordered per-exercise blocks. |
| **Owner result** | PASS / FAIL — |
| **Follow-up if FAIL** | If cards are still batched before the coaching, capture the entry + the rendered order. |

---

## Completed

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
