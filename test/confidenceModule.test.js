'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { scoreConfidence, CAVEAT_KEYS } = require('../services/confidenceModule');

// ─── Shared fixtures ─────────────────────────────────────────────────────────

// Rich liftState — 5 sessions, fresh data (2 days ago).
const LIFT_RICH = {
  e1rm:     { sessionsTracked: 5 },
  staleness: { daysSinceLastSession: 2 },
};

// Sparse liftState — 1 session, stale data.
const LIFT_SPARSE = {
  e1rm:     { sessionsTracked: 1 },
  staleness: { daysSinceLastSession: 20 },
};

// Moderate liftState — 3 sessions, data from 10 days ago.
const LIFT_MODERATE = {
  e1rm:     { sessionsTracked: 3 },
  staleness: { daysSinceLastSession: 10 },
};

// High-confidence readiness result (4 inputs used).
const READINESS_HIGH = {
  score:       85,
  tier:        'high',
  confidence:  'high',
  inputsUsed:  ['sleep', 'soreness', 'stress', 'motivation'],
  inputsAbsent: [],
};

// Medium-confidence readiness result (2 inputs used, 4 absent).
const READINESS_MEDIUM = {
  score:       60,
  tier:        'moderate',
  confidence:  'medium',
  inputsUsed:  ['sleep', 'soreness'],
  inputsAbsent: ['stress', 'motivation', 'recent_load', 'hrv'],
};

// Low-confidence readiness result (1 input, rest absent).
const READINESS_LOW = {
  score:       30,
  tier:        'low',
  confidence:  'low',
  inputsUsed:  ['sleep'],
  inputsAbsent: ['soreness', 'stress', 'motivation', 'recent_load', 'hrv'],
};

// Trend results.
const TREND_IMPROVING_HIGH = { trend: 'improving', confidence: 'high',   sessions_analyzed: 5 };
const TREND_STALLING_MED   = { trend: 'stalling',  confidence: 'medium', sessions_analyzed: 3 };
const TREND_INSUFFICIENT   = { trend: 'insufficient_data', confidence: 'none', sessions_analyzed: 1 };
const TREND_NOISY_NONE     = { trend: 'noisy', confidence: 'none', sessions_analyzed: 2 };

// ─── Guards ──────────────────────────────────────────────────────────────────

test('scoreConfidence: returns null for null params', () => {
  assert.equal(scoreConfidence(null), null);
});

test('scoreConfidence: returns null for non-object params', () => {
  assert.equal(scoreConfidence('bad'), null);
  assert.equal(scoreConfidence(42), null);
});

// ─── Scoring: full data → score=100, tier=high, action=act ──────────────────

test('scoreConfidence: rich data yields score 100 and act', () => {
  // Completeness: 5 sessions(50) + 4 readiness inputs(30) + exerciseKnown(20) = 100
  // Recency: 2 days → 100
  // Consistency: improving * high = 100 * 1.0 = 100
  // SelfReport: high conf (100) * no-penalty = 100
  // Weighted: 100*0.30 + 100*0.25 + 100*0.25 + 100*0.20 = 100
  const r = scoreConfidence({
    liftState:       LIFT_RICH,
    readinessResult: READINESS_HIGH,
    trendResult:     TREND_IMPROVING_HIGH,
    exerciseKnown:   true,
  });
  assert.equal(r.confidenceScore, 100);
  assert.equal(r.tier, 'high');
  assert.equal(r.action, 'act');
  assert.equal(r.safetyInverted, false);
});

// ─── Scoring: no data → score=0, tier=low, action=ask ───────────────────────

test('scoreConfidence: empty params yields score 0 and ask', () => {
  const r = scoreConfidence({});
  assert.equal(r.confidenceScore, 0);
  assert.equal(r.tier, 'low');
  assert.equal(r.action, 'ask');
});

// ─── Scoring: moderate data → moderate tier, act_with_caveat ────────────────

