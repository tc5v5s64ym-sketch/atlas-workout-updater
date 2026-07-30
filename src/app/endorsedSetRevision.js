// #1163 — deciding whether the athlete EXPLICITLY endorsed a proposed set-level prescription
// change ("keep the movement, the rest of the sets are now X").
//
// This lives outside app.js on purpose: the Phase-2 app.js freeze forbids growing the shell's
// session-state surface, and this is a decision, not a render. It is also deterministic by
// contract — the engine owns the decision, the LLM never does — so it is a bounded phrase test
// with no model call and no network.
//
// FAIL-CLOSED. A revision mutates the plan the athlete is training against, so silence, a
// question, a hedge, or a bare acknowledgement must never mutate it. Only an unambiguous
// affirmative endorses. `ok` / `alright` / `sure` are deliberately NOT endorsements: in gym
// conversation they are as often "I heard you" as "do it", and guessing wrong rewrites the
// prescription for every remaining set.

// Unambiguous affirmatives. Matched as whole phrases against the normalized message.
const ENDORSEMENTS = [
  'yes', 'yeah', 'yep', 'yup', 'ya', 'yah',
  'do it', 'lets do it', 'let us do it', 'lets do that', 'do that',
  'go ahead', 'go for it', 'sounds good', 'that works', 'works for me',
  'please do', 'affirmative', 'definitely', 'absolutely',
];

// Any of these anywhere in the message vetoes an endorsement, even beside an affirmative token
// ("no, let's do it" is contradictory — refuse rather than pick a side).
//
// `keep` / `leave` / `stick` / `stay` and the ORIGINAL-plan markers are vetoed as whole words
// (Phase 4 criterion 4 step (b)): "yes, keep the original" opens with an affirmative while
// declining the change, and the head-anchored rule below would otherwise have read it as consent
// and applied the very revision the athlete just refused. Vetoing here keeps ONE consent authority
// fail-closed for every caller — the card, the typed lane, and any future one.
const VETOES = [
  'no', 'nope', 'nah', 'not', 'dont', 'do not', 'never', 'skip',
  'keep', 'leave', 'stick', 'stay', 'original', 'as planned', 'as is', 'unchanged',
  'maybe', 'might', 'guess', 'probably', 'idk', 'unsure', 'not sure', 'hold off', 'wait',
  'cant', 'can not', 'wont', 'will not', 'shouldnt', 'rather', 'instead', 'later', 'yet',
];

// An accept/apply verb plus an unambiguous reference to the PROPOSAL (Phase 4 criterion 4 step (b),
// owner-approved phrase class 1: "apply that change", "go with that", "accept Atlas's change").
// Deliberately narrow: the object must be a demonstrative pronoun or a named change-noun, so a
// prescription statement ("make that 185") and a movement command ("do squats") can never read as
// consent. `Atlas's` normalizes to `atlass`, hence the optional trailing s.
// A bare `accept` / `approve` is admitted too: both verbs mean exactly one thing in reply to a
// proposal, and they are the direct answer to the two-choice question the follow-up lane asks.
const ACTION_ENDORSEMENT_RE = new RegExp(
  '^(?:'
  + '(?:accept|approve)'
  + '|(?:do|apply|accept|approve|make|use|go\\s+with)\\s+'
  + '(?:(?:it|that|this)'
  + '|(?:(?:that|the|this|your|atlass?|his|its)\\s+)?'
  + '(?:change|adjustment|revision|update|proposal|recommendation))'
  + ')$'
);

// Bounded conversational lead-ins that may precede an affirmative without weakening it
// ("ok yeah do it"). They are not endorsements on their own — see the fail-closed note above.
const LEAD_INS = ['ok', 'okay', 'k', 'alright', 'right', 'well', 'so', 'um', 'uh', 'yea'];

