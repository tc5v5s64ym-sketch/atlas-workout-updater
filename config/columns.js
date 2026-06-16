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

const deloadStateRowFieldAliases = {
  updated_at: ['updated_at', 'updatedAt'],
  training_state: ['training_state', 'trainingState', 'state'],
  deload_protocol: ['deload_protocol', 'deloadProtocol', 'protocol'],
  deload_reason: ['deload_reason', 'deloadReason', 'reason'],
  deload_start_date: ['deload_start_date', 'deloadStartDate', 'start_date'],
  deload_sessions_remaining: ['deload_sessions_remaining', 'deloadSessionsRemaining', 'sessions_remaining'],
  deload_exit_criteria: ['deload_exit_criteria', 'deloadExitCriteria', 'exit_criteria']
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
  deloadStateRowFieldAliases
};
