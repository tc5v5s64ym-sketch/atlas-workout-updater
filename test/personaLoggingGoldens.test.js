'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GOLDENS } = require('./fixtures/personaLoggingGoldens');
const { parseWorkoutText, EXERCISE_ALIASES } = require('../services/workoutTextParser');
const { recognizeModalityInput } = require('../services/multiModalityParser');

// ---------------------------------------------------------------------------
// Persona Test Rig, Slice 1b (issue #1607) — the golden DRIVER.
//
// Runs every `log` golden in test/fixtures/personaLoggingGoldens.js through
// the real unit parser seam and compares the produced set structure against
// the parse the Soul Corpus itself states (design §2.2). No browser, no
// model, no reply prose — behaviour, not wording.
//
// ROUTING (the way production routes a turn, per design §2.2):
//   - Resistance exercises go through services/workoutTextParser.js
//     `parseWorkoutText(input)` — called with NO context object, exactly as
//     the existing unit homes call it (test/multiModalityParser.test.js,
//     test/confirmation-card-routing.test.js). The unit seam therefore
//     receives no session state: no activeExercise for nameless
//     continuations, no declared plan for "as written" turns. Where the
//     corpus card states a parse that depends on that session context, the
//     golden fails here and the failure is registered below with that
//     reason — recovering session context is Slice 2's end-to-end job.
//   - Exercises whose expected sets are purely timed/cardio shapes
//     ({ durationSec } / { distanceM } only) go through
//     services/multiModalityParser.js `recognizeModalityInput(input)`,
//     which contractually returns null for slash input. A mixed turn (one
//     resistance exercise + one timed hold, SC7-PRIYA-03) runs BOTH seams
//     and the union is compared.
//
// COMPARISON RULES:
//   - Exercise identity: both the golden's corpus name and the parser's
//     canonical_name are resolved through the parser's OWN alias table
//     (EXERCISE_ALIASES: canonical + aliases -> canonical), so 'RDL' and
//     'Romanian Deadlift' are the same exercise because the parser's data
//     says so — not because this test is lenient. If the parser flagged
//     the exercise `unknown_exercise`, identity is NOT established (the
//     parser's own account says it did not recognize the lift), however
//     exact the sets are.
//   - Exercises are compared in input order, resistance and modality
//     queues separately; exercise count must match exactly.
//   - Sets are compared per set, in order, over the fixture's measures
//     (weight, reps, rir, durationSec, distanceM). A field the corpus
//     states (non-null) must equal the parsed value exactly. A field the
//     corpus does NOT state (null) must stay unstated in the parse: a
//     parsed number where the golden says null is an INVENTED value and
//     counts as a mismatch.
//
// THE RATCHET (the honest core of this slice):
//   A golden that fails against the current parser is a FINDING, not a
//   fixture error. Every currently-failing golden is named in
//   KNOWN_FAILURES below with a one-line observed-vs-expected summary.
//   The suite enforces the register in both directions:
//     (a) a golden that fails WITHOUT a register entry fails the suite;
//     (b) a register entry whose golden now PASSES fails the suite
//         (stale register) — the entry must be removed in the same PR
//         that fixes the parser.
//   The register may only shrink via a parser fix. Never edit a golden,
//   and never add a register entry, to make a failure go away quietly:
//   the register IS the finding list for follow-up parser-fix slices.
//
// CORRECTION GOLDENS: the two `correction-end-state` goldens are
// NOT-RUN-BY-DESIGN at this seam. The design (§2.2) encodes corrections
// as end-states of a prior parse; it names no unit-level seam that
// applies a correction turn to retained state (parseWorkoutText's
// update paths are single-set, last-set only, and both corpus
// corrections amend an earlier set / a whole exercise load from session
// context). Faking a unit test for them would test nothing real, so
// they are accounted for explicitly below and belong to Slice 2's
// end-to-end checks.
// ---------------------------------------------------------------------------

const MEASURES = ['weight', 'reps', 'rir', 'durationSec', 'distanceM'];

