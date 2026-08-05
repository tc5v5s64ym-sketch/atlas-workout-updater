# Qualifying rehearsal Session 1 — the partial-render failure, classified and closed

**Date:** 2026-08-05
**Source `main`:** `61601b730c3ba97af4516c36cf9e24db90c68f0f`
**Failed run:** `qualifying-session-1-20260805T011738-B63559`
**Counts unchanged by this document:** Rehearsal 0/5 · Stage A 5/5 COMPLETE · Stage B 0/5 OPEN · Phase 5 unauthorized · `SESSION_PLAN_SETS_WRITE_ENABLED` untouched.

## The incident

Qualifying Session 1 failed before scoring, at the open-question turn. The recorded server
evidence: `POST /api/coach/chat` returned **200** after about **16.7 s**, carrying a complete
Gemini message of **386 characters**. The turn's own bubble stopped changing while shorter than
that reply, and `settleReply` waited its full 90 s and refused.

## Classification: PRODUCT-SIDE DEFECT — the client discarded the served reply

The three candidate classifications resolve as follows.

| candidate | verdict | evidence |
|---|---|---|
| product render defect (`typeOut` leaves a stable prefix) | **excluded** | the same 386-character reply renders complete at 0 s, 2 s and 14 s latency, three runs each, past the eviction cap and after a reused preview bubble |
| settlement / correlation defect (`settleReply` compared the wrong thing) | **excluded** | the harness held the right served reply, addressed the right bubble by identity, and refused correctly — refusing was the truthful outcome |
| transient environmental interruption | **excluded** | reproduced deterministically, 3/3, with zero page errors, zero console errors, no navigation, no detach, no eviction of the turn's bubble, and no timer cancellation |

**One correction to the incident description.** The bubble did not hold a *prefix* of the served
reply. It held a complete, different, deterministic line — `chatFallback`'s catch-all,
*"Got it — keep logging your sets and say \"log it\" when you're done."* (66 characters). The
"partial render" wording came from the settlement diagnosis label, which reports only that the
visible text was shorter than the served text. The distinction is what identifies the cause:
nothing truncated, and the coach's answer was never rendered at all.

### Cause

`getChatReply` (`src/app/coach-conversation.js`) raced the request against a 15 s timer that
**cancelled nothing**:

```js
const CHAT_REPLY_TIMEOUT_MS = 15000;
const timeout = new Promise(resolve => setTimeout(() => resolve({ selected: false, value: { message: null, … } }), CHAT_REPLY_TIMEOUT_MS));
const winner = await Promise.race([request, timeout]);
return winner.value;
```

At 15 s the client stopped listening and the caller rendered `chatFallback`. The request stayed
alive and returned the real 200 answer 1.7 s later; nothing consumed it. The lifter read a generic
nudge while the coach's actual answer was discarded.

The budget was also derived from nothing. The server's own provider bound is **12 s**
(`COACH_CHAT_TIMEOUT_MS`, `routes/coachOps.js`) and sits **on top of** four Sheets reads and the
context build, so a successful turn can legitimately outlast 15 s. The route's own comment already
recorded the coupling in the wrong direction — the server was widened *because* the client waits
15 s — leaving the client cap as the binding constraint on the server's real worst case.

## Authority

| | |
|---|---|
| **Current live authority (before)** | two — the served `/api/coach/chat` response **and** the client's expired budget, whichever spoke first |
| **Intended sole authority** | the response the turn was served |
| **Losing authority, removed** | the timeout's power to answer. It no longer produces a result; `chatFallback` is an **outage** line and may appear only when the turn genuinely served nothing |
| **Compatibility bridge** | none |
| **Net complexity** | one `Promise.race` and one synthetic timeout result deleted; one abort backstop added |

This is the authority rule in `docs/ATLAS_SYSTEM_AUTHORITY.md` row 6 (visible coach wording:
*engine decides, LLM words*) applied to its own client edge: a deterministic fallback exists for an
outage and may never outrank a reply the coach served.

## The fix

`getChatReply` awaits the request. The bubble holds its `Thinking…` state until the request
concludes, so the deterministic line is only ever rendered when it is **true**. The bound that
remains is a hung-transport backstop — `CHAT_REQUEST_ABORT_MS = 60000` — and it **aborts** the
request (`api()` already honours `signal` and never retries a caller abort), so an expired bound
cannot orphan a served reply behind a fabricated answer. It sits an order of magnitude above the
server's own budget, so it is never why a real reply is missed.

