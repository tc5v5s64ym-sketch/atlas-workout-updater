'use strict';

// Build identity helpers — surface the deployed PR number (and commit subject) so
// "is the live app on the right build?" is answerable at a glance, not just from a
// raw SHA. The actual values are captured at BUILD time by scripts/write-build-info.js
// (where .git is present) into public/build-info.json; this module reads + parses them.
//
// Pure / read-only. Degrades to {} when the file is absent so callers fall back to
// the runtime commit SHA (RENDER_GIT_COMMIT) — never throws.

const fs = require('fs');
const path = require('path');

const BUILD_INFO_PATH = path.join(__dirname, '..', 'public', 'build-info.json');

// Pull the PR number out of a merge-commit subject, e.g.
// "Merge pull request #461 from owner/branch" → 461. Null when there's no "#<n>".
function parsePrNumber(subject) {
  const m = String(subject == null ? '' : subject).match(/#(\d+)/);
  return m ? Number(m[1]) : null;
}

// Read the build-info JSON written at build time. Returns {} on any problem.
function readBuildInfo(file = BUILD_INFO_PATH) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    return info && typeof info === 'object' ? info : {};
  } catch (_) {
    return {};
  }
}

module.exports = { parsePrNumber, readBuildInfo, BUILD_INFO_PATH };