test('scoreConfidence: moderate data yields act_with_caveat', () => {
  // Completeness: 3 sess(30) + 2 inputs(15) + known(20) = 65
  // Recency: 10 days → 60
  // Consistency: stalling(70) * medium(0.7) = 49
  // SelfReport: medium(60) * penalty(0.7, 4 absent > 2 used) = 42
  // Weighted: 65*0.30 + 60*0.25 + 49*0.25 + 42*0.20
  //         = 19.5 + 15 + 12.25 + 8.4 = 55.15 → 55
  const r = scoreConfidence({
    liftState:       LIFT_MODERATE,
    readinessResult: READINESS_MEDIUM,
    trendResult:     TREND_STALLING_MED,
    exerciseKnown:   true,
  });
  assert.equal(r.confidenceScore, 55);
  assert.equal(r.tier, 'moderate');
  assert.equal(r.action, 'act_with_caveat');
});

// ─── Scoring: low data + stale ───────────────────────────────────────────────

test('scoreConfidence: sparse + stale data yields low tier and ask', () => {
  // Completeness: 1 sess(10) + 0 inputs(0) + unknown(0) = 10
  // Recency: 20 days → 40
  // Consistency: insufficient(20) * none(0.3) = 6
  // SelfReport: 0 (no readiness)
  // Weighted: 10*0.30 + 40*0.25 + 6*0.25 + 0 = 3 + 10 + 1.5 = 14.5 → 15
  const r = scoreConfidence({
    liftState:   LIFT_SPARSE,
    trendResult: TREND_INSUFFICIENT,
  });
  assert.ok(r.confidenceScore < 45, `score ${r.confidenceScore} should be below 45`);
  assert.equal(r.tier, 'low');
  assert.equal(r.action, 'ask');
});

// ─── Tier boundary: exactly at thresholds ────────────────────────────────────

test('scoreConfidence: score at TIER_ACT_MIN (75) is high → act', () => {
  // Craft inputs that produce exactly 75.
  // Completeness: 5 sessions(50) + 2 inputs(15) + known(20) = 85
  // Recency: 7 days (≤7) → 80
  // Consistency: improving(100) * medium(0.7) → 70
  // SelfReport: medium(60), inputsAbsent < inputsUsed?
  //   inputsUsed=2, inputsAbsent=4 → penalty → 42
  // Weighted: 85*0.30 + 80*0.25 + 70*0.25 + 42*0.20
  //         = 25.5 + 20 + 17.5 + 8.4 = 71.4 → 71 (moderate)
  // Let's try: consistency with high confidence
  // SelfReport: high conf, 2 inputs used, 0 absent
  //   → READINESS_MEDIUM but with 0 absent
  const readiness = { ...READINESS_MEDIUM, inputsAbsent: [] };
  // Completeness: 5 sess(50) + 2 inputs(15) + known(20) = 85
  // Recency: 7 days → 80
  // Consistency: improving(100) * high(1.0) = 100
  // SelfReport: medium(60) * no penalty = 60
  // Weighted: 85*0.30 + 80*0.25 + 100*0.25 + 60*0.20
  //         = 25.5 + 20 + 25 + 12 = 82.5 → 83 (high)
  const r = scoreConfidence({
    liftState:       LIFT_RICH,
    readinessResult: readiness,
    trendResult:     TREND_IMPROVING_HIGH,
    exerciseKnown:   true,
  });
  assert.equal(r.tier, 'high');
  assert.equal(r.action, 'act');
});

test('scoreConfidence: score just below TIER_ACT_MIN is moderate → act_with_caveat', () => {
  // Use moderate case (score=55) which is between 45 and 75.
  const r = scoreConfidence({
    liftState:       LIFT_MODERATE,
    readinessResult: READINESS_MEDIUM,
    trendResult:     TREND_STALLING_MED,
    exerciseKnown:   true,
  });
  assert.ok(r.confidenceScore >= 45 && r.confidenceScore < 75);
  assert.equal(r.tier, 'moderate');
  assert.equal(r.action, 'act_with_caveat');
});

// ─── Safety inversion ────────────────────────────────────────────────────────

test('scoreConfidence: safety flag + high tier → act_with_caveat, safetyInverted=true', () => {
  const r = scoreConfidence({
    liftState:       LIFT_RICH,
    readinessResult: READINESS_HIGH,
    trendResult:     TREND_IMPROVING_HIGH,
    exerciseKnown:   true,
    safetyFlags:     { active: ['injury_flagged'] },
  });
  assert.equal(r.tier, 'high');
  assert.equal(r.action, 'act_with_caveat');  // downgraded from 'act'
  assert.equal(r.safetyInverted, true);
});

