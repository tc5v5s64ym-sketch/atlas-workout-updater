'use strict';

// ── Set C voice regression harness (Soul Plan PR-B7, Part 2) ─────────────────
//
// Turns the owner-ratified Set C taste (docs/ATLAS_VOICE_RATIFICATION_V1.md §3,
// encoded in test/fixtures/voiceCorpusSetC.js) into a permanent regression lock
// on the DETERMINISTIC halves of the coach voice: which coach_mode fires, which
// register the engine grants, when celebration is scarce, when the new_ground
// gate blocks a false PR, and that the persona core reaches every prompt surface
// exactly once. The LLM still owns WORDING only; deterministic code owns mode,
// register, permissions, facts, numbers, state, and gates — and this proves the
// current code matches the corpus.
//
// The harness drives the REAL modules through every fixture:
//   - services/coachMode.selectCoachMode           (mode selection)
//   - services/registerPermissions.grantRegister   (register grant)
//   - services/celebrationScarcity.computeCelebrationScarcity (scarcity)
//   - services/analytics.progressionVerdict/Band   (the new_ground gate)
//   - services/coach.findRegisterViolations        (the production suppressor)
//   - services/coach build*SystemPrompt + persona core (exactly-once)
//
// Behavior-level assertions, not whole-prompt snapshots. Where the §3 prose
// register label diverges from the ratified B2 enum (C2/C5/C11/C12/C14), the
// harness locks the ENUM output (§3 says the register line IS the enum) and the
// fixture records the divergence; the reconciliation is filed in BACKLOG.

const test = require('node:test');
const assert = require('node:assert/strict');

const { SET_C, CANONICAL, REG } = require('./fixtures/voiceCorpusSetC');
const { selectCoachMode, COACH_MODES } = require('../services/coachMode');
const { grantRegister, KNOWN_MODES } = require('../services/registerPermissions');
const { computeCelebrationScarcity } = require('../services/celebrationScarcity');
const { progressionVerdict, progressionBand } = require('../services/analytics');
const {
  findRegisterViolations,
  buildCoachSystemPrompt,
  buildChatSystemPrompt,
  buildPlanSystemPrompt,
  buildCompileSystemPrompt,
  buildVerdictReactionSystemPrompt,
} = require('../services/coach');
const { PERSONA_CORE } = require('../services/coachPersonaCore');
const det = require('./helpers/voiceViolationDetectors');

// ── 0. Corpus integrity — the fixtures are well-formed ────────────────────────

test('corpus: all sixteen canonical Set C scenarios are present (C1..C16)', () => {
  const ids = CANONICAL.map(s => s.id);
  for (let i = 1; i <= 16; i++) {
    assert.ok(ids.includes(`C${i}`), `canonical scenario C${i} must be encoded`);
  }
  assert.equal(CANONICAL.length, 16, 'exactly the sixteen owner-brief scenarios are canonical');
});

test('corpus: every fixture is structurally complete and self-consistent', () => {
  for (const s of SET_C) {
    assert.ok(typeof s.id === 'string' && s.id, 'id required');
    assert.ok(typeof s.description === 'string' && s.description, `${s.id}: description required`);
    assert.ok(COACH_MODES.includes(s.expected_mode), `${s.id}: expected_mode must be a known coach mode`);
    assert.ok(Array.isArray(s.approved) && s.approved.length >= 1, `${s.id}: at least one approved exemplar`);
    assert.ok(Array.isArray(s.rejected) && s.rejected.length >= 1, `${s.id}: at least one rejected exemplar`);
    assert.ok(Array.isArray(s.citable_numbers), `${s.id}: citable_numbers array required`);
    assert.ok(['silence', 'deterministic_copy', 'llm_wording'].includes(s.outcome_type),
      `${s.id}: outcome_type must be silence|deterministic_copy|llm_wording`);
    assert.equal(typeof s.drives_select_mode, 'boolean', `${s.id}: drives_select_mode boolean`);
    if (!s.drives_select_mode) {
      assert.ok(typeof s.mode_source === 'string' && s.mode_source,
        `${s.id}: a non-selectCoachMode scenario must name its mode_source`);
    }
    // expected_register is either null (pure silence) or a full grant shape.
    if (s.expected_register !== null) {
      for (const k of ['intensity', 'casual_ok', 'humor_ok', 'profanity_ok']) {
        assert.ok(k in s.expected_register, `${s.id}: expected_register.${k} required`);
      }
    }
  }
});

