'use strict';

// THE FROZEN LEGACY IDENTITY BRIDGE — the fourteen proofs the owner required.
//
// The map is a TEMPORARY S3 migration bridge, deleted at S4. These proofs hold two
// lines at once:
//
//   * the bridge translates ONLY what the owner froze, and fails closed on anything
//     it does not cover;
//   * the backfill, the sweep and the reconciliation cannot disagree about a mapping
//     or an exclusion, because there is exactly one resolver and no second classifier.
//
// Owner rulings under proof (recorded 2026-08-12): slot 01 for legacy sessions
// (card 1, OWNER-DECLARED); period PM where no evidence exists (card 2,
// OWNER-DECLARED); two stray Log ids fold into their same-date sessions (card 3);
// 2026-06-12 PM merges into 20260612-PM-01 (card 4); the main-block Effort row
// survives its duplicate (card 5); the 2020 Effort record is excluded (card 6);
// malformed Effort date cells recover date through the proven session identity
// (card 7); Log rows 1046/1054 are excluded (prior ruling).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const contract = require('../services/migrationRowContract');
const legacyMap = require('../services/migrationLegacyIdentityMap');
const { runBackfill, reconcileConcept } = require('../services/migrationBackfill');
const { sweepRowConcept } = require('../services/migrationSweep');

const MAP = JSON.parse(fs.readFileSync(legacyMap.MAP_PATH, 'utf8'));

// Log_Cleaned contract order: date_clean, session_id, exercise, canonical_exercise,
// muscle_group, lift_code, set_number, weight, reps, rir, notes, volume_calc.
const logRow = (sessionId, exercise = 'Bench Press', setNumber = '1') =>
  ['2026-05-20', sessionId, exercise, exercise, 'Chest', 'BP', setNumber, '225', '5', '2', '', '1125'];
// Effort contract order: date, session_id, duration, active_calories, total_calories,
// average_hr, peak_hr, location, notes.
const effRow = (sessionId, date = '2026-05-20', duration = '01:02:03', location = 'Gym') =>
  [date, sessionId, duration, '300', '400', '120', '150', location, ''];

const stubSheets = (rowsByTab) => ({ getSheetRows: async (tab) => (rowsByTab[tab] || []).map((r) => r.slice()) });
const INERT_ADAPTER = { listConcept: async () => [], backfillRows: async () => ({ inserted: 0, existing: 0 }) };

const entryFor = (legacyId) => MAP.sessions.find((e) => e.legacy_session_id.toLowerCase() === legacyId.toLowerCase());

// ── 1. Every legacy id carries an explicit frozen disposition ─────────────────

test('map: all 149 legacy ids have an explicit frozen disposition', () => {
  assert.equal(MAP.sessions.length, 149);
  for (const entry of MAP.sessions) {
    assert.ok(['MAP', 'MERGE_INTO_EXISTING'].includes(entry.disposition), `${entry.legacy_session_id} has no disposition`);
    assert.ok(entry.canonical_session_id, `${entry.legacy_session_id} has no canonical target`);
    assert.ok(entry.owner_ruling, `${entry.legacy_session_id} records no owner ruling`);
  }
  assert.equal(MAP.frozen, true);
  assert.equal(MAP.owner_approved, true);
});

// ── 2. No duplicate source keys ───────────────────────────────────────────────

test('map: source keys are unique, and the exact legacy string is the key', () => {
  const keys = MAP.sessions.map((e) => e.legacy_session_id.trim().toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.filter((k) => k === '').length, 0);
});

test('map: a duplicate source key fails the load', () => {
  const dup = { ...MAP, sessions: [MAP.sessions[0], { ...MAP.sessions[0] }] };
  assert.throws(() => legacyMap.loadMap(dup), /duplicate source key/);
});

// ── 3. Canonical targets satisfy the LIVE identity shape ──────────────────────

test('map: every canonical target parses under the live identity contract', () => {
  for (const entry of MAP.sessions) {
    const parsed = contract.parseSessionId(entry.canonical_session_id);
    assert.ok(parsed, `${entry.canonical_session_id} does not parse`);
    assert.equal(parsed.slot, 1, 'every legacy target is slot 01 per the owner ruling');
  }
});

test('map: a canonical target in legacy grammar fails the load — no legacy grammar escapes', () => {
  const bad = { ...MAP, sessions: [{ ...MAP.sessions[0], canonical_session_id: '2026-05-20' }] };
  assert.throws(() => legacyMap.loadMap(bad), /fails the canonical identity shape/);
});

// ── 4. Owner-declared values are recorded as owner-declared ───────────────────

