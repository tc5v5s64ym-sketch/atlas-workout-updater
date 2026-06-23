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
  modalityLogColumns,
  modalityLogRowFieldAliases
};
