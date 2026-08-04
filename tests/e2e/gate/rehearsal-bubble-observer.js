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
// THE FLUSH WINDOW IS ITSELF A RACE, and no wall-clock timestamp can settle it (owner
// P1, 2026-08-03). A bubble can become "saved to your sheet" at t=0, the boundary be
// recorded at t=50, and the coalesced report reach Node at t≈100. Receipt time is an
// upper bound on when the change happened, never the change itself.
//
// A drain barrier alone does not fix it either, and the reason is worth stating: a
// drain proves the collector was empty AT THE INSTANT IT RAN. It cannot be transplanted
// onto a different instant. The live write boundary is exactly that trap — its time is
// the successful RESPONSE, while a drain can only be taken before the click or after
// the save settles, so a claim rendered between the click and the response has a
// pre-click drain certificate attached to a post-response timestamp and looks earned.
//
// THE FIX IS A LOGICAL CLOCK, not a better wall clock. The page keeps a monotonic
// `changeSeq`, incremented on every observed DOM change, and every report carries the
// `changeSeq` of the change it describes. A boundary READS that counter at its own
// instant. Ordering is then a comparison of two counter values taken from the same
// source:
//
//   report.changeSeq  >  boundary.atChangeSeq   ⇒ the change happened AFTER the boundary
//   report.changeSeq  <= boundary.atChangeSeq   ⇒ the change had already happened
//
// Flush latency cannot invert that, because the sequence is assigned when the DOM
// changes rather than when the report is delivered. The drain barrier is kept as a
// belt-and-braces convenience, and it must now PROVE its postcondition rather than
// assume it: a missing function, a rejected callback, or an unverified state leaves
// `drained:false`.
//
// FAIL-CLOSED remains the default. A collector record facing a boundary that carries no
// sequence evidence is `uncertain`, never earned.
//
// A sweep remains, but only as a RECONCILER: it may fill in a bubble the observer never
// reported, and when it does it marks the record `retroactive`, which the claim
// decisions treat as missing evidence and fail closed on. A sweep may never improve or
// overwrite a live timestamp.

const OBSERVER_FLUSH_MS = 100;

// ── Turn-own-bubble identity (F-SB4B corrective 2, sweep Session 1) ────────────
//
// THE DEFECT THIS REPLACES. The driver identified a turn's own reply POSITIONALLY:
// it counted `.chat-bubble-atlas` before the turn and then waited for the count to
// rise, reading the reply at `nth(bubblesBefore)`. Both halves assume the thread only
// ever GROWS.
//
// It does not. `src/app/chat.js` caps the thread at MAX_BUBBLES = 12 and prunes
// `thread.firstChild` whenever a new bubble pushes it over. In a long session the
// user's own message is painted first, evicting the OLDEST atlas bubble, and the reply
// is then appended — so the count is unchanged even though the reply rendered
// perfectly. Debug sweep Session 1 hung the full 90 s on exactly this, at bubble 7 of
// a six-lift, six-set scenario, and reported a silent turn against a product that had
// answered correctly.
//
// The index is the worse half. After an eviction, `nth(bubblesBefore)` addresses a
// DIFFERENT turn's bubble, so a turn whose count did happen to rise would be settled
// and scored against the wrong reply — false evidence in a qualifying rehearsal, not
// merely a hang. `assertStagedProposal` read its new-bubble window the same way, which
// could shift a pre-acceptance completed-mutation claim out of view entirely and turn
// a trust assertion green on unread text.
//
// The replacement is IDENTITY, exactly as the earlier corrective replaced byte-offset
// thread slicing with per-element reads: mark every bubble that exists BEFORE the turn,
// then the turn's own bubbles are precisely the unmarked ones. Eviction cannot forge
// that — a pruned bubble is gone, and a surviving one keeps its mark. Reuse is handled
// for free: `handlePreviewReady` reuses an existing bubble element, which stays marked
// and so is correctly not counted as new.
//
// The attribute is inert: no application code reads or writes it, and it is set from
// the driver, never by the page's own scripts.
const SEEN_ATTR = 'data-rehearsal-seen';
const NEW_BUBBLE_SELECTOR = `#thread-messages .chat-bubble-atlas:not([${SEEN_ATTR}])`;

