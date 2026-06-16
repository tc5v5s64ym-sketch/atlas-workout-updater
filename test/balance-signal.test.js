'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeBalanceSignal } = require('../services/balanceSignal');

// ─── helpers ────────────────────────────────────────────────────────────────

function row(date, exercise) {
  return { date_clean: date, canonical_exercise: exercise };
}

// Make N identical rows.
function rows(n, date, exercise) {
  return Array.from({ length: n }, () => row(date, exercise));
}

// Find a pair record by its canonical name.
function pair(result, name) {
  return result.find(r => r.pair === name);
}

// ─── structural guarantees ──────────────────────────────────────────────────

describe('computeBalanceSignal — structure', () => {
  it('returns exactly 4 records', () => {
    const result = computeBalanceSignal([]);
    assert.strictEqual(result.length, 4);
  });

  it('pairs are in canonical order', () => {
    const result = computeBalanceSignal([]);
    assert.strictEqual(result[0].pair, 'horizontal_push:horizontal_pull');
    assert.strictEqual(result[1].pair, 'vertical_push:vertical_pull');
    assert.strictEqual(result[2].pair, 'anterior:posterior');
    assert.strictEqual(result[3].pair, 'quad:hamstring');
  });

  it('every record has required fields', () => {
    const result = computeBalanceSignal([]);
    for (const rec of result) {
      assert.ok('pair'   in rec, `missing pair   in ${rec.pair}`);
      assert.ok('aSets'  in rec, `missing aSets  in ${rec.pair}`);
      assert.ok('bSets'  in rec, `missing bSets  in ${rec.pair}`);
      assert.ok('ratio'  in rec, `missing ratio  in ${rec.pair}`);
      assert.ok('status' in rec, `missing status in ${rec.pair}`);
      assert.ok('reason' in rec, `missing reason in ${rec.pair}`);
    }
  });

  it('status is always a valid value', () => {
    const valid = new Set(['balanced', 'worth_a_nudge', 'real_gap']);
    for (const rec of computeBalanceSignal([])) {
      assert.ok(valid.has(rec.status), `invalid status: ${rec.status}`);
    }
  });
});

// ─── empty / no-data ────────────────────────────────────────────────────────

describe('computeBalanceSignal — empty / no data', () => {
  it('empty array → all balanced, ratio null, aSets/bSets 0', () => {
    const result = computeBalanceSignal([]);
    for (const rec of result) {
      assert.strictEqual(rec.aSets,  0,      `aSets for ${rec.pair}`);
      assert.strictEqual(rec.bSets,  0,      `bSets for ${rec.pair}`);
      assert.strictEqual(rec.ratio,  null,   `ratio for ${rec.pair}`);
      assert.strictEqual(rec.status, 'balanced', `status for ${rec.pair}`);
    }
  });

  it('null logRows → all balanced (same as empty)', () => {
    // null is not an array — treats like empty
    const result = computeBalanceSignal(null);
    assert.strictEqual(result.length, 4);
    for (const rec of result) assert.strictEqual(rec.status, 'balanced');
  });

  it('rows all outside the window → all balanced', () => {
    // today: 2026-06-16, days: 7 → cutoff: 2026-06-09
    // row on 2026-06-01 is excluded
    const logRows = [row('2026-06-01', 'Bench Press')];
    const result = computeBalanceSignal(logRows, { today: '2026-06-16', days: 7 });
    const hp = pair(result, 'horizontal_push:horizontal_pull');
    assert.strictEqual(hp.aSets,  0);
    assert.strictEqual(hp.bSets,  0);
    assert.strictEqual(hp.status, 'balanced');
  });
});

// ─── horizontal push : horizontal pull ──────────────────────────────────────

