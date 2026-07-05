# Atlas Flight Recorder — Design Spec

> **Governance layer:** Spec / design record. Subordinate to `docs/CONSTITUTION.md`, `docs/INVARIANTS.md`, and the trust contract. See `docs/GOVERNANCE.md` for the hierarchy.
>
> **Status:** owner-approved design (2026-07-05). Build proceeds as tiny PRs PR-FR1 → PR-FR5 (see Rollout). PR-FR1 (schema + contract + pure builder/ring/redaction) is the first slice; it wires **nothing** to a runtime path.

## Purpose

Atlas is in a real-world **One-Brain observation window**. `Brain_Shadow` and `Intent_Shadow` capture the engine/router **decision** trail, but they do **not** capture what the user actually **saw** in the app. Today the owner debugs by screenshots and pasted JSON — too slow and incomplete.

The Flight Recorder is an **optional, feature-flagged, append-only** logging system that records the **user-visible app experience and decision trail** during real sessions, so a developer can **replay** a session instead of reconstructing it from screenshots. It answers one question:

> **What did the user do, what did Atlas think, what did Atlas decide, and what exactly did Atlas show?**

## Non-negotiable contract

The Flight Recorder is **owner/debug telemetry, not training data**. It inherits the exact discipline of the shadow lanes (`services/brainShadow.js`, `services/intentShadow.js`):

- **Feature-flagged, default OFF** — `ATLAS_FLIGHT_RECORDER=1` (also accepts `true`/`on`). Unset → fully inert: no ring, no network, no rows, byte-identical app.
- **Append-only.** New columns are only ever added at the **end** (like `Bug_Reports`) — never insert or reorder.
- **Never touches the trust path.** No `write_id`, no preview→approve→write loop, and (once wired) writes **only** to the optional `Flight_Recorder` tab — never `Log_Cleaned`, `Effort`, `Modality_Log`, or any trust-contract tab.
- **Best-effort and TOTAL.** Every function is wrapped so it can never throw at a call site. A failed recorder write must never surface a user-visible error, never block the UI, never retry-storm, and never interrupt workout logging.
- **Redacted + truncated.** Secrets are stripped and large payloads summarized/truncated before anything becomes a row.

## Design principle: reuse, don't reinvent

~80% of the client-side capture already exists in `public/app.js`, but only as a **point-in-time snapshot** fired once on "Report Bug". The Flight Recorder is the **continuous, batched, durable** version of that same telemetry:

| Capability | Existing primitive | Location |
|---|---|---|
| API calls + latency + bodies | `atlasRecentApiRequests`, `api()` | `public/app.js` |
| UI action breadcrumbs | `atlasActionLog`, capture-phase click listener | `public/app.js` |
| Errors / cascades | `atlasRecentErrors`, `window.onerror`, `unhandledrejection` | `public/app.js` |
| Rendered UI state | `uiStateForBugReport()` | `public/app.js` |
| Active planned session | `activePlannedSession`, `getCanonicalSession()` | `public/app.js` |
| Secret redaction + truncation | `redactBugPayload`, `SECRET_VALUE_PATTERNS` | `services/bugReport.js` |
| Append-only best-effort mirror | shadow-lane pattern | `services/brainShadow.js`, `services/intentShadow.js` |
| Auto-create optional tab | `ensureSheetTab(tab, cols)` | `index.js` |

The recorder wraps these primitives; it does not duplicate them. Server-side redaction reuses `redactBugPayload` directly.

## 1. Storage — `Flight_Recorder` tab

New **optional** tab (`config/sheetContract.js` `optionalSheetTabs`; columns in `config/columns.js` as `flightRecorderColumns`). One row per event. Append-only.

**MVP schema — 18 columns (JSON-in-cells, owner-approved):**

```
captured_at | flight_session_id | seq | app_version | device_id |
route | event_type | user_input | user_action |
ui_snapshot_json | session_state_json |
api_endpoint | request_summary | response_summary |
decision_summary_json | shadow_refs_json |
error | latency_ms
```

