'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePrNumber, readBuildInfo } = require('../services/buildInfo');

describe('parsePrNumber — pull the PR number out of a merge-commit subject', () => {
  it('extracts the number from a GitHub merge commit subject', () => {
    assert.equal(parsePrNumber('Merge pull request #461 from owner/claude/warmup-detector'), 461);
  });
  it('matches a "(#123)" squash-merge style suffix', () => {
    assert.equal(parsePrNumber('Structure all training intents (#459)'), 459);
  });
  it('returns null when there is no PR number', () => {
    assert.equal(parsePrNumber('Fix e1RM trend skew for warm-ups'), null);
    assert.equal(parsePrNumber(''), null);
    assert.equal(parsePrNumber(null), null);
    assert.equal(parsePrNumber(undefined), null);
  });
});

describe('readBuildInfo — read the build-time identity file', () => {
  it('returns {} when the file is absent (caller falls back to the SHA)', () => {
    assert.deepEqual(readBuildInfo(path.join(os.tmpdir(), 'atlas-no-such-build-info.json')), {});
  });
  it('returns {} on malformed JSON (never throws)', () => {
    const f = path.join(os.tmpdir(), `atlas-bad-build-info-${process.pid}.json`);
    fs.writeFileSync(f, '{ not json');
    try { assert.deepEqual(readBuildInfo(f), {}); } finally { fs.unlinkSync(f); }
  });
  it('parses a well-formed build-info file', () => {
    const f = path.join(os.tmpdir(), `atlas-build-info-${process.pid}.json`);
    fs.writeFileSync(f, JSON.stringify({ commit: 'abc1234def', commit_short: 'abc1234', pr: 461, subject: 'Merge pull request #461 from x', built_at: '2026-06-21T15:00:00Z' }));
    try {
      const info = readBuildInfo(f);
      assert.equal(info.pr, 461);
      assert.equal(info.commit_short, 'abc1234');
    } finally { fs.unlinkSync(f); }
  });
});