test('scoreConfidence: safety flag + moderate tier → ask, safetyInverted=true', () => {
  const r = scoreConfidence({
    liftState:       LIFT_MODERATE,
    readinessResult: READINESS_MEDIUM,
    trendResult:     TREND_STALLING_MED,
    exerciseKnown:   true,
    safetyFlags:     { active: ['pain_level_high'] },
  });
  assert.equal(r.tier, 'moderate');
  assert.equal(r.action, 'ask');              // downgraded from 'act_with_caveat'
  assert.equal(r.safetyInverted, true);
});

test('scoreConfidence: safety flag + low tier → ask, safetyInverted=false (already ask)', () => {
  const r = scoreConfidence({
    liftState:   LIFT_SPARSE,
    trendResult: TREND_INSUFFICIENT,
    safetyFlags: { active: ['pain_level_high'] },
  });
  assert.equal(r.tier, 'low');
  assert.equal(r.action, 'ask');
  assert.equal(r.safetyInverted, false);
});

test('scoreConfidence: empty safety flags array — no inversion', () => {
  const r = scoreConfidence({
    liftState:       LIFT_RICH,
    readinessResult: READINESS_HIGH,
    trendResult:     TREND_IMPROVING_HIGH,
    exerciseKnown:   true,
    safetyFlags:     { active: [] },
  });
  assert.equal(r.action, 'act');
  assert.equal(r.safetyInverted, false);
});

test('scoreConfidence: null safetyFlags — no inversion', () => {
  const r = scoreConfidence({
    liftState:       LIFT_RICH,
    readinessResult: READINESS_HIGH,
    trendResult:     TREND_IMPROVING_HIGH,
    exerciseKnown:   true,
    safetyFlags:     null,
  });
  assert.equal(r.action, 'act');
  assert.equal(r.safetyInverted, false);
});

// ─── Caveats ─────────────────────────────────────────────────────────────────

test('caveats: INSUFFICIENT_HISTORY when sessionsTracked < 2', () => {
  const r = scoreConfidence({ liftState: { e1rm: { sessionsTracked: 1 }, staleness: { daysSinceLastSession: 3 } } });
  assert.ok(r.caveats.includes(CAVEAT_KEYS.INSUFFICIENT_HISTORY));
});

test('caveats: no INSUFFICIENT_HISTORY when sessionsTracked >= 2', () => {
  const r = scoreConfidence({ liftState: { e1rm: { sessionsTracked: 2 }, staleness: { daysSinceLastSession: 3 } } });
  assert.ok(!r.caveats.includes(CAVEAT_KEYS.INSUFFICIENT_HISTORY));
});

test('caveats: STALE_DATA when daysSinceLastSession > 14', () => {
  const r = scoreConfidence({ liftState: { e1rm: { sessionsTracked: 3 }, staleness: { daysSinceLastSession: 15 } } });
  assert.ok(r.caveats.includes(CAVEAT_KEYS.STALE_DATA));
});

test('caveats: no STALE_DATA when daysSinceLastSession <= 14', () => {
  const r = scoreConfidence({ liftState: { e1rm: { sessionsTracked: 3 }, staleness: { daysSinceLastSession: 14 } } });
  assert.ok(!r.caveats.includes(CAVEAT_KEYS.STALE_DATA));
});

test('caveats: LOW_TREND_CONFIDENCE when consistency score < 40', () => {
  // noisy trend * none confidence → score < 40
  const r = scoreConfidence({ trendResult: TREND_NOISY_NONE });
  assert.ok(r.caveats.includes(CAVEAT_KEYS.LOW_TREND_CONFIDENCE));
});

test('caveats: no LOW_TREND_CONFIDENCE for stalling + medium (score=49)', () => {
  // stalling(70) * medium(0.7) = 49 >= 40
  const r = scoreConfidence({ trendResult: TREND_STALLING_MED });
  assert.ok(!r.caveats.includes(CAVEAT_KEYS.LOW_TREND_CONFIDENCE));
});

