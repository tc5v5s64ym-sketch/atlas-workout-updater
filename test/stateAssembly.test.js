'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

// Requiring stateAssembly must NOT pull sheets.js / googleapis (the whole point
// of the injected-reader design). If it did, this require would throw here.
const { assembleState, knownKeys, defaultReaders } = require('../services/stateAssembly');

const ASOF = '2026-06-30T14:00:00Z';

// Log_Cleaned rows in the canonical 12-column POSITIONAL form (what getLogRows
// returns and what memoryModule consumes):
//   date_clean | session_id | exercise | canonical_exercise | muscle_group |
//   lift_code | set_number | weight | reps | rir | notes | volume_calc
const LOG_ROWS = [
  ['2026-06-01', 's1', 'Back Squat', 'Back Squat', 'quads', 'SQUAT', 1, 225, 5, 2, '', 1125],
  ['2026-06-04', 's2', 'Back Squat', 'Back Squat', 'quads', 'SQUAT', 1, 230, 5, 2, '', 1150],
];

function stubReaders(overrides = {}) {
  return {
    getLogRows:      async () => LOG_ROWS,
    readDeloadState: async () => ({ training_state: 'NORMAL' }),
    getProfile:      async () => ({ profile_goal: 'powerlifting', training_level: 'intermediate', population: 'general' }),
    // pass through any extra readers (e.g. getConstraints) verbatim
    ...overrides,
  };
}

// ─── single-read / reader reuse (double-read hardening) ──────────────────────

describe('assembleState — reads the log exactly once', () => {
  it('calls getLogRows a single time (no duplicate read within assembly)', async () => {
    let calls = 0;
    const readers = stubReaders({ getLogRows: async () => { calls++; return LOG_ROWS; } });
    await assembleState({ readers, asOf: ASOF });
    assert.strictEqual(calls, 1);
  });
  it('a caller can override getLogRows with pre-loaded rows (the index.js reuse pattern)', async () => {
    const preloaded = LOG_ROWS;
    let fetched = false;
    const readers = stubReaders({ getLogRows: async () => { fetched = true; return preloaded; } });
    const s = await assembleState({ readers, asOf: ASOF });
    assert.ok(fetched);
    assert.strictEqual(s.log_history, preloaded);
  });
  it('exposes defaultReaders as a function (index.js spreads it, overriding getLogRows)', () => {
    // Do not invoke — the real defaults lazy-require the Sheets client.
    assert.strictEqual(typeof defaultReaders, 'function');
  });
});

// ─── snapshot shape ──────────────────────────────────────────────────────────

describe('assembleState — snapshot shape (stub readers, no live Sheets)', () => {
  it('builds the documented shape', async () => {
    const s = await assembleState({ readers: stubReaders(), asOf: ASOF });
    assert.strictEqual(s.asOf, ASOF);
    assert.ok(Array.isArray(s.log_history));
    assert.deepEqual(s.profile, { profile_goal: 'powerlifting', training_level: 'intermediate', population: 'general' });
    assert.deepEqual(s.deload_state, { training_state: 'NORMAL' });
    assert.strictEqual(s.equipment_profile, null);
    assert.ok(s.provenance && Array.isArray(s.provenance.reads) && Array.isArray(s.provenance.derived));
    assert.strictEqual(s.provenance.state_asOf, ASOF);
  });

  it('records which readers ran in provenance.reads', async () => {
    const s = await assembleState({ readers: stubReaders(), asOf: ASOF });
    assert.ok(s.provenance.reads.includes('log'));
    assert.ok(s.provenance.reads.includes('deload_state'));
    assert.ok(s.provenance.reads.includes('profile'));
  });

  it('echoes asOf verbatim and defaults to null when absent', async () => {
    const s = await assembleState({ readers: stubReaders() });
    assert.strictEqual(s.asOf, null);
    assert.strictEqual(s.provenance.state_asOf, null);
  });
});

// ─── constraints_active (the Constraints tab reaches the Brain) ──────────────

