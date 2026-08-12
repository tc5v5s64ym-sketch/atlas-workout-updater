'use strict';

// THE PLAN-EVENT VERSION IS AN OPAQUE TEXT TOKEN, AND THE PLAN-SET VERSION IS AN
// INTEGER COUNTER. Owner ruling 2026-08-12.
//
// `Session_Plans.plan_version` carries the accepted plan's `pv_…` identity token.
// The destination column was declared `integer`, and the row contract
// canonicalised the field as INT — so `Number('pv_ab12')` was NaN and the token
// became NULL on its way to Supabase. Production forensics found 55 eligible
// historical plan events carrying such tokens.
//
// `Session_Plan_Sets.plan_version` is a DIFFERENT dimension with the same name:
// the integer set-revision counter, whose arithmetic requires an integer.
//
// These tests are deterministic and need no database. The real-Postgres round trip
// is test-pg/planEventVersionText.pgproof.js.

const test = require('node:test');
const assert = require('node:assert');

const contract = require('../services/migrationRowContract');
const { sessionPlansColumns, sessionPlanSetsColumns } = require('../config/columns');

const TOKEN = 'pv_12345678-abcd';

function planEventCells(planVersion) {
  const byColumn = {
    idempotency_key: 'ff00aa11bb22cc33',
    session_id: '20260801-AM-01',
    session_date: '2026-08-01',
    plan_version: planVersion,
    event_type: 'plan_accepted',
    plan_item_id: 'pi_9f8e7d',
    planned_order: 1,
    planned_lift_code: 'SQ01',
    movement_pattern: 'squat',
    outcome: 'planned',
    performed_lift_code: '',
    closeout_status: '',
    recorded_at: '2026-08-01T10:00:00.000Z',
  };
  return sessionPlansColumns.map((column) => byColumn[column]);
}

function planSetCells(planVersion) {
  const byColumn = {
    idempotency_key: '00112233445566aa',
    session_id: '20260801-AM-01',
    session_date: '2026-08-01',
    plan_version: planVersion,
    plan_item_id: 'pi_9f8e7d',
    planned_lift_code: 'SQ01',
    set_index: 1,
    target_set_count: 3,
    target_weight: 225,
    target_reps: 5,
    target_rir: 2,
    recommendation_source: 'accepted',
    supersedes_key: '',
    confidence: 'reliable',
    closeout_write_id: '',
    recorded_at: '2026-08-01T10:00:00.000Z',
  };
  return sessionPlanSetsColumns.map((column) => byColumn[column]);
}

/* ══════════ A — the token survives the Sheets side of the contract ══════════ */

test('A: an opaque pv_ token survives rowFromSheet unchanged', () => {
  const row = contract.rowFromSheet('session_plan_events', planEventCells(TOKEN));
  assert.equal(row.plan_version, TOKEN,
    'the authoritative token must arrive at the destination byte-for-byte');
});

test('A: it survives the Supabase side, and the two sides compare EQUAL', () => {
  const fromSheet = contract.rowFromSheet('session_plan_events', planEventCells(TOKEN));
  // Exactly what the driver hands back from a text column.
  const fromSupabase = contract.rowFromSupabase('session_plan_events', {
    ...fromSheet,
    recorded_at: new Date('2026-08-01T10:00:00.000Z'),
  });
  assert.equal(fromSupabase.plan_version, TOKEN);

  const { equal, differences } = contract.compareRows('session_plan_events', fromSheet, fromSupabase);
  assert.equal(equal, true, JSON.stringify(differences));
});

test('A: and it survives the round trip back to a Sheets cell', () => {
  const row = contract.rowFromSheet('session_plan_events', planEventCells(TOKEN));
  const cells = contract.sheetCellsFromRow('session_plan_events', row);
  assert.equal(cells[sessionPlansColumns.indexOf('plan_version')], TOKEN);
});

/* ══════════ C — the bite ══════════ */
//
// The tests above are only worth their names if reverting the mapping to INT
// breaks them. Rather than assert that in prose, run the OLD canonicalisation over
// the same token and show what it did.