Nothing else changed: the correlation ticket is still committed only by the response that supplied
the visible coaching, `completeTurnResponse` is still fail-closed for a revoked ticket, every
structured effect still passes `isTurnResponseAuthoritative`, and the preview → approve → write loop
is untouched. `settleReply` was not relaxed, its timeout was not raised, and stability-only or
prefix agreement was not accepted anywhere.

**A second consequence, recorded because it is load-bearing.** `classifySettlement` settles on
`stable-no-served-message` when the visible text is quiet and no reply has been captured *yet*. A
client line rendered while its own response was still in flight could therefore be settled as a
turn's reply. That window existed only because the product rendered a non-served line during an
in-flight request; with the fix the bubble still reads `Thinking…` at that instant, which
`classifySettlement` never settles. The cause is removed rather than the symptom suppressed.

## Reproduction — credential-free, against the real built application

`tests/e2e/support/coach-lane-harness.js` opens the real built shell; the real composer routes the
turn to the real chat lane; the real `appendAtlasBubble`/`typeOut` renderer paints it; the turn's own
bubble is selected by the rehearsal's own identity rule (`markExistingBubblesScript` +
`NEW_BUBBLE_SELECTOR`); settlement is decided by the rehearsal's own `classifySettlement`; and the
served reply is captured from the **wire**, never from the client. One complete message is served per
turn — no truncation is simulated at any point.

Every case asserted: the exact served reply, the turn's bubble identity, every DOM text transition,
the final DOM text, the settlement outcome, and page/console errors.

### Against `61601b7` (before the fix)

| case | served | final visible | outcome |
|---|---|---|---|
| immediate, 386 chars — runs 1/2/3 | 386 | 386, identical | `served-complete` |
| 2 s, short reply — runs 1/2/3 | 59 | 59, identical | `served-complete` |
| 14 s, 386 chars — runs 1/2/3 | 386 | 386, identical | `served-complete` |
| **16.7 s, 386 chars — runs 1/2/3** | **386** | **66 — the `chatFallback` catch-all** | **RED, 3/3** |
| beyond the 12-bubble eviction cap, immediate | 386 | 386, identical | `served-complete` |
| **beyond the eviction cap, 16.7 s** | **386** | **66 — the same fallback** | **RED** |
| after the preview lane reuses a bubble, immediate | 386 | 386, identical | `served-complete` |

Zero page errors and zero console errors in every case, red and green alike. The DOM transition log
for a red case shows the bubble reaching 66 characters in 15 monotonic steps starting at 15.5 s and
never changing again — a completed render of the wrong text, not an interrupted render of the right
one.

### Against the fix

All fifteen cases green, including the 16.7 s cases at `served-complete` with the served capture
proven present before the comparison.

## Regression test and mutation bite

`tests/e2e/coach-chat-served-reply.spec.js` — three cases, credential-free and write-free:

1. a reply served **after** the old 15 s budget still reaches the bubble in full;
2. an ordinary fast reply is unchanged;
3. a turn that genuinely serves nothing still gets the deterministic line, and never sits on
   `Thinking…` — so the outage lane is proven still reachable, not merely deleted.

**Bite.** With the fix reverted and the client rebuilt, case 1 fails on exactly the defect —
`Expected: "Keep the bar path over your midfoot…" / Received: "Got it — keep logging your sets…"` —
while cases 2 and 3 stay green. With the fix in place, all three pass.

## Checks

`npm test` 7566 pass / 0 fail · `npm run test:e2e` 352 pass, 2 skipped · `npm run lint` 0 errors ·
`npm run check:syntax` clean · `npm run scan:secrets` clean · wiring, authority, banned-pattern,
allowlist-ratchet, completion-ladder, packet-trace and paper-weight guards all green.

## Scope

One concern. Sheets quota behaviour, staged-proposal evidence, collector timing and identity,
scorecard conditions, rehearsal counts, write authority, schema, and Phase 5 authorization are
untouched. The quota messages recorded around the failed run stay environmental evidence; they are
not a demonstrated cause of this defect, and the reproduction needs no workbook at all.

The four recently merged harness correctives (#1263, #1264, #1265, #1266) are exonerated by
reproduction rather than by code inspection: the failure reproduces with no collector, no sweep, and
no scorecard in the path.

## Next

Qualifying Session 1 is re-attempted from a refreshed `main` after this corrective is merged and
verified, with fresh synthetic identities. The rehearsal restarts at Session 1; the streak stays
0/5.
