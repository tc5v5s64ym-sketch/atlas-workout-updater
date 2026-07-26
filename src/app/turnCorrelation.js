'use strict';

// Issue #1165 slice 2 — bounded client half of the coach-turn → preview → approval
// round-trip. This module owns only correlation state. It never decides whether a write
// happens, never logs a capability, and never places tokens in response bodies or artifacts.

export const TURN_ID_HEADER = 'x-atlas-turn-id';
export const PAIRING_TOKEN_HEADER = 'x-atlas-turn-pairing';
export const MAX_TRACKED_SESSIONS = 4;
export const MAX_RETIRED_INITIATIONS = 8;

const TURN_ID_RE = /^turn:[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const PAIRING_TOKEN_RE = /^pair:[a-f0-9]{32}$/;
const INITIATION_NONCE_RE = /^init:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TURN_ID_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 128;

function validSessionId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_ID_LENGTH
    && value === value.trim();
}

function validTurnId(value) {
  return typeof value === 'string'
    && value.length <= MAX_TURN_ID_LENGTH
    && value === value.trim()
    && TURN_ID_RE.test(value);
}

function validPairingToken(value) {
  return typeof value === 'string' && PAIRING_TOKEN_RE.test(value);
}

function uuidFallback() {
  // The nonce is ordering identity, not a capability. Pairing authority remains a
  // server-minted cryptographic token; this fallback only preserves bounded UUID shape.
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map(v => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultRandomUUID() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  return c && typeof c.randomUUID === 'function' ? c.randomUUID() : uuidFallback();
}

function headerValue(headers, name) {
  try {
    return headers && typeof headers.get === 'function' ? headers.get(name) : null;
  } catch (_) {
    return null;
  }
}

export function createTurnCorrelation({ randomUUID = defaultRandomUUID } = {}) {
  // session_id → { turnId, active, retired[] }. Pairing tokens exist only inside the
  // active record closure and are erased the instant a newer preview starts.
  const sessions = new Map();

  function touch(sessionId, state) {
    sessions.delete(sessionId);
    sessions.set(sessionId, state);
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
    }
  }

  function stateFor(sessionId) {
    return validSessionId(sessionId) ? sessions.get(sessionId) || null : null;
  }

  function addRetired(state, nonce) {
    if (!state || !INITIATION_NONCE_RE.test(String(nonce || ''))) return;
    if (!state.retired.includes(nonce)) state.retired.push(nonce);
    while (state.retired.length > MAX_RETIRED_INITIATIONS) state.retired.shift();
  }

  function captureTurn({ sessionId, turnId } = {}) {
    if (!validSessionId(sessionId) || !validTurnId(turnId)) return false;
    const current = sessions.get(sessionId);
    if (current && current.turnId === turnId) {
      touch(sessionId, current);
      return true;
    }
    if (current && current.active) {
      current.active.pairingToken = null;
      current.active.superseded = true;
    }
    touch(sessionId, { turnId, active: null, retired: [] });
    return true;
  }

  function captureTurnResponse({ sessionId, responseHeaders } = {}) {
    return captureTurn({
      sessionId,
      turnId: headerValue(responseHeaders, TURN_ID_HEADER),
    });
  }

  function beginPreview({ sessionId } = {}) {
    const state = stateFor(sessionId);
    if (!state || !validTurnId(state.turnId)) return null;

    if (state.active) {
      state.active.pairingToken = null;
      state.active.superseded = true;
      addRetired(state, state.active.initiation_nonce);
    }

    const initiation_nonce = `init:${String(randomUUID())}`;
    if (!INITIATION_NONCE_RE.test(initiation_nonce)) return null;
    const correlation = {
      turn_id: state.turnId,
      initiation_nonce,
      ...(state.retired.length
        ? { retire_initiation_nonces: [...state.retired] }
        : {}),
    };
    const preview = {
      sessionId,
      turnId: state.turnId,
      initiation_nonce,
      correlation,
      pairingToken: null,
      superseded: false,
    };
    state.active = preview;
    touch(sessionId, state);
    return preview;
  }

  function completePreview(preview, responseHeaders) {
    if (!preview || preview.superseded === true) return false;
    const state = stateFor(preview.sessionId);
    if (!state || state.active !== preview || state.turnId !== preview.turnId) return false;
    const responseTurnId = headerValue(responseHeaders, TURN_ID_HEADER);
    const pairingToken = headerValue(responseHeaders, PAIRING_TOKEN_HEADER);
    if (responseTurnId !== preview.turnId || !validTurnId(responseTurnId)
        || !validPairingToken(pairingToken)) {
      preview.pairingToken = null;
      return false;
    }
    preview.pairingToken = pairingToken;
    return true;
  }

  function approvalClaim(preview) {
    if (!preview || preview.superseded === true || !validPairingToken(preview.pairingToken)) return null;
    const state = stateFor(preview.sessionId);
    if (!state || state.active !== preview || state.turnId !== preview.turnId) return null;
    return {
      turn_id: preview.turnId,
      initiation_nonce: preview.initiation_nonce,
      pairing_token: preview.pairingToken,
    };
  }

  function retirePreview(preview) {
    if (!preview) return false;
    const state = stateFor(preview.sessionId);
    preview.pairingToken = null;
    preview.superseded = true;
    if (!state || state.active !== preview) return false;
    addRetired(state, preview.initiation_nonce);
    state.active = null;
    touch(preview.sessionId, state);
    return true;
  }

  function diagnosticSnapshot() {
    // Deliberately no pairing token, payload, or fingerprint. This is safe to inspect
    // in tests/debugging and cannot accidentally become a capability-leaking artifact.
    return [...sessions.entries()].map(([session_id, state]) => ({
      session_id,
      turn_id: state.turnId,
      active_initiation: state.active ? state.active.initiation_nonce : null,
      retired_count: state.retired.length,
    }));
  }

  return {
    captureTurn,
    captureTurnResponse,
    beginPreview,
    completePreview,
    approvalClaim,
    retirePreview,
    diagnosticSnapshot,
  };
}

// One module singleton shared by app.js and coach-conversation.js.
export const turnCorrelation = createTurnCorrelation();

export const captureTurnResponse = args => turnCorrelation.captureTurnResponse(args);
export const beginCorrelatedPreview = args => turnCorrelation.beginPreview(args);
export const completeCorrelatedPreview = (preview, responseHeaders) =>
  turnCorrelation.completePreview(preview, responseHeaders);
export const approvalCorrelation = preview => turnCorrelation.approvalClaim(preview);
export const retireCorrelatedPreview = preview => turnCorrelation.retirePreview(preview);
