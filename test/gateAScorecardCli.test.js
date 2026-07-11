'use strict';

// PR-GATEA2 — the read-only scorecard CLI core. Proves it reads exactly one tab,
// writes nothing, requires explicit prod/sandbox selection, and fails closed on an
// env mismatch or a missing provenance header.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runGateAScorecard, splitHeader, parseArgs, SHADOW_TAB } = require('../scripts/gate-a-scorecard');
const { BRAIN_SHADOW_HEADER } = require('../services/gateAScorecard');

const HEADER = BRAIN_SHADOW_HEADER.slice();
function dataRow(o = {}) {
  return [
    o.at ?? '2026-08-01T10:00:00.000Z', '/api/recommend/next', o.lift ?? 'BENCH', 'hybrid',
    'TRUE', '', 'progression', 'answered', 'high', '[]', 'TRUE', 'FALSE', 0, 0, 5, 'v129',
    o.cls ?? 'athlete_ui', o.elig ?? 'TRUE', o.origin ?? 'athlete_ui',
  ];
}
// Placeholder only — the real production workbook ID is never committed (it lives
// in the GOOGLE_SHEETS_ID env var). The test reads config.id/isSandboxSheet, never a
// live ID, so an obvious placeholder mirrors the SANDBOX fixture convention.
const PROD = { id: 'prod-sheet-id', isSandboxSheet: false };
const SANDBOX = { id: 'sandbox-sheet-id', isSandboxSheet: true };

test('runs read-only: reads exactly one tab, writes nothing, scores eligible rows', async () => {
  const calls = [];
  const getRows = async (tab) => { calls.push(tab); return [HEADER, dataRow(), dataRow({ cls: 'synthetic', elig: 'FALSE', origin: 'smoke' })]; };
  const out = await runGateAScorecard({ getRows, env: 'production', config: PROD, asOf: '2026-09-01T00:00:00Z' });
  assert.deepEqual(calls, [SHADOW_TAB], 'reads only the Brain_Shadow tab, exactly once');
  assert.equal(out.scorecard.eligible.total, 1);
  assert.equal(out.scorecard.excluded.total, 1);
  assert.equal(out.meta.env, 'production');
  assert.equal(out.meta.workbook_id, PROD.id);
  assert.match(out.markdown, /GATE A/);
});

test('requires explicit --env; rejects anything else', async () => {
  const getRows = async () => [HEADER, dataRow()];
  await assert.rejects(() => runGateAScorecard({ getRows, env: undefined, config: PROD }), /explicit selection is required|--env/);
  await assert.rejects(() => runGateAScorecard({ getRows, env: 'prod', config: PROD }), /--env/);
});

test('fails closed on an env/workbook MISMATCH (never reads the wrong workbook)', async () => {
  const getRows = async () => [HEADER, dataRow()];
  // asked for production but the resolved workbook is the sandbox
  await assert.rejects(() => runGateAScorecard({ getRows, env: 'production', config: SANDBOX }), /resolved workbook is sandbox|wrong workbook/i);
  // asked for sandbox but the resolved workbook is production
  await assert.rejects(() => runGateAScorecard({ getRows, env: 'sandbox', config: PROD }), /resolved workbook is production|wrong workbook/i);
});

test('fails closed when the tab has no provenance header (pre-GATEA1 tab)', async () => {
  const getRows = async () => [dataRow(), dataRow()]; // no header row
  await assert.rejects(() => runGateAScorecard({ getRows, env: 'production', config: PROD }), /no provenance header|evidence_class/i);
});

test('flags stale pre-provenance rows in the active tab (window not reset)', async () => {
  const getRows = async () => [HEADER, dataRow(), dataRow().slice(0, 16)]; // one 16-col legacy row
  const out = await runGateAScorecard({ getRows, env: 'production', config: PROD });
  assert.ok(out.meta.stale_pre_provenance_rows >= 1, 'legacy rows surfaced');
  assert.equal(out.scorecard.eligible.total, 1, 'the legacy row is never counted');
});

test('output leaks no secrets', async () => {
  const getRows = async () => [HEADER, dataRow()];
  const out = await runGateAScorecard({ getRows, env: 'production', config: PROD });
  const blob = out.markdown + JSON.stringify(out.scorecard) + JSON.stringify(out.meta);
  assert.ok(!/x-atlas-api-key|GOOGLE_PRIVATE_KEY|BEGIN PRIVATE KEY|ATLAS_API_KEY/i.test(blob));
});

test('parseArgs + splitHeader helpers', () => {
  assert.deepEqual(parseArgs(['--env=production', '--out=x.md', '--flag']), { env: 'production', out: 'x.md', flag: true });
  assert.throws(() => splitHeader([dataRow()]), /no provenance header/i);
  const { header, dataRows } = splitHeader([HEADER, dataRow()]);
  assert.equal(header[16], 'evidence_class');
  assert.equal(dataRows.length, 1);
});
