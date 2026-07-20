'use strict';

// Drift Guard 1 — AUTHORITY CONSISTENCY (Phase 2).
// The single canonical active-campaign marker must be present + consistent across
// CLAUDE.md, the execution plan, and the docs index, and both CLAUDE.md and the
// docs index must name the plan as the sole authority. Part A (offline).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  analyze,
  CAMPAIGN_MARKER,
  PLAN_PATH,
  AUTHORITY_DOCS,
} = require('../scripts/check-authority-consistency');

// A minimal set of doc contents that satisfies the guard, for drift tests.
function goodDocs() {
  return {
    'CLAUDE.md': `The sole active execution campaign is ${PLAN_PATH}. ${CAMPAIGN_MARKER} is the current owner insertion; the plan remains the sole work-selection authority.`,
    [PLAN_PATH]: `This is the single active campaign. ${CAMPAIGN_MARKER} embedded here.`,
    'docs/DOCS_INDEX.md': `${PLAN_PATH} — the sole active execution queue and work-selection authority. It carries the ${CAMPAIGN_MARKER}.`,
  };
}
const readerFor = (docs) => (rel) => {
  if (!(rel in docs)) throw new Error('ENOENT');
  return docs[rel];
};

describe('Drift Guard 1 — authority consistency', () => {
  it('passes on the real repository (the three authority docs agree)', () => {
    const r = analyze();
    assert.equal(r.valid, true, r.errors.join(' | '));
  });

  it('passes on a well-formed synthetic set', () => {
    assert.equal(analyze(readerFor(goodDocs())).valid, true);
  });

  it('fails if any authority doc drops the canonical campaign marker', () => {
    for (const f of AUTHORITY_DOCS) {
      const docs = goodDocs();
      docs[f] = docs[f].split(CAMPAIGN_MARKER).join('some OTHER campaign');
      const r = analyze(readerFor(docs));
      assert.equal(r.valid, false, `dropping the marker from ${f} must fail`);
      assert.ok(r.errors.some((e) => e.startsWith(f)), `error names ${f}`);
    }
  });

  it('fails if CLAUDE.md or the docs index stops naming the plan as the sole authority', () => {
    const noPath = goodDocs(); noPath['docs/DOCS_INDEX.md'] = noPath['docs/DOCS_INDEX.md'].split(PLAN_PATH).join('some/other/plan.md');
    assert.equal(analyze(readerFor(noPath)).valid, false);
    const noSole = goodDocs(); noSole['CLAUDE.md'] = `${PLAN_PATH} ${CAMPAIGN_MARKER} — the plan.`; // drops "sole … authority"
    assert.equal(analyze(readerFor(noSole)).valid, false);
  });

  it('fails closed on an unreadable authority doc', () => {
    const docs = goodDocs(); delete docs['CLAUDE.md'];
    assert.equal(analyze(readerFor(docs)).valid, false);
  });
});