// TRAILING politeness, stripped from the END only. `please` deliberately does NOT belong in
// LEAD_INS: `please do` is itself an ENDORSEMENTS entry, and stripping the leading `please` left the
// unmatched word `do`, silently retiring a phrase this module has always accepted (Codex P2,
// round 5 — a regression introduced by the standalone-endorsement fix). Stripping from the end
// instead lets "do it please" pass without touching "please do".
const TRAILING_FILLER = ['please', 'then', 'now', 'thanks', 'thank you'];

function normalize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9?\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasWholePhrase(haystack, phrase) {
  return new RegExp(`(^|\\s)${phrase.replace(/\s+/g, '\\s+')}($|\\s)`).test(haystack);
}

// Strip a bounded run of conversational lead-ins from the FRONT only.
function stripLeadIns(s) {
  let out = s;
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    for (const lead of LEAD_INS) {
      out = out.replace(new RegExp(`^${lead}(\\s+|$)`), '');
    }
    if (out === before) break;
  }
  return out.trim();
}

// Is the WHOLE utterance nothing but affirmative phrases and conversational filler?
//
// A prefix match is not enough. "yes my knee hurts" and "sounds good but my knee hurts" both OPEN
// with an endorsement while carrying a safety report the athlete needs answered — approving on
// either would rewrite the remaining sets AND swallow the safety turn (Codex P1, this PR). So the
// endorsement must ACCOUNT FOR THE ENTIRE TURN: every token is consumed by an affirmative phrase or
// a lead-in, or there is no consent. Anything left over means the athlete said something more than
// yes, and something more than yes is not a yes.
// Strip a bounded run of trailing politeness from the END only.
function stripTrailingFiller(s) {
  let out = s;
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    for (const tail of TRAILING_FILLER) {
      out = out.replace(new RegExp(`(^|\\s)${tail.replace(/\s+/g, '\\s+')}$`), '');
    }
    out = out.trim();
    if (out === before) break;
  }
  return out;
}

function isEndorsementOnly(body) {
  let rest = body;
  let matched = false;
  for (let guard = 0; guard < 6; guard += 1) {
    rest = stripTrailingFiller(stripLeadIns(rest));
    if (!rest) break;
    // The action tier is end-anchored, so it can only match the whole remainder.
    if (ACTION_ENDORSEMENT_RE.test(rest)) { rest = ''; matched = true; break; }
    const hit = ENDORSEMENTS.find((e) => rest === e || rest.startsWith(`${e} `));
    if (!hit) return false;                                           // unconsumed content
    rest = rest.slice(hit.length).trim();
    matched = true;
  }
  return matched && !rest;
}

// Returns true ONLY for an unambiguous endorsement. Everything else — decline, question,
// hedge, bare acknowledgement, an endorsement carrying extra content, empty — returns false.
//
// The affirmative must OPEN the utterance (after at most a few lead-ins) AND account for all of it.
// An affirmative token anywhere in the sentence is not consent: "I can't say yes yet" contains `yes`
// while explicitly withholding it, and an anywhere-match would have rewritten every remaining set on
// it (Codex P2, #1188). Requiring the utterance to BEGIN with the affirmative is what separates
// "yeah, do it" from a sentence that merely mentions agreeing; requiring it to END there is what
// separates "yes" from "yes, my knee hurts".
function isExplicitEndorsement(text) {
  const s = normalize(text);
  if (!s) return false;
  if (s.includes('?')) return false;                                  // a question is not consent
  if (VETOES.some((v) => hasWholePhrase(s, v))) return false;
  const body = stripLeadIns(s);
  if (!body) return false;                                            // lead-ins alone are not consent
  if (isEndorsementOnly(body)) return true;
  // "please do it": the `please do` entry consumes the endorsement and leaves a dangling `it`. Retry
  // once with the leading politeness removed so the inner phrase (`do it`) is matched whole. Bounded
  // and fail-closed — a retry can only accept a phrase that is ITSELF entirely an endorsement, so
  // "please my knee hurts" still refuses.
  const withoutPolite = body.replace(/^(?:please|then|now)\s+/, '');
  return withoutPolite !== body && isEndorsementOnly(withoutPolite);
}

export { isExplicitEndorsement };
