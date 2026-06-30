'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  getPopulationCaps,
  listPopulations,
  applyPopulationCaps,
  _resetForTesting,
} = require('../services/populationCapsModule');

before(() => _resetForTesting());

// --- null guards ---

describe('getPopulationCaps — null guards', () => {
  it('returns null for null', () => assert.strictEqual(getPopulationCaps(null), null));
  it('returns null for empty string', () => assert.strictEqual(getPopulationCaps(''), null));
  it('returns null for unknown id', () => assert.strictEqual(getPopulationCaps('alien-cyborg'), null));
  it('returns null for numeric id', () => assert.strictEqual(getPopulationCaps(99), null));
});

// --- known populations ---

describe('getPopulationCaps — known populations', () => {
  it('returns general caps (all nulls)', () => {
    const p = getPopulationCaps('general');
    assert.ok(p);
    assert.strictEqual(p.id, 'general');
    assert.strictEqual(p.constraints.max_days_per_week, null);
    assert.strictEqual(p.constraints.rir_floor, null);
  });

  it('returns older-adult caps', () => {
    const p = getPopulationCaps('older-adult');
    assert.ok(p);
    assert.strictEqual(p.constraints.max_days_per_week, 4);
    assert.strictEqual(p.constraints.rir_floor, 2);
    assert.strictEqual(p.constraints.intensity_ceiling_percent_1rm, 85);
  });

  it('returns youth caps', () => {
    const p = getPopulationCaps('youth');
    assert.ok(p);
    assert.strictEqual(p.constraints.max_days_per_week, 4);
    assert.strictEqual(p.constraints.rir_floor, 2);
    assert.strictEqual(p.constraints.intensity_ceiling_percent_1rm, 80);
  });

  it('returns busy-parent caps', () => {
    const p = getPopulationCaps('busy-parent');
    assert.ok(p);
    assert.strictEqual(p.constraints.max_days_per_week, 3);
    assert.strictEqual(p.constraints.max_session_duration_min, 45);
  });

  it('returns home-gym caps with preferred_equipment array', () => {
    const p = getPopulationCaps('home-gym');
    assert.ok(p);
    assert.ok(Array.isArray(p.constraints.preferred_equipment));
    assert.ok(p.constraints.preferred_equipment.includes('dumbbell'));
  });

  it('all populations have required shape fields', () => {
    for (const id of ['general', 'older-adult', 'youth', 'busy-parent', 'home-gym']) {
      const p = getPopulationCaps(id);
      assert.ok(p.id,          `${id}: missing id`);
      assert.ok(p.name,        `${id}: missing name`);
      assert.ok(p.description, `${id}: missing description`);
      assert.ok(p.constraints, `${id}: missing constraints`);
    }
  });
});

// --- listPopulations ---

describe('listPopulations', () => {
  it('returns at least 5 entries', () => {
    const list = listPopulations();
    assert.ok(list.length >= 5, `expected ≥5 populations, got ${list.length}`);
  });

  it('each entry has id, name, description', () => {
    for (const entry of listPopulations()) {
      assert.ok(entry.id);
      assert.ok(entry.name);
      assert.ok(entry.description);
      assert.strictEqual(entry.constraints, undefined, 'constraints should not appear in summary');
    }
  });

  it('includes all five expected population ids', () => {
    const ids = listPopulations().map(p => p.id);
    for (const id of ['general', 'older-adult', 'youth', 'busy-parent', 'home-gym']) {
      assert.ok(ids.includes(id), `missing population id: ${id}`);
    }
  });
});

// --- applyPopulationCaps ---

describe('applyPopulationCaps — null/invalid guards', () => {
  it('returns null for null params', () => assert.strictEqual(applyPopulationCaps(null, 'general'), null));
  it('returns null for non-object params', () => assert.strictEqual(applyPopulationCaps('string', 'general'), null));
  it('returns unmodified copy for unknown population', () => {
    const params = { days_per_week: 5 };
    const out    = applyPopulationCaps(params, 'unknown-pop');
    assert.deepStrictEqual(out, params);
    assert.notStrictEqual(out, params, 'should return a copy, not the same object');
  });
});

describe('applyPopulationCaps — general (no caps)', () => {
  it('passes params through unchanged', () => {
    const params = { days_per_week: 6, session_duration_min: 90, target_rir: 0 };
    const out    = applyPopulationCaps(params, 'general');
    assert.deepStrictEqual(out, params);
  });
});

describe('applyPopulationCaps — older-adult', () => {
  it('caps days_per_week at 4', () => {
    const out = applyPopulationCaps({ days_per_week: 6 }, 'older-adult');
    assert.strictEqual(out.days_per_week, 4);
  });

  it('does not lower days_per_week if already within cap', () => {
    const out = applyPopulationCaps({ days_per_week: 3 }, 'older-adult');
    assert.strictEqual(out.days_per_week, 3);
  });

  it('caps session_duration_min at 60', () => {
    const out = applyPopulationCaps({ session_duration_min: 90 }, 'older-adult');
    assert.strictEqual(out.session_duration_min, 60);
  });

  it('raises target_rir to floor of 2', () => {
    const out = applyPopulationCaps({ target_rir: 0 }, 'older-adult');
    assert.strictEqual(out.target_rir, 2);
  });

  it('does not lower target_rir if already above floor', () => {
    const out = applyPopulationCaps({ target_rir: 3 }, 'older-adult');
    assert.strictEqual(out.target_rir, 3);
  });

  it('caps intensity_percent_1rm at 85', () => {
    const out = applyPopulationCaps({ intensity_percent_1rm: 95 }, 'older-adult');
    assert.strictEqual(out.intensity_percent_1rm, 85);
  });
});

describe('applyPopulationCaps — busy-parent', () => {
  it('caps days_per_week at 3', () => {
    const out = applyPopulationCaps({ days_per_week: 5 }, 'busy-parent');
    assert.strictEqual(out.days_per_week, 3);
  });

  it('caps session_duration_min at 45', () => {
    const out = applyPopulationCaps({ session_duration_min: 60 }, 'busy-parent');
    assert.strictEqual(out.session_duration_min, 45);
  });

  it('does not cap target_rir (no rir_floor for busy-parent)', () => {
    const out = applyPopulationCaps({ target_rir: 0 }, 'busy-parent');
    assert.strictEqual(out.target_rir, 0);
  });
});

describe('applyPopulationCaps — youth', () => {
  it('caps intensity_ceiling at 80', () => {
    const out = applyPopulationCaps({ intensity_percent_1rm: 90 }, 'youth');
    assert.strictEqual(out.intensity_percent_1rm, 80);
  });
});

describe('applyPopulationCaps — null fields in params pass through unmodified', () => {
  it('null days_per_week not overwritten by a cap', () => {
    const out = applyPopulationCaps({ days_per_week: null }, 'older-adult');
    assert.strictEqual(out.days_per_week, null);
  });
  it('undefined target_rir not overwritten by a floor', () => {
    const out = applyPopulationCaps({ session_duration_min: 30 }, 'older-adult');
    assert.strictEqual(out.target_rir, undefined);
  });
});
