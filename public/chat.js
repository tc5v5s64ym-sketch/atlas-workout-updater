/* Atlas Coach chat layer — purely visual.
 *
 * Turns the logger into a conversation: the workout you send becomes a user
 * bubble in #thread-messages, and the existing preview panel / status box
 * (owned by app.js, untouched) read as Atlas's replies beneath it.
 *
 * This file never calls the API and never touches the trust loop: preview,
 * approve, write, undo and verification all stay in app.js.
 */

(function () {
  'use strict';

  const form = document.getElementById('logger-form');
  const thread = document.getElementById('thread-messages');
  // eslint-disable-next-line no-unused-vars -- DOM element captured; referenced via closure in sibling scripts; Phase 1 PR-08/09
  const workoutText = document.getElementById('workout-text');
  const previewPanel = document.getElementById('preview-panel');
  const loggerStatus = document.getElementById('logger-status');
  if (!form || !thread) return;

  const MAX_BUBBLES = 12;

  // Honor the OS "reduce motion" setting: jump instead of smooth-scroll.
  const reduce = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function addUserBubble(text) {
    // Don't repeat an identical consecutive bubble (double-tap preview).
    const last = thread.lastElementChild;
    if (last && last.textContent === text) return;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-bubble-user';
    bubble.textContent = text;
    thread.appendChild(bubble);
    while (thread.children.length > MAX_BUBBLES) thread.removeChild(thread.firstChild);
    bubble.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'nearest' });
  }

  // Expose the bubble painter so app.js's submit handler can paint the user's
  // message FIRST — before any routing/coach reply/preview/log reaction appends an
  // Atlas bubble. Painting here on submit would race app.js's synchronous appends
  // and could land the user bubble BELOW the response (the owner-reported inversion).
  // app.js now owns the on-submit paint; the dedupe guard in addUserBubble keeps a
  // double-submit from stacking.
  window.atlasAddUserBubble = addUserBubble;

  // A chosen screenshot is the user's "message" — drop the attachment bubble in
  // the moment it's picked, before the auto-preview fires (see nav.js).
  const effortImage = document.getElementById('effort-image');
  effortImage?.addEventListener('change', () => {
    const file = effortImage.files?.[0];
    if (file) addUserBubble(`\u{1F4F7} ${file.name}`);
  });

  // Bring Atlas's reply (preview card) into view when it appears.
  if (previewPanel) {
    new MutationObserver(() => {
      if (!previewPanel.hidden) {
        previewPanel.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'nearest' });
      }
    }).observe(previewPanel, { attributes: true, attributeFilter: ['hidden'] });
  }

  // Status replies (written ✓ / verified / verdict / errors) scroll into view too.
  if (loggerStatus) {
    new MutationObserver(() => {
      if (loggerStatus.childElementCount > 0) {
        loggerStatus.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'nearest' });
      }
    }).observe(loggerStatus, { childList: true });
  }

})();
