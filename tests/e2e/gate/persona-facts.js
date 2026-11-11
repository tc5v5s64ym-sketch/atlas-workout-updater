'use strict';

// ── Persona fact checks (persona test rig, design §3.4 — Slice 2b) ────────────
// The persona-new deterministic checks, kept OUT of the frozen 25-condition
// rehearsal scorecard: that card judges the harness/product path every run
// shares, while these judge the PERSONA's declared facts — the sets this
// athlete was declared to log, the correction end-states its script promises,
// and the plan-state its fixture declares. A persona run's evidence carries
// BOTH verdicts; neither substitutes for the other.
//
// Pure and fail-closed: no clock, network, filesystem, or environment access.
// The spec MEASURES (durable rows through the session-filtered verifier, the
// client's retained buffer, the client's remaining-work list); this module
// DECIDES what the measurements prove. A missing measurement is a failed
// check with the absence named — never a pass, never a skip.
//
// The expectations are the RUN's, computed by the spec from the persona
// fixture's beat templates and the run's recorded variation draw (design
// §3.3) — never copied from the corpus script's numbers and never read back
// from the product's own output.

const { logCleanedColumns, modalityLogColumns } = require('../../../config/columns');
const { deriveExpectedRemaining } = require('./rehearsal-scorecard');

const nameKey = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[-\s]+/g, ' ');
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

// ── RIR cell state (#1663) ──────────────────────────────────────────────────
// A durable RIR cell can be genuinely empty (no RIR recorded), a number,
// or a non-numeric string ('INVALID'). Number() collapses the last two into
// NaN, so the old comparison could not tell a malformed cell from a missing
// one — and the bench 'no RIR recorded' check passed a malformed cell. The
// state is carried alongside the number and encoded in the comparison tuple,
// so malformed ≠ missing ≠ present. A declaration's RIR is a number or
// null; a malformed declaration value is an authoring hole, encoded as
// malformed so it can never match a durable row.
function rirState(raw) {
  // A JS NaN is missing too: the buffer mapping turns null/empty/missing
  // into NaN by convention (personaLane: mapBufferSets), so a NaN input is
  // a missing RIR, never a malformed one. Only a non-empty, non-numeric
  // VALUE — a string cell like 'INVALID' — is malformed. A whitespace-only
  // cell carries nothing, so it is missing, not a zero: Number(' ') is 0,
  // and a blank cell must never read as a recorded RIR 0.
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (trimmed === '' || trimmed === null || trimmed === undefined || (typeof trimmed === 'number' && Number.isNaN(trimmed))) return { state: 'missing', rir: NaN, raw: '' };
  const n = Number(trimmed);
  if (Number.isFinite(n)) return { state: 'present', rir: n, raw: String(trimmed) };
  return { state: 'malformed', rir: NaN, raw: String(trimmed) };
}

// One comparable set shape across every surface: the declaration the spec
// computes, the client's retained buffer, and the durable rows.
//   { key, exercise, lift_code, weight, reps, rir, rirState, rirRaw }
function declaredSet(s) {
  const o = s && typeof s === 'object' ? s : {};
  const rs = rirState(o.rir);
  return {
    key: nameKey(o.exercise),
    exercise: String(o.exercise || ''),
    lift_code: String(o.lift_code || '').trim().toUpperCase(),
    weight: num(o.weight),
    reps: num(o.reps),
    rir: rs.rir,
    rirState: rs.state,
    rirRaw: rs.raw,
  };
}

function durableRowSet(row) {
  const r = Array.isArray(row) ? row : [];
  const at = (name) => r[logCleanedColumns.indexOf(name)];
  const rs = rirState(at('rir'));
  return {
    key: nameKey(at('canonical_exercise') || at('exercise')),
    exercise: String(at('canonical_exercise') || at('exercise') || ''),
    lift_code: String(at('lift_code') || '').trim().toUpperCase(),
    weight: num(at('weight')),
    reps: num(at('reps')),
    rir: rs.rir,
    rirState: rs.state,
    rirRaw: rs.raw,
  };
}