// ── 1. Mode selection — drive the REAL selectCoachMode ────────────────────────

for (const s of SET_C.filter(f => f.drives_select_mode)) {
  test(`mode [${s.id}]: selectCoachMode returns ${s.expected_mode}`, () => {
    const out = selectCoachMode(s.mode_input, s.mode_opts || {});
    assert.equal(out.mode, s.expected_mode,
      `${s.id} facts must select mode ${s.expected_mode}, got ${out.mode}`);
    assert.ok(out.evidence && typeof out.evidence === 'object', `${s.id}: evidence object required`);
  });
}

// ── 2. Register grant — drive the REAL grantRegister for every fixture ────────

for (const s of SET_C.filter(f => f.expected_register !== null)) {
  test(`register [${s.id}]: grantRegister(${s.expected_mode}) == ratified enum grant`, () => {
    const grant = grantRegister({ mode: s.expected_mode, scarcity: s.scarcity, ownerPrefs: s.owner_prefs });
    assert.deepEqual(grant, s.expected_register,
      `${s.id}: grantRegister must produce the fixture's expected_register`);
  });
}

// The four §3 prose labels that drifted from the ratified enum are LOCKED as
// known divergences here (documented, owner-reviewable) so a future reader sees
// the gap is deliberate, not an oversight. Filed for reconciliation in BACKLOG.
test('register: the documented §3-prose vs enum divergences are exactly C2/C5/C11/C12/C14', () => {
  const diverging = SET_C.filter(s => s.register_annotation_divergence).map(s => s.id).sort();
  assert.deepEqual(diverging, ['C11', 'C12', 'C14', 'C2', 'C5'].sort(),
    'the known register-annotation divergences must be exactly these five fixtures');
});

// ── 3. Register invariant matrix — the D1–D5 gates over EVERY mode ────────────
// (Assertions #4/#5/#6/#7: safety/pain/correction/refusal/uncertainty never get
// humor or profanity; routine stays restrained; only celebrate reaches MAX.)

test('register matrix: safety and refuse force the fully-conservative grant', () => {
  for (const mode of ['safety', 'refuse']) {
    const g = grantRegister({ mode, scarcity: true });
    assert.deepEqual(g, { intensity: 'routine', casual_ok: false, humor_ok: false, profanity_ok: false },
      `${mode} must be routine + nothing casual/funny/loud`);
  }
});

test('register matrix: no correction/challenge/reassure/safety/refuse mode ever gets humor or profanity', () => {
  // "uncertainty" surfaces deterministically as the safe floor (silent) or via
  // safety/refuse — none of these carry humor or profanity.
  for (const mode of ['correct', 'challenge', 'reassure', 'safety', 'refuse']) {
    const g = grantRegister({ mode, scarcity: true });
    assert.equal(g.humor_ok, false, `${mode} must never license humor`);
    assert.equal(g.profanity_ok, false, `${mode} must never license profanity`);
  }
});

test('register matrix: profanity is reachable in EXACTLY the celebrate x max x scarcity-clear cell', () => {
  for (const mode of KNOWN_MODES) {
    const clear = grantRegister({ mode, scarcity: true });
    const spent = grantRegister({ mode, scarcity: false });
    if (mode === 'celebrate') {
      assert.equal(clear.profanity_ok, true, 'celebrate + scarcity clear is the profanity cell');
      assert.equal(clear.intensity, 'max', 'celebrate is MAX');
      assert.equal(spent.profanity_ok, false, 'celebrate with a spent budget withholds profanity');
    } else {
      assert.equal(clear.profanity_ok, false, `${mode} must never reach the profanity cell`);
    }
  }
});

