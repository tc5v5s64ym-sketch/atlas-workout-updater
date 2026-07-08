'use strict';

// PR-23 — Flight-Recorder replay harness (docs/REMEDIATION_PLAN_V2.md).
//
// Data-driven regression lock: each fixture under test/fixtures/replays/ is a
// recorded Flight-Recorder session export (see docs/FLIGHT_RECORDER_SPEC.md §2
// for the real event taxonomy this mirrors). test/helpers/flightReplay.js
// re-drives the real client/session-state-machine functions through the
// fixture's recorded event sequence; this file just loads every fixture and
// asserts the outcome matches what was recorded as `expected`.
//
// Seeded with the 7 v116 live-session findings in docs/PR10_REGRESSION_ADDENDUM.md.
// Six are fixed and have a fixture here (ADD-1/2/4/5/6/7, using the scenario names
// in test/helpers/flightReplay.js). ADD-3 ("stay away from legs and lower back
// must constrain remaining suggestions") is NOT fixed — it is a new capability,
// owner-reserved, awaiting the Atlas Decision Desk verdict on issue #914
// (BACKLOG.md "ADD-3") — so it has no fixture. Add one here once it ships.
//
// See test/fixtures/replays/README.md for the fixture schema and how to turn a
// real recorded session into a new fixture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { replayFixture } = require('./helpers/flightReplay');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'replays');
const fixtureFiles = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json')).sort();

assert.ok(fixtureFiles.length >= 6, `expected at least the 6 fixed-case fixtures, found ${fixtureFiles.length}`);

for (const file of fixtureFiles) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));

  test(`replay: ${fixture.id} — ${fixture.description}`, async () => {
    assert.ok(fixture.scenario, `${file}: fixture must name a scenario`);
    assert.ok(Array.isArray(fixture.events) && fixture.events.length, `${file}: fixture must have a non-empty events array`);
    assert.ok(fixture.expected, `${file}: fixture must declare an expected outcome`);

    const actual = await replayFixture(fixture);
    assert.deepEqual(actual, fixture.expected, `${fixture.id}: replayed outcome must match the recorded expectation`);
  });
}

test('replay harness: every fixture names a scenario with a registered adapter', () => {
  const { ADAPTERS } = require('./helpers/flightReplay');
  for (const file of fixtureFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
    assert.ok(ADAPTERS[fixture.scenario], `${file}: scenario "${fixture.scenario}" has no adapter in flightReplay.js`);
  }
});
