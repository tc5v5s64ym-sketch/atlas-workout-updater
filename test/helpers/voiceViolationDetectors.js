'use strict';

// ── Voice violation detectors (Soul Plan PR-B7) ──────────────────────────────
//
// Pure, deterministic string heuristics that flag out-of-character coach wording
// against the ratified persona (COACH_PERSONALITY.md / docs/ATLAS_VOICE_RATIFICATION_V1.md
// §1a). Shared by two consumers:
//   - test/voiceCorpusHarness.test.js — to LINT the Set C exemplars themselves
//     (prove every ✅ approved line is clean and every ❌ rejected line trips a
//     detector, so the corpus is internally consistent).
//   - scripts/voice-validation-live.js — to flag ADVISORY violations in sampled
//     live LLM output for owner review.
//
// SCOPE + HONESTY: these are heuristics, NOT a taste oracle. They surface
// evidence (a filler phrase, an emoji, a swear without permission, a digit not
// in the supplied facts). They do NOT score voice quality and MUST NEVER become
// a CI gate — model wording is nondeterministic. The genuine production
// protections (the deterministic register suppressor) live in
// services/coach.js `findRegisterViolations`; the live script uses THAT for the
// profanity / earned-vocab gate and these heuristics only as extra advisory
// signal. This module is test/advisory tooling — it is NOT wired into any
// runtime path.
//
// Every function is total (never throws) and takes a plain string.

// The six banned generic-praise fillers named in the persona core, plus close
// equivalents the model might substitute. Word-boundary, case-insensitive.
const FILLER_PHRASES = [
  /\bgreat work\b/i, /\bgreat job\b/i, /\bkeep it up\b/i, /\bsolid session\b/i,
  /\bstay consistent\b/i, /\bnice job\b/i, /\bwell done\b/i, /\bkeep pushing\b/i,
  /\bevery rep counts\b/i, /\byou'?ve got this\b/i, /\bbelieve in yourself\b/i,
  /\bproud of you\b/i, /\bkeep grinding\b/i,
];

// Gym-bro hype / anti-patterns the persona core bans outright.
const HYPE_PHRASES = [
  /\bbeast mode\b/i, /\bcrushing it\b/i, /\bkilling it\b/i, /\bon fire\b/i,
  /\blet'?s\s*go+\b/i, /\bno pain no gain\b/i, /\bsend it\b/i, /\bgo hard or go home\b/i,
];

// Coaching clichés the persona core bans as a CLASS — generic/participation
// praise ("praise for showing up, participation, or attendance"), empty
// reassurance, corporate apology, and permissive caving. The core names six
// specific fillers (FILLER_PHRASES); this is the broader "or any equivalent"
// family, curated from the Set C ❌ exemplars. Advisory only.
const CLICHE_PHRASES = [
  /\bnice work\b/i, /\bgood effort\b/i, /\bgood job\b/i, /\bcongratulations\b/i,
  /\bshowed up\b/i, /\bwhat matters\b/i, /\bgreat way to\b/i, /\blisten to your body\b/i,
  /\bwinners train\b/i, /\bsorry you feel\b/i, /\bso sorry\b/i, /\bsorry for the confusion\b/i,
  /\bthat'?s okay\b/i, /\bdon'?t worry\b/i, /\bkeep trying\b/i, /\btry harder\b/i,
  /\bwelcome back\b/i, /\bconsistency is key\b/i, /\byou did amazing\b/i, /\byou did great\b/i,
];

// Pet names — "intimacy comes from specifics, not vocabulary" (persona core).
const PET_NAMES = [
  /\bmy man\b/i, /\bchamp\b/i, /\bking\b/i, /\bbuddy\b/i, /\bbro\b/i, /\bbrother\b/i,
  /\bboss\b/i, /\bbeast\b/i, /\bwarrior\b/i,
];

// Genuine profanity (the D1 ceiling). Mirrors services/coach.js PROFANITY_TOKENS
// — the same token family the production suppressor gates on. Deliberately
// EXCLUDES mild casual words ("damn", "hell", "crap") that are casual register,
// not the D1 swear ("goddamn" stays).
const PROFANITY_TOKENS = [
  /\bfuck\w*/i, /\bshit\w*/i, /\basshole[s]?\b/i, /\bbitch\w*/i,
  /\bbastard[s]?\b/i, /\bgoddamn\w*/i, /\bpiss\w*/i, /\bdick\s?heads?\b/i,
];