- `flight_session_id` — one id per app load / observation session; the primary replay key.
- `seq` — monotonic per-session counter so events order deterministically even when a batch lands in the same millisecond (Sheets append order is not guaranteed under batching).
- `device_id` — stable random non-PII id in `localStorage`; blank if absent.
- `ui_snapshot_json` — a broad UI-state snapshot (not only rendered HTML/JSON): visible cards, visible tiles, active card, visible CTAs/buttons, modal shown, toast/banner shown, primary coach message shown, composer state. Named `ui_snapshot_json` (not `rendered_ui_json`) so it can grow to hold more UI state without a rename.
- `session_state_json` — `activePlannedSession`, `suggestedPlan`, `plannedExerciseOrder`, `sessionCompleted`, `remainingPlannedExercises`, `firstUnloggedPlannedLift`.
- `request_summary` / `response_summary` — **shape summaries, never raw field values.** `request_summary` is the body's top-level keys + size (e.g. `{message, notes} (412 chars)`); `response_summary` is the status. This deliberately keeps **workout content** (notes, weights, free text in `/api/log-workout` et al.) out of the debug tab — `redactBugPayload` scrubs *secret-shaped* values but not *workout data*, so the safe design emits no values at all. (Owner decision 2026-07-05, honoring the "prefer summaries for large JSON" guardrail; can be switched to full-redacted-body fidelity if the owner later prefers.)
- `decision_summary_json` — trimmed engine/router verdict where safe (the same trimmed shape `coachDecisionSummary.js` emits — never the full internal object).
- `shadow_refs_json` — `{ brain: {created, route, count}, intent: {created, route, count} }` (see §5).

**Why JSON-in-cells for MVP** (owner decision): keeps the contract stable as captured fields evolve (append-only friendly), matches how `Bug_Reports` already carries `Payload JSON`, and each cell stays well under the ~50k Sheets per-cell limit after truncation. Per-cell cap is 20,000 chars; scalar text fields cap at 2,000.

## 2. Event taxonomy

Ten `event_type` values. Each event populates only the columns it needs; the rest are blank.

| `event_type` | Fired when | Primary columns |
|---|---|---|
| `screen_rendered` | route/screen becomes visible | route, ui_snapshot_json, session_state_json |
| `user_input` | composer text / free-form message submitted | user_input, route |
| `user_action` | button/tile/tab tapped, nav | user_action, route |
| `api_request` | outbound call starts | api_endpoint, request_summary |
| `api_response` | call resolves/rejects | api_endpoint, response_summary, decision_summary_json, shadow_refs_json, latency_ms, error |
| `coach_message_rendered` | a coach reply is painted | ui_snapshot_json, decision_summary_json |
| `card_rendered` | a card/tile/preview/confirmation renders | ui_snapshot_json |
| `session_state_changed` | activePlannedSession / plan cursor / completion changes | session_state_json |
| `error` | JS error, unhandled rejection, or API failure | error, api_endpoint |
| `bug_marker` | owner taps "mark issue here" in Debug UX | user_action, user_input (note) |

`bug_marker` bridges to the bug flow: it drops a labeled pin **into the same transcript** so replay lands exactly where the owner flagged a problem.

## 3. Frontend capture points (`public/`)

A new `public/flightRecorder.js` (UMD, self-contained, never throws) owns a capped in-memory ring + batched flush. It taps existing hooks rather than adding new instrumentation:

- **`screen_rendered` / `card_rendered`** — hook render/nav functions (`public/nav.js` route switches; card/preview render in `public/app.js` and `public/coach-conversation.js`) via a `snapshotUiState()` helper (an extended `uiStateForBugReport()`).
- **`user_input` / `user_action`** — reuse the existing capture-phase click listener and composer submit.
- **`api_request` / `api_response` / `error`** — hook the single `api()` wrapper (already measures latency; already records into `atlasRecentApiRequests`). Reuse `snapshotBugBody()` for summaries.
- **`coach_message_rendered`** — hook the coach reply painter in `public/coach-conversation.js`.
- **`session_state_changed`** — fire on `activePlannedSession` / plan-cursor mutations (the same events `nav.js` already listens to).
- **`bug_marker`** — Settings → Debug button.

