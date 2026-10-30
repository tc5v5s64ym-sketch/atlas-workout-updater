'use strict';

// Persona lane pins (Slice 2a, persona test rig — issue #1607). Proves the
// persona lane's safety-critical property: a persona run is STRUCTURALLY
// incapable of touching the canonical F-SB4 rehearsal count. Every rule that
// claim rests on is bitten here, in the pure modules where the decisions live:
//   - purpose resolution refuses a persona run combined with a counting flag;
//   - the persona preflight never consults the count (absent, garbage, or
//     impossible counts refuse nothing) yet refuses a dirty/off-branch/stale
//     tree exactly as a debug run does;
//   - persona and rehearsal identity families refuse each other in both
//     directions, so no artifact from one lane can satisfy the other;
//   - eligibility fails closed for PERSONA_RUN at the predicate AND at the
//     scorecard, so no persona artifact can publish rehearsal_eligible=true;
//   - parseCanonicalRehearsalCount reads the plan's CAMPAIGN STATE field and
//     nothing else — persona artifacts on disk cannot move it.
// Plus the fixture format: the loader validates Marcus (the format proof) and
// refuses unknown/traversal slugs and malformed fixtures.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  REHEARSAL_SESSION, REHEARSAL_DEBUG, PERSONA_RUN, QUALIFYING_PURPOSE,
  isQualifyingPurpose, RUN_PURPOSES, normalizePurpose, isPersonaSlug,
  resolveRunPurpose, mintPersonaIdentities, personaRunIdentityRefusal,
  runIdentityRefusal, workoutIdentityRefusal, parseCanonicalRehearsalCount,
  evaluateRehearsalPreflight,
} = require('../tests/e2e/gate/rehearsal-run-purpose');
const { scoreRehearsalRun, renderMarkdown } = require('../tests/e2e/gate/rehearsal-scorecard');
const { loadPersonaFixture, personaFixtureProblems } = require('../tests/e2e/gate/personas/load-persona');

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
function personaPreflightInput(over) {
  return {
    purpose: PERSONA_RUN,
    personaSlug: 'marcus',
    mode: 'model-up',
    runId: 'persona-marcus-20261029T120000-AB12CD',
    git: { branch: 's3-maintenance', head: HEAD, originHead: HEAD, clean: true },
    originRefreshed: true,
    // NO priorRehearsalCount — the runner never hands one to a persona decision.
    env: {
      childCarriesWorkbookId: false,
      childCarriesWorkoutSessionId: false,
      rehearsalPostureDeclared: true,
      declaredWorkbookIsSandbox: true,
      nodeEnvProduction: false,
      hasServiceAccountEmail: true,
      hasPrivateKey: true,
      hasProviderKey: true,
    },
    ...over,
  };
}

describe('resolveRunPurpose — exactly one purpose, persona never counts', () => {
  it('resolves each single flag to its purpose', () => {
    assert.deepEqual(resolveRunPurpose({ wantsQualifying: true }), { ok: true, purpose: REHEARSAL_SESSION });
    assert.deepEqual(resolveRunPurpose({ wantsDebug: true }), { ok: true, purpose: REHEARSAL_DEBUG });
    assert.deepEqual(resolveRunPurpose({ personaSlug: 'marcus' }), { ok: true, purpose: PERSONA_RUN });
  });

  it('REFUSES a persona run combined with --qualifying (the negative pin)', () => {
    const r = resolveRunPurpose({ personaSlug: 'marcus', wantsQualifying: true });
    assert.equal(r.ok, false);
    assert.match(r.refusal, /mutually exclusive/);
    assert.match(r.refusal, /never advance the rehearsal streak/);
  });

  it('refuses persona combined with --debug, and qualifying combined with debug', () => {
    assert.equal(resolveRunPurpose({ personaSlug: 'marcus', wantsDebug: true }).ok, false);
    assert.equal(resolveRunPurpose({ wantsQualifying: true, wantsDebug: true }).ok, false);
  });

  it('refuses no purpose at all — there is no default', () => {
    assert.equal(resolveRunPurpose({}).ok, false);
    assert.equal(resolveRunPurpose().ok, false);
  });

  it('refuses a malformed or path-shaped persona slug', () => {
    for (const bad of ['../marcus', 'Marcus', 'marcus.js', 'a/b', '', '  ']) {
      const r = resolveRunPurpose({ personaSlug: bad });
      if (bad.trim() === '') { assert.equal(r.ok, false, 'empty slug must not resolve'); continue; }
      assert.equal(r.ok, false, `slug ${JSON.stringify(bad)} must refuse`);
      assert.match(r.refusal, /not a valid persona slug/);
    }
  });
});

