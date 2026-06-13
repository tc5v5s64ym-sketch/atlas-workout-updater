const { parseNumber, normalizeDate, parseDurationMinutes, getSimpleTrend, calculateQualityScore, qualityScoreBreakdown } = require('./validation');

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

  const qualityMetrics = {
    totalSets,
    effortDuration: effortRow?.duration,
    averageHR: effortRow?.average_hr,
    uniqueExercisesCount: uniqueExercises.length,
    validationWarnings
  };
  const quality_score = calculateQualityScore(qualityMetrics);
  const quality_breakdown = qualityScoreBreakdown(qualityMetrics);

  return {
    session_id: sessionId,
    date: effortRow?.date || sessionLogRows[0]?.date_clean || '',
    exercises: uniqueExercises,
    total_sets: totalSets,
    total_volume: totalVolume,
    top_set: topSet,
    // Per-set detail so a session can show exactly what was logged (weight ×
    // reps @rir, with notes), grouped by exercise on the client.
    sets: sessionLogRows.map(formatSet),
    effort: effortRow,
    quick_summary: quickSummary,
    quality_score,
    quality_breakdown
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
      exercise: row.canonical_exercise || row.exercise || '',
      bestWeightSet: null,
      bestRepSet: null,
      bestEstimated1RMSet: null
    };
    // Keep the most-recently-seen exercise name in case earlier rows were blank.
    if (!existing.exercise && (row.canonical_exercise || row.exercise)) {
      existing.exercise = row.canonical_exercise || row.exercise;
    }

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

