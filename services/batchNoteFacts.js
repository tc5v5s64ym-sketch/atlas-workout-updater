'use strict';

// Batch Note Facts — pure fold of ONE exercise's logged block into the single
// facts payload (+ verbosity tier) a per-exercise coaching note renders from.
//
// PURE. No I/O, no LLM, no Sheets, no writes, no routes. Given the sets logged
// for one exercise (a "block" — the primary/batch logging cadence) plus the
// engine reads the caller already computed (the recommendation object `rec`),
// it assembles the note facts, runs the per-set effort analysis, picks the top
// working set, and attaches the coachNoteTier verbosity decision. It emits no
// wording and no numbers of its own — the verdicts come from `rec` (the engine
// owns them), the analysis comes from the pure setEffortSignals engine, and the
// tier comes from the pure coachNoteTier classifier. The LLM / template layer
// words this later (docs/COACHING_NOTE_VOICE.md IRON RULE).
//
// PR-2 of the Conversation Prototype v1 build lane
// (docs/ATLAS_CONVERSATION_PROTOTYPE_V1_PLAN.md §3/§4). Deterministic-engine-
// first and intentionally UNWIRED: nothing consumes it yet. The wiring into the
// existing read-only /api/coach/message path is the next slice (plan PR-3), so
// the fold is fixture-locked first. The per-exercise `rec` (which carries
// effort_verdict / progression_verdict, computed by analytics.recommendNextSet
// against real history) is supplied by the caller — keeping this module pure and
// free of the Sheets-backed band computation.
//
// assembleBatchNoteFacts(block, opts) → {
//   exercise, set_count, working_set_count, top_set, facts, analysis, tier
// } | null
//   block: {
//     exerciseName | exercise : string   — resolved/canonical lift name
//     sets: Array<{weight,reps,rir}|[w,r,rir]>  — the block's logged sets, in order
//     muscleGroup? : string              — helps role/pattern classification
//     targetRir?   : number              — prescribed work RIR (defaults to 2)
//   }
//   opts (all optional): {
//     rec?                : the per-exercise recommendation ({ effort_verdict, progression_verdict, confidence, ... })
//     effort_verdict?     : override — else rec.effort_verdict — else null
//     progression_verdict?: override — else rec.progression_verdict — else null
//     recovery_active?    : true on a deliberate deload/recovery session
//     substitution?, injury?, unexpected_excellence?, regression?, confidence?, asked_why?
//                          — passed straight through to coachNoteTier (see its header)
//   }

const { analyzeSetSequence } = require('./setEffortSignals');
const { classifyNoteTier } = require('./coachNoteTier');

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Accept either parser objects {weight, reps, rir} or compact arrays [weight, reps, rir].
function normalizeSet(set) {
  if (Array.isArray(set)) {
    return { weight: toNum(set[0]), reps: toNum(set[1]), rir: toNum(set[2]) };
  }
  if (set && typeof set === 'object') {
    return { weight: toNum(set.weight), reps: toNum(set.reps), rir: toNum(set.rir) };
  }
  return { weight: null, reps: null, rir: null };
}

// The top working set the note anchors on: the heaviest load, and among equal
// loads the hardest (lowest RIR), then the last occurrence. When no set carries
// a numeric load (e.g. a bodyweight block — out of setEffortSignals' weighted
// scope but handled gracefully), fall back to the last logged set.
function pickTopSet(norm) {
  const weighted = norm.filter(s => s.weight !== null);
  if (weighted.length === 0) return norm.length ? norm[norm.length - 1] : null;
  const topWeight = Math.max(...weighted.map(s => s.weight));
  const atTop = norm.filter(s => s.weight === topWeight);
  // hardest first (lowest RIR; a null RIR is treated as least-informative → last)
  return atTop.reduce((best, s) => {
    if (!best) return s;
    const br = best.rir === null ? Infinity : best.rir;
    const sr = s.rir === null ? Infinity : s.rir;
    return sr <= br ? s : best; // <= keeps the LATER set on a tie
  }, null);
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

/**
 * Fold a logged exercise block into the note facts payload + verbosity tier.
 * Returns null when there is no block to read (missing/empty sets).
 *
 * @param {object} block - one exercise's logged sets (see module header).
 * @param {object} [opts] - engine reads + trigger flags (see module header).
 * @returns {object|null}
 */
function assembleBatchNoteFacts(block, opts = {}) {
  if (!block || typeof block !== 'object') return null;
  const sets = Array.isArray(block.sets) ? block.sets : null;
  if (!sets || sets.length === 0) return null;

  const o = opts && typeof opts === 'object' ? opts : {};
  const rec = o.rec && typeof o.rec === 'object' ? o.rec : {};

  const exerciseName = String(block.exerciseName || block.exercise || '');
  const muscleGroup = String(block.muscleGroup || '');
  const targetRir = toNum(block.targetRir);

  const norm = sets.map(normalizeSet);
  const analysis = analyzeSetSequence(sets, {
    exerciseName,
    muscleGroup,
    ...(targetRir !== null ? { targetRir } : {}),
  });
  const topSet = pickTopSet(norm);

  const workingSetCount = analysis
    ? analysis.set_classes.filter(c => c !== 'warmup_feeder').length
    : norm.length;

  // Verdicts are engine-owned: taken from an explicit override or the supplied
  // `rec`. This module never derives its own verdict (no number invented).
  const effort_verdict = firstDefined(o.effort_verdict, rec.effort_verdict);
  const progression_verdict = firstDefined(o.progression_verdict, rec.progression_verdict);

  const facts = {
    effort_verdict,
    progression_verdict,
    effort_signals: analysis,
    injury: firstDefined(o.injury),
    unexpected_excellence: o.unexpected_excellence === true,
    regression: o.regression === true,
    substitution: firstDefined(o.substitution),
    confidence: firstDefined(o.confidence, rec.confidence),
    recovery_active: o.recovery_active === true,
    asked_why: o.asked_why === true,
  };

  const tier = classifyNoteTier(facts);

  return {
    exercise: exerciseName,
    set_count: norm.length,
    working_set_count: workingSetCount,
    top_set: topSet,
    facts,
    analysis,
    tier,
  };
}

module.exports = { assembleBatchNoteFacts };
