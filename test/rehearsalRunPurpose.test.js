'use strict';

// F-SB4B run-purpose bites (TEMPORARY; sunset: F-SB4C). Proves the eligibility
// rules in tests/e2e/gate/rehearsal-run-purpose.js actually refuse what they
// claim to refuse — most importantly the INVERTED identity rule: a workout
// session id carrying the runner's own family marker is mechanical proof of
// pre-seeding and must refuse, while only a server-allocator-shaped id passes.
// A rule that cannot bite here would let a non-qualifying run count toward the
// rehearsal streak.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  REHEARSAL_SESSION, REHEARSAL_STREAK_LENGTH, SERVER_SESSION_ID_RE,
  normalizePurpose, isRehearsalSessionNumber, mintIdentities,
  workoutIdentityRefusal, runIdentityRefusal,
  parseCanonicalRehearsalCount, evaluateRehearsalPreflight,
} = require('../tests/e2e/gate/rehearsal-run-purpose');

describe('mintIdentities — correlation family only, never a workout id', () => {
  it('mints run and athlete ids carrying the session marker', () => {
    const ids = mintIdentities({ sessionNumber: 3, stamp: '20260803T120000', nonce: 'AB12CD' });
    assert.match(ids.run_id, /^fsb4b-s3-20260803T120000-AB12CD$/);
    assert.equal(ids.athlete_id, 'fsb4b-athlete-AB12CD');
  });

  it('never mints a workout session id — the server allocator owns that identity', () => {
    const ids = mintIdentities({ sessionNumber: 1, stamp: 's', nonce: 'n' });
    assert.deepEqual(Object.keys(ids).sort(), ['athlete_id', 'run_id']);
    for (const v of Object.values(ids)) {
      assert.equal(SERVER_SESSION_ID_RE.test(v), false, `minted id "${v}" must never look server-allocated`);
    }
  });

  it('refuses session numbers outside 1..5 and non-integers', () => {
    for (const bad of [0, 6, 1.5, NaN, '1', undefined]) {
      assert.throws(() => mintIdentities({ sessionNumber: bad, stamp: 's', nonce: 'n' }), /1\.\.5/);
    }
  });

  it('refuses a missing stamp or nonce', () => {
    assert.throws(() => mintIdentities({ sessionNumber: 1, nonce: 'n' }), /stamp and a nonce/);
    assert.throws(() => mintIdentities({ sessionNumber: 1, stamp: 's' }), /stamp and a nonce/);
  });
});

describe('workoutIdentityRefusal — the INVERTED identity rule (isolation rule 3)', () => {
  it('accepts a server-allocator-shaped id', () => {
    assert.equal(workoutIdentityRefusal({ workoutSessionId: '20260803-AM-01' }), null);
    assert.equal(workoutIdentityRefusal({ workoutSessionId: '20260803-pm-02' }), null);
  });

  it('refuses an empty or missing capture — acceptance must have allocated one', () => {
    assert.match(workoutIdentityRefusal({ workoutSessionId: '' }), /no server-allocated/);
    assert.match(workoutIdentityRefusal({}), /no server-allocated/);
    assert.match(workoutIdentityRefusal({ workoutSessionId: '   ' }), /no server-allocated/);
  });

  it('refuses ANY runner-family marker as mechanical proof of pre-seeding', () => {
    for (const preseeded of ['fsb4b-s1-x-Y', 'FSB4B-20260803-AM-01', 'stagea-s2-x', 'CANARY-01']) {
      const refusal = workoutIdentityRefusal({ workoutSessionId: preseeded });
      assert.match(refusal, /pre-seeded identity bypasses the server allocator/i, preseeded);
    }
  });

  it('refuses a non-server-shaped id even without a family marker', () => {
    for (const bad of ['workout-1', '2026-08-03-AM-01', '20260803-XX-01', '20260803-AM-1']) {
      assert.match(workoutIdentityRefusal({ workoutSessionId: bad }), /not server-allocator-shaped/, bad);
    }
  });
});

