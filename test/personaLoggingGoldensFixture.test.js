'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GOLDENS, EXCLUDED, SOURCE_OF_TRUTH } = require('./fixtures/personaLoggingGoldens');

// ---------------------------------------------------------------------------
// Persona Test Rig, Slice 1a (issue #1607) — fixture-integrity guard for
// test/fixtures/personaLoggingGoldens.js.
//
// This test does NOT run the goldens against the parser — that driver is
// Slice 1b (test/personaLoggingGoldens.test.js). This guard proves the
// fixture is well-formed enough for that driver to trust: it loads, every
// golden carries its input / stated expected parse / provenance, inputs are
// unique per athlete/session, correction entries point at a real golden,
// and the fail-closed EXCLUDED list is present with a reason per entry (the
// adjudication rule — design §2.4 — is only auditable if both lists are).
// ---------------------------------------------------------------------------

const MEASURES = ['weight', 'reps', 'rir', 'durationSec', 'distanceM'];
const KINDS = new Set(['log', 'correction-end-state']);
const BASES = new Set(['card-restated', 'card-plan-match', 'mixed']);

test('fixture loads: GOLDENS and EXCLUDED are non-empty arrays with a named source of truth', () => {
  assert.ok(Array.isArray(GOLDENS) && GOLDENS.length > 0, 'GOLDENS must be a non-empty array');
  assert.ok(Array.isArray(EXCLUDED) && EXCLUDED.length > 0, 'EXCLUDED must be a non-empty array');
  assert.equal(typeof SOURCE_OF_TRUTH, 'string');
  assert.ok(SOURCE_OF_TRUTH.includes('ATLAS_SOUL_CORPUS_V2_SESSIONS.md'));
});

test('every golden carries id, source, persona, kind, verbatim input, stated expected parse, and provenance', () => {
  for (const g of GOLDENS) {
    const at = `golden ${g.id || '(missing id)'}`;
    assert.equal(typeof g.id, 'string', `${at}: id`);
    assert.ok(g.id.length > 0, `${at}: id non-empty`);
    assert.equal(g.source && g.source.doc, 'ATLAS_SOUL_CORPUS_V2_SESSIONS.md', `${at}: source.doc`);
    assert.equal(typeof g.source.ref, 'string', `${at}: source.ref`);
    assert.ok(g.source.ref.length > 0, `${at}: source.ref non-empty`);
    assert.ok(Number.isInteger(g.session) && g.session >= 1 && g.session <= 15, `${at}: session 1–15`);
    assert.equal(typeof g.persona, 'string', `${at}: persona`);
    assert.ok(g.persona.length > 0, `${at}: persona non-empty`);
    assert.ok(KINDS.has(g.kind), `${at}: kind must be log | correction-end-state`);
    assert.equal(typeof g.input, 'string', `${at}: input`);
    assert.ok(g.input.trim().length > 0, `${at}: input non-empty`);

    // The expected parse: at least one exercise, each with a name and a
    // non-empty set list; every set states at least one measurable field
    // (a null field means "not stated", so a set with NO stated measure
    // would be an invented set).
    assert.ok(g.expected && Array.isArray(g.expected.exercises), `${at}: expected.exercises`);
    assert.ok(g.expected.exercises.length > 0, `${at}: expected.exercises non-empty`);
    for (const ex of g.expected.exercises) {
      assert.equal(typeof ex.name, 'string', `${at}: exercise name`);
      assert.ok(ex.name.length > 0, `${at}: exercise name non-empty`);
      assert.ok(Array.isArray(ex.sets) && ex.sets.length > 0, `${at}: ${ex.name} sets non-empty`);
      for (const s of ex.sets) {
        assert.ok(s && typeof s === 'object', `${at}: ${ex.name} set is an object`);
        assert.ok(
          MEASURES.some((k) => s[k] !== null && s[k] !== undefined),
          `${at}: ${ex.name} set must state at least one measurable field`,
        );
        for (const k of MEASURES) {
          if (s[k] !== null && s[k] !== undefined) {
            assert.equal(typeof s[k], 'number', `${at}: ${ex.name} set ${k} is a number when stated`);
            assert.ok(Number.isFinite(s[k]) && s[k] >= 0, `${at}: ${ex.name} set ${k} is finite and >= 0`);
          }
        }
      }
    }

    // Provenance: the card text the parse was taken from, verbatim, plus the
    // adjudication basis that admitted the line.
    assert.ok(g.provenance && typeof g.provenance.card === 'string', `${at}: provenance.card`);
    assert.ok(g.provenance.card.length > 0, `${at}: provenance.card non-empty`);
    assert.ok(BASES.has(g.provenance.basis), `${at}: provenance.basis must name the adjudication basis`);
  }
});

