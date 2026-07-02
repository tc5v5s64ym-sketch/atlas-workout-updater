'use strict';

// Preview card deduplication (owner live-test gap, 2026-06-28).
//
// When the user previews a workout (sets only) and then adds manual effort via
// "Add effort & preview", atlas:preview-ready fires a second time. Without this
// fix, handlePreviewReady always called appendAtlasBubble(), producing two
// stacked "Today's workout" cards in the thread.
//
// The fix: before appending a new bubble, check whether a .review card already
// exists in .chat-bubble-atlas. If so, update that bubble in place (clear the
// body text, remove the old card, rebuild) instead of appending a second one.
//
// Structural source-introspection tests — no jsdom dependency.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'coach-conversation.js'),
  'utf8'
);

// Locate the handlePreviewReady function body for targeted assertions.
const fnStart = src.indexOf('async function handlePreviewReady(');
assert.ok(fnStart >= 0, 'handlePreviewReady must exist in coach-conversation.js');
// Grab enough source to cover the full function (up to buildReviewCard call).
const fnSrc = src.slice(fnStart, fnStart + 3100);

test('handlePreviewReady: checks for an existing unsaved .review card before appending a new bubble', () => {
  // :not(.done) excludes already-saved cards so a second-workout preview in the
  // same page session never clobbers a saved card from the first workout.
  assert.match(fnSrc, /querySelector.*\.review:not\(\.done\)/,
    'must query for an existing unsaved .review card (:not(.done)) to avoid clobbering saved cards');
});

test('handlePreviewReady: removes the existing .review card when updating in place', () => {
  assert.match(fnSrc, /existingCard\.remove\(\)|\.remove\(\)/,
    'must call .remove() on the existing card before rebuilding');
});

test('handlePreviewReady: clears the body text of the existing bubble (no stale intro)', () => {
  assert.match(fnSrc, /existingBody\.textContent\s*=\s*''|\.textContent\s*=\s*''/,
    'must clear body textContent before retyping the intro');
});

test('handlePreviewReady: falls back to appendAtlasBubble when no existing card found', () => {
  // Both the "existing card" branch and the "no existing card" branch must
  // reach appendAtlasBubble — the former as a safety fallback, the latter as
  // the normal new-session path.
  const callCount = (fnSrc.match(/appendAtlasBubble\(\)/g) || []).length;
  assert.ok(callCount >= 2,
    'appendAtlasBubble() must appear at least twice: the fallback + the new-bubble path');
});

test('handlePreviewReady: still appends buildReviewCard to the (possibly reused) bubble', () => {
  assert.match(fnSrc, /bubble\.appendChild\(buildReviewCard\(/,
    'must still call bubble.appendChild(buildReviewCard(...)) in both branches');
});
