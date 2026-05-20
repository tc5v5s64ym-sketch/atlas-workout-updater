const assert = require('node:assert/strict');

const baseUrl = (process.env.ATLAS_BASE_URL || '').replace(/\/$/, '');
const apiKey = process.env.ATLAS_API_KEY;

if (!baseUrl) {
  throw new Error('ATLAS_BASE_URL is required, for example https://atlas-workout-updater.onrender.com');
}

if (!apiKey) {
  throw new Error('ATLAS_API_KEY is required for protected endpoint smoke tests');
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'x-atlas-api-key': apiKey,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Expected JSON from ${path}, got status ${response.status}: ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`Request failed for ${path} with status ${response.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

async function publicJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Expected JSON from ${path}, got status ${response.status}: ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`Public request failed for ${path} with status ${response.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

async function main() {
  console.log(`Smoke testing Atlas at ${baseUrl}`);

  const health = await publicJson('/health');
  assert.equal(health.status, 'ok');
  console.log('✓ /health');

  const version = await publicJson('/version');
  assert.equal(version.status, 'ok');
  console.log('✓ /version');

  const catalog = await requestJson('/api/catalog/search?q=Back%20Squat');
  const squat = catalog?.data?.results?.find(item => item.canonical_name === 'Back Squat');
  assert.ok(squat, 'Back Squat should exist in catalog search results');
  assert.equal(squat.lift_code, 'SQ01');
  console.log('✓ /api/catalog/search Back Squat -> SQ01');

  const debugMatch = await requestJson('/api/debug/exercise-match?q=Back%20Squat');
  const matchData = debugMatch.data;
  assert.equal(matchData.catalog_match, true);
  assert.equal(matchData.canonical_exercise, 'Back Squat');
  assert.equal(matchData.lift_code, 'SQ01');
  console.log('✓ /api/debug/exercise-match Back Squat -> SQ01');

  const dryRun = await requestJson('/api/log-workout', {
    method: 'POST',
    body: JSON.stringify({
      session_id: `SMOKE-DRY-RUN-${Date.now()}`,
      date: '2026-05-20',
      test_mode: true,
      log_rows: [
        {
          date: '2026-05-20',
          exercise: 'Back Squat',
          set_number: 1,
          weight: 135,
          reps: 5,
          rir: 3,
          notes: 'automated smoke test dry run'
        }
      ]
    })
  });

  const dryRunData = dryRun.data || dryRun;
  assert.equal(dryRunData.test_mode, true);
  assert.equal(dryRunData.sheet_write, 'skipped');

  const previewRows = dryRunData.log_rows_preview || dryRunData.data?.log_rows_preview;
  assert.ok(Array.isArray(previewRows), 'dry run should return log_rows_preview');
  const firstPreview = previewRows[0];
  assert.equal(firstPreview[2], 'Back Squat');
  assert.equal(firstPreview[3], 'Back Squat');
  assert.equal(firstPreview[4], 'Quads');
  assert.equal(firstPreview[5], 'SQ01');
  console.log('✓ /api/log-workout test_mode dry run enriches without writing');

  console.log('Atlas Render smoke tests passed.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
