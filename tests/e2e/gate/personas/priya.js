'use strict';

// ── Persona fixture: PRIYA — the beginner who needs the words explained ────
// Slice 2c of the persona test rig (issue #1607; design:
// goals file persona-test-rig-design-2026-10-29.md §3.2). One module per
// persona under tests/e2e/gate/personas/, authored by hand from the
// athlete's card + script in docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md
// (Session 7), following the Marcus format proof (Slice 2a). The loader
// (load-persona.js) only validates shape; the gate server, the persona
// spec, and the rehearsal runner all resolve a persona by slug through
// it, so this module is the whole landing — no registry or scenario
// change rides with it.
//
// Everything declared here is a DECLARATION the run is compared against,
// never a transcript: the beats are templates in Priya's register, and a
// scored run computes expectations from the declared inputs at run time.
// The numbers below are the script's — they make the fixture's plan
// plausible against its own history, which is the authoring cost the
// design names (§4.4).
//
// Settled authoring calls (coordinator, Slice 2c thread, 2026-10-31):
// historyMode 'replace' (see the historyMode comment below); the new
// lift codes GSQ01/DBB01/OAR01 (see catalogRows); plank as a finisher
// beat, not a plan row, counted in expected.log_rows (see expected);
// and variation as the script's fixed values, not a seeded draw (see
// variation).
//
// Source numbers, Session 7: plan issued — goblet squat 35 lb 3x10 @~2 RIR,
// dumbbell bench 25s 3x10, one-arm rows 30 3x10/side, plank to finish.
// Tuesday's session — goblet squat 30 lb 10/3+ (easy). Three-week deltas
// cited at closeout — squat 25→35, rows +10 lb, plank PB 32→40 s.
// Session beats — RIR re-explained; squat 35x10, sets 1–2 @~2, set 3 @~1;
// bench stopped at 8 on all 3 sets (left-arm wobble ~rep 7, form bail),
// target revised to 25x8; rows 30x10/side @2; plank 40 s PB.

