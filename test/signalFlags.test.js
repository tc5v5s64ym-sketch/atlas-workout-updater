'use strict';

// #1343 — Emotion/adherence signal flags (Corpus V2 §F.11) golden fixtures.
//
// Pins, per §F.11 dimension: each kind fires on its evidence; the guards
// (negation, interrogative, future-plan, unrecorded sensitivity); one flag
// per dimension max; deterministic order (gap, truncation, sentiment,
// sensitivity); history-derived gap wins over a message-stated gap; routine
// turns yield [] (the route emits the empty array, the detector returns it).

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectSignalFlags } = require('../services/signalFlags');

const NO_LAYOFF = { days_since_last_session: null, returning_from_layoff: false, severity: 'none', volume_factor: 1.0, watch: null };
const LAYOFF_21D = { days_since_last_session: 21, returning_from_layoff: true, severity: 'significant', volume_factor: 0.66, watch: null };
const KNEE = [{ kind: 'injury', target: 'knee', rule: 'avoid' }];

function flags(message, extra = {}) {
  return detectSignalFlags({ message, layoff: NO_LAYOFF, constraints: [], ...extra });
}
function kinds(list) {
  return list.map((f) => f.kind);
}

// ── Gap length ──────────────────────────────────────────────────────────────

test('gap: history-derived layoff emits a gap_return flag with days + severity', () => {
  const out = flags("I'm back, what should I do today?", { layoff: LAYOFF_21D });
  assert.deepEqual(out, [
    { kind: 'gap_return', days_since_last_session: 21, severity: 'significant', source: 'history' },
  ]);
});

test('gap: no layoff and no stated gap emits nothing', () => {
  assert.deepEqual(flags("what's on the plan today?"), []);
});

test('gap: message-stated gap fires at >= 7 days, with the stated length', () => {
  assert.deepEqual(
    flags("It's been 9 days. Almost didn't message you, what's the point.").filter((f) => f.kind === 'gap_return'),
    [{ kind: 'gap_return', days_since_last_session: 9, severity: null, source: 'message' }],
  );
  const out = flags('back after three weeks off, where do I start?');
  assert.equal(out[0].kind, 'gap_return');
  assert.equal(out[0].days_since_last_session, 21);
  assert.equal(out[0].source, 'message');
});

test('gap: a stated sub-threshold gap does not fire', () => {
  assert.deepEqual(flags("It's been 3 days since my last session."), []);
});

test('gap: a future plan ("three weeks to 205") is not a gap', () => {
  assert.deepEqual(flags('Three weeks to 205 — you actually believe that or is that coach talk?'), []);
});

test('gap: history wins over a message-stated gap (one flag, history source)', () => {
  const out = flags("I'm back after three weeks off", { layoff: LAYOFF_21D });
  assert.equal(out.filter((f) => f.kind === 'gap_return').length, 1);
  assert.equal(out[0].source, 'history');
  assert.equal(out[0].days_since_last_session, 21);
});

// ── Truncation cause ────────────────────────────────────────────────────────

test('truncation: "ran out of time" carries cause time', () => {
  assert.deepEqual(flags("had to cut today's session short after two exercises, ran out of time"), [
    { kind: 'truncation', cause: 'time' },
  ]);
});

test('truncation: "tones dropped, had to bail" carries cause time', () => {
  assert.deepEqual(flags('1620. Got 4 x 500 in, tones dropped, had to bail. Annoyed.'), [
    { kind: 'truncation', cause: 'time' },
  ]);
});

test('truncation: a bare cut-short with no cause carries cause truncated', () => {
  assert.deepEqual(flags("couldn't finish the session today"), [
    { kind: 'truncation', cause: 'truncated' },
  ]);
});

test('truncation: a chosen stop carries cause deliberate', () => {
  assert.deepEqual(flags('decided to call it a day after squats, legs are done'), [
    { kind: 'truncation', cause: 'deliberate' },
  ]);
});

test('truncation: a negated cut-short never fires', () => {
  assert.deepEqual(flags("didn't have to cut it short, finished everything"), []);
});

