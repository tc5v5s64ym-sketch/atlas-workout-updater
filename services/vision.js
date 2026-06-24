'use strict';

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { GoogleGenAI } = require('@google/genai');

function buildWorkoutScreenshotPrompt() {
  return [
    'Extract workout metrics visible in this fitness device screenshot (Apple Watch, Garmin, Fitbit, Polar, Whoop, Samsung, or any other wearable or fitness app).',
    'Return strict JSON only with this exact schema:',
    '{',
    '  "date": string|null,',
    '  "duration": string|null,',
    '  "activeCalories": number|null,',
    '  "totalCalories": number|null,',
    '  "averageHR": number|null,',
    '  "peakHR": number|null,',
    '  "workoutType": string|null',
    '}',
    'Field extraction rules:',
    '- duration: any elapsed or workout time field (e.g. "Duration", "Time", "Elapsed Time", "Workout Time").',
    '- activeCalories: active or move energy (e.g. "Active Calories", "Active Cal", "Active Energy", "Move", "Move Cal", "Calories (Active)").',
    '- totalCalories: total energy burned (e.g. "Total Calories", "Total Cal", "Total Energy", "Calories Burned", "Total Burned"). If only one calorie field is visible, put it in activeCalories and leave totalCalories null.',
    '- workoutType: the activity label (e.g. "Outdoor Run", "Strength Training", "Cycling", "Activity Type", "Exercise Type").',
    'Heart rate rules:',
    '- averageHR: use only the value next to labels like "Avg HR", "Average HR", "Avg Heart Rate", "Average Heart Rate", "Mean HR", or "Mean Heart Rate".',
    '- peakHR: use only the value next to labels like "Max HR", "Maximum HR", "Peak HR", "Peak Heart Rate", "Max Heart Rate", "Maximum Heart Rate", or the highest visible heart-rate value on the screenshot.',
    '- averageHR and peakHR are different metrics. Do not confuse them and do not copy one into the other.',
    '- If averageHR is visible but no peak/max heart-rate label or highest HR value is visible, return peakHR: null.',
    'If a workout date is visible and unambiguous, return it as YYYY-MM-DD.',
    'Use null when a value is not visible.',
    'Do not include markdown, code fences, or extra keys.'
  ].join('\n');
}

// Returns provider config or throws a clear config error.
// Exported for testing.
function getProviderConfig() {
  const provider = (process.env.ATLAS_LLM_PROVIDER || 'openai').toLowerCase().trim();

  if (provider === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error(
        'ATLAS_LLM_PROVIDER=gemini but GEMINI_API_KEY is not set. ' +
        'Set GEMINI_API_KEY or unset ATLAS_LLM_PROVIDER to use OpenAI.'
      );
    }
    return {
      provider: 'gemini',
      model: (process.env.ATLAS_LLM_MODEL || 'gemini-2.5-flash-lite').trim(),
      apiKey: process.env.GEMINI_API_KEY
    };
  }

  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for workout image parsing.');
    }
    return {
      provider: 'openai',
      model: (process.env.ATLAS_LLM_MODEL || 'gpt-4.1-mini').trim(),
      apiKey: process.env.OPENAI_API_KEY
    };
  }

  throw new Error(
    `Unknown ATLAS_LLM_PROVIDER value: "${process.env.ATLAS_LLM_PROVIDER}". Supported values: openai, gemini`
  );
}

// Normalizes a raw parsed object to the output contract.
// Throws on non-object input (array, string, null) — never returns partial data.
// Exported for testing.
function normalizeParsedMetrics(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? 'array' : typeof parsed;
    throw new Error(
      `Vision model returned an unexpected response shape: expected a JSON object, got ${got}.`
    );
  }
  return {
    date: parsed.date ?? null,
    duration: parsed.duration ?? null,
    activeCalories: parsed.activeCalories ?? null,
    totalCalories: parsed.totalCalories ?? null,
    averageHR: parsed.averageHR ?? null,
    peakHR: parsed.peakHR ?? null,
    workoutType: parsed.workoutType ?? null
  };
}

