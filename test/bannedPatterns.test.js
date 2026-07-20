'use strict';

// Drift Guard 2 — BANNED-PATTERN GUARD (Phase 2).
// The retired normal-path receipt ("On plan — logged.") is legal only inside the
// outage-only templatedAckLine; a re-introduction on any other production path fails
// the build, and the data-grounded wrap line is never flagged.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, enclosingFn } = require('../scripts/check-banned-patterns');

describe('Drift Guard 2 — banned patterns', () => {
  it('passes on the real repository (receipt lives only in its outage-only home)', () => {
    const r = analyze();
    assert.equal(r.valid, true, JSON.stringify(r.violations));
  });

  it('allows the retired receipt inside the outage-only templatedAckLine', () => {
    const files = [{ path: 'src/app/coachVoiceTemplates.js', content: 'function templatedAckLine() {\n  return "On plan — logged.";\n}' }];
    assert.equal(analyze(files).valid, true);
  });

  it('fails when the receipt is re-introduced on a normal-path function', () => {
    const files = [{ path: 'src/app/coach-conversation.js', content: 'function getInWorkoutNote() {\n  return "On plan — logged.";\n}' }];
    const r = analyze(files);
    assert.equal(r.valid, false);
    assert.equal(r.violations[0].fn, 'getInWorkoutNote');
    assert.equal(r.violations[0].pattern, 'normal-path-receipt');
  });

  it('never flags the data-grounded wrap line (facts, not a contentless receipt)', () => {
    const files = [{ path: 'src/app/coachVoiceTemplates.js', content: 'function templatedOnPlanWrapLine() {\n  return "On plan — RIR 2 across 3 sets, right where I called it.";\n}' }];
    assert.equal(analyze(files).valid, true);
  });

  it('never flags a comment that documents the retired receipt (not rendered code)', () => {
    const files = [{ path: 'src/app/coach-conversation.js', content: 'function getInWorkoutNote() {\n  // The retired "On plan — logged." receipt is gone for good.\n  return grounded();\n}' }];
    assert.equal(analyze(files).valid, true);
    const block = [{ path: 'src/app/x.js', content: 'function f() {\n  /* was: "On plan — logged." */\n  return grounded();\n}' }];
    assert.equal(analyze(block).valid, true);
  });

  it('never flags a contextual sentence that merely contains "logged"', () => {
    const files = [{ path: 'src/app/coach-conversation.js', content: 'function correction() {\n  return "I left your last lift as logged.";\n}' }];
    assert.equal(analyze(files).valid, true);
  });

  it('fails a top-level (no enclosing function) re-introduction', () => {
    const files = [{ path: 'src/app/x.js', content: 'const s = "On plan — logged.";' }];
    assert.equal(analyze(files).valid, false);
  });

  it('enclosingFn returns the nearest function name at or above a line', () => {
    const lines = ['function outer() {', '  const x = 1;', '  return "y";', '}'];
    assert.equal(enclosingFn(lines, 2), 'outer');
    assert.equal(enclosingFn(['const a = 1;'], 0), null);
  });
});
