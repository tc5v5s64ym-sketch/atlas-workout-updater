'use strict';

const BUG_REPORT_TAB = 'Bug_Reports';
const BUG_REPORT_COLUMNS = [
  'Created At',
  'Bug ID',
  'Note',
  'Route',
  'Session ID',
  'Last Error',
  'App Version',
  'User Agent',
  'Payload JSON'
];

const SENSITIVE_KEY_RE = /(?:api[_-]?key|authorization|auth|bearer|cookie|credential|jwt|password|private[_-]?key|secret|token)/i;
const MAX_STRING_LENGTH = 12000;

function bugIdFromDate(date = new Date()) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  return `BUG-${stamp}`;
}

function redactBugPayload(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      : value;
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
    JSON.stringify(safePayload)
  ];
}

module.exports = {
  BUG_REPORT_TAB,
  BUG_REPORT_COLUMNS,
  bugIdFromDate,
  redactBugPayload,
  buildBugReportRow
};
