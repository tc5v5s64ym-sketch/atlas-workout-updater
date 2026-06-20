'use strict';

// Golden fixtures for services/layoffGuard.js
// Pure data — no I/O, no Sheets, no LLM.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { assessLayoff } = require('../services/layoffGuard');

// One 12-col Log_Cleaned row on a given date.
function row(date) {
  return [date, 'S1', 'Bench Press', 'Bench Press', 'Chest', 'BP01', '1', '225', '5', '2', ''];
}

describe('assessLayoff — severity tiers', () => {
  it('recent (3 days) → not a layoff, full volume', () => {
    const r = assessLayoff([row('2026-06-17')], { today: '2026-06-20' });
    assert.equal(r.returning_from_layoff, false);
    assert.equal(r.severity, 'none');
    assert.equal(r.volume_factor, 1.0);
    assert.equal(r.days_since_last_session, 3);
    assert.equal(r.watch, null);
  });

  it('6 days → still normal cadence (boundary, not yet a layoff)', () => {
    const r = assessLayoff([row('2026-06-14')], { today: '2026-06-20' });
    assert.equal(r.returning_from_layoff, false);
    assert.equal(r.severity, 'none');
  });

  it('7 days → mild layoff (factor 0.8)', () => {
    const r = assessLayoff([row('2026-06-13')], { today: '2026-06-20' });
    assert.equal(r.returning_from_layoff, true);
    assert.equal(r.severity, 'mild');
    assert.equal(r.volume_factor, 0.8);
    assert.match(r.watch, /ease back/i);
  });

  it('14 days → significant (factor 0.66)', () => {
    const r = assessLayoff([row('2026-06-06')], { today: '2026-06-20' });
    assert.equal(r.severity, 'significant');
    assert.equal(r.volume_factor, 0.66);
  });

  it('30 days → extended / detraining (factor 0.5)', () => {
    const r = assessLayoff([row('2026-05-21')], { today: '2026-06-20' });
    assert.equal(r.severity, 'extended');
    assert.equal(r.volume_factor, 0.5);
  });
});

describe('assessLayoff — latest session wins', () => {
  it('uses the most recent of many sessions', () => {
    const rows = [row('2026-05-01'), row('2026-06-18'), row('2026-05-20')];
    const r = assessLayoff(rows, { today: '2026-06-20' });
    assert.equal(r.days_since_last_session, 2);
    assert.equal(r.returning_from_layoff, false);
  });
});

describe('assessLayoff — input shapes', () => {
  it('accepts {date_clean} objects', () => {
    const r = assessLayoff([{ date_clean: '2026-06-01' }], { today: '2026-06-20' });
    assert.equal(r.days_since_last_session, 19);
    assert.equal(r.severity, 'significant');
  });

  it('accepts {date} objects', () => {
    const r = assessLayoff([{ date: '2026-06-19' }], { today: '2026-06-20' });
    assert.equal(r.days_since_last_session, 1);
  });

  it('empty / no parseable date → no signal, full volume', () => {
    assert.equal(assessLayoff([], { today: '2026-06-20' }).days_since_last_session, null);
    assert.equal(assessLayoff([row('')], { today: '2026-06-20' }).returning_from_layoff, false);
    assert.equal(assessLayoff(null, { today: '2026-06-20' }).volume_factor, 1.0);
  });

  it('future/zero diff clamps to 0', () => {
    const r = assessLayoff([row('2026-06-25')], { today: '2026-06-20' });
    assert.equal(r.days_since_last_session, 0);
  });
});
