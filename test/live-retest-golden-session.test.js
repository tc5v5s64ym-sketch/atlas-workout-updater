'use strict';

// The Golden Session adapter (Phase 4 live-testing slice PR B).
//
// These tests are deterministic and browser-free. They pin the properties the slice
// exists to guarantee:
//   1. the fixture's beat ORDER is preserved, beat for beat;
//   2. no beat is skipped or duplicated;
//   3. an unknown beat fails CLOSED (never a silent skip, never "executable");
//   4. a write-capable beat cannot execute — there is no executor for one in this PR;
//   5. the existing single-scenario live-retest behavior is unchanged;
//   6. the authenticated-run privacy rules are unchanged;
//   7. replaying only the non-write subset can never produce a false PASS.
//
// The fixture (`test/fixtures/goldenSession.js`) stays the single definition — every
// assertion below derives its expectation from the fixture rather than restating beats.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GOLDEN_SESSION } = require('../test/fixtures/goldenSession');
const golden = require('../scripts/live-retest-golden-session');
const {
  SCENARIOS, assertScenario, navigateGoldenSession, buildMarkdownReport
} = require('../scripts/live-retest');

const TMP = path.join(os.tmpdir(), 'atlas-live-retest-golden-session');
fs.mkdirSync(TMP, { recursive: true });

const SCN = SCENARIOS['golden-session'];
const WRITE_SEAMS = ['client:start-this-plan', 'client:revise', 'client:closeout', 'client:seal'];

// Tight settle bounds for the browser-free walk (the same injection style
// `waitForSettledResponse` already accepts). Production bounds are unchanged.
const FAST_SETTLE = { pollMs: 1, stableMs: 2, timeoutMs: 200 };

function walk(page, scenarioKey, privacy = true) {
  return navigateGoldenSession({ page, scenarioKey, outputDir: TMP, privacy, assertion: SCN.assertion, settleOptions: FAST_SETTLE });
}

// ── 1. Beat order is preserved, beat for beat ────────────────────────────────

test('1a. the plan carries every fixture beat, in the fixture\'s exact order', () => {
  const plan = golden.buildGoldenSessionPlan();
  assert.deepEqual(
    plan.beats.map(b => b.id),
    GOLDEN_SESSION.beats.map(b => b.beat),
    'the plan is the fixture order, unchanged'
  );
  assert.deepEqual(
    plan.beats.map(b => b.seam),
    GOLDEN_SESSION.beats.map(b => b.seam),
    'each plan entry keeps its own fixture seam'
  );
  assert.deepEqual(plan.beats.map(b => b.index), GOLDEN_SESSION.beats.map((_, i) => i));
});

test('1b. the fixture\'s reserved live beats appear in their canonical order', () => {
  const plan = golden.buildGoldenSessionPlan();
  const seams = plan.beats.map(b => b.seam);
  const reserved = seams.filter(s => ['client:start-this-plan', 'coach/ask', 'client:revise', 'client:closeout', 'client:seal'].includes(s));
  assert.deepEqual(reserved, [
    'client:start-this-plan', 'coach/ask', 'client:revise', 'client:closeout', 'client:seal'
  ], 'start-this-plan → ask → revise → closeout → seal, exactly as the fixture scripts them');
});

test('1c. the plan is derived from the fixture, not a second catalogue — a reordered fixture reorders the plan', () => {
  const reversed = { title: 'x', beats: [...GOLDEN_SESSION.beats].reverse() };
  const plan = golden.buildGoldenSessionPlan(reversed);
  assert.deepEqual(plan.beats.map(b => b.id), reversed.beats.map(b => b.beat));
});

// ── 2. No beat skipped, none duplicated ──────────────────────────────────────

