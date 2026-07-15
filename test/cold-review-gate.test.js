const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS_CONTEXT,
  MAX_DESCRIPTION,
  isTrusted,
  parseColdReviewMarker,
  selectLatestMarker,
  shaMatches,
  evaluateColdReview,
} = require('../scripts/cold-review-gate');

const HEAD = '0bdcf281a1b2c3d4e5f60718293a4b5c6d7e8f90';

function comment(overrides = {}) {
  return {
    id: 1,
    author_association: 'OWNER',
    created_at: '2026-07-15T12:00:00Z',
    updated_at: '2026-07-15T12:00:00Z',
    body: `Cold review: PASS\nReviewed head: ${HEAD}\nP0/P1 findings: 0`,
    ...overrides,
  };
}

test('parseColdReviewMarker: returns null for a non-marker body', () => {
  assert.equal(parseColdReviewMarker('LGTM, ship it'), null);
  assert.equal(parseColdReviewMarker(''), null);
  assert.equal(parseColdReviewMarker(null), null);
});

test('parseColdReviewMarker: parses a PASS marker with sha and findings', () => {
  const m = parseColdReviewMarker(`Cold review: PASS\nReviewed head: ${HEAD}\nP0/P1 findings: 0`);
  assert.equal(m.verdict, 'pass');
  assert.equal(m.reviewedSha, HEAD);
  assert.equal(m.findings, 0);
});

test('parseColdReviewMarker: tolerates markdown quoting, backticks, and short sha', () => {
  const m = parseColdReviewMarker('> **Cold review:** PASS\n> Reviewed head: `0bdcf28`\n> P0/P1 findings: 2');
  assert.equal(m.verdict, 'pass');
  assert.equal(m.reviewedSha, '0bdcf28');
  assert.equal(m.findings, 2);
});

test('parseColdReviewMarker: parses N/A exemption and captures the reason', () => {
  const m = parseColdReviewMarker('Cold review: N/A (trivial docs-only)');
  assert.equal(m.verdict, 'na');
  assert.equal(m.reason, '(trivial docs-only)');
  assert.equal(m.reviewedSha, null);
  assert.equal(m.findings, null);
});

test('parseColdReviewMarker: PASS without findings line leaves findings null', () => {
  const m = parseColdReviewMarker(`Cold review: PASS\nReviewed head: ${HEAD}`);
  assert.equal(m.verdict, 'pass');
  assert.equal(m.findings, null);
});

test('isTrusted: only OWNER/MEMBER/COLLABORATOR count', () => {
  assert.equal(isTrusted('OWNER'), true);
  assert.equal(isTrusted('member'), true);
  assert.equal(isTrusted('COLLABORATOR'), true);
  assert.equal(isTrusted('CONTRIBUTOR'), false);
  assert.equal(isTrusted('NONE'), false);
  assert.equal(isTrusted(undefined), false);
});

test('shaMatches: prefix match works, mismatch and too-short fail', () => {
  assert.equal(shaMatches(HEAD, HEAD), true);
  assert.equal(shaMatches('0bdcf281', HEAD), true);
  assert.equal(shaMatches(HEAD, '0bdcf281'), true);
  assert.equal(shaMatches('deadbeef', HEAD), false);
  assert.equal(shaMatches('0bdcf2', HEAD), false); // < 7 shared chars
  assert.equal(shaMatches('', HEAD), false);
  assert.equal(shaMatches(null, HEAD), false);
});

test('selectLatestMarker: newest trusted marker wins over an older one', () => {
  const older = comment({ id: 1, updated_at: '2026-07-15T10:00:00Z', body: 'Cold review: PASS\nReviewed head: deadbeef1234\nP0/P1 findings: 0' });
  const newer = comment({ id: 2, updated_at: '2026-07-15T12:00:00Z' });
  const picked = selectLatestMarker([older, newer]);
  assert.equal(picked.comment.id, 2);
});

test('selectLatestMarker: ignores markers from untrusted authors', () => {
  const untrusted = comment({ id: 3, author_association: 'CONTRIBUTOR' });
  assert.equal(selectLatestMarker([untrusted]), null);
});

test('evaluateColdReview: PASS marker matching the head passes', () => {
  const r = evaluateColdReview({ comments: [comment()], headSha: HEAD });
  assert.equal(r.state, 'success');
  assert.equal(r.context, STATUS_CONTEXT);
});

