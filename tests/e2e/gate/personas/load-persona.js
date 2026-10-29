'use strict';

// ── The persona fixture loader — ONE way a persona enters the harness ─────────
// Slice 2a of the persona test rig (issue #1607; design §3.2). The gate server
// and the persona spec both load fixtures through here, so "which personas
// exist" and "what shape a fixture must carry" are decided in exactly one
// place and fail closed everywhere else: an unknown slug, a malformed slug
// (including any path traversal — a slug is a NAME, never a path), a fixture
// whose declared slug disagrees with the file it was loaded from, or a fixture
// missing a declared field is a harness refusal, not a fallback.
//
// Pure file loading only: no environment, no network, no mutation.

const path = require('node:path');
const { isPersonaSlug } = require('../rehearsal-run-purpose');

const CARD_FIELDS = Object.freeze([
  'goal', 'experience', 'style', 'schedule', 'equipment', 'injury',
  'personality', 'communication', 'recovery', 'loggingStyle', 'adherence',
]);
const FIXTURE_FIELDS = Object.freeze([
  'slug', 'sourceRef', 'card', 'plan', 'historyMode', 'historyRows',
  'catalogRows', 'beats', 'expected', 'facts', 'reviewChecklist',
]);
const HISTORY_MODES = Object.freeze(['alongside', 'replace']);

// Returns a list of shape problems with a fixture (empty = well-formed). The
// checks are structural only — whether a fixture's plan is PLAUSIBLE against
// its history is authoring judgement (design §4.4), not machinery.
function personaFixtureProblems(fixture, expectedSlug) {
  const problems = [];
  const f = fixture && typeof fixture === 'object' ? fixture : null;
  if (!f) return ['the fixture module did not export an object'];
  for (const field of FIXTURE_FIELDS) {
    if (!(field in f)) problems.push(`the fixture is missing its declared "${field}" field`);
  }
  if (problems.length) return problems;
  if (!isPersonaSlug(f.slug)) problems.push(`the fixture's slug "${f.slug}" is not a valid persona slug`);
  if (expectedSlug !== undefined && f.slug !== expectedSlug) {
    problems.push(`the fixture declares slug "${f.slug}" but was loaded as "${expectedSlug}" — a fixture may only answer to its own name`);
  }
  if (typeof f.sourceRef !== 'string' || f.sourceRef.trim() === '') {
    problems.push('the fixture\'s sourceRef is empty — every persona cites the card + script it was authored from');
  }
  const card = f.card && typeof f.card === 'object' ? f.card : {};
  for (const field of CARD_FIELDS) {
    if (typeof card[field] !== 'string' || card[field].trim() === '') {
      problems.push(`the athlete card is missing a non-empty "${field}" field`);
    }
  }
  if (!Array.isArray(f.plan) || f.plan.length === 0) {
    problems.push('the fixture\'s plan is empty — a persona run needs a declared plan to accept');
  } else {
    f.plan.forEach((row, i) => {
      const r = row && typeof row === 'object' ? row : {};
      for (const field of ['exercise', 'lift_code', 'target_weight', 'target_reps', 'target_sets', 'target_rir']) {
        if (r[field] === undefined || r[field] === null || r[field] === '') {
          problems.push(`plan row ${i} is missing "${field}" (the OWNER_PLAN row shape)`);
        }
      }
    });
  }
  if (!HISTORY_MODES.includes(f.historyMode)) {
    problems.push(`historyMode must be one of ${HISTORY_MODES.join(' / ')}; got "${f.historyMode}"`);
  }
  if (!Array.isArray(f.historyRows)) {
    problems.push('historyRows is not an array of logCleanedColumns-shaped rows');
  } else {
    f.historyRows.forEach((row, i) => {
      // The GATE-H convention: the 11 leading logCleanedColumns values
      // (volume_calc is derived and omitted, exactly as the shared rows omit it).
      if (!Array.isArray(row) || row.length !== 11) {
        problems.push(`history row ${i} is not an 11-value logCleanedColumns-shaped row`);
      } else if (!/^PERS-[A-Z]+[0-9]+$/.test(String(row[1] || ''))) {
        problems.push(`history row ${i} carries session id "${row[1]}" — persona history uses synthetic PERS-… ids, never a server-shaped or shared-harness id`);
      }
    });
  }
  if (!Array.isArray(f.catalogRows)) problems.push('catalogRows is not an array (declare [] when the gate catalog already carries the persona\'s lifts)');
  if (!Array.isArray(f.beats) || f.beats.length === 0) problems.push('beats is empty — a persona declares its turn templates, even before any slice runs them');
  if (!f.expected || typeof f.expected !== 'object') problems.push('expected is not a declaration object (the SCENARIOS[n].expected shape)');
  if (!f.facts || typeof f.facts !== 'object') problems.push('facts is not a declaration object (the §3.4 fact-check declarations)');
  if (!Array.isArray(f.reviewChecklist) || f.reviewChecklist.length === 0) {
    problems.push('reviewChecklist is empty — the human voice/feel pass is part of the format, not an optional extra');
  }
  return problems;
}

// Load + validate the fixture for a slug. Throws an Error naming every problem
// on any failure — callers (gate server, persona spec) treat a throw as a
// harness refusal before anything runs.
function loadPersonaFixture(slug) {
  if (!isPersonaSlug(slug)) {
    throw new Error(`"${slug}" is not a valid persona slug — a slug is a lowercase name (a-z, 0-9, hyphens), never a path`);
  }
  let fixture;
  try {
    fixture = require(path.join(__dirname, `${slug}.js`));
  } catch (e) {
    throw new Error(`no persona fixture named "${slug}" could be loaded (${e.message})`);
  }
  const problems = personaFixtureProblems(fixture, slug);
  if (problems.length) {
    throw new Error(`the "${slug}" persona fixture is malformed: ${problems.join('; ')}`);
  }
  return fixture;
}

module.exports = { CARD_FIELDS, FIXTURE_FIELDS, HISTORY_MODES, personaFixtureProblems, loadPersonaFixture };
