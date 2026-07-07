/* Atlas frontend module entry (Phase-1 PR-08).
 *
 * The single `type="module"` script index.html loads. It imports every
 * converted satellite for its side effects (DOM wiring, window API assignment)
 * and the legacy bridge that re-exposes the pure helpers to the still-classic
 * app.js. Being a module, this runs deferred — AFTER the classic app.js has
 * executed and its top-level globals exist, and BEFORE DOMContentLoaded — so the
 * bridge's window assignments are in place before app.js's DOMContentLoaded
 * handler (and every user interaction) reads them.
 *
 * The pure helpers (activeSession, planMutationIntent, identityCorrection,
 * displayBlockNormalizer, hybridCompare) load transitively via legacyBridge.js;
 * coachVoiceTemplates + sessionQuestion load transitively via coach-conversation.js.
 */

import './flightRecorder.js';
import './legacyBridge.js';
import './nav.js';
import './drawer.js';
import './chat.js';
import './coach-conversation.js';
