'use strict';

// ── Discouragement signal (Soul Plan PR-B5b, Part 1 — pure, unwired) ──────────
//
// The deterministic seed for engine-triggered REASSURANCE. When the lifter types
// "bench is stuck, I feel like I'm going backwards," the zoom-out that follows
// ("squat's up 15 since June; you haven't missed a Monday in two months") should be
// the engine handing over the exact facts that make it true — not model
// improvisation. This module is the tripwire: the smallest honest version —
// EXPLICIT frustration/self-talk phrases plus stall context, NOT a sentiment model
// and NOT the 16-state research model (07-the-feel-of-atlas stays non-governing).
//
// PURE + UNWIRED: no I/O, no LLM, no clock. Part 2 wires detectDiscouragement into
// selectCoachMode's `reassure` trigger + assembles the deterministic zoom-out
// evidence pack (per-lift trends, athlete_identity streaks, the stalled lift's own
// history) + the persona reassure block. This part only classifies the language.
//
// detectDiscouragement(messageText, context) →
//   { discouraged: bool, kind: 'frustration'|'negative_self_talk'|'stall_frustration'|null, matched: string|null }
//
// Guards (mirroring services/recoveryRouting.js isTirednessExpression discipline):
//   - Explicit phrases only, \b-anchored so a lift name can't collide.
//   - A negated phrase ("I'm NOT going backwards", "bench isn't stuck") never fires.
//   - A leading interrogative ("why is my bench stuck?") is an analytical question
//     for the coach, not a frustration report — it does not fire.
//   - Pure TIREDNESS ("I'm exhausted", "legs are toast") is NOT discouragement — it
//     routes to the existing recovery read; deferred here so the two never collide.
//   - `stall_frustration` = a frustration/self-talk phrase co-occurring with the
//     engine's `stalls` context (context.stalls non-empty).
//
// Pure tiredness ("I'm exhausted", "legs are toast") does NOT fire here BY
// CONSTRUCTION — fatigue words are not discouragement phrases — so this module
// stays uncoupled from recoveryRouting; when a message reads as both, the Part 2
// selectCoachMode precedence decides (recovery/safety over reassure), not this
// classifier.

// Explicit frustration about progress / a lift being stuck.
// "stuck" excludes the POSITIVE adherence senses ("stuck to my program", "stuck
// with it", "stuck it out", "stuck around") via a lookahead — those read as
// encouraged, not discouraged (review #950). "stuck in a rut" is caught by its own
// pattern below; a bare "stuck in traffic" then correctly does not fire.
const FRUSTRATION = [
  /\bstuck\b(?!\s+(?:to|with|it|around|in)\b)/,
  /\b(stalled|plateaued|plateauing|plateaus?)\b/,
  /\b(going|getting) nowhere\b/,
  /\bnot getting anywhere\b/,
  /\bspinning my wheels\b/,
  /\bstuck in a rut\b/,
  /\b(so |really |very |super )?frustrat(?:ed|ing)\b/,
  /\bcan'?t (?:break|get) (?:through|past)\b/,
  /\bhitting a wall\b/,
  /\bfed up\b/,
];

// Negative self-talk about themselves / their trajectory.
const NEGATIVE_SELF_TALK = [
  /\b(?:going|moving|sliding) backwards?\b/,
  /\bgetting worse\b/,
  /\bi'?m (?:so |such |just )?(?:weak|useless|terrible|hopeless|pathetic|garbage|trash|worthless)\b/,
  /\bi (?:suck|stink)\b/,
  /\bi'?ll never\b/,
  /\bnever (?:going to|gonna) (?:get|make|hit|reach)\b/,
  /\bwhat'?s the point\b/,
  /\bfeel like (?:i'?m |i am )?(?:going backwards?|failing|falling behind|a failure)\b/,
];

// Negation before a discouragement term flips the meaning ("bench is not really
// stuck"). PHRASE-SCOPED (review #950): a negator neutralizes only a phrase within a
// short preceding window (negator + up to two words), NOT the whole message — so a
// negated clause ("I'm not stuck on squat") never suppresses a genuine discouragement
// in another clause ("bench has me spinning my wheels"). Anchored at `$` so it tests
// only the text immediately before a candidate match.
const NEG_BEFORE = /\b(?:not|never|no longer|isn'?t|aren'?t|ain'?t|don'?t|doesn'?t|didn'?t|wasn'?t|weren'?t|hardly|barely)\s+(?:\w+\s+){0,2}$/;

// Is the phrase starting at `index` negated by a negator in its immediate lead-in?
// Looks back a bounded window (enough for "no longer" + two words); a slice that cuts
// mid-word simply won't \b-anchor a negator, which fails closed (treats as un-negated).
function _isNegatedAt(text, index) {
  return NEG_BEFORE.test(text.slice(Math.max(0, index - 40), index));
}

// A genuine analytical question → for the coach, not a frustration report. Narrow
// on purpose: a trailing "?" OR an unambiguous analytical opener. NOT bare "what"
// ("what's the point anymore" is rhetorical despair, not a question) and NOT "can"
// (must not swallow "can't break through").
function _isAnalyticalQuestion(t) {
  if (/\?\s*$/.test(t)) return true;
  if (/^(why|how|when|where|which|who)\b/.test(t)) return true;
  if (/^what\s+(should|do|can|to|is|are)\b/.test(t)) return true;
  if (/^(should|could|would|can|do|does|did|is|are|am)\s+(i|we|my|you)\b/.test(t)) return true;
  return false;
}

// The first match of any pattern whose position is NOT negated in its lead-in. A
// negated phrase is skipped and scanning continues, so an un-negated discouragement
// later in the message still fires (phrase-scoped negation).
function _firstUnnegatedMatch(text, patterns) {
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text)) !== null) {
      if (!_isNegatedAt(text, m.index)) return m[0];
      if (g.lastIndex === m.index) g.lastIndex++; // never spin on a zero-width match
    }
  }
  return null;
}

function detectDiscouragement(messageText, context) {
  const t = String(messageText == null ? '' : messageText).toLowerCase().trim();
  const none = { discouraged: false, kind: null, matched: null };
  if (!t) return none;
  if (_isAnalyticalQuestion(t)) return none;

  // Phrase-scoped negation: each candidate is kept only if its own lead-in is not
  // negated, so a negated clause no longer suppresses the whole message (review #950).
  const selfTalk = _firstUnnegatedMatch(t, NEGATIVE_SELF_TALK);
  const frustration = _firstUnnegatedMatch(t, FRUSTRATION);
  const matched = selfTalk || frustration;
  if (!matched) {
    // No explicit discouragement phrase. Pure tiredness is handled elsewhere; we
    // never reclassify it as discouragement.
    return none;
  }

  // Base kind: self-talk is the more specific/serious read; else frustration.
  let kind = selfTalk ? 'negative_self_talk' : 'frustration';

  // Boost: an explicit frustration/self-talk co-occurring with the engine's own
  // stall context is stall-anchored frustration — the strongest, most groundable
  // case for the zoom-out (Part 2 pulls the stalled lift's history).
  const stalls = context && typeof context === 'object' && Array.isArray(context.stalls) ? context.stalls : [];
  if (stalls.length > 0) kind = 'stall_frustration';

  return { discouraged: true, kind, matched };
}

module.exports = { detectDiscouragement };
