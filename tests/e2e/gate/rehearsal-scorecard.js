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
  REHEARSAL_SESSION, REHEARSAL_DEBUG, PERSONA_RUN, REHEARSAL_STREAK_LENGTH, REQUIRED_BRANCH,
  normalizePurpose, isQualifyingPurpose, isRehearsalSessionNumber,
  workoutIdentityRefusal, runIdentityRefusal, personaRunIdentityRefusal,
} = require('./rehearsal-run-purpose');
const { sessionPlanSetsColumns } = require('../../../config/columns');
// The ENGINE's own fail-closed ledger selectors decide chain validity — the scorecard
// never reimplements supersession rules, it asks the same authority the seal uses.
const { parseRow: parseLedgerRow, effectivePlan: ledgerEffectivePlan } = require('../../../services/sessionPlanLedger');
// The causal ordering primitive: a claim is only "earned" when it is provably after the
// boundary. A report that arrived after an UNDRAINED boundary is `uncertain`, because the
// coalescing flush window means it may describe a change that predates it.
const { classifyClaimAgainstBoundary } = require('./rehearsal-bubble-observer');

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

// ── replacement identity, captured independently of the durable rows ───────────
// Pure: compares every durable surface against ONE independently-captured identity.
//
// The circularity this removes (owner instruction 2026-08-03): the spec identified the
// substitute's Log_Cleaned rows partly by exclusion, weight and reps, derived
// `subLogLiftCodes[0]` FROM those rows, and then used that derived code as the expected
// `performed_lift_code` on the Session_Plans outcome and as the expected replacement
// lift on the Session_Plan_Sets revisions. A consistently WRONG lift code across all
// three surfaces satisfied every check, because the evidence under review defined its
// own expectation.
//
// The expectation must therefore be captured BEFORE any durable read, from the accepted
// pending proposal itself: the replacement lift code the engine resolved, and the source
// slot the proposal retained. Durable rows are then compared to it and can never define
// it.
//
// identity = { replacementLiftCode, sourceLiftCode, sourcePlanItemId }
// durable  = { logLiftCodes: [], outcomePerformedLiftCode, outcomePlannedLiftCode,
//              outcomePlanItemId, ledgerRevisionLiftCodes: [] }
// Returns { ok, problems }. Fails CLOSED: a missing captured identity is a failure, not
// a licence to fall back on the rows.
function compareReplacementIdentity(identity, durable) {
  const problems = [];
  const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
  const id = identity && typeof identity === 'object' ? identity : {};
  const d = durable && typeof durable === 'object' ? durable : {};

  const expected = up(id.replacementLiftCode);
  const source = up(id.sourceLiftCode);
  if (!expected) {
    return { ok: false, problems: ['no replacement lift code was captured from the accepted proposal — the durable rows may not supply one'] };
  }
  if (expected === source && source !== '') {
    problems.push(`the captured replacement lift code ${expected} equals the source lift — that is not a replacement`);
  }

  const logCodes = [...new Set((Array.isArray(d.logLiftCodes) ? d.logLiftCodes : []).map(up).filter(Boolean))];
  if (logCodes.length === 0) problems.push('the substitute performed no Log_Cleaned rows carrying a lift code');
  else if (logCodes.length > 1) problems.push(`the substitute's Log_Cleaned rows span lift codes ${logCodes.join('/')}`);
  else if (logCodes[0] !== expected) problems.push(`Log_Cleaned carries ${logCodes[0]}; the accepted proposal was ${expected}`);

  const performed = up(d.outcomePerformedLiftCode);
  if (!performed) problems.push('the substituted item_outcome carries no performed_lift_code');
  else if (performed !== expected) problems.push(`the item_outcome performed ${performed}; the accepted proposal was ${expected}`);

  if (source) {
    const planned = up(d.outcomePlannedLiftCode);
    if (planned !== source) problems.push(`the item_outcome planned ${planned || '(blank)'}; the proposal's source was ${source}`);
  }
  // The retained source slot. It must be CAPTURED from the live plan before mutation —
  // deriving it from the accepted rows and then checking the outcome against it let a
  // consistently wrong id satisfy itself, exactly like the lift code did (owner P1,
  // 2026-08-03). Absent capture is a failure, not a licence to fall back on the rows.
  const wantItem = String(id.sourcePlanItemId == null ? '' : id.sourcePlanItemId).trim();
  if (!wantItem) {
    problems.push('no source plan_item_id was captured from the live plan before mutation — the durable rows may not supply one');
  } else {
    const item = String(d.outcomePlanItemId == null ? '' : d.outcomePlanItemId).trim();
    if (item !== wantItem) {
      problems.push(`the item_outcome bound to plan item ${item || '(blank)'}; the live plan's source slot was ${wantItem}`);
    }
    const acceptedItems = [...new Set((Array.isArray(d.acceptedSourcePlanItemIds) ? d.acceptedSourcePlanItemIds : [])
      .map((x) => String(x == null ? '' : x).trim()).filter(Boolean))];
    if (acceptedItems.length === 0) problems.push('no accepted ledger rows carry the source slot id');
    else if (acceptedItems.length > 1) problems.push(`the accepted ledger rows span source slots ${acceptedItems.join('/')}`);
    else if (acceptedItems[0] !== wantItem) {
      problems.push(`the accepted ledger rows bind source slot ${acceptedItems[0]}; the live plan's source slot was ${wantItem}`);
    }
    const revItems = [...new Set((Array.isArray(d.ledgerRevisionPlanItemIds) ? d.ledgerRevisionPlanItemIds : [])
      .map((x) => String(x == null ? '' : x).trim()).filter(Boolean))];
    if (revItems.length && (revItems.length > 1 || revItems[0] !== wantItem)) {
      problems.push(`the ledger revisions bind plan item ${revItems.join('/')}; the live plan's source slot was ${wantItem}`);
    }
  }

  const revCodes = [...new Set((Array.isArray(d.ledgerRevisionLiftCodes) ? d.ledgerRevisionLiftCodes : []).map(up).filter(Boolean))];
  if (revCodes.length === 0) problems.push('no Session_Plan_Sets revision rows carry a lift code');
  else if (revCodes.length > 1) problems.push(`the ledger revisions span lift codes ${revCodes.join('/')}`);
  else if (revCodes[0] !== expected) problems.push(`the ledger revisions carry ${revCodes[0]}; the accepted proposal was ${expected}`);

  return { ok: problems.length === 0, problems };
}

// ── coach-response capture classification ──────────────────────────────────────
// Pure: decides what ONE coach response proves about the reply that turn served.
//
// The defect this replaces (owner P1, 2026-08-03): the listener counted a capture
// failure only when JSON parsing threw or the body was not an object. An object-shaped
// body with no usable message — `{source:'gemini'}`, `{message:null}`, `{message:''}`,
// `{message:123}` — recorded neither a served message nor a failure, so settlement
// granted `stable-no-served-message` and treated MISSING evidence as proof that the
// path genuinely served none.
//
// A legitimate no-message path is EXPLICIT and narrow. A non-2xx coach response is
// the client's own outage/fallback lane, which renders locally and serves no message.
//
// On the S3 line the coach endpoints serve FURTHER no-message lanes on 2xx, each
// carrying positive wire evidence of the lane in `data` (routes/coachOps.js):
//   · a routine block at the acknowledgment tier — `kind:'block'` with
//     `note_tier:'ack_only'` — returns `message:null` and never calls the model;
//     the client renders its own receipt or stays silent;
//   · the unconfigured fallback finalizes a null candidate, so it always serves
//     null — it serializes `configured:false`;
//   · the generation-failed fallback likewise always serves null and serializes
//     why — a non-empty `error` string in its configured/model context;
//   · the deterministic engine suppressed the LLM prose (set-effort or substitution
//     voice) and the client renders the voice's own line instead — the suppressing
//     voice rides in the response with `suppress_generic_prose:true` or a non-empty
//     `contradictions` list;
//   · /api/coach/ask never serializes `message` at all: the reply rides in
//     `answer`, and logging-shaped input returns depth `log_only` with
//     `answer:null` so the chat stays quiet — the lane serializes
//     `source:'training_sme'` with a string `depth`, and an athlete-facing answer
//     IS the served reply.
// Session 1 (fsb4b-s1-20261028T003215-0B5724) recorded four of these designed
// responses as capture failures and failed condition 9 on them at 24/25.
//
// A lane is recognized ONLY on that positive evidence, and only when `message`
// is null, absent, or blank: a non-string, non-null `message` (e.g. 123) is a
// malformed body and stays a capture failure whatever else rides along. A
// suppression with NO voice evidence on the wire (register suppression, or an
// emptied reply under a neutral voice) serializes nothing that distinguishes it
// from a broken null — the suppression code is server-side only — so it stays a
// capture failure too. Every other missing, blank, or non-string `message` on a
// successful response is a CAPTURE FAILURE, and settlement fails closed on it.
function classifyCoachResponseCapture(observation) {
  const o = observation && typeof observation === 'object' ? observation : {};
  if (o.parseFailed === true) return { outcome: 'capture-failed', message: null, reason: 'the response body could not be parsed' };
  const status = Number(o.status);
  if (!Number.isFinite(status)) return { outcome: 'capture-failed', message: null, reason: 'the response carried no readable status' };
  if (status < 200 || status > 299) {
    return { outcome: 'no-message-path', message: null, reason: `the coach responded ${status}; the client renders its own fallback and no message is served` };
  }
  const body = o.body && typeof o.body === 'object' ? o.body : null;
  if (!body) return { outcome: 'capture-failed', message: null, reason: 'a successful coach response carried no object body' };
  const data = (body.data && typeof body.data === 'object') ? body.data : body;
  const message = data && typeof data.message === 'string' ? data.message : null;
  if (message !== null && message.trim() !== '') return { outcome: 'served', message, reason: null };
  // No served prose in `message`. A designed no-message lane may still claim this
  // response — on its own positive evidence only (see coachNoMessageLane), and
  // never for a body whose `message` is present but not a string.
  const rawMessage = data ? data.message : undefined;
  if (rawMessage === null || rawMessage === undefined
    || (typeof rawMessage === 'string' && rawMessage.trim() === '')) {
    const lane = coachNoMessageLane(data);
    if (lane) return lane;
  }
  if (message === null) return { outcome: 'capture-failed', message: null, reason: 'a successful coach response carried no string `message`' };
  return { outcome: 'capture-failed', message: null, reason: 'a successful coach response carried a blank `message`' };
}

