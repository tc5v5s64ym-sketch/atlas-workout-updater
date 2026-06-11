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
    if (exercise) {
      const q = String(exercise).trim().toLowerCase();
      const exerciseName = String(row.canonical_exercise || row.exercise || '').toLowerCase();
      if (!exerciseName.includes(q)) return false;
    }
    if (liftCode && row.lift_code.toLowerCase() !== String(liftCode).trim().toLowerCase()) {
      return false;
    }
    if (muscleGroup) {
      const q = String(muscleGroup).trim().toLowerCase();
      if (!String(row.muscle_group || '').toLowerCase().includes(q)) return false;
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
      exercise_name: normalizedCode,
      last_working_sets: [],
      recommendation: 'No recent working sets found for this lift code.',
      reasoning: 'There is not enough history to make a recommendation.',
      next_target: null,
      sessions_analyzed: 0
    };
  }

  const exercise_name = rows[rows.length - 1].canonical_exercise || rows[rows.length - 1].exercise || normalizedCode;

  // Count distinct sessions for this lift
  const sessions = [...new Set(rows.map(r => r.session_id))];

  const lastSets = rows.slice(-5).map(formatSet);
  const lastSet = lastSets[lastSets.length - 1];
  const priorSet = lastSets.length >= 2 ? lastSets[lastSets.length - 2] : null;
  const muscleGroup = lastSet.muscle_group || '';
  const lowerBody = isLowerBodyGroup(muscleGroup);
  const increaseAmount = lowerBody ? 10 : 5;

  // e1RM trend across all sessions for this lift
  const sessionBests = [];
  const seenSessions = new Set();
  for (const row of rows) {
    if (!seenSessions.has(row.session_id)) {
      seenSessions.add(row.session_id);
      const e1rm = row.weight && row.reps ? Math.round(row.weight * (1 + row.reps / 30) * 100) / 100 : null;
      if (e1rm) sessionBests.push(e1rm);
    }
  }
  const e1rmTrend = sessionBests.length >= 2 ? getSimpleTrend(sessionBests) : 'flat';

  let recommendation = 'Repeat the last working set and keep form tight.';
  let reasoning = 'Insufficient recent trend to make a stronger recommendation.';
  let nextWeight = lastSet.weight;
  let nextReps = lastSet.reps;
  let confidence = 'low';

  if (lastSet.rir !== null && lastSet.rir !== undefined && Number.isFinite(lastSet.rir)) {
    if (lastSet.rir >= 2 && priorSet && lastSet.reps === priorSet.reps) {
      nextWeight = lastSet.weight + increaseAmount;
      nextReps = lastSet.reps;
      recommendation = `Increase to ${nextWeight} × ${nextReps} reps.`;
      reasoning = `RIR ${lastSet.rir} with stable reps over two sessions — ${increaseAmount} lb progression is warranted.`;
      confidence = 'high';
    } else if (lastSet.rir <= 0) {
      nextWeight = lastSet.weight;
      nextReps = lastSet.reps;
      recommendation = `Hold at ${nextWeight} × ${nextReps} — the last set was at or near failure.`;
      reasoning = 'RIR ≤ 0 means the last set was very close to failure. Maintain load and prioritize technique before adding weight.';
      confidence = 'high';
    } else {
      nextWeight = lastSet.weight;
      nextReps = (lastSet.reps || 0) + 1;
      recommendation = `Keep ${nextWeight} lbs and target ${nextReps} reps next session.`;
      reasoning = `RIR ${lastSet.rir} suggests there is room to add a rep before bumping load.`;
      confidence = 'medium';
    }
  }

  return {
    liftCode: normalizedCode,
    exercise_name,
    last_working_sets: lastSets,
    recommendation,
    reasoning,
    next_target: { weight: nextWeight, reps: nextReps, sets: 3 },
    e1rm_trend: e1rmTrend,
    sessions_analyzed: sessions.length,
    confidence
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

function detectStalls(logRows, minSessions = 3) {
  const count = Math.max(2, Number.isFinite(Number(minSessions)) ? Number(minSessions) : 3);
  const rows = logRows.map(normalizeLogRow).filter(row => row.weight && row.weight > 0 && row.reps);
  const byLiftCode = new Map();

  rows.forEach(row => {
    const code = row.lift_code || 'UNKNOWN';
    if (!byLiftCode.has(code)) byLiftCode.set(code, []);
    byLiftCode.get(code).push(row);
  });

  const stalls = [];

  for (const [liftCode, liftRows] of byLiftCode.entries()) {
    const sorted = [...liftRows].sort((a, b) =>
      (a.date_clean || '').localeCompare(b.date_clean || '') ||
      (a.session_id || '').localeCompare(b.session_id || '')
    );

    const sessionMap = new Map();
    sorted.forEach(row => {
      const key = `${row.session_id}||${row.date_clean}`;
      const current = sessionMap.get(key) || { session_id: row.session_id, date: row.date_clean, best_weight: 0 };
      current.best_weight = Math.max(current.best_weight, row.weight || 0);
      sessionMap.set(key, current);
    });

    const sessions = Array.from(sessionMap.values());
    if (sessions.length < count) continue;

    const lastN = sessions.slice(-count);
    const maxWeight = Math.max(...lastN.map(s => s.best_weight));
    const firstWeight = lastN[0].best_weight;

    if (maxWeight <= firstWeight) {
      stalls.push({
        liftCode,
        sessions_stalled: lastN.length,
        last_best_weight: lastN[lastN.length - 1].best_weight,
        first_session_date: lastN[0].date,
        last_session_date: lastN[lastN.length - 1].date
      });
    }
  }

  return stalls;
}

function suggestDeloads(logRows, minSessions = 4) {
  const stalls = detectStalls(logRows, minSessions);
  return stalls.map(stall => {
    const deloadWeight = Math.round(stall.last_best_weight * 0.9);
    return {
      liftCode: stall.liftCode,
      sessions_stalled: stall.sessions_stalled,
      last_best_weight: stall.last_best_weight,
      suggested_deload_weight: deloadWeight,
      suggestion: `No progression in ${stall.sessions_stalled} sessions. Deload to ~${deloadWeight} (−10%) for one session, then rebuild.`
    };
  });
}

function computeFatigueStatus(logRows, referenceDate = new Date()) {
  const ref = new Date(referenceDate);
  const dayMs = 24 * 60 * 60 * 1000;
  const recentCutoff = new Date(ref.getTime() - 7 * dayMs).toISOString().slice(0, 10);
  const baselineCutoff = new Date(ref.getTime() - 28 * dayMs).toISOString().slice(0, 10);

  let recentVolume = 0;
  let baselineVolume = 0;

  logRows.map(normalizeLogRow).forEach(row => {
    if (!row.date_clean || !row.weight || row.weight <= 0 || !row.reps) return;
    const volume = row.weight * row.reps;
    if (row.date_clean >= recentCutoff) {
      recentVolume += volume;
    } else if (row.date_clean >= baselineCutoff) {
      baselineVolume += volume;
    }
  });

  // Baseline window is 21 days (days 8-28); convert to a weekly average.
  const baselineWeekly = baselineVolume / 3;
  let ratio = null;
  let status = 'no_baseline';
  let guidance = 'Not enough training history in the prior 3 weeks to judge fatigue.';

  if (baselineWeekly > 0) {
    ratio = Math.round((recentVolume / baselineWeekly) * 100) / 100;
    if (ratio >= 1.5) {
      status = 'high';
      guidance = 'This week\'s volume is well above your recent average. Watch recovery and consider an easier session.';
    } else if (ratio <= 0.5) {
      status = 'low';
      guidance = 'This week\'s volume is well below your recent average. Good time to push if you feel recovered.';
    } else {
      status = 'normal';
      guidance = 'Weekly volume is in a normal range relative to your recent average.';
    }
  }

  return {
    recent_volume: Math.round(recentVolume),
    baseline_weekly_volume: Math.round(baselineWeekly),
    ratio,
    status,
    guidance
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

function buildExerciseDetail(logRows, liftCode, { recentDays = 30, today = null } = {}) {
  const normalizedCode = String(liftCode || '').trim().toUpperCase();
  if (!normalizedCode) {
    return { lift_code: '', exercise_names: [], sessions_count: 0, last_sessions: [], best_recent_set: null, volume_trend: 'flat', recommendation: null };
  }

  const progress = computeExerciseProgress(logRows, normalizedCode);
  const sessionCount = progress.sessions.length;
  const startIdx = Math.max(0, sessionCount - 5);
  const last_sessions = progress.sessions.slice(startIdx).map((s, i) => ({
    date: s.date,
    session_id: s.session_id,
    best_weight: progress.best_weight_over_time[startIdx + i]?.best_weight ?? null,
    estimated_1rm: progress.estimated_1rm_over_time[startIdx + i]?.estimated_1rm ?? null,
    volume: Math.round(s.total_volume),
    sets: s.total_sets
  }));

  const normalRows = logRows.map(normalizeLogRow).filter(r => r.lift_code === normalizedCode && r.weight > 0);
  const exercise_names = [...new Set(normalRows.map(r => r.canonical_exercise || r.exercise).filter(Boolean))];

  const dayMs = 24 * 60 * 60 * 1000;
  const refMs = today
    ? new Date(today + 'T12:00:00Z').getTime()
    : new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00Z').getTime();
  const cutoffDate = new Date(refMs - recentDays * dayMs).toISOString().slice(0, 10);
  const recentRows = normalRows.filter(r => r.date_clean >= cutoffDate);
  let best_recent_set = null;
  if (recentRows.length > 0) {
    const best = recentRows.reduce((acc, r) => (r.weight > acc.weight ? r : acc), recentRows[0]);
    best_recent_set = {
      date: best.date_clean,
      weight: best.weight,
      reps: best.reps,
      rir: best.rir != null ? best.rir : null,
      exercise: best.canonical_exercise || best.exercise
    };
  }

  const rec = recommendNextSet(logRows, normalizedCode);
  const recommendation = rec.sessions_analyzed > 0 ? {
    recommendation: rec.recommendation,
    reasoning: rec.reasoning,
    next_target: rec.next_target || null,
    confidence: rec.confidence
  } : null;

  return {
    lift_code: normalizedCode,
    exercise_names,
    sessions_count: sessionCount,
    last_sessions,
    best_recent_set,
    volume_trend: progress.recent_trend,
    recommendation
  };
}

function buildRecentSessions(logRows, effortRows, { limit = 15 } = {}) {
  const safeLimit = Math.min(Math.max(1, Number(limit) || 15), 50);

  const normalizedLog = logRows.map(normalizeLogRow).filter(r => r.session_id);
  const normalizedEffort = (effortRows || []).map(normalizeEffortRow);

  const effortBySession = new Map();
  normalizedEffort.forEach(e => { if (e.session_id) effortBySession.set(e.session_id, e); });

  const sessionMap = new Map();
  normalizedLog.forEach(r => {
    if (!sessionMap.has(r.session_id)) {
      sessionMap.set(r.session_id, {
        session_id: r.session_id,
        date: r.date_clean,
        exercises: new Set(),
        sets_count: 0,
        total_volume: 0
      });
    }
    const s = sessionMap.get(r.session_id);
    if (r.date_clean > s.date) s.date = r.date_clean;
    if (r.canonical_exercise || r.exercise) s.exercises.add(r.canonical_exercise || r.exercise);
    if (r.weight > 0) {
      s.sets_count++;
      s.total_volume += r.weight * r.reps;
    }
  });

  const sessions = [...sessionMap.values()]
    .sort((a, b) => b.date !== a.date ? b.date.localeCompare(a.date) : b.session_id.localeCompare(a.session_id))
    .slice(0, safeLimit)
    .map(s => ({
      session_id: s.session_id,
      date: s.date,
      exercises: [...s.exercises],
      sets_count: s.sets_count,
      total_volume: Math.round(s.total_volume),
      effort: effortBySession.get(s.session_id) || null
    }));

  return { sessions, count: sessions.length };
}

function buildWeeklyReport(logRows, { days = 7, today = null } = {}) {
  const dayMs = 24 * 60 * 60 * 1000;
  const refDate = today
    ? new Date(today + 'T12:00:00Z')
    : new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00Z');
  const periodEnd = refDate.toISOString().slice(0, 10);
  const periodStart = new Date(refDate.getTime() - (days - 1) * dayMs).toISOString().slice(0, 10);
  const priorEnd = new Date(refDate.getTime() - days * dayMs).toISOString().slice(0, 10);
  const priorStart = new Date(refDate.getTime() - (2 * days - 1) * dayMs).toISOString().slice(0, 10);

  const weekRows = logRows.filter(row => {
    const d = String(row[0] || '').slice(0, 10);
    return d >= periodStart && d <= periodEnd && Number(row[7]) > 0;
  });
  const priorRows = logRows.filter(row => {
    const d = String(row[0] || '').slice(0, 10);
    return d >= priorStart && d <= priorEnd && Number(row[7]) > 0;
  });

  const sessions_count = new Set(
    weekRows.map(r => String(r[1] || '').trim()).filter(Boolean)
  ).size;

  let total_sets = 0;
  let total_volume = 0;
  weekRows.forEach(row => {
    total_sets++;
    total_volume += (Number(row[7]) || 0) * (Number(row[8]) || 0);
  });
  total_volume = Math.round(total_volume);

  // Top exercises by volume this week
  const exerciseMap = new Map();
  weekRows.forEach(row => {
    const exercise = String(row[3] || row[2] || '').trim();
    const liftCode = String(row[5] || '').trim();
    const key = liftCode || exercise;
    if (!key) return;
    const vol = (Number(row[7]) || 0) * (Number(row[8]) || 0);
    if (!exerciseMap.has(key)) exerciseMap.set(key, { exercise, lift_code: liftCode, volume: 0, sets: 0 });
    const e = exerciseMap.get(key);
    e.volume += vol;
    e.sets++;
  });
  const top_exercises = [...exerciseMap.values()]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5)
    .map(e => ({ ...e, volume: Math.round(e.volume) }));

  // Muscle group volume this week
  const muscle_group_volume = {};
  weekRows.forEach(row => {
    const mg = String(row[4] || 'Unknown').trim() || 'Unknown';
    muscle_group_volume[mg] = (muscle_group_volume[mg] || 0) + (Number(row[7]) || 0) * (Number(row[8]) || 0);
  });
  for (const mg in muscle_group_volume) muscle_group_volume[mg] = Math.round(muscle_group_volume[mg]);

  // PRs: this week's best weight vs prior week's best weight per lift
  const thisBest = new Map();
  weekRows.forEach(row => {
    const liftCode = String(row[5] || '').trim();
    if (!liftCode) return;
    const weight = Number(row[7]) || 0;
    const exercise = String(row[3] || row[2] || '').trim();
    if (!thisBest.has(liftCode) || weight > thisBest.get(liftCode).best_weight) {
      thisBest.set(liftCode, { best_weight: weight, exercise });
    }
  });
  const priorBest = new Map();
  priorRows.forEach(row => {
    const liftCode = String(row[5] || '').trim();
    if (!liftCode) return;
    const weight = Number(row[7]) || 0;
    if (!priorBest.has(liftCode) || weight > priorBest.get(liftCode).best_weight) {
      priorBest.set(liftCode, { best_weight: weight });
    }
  });
  const prs = [];
  for (const [liftCode, { best_weight, exercise }] of thisBest) {
    const prior = priorBest.get(liftCode);
    if (prior && best_weight > prior.best_weight) {
      prs.push({ lift_code: liftCode, exercise, prev_best: prior.best_weight, this_week_best: best_weight, type: 'weight' });
    }
  }

  // Stalls: detect across full history, filter to lifts trained this week
  const weekLiftCodes = new Set(thisBest.keys());
  const stalls_or_watchouts = detectStalls(logRows, 3).filter(s => weekLiftCodes.has(s.liftCode));

  // Recommendations for the top 3 lifts by volume this week
  const recommendations = top_exercises
    .filter(e => e.lift_code)
    .slice(0, 3)
    .map(e => {
      const rec = recommendNextSet(logRows, e.lift_code);
      return { lift_code: e.lift_code, recommendation: rec.recommendation, next_target: rec.next_target || null };
    });

  // summary_markdown
  const lines = [`**Weekly Training Report** — ${periodStart} to ${periodEnd}`, ''];
  if (sessions_count === 0) {
    lines.push('No training data found for this period.');
  } else {
    lines.push(`Sessions: ${sessions_count} · Sets: ${total_sets} · Volume: ${total_volume.toLocaleString()} lb`);
    if (top_exercises.length) {
      lines.push(`Main lifts: ${top_exercises.map(e => e.exercise || e.lift_code).filter(Boolean).join(', ')}`);
    }
    const mgSorted = Object.entries(muscle_group_volume).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (mgSorted.length) {
      lines.push(`Volume by group: ${mgSorted.map(([mg, vol]) => `${mg} ${vol.toLocaleString()}`).join(' · ')}`);
    }
    if (prs.length) {
      lines.push(`Improvements: ${prs.map(p => `${p.exercise || p.lift_code} ${p.prev_best} → ${p.this_week_best} lb`).join(', ')}`);
    }
    if (stalls_or_watchouts.length) {
      lines.push(`Watchouts: ${stalls_or_watchouts.map(s => `${s.liftCode} stalled at ${s.last_best_weight} lb (${s.sessions_stalled} sessions)`).join(', ')}`);
    }
    const recLines = recommendations.filter(r => r.recommendation).map(r => `${r.lift_code}: ${r.recommendation}`);
    if (recLines.length) lines.push(`Next focus: ${recLines.join(' · ')}`);
  }
  const summary_markdown = lines.join('\n');

  return {
    period_start: periodStart,
    period_end: periodEnd,
    sessions_count,
    total_sets,
    total_volume,
    top_exercises,
    muscle_group_volume,
    prs,
    stalls_or_watchouts,
    recommendations,
    summary_markdown
  };
}

module.exports = {
  normalizeLogRow,
  buildSessionSummary,
  computeExerciseProgress,
  computeMuscleGroupVolume,
  searchSessions,
  detectRecentPrs,
  recommendNextSet,
  buildBodyweightHistory,
  previewTestRows,
  detectStalls,
  suggestDeloads,
  computeFatigueStatus,
  buildWeeklyReport,
  buildExerciseDetail,
  buildRecentSessions
};
