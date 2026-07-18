/* Session plan executor — deterministic plan state from a planned list and a
 * completed list. Pure function, no I/O, no LLM, no Sheets writes.
 *
 * computePlanState(planned, completed) → { planned, completed, remaining, isComplete }
 *
 *   planned   – ordered array. Each entry may be either:
 *                 - a string exercise name, OR
 *                 - { name: string, liftCode?: string }
 *   completed – array. Same format as planned.
 *
 * An exercise in `planned` is considered done when ANY of the following hold:
 *   1. Its name matches a name in `completed` (case-insensitive), OR
 *   2. Both sides supply a non-empty liftCode and they match (case-insensitive).
 *      This covers the "Rows" (plan) vs "Barbell Row" (logged) identity mismatch
 *      when both carry the same lift_code.
 *
 * planned[] and completed[] in the RETURN value are always string arrays
 * (names only) so downstream consumers see a stable shape.
 *
 * remaining  = planned exercises not yet covered by either match rule above
 * isComplete = remaining.length === 0 AND planned.length > 0
 *
 * Non-string and blank entries in either array are silently dropped.
 */
'use strict';

function toRecord(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim();
    return name ? { name, liftCode: '' } : null;
  }
  if (entry && typeof entry === 'object') {
    const name = String(entry.name || '').trim();
    const liftCode = String(entry.liftCode || entry.lift_code || '').trim();
    return name ? { name, liftCode } : null;
  }
  return null;
}

function toRecords(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(toRecord).filter(Boolean);
}

// Normalize an exercise name for completion matching: lowercase, strip punctuation,
// and singularize each word (drop a trailing "s", but never from an "ss" ending like
// "press"). This makes a plural logged name match its singular plan entry — "Lateral
// Raises" ↔ "Lateral Raise", "Barbell Curls" ↔ "Barbell Curl", "Dips" ↔ "Dip" — so a
// completed exercise isn't re-read as remaining just because the logged form was
// plural. SAFE: word count and words are preserved (only trailing -s), so distinct
// exercises ("Bench Press" vs "Incline Bench Press") still never collide. It does NOT
// resolve abbreviations/aliases ("OHP" → "Overhead Press") — that needs the exercise
// catalog and belongs to the client's identity resolution / a lift-code match.
function normalizeExerciseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

/**
 * computePlanState(planned, completed) → { planned, completed, remaining, isComplete }
 */
function computePlanState(planned, completed) {
  const planRecs  = toRecords(planned);
  const doneRecs  = toRecords(completed);

  // F10 — authoritative completion identity: attribute each logged completion to AT
  // MOST ONE planned slot (greedy, in plan order), rather than broadcasting a done
  // name/code across the whole plan via Sets. Two same-named slots therefore stay
  // slot-distinct — one logged "Lat Pulldown" clears ONE of them, not both (the
  // duplicate-name bug). Matching per slot is the singular-normalized name (so a
  // plural logged name still completes its singular plan entry) then the
  // authoritative lift_code when both sides supply one. Exact identity only — no
  // substring guessing here (the client selector owns the substring/ambiguity rung).
  const claimed = new Array(planRecs.length).fill(false);
  for (const d of doneRecs) {
    const dName = normalizeExerciseName(d.name);
    const dCode = d.liftCode ? d.liftCode.toLowerCase() : '';
    let idx = planRecs.findIndex((r, i) => !claimed[i] && normalizeExerciseName(r.name) === dName);
    if (idx === -1 && dCode) {
      idx = planRecs.findIndex((r, i) => !claimed[i] && r.liftCode && r.liftCode.toLowerCase() === dCode);
    }
    if (idx !== -1) claimed[idx] = true;
  }

  const remaining = planRecs
    .filter((_r, i) => !claimed[i])
    .map(r => r.name);

  const planArr      = planRecs.map(r => r.name);
  const completedArr = doneRecs.map(r => r.name);

  return {
    planned:    planArr,
    completed:  completedArr,
    remaining,
    isComplete: planArr.length > 0 && remaining.length === 0
  };
}

