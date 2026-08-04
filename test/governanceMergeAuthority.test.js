const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// Models the owner-ratified Atlas contract:
// deterministic hard gates + advisory findings + the trigger-based Atlas Contract /
// Systems Review. Builder identity is not a merge input.
//
// The trigger set below is a FIXTURE, deliberately not a second copy of the rule:
// `CLAUDE.md` holds the one authoritative trigger list (expanded 2026-08-03 to cover
// campaign gates, scorecards and counters, adjudicators, rehearsal and test runners,
// evidence collectors, identity and correlation machinery, and phase or count
// advancement). This model reads no document and gates no real PR — it exists to pin
// the SHAPE of the merge decision: a fired trigger without a recorded review blocks.
// Do not read it as the trigger list.
function evaluateMergeAuthority(pr) {
  const blockers = [];
  const reviewRequired = Boolean(
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
  if (reviewRequired && pr.contractReview !== 'pass') blockers.push('contract-systems-review');
  if (pr.ownerAuthorizationOutstanding) blockers.push('owner-authorization');

  const canMerge = blockers.length === 0;

  return {
    canMerge,
    reviewRequired,
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
  contractReview: 'not-required',
};

test('routine green PRs are merge-authorized by the active builder without owner handoff', () => {
  const result = evaluateMergeAuthority(GREEN_ROUTINE_PR);
  assert.equal(result.canMerge, true);
  assert.equal(result.reviewRequired, false);
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

test('campaign transitions and trust changes require the Atlas Contract / Systems Review', () => {
  const withoutReview = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    campaignChange: true,
    contractReview: 'missing',
  });
  const withReview = evaluateMergeAuthority({
    ...GREEN_ROUTINE_PR,
    phaseTransition: true,
    contractReview: 'pass',
  });

  assert.equal(withoutReview.reviewRequired, true);
  assert.equal(withoutReview.canMerge, false);
  assert.ok(withoutReview.blockers.includes('contract-systems-review'));
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

test('the retired cold-review gate is fully removed and no doc mandates a compatibility marker', () => {
  for (const rel of [
    '.github/workflows/cold-review-gate.yml',
    'scripts/cold-review-gate.js',
    'test/cold-review-gate.test.js',
    'docs/COLD_REVIEW_GATE.md',
  ]) {
    assert.ok(!fs.existsSync(path.join(ROOT, rel)), `${rel} must be deleted — cold review is fully retired`);
  }

  for (const rel of [
    'CLAUDE.md',
    'AGENTS.md',
    'CODEX.md',
    'docs/AGENT_WORKFLOW.md',
    'docs/BUILDER_PORTABILITY.md',
    'docs/AUTOMATION_PROTOCOL.md',
    'docs/OWNER_CHECKIN_RULES.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'docs/DOCS_INDEX.md',
  ]) {
    const body = read(rel);
    assert.doesNotMatch(body, /cold-review\/exact-head/i, `${rel} must not reference the retired cold-review status`);
    assert.doesNotMatch(body, /compatibility marker/i, `${rel} must not tell an agent to post a compatibility marker`);
  }

  const result = evaluateMergeAuthority(GREEN_ROUTINE_PR);
  assert.equal(result.canMerge, true);
  assert.deepEqual(result.blockers, []);
});

test('the active builder continues the canonical campaign after merge', () => {
  const result = evaluateMergeAuthority(GREEN_ROUTINE_PR);
  assert.deepEqual(result.postMergeContinuation, [
    'verify-main',
    'confirm-deployment-when-applicable',
    'update-campaign-card',
    'fresh-branch',
    'continue-next-card',
  ]);
});

test('CLAUDE.md stays canonical while AGENTS and CODEX provide the same portability mapping', () => {
  const claude = read('CLAUDE.md');
  const agents = read('AGENTS.md');
  const codex = read('CODEX.md');
  const portability = read('docs/BUILDER_PORTABILITY.md');

  assert.match(claude, /# Atlas — Canonical Agent Brief/);
  assert.match(claude, /docs\/ATLAS_V1_EXECUTION_PLAN\.md/);

  for (const [name, body] of [['AGENTS.md', agents], ['CODEX.md', codex]]) {
    assert.match(body, /compatibility adapter/i, name);
    assert.match(body, /CLAUDE\.md/, name);
    assert.match(body, /BUILDER_PORTABILITY\.md/, name);
    assert.match(body, /active implementation agent|primary implementation and merge agent/i, name);
    assert.match(body, /no independent product, safety, branch, merge, or sequencing rules/i, name);
  }

  assert.match(portability, /Claude Code or Codex as the active implementation agent/i);
  assert.match(portability, /does not select work/i);
  assert.match(portability, /sole active work-selection authority/i);
});

test('one canonical plan selects work', () => {
  const plan = read('docs/ATLAS_V1_EXECUTION_PLAN.md');
  const index = read('docs/DOCS_INDEX.md');
  const governance = read('docs/GOVERNANCE.md');
  const workflow = read('docs/AGENT_WORKFLOW.md');
  const portability = read('docs/BUILDER_PORTABILITY.md');

  for (const body of [plan, index, governance, workflow, portability]) {
    assert.match(body, /one|sole/i);
    assert.match(body, /ATLAS_V1_EXECUTION_PLAN\.md|canonical execution/i);
  }

  assert.match(plan, /Finish\. Prove\. Declare/);
  assert.match(plan, /first eligible unfinished card/i);
  assert.match(plan, /Do not add a second roadmap/i);
});

test('active governance makes independent agent review advisory and optional', () => {
  const docs = [
    read('CLAUDE.md'),
    read('AGENTS.md'),
    read('CODEX.md'),
    read('docs/AGENT_WORKFLOW.md'),
    read('docs/BUILDER_PORTABILITY.md'),
    read('docs/AUTOMATION_PROTOCOL.md'),
    read('docs/OWNER_CHECKIN_RULES.md'),
    read('.github/PULL_REQUEST_TEMPLATE.md'),
  ].join('\n');

  assert.match(docs, /independent agent review[^\n]*advisory|Codex comments are advisory|Codex review comments are advisory/i);
  assert.match(docs, /optional clean-context review|clean-context review is optional|missing optional agent review does not block/i);
  assert.match(docs, /not a required status|not a required marker|not a required marker, status/i);
  assert.doesNotMatch(docs, /cold review is required/i);
  assert.doesNotMatch(docs, /Dale remains the merge authority for owner-reserved PRs/i);
});

test('builder identity is portable without weakening data-safety owner gates', () => {
  const claude = read('CLAUDE.md');
  const agents = read('AGENTS.md');
  const portability = read('docs/BUILDER_PORTABILITY.md');

  assert.match(agents, /Claude Code and Codex are both approved Atlas implementation agents/i);
  assert.match(portability, /same responsibilities and standing authority/i);
  assert.match(portability, /Tool identity never changes production-write, schema, security, invariant, promotion, or owner-evidence gates/i);

  assert.match(claude, /No real Google Sheets write without explicit owner authorization/i);
  assert.match(claude, /schema, migration, deletion, credentials, or security-sensitive infrastructure/i);
  assert.match(claude, /Constitution\/Invariant amendments/i);
  assert.match(claude, /One-Brain or other promotion decisions/i);
  assert.match(claude, /routine PRs do not wait for him to click merge/i);
});

test('new work uses tool-neutral agent branches and prevents duplicate parallel implementation', () => {
  const workflow = read('docs/AGENT_WORKFLOW.md');
  const portability = read('docs/BUILDER_PORTABILITY.md');

  assert.match(workflow, /fresh `agent\/<concern>` branch/);
  assert.match(workflow, /Never run Claude and Codex on the same concern in parallel/i);
  assert.match(portability, /New branches use \*\*`agent\/<concern>`\*\*/);
  assert.match(portability, /Never have Claude and Codex independently implement the same concern/i);
});
