'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  selectPeriodizationModel,
  buildBlockPhases,
  getDupSessionTypes,
  isPeakingAppropriate,
  buildPeakingPhase,
  _resetForTesting,
} = require('../services/periodizationModule');

before(() => _resetForTesting());

const TM = Object.freeze({ SQUAT: 225, BENCH: 155, DEADLIFT: 275, OHP: 115 });

// --- selectPeriodizationModel null/invalid guards ---

describe('selectPeriodizationModel — null/invalid guards', () => {
  it('returns null for null goalId', () => assert.strictEqual(selectPeriodizationModel(null, 'intermediate'), null));
  it('returns null for empty goalId', () => assert.strictEqual(selectPeriodizationModel('', 'intermediate'), null));
  it('returns null for null trainingLevel', () => assert.strictEqual(selectPeriodizationModel('powerlifting', null), null));
  it('returns null for unknown trainingLevel', () => assert.strictEqual(selectPeriodizationModel('powerlifting', 'elite'), null));
  it('returns null for unknown goalId', () => assert.strictEqual(selectPeriodizationModel('underwater-basket-weaving', 'intermediate'), null));
  it('returns null for beginner (LP handled by starterProgramModule)', () =>
    assert.strictEqual(selectPeriodizationModel('powerlifting', 'beginner'), null));
  it('returns null for bodybuilding beginner', () =>
    assert.strictEqual(selectPeriodizationModel('bodybuilding', 'beginner'), null));
});

// --- selectPeriodizationModel model assignment ---

describe('selectPeriodizationModel — model assignment', () => {
  it('powerlifting intermediate → 531_wave', () => {
    const r = selectPeriodizationModel('powerlifting', 'intermediate');
    assert.ok(r);
    assert.strictEqual(r.modelId, '531_wave');
    assert.strictEqual(r.goalId, 'powerlifting');
    assert.strictEqual(r.trainingLevel, 'intermediate');
  });

  it('powerlifting advanced → block-intermediate', () => {
    const r = selectPeriodizationModel('powerlifting', 'advanced');
    assert.ok(r);
    assert.strictEqual(r.modelId, 'block-intermediate');
  });

  it('general-fitness intermediate → 531_wave', () => {
    const r = selectPeriodizationModel('general-fitness', 'intermediate');
    assert.ok(r);
    assert.strictEqual(r.modelId, '531_wave');
  });

  it('general-fitness advanced → dup-patterns', () => {
    const r = selectPeriodizationModel('general-fitness', 'advanced');
    assert.ok(r);
    assert.strictEqual(r.modelId, 'dup-patterns');
  });

  it('bodybuilding intermediate → dup-patterns', () => {
    const r = selectPeriodizationModel('bodybuilding', 'intermediate');
    assert.ok(r);
    assert.strictEqual(r.modelId, 'dup-patterns');
  });

  it('bodybuilding advanced → dup-patterns', () => {
    const r = selectPeriodizationModel('bodybuilding', 'advanced');
    assert.ok(r);
    assert.strictEqual(r.modelId, 'dup-patterns');
  });

  it('weight-loss intermediate → dup-patterns', () => {
    const r = selectPeriodizationModel('weight-loss', 'intermediate');
    assert.ok(r);
    assert.strictEqual(r.modelId, 'dup-patterns');
  });

  it('result always includes notes string', () => {
    for (const [g, l] of [['powerlifting','intermediate'], ['powerlifting','advanced'], ['bodybuilding','intermediate']]) {
      const r = selectPeriodizationModel(g, l);
      assert.ok(r && typeof r.notes === 'string' && r.notes.length > 0, `${g}/${l}: missing notes`);
    }
  });
});

// --- buildBlockPhases null/invalid guards ---

