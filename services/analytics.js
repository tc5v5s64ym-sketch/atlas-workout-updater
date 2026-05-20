const { parseNumber, normalizeDate, parseDurationMinutes, getSimpleTrend, calculateQualityScore } = require('./validation');

function normalizeLogRow(row) {
  if (Array.isArray(row)) {
    return {
      date_clean: normalizeDate(row[0]),
      session_id: String(row[1] || '').trim(),
      exercise: String(row[2] || '').trim(),
      canonical_exercise: String(row[3] || '').trim(),
      muscle_group: String(row[4] || '').trim(),
      lift_code: String(row[5] || '').trim().toUpperCase(),
      set_number: String(row[6] || '').trim(),
      weight: parseNumber(row[7]),
      reps: parseNumber(row[8]),
      rir: parseNumber(row[9]),
      notes: String(row[10] || '').trim()
    };
  }

  return {
    date_clean: normalizeDate(row.date_clean || row.date || row.dateClean),
    session_id: String(row.session_id || row.sessionId || '').trim(),
    exercise: String(row.exercise || '').trim(),
    canonical_exercise: String(row.canonical_exercise || row.canonicalExercise || '').trim(),
    muscle_group: String(row.muscle_group || row.muscleGroup || '').trim(),
    lift_code: String(row.lift_code || row.liftCode || '').trim().toUpperCase(),
    set_number: String(row.set_number || row.setNumber || row.set || '').trim(),
    weight: parseNumber(row.weight),
    reps: parseNumber(row.reps),
    rir: parseNumber(row.rir),
    notes: String(row.notes || '').trim()
  };
}

function normalizeEffortRow(row) {
  if (Array.isArray(row)) {
    return {
      date: normalizeDate(row[0]),
      session_id: String(row[1] || '').trim(),
      duration: String(row[2] || '').trim(),
      active_calories: parseNumber(row[3]),
      total_calories: parseNumber(row[4]),
      average_hr: parseNumber(row[5]),
      peak_hr: parseNumber(row[6]),
      location: String(row[7] || '').trim(),
      notes: String(row[8] || '').trim()
    };
  }

  return {
    date: normalizeDate(row.date),
    session_id: String(row.session_id || row.sessionId || '').trim(),
    duration: String(row.duration || '').trim(),
    active_calories: parseNumber(row.active_calories || row.activeCalories),
    total_calories: parseNumber(row.total_calories || row.totalCalories),
    average_hr: parseNumber(row.average_hr || row.averageHR || row.avg_hr),
    peak_hr: parseNumber(row.peak_hr || row.peakHR),
    location: String(row.location || '').trim(),
    notes: String(row.notes || '').trim()
  };
}

function formatSet(row) {
  return {
    date_clean: row.date_clean,
    session_id: row.session_id,
    exercise: row.exercise,
    canonical_exercise: row.canonical_exercise,
    muscle_group: row.muscle_group,
    lift_code: row.lift_code,
    set_number: row.set_number,
    weight: row.weight,
    reps: row.reps,
    rir: row.rir,
    notes: row.notes,
    volume: row.weight && row.reps ? row.weight * row.reps : 0
  };
}

function buildSessionSummary(logRows, effortRows, sessionId, validationWarnings = []) {
  const normalizedSessionId = String(sessionId || '').trim().toLowerCase();
  const sessionLogRows = logRows
    .map(normalizeLogRow)
    .filter(row => row.session_id.toLowerCase() === normalizedSessionId);

  const effortRow = effortRows
    .map(normalizeEffortRow)
    .find(row => row.session_id.toLowerCase() === normalizedSessionId) || null;

  const uniqueExercises = [...new Set(sessionLogRows.map(row => row.canonical_exercise || row.exercise).filter(Boolean))];
  const totalSets = sessionLogRows.length;

  let totalVolume = 0;
  let topSet = null;

  for (const row of sessionLogRows) {
    if (row.weight && row.reps) {
      const volume = row.weight * row.reps;
      totalVolume += volume;
      if (!topSet || volume > topSet.volume) {
        topSet = { ...formatSet(row), volume };
      }
    }
  }

  const quickSummary = sessionLogRows.length
    ? `Session ${sessionId} on ${sessionLogRows[0].date_clean || effortRow?.date || 'unknown date'} includes ${totalSets} sets, ${uniqueExercises.length} exercises, and ${Math.round(totalVolume)} total volume.`
    : `No log rows found for session ${sessionId}.`;

  const quality_score = calculateQualityScore({
    totalSets,
    effortDuration: effortRow?.duration,
    averageHR: effortRow?.average_hr,
    uniqueExercisesCount: uniqueExercises.length,
    validationWarnings
  });

  return {
    session_id: sessionId,
    date: effortRow?.date || sessionLogRows[0]?.date_clean || '',
    exercises: uniqueExercises,
    total_sets: totalSets,
    total_volume: totalVolume,
    top_set: topSet,
    effort: effortRow,
    quick_summary: quickSummary,
    quality_score
  };
}

