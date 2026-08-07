'use strict';

// THE COACH LLM, PINNED — so a read measurement cannot depend on the runner's environment.
//
// WHAT WENT WRONG. The read-budget harness measured 46 reads on the builder's machine and 45
// in CI, and `/api/coach/chat` answered `served:yes` locally and `served:no` in CI. The cause
// was not the harness and not the request body: `GEMINI_API_KEY` happened to be present in the
// builder's container and absent in CI. The route branches on it —
//
//   configured   → it grounds the answer, reading Coaching_Notes + Constraints + Log_Cleaned
//                  in ONE batchGet, and words the reply through the model;
//   unconfigured → "No Sheets read on the unconfigured path" (routes/coachOps.js), answering
//                  from client context only.
//
// So the whole measurement silently depended on an ambient environment variable, and — worse —
// every local run made a REAL network call to Gemini, which is nondeterministic, slow, and
// sends synthetic athlete text to an external provider from a unit test.
//
// WHICH BRANCH IS THE TRUTH. Production runs configured, and the captured session came from
// production, so the configured path is the one the budget must model. That is also the more
// expensive branch, which is the right way for a lower bound to be wrong if it is wrong.
//
// WHAT THIS DOES. It makes "configured" true in EVERY environment and answers the model call
// from memory:
//   - sets a fake `GEMINI_API_KEY`, always — including where a real one exists, so no test
//     ever reaches the network, and the builder's machine and CI run the same code path;
//   - replaces `fetch` for the Gemini host ONLY, returning a canned response in the real
//     `generateContent` shape; every other fetch is passed through untouched.
//
// Nothing else is stubbed. The route, its grounding read, the sanitizers and the voice
// finalizer all run exactly as in production — only the model's own words are fixed, and
// those words are the one thing that never affects a Sheets read.

const GEMINI_HOST = 'generativelanguage.googleapis.com';

// A plain, on-topic reply. Deliberately carries no number: `stripFabricatedUnits` and the
// voice validator run for real over it, and a number here would invite them to disagree
// with an engine fact that this fixture knows nothing about.
const CANNED_REPLY = 'Keep the same target and focus on clean execution.';

let calls = 0;
let installed = false;
let realFetch = null;

function geminiResponse() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { candidates: [{ content: { parts: [{ text: CANNED_REPLY }] } }] };
    },
    async text() {
      return CANNED_REPLY;
    },
  };
}

/**
 * Pin the coach LLM for this process. Idempotent, and safe to call before the app loads.
 * Returns the canned reply so a caller can assert on the exact words if it wants to.
 */
function installFakeCoachLlm() {
  if (installed) return CANNED_REPLY;
  installed = true;

  // ALWAYS overwrite. Reading a real key here is what made the measurement environmental in
  // the first place — the point is that this file, not the container, decides.
  process.env.GEMINI_API_KEY = 'fake-key-installed-by-test-harness';

  realFetch = global.fetch;
  global.fetch = async function fakeFetch(url, options) {
    const href = typeof url === 'string' ? url : (url && url.url) || '';
    if (href.includes(GEMINI_HOST)) {
      calls += 1;
      return geminiResponse();
    }
    if (!realFetch) throw new Error(`unexpected fetch to ${href} with no real fetch available`);
    return realFetch(url, options);
  };
  return CANNED_REPLY;
}

/** How many model calls the pinned coach served since the last reset. */
function geminiCallCount() {
  return calls;
}

function resetGeminiCalls() {
  calls = 0;
}

module.exports = { installFakeCoachLlm, geminiCallCount, resetGeminiCalls, CANNED_REPLY, GEMINI_HOST };
