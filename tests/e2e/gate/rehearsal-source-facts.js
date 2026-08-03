'use strict';

// ── Measuring the source tree an F-SB4B rehearsal run executed from — ONE implementation ──
// TEMPORARY F-SB4B machinery (sunset: F-SB4C), adapted from the proven Stage A module
// (stage-a-source-facts.js, sunset PR #1234).
//
// Two callers need these facts at two different moments, and they must be the SAME facts:
//   scripts/atlas-rehearsal-session.js — to REFUSE before the browser opens.
//   tests/e2e/gate/rehearsal.spec.js   — to RECORD what the run actually ran from.
// The spec measures for itself rather than trusting values handed to it on the
// environment: evidence a launcher ASSERTED is weaker than evidence the run OBSERVED.
//
// Impure by necessity (shells out to git, reads the plan); the rules that DECIDE stay
// pure in rehearsal-run-purpose.js. Every failure path returns an absent value rather
// than a guess — the deciding rules treat absent evidence as a refusal.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { parseCanonicalRehearsalCount } = require('./rehearsal-run-purpose');

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
// rather than a stale local ref. Best effort: a failure is reported, never hidden.
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
  const clean = head ? status === '' : undefined;

  let planText = '';
  try {
    planText = fs.readFileSync(path.join(repoRoot, PLAN_RELATIVE_PATH), 'utf8');
  } catch {
    planText = '';
  }
  const canonical = parseCanonicalRehearsalCount(planText);

  return {
    branch,
    head_sha: head,
    origin_head_sha: originHead,
    clean,
    prior_rehearsal_count: canonical.ok ? canonical.count : null,
    prior_count_reason: canonical.reason,
  };
}

module.exports = { REPO_ROOT, PLAN_RELATIVE_PATH, fetchOriginMain, measureSourceTree };
