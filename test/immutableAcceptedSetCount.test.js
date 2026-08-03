'use strict';

// ── Immutable v1 accepted-set-count (Codex P1 on PR #1248, fix 2026-08-03) ───────
//
// The defect chain, confirmed link-by-link: `applySessionSubstitution` overwrites
// `slot.sets` with a replacement prescription's own (larger) set count;
// `effectivePrescription` read that mutable value as `acceptedSetCount`; an approved
// post-log set revision then carried it into `buildFutureRevisions`, which emitted a
// v2 revision for a set with NO v1 predecessor (`nextRevisionVersion` never checks
// the durable ledger); `sealCloseout` → `validateChain` fails `non_contiguous_version`
// → `malformed_chain`, nothing stamped — permanently, since every retry recomputes
// the same chain. The verified seal became unreachable for that workout.
//
// The fix: `accepted_set_count` is stamped ONCE at acceptance (the same value the
// accepted checkpoint projects into target_set_count) and never overwritten; every
// revision path reads the immutable grain, with `slot.sets` remaining the display
// grain. Presence beats truthiness: a stamped NULL means the accepted item has no v1
// rows, so nothing may ever be bounded there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The live-write flag must be set BEFORE the store module loads (read at require
// time). Sheets is require.cache-stubbed in-memory below — nothing real is reachable
// from this process; this is the same seam every ledger unit test uses.
process.env.SESSION_PLAN_SETS_WRITE_ENABLED = '1';

const tab = { rows: [] };
const fakeSheets = {
  appendRows: async (tabName, rows) => {
    if (tabName === 'Session_Plan_Sets') for (const r of rows) tab.rows.push([...r]);
    return { data: { updates: { updatedRows: rows.length } } };
  },
  readRange: async (range) => {
    const { sessionPlanSetsColumns } = require('../config/columns');
    if (String(range || '').startsWith('Session_Plan_Sets!A1:A1')) return [[sessionPlanSetsColumns[0]]];
    if (String(range || '').startsWith('Session_Plan_Sets!')) return [[...sessionPlanSetsColumns]];
    return [];
  },
  getSheetRows: async (tabName) => (tabName === 'Session_Plan_Sets' ? tab.rows.map(r => [...r]) : []),
  getSpreadsheetTabs: async () => ['Session_Plan_Sets'],
  updateColumnCells: async (tabName, columnLetter, cells) => {
    const colIdx = columnLetter.charCodeAt(0) - 65;
    for (const c of cells) { if (tab.rows[c.row - 2]) tab.rows[c.row - 2][colIdx] = c.value; }
    return { data: { totalUpdatedCells: cells.length } };
  },
  getHeaderRow: async () => [],
};
const sheetsPath = require.resolve('../sheets');
require.cache[sheetsPath] = { id: sheetsPath, filename: sheetsPath, loaded: true, exports: fakeSheets };

const store = require('../services/sessionPlanSetsStore');

let planAcceptance, effective, ledger;
test.before(async () => {
  planAcceptance = await import('../src/app/planAcceptance.js');
  effective = await import('../src/app/effectivePrescription.js');
  ledger = await import('../src/app/sessionLedger.js');
});

test.beforeEach(() => { tab.rows.length = 0; });

const SESSION = { session_id: '20260803-PM-01', session_date: '2026-08-03', plan_version: 'pv_11111111-1111-4111-8111-111111111111' };
const PI = 'pi_aaaaaaaa-1111-4111-8111-111111111111';

