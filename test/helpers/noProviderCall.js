'use strict';

// ── Unit-test hermeticity: a unit test may never reach a provider ──────────────
//
// WHY. `services/intentRouter.classifyIntent` reads `process.env.GEMINI_API_KEY`
// and, when one is present, issues a real `fetch` to
// `generativelanguage.googleapis.com` (services/intentRouter.js). The shadow unit
// tests inject their own `append` through `_resetForTesting` but historically left
// `classify` alone, so the REAL classifier ran. The tests then failed on a machine
// with credentials in `.env` and passed in credential-free CI — the same test
// asserting different things depending on whether a secret existed. A unit test
// that changes behavior because a credential is present is not a unit test.
//
// This helper supplies the two halves of the fix.
//
// `silentClassifier()` is a deterministic stand-in for `classifyIntent`. It returns
// `null`, which is EXACTLY what the real classifier returns with no API key
// (`if (!apiKey) return null`). Credential-free behavior is therefore byte-identical
// to before: the shadow records an `ok:false` entry and still mirrors the row.
// Nothing these tests prove changes; only the dependence on ambient secrets goes.
//
// `recordProviderCalls()` is the BITE. Stubbing the classifier alone would rot
// silently — delete the stub and credential-free CI stays green while a credentialed
// machine quietly makes network calls again. This wraps a section in a `fetch`
// tripwire and reports every outbound attempt, so hermeticity is proven rather than
// assumed. It trips on the ATTEMPT, so it needs no network and no credential to work.
//
// Deliberately generic: it traps ANY `fetch`, not only Gemini. A unit test that
// starts talking to any host fails here.

/** A deterministic classifier that never touches the network. */
function silentClassifier() {
  return async () => null;
}

/**
 * Run `fn` with `globalThis.fetch` replaced by a tripwire, and return the hosts of
 * every outbound attempt (empty when hermetic).
 *
 * Returns attempts rather than asserting, because the shadow lanes are
 * fire-and-forget by design: the call can land AFTER `fn` resolves, so the caller
 * must be able to drain pending work inside `fn` before judging.
 *
 * The rejection keeps the caller's own error handling on its normal path — the real
 * classifier already treats a failed fetch as `null` — so the tripwire changes what
 * is OBSERVED, never what the code under test does on the happy path.
 */
async function recordProviderCalls(fn) {
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = (...args) => {
    // Record the host only. A URL can carry a key in its query string, and this
    // message reaches CI logs.
    let host = 'unknown-host';
    try {
      const raw = args[0];
      host = new URL(typeof raw === 'string' ? raw : (raw && raw.url) || '').host || host;
    } catch { /* unparseable target — the attempt still counts */ }
    attempts.push(host);
    return Promise.reject(new Error(`unit test attempted a network call to ${host}`));
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return attempts;
}

module.exports = { silentClassifier, recordProviderCalls };
