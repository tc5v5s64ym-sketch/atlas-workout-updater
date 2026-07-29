'use strict';

// Phase 4 criterion 4 step (a) — the discussion referent is resolved with the FULL context
// BEFORE any configured-path answer or early return, and enriches the ONE request-scoped
// canonical WorkoutSession (owner ruling, Option 2, 2026-07-29).
//
// GOVERNING INVARIANT (owner-amended): "discussion_referent must not be null merely because of
// invocation order when the evidence required to resolve it is available. When the route
// intentionally has no Sheet-derived evidence, null is the honest value."
//
// Two things were wrong before this:
//   1. the referent block sat AFTER the recovery early return, so a tired turn returned with no
//      referent at all — null purely from ordering, with the full evidence already gathered;
//   2. the referent reached packet.session only as a post-response overlay, so the live
//      configured answer and the packet did not share one enriched object.
//
// The resolver itself is deliberately UNCHANGED. The gate proved that reducing it to
// request-scoped context regresses a real case — a custom off-plan lift known only through
// stalls/recent_sessions stops being identified and the whole plan is substituted — so the fix is
// ordering, not a narrower resolver.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const grounding = require('../services/coachResponseGrounding');
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'coachOps.js'), 'utf8');
const shadowSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'coachQaShadow.js'), 'utf8');

// ── 1 · the regression the gate found, pinned as a CONTROL ────────────────────

const PLAN = [{ name: 'Bench Press' }, { name: 'Back Squat' }];
const CUSTOM_MSG = 'my jefferson curl felt off';

test('criterion 4a CONTROL — request-only context substitutes the whole plan for a custom off-plan lift', () => {
  // This is why the resolver was NOT reduced to request-scoped inputs. Keep it as a live control:
  // if this ever stops reproducing, the reasoning behind Option 2 has changed and must be redone.
  const requestOnly = { current_plan: PLAN };
  const resolved = grounding.resolveTurnExercises(CUSTOM_MSG, requestOnly);

  assert.deepEqual(resolved, ['Bench Press', 'Back Squat'],
    'without stalls/recent_sessions the custom lift is unrecognised and the PLAN is substituted');
});

test('criterion 4a — the full context still identifies the custom off-plan lift', () => {
  const full = {
    current_plan: PLAN,
    stalls: [{ exercise: 'Jefferson Curl' }],
    recent_sessions: [{ exercises: ['Jefferson Curl'] }],
  };
  const resolved = grounding.resolveTurnExercises(CUSTOM_MSG, full);

  assert.deepEqual(resolved, ['Jefferson Curl'],
    'the production resolver keeps its Sheet-derived evidence and identifies the named lift');
  assert.ok(!resolved.includes('Bench Press') && !resolved.includes('Back Squat'),
    'and never falls back to the plan for an explicitly named off-plan lift');
});

