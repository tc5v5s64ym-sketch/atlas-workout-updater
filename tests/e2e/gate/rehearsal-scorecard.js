'use strict';

// ── F-SB4B rehearsal-session scorecard (TEMPORARY; sunset: F-SB4C) ──────────────
// Adapted from the proven Stage A scorecard (stage-a-canary-scorecard.js, sunset PR
// #1234) under the owner resolution recorded in docs/ATLAS_V1_EXECUTION_PLAN.md.
//
// Scores ONE rehearsal run against the FROZEN condition list below — the F-SB4 card's
// 25 common scorecard items made mechanical. Pure and deterministic: no clock, network,
// filesystem, Sheets, or environment access — the caller collects observations, this
// module decides what they prove.
//
// `rehearsal_eligible` is the single published field that decides whether a run may
// advance the rehearsal streak. Nothing else in the repository may grant credit.
//
// Four statuses, no fifth; missing evidence is ERROR, never PASS and never FAIL.
// NOT_APPLICABLE is legal ONLY where a scenario's declared expectation makes a
// condition genuinely outside the session (e.g. Session 4 declares no Effort data, so
// the Effort-row condition asserts ABSENCE rather than going N/A — there is no
// owner-authorized N/A in this rehearsal: "No authorized N/A may hide a seam this
// rehearsal is intended to test"). The frozen list is the point: every condition is
// always emitted, and removing an assertion turns the run RED rather than quietly
// shrinking the bar.

const {
  REHEARSAL_SESSION, REHEARSAL_DEBUG, REHEARSAL_STREAK_LENGTH,
  normalizePurpose, isQualifyingPurpose, isRehearsalSessionNumber,
  workoutIdentityRefusal, runIdentityRefusal,
} = require('./rehearsal-run-purpose');
const { sessionPlanSetsColumns } = require('../../../config/columns');
// The ENGINE's own fail-closed ledger selectors decide chain validity — the scorecard
// never reimplements supersession rules, it asks the same authority the seal uses.
const { parseRow: parseLedgerRow, effectivePlan: ledgerEffectivePlan } = require('../../../services/sessionPlanLedger');

const PASS = 'PASS';
const FAIL = 'FAIL';
const ERROR = 'ERROR';
const NOT_APPLICABLE = 'NOT_APPLICABLE';

const pass = (detail) => ({ status: PASS, detail });
const fail = (detail) => ({ status: FAIL, detail });
const err = (detail) => ({ status: ERROR, detail });
const missing = (what) => err(`no evidence recorded for ${what}`);

