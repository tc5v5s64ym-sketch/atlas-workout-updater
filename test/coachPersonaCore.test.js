'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCoachSystemPrompt,
  buildPlanSystemPrompt,
  buildChatSystemPrompt,
  buildCompileSystemPrompt,
  buildVerdictReactionSystemPrompt,
} = require('../services/coach');
const { PERSONA_CORE, buildPersonaCore } = require('../services/coachPersonaCore');

// The five prompt builders, by the name PR-A2 uses for them.
const BUILDERS = [
  ['set-reaction', () => buildCoachSystemPrompt()],
  ['chat', () => buildChatSystemPrompt()],
  ['verdict-reaction', () => buildVerdictReactionSystemPrompt()],
  ['plan', () => buildPlanSystemPrompt()],
  ['compile', () => buildCompileSystemPrompt()],
];

// ── (2) the module: one frozen persona + iron-rule block ──────────────────────

test('persona core: buildPersonaCore returns the PERSONA_CORE block, and the module export is frozen', () => {
  assert.equal(buildPersonaCore(), PERSONA_CORE, 'accessor must return the constant');
  assert.equal(typeof PERSONA_CORE, 'string');
  // PERSONA_CORE is a string primitive (already immutable); tamper-resistance is
  // on the exported object, so a consumer can't swap out buildPersonaCore/PERSONA_CORE.
  assert.ok(Object.isFrozen(require('../services/coachPersonaCore')), 'the module export must be frozen');
});

// ── (1a) every builder emits the persona core exactly once, at the top ────────

for (const [name, build] of BUILDERS) {
  test(`persona core: the ${name} prompt carries the core exactly once, at the top`, () => {
    const prompt = build();
    const first = prompt.indexOf(PERSONA_CORE);
    assert.ok(first >= 0, `${name} prompt must contain the persona core`);
    assert.equal(prompt.indexOf(PERSONA_CORE, first + 1), -1,
      `${name} prompt must contain the persona core exactly once`);
    // "at the top": the core is the very start of the system prompt.
    assert.equal(first, 0, `${name} prompt must open with the persona core`);
  });
}

// ── (1b) shared rules apply to ALL five voices (they now flow from the core) ───

const SHARED_RULE_PROBES = [
  ['IRON RULE on numbers', /IRON RULE — numbers: every number is engine-computed/],
  ['never-writes', /never write to any database or sheet/i],
  ['plain-text-only', /plain text only/i],
  ['no-markdown', /no markdown/i],
  ['anti-hype: beast mode', /beast mode/i],
  ['anti-hype: crushing it', /crushing it/i],
  ['thin-history filler ban: great work', /great work/i],
  ['thin-history filler ban: keep it up', /keep it up/i],
];

for (const [name, build] of BUILDERS) {
  for (const [ruleName, probe] of SHARED_RULE_PROBES) {
    test(`persona core: the ${name} voice carries the shared rule "${ruleName}"`, () => {
      assert.match(build(), probe, `${name} must carry the shared rule "${ruleName}" via the core`);
    });
  }
}

// ── (1b, cont.) the ratified identity now reaches every voice ─────────────────

for (const [name, build] of BUILDERS) {
  test(`persona core: the ${name} voice speaks in the ratified logbook-keeper identity`, () => {
    const prompt = build();
    assert.match(prompt, /keep(s)? the logbook/i, `${name} identity must keep the logbook`);
    assert.match(prompt, /not easily impressed/i, `${name} identity must be not easily impressed`);
    assert.match(prompt, /hype man/i, `${name} identity must reject the hype-man voice`);
  });
}

// ── (1b) the superseded "sharp, encouraging" placeholder is gone everywhere ────

for (const [name, build] of BUILDERS) {
  test(`persona core: the ${name} voice no longer carries the superseded "sharp, encouraging" identity`, () => {
    assert.doesNotMatch(build(), /sharp, encouraging/i,
      `${name} must not carry the retired placeholder persona line`);
  });
}

// ── (1c) golden test: the core text forbids the named filler + anti-pattern
//         vocabulary (services/coach.js:1293-1295 list) ───────────────────────

test('persona core golden: the block names every banned filler phrase', () => {
  const fillerPhrases = ['great work', 'keep it up', 'solid session', 'stay consistent', 'nice job', 'well done'];
  for (const phrase of fillerPhrases) {
    assert.ok(PERSONA_CORE.includes(phrase), `core must name the banned filler phrase "${phrase}"`);
  }
});

test('persona core golden: the block bans the anti-pattern hype vocabulary', () => {
  assert.match(PERSONA_CORE, /pet names/i, 'core must ban pet names');
  assert.match(PERSONA_CORE, /beast mode/i, 'core must ban "beast mode"');
  assert.match(PERSONA_CORE, /crushing it/i, 'core must ban "crushing it"');
  assert.match(PERSONA_CORE, /emoji/i, 'core must ban emoji');
  assert.match(PERSONA_CORE, /attendance|ordinary compliance/i, 'core must ban attendance / ordinary-compliance praise');
});

test('persona core golden: the block carries the numbers IRON RULE and the never-writes rule', () => {
  assert.match(PERSONA_CORE, /IRON RULE — numbers/, 'core must carry the numbers iron rule');
  assert.match(PERSONA_CORE, /Never invent or change numbers/i, 'core must forbid inventing numbers');
  assert.match(PERSONA_CORE, /never write to any database or sheet/i, 'core must carry never-writes');
});

// ── (PR-B4 slice 2) register-interpretation block ─────────────────────────────

const REGISTER_HEADER = "REGISTER — how loud you may be is the engine's call, never yours";

test('register block: the core describes routine/elevated/max and the casual/humor licenses', () => {
  assert.ok(PERSONA_CORE.includes(REGISTER_HEADER), 'core must carry the register-interpretation block');
  for (const level of ['routine', 'elevated', 'max']) {
    assert.ok(PERSONA_CORE.includes(`"${level}"`), `register block must describe intensity "${level}"`);
  }
  assert.match(PERSONA_CORE, /"casual_ok"/, 'register block must describe casual_ok');
  assert.match(PERSONA_CORE, /"humor_ok"/, 'register block must describe humor_ok');
});

test('register block: the engine grants the level; the model never chooses its own volume', () => {
  assert.match(PERSONA_CORE, /NEVER choose your own volume, and never upgrade it/,
    'the model must be told it never picks its own intensity');
  assert.match(PERSONA_CORE, /When "register" is absent, treat it as routine/,
    'absent register defaults to routine');
  assert.match(PERSONA_CORE, /Register sets TONE only\. A higher intensity never overrides a grounding rule/,
    'register must be subordinate to the grounding rules (no invented numbers even at max)');
});

test('register block: profanity is NOT described in this slice (it lands with its suppressor in B4-3)', () => {
  assert.doesNotMatch(PERSONA_CORE, /profanit|swear|curse|\bfuck|\bshit/i,
    'the persona core must NOT mention profanity until B4-3 wires it with its deterministic suppressor');
});

test('register block reaches every voice via the core, exactly once', () => {
  for (const [name, build] of BUILDERS) {
    const prompt = build();
    const first = prompt.indexOf(REGISTER_HEADER);
    assert.ok(first >= 0, `${name} must carry the register block via the core`);
    assert.equal(prompt.indexOf(REGISTER_HEADER, first + 1), -1,
      `${name} must carry the register block exactly once`);
  }
});