test('C BITE: the retired INT canonicalisation destroys the token, and hides the loss', () => {
  const asInt = contract.canonicalize(contract.KINDS.INT, TOKEN);
  assert.equal(asInt, null, 'Number("pv_…") is NaN, so the INT kind stored NULL — the token was lost');

  const asText = contract.canonicalize(contract.KINDS.TEXT, TOKEN);
  assert.equal(asText, TOKEN);
  assert.notEqual(asInt, asText, 'the two kinds must disagree, or this proof is decorative');

  // WORSE THAN LOSS: under INT both sides canonicalised to null, so the comparison
  // reported the rows EQUAL while the destination held nothing. That is the false
  // green the S3 gates exist to prevent, and it is why the mapping is the defect
  // rather than the schema alone.
  const nulls = contract.compareRows(
    'session_plan_events',
    { plan_version: asInt },
    { plan_version: asInt }
  );
  assert.equal(nulls.equal, true, 'null vs null looked equal — the loss was invisible');

  // With TEXT, a destination that dropped the token is now a reported difference.
  const honest = contract.compareRows(
    'session_plan_events',
    { plan_version: TOKEN },
    { plan_version: null }
  );
  assert.equal(honest.equal, false);
  assert.deepEqual(honest.differences.map((d) => d.field), ['plan_version']);
});

/* ══════════ D — the two dimensions stay separate ══════════ */

test('D: the plan-EVENT version is TEXT and the plan-SET version is INT, in the one contract', () => {
  const eventField = contract.conceptSpec('session_plan_events').fields
    .find((f) => f.column === 'plan_version');
  const setField = contract.conceptSpec('session_plan_set_recommendations').fields
    .find((f) => f.column === 'plan_version');

  assert.equal(eventField.kind, contract.KINDS.TEXT);
  assert.equal(setField.kind, contract.KINDS.INT);
  assert.notEqual(eventField.kind, setField.kind,
    'one name, two dimensions — aliasing them is the defect this repair removes');
});

test('D: the set-revision counter is still a NUMBER, so the ledger arithmetic still works', () => {
  const row = contract.rowFromSheet('session_plan_set_recommendations', planSetCells('2'));
  assert.strictEqual(row.plan_version, 2, 'the revision counter must stay an integer, not become "2"');
  assert.equal(typeof row.plan_version, 'number');
});

test('D: an opaque token in the plan-SET column is NOT quietly accepted as text', () => {
  // The set ledger has no opaque tokens. If one ever appeared there it must fail
  // the destination NOT NULL rather than be stored as a string — the two columns
  // are not interchangeable in either direction.
  const row = contract.rowFromSheet('session_plan_set_recommendations', planSetCells(TOKEN));
  assert.equal(row.plan_version, null);
});

/* ══════════ E — blank ══════════ */

test('E: a blank plan_version stays NULL and is never given a substitute value', () => {
  for (const blank of ['', '   ', null, undefined]) {
    const row = contract.rowFromSheet('session_plan_events', planEventCells(blank));
    assert.equal(row.plan_version, null,
      `a blank cell must read as NULL (§4.7), never as '' and never as a minted token: ${JSON.stringify(blank)}`);
  }
  // NULL is refused by the destination's NOT NULL, and '' by the presence CHECK
  // that 20260812000100 adds — both proven against real Postgres in
  // test-pg/planEventVersionText.pgproof.js. The contract's job is to fail closed,
  // not to invent a version.
});

test('E: the live builder refuses a blank version, which is the authority this mirrors', () => {
  const events = require('../services/sessionPlanEvents');
  assert.throws(
    () => events.buildPlanAcceptedEvents({ session_id: '20260801-AM-01', plan_version: '' }, []),
    /plan_version is required/
  );
});

/* ══════════ F — the historical integer, preserved exactly ══════════ */

test('F: a historical integer version reads as its exact text, not as a new token', () => {
  const row = contract.rowFromSheet('session_plan_events', planEventCells(1));
  assert.strictEqual(row.plan_version, '1',
    'the replay conversion is 1 → "1"; anything else would be invented data');
});
