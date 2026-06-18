'use strict';

// Golden fixtures for services/constraintDetector.js and the
// isConstraintMessage + recommendSubstitute pipeline.
// Pure data — no I/O, no Sheets, no LLM.
//
// These tests cover the 6 required scenarios for PR 343:
//   1. Deadlift active + platform busy → RDL recommendation.
//   2. Back Squat active + rack unavailable → Leg Press recommendation.
//   3. Unknown current exercise → no recommendation.
//   4. No active plan → no recommendation.
//   5. recommendSubstitute returns only excellent/acceptable.
//   6. Questionable poor/unknown candidates are not recommended.
//
// Visible integration (endpoint + app.js wiring) is deferred to PR 344.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isConstraintMessage }  = require('../services/constraintDetector');
const { recommendSubstitute }  = require('../services/substitutionRecommender');

// ─── required pipeline scenarios ──────────────────────────────────────────────

describe('constraint + recommendation pipeline — required scenarios', () => {
  it('1. Deadlift active + "Platform busy" → Romanian Deadlift recommendation', () => {
    const currentExercise = 'Deadlift';
    const userMessage     = 'Platform busy';
    assert.ok(isConstraintMessage(userMessage), 'message must be detected as constraint');
    const rec = recommendSubstitute(currentExercise);
    assert.ok(rec, 'recommendation must not be null');
    assert.strictEqual(rec.recommendation, 'Romanian Deadlift');
  });

  it('1b. Deadlift active + "Deadlift platform is busy" → Romanian Deadlift', () => {
    assert.ok(isConstraintMessage('Deadlift platform is busy'));
    const rec = recommendSubstitute('Deadlift');
    assert.ok(rec);
    assert.strictEqual(rec.recommendation, 'Romanian Deadlift');
  });

  it('2. Back Squat active + "Rack unavailable" → Leg Press recommendation', () => {
    const currentExercise = 'Back Squat';
    const userMessage     = 'Rack unavailable';
    assert.ok(isConstraintMessage(userMessage), 'message must be detected as constraint');
    const rec = recommendSubstitute(currentExercise);
    assert.ok(rec, 'recommendation must not be null');
    assert.strictEqual(rec.recommendation, 'Leg Press');
  });

  it('2b. Back Squat active + "All racks are taken" → Leg Press', () => {
    assert.ok(isConstraintMessage('All racks are taken'));
    const rec = recommendSubstitute('Back Squat');
    assert.ok(rec);
    assert.strictEqual(rec.recommendation, 'Leg Press');
  });

  it('3. Unknown current exercise → no recommendation', () => {
    // "Jammer Press" is not in the substitution catalog.
    const rec = recommendSubstitute('Jammer Press');
    assert.strictEqual(rec, null, 'unknown exercise must return null');
  });

  it('4. No active plan (null exercise) → no recommendation', () => {
    const rec = recommendSubstitute(null);
    assert.strictEqual(rec, null, 'null exercise must return null');
  });

  it('4b. No active plan (empty string) → no recommendation', () => {
    const rec = recommendSubstitute('');
    assert.strictEqual(rec, null);
  });
});

// ─── constraint detector — detection accuracy ─────────────────────────────────

describe('isConstraintMessage — detection accuracy', () => {
  it('"Platform busy" → true', () => {
    assert.ok(isConstraintMessage('Platform busy'));
  });

  it('"Rack unavailable" → true', () => {
    assert.ok(isConstraintMessage('Rack unavailable'));
  });

  it('"All racks are taken" → true', () => {
    assert.ok(isConstraintMessage('All racks are taken'));
  });

  it('"Deadlift platform is busy" → true', () => {
    assert.ok(isConstraintMessage('Deadlift platform is busy'));
  });

  it('"Barbell is broken" → true', () => {
    assert.ok(isConstraintMessage('Barbell is broken'));
  });

  it('"Machine out of order" → true', () => {
    assert.ok(isConstraintMessage('Machine out of order'));
  });

  it('"Squat rack occupied" → true', () => {
    assert.ok(isConstraintMessage('Squat rack occupied'));
  });

  it('"Gym is closed" → true', () => {
    assert.ok(isConstraintMessage('Gym is closed'));
  });
});

describe('isConstraintMessage — non-constraint messages', () => {
  it('set log input → false', () => {
    assert.ok(!isConstraintMessage('Romanian Deadlift 245 7/2 x3'));
  });

  it('intent message → false', () => {
    assert.ok(!isConstraintMessage('I want to do RDL today'));
  });

  it('empty string → false', () => {
    assert.ok(!isConstraintMessage(''));
  });

  it('null → false', () => {
    assert.ok(!isConstraintMessage(null));
  });

  it('normal question → false', () => {
    assert.ok(!isConstraintMessage('What weight should I use for deadlift?'));
  });

  it('"Full ROM squats 225 5/2" → false (full is not a constraint keyword)', () => {
    assert.ok(!isConstraintMessage('Full ROM squats 225 5/2'));
  });

  it('"Fullbody day" → false', () => {
    assert.ok(!isConstraintMessage('Fullbody day'));
  });

  it('"mistaken" → false (taken requires word boundary, not substring)', () => {
    assert.ok(!isConstraintMessage('mistaken'));
  });

  it('"I closed my grip at the top" → false (closed excluded)', () => {
    assert.ok(!isConstraintMessage('I closed my grip at the top'));
  });
});

// ─── required: quality floor and catalog discipline ───────────────────────────

describe('recommendation quality — required scenarios 5 and 6', () => {
  it('5. recommendSubstitute only returns excellent or acceptable — never poor/unknown', () => {
    const { SUBSTITUTE_CATALOG } = require('../services/substitutionRecommender');
    for (const rawKey of Object.keys(SUBSTITUTE_CATALOG)) {
      const name = rawKey.charAt(0).toUpperCase() + rawKey.slice(1);
      const rec = recommendSubstitute(name);
      if (rec) {
        assert.ok(
          rec.quality === 'excellent' || rec.quality === 'acceptable',
          `${name} → ${rec.recommendation} returned quality=${rec.quality}`
        );
      }
    }
  });

  it('6a. Deadlift catalog does not suggest Leg Press (cross-pattern candidate removed)', () => {
    // Leg Press (squat pattern) is no longer a Deadlift (hinge pattern) candidate.
    // The broad-region fallback exists in the quality scorer but not as a recommendation.
    const rec = recommendSubstitute('Deadlift');
    assert.ok(rec);
    assert.notStrictEqual(rec.recommendation, 'Leg Press',
      'Deadlift must not recommend Leg Press after catalog tightening');
  });

  it('6b. Romanian Deadlift catalog does not suggest Leg Curl (isolation candidate removed)', () => {
    // Leg Curl (knee_isolation/LOW) is no longer an RDL (hinge/HIGH) candidate.
    const rec = recommendSubstitute('Romanian Deadlift');
    assert.ok(rec);
    assert.notStrictEqual(rec.recommendation, 'Leg Curl',
      'Romanian Deadlift must not recommend Leg Curl after catalog tightening');
  });

  it('6c. Overhead Press → Bench Press is acceptable (cross-pattern push, documented)', () => {
    // Retained as the only viable push sub when no same-pattern option exists.
    // Documented as cross-pattern (vertical_push → horizontal_push), not ideal.
    const rec = recommendSubstitute('Overhead Press');
    assert.ok(rec);
    assert.strictEqual(rec.recommendation, 'Bench Press');
    assert.strictEqual(rec.quality, 'acceptable');
    assert.ok(rec.reason.includes('horizontal push'),
      `reason should name the substitute pattern: ${rec.reason}`);
  });
});