test('truncation: a question about cutting short is a request, not a report', () => {
  assert.deepEqual(flags('should I cut today short?'), []);
});

test('truncation: a report followed by a question still fires', () => {
  const out = flags('had to cut it short — should I make it up tomorrow?');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'truncation');
});

test('truncation: a past-session report is history, not this turn\'s signal', () => {
  assert.deepEqual(flags('cut it short last week and felt great'), []);
  assert.deepEqual(flags('had to bail yesterday, tones dropped'), []);
});

test('truncation: a past clause does not suppress a today-clause report', () => {
  const out = flags('yesterday I felt great, today I had to cut it short');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'truncation');
});

// ── Sentiment cue ───────────────────────────────────────────────────────────

test('sentiment: an explicit discouragement phrase emits a sentiment flag', () => {
  const out = flags("bench is stuck, I feel like I'm going backwards");
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'sentiment_discouragement');
  assert.equal(out[0].cue, 'negative_self_talk');
});

test('sentiment: pure tiredness is not a sentiment flag', () => {
  assert.deepEqual(flags("I'm exhausted, legs are toast"), []);
});

test('sentiment: an analytical question is not a sentiment flag', () => {
  assert.deepEqual(flags('why is my bench stuck?'), []);
});

// ── Sensitivity match ───────────────────────────────────────────────────────

test('sensitivity: a turn touching a recorded injury constraint matches it', () => {
  assert.deepEqual(flags("my knee's been acting up, can we avoid deep squats today", { constraints: KNEE }), [
    { kind: 'sensitivity_match', constraint: { kind: 'injury', target: 'knee', rule: 'avoid' } },
  ]);
});

test('sensitivity: the plural of a single-word target matches too', () => {
  const out = flags('my knees are stiff today', { constraints: KNEE });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'sensitivity_match');
});

test('sensitivity: a multi-word target matches as the whole phrase', () => {
  const rows = [{ kind: 'injury', target: 'overhead pressing', rule: 'avoid' }];
  assert.equal(flags('can we skip overhead pressing today', { constraints: rows }).length, 1);
  assert.deepEqual(flags('can we skip pressing today', { constraints: rows }), []);
});

test('sensitivity: an unrecorded body part never fires', () => {
  assert.deepEqual(flags("my shoulder's been acting up", { constraints: KNEE }), []);
});

test('sensitivity: no recorded constraints means no match', () => {
  assert.deepEqual(flags("my knee's been acting up"), []);
});

test('sensitivity: a non-injury constraint never matches', () => {
  const rows = [{ kind: 'equipment', target: 'knee', rule: 'avoid' }];
  assert.deepEqual(flags("my knee's been acting up", { constraints: rows }), []);
});

test('sensitivity: a malformed constraint row never matches', () => {
  const rows = [{ kind: 'injury', target: '', rule: 'avoid' }, { kind: 'injury', target: 'knee', rule: 'ban' }];
  assert.deepEqual(flags("my knee's been acting up", { constraints: rows }), []);
});

// ── Composition ─────────────────────────────────────────────────────────────

test('composition: all four dimensions fire once each, in §F.11 order', () => {
  const out = flags("It's been 9 days and I had to bail today — bench is stuck, I feel like I'm going backwards, and my knee's been acting up", {
    layoff: LAYOFF_21D,
    constraints: KNEE,
  });
  assert.deepEqual(kinds(out), ['gap_return', 'truncation', 'sentiment_discouragement', 'sensitivity_match']);
});

test('composition: a routine turn yields []', () => {
  assert.deepEqual(flags("what's on the plan today?"), []);
  assert.deepEqual(flags(''), []);
  assert.deepEqual(detectSignalFlags(), []);
});

test('composition: totality — garbage input returns a valid array', () => {
  assert.deepEqual(detectSignalFlags({ message: null, layoff: null, constraints: null }), []);
  assert.deepEqual(detectSignalFlags({ message: 42, layoff: 'x', constraints: 'x' }), []);
});