const isBool = (v) => v === true || v === false;
const arr = (v) => (Array.isArray(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

const SHA_RE = /^[0-9a-f]{40}$/;

// ── the repeat-approval probe classification ───────────────────────────────────
// Pure and bite-able: the spec measures, this decides. A DOM click event proves
// only that an event fired — the probe's own listener firing is NOT evidence the
// APPLICATION approval handler ran (a neutralized handler leaves the dispatch
// observable and everything else unchanged — owner contract review, PR #1254).
// The only affirmative outcomes:
//   handler-invoked          — a second live save request/response was OBSERVED
//                              (application-owned network evidence);
//   refused-disabled-control — the control was present, disabled, provably
//                              dispatched nothing, and issued no request.
// A bare dispatch with no request, an enabled no-op control, or missing counts
// all classify no-op-unproven, which condition 17 refuses.
function classifyRepeatApprovalProbe(p) {
  const probe = p && typeof p === 'object' ? p : {};
  const before = probe.live_saves_before;
  const after = probe.live_saves_after;
  const countsKnown = Number.isInteger(before) && Number.isInteger(after);
  if (countsKnown && after > before) return 'handler-invoked';
  if (countsKnown && after === before
    && probe.control_present === true
    && probe.disabled_at_click === true
    && probe.dispatched === false) return 'refused-disabled-control';
  return 'no-op-unproven';
}

// ── unsupported completed-mutation wording ─────────────────────────────────────
// Pure: decides whether any VISIBLE message claimed a mutation had already happened at
// a time when no mutation had yet occurred.
//
// The defect it exists to prevent (owner instruction 2026-08-03): the scorecard's
// `no_unsupported_claims` condition trusted `claims.unsupported_mutation_wording`,
// which the spec published as a literal `false` with the comment "asserted per-beat
// pre-acceptance above". Per-beat checks covered only selected phrases in selected
// phases; a constant is not evidence, and this is the same false-green class already
// removed from the repeat-approval proof.
//
// Inputs are OBSERVED, not asserted:
//   messages       — [{ text, atMs, phase }] every visible Atlas message, in order
//   mutationAtMs   — when the plan mutation actually became true (null = never)
// A message claiming completion BEFORE mutationAtMs (or at any time when no mutation
// ever occurred) is unsupported. After the mutation the same wording is honest.
//
// Fails CLOSED: unreadable timing with completed-mutation wording present counts as
// unsupported, because the run cannot show the claim was earned.
const COMPLETED_MUTATION_PATTERNS = Object.freeze([
  /i(?:'ve| have) (?:noted|recorded|logged|made|applied) (?:the |that )?(?:substitution|swap|replacement|change)/i,
  /(?:has|have) been (?:swapped|replaced|substituted|changed)/i,
  /(?:i(?:'ve| have) )?(?:swapped|replaced|substituted) (?:it|that|your|the)\b/i,
  /you(?:'re| are) (?:now )?(?:substituting|swapping|doing) /i,
  /(?:substitution|swap|replacement) (?:is )?(?:done|complete|applied|in place|locked in)/i,
  /(?:updated|changed) your plan\b/i,
  /(?:removed|dropped) .{0,30}from your plan\b/i,
]);

function detectUnsupportedMutationWording(input) {
  const i = input && typeof input === 'object' ? input : {};
  const messages = Array.isArray(i.messages) ? i.messages : null;
  if (!messages) {
    return { unsupported: true, detail: 'no visible messages were captured, so a completed-mutation claim cannot be ruled out', matches: [] };
  }
  const mutationAtMs = Number.isFinite(i.mutationAtMs) ? i.mutationAtMs : null;
  const matches = [];
  for (const m of messages) {
    const text = String((m && m.text) || '');
    if (!text) continue;
    const pattern = COMPLETED_MUTATION_PATTERNS.find((re) => re.test(text));
    if (!pattern) continue;
    const atMs = Number.isFinite(m && m.atMs) ? m.atMs : null;
    // Unsupported when the claim landed before the mutation, when no mutation ever
    // happened, or when the claim's own timing is unknown (fail closed).
    const earned = mutationAtMs !== null && atMs !== null && atMs >= mutationAtMs;
    if (!earned) {
      matches.push({
        phase: (m && m.phase) || 'unknown',
        atMs,
        excerpt: text.replace(/\s+/g, ' ').slice(0, 120),
        reason: mutationAtMs === null ? 'no mutation occurred in this run'
          : atMs === null ? 'the message carried no timestamp, so the claim cannot be shown to be earned'
            : 'the claim landed before the mutation',
      });
    }
  }
  if (!matches.length) {
    return {
      unsupported: false,
      detail: mutationAtMs === null
        ? `${messages.length} visible messages swept; no completed-mutation wording, and no mutation occurred`
        : `${messages.length} visible messages swept; every completed-mutation claim landed after the mutation`,
      matches: [],
    };
  }
  return {
    unsupported: true,
    detail: matches.map((m) => `[${m.phase}] "${m.excerpt}" — ${m.reason}`).join('; '),
    matches,
  };
}

// ── independent remaining-work derivation ──────────────────────────────────────
// Pure: derives the EXPECTED ordered remaining list and next-up lift from the FROZEN
// scenario declaration plus the sets the scenario declares were logged. It never reads
// client state, durable rows, or the visible reply.
//
// The defect it exists to prevent (owner instruction 2026-08-03): the remaining-work
// proof read `window.remainingPlannedExercises()` and passed when the visible reply
// repeated that same list. Client state and reply can AGREE and both still be wrong —
// which is the exact corruption shape this rehearsal exists to catch. Evidence may not
// define its own expectation, so the expectation comes from the declaration and both
// observations are compared against it.
//
// declaration = {
//   plan: [{ exercise, target_sets }, …]        // ordered, as accepted
//   loggedNames: ['back squat', 'back squat', …] // one entry per declared logged SET
//   replacement: { sourceName, replacementName } | null   // an ACCEPTED substitution
// }
// Returns { remaining: [names…], nextUp: name|null, complete: [names…] }.
// Names are compared case- and separator-insensitively; the returned names keep the
// declaration's own spelling so a failure message reads like the plan.
function deriveExpectedRemaining(declaration) {
  const d = declaration && typeof declaration === 'object' ? declaration : {};
  const key = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, ' ');
  const plan = Array.isArray(d.plan) ? d.plan : [];
  const loggedNames = (Array.isArray(d.loggedNames) ? d.loggedNames : []).map(key);
  const rep = d.replacement && typeof d.replacement === 'object' ? d.replacement : null;

  // An accepted substitution takes the source's SLOT and position — it is not an
  // append (services/activeReplacement.js applyReplacement).
  const items = plan.map((p) => {
    const name = p && (p.exercise || p.name);
    const isSource = rep && key(name) === key(rep.sourceName);
    return {
      name: isSource ? rep.replacementName : name,
      sets: Number(p && p.target_sets) || 0,
    };
  });

  // Count declared logged sets per lift, then spend them against the ordered plan.
  const loggedCount = new Map();
  for (const n of loggedNames) loggedCount.set(n, (loggedCount.get(n) || 0) + 1);

  // A lift an ACCEPTED substitution removed from the plan is neither remaining nor
  // complete — it is RETIRED, and naming it as outstanding work is its own failure.
  // Without this the Session 3 corruption (a reply and a wrong client state agreeing
  // that the substituted-away source still remains) would slip past both lists.
  const retired = rep ? plan
    .map((p) => p && (p.exercise || p.name))
    .filter((n) => key(n) === key(rep.sourceName)) : [];

  const remaining = [];
  const complete = [];
  for (const item of items) {
    const k = key(item.name);
    const done = loggedCount.get(k) || 0;
    if (item.sets > 0 && done >= item.sets) complete.push(item.name);
    else remaining.push(item.name);
  }
  return { remaining, nextUp: remaining.length ? remaining[0] : null, complete, retired };
}

// Compare an OBSERVED ordered list (client state) against the derived expectation.
// Order matters: "what is left" and "what is next" are both order-dependent facts.
// Returns { ok, problems }.
function compareRemainingToExpectation(observedNames, expectation) {
  const key = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, ' ');
  const problems = [];
  const exp = (expectation && Array.isArray(expectation.remaining)) ? expectation.remaining : null;
  if (!exp) return { ok: false, problems: ['no derived expectation was supplied'] };
  const got = Array.isArray(observedNames) ? observedNames.map(key) : null;
  if (!got) return { ok: false, problems: ['the observed remaining list was not an array'] };
  const want = exp.map(key);
  if (got.length !== want.length || got.some((n, i) => n !== want[i])) {
    problems.push(`remaining work is [${observedNames.join(', ')}]; the declaration expects [${exp.join(', ')}]`);
  }
  return { ok: problems.length === 0, problems };
}

// Does the visible reply actually name the expected next-up lift, and does it avoid
// naming anything the declaration says is already COMPLETE? A reply that repeats a
// wrong client state fails against the declaration even when the two agree.
function replyMatchesExpectation(replyText, expectation) {
  const problems = [];
  const text = String(replyText == null ? '' : replyText);
  const exp = expectation && typeof expectation === 'object' ? expectation : {};
  const mentions = (name) => {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    // Match on the full phrase with flexible separators, not a single leading word:
    // "Bench Press" and "Bench" must not be treated as interchangeable evidence.
    const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]+');
    return new RegExp(pattern, 'i').test(text);
  };
  for (const name of (Array.isArray(exp.remaining) ? exp.remaining : [])) {
    if (!mentions(name)) problems.push(`the reply does not name remaining lift "${name}"`);
  }
  for (const name of (Array.isArray(exp.complete) ? exp.complete : [])) {
    if (mentions(name)) problems.push(`the reply names "${name}", which the declaration says is already complete`);
  }
  for (const name of (Array.isArray(exp.retired) ? exp.retired : [])) {
    if (mentions(name)) problems.push(`the reply names "${name}", which an accepted substitution removed from the plan`);
  }
  return { ok: problems.length === 0, problems };
}

// ── reply-settlement classification ────────────────────────────────────────────
// Pure and bite-able: the spec OBSERVES (bubble text, served messages, how long the
// text has been unchanged), this DECIDES whether the reply has finished rendering.
//
// The defect it exists to prevent (owner instruction 2026-08-03): the previous probe
// accepted a reply once the observed text stopped changing for 750 ms. Text that has
// stopped changing is not text that has FINISHED — `typeOut` renders character by
// character, so a pause mid-render is indistinguishable from the end. Session 2
// captured the trailing fragment "ve." while the server had served the complete reply
// (message_len 167 and 321 in the coach-turn shadow).
//
// So stability alone can only settle a turn that served NO message. When a message was
// served, the bubble must contain the whole of it: `served-complete` is the only
// affirmative outcome, and a bubble that goes quiet while still shorter is
// `partial-render` — refused, never settled.
//
// Whitespace is normalized on both sides because the DOM re-wraps text; nothing else
// about the served message is relaxed.
function classifySettlement(observation) {
  const o = observation && typeof observation === 'object' ? observation : {};
  const normalize = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  const text = normalize(o.text);
  const served = (Array.isArray(o.servedMessages) ? o.servedMessages : [])
    .map(normalize).filter((m) => m.length > 0);
  const stableForMs = Number.isFinite(o.stableForMs) ? o.stableForMs : 0;
  const stableThresholdMs = Number.isFinite(o.stableThresholdMs) ? o.stableThresholdMs : 750;
  const thinkingMarker = normalize(o.thinkingMarker || 'Thinking…');

  if (thinkingMarker && text.includes(thinkingMarker)) return 'thinking';
  if (text.length === 0) return 'empty';
  // Authoritative: the whole served reply is on screen. Timing is not consulted.
  if (served.some((m) => text.includes(m))) return 'served-complete';
  if (stableForMs < stableThresholdMs) return 'growing';
  // Quiet, but a message WAS served and this is not all of it.
  if (served.length > 0) return 'partial-render';
  return 'stable-no-served-message';
}

// The two outcomes a caller may treat as settled.
const SETTLED_OUTCOMES = Object.freeze(['served-complete', 'stable-no-served-message']);
function isSettled(outcome) { return SETTLED_OUTCOMES.includes(outcome); }

// ── the scenario-declared ledger multiset ──────────────────────────────────────
// Compares the session's raw Session_Plan_Sets rows (arrays in the
// sessionPlanSetsColumns order, exactly as the durable verifier serves them)
// against the scenario's declared ledger: the accepted v1 grain per item AND the
// substitution revision grain, row for row. Row counts, item counts, and seal
// counts alone cannot distinguish "the declared workout" from "any 14 sealed
// rows" — revisions attached to the wrong slot, swapped set indexes, a duplicate
// accepted row standing in for a revision, or a broken supersession chain all
// preserve the counts. Every declared row must be matched exactly once, every
// durable row must match a declaration, and the chain must validate through the
// engine's own selectors.
//
// declaration = {
//   accepted: [{ lift, set_count, weight, reps, rir }],   // one entry per plan item
//   revisions: {
//     source_lift,           // the accepted slot the revisions must bind to
//     replacement_lift,      // the durable lift code the revisions must carry
//     rows,                  // exact revision row count
//     set_indexes,           // exact set indexes, e.g. [1, 2]
//     source,                // exact recommendation_source, e.g. 'live_revision'
//     plan_version,          // exact ledger version, e.g. 2
//     weight, reps,          // the approved proposal's own numbers
//     rir,                   // optional: asserted only when the proposal carried one
//   } | null,                // null = the scenario declares no revisions
//   confidence,              // the exact durable confidence every row must carry
// }
// Revision target_set_count is NOT separately declarable: it must equal the matched
// source item's accepted set_count — the immutable accepted grain (PR #1249) that a
// revision may never inflate.
// Returns { ok, problems }; pure, throws never (a malformed row is a problem).
function compareLedgerToDeclaration(rawRows, declaration) {
  const problems = [];
  const col = (name) => sessionPlanSetsColumns.indexOf(name);
  const idx = {
    key: col('idempotency_key'), sid: col('session_id'), version: col('plan_version'),
    item: col('plan_item_id'), lift: col('planned_lift_code'), set: col('set_index'),
    count: col('target_set_count'), weight: col('target_weight'), reps: col('target_reps'),
    rir: col('target_rir'), src: col('recommendation_source'), supersedes: col('supersedes_key'),
    confidence: col('confidence'), seal: col('closeout_write_id'),
  };
  const rows = (Array.isArray(rawRows) ? rawRows : []).map((r) => (Array.isArray(r) ? r : []));
  const decl = declaration && typeof declaration === 'object' ? declaration : {};
  const declaredAccepted = Array.isArray(decl.accepted) ? decl.accepted : [];
  const rev = decl.revisions || null;

  if (!rows.length) return { ok: false, problems: ['zero ledger rows for this session'] };
  for (const r of rows) {
    if (parseLedgerRow(sessionPlanSetsColumns.map((_, i) => (r[i] == null ? '' : String(r[i])))).malformed) {
      problems.push('a ledger row is structurally unparseable');
    }
  }

  // One session identity and ONE seal across the whole session ledger.
  const sids = [...new Set(rows.map((r) => String(r[idx.sid] || '').trim()))];
  if (sids.length !== 1) problems.push(`rows span ${sids.length} session identities`);
  const seals = rows.map((r) => String(r[idx.seal] || '').trim());
  if (seals.some((s) => s === '')) problems.push(`${seals.filter((s) => s === '').length} row(s) carry no closeout seal`);
  const distinctSeals = [...new Set(seals.filter((s) => s !== ''))];
  if (distinctSeals.length > 1) problems.push(`rows carry ${distinctSeals.length} different closeout seals (mismatched seal)`);

  const accepted = rows.filter((r) => String(r[idx.src] || '').trim() === 'accepted');
  const others = rows.filter((r) => String(r[idx.src] || '').trim() !== 'accepted');

  // Accepted v1 grain: exactly the declared items, each with set indexes 1..count,
  // no duplicates, no gaps, exact targets, version 1, no supersession.
  const byItem = new Map();
  for (const r of accepted) {
    const item = String(r[idx.item] || '').trim();
    if (!byItem.has(item)) byItem.set(item, []);
    byItem.get(item).push(r);
  }
  if (byItem.size !== declaredAccepted.length) {
    problems.push(`expected ${declaredAccepted.length} accepted plan items, found ${byItem.size}`);
  }
  const remainingDecl = declaredAccepted.slice();
  const acceptedKeyBySlot = new Map(); // `${item}#${set}` -> idempotency_key (for supersession checks)
  let acceptedLiftForRevisions = null;
  for (const [item, itemRows] of byItem) {
    const lifts = [...new Set(itemRows.map((r) => String(r[idx.lift] || '').trim().toUpperCase()))];
    if (lifts.length !== 1) { problems.push(`accepted item ${item} spans lift codes ${lifts.join('/')}`); continue; }
    const lift = lifts[0];
    const di = remainingDecl.findIndex((d) => String(d.lift).toUpperCase() === lift);
    if (di < 0) { problems.push(`accepted item for ${lift} matches no declared plan item (or a declared item was consumed twice)`); continue; }
    const d = remainingDecl.splice(di, 1)[0];
    const wantSets = Array.from({ length: d.set_count }, (_, i) => i + 1);
    const gotSets = itemRows.map((r) => Number(r[idx.set])).sort((a, b) => a - b);
    if (JSON.stringify(gotSets) !== JSON.stringify(wantSets)) {
      problems.push(`accepted ${lift}: set indexes [${gotSets.join(',')}], declared [${wantSets.join(',')}] (duplicate or missing accepted set index)`);
    }
    for (const r of itemRows) {
      if (Number(r[idx.count]) !== d.set_count) problems.push(`accepted ${lift} set ${r[idx.set]}: target_set_count ${r[idx.count]}, declared ${d.set_count}`);
      if (!cellEquals(r[idx.weight], d.weight)) problems.push(`accepted ${lift} set ${r[idx.set]}: weight ${r[idx.weight]}, declared ${d.weight}`);
      if (!cellEquals(r[idx.reps], d.reps)) problems.push(`accepted ${lift} set ${r[idx.set]}: reps ${r[idx.reps]}, declared ${d.reps}`);
      if (d.rir != null && !cellEquals(r[idx.rir], d.rir)) problems.push(`accepted ${lift} set ${r[idx.set]}: rir ${r[idx.rir]}, declared ${d.rir}`);
      if (Number(r[idx.version]) !== 1) problems.push(`accepted ${lift} set ${r[idx.set]}: plan_version ${r[idx.version]}, expected 1`);
      if (String(r[idx.supersedes] || '').trim() !== '') problems.push(`accepted ${lift} set ${r[idx.set]} carries a supersedes_key — an accepted v1 row supersedes nothing`);
      if (String(r[idx.confidence] || '').trim() !== String(decl.confidence || '')) {
        problems.push(`accepted ${lift} set ${r[idx.set]}: confidence "${r[idx.confidence]}", declared "${decl.confidence}"`);
      }
      acceptedKeyBySlot.set(`${String(r[idx.item]).trim()}#${Number(r[idx.set])}`, String(r[idx.key] || '').trim());
    }
    if (rev && lift === String(rev.source_lift).toUpperCase()) acceptedLiftForRevisions = item;
  }
  for (const d of remainingDecl) problems.push(`declared plan item ${d.lift} has no accepted ledger rows`);

  // Revision grain: exactly the declared revision rows, bound to the source slot,
  // carrying the replacement lift, the declared version/source, and a supersession
  // key naming the SAME-SET accepted row.
  if (!rev) {
    if (others.length) problems.push(`${others.length} non-accepted row(s) present but the scenario declares no revisions`);
  } else {
    if (others.length !== rev.rows) problems.push(`expected ${rev.rows} revision row(s), found ${others.length} (missing or unexpected extra revision)`);
    if (!acceptedLiftForRevisions) problems.push(`no single accepted item carries the revision source lift ${rev.source_lift}`);
    const srcDecl = declaredAccepted.find((d) => String(d.lift).toUpperCase() === String(rev.source_lift).toUpperCase()) || null;
    const gotRevSets = others.map((r) => Number(r[idx.set])).sort((a, b) => a - b);
    const wantRevSets = (rev.set_indexes || []).slice().sort((a, b) => a - b);
    if (JSON.stringify(gotRevSets) !== JSON.stringify(wantRevSets)) {
      problems.push(`revision set indexes [${gotRevSets.join(',')}], declared [${wantRevSets.join(',')}]`);
    }
    for (const r of others) {
      const item = String(r[idx.item] || '').trim();
      const set = Number(r[idx.set]);
      if (acceptedLiftForRevisions && item !== acceptedLiftForRevisions) {
        problems.push(`revision set ${set} is attached to item ${item}, not the accepted ${rev.source_lift} slot ${acceptedLiftForRevisions}`);
      }
      const lift = String(r[idx.lift] || '').trim().toUpperCase();
      if (lift !== String(rev.replacement_lift || '').toUpperCase()) {
        problems.push(`revision set ${set}: lift code ${lift || '(blank)'}, expected the replacement ${rev.replacement_lift}`);
      }
      if (String(r[idx.src] || '').trim() !== rev.source) problems.push(`revision set ${set}: recommendation_source "${r[idx.src]}", expected "${rev.source}"`);
      if (Number(r[idx.version]) !== rev.plan_version) problems.push(`revision set ${set}: plan_version ${r[idx.version]}, expected ${rev.plan_version}`);
      // The immutable accepted grain (PR #1249): a revision's target_set_count must
      // equal the SOURCE item's accepted set_count — never inflated, never shrunk.
      if (srcDecl && Number(r[idx.count]) !== srcDecl.set_count) {
        problems.push(`revision set ${set}: target_set_count ${r[idx.count]} differs from the immutable accepted grain ${srcDecl.set_count}`);
      }
      if (String(r[idx.confidence] || '').trim() !== String(decl.confidence || '')) {
        problems.push(`revision set ${set}: confidence "${r[idx.confidence]}", declared "${decl.confidence}"`);
      }
      if (!cellEquals(r[idx.weight], rev.weight)) problems.push(`revision set ${set}: weight ${r[idx.weight]}, expected the proposal's ${rev.weight}`);
      if (!cellEquals(r[idx.reps], rev.reps)) problems.push(`revision set ${set}: reps ${r[idx.reps]}, expected the proposal's ${rev.reps}`);
      if (rev.rir != null && !cellEquals(r[idx.rir], rev.rir)) problems.push(`revision set ${set}: rir ${r[idx.rir]}, expected ${rev.rir}`);
      const wantSupersedes = acceptedKeyBySlot.get(`${item}#${set}`);
      const gotSupersedes = String(r[idx.supersedes] || '').trim();
      if (!wantSupersedes || gotSupersedes !== wantSupersedes) {
        problems.push(`revision set ${set}: supersedes_key does not name the same-set accepted row (broken supersession binding)`);
      }
    }
  }

  // Chain validity through the engine's own fail-closed selectors.
  const rawForEngine = rows.map((r) => sessionPlanSetsColumns.map((_, i) => (r[i] == null ? '' : String(r[i]))));
  const itemIds = [...new Set(rawForEngine.map((r) => parseLedgerRow(r).rec.plan_item_id).filter(Boolean))];
  for (const itemId of itemIds) {
    const eff = ledgerEffectivePlan(rawForEngine, itemId);
    const bad = eff.find((e) => e.confidence === 'no_reliable_target' && e.reason === 'malformed_chain');
    if (bad) problems.push(`item ${itemId} set ${bad.set_index}: the engine's selectors refuse this history (malformed_chain)`);
  }

  // Exact total: nothing beyond the declared multiset may ride along.
  const declaredTotal = declaredAccepted.reduce((n, d) => n + d.set_count, 0) + (rev ? rev.rows : 0);
  if (rows.length !== declaredTotal) problems.push(`${rows.length} total rows, declared ${declaredTotal}`);

  return { ok: problems.length === 0, problems };
}

// Sheets string/number ambiguity ('225' vs 225) without treating '' as 0.
function cellEquals(cell, expected) {
  const raw = cell == null ? '' : String(cell).trim();
  if (raw === '') return false;
  if (typeof expected === 'number') return Number(raw) === expected;
  return raw.toLowerCase() === String(expected).trim().toLowerCase();
}

// ── the frozen condition list (card items 1–25) ────────────────────────────────
// Each entry: { id, title, evaluate(obs) -> {status, detail} }; evaluate must
// tolerate a completely absent observation branch and return ERROR.
const CONDITIONS = Object.freeze([
  // (1) clean source main, exact SHA recorded — measured by the RUN, not asserted.
  //
  // This condition asks TWO questions that used to be welded together (owner
  // instruction 2026-08-03):
  //   a. is the source tree exact and clean? — asked under BOTH purposes, always;
  //   b. is this session number legal at the canonical count? — a QUALIFYING rule only.
  //
  // Welding them made a five-scenario diagnostic sweep from exact main impossible: at
  // count 0/5 a Session 2 run failed here no matter how the product behaved. The
  // practice that grew around that — running from an OFF-MAIN tree so this condition
  // failed for a different reason and the run quietly did not count — used a failure as
  // a mode switch. Purpose is now declared, so (b) is applied to the runs it governs.
  //
  // A debug run still READS and RECORDS the count: evidence that cannot state the count
  // it ran at is not honest evidence. It simply is not ordered against it.
  {
    id: 'source_tree_verified',
    title: 'clean main equal to origin/main with the exact SHA recorded; a qualifying session is also legal at the canonical count',
    evaluate(obs) {
      const s = obs && obs.source;
      if (!s) return missing('the source tree');
      if (s.branch !== 'main') return err(`the run executed on "${s.branch || 'unknown'}", not main`);
      if (s.clean !== true) return err('the worktree was not clean');
      if (!SHA_RE.test(str(s.head_sha))) return err('HEAD did not resolve to a full sha');
      if (s.head_sha !== s.origin_head_sha) return err(`HEAD ${str(s.head_sha).slice(0, 7)} != origin/main ${str(s.origin_head_sha).slice(0, 7)}`);
      const n = obs.session_number;
      if (!isRehearsalSessionNumber(n)) return err(`session number ${n} is not 1..${REHEARSAL_STREAK_LENGTH}`);

      const purpose = normalizePurpose(obs.run_purpose);
      if (purpose === null) return err('the run declared no recognized purpose, so count legality cannot be judged');
      const prior = s.prior_rehearsal_count;
      if (!Number.isInteger(prior)) {
        return err(`the canonical rehearsal count was unreadable (${s.prior_count_reason || 'no reason recorded'}); every run must record the count it ran at`);
      }
      const head = `main @ ${s.head_sha.slice(0, 12)} (= origin/main, clean)`;
      if (!isQualifyingPurpose(purpose)) {
        return pass(`${head}; DIAGNOSTIC (${purpose}) session ${n} ran at canonical count ${prior}/${REHEARSAL_STREAK_LENGTH} — not ordered against it, and cannot advance it`);
      }
      if (prior !== n - 1) {
        return fail(`session ${n} is legal only at count ${n - 1}/${REHEARSAL_STREAK_LENGTH}; the plan recorded ${prior}/${REHEARSAL_STREAK_LENGTH}`);
      }
      return pass(`${head}; qualifying session ${n} at prior count ${prior}/${REHEARSAL_STREAK_LENGTH}`);
    },
  },
  // (2) fresh synthetic identities — run family + the INVERTED workout check.
  {
    id: 'fresh_identities',
    title: 'fresh run/athlete identities; the workout identity was SERVER-allocated, never pre-seeded',
    evaluate(obs) {
      if (normalizePurpose(obs && obs.run_purpose) === null) {
        return err(`the run declared no recognized purpose (got "${(obs && obs.run_purpose) || ''}"); expected ${REHEARSAL_SESSION} or ${REHEARSAL_DEBUG}`);
      }
      const runRef = runIdentityRefusal({ sessionNumber: obs.session_number, runId: obs.run_id });
      if (runRef) return err(runRef);
      if (!str(obs.athlete_id)) return missing('the synthetic athlete id');
      const wRef = workoutIdentityRefusal({ workoutSessionId: obs.workout_session_id });
      if (wRef) return fail(wRef);
      if (obs.workout_id_preseeded === true) return fail('the workout id was present before acceptance — pre-seeded, not allocated');
      return pass(`run ${obs.run_id}; workout ${obs.workout_session_id} allocated by the server at acceptance`);
    },
  },
  // (3) model-up proven positively.
  {
    id: 'model_posture_proven',
    title: 'model-up with the provider proven reachable and a live-provider turn observed',
    evaluate(obs) {
      const m = obs && obs.model;
      if (!m) return missing('the model posture');
      if (m.posture !== 'model-up') return err(`the harness posture was "${m.posture || 'unknown'}", not model-up`);
      if (m.provider_reachable !== true) return err('the provider was not proven reachable before the port published');
      if (!str(m.coach_model)) return err('no coach model was recorded');
      if (m.live_provider_turn_observed !== true) return fail('no turn showed an unambiguous live-provider source — model-up is unproven for this run');
      return pass(`model-up (${m.coach_model}); a live-provider turn was observed`);
    },
  },
  // (4) the exact sandbox; production non-contact.
  {
    id: 'sandbox_posture_proven',
    title: 'the combined rehearsal posture served the declared sandbox with every preflight check green',
    evaluate(obs) {
      const s = obs && obs.sandbox;
      if (!s) return missing('the sandbox posture');
      if (s.rehearsal_live !== true) return err('the harness did not report the combined rehearsal posture');
      if (!str(s.sandbox_last6)) return err('no sandbox identity (last6) was recorded');
      if (s.declared_last6 !== s.sandbox_last6) return err(`the served workbook last6 ${s.sandbox_last6} is not the declared sandbox ${s.declared_last6}`);
      if (s.preflight_ok !== true) return err('the sandbox preflight did not pass');
      const checks = arr(s.preflight_checks);
      if (!checks || !checks.length) return missing('the preflight checks');
      const bad = checks.filter((c) => c.ok !== true);
      if (bad.length) return err(`preflight checks failed: ${bad.map((c) => c.name).join(', ')}`);
      return pass(`declared sandbox last6 ${s.sandbox_last6}; ${checks.length} preflight checks green`);
    },
  },
  // (5) no ambient workbook inheritance.
  {
    id: 'ambient_sheet_not_inherited',
    title: 'no ambient GOOGLE_SHEETS_ID crossed into the run',
    evaluate(obs) {
      const s = obs && obs.sandbox;
      if (!s) return missing('the sandbox posture');
      if (s.child_carried_workbook_id === true) return err('the child environment carried a GOOGLE_SHEETS_ID');
      return pass('the workbook id was assigned from config/sandboxSheet.js, never inherited');
    },
  },
  // (6) real browser and built client.
  {
    id: 'real_browser_built_client',
    title: 'a real browser drove the BUILT client shell',
    evaluate(obs) {
      const ui = obs && obs.ui;
      if (!ui) return missing('the browser evidence');
      if (ui.real_browser !== true) return err('the run did not record a real browser');
      if (!str(ui.shell_build)) return err('the built shell recorded no build identity');
      return pass(`built shell ${ui.shell_build} in a real browser`);
    },
  },
  // (7) full production path — the gate server IS index.js; provenance marks synthetic.
  {
    id: 'synthetic_provenance',
    title: 'the full production route stack served the run and every request carried synthetic provenance',
    evaluate(obs) {
      const p = obs && obs.provenance;
      if (!p) return missing('request provenance');
      if (p.request_origin !== 'playwright') return err(`the client marked requests "${p.request_origin || 'nothing'}", not playwright`);
      if (p.real_index_js !== true) return err('the run did not record the real index.js app serving');
      return pass('real Express app; requests marked playwright (synthetic, never owner evidence)');
    },
  },
  // (8) the expected visible conversation — scenario-declared beats all observed.
  {
    id: 'declared_conversation_observed',
    title: 'every scenario-declared conversational beat was observed, in order',
    evaluate(obs) {
      const beats = arr(obs && obs.scenario && obs.scenario.beats);
      if (!beats || !beats.length) return missing('the declared conversation beats');
      const failed = beats.filter((b) => b.ok !== true);
      if (failed.length) return fail(`beats failed: ${failed.map((b) => `${b.id} (${b.detail || 'no detail'})`).join('; ')}`);
      return pass(`${beats.length} declared beats observed`);
    },
  },
  // (9) no unsupported mutation or write claim.
  {
    id: 'no_unsupported_claims',
    title: 'no completed-mutation or write claim appeared without the state to back it',
    evaluate(obs) {
      const c = obs && obs.claims;
      if (!c) return missing('the claim sweep');
      if (c.unsupported_mutation_wording === true) return fail(`completed-mutation wording appeared without a mutation: ${c.detail || ''}`);
      if (c.unsupported_write_claim === true) return fail(`a write claim appeared without a write: ${c.detail || ''}`);
      return pass('no unsupported mutation or write claims in the visible thread');
    },
  },
  // (10) canonical plan state agrees with visible wording.
  {
    id: 'canonical_state_agrees',
    title: 'canonical plan state agreed with the visible wording at every checked point',
    evaluate(obs) {
      const checks = arr(obs && obs.state_agreement);
      if (!checks || !checks.length) return missing('the state-agreement checks');
      const bad = checks.filter((c) => c.ok !== true);
      if (bad.length) return fail(`state disagreed with wording: ${bad.map((c) => `${c.id} (${c.detail || ''})`).join('; ')}`);
      return pass(`${checks.length} state-agreement checks green`);
    },
  },
  // (11) exact Session_Plans events, session-filtered.
  {
    id: 'session_plans_events_exact',
    title: 'the durable Session_Plans events match the scenario declaration exactly (this session only)',
    evaluate(obs) {
      const d = obs && obs.durable && obs.durable.session_plans;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!d) return missing('the durable Session_Plans rows');
      if (!ex) return missing('the scenario declaration');
      const events = arr(d.event_counts) || [];
      const want = ex.session_plans_events || {};
      const got = {};
      for (const e of events) got[e.event] = e.count;
      const problems = [];
      for (const [event, count] of Object.entries(want)) {
        if ((got[event] || 0) !== count) problems.push(`${event}: expected ${count}, found ${got[event] || 0}`);
      }
      for (const [event, count] of Object.entries(got)) {
        if (!(event in want) && count > 0) problems.push(`unexpected event ${event} × ${count}`);
      }
      if (problems.length) return fail(problems.join('; '));
      return pass(Object.entries(want).map(([e, c]) => `${e}×${c}`).join(', ') + ' — exact');
    },
  },
  // (12) exact Session_Plan_Sets binding and seal.
  {
    id: 'session_plan_sets_binding_and_seal',
    title: 'the durable ledger rows carry the accepted grain, correct binding, and one seal',
    evaluate(obs) {
      const d = obs && obs.durable && obs.durable.session_plan_sets;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!d) return missing('the durable Session_Plan_Sets rows');
      if (!ex) return missing('the scenario declaration');
      if (d.row_count !== ex.plan_set_rows) return fail(`expected ${ex.plan_set_rows} ledger rows for this session, found ${d.row_count}`);
      if (d.distinct_seals !== 1) return fail(`expected ONE closeout seal across the session's ledger rows, found ${d.distinct_seals}`);
      if (d.blank_seals !== 0) return fail(`${d.blank_seals} ledger row(s) were left unsealed`);
      if (d.accepted_grain_ok !== true) return fail(d.grain_detail || 'the accepted rows did not carry the declared per-item set counts');
      // Counts alone cannot prove the DECLARED workout: the full scenario multiset —
      // accepted grain per item, revision rows bound to the accepted source slot with
      // the replacement lift and a valid same-set supersession chain, nothing extra —
      // must compare exactly (runner-honesty corrective, owner instruction 2026-08-03).
      if (d.declared_multiset_ok !== true) {
        return fail(d.multiset_detail || 'the ledger rows did not match the scenario-declared multiset (accepted grain + revision chain)');
      }
      return pass(`${d.row_count} rows, one seal, accepted grain exact, declared multiset (incl. revision binding and supersession chain) exact`);
    },
  },
  // (13) exact Log_Cleaned rows.
  {
    id: 'durable_log_rows_exact',
    title: 'the durable Log_Cleaned rows match the scenario declaration exactly (this session only)',
    evaluate(obs) {
      const d = obs && obs.durable && obs.durable.log_cleaned;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!d) return missing('the durable Log_Cleaned rows');
      if (!ex) return missing('the scenario declaration');
      if (d.row_count !== ex.log_rows) return fail(`expected ${ex.log_rows} Log_Cleaned rows, found ${d.row_count}`);
      if (d.rows_match_declaration !== true) return fail(d.detail || 'the rows did not match the declared sets');
      return pass(`${d.row_count} rows, matching the declared sets`);
    },
  },
  // (14) Effort behavior matches whether effort was supplied.
  {
    id: 'effort_behavior_matches',
    title: 'the Effort row exists exactly when the scenario supplied effort data',
    evaluate(obs) {
      const d = obs && obs.durable && obs.durable.effort;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!d) return missing('the durable Effort rows');
      if (!ex) return missing('the scenario declaration');
      const want = ex.effort_supplied ? 1 : 0;
      if (d.row_count !== want) {
        return fail(ex.effort_supplied
          ? `effort was supplied but ${d.row_count} Effort row(s) landed (expected 1)`
          : `no effort was supplied but ${d.row_count} Effort row(s) landed (expected 0) — absence must not fail the write`);
      }
      return pass(ex.effort_supplied ? 'one Effort row, as supplied' : 'no Effort row, and the write did not require one');
    },
  },
  // (15) a preview before the write.
  {
    id: 'preview_before_write',
    title: 'a dry-run preview with the no-write proof preceded the live write',
    evaluate(obs) {
      const w = obs && obs.write;
      if (!w) return missing('the write evidence');
      if (w.preview_seen !== true) return err('no preview was observed');
      if (w.preview_no_write_confirmed !== true) return fail('the preview did not carry the no-write proof');
      if (w.preview_before_write !== true) return fail('the preview did not precede the live write');
      return pass('preview (no_write_confirmed) → approval → write, in order');
    },
  },
  // (16) one visible approval.
  {
    id: 'browser_approval',
    title: 'exactly one visible approval action released the write',
    evaluate(obs) {
      const w = obs && obs.write;
      if (!w) return missing('the write evidence');
      if (w.approvals_clicked !== 1) return fail(`${w.approvals_clicked} approval actions were performed (expected exactly 1)`);
      if (w.write_success !== true) return fail('the approved write did not report success');
      return pass('one visible approval; the write reported success with proof fields');
    },
  },
  // (17) a repeated approval writes nothing.
  {
    id: 'approval_at_most_once',
    title: 'a repeated approval created zero duplicate durable rows',
    evaluate(obs) {
      const w = obs && obs.write;
      if (!w) return missing('the write evidence');
      if (w.repeat_attempted !== true) return err('the repeat-approval probe did not run');
      // A hardcoded flag is not evidence: the probe must record HOW the repeat
      // attempt landed — either the write handler was provably invoked, or the
      // approval gate provably refused it (a disabled control whose click dispatched
      // nothing AND issued no request). A click that cannot prove either is a no-op,
      // and a no-op proves nothing about repeat safety (owner P1, 2026-08-03).
      const outcome = str(w.repeat_outcome);
      if (outcome !== 'handler-invoked' && outcome !== 'refused-disabled-control') {
        return fail(`the repeat attempt carries no affirmative evidence (outcome "${outcome || 'unrecorded'}") — a no-op click cannot prove the write path refuses repeats`);
      }
      if (w.duplicate_rows !== 0) return fail(`${w.duplicate_rows} duplicate durable row(s) appeared after the repeated approval (checked across Log_Cleaned, Effort, Session_Plans, Session_Plan_Sets)`);
      return pass(outcome === 'handler-invoked'
        ? 'the repeated approval reached the write handler and produced zero new durable rows across all four tabs'
        : 'the repeated approval was refused by the disabled approval control (proven no-dispatch, no request) and zero new durable rows appeared across all four tabs');
    },
  },
  // (18) correct closeout state.
  {
    id: 'closeout_state_correct',
    title: 'the closeout reached the scenario-declared final state honestly',
    evaluate(obs) {
      const c = obs && obs.closeout;
      const ex = obs && obs.scenario && obs.scenario.expected;
      if (!c) return missing('the closeout evidence');
      if (!ex) return missing('the scenario declaration');
      if (c.fully_verified !== ex.closeout_fully_verified) {
        return fail(`closeout_fully_verified was ${c.fully_verified}, declared ${ex.closeout_fully_verified}`);
      }
      if (c.ui_stuck_saving === true) return fail('the visible Save control stayed on "Saving…"');
      if (c.final_state_ok !== true) return fail(c.detail || 'the visible closeout state was wrong');
      return pass(`closeout_fully_verified=${c.fully_verified}, visible state correct`);
    },
  },
  // (19) InteractionTrace and turn-write proof join on the live write's turn_id.
  {
    id: 'trace_write_join',
    title: 'the InteractionTrace and the turn-write proof join on the live write turn',
    evaluate(obs) {
      const t = obs && obs.trace;
      if (!t) return missing('the trace/write-proof join');
      if (t.join_ok !== true) return fail(t.detail || 'the trace and the turn-write proof did not join on the live write turn_id');
      return pass(`joined on turn ${t.turn_id || '(recorded)'}`);
    },
  },
  // (20) the corrected review tool finds the exact session.
  {
    id: 'review_tool_adjudicates',
    title: 'atlas:review-live finds exactly this session and passes its trust criteria',
    evaluate(obs) {
      const r = obs && obs.review;
      if (!r) return missing('the review-tool adjudication');
      if (r.found_exact_session !== true) return fail('the review tool did not correlate this exact session');
      if (r.all_unknown === true) return fail('the review tool returned an all-UNKNOWN verdict');
      if (r.failed_criteria && r.failed_criteria.length) return fail(`review criteria failed: ${r.failed_criteria.join(', ')}`);
      return pass('the review tool adjudicated this exact session with no failed criterion');
    },
  },
  // (21) /api/summary/weekly succeeds.
  {
    id: 'weekly_summary_succeeds',
    title: 'GET /api/summary/weekly returns HTTP 200 with a bounded valid body',
    evaluate(obs) {
      const w = obs && obs.weekly;
      if (!w) return missing('the weekly-summary probe');
      if (w.status !== 200) return fail(`/api/summary/weekly returned ${w.status}${w.detail ? ` (${w.detail})` : ''}`);
      if (w.valid_body !== true) return fail('the weekly summary body was not a bounded valid response');
      return pass('200 with a valid bounded body');
    },
  },
  // (22) no foreign identity or cross-session rows.
  {
    id: 'no_cross_session_rows',
    title: 'every durable row read for this session carries this session\'s identity, and foreign identities are unreachable',
    evaluate(obs) {
      const d = obs && obs.durable;
      if (!d) return missing('the durable evidence');
      if (d.foreign_rows !== 0) return fail(`${d.foreign_rows} row(s) carrying another identity rode along`);
      if (d.foreign_id_probe_status !== 403) return fail(`the verifier answered ${d.foreign_id_probe_status} for a foreign identity (expected 403)`);
      return pass('all rows carry this session\'s identity; a foreign-identity read was refused (403)');
    },
  },
  // (23) no secret, token, fingerprint, or workbook ID leakage.
  {
    id: 'artifacts_privacy_safe',
    title: 'the published artifacts leak no secret, token, or full workbook id',
    evaluate(obs) {
      const a = obs && obs.artifacts;
      if (!a) return missing('the artifact sweep');
      if (a.leaks && a.leaks.length) return fail(`artifact leakage: ${a.leaks.join(', ')}`);
      if (a.swept !== true) return err('the artifact privacy sweep did not run');
      return pass('artifacts name the workbook by last6 only; no credential or token material found');
    },
  },
  // (24) bounded local artifacts with SHA-256 hashes.
  {
    id: 'artifacts_hashed',
    title: 'the run preserved bounded artifacts with SHA-256 hashes',
    evaluate(obs) {
      const a = obs && obs.artifacts;
      if (!a) return missing('the artifact record');
      const files = arr(a.files);
      if (!files || !files.length) return err('no artifacts were preserved');
      const unhashed = files.filter((f) => !/^[0-9a-f]{64}$/.test(str(f.sha256)));
      if (unhashed.length) return err(`artifacts without hashes: ${unhashed.map((f) => f.name).join(', ')}`);
      return pass(`${files.length} artifacts, each with a SHA-256`);
    },
  },
  // (25) counts and reasons — emitted by construction: the scorecard itself.
  {
    id: 'schema_and_guard_clean',
    title: 'no schema mutation and no guard refusal occurred (a refusal is a finding, never a pass)',
    evaluate(obs) {
      const g = obs && obs.guard;
      if (!g) return missing('the guard record');
      if ((g.ensure_tab_calls || 0) !== 0) return fail(`${g.ensure_tab_calls} ensureSheetTab call(s) were attempted`);
      if ((g.refusals || 0) !== 0) return fail(`${g.refusals} guard refusal(s) occurred — production attempted something this rehearsal may not do`);
      const seals = g.seal_updates;
      if (!Number.isInteger(seals) || seals < 1) return fail('the closeout seal update was not observed through the guard');
      return pass(`no refusals, no schema calls, ${seals} seal update(s) through the authorized column`);
    },
  },
]);

