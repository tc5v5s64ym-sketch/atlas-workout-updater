const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

function buildWorkoutScreenshotPrompt() {
  return [
    'Extract workout metrics visible in this Apple Watch workout screenshot.',
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
    'Heart rate rules:',
    '- averageHR: use only the value next to labels like "Avg HR", "Average HR", or "Avg Heart Rate".',
    '- peakHR: use only the value next to labels like "Max HR", "Maximum HR", "Peak HR", or "Peak Heart Rate", or the highest visible heart-rate value on the screenshot.',
    '- averageHR and peakHR are different metrics. Do not confuse them and do not copy one into the other.',
    '- If averageHR is visible but no peak/max heart-rate label or highest HR value is visible, return peakHR: null.',
    'If a workout date is visible and unambiguous, return it as YYYY-MM-DD.',
    'Use null when a value is not visible.',
    'Do not include markdown, code fences, or extra keys.'
  ].join('\n');
}

async function parseWorkoutScreenshot(imagePath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for workout image parsing.');
  }

  if (!imagePath) {
    throw new Error('imagePath is required');
  }

  const absolutePath = path.resolve(imagePath);
  const imageBuffer = fs.readFileSync(absolutePath);
  const mimeType = getMimeTypeFromPath(absolutePath);
  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildWorkoutScreenshotPrompt()
          },
          {
            type: 'input_image',
            image_url: dataUrl
          }
        ]
      }
    ]
  });

  const textOutput = extractTextOutput(response);
  if (!textOutput) {
    throw new Error('Vision model returned no text output.');
  }

  let parsed;
  try {
    parsed = JSON.parse(textOutput);
  } catch (error) {
    throw new Error(`Vision response was not valid JSON: ${error.message}`);
  }

  return {
    status: 'image received',
    parsed_metrics: {
      date: parsed.date ?? null,
      duration: parsed.duration ?? null,
      activeCalories: parsed.activeCalories ?? null,
      totalCalories: parsed.totalCalories ?? null,
      averageHR: parsed.averageHR ?? null,
      peakHR: parsed.peakHR ?? null,
      workoutType: parsed.workoutType ?? null
    }
  };
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
  parseWorkoutScreenshot
};
