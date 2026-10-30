'use strict';

// ── Persona fixture: MARCUS — the strength purist ──────────────────────────────
// Slice 2a of the persona test rig (issue #1607; design:
// goals file persona-test-rig-design-2026-10-29.md §3.2). This module is the
// FORMAT PROOF for persona fixtures: one module per persona under
// tests/e2e/gate/personas/, authored by hand from the athlete's card + script
// in docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md. Priya and Tara land in
// Slice 2c; nothing here is shared machinery — the loader (load-persona.js)
// only validates shape.
//
// Everything declared here is a DECLARATION the run is compared against, never
// a transcript: the beats are templates in Marcus's register with slots (§3.3),
// and Slice 2b computes expectations from the varied inputs at run time. The
// numbers below are the script's — they make the fixture's plan plausible
// against its own history, which is the authoring cost the design names (§4.4).

module.exports = {
  slug: 'marcus',
  sourceRef: 'Soul Corpus Session 6 (Part II) — docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md',

  // The athlete card, field for field from the corpus (Part II cards are
  // uniform: goal, experience, style, schedule, equipment, injury, personality,
  // communication, recovery, logging style, adherence).
  card: {
    goal: 'raw strength on squat/bench/deadlift, no meet booked',
    experience: '6 years',
    style: 'low-rep top sets + back-offs, 4-day split',
    schedule: '5:30 AM before work, hard 60-minute cap',
    equipment: 'full barbell gym',
    injury: 'none current',
    personality: 'stoic, hates chatter, suspicious of hype',
    communication: 'terse shorthand, no emoji, ignores long messages',
    recovery: 'good, consistent sleep',
    loggingStyle: 'precise, immediate, occasionally fat-fingers a number',
    adherence: 'follows the plan to the letter',
  },

  // The day Atlas issued in the script ("Plan." → squat top triple, bench,
  // RDL), in the OWNER_PLAN row shape the acceptance boundary consumes. The
  // squat back-offs ride the beats, exactly as warmups do in the owner
  // scenarios: the plan declares the top set, the log declares the rest.
  plan: [
    { exercise: 'Back Squat', lift_code: 'SQ01', target_weight: 315, target_reps: 3, target_sets: 1, target_rir: 3 },
    { exercise: 'Bench Press', lift_code: 'BEN01', target_weight: 225, target_reps: 5, target_sets: 3, target_rir: 2 },
    { exercise: 'Romanian Deadlift', lift_code: 'RDL01', target_weight: 275, target_reps: 6, target_sets: 3, target_rir: 2 },
  ],

  // How the gate server serves this fixture's history (§3.2): 'alongside' the
  // shared GATE-H rows, or 'replace' (they are served instead of them). The
  // choice is part of the test input — Marcus's engine-visible history does
  // not need to hide the shared rows, so he shares.
  historyMode: 'alongside',

  // Engine-visible history in config/columns logCleanedColumns order (the
  // GATE-H row shape), synthetic session ids PERS-M<n>. Authored so the plan
  // above is plausible (§4.4): last squat day carries the 315 top triple and
  // the 285 back-off baseline the script's Data line cites, and TWO prior RDL
  // days sit at 275 6/2 x3 — so the script's correction end-state ("three
  // straight at 275") is true when today's corrected session lands.
  historyRows: [
    // PERS-M1 — 2026-07-03, RDL day: 275 6/2 x3 (first straight 275 session).
    ['2026-07-03', 'PERS-M1', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '1', '275', '6', '2', ''],
    ['2026-07-03', 'PERS-M1', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '2', '275', '6', '2', ''],
    ['2026-07-03', 'PERS-M1', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '3', '275', '6', '2', ''],
    // PERS-M2 — 2026-07-06, squat day: top triple 315 @3, back-offs 285 5/2 x3, bench 225 5/2 x3.
    ['2026-07-06', 'PERS-M2', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '1', '315', '3', '3', ''],
    ['2026-07-06', 'PERS-M2', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '2', '285', '5', '2', ''],
    ['2026-07-06', 'PERS-M2', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '3', '285', '5', '2', ''],
    ['2026-07-06', 'PERS-M2', 'Back Squat', 'Back Squat', 'Legs', 'SQ01', '4', '285', '5', '2', ''],
    ['2026-07-06', 'PERS-M2', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '1', '225', '5', '2', ''],
    ['2026-07-06', 'PERS-M2', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '2', '225', '5', '2', ''],
    ['2026-07-06', 'PERS-M2', 'Bench Press', 'Bench Press', 'Chest', 'BEN01', '3', '225', '5', '2', ''],
    // PERS-M3 — 2026-07-08, RDL day: 275 6/2 x3 (second straight 275 session).
    ['2026-07-08', 'PERS-M3', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '1', '275', '6', '2', ''],
    ['2026-07-08', 'PERS-M3', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '2', '275', '6', '2', ''],
    ['2026-07-08', 'PERS-M3', 'Romanian Deadlift', 'Romanian Deadlift', 'Hamstrings', 'RDL01', '3', '275', '6', '2', ''],
  ],

  // Only lifts the gate catalog lacks (§3.2). All three of Marcus's lifts are
  // already in the shared gate catalog (SQ01/BEN01/RDL01), so this is empty —
  // declared, not omitted, so the absence is a decision a reviewer can see.
  catalogRows: [],

  // Ordered turn templates (§3.3): surface forms in Marcus's register with
  // {slots}; the variation draw (±1 rep / ±1 RIR around target, weight held at
  // target except the beat that is ABOUT a deviation) is Slice 2b machinery.
  // The forms below are the script's own shapes, parameterized.
  beats: [
    {
      id: 'plan-ask', kind: 'ask',
      forms: ['Plan.'],
      slots: {},
    },
    {
      id: 'squat-warmups-and-top', kind: 'log',
      forms: ['Squat 135 5/5 225 3/4 275 2/3 315 {topReps}/{topRir}'],
      slots: { topReps: 'plan.target_reps ± 0', topRir: 'plan.target_rir ± 1' },
    },
    {
      id: 'squat-backoffs', kind: 'log',
      forms: ['{backoffWeight} {backoffReps}/{backoffRir} x{backoffSets}'],
      slots: { backoffWeight: 'revised target (script: 290 after the top-set read; 285 if unrevised)', backoffReps: '5', backoffRir: '2', backoffSets: '3' },
    },
    {
      id: 'bench-rdl-batch', kind: 'log',
      forms: ['Bench {benchWeight} {benchReps}/{benchRir} x{benchSets}. RDL {rdlLoggedWeight} {rdlReps}/{rdlRir} x{rdlSets}.'],
      slots: {
        benchWeight: 'plan target (225)', benchReps: '5', benchRir: '2', benchSets: '3',
        rdlLoggedWeight: 'plan target + 10 — THE FAT-FINGER BEAT: the deviation is the test input',
        rdlReps: '6', rdlRir: '2', rdlSets: '3',
      },
    },
    {
      id: 'rdl-correction', kind: 'correction',
      forms: ['Typo. {rdlPlannedWeight}.'],
      slots: { rdlPlannedWeight: 'plan target (275)' },
    },
    {
      id: 'closeout', kind: 'closeout',
      forms: ['Done. {minutes} min.'],
      slots: { minutes: 'under the 60-minute cap (script: 58)' },
    },
  ],

  // The durable end-state declaration, same shape as SCENARIOS[n].expected in
  // rehearsal.spec.js. Authored for Slice 2b's scored run; Slice 2a does not
  // run the beats, so nothing here is asserted yet.
  //   plan_set_rows: 1 (squat top) + 3 (bench) + 3 (RDL) = 7 declared plan sets.
  //   log_rows: 3 warmups + 1 top + 3 back-offs + 3 bench + 3 RDL = 13.
  expected: {
    session_plans_events: { plan_accepted: 3, item_outcome: 1, session_closeout: 1 },
    plan_set_rows: 7,
    log_rows: 13,
    effort_supplied: true,
    closeout_fully_verified: true,
  },

  // Persona fact-check declarations (§3.4) for Slice 2b's scorecard checks.
  facts: {
    // Parsed-set equality: the durable Log_Cleaned rows under the allocated
    // session id equal the sets the beats declare for this run, computed from
    // the varied inputs — including this correction end-state.
    correctionEndStates: [
      { beat: 'rdl-correction', exercise: 'Romanian Deadlift', lift_code: 'RDL01', weight: 275, sets: 3, reps: 6, rir: 2, forbiddenWeight: 285 },
    ],
    // Plan-state facts: completed/remaining derivation against the plan above
    // matches the declaration after the final turn.
    planState: { completedExercises: ['Back Squat', 'Bench Press', 'Romanian Deadlift'], remainingExercises: [] },
  },

  // Variation declaration (§3.3 machinery, resolved by the Slice 2b driver):
  // which slots the seeded draw may move, and the rule that resolves the
  // back-off weight from the drawn top-set read. The corpus script read the
  // top set one RIR over target and lifted the back-offs 285 → 290; the draw
  // may also land at or under target, in which case the back-offs stay at
  // the unrevised weight. Both branch weights are declared HERE, so the
  // driver's expectation is computed from the declaration and the draw —
  // never copied from the script and never read from the coach's reply.
  variation: {
    topRirDeltaChoices: [-1, 0, 1],
    squatWarmups: [
      { weight: 135, reps: 5, rir: 5 },
      { weight: 225, reps: 3, rir: 4 },
      { weight: 275, reps: 2, rir: 3 },
    ],
    backoff: { aboveTargetWeight: 290, atOrBelowTargetWeight: 285, reps: 5, rir: 2, sets: 3 },
    closeoutMinutes: 58,
  },

  // Human-review checklist (§3.4) — voice/feel, NEVER automated. Emitted with
  // the run artifact from Slice 2b on; a persona run is passed on facts by
  // the scorecard and accepted only when a human works this list.
  reviewChecklist: [
    'Replies stay in Marcus\'s register: terse, telegram-style, no emoji, no hype.',
    'Progression and restraint calls are stated as numbers and rules, not praise.',
    'The fat-finger discrepancy is raised as a neutral question — no assumption of error, no assumption of freelancing.',
    'Back-off revision (if any) carries its one-line why; nothing else gets a paragraph.',
    'Closeout is three clauses or fewer and names what the next squat day tests.',
  ],
};