**Batching (owner-approved thresholds).** Unlike the low-volume shadow lanes (one row per chat message), the recorder is high-volume, so it must **not** append per event. The client buffers and flushes when **any** of:

- the buffer reaches **25 events**, or
- **every 10 seconds**, or
- **immediately** on an `error`, a `bug_marker`, or `pagehide`/`visibilitychange` (via `navigator.sendBeacon`).

This bounds Sheets API calls and keeps the flush off the render/save path.

**Trust-loop safety.** These are read/observe taps. `public/app.js` is restricted, so the PR that edits it must name it in scope; edits are additive `record()` calls in the api/render/coach branches only — no change to preview→approve→write, `test_mode`, proof fields, or the slash parser.

## 4. Backend / API capture points (`services/` + `index.js`)

- **`services/flightRecorder.js`** — mirrors the shadow lanes: `isFlightRecorderEnabled()`, capped in-memory ring, `buildFlightRow(event)` / `buildFlightRows(events)`, `redactFlightEvent` (reusing `redactBugPayload` — defense in depth; the server never trusts client redaction). *(PR-FR1 ships this as the pure core, unwired.)*
- **Server-side API-flow recorder** *(PR-FR2, shipped)* — `recordApiFlow(info, opts)` builds one `api_response` event per served request, rings it, and **best-effort** appends one row via the standard `sheets.appendRows` (fire-and-forget, self-swallowing — a missing tab / bad creds / transient error can never surface). A thin **observe-only middleware** in `index.js` (registered once, flag-gated, skips `/api/flight/*`) records on `res.on('finish')` — it never reads or mutates the response and never blocks the request. Because it appends via `appendRows`, which targets the server's own `GOOGLE_SHEETS_ID`, a **sandbox server records to the sandbox `Flight_Recorder` and a production server to production** — the recorder introduces no second sheet target. This is what makes the recorder work for **both** real app traffic and the simulation harness (which is just an HTTP client driving the server). Per-request best-effort append is consistent with the existing shadow-lane volume; server-side batching is a possible future optimization (filed in `BACKLOG.md`).
- **`GET /api/flight/recent`** *(PR-FR2, shipped)* — read-only (`writeCapable:false`); returns the in-memory ring + aggregates. Powers the Debug UX. Modeled on `GET /api/debug/brain-shadow`.
- **`POST /api/flight/ingest`** *(PR-FR3)* — the CLIENT batch sink for rich UI-only events (`ui_snapshot`, taps, coach renders) the server can't see. `writeCapable:true`, rate-limited, best-effort batched append, no-op when the flag is off. Ships with the frontend emitters (FR3) since it has no producer until then; the server-side recorder (FR2) already covers the API-flow backbone.
- **Shadow linkage enrichment** *(PR-FR3)* — the response envelope carries a tiny additive `_flight.shadow` block the client stamps onto its `api_response` event, riding the existing `standardSuccess` builder (no per-route surgery).

## 5. Linking to `Brain_Shadow` and `Intent_Shadow`

**MVP (no shadow-tab schema change — in scope):** per request, capture whether a Brain/Intent shadow entry was created, its `route`, and a `count`, into `shadow_refs_json` via the additive `_flight.shadow` response block. This answers "did the Brain/Intent lane fire on the call the user just made, and how many times", enough to jump to the right neighborhood of the shadow tab by `captured_at` + `route`.

### Sandbox / production sheet isolation

The Flight Recorder writes to **whichever sheet the server itself is configured for** (`GOOGLE_SHEETS_ID`) — it never hardcodes or picks a second target. Combined with the simulation model, this gives strict isolation:

- **Real production usage** → the production server records to the **production** `Flight_Recorder`.
- **Real usage on a sandbox server** / **simulation runs** (the harness drives a sandbox-pointed server) → the **sandbox** `Flight_Recorder`.
- Simulation **write** mode already **hard-refuses** any server not confirmed as the sandbox sheet (`verifyServerSheet`), so a sim can never drive a production server to write training data — or Flight Recorder rows.
- **Belt-and-suspenders guard:** the harness marks every request with `x-atlas-simulation: 1`, and `recordApiFlow` **never persists a simulation-marked request to a non-sandbox sheet** (it stays in the in-memory ring only). So even a *read-only* sim pointed at production can never write sim noise into the production `Flight_Recorder`.
- **Flag OFF (default)** → nothing is written anywhere, on any sheet.

**Full correlation (PR-FR5, owner-gated — NOT in initial scope):** mint a `correlation_id` per inbound request and append it as a new trailing column to `Brain_Shadow` and `Intent_Shadow` so a replay tool can join the three tabs on one exact key. This touches two existing tabs' schemas (append-only, low risk, but still a schema change) → owner approval required. Deferred by owner decision (2026-07-05).

## 6. Failure behavior

Identical discipline to the shadow lanes — the recorder is **TOTAL and INERT to the user flow**:

- Flag OFF (default) → fully inert.
- Every function self-swallows; it can never throw at a call site.
- The Sheets append is **fire-and-forget**: missing tab, absent creds, quota/429, or transient error is silently ignored. User flow continues, workout logging continues, the trust loop is untouched.
- **No retry storm.** One best-effort append per batch; on failure the batch is dropped (or retained in the client ring for the next flush, capped) — never an exponential retry loop against Sheets.
- No user-visible error unless an explicit debug mode is on (then only in the Debug panel).
- Non-blocking: batching + `sendBeacon` keep it off the render/save path.

## 7. Debug UX — Settings → Debug

Read-only surface backed by `GET /api/flight/recent` + the client ring:

