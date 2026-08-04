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
// produce thousands of IPC calls.
//
// THE FLUSH WINDOW IS ITSELF A RACE, and a bounded race is still a race (owner P1,
// 2026-08-03). A bubble can become "saved to your sheet" at t=0, the boundary be
// recorded at t=50, and the coalesced report reach Node at t≈100 — inverting a claim
// that was visible FIRST into one that looks earned. Two mechanisms close it, and the
// second is what makes the first optional rather than load-bearing:
//
//   1. DRAIN BARRIER. `__atlasBubbleFlush()` forces the pending flush and AWAITS the
//      exposed callback, so when it resolves every change that had already happened is
//      already stamped. The runner drains immediately before it records a boundary, so
//      a pre-boundary claim can never be stamped after it.
//   2. FAIL-CLOSED UNCERTAINTY. A boundary records whether it was taken after a
//      successful drain. If it was NOT, any record ingested afterwards could describe a
//      change that predates it, and the claim decisions refuse to call such a claim
//      earned. Correctness therefore does not depend on the drain succeeding.
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
function bubbleObserverInitScript({ flushMs, threadId, bubbleSelector, callbackName, flushName, stateName }) {
  const pending = new Set();
  let timer = null;
  let changeSeq = 0;      // every observed DOM change
  let flushedSeq = 0;     // the change seq covered by the last delivered report

  // AWAITS the exposed callback, so a resolved flush means Node has already ingested
  // and stamped every change observed so far.
  const flush = async () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const seqAtFlush = changeSeq;
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
    if (batch.length) {
      try { await window[callbackName](batch); } catch { /* reporting is best-effort */ }
    }
    flushedSeq = seqAtFlush;
  };

  const schedule = () => { if (timer === null) timer = setTimeout(() => { flush(); }, flushMs); };

  const markAll = (thread) => {
    changeSeq += 1;
    const bubbles = thread.querySelectorAll(bubbleSelector);
    for (let i = 0; i < bubbles.length; i += 1) pending.add(i);
    schedule();
  };

  // The drain barrier and the pending-state probe the runner uses before a boundary.
  window[flushName] = () => flush();
  window[stateName] = () => ({ changeSeq, flushedSeq, pending: changeSeq !== flushedSeq });

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
function ingestLiveObservation(records, observation, { phase, nowMs, ingestSeq = 0, thinkingMarker = 'Thinking…' } = {}) {
  const out = records && typeof records === 'object' ? records : {};
  const o = observation && typeof observation === 'object' ? observation : {};
  const index = Number(o.index);
  if (!Number.isInteger(index) || index < 0) return out;
  const text = normalize(o.text);
  const prior = out[index];
  if (!prior) {
    out[index] = { index, text, atMs: nowMs, phase, ingestSeq, placeholder: text.includes(thinkingMarker), retroactive: false };
    return out;
  }
  if (text !== prior.text) {
    prior.text = text;
    prior.atMs = nowMs;
    prior.ingestSeq = ingestSeq;
    prior.placeholder = text.includes(thinkingMarker);
    prior.retroactive = false;   // a live report supersedes any retroactive fill-in
  }
  return out;
}

// ── boundaries ────────────────────────────────────────────────────────────────
// A boundary (the live write, or the moment the plan mutation became true) is not a
// bare timestamp: it also records the ingest counter at the moment it was taken and
// whether it was taken after a SUCCESSFUL drain. Those two facts are what let a claim
// decision tell "reported after the boundary because it happened after" from "reported
// after the boundary because the flush was still pending".
function makeBoundary({ atMs, ingestSeq = 0, drained = false } = {}) {
  return { atMs: Number.isFinite(atMs) ? atMs : null, ingestSeq, drained: drained === true };
}

// Accepts a boundary object or a bare timestamp (which is treated as UNDRAINED, because
// a bare number carries no evidence that pending work was flushed first).
function normalizeBoundary(value) {
  if (value && typeof value === 'object') return makeBoundary(value);
  return makeBoundary({ atMs: value, ingestSeq: Number.POSITIVE_INFINITY, drained: false });
}

// Was this claim provably visible AFTER the boundary?
//   'after'     — the record was ingested before the boundary and stamped at/after it,
//                 or the boundary was drained so a later report is genuinely later;
//   'before'    — stamped before the boundary;
//   'uncertain' — reported after an UNDRAINED boundary, so the change may predate it;
//   'untimed'   — the record carries no timestamp at all.
function classifyClaimAgainstBoundary(record, boundary) {
  const b = normalizeBoundary(boundary);
  const r = record && typeof record === 'object' ? record : {};
  if (b.atMs === null) return 'before';                 // no boundary ever occurred
  const atMs = Number.isFinite(r.atMs) ? r.atMs : null;
  if (atMs === null) return 'untimed';
  // The uncertainty rule needs BOTH sequences: it exists to catch a report that arrived
  // after the boundary was taken. Without a sequence on either side the question cannot
  // be asked, and answering "uncertain" would refuse every ordinary timestamped claim
  // rather than the racing one. A live record always carries a sequence; a sweep-only
  // record is already marked `retroactive` and fails closed before reaching here.
  const seq = Number.isFinite(r.ingestSeq) ? r.ingestSeq : null;
  const comparable = seq !== null && Number.isFinite(b.ingestSeq);
  if (comparable && seq > b.ingestSeq && !b.drained) return 'uncertain';
  return atMs >= b.atMs ? 'after' : 'before';
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
  makeBoundary,
  normalizeBoundary,
  classifyClaimAgainstBoundary,
};
