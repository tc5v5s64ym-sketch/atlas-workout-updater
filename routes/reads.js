'use strict';

// Read / analytics routes (Remediation PR-16).
//
// Extracted VERBATIM from index.js into an Express Router. Byte-identical paths,
// handler bodies, and the two :param orderings (last-session before :liftCode,
// recent before :sessionId). Auth, rate-limiters, and the flight-recorder are
// GLOBAL `app.use('/api', …)` middleware in index.js and run before this router
// regardless of mount position, so no per-route middleware moves here.
//
// The shared sheet-rows cache is INJECTED (`getSheetRows`) so a write in index.js
// still invalidates the rows these reads see — the router must never build its own.
// `catalogCache` + `buildExerciseCatalogEntries` are slice-exclusive and live here.

const express = require('express');
const { success: standardSuccess, error: standardError } = require('../response');
const { getRecentRows, getExerciseCatalog, logSheetName, effortSheetName } = require('../sheets');
const {
  computeExerciseProgress,
  computeMuscleGroupVolume,
  searchSessions,
  detectRecentPrs,
  detectStalls,
} = require('../services/analytics');
const trainingStore = require('../services/trainingStore');
const { createTtlCache } = require('../services/cache');

const catalogCache = createTtlCache(60 * 1000);

function buildExerciseCatalogEntries(rows) {
  if (!rows.length) return [];

  const header = rows[0].map(cell => String(cell || '').trim().toLowerCase());
  const exerciseIndex = header.findIndex(value => ['exercise', 'exercise_name', 'exercise name'].includes(value));
  const canonicalNameIndex = header.findIndex(value => ['canonical_name', 'canonical name', 'canonicalname', 'canonical_exercise', 'canonical exercise', 'canonicalexercise'].includes(value));
  const muscleGroupIndex = header.findIndex(value => ['muscle_group', 'muscle group', 'musclegroup'].includes(value));
  const liftCodeIndex = header.findIndex(value => ['lift code', 'lift_code', 'liftcode'].includes(value));
  const variantsIndex = header.findIndex(value => ['original_variants', 'original variants', 'originalvariant', 'original variant'].includes(value));

  if (canonicalNameIndex === -1 && exerciseIndex === -1) {
    throw new Error('Exercise_Catalog header must include Exercise or Canonical_Name.');
  }

  const entries = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const exerciseName = exerciseIndex === -1 ? '' : String(row[exerciseIndex] || '').trim();
    const canonicalName = String(row[canonicalNameIndex] || exerciseName).trim();
    if (!canonicalName) continue;

    const muscleGroup = String(row[muscleGroupIndex] || '').trim();
    const liftCode = String(row[liftCodeIndex] || '').trim();
    const variants = variantsIndex !== -1
      ? String(row[variantsIndex] || '')
          .split(/[,;|]/)
          .map(v => String(v).trim())
          .filter(Boolean)
      : [];

    entries.push({
      canonical_name: canonicalName,
      exercise: exerciseName || canonicalName,
      muscle_group: muscleGroup,
      lift_code: liftCode,
      variants
    });
  }

  return entries;
}