/**
 * nextExerciseFromPlan(map, exerciseName)
 *
 * Pure lookup: given an ordered Map<lowercase-name, record> from the API plan,
 * returns the next exercise entry (or null for the last exercise).
 *
 * Return shape:
 *   { found: true,  next: string|null } — exercise was in the plan; next is the
 *                                          following entry's display name, or null
 *                                          when the matched exercise is the last.
 *   { found: false }                    — exercise was NOT in the plan; caller
 *                                          should use its fallback (e.g. activePlannedSession).
 *
 * Matching: exact lowercase first, then bidirectional substring.
 * When found, the result is AUTHORITATIVE — the caller must NOT consult any
 * fallback, because the API plan is the source of truth for plan order.
 *
 * This replicates the lookup block inside getNextExerciseInPlan
 * (public/coach-conversation.js) so the algorithm can be tested in Node.js
 * without a browser environment.
 * keep in sync with the "keep in sync" block in getNextExerciseInPlan (coach-conversation.js)
 */
function nextExerciseFromPlan(map, exerciseName) {
  if (!map || !map.size) return { found: false };
  const key = String(exerciseName || '').toLowerCase();
  const keys = Array.from(map.keys());
  let idx = keys.indexOf(key);
  if (idx === -1) idx = keys.findIndex(k => k.includes(key) || key.includes(k));
  if (idx === -1) return { found: false };
  if (idx >= keys.length - 1) return { found: true, next: null };
  const nextRec = map.get(keys[idx + 1]);
  return { found: true, next: (nextRec && (nextRec.exercise_name || nextRec.exercise)) || null };
}

/**
 * isPlanComplete(planned, completed) → boolean
 *
 * Convenience wrapper: true when planned is non-empty and every entry has a
 * match in completed (same rules as computePlanState). Used by regression tests
 * and any future server-side caller; the browser replicates the name-match logic
 * inline (no require() in classic scripts).
 */
function isPlanComplete(planned, completed) {
  return computePlanState(planned, completed).isComplete;
}

/**
 * applySubstitution(planned, prescribed, substitute) → { planned, substituted, applied }
 *
 * Records an in-session swap on the planned list: the `prescribed` exercise's
 * slot is replaced, IN PLACE (order preserved), by the `substitute` exercise.
 * This is how an accepted "X is taken, I'll do Y instead" swap updates the
 * authoritative session state so the prescribed exercise stops showing as
 * remaining and the substitute takes its place. (Roadmap Step 372.)
 *
 * Inputs (entries may be a string name or { name, liftCode }):
 *   planned    – ordered planned list
 *   prescribed – the planned exercise being swapped OUT (string or record)
 *   substitute – the exercise swapped IN (string or record). Its liftCode, when
 *                present, rides along so a later log under a different canonical
 *                name (e.g. plan "Rows" logged as "Barbell Row") still matches by
 *                code in computePlanState.
 *
 * Returns:
 *   planned     – updated ordered list as { name, liftCode } records (stable shape;
 *                 computePlanState accepts records directly)
 *   substituted – array of { from, to } applied swaps (empty when none applied)
 *   applied     – true when the prescribed slot was found and replaced
 *
 * No-op (applied:false, planned returned as records unchanged) when:
 *   - prescribed or substitute is blank / non-resolvable, OR
 *   - prescribed is not found in planned (by name or liftCode) — that is an
 *     'add', not a substitution; the caller decides what to do, OR
 *   - substitute resolves to the same NAME as prescribed (nothing to swap).
 *
 * Pure function. Never mutates its inputs.
 */