// One comparable modality shape: the session's Modality_Log rows, in
// modalityLogColumns order.
//   { modality, exercise, durationSec }
function durableModalityRow(row) {
  const r = Array.isArray(row) ? row : [];
  const at = (name) => r[modalityLogColumns.indexOf(name)];
  return {
    modality: String(at('modality') || '').trim().toLowerCase(),
    exercise: String(at('exercise') || '').trim(),
    durationSec: num(at('duration_sec')),
  };
}

const rirTuple = (s) => (s.rirState === 'present' ? String(s.rir)
  : s.rirState === 'malformed' ? `malformed:${s.rirRaw}` : 'missing');
const setTuple = (s) => `${s.key}|${s.lift_code}|${s.weight}|${s.reps}|${rirTuple(s)}`;
const setLabel = (s) => `${s.exercise || s.key} ${s.weight}x${s.reps}@${s.rirState === 'malformed' ? `malformed '${s.rirRaw}'` : (s.rirState === 'missing' ? 'no RIR' : s.rir)}`;

// Multiset comparison with named differences — counts alone cannot prove the
// declared workout (the same rule the scorecard's durable comparison lives by).
function compareSetMultisets(observed, expected) {
  const remaining = (Array.isArray(expected) ? expected : []).map(setTuple);
  const unmatched = [];
  for (const s of (Array.isArray(observed) ? observed : [])) {
    const t = setTuple(s);
    const i = remaining.indexOf(t);
    if (i >= 0) remaining.splice(i, 1);
    else unmatched.push(setLabel(s));
  }
  const missing = [];
  const pool = (Array.isArray(expected) ? expected : []).map((s) => ({ s, t: setTuple(s) }));
  for (const t of remaining) {
    const hit = pool.find((p) => p.t === t);
    if (hit) { missing.push(setLabel(hit.s)); pool.splice(pool.indexOf(hit), 1); }
  }
  return { ok: unmatched.length === 0 && missing.length === 0, unmatched, missing };
}

