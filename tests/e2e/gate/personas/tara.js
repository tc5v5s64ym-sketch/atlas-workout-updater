'use strict';

// ── Persona fixture: TARA — training hard around a shoulder that gets a vote ─
// Slice 2c of the persona test rig (issue #1607; design:
// goals file persona-test-rig-design-2026-10-29.md §3.2). One module per
// persona under tests/e2e/gate/personas/, authored by hand from the
// athlete's card + script in docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md
// (Session 13), following the Marcus format proof (Slice 2a) and the
// Priya fixture (Slice 2c, PR #1639). The loader (load-persona.js) only
// validates shape; the gate server, the persona spec, and the rehearsal
// runner all resolve a persona by slug through it, so this module is the
// whole landing — no registry or scenario change rides with it.
//
// Everything declared here is a DECLARATION the run is compared against,
// never a transcript: the beats are templates in Tara's register, and a
// scored run computes expectations from the declared inputs at run time.
// The numbers below are the script's — they make the fixture's plan
// plausible against its own history, which is the authoring cost the
// design names (§4.4).
//
// Authoring calls (builder's, within the Marcus/Priya format, checked at
// handback review — the same class the coordinator settled in-thread for
// Priya on 2026-10-31): historyMode 'replace' (see the historyMode
// comment); new lift codes LMP01/CSB01/PLU01/FLP01 plus the app
// catalog's own BC01 for curls (see catalogRows); band rows and pull-ups
// declared with target_weight 0 — no numeric load exists for either,
// and the loader requires the field (see plan); the two history
// sessions below are authored to carry the script's stated tolerance
// history (see historyRows); the closeout beat's form is authored, not
// a corpus quote (Session 13 has no Tara closeout turn), matching the
// verified end-state, as Priya's closeout was.
//
// Source numbers, Session 13: plan issued — landmine press 70 lb
// 8 @2 x3, flat DB bench 45s 8 @2 x3, chest-supported band rows 12 @2
// x3, pull-ups 6 @2 x3, curls 25s 12 @2 x3; neutral grips, no wide
// overhead; standing stop rule (anything sharp, the set ends). Session
// beats — landmine 70 8/2 x3 felt great; bench set 1 45s 8 @2, set 2
// stopped at rep 5 on a front-of-shoulder pinch (stop rule invoked);
// bench replaced by floor press 40s 8 @2 x2, completely silent; rows
// and pull-ups as written; curls skipped — time. The logging goldens
// (test/fixtures/personaLoggingGoldens.js SC13-TARA-01/02) restate the
// same parses, including weight null for band rows and pull-ups at
// logging time and rir null for the stopped set.