// Earned-moment vocabulary — legitimate ONLY in celebrate/praise. Mirrors
// services/coach.js CELEBRATION_VOCAB.
const CELEBRATION_VOCAB = [
  /\bpersonal best\b/i, /\bnew\s+pr\b/i, /\bnew\s+record\b/i, /\bpr\s+today\b/i,
  /\bbroke\s+your\s+record\b/i, /\bcrushed it\b/i, /\bcrushing it\b/i,
];

// A conservative emoji / pictograph range (covers the common gym confetti).
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

function _str(x) {
  return typeof x === 'string' ? x : '';
}

function _matchAll(text, patterns) {
  const hits = [];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

// Filler / generic praise that says nothing specific.
function detectFiller(text) {
  return _matchAll(_str(text), FILLER_PHRASES);
}

// Gym-bro hype vocabulary.
function detectHype(text) {
  return _matchAll(_str(text), HYPE_PHRASES);
}

// Generic/participation-praise, empty-reassurance, apology, and caving clichés.
function detectCliche(text) {
  return _matchAll(_str(text), CLICHE_PHRASES);
}

// Pet names.
function detectPetNames(text) {
  return _matchAll(_str(text), PET_NAMES);
}

// Genuine profanity tokens present.
function detectProfanity(text) {
  return _matchAll(_str(text), PROFANITY_TOKENS);
}

// Earned-moment / PR vocabulary present.
function detectCelebrationVocab(text) {
  return _matchAll(_str(text), CELEBRATION_VOCAB);
}

// Emoji present (returns the offending characters).
function detectEmoji(text) {
  const s = _str(text);
  const out = [];
  for (const ch of s) {
    if (EMOJI_RE.test(ch)) out.push(ch);
  }
  return out;
}

// Exclamation stacking: two or more '!' anywhere, or any run of "!!".
function detectExclamationStacking(text) {
  const s = _str(text);
  const total = (s.match(/!/g) || []).length;
  const stacked = /!\s*!/.test(s);
  return stacked || total >= 2 ? { count: total, stacked } : null;
}

// Every DIGIT sequence in the text that is NOT in the allowed `citable` set.
// Word-numbers ("two", "forty") are intentionally out of scope — this proves the
// stronger, non-brittle claim that no numeric DIGIT absent from the supplied
// facts appears in the wording (the "never invent a number" grounding rule).
function detectUncitedNumbers(text, citable) {
  const s = _str(text);
  const allowed = new Set((Array.isArray(citable) ? citable : []).map(n => String(n)));
  const found = s.match(/\d+(?:\.\d+)?/g) || [];
  const out = [];
  for (const tok of found) {
    // Normalize a bare integer ("205") and a decimal ("2.5"); also allow a token
    // that is a substring-free exact member of citable.
    if (!allowed.has(tok) && !allowed.has(String(Number(tok)))) out.push(tok);
  }
  return out;
}

// Advisory length signal — a set-reaction should default to 1–4 short sentences.
function measureLength(text) {
  const s = _str(text).trim();
  const words = s ? s.split(/\s+/).length : 0;
  const sentences = s ? (s.match(/[.!?](?:\s|$)/g) || []).length || 1 : 0;
  return { words, sentences };
}

function exceedsLength(text, { maxWords = 60, maxSentences = 4 } = {}) {
  const { words, sentences } = measureLength(text);
  return words > maxWords || sentences > maxSentences;
}

// Does the text ask a question (challenge/pattern moments must ASK, not lecture)?
function isQuestionShaped(text) {
  return /\?/.test(_str(text));
}

module.exports = Object.freeze({
  FILLER_PHRASES,
  HYPE_PHRASES,
  CLICHE_PHRASES,
  PET_NAMES,
  PROFANITY_TOKENS,
  CELEBRATION_VOCAB,
  detectFiller,
  detectHype,
  detectCliche,
  detectPetNames,
  detectProfanity,
  detectCelebrationVocab,
  detectEmoji,
  detectExclamationStacking,
  detectUncitedNumbers,
  measureLength,
  exceedsLength,
  isQuestionShaped,
});
