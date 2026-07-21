'use strict';

// Unit coverage for the Q&A shadow helper's pure parts: normalizing the two Q&A response
// shapes (/api/coach/chat uses data.message; /api/coach/ask uses data.answer) into one
// capture envelope, and the TRUTHFUL response-derived model-stage status (the LLM only
// demonstrably ran when the answer came back tagged source 'gemini').

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const qa = require('../services/coachQaShadow');

describe('coachQaShadow (pure)', () => {
  it('normalizes a /api/coach/chat envelope (data.message)', () => {
    const v = qa._normalizeVisible({ data: { message: 'Because at RIR 1 that set is near failure.', source: 'gemini', configured: true } });
    assert.equal(v.data.message, 'Because at RIR 1 that set is near failure.');
    assert.equal(v.data.source, 'gemini');
    assert.equal(v.data.configured, true);
  });

  it('normalizes a /api/coach/ask envelope (data.answer → message)', () => {
    const v = qa._normalizeVisible({ data: { answer: 'RIR means reps in reserve.', source: 'training_sme', depth: 'explain' } });
    assert.equal(v.data.message, 'RIR means reps in reserve.');
    assert.equal(v.data.source, 'training_sme');
  });

  it('normalizes an absent answer/message to null (silence represented, not invented)', () => {
    const v = qa._normalizeVisible({ data: { answer: null, depth: 'log_only', source: 'training_sme' } });
    assert.equal(v.data.message, null);
  });

  it('derives model_response truthfully — ok only when the LLM demonstrably answered', () => {
    assert.equal(qa._deriveModelStatus('gemini'), 'ok');
    assert.equal(qa._deriveModelStatus('engine'), 'skipped');
    assert.equal(qa._deriveModelStatus('training_sme'), 'skipped');
    assert.equal(qa._deriveModelStatus(null), 'skipped');
    assert.equal(qa._deriveModelStatus(undefined), 'skipped');
  });
});
