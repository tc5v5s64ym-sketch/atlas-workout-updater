'use strict';

// PR3 — vision.js provider-dispatch + parse-pipeline contract tests.
//
// getProviderConfig / normalizeParsedMetrics / stripJsonFences / withVisionTimeout
// are already covered in test/vision.test.js. The still-uncovered surface is the
// orchestration in parseWorkoutScreenshot: which provider SDK it calls, how it
// shapes the image payload, how it extracts + parses the model's text into the
// 7-field contract, and — critically — that a provider failure propagates with
// NO silent fallback to the other provider (CLAUDE.md: provider selection is
// explicit, never a silent fallback).
//
// Approach: inject fake `openai` and `@google/genai` SDK modules into the require
// cache BEFORE loading the REAL vision.js, so the real dispatch/parse code runs
// against in-memory clients. No network, no real keys. Test-only — vision.js is
// not changed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- Fake OpenAI SDK (require('openai') returns the class directly) ----------
const openaiState = { constructed: 0, lastApiKey: null, lastParams: null, response: null, throw: null };
class FakeOpenAI {
  constructor({ apiKey }) { openaiState.constructed += 1; openaiState.lastApiKey = apiKey; }
  get responses() {
    return {
      create: async (params /* , opts */) => {
        openaiState.lastParams = params;
        if (openaiState.throw) throw openaiState.throw;
        return openaiState.response;
      }
    };
  }
}

// --- Fake @google/genai SDK ({ GoogleGenAI }) --------------------------------
const genaiState = { constructed: 0, lastApiKey: null, lastParams: null, response: null, throw: null };
class FakeGoogleGenAI {
  constructor({ apiKey }) { genaiState.constructed += 1; genaiState.lastApiKey = apiKey; }
  get models() {
    return {
      generateContent: async (params) => {
        genaiState.lastParams = params;
        if (genaiState.throw) throw genaiState.throw;
        return genaiState.response;
      }
    };
  }
}

const openaiPath = require.resolve('openai');
require.cache[openaiPath] = { id: openaiPath, filename: openaiPath, loaded: true, exports: FakeOpenAI };
const genaiPath = require.resolve('@google/genai');
require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: { GoogleGenAI: FakeGoogleGenAI } };

const vision = require('../services/vision');

// --- Env + temp-image helpers ------------------------------------------------
const PROVIDER_KEYS = ['ATLAS_LLM_PROVIDER', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ATLAS_LLM_MODEL'];
function withEnv(vars, fn) {
  const saved = {};
  for (const k of PROVIDER_KEYS) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of PROVIDER_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

const tmpFiles = [];
function makeImage(ext, bytes = 'fake-image-bytes') {
  const p = path.join(os.tmpdir(), `atlas-vision-${tmpFiles.length}-${ext.replace('.', '')}${ext}`);
  fs.writeFileSync(p, bytes);
  tmpFiles.push(p);
  return p;
}

test.beforeEach(() => {
  openaiState.constructed = 0; openaiState.lastApiKey = null; openaiState.lastParams = null;
  openaiState.response = null; openaiState.throw = null;
  genaiState.constructed = 0; genaiState.lastApiKey = null; genaiState.lastParams = null;
  genaiState.response = null; genaiState.throw = null;
});

test.after(() => { for (const p of tmpFiles) { try { fs.unlinkSync(p); } catch { /* ignore */ } } });

const FULL_JSON = JSON.stringify({
  date: '2026-06-29', duration: '45:00', activeCalories: 350, totalCalories: 420,
  averageHR: 145, peakHR: 178, workoutType: 'Strength Training'
});

// ---------------------------------------------------------------------------
// guard
// ---------------------------------------------------------------------------
test('parseWorkoutScreenshot throws when imagePath is missing', async () => {
  await assert.rejects(() => vision.parseWorkoutScreenshot(''), /imagePath is required/);
});

// ---------------------------------------------------------------------------
// OpenAI path
// ---------------------------------------------------------------------------
test('OpenAI: dispatches to OpenAI, sends a png data URL + model, returns the 7-field contract', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', ATLAS_LLM_MODEL: undefined }, async () => {
    openaiState.response = { output_text: FULL_JSON };
    const img = makeImage('.png');
    const out = await vision.parseWorkoutScreenshot(img);

    assert.equal(openaiState.constructed, 1);
    assert.equal(genaiState.constructed, 0, 'gemini SDK must not be touched on the openai path');
    assert.equal(openaiState.lastApiKey, 'sk-test');
    assert.equal(openaiState.lastParams.model, 'gpt-4.1-mini');
    const imageUrl = openaiState.lastParams.input[0].content[1].image_url;
    assert.ok(imageUrl.startsWith('data:image/png;base64,'), 'png mime in the data URL');
    assert.equal(out.status, 'image received');
    assert.deepEqual(out.parsed_metrics, {
      date: '2026-06-29', duration: '45:00', activeCalories: 350, totalCalories: 420,
      averageHR: 145, peakHR: 178, workoutType: 'Strength Training'
    });
  });
});

