'use strict';

// Gate harness — F-SB4B rehearsal (sandbox-live) posture safety.
// TEMPORARY F-SB4B machinery's permanent-while-it-exists safety net (sunset: F-SB4C,
// together with the posture it guards). Adapted from the proven Stage A suite
// (test/gateHarnessSandboxPosture.test.js, sunset PR #1234).
//
// These assert the HARNESS refuses to serve a browser an unverified or unsafe workbook,
// and that the default posture is untouched. Offline by construction: the only
// credentials used are deliberately malformed, so no Google client can authenticate and
// no write is reachable from any case here. No case requires a real credential.
//
// The load-bearing case is `an explicitly supplied production workbook id is NOT
// inherited`. It works because the preflight runs its offline checks (config resolution,
// declared-sandbox comparison, isSandboxSheet, production fingerprint) BEFORE the first
// network call. So if the harness had inherited the supplied id, it would fail at
// `resolved_workbook_is_declared_sandbox`. It instead reaches the reachability check,
// which is only possible if the assignment won.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6, isSandboxSpreadsheetId } = require('../config/sandboxSheet');

const GATE_SERVER = path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'gate-server.js');
const gateSrc = fs.readFileSync(GATE_SERVER, 'utf8');

// A private key with no usable PEM body: googleapis fails locally when it tries to sign,
// so these cases do not depend on reaching Google.
const FAKE_CREDS = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'stub@example.com',
  GOOGLE_PRIVATE_KEY: 'not-a-real-key',
};
// The combined flags are THE rehearsal posture.
const REHEARSAL_FLAGS = { ATLAS_GATE_SANDBOX_LIVE: '1', ATLAS_GATE_LEDGER_SANDBOX: '1' };

// Spawn the harness with an EXPLICITLY constructed environment. `...process.env` is never
// spread: a host exporting a real GOOGLE_SHEETS_ID or provider key is the exact accident
// under test, and inheriting it would make these cases lie.
function runHarness(env, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE_SERVER], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; child.kill('SIGKILL'); resolve(result); } };
    const timer = setTimeout(() => done({ code: null, stdout, stderr, timedOut: true }), timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += String(d);
      if (/GATE_PORT=\d+/.test(stdout)) { clearTimeout(timer); done({ code: 0, stdout, stderr, served: true }); }
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code) => { clearTimeout(timer); done({ code, stdout, stderr, served: /GATE_PORT=\d+/.test(stdout) }); });
  });
}

const served = (r) => /GATE_PORT=\d+/.test(r.stdout);

// ── the declared sandbox constant ──────────────────────────────────────────────

test('the sandbox workbook id is declared exactly once and both consumers agree', () => {
  const sheets = require('../sheets');
  assert.ok(isSandboxSpreadsheetId(SANDBOX_SPREADSHEET_ID));
  assert.strictEqual(isSandboxSpreadsheetId('something-else'), false);
  assert.strictEqual(SANDBOX_SPREADSHEET_ID_LAST6, SANDBOX_SPREADSHEET_ID.slice(-6));
  assert.strictEqual(typeof sheets.getSafeSpreadsheetConfig, 'function');
  const simHarness = require('../scripts/sim/harness');
  assert.strictEqual(simHarness.SANDBOX_SHEET_ID, SANDBOX_SPREADSHEET_ID,
    'the simulation harness resolved a different sandbox id than config/sandboxSheet.js');
});

// ── default posture is untouched ───────────────────────────────────────────────

test('the DEFAULT posture still serves the in-memory stub and never a real workbook', async () => {
  const r = await runHarness({ ATLAS_GATE_KEY: 'k' });
  assert.ok(served(r), `the default harness failed to start: ${r.stderr.slice(-600)}`);
  assert.match(r.stdout, /GATE_SHEETS_POSTURE=in-memory-stub/);
  assert.match(r.stdout, /GATE_MODEL_POSTURE=model-down/);
  assert.ok(!/sandbox-live/.test(r.stdout), 'the default harness advertised sandbox-live');
});