describe('buildBlockPhases — null/invalid guards', () => {
  it('returns null for null', () => assert.strictEqual(buildBlockPhases(null), null));
  it('returns null for empty string', () => assert.strictEqual(buildBlockPhases(''), null));
  it('returns null for unknown model', () => assert.strictEqual(buildBlockPhases('dup-patterns'), null));
  it('returns null for 531_wave (handled elsewhere)', () => assert.strictEqual(buildBlockPhases('531_wave'), null));
});

// --- buildBlockPhases structure ---

describe('buildBlockPhases — block-intermediate structure', () => {
  let r;
  before(() => { r = buildBlockPhases('block-intermediate'); });

  it('returns a result', () => assert.ok(r));
  it('modelId is block-intermediate', () => assert.strictEqual(r.modelId, 'block-intermediate'));
  it('totalWeeks is 8', () => assert.strictEqual(r.totalWeeks, 8));
  it('has 3 phases', () => assert.strictEqual(r.phases.length, 3));

  it('phase 1 is accumulation, 4 weeks', () => {
    assert.strictEqual(r.phases[0].name, 'accumulation');
    assert.strictEqual(r.phases[0].weeks, 4);
  });
  it('phase 2 is intensification, 3 weeks', () => {
    assert.strictEqual(r.phases[1].name, 'intensification');
    assert.strictEqual(r.phases[1].weeks, 3);
  });
  it('phase 3 is realization, 1 week', () => {
    assert.strictEqual(r.phases[2].name, 'realization');
    assert.strictEqual(r.phases[2].weeks, 1);
  });

  it('phase weeks sum to totalWeeks', () => {
    const sum = r.phases.reduce((acc, p) => acc + p.weeks, 0);
    assert.strictEqual(sum, r.totalWeeks);
  });

  it('phases are in ascending intensity order', () => {
    const lo = r.phases.map(p => p.percent_tm_range[0]);
    assert.ok(lo[0] < lo[1] && lo[1] < lo[2], 'lower bounds should increase accumulation → realization');
  });

  it('accumulation has highest volume_factor (1.0)', () => assert.strictEqual(r.phases[0].volume_factor, 1.0));
  it('realization has lowest volume_factor (≤0.5)', () => assert.ok(r.phases[2].volume_factor <= 0.5));

  it('each phase has rep_range, set_range, rpe_target, notes', () => {
    for (const p of r.phases) {
      assert.ok(Array.isArray(p.rep_range) && p.rep_range.length === 2, `${p.name}: rep_range`);
      assert.ok(Array.isArray(p.set_range) && p.set_range.length === 2, `${p.name}: set_range`);
      assert.ok(typeof p.rpe_target === 'number', `${p.name}: rpe_target`);
      assert.ok(typeof p.notes === 'string', `${p.name}: notes`);
    }
  });
});

// --- getDupSessionTypes null/invalid guards ---

describe('getDupSessionTypes — null/invalid guards', () => {
  it('returns null for null', () => assert.strictEqual(getDupSessionTypes(null), null));
  it('returns null for string', () => assert.strictEqual(getDupSessionTypes('3'), null));
  it('returns null for 5 days (no pattern)', () => assert.strictEqual(getDupSessionTypes(5), null));
  it('returns null for 0', () => assert.strictEqual(getDupSessionTypes(0), null));
});

// --- getDupSessionTypes 3-day pattern ---

