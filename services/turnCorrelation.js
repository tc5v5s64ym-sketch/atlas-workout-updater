'use strict';

// Cross-route turn↔write correlation (#1165) — the Phase-4 critical-path seam.
//
// THE PROBLEM. The canonical `turn_id` is minted at the coach turn's first trusted
// boundary (services/interactionTraceShadow.mintTurnId, via beginTurn). But the coach
// routes are READ-ONLY — /api/coach/message|chat|ask are declared
// `readOnly: true, writeCapable: false` in config/routes.js — so the write a turn
// authorizes lands LATER, on a different request to a different route. Nothing carried the
// id across that boundary, so the InteractionTrace could never populate its `write_proof`
// stage. The 2026-07-25 Golden Session recorded that as ARCHITECTURAL, not as missing log
// evidence: there is no write on the coach route to prove
// (docs/verification/PHASE_4_GOLDEN_SESSION_EVIDENCE_2026-07-25.md, criterion 7).
//
// THE SEAM. The client carries the id across the round-trip. The claim is explicitly
// NON-AUTHORITATIVE: the client may assert a turn id, but the SERVER decides whether that
// id is real, fresh, and its own. That is why this module keeps an ISSUANCE REGISTRY —
// without one, any well-formed string would be accepted, which is precisely what
// "non-authoritative" must not permit.
//
// FAIL CLOSED, ALWAYS. A claim resolves only when it is well-formed, was issued by this
// server, was issued for THIS session, and is fresh. Anything else drops the correlation.
// Crucially, a rejected claim NEVER blocks or alters the write: correlation is telemetry
// riding alongside the trust loop, never part of it. A dropped correlation costs a
// reviewable join; a wrong one would corrupt the evidence record.
//
// BOUNDED. The registry is TTL'd and hard-capped exactly like
// services/coachDiscussionReferent.js — ephemeral, never a Sheet or durable record.
//
// WHAT THIS IS NOT. It does not make a coach route write-capable, does not touch the
// preview→approve→write loop, and does not reshape any W1–W3 proof field — the write-proof
// record COPIES those fields verbatim. D10 (cross-turn discussion referent) will later
// reuse this same round-trip envelope by adding its own field; it is NOT implemented here.

// #1173 item 1 — PREVIEW-ESTABLISHED BINDING (replaces #1172's first-write-wins).
//
// #1172 bound a turn to the FIRST write_id it correlated. With no prior binding the CLIENT
// still chose which write became "the authorized one", so a record established only "this turn
// exists in this session" — not the property #1165 exists to prove. Worse, a turn id attached
// to the wrong same-session write LOCKED THE LEGITIMATE WRITE OUT, turning a client bug into
// LOST evidence rather than wrong evidence.
//
// The pairing is now established at the PREVIEW and keyed on a server-minted token.
//
// WHY NOT write_id, which the direction in #1173 proposed. Checked against src/app/app.js
// rather than assumed, and the prerequisite does NOT hold:
//   • /api/log-workout is the ONE path whose dry-run really carries the write_id it will later
//     approve with — app.js:6960 puts it inside the test_mode payload, 7012 stores that same
//     object on pendingWrite, 7506 re-sends it with only test_mode deleted;
//   • both /api/complete-workout paths WITHHOLD it from the dry-run by design
//     (app.js:7113 `if (writeId && !testMode)`), minting it only after the preview returns
//     (6918, 6944); modality (6114/6133) and bodyweight (7790) mint it after the preview too;
//   • and even on log-workout the client DELIBERATELY RE-MINTS it mid-flow on the documented
//     seal retry (app.js:7563-7568) — same turn, same preview, new write_id.
// So a write_id key would be correct on one route of five, would force the contract to change
// again the moment the seam extends, and would re-create the very lockout it was meant to
// remove. It is also CLIENT-minted, so the client would keep supplying the pairing key.
//
// WHAT THE TOKEN BUYS. It is minted only in the response to a preview that carried this turn's
// claim, so a turn that never previewed can never correlate a write, and a client that only
// scraped the turn id from the response header cannot claim one.
//
// BUT A TOKEN ALONE IS ONLY A TURN-LEVEL BINDING. The first cut of this change stopped there and
// claimed a write-level one; Codex refuted that (r3649520130) and was right — a valid token
// attached to a DIFFERENT same-session payload was accepted, so the record proved only "this turn
// previewed something, and this write presented its token". The previewed `write_id` was the only
// corroboration and four of five write paths never send it at preview.
//
// SO THE PAYLOAD IS GATED TOO. `_previewIdentity` fingerprints the write identity the SERVER
// received at preview and the live payload must reproduce it. It depends on nothing the client
// mints, so it holds on every route rather than one of five. The fingerprint is DEFAULT-DENY over
// the whole payload — see IDENTITY_EXCLUDED_FIELDS for the three fields outside it and why, and
// `_payloadMatchesPairing` for the one permitted transition.
//
// THE CEILING, STATED HONESTLY. Where the payload gate applied and matched, this establishes:
// "this turn previewed a write of exactly this identity, and this write presented that preview's
// token". `payload_bound` is true ONLY in that case — never on a preview record (no live payload
// exists yet to compare) and never where no identity was computable, both of which degrade to a
// turn-level claim and say so rather than assume a match. Neither form is cryptographic
// authorization, which no client round-trip can deliver. The previewed write_id stays
// CORROBORATION (`previewed_write_id_match`) and never a gate, precisely so the legitimate seal
// retry keeps its evidence instead of being locked out.
//
// UNTIL SLICE 2 CARRIES THE TOKEN, NO LIVE WRITE CORRELATES — previews still do. That is
// fail-closed and deliberate: it is why #1173 orders this item before the client round-trip.