test('the default posture is unchanged even when a real-looking workbook id is exported', async () => {
  const r = await runHarness({ ATLAS_GATE_KEY: 'k', GOOGLE_SHEETS_ID: 'a-production-workbook-id', ...FAKE_CREDS });
  assert.ok(served(r), `the default harness failed to start: ${r.stderr.slice(-600)}`);
  assert.match(r.stdout, /GATE_SHEETS_POSTURE=in-memory-stub/);
});

// ── exactly ONE live posture: the combined rehearsal ───────────────────────────

test('standalone sandbox-live (without the ledger posture) refuses to start — the Stage A mode stays sunset', async () => {
  const r = await runHarness({ ATLAS_GATE_SANDBOX_LIVE: '1', ...FAKE_CREDS });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /requires ATLAS_GATE_LEDGER_SANDBOX=1/);
});

// ── the ambient / supplied workbook id is never inherited ──────────────────────

test('an explicitly supplied production workbook id is NOT inherited by the rehearsal posture', async () => {
  const r = await runHarness({
    ...REHEARSAL_FLAGS,
    GOOGLE_SHEETS_ID: 'a-production-workbook-id-that-must-never-be-used',
    ...FAKE_CREDS,
  });
  assert.ok(!served(r), 'the harness published a port with unusable credentials');
  // The decisive assertion: it did NOT fail on the declared-sandbox comparison, which means
  // the assignment replaced the supplied id before sheets.js captured it.
  assert.ok(!/resolved_workbook_is_declared_sandbox/.test(r.stderr),
    `the harness inherited the supplied workbook id: ${r.stderr.slice(-800)}`);
  assert.ok(!/is_sandbox_sheet_true/.test(r.stderr),
    `the harness resolved a non-sandbox workbook: ${r.stderr.slice(-800)}`);
  // It failed later, at reachability — the only check unusable credentials can reach.
  assert.match(r.stderr, /GATE_SANDBOX_ERROR: sandbox_reachable/);
});

// ── missing credentials / unverifiable workbook fail closed ────────────────────

test('the rehearsal posture without service-account credentials refuses to start', async () => {
  const r = await runHarness({ ...REHEARSAL_FLAGS });
  assert.ok(!served(r));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR: ATLAS_GATE_SANDBOX_LIVE=1 requires GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY/);
});

test('the rehearsal posture never publishes a port when the workbook cannot be verified', async () => {
  const r = await runHarness({ ...REHEARSAL_FLAGS, ...FAKE_CREDS }, { timeoutMs: 90000 });
  assert.ok(!served(r), 'a port was published without a verified workbook');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_SANDBOX_ERROR/);
  assert.ok(!/GATE_STATE_PORT=/.test(r.stdout), 'nothing may be advertised from an unverified harness');
});

// ── model posture authority (PR #1226) is inherited, not reimplemented ─────────

test('the rehearsal posture inherits model-down default rather than reimplementing it', async () => {
  const r = await runHarness({ ...REHEARSAL_FLAGS, GEMINI_API_KEY: 'fake-key-value', ...FAKE_CREDS }, { timeoutMs: 90000 });
  assert.ok(!served(r));
  assert.ok(!/GATE_POSTURE_ERROR: model-down harness has provider key/.test(r.stderr),
    'model-down should have deleted the provider key before the app loaded');
  assert.match(r.stderr, /GATE_SANDBOX_ERROR/);
});

test('a model-up rehearsal with an unreachable provider refuses to start', async () => {
  const r = await runHarness({
    ...REHEARSAL_FLAGS, ATLAS_GATE_MODEL_UP: '1',
    GEMINI_API_KEY: 'definitely-not-a-valid-key', ...FAKE_CREDS,
  }, { timeoutMs: 60000 });
  assert.ok(!served(r), 'model-up published a port without a reachable provider');
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /GATE_POSTURE_ERROR: ATLAS_GATE_MODEL_UP=1/);
});

// ── the write guard's shape, pinned at source level ────────────────────────────
// The guard's live behavior needs a real workbook, so its boundary is pinned on the
// source: what it refuses unconditionally, what it allows only under the combined
// posture, and that the allowlist widens ONLY under REHEARSAL_LIVE.