describe('persona identity family — disjoint from the rehearsal family in both directions', () => {
  it('mints persona-shaped correlation ids and never a workout id', () => {
    const ids = mintPersonaIdentities({ slug: 'marcus', stamp: '20261029T120000', nonce: 'AB12CD' });
    assert.equal(ids.run_id, 'persona-marcus-20261029T120000-AB12CD');
    assert.equal(ids.athlete_id, 'persona-athlete-AB12CD');
    assert.deepEqual(Object.keys(ids).sort(), ['athlete_id', 'run_id']);
  });

  it('refuses bad slugs and missing stamp/nonce', () => {
    assert.throws(() => mintPersonaIdentities({ slug: '../x', stamp: 's', nonce: 'n' }), /persona slug/);
    assert.throws(() => mintPersonaIdentities({ slug: 'marcus', nonce: 'n' }), /stamp and a nonce/);
  });

  it('a persona run id can NEVER satisfy a rehearsal session identity check', () => {
    const personaRunId = 'persona-marcus-20261029T120000-AB12CD';
    for (let n = 1; n <= 5; n += 1) {
      assert.match(runIdentityRefusal({ sessionNumber: n, runId: personaRunId }), /does not carry the rehearsal/);
    }
  });

  it('a rehearsal run id can NEVER satisfy a persona identity check', () => {
    assert.match(personaRunIdentityRefusal({ slug: 'marcus', runId: 'fsb4b-s1-20261029T120000-AB12CD' }), /does not carry the persona marker/);
    assert.match(personaRunIdentityRefusal({ slug: 'marcus', runId: 'persona-priya-20261029T120000-AB12CD' }), /does not carry the persona marker/);
    assert.equal(personaRunIdentityRefusal({ slug: 'marcus', runId: 'persona-marcus-20261029T120000-AB12CD' }), null);
  });

  it('the workout-identity rule is unchanged: a persona run id is not a server allocation', () => {
    assert.match(workoutIdentityRefusal({ workoutSessionId: 'persona-marcus-20261029T120000-AB12CD' }), /not server-allocator-shaped/);
    assert.equal(workoutIdentityRefusal({ workoutSessionId: '20261029-AM-01' }), null);
  });
});

describe('evaluateRehearsalPreflight — the persona branch', () => {
  it('passes a clean persona baseline with NO count handed to the decision', () => {
    const r = evaluateRehearsalPreflight(personaPreflightInput());
    assert.deepEqual(r, { ok: true, refusals: [] });
  });

  it('never consults the count: absent, garbage, or impossible counts refuse nothing', () => {
    for (const prior of [undefined, null, 'garbage', -1, 0, 3, 5, 99]) {
      const r = evaluateRehearsalPreflight(personaPreflightInput({
        priorRehearsalCount: prior, priorCountReason: 'conflicting counts',
      }));
      assert.equal(r.ok, true, `prior=${JSON.stringify(prior)} must not refuse a persona run; got ${JSON.stringify(r.refusals)}`);
      assert.ok(!r.refusals.some((x) => /canonical count/.test(x)));
    }
  });

  it('refuses a persona run that smuggles in a rehearsal session number', () => {
    const r = evaluateRehearsalPreflight(personaPreflightInput({ sessionNumber: 3 }));
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => /no rehearsal session number/.test(x)));
  });

  it('refuses a dirty, off-branch, or stale tree EXACTLY as a debug run does', () => {
    for (const [label, patch] of [
      ['off-branch', { git: { branch: 'feature/x', head: HEAD, originHead: HEAD, clean: true } }],
      ['dirty worktree', { git: { branch: 's3-maintenance', head: HEAD, originHead: HEAD, clean: false } }],
      ['stale head', { git: { branch: 's3-maintenance', head: HEAD, originHead: 'b'.repeat(40), clean: true } }],
      ['origin not refreshed', { originRefreshed: false }],
      ['model-down', { mode: 'model-down' }],
      ['pre-seeded workout id', { env: { ...personaPreflightInput().env, childCarriesWorkoutSessionId: true } }],
    ]) {
      const persona = evaluateRehearsalPreflight(personaPreflightInput(patch));
      assert.equal(persona.ok, false, `a persona run must refuse on ${label}`);
      const debug = evaluateRehearsalPreflight({
        ...personaPreflightInput(patch),
        purpose: REHEARSAL_DEBUG, sessionNumber: 2,
        runId: 'fsb4b-s2-20261029T120000-AB12CD',
      });
      assert.equal(debug.ok, false, `the debug comparison run must also refuse on ${label}`);
      // Same tree refusals, verbatim — the persona purpose relaxes nothing but the count.
      const treeRefusals = (r) => r.refusals.filter((x) => /s3-maintenance|clean worktree|stale|model-up only|pre-seeded/.test(x)).sort();
      assert.deepEqual(treeRefusals(persona), treeRefusals(debug), `persona and debug must refuse ${label} identically`);
    }
  });

  it('refuses a persona run carrying a rehearsal or foreign run id', () => {
    const r = evaluateRehearsalPreflight(personaPreflightInput({ runId: 'fsb4b-s1-20261029T120000-AB12CD' }));
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => /persona marker/.test(x)));
  });
});

