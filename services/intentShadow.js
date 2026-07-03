'use strict';

// Intent-router SHADOW lane — Phase C2 of the Composer-First Migration
// (owner-approved 2026-07-03). Staged exactly like ATLAS_COACH_ENGINE:
// a default-OFF env flag, observability first, promotion only on evidence.
//
//   ATLAS_INTENT_ROUTER unset (default) → this module is inert: no router
//   call, no network, no log. The chat route behaves byte-identically.
//
//   ATLAS_INTENT_ROUTER=shadow → each chat message is ALSO classified by
//   services/intentRouter (fire-and-forget, never awaited on the reply
//   path), and the outcome is recorded to a capped in-memory ring + one
//   console line. NOTHING executes from the classification: no reply
//   change, no Sheets access, no write. The ring is served read-only by
//   GET /api/debug/intent-shadow (auth-gated) so the owner can judge the
//   router's accuracy on real traffic before any promotion decision.
//
// The ring is in-memory ON PURPOSE (Atlas has no database; Sheets is the
// permanent record for TRAINING data, and shadow diagnostics are not
// training data — they reset on deploy/restart, which is the right
// lifetime for a calibration log).

const { classifyIntent } = require('./intentRouter');

const RING_MAX = 50;
const PREVIEW_CHARS = 80;

let _ring = [];                 // newest first
let _classify = classifyIntent; // injectable for unit tests

function isShadowEnabled() {
  return process.env.ATLAS_INTENT_ROUTER === 'shadow';
}

function _push(entry) {
  _ring.unshift(entry);
  if (_ring.length > RING_MAX) _ring.length = RING_MAX;
}

// Fire-and-forget: synchronous no-op when the flag is off; when on, the
// classification runs OFF the reply path — the chat handler never awaits it,
// and no outcome (including an unexpected throw) can surface to the lifter.
function observeChatMessage(message) {
  if (!isShadowEnabled()) return;
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return;
  const startedAt = Date.now();
  Promise.resolve()
    .then(() => _classify(text, { source: 'chat' }))
    .then(envelope => {
      const entry = {
        at: new Date().toISOString(),
        ms: Date.now() - startedAt,
        message_preview: text.slice(0, PREVIEW_CHARS),
        ok: Boolean(envelope),
      };
      if (envelope) {
        entry.type = envelope.type;
        entry.confidence = envelope.extraction && envelope.extraction.confidence;
        entry.constraint_keys = Object.keys(envelope.constraints || {});
        if (envelope.extraction && envelope.extraction.dropped_keys) {
          entry.dropped_keys = envelope.extraction.dropped_keys;
        }
      }
      _push(entry);
      try { console.log(`[intent-shadow] ${JSON.stringify(entry)}`); } catch { /* log-only */ }
    })
    .catch(() => {
      // classifyIntent is TOTAL (resolves null on any failure), so this is
      // belt-and-braces — the shadow lane must never create a failure.
      _push({ at: new Date().toISOString(), ms: Date.now() - startedAt, message_preview: text.slice(0, PREVIEW_CHARS), ok: false });
    });
}

// Read-only snapshot for GET /api/debug/intent-shadow.
function getShadowLog() {
  return {
    enabled: isShadowEnabled(),
    ring_max: RING_MAX,
    count: _ring.length,
    entries: _ring.slice(),
  };
}

function _resetForTesting({ classify } = {}) {
  _ring = [];
  _classify = typeof classify === 'function' ? classify : classifyIntent;
}

module.exports = {
  RING_MAX,
  isShadowEnabled,
  observeChatMessage,
  getShadowLog,
  _resetForTesting,
};