test('2a. every fixture beat gets exactly one plan entry — none skipped, none duplicated', () => {
  const plan = golden.buildGoldenSessionPlan();
  assert.equal(plan.beats.length, GOLDEN_SESSION.beats.length);
  assert.equal(plan.counts.total, GOLDEN_SESSION.beats.length);
  const ids = plan.beats.map(b => b.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate beat entries');
  assert.equal(
    plan.counts.executable + plan.counts.write_blocked + plan.counts.fixture_error,
    plan.counts.total,
    'the class tally accounts for every beat — nothing falls through unclassified'
  );
});

test('2b. the walk visits every beat exactly once, in order', async () => {
  const { page } = fakePage();
  const res = await walk(page, 'g2b');
  assert.deepEqual(res.golden.beats.map(b => b.beat_id), GOLDEN_SESSION.beats.map(b => b.beat));
  assert.deepEqual(res.golden.beats.map(b => b.beat_index), GOLDEN_SESSION.beats.map((_, i) => i));
});

// ── 3. Unknown / malformed beats fail closed ─────────────────────────────────

test('3a. an unknown seam is a fixture_error, never executable and never silently skipped', () => {
  const plan = golden.buildGoldenSessionPlan({ beats: [{ beat: 'mystery', seam: 'client:teleport' }] });
  assert.equal(plan.beats.length, 1, 'the unknown beat is still accounted for');
  assert.equal(plan.beats[0].class, 'fixture_error');
  assert.match(plan.beats[0].reason, /unknown seam/i);
  assert.equal(plan.beats[0].input, null);
  assert.equal(golden.mayExecuteBeat(plan.beats[0]), false);
});

test('3b. a beat with no id, and a read-only beat with underivable input, both fail closed', () => {
  const plan = golden.buildGoldenSessionPlan({
    beats: [
      { seam: 'coach/message:block', facts: {} },
      { beat: 'no-facts', seam: 'coach/message:block', facts: {} },
      { beat: 'half-a-set', seam: 'coach/message:block', facts: { exerciseName: 'Bench Press', todaySets: [{ weight: 225 }] } }
    ]
  });
  assert.deepEqual(plan.beats.map(b => b.class), ['fixture_error', 'fixture_error', 'fixture_error']);
  assert.equal(plan.counts.executable, 0);
});

test('3c. an unknown beat drives the walk to ERROR — it can never read PASS or be ignored', async () => {
  const ledger = { beats: [{ beat_id: 'mystery', class: 'fixture_error', error: 'unknown seam' }] };
  assert.equal(golden.goldenSessionVerdict(ledger).verdict, 'ERROR');
  // …and even alongside a perfectly settled beat, the error still wins.
  const mixed = { beats: [{ beat_id: 'ok', class: 'executable', settled: true }, ...ledger.beats] };
  assert.equal(golden.goldenSessionVerdict(mixed).verdict, 'ERROR');
});

// ── 4. Write-capable beats cannot execute ────────────────────────────────────

test('4a. every write-capable fixture seam is classified write_blocked with an explicit reason', () => {
  const plan = golden.buildGoldenSessionPlan();
  const blocked = plan.beats.filter(b => b.class === 'write_blocked');
  assert.deepEqual(blocked.map(b => b.seam), WRITE_SEAMS);
  for (const b of blocked) {
    assert.equal(golden.mayExecuteBeat(b), false, `${b.id} must not be executable`);
    assert.equal(b.input, null, `${b.id} must carry no browser input`);
    assert.match(b.reason, /write/i);
    assert.match(b.reason, /PR D/, `${b.id} names the slice that installs the posture`);
    assert.equal(b.blockedPending, golden.WRITE_POSTURE.installedBy);
  }
});

test('4b. the write posture is not installed in this PR', () => {
  assert.equal(golden.WRITE_POSTURE.installed, false);
  assert.equal(golden.WRITE_POSTURE.authorized, false);
  assert.equal(Object.isFrozen(golden.WRITE_POSTURE), true, 'the posture cannot be flipped at run time');
});

test('4c. the walk never interacts with the page for a write-capable beat, and never touches a write control', async () => {
  const { page, calls } = fakePage();
  const res = await walk(page, 'g4c');

  const blocked = res.golden.beats.filter(b => b.class === 'write_blocked');
  assert.equal(blocked.length, WRITE_SEAMS.length);
  for (const b of blocked) {
    assert.equal(b.executed, false);
    assert.equal(b.write_posture_installed, false);
    assert.ok(b.blocked_reason, 'a blocked beat states WHY it is blocked');
  }

  // The composer/preview interaction count must equal the EXECUTABLE beat count —
  // proof that no blocked beat produced any browser action of its own.
  const executable = res.golden.beats.filter(b => b.class === 'executable' && b.executed).length;
  assert.equal(calls.filter(c => c === 'fill:#workout-text').length, executable);
  assert.equal(calls.filter(c => c === 'click:#preview-btn').length, executable);

  // No write control is ever clicked. `#approve-btn` is only ever READ (isDisabled).
  assert.equal(calls.filter(c => c.startsWith('click:')).every(c => c === 'click:#preview-btn'), true,
    `the only control ever clicked is the preview button; saw: ${JSON.stringify([...new Set(calls.filter(c => c.startsWith('click:')))])}`);
  assert.equal(calls.includes('click:#approve-btn'), false);
});

test('4d. the runner source contains no executor for any write-capable seam and no write-control click', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'live-retest.js'), 'utf8');
  const adapter = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'live-retest-golden-session.js'), 'utf8');
  for (const src of [runner, adapter]) {
    assert.equal(/\.click\(\)/.test(src.replace(/#preview-btn'\)\.click\(\)/g, '')), false,
      'the only click() in the harness is #preview-btn');
    assert.equal(/approve-btn'\)\.click/.test(src), false, 'the write button is never clicked');
  }
});

// ── 5. Existing single-scenario behavior is unchanged ────────────────────────

test('5a. every pre-existing scenario keeps its key, navigation type, and assertion mode', () => {
  const before = {
    'bug-20260629-153258': { nav: 'composer', mode: undefined },
    'bug-20260629-153312': { nav: 'composer', mode: undefined },
    'bug-20260629-003505': { nav: 'manual', mode: null },
    'bug-20260629-002945': { nav: 'composer', mode: undefined },
    'bug-20260629-204817': { nav: 'manual', mode: null },
    'coach-response-settlement': { nav: 'composer', mode: 'settled_no_forbidden' }
  };
  for (const [key, want] of Object.entries(before)) {
    const s = SCENARIOS[key];
    assert.ok(s, `${key} still exists`);
    assert.equal(s.navigation.type, want.nav, `${key} navigation type unchanged`);
    assert.equal(s.assertion ? s.assertion.mode : null, want.mode, `${key} assertion mode unchanged`);
    assert.equal(s.excludeFromAll, undefined, `${key} is still part of the "all" sweep`);
  }
});

test('5b. the outage scenarios keep their exact forbidden + expected assertions', () => {
  for (const key of ['bug-20260629-153258', 'bug-20260629-153312']) {
    const a = SCENARIOS[key].assertion;
    assert.equal(a.forbidden.length, 4);
    assert.deepEqual(a.expected.map(String), [String(/re-?type|add it to the preview|log it/i)]);
  }
  const modality = SCENARIOS['bug-20260629-002945'].assertion;
  assert.deepEqual(modality.forbidden.map(String), [String(/not a recognized modality/i)]);
});

test('5c. the Golden Session is excluded from the "all" sweep, so "all" keeps its prior scenario set', () => {
  assert.equal(SCN.excludeFromAll, true);
  const allKeys = Object.keys(SCENARIOS).filter(k => !SCENARIOS[k].excludeFromAll);
  assert.deepEqual(allKeys, [
    'bug-20260629-153258', 'bug-20260629-153312', 'bug-20260629-003505',
    'bug-20260629-002945', 'bug-20260629-204817', 'coach-response-settlement'
  ]);
  assert.equal(allKeys.includes(golden.SCENARIO_KEY), false);
});

test('5d. an existing scenario\'s verdict is untouched by the new mode', () => {
  const settled = { settled: true, reason: 'settled' };
  const v = assertScenario({
    scenarioKey: 'g5d', scenario: SCENARIOS['coach-response-settlement'],
    navResult: { navigated: true, threadText: 'Got it — tell me the set and I\'ll log it.', settle: settled },
    outputDir: TMP
  });
  assert.equal(v, 'PASS');
  const outage = assertScenario({
    scenarioKey: 'g5d2', scenario: SCENARIOS['bug-20260629-153258'],
    navResult: { navigated: true, threadText: 'The coach isn\'t available right now.', settle: settled },
    outputDir: TMP
  });
  assert.equal(outage, 'FAIL');
});

// ── 6. Authenticated-run privacy rules are unchanged ─────────────────────────

test('6a. the Golden Session result JSON never carries reply text or a thread excerpt', () => {
  const ledger = {
    beats: [
      { beat_id: 'plan-from-history', beat_index: 0, seam: 'coach/message:plan', class: 'executable', executed: true, settled: true, settle_reason: 'settled', waited_ms: 900, reply_length: 84, forbidden_hit: false },
      { beat_id: 'accept-the-plan', beat_index: 1, seam: 'client:start-this-plan', class: 'write_blocked', executed: false, blocked_reason: 'write', write_posture_installed: false }
    ]
  };
  for (const privacy of [true, false]) {
    const key = `g6a-${privacy}`;
    assertScenario({
      scenarioKey: key, scenario: SCN,
      navResult: { navigated: true, threadText: 'PRIVATE OWNER SURFACE TEXT', golden: ledger },
      outputDir: TMP, auth: { authenticated: privacy }, privacy
    });
    const json = JSON.parse(fs.readFileSync(path.join(TMP, `${key}-result.json`), 'utf8'));
    const blob = JSON.stringify(json);
    assert.equal(json.threadExcerpt, null, 'no thread excerpt on either posture');
    assert.equal(blob.includes('PRIVATE OWNER SURFACE TEXT'), false, 'private surface text never reaches the artifact');
    assert.equal(blob.includes('reply_text'), false);
    for (const b of json.beats) {
      assert.equal(Object.prototype.hasOwnProperty.call(b, 'text'), false, 'a beat row carries no reply text');
    }
  }
});

test('6b. the walk logs lengths and booleans, never reply content', async () => {
  const { page } = fakePage({ replyText: 'SECRET PRIVATE REPLY' });
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let res;
  try {
    res = await walk(page, 'g6b');
  } finally {
    console.log = realLog;
  }
  assert.equal(logs.join('\n').includes('SECRET PRIVATE REPLY'), false, 'no reply content is logged');
  const executed = res.golden.beats.filter(b => b.executed);
  assert.ok(executed.length > 0);
  for (const b of executed) {
    assert.equal(typeof b.reply_length, 'number');
    assert.equal(Object.prototype.hasOwnProperty.call(b, 'text'), false);
  }
});

test('6c. the privacy contract in the existing runner is unchanged (no screenshot on an authenticated walk)', async () => {
  const shots = [];
  const { page } = fakePage({ onScreenshot: p => shots.push(p) });
  await walk(page, 'g6c');
  assert.deepEqual(shots, [], 'an authenticated (privacy) walk captures no screenshot');

  const shots2 = [];
  const { page: page2 } = fakePage({ onScreenshot: p => shots2.push(p) });
  await walk(page2, 'g6c2', false);
  assert.equal(shots2.length, 1, 'an unauthenticated walk still captures the read-only screenshot');
});

// ── 7. No false PASS from the non-write subset ───────────────────────────────

test('7a. a walk in which every executable beat settled cleanly is still INCONCLUSIVE while beats are blocked', async () => {
  const { page } = fakePage();
  const res = await walk(page, 'g7a');
  // Precondition: the non-write subset went perfectly.
  const executed = res.golden.beats.filter(b => b.executed);
  assert.ok(executed.length > 0);
  assert.equal(executed.every(b => b.settled === true && b.forbidden_hit === false), true);

  const g = golden.goldenSessionVerdict(res.golden);
  assert.equal(g.verdict, 'INCONCLUSIVE');
  assert.match(g.reason, /write_capable_beats_blocked/);

  const v = assertScenario({
    scenarioKey: 'g7a', scenario: SCN,
    navResult: res, outputDir: TMP
  });
  assert.equal(v, 'INCONCLUSIVE', 'the non-write subset alone can never read PASS');
});

test('7b. PASS is unreachable for the real fixture with the current (uninstalled) write posture', () => {
  const plan = golden.buildGoldenSessionPlan();
  assert.ok(plan.counts.write_blocked > 0, 'the fixture genuinely contains write-capable beats');
  // Any ledger built from this plan carries those blocked rows, and a blocked row
  // is an unconditional INCONCLUSIVE.
  const ledger = { beats: plan.beats.map(b => (b.class === 'executable'
    ? { beat_id: b.id, class: 'executable', executed: true, settled: true, forbidden_hit: false }
    : { beat_id: b.id, class: b.class, executed: false })) };
  assert.equal(golden.goldenSessionVerdict(ledger).verdict, 'INCONCLUSIVE');
});

test('7c. PASS becomes reachable only once nothing is blocked and every beat settled (the PR-D shape)', () => {
  const allSettled = { beats: golden.buildGoldenSessionPlan().beats.map(b => ({ beat_id: b.id, class: 'executable', executed: true, settled: true, forbidden_hit: false })) };
  assert.equal(golden.goldenSessionVerdict(allSettled).verdict, 'PASS');
});

test('7d. a settlement failure is its own outcome — INCONCLUSIVE with its reason, never blocked and never PASS', () => {
  const ledger = { beats: [
    { beat_id: 'a', class: 'executable', executed: true, settled: true, forbidden_hit: false },
    { beat_id: 'b', class: 'executable', executed: true, settled: false, settle_reason: 'timeout_still_thinking' }
  ] };
  const g = golden.goldenSessionVerdict(ledger);
  assert.equal(g.verdict, 'INCONCLUSIVE');
  assert.equal(g.reason, 'beat_settlement_failed:timeout_still_thinking');

  const row = golden.beatSettlementFailure({ id: 'b', index: 1, seam: 'coach/ask' }, { reason: 'timeout_no_response' });
  assert.deepEqual(row, { beat_id: 'b', beat_index: 1, seam: 'coach/ask', executed: true, settled: false, settle_reason: 'timeout_no_response' });
});

test('7e. an outage wording in any executed beat is a FAIL, outranking the blocked beats', () => {
  const ledger = { beats: [
    { beat_id: 'a', class: 'executable', executed: true, settled: true, forbidden_hit: true },
    { beat_id: 'b', class: 'write_blocked', executed: false }
  ] };
  assert.equal(golden.goldenSessionVerdict(ledger).verdict, 'FAIL');
});

test('7f. a walk that never happened is INCONCLUSIVE, never a pass', () => {
  assert.equal(golden.goldenSessionVerdict({ beats: [] }).verdict, 'INCONCLUSIVE');
  const v = assertScenario({
    scenarioKey: 'g7f', scenario: SCN,
    navResult: { navigated: false, threadText: '' }, outputDir: TMP
  });
  assert.equal(v, 'INCONCLUSIVE');
});

test('7g. a real outage reply during the walk drives FAIL end to end', async () => {
  const { page } = fakePage({ replyText: 'Sorry, the coach is unavailable right now.' });
  const res = await walk(page, 'g7g');
  assert.equal(res.golden.beats.some(b => b.forbidden_hit === true), true);
  assert.equal(assertScenario({ scenarioKey: 'g7g', scenario: SCN, navResult: res, outputDir: TMP }), 'FAIL');
});

// ── 8. Fixture-derived inputs and the owner report ───────────────────────────

test('8a. each executable beat\'s composer input is rendered from that beat\'s own fixture facts', () => {
  const plan = golden.buildGoldenSessionPlan();
  for (const b of plan.beats.filter(x => x.class === 'executable')) {
    const fixtureBeat = GOLDEN_SESSION.beats[b.index];
    const facts = fixtureBeat.facts || {};
    if (fixtureBeat.seam === 'coach/ask') { assert.equal(b.input, 'why?'); continue; }
    assert.ok(b.input.includes(facts.exerciseName), `${b.id} names its own lift`);
    for (const s of facts.todaySets || []) {
      const expected = s.rir === undefined || s.rir === null ? `${s.weight} ${s.reps}` : `${s.weight} ${s.reps}/${s.rir}`;
      assert.ok(b.input.includes(expected), `${b.id} carries the fixture set ${expected} in slash notation`);
    }
  }
});

test('8b. renderSet follows the parser contract and never fabricates an RIR', () => {
  assert.equal(golden.renderSet({ weight: 225, reps: 5, rir: 2 }), '225 5/2');
  assert.equal(golden.renderSet({ weight: 225, reps: 5, rir: 0 }), '225 5/0', 'RIR 0 is a real value, not a missing one');
  assert.equal(golden.renderSet({ weight: 135, reps: 12 }), '135 12', 'no RIR is rendered when the fixture gives none');
  assert.equal(golden.renderSet({ weight: 135 }), null);
});

test('8c. the owner report lists every beat, its status, and the PR-C evidence fields — with no production content', () => {
  const plan = golden.buildGoldenSessionPlan();
  const md = golden.buildGoldenSessionReport(plan);
  for (const b of GOLDEN_SESSION.beats) assert.ok(md.includes(`\`${b.beat}\``), `${b.beat} appears in the report`);
  assert.match(md, /blocked pending PR D/);
  assert.match(md, /Expected evidence fields for PR C/);
  assert.match(md, /No production write is possible/);
  for (const f of golden.EVIDENCE_FIELDS.executable) assert.ok(md.includes(f), `${f} is declared`);
  // Privacy: the report is built from the fixture and carries no run content.
  assert.equal(/reply_text|threadExcerpt|screenshot\.png/.test(md), false);
});

test('8d. the runner report appends the Golden Session plan only when that scenario ran', () => {
  const withGolden = buildMarkdownReport([{ scenario: 'golden-session', bugId: 'GOLDEN-SESSION', verdict: 'INCONCLUSIVE', exitCode: 0 }]);
  assert.match(withGolden, /Golden Session — beat plan/);
  const without = buildMarkdownReport([{ scenario: 'bug-20260629-153258', bugId: 'BUG-20260629-153258', verdict: 'PASS', exitCode: 0 }]);
  assert.equal(/Golden Session — beat plan/.test(without), false, 'the bug sweep report is unchanged');
});

// ── Test double: a Playwright-shaped page that records every interaction ─────
// It answers like a healthy app (a new atlas bubble that settles immediately) and
// records each locator action, so a test can prove exactly which controls were touched.
function fakePage({ replyText = 'On it — logged.', onScreenshot = null } = {}) {
  const calls = [];
  let atlasCount = 0;
  const page = {
    locator(sel) {
      return {
        async fill(v) { calls.push(`fill:${sel}`); this._v = v; page._composer = v; },
        async inputValue() { return page._composer; },
        async click() { calls.push(`click:${sel}`); if (sel === '#preview-btn') atlasCount += 1; },
        async count() { calls.push(`count:${sel}`); return atlasCount; },
        last() { return { async innerText() { return replyText; } }; },
        async isDisabled() { calls.push(`isDisabled:${sel}`); return true; },
        async innerText() { return ''; }
      };
    },
    async waitForTimeout() {},
    async screenshot({ path: p }) { calls.push('screenshot'); if (onScreenshot) onScreenshot(p); }
  };
  return { page, calls };
}
