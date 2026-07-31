'use strict';

// Durable capture of the FINAL visible coach response — the companion to the Coach_Shadow
// presence-flag mirror. Coach_Shadow records THAT a response happened (flags only); this
// records WHAT was actually returned to the athlete, so a production turn can be reviewed
// for coaching quality and validator suppression. It is written at the SAME shadow seam,
// keyed by the SAME turn_id, so every Coach_Shadow row has a matching Coach_Response row.
//
// Observational only: the coach response never waits for or depends on this append. The
// append is queued off the served path, best-effort, deduped by turn_id (a retried or
// double-finished turn appends once), and preserves turn order. A header mismatch fails
// closed (no row lands under the wrong labels). Persistence failures are logged once and
// swallowed so telemetry can never fail coaching.
//
// PRIVACY / SIZE: stores only the athlete-facing output and its shape — the visible text,
// its source/kind, presence, an explicit suppression state, session/route/turn identifiers,
// and app/build tag. It NEVER stores prompts, chain-of-thought, request bodies, secrets,
// cookies, or auth headers. The visible text is length-bounded; short fields are clipped.

const RESPONSE_TAB = 'Coach_Response';
const RESPONSE_HEADERS = Object.freeze([
  'recorded_at',
  'turn_id',
  'session_id',
  'route',
  'intent_type',
  'visible_source',
  'visible_kind',
  'visible_message_present',
  'visible_message',
  'suppressed',
  'suppression_reason',
  'app_version',
  'visible_error',
]);

const { formatSuppressionReason, isValidatorSuppressed } = require('./suppressionReason');

const MAX_MESSAGE_CHARS = 4000; // bound the stored visible text (coach lines are short)
const MAX_FIELD_CHARS = 256;    // bound short string fields
const MAX_SEEN = 1000;          // dedup ring bound
const REVALIDATE_EVERY = 50;    // re-check the header at least this often (bounded staleness)

let _append = null;
let _ensure = null;
let _getHeader = null;
let _ready = null;
let _tail = Promise.resolve();
const _seen = new Set(); // turn_ids already queued — dedup across retries/double-finish
let _buildTag; // cached server build tag (lazy)
let _appendsSinceValidate = 0;
let _revalidateEvery = REVALIDATE_EVERY;

