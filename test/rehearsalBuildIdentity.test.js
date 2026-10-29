'use strict';

// F-SB4B served-client build-identity bites (TEMPORARY; sunset: F-SB4C). Proves
// the rehearsal can never again score a run against a stale client build: the
// served bundle in public/ is gitignored build output, the gate server never
// rebuilds it, and run fsb4b-s3-20261029T101354-B9957C scored a Session 3 FAIL
// against a client built from 9f96cb8f (2026-10-27) while the server and tests
// executed fresh from the verified head — four merged client fixes were inert
// in the browser. These bites pin the three enforcements:
//   evaluateBuildIdentity — the pure comparison (match / mismatch / absent);
//   checkServedBuildIdentity — the pre-turn machinery abort and its record;
//   scorecard condition 6 — the recorded comparison re-judged after the run.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MACHINERY_ABORT_MARKER, measureServedBuild, evaluateBuildIdentity, checkServedBuildIdentity,
} = require('../tests/e2e/gate/rehearsal-build-identity');
const { scoreRehearsalRun, PASS, FAIL, ERROR } = require('../tests/e2e/gate/rehearsal-scorecard');

const SOURCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
// The actual stale build commit from the 2026-10-29 incident bundle.
const STALE = '9f96cb8fd4c6070005a5bade5a9c62c4f09f6321';

function condition(card, id) {
  const c = card.conditions.find((x) => x.id === id);
  assert.ok(c, `condition ${id} must be emitted`);
  return c;
}

describe('evaluateBuildIdentity — the pure comparison', () => {
  it('passes when the served build commit equals the verified source', () => {
    const v = evaluateBuildIdentity({ buildInfo: { commit: SOURCE }, sourceHeadSha: SOURCE });
    assert.equal(v.ok, true);
    assert.equal(v.served_commit, SOURCE);
    assert.equal(v.source_sha, SOURCE);
    assert.equal(v.reason, null);
  });

  it('refuses a stale build and names BOTH commits', () => {
    const v = evaluateBuildIdentity({ buildInfo: { commit: STALE }, sourceHeadSha: SOURCE });
    assert.equal(v.ok, false);
    assert.match(v.reason, new RegExp(STALE));
    assert.match(v.reason, new RegExp(SOURCE));
    assert.match(v.reason, /stale client build/);
  });

  it('refuses when build-info is missing entirely (null)', () => {
    const v = evaluateBuildIdentity({ buildInfo: null, sourceHeadSha: SOURCE });
    assert.equal(v.ok, false);
    assert.match(v.reason, /build-info\.json could not be read/);
  });

  it('refuses when build-info records no commit', () => {
    const v = evaluateBuildIdentity({ buildInfo: { built_at: '2026-10-27T23:51:02.400Z' }, sourceHeadSha: SOURCE });
    assert.equal(v.ok, false);
    assert.match(v.reason, /records no commit/);
  });

  it('refuses a build identity that is not a full commit sha', () => {
    const v = evaluateBuildIdentity({ buildInfo: { commit: '9f96cb8' }, sourceHeadSha: SOURCE });
    assert.equal(v.ok, false);
    assert.match(v.reason, /not a full commit sha/);
  });

  it('refuses when the verified source is not a full commit sha — the comparison cannot be made', () => {
    const v = evaluateBuildIdentity({ buildInfo: { commit: SOURCE }, sourceHeadSha: '' });
    assert.equal(v.ok, false);
    assert.match(v.reason, /verified source sha/);
  });
});

