/* Pure substitution-text helpers shared between coach-conversation.js (browser)
 * and the Node test suite. UMD wrapper: exports in Node, sets
 * window.coachVoiceTemplates in the browser.
 *
 * No DOM, no closures, no side effects — unit-testable in isolation.
 */
(function (root) {
  'use strict';

  // Handle both object refs ({ name, … }) and bare name strings gracefully.
  function liftLabel(ref, fallback) {
    if (ref && typeof ref === 'object') return ref.name || fallback;
    return (typeof ref === 'string' && ref) ? ref : fallback;
  }

  // Deterministic one-line substitution verdict keyed off the engine's
  // classification.  This is the fallback when the LLM is unavailable; it is
  // also woven into the preview-bubble intro so the coach sounds like one voice.
  function templatedSubstitutionLine(sub) {
    const p = liftLabel(sub && sub.prescribed, 'the prescribed lift');
    const l = liftLabel(sub && sub.logged, 'what you logged');
    const reasonSuffix = (sub && sub.reason) ? ` Reason: ${sub.reason}.` : '';
    switch (sub && sub.classification) {
      case 'preserved':
        return `${l} for ${p} — same job, different tool. Intent preserved.${reasonSuffix}`;
      case 'changed':
        return `${l} for ${p} — that shifts the target muscle. Slot the real match in next time.${reasonSuffix}`;
      case 'abandoned':
        return `${l} for ${p} — that left the session's objective untrained. Get the real movement back in this week.${reasonSuffix}`;
      case 'baseline':
        return `${l} for ${p} — no history yet to judge it against. Logging it builds the baseline.${reasonSuffix}`;
      default:
        return `${l} for ${p}.${reasonSuffix}`;
    }
  }

  // Coach-voice text for a proactive equipment-substitution recommendation
  // (atlas:substitute-suggested). Returns null when required fields are absent.
  // Sounds like one coach talking, not a structured diagnostic card.
  function formatSubstituteCoachLine({ prescribed, recommendation, quality, reason } = {}) {
    if (!prescribed || !recommendation) return null;
    const reasonPart = reason ? ` ${reason}.` : '';
    if (quality === 'excellent') {
      return `No ${prescribed} today — ${recommendation} is your best swap.${reasonPart} Same stimulus, different bar.`;
    }
    return `No ${prescribed} today — switch to ${recommendation}.${reasonPart} Not a perfect one-for-one, but it covers the session — get ${prescribed} back in when the equipment's free.`;
  }

  const exported = { liftLabel, templatedSubstitutionLine, formatSubstituteCoachLine };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.coachVoiceTemplates = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
