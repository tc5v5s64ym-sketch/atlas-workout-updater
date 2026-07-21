'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  parseShadowLines,
  analyzeDivergences,
  formatReport,
  EXPECTED_ABSENT_STAGES,
} = require('../services/coachTurnDivergence');

// A realistic shadow record (as coachTurnPacketShadow.observe emits it).
function rec(over = {}) {
  return {
    turn_id: 'turn:2026-07-21T12:00:00.000Z_1_aaa',
    packet_valid: true,
    packet_errors: [],
    embedded: { athlete: true, athlete_profile_goal: true, session: false, exercises: 0, decision: false, safety: false, closeout: false },
    visible: { message_present: false, message_len: 0, source: 'gemini', configured: true, note_tier: null, kind: 'set', error_present: false },
    trace: {
      valid: true,
      stages: ['intent', 'session_snapshot', 'engine_decision', 'coaching_strategy', 'model_response', 'validator_result', 'rendered_output'].map((s) => ({ stage: s, status: 'ok' })),
      missing: ['parser', 'knowledge_retrieval', 'write_proof'],
    },
    ...over,
  };
}

function line(record, { prefix = '' } = {}) {
  return `${prefix}[coach-turn-shadow] ${JSON.stringify(record)}`;
}

describe('coachTurnDivergence — parseShadowLines', () => {
  it('parses prefixed shadow lines and skips everything else', () => {
    const text = [
      '2026-07-21T12:00:01Z app[web.1]: ' + line(rec()),          // Render-style timestamp prefix
      line(rec({ turn_id: 'turn:x_2_b' })),
      'some unrelated log line',
      '[interaction-trace] {"turn_id":"turn:x_3_c"}',             // a different marker — ignored
      '[coach-turn-shadow] {not valid json',                       // malformed — skipped, not fatal
    ].join('\n');
    const records = parseShadowLines(text);
    assert.equal(records.length, 2, 'only the two well-formed [coach-turn-shadow] lines parse');
    assert.equal(records[1].turn_id, 'turn:x_2_b');
  });

  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(parseShadowLines(''), []);
    assert.deepEqual(parseShadowLines(null), []);
  });
});

describe('coachTurnDivergence — analyzeDivergences', () => {
  it('counts embedded bypasses, stage bypasses, and the visible↔packet contradiction', () => {
    const records = [
      rec(),
      rec({ turn_id: 't2' }),
      // a turn whose reply carried coaching prose while the packet decision was null
      rec({ turn_id: 't3', visible: { message_present: true, message_len: 20, source: 'gemini', configured: true, note_tier: null, kind: 'set', error_present: false } }),
    ];
    const a = analyzeDivergences(records);
    assert.equal(a.total, 3);
    assert.equal(a.packets_valid, 3);
    assert.equal(a.packets_invalid, 0);
    // Every turn bypassed decision/session/safety and had no ExerciseIdentity.
    assert.equal(a.embedded_bypass.decision, 3);
    assert.equal(a.embedded_bypass.session, 3);
    assert.equal(a.embedded_bypass.safety, 3);
    assert.equal(a.embedded_bypass.exercises, 3);
    assert.equal(a.embedded_bypass.athlete_profile_goal, 0, 'profile goal was populated on all');
    // knowledge_retrieval is a genuine bypass; parser/write_proof are structural and excluded.
    assert.equal(a.stage_bypass.knowledge_retrieval, 3);
    for (const s of EXPECTED_ABSENT_STAGES) assert.equal(a.stage_bypass[s], undefined, `${s} must not be counted as a bypass`);
    // full spine on all; the H-03 headline fired once.
    assert.equal(a.full_spine_turns, 3);
    assert.equal(a.visible_null_decision, 1);
  });

  it('flags an invalid packet and a core-stage spine gap', () => {
    const bad = rec({
      turn_id: 'bad',
      packet_valid: false,
      packet_errors: ['turn_id: must be a non-empty string'],
      trace: { valid: true, stages: [{ stage: 'intent', status: 'ok' }, { stage: 'rendered_output', status: 'ok' }], missing: ['parser', 'session_snapshot', 'engine_decision', 'coaching_strategy', 'model_response', 'validator_result', 'knowledge_retrieval', 'write_proof'] },
    });
    const a = analyzeDivergences([rec(), bad]);
    assert.equal(a.packets_invalid, 1);
    assert.equal(a.invalid_examples[0].turn_id, 'bad');
    // the bad turn is missing several core stages
    assert.equal(a.full_spine_turns, 1);
    assert.ok(a.spine_gap.session_snapshot >= 1);
    assert.ok(a.spine_gap.coaching_strategy >= 1);
  });

  it('handles zero records', () => {
    const a = analyzeDivergences([]);
    assert.equal(a.total, 0);
    assert.equal(a.packets_valid, 0);
  });
});

describe('coachTurnDivergence — formatReport', () => {
  it('renders the key sections for a normal (sparse-packet) run', () => {
    const a = analyzeDivergences([rec(), rec({ turn_id: 't2' })]);
    const out = formatReport(a, { source: 'render.log' });
    assert.match(out, /coach-turn divergence report \(from render\.log\)/);
    assert.match(out, /2 coach turn\(s\)/);
    assert.match(out, /schema-valid/);
    assert.match(out, /Bypassed packet truth/);
    assert.match(out, /decision/);
    assert.match(out, /H-03/);
    assert.match(out, /Phase-4 TODO/);
  });

  it('renders a clear message when there are no records (never a false green)', () => {
    const out = formatReport(analyzeDivergences([]), {});
    assert.match(out, /No \[coach-turn-shadow\] records found/);
  });
});

describe('atlas-divergence CLI', () => {
  const SCRIPT = path.join(__dirname, '..', 'scripts', 'atlas-divergence.js');

  it('reads a log file and prints the human report', () => {
    const tmp = path.join(os.tmpdir(), `atlas-div-${process.pid}.log`);
    fs.writeFileSync(tmp, [line(rec()), 'noise', line(rec({ turn_id: 't2' }))].join('\n'));
    try {
      const out = execFileSync('node', [SCRIPT, tmp], { encoding: 'utf8' });
      assert.match(out, /2 coach turn\(s\)/);
      assert.match(out, /Bypassed packet truth/);
    } finally { fs.unlinkSync(tmp); }
  });

  it('supports --json machine output', () => {
    const tmp = path.join(os.tmpdir(), `atlas-div-json-${process.pid}.log`);
    fs.writeFileSync(tmp, line(rec()));
    try {
      const out = execFileSync('node', [SCRIPT, tmp, '--json'], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      assert.equal(parsed.total, 1);
      assert.equal(parsed.embedded_bypass.decision, 1);
      assert.equal(parsed.source, tmp);
    } finally { fs.unlinkSync(tmp); }
  });
});
