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

  // RENAMED 2026-07-31: the catalog knows 'Incline DB Press'; nothing knew the generic
  // 'Incline Press', so Atlas recommended a lift it could not afterwards discuss (the
  // barbell-row defect, live on the DEFAULT Bench Press path). Same movement pattern
  // (horizontal_push) and same quality tier — only the name became real.
  it('Bench Press → Incline DB Press (excellent, same horizontal_push pattern)', () => {
    const r = recommendSubstitute('Bench Press');
    assert.ok(r);
    assert.strictEqual(r.recommendation, 'Incline DB Press');
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

// ─── context-aware substitution (live evidence 2026-07-11) ────────────────────
// Back Squat auto-replaced with Leg Press while the very next slot was Single-Leg
// Seated Leg Press. With the remaining plan supplied via opts.avoid, the recommender
// must skip the redundant Leg Press and pick a valid non-redundant substitute.
describe('recommendSubstitute — context-aware (opts.avoid)', () => {
  it('default (no context) is unchanged: Back Squat → Leg Press', () => {
    assert.strictEqual(recommendSubstitute('Back Squat').recommendation, 'Leg Press');
    assert.strictEqual(recommendSubstitute('Back Squat', {}).recommendation, 'Leg Press');
  });

  it('avoids the next-slot redundancy: Back Squat with Single-Leg Seated Leg Press next → NOT Leg Press', () => {
    const r = recommendSubstitute('Back Squat', { avoid: ['Single-Leg Seated Leg Press', 'Seated Row'] });
    assert.ok(r, 'still returns a valid substitute');
    assert.notStrictEqual(r.recommendation, 'Leg Press', 'the redundant leg-press family is skipped');
    assert.strictEqual(r.recommendation, 'Goblet Squat', 'picks the valid non-redundant squat-pattern sub');
    assert.ok(['excellent', 'acceptable'].includes(r.quality));
  });

  it('avoid that matches nothing leaves the default pick intact', () => {
    assert.strictEqual(recommendSubstitute('Back Squat', { avoid: ['Seated Row', 'Bench Press'] }).recommendation, 'Leg Press');
  });

  it('when EVERY acceptable candidate is redundant, still returns the best (never regresses to a skip)', () => {
    // Deadlift candidates are RDL (excellent) + Good Morning; both hinge-family. Avoid both.
    const r = recommendSubstitute('Deadlift', { avoid: ['Romanian Deadlift', 'Good Morning'] });
    assert.ok(r, 'a valid-but-redundant substitute beats no substitute');
    assert.strictEqual(r.recommendation, 'Romanian Deadlift', 'falls back to the best acceptable candidate');
  });

  it('unknown prescribed → null regardless of context', () => {
    assert.strictEqual(recommendSubstitute('Jammer Press', { avoid: ['Bench Press'] }), null);
  });
});

// ─── quad knee-isolation gap (production 2026-07-11) ──────────────────────────
// "Swap leg extensions out for something else" with Leg Extension the only pending
// slot produced NO substitution: recommendSubstitute('Leg Extension') returned null
// (no catalog entry), so the client's deterministic implicit-substitution path fell
// through to the LLM, which then falsely claimed "Plan updated" while Leg Extension
// remained. Leg Extension (quad knee-isolation) now maps to quad-region squat-pattern
// movements — the honest best, since no same-pattern quad isolation scores excellent.
describe('recommendSubstitute — Leg Extension (quad knee-isolation)', () => {
  const QUAD_SUBS = ['Leg Press', 'Hack Squat', 'Goblet Squat'];

  it('Leg Extension → a valid acceptable substitute (was null → no substitution)', () => {
    const r = recommendSubstitute('Leg Extension');
    assert.ok(r, 'Leg Extension must have a substitute so the swap can be applied');
    assert.equal(r.quality, 'acceptable');
    assert.ok(r.reason && r.reason.length > 0, 'reason is a non-empty string');
    assert.ok(QUAD_SUBS.includes(r.recommendation), `expected a quad squat-pattern sub, got ${r.recommendation}`);
  });

  it('never recommends the hamstring antagonist (Leg Curl is poor, different muscle)', () => {
    // Leg Curl is knee_isolation too but trains the OPPOSITE muscle — the quality
    // scorer grades it 'poor', so it must never surface as a Leg Extension substitute.
    const r = recommendSubstitute('Leg Extension');
    assert.ok(r);
    assert.notEqual(r.recommendation.toLowerCase(), 'leg curl');
  });

  it('context-aware: avoids a redundant next-slot pick and returns the next valid sub', () => {
    const r = recommendSubstitute('Leg Extension', { avoid: ['Leg Press'] });
    assert.ok(r, 'still returns a valid substitute when the first pick is redundant');
    assert.notEqual(r.recommendation, 'Leg Press', 'the redundant pick is skipped');
    assert.ok(QUAD_SUBS.includes(r.recommendation));
  });

  it('case-insensitive + object input reach the same entry', () => {
    assert.ok(recommendSubstitute('leg extension'));
    assert.ok(recommendSubstitute({ name: 'Leg Extension' }));
  });
});
