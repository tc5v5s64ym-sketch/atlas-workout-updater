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
    // Good pivot (Coach Voice Renderer slice 2): the engine classified the swap as
    // intent-PRESERVED with a non-poor stimulus → a brief, non-lecturing
    // acknowledgement. Mirrors the server renderer's substitutionPivotLine for the
    // offline / no-LLM path and the preview-bubble intro. A poor-quality "preserved"
    // (rare) falls through to the measured line below.
    const quality = sub && sub.quality;
    if (sub && sub.classification === 'preserved' && quality !== 'poor' && quality !== 'unknown') {
      return `Good pivot — ${l} holds the same pattern with less friction. Log it.${reasonSuffix}`;
    }
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

  // Deterministic one-line voicing of the Fatigue Router's next-move SUGGESTION
  // (PR 483/484), used when the LLM is unavailable so the engine's heads-up for
  // the planned next move is never lost to a Gemini outage. Conclusion-first,
  // suggestion-only (never an order, never a reorder), no invented numbers — the
  // action is the engine's, the wording is ours. `keep`/unknown carry no advice
  // (the server already drops them) → null. Mirrors the LLM prompt rule in
  // services/coach.js for `next_move_advisory`.
  function templatedNextMoveAdvisoryLine(adv) {
    if (!adv || typeof adv !== 'object') return null;
    const next = (typeof adv.next_exercise === 'string' && adv.next_exercise.trim()) ? adv.next_exercise.trim() : null;
    const onNext = next ? ` on ${next}` : '';
    const nextUp = next || 'the next move';
    switch (adv.action) {
      case 'reduce':              return `Heads up — ease off${onNext} next: trim a set or take a little off the bar.`;
      case 'make_optional':       return `Heads up — ${nextUp} is optional today; skip it if you're cooked.`;
      case 'promote_alternative': return `Heads up — pull a rested or antagonist move forward next instead of ${next || 'the same muscle'}.`;
      case 'block_pr':            return `Heads up — no PR attempts on the next lift until you've recovered.`;
      case 'reduce_intensity':    return `Heads up — keep${onNext || ' the next round'} easy: lower the zone or cut it short.`;
      case 'reduce_density':      return `Heads up — cut the rounds or density on ${nextUp}.`;
      default:                    return null; // 'keep'/unknown → no advice
    }
  }

  // Humanize the engine's snake_case convergence-signal labels for prose
  // (e.g. "performance_decline" → "performance decline"). Engine-owned values only.
  function humanizeSignals(signals) {
    if (!Array.isArray(signals)) return null;
    const clean = signals
      .filter(s => typeof s === 'string' && s.trim())
      .map(s => s.trim().replace(/_/g, ' '));
    return clean.length ? clean.join(', ') : null;
  }

  // Deterministic one-line voicing of the Recovery/Deload SELECTION engine's
  // convergence read (PR 485/484), used when the LLM is unavailable. Worded
  // CAUTIOUSLY — never a command ("worth considering" / "hold the line"), never a
  // number (the prescription is owned elsewhere). Only the two recovery-oriented
  // decisions are voiced; anything else carries no recovery advice → null. Mirrors
  // the LLM prompt rule in services/coach.js for `recovery_advisory`.
  function templatedRecoveryAdvisoryLine(adv) {
    if (!adv || typeof adv !== 'object') return null;
    const reason = humanizeSignals(adv.converged_signals);
    const reasonPart = reason ? ` Your last few sessions are stacking fatigue (${reason}).` : '';
    const focusArr = adv.deload_style && Array.isArray(adv.deload_style.focus)
      ? adv.deload_style.focus.filter(f => typeof f === 'string' && f.trim())
      : [];
    if (adv.decision === 'deload') {
      const focusPart = focusArr.length ? ` Keep it simple: ${focusArr[0].trim()}.` : '';
      return `A deload's worth considering — recovery may be the smarter play right now.${reasonPart}${focusPart}`;
    }
    if (adv.decision === 'recovery_reload') {
      return `Might be worth holding the line this week — a lighter touch, not a full deload.${reasonPart}`;
    }
    return null;
  }

  // PR 484 — deterministic LLM-down voicing of the profile-aware Stimulus Governor
  // grade (`set_grade`). The raw effort verdict the offline opener words is profile-
  // BLIND: an `easy`/`far_easy` set reads as "room to add load", but the governor may
  // HOLD it (e.g. a general_fitness lifter whose effort already meets the goal) or flag
  // fatigue. These helpers let the opener defer to the governor so the fallback never
  // invites progression the engine wants held. Direction only — never a number (the
  // load math stays in recommendNextSet). Mirrors the slice-3 prompt rule in
  // services/coach.js for `stimulus_grade`.

  // True when the governor's read should OVERRIDE a raw progression-invite opener:
  // it wants to hold / back off, or it flags elevated/high fatigue. (`set_grade` shape:
  // { profile, effort_interpretation, progression_verdict, fatigue_signal }.)
  function governorOverridesProgressionInvite(grade) {
    if (!grade || typeof grade !== 'object') return false;
    return grade.progression_verdict === 'hold'
      || grade.progression_verdict === 'back_off'
      || grade.fatigue_signal === 'elevated'
      || grade.fatigue_signal === 'high';
  }

  // The deterministic hold line that replaces a progression invite when the governor
  // overrides → null when it does not. No numbers; conclusion-first. A back_off /
  // high-fatigue read is firmer; a general_fitness hold names that the goal is already
  // met (never celebrate chasing more / grinding); the default is a plain "repeat,
  // don't jump".
  function templatedGovernorHoldLine(grade) {
    if (!governorOverridesProgressionInvite(grade)) return null;
    const backOff = grade.progression_verdict === 'back_off' || grade.fatigue_signal === 'high';
    if (backOff) {
      return 'Hold here — back off rather than push; keep this load (or a touch less) next time.';
    }
    if (grade.profile === 'general_fitness') {
      return "That's enough stimulus for your goal — hold this load next time, no need to chase more.";
    }
    return 'Hold this load next time — that effort earned a repeat, not a jump.';
  }

  // PR-4 (composer-first Phase 0a) — tier-aware brevity for the DETERMINISTIC note
  // paths. The engine's coachNoteTier decides how much the fallback voice says: a
  // brief tier renders the headline only, trimming SUPPLEMENTARY lines (the
  // next-move heads-up, the substitution ack). The recovery read is safety-class
  // and is never gated on this — a brevity tier must not silence a back-off
  // signal. Per-set notes carry no tier (null) and are never brief, so existing
  // set-by-set output is byte-identical. Pure predicate; no wording, no numbers.
  function isBriefTier(tier) {
    return tier === 'short' || tier === 'ack_only';
  }

  const exported = {
    liftLabel,
    templatedSubstitutionLine,
    formatSubstituteCoachLine,
    templatedNextMoveAdvisoryLine,
    templatedRecoveryAdvisoryLine,
    governorOverridesProgressionInvite,
    templatedGovernorHoldLine,
    isBriefTier,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else {
    root.coachVoiceTemplates = exported;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