test('register matrix: MAX intensity is celebrate-only (merely-strong work never reaches MAX)', () => {
  for (const mode of KNOWN_MODES) {
    const g = grantRegister({ mode, scarcity: true });
    if (mode === 'celebrate') assert.equal(g.intensity, 'max');
    else assert.notEqual(g.intensity, 'max', `${mode} must not reach MAX (only a certified new-ground celebration does)`);
  }
});

test('register matrix: production staging — ownerPrefs.profanity_enabled:false closes the profanity cell', () => {
  // Production gates profanity OFF via ATLAS_COACH_PROFANITY (passed as
  // ownerPrefs.profanity_enabled); the certified cell then yields profanity_ok:false.
  const staged = grantRegister({ mode: 'celebrate', scarcity: true, ownerPrefs: { profanity_enabled: false } });
  assert.equal(staged.profanity_ok, false, 'the env-staged OFF path must withhold profanity even in the certified cell');
  assert.equal(staged.intensity, 'max', 'staging profanity off does not change intensity');
});

// ── 4. Celebration scarcity — the downgrade the corpus depends on ─────────────
// (Assertion #3: scarcity downgrades reactions; #6/#7: MAX only when the whole
// chain allows.) C3 (clear) vs C3-spent (spent) prove the selectCoachMode +
// grantRegister chain; a real log drives computeCelebrationScarcity end-to-end.

test('scarcity [C3 vs C3-spent]: the same new ground celebrates when clear, downgrades to praise when spent', () => {
  const c3 = SET_C.find(s => s.id === 'C3');
  const spent = SET_C.find(s => s.id === 'C3-spent');
  assert.equal(selectCoachMode(c3.mode_input, c3.mode_opts).mode, 'celebrate');
  assert.equal(selectCoachMode(spent.mode_input, spent.mode_opts).mode, 'praise');
  // …and the register follows: the certified profanity cell only in the clear case.
  assert.equal(grantRegister({ mode: 'celebrate', scarcity: true }).profanity_ok, true);
  assert.equal(grantRegister({ mode: 'praise', scarcity: false }).profanity_ok, false);
});

test('scarcity: computeCelebrationScarcity spends the budget after a real new-ground day', () => {
  // A lift with a genuine new-ground jump two days before the asOf date: the
  // rolling-7-day budget (cap 1/window) is then SPENT.
  const rows = [
    { date_clean: '2026-05-01', session_id: '20260501-AM-01', lift_code: 'BEN01', weight: 185, reps: 5, notes: '' },
    { date_clean: '2026-05-08', session_id: '20260508-AM-01', lift_code: 'BEN01', weight: 205, reps: 5, notes: '' }, // new ground
  ];
  const spent = computeCelebrationScarcity(rows, { asOf: '2026-05-10' });
  assert.equal(spent.scarcityClear, false, 'a new-ground day inside the window spends the budget');
  assert.ok(spent.last_new_ground && spent.last_new_ground.lift === 'BEN01');

  // Far enough out, the window has rolled past the event → budget clear again.
  const clear = computeCelebrationScarcity(rows, { asOf: '2026-06-01' });
  assert.equal(clear.scarcityClear, true, 'once the event rolls out of the window the budget is clear');

  // Empty / thin input never throws and reads clear (nothing has been spent).
  assert.equal(computeCelebrationScarcity([], { asOf: '2026-05-10' }).scarcityClear, true);
  assert.equal(computeCelebrationScarcity(null, {}).scarcityClear, true);
});

// ── 5. The new_ground gate blocks a false PR (C15) and passes a real one (C16) ─
// (Assertion #10 grounding: a claim of "PR" is engine-certified, never asserted.)