describe('assembleState — constraints_active', () => {
  const ROWS = [['2026-07-01', 'preference', 'Leg Press', 'avoid', null]];

  it('hydrates stored Constraints rows via the injected reader and records the read', async () => {
    const s = await assembleState({ readers: stubReaders({ getConstraints: async () => ROWS }), asOf: ASOF });
    assert.deepEqual(s.constraints_active, ROWS);
    assert.ok(s.provenance.reads.includes('constraints'));
  });

  it('degrades to [] when the reader is absent or throws — never blocks the snapshot', async () => {
    const absent = await assembleState({ readers: stubReaders(), asOf: ASOF });
    assert.deepEqual(absent.constraints_active, []);
    const thrown = await assembleState({
      readers: stubReaders({ getConstraints: async () => { throw new Error('tab missing'); } }),
      asOf: ASOF,
    });
    assert.deepEqual(thrown.constraints_active, []);
    assert.ok(!thrown.provenance.reads.includes('constraints'));
    assert.ok(thrown.log_history.length === 2, 'the rest still hydrated');
  });

  it('knownKeys includes constraints_active only when rows exist', async () => {
    const withRows = await assembleState({ readers: stubReaders({ getConstraints: async () => ROWS }), asOf: ASOF });
    assert.ok(knownKeys(withRows).has('constraints_active'));
    const without = await assembleState({ readers: stubReaders(), asOf: ASOF });
    assert.ok(!knownKeys(without).has('constraints_active'));
  });
});

// ─── derived keys ────────────────────────────────────────────────────────────

describe('assembleState — derived keys', () => {
  it('derives memory_snapshot and bodyweight_history from log_history', async () => {
    const s = await assembleState({ readers: stubReaders(), asOf: ASOF });
    assert.ok(s.memory_snapshot !== null, 'memory_snapshot should be derived');
    assert.ok(s.provenance.derived.includes('memory_snapshot'));
    assert.ok(s.provenance.derived.includes('bodyweight_history'));
  });

  it('derives nothing when log_history is empty', async () => {
    const s = await assembleState({ readers: stubReaders({ getLogRows: async () => [] }), asOf: ASOF });
    assert.strictEqual(s.memory_snapshot, null);
    assert.strictEqual(s.bodyweight_history, null);
    assert.deepEqual(s.provenance.derived, []);
  });

  it('memory_snapshot reflects the injected rows (not a separate read)', async () => {
    const s = await assembleState({ readers: stubReaders(), asOf: ASOF });
    // buildMemorySnapshot surfaces encountered lifts; SQUAT was in the injected rows
    const json = JSON.stringify(s.memory_snapshot);
    assert.ok(json.includes('SQUAT'), 'memory snapshot should reflect injected SQUAT rows');
  });
});

// ─── graceful degradation ────────────────────────────────────────────────────

describe('assembleState — graceful degradation', () => {
  it('a throwing reader yields the fallback, never throws', async () => {
    const s = await assembleState({
      readers: stubReaders({ readDeloadState: async () => { throw new Error('sheets down'); } }),
      asOf: ASOF,
    });
    assert.strictEqual(s.deload_state, null);
    assert.ok(!s.provenance.reads.includes('deload_state'));
    // the rest still hydrated
    assert.ok(s.log_history.length === 2);
  });

  it('an empty/absent log reader yields [] and no derived keys', async () => {
    const s = await assembleState({ readers: stubReaders({ getLogRows: async () => null }), asOf: ASOF });
    assert.deepEqual(s.log_history, []);
    assert.deepEqual(s.provenance.derived, []);
  });

  it('all readers failing still returns a well-formed snapshot', async () => {
    const boom = async () => { throw new Error('down'); };
    const s = await assembleState({ readers: { getLogRows: boom, readDeloadState: boom, getProfile: boom }, asOf: ASOF });
    assert.deepEqual(s.log_history, []);
    assert.strictEqual(s.deload_state, null);
    assert.deepEqual(s.profile, { profile_goal: null, training_level: null, population: null });
    assert.deepEqual(s.provenance.reads, []);
  });

  it('missing reader functions are treated as absent (no throw)', async () => {
    const s = await assembleState({ readers: {}, asOf: ASOF });
    assert.deepEqual(s.log_history, []);
    assert.strictEqual(s.deload_state, null);
  });

  it('never throws on garbage params', async () => {
    await assert.doesNotReject(() => assembleState(null));
    await assert.doesNotReject(() => assembleState('x'));
    await assert.doesNotReject(() => assembleState({}));
  });
});

