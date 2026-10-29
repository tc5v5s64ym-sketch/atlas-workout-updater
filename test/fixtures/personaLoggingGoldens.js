'use strict';

// ── Persona logging goldens — the Soul Corpus's stated parses, as DATA ───────
// (Persona Test Rig, Slice 1a — issue #1607.)
//
// SOURCE OF TRUTH (do not re-litigate, do not create a competing corpus):
//   docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md — the owner-provided Atlas
//   Soul Corpus V2 (fifteen annotated mock sessions, recorded 2026-07-22).
//   Every input below is a USER turn copied verbatim from that doc, and every
//   expected parse is the parse the doc itself states for that turn — in the
//   turn's CONFIRMATION / SESSION CARD or, for the plan-match entries, in the
//   card's explicit match statement read against the plan the same session
//   declared. If this file and the doc ever disagree, the doc wins and this
//   file is wrong.
//
// ADJUDICATION RULE (fail-closed, no guessing — design §2.4):
//   A logging line becomes a golden ONLY if the source states its expected
//   parse in recoverable form:
//     basis 'card-restated'   — the confirmation card prints the parse numbers.
//     basis 'card-plan-match' — the card explicitly states a match ("matched
//                               the plan" / "matched their targets" / "as
//                               planned") against a plan declared in the same
//                               session; the declared lines ride in
//                               context.plan.
//     basis 'mixed'           — one turn whose exercises split across the two
//                               bases above (basis noted per entry).
//   Where a card states a total set count plus the working sets, the remaining
//   sets are the warmup tokens of the verbatim input in the corpus's fixed
//   notation (weight reps/RIR) — the stated count is what makes them stated,
//   not inferred. Anything else — a card that says only "completed", a card
//   that states part of the input's sets, a load stated in units that cannot
//   be encoded without inventing a number — is EXCLUDED and listed in the
//   EXCLUDED export below with its reason. The excluded list is a deliverable:
//   it is the queue a future annotation pass could promote.
//
// ENTRY SHAPE:
//   id ......... SC<session>-<PERSONA>-<seq> (EX-… for excluded entries)
//   source ..... { doc, ref } — ref is the doc's own session heading
//   session .... the corpus session number (1–15)
//   persona .... 'owner' for Part I; the athlete slug for Part II
//   kind ....... 'log' | 'correction-end-state'
//   input ...... the USER turn, verbatim
//   context .... (optional) { plan: [declared plan lines the parse reads
//                against] }
//   expected ... { exercises: [{ name, sets }] } — sets are FULLY EXPANDED
//                (a "x3" in the source is three set objects). A set carries
//                { weight, reps, rir } in lb / reps / RIR; a field the source
//                does not state is null — never invented. Timed/cardio work
//                uses { durationSec } / { distanceM } sets instead.
//   provenance . { card, basis } — card is the confirmation-card text,
//                verbatim; basis is the adjudication basis above
//   corrects ... (correction-end-state only) the id of the golden whose
//                parse this turn amends; expected is then the corrected
//                END STATE of the whole original input, as the follow-up
//                card states it
//   notes ...... (optional) adjudication detail a reader needs (approximate
//                RIR marks, per-side sets, identity carried by the card…)
//
// SCOPE: Part I + Part II of the Soul Corpus only. Conversation-suite
// material is not here (design: suite goldens are a separate extraction;
// rehearsals are Slice 2). Non-logging turns (plan asks, questions,
// emotional beats) are not candidates and appear in neither export — the
// one data-shaped exception, Session 1's device-screenshot turn, is in
// EXCLUDED so the boundary is auditable.
//
// COUNTS (extraction of 2026-10-29, against s3-maintenance @ ec9f4cfe):
//   35 goldens (33 log + 2 correction-end-state), 10 excluded.
//
// PURE DATA. No requires, no logic beyond two set-shaping helpers — the
// Slice 1b driver (test/personaLoggingGoldens.test.js) imports this and
// drives the real parsers through it; the fixture-integrity test
// (test/personaLoggingGoldensFixture.test.js) guards this file's shape.

const S = (weight, reps, rir) => ({ weight, reps, rir });
const T = (n, s) => Array.from({ length: n }, () => ({ ...s }));

const DOC = 'ATLAS_SOUL_CORPUS_V2_SESSIONS.md';

