'use strict';

// Durable capture of the FINAL message actually rendered to the athlete — the
// companion to Coach_Response's server-stage record (issue #1124).
//
// Coach_Response records what the server RETURNED (model output / silence /
// suppression). The client may replace silence or a suppressed line with a
// deterministic engine/template line AFTER the response returns, so the server
// row can say `visible_message_present=FALSE` while the athlete reads a line.
// This tab records the client's final rendered truth, correlated by the SAME
// canonical turn_id, so both truths survive side by side:
//
//   • Coach_Response — server-stage truth (model/suppression, never replaced).
//   • Coach_Render   — final-render truth (exact bounded text shown on screen,
//     its source/kind, and whether client deterministic rendering replaced the
//     server-visible result).
//
// A render record is written ONLY when the rendered outcome diverges from the
// server-stage record (client rendered a line the server did not show, the
// client dropped a visible server line, or the client extended the server
// message). Agreement cases keep exactly one correlated record and no duplicate.
//
// Same discipline as coachResponseSheet.js: append-only, queued off the served
// path, best-effort, deduped by turn_id (a retried or double-rendered turn
// appends once), header-mismatch fails closed. Synthetic containment (owner
// ruling 2026-07-31): a synthetic turn never lands a row.
//
// PRIVACY / SIZE: stores only the athlete-facing rendered text and its shape —
// the final text, its source/kind, presence flags, session/route/turn
// identifiers, and app/build tag. It NEVER stores prompts, chain-of-thought,
// request bodies, secrets, cookies, or auth headers. The final text is
// length-bounded; source/kind are allowlisted (no free text reaches the sheet).

const RENDER_TAB = 'Coach_Render';
const RENDER_HEADERS = Object.freeze([
  'recorded_at',
  'turn_id',
  'session_id',
  'route',
  'final_message_present',
  'final_message',
  'final_source',
  'final_kind',
  'replaced_server_visible',
  'server_visible_present',
  'app_version',
]);

// The client-asserted producer of the final rendered text. 'llm' is the model
// message shown unchanged; the deterministic sources are the client fallbacks
// that replace silence/suppression; 'none' is an explicit no-visible-message
// render (the client dropped a visible server line).
const FINAL_SOURCES = Object.freeze([
  'llm',
  'deterministic_wrap',
  'voice_primary_line',
  'templated_opener',
  'templated_fallback',
  'none',
]);

// The coach-turn kinds that can produce a rendered message.
const FINAL_KINDS = Object.freeze(['set', 'block', 'plan', 'chat', 'ask']);

const { isWellFormedTurnId } = require('./turnCorrelation');

const MAX_MESSAGE_CHARS = 4000; // bound the stored final text (coach lines are short)
const MAX_FIELD_CHARS = 256;    // bound short string fields
const MAX_SEEN = 1000;          // dedup ring bound
const REVALIDATE_EVERY = 50;    // re-check the header at least this often (bounded staleness)

let _append = null;
let _ensure = null;
let _getHeader = null;
let _ready = null;
let _tail = Promise.resolve();
const _seen = new Set(); // turn_ids already queued — dedup across retries/re-renders
let _buildTag; // cached server build tag (lazy)
let _appendsSinceValidate = 0;
let _revalidateEvery = REVALIDATE_EVERY;

function _clip(value, max) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function _bool(value) {
  return value === true ? 'TRUE' : 'FALSE';
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
    if (b.pr !== null && b.pr !== undefined) _buildTag = `PR #${b.pr}`;
    else if (commit) _buildTag = commit.slice(0, 12);
  } catch (_) { _buildTag = ''; }
  return _buildTag;
}

