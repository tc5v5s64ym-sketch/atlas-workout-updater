'use strict';

// §6.2 P1, P3, P5, P6, P7 — the backfill, its reconciliation, and cutover
// readiness, against the REAL from-empty database.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.3, §4 (the mapping),
// §4.7 (blank versus null), §6.2.
//
// The Sheets side is a deterministic fixture rather than owner data — no workout
// value in this repository may be real (§8.4) — but everything below the fixture
// is real: the real row contract, the real adapter, the real from-empty schema,
// the real sweep, the real repair worker, and the real least-privileged role.
//
// P3 is explicit that a count match alone is not reconciliation. Every assertion
// here checks identity AND content, and the field-difference report is redacted to
// SHAPES by construction.

const test = require('node:test');
const assert = require('node:assert');

// The frozen map's exact-duplicate approvals name PRODUCTION content, which a
// synthetic workbook cannot hold, and an unmatched approval fails closed. Scoped
// out at the one shared resolver seam — never by relaxing the rule. See the module.
require('./support/syntheticIdentityMap');

const { withOwner, resetSchema } = require('./support/db');
const adapter = require('../services/supabaseAdapter');
const contract = require('../services/migrationRowContract');
const backfill = require('../services/migrationBackfill');
const readParity = require('../services/migrationReadParity');
const { runSweep } = require('../services/migrationSweep');
const { runRepair } = require('../services/migrationRepair');
const { readinessVerdict } = require('../scripts/atlas-migration-readiness');

// ── The workbook, as sheets.getSheetRows() presents it: DATA ROWS ONLY ────────
// sheets.js:784-790 slices the header off, so a fixture that kept one would be
// testing a shape production never sees.
const SESSIONS = ['20260801-AM-01', '20260803-PM-01', '20260805-AM-02'];

function logRow(session, exercise, setNumber, weight, reps, rir) {
  return [
    `${session.slice(0, 4)}-${session.slice(4, 6)}-${session.slice(6, 8)}`, session, exercise, exercise,
    'legs', 'SQ01', setNumber, weight, reps, rir, '', weight * reps,
  ];
}

const TABS = {
  Log_Cleaned: [
    logRow(SESSIONS[0], 'Back Squat', 1, 225, 5, 2),
    logRow(SESSIONS[0], 'Back Squat', 2, 225, 5, 1),
    logRow(SESSIONS[0], 'Romanian Deadlift', 1, 185, 8, 2),
    logRow(SESSIONS[1], 'Back Squat', 1, 235, 5, 2),
    logRow(SESSIONS[2], 'Overhead Press', 1, 115, 6, 2),
  ],
  Effort: [
    ['2026-08-01', SESSIONS[0], '00:52:00', 410, 520, 148, 171, 'Home gym', ''],
    ['2026-08-03', SESSIONS[1], '00:41:00', 330, 430, 142, 165, 'Home gym', ''],
    // SESSIONS[2] deliberately has NO Effort row — a real workbook has ragged tabs.
  ],
  Session_Plans: [
    [`${SESSIONS[0]}|1|plan_accepted|item-1`, SESSIONS[0], '2026-08-01', 1, 'plan_accepted', 'item-1',
      1, 'SQ01', 'squat', '', '', '', '2026-08-01T10:00:00.000Z'],
    [`${SESSIONS[0]}|1|session_closeout|`, SESSIONS[0], '2026-08-01', 1, 'session_closeout', '',
      '', '', '', '', '', 'finalized', '2026-08-01T11:00:00.000Z'],
  ],
  Session_Plan_Sets: [
    [`${SESSIONS[0]}|1|item-1|1`, SESSIONS[0], '2026-08-01', 1, 'item-1', 'SQ01', 1, 3, 225, 5, 2,
      'engine', '', 'reliable', '', '2026-08-01T10:00:00.000Z'],
    [`${SESSIONS[0]}|1|item-1|2`, SESSIONS[0], '2026-08-01', 1, 'item-1', 'SQ01', 2, 3, 225, 5, 2,
      'engine', '', 'reliable', '', '2026-08-01T10:00:00.000Z'],
  ],
  Exercise_Catalog: [
    ['exercise', 'muscle_group', 'lift_code', 'canonical_exercise'],   // the catalog read KEEPS its header
    ['back squat', 'legs', 'SQ01', 'Back Squat'],
    ['romanian deadlift', 'hamstrings', 'RDL01', 'Romanian Deadlift'],
    ['overhead press', 'shoulders', 'OHP01', 'Overhead Press'],
  ],
};

function cloneTabs() {
  return JSON.parse(JSON.stringify(TABS));
}

