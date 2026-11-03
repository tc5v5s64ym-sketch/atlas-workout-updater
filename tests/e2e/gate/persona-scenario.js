'use strict';

// ── Persona scored-scenario declarations (persona test rig, Slice 2b/2c+) ────
// The scored driver used to compute its declaration inline in persona.spec.js
// in Marcus's shape only: plan destructured three ways, a seeded RIR draw,
// warmups + back-offs + a fat-finger batch + a correction. That block crashed
// for Priya (no topRirDeltaChoices, no backoff, no closeoutMinutes, no
// correctionEndStates) — a scored run died before the first turn. The
// declaration computation now lives here, pure and unit-testable, behind a
// per-slug dispatch: each persona's declaration is computed from ITS fixture
// (plan + variation + facts + beats), never from another persona's shape.
//
// Pure: no clock, network, filesystem, or environment access. The spec owns
// the seeded draw (personaSeed/personaRng, run-id-seeded) and passes the
// drawn values in; this module only derives. A slug with no scored driver
// (Tara, until her slice lands) throws — a scored run must never fall back
// to another persona's beats.
//
// One concern per slice: adding a persona means adding ONE dispatch entry
// here plus its fact checks — the spec's instruments (bubble collector,
// settlement, closeout card → preview → approval, probes, scorecard
// assembly) are persona-agnostic and stay untouched.

const asSet = (planRow, weight, reps, rir) => ({
  exercise: planRow.exercise, lift_code: planRow.lift_code, weight, reps, rir,
});

function beatForm(fixture, id) {
  const beat = (Array.isArray(fixture.beats) ? fixture.beats : []).find((b) => b && b.id === id);
  if (!beat || !Array.isArray(beat.forms) || !beat.forms[0]) {
    throw new Error(`persona scored driver: fixture "${fixture.slug}" declares no usable form for beat "${id}"`);
  }
  return beat.forms[0];
}

// ── Marcus (Slice 2b, the format proof) ───────────────────────────────────────
// The Slice 2b computation, moved verbatim: the top-set RIR draw resolves the
// back-off weight, the batch carries the fat-finger weight, the correction
// restores the plan target. The unit suite pins this entry against the
// pre-extraction inline computation for all three draws — any drift here is
// a Marcus regression, not a generalization.
function buildMarcusDeclaration(fixture, draw) {
  const [squatPlan, benchPlan, rdlPlan] = fixture.plan;
  const topRirDelta = draw && Number.isFinite(draw.topRirDelta) ? draw.topRirDelta : null;
  if (topRirDelta === null) {
    throw new Error('persona scored driver: the Marcus declaration needs a drawn topRirDelta (seeded by the spec from the run id)');
  }
  const topRir = Math.min(5, Math.max(1, squatPlan.target_rir + topRirDelta));
  const bo = fixture.variation.backoff;
  const backoffWeight = topRir > squatPlan.target_rir ? bo.aboveTargetWeight : bo.atOrBelowTargetWeight;
  const correction = fixture.facts.correctionEndStates.find((c) => c.lift_code === rdlPlan.lift_code)
    || fixture.facts.correctionEndStates[0];
  const fatFingerWeight = correction.forbiddenWeight;
  const closeoutMinutes = fixture.variation.closeoutMinutes;
  const squatLineSets = [
    ...fixture.variation.squatWarmups.map((w) => asSet(squatPlan, w.weight, w.reps, w.rir)),
    asSet(squatPlan, squatPlan.target_weight, squatPlan.target_reps, topRir),
  ];
  const backoffSets = Array.from({ length: bo.sets }, () => asSet(squatPlan, backoffWeight, bo.reps, bo.rir));
  const benchSets = Array.from({ length: benchPlan.target_sets },
    () => asSet(benchPlan, benchPlan.target_weight, benchPlan.target_reps, benchPlan.target_rir));
  const rdlLoggedSets = Array.from({ length: rdlPlan.target_sets },
    () => asSet(rdlPlan, fatFingerWeight, rdlPlan.target_reps, rdlPlan.target_rir));
  const rdlCorrectedSets = Array.from({ length: correction.sets },
    () => asSet(rdlPlan, correction.weight, correction.reps, correction.rir));
  const preCorrectionSets = [...squatLineSets, ...backoffSets, ...benchSets, ...rdlLoggedSets];
  const expectedSets = [...squatLineSets, ...backoffSets, ...benchSets, ...rdlCorrectedSets];
  const squatText = `Squat ${fixture.variation.squatWarmups.map((w) => `${w.weight} ${w.reps}/${w.rir}`).join(' ')} ${squatPlan.target_weight} ${squatPlan.target_reps}/${topRir}`;
  const backoffText = `${backoffWeight} ${bo.reps}/${bo.rir} x${bo.sets}`;
  const batchText = `Bench ${benchPlan.target_weight} ${benchPlan.target_reps}/${benchPlan.target_rir} x${benchPlan.target_sets}. RDL ${fatFingerWeight} ${rdlPlan.target_reps}/${rdlPlan.target_rir} x${rdlPlan.target_sets}.`;
  const correctionText = `Typo. ${correction.weight}.`;
  const closeoutText = `Done. ${closeoutMinutes} min.`;
  return {
    expectedSets, closeoutMinutes, closeoutText,
    squatLineSets, backoffSets, benchSets, rdlLoggedSets, rdlCorrectedSets, preCorrectionSets,
    squatText, backoffText, batchText, correctionText,
    squatPlan, benchPlan, rdlPlan, topRirDelta, topRir, backoffWeight, fatFingerWeight, correction,
    declaration: {
      persona_slug: fixture.slug, top_rir_delta: topRirDelta, top_rir: topRir,
      backoff_weight: backoffWeight, fat_finger_weight: fatFingerWeight,
      closeout_minutes: closeoutMinutes, expected_sets: expectedSets,
      expected_counts: fixture.expected,
    },
  };
}

