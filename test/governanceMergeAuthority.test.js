const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// Models the owner-ratified Atlas contract:
// deterministic hard gates + advisory findings + risk-triggered ChatGPT review.
// Cold review is optional confidence work, not a merge requirement.
function evaluateMergeAuthority(pr) {
  const blockers = [];
  const chatgptRequired = Boolean(
    pr.phaseTransition ||
    pr.campaignChange ||
    pr.productDirection ||
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
  if (pr.realP0P1Findings > 0) blockers.push('p0-p1');
  if (pr.realAdvisoryFindingsOpen > 0) blockers.push('advisory-findings');
  if (!pr.riskScopeBranchMergeCardComplete) blockers.push('risk-scope-branch-merge-card');
  if (!pr.branchCurrent || !pr.mergeable) blockers.push('branch-current-mergeable');
  if (chatgptRequired && pr.chatgptReview !== 'pass') blockers.push('chatgpt-risk-review');
  if (pr.ownerAuthorizationOutstanding) blockers.push('owner-authorization');

  const canMerge = blockers.length === 0;

  return {
    canMerge,
    chatgptRequired,
    blockers,
    postMergeContinuation: canMerge
      ? ['verify-main', 'confirm-deployment-when-applicable', 'update-campaign-card', 'fresh-branch', 'continue-next-card']
      : [],
  };
}

const GREEN_ROUTINE_PR = {
  authorizedConcern: true,
  requiredChecksPassed: true,
  realP0P1Findings: 0,
  realAdvisoryFindingsOpen: 0,
  riskScopeBranchMergeCardComplete: true,
  branchCurrent: true,
  mergeable: true,
  ownerAuthorizationOutstanding: false,
  chatgptReview: 'not-required',
};

test('routine green PRs are merge-authorized by Claude without owner handoff', () => {
  const result = evaluateMergeAuthority(GREEN_ROUTINE_PR);
  assert.equal(result.canMerge, true);
  assert.equal(result.chatgptRequired, false);
  assert.deepEqual(result.blockers, []);
});

test('owner authorization remains required only when a reserved decision is outstanding', () => {
  const result = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    ownerAuthorizationOutstanding: true,
  });
  assert.equal(result.canMerge, false);
  assert.deepEqual(result.blockers, ['owner-authorization']);
});

test('campaign transitions and trust changes require ChatGPT Contract Review', () => {
  const withoutReview = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    campaignChange: true,
    chatgptReview: 'missing',
  });
  const withReview = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    phaseTransition: true,
    chatgptReview: 'pass',
  });

  assert.equal(withoutReview.chatgptRequired, true);
  assert.equal(withoutReview.canMerge, false);
  assert.ok(withoutReview.blockers.includes('chatgpt-risk-review'));
  assert.equal(withReview.canMerge, true);
});

test('failed CI and real unresolved findings block merge', async (t) => {
  const cases = [
    ['failed CI', { requiredChecksPassed: false }, 'required-checks'],
    ['P0/P1 finding', { realP0P1Findings: 1 }, 'p0-p1'],
    ['real advisory finding', { realAdvisoryFindingsOpen: 1 }, 'advisory-findings'],
    ['incomplete merge evidence', { riskScopeBranchMergeCardComplete: false }, 'risk-scope-branch-merge-card'],
    ['stale branch', { branchCurrent: false }, 'branch-current-mergeable'],
  ];

  for (const [name, patch, expectedBlocker] of cases) {
    await t.test(name, () => {
      const result = evaluateMergeAuthority({ ...GREEN_ROUTINE_PR, ...patch });
      assert.equal(result.canMerge, false);
      assert.ok(result.blockers.includes(expectedBlocker), result.blockers.join(', '));
    });
  }
});

test('cold-review metadata is not a merge input', () => {
  const result = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    coldReview: null,
  });
  assert.equal(result.canMerge, true);
  assert.deepEqual(result.blockers, []);
});

test('Claude continues the canonical campaign after merge', () => {
  const result = evaluateMergeAuthority(GREEN_ROUTINE_PR);
  assert.deepEqual(result.postMergeContinuation, [
    'verify-main',
    'confirm-deployment-when-applicable',
    'update-campaign-card',
    'fresh-branch',
    'continue-next-card',
  ]);
});

test('CLAUDE.md is canonical and compatibility files define no independent process', () => {
  const claude = read('CLAUDE.md');
  const agents = read('AGENTS.md');
  const codex = read('CODEX.md');

  assert.match(claude, /# Atlas — Canonical Agent Brief/);
  assert.match(claude, /docs\/ATLAS_V1_EXECUTION_PLAN\.md/);

  for (const [name, body] of [['AGENTS.md', agents], ['CODEX.md', codex]]) {
    assert.match(body, /compatibility pointer/i, name);
    assert.match(body, /CLAUDE\.md/, name);
    assert.match(body, /no independent role, review, branch, merge, or sequencing rules/i, name);
  }
});

test('one canonical plan selects work', () => {
  const plan = read('docs/ATLAS_V1_EXECUTION_PLAN.md');
  const index = read('docs/DOCS_INDEX.md');
  const governance = read('docs/GOVERNANCE.md');
  const workflow = read('docs/AGENT_WORKFLOW.md');

  for (const body of [plan, index, governance, workflow]) {
    assert.match(body, /one|sole/i);
    assert.match(body, /ATLAS_V1_EXECUTION_PLAN\.md|canonical execution/i);
  }

  assert.match(plan, /Finish\. Prove\. Declare/);
  assert.match(plan, /first eligible unfinished card/i);
  assert.match(plan, /Do not add a second roadmap/i);
});

test('active governance makes Codex advisory and cold review optional', () => {
  const docs = [
    read('CLAUDE.md'),
    read('docs/AGENT_WORKFLOW.md'),
    read('docs/AUTOMATION_PROTOCOL.md'),
    read('docs/OWNER_CHECKIN_RULES.md'),
    read('.github/PULL_REQUEST_TEMPLATE.md'),
  ].join('\n');

  assert.match(docs, /Codex comments are advisory|Codex review comments are advisory|Codex comments and optional clean-context review are advisory/i);
  assert.match(docs, /optional clean-context review|clean-context review is optional/i);
  assert.match(docs, /not a required status|not a required marker/i);
  assert.doesNotMatch(docs, /cold review is required/i);
  assert.doesNotMatch(docs, /Dale remains the merge authority for owner-reserved PRs/i);
});

test('legacy cold-review gate is explicitly temporary compatibility only', () => {
  const legacyDoc = read('docs/COLD_REVIEW_GATE.md');
  assert.match(legacyDoc, /retired as an Atlas governance requirement/i);
  assert.match(legacyDoc, /temporarily/i);
  assert.match(legacyDoc, /branch protection/i);
  assert.match(legacyDoc, /delete together/i);
});

test('standing authority preserves data-safety owner gates', () => {
  const claude = read('CLAUDE.md');
  assert.match(claude, /No real Google Sheets write without explicit owner authorization/i);
  assert.match(claude, /schema, migration, deletion, credentials, or security-sensitive infrastructure/i);
  assert.match(claude, /Constitution\/Invariant amendments/i);
  assert.match(claude, /One-Brain or other promotion decisions/i);
  assert.match(claude, /routine PRs do not wait for him to click merge/i);
});

test('claude/* and agent/* branches are the campaign branch pattern', () => {
  const workflow = read('docs/AGENT_WORKFLOW.md');
  assert.match(workflow, /`claude\/<concern>` or `agent\/<concern>`/);
  assert.doesNotMatch(workflow, /Never create new `claude\/\*`/);
});