// A Sheets stand-in with the exact surface the backfill, the sweep, the repair
// worker and the read-parity comparison consume.
function sheetsFixture(tabs) {
  return {
    getSheetRows: async (tab) => (tabs[tab] || []).map((r) => [...r]),
    getExerciseCatalog: async () => (tabs.Exercise_Catalog || []).map((r) => [...r]),
    // These two mirror sheets.js EXACTLY, including its skips. The real
    // getLogCompositeKeys (sheets.js:890-913) drops a row missing session_id,
    // exercise or set_number, and getEffortSessionIds (:883-888) drops a blank and
    // the header. A fixture that kept them would compare the prospective read path
    // against a Sheets behaviour production does not have.
    getLogCompositeKeys: async () => (tabs.Log_Cleaned || [])
      .map((r) => [
        String(r[1] ?? '').trim(), String(r[2] ?? '').trim(), String(r[6] ?? '').trim(),
      ])
      .filter(([sid, ex, setn]) => sid && ex && setn)
      .map(([sid, ex, setn]) => `${sid.toLowerCase()}||${ex.toLowerCase()}||${setn.toLowerCase()}`),
    getEffortSessionIds: async () => (tabs.Effort || [])
      .map((r) => String(r[1] ?? '').trim())
      .filter((value) => value && value.toLowerCase() !== 'session id'),
  };
}

let tabs;
let sheets;
test.beforeEach(async () => {
  await resetSchema();
  tabs = cloneTabs();
  sheets = sheetsFixture(tabs);
});
test.after(async () => { await adapter.close(); });

/* ══════════ the backfill itself ══════════ */

const BACKFILLED_TABLES = ['logged_sets', 'session_effort', 'session_plan_events',
  'session_plan_set_recommendations', 'workout_sessions', 'exercise_catalog_sync'];

async function tableCounts(tables = BACKFILLED_TABLES) {
  const counts = {};
  await withOwner(async (client) => {
    for (const table of tables) {
      counts[table] = (await client.query(`SELECT count(*)::int AS n FROM atlas.${table}`)).rows[0].n;
    }
  });
  return counts;
}

test('the dry run writes NOTHING, and against an EMPTY destination every eligible row is would_insert', async () => {
  const plan = await backfill.runBackfill({ sheets, adapter, apply: false });
  assert.equal(plan.applied, false);
  assert.equal(plan.complete, true);
  assert.equal(plan.totals.inserted, 0, 'a dry run must never insert');
  assert.equal(plan.totals.rows_with_identity, 11, '5 logged sets + 2 effort + 2 plan events + 2 plan set rows');

  // The half that used to be claimed and never proven: the dry run READ the
  // destination and split the eligible rows by what it found there.
  assert.equal(plan.totals.would_insert, 11, 'an empty destination means every eligible row would be inserted');
  assert.equal(plan.totals.already_present, 0, 'and nothing is already present');

  for (const [table, n] of Object.entries(await tableCounts())) {
    assert.equal(n, 0, `atlas.${table} must be untouched by a dry run`);
  }
});

test('BITE: a proven legacy Effort date crosses the real Postgres DATE boundary', async () => {
  tabs.Effort[0][0] = '20260801-AM';
  const legacySheets = sheetsFixture(tabs);

  const result = await backfill.runBackfill({
    sheets: legacySheets, adapter, apply: true, concepts: ['session_effort'], includeCatalog: false,
  });
  assert.equal(result.complete, true, JSON.stringify(result.concepts));
  assert.equal(result.concepts[0].inserted, 2);

  await withOwner(async (client) => {
    const stored = await client.query(
      'SELECT effort_date::text AS effort_date FROM atlas.session_effort WHERE session_id = $1',
      [SESSIONS[0]]
    );
    assert.equal(stored.rows[0].effort_date, '2026-08-01');
  });
});

test('the production-shaped partial state dry-runs as existing successes plus missing concepts', async () => {
  // The paused production apply has exactly these concept classes populated:
  // logged sets and set recommendations landed; Effort and plan events did not.
  await backfill.runBackfill({
    sheets, adapter, apply: true,
    concepts: ['logged_sets', 'session_plan_set_recommendations'], includeCatalog: false,
  });
  const before = await tableCounts();

  const dry = await backfill.runBackfill({ sheets, adapter, apply: false, includeCatalog: false });
  const byConcept = Object.fromEntries(dry.concepts.map((plan) => [plan.concept, plan]));

  assert.deepEqual(
    {
      logged_sets: [byConcept.logged_sets.already_present, byConcept.logged_sets.would_insert],
      session_effort: [byConcept.session_effort.already_present, byConcept.session_effort.would_insert],
      session_plan_events: [byConcept.session_plan_events.already_present, byConcept.session_plan_events.would_insert],
      session_plan_set_recommendations: [
        byConcept.session_plan_set_recommendations.already_present,
        byConcept.session_plan_set_recommendations.would_insert,
      ],
    },
    {
      logged_sets: [5, 0],
      session_effort: [0, 2],
      session_plan_events: [0, 2],
      session_plan_set_recommendations: [2, 0],
    }
  );
  assert.deepEqual(await tableCounts(), before, 'the destination-aware resume proof is read-only');

  const existingOnly = await backfill.reconcile({
    sheets, adapter, concepts: ['logged_sets', 'session_plan_set_recommendations'],
  });
  assert.equal(existingOnly.reconciled, true,
    'already-present successes retain exact identity and content equality without rollback');
});

test('after a completed backfill the dry run reports would_insert 0 and already_present 11', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  const before = await tableCounts();

  const plan = await backfill.runBackfill({ sheets, adapter, apply: false });
  assert.equal(plan.applied, false);
  assert.equal(plan.complete, true);
  assert.equal(plan.totals.inserted, 0, 'a dry run still inserts nothing, converged or not');
  assert.equal(plan.totals.would_insert, 0, 'a converged destination means nothing left to insert');
  assert.equal(plan.totals.already_present, 11, 'and every eligible row is recognised as already present');

  assert.deepEqual(await tableCounts(), before, 'a dry run over a populated destination changes nothing');
});

