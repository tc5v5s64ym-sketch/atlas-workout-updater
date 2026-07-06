'use strict';

// Capture the deployed build's identity at BUILD time (when .git is present, e.g.
// during Render's install/build step) into public/build-info.json, so /version and
// the in-app build badge can show the PR number + commit subject — not just a SHA.
//
// Best-effort: any failure leaves the file unwritten and the app falls back to the
// runtime commit SHA (RENDER_GIT_COMMIT). This script must NEVER fail the install.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parsePrNumber } = require('../services/buildInfo');

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return '';
  }
}

try {
  // Prefer the commit Render injects; fall back to local git HEAD for dev builds.
  const commit = (process.env.RENDER_GIT_COMMIT || sh('git rev-parse HEAD')).trim();
  const subject = (commit ? sh(`git log -1 --pretty=%s ${commit}`) : '') || sh('git log -1 --pretty=%s');
  const info = {
    commit,
    commit_short: commit ? commit.slice(0, 7) : '',
    pr: parsePrNumber(subject),
    subject,
    built_at: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(__dirname, '..', 'public', 'build-info.json'),
    JSON.stringify(info, null, 2) + '\n'
  );
   
  console.log(`[build-info] commit=${info.commit_short || 'unknown'} pr=${info.pr != null ? info.pr : '-'}`);
} catch (_) {
  // Never break the install/build over a diagnostics file.
}