test('map: slot is OWNER_DECLARED on every entry and is never claimed as derived', () => {
  for (const entry of MAP.sessions) {
    assert.equal(entry.provenance.slot, 'OWNER_DECLARED', `${entry.legacy_session_id} claims a derived slot`);
  }
  const derivedSlot = { ...MAP, sessions: [{ ...MAP.sessions[0], provenance: { ...MAP.sessions[0].provenance, slot: 'source_derived_embedded_in_id' } }] };
  assert.throws(() => legacyMap.loadMap(derivedSlot), /slot provenance must be OWNER_DECLARED/);
});

test('map: the 28 evidence-free periods are OWNER_DECLARED PM, and the derived ones are not', () => {
  const declared = MAP.sessions.filter((e) => e.provenance.period === 'OWNER_DECLARED');
  const crossTab = MAP.sessions.filter((e) => e.provenance.period === 'cross_tab_structurally_derived');
  const carried = MAP.sessions.filter((e) => e.provenance.period === 'source_derived_carried_by_id');
  // 28 card-2 sessions plus the 2 card-3 folds, whose period comes from the owner ruling.
  assert.equal(declared.length, 30);
  assert.equal(crossTab.length, 55);
  assert.equal(carried.length, 64);
  assert.equal(declared.length + crossTab.length + carried.length, 149);
  for (const entry of MAP.sessions.filter((e) => e.owner_ruling === 'CARD_1+CARD_2')) {
    assert.match(entry.canonical_session_id, /-PM-01$/);
    assert.equal(entry.provenance.period, 'OWNER_DECLARED');
    assert.equal(entry.evidence.derived_period, null, 'an owner-declared period must not be reported as derived evidence');
  }
});

// ── 5. The one MERGE_INTO_EXISTING ────────────────────────────────────────────

test('map: 2026-06-12 PM merges into the existing canonical 20260612-PM-01', () => {
  const merges = MAP.sessions.filter((e) => e.disposition === 'MERGE_INTO_EXISTING');
  assert.equal(merges.length, 1);
  assert.equal(merges[0].canonical_session_id, '20260612-PM-01');
  assert.equal(merges[0].owner_ruling, 'CARD_4');
});

test('resolver: a legacy 2026-06-12 PM row resolves onto the existing canonical identity', () => {
  const legacyId = MAP.sessions.find((e) => e.disposition === 'MERGE_INTO_EXISTING').legacy_session_id;
  const resolved = legacyMap.resolveSheetRows('logged_sets', [logRow(legacyId)]);
  assert.equal(resolved.counts.translated, 1);
  assert.equal(resolved.rows[0].session_id, '20260612-PM-01');
});

// ── 6. The two stray Log ids ──────────────────────────────────────────────────

test('map: the two stray one-row Log ids fold into their same-date sessions', () => {
  const strays = MAP.sessions.filter((e) => e.owner_ruling === 'CARD_3');
  assert.equal(strays.length, 2);
  const targets = strays.map((e) => e.canonical_session_id).sort();
  assert.deepEqual(targets, ['20260520-AM-01', '20260529-PM-01']);
  for (const stray of strays) {
    assert.equal(stray.evidence.log_rows, 1, 'each stray carries exactly one Log row');
    assert.ok(stray.evidence.folded_into_same_date_session, 'the host session is recorded');
    // The fold must land on the SAME canonical id as its host legacy session.
    const host = entryFor(stray.evidence.folded_into_same_date_session);
    assert.equal(host.canonical_session_id, stray.canonical_session_id);
  }
});

// ── 7. Log rows 1046 / 1054 are excluded ONLY by explicit frozen disposition ──

test('map: the two Log fragments are excluded by explicit frozen row dispositions', () => {
  const logExclusions = MAP.excluded_rows.filter((e) => e.concept === 'logged_sets');
  assert.equal(logExclusions.length, 2);
  for (const entry of logExclusions) {
    assert.equal(entry.disposition, 'EXCLUDE');
    assert.equal(entry.owner_ruling, 'PRIOR_RULING_1046_1054');
    assert.match(entry.row_fingerprint, /^[0-9a-f]{16}$/);
  }
  assert.deepEqual(logExclusions.map((e) => e.observed_sheet_row_at_freeze).sort((a, b) => a - b), [1046, 1054]);
});

test('resolver: WITHOUT its frozen entry a fragment still fails as identityless — never silently dropped', () => {
  const fragment = ['', '', '', 'Something', 'Something'];
  const withoutExclusions = { ...MAP, excluded_rows: [] };
  const resolved = legacyMap.resolveSheetRows('logged_sets', [fragment], { map: withoutExclusions });
  assert.equal(resolved.counts.no_identity, 1, 'exclusion is the ONLY thing that removes it');
  assert.equal(resolved.counts.excluded_row, 0);
  assert.equal(resolved.rows.length, 0);
});