// In-page: mark every atlas bubble currently in the thread. Returns how many carry the
// mark afterwards, so the driver can assert the precondition actually took rather than
// assume it.
function markExistingBubblesScript(attr) {
  const nodes = document.querySelectorAll('#thread-messages .chat-bubble-atlas');
  for (const n of nodes) n.setAttribute(attr, '1');
  return document.querySelectorAll(`#thread-messages .chat-bubble-atlas[${attr}]`).length;
}

// The in-page installer, as a function Playwright serializes into an init script. It
// runs before any application script on every navigation, so it is installed for the
// fresh-session transition too. It reports `{ index, text }` per changed bubble and
// takes NO timestamp of its own — timing belongs to the receiving side.
function bubbleObserverInitScript({ flushMs, threadId, bubbleSelector, callbackName, flushName, stateName }) {
  // index -> the EARLIEST UNDELIVERED changeSeq for that bubble.
  //
  // Earliest, not latest, and the difference is load-bearing (owner P1, 2026-08-03).
  // A batch is built from `pending` and cleared before the delivery is awaited, so a
  // rejected delivery must re-queue its entries. If an unrelated thread mutation ran
  // while that batch was in flight, `markAll` had already re-added the same index with a
  // NEWER sequence, and the re-queue skipped it — so the retry reported an OLD
  // pre-boundary claim carrying a LATER unrelated sequence, and a boundary between the
  // two could class it `after`. That defeats the point of assigning logical time when
  // the DOM changed.
  //
  // Keeping the earliest undelivered sequence is also the fail-closed direction: a
  // report labelled earlier than reality can only make a claim look like it happened
  // BEFORE a boundary, never after. Once a delivery succeeds the slot is cleared, so a
  // genuine later transition of the same bubble carries its own later sequence.
  const pending = new Map();
  const markPending = (index, seq) => {
    const prior = pending.get(index);
    pending.set(index, prior === undefined ? seq : Math.min(prior, seq));
  };
  let observer = null;
  let timer = null;
  let changeSeq = 0;      // the logical clock: every observed DOM change
  let flushedSeq = 0;     // the changeSeq covered by the last DELIVERED report

  // Returns a verifiable postcondition so the runner can prove the drain happened
  // rather than assume it: `{ ok, delivered, changeSeq, flushedSeq, pending }`.
  const flush = async () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const thread0 = document.getElementById(threadId);
    // DELIVERED-BUT-UNDISPATCHED records first. A MutationObserver callback is a
    // microtask: a drain taken immediately after a DOM change can otherwise run before
    // the callback fires and certify an empty collector that is not empty. takeRecords()
    // hands over exactly those pending mutations so they are counted before the flush
    // decides what to send.
    if (observer && thread0) {
      const outstanding = observer.takeRecords();
      if (outstanding && outstanding.length) markAll(thread0);
    }
    const seqAtFlush = changeSeq;
    const thread = document.getElementById(threadId);
    if (!thread) return { ok: false, reason: 'thread element missing', changeSeq, flushedSeq, pending: changeSeq !== flushedSeq };
    if (typeof window[callbackName] !== 'function') {
      return { ok: false, reason: 'report callback missing', changeSeq, flushedSeq, pending: changeSeq !== flushedSeq };
    }
    const bubbles = thread.querySelectorAll(bubbleSelector);
    const batch = [];
    const sent = new Map();
    for (const [index, seq] of pending) {
      const el = bubbles[index];
      if (!el) continue;
      batch.push({ index, changeSeq: seq, text: String(el.innerText || '').replace(/\s+/g, ' ').trim() });
      sent.set(index, seq);
    }
    pending.clear();
    if (batch.length) {
      try {
        await window[callbackName](batch);
      } catch (e) {
        // A rejected callback means the report did NOT land. RE-QUEUE it: clearing
        // `pending` before the await means a failed delivery would otherwise DROP the
        // evidence permanently, and a lost claim is exactly what this collector exists
        // to prevent. The change keeps its ORIGINAL changeSeq, so a retry cannot make a
        // pre-boundary change look post-boundary.
        for (const [index, seq] of sent) markPending(index, seq);
        schedule();
        return { ok: false, reason: `report callback rejected: ${e && e.message}`, changeSeq, flushedSeq, pending: true };
      }
    }
    flushedSeq = seqAtFlush;
    return { ok: true, delivered: batch.length, changeSeq, flushedSeq, pending: changeSeq !== flushedSeq };
  };

  const schedule = () => { if (timer === null) timer = setTimeout(() => { flush(); }, flushMs); };

  const markAll = (thread) => {
    changeSeq += 1;
    const bubbles = thread.querySelectorAll(bubbleSelector);
    for (let i = 0; i < bubbles.length; i += 1) markPending(i, changeSeq);
    schedule();
  };

  window[flushName] = () => flush();
  window[stateName] = () => ({ changeSeq, flushedSeq, pending: changeSeq !== flushedSeq });

  const attach = () => {
    const thread = document.getElementById(threadId);
    if (!thread) return false;
    // Any subtree change can add a bubble or rewrite one's text, and indexes shift when
    // a bubble is inserted, so every mutation re-reads the whole (small) list.
    observer = new MutationObserver(() => markAll(thread));
    observer.observe(thread, { childList: true, subtree: true, characterData: true });
    markAll(thread);
    return true;
  };

  if (!attach()) {
    // The thread element is created by the app bundle, and this script runs at
    // document-start, when `document.documentElement` can still be null — observing
    // that would throw and leave the collector silently uninstalled.
    //
    // Bootstrap on `document`, which always exists, so the thread is picked up AS IT IS
    // PARSED rather than at the next poll tick. A poll alone left a window in which
    // bubbles created immediately after navigation were missed entirely: the observer
    // had not attached, so their changes never entered the logical clock at all. Both
    // mechanisms run; whichever wins disconnects the other.
    let bootstrap = null;
    const poll = setInterval(() => {
      if (attach()) { clearInterval(poll); if (bootstrap) bootstrap.disconnect(); }
    }, 5);
    try {
      bootstrap = new MutationObserver(() => {
        if (attach()) { bootstrap.disconnect(); clearInterval(poll); }
      });
      bootstrap.observe(document, { childList: true, subtree: true });
    } catch { bootstrap = null; }   // the poll remains
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
  // The LOGICAL time of the change, assigned in the page when the DOM changed — not
  // when this report was delivered. This is what flush latency cannot distort.
  const changeSeq = Number.isFinite(o.changeSeq) ? o.changeSeq : null;
  const prior = out[index];
  if (!prior) {
    out[index] = {
      index, text, atMs: nowMs, phase, ingestSeq, changeSeq,
      placeholder: text.includes(thinkingMarker), retroactive: false,
    };
    return out;
  }
  if (text !== prior.text) {
    prior.text = text;
    prior.atMs = nowMs;
    prior.ingestSeq = ingestSeq;
    prior.changeSeq = changeSeq;
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
// `atChangeSeq` is the page's logical clock READ AT THIS BOUNDARY'S OWN INSTANT. It is
// the only field that can order a change against the boundary, and it may never be
// copied from a different instant — that transplant is the defect this replaces.
function makeBoundary({ atMs, atChangeSeq = null, ingestSeq = null, drained = false } = {}) {
  return {
    atMs: Number.isFinite(atMs) ? atMs : null,
    atChangeSeq: Number.isFinite(atChangeSeq) ? atChangeSeq : null,
    ingestSeq: Number.isFinite(ingestSeq) ? ingestSeq : null,
    drained: drained === true,
  };
}

// Accepts a boundary object or a bare timestamp. A bare number carries NO sequence and
// NO drain evidence, so a collector record facing it is uncertain — matching what the
// comment says rather than quietly disabling the comparison.
function normalizeBoundary(value) {
  if (value && typeof value === 'object') return makeBoundary(value);
  return makeBoundary({ atMs: value, atChangeSeq: null, ingestSeq: null, drained: false });
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
  // 1. THE LOGICAL CLOCK — exact, and immune to flush latency. Both values come from
  //    the same in-page counter: the change's own sequence, and the counter read at the
  //    boundary's instant.
  const changeSeq = Number.isFinite(r.changeSeq) ? r.changeSeq : null;
  if (changeSeq !== null && b.atChangeSeq !== null) {
    return changeSeq > b.atChangeSeq ? 'after' : 'before';
  }

  // 2. A record with NO collector causality (a plain timestamped message, as the unit
  //    fixtures use) is judged on time alone — there is no ordering question to ask.
  const ingestSeq = Number.isFinite(r.ingestSeq) ? r.ingestSeq : null;
  if (changeSeq === null && ingestSeq === null) return atMs >= b.atMs ? 'after' : 'before';

  // 3. A COLLECTOR record facing a boundary with NO sequence read at its own instant.
  //    Receipt time is only an upper bound on when the change happened, so a report
  //    stamped at or after the boundary may describe an earlier change.
  //
  //    A drain certificate cannot rescue this, and deliberately does not: a drain proves
  //    the collector was empty AT THE INSTANT IT RAN, and the boundary that matters may
  //    be a different instant — the live write's response time is exactly such a case.
  //    Accepting `drained` here is what let a pre-click certificate be transplanted onto
  //    a post-response timestamp (owner P1, 2026-08-03). Ordering comes from the logical
  //    clock or not at all.
  if (atMs < b.atMs) return 'before';
  return 'uncertain';
}

// A SWEEP. It may only FILL IN a bubble the observer never reported, and such a record
// is marked `retroactive` because its timestamp is the inspection time, not the render
// time. It may never overwrite or improve a live timestamp — doing so is precisely the
// retroactive assignment this module exists to prevent.
//
// `collectorQuiet` — WAS THE OBSERVER GIVEN ITS SAY BEFORE THIS SWEEP LOOKED?
//
// THE DEFECT THIS CLOSES (F-SB4B corrective 4). "The text differs from the record" is
// evidence the observer MISSED a change only when the observer has nothing left to
// deliver. `say()` sweeps immediately after submitting, inside the collector's flush
// window, so a change the observer HAD seen was routinely swept before its report
// landed. The sweep wrote the new text and set `retroactive` — and the live report that
// followed could not clear the mark, because `ingestLiveObservation` only resets it
// when the text DIFFERS and the sweep had already written that very text. The record
// stayed untrustworthy forever despite having been observed live, and every claim
// decision failed closed on it. Session 1 reported seven messages as seen only by the
// sweep for exactly this reason, against a product that had rendered them normally.
//
// So a sweep facing a collector that still holds an undelivered change may NOT downgrade
// an existing live record: that record's report is in flight and will carry the change's
// own logical time. Leaving it alone is safe precisely because the observer re-marks
// EVERY index on every mutation, so the pending delivery updates it.
//
// FAIL-CLOSED is unchanged in the direction that matters. A bubble with NO record at all
// is still filled in and still marked `retroactive`, whatever the collector's state —
// an unobserved bubble is never silently trusted.
function reconcileSweep(records, texts, { phase, nowMs, thinkingMarker = 'Thinking…', collectorQuiet = true } = {}) {
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
      // A change the observer still owes us is not a change it missed.
      if (collectorQuiet !== true) continue;
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
  SEEN_ATTR,
  NEW_BUBBLE_SELECTOR,
  markExistingBubblesScript,
  bubbleObserverInitScript,
  ingestLiveObservation,
  reconcileSweep,
  recordsToMessages,
  makeBoundary,
  normalizeBoundary,
  classifyClaimAgainstBoundary,
};