function recommendNextSet(logRows, liftCode, { today = null } = {}) {
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
      sessions_analyzed: 0,
      days_since_last_session: null
    };
  }

  const exercise_name = rows[rows.length - 1].canonical_exercise || rows[rows.length - 1].exercise || normalizedCode;

  // How long since this lift was last trained. Progression assumes recent data;
  // after a layoff we repeat rather than add load (staleness guard below).
  const dayMs = 24 * 60 * 60 * 1000;
  const refMs = today
    ? new Date(today + 'T12:00:00Z').getTime()
    : new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00Z').getTime();
  const lastDate = rows[rows.length - 1].date_clean;
  const daysSinceLastSession = lastDate
    ? Math.max(0, Math.round((refMs - new Date(lastDate + 'T12:00:00Z').getTime()) / dayMs))
    : null;

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

  // Staleness guard. Progression (adding load, adding a rep) assumes the last
  // session is recent. After a long gap, adding weight off old data is a guess —
  // repeat the last working weight to reconfirm first. Either way the age is
  // stated so the advice reads honestly instead of pretending the gap isn't there.
  if (daysSinceLastSession != null && daysSinceLastSession > 10) {
    nextWeight = lastSet.weight;
    nextReps = lastSet.reps;
    recommendation = `Repeat ${nextWeight} × ${nextReps} to reconfirm this lift.`;
    reasoning = `Based on your last session, ${daysSinceLastSession} days ago — too long a gap to assume progression. Repeat the last working weight and see where you are before adding load.`;
    confidence = confidence === 'high' ? 'medium' : 'low';
  } else if (daysSinceLastSession != null && daysSinceLastSession >= 7) {
    reasoning = `${reasoning} Based on your last session, ${daysSinceLastSession} days ago.`;
  }

  const allWeights = rows.map(r => r.weight).filter(w => w > 0);
  // Use the first session's best weight (not first set) so warm-up sets on day
  // one don't inflate the progress % badge (e.g. 45 lb warm-up → 400% is wrong).
  const firstSessionId = rows.length ? rows[0].session_id : null;
  const firstSessionBests = firstSessionId
    ? rows.filter(r => r.session_id === firstSessionId).map(r => r.weight).filter(w => w > 0)
    : [];
  const first_weight = firstSessionBests.length ? Math.max(...firstSessionBests) : null;
  const best_weight = allWeights.length ? Math.max(...allWeights) : null;

  return {
    liftCode: normalizedCode,
    exercise_name,
    last_working_sets: lastSets,
    recommendation,
    reasoning,
    next_target: { weight: nextWeight, reps: nextReps, sets: 3 },
    e1rm_trend: e1rmTrend,
    sessions_analyzed: sessions.length,
    confidence,
    days_since_last_session: daysSinceLastSession,
    first_weight,
    best_weight
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
      const lastNamed = [...sorted].reverse().find(r => r.canonical_exercise || r.exercise);
      stalls.push({
        liftCode,
        exercise: lastNamed ? (lastNamed.canonical_exercise || lastNamed.exercise) : '',
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
      exercise: stall.exercise || '',
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

// ─── Movement pattern classification ─────────────────────────────────────────
// Ordered: hinge before lower so 'Posterior Chain' → hinge, not lower.
// pull before push so 'Rear Delts' → pull, not push.
const PATTERN_REGEXES = [
  ['hinge', /posterior chain|lower back/i],
  ['lower', /leg|quad|hamstring|glute|calf|hip flexor|hip|adductor/i],
  ['pull',  /back|lat|rear delt|bicep|trap|rhomboid|row/i],
  ['push',  /chest|pec|shoulder|delt|tricep/i],
  ['core',  /core|ab|oblique/i]
];

function classifyMuscleGroup(muscleGroup) {
  const s = String(muscleGroup || '').trim();
  for (const [pattern, regex] of PATTERN_REGEXES) {
    if (regex.test(s)) return pattern;
  }
  return null;
}

// ─── Recovery model ───────────────────────────────────────────────────────────
// Per-pattern readiness used to snap between day-count bins (0 / 1 / 2–4 / 5+),
// which made fatigue jump rather than ease. These helpers replace the bins with
// a continuous exponential recovery curve whose speed depends on how hard the
// last session was (lower RIR = closer to failure = slower recovery).

// Recovery time-constant in days for a session ending at the given minimum RIR.
// Null/unknown RIR falls back to a moderate default.
function recoveryTau(minRir) {
  if (minRir == null || !Number.isFinite(minRir)) return 2.0;
  if (minRir <= 0) return 3.0;   // trained to failure — slowest recovery
  if (minRir >= 3) return 1.6;   // plenty left in the tank — fastest recovery
  return 3.0 - (minRir / 3) * 1.4; // smooth ramp between the two extremes
}

// Recovery fraction in [0,1]: 0 = just trained, 1 = fully recovered. The optional
// tauMultiplier stretches (>1) or compresses (<1) recovery based on how systemically
// hard the session was, derived from Apple Watch effort (see effortTauMultiplier).
function recoveryFraction(daysSince, minRir, tauMultiplier = 1) {
  if (daysSince == null || daysSince < 0) return null;
  return 1 - Math.exp(-daysSince / (recoveryTau(minRir) * tauMultiplier));
}

// Per-session systemic effort intensity in [0,1], normalised against the owner's
// own effort history (Apple Watch avg HR, active calories, duration). Returns an
// empty map when there isn't enough spread to normalise, keeping recovery neutral.
function effortIntensityBySession(effortRows = []) {
  const rows = (effortRows || []).map(normalizeEffortRow).filter(e => e.session_id);
  if (rows.length < 2) return new Map();

  const SIGNALS = ['average_hr', 'active_calories', 'duration_min'];
  const perSession = rows.map(e => {
    const durationMin = parseDurationMinutes(e.duration);
    return {
      session_id: e.session_id,
      average_hr: Number.isFinite(e.average_hr) && e.average_hr > 0 ? e.average_hr : null,
      active_calories: Number.isFinite(e.active_calories) && e.active_calories > 0 ? e.active_calories : null,
      duration_min: Number.isFinite(durationMin) && durationMin > 0 ? durationMin : null
    };
  });

  const range = {};
  for (const k of SIGNALS) {
    const vals = perSession.map(s => s[k]).filter(v => v != null);
    range[k] = vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
  }

  const norm = (k, v) => {
    if (v == null || !range[k]) return null;
    const { min, max } = range[k];
    if (max === min) return 0.5; // no spread on this signal — treat as neutral
    return (v - min) / (max - min);
  };

  const map = new Map();
  for (const s of perSession) {
    const parts = SIGNALS.map(k => norm(k, s[k])).filter(v => v != null);
    if (!parts.length) continue;
    const intensity = parts.reduce((a, b) => a + b, 0) / parts.length;
    map.set(s.session_id, Math.max(0, Math.min(1, intensity)));
  }
  return map;
}

// Map a session's effort intensity to a recovery time-constant multiplier.
// Neutral (1.0) at median effort or when effort data is absent; a brutal session
// stretches recovery, an easy one shortens it. Bounded to ±30%.
function effortTauMultiplier(intensity) {
  if (intensity == null) return 1;
  return 1 + (intensity - 0.5) * 0.6; // 0 → 0.7, 0.5 → 1.0, 1 → 1.3
}

// Map a recovery fraction to the discrete readiness label the UI and intent
// engine consume. Thresholds are tuned so a typical @2 RIR session reproduces
// the original day bins (0→fatigued, 1–2→recovering, 3–4→ready, 5+→fresh),
// while harder or easier sessions now shift the curve earlier or later.
function readinessStatus(recovery) {
  if (recovery == null) return 'unknown';
  if (recovery < 0.36) return 'fatigued';
  if (recovery < 0.70) return 'recovering';
  if (recovery < 0.89) return 'ready';
  return 'fresh';
}

// ─── Per-movement-pattern readiness ──────────────────────────────────────────
function buildMuscleGroupReadiness(logRows, { today = null, effortRows = [] } = {}) {
  const todayStr = today || new Date().toISOString().slice(0, 10);
  const normalized = logRows.map(normalizeLogRow).filter(r => r.weight > 0 && r.date_clean);
  const effortIntensity = effortIntensityBySession(effortRows);

  // key = `${session_id}:${pattern}` → { session_id, date, volume, minRir }
  const bySessionPattern = {};
  for (const row of normalized) {
    const pattern = classifyMuscleGroup(row.muscle_group);
    if (!pattern) continue;
    const key = `${row.session_id}:${pattern}`;
    if (!bySessionPattern[key]) bySessionPattern[key] = { session_id: row.session_id, date: row.date_clean, volume: 0, minRir: null };
    const d = bySessionPattern[key];
    if (row.date_clean > d.date) d.date = row.date_clean;
    d.volume += (row.weight || 0) * (row.reps || 0);
    if (row.rir != null && Number.isFinite(row.rir)) {
      d.minRir = d.minRir == null ? row.rir : Math.min(d.minRir, row.rir);
    }
  }

  const LABELS = { lower: 'Lower body', push: 'Pressing', pull: 'Pulling', hinge: 'Hinge', core: 'Core' };

  return ['lower', 'push', 'pull', 'hinge', 'core'].map(pattern => {
    let best = null;
    for (const [key, d] of Object.entries(bySessionPattern)) {
      if (key.endsWith(`:${pattern}`) && (!best || d.date > best.date)) best = d;
    }

    let daysSince = null;
    if (best) daysSince = Math.floor((new Date(todayStr) - new Date(best.date)) / 86400000);

    const minRir = best?.minRir ?? null;
    const intensity = best ? (effortIntensity.get(best.session_id) ?? null) : null;
    const recovery = recoveryFraction(daysSince, minRir, effortTauMultiplier(intensity));
    const status = readinessStatus(recovery);

    const detail = daysSince === null ? 'No training data'
      : daysSince === 0 ? 'Trained today'
      : daysSince === 1 ? `Trained yesterday${best.minRir != null ? ` — last effort @${best.minRir} RIR` : ''}`
      : `${daysSince} days since last session`;

    return {
      pattern,
      label: LABELS[pattern],
      status,
      daysSince,
      recovery: recovery == null ? null : Math.round(recovery * 100) / 100,
      effortIntensity: intensity == null ? null : Math.round(intensity * 100) / 100,
      lastDate: best?.date || null,
      lastSessionVolume: best?.volume || 0,
      lastSessionMinRir: best?.minRir ?? null,
      detail
    };
  });
}

// ─── Intent scoring engine ────────────────────────────────────────────────────
function scoreIntents(logRows, effortRows = [], { today = null } = {}) {
  const todayStr = today || new Date().toISOString().slice(0, 10);
  const readiness = buildMuscleGroupReadiness(logRows, { today: todayStr, effortRows });
  const fatigue = computeFatigueStatus(logRows, new Date(todayStr + 'T12:00:00'));
  const stalls = detectStalls(logRows);
  // Lifts with no progression over their last few sessions. Used to keep stale
  // lifts out of PR attempts and to surface a deload when several plateau.
  const stalledCodes = new Set(stalls.map(s => s.liftCode));

  const rm = Object.fromEntries(readiness.map(r => [r.pattern, r]));
  const canTrain = (...ps) => ps.some(p => ['ready', 'fresh'].includes(rm[p]?.status));
  const isFatigued = (...ps) => ps.some(p => rm[p]?.status === 'fatigued');
  const isFresh = (...ps) => ps.some(p => rm[p]?.status === 'fresh');

  // Collect all lift codes with muscle-group context
  const validCode = c => c && /[a-zA-Z]/.test(c);
  const normalized = logRows.map(normalizeLogRow).filter(r => validCode(r.lift_code) && r.weight > 0 && r.date_clean);

  const liftInfo = new Map(); // liftCode → { pattern, lastDate }
  for (const row of normalized) {
    const existing = liftInfo.get(row.lift_code);
    if (!existing || row.date_clean > existing.lastDate) {
      liftInfo.set(row.lift_code, { pattern: classifyMuscleGroup(row.muscle_group), lastDate: row.date_clean });
    }
  }

  // Get recommendations for each lift (only those with a next_target)
  const allRecs = [];
  for (const [liftCode, info] of liftInfo) {
    const rec = recommendNextSet(logRows, liftCode);
    if (rec.next_target && rec.sessions_analyzed > 0) {
      allRecs.push({ ...rec, pattern: info.pattern });
    }
  }
  // Sort by most recently trained so exercises are in recency order
  allRecs.sort((a, b) => {
    const da = a.last_working_sets?.length ? a.last_working_sets[a.last_working_sets.length - 1].date_clean : '';
    const db = b.last_working_sets?.length ? b.last_working_sets[b.last_working_sets.length - 1].date_clean : '';
    return db.localeCompare(da);
  });

  // Friendly name for a stalled lift code (falls back to the code itself).
  const liftNameByCode = new Map(allRecs.map(r => [r.liftCode, r.exercise_name]));
  const stallName = code => liftNameByCode.get(code) || code;

  const upwardLifts = allRecs.filter(r => r.e1rm_trend === 'up');
  const fatiguedPatterns = readiness.filter(r => r.status === 'fatigued');
  const freshPatterns = readiness.filter(r => r.status === 'fresh');
  const readyPatterns = readiness.filter(r => ['ready', 'fresh'].includes(r.status));

  const lastDate = normalized.reduce((max, r) => r.date_clean > max ? r.date_clean : max, '');
  const daysSinceLast = lastDate ? Math.floor((new Date(todayStr) - new Date(lastDate)) / 86400000) : null;

  // Build exercise list filtered by allowed movement patterns
  function exForPatterns(patterns, max = 6) {
    return allRecs
      .filter(r => patterns.includes(r.pattern))
      .slice(0, max)
      .map(r => ({
        exercise: r.exercise_name,
        lift_code: r.liftCode,
        target_weight: r.next_target.weight,
        target_reps: r.next_target.reps,
        target_sets: r.next_target.sets,
        reason: r.recommendation
      }));
  }

  // Standard pivot rules for an exercise list
  function pivotFor(exercises) {
    return exercises.slice(0, 2).flatMap(ex => [
      { exercise: ex.exercise, condition: 'Set 1 lands at @1 RIR', action: 'Hold weight — do not increase today' },
      { exercise: ex.exercise, condition: 'Set 1 lands at @0 RIR', action: 'Drop 5–10 lbs, back-off sets only' }
    ]);
  }

  // A stall is a *progression* signal (this lift needs a deload), which is
  // separate from a *today readiness* signal (is this muscle group rested now?).
  // Keep them apart so we never recommend deloading a muscle trained recently.
  const patternOf = code => liftInfo.get(code)?.pattern || null;
  const restedEnough = code => {
    const st = rm[patternOf(code)]?.status;
    return st === 'ready' || st === 'fresh' || st === 'unknown' || st == null;
  };
  const eligibleStalls = stalls.filter(s => restedEnough(s.liftCode));
  const holdStalls = stalls.filter(s => !restedEnough(s.liftCode));

  const intents = [];

  // ── Build Strength ───────────────────────────────────────────────
  {
    let score = 60;
    const why = [];
    const data = [];
    const protects = [];

    if (fatigue.status !== 'high') score += 20;
    else { score -= 15; why.push('Weekly volume is elevated — monitor total load'); }
    if (daysSinceLast === 0) score -= 15;
    if (daysSinceLast >= 2) score += 10;
    if (isFatigued('lower')) { score += 5; why.push('Lower body is recovering — upper strength is the smart target'); protects.push('Lower-body recovery'); }
    if (isFatigued('push')) score -= 20;
    if (canTrain('push', 'pull')) score += 15;
    const upPush = upwardLifts.filter(r => r.pattern === 'push');
    if (upPush.length) {
      score += 10;
      why.push(`${upPush[0].exercise_name} is trending up — good time to push strength`);
      data.push({ label: upPush[0].exercise_name, value: `→ ${upPush[0].next_target.weight} × ${upPush[0].next_target.reps}`, context: 'trending up' });
    }
    if (isFresh('pull')) { why.push('Pulling work is overdue — important for shoulder balance'); protects.push('Shoulder health via pulling rotation'); }
    if (rm.lower?.daysSince) data.push({ label: 'Lower body', value: `${rm.lower.daysSince}d since last session`, context: rm.lower.status });

    const exercises = exForPatterns(['push', 'pull']);
    // Only flag a plateau on lifts whose muscle group could actually be trained
    // today — warning about a fatigued lift here would just repeat the deload bug.
    for (const s of eligibleStalls.slice(0, 2)) {
      if (!exercises.some(ex => ex.lift_code === s.liftCode)) continue;
      why.push(`${stallName(s.liftCode)} hasn't improved in ${s.sessions_stalled} sessions — consider a lighter, technique-focused day`);
    }
    if (stalls.length) score -= Math.min(stalls.length * 8, 24);
    const confReasons = [];
    if (upPush.length) confReasons.push('Pressing trend is upward');
    if (isFatigued('lower')) confReasons.push('Clear lower-body fatigue signal');
    if (allRecs.filter(r => r.pattern === 'push').length) confReasons.push('Recent pressing data available');

    intents.push({
      id: 'build_strength',
      label: 'Build Strength',
      score,
      focus: isFatigued('lower') ? 'Upper body — press + pull' : 'Heavy compound work',
      confidence: score >= 75 ? 'high' : score >= 55 ? 'medium' : 'low',
      confidence_reasons: confReasons.length ? confReasons : ['Training data available'],
      why_today: why.length ? why : ['Good time for heavy compound work'],
      data_points: data,
      what_it_protects: protects.length ? protects : ['Strength trajectory'],
      watch_for: ['Shoulder pain above 3/10', 'Warmups feeling unusually heavy'],
      pivot_logic: pivotFor(exercises),
      exercises
    });
  }

  // ── Build Muscle ─────────────────────────────────────────────────
  {
    let score = 55;
    const why = [];

    if (fatigue.status === 'normal') { score += 15; why.push('Volume load is in a normal range — good conditions for hypertrophy work'); }
    if (fatigue.status === 'high') score -= 15;
    if (readyPatterns.length >= 2) { score += 10; why.push('Multiple muscle groups are recovered'); }
    if (upwardLifts.length === 0) score += 8;
    if (daysSinceLast === 0) score -= 10;

    const exercises = exForPatterns(['push', 'pull', 'lower', 'core'], 6);
    intents.push({
      id: 'build_muscle',
      label: 'Build Muscle',
      score,
      focus: 'Moderate load, 6–12 reps, higher volume',
      confidence: score >= 65 ? 'medium' : 'low',
      confidence_reasons: ['Volume-focused training available'],
      why_today: why.length ? why : ['Build volume across recovered muscle groups'],
      data_points: fatigue.ratio ? [{ label: 'Weekly load', value: `${fatigue.ratio}× baseline`, context: fatigue.status }] : [],
      what_it_protects: ['Muscle tissue development', 'Volume accumulation'],
      watch_for: ['Track RIR on high-rep sets', 'Avoid if feeling systemically fatigued'],
      pivot_logic: pivotFor(exercises),
      exercises
    });
  }

  // ── Fix Blind Spots ──────────────────────────────────────────────
  {
    let score = 40;
    const why = [];
    const data = [];
    const PLABEL = { lower: 'Lower body', push: 'Pressing', pull: 'Pulling', hinge: 'Hinge', core: 'Core' };

    for (const p of freshPatterns) {
      score += 20;
      why.push(`${PLABEL[p.pattern]} has not been trained in ${p.daysSince} days — rotation overdue`);
      data.push({ label: PLABEL[p.pattern], value: `${p.daysSince}d since last session`, context: 'overdue' });
    }

    const freshIds = freshPatterns.map(p => p.pattern);
    const exercises = freshIds.length ? exForPatterns(freshIds) : exForPatterns(['pull', 'core']);
    intents.push({
      id: 'fix_blind_spots',
      label: 'Fix Blind Spots',
      score,
      focus: freshIds.length ? freshPatterns.map(p => PLABEL[p.pattern]).join(' + ') : 'Neglected movements',
      confidence: freshIds.length > 0 ? 'high' : 'low',
      confidence_reasons: freshIds.length > 0 ? ['Specific underworked patterns identified from data'] : ['No clear gaps detected'],
      why_today: why.length ? why : ['Check for any movements not done recently'],
      data_points: data,
      what_it_protects: ['Movement pattern balance', 'Injury prevention via balanced training'],
      watch_for: ['Ease back into a rested pattern — do not max effort after a long gap'],
      pivot_logic: [],
      exercises
    });
  }

  // ── Balanced Day ─────────────────────────────────────────────────
  {
    let score = 50;
    const why = [];
    const allModerate = readiness.every(r => ['recovering', 'ready', 'unknown'].includes(r.status));
    if (allModerate) { score += 20; why.push('All movement patterns are in a moderate state'); }
    if (fatiguedPatterns.length) score -= 15;
    if (freshPatterns.length) score -= 10;
    if (fatigue.status === 'normal') score += 10;

    const exercises = exForPatterns(['push', 'pull', 'lower', 'hinge', 'core'], 6);
    intents.push({
      id: 'balanced',
      label: 'Balanced Day',
      score,
      focus: 'One exercise per major movement pattern',
      confidence: allModerate ? 'medium' : 'low',
      confidence_reasons: allModerate ? ['Balanced readiness across patterns'] : ['Some patterns may not be ready'],
      why_today: why.length ? why : ['A mix of movements when no single pattern stands out'],
      data_points: [],
      what_it_protects: ['Training consistency', 'Pattern balance'],
      watch_for: ['Adjust volume if any pattern feels heavier than expected'],
      pivot_logic: pivotFor(exercises),
      exercises
    });
  }

  // ── Recovery / Pump ──────────────────────────────────────────────
  {
    let score = 30;
    const why = [];

    if (fatigue.status === 'high') { score += 35; why.push('Weekly volume load is high — active recovery is the smart play'); }
    if (fatiguedPatterns.length >= 2) { score += 20; why.push(`${fatiguedPatterns.length} muscle groups are still recovering`); }
    if (daysSinceLast === 0) { score += 15; why.push('Already trained today — this is a light second session'); }
    if (fatigue.status === 'low') score -= 20;

    const baseExercises = exForPatterns(['push', 'pull', 'core'], 4);
    const exercises = baseExercises.map(ex => ({
      ...ex,
      target_weight: Math.round(ex.target_weight * 0.75 / 5) * 5,
      target_reps: Math.min(15, ex.target_reps + 4),
      reason: 'Light pump — 70–75% load, 12–15 reps, 2 sets'
    }));
    intents.push({
      id: 'recovery_pump',
      label: 'Recovery / Pump',
      score,
      focus: 'Light loads, 12–15 reps, blood flow',
      confidence: fatigue.status === 'high' ? 'high' : 'low',
      confidence_reasons: fatigue.status === 'high' ? ['High weekly volume detected'] : ['Best reserved for genuine fatigue'],
      why_today: why.length ? why : ['Use when you want to move but not add training stress'],
      data_points: fatigue.ratio ? [{ label: 'Weekly fatigue', value: `${fatigue.ratio}× baseline`, context: fatigue.status }] : [],
      what_it_protects: ['Recovery from accumulated load', 'Movement quality'],
      watch_for: ['If warmups feel great, upgrade to Build Muscle instead'],
      pivot_logic: [],
      exercises
    });
  }

  // ── Short Session ────────────────────────────────────────────────
  {
    let score = 45;
    const why = [];

    if (fatigue.status === 'high') { score += 15; why.push('Fatigue is elevated — a shorter session manages total stress'); }
    if (daysSinceLast >= 3) { score += 10; why.push('Been a few days — a short session gets training back on track'); }

    const exercises = exForPatterns(['push', 'pull'], 3).map(ex => ({ ...ex, target_sets: Math.min(ex.target_sets, 2) }));
    intents.push({
      id: 'short_session',
      label: 'Short Session',
      score,
      focus: '2–3 compounds, 20–30 minutes',
      confidence: 'medium',
      confidence_reasons: ['Always viable — adapts to any situation'],
      why_today: why.length ? why : ['Quick session when time or energy is limited'],
      data_points: [],
      what_it_protects: ['Training habit', 'Consistency without overloading'],
      watch_for: ['If you start feeling good, extend to Build Strength or Build Muscle'],
      pivot_logic: [],
      exercises
    });
  }

  // ── Test Progress ────────────────────────────────────────────────
  {
    let score = 35;
    const why = [];
    const data = [];

    // A stalled lift is not a PR candidate — only test lifts that are actually moving.
    const trendingFresh = upwardLifts.filter(r => !stalledCodes.has(r.liftCode));

    if (trendingFresh.length > 0) {
      score += 30;
      const best = trendingFresh[0];
      why.push(`${best.exercise_name} is trending upward — conditions are right for a PR attempt`);
      data.push({ label: best.exercise_name, value: `e1RM trending up`, context: `target ${best.next_target.weight} × ${best.next_target.reps}` });
    }
    if (daysSinceLast >= 3) score += 20;
    if (fatigue.status === 'high') score -= 25;
    if (daysSinceLast != null && daysSinceLast <= 1) score -= 20;
    if (fatiguedPatterns.length >= 2) score -= 15;

    const exercises = trendingFresh.slice(0, 3).map(r => ({
      exercise: r.exercise_name,
      lift_code: r.liftCode,
      target_weight: r.next_target.weight,
      target_reps: r.next_target.reps,
      target_sets: 1,
      reason: `PR attempt — ${r.recommendation}`
    }));
    intents.push({
      id: 'test_progress',
      label: 'Test Progress',
      score,
      focus: 'PR attempts on strongest trending lifts',
      confidence: trendingFresh.length > 0 && fatigue.status !== 'high' ? 'high' : 'low',
      confidence_reasons: trendingFresh.length > 0 ? ['Upward e1RM trend detected'] : ['No clear upward trend found'],
      why_today: why.length ? why : ['Best when a lift has trended up for 3+ sessions and fatigue is low'],
      data_points: data,
      what_it_protects: [],
      watch_for: ['Warmup must feel smooth before going heavy', 'Abort PR attempt if set 1 is harder than expected', 'Do not test when overall fatigue is high'],
      pivot_logic: trendingFresh.slice(0, 1).map(r => ({ exercise: r.exercise_name, condition: 'Warmup feels heavy', action: 'Abort PR — switch to a regular strength session' })),
      exercises
    });
  }

  // ── Deload & Reset (only for stalled lifts whose muscle group is rested) ──────
  // Appears when 2+ lifts have plateaued AND at least one of them sits on a
  // rested muscle group. Stalled lifts trained recently are surfaced as an
  // honest "due soon, not today" note rather than recommended for a session.
  if (eligibleStalls.length >= 1 && stalls.length >= 2) {
    const top = eligibleStalls.slice(0, 3);
    const patternLabel = code => rm[patternOf(code)]?.label || 'that muscle group';
    const why = top.map(s =>
      `${stallName(s.liftCode)} stalled for ${s.sessions_stalled} sessions — deload to ~${Math.round(s.last_best_weight * 0.9)} lb`
    );
    for (const s of holdStalls.slice(0, 2)) {
      why.push(`${stallName(s.liftCode)} needs a deload soon — not today, ${patternLabel(s.liftCode)} was trained recently`);
    }
    intents.push({
      id: 'deload_reset',
      label: 'Deload & Reset',
      score: 45 + eligibleStalls.length * 5,
      focus: 'Drop ~10%, sharpen form, rebuild momentum',
      confidence: eligibleStalls.length >= 3 ? 'high' : 'medium',
      confidence_reasons: [`${eligibleStalls.length} rested lift${eligibleStalls.length === 1 ? '' : 's'} ready for a reset`],
      why_today: why,
      data_points: top.map(s => ({ label: stallName(s.liftCode), value: `${s.sessions_stalled} sessions flat`, context: 'no progression' })),
      what_it_protects: ['Avoids grinding through a plateau', 'Lowers injury risk from repeated max-effort grinding'],
      watch_for: ['If a deloaded set still feels heavy, take a full rest day instead'],
      pivot_logic: [],
      exercises: top.map(s => ({
        exercise: stallName(s.liftCode),
        lift_code: s.liftCode,
        target_weight: Math.round(s.last_best_weight * 0.9),
        target_reps: 5,
        target_sets: 3,
        reason: 'Deload — 10% lighter, focus on clean reps'
      }))
    });
  }

  // ── Custom (always available, never starred) ─────────────────────
  intents.push({
    id: 'custom', label: 'Custom', score: 50, focus: 'You decide',
    confidence: null, confidence_reasons: [],
    why_today: ['Define your own intent for today'],
    data_points: [], what_it_protects: [], watch_for: [], pivot_logic: [], exercises: []
  });

  // Sort, mark the top non-custom intent as recommended
  intents.sort((a, b) => b.score - a.score);
  const top = intents.find(i => i.id !== 'custom');
  for (const i of intents) i.recommended = (i === top);

  return {
    today: todayStr,
    todays_read: {
      patterns: readiness,
      recommended_intent_id: top?.id ?? null,
      recommended_label: top?.label ?? null,
      recommended_reason: top?.focus ?? null
    },
    intents
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

function isoDateAtUtcNoon(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`);
}

function getWeekStartIso(dateStr) {
  const date = isoDateAtUtcNoon(dateStr);
  const day = date.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function addDaysIso(dateStr, days) {
  const date = isoDateAtUtcNoon(dateStr);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weeksBetweenInclusive(startWeek, endWeek) {
  const startMs = isoDateAtUtcNoon(startWeek).getTime();
  const endMs = isoDateAtUtcNoon(endWeek).getTime();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  return Math.floor((endMs - startMs) / weekMs) + 1;
}

function buildProgressSummary(logRows, { today = null, streakTargetPerWeek = 3, weeks = 12 } = {}) {
  const normalizedRows = (logRows || [])
    .map(normalizeLogRow)
    .filter(row => row.session_id && row.date_clean);

  const safeWeeks = Math.min(Math.max(8, Number(weeks) || 12), 12);
  const target = Math.max(1, Number(streakTargetPerWeek) || 3);
  const todayStr = today || new Date().toISOString().slice(0, 10);
  const currentWeekStart = getWeekStartIso(todayStr);

  if (!normalizedRows.length) {
    const weekBuckets = [];
    for (let i = safeWeeks - 1; i >= 0; i -= 1) {
      const weekStart = addDaysIso(currentWeekStart, -7 * i);
      weekBuckets.push({
        week_start: weekStart,
        week_end: addDaysIso(weekStart, 6),
        sessions: 0,
        total_volume: 0,
        total_sets: 0
      });
    }
    return {
      total_sessions: 0,
      average_sessions_per_week: 0,
      total_sets: 0,
      total_volume: 0,
      first_session_date: null,
      latest_session_date: null,
      current_week_sessions: 0,
      weekly_streak: 0,
      streak_target_per_week: target,
      sessions_by_week: weekBuckets.map(({ week_start, week_end, sessions }) => ({ week_start, week_end, sessions })),
      volume_by_week: weekBuckets.map(({ week_start, week_end, total_volume, total_sets }) => ({ week_start, week_end, total_volume, total_sets })),
      top_exercises: [],
      recent_prs: [],
      watchouts: []
    };
  }

  const sessionMap = new Map();
  const exerciseMap = new Map();
  let totalSets = 0;
  let totalVolume = 0;

  normalizedRows.forEach(row => {
    const session = sessionMap.get(row.session_id) || { session_id: row.session_id, date: row.date_clean };
    if (row.date_clean < session.date) session.date = row.date_clean;
    sessionMap.set(row.session_id, session);

    totalSets += 1;
    const volume = row.weight && row.reps ? row.weight * row.reps : 0;
    totalVolume += volume;

    const exerciseKey = row.lift_code || row.canonical_exercise || row.exercise;
    if (exerciseKey) {
      const existing = exerciseMap.get(exerciseKey) || {
        exercise: row.canonical_exercise || row.exercise || row.lift_code,
        lift_code: row.lift_code || '',
        set_count: 0,
        session_ids: new Set(),
        total_volume: 0,
        last_date: row.date_clean
      };
      existing.set_count += 1;
      existing.session_ids.add(row.session_id);
      existing.total_volume += volume;
      if (row.date_clean > existing.last_date) existing.last_date = row.date_clean;
      exerciseMap.set(exerciseKey, existing);
    }
  });

  const sessions = [...sessionMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.session_id.localeCompare(b.session_id));
  const totalSessions = sessions.length;
  const firstSessionDate = sessions[0].date;
  const latestSessionDate = sessions[sessions.length - 1].date;
  const firstWeekStart = getWeekStartIso(firstSessionDate);
  const latestWeekStart = getWeekStartIso(latestSessionDate);
  const activeTrainingWeeks = Math.max(1, weeksBetweenInclusive(firstWeekStart, latestWeekStart));
  const averageSessionsPerWeek = Math.round((totalSessions / activeTrainingWeeks) * 100) / 100;

  const sessionsPerWeek = new Map();
  const sessionIdsPerWeek = new Map();
  sessions.forEach(session => {
    const weekStart = getWeekStartIso(session.date);
    sessionsPerWeek.set(weekStart, (sessionsPerWeek.get(weekStart) || 0) + 1);
    if (!sessionIdsPerWeek.has(weekStart)) sessionIdsPerWeek.set(weekStart, new Set());
    sessionIdsPerWeek.get(weekStart).add(session.session_id);
  });

  const volumePerWeek = new Map();
  normalizedRows.forEach(row => {
    const weekStart = getWeekStartIso(row.date_clean);
    const current = volumePerWeek.get(weekStart) || { total_volume: 0, total_sets: 0 };
    current.total_volume += row.weight && row.reps ? row.weight * row.reps : 0;
    current.total_sets += 1;
    volumePerWeek.set(weekStart, current);
  });

  const weekBuckets = [];
  for (let i = safeWeeks - 1; i >= 0; i -= 1) {
    const weekStart = addDaysIso(currentWeekStart, -7 * i);
    const volumeBucket = volumePerWeek.get(weekStart) || { total_volume: 0, total_sets: 0 };
    weekBuckets.push({
      week_start: weekStart,
      week_end: addDaysIso(weekStart, 6),
      sessions: sessionsPerWeek.get(weekStart) || 0,
      total_volume: Math.round(volumeBucket.total_volume),
      total_sets: volumeBucket.total_sets
    });
  }

  let weeklyStreak = 0;
  for (let i = weekBuckets.length - 1; i >= 0; i -= 1) {
    if (weekBuckets[i].sessions >= target) {
      weeklyStreak += 1;
    } else {
      break;
    }
  }

  const topExercises = [...exerciseMap.values()]
    .map(item => ({
      exercise: item.exercise,
      lift_code: item.lift_code,
      set_count: item.set_count,
      session_count: item.session_ids.size,
      total_volume: Math.round(item.total_volume),
      last_date: item.last_date
    }))
    .sort((a, b) =>
      b.set_count - a.set_count ||
      b.session_count - a.session_count ||
      b.total_volume - a.total_volume ||
      (b.last_date || '').localeCompare(a.last_date || '')
    )
    .slice(0, 8);

  const watchouts = detectStalls(logRows, 3).slice(0, 5);

  return {
    total_sessions: totalSessions,
    average_sessions_per_week: averageSessionsPerWeek,
    total_sets: totalSets,
    total_volume: Math.round(totalVolume),
    first_session_date: firstSessionDate,
    latest_session_date: latestSessionDate,
    current_week_sessions: sessionsPerWeek.get(currentWeekStart) || 0,
    weekly_streak: weeklyStreak,
    streak_target_per_week: target,
    sessions_by_week: weekBuckets.map(({ week_start, week_end, sessions }) => ({ week_start, week_end, sessions })),
    volume_by_week: weekBuckets.map(({ week_start, week_end, total_volume, total_sets }) => ({ week_start, week_end, total_volume, total_sets })),
    top_exercises: topExercises,
    recent_prs: [],
    watchouts
  };
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
      lines.push(`Watchouts: ${stalls_or_watchouts.map(s => `${s.exercise || s.liftCode} stalled at ${s.last_best_weight} lb (${s.sessions_stalled} sessions)`).join(', ')}`);
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
  buildProgressSummary,
  buildExerciseDetail,
  buildRecentSessions,
  classifyMuscleGroup,
  buildMuscleGroupReadiness,
  scoreIntents
};