module.exports = {
  slug: 'tara',
  sourceRef: 'Soul Corpus Session 13 — docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md',

  card: {
    goal: 'strong and capable at home with what she owns',
    experience: '4 years',
    style: 'upper/lower at home, 4 days/week',
    schedule: 'early mornings, home garage',
    equipment: 'adjustable dumbbells to 50 lb, bench, bands, landmine sleeve, pull-up bar',
    injury: 'right shoulder gets cranky on wide overhead work; physio discharged last year — "keep training, load smart"',
    personality: 'determined, hates being told to rest; adherence so high she needs a governor',
    communication: 'direct, practical',
    recovery: 'good',
    loggingStyle: 'consistent',
    adherence: 'very high — if anything, needs a governor',
  },

  // Plan as ISSUED in the script (bench 8s, curls included; the bench
  // stop and the curls skip are beats/facts, as Priya's form-bail
  // revision was a beat/fact, not a plan edit). Band rows and pull-ups
  // carry target_weight 0: neither has a numeric load (band resistance;
  // bodyweight), the loader requires the OWNER_PLAN field, and the
  // logging layer records both with weight null (goldens SC13-TARA-02).
  // Floor press is deliberately NOT a plan row: it is the mid-session
  // substitution, declared in catalogRows and facts, and counted in
  // expected.log_rows — never in the issued plan.
  plan: [
    { exercise: 'Landmine Press', lift_code: 'LMP01', target_weight: 70, target_reps: 8, target_sets: 3, target_rir: 2 },
    { exercise: 'Dumbbell Bench Press', lift_code: 'DBB01', target_weight: 45, target_reps: 8, target_sets: 3, target_rir: 2 },
    { exercise: 'Chest-Supported Band Row', lift_code: 'CSB01', target_weight: 0, target_reps: 12, target_sets: 3, target_rir: 2 },
    { exercise: 'Pull-Up', lift_code: 'PLU01', target_weight: 0, target_reps: 6, target_sets: 3, target_rir: 2 },
    { exercise: 'Bicep Curl', lift_code: 'BC01', target_weight: 25, target_reps: 12, target_sets: 3, target_rir: 2 },
  ],

  // How the gate server serves this fixture's history (§3.2): 'alongside'
  // the shared GATE-H rows, or 'replace' (they are served instead of
  // them). Tara uses 'replace', on the same reasoning the coordinator
  // settled for Priya: the shared GATE-H rows are heavy gym-barbell
  // history (225 squat, 215 bench, 110 overhead press) that contradict
  // this athlete's file — a home lifter capped at 50 lb dumbbells whose
  // pressing is selected from a green list that excludes wide overhead
  // work. Served alongside, an OHP history and a 215 bench would
  // distort every progression and tolerance read the session turns on.
  historyMode: 'replace',

  // Engine-visible history, GATE-H row shape, synthetic PERS-T<n> ids.
  // Authored to carry exactly what the script claims: a two-week quiet
  // streak going into today, landmine as the long-clean pressing angle,
  // bench at 45s symptom-free through the streak, and floor press clean
  // every time it has been used. PERS-T1 (two weeks back, streak
  // start): landmine 65 (the base today's 70 progressed from), bench 45
  // clean, floor press 40 clean. PERS-T2 (one week back, inside the
  // streak): landmine 70 (today's load already proven), bench 45 clean,
  // floor press 40 clean. Band rows, pull-ups, and curls carry no
  // history rows: no script claim turns on their loads, and two of the
  // three have no numeric load to record.
  historyRows: [
    // PERS-T1 — landmine 65 x8 @2 x3; bench 45 x8 @2 x3; floor press 40 x8 @2 x2.
    ['2026-07-02', 'PERS-T1', 'Landmine Press', 'Landmine Press', 'Shoulders', 'LMP01', '1', '65', '8', '2', ''],
    ['2026-07-02', 'PERS-T1', 'Landmine Press', 'Landmine Press', 'Shoulders', 'LMP01', '2', '65', '8', '2', ''],
    ['2026-07-02', 'PERS-T1', 'Landmine Press', 'Landmine Press', 'Shoulders', 'LMP01', '3', '65', '8', '2', ''],
    ['2026-07-02', 'PERS-T1', 'Dumbbell Bench Press', 'Dumbbell Bench Press', 'Chest', 'DBB01', '1', '45', '8', '2', ''],
    ['2026-07-02', 'PERS-T1', 'Dumbbell Bench Press', 'Dumbbell Bench Press', 'Chest', 'DBB01', '2', '45', '8', '2', ''],
    ['2026-07-02', 'PERS-T1', 'Dumbbell Bench Press', 'Dumbbell Bench Press', 'Chest', 'DBB01', '3', '45', '8', '2', ''],
    ['2026-07-02', 'PERS-T1', 'Floor Press', 'Floor Press', 'Chest', 'FLP01', '1', '40', '8', '2', ''],
    ['2026-07-02', 'PERS-T1', 'Floor Press', 'Floor Press', 'Chest', 'FLP01', '2', '40', '8', '2', ''],
    // PERS-T2 — landmine 70 x8 @2 x3; bench 45 x8 @2 x3; floor press 40 x8 @2 x2.
    ['2026-07-09', 'PERS-T2', 'Landmine Press', 'Landmine Press', 'Shoulders', 'LMP01', '1', '70', '8', '2', ''],
    ['2026-07-09', 'PERS-T2', 'Landmine Press', 'Landmine Press', 'Shoulders', 'LMP01', '2', '70', '8', '2', ''],
    ['2026-07-09', 'PERS-T2', 'Landmine Press', 'Landmine Press', 'Shoulders', 'LMP01', '3', '70', '8', '2', ''],
    ['2026-07-09', 'PERS-T2', 'Dumbbell Bench Press', 'Dumbbell Bench Press', 'Chest', 'DBB01', '1', '45', '8', '2', ''],
    ['2026-07-09', 'PERS-T2', 'Dumbbell Bench Press', 'Dumbbell Bench Press', 'Chest', 'DBB01', '2', '45', '8', '2', ''],
    ['2026-07-09', 'PERS-T2', 'Dumbbell Bench Press', 'Dumbbell Bench Press', 'Chest', 'DBB01', '3', '45', '8', '2', ''],
    ['2026-07-09', 'PERS-T2', 'Floor Press', 'Floor Press', 'Chest', 'FLP01', '1', '40', '8', '2', ''],
    ['2026-07-09', 'PERS-T2', 'Floor Press', 'Floor Press', 'Chest', 'FLP01', '2', '40', '8', '2', ''],
  ],

  // Only lifts the gate catalog lacks (§3.2). The shared gate catalog
  // carries only SQ01/FSQ01/BEN01/OHP01/RDL01, so every lift in this
  // session is declared here — declared, not omitted, so the additions
  // are a decision a reviewer can see. DBB01 repeats Priya's row for
  // the same lift (the catalog append is per-persona; each fixture
  // declares what its own session needs). BC01 is the app catalog's
  // own code for Bicep Curl, reused rather than inventing a parallel
  // code. LMP01/CSB01/PLU01/FLP01 follow the catalog's code pattern.
  catalogRows: [
    ['Landmine Press', 'Shoulders', 'LMP01', 'Landmine Press', 'landmine press|landmine presses'],
    ['Dumbbell Bench Press', 'Chest', 'DBB01', 'Dumbbell Bench Press', 'dumbbell bench|dumbbell bench press|db bench'],
    ['Chest-Supported Band Row', 'Back', 'CSB01', 'Chest-Supported Band Row', 'band row|band rows|chest-supported band row|chest-supported band rows'],
    ['Pull-Up', 'Back', 'PLU01', 'Pull-Up', 'pull-up|pull-ups|pullup|pullups'],
    ['Floor Press', 'Chest', 'FLP01', 'Floor Press', 'floor press'],
    ['Bicep Curl', 'Biceps', 'BC01', 'Bicep Curl', 'bicep curl|bicep curls|curls'],
  ],

  // Ordered turn templates (§3.3): surface forms in Tara's register —
  // terse, numbers-first, no filler. The two log forms are the script's
  // own turns (and the SC13 goldens' inputs), verbatim.
  beats: [
    {
      id: 'plan-ask', kind: 'ask',
      forms: ['Upper day. Shoulder\'s been quiet for two weeks, for the record.'],
      slots: {},
    },
    {
      id: 'landmine-bench-pinch', kind: 'log',
      forms: ['Landmine 70 8/2 x3, felt great. Bench first set 45s 8/2. Second set, rep 5, little pinch in the front of the shoulder. Not bad. I stopped. Kind of furious about it.'],
      slots: { benchStoppedSet: '2', benchStoppedRep: '5' },
    },
    {
      id: 'swap-and-finish', kind: 'log',
      forms: ['Floor press 40s 8/2 x2, completely silent. Rows and pull-ups done as written, no issues. Skipped curls, ran out of runway before work.'],
      slots: { floorPressWeight: '40', floorPressSets: '2', curlsSkipped: 'time' },
    },
    {
      id: 'closeout', kind: 'closeout',
      forms: ['Done — landmine 70 x8 x3, bench stopped at set 2 rep 5 on the pinch, floor press 40s x8 x2 silent, rows and pull-ups as written, curls skipped for time.'],
      slots: {},
    },
  ],

  // The durable end-state declaration, same shape as SCENARIOS[n].expected
  // in rehearsal.spec.js.
  //   plan_accepted: one per declared plan row (persona.spec.js asserts
  //   events == plan.length) = 5.
  //   plan_set_rows: 3+3+3+3+3 = 15 declared plan sets.
  //   log_rows: 3 landmine + 2 bench (set 1 full; set 2 the stopped set,
  //   logged at rep 5 with no RIR — golden SC13-TARA-01) + 2 floor press
  //   + 3 band rows + 3 pull-ups = 13. Curls log nothing (skipped).
  //   effort_supplied: the session's sets carry RIR throughout, except
  //   the stopped bench set, which the script and the golden both leave
  //   without an effort read — the stop, not an estimate, is its data.
  expected: {
    session_plans_events: { plan_accepted: 5, item_outcome: 1, session_closeout: 1 },
    plan_set_rows: 15,
    log_rows: 13,
    effort_supplied: true,
    closeout_fully_verified: true,
  },

  // Persona fact-check declarations (§3.4) for the scorecard checks: the
  // end-states a scored run is judged against, declared here — never read
  // from the coach's reply.
  facts: {
    // Bench has log rows but was ended by the stop rule, so it is not
    // counted completed; curls were planned and never performed, so
    // they remain the one uncompleted plan item (see curlsSkipped).
    planState: { completedExercises: ['Landmine Press', 'Floor Press', 'Chest-Supported Band Row', 'Pull-Up'], remainingExercises: ['Bicep Curl'] },
    // The stop: bench set 2 ended at rep 5 on a front-of-shoulder
    // pinch; the standing rule was invoked, and no RIR is stated for
    // the stopped set (golden SC13-TARA-01 records rir null).
    benchStop: { exercise: 'Dumbbell Bench Press', lift_code: 'DBB01', weight: 45, stoppedSet: 2, stoppedRep: 5, symptom: 'little pinch, front of shoulder', rir: null },
    // The substitution: floor press at 40s, a lift with a clean
    // personal history, performed symptom-free.
    floorPressSubstitution: { exercise: 'Floor Press', lift_code: 'FLP01', weight: 40, sets: 2, reps: 8, targetRir: 2, symptoms: 'none' },
    // Curls were sacrificed to the clock — the correct thing to
    // sacrifice, per the closeout; not a shoulder decision.
    curlsSkipped: { exercise: 'Bicep Curl', lift_code: 'BC01', reason: 'time — ran out of runway before work' },
    // The shoulder note: one pinch after a 14-day quiet streak, filed
    // as a one-line entry unless it earns more; recurrence across
    // sessions reopens the physio question with her (script, State).
    shoulderWatch: { quietStreakDays: 14, event: 'one pinch, bench set 2 rep 5, resolved by substitution', rule: 'recurrence across sessions → raise the professional-look flag' },
    // Ceiling note from the closeout: the 50s are getting close on a
    // few lifts, so home progression runs on reps and tempo.
    equipmentCeiling: { dumbbellCapLb: 50, progressionAxes: ['reps', 'tempo'] },
  },

  // Variation declaration (§3.3): Tara's script beats are fixed values
  // (the rep-5 stop, the 40s x2 substitution), not a seeded draw — the
  // deviations ARE the script's test inputs (the pinch, the swap), so
  // the fixture declares the script values as the baseline a run is
  // compared against, as Priya's did.
  variation: {
    benchStoppedSet: 2,
    benchStoppedRep: 5,
    floorPressWeight: 40,
    floorPressSets: 2,
  },

  // Human-review checklist (§3.4) — voice/feel, NEVER automated. Emitted
  // with the run artifact; a persona run is passed on facts by the
  // scorecard and accepted only when a human works this list.
  reviewChecklist: [
    'Replies stay in Tara\'s register: direct, practical, numbers-first — respect shown as competence, not cushioning.',
    'Stopping on the pinch is framed as the rule working — discipline, not defeat — and the substitute arrives before any impulse to test the shoulder does.',
    'No diagnosis and no anatomy verdicts about the pinch: "information, not a verdict"; why the shoulder behaves as it does is explicitly not Atlas\'s question.',
    'Never prescribed rest: the governor works through selection and substitution from her own green list, not through telling her to stop training.',
    'The shoulder note stays one line unless it earns more; the physio question reopens only on recurrence across sessions, and with her, not about her.',
    'The equipment-ceiling note is framed as arithmetic (loads trending to the 50 lb cap; reps/tempo next), never as a limitation narrative.',
  ],
};
