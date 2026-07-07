'use strict';

// Exercise Knowledge Base — resolver + catalog/alias validation.
//
// Proves the recognition pipeline (normalize → strip set-notation → alias lookup →
// canonical exercise_id) resolves real user text, that ambiguous bare tokens do NOT
// silently map to a wrong exercise, and that the committed KB data is schema-valid,
// deduplicated, and within the seed-size targets. Reference-only: no write path.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { validateKb } = require('../services/exerciseKbSchema');
const { resolveExercise, extractExerciseLead, allExercises, allAliases } = require('../services/exerciseResolver');

const repoRoot = path.join(__dirname, '..');
const catalog = require('../data/exercise_catalog.v1.json');
const aliases = require('../data/exercise_aliases.v1.json');

// ── KB data integrity ─────────────────────────────────────────────────────────

test('exercise KB validates against the schema (enums, dedup, coverage)', () => {
  const r = validateKb({ catalog, aliases });
  assert.ok(r.ok, 'KB must be schema-valid:\n' + r.errors.slice(0, 20).join('\n'));
});

test('exercise KB meets the seed-size targets (>=250 canonical, >=1000 aliases)', () => {
  assert.ok(catalog.length >= 250, `catalog has ${catalog.length} (<250)`);
  assert.ok(aliases.length >= 1000, `aliases has ${aliases.length} (<1000)`);
});

test('every canonical name resolves to its own record (no alias shadows a name)', () => {
  const mis = [];
  for (const rec of catalog) {
    const r = resolveExercise(rec.name);
    if (!r || r.exercise_id !== rec.exercise_id) mis.push(`${rec.exercise_id} ("${rec.name}") → ${r && r.exercise_id}`);
  }
  assert.equal(mis.length, 0, 'canonical names must self-resolve:\n' + mis.slice(0, 20).join('\n'));
});

test('exercise_id is stable lower snake_case and unique (distinct from lift_code)', () => {
  const ids = new Set();
  for (const rec of catalog) {
    assert.match(rec.exercise_id, /^[a-z0-9]+(?:_[a-z0-9]+)*$/, `bad id ${rec.exercise_id}`);
    assert.ok(!ids.has(rec.exercise_id), `dup id ${rec.exercise_id}`);
    ids.add(rec.exercise_id);
  }
});

// ── Acceptance resolutions (owner spec) ───────────────────────────────────────

test('acceptance: "Cable Fly 30 12/0" resolves to a known canonical exercise', () => {
  const r = resolveExercise('Cable Fly 30 12/0');
  assert.ok(r, 'must resolve');
  assert.equal(r.exercise_id, 'cable_fly');
  assert.equal(extractExerciseLead('Cable Fly 30 12/0'), 'Cable Fly');
});

test('acceptance: cable fly alias coverage all resolves to cable_fly', () => {
  for (const a of ['cable fly', 'cable flys', 'cable flyes', 'cable chest fly', 'cable pec fly',
    'cable crossover', 'standing cable fly', 'low cable fly', 'high cable fly']) {
    const r = resolveExercise(a);
    assert.ok(r && r.exercise_id === 'cable_fly', `"${a}" → ${r && r.exercise_id}`);
  }
});

test('acceptance: "bb row" resolves to Bent-Over Row', () => {
  const r = resolveExercise('bb row');
  assert.ok(r && r.exercise_id === 'barbell_bent_over_row');
  // Canonical name reconciled to the parser/history convention in PR-06
  // (exercise_id is unchanged; only the user-facing name aligned to "Bent-Over Row").
  assert.equal(r.name, 'Bent-Over Row');
});

test('acceptance: barbell row alias coverage resolves', () => {
  for (const a of ['barbell row', 'bb row', 'bent row', 'bent over row', 'bent-over row', 'bor']) {
    const r = resolveExercise(a);
    assert.ok(r && r.exercise_id === 'barbell_bent_over_row', `"${a}" → ${r && r.exercise_id}`);
  }
});

test('acceptance: "lat pull" resolves to Lat Pulldown', () => {
  const r = resolveExercise('lat pull');
  assert.ok(r && r.exercise_id === 'lat_pulldown');
  assert.equal(r.name, 'Lat Pulldown');
});

test('acceptance: "RDL" resolves to Romanian Deadlift', () => {
  const r = resolveExercise('RDL');
  assert.ok(r && r.exercise_id === 'romanian_deadlift');
  assert.equal(r.name, 'Romanian Deadlift');
});

test('acceptance: "OHP" resolves to Overhead Press', () => {
  const r = resolveExercise('OHP');
  assert.ok(r && r.exercise_id === 'overhead_press');
  assert.equal(r.name, 'Overhead Press');
});

// ── Ambiguity safety ──────────────────────────────────────────────────────────

test('acceptance: ambiguous bare tokens do NOT silently map to an exercise', () => {
  // These bare words name a movement class, not a lift — they carry no alias entry
  // at all, so the resolver returns null and the caller must ask which lift.
  for (const a of ['press', 'row', 'curl', 'fly', 'raise', 'extension', 'pulldown ']) {
    const r = resolveExercise(a);
    if (a.trim() === 'pulldown') continue; // handled by the low-confidence test below
    assert.equal(r, null, `bare "${a.trim()}" must require clarification, got ${r && r.exercise_id}`);
  }
});

test('low-confidence aliases resolve to the commonest lift but are flagged for confirmation', () => {
  // A few shorthands (e.g. "pulldown" → lat pulldown, "pushdown" → triceps
  // pushdown) map to the commonest meaning at confidence < threshold, so the
  // caller can confirm rather than commit coaching logic blindly.
  for (const [text, id] of [['pulldown', 'lat_pulldown'], ['pushdown', 'triceps_pushdown']]) {
    const r = resolveExercise(text);
    assert.ok(r && r.exercise_id === id, `"${text}" → ${r && r.exercise_id}`);
    assert.equal(r.confident, false, `"${text}" must not be treated as confident`);
  }
});

test('unknown text resolves to null (never a guess)', () => {
  assert.equal(resolveExercise('qwerty zzz nonsense'), null);
  assert.equal(resolveExercise(''), null);
});

// ── Reference-only / purity guard (no write path) ─────────────────────────────

test('resolver + schema are read-only (no sheets / parser / write / network)', () => {
  for (const f of ['exerciseResolver.js', 'exerciseKbSchema.js']) {
    const src = fs.readFileSync(path.join(repoRoot, 'services', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"]\.\/sheets/, `${f} must not touch the sheets client`);
    assert.doesNotMatch(src, /appendRows|getSheetRows|completeWrite|beginWrite|fetch\(/, `${f}: no write/IO`);
    assert.doesNotMatch(src, /workoutTextParser/, `${f}: must not change the parser`);
  }
});

test('resolver exposes the full catalog and alias set', () => {
  assert.equal(allExercises().length, catalog.length);
  assert.equal(allAliases().length, aliases.length);
});
