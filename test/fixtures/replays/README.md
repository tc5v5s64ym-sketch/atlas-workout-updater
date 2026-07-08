# Flight-Recorder replay fixtures

Each `.json` file here is a **recorded Flight-Recorder session export** — shaped
after the real event taxonomy in [`docs/FLIGHT_RECORDER_SPEC.md`](../../../docs/FLIGHT_RECORDER_SPEC.md)
§2 (`event_type`, `route`, `user_input`, `user_action`, `session_state`,
`ui_snapshot`) — that `test/flightRecorderReplay.test.js` replays through the real
client/session-state-machine functions via `test/helpers/flightReplay.js`, and
asserts the outcome matches what's recorded as `expected`.

This turns a real gym-session bug into a permanent, data-driven regression test:
the fixture *is* the test case. No new fixture requires touching the harness
code — unless it's a genuinely new kind of scenario (see below).

## Fixture schema

```json
{
  "id": "add-N-short-name",
  "scenario": "one-of-the-registered-scenario-names",
  "source": "docs/PR10_REGRESSION_ADDENDUM.md #N",
  "description": "One sentence: what must hold, in plain terms.",
  "events": [
    { "event_type": "...", "...": "..." }
  ],
  "expected": { "...": "..." }
}
```

- `scenario` — must match a key in `ADAPTERS` (`test/helpers/flightReplay.js`).
  Six exist today, one per fixed [`PR10_REGRESSION_ADDENDUM.md`](../../../docs/PR10_REGRESSION_ADDENDUM.md)
  case: `restored-session-discard` (ADD-1), `plan-skip` (ADD-2),
  `substitute-satisfies-slot` (ADD-4), `identity-correction-guard` (ADD-5),
  `recap-reconciliation` (ADD-6), `coach-message-not-blank` (ADD-7). ADD-3 has no
  fixture — it's not fixed yet (owner-reserved new capability, pending the Atlas
  Decision Desk verdict on issue #914; see `BACKLOG.md` "ADD-3").
- `events` — an array of Flight-Recorder-shaped events. Each adapter reads only
  the fields its scenario needs (see the adapter functions in `flightReplay.js`
  for the exact fields each one looks at) — extra fields are fine and encouraged
  for realism/context, they're just ignored.
- `expected` — a plain object the adapter's return value must `assert.deepEqual`
  against. Shape is scenario-specific (see the adapter's return statement).

## Converting a real recorded session into a fixture

1. **Capture it.** With `ATLAS_FLIGHT_RECORDER=1`, reproduce the bug, then use
   Settings → "Flight Recorder (debug)" → **Copy transcript** (or `GET
   /api/flight/recent`, which returns `{ entries: [...] }` — the same shape) to
   get the raw recorded events for that session.
2. **Trim to the relevant events.** A real transcript has far more events than a
   fixture needs (screen renders, unrelated API calls). Keep only the ones the
   scenario's adapter actually reads — e.g. the `session_state_changed` event
   carrying the state right before the bug, and the `user_input`/`user_action`
   event that triggers it. Real `request_summary`/`response_summary` fields are
   shape-only by design (FR never records raw workout content) — don't add raw
   values back in; a fixture should carry no more real user content than FR
   itself would ever record.
3. **Does an existing `scenario` fit?** If the bug is another instance of an
   already-fixed case (e.g. a different exercise pair hitting the same
   `identity-correction-guard` logic), just write the new fixture JSON — no code
   change needed. Drop it in this directory with a new `id` and it's picked up
   automatically (`flightRecorderReplay.test.js` reads every `*.json` file here).
4. **New kind of scenario?** Add one adapter function to `test/helpers/flightReplay.js`
   (register it in the `ADAPTERS` map) that knows which real function(s) to
   drive and how to pull inputs out of `events`. If it needs to run app.js
   (a classic, non-modular script) rather than a plain ES module, add a harness
   builder to `test/helpers/appSliceHarness.js` — copy the slice markers and
   shim shape from whichever existing regression-lock test already exercises
   that code path (see the comment at the top of `appSliceHarness.js`); don't
   reinvent the slicing, so the replay stays faithful to already-proven
   coverage.
5. **Write the `expected` block from a real passing run**, not from memory — run
   the new fixture once, print the adapter's actual return value, and copy that
   in (after confirming it's actually correct, not just what the code happens to
   currently do). Getting the exact array order or event list wrong is the most
   common way a fixture silently asserts the wrong thing.

## Constraints (same as the harness itself)

Replay is read-only: no live Sheets access, no LLM calls, no network of any
kind — every adapter drives a pure function or a fake-DOM-backed one with
literal fixture data as input. Fixtures must never carry more than
Flight-Recorder itself would ever capture (shape summaries, not raw workout
content) — this is owner/debug telemetry shape, not training data.