// ── THE BITE PROOF ───────────────────────────────────────────────────────────
// The two tests above are only worth their names if they FAIL when the
// destination read is removed. Rather than assert that in prose, mutate exactly
// that one behaviour and prove the numbers move.
test('BITE: bypassing the destination read makes the dry run wrong, so the proof above cannot pass without it', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });

  // The mutant: a dry run that does not really look at Supabase. This is the
  // shape of the original defect — it answers as though the destination were
  // empty however full it is.
  const blind = { ...adapter, listConcept: async () => [] };
  const mutated = await backfill.runBackfill({ sheets, adapter: blind, apply: false });

  assert.equal(mutated.totals.would_insert, 11,
    'the blind adapter reports every row as pending against a FULL destination');
  assert.equal(mutated.totals.already_present, 0,
    'and sees nothing already present — the exact false preflight this fix removes');

  // Same fixture, same instant, real adapter: the opposite answer. The counts
  // therefore come from the destination read and from nothing else.
  const honest = await backfill.runBackfill({ sheets, adapter, apply: false });
  assert.equal(honest.totals.would_insert, 0);
  assert.equal(honest.totals.already_present, 11);
  assert.notEqual(mutated.totals.already_present, honest.totals.already_present,
    'removing the destination read must change the reported result, or the read is decorative');
});

// *Required review of `63e39a3`, finding P1.* Two Sheets rows, ONE export
// identity. `ON CONFLICT DO NOTHING` means apply inserts one of them, so a dry
// run that counted rows would promise two. The preflight may never overstate the
// apply it is predicting.
test('a DUPLICATE source identity cannot overstate would_insert — it predicts what apply actually inserts', async () => {
  // logged_sets identity is session_id||exercise||set_number, so this row is a
  // second copy of an identity already in the fixture. Its weight differs, which
  // is deliberate: identity collides, content does not.
  tabs.Log_Cleaned.push(logRow(SESSIONS[0], 'Back Squat', 1, 245, 5, 2));
  const sheets2 = sheetsFixture(tabs);

  const dry = await backfill.runBackfill({
    sheets: sheets2, adapter, apply: false, concepts: ['logged_sets'], includeCatalog: false,
  });
  const plan = dry.concepts[0];

  assert.equal(plan.rows_with_identity, 6, 'six eligible ROWS are read');
  assert.equal(plan.sheets_duplicate_identities, 1, 'one of them duplicates an identity, and that is reported');
  assert.equal(plan.would_insert, 5, 'but only five distinct IDENTITIES can be inserted');
  assert.equal(plan.already_present, 0);

  // The claim, proven rather than reasoned about: the number the dry run promised
  // is the number apply performs.
  const applied = await backfill.runBackfill({
    sheets: sheets2, adapter, apply: true, concepts: ['logged_sets'], includeCatalog: false,
  });
  assert.equal(applied.concepts[0].inserted, plan.would_insert,
    'would_insert must equal what apply actually inserted, or the preflight lied');

  await withOwner(async (client) => {
    const n = (await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets')).rows[0].n;
    assert.equal(n, 5, 'the destination holds one row per identity, which is why five was the honest answer');
  });
});

// *Required review of `63e39a3`, finding P2.* A summary is what an operator reads.
test('a MIXED run — one concept read, a later one failed — reports null totals, never a partial sum', async () => {
  const flaky = {
    ...adapter,
    listConcept: async (concept) => {
      if (concept === 'session_effort') throw new Error('connection reset by peer');
      return adapter.listConcept(concept);
    },
  };
  const plan = await backfill.runBackfill({ sheets, adapter: flaky, apply: false });

  assert.equal(plan.complete, false, 'a run with an unread concept is NOT complete');

  const logged = plan.concepts.find((c) => c.concept === 'logged_sets');
  const effort = plan.concepts.find((c) => c.concept === 'session_effort');
  assert.equal(logged.error, null, 'the concept that succeeded keeps its result');
  assert.equal(logged.would_insert, 5, 'and its own counter stays a real number');
  assert.match(effort.error, /supabase_read_failed/, 'the concept that failed keeps its failure');
  assert.equal(effort.would_insert, null);

  // The finding itself: the aggregate must not launder a partial read into a number.
  assert.equal(plan.totals.would_insert, null, 'a partial destination read yields NO whole-workbook total');
  assert.equal(plan.totals.already_present, null);
  assert.equal(plan.totals.sheets_duplicate_identities, null);

  for (const [table, n] of Object.entries(await tableCounts())) {
    assert.equal(n, 0, `a mixed failed dry run still wrote nothing to atlas.${table}`);
  }
});

test('a dry run whose destination read FAILS is an error, never a zero', async () => {
  const broken = {
    ...adapter,
    listConcept: async () => { throw new Error('connection refused'); },
  };
  const plan = await backfill.runBackfill({ sheets, adapter: broken, apply: false });

  assert.equal(plan.complete, false, 'a run that could not read the destination is NOT complete');
  for (const concept of plan.concepts) {
    assert.match(concept.error || '', /supabase_read_failed/, 'the failure is reported, not swallowed');
    assert.equal(concept.would_insert, null, 'an uncomputed counter stays null');
    assert.equal(concept.already_present, null, 'never 0, which would read as "nothing to do"');
    assert.equal(concept.sheets_duplicate_identities, null);
  }
  assert.equal(plan.totals.would_insert, null, 'and the total never fabricates a zero either');
  assert.equal(plan.totals.already_present, null);
  assert.equal(plan.totals.sheets_duplicate_identities, null);

  for (const [table, n] of Object.entries(await tableCounts())) {
    assert.equal(n, 0, `a failed dry run still wrote nothing to atlas.${table}`);
  }
});

test('the backfill loads every sourceable concept, parent-first', async () => {
  const result = await backfill.runBackfill({ sheets, adapter, apply: true });
  assert.equal(result.complete, true, JSON.stringify(result.concepts));

  await withOwner(async (client) => {
    const counts = {};
    for (const table of ['workout_sessions', 'logged_sets', 'session_effort',
      'session_plan_events', 'session_plan_set_recommendations', 'exercise_catalog_mirror']) {
      counts[table] = (await client.query(`SELECT count(*)::int AS n FROM atlas.${table}`)).rows[0].n;
    }
    assert.equal(counts.logged_sets, 5);
    assert.equal(counts.session_effort, 2);
    assert.equal(counts.session_plan_events, 2);
    assert.equal(counts.session_plan_set_recommendations, 2);
    assert.equal(counts.exercise_catalog_mirror, 3);
    // Every child's parent was DERIVED from its session_id and inserted first.
    assert.equal(counts.workout_sessions, 3, 'three distinct sessions across the tabs');

    const parent = await client.query(
      'SELECT session_date, period, slot FROM atlas.workout_sessions WHERE session_id = $1', [SESSIONS[2]]
    );
    assert.equal(String(parent.rows[0].session_date), '2026-08-05');
    assert.equal(parent.rows[0].period, 'AM');
    assert.equal(parent.rows[0].slot, 2, 'the parent is parsed from the id, never invented');
  });
});

test('write_receipts is NOT backfilled, and write_id stays NULL throughout (§3.6)', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  await withOwner(async (client) => {
    const receipts = await client.query('SELECT count(*)::int AS n FROM atlas.write_receipts');
    assert.equal(receipts.rows[0].n, 0,
      'the workbook stores no write_id, so a backfilled receipt would be a FABRICATED one');

    for (const table of ['logged_sets', 'session_effort']) {
      const nonNull = await client.query(`SELECT count(*)::int AS n FROM atlas.${table} WHERE write_id IS NOT NULL`);
      assert.equal(nonNull.rows[0].n, 0, `atlas.${table}.write_id must be NULL through S2 and S3`);
    }

    // And the cursor takes its base at cutover, not now.
    const cursor = await client.query('SELECT count(*)::int AS n FROM atlas.sheets_mirror_cursor');
    assert.equal(cursor.rows[0].n, 0, 'a base recorded now would be stale by the time §5.5 step 4 used it');
  });
});