describe('eligibility fails closed for PERSONA_RUN', () => {
  it('the predicate: only REHEARSAL_SESSION qualifies', () => {
    assert.equal(QUALIFYING_PURPOSE, REHEARSAL_SESSION);
    assert.equal(isQualifyingPurpose(PERSONA_RUN), false);
    assert.equal(isQualifyingPurpose('persona_run'), false);
    assert.deepEqual([...RUN_PURPOSES].sort(), [PERSONA_RUN, REHEARSAL_DEBUG, REHEARSAL_SESSION].sort());
    assert.equal(normalizePurpose('PERSONA_RUN'), PERSONA_RUN);
    assert.equal(normalizePurpose('PERSONA'), null);
  });

  it('the scorecard: a persona-purpose observation set is ineligible, whatever else it claims', () => {
    const card = scoreRehearsalRun({ run_purpose: PERSONA_RUN, session_number: undefined });
    assert.equal(card.purpose, PERSONA_RUN);
    assert.equal(card.qualifying, false);
    assert.equal(card.rehearsal_eligible, false);
  });

  it('persona artifacts on disk cannot move the canonical count', () => {
    // The count derives ONLY from the plan's CAMPAIGN STATE field. Write a
    // full persona-evidence artifact (the shape persona.spec.js publishes)
    // into a scratch dir and prove the parse of the REAL plan is unmoved —
    // the machinery has no path from persona artifacts to the count.
    const planPath = path.join(__dirname, '..', 'docs', 'ATLAS_V1_EXECUTION_PLAN.md');
    const planText = fs.readFileSync(planPath, 'utf8');
    const before = parseCanonicalRehearsalCount(planText);
    assert.equal(before.ok, true, 'the live plan must carry a readable canonical count for this pin to mean anything');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-artifacts-'));
    try {
      fs.writeFileSync(path.join(dir, 'persona-evidence.json'), JSON.stringify({
        kind: 'PERSONA_SMOKE', ok: true, purpose: PERSONA_RUN,
        rehearsal_eligible: isQualifyingPurpose(PERSONA_RUN), run_id: 'persona-marcus-x-Y',
      }));
      const after = parseCanonicalRehearsalCount(fs.readFileSync(planPath, 'utf8'));
      assert.deepEqual(after, before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a plan text whose CAMPAIGN STATE field is untouched by persona wording still parses once', () => {
    // Persona vocabulary in a plan line must not mint a second marker: only
    // the `Rehearsal (F-SB4): <k>/5` shape on a CAMPAIGN STATE line counts.
    const text = 'CAMPAIGN STATE: Rehearsal (F-SB4) 2/5 — persona runs (PERSONA_RUN) never count toward this streak.';
    const r = parseCanonicalRehearsalCount(text);
    assert.deepEqual(r, { ok: true, count: 2, reason: null, occurrences: 1 });
  });
});

describe('persona fixture format — the loader and the Marcus format proof', () => {
  it('isPersonaSlug accepts names and refuses paths', () => {
    assert.equal(isPersonaSlug('marcus'), true);
    assert.equal(isPersonaSlug('mary-jane2'), true);
    for (const bad of ['../marcus', 'Marcus', 'marcus.js', 'a/b', '', 42, null]) {
      assert.equal(isPersonaSlug(bad), false, JSON.stringify(bad));
    }
  });

  it('loads Marcus: card, plan, history, beats, declarations all present and self-consistent', () => {
    const m = loadPersonaFixture('marcus');
    assert.equal(m.slug, 'marcus');
    assert.match(m.sourceRef, /Soul Corpus Session 6/);
    assert.equal(m.card.loggingStyle, 'precise, immediate, occasionally fat-fingers a number');
    assert.equal(m.historyMode, 'alongside');
    assert.deepEqual(m.plan.map((r) => r.lift_code), ['SQ01', 'BEN01', 'RDL01']);
    // History plausibility the design demands (§4.4): the 315 top triple and
    // TWO prior 275 RDL sessions the script's correction end-state relies on.
    const squatTop = m.historyRows.filter((r) => r[5] === 'SQ01' && r[7] === '315');
    assert.equal(squatTop.length, 1);
    assert.deepEqual(squatTop[0].slice(6, 10), ['1', '315', '3', '3']);
    const rdlSessions = new Set(m.historyRows.filter((r) => r[5] === 'RDL01' && r[7] === '275').map((r) => r[1]));
    assert.equal(rdlSessions.size, 2);
    assert.equal(m.catalogRows.length, 0, 'Marcus declares no catalog additions — all his lifts are in the shared catalog');
    assert.ok(m.beats.some((b) => b.id === 'rdl-correction' && b.kind === 'correction'));
    assert.equal(m.facts.correctionEndStates[0].weight, 275);
    assert.equal(m.facts.correctionEndStates[0].forbiddenWeight, 285);
    assert.ok(m.reviewChecklist.length >= 3);
    assert.deepEqual(personaFixtureProblems(m, 'marcus'), []);
  });

  it('refuses unknown slugs and traversal', () => {
    assert.throws(() => loadPersonaFixture('nobody'), /no persona fixture named "nobody"/);
    assert.throws(() => loadPersonaFixture('../marcus'), /not a valid persona slug/);
    assert.throws(() => loadPersonaFixture('gate-server'), /no persona fixture named "gate-server"/);
  });

  it('the shape validator bites: missing fields, bad history ids, slug disagreement', () => {
    const m = loadPersonaFixture('marcus');
    const noCard = { ...m, card: { ...m.card, loggingStyle: '' } };
    assert.ok(personaFixtureProblems(noCard, 'marcus').some((p) => /loggingStyle/.test(p)));
    const badHistory = { ...m, historyRows: m.historyRows.map((r, i) => (i === 0 ? [...r.slice(0, 1), '20261029-AM-01', ...r.slice(2)] : r)) };
    assert.ok(personaFixtureProblems(badHistory, 'marcus').some((p) => /PERS-/.test(p)),
      'a server-shaped session id in persona history must be a shape violation');
    assert.ok(personaFixtureProblems(m, 'priya').some((p) => /loaded as "priya"/.test(p)));
    const noBeats = { ...m, beats: [] };
    assert.ok(personaFixtureProblems(noBeats, 'marcus').some((p) => /beats is empty/.test(p)));
  });
});

describe('the gate-server seam is wired to the loader (source pin)', () => {
  it('gate-server.js arms the seam from ATLAS_GATE_PERSONA through loadPersonaFixture, default off', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'gate-server.js'), 'utf8');
    assert.match(src, /ATLAS_GATE_PERSONA/);
    assert.match(src, /loadPersonaFixture\(PERSONA_SLUG\)/);
    assert.match(src, /servedLogRows/);
    // The seam must reach BOTH postures: the stub's served rows and the
    // guarded adapter's wrapped reads.
    assert.match(src, /PERSONA_HISTORY_MODE === 'replace'/);
  });

  it('the runner refuses --persona with --qualifying through resolveRunPurpose (source pin)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'atlas-rehearsal-session.js'), 'utf8');
    assert.match(src, /resolveRunPurpose\(\{ wantsQualifying, wantsDebug, personaSlug: PERSONA_SLUG \}\)/);
    assert.match(src, /persona\.spec\.js/);
  });
});

