'use strict';

// #1773 (Astra C-04) — unit probes for the deload overlay choke point
// (services/deloadOverlay.js): numbers AND prose apply together or not at
// all, and the prose is rendered only from the final decision.

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyDeloadOverlay, deloadOverlayText } = require('../services/deloadOverlay');
const { STRENGTH_DELOAD_V1, HYPERTROPHY_DELOAD_V1 } = require('../services/deloadProtocols');

// A stale-style legacy recommendation: the pre-overlay decision says 185 x 8.
function staleRecommendation() {
  return {
    recommendation: 'Repeat 185 × 8 to reconfirm this lift.',
    reasoning: 'Based on your last session, 14 days ago — too long a gap to assume progression. Repeat the last working weight and see where you are before adding load.',
    next_target: { weight: 185, reps: 8, sets: 3 },
    target_rir: 2,
    days_since_last_session: 14,
  };
}

function activeDeload(protocol = STRENGTH_DELOAD_V1) {
  return { in_deload: true, training_state: 'DELOAD_ACTIVE', protocol, protocol_id: protocol.id };
}

test('#1773 overlay applies numbers + prose together from the final decision', () => {
  const rec = staleRecommendation();
  assert.equal(applyDeloadOverlay(rec, activeDeload()), true);
  assert.equal(rec.next_target.weight, 170, '185 x 0.92 -> 170');
  assert.equal(rec.next_target.reps, 8, 'reps untouched by the overlay');
  assert.equal(rec.target_rir, 5, 'protocol RIR');
  assert.equal(rec.recommendation, 'Deload — 170 × 8 at RIR 5.');
  assert.match(rec.reasoning, /Active deload/);
  assert.match(rec.reasoning, /170 lb at RIR 5/);
  assert.match(rec.reasoning, /Last trained 14 days ago\./, 'the layoff fact survives — it is still true');
  assert.doesNotMatch(rec.recommendation, /\b185\b/, 'no stale load in the prose');
  assert.doesNotMatch(rec.reasoning, /\b185\b/, 'no stale load in the reasoning');
});

test('#1773 overlay scales the anchored decision, not the logged load (just-logged A: 190 -> 175)', () => {
  const rec = {
    recommendation: 'Room to progress — move to 190 × 8 next set.',
    reasoning: 'RIR 5 is well above the 2 target — you left 5 in reserve, so a 5 lb step up is warranted.',
    next_target: { weight: 190, reps: 8, sets: 3 },
    target_rir: 2,
    days_since_last_session: 2,
  };
  assert.equal(applyDeloadOverlay(rec, activeDeload()), true);
  assert.equal(rec.next_target.weight, 175, '190 x 0.92 = 174.8 -> 175');
  assert.equal(rec.recommendation, 'Deload — 175 × 8 at RIR 5.');
  assert.doesNotMatch(rec.recommendation, /\b190\b/);
  assert.doesNotMatch(rec.reasoning, /\b190\b/);
});

test('#1773 overlay honors every protocol (hypertrophy 185 -> 155, RIR 5)', () => {
  const rec = staleRecommendation();
  assert.equal(applyDeloadOverlay(rec, activeDeload(HYPERTROPHY_DELOAD_V1)), true);
  assert.equal(rec.next_target.weight, 155, '185 x 0.85 = 157.25 -> 155');
  assert.equal(rec.target_rir, 5);
  assert.equal(rec.recommendation, 'Deload — 155 × 8 at RIR 5.');
});

test('#1773 no overlay, no change: deload missing / inactive / protocol missing', () => {
  for (const deload of [null, undefined, {}, { in_deload: false, protocol: STRENGTH_DELOAD_V1 }, { in_deload: true }, { in_deload: true, protocol: null }]) {
    const rec = staleRecommendation();
    const before = JSON.stringify(rec);
    assert.equal(applyDeloadOverlay(rec, deload), false);
    assert.equal(JSON.stringify(rec), before, 'recommendation must be byte-identical when no overlay applies');
  }
  const before = JSON.stringify(staleRecommendation());
  assert.equal(applyDeloadOverlay(null, activeDeload()), false);
  assert.equal(applyDeloadOverlay('nope', activeDeload()), false);
  assert.equal(before, JSON.stringify(staleRecommendation()));
});

