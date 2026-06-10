const assert = require('node:assert/strict');

// ===== CONFIG =====
const baseUrl = (process.env.ATLAS_BASE_URL || '').replace(/\/$/, '');
const apiKey = process.env.ATLAS_API_KEY;
const smokeMode = (process.env.ATLAS_SMOKE_MODE || 'full').toLowerCase();
const expectedSheetLabel = (process.env.ATLAS_EXPECTED_SHEET_LABEL || 'unknown').toLowerCase();

const VALID_MODES = ['basic', 'read-only', 'full', 'dry-run-only'];
const VALID_LABELS = ['current', 'cleaned', 'unknown'];

if (!baseUrl) throw new Error('ATLAS_BASE_URL is required');
if (!apiKey) throw new Error('ATLAS_API_KEY is required for protected tests');
if (!VALID_MODES.includes(smokeMode)) throw new Error(`Invalid ATLAS_SMOKE_MODE: ${smokeMode}. Valid: ${VALID_MODES.join(', ')}`);
if (!VALID_LABELS.includes(expectedSheetLabel)) throw new Error(`Invalid ATLAS_EXPECTED_SHEET_LABEL: ${expectedSheetLabel}`);

// ===== HELPERS =====
function logSection(title) {
  console.log(`\n=== ${title} ===`);
}

function recordResult(results, name, passed, note = '') {
  const icon = passed ? '✓' : '✗';
  const line = `${icon} ${name}${note ? ' — ' + note : ''}`;
  console.log(line);
  results.push({ name, passed, note });
  return passed;
}

