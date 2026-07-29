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
const VETOES = [
  'no', 'nope', 'nah', 'not', 'dont', 'do not', 'never', 'skip', 'leave it', 'keep it',
  'maybe', 'might', 'guess', 'probably', 'idk', 'unsure', 'not sure', 'hold off', 'wait',
  'cant', 'can not', 'wont', 'will not', 'shouldnt', 'rather', 'instead', 'later', 'yet',
];

// Bounded conversational lead-ins that may precede an affirmative without weakening it
// ("ok yeah do it"). They are not endorsements on their own — see the fail-closed note above.
const LEAD_INS = ['ok', 'okay', 'k', 'alright', 'right', 'well', 'so', 'um', 'uh', 'yea'];

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

// Returns true ONLY for an unambiguous endorsement. Everything else — decline, question,
// hedge, bare acknowledgement, empty — returns false.
//
// The affirmative must OPEN the utterance (after at most a few lead-ins). An affirmative token
// anywhere in the sentence is not consent: "I can't say yes yet" contains `yes` while explicitly
// withholding it, and an anywhere-match would have rewritten every remaining set on it
// (Codex P2, this PR). Requiring the utterance to BEGIN with the affirmative is what separates
// "yeah, do it" from a sentence that merely mentions agreeing.
function isExplicitEndorsement(text) {
  const s = normalize(text);
  if (!s) return false;
  if (s.includes('?')) return false;                                  // a question is not consent
  if (VETOES.some((v) => hasWholePhrase(s, v))) return false;
  const body = stripLeadIns(s);
  if (!body) return false;                                            // lead-ins alone are not consent
  return ENDORSEMENTS.some((e) => body === e || body.startsWith(`${e} `));
}

export { isExplicitEndorsement };
