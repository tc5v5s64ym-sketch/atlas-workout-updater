const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STORAGE_KEY,
  MAX_STORED_ENTRIES,
  PREFERENCES,
  shouldShowCompareCard,
  summarizeLegacy,
  summarizeBrian,
  buildComparisonEntry,
  loadComparisons,
  saveComparisonEntry
} = require('../public/hybridCompare');

/* ===== shouldShowCompareCard — the card's dev/hybrid-only gate ===== */

const LEGACY_ONLY_RECOMMENDATION = {
  recommendation: 'Hold 225 and build cleaner 5s.',
  reasoning: 'Two clean sessions at this load.',
  next_target: { weight: 225, reps: 5, sets: 3 },
  target_rir: 2
};

const HYBRID_RECOMMENDATION = {
  ...LEGACY_ONLY_RECOMMENDATION,
  brian: {
    decision_type: 'progression',
    status: 'answered',
    payload: { lift_code: 'BEN01', action: 'hold', target_weight: 225, target_reps: 5, rationale: 'Two clean sessions.' },
    confidence: { score: 82, tier: 'high', action: 'act', caveats: [] },
    safety: { level: 'green', flags: [], blocking: false }
  }
};

test('shouldShowCompareCard: true when recommendation.brian is a valid object', () => {
  assert.equal(shouldShowCompareCard(HYBRID_RECOMMENDATION), true);
});

test('shouldShowCompareCard: false with no brian field (shadow attach did not validate / legacy mode)', () => {
  assert.equal(shouldShowCompareCard(LEGACY_ONLY_RECOMMENDATION), false);
});

test('shouldShowCompareCard: false when brian is not an object', () => {
  assert.equal(shouldShowCompareCard({ ...LEGACY_ONLY_RECOMMENDATION, brian: 'not-an-object' }), false);
});

test('shouldShowCompareCard: false when recommendation is null/undefined', () => {
  assert.equal(shouldShowCompareCard(null), false);
  assert.equal(shouldShowCompareCard(undefined), false);
});

// Gate is deliberately single-signal: index.js only ever attaches a validated
// recommendation.brian while ATLAS_COACH_ENGINE==='hybrid', so its presence
// alone is sufficient proof — no separately-fetched coachEngineMode is
// needed (see the function's own comment for the TOCTOU this avoids).
test('shouldShowCompareCard: takes only recommendation, not an engine-mode flag', () => {
  assert.equal(shouldShowCompareCard.length, 1);
});

/* ===== summarizeLegacy ===== */

test('summarizeLegacy extracts the legacy fields the production coach card already reads', () => {
  assert.deepEqual(summarizeLegacy(LEGACY_ONLY_RECOMMENDATION), {
    verdict: 'Hold 225 and build cleaner 5s.',
    reasoning: 'Two clean sessions at this load.',
    target_weight: 225,
    target_reps: 5,
    target_sets: 3,
    target_rir: 2
  });
});

test('summarizeLegacy degrades to nulls when next_target/fields are missing', () => {
  assert.deepEqual(summarizeLegacy({}), {
    verdict: null,
    reasoning: null,
    target_weight: null,
    target_reps: null,
    target_sets: null,
    target_rir: null
  });
});

test('summarizeLegacy never throws on a non-object input', () => {
  assert.doesNotThrow(() => summarizeLegacy(null));
  assert.doesNotThrow(() => summarizeLegacy(undefined));
});

/* ===== summarizeBrian ===== */

test('summarizeBrian projects the CoachingDecision payload/confidence/safety', () => {
  assert.deepEqual(summarizeBrian(HYBRID_RECOMMENDATION), {
    decision_type: 'progression',
    status: 'answered',
    action: 'hold',
    target_weight: 225,
    target_reps: 5,
    rationale: 'Two clean sessions.',
    confidence_tier: 'high',
    confidence_action: 'act',
    safety_level: 'green'
  });
});

test('summarizeBrian returns null when recommendation.brian is absent', () => {
  assert.equal(summarizeBrian(LEGACY_ONLY_RECOMMENDATION), null);
  assert.equal(summarizeBrian(null), null);
});

/* ===== buildComparisonEntry ===== */

