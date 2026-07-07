/* Atlas frontend module entry (Phase-1 PR-08 / PR-09).
 *
 * The single `type="module"` script index.html loads. It imports app.js (now an ES
 * module — PR-09) and every satellite for its side effects (DOM wiring, window API
 * assignment) plus the legacy bridge that re-exposes the pure helpers.
 *
 * PR-09: app.js is now an ES module too, loaded by index.html as its OWN deferred
 * module script IMMEDIATELY BEFORE this entry (not imported here) — so it evaluates
 * first, with a microtask checkpoint between it and this entry. That preserves the
 * previous "classic app.js runs before atlasEntry, and its init's async work settles
 * in the gap" timing (e.g. the atlas:glance-ready opener race), rather than folding
 * app.js into this graph and closing that gap.
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
