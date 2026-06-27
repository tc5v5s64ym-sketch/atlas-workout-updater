'use strict';

const BUG_REPORT_TAB = 'Bug_Reports';
const BUG_REPORT_COLUMNS = [
  'Created At',
  'Bug ID',
  'Source',
  'Severity',
  'Status',
  'Note',
  'Route',
  'Session ID',
  'Last Error',
  'App Version',
  'User Agent',
  'Screenshot/DOM Link',
  'Payload JSON'
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
    safePayload.source || '',
    safePayload.severity || '',
    safePayload.status || '',
    safePayload.note || '',
    safePayload.route || safePayload.current_route || '',
    sessionId,
    safePayload.last_error?.message || safePayload.last_error || '',
    safePayload.app_version?.version || safePayload.app_version?.shell || safePayload.app_version || '',
    safePayload.browser?.userAgent || safePayload.userAgent || '',
    safePayload.screenshot_url || safePayload.dom_url || '',
    JSON.stringify(safePayload)
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