describe('getDupSessionTypes — 3-day pattern', () => {
  let r;
  before(() => { r = getDupSessionTypes(3); });

  it('returns a result', () => assert.ok(r));
  it('patternId is dup-3day', () => assert.strictEqual(r.patternId, 'dup-3day'));
  it('daysPerWeek is 3', () => assert.strictEqual(r.daysPerWeek, 3));
  it('returns 3 sessions', () => assert.strictEqual(r.sessions.length, 3));
  it('first session is strength', () => assert.strictEqual(r.sessions[0].typeId, 'strength'));
  it('second session is hypertrophy', () => assert.strictEqual(r.sessions[1].typeId, 'hypertrophy'));
  it('third session is power', () => assert.strictEqual(r.sessions[2].typeId, 'power'));

  it('each session has label, rep_range, percent_tm_range, rpe_target', () => {
    for (const s of r.sessions) {
      assert.ok(typeof s.label === 'string', `${s.typeId}: label`);
      assert.ok(Array.isArray(s.rep_range) && s.rep_range.length === 2, `${s.typeId}: rep_range`);
      assert.ok(Array.isArray(s.percent_tm_range) && s.percent_tm_range.length === 2, `${s.typeId}: percent_tm_range`);
      assert.ok(typeof s.rpe_target === 'number', `${s.typeId}: rpe_target`);
    }
  });

  it('strength has heavier percent_tm than hypertrophy', () => {
    const str = r.sessions.find(s => s.typeId === 'strength');
    const hyo = r.sessions.find(s => s.typeId === 'hypertrophy');
    assert.ok(str.percent_tm_range[0] > hyo.percent_tm_range[0]);
  });
});

// --- getDupSessionTypes 4-day pattern ---

describe('getDupSessionTypes — 4-day pattern', () => {
  let r;
  before(() => { r = getDupSessionTypes(4); });

  it('returns a result', () => assert.ok(r));
  it('patternId is dup-4day', () => assert.strictEqual(r.patternId, 'dup-4day'));
  it('returns 4 sessions', () => assert.strictEqual(r.sessions.length, 4));
  it('includes a hypertrophy session twice', () => {
    const hyoCount = r.sessions.filter(s => s.typeId === 'hypertrophy').length;
    assert.strictEqual(hyoCount, 2);
  });
});

// --- isPeakingAppropriate ---

describe('isPeakingAppropriate', () => {
  it('powerlifting + null population → true', () =>
    assert.strictEqual(isPeakingAppropriate('powerlifting', null), true));
  it('powerlifting + undefined population → true', () =>
    assert.strictEqual(isPeakingAppropriate('powerlifting', undefined), true));
  it('powerlifting + general → true', () =>
    assert.strictEqual(isPeakingAppropriate('powerlifting', 'general'), true));
  it('powerlifting + home-gym → true', () =>
    assert.strictEqual(isPeakingAppropriate('powerlifting', 'home-gym'), true));
  it('powerlifting + busy-parent → true', () =>
    assert.strictEqual(isPeakingAppropriate('powerlifting', 'busy-parent'), true));

  it('powerlifting + youth → false (intensity ceiling)', () =>
    assert.strictEqual(isPeakingAppropriate('powerlifting', 'youth'), false));
  it('powerlifting + older-adult → false (intensity ceiling)', () =>
    assert.strictEqual(isPeakingAppropriate('powerlifting', 'older-adult'), false));

  it('bodybuilding + general → false (wrong goal)', () =>
    assert.strictEqual(isPeakingAppropriate('bodybuilding', 'general'), false));
  it('general-fitness + general → false', () =>
    assert.strictEqual(isPeakingAppropriate('general-fitness', 'general'), false));
  it('weight-loss + general → false', () =>
    assert.strictEqual(isPeakingAppropriate('weight-loss', null), false));
  it('null goalId → false', () =>
    assert.strictEqual(isPeakingAppropriate(null, 'general'), false));
});

// --- buildPeakingPhase null/invalid guards ---

describe('buildPeakingPhase — null/invalid guards', () => {
  it('returns null for null params', () => assert.strictEqual(buildPeakingPhase(null), null));
  it('returns null for non-object params', () => assert.strictEqual(buildPeakingPhase('x'), null));
  it('returns null when trainingMaxes missing', () =>
    assert.strictEqual(buildPeakingPhase({ goalId: 'powerlifting' }), null));
  it('returns null for inappropriate goal (bodybuilding)', () =>
    assert.strictEqual(buildPeakingPhase({ trainingMaxes: TM, goalId: 'bodybuilding' }), null));
  it('returns null for excluded population (youth)', () =>
    assert.strictEqual(buildPeakingPhase({ trainingMaxes: TM, goalId: 'powerlifting', populationId: 'youth' }), null));
  it('returns null for excluded population (older-adult)', () =>
    assert.strictEqual(buildPeakingPhase({ trainingMaxes: TM, goalId: 'powerlifting', populationId: 'older-adult' }), null));
});