// ── Known failures register ───────────────────────────────────────────────
// id -> one-line observed-vs-expected summary. Enforced exactly (see the
// ratchet rules in the header): this set must equal the set of goldens
// that fail, neither a superset nor a subset.
const KNOWN_FAILURES = {
  'SC1-OWNER-02': "bare 'Incline' is ambiguous to the parser (needs_clarification); expected Incline Dumbbell Bench 75 x [8/2, 7/1, 6/1]",
  'SC1-OWNER-03': "bare 'Rows' is ambiguous to the parser (needs_clarification); the card states Seated Rows from session context the unit seam does not receive",
  'SC1-OWNER-04': "'KR 15 x3' resolves to Hanging Knee Raises but the parser finds no sets (needs_clarification, missing_sets); expected 3 x 15 reps bodyweight",
  'SC2-OWNER-03': 'sentence-stacked second exercise is not split (needs_clarification, unattributable_trailing_sets); expected Lat Pulldown + Incline Dumbbell Curl, 3 sets each',
  'SC3-OWNER-03': "sets are exact (150 x [12/2, 10/1]) but the exercise is left unresolved — parser logs 'Extensions' with unknown_exercise; expected identity Leg Extension",
  'SC4-OWNER-01': "sets are exact but the exercise is left unresolved — parser logs 'Machine Press' with unknown_exercise; expected identity Machine Chest Press (absent from the parser ontology)",
  'SC4-OWNER-02': "nameless continuation '140 8/2 x2' has no exercise (needs_clarification, missing_exercise); the unit seam receives no activeExercise — production supplies it from session state",
  'SC4-OWNER-03': "bare 'Rows' is ambiguous to the parser (needs_clarification); the card states Seated Rows by plan match against the session's declared plan",
  'SC5-OWNER-03': "bare 'Rows' is ambiguous to the parser (needs_clarification); the card states Seated Rows from session context the unit seam does not receive",
  'SC6-MARCUS-01': "nameless back-off continuation '290 5/2 x3' has no exercise (needs_clarification, missing_exercise); the unit seam receives no activeExercise — production supplies it from session state",
  'SC6-MARCUS-02': 'log_sets_multi drops the x3 multiplier: 1 set per exercise instead of 3 (Bench 225 5/2 and RDL 285 6/2 each logged once)',
  'SC7-PRIYA-01': 'prose log is not parsed (needs_clarification, missing_exercise); expected Goblet Squat 35 x [10/2, 10/2, 10/1]',
  'SC7-PRIYA-02': 'question-shaped log produces no usable parse (needs_clarification, unattributable_trailing_sets); expected Dumbbell Bench 3 x (25 lb x 8)',
  'SC7-PRIYA-03': "rows half is ambiguous ('Rows', needs_clarification) and the modality recognizer returns the plank as timed_hold with exercise null — duration 40 s matches, identity 'Plank' is not recovered",
  'SC8-JONAS-01': 'stacked Rows sets are dropped (needs_clarification, unattributable_trailing_sets) after the Bench parse; expected Bench Press + Rows',
  'SC9-RAY-01': 'a 3-exercise batch log that also asks a question is suppressed whole (intent question, logged_nothing_question); nothing is logged',
  'SC9-RAY-02': "modality recognizer returns null for the prose interval log '4 x 500'; expected Rower 4 x 500 m",
  'SC10-ELLEN-01': 'full-sentence prose log is not parsed (needs_clarification, missing_exercise); expected Leg Press [180x10/4, 230x8/2 x3]',
  'SC10-ELLEN-02': 'prose two-exercise turn is not parsed (needs_clarification, unattributable_trailing_sets); expected Incline Dumbbell Bench + Seated Rows',
  'SC12-SAM-01': 'sparse prose batch of three exercises is not parsed (needs_clarification, multiple_exercises_in_input)',
  'SC13-TARA-01': 'mixed slash + prose stopped-set turn is not parsed (needs_clarification, unattributable_trailing_sets); expected Landmine Press + Dumbbell Bench with the stopped 5-rep set',
  'SC13-TARA-02': "the 'done as written' sets exist only in the declared plan (needs_clarification, unattributable_trailing_sets); the unit seam receives no plan context",
  'SC14-LEO-01': "colon-format log 'Incline DB 80s: 10/2, 9/2, 9/1' is not parsed (needs_clarification, missing_exercise)",
  'SC14-LEO-02': 'colon-format two-exercise log is not parsed (needs_clarification, missing_exercise); expected Machine Press + Cable Flyes',
  'SC15-NADIA-01': 'prose-led log is not parsed (needs_clarification, missing_exercise); expected Trap Bar Deadlift + Bulgarian Split Squats',
  'SC15-NADIA-02': 'stacked Rows sets are dropped (needs_clarification, unattributable_trailing_sets) after the Bench parse; expected Bench Press + Rows',
};