// ── scoring ────────────────────────────────────────────────────────────────────
function scoreRehearsalRun(observations) {
  const obs = observations && typeof observations === 'object' ? observations : {};
  const conditions = CONDITIONS.map((c) => {
    let result;
    try {
      result = c.evaluate(obs);
    } catch (e) {
      result = err(`the condition evaluator threw: ${e && e.message}`);
    }
    return { id: c.id, title: c.title, status: result.status, detail: result.detail };
  });

  const counts = { PASS: 0, FAIL: 0, ERROR: 0, NOT_APPLICABLE: 0 };
  for (const c of conditions) counts[c.status] += 1;
  const overall = counts.FAIL > 0 ? FAIL : (counts.ERROR > 0 ? ERROR : PASS);

  // ── ELIGIBILITY ─────────────────────────────────────────────────────────────
  // TWO independent conditions, both required, evaluated in this order so the reason
  // is always the honest one:
  //   1. the run was DECLARED qualifying — a debug run is ineligible by construction,
  //      no matter how well it scored;
  //   2. every condition passed.
  // A run whose purpose is absent, unknown, or malformed fails (1) and is ineligible:
  // eligibility fails closed, and there is no override flag.
  const purpose = normalizePurpose(obs.run_purpose);
  const qualifying = isQualifyingPurpose(purpose);
  const eligible = qualifying && overall === PASS;

  let note;
  if (!qualifying) {
    note = purpose === null
      ? 'this run declared no recognized purpose and can never advance the rehearsal streak'
      : `DIAGNOSTIC RUN (${purpose}) — scenario evidence only. It can never advance or authorize the rehearsal count, and a full ${counts.PASS}/${conditions.length} score does not make it eligible.`;
  } else if (eligible) {
    note = `this run qualifies as rehearsal session ${obs.session_number} — record the count advance in a reviewed status PR`;
  } else {
    note = 'this run does NOT advance the rehearsal streak';
  }

  return {
    // The purpose actually DECLARED by the run, never a constant: a scorecard that
    // always printed the qualifying purpose would misdescribe every debug artifact.
    purpose: purpose || null,
    qualifying,
    diagnostic: !qualifying,
    session_number: obs.session_number ?? null,
    scenario: (obs.scenario && obs.scenario.id) || null,
    overall,
    counts,
    conditions,
    rehearsal_eligible: eligible,
    rehearsal_note: note,
  };
}