test('golden ids are unique and inputs are unique per athlete/session', () => {
  const ids = new Set();
  const perAthleteSession = new Set();
  for (const g of GOLDENS) {
    assert.ok(!ids.has(g.id), `duplicate golden id ${g.id}`);
    ids.add(g.id);
    const key = `${g.persona}|${g.session}|${g.input}`;
    assert.ok(!perAthleteSession.has(key), `duplicate input for ${g.persona} session ${g.session}: ${g.input}`);
    perAthleteSession.add(key);
  }
});

test('correction-end-state goldens correct a real golden from the same session and athlete', () => {
  const byId = new Map(GOLDENS.map((g) => [g.id, g]));
  const corrections = GOLDENS.filter((g) => g.kind === 'correction-end-state');
  assert.ok(corrections.length > 0, 'the corpus has stated corrections; the fixture must carry them');
  for (const c of corrections) {
    assert.equal(typeof c.corrects, 'string', `${c.id}: corrects`);
    const target = byId.get(c.corrects);
    assert.ok(target, `${c.id}: corrects target ${c.corrects} must exist in GOLDENS`);
    assert.notEqual(target.id, c.id, `${c.id}: must not correct itself`);
    assert.equal(target.session, c.session, `${c.id}: correction and target share a session`);
    assert.equal(target.persona, c.persona, `${c.id}: correction and target share an athlete`);
    assert.equal(target.kind, 'log', `${c.id}: correction target is a log golden`);
  }
  for (const g of GOLDENS) {
    if (g.kind === 'log') assert.equal(g.corrects, undefined, `${g.id}: log goldens carry no corrects field`);
  }
});

test('excluded list is present with a reason per entry and never overlaps the goldens', () => {
  const goldenKeys = new Set(GOLDENS.map((g) => `${g.persona}|${g.session}|${g.input}`));
  const seenIds = new Set(GOLDENS.map((g) => g.id));
  for (const e of EXCLUDED) {
    const at = `excluded ${e.id || '(missing id)'}`;
    assert.equal(typeof e.id, 'string', `${at}: id`);
    assert.ok(e.id.length > 0, `${at}: id non-empty`);
    assert.ok(!seenIds.has(e.id), `${at}: id must be unique across both lists`);
    seenIds.add(e.id);
    assert.equal(e.source && e.source.doc, 'ATLAS_SOUL_CORPUS_V2_SESSIONS.md', `${at}: source.doc`);
    assert.ok(Number.isInteger(e.session) && e.session >= 1 && e.session <= 15, `${at}: session 1–15`);
    assert.equal(typeof e.persona, 'string', `${at}: persona`);
    assert.ok(e.persona.length > 0, `${at}: persona non-empty`);
    assert.equal(typeof e.input, 'string', `${at}: input`);
    assert.ok(e.input.trim().length > 0, `${at}: input non-empty`);
    assert.equal(typeof e.reason, 'string', `${at}: reason`);
    assert.ok(e.reason.trim().length > 0, `${at}: every excluded line carries its reason`);
    // A line is adjudicated once: it cannot be both a golden and excluded.
    assert.ok(!goldenKeys.has(`${e.persona}|${e.session}|${e.input}`), `${at}: line is both golden and excluded`);
  }
});

test('counts are pinned: 35 goldens (33 log + 2 correction-end-state) and 10 excluded', () => {
  // Pinned from the PR #1613 review (Slice 1a): without an exact count, a
  // golden could be silently deleted and every other assertion in this file
  // would still pass. An intentional extraction change must update this pin
  // in the same PR that changes the fixture — that is what makes the change
  // deliberate and reviewable.
  assert.equal(GOLDENS.length, 35, 'golden count is pinned at 35');
  assert.equal(GOLDENS.filter((g) => g.kind === 'log').length, 33, 'log goldens pinned at 33');
  assert.equal(GOLDENS.filter((g) => g.kind === 'correction-end-state').length, 2, 'correction-end-state goldens pinned at 2');
  assert.equal(EXCLUDED.length, 10, 'excluded count is pinned at 10');
});

test('all fifteen corpus sessions are accounted for across the two lists', () => {
  const covered = new Set();
  for (const g of GOLDENS) covered.add(g.session);
  for (const e of EXCLUDED) covered.add(e.session);
  for (let s = 1; s <= 15; s += 1) {
    assert.ok(covered.has(s), `session ${s} appears in neither GOLDENS nor EXCLUDED`);
  }
});
