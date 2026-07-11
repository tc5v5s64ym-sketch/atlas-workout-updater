'use strict';

// Soul Plan PR-B5a Part 2a — DARK drift shadow (services/driftShadow.js).
//
// Pins the dark, observable production path: gated behind ATLAS_DRIFT_SHADOW
// (default OFF ⇒ ZERO Session_Plans reads), finalized-only authoritative history fed
// to the pure detectDrift, a bounded/cached read (never per-message), deload + layoff
// suppression, thin-history floor, fail-closed on read/header failure, and a
// structured diagnostic emitted to an injected observation sink. NOTHING here changes
// coach mode, copy, the LLM input, or the reply — the sink is the only output.

const test = require('node:test');
const assert = require('node:assert/strict');

const { sessionPlansColumns } = require('../config/columns');
const {
  buildPlanAcceptedEvents, buildItemOutcomeEvent, buildSessionCloseoutEvent,
} = require('../services/sessionPlanEvents');
const driftShadow = require('../services/driftShadow');

const HEADER = [...sessionPlansColumns];
const withHeader = (dataRows) => [HEADER, ...dataRows];

// Build one finalized (default) session's rows. `outcomes` maps plan_item_id →
// 'completed'|'skipped'|{outcome:'substituted', performed:'CODE'}.
function sessionRows(sid, date, items, outcomes, closeout = 'finalized') {
  const session = { session_id: sid, session_date: date, plan_version: `pv_${sid}` };
  const rows = buildPlanAcceptedEvents(session, items, { recordedAt: `${sid}-r0` });
  let n = 1;
  for (const it of items) {
    const o = outcomes[it.plan_item_id];
    if (!o) continue;
    const outcome = typeof o === 'string' ? o : o.outcome;
    const performed_lift_code = typeof o === 'object' ? o.performed : undefined;
    rows.push(buildItemOutcomeEvent(session, { ...it, outcome, performed_lift_code }, { recordedAt: `${sid}-r${n++}` }));
  }
  if (closeout) rows.push(buildSessionCloseoutEvent(session, closeout, { recordedAt: `${sid}-rz` }));
  return rows;
}

const twoItem = [
  { plan_item_id: 'i1', planned_order: 1, planned_lift_code: 'ROW01', movement_pattern: 'horizontal_pull' },
  { plan_item_id: 'i2', planned_order: 2, planned_lift_code: 'LEX01', movement_pattern: 'knee_extension' },
];
// Three finalized sessions each planning 2 lifts and completing only 1 → 50% missed
// across 3 sessions → plan_deviation (works on lift codes; skipped_pattern_streak
// cannot, since patternFor is name-based — the safe "unknown pattern" floor).
function deviationHistoryRows() {
  return [
    ...sessionRows('S1', '2026-07-01', twoItem, { i1: 'completed', i2: 'skipped' }),
    ...sessionRows('S2', '2026-07-03', twoItem, { i1: 'completed', i2: 'skipped' }),
    ...sessionRows('S3', '2026-07-05', twoItem, { i1: 'completed', i2: 'skipped' }),
  ];
}

// A capturing sink + injectable reads.
function harness({ rows, deload = null, readRangeImpl } = {}) {
  const calls = { readRange: 0, readDeload: 0 };
  const emitted = [];
  driftShadow._resetForTesting({
    readRange: readRangeImpl || (async () => { calls.readRange += 1; return withHeader(rows || []); }),
    readDeload: async () => { calls.readDeload += 1; return deload; },
    emit: (d) => emitted.push(d),
  });
  return { calls, emitted };
}

function on() { process.env.ATLAS_DRIFT_SHADOW = '1'; }
function off() { delete process.env.ATLAS_DRIFT_SHADOW; }
test.afterEach(() => { off(); driftShadow._resetForTesting({}); });

// ── buildDiagnostic (pure) ────────────────────────────────────────────────────

test('buildDiagnostic: a failed/disabled read is evaluated:false with the reason', () => {
  const d = driftShadow.buildDiagnostic({ readResult: { ok: false, reason: 'tab_missing', sessions_considered: 0 }, driftResult: null });
  assert.deepEqual(d, { evaluated: false, drifting: false, kind: null, evidence: null, sessions_considered: 0, suppressed_reason: 'tab_missing' });
});

test('buildDiagnostic: a drift hit forwards kind + shape-only evidence', () => {
  const d = driftShadow.buildDiagnostic({
    readResult: { ok: true, reason: null, sessions_considered: 3 },
    driftResult: { drifting: true, kind: 'plan_deviation', evidence: { deviation_pct: 50, sessions_checked: 3 } },
  });
  assert.equal(d.evaluated, true);
  assert.equal(d.drifting, true);
  assert.equal(d.kind, 'plan_deviation');
  assert.deepEqual(d.evidence, { deviation_pct: 50, sessions_checked: 3 });
  assert.equal(d.sessions_considered, 3);
  assert.equal(d.suppressed_reason, null);
});

test('buildDiagnostic: a suppressed detector result surfaces suppressed_reason, drifting:false, no evidence', () => {
  const d = driftShadow.buildDiagnostic({
    readResult: { ok: true, sessions_considered: 3 },
    driftResult: { drifting: false, kind: null, evidence: { suppressed: 'deload' } },
  });
  assert.equal(d.evaluated, true);
  assert.equal(d.drifting, false);
  assert.equal(d.kind, null);
  assert.equal(d.evidence, null);
  assert.equal(d.suppressed_reason, 'deload');
});

// ── gating + reads ────────────────────────────────────────────────────────────

test('flag OFF: observeDrift performs NO Session_Plans read and emits nothing (test 10)', async () => {
  off();
  const { calls, emitted } = harness({ rows: deviationHistoryRows() });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  assert.equal(calls.readRange, 0, 'no Session_Plans read when the flag is off');
  assert.equal(calls.readDeload, 0);
  assert.equal(emitted.length, 0, 'no diagnostic emitted');
});

