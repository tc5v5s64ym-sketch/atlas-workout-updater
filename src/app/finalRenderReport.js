// #1124 — client half of the final-render report.
//
// Decides whether a coach turn's rendered outcome DIVERGES from the
// server-stage record, and builds the bounded POST body for
// /api/coach/final-render. Pure and stateless: same inputs → same decision.
// No I/O, no DOM, no network — the caller (coach-conversation.js) owns the
// fire-and-forget POST and the render itself.
//
// The server row (Coach_Response) already captures the server-stage truth:
// the message the server returned, or deliberate_silence /
// validator_suppressed when it returned none. This module answers only one
// question: does the text the athlete actually saw differ from that record?
//
//   • Agreement (server message shown unchanged, or true silence on both
//     sides) → null. One correlated record, no duplicate.
//   • Client rendered a line the server did not show (deliberate-silence
//     wrap, suppressed-prose primary line, LLM-down opener) → report it,
//     replaced_server_visible: true.
//   • Client rendered nothing while the server message was visible → report
//     the drop, server_visible_present: true.
//   • Client extended the server message (advisory / substitution lines
//     appended) → report the exact final text, replaced: false.
//
// The final text is bounded at 4000 chars (the same bound the server sheet
// enforces). Source/kind are caller-supplied from the allowlists the server
// enforces; this module never invents them.

export const MAX_FINAL_RENDER_CHARS = 4000;

export const FINAL_RENDER_SOURCES = Object.freeze([
  'llm',
  'deterministic_wrap',
  'voice_primary_line',
  'templated_opener',
  'templated_fallback',
  'none',
]);

export const FINAL_RENDER_KINDS = Object.freeze(['set', 'block', 'plan', 'chat', 'ask']);

function visibleText(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

// Returns null when the rendered outcome agrees with the server-stage record
// (nothing to report), or { finalMessage, replacedServerVisible,
// serverVisiblePresent } when it diverges.
export function decideFinalRenderReport({ serverMessage, renderedNote } = {}) {
  const server = visibleText(serverMessage);
  const rendered = visibleText(renderedNote);
  if (server === rendered) return null; // agreement: unchanged message, or true silence
  if (rendered && !server) {
    return {
      finalMessage: rendered.slice(0, MAX_FINAL_RENDER_CHARS),
      replacedServerVisible: true,
      serverVisiblePresent: false,
    };
  }
  if (!rendered && server) {
    return { finalMessage: '', replacedServerVisible: false, serverVisiblePresent: true };
  }
  // Both visible but different: the client extended the server message.
  return {
    finalMessage: rendered.slice(0, MAX_FINAL_RENDER_CHARS),
    replacedServerVisible: false,
    serverVisiblePresent: true,
  };
}

// Builds the POST body for /api/coach/final-render, or null when there is
// nothing divergent to report. The turn id must come from the response
// headers of the turn that produced the render (x-atlas-turn-id); never mint
// an unrelated render ID — without a turn id there is no report.
export function buildFinalRenderPayload({
  turnId,
  sessionId = null,
  route = '/api/coach/message',
  serverMessage,
  renderedNote,
  finalSource,
  finalKind,
  appVersion = null,
} = {}) {
  if (typeof turnId !== 'string' || !turnId.trim()) return null;
  if (!FINAL_RENDER_SOURCES.includes(finalSource)) return null;
  if (!FINAL_RENDER_KINDS.includes(finalKind)) return null;
  const decision = decideFinalRenderReport({ serverMessage, renderedNote });
  if (!decision) return null;
  return {
    turn_id: turnId.trim(),
    ...(typeof sessionId === 'string' && sessionId.trim() ? { session_id: sessionId.trim() } : {}),
    route,
    final_message: decision.finalMessage,
    final_source: finalSource,
    final_kind: finalKind,
    replaced_server_visible: decision.replacedServerVisible,
    server_visible_present: decision.serverVisiblePresent,
    ...(typeof appVersion === 'string' && appVersion.trim() ? { app_version: appVersion.trim() } : {}),
  };
}