describe('measureServedBuild + checkServedBuildIdentity — the pre-turn machinery abort', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-build-identity-'));
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const stampBuild = (commit) => fs.writeFileSync(
    path.join(root, 'public', 'build-info.json'),
    `${JSON.stringify({ commit, commit_short: commit.slice(0, 7) })}\n`,
  );

  it('measureServedBuild returns the parsed build-info, and null when absent or malformed', () => {
    assert.equal(measureServedBuild(root), null);
    stampBuild(STALE);
    assert.equal(measureServedBuild(root).commit, STALE);
    fs.writeFileSync(path.join(root, 'public', 'build-info.json'), '{not json');
    assert.equal(measureServedBuild(root), null);
  });

  it('a stale served build aborts and records MACHINERY_ABORT.json — started:false, both commits, the reason', () => {
    stampBuild(STALE);
    const artifactDir = path.join(root, 'artifacts');
    const v = checkServedBuildIdentity({ repoRoot: root, sourceHeadSha: SOURCE, artifactDir, runId: 'fsb4b-s3-test' });
    assert.equal(v.ok, false);
    const record = JSON.parse(fs.readFileSync(path.join(artifactDir, MACHINERY_ABORT_MARKER), 'utf8'));
    assert.equal(record.started, false);
    assert.equal(record.kind, 'MACHINERY_ABORT');
    assert.equal(record.run_id, 'fsb4b-s3-test');
    assert.equal(record.served_build_commit, STALE);
    assert.equal(record.source_sha, SOURCE);
    assert.match(record.reason, /stale client build/);
    // The session-start marker must NOT exist: its absence is what makes the
    // operator command classify the run NOT STARTED.
    assert.equal(fs.existsSync(path.join(artifactDir, 'RUN_START.json')), false);
  });

  it('an aligned served build passes and records no abort', () => {
    stampBuild(SOURCE);
    const artifactDir = path.join(root, 'artifacts');
    const v = checkServedBuildIdentity({ repoRoot: root, sourceHeadSha: SOURCE, artifactDir, runId: 'fsb4b-s1-test' });
    assert.equal(v.ok, true);
    assert.equal(v.served_commit, SOURCE);
    assert.equal(fs.existsSync(path.join(artifactDir, MACHINERY_ABORT_MARKER)), false);
  });

  it('a missing build-info aborts too — an unidentifiable client never runs', () => {
    const artifactDir = path.join(root, 'artifacts');
    const v = checkServedBuildIdentity({ repoRoot: root, sourceHeadSha: SOURCE, artifactDir, runId: 'fsb4b-s1-test' });
    assert.equal(v.ok, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(artifactDir, MACHINERY_ABORT_MARKER), 'utf8')).started, false);
  });
});

describe('scorecard condition 6 — the recorded comparison, re-judged', () => {
  // Skeletal observation sets: every other condition ERRORs on the absent
  // branches (fail-closed by design); these bites judge condition 6 alone.
  const obsWithBuild = (buildCommit) => ({
    run_purpose: 'REHEARSAL_SESSION',
    session_number: 1,
    source: { branch: 's3-maintenance', clean: true, head_sha: SOURCE, origin_head_sha: SOURCE, prior_rehearsal_count: 0 },
    ui: { real_browser: true, shell_build: 'shell v146', ...(buildCommit === undefined ? {} : { build_commit: buildCommit }) },
  });

  it('PASSES when the recorded served build commit equals the verified source, naming both', () => {
    const c = condition(scoreRehearsalRun(obsWithBuild(SOURCE)), 'real_browser_built_client');
    assert.equal(c.status, PASS);
    assert.match(c.detail, new RegExp(`served build commit ${SOURCE} == verified source ${SOURCE}`));
  });

  it('FAILS a stale served build, naming the mismatch — the 2026-10-29 incident shape', () => {
    const c = condition(scoreRehearsalRun(obsWithBuild(STALE)), 'real_browser_built_client');
    assert.equal(c.status, FAIL);
    assert.match(c.detail, new RegExp(`built from commit ${STALE}`));
    assert.match(c.detail, new RegExp(`verified source is ${SOURCE}`));
    assert.match(c.detail, /stale client build/);
  });

  it('ERRORs when the run recorded no served build commit — old artifacts cannot pass on silence', () => {
    const c = condition(scoreRehearsalRun(obsWithBuild(undefined)), 'real_browser_built_client');
    assert.equal(c.status, ERROR);
    assert.match(c.detail, /no served build commit/);
  });

  it('ERRORs when the recorded served build commit is not a full sha', () => {
    const c = condition(scoreRehearsalRun(obsWithBuild('9f96cb8')), 'real_browser_built_client');
    assert.equal(c.status, ERROR);
    assert.match(c.detail, /not a full commit sha/);
  });
});