test('the backfill is IDEMPOTENT — a re-run inserts nothing and duplicates nothing', async () => {
  const first = await backfill.runBackfill({ sheets, adapter, apply: true });
  const second = await backfill.runBackfill({ sheets, adapter, apply: true });

  assert.equal(second.totals.inserted, 0, 'a converged re-run adds nothing');
  assert.equal(second.totals.existing, first.totals.inserted, 'and recognises every row as already present');

  const report = await backfill.reconcile({ sheets, adapter });
  assert.equal(report.reconciled, true, 'a re-run must not break reconciliation');
});

test('an interrupted backfill RESUMES rather than duplicating', async () => {
  // Load only the first two tabs, as an interruption would leave it.
  await backfill.runBackfill({ sheets, adapter, apply: true, concepts: ['logged_sets'], includeCatalog: false });
  const partial = await backfill.reconcile({ sheets, adapter });
  assert.equal(partial.reconciled, false, 'a partial load is honestly NOT reconciled');

  await backfill.runBackfill({ sheets, adapter, apply: true });
  const complete = await backfill.reconcile({ sheets, adapter });
  assert.equal(complete.reconciled, true);

  await withOwner(async (client) => {
    const sets = await client.query('SELECT count(*)::int AS n FROM atlas.logged_sets');
    assert.equal(sets.rows[0].n, 5, 'the resumed run did not double the rows it had already written');
  });
});

test('a row with an unparseable session_id is SKIPPED and reported, never guessed at', async () => {
  tabs.Log_Cleaned.push(['2026-08-07', 'not-a-session-id', 'Bench Press', 'Bench Press', 'chest', 'BP01', 1, 185, 5, 2, '', 925]);
  const result = await backfill.runBackfill({ sheets, adapter, apply: true });
  const plan = result.concepts.find((c) => c.concept === 'logged_sets');
  assert.equal(plan.rows_skipped_unparseable_session, 1);
  assert.equal(plan.inserted, 5, 'the five well-formed rows still load');

  await withOwner(async (client) => {
    const sessions = await client.query('SELECT count(*)::int AS n FROM atlas.workout_sessions');
    assert.equal(sessions.rows[0].n, 3, 'no fabricated session parent reached the destination');
  });

  // And the sweep opens a divergence for it, so it reaches the owner rather than
  // vanishing into a skip counter.
  const sweep = await runSweep({ sheets, adapter, openDivergences: true });
  assert.equal(sweep.totals.missing_in_supabase, 1, 'Sheets is the authority and holds a row Supabase lacks');
});

