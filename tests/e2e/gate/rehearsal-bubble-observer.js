'use strict';

// ── Truthful bubble-lifecycle timestamps (TEMPORARY F-SB4B; sunset: F-SB4C) ─────
//
// THE DEFECT THIS REPLACES (owner P1, 2026-08-03). The claim collector stamped each
// bubble with the `Date.now()` of the SWEEP that happened to notice it. That is honest
// only while a sweep is running. The runner has long gaps with no sweep, and the sharp
// one is the ordinary closeout every session performs:
//
//   1. `say(page, 'done')` clicks and sweeps once, immediately;
//   2. the closeout bubble may not exist yet, or may still read `Thinking…`;
//   3. the runner then waits for the closeout card, clicks Save, waits for the live
//      write, and performs the durable reads and adjudication;
//   4. the next guaranteed full sweep is section 13a — AFTER the write.
//
// A bubble that rendered "saved to your sheet" BEFORE Save, but whose final text was
// first observed in 13a, received an `atMs` later than the live write — so
// `detectUnsupportedWriteClaim` called an unsupported claim earned. The lifecycle fold
// fixed "index recorded once"; it did not fix "no observation occurred while the
// lifecycle changed". The same gap can hide a pre-mutation claim.
//
// THE FIX. The page tells us when its own text changed, instead of us guessing later.
// A MutationObserver inside the page watches `#thread-messages` and reports each
// changed bubble; the Node side stamps the report on RECEIPT. Two properties matter:
//
//   * the timestamp is on the SAME CLOCK as `saveResponses` — both are Node
//     `Date.now()`. An in-page clock would not be: Session 5 installs a FAKE clock
//     (`page.clock.install`) whose `Date.now()` is a controlled evening instant hours
//     away from real time, so an in-page timestamp could not be compared to a write.
//   * it cannot be assigned RETROACTIVELY. The delay between the DOM changing and the
//     report arriving is bounded by the flush interval and IPC, not by whenever the
//     harness next decides to look.
//
// Reports are coalesced per flush window so a character-by-character `typeOut` cannot
// produce thousands of IPC calls. The window bounds the timestamp's precision, which is
// far tighter than the minutes-wide gap it replaces.
//
// A sweep remains, but only as a RECONCILER: it may fill in a bubble the observer never
// reported, and when it does it marks the record `retroactive`, which the claim
// decisions treat as missing evidence and fail closed on. A sweep may never improve or
// overwrite a live timestamp.

const OBSERVER_FLUSH_MS = 100;

// The in-page installer, as a function Playwright serializes into an init script. It
// runs before any application script on every navigation, so it is installed for the
// fresh-session transition too. It reports `{ index, text }` per changed bubble and
// takes NO timestamp of its own — timing belongs to the receiving side.
function bubbleObserverInitScript({ flushMs, threadId, bubbleSelector, callbackName }) {
  const pending = new Set();
  let timer = null;

  const flush = () => {
    timer = null;
    const thread = document.getElementById(threadId);
    if (!thread || typeof window[callbackName] !== 'function') return;
    const bubbles = thread.querySelectorAll(bubbleSelector);
    const batch = [];
    for (const index of pending) {
      const el = bubbles[index];
      if (!el) continue;
      batch.push({ index, text: String(el.innerText || '').replace(/\s+/g, ' ').trim() });
    }
    pending.clear();
    if (batch.length) { try { window[callbackName](batch); } catch { /* reporting is best-effort */ } }
  };

  const schedule = () => { if (timer === null) timer = setTimeout(flush, flushMs); };

  const markAll = (thread) => {
    const bubbles = thread.querySelectorAll(bubbleSelector);
    for (let i = 0; i < bubbles.length; i += 1) pending.add(i);
    schedule();
  };

  const attach = () => {
    const thread = document.getElementById(threadId);
    if (!thread) return false;
    // Any subtree change can add a bubble or rewrite one's text, and indexes shift when
    // a bubble is inserted, so every mutation re-reads the whole (small) list.
    new MutationObserver(() => markAll(thread)).observe(thread, {
      childList: true, subtree: true, characterData: true,
    });
    markAll(thread);
    return true;
  };

  if (!attach()) {
    // The thread element is created by the app bundle, and this script runs at
    // document-start — when `document.documentElement` can still be null, so observing
    // it would throw and silently leave the collector uninstalled. Poll instead: it
    // costs nothing, it stops the moment the thread exists, and it cannot fail on a
    // document that is not built yet.
    const poll = setInterval(() => { if (attach()) clearInterval(poll); }, 25);
  }
}

// ── the record reducers (pure) ─────────────────────────────────────────────────

const normalize = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();

// A LIVE report from the page. Authoritative: the text changed at (or just before) this
// moment. First report binds the phase — the turn that created the bubble.
function ingestLiveObservation(records, observation, { phase, nowMs, thinkingMarker = 'Thinking…' } = {}) {
  const out = records && typeof records === 'object' ? records : {};
  const o = observation && typeof observation === 'object' ? observation : {};
  const index = Number(o.index);
  if (!Number.isInteger(index) || index < 0) return out;
  const text = normalize(o.text);
  const prior = out[index];
  if (!prior) {
    out[index] = { index, text, atMs: nowMs, phase, placeholder: text.includes(thinkingMarker), retroactive: false };
    return out;
  }
  if (text !== prior.text) {
    prior.text = text;
    prior.atMs = nowMs;
    prior.placeholder = text.includes(thinkingMarker);
    prior.retroactive = false;   // a live report supersedes any retroactive fill-in
  }
  return out;
}

// A SWEEP. It may only FILL IN a bubble the observer never reported, and such a record
// is marked `retroactive` because its timestamp is the inspection time, not the render
// time. It may never overwrite or improve a live timestamp — doing so is precisely the
// retroactive assignment this module exists to prevent.
function reconcileSweep(records, texts, { phase, nowMs, thinkingMarker = 'Thinking…' } = {}) {
  const out = records && typeof records === 'object' ? records : {};
  const list = Array.isArray(texts) ? texts : [];
  for (let i = 0; i < list.length; i += 1) {
    const text = normalize(list[i]);
    const prior = out[i];
    if (!prior) {
      out[i] = { index: i, text, atMs: nowMs, phase, placeholder: text.includes(thinkingMarker), retroactive: true };
      continue;
    }
    if (text !== prior.text) {
      // The observer missed this transition. Keep the record but mark it untrustworthy
      // for timing; the claim decisions fail closed on it.
      prior.text = text;
      prior.placeholder = text.includes(thinkingMarker);
      prior.retroactive = true;
    }
  }
  return out;
}

function recordsToMessages(records) {
  const out = records && typeof records === 'object' ? records : {};
  return Object.keys(out)
    .map((k) => Number(k))
    .filter((k) => Number.isInteger(k))
    .sort((a, b) => a - b)
    .map((k) => out[k]);
}

module.exports = {
  OBSERVER_FLUSH_MS,
  bubbleObserverInitScript,
  ingestLiveObservation,
  reconcileSweep,
  recordsToMessages,
};
