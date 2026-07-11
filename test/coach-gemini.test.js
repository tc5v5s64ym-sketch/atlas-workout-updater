'use strict';

// Coverage follow-up — coach.js Gemini network path + degradation.
//
// The existing coach.test.js covers the pure sanitize/prompt builders but never
// exercises the actual Gemini call path (callGeminiContents and the generate*
// wrappers), because it doesn't stub `fetch`. coach.js calls the global `fetch`
// directly, so this file stubs it to drive the real call/parse/error paths with
// no network:
//   - success (text returned), non-OK status, empty-output → the three
//     callGeminiContents outcomes
//   - the unconfigured guard (no GEMINI_API_KEY) throws before any fetch
//
// Tests assert CURRENT behaviour; coach.js is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const coach = require('../services/coach');

const realFetch = global.fetch;
let fetchCalls = [];

// Install a fetch stub whose response is produced by `responder(url, opts)`.
function setFetch(responder) {
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return responder(url, opts);
  };
}

// A successful Gemini generateContent response carrying `text`.
function okResponse(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    text: async () => ''
  };
}

test.beforeEach(() => {
  fetchCalls = [];
  process.env.GEMINI_API_KEY = 'gm-test-key';
});

test.afterEach(() => {
  global.fetch = realFetch;
  delete process.env.GEMINI_API_KEY;
});

// ---------------------------------------------------------------------------
// Success paths — callGeminiContents + the generate* wrappers
// ---------------------------------------------------------------------------
test('generateCoachMessage returns the model text and calls Gemini with the api key header', async () => {
  setFetch(() => okResponse('Strong work today.'));
  const out = await coach.generateCoachMessage({});
  assert.equal(out, 'Strong work today.');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /:generateContent$/);
  assert.equal(fetchCalls[0].opts.headers['x-goog-api-key'], 'gm-test-key');
  assert.equal(fetchCalls[0].opts.method, 'POST');
});

test('generatePlanMessage returns the model text', async () => {
  setFetch(() => okResponse('Push day today because your pressing is fresh.'));
  assert.equal(await coach.generatePlanMessage({}), 'Push day today because your pressing is fresh.');
});

test('pingGemini returns the probe text on a healthy model', async () => {
  setFetch(() => okResponse('OK'));
  assert.equal(await coach.pingGemini(), 'OK');
});

test('generateChatReply returns parsed prose with null proposals for a plain reply', async () => {
  setFetch(() => okResponse('Focus on sleep and keep RIR honest.'));
  const r = await coach.generateChatReply({ message: 'How am I doing?', context: {}, history: [] });
  assert.equal(r.reply, 'Focus on sleep and keep RIR honest.');
  assert.equal(r.propose_edit, null);
  assert.equal(r.propose_note, null);
  assert.equal(r.propose_constraint, null);
});

test('generateChatReply rejects an empty message before any network call', async () => {
  setFetch(() => okResponse('unused'));
  await assert.rejects(() => coach.generateChatReply({ message: '   ' }), /chat message is required/);
  assert.equal(fetchCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Failure / degradation paths
// ---------------------------------------------------------------------------
test('callGemini path throws (before any fetch) when GEMINI_API_KEY is not configured', async () => {
  delete process.env.GEMINI_API_KEY;
  setFetch(() => okResponse('unused'));
  await assert.rejects(() => coach.generateCoachMessage({}), /GEMINI_API_KEY is not configured/);
  assert.equal(fetchCalls.length, 0);
});

test('a non-OK Gemini response throws a status-bearing error', async () => {
  setFetch(() => ({ ok: false, status: 500, text: async () => 'backend error' }));
  await assert.rejects(() => coach.generateCoachMessage({}), /Gemini request failed \(500\)/);
});

test('an empty-output Gemini response throws "no text output"', async () => {
  setFetch(() => ({ ok: true, status: 200, json: async () => ({ candidates: [] }), text: async () => '' }));
  await assert.rejects(() => coach.generateCoachMessage({}), /no text output/);
});