test('evaluateColdReview: no marker fails as "no cold review"', () => {
  const r = evaluateColdReview({ comments: [comment({ body: 'nice work' })], headSha: HEAD });
  assert.equal(r.state, 'failure');
  assert.match(r.description, /No cold review recorded/i);
});

test('evaluateColdReview: an untrusted PASS does not pass the gate', () => {
  const r = evaluateColdReview({ comments: [comment({ author_association: 'NONE' })], headSha: HEAD });
  assert.equal(r.state, 'failure');
});

test('evaluateColdReview: a review of an older head is stale and fails', () => {
  const stale = comment({ body: 'Cold review: PASS\nReviewed head: deadbeef1234567\nP0/P1 findings: 0' });
  const r = evaluateColdReview({ comments: [stale], headSha: HEAD });
  assert.equal(r.state, 'failure');
  assert.match(r.description, /stale/i);
});

test('evaluateColdReview: unresolved P0/P1 findings block', () => {
  const withFindings = comment({ body: `Cold review: PASS\nReviewed head: ${HEAD}\nP0/P1 findings: 3` });
  const r = evaluateColdReview({ comments: [withFindings], headSha: HEAD });
  assert.equal(r.state, 'failure');
  assert.match(r.description, /P0\/P1 finding/i);
});

test('evaluateColdReview: PASS missing the findings line fails', () => {
  const noFindings = comment({ body: `Cold review: PASS\nReviewed head: ${HEAD}` });
  const r = evaluateColdReview({ comments: [noFindings], headSha: HEAD });
  assert.equal(r.state, 'failure');
  assert.match(r.description, /P0\/P1 findings/i);
});

test('evaluateColdReview: PASS missing the reviewed-head line fails', () => {
  const noSha = comment({ body: 'Cold review: PASS\nP0/P1 findings: 0' });
  const r = evaluateColdReview({ comments: [noSha], headSha: HEAD });
  assert.equal(r.state, 'failure');
  assert.match(r.description, /Reviewed head/i);
});

test('evaluateColdReview: a head-bound N/A exemption passes', () => {
  const na = comment({ body: `Cold review: N/A (trivial docs-only)\nReviewed head: ${HEAD}` });
  const r = evaluateColdReview({ comments: [na], headSha: HEAD });
  assert.equal(r.state, 'success');
  assert.match(r.description, /N\/A/i);
});

test('evaluateColdReview: an N/A exemption without a reviewed head fails', () => {
  const na = comment({ body: 'Cold review: N/A (trivial docs-only)' });
  const r = evaluateColdReview({ comments: [na], headSha: HEAD });
  assert.equal(r.state, 'failure');
  assert.match(r.description, /Reviewed head/i);
});

test('evaluateColdReview: a stale N/A exemption (old head) fails after a new push', () => {
  const na = comment({ body: 'Cold review: N/A (trivial docs-only)\nReviewed head: deadbeef1234567' });
  const r = evaluateColdReview({ comments: [na], headSha: HEAD });
  assert.equal(r.state, 'failure');
  assert.match(r.description, /stale|exemption/i);
});

test('evaluateColdReview: a fresh stale review overrides an older passing one', () => {
  // Owner re-reviewed after a push but the new review has a mismatched sha.
  const oldPass = comment({ id: 1, updated_at: '2026-07-15T10:00:00Z' });
  const newStale = comment({ id: 2, updated_at: '2026-07-15T13:00:00Z', body: 'Cold review: PASS\nReviewed head: feedface1234567\nP0/P1 findings: 0' });
  const r = evaluateColdReview({ comments: [oldPass, newStale], headSha: HEAD });
  assert.equal(r.state, 'failure');
  assert.match(r.description, /stale/i);
});

test('evaluateColdReview: descriptions never exceed the 140-char commit-status cap', () => {
  const cases = [
    { comments: [], headSha: HEAD },
    { comments: [comment()], headSha: HEAD },
    { comments: [comment({ body: 'Cold review: PASS\nReviewed head: deadbeef1234567\nP0/P1 findings: 0' })], headSha: HEAD },
    { comments: [comment({ body: `Cold review: PASS\nReviewed head: ${HEAD}\nP0/P1 findings: 9` })], headSha: HEAD },
  ];
  for (const c of cases) {
    const r = evaluateColdReview(c);
    assert.ok(r.description.length <= MAX_DESCRIPTION, `too long: ${r.description}`);
  }
});