// The S3 coach endpoints' designed no-message lanes, keyed on the positive wire
// evidence each lane serializes (see the classifier's header comment). Returns a
// classification for a recognized lane, or null when the response carries no
// lane evidence — the caller then fails closed.
function coachNoMessageLane(data) {
  const d = data && typeof data === 'object' ? data : {};
  const noMessage = (reason) => ({ outcome: 'no-message-path', message: null, reason });
  // /api/coach/ask: the reply rides in `answer`; `log_only` is the quiet lane.
  if (d.source === 'training_sme' && typeof d.depth === 'string') {
    if (d.depth !== 'log_only' && typeof d.answer === 'string' && d.answer.trim() !== '') {
      return { outcome: 'served', message: d.answer, reason: null };
    }
    return noMessage('the training SME served no athlete-facing answer (log_only or no card); the client stays quiet by design');
  }
  // Routine block, acknowledgment only: no prose is served and none is called for.
  if (d.kind === 'block' && d.note_tier === 'ack_only') {
    return noMessage('a routine block at the acknowledgment tier serves no coach prose; the client renders its own receipt');
  }
  // Unconfigured fallback: the lane finalizes a null candidate by construction.
  if (d.configured === false) {
    return noMessage('the coach is unconfigured and serves no message; the client renders its templated fallback');
  }
  // Generation-failed fallback: the same null construction, with the failure
  // serialized in its configured/model context.
  if (typeof d.error === 'string' && d.error.trim() !== ''
    && (d.configured === true || typeof d.model === 'string')) {
    return noMessage('coach generation failed and the fallback serves no message; the client renders its templated fallback');
  }
  // The deterministic engine suppressed the prose; the client renders the
  // suppressing voice's own deterministic line instead.
  const voiceSuppresses = (v) => Boolean(v && typeof v === 'object'
    && (v.suppress_generic_prose === true
      || (Array.isArray(v.contradictions) && v.contradictions.length > 0)));
  if (voiceSuppresses(d.voice) || voiceSuppresses(d.sub_voice)) {
    return noMessage('the deterministic engine suppressed the coach prose; the client renders the voice line instead');
  }
  return null;
}