function applySubstitution(planned, prescribed, substitute) {
  const planRecs = toRecords(planned);
  const presc = toRecord(prescribed);
  const sub   = toRecord(substitute);

  if (!presc || !sub) return { planned: planRecs, substituted: [], applied: false };
  if (presc.name.toLowerCase() === sub.name.toLowerCase()) {
    return { planned: planRecs, substituted: [], applied: false };
  }

  const prescKey  = presc.name.toLowerCase();
  const prescCode = presc.liftCode.toLowerCase();

  const idx = planRecs.findIndex(r => {
    if (r.name.toLowerCase() === prescKey) return true;
    if (prescCode && r.liftCode.toLowerCase() === prescCode) return true;
    return false;
  });
  if (idx === -1) return { planned: planRecs, substituted: [], applied: false };

  const fromName = planRecs[idx].name;

  // Dedupe guard: if the substitute is ALREADY planned in another slot, drop the
  // prescribed slot instead of replacing it — otherwise the list would carry the
  // substitute twice and computePlanState would close both slots from a single
  // logged set.
  const subKey  = sub.name.toLowerCase();
  const subCode = sub.liftCode.toLowerCase();
  const dupElsewhere = planRecs.some((r, i) =>
    i !== idx && (
      r.name.toLowerCase() === subKey ||
      (subCode && r.liftCode.toLowerCase() === subCode)
    )
  );

  const updated = planRecs.slice();
  if (dupElsewhere) {
    updated.splice(idx, 1);
  } else {
    updated[idx] = { name: sub.name, liftCode: sub.liftCode };
  }

  return {
    planned: updated,
    substituted: [{ from: fromName, to: sub.name }],
    applied: true,
  };
}

/**
 * clampCursorAfterRemoval(index, removedIdx, newLength) → number
 *
 * When a dedupe-substitution splices the prescribed slot out of a LIVE session
 * (Step 373b), the session cursor must follow the removed entry:
 *   - shift left by one if the cursor was AFTER the removed slot, and
 *   - never point past the end (removing the current+last slot would otherwise
 *     leave the cursor out of bounds and crash the banner render).
 *
 * Pure helper so the browser's applySessionSubstitution cursor math is covered
 * by tests (the engine applySubstitution is index-free). Returns a valid index
 * in [0, newLength-1], or 0 when the list is now empty.
 */
function clampCursorAfterRemoval(index, removedIdx, newLength) {
  let next = Number.isInteger(index) ? index : 0;
  if (next > removedIdx) next -= 1;
  if (next >= newLength) next = Math.max(0, newLength - 1);
  return Math.max(0, next);
}

/**
 * planStateFromContext(context) → plan_state | null   (Step 377)
 *
 * Pure extraction of the authoritative plan_state from a raw chat-context object
 * ({ current_plan, plan_completed }). This is the SINGLE gate shared by the
 * /api/coach/chat snapshot builder (buildChatContext) and the LLM-down fallback
 * path, so both decide "do we have an authoritative session state?" identically:
 *
 *   - current_plan supplies the planned exercise names (strings or { name }), and
 *   - plan_completed MUST be present as an array (even []). When it is absent the
 *     client hasn't wired completed-tracking, so we return null rather than tell
 *     the coach "all exercises still outstanding" from stale data (the Step 375
 *     gate). An empty array is honored — that means "session started, nothing
 *     logged yet", which is authoritative.
 *
 * Returns the computePlanState result, or null when there is no authoritative
 * session state. Pure — no I/O.
 */
function planStateFromContext(context) {
  const cc = context && typeof context === 'object' ? context : {};
  const planNames = Array.isArray(cc.current_plan)
    ? cc.current_plan
        .map(e => (e && typeof e === 'object'
          ? (typeof e.name === 'string' ? e.name.trim() : null)
          : (typeof e === 'string' ? e.trim() : null)))
        .filter(Boolean)
    : [];
  if (planNames.length === 0 || !Array.isArray(cc.plan_completed)) return null;
  const completedNames = cc.plan_completed
    .filter(n => typeof n === 'string' && n.trim())
    .map(n => n.trim());
  return computePlanState(planNames, completedNames);
}