// ── 8. Effort duplicate: one excluded, one kept ───────────────────────────────

test('map: exactly one half of the Effort duplicate is excluded', () => {
  const effortExclusions = MAP.excluded_rows.filter((e) => e.concept === 'session_effort');
  assert.equal(effortExclusions.length, 1);
  assert.equal(effortExclusions[0].owner_ruling, 'CARD_5');
  assert.equal(effortExclusions[0].observed_sheet_row_at_freeze, 1018);
});

test('resolver: the excluded Effort row drops out while its twin survives with the identity', () => {
  const excluded = MAP.excluded_rows.find((e) => e.concept === 'session_effort');
  // Two rows sharing one identity; only the one whose fingerprint is frozen is removed.
  const kept = effRow('20260624-PM-01', '2026-06-24', '01:02:03', '');
  const dropped = effRow('20260624-PM-01', '2026-06-24', '58.20', 'Gym');
  const stub = { ...MAP, excluded_rows: [{ ...excluded, row_fingerprint: legacyMap.rowFingerprint(dropped) }] };
  const resolved = legacyMap.resolveSheetRows('session_effort', [kept, dropped], { map: stub });
  assert.equal(resolved.counts.excluded_row, 1);
  assert.equal(resolved.rows.length, 1);
  assert.equal(resolved.rows[0].duration, '01:02:03', 'the surviving row is the one the owner kept');
});

// ── 9. The 2020 canonical Effort record is excluded ───────────────────────────

test('map: 20200628-AM-01 is excluded by explicit frozen session disposition', () => {
  assert.equal(MAP.excluded_sessions.length, 1);
  assert.equal(MAP.excluded_sessions[0].session_id, '20200628-AM-01');
  assert.equal(MAP.excluded_sessions[0].disposition, 'EXCLUDE');
  assert.equal(MAP.excluded_sessions[0].owner_ruling, 'CARD_6');
});

test('resolver: the 2020 record is excluded even though its id is already canonical', () => {
  const resolved = legacyMap.resolveSheetRows('session_effort', [effRow('20200628-AM-01', '2020-06-28')]);
  assert.equal(resolved.counts.excluded_session, 1);
  assert.equal(resolved.counts.canonical, 0);
  assert.equal(resolved.rows.length, 0);
});

// ── 10. Malformed Effort date cells ───────────────────────────────────────────

test('resolver: a malformed date cell never blocks a row, and date comes only from the row itself', () => {
  // The date cell holds a session-id-shaped string. The row keeps its identity from
  // session_id; nothing invents a date and nothing reads another row.
  const legacyId = MAP.sessions.find((e) => e.evidence.legacy_form === 'dashed_date_time').legacy_session_id;
  const row = effRow(legacyId, '20260420-PM');
  const resolved = legacyMap.resolveSheetRows('session_effort', [row]);
  assert.equal(resolved.counts.translated, 1);
  assert.equal(resolved.rows.length, 1);
  const expected = entryFor(legacyId).canonical_session_id;
  assert.equal(resolved.rows[0].session_id, expected);
  // The canonical date is the one the session identity proves, never the broken cell.
  assert.equal(expected.slice(0, 8), entryFor(legacyId).evidence.derived_date.replace(/-/g, ''));
});

// ── 11. An unmapped legacy id is a hard completeness failure ──────────────────

test('backfill: an unmapped legacy id fails the run — never a silent skip', async () => {
  const result = await runBackfill({
    sheets: stubSheets({ Log_Cleaned: [logRow('2029-01-01')] }),
    adapter: INERT_ADAPTER,
    concepts: ['logged_sets'],
    includeCatalog: false,
  });
  const plan = result.concepts[0];
  assert.equal(plan.rows_skipped_unparseable_session, 1);
  assert.deepEqual(plan.unmapped_legacy_session_ids, ['2029-01-01']);
  assert.match(String(plan.error), /unmapped_legacy_session/);
  assert.match(String(plan.error), /OWNER ACTION REQUIRED/);
  assert.equal(result.complete, false);
});

test('reconciliation: an unmapped legacy id blocks reconciled, whatever the counts say', async () => {
  const result = await reconcileConcept({
    concept: 'logged_sets',
    sheets: stubSheets({ Log_Cleaned: [logRow('2029-01-01')] }),
    adapter: INERT_ADAPTER,
  });
  assert.equal(result.sheets_unmapped_legacy, 1);
  assert.equal(result.counts_equal, true, 'both sides are empty, so a naive check would pass');
  assert.equal(result.reconciled, false, 'and it must still refuse to reconcile');
});

