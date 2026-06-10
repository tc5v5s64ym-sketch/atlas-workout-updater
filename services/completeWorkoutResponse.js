function buildCompleteWorkoutResponseData({
  sessionId,
  dateValue,
  testMode,
  rowsToWrite,
  skippedDuplicates,
  duplicateSession = false,
  effortWritten,
  normalizedMetrics,
  qualityScore,
  effortSource,
  effortRow,
  formattedLogRows,
  pendingExercises
}) {
  const duplicateLogRows = skippedDuplicates.length;
  const wouldWrite = rowsToWrite.length > 0;
  const sheetWritten = !testMode && effortWritten;

  const core = {
    session_id: sessionId,
    date: dateValue,
    test_mode: testMode,
    would_write: wouldWrite,
    sheet_written: sheetWritten,
    log_rows_written: testMode ? 0 : rowsToWrite.length,
    effort_written: effortWritten,
    duplicate_check: {
      duplicate_session: duplicateSession,
      duplicate_log_rows: duplicateLogRows
    },
    effort_source: effortSource,
    parsed_effort: normalizedMetrics,
    quality_score: qualityScore
  };

  if (testMode) {
    core.no_write_confirmed = !sheetWritten;
    core.effort_row = effortRow;
    core.log_rows_preview = formattedLogRows;
    core.rows_to_write = rowsToWrite;
    core.rows_skipped = skippedDuplicates.map(s => s.row);
    core.enrichment = formattedLogRows.map(row => ({
      exercise: row[2],
      canonical_exercise: row[3],
      muscle_group: row[4],
      lift_code: row[5]
    }));
  }

  if (pendingExercises && pendingExercises.length > 0) {
    core.pending_exercises = pendingExercises;
  }

  // Compatibility for older smoke/client code that looked under response.data.data.
  core.data = {
    session_id: core.session_id,
    date: core.date,
    test_mode: core.test_mode,
    would_write: core.would_write,
    sheet_written: core.sheet_written,
    no_write_confirmed: core.no_write_confirmed,
    log_rows_written: core.log_rows_written,
    effort_written: core.effort_written,
    duplicate_check: core.duplicate_check,
    effort_source: core.effort_source,
    parsed_effort: core.parsed_effort,
    quality_score: core.quality_score,
    effort_row: core.effort_row,
    log_rows_preview: core.log_rows_preview,
    rows_to_write: core.rows_to_write,
    rows_skipped: core.rows_skipped,
    enrichment: core.enrichment
  };

  return core;
}

module.exports = {
  buildCompleteWorkoutResponseData
};
