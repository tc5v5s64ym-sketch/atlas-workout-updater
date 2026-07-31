'use strict';

// Durable mirror for the Phase-3 CoachTurnPacket shadow. The live coach response
// never waits for this path: persistence is queued off-path, best-effort, and may
// only touch the dedicated Coach_Shadow diagnostics tab.

const SHADOW_TAB = 'Coach_Shadow';
const SHADOW_HEADERS = Object.freeze([
  'recorded_at',
  'turn_id',
  'intent_type',
  'source',
  'packet_valid',
  'packet_errors',
  'athlete_profile_goal',
  'session',
  'exercises',
  'decision',
  'safety',
  'closeout',
  'trace_valid',
  'trace_stages',
  'trace_missing',
  'visible_message_present',
  'visible_source',
  'visible_kind',
  'visible_error',
]);

let _append = null;
let _ensure = null;
let _getHeader = null;
let _ready = null;
let _tail = Promise.resolve();

function _json(value, empty = '') {
  if (value == null) return empty;
  try { return JSON.stringify(value); } catch (_) { return empty; }
}

function _bool(value, emptyWhenUnknown = false) {
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  return emptyWhenUnknown ? '' : 'FALSE';
}

function buildRow(params) {
  const p = params && typeof params === 'object' ? params : {};
  const assembled = p.assembled && typeof p.assembled === 'object' ? p.assembled : {};
  const packet = assembled.packet && typeof assembled.packet === 'object' ? assembled.packet : null;
  const traceRecord = p.trace && typeof p.trace === 'object' && p.trace.trace ? p.trace : null;
  const trace = traceRecord && traceRecord.trace && typeof traceRecord.trace === 'object'
    ? traceRecord.trace
    : null;
  const visible = p.visible && typeof p.visible === 'object' ? p.visible : {};
  const stages = trace && Array.isArray(trace.stages)
    ? trace.stages.map((stage) => ({ stage: stage.stage, status: stage.status }))
    : [];
  const turnId = packet && packet.turn_id != null
    ? packet.turn_id
    : (trace && trace.turn_id != null ? trace.turn_id : '');

  return [
    typeof p.recordedAt === 'string' && p.recordedAt ? p.recordedAt : new Date().toISOString(),
    turnId || '',
    traceRecord && traceRecord.intent_type != null ? traceRecord.intent_type : '',
    traceRecord && traceRecord.source != null ? traceRecord.source : '',
    _bool(assembled.valid === true),
    _json(Array.isArray(assembled.errors) ? assembled.errors.slice(0, 10) : [], '[]'),
    packet && packet.athlete && packet.athlete.profile_goal != null ? packet.athlete.profile_goal : '',
    packet && packet.session != null ? _json(packet.session) : '',
    _json(packet && Array.isArray(packet.exercises) ? packet.exercises : [], '[]'),
    packet && packet.decision != null ? _json(packet.decision) : '',
    packet && packet.safety != null ? _json(packet.safety) : '',
    packet && packet.closeout != null ? _json(packet.closeout) : '',
    traceRecord ? _bool(traceRecord.valid === true) : '',
    _json(stages, '[]'),
    _json(traceRecord && Array.isArray(traceRecord.missing) ? traceRecord.missing : [], '[]'),
    _bool(visible.message_present === true),
    typeof visible.source === 'string' ? visible.source : '',
    typeof visible.kind === 'string' ? visible.kind : '',
    _bool(visible.error_present === true),
  ];
}

function validateHeaders(actualHeader) {
  const actual = Array.isArray(actualHeader) ? actualHeader : [];
  const mismatches = [];
  const width = Math.max(actual.length, SHADOW_HEADERS.length);
  for (let i = 0; i < width; i += 1) {
    const expected = i < SHADOW_HEADERS.length ? SHADOW_HEADERS[i] : null;
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
      .then(() => ensure(SHADOW_TAB, SHADOW_HEADERS))
      .then(() => getHeader(SHADOW_TAB))
      .then((actualHeader) => {
        const validation = validateHeaders(actualHeader);
        if (!validation.ok) {
          const first = validation.mismatches[0];
          throw new Error(`Coach_Shadow header mismatch at column ${first.index + 1}: expected ${first.expected || '<none>'}, found ${first.actual || '<blank>'}`);
        }
      })
      .catch((error) => {
        _ready = null;
        throw error;
      });
  }
  return _ready;
}

// Queue one durable row without entering the served response path. A failed
// append is logged once and swallowed; the next turn starts from a clean queue.
function persist(params) {
  // SYNTHETIC CONTAINMENT (owner ruling, 2026-07-31). A positively-synthetic request
  // — an agent/CI/Playwright run marked `x-atlas-request-origin` — must never append
  // here. Coach_Shadow is owner review evidence, and the 2026-07-31 live-retest run
  // (Actions run 30596164330) appended rows 90–91 with no synthetic provenance,
  // contaminating that evidence. The Coach_Shadow schema carries no provenance
  // columns, so an untagged row is indistinguishable from genuine owner activity:
  // the only safe containment is not to write it at all.
  //
  // Deliberately gated on a POSITIVE synthetic identification, not on
  // `evidence_eligible === false`. `unknown` traffic still persists — for an
  // evidence tab, silently dropping unclassifiable-but-possibly-genuine owner turns
  // would destroy real evidence, which is the worse failure. Intent_Shadow and
  // Brain_Shadow are unaffected: they carry evidence_class/evidence_eligible/
  // request_origin columns and correctly tag synthetic rows, so they keep recording.
  if (params && params.synthetic === true) return null;

  const row = buildRow(params);

  // Existing unit/route tests enable the shadow flag but must never touch a real
  // spreadsheet. An injected writer opts a test into this persistence path.
  if (!_append && _isNodeTestRuntime()) return row;

  _tail = _tail
    .catch(() => {})
    .then(async () => {
      const sheets = (!_append || !_ensure || !_getHeader) ? require('../sheets') : null;
      const ensure = _ensure || sheets.ensureSheetTab;
      const getHeader = _getHeader || sheets.getHeaderRow;
      const append = _append || sheets.appendRows;
      await _ensureReady(ensure, getHeader);
      await append(SHADOW_TAB, [row]);
    })
    .catch((error) => {
      const message = error && error.message ? error.message : String(error || 'unknown error');
      try { console.warn(`[coach-turn-shadow-sheet] append failed: ${message}`); } catch (_) { /* best-effort */ }
    });

  return row;
}

function _flushForTesting() {
  return _tail;
}

function _resetForTesting({ append, ensure, getHeader } = {}) {
  _append = typeof append === 'function' ? append : null;
  _ensure = typeof ensure === 'function' ? ensure : null;
  _getHeader = typeof getHeader === 'function' ? getHeader : null;
  _ready = null;
  _tail = Promise.resolve();
}

module.exports = {
  SHADOW_TAB,
  SHADOW_HEADERS,
  buildRow,
  validateHeaders,
  persist,
  _flushForTesting,
  _resetForTesting,
};
