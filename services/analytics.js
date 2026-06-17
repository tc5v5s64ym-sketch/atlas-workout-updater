const { parseNumber, normalizeDate, parseDurationMinutes, getSimpleTrend, calculateQualityScore, qualityScoreBreakdown } = require('./validation');
const { applyLiftRoleGuards, isAccessory, isMainCompound, guardAccessoryReps, recommendedTargetRir } = require('./liftRole');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function safeDateString(value, fallback = todayIso()) {
  const normalized = normalizeDate(value);
  if (normalized) return normalized;
  return fallback;
}

function safePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeLogRow(row) {
  if (!row || typeof row !== 'object') {
    return {
      date_clean: '',
      session_id: '',
      exercise: '',
      canonical_exercise: '',
      muscle_group: '',
      lift_code: '',
      set_number: '',
      weight: null,
      reps: null,
      rir: null,
      notes: ''
    };
  }

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
  if (!row || typeof row !== 'object') {
    return {
      date: '',
      session_id: '',
      duration: '',
      active_calories: null,
      total_calories: null,
      average_hr: null,
      peak_hr: null,
      location: '',
      notes: ''
    };
  }

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
    volume: isPositiveFinite(row.weight) && isPositiveFinite(row.reps) ? row.weight * row.reps : 0
  };
}

// Best weight lifted per lift code in a set of rows, with the exercise name.
// Used to detect new personal records when compared against historicalBestByLift.
function sessionBestByLift(rows) {
  const best = {};
  for (const row of rows) {
    if (!row.lift_code || row.lift_code === 'UNKNOWN' || !row.weight || row.weight <= 0) continue;
    const existing = best[row.lift_code];
    if (!existing || row.weight > existing.weight) {
      best[row.lift_code] = {
        weight: row.weight,
        exercise: row.canonical_exercise || row.exercise || row.lift_code
      };
    }
  }
  return best;
}

// Best weight per lift code across rows strictly before sessionDate (exclusive),
// excluding the current session. Using date < sessionDate prevents future
// sessions from inflating the baseline when scoring historical sessions.
function historicalBestByLift(allRows, currentSessionId, sessionDate) {
  const normId   = String(currentSessionId || '').trim().toLowerCase();
  const beforeDate = sessionDate || '';
  const best = {};
  for (const row of asArray(allRows).map(normalizeLogRow)) {
    if (row.session_id.toLowerCase() === normId) continue;
    if (beforeDate && row.date_clean >= beforeDate) continue;
    if (!row.lift_code || row.lift_code === 'UNKNOWN' || !row.weight || row.weight <= 0) continue;
    if (!best[row.lift_code] || row.weight > best[row.lift_code]) {
      best[row.lift_code] = row.weight;
    }
  }
  return best;
}