function renderMarkdown(card) {
  // Every artifact states its purpose in its FIRST line. A diagnostic scorecard that
  // reads like a qualifying one is exactly how a non-counting run gets mistaken for a
  // counted one weeks later.
  const banner = card.qualifying
    ? `# F-SB4B QUALIFYING rehearsal session ${card.session_number ?? '?'} — ${card.overall}`
    : `# F-SB4B DIAGNOSTIC (NON-COUNTING) rehearsal session ${card.session_number ?? '?'} — ${card.overall}`;
  const lines = [
    banner,
    '',
    `Purpose: ${card.purpose || '(none declared)'}${card.qualifying ? '' : ' — scenario evidence only; cannot advance or authorize the rehearsal count'}`,
    `Scenario: ${card.scenario || '(none)'} · PASS ${card.counts.PASS} · FAIL ${card.counts.FAIL} · ERROR ${card.counts.ERROR} · N/A ${card.counts.NOT_APPLICABLE}`,
    `rehearsal_eligible: ${card.rehearsal_eligible}`,
    card.rehearsal_note,
    '',
    '| # | condition | status | detail |',
    '|---|---|---|---|',
  ];
  card.conditions.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.id} | ${c.status} | ${String(c.detail || '').replace(/\|/g, '\\|')} |`);
  });
  return `${lines.join('\n')}\n`;
}

module.exports = { CONDITIONS, scoreRehearsalRun, renderMarkdown, compareLedgerToDeclaration, classifyRepeatApprovalProbe, classifySettlement, isSettled, SETTLED_OUTCOMES, deriveExpectedRemaining, compareRemainingToExpectation, replyMatchesExpectation, detectUnsupportedMutationWording, COMPLETED_MUTATION_PATTERNS, PASS, FAIL, ERROR, NOT_APPLICABLE };