describe('computeBalanceSignal — horizontal push:pull', () => {
  const TODAY = '2026-01-10';

  it('3 bench + 3 barbell row → balanced (ratio 1.00)', () => {
    const logRows = [
      ...rows(3, TODAY, 'Bench Press'),
      ...rows(3, TODAY, 'Barbell Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.aSets,  3);
    assert.strictEqual(rec.bSets,  3);
    assert.strictEqual(rec.ratio,  1);
    assert.strictEqual(rec.status, 'balanced');
  });

  it('5 bench + 3 row → worth_a_nudge (ratio 1.67)', () => {
    // 5/3 = 1.667 → outside 1.4 but < 2.0 → worth_a_nudge
    const logRows = [
      ...rows(5, TODAY, 'Bench Press'),
      ...rows(3, TODAY, 'Seated Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.aSets,  5);
    assert.strictEqual(rec.bSets,  3);
    assert.strictEqual(rec.ratio,  1.67);
    assert.strictEqual(rec.status, 'worth_a_nudge');
  });

  it('6 bench + 2 row → real_gap (ratio 3.00)', () => {
    const logRows = [
      ...rows(6, TODAY, 'Bench Press'),
      ...rows(2, TODAY, 'Barbell Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.aSets,  6);
    assert.strictEqual(rec.bSets,  2);
    assert.strictEqual(rec.ratio,  3);
    assert.strictEqual(rec.status, 'real_gap');
  });

  it('1 bench + 6 row → real_gap (ratio 0.17, pull-heavy)', () => {
    // ratio = 1/6 = 0.167 → ≤ 0.5 → real_gap
    const logRows = [
      ...rows(1, TODAY, 'Bench Press'),
      ...rows(3, TODAY, 'Barbell Row'),
      ...rows(3, TODAY, 'Seated Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.aSets,  1);
    assert.strictEqual(rec.bSets,  6);
    assert.strictEqual(rec.ratio,  0.17);
    assert.strictEqual(rec.status, 'real_gap');
  });

  it('push with zero pull → real_gap (ratio null, b-denominator 0)', () => {
    const logRows = rows(4, TODAY, 'Bench Press');
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.aSets,  4);
    assert.strictEqual(rec.bSets,  0);
    assert.strictEqual(rec.ratio,  null);
    assert.strictEqual(rec.status, 'real_gap');
  });

  it('counts Dips and Incline Press as horizontal push', () => {
    const logRows = [
      ...rows(2, TODAY, 'Dips'),
      ...rows(2, TODAY, 'Incline DB Press'),
      ...rows(4, TODAY, 'Seated Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.aSets, 4);  // dips + incline
    assert.strictEqual(rec.bSets, 4);  // seated row
    assert.strictEqual(rec.status, 'balanced');
  });
});

// ─── vertical push : vertical pull ──────────────────────────────────────────

describe('computeBalanceSignal — vertical push:pull', () => {
  const TODAY = '2026-02-01';

  it('3 OHP + 3 Lat Pulldown → balanced (ratio 1.00)', () => {
    const logRows = [
      ...rows(3, TODAY, 'Overhead Press'),
      ...rows(3, TODAY, 'Lat Pulldown'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'vertical_push:vertical_pull');
    assert.strictEqual(rec.aSets,  3);
    assert.strictEqual(rec.bSets,  3);
    assert.strictEqual(rec.ratio,  1);
    assert.strictEqual(rec.status, 'balanced');
  });

  it('3 OHP + 2 Lat Pulldown → worth_a_nudge (ratio 1.50)', () => {
    // 3/2 = 1.5 → outside 1.4, < 2.0 → worth_a_nudge
    const logRows = [
      ...rows(3, TODAY, 'OHP'),
      ...rows(2, TODAY, 'Lat Pulldown'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'vertical_push:vertical_pull');
    assert.strictEqual(rec.ratio,  1.5);
    assert.strictEqual(rec.status, 'worth_a_nudge');
  });

  it('3 OHP + 0 vertical pull → real_gap (ratio null)', () => {
    const logRows = rows(3, TODAY, 'Overhead Press');
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'vertical_push:vertical_pull');
    assert.strictEqual(rec.aSets,  3);
    assert.strictEqual(rec.bSets,  0);
    assert.strictEqual(rec.ratio,  null);
    assert.strictEqual(rec.status, 'real_gap');
  });

  it('Pull-up counts as vertical pull', () => {
    const logRows = [
      ...rows(3, TODAY, 'OHP'),
      ...rows(3, TODAY, 'Pull-Up'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'vertical_push:vertical_pull');
    assert.strictEqual(rec.aSets, 3);
    assert.strictEqual(rec.bSets, 3);
    assert.strictEqual(rec.status, 'balanced');
  });
});

// ─── anterior : posterior ───────────────────────────────────────────────────

describe('computeBalanceSignal — anterior:posterior', () => {
  const TODAY = '2026-03-01';

  it('3 bench + 3 barbell row → balanced (1.00)', () => {
    // anterior = horizontal_push = 3; posterior = horizontal_pull = 3
    const logRows = [
      ...rows(3, TODAY, 'Bench Press'),
      ...rows(3, TODAY, 'Barbell Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'anterior:posterior');
    assert.strictEqual(rec.aSets,  3);
    assert.strictEqual(rec.bSets,  3);
    assert.strictEqual(rec.ratio,  1);
    assert.strictEqual(rec.status, 'balanced');
  });

  it('3 bench + 3 OHP vs 4 row + 3 deadlift → balanced (6/7 = 0.86)', () => {
    // anterior = horizontal_push(3) + vertical_push(3) + squat(0) = 6
    // posterior = hinge(3) + horizontal_pull(4) + vertical_pull(0) = 7
    // ratio = 6/7 = 0.86 → within [0.75, 1.4] → balanced
    const logRows = [
      ...rows(3, TODAY, 'Bench Press'),
      ...rows(3, TODAY, 'OHP'),
      ...rows(4, TODAY, 'Barbell Row'),
      ...rows(3, TODAY, 'Deadlift'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'anterior:posterior');
    assert.strictEqual(rec.aSets,  6);
    assert.strictEqual(rec.bSets,  7);
    assert.strictEqual(rec.ratio,  0.86);
    assert.strictEqual(rec.status, 'balanced');
  });

  it('anterior-only session → real_gap', () => {
    // 6 push, 0 posterior → real_gap
    const logRows = [
      ...rows(3, TODAY, 'Bench Press'),
      ...rows(3, TODAY, 'Overhead Press'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'anterior:posterior');
    assert.strictEqual(rec.aSets,  6);
    assert.strictEqual(rec.bSets,  0);
    assert.strictEqual(rec.status, 'real_gap');
  });

  it('squat counts toward anterior', () => {
    // 3 squat → anterior += 3
    const logRows = [
      ...rows(3, TODAY, 'Back Squat'),
      ...rows(3, TODAY, 'Deadlift'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'anterior:posterior');
    assert.strictEqual(rec.aSets, 3);  // squat = anterior
    assert.strictEqual(rec.bSets, 3);  // deadlift = posterior (hinge)
    assert.strictEqual(rec.status, 'balanced');
  });

  it('3 bench + 2 OHP vs 3 row → worth_a_nudge (5/3 = 1.67)', () => {
    // anterior = 3 + 2 = 5; posterior = 3; ratio = 1.67 → worth_a_nudge
    const logRows = [
      ...rows(3, TODAY, 'Bench Press'),
      ...rows(2, TODAY, 'OHP'),
      ...rows(3, TODAY, 'Barbell Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'anterior:posterior');
    assert.strictEqual(rec.aSets,  5);
    assert.strictEqual(rec.bSets,  3);
    assert.strictEqual(rec.ratio,  1.67);
    assert.strictEqual(rec.status, 'worth_a_nudge');
  });
});

// ─── quad : hamstring ────────────────────────────────────────────────────────

describe('computeBalanceSignal — quad:hamstring', () => {
  const TODAY = '2026-04-01';

  it('4 squat + 2 leg curl → balanced (4.0 vs 4.0, ratio 1.00)', () => {
    // Squat: quads=1.0, hamstrings=0.5 → 4 sets: quads=4.0, hamstrings=2.0
    // Leg Curl: hamstrings=1.0 → 2 sets: hamstrings+=2.0 → total=4.0
    // ratio = 4.0 / 4.0 = 1.0 → balanced
    const logRows = [
      ...rows(4, TODAY, 'Back Squat'),
      ...rows(2, TODAY, 'Leg Curl'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'quad:hamstring');
    assert.strictEqual(rec.aSets,  4);
    assert.strictEqual(rec.bSets,  4);
    assert.strictEqual(rec.ratio,  1);
    assert.strictEqual(rec.status, 'balanced');
  });

  it('5 squat + 1 leg curl → worth_a_nudge (5.0 vs 3.5, ratio 1.43)', () => {
    // Squat x5: quads=5.0, hamstrings=2.5
    // Leg Curl x1: hamstrings+=1.0 → total=3.5
    // ratio = 5.0/3.5 = 1.43 → outside 1.4 but < 2.0 → worth_a_nudge
    const logRows = [
      ...rows(5, TODAY, 'Back Squat'),
      ...rows(1, TODAY, 'Leg Curl'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'quad:hamstring');
    assert.strictEqual(rec.aSets,  5);
    assert.strictEqual(rec.bSets,  3.5);
    assert.strictEqual(rec.ratio,  1.43);
    assert.strictEqual(rec.status, 'worth_a_nudge');
  });

  it('6 leg extension (quad-only) → real_gap (6.0 vs 0, ratio null)', () => {
    // Leg Extension: quads only, no hamstring credit
    const logRows = rows(6, TODAY, 'Leg Extension');
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'quad:hamstring');
    assert.strictEqual(rec.aSets,  6);
    assert.strictEqual(rec.bSets,  0);
    assert.strictEqual(rec.ratio,  null);
    assert.strictEqual(rec.status, 'real_gap');
  });

  it('3 RDL + 3 leg curl (hamstring-heavy) → real_gap (0 vs 4.5)', () => {
    // RDL x3: hamstrings=1.0 each → 3.0; glutes=1.0 each; lower_back secondary
    // Leg Curl x3: hamstrings=1.0 each → 3.0
    // quads: 0 from RDL, 0 from leg curl → 0
    // hamstrings: 3.0 + 3.0 = 6.0
    // ratio = 0/6 → 0 → real_gap
    const logRows = [
      ...rows(3, TODAY, 'Romanian Deadlift'),
      ...rows(3, TODAY, 'Leg Curl'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'quad:hamstring');
    assert.strictEqual(rec.aSets,  0);
    assert.strictEqual(rec.bSets,  6);
    assert.strictEqual(rec.ratio,  0);
    assert.strictEqual(rec.status, 'real_gap');
  });
});

// ─── rolling window ──────────────────────────────────────────────────────────

describe('computeBalanceSignal — rolling window', () => {
  it('rows before cutoff are excluded', () => {
    // today 2026-06-16, days 7 → cutoff 2026-06-09
    // Jun 01 is before cutoff → excluded; Jun 09 is on cutoff → included
    const logRows = [
      row('2026-06-01', 'Bench Press'),   // excluded (< cutoff)
      row('2026-06-09', 'Bench Press'),   // included (= cutoff)
      row('2026-06-16', 'Barbell Row'),   // included
    ];
    const result = computeBalanceSignal(logRows, { today: '2026-06-16', days: 7 });
    const hp = pair(result, 'horizontal_push:horizontal_pull');
    assert.strictEqual(hp.aSets, 1);  // only Jun-09 bench
    assert.strictEqual(hp.bSets, 1);  // Jun-16 row
  });

  it('rows after anchor are excluded when today is provided', () => {
    const logRows = [
      row('2026-06-15', 'Bench Press'),  // in window
      row('2026-06-17', 'Bench Press'),  // after anchor (excluded)
    ];
    const result = computeBalanceSignal(logRows, { today: '2026-06-16', days: 7 });
    const hp = pair(result, 'horizontal_push:horizontal_pull');
    assert.strictEqual(hp.aSets, 1);   // only Jun-15
  });

  it('custom days window works', () => {
    const logRows = [
      row('2026-06-02', 'Bench Press'),  // 14 days back
      row('2026-06-12', 'Barbell Row'),  // 4 days back
    ];
    // days=7 → cutoff 2026-06-09 → Jun-02 excluded, Jun-12 included
    const result7 = computeBalanceSignal(logRows, { today: '2026-06-16', days: 7 });
    assert.strictEqual(pair(result7, 'horizontal_push:horizontal_pull').aSets, 0);
    assert.strictEqual(pair(result7, 'horizontal_push:horizontal_pull').bSets, 1);

    // days=14 → cutoff 2026-06-02 → Jun-02 included (= cutoff)
    const result14 = computeBalanceSignal(logRows, { today: '2026-06-16', days: 14 });
    assert.strictEqual(pair(result14, 'horizontal_push:horizontal_pull').aSets, 1);
    assert.strictEqual(pair(result14, 'horizontal_push:horizontal_pull').bSets, 1);
  });
});

// ─── unknown lifts excluded ──────────────────────────────────────────────────

describe('computeBalanceSignal — unknown/needsReview lifts', () => {
  const TODAY = '2026-05-01';

  it('unknown lift (needsReview) does not affect pattern counts', () => {
    const logRows = [
      row(TODAY, 'Bench Press'),       // horizontal_push = 1
      row(TODAY, 'Alien Probe X9000'), // needsReview → excluded
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.aSets,  1);
    assert.strictEqual(rec.bSets,  0);
    assert.strictEqual(rec.status, 'real_gap');
  });

  it('only unknown lifts → all balanced (no data)', () => {
    const logRows = [
      row(TODAY, 'Mystery Cable Contraption'),
      row(TODAY, 'Bulgarian Trapeze Machine'),
    ];
    const result = computeBalanceSignal(logRows, { today: TODAY });
    for (const rec of result) {
      assert.strictEqual(rec.aSets,  0);
      assert.strictEqual(rec.bSets,  0);
      assert.strictEqual(rec.status, 'balanced');
    }
  });
});

// ─── realistic snapshot ──────────────────────────────────────────────────────

describe('computeBalanceSignal — realistic balanced week', () => {
  // Push day: 3 Bench, 2 OHP, 3 Back Squat
  // Pull day: 3 Barbell Row, 2 Lat Pulldown, 2 Deadlift
  // All in window
  const logRows = [
    ...rows(3, '2026-06-13', 'Bench Press'),
    ...rows(2, '2026-06-13', 'Overhead Press'),
    ...rows(3, '2026-06-13', 'Back Squat'),
    ...rows(3, '2026-06-15', 'Barbell Row'),
    ...rows(2, '2026-06-15', 'Lat Pulldown'),
    ...rows(2, '2026-06-15', 'Deadlift'),
  ];
  const OPTS = { today: '2026-06-16', days: 7 };

  it('horizontal push:pull → balanced (3:3 = 1.00)', () => {
    const rec = pair(computeBalanceSignal(logRows, OPTS), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.aSets,  3);
    assert.strictEqual(rec.bSets,  3);
    assert.strictEqual(rec.ratio,  1);
    assert.strictEqual(rec.status, 'balanced');
  });

  it('vertical push:pull → balanced (2:2 = 1.00)', () => {
    const rec = pair(computeBalanceSignal(logRows, OPTS), 'vertical_push:vertical_pull');
    assert.strictEqual(rec.aSets,  2);
    assert.strictEqual(rec.bSets,  2);
    assert.strictEqual(rec.ratio,  1);
    assert.strictEqual(rec.status, 'balanced');
  });

  it('anterior:posterior → balanced (8:7 = 1.14)', () => {
    // anterior = horizontal_push(3) + vertical_push(2) + squat(3) = 8
    // posterior = hinge(2) + horizontal_pull(3) + vertical_pull(2) = 7
    // ratio = 8/7 = 1.14 → within [0.75, 1.4] → balanced
    const rec = pair(computeBalanceSignal(logRows, OPTS), 'anterior:posterior');
    assert.strictEqual(rec.aSets,  8);
    assert.strictEqual(rec.bSets,  7);
    assert.strictEqual(rec.ratio,  1.14);
    assert.strictEqual(rec.status, 'balanced');
  });

  it('quad:hamstring → balanced (3.0 vs 3.5 = 0.86)', () => {
    // Squat x3: quads=3.0, hamstrings=1.5 (secondary 0.5/set)
    // Barbell Row x3: no quad/hamstring credit (lats/upper_back primary)
    // Deadlift x2: hamstrings=2.0 (primary), quads=0
    // Lat Pulldown x2: no quad/hamstring credit
    // Bench Press x3, OHP x2: no quad/hamstring credit
    // quads: 3.0, hamstrings: 1.5 + 2.0 = 3.5
    // ratio = 3.0/3.5 = 0.86 → within [0.75, 1.4] → balanced
    const rec = pair(computeBalanceSignal(logRows, OPTS), 'quad:hamstring');
    assert.strictEqual(rec.aSets,  3);
    assert.strictEqual(rec.bSets,  3.5);
    assert.strictEqual(rec.ratio,  0.86);
    assert.strictEqual(rec.status, 'balanced');
  });
});

// ─── reason strings ──────────────────────────────────────────────────────────

describe('computeBalanceSignal — reason strings', () => {
  const TODAY = '2026-05-15';

  it('both-zero reason mentions "nothing to compare"', () => {
    const rec = pair(computeBalanceSignal([], { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.ok(rec.reason.includes('nothing to compare'), `reason: ${rec.reason}`);
  });

  it('balanced reason mentions "within the balanced range"', () => {
    const logRows = [
      ...rows(3, TODAY, 'Bench Press'),
      ...rows(3, TODAY, 'Barbell Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.status, 'balanced');
    assert.ok(rec.reason.includes('within the balanced range'), `reason: ${rec.reason}`);
  });

  it('worth_a_nudge reason mentions "slightly ahead" and "balance slot"', () => {
    const logRows = [
      ...rows(5, TODAY, 'Bench Press'),
      ...rows(3, TODAY, 'Barbell Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.status, 'worth_a_nudge');
    assert.ok(rec.reason.includes('slightly ahead'), `reason: ${rec.reason}`);
    assert.ok(rec.reason.includes('balance slot'), `reason: ${rec.reason}`);
  });

  it('real_gap reason mentions "significantly ahead" and "balance slot"', () => {
    const logRows = [
      ...rows(6, TODAY, 'Bench Press'),
      ...rows(2, TODAY, 'Barbell Row'),
    ];
    const rec = pair(computeBalanceSignal(logRows, { today: TODAY }), 'horizontal_push:horizontal_pull');
    assert.strictEqual(rec.status, 'real_gap');
    assert.ok(rec.reason.includes('significantly ahead'), `reason: ${rec.reason}`);
    assert.ok(rec.reason.includes('balance slot'), `reason: ${rec.reason}`);
  });
});
