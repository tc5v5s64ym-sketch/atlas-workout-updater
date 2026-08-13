# Atlas Product Constitution

> **Governance layer:** Constitution — see [`docs/GOVERNANCE.md`](GOVERNANCE.md) for the full hierarchy.

## Mission

**Track Less. Understand More.**

Atlas is Dale's personal training intelligence. It exists to reduce the friction of recording real gym work and surface the patterns that make the next session better.

## What Atlas Is

- A **chat-first workout logger** that accepts natural-language input, parses it, previews it, and writes it to Google Sheets on explicit approval.
- A **personal intelligence layer** over a single owner's training history, backed by one spreadsheet as the permanent record.
- A **fast, opinionated tool** optimised for the moment between sets — one input, one confirmation, done.

## What Atlas Is Not (this phase)

- A nutrition tracker.
- A voice interface.
- A multi-user platform.
- A database migration project.
- An "Atlas Brain" autonomous agent.
- A generic fitness API or white-label product.

None of the above will be built in the current phase. "Multi-user platform" and "generic fitness API" are current-phase constraints, not permanent limits — see "The Dream" in `docs/ATLAS_PRODUCT_VISION.md` for where Atlas may eventually grow. Do not build any of these until the owner explicitly directs it.

## The Magic Moment

> Between sets, the athlete types `225 5/2 bench` and Atlas reacts instantly — a readback and coaching — writing nothing. At the end of the session ("done", an Apple Watch screenshot, or manual effort) Atlas compiles the whole conversation into one review → owner approves → the session is written → confirmation shows with an undo button.

Everything in the codebase exists to make that loop **fast, correct, and trustworthy**. Any change that slows the loop, introduces ambiguity, or risks a silent incorrect write is wrong regardless of how well-intentioned it is.

## Slash Notation — The Parser Contract

`225 5/2` means **225 lb × 5 reps @ RIR 2**.

- The slash separates `reps` from `RIR`. It never means `reps × set-count`.
- This is a product decision, not a configurable preference.
- Parser behaviour is governed by golden-path test coverage. Changes to the parser require new golden tests before the PR lands.

## Logging Heartbeat

Logging is **session-level, not per-set**. During a workout, Atlas coaches each logged set in the conversation — a readback and guidance — and writes nothing. The session is committed **once**, on an explicit end trigger ("done"/"log it", an Apple Watch screenshot, or manual effort), through a single trust-loop cycle:

```
conversation (sets coached, nothing written) → end trigger → compile the session
  → dry-run preview (test_mode=true) → owner approves → live write → read-back proof → undo available
```

The safety law is unchanged: no blind writes, the dry-run never touches the sheet, the owner approves before any write, the live write is provable via `sheet_written` and `log_rows_written`, and undo is available. Only the **cadence** moved — from a write per set to one write per session. There must be **no per-set save prompts** during the workout; coaching during, one save at the end.

## Source of Truth

**Amended by owner instruction 2026-08-07, and again by owner correction 2026-08-13.** The
text below is the owner's direction and nothing wider; it is recorded in
`docs/ATLAS_V1_EXECUTION_PLAN.md`.

Storage authority is **per concept**, and each concept has exactly one live authority:

- **Supabase wins** for the migrated workout hot path — workout sessions and their identity,
  logged sets, Effort, accepted plans and plan events, plan sets and revisions, item
  outcomes, closeout, and write receipts and idempotency — **and for the exercise catalog**.
- **Google Sheets wins** for every concept that has not migrated. For those, Sheets is the
  permanent record, the app reads from it and writes to it, and if Sheets and the app
  disagree, Sheets wins.
- **Google Sheets is the export mirror** for the migrated concepts. It is human-readable, it
  is never required for an active workout to read, save, verify, or close out, and an export
  failure may create backlog but may never invalidate a workout.

**A Google Sheets quota of any kind must not invalidate or block an active workout or the
Phase 4 test campaign.** For a migrated concept there is no synchronous Sheets call on the
workout path, no fallback from Supabase to Sheets, no staleness clock, and no cache standing
in for the authority.

**The exercise catalog is edited only by the owner**, through an explicit owner-run command
against Supabase. The runtime may read it and may not change it.

Until a concept's cutover is complete, Google Sheets remains its live authority whatever the
repository already contains. Building a destination does not move an authority.

## Ownership

Atlas has one owner: Dale. Decisions about scope, schema, and priorities belong to him. This document records those decisions so AI agents and future contributors do not re-litigate them.
