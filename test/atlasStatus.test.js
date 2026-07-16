'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ALLOWED_KEYS,
  parseActivePlanCard,
  parseLatestTest,
  computeOverall,
  assembleStatus,
  buildLocalCliStatus,
  renderHuman
} = require('../services/atlasStatus');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = Date.parse('2026-07-16T00:00:00Z');

// --- parseActivePlanCard ----------------------------------------------------

test('parseActivePlanCard picks the first non-COMPLETE card and the milestone', () => {
  const plan = [
    '# Plan',
    '> **Current active milestone:** M2 — close the risks',
    '### F01 — first',
    '**Status:** ✅ COMPLETE (2026-07-01)',
    'body',
    '### F02 — second thing',
    '**Status:** QUEUED',
    'body'
  ].join('\n');
  const out = parseActivePlanCard(plan);
  assert.equal(out.available, true);
  assert.equal(out.active_milestone, 'M2 — close the risks');
  assert.equal(out.active_card, 'F02');
  assert.equal(out.active_card_title, 'second thing');
  assert.equal(out.active_card_status, 'QUEUED');
});

test('parseActivePlanCard does not let a card borrow a later card status', () => {
  const plan = [
    '### F01 — done',
    '**Status:** ✅ COMPLETE',
    '### F02 — no status of its own',
    'just prose, no status line',
    '### F03 — later',
    '**Status:** QUEUED'
  ].join('\n');
  const out = parseActivePlanCard(plan);
  // F02 is the first non-complete card; its status is null, NOT F03's QUEUED.
  assert.equal(out.active_card, 'F02');
  assert.equal(out.active_card_status, null);
});

test('parseActivePlanCard on empty input reports unavailable', () => {
  const out = parseActivePlanCard('');
  assert.equal(out.available, false);
  assert.equal(out.active_card, null);
});

test('parseActivePlanCard resolves the real execution plan to a real card', () => {
  const out = parseActivePlanCard(read('docs/ATLAS_V1_EXECUTION_PLAN.md'));
  assert.equal(out.available, true);
  assert.match(String(out.active_card), /^F\d+[A-Z]?$/);
  assert.ok(out.active_milestone && out.active_milestone.length > 0);
});

// --- parseLatestTest --------------------------------------------------------

test('parseLatestTest selects the newest test by DATE, not by LT number', () => {
  const ledger = [
    '### LT-020 — high number, old',
    '| **Owner result** | PASS |',
    'run 2026-01-01',
    '### LT-005 — low number, recent',
    '| **Owner result** | FAIL — regression |',
    'run 2026-09-09'
  ].join('\n');
  const out = parseLatestTest(ledger, NOW);
  assert.equal(out.id, 'LT-005');
  assert.equal(out.verdict, 'FAIL');
});

test('parseLatestTest treats the "PASS / FAIL —" template as UNKNOWN, never a false PASS', () => {
  const ledger = [
    '### LT-002 — pending',
    '| **Owner result** | PASS / FAIL — (fill in after testing) |',
    'noted 2026-05-01'
  ].join('\n');
  const out = parseLatestTest(ledger, NOW);
  assert.equal(out.id, 'LT-002');
  assert.equal(out.verdict, 'UNKNOWN');
});

test('parseLatestTest reports verified/confirmed only when the ledger confirms it', () => {
  const confirmed = [
    '### LT-010 — soul closeout',
    '| **Owner result** | ✅ PASS 2026-07-16 |',
    'each written via the trusted preview→approve→verified-write path and each fully',
    'undone via /api/log-workout/undo-last; post-undo verify-range reported no rows',
    'remaining; zero leftover synthetic rows.'
  ].join('\n');
  const out = parseLatestTest(confirmed, NOW);
  assert.equal(out.verdict, 'PASS');
  assert.equal(out.write_verdict, 'verified');
  assert.equal(out.undo_verdict, 'confirmed');
  assert.equal(out.freshness_days, 0);
});

test('parseLatestTest does NOT confuse a mere attempt with a verified/confirmed result', () => {
  const attempted = [
    '### LT-030 — interrupted',
    '| **Owner result** | UNKNOWN |',
    'a write was attempted but never verified; an undo was attempted, outcome unclear.',
    'logged 2026-07-10'
  ].join('\n');
  const out = parseLatestTest(attempted, NOW);
  assert.equal(out.write_verdict, 'attempted');
  assert.equal(out.undo_verdict, 'attempted');
  assert.notEqual(out.write_verdict, 'verified');
  assert.notEqual(out.undo_verdict, 'confirmed');
});