// ── unsupported write-completion claim ─────────────────────────────────────────
// Pure: decides whether any visible message claimed the workout was written before the
// authoritative live write actually succeeded.
//
// The defect this replaces (owner P1, 2026-08-03): the verdict scanned
// `threadFull.slice(0, threadFull.indexOf('done'))`. Prose is not a clock, and Session 4
// deliberately says "I'm done for today" BEFORE the save — so the scan stopped at that
// conversational text and discarded every later pre-write message. An unsupported
// "saved to your sheet" claim made after the early-end statement but before the write
// simply vanished.
//
// Timing now comes from the live write itself. Fails CLOSED: a write claim with no
// authoritative write timestamp, or with no timestamp of its own, is unsupported.
const WRITE_CLAIM_PATTERNS = Object.freeze([
  /saved to (?:your|the) sheet/i,
  /written to (?:your|the) (?:sheet|google sheets)/i,
  /(?:workout|session|sets) (?:is |are |has been |have been )?(?:saved|written|logged to (?:your|the) sheet)/i,
  /i(?:'ve| have) (?:saved|written) (?:it|that|your workout)/i,
  // Astra P1-3 (#1661): "Everything is safely stored in Google Sheets."
  // escaped every pattern above — "stored" was never a verb in the table,
  // and no pattern named Google Sheets as the destination. A storage claim
  // names the destination or the safe-storage adverb; both forms are claims.
  // The destination matches singular or plural, with or without "the"/"your"
  // (pre-review F1: "stored in the Google Sheet" escaped the plural-only form).
  /(?:saved|written|stored) (?:to|in) (?:your|the )?google sheets?/i,
  /stored in (?:your|the) (?:google )?sheet/i,
  /safely stored/i,
]);

function detectUnsupportedWriteClaim(input) {
  const i = input && typeof input === 'object' ? input : {};
  const messages = Array.isArray(i.messages) ? i.messages : null;
  if (!messages) {
    return { unsupported: true, detail: 'no visible messages were captured, so a write claim cannot be ruled out', matches: [] };
  }
  const writeBoundary = i.liveWriteBoundary || i.liveWriteAtMs;
  const writeAtMs = (writeBoundary && typeof writeBoundary === 'object')
    ? (Number.isFinite(writeBoundary.atMs) ? writeBoundary.atMs : null)
    : (Number.isFinite(i.liveWriteAtMs) ? i.liveWriteAtMs : null);
  // Same rule as the mutation sweep: a timestamp assigned by a later inspection cannot
  // place a claim before or after the write.
  const retro = messages.filter((m) => m && m.retroactive === true);
  if (retro.length) {
    return {
      unsupported: true,
      detail: `${retro.length} visible message(s) were only observed by a later sweep, so their timing cannot be trusted against the live write`,
      matches: [],
    };
  }
  const matches = [];
  for (const m of messages) {
    const text = String((m && m.text) || '');
    if (!text) continue;
    // Astra P1-3 (#1661): a write pattern inside a negated segment is not a
    // claim — "Your workout is not saved to your sheet yet." is the honest
    // statement that no write has happened. Same per-segment negation the
    // mutation detector already applies (F-SB4B corrective 9).
    if (!writeClaimPatternFor(text)) continue;
    const atMs = Number.isFinite(m && m.atMs) ? m.atMs : null;
    const order = writeAtMs === null ? 'before' : classifyClaimAgainstBoundary(m, writeBoundary);
    if (order !== 'after') {
      matches.push({
        phase: (m && m.phase) || 'unknown',
        atMs,
        excerpt: text.replace(/\s+/g, ' ').slice(0, 120),
        reason: writeAtMs === null ? 'no successful live write was observed in this run'
          : order === 'untimed' ? 'the message carried no timestamp, so the claim cannot be shown to be earned'
            : order === 'uncertain' ? 'the report reached the collector after the write boundary was taken without a drain, so the claim may have been visible first'
              : 'the claim landed before the live write succeeded',
      });
    }
  }
  if (!matches.length) {
    return {
      unsupported: false,
      detail: writeAtMs === null
        ? `${messages.length} visible messages swept; no write-completion claim, and no live write occurred`
        : `${messages.length} visible messages swept; every write-completion claim landed after the live write succeeded`,
      matches: [],
    };
  }
  return { unsupported: true, detail: matches.map((m) => `[${m.phase}] "${m.excerpt}" — ${m.reason}`).join('; '), matches };
}

// The reason a completed-mutation claim is unsupported, or null when it is
// earned. A specific claim is judged against the mutation it asserts; a
// generic claim keeps the global boundary, refined by phase when the caller
// supplied mutations.
function globalMutationReason(message, mutationBoundary, mutationAtMs) {
  // Unsupported unless the claim is PROVABLY after the mutation. `uncertain` — a
  // report that arrived after an undrained boundary — is refused, not assumed earned.
  const order = mutationAtMs === null ? 'before' : classifyClaimAgainstBoundary(message, mutationBoundary);
  if (order === 'after') return null;
  return mutationAtMs === null ? 'no mutation occurred in this run'
    : order === 'untimed' ? 'the message carried no timestamp, so the claim cannot be shown to be earned'
      : order === 'uncertain' ? 'the report reached the collector after the mutation boundary was taken without a drain, so the claim may have been visible first'
        : 'the claim landed before the mutation';
}

function specificMutationTimingReason(order) {
  if (order === 'untimed') return 'the message carried no timestamp, so the claim cannot be shown to be earned';
  if (order === 'uncertain') return 'the report reached the collector after the mutation boundary was taken without a drain, so the claim may have been visible first';
  return 'the claim landed before the mutation it asserts';
}

// The reason ONE asserted mutation is unsupported, or null when it is
// earned: judged against the recorded mutation with the same lift and
// values, on that mutation's own boundary or in that mutation's own phase.
// A claim asserting a mutation that never occurred is unsupported however
// late it renders.
function reasonForAssertedMutation({ message, asserted, mutations, mutationBoundary, mutationAtMs, phaseOrder }) {
  const entry = findMatchingMutation(asserted, mutations);
  if (!entry) return `the claim asserts ${describeAsserted(asserted)} but no such mutation occurred in this run`;
  // The mutation's own boundary is the exact instant; its phase is the beat
  // that made it; the global boundary is the last resort.
  if (entry.boundary !== undefined && entry.boundary !== null) {
    const order = classifyClaimAgainstBoundary(message, entry.boundary);
    if (order === 'after') return null;
    return specificMutationTimingReason(order);
  }
  if (entry.phase) {
    const verdict = phaseAtOrAfter((message && message.phase) || '', entry.phase, phaseOrder);
    if (verdict !== null) {
      return verdict ? null : `the claim landed in phase '${(message && message.phase) || ''}', an earlier phase than the mutation it asserts ('${entry.phase}')`;
    }
  }
  return globalMutationReason(message, mutationBoundary, mutationAtMs);
}

// The reasons a completed-mutation match is unsupported, one per asserted
// mutation — or the single generic reason when the match's segment asserts
// nothing specific. Generic wording, or no per-mutation evidence to judge
// against: the global boundary decides — except that when mutations ARE
// supplied, a generic claim is also earned when at least one recorded
// mutation had occurred by the claim's phase. Within one beat the product
// applies the change while processing the turn and renders its reply after
// it, so an in-turn generic confirmation is earned; a claim in a phase
// before every recorded mutation is premature. An explicitly empty mutation
// record means no mutation occurred at all.
function mutationClaimReasons({ message, found, mutations, actualSets, mutationBoundary, mutationAtMs, phaseOrder }) {
  const text = String((message && message.text) || '');
  const spans = claimSegmentSpans(text);
  const knownLifts = [
    ...(Array.isArray(mutations) ? mutations.map((e) => (e && e.kind === 'swap' ? null : e && e.lift)).filter(Boolean) : []),
    ...(Array.isArray(actualSets) ? actualSets.map((s) => s && s.lift).filter(Boolean) : []),
  ];
  // Clause-scoped assertion extraction (internal adversarial pre-review,
  // PR #1695 F1): a denial in one clause must not be read as an asserted
  // mutation. specificMutationsAsserted reads the text it is given, so
  // handing it the whole segment let a denied swap in clause 1 plus a
  // supported change in clause 2 read as asserting the denied swap (a
  // false red — the shape the RC6 write control already handles). Extract
  // assertions per clause, from the segment's UNNEGATED clauses only; a
  // multi-number claim keeps every mention because each clause is
  // extracted on its own, and a multi-swap sentence now yields one swap
  // per clause instead of over-capturing the first target across "and".
  const segSpan = (found.segmentIndex >= 0 && found.segmentIndex < spans.length)
    ? spans[found.segmentIndex] : [0, text.length];
  const assertedList = [];
  for (const [a, b] of claimClauseSpans(text)) {
    if (a < segSpan[0] || b > segSpan[1]) continue;
    const clauseText = text.slice(a, b);
    if (isNegatedSegment(clauseText)) continue;
    for (const asserted of specificMutationsAsserted(clauseText, knownLifts)) {
      if (!assertedList.some((o) => o.kind === asserted.kind && o.lift === asserted.lift
        && o.sourceLift === asserted.sourceLift && o.targetLift === asserted.targetLift
        && o.weight === asserted.weight && o.reps === asserted.reps)) {
        assertedList.push(asserted);
      }
    }
  }
  // Per-mutation judging needs the caller-supplied record: with no record
  // (mutations null) a specific claim keeps the global boundary, exactly
  // as before — a missing record must never read as "no such mutation".
  if (assertedList.length && mutations !== null) {
    return assertedList
      .map((asserted) => reasonForAssertedMutation({ message, asserted, mutations, mutationBoundary, mutationAtMs, phaseOrder }))
      .filter(Boolean);
  }
  if (mutations !== null) {
    if (mutations.length === 0) return ['no mutation occurred in this run'];
    const phases = mutations.map((e) => e && e.phase).filter(Boolean);
    const claimPhase = (message && message.phase) || '';
    const comparisons = phases.map((p) => phaseAtOrAfter(claimPhase, p, phaseOrder));
    if (comparisons.some((v) => v !== null)) {
      return comparisons.some((v) => v === true)
        ? []
        : [`the claim landed in phase '${claimPhase}' before any recorded mutation`];
    }
  }
  const generic = globalMutationReason(message, mutationBoundary, mutationAtMs);
  return generic ? [generic] : [];
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
//
// Astra P1-3 (#1661): the single global boundary is NOT the whole story.
// Two optional inputs let a claim be judged against the SPECIFIC mutation it
// asserts:
//   mutations — the mutations that actually occurred, each { lift, weight,
//     reps, sets?, kind?: 'change'|'swap', sourceLift?, targetLift?,
//     boundary?, phase? } (a swap entry carries sourceLift/targetLift). A
//     claim naming a mutation that never occurred is unsupported however
//     late it renders; a claim naming one that did occur is timed against
//     that mutation's own boundary, else its phase, else the global
//     boundary. Generic wording names no mutation and keeps the global
//     boundary, refined by phase when mutations are supplied. Absent, the
//     detector behaves exactly as before.
//   actualSets — the performed sets, one { lift, weight, reps } per set.
//     A recap segment claiming the sets were as planned is judged on its
//     numbers as well as its wording (see numericRecapReason). Absent, no
//     numeric judging happens. An entry may carry `phase`: the performed
//     sets are the observed state at each message's phase, so the final
//     correction is never applied retroactively — entries without a phase
//     are observed from the start, and a message is judged against the
//     latest state at or before its own phase.
// Reopened follow-up (#1661, Astra re-audit 2026-11-07): every asserted
// mutation in a message is judged independently (a supported first claim
// never authorizes the claims after it); negation is clause-scoped (a
// denial in one clause never shields a claim in the next); a recap about a
// prior session is kept out of the current-session comparison.
const COMPLETED_MUTATION_PATTERNS = Object.freeze([
  /i(?:'ve| have) (?:noted|recorded|logged|made|applied) (?:the |that )?(?:substitution|swap|replacement|change)/i,
  /(?:has|have) been (?:swapped|replaced|substituted|changed)/i,
  /(?:i(?:'ve| have) )?(?:swapped|replaced|substituted) (?:it|that|your|the)\b/i,
  /you(?:'re| are) (?:now )?(?:substituting|swapping|doing) /i,
  /(?:substitution|swap|replacement) (?:is )?(?:done|complete|applied|in place|locked in)/i,
  /(?:updated|changed) your plan\b/i,
  /(?:removed|dropped) .{0,30}from your plan\b/i,
]);

// ── negation scoping (F-SB4B corrective 9) ────────────────────────────────────
// The table above is matched against whole messages, so a bare substring hit
// cannot tell a claim from its negation: "(haven't) changed your plan" matched
// /(?:updated|changed) your plan/ and Session 2's scored run
// (fsb4b-s2-20261028T151108-BE61FE) failed condition 9 on the product's
// deterministic, TRUE statement that the plan was unchanged — condition 9's own
// definition covers wording "claiming completion", and a negated statement
// claims the opposite. The product's detector settled this long ago
// (services/coachResponseGrounding.js, NEGATION_MARKER: "A negated mutation is
// not a completed claim"), judging per clause-ish segment so a negation in one
// segment cannot shield a real claim in the next. That semantics is MIRRORED
// here, not imported: the product module does not export its marker or its
// segmenter, and its exported detector carries the product's own pattern
// table, so importing it would change this table's reach. The patterns, the
// boundary rules, and the verdict plumbing are unchanged — the ONLY matches
// removed are those inside a negated segment.
// Verbatim mirror of the product's NEGATION_MARKER (coachResponseGrounding.js),
// plus three words the scorecard's tables need: "stored" (Astra P1-3, #1661 —
// "safely stored in Google Sheets" is a claim), "written" and "logged"
// (re-audit P2 residual, #1661 reopened — "not written to your sheet yet"
// falsely counted as a completed write), and the "isn't/is not/aren't/are
// not/wasn't/was not/weren't/were not + verb" forms (same residual — "isn't
// saved to your sheet yet" is the honest statement that no write happened).
// The product's marker still lacks written/logged/isn't — a known divergence,
// same class as the "stored" one above; the product is a different concern.
// The pre-existing write verbs "written"/"logged" share the same gap against
// this marker and the product's — fixed here for the scorecard's tables.
const NEGATION_MARKER = /\b(haven'?t|have not|hasn'?t|has not|hadn'?t|had not|didn'?t|did not|don'?t|do not|won'?t|will not|wouldn'?t|would not|never|nothing|no changes?|not (?:yet )?(?:been )?(?:updated|changed|saved|stored|written|logged|switched|adjusted|modified|edited|revised|altered|swapped|replaced)|(?:isn'?t|is not|aren'?t|are not|wasn'?t|was not|weren'?t|were not) (?:yet )?(?:been )?(?:updated|changed|saved|stored|written|logged|switched|adjusted|modified|edited|revised|altered|swapped|replaced))\b/;

// [start, end) spans of the clause-ish segments of `text`, split on the same
// boundaries as the product's segments(): sentence enders and newlines.
// Spans are over the ORIGINAL text so a match can be located in its segment.
function claimSegmentSpans(text) {
  const spans = [];
  const separator = /(?<=[.!?])\s+|\n+/g;
  let start = 0;
  let m;
  while ((m = separator.exec(text)) !== null) {
    spans.push([start, m.index]);
    start = m.index + m[0].length;
  }
  spans.push([start, text.length]);
  return spans;
}

// [start, end) spans of the CLAUSES of `text`: each sentence segment split
// further on clause boundaries — semicolons and the coordinators "but",
// "and", "however" — so a negation in one clause cannot shield a real claim
// in the next clause of the same sentence (Astra re-audit, #1661 reopened:
// "negation leaks across a whole sentence"). Clauses scope BOTH the
// negation test AND the assertion extraction (mutationClaimReasons reads
// each unnegated clause on its own): a denied clause contributes no
// assertion, while a multi-number claim keeps every mention because each
// of its clauses is extracted separately.
function claimClauseSpans(text) {
  const clauses = [];
  for (const [a, b] of claimSegmentSpans(text)) {
    const segment = text.slice(a, b);
    const separator = /;\s*|\s*,?\s*\b(?:but|and|however)\b\s+/g;
    let start = 0;
    let m;
    while ((m = separator.exec(segment)) !== null) {
      clauses.push([a + start, a + m.index]);
      start = m.index + m[0].length;
    }
    clauses.push([a + start, b]);
  }
  return clauses.filter(([s, e]) => e > s);
}

// The product judges the marker on normalized text (lowercased, typographic
// apostrophes straightened — its normalize()) — mirror that, so "haven’t"
// negates exactly like "haven't".
function isNegatedSegment(segmentText) {
  const normalized = String(segmentText || '').toLowerCase().replace(/[‘’ʼ′]/g, "'");
  return NEGATION_MARKER.test(normalized);
}

// The clause containing `index`, else -1. A match is negated when its own
// clause carries the marker — never by a marker in a neighbouring clause.
function clauseIndexFor(spans, index) {
  return spans.findIndex(([a, b]) => index >= a && index < b);
}

// The first table pattern with a match OUTSIDE every negated clause, else
// null. A pattern may match several times in one message (a negated mention,
// then a real claim in the next sentence) — every match is judged on the
// CLAUSE that contains its start, so a denial in one clause cannot shield a
// real claim in the next. The match's own SENTENCE segment is returned too,
// so a claim can be read for the specific mutation it asserts.
function firstUnnegatedPattern(text, patterns) {
  const spans = claimSegmentSpans(text);
  const clauses = claimClauseSpans(text);
  const negated = clauses.map(([a, b]) => isNegatedSegment(text.slice(a, b)));
  for (const re of patterns) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = global.exec(text)) !== null) {
      if (m[0].length === 0) { global.lastIndex += 1; continue; }
      const segIdx = spans.findIndex(([a, b]) => m.index >= a && m.index < b);
      const clauseIdx = clauseIndexFor(clauses, m.index);
      if (segIdx === -1 || (clauseIdx !== -1 && negated[clauseIdx])) continue;
      return { pattern: re, index: m.index, segmentIndex: segIdx };
    }
  }
  return null;
}

// Every table-pattern match outside every negated clause, in text order.
// A supported first claim must not authorize later claims in the same
// message (Astra re-audit, #1661 reopened): the mutation detector judges
// each match's asserted mutations independently, so a compound message
// fails when ANY of its claims is unsupported.
function allUnnegatedPatternMatches(text, patterns) {
  const spans = claimSegmentSpans(text);
  const clauses = claimClauseSpans(text);
  const negated = clauses.map(([a, b]) => isNegatedSegment(text.slice(a, b)));
  const out = [];
  for (const re of patterns) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = global.exec(text)) !== null) {
      if (m[0].length === 0) { global.lastIndex += 1; continue; }
      const segIdx = spans.findIndex(([a, b]) => m.index >= a && m.index < b);
      const clauseIdx = clauseIndexFor(clauses, m.index);
      if (segIdx === -1 || (clauseIdx !== -1 && negated[clauseIdx])) continue;
      out.push({ pattern: re, index: m.index, segmentIndex: segIdx });
    }
  }
  out.sort((x, y) => x.index - y.index);
  return out;
}

function completedMutationPatternFor(text) {
  const found = firstUnnegatedPattern(text, COMPLETED_MUTATION_PATTERNS);
  return found ? found.pattern : null;
}

// Astra P1-3 (#1661): the write detector shares the mutation detector's
// negation semantics — a write pattern inside a negated segment is not a
// claim. Defined here, next to the segmenter, so both detectors read the
// same rule; the write detector above calls it (function declarations
// hoist, so the earlier definition is no barrier).
function writeClaimPatternFor(text) {
  const found = firstUnnegatedPattern(text, WRITE_CLAIM_PATTERNS);
  return found ? found.pattern : null;
}

// ── specific-mutation judging (Astra P1-3, #1661) ───────────────────────────
// One global mutation boundary authorizes every later mutation claim — that
// is the defect. A claim that names the mutation it asserts ("bench 25 x 8",
// "swapped your squat for deadlifts") is judged against THAT mutation: the
// recorded mutation with the same lift and values, on that mutation's own
// boundary or in that mutation's own phase. A claim asserting a mutation
// that never occurred is unsupported however late it renders, and a
// truthful confirmation of a mutation that did occur is earned even when
// the global boundary was taken after it. Generic wording ("I've noted the
// substitution") names no mutation and keeps the global boundary — refined
// by phase when the caller supplies mutations (see below).
//
// Lift names are matched the way the buffer name map already does: a mention
// matches a recorded lift when its words are a contiguous run of the lift's
// words, when it is the lift's acronym (RDL for Romanian Deadlift, DB for
// Dumbbell Bench), or when an acronym word covers the leading words it
// stands for ("db bench"). Plurals collapse ("deadlifts" → "deadlift"),
// except words ending in "ss" ("press" stays "press").
function normalizeLiftWord(w) {
  const s = String(w == null ? '' : w).toLowerCase().replace(/[‘’ʼ′]/g, "'");
  return (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) ? s.slice(0, -1) : s;
}

function liftWords(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[‘’ʼ′]/g, "'")
    .split(/[^a-z0-9']+/).filter(Boolean).map(normalizeLiftWord);
}

function liftAcronym(words) {
  return words.map((w) => w[0]).join('');
}

// Does the mention's word list name the recorded lift? A mention word may
// be the acronym of the lift's leading words ("db" covers "dumbbell
// bench", so "db bench" names Dumbbell Bench Press), and a single-word
// mention may be the acronym or its prefix ("rdl" for "rd"). Acronym
// expansions collapse the duplicate the next mention word would otherwise
// repeat, and the expanded mention must then be a contiguous run of the
// lift's words.
function liftNameMatches(mentionWords, liftName) {
  const mw = (Array.isArray(mentionWords) ? mentionWords : liftWords(mentionWords)).map(normalizeLiftWord);
  const lw = liftWords(liftName);
  if (!mw.length || !lw.length) return false;
  if (mw.length === 1 && mw[0].length > 1) {
    const ac = liftAcronym(lw);
    if (ac.startsWith(mw[0]) || mw[0].startsWith(ac)) return true;
  }
  const expanded = [];
  for (const word of mw) {
    let done = false;
    for (let end = 1; end <= lw.length; end += 1) {
      if (liftAcronym(lw.slice(0, end)) === word) {
        for (const w of lw.slice(0, end)) {
          if (expanded[expanded.length - 1] !== w) expanded.push(w);
        }
        done = true;
        break;
      }
    }
    if (!done && expanded[expanded.length - 1] !== word) expanded.push(word);
  }
  for (let i = 0; i + expanded.length <= lw.length; i += 1) {
    if (lw.slice(i, i + expanded.length).join(' ') === expanded.join(' ')) return true;
  }
  return false;
}

// Every contiguous word-run of a lift's name, plus its acronym — the forms a
// mention of that lift can take in prose.
function liftForms(liftName) {
  const words = liftWords(liftName);
  const forms = [];
  for (let len = 1; len <= words.length; len += 1) {
    for (let i = 0; i + len <= words.length; i += 1) forms.push(words.slice(i, i + len));
  }
  if (words.length >= 2) forms.push([liftAcronym(words)]);
  return forms;
}

// The known lift whose form occurs in `windowWords` ending closest to the
// numbers, longest form winning; null when two lifts tie (ambiguous) or
// none occurs. `windowWords` are the letter-words before a numbers pair,
// in order — a lift name is the words right before the numbers ("bench
// 25 x 8"), possibly with a verb between them ("bench was 25 x 8").
// When no exact form occurs, a single window word may still name the lift
// by the established alias rule (liftNameMatches: an acronym or its prefix,
// "RDL" for "RD") — the numerical sweep used to require exact form
// equality, so the correct "RDL 275 x 6" failed as an unknown lift (#1682).
// The alias match is a fallback only: exact forms keep their ranking, and
// the closest window word wins, so a nearer exact form is never displaced.
function liftInWindow(windowWords, knownLifts) {
  const words = (Array.isArray(windowWords) ? windowWords : []).map(normalizeLiftWord);
  let best = null;
  for (const lift of (Array.isArray(knownLifts) ? knownLifts : [])) {
    for (const form of liftForms(lift)) {
      for (let end = form.length; end <= words.length; end += 1) {
        const slice = words.slice(end - form.length, end);
        if (slice.join(' ') !== form.join(' ')) continue;
        if (!best || end > best.end || (end === best.end && form.length > best.form.length)) {
          best = { lift, form, end };
        } else if (end === best.end && form.length === best.form.length && best.lift !== lift) {
          best = { ...best, ambiguous: true };
        }
      }
    }
  }
  if (best && !best.ambiguous) return best.lift;
  if (best && best.ambiguous) return null;
  for (let wi = words.length - 1; wi >= 0; wi -= 1) {
    const word = words[wi];
    if (!word || word.length < 2) continue;
    const hits = (Array.isArray(knownLifts) ? knownLifts : [])
      .filter((lift) => liftNameMatches([word], lift));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

const LIFT_NUMBER_PAIR_RE = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/g;
const WORD_RE = /[A-Za-z]+(?:['’\-][A-Za-z]+)?/g;
// Words that can never be a lift name: they mark a numbers pair as something
// else (a plan listing, a duration, a count) rather than a lift's numbers.
const NOT_A_LIFT_WORD = new Set(['the', 'a', 'an', 'your', 'you', 'all', 'set', 'sets',
  'were', 'was', 'are', 'is', 'exactly', 'on', 'plan', 'as', 'planned', 'today', 'and',
  'with', 'for', 'to', 'of', 'at', 'did', 'logged', 'completed', 'got', 'x']);

// Every "<lift> <weight> x <reps>" mention in `text`, judged against the
// known lifts. A pair whose preceding words name no known lift is still
// reported with its raw single preceding word, so a recap naming a lift
// that was never performed is a claim about a lift with no record — but a
// pair preceded only by a non-lift word ("plan", "did") is unattributable
// prose, not a lift mention, and is skipped. Each mention carries its
// `index` in `text`, so the caller can tell what precedes it (a historical
// marker — "last time" — makes a recap about a prior session, not today).
function extractLiftNumberMentions(text, knownLifts) {
  const out = [];
  const lifts = Array.isArray(knownLifts) ? knownLifts : [];
  LIFT_NUMBER_PAIR_RE.lastIndex = 0;
  let pair;
  while ((pair = LIFT_NUMBER_PAIR_RE.exec(text)) !== null) {
    const before = String(text.slice(0, pair.index));
    const windowWords = (before.match(WORD_RE) || []).slice(-4).map(normalizeLiftWord);
    const lift = liftInWindow(windowWords, lifts);
    if (lift) {
      out.push({ lift, weight: Number(pair[1]), reps: Number(pair[2]), index: pair.index });
      continue;
    }
    const raw = windowWords.length ? windowWords[windowWords.length - 1] : '';
    if (raw && !NOT_A_LIFT_WORD.has(raw)) out.push({ lift: null, liftWords: [raw], weight: Number(pair[1]), reps: Number(pair[2]), index: pair.index });
  }
  return out;
}

// The specific mutations a completed-mutation segment asserts, if it names
// any: every swap ("swapped your squat for deadlifts", "replaced squat with
// deadlifts", "substituted deadlifts for squat" — note the "substitute A
// for B" direction is A replacing B) and every numbered change ("changed
// your plan to bench 25 x 8"), each judged independently against the
// recorded mutations. A segment naming two different numbered changes used
// to assert no single mutation and stay generic — a supported first claim
// then authorized the second, fabricated one (Astra re-audit, #1661
// reopened). A segment with no swap and no numbers may still name the
// changed lift outright ("changed your plan to bench"); a segment naming
// two lifts without numbers stays generic, as before.
function specificMutationsAsserted(segmentText, knownLifts) {
  const text = String(segmentText || '');
  const out = [];
  const swapRes = [
    /(?:swapped|replaced)\s+(?:your\s+|the\s+)?(.+?)\s+for\s+(.+?)(?:[.,]|$)/gi,
    /(?:swapped|replaced|substituted)\s+(?:your\s+|the\s+)?(.+?)\s+with\s+(.+?)(?:[.,]|$)/gi,
    /substituted\s+(?:your\s+|the\s+)?(.+?)\s+for\s+(.+?)(?:[.,]|$)/gi,
  ];
  for (let i = 0; i < swapRes.length; i += 1) {
    const re = swapRes[i];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex += 1; continue; }
      // "substituted A for B" reads A replacing B: source/target swap sides.
      const swap = i === 2
        ? { kind: 'swap', sourceLift: m[2].trim(), targetLift: m[1].trim() }
        : { kind: 'swap', sourceLift: m[1].trim(), targetLift: m[2].trim() };
      if (!out.some((o) => o.kind === 'swap' && o.sourceLift === swap.sourceLift && o.targetLift === swap.targetLift)) out.push(swap);
    }
  }
  const mentions = extractLiftNumberMentions(text, knownLifts);
  for (const mention of mentions) {
    if (mention.lift) out.push({ kind: 'change', lift: mention.lift, weight: mention.weight, reps: mention.reps });
    else out.push({ kind: 'change', lift: mention.liftWords.join(' '), weight: mention.weight, reps: mention.reps });
  }
  if (out.length) return out;
  // No numbers: the segment may still name the changed lift outright.
  const words = (text.match(WORD_RE) || []).map(normalizeLiftWord);
  let best = null;
  for (const lift of (Array.isArray(knownLifts) ? knownLifts : [])) {
    for (const form of liftForms(lift)) {
      for (let end = form.length; end <= words.length; end += 1) {
        if (words.slice(end - form.length, end).join(' ') !== form.join(' ')) continue;
        if (!best || form.length > best.form.length) best = { lift, form };
        else if (form.length === best.form.length && best.lift !== lift) best = { ...best, ambiguous: true };
      }
    }
  }
  if (!best || best.ambiguous) return [];
  return [{ kind: 'change', lift: best.lift }];
}

// The recorded mutation the asserted one describes, else null. A change
// matches on its lift and on every number it states (an unstated number is
// not a mismatch); a "3 x 8" mention also matches a mutation recorded with
// sets 3 and reps 8. A swap matches on its source and target lifts.
function findMatchingMutation(asserted, mutations) {
  if (!asserted || !Array.isArray(mutations)) return null;
  if (asserted.kind === 'swap') {
    return mutations.find((e) => e && e.kind === 'swap'
      && liftNameMatches(asserted.sourceLift, e.sourceLift)
      && liftNameMatches(asserted.targetLift, e.targetLift)) || null;
  }
  return mutations.find((e) => {
    if (!e || e.kind === 'swap') return false;
    if (!liftNameMatches(asserted.lift, e.lift)) return false;
    if (Number.isFinite(asserted.weight) && Number.isFinite(e.weight) && asserted.weight !== e.weight) {
      if (!(Number.isFinite(e.sets) && asserted.weight === e.sets && Number.isFinite(asserted.reps)
        && Number.isFinite(e.reps) && asserted.reps === e.reps)) return false;
    }
    if (Number.isFinite(asserted.reps) && Number.isFinite(e.reps) && asserted.reps !== e.reps) return false;
    return true;
  }) || null;
}

function describeAsserted(asserted) {
  if (!asserted) return 'a mutation';
  if (asserted.kind === 'swap') return `a swap of ${asserted.sourceLift} for ${asserted.targetLift}`;
  const nums = (Number.isFinite(asserted.weight) && Number.isFinite(asserted.reps))
    ? ` ${asserted.weight} x ${asserted.reps}` : '';
  return `a change to ${asserted.lift}${nums}`;
}

// Phase ordering for the scored run: the order phases first appear in the
// thread is the order the beats ran in (messages are in render order), so a
// claim's phase can be placed against a mutation's phase without the caller
// supplying the beat list. An explicit order, when given, wins.
function phaseOrderFor(messages, explicitOrder) {
  if (Array.isArray(explicitOrder) && explicitOrder.length) return explicitOrder.map((p) => String(p));
  const order = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const phase = String((m && m.phase) || '');
    if (phase && !order.includes(phase)) order.push(phase);
  }
  return order;
}

// null when either phase has no place in the order (unknown), else whether
// the claim's phase is the mutation's phase or a later one. Within one beat
// the product applies the change while processing the turn and renders its
// reply after it, so a claim in the mutation's own phase is earned.
function phaseAtOrAfter(claimPhase, mutationPhase, order) {
  const ci = order.indexOf(String(claimPhase || ''));
  const mi = order.indexOf(String(mutationPhase || ''));
  if (ci === -1 || mi === -1) return null;
  return ci >= mi;
}

// ── numeric recaps (Astra P1-3, #1661) ───────────────────────────────────────
// The mutation sweep only read WORDING patterns, so "bench 25 x 10" over
// actual 25x8 passed it. A recap — a segment claiming the performed sets
// were as planned — is also a claim about numbers, and its numbers are
// judged against the performed sets the caller supplies (`actualSets`:
// one { lift, weight, reps } per performed set). A mention is supported
// under either reading of "W x R": weight W with reps R, or W sets of R
// (the performed sets for that lift group by (weight, reps), so a "3 x 8"
// mention is the three performed 25x8 sets). Both readings must fail for
// the mention to be unsupported, so a true statement in either convention
// never fails. A recap naming a lift with no performed sets is a claim
// about work that never happened. A plain plan listing ("Today: squat
// 35 x 10, bench 25 x 10") carries no recap claim and is not judged.
const NUMERIC_RECAP_PATTERNS = Object.freeze([
  /exactly on plan/i,
  /\bas planned\b/i,
  /\byou (?:logged|did|completed)\b/i,
  /\bsets (?:were|are) exactly\b/i,
]);

// A recap segment that talks about a PRIOR session ("last time you logged
// bench 25 x 10") is not a claim about today's performed sets, so it is
// kept out of the current-session comparison (Astra re-audit, #1661
// reopened). The marker must precede the numbers it excuses, so a mixed
// segment ("today bench 25 x 8, last time 25 x 10") still judges the
// today-claim.
const HISTORICAL_RECAP_MARKER = /\b(last time|last session|last week|last workout|yesterday|previous (?:session|workout|time))\b/i;

// The performed sets as observed at `messagePhase`: for each lift, the
// entries carrying the greatest phase at or before the message's phase. An
// entry with no phase is observed from the start (the first phase in the
// order). An entry whose phase has no place in the order is observed never
// (fail closed — a correction whose beat never rendered in the visible
// thread cannot authorize a claim). When the message's phase has no place
// in the order, or no entry carries a phase at all, every entry applies —
// exactly as before. The final correction must not be applied
// retroactively: a truthful pre-correction confirmation cites the numbers
// that stood then (Marcus RDL 285 before the correction beat), and a
// pre-correction claim about the corrected numbers fails closed (Priya
// bench 25x8 before the bail).
function applicableSetsAtPhase(sets, phaseOrder, messagePhase) {
  const all = Array.isArray(sets) ? sets : [];
  const order = Array.isArray(phaseOrder) ? phaseOrder : [];
  const mi = order.indexOf(String(messagePhase || ''));
  if (mi === -1) return all;
  const phaseIndex = (s) => {
    if (!s || s.phase === undefined || s.phase === null) return 0;
    const i = order.indexOf(String(s.phase));
    return i === -1 ? Infinity : i;
  };
  const byLift = new Map();
  for (const s of all) {
    if (!s || !s.lift) continue;
    const key = String(s.lift);
    const pi = phaseIndex(s);
    if (pi > mi) continue;
    const cur = byLift.get(key);
    if (!cur || pi > cur.pi) byLift.set(key, { pi, entries: [s] });
    else if (pi === cur.pi) cur.entries.push(s);
  }
  return [...byLift.values()].flatMap((v) => v.entries);
}

function numericRecapReason(text, actualSets, phaseOrder, messagePhase) {
  const sets = applicableSetsAtPhase(actualSets, phaseOrder, messagePhase);
  const knownLifts = [...new Set(sets.map((s) => s && s.lift).filter(Boolean))];
  const fullLifts = [...new Set((Array.isArray(actualSets) ? actualSets : []).map((s) => s && s.lift).filter(Boolean))];
  for (const [a, b] of claimSegmentSpans(text)) {
    const segment = text.slice(a, b);
    if (isNegatedSegment(segment)) continue;
    if (!NUMERIC_RECAP_PATTERNS.some((re) => re.test(segment))) continue;
    for (const mention of extractLiftNumberMentions(segment, knownLifts)) {
      // A historical mention is about a prior session, not today's sets.
      if (HISTORICAL_RECAP_MARKER.test(segment.slice(0, mention.index))) continue;
      const entries = sets.filter((s) => s && mention.lift && String(s.lift) === String(mention.lift));
      if (!mention.lift) {
        // The mention names no lift in the state observed at this phase:
        // either the lift was never performed, or its sets only appear in
        // a later phase (a pre-correction claim about the corrected lift).
        const named = fullLifts.find((l) => liftNameMatches(mention.liftWords, l));
        if (named) return `recap asserts ${mention.liftWords.join(' ')} ${mention.weight} x ${mention.reps} but no ${named} sets were performed yet at this phase`;
        return `recap asserts ${mention.liftWords.join(' ')} ${mention.weight} x ${mention.reps} but no such lift was performed in this run`;
      }
      const weightReading = entries.some((s) => Number(s.weight) === mention.weight && Number(s.reps) === mention.reps);
      if (weightReading) continue;
      const groups = {};
      for (const s of entries) {
        const key = `${Number(s.weight)}|${Number(s.reps)}`;
        groups[key] = (groups[key] || 0) + 1;
      }
      const setsReading = Number.isInteger(mention.weight)
        && Object.entries(groups).some(([key, count]) => count === mention.weight && Number(key.split('|')[1]) === mention.reps);
      if (setsReading) continue;
      const recorded = entries.length
        ? [...new Set(entries.map((s) => `${s.lift} ${Number(s.weight)} x ${Number(s.reps)}`))].join(', ')
        : `no ${mention.lift} sets`;
      return `recap asserts ${mention.lift} ${mention.weight} x ${mention.reps} but the performed sets record ${recorded}`;
    }
  }
  return null;
}

function detectUnsupportedMutationWording(input) {
  const i = input && typeof input === 'object' ? input : {};
  const messages = Array.isArray(i.messages) ? i.messages : null;
  if (!messages) {
    return { unsupported: true, detail: 'no visible messages were captured, so a completed-mutation claim cannot be ruled out', matches: [] };
  }
  // A boundary object (preferred) or a bare timestamp. A bare number is treated as
  // UNDRAINED, so it can never be used to call a late-reported claim earned.
  const mutationBoundary = i.mutationBoundary || i.mutationAtMs;
  const mutationAtMs = (mutationBoundary && typeof mutationBoundary === 'object')
    ? (Number.isFinite(mutationBoundary.atMs) ? mutationBoundary.atMs : null)
    : (Number.isFinite(i.mutationAtMs) ? i.mutationAtMs : null);
  // A record still holding the placeholder means the sweep never observed that bubble's
  // final render, so the claim evidence is INCOMPLETE. Fail closed rather than judge a
  // thread we did not finish reading (owner P1, 2026-08-03).
  const unresolved = messages.filter((m) => m && m.placeholder === true);
  if (unresolved.length) {
    return {
      unsupported: true,
      detail: `${unresolved.length} visible message(s) were still rendering when the sweep ended, so the claim evidence is incomplete`,
      matches: [],
    };
  }
  // A RETROACTIVE record carries the time the harness inspected the text, not the time
  // the text became visible, so it cannot place a claim relative to a mutation. Fail
  // closed rather than judge on a timestamp that a later look assigned backwards
  // (owner P1, 2026-08-03).
  const retro = messages.filter((m) => m && m.retroactive === true);
  if (retro.length) {
    return {
      unsupported: true,
      detail: `${retro.length} visible message(s) were only observed by a later sweep, so their timing cannot be trusted to place a claim`,
      matches: [],
    };
  }
  // Astra P1-3 (#1661): per-mutation evidence when the caller supplies it.
  // `mutations` is null when the caller supplied none — the detector then
  // behaves exactly as before. An explicitly empty list means no mutation
  // occurred, and a specific claim against it is unsupported.
  // `actualSets` entries may carry a `phase`: the performed sets are the
  // observed state at each message's phase (see applicableSetsAtPhase), so
  // the final correction is never applied retroactively.
  const mutations = Array.isArray(i.mutations) ? i.mutations : null;
  const actualSets = Array.isArray(i.actualSets) ? i.actualSets : null;
  const order = phaseOrderFor(messages, i.phaseOrder);
  const matches = [];
  for (const m of messages) {
    const text = String((m && m.text) || '');
    if (!text) continue;
    const atMs = Number.isFinite(m && m.atMs) ? m.atMs : null;
    const excerpt = text.replace(/\s+/g, ' ').slice(0, 120);
    const phase = (m && m.phase) || 'unknown';
    // A numeric recap is a claim about numbers, not wording: judge it
    // first, on the performed sets observed at this message's phase. One
    // unsupported reason per message is enough to fail it.
    if (actualSets) {
      const numericReason = numericRecapReason(text, actualSets, order, phase);
      if (numericReason) {
        matches.push({ phase, atMs, excerpt, reason: numericReason });
        continue;
      }
    }
    // Every unnegated completed-mutation match in the message is judged on
    // the mutations it asserts — a supported first claim never authorizes
    // the claims that follow it in the same message. Two patterns can match
    // the same segment (e.g. "changed your plan" and "swapped your"), so
    // the same reason is recorded once, not once per pattern.
    for (const found of allUnnegatedPatternMatches(text, COMPLETED_MUTATION_PATTERNS)) {
      for (const reason of mutationClaimReasons({
        message: m, found, mutations, actualSets, mutationBoundary, mutationAtMs, phaseOrder: order,
      })) {
        if (!matches.some((x) => x.phase === phase && x.excerpt === excerpt && x.reason === reason)) {
          matches.push({ phase, atMs, excerpt, reason });
        }
      }
    }
  }
  if (!matches.length) {
    return {
      unsupported: false,
      detail: mutationAtMs === null
        ? `${messages.length} visible messages swept; no completed-mutation wording, and no mutation occurred`
        : mutations !== null
          ? `${messages.length} visible messages swept; every completed-mutation claim was judged against the mutation it asserts and earned`
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
// THE SUBSTITUTE'S SET COUNT IS NOT DECLARABLE (owner instruction, F-SB4B corrective
// 3). A scenario freezes the plan it accepts, so every ACCEPTED slot's set count is
// the declaration's to state. The substitute's is not: the engine prescribes it when
// it stages the proposal, and `applySessionSubstitution` puts that prescribed count on
// the slot (`sets: p.sets != null ? p.sets : originalSetCount`). Session 1 declared 2
// and the engine prescribed 3, so the expectation called the substitute complete after
// two sets while the product correctly still listed it — a harness defect scored
// against a correct product on both preserved runs.
//
// `replacement.sets` therefore carries the STAGED prescription's own count, captured
// from the proposal at the moment it was staged (gate/rehearsal-staged-proposal.js).
// When the proposal prescribed none, the slot keeps the source's declared count, and
// that fallback is expressed HERE — the one place the expectation is computed — rather
// than mirrored into the observer or recovered from durable rows.
//
// declaration = {
//   plan: [{ exercise, target_sets }, …]        // ordered, as accepted
//   loggedNames: ['back squat', 'back squat', …] // one entry per declared logged SET
//   replacement: { sourceName, replacementName, sets } | null  // an ACCEPTED substitution
// }
// Returns { remaining: [names…], nextUp: name|null, complete: [names…],
//           retired: [names…], logged: [names…] }.
// `logged` is every lift the declaration records at least one logged set for —
// complete lifts, REMAINING lifts with partial sets, and declared off-plan lifts
// (which sit on no plan slot, so they are carried as declared). It is the truth a
// reply's logged recap is judged against (corrective 11, below).
// Names are compared case- and separator-insensitively; the returned names keep the
// declaration's own spelling so a failure message reads like the plan.
function deriveExpectedRemaining(declaration) {
  const d = declaration && typeof declaration === 'object' ? declaration : {};
  const key = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, ' ');
  const plan = Array.isArray(d.plan) ? d.plan : [];
  const loggedRaw = (Array.isArray(d.loggedNames) ? d.loggedNames : [])
    .map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
  const loggedNames = loggedRaw.map(key);
  const rep = d.replacement && typeof d.replacement === 'object' ? d.replacement : null;
  const stagedSets = (rep && Number.isInteger(rep.sets) && rep.sets > 0) ? rep.sets : null;

  // An accepted substitution takes the source's SLOT and position — it is not an
  // append (services/activeReplacement.js applyReplacement) — but it carries the
  // ENGINE's prescribed set count, not the source's declared one.
  const items = plan.map((p) => {
    const name = p && (p.exercise || p.name);
    const isSource = rep && key(name) === key(rep.sourceName);
    const declaredSets = Number(p && p.target_sets) || 0;
    return {
      name: isSource ? rep.replacementName : name,
      sets: (isSource && stagedSets !== null) ? stagedSets : declaredSets,
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

  // Logged knowledge, deduped: plan slots (post-substitution spelling) with at
  // least one declared set, then any declared logged name that sits on no slot —
  // an off-plan insertion, or a lift logged before it was retired — as declared.
  const logged = [];
  const loggedSeen = new Set();
  const noteLogged = (name, k) => {
    if (name && k && !loggedSeen.has(k)) { loggedSeen.add(k); logged.push(name); }
  };
  for (const item of items) {
    if ((loggedCount.get(key(item.name)) || 0) > 0) noteLogged(item.name, key(item.name));
  }
  loggedRaw.forEach((raw, i) => noteLogged(raw, loggedNames[i]));
  return { remaining, nextUp: remaining.length ? remaining[0] : null, complete, retired, logged };
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
// Where in `text` a lift name appears, or -1. Matches the FULL phrase with flexible
// separators — "Bench" must never satisfy "Bench Press".
function liftMentionIndex(text, name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return -1;
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]+');
  const m = new RegExp(pattern, 'i').exec(String(text));
  return m ? m.index : -1;
}

// An EXPLICIT next-up claim in the reply — "next up is X", "you're on X next",
// "then X". Returns the claimed lift text, or null when the reply makes no such claim.
// Only an explicit claim is judged; a reply that simply lists remaining work makes none.
const NEXT_UP_CLAIM_PATTERNS = Object.freeze([
  /next up(?:\s+is)?[:,]?\s+([A-Za-z][A-Za-z \-]{1,40})/i,
  /(?:you(?:'re| are)\s+)?(?:on|onto)\s+([A-Za-z][A-Za-z \-]{1,40})\s+next/i,
  /next(?:\s+(?:lift|exercise|movement))?\s+is[:,]?\s+([A-Za-z][A-Za-z \-]{1,40})/i,
  /(?:up next|first up)[:,]?\s+([A-Za-z][A-Za-z \-]{1,40})/i,
]);
function explicitNextUpClaim(text) {
  for (const re of NEXT_UP_CLAIM_PATTERNS) {
    const m = re.exec(String(text || ''));
    if (m && m[1]) return m[1].replace(/[.,;!].*$/, '').trim();
  }
  return null;
}

// ── the remaining-answer beat: strict default + plain logged-list carve-out ──
// (F-SB4B corrective 11, Option A — the redesign after three segment-aware heads)
//
// Session 3's scored run (fsb4b-s3-20261028T195320-ACB006) failed this beat on a
// reply that OPENED with a truthful logged recap ("You've logged Back Squat,
// Overhead Press, Romanian Deadlift, Seated Row, Incline DB Press, and Face
// Pull." — every fact verified accurate; Face Pull is the scenario's declared
// off-plan insertion) and then stated the remaining work correctly. The old
// beat had no framing awareness: ANY mention of a completed lift counted as
// claiming it remaining, and remaining ORDER was read off first mentions
// across the whole text, so the recap's log order failed a reply whose
// remaining statement (and the client's canonical state) were right.
//
// Three segment-aware heads (93907b08, f4459300, 25667b2d) tried to judge each
// framed segment as what it is. Three independent reviews each found the same
// escape in a new form: a completed lift asserted as still-to-do HIDING inside
// a logged-framed sentence — conjoined at a clause boundary (B1), joined by a
// bare comma or "and" with the predicate outside the added vocabulary (B1-R),
// and finally with subject and predicate SEPARATED by a relative pronoun, an
// em-dash, an appositive, a determiner, or mere lowercase (B1-R2) — while the
// third head also began failing truthful DECORATED recaps ("Overhead Press
// (60 kg)", "… for 2 sets", "… (last one was tough)"). Prose shape cannot
// separate list membership from a new claim: a lift name plus further material
// is neither necessary nor sufficient for "new assertion". The repair loop's
// stop rule fired, and the coordinator decided Option A: flip the default.
//
// THE RULE (Option A). A COMPLETE lift named ANYWHERE in the reply counts
// against the session — the pre-corrective whole-text behaviour — UNLESS the
// mention sits inside a PLAIN, UNDECORATED LOGGED LIST. A plain logged list
// is defined mechanically and narrowly, as a SENTENCE shape: the sentence's
// ENTIRE content is
//   (1) one logged-framing header — "You've logged", "You logged",
//       "We've completed", "Logged this session:", "Logged:" — followed by
//   (2) one or more lift names drawn from the declaration's own names
//       (remaining / complete / retired / logged), joined ONLY by list
//       punctuation and conjunctions: commas, semicolons, "and", "or", "&".
// No parentheticals, no weights, no set counts, no asides, no additional
// clauses, no still-to-do language. A sentence deviating in ANY token is not
// a list and earns no carve-out — fail-closed toward the strict default.
// There is no segmentation, no framing inheritance, and no per-item
// splitting: the carve-out is all-or-nothing per sentence, so no assertion
// can hide inside one — every escape in the three reviews is a sentence
// whose content is not exactly header + names, and is judged whole.
//
// The carved-out lists are still judged — as LOGGED claims: a lift named in
// one that the declaration records no logged sets for is a false logged
// claim. The remaining checks (presence, order, the complete and retired
// bans, explicit next-up claims) run over the text OUTSIDE the carved lists,
// so a remaining lift named only inside a recap still does not count as
// stated remaining. A decorated recap naming a completed lift ("Overhead
// Press (60 kg)") FAILS under this rule — intended, chosen behaviour: the
// definition was not widened to rescue it, because every widening round is
// what reopened the escape.
//
// Option A′ — the one bounded extension of A, decided after the Session 3
// evidence was re-read. A's strictness failed the LITERAL Session 3 reply
// for a reason A's rationale does not cover: after its plain recap, the
// reply carries a per-set detail sentence ("Back Squat 225 x 5 @ RIR 2
// Overhead Press 110 x 6 @ RI…" — preserved verbatim in the run's scorecard
// detail) that names completed lifts with SET FACTS. A detail sentence is
// not a claim about what remains: it carries no predicate at all. The three
// widening rounds died classifying CLAIMS (predicates); A′ widens only what
// counts as list CONTENT (facts), never assertions, by adding a SECOND
// carve-out shape alongside the plain logged list: the SET-FACT ENUMERATION,
// defined mechanically in `setFactEnumeration` below. A status assertion
// ("hasn't been done yet", "is unfinished", "was skipped") necessarily
// contains alphabetic tokens outside the fact vocabulary, so it can never
// sit inside either carve-out shape — the escape class stays dead by
// construction, for the same reason as under A. The plain logged list is
// unchanged, byte-for-byte as strict: its header sentence gains no facts
// allowance, and the enumeration shape has no header — a header sentence
// carrying facts is neither shape and is judged whole.
const LOGGED_LIST_HEADERS = Object.freeze([
  /^(?:you|we)(?:'ve| have)\s+(?:just\s+|already\s+|also\s+)?(?:logged|completed|recorded|finished)(?:\s*:\s*|\s+)/i,
  /^(?:you|we)\s+(?:just\s+|already\s+|also\s+)?(?:logged|completed|recorded|finished)(?:\s*:\s*|\s+)/i,
  /^logged\s+this\s+session(?:\s*:\s*|\s+)/i,
  /^logged\s*:\s*/i,
]);

// ── Declaration-declared lift aliases (F-SB4B corrective 12) ────────────────
//
// Session 3's second scored FAIL (run fsb4b-s3-20261029T082343-D0E7E0): PR
// #1591's deterministic lane answered "What do I have left?" with the
// grounded statement, whose Logged list is rendered from session_tally
// spellings — the tally's log-row name for the deadlift is "RDL", while the
// declaration names the lift "Romanian Deadlift". The carve-out vocabulary
// was the declaration's names only, so that one tally-spelled item sank the
// whole plain logged list and the beat judged the recap as prose: completed
// lifts were flagged and the remaining order was read off first mentions
// inside the recap. Diagnosis probes proved the 2×2: even a substantively
// perfect remaining answer in the product's real output shape failed this
// beat, and the same text with the deadlift spelled as the declaration
// spells it passed. A target that names a lift differently BY DESIGN is a
// harness vocabulary mismatch, not a product failure.
//
// THE ADMISSION — vocabulary only, no judging change: the frozen declaration
// may declare, per lift, the product's own spellings as ALIASES
// (expectation.aliases = { 'Romanian Deadlift': ['RDL'] }, declared in the
// scenario, on the spec side). An admitted alias enters knownLiftNames under
// its canonical lift's key and counts as a mention of that lift EVERYWHERE
// the beat looks — carve-out membership, logged claims, complete/retired
// naming, remaining presence and order, next-up claims — so an alias is
// never a hiding place: "RDL" outside a qualifying logged list flags exactly
// as "Romanian Deadlift" would. Aliases come ONLY from the declaration —
// never from the reply, never derived from the target's output — and match
// with this module's exact full-phrase matching. An undeclared spelling
// still disqualifies a carve-out: the fail-closed, all-or-nothing default is
// unchanged, and an expectation with no aliases is judged exactly as before.

// The expectation's declared aliases, as a Map of canonical name key ->
// alias spellings. Admissions are fail-closed: the canonical name must be
// one of the expectation's own names; an alias equal to its own lift's name
// or to ANOTHER lift's name admits nothing (it would blur two lifts into
// one); an alias string claimed by two lifts admits nothing for either.
function declaredLiftAliases(expectation) {
  const exp = expectation && typeof expectation === 'object' ? expectation : {};
  const key = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, ' ');
  const raw = (exp.aliases && typeof exp.aliases === 'object' && !Array.isArray(exp.aliases)) ? exp.aliases : {};
  const canonicalKeys = new Set();
  for (const list of [exp.remaining, exp.complete, exp.retired, exp.logged]) {
    for (const name of (Array.isArray(list) ? list : [])) {
      const k = key(name);
      if (k) canonicalKeys.add(k);
    }
  }
  const byCanonical = new Map();
  const owners = new Map();
  for (const [name, aliases] of Object.entries(raw)) {
    const ck = key(name);
    if (!ck || !canonicalKeys.has(ck) || !Array.isArray(aliases)) continue;
    const clean = [];
    for (const alias of aliases) {
      const s = String(alias == null ? '' : alias).trim();
      const ak = key(s);
      if (!s || !ak || ak === ck || canonicalKeys.has(ak)) continue;
      if (clean.some((x) => key(x) === ak)) continue;
      clean.push(s);
      owners.set(ak, (owners.get(ak) || 0) + 1);
    }
    if (clean.length) byCanonical.set(ck, clean);
  }
  for (const [ck, aliases] of byCanonical) {
    const kept = aliases.filter((a) => owners.get(key(a)) === 1);
    if (kept.length) byCanonical.set(ck, kept);
    else byCanonical.delete(ck);
  }
  return byCanonical;
}

// The first mention of a lift in `text`, counting its declaration-declared
// aliases as mentions of the lift itself. Returns the earliest index, or -1.
function liftMentionIndexWithAliases(text, name, aliasesByKey) {
  let at = liftMentionIndex(text, name);
  const key = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, ' ');
  for (const alias of (aliasesByKey.get(key(name)) || [])) {
    const i = liftMentionIndex(text, alias);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  return at;
}

// The declaration's own lift names, longest first so a longer name is tried
// before any shorter name it contains. Entries: { name, key } — `name` keeps
// the declaration's spelling for failure messages. Declaration-declared
// aliases (corrective 12) enter as further entries under their canonical
// lift's key, so a carved list naming an alias is judged as a logged claim
// about the canonical lift.
function knownLiftNames(expectation) {
  const exp = expectation && typeof expectation === 'object' ? expectation : {};
  const key = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, ' ');
  const out = [];
  const seen = new Set();
  for (const list of [exp.remaining, exp.complete, exp.retired, exp.logged]) {
    for (const name of (Array.isArray(list) ? list : [])) {
      const k = key(name);
      if (name && k && !seen.has(k)) { seen.add(k); out.push({ name, key: k }); }
    }
  }
  const aliases = declaredLiftAliases(exp);
  for (const entry of out.slice()) {
    for (const alias of (aliases.get(entry.key) || [])) out.push({ name: alias, key: entry.key });
  }
  return out.sort((a, b) => b.name.length - a.name.length);
}

// True when `part` is exactly the lift `name` — the full phrase with flexible
// separators and nothing before or after (the anchored form of the mention
// match used everywhere else in this module: "Bench" is not "Bench Press").
function isExactLiftName(part, name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]+');
  return new RegExp(`^${pattern}$`, 'i').test(part);
}

// Match ONE sentence against the plain logged-list shape above. Returns the
// list's lift entries in order, or null when the sentence is anything else —
// any token that is not the header, a known lift name, or list punctuation /
// conjunction disqualifies the whole sentence.
function plainLoggedList(sentence, known) {
  const s = String(sentence || '').trim();
  let rest = null;
  for (const re of LOGGED_LIST_HEADERS) {
    const m = re.exec(s);
    if (m) { rest = s.slice(m[0].length); break; }
  }
  if (rest === null) return null;
  const body = rest.replace(/[.!?]+\s*$/, '').trim();
  if (!body) return null;
  const items = body.split(/\s*(?:,|;)\s*/)
    .flatMap((p) => p.split(/\s+(?:and|or)\s+/i))
    .map((p) => p.trim().replace(/^(?:and|or)\s+/i, '').replace(/^["“”'']+|["“”'']+$/g, '').trim())
    .filter(Boolean);
  if (!items.length) return null;
  const names = [];
  for (const item of items) {
    const hit = known.find((entry) => isExactLiftName(item, entry.name));
    if (!hit) return null;
    names.push(hit);
  }
  return names;
}

// ── Option A′: the set-fact enumeration — the second carve-out shape ────────
//
// A sentence is a SET-FACT ENUMERATION when its ENTIRE content is one or
// more entries of the form
//   LIFT-NAME (fact atom)*
// joined only by list punctuation (commas, semicolons) and conjunctions
// ("and", "or", "&"), where LIFT-NAME is drawn from the declaration's own
// names (`known`, the same set the plain logged list draws from) and a fact
// atom is exactly one of:
//   - a number: digits with an optional decimal part ("225", "102.5"),
//     optionally carrying a load unit ("225 kg", "60kg"),
//   - a standalone load unit: "kg", "lb",
//   - a rep/set marker: "x", "×" (spaced "225 x 5" or attached "3x5"),
//   - the effort tokens "@" and "RIR" ("@ RIR 2").
// NO other token is allowed anywhere in the sentence: any prose word,
// predicate, parenthetical aside, or status language disqualifies the WHOLE
// sentence (fail-closed to the strict default). Token classes not listed —
// the words "reps"/"sets", "RPE", "lbs", "pounds", "%", ranges ("5-6"),
// bodyweight shorthands — are excluded by that silence: ambiguous classes
// stay out rather than being guessed in. The sentence must carry at least
// one fact atom overall: a fact-free sentence is a headerless name list,
// which is NOT carved out (the plain list's header requirement stands, and
// this shape has no header). An entry may carry zero fact atoms when a
// sibling entry carries them — the names are still judged as logged claims,
// so a bare entry can state nothing but membership.
//
// One fact atom at the match position (sticky). Alphabetic atoms are
// word-bounded so they cannot match inside a longer word ("x" inside
// "extra", "rir" inside "first", "kg" inside a name fragment).
const SET_FACT_ATOM = /\d+(?:\.\d+)?(?:\s*(?:kg|lb)(?![a-z]))?|(?:kg|lb)(?![a-z])|@|rir(?![a-z])|[x×](?![a-z])/iy;

// Match ONE known lift name at exactly `pos` in `body` (the declaration's
// names are tried longest first by knownLiftNames). The name must end at a
// non-alphanumeric boundary, so "Back Squat225" is not the name "Back
// Squat" followed by a fact. Returns { entry, length } or null.
function matchKnownLiftNameAt(body, pos, known) {
  const rest = body.slice(pos);
  for (const entry of known) {
    const words = String(entry.name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]+');
    const m = new RegExp(`^${pattern}(?![a-z0-9])`, 'i').exec(rest);
    if (m) return { entry, length: m[0].length };
  }
  return null;
}

// Match ONE sentence against the set-fact enumeration shape above. Returns
// the enumeration's lift entries in order, or null when the sentence is
// anything else.
function setFactEnumeration(sentence, known) {
  const s = String(sentence || '').trim();
  const body = s.replace(/[.!?]+\s*$/, '').trim();
  if (!body) return null;
  let pos = 0;
  let factAtoms = 0;
  const entries = [];
  const skipInline = () => { while (pos < body.length && /\s/.test(body[pos])) pos += 1; };
  // Between entries: whitespace, commas, semicolons, "&", and the
  // conjunction words "and" / "or" as whole tokens.
  const skipSeparators = () => {
    for (;;) {
      skipInline();
      const ch = body[pos];
      if (ch === ',' || ch === ';' || ch === '&') { pos += 1; continue; }
      const conj = /^(?:and|or)(?![a-z])/i.exec(body.slice(pos));
      if (conj) { pos += conj[0].length; continue; }
      return;
    }
  };
  skipInline();
  for (;;) {
    const hit = matchKnownLiftNameAt(body, pos, known);
    if (!hit) return null;
    entries.push(hit.entry);
    pos += hit.length;
    // The entry's fact atoms — numbers, units, markers, nothing else. The
    // first token that is not a fact atom ends the entry's facts; the main
    // loop then requires a separator and the next entry's name.
    for (;;) {
      skipInline();
      SET_FACT_ATOM.lastIndex = pos;
      const atom = SET_FACT_ATOM.exec(body);
      if (!atom) break;
      pos += atom[0].length;
      factAtoms += 1;
    }
    skipSeparators();
    if (pos >= body.length) break;
  }
  // A fact-free sentence is a headerless name list, not an enumeration.
  if (!entries.length || factAtoms === 0) return null;
  return entries;
}

// Split the reply into sentences and carve out its plain logged lists and
// its set-fact enumerations (Option A′). Returns { judgedText, loggedNames }:
// the text every remaining-work check runs over, and the lift entries the
// carved sentences claimed as logged.
function carvePlainLoggedLists(replyText, known) {
  const sentences = String(replyText == null ? '' : replyText)
    .split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const judged = [];
  const loggedNames = [];
  for (const sentence of sentences) {
    const list = plainLoggedList(sentence, known) || setFactEnumeration(sentence, known);
    if (list) loggedNames.push(...list);
    else judged.push(sentence);
  }
  return { judgedText: judged.join(' '), loggedNames };
}

// Does the visible reply agree with the declaration — in CONTENT and in ORDER, and on
// any explicit next-up claim it chooses to make?
//
// The gap this closes (owner P1, 2026-08-03): proving every remaining lift is mentioned
// and no completed/retired lift is, does not prove the reply told the truth about
// SEQUENCE. A reply naming every correct lift in the wrong order, or explicitly naming
// the wrong lift as next while mentioning the real next-up elsewhere, passed.
//
// Corrective 11 (Option A, as extended by A′): the checks run over the reply
// MINUS its plain logged lists and set-fact enumerations (see the carve-outs
// above) — a truthful plain recap or per-set detail sentence can neither
// satisfy a remaining claim nor pollute its order — and the carved sentences
// are judged as logged claims against the expectation's `logged` knowledge.
function replyMatchesExpectation(replyText, expectation) {
  const problems = [];
  const text = String(replyText == null ? '' : replyText);
  const exp = expectation && typeof expectation === 'object' ? expectation : {};
  const remaining = Array.isArray(exp.remaining) ? exp.remaining : [];

  const aliases = declaredLiftAliases(exp);
  const { judgedText, loggedNames } = carvePlainLoggedLists(text, knownLiftNames(exp));

  const positions = [];
  for (const name of remaining) {
    const at = liftMentionIndexWithAliases(judgedText, name, aliases);
    if (at < 0) problems.push(`the reply does not name remaining lift "${name}"`);
    else positions.push({ name, at });
  }
  for (const name of (Array.isArray(exp.complete) ? exp.complete : [])) {
    if (liftMentionIndexWithAliases(judgedText, name, aliases) >= 0) problems.push(`the reply names "${name}", which the declaration says is already complete`);
  }
  for (const name of (Array.isArray(exp.retired) ? exp.retired : [])) {
    if (liftMentionIndexWithAliases(judgedText, name, aliases) >= 0) problems.push(`the reply names "${name}", which an accepted substitution removed from the plan`);
  }

  // LOGGED claims: a lift named in a carved-out plain logged list or
  // set-fact enumeration must be one the declaration records logged sets
  // for. An expectation built by hand
  // without `logged` falls back to its complete lifts — the only lifts such
  // an expectation can prove were logged. A retired lift named here is caught
  // as the false logged claim it is (it was never logged); the retired rule
  // above still governs a retired lift named anywhere else.
  if (loggedNames.length) {
    const key = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, ' ');
    const loggedKeys = new Set((Array.isArray(exp.logged) ? exp.logged : (Array.isArray(exp.complete) ? exp.complete : [])).map(key));
    const seen = new Set();
    for (const entry of loggedNames) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      if (!loggedKeys.has(entry.key)) {
        problems.push(`the reply names "${entry.name}" as logged, but the declaration records no logged sets for it`);
      }
    }
  }

  // ORDER: the remaining lifts must appear in the declared sequence — judged
  // by first mentions WITHIN the judged text, never across a carved recap.
  if (positions.length === remaining.length && remaining.length > 1) {
    const spoken = positions.slice().sort((a, b) => a.at - b.at).map((p) => p.name);
    if (spoken.join('|') !== remaining.join('|')) {
      problems.push(`the reply lists remaining work as [${spoken.join(', ')}]; the declaration order is [${remaining.join(', ')}]`);
    }
  }

  // EXPLICIT next-up: judged only when the reply actually makes the claim,
  // and only over the judged text a next-up claim can live in.
  const claimed = explicitNextUpClaim(judgedText);
  if (claimed !== null) {
    // Fall back to the head of the remaining list when the caller supplied no explicit
    // nextUp — an expectation with remaining work always has one.
    const wanted = exp.nextUp || (remaining.length ? remaining[0] : null);
    if (!wanted) problems.push(`the reply claims "${claimed}" is next, but the declaration expects no remaining work`);
    else if (liftMentionIndexWithAliases(claimed, wanted, aliases) < 0) {
      // One-directional on purpose: the CLAIM must carry the full expected name.
      // Accepting the reverse would let "Bench" satisfy "Bench Press", which is the
      // partial-name match this module refuses everywhere else.
      problems.push(`the reply claims "${claimed}" is next; the declaration expects "${wanted}"`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// The visible session pin must name the EXACT expected current lift and nothing retired
// or completed. A blank pin, or a pin naming the wrong lift, is a failure — checking
// only for a retired name let both pass (owner P1, 2026-08-03).
function pinMatchesExpectation(pinText, expectation) {
  const problems = [];
  const text = String(pinText == null ? '' : pinText).replace(/\s+/g, ' ').trim();
  const exp = expectation && typeof expectation === 'object' ? expectation : {};
  if (!text) return { ok: false, problems: ['the session pin is blank, so it proves nothing about the current lift'] };
  const wanted = exp.nextUp || null;
  if (wanted && liftMentionIndex(text, wanted) < 0) {
    problems.push(`the pin does not name the expected current lift "${wanted}"`);
  }
  for (const name of (Array.isArray(exp.retired) ? exp.retired : [])) {
    if (liftMentionIndex(text, name) >= 0) problems.push(`the pin names "${name}", which an accepted substitution removed from the plan`);
  }
  for (const name of (Array.isArray(exp.complete) ? exp.complete : [])) {
    if (liftMentionIndex(text, name) >= 0) problems.push(`the pin names "${name}", which the declaration says is already complete`);
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
  // Quiet, no served message — but was that because the path genuinely serves none, or
  // because the capture FAILED? Treating an unreadable coach response as "no message"
  // reopens the partial-render false green exactly when the authoritative completion
  // signal is missing (owner P1, 2026-08-03). Fail closed instead.
  if (o.captureFailed === true) return 'capture-failed';
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
  // (1) clean source on the required branch, exact SHA recorded — measured by the RUN, not asserted.
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
    title: `clean ${REQUIRED_BRANCH} equal to origin/${REQUIRED_BRANCH} with the exact SHA recorded; a qualifying session is also legal at the canonical count`,
    evaluate(obs) {
      const s = obs && obs.source;
      if (!s) return missing('the source tree');
      if (s.branch !== REQUIRED_BRANCH) return err(`the run executed on "${s.branch || 'unknown'}", not ${REQUIRED_BRANCH}`);
      if (s.clean !== true) return err('the worktree was not clean');
      if (!SHA_RE.test(str(s.head_sha))) return err('HEAD did not resolve to a full sha');
      if (s.head_sha !== s.origin_head_sha) return err(`HEAD ${str(s.head_sha).slice(0, 7)} != origin/${REQUIRED_BRANCH} ${str(s.origin_head_sha).slice(0, 7)}`);
      const purpose = normalizePurpose(obs.run_purpose);
      const n = obs.session_number;
      // PERSONA_RUN (persona test rig, issue #1607 — Slice 2b): a persona run
      // carries NO rehearsal session number by design — it is not a streak
      // member, so the session-number legality question does not exist for it
      // and is skipped, not answered. Everything else in this condition binds
      // it unchanged: the tree facts above, and the duty below to RECORD the
      // canonical count it ran at (recorded, never consulted for ordering).
      if (purpose !== PERSONA_RUN && !isRehearsalSessionNumber(n)) return err(`session number ${n} is not 1..${REHEARSAL_STREAK_LENGTH}`);

      if (purpose === null) return err('the run declared no recognized purpose, so count legality cannot be judged');
      const prior = s.prior_rehearsal_count;
      if (!Number.isInteger(prior)) {
        return err(`the canonical rehearsal count was unreadable (${s.prior_count_reason || 'no reason recorded'}); every run must record the count it ran at`);
      }
      const head = `${REQUIRED_BRANCH} @ ${s.head_sha.slice(0, 12)} (= origin/${REQUIRED_BRANCH}, clean)`;
      if (purpose === PERSONA_RUN) {
        return pass(`${head}; PERSONA run (${str(obs.persona_slug) || 'persona'}) ran at canonical count ${prior}/${REHEARSAL_STREAK_LENGTH} — recorded, never ordered against it, and cannot advance it`);
      }
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
      const purpose = normalizePurpose(obs && obs.run_purpose);
      if (purpose === null) {
        return err(`the run declared no recognized purpose (got "${(obs && obs.run_purpose) || ''}"); expected ${REHEARSAL_SESSION}, ${REHEARSAL_DEBUG} or ${PERSONA_RUN}`);
      }
      // PERSONA_RUN (persona test rig, issue #1607 — Slice 2b): the run identity
      // must carry THIS persona's marker — the persona family check, disjoint
      // from the rehearsal family in both directions (pinned in
      // test/personaLane.test.js). A rehearsal run id presented here ERRORs
      // exactly as a foreign session's run id does in the rehearsal lane: one
      // lane's artifacts can never satisfy the other.
      const runRef = purpose === PERSONA_RUN
        ? personaRunIdentityRefusal({ slug: obs.persona_slug, runId: obs.run_id })
        : runIdentityRefusal({ sessionNumber: obs.session_number, runId: obs.run_id });
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
  // (6) real browser and built client — the shell the browser ran must be the
  // build OF THE EXACT VERIFIED SOURCE (condition 1), not merely A build: a
  // bundle built from an older commit serves stale client code under a fresh
  // source's name while the server executes fresh (run
  // fsb4b-s3-20261029T101354-B9957C, whose served bundle predated four merged
  // client fixes). Both sides of the comparison are recorded and named.
  {
    id: 'real_browser_built_client',
    title: 'a real browser drove the BUILT client shell, built from the exact verified source commit',
    evaluate(obs) {
      const ui = obs && obs.ui;
      if (!ui) return missing('the browser evidence');
      if (ui.real_browser !== true) return err('the run did not record a real browser');
      if (!str(ui.shell_build)) return err('the built shell recorded no build identity');
      const served = str(ui.build_commit);
      if (!served) return err('the run recorded no served build commit — the built client cannot be tied to the verified source');
      if (!SHA_RE.test(served)) return err(`the recorded served build commit "${served}" is not a full commit sha`);
      const s = obs && obs.source;
      if (!s) return missing('the source tree');
      const head = str(s.head_sha);
      if (!SHA_RE.test(head)) return err('the verified source sha was not recorded as a full commit sha');
      if (served !== head) return fail(`the served client was built from commit ${served} but the verified source is ${head} — the run measured a stale client build, not the source it claims`);
      return pass(`built shell ${ui.shell_build} in a real browser; served build commit ${served} == verified source ${head}`);
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
      // A persona whose script ends a set block with a timed hold (Priya's
      // plank, Slice 2c) declares that hold as a Modality_Log row: the
      // fixture's log_rows counts it (9 Log_Cleaned + 1 modality = 10),
      // and the split is declared explicitly as modality_rows. The
      // condition judges the SUM against log_rows, plus the modality
      // count itself when declared — a strengthening, never a weakening:
      // a run landing 9 + 0 fails here with both numbers named. A
      // scenario with no modality_rows declared (every rehearsal, Marcus)
      // takes the old path exactly: modality 0, same comparison, same
      // pass message.
      const modality = obs && obs.durable && obs.durable.modality;
      const modalityRows = modality && Number.isFinite(modality.row_count) ? modality.row_count : 0;
      const modalityDeclared = ex.modality_rows !== undefined && ex.modality_rows !== null ? ex.modality_rows : null;
      if (modalityDeclared !== null && modalityRows !== modalityDeclared) {
        return fail(`expected ${modalityDeclared} Modality_Log row(s), found ${modalityRows}`);
      }
      if (d.row_count + modalityRows !== ex.log_rows) {
        return fail(`expected ${ex.log_rows} log rows (Log_Cleaned + Modality_Log), found ${d.row_count} + ${modalityRows}`);
      }
      if (d.rows_match_declaration !== true) return fail(d.detail || 'the rows did not match the declared sets');
      return pass(modalityDeclared !== null
        ? `${d.row_count} Log_Cleaned + ${modalityRows} Modality_Log rows, matching the declared sets`
        : `${d.row_count} rows, matching the declared sets`);
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
      : purpose === PERSONA_RUN
        ? `PERSONA RUN — persona scenario evidence only. A persona run is not a rehearsal session: it can never advance or authorize the rehearsal count, and a full ${counts.PASS}/${conditions.length} score does not make it eligible.`
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
    persona_slug: (obs && typeof obs.persona_slug === 'string' && obs.persona_slug.trim()) ? obs.persona_slug.trim() : null,
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
  const banner = card.purpose === PERSONA_RUN
    ? `# Persona rehearsal (NON-COUNTING) — ${card.persona_slug || 'persona'} — ${card.overall}`
    : card.qualifying
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

module.exports = { CONDITIONS, scoreRehearsalRun, renderMarkdown, compareLedgerToDeclaration, classifyRepeatApprovalProbe, classifySettlement, isSettled, SETTLED_OUTCOMES, deriveExpectedRemaining, compareRemainingToExpectation, replyMatchesExpectation, pinMatchesExpectation, explicitNextUpClaim, liftMentionIndex, detectUnsupportedMutationWording, COMPLETED_MUTATION_PATTERNS, compareReplacementIdentity, classifyCoachResponseCapture, detectUnsupportedWriteClaim, WRITE_CLAIM_PATTERNS, PASS, FAIL, ERROR, NOT_APPLICABLE };
