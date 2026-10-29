'use strict';

// ── F-SB4B served-client build identity (TEMPORARY; sunset: F-SB4C) ────────────
//
// THE DEFECT THIS MODULE EXISTS TO CLOSE. The rehearsal's gate server serves the
// app from `public/` (express.static in index.js) — gitignored Vite build output.
// The gate server requires index.js directly and calls app.listen itself, so the
// app's build-if-missing guard (ensurePublicBuilt, which fires only from the
// `npm start` path) never runs, and NOTHING in the run path rebuilt the client.
// A bundle built from an OLDER commit therefore served silently while the server
// and the tests executed fresh from the verified tree: run
// fsb4b-s3-20261029T101354-B9957C scored a Session 3 FAIL against a client built
// 2026-10-27 from 9f96cb8f — every src/app fix merged after that build (PRs
// #1328, #1332 client parts, #1582, #1597) was inert in the browser while the
// run claimed to measure the verified head. Condition 6 asked only that SOME
// build identity exist, so the mismatch was invisible to the scorecard.
//
// THE RULE: the client the browser runs must be the build OF THE EXACT VERIFIED
// SOURCE TREE. The served build's identity is public/build-info.json — the same
// file express.static serves alongside the bundle and services/buildInfo.js
// reads — and it is compared against the source SHA the run verified. Enforced
// at three moments, all decided HERE so there is one rule to attack in a test:
//   1. scripts/atlas-rehearsal-session.js BUILDS the client from the verified
//      tree after preflight and re-verifies the stamp before spawning
//      Playwright (a build failure is a machinery refusal, NOT STARTED);
//   2. tests/e2e/gate/rehearsal.spec.js re-checks in beforeAll — before the
//      gate server spawns and before any athlete turn can exist — and aborts
//      as machinery (NOT STARTED) on mismatch, recording MACHINERY_ABORT.json
//      in the run's artifact directory. This covers every path that reaches
//      the spec without the operator command's build step;
//   3. the scorecard's condition 6 re-judges the RECORDED comparison after the
//      run, so a run's own evidence states both commits it was judged on.
//
// Measure/decide split, as in rehearsal-source-facts.js / rehearsal-run-purpose.js:
// measureServedBuild reads the file and never guesses; evaluateBuildIdentity is
// pure and decides.

const fs = require('node:fs');
const path = require('node:path');

const SHA_RE = /^[0-9a-f]{40}$/;
const BUILD_INFO_RELATIVE_PATH = path.join('public', 'build-info.json');
// The durable record of a pre-turn machinery abort. The session-start marker
// (RUN_START.json) is deliberately NOT written for an abort: its absence is
// what classifies the run NOT STARTED. This file states WHY, in the artifacts.
const MACHINERY_ABORT_MARKER = 'MACHINERY_ABORT.json';

// ── measure ────────────────────────────────────────────────────────────────────
// The build identity the gate server will serve from <repoRoot>. Returns the
// parsed build-info object, or null when the file is absent, unreadable, or not
// a JSON object — absent evidence, never a fabricated one.
function measureServedBuild(repoRoot) {
  if (!repoRoot) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, BUILD_INFO_RELATIVE_PATH), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── decide (pure) ──────────────────────────────────────────────────────────────
// { ok, served_commit, source_sha, reason }. Fail-closed on every absent or
// malformed input: a comparison that cannot be made is a refusal, never a pass.
function evaluateBuildIdentity(input) {
  const i = input && typeof input === 'object' ? input : {};
  const info = i.buildInfo && typeof i.buildInfo === 'object' ? i.buildInfo : null;
  const served = info && typeof info.commit === 'string' ? info.commit.trim() : '';
  const source = typeof i.sourceHeadSha === 'string' ? i.sourceHeadSha.trim() : '';
  const base = { served_commit: served || null, source_sha: source || null };
  if (!info) {
    return { ...base, ok: false, reason: 'public/build-info.json could not be read — the served client carries no recorded build identity, so it cannot be tied to the verified source' };
  }
  if (!served) {
    return { ...base, ok: false, reason: 'public/build-info.json records no commit — the served client cannot be tied to the verified source' };
  }
  if (!SHA_RE.test(served)) {
    return { ...base, ok: false, reason: `the served client's recorded build identity "${served}" is not a full commit sha — it cannot be compared to the verified source` };
  }
  if (!SHA_RE.test(source)) {
    return { ...base, ok: false, reason: `the verified source sha "${source || 'nothing'}" is not a full commit sha — the served build cannot be compared to it` };
  }
  if (served !== source) {
    return { ...base, ok: false, reason: `the served client was built from commit ${served} but the verified source is ${source} — a stale client build would run under this source's name; rebuild the client from the verified tree (npm run build) before running` };
  }
  return { ...base, ok: true, reason: null };
}

// ── the pre-turn enforcement (spec beforeAll) ──────────────────────────────────
// Measure + decide; on refusal, record the machinery abort in the run's artifact
// directory BEFORE returning, so the artifacts state the machinery failure even
// when the run is driven outside the operator command. Never throws — the
// caller throws with the reason so the failure surfaces in the run transcript.
function checkServedBuildIdentity({ repoRoot, sourceHeadSha, artifactDir, runId } = {}) {
  const verdict = evaluateBuildIdentity({ buildInfo: measureServedBuild(repoRoot), sourceHeadSha });
  if (!verdict.ok && artifactDir) {
    try {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, MACHINERY_ABORT_MARKER), `${JSON.stringify({
        started: false,
        kind: 'MACHINERY_ABORT',
        at: new Date().toISOString(),
        boundary: 'no synthetic athlete turn was submitted — the session never began (NOT STARTED)',
        run_id: runId || null,
        served_build_commit: verdict.served_commit,
        source_sha: verdict.source_sha,
        reason: verdict.reason,
      }, null, 2)}\n`);
    } catch { /* the verdict still refuses; the record is best-effort */ }
  }
  return verdict;
}

module.exports = {
  SHA_RE,
  BUILD_INFO_RELATIVE_PATH,
  MACHINERY_ABORT_MARKER,
  measureServedBuild,
  evaluateBuildIdentity,
  checkServedBuildIdentity,
};
