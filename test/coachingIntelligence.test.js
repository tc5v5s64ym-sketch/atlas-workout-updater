'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const COACHING_DIR = path.join(__dirname, '..', 'config', 'coaching');
const EXERCISES_DIR = path.join(COACHING_DIR, 'exercises');
const RULES_DIR = path.join(COACHING_DIR, 'rules');

const EXERCISE_IDS = [
  'back-squat', 'front-squat', 'goblet-squat', 'leg-press', 'hack-squat', 'box-squat', 'belt-squat',
  'conventional-deadlift', 'romanian-deadlift', 'sumo-deadlift', 'trap-bar-deadlift', 'hip-thrust',
  'good-morning', 'kettlebell-swing',
  'bulgarian-split-squat', 'walking-lunge', 'reverse-lunge', 'step-up', 'lateral-lunge',
  'bench-press', 'dumbbell-bench-press', 'incline-bench-press', 'push-up', 'dip', 'cable-chest-fly',
  'overhead-press', 'seated-dumbbell-shoulder-press', 'push-press', 'lateral-raise',
  'barbell-row', 'dumbbell-row', 'cable-row', 'face-pull', 'inverted-row',
  'pull-up', 'lat-pulldown', 'chin-up', 'cable-pull-over',
  'farmers-carry', 'suitcase-carry',
  'pallof-press', 'plank',
  'cable-woodchop',
  'bicep-curl', 'hammer-curl', 'tricep-pushdown', 'skull-crusher',
  'leg-curl', 'leg-extension', 'calf-raise', 'rear-delt-fly', 'preacher-curl'
];

const EXERCISE_REQUIRED = ['id', 'name', 'movement_pattern', 'implement', 'primary_muscles', 'provenance'];
const PROVENANCE_REQUIRED = ['sources', 'evidence_tier', 'confidence', 'contested'];
const VALID_MOVEMENT_PATTERNS = new Set([
  'squat','hinge','horizontal_push','vertical_push','horizontal_pull','vertical_pull',
  'lunge','carry','rotation','anti_rotation','isolation','locomotion'
]);
const VALID_IMPLEMENTS = new Set(['barbell','dumbbell','machine','cable','kettlebell','bodyweight','band']);
const VALID_CONFIDENCE = new Set(['high','medium','low']);

const RULE_FILES = ['progression.rules.json', 'fatigue.rules.json', 'safety.rules.json'];
const META_REQUIRED = ['status', 'behavior', 'purpose', 'derived_from'];

test('exercise files: required fields present', () => {
  for (const id of EXERCISE_IDS) {
    const data = require(path.join(EXERCISES_DIR, `${id}.json`));
    for (const field of EXERCISE_REQUIRED) {
      assert.ok(field in data, `${id}.json missing required field: ${field}`);
    }
    assert.strictEqual(data.id, id, `${id}.json id field must match filename`);
    assert.ok(Array.isArray(data.primary_muscles), `${id}.json primary_muscles must be an array`);
    assert.ok(data.primary_muscles.length > 0, `${id}.json primary_muscles must not be empty`);
  }
});

test('exercise files: movement_pattern values are valid enum', () => {
  for (const id of EXERCISE_IDS) {
    const data = require(path.join(EXERCISES_DIR, `${id}.json`));
    assert.ok(
      VALID_MOVEMENT_PATTERNS.has(data.movement_pattern),
      `${id}.json movement_pattern '${data.movement_pattern}' is not a valid enum value`
    );
  }
});

test('exercise files: implement values are valid enum', () => {
  for (const id of EXERCISE_IDS) {
    const data = require(path.join(EXERCISES_DIR, `${id}.json`));
    assert.ok(
      VALID_IMPLEMENTS.has(data.implement),
      `${id}.json implement '${data.implement}' is not a valid enum value`
    );
  }
});