// Build one Coach_Render row, or null when the report is not valid. Validation is
// fail-closed: a malformed turn_id, a non-string message, a non-allowlisted
// source/kind, or a non-boolean flag never becomes a row — the caller must never
// mint an unrelated render ID or persist attacker-chosen free text as a source.
function buildRow(params) {
  const p = params && typeof params === 'object' ? params : {};
  const turnId = typeof p.turnId === 'string' ? p.turnId.trim() : '';
  if (!isWellFormedTurnId(turnId)) return null;
  if (typeof p.finalMessage !== 'string') return null;
  if (!FINAL_SOURCES.includes(p.finalSource)) return null;
  if (!FINAL_KINDS.includes(p.finalKind)) return null;
  if (typeof p.replacedServerVisible !== 'boolean' || typeof p.serverVisiblePresent !== 'boolean') return null;

  const message = p.finalMessage;
  const messagePresent = !!(message && message.trim());
  const appVersion = (p.appVersion !== null && p.appVersion !== undefined && String(p.appVersion).trim()) ? p.appVersion : _serverBuildTag();

  return [
    typeof p.recordedAt === 'string' && p.recordedAt ? p.recordedAt : new Date().toISOString(),
    _clip(turnId, MAX_FIELD_CHARS),
    _clip(p.sessionId, MAX_FIELD_CHARS),
    _clip(p.route || '/api/coach/message', MAX_FIELD_CHARS),
    _bool(messagePresent),
    _clip(messagePresent ? message : '', MAX_MESSAGE_CHARS),
    _clip(p.finalSource, MAX_FIELD_CHARS),
    _clip(p.finalKind, MAX_FIELD_CHARS),
    _bool(p.replacedServerVisible),
    _bool(p.serverVisiblePresent),
    _clip(appVersion, MAX_FIELD_CHARS),
  ];
}

function validateHeaders(actualHeader) {
  const actual = Array.isArray(actualHeader) ? actualHeader : [];
  const mismatches = [];
  const width = Math.max(actual.length, RENDER_HEADERS.length);
  for (let i = 0; i < width; i += 1) {
    const expected = i < RENDER_HEADERS.length ? RENDER_HEADERS[i] : null;
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
      .then(() => ensure(RENDER_TAB, RENDER_HEADERS))
      .then(() => getHeader(RENDER_TAB))
      .then((actualHeader) => {
        const validation = validateHeaders(actualHeader);
        if (!validation.ok) {
          const first = validation.mismatches[0];
          throw new Error(`Coach_Render header mismatch at column ${first.index + 1}: expected ${first.expected || '<none>'}, found ${first.actual || '<blank>'}`);
        }
      })
      .catch((error) => { _ready = null; throw error; });
  }
  return _ready;
}

// Queue one durable final-render record without entering the served response path.
// A failed append is logged once and swallowed. Deduped by turn_id so a retry
// never doubles a row. Returns the row, or null when the report is invalid,
// synthetic, or already captured.
function persist(params) {
  const p = params && typeof params === 'object' ? params : {};

  // SYNTHETIC CONTAINMENT (owner ruling, 2026-07-31). See the matching guard in
  // services/coachResponseSheet.js. Coach_Render stores the VISIBLE coach reply
  // text, so a synthetic turn does not merely add a row — it puts fabricated
  // conversation into the owner's review record. Gated on a positive synthetic
  // identification; `unknown` still persists so genuine-but-unclassified owner
  // turns are never lost. Returns before `_seen` is touched, so suppressing a
  // synthetic turn can never mask a later genuine one.
  if (p.synthetic === true) return null;

  const row = buildRow(p);
  if (!row) return null;

  const turnId = row[1];

  // Unit/route tests enable the shadow flag but must never touch a real spreadsheet. An
  // injected writer (via _resetForTesting) opts a test into this persistence path.
  if (!_append && _isNodeTestRuntime()) return row;

  if (_seen.has(turnId)) return null; // already captured this turn
  _seen.add(turnId);
  if (_seen.size > MAX_SEEN) { const first = _seen.values().next().value; _seen.delete(first); }

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
      await append(RENDER_TAB, [row]);
      _appendsSinceValidate += 1;
    })
    .catch((error) => {
      const message = error && error.message ? error.message : String(error || 'unknown error');
      try { console.warn(`[coach-render-sheet] append failed: ${message}`); } catch (_) { /* best-effort */ }
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
  RENDER_TAB,
  RENDER_HEADERS,
  FINAL_SOURCES,
  FINAL_KINDS,
  MAX_MESSAGE_CHARS,
  buildRow,
  validateHeaders,
  persist,
  _flushForTesting,
  _resetForTesting,
};