function computeExerciseProgress(logRows, liftCode) {
  const normalizedCode = String(liftCode || '').trim().toUpperCase();
  const rows = logRows
    .map(normalizeLogRow)
    .filter(row => row.lift_code === normalizedCode && row.weight && row.reps);

  const sessionsByKey = new Map();
  const progressByDate = [];
  const bestWeightValues = [];
  const best1RMValues = [];
  const volumeValues = [];

  rows.forEach(row => {
    const key = `${row.session_id}||${row.date_clean}`;
    const current = sessionsByKey.get(key) || { session_id: row.session_id, date: row.date_clean, total_sets: 0, total_volume: 0 };
    current.total_sets += 1;
    current.total_volume += row.weight * row.reps;
    sessionsByKey.set(key, current);
  });

  const sessions = Array.from(sessionsByKey.values()).sort((a, b) => a.date.localeCompare(b.date) || a.session_id.localeCompare(b.session_id));

  const sessionBestByCode = new Map();
  rows.forEach(row => {
    const key = `${row.session_id}||${row.date_clean}`;
    const existing = sessionBestByCode.get(key) || { best_weight: 0, best_1rm: 0 };
    existing.best_weight = Math.max(existing.best_weight, row.weight || 0);
    existing.best_1rm = Math.max(existing.best_1rm, row.weight * (1 + (row.reps || 0) / 30));
    sessionBestByCode.set(key, existing);
  });

  for (const session of sessions) {
    const best = sessionBestByCode.get(`${session.session_id}||${session.date}`) || { best_weight: 0, best_1rm: 0 };
    bestWeightValues.push({ date: session.date, session_id: session.session_id, best_weight: best.best_weight });
    best1RMValues.push({ date: session.date, session_id: session.session_id, estimated_1rm: Math.round(best.best_1rm * 100) / 100 });
    volumeValues.push({ date: session.date, session_id: session.session_id, volume: Math.round(session.total_volume * 100) / 100 });
  }

  const bestWeightTrend = bestWeightValues.map(v => v.best_weight);
  const recent_trend = getSimpleTrend(bestWeightTrend);

  return {
    liftCode: normalizedCode,
    sessions,
    best_weight_over_time: bestWeightValues,
    estimated_1rm_over_time: best1RMValues,
    volume_over_time: volumeValues,
    recent_trend
  };
}

function computeMuscleGroupVolume(logRows, days = 14) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Number(days));
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const summary = {};

  logRows.map(normalizeLogRow).forEach(row => {
    if (!row.date_clean || row.date_clean < cutoffIso) return;

    const muscleGroupKey = row.muscle_group || 'Unknown';
    const group = summary[muscleGroupKey] || { muscle_group: muscleGroupKey, volume: 0, set_count: 0 };
    if (row.weight && row.weight > 0 && row.reps) {
      group.volume += row.weight * row.reps;
      group.set_count += 1;
    } else if (!row.weight && /bodyweight|core/i.test(muscleGroupKey)) {
      group.set_count += 1;
    } else if (row.weight === 0) {
      group.set_count += 1;
    }
    summary[muscleGroupKey] = group;
  });

  return Object.values(summary).map(item => ({
    muscle_group: item.muscle_group,
    volume: Math.round(item.volume * 100) / 100,
    set_count: item.set_count
  }));
}

function searchSessions(logRows, filters) {
  const normalizedRows = logRows.map(normalizeLogRow);
  const { exercise, liftCode, dateFrom, dateTo, muscleGroup } = filters;
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);

  const matchingRows = normalizedRows.filter(row => {
    if (exercise && String(row.exercise || row.canonical_exercise).toLowerCase() !== String(exercise).trim().toLowerCase()) {
      return false;
    }
    if (liftCode && row.lift_code.toLowerCase() !== String(liftCode).trim().toLowerCase()) {
      return false;
    }
    if (muscleGroup && row.muscle_group.toLowerCase() !== String(muscleGroup).trim().toLowerCase()) {
      return false;
    }
    if (from && row.date_clean && row.date_clean < from) {
      return false;
    }
    if (to && row.date_clean && row.date_clean > to) {
      return false;
    }
    return true;
  });

  const sessionIds = [...new Set(matchingRows.map(row => row.session_id).filter(Boolean))];
  return {
    session_ids: sessionIds,
    rows: matchingRows
  };
}