// Correction goldens deliberately not run at this seam — see the header.
// id -> why the unit seam cannot run it.
const NOT_RUN_BY_DESIGN = {
  'SC5-OWNER-02': 'correction amends the FIRST back-off set of a retained parse; no unit seam applies a correction turn to retained multi-set state (Slice 2 end-to-end)',
  'SC6-MARCUS-03': "correction 'Typo. 275.' refers to a retained parse by session context alone; no unit seam resolves the referent (Slice 2 end-to-end)",
};

// ── Exercise identity, resolved through the parser's own alias table ─────
const normName = (s) => String(s == null ? '' : s)
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const IDENTITY = new Map();
for (const [canonical, aliases] of EXERCISE_ALIASES) {
  IDENTITY.set(normName(canonical), canonical);
  for (const a of aliases || []) IDENTITY.set(normName(a), canonical);
}
function resolveIdentity(name) {
  if (!name) return null;
  const n = normName(name);
  if (IDENTITY.has(n)) return IDENTITY.get(n);
  if (n.endsWith('s')) {
    const singular = n.slice(0, -1);
    if (IDENTITY.has(singular)) return IDENTITY.get(singular);
  }
  return n; // unresolved: compares as its own normalized string
}

// ── Seam adapters: normalize both parsers' outputs to the fixture shape ──
function fromTextParse(input) {
  const r = parseWorkoutText(input);
  if (r.intent === 'log_sets') {
    return { exercises: [{ name: r.canonical_name, sets: r.sets || [], warnings: r.warnings || [] }], note: null };
  }
  if (r.intent === 'log_sets_multi') {
    return {
      exercises: (r.exercises || []).map((e) => ({ name: e.canonical_name, sets: e.sets || [], warnings: e.warnings || [] })),
      note: null,
    };
  }
  const warnings = (r.warnings && r.warnings.length) ? ` (${r.warnings.join(', ')})` : '';
  return { exercises: [], note: `intent ${r.intent}${warnings}` };
}

function fromModality(input) {
  const r = recognizeModalityInput(input);
  if (!r) return null;
  if (r.modality === 'timed_hold') {
    return { name: r.exercise || null, sets: Array.from({ length: r.sets || 1 }, () => ({ durationSec: r.duration_sec })), warnings: [] };
  }
  if (r.modality === 'cardio_interval') {
    const proto = r.work_distance_m != null ? { distanceM: r.work_distance_m } : { durationSec: r.work_sec };
    return { name: r.exercise || null, sets: Array.from({ length: r.rounds || 1 }, () => ({ ...proto })), warnings: [] };
  }
  if (r.modality === 'cardio_steady') {
    const proto = r.distance_km != null ? { distanceM: Math.round(r.distance_km * 1000) } : { durationSec: (r.duration_min || 0) * 60 };
    return { name: r.exercise || null, sets: [proto], warnings: [] };
  }
  return { name: r.exercise || null, sets: [], warnings: [], unsupportedModality: r.modality };
}

// ── Comparison ─────────────────────────────────────────────────────────────
const isModalitySet = (s) => s.weight == null && s.reps == null && s.rir == null
  && (s.durationSec != null || s.distanceM != null);

function compareSets(goldenId, exName, expectedSets, actualSets, mismatches) {
  if (expectedSets.length !== actualSets.length) {
    mismatches.push(`${exName}: set count — expected ${expectedSets.length}, parsed ${actualSets.length}`);
  }
  const n = Math.min(expectedSets.length, actualSets.length);
  for (let i = 0; i < n; i += 1) {
    for (const k of MEASURES) {
      const ev = expectedSets[i][k] == null ? null : expectedSets[i][k];
      const av = actualSets[i][k] == null ? null : actualSets[i][k];
      if (ev === null && av === null) continue;
      if (ev === null) {
        mismatches.push(`${exName} set ${i + 1}: ${k} invented as ${av} (corpus states no ${k})`);
      } else if (av !== ev) {
        mismatches.push(`${exName} set ${i + 1}: ${k} — expected ${ev}, parsed ${av}`);
      }
    }
  }
}