test('sweep: an unmapped legacy id makes the concept incomplete', async () => {
  const result = await sweepRowConcept({
    concept: 'logged_sets',
    sheets: stubSheets({ Log_Cleaned: [logRow('2029-01-01')] }),
    adapter: { listConcept: async () => [], openDivergence: async () => ({ created: true }) },
    openDivergences: false,
  });
  assert.equal(result.sheets_unmapped_legacy, 1);
  assert.equal(result.complete, false);
});

// ── 12. Mutation / bite proof ─────────────────────────────────────────────────

test('mutation: emptying the map turns every legacy row into a hard failure', async () => {
  const emptied = { ...MAP, sessions: [] };
  const legacyId = MAP.sessions[0].legacy_session_id;
  const resolved = legacyMap.resolveSheetRows('logged_sets', [logRow(legacyId)], { map: emptied });
  assert.equal(resolved.counts.translated, 0, 'without the map nothing translates');
  assert.equal(resolved.counts.unmapped_legacy, 1, 'and the row fails rather than passing through');
  assert.equal(resolved.rows.length, 0);
});

test('mutation: bypassing translation would leave the legacy identity in place', () => {
  const legacyId = MAP.sessions[0].legacy_session_id;
  const translated = legacyMap.resolveSheetRows('logged_sets', [logRow(legacyId)]);
  const untranslated = contract.rowFromSheet('logged_sets', logRow(legacyId));
  assert.notEqual(translated.rows[0].session_id, untranslated.session_id);
  assert.ok(contract.parseSessionId(translated.rows[0].session_id), 'the translated id is canonical');
  assert.equal(contract.parseSessionId(untranslated.session_id), null, 'the source id is not');
});

test('mutation: a map that is not frozen or not owner-approved refuses to load', () => {
  assert.throws(() => legacyMap.loadMap({ ...MAP, frozen: false }), /not marked frozen/);
  assert.throws(() => legacyMap.loadMap({ ...MAP, owner_approved: false }), /not owner-approved/);
});

// ── 13. The consumers cannot disagree ─────────────────────────────────────────

test('backfill, sweep and reconciliation return the SAME verdicts for the same rows', async () => {
  const legacyId = MAP.sessions[0].legacy_session_id;
  const rows = [
    logRow(legacyId, 'Bench Press', '1'),
    logRow('20260801-AM-01', 'Squat', '1'),
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    logRow('2029-01-01', 'Row', '1'),
  ];
  const sheets = stubSheets({ Log_Cleaned: rows });
  const adapter = { ...INERT_ADAPTER, openDivergence: async () => ({ created: true }) };

  const backfill = (await runBackfill({ sheets, adapter, concepts: ['logged_sets'], includeCatalog: false })).concepts[0];
  const reconciliation = await reconcileConcept({ concept: 'logged_sets', sheets, adapter });
  const sweep = await sweepRowConcept({ concept: 'logged_sets', sheets, adapter, openDivergences: false });

  assert.equal(backfill.rows_skipped_blank, reconciliation.sheets_blank_rows);
  assert.equal(backfill.rows_skipped_blank, sweep.sheets_blank_rows);
  assert.equal(backfill.rows_skipped_unparseable_session, reconciliation.sheets_unmapped_legacy);
  assert.equal(backfill.rows_skipped_unparseable_session, sweep.sheets_unmapped_legacy);
  assert.equal(backfill.rows_translated_from_legacy, reconciliation.sheets_translated_from_legacy);
  assert.equal(backfill.rows_translated_from_legacy, sweep.sheets_translated_from_legacy);
  // And all three refuse to claim success.
  assert.equal(reconciliation.reconciled, false);
  assert.equal(sweep.complete, false);
});

test('one resolver only: the backfill exports no second row classifier', () => {
  const backfill = require('../services/migrationBackfill');
  assert.equal(backfill.classifyRow, undefined, 'classifyRow was a second classification authority and is removed');
});

// ── 14. Canonical rows bypass legacy translation unchanged ────────────────────

test('resolver: an already-canonical row passes through untranslated and unmodified', () => {
  const cells = logRow('20260801-AM-01');
  const resolved = legacyMap.resolveSheetRows('logged_sets', [cells]);
  assert.equal(resolved.counts.canonical, 1);
  assert.equal(resolved.counts.translated, 0);
  assert.deepEqual(resolved.rows[0], contract.rowFromSheet('logged_sets', cells));
});

test('resolver: no canonical session id appears as a source key in the map', () => {
  // A canonical id must never be translatable, or the bridge could rewrite live
  // identities rather than only historical ones.
  for (const entry of MAP.sessions) {
    assert.equal(contract.parseSessionId(entry.legacy_session_id), null,
      `${entry.legacy_session_id} is canonical and must not be a translation source`);
  }
});