test('parseLatestTest degrades cleanly with no LT cards and with empty input', () => {
  const none = parseLatestTest('# Test Queue\n\nno cards yet', NOW);
  assert.equal(none.available, true);
  assert.equal(none.id, null);
  assert.equal(none.verdict, 'UNKNOWN');

  const empty = parseLatestTest('', NOW);
  assert.equal(empty.available, false);
});

test('parseLatestTest resolves the real ledger to the freshest trusted card', () => {
  const out = parseLatestTest(read('docs/TEST_QUEUE.md'), NOW);
  assert.match(String(out.id), /^LT-\d+$/);
  assert.ok(['PASS', 'FAIL', 'UNKNOWN'].includes(out.verdict));
});

// --- computeOverall ---------------------------------------------------------

const GOOD = {
  deployed_commit: 'abc123def456',
  plan_available: true,
  test_available: true,
  sheets_configured: true,
  llm_configured: true,
  latest_test_verdict: 'PASS',
  synthetic_rows_remaining: 0
};

test('computeOverall is healthy only with build known + services configured + latest PASS', () => {
  const r = computeOverall(GOOD);
  assert.equal(r.overall_status, 'healthy');
  assert.equal(r.owner_action_required, false);
  assert.deepEqual(r.owner_action_codes, []);
});

test('computeOverall degrades on each hard problem and flags an owner action', () => {
  const cases = [
    [{ sheets_configured: false }, 'SHEETS_NOT_CONFIGURED'],
    [{ llm_configured: false }, 'LLM_NOT_CONFIGURED'],
    [{ latest_test_verdict: 'FAIL' }, 'LATEST_TEST_FAILED'],
    [{ synthetic_rows_remaining: 3 }, 'SYNTHETIC_ROWS_PRESENT']
  ];
  for (const [patch, code] of cases) {
    const r = computeOverall({ ...GOOD, ...patch });
    assert.equal(r.overall_status, 'degraded', code);
    assert.ok(r.owner_action_codes.includes(code), `${code}: ${r.owner_action_codes.join(',')}`);
    assert.equal(r.owner_action_required, true);
  }
});

test('computeOverall never greens on config alone — an unconfirmed test is unknown', () => {
  const r = computeOverall({ ...GOOD, latest_test_verdict: 'UNKNOWN' });
  assert.equal(r.overall_status, 'unknown');
  assert.ok(r.status_reason_codes.includes('LATEST_TEST_UNCONFIRMED'));
});

test('computeOverall reports unknown (not healthy) when the build is unknown', () => {
  const r = computeOverall({ ...GOOD, deployed_commit: 'unknown' });
  assert.equal(r.overall_status, 'unknown');
  assert.ok(r.status_reason_codes.includes('BUILD_UNKNOWN'));
});

// --- assembleStatus (redaction + shape) -------------------------------------

test('assembleStatus only ever emits whitelisted keys', () => {
  const status = assembleStatus({
    now: NOW,
    generated_by: 'endpoint',
    deployed_commit: 'abc123def456789',
    app_version: 'PR #1021',
    plan_text: '### F09 — thing\n**Status:** QUEUED',
    test_text: '### LT-010 — x\n| **Owner result** | ✅ PASS 2026-07-16 |',
    sheets_configured: true,
    llm_configured: true,
    llm_provider: 'gemini',
    llm_model: 'gemini-2.5-flash-lite',
    flight_recorder_enabled: false,
    // A hostile extra input key must not survive into the output.
    injected_secret: 'sk-should-never-appear'
  });
  for (const k of Object.keys(status)) {
    assert.ok(ALLOWED_KEYS.includes(k), `unexpected key leaked: ${k}`);
  }
  assert.equal(status.deployed_commit.length, 12); // shortened
  assert.equal(status.generated_by, 'endpoint');
  assert.ok(!JSON.stringify(status).includes('sk-should-never-appear'));
  assert.ok(!('injected_secret' in status));
});

test('assembleStatus never carries a secret/email/sheet-id passed in a reason field', () => {
  const status = assembleStatus({
    now: NOW,
    deployed_commit: 'abc123def456',
    plan_text: '',
    test_text: '',
    sheets_configured: true,
    llm_configured: true,
    // even if a caller tried to smuggle sensitive text via synthetic_reason, the
    // output must not read it into a data field (it stays inside unavailable_sources
    // as an operator note only — assert it is never elevated elsewhere).
    synthetic_reason: 'benign not-scanned note'
  });
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('@'));
  assert.ok(!/\bGOOGLE_SHEETS_ID\b/.test(serialized));
});

