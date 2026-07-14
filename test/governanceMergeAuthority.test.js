const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// Models the post-cutover Atlas merge-authority contract (CLAUDE.md, canonical):
// deterministic hard gates + a clean-context cold review (required for
// non-trivial PRs) + a risk-triggered ChatGPT Atlas Contract Review. Native
// Codex GitHub Review is retired as a required gate.
function evaluateMergeAuthority(pr) {
  const blockers = [];
  const chatgptRequired = Boolean(
    pr.ownerReserved ||
    pr.highRisk ||
    pr.phaseTransition ||
    pr.governance ||
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

  // Trivial docs-only typo/status/index PRs may merge on deterministic CI alone.
  const coldReviewRequired = !pr.trivialDocsOnly;

  if (!pr.authorizedConcern) blockers.push('unauthorized-concern');
  if (!pr.requiredChecksPassed) blockers.push('required-checks');
  if (coldReviewRequired) {
    if (!pr.coldReview || pr.coldReview.headSha !== pr.headSha) blockers.push('cold-review-missing-or-wrong-head');
    if (pr.coldReview && !pr.coldReview.cleanContext) blockers.push('cold-review-not-clean-context');
    if (pr.coldReview && pr.coldReview.stale) blockers.push('cold-review-stale');
    if (pr.coldReview && pr.coldReview.status !== 'pass') blockers.push('cold-review-not-pass');
  }
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
    coldReviewRequired,
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
  trivialDocsOnly: false,
  coldReview: { headSha: 'abc123', cleanContext: true, stale: false, status: 'pass' },
  p0p1Findings: 0,
  unresolvedActionableThreads: 0,
  riskScopeBranchMergeCardComplete: true,
  branchCurrent: true,
  mergeable: true,
  ownerReserved: false,
  chatgptReview: 'not-required',
};

test('routine green PRs are merge-authorized by Claude without owner handoff', () => {
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

test('governance and phase-transition PRs require a passing ChatGPT Contract Review', () => {
  const governanceWithoutReview = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    governance: true,
    chatgptReview: 'missing',
  });
  const phaseTransitionWithReview = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    phaseTransition: true,
    chatgptReview: 'pass',
  });

  assert.equal(governanceWithoutReview.chatgptRequired, true);
  assert.equal(governanceWithoutReview.canRoutineMerge, false);
  assert.ok(governanceWithoutReview.blockers.includes('chatgpt-risk-review'));

  assert.equal(phaseTransitionWithReview.chatgptRequired, true);
  assert.equal(phaseTransitionWithReview.canRoutineMerge, true);
});

test('failed CI and a missing, stale, or non-clean-context cold review never authorize merge', async (t) => {
  const cases = [
    ['failed CI', { requiredChecksPassed: false }, 'required-checks'],
    ['missing cold review', { coldReview: null }, 'cold-review-missing-or-wrong-head'],
    ['wrong-head cold review', { coldReview: { headSha: 'old', cleanContext: true, stale: false, status: 'pass' } }, 'cold-review-missing-or-wrong-head'],
    ['not-clean-context cold review', { coldReview: { headSha: 'abc123', cleanContext: false, stale: false, status: 'pass' } }, 'cold-review-not-clean-context'],
    ['stale cold review', { coldReview: { headSha: 'abc123', cleanContext: true, stale: true, status: 'pass' } }, 'cold-review-stale'],
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

test('trivial docs-only PRs may merge on deterministic CI without a cold review', () => {
  const trivialDocs = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    trivialDocsOnly: true,
    coldReview: null,
  });

  assert.equal(trivialDocs.coldReviewRequired, false);
  assert.equal(trivialDocs.canRoutineMerge, true);
  assert.deepEqual(trivialDocs.blockers, []);
});

test('Claude continues after a successful routine merge', () => {
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

test('CLAUDE.md is the canonical brief and AGENTS.md/CODEX.md are pointers only', () => {
  const claude = read('CLAUDE.md');
  const agents = read('AGENTS.md');
  const codex = read('CODEX.md');

  // CLAUDE.md is canonical.
  assert.match(claude, /canonical/i);
  assert.match(claude, /# Atlas — AI Agent Operating Brief/);

  // AGENTS.md and CODEX.md are compatibility pointers with no independent rules.
  for (const [name, body] of [['AGENTS.md', agents], ['CODEX.md', codex]]) {
    assert.match(body, /compatibility pointer/i, name);
    assert.match(body, /\bCLAUDE\.md\b/, name);
    assert.match(body, /no independent role, review, branch, or merge rules/i, name);
    // They must not re-assert canonical authority for themselves.
    assert.doesNotMatch(body, /is the canonical implementation-agent (entry point|brief) for Atlas/i, name);
  }
});

test('no required native Codex review gate remains in active governance', () => {
  const docs = [
    read('CLAUDE.md'),
    read('docs/AGENT_WORKFLOW.md'),
    read('docs/AUTOMATION_PROTOCOL.md'),
    read('docs/OWNER_CHECKIN_RULES.md'),
    read('.github/PULL_REQUEST_TEMPLATE.md'),
  ].join('\n');

  // Native Codex GitHub Review is retired as a gate; auto-comments are advisory.
  assert.match(docs, /Native Codex GitHub Review is (retired|no longer a required gate)/);
  assert.match(docs, /advisory only/);

  // The old mandatory-native-review and @codex-review-as-delivery-step language is gone.
  assert.doesNotMatch(docs, /native Codex GitHub Review is mandatory/i);
  assert.doesNotMatch(docs, /Requests?\b[^\n]*@codex review[^\n]*after the final push/i);
});

test('active governance pins Claude-led cold-review merge authority', () => {
  const docs = [
    read('CLAUDE.md'),
    read('docs/AGENT_WORKFLOW.md'),
    read('docs/AUTOMATION_PROTOCOL.md'),
    read('docs/OWNER_CHECKIN_RULES.md'),
    read('.github/PULL_REQUEST_TEMPLATE.md'),
  ].join('\n');

  assert.match(docs, /Claude may merge routine PRs/);
  assert.match(docs, /Dale remains required for owner-only or gym evidence/);
  assert.match(docs, /cold review/i);
  assert.match(docs, /clean-context/i);
  assert.match(docs, /Never merge when a required check or the exact-head cold review is missing/);
  assert.match(docs, /Atlas Contract Review is risk-triggered/);
  assert.match(docs, /continue the next approved concern/);
});

test('claude/* and agent/* branches are allowed and no longer forbidden', () => {
  const workflow = read('docs/AGENT_WORKFLOW.md');

  assert.match(workflow, /`claude\/\*` or `agent\/\*` branches only for new agent work/);
  assert.doesNotMatch(workflow, /Never create new `claude\/\*`/);
});