test('buildComparisonEntry assembles a feedback entry without mutating the recommendation', () => {
  const frozen = Object.freeze(JSON.parse(JSON.stringify(HYBRID_RECOMMENDATION)));
  const entry = buildComparisonEntry({
    timestamp: '2026-07-01T04:00:00.000Z',
    liftCode: 'BEN01',
    preference: 'brian',
    note: '  Brian caught the plateau, legacy missed it.  ',
    recommendation: frozen
  });
  assert.equal(entry.preference, 'brian');
  assert.equal(entry.liftCode, 'BEN01');
  assert.equal(entry.note, 'Brian caught the plateau, legacy missed it.');
  assert.deepEqual(entry.legacy, summarizeLegacy(HYBRID_RECOMMENDATION));
  assert.deepEqual(entry.brian, summarizeBrian(HYBRID_RECOMMENDATION));
  // Object.freeze would throw on write if buildComparisonEntry mutated the source.
  assert.deepEqual(frozen, JSON.parse(JSON.stringify(HYBRID_RECOMMENDATION)));
});

test('buildComparisonEntry never emits write-path/proof fields — it is feedback, not a Sheets write', () => {
  const entry = buildComparisonEntry({ preference: 'legacy', recommendation: LEGACY_ONLY_RECOMMENDATION });
  for (const forbidden of ['sheet_written', 'sheet_write', 'no_write_confirmed', 'write_id', 'log_rows_written', 'test_mode']) {
    assert.equal(Object.prototype.hasOwnProperty.call(entry, forbidden), false, `entry must not carry '${forbidden}'`);
  }
});

test('buildComparisonEntry throws on an invalid preference (fails loudly, never coerces)', () => {
  assert.throws(() => buildComparisonEntry({ preference: 'brian-is-better', recommendation: HYBRID_RECOMMENDATION }));
  assert.throws(() => buildComparisonEntry({ preference: undefined, recommendation: HYBRID_RECOMMENDATION }));
});

test('buildComparisonEntry accepts every documented preference value', () => {
  for (const pref of PREFERENCES) {
    assert.doesNotThrow(() => buildComparisonEntry({ preference: pref, recommendation: HYBRID_RECOMMENDATION }));
  }
});

test('buildComparisonEntry caps an oversized note rather than storing it unbounded', () => {
  const entry = buildComparisonEntry({ preference: 'neither', note: 'x'.repeat(10000), recommendation: HYBRID_RECOMMENDATION });
  assert.ok(entry.note.length <= 500);
});

/* ===== loadComparisons / saveComparisonEntry (localStorage, injected) ===== */

function fakeStorage() {
  const store = new Map();
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, v); }
  };
}

test('loadComparisons returns [] when storage is empty/missing', () => {
  assert.deepEqual(loadComparisons(fakeStorage()), []);
  assert.deepEqual(loadComparisons(null), []);
});

test('loadComparisons degrades to [] on corrupt JSON instead of throwing', () => {
  const storage = fakeStorage();
  storage.setItem(STORAGE_KEY, '{not json');
  assert.deepEqual(loadComparisons(storage), []);
});

test('saveComparisonEntry appends and round-trips through loadComparisons', () => {
  const storage = fakeStorage();
  const entry = buildComparisonEntry({ preference: 'legacy', liftCode: 'BEN01', recommendation: HYBRID_RECOMMENDATION });
  saveComparisonEntry(storage, entry);
  const loaded = loadComparisons(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].preference, 'legacy');
});

test('saveComparisonEntry throws (does not swallow) when the underlying storage write fails', () => {
  // A save that didn't actually persist must never be reported as "Saved" —
  // so unlike loadComparisons, this is NOT caught internally; the caller
  // (public/app.js saveHybridComparePreference) is expected to catch it and
  // show an error instead of a false "Saved" confirmation.
  const throwingStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); }
  };
  const entry = buildComparisonEntry({ preference: 'legacy', recommendation: HYBRID_RECOMMENDATION });
  assert.throws(() => saveComparisonEntry(throwingStorage, entry), /QuotaExceededError/);
});

test('saveComparisonEntry caps stored history at MAX_STORED_ENTRIES, dropping the oldest', () => {
  const storage = fakeStorage();
  for (let i = 0; i < MAX_STORED_ENTRIES + 10; i++) {
    saveComparisonEntry(storage, buildComparisonEntry({
      preference: 'brian',
      liftCode: `E${i}`,
      recommendation: HYBRID_RECOMMENDATION
    }));
  }
  const loaded = loadComparisons(storage);
  assert.equal(loaded.length, MAX_STORED_ENTRIES);
  // Oldest 10 (E0..E9) were dropped; the newest survives.
  assert.equal(loaded[loaded.length - 1].liftCode, `E${MAX_STORED_ENTRIES + 9}`);
  assert.equal(loaded.some(e => e.liftCode === 'E0'), false);
});
