const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkoutScreenshotPrompt, getProviderConfig, normalizeParsedMetrics, stripJsonFences, withVisionTimeout, VISION_TIMEOUT_MS } = require('../services/vision');

// ---------------------------------------------------------------------------
// Prompt content tests (unchanged behaviour)
// ---------------------------------------------------------------------------

test('vision prompt maps averageHR to average labels only', () => {
  const prompt = buildWorkoutScreenshotPrompt();

  assert.match(prompt, /"Avg HR"/);
  assert.match(prompt, /"Average HR"/);
  assert.match(prompt, /"Avg Heart Rate"/);
  assert.match(prompt, /averageHR: use only the value next to labels like/);
  assert.doesNotMatch(
    prompt.match(/- averageHR:[^\n]*/)?.[0] ?? '',
    /Max HR|Peak HR|Maximum HR/
  );
});

test('vision prompt maps peakHR to max or peak labels or highest visible HR', () => {
  const prompt = buildWorkoutScreenshotPrompt();

  assert.match(prompt, /"Max HR"/);
  assert.match(prompt, /"Maximum HR"/);
  assert.match(prompt, /"Peak HR"/);
  assert.match(prompt, /"Peak Heart Rate"/);
  assert.match(prompt, /highest visible heart-rate value/);
});

test('vision prompt keeps averageHR and peakHR separate', () => {
  const prompt = buildWorkoutScreenshotPrompt();

  assert.match(prompt, /Do not confuse them/);
  assert.match(prompt, /do not copy one into the other/);
  assert.match(prompt, /return peakHR: null/);
});

// ---------------------------------------------------------------------------
// Provider config — helper that saves/restores env around each test
// ---------------------------------------------------------------------------

const PROVIDER_KEYS = ['ATLAS_LLM_PROVIDER', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ATLAS_LLM_MODEL'];

function withEnv(vars, fn) {
  const saved = {};
  for (const k of PROVIDER_KEYS) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return fn();
  } finally {
    for (const k of PROVIDER_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('provider: no ATLAS_LLM_PROVIDER defaults to openai', () => {
  withEnv({ ATLAS_LLM_PROVIDER: undefined, OPENAI_API_KEY: 'sk-test' }, () => {
    const config = getProviderConfig();
    assert.equal(config.provider, 'openai');
    assert.equal(config.apiKey, 'sk-test');
  });
});

test('provider: ATLAS_LLM_PROVIDER=openai uses openai', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, () => {
    const config = getProviderConfig();
    assert.equal(config.provider, 'openai');
  });
});

test('provider: ATLAS_LLM_PROVIDER is case-insensitive', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'OpenAI', OPENAI_API_KEY: 'sk-test' }, () => {
    const config = getProviderConfig();
    assert.equal(config.provider, 'openai');
  });
});

test('provider: ATLAS_LLM_PROVIDER=gemini with key returns gemini config', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'gm-test', ATLAS_LLM_MODEL: undefined }, () => {
    const config = getProviderConfig();
    assert.equal(config.provider, 'gemini');
    assert.equal(config.apiKey, 'gm-test');
    assert.equal(config.model, 'gemini-2.5-flash-lite');
  });
});

test('provider: default gemini model is gemini-2.5-flash-lite', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'gm-test', ATLAS_LLM_MODEL: undefined }, () => {
    const config = getProviderConfig();
    assert.equal(config.model, 'gemini-2.5-flash-lite');
  });
});

test('provider: ATLAS_LLM_MODEL overrides the default gemini model', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'gm-test', ATLAS_LLM_MODEL: 'gemini-custom' }, () => {
    const config = getProviderConfig();
    assert.equal(config.model, 'gemini-custom');
  });
});

// ME-10: the OpenAI path must honor ATLAS_LLM_MODEL (was hardcoded to gpt-4.1-mini).
test('provider: openai default model is gpt-4.1-mini', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', ATLAS_LLM_MODEL: undefined }, () => {
    const config = getProviderConfig();
    assert.equal(config.provider, 'openai');
    assert.equal(config.model, 'gpt-4.1-mini');
  });
});

test('provider: ATLAS_LLM_MODEL overrides the default openai model (ME-10)', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', ATLAS_LLM_MODEL: 'gpt-4o-mini' }, () => {
    const config = getProviderConfig();
    assert.equal(config.model, 'gpt-4o-mini');
  });
});

test('provider: ATLAS_LLM_PROVIDER=gemini without GEMINI_API_KEY throws', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: undefined }, () => {
    assert.throws(
      () => getProviderConfig(),
      (err) => {
        assert.match(err.message, /GEMINI_API_KEY/);
        assert.match(err.message, /not set/);
        return true;
      }
    );
  });
});

test('provider: unknown ATLAS_LLM_PROVIDER value throws', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'anthropic' }, () => {
    assert.throws(
      () => getProviderConfig(),
      (err) => {
        assert.match(err.message, /Unknown ATLAS_LLM_PROVIDER/);
        assert.match(err.message, /anthropic/);
        return true;
      }
    );
  });
});