function compareQueue(golden, expected, actual, mismatches, seamNote) {
  if (expected.length !== actual.length) {
    mismatches.push(`exercise count — expected ${expected.length} (${expected.map((e) => e.name).join(', ')}), parsed ${actual.length}${seamNote ? ` [${seamNote}]` : ''}`);
  }
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i += 1) {
    const exp = expected[i];
    const act = actual[i];
    if ((act.warnings || []).includes('unknown_exercise')) {
      mismatches.push(`${exp.name}: exercise left unresolved by the parser (unknown_exercise, logged as '${act.name}')`);
    } else if (resolveIdentity(exp.name) !== resolveIdentity(act.name)) {
      mismatches.push(`exercise identity — expected '${exp.name}' (resolves to '${resolveIdentity(exp.name)}'), parsed '${act.name}' (resolves to '${resolveIdentity(act.name)}')`);
    }
    compareSets(golden.id, exp.name, exp.sets, act.sets || [], mismatches);
  }
}

function evaluate(golden) {
  const mismatches = [];
  const expectedRes = [];
  const expectedMod = [];
  for (const e of golden.expected.exercises) {
    (e.sets.every(isModalitySet) ? expectedMod : expectedRes).push(e);
  }
  let actualRes = [];
  let note = null;
  if (expectedRes.length > 0) {
    try {
      const t = fromTextParse(golden.input);
      actualRes = t.exercises;
      note = t.note;
    } catch (err) {
      mismatches.push(`parseWorkoutText threw: ${err.message}`);
    }
  }
  let actualMod = [];
  if (expectedMod.length > 0) {
    try {
      const m = fromModality(golden.input);
      if (m) actualMod = [m];
    } catch (err) {
      mismatches.push(`recognizeModalityInput threw: ${err.message}`);
    }
  }
  compareQueue(golden, expectedRes, actualRes, mismatches, note);
  compareQueue(golden, expectedMod, actualMod, mismatches, null);
  return mismatches;
}

// ── Run every log golden once; the tests below assert over the results ────
const LOG_GOLDENS = GOLDENS.filter((g) => g.kind === 'log');
const RESULTS = new Map(LOG_GOLDENS.map((g) => [g.id, evaluate(g)]));

for (const g of LOG_GOLDENS) {
  test(`golden ${g.id} — ${g.persona}, session ${g.session}: stated parse vs production parser`, () => {
    const mismatches = RESULTS.get(g.id);
    if (KNOWN_FAILURES[g.id]) {
      assert.ok(
        mismatches.length > 0,
        `${g.id} is in the known-failures register but now PASSES. Remove its register entry in the same PR as the parser fix — the register may only shrink via a fix.`,
      );
    } else {
      assert.deepEqual(
        mismatches,
        [],
        `${g.id} fails against the current parser and is NOT in the known-failures register. Either this is a parser regression (fix the parser) or a new finding (register it with a one-line observed-vs-expected summary):\n - ${mismatches.join('\n - ')}`,
      );
    }
  });
}

test('ratchet: the known-failures register names exactly the goldens that fail — no more, no fewer', () => {
  const failing = LOG_GOLDENS.filter((g) => RESULTS.get(g.id).length > 0).map((g) => g.id).sort();
  assert.deepEqual(
    Object.keys(KNOWN_FAILURES).sort(),
    failing,
    'register/failure drift: a golden started passing (remove its entry with the parser fix) or started failing (register the finding) — never edit a golden to move this line',
  );
  for (const [id, summary] of Object.entries(KNOWN_FAILURES)) {
    assert.equal(typeof summary, 'string', `${id}: register summary`);
    assert.ok(summary.trim().length > 0, `${id}: every register entry carries its one-line observed-vs-expected summary`);
  }
});

test('correction-end-state goldens are accounted for as NOT-RUN-BY-DESIGN at the unit seam', () => {
  const corrections = GOLDENS.filter((g) => g.kind === 'correction-end-state').map((g) => g.id).sort();
  assert.deepEqual(
    Object.keys(NOT_RUN_BY_DESIGN).sort(),
    corrections,
    'every correction-end-state golden must be explicitly accounted for in NOT_RUN_BY_DESIGN — they may not silently vanish from the driver',
  );
  for (const [id, reason] of Object.entries(NOT_RUN_BY_DESIGN)) {
    assert.ok(typeof reason === 'string' && reason.trim().length > 0, `${id}: not-run entries carry their reason`);
    assert.ok(!(id in KNOWN_FAILURES), `${id}: a not-run golden is not a known failure — the two registers never overlap`);
  }
});
