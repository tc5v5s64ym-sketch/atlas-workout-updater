'use strict';
// #1791 — shared test helper: preview-then-write for /api/log-workout.
//
// A live write requires the signed preview digest of the exact rows a
// dry-run preview showed. Route tests that used to POST a live write
// directly must preview first and carry the digest on the live write —
// exactly what the app's approve flow does. This helper does the two-step
// dance against the calling file's own `post` helper, so each file keeps its
// fake sheets and its own post shape.
//
// `post(path, payload)` is the file's helper. It may return either the
// fetch idiom `{ response, body }` (response.status, body.data), the
// node-fetch idiom `{ res, body }`, or the compact idiom `{ status, body }`.
// The preview uses the SAME write_id as the live write (mirroring the client): a preview never consumes the id
// (test_mode returns before beginWrite), so idempotency-retry tests keep
// their semantics.
//
// Returns the live-write result in the file's own shape. Throws (via the
// caller's assert) when the preview itself does not succeed, so a broken
// preview fails loudly instead of producing a confusing digest refusal.
const assert = require('node:assert/strict');

function statusOf(result) {
  if (result && result.response && typeof result.response.status === 'number') return result.response.status;
  if (result && result.res && typeof result.res.status === 'number') return result.res.status;
  if (result && typeof result.status === 'number') return result.status;
  return undefined;
}

function bodyOf(result) {
  return (result && result.body) || {};
}

// Preview `payload` (test_mode) and return the signed digest the preview
// minted. `label` names the caller in the failure message. Returns null
// when the preview itself is refused: the preview and the live write share
// the validation path, so a preview refusal IS the live refusal (same status
// + message) — the caller returns it as the response instead of posting.
async function previewDigestFor(post, payload, label = 'previewDigestFor') {
  const preview = await post('/api/log-workout', { ...payload, test_mode: true });
  const status = statusOf(preview);
  if (status !== 200) return null;
  const digest = bodyOf(preview).data && bodyOf(preview).data.preview_digest;
  assert.equal(typeof digest, 'string', `${label}: preview must mint a preview_digest`);
  assert.ok(digest.length > 0, `${label}: preview_digest must be non-empty`);
  return digest;
}

// Preview `payload`, then post the live write carrying the digest. Returns
// the live-write result in the file's own post shape — or the preview's
// refusal when the preview itself fails validation (see previewDigestFor).
async function postLiveLogWorkout(post, payload, label = 'postLiveLogWorkout') {
  const preview = await post('/api/log-workout', { ...payload, test_mode: true });
  const status = statusOf(preview);
  if (status !== 200) return preview;
  const digest = bodyOf(preview).data && bodyOf(preview).data.preview_digest;
  assert.equal(typeof digest, 'string', `${label}: preview must mint a preview_digest`);
  assert.ok(digest.length > 0, `${label}: preview_digest must be non-empty`);
  return post('/api/log-workout', { ...payload, preview_digest: digest });
}

module.exports = { previewDigestFor, postLiveLogWorkout };