const crypto = require('crypto');
const { isShadowEnabled } = require('./interactionTraceShadow');
// Only to locate the Effort contract's session column by NAME rather than a hardcoded index, so a
// schema change cannot silently move the session identity out from under the check below.
const { effortColumns, logCleanedColumns, effortRowFieldAliases } = require('../config/columns');

// A correlation claim is good for one live-workout beat — long enough for a lifter to read
// a reply, do the set, and save; short enough that a stale client cannot attribute a write
// to a conversation that has moved on. Mirrors the discussion-referent window.
const DEFAULT_MAX_AGE_MS = 8 * 60 * 1000;

// Hard cap on issued turns held at once. Far above any realistic concurrent-turn count
// (single-owner V1); oldest entries evict past it, so sustained traffic cannot grow the map.
const MAX_ENTRIES = 500;

// Bound the accepted id length so a hostile or buggy client cannot push an unbounded string
// through the format gate and into a log line.
const MAX_TURN_ID_LENGTH = 128;

// The canonical minted shape: `turn:<ISO-8601>_<seq>_<rand>`. Deliberately narrower than
// Drift Guard 4's TRACE_ID_RE (which also admits trace:/flight:/session: ids) — only a TURN
// id may correlate a turn to its write.
const TURN_ID_RE = /^turn:[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

// The pairing token's shape. Server-minted ONLY, so the gate demands the exact minted form
// rather than a permissive pattern — a token is never anything a client composed.
const PAIRING_TOKEN_BYTES = 16;
const PAIRING_TOKEN_RE = /^pair:[a-f0-9]{32}$/;

// How many DISTINCT write_ids one turn may correlate. Not one: the documented closeout seal
// retry (app.js:7563-7568) re-mints the write_id for the same staged write, and refusing it is
// exactly the lost-evidence lockout #1173 records. Not unlimited either — that would let one
// token be replayed against every save in the freshness window, which is the replay protection
// #1172's first-write-wins existed to provide and this must not simply drop. Each correlated
// write is stamped with its attempt number, so a reviewer always sees which it was.
const MAX_WRITES_PER_PAIRING = 5;

// How many of a turn's preview pairings may be outstanding at once (Codex P2, this PR).
//
// The first cut kept ONE and superseded it on every preview — last COMPLETION wins. That is the
// wrong order: two previews for the same turn can overlap, and the client keeps whichever
// response is newest by INITIATION order (`previewRequestSeq` / `submitSeq`,
// src/app/app.js:6416, 6881), discarding a superseded response even when it arrives last. So an
// older request finishing last left the registry holding a token the client had already thrown
// away, and the approved write lost its correlation to `pairing_mismatch` — lost evidence, the
// very failure mode this item exists to remove. The server cannot observe the client's
// initiation order, so it must not pretend to: it accepts any of the turn's recent pairings.
//
// This costs nothing in claim strength. Every outstanding pairing belongs to the SAME turn and
// each is independently payload-bound, so accepting any of them cannot mis-attribute a write.
//
// KNOWN RESIDUAL LIMITATION, not closed here (Codex second round, r3649542463, and it is right).
// Eviction is still by COMPLETION order, so a finite set cannot GUARANTEE it retains the pairing
// the client kept: if more than MAX_OUTSTANDING_PAIRINGS previews overlap AND the newest-initiated
// one completes first, its token is pushed first and evicted first, while the client discarded
// every other response by initiation sequence. Raising the cap shrinks the window but cannot
// remove it — only initiation identity or explicit retirement FROM the client can, and inventing
// that field here would design slice 2's client contract from the wrong end. It is therefore
// recorded as a REQUIREMENT ON SLICE 2 in the canonical plan's CAMPAIGN STATE — the sole
// work-selection authority, and where the round-trip protocol is actually designed.
//
// The failure mode is bounded and one-directional: a LOST correlation, never a wrong one. No
// record can overclaim because of it — the write proceeds untouched and simply goes unjoined.
// The cap is set well above any plausible concurrent-preview count for a single-owner V1 client
// that previews on explicit submits, so this is a mitigation with a documented gap, not a fix.
const MAX_OUTSTANDING_PAIRINGS = 8;

// Cap the fingerprint input so a pathological payload cannot turn identity computation into
// unbounded work. Past it the identity is null — which under-claims (payload_bound:false)
// rather than failing a legitimate write's correlation on size alone.
const MAX_IDENTITY_INPUT_CHARS = 200_000;

// The preview fingerprint is DEFAULT-DENY: it covers the WHOLE payload except these fields.
//
// The first cut listed the fields to include (session_id + date + log_rows) and Codex found the
// gap that shape guarantees (r3649542461): `/api/log-workout` also APPENDS `effort_row`
// (index.js:2930) and drives the closeout capture and ledger seal from `closeout_context`
// (index.js:3172, 3320), so a live request could change either while keeping the three listed
// fields and still be reported `payload_bound:true`. Default-deny means a field added to the
// payload in future is bound automatically rather than silently unbound.
//
// Each exclusion is a field that provably differs between a preview and its own approve:
//   • `test_mode`   — deleted on approve (app.js:7507); the one field that ALWAYS differs;
//   • `write_id`    — re-minted on the documented seal retry (app.js:7566);
//   • `correlation` — the envelope carrying the pairing token, which differs by construction.
// `effort_row` is NOT excluded. It is write-affecting, so its documented REMOVAL on the seal
// retry (app.js:7567) is handled as one explicit permitted TRANSITION below — which still
// refuses a CHANGED or newly-ADDED effort row.
const IDENTITY_EXCLUDED_FIELDS = Object.freeze(['test_mode', 'write_id', 'correlation']);

// The ONLY proof keys that may be copied into a correlation record. A closed whitelist, not
// a denylist: a field added to a write response in future is excluded by default rather than
// silently published. Every one of these is an existing W1–W3 proof field or its immediate
// evidence — none is workout data, prose, a credential, or a Sheet ID.
const PROOF_KEYS = Object.freeze([
  'test_mode',
  'sheet_write',
  'sheet_written',
  'no_write_confirmed',
  'dry_run',
  'reason',
  'write_id',
  'duplicate_write',
  'log_appended_range',
  'effort_appended_range',
  'rows_appended',
  // The live /api/log-workout response spells its range evidence in camelCase and reports
  // row counts rather than a `sheet_written` boolean, so the whitelist carries the ACTUAL
  // served names too. Verified against the route's response body, not assumed — a whitelist
  // built from guessed names would silently record an empty proof.
  'logAppendedRange',
  'effortAppendedRange',
  'log_rows_written',
  'effort_rows_written',
  'effortWritten',
  'idempotency_status',
  'closeout_fully_verified',
  'skipped_duplicates',
]);

// The resolution outcomes. Exactly one is returned per claim; each rejection names WHY, so a
// reviewer can tell a client that never claimed from one whose claim was refused.
// `write_mismatch` is deliberately ABSENT: first-write-wins is retired, not bypassed, so no
// caller can fall back to it (test/turnCorrelation.test.js pins its removal).
const REASONS = Object.freeze({
  OK: 'ok',
  ABSENT: 'absent',
  MALFORMED: 'malformed',
  UNKNOWN: 'unknown',
  SESSION_MISMATCH: 'session_mismatch',
  STALE: 'stale',
  UNPAIRED: 'unpaired',
  PAIRING_MISMATCH: 'pairing_mismatch',
  PAIRING_EXHAUSTED: 'pairing_exhausted',
  PAYLOAD_MISMATCH: 'payload_mismatch',
});

// turnId -> { sessionId, atMs, pairings: [], writeIds: [] }
//
// `atMs` is the turn's ISSUANCE time and stays the freshness anchor — establishing a pairing
// never refreshes it, so a client cannot keep a turn alive by previewing in a loop and then
// correlate a write to a conversation that has moved on.
//
// `pairings` holds up to MAX_OUTSTANDING_PAIRINGS entries, one per preview, oldest evicted:
//   { token, atMs, identity, previewedWriteId }
// `writeIds` is per TURN, not per pairing, so the replay cap bounds the turn however many
// overlapping previews it accumulated. Both ride the turn's own capped/TTL'd entry.
const registry = new Map();

// The emitted correlation records, for the reviewable artifact. Ring-buffered like the
// packet/trace shadow — in-memory only, never durable.
const MAX_LOG = 200;
const _log = [];

function _isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function _now(opts) {
  return opts && typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
}

// Is this a structurally valid turn id? Shape only — says nothing about whether the server
// issued it. Checked BEFORE any registry lookup so a malformed claim never probes the map.
function isWellFormedTurnId(v) {
  if (!_isNonEmptyString(v)) return false;
  const id = v.trim();
  if (id.length > MAX_TURN_ID_LENGTH) return false;
  return TURN_ID_RE.test(id);
}

// Is this the exact minted pairing-token shape? Shape only — says nothing about whether this
// server minted THIS token. Checked BEFORE any comparison so an unbounded or junk value is
// refused without being compared against a live token.
function isWellFormedPairingToken(v) {
  if (!_isNonEmptyString(v)) return false;
  return PAIRING_TOKEN_RE.test(v);
}

// A fresh, unguessable pairing capability. crypto, never Math.random: a predictable token
// would let a client that never previewed compose one and claim a write.
function _mintPairingToken() {
  return `pair:${crypto.randomBytes(PAIRING_TOKEN_BYTES).toString('hex')}`;
}

// Deterministic, key-order-independent serialization. A client that re-serializes the same
// payload (different key order, an added unrelated field on a nested row) must still fingerprint
// identically, or a legitimate approve would be refused on formatting alone. Bounded in depth so
// a hostile nesting cannot drive unbounded recursion.
function _canonicalJson(v, depth = 0) {
  if (depth > 8) return '"__depth__"';
  if (v === undefined) return 'null';
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(x => _canonicalJson(x, depth + 1)).join(',')}]`;
  if (_isPlainObject(v)) {
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${_canonicalJson(v[k], depth + 1)}`).join(',')}}`;
  }
  return 'null';
}

/**
 * The SERVER-COMPUTED identity of the write a payload describes (Codex P1, this PR).
 *
 * This is what makes the record's claim "this turn previewed THIS write" rather than "this turn
 * previewed something and this write presented its token". It is derived entirely from what the
 * SERVER received — nothing the client mints — so unlike the previewed `write_id` (present at
 * preview on one of five write paths) it holds on every route.
 *
 * Returns null when the payload carries no identity to fingerprint. Null must degrade to an
 * UNBOUND pairing that reports `payload_bound:false`, never to an assumed match: a turn-level
 * join is still real evidence, but it must not be published as a write-level one.
 */
function _previewIdentity(payload, opts = {}) {
  const p = _isPlainObject(payload) ? payload : {};
  const sessionId = _isNonEmptyString(p.session_id) ? String(p.session_id).trim() : '';
  // No session identity, or no row set to identify: nothing to bind the write to.
  if (!sessionId || !Array.isArray(p.log_rows)) return null;

  // Default-deny: every field except the documented exclusions. `session_id` and `date` are
  // trimmed so incidental whitespace cannot refuse a legitimate approve.
  const projection = {};
  for (const key of Object.keys(p)) {
    if (IDENTITY_EXCLUDED_FIELDS.includes(key)) continue;
    if (opts.dropEffort === true && key === 'effort_row') continue;
    if (p[key] === undefined) continue;
    projection[key] = key === 'session_id' || key === 'date' ? String(p[key]).trim() : p[key];
  }

  const serialized = _canonicalJson(projection);
  if (serialized.length > MAX_IDENTITY_INPUT_CHARS) return null;
  // A digest, so the registry never holds workout content — and it is never logged or published
  // either, exactly like the token: only the derived `payload_bound` boolean reaches the record.
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

// Where each contract keeps its session identity, located by NAME so a schema change cannot move
// it out from under the checks below. Positional rows in either shape are written VERBATIM from
// these columns (index.js:512 for Log_Cleaned, 541-545 for Effort), so both are client-controlled.
const EFFORT_SESSION_INDEX = effortColumns.indexOf('session_id');
const LOG_SESSION_INDEX = logCleanedColumns.indexOf('session_id');

// The object-form Effort session aliases, IN NORMALIZATION ORDER — taken from the shared contract
// rather than restated, so an alias added there is covered here automatically.
const EFFORT_SESSION_ALIASES = Object.freeze(
  (effortRowFieldAliases && effortRowFieldAliases.session_id) || ['session_id'],
);

// Any value the write path would use as a session, rendered for comparison. Deliberately NOT a
// string-only check: `normalizeLogRowObject` accepts any TRUTHY value (`row.session_id ||
// row.sessionId || topLevel`), so a number, boolean or object would win at write time while a
// string-only gate silently skipped it (Codex r3649569662). Rendering everything and comparing
// fails closed — a non-matching or unusable value simply is not the bound session.
function _renderSessionValue(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Every session identity a payload names BELOW its top level (Codex r3649557069, r3649569662).
 *
 * Comparing only the top-level session let a request write rows under session B while the
 * correlation record named session A — cross-session contamination inside the evidence itself.
 *
 * The two row shapes differ in a way that matters, and the difference is NOT cosmetic:
 *   • OBJECT rows resolve as `row.session_id || row.sessionId || topLevelSessionId`
 *     (index.js:449), so a FALSY value inherits the top level — already checked, so not a
 *     mismatch. Only a truthy value that disagrees is.
 *   • POSITIONAL rows have NO fallback: `logRowArrayToObject` sets `session_id: row[1]` flat
 *     (index.js:512). Every positional row is therefore an EXPLICIT session, and an empty one is
 *     written as an empty session_id — a different session, not an inherited one. So positional
 *     rows are always compared, empty included.
 *
 * The Effort row is a THIRD set of semantics, opposite to an object log row: an array is written as
 * given (index.js:541-545), and `normalizeEffortRow` resolves the OBJECT form by PROPERTY PRESENCE
 * via `effortRowFieldAliases` (`hasOwnProperty`, index.js:548-555), NOT truthiness — so a falsy
 * `session_id` is written VERBATIM rather than inheriting the top level. Reusing the log-row
 * truthiness rule here skipped exactly those values (Codex r3649591244), and the comparison must
 * use the SAME alias normalization will select: the first one PRESENT, in the map's own order.
 */
function _explicitRowSessionIds(payload) {
  const p = _isPlainObject(payload) ? payload : {};
  const found = [];
  if (Array.isArray(p.log_rows)) {
    for (const row of p.log_rows) {
      if (Array.isArray(row)) {
        // Always explicit — there is nothing to inherit from.
        if (LOG_SESSION_INDEX >= 0) found.push(_renderSessionValue(row[LOG_SESSION_INDEX]));
      } else if (_isPlainObject(row)) {
        const raw = row.session_id || row.sessionId;
        if (raw) found.push(_renderSessionValue(raw));
      }
    }
  }
  const effort = p.effort_row;
  if (Array.isArray(effort)) {
    if (EFFORT_SESSION_INDEX >= 0) found.push(_renderSessionValue(effort[EFFORT_SESSION_INDEX]));
  } else if (_isPlainObject(effort)) {
    // Presence, not truthiness — and the FIRST present alias, which is the one normalization
    // writes. An alias it would ignore must not decide the correlation. No session property at all
    // makes `normalizeEffortRow` throw before any write, so there is nothing to contaminate.
    for (const alias of EFFORT_SESSION_ALIASES) {
      if (Object.prototype.hasOwnProperty.call(effort, alias)) {
        found.push(_renderSessionValue(effort[alias]));
        break;
      }
    }
  }
  return found;
}

/**
 * Does this live payload describe the write its preview fingerprinted?
 *
 * An exact identity match, OR the one explicit permitted transition: the documented seal retry
 * DELETES `effort_row` and re-mints `write_id` for the same staged write (app.js:7566-7567). That
 * is allowed only as a REMOVAL from a preview that had one — a changed effort row, or one ADDED by
 * a live write that never previewed it, is an unpreviewed Effort append and stays refused.
 *
 * The relaxed comparison is further gated on the pairing having ALREADY accepted an exact-identity
 * write (Codex P1, r3649557072). Without that, the very FIRST live request could silently omit the
 * previewed Effort append and still be reported exactly bound, having never performed the write
 * that was previewed. The real retry cannot occur first: app.js deletes `effort_row` only after a
 * live write committed rows and returned `closeout_fully_verified:false` (app.js:7563-7567).
 *
 * Returns { matched, effortTransition } so the record can state which comparison succeeded rather
 * than leave a reviewer unable to tell an exact binding from a relaxed one.
 *
 * An unbound pairing (identity null) has nothing to check and matches trivially; it can only ever
 * report `payload_bound:false`, so it never publishes a write-level claim it cannot support.
 */
function _payloadMatchesPairing(pairing, payload) {
  const no = { matched: false, effortTransition: false };
  if (!pairing || pairing.identity === null) return { matched: true, effortTransition: false };
  if (_previewIdentity(payload) === pairing.identity) return { matched: true, effortTransition: false };
  // Only a REMOVAL, only from a preview that had one, and only after an exact write.
  if (!pairing.exactMatched) return no;
  if (pairing.identityEffortDropped === null) return no;
  if (_isPlainObject(payload) && payload.effort_row !== undefined) return no;
  if (_previewIdentity(payload, { dropEffort: true }) !== pairing.identityEffortDropped) return no;
  return { matched: true, effortTransition: true };
}

// The pairing facts a record may publish. Server-owned scalars only. Neither the TOKEN nor the
// IDENTITY digest is ever included: the token stays a live capability for the rest of the window,
// and the digest is derived from workout content.
function _pairingSummary(rec, pairing, writeId, opts = {}) {
  if (!pairing) {
    return {
      established_at_preview: false,
      write_attempt: 0,
      previewed_write_id_match: null,
      payload_bound: false,
      effort_transition: false,
    };
  }
  return {
    // true when the match came via the effort-removal transition rather than an exact identity —
    // so a reviewer can tell an exactly-bound record from a relaxed one instead of guessing.
    effort_transition: opts.effortTransition === true,
    established_at_preview: true,
    write_attempt: writeId && rec ? rec.writeIds.indexOf(writeId) + 1 : 0,
    // null = the preview carried no write_id to compare (four of the five write paths), which
    // must read as UNKNOWN and never as a match. Evidence for the reviewer, never a gate.
    previewed_write_id_match: pairing.previewedWriteId && writeId
      ? pairing.previewedWriteId === writeId
      : null,
    // true ONLY when the server fingerprinted the previewed write AND a LIVE payload has actually
    // been compared against it and matched. A PREVIEW record must therefore report false: at that
    // point no live payload exists, so a computable identity is a capability, not a match
    // (Codex r3649604170 — the code contradicted this very comment and published the write-level
    // claim on preview-only records).
    payload_bound: opts.live === true && pairing.identity !== null,
  };
}

function _evictExpired(nowMs) {
  for (const [k, rec] of registry) {
    if (nowMs - rec.atMs > DEFAULT_MAX_AGE_MS) registry.delete(k);
  }
}

function _enforceCap() {
  if (registry.size <= MAX_ENTRIES) return;
  const oldestFirst = [...registry.entries()].sort((a, b) => a[1].atMs - b[1].atMs);
  for (let i = 0; i < registry.size - MAX_ENTRIES; i += 1) registry.delete(oldestFirst[i][0]);
}

/**
 * Record that this server issued `turnId` for `sessionId`. Called by the coach route when a
 * turn opens. Ignores junk (a malformed id or a missing session never enters the registry,
 * so it can never later resolve). Bounded on every write. Never throws.
 */
function issueTurn(turnId, sessionId, opts = {}) {
  try {
    if (!isWellFormedTurnId(turnId)) return;
    const sid = _isNonEmptyString(sessionId) ? String(sessionId).trim() : '';
    if (!sid) return;
    const atMs = _now(opts);
    registry.set(String(turnId).trim(), { sessionId: sid, atMs, pairings: [], writeIds: [] });
    _evictExpired(atMs);
    _enforceCap();
  } catch (_) { /* best-effort — correlation must never surface on the write path */ }
}

/**
 * Resolve a client-carried correlation claim against the registry.
 *
 *   resolveCorrelation(payload, { sessionId, nowMs })
 *     → { ok, turn_id, reason }
 *
 * `payload` is the raw request body. Only `payload.correlation.turn_id` and
 * `payload.correlation.pairing_token` are ever read — every other key on the correlation object
 * is ignored outright, never stored and never echoed, so the envelope can grow (D10) without
 * this becoming a pass-through for client data.
 *
 * `opts.isPreview` must be passed EXPLICITLY by a dry-run call site. It is never inferred from
 * a missing write_id: a live route that forgot to pass one would then silently mint a pairing
 * for itself. The default is therefore live, which fails closed to `unpaired`.
 *
 * Returns ok:false with a naming reason for every rejection. Never throws.
 */
function resolveCorrelation(payload, opts = {}) {
  const miss = (reason) => ({ ok: false, turn_id: null, reason });
  try {
    if (!_isPlainObject(payload)) return miss(REASONS.ABSENT);
    const claim = payload.correlation;
    // No claim at all is legal — a write without correlation is an ordinary write.
    if (claim === undefined || claim === null) return miss(REASONS.ABSENT);

    // Shape gate FIRST: a malformed claim is rejected without touching the registry.
    if (!_isPlainObject(claim)) return miss(REASONS.MALFORMED);
    if (!isWellFormedTurnId(claim.turn_id)) return miss(REASONS.MALFORMED);
    const turnId = String(claim.turn_id).trim();

    const rec = registry.get(turnId);
    if (!rec) return miss(REASONS.UNKNOWN);

    // Session binding. A write with no session identity can never claim a correlation —
    // there is nothing to bind it to, so it fails as a mismatch rather than defaulting open.
    const sid = _isNonEmptyString(opts.sessionId) ? String(opts.sessionId).trim() : '';
    if (!sid || sid !== rec.sessionId) return miss(REASONS.SESSION_MISMATCH);

    // ...and the same check for every session identity the payload names BELOW its top level. A
    // row-level `session_id` beats the top-level one at write time (index.js:449), so without this
    // a request could write rows under another session while the record named this one.
    for (const rowSid of _explicitRowSessionIds(payload)) {
      if (rowSid !== rec.sessionId) return miss(REASONS.SESSION_MISMATCH);
    }

    // Freshness. Inclusive at the boundary so a legitimately slow save is not dropped.
    const nowMs = _now(opts);
    if (nowMs - rec.atMs > DEFAULT_MAX_AGE_MS) return miss(REASONS.STALE);

    const writeId = _isNonEmptyString(opts.writeId) ? String(opts.writeId).trim() : '';

    // THE PREVIEW ESTABLISHES THE PAIRING. Reached only after every gate above, so a claim the
    // server never issued, one from another session, or a stale one can never leave a pairing
    // behind for a later write to find.
    //
    // Each preview ADDS a pairing rather than replacing the last one, bounded and oldest-first
    // evicted (Codex P2): the server cannot see the client's preview initiation order, so
    // last-completion-wins would discard a token the client legitimately kept.
    if (opts.isPreview === true) {
      const pairing = {
        token: _mintPairingToken(),
        atMs: nowMs,
        // What makes this a WRITE-level binding rather than a turn-level one. Null ⇒ unbound,
        // reported honestly as payload_bound:false.
        identity: _previewIdentity(payload),
        // The same identity with `effort_row` omitted, so the documented seal retry's effort
        // REMOVAL is a permitted transition without loosening the gate for anything else.
        identityEffortDropped: _previewIdentity(payload, { dropEffort: true }),
        // Set once this pairing accepts an EXACT-identity write. The effort-removal transition is
        // legal only after that, because the real retry cannot happen before it.
        exactMatched: false,
        // The one path whose dry-run carries the write_id it will approve with. Recorded as
        // corroboration only; four of five paths send nothing here.
        previewedWriteId: _isNonEmptyString(opts.previewedWriteId) ? String(opts.previewedWriteId).trim() : null,
      };
      rec.pairings.push(pairing);
      while (rec.pairings.length > MAX_OUTSTANDING_PAIRINGS) rec.pairings.shift();
      return {
        ok: true,
        turn_id: turnId,
        reason: REASONS.OK,
        pairing_token: pairing.token,
        pairing: _pairingSummary(rec, pairing, '', { live: false }),
      };
    }

    // A LIVE WRITE MUST PRESENT A PAIRING ITS OWN PREVIEW ESTABLISHED — this is the difference
    // between "some recent turn in this session" and "this turn previewed this write".
    if (rec.pairings.length === 0) return miss(REASONS.UNPAIRED);

    // Shape gate before comparison: an unbounded or junk token is refused without ever being
    // measured against a live one.
    const claimed = claim.pairing_token;
    if (!isWellFormedPairingToken(claimed)) return miss(REASONS.PAIRING_MISMATCH);
    const pairing = rec.pairings.find(p => p.token === claimed);
    if (!pairing) return miss(REASONS.PAIRING_MISMATCH);

    // THE PAYLOAD GATE. A genuine token on a DIFFERENT write is the hole Codex found: it used to
    // resolve ok and attribute the wrong write to this turn. The live payload must fingerprint to
    // the identity the server computed at preview. An unbound pairing (identity null) has nothing
    // to check, so it correlates but can only ever report payload_bound:false.
    const match = _payloadMatchesPairing(pairing, payload);
    if (!match.matched) return miss(REASONS.PAYLOAD_MISMATCH);
    // An exact match unlocks the effort-removal transition for the retry that may follow.
    if (pairing.identity !== null && !match.effortTransition) pairing.exactMatched = true;

    // Bound the replay, per TURN. A repeat of a write_id already recorded is the SAME attempt (an
    // idempotent retry of one logical write must not be dropped); a new write_id is the next
    // attempt, which the documented seal retry legitimately needs.
    if (writeId && !rec.writeIds.includes(writeId)) {
      if (rec.writeIds.length >= MAX_WRITES_PER_PAIRING) return miss(REASONS.PAIRING_EXHAUSTED);
      rec.writeIds.push(writeId);
    }

    return {
      ok: true,
      turn_id: turnId,
      reason: REASONS.OK,
      pairing: _pairingSummary(rec, pairing, writeId, { live: true, effortTransition: match.effortTransition }),
    };
  } catch (_) {
    return miss(REASONS.MALFORMED);
  }
}

/**
 * Build the bounded correlation record joining a turn to the write it authorized.
 *
 * The proof is COPIED VERBATIM from the write response under a closed whitelist — invariants
 * W1–W3 are owner-reserved, so nothing here renames, reshapes, derives or infers a proof
 * field. Returns null without a resolved, well-formed turn id: a record that cannot name its
 * turn is not evidence.
 */
function buildWriteProofRecord(params) {
  const p = _isPlainObject(params) ? params : {};
  if (!isWellFormedTurnId(p.turnId)) return null;

  const src = _isPlainObject(p.proof) ? p.proof : {};
  const proof = {};
  for (const key of PROOF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, key) && src[key] !== undefined) {
      const v = src[key];
      // Scalars only. A nested object or array on a proof key could smuggle rows or a body
      // into the record, so it is dropped rather than serialized.
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        proof[key] = v;
      }
    }
  }

  // How the turn was bound to this write — the evidence that makes the record's claim
  // reviewable rather than asserted. Rebuilt from a closed set of server-owned scalars, so an
  // unrecognised or nested field cannot ride along, and the live pairing TOKEN never can.
  // Absent pairing evidence reads `established_at_preview:false`, never true and never missing.
  const src2 = _isPlainObject(p.pairing) ? p.pairing : {};
  const pairing = {
    established_at_preview: src2.established_at_preview === true,
    write_attempt: typeof src2.write_attempt === 'number' && Number.isFinite(src2.write_attempt)
      ? src2.write_attempt
      : 0,
    previewed_write_id_match: typeof src2.previewed_write_id_match === 'boolean'
      ? src2.previewed_write_id_match
      : null,
    payload_bound: src2.payload_bound === true,
    effort_transition: src2.effort_transition === true,
  };

  return {
    schema_version: 1,
    turn_id: String(p.turnId).trim(),
    session_id: _isNonEmptyString(p.sessionId) ? String(p.sessionId).trim() : null,
    route: _isNonEmptyString(p.route) ? String(p.route).trim() : null,
    recorded_at: _isNonEmptyString(p.recordedAt) ? p.recordedAt : new Date().toISOString(),
    pairing,
    proof,
  };
}

