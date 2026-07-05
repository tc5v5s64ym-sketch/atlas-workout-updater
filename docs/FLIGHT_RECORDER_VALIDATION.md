# Flight Recorder — Live Validation Checklist

> **Purpose:** validate the completed Flight Recorder core (FR1–FR4) against a real session on the **sandbox** sheet before considering a production owner-debug run. Full design: [`FLIGHT_RECORDER_SPEC.md`](./FLIGHT_RECORDER_SPEC.md).
>
> **Scope:** validation only. Do **not** enable this against the production sheet for this run. The feature flag is default-OFF; nothing writes until you turn it on.

---

## 1. Exact `Flight_Recorder` header row

Create a tab named exactly **`Flight_Recorder`** and paste this as **row 1** (tab-separated → fills A1:R1). 18 columns, in this order — do not reorder:

```
captured_at	flight_session_id	seq	app_version	device_id	route	event_type	user_input	user_action	ui_snapshot_json	session_state_json	api_endpoint	request_summary	response_summary	decision_summary_json	shadow_refs_json	error	latency_ms
```

| # | Column | # | Column |
|---|---|---|---|
| A | captured_at | J | ui_snapshot_json |
| B | flight_session_id | K | session_state_json |
| C | seq | L | api_endpoint |
| D | app_version | M | request_summary |
| E | device_id | N | response_summary |
| F | route | O | decision_summary_json |
| G | event_type | P | shadow_refs_json |
| H | user_input | Q | error |
| I | user_action | R | latency_ms |

## 2. Sandbox setup

1. Confirm the server you'll test is pointed at the **sandbox** sheet — its `GOOGLE_SHEETS_ID` must equal the known sandbox sheet id (`services/*` treats only that id as `isSandboxSheet`). If it points anywhere else, stop — this run must be sandbox-only.
2. In that sandbox spreadsheet, add the `Flight_Recorder` tab with the header row from §1. (Until the tab exists, appends fail silently/best-effort — no error, but no rows either.)
3. Leave every trust tab untouched: `Log_Cleaned`, `Effort`, `Modality_Log`, `Constraints`, `Deload_State` are never written by the Flight Recorder.

## 3. Render env flag steps

1. In the sandbox service's Render **Environment** settings, add: `ATLAS_FLIGHT_RECORDER=1`.
2. (Optional) `ATLAS_FLIGHT_RATE_LIMIT_MAX` (default `600` / 10 min) — the ingest route has its **own** rate-limiter bucket, so telemetry never draws from the trust-write budget; leave default for validation.
3. Redeploy so the new env var is live.
4. Hard-reload the app (or bump past the cached shell) so the client picks up the running build; the Flight Recorder client self-activates only after the server reports the flag on.

## 4. App Debug UX verification

Open the app → **Settings → "Flight Recorder (debug)"**:

1. State line reads **`ON`** and shows a **session id** (`FR-…`). *(If it reads `OFF`, the flag/redeploy or the sheet pointer isn't in effect.)*
2. Interact with the app for ~30–60s: open the app, tap tabs/buttons, type a workout into the composer and preview/log a set, ask the coach a question.
3. Tap **Refresh events** → the last-20 list populates, newest first.
4. Tap **Copy transcript** → a JSON dump lands on the clipboard (paste somewhere to confirm it's the redacted ring).

## 5. Expected event types

Across a normal session you should see a mix of these in the tab and/or the Debug list:

- `screen_rendered` — on load / surface changes
- `user_action` — taps (buttons, tabs, tiles)
- `user_input` — composer submit
- `api_response` — one per served `/api` call (with `latency_ms`; server-side lane)
- `coach_message_rendered` — a coach reply painted
- `card_rendered` — a preview/confirmation card
- `session_state_changed` — set logged / plan mutated / session reset
- `error` — only if a JS error/unhandled rejection occurs
- `bug_marker` — only when you use "Mark issue" (§6)

Spot-check a row: `request_summary` should be a **shape summary** (top-level keys + size, e.g. `{message, context} (…chars)`), **never** raw workout content or secrets. `ui_snapshot_json` / `session_state_json` should hold compact JSON.

## 6. `bug_marker` verification

1. In the Debug card, type a short note (e.g. "test marker") and tap **Mark issue**.
2. The card confirms "Issue marked in session `FR-…`".
3. Tap **Refresh events** → a `bug_marker` row appears with your note in `user_input`.
4. In the sandbox `Flight_Recorder` tab, confirm a `bug_marker` row landed with the same `flight_session_id`.

## 7. Flag-off verification

1. Set `ATLAS_FLIGHT_RECORDER=0` (or remove it) in Render and redeploy.
2. Hard-reload the app → Settings → Debug card state reads **`OFF`** and shows no session id.
3. Interact with the app, tap **Refresh events** → "Flight Recorder is OFF" copy; **no new rows** append to the `Flight_Recorder` tab.
4. Confirm the app behaves exactly as before (byte-identical): logging, preview→approve→write, undo, and coach all unchanged.

## 8. Pass / fail criteria

**PASS** requires all of:

- [ ] Flag ON → Debug card shows `ON` + a session id.
- [ ] Rows append to the **sandbox** `Flight_Recorder` tab only — **zero** rows in any trust tab (`Log_Cleaned`/`Effort`/`Modality_Log`).
- [ ] The expected event types (§5) appear across a normal session, with correct `captured_at`, `event_type`, `route`, and `latency_ms` on `api_response`.
- [ ] `request_summary` is shape-only — no raw workout content, no secrets/API keys anywhere in any row (§5 spot-check + the Copy-transcript dump).
- [ ] `bug_marker` round-trips (Debug note → tab row, same `flight_session_id`).
- [ ] Copy transcript produces valid, readable JSON.
- [ ] Flag OFF → `OFF` state, no new rows, app byte-identical.
- [ ] Normal workout logging + trust loop worked normally throughout, with **no** user-visible errors or slowdowns caused by the recorder.

**FAIL** if any of: rows land in a trust tab; a real workout write is blocked/429'd/slowed by telemetry; raw workout content or a secret appears in a row; a recorder error surfaces to the user; or the app behaves differently with the flag on vs off (beyond the telemetry itself).

---

## After the run

Report PASS/FAIL with any anomalies. Then the owner decides the next step (per the standing plan): (1) a brief production owner-debug enable, (2) fix issues found, (3) start FR5 `correlation_id`, or (4) start shadow-linkage enrichment. No further Flight Recorder development happens until then.