- Current **`flight_session_id`** (copyable).
- **Last 20 Flight Recorder events** (event_type, route, latency, error), newest first.
- **Copy / export recent transcript** — dumps the ring as JSON to clipboard (reuses `exposeBugReportJson`'s pattern), so the owner hands over a replayable transcript instead of screenshots.
- **"Mark issue here"** — inserts a `bug_marker` row (with optional note), flushed promptly, so replay lands on the flagged moment.

## 8. Test plan

Follows Atlas invariants T1–T3 (require.cache stub of `sheets.js`); live-path coverage required.

- **`services/flightRecorder.js` unit** *(PR-FR1, shipped)* — row width equals the column contract; scalar/JSON field mapping; server-side re-redaction of planted secrets (`sk-…`, `AIza…`, `Bearer …`, `PRIVATE KEY`, secret-shaped keys); truncation of oversized cells and scalar text; empty objects → blank; non-finite numbers → blank; ring cap + newest-first; flag gate default-OFF; taxonomy exposure; TOTAL on hostile input (circular refs, junk types).
- **Server-side API-flow unit** *(PR-FR2, shipped — `test/flightRecorderApiFlow.test.js`)* — flag OFF → `recordApiFlow` writes nothing (disabled-flag proof); flag ON → one best-effort append to `Flight_Recorder` only, never a workout/trust tab; **isolation**: sim-marked traffic on a non-sandbox sheet is ring-only (never persisted) while sim-on-sandbox and real-on-any-sheet do persist; request bodies redacted + summarized; TOTAL (a throwing append never surfaces); plus a harness proof that sim requests carry `x-atlas-simulation`.
- **Route/middleware smoke (`test/api-smoke.test.js`)** *(PR-FR2, shipped)* — end-to-end over the real app: flag ON records an `/api` flow to `Flight_Recorder` only (never `Log_Cleaned`/`Effort`/`Modality_Log`); a simulation-marked request against the non-sandbox stub sheet writes **nothing** (isolation proof); flag OFF writes nothing; `GET /api/flight/recent` returns a safe inert snapshot.
- **Client ingest smoke** *(PR-FR3)* — `POST /api/flight/ingest` flag-gated batched append + isolation.
- **Shadow linkage** *(PR-FR3)* — `shadow_refs_json` reflects created/route/count when the observers fire.
- **Frontend** *(PR-FR3)* — source-introspection test that `record()` is wired at the api/render/coach hooks and flag-guarded; `sendBeacon` flush on `pagehide`; batching thresholds (25 / 10s / error+bug_marker+pagehide).
- **Regression** — proof-field invariants unchanged with the flag ON.

## 9. Rollout plan (tiny PRs, one concern each)

1. **PR-FR1 — schema + contract + pure core (no writes).** `Flight_Recorder` in `optionalSheetTabs`; `flightRecorderColumns`; `services/flightRecorder.js` builder + ring + redaction; unit tests. **Nothing writes; nothing is wired to a runtime path.** *(This slice.)*
2. **PR-FR2 — server-side API-flow recording + read route** *(shipped)*. `recordApiFlow` + a thin observe-only middleware in `index.js` (flag-gated, best-effort append to the server's own `Flight_Recorder`) + `GET /api/flight/recent`; the sim harness marks its traffic (`x-atlas-simulation`) and the recorder's isolation guard blocks sim writes to a non-sandbox sheet. Covers **both** real app traffic and simulation runs. (The client batch-ingest route moved to FR3, alongside its only producer — the frontend.)
3. **PR-FR3 — frontend capture + batching + client ingest.** `public/flightRecorder.js` + hooks (names `public/app.js` in scope); batched flush + `sendBeacon`; `POST /api/flight/ingest` for UI-only events; shadow-linkage enrichment.
4. **PR-FR4 — Debug UX.** Settings → Debug surface incl. `bug_marker`.
5. **PR-FR5 (owner-gated) — full `correlation_id`** across `Brain_Shadow` / `Intent_Shadow` (append-only schema change).

Enable only during owner/debug observation windows via `ATLAS_FLIGHT_RECORDER=1`; default OFF everywhere else. Each PR ships behind the flag, so `main` behavior is unchanged until the owner flips it on.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Sheets write storm / quota exhaustion | Client batching (25 / 10s / beacon); one append per batch; no per-event write; no retry loop. |
| Secret leakage into a durable tab | Client redaction **and** mandatory server re-redaction (`redactBugPayload`); summaries not raw bodies; never log API keys/headers; no image/audio blobs (multipart summarized by field name). |
| Perf / UI jank on the workout path | Off the render/save path; capped ring; async flush; flag OFF by default. |
| Touching restricted `public/app.js` / trust loop | Additive observe-only `record()` calls; PR names the file in scope; proof-field regression tests; no `test_mode`/parser/undo change. |
| Cell-size overflow (~50k limit) | Per-cell truncation (20k) + JSON summaries + oldest-body shedding. |
| PII / owner privacy | Single-owner app; `device_id` is a random non-PII id; tab labeled owner/debug telemetry; default OFF; ephemeral by intent. |
| Schema drift on shadow tabs (full correlation) | Append-only trailing column; owner-gated (PR-FR5); MVP linkage needs no schema change. |

## Recommendation: build before further simulator expansion

**Yes — the thin vertical slice (PR-FR1 → FR3) before expanding the simulator.** The owner's current bottleneck is real-device debugging by screenshots, which the simulator cannot reproduce (stale shell, toast timing, modal state, real latency). The shadow lanes already capture the decision trail but explicitly not what the user saw; the Flight Recorder closes exactly that gap and makes existing shadow data replayable in context. It is low-risk and cheap (most capture already exists; the persistence pattern is proven twice; flag-gated OFF; append-only; never touches the trust loop). Keep it tiny and staged: land FR1–FR3 behind the flag, validate one real observation session, then decide whether full correlation (FR5) or more simulator work is the better next investment.

## Owner decisions (2026-07-05)

- JSON-in-cells for the MVP schema. ✅
- Batching thresholds: flush at 25 events, every 10 seconds, and immediately on error / bug_marker / pagehide. ✅
- Full `correlation_id` **excluded** from initial scope; FR5 remains a later owner-gated follow-up. ✅
- Proceed with `docs/FLIGHT_RECORDER_SPEC.md` + backlog entry, then build PR-FR1 only (schema + contract + pure builder/ring/redaction tests; no runtime writes). ✅
