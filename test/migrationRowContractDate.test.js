'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalize } = require('../services/migrationRowContract');

const date = (value) => canonicalize('date', value);

test('migration DATE canonicalization preserves modern ISO and driver Date values', () => {
  assert.equal(date('2030-02-03'), '2030-02-03');
  assert.equal(date('2030-2-3'), '2030-02-03');
  assert.equal(date(new Date('2030-02-03T00:00:00.000Z')), '2030-02-03');
});

test('the proven legacy YYYYMMDD-period Effort shape normalizes deterministically', () => {
  assert.equal(date('20300203-AM'), '2030-02-03');
  assert.equal(date('20301109-PM'), '2030-11-09');
  assert.equal(date('20240229-AM'), '2024-02-29', 'a valid leap day survives');
  assert.equal(date('20000229-PM'), '2000-02-29', 'the 400-year leap rule survives');
  assert.equal(date('20300101-AM'), '2030-01-01');
  assert.equal(date('20301231-PM'), '2030-12-31');
});

test('ambiguous, unproven, and impossible date strings remain failures instead of guesses', () => {
  for (const value of [
    '02/03/2030',
    '20300203',
    '20300203-am',
    '20300203-NOON',
    '20301301-AM',
    '20300001-PM',
    '20300431-AM',
    '20230229-PM',
    '19000229-AM',
  ]) {
    assert.equal(date(value), value, `${value} must be preserved for fail-closed rejection`);
  }
});

test('BITE: removing legacy normalization recreates the production-blocking DATE value', () => {
  const legacy = '20300203-PM';
  assert.notEqual(date(legacy), legacy,
    'the migration must not hand the legacy session-stamped string to Postgres DATE');
  assert.match(date(legacy), /^\d{4}-\d{2}-\d{2}$/);
});