test('read-budget: repeated chat turns share ONE cached read, never per-message (test 11)', async () => {
  on();
  const { calls, emitted } = harness({ rows: deviationHistoryRows() });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  assert.equal(calls.readRange, 1, 'the finalized history is read once per TTL window, not per message');
  assert.equal(calls.readDeload, 1, 'deload state is read once per window too');
  assert.equal(emitted.length, 3, 'every turn still emits a diagnostic (from cache)');
});

// ── dark computation semantics ────────────────────────────────────────────────

test('flag ON: plan_deviation over 3 finalized sessions is detected (dark) and emitted', async () => {
  on();
  const { emitted } = harness({ rows: deviationHistoryRows() });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  assert.equal(emitted.length, 1);
  const d = emitted[0];
  assert.equal(d.evaluated, true);
  assert.equal(d.drifting, true);
  assert.equal(d.kind, 'plan_deviation');
  assert.equal(d.sessions_considered, 3);
  assert.equal(d.suppressed_reason, null);
});

test('fewer than 3 finalized sessions never fire plan-history drift (thin-history floor, test 6)', async () => {
  on();
  const rows = [
    ...sessionRows('S1', '2026-07-01', twoItem, { i1: 'completed', i2: 'skipped' }),
    ...sessionRows('S2', '2026-07-03', twoItem, { i1: 'completed', i2: 'skipped' }),
  ];
  const { emitted } = harness({ rows });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  const d = emitted[0];
  assert.equal(d.evaluated, true);
  assert.equal(d.drifting, false, 'thin history never fires');
  assert.equal(d.kind, null);
  assert.equal(d.sessions_considered, 2);
});

test('an active deload suppresses drift (test 7)', async () => {
  on();
  const { emitted } = harness({ rows: deviationHistoryRows(), deload: { training_state: 'DELOAD' } });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  const d = emitted[0];
  assert.equal(d.drifting, false);
  assert.equal(d.suppressed_reason, 'deload');
});

test('a real layoff (>=7 days) suppresses drift (test 8)', async () => {
  on();
  const { emitted } = harness({ rows: deviationHistoryRows() });
  // logRows with a last session date well before asOf → layoff guard fires first.
  await driftShadow.observeDrift({ logRows: [['2026-06-01', 'OLD', 'Bench Press']], memoryPatterns: [], asOf: '2026-07-06' });
  const d = emitted[0];
  assert.equal(d.drifting, false);
  assert.equal(d.suppressed_reason, 'layoff');
});

test('abandoned + open sessions are excluded from the finalized history the detector sees', async () => {
  on();
  const rows = [
    ...deviationHistoryRows(),
    ...sessionRows('AB', '2026-07-06', twoItem, { i1: 'skipped', i2: 'skipped' }, 'abandoned'),
    ...sessionRows('OP', '2026-07-07', twoItem, { i1: 'completed' }, null), // open (no closeout)
  ];
  const { emitted } = harness({ rows });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-08' });
  assert.equal(emitted[0].sessions_considered, 3, 'only the 3 finalized sessions are considered');
});

test('identical replay rows deduplicate — sessions_considered is stable (test 3)', async () => {
  on();
  const base = deviationHistoryRows();
  const { emitted } = harness({ rows: [...base, ...base] }); // exact duplicates collapse
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  assert.equal(emitted[0].sessions_considered, 3, 'replayed rows do not inflate the session count');
  assert.equal(emitted[0].drifting, true);
});

test('malformed/conflicting rows fail closed and are excluded (test 4)', async () => {
  on();
  const good = deviationHistoryRows();
  // A truncated plan_accepted row for a NEW session → that session is status:error → dropped.
  const errRow = buildPlanAcceptedEvents({ session_id: 'ERR', session_date: '2026-07-05', plan_version: 'pv_ERR' }, [twoItem[0]], { recordedAt: 'e0' })[0].slice(0, 5);
  const { emitted } = harness({ rows: [...good, errRow] });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  assert.equal(emitted[0].sessions_considered, 3, 'the error session is excluded, not counted');
});

// ── fail-closed reads (never surface) ─────────────────────────────────────────

test('a read failure produces evaluated:false and never throws (test 9)', async () => {
  on();
  const { emitted } = harness({ readRangeImpl: async () => { throw new Error('Sheets 500'); } });
  await assert.doesNotReject(driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' }));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].evaluated, false);
  assert.equal(emitted[0].drifting, false);
  assert.equal(emitted[0].suppressed_reason, 'read_error');
});

test('a header mismatch fails closed (evaluated:false, no fabricated drift)', async () => {
  on();
  const rows = deviationHistoryRows();
  const { emitted } = harness({ readRangeImpl: async () => [['wrong', 'header'], ...rows] });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  assert.equal(emitted[0].evaluated, false);
  assert.equal(emitted[0].suppressed_reason, 'header_mismatch');
});

test('a missing tab (empty read) fails closed as tab_missing', async () => {
  on();
  const { emitted } = harness({ readRangeImpl: async () => [] });
  await driftShadow.observeDrift({ logRows: [], memoryPatterns: [], asOf: '2026-07-06' });
  assert.equal(emitted[0].evaluated, false);
  assert.equal(emitted[0].suppressed_reason, 'tab_missing');
});

test('totality: observeDrift never throws on garbage inputs', async () => {
  on();
  harness({ rows: deviationHistoryRows() });
  for (const bad of [undefined, {}, { logRows: 42, memoryPatterns: 'x', asOf: 7 }]) {
    await assert.doesNotReject(driftShadow.observeDrift(bad));
  }
});
