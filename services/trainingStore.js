// The migrated workout concepts read Supabase, their sole authority since the S4
// cutover. Same header-stripped cell shape  returned.
const workoutAuthority = require('./workoutAuthority');
const {
  buildExerciseDetail,
  buildProgressSummary,
  buildRecentSessions,
  buildWeeklyReport
} = require('./analytics');

async function getLogRows() {
  return workoutAuthority.loggedSetRows();
}

async function getEffortRows() {
  return workoutAuthority.effortRows();
}

async function getRecentLogRows(limit = 1000) {
  return workoutAuthority.loggedSetRows({ limit });
}

async function getRecentSessions(options = {}) {
  const limit = options.limit;
  const [logRows, effortRows] = await Promise.all([
    getLogRows(),
    getEffortRows()
  ]);
  return buildRecentSessions(logRows, effortRows, { limit });
}

async function getProgressSummary(options = {}) {
  const logRows = await getLogRows();
  return buildProgressSummary(logRows, options);
}

async function getWeeklyReportData(options = {}) {
  const limit = options.rowLimit || 1000;
  const days = options.days;
  const logRows = await getRecentLogRows(limit);
  return buildWeeklyReport(logRows, { days });
}

async function getExerciseDetail(liftCode, options = {}) {
  const limit = options.rowLimit || 1000;
  const logRows = await getRecentLogRows(limit);
  return buildExerciseDetail(logRows, liftCode, options);
}

module.exports = {
  getEffortRows,
  getExerciseDetail,
  getLogRows,
  getProgressSummary,
  getRecentLogRows,
  getRecentSessions,
  getWeeklyReportData
};