// --- buildPeakingPhase structure ---

describe('buildPeakingPhase — structure (powerlifting + general)', () => {
  let r;
  before(() => { r = buildPeakingPhase({ trainingMaxes: TM, goalId: 'powerlifting', populationId: 'general' }); });

  it('returns a result', () => assert.ok(r));
  it('modelId is peaking', () => assert.strictEqual(r.modelId, 'peaking'));
  it('taperWeeks is 2', () => assert.strictEqual(r.taperWeeks, 2));
  it('has 2 phases', () => assert.strictEqual(r.phases.length, 2));
  it('eligibleGoal is powerlifting', () => assert.strictEqual(r.eligibleGoal, 'powerlifting'));
  it('population is general', () => assert.strictEqual(r.population, 'general'));

  it('phase 1 is volume_taper (week 2 out)', () => {
    assert.strictEqual(r.phases[0].name, 'volume_taper');
    assert.strictEqual(r.phases[0].weekFromCompetition, 2);
  });
  it('phase 2 is intensity_taper (week 1 out)', () => {
    assert.strictEqual(r.phases[1].name, 'intensity_taper');
    assert.strictEqual(r.phases[1].weekFromCompetition, 1);
  });

  it('volume_taper keeps 60% of volume', () => assert.strictEqual(r.phases[0].volumeFactor, 0.60));
  it('intensity_taper keeps 40% of volume', () => assert.strictEqual(r.phases[1].volumeFactor, 0.40));
  it('intensity_taper has ceiling at 97% TM', () => assert.strictEqual(r.phases[1].intensityCeilingFactor, 0.97));

  it('prescriptions include all 4 lifts', () => {
    for (const phase of r.phases) {
      for (const code of ['SQUAT', 'BENCH', 'DEADLIFT', 'OHP']) {
        assert.ok(phase.prescriptions[code], `${phase.name}: missing ${code}`);
      }
    }
  });

  it('intensity_taper SQUAT targetIntensityMax = round5(225 × 0.97) = 220', () => {
    // 225 × 0.97 = 218.25 → round5 = 220
    assert.strictEqual(r.phases[1].prescriptions.SQUAT.targetIntensityMax, 220);
  });

  it('volume_taper SQUAT targetIntensityMax = 225 (no ceiling)', () => {
    // intensity_ceiling_factor 1.0 → 225 × 1.0 = 225 → round5 = 225
    assert.strictEqual(r.phases[0].prescriptions.SQUAT.targetIntensityMax, 225);
  });

  it('prescription volumeFactor matches phase volumeFactor', () => {
    for (const phase of r.phases) {
      for (const pres of Object.values(phase.prescriptions)) {
        assert.strictEqual(pres.volumeFactor, phase.volumeFactor);
      }
    }
  });
});

// --- buildPeakingPhase with null population (no pop restriction) ---

describe('buildPeakingPhase — null population (no pop restriction)', () => {
  it('returns result when populationId is omitted', () => {
    const r = buildPeakingPhase({ trainingMaxes: TM, goalId: 'powerlifting' });
    assert.ok(r);
    assert.strictEqual(r.population, null);
  });
});

// --- buildPeakingPhase skips non-finite TMs ---

describe('buildPeakingPhase — non-finite TM values', () => {
  it('skips Infinity TM and includes only finite lifts', () => {
    const r = buildPeakingPhase({
      trainingMaxes: { SQUAT: 225, BENCH: Infinity },
      goalId: 'powerlifting',
    });
    assert.ok(r);
    assert.ok(r.phases[0].prescriptions.SQUAT);
    assert.strictEqual(r.phases[0].prescriptions.BENCH, undefined);
  });
});