// One line per correlated write — a stable single-line JSON record the artifact script joins
// against `[interaction-trace]` on turn_id. Mirrors the packet/trace shadow's log discipline.
function _logRecord(record) {
  try {
    console.log(`[turn-write-proof] ${JSON.stringify(record)}`);
  } catch (_) { /* a telemetry line must never surface on the write path */ }
}

/**
 * Emit the correlation record. Gated by the same ATLAS_INTERACTION_TRACE=shadow flag as the
 * packet/trace shadow, so this adds no production surface while the shadow is off. Returns
 * the record (or null when disabled / unbuildable). Never throws.
 */
function recordWriteProof(params) {
  try {
    if (!isShadowEnabled()) return null;
    const record = buildWriteProofRecord(params);
    if (!record) return null;
    _logRecord(record);
    _log.push(record);
    if (_log.length > MAX_LOG) _log.shift();
    return record;
  } catch (_) {
    return null;
  }
}

// Read the ring buffer (newest last) for the reviewable artifact / debugging.
function recentWriteProofs() {
  return _log.map(r => ({ ...r, pairing: { ...r.pairing }, proof: { ...r.proof } }));
}

/**
 * The session identity a coach request carries, if any — ONE definition shared by every
 * turn-open site so they cannot drift apart.
 *
 * Only an EXPLICIT id counts. The plan fingerprint `coachChatSessionKey` falls back to is
 * scoping, not identity, and its own comment says it is "never a trust boundary" — so it must
 * never become one here. The precedence mirrors the existing Coach_Response capture
 * (facts.sessionId → facts.session_id → body → context) so correlation and response evidence
 * agree on which session a turn belongs to. Absent ⇒ null ⇒ the turn is never registered.
 */