describe('runIdentityRefusal — a prior rehearsal can never satisfy this session', () => {
  it('accepts a run id carrying this session\'s marker', () => {
    assert.equal(runIdentityRefusal({ sessionNumber: 2, runId: 'fsb4b-s2-20260803T000000-AA11BB' }), null);
  });

  it('refuses another session\'s marker and unmarked ids', () => {
    assert.match(runIdentityRefusal({ sessionNumber: 2, runId: 'fsb4b-s1-x-Y' }), /session-2 marker/);
    assert.match(runIdentityRefusal({ sessionNumber: 1, runId: 'stage-a-s1-x' }), /session-1 marker/);
    assert.match(runIdentityRefusal({ sessionNumber: 1, runId: '' }), /session-1 marker/);
  });

  it('refuses an illegal session number before looking at the id', () => {
    assert.match(runIdentityRefusal({ sessionNumber: 0, runId: 'fsb4b-s0-x-Y' }), /1\.\.5/);
  });
});

describe('parseCanonicalRehearsalCount — fail-closed', () => {
  it('parses agreeing digit occurrences', () => {
    const r = parseCanonicalRehearsalCount('a\nRehearsal (F-SB4): 2/5 …\nRehearsal (F-SB4): 2 / 5\n');
    assert.deepEqual({ ok: r.ok, count: r.count, occurrences: r.occurrences }, { ok: true, count: 2, occurrences: 2 });
  });

  it('never matches the template occurrence `<k>/5`', () => {
    const r = parseCanonicalRehearsalCount('Rehearsal (F-SB4): <k>/5');
    assert.equal(r.ok, false);
    assert.match(r.reason, /states no/);
  });

  it('fails closed on an unreadable document, absence, disagreement, and impossible counts', () => {
    assert.equal(parseCanonicalRehearsalCount('').ok, false);
    assert.equal(parseCanonicalRehearsalCount(null).ok, false);
    assert.equal(parseCanonicalRehearsalCount('no count here').ok, false);
    const conflict = parseCanonicalRehearsalCount('Rehearsal (F-SB4): 1/5\nRehearsal (F-SB4): 2/5');
    assert.equal(conflict.ok, false);
    assert.match(conflict.reason, /conflicting/);
    const impossible = parseCanonicalRehearsalCount('Rehearsal (F-SB4): 9/5');
    assert.equal(impossible.ok, false);
    assert.match(impossible.reason, /impossible/);
  });

  it('agrees with the REAL execution plan right now (0..5, unambiguous)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const plan = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ATLAS_V1_EXECUTION_PLAN.md'), 'utf8');
    const r = parseCanonicalRehearsalCount(plan);
    assert.equal(r.ok, true, r.reason || '');
    assert.ok(Number.isInteger(r.count) && r.count >= 0 && r.count <= REHEARSAL_STREAK_LENGTH);
  });
});