/* ══════════ §6.2 P3 — reconciliation: identity AND content ══════════ */

test('P3: after the backfill every tab reconciles by count, identity AND content', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  const report = await backfill.reconcile({ sheets, adapter });

  assert.equal(report.complete, true);
  assert.equal(report.reconciled, true, JSON.stringify(report.tabs, null, 2));
  assert.equal(report.tabs.length, 4, 'all four sourceable tabs');

  for (const tab of report.tabs) {
    assert.equal(tab.counts_equal, true, `${tab.concept}: equal row counts`);
    assert.equal(tab.missing_in_supabase, 0, `${tab.concept}: every Sheets row matched by identity`);
    assert.equal(tab.missing_in_sheets, 0, `${tab.concept}: no Supabase-only row`);
    assert.equal(tab.content_mismatch, 0, `${tab.concept}: zero field differences`);
    assert.equal(tab.matched_by_identity, tab.sheets_rows, `${tab.concept}: matched by identity, not merely counted`);
    assert.deepEqual(tab.field_differences, {});
  }
});

test('P3: a COUNT match with a CONTENT difference is reported as NOT reconciled', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  // Same identity, different load. A counter-only check would call this clean.
  await withOwner((client) => client.query(
    `UPDATE atlas.logged_sets SET weight = 999 WHERE session_id = $1 AND exercise = 'Back Squat' AND set_number = 1`,
    [SESSIONS[0]]
  ));

  const report = await backfill.reconcile({ sheets, adapter });
  const tab = report.tabs.find((t) => t.concept === 'logged_sets');
  assert.equal(tab.counts_equal, true, 'the counts still match — which is exactly why counts are not reconciliation');
  assert.equal(tab.content_mismatch, 1);
  assert.equal(report.reconciled, false);

  // REDACTED BY CONSTRUCTION: shapes, never values.
  assert.ok(tab.field_differences.weight, 'the differing field is named');
  const example = tab.field_differences.weight.examples[0];
  assert.match(example.sheets, /^(int\(\d+\)|decimal|null|empty)$/, `a shape, not a load: ${example.sheets}`);
  assert.match(example.supabase, /^(int\(\d+\)|decimal|null|empty)$/);
  assert.equal(JSON.stringify(report).includes('999'), false, 'no workout value may appear in committed evidence');
  assert.equal(JSON.stringify(report).includes('225'), false);
});

test('P3: the §4.7 blank/null rule survives the round trip', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  await withOwner(async (client) => {
    // TEXT: a blank cell is NULL, never an empty string masquerading as a value.
    const notes = await client.query('SELECT notes FROM atlas.logged_sets WHERE notes IS NOT NULL');
    assert.equal(notes.rowCount, 0, 'a blank notes cell reads as NULL');

    // VOCAB: '' is a MEMBER of the frozen vocabulary and must stay '', because the
    // idempotency key is derived from it.
    const closeout = await client.query(
      `SELECT plan_item_id, outcome, closeout_status FROM atlas.session_plan_events
        WHERE event_type = 'session_closeout'`
    );
    assert.equal(closeout.rows[0].plan_item_id, '', "a closeout row's plan_item_id stays '' — NULL would change its key");
    assert.equal(closeout.rows[0].outcome, '');
    assert.equal(closeout.rows[0].closeout_status, 'finalized');

    // NUM: a blank target is NULL, never 0 — a 0 target is a prescription.
    const targets = await client.query(
      'SELECT closeout_write_id FROM atlas.session_plan_set_recommendations WHERE closeout_write_id IS NULL'
    );
    assert.equal(targets.rowCount, 2, 'an unsealed plan set carries NULL, not an empty string');
  });
});

/* ══════════ §6.2 P6 — a COMPLETE sweep, and zero open divergences ══════════ */

test('P6: after the backfill a COMPLETE sweep finds zero divergences', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  const sweep = await runSweep({ sheets, adapter, openDivergences: true });

  assert.equal(sweep.complete, true, 'a sweep that could not reconcile a concept is NEVER a zero');
  assert.equal(sweep.divergences_found, 0, JSON.stringify(sweep.concepts, null, 2));
  for (const concept of sweep.concepts) {
    assert.equal(concept.complete, true, `${concept.concept} must be reconcilable`);
    assert.equal(concept.error, null);
  }

  const summary = await adapter.divergenceSummary();
  assert.equal(Number(summary.open_count), 0, 'the cutover-readiness zero');
});