test('#1773 no overlay, no change: no next_target', () => {
  const rec = { recommendation: 'No recent working sets found for this lift code.', reasoning: 'There is not enough history.', next_target: null, target_rir: null };
  const before = JSON.stringify(rec);
  assert.equal(applyDeloadOverlay(rec, activeDeload()), false);
  assert.equal(JSON.stringify(rec), before);
});

test('#1773 no overlay, no change: bodyweight (no usable working weight)', () => {
  const rec = {
    recommendation: 'Repeat 8 reps to reconfirm this lift.',
    reasoning: 'Bodyweight progression.',
    next_target: { weight: 0, reps: 8, sets: 3 },
    target_rir: 2,
    days_since_last_session: 14,
  };
  const before = JSON.stringify(rec);
  assert.equal(applyDeloadOverlay(rec, activeDeload()), false);
  assert.equal(JSON.stringify(rec), before);
});

test('#1773 prose never renders undefined: reps missing falls back to weight-only prose', () => {
  const rec = staleRecommendation();
  delete rec.next_target.reps;
  assert.equal(applyDeloadOverlay(rec, activeDeload()), true);
  assert.equal(rec.recommendation, 'Deload — 170 at RIR 5.');
  assert.doesNotMatch(rec.recommendation, /undefined/);
  assert.doesNotMatch(rec.reasoning, /undefined/);
});

test('#1773 prose never renders undefined: days absent drops the layoff clause', () => {
  const rec = staleRecommendation();
  delete rec.days_since_last_session;
  assert.equal(applyDeloadOverlay(rec, activeDeload()), true);
  assert.equal(rec.recommendation, 'Deload — 170 × 8 at RIR 5.');
  assert.doesNotMatch(rec.reasoning, /Last trained/);
  assert.doesNotMatch(rec.reasoning, /undefined/);
});

test('#1773 prose never invents a layoff: days null (no history) drops the clause', () => {
  const rec = staleRecommendation();
  rec.days_since_last_session = null;
  assert.equal(applyDeloadOverlay(rec, activeDeload()), true);
  assert.doesNotMatch(rec.reasoning, /Last trained/);
  assert.doesNotMatch(rec.reasoning, /0 days ago/);
});

test('#1773 layoff clause: trained today reads "today", not "0 days ago"', () => {
  const text = deloadOverlayText(STRENGTH_DELOAD_V1, { weight: 170, reps: 8, targetRir: 5, daysSinceLastSession: 0 });
  assert.match(text.reasoning, /Last trained today\./);
  assert.doesNotMatch(text.reasoning, /0 days ago/);
});

test('#1773 deloadOverlayText is pure and renders only from its inputs', () => {
  const text = deloadOverlayText(STRENGTH_DELOAD_V1, { weight: 170, reps: 8, targetRir: 5, daysSinceLastSession: 14 });
  assert.equal(text.recommendation, 'Deload — 170 × 8 at RIR 5.');
  assert.equal(
    text.reasoning,
    'Active deload — Reduce fatigue while preserving strength skill. Load cut to 170 lb at RIR 5. Return immediately to the previous working weight. Last trained 14 days ago.'
  );
  // A protocol without purpose/exit still renders honest prose from the numbers.
  const bare = deloadOverlayText({ id: 'CUSTOM' }, { weight: 100, reps: 5, targetRir: 4 });
  assert.equal(bare.recommendation, 'Deload — 100 × 5 at RIR 4.');
  assert.equal(bare.reasoning, 'Active deload — Load cut to 100 lb at RIR 4.');
});