// Step 377 — Session-close question detection (deterministic).
//
// When the LLM coach is down or unconfigured, a question like "Ok so we are
// done?" used to dead-end at "Coach is unavailable". The engine already knows the
// answer from computePlanState, so we recognize the family of session-CLOSE
// questions here and answer them deterministically. Scoped tight on purpose:
// done / finished / complete / "that's it" / "that's everything" framings — NOT
// the separate "what should I do today?" planning ask.
const SESSION_CLOSE_PATTERNS = [
  /\bwe(?:'re| are)?\s+(?:all\s+)?done\b/,   // "we done", "we're done", "we are done", "are we done"
  /\b(?:i'?m|am i)\s+(?:all\s+)?done\b/,     // "i'm done", "am i done"
  /\ball done\b/,                            // "all done"
  /\b(?:i'?m|we'?re|are we)\s+(?:all\s+)?finished\b/,
  /\bthat'?s? (?:it|all|everything)\b/,      // "that's it", "thats everything", "that all"
  /\bis that (?:it|all|everything)\b/,       // "is that it", "is that everything"
  /\bwrapp?ed up\b/,                         // "wrapped up", "wraped up"
  /\bdone (?:for (?:the day|today)|here|now)\b/, // "done for the day", "done here"
  // A message that is essentially just the close word — "done?", "ok done",
  // "so all finished?", "complete". Anchored whole-message so it never fires on
  // "I'm not done" or "done a set" mid-sentence.
  /^\s*(?:ok(?:ay)?,?\s+)?(?:so\s+)?(?:all\s+)?(?:done|finished|complete)\b[\s.!?]*$/,
];
function detectSessionCloseQuestion(message) {
  const t = String(message || '').toLowerCase();
  if (!t.trim()) return false;
  return SESSION_CLOSE_PATTERNS.some(re => re.test(t));
}

/**
 * buildSessionCloseAnswer(message, planState) → string | null   (Step 377)
 *
 * Deterministic answer to a session-close question. Returns null (so the caller's
 * generic fallback runs) unless BOTH hold:
 *   1. the message is a recognized session-close question, AND
 *   2. planState carries an authoritative, non-empty plan.
 *
 * When it fires:
 *   - plan complete  → confirm the session is done and point at the save step.
 *   - work remaining → say it's not done and name what is still on the list.
 *
 * The engine owns the count and the names; this only words them — it never writes
 * and never triggers the save (the lifter still says "log it"). Pure.
 */
function buildSessionCloseAnswer(message, planState) {
  if (!detectSessionCloseQuestion(message)) return null;
  if (!planState || !Array.isArray(planState.planned) || planState.planned.length === 0) return null;

  if (planState.isComplete) {
    const n = planState.planned.length;
    return `That's your plan done — ${n} exercise${n === 1 ? '' : 's'} complete. Say "log it" to save.`;
  }

  const remaining = Array.isArray(planState.remaining) ? planState.remaining : [];
  const left = remaining.length;
  return `Not done yet — ${left} still on your list: ${remaining.join(', ')}. Knock ${left === 1 ? 'it' : 'those'} out, then say "log it" to save.`;
}

/**
 * nextRemainingExercise(planned, completed) → string | null
 *
 * The next exercise still to do: the FIRST planned entry (in the planned/visible
 * order) not yet covered by computePlanState's match rules. Returns null when the
 * plan is complete or empty. This is what a "next up" handoff should point at — it
 * follows the visible plan order and skips anything already logged, whether the
 * lifter logged in order or jumped around. Pure.
 *
 * keep in sync with the inline nextPlanned computation in emitSetLogged
 * (public/app.js).
 */
function nextRemainingExercise(planned, completed) {
  const { remaining } = computePlanState(planned, completed);
  return remaining.length ? remaining[0] : null;
}

module.exports = {
  computePlanState,
  nextExerciseFromPlan,
  nextRemainingExercise,
  isPlanComplete,
  applySubstitution,
  clampCursorAfterRemoval,
  planStateFromContext,
  detectSessionCloseQuestion,
  buildSessionCloseAnswer,
};