// ── Priya (Slice 2c fixture, scored slice under #1607) ───────────────────────
// Fixed values, not a seeded draw: the script's deviations ARE the test
// inputs (the form bail, the last-set effort read, the plank PB), so the
// fixture declares the script values as the baseline (priya.js variation
// comment). Turn texts are the fixture's own beat forms — the script's
// shapes, never recomputed prose.
//   squat: 35 x 10, sets 1–2 @ target RIR 2, set 3 @ variation.squatSet3Rir 1.
//   bench: the REVISED target from facts.benchRevisedTarget (25 x 8 x3),
//     RIR null — the bail turn states no RIR, and the golden
//     (SC7-PRIYA-02) states RIR null. The plan's 10s are the pre-bail
//     prescription, not the end-state.
//   rows: plan target, 3 sets (per-side, counted as 3 — golden
//     SC7-PRIYA-03: T(3, S(30,10,2)) — not 6).
//   plank: NOT a set — a Modality_Log timed hold (40 s). It rides the
//     rows turn's text and the modality observation, never expectedSets.
function buildPriyaDeclaration(fixture) {
  const [squatPlan, benchPlan, rowPlan] = fixture.plan;
  const revised = fixture.facts.benchRevisedTarget;
  if (!revised) {
    throw new Error('persona scored driver: the Priya declaration needs facts.benchRevisedTarget (the form-bail end-state)');
  }
  const squatSets = [];
  for (let i = 0; i < squatPlan.target_sets; i += 1) {
    const rir = i === squatPlan.target_sets - 1 ? fixture.variation.squatSet3Rir : squatPlan.target_rir;
    squatSets.push(asSet(squatPlan, squatPlan.target_weight, squatPlan.target_reps, rir));
  }
  const benchSets = Array.from({ length: revised.sets },
    () => asSet(benchPlan, revised.weight, revised.reps, null));
  const rowSets = Array.from({ length: rowPlan.target_sets },
    () => asSet(rowPlan, rowPlan.target_weight, rowPlan.target_reps, rowPlan.target_rir));
  const expectedSets = [...squatSets, ...benchSets, ...rowSets];
  const closeoutMinutes = fixture.variation.closeoutMinutes;
  if (closeoutMinutes === undefined || closeoutMinutes === null) {
    throw new Error('persona scored driver: the Priya declaration needs variation.closeoutMinutes (the effort field has no other source)');
  }
  return {
    expectedSets, closeoutMinutes,
    squatSets, benchSets, rowSets,
    benchPlan, rowPlan, squatPlan,
    benchRevised: revised,
    turnTexts: {
      planAsk: beatForm(fixture, 'plan-ask'),
      rirQuestion: beatForm(fixture, 'rir-question'),
      squatLog: beatForm(fixture, 'squat-log'),
      benchBail: beatForm(fixture, 'bench-form-bail'),
      rowsPlank: beatForm(fixture, 'rows-and-plank'),
      progressDoubt: beatForm(fixture, 'progress-doubt'),
      closeout: beatForm(fixture, 'closeout'),
    },
    closeoutText: beatForm(fixture, 'closeout'),
    declaration: {
      persona_slug: fixture.slug,
      closeout_minutes: closeoutMinutes, expected_sets: expectedSets,
      expected_counts: fixture.expected,
      bench_revised: { weight: revised.weight, reps: revised.reps, sets: revised.sets, rir: null },
      plank_seconds: fixture.variation.plankSeconds,
      modality_rows: fixture.expected.modality_rows || 0,
    },
  };
}