function sessionIdFromRequestBody(body) {
  const b = _isPlainObject(body) ? body : {};
  const facts = _isPlainObject(b.facts) ? b.facts : {};
  const ctx = _isPlainObject(b.context) ? b.context : {};
  const raw = facts.sessionId || facts.session_id
    || b.sessionId || b.session_id
    || ctx.sessionId || ctx.session_id;
  return _isNonEmptyString(raw) ? String(raw).trim() : null;
}

// The response header carrying the turn id back to the client. A HEADER, deliberately, not a
// body field: the coach shadow's response wrapper promises to "always delegate, never alter
// the response", and every coach body shape is pinned by tests. A header hands the client the
// id without touching either.
const TURN_ID_HEADER = 'x-atlas-turn-id';

// The response header carrying a preview's pairing token back to the client (#1173 item 1).
// A header for the same reason the turn id is one: every preview and coach body shape is
// pinned by tests, and a header hands the client its capability without touching either.
// Must be CORS-exposed (middleware.js) or a cross-origin frontend would read null and the
// round-trip would silently never happen — the same trap the turn-id header had.
const PAIRING_TOKEN_HEADER = 'x-atlas-turn-pairing';

/**
 * Publish a turn to its response and register its session binding — the server half of the
 * round-trip, called where the turn opens.
 *
 * The binding is the whole trust boundary, so it is strict: the turn is registered ONLY when
 * the request carried an explicit session id. The coach request has no authoritative server
 * session today (`coachChatSessionKey` scopes the referent store to a plan FINGERPRINT and
 * says in terms that it is "never a trust boundary"), so an unbound turn must never become
 * claimable — an unregistered turn resolves `unknown` and simply yields no correlation.
 * Degrading to no-correlation is right; degrading to a guessed correlation would be evidence
 * corruption. Never throws; never alters the response body.
 */
