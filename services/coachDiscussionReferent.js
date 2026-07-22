'use strict';

// Server-side, in-memory "last-discussed lift" per chat session — the interim backing for
// the disputed-lift resolver's tier 2 (services/coachResponseGrounding.resolveDisputedLiftEntry).
//
// WHY: a bare correction ("That isn't what you planned. You planned 3 sets at 6 reps.")
// omits the lift name. #1126 recovered the referent from the athlete's own prior turns,
// but missed the case where ATLAS named the lift and the athlete did not — e.g.
// "what's next?" → Atlas answers "Bench Press…" → "that isn't what you planned." The route
// records the lift it just grounded an answer about (a next-up answer, a "why did you…"
// explanation narrowed to one lift, or a dispute answer) here, keyed by session, and reads
// it back — freshness-bounded — on a later bare dispute to seed the resolver.
//
// TRUST: this is NOT client-trusted. Only the route writes it, and only from a lift the
// SERVER resolved from the current plan; the resolver reads the value the route injects,
// never a client-sent context field. It is ephemeral (never a Sheet or durable record) and
// is OVERWRITTEN on every new discussion, so it always holds the MOST RECENT referent.
//
// FRESHNESS: `readFreshDiscussedLift` returns the referent only when the record is recent
// (default 8 minutes — a live-workout "we were just talking about this" window) and for the
// same session id. A stale confident answer is worse than asking, so an expired record
// yields null and the resolver falls through to its bounded history scan / fails closed.
//
// PERMANENT VERSION (Phase 4 punch list): discussion-referent becomes a
// CoachTurnPacket/WorkoutSession field set at answer time, collapsing this whole module +
// resolver to a single state read. See docs/ATLAS_V1_EXECUTION_PLAN.md.

// A live-workout "we were just discussing this lift" window.
const DEFAULT_MAX_AGE_MS = 8 * 60 * 1000;

// sessionId -> { canonicalKey, turnId, atMs }
const store = new Map();

function asKey(v) {
  return v == null ? '' : String(v);
}

// Record the lift a grounded answer was just about. `canonicalKey` is the plan entry's
// canonical key (coachResponseGrounding.canonicalKey). `opts.turnId` is stored for the
// divergence shadow + the Phase-4 migration; `opts.nowMs` lets callers/tests pass an
// explicit clock (defaults to Date.now()). No-op if session or key is missing.
function recordDiscussedLift(sessionId, canonicalKey, opts = {}) {
  const sid = asKey(sessionId);
  const key = asKey(canonicalKey);
  if (!sid || !key) return;
  const atMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  store.set(sid, { canonicalKey: key, turnId: opts.turnId != null ? String(opts.turnId) : null, atMs });
}

// Read the session's last-discussed lift IF it is fresh (within maxAgeMs). Returns the
// stored canonical key, or null when absent/stale. Never throws.
function readFreshDiscussedLift(sessionId, opts = {}) {
  const sid = asKey(sessionId);
  if (!sid) return null;
  const rec = store.get(sid);
  if (!rec) return null;
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const maxAgeMs = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  if (nowMs - rec.atMs > maxAgeMs) return null;
  return rec.canonicalKey;
}

// The full record (canonicalKey, turnId, atMs) without a freshness check — for the
// divergence shadow comparison and debugging. Returns null when absent.
function peekRecord(sessionId) {
  const rec = store.get(asKey(sessionId));
  return rec ? { ...rec } : null;
}

function _resetForTesting() {
  store.clear();
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  recordDiscussedLift,
  readFreshDiscussedLift,
  peekRecord,
  _resetForTesting,
};
