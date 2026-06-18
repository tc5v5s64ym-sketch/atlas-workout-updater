'use strict';

// Golden fixtures for services/substitutionRecommender.js
// Pure data — no I/O, no Sheets, no LLM.
//
// Verifies that recommendSubstitute returns the correct exercise for
// well-known prescribed lifts and null when no substitute is available.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { recommendSubstitute, SUBSTITUTE_CATALOG } = require('../services/substitutionRecommender');

// ─── required scenarios (PR 343) ──────────────────────────────────────────────

describe('recommendSubstitute — required scenarios', () => {
  it('1. Deadlift constraint → RDL recommendation', () => {
    const r = recommendSubstitute('Deadlift');
    assert.ok(r, 'recommendation must not be null');
    assert.strictEqual(r.recommendation, 'Romanian Deadlift');
  });

  it('2. Squat constraint → Leg Press recommendation', () => {
    const r = recommendSubstitute('Back Squat');
    assert.ok(r, 'recommendation must not be null');
    assert.strictEqual(r.recommendation, 'Leg Press');
  });

  it('3. Unknown constraint → no recommendation', () => {
    // "Jammer Press" is not in the catalog.
    const r = recommendSubstitute('Jammer Press');
    assert.strictEqual(r, null);
  });

  it('4. Existing substitution quality logic unchanged', () => {
    const { scoreSubstitutionQuality } = require('../services/substitutionQuality');
    const score = scoreSubstitutionQuality('Deadlift', 'Romanian Deadlift');
    assert.strictEqual(score.quality, 'excellent');
  });
});

// ─── result shape ─────────────────────────────────────────────────────────────

