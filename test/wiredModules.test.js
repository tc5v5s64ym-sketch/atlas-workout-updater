'use strict';

// Wired-or-deleted guard (Remediation PR-13).
//
// Every services/*.js must be reachable from a production entrypoint (static
// require/import graph seeded from index.js/sheets.js/middleware.js, scripts/*,
// config/* recursively, the frontend entry, and the declarative capability
// manifest's module.file strings) — OR be explicitly listed in
// config/wiring-allowlist.json. A module nothing runs is dead weight; this test
// makes that state fail CI so it is wired, deleted, or (temporarily, with an
// expiry) allowlisted. The allowlist's staged entries expire, so a module can
// never sit unwired forever.
//
// See scripts/check-wired-modules.js for the analysis.

const test = require('node:test');
const assert = require('node:assert');
const { analyze } = require('../scripts/check-wired-modules');

test('wiring guard: every services/*.js is wired or validly allowlisted', () => {
  const r = analyze();
  const problems = [];
  if (r.unwired.length) problems.push(`UNWIRED (wire/delete/allowlist): ${r.unwired.join(', ')}`);
  if (r.expired.length) problems.push(`EXPIRED allowlist entries (wire or delete now): ${r.expired.join(', ')}`);
  if (r.staleAllow.length) problems.push(`STALE allowlist entries (remove): ${r.staleAllow.join(', ')}`);
  if (r.allowErrors.length) problems.push(`MALFORMED allowlist entries: ${r.allowErrors.join(', ')}`);
  assert.equal(problems.length, 0, `\n${problems.join('\n')}`);
  assert.equal(r.ok, true);
});

test('wiring guard: the staged allowlist stays small (brief target ≤ 8)', () => {
  // The allowlist is an escape hatch, not a dumping ground. testOnly tooling is a
  // separate category and not subject to this cap.
  const r = analyze();
  assert.ok(r.allowlisted.length <= 8,
    `staged allowlist has ${r.allowlisted.length} entries (> 8): ${r.allowlisted.join(', ')}`);
});

test('wiring guard: expiry mechanism fails once a staged entry passes its date', () => {
  // Prove the forcing function works: run the analysis as if it were far in the
  // future — every dated staged entry must then read as expired and fail the guard.
  const future = analyze({ today: new Date('2099-01-01T00:00:00Z') });
  assert.ok(future.expired.length >= 1, 'a past-dated staged entry must surface as expired');
  assert.equal(future.ok, false, 'expired staged entries must fail the guard');
});
