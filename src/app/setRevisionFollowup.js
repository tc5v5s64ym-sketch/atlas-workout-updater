// Phase 4 criterion 4 step (b) — the natural-language follow-up to an active set-revision
// proposal, classified as LANGUAGE ONLY.
//
// WHY THIS EXISTS. #1189/#1194 built the trusted set-revision state machine and the Approve /
// Keep Original / Ask Why card, but only the card could reach it. A typed "do that" against a live
// proposal fell through to the coach, so natural conversation and the card were two different
// products. The owner approved exactly five phrase classes; this module decides which one an
// utterance is, and nothing else.
//
// HARD BOUNDARY. This module is PURE LANGUAGE. It never reads or mutates the proposal store, calls
// no route, emits no revision, and — decisively — derives NO identity: no proposal id, no plan item,
// no lift code, no prescription, no affected sets, no accepted set count. The stored structured
// proposal is the only authority for all of those, and the thin orchestration layer in the app shell
// is what reads it. A classifier that could name a lift could name the WRONG lift.
//
// CONSENT IS NOT DECIDED HERE EITHER. The approve class delegates to `isExplicitEndorsement` — the
// same single consent authority the card's Approve button and `decideApproval` already use — so the
// classifier and the approval handler can never disagree about what counts as a yes.
//
// UNDER-CALL, NEVER OVERREACH. Every tier is head-anchored and bounded. A phrase that does not
// clearly belong to one of the five classes returns `no_match`, and the turn falls through to the
// existing lanes exactly as it does today. Ambiguity clarifies; it never mutates plan state.

import { isExplicitEndorsement } from './endorsedSetRevision.js';

const FOLLOWUP_ACTIONS = [
  'approve_active_proposal',
  'explain_active_proposal',
  'reject_active_proposal',
  'clarify_keep',
  'clarify_set_scope',
  'clarify_drop_dimension',
  'no_match',
];

const NO_MATCH = { action: 'no_match' };

// Same normalization the consent authority uses: lowercase, apostrophes dropped (so "Atlas's"
// becomes "atlass" and a mobile curly quote behaves like a straight one), punctuation to spaces,
// `?` preserved because a question is never consent.
function normalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9?\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A bounded run of conversational lead-ins, stripped from the FRONT only, so "ok, just keep it"
// reaches the same tier as "keep it". Affirmative lead-ins are included deliberately: "yes, keep
// the original" is a REJECTION, and reading its "yes" as consent would apply the very change the
// athlete just declined.
const LEAD_INS = [
  'ok', 'okay', 'k', 'alright', 'right', 'well', 'so', 'um', 'uh', 'hey', 'actually',
  'yes', 'yeah', 'yep', 'yup', 'ya', 'yea', 'sure', 'and', 'but', 'then',
  'just', 'please', 'lets', 'let us', 'i think', 'i guess', 'maybe',
];

function stripLeadIns(s) {
  let out = s;
  for (let i = 0; i < 4; i += 1) {
    const before = out;
    for (const lead of LEAD_INS) {
      out = out.replace(new RegExp(`^${lead.replace(/\s+/g, '\\s+')}(?:\\s+|$)`), '');
    }
    if (out === before) break;
  }
  return out.trim();
}

// ── phrase 2: "why that weight?" ──────────────────────────────────────────────
// Three conditions, all required. A "why" that carries its own subject ("why do I keep stalling on
// deadlifts") is a coaching question and must reach the coach, so the utterance has to refer back to
// the proposal (a demonstrative or "it") AND name something the proposal actually holds.
const WHY_HEAD_RE = /^(?:why|how come)\b/;
const PROPOSAL_REF_RE = /\b(?:that|those|this|these|it)\b/;
const WHY_SUBJECT_RE = /\b(?:weight|weights|load|number|numbers|rep|reps|rir|change|changing|adjustment|revision|target|much|many|drop|dropping|lower|lowering|light|lighter|heavy|heavier|less|more)\b/;

// ── phrase 3: "keep it" vs "keep the original" ────────────────────────────────
// An ORIGINAL marker turns an ambiguous "keep" into an unambiguous rejection.
const ORIGINAL_MARKER_RE = /\b(?:original|as\s+planned|as\s+is|as\s+it\s+is|as\s+it\s+was|unchanged|the\s+same|alone|the\s+plan|planned)\b/;
// Unambiguous rejections that need no "keep": a cancel is a cancel.
const CANCEL_RE = /^(?:dont\s+change\s+(?:it|that|this|them|those|anything)|do\s+not\s+change\s+(?:it|that|this|them|those|anything)|no\s+change(?:s)?|forget\s+it|cancel\s+(?:it|that)?|nevermind|never\s+mind)\b/;
// The ambiguous keep: a keep/leave verb whose object is a bare pronoun. Atlas's own proposal reads
// "Keep Back Squat and take the rest of the sets to X", so "keep it" can mean keep the ORIGINAL
// plan, keep Atlas's CHANGE, keep the current weight, or keep the exercise. Four readings, three of
// which contradict each other — so it asks.
const AMBIGUOUS_KEEP_RE = /^(?:keep|leave)\s+(?:it|that|this|them|those|these)(?:\s+(?:there|for\s+now))?$/;
const BARE_KEEP_RE = /^(?:keep|leave)$/;

