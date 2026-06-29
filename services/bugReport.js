'use strict';

const BUG_REPORT_TAB = 'Bug_Reports';
// APPEND-ONLY contract: new columns go at the END so historical rows (which have
// fewer cells) stay aligned — never insert or reorder. The summary columns after
// Payload JSON are short, scannable values DERIVED from the payload (which the
// enriched one-tap report already carries), so the common bug classes are readable
// in the grid without opening the JSON blob.
const BUG_REPORT_COLUMNS = [
  'Created At',
  'Bug ID',
  'Note',
  'Route',
  'Session ID',
  'Last Error',
  'App Version',
  'User Agent',
  'Payload JSON',
  'Error Count',          // # of errors captured this session (spots a poison cascade)
  'Last Failed Endpoint', // most recent failing request, e.g. POST /api/log-workout
  'Last Action',          // last UI breadcrumb before the report, e.g. "tap: restore"
  'Stale Shell',          // yes = a SW update is waiting (a cached/old shell, not a code bug)
  'UI Blocked'            // e.g. "Save disabled" / "composer disabled" — the lockup class
];

const SENSITIVE_KEY_RE = /(?:api[_-]?key|authorization|auth|bearer|cookie|credential|jwt|password|private[_-]?key|secret|token)/i;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*)\s*=\s*["']?[^"',\s]+["']?/g
];
const MAX_STRING_LENGTH = 12000;

function bugIdFromDate(date = new Date()) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  return `BUG-${stamp}`;
}

function redactBugString(value) {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (match, keyName) => {
      if (typeof keyName === 'string' && keyName) return `${keyName}=[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return out;
}

function redactBugPayload(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const safeValue = redactBugString(value);
    return safeValue.length > MAX_STRING_LENGTH
      ? `${safeValue.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      : safeValue;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactBugPayload(item, seen));

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactBugPayload(raw, seen);
    }
  }
  return out;
}

// Short, scannable summaries derived from the (already-redacted) payload, so the
// painful bug classes are readable in the grid without opening Payload JSON. Every
// field defaults to '' when the source data is absent (older clients / the /bug
// command path), so missing data is a blank cell, never a crash.
function bugReportSummaryFields(safePayload) {
  const errors = Array.isArray(safePayload.recent_errors) ? safePayload.recent_errors : [];
  const errorCount = errors.length || '';

  const lastFailed = [...errors].reverse().find(e => e && e.endpoint);
  const lastFailedEndpoint = lastFailed
    ? [lastFailed.method, lastFailed.endpoint].filter(Boolean).join(' ')
    : (safePayload.last_error?.endpoint || '');

  const actions = Array.isArray(safePayload.action_log) ? safePayload.action_log : [];
  const lastActionEntry = actions.length ? actions[actions.length - 1] : null;
  const lastAction = lastActionEntry
    ? [lastActionEntry.action, lastActionEntry.detail].filter(Boolean).join(': ')
    : '';

  const sw = safePayload.service_worker;
  const staleShell = sw ? (sw.waiting === true ? 'yes' : 'no') : '';

  const ui = safePayload.ui_state || {};
  const blocked = [];
  if (ui.approve_btn_disabled === true) blocked.push('Save disabled');
  if (ui.composer_disabled === true) blocked.push('composer disabled');
  if (ui.preview_btn_disabled === true) blocked.push('preview disabled');
  const uiBlocked = blocked.join(', ');

  return [errorCount, lastFailedEndpoint, lastAction, staleShell, uiBlocked];
}

function buildBugReportRow(payload) {
  const safePayload = redactBugPayload(payload && typeof payload === 'object' ? payload : {});
  const bugId = safePayload.bug_id || bugIdFromDate();
  const timestamp = safePayload.timestamp || new Date().toISOString();
  const sessionId = safePayload.current_sheet?.session_id
    || safePayload.session_id
    || safePayload.pending_write?.sessionId
    || safePayload.pending_write?.payload?.session_id
    || '';
  return [
    timestamp,
    bugId,
    safePayload.note || '',
    safePayload.route || safePayload.current_route || '',
    sessionId,
    safePayload.last_error?.message || safePayload.last_error || '',
    safePayload.app_version?.version || safePayload.app_version?.shell || safePayload.app_version || '',
    safePayload.browser?.userAgent || safePayload.userAgent || '',
    JSON.stringify(safePayload),
    ...bugReportSummaryFields(safePayload)
  ];
}

module.exports = {
  BUG_REPORT_TAB,
  BUG_REPORT_COLUMNS,
  bugIdFromDate,
  redactBugString,
  redactBugPayload,
  buildBugReportRow
};