// A baseline that passes every preflight rule; each bite flips exactly one fact.
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
function goodPreflightInput(over) {
  return {
    purpose: REHEARSAL_SESSION,
    sessionNumber: 1,
    mode: 'model-up',
    runId: 'fsb4b-s1-20260803T000000-AA11BB',
    git: { branch: 'main', head: HEAD, originHead: HEAD, clean: true },
    originRefreshed: true,
    priorRehearsalCount: 0,
    priorCountReason: null,
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

describe('evaluateRehearsalPreflight — every rule bites', () => {
  it('passes the fully-qualifying baseline with zero refusals', () => {
    const r = evaluateRehearsalPreflight(goodPreflightInput());
    assert.deepEqual(r, { ok: true, refusals: [] });
  });

  it('refuses anything but model-up (no downgrade path)', () => {
    const r = evaluateRehearsalPreflight(goodPreflightInput({ mode: 'model-down' }));
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => /model-up only/.test(x)));
  });

  it('refuses session N at any canonical count other than N-1', () => {
    const skip = evaluateRehearsalPreflight(goodPreflightInput({ sessionNumber: 3 }));
    assert.ok(skip.refusals.some((x) => /session 3 requires the canonical count to be 2\/5/.test(x)));
    const repeat = evaluateRehearsalPreflight(goodPreflightInput({ priorRehearsalCount: 1 }));
    assert.ok(repeat.refusals.some((x) => /session 1 requires the canonical count to be 0\/5/.test(x)));
  });

  it('refuses an unreadable canonical count outright', () => {
    const r = evaluateRehearsalPreflight(goodPreflightInput({ priorRehearsalCount: null, priorCountReason: 'conflicting counts' }));
    assert.ok(r.refusals.some((x) => /unreadable \(conflicting counts\)/.test(x)));
  });

  it('refuses a stale, dirty, or off-main source tree', () => {
    const other = HEAD.replace(/^a/, 'b');
    for (const [over, re] of [
      [{ git: { branch: 'claude/x', head: HEAD, originHead: HEAD, clean: true } }, /must execute on main/],
      [{ git: { branch: 'main', head: HEAD, originHead: HEAD, clean: false } }, /clean worktree/],
      [{ git: { branch: 'main', head: HEAD, originHead: other, clean: true } }, /does not equal origin\/main/],
      [{ originRefreshed: false }, /may be stale/],
    ]) {
      const r = evaluateRehearsalPreflight(goodPreflightInput(over));
      assert.equal(r.ok, false);
      assert.ok(r.refusals.some((x) => re.test(x)), re.toString());
    }
  });

  it('refuses a pre-seeded workout session id in the child environment (isolation rule 3)', () => {
    const input = goodPreflightInput();
    input.env.childCarriesWorkoutSessionId = true;
    const r = evaluateRehearsalPreflight(input);
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => /pre-seeded workout session id/.test(x)));
  });

  it('refuses an inherited workbook id and missing credentials/provider key', () => {
    for (const [key, re] of [
      ['childCarriesWorkbookId', /GOOGLE_SHEETS_ID/],
      ['hasServiceAccountEmail', /GOOGLE_SERVICE_ACCOUNT_EMAIL/],
      ['hasPrivateKey', /GOOGLE_PRIVATE_KEY/],
      ['hasProviderKey', /GEMINI_API_KEY/],
    ]) {
      const input = goodPreflightInput();
      input.env[key] = key === 'childCarriesWorkbookId';
      const r = evaluateRehearsalPreflight(input);
      assert.equal(r.ok, false, key);
      assert.ok(r.refusals.some((x) => re.test(x)), key);
    }
  });

  it('refuses a run id from another session — stale artifacts cannot qualify', () => {
    const r = evaluateRehearsalPreflight(goodPreflightInput({ runId: 'fsb4b-s2-x-Y' }));
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => /session-1 marker/.test(x)));
  });

  it('collects refusals instead of short-circuiting, and offers no override', () => {
    const r = evaluateRehearsalPreflight({});
    assert.equal(r.ok, false);
    assert.ok(r.refusals.length >= 5, `expected many refusals on an empty input, got ${r.refusals.length}`);
  });
});

describe('purpose and session-number primitives', () => {
  it('normalizePurpose accepts only the one rehearsal purpose', () => {
    assert.equal(normalizePurpose(' rehearsal_session '), REHEARSAL_SESSION);
    assert.equal(normalizePurpose('STAGE_A_CANARY'), null);
    assert.equal(normalizePurpose(undefined), null);
  });

  it('isRehearsalSessionNumber bounds to 1..5 integers', () => {
    assert.equal(isRehearsalSessionNumber(1), true);
    assert.equal(isRehearsalSessionNumber(5), true);
    for (const bad of [0, 6, 2.5, '3', null]) assert.equal(isRehearsalSessionNumber(bad), false);
  });
});