module.exports = {
  slug: 'priya',
  sourceRef: 'Soul Corpus Session 7 — docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md',

  card: {
    goal: 'general strength and confidence; "not be intimidated by the gym"',
    experience: '11 weeks',
    style: 'full-body, 3 days/week, learning barbell basics',
    schedule: 'weekday evenings',
    equipment: 'commercial gym, prefers dumbbells and machines while learning',
    injury: 'none',
    personality: 'eager, self-doubting, apologizes for "dumb questions"',
    communication: 'chatty, types in full sentences, asks lots of whys',
    recovery: 'fine',
    loggingStyle: 'messy — approximate names, sometimes forgets reps or units',
    adherence: 'follows the plan but bails on sets when unsure of form',
  },

  // Plan as ISSUED in the script (bench 10, before the form-bail revision;
  // the revision is a beat/fact, as Marcus's back-off revision is).
  // Plank is deliberately NOT a plan row: the script prescribes no plank
  // load/sets/reps, only "a plank to finish" — it rides the finisher beat.
  plan: [
    { exercise: 'Goblet Squat', lift_code: 'GSQ01', target_weight: 35, target_reps: 10, target_sets: 3, target_rir: 2 },
    { exercise: 'Dumbbell Bench Press', lift_code: 'DBB01', target_weight: 25, target_reps: 10, target_sets: 3, target_rir: 2 },
    { exercise: 'One-Arm Row', lift_code: 'OAR01', target_weight: 30, target_reps: 10, target_sets: 3, target_rir: 2 },
  ],

  // How the gate server serves this fixture's history (§3.2): 'alongside'
  // the shared GATE-H rows, or 'replace' (they are served instead of
  // them). The choice is part of the test input — Priya uses 'replace':
  // the shared GATE-H rows are heavy barbell history (225 squat, 215
  // bench) that would contradict an 11-week beginner's file and distort
  // the progression reads (30→35 on Tuesday ease; 25→35 over three
  // weeks). Marcus used 'alongside' because his history did not need to
  // hide the shared rows. Settled with the coordinator 2026-10-31.
  historyMode: 'replace',

  // Engine-visible history, GATE-H row shape, synthetic PERS-P<n> ids.
  // PERS-P1 (three weeks back): squat 25, rows 20 — the bases of the
  // closeout deltas (squat 25→35, rows +10). PERS-P2 (Tuesday): squat 30
  // 10/3 (the "easy" session that justifies 30→35), bench 25 10/2, rows 25
  // 10/2 (the midpoint of the rows progression). Plank history is NOT a
  // row here: a timed hold has no weight/reps row shape (see the expected comment below).
  historyRows: [
    // PERS-P1 — goblet squat 25 x10 @2 x3; rows 20 x10 @2 x3.
    ['2026-07-03', 'PERS-P1', 'Goblet Squat', 'Goblet Squat', 'Legs', 'GSQ01', '1', '25', '10', '2', ''],
    ['2026-07-03', 'PERS-P1', 'Goblet Squat', 'Goblet Squat', 'Legs', 'GSQ01', '2', '25', '10', '2', ''],
    ['2026-07-03', 'PERS-P1', 'Goblet Squat', 'Goblet Squat', 'Legs', 'GSQ01', '3', '25', '10', '2', ''],
    ['2026-07-03', 'PERS-P1', 'One-Arm Row', 'One-Arm Row', 'Back', 'OAR01', '1', '20', '10', '2', ''],
    ['2026-07-03', 'PERS-P1', 'One-Arm Row', 'One-Arm Row', 'Back', 'OAR01', '2', '20', '10', '2', ''],
    ['2026-07-03', 'PERS-P1', 'One-Arm Row', 'One-Arm Row', 'Back', 'OAR01', '3', '20', '10', '2', ''],
    // PERS-P2 — Tuesday: squat 30 x10 @3 x3; bench 25 x10 @2 x3; rows 25 x10 @2 x3.
    ['2026-07-07', 'PERS-P2', 'Goblet Squat', 'Goblet Squat', 'Legs', 'GSQ01', '1', '30', '10', '3', ''],
    ['2026-07-07', 'PERS-P2', 'Goblet Squat', 'Goblet Squat', 'Legs', 'GSQ01', '2', '30', '10', '3', ''],
    ['2026-07-07', 'PERS-P2', 'Goblet Squat', 'Goblet Squat', 'Legs', 'GSQ01', '3', '30', '10', '3', ''],
    ['2026-07-07', 'PERS-P2', 'Dumbbell Bench Press', 'Dumbbell Bench Press', 'Chest', 'DBB01', '1', '25', '10', '2', ''],
    ['2026-07-07', 'PERS-P2', 'Dumbbell Bench Press', 'Dumbbell Bench Press', 'Chest', 'DBB01', '2', '25', '10', '2', ''],
    ['2026-07-07', 'PERS-P2', 'Dumbbell Bench Press', 'Dumbbell Bench Press', 'Chest', 'DBB01', '3', '25', '10', '2', ''],
    ['2026-07-07', 'PERS-P2', 'One-Arm Row', 'One-Arm Row', 'Back', 'OAR01', '1', '25', '10', '2', ''],
    ['2026-07-07', 'PERS-P2', 'One-Arm Row', 'One-Arm Row', 'Back', 'OAR01', '2', '25', '10', '2', ''],
    ['2026-07-07', 'PERS-P2', 'One-Arm Row', 'One-Arm Row', 'Back', 'OAR01', '3', '25', '10', '2', ''],
  ],

  // Only lifts the gate catalog lacks (§3.2). None of Priya's lifts are
  // in the shared gate catalog (which carries only SQ01/FSQ01/BEN01/
  // OHP01/RDL01), so all three are declared here — declared, not omitted,
  // so the additions are a decision a reviewer can see. GSQ01/DBB01/OAR01
  // follow the catalog's code pattern, as the coordinator noted when
  // settling these calls (2026-10-31).
  catalogRows: [
    ['Goblet Squat', 'Legs', 'GSQ01', 'Goblet Squat', 'goblet squat|goblet squats'],
    ['Dumbbell Bench Press', 'Chest', 'DBB01', 'Dumbbell Bench Press', 'dumbbell bench|dumbbell bench press|db bench'],
    ['One-Arm Row', 'Back', 'OAR01', 'One-Arm Row', 'one-arm row|one arm row|one-arm rows|rows'],
  ],

  // Ordered turn templates (§3.3): surface forms in Priya's register.
  // The forms below are the script's own shapes.
  beats: [
    {
      id: 'plan-ask', kind: 'ask',
      forms: ['Hi! Gym day. What am I doing? Also sorry in advance, I will probably have questions.'],
      slots: {},
    },
    {
      id: 'rir-question', kind: 'ask',
      forms: ['Wait what does the "2 reps left in the tank" thing mean again? I know you told me.'],
      slots: {},
    },
    {
      id: 'squat-log', kind: 'log',
      forms: ['Ok squats done!! I did the 35 pound one, 3 sets of 10. Honestly the last set the answer was like... 1? Maybe 1.'],
      slots: { squatSets12Rir: '2', squatSet3Rir: '1' },
    },
    {
      id: 'bench-form-bail', kind: 'log',
      forms: ['Bench question — on like rep 7 my left arm got wobbly and I stopped at 8 instead of 10. Is that bad?? I did that on all 3 sets basically.'],
      slots: { benchActualReps: '8 (planned 10, stopped on form)', benchWobbleRep: '7' },
    },
    {
      id: 'rows-and-plank', kind: 'log',
      forms: ['Rows done, 30 pounds, 10 each arm, 3 sets. Tank answer: 2. Plank 40 seconds!! That is a record for me.'],
      slots: { rowsRir: '2', plankSeconds: '40' },
    },
    {
      id: 'progress-doubt', kind: 'ask',
      forms: ['Ok honest question. Am I actually getting anywhere or am I just doing baby weights?'],
      slots: {},
    },
    {
      id: 'closeout', kind: 'closeout',
      forms: ['Done — squat held at 35, bench revised to 25 x 8, rows 30, plank PB 40 seconds.'],
      slots: {},
    },
  ],

  // The durable end-state declaration, same shape as SCENARIOS[n].expected
  // in rehearsal.spec.js.
  //   plan_set_rows: 3 (squat) + 3 (bench) + 3 (rows) = 9 declared plan sets.
  //   log_rows: 3 squat + 3 bench + 3 rows + 1 plank hold = 10.
  // The plank is a timed hold, not a weight/reps set (see
  // test/fixtures/personaLoggingGoldens.js: plank = durationSec); it
  // counts as one log row in the count above — the settled call for this
  // fixture, and the rows-and-plank finisher beat above declares it.
  expected: {
    session_plans_events: { plan_accepted: 3, item_outcome: 1, session_closeout: 1 },
    plan_set_rows: 9,
    log_rows: 10,
    effort_supplied: true,
    closeout_fully_verified: true,
  },

  // Persona fact-check declarations (§3.4) for the scorecard checks: the
  // end-states a scored run is judged against, declared here — never read
  // from the coach's reply.
  facts: {
    planState: { completedExercises: ['Goblet Squat', 'Dumbbell Bench Press', 'One-Arm Row'], remainingExercises: [] },
    // Bench end-state after the form bail: 25 x 8 x3, NOT the planned 10s.
    benchRevisedTarget: { exercise: 'Dumbbell Bench Press', lift_code: 'DBB01', weight: 25, sets: 3, reps: 8 },
    // Squat hold rule from the script: 35 stays until all three sets sit at 2.
    squatHold: { exercise: 'Goblet Squat', lift_code: 'GSQ01', weight: 35, sets: 3, reps: 10, targetRir: 2 },
    // Plank PB: previous best 32 s, today 40 s (+8). No history row carries
    // this (timed hold, no weight/reps shape) — it is a fact declaration.
    plankPb: { previousBestSec: 32, todaySec: 40 },
  },

  // Variation declaration (§3.3): Priya's script beats are fixed values
  // (squat set-3 RIR 1, bench 8s, plank 40 s), not a seeded draw like
  // Marcus's ±1 RIR — the deviations ARE the script's test inputs (the
  // form bail, the last-set effort read, the PB), so the fixture declares
  // the script values as the baseline a run is compared against.
  variation: {
    squatSet3Rir: 1,
    benchActualReps: 8,
    plankSeconds: 40,
  },

  // Human-review checklist (§3.4) — voice/feel, NEVER automated. Emitted
  // with the run artifact; a persona run is passed on facts by the
  // scorecard and accepted only when a human works this list.
  reviewChecklist: [
    'Replies stay in Priya\'s register: chatty, full sentences, questions welcomed — never terse, never shaming a "dumb question".',
    'RIR is taught as a felt question ("how many more clean reps?"), not jargon; estimates stay approximate ("about", "like... 1").',
    'Stopping on form loss is praised as the right call, every time — the bench revision to 25 x 8 is stated, not smuggled in.',
    'Reassurance is built from her own numbers (squat 25→35, rows +10, plank PB by 8), never generic praise.',
    'No medical claim about the left-arm wobble: "usually stabilizers catching up" at most, with the form-check watch note held open.',
  ],
};