test('P6: an INCOMPLETE sweep is not a zero, even when its counters read zero', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  // Two Sheets rows under one export identity: Supabase's unique index can hold
  // only one, so the tab is not reconcilable however the counters look.
  tabs.Log_Cleaned.push(logRow(SESSIONS[0], 'Back Squat', 1, 225, 5, 2));

  const sweep = await runSweep({ sheets, adapter, openDivergences: true });
  assert.equal(sweep.complete, false, 'a duplicate identity makes the concept unreconcilable');
  const summary = await adapter.divergenceSummary();
  assert.ok(Number(summary.open_count) > 0, 'and it becomes a DURABLE row, not a statistic');
});

/* ══════════ FINDING 3 — an IDENTITYLESS authoritative row ══════════ */

// *Required Atlas Contract / Systems Review of `65310b3`, finding 3.*
//
// Sheets is the authority and can hold a row with NO export identity — every
// identity component blank. Such a row cannot be matched, cannot be compared,
// cannot be repaired, and cannot even be recorded as a divergence, because a
// divergence is keyed BY identity.
//
// Both the backfill and the sweep used to drop it silently, from BOTH sides, so
// the counts agreed and every gate read clean. These proofs use a genuinely
// identityless row and assert that S3 completeness, reconciliation and readiness
// each fail EXPLICITLY. Nothing here invents an identity to make it representable —
// that would hide the very defect being proven.
const IDENTITYLESS_LOG_ROW = ['2026-08-07', '', '', '', 'legs', '', '', 195, 5, 2, '', 975];

test('FINDING 3: an identityless authoritative row makes the BACKFILL incomplete, not merely skipped', async () => {
  tabs.Log_Cleaned.push([...IDENTITYLESS_LOG_ROW]);

  const result = await backfill.runBackfill({ sheets, adapter, apply: true });
  const plan = result.concepts.find((c) => c.concept === 'logged_sets');

  assert.equal(plan.rows_skipped_no_identity, 1, 'the row is recognised as having no identity');
  assert.equal(plan.inserted, 5, 'and the five well-formed rows still load');
  assert.match(plan.error, /sheets_identityless/, 'it is an ERROR, not a counter nobody reads');
  assert.match(plan.error, /OWNER ACTION REQUIRED/);
  assert.equal(result.complete, false,
    'a backfill that could not represent an authoritative row is NOT complete');

  // And nothing was invented to make it representable.
  await withOwner(async (client) => {
    const blank = await client.query(
      `SELECT count(*)::int AS n FROM atlas.logged_sets WHERE session_id = '' OR exercise = ''`
    );
    assert.equal(blank.rows[0].n, 0, 'no placeholder row reached the destination');
    const sessions = await client.query('SELECT count(*)::int AS n FROM atlas.workout_sessions');
    assert.equal(sessions.rows[0].n, 3, 'and no fabricated session parent either');
  });
});

test('FINDING 3: it makes the SWEEP incomplete — never a zero', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  tabs.Log_Cleaned.push([...IDENTITYLESS_LOG_ROW]);

  const sweep = await runSweep({ sheets, adapter, openDivergences: true });
  const concept = sweep.concepts.find((c) => c.concept === 'logged_sets');

  assert.equal(concept.sheets_identityless, 1, 'it is COUNTED rather than dropped');
  assert.equal(concept.complete, false, 'and the concept is not reconcilable');
  assert.match(concept.error, /sheets_identityless/);
  assert.equal(sweep.complete, false, 'so the run as a whole is not a zero');

  // It correctly opens NO divergence — there is no identity to key one by, and the
  // sweep must not invent one. Incompleteness is the honest record.
  assert.equal(concept.divergences_opened, 0);
  assert.equal(Number((await adapter.divergenceSummary()).open_count), 0,
    'the durable count is genuinely zero here, which is exactly why P6 may not read it alone');
});

test('FINDING 3: it makes RECONCILIATION fail even though the counts still agree', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  tabs.Log_Cleaned.push([...IDENTITYLESS_LOG_ROW]);

  const report = await backfill.reconcile({ sheets, adapter });
  const tab = report.tabs.find((t) => t.concept === 'logged_sets');

  // THE POINT: dropping the row from both sides made the counts agree, and a
  // count-based reconciliation would have called this clean.
  assert.equal(tab.counts_equal, true, 'the counts still match — that is the trap');
  assert.equal(tab.missing_in_supabase, 0);
  assert.equal(tab.content_mismatch, 0);
  assert.equal(tab.sheets_identityless, 1);
  assert.equal(tab.reconciled, false, 'and it is still NOT reconciled');
  assert.equal(report.reconciled, false);
});

test('FINDING 3: the READ-PARITY path fails on it too, and does not drop it', async () => {
  // *Required review of `a29129e`, P1.* compareCellSets() re-derived the retired
  // rule and would have DROPPED this row from both sides, making the sizes match
  // and parity report equal — a cutover-readiness green on a tab holding a row
  // Supabase can never represent.
  await backfill.runBackfill({ sheets, adapter, apply: true });
  tabs.Log_Cleaned.push([...IDENTITYLESS_LOG_ROW]);

  const verdict = await readParity.compareReadPaths({ sheets, adapter });
  const rows = verdict.reads.find((r) => r.id === 'logged_sets_rows');

  assert.equal(rows.equal, false, 'an identityless authoritative row must fail the comparison');
  assert.match(rows.detail, /identityless rows cannot be compared/);
  assert.match(rows.detail, /sheets=1/);
  assert.match(rows.detail, /OWNER ACTION REQUIRED/);
  assert.equal(verdict.ready, false);

  // Redacted: the reason carries counts, never a value (§3.8).
  assert.equal(/195|975/.test(rows.detail), false, 'no workout value may appear in a parity reason');
});