module.exports = function registerReadRoutes({ getSheetRows }) {
  const router = express.Router();

  // GET /api/history/recent
  router.get('/api/history/recent', async (req, res) => {

    const limit = Number(req.query.limit) || 5;
    const exerciseFilter = req.query.exercise ? String(req.query.exercise).toLowerCase() : null;

    try {
      const recentLog = await getRecentRows(logSheetName, Math.max(100, limit * 20));
      const recentEffort = await getRecentRows(effortSheetName, Math.max(limit, 20));

      let filteredLog = recentLog;
      if (exerciseFilter) {
        filteredLog = recentLog.filter(r => String(r[2] || '').toLowerCase() === exerciseFilter);
      }

      if (req.query.exclude_test === 'true') {
        filteredLog = filteredLog.filter(r => !/test/i.test(String(r[10] || '')));
      }
      const filteredEffort = req.query.exclude_test === 'true'
        ? recentEffort.filter(r => !/test/i.test(String(r[8] || '')))
        : recentEffort;

      const recent_sets = filteredLog.slice(-limit).map(row => ({
        date_clean: row[0],
        session_id: row[1],
        exercise: row[2],
        canonical_exercise: row[3],
        muscle_group: row[4],
        lift_code: row[5],
        set_number: row[6],
        weight: row[7],
        reps: row[8],
        rir: row[9],
        notes: row[10]
      }));

      const sessionMap = new Map();
      for (const row of [...recent_sets].reverse()) {
        if (!sessionMap.has(row.session_id)) {
          sessionMap.set(row.session_id, { session_id: row.session_id, date: row.date_clean });
        }
      }
      const recent_sessions = Array.from(sessionMap.values()).reverse().slice(-limit);
      // Like recent_sets above: the sheet appends downward, so the newest rows
      // are at the END of the window — take the tail, keep sheet order.
      const recent_effort = filteredEffort.slice(-limit).map(row => ({
        date: row[0],
        session_id: row[1],
        duration: row[2],
        active_calories: row[3],
        total_calories: row[4],
        average_hr: row[5],
        peak_hr: row[6],
        location: row[7],
        notes: row[8]
      }));

      return res.json({ status: 'ok', data: { recent_sessions, recent_sets, recent_effort } });
    } catch (error) {
      return standardError(req, res, 'Failed to fetch history', error.message, 500);
    }
  });

  // GET /api/exercises/last-session?exercise=Back+Squat
  // Returns the sets from the most recent session that included this exercise.
  // Used by the logger to show "last time" hints without a full reload.
  router.get('/api/exercises/last-session', async (req, res) => {
    const exercise = String(req.query.exercise || '').trim();
    if (!exercise) return standardError(req, res, 'exercise query param required', null, 400);

    try {
      const allLog = await getSheetRows(logSheetName);
      const lowerExercise = exercise.toLowerCase();
      // Find all rows where exercise or canonical_exercise matches (substring)
      const matchingRows = allLog.filter(row => {
        const ex = String(row[2] || '').toLowerCase();
        const canonical = String(row[3] || '').toLowerCase();
        return ex.includes(lowerExercise) || canonical.includes(lowerExercise);
      });
      if (!matchingRows.length) {
        return standardSuccess(req, res, 'No prior sets for this exercise', { sets: [], session_id: null, date: null });
      }
      // Find the most recent session containing this exercise
      const sortedRows = matchingRows.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
      const lastSessionId = String(sortedRows[0][1] || '');
      const sessionRows = lastSessionId
        ? matchingRows.filter(row => String(row[1] || '') === lastSessionId)
        : [sortedRows[0]];
      const sets = sessionRows.map(row => ({
        set_number: String(row[6] || ''),
        weight: String(row[7] || ''),
        reps: String(row[8] || ''),
        rir: String(row[9] || ''),
        notes: String(row[10] || '')
      }));
      return standardSuccess(req, res, 'Last session sets', {
        exercise,
        session_id: lastSessionId,
        date: String(sortedRows[0][0] || ''),
        sets
      });
    } catch (error) {
      return standardError(req, res, 'Failed to fetch last session', error.message, 500);
    }
  });

  // GET /api/exercises/:liftCode
  router.get('/api/exercises/:liftCode', async (req, res) => {

    const liftCode = String(req.params.liftCode || '').trim().toLowerCase();
    if (!liftCode) return standardError(req, res, 'liftCode is required in path', null, 400);

    try {
      const allLog = await getRecentRows(logSheetName, 1000);
      const matching = allLog.filter(row => String(row[5] || '').toLowerCase() === liftCode);

      const exerciseNames = [...new Set(matching.map(r => r[2]))];
      const totalSets = matching.length;
      const workingSets = matching.filter(r => Number(r[7]) > 0);
      const rowToSet = r => ({
        date_clean: r[0],
        session_id: r[1],
        exercise: r[2],
        canonical_exercise: r[3],
        muscle_group: r[4],
        lift_code: r[5],
        set_number: r[6],
        weight: r[7],
        reps: r[8],
        rir: r[9],
        notes: r[10]
      });

      const bestWeightRow = workingSets.reduce((best, r) => {
        const w = Number(r[7]);
        if (!Number.isFinite(w)) return best;
        if (!best || w > Number(best[7])) return r;
        return best;
      }, null);
      const bestVolumeRow = workingSets.reduce((best, r) => {
        const w = Number(r[7]);
        const reps = Number(r[8]);
        if (!Number.isFinite(w) || !Number.isFinite(reps)) return best;
        const volume = w * reps;
        const bestVolume = best ? Number(best[7]) * Number(best[8]) : -1;
        if (!best || volume > bestVolume) return r;
        return best;
      }, null);
      const estimated1RM = workingSets.reduce((max, r) => {
        const w = Number(r[7]);
        const reps = Number(r[8]);
        if (!Number.isFinite(w) || !Number.isFinite(reps)) return max;
        return Math.max(max, w * (1 + reps / 30));
      }, 0);

      const recentWorkingSets = matching.filter(r => Number(r[7]) > 0).slice(-10).map(rowToSet);

      return res.json({ status: 'ok', data: {
        liftCode: liftCode.toUpperCase(),
        exerciseNames,
        totalSets,
        bestWeightSet: bestWeightRow ? rowToSet(bestWeightRow) : null,
        bestVolumeSet: bestVolumeRow ? rowToSet(bestVolumeRow) : null,
        estimated1RM,
        recentWorkingSets
      } });
    } catch (error) {
      return standardError(req, res, 'Failed to fetch exercise detail', error.message, 500);
    }
  });

  router.get('/api/exercises/:liftCode/progress', async (req, res) => {

    const liftCode = String(req.params.liftCode || '').trim();
    if (!liftCode) {
      return standardError(req, res, 'liftCode is required in path', null, 400);
    }

    try {
      const allLog = await getSheetRows(logSheetName);
      const progress = computeExerciseProgress(allLog, liftCode);
      return standardSuccess(req, res, 'Exercise progress', progress);
    } catch (error) {
      return standardError(req, res, 'Failed to fetch exercise progress', error.message, 500);
    }
  });

  // GET /api/exercises/:liftCode/detail
  // Combined single-call exercise detail: names, session count, last 5 sessions,
  // best recent set (30-day window), volume trend, and current recommendation.
  router.get('/api/exercises/:liftCode/detail', async (req, res) => {
    const liftCode = String(req.params.liftCode || '').trim();
    if (!liftCode) return standardError(req, res, 'liftCode is required in path', null, 400);
    try {
      const detail = await trainingStore.getExerciseDetail(liftCode, { rowLimit: 1000 });
      return standardSuccess(req, res, 'Exercise detail', detail);
    } catch (error) {
      return standardError(req, res, 'Failed to fetch exercise detail', error.message, 500);
    }
  });

  router.get('/api/volume/muscle-groups', async (req, res) => {

    const days = parseInt(req.query.days || '14', 10);
    if (Number.isNaN(days) || days <= 0) {
      return standardError(req, res, 'days must be a positive integer', null, 400);
    }

    try {
      const allLog = await getSheetRows(logSheetName);
      const groups = computeMuscleGroupVolume(allLog, days);
      return standardSuccess(req, res, 'Muscle group volume summary', { days, groups });
    } catch (error) {
      return standardError(req, res, 'Failed to fetch muscle group volume', error.message, 500);
    }
  });

  router.get('/api/search/sessions', async (req, res) => {

    const filters = {
      exercise: req.query.exercise,
      liftCode: req.query.liftCode,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      muscleGroup: req.query.muscleGroup
    };

    try {
      const allLog = await getSheetRows(logSheetName);
      const result = searchSessions(allLog, filters);
      return standardSuccess(req, res, 'Session search results', result);
    } catch (error) {
      return standardError(req, res, 'Failed to search sessions', error.message, 500);
    }
  });

  // GET /api/catalog/exercises
  router.get('/api/catalog/exercises', async (req, res) => {

    try {
      const cached = catalogCache.get('catalog:rows');
      const rows = cached || await getExerciseCatalog();
      if (!cached) catalogCache.set('catalog:rows', rows);
      const exercises = buildExerciseCatalogEntries(rows);
      return standardSuccess(req, res, 'Exercise catalog entries', { exercises });
    } catch (error) {
      return standardError(req, res, 'Failed to read Exercise_Catalog', error.message, 500);
    }
  });

  // GET /api/catalog/search
  router.get('/api/catalog/search', async (req, res) => {

    const query = String(req.query.q || '').trim();
    if (!query) {
      return standardError(req, res, 'Query param q is required', null, 400);
    }

    try {
      const cached = catalogCache.get('catalog:rows');
      const rows = cached || await getExerciseCatalog();
      if (!cached) catalogCache.set('catalog:rows', rows);
      const exercises = buildExerciseCatalogEntries(rows);
      const lowerQuery = query.toLowerCase();
      const results = exercises.filter(entry => {
        return entry.canonical_name.toLowerCase().includes(lowerQuery)
          || entry.lift_code.toLowerCase().includes(lowerQuery)
          || entry.variants.some(v => v.toLowerCase().includes(lowerQuery));
      });
      return standardSuccess(req, res, 'Catalog search results', { query, results });
    } catch (error) {
      return standardError(req, res, 'Failed to search Exercise_Catalog', error.message, 500);
    }
  });

  // GET /api/sessions/recent — list recent sessions with aggregated data (MUST be before /:sessionId)
  router.get('/api/sessions/recent', async (req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 15));
    try {
      const result = await trainingStore.getRecentSessions({ limit });
      return standardSuccess(req, res, 'Recent sessions', result);
    } catch (err) {
      return standardError(req, res, 'Failed to load recent sessions', err);
    }
  });

  // GET /api/sessions/:sessionId — fetch all log rows for a session (for correction pre-fill)
  router.get('/api/sessions/:sessionId', async (req, res) => {

    const sessionId = String(req.params.sessionId || '').trim();
    if (!sessionId) return standardError(req, res, 'sessionId is required', null, 400);

    try {
      const allLog = await getSheetRows(logSheetName);
      const sessionRows = allLog.filter(row => String(row[1] || '').trim() === sessionId);
      if (!sessionRows.length) {
        return standardError(req, res, `No rows found for session "${sessionId}"`, null, 404);
      }
      const rows = sessionRows.map(row => ({
        date_clean: String(row[0] || ''),
        session_id: String(row[1] || ''),
        exercise: String(row[2] || ''),
        canonical_exercise: String(row[3] || ''),
        muscle_group: String(row[4] || ''),
        lift_code: String(row[5] || ''),
        set_number: String(row[6] || ''),
        weight: String(row[7] || ''),
        reps: String(row[8] || ''),
        rir: String(row[9] || ''),
        notes: String(row[10] || '')
      }));
      return standardSuccess(req, res, 'Session rows', {
        session_id: sessionId,
        date: rows[0]?.date_clean || '',
        set_count: rows.length,
        rows
      });
    } catch (error) {
      return standardError(req, res, 'Failed to fetch session', error.message, 500);
    }
  });

  // GET /api/summary/weekly
  router.get('/api/summary/weekly', async (req, res) => {

    try {
      const recentLog = await getRecentRows(logSheetName, 1000);
      const recentEffort = await getRecentRows(effortSheetName, 1000);
      const today = new Date();
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(today.getDate() - 6);
      const isoSevenDaysAgo = sevenDaysAgo.toISOString().slice(0, 10);

      const sessions = new Map();
      let totalSets = 0;
      let totalVolume = 0;
      const muscleGroupBreakdown = {};

      const logRows = recentLog
        .filter(row => {
          const date = String(row[0] || '');
          return date >= isoSevenDaysAgo;
        })
        .filter(row => Number(row[7]) > 0);

      logRows.forEach(row => {
        totalSets += 1;
        const weight = Number(row[7]);
        const reps = Number(row[8]);
        const volume = Number.isFinite(weight) && Number.isFinite(reps) ? weight * reps : 0;
        totalVolume += volume;
        const muscleGroup = String(row[4] || 'Unknown');
        muscleGroupBreakdown[muscleGroup] = (muscleGroupBreakdown[muscleGroup] || 0) + volume;

        const sessionId = String(row[1] || '').trim();
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, { session_id: sessionId, date: row[0], sets: 0, volume: 0 });
        }
        const session = sessions.get(sessionId);
        session.sets += 1;
        session.volume += volume;
      });

      const effortSummary = recentEffort
        .filter(row => {
          const date = String(row[0] || '');
          return date >= isoSevenDaysAgo;
        })
        .map(row => ({
          date: row[0],
          session_id: row[1],
          duration: row[2],
          active_calories: row[3],
          total_calories: row[4],
          average_hr: row[5],
          peak_hr: row[6],
          location: row[7],
          notes: row[8]
        }));

      const highlights = [];
      if (totalSets > 0) {
        highlights.push(`Completed ${totalSets} working sets across ${sessions.size} sessions.`);
      }
      if (totalVolume > 0) {
        highlights.push(`Accumulated ${Math.round(totalVolume)} total volume this week.`);
      }
      const topMuscleGroup = Object.entries(muscleGroupBreakdown).sort((a, b) => b[1] - a[1])[0];
      if (topMuscleGroup) {
        highlights.push(`Top muscle group: ${topMuscleGroup[0]} with ${Math.round(topMuscleGroup[1])} volume.`);
      }

      return standardSuccess(req, res, 'Weekly summary', {
        sessions: Array.from(sessions.values()),
        totalSets,
        totalVolume,
        muscleGroupBreakdown,
        effortSummary,
        highlights
      });
    } catch (error) {
      return standardError(req, res, 'Failed to build weekly summary', error.message, 500);
    }
  });

  // GET /api/progress/summary
  router.get('/api/progress/summary', async (req, res) => {
    try {
      const summary = await trainingStore.getProgressSummary();
      return standardSuccess(req, res, 'Progress summary', summary);
    } catch (error) {
      return standardError(req, res, 'Failed to build progress summary', error.message, 500);
    }
  });

  // GET /api/report/weekly
  // Returns a structured weekly training report using existing log data.
  // Uses the prior period of equal length for PR/improvement comparisons.
  // Optional ?days=N overrides the default 7-day lookback (range: 3–14).
  router.get('/api/report/weekly', async (req, res) => {
    const rawDays = parseInt(req.query.days || '7', 10);
    if (Number.isNaN(rawDays) || rawDays < 3 || rawDays > 14) {
      return standardError(req, res, 'days must be an integer between 3 and 14', null, 400);
    }
    try {
      const report = await trainingStore.getWeeklyReportData({ days: rawDays, rowLimit: 1000 });
      return standardSuccess(req, res, 'Weekly report', report);
    } catch (error) {
      return standardError(req, res, 'Failed to build weekly report', error.message, 500);
    }
  });

  // GET /api/prs/recent
  router.get('/api/prs/recent', async (req, res) => {

    try {
      const allLog = await getSheetRows(logSheetName);
      const prs = detectRecentPrs(allLog);
      return standardSuccess(req, res, 'Recent PRs', { prs });
    } catch (error) {
      return standardError(req, res, 'Failed to fetch recent PRs', error.message, 500);
    }
  });

  // GET /api/stalls
  router.get('/api/stalls', async (req, res) => {
    const minSessions = parseInt(req.query.minSessions || '3', 10);
    if (Number.isNaN(minSessions) || minSessions < 2) {
      return standardError(req, res, 'minSessions must be an integer >= 2', null, 400);
    }

    try {
      const allLog = await getSheetRows(logSheetName);
      const stalls = detectStalls(allLog, minSessions);
      return standardSuccess(req, res, 'Stall detection', { stalls, minSessions });
    } catch (error) {
      return standardError(req, res, 'Failed to detect stalls', error.message, 500);
    }
  });

  return router;
};