// Strips leading/trailing markdown code fences that some models add despite instructions.
function stripJsonFences(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

// Vision (image) parsing is heavier than the text-chat coach path, so it gets its
// own abort timeout — generous enough not to false-fail a normal screenshot parse,
// but bounded so a hung provider call can never block the request forever. Override
// with ATLAS_VISION_TIMEOUT_MS.
const VISION_TIMEOUT_MS = Number(process.env.ATLAS_VISION_TIMEOUT_MS) > 0
  ? Number(process.env.ATLAS_VISION_TIMEOUT_MS)
  : 30000;

// Runs an async provider call with an abort timeout. Passes the AbortSignal to `fn`
// so the underlying SDK request is actually cancelled (not just ignored), and always
// clears the timer. A timeout surfaces as a clear error rather than a hang.
async function withVisionTimeout(fn, ms = VISION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Vision request timed out after ${ms}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function parseWithOpenAI(imageBuffer, mimeType, config) {
  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  const client = new OpenAI({ apiKey: config.apiKey });

  const response = await withVisionTimeout(signal => client.responses.create({
    model: config.model,
    text: { format: { type: 'json_object' } },   // JSON mode — model must return a JSON object
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: buildWorkoutScreenshotPrompt() },
          { type: 'input_image', image_url: dataUrl }
        ]
      }
    ]
  }, { signal }));

  const rawOutput = extractTextOutput(response);
  if (!rawOutput) {
    throw new Error('Vision model returned no text output.');
  }

  // Defensive: strip code fences in case the model wraps the JSON despite JSON mode.
  const textOutput = stripJsonFences(rawOutput);

  let parsed;
  try {
    parsed = JSON.parse(textOutput);
  } catch (err) {
    throw new Error(`Vision response was not valid JSON: ${err.message}`);
  }

  return normalizeParsedMetrics(parsed);
}

async function parseWithGemini(imageBuffer, mimeType, config) {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });

  const response = await withVisionTimeout(signal => ai.models.generateContent({
    model: config.model,
    contents: [
      { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
      { text: buildWorkoutScreenshotPrompt() }
    ],
    config: {
      responseMimeType: 'application/json',   // JSON mode
      abortSignal: signal
    }
  }));

  const textOutput = stripJsonFences(response.text?.trim() || '');
  if (!textOutput) {
    throw new Error('Gemini returned no text output.');
  }

  let parsed;
  try {
    parsed = JSON.parse(textOutput);
  } catch (err) {
    throw new Error(`Gemini response was not valid JSON: ${err.message}`);
  }

  return normalizeParsedMetrics(parsed);
}

async function parseWorkoutScreenshot(imagePath) {
  if (!imagePath) {
    throw new Error('imagePath is required');
  }

  const config = getProviderConfig();
  const absolutePath = path.resolve(imagePath);
  const imageBuffer = fs.readFileSync(absolutePath);
  const mimeType = getMimeTypeFromPath(absolutePath);

  const metrics = config.provider === 'gemini'
    ? await parseWithGemini(imageBuffer, mimeType, config)
    : await parseWithOpenAI(imageBuffer, mimeType, config);

  return { status: 'image received', parsed_metrics: metrics };
}

function extractTextOutput(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const chunks = [];
  for (const item of response.output || []) {
    for (const contentItem of item.content || []) {
      if (contentItem.type === 'output_text' && typeof contentItem.text === 'string') {
        chunks.push(contentItem.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function getMimeTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

module.exports = {
  buildWorkoutScreenshotPrompt,
  parseWorkoutScreenshot,
  getProviderConfig,
  normalizeParsedMetrics,
  stripJsonFences,
  withVisionTimeout,
  VISION_TIMEOUT_MS
};
