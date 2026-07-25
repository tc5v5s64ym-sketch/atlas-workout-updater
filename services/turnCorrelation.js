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

const { isShadowEnabled } = require('./interactionTraceShadow');

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
const REASONS = Object.freeze({
  OK: 'ok',
  ABSENT: 'absent',
  MALFORMED: 'malformed',
  UNKNOWN: 'unknown',
  SESSION_MISMATCH: 'session_mismatch',
  STALE: 'stale',
  WRITE_MISMATCH: 'write_mismatch',
});

// turnId -> { sessionId, atMs, writeId? }  (writeId set on first correlated real write)
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
    registry.set(String(turnId).trim(), { sessionId: sid, atMs });
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
 * `payload` is the raw request body. Only `payload.correlation.turn_id` is ever read — every
 * other key on the correlation object is ignored outright, never stored and never echoed, so
 * the envelope can grow (D10) without this becoming a pass-through for client data.
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

    // Freshness. Inclusive at the boundary so a legitimately slow save is not dropped.
    const age = _now(opts) - rec.atMs;
    if (age > DEFAULT_MAX_AGE_MS) return miss(REASONS.STALE);

    // WRITE BINDING — the difference between "some recent turn in this session" and "THIS
    // turn authorized THIS write". Without it a single id could be replayed against every
    // save in the window, and the record would claim more than it establishes.
    //
    // A dry-run carries no write_id: it is a preview, not the authorized write, so it may
    // correlate but never binds or retires the turn — the approve that follows still needs it.
    // A real write binds the turn to its write_id on first use. After that the turn answers
    // ONLY to that write_id: a different one is refused (a second write is a second turn's
    // business), while the same one may correlate again so an idempotent retry of the same
    // logical write is not silently dropped.
    const writeId = _isNonEmptyString(opts.writeId) ? String(opts.writeId).trim() : '';
    if (writeId) {
      if (rec.writeId && rec.writeId !== writeId) return miss(REASONS.WRITE_MISMATCH);
      if (!rec.writeId) rec.writeId = writeId;
    }

    return { ok: true, turn_id: turnId, reason: REASONS.OK };
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

  return {
    schema_version: 1,
    turn_id: String(p.turnId).trim(),
    session_id: _isNonEmptyString(p.sessionId) ? String(p.sessionId).trim() : null,
    route: _isNonEmptyString(p.route) ? String(p.route).trim() : null,
    recorded_at: _isNonEmptyString(p.recordedAt) ? p.recordedAt : new Date().toISOString(),
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
  return _log.map(r => ({ ...r, proof: { ...r.proof } }));
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
  PROOF_KEYS,
  REASONS,
  isWellFormedTurnId,
  sessionIdFromRequestBody,
  issueTurn,
  attachTurnToResponse,
  resolveCorrelation,
  buildWriteProofRecord,
  recordWriteProof,
  recentWriteProofs,
  _resetForTesting,
  _sizeForTesting,
};
