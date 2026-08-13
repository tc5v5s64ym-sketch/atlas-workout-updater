const logCleanedColumns = [
  'date_clean',
  'session_id',
  'exercise',
  'canonical_exercise',
  'muscle_group',
  'lift_code',
  'set_number',
  'weight',
  'reps',
  'rir',
  'notes',
  'volume_calc'
];

const logRowFieldAliases = {
  date_clean: ['date_clean', 'dateClean', 'date'],
  session_id: ['session_id', 'sessionId'],
  exercise: ['exercise'],
  canonical_exercise: ['canonical_exercise', 'canonicalExercise'],
  muscle_group: ['muscle_group', 'muscleGroup'],
  lift_code: ['lift_code', 'liftCode'],
  set_number: ['set_number', 'setNumber', 'set'],
  weight: ['weight'],
  reps: ['reps'],
  rir: ['rir'],
  notes: ['notes'],
  volume_calc: ['volume_calc', 'volumeCalc', 'volume']
};

const effortColumns = [
  'date',
  'session_id',
  'duration',
  'active_calories',
  'total_calories',
  'average_hr',
  'peak_hr',
  'location',
  'notes'
];

const exerciseCatalogColumns = ['Exercise', 'Muscle_Group', 'Lift Code', 'Canonical_Exercise'];

const coachingNotesColumns = ['date', 'note'];

const constraintsColumns = ['date', 'kind', 'target', 'rule', 'note'];

// Deload_State — the persisted training-state record for the deload system
// (docs/DELOAD_SPEC.md, "DELOAD STATE"). Append-only: each state change appends
// a row, and the current state is the last row. This keeps an audit trail (the
// spec requires the system be auditable) and fits the append-only sheets model.
// These writes are system state, NOT logged sets — they never route through the
// preview→approve→write trust loop or the write_id log path.
const deloadStateColumns = [
  'updated_at',
  'training_state',
  'deload_protocol',
  'deload_reason',
  'deload_start_date',
  'deload_sessions_remaining',
  'deload_exit_criteria'
];

// Session_Plans — the durable, append-only record of ACCEPTED/FINAL plan state
// (Decision Desk #952, owner-approved Option A). Event-sourced: `plan_accepted`
// item events are written when a plan is accepted; `item_outcome` and
// `session_closeout` events are appended later. Prior rows are NEVER mutated; the
// reader (PR-C) folds by (session_id + plan_version + plan_item_id), last-wins.
// Column order is OWNER-APPROVED (do not add/remove/reorder without a schema
// migration + owner approval). Like Constraints/Deload_State/Modality_Log it is a
// system-state tab, NOT logged sets — these writes never route through
// preview→approve→write, carry no write_id, and never touch Log_Cleaned/Effort.
// Canonical lift CODES only (never free-text lift identity); no loads/reps/RIR/
// progression data in this first version.
const sessionPlansColumns = [
  'idempotency_key',
  'session_id',
  'session_date',
  'plan_version',
  'event_type',
  'plan_item_id',
  'planned_order',
  'planned_lift_code',
  'movement_pattern',
  'outcome',
  'performed_lift_code',
  'closeout_status',
  'recorded_at'
];

// Session_Plan_Sets — the SET-LEVEL recommendation ledger (owner-approved contract
// docs/SESSION_PLANS_LEDGER_DESIGN.md §2). Supabase stores it alongside the item-level
// Session_Plans spine, joined by (session_id, plan_version,
// plan_item_id). Grain = set × revision: one row per (plan item, set_index, version).
// Append-only and immutable per set once effective — a REVISION never mutates a prior
// row; it appends a new row with plan_version+1 and supersedes_key = the superseded
// row's key. Stores RECOMMENDATIONS ONLY (never a performed/actual value — those live
// in Log_Cleaned; an actual is never copied back and labeled the plan). Like
// Session_Plans/Constraints/Deload_State it is system state, NOT logged sets:
// these writes never route through preview→approve→write and carry no log write_id
// (closeout stamps closeout_write_id only to SEAL a row, never as its first write).
// Canonical lift CODES only. Column order is OWNER-APPROVED: new columns are only
// ever appended at the end; never insert or reorder without a migration + owner approval.
const sessionPlanSetsColumns = [
  'idempotency_key',
  'session_id',
  'session_date',
  'plan_version',
  'plan_item_id',
  'planned_lift_code',
  'set_index',
  'target_set_count',
  'target_weight',
  'target_reps',
  'target_rir',
  'recommendation_source',
  'supersedes_key',
  'confidence',
  'closeout_write_id',
  'recorded_at'
];