test('caveats: LIMITED_READINESS when inputsUsed < 2', () => {
  const r = scoreConfidence({ readinessResult: READINESS_LOW });  // 1 input
  assert.ok(r.caveats.includes(CAVEAT_KEYS.LIMITED_READINESS));
});

test('caveats: no LIMITED_READINESS when inputsUsed >= 2', () => {
  const r = scoreConfidence({ readinessResult: READINESS_MEDIUM });  // 2 inputs
  assert.ok(!r.caveats.includes(CAVEAT_KEYS.LIMITED_READINESS));
});

test('caveats: EXERCISE_UNRESOLVED when exerciseKnown=false', () => {
  const r = scoreConfidence({ exerciseKnown: false });
  assert.ok(r.caveats.includes(CAVEAT_KEYS.EXERCISE_UNRESOLVED));
});

test('caveats: no EXERCISE_UNRESOLVED when exerciseKnown=true', () => {
  const r = scoreConfidence({ exerciseKnown: true });
  assert.ok(!r.caveats.includes(CAVEAT_KEYS.EXERCISE_UNRESOLVED));
});

test('caveats: no EXERCISE_UNRESOLVED when exerciseKnown not provided (undefined)', () => {
  // undefined = not passed; we don't know → no caveat
  const r = scoreConfidence({});
  assert.ok(!r.caveats.includes(CAVEAT_KEYS.EXERCISE_UNRESOLVED));
});

test('caveats: SAFETY_FLAG included when safetyFlags has active entries', () => {
  const r = scoreConfidence({ safetyFlags: { active: ['pain_level_high'] } });
  assert.ok(r.caveats.includes(CAVEAT_KEYS.SAFETY_FLAG));
});

test('caveats: SAFETY_FLAG absent when no safety flags active', () => {
  const r = scoreConfidence({ safetyFlags: { active: [] } });
  assert.ok(!r.caveats.includes(CAVEAT_KEYS.SAFETY_FLAG));
});

test('caveats: multiple caveats can be present simultaneously', () => {
  // Sparse stale data with unknown exercise and noisy trend → multiple caveats
  const r = scoreConfidence({
    liftState:     { e1rm: { sessionsTracked: 1 }, staleness: { daysSinceLastSession: 20 } },
    trendResult:   TREND_NOISY_NONE,
    exerciseKnown: false,
  });
  assert.ok(r.caveats.includes(CAVEAT_KEYS.INSUFFICIENT_HISTORY));
  assert.ok(r.caveats.includes(CAVEAT_KEYS.STALE_DATA));
  assert.ok(r.caveats.includes(CAVEAT_KEYS.LOW_TREND_CONFIDENCE));
  assert.ok(r.caveats.includes(CAVEAT_KEYS.EXERCISE_UNRESOLVED));
  assert.ok(r.caveats.includes(CAVEAT_KEYS.LIMITED_READINESS));
});

// ─── Dimensions ──────────────────────────────────────────────────────────────

test('result shape: all top-level fields present', () => {
  const r = scoreConfidence({});
  assert.ok('confidenceScore'   in r);
  assert.ok('tier'              in r);
  assert.ok('action'            in r);
  assert.ok('caveats'           in r);
  assert.ok('safetyInverted'    in r);
  assert.ok('dimensions'        in r);
});

test('result shape: all dimension sub-fields present', () => {
  const r = scoreConfidence({});
  const d = r.dimensions;
  assert.ok('completeness'          in d);
  assert.ok('recency'               in d);
  assert.ok('consistency'           in d);
  assert.ok('selfReportReliability' in d);

  // Completeness sub-fields
  assert.ok('score'               in d.completeness);
  assert.ok('sessionsTracked'     in d.completeness);
  assert.ok('readinessInputsUsed' in d.completeness);

  // Recency sub-fields
  assert.ok('score'                in d.recency);
  assert.ok('daysSinceLastSession' in d.recency);

  // Consistency sub-fields
  assert.ok('score'           in d.consistency);
  assert.ok('trend'           in d.consistency);
  assert.ok('trendConfidence' in d.consistency);

  // SelfReportReliability sub-fields
  assert.ok('score'               in d.selfReportReliability);
  assert.ok('readinessConfidence' in d.selfReportReliability);
  assert.ok('inputsUsed'          in d.selfReportReliability);
});