test('provider: openai without OPENAI_API_KEY throws', () => {
  withEnv({ ATLAS_LLM_PROVIDER: 'openai', OPENAI_API_KEY: undefined }, () => {
    assert.throws(
      () => getProviderConfig(),
      /OPENAI_API_KEY/
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeParsedMetrics — contract normalization and error paths
// ---------------------------------------------------------------------------

test('normalizeParsedMetrics: full valid object returns all seven fields', () => {
  const result = normalizeParsedMetrics({
    date: '2026-06-13',
    duration: '45:00',
    activeCalories: 350,
    totalCalories: 420,
    averageHR: 145,
    peakHR: 178,
    workoutType: 'Traditional Strength Training'
  });
  assert.deepEqual(result, {
    date: '2026-06-13',
    duration: '45:00',
    activeCalories: 350,
    totalCalories: 420,
    averageHR: 145,
    peakHR: 178,
    workoutType: 'Traditional Strength Training'
  });
});

test('normalizeParsedMetrics: missing fields default to null', () => {
  const result = normalizeParsedMetrics({ averageHR: 145 });
  assert.equal(result.date, null);
  assert.equal(result.duration, null);
  assert.equal(result.activeCalories, null);
  assert.equal(result.totalCalories, null);
  assert.equal(result.averageHR, 145);
  assert.equal(result.peakHR, null);
  assert.equal(result.workoutType, null);
});

test('normalizeParsedMetrics: explicit null fields pass through as null', () => {
  const result = normalizeParsedMetrics({ averageHR: 145, peakHR: null });
  assert.equal(result.peakHR, null);
});

test('normalizeParsedMetrics: extra keys are stripped from output', () => {
  const result = normalizeParsedMetrics({ averageHR: 145, unknownField: 'surprise' });
  assert.equal(Object.hasOwn(result, 'unknownField'), false);
});

test('normalizeParsedMetrics: null input throws', () => {
  assert.throws(
    () => normalizeParsedMetrics(null),
    /unexpected response shape/
  );
});

test('normalizeParsedMetrics: array input throws', () => {
  assert.throws(
    () => normalizeParsedMetrics([{ averageHR: 145 }]),
    /unexpected response shape.*array/
  );
});

test('normalizeParsedMetrics: string input throws', () => {
  assert.throws(
    () => normalizeParsedMetrics('{"averageHR":145}'),
    /unexpected response shape/
  );
});

test('normalizeParsedMetrics: number input throws', () => {
  assert.throws(
    () => normalizeParsedMetrics(42),
    /unexpected response shape/
  );
});

test('normalizeParsedMetrics: gemini markdown-wrapped JSON normalizes correctly after fence strip', () => {
  // Simulates: caller strips fences, then calls normalizeParsedMetrics
  const rawGeminiText = '```json\n{"averageHR":155,"peakHR":182}\n```';
  const stripped = rawGeminiText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const parsed = JSON.parse(stripped);
  const result = normalizeParsedMetrics(parsed);
  assert.equal(result.averageHR, 155);
  assert.equal(result.peakHR, 182);
  assert.equal(result.date, null);
});

// ---------------------------------------------------------------------------
// ME-11 — defensive parsing + abort timeout (both providers)
// ---------------------------------------------------------------------------

test('stripJsonFences: removes ```json fences the OpenAI path now strips too', () => {
  assert.equal(stripJsonFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripJsonFences('{"a":1}'), '{"a":1}', 'unfenced JSON is untouched');
  assert.equal(stripJsonFences('  {"a":1}  '), '{"a":1}', 'surrounding whitespace trimmed');
});

test('withVisionTimeout: resolves the inner call and passes a live AbortSignal', async () => {
  let seenSignal = null;
  const result = await withVisionTimeout(signal => {
    seenSignal = signal;
    return Promise.resolve('ok');
  });
  assert.equal(result, 'ok');
  assert.ok(seenSignal instanceof AbortSignal, 'fn receives an AbortSignal to thread into the SDK');
  assert.equal(seenSignal.aborted, false, 'signal is not aborted on a fast success');
});

test('withVisionTimeout: aborts and throws a clear timeout error when the call overruns', async () => {
  await assert.rejects(
    withVisionTimeout(
      signal => new Promise((_resolve, reject) => {
        // Never resolves on its own; reject when the timeout aborts the signal.
        signal.addEventListener('abort', () => reject(new Error('aborted by signal')));
      }),
      20
    ),
    /Vision request timed out after 20ms/
  );
});

test('withVisionTimeout: propagates a non-timeout error unchanged', async () => {
  await assert.rejects(
    withVisionTimeout(() => Promise.reject(new Error('provider 500'))),
    /provider 500/
  );
});

test('VISION_TIMEOUT_MS: has a sane positive default', () => {
  assert.ok(Number.isFinite(VISION_TIMEOUT_MS) && VISION_TIMEOUT_MS > 0);
});

// Screenshot-date year rule (live incident 2026-07-02: the model weekday-matched a
// yearless "June 28" header to 2020). The prompt must forbid year inference; the
// deterministic server-side plausibility guard is the enforcement backstop.
test('prompt: forbids inferring the year — yearless dates must return null', () => {
  const prompt = buildWorkoutScreenshotPrompt();
  assert.match(prompt, /If the year is not visible, return date: null/);
  assert.match(prompt, /Never infer or guess the year from the weekday/);
});