describe('recommendSubstitute — result shape', () => {
  it('result has recommendation, quality, reason fields', () => {
    const r = recommendSubstitute('Deadlift');
    assert.ok(r);
    assert.ok('recommendation' in r, 'recommendation missing');
    assert.ok('quality'        in r, 'quality missing');
    assert.ok('reason'         in r, 'reason missing');
  });

  it('quality is excellent or acceptable — never poor or unknown', () => {
    const exercises = Object.keys(SUBSTITUTE_CATALOG).map(k => {
      // Use the original-case key to reconstruct — just capitalize first letter
      return k.charAt(0).toUpperCase() + k.slice(1);
    });
    for (const ex of exercises) {
      const r = recommendSubstitute(ex);
      if (r) {
        assert.ok(
          r.quality === 'excellent' || r.quality === 'acceptable',
          `${ex} returned quality=${r.quality} — only excellent/acceptable allowed`
        );
      }
    }
  });

  it('reason is a non-empty string', () => {
    const r = recommendSubstitute('Bench Press');
    assert.ok(r);
    assert.strictEqual(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
  });
});

// ─── quality tier selection ───────────────────────────────────────────────────

describe('recommendSubstitute — quality tier selection', () => {
  it('prefers excellent over acceptable when available (Deadlift → RDL)', () => {
    // Catalog: [RDL (excellent), Good Morning (excellent)]
    const r = recommendSubstitute('Deadlift');
    assert.ok(r);
    assert.strictEqual(r.quality, 'excellent');
    assert.strictEqual(r.recommendation, 'Romanian Deadlift');
  });

  it('returns acceptable when no excellent candidate (Back Squat → Leg Press)', () => {
    const r = recommendSubstitute('Back Squat');
    assert.ok(r);
    assert.strictEqual(r.quality, 'acceptable');
  });

  it('Bench Press → Incline Press (excellent, same horizontal_push pattern)', () => {
    const r = recommendSubstitute('Bench Press');
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Incline Press');
    assert.strictEqual(r.quality, 'excellent');
  });

  it('Lat Pulldown → Pull-up (excellent, same vertical_pull pattern)', () => {
    const r = recommendSubstitute('Lat Pulldown');
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Pull-up');
    assert.strictEqual(r.quality, 'excellent');
  });

  it('Overhead Press → Bench Press (acceptable, same push region, different pattern)', () => {
    const r = recommendSubstitute('Overhead Press');
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Bench Press');
    assert.strictEqual(r.quality, 'acceptable');
  });
});

// ─── reason strings ───────────────────────────────────────────────────────────

describe('recommendSubstitute — reason strings', () => {
  it('same_pattern_same_cost reason mentions the movement pattern', () => {
    // Deadlift → RDL: same hinge pattern
    const r = recommendSubstitute('Deadlift');
    assert.ok(r);
    assert.ok(r.reason.includes('hip hinge'), `reason should mention 'hip hinge': ${r.reason}`);
  });

  it('same_pattern_lighter_compound reason mentions preserving the pattern', () => {
    // Back Squat → Leg Press: same squat pattern, lighter compound
    const r = recommendSubstitute('Back Squat');
    assert.ok(r);
    assert.ok(r.reason.toLowerCase().includes('squat'), `reason should mention 'squat': ${r.reason}`);
  });

  it('same_region_different_pattern reason mentions the substitute pattern', () => {
    // OHP (vertical_push) → Bench Press (horizontal_push): same push region
    const r = recommendSubstitute('Overhead Press');
    assert.ok(r);
    assert.ok(
      r.reason.includes('horizontal push'),
      `reason should mention 'horizontal push': ${r.reason}`
    );
  });
});

// ─── case-insensitive lookup ──────────────────────────────────────────────────

describe('recommendSubstitute — case-insensitive lookup', () => {
  it('lowercase input works', () => {
    const r = recommendSubstitute('deadlift');
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Romanian Deadlift');
  });

  it('uppercase input works', () => {
    const r = recommendSubstitute('DEADLIFT');
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Romanian Deadlift');
  });
});

// ─── object input ─────────────────────────────────────────────────────────────

describe('recommendSubstitute — object input', () => {
  it('accepts {name} object', () => {
    const r = recommendSubstitute({ name: 'Deadlift' });
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Romanian Deadlift');
  });

  it('accepts {name} object for Back Squat', () => {
    const r = recommendSubstitute({ name: 'Back Squat' });
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Leg Press');
  });
});

// ─── catalog coverage ─────────────────────────────────────────────────────────

describe('recommendSubstitute — catalog coverage', () => {
  it('"Squat" (without Back) also maps to Leg Press', () => {
    const r = recommendSubstitute('Squat');
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Leg Press');
  });

  it('Romanian Deadlift → Deadlift (first excellent candidate)', () => {
    const r = recommendSubstitute('Romanian Deadlift');
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Deadlift');
    assert.strictEqual(r.quality, 'excellent');
  });

  it('Barbell Row → Seated Row (acceptable, lighter compound)', () => {
    const r = recommendSubstitute('Barbell Row');
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Seated Row');
    assert.strictEqual(r.quality, 'acceptable');
  });
});

// ─── defensive inputs ─────────────────────────────────────────────────────────

describe('recommendSubstitute — defensive inputs', () => {
  it('null → null', () => {
    assert.strictEqual(recommendSubstitute(null), null);
  });

  it('empty string → null', () => {
    assert.strictEqual(recommendSubstitute(''), null);
  });

  it('object with empty name → null', () => {
    assert.strictEqual(recommendSubstitute({ name: '' }), null);
  });

  it('exercise not in catalog → null', () => {
    assert.strictEqual(recommendSubstitute('Jammer Press'), null);
    assert.strictEqual(recommendSubstitute('Landmine Rotation'), null);
    assert.strictEqual(recommendSubstitute('Bicep Curl'), null);
  });
});

// ─── existing infrastructure untouched ───────────────────────────────────────

describe('recommendSubstitute — existing infrastructure untouched', () => {
  it('classifySubstitution still importable and functional', () => {
    const { classifySubstitution } = require('../services/substitutionIntent');
    const result = classifySubstitution({
      prescribed: { name: 'Deadlift' },
      logged:     { name: 'Romanian Deadlift' },
      history:    [{}],
    });
    assert.strictEqual(result.classification, 'preserved');
  });

  it('inferPrescribedPairs still importable and functional', () => {
    const { inferPrescribedPairs } = require('../services/planMatcher');
    const pairs = inferPrescribedPairs(
      [{ name: 'Deadlift' }],
      [{ name: 'Romanian Deadlift' }]
    );
    assert.strictEqual(pairs.length, 1);
  });

  it('scoreSubstitutionQuality still importable and functional', () => {
    const { scoreSubstitutionQuality } = require('../services/substitutionQuality');
    const r = scoreSubstitutionQuality('Deadlift', 'Romanian Deadlift');
    assert.strictEqual(r.quality, 'excellent');
  });
});
