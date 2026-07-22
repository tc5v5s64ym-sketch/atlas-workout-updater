'use strict';

// Atlas Soul Corpus V2 — the fifteen sessions as REPLAYABLE turn sequences.
//
// Source of truth: docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md (owner reference input).
// This file encodes each session's turns into the structured facts the REAL read-only
// coach seam consumes (POST /api/coach/message with { kind, facts }, and the read-only
// POST /api/coach/chat for conversational turns), so the Corpus Baseline Runner can
// replay them turn-by-turn against the real deterministic engine.
//
// FIDELITY: weights/reps/RIR, substitutions, and the redline/failure and client-PR beats
// mirror the corpus. Purely conversational beats (a question, an emotional line) are
// encoded as `chat` turns so the seam is exercised, but the runner never credits the
// LLM's WORDS — only deterministic engine + packet signals count (see services/corpusBaselineRubric.js).
//
// SEGREGATION: every athlete profile is SYNTHETIC (synthetic_profile: true) and every
// session carries synthetic: true. The runner stamps corpus_synthetic on every turn
// observation and NEVER enables the ATLAS_INTERACTION_TRACE=shadow log stream, so nothing
// here can leak into the real [coach-turn-shadow] / divergence data. Test mode only —
// sheets.js is stubbed; no live write is ever attempted.
//
// kind: 'plan'  → "what are we doing today?" (the plan voice seam)
//       'block' → a logged exercise block (the primary in-session reaction seam)
//       'set'   → a single logged set
//       'chat'  → a free-form question / emotional line (read-only Q&A seam)

// Routine on-plan rec: the engine tiers this to ack_only (deliberate silence).
const ROUTINE = { effort_verdict: { level: 'on_target' }, progression_verdict: { level: 'in_pocket' } };
// A client-supplied elevation claim (a "PR"): the scarcity gate must NOT elevate it
// without server-confirmed history — that refusal is the praise-economy signal.
const CLIENT_PR = { progression_verdict: { level: 'new_ground' } };