function attachTurnToResponse(res, turnId, sessionId, opts = {}) {
  try {
    if (!isWellFormedTurnId(turnId)) return null;
    const id = String(turnId).trim();
    if (res && typeof res.setHeader === 'function' && !res.headersSent) {
      res.setHeader(TURN_ID_HEADER, id);
    }
    // Registration is what makes the id claimable. No session ⇒ no registration.
    if (_isNonEmptyString(sessionId)) issueTurn(id, sessionId, opts);
    return id;
  } catch (_) {
    return null;
  }
}

/**
 * Hand a preview's pairing token back to the client. Best-effort and header-only: it never
 * touches the response body, and a failure costs a correlation, never the write.
 */
function attachPairingToResponse(res, pairingToken) {
  try {
    if (!isWellFormedPairingToken(pairingToken)) return null;
    if (res && typeof res.setHeader === 'function' && !res.headersSent) {
      res.setHeader(PAIRING_TOKEN_HEADER, pairingToken);
    }
    return pairingToken;
  } catch (_) {
    return null;
  }
}

function _resetForTesting() {
  registry.clear();
  _log.length = 0;
}

function _sizeForTesting() {
  return registry.size;
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  MAX_ENTRIES,
  MAX_TURN_ID_LENGTH,
  TURN_ID_RE,
  TURN_ID_HEADER,
  PAIRING_TOKEN_HEADER,
  PAIRING_TOKEN_RE,
  MAX_WRITES_PER_PAIRING,
  MAX_OUTSTANDING_PAIRINGS,
  IDENTITY_EXCLUDED_FIELDS,
  PROOF_KEYS,
  REASONS,
  isWellFormedTurnId,
  isWellFormedPairingToken,
  sessionIdFromRequestBody,
  issueTurn,
  attachTurnToResponse,
  attachPairingToResponse,
  resolveCorrelation,
  buildWriteProofRecord,
  recordWriteProof,
  recentWriteProofs,
  _resetForTesting,
  _sizeForTesting,
};
