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
];

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

// Returns true ONLY for an unambiguous endorsement. Everything else — decline, question,
// hedge, bare acknowledgement, empty — returns false.
function isExplicitEndorsement(text) {
  const s = normalize(text);
  if (!s) return false;
  if (s.includes('?')) return false;                                  // a question is not consent
  if (VETOES.some((v) => hasWholePhrase(s, v))) return false;
  return ENDORSEMENTS.some((e) => hasWholePhrase(s, e));
}

export { isExplicitEndorsement };
