'use strict';

// Golden Session adapter for the live-retest runner (Phase 4, live-testing slice PR B).
//
// WHAT THIS IS. The Golden Session is defined ONCE, in `test/fixtures/goldenSession.js`.
// This module is the ADAPTER that lets the existing `scripts/live-retest.js` runner
// select and replay that fixture through the real browser flow. It reads the fixture and
// derives everything from it. It holds NO second catalogue of beats: it never redefines,
// reorders, adds, drops, or rewrites a beat, and if the fixture changes, the plan this
// module produces changes with it.
//
// WHAT THIS IS NOT. It does not capture evidence (PR C) and it installs no write
// authorization (PR D). Every write-capable beat is deterministically BLOCKED here with an
// explicit reason, and there is no code path in this module or in the runner that can
// execute one — not "disabled by a flag", but absent. Nothing here presses Approve, Save,
// Closeout, or Seal.
//
// FOUR OUTCOME CLASSES (the adapter must tell these apart — they are not interchangeable):
//   • executable      — a read-only browser beat that can be driven now (composer +
//                       preview, the same dry-run path the runner already uses).
//   • write_blocked   — a write-capable beat, blocked pending the PR-D write posture.
//   • fixture_error   — the fixture or its configuration is unusable (unknown seam,
//                       missing id, no derivable input). Fails CLOSED — never skipped.
//   • settlement failure — an executable beat that ran but whose reply never settled.
//                       Recorded per beat at run time (see `beatSettlementFailure`),
//                       never folded into "blocked" and never into a pass.
//
// PURITY. No fs, no network, no browser, no Playwright. The runner owns the browser and
// calls into the pure functions here, so the whole beat plan is unit-testable.

const { GOLDEN_SESSION } = require('../test/fixtures/goldenSession');

const SCENARIO_KEY = 'golden-session';

// --- The write posture (installed by PR D; NOT present in this PR) -----------
// A single frozen fact the whole adapter reads. It is `installed: false` here, and this
// PR ships no way to make it true: the runner has no executor for a write-capable seam.
// PR D is what adds the owner-authorized posture AND the executor it gates.
const WRITE_POSTURE = Object.freeze({
  installed: false,
  authorized: false,
  installedBy: 'PR D (owner-authorized write posture)',
  reason: 'no owner-authorized write posture exists yet — PR D installs it; until then a write-capable beat is blocked, never executed'
});

// --- Seam classification -----------------------------------------------------
// Every seam the fixture can name, and what the browser may do with it. Keyed on the
// fixture's own `seam` values — the fixture is the authority for which seam a beat uses;
// this table only says whether that seam is read-only or write-capable.
//
// READ-ONLY seams reach the deployed app through the composer + PREVIEW button, which is
// a `test_mode` dry-run — the same posture the runner has always used. WRITE-CAPABLE
// seams change durable state (plan acceptance opens the Session_Plans ledger; a revision
// writes a planned-set row; closeout is the single approved write; seal finalizes the
// ledger), so all four are blocked here.
const SEAM_POLICY = Object.freeze({
  'coach/message:plan': { writeCapable: false, surface: 'composer-preview' },
  'coach/message:block': { writeCapable: false, surface: 'composer-preview' },
  'coach/message:set': { writeCapable: false, surface: 'composer-preview' },
  'coach/ask': { writeCapable: false, surface: 'composer-preview' },
  'client:start-this-plan': { writeCapable: true, surface: 'client-action' },
  'client:revise': { writeCapable: true, surface: 'client-action' },
  'client:closeout': { writeCapable: true, surface: 'client-action' },
  'client:seal': { writeCapable: true, surface: 'client-action' }
});

// Why each write-capable beat is blocked, in the fixture's own terms. Stated per seam so
// the owner report says what the beat WOULD do, not just that it is blocked.
const WRITE_BLOCK_REASON = Object.freeze({
  'client:start-this-plan': 'plan acceptance opens the durable Session_Plans ledger for the session — a write',
  'client:revise': 'an endorsed revision creates a durable Session_Plan_Sets row — a write',
  'client:closeout': 'closeout is the single approved write of the session (preview → approve → write)',
  'client:seal': 'sealing finalizes the plan ledger — a write'
});