test('exercise files: provenance block has required fields and valid values', () => {
  for (const id of EXERCISE_IDS) {
    const { provenance } = require(path.join(EXERCISES_DIR, `${id}.json`));
    for (const field of PROVENANCE_REQUIRED) {
      assert.ok(field in provenance, `${id}.json provenance missing: ${field}`);
    }
    assert.ok(Array.isArray(provenance.sources), `${id}.json provenance.sources must be an array`);
    assert.ok(provenance.sources.length > 0, `${id}.json provenance.sources must not be empty`);
    assert.ok(
      Number.isInteger(provenance.evidence_tier) && provenance.evidence_tier >= 1 && provenance.evidence_tier <= 5,
      `${id}.json provenance.evidence_tier must be integer 1-5`
    );
    assert.ok(
      VALID_CONFIDENCE.has(provenance.confidence),
      `${id}.json provenance.confidence must be high/medium/low`
    );
    assert.ok(
      typeof provenance.contested === 'boolean',
      `${id}.json provenance.contested must be boolean`
    );
  }
});

test('exercise _index.json lists all seeded exercise IDs', () => {
  const index = require(path.join(EXERCISES_DIR, '_index.json'));
  assert.ok(Array.isArray(index.exercises), '_index.json exercises must be an array');
  const indexedIds = new Set(index.exercises.map(e => e.id));
  for (const id of EXERCISE_IDS) {
    assert.ok(indexedIds.has(id), `_index.json is missing exercise id: ${id}`);
  }
});

test('exercise _index.json: every indexed id has a corresponding file', () => {
  const index = require(path.join(EXERCISES_DIR, '_index.json'));
  const fs = require('node:fs');
  for (const entry of index.exercises) {
    const filePath = path.join(EXERCISES_DIR, entry.file);
    assert.ok(fs.existsSync(filePath), `_index.json references file that does not exist: ${entry.file}`);
    assert.strictEqual(entry.id, path.basename(entry.file, '.json'), `_index.json entry id '${entry.id}' does not match filename '${entry.file}'`);
  }
});

test('rule files: _meta block has required fields', () => {
  for (const filename of RULE_FILES) {
    const data = require(path.join(RULES_DIR, filename));
    assert.ok('_meta' in data, `${filename} missing _meta block`);
    for (const field of META_REQUIRED) {
      assert.ok(field in data._meta, `${filename} _meta missing: ${field}`);
    }
    assert.ok(Array.isArray(data._meta.derived_from), `${filename} _meta.derived_from must be an array`);
    assert.ok(data._meta.derived_from.length > 0, `${filename} _meta.derived_from must not be empty`);
  }
});

test('progression rules: decision_table entries have required fields', () => {
  const { decision_table } = require(path.join(RULES_DIR, 'progression.rules.json'));
  assert.ok(Array.isArray(decision_table), 'progression.rules.json decision_table must be an array');
  assert.ok(decision_table.length > 0, 'progression.rules.json decision_table must not be empty');
  for (const entry of decision_table) {
    assert.ok('id' in entry, `decision_table entry missing id: ${JSON.stringify(entry).slice(0, 60)}`);
    assert.ok('when' in entry, `decision_table entry '${entry.id}' missing when`);
    assert.ok('interpretation' in entry, `decision_table entry '${entry.id}' missing interpretation`);
    assert.ok('default_action' in entry, `decision_table entry '${entry.id}' missing default_action`);
  }
});

test('safety rules: traffic_light has green/yellow/red states', () => {
  const { traffic_light } = require(path.join(RULES_DIR, 'safety.rules.json'));
  assert.ok(Array.isArray(traffic_light), 'safety.rules.json traffic_light must be an array');
  const states = new Set(traffic_light.map(t => t.state));
  assert.ok(states.has('green'), 'safety.rules.json traffic_light missing green state');
  assert.ok(states.has('yellow'), 'safety.rules.json traffic_light missing yellow state');
  assert.ok(states.has('red'), 'safety.rules.json traffic_light missing red state');
  for (const entry of traffic_light) {
    assert.ok(Array.isArray(entry.signals), `traffic_light '${entry.state}' signals must be an array`);
    assert.ok('action' in entry, `traffic_light '${entry.state}' missing action`);
  }
});