for (const s of SET_C.filter(f => f.false_pr_check)) {
  test(`new_ground gate [${s.id}]: ${s.false_pr_check.claimed_weight} vs prior best ${s.false_pr_check.prior_best} => new_ground=${s.false_pr_check.expected_new_ground}`, () => {
    const { claimed_weight, prior_best, expected_new_ground } = s.false_pr_check;
    // Prior history establishing the ceiling, then today's claimed top set.
    const priorRows = [
      { date_clean: '2026-04-01', session_id: '20260401-AM-01', lift_code: 'SQ', weight: prior_best, reps: 3, notes: '' },
    ];
    const band = progressionBand(priorRows);
    const verdict = progressionVerdict(claimed_weight, band);
    const isNewGround = !!(verdict && verdict.level === 'new_ground');
    assert.equal(isNewGround, expected_new_ground,
      `${s.id}: ${claimed_weight} against a ${prior_best} ceiling must ${expected_new_ground ? '' : 'NOT '}be new_ground`);
    // And the mode consequence: a blocked claim can never reach celebrate on the
    // new_ground path; a real one does (with scarcity clear).
    const mode = selectCoachMode({ progression_verdict: { level: isNewGround ? 'new_ground' : 'in_pocket' } }, { scarcityClear: true }).mode;
    assert.equal(mode === 'celebrate', expected_new_ground, `${s.id}: celebrate iff genuinely new ground`);
  });
}

// ── 6. Challenge is question-shaped, reassure stays evidence-bounded ──────────
// (Assertions #8 and #9.)

test('challenge [C14]: the approved exemplar is firm, specific, and QUESTION-shaped (asks, never lectures)', () => {
  const c14 = SET_C.find(s => s.id === 'C14');
  assert.ok(c14.requires_question_shape, 'C14 must require a question shape');
  for (const line of c14.approved) {
    assert.ok(det.isQuestionShaped(line), `C14 approved line must ask a question: ${line}`);
    assert.equal(det.detectProfanity(line).length, 0, 'challenge carries no profanity (honesty, not heat)');
    assert.equal(det.detectHype(line).length, 0, 'challenge carries no hype');
  }
  // The rejected lecture/hype lines are NOT question-shaped or trip a detector.
  for (const line of c14.rejected) {
    assert.ok(!det.isQuestionShaped(line) || det.detectHype(line).length > 0,
      `C14 rejected line must read as a lecture/hype: ${line}`);
  }
});

test('reassure [C7/C12]: says less with thin evidence and never invents progress', () => {
  for (const id of ['C7', 'C12']) {
    const s = SET_C.find(f => f.id === id);
    // Every approved reassurance line cites only its supplied digits (no invented numbers).
    for (const line of s.approved) {
      assert.deepEqual(det.detectUncitedNumbers(line, s.citable_numbers), [],
        `${id}: reassurance may cite only supplied numbers: ${line}`);
      assert.equal(det.detectFiller(line).length, 0, `${id}: no empty reassurance filler: ${line}`);
    }
  }
  // C7's thin-history alternate deliberately makes NO positive claim it lacks facts for.
  const c7 = SET_C.find(f => f.id === 'C7');
  const thinAlt = c7.approved[1];
  assert.ok(/one lift|it's one lift/i.test(thinAlt) || /flat weeks/i.test(thinAlt),
    'the thin-history reassurance stays honest and narrow');
});

// ── 7. No invented numbers / history — over EVERY approved exemplar ───────────
// (Assertion #10.)

for (const s of SET_C) {
  test(`grounding [${s.id}]: no approved exemplar states a digit absent from the supplied facts`, () => {
    for (const line of s.approved) {
      const uncited = det.detectUncitedNumbers(line, s.citable_numbers);
      assert.deepEqual(uncited, [],
        `${s.id}: approved line invents digit(s) ${JSON.stringify(uncited)} not in citable_numbers: ${line}`);
    }
  });
}

// ── 8. Persona core reaches every prompt surface exactly once (Assertion #11) ─

const PROMPT_SURFACES = [
  ['set-reaction', buildCoachSystemPrompt],
  ['chat', buildChatSystemPrompt],
  ['plan', buildPlanSystemPrompt],
  ['compile', buildCompileSystemPrompt],
  ['verdict-reaction', buildVerdictReactionSystemPrompt],
];