test('OpenAI: extracts text from the output[].content[] chunks when output_text is absent', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, async () => {
    openaiState.response = {
      output: [{ content: [{ type: 'output_text', text: FULL_JSON }] }]
    };
    const out = await vision.parseWorkoutScreenshot(makeImage('.png'));
    assert.equal(out.parsed_metrics.averageHR, 145);
  });
});

test('OpenAI: strips ```json fences before parsing', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, async () => {
    openaiState.response = { output_text: '```json\n' + FULL_JSON + '\n```' };
    const out = await vision.parseWorkoutScreenshot(makeImage('.png'));
    assert.equal(out.parsed_metrics.peakHR, 178);
  });
});

test('OpenAI: throws when the model returns no text output', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, async () => {
    openaiState.response = { output_text: '', output: [] };
    await assert.rejects(() => vision.parseWorkoutScreenshot(makeImage('.png')), /no text output/);
  });
});

test('OpenAI: throws a clear error when the response is not valid JSON', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, async () => {
    openaiState.response = { output_text: 'not json at all' };
    await assert.rejects(() => vision.parseWorkoutScreenshot(makeImage('.png')), /not valid JSON/);
  });
});

test('OpenAI: honors ATLAS_LLM_MODEL and the .jpg mime type', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', ATLAS_LLM_MODEL: 'gpt-4o-mini' }, async () => {
    openaiState.response = { output_text: FULL_JSON };
    await vision.parseWorkoutScreenshot(makeImage('.jpg'));
    assert.equal(openaiState.lastParams.model, 'gpt-4o-mini');
    assert.ok(openaiState.lastParams.input[0].content[1].image_url.startsWith('data:image/jpeg;base64,'));
  });
});

// ---------------------------------------------------------------------------
// Gemini path
// ---------------------------------------------------------------------------
test('Gemini: dispatches to Gemini with inline image data + model, returns the contract', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'gm-test', ATLAS_LLM_MODEL: undefined }, async () => {
    genaiState.response = { text: FULL_JSON };
    const out = await vision.parseWorkoutScreenshot(makeImage('.webp'));

    assert.equal(genaiState.constructed, 1);
    assert.equal(openaiState.constructed, 0, 'openai SDK must not be touched on the gemini path');
    assert.equal(genaiState.lastApiKey, 'gm-test');
    assert.equal(genaiState.lastParams.model, 'gemini-2.5-flash-lite');
    assert.equal(genaiState.lastParams.contents[0].inlineData.mimeType, 'image/webp');
    assert.equal(out.parsed_metrics.workoutType, 'Strength Training');
  });
});

test('Gemini: throws when Gemini returns no text', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'gm-test' }, async () => {
    genaiState.response = { text: '' };
    await assert.rejects(() => vision.parseWorkoutScreenshot(makeImage('.png')), /Gemini returned no text output/);
  });
});

test('Gemini: throws a clear error when the response is not valid JSON', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'gm-test' }, async () => {
    genaiState.response = { text: 'definitely not json' };
    await assert.rejects(() => vision.parseWorkoutScreenshot(makeImage('.png')), /Gemini response was not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// No silent fallback — a provider failure propagates; the other is never tried
// ---------------------------------------------------------------------------
test('a Gemini SDK failure propagates and never silently falls back to OpenAI', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'gm-test', OPENAI_API_KEY: 'sk-test' }, async () => {
    genaiState.throw = new Error('gemini 503 unavailable');
    await assert.rejects(() => vision.parseWorkoutScreenshot(makeImage('.png')), /gemini 503 unavailable/);
    assert.equal(openaiState.constructed, 0, 'must not fall back to OpenAI');
  });
});

test('an OpenAI SDK failure propagates and never silently falls back to Gemini', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'gm-test' }, async () => {
    openaiState.throw = new Error('openai 500 server error');
    await assert.rejects(() => vision.parseWorkoutScreenshot(makeImage('.png')), /openai 500 server error/);
    assert.equal(genaiState.constructed, 0, 'must not fall back to Gemini');
  });
});

// ---------------------------------------------------------------------------
// getMimeTypeFromPath fallback (exercised via the data URL)
// ---------------------------------------------------------------------------
test('an unknown image extension falls back to application/octet-stream', async () => {
  await withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, async () => {
    openaiState.response = { output_text: FULL_JSON };
    await vision.parseWorkoutScreenshot(makeImage('.bin'));
    assert.ok(openaiState.lastParams.input[0].content[1].image_url.startsWith('data:application/octet-stream;base64,'));
  });
});