test('FINDING 3: a SINGLE-KEY concept with a blank identity fails parity the same way', async () => {
  // logged_sets joins three components to `'||||'`; session_effort's identity IS
  // the session_id, so an identityless row there is the empty string. Both must be
  // caught by the one shared predicate, or the rule is concept-specific by accident.
  await backfill.runBackfill({ sheets, adapter, apply: true });
  tabs.Effort.push(['2026-08-07', '', '00:30:00', 200, 260, 120, 140, 'Home gym', '']);

  const verdict = await readParity.compareReadPaths({ sheets, adapter });
  const rows = verdict.reads.find((r) => r.id === 'session_effort_rows');
  assert.equal(rows.equal, false, "an empty single-component identity is identityless too");
  assert.match(rows.detail, /identityless rows cannot be compared/);
  assert.equal(verdict.ready, false);

  // And the sweep agrees, through the same predicate.
  const sweep = await runSweep({ sheets, adapter, openDivergences: false });
  const concept = sweep.concepts.find((c) => c.concept === 'session_effort');
  assert.equal(concept.sheets_identityless, 1);
  assert.equal(sweep.complete, false);
});

test('FINDING 3: readiness REFUSES on it, through the real verdict', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  tabs.Log_Cleaned.push([...IDENTITYLESS_LOG_ROW]);

  const sweep = await runSweep({ sheets, adapter, openDivergences: false });
  const summary = await adapter.divergenceSummary();
  const assessment = readinessVerdict({
    parity: await readParity.compareReadPaths({ sheets, adapter }),
    sweep,
    openDivergences: summary.open_count,
    catalog: { ok: true },
  });

  assert.equal(assessment.open_divergences, 0, 'the durable count is zero…');
  assert.equal(assessment.verdict.p6_zero_divergences, false, '…and readiness refuses anyway');
  assert.equal(assessment.ready, false);
});

/* ══════════ FINDING 2 — the stale zero, against a real database ══════════ */

test('FINDING 2: a durable ZERO with a live mismatch must FAIL readiness', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });

  // A real content divergence, introduced WITHOUT opening a divergence row — the
  // state a database is in whenever a mismatch appears before the opening sweep
  // next runs. The durable table stays empty.
  await withOwner((client) => client.query(
    `UPDATE atlas.logged_sets SET reps = reps + 1 WHERE session_id = $1 AND exercise = 'Back Squat' AND set_number = 1`,
    [SESSIONS[0]]
  ));

  const sweep = await runSweep({ sheets, adapter, openDivergences: false });
  const summary = await adapter.divergenceSummary();

  assert.equal(Number(summary.open_count), 0, 'nothing has been RECORDED…');
  assert.equal(sweep.complete, true, '…the sweep ran to completion…');
  assert.equal(sweep.divergences_found, 1, '…and it found a live mismatch right now');

  const assessment = readinessVerdict({
    parity: { ready: true }, sweep, openDivergences: summary.open_count, catalog: { ok: true },
  });
  assert.equal(assessment.verdict.p6_zero_divergences, false,
    'reading the durable count alone would have certified a state that is no longer true');
  assert.equal(assessment.ready, false);
});

/* ══════════ §6.2 P7 — a repair closes only on a PASSING re-comparison ══════════ */

test('P7: a repaired omission closes ONLY after the re-comparison passes', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  // Remove one Supabase row, as a failed shadow write or a process death would.
  await withOwner((client) => client.query(
    `DELETE FROM atlas.logged_sets WHERE session_id = $1 AND exercise = 'Romanian Deadlift'`, [SESSIONS[0]]
  ));

  const sweep = await runSweep({ sheets, adapter, openDivergences: true });
  assert.equal(sweep.totals.missing_in_supabase, 1);

  const repaired = await runRepair({ sheets, adapter });
  assert.equal(repaired.closed, 1);
  assert.equal(repaired.open_after, 0);

  await withOwner(async (client) => {
    const closed = await client.query(
      `SELECT state, closure_proof FROM atlas.migration_divergences WHERE state = 'closed'`
    );
    assert.equal(closed.rowCount, 1);
    assert.match(closed.rows[0].closure_proof, /recompare:/,
      'the closure records the comparison that authorised it — never a timer and never "the repair ran"');
    assert.match(closed.rows[0].closure_proof, /present in both stores/);
  });

  const after = await backfill.reconcile({ sheets, adapter });
  assert.equal(after.reconciled, true, 'and the tab genuinely reconciles again');
});

