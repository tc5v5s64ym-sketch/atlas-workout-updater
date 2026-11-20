'use strict';

// #1791 — server-enforced preview-to-approve on /api/log-workout.
//
// The dry-run preview returns a signed digest of the exact rows it showed;
// a live write must present that digest, and the server recomputes it over
// the rows the write would actually append before any append happens. A
// direct write that skips the preview (or edits the rows after previewing)
// is refused with 409, never written.
//
// Digest scope — the exact rows as previewed (formatted, post-dedupe):
//   { v: 1, session_id, date, log_rows, effort_row, closeout_context? }
// where log_rows are the formatted Log_Cleaned arrays the preview returned
// (previewLogRows) and effort_row is the formatted Effort array (or null).
// The live path recomputes over its own partition result (rowsToWrite), so a
// sheet-state change between preview and approve that alters the written set
// fails the digest and the client re-previews. The all-duplicates replay
// (nothing to write) skips verification — nothing is written, so there is
// nothing to bind.
//
// Secret — ATLAS_SESSION_SECRET (the established server-side HMAC secret,
// services/session.js), domain-separated by the purpose label in the signed
// data, so a session token can never pass as a digest or vice versa. When
// the secret is unset, a per-process random secret is generated once: digests
// then survive only within the process lifetime, and a restart between preview
// and approve yields a clean re-preview error. No new env var to provision.
//
// The digest is a bearer capability for one write, not a secret to publish:
// it is never logged and never recorded in the turn-write-proof record
// (PROOF_KEYS deliberately does not carry it, mirroring the pairing token).

const crypto = require('crypto');
const { stableStringify } = require('./writeOutcomes');

const DIGEST_VERSION = 1;
const DIGEST_PREFIX = 'pd1.';
const DOMAIN = 'atlas-preview-digest-v1';

// Lazily generated once per process when ATLAS_SESSION_SECRET is unset.
let ephemeralSecret = null;

function previewDigestSecret() {
  const configured = process.env.ATLAS_SESSION_SECRET || '';
  if (configured) return Buffer.from(configured, 'utf8');
  if (!ephemeralSecret) ephemeralSecret = crypto.randomBytes(32);
  return ephemeralSecret;
}

// The canonical digest payload. Both the preview mint site and the live
// verify site build it from their own locally-computed values, so the
// canonicalization is shared and cannot drift between the two call sites.
// logRows are formatted Log_Cleaned arrays; effortRow is the formatted
// Effort array or null. closeout_context rides along only when the caller
// carries one, so a previewed closeout cannot be re-aimed at approve time.
function previewDigestPayload({ sessionId, date, logRows, effortRow, closeoutContext }) {
  const payload = {
    v: DIGEST_VERSION,
    session_id: String(sessionId || ''),
    date: String(date || ''),
    log_rows: Array.isArray(logRows) ? logRows : [],
    effort_row: effortRow === undefined || effortRow === null ? null : effortRow,
  };
  if (closeoutContext !== undefined) payload.closeout_context = closeoutContext;
  return payload;
}

function signPreviewDigest(payload, secret) {
  const body = `${DOMAIN}\n${stableStringify(payload)}`;
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

// Mint a digest for the exact rows a preview showed. Returns the opaque
// token the client carries back on the approve (`preview_digest`).
function mintPreviewDigest(fields) {
  const payload = previewDigestPayload(fields);
  return `${DIGEST_PREFIX}${signPreviewDigest(payload, previewDigestSecret())}`;
}

// Verify a presented digest against the rows a live write would append.
// Fails closed on any malformed input: non-string, wrong prefix, wrong
// length, or signature mismatch all return false, never throw.
function verifyPreviewDigest(digest, fields) {
  try {
    if (typeof digest !== 'string' || !digest.startsWith(DIGEST_PREFIX)) return false;
    const presented = digest.slice(DIGEST_PREFIX.length);
    if (!presented) return false;
    const payload = previewDigestPayload(fields);
    const expected = signPreviewDigest(payload, previewDigestSecret());
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

module.exports = {
  DIGEST_VERSION,
  DIGEST_PREFIX,
  previewDigestPayload,
  mintPreviewDigest,
  verifyPreviewDigest,
  // Exported for tests only: prove the ephemeral fallback is per-process.
  _previewDigestSecret: previewDigestSecret,
};
