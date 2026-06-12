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
  const workoutText = document.getElementById('workout-text');
  const previewPanel = document.getElementById('preview-panel');
  const loggerStatus = document.getElementById('logger-status');
  if (!form || !thread) return;

  const MAX_BUBBLES = 12;

  function addUserBubble(text) {
    // Don't repeat an identical consecutive bubble (double-tap preview).
    const last = thread.lastElementChild;
    if (last && last.textContent === text) return;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-bubble-user';
    bubble.textContent = text;
    thread.appendChild(bubble);
    while (thread.children.length > MAX_BUBBLES) thread.removeChild(thread.firstChild);
    bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // app.js's submit handler runs preview; we only narrate the send.
  form.addEventListener('submit', () => {
    const text = (workoutText?.value || '').trim();
    if (text) {
      addUserBubble(text);
      return;
    }
    const mode = document.querySelector('input[name="effort-mode"]:checked')?.value;
    const file = document.getElementById('effort-image')?.files?.[0];
    if (mode === 'screenshot' && file) addUserBubble(`\u{1F4F7} ${file.name}`);
  });

  // Bring Atlas's reply (preview card) into view when it appears.
  if (previewPanel) {
    new MutationObserver(() => {
      if (!previewPanel.hidden) {
        previewPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }).observe(previewPanel, { attributes: true, attributeFilter: ['hidden'] });
  }

  // Status replies (written ✓ / verified / verdict / errors) scroll into view too.
  if (loggerStatus) {
    new MutationObserver(() => {
      if (loggerStatus.childElementCount > 0) {
        loggerStatus.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }).observe(loggerStatus, { childList: true });
  }

  // Opening the nested Effort section must also open the outer Details fold.
  const effortDetails = document.getElementById('effort-details');
  effortDetails?.addEventListener('toggle', () => {
    if (!effortDetails.open) return;
    let node = effortDetails.parentElement;
    while (node) {
      if (node.tagName === 'DETAILS') node.open = true;
      node = node.parentElement;
    }
  });
})();