function buildDeclaration(slug, fixture, draw) {
  if (slug === 'marcus') return buildMarcusDeclaration(fixture, draw);
  if (slug === 'priya') return buildPriyaDeclaration(fixture);
  if (slug === 'tara') {
    throw new Error('persona scored driver: no scored scenario for "tara" yet — her slice adds a dispatch entry here, it never borrows Priya\'s or Marcus\'s beats');
  }
  throw new Error(`persona scored driver: no scored scenario for slug "${slug}"`);
}

// ── Buffer name map (the spec's readBufferSets, extracted pure) ─────────────
// The session log stamps each entry with the name the LOGGING lane used,
// which is not always the plan's exercise name: Marcus's batch entry for
// the Romanian Deadlift is stamped 'RDL' (first run, 20261030T001500 —
// its parsed sets were correct and the comparison missed them purely on
// the name). Map through every name a plan item legitimately carries:
// its exercise name, its lift-code stem (RDL01 → 'rdl'), and its acronym —
// PLUS the fixture's own catalog synonyms for that lift (Priya's
// catalogRows declare 'rows' for OAR01, 'db bench' for DBB01: the messy
// names her script actually uses). A synonym is fixture-declared, so
// mapping through it cannot invent a lift. Marcus's catalogRows is [],
// so his map is exactly the pre-extraction one. Last write wins on a
// collision, matching the inline construction this replaces.
const bufferKeyOf = (s) => String(s || '').trim().toLowerCase().replace(/[-\s]+/g, ' ');
function buildBufferNameMap(planItems, catalogRows) {
  const byName = {};
  for (const p of (Array.isArray(planItems) ? planItems : [])) {
    byName[bufferKeyOf(p.exercise)] = p;
    byName[bufferKeyOf(String(p.lift_code || '').replace(/[0-9]+$/, ''))] = p;
    byName[bufferKeyOf(String(p.exercise).split(/\s+/).map((w) => w[0]).join(''))] = p;
  }
  for (const row of (Array.isArray(catalogRows) ? catalogRows : [])) {
    const code = String((Array.isArray(row) ? row[2] : '') || '').trim().toUpperCase();
    const plan = (Array.isArray(planItems) ? planItems : [])
      .find((p) => String(p.lift_code || '').trim().toUpperCase() === code);
    if (!plan) continue;
    for (const syn of String((Array.isArray(row) ? row[4] : '') || '').split('|')) {
      if (syn.trim() !== '') byName[bufferKeyOf(syn)] = plan;
    }
  }
  return byName;
}

// Buffer-entry mapping, shared by the spec and the unit tests: the session
// log's numeric fields use persona-facts.js num() semantics — null,
// undefined, and '' all map to NaN, never to 0. The old browser-side
// mapping used Number(), which turned a null RIR (Priya's bench bail,
// golden S(25, 8, null)) into 0, so a parse-correct run could never match
// the declared null-RIR sets. A 0 RIR is a real value and stays 0.
const bufferNum = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
function mapBufferSets(sessionLog, nameMap) {
  const byName = nameMap && typeof nameMap === 'object' ? nameMap : {};
  return (Array.isArray(sessionLog) ? sessionLog : []).map((x) => {
    const rawName = String((x && (x.canonical || x.exercise || x.name)) || '');
    const plan = byName[bufferKeyOf(rawName)];
    return {
      exercise: plan ? plan.exercise : rawName,
      lift_code: plan ? plan.lift_code : '',
      weight: bufferNum(x && x.weight),
      reps: bufferNum(x && x.reps),
      rir: bufferNum(x && x.rir),
    };
  });
}

module.exports = { asSet, buildMarcusDeclaration, buildPriyaDeclaration, buildDeclaration, buildBufferNameMap, bufferKeyOf, mapBufferSets };