// Modality_Log — the persistence target for NON-slash modality logs recognized by
// services/multiModalityParser.js (timed holds / steady cardio / cardio intervals
// / circuits — PR 486). This is a NEW typed sibling tab; it leaves the 12-col
// Log_Cleaned and 9-col Effort schemas untouched. Like Constraints/Deload_State it
// is OPTIONAL (config/sheetContract.js) — the future write route returns 503 until
// the tab exists.
//
// One row per recognized modality entry; the `modality` column is the discriminator
// that tells you how to read the shared metric columns:
//   timed_hold     → duration_sec = hold length, rounds = sets
//   cardio_steady  → duration_sec = elapsed/duration, distance_m, level (machine)
//   cardio_interval→ rounds, duration_sec = per-rep work time, distance_m = per-rep
//                    work distance, rest_sec = rest between rounds
//   circuit        → exercise = kind label (AMRAP/EMOM/…), duration_sec = time cap,
//                    rounds, notes = movement list
// Unused columns for a given modality are left blank. NOTE: column design is
// owner-reviewable before any write is wired (PR 486 slice 4b) — slice 4a defines
// the contract only; nothing is written yet.
const modalityLogColumns = [
  'date',
  'session_id',
  'modality',
  'exercise',
  'duration_sec',
  'distance_m',
  'rounds',
  'rest_sec',
  'level',
  'rpe',
  'avg_hr',
  'notes'
];

const modalityLogRowFieldAliases = {
  date: ['date', 'date_clean', 'dateClean'],
  session_id: ['session_id', 'sessionId'],
  modality: ['modality'],
  exercise: ['exercise'],
  duration_sec: ['duration_sec', 'durationSec', 'duration'],
  distance_m: ['distance_m', 'distanceM', 'distance'],
  rounds: ['rounds'],
  rest_sec: ['rest_sec', 'restSec', 'rest'],
  level: ['level'],
  rpe: ['rpe'],
  avg_hr: ['avg_hr', 'avgHr', 'average_hr', 'averageHR'],
  notes: ['notes']
};

// Flight_Recorder — the Atlas Flight Recorder's append-only session transcript
// (docs/FLIGHT_RECORDER_SPEC.md). An OPTIONAL, feature-flagged (ATLAS_FLIGHT_RECORDER=1,
// default OFF) debug/observation surface that records the USER-VISIBLE app experience
// and decision trail during real sessions — answering "what did the user do, what did
// Atlas think, what did Atlas decide, and what exactly did Atlas show?". One row per
// event; append-only (new columns ONLY ever added at the END so historical rows stay
// aligned — never insert or reorder, same rule as Bug_Reports).
//
// These are owner/debug TELEMETRY rows, NOT logged sets: they never touch
// Log_Cleaned/Effort/Modality_Log, carry no write_id, and never route through the
// preview→approve→write trust loop. The four *_json columns hold compact, redacted,
// truncated JSON summaries (MVP schema decision — keeps the contract stable as captured
// fields evolve, like Bug_Reports' Payload JSON), each well under the ~50k Sheets
// per-cell limit. Same schema-migration rule as every other tab: do not add, remove, or
// reorder columns without explicit owner approval.
//   captured_at        — ISO timestamp the event was captured (client clock)
//   flight_session_id  — one id per app load / observation session (the replay key)
//   seq                — monotonic per-session counter (deterministic order under batching)
//   app_version        — shell/app version string
//   device_id          — stable non-PII device id if available (else blank)
//   route              — route / screen name visible when the event fired
//   event_type         — one of the taxonomy below
//   user_input         — user text (composer / free-form message / bug-marker note)
//   user_action        — button/tile/tab tapped or nav action
//   ui_snapshot_json   — visible cards/tiles, active card, CTAs, modal, toast, coach message,
//                        composer state (a broad UI snapshot, not only rendered HTML/JSON)
//   session_state_json — activePlannedSession/suggestedPlan/plannedExerciseOrder/…
//   api_endpoint       — endpoint called (api_request/api_response)
//   request_summary    — redacted/truncated request summary (not a raw body)
//   response_summary   — redacted/truncated response summary (status + shape + key fields)
//   decision_summary_json — trimmed engine/router decision summary where safe
//   shadow_refs_json   — { brain:{created,route,count}, intent:{created,route,count} }
//   error              — short error/warning string (blank when none)
//   latency_ms         — round-trip latency for api_response, else blank
const flightRecorderColumns = [
  'captured_at',
  'flight_session_id',
  'seq',
  'app_version',
  'device_id',
  'route',
  'event_type',
  'user_input',
  'user_action',
  'ui_snapshot_json',
  'session_state_json',
  'api_endpoint',
  'request_summary',
  'response_summary',
  'decision_summary_json',
  'shadow_refs_json',
  'error',
  'latency_ms'
];

const effortRowFieldAliases = {
  date: ['date'],
  session_id: ['session_id', 'sessionId'],
  duration: ['duration'],
  active_calories: ['active_calories', 'activeCalories'],
  total_calories: ['total_calories', 'totalCalories'],
  average_hr: ['average_hr', 'averageHR', 'avg_hr'],
  peak_hr: ['peak_hr', 'peakHR'],
  location: ['location'],
  notes: ['notes']
};

module.exports = {
  logCleanedColumns,
  logRowFieldAliases,
  effortColumns,
  exerciseCatalogColumns,
  coachingNotesColumns,
  constraintsColumns,
  effortRowFieldAliases,
  deloadStateColumns,
  sessionPlansColumns,
  sessionPlanSetsColumns,
  modalityLogColumns,
  modalityLogRowFieldAliases,
  flightRecorderColumns
};
