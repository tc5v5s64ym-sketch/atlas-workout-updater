'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifyScenario, SCENARIOS } = require('../services/scenarioClassifier');
const { getAllScenarioIds } = require('../services/progressionRulesModule');

// liftState fixture with a given e1RM trend.
function lift(trend, sessionsTracked = 5) {
  return { e1rm: { trend, sessionsTracked }, pr: {}, staleness: {} };
}

// ─── drift guard: our scenario ids match the rules config ────────────────────

describe('scenarioClassifier — scenario id alignment', () => {
  it('every SCENARIOS value is a real progression scenario id', () => {
    const valid = new Set(getAllScenarioIds());
    for (const id of Object.values(SCENARIOS)) {
      assert.ok(valid.has(id), `scenario_id '${id}' not in progression.rules.json`);
    }
  });
  it('SCENARIOS covers all six rules scenarios (no gap)', () => {
    assert.deepEqual(new Set(Object.values(SCENARIOS)), new Set(getAllScenarioIds()));
  });
});

// ─── guards / insufficient input ─────────────────────────────────────────────

describe('scenarioClassifier — guards', () => {
  it('returns null for null/garbage params', () => {
    assert.strictEqual(classifyScenario(null), null);
    assert.strictEqual(classifyScenario('x'), null);
    assert.strictEqual(classifyScenario({}), null);
  });
  it('returns null when trend is insufficient_data and no injury', () => {
    assert.strictEqual(classifyScenario({ liftState: lift('insufficient_data', 1) }), null);
  });
  it('returns null when sessionsTracked < 2', () => {
    assert.strictEqual(classifyScenario({ liftState: lift('improving', 1) }), null);
  });
  it('never throws on odd input', () => {
    assert.doesNotThrow(() => classifyScenario({ liftState: { e1rm: null } }));
    assert.doesNotThrow(() => classifyScenario({ injury: 42 }));
  });
});

// ─── each scenario branch ────────────────────────────────────────────────────

describe('scenarioClassifier — branches', () => {
  it('injury → injury_signal (even without a trend)', () => {
    const r = classifyScenario({ injury: 'shoulder' });
    assert.strictEqual(r.scenario_id, SCENARIOS.INJURY_SIGNAL);
    assert.ok(r.rationale.includes('shoulder'));
  });
  it('plateau → candidate_plateau', () => {
    const r = classifyScenario({ liftState: lift('stalling'), plateau: { sessions_stalled: 3 } });
    assert.strictEqual(r.scenario_id, SCENARIOS.CANDIDATE_PLATEAU);
  });
  it('readiness low → likely_fatigue', () => {
    const r = classifyScenario({ liftState: lift('improving'), readiness: { tier: 'low' } });
    assert.strictEqual(r.scenario_id, SCENARIOS.LIKELY_FATIGUE);
  });
  it('trend declining → likely_fatigue', () => {
    const r = classifyScenario({ liftState: lift('declining') });
    assert.strictEqual(r.scenario_id, SCENARIOS.LIKELY_FATIGUE);
  });
  it('overperforming → underloaded', () => {
    const r = classifyScenario({ liftState: lift('improving'), overperforming: true });
    assert.strictEqual(r.scenario_id, SCENARIOS.UNDERLOADED);
  });
  it('trend improving → on_target', () => {
    const r = classifyScenario({ liftState: lift('improving') });
    assert.strictEqual(r.scenario_id, SCENARIOS.ON_TARGET);
  });
  it('trend stalling → normal_variability', () => {
    const r = classifyScenario({ liftState: lift('stalling') });
    assert.strictEqual(r.scenario_id, SCENARIOS.NORMAL_VARIABILITY);
  });
  it('every result carries a non-empty rationale', () => {
    for (const p of [
      { injury: 'knee' },
      { liftState: lift('stalling'), plateau: {} },
      { liftState: lift('declining') },
      { liftState: lift('improving'), overperforming: true },
      { liftState: lift('improving') },
      { liftState: lift('stalling') },
    ]) {
      const r = classifyScenario(p);
      assert.ok(r && typeof r.rationale === 'string' && r.rationale.length > 0);
    }
  });
});

// ─── precedence ──────────────────────────────────────────────────────────────

describe('scenarioClassifier — safety-first precedence', () => {
  it('injury beats plateau', () => {
    const r = classifyScenario({ injury: 'knee', liftState: lift('stalling'), plateau: {} });
    assert.strictEqual(r.scenario_id, SCENARIOS.INJURY_SIGNAL);
  });
  it('plateau beats low readiness', () => {
    const r = classifyScenario({ liftState: lift('improving'), plateau: {}, readiness: { tier: 'low' } });
    assert.strictEqual(r.scenario_id, SCENARIOS.CANDIDATE_PLATEAU);
  });
  it('low readiness beats an improving trend', () => {
    const r = classifyScenario({ liftState: lift('improving'), readiness: { tier: 'low' } });
    assert.strictEqual(r.scenario_id, SCENARIOS.LIKELY_FATIGUE);
  });
  it('declining fatigue beats overperforming (fatigue is the safer read)', () => {
    const r = classifyScenario({ liftState: lift('declining'), overperforming: true });
    assert.strictEqual(r.scenario_id, SCENARIOS.LIKELY_FATIGUE);
  });
});

// ─── feeds progressionModule ─────────────────────────────────────────────────

describe('scenarioClassifier — output drives progressionModule', () => {
  it('every produced scenario_id is accepted by progressionModule.recommendProgression', () => {
    const { recommendProgression } = require('../services/progressionModule');
    const ctx = { currentWeight: 185, currentReps: 5, currentRIR: 2, bodyRegion: 'upper_body' };
    for (const p of [
      { injury: 'shoulder' },
      { liftState: lift('stalling'), plateau: {} },
      { liftState: lift('declining') },
      { liftState: lift('improving'), overperforming: true },
      { liftState: lift('improving') },
      { liftState: lift('stalling') },
    ]) {
      const { scenario_id } = classifyScenario(p);
      const rec = recommendProgression(scenario_id, ctx);
      assert.ok(rec && rec.scenarioId === scenario_id, `progressionModule rejected '${scenario_id}'`);
    }
  });
});