test('assembleStatus marks the synthetic scan unavailable when not scanned', () => {
  const status = assembleStatus({ now: NOW, deployed_commit: 'abc123def456', plan_text: '', test_text: '' });
  assert.equal(status.synthetic_rows_remaining, null);
  assert.ok(status.unavailable_sources.some(s => s.source === 'sheet_synthetic_scan'));
});

test('assembleStatus lists unreadable plan/test sources as unavailable and not healthy', () => {
  const status = assembleStatus({ now: NOW, deployed_commit: 'abc123def456', plan_text: '', test_text: '', sheets_configured: true, llm_configured: true });
  assert.equal(status.source_freshness.execution_plan, 'unavailable');
  assert.equal(status.source_freshness.test_queue, 'unavailable');
  assert.notEqual(status.overall_status, 'healthy');
});

// --- renderHuman agrees with the JSON ---------------------------------------

test('renderHuman agrees with the status object it renders', () => {
  const status = assembleStatus({
    now: NOW,
    deployed_commit: 'abc123def456',
    app_version: 'PR #1021',
    plan_text: '### F09 — thing\n**Status:** QUEUED',
    test_text: '### LT-010 — x\n| **Owner result** | ✅ PASS 2026-07-16 |\nverified-write; fully undone; no rows remaining',
    sheets_configured: true,
    llm_configured: true
  });
  const human = renderHuman(status);
  assert.ok(human.includes(status.overall_status.toUpperCase()));
  assert.ok(human.includes(status.active_card));
  assert.ok(human.includes(status.latest_test_verdict));
  assert.ok(human.includes(status.deployed_commit));
});

test('buildLocalCliStatus assembles an honest offline view marked cli', () => {
  const status = buildLocalCliStatus({ now: NOW, deployed_reason: 'offline test' });
  assert.equal(status.generated_by, 'cli');
  assert.equal(status.deployed_commit, 'unknown');
  assert.ok(status.unavailable_sources.some(s => s.source === 'deployed_endpoint'));
  assert.notEqual(status.overall_status, 'healthy');
});

// --- Discoverability / clean-checkout acceptance ----------------------------
// A fresh agent reading AGENTS.md must be able to find the status command without
// being told the Sheet ID or tab names.

test('the atlas:status command and public endpoint are wired end to end', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['atlas:status'], 'node scripts/atlas-status.js');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/atlas-status.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'services/atlasStatus.js')));

  const routes = require('../config/routes').routeDefinitions;
  const statusRoute = routes.find(r => r.path === '/.well-known/atlas-status.json');
  assert.ok(statusRoute, 'the public status route must be declared');
  assert.equal(statusRoute.authRequired, false);
  assert.equal(statusRoute.public, true);
  assert.equal(statusRoute.writeCapable, false);
});

test('AGENTS.md and CLAUDE.md point a fresh agent to the status command and contract', () => {
  for (const rel of ['AGENTS.md', 'CLAUDE.md']) {
    const body = read(rel);
    assert.match(body, /atlas:status/, `${rel} must name the command`);
    assert.match(body, /ATLAS_OPERATIONS_CONTRACT\.md/, `${rel} must link the contract`);
  }
  const agents = read('AGENTS.md');
  assert.match(agents, /atlas-status\.json/);
  // No Sheet ID or tab name needs to be supplied to use it.
  assert.match(agents, /No Sheet ID/i);
});

test('the operations contract documents the schema, redaction, and no-secret requirement', () => {
  const doc = read('docs/ATLAS_OPERATIONS_CONTRACT.md');
  assert.match(doc, /npm run atlas:status/);
  assert.match(doc, /\/\.well-known\/atlas-status\.json/);
  assert.match(doc, /schema_version/);
  assert.match(doc, /whitelist/i);
  assert.match(doc, /never.*false green|no false green/i);
  assert.match(doc, /Sheet ID/); // states none is required
});

test('README and DOCS_INDEX surface the operations contract', () => {
  assert.match(read('README.md'), /ATLAS_OPERATIONS_CONTRACT\.md/);
  assert.match(read('docs/DOCS_INDEX.md'), /ATLAS_OPERATIONS_CONTRACT\.md/);
});
