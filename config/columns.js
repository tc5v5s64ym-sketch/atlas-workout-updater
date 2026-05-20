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
  'notes'
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
  notes: ['notes']
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

const exerciseCatalogColumns = ['Canonical_Name', 'Muscle_Group', 'Lift_Code', 'Original_Variants'];

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
  effortRowFieldAliases
};