describe('the scorecard\'s PERSONA_RUN branches (Slice 2b) — additive, rehearsal paths untouched', () => {
  // A persona observation set with ONLY the identity/source branches filled:
  // the other 23 conditions ERROR on missing evidence, which is fine — these
  // cases judge conditions 1 and 2, the two that embed rehearsal assumptions.
  function personaObs(over = {}) {
    return {
      run_purpose: PERSONA_RUN,
      persona_slug: 'marcus',
      run_id: 'persona-marcus-20261029T120000-AB12CD',
      athlete_id: 'persona-athlete-AB12CD',
      workout_session_id: '20261029-AM-01',
      workout_id_preseeded: false,
      session_number: undefined,
      source: { branch: 's3-maintenance', clean: true, head_sha: HEAD, origin_head_sha: HEAD, prior_rehearsal_count: 5, prior_count_reason: null },
      ...over,
    };
  }
  const condition = (card, id) => card.conditions.find((c) => c.id === id);

  it('source_tree_verified passes a persona run on the exact tree with NO session number', () => {
    const card = scoreRehearsalRun(personaObs());
    const c = condition(card, 'source_tree_verified');
    assert.equal(c.status, 'PASS', c.detail);
    assert.match(c.detail, /PERSONA run \(marcus\) ran at canonical count 5\/5 — recorded, never ordered against it/);
  });

  it('source_tree_verified still refuses a persona run on a dirty or off-branch tree', () => {
    const dirty = scoreRehearsalRun(personaObs({ source: { branch: 's3-maintenance', clean: false, head_sha: HEAD, origin_head_sha: HEAD, prior_rehearsal_count: 5 } }));
    assert.equal(condition(dirty, 'source_tree_verified').status, 'ERROR');
    assert.match(condition(dirty, 'source_tree_verified').detail, /not clean/);
    const offBranch = scoreRehearsalRun(personaObs({ source: { branch: 'agent/x', clean: true, head_sha: HEAD, origin_head_sha: HEAD, prior_rehearsal_count: 5 } }));
    assert.equal(condition(offBranch, 'source_tree_verified').status, 'ERROR');
    const noCount = scoreRehearsalRun(personaObs({ source: { branch: 's3-maintenance', clean: true, head_sha: HEAD, origin_head_sha: HEAD, prior_rehearsal_count: null, prior_count_reason: 'no marker' } }));
    assert.equal(condition(noCount, 'source_tree_verified').status, 'ERROR',
      'a persona run must still RECORD the count it ran at — unreadable count is an ERROR, not a pass');
  });

  it('fresh_identities passes a persona run id and refuses a rehearsal run id', () => {
    const card = scoreRehearsalRun(personaObs());
    assert.equal(condition(card, 'fresh_identities').status, 'PASS', condition(card, 'fresh_identities').detail);
    const foreign = scoreRehearsalRun(personaObs({ run_id: 'fsb4b-s1-20261029T120000-AB12CD' }));
    assert.equal(condition(foreign, 'fresh_identities').status, 'ERROR');
    assert.match(condition(foreign, 'fresh_identities').detail, /persona marker/);
    const noSlug = scoreRehearsalRun(personaObs({ persona_slug: undefined }));
    assert.equal(condition(noSlug, 'fresh_identities').status, 'ERROR',
      'a persona run that cannot name its persona cannot prove its identity family');
  });

  it('a persona card is never eligible, carries the persona note, and renders a persona banner', () => {
    const card = scoreRehearsalRun(personaObs());
    assert.equal(card.rehearsal_eligible, false);
    assert.equal(card.persona_slug, 'marcus');
    assert.match(card.rehearsal_note, /^PERSONA RUN — persona scenario evidence only/);
    assert.match(renderMarkdown(card).split('\n')[0], /^# Persona rehearsal \(NON-COUNTING\) — marcus — /);
  });

  it('the rehearsal branches are unchanged: debug passes at any count, qualifying still ordered', () => {
    const base = personaObs({ run_purpose: REHEARSAL_DEBUG, session_number: 2, run_id: 'fsb4b-s2-20261029T120000-AB12CD' });
    const debug = scoreRehearsalRun(base);
    assert.equal(condition(debug, 'source_tree_verified').status, 'PASS');
    assert.match(condition(debug, 'source_tree_verified').detail, /DIAGNOSTIC \(REHEARSAL_DEBUG\) session 2 ran at canonical count 5\/5/);
    const qualifying = scoreRehearsalRun({ ...base, run_purpose: REHEARSAL_SESSION });
    assert.equal(condition(qualifying, 'source_tree_verified').status, 'FAIL',
      'session 2 at prior count 5 is still illegal for a qualifying run');
    const noNumber = scoreRehearsalRun({ ...base, session_number: undefined });
    assert.equal(condition(noNumber, 'source_tree_verified').status, 'ERROR',
      'a rehearsal-purpose run without a session number still ERRORs — only PERSONA_RUN skips the question');
  });
});
