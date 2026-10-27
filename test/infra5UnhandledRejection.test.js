'use strict';

// INFRA-5 — no `unhandledRejection` backstop for the ~67 bare async route
// handlers (Express 4 never forwards an async handler's rejection to the
// error middleware, so one future unguarded `await` kills the process
// mid-write under Node's default).
//
// The fix is a process-level backstop with ONE home
// (services/processBackstop.js), installed once from startServer(): an
// unhandled rejection is logged loudly as a structured event and the
// process stays alive, instead of dying silently mid-write. The backstop
// never throws and never swallows silently — the log line IS the surface.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const repoRoot = path.join(__dirname, '..');
const { installUnhandledRejectionBackstop } = require('../services/processBackstop');

function fakeProc() {
  return new EventEmitter();
}

test('INFRA-5: an unhandled rejection is logged as a structured event, not a process death', () => {
  const proc = fakeProc();
  const lines = [];
  assert.equal(installUnhandledRejectionBackstop({ proc, log: (l) => lines.push(l) }), true);
  proc.emit('unhandledRejection', new Error('boom-mid-write'));
  assert.equal(lines.length, 1, 'exactly one log line per rejection');
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'unhandled_rejection');
  assert.equal(entry.error, 'boom-mid-write');
  assert.ok(entry.stack, 'the stack is captured for diagnosis');
});

test('INFRA-5: a non-Error rejection reason is still logged, and the handler never throws', () => {
  const proc = fakeProc();
  const lines = [];
  installUnhandledRejectionBackstop({ proc, log: (l) => lines.push(l) });
  assert.doesNotThrow(() => proc.emit('unhandledRejection', 'plain string reason'));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).error, 'plain string reason');
});

test('INFRA-5: even a throwing logger cannot take the process down', () => {
  const proc = fakeProc();
  installUnhandledRejectionBackstop({
    proc,
    log: () => { throw new Error('logger broke'); },
  });
  assert.doesNotThrow(() => proc.emit('unhandledRejection', new Error('boom')));
});

test('INFRA-5: installation is once per process — a second install is an inert no-op', () => {
  const proc = fakeProc();
  const log = () => {};
  assert.equal(installUnhandledRejectionBackstop({ proc, log }), true);
  assert.equal(installUnhandledRejectionBackstop({ proc, log }), false);
  assert.equal(proc.listenerCount('unhandledRejection'), 1, 'exactly one listener, never stacked');
  // A different process object gets its own installation.
  const other = fakeProc();
  assert.equal(installUnhandledRejectionBackstop({ proc: other, log }), true);
  assert.equal(other.listenerCount('unhandledRejection'), 1);
});

test('INFRA-5: startServer installs the backstop; index.js has no second registration site', () => {
  const indexSrc = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  assert.match(indexSrc, /require\('\.\/services\/processBackstop'\)/,
    'index.js must wire the backstop module');
  const startServer = indexSrc.slice(indexSrc.indexOf('function startServer()'));
  assert.match(startServer, /installUnhandledRejectionBackstop\(\)/,
    'startServer must install the backstop when the server starts');
  assert.doesNotMatch(indexSrc, /process\.on\('unhandledRejection'/,
    'the registration lives only in services/processBackstop.js — one home');
});
