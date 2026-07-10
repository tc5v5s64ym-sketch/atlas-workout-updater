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
const { analyze, extractSpecifiers } = require('../scripts/check-wired-modules');

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

test('wiring guard: orphan detection positively finds production-unreachable modules', () => {
  // Positive coverage for the core detection: every allowlisted / testOnly module
  // is genuinely unreachable from production — that is WHY it is listed — so it
  // must appear in the raw `orphans` set. This proves the graph walk actually
  // surfaces orphans (allowlisting only moves them out of `unwired`, not `orphans`).
  const r = analyze();
  const listed = [...r.allowlisted, ...r.testOnly];
  assert.ok(listed.length >= 1, 'there is at least one listed module to check');
  for (const f of listed) {
    assert.ok(r.orphans.includes(f), `${f} must be detected as an orphan (unreachable from production)`);
  }
});

test('wiring guard: the staged allowlist stays small (brief target ≤ 8)', () => {
  // The allowlist is an escape hatch, not a dumping ground. testOnly tooling is a
  // separate category and not subject to this cap.
  // (The B1–B3 staging window raised this to 11 for coachMode/registerPermissions/
  // celebrationScarcity; PR-B4 slice 1 wired all three into routes/coachOps.js and
  // removed their entries, so the cap is back to its standing 8.)
  const r = analyze();
  assert.ok(r.allowlisted.length <= 8,
    `staged allowlist has ${r.allowlisted.length} entries (> 8): ${r.allowlisted.join(', ')}`);
});

test('wiring guard: a commented-out require is not counted as a real edge', () => {
  // Precision: a documented/commented-out import must not keep a dead module
  // silently "wired" (the false negative that would defeat the guard).
  const src = [
    "const a = require('./real');",
    "// const b = require('./commented-line');",
    "/* const c = require('./commented-block'); */",
    "const url = 'https://example.com/not-a-comment';", // '//' inside a string is preserved
    "import d from './imported';",
  ].join('\n');
  const specs = extractSpecifiers(src);
  assert.ok(specs.includes('./real'), 'real require is an edge');
  assert.ok(specs.includes('./imported'), 'real import is an edge');
  assert.ok(!specs.includes('./commented-line'), 'a // commented require is NOT an edge');
  assert.ok(!specs.includes('./commented-block'), 'a /* */ commented require is NOT an edge');
});

test('wiring guard: expiry mechanism fails once a staged entry passes its date', () => {
  // Prove the forcing function works: run the analysis as if it were far in the
  // future — every dated staged entry must then read as expired and fail the guard.
  const future = analyze({ today: new Date('2099-01-01T00:00:00Z') });
  assert.ok(future.expired.length >= 1, 'a past-dated staged entry must surface as expired');
  assert.equal(future.ok, false, 'expired staged entries must fail the guard');
});
