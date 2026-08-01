'use strict';

// ── Measuring the source tree a Stage-A run executed from — ONE implementation ──
//
// Two callers need these facts at two different moments, and they must be the SAME facts:
//
//   scripts/atlas-stage-a-session.js  — to REFUSE before the browser opens.
//   tests/e2e/gate/stage-a-canary.spec.js — to RECORD what the run actually ran from.
//
// The spec measures for itself rather than trusting values handed to it on the environment.
// That difference matters for exactly the reason this whole mode exists: evidence that a
// launcher ASSERTED is weaker than evidence the run OBSERVED, and a published artifact
// claiming "clean main at <sha>" should be a measurement, not a repeated claim.
//
// Impure by necessity (it shells out to git and reads the plan), which is why it is separate
// from `stage-a-run-purpose.js` — the rules that DECIDE stay pure and unit-testable, and this
// only reports what it saw. Every failure path returns an absent value rather than a guess:
// the deciding rules treat absent evidence as a refusal, so a git that cannot answer can
// never produce a green source-tree claim.
//
// Sunset: deleted with the rest of the temporary Phase 4 Stage-A machinery, in the same PR
// that records Stage A at 5/5.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { parseCanonicalStageACount } = require('./stage-a-run-purpose');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const PLAN_RELATIVE_PATH = path.join('docs', 'ATLAS_V1_EXECUTION_PLAN.md');

function git(args, repoRoot) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// Refresh origin/main so "HEAD equals origin/main" is measured against the real remote
// rather than a stale local ref, which would let a superseded tree look current. Best
// effort: a failure here leaves the local ref in place and is reported, never hidden.
function fetchOriginMain(repoRoot = REPO_ROOT) {
  try {
    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Returns the shape both the preflight and the scorecard consume. `clean` is tri-state:
// true, false, or undefined when git could not answer — never defaulted to either.
function measureSourceTree(repoRoot = REPO_ROOT) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const head = git(['rev-parse', 'HEAD'], repoRoot);
  const originHead = git(['rev-parse', 'origin/main'], repoRoot);
  const status = git(['status', '--porcelain'], repoRoot);
  // `git status` returning '' is ambiguous between "clean" and "the command failed", so the
  // determination is made only when git could answer at all (proven by HEAD resolving).
  const clean = head ? status === '' : undefined;

  let planText = '';
  try {
    planText = fs.readFileSync(path.join(repoRoot, PLAN_RELATIVE_PATH), 'utf8');
  } catch {
    planText = '';
  }
  const canonical = parseCanonicalStageACount(planText);

  return {
    branch,
    head_sha: head,
    origin_head_sha: originHead,
    clean,
    prior_stage_a_count: canonical.ok ? canonical.count : null,
    prior_count_reason: canonical.reason,
  };
}

module.exports = { REPO_ROOT, PLAN_RELATIVE_PATH, fetchOriginMain, measureSourceTree };