// --- Evidence fields PR C is expected to capture ------------------------------
// Declared here so the dry-run report can show the owner exactly what the next slice will
// record, and so PR C has a fixture-derived contract to build against rather than a fresh
// invention. Every field is operational metadata (ids, booleans, enums, counts, lengths)
// — deliberately NO reply text, DOM values, or screenshots, because an authenticated run
// renders the owner's private surface on a public repository.
const EVIDENCE_FIELDS = Object.freeze({
  executable: Object.freeze([
    'beat_id', 'beat_index', 'seam', 'executed', 'settled', 'settle_reason',
    'waited_ms', 'reply_length', 'forbidden_hit'
  ]),
  write_blocked: Object.freeze([
    'beat_id', 'beat_index', 'seam', 'executed', 'blocked_reason', 'write_posture_installed'
  ]),
  fixture_error: Object.freeze([
    'beat_id', 'beat_index', 'seam', 'error'
  ])
});

// The behavioral facts from the fixture's own `expect` that PR C should record for a beat.
// Field names are the real response fields the golden-transcript test already asserts
// (`data.note_tier`, `data.note_trigger`) — not new invented surface.
function expectedBehaviorFields(beat) {
  const expect = (beat && beat.expect) || {};
  const fields = [];
  if (expect.behavior) fields.push('note_tier');
  if (expect.trigger) fields.push('note_trigger');
  if (expect.kind) fields.push('kind');
  return fields;
}

// --- Fixture → composer input -------------------------------------------------
// A TRANSPORT rendering, not a new beat. The fixture states each beat's facts as the
// client posts them to `/api/coach/message`; a browser replay has to put those same facts
// into the composer. This renders them mechanically from the fixture — the beat's
// identity, order, seam, and semantics all still come from the fixture alone, and a test
// pins each rendering so it cannot drift away from the facts it claims to carry.
//
// Slash notation is the parser contract (`225 5/2` = 225 lb × 5 reps @ RIR 2). A set with
// no RIR renders as bare reps; the renderer never fabricates an RIR.
function renderSet(set) {
  const weight = set && set.weight;
  const reps = set && set.reps;
  if (weight === undefined || weight === null || reps === undefined || reps === null) return null;
  const rir = set.rir;
  return rir === undefined || rir === null ? `${weight} ${reps}` : `${weight} ${reps}/${rir}`;
}

function renderBeatInput(beat) {
  const seam = beat && beat.seam;
  const facts = (beat && beat.facts) || {};

  if (seam === 'coach/ask') {
    // The fixture's own words for this beat: an in-session "why?".
    return 'why?';
  }

  if (seam === 'coach/message:plan') {
    if (!facts.exerciseName) return null;
    return `what's the plan for ${facts.exerciseName} today?`;
  }

  if (seam === 'coach/message:block' || seam === 'coach/message:set') {
    if (!facts.exerciseName || !Array.isArray(facts.todaySets) || facts.todaySets.length === 0) return null;
    const sets = facts.todaySets.map(renderSet);
    if (sets.some(s => s === null)) return null;
    return `${facts.exerciseName} ${sets.join(' ')}`;
  }

  return null;
}

// --- Beat classification ------------------------------------------------------
// Fails CLOSED: an unknown seam, a beat with no id, or a read-only beat whose input
// cannot be derived from its own facts is a `fixture_error`, never a silent skip and
// never an optimistic "executable".
function classifyBeat(beat, index) {
  const id = beat && beat.beat;
  const seam = beat && beat.seam;
  const base = { index, id: id || null, seam: seam || null, note: (beat && beat.note) || null };

  if (!id) {
    return { ...base, class: 'fixture_error', reason: 'beat has no id', input: null, evidenceFields: EVIDENCE_FIELDS.fixture_error, expectedBehaviorFields: [] };
  }
  const policy = SEAM_POLICY[seam];
  if (!policy) {
    return { ...base, class: 'fixture_error', reason: `unknown seam ${JSON.stringify(seam)} — no policy; failing closed`, input: null, evidenceFields: EVIDENCE_FIELDS.fixture_error, expectedBehaviorFields: [] };
  }

  if (policy.writeCapable) {
    return {
      ...base,
      class: 'write_blocked',
      surface: policy.surface,
      reason: `${WRITE_BLOCK_REASON[seam] || 'write-capable beat'}; ${WRITE_POSTURE.reason}`,
      blockedPending: WRITE_POSTURE.installedBy,
      input: null,
      evidenceFields: EVIDENCE_FIELDS.write_blocked,
      expectedBehaviorFields: expectedBehaviorFields(beat)
    };
  }

  const input = renderBeatInput(beat);
  if (!input) {
    return { ...base, class: 'fixture_error', reason: `read-only seam ${seam} but no browser input could be derived from the beat's facts`, input: null, evidenceFields: EVIDENCE_FIELDS.fixture_error, expectedBehaviorFields: [] };
  }

  return {
    ...base,
    class: 'executable',
    surface: policy.surface,
    reason: 'read-only: composer + preview (test_mode dry-run) — never Save',
    input,
    evidenceFields: EVIDENCE_FIELDS.executable,
    expectedBehaviorFields: expectedBehaviorFields(beat)
  };
}

