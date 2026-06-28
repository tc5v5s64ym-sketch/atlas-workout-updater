'use strict';

// B2 — Canonical active session state: surface consistency.
//
// QA campaign finding B2 (docs/QA_CAMPAIGN_2026-06-26_LIVE_GYM.md; BACKLOG.md):
// "surfaces (parser/UI/coach/preview/save) disagree; a success card and 'didn't
// catch lift' both fire." Named acceptance test (campaign PR 2): a single composer
// input must NOT produce BOTH a success confirmation card AND a "didn't catch"
// failure message for the same input.
//
// Root cause (verified by reading public/app.js): for a genuinely-unrecognized lift
// the composer status showed "Didn't catch that lift — check the exercise name
// before saving" while the SAME parsed rows were still captured — emitSetLogged
// buffers them into sessionLog/sessionCompleted and dispatches a confirmation card,
// then clears the very editor the warning told the lifter to check (public/app.js,
// emitSetLogged: setsTableBody cleared + parsedRowsEditor hidden). So the lifter saw
// a green "logged" card AND a red "didn't catch" failure for one input — contradictory
// surfaces, the exact B2 trust failure (owner live evidence: "RDLs" carded + warned +
// saved with muscle group Unknown).
//
// Fix: the composer surfaces ONE consistent name-review advisory that AGREES with the
// card ("I don't recognize …") instead of a failure message — and the set is still
// captured (no data loss; the unresolved name is still flagged for correction). The
// advisory stays gated by the identical shouldWarnUnknownLift check (KB/catalog-known
// lifts get no advisory at all). No write-path / trust-loop / proof-field change.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseWorkoutText } = require('../services/workoutTextParser');

const repoRoot = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');

// Extract the pure shouldWarnUnknownLift gate from app.js (same technique as
// test/cableFlyIdentity.test.js — the browser IIFE has no module export).
function loadShouldWarn() {
  const fnSrc = appSrc.slice(
    appSrc.indexOf('function shouldWarnUnknownLift('),
    appSrc.indexOf('function shouldUseLocalFallback(')
  );
  return new Function(`${fnSrc}; return shouldWarnUnknownLift;`)();
}

// The if-block that decides the unknown-lift advisory, sliced out for structural
// assertions. It is the last statement in rowsFromWorkoutInput, so it runs up to the
// shouldWarnUnknownLift definition that immediately follows.
function unknownLiftBranch() {
  const start = appSrc.indexOf('if (shouldWarnUnknownLift(parsed.warnings');
  assert.ok(start !== -1, 'the gated unknown-lift advisory branch must exist in app.js');
  const end = appSrc.indexOf('function shouldWarnUnknownLift(', start);
  return appSrc.slice(start, end === -1 ? start + 1200 : end);
}

// ── 1. The contradictory failure message is gone; one consistent advisory remains ──

test('b2: the "didn\'t catch that lift" failure message no longer contradicts the card', () => {
  assert.equal((appSrc.match(/Didn't catch that lift/g) || []).length, 0,
    'the failure-framed unknown-lift message must be removed');
  assert.equal((appSrc.match(/I don't recognize "/g) || []).length, 1,
    'exactly one consistent name-review advisory surface remains');
});

// ── 2. The advisory does NOT suppress set capture (card still fires) ──────────────
// This is what makes the composer status and the confirmation card AGREE: the set is
// captured for an unrecognized lift just like any other log, so the advisory must be
// a pure status note — never a throw/early-return that would strand the set OR (the
// pre-fix behavior) sit beside a contradicting "logged" card.

test('b2: unknown-lift advisory is a pure status note (no throw/early-return)', () => {
  const branch = unknownLiftBranch();
  assert.ok(/setStatus\(loggerStatus,/.test(branch),
    'the advisory must be surfaced via setStatus on the composer');
  assert.ok(!/\breturn\b/.test(branch),
    'the advisory branch must not return — the set still flows to the confirmation card');
  assert.ok(!/\bthrow\b/.test(branch),
    'the advisory branch must not throw — the set is captured, not dropped');
});

// ── 3. The advisory still FIRES for a genuinely-unknown lift (no silent capture) ──
// Surfaces agree, but the unresolved name is never swallowed: a lift unknown to both
// the parser and the catalog (and with no KB identity) still raises the advisory.

test('b2: a genuinely-unknown lift still raises the advisory', () => {
  const shouldWarn = loadShouldWarn();
  assert.equal(shouldWarn(['unknown_exercise'], 'Zzqx Press', () => '', null), true,
    'unknown to parser + catalog + KB → advisory shown (name flagged for correction)');
});

// ── 4. A card-eligible lift produces a card and NO advisory (the named B2 test) ──
// "Bench/Curls-style inputs cannot produce both success and 'didn't catch' for the
// same input." A cleanly-resolved lift parses to a card-eligible log_sets and never
// trips shouldWarnUnknownLift, so only the success surface fires.

test('b2: a cleanly-resolved lift fires only the card, never the advisory', () => {
  const shouldWarn = loadShouldWarn();
  for (const [input, canonical] of [['Bench 225 5/2', 'Bench Press'], ['Deadlift 315 5/2', 'Deadlift']]) {
    const parsed = parseWorkoutText(input);
    assert.equal(parsed.intent, 'log_sets', `${input} must be card-eligible (log_sets)`);
    assert.equal(parsed.canonical_name, canonical, `${input} resolves to ${canonical}`);
    const warnings = parsed.warnings || [];
    assert.ok(!warnings.includes('unknown_exercise'), `${input} resolves cleanly (no unknown_exercise)`);
    assert.equal(shouldWarn(warnings, parsed.canonical_name, () => 'CODE01', null), false,
      `${input}: success card fires with NO unknown-lift advisory — surfaces agree`);
  }
});

// ── 5. KB / catalog identity suppresses the advisory (regression with cableFly) ──
// A lift the parser flags unknown but the KB or catalog recognizes is a real lift —
// the card and isolation voice trust that identity, so the advisory must stay silent
// (no contradiction the other direction either).

test('b2: KB or catalog identity suppresses the advisory', () => {
  const shouldWarn = loadShouldWarn();
  const kb = { exercise_id: 'cable_fly', name: 'Cable Fly', confidence: 1 };
  assert.equal(shouldWarn(['unknown_exercise'], 'Cable Fly', () => '', kb), false,
    'KB identity suppresses the advisory even when the datalist does not know the lift');
  assert.equal(shouldWarn(['unknown_exercise'], 'Cable Fly', () => 'CABF01', null), false,
    'a catalog hit suppresses the advisory');
});