function detectRecentPrs(logRows) {
  const rows = logRows.map(normalizeLogRow).filter(row => row.weight && row.weight > 0 && row.reps);
  const byLiftCode = new Map();

  rows.forEach(row => {
    const code = row.lift_code || 'UNKNOWN';
    const existing = byLiftCode.get(code) || {
      liftCode: code,
      bestWeightSet: null,
      bestRepSet: null,
      bestEstimated1RMSet: null
    };

    const estimated1RM = row.weight * (1 + (row.reps || 0) / 30);
    const rowSet = formatSet(row);

    if (!existing.bestWeightSet || row.weight > existing.bestWeightSet.weight) {
      existing.bestWeightSet = { ...rowSet };
    }

    if (!existing.bestRepSet || row.reps > existing.bestRepSet.reps || (row.reps === existing.bestRepSet.reps && row.weight > existing.bestRepSet.weight)) {
      existing.bestRepSet = { ...rowSet };
    }

    if (!existing.bestEstimated1RMSet || estimated1RM > existing.bestEstimated1RMSet.estimated_1rm) {
      existing.bestEstimated1RMSet = { ...rowSet, estimated_1rm: Math.round(estimated1RM * 100) / 100 };
    }

    byLiftCode.set(code, existing);
  });

  return Array.from(byLiftCode.values());
}

function isLowerBodyGroup(muscleGroup) {
  return /leg|quad|hamstring|glute|calf|lower body|hip/i.test(muscleGroup || '');
}

function recommendNextSet(logRows, liftCode) {
  const normalizedCode = String(liftCode || '').trim().toUpperCase();
  const rows = logRows
    .map(normalizeLogRow)
    .filter(row => row.lift_code === normalizedCode && row.weight && row.weight > 0)
    .sort((a, b) => (a.date_clean || '').localeCompare(b.date_clean || '') || (a.session_id || '').localeCompare(b.session_id || '') || (Number(a.set_number) || 0) - (Number(b.set_number) || 0));

  if (!rows.length) {
    return {
      liftCode: normalizedCode,
      last_working_sets: [],
      recommendation: 'No recent working sets found for this lift code.',
      reasoning: 'There is not enough history to make a recommendation.'
    };
  }

  const lastSets = rows.slice(-5).map(formatSet);
  const lastSet = lastSets[lastSets.length - 1];
  const priorSet = lastSets.length >= 2 ? lastSets[lastSets.length - 2] : null;
  const muscleGroup = lastSet.muscle_group || '';
  const lowerBody = isLowerBodyGroup(muscleGroup);
  const increaseAmount = lowerBody ? 10 : 5;
  let recommendation = 'Repeat the last working set and keep form tight.';
  let reasoning = 'Insufficient recent trend to make a stronger recommendation.';

  if (lastSet.rir !== null && lastSet.rir !== undefined && Number.isFinite(lastSet.rir)) {
    if (lastSet.rir >= 2 && priorSet && lastSet.reps === priorSet.reps) {
      recommendation = `Increase the weight from ${lastSet.weight} to ${lastSet.weight + increaseAmount} and keep reps around ${lastSet.reps}.`;
      reasoning = `Last session had RIR ${lastSet.rir} with stable reps, so a conservative ${increaseAmount} lb progression is reasonable.`;
    } else if (lastSet.rir <= 0) {
      recommendation = `Repeat the same weight or reduce by about 5% if the last set felt too heavy.`;
      reasoning = 'RIR at or below zero indicates the set was very close to failure, so maintain or slightly reduce weight.';
    } else {
      recommendation = `Keep ${lastSet.weight} lbs and aim to add a rep or two next session.`;
      reasoning = 'The last set did not show strong progression margin, so build volume before increasing load.';
    }
  }

  return {
    liftCode: normalizedCode,
    last_working_sets: lastSets,
    recommendation,
    reasoning
  };
}

function buildBodyweightHistory(rows, days = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Number(days));
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const entries = rows
    .map(row => {
      const date = normalizeDate(Array.isArray(row) ? row[0] : row.date);
      return {
        date,
        weight: parseNumber(Array.isArray(row) ? row[1] : row.weight),
        notes: String(Array.isArray(row) ? row[2] : row.notes || '').trim()
      };
    })
    .filter(entry => entry.date && entry.weight !== null && entry.date >= cutoffIso)
    .sort((a, b) => a.date.localeCompare(b.date));

  const latest = entries.length ? entries[entries.length - 1] : null;
  const average = entries.length ? entries.reduce((sum, e) => sum + e.weight, 0) / entries.length : null;
  const trend = latest && entries.length > 1 ? getSimpleTrend(entries.map(e => e.weight)) : 'flat';

  return {
    entries,
    latest,
    average: average === null ? null : Math.round(average * 100) / 100,
    trend
  };
}

function previewTestRows(logRows, effortRows) {
  const logCandidates = logRows
    .map(normalizeLogRow)
    .filter(row => /test/i.test(row.notes) || /test/i.test(row.session_id) || /session-2026/i.test(row.session_id));

  const effortCandidates = effortRows
    .map(normalizeEffortRow)
    .filter(row => /test/i.test(row.notes) || /test/i.test(row.session_id) || /session-2026/i.test(row.session_id));

  return {
    log_candidates: logCandidates,
    effort_candidates: effortCandidates
  };
}

module.exports = {
  buildSessionSummary,
  computeExerciseProgress,
  computeMuscleGroupVolume,
  searchSessions,
  detectRecentPrs,
  recommendNextSet,
  buildBodyweightHistory,
  previewTestRows
};
