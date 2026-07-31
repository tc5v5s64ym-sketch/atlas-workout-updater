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
const { normalizeEvidenceClass, normalizeRequestOrigin, EVIDENCE_CLASSES, SYNTHETIC_ORIGINS } = require('./evidenceProvenance');

const RING_MAX = 50;
const PREVIEW_CHARS = 80;

// Dedicated diagnostics tab (owner direction 2026-07-03: "review the shadow"
// without debug JSON). NOT one of the trust-contract tabs and NOT training data —
// an offline owner/agent review surface only, appended best-effort. Columns
// (append order):
//   captured_at | message_preview | intent_type | confidence |
//   constraint_keys_json | dropped_keys_json | ok | latency_ms |
//   source | route | app_version | review_status | review_notes |
//   evidence_class | evidence_eligible | request_origin   ← PR-GATEA1 (appended)
// The three GATE-A provenance columns are appended to the END; the 13 existing
// columns are never reordered or reinterpreted. Old 13-column rows read back as
// evidence_class=unknown / evidence_eligible=FALSE (see services/evidenceProvenance.js).
const SHADOW_TAB = 'Intent_Shadow';

let _ring = [];                 // newest first
let _classify = classifyIntent; // injectable for unit tests
let _append = null;             // injectable Sheets appendRows; lazy-required otherwise

function isShadowEnabled() {
  return process.env.ATLAS_INTENT_ROUTER === 'shadow';
}

function _push(entry) {
  _ring.unshift(entry);
  if (_ring.length > RING_MAX) _ring.length = RING_MAX;
}

// Record one entry: the in-memory ring (diagnostics endpoint), a console line, and
// a BEST-EFFORT append to the Intent_Shadow Sheet tab. The Sheet mirror is the
// only durable copy — the ring resets on deploy — so the owner reviews the tab,
// not the debug JSON.
function _record(entry, meta) {
  _push(entry);
  try { console.log(`[intent-shadow] ${JSON.stringify(entry)}`); } catch { /* log-only */ }
  _persistRow(entry, meta || {});
}

// Mirror one diagnostic entry to the Intent_Shadow tab. BEST-EFFORT and TOTAL:
// fire-and-forget, self-swallowing — a missing tab, absent Sheets creds, or a
// transient error is silently ignored so the caller (coach/chat/log/save) can
// NEVER be blocked or failed by shadow persistence. Touches no workout tab or
// write path; this is diagnostics, not a logged set.
function _persistRow(entry, meta) {
  // SYNTHETIC QUOTA CONTAINMENT (owner ruling 2026-07-31). A request that DECLARES a
  // synthetic origin (agent / CI / Playwright) does not mirror to the Sheet.
  //
  // These rows were correctly TAGGED (evidence_class=synthetic, evidence_eligible=FALSE)
  // and were never mistaken for owner evidence — the problem is VOLUME, not honesty.
  // In live-retest run 30596164330 the synthetic shadow mirror exhausted the Google
  // Sheets per-minute quota (150 quota-exceeded events; Brain_Shadow alone 126), which
  // degraded PRODUCTION traffic: /api/plan/today 19.5 s, /api/recommend/next 38.6 s, and
  // HTTP 500 on /api/history/recent and /api/summary/weekly. Owner-facing requests were
  // collateral damage of agent telemetry.
  //
  // The in-memory ring and the console line are KEPT: they are free, they are what the
  // debug endpoint and the divergence tooling read, and they touch no quota. Only the
  // Sheet mirror is skipped. Owner traffic is completely unaffected.
  const _ev = (meta && typeof meta.evidence === 'object' && meta.evidence) ? meta.evidence : {};
  if (SYNTHETIC_ORIGINS.has(normalizeRequestOrigin(_ev.request_origin))) return;

  Promise.resolve()
    .then(() => {
      const append = _append || require('../sheets').appendRows;
      // PR-GATEA1 — provenance verdict (from the observe route) re-normalized here,
      // failing closed: missing/malformed → unknown, ineligible; request_origin
      // bounded to a safe token. Telemetry only; never a served field.
      const ev = (meta.evidence && typeof meta.evidence === 'object') ? meta.evidence : {};
      const evidence_class = normalizeEvidenceClass(ev.evidence_class);
      const row = [
        entry.at || '',
        entry.message_preview || '',
        entry.type || '',
        entry.confidence != null ? entry.confidence : '',
        JSON.stringify(entry.constraint_keys || []),
        JSON.stringify(entry.dropped_keys || []),
        entry.ok === true ? 'TRUE' : 'FALSE',
        entry.ms != null ? entry.ms : '',
        meta.source || 'chat',
        meta.route || 'composer',
        meta.appVersion || '',
        '',   // review_status — filled by the owner/agent during review
        '',    // review_notes
        // PR-GATEA1 provenance — appended to the END; existing columns untouched.
        evidence_class || EVIDENCE_CLASSES.UNKNOWN,
        evidence_class === EVIDENCE_CLASSES.ATHLETE_UI ? 'TRUE' : 'FALSE',
        normalizeRequestOrigin(ev.request_origin) || '',
      ];
      return append(SHADOW_TAB, [row]);
    })
    .catch(() => { /* best-effort: persistence failure must never surface */ });
}

// Fire-and-forget: synchronous no-op when the flag is off; when on, the
// classification runs OFF the reply path — the chat handler never awaits it,
// and no outcome (including an unexpected throw) can surface to the lifter.
function observeChatMessage(message, meta = {}) {
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
      _record(entry, meta);
    })
    .catch(() => {
      // classifyIntent is TOTAL (resolves null on any failure), so this is
      // belt-and-braces — the shadow lane must never create a failure. An ok:false
      // row is still persisted so classification failures are captured too.
      _record({ at: new Date().toISOString(), ms: Date.now() - startedAt, message_preview: text.slice(0, PREVIEW_CHARS), ok: false }, meta);
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

function _resetForTesting({ classify, append } = {}) {
  _ring = [];
  _classify = typeof classify === 'function' ? classify : classifyIntent;
  _append = typeof append === 'function' ? append : null;
}

module.exports = {
  RING_MAX,
  SHADOW_TAB,
  isShadowEnabled,
  observeChatMessage,
  getShadowLog,
  _resetForTesting,
};
