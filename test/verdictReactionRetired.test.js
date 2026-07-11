'use strict';

// Soul Plan PR-A6 — Verdict-reaction voice disposition: ONE set-reaction voice.
//
// Atlas carried two set-reaction coaches: the WIRED voice (buildCoachSystemPrompt /
// generateCoachMessage, the one actually surfaced) and an UNWIRED duplicate — the
// "verdict reaction" voice (buildVerdictReactionSystemPrompt / generateVerdictReaction)
// that no production path ever called (the PR-A6 inventory confirmed zero callers in
// index.js / routes/ / src/). PR-A6's owner-ratified disposition is FOLD: the wired
// set voice already carries every overlapping rule in equal-or-richer form, so the
// duplicate is retired rather than wired. This is the "two coaches in code" era ending.
//
// This guard makes the retirement permanent: the verdict-reaction cluster must stay
// gone, and — crucially — the shared helper it borrowed (sanitizeSubstitution, used by
// the LIVE sanitizeFacts) must NOT have been deleted along with it. If a later change
// re-introduces the duplicate voice, or over-deletes the shared helper, this fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const coach = require('../services/coach');

// The unwired verdict-reaction cluster — every symbol PR-A6 retires. None may be
// re-exported: the voice is deleted, not merely unwired.
const RETIRED_SYMBOLS = [
  'buildVerdictReactionSystemPrompt',
  'generateVerdictReaction',
  'shouldReactToVerdict',
  'isVerdictWorthReacting',
  'hasActionableRuleDecision',
  'sanitizeVerdictFacts',
  'sanitizeRuleDecision',
  'sanitizeRuleDecisions',
  'sanitizeReactionContext',
];

test('PR-A6: the retired verdict-reaction voice is no longer exported from services/coach', () => {
  for (const name of RETIRED_SYMBOLS) {
    assert.equal(coach[name], undefined,
      `${name} must be retired — the unwired verdict-reaction voice is deleted, not exported`);
  }
});

test('PR-A6: services/coach.js no longer defines the verdict-reaction builder or its dead helpers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'coach.js'), 'utf8');
  for (const name of RETIRED_SYMBOLS) {
    assert.ok(!new RegExp(`function ${name}\\b`).test(src),
      `${name} must not be defined in coach.js — the fold retires the whole cluster`);
  }
});

test('PR-A6: the one surfaced set-reaction voice remains, and the register violation suppressor stays', () => {
  // The wired path is untouched — it is the single set-reaction voice that survives.
  assert.equal(typeof coach.generateCoachMessage, 'function', 'the wired set voice must remain');
  assert.equal(typeof coach.buildCoachSystemPrompt, 'function', 'the wired set-voice prompt builder must remain');
  // The deterministic register suppressor is a live-path guard, not part of the cluster.
  assert.equal(typeof coach.findRegisterViolations, 'function', 'the register suppressor must remain');
});

test('PR-A6: sanitizeSubstitution is NOT collateral — the live sanitizeFacts still owns it', () => {
  // sanitizeSubstitution was borrowed by the retired sanitizeReactionContext but is
  // ALSO the swap-classification whitelist for the live set voice (sanitizeFacts). It
  // must survive the fold; deleting it would strip the substitution verdict from the
  // surfaced coaching note.
  assert.equal(typeof coach.sanitizeSubstitution, 'function',
    'sanitizeSubstitution is shared by the live sanitizeFacts and must stay');
  const facts = coach.sanitizeFacts({
    liftCode: 'BENCH',
    substitution: { classification: 'preserved', decision: 'approve', prescribed: 'Bench', logged: 'DB Bench' },
  });
  assert.ok(facts.substitution && facts.substitution.decision === 'approve',
    'the live set voice still receives the engine substitution verdict');
});