test('the guard refuses schema changes and deletions unconditionally', () => {
  const guard = gateSrc.slice(gateSrc.indexOf('function buildGuardedSheets('), gateSrc.indexOf('// ── The Sheets adapter the app will see'));
  assert.match(guard, /ensureSheetTab: async \(tabName\) => \{[\s\S]*?refuse\('ensureSheetTab', tabName, 'creating or ensuring a tab is a schema change and is owner-reserved'\)/,
    'ensureSheetTab must always refuse — tab creation is owner-reserved');
  assert.match(guard, /deleteRowsByRange: async \(\.\.\.args\) => \{[\s\S]*?refuse\('deleteRowsByRange'/,
    'deleteRowsByRange must always refuse — the rehearsal never deletes sandbox data');
  assert.match(guard, /assertSandboxNow\('appendRows', tabName\)/, 'every append re-checks the sandbox at call time');
  assert.match(guard, /assertSandboxNow\('updateColumnCells', tabName\)/, 'every cell update re-checks the sandbox at call time');
});

test('the seal column is the ONLY writable cell class, and only under the combined posture', () => {
  assert.match(gateSrc, /REHEARSAL_LIVE && tabName === 'Session_Plan_Sets' && columnLetter === SEAL_COL_LETTER/,
    'updateColumnCells must be limited to the Session_Plan_Sets seal column under REHEARSAL_LIVE');
});

test('the append allowlist widens to the plan-ledger tabs ONLY under the combined posture', () => {
  assert.match(gateSrc, /const WRITABLE_TABS = new Set\(REHEARSAL_LIVE\s*\?\s*\['Log_Cleaned', 'Effort', 'Session_Plans', 'Session_Plan_Sets'\]\s*:\s*\['Log_Cleaned', 'Effort'\]\)/,
    'the four-tab write set must be conditional on REHEARSAL_LIVE');
});

test('the preflight requires the owner-created ledger tabs with EXACT contract headers', () => {
  assert.match(gateSrc, /\['Session_Plans', sessionPlansColumns\], \['Session_Plan_Sets', sessionPlanSetsColumns\]/,
    'both plan-ledger tabs are header-checked in the preflight');
  assert.match(gateSrc, /header_exact_\$\{tab\}/, 'plan-ledger headers are compared exactly, mirroring the capture layers');
  assert.match(gateSrc, /ledger_write_flags_on/, 'the combined posture records the write flags as posture facts');
  assert.match(gateSrc, /telemetry_persistence_off/, 'telemetry persistence must stay off in the live posture');
});

test('the durable verifier answers only for one explicit session identity (isolation rule 5)', () => {
  const verifier = gateSrc.slice(gateSrc.indexOf("startsWith('/durable-rows')"), gateSrc.indexOf('sandbox_last6: SANDBOX_SPREADSHEET_ID_LAST6'));
  assert.match(verifier, /session_id is required — the verifier answers only for one session identity/,
    'a session-less read must be refused, never a whole-workbook dump');
  assert.match(verifier, /String\(r\[idx\] \|\| ''\)\.trim\(\) === wantSession/,
    'the span is re-filtered by the requested session id');
  // Codex P2 (PR #1251): the verifier may answer ONLY for an identity this process
  // durably wrote — a prior rehearsal's id, the owner's setup rows, or a guessed
  // date-pattern id must be refused, so the endpoint cannot browse the workbook.
  assert.match(verifier, /the verifier answers only for a session identity this process durably wrote/,
    'an identity this process did not write must be refused (403)');
  assert.match(verifier, /c\.live === true/, 'the write record consulted is the LIVE append log');
});

test('both harness servers bind to loopback and the default lane scrubs the live flag (Codex P1/P2)', () => {
  assert.match(gateSrc, /app\.listen\(0, '127\.0\.0\.1'/, 'the app server must bind loopback only');
  assert.match(gateSrc, /stateServer\.listen\(0, '127\.0\.0\.1'/, 'the state server must bind loopback only');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.js'), 'utf8');
  assert.match(cfg, /delete process\.env\.ATLAS_GATE_SANDBOX_LIVE;/,
    'playwright.config.js must scrub the live flag before any spec worker exists — an exported flag in the invoking shell must be inert for the whole default lane');
});

test('the rehearsal waits for the acceptance boundary itself before reading app state', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal.spec.js'), 'utf8');
  assert.match(spec, /const APP_READINESS_TIMEOUT_MS = 30000;/,
    'the readiness wait budget is a named constant');
  const waitIdx = spec.indexOf("page.waitForFunction(() => typeof window.atlasAcceptPlan === 'function', null, { timeout: APP_READINESS_TIMEOUT_MS })");
  assert.ok(waitIdx > -1,
    'the spec must wait for window.atlasAcceptPlan itself — networkidle proves only 500 ms of network quiet, not that the module graph executed (runs fsb4b-s1-20261028T022014-A6659B and fsb4b-s1-20261028T022107-25585D failed NOT_STARTED on exactly that gap)');
  const snapIdx = spec.indexOf("snap(page, '01-client-open.png')");
  const shellIdx = spec.indexOf("getElementById('shell-version')");
  const acceptIdx = spec.indexOf('window.atlasAcceptPlan({');
  assert.ok(snapIdx > -1 && shellIdx > -1 && acceptIdx > -1, 'the pinned spec landmarks are present');
  assert.ok(waitIdx < snapIdx && waitIdx < shellIdx && waitIdx < acceptIdx,
    'the readiness wait must precede the client-open screenshot, the app-state reads, and the acceptance call');
});

test('the claim snapshot follows a final collector settle, and per-record claim diagnostics are persisted', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal.spec.js'), 'utf8');
  assert.match(spec, /async function settleBubbleCollector\(page\) \{/,
    'the spec must define a final drain + settle for the bubble collector (F-SB4B corrective 7)');
  const settleIdx = spec.indexOf('await settleBubbleCollector(page);');
  assert.ok(settleIdx > -1, 'section 13a must run the settle before snapshotting the claim records');
  const snapshotIdx = spec.indexOf('const originalVisibleMessages = recordsToMessages(bubbleRecords);');
  assert.ok(snapshotIdx > -1, 'the pinned snapshot landmark is present');
  assert.ok(settleIdx < snapshotIdx,
    'the settle must precede the snapshot — a snapshot taken straight after the final sweep judges records whose redeeming reports are still in flight (run fsb4b-s1-20261028T051612-EFEB58 failed condition 9 on exactly one such record, with zero claim matches)');
  // The next occurrence must be diagnosable: the run evidence persists one entry per
  // claim record — identity, phase, and the timing evidence, never the text (run
  // fsb4b-s1-20261028T051612-EFEB58's artifacts named no bubble).
  assert.match(spec, /records: originalVisibleMessages\.map\(/,
    'the claim evidence must persist per-record diagnostics');
  assert.match(spec, /swept_at_change_seq/,
    'the persisted diagnostics must carry the sweep sequence evidence');
});

test('a proven settle judges stored sequence evidence before the claim snapshot (corrective 8)', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal.spec.js'), 'utf8');
  const observer = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal-bubble-observer.js'), 'utf8');
  assert.match(observer, /function redeemOnStoredEvidence\(records\) \{/,
    'the observer must export the settle-time redemption on stored sequence evidence');
  // The redemption may run ONLY on the settle's proven branch — collector not
  // pending AND the record set identical across a flush window. Anywhere else
  // (an unsettled collector, an ordinary sweep) the mark must stand, because a
  // report still in flight is the live authority, not the stored pair.
  const settle = spec.slice(spec.indexOf('async function settleBubbleCollector(page) {'),
    spec.indexOf('const THINKING = '));
  assert.ok(settle.length > 0, 'the pinned settle landmark is present');
  const provenIdx = settle.indexOf('if (!pending && snapshot === previous)');
  const redeemIdx = settle.indexOf('redeemOnStoredEvidence(bubbleRecords);');
  assert.ok(provenIdx > -1, 'the settle success branch is present');
  assert.ok(redeemIdx > provenIdx,
    'stored-evidence redemption must run inside the proven-settle branch — run fsb4b-s1-20261028T060125-0939CE failed condition 9 on a record whose stored pair (128 <= 128) satisfied the sequence proof but whose bubble, being final, had no later report to redeem it');
  assert.equal(spec.split('redeemOnStoredEvidence(bubbleRecords);').length - 1, 1,
    'the redemption runs in exactly one place — the proven settle, never an ordinary sweep');
});

test('the write boundary is sampled in-page at the response instant, harvested before teardown, and persisted (in-page boundary)', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal.spec.js'), 'utf8');
  const observer = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal-bubble-observer.js'), 'utf8');
  // The sampler lives inside the collector's init script, wrapped around the
  // page's own fetch, so its reaction is attached to the save promise before the
  // app's continuation can render the claim the response causes.
  assert.match(observer, /window\.fetch = function/,
    'the in-page sampler must wrap window.fetch inside the collector init script');
  assert.match(spec, /boundaryName: '__atlasWriteBoundary'/,
    'the spec must install the sampler under its boundary hook name');
  // The old outside read is gone entirely: no listener-side clock state remains.
  assert.ok(!/liveWriteChangeSeq/.test(spec),
    'the spec must not carry the old outside-the-page sampling state');
  const listenerStart = spec.indexOf("page.on('response'");
  const listenerEnd = spec.indexOf('// ── 1. Open the real built client');
  assert.ok(listenerStart > -1 && listenerEnd > listenerStart, 'the pinned listener landmarks are present');
  assert.ok(!/__atlasBubbleState/.test(spec.slice(listenerStart, listenerEnd)),
    'the response listener must not read the collector clock — that read lands after the page rendered the claim the response caused (run fsb4b-s1-20261028T065034-CDE1FA failed condition 9 on exactly it)');
  // The samples are harvested while the session document still exists — before
  // the teardown reload replaces it — and paired at the boundary, not read live.
  const harvestIdx = spec.indexOf('writeBoundarySamples = samples');
  const teardownIdx = spec.indexOf('await proveTeardownAndNoInheritance(page, h, { base });');
  assert.ok(harvestIdx > -1, 'the spec must harvest the in-page samples');
  assert.ok(teardownIdx > -1 && harvestIdx < teardownIdx,
    'the harvest must precede the teardown reload — afterwards the document holding the samples no longer exists');
  assert.match(spec, /pairLiveWriteChangeSeq\(saveResponses, writeBoundarySamples\)/,
    'the boundary must pair the network records with the harvested samples under the guards');
  // Both judged boundaries are persisted into the run evidence: the failed run's
  // boundary existed nowhere in its artifacts and had to be reconstructed from
  // the verdict's branch.
  assert.match(spec, /boundaries: \{/,
    'the claim evidence must persist the judged boundaries');
  assert.match(spec, /atChangeSeq: liveWriteBoundary\.atChangeSeq/,
    'the persisted write boundary must carry its sampled sequence');
  assert.match(spec, /atChangeSeq: mutationBoundary\.atChangeSeq/,
    'the persisted mutation boundary must carry its sequence');
});

test('the teardown waits for the second-graph pick global before its opener turn (teardown readiness)', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal.spec.js'), 'utf8');
  const teardown = spec.slice(spec.indexOf('async function proveTeardownAndNoInheritance'),
    spec.indexOf('let child = null;'));
  assert.ok(teardown.length > 0, 'the pinned teardown landmark is present');
  // networkidle after the teardown reload proves only network quiet — the same
  // gap first load closed for the first graph. Run
  // fsb4b-s2-20261029T013544-B83515 submitted its opener while
  // window.atlasOpenCoachPick (assigned by coach-conversation.js, the second
  // graph's last module) was not yet a function, and the Coach's Pick lane
  // silently dropped it. The wait is on the SAME budget as first load.
  assert.match(teardown, /page\.waitForFunction\(\(\) => typeof window\.atlasOpenCoachPick === 'function', null, \{ timeout: APP_READINESS_TIMEOUT_MS \}\)/,
    'the teardown must wait for window.atlasOpenCoachPick itself before the opener turn');
  // The global's status is recorded in the inheritance probe EITHER WAY, so the
  // artifact states it at submit time even when the wait succeeds.
  assert.match(teardown, /coachPickGlobal: typeof window\.atlasOpenCoachPick/,
    'the inheritance probe must record typeof window.atlasOpenCoachPick');
  assert.match(teardown, /'teardown-second-graph-ready'/,
    'the readiness verdict must be recorded as a state check');
  // A timed-out wait throws as machinery evidence BEFORE the opener: the opener
  // is never submitted against a second graph that never arrived.
  const throwIdx = teardown.indexOf('teardown second-graph readiness failed');
  const openerIdx = teardown.indexOf("settleReply(page, 'what should I train today?')");
  assert.ok(throwIdx > -1, 'the readiness timeout must throw as machinery evidence');
  assert.ok(openerIdx > throwIdx,
    'the readiness throw must precede the opener turn — the opener is not submitted on a failed wait');
});

test('the collected page errors are persisted for every run, not only on closeout failure (pageerror persistence)', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal.spec.js'), 'utf8');
  // ONE writer, two triggers. Run fsb4b-s2-20261029T013544-B83515's page errors
  // were collected and then discarded because the run did not fail at closeout.
  assert.match(spec, /function persistPageErrors\(fileName\) \{/,
    'the spec must define one pageerror writer');
  assert.match(spec, /pageErrors\.join\('\\n\\n'\) \|\| '\(no page errors captured\)'/,
    'the writer must keep the closeout path\'s original content format');
  const writerCount = spec.split('fs.writeFileSync(path.join(artDir, fileName)').length - 1;
  assert.equal(writerCount, 1, 'the pageerror write must exist in exactly one place — the shared writer');
  // Trigger one: the closeout-failure catch, under its failure name.
  assert.match(spec, /persistPageErrors\('closeout-failure-pageerrors\.txt'\)/,
    'the closeout-failure path must persist through the shared writer');
  // Trigger two: afterAll, beside server-log.txt, so EVERY run leaves the file.
  const afterAll = spec.slice(spec.indexOf('test.afterAll(async () => {'),
    spec.indexOf("test('F-SB4B rehearsal session"));
  assert.ok(afterAll.length > 0, 'the pinned afterAll landmark is present');
  assert.match(afterAll, /persistPageErrors\('pageerrors\.txt'\)/,
    'afterAll must persist the page errors for every run');
  const serverLogIdx = afterAll.indexOf("'server-log.txt'");
  assert.ok(serverLogIdx > -1 && afterAll.indexOf("persistPageErrors('pageerrors.txt')") > serverLogIdx,
    'the every-run pageerror write must sit beside the server-log write in afterAll');
  // The collection is module-scope, or afterAll could never see it.
  assert.match(spec, /const pageErrors = \[\];/,
    'the pageerror collection must be declared once, at module scope');
  assert.equal(spec.split('const pageErrors = [];').length - 1, 1,
    'the pageerror collection must be declared exactly once');
});

test('the collector counts class-only reveals, scoped to class changes that change visible text (attribute observer)', () => {
  const observer = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'rehearsal-bubble-observer.js'), 'utf8');
  // The Saved reveal is a CLASS-ONLY mutation: markReviewSaved adds 'done' to
  // the card and .rv-saved is display:none until .review.done (styles.css).
  // A collector observing only childList/characterData never counts it, so the
  // claim is stamped by an unrelated later value — run
  // fsb4b-s1-20261028T130455-6EEF09 recorded the claim and the in-page write
  // boundary at the SAME sequence (156) and judged an earned claim 'before'.
  assert.match(observer, /attributes: true, attributeFilter: \['class'\]/,
    'the collector must observe class attribute changes — the reveal it exists to time is one');
  // Scoped, not coarse: an attribute-only batch takes a visibility pass that
  // counts the change only where a bubble’s visible text actually changed,
  // diffed against the text the collector last read for that bubble. A class
  // wiggle that reveals and hides nothing must not advance the clock, or the
  // bounded settle (which requires the collector pending === false) can be
  // starved by class churn that carries no claim evidence.
  assert.match(observer, /const markVisibilityChanges = \(\) => \{/,
    'attribute-only batches must take the scoped visibility pass, not markAll');
  assert.match(observer, /lastText\.get\(b\.id\) !== b\.text/,
    'the visibility pass must diff each bubble’s text against the collector’s last read');
  // The content path is untouched: any batch carrying a childList or
  // characterData record still takes markAll, so no prior corrective’s
  // counting changes.
  assert.match(observer, /r\.type !== 'attributes'/,
    'the dispatcher must keep non-attribute records on the markAll path');
});