// ── phrase 5: "drop those" ────────────────────────────────────────────────────
// "Drop" can mean lower the weight, lower the reps, remove the sets, or reject the proposal. The
// object must be a pronoun or a set-scope phrase; a NAMED target ("drop squats") is a real skip and
// belongs to the existing plan-mutation lane, untouched.
const DROP_VERB_RE = /^(?:drop|lower|reduce|cut|ditch|take\s+down|bring\s+down|back\s+off(?:\s+(?:on|of))?)\s+(.+)$/;
const BARE_PRONOUN_RE = /^(?:it|that|this|them|those|these)$/;

// ── phrase 4: "the last two sets" ─────────────────────────────────────────────
// A scope FRAGMENT: it names sets and nothing to do to them. The count is the athlete's own word —
// it is used only to phrase the question and to compare against the structured future-set count the
// shell reads from the stored proposal. It is never a prescription and never selects rows.
const COUNT_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  a: 1, an: 1, couple: 2, few: 3, both: 2,
};
const SET_SCOPE_RE = new RegExp(
  '^(?:(?:the|those|these|my|all)\\s+)*'                           // optional determiners
  + '(?:(last|final|remaining|next|first)\\s+)?'                   // position
  + '(?:(\\d+|one|two|three|four|five|six|a|an|couple|few|both)\\s+)?'  // count
  + '(?:(last|final|remaining|next)\\s+)?'                         // position after the count
  + '(sets?)$'
);

function parseSetScope(body) {
  const m = SET_SCOPE_RE.exec(body);
  if (!m) return null;
  const position = m[1] || m[3] || null;
  const raw = m[2] || null;
  let count = null;
  if (raw != null) {
    count = /^\d+$/.test(raw) ? Number(raw) : (COUNT_WORDS[raw] != null ? COUNT_WORDS[raw] : null);
    if (count != null && (!Number.isFinite(count) || count <= 0)) count = null;
  } else if (m[4] === 'set') {
    count = 1;                              // "the last set" names exactly one
  }
  return { count, position, raw: body };
}

/**
 * classifySetRevisionFollowup(text) → { action, setScope? }
 *
 * `action` is always one of FOLLOWUP_ACTIONS. `setScope` is present only on the two set-scoped
 * classes and carries `{ count, position, raw }` — language, not identity.
 */
function classifySetRevisionFollowup(text) {
  const s = normalize(text);
  if (!s) return NO_MATCH;

  const body = stripLeadIns(s);
  if (!body) return NO_MATCH;               // lead-ins alone ("ok", "sure", "alright") decide nothing

  // 1. Explanation first. "why are we dropping it?" mentions dropping, and a question is never an
  //    action — asking must never be able to fall into an executing or rejecting tier.
  if (WHY_HEAD_RE.test(body) && PROPOSAL_REF_RE.test(body) && WHY_SUBJECT_RE.test(body)) {
    return { action: 'explain_active_proposal' };
  }
  // A bare "why" question that names its own subject stays with the coach; so does any other
  // question. Nothing below this line may execute on a question.
  const isQuestion = s.includes('?');

  // 2. Unambiguous rejection.
  if (!isQuestion && (CANCEL_RE.test(body) || (/^(?:keep|leave|stick|stay|go)\b/.test(body) && ORIGINAL_MARKER_RE.test(body)))) {
    return { action: 'reject_active_proposal' };
  }

  // 3. The ambiguous keep.
  if (!isQuestion && (AMBIGUOUS_KEEP_RE.test(body) || BARE_KEEP_RE.test(body))) {
    return { action: 'clarify_keep' };
  }

  // 4. The ambiguous drop. Pronoun or set-scope object only.
  const drop = DROP_VERB_RE.exec(body);
  if (!isQuestion && drop) {
    const object = drop[1].trim();
    if (BARE_PRONOUN_RE.test(object)) return { action: 'clarify_drop_dimension' };
    // A bare "drop set(s)" is not a follow-up: "drop set" is a training TECHNIQUE, which the
    // existing plan-mutation classifier already refuses to read as a removal, and this lane must
    // not read it as a question about the proposal either.
    if (!/^sets?$/.test(object)) {
      const scope = parseSetScope(object);
      if (scope) return { action: 'clarify_drop_dimension', setScope: scope };
    }
    return NO_MATCH;                        // a NAMED target is the existing skip lane's turn
  }

  // 5. Consent, decided by the one shared authority — never re-derived here. Checked after the
  //    rejection and clarification tiers so a "yes" glued to a decline can never approve.
  if (isExplicitEndorsement(text)) return { action: 'approve_active_proposal' };

  // 6. A bare scope fragment with no action at all.
  if (!isQuestion) {
    const scope = parseSetScope(body);
    if (scope) return { action: 'clarify_set_scope', setScope: scope };
  }

  return NO_MATCH;
}

export { FOLLOWUP_ACTIONS, classifySetRevisionFollowup };