// The checks. Input:
//   fixture           — the loaded persona fixture (plan + facts declarations)
//   expectedSets      — the run's computed durable declaration (declaredSet inputs)
//   loggedNames       — one exercise name per set the driver logged this run
//   bufferSets        — the retained buffer's sets AFTER the correction beat
//                       (declaredSet inputs), or null when unmeasured
//   durableLogRows    — raw Log_Cleaned rows for THIS session only (arrays)
//   durableModalityRows — raw Modality_Log rows for THIS session only
//                       (arrays), or null when unmeasured; the plank check
//                       judges their content, not just their count
//   observedRemaining — the client's remaining-work names at the final probe,
//                       or null when unmeasured
function checkPersonaFacts(input) {
  const i = input && typeof input === 'object' ? input : {};
  const fixture = i.fixture && typeof i.fixture === 'object' ? i.fixture : {};
  const facts = fixture.facts && typeof fixture.facts === 'object' ? fixture.facts : {};
  const expected = (Array.isArray(i.expectedSets) ? i.expectedSets : []).map(declaredSet);
  const durable = (Array.isArray(i.durableLogRows) ? i.durableLogRows : []).map(durableRowSet);
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: ok === true, detail: detail || '' });

  // ── Parsed-set equality: the durable rows ARE the declared sets ────────────
  const eq = compareSetMultisets(durable, expected);
  add('persona-parsed-set-equality', eq.ok,
    eq.ok
      ? `${durable.length} durable Log_Cleaned rows equal the run's declared sets, one-for-one on exercise/weight/reps/RIR`
      : `undeclared durable rows: [${eq.unmatched.join('; ') || 'none'}]; declared sets with no durable row: [${eq.missing.join('; ') || 'none'}]`);

  // ── Correction end-states (the Slice-1 correction goldens, end-to-end) ─────
  // For each declared correction: the durable rows for that lift are EXACTLY
  // the corrected sets, and no row OF THAT LIFT carries the fat-fingered
  // weight. The scan is scoped to the lift, deliberately: another lift may
  // legitimately use the same number (Marcus's squat back-offs ARE 285 in
  // the unrevised draw — the same 285 that is forbidden on his RDL), and a
  // session-wide ban would fail a correct run on a coincidence.
  const corrections = Array.isArray(facts.correctionEndStates) ? facts.correctionEndStates : [];
  if (!corrections.length) {
    // No correction declared. Whether that fails depends on whether the
    // fixture HAS a correction beat: a correction beat with no declared
    // end-state is an authoring hole (fail, as before); a fixture with no
    // correction beat at all (Priya — no correction by design) has nothing
    // to judge, so the check passes informationally instead of failing a
    // correct run for lacking a beat it never promised.
    const hasCorrectionBeat = Array.isArray(fixture.beats)
      && fixture.beats.some((b) => b && b.kind === 'correction');
    add('persona-correction-end-state', hasCorrectionBeat !== true,
      hasCorrectionBeat
        ? 'the fixture declares no correctionEndStates — a persona with a correction beat must declare its end-state'
        : 'the fixture declares no correction beat and no correctionEndStates — no correction end-state to judge');
  }
  for (const c of corrections) {
    const lift = String(c.lift_code || '').trim().toUpperCase();
    const rows = durable.filter((s) => s.lift_code === lift);
    const want = { weight: num(c.weight), reps: num(c.reps), rir: num(c.rir) };
    const problems = [];
    if (rows.length !== num(c.sets)) problems.push(`${rows.length} durable ${lift} row(s), declared ${c.sets}`);
    const off = rows.filter((s) => s.weight !== want.weight || s.reps !== want.reps || s.rir !== want.rir);
    if (off.length) problems.push(`${off.length} ${lift} row(s) off the corrected end-state: ${off.map(setLabel).join('; ')}`);
    if (c.forbiddenWeight !== undefined && c.forbiddenWeight !== null) {
      const bad = rows.filter((s) => s.weight === num(c.forbiddenWeight));
      if (bad.length) problems.push(`the forbidden weight ${c.forbiddenWeight} survives in ${bad.length} durable ${lift} row(s): ${bad.map(setLabel).join('; ')}`);
    }
    add(`persona-correction-end-state:${lift}`, problems.length === 0,
      problems.length === 0
        ? `${lift} durable rows read ${want.weight}x${want.reps}@${want.rir} x${c.sets} — the corrected end-state, with no ${lift} row at ${c.forbiddenWeight}`
        : problems.join('; '));
  }

  // ── A declared revised target (Priya's form-bail end-state) ─────────────────
  // The same shape as a correction end-state, for a revision that is NOT a
  // correction: the bench target moves 10 → 8 on form, with no item_outcome
  // (endorsed-revision class). The durable rows for that lift must be
  // EXACTLY the revised sets. RIR: the fixture's benchRevisedTarget declares
  // no rir (the bail turn states none, golden SC7-PRIYA-02 states null), so
  // a recorded RIR fails — the row must carry no RIR at all. A fixture
  // without benchRevisedTarget (Marcus) emits no check here, unchanged.
  const revised = facts.benchRevisedTarget && typeof facts.benchRevisedTarget === 'object' ? facts.benchRevisedTarget : null;
  if (revised) {
    const lift = String(revised.lift_code || '').trim().toUpperCase();
    const rows = durable.filter((s) => s.lift_code === lift);
    const want = { weight: num(revised.weight), reps: num(revised.reps) };
    const rirDeclared = revised.rir !== undefined && revised.rir !== null;
    const problems = [];
    if (rows.length !== num(revised.sets)) problems.push(`${rows.length} durable ${lift} row(s), declared ${revised.sets}`);
    // A malformed RIR is NOT a missing one (#1663): it gets its own problem
    // line naming the cell, instead of passing as 'no RIR recorded'.
    const malformed = rows.filter((s) => s.rirState === 'malformed');
    if (malformed.length) problems.push(`${malformed.length} ${lift} row(s) carry a malformed RIR (not a missing one): ${malformed.map((s) => `malformed RIR '${s.rirRaw}'`).join('; ')}`);
    const off = rows.filter((s) => s.weight !== want.weight || s.reps !== want.reps
      || (rirDeclared ? s.rir !== num(revised.rir) : s.rirState === 'present'));
    if (off.length) problems.push(`${off.length} ${lift} row(s) off the revised end-state: ${off.map(setLabel).join('; ')}`);
    add(`persona-bench-revised-target:${lift}`, problems.length === 0,
      problems.length === 0
        ? `${lift} durable rows read ${want.weight}x${want.reps}${rirDeclared ? `@${num(revised.rir)}` : ' with no RIR recorded'} x${revised.sets} — the revised target end-state`
        : problems.join('; '));
  }

  // ── The squat hold rule (Priya's declared hold: 35 stays until all sets
  // reach target RIR) ───────────────────────────────────────────────────────
  // Two halves, both judged: the durable rows for the lift are EXACTLY the
  // held sets (the weight did not move), AND the hold is genuinely
  // exercised — at least one set sits off the target RIR. A run where every
  // set sits at target RIR meets the progression condition, so a hold claim
  // on it is vacuous and fails. A fixture without squatHold (Marcus)
  // emits no check here, unchanged.
  const hold = facts.squatHold && typeof facts.squatHold === 'object' ? facts.squatHold : null;
  if (hold) {
    const lift = String(hold.lift_code || '').trim().toUpperCase();
    const problems = [];
    for (const f of ['weight', 'reps', 'sets', 'targetRir']) {
      if (hold[f] === undefined || hold[f] === null || !Number.isFinite(num(hold[f]))) {
        problems.push(`squatHold declares no usable ${f} — the hold cannot be judged`);
      }
    }
    if (problems.length === 0) {
      const rows = durable.filter((s) => s.lift_code === lift);
      const want = { weight: num(hold.weight), reps: num(hold.reps) };
      if (rows.length !== num(hold.sets)) problems.push(`${rows.length} durable ${lift} row(s), declared ${hold.sets}`);
      const malformed = rows.filter((s) => s.rirState === 'malformed');
      if (malformed.length) problems.push(`${malformed.length} ${lift} row(s) carry a malformed RIR: ${malformed.map((s) => `malformed RIR '${s.rirRaw}'`).join('; ')}`);
      const unusable = rows.filter((s) => s.rirState === 'missing');
      if (unusable.length) problems.push(`${unusable.length} ${lift} row(s) carry no usable RIR — the hold cannot be judged from them`);
      const off = rows.filter((s) => s.weight !== want.weight || s.reps !== want.reps);
      if (off.length) problems.push(`${off.length} ${lift} row(s) off the held end-state: ${off.map(setLabel).join('; ')}`);
      const rirs = rows.filter((s) => s.rirState === 'present').map((s) => s.rir);
      if (rows.length && rirs.length === rows.length && rirs.every((r) => r === num(hold.targetRir))) {
        problems.push(`all ${rows.length} ${lift} sets sit at target RIR ${num(hold.targetRir)} — the hold is not exercised, the weight should progress`);
      }
      add(`persona-squat-hold:${lift}`, problems.length === 0,
        problems.length === 0
          ? `${lift} durable rows read ${want.weight}x${want.reps} x${rows.length} — the weight stays ${want.weight} with set RIRs: ${rows.map((s) => (s.rirState === 'present' ? s.rir : s.rirState)).join(', ')} (target ${num(hold.targetRir)}, so the hold is exercised)`
          : problems.join('; '));
    } else {
      add(`persona-squat-hold:${lift || 'UNKNOWN'}`, false, problems.join('; '));
    }
  }

  // ── The next squat hold recommendation (reopened #1663) ─────────────────
  // The squat-hold check above judges TODAY's rows; the recommendation —
  // what the coach tells Priya to do NEXT time — is model prose in the
  // reply, and the script declares no next squat weight, so no automated
  // consumer can judge whether a recommended value is right. The smallest
  // permitted closure is the plank-baseline pattern: the fixture marks
  // the recommendation human-judged, the review checklist carries the
  // hold rule for the human judge, and this check enforces BOTH — an
  // unmarked recommendation, or a checklist with no squat-recommendation
  // item, fails naming the rule. The checklist match is deliberately
  // narrow (squat + next/recommend + hold/stay/progress) so a vague item
  // cannot satisfy it. A fixture without squatHold (Marcus) emits no
  // check here, unchanged.
  if (hold) {
    const lift = String(hold.lift_code || '').trim().toUpperCase();
    const problems = [];
    if (hold.nextRecommendationJudgedBy !== 'human') {
      problems.push(`the next ${lift} hold recommendation has no automated consumer and is not marked human-judged — mark it nextRecommendationJudgedBy: 'human'`);
    }
    const checklist = Array.isArray(fixture.reviewChecklist) ? fixture.reviewChecklist : [];
    const covers = checklist.some((item) => {
      const t = String(item || '').toLowerCase();
      return /squat/.test(t) && (/next/.test(t) || /recommend/.test(t)) && (/hold/.test(t) || /stay/.test(t) || /progress/.test(t));
    });
    if (!covers) {
      problems.push('the review checklist carries no item naming the next squat hold recommendation — add one stating the hold rule for the human judge');
    }
    const rule = ['weight', 'sets', 'targetRir'].every((f) => Number.isFinite(num(hold[f])))
      ? ` — the hold stays ${num(hold.weight)} until all ${num(hold.sets)} sets sit at target RIR ${num(hold.targetRir)}`
      : '';
    add('persona-squat-hold-recommendation', problems.length === 0,
      problems.length === 0
        ? `The next ${lift} hold recommendation is human-judged (review checklist)${rule}`
        : problems.join('; '));
  }

  // ── The plank PB (Priya's declared finisher) ─────────────────────────────
  // Split by what is measurable. Today's hold IS judged here: the session's
  // Modality_Log rows must carry exactly one plank timed hold at todaySec —
  // a count-only observation let a 5-second treadmill row stand in for the
  // plank (the audit's counterexample), so the content is judged, not the
  // count. The baseline comparison (previousBestSec) has no engine-visible
  // history to judge it against — a timed hold has no GATE-H row shape —
  // so the fixture must mark it human-judged; an unmarked baseline fails,
  // naming the rule. A fixture without plankPb (Marcus) emits no check
  // here, unchanged.
  const pb = facts.plankPb && typeof facts.plankPb === 'object' ? facts.plankPb : null;
  if (pb) {
    const problems = [];
    if (pb.todaySec === undefined || pb.todaySec === null || !Number.isFinite(num(pb.todaySec))) {
      problems.push('plankPb declares no usable todaySec — the hold cannot be judged');
    }
    if (pb.previousBestSec !== undefined && pb.previousBestSec !== null) {
      if (pb.previousBestJudgedBy !== 'human') {
        problems.push(`previousBestSec ${pb.previousBestSec} has no automated consumer and is not marked human-judged — mark it previousBestJudgedBy: 'human' or remove it`);
      } else if (Number.isFinite(num(pb.todaySec)) && num(pb.todaySec) <= num(pb.previousBestSec)) {
        problems.push(`todaySec ${pb.todaySec} does not beat previousBestSec ${pb.previousBestSec} — the declared PB is not a PB`);
      }
    }
    if (!Array.isArray(i.durableModalityRows)) {
      problems.push('no modality observation was recorded — the plank hold is unproven');
    } else if (problems.length === 0) {
      const mods = i.durableModalityRows.map(durableModalityRow);
      const named = mods.filter((m) => /plank/i.test(m.exercise || ''));
      if (named.length === 0) {
        const found = mods.map((m) => `${m.exercise || m.modality || 'unnamed'} ${Number.isFinite(m.durationSec) ? `${m.durationSec}s` : 'no duration'}`).join(', ') || 'none';
        problems.push(`no plank row in Modality_Log — found [${found}]`);
      } else if (named.length !== 1) {
        problems.push(`${named.length} plank rows in Modality_Log, declared 1`);
      } else {
        const row = named[0];
        if (row.modality !== 'timed_hold') problems.push(`the plank row is modality '${row.modality}', not a timed_hold`);
        if (row.durationSec !== num(pb.todaySec)) problems.push(`plank row reads ${Number.isFinite(row.durationSec) ? `${row.durationSec}s` : 'no duration'}, declared ${num(pb.todaySec)}s`);
      }
    }
    add('persona-plank-pb', problems.length === 0,
      problems.length === 0
        ? `Plank timed hold lands in Modality_Log at ${num(pb.todaySec)}s — today's PB; the ${pb.previousBestSec}s baseline comparison is human-judged (review checklist)`
        : problems.join('; '));
  }

  // ── The retained buffer carries the correction BEFORE any save ─────────────
  // The durable rows could in principle be repaired at write time; the script's
  // promise is stronger — the athlete's own session state is corrected the
  // moment the correction is accepted. Measured from the client's session log
  // after the correction beat, compared against the same declaration.
  // For a persona with no correction beat (Priya), the buffer is measured
  // after the final log turn instead; the caller names that moment via
  // bufferContext/bufferNote so the detail never claims a correction that
  // never happened. Marcus passes neither and gets the original wording.
  const bufferContext = typeof i.bufferContext === 'string' ? i.bufferContext : 'after the correction';
  const bufferNote = typeof i.bufferNote === 'string' ? i.bufferNote : '(corrected weight in place, every other lift untouched)';
  if (!Array.isArray(i.bufferSets)) {
    add('persona-retained-buffer-corrected', false,
      `no retained-buffer measurement was recorded — the in-session end-state ${bufferContext} is unproven`);
  } else {
    const buf = compareSetMultisets(i.bufferSets.map(declaredSet), expected);
    add('persona-retained-buffer-corrected', buf.ok,
      buf.ok
        ? `the retained buffer ${bufferContext} equals the declared sets ${bufferNote}`
        : `buffer sets not in the declaration: [${buf.unmatched.join('; ') || 'none'}]; declared sets missing from the buffer: [${buf.missing.join('; ') || 'none'}]`);
  }

  // ── Plan-state facts: the fixture's declared end-state of the plan ─────────
  // Three-way: the fixture's facts declaration, the expectation DERIVED from
  // the plan + the sets logged this run (the scorecard's own derivation), and
  // the client's observed remaining work. The declaration and the derivation
  // must agree (authoring consistency), and the client must agree with both
  // (product truth).
  const declared = facts.planState && typeof facts.planState === 'object' ? facts.planState : null;
  if (!declared || !Array.isArray(declared.remainingExercises)) {
    add('persona-plan-state-facts', false, 'the fixture declares no facts.planState.remainingExercises to judge against');
  } else if (!Array.isArray(i.observedRemaining)) {
    add('persona-plan-state-facts', false, 'no remaining-work observation was recorded — the plan end-state is unproven');
  } else {
    const derived = deriveExpectedRemaining({
      plan: Array.isArray(fixture.plan) ? fixture.plan : [],
      loggedNames: Array.isArray(i.loggedNames) ? i.loggedNames : [],
      replacement: null,
    });
    const problems = [];
    const sameList = (a, b) => a.length === b.length && a.every((v, ix) => nameKey(v) === nameKey(b[ix]));
    if (!sameList(derived.remaining.map(nameKey), declared.remainingExercises.map(nameKey))) {
      problems.push(`the derived remaining [${derived.remaining.join(', ')}] disagrees with the fixture's declared remaining [${declared.remainingExercises.join(', ')}]`);
    }
    if (!sameList(i.observedRemaining.map(nameKey), derived.remaining.map(nameKey))) {
      problems.push(`the client reports remaining [${i.observedRemaining.join(', ')}]; the declaration derives [${derived.remaining.join(', ')}]`);
    }
    if (Array.isArray(declared.completedExercises)) {
      if (!sameList(derived.complete.map(nameKey), declared.completedExercises.map(nameKey))) {
        problems.push(`the derived completed [${derived.complete.join(', ')}] disagrees with the fixture's declared completed [${declared.completedExercises.join(', ')}]`);
      }
    }
    add('persona-plan-state-facts', problems.length === 0,
      problems.length === 0
        ? `remaining work after the final turn is [${derived.remaining.join(', ') || 'none'}] — fixture declaration, derivation, and client state agree`
        : problems.join('; '));
  }

  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = { checkPersonaFacts, compareSetMultisets, declaredSet, durableRowSet, durableModalityRow, nameKey };