test('dimensions: completeness sessionsTracked matches input', () => {
  const r = scoreConfidence({ liftState: { e1rm: { sessionsTracked: 4 }, staleness: {} } });
  assert.equal(r.dimensions.completeness.sessionsTracked, 4);
});

test('dimensions: recency daysSinceLastSession null when no liftState', () => {
  const r = scoreConfidence({});
  assert.equal(r.dimensions.recency.daysSinceLastSession, null);
});

test('dimensions: recency score 100 for fresh data (2 days)', () => {
  const r = scoreConfidence({ liftState: LIFT_RICH });
  assert.equal(r.dimensions.recency.score, 100);
});

test('dimensions: recency score 0 for very stale data (> 30 days)', () => {
  const r = scoreConfidence({
    liftState: { e1rm: { sessionsTracked: 3 }, staleness: { daysSinceLastSession: 31 } },
  });
  assert.equal(r.dimensions.recency.score, 0);
});

test('dimensions: consistency trend and trendConfidence passed through', () => {
  const r = scoreConfidence({ trendResult: TREND_IMPROVING_HIGH });
  assert.equal(r.dimensions.consistency.trend, 'improving');
  assert.equal(r.dimensions.consistency.trendConfidence, 'high');
});

test('dimensions: consistency null when no trendResult', () => {
  const r = scoreConfidence({});
  assert.equal(r.dimensions.consistency.trend, null);
  assert.equal(r.dimensions.consistency.trendConfidence, null);
  assert.equal(r.dimensions.consistency.score, 0);
});

test('dimensions: selfReport score 0 when no readinessResult', () => {
  const r = scoreConfidence({});
  assert.equal(r.dimensions.selfReportReliability.score, 0);
  assert.equal(r.dimensions.selfReportReliability.readinessConfidence, null);
});

// ─── Trend variants ───────────────────────────────────────────────────────────

test('trend: flat treated same as stalling', () => {
  const rFlat    = scoreConfidence({ trendResult: { trend: 'flat',     confidence: 'high' } });
  const rStall   = scoreConfidence({ trendResult: { trend: 'stalling', confidence: 'high' } });
  assert.equal(rFlat.dimensions.consistency.score, rStall.dimensions.consistency.score);
});

test('trend: declining yields lower consistency than stalling', () => {
  const rDecl  = scoreConfidence({ trendResult: { trend: 'declining', confidence: 'high' } });
  const rStall = scoreConfidence({ trendResult: { trend: 'stalling',  confidence: 'high' } });
  assert.ok(rDecl.dimensions.consistency.score < rStall.dimensions.consistency.score);
});

test('trend: improving yields highest consistency', () => {
  const rImpr  = scoreConfidence({ trendResult: TREND_IMPROVING_HIGH });
  const rDecl  = scoreConfidence({ trendResult: { trend: 'declining', confidence: 'high' } });
  assert.ok(rImpr.dimensions.consistency.score > rDecl.dimensions.consistency.score);
});

// ─── Recency boundary conditions ─────────────────────────────────────────────

test('recency: score 80 for 7-day-old data', () => {
  const r = scoreConfidence({
    liftState: { e1rm: { sessionsTracked: 3 }, staleness: { daysSinceLastSession: 7 } },
  });
  assert.equal(r.dimensions.recency.score, 80);
});

test('recency: score 60 for 14-day-old data (boundary)', () => {
  const r = scoreConfidence({
    liftState: { e1rm: { sessionsTracked: 3 }, staleness: { daysSinceLastSession: 14 } },
  });
  assert.equal(r.dimensions.recency.score, 60);
});

// ─── Completeness: numeric inputsUsed format ─────────────────────────────────

test('completeness: numeric inputsUsed is handled (not just arrays)', () => {
  const readiness = { confidence: 'medium', inputsUsed: 3, inputsAbsent: 3 };
  const r = scoreConfidence({ readinessResult: readiness });
  assert.equal(r.dimensions.completeness.readinessInputsUsed, 3);
});