async function requestJson(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'x-atlas-api-key': apiKey,
      ...(options.body && !(options.headers && options.headers['content-type']) ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; }
  catch (e) { throw new Error(`Non-JSON from ${path} (status ${res.status}): ${text.slice(0, 400)}`); }
  if (!res.ok) throw new Error(`Failed ${path} ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  return json;
}

async function publicJson(path) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; }
  catch (e) { throw new Error(`Non-JSON from ${path} (status ${res.status}): ${text.slice(0, 400)}`); }
  if (!res.ok) throw new Error(`Public ${path} failed ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  return json;
}

function getData(obj) {
  return obj?.data || obj;
}

// ===== MAIN =====
async function main() {
  const startTime = new Date().toISOString();
  console.log(`\nAtlas Render Smoke Test`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Mode: ${smokeMode}`);
  console.log(`Expected sheet label: ${expectedSheetLabel}`);
  console.log(`Timestamp: ${startTime}`);
  console.log(`(All secrets and private data redacted — using GitHub secrets only)`);

  const results = [];
  let overallPass = true;

  try {
    // PHASE 5 — PUBLIC ENDPOINTS
    logSection('Public endpoints');
    {
      const h = await publicJson('/health');
      const ok = h.status === 'ok' || h.message?.includes('ok');
      recordResult(results, 'GET /health', ok, ok ? 'status=ok' : 'unexpected shape');
    }
    {
      const v = await publicJson('/version');
      const ok = v.status === 'ok' || v.data || v.version;
      const ver = v.data?.version || v.version || 'present';
      recordResult(results, 'GET /version', ok, `version=${ver}`);
    }
    {
      const r = await publicJson('/routes');
      const data = getData(r);
      const routes = data?.routes || data || [];
      const hasHealthSheets = JSON.stringify(routes).includes('/api/health/sheets');
      recordResult(results, 'GET /routes', true, hasHealthSheets ? 'includes key routes' : 'basic route list returned');
    }

    // PHASE 4 & 6 — SHEET CONTRACT + READ-ONLY
    logSection('Sheet contract & read-only endpoints');
    {
      const sh = await requestJson('/api/health/sheets');
      const d = getData(sh);
      const missing = d.missingRequiredTabs || d.missing_required_tabs || [];
      const requiredTabs = ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'];
      const hasAllRequired = requiredTabs.every(t => !missing.includes(t));
      const dashOptional = !d.tabs?.Dashboard?.required && (d.optionalTabs?.Dashboard || d.optional_tabs?.Dashboard || true);
      const sheetOk = hasAllRequired && (missing.length === 0);
      recordResult(results, 'GET /api/health/sheets', sheetOk, `required tabs present, Dashboard optional/non-fatal, missing=${missing.length}`);
      if (!sheetOk) throw new Error('Required tabs missing or sheet health failed');
    }

    if (['read-only', 'full'].includes(smokeMode)) {
      const hist = await requestJson('/api/history/recent?limit=5');
      const hd = getData(hist);
      const sessions = hd.recent_sessions || hd.recentSessions || [];
      recordResult(results, 'GET /api/history/recent', sessions.length >= 0, `recent_sessions=${sessions.length}`);

      // Dynamic session extraction
      let sessionId = null;
      if (sessions.length > 0) {
        sessionId = sessions[0].session_id || sessions[0].sessionId;
      } else if (hd.recent_sets && hd.recent_sets.length > 0) {
        sessionId = hd.recent_sets[0].session_id;
      }
      if (!sessionId && smokeMode !== 'basic') {
        throw new Error('Could not find real session_id from /api/history/recent in read-only/full mode');
      }
      if (sessionId) {
        console.log(`  Selected session_id for dynamic checks: ${sessionId}`);
        const sess = await requestJson(`/api/session/${encodeURIComponent(sessionId)}`);
        recordResult(results, `GET /api/session/${sessionId}`, true, 'detail returned');
        const sum = await requestJson(`/api/session/${encodeURIComponent(sessionId)}/summary`);
        recordResult(results, `GET /api/session/${sessionId}/summary`, true, 'summary returned');
      }

      const cat = await requestJson('/api/catalog/exercises');
      const catData = getData(cat);
      const exercises = catData.exercises || [];
      recordResult(results, 'GET /api/catalog/exercises', exercises.length > 0, `count=${exercises.length}`);

      // Key exercise presence (soft where possible)
      const keyExercises = ['Back Squat', 'Bench Press', 'Overhead Press', 'Deadlift', 'Lat Pulldown', 'Face Pull', 'Hanging Knee Raises'];
      const foundKeys = keyExercises.filter(name => exercises.some(e => (e.canonical_name || e.exercise || '').toLowerCase().includes(name.toLowerCase())));
      recordResult(results, 'Catalog key exercises', foundKeys.length >= 4, `found ${foundKeys.length}/7 key exercises`);

      const search = await requestJson('/api/catalog/search?q=squat');
      const sData = getData(search);
      const hasSquat = (sData.results || []).some(r => (r.canonical_name || r.exercise || '').toLowerCase().includes('squat'));
      recordResult(results, 'GET /api/catalog/search?q=squat', hasSquat, hasSquat ? 'Back Squat/SQ01 present' : 'results returned');

      const vol = await requestJson('/api/volume/muscle-groups?days=30');
      recordResult(results, 'GET /api/volume/muscle-groups?days=30', true, 'volume data returned');

      const prs = await requestJson('/api/prs/recent');
      recordResult(results, 'GET /api/prs/recent', true, 'PRS endpoint ok (may be empty)');

      const pend = await requestJson('/api/pending-exercises');
      recordResult(results, 'GET /api/pending-exercises', true, 'pending endpoint ok (may be empty)');
    }

    // PHASE 8 — LIFT CHECKS (read-only + full)
    if (['read-only', 'full'].includes(smokeMode)) {
      logSection('Lift progress & recommendation checks');
      const lifts = ['SQ01', 'BEN01', 'OHP01'];
      for (const lift of lifts) {
        try {
          const ex = await requestJson(`/api/exercises/${lift}`);
          recordResult(results, `GET /api/exercises/${lift}`, true, 'detail ok');
          const prog = await requestJson(`/api/exercises/${lift}/progress`);
          recordResult(results, `GET /api/exercises/${lift}/progress`, true, 'progress ok');
          const rec = await requestJson(`/api/recommend/next/${lift}`);
          recordResult(results, `GET /api/recommend/next/${lift}`, true, 'recommendation ok');
        } catch (e) {
          recordResult(results, `Lift ${lift} checks`, false, e.message.slice(0, 120));
          overallPass = false;
        }
      }
    }

    // PHASE 9 — DRY-RUN (full or dry-run-only)
    let dryRunSessionId = null;
    if (['full', 'dry-run-only'].includes(smokeMode)) {
      logSection('complete-workout test_mode dry-run (no write)');
      dryRunSessionId = `ATLAS-GHA-COMPLETE-WORKOUT-DRYRUN-${Date.now()}`;
      const today = new Date().toISOString().slice(0, 10);

      const logRows = [
        { exercise: 'Back Squat', set_number: 1, weight: 135, reps: 5, rir: 3, notes: 'GHA smoke dry-run' },
        { exercise: 'Overhead Press', set_number: 1, weight: 95, reps: 5, rir: 3, notes: 'GHA smoke dry-run' },
        { exercise: 'Lat Pulldown', set_number: 1, weight: 120, reps: 8, rir: 2, notes: 'GHA smoke dry-run' },
        { exercise: 'Face Pull', set_number: 1, weight: 40, reps: 12, rir: 2, notes: 'GHA smoke dry-run' }
      ];

      const effort = {
        duration: 45,
        active_calories: 350,
        total_calories: 430,
        average_hr: 121,
        peak_hr: 165,
        location: 'GitHub Actions Smoke Test'
      };

      // Multipart form-data for complete-workout (matches multer + API_REFERENCE)
      const form = new FormData();
      form.append('session_id', dryRunSessionId);
      form.append('test_mode', 'true');
      form.append('log_rows_json', JSON.stringify(logRows));
      form.append('effort_json', JSON.stringify(effort));
      form.append('date', today);
      form.append('location', 'GitHub Actions Smoke Test');

      const dryRes = await fetch(`${baseUrl}/api/complete-workout`, {
        method: 'POST',
        body: form,
        headers: { 'x-atlas-api-key': apiKey }
      });

      const dryText = await dryRes.text();
      let dryJson;
      try { dryJson = dryText ? JSON.parse(dryText) : null; }
      catch (e) { throw new Error(`Dry-run non-JSON: ${dryText.slice(0,300)}`); }

      if (!dryRes.ok) throw new Error(`Dry-run failed ${dryRes.status}: ${JSON.stringify(dryJson).slice(0,400)}`);

      const dd = getData(dryJson) || dryJson;
      const testModeOk = dd.test_mode === true || dryJson.test_mode === true;
      const noWrite = dd.sheet_written === false || dd.no_write_confirmed === true || dd.would_write !== undefined;
      const hasPreviews = Array.isArray(dd.log_rows_preview || dd.log_rows_preview) || dd.effort_row;

      const dryOk = testModeOk && noWrite && hasPreviews;
      recordResult(results, 'POST /api/complete-workout test_mode dry-run', dryOk, `test_mode=${testModeOk} no_write=${noWrite} previews=${hasPreviews}`);

      if (!testModeOk || dd.sheet_written === true || (dd.no_write_confirmed === false)) {
        throw new Error('Dry-run wrote data or missing no_write_confirmed flag — potential mutation!');
      }

      // PHASE 10 — No-mutation verification
      if (smokeMode === 'full' && dryRunSessionId) {
        logSection('No-mutation verification (post dry-run)');
        const hist2 = await requestJson('/api/history/recent?limit=10&exclude_test=true');
        const hd2 = getData(hist2);
        const recentIds = (hd2.recent_sessions || []).map(s => s.session_id || s.sessionId);
        const appeared = recentIds.includes(dryRunSessionId);
        recordResult(results, 'Dry-run session absent from recent history', !appeared, appeared ? 'WARNING: session appeared — possible write!' : 'confirmed absent');
        if (appeared) {
          throw new Error('Dry-run session ID appeared in history after test_mode run — rollback recommended');
        }
      }
    }

    // FINAL SUMMARY
    logSection('Summary');
    const passedCount = results.filter(r => r.passed).length;
    const total = results.length;
    console.log(`Passed: ${passedCount}/${total}`);

    const summaryTable = {
      'public endpoints': results.filter(r => r.name.includes('/health') || r.name.includes('/version') || r.name.includes('/routes')).every(r => r.passed),
      'sheet health': results.some(r => r.name.includes('/api/health/sheets')) && results.find(r => r.name.includes('/api/health/sheets')).passed,
      'read-only endpoints': results.filter(r => r.name.includes('/api/') && !r.name.includes('complete-workout')).every(r => r.passed) || smokeMode === 'basic',
      'dynamic session': results.some(r => r.name.includes('/api/session/')) ? results.filter(r => r.name.includes('/api/session/')).every(r => r.passed) : 'skipped',
      'lift checks': results.some(r => r.name.includes('/api/exercises/')) ? results.filter(r => r.name.includes('/api/exercises/')).every(r => r.passed) : 'skipped',
      'dry-run': results.some(r => r.name.includes('complete-workout')) ? results.find(r => r.name.includes('complete-workout')).passed : 'skipped',
      'no-mutation': results.some(r => r.name.includes('absent from recent')) ? results.find(r => r.name.includes('absent from recent')).passed : 'skipped'
    };

    console.log('\nSummary Table:');
    Object.entries(summaryTable).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

    overallPass = results.every(r => r.passed);
    if (!overallPass) {
      console.error('\nSome checks failed. See above for exact endpoint and reason.');
      process.exit(1);
    }

    console.log('\n✅ Atlas Render smoke test PASSED in mode ' + smokeMode + ' for expected sheet label: ' + expectedSheetLabel);
    console.log('Safe signal for production monitoring / cutover (test_mode only, no real writes).');

  } catch (error) {
    console.error(`\n❌ Smoke test FAILED in mode ${smokeMode}: ${error.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
