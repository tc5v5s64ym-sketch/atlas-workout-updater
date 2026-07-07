'use strict';

// Regression — the Flight Recorder's UI snapshot must capture the coach's ACTUAL
// visible message, so a snapshot updates when the user logs a workout or asks a
// question. The old selector ('.coach-guide-box, #coach-opening, .coach-message')
// always matched `.coach-guide-box` — the home hero WRAPPER, first in tree order
// (`.coach-message` doesn't exist) — so every snapshot reported the persistent hero's
// stale idle greeting — "Still here. Moderate load, 6–12 reps…" — no matter what the
// coach actually said. This
// isn't a lost/overwritten API response (replies render fine as `.coach-msg`
// bubbles); it's the observability capture layer reading the wrong element.
//
// This drives the extracted, exported latestCoachMessage() against a minimal DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
// PR-08: the client is an ES module now — dynamic import (Node 20 CI has no
// require(esm)). In Node `document` is undefined, so the module attaches nothing.
let client;
test.before(async () => { client = await import('../src/app/flightRecorder.js'); });

const IDLE = "Good evening, Dale.\n Still here. Moderate load, 6–12 reps, higher volume whenever you're ready.";

// Minimal document stub: enough for latestCoachMessage() (querySelectorAll for the
// coach reply bubbles + getElementById for the home hero / opener).
function fakeDoc({ bubbles = [], heroHidden = false, hasHero = true, opening = null }) {
  return {
    querySelectorAll(sel) {
      if (sel === '.chat-bubble-atlas .coach-msg') return bubbles.map(t => ({ textContent: t }));
      return [];
    },
    getElementById(id) {
      if (id === 'coach-empty') return hasHero ? { hasAttribute: n => n === 'hidden' && heroHidden } : null;
      if (id === 'coach-opening') return opening == null ? null : { textContent: opening };
      return null;
    }
  };
}

function withDoc(doc, fn) {
  const prev = global.document;
  global.document = doc;
  try { return fn(); } finally {
    if (prev === undefined) delete global.document; else global.document = prev;
  }
}

test('coach_message reflects the newest rendered reply after a log / question (not the idle hero)', () => {
  const reply = "Nice — 225×5 logged, a top-set PR. Next up: Seated Row.";
  const msg = withDoc(fakeDoc({
    bubbles: ['Logged. One more set?', reply], // newest last
    heroHidden: true, // conversation started → hero hidden (but still in the DOM)
    opening: IDLE
  }), () => client.latestCoachMessage());
  assert.equal(msg, reply, 'must report the most recent coach reply bubble');
  assert.notEqual(msg, client.truncate(IDLE.trim(), 400), 'must NOT report the stale idle greeting');
});

test('coach question reply updates the visible coach message', () => {
  const answer = "You went to failure on dips (RIR 0), so back off to RIR 2 next time.";
  const msg = withDoc(fakeDoc({ bubbles: [answer], heroHidden: true, opening: IDLE }),
    () => client.latestCoachMessage());
  assert.equal(msg, answer);
});

test('before the conversation starts, the visible message is the home opener', () => {
  const opener = 'Back after 4 days — settle in with clean reps.';
  const msg = withDoc(fakeDoc({ bubbles: [], heroHidden: false, opening: opener }),
    () => client.latestCoachMessage());
  assert.equal(msg, opener, 'the opener counts only while the hero is visible');
});

test('a hidden hero with no replies yields no stale coach message', () => {
  const msg = withDoc(fakeDoc({ bubbles: [], heroHidden: true, opening: IDLE }),
    () => client.latestCoachMessage());
  assert.equal(msg, null, 'must not resurrect the hidden idle greeting');
});

// The snapshot field must be wired to the helper (not the old dead selector).
test('snapshotUiState wires coach_message to latestCoachMessage(), not the dead selector', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'flightRecorder.js'), 'utf8');
  assert.match(src, /coach_message:\s*latestCoachMessage\(\)/, 'coach_message must come from latestCoachMessage()');
  assert.doesNotMatch(src, /querySelector\('\.coach-guide-box, #coach-opening, \.coach-message'\)/, 'the dead selector must be gone');
});
