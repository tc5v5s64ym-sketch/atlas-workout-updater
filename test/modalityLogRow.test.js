'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeModalityRecord, toModalityLogRow, elapsedToSec } = require('../services/modalityLogRow');
const { recognizeModalityInput } = require('../services/multiModalityParser');
const { modalityLogColumns } = require('../config/columns');

// ---------------------------------------------------------------------------
// PR 486 slice 4b — reconcile recognizer output → Modality_Log columns.
// The recognizer emits per-modality field names in MIXED units (min/km/work_sec/
// work_distance_m/elapsed/sets); this module normalizes to duration_sec/distance_m/
// rounds so a write never persists the wrong unit. Pure.
// ---------------------------------------------------------------------------

test('elapsedToSec parses mm:ss and h:mm:ss; rejects junk', () => {
  assert.equal(elapsedToSec('32:10'), 1930);
  assert.equal(elapsedToSec('1:00:00'), 3600);
  assert.equal(elapsedToSec('0:45'), 45);
  assert.equal(elapsedToSec('nope'), null);
  assert.equal(elapsedToSec('1:2:3:4'), null);
});

test('timed_hold: duration_sec preserved, sets → rounds', () => {
  const r = recognizeModalityInput('Plank 60 sec x3 RPE 7');
  const n = normalizeModalityRecord(r);
  assert.equal(n.modality, 'timed_hold');
  assert.equal(n.duration_sec, 60);
  assert.equal(n.rounds, 3); // sets → rounds
  assert.equal(n.rpe, 7);
});

test('cardio_steady: km → m, duration_min → sec (or elapsed fallback), elapsed noted', () => {
  const n = normalizeModalityRecord(recognizeModalityInput('Run 5 km 32:10 RPE 7 avg HR 151'));
  assert.equal(n.modality, 'cardio_steady');
  assert.equal(n.distance_m, 5000);      // km → m
  assert.equal(n.duration_sec, 1930);    // 32:10 elapsed → sec (no explicit minutes)
  assert.equal(n.avg_hr, 151);
  assert.equal(n.notes_extra, 'elapsed 32:10');

  const mins = normalizeModalityRecord(recognizeModalityInput('Elliptical 30 min RPE 6 avg HR 142'));
  assert.equal(mins.duration_sec, 1800); // 30 min → sec
  assert.equal(mins.distance_m, null);
});

test('cardio_interval: rounds, work_sec → duration_sec, work_distance_m → distance_m, rest_sec', () => {
  const dist = normalizeModalityRecord(recognizeModalityInput('8 x 400m / 90 sec RPE 8'));
  assert.equal(dist.modality, 'cardio_interval');
  assert.equal(dist.rounds, 8);
  assert.equal(dist.distance_m, 400);
  assert.equal(dist.duration_sec, null); // distance-based interval
  assert.equal(dist.rest_sec, 90);

  const timed = normalizeModalityRecord(recognizeModalityInput('6 x 2 min / 60 sec'));
  assert.equal(timed.duration_sec, 120); // work_sec (2 min recognized → 120s)
  assert.equal(timed.distance_m, null);
  assert.equal(timed.rest_sec, 60);
});

test('circuit: kind → exercise label, cap_min → duration_sec, movements → notes_extra', () => {
  const n = normalizeModalityRecord(recognizeModalityInput('AMRAP 12 min: pushups 10, air squats 15 - 6 rounds RPE 8'));
  assert.equal(n.modality, 'circuit');
  assert.equal(n.exercise, 'AMRAP');
  assert.equal(n.duration_sec, 720); // 12 min cap → sec
  assert.equal(n.rounds, 6);
  assert.equal(n.notes_extra, 'pushups 10; air squats 15');
});

test('toModalityLogRow emits a row in the exact column order, merging notes', () => {
  const r = recognizeModalityInput('Run 5 km 32:10 RPE 7 avg HR 151');
  const row = toModalityLogRow(r, { date: '2026-06-23', session_id: 'S1', notes: 'easy zone 2' });
  assert.equal(row.length, modalityLogColumns.length);
  assert.deepEqual(row, ['2026-06-23', 'S1', 'cardio_steady', 'Run', 1930, 5000, '', '', '', 7, 151, 'easy zone 2 | elapsed 32:10']);
});

test('toModalityLogRow blanks absent metrics (never undefined/null cells)', () => {
  const row = toModalityLogRow(recognizeModalityInput('Wall Sit 2 min'), { date: '2026-06-23', session_id: 'S1' });
  // Wall Sit 2 min → timed_hold, duration 120s, rounds default 1, no rpe.
  assert.deepEqual(row, ['2026-06-23', 'S1', 'timed_hold', 'Wall Sit', 120, '', 1, '', '', '', '', '']);
  for (const cell of row) assert.ok(cell !== null && cell !== undefined);
});

test('normalize/toRow return null for a non-record / unknown modality', () => {
  assert.equal(normalizeModalityRecord(null), null);
  assert.equal(normalizeModalityRecord({ modality: 'bogus' }), null);
  assert.equal(toModalityLogRow(null, {}), null);
});

test('notes are capped at 200 chars', () => {
  const r = recognizeModalityInput('Run 5 km 30:00');
  const row = toModalityLogRow(r, { date: '2026-06-23', session_id: 'S1', notes: 'x'.repeat(500) });
  const notes = row[modalityLogColumns.indexOf('notes')];
  assert.ok(notes.length <= 200);
});