function _clip(value, max) {
  if (value == null) return '';
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function _bool(value) {
  return value === true ? 'TRUE' : 'FALSE';
}

// Explicit silence-vs-suppression classification so a quiet turn is never indistinguishable
// from missing data. Derived from the response the athlete received, not from internals.
//
// `suppressionCode` is the fixed enum code the SUPPRESSION POINT reported (see
// services/suppressionReason.js). It only refines the coarse `validator_suppressed` value
// into `validator_suppressed:<code>` — it never changes WHETHER a turn counts as
// suppressed. A missing or unrecognized code fails closed to `validator_suppressed:unknown`,
// so no arbitrary text can be persisted through this path.
function deriveSuppression(modelStatus, messagePresent, configured, suppressionCode) {
  if (modelStatus === 'error') return { suppressed: false, reason: 'model_error_fallback' };
  if (configured === false) return { suppressed: false, reason: 'outage_fallback' };
  if (modelStatus === 'ok') {
    return messagePresent
      ? { suppressed: false, reason: '' }
      // The model produced a line; a validator nulled it. The code names which one.
      : { suppressed: true, reason: formatSuppressionReason(suppressionCode) };
  }
  // model skipped, coach configured
  return messagePresent
    ? { suppressed: false, reason: 'templated_fallback' }
    : { suppressed: false, reason: 'deliberate_silence' }; // routine block met with intended silence
}

// The deployed build tag, read once from public/build-info.json (+ RENDER_GIT_COMMIT).
// Best-effort and never throws — used only as a fallback when the client sent no appVersion.
function _serverBuildTag() {
  if (_buildTag !== undefined) return _buildTag;
  _buildTag = '';
  try {
    const { readBuildInfo } = require('./buildInfo');
    const b = readBuildInfo() || {};
    const commit = (process.env.RENDER_GIT_COMMIT || b.commit || '').toString().trim();
    if (b.pr != null) _buildTag = `PR #${b.pr}`;
    else if (commit) _buildTag = commit.slice(0, 12);
  } catch (_) { _buildTag = ''; }
  return _buildTag;
}

function buildRow(params) {
  const p = params && typeof params === 'object' ? params : {};
  const body = p.visible && typeof p.visible === 'object' ? p.visible : {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const msg = typeof data.message === 'string' ? data.message : null;
  const messagePresent = !!(msg && msg.trim());
  const configured = data.configured === true ? true : (data.configured === false ? false : null);
  const { suppressed, reason } = deriveSuppression(p.modelStatus, messagePresent, configured, p.suppressionCode);
  const appVersion = (p.appVersion != null && String(p.appVersion).trim()) ? p.appVersion : _serverBuildTag();

  return [
    typeof p.recordedAt === 'string' && p.recordedAt ? p.recordedAt : new Date().toISOString(),
    _clip(p.turnId, MAX_FIELD_CHARS),
    _clip(p.sessionId, MAX_FIELD_CHARS),
    _clip(p.route, MAX_FIELD_CHARS),
    _clip(p.intentType, MAX_FIELD_CHARS),
    _clip(typeof data.source === 'string' ? data.source : '', MAX_FIELD_CHARS),
    _clip(typeof data.kind === 'string' ? data.kind : '', MAX_FIELD_CHARS),
    _bool(messagePresent),
    _clip(messagePresent ? msg : '', MAX_MESSAGE_CHARS),
    _bool(suppressed),
    _clip(reason, MAX_FIELD_CHARS),
    _clip(appVersion, MAX_FIELD_CHARS),
    _bool(!!data.error),
  ];
}

function validateHeaders(actualHeader) {
  const actual = Array.isArray(actualHeader) ? actualHeader : [];
  const mismatches = [];
  const width = Math.max(actual.length, RESPONSE_HEADERS.length);
  for (let i = 0; i < width; i += 1) {
    const expected = i < RESPONSE_HEADERS.length ? RESPONSE_HEADERS[i] : null;
    const value = i < actual.length ? String(actual[i]) : null;
    if (value !== expected) mismatches.push({ index: i, expected, actual: value });
  }
  return { ok: mismatches.length === 0, mismatches };
}

function _isNodeTestRuntime() {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
}

async function _ensureReady(ensure, getHeader) {
  if (!_ready) {
    _ready = Promise.resolve()
      .then(() => ensure(RESPONSE_TAB, RESPONSE_HEADERS))
      .then(() => getHeader(RESPONSE_TAB))
      .then((actualHeader) => {
        const validation = validateHeaders(actualHeader);
        if (!validation.ok) {
          const first = validation.mismatches[0];
          throw new Error(`Coach_Response header mismatch at column ${first.index + 1}: expected ${first.expected || '<none>'}, found ${first.actual || '<blank>'}`);
        }
      })
      .catch((error) => { _ready = null; throw error; });
  }
  return _ready;
}

// Queue one durable response record without entering the served response path. A failed
// append is logged once and swallowed. Deduped by turn_id so a retry never doubles a row.
function persist(params) {
  const p = params && typeof params === 'object' ? params : {};

  // SYNTHETIC CONTAINMENT (owner ruling, 2026-07-31). See the matching guard in
  // services/coachShadowSheet.js. Coach_Response stores the VISIBLE coach reply
  // text, so a synthetic turn does not merely add a row — it puts fabricated
  // conversation into the owner's review record. The 2026-07-31 live-retest run
  // appended rows 84–85 that way. Gated on a positive synthetic identification;
  // `unknown` still persists so genuine-but-unclassified owner turns are never lost.
  // Returns before `_seen` is touched, so suppressing a synthetic turn can never
  // mask a later genuine one.
  if (p.synthetic === true) return null;

  const turnId = p.turnId != null ? String(p.turnId) : '';
  if (turnId && _seen.has(turnId)) return null; // already captured this turn
  const row = buildRow(p);

  // Unit/route tests enable the shadow flag but must never touch a real spreadsheet. An
  // injected writer (via _resetForTesting) opts a test into this persistence path.
  if (!_append && _isNodeTestRuntime()) return row;

  if (turnId) {
    _seen.add(turnId);
    if (_seen.size > MAX_SEEN) { const first = _seen.values().next().value; _seen.delete(first); }
  }

  _tail = _tail
    .catch(() => {})
    .then(async () => {
      const sheets = (!_append || !_ensure || !_getHeader) ? require('../sheets') : null;
      const ensure = _ensure || sheets.ensureSheetTab;
      const getHeader = _getHeader || sheets.getHeaderRow;
      const append = _append || sheets.appendRows;
      // Periodically re-validate the header so a post-startup column edit (reorder/delete)
      // is caught within a bounded window and fails closed, instead of silently landing
      // values under the wrong labels for the whole process lifetime. Costs ~1 read per
      // REVALIDATE_EVERY turns — not a read on every turn (the codebase's quota-conscious
      // Sheets discipline). The primary review evidence is the text, so this is worth it.
      if (_appendsSinceValidate >= _revalidateEvery) { _ready = null; _appendsSinceValidate = 0; }
      await _ensureReady(ensure, getHeader);
      await append(RESPONSE_TAB, [row]);
      _appendsSinceValidate += 1;
    })
    .catch((error) => {
      const message = error && error.message ? error.message : String(error || 'unknown error');
      try { console.warn(`[coach-response-sheet] append failed: ${message}`); } catch (_) { /* best-effort */ }
    });

  return row;
}

function _flushForTesting() {
  return _tail;
}

function _resetForTesting({ append, ensure, getHeader, revalidateEvery } = {}) {
  _append = typeof append === 'function' ? append : null;
  _ensure = typeof ensure === 'function' ? ensure : null;
  _getHeader = typeof getHeader === 'function' ? getHeader : null;
  _ready = null;
  _tail = Promise.resolve();
  _seen.clear();
  _buildTag = undefined;
  _appendsSinceValidate = 0;
  _revalidateEvery = (typeof revalidateEvery === 'number' && revalidateEvery > 0) ? revalidateEvery : REVALIDATE_EVERY;
}

module.exports = {
  RESPONSE_TAB,
  RESPONSE_HEADERS,
  MAX_MESSAGE_CHARS,
  deriveSuppression,
  // Re-exported so a consumer grouping suppressions has ONE correct predicate that
  // recognizes both the historical exact value and every validator_suppressed:* value.
  isValidatorSuppressed,
  buildRow,
  validateHeaders,
  persist,
  _flushForTesting,
  _resetForTesting,
};