// --- The beat plan -------------------------------------------------------------
// The whole fixture, in the fixture's exact order, one plan entry per beat — no beat
// dropped, none added, none reordered. `counts` is a tally, not a filter.
function buildGoldenSessionPlan(fixture = GOLDEN_SESSION) {
  const beats = ((fixture && fixture.beats) || []).map(classifyBeat);
  const counts = beats.reduce((acc, b) => { acc[b.class] = (acc[b.class] || 0) + 1; return acc; }, {});
  return {
    title: (fixture && fixture.title) || 'Golden Session',
    source: 'test/fixtures/goldenSession.js',
    writePosture: WRITE_POSTURE,
    beats,
    counts: {
      total: beats.length,
      executable: counts.executable || 0,
      write_blocked: counts.write_blocked || 0,
      fixture_error: counts.fixture_error || 0
    }
  };
}

// --- Run-time guards -----------------------------------------------------------
// The runner asks this before touching the page. It is the single decision point, and it
// answers `false` for every non-executable class, so a write-capable beat cannot reach a
// browser interaction even if a future caller loops carelessly.
function mayExecuteBeat(planBeat) {
  return Boolean(planBeat) && planBeat.class === 'executable';
}

// Record a settlement failure as its OWN outcome. A beat that ran but never settled is
// not "blocked" and is not a pass — it is an executed beat with an unobserved reply.
function beatSettlementFailure(planBeat, settle) {
  return {
    beat_id: planBeat.id,
    beat_index: planBeat.index,
    seam: planBeat.seam,
    executed: true,
    settled: false,
    settle_reason: (settle && settle.reason) || 'no_settlement_observed'
  };
}

// --- Verdict -------------------------------------------------------------------
// The Golden Session verdict, computed from the beat ledger. The ordering is deliberate:
//
//   ERROR         — the fixture/configuration is unusable. Outranks everything: a broken
//                   plan cannot report on the session it failed to describe.
//   FAIL          — a forbidden (outage-reveal) pattern appeared in an executed beat's
//                   reply. A real bug signal outranks incompleteness.
//   INCONCLUSIVE  — everything else, in this PR ALWAYS. While any beat is blocked, the
//                   canonical sequence was not walked end to end, so replaying only the
//                   non-write subset can never manufacture a PASS. A settlement failure is
//                   likewise INCONCLUSIVE with its own reason.
//   PASS          — reachable only once no beat is blocked and none failed, i.e. only
//                   after PR D installs the write posture AND the full sequence runs.
function goldenSessionVerdict(ledger) {
  const beats = (ledger && ledger.beats) || [];
  if (beats.some(b => b.class === 'fixture_error')) {
    return { verdict: 'ERROR', reason: 'fixture_error' };
  }
  if (beats.some(b => b.forbidden_hit === true)) {
    return { verdict: 'FAIL', reason: 'forbidden_pattern' };
  }
  if (beats.some(b => b.class === 'write_blocked')) {
    return { verdict: 'INCONCLUSIVE', reason: 'write_capable_beats_blocked_pending_write_posture' };
  }
  const unsettled = beats.find(b => b.class === 'executable' && b.settled === false);
  if (unsettled) {
    return { verdict: 'INCONCLUSIVE', reason: `beat_settlement_failed:${unsettled.settle_reason || 'unknown'}` };
  }
  if (!beats.some(b => b.class === 'executable' && b.settled === true)) {
    return { verdict: 'INCONCLUSIVE', reason: 'no_beat_was_observed' };
  }
  return { verdict: 'PASS', reason: 'full_canonical_sequence_walked' };
}

// --- Owner-facing rendering ----------------------------------------------------
// Console lines for the dry-run description. Operational metadata only — beat ids, seams,
// classes, reasons, and the derived composer input, which comes from the fixture and
// contains no production content.
const CLASS_ICON = { executable: '▶', write_blocked: '⛔', fixture_error: '💥' };