test('P7: a divergence the worker CANNOT fix stays OPEN — an unrepairable one is never closed', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  // A Supabase-only orphan on a concept the runtime holds no DELETE for (§8.2
  // grants DELETE on logged_sets and nowhere else in the workout schema).
  await withOwner((client) => client.query(
    `INSERT INTO atlas.session_plan_events
       (idempotency_key, session_id, session_date, plan_version, event_type, plan_item_id, outcome, closeout_status, recorded_at)
     VALUES ($1, $2, '2026-08-01', 1, 'plan_accepted', 'item-orphan', '', '', now())`,
    [`${SESSIONS[0]}|1|plan_accepted|item-orphan`, SESSIONS[0]]
  ));

  await runSweep({ sheets, adapter, openDivergences: true });
  const repaired = await runRepair({ sheets, adapter });
  assert.equal(repaired.closed, 0, 'a repair worker that closed what it could not fix would make the S3 zero a lie');
  assert.equal(repaired.left_open, 1);
  assert.ok(Number((await adapter.divergenceSummary()).open_count) > 0, 'it reaches the owner as owner action required');
});

/* ══════════ §6.2 P1 and P5 — the reads S4 will move ══════════ */

test('P1: every declared moved read has a prospective Supabase implementation', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  // Deterministic, per read, rather than only through the aggregate verdict.
  const keys = await readParity.logCompositeKeys({ adapter });
  assert.deepEqual([...keys].sort(), [...(await sheets.getLogCompositeKeys())].sort());

  const effort = await readParity.effortSessionIds({ adapter });
  assert.deepEqual([...effort].sort(), [...(await sheets.getEffortSessionIds())].sort());

  for (const concept of contract.CONCEPT_NAMES) {
    const rows = await readParity.conceptRows(concept, { adapter });
    const spec = contract.conceptSpec(concept);
    assert.equal(rows.length, (await sheets.getSheetRows(spec.tab)).length, `${concept}: same row count`);
    for (const cells of rows) {
      assert.equal(cells.length, spec.sheetColumns.length,
        `${concept}: the projection must be the full ${spec.sheetColumns.length}-cell contract row`);
    }
  }

  const catalog = await readParity.exerciseCatalogRows({ adapter });
  assert.equal(catalog.length, 3);
});

test('P5: every read S4 will move returns what the Sheets read returns today', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  const verdict = await readParity.compareReadPaths({ sheets, adapter });

  assert.equal(verdict.reads.length, readParity.MOVED_READS.length, 'the comparison set may not silently shrink');
  for (const read of verdict.reads) {
    assert.equal(read.error, null, `${read.id} threw: ${read.error}`);
    assert.equal(read.equal, true, `${read.id} differs: ${read.detail}`);
  }
  assert.equal(verdict.ready, true);
});

test('P5: a single differing row makes the verdict FALSE — readiness is not cosmetic', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  await withOwner((client) => client.query(
    `UPDATE atlas.logged_sets SET reps = reps + 1 WHERE session_id = $1 AND exercise = 'Back Squat' AND set_number = 1`,
    [SESSIONS[0]]
  ));
  const verdict = await readParity.compareReadPaths({ sheets, adapter });
  assert.equal(verdict.ready, false);
  assert.equal(verdict.reads.find((r) => r.id === 'logged_sets_rows').equal, false);
});

test('P5: a missing row is caught by the DERIVED duplicate-guard read too', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  await withOwner((client) => client.query(
    `DELETE FROM atlas.logged_sets WHERE session_id = $1 AND exercise = 'Back Squat' AND set_number = 2`, [SESSIONS[0]]
  ));
  const verdict = await readParity.compareReadPaths({ sheets, adapter });
  const keys = verdict.reads.find((r) => r.id === 'log_composite_keys');
  assert.equal(keys.equal, false, 'the composite-key projection is what the Save path actually consults');
  assert.match(keys.detail, /sheets=5 supabase=4/);
});

test('P5: the catalog read FAILS CLOSED past the age bound rather than serving stale content', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });

  // Age the verified generation past the bound.
  await withOwner((client) => client.query(
    `UPDATE atlas.exercise_catalog_sync SET verified_at = now() - interval '10 hours' WHERE status = 'verified'`
  ));

  let refused = null;
  try {
    await readParity.exerciseCatalogRows({ adapter });
  } catch (err) {
    refused = err;
  }
  assert.ok(refused, 'a stale mirror must never be served');
  assert.equal(refused.code, 'CATALOG_MIRROR_UNAVAILABLE');
  assert.equal(refused.status, 503);

  // And the readiness verdict reports it rather than skipping it.
  const verdict = await readParity.compareReadPaths({ sheets, adapter });
  assert.equal(verdict.ready, false);
  assert.match(verdict.reads.find((r) => r.id === 'exercise_catalog').error, /not servable/);
});

test('P5: a catalog EDIT converges through the sync — a changed hash is not a failure', async () => {
  await backfill.runBackfill({ sheets, adapter, apply: true });
  assert.equal((await readParity.compareReadPaths({ sheets, adapter })).ready, true);

  // The owner edits the editing authority, which is still Google Sheets.
  tabs.Exercise_Catalog.push(['front squat', 'legs', 'FSQ01', 'Front Squat']);
  const drifted = await readParity.compareReadPaths({ sheets, adapter });
  assert.equal(drifted.reads.find((r) => r.id === 'exercise_catalog').equal, false, 'the mirror is now behind');

  const resynced = await backfill.backfillCatalog({ sheets, adapter, apply: true });
  assert.equal(resynced.ok, true, 'an ordinary catalog edit is INGESTED, never recorded as a failure');
  assert.equal((await readParity.compareReadPaths({ sheets, adapter })).ready, true);
});