test('criterion 4a — the production route still feeds the resolver the FULL context', () => {
  // The ordering change must not have quietly swapped in a narrower context object.
  const block = routeSrc.slice(
    routeSrc.indexOf('── Discussion-referent'),
    routeSrc.indexOf('res.locals.coachTurnReferent =')
  );
  assert.match(block, /resolveDisputedLiftEntry\(message, context, history/,
    'the dispute resolver keeps the full buildChatContext result');
  assert.match(block, /resolveDiscussedLift\(message, context\)/,
    'and so does the non-dispute referent resolution');
});

// ── 2 · ordering: the referent precedes every post-read answer and early return ─

test('criterion 4a — the referent is resolved BEFORE the recovery early return', () => {
  // The defect: a tired turn returned at `if (tired)` before the referent block ran, so the
  // packet carried null despite the evidence being in hand — null from ordering, which the
  // amended invariant forbids.
  const iContext = routeSrc.indexOf('const context = buildChatContext(');
  const iReferent = routeSrc.indexOf('── Discussion-referent');
  const iRecoveryReturn = routeSrc.indexOf('if (tired) {', iContext);
  const iDeterministic = routeSrc.indexOf('|| deterministicAnswer(allLog)');

  assert.ok(iContext !== -1 && iReferent !== -1 && iRecoveryReturn !== -1 && iDeterministic !== -1);
  assert.ok(iReferent > iContext, 'the referent still uses the full context, so it follows the reads');
  assert.ok(iReferent < iRecoveryReturn, '…but precedes the recovery early return');
  assert.ok(iReferent < iDeterministic, '…and precedes the configured deterministic answer');
});

test('criterion 4a — the canonical session is ENRICHED with the referent, not rebuilt', () => {
  const enrich = routeSrc.slice(
    routeSrc.indexOf('res.locals.coachTurnReferent ='),
    routeSrc.indexOf('if (tired) {', routeSrc.indexOf('res.locals.coachTurnReferent ='))
  );
  assert.match(enrich, /res\.locals\.coachCanonicalSession = \{/,
    'the enriched session is stored back for the live path and the packet');
  assert.match(enrich, /discussion_referent: turnReferentKey/,
    'carrying the referent resolved from the full context');
  assert.doesNotMatch(enrich, /buildCanonicalSessionSnapshot\(/,
    'enrichment must never call the builder again');
});

test('criterion 4a — buildCanonicalSessionSnapshot has exactly ONE call site in the route', () => {
  const calls = routeSrc.split('\n').filter((l) =>
    /buildCanonicalSessionSnapshot\(/.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/require\(/.test(l));
  assert.equal(calls.length, 1, 'one builder call site per request, still');
});

// ── 3 · the packet no longer overlays its own referent ────────────────────────

test('criterion 4a — the shadow neither recomputes nor overlays a referent', () => {
  const region = shadowSrc.slice(
    shadowSrc.indexOf('const canonicalBase'),
    shadowSrc.indexOf('const grounding =')
  );
  assert.match(region, /const canonicalSession = canonicalBase;/,
    'the packet embeds exactly the object the live response used');
  // The overlay's signature was a spread copy of the base. Match that, not the words
  // "discussion_referent", which legitimately appear in the comment explaining the honest null.
  assert.doesNotMatch(region, /\{\s*\.\.\.canonicalBase/,
    'no post-response referent overlay copy remains');
  assert.doesNotMatch(shadowSrc, /buildCanonicalSessionSnapshot\(/,
    'and the shadow still never builds workout state');
});

// ── 4 · the offline null is caused by absent evidence, not ordering ───────────

test('criterion 4a — the model-unavailable path takes no Sheet read and runs no referent resolution', () => {
  // Everything between the canonical-session build and the offline answer must stay read-free.
  const iBuild = routeSrc.indexOf('res.locals.coachCanonicalSession = isTurnPrecedenceEnabled()');
  const iOffline = routeSrc.indexOf('|| deterministicAnswer([])');
  assert.ok(iBuild !== -1 && iOffline !== -1 && iOffline > iBuild);
  const offlineSpan = routeSrc.slice(iBuild, iOffline);

  assert.doesNotMatch(offlineSpan, /buildChatContext\(/,
    'the offline path must not gain a Sheet-backed context');
  assert.doesNotMatch(offlineSpan, /resolveDisputedLiftEntry\(|resolveDiscussedLift\(/,
    'and must not run the full referent resolver it has no evidence for');
  assert.doesNotMatch(offlineSpan, /readFreshDiscussedLift\(/,
    'nor lean on a stale server referent without the fail-closed context');
});

// ── 5 · the flag-off path keeps its legacy referent ordering (Codex P2) ───────

test('criterion 4a — flag OFF keeps the legacy referent ordering, recovery turns included', () => {
  // recordDiscussedLift is a PERSISTENT side effect on the server referent store. Hoisting it
  // above the recovery early return changes what a LATER bare correction resolves to — so with
  // ATLAS_TURN_PRECEDENCE off it would be a flag-off behaviour change, which the invariant
  // forbids. A tired turn previously returned without ever recording a referent.
  const iEarly = routeSrc.indexOf('const turnReferentKey = resolveAndRecordTurnReferent();');
  const iRecovery = routeSrc.indexOf('if (tired) {', iEarly);
  const iLegacy = routeSrc.indexOf('if (!isTurnPrecedenceEnabled()) resolveAndRecordTurnReferent();');

  assert.ok(iEarly !== -1 && iRecovery !== -1 && iLegacy !== -1, 'both invocation sites exist');
  assert.ok(iEarly < iRecovery, 'flag ON resolves before the recovery early return');
  assert.ok(iLegacy > iRecovery, 'flag OFF resolves at the legacy position, after it');

  // The early site must be gated, or the side effect leaks into the flag-off path.
  const gate = routeSrc.slice(routeSrc.lastIndexOf('if (isTurnPrecedenceEnabled()) {', iEarly), iEarly);
  assert.match(gate, /if \(isTurnPrecedenceEnabled\(\)\) \{/,
    'the early resolve+record runs only when the Phase 4 flag is enabled');
});

test('criterion 4a — the resolver body is defined ONCE and shared by both invocation sites', () => {
  const defs = routeSrc.split('\n').filter((l) => /const resolveAndRecordTurnReferent = /.test(l));
  assert.equal(defs.length, 1, 'one definition — the two paths cannot drift apart');
  const calls = routeSrc.split('\n').filter((l) =>
    /resolveAndRecordTurnReferent\(\)/.test(l) && !/const resolveAndRecordTurnReferent/.test(l));
  assert.equal(calls.length, 2, 'exactly two mutually exclusive invocation sites');
});