// ─── purity ──────────────────────────────────────────────────────────────────

describe('assembleState — purity of shaping', () => {
  it('same readers + same asOf → same snapshot', async () => {
    const a = await assembleState({ readers: stubReaders(), asOf: ASOF });
    const b = await assembleState({ readers: stubReaders(), asOf: ASOF });
    assert.deepEqual(a, b);
  });
});

// ─── knownKeys ───────────────────────────────────────────────────────────────

describe('knownKeys', () => {
  it('includes present state keys', async () => {
    const s = await assembleState({ readers: stubReaders(), asOf: ASOF });
    const keys = knownKeys(s, { constraints: {} });
    assert.ok(keys.has('log_history'));
    assert.ok(keys.has('deload_state'));
    assert.ok(keys.has('profile_goal'));
    assert.ok(keys.has('training_level'));
    assert.ok(keys.has('memory_snapshot'));
    assert.ok(!keys.has('equipment_profile')); // null → absent
  });

  it('omits absent state keys', async () => {
    const s = await assembleState({ readers: stubReaders({ getLogRows: async () => [], readDeloadState: async () => null }), asOf: ASOF });
    const keys = knownKeys(s, {});
    assert.ok(!keys.has('log_history'));
    assert.ok(!keys.has('deload_state'));
    assert.ok(!keys.has('memory_snapshot'));
  });

  it('namespaces envelope constraint keys and passes readiness_inputs/signal as-is', () => {
    const keys = knownKeys({ profile: {} }, { constraints: { focus: 'upper_body', readiness_inputs: { sleep: 6 }, signal: {} } });
    assert.ok(keys.has('constraint.focus'));
    assert.ok(keys.has('readiness_inputs'));
    assert.ok(keys.has('signal'));
    assert.ok(!keys.has('constraint.readiness_inputs'));
  });

  it('handles null/garbage inputs without throwing', () => {
    assert.doesNotThrow(() => knownKeys(null, null));
    assert.ok(knownKeys(null, null) instanceof Set);
  });
});

// ─── read-only guard ─────────────────────────────────────────────────────────

describe('stateAssembly — read-only guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'stateAssembly.js'), 'utf8');

  it('invokes no writer (no append/write Sheets call)', () => {
    assert.ok(!/appendDeloadState|appendRows|\.append\(/.test(src),
      'stateAssembly must never call a Sheets writer');
  });

  it('imports only pure derivers at the top level (Sheets-backed readers are lazy)', () => {
    // top-level = before the first function declaration
    const head = src.slice(0, src.indexOf('function _defaultReaders'));
    const topRequires = [...head.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    for (const t of topRequires) {
      assert.ok(['./memoryModule', './analytics'].includes(t),
        `top-level require('${t}') must be a pure deriver — Sheets-backed readers belong in _defaultReaders`);
    }
    // and the Sheets-backed readers must be require'd lazily (present somewhere, just not at top)
    assert.ok(src.includes("require('./trainingStore')"));
    assert.ok(src.includes("require('./deloadState')"));
  });

  it("requires the Sheets client at '../sheets' — a './sheets' typo silently empties _defaultReaders", () => {
    // The real client is repo-root sheets.js; siblings in services/ require it as '../sheets'.
    // A './sheets' typo (services/sheets.js does not exist) throws MODULE_NOT_FOUND inside
    // _defaultReaders' try/catch, which then returns {} — silently stripping deload_state,
    // profile, and constraints from EVERY brian snapshot (the reader spread degrades to
    // just getLogRows). Guard the exact path so that never regresses.
    assert.ok(src.includes("require('../sheets')"),
      "_defaultReaders must require the root Sheets client as '../sheets'");
    assert.ok(!/require\(\s*['"]\.\/sheets['"]\s*\)/.test(src),
      "must NOT require('./sheets') — services/sheets.js does not exist, so it silently returns {}");
    // and that path must actually resolve to a real module from services/.
    assert.doesNotThrow(() => require.resolve(path.join(__dirname, '..', 'sheets')));
  });
});
