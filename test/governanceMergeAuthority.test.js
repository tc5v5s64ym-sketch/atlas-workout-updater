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

test('CLAUDE.md stays canonical, AGENTS.md is the entrypoint, and CODEX.md is only a pointer', () => {
  const claude = read('CLAUDE.md');
  const agents = read('AGENTS.md');
  const codex = read('CODEX.md');
  const portability = read('docs/BUILDER_PORTABILITY.md');

  assert.match(claude, /# Atlas — Canonical Agent Brief/);
  assert.match(claude, /docs\/ATLAS_V1_EXECUTION_PLAN\.md/);
  // One canonical brief under its historical filename. A second one would be a second authority.
  assert.ok(!fs.existsSync(path.join(ROOT, 'ATLAS.md')), 'no second canonical brief may exist');
  assert.match(agents, /no second canonical brief/i);

  assert.match(agents, /universal entrypoint/i);
  for (const [name, body] of [['AGENTS.md', agents], ['CODEX.md', codex]]) {
    assert.match(body, /CLAUDE\.md/, name);
    assert.match(body, /approved active implementation agent/i, name);
  }
  assert.match(agents, /BUILDER_PORTABILITY\.md/);
  assert.match(agents, /defines no independent product, safety, branch, merge, or sequencing rules/i);
  // CODEX.md is a pointer: it carries no authority and no competing workflow.
  assert.match(codex, /AGENTS\.md/);
  assert.match(codex, /carries no implementation authority/i);
  assert.match(codex, /defines no product, safety, branch, merge, sequencing, or review rule/i);

  assert.match(portability, /approved active implementation agent/i);
  assert.match(portability, /does not select work/i);
  assert.match(portability, /sole active work-selection authority/i);
});

// The authority correction (owner instruction 2026-08-05). Atlas work is implemented by a
// ROLE, not by a product name. These tests pin the role's canonical definition, its reach
// across surfaces, and — the load-bearing part — that no ACTIVE governance surface still
// grants that role exclusively to a named tool.
test('the approved-active-agent definition is canonical, in CLAUDE.md, and stated once', () => {
  const claude = read('CLAUDE.md');

  assert.match(claude, /\*\*Definition \(canonical; every other document points here\)\.\*\*/,
    'CLAUDE.md must carry the one canonical definition');
  assert.match(claude, /\*\*approved active implementation agent\*\* is the one agent Dale has approved/i);
  assert.match(claude, /It is a role, not a product name/i);
  assert.match(claude, /Claude Code, Codex, Cursor, or another owner-approved implementation surface/i);
  assert.match(claude, /Two agents never hold the role for the same concern at the same time/i);

  // Every other surface points at the definition rather than restating it, so there is
  // exactly one place to change if the role changes.
  for (const rel of ['AGENTS.md', 'docs/BUILDER_PORTABILITY.md', 'docs/AGENT_WORKFLOW.md']) {
    const body = read(rel);
    assert.match(body, /approved active implementation agent/i, rel);
    assert.match(body, /CLAUDE\.md/, `${rel} must point at the canonical definition`);
    assert.doesNotMatch(body, /\*\*Definition \(canonical/i, `${rel} must not carry a second canonical definition`);
  }
});

test('a Cursor agent is covered by the same workflow, with no second Cursor authority', () => {
  const claude = read('CLAUDE.md');
  const agents = read('AGENTS.md');
  const portability = read('docs/BUILDER_PORTABILITY.md');
  const workflow = read('docs/AGENT_WORKFLOW.md');

  for (const [rel, body] of [['CLAUDE.md', claude], ['AGENTS.md', agents],
    ['docs/BUILDER_PORTABILITY.md', portability], ['docs/AGENT_WORKFLOW.md', workflow]]) {
    assert.match(body, /Cursor/, `${rel} must name Cursor as a covered surface`);
  }
  assert.match(claude, /do not change branch rules, one-concern discipline[^.]*merge authority/i);

  // A Cursor pointer may exist, but only as a pointer. Anything that defines Atlas rules
  // inside .cursor would be a second governance authority — the exact thing being removed.
  const cursorDir = path.join(ROOT, '.cursor');
  if (fs.existsSync(cursorDir)) {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(cursorDir);
    assert.ok(files.length <= 1, `.cursor may hold at most one pointer file, found ${files.length}`);
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8');
      assert.match(body, /AGENTS\.md/, `${file} must point at AGENTS.md`);
      assert.ok(body.split('\n').filter((l) => l.trim()).length <= 10,
        `${file} must stay a pointer, not a governance system`);
      // A pointer never restates a rule it cannot own.
      for (const forbidden of [/merge (?:the exact|when)/i, /owner-reserved/i, /test_mode/i, /preview → approve/i]) {
        assert.doesNotMatch(body, forbidden, `${file} must not duplicate Atlas governance`);
      }
    }
  }
});

test('no active governance surface grants implementation authority to a named tool alone', () => {
  // ACTIVE authority surfaces only. Historical records, dated evidence, and the execution
  // plan's own history legitimately name the agent that did the work; rewriting those would
  // falsify the record. What must not survive is a LIVE rule that reads "Claude implements"
  // or "Codex implements" as though the tool name were the authority.
  const ACTIVE = [
    'CLAUDE.md',
    'AGENTS.md',
    'CODEX.md',
    'README.md',
    'docs/AGENT_WORKFLOW.md',
    'docs/BUILDER_PORTABILITY.md',
    'docs/DECISION_KERNEL.md',
    'docs/AUTOMATION_PROTOCOL.md',
    'docs/OWNER_CHECKIN_RULES.md',
    'docs/DOCS_INDEX.md',
    'docs/CODEX_SESSION_STARTER.md',
    'docs/CONTROLLED_TECHNICAL_WRITING.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ];
  const EXCLUSIVE = [
    // "Claude merges", "Claude Code merges", "Codex merges" — the tool as merge operator.
    /\b(?:Claude(?: Code)?|Codex)\s+(?:merges|selects|implements|opens and completes)\b/i,
    // "Claude Code and Codex are both approved" / "Claude Code or Codex as the active agent"
    /Claude Code (?:and|or|↔) Codex/i,
    /both approved Atlas implementation agents/i,
    // A two-tool closed set stated as the rule.
    /Never run Claude and Codex/i,
    /Never have Claude and Codex/i,
  ];

  for (const rel of ACTIVE) {
    const body = read(rel);
    for (const pattern of EXCLUSIVE) {
      assert.doesNotMatch(body, pattern,
        `${rel} still grants implementation authority to a named tool: ${pattern}`);
    }
  }
});

test('historical and compatibility references may name a tool without becoming authority', () => {
  // The legacy map must SURVIVE. Deleting it would strand every historical `claude/*`
  // branch, `.claude/rules/*` path, and CLAUDE.md reference with nothing explaining them.
  const portability = read('docs/BUILDER_PORTABILITY.md');
  const agents = read('AGENTS.md');

  assert.match(portability, /Legacy wording map/i);
  assert.match(portability, /`claude\/<concern>` branches\*\* remain valid historical branches/i);
  assert.match(portability, /`\.claude\/rules\/\*`\*\* are retained filenames/i);
  assert.match(portability, /keeps its historical filename/i);
  assert.match(agents, /Legacy wording map/i);

  // The map is a bridge, not an authority: it explicitly carries none.
  assert.match(portability, /carry no implementation authority/i);
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

  assert.match(agents, /Claude Code, Codex, Cursor, and any other owner-approved implementation surface may hold it/i);
  assert.match(portability, /same responsibilities and standing authority/i);
  assert.match(portability, /Surface identity and model identity never change production-write, schema, security, invariant, promotion, or owner-evidence gates/i);

  assert.match(claude, /No real Google Sheets write without explicit owner authorization/i);
  assert.match(claude, /schema, migration, deletion, credentials, or security-sensitive infrastructure/i);
  assert.match(claude, /Constitution\/Invariant amendments/i);
  assert.match(claude, /One-Brain or other promotion decisions/i);
  assert.match(claude, /routine PRs do not wait for him to click merge/i);
});

test('new work uses tool-neutral agent branches and prevents duplicate parallel implementation', () => {
  const claude = read('CLAUDE.md');
  const workflow = read('docs/AGENT_WORKFLOW.md');
  const portability = read('docs/BUILDER_PORTABILITY.md');

  assert.match(workflow, /fresh `agent\/<concern>` branch/);
  assert.match(workflow, /Never run two implementation agents on the same concern in parallel/i);
  assert.match(portability, /New branches use \*\*`agent\/<concern>`\*\*/);
  assert.match(portability, /Two agents never implement the same concern/i);
  // The canonical brief agrees: new work is `agent/<concern>` on every surface.
  assert.match(claude, /Create a fresh `agent\/<concern>` branch from current `main`/);
  assert.match(claude, /New work uses `agent\/<concern>` from current `main`/);
});

test('one compact launcher exists, it is tool-neutral, and it selects only plan work', () => {
  const agents = read('AGENTS.md');

  const launcher = /> Read `AGENTS\.md` and execute the first eligible unfinished Atlas concern as the approved active implementation agent\. Use a fresh `agent\/<concern>` branch\. Stop only for an owner-reserved gate or required external review\./;
  assert.match(agents, launcher, 'AGENTS.md must carry the one compact launcher');
  assert.match(agents, /This is the one implementation launcher\. Do not write a second one\./);

  // Tool-neutral: the launcher itself names no tool and no model.
  const quoted = launcher.exec(agents)[0];
  for (const tool of [/Claude/i, /Codex/i, /Cursor/i, /Opus/i, /GPT/i]) {
    assert.doesNotMatch(quoted, tool, `the launcher must name no tool or model: ${tool}`);
  }

  // It must not license backlog, retired-plan, or chat-history work selection.
  assert.match(agents, /Never select work from `BACKLOG\.md`, a retired plan, an audit, a proposal, a standalone issue, Git history, or a chat transcript/i);

  // Every other surface points here instead of carrying a competing launcher.
  for (const rel of ['CLAUDE.md', 'docs/AGENT_WORKFLOW.md', 'docs/BUILDER_PORTABILITY.md', 'docs/CODEX_SESSION_STARTER.md']) {
    const body = read(rel);
    assert.match(body, /one compact (?:implementation )?launcher|carries the one compact launcher/i, rel);
    assert.doesNotMatch(body, /Act as the active Atlas implementation agent\. Verify current state/i,
      `${rel} must not carry a second launcher`);
  }
});

test('the fresh-agent cold-start acceptance trial is documented, bounded, and unclaimed', () => {
  const portability = read('docs/BUILDER_PORTABILITY.md');
  const agents = read('AGENTS.md');

  assert.match(portability, /## Fresh-agent cold-start acceptance trial/);
  assert.match(agents, /cold-start acceptance trial/i, 'the entrypoint must reach the trial');

  // The launcher a human copies to run it later.
  const trialLauncher = /> Read `AGENTS\.md` and perform the documented Atlas fresh-agent cold-start acceptance trial\. Make no edits and invoke no live service\. Report the required evidence and stop\./;
  assert.match(portability, trialLauncher);
  assert.match(agents, trialLauncher);

  // All ten required report items.
  const REQUIRED = [
    /current `main` SHA/i,
    /whether local `main` equals `origin\/main`/i,
    /open PR state/i,
    /current campaign and count state/i,
    /the first eligible action, or the exact blocker/i,
    /every owner-reserved stop relevant to that action/i,
    /the required branch form/i,
    /status, unit, lint, guard, secret-scan, and browser-test commands/i,
    /whether the Atlas Contract \/ Systems Review would be required/i,
    /what it is explicitly forbidden to do next/i,
  ];
  for (const item of REQUIRED) {
    assert.match(portability, item, `cold-start checklist is missing: ${item}`);
  }

  // Bounds: read-only, no live service, no rehearsal, no configuration change.
  for (const bound of [
    /makes no file edit/i,
    /creates no branch/i,
    /makes no provider call/i,
    /makes no Google Sheets request/i,
    /runs no qualifying rehearsal session/i,
    /changes no deployment and no configuration/i,
  ]) {
    assert.match(portability, bound, `cold-start bound is missing: ${bound}`);
  }

  // No PASS may be claimed from repository structure alone.
  assert.match(portability, /Structural readiness in the repository is not a PASS/i);
  assert.match(portability, /only after a real fresh agent on a new surface performs the trial/i);
});

test('the merge card is the sole attribution authority and names all four fields', () => {
  const claude = read('CLAUDE.md');
  const template = read('.github/PULL_REQUEST_TEMPLATE.md');

  assert.match(claude, /## Merge-card attribution/);
  assert.match(claude, /The card is the sole attribution authority/i);
  assert.match(claude, /declared evidence\*\*, not cryptographic proof/i);
  assert.match(claude, /Never guess a model identity/i);
  assert.match(claude, /grants no authority/i);

  for (const field of ['Builder surface', 'Primary builder model', 'Supporting / explore models', 'Architecture / dispatch authority']) {
    assert.ok(claude.includes(field), `CLAUDE.md must name the "${field}" field`);
    assert.ok(template.includes(field), `the PR template must ship the "${field}" row`);
  }
});
