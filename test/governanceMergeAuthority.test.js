const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function evaluateMergeAuthority(pr) {
  const blockers = [];
  const chatgptRequired = Boolean(
    pr.ownerReserved ||
    pr.highRisk ||
    pr.phaseTransition ||
    pr.roadmapOrVision ||
    pr.coachingPhilosophy ||
    pr.trustContract ||
    pr.writeOrSchema ||
    pr.securityOrCredentials ||
    pr.runtimeModel ||
    pr.promotion ||
    pr.destructive ||
    pr.ambiguous,
  );

  if (!pr.authorizedConcern) blockers.push('unauthorized-concern');
  if (!pr.requiredChecksPassed) blockers.push('required-checks');
  if (!pr.nativeReview || pr.nativeReview.headSha !== pr.headSha) blockers.push('native-review-missing-or-wrong-head');
  if (pr.nativeReview && !pr.nativeReview.requestedAfterFinalPush) blockers.push('native-review-not-requested-after-final-push');
  if (pr.nativeReview && pr.nativeReview.stale) blockers.push('native-review-stale');
  if (pr.nativeReview && pr.nativeReview.status !== 'pass') blockers.push('native-review-not-pass');
  if (pr.p0p1Findings > 0) blockers.push('p0-p1');
  if (pr.unresolvedActionableThreads > 0) blockers.push('unresolved-actionable-review-thread');
  if (!pr.riskScopeBranchMergeCardComplete) blockers.push('risk-scope-branch-merge-card');
  if (!pr.branchCurrent || !pr.mergeable) blockers.push('branch-current-mergeable');
  if (chatgptRequired && pr.chatgptReview !== 'pass') blockers.push('chatgpt-risk-review');
  if (pr.ownerReserved) blockers.push('owner-reserved');

  const canRoutineMerge = blockers.length === 0;

  return {
    canRoutineMerge,
    mustStopForDale: pr.ownerReserved && blockers.every((b) => b === 'owner-reserved'),
    chatgptRequired,
    blockers,
    postMergeContinuation: canRoutineMerge
      ? ['verify-main', 'confirm-deployment-read-only-when-applicable', 'fresh-branch', 'continue-next-approved-concern']
      : [],
  };
}

const GREEN_ROUTINE_PR = {
  headSha: 'abc123',
  authorizedConcern: true,
  requiredChecksPassed: true,
  nativeReview: { headSha: 'abc123', requestedAfterFinalPush: true, stale: false, status: 'pass' },
  p0p1Findings: 0,
  unresolvedActionableThreads: 0,
  riskScopeBranchMergeCardComplete: true,
  branchCurrent: true,
  mergeable: true,
  ownerReserved: false,
  chatgptReview: 'not-required',
};

test('routine green PRs are merge-authorized without owner handoff', () => {
  const result = evaluateMergeAuthority(GREEN_ROUTINE_PR);

  assert.equal(result.canRoutineMerge, true);
  assert.equal(result.chatgptRequired, false);
  assert.deepEqual(result.blockers, []);
});

test('owner-reserved PRs still stop for Dale after non-owner gates pass', () => {
  const result = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    ownerReserved: true,
    chatgptReview: 'pass',
  });

  assert.equal(result.canRoutineMerge, false);
  assert.equal(result.mustStopForDale, true);
  assert.deepEqual(result.blockers, ['owner-reserved']);
});

test('stale or missing review and failed CI never authorize merge', async (t) => {
  const cases = [
    ['failed CI', { requiredChecksPassed: false }, 'required-checks'],
    ['missing native review', { nativeReview: null }, 'native-review-missing-or-wrong-head'],
    ['wrong-head native review', { nativeReview: { headSha: 'old', requestedAfterFinalPush: true, stale: false, status: 'pass' } }, 'native-review-missing-or-wrong-head'],
    ['stale native review', { nativeReview: { headSha: 'abc123', requestedAfterFinalPush: true, stale: true, status: 'pass' } }, 'native-review-stale'],
    ['unresolved actionable thread', { unresolvedActionableThreads: 1 }, 'unresolved-actionable-review-thread'],
  ];

  for (const [name, patch, expectedBlocker] of cases) {
    await t.test(name, () => {
      const result = evaluateMergeAuthority({ ...GREEN_ROUTINE_PR, ...patch });
      assert.equal(result.canRoutineMerge, false);
      assert.ok(result.blockers.includes(expectedBlocker), result.blockers.join(', '));
    });
  }
});

test('Codex continues after a successful routine merge', () => {
  const result = evaluateMergeAuthority(GREEN_ROUTINE_PR);

  assert.deepEqual(result.postMergeContinuation, [
    'verify-main',
    'confirm-deployment-read-only-when-applicable',
    'fresh-branch',
    'continue-next-approved-concern',
  ]);
});

test('ChatGPT review is risk-triggered, not required on every routine PR', () => {
  const routine = evaluateMergeAuthority(GREEN_ROUTINE_PR);
  const trustRiskWithoutReview = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    trustContract: true,
    chatgptReview: 'missing',
  });

  assert.equal(routine.canRoutineMerge, true);
  assert.equal(routine.chatgptRequired, false);
  assert.equal(trustRiskWithoutReview.canRoutineMerge, false);
  assert.equal(trustRiskWithoutReview.chatgptRequired, true);
  assert.ok(trustRiskWithoutReview.blockers.includes('chatgpt-risk-review'));
});

test('active governance docs pin risk-based automation-first merge authority', () => {
  const docs = [
    read('AGENTS.md'),
    read('docs/AGENT_WORKFLOW.md'),
    read('docs/AUTOMATION_PROTOCOL.md'),
    read('docs/OWNER_CHECKIN_RULES.md'),
    read('.github/PULL_REQUEST_TEMPLATE.md'),
  ].join('\n');

  assert.match(docs, /Codex may merge routine PRs/);
  assert.match(docs, /Dale remains required for owner-only or gym evidence/);
  assert.match(docs, /Never merge when a required check or exact-head native review is missing, stale/);
  assert.match(docs, /ChatGPT review is risk-triggered|ChatGPT Atlas Contract Review is risk-triggered/);
  assert.match(docs, /continue the next approved concern/);
});
