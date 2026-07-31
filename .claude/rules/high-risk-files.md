---
paths:
  - "index.js"
  - "src/app/app.js"
  - "services/workoutTextParser.js"
---

# High-risk files

Moved verbatim from `CLAUDE.md` so it loads when one of these three files is opened, instead of in every session. The rule is unchanged; `CLAUDE.md` keeps a one-line pointer.

These may be touched only when the active card explicitly requires them, with a tiny focused diff and live-path tests:

- `index.js` — write path, `test_mode`, proof fields, enrichment/append orchestration
- `src/app/app.js` — preview → approve → write trust loop and major client state
- `services/workoutTextParser.js` — slash notation and parser grammar

Editing the file is not automatically owner-reserved; changing its protected contract is.

**app.js freeze rule (Phase 2, owner-adopted 2026-07-20).** `src/app/app.js` (H-21, ~7,800 lines) is frozen for **new session-state logic**: no new session-state store, session-truth selector, or truth-derivation may be added here. New session-state logic goes in a dedicated module (`src/app/activeSession.js`, a `services/` contract, etc.) and is imported. Bug-fix edits, comments, and labels on existing code are fine; growing the shell's session-state surface is not. Enforced by review now; the app.js extraction lands in Phase 5.