const GOLDENS = [
  // ── Part I — the owner's five sessions ────────────────────────────────────

  {
    id: 'SC1-OWNER-01',
    source: { doc: DOC, ref: 'Session 1 (owner)' },
    session: 1, persona: 'owner', kind: 'log',
    input: 'Bench 135 10/5 185 10/3 225 6/2 x3',
    expected: { exercises: [
      { name: 'Bench Press', sets: [S(135, 10, 5), S(185, 10, 3), ...T(3, S(225, 6, 2))] },
    ] },
    provenance: {
      card: 'Bench Press parsed as 5 sets. Working sets: 225 lb × 6 reps @2 RIR for 3 sets.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC1-OWNER-02',
    source: { doc: DOC, ref: 'Session 1 (owner)' },
    session: 1, persona: 'owner', kind: 'log',
    input: 'Incline 75 8/2 7/1 6/1',
    expected: { exercises: [
      { name: 'Incline Dumbbell Bench', sets: [S(75, 8, 2), S(75, 7, 1), S(75, 6, 1)] },
    ] },
    provenance: {
      card: 'Incline Dumbbell Bench parsed as 3 sets: 75 × 8 @2, 75 × 7 @1, 75 × 6 @1.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC1-OWNER-03',
    source: { doc: DOC, ref: 'Session 1 (owner)' },
    session: 1, persona: 'owner', kind: 'log',
    input: 'Rows 190 10/2 x3',
    expected: { exercises: [
      { name: 'Seated Rows', sets: T(3, S(190, 10, 2)) },
    ] },
    provenance: {
      card: 'Seated Rows parsed as 190 × 10 @2 for 3 sets.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC1-OWNER-04',
    source: { doc: DOC, ref: 'Session 1 (owner)' },
    session: 1, persona: 'owner', kind: 'log',
    input: 'Skip dips. KR 15 x3.',
    expected: { exercises: [
      { name: 'Knee Raises', sets: T(3, S(null, 15, null)) },
    ] },
    provenance: {
      card: 'Weighted Dips marked skipped. Knee Raises parsed as 15 reps for 3 sets.',
      basis: 'card-restated',
    },
    notes: 'The input also carries a skip directive; the card marks Weighted Dips skipped (a plan-state fact, not a set parse). Expected covers the Knee Raises parse the card states — bodyweight, no load or RIR stated.',
  },
  {
    id: 'SC1-OWNER-05',
    source: { doc: DOC, ref: 'Session 1 (owner)' },
    session: 1, persona: 'owner', kind: 'log',
    input: 'Hammers 40 12/2 x3',
    expected: { exercises: [
      { name: 'Hammer Curls', sets: T(3, S(40, 12, 2)) },
    ] },
    provenance: {
      card: 'Hammer Curls added as unplanned work: 40 × 12 @2 for 3 sets.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC2-OWNER-01',
    source: { doc: DOC, ref: 'Session 2 (owner)' },
    session: 2, persona: 'owner', kind: 'log',
    input: 'Bench 135 10/5 185 8/3 215 6/2 6/2 5/1',
    expected: { exercises: [
      { name: 'Bench Press', sets: [S(135, 10, 5), S(185, 8, 3), S(215, 6, 2), S(215, 6, 2), S(215, 5, 1)] },
    ] },
    provenance: {
      card: 'Bench Press parsed as 5 sets. Working sets: 215 × 6 @2, 215 × 6 @2, 215 × 5 @1.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC2-OWNER-02',
    source: { doc: DOC, ref: 'Session 2 (owner)' },
    session: 2, persona: 'owner', kind: 'log',
    input: 'OHP 115 8/2 x3',
    expected: { exercises: [
      { name: 'Overhead Press', sets: T(3, S(115, 8, 2)) },
    ] },
    provenance: {
      card: 'Overhead Press parsed as 115 × 8 @2 for 3 sets.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC2-OWNER-03',
    source: { doc: DOC, ref: 'Session 2 (owner)' },
    session: 2, persona: 'owner', kind: 'log',
    input: 'Pulldowns 160 10/2 x3. Curls 40 10/2 x3. Done.',
    context: { plan: ['Lat Pulldown 160 10/2 x3', 'Incline Dumbbell Curl 40 10/2 x3'] },
    expected: { exercises: [
      { name: 'Lat Pulldown', sets: T(3, S(160, 10, 2)) },
      { name: 'Incline Dumbbell Curl', sets: T(3, S(40, 10, 2)) },
    ] },
    provenance: {
      card: 'Lat Pulldown and Incline Dumbbell Curl matched the plan. Session ready for effort review.',
      basis: 'card-plan-match',
    },
    notes: 'The card restates no numbers; it explicitly states both lifts matched the plan declared in the same session (TODAY\'S PLAN), which is where the expected numbers come from.',
  },
  {
    id: 'SC3-OWNER-01',
    source: { doc: DOC, ref: 'Session 3 (owner)' },
    session: 3, persona: 'owner', kind: 'log',
    input: 'RDL 135 10/5 185 8/3 225 8/2 8/1 7/1',
    expected: { exercises: [
      { name: 'Romanian Deadlift', sets: [S(135, 10, 5), S(185, 8, 3), S(225, 8, 2), S(225, 8, 1), S(225, 7, 1)] },
    ] },
    provenance: {
      card: 'Romanian Deadlift parsed as 5 sets. Working sets: 225 × 8 @2, 225 × 8 @1, 225 × 7 @1.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC3-OWNER-02',
    source: { doc: DOC, ref: 'Session 3 (owner)' },
    session: 3, persona: 'owner', kind: 'log',
    input: 'Squat 135 10/5 185 8/3 215 6/2 6/2 6/1',
    expected: { exercises: [
      { name: 'Back Squat', sets: [S(135, 10, 5), S(185, 8, 3), S(215, 6, 2), S(215, 6, 2), S(215, 6, 1)] },
    ] },
    provenance: {
      card: 'Back Squat parsed as 5 sets. Working sets: 215 × 6 @2, 215 × 6 @2, 215 × 6 @1.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC3-OWNER-03',
    source: { doc: DOC, ref: 'Session 3 (owner)' },
    session: 3, persona: 'owner', kind: 'log',
    input: 'Extensions 150 12/2 10/1',
    expected: { exercises: [
      { name: 'Leg Extension', sets: [S(150, 12, 2), S(150, 10, 1)] },
    ] },
    provenance: {
      card: 'Leg Extension parsed as 150 × 12 @2 and 150 × 10 @1.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC4-OWNER-01',
    source: { doc: DOC, ref: 'Session 4 (owner)' },
    session: 4, persona: 'owner', kind: 'log',
    input: 'Machine press 120 10/4 140 8/2 150 8/0',
    expected: { exercises: [
      { name: 'Machine Chest Press', sets: [S(120, 10, 4), S(140, 8, 2), S(150, 8, 0)] },
    ] },
    provenance: {
      card: 'Machine Chest Press parsed as 120 × 10 @4, 140 × 8 @2, 150 × 8 @0.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC4-OWNER-02',
    source: { doc: DOC, ref: 'Session 4 (owner)' },
    session: 4, persona: 'owner', kind: 'log',
    input: '140 8/2 x2',
    expected: { exercises: [
      { name: 'Machine Chest Press', sets: T(2, S(140, 8, 2)) },
    ] },
    provenance: {
      card: 'Two additional Machine Chest Press sets added: 140 × 8 @2 for 2 sets.',
      basis: 'card-restated',
    },
    notes: 'The input names no exercise; the card identifies these as additional Machine Chest Press sets (the finder block of SC4-OWNER-01, continued).',
  },
  {
    id: 'SC4-OWNER-03',
    source: { doc: DOC, ref: 'Session 4 (owner)' },
    session: 4, persona: 'owner', kind: 'log',
    input: 'Rows 190 10/2 x3. Pulldowns 160 10/2 x3.',
    context: { plan: ['Seated Rows 190 10/2 x3', 'Lat Pulldown 160 10/2 x3'] },
    expected: { exercises: [
      { name: 'Seated Rows', sets: T(3, S(190, 10, 2)) },
      { name: 'Lat Pulldown', sets: T(3, S(160, 10, 2)) },
    ] },
    provenance: {
      card: 'Rows and Lat Pulldown matched their targets.',
      basis: 'card-plan-match',
    },
    notes: 'The card restates no numbers; it explicitly states both lifts matched their targets in the REVISED REMAINDER declared in the same session, which is where the expected numbers come from.',
  },
  {
    id: 'SC5-OWNER-01',
    source: { doc: DOC, ref: 'Session 5 (owner)' },
    session: 5, persona: 'owner', kind: 'log',
    input: 'Deadlift 135 8/5 185 6/4 225 5/3 245 6/2 225 6/2 x2',
    expected: { exercises: [
      { name: 'Deadlift', sets: [S(135, 8, 5), S(185, 6, 4), S(225, 5, 3), S(245, 6, 2), S(225, 6, 2), S(225, 6, 2)] },
    ] },
    provenance: {
      card: 'Deadlift parsed as 6 sets. Top set: 245 × 6 @2. Back-offs: 225 × 6 @2 for 2 sets.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC5-OWNER-02',
    source: { doc: DOC, ref: 'Session 5 (owner)' },
    session: 5, persona: 'owner', kind: 'correction-end-state',
    corrects: 'SC5-OWNER-01',
    input: 'Actually the first back-off was 215, not 225.',
    expected: { exercises: [
      { name: 'Deadlift', sets: [S(135, 8, 5), S(185, 6, 4), S(225, 5, 3), S(245, 6, 2), S(215, 6, 2), S(225, 6, 2)] },
    ] },
    provenance: {
      card: 'Corrected first back-off set to 215 × 6 @2. Second back-off remains 225 × 6 @2.',
      basis: 'card-restated',
    },
    notes: 'Conversational correction: expected is the corrected end state of SC5-OWNER-01\'s input — only the first back-off set changes (225 → 215).',
  },
  {
    id: 'SC5-OWNER-03',
    source: { doc: DOC, ref: 'Session 5 (owner)' },
    session: 5, persona: 'owner', kind: 'log',
    input: 'Rows 190 10/2 10/2 8/1',
    expected: { exercises: [
      { name: 'Seated Rows', sets: [S(190, 10, 2), S(190, 10, 2), S(190, 8, 1)] },
    ] },
    provenance: {
      card: 'Seated Rows parsed as 190 × 10 @2, 190 × 10 @2, 190 × 8 @1.',
      basis: 'card-restated',
    },
  },

  // ── Part II — ten new athletes ────────────────────────────────────────────

  {
    id: 'SC6-MARCUS-01',
    source: { doc: DOC, ref: 'Session 6 (Marcus)' },
    session: 6, persona: 'marcus', kind: 'log',
    input: '290 5/2 x3',
    expected: { exercises: [
      { name: 'Back Squat', sets: T(3, S(290, 5, 2)) },
    ] },
    provenance: {
      card: 'Back-off sets parsed: 290 × 5 @2 for 3 sets.',
      basis: 'card-restated',
    },
    notes: 'The input names no exercise; the card identifies these as the back-off sets, and the turn\'s annotation (State: "squat block complete; 290 becomes the back-off baseline going forward") ties them to the Back Squat block whose back-offs Atlas had just revised to 290.',
  },
  {
    id: 'SC6-MARCUS-02',
    source: { doc: DOC, ref: 'Session 6 (Marcus)' },
    session: 6, persona: 'marcus', kind: 'log',
    input: 'Bench 225 5/2 x3. RDL 285 6/2 x3.',
    context: { plan: ['bench 225 5/2 x3', 'RDL 275 6/2 x3'] },
    expected: { exercises: [
      { name: 'Bench Press', sets: T(3, S(225, 5, 2)) },
      { name: 'Romanian Deadlift', sets: T(3, S(285, 6, 2)) },
    ] },
    provenance: {
      card: 'Bench 225 × 5 @2 x3. RDL parsed: 285 × 6 @2 x3 — 10 lb above plan.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC6-MARCUS-03',
    source: { doc: DOC, ref: 'Session 6 (Marcus)' },
    session: 6, persona: 'marcus', kind: 'correction-end-state',
    corrects: 'SC6-MARCUS-02',
    input: 'Typo. 275.',
    expected: { exercises: [
      { name: 'Bench Press', sets: T(3, S(225, 5, 2)) },
      { name: 'Romanian Deadlift', sets: T(3, S(275, 6, 2)) },
    ] },
    provenance: {
      card: 'RDL corrected to 275 × 6 @2 for 3 sets.',
      basis: 'card-restated',
    },
    notes: 'Fat-finger correction: expected is the corrected end state of SC6-MARCUS-02\'s input — the RDL load changes (285 → 275); the bench parse is unchanged.',
  },
  {
    id: 'SC7-PRIYA-01',
    source: { doc: DOC, ref: 'Session 7 (Priya)' },
    session: 7, persona: 'priya', kind: 'log',
    input: 'Ok squats done!! I did the 35 pound one, 3 sets of 10. Honestly the last set the answer was like... 1? Maybe 1.',
    expected: { exercises: [
      { name: 'Goblet Squat', sets: [S(35, 10, 2), S(35, 10, 2), S(35, 10, 1)] },
    ] },
    provenance: {
      card: 'Goblet Squat parsed as 35 × 10, sets 1–2 @~2 RIR, set 3 @~1 RIR.',
      basis: 'card-restated',
    },
    notes: 'Prose logging in Priya\'s register. The card marks the RIR values with "~" (the athlete\'s own approximation); they are encoded as the stated integers.',
  },
  {
    id: 'SC7-PRIYA-02',
    source: { doc: DOC, ref: 'Session 7 (Priya)' },
    session: 7, persona: 'priya', kind: 'log',
    input: 'Bench question — on like rep 7 my left arm got wobbly and I stopped at 8 instead of 10. Is that bad?? I did that on all 3 sets basically.',
    expected: { exercises: [
      { name: 'Dumbbell Bench', sets: T(3, S(25, 8, null)) },
    ] },
    provenance: {
      card: 'Dumbbell Bench parsed as 25 × 8 for 3 sets, stopped short of plan on form.',
      basis: 'card-restated',
    },
    notes: 'A question-shaped turn that carries the log: the card states the parse (25 × 8 for 3 sets, stopped short of the planned 10 on form). No RIR is stated, so rir is null.',
  },
  {
    id: 'SC7-PRIYA-03',
    source: { doc: DOC, ref: 'Session 7 (Priya)' },
    session: 7, persona: 'priya', kind: 'log',
    input: 'Rows done, 30 pounds, 10 each arm, 3 sets. Tank answer: 2. Plank 40 seconds!! That is a record for me.',
    expected: { exercises: [
      { name: 'One-Arm Rows', sets: T(3, S(30, 10, 2)) },
      { name: 'Plank', sets: [{ durationSec: 40 }] },
    ] },
    provenance: {
      card: 'One-Arm Rows 30 × 10/side @2 x3. Plank 40 s — personal best on file.',
      basis: 'card-restated',
    },
    notes: 'Rows are per side, as the card\'s "10/side" states. The plank is a timed hold — the modality shape (durationSec), not a weight/reps set.',
  },
  {
    id: 'SC8-JONAS-01',
    source: { doc: DOC, ref: 'Session 8 (Jonas)' },
    session: 8, persona: 'jonas', kind: 'log',
    input: 'Bench 155 8/2 x3. Rows 140 10/2 8/2 8/2 — grip was gone, honestly.',
    expected: { exercises: [
      { name: 'Bench Press', sets: T(3, S(155, 8, 2)) },
      { name: 'Rows', sets: [S(140, 10, 2), S(140, 8, 2), S(140, 8, 2)] },
    ] },
    provenance: {
      card: 'Bench 155 × 8 @2 x3. Rows parsed: 140 × 10 @2, 8 @2, 8 @2, athlete cites grip.',
      basis: 'card-restated',
    },
    notes: 'The corpus names the second lift only "Rows" — no row type is stated anywhere in the session, so the name is recorded as stated. The trailing prose is the athlete\'s grip report, which the card cites; it is not part of the parse.',
  },
  {
    id: 'SC9-RAY-01',
    source: { doc: DOC, ref: 'Session 9 (Ray)' },
    session: 9, persona: 'ray', kind: 'log',
    input: 'AM done, logging late: trap bar DL 245 5/3 x3, press 115 6/2 x3, pullups BW 8/2 x3. PM window opens 1600, what\'s the move? On shift tomorrow.',
    expected: { exercises: [
      { name: 'Trap Bar Deadlift', sets: T(3, S(245, 5, 3)) },
      { name: 'Overhead Press', sets: T(3, S(115, 6, 2)) },
      { name: 'Pull-ups', sets: T(3, S(null, 8, 2)) },
    ] },
    provenance: {
      card: 'Morning batch-logged: Trap Bar Deadlift 245 × 5 @3 x3 · Overhead Press 115 × 6 @2 x3 · Pull-ups BW × 8 @2 x3.',
      basis: 'card-restated',
    },
    notes: 'Batch log of a completed morning session, embedded in a turn that also asks for the PM plan. Pull-ups are bodyweight ("BW" as written and as the card restates it), so weight is null.',
  },
  {
    id: 'SC9-RAY-02',
    source: { doc: DOC, ref: 'Session 9 (Ray)' },
    session: 9, persona: 'ray', kind: 'log',
    input: '1620. Got 4 x 500 in, tones dropped, had to bail mid-session. Annoyed.',
    expected: { exercises: [
      { name: 'Rower', sets: T(4, { distanceM: 500 }) },
    ] },
    provenance: {
      card: 'Rower logged 4 × 500 m of planned 6. Session interrupted — marked shift-truncated, not skipped.',
      basis: 'card-restated',
    },
    notes: 'Steady-cardio modality shape (intervals × distance). Expected is the performed work the card states — 4 of the 6 planned intervals, session shift-truncated.',
  },
  {
    id: 'SC10-ELLEN-01',
    source: { doc: DOC, ref: 'Session 10 (Ellen)' },
    session: 10, persona: 'ellen', kind: 'log',
    input: 'Warmed up properly. Leg press: 180 for 10, felt like 4 left. 230 for 8, about 2 left. Stayed there — 230, 8 and 8, both around 2 left. Knees behaved completely, for the record.',
    expected: { exercises: [
      { name: 'Leg Press', sets: [S(180, 10, 4), ...T(3, S(230, 8, 2))] },
    ] },
    provenance: {
      card: 'Leg Press parsed: 180 × 10 @~4 (ramp), 230 × 8 @~2 x3. Athlete reports no knee complaint during work sets.',
      basis: 'card-restated',
    },
    notes: 'Full-sentence logging in Ellen\'s register. The card marks the RIR values with "~" (athlete-reported approximations); they are encoded as the stated integers. The 180 set is the card\'s "(ramp)" set.',
  },
  {
    id: 'SC10-ELLEN-02',
    source: { doc: DOC, ref: 'Session 10 (Ellen)' },
    session: 10, persona: 'ellen', kind: 'log',
    input: 'Bench: 30s, 10 and 10 with 2 left, and then the last set was 10 with what I would honestly call 3 left. Rows 100, 10-10-10, all comfortable twos.',
    expected: { exercises: [
      { name: 'Incline Dumbbell Bench', sets: [S(30, 10, 2), S(30, 10, 2), S(30, 10, 3)] },
      { name: 'Seated Rows', sets: T(3, S(100, 10, 2)) },
    ] },
    provenance: {
      card: 'Incline DB Bench 30 × 10 @2, @2, @3. Seated Rows 100 × 10 @2 x3.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC12-SAM-01',
    source: { doc: DOC, ref: 'Session 12 (Sam)' },
    session: 12, persona: 'sam', kind: 'log',
    input: 'Squats done, 45, 8-8-8, two left each. Bench done, 8-8-8, honestly could\'ve done the heavier ones. Rows done. That took 22 minutes and I feel like a person again.',
    expected: { exercises: [
      { name: 'Goblet Squat', sets: T(3, S(45, 8, 2)) },
      { name: 'Dumbbell Bench', sets: T(3, S(40, 8, 2)) },
      { name: 'One-Arm Rows', sets: T(3, S(50, 8, 2)) },
    ] },
    provenance: {
      card: 'Goblet Squat 45 × 8 @2 x3 · DB Bench 40 × 8 @2+ x3 · One-Arm Rows 50 × 8 @2 x3. Short session complete, 22 min.',
      basis: 'card-restated',
    },
    notes: 'Sparse prose logging: the input states numbers for the squat only ("8-8-8" for the bench, nothing for rows) — the card states all three parses outright, which is the adjudication basis. The card writes the bench effort as "@2+"; it is encoded as rir 2, the card\'s stated figure.',
  },
  {
    id: 'SC13-TARA-01',
    source: { doc: DOC, ref: 'Session 13 (Tara)' },
    session: 13, persona: 'tara', kind: 'log',
    input: 'Landmine 70 8/2 x3, felt great. Bench first set 45s 8/2. Second set, rep 5, little pinch in the front of the shoulder. Not bad. I stopped. Kind of furious about it.',
    expected: { exercises: [
      { name: 'Landmine Press', sets: T(3, S(70, 8, 2)) },
      { name: 'Dumbbell Bench', sets: [S(45, 8, 2), S(45, 5, null)] },
    ] },
    provenance: {
      card: 'Landmine Press 70 × 8 @2 x3. DB Bench set 1: 45 × 8 @2; set 2 stopped at rep 5 — athlete reports a pinch, invoked stop rule.',
      basis: 'card-restated',
    },
    notes: 'The bench\'s second set is a stopped set: the card states it ended at rep 5 when the athlete reported a pinch and invoked the stop rule. No RIR is stated for it, so rir is null.',
  },
  {
    id: 'SC13-TARA-02',
    source: { doc: DOC, ref: 'Session 13 (Tara)' },
    session: 13, persona: 'tara', kind: 'log',
    input: 'Floor press 40s 8/2 x2, completely silent. Rows and pull-ups done as written, no issues. Skipped curls, ran out of runway before work.',
    context: { plan: ['chest-supported band rows 12/2 x3', 'pull-ups 6/2 x3'] },
    expected: { exercises: [
      { name: 'Floor Press', sets: T(2, S(40, 8, 2)) },
      { name: 'Band Rows', sets: T(3, S(null, 12, 2)) },
      { name: 'Pull-ups', sets: T(3, S(null, 6, 2)) },
    ] },
    provenance: {
      card: 'Floor Press 40 × 8 @2 x2, no symptoms reported. Band Rows and Pull-ups as planned. Curls skipped — time.',
      basis: 'mixed',
    },
    notes: 'Mixed basis in one turn: the Floor Press parse is restated by the card; Band Rows and Pull-ups are stated only as "as planned" against the plan Atlas declared in the same session (context.plan) — band rows carry no numeric load and pull-ups are bodyweight, so weight is null for both. The curls skip is a plan-state fact, not a parse.',
  },
  {
    id: 'SC14-LEO-01',
    source: { doc: DOC, ref: 'Session 14 (Leo)' },
    session: 14, persona: 'leo', kind: 'log',
    input: 'Deal. Incline DB 80s: 10/2, 9/2, 9/1. Felt STRONG.',
    expected: { exercises: [
      { name: 'Incline Dumbbell Press', sets: [S(80, 10, 2), S(80, 9, 2), S(80, 9, 1)] },
    ] },
    provenance: {
      card: 'Incline DB Press parsed: 80 × 10 @2, 9 @2, 9 @1.',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC14-LEO-02',
    source: { doc: DOC, ref: 'Session 14 (Leo)' },
    session: 14, persona: 'leo', kind: 'log',
    input: 'Flat machine press 160: 12/2, 12/2, 11/1. Cable flyes 40: 15/2, 14/1, and on the last set I took the deal — 12/0, total failure, chest is DESTROYED in the best way 🔥',
    expected: { exercises: [
      { name: 'Machine Press', sets: [S(160, 12, 2), S(160, 12, 2), S(160, 11, 1)] },
      { name: 'Cable Flyes', sets: [S(40, 15, 2), S(40, 14, 1), S(40, 12, 0)] },
    ] },
    provenance: {
      card: 'Machine Press 160 × 12 @2, 12 @2, 11 @1. Cable Flyes 40 × 15 @2, 14 @1, 12 @0 (final set to failure per standing rule).',
      basis: 'card-restated',
    },
  },
  {
    id: 'SC15-NADIA-01',
    source: { doc: DOC, ref: 'Session 15 (Nadia)' },
    session: 15, persona: 'nadia', kind: 'log',
    input: 'Annoyingly reasonable. Fine. Trap bar 185 5/3 x2, splits done 25s 8/3 x2 each. Legs feel worked but fine.',
    expected: { exercises: [
      { name: 'Trap Bar Deadlift', sets: T(2, S(185, 5, 3)) },
      { name: 'Bulgarian Split Squats', sets: T(2, S(25, 8, 3)) },
    ] },
    provenance: {
      card: 'Trap Bar Deadlift 185 × 5 @3 x2 · Bulgarian Split Squats 25s × 8 @3 x2/leg. Lower block complete at match-week volume.',
      basis: 'card-restated',
    },
    notes: 'Split-squat sets are per leg, as the card\'s "x2/leg" states.',
  },
  {
    id: 'SC15-NADIA-02',
    source: { doc: DOC, ref: 'Session 15 (Nadia)' },
    session: 15, persona: 'nadia', kind: 'log',
    input: 'Bench 115 8/2 x3. Rows 130 10/2 x3. Done and out — team dinner tonight.',
    expected: { exercises: [
      { name: 'Bench Press', sets: T(3, S(115, 8, 2)) },
      { name: 'Rows', sets: T(3, S(130, 10, 2)) },
    ] },
    provenance: {
      card: 'Bench 115 × 8 @2 x3 · Rows 130 × 10 @2 x3. Session complete.',
      basis: 'card-restated',
    },
    notes: 'As with Jonas (SC8-JONAS-01), the corpus names the second lift only "Rows"; the name is recorded as stated.',
  },
];

// ── Excluded — logging lines that fail the adjudication rule ────────────────
// Each entry: the verbatim input, the card the source actually gave it (or
// the absence of one), and why no golden was taken. This list is the queue a
// future annotation pass could promote; it is not a list of bad inputs —
// several are excellent parser inputs whose parse the source simply never
// states independently (they belong to the rehearsal slice, where durable
// rows are the oracle, not to Slice 1).

const EXCLUDED = [
  {
    id: 'EX-SC1-OWNER-01',
    source: { doc: DOC, ref: 'Session 1 (owner)' },
    session: 1, persona: 'owner',
    input: 'Uploads fitness-device screenshot.',
    card: 'Session review: duration, average HR, peak HR, and effort extracted for owner confirmation before save.',
    reason: 'Device-data turn (a stage direction in the doc, not a set-logging line): the card names extraction categories but states no values, so there is no stated parse to golden. Recorded so the boundary of the extraction is auditable.',
  },
  {
    id: 'EX-SC3-OWNER-01',
    source: { doc: DOC, ref: 'Session 3 (owner)' },
    session: 3, persona: 'owner',
    input: 'KR 15 x3. Done.',
    card: 'Knee Raises completed. Session ready for closeout.',
    reason: 'The card states completion only — no numbers restated and no explicit plan-match statement. Taking the parse from the input itself would make the test circular. (Contrast SC1-OWNER-04, where the card restates the parse and the line is a golden.)',
  },
  {
    id: 'EX-SC4-OWNER-01',
    source: { doc: DOC, ref: 'Session 4 (owner)' },
    session: 4, persona: 'owner',
    input: 'Skip dips. Hammers 40 12/2 x3.',
    card: 'Weighted Dips marked skipped. Hammer Curls added and completed.',
    reason: 'The card states the Hammer Curls were "added and completed" without restating the parse, and the lift was unplanned — no declared plan exists for a plan-match reading either. (The same lift in Session 1 is golden SC1-OWNER-05 because that card restates the parse.)',
  },
  {
    id: 'EX-SC5-OWNER-01',
    source: { doc: DOC, ref: 'Session 5 (owner)' },
    session: 5, persona: 'owner',
    input: 'KR 15 x3. Done.',
    card: 'Knee Raises completed. Session ready for effort review and save.',
    reason: 'Same shape as EX-SC3-OWNER-01: completion stated, parse never stated.',
  },
  {
    id: 'EX-SC6-MARCUS-01',
    source: { doc: DOC, ref: 'Session 6 (Marcus)' },
    session: 6, persona: 'marcus',
    input: 'Squat 135 5/5 225 3/4 275 2/3 315 3/4',
    card: 'Back Squat top set parsed: 315 × 3 @4 RIR. Warmups logged.',
    reason: 'The card states only the top set; the warmups are acknowledged ("Warmups logged") without numbers and no total set count is stated, so the warmup sets\' parse is not independently stated.',
  },
  {
    id: 'EX-SC8-JONAS-01',
    source: { doc: DOC, ref: 'Session 8 (Jonas)' },
    session: 8, persona: 'jonas',
    input: 'Squat 135 8/5 185 5/3 5/3 5/2',
    card: 'Back Squat parsed: 185 × 5 @3, @3, @2.',
    reason: 'The card states the three working sets only; the warmup set\'s parse is not stated and no total set count is given.',
  },
  {
    id: 'EX-SC10-ELLEN-01',
    source: { doc: DOC, ref: 'Session 10 (Ellen)' },
    session: 10, persona: 'ellen',
    input: 'Carries done — 45s, down the mat and back, three rounds, no complaints from anywhere. And that\'s a session.',
    card: 'Suitcase Carries 45 lb × 3 rounds completed. Session ready for closeout.',
    reason: 'The card gives load × rounds as a closeout summary; no per-set distance or reps are stated anywhere in the session, so no set-level parse is recoverable in stated form.',
  },
  {
    id: 'EX-SC11-DEV-01',
    source: { doc: DOC, ref: 'Session 11 (Dev)' },
    session: 11, persona: 'dev',
    input: 'Bench 135 10/5 185 6/3 6/3 6/2. This used to be my warmup. Not going to lie, that stings.',
    card: 'Bench parsed: 185 × 6 @3, @3, @2 after warmup. Restart block, session 1.',
    reason: 'The card states the working sets "after warmup" without the warmup\'s numbers and without a total set count — same unstated-warmup shape as EX-SC6-MARCUS-01 and EX-SC8-JONAS-01.',
  },
  {
    id: 'EX-SC11-DEV-02',
    source: { doc: DOC, ref: 'Session 11 (Dev)' },
    session: 11, persona: 'dev',
    input: 'Rows on the new gym\'s machine — no idea how it loads. Plate-loaded, did 2 plates a side for 10, felt like 3 left. Then 2 plates + a quarter, 10 with 2 left, twice.',
    card: 'Plate-Loaded Row (new equipment): 2pps × 10 @~3 (finder), 2pps+25 × 10 @2 x2. Machine baseline created.',
    reason: 'The parse is stated, but the load exists only in plates per side (2pps, 2pps+25) on an uncalibrated machine. Encoding an absolute weight would require assuming a plate mass — an invented number — so the line cannot enter a weight-based fixture.',
  },
  {
    id: 'EX-SC14-LEO-01',
    source: { doc: DOC, ref: 'Session 14 (Leo)' },
    session: 14, persona: 'leo',
    input: 'Face pulls done, 3 sets of 15, burned SO good. Ok honestly this was a top 3 session ever. Chest day supremacy 💪',
    card: null,
    reason: 'No confirmation card follows this turn, and no load for the face pulls is stated anywhere in the session; the parse is never stated.',
  },
];

module.exports = {
  GOLDENS: Object.freeze(GOLDENS),
  EXCLUDED: Object.freeze(EXCLUDED),
  SOURCE_OF_TRUTH: 'docs/reference/ATLAS_SOUL_CORPUS_V2_SESSIONS.md (owner-provided Soul Corpus V2, recorded 2026-07-22)',
};