function fakeCrypto() {
  let n = 0;
  return { randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
}

// ── 1. acceptance stamps the immutable grain ─────────────────────────────────────

test('runAcceptance stamps accepted_set_count per slot — the ledger grain, present even when null', async () => {
  const stored = [];
  const rec = {
    label: 'Push', id: 'p1',
    exercises: [
      { name: 'Bench Press', liftCode: 'BEN01', sets: 2, weight: 225, reps: 5, rir: 2 },
      { name: 'Face Pull', liftCode: 'FPL01' }, // no set count → NO ledger rows → stamped null
    ],
  };
  await planAcceptance.runAcceptance(rec, {
    crypto: fakeCrypto(), guard: {}, sessionId: '20260803-PM-01', sessionDate: '2026-08-03',
    setActivePlan: (p) => stored.push(p), persist: () => {}, startWorkout: () => {},
    postAccept: async () => ({ data: { session_plans: { captured: true, status: 'written' } } }),
    postLedgerCheckpoint: async () => ({}),
  });
  const exs = stored[0].exercises;
  assert.equal(exs[0].accepted_set_count, 2, 'the stamped grain equals the accepted set count');
  assert.ok(Object.prototype.hasOwnProperty.call(exs[1], 'accepted_set_count'), 'the field is PRESENT on a no-count slot');
  assert.equal(exs[1].accepted_set_count, null, 'a no-count slot is stamped null — no v1 rows, nothing may be bounded');
});

// ── 2. effectivePrescription reads the immutable grain, never the display grain ──

test('a substitution-inflated slot.sets does not move acceptedSetCount', () => {
  const slot = { plan_item_id: PI, name: 'Incline DB Press', sets: 3, accepted_set_count: 2, weight: 90, reps: 8, rir: 2 };
  const eff = effective.effectivePrescription({ slot, sessionLog: [{ exercise: 'Incline DB Press' }], sessionRevisions: [] });
  assert.equal(eff.acceptedSetCount, 2, 'the immutable grain wins over the overwritten display count');
  assert.equal(eff.nextSetIndex, 2);
  const eff2 = effective.effectivePrescription({ slot, sessionLog: [{ exercise: 'Incline DB Press' }, { exercise: 'Incline DB Press' }], sessionRevisions: [] });
  assert.equal(eff2.futureSetsRemain, false, 'set 3 is beyond the v1 grain — nothing left to revise');
});

test('a stamped-NULL grain fails closed even after substitution populates sets', () => {
  const slot = { plan_item_id: PI, name: 'Cable Fly', sets: 3, accepted_set_count: null, weight: 40, reps: 12 };
  assert.equal(effective.effectivePrescription({ slot, sessionLog: [], sessionRevisions: [] }), null,
    'no v1 rows exist for this item — no revision may ever be bounded');
});

test('a pre-stamp slot (field absent) keeps the historical slot.sets behavior', () => {
  const slot = { plan_item_id: PI, name: 'Bench Press', sets: 2, weight: 225, reps: 5 };
  const eff = effective.effectivePrescription({ slot, sessionLog: [], sessionRevisions: [] });
  assert.equal(eff.acceptedSetCount, 2);
});

// ── 3. the terminal symptom, against the REAL store and seal ─────────────────────

async function checkpointAccepted2SetItem() {
  await store.checkpointAcceptedPlan(SESSION, [{
    plan_item_id: PI, planned_lift_code: 'BEN01', target_set_count: 2,
    target_weight: 225, target_reps: 5, target_rir: 2, confidence: 'reliable',
  }]);
}

test('DEFECT REPRODUCTION: an inflated-count revision makes the seal permanently unreachable', async () => {
  await checkpointAccepted2SetItem();
  // The pre-fix path: the revision builder is handed the substitution-inflated count
  // (3) with 2 sets performed → it emits a set-3 revision at v2, which the store
  // durably checkpoints. No v1 row for set 3 exists.
  const inflated = ledger.buildFutureRevisions({
    plan_item_id: PI, planned_lift_code: 'IDP01',
    target_weight: 90, target_reps: 8, target_rir: 2,
    target_set_count: 3, performedCount: 2, sessionRevisions: [],
  });
  assert.equal(inflated.length, 1);
  assert.equal(inflated[0].set_index, 3);
  assert.equal(inflated[0].plan_version, 2, 'v2 with no v1 predecessor');
  await store.checkpointRevision(SESSION, inflated[0]);

  const seal = await store.sealCloseout(SESSION, 'w-defect-1');
  assert.equal(seal.sealed_ok, false, 'the seal must refuse a dangling chain');
  assert.equal(seal.reason, 'malformed_chain');
  assert.equal(seal.diagnostics.set_index, 3, 'the diagnostics name the exact dangling set');

  const retry = await store.sealCloseout(SESSION, 'w-defect-1');
  assert.equal(retry.sealed_ok, false, 'a retry recomputes the same malformed chain — unrecoverable');
});

test('FIX PATH: bounded by the immutable grain, the same workout seals verified', async () => {
  await checkpointAccepted2SetItem();
  // The fixed client: effectivePrescription reads the immutable grain (2) off the
  // substituted slot, so the revision builder is bounded by it. With 1 set performed
  // the substitute's targets revise set 2 only; set 3 never exists in the ledger.
  const slot = { plan_item_id: PI, name: 'Incline DB Press', sets: 3, accepted_set_count: 2, weight: 225, reps: 5, rir: 2 };
  const eff = effective.effectivePrescription({ slot, sessionLog: [{ exercise: 'Incline DB Press' }], sessionRevisions: [] });
  const bounded = ledger.buildFutureRevisions({
    plan_item_id: PI, planned_lift_code: 'IDP01',
    target_weight: 90, target_reps: 8, target_rir: 2,
    target_set_count: eff.acceptedSetCount, performedCount: eff.performed, sessionRevisions: [],
  });
  assert.deepEqual(bounded.map(r => r.set_index), [2], 'revisions stop at the v1 grain');
  for (const r of bounded) await store.checkpointRevision(SESSION, r);

  const seal = await store.sealCloseout(SESSION, 'w-fixed-1');
  assert.equal(seal.sealed_ok, true, 'a chain bounded by the v1 grain seals verified');
  assert.equal(seal.sealed, 3, 'both v1 rows and the set-2 revision are sealed');
});

// ── 4. the app.js glue (built shell) carries the grain through a substitution ────

test('applySessionSubstitution reads and preserves the immutable grain (built-shell pins)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const block = app.slice(app.indexOf('function applySessionSubstitution('), app.indexOf('function emitFutureSetRevision('));
  assert.match(block, /Object\.prototype\.hasOwnProperty\.call\(exs\[idx\], 'accepted_set_count'\)/,
    'the revision bound reads the immutable field (presence, not truthiness) — a second swap must not read the first substitute\'s count');
  assert.match(block, /accepted_set_count: originalSetCount != null \? originalSetCount : null/,
    'the replacement slot carries the immutable grain forward');
  assert.doesNotMatch(block, /const originalSetCount = exs\[idx\]\.sets;/,
    'the mutable display count is no longer the bound');
});
