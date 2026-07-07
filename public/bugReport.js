'use strict';
// Atlas frontend — bugReport module (PR-09b mechanical extraction from app.js).
import { redactBugReportString } from './app.js';

export const BUG_REPORT_STORAGE_KEY_RE = /(?:api[_-]?key|authorization|auth|bearer|cookie|credential|jwt|password|private[_-]?key|secret|token)/i;

export const BUG_REPORT_SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*)\s*=\s*["']?[^"',\s]+["']?/g
];

export const BUG_REPORT_REDACTED = '[REDACTED]';

export const BUG_REPORT_RECENT_API_LIMIT = 20;

// Bug-report diagnostics: so one tap on "Report Bug" captures enough to root-cause
// without the owner typing anything. All of this rides inside the existing Payload JSON
// column (no Bug_Reports schema change) and is bounded + redacted before it leaves.
export const BUG_REPORT_ERROR_LIMIT = 12;

// ring buffer of recent errors (api + client JS)
export const BUG_REPORT_ACTION_LIMIT = 30;

// ring buffer of UI breadcrumbs (taps, nav)
const BUG_REPORT_BODY_MAX = 1000;

// per-call request/response body cap (chars)
export const BUG_REPORT_SIZE_BUDGET = 44000;

// keep the whole report under the Sheets per-cell limit
export const atlasRecentApiRequests = [];

export const atlasRecentErrors = [];

// last N errors, so a cascade shows AS a cascade
export const atlasActionLog = [];

// Truncated + redacted snapshot of a request/response body. Multipart uploads
// (screenshots) are summarised by field name, never dumped.
export function snapshotBugBody(body) {
  if (body == null) return null;
  try {
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const keys = [];
      for (const k of body.keys()) keys.push(k);
      return `[multipart: ${keys.join(', ')}]`;
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const safe = redactBugReportString(text);
    return safe.length > BUG_REPORT_BODY_MAX ? `${safe.slice(0, BUG_REPORT_BODY_MAX)}...[truncated]` : safe;
  } catch {
    return '[unserializable]';
  }
}

// Error/action capture must NEVER throw — diagnostics can't be the thing that breaks logging.
export function recordAtlasError(entry) {
  try {
    atlasRecentErrors.push({ at: new Date().toISOString(), ...entry });
    while (atlasRecentErrors.length > BUG_REPORT_ERROR_LIMIT) atlasRecentErrors.shift();
  } catch { /* best-effort */ }
}

export function recordAtlasAction(action, detail) {
  try {
    atlasActionLog.push({
      at: new Date().toISOString(),
      action,
      ...(detail ? { detail: String(detail).slice(0, 120) } : {})
    });
    while (atlasActionLog.length > BUG_REPORT_ACTION_LIMIT) atlasActionLog.shift();
  } catch { /* best-effort */ }
}