for (const [name, build] of PROMPT_SURFACES) {
  test(`persona core [${name}]: present exactly once, at the top`, () => {
    const prompt = build();
    const first = prompt.indexOf(PERSONA_CORE);
    assert.equal(first, 0, `${name} must open with the persona core`);
    assert.equal(prompt.indexOf(PERSONA_CORE, first + 1), -1, `${name} must carry the persona core exactly once`);
  });
}

test('persona core: carries the corpus-critical guarantees the harness relies on', () => {
  // The corpus assumes these persona-level guardrails are live on every surface
  // (numbers grounding, never-writes, anti-filler, anti-hype, plain text, the
  // register + profanity gates). If any is removed the corpus is no longer safe.
  assert.match(PERSONA_CORE, /IRON RULE — numbers/, 'numbers grounding');
  assert.match(PERSONA_CORE, /never write to any database or sheet/i, 'never-writes');
  assert.match(PERSONA_CORE, /Plain text only/i, 'plain-text');
  assert.match(PERSONA_CORE, /beast mode/i, 'anti-hype vocabulary');
  for (const phrase of ['great work', 'keep it up', 'solid session', 'stay consistent', 'nice job', 'well done']) {
    assert.ok(PERSONA_CORE.includes(phrase), `anti-filler must name "${phrase}"`);
  }
  assert.match(PERSONA_CORE, /PROFANITY is the engine's call/, 'profanity gate');
  assert.match(PERSONA_CORE, /NEVER in a safety, pain, correction, or uncertainty moment/i, 'profanity hard-ban contexts');
});

// ── 9. The production suppressor still catches the corpus's forbidden output ──
// (Assertion #12: existing deterministic sanitization protections remain intact.)

test('suppressor: findRegisterViolations passes every in-character exemplar under its granted register', () => {
  for (const s of SET_C) {
    if (s.expected_register === null) continue; // silence has no worded output
    for (const line of s.approved) {
      const violations = findRegisterViolations(line, { mode: s.expected_mode, register: s.expected_register });
      assert.deepEqual(violations, [],
        `${s.id}: an in-character line must not trip the suppressor under its own grant: ${line}`);
    }
  }
});

test('suppressor: profanity in prose is stripped everywhere EXCEPT the granted celebrate cell', () => {
  // The C3/C16 approved profanity lines pass ONLY because profanity_ok is granted…
  const c3 = SET_C.find(s => s.id === 'C3');
  const profLine = c3.approved[0]; // "Fuck yes. 225 …"
  assert.deepEqual(findRegisterViolations(profLine, { mode: 'celebrate', register: REG.celebrate_clear }), []);
  // …and are suppressed the instant the grant is anything else.
  const noGrant = findRegisterViolations(profLine, { mode: 'celebrate', register: { ...REG.celebrate_clear, profanity_ok: false } });
  assert.equal(noGrant.some(v => v.code === 'profanity_without_permission'), true,
    'the same swear must be flagged when profanity_ok is not granted');
});

test('suppressor: celebration/PR vocabulary is flagged outside celebrate/praise', () => {
  // A "new record" claim in a correct-mode reply (the C15 false-PR situation) is
  // exactly what the suppressor exists to strip.
  const v = findRegisterViolations('Incredible! New record!', { mode: 'correct', register: REG.correct });
  assert.equal(v.some(x => x.code === 'celebration_vocab_outside_earned_mode'), true,
    'PR/celebration vocab must be flagged when the mode is not celebrate/praise');
});

// ── 10. Exemplar consistency — the corpus lints itself ────────────────────────
// Every ❌ rejected line must trip at least one detector (proving it is genuinely
// out of character); every ✅ approved line must be free of the persona
// anti-patterns it is not explicitly allowed (profanity only where permitted).

function tripsAnyDetector(line, fixture) {
  const hits = [];
  if (det.detectFiller(line).length) hits.push('filler');
  if (det.detectCliche(line).length) hits.push('cliche');
  if (det.detectHype(line).length) hits.push('hype');
  if (det.detectPetNames(line).length) hits.push('pet_name');
  if (det.detectEmoji(line).length) hits.push('emoji');
  if (det.detectExclamationStacking(line)) hits.push('exclamation_stacking');
  if (det.detectUncitedNumbers(line, fixture.citable_numbers).length) hits.push('uncited_number');
  // Celebration vocab is only a violation OUTSIDE an earned (celebrate/praise) mode.
  if (fixture.expected_mode !== 'celebrate' && fixture.expected_mode !== 'praise'
      && det.detectCelebrationVocab(line).length) hits.push('celebration_vocab');
  // Profanity is only a violation where the cell does not permit it.
  if (!fixture.profanity_permitted && det.detectProfanity(line).length) hits.push('profanity');
  return hits;
}

for (const s of SET_C) {
  test(`exemplar lint [${s.id}]: every rejected line trips a detector; approved lines stay clean`, () => {
    for (const line of s.rejected) {
      const hits = tripsAnyDetector(line, s);
      assert.ok(hits.length > 0, `${s.id}: rejected line should read as out-of-character but tripped nothing: ${line}`);
    }
    for (const line of s.approved) {
      // Approved lines must carry NO filler, hype, pet names, emoji, exclamation
      // stacking, or uncited numbers. (Profanity is allowed only where permitted;
      // celebration vocab only in celebrate/praise — both handled by tripsAny.)
      assert.equal(det.detectFiller(line).length, 0, `${s.id}: approved line has filler: ${line}`);
      assert.equal(det.detectCliche(line).length, 0, `${s.id}: approved line has a cliché: ${line}`);
      assert.equal(det.detectHype(line).length, 0, `${s.id}: approved line has hype: ${line}`);
      assert.equal(det.detectPetNames(line).length, 0, `${s.id}: approved line has a pet name: ${line}`);
      assert.equal(det.detectEmoji(line).length, 0, `${s.id}: approved line has an emoji: ${line}`);
      assert.equal(det.detectExclamationStacking(line), null, `${s.id}: approved line stacks exclamations: ${line}`);
      if (!s.profanity_permitted) {
        assert.equal(det.detectProfanity(line).length, 0, `${s.id}: approved line swears without permission: ${line}`);
      }
    }
  });
}

test('exemplar lint: safety-class scenarios carry no humor cue and no profanity (C6)', () => {
  // C6 is safety-class: even though note-mode's register grants humor_ok:true, the
  // recovery read must never joke. The approved line must be plain and factual.
  const c6 = SET_C.find(s => s.id === 'C6');
  assert.equal(c6.safety_class, true);
  for (const line of c6.approved) {
    assert.equal(det.detectProfanity(line).length, 0, 'a recovery read never swears');
    assert.equal(det.detectHype(line).length, 0, 'a recovery read never hypes');
  }
});

// ── 11. Totality — malformed / partial fixture input degrades safely ──────────
// (Task: "totality for malformed fixture input where appropriate.")

test('totality: every fixture mode_input drives the modules without throwing, valid shapes only', () => {
  for (const s of SET_C) {
    // selectCoachMode is total over any input (incl. null); it must never throw
    // and must return a known mode.
    const modeOut = selectCoachMode(s.mode_input, s.mode_opts || {});
    assert.ok(COACH_MODES.includes(modeOut.mode), `${s.id}: selectCoachMode returned an unknown mode`);
    // grantRegister over the expected mode is total and returns a full grant.
    const grant = grantRegister({ mode: s.expected_mode, scarcity: s.scarcity });
    for (const k of ['intensity', 'casual_ok', 'humor_ok', 'profanity_ok']) {
      assert.ok(k in grant, `${s.id}: grant missing ${k}`);
    }
  }
});

test('totality: garbage fixture-shaped input never throws and lands on the safe floor', () => {
  for (const garbage of [undefined, null, 42, 'x', [], {}, { mode_input: 'nope' }]) {
    const mi = garbage && typeof garbage === 'object' ? garbage.mode_input : garbage;
    assert.equal(selectCoachMode(mi).mode, 'silent', 'garbage mode input → silent floor');
    assert.deepEqual(grantRegister(garbage), { intensity: 'routine', casual_ok: false, humor_ok: false, profanity_ok: false },
      'garbage register input → the conservative grant');
  }
});