function describeGoldenSessionPlan(plan) {
  const lines = [];
  lines.push(`Golden Session   : ${plan.title}`);
  lines.push(`Fixture source   : ${plan.source} (single definition — this adapter holds no second catalogue)`);
  lines.push(`Write posture    : installed=${plan.writePosture.installed} — ${plan.writePosture.reason}`);
  lines.push('');
  lines.push('Beats, in the fixture\'s canonical order:');
  for (const b of plan.beats) {
    const n = String(b.index + 1).padStart(2, ' ');
    lines.push(`  ${n}. ${CLASS_ICON[b.class] || '?'} ${b.class.padEnd(13)} ${b.id}  [${b.seam}]`);
    lines.push(`      ${b.reason}`);
    if (b.input) lines.push(`      composer input: ${JSON.stringify(b.input)}`);
    if (b.expectedBehaviorFields.length) {
      lines.push(`      PR C behavior evidence: ${b.expectedBehaviorFields.join(', ')}`);
    }
    lines.push(`      PR C evidence fields  : ${b.evidenceFields.join(', ')}`);
  }
  lines.push('');
  lines.push(`Totals           : ${plan.counts.total} beats — ${plan.counts.executable} executable now, ${plan.counts.write_blocked} blocked pending ${plan.writePosture.installedBy}, ${plan.counts.fixture_error} fixture errors`);
  lines.push('Best achievable verdict in this PR: INCONCLUSIVE — the canonical sequence cannot be walked end to end while write-capable beats are blocked, so the non-write subset alone can never read PASS.');
  lines.push('Sequence caveat  : plan acceptance is blocked, so the executable beats after it run OUTSIDE an accepted plan. Their behavioral expectations are therefore recorded, NOT scored, in this PR.');
  return lines;
}

// Markdown for the GitHub Actions run summary. Same content, same privacy posture.
function buildGoldenSessionReport(plan, ledger = null) {
  const lines = [];
  lines.push('### 🧭 Golden Session — beat plan');
  lines.push('');
  lines.push(`Fixture: \`${plan.source}\` — the single definition. This adapter derives every beat from it and holds no second catalogue.`);
  lines.push('');
  lines.push('| # | Beat | Seam | Status | Why |');
  lines.push('|---|---|---|---|---|');
  for (const b of plan.beats) {
    const status = b.class === 'executable' ? '▶ executable now'
      : b.class === 'write_blocked' ? `⛔ blocked pending ${plan.writePosture.installedBy}`
        : '💥 fixture error';
    lines.push(`| ${b.index + 1} | \`${b.id}\` | \`${b.seam}\` | ${status} | ${String(b.reason).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push(`**Totals:** ${plan.counts.total} beats — ${plan.counts.executable} executable now · ${plan.counts.write_blocked} blocked pending ${plan.writePosture.installedBy} · ${plan.counts.fixture_error} fixture errors`);
  lines.push('');
  if (ledger && Array.isArray(ledger.beats) && ledger.beats.length) {
    const v = goldenSessionVerdict(ledger);
    lines.push(`**Walk verdict:** ${v.verdict} (${v.reason})`);
    lines.push('');
  }
  lines.push('**Expected evidence fields for PR C** (operational metadata only — no reply text, DOM values, or screenshots, because an authenticated run renders the owner\'s private surface on a public repository):');
  lines.push('');
  lines.push(`- executable beat: \`${EVIDENCE_FIELDS.executable.join('`, `')}\``);
  lines.push(`- blocked beat: \`${EVIDENCE_FIELDS.write_blocked.join('`, `')}\``);
  lines.push(`- fixture error: \`${EVIDENCE_FIELDS.fixture_error.join('`, `')}\``);
  lines.push('- per-beat behavioral facts from the fixture\'s own `expect`: `note_tier`, `note_trigger`, `kind`');
  lines.push('');
  lines.push(`> No production write is possible in this PR. Write-capable beats are blocked deterministically — the runner has no executor for them. ${plan.writePosture.installedBy} installs the owner-authorized posture; Approve, Save, Closeout, and Seal are never pressed here.`);
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  SCENARIO_KEY, WRITE_POSTURE, SEAM_POLICY, WRITE_BLOCK_REASON, EVIDENCE_FIELDS,
  renderSet, renderBeatInput, classifyBeat, buildGoldenSessionPlan,
  mayExecuteBeat, beatSettlementFailure, goldenSessionVerdict,
  describeGoldenSessionPlan, buildGoldenSessionReport
};