function buildSessionSummary(logRows, effortRows, sessionId, validationWarnings = []) {
  const normalizedSessionId = String(sessionId || '').trim().toLowerCase();
  const sessionLogRows = asArray(logRows)
    .map(normalizeLogRow)
    .filter(row => row.session_id.toLowerCase() === normalizedSessionId);

  const effortRow = asArray(effortRows)
    .map(normalizeEffortRow)
    .find(row => row.session_id.toLowerCase() === normalizedSessionId) || null;

  const uniqueExercises = [...new Set(sessionLogRows.map(row => row.canonical_exercise || row.exercise).filter(Boolean))];
  const totalSets = sessionLogRows.length;

  let totalVolume = 0;
  let topSet = null;

  for (const row of sessionLogRows) {
    if (isPositiveFinite(row.weight) && isPositiveFinite(row.reps)) {
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
    activeCalories: effortRow?.active_calories,
    uniqueExercisesCount: uniqueExercises.length,
    validationWarnings,
    setsWithRir: sessionLogRows.map(r => r.rir).filter(v => v !== null && Number.isFinite(v)),
    sessionBestByLift: sessionBestByLift(sessionLogRows),
    historicalBestByLift: historicalBestByLift(logRows, sessionId, effortRow?.date || sessionLogRows[0]?.date_clean || '')
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
  const rows = asArray(logRows)
    .map(normalizeLogRow)
    .filter(row => row.lift_code === normalizedCode && isPositiveFinite(row.weight) && isPositiveFinite(row.reps));

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
  cutoff.setDate(cutoff.getDate() - safePositiveNumber(days, 14));
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const summary = {};

  asArray(logRows).map(normalizeLogRow).forEach(row => {
    if (!row.date_clean || row.date_clean < cutoffIso) return;

    const muscleGroupKey = row.muscle_group || 'Unknown';
    const group = summary[muscleGroupKey] || { muscle_group: muscleGroupKey, volume: 0, set_count: 0 };
    if (isPositiveFinite(row.weight) && isPositiveFinite(row.reps)) {
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
  const normalizedRows = asArray(logRows).map(normalizeLogRow);
  const { exercise, liftCode, dateFrom, dateTo, muscleGroup } = filters || {};
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
  const rows = asArray(logRows).map(normalizeLogRow).filter(row => isPositiveFinite(row.weight) && isPositiveFinite(row.reps));
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

// Round a COMPUTED load to the nearest rackable increment (default 5 lb) so a
// percentage-derived target — e.g. a 10% deload — reads as a real weight a lifter
// can actually load: 185 × 0.9 = 166.5 → 165, not 167. Progression weights that
// are a logged weight plus a fixed step already respect the lifter's own
// increment (incl. micro-loading), so those are deliberately left untouched.
function roundLoad(weight, step = 5) {
  if (weight == null || weight === '') return null; // Number(null) === 0, guard it
  const w = Number(weight);
  if (!Number.isFinite(w)) return null;
  const s = Number.isFinite(step) && step > 0 ? step : 5;
  return Math.round(w / s) * s;
}

// The lifter's documented working weight for a lift, from a recommendation: the
// top of their recent working sets, falling back to their best, then the next
// target. Used to keep deload accessories anchored on what they actually lift.
function recentWorkingWeight(rec) {
  const sets = rec && Array.isArray(rec.last_working_sets) ? rec.last_working_sets : [];
  const weights = sets.map(s => Number(s.weight)).filter(isPositiveFinite);
  if (weights.length) return Math.max(...weights);
  if (rec && isPositiveFinite(rec.best_weight)) return rec.best_weight;
  const nt = rec && rec.next_target ? Number(rec.next_target.weight) : NaN;
  return isPositiveFinite(nt) ? nt : null;
}

// Deload load for an accessory/filler on a deload day. NEVER its next_target
// (that's a progression — a step UP). Hold the documented working weight —
// the deload cut comes via fewer sets, not a weight reduction. Falls back to
// the next target only if no history exists.
function deloadFillerWeight(rec) {
  const working = recentWorkingWeight(rec);
  if (!isPositiveFinite(working)) return rec && rec.next_target ? rec.next_target.weight : null;
  return working; // hold the working weight; volume cut happens via target_sets
}

// Effort read for a logged set: how the ACTUAL logged RIR compares to the target
// RIR. Deterministic — the rule engine owns this verdict; the coaching LLM only
// words it and must never derive its own read of how hard a set was.
//   failure   → RIR ≤ 0: at or near failure; acknowledge it and back off.
//   far_easy  → RIR ≥ target + 5: way under the target — not "on target with room",
//               it's under-effort; the read is "add real weight", not "nice work".
//   easy      → target + 2 ≤ RIR < target + 5: within reserve; room to add a bit.
//   hard      → 0 < RIR < target: a grinder, just shy of the target.
//   on_target → RIR at (or one above) the target.
// Returns null when no RIR was logged — there is nothing to read.
function effortVerdict(rir, targetRir) {
  if (rir == null || !Number.isFinite(Number(rir))) return null;
  const r = Number(rir);
  const t = Number.isFinite(Number(targetRir)) ? Number(targetRir) : 2;
  if (r <= 0) {
    return { level: 'failure', target_rir: t, headline: 'That set was at or near failure.' };
  }
  if (r - t >= 5) {
    return { level: 'far_easy', target_rir: t, headline: `Far too light — RIR ${r} against a target of ${t}, ${r - t} more in reserve than the goal. That's under-effort; add real weight next time.` };
  }
  if (r - t >= 2) {
    return { level: 'easy', target_rir: t, headline: `Well within reserve — RIR ${r} against a target of ${t}. Room to add load or reps.` };
  }
  if (r < t) {
    return { level: 'hard', target_rir: t, headline: `A grinder — RIR ${r}, just shy of the ${t} target.` };
  }
  return { level: 'on_target', target_rir: t, headline: `On target — RIR ${r}.` };
}

// The engine's read of today's LOAD against the lifter's own working history — the
// progression analogue of effortVerdict. Pure: it judges a single number (today's top
// working weight) against a band the engine already computed from real sessions. The
// model only WORDS this; it never derives its own read of progress. Levels:
//   new_ground         → top clears the historical ceiling (a fresh working best).
//   under_shot         → top below the bottom of the recent band.
//   progressing        → top above the band but not past the ceiling (climbing).
//   in_pocket          → top in the upper half of the band — solidly in range.
//   maintenance_drift  → top in the lower half of the band — holding but slipping.
// Returns null when there is no top or no band — there is nothing to read.
function progressionVerdict(top, band) {
  const t = Number(top);
  if (!isPositiveFinite(t)) return null;
  if (!band || typeof band !== 'object') return null;
  // Coerce strictly — Number(null) is 0, which would let a missing band slip through.
  const num = v => (v == null ? NaN : Number(v));
  const low = num(band.range_low);
  const high = num(band.range_high);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const ceiling = num(band.ceiling);
  const hasCeiling = Number.isFinite(ceiling);
  const out = (level, headline) => ({
    level,
    range_low: low,
    range_high: high,
    ceiling: hasCeiling ? ceiling : null,
    headline
  });
  if (hasCeiling && t > ceiling) {
    return out('new_ground', `New working weight — ${t} clears your previous best of ${ceiling}.`);
  }
  if (t < low) {
    return out('under_shot', `Under your range — ${t} is below your recent ${low}–${high} working band.`);
  }
  if (t > high) {
    return out('progressing', `Climbing — ${t} is above your recent ${low}–${high} band, pushing it up.`);
  }
  const midpoint = (low + high) / 2;
  if (t < midpoint) {
    return out('maintenance_drift', `Holding low — ${t} sits at the bottom of your ${low}–${high} band.`);
  }
  return out('in_pocket', `Right in your range — ${t} sits inside your recent ${low}–${high} band.`);
}

// The lifter's recent working-weight band for a lift, from their own session history.
// Top working weight per session (warm-ups never beat a working set, so a max is safe),
// chronological because the caller passes already-sorted rows. range_low/high come from
// the most recent `window` sessions; ceiling is the best top across all sessions seen.
// `excludeSessionId` drops the session being judged (e.g. today's) so the band is pure
// history. Returns null when no qualifying prior session exists — not enough to read.
function progressionBand(rows, excludeSessionId = null, window = 5) {
  const bySession = new Map();
  for (const r of asArray(rows)) {
    if (excludeSessionId != null && r.session_id === excludeSessionId) continue;
    if (!isPositiveFinite(r.weight)) continue;
    const cur = bySession.get(r.session_id) || 0;
    if (r.weight > cur) bySession.set(r.session_id, r.weight);
  }
  const tops = [...bySession.values()];
  if (!tops.length) return null;
  const ceiling = Math.max(...tops);
  const recent = tops.slice(-window);
  return { range_low: Math.min(...recent), range_high: Math.max(...recent), ceiling };
}

// Bug-1 path: when the lifter has JUST logged a set, session-level save means it
// is not in the sheet yet — so the recommendation must anchor on THAT set, not on
// stale history. RIR ≥ target + 2 → room to progress; RIR ≤ 0 → hold (near
// failure); between → repeat / add a rep. The advice can never contradict the
// logged RIR (RIR 5 can never read as "near failure").
function recommendFromJustLoggedSet(set, { targetRir, increaseAmount }) {
  const weight = Number(set.weight);
  const reps = Number(set.reps);
  const rir = set && set.rir != null && Number.isFinite(Number(set.rir)) ? Number(set.rir) : null;
  const verdict = effortVerdict(rir, targetRir);
  let recommendation;
  let reasoning;
  let nextWeight = weight;
  let nextReps = reps;
  let confidence = 'medium';

  if (rir == null) {
    recommendation = `Repeat ${weight} × ${reps} and log your RIR so I can tune the next step.`;
    reasoning = 'No RIR logged for that set — repeating the load until the effort is known.';
    confidence = 'low';
  } else if (rir <= 0) {
    recommendation = `Hold ${weight} × ${reps} — that set was at or near failure.`;
    reasoning = `RIR ${rir}: at or near failure. Keep the load and bank clean reps before adding weight.`;
    confidence = 'high';
  } else if (rir - targetRir >= 2) {
    nextWeight = weight + increaseAmount;
    recommendation = `Room to progress — move to ${nextWeight} × ${reps} next set.`;
    reasoning = `RIR ${rir} is well above the ${targetRir} target — you left ${rir} in reserve, so a ${increaseAmount} lb step up is warranted.`;
    confidence = 'high';
  } else if (rir < targetRir) {
    recommendation = `Hold ${weight} × ${reps} — you're right around target effort.`;
    reasoning = `RIR ${rir} is just shy of the ${targetRir} target. Repeat the load and keep form tight.`;
    confidence = 'medium';
  } else {
    nextReps = reps + 1;
    recommendation = `On target — keep ${weight} and chase ${nextReps} reps next set.`;
    reasoning = `RIR ${rir} matches the ${targetRir} target. Add a rep before adding load.`;
    confidence = 'medium';
  }

  return { recommendation, reasoning, next_target: { weight: nextWeight, reps: nextReps, sets: 3 }, effort_verdict: verdict, confidence };
}

// Post-deload recovery path: is the most recent session a ONE-OFF deload? If so the next session
// should return to the pre-deload working weight and resume normal progression —
// not carry the lighter deload load forward as the new baseline.
//
// Two signals, note text primary:
//   1. Explicit — any row in the last session has a note matching /deload/i.
//      Definitive when present, but rarely persisted to the sheet today (the
//      deload plan reason is not written into the row's notes column), so it is
//      mostly a safety net until an explicit deload marker is persisted (future
//      write-path PR).
//   2. Heuristic (the workhorse) — the last session's top working weight is ≥7%
//      below the established working weight (the heaviest of the prior few
//      sessions), with at least two prior sessions to anchor "established".
// Returns { isDeload, preDeloadWeight, lastTop, dropPct, signal } or null.
function detectDeloadRecovery(rows) {
  const order = [];
  const topBySession = new Map();
  const notesBySession = new Map();
  for (const row of rows) {
    const sid = row.session_id || '';
    if (!topBySession.has(sid)) { order.push(sid); topBySession.set(sid, 0); notesBySession.set(sid, []); }
    if (isPositiveFinite(row.weight)) topBySession.set(sid, Math.max(topBySession.get(sid), row.weight));
    if (row.notes) notesBySession.get(sid).push(String(row.notes));
  }
  if (order.length < 3) return null; // need ≥2 prior sessions plus the last one

  const lastSid = order[order.length - 1];
  const lastTop = topBySession.get(lastSid) || 0;
  if (!isPositiveFinite(lastTop)) return null;

  const recentPriorTops = order.slice(0, -1).slice(-3).map(s => topBySession.get(s)).filter(isPositiveFinite);
  if (recentPriorTops.length < 2) return null;
  const established = Math.max(...recentPriorTops);
  if (!isPositiveFinite(established) || lastTop >= established) return null;

  const explicit = (notesBySession.get(lastSid) || []).some(n => /deload/i.test(n));
  const dropPct = (established - lastTop) / established;
  if (!explicit && dropPct < 0.07) return null;

  return {
    isDeload: true,
    preDeloadWeight: established,
    lastTop,
    dropPct: Math.round(dropPct * 100),
    signal: explicit ? 'note' : 'heuristic'
  };
}

function recommendNextSet(logRows, liftCode, options = {}) {
  const { today = null } = options || {};
  const normalizedCode = String(liftCode || '').trim().toUpperCase();
  const rows = asArray(logRows)
    .map(normalizeLogRow)
    .filter(row => row.lift_code === normalizedCode && isPositiveFinite(row.weight) && isPositiveFinite(row.reps))
    .sort((a, b) => (a.date_clean || '').localeCompare(b.date_clean || '') || (a.session_id || '').localeCompare(b.session_id || '') || (Number(a.set_number) || 0) - (Number(b.set_number) || 0));

  if (!rows.length) {
    const base = {
      liftCode: normalizedCode,
      exercise_name: normalizedCode,
      last_working_sets: [],
      recommendation: 'No recent working sets found for this lift code.',
      reasoning: 'There is not enough history to make a recommendation.',
      next_target: null,
      sessions_analyzed: 0,
      days_since_last_session: null,
      target_rir: null,
      effort_verdict: null,
      progression_verdict: null
    };
    // Even with no history, a just-logged set still gets an effort read + a next
    // step anchored on that set (a brand-new lift logged in-workout).
    const jl = options.justLoggedSet;
    if (jl && isPositiveFinite(Number(jl.weight)) && isPositiveFinite(Number(jl.reps))) {
      const targetRir = recommendedTargetRir({ exercise: normalizedCode }, options.intentId);
      const anchored = recommendFromJustLoggedSet(jl, { targetRir, increaseAmount: 5 });
      return { ...base, recommendation: anchored.recommendation, reasoning: anchored.reasoning, next_target: anchored.next_target, confidence: anchored.confidence, target_rir: targetRir, effort_verdict: anchored.effort_verdict };
    }
    return base;
  }

  const exercise_name = rows[rows.length - 1].canonical_exercise || rows[rows.length - 1].exercise || normalizedCode;

  // How long since this lift was last trained. Progression assumes recent data;
  // after a layoff we repeat rather than add load (staleness guard below).
  const dayMs = 24 * 60 * 60 * 1000;
  const refMs = isoDateAtUtcNoon(safeDateString(today)).getTime();
  const lastDate = rows[rows.length - 1].date_clean;
  const daysSinceLastSession = lastDate
    ? Math.max(0, Math.round((refMs - isoDateAtUtcNoon(lastDate).getTime()) / dayMs))
    : null;

  // Count distinct sessions for this lift
  const sessions = [...new Set(rows.map(r => r.session_id))];

  const lastSets = rows.slice(-5).map(formatSet);
  const lastSet = lastSets[lastSets.length - 1];
  // Compare against the previous DISTINCT session's last working set — not merely
  // the prior set, which is usually in the same session. This makes the
  // "stable reps across two sessions" progression check a true session-over-session
  // signal, so a single session of equal-rep sets no longer triggers a load bump.
  const lastSessionId = lastSet ? lastSet.session_id : null;
  const priorSessionRows = rows.filter(row => row.session_id !== lastSessionId);
  const priorSet = priorSessionRows.length ? formatSet(priorSessionRows[priorSessionRows.length - 1]) : null;
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

  // Recommended effort target for this lift (role-aware). Drives the effort
  // verdict below; options.intentId lets a caller pass today's training goal.
  const targetRir = recommendedTargetRir({ exercise: exercise_name, muscle_group: muscleGroup }, options.intentId);
  let effort_verdict = null;

  const justLogged = options.justLoggedSet;
  if (justLogged && isPositiveFinite(Number(justLogged.weight)) && isPositiveFinite(Number(justLogged.reps))) {
    // Bug 1: in-workout, anchor the next step on the just-logged set — it is not
    // in the sheet yet (session-level save), so history alone is stale.
    const anchored = recommendFromJustLoggedSet(justLogged, { targetRir, increaseAmount });
    recommendation = anchored.recommendation;
    reasoning = anchored.reasoning;
    nextWeight = anchored.next_target.weight;
    nextReps = anchored.next_target.reps;
    confidence = anchored.confidence;
    effort_verdict = anchored.effort_verdict;
  } else {
    // Post-deload recovery — a deload is a one-off, so when the last session was a
    // (lighter) deload set, return to the pre-deload working weight and resume
    // normal progression rather than carry the deload weight forward. Detected from
    // history (detectDeloadRecovery); the active-deload prescription itself now
    // comes from the deload engine (services/deloadEngine).
    const deload = detectDeloadRecovery(rows);
    if (deload) {
      nextWeight = deload.preDeloadWeight;
      nextReps = lastSet.reps;
      recommendation = `That's your deload done — back to ${nextWeight} × ${nextReps} next session.`;
      reasoning = `Last session was a deload (${deload.lastTop} lb, ~${deload.dropPct}% lighter${deload.signal === 'note' ? ', noted' : ''}). A deload is a one-off — return to your working weight and resume normal progression.`;
      confidence = 'medium';
    }
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

  // Progression verdict — today's top working set judged against the lifter's own
  // recent band. Two sources for "today": in-workout the just-logged set is the truth
  // (it is not in the sheet yet), and the whole row history is prior history. Otherwise
  // the latest logged session is "today" and the band excludes it so the read is honest.
  let progressionTop = null;
  let band = null;
  if (justLogged && isPositiveFinite(Number(justLogged.weight))) {
    progressionTop = Number(justLogged.weight);
    band = progressionBand(rows, null);
  } else {
    progressionTop = rows
      .filter(r => r.session_id === lastSessionId && isPositiveFinite(r.weight))
      .reduce((m, r) => Math.max(m, r.weight), 0) || null;
    band = progressionBand(rows, lastSessionId);
  }
  const progression_verdict = isPositiveFinite(progressionTop) && band
    ? progressionVerdict(progressionTop, band)
    : null;

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
    best_weight,
    target_rir: targetRir,
    effort_verdict,
    progression_verdict
  };
}

function buildBodyweightHistory(rows, days = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - safePositiveNumber(days, 30));
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const entries = asArray(rows)
    .map(row => {
      const date = normalizeDate(Array.isArray(row) ? row[0] : row.date);
      return {
        date,
        weight: parseNumber(Array.isArray(row) ? row[1] : row.weight),
        notes: String(Array.isArray(row) ? row[2] : row.notes || '').trim()
      };
    })
    .filter(entry => entry.date && isPositiveFinite(entry.weight) && entry.date >= cutoffIso)
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
  const rows = asArray(logRows).map(normalizeLogRow).filter(row => isPositiveFinite(row.weight) && isPositiveFinite(row.reps));
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
      const current = sessionMap.get(key) || { session_id: row.session_id, date: row.date_clean, best_weight: 0, best_e1rm: 0 };
      current.best_weight = Math.max(current.best_weight, row.weight || 0);
      // Estimated 1RM (Epley, the same formula used elsewhere in this file) so the
      // stall decision counts reps, not just top weight: adding reps at a fixed
      // weight (205×5 → 205×6 → 205×7) is real progress, not a stall.
      const e1rm = row.weight * (1 + row.reps / 30);
      current.best_e1rm = Math.max(current.best_e1rm, e1rm || 0);
      sessionMap.set(key, current);
    });

    const sessions = Array.from(sessionMap.values());
    if (sessions.length < count) continue;

    const lastN = sessions.slice(-count);
    // Stall = best e1RM across the window did not meaningfully exceed the first
    // session's best e1RM. The epsilon keeps float noise from reading as progress;
    // a real same-weight rep gain clears it, a flat/falling window does not.
    const STALL_EPSILON = 1e-6;
    const maxE1rm = Math.max(...lastN.map(s => s.best_e1rm));
    const firstE1rm = lastN[0].best_e1rm;

    if (maxE1rm - firstE1rm <= STALL_EPSILON) {
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
    const deloadWeight = roundLoad(stall.last_best_weight);
    return {
      liftCode: stall.liftCode,
      exercise: stall.exercise || '',
      sessions_stalled: stall.sessions_stalled,
      last_best_weight: stall.last_best_weight,
      suggested_deload_weight: deloadWeight,
      suggestion: `No progression in ${stall.sessions_stalled} sessions. Deload: same weight, fewer sets, kept well short of failure for one pass, then rebuild.`
    };
  });
}

function computeFatigueStatus(logRows, referenceDate = new Date()) {
  const ref = new Date(referenceDate);
  const safeRef = Number.isFinite(ref.getTime()) ? ref : isoDateAtUtcNoon(todayIso());
  const dayMs = 24 * 60 * 60 * 1000;
  const recentCutoff = new Date(safeRef.getTime() - 7 * dayMs).toISOString().slice(0, 10);
  const baselineCutoff = new Date(safeRef.getTime() - 28 * dayMs).toISOString().slice(0, 10);

  let recentVolume = 0;
  let baselineVolume = 0;

  asArray(logRows).map(normalizeLogRow).forEach(row => {
    if (!row.date_clean || !isPositiveFinite(row.weight) || !isPositiveFinite(row.reps)) return;
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
  const logCandidates = asArray(logRows)
    .map(normalizeLogRow)
    .filter(row => /test/i.test(row.notes) || /test/i.test(row.session_id) || /session-2026/i.test(row.session_id));

  const effortCandidates = asArray(effortRows)
    .map(normalizeEffortRow)
    .filter(row => /test/i.test(row.notes) || /test/i.test(row.session_id) || /session-2026/i.test(row.session_id));

  return {
    log_candidates: logCandidates,
    effort_candidates: effortCandidates
  };
}

function buildExerciseDetail(logRows, liftCode, options = {}) {
  const { recentDays = 30, today = null } = options || {};
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

  const normalRows = asArray(logRows).map(normalizeLogRow).filter(r => r.lift_code === normalizedCode && isPositiveFinite(r.weight) && isPositiveFinite(r.reps));
  const exercise_names = [...new Set(normalRows.map(r => r.canonical_exercise || r.exercise).filter(Boolean))];

  const dayMs = 24 * 60 * 60 * 1000;
  const refMs = isoDateAtUtcNoon(safeDateString(today)).getTime();
  const cutoffDate = new Date(refMs - safePositiveNumber(recentDays, 30) * dayMs).toISOString().slice(0, 10);
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
  if (daysSince == null || !Number.isFinite(Number(daysSince)) || Number(daysSince) < 0) return null;
  const multiplier = Number.isFinite(Number(tauMultiplier)) && Number(tauMultiplier) > 0 ? Number(tauMultiplier) : 1;
  const recovery = 1 - Math.exp(-Number(daysSince) / (recoveryTau(minRir) * multiplier));
  return Number.isFinite(recovery) ? recovery : null;
}

// Per-session systemic effort intensity in [0,1], normalised against the owner's
// own effort history (Apple Watch avg HR, active calories, duration). Returns an
// empty map when there isn't enough spread to normalise, keeping recovery neutral.
function effortIntensityBySession(effortRows = []) {
  const rows = asArray(effortRows).map(normalizeEffortRow).filter(e => e.session_id);
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
  if (intensity == null || !Number.isFinite(Number(intensity))) return 1;
  return 1 + (Number(intensity) - 0.5) * 0.6; // 0 → 0.7, 0.5 → 1.0, 1 → 1.3
}

// Map a recovery fraction to the discrete readiness label the UI and intent
// engine consume. Thresholds are tuned so a typical @2 RIR session reproduces
// the original day bins (0→fatigued, 1–2→recovering, 3–4→ready, 5+→fresh),
// while harder or easier sessions now shift the curve earlier or later.
function readinessStatus(recovery) {
  if (recovery == null || !Number.isFinite(Number(recovery))) return 'unknown';
  if (recovery < 0.36) return 'fatigued';
  if (recovery < 0.70) return 'recovering';
  if (recovery < 0.89) return 'ready';
  return 'fresh';
}

// ─── Per-movement-pattern readiness ──────────────────────────────────────────
function buildMuscleGroupReadiness(logRows, options = {}) {
  const { today = null, effortRows = [] } = options || {};
  const todayStr = safeDateString(today);
  const normalized = asArray(logRows).map(normalizeLogRow).filter(r => isPositiveFinite(r.weight) && isPositiveFinite(r.reps) && r.date_clean);
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
    if (best) {
      const delta = isoDateAtUtcNoon(todayStr).getTime() - isoDateAtUtcNoon(best.date).getTime();
      daysSince = Number.isFinite(delta) ? Math.max(0, Math.floor(delta / 86400000)) : null;
    }

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
function scoreIntents(logRows, effortRows = [], options = {}) {
  const { today = null } = options || {};
  const todayStr = safeDateString(today);
  const readiness = buildMuscleGroupReadiness(logRows, { today: todayStr, effortRows });
  const fatigue = computeFatigueStatus(logRows, new Date(todayStr + 'T12:00:00'));
  // Lazily required to break a load-time cycle: coverageStalls → muscleVolume →
  // analytics. By the time scoreIntents runs, every module is fully loaded.
  const { annotateStallsForDeload } = require('./coverageStalls');
  // Each stall is tagged ignored_for_deload when it's a flat accessory whose
  // muscle is already covered by other lifts — downgraded, not erased.
  const stalls = annotateStallsForDeload(detectStalls(logRows), logRows);
  // Lifts with no progression over their last few sessions. Used to keep stale
  // lifts out of PR attempts and to surface a deload when several plateau.
  const stalledCodes = new Set(stalls.map(s => s.liftCode));

  const rm = Object.fromEntries(readiness.map(r => [r.pattern, r]));
  const canTrain = (...ps) => ps.some(p => ['ready', 'fresh'].includes(rm[p]?.status));
  const isFatigued = (...ps) => ps.some(p => rm[p]?.status === 'fatigued');
  const isFresh = (...ps) => ps.some(p => rm[p]?.status === 'fresh');

  // Collect all lift codes with muscle-group context
  const validCode = c => c && /[a-zA-Z]/.test(c);
  const normalized = asArray(logRows).map(normalizeLogRow).filter(r => validCode(r.lift_code) && isPositiveFinite(r.weight) && isPositiveFinite(r.reps) && r.date_clean);

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
  const daysSinceLast = lastDate ? Math.floor((isoDateAtUtcNoon(todayStr).getTime() - isoDateAtUtcNoon(lastDate).getTime()) / 86400000) : null;

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
  // Coverage-aware deload gate. A flat accessory whose primary muscle is already
  // covered by other lifts is downgraded (ignored_for_deload) and must not feed a
  // whole-program deload — but it stays in `stalls` (visible) for PR-exclusion and
  // watchouts. Mains, secondary lifts, and uncovered accessories keep feeding.
  const deloadFeedingStalls = stalls.filter(s => !s.ignored_for_deload);
  const eligibleStalls = deloadFeedingStalls.filter(s => restedEnough(s.liftCode));
  const holdStalls = deloadFeedingStalls.filter(s => !restedEnough(s.liftCode));

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
      target_weight: roundLoad(ex.target_weight * 0.75),
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
  if (eligibleStalls.length >= 1 && deloadFeedingStalls.length >= 2) {
    const top = eligibleStalls.slice(0, 3);
    const patternLabel = code => rm[patternOf(code)]?.label || 'that muscle group';
    const stalledNames = top.map(s => stallName(s.liftCode));
    const accessoryOnly = stalledNames.length > 0 && stalledNames.every(n => isAccessory(n));

    if (accessoryOnly) {
      // Accessory-only stalls aren't a systemic deload — and the day shouldn't be
      // "redo your 3 stalled lifts". Program a real recovery/accessory session from
      // the owner's non-compound movements; the stalls become a reset note.
      // Stalled lifts hold their load and chase reps (matching the "reset" note);
      // everything else progresses normally.
      const topCodes = new Set(top.map(s => s.liftCode));
      const stalledWeightByCode = new Map(stalls.map(s => [s.liftCode, s.last_best_weight]));
      const toExercise = r => {
        const held = stalledWeightByCode.has(r.liftCode);
        return guardAccessoryReps({
          exercise: r.exercise_name,
          lift_code: r.liftCode,
          target_weight: held ? stalledWeightByCode.get(r.liftCode) : r.next_target.weight,
          target_reps: r.next_target.reps,
          target_sets: r.next_target.sets,
          reason: held ? 'Reset — hold the load, chase clean reps' : r.recommendation
        });
      };

      const usable = allRecs.filter(r => r.exercise_name && r.next_target && !isMainCompound(r.exercise_name));
      const seen = new Set();
      const exercises = [];
      // 1) The stalled accessories that triggered this always lead the session
      //    (held load) — never crowded out by newer work.
      for (const r of usable) {
        if (topCodes.has(r.liftCode) && !seen.has(r.liftCode)) { seen.add(r.liftCode); exercises.push(toExercise(r)); }
      }
      for (const s of top) {                       // stalled lift with no recommendation → still reset it
        if (seen.has(s.liftCode)) continue;
        seen.add(s.liftCode);
        exercises.push(guardAccessoryReps({
          exercise: stallName(s.liftCode), lift_code: s.liftCode,
          target_weight: s.last_best_weight, target_reps: 12, target_sets: 3,
          reason: 'Reset — hold the load, chase clean reps'
        }));
      }
      // 2) Fill the rest with the owner's RESTED, non-compound movements only —
      //    keep patterns the readiness model just marked fatigued out of a recovery day.
      for (const r of usable) {
        if (exercises.length >= 6) break;
        if (seen.has(r.liftCode) || !restedEnough(r.liftCode)) continue;
        seen.add(r.liftCode);
        exercises.push(toExercise(r));
      }

      const resetList = stalledNames.join(', ');

      intents.push({
        id: 'deload_reset',
        label: 'Recovery Pull / Accessory',
        score: 45 + eligibleStalls.length * 5,
        focus: 'Main lifts are fatigued — bank quality pulling + accessory volume at moderate effort.',
        confidence: exercises.length >= 3 ? 'high' : 'medium',
        confidence_reasons: [`${exercises.length} rested accessory movement${exercises.length === 1 ? '' : 's'} available`],
        why_today: [
          `${resetList} ${stalledNames.length === 1 ? 'has' : 'have'} stalled — but an accessory stall doesn't warrant a systemic pullback.`,
          'Keep the big lifts off the table today and get clean pulling + arm/delt/core volume in.',
          'On the stalled ones, reset the load and chase 10–20 crisp reps, or rotate the variation if they stay stuck.'
        ],
        data_points: top.map(s => ({ label: stallName(s.liftCode), value: `${s.sessions_stalled} sessions flat`, context: "reset, don't grind" })),
        what_it_protects: ['Keeps momentum without digging a recovery hole', 'Saves the heavy-lift reset for when the main lifts actually slip'],
        watch_for: ["If a main lift starts grinding next session, that's the real signal to pull back"],
        pivot_logic: [],
        exercises
      });
    } else {
      const why = top.map(s =>
        `${stallName(s.liftCode)} stalled for ${s.sessions_stalled} sessions — hold ${s.last_best_weight} lb, cut to 2 sets at RIR 4–5`
      );
      for (const s of holdStalls.slice(0, 2)) {
        why.push(`${stallName(s.liftCode)} needs a deload soon — not today, ${patternLabel(s.liftCode)} was trained recently`);
      }

      // Frame the deload as a CHOICE with duration, return point, and a way to
      // decline. Fatigue is weighed too — a fresh-but-stalled lifter softens the
      // framing and scores below the pushing intents.
      const lead = top[0];
      const returnWeight = lead ? lead.last_best_weight : null;
      const returnName = lead ? stallName(lead.liftCode) : 'your main lifts';
      const freshButStalled = fatigue.status === 'low';
      const proposal = {
        duration: 'about one week — one pass through your rotation, then you step back up',
        loads: 'near-normal weight, just fewer sets and kept well short of failure (RIR 4–5)',
        return_point: returnWeight != null
          ? `back to your normal working weight right after — about ${returnWeight} lb on ${returnName}`
          : 'back to your normal working weight right after',
        decline: freshButStalled
          ? "You're not actually beat up this week, so this is optional — to push instead, pick Test Progress or a Strength session."
          : 'Prefer to power through? Pick Test Progress or a Strength session instead — this is your call.'
      };
      why.push(`Take it or skip it: ${proposal.duration}.`);
      why.push(`Loads are ${proposal.loads}, and you're ${proposal.return_point}.`);
      why.push(proposal.decline);
      const fatigueScoreAdj = fatigue.status === 'high' ? 10 : fatigue.status === 'low' ? -25 : 0;

      // The stalled mains lead the session — same weight, fewer sets, well short of failure.
      const exercises = top.map(s => ({
        exercise: stallName(s.liftCode),
        lift_code: s.liftCode,
        target_weight: roundLoad(s.last_best_weight),
        target_reps: 5,
        target_sets: 2,
        reason: 'Deload — same weight, fewer sets, well short of failure (RIR 4–5)'
      }));
      // A deload is still a full session — round it out to ~4–6 movements with the
      // owner's RESTED, non-compound accessories at moderate effort, so it's never
      // a token 1–2 lift day. Fatigued patterns and other main compounds stay out.
      const seen = new Set(exercises.map(e => e.lift_code));
      const fillers = allRecs.filter(r => r.exercise_name && r.next_target && !isMainCompound(r.exercise_name));
      for (const r of fillers) {
        if (exercises.length >= 6) break;
        if (seen.has(r.liftCode) || !restedEnough(r.liftCode)) continue;
        seen.add(r.liftCode);
        exercises.push(guardAccessoryReps({
          exercise: r.exercise_name,
          lift_code: r.liftCode,
          target_weight: deloadFillerWeight(r),
          target_reps: r.next_target.reps,
          target_sets: Math.max(1, r.next_target.sets - 1),
          reason: 'Accessory volume — near-normal weight, a set lighter, moderate effort'
        }));
      }

      intents.push({
        id: 'deload_reset',
        label: 'Deload & Reset',
        score: 45 + eligibleStalls.length * 5 + fatigueScoreAdj,
        focus: 'Fewer sets at near-normal weight for about a week, kept well short of failure, then step back to your normal volume',
        confidence: eligibleStalls.length >= 3 ? 'high' : 'medium',
        confidence_reasons: [`${eligibleStalls.length} rested lift${eligibleStalls.length === 1 ? '' : 's'} ready for a reset`],
        why_today: why,
        proposal,
        data_points: top.map(s => ({ label: stallName(s.liftCode), value: `${s.sessions_stalled} sessions flat`, context: 'no progression' })),
        what_it_protects: ['Avoids grinding through a plateau', 'Lowers injury risk from repeated max-effort grinding'],
        watch_for: ['If a deloaded set still feels heavy, take a full rest day instead'],
        pivot_logic: [],
        exercises
      });
    }
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

  return applyLiftRoleGuards({
    today: todayStr,
    todays_read: {
      patterns: readiness,
      recommended_intent_id: top?.id ?? null,
      recommended_label: top?.label ?? null,
      recommended_reason: top?.focus ?? null
    },
    intents
  });
}


function buildRecentSessions(logRows, effortRows, options = {}) {
  const { limit = 15 } = options || {};
  const safeLimit = Math.min(Math.max(1, Number(limit) || 15), 50);

  const normalizedLog = asArray(logRows).map(normalizeLogRow).filter(r => r.session_id);
  const normalizedEffort = asArray(effortRows).map(normalizeEffortRow);

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
    if (isPositiveFinite(r.weight) && isPositiveFinite(r.reps)) {
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
  const normalized = normalizeDate(dateStr) || todayIso();
  const date = new Date(`${normalized}T12:00:00Z`);
  return Number.isFinite(date.getTime()) ? date : new Date(`${todayIso()}T12:00:00Z`);
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
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : 0;
  date.setUTCDate(date.getUTCDate() + safeDays);
  return date.toISOString().slice(0, 10);
}

function weeksBetweenInclusive(startWeek, endWeek) {
  const startMs = isoDateAtUtcNoon(startWeek).getTime();
  const endMs = isoDateAtUtcNoon(endWeek).getTime();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 1;
  return Math.floor((endMs - startMs) / weekMs) + 1;
}

function buildProgressSummary(logRows, options = {}) {
  const { today = null, streakTargetPerWeek = 3, weeks = 12 } = options || {};
  const normalizedRows = asArray(logRows)
    .map(normalizeLogRow)
    .filter(row => row.session_id && row.date_clean);

  const safeWeeks = Math.min(Math.max(8, Number(weeks) || 12), 12);
  const target = Math.max(1, Number(streakTargetPerWeek) || 3);
  const todayStr = safeDateString(today);
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
    const volume = isPositiveFinite(row.weight) && isPositiveFinite(row.reps) ? row.weight * row.reps : 0;
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
    current.total_volume += isPositiveFinite(row.weight) && isPositiveFinite(row.reps) ? row.weight * row.reps : 0;
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

function buildWeeklyReport(logRows, options = {}) {
  const { days = 7, today = null } = options || {};
  const dayMs = 24 * 60 * 60 * 1000;
  const safeDays = safePositiveNumber(days, 7);
  const refDate = isoDateAtUtcNoon(safeDateString(today));
  const periodEnd = refDate.toISOString().slice(0, 10);
  const periodStart = new Date(refDate.getTime() - (safeDays - 1) * dayMs).toISOString().slice(0, 10);
  const priorEnd = new Date(refDate.getTime() - safeDays * dayMs).toISOString().slice(0, 10);
  const priorStart = new Date(refDate.getTime() - (2 * safeDays - 1) * dayMs).toISOString().slice(0, 10);

  const weekRows = asArray(logRows).filter(row => {
    const d = normalizeDate(Array.isArray(row) ? row[0] : row?.date_clean || row?.date);
    return d >= periodStart && d <= periodEnd && isPositiveFinite(Number(Array.isArray(row) ? row[7] : row?.weight)) && isPositiveFinite(Number(Array.isArray(row) ? row[8] : row?.reps));
  });
  const priorRows = asArray(logRows).filter(row => {
    const d = normalizeDate(Array.isArray(row) ? row[0] : row?.date_clean || row?.date);
    return d >= priorStart && d <= priorEnd && isPositiveFinite(Number(Array.isArray(row) ? row[7] : row?.weight)) && isPositiveFinite(Number(Array.isArray(row) ? row[8] : row?.reps));
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

// Swap detection — PR 3.5 (COACH_PLAN.md).
//
// Detects whether the logged exercise differs from the prescribed one.
// Comparison is case- and whitespace-insensitive so "bench press" and
// "Bench Press" are not a swap. Null/missing inputs are never a swap.
// Pure — no log data required.
function detectSwap(prescribedExercise, loggedExercise) {
  const norm = s => (s && typeof s === 'string' ? s.trim().toLowerCase() : null);
  const a = norm(prescribedExercise);
  const b = norm(loggedExercise);
  if (!a || !b) {
    return {
      swapped: false,
      prescribedExercise: (prescribedExercise && typeof prescribedExercise === 'string') ? prescribedExercise.trim() : null,
      loggedExercise:     (loggedExercise     && typeof loggedExercise     === 'string') ? loggedExercise.trim()     : null,
    };
  }
  return {
    swapped: a !== b,
    prescribedExercise: prescribedExercise.trim(),
    loggedExercise:     loggedExercise.trim(),
  };
}

// Working-weight finder — PR 3.5 (COACH_PLAN.md).
//
// Produces the "find your working weight at the target RIR" calibration
// protocol for when a lifter swaps to an exercise with no clean equivalent
// load — i.e. no prior history to anchor a recommendation.
//
//   targetReps      — prescribed rep count (default 8)
//   targetRir       — prescribed RIR (default 2)
//   referenceWeight — the prescribed weight for the ORIGINAL lift (optional)
//
// Returns: { instruction, targetReps, targetRir, startHint }
//   startHint   — 70% of referenceWeight rounded to nearest 5 lb, or null
//   instruction — plain-English protocol for the coach voice to word
//
// The 70% anchor is deliberately conservative: mechanics differ across
// exercise variations and it's always safer to step up than to miss a rep
// on an unfamiliar movement.
function buildWorkingWeightProtocol({ targetReps = 8, targetRir = 2, referenceWeight = null } = {}) {
  const parseOrDefault = (v, d) => { if (v == null) return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
  const reps = Math.max(1, Math.round(parseOrDefault(targetReps, 8)));
  const rir  = Math.max(0, Math.round(parseOrDefault(targetRir,  2)));

  let startHint   = null;
  let startPhrase = 'Start conservative';

  const ref = referenceWeight != null ? Number(referenceWeight) : NaN;
  if (Number.isFinite(ref) && ref > 0) {
    startHint   = Math.round((ref * 0.7) / 5) * 5;
    startPhrase = `Start around ${startHint} lbs`;
  }

  const instruction = `${startPhrase} and work up in small steps until ${reps} reps leaves you ${rir} in reserve. That working weight is your baseline for this variation.`;

  return { instruction, targetReps: reps, targetRir: rir, startHint };
}

// Expectation verdict engine — PR 3.3 (COACH_PLAN.md).
//
// Compares what was actually logged (actualRir) to what was prescribed
// (prescribedRir) and emits a structured verdict the coach voice (PR 3.4)
// can react to. Nothing surfaces this yet — pure data.
//
//   outcome    ∈ { 'beat' | 'met' | 'fell_short' | 'swap' }
//   rirDelta   = actualRir − prescribedRir
//                negative → pushed harder than target
//                positive → left more in reserve than target (sandbagged)
//   swapped    = true when the logged exercise differs from the prescribed one;
//                in that case actualRir/rirDelta are null (no RIR comparison).
//
// Returns null when actualRir is absent and swapped is false — nothing to read.
// prescribedRir defaults to 2 (matching effortVerdict) when omitted or NaN.
function computeExpectationVerdict({ actualRir = null, prescribedRir = null, swapped = false } = {}) {
  if (swapped) {
    return {
      outcome:       'swap',
      why:           'Exercise swapped — no direct RIR comparison; treat as a smart adjustment.',
      prescribedRir: null,
      actualRir:     null,
      rirDelta:      null,
    };
  }

  if (actualRir == null || !Number.isFinite(Number(actualRir))) return null;

  const actual     = Number(actualRir);
  const prescribed = (prescribedRir != null && Number.isFinite(Number(prescribedRir))) ? Number(prescribedRir) : 2;
  const rirDelta   = Math.round((actual - prescribed) * 100) / 100;

  let outcome, why;

  if (rirDelta < 0) {
    outcome = 'beat';
    why = actual <= 0
      ? `Hit failure — pushed beyond the ${prescribed} RIR target.`
      : `RIR ${actual} vs target ${prescribed} — pushed ${Math.abs(rirDelta)} below target.`;
  } else if (rirDelta >= 2) {
    outcome = 'fell_short';
    why = `RIR ${actual} vs target ${prescribed} — ${rirDelta} reps left in the tank.`;
  } else {
    outcome = 'met';
    why = rirDelta === 0
      ? `RIR ${actual} — right on the ${prescribed} target.`
      : `RIR ${actual} — one above the ${prescribed} target; within range.`;
  }

  return { outcome, why, prescribedRir: prescribed, actualRir: actual, rirDelta };
}

module.exports = {
  normalizeLogRow,
  buildSessionSummary,
  computeExerciseProgress,
  computeMuscleGroupVolume,
  searchSessions,
  detectRecentPrs,
  recommendNextSet,
  effortVerdict,
  progressionVerdict,
  progressionBand,
  computeExpectationVerdict,
  roundLoad,
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
  scoreIntents,
  recoveryFraction,
  effortIntensityBySession,
  detectSwap,
  buildWorkingWeightProtocol
};
