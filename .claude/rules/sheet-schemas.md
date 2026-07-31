---
paths:
  - "config/columns.js"
  - "config/sheetContract.js"
  - "sheets.js"
  - "index.js"
  - "routes/sessionPlans.js"
  - "routes/coachOps.js"
  - "services/sessionPlan*.js"
  - "services/deloadState.js"
  - "services/closeoutFinality.js"
  - "services/flightRecorder.js"
  - "services/driftShadow.js"
  - "services/turnCorrelation.js"
  - "services/turnWriteArtifact.js"
---

# Sheet schemas

Moved verbatim from `CLAUDE.md` so it loads when a file that defines, writes, or validates a Sheet row is opened, instead of in every session. The rule is unchanged; `CLAUDE.md` keeps a one-line pointer.

Scope note: the `paths` list covers the files that construct, append, or validate a row of one of the five documented tabs — derived by sweeping for `appendRows`/range writes, for imports of `config/columns.js`, and for references to the tab names themselves. Shadow and telemetry sheets (`brainShadow`, `intentShadow`, `coachShadowSheet`, `coachResponseSheet`, `sessionPlanSetsStore`) write their own tabs, which this rule does not document, so they are excluded.

Drift note: a `paths` list is an enumeration and a new row writer added later will not match it. The always-on backstop is the one sentence kept in `CLAUDE.md` — no columns may be added, removed, or reordered without a migration and explicit owner approval. A missed path costs the preloaded layouts, never the rule itself.

No columns may be added, removed, or reordered without a migration and explicit owner approval. `config/columns.js` and the relevant sheet contract are authoritative.

### `Log_Cleaned` — 12 columns

```text
date_clean | session_id | exercise | canonical_exercise | muscle_group | lift_code | set_number | weight | reps | rir | notes | volume_calc
```

### `Effort` — 9 columns

```text
date | session_id | duration | active_calories | total_calories | average_hr | peak_hr | location | notes
```

`average_hr` and `peak_hr` are distinct.

### `Constraints` — 5 columns

```text
date | kind | target | rule | note
```

Use the vocabulary and validation in `config/columns.js` and the active reader/writer; do not invent row conventions.

### `Deload_State` — 7 columns

```text
updated_at | training_state | deload_protocol | deload_reason | deload_start_date | deload_sessions_remaining | deload_exit_criteria
```

Append-only system state.

### `Session_Plans` — 13 columns

```text
idempotency_key | session_id | session_date | plan_version | event_type | plan_item_id | planned_order | planned_lift_code | movement_pattern | outcome | performed_lift_code | closeout_status | recorded_at
```

Append-only, deterministic idempotency, canonical lift codes, and plan-item identity. It does not pass through the logged-set preview/write loop.