const SESSIONS = [
  // ── PART I — the owner's five sessions ──────────────────────────────────────
  {
    id: 'S1', name: 'On-target bench work that means something', part: 'core', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'strength', label: 'Owner — strength' },
    turns: [
      { kind: 'plan', facts: { exerciseName: 'Bench Press' }, demonstrates: [1, 2] },
      { kind: 'block', facts: { exerciseName: 'Bench Press', muscleGroup: 'Chest',
        todaySets: [{ weight: 225, reps: 6, rir: 2 }, { weight: 225, reps: 6, rir: 2 }, { weight: 225, reps: 6, rir: 2 }], rec: ROUTINE },
        demonstrates: [5, 31], note: 'Second clean repeat at 225 6/2 x3 — routine on-plan.' },
      { kind: 'chat', text: 'How much has my bench increased over the last three months?', demonstrates: [7, 11, 26] },
      { kind: 'block', facts: { exerciseName: 'Incline Dumbbell Bench', muscleGroup: 'Chest',
        todaySets: [{ weight: 75, reps: 8, rir: 2 }, { weight: 75, reps: 7, rir: 1 }, { weight: 75, reps: 6, rir: 1 }], rec: ROUTINE },
        demonstrates: [8, 9, 10], note: 'Rep decay under pressing fatigue.' },
      { kind: 'chat', text: 'Kind of annoying — incline felt weak today.', demonstrates: [27, 10] },
      { kind: 'block', facts: { exerciseName: 'Seated Rows', muscleGroup: 'Back',
        todaySets: [{ weight: 190, reps: 10, rir: 2 }, { weight: 190, reps: 10, rir: 2 }, { weight: 190, reps: 10, rir: 2 }], rec: ROUTINE },
        demonstrates: [5], note: 'Third repeat at 190 — a bump is earned.' },
    ],
  },
  {
    id: 'S2', name: '14-day layoff changes the plan', part: 'core', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'strength', label: 'Owner — re-entry' },
    turns: [
      { kind: 'plan', facts: { exerciseName: 'Bench Press' }, demonstrates: [2, 4] },
      { kind: 'chat', text: 'Why not just do 225?', demonstrates: [4] },
      { kind: 'block', facts: { exerciseName: 'Bench Press', muscleGroup: 'Chest',
        todaySets: [{ weight: 215, reps: 6, rir: 2 }, { weight: 215, reps: 6, rir: 2 }, { weight: 215, reps: 5, rir: 1 }], rec: ROUTINE },
        demonstrates: [4, 24], note: 'Re-entry read after a gap.' },
      { kind: 'chat', text: 'So did I lose strength?', demonstrates: [24, 26] },
      { kind: 'block', facts: { exerciseName: 'Overhead Press', muscleGroup: 'Shoulders',
        todaySets: [{ weight: 115, reps: 8, rir: 2 }, { weight: 115, reps: 8, rir: 2 }, { weight: 115, reps: 8, rir: 2 }], rec: ROUTINE },
        demonstrates: [11], note: 'Cross-lift evidence: OHP held.' },
      { kind: 'chat', text: 'I still think I could have done 225.', demonstrates: [26, 35] },
    ],
  },
  {
    id: 'S3', name: 'Fatigue from earlier lifts changes the rest', part: 'core', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'strength', label: 'Owner — squat day' },
    turns: [
      { kind: 'plan', facts: { exerciseName: 'Romanian Deadlift' }, demonstrates: [1, 22] },
      { kind: 'block', facts: { exerciseName: 'Romanian Deadlift', muscleGroup: 'Legs',
        todaySets: [{ weight: 225, reps: 8, rir: 2 }, { weight: 225, reps: 8, rir: 1 }, { weight: 225, reps: 7, rir: 1 }], rec: ROUTINE },
        demonstrates: [8, 9], note: 'RIR decay drives a squat trim.' },
      { kind: 'chat', text: 'I thought we were squatting 225.', demonstrates: [9] },
      { kind: 'block', facts: { exerciseName: 'Back Squat', muscleGroup: 'Legs',
        todaySets: [{ weight: 215, reps: 6, rir: 2 }, { weight: 215, reps: 6, rir: 2 }, { weight: 215, reps: 6, rir: 1 }], rec: ROUTINE },
        demonstrates: [9, 10], note: 'Trimmed squat holds.' },
      { kind: 'block', facts: { exerciseName: 'Leg Extension', muscleGroup: 'Legs',
        todaySets: [{ weight: 150, reps: 12, rir: 2 }, { weight: 150, reps: 10, rir: 1 }], rec: ROUTINE },
        demonstrates: [10], note: 'Fatigued accessory — baseline protected.' },
      { kind: 'chat', text: 'Should we do extensions before squats next time?', demonstrates: [22, 30] },
    ],
  },
  {
    id: 'S4', name: 'Equipment substitution without fake equivalence', part: 'core', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'strength', label: 'Owner — substitution' },
    turns: [
      { kind: 'chat', text: 'Bench is packed. Can I use the chest-press machine?', demonstrates: [13, 15] },
      { kind: 'block', facts: { exerciseName: 'Machine Chest Press', muscleGroup: 'Chest',
        todaySets: [{ weight: 120, reps: 10, rir: 4 }, { weight: 140, reps: 8, rir: 2 }, { weight: 150, reps: 8, rir: 0 }],
        substitution: { classification: 'substituted', prescribed: { name: 'Bench Press' }, logged: { name: 'Machine Chest Press' } } },
        demonstrates: [13, 14, 15], note: 'Finder ascends; 150 @0 overshoots.' },
      { kind: 'block', facts: { exerciseName: 'Machine Chest Press', muscleGroup: 'Chest',
        todaySets: [{ weight: 140, reps: 8, rir: 2 }, { weight: 140, reps: 8, rir: 2 }], rec: ROUTINE },
        demonstrates: [14], note: 'Repeatable working weight found.' },
      { kind: 'chat', text: 'Bench just opened. Should I switch back?', demonstrates: [17] },
      { kind: 'block', facts: { exerciseName: 'Seated Rows', muscleGroup: 'Back',
        todaySets: [{ weight: 190, reps: 10, rir: 2 }, { weight: 190, reps: 10, rir: 2 }], rec: ROUTINE },
        demonstrates: [32], note: 'Clean pulls — routine, brief.' },
    ],
  },
  {
    id: 'S5', name: 'Readiness-aware deadlift day + correction', part: 'core', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'strength', label: 'Owner — low sleep' },
    turns: [
      { kind: 'plan', facts: { exerciseName: 'Deadlift' }, demonstrates: [3], note: 'Five hours of sleep changes the target.' },
      { kind: 'block', facts: { exerciseName: 'Deadlift', muscleGroup: 'Legs',
        todaySets: [{ weight: 245, reps: 6, rir: 2 }, { weight: 225, reps: 6, rir: 2 }, { weight: 225, reps: 6, rir: 2 }], rec: ROUTINE },
        demonstrates: [3], note: 'One top set + back-offs under readiness limit.' },
      { kind: 'chat', text: 'Actually the first back-off was 215, not 225.', demonstrates: [18], note: 'Conversational correction.' },
      { kind: 'chat', text: 'Can I add RDLs?', demonstrates: [17] },
      { kind: 'block', facts: { exerciseName: 'Seated Rows', muscleGroup: 'Back',
        todaySets: [{ weight: 190, reps: 10, rir: 2 }, { weight: 190, reps: 10, rir: 2 }, { weight: 190, reps: 8, rir: 1 }], rec: ROUTINE },
        demonstrates: [10, 26], note: 'Late fade — no bump, no downgrade.' },
    ],
  },
  // ── PART II — ten new athletes ─────────────────────────────────────────────
  {
    id: 'S6', name: 'Marcus — strength purist, moves fast', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'strength', label: 'Marcus — terse, 6yr' },
    turns: [
      { kind: 'plan', facts: { exerciseName: 'Back Squat' }, demonstrates: [1, 32] },
      { kind: 'block', facts: { exerciseName: 'Back Squat', muscleGroup: 'Legs',
        todaySets: [{ weight: 315, reps: 3, rir: 4 }], rec: CLIENT_PR },
        demonstrates: [23, 31], note: 'Better-than-expected @4 — banked, not spent.' },
      { kind: 'block', facts: { exerciseName: 'Back Squat', muscleGroup: 'Legs',
        todaySets: [{ weight: 290, reps: 5, rir: 2 }, { weight: 290, reps: 5, rir: 2 }, { weight: 290, reps: 5, rir: 2 }], rec: ROUTINE },
        demonstrates: [32], note: 'Clean back-offs — near-silence.' },
      { kind: 'block', facts: { exerciseName: 'Romanian Deadlift', muscleGroup: 'Legs',
        todaySets: [{ weight: 285, reps: 6, rir: 2 }, { weight: 285, reps: 6, rir: 2 }, { weight: 285, reps: 6, rir: 2 }], rec: ROUTINE },
        demonstrates: [19], note: '285 logged vs 275 plan — a discrepancy to verify.' },
      { kind: 'chat', text: 'Typo. 275.', demonstrates: [18, 5], note: 'Correction → earned bump.' },
    ],
  },
  {
    id: 'S7', name: 'Priya — beginner who needs the words', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'general_health', label: 'Priya — 11 weeks' },
    turns: [
      { kind: 'plan', facts: { exerciseName: 'Goblet Squat' }, demonstrates: [1] },
      { kind: 'chat', text: 'What does the "2 reps left in the tank" thing mean again?', demonstrates: [30], note: 'RIR taught at her level.' },
      { kind: 'block', facts: { exerciseName: 'Goblet Squat', muscleGroup: 'Legs',
        todaySets: [{ weight: 35, reps: 10, rir: 2 }, { weight: 35, reps: 10, rir: 2 }, { weight: 35, reps: 10, rir: 1 }], rec: ROUTINE },
        demonstrates: [5, 31], note: 'Well-judged effort at a new load.' },
      { kind: 'block', facts: { exerciseName: 'Dumbbell Bench', muscleGroup: 'Chest',
        todaySets: [{ weight: 25, reps: 8, rir: 0 }, { weight: 25, reps: 8, rir: 0 }, { weight: 25, reps: 8, rir: 0 }], rec: ROUTINE },
        demonstrates: [30, 27], note: 'Stopped on form wobble — a legitimate set end.' },
      { kind: 'chat', text: 'Am I actually getting anywhere or am I just doing baby weights?', demonstrates: [27, 31] },
    ],
  },
  {
    id: 'S8', name: 'Jonas — runner, two sports', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'general_health', label: 'Jonas — concurrent' },
    turns: [
      { kind: 'chat', text: '10k tempo this morning, legs at ~70%. Do we still squat?', demonstrates: [3], note: 'Readiness-adjusted prescription.' },
      { kind: 'block', facts: { exerciseName: 'Back Squat', muscleGroup: 'Legs',
        todaySets: [{ weight: 185, reps: 5, rir: 3 }, { weight: 185, reps: 5, rir: 3 }, { weight: 185, reps: 5, rir: 2 }], rec: ROUTINE },
        demonstrates: [3], note: 'Trimmed squat verifies the 70% call.' },
      { kind: 'block', facts: { exerciseName: 'Seated Rows', muscleGroup: 'Back',
        todaySets: [{ weight: 140, reps: 10, rir: 2 }, { weight: 140, reps: 8, rir: 2 }, { weight: 140, reps: 8, rir: 2 }], rec: ROUTINE },
        demonstrates: [12], note: 'Reps drop at stable RIR → grip limiter hypothesis.' },
      { kind: 'chat', text: 'The internet says lifting legs in a race block is pointless. Thoughts?', demonstrates: [30, 26] },
    ],
  },
  {
    id: 'S9', name: 'Ray — two-a-days on shift', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'general_health', label: 'Ray — shift worker' },
    turns: [
      { kind: 'block', facts: { exerciseName: 'Trap Bar Deadlift', muscleGroup: 'Legs',
        todaySets: [{ weight: 245, reps: 5, rir: 3 }, { weight: 245, reps: 5, rir: 3 }, { weight: 245, reps: 5, rir: 3 }], rec: ROUTINE },
        demonstrates: [20, 1], note: 'Batch-logged late — still a full read.' },
      { kind: 'chat', text: 'PM window opens 1600, what\'s the move? On shift tomorrow.', demonstrates: [3, 1] },
      { kind: 'chat', text: '1620. Got 4 x 500 in, tones dropped, had to bail. Annoyed.', demonstrates: [20, 28], note: 'Truncated ≠ skipped.' },
      { kind: 'chat', text: 'Tomorrow\'s a 24. If it\'s quiet can I lift at the house?', demonstrates: [29, 35] },
    ],
  },
  {
    id: 'S10', name: 'Ellen — 61, patient, getting stronger', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'general_health', label: 'Ellen — older athlete' },
    turns: [
      { kind: 'chat', text: 'Knees are on the stiff side today. What\'s the plan?', demonstrates: [3, 29], note: 'Symptom-informed swap to leg press.' },
      { kind: 'block', facts: { exerciseName: 'Leg Press', muscleGroup: 'Legs',
        todaySets: [{ weight: 230, reps: 8, rir: 2 }, { weight: 230, reps: 8, rir: 2 }, { weight: 230, reps: 8, rir: 2 }],
        substitution: { classification: 'substituted', prescribed: { name: 'Back Squat' }, logged: { name: 'Leg Press' } } },
        demonstrates: [13, 3], note: 'Matches a best from a stiff start.' },
      { kind: 'block', facts: { exerciseName: 'Incline Dumbbell Bench', muscleGroup: 'Chest',
        todaySets: [{ weight: 30, reps: 10, rir: 2 }, { weight: 30, reps: 10, rir: 2 }, { weight: 30, reps: 10, rir: 3 }], rec: ROUTINE },
        demonstrates: [5, 6], note: 'Rising terminal reserve → small step to 32.5s.' },
    ],
  },
  {
    id: 'S11', name: 'Dev — ten weeks away', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'strength', label: 'Dev — 10-week layoff' },
    turns: [
      { kind: 'plan', facts: { exerciseName: 'Bench Press' }, demonstrates: [2, 4], note: 'Restart, not damage.' },
      { kind: 'block', facts: { exerciseName: 'Bench Press', muscleGroup: 'Chest',
        todaySets: [{ weight: 185, reps: 6, rir: 3 }, { weight: 185, reps: 6, rir: 3 }, { weight: 185, reps: 6, rir: 2 }], rec: ROUTINE },
        demonstrates: [4, 24], note: 'Restart block session 1.' },
      { kind: 'block', facts: { exerciseName: 'Plate-Loaded Row', muscleGroup: 'Back',
        todaySets: [{ weight: 205, reps: 10, rir: 3 }, { weight: 230, reps: 10, rir: 2 }, { weight: 230, reps: 10, rir: 2 }],
        substitution: { classification: 'substituted', prescribed: { name: 'Cable Row' }, logged: { name: 'Plate-Loaded Row' } } },
        demonstrates: [14, 15], note: 'Self-run finder on a new machine.' },
      { kind: 'chat', text: 'Three weeks to 205 — you actually believe that or is that coach talk?', demonstrates: [25, 26] },
    ],
  },
  {
    id: 'S12', name: 'Sam — the streak that keeps not starting', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'general_health', label: 'Sam — adherence' },
    turns: [
      { kind: 'chat', text: 'It\'s been 9 days. Almost didn\'t message you, what\'s the point.', demonstrates: [28, 27], note: 'Highest-risk adherence moment.' },
      { kind: 'block', facts: { exerciseName: 'Goblet Squat', muscleGroup: 'Legs',
        todaySets: [{ weight: 45, reps: 8, rir: 2 }, { weight: 45, reps: 8, rir: 2 }, { weight: 45, reps: 8, rir: 2 }], rec: ROUTINE },
        demonstrates: [32], note: 'Short session, soft opener.' },
      { kind: 'block', facts: { exerciseName: 'Dumbbell Bench', muscleGroup: 'Chest',
        todaySets: [{ weight: 40, reps: 8, rir: 2 }, { weight: 40, reps: 8, rir: 2 }, { weight: 40, reps: 8, rir: 2 }], rec: ROUTINE },
        demonstrates: [32], note: 'Landed with room to spare.' },
      { kind: 'chat', text: 'Should I just say I\'ll come Thursday? I hate saying it and then not.', demonstrates: [28, 35] },
    ],
  },
  {
    id: 'S13', name: 'Tara — training around a shoulder', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'strength', label: 'Tara — pain-aware' },
    turns: [
      { kind: 'plan', facts: { exerciseName: 'Landmine Press' }, demonstrates: [29, 35], note: 'Green-list selection; stop rule armed.' },
      { kind: 'block', facts: { exerciseName: 'Landmine Press', muscleGroup: 'Shoulders',
        todaySets: [{ weight: 70, reps: 8, rir: 2 }, { weight: 70, reps: 8, rir: 2 }, { weight: 70, reps: 8, rir: 2 }], rec: ROUTINE },
        demonstrates: [29], note: 'Friendliest pressing angle.' },
      { kind: 'block', facts: { exerciseName: 'Floor Press', muscleGroup: 'Chest',
        todaySets: [{ weight: 40, reps: 8, rir: 2 }, { weight: 40, reps: 8, rir: 2 }],
        substitution: { classification: 'substituted', prescribed: { name: 'Dumbbell Bench' }, logged: { name: 'Floor Press' } } },
        demonstrates: [13, 29], note: 'Range-limited substitute after a pinch.' },
      { kind: 'block', facts: { exerciseName: 'Dumbbell Curl', muscleGroup: 'Arms',
        todaySets: [{ weight: 50, reps: 12, rir: 1 }, { weight: 50, reps: 12, rir: 1 }], rec: ROUTINE },
        demonstrates: [16], note: 'Approaching the 50 lb ceiling → reps/tempo axes.' },
    ],
  },
  {
    id: 'S14', name: 'Leo — hypertrophy, new video to discuss', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'hypertrophy', label: 'Leo — bodybuilding' },
    turns: [
      { kind: 'chat', text: 'A video says if you\'re not training to absolute failure you\'re leaving gains on the table. Should we?', demonstrates: [30] },
      { kind: 'block', facts: { exerciseName: 'Incline Dumbbell Press', muscleGroup: 'Chest',
        todaySets: [{ weight: 80, reps: 10, rir: 2 }, { weight: 80, reps: 9, rir: 2 }, { weight: 80, reps: 9, rir: 1 }], rec: CLIENT_PR },
        demonstrates: [5, 8, 31], note: 'First 10 @2 opener on the 80s — a rep PR claim.' },
      { kind: 'block', facts: { exerciseName: 'Cable Flyes', muscleGroup: 'Chest',
        todaySets: [{ weight: 40, reps: 15, rir: 2 }, { weight: 40, reps: 14, rir: 1 }, { weight: 40, reps: 12, rir: 0 }], rec: ROUTINE },
        demonstrates: [30], note: 'Final set to failure — the bounded allowance.' },
      { kind: 'chat', text: 'What if we ADD a fourth chest exercise? More volume more growth right??', demonstrates: [21, 30], note: 'Weekly ledger + redirect.' },
    ],
  },
  {
    id: 'S15', name: 'Nadia — in-season, match Sunday', part: 'extended', synthetic: true,
    athlete: { synthetic_profile: true, profileGoal: 'general_health', label: 'Nadia — in-season' },
    turns: [
      { kind: 'plan', facts: { exerciseName: 'Trap Bar Deadlift' }, demonstrates: [1, 3], note: 'Match-week trim, no novelty.' },
      { kind: 'chat', text: 'Any reason I can\'t test a max deadlift today? Would love to know my number.', demonstrates: [25], note: 'Redirect the impulse to a booked slot.' },
      { kind: 'block', facts: { exerciseName: 'Trap Bar Deadlift', muscleGroup: 'Legs',
        todaySets: [{ weight: 185, reps: 5, rir: 3 }, { weight: 185, reps: 5, rir: 3 }], rec: ROUTINE },
        demonstrates: [3], note: 'Worked, not spent — dosed.' },
      { kind: 'block', facts: { exerciseName: 'Seated Rows', muscleGroup: 'Back',
        todaySets: [{ weight: 130, reps: 10, rir: 2 }, { weight: 130, reps: 10, rir: 2 }, { weight: 130, reps: 10, rir: 2 }], rec: ROUTINE },
        demonstrates: [5], note: 'Two straight at 130 — match-neutral progression continues.' },
    ],
  },
];

module.exports = { SESSIONS };
