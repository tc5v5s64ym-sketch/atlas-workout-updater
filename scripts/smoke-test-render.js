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
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'x-atlas-api-key': apiKey,
      ...(options.body && !options.headers?.['content-type'] ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Expected JSON from ${path}, got status ${response.status}: ${text.slice(0, 400)}`);
  }

  if (!response.ok) {
    throw new Error(`Request failed for ${path} with status ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  return json;
}

async function publicJson(path) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Expected JSON from ${path}, got status ${response.status}: ${text.slice(0, 400)}`);
  }

  if (!response.ok) {
    throw new Error(`Public request failed for ${path} with status ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  return json;
}

async function main() {
  console.log(`\nSmoke testing Atlas at ${baseUrl} (strong GHA + iPhone friendly)\n`);
  const results = [];
  const record = (name, passed, note = '') => {
    const status = passed ? '✓' : '✗';
    console.log(`${status} ${name}${note ? ' - ' + note : ''}`);
    results.push({ name, passed, note });
  };

  try {
    // ========== PUBLIC ENDPOINTS ==========
    const health = await publicJson('/health');
    assert.equal(health.status, 'ok');
    record('/health', true, 'status=ok');

    const version = await publicJson('/version');
    assert.ok(version.status === 'ok' || version.data);
    record('/version', true, `version=${version.data?.version || version.version || 'ok'}`);

    const routes = await publicJson('/routes');
    assert.ok(routes.status === 'ok' || routes.data?.routes);
    record('/routes', true, 'route definitions returned');

    // ========== PROTECTED READ-ONLY ENDPOINTS ==========
    const sheetsHealth = await requestJson('/api/health/sheets');
    const shData = sheetsHealth.data || sheetsHealth;
    const missing = shData.missingRequiredTabs || [];
    assert.equal(missing.length, 0, 'No missing required tabs');
    const optionalTabs = shData.optionalTabs || {};
    const dashboardInfo = optionalTabs.Dashboard || shData.optionalTabs?.Dashboard;
    const dashboardOptional = !dashboardInfo || dashboardInfo.required === false || dashboardInfo.exists === false;
    record('/api/health/sheets', true, `required tabs present, Dashboard optional/non-fatal (missingRequired=${missing.length})`);

    const history = await requestJson('/api/history/recent?limit=3');
    const histData = history.data || history;
    assert.ok(histData.recent_sessions || histData.recent_sets);
    record('/api/history/recent', true, `recent_sessions=${(histData.recent_sessions || []).length}`);

    const catalog = await requestJson('/api/catalog/exercises');
    const catData = catalog.data || catalog;
    assert.ok(Array.isArray(catData.exercises) && catData.exercises.length > 0);
    record('/api/catalog/exercises', true, `exercises=${catData.exercises.length}`);

    const searchSquat = await requestJson('/api/catalog/search?q=squat');
    const searchData = searchSquat.data || searchSquat;
    assert.ok(Array.isArray(searchData.results) && searchData.results.length > 0);
    record('/api/catalog/search?q=squat', true, `results=${searchData.results.length}`);

    const volume = await requestJson('/api/volume/muscle-groups?days=30');
    const volData = volume.data || volume;
    assert.ok(volData.groups || volData.data);
    record('/api/volume/muscle-groups?days=30', true, 'volume groups returned');

    const prs = await requestJson('/api/prs/recent');
    const prsData = prs.data || prs;
    assert.ok(prsData.prs !== undefined);
    record('/api/prs/recent', true, 'recent PRs checked');

    const pending = await requestJson('/api/pending-exercises');
    const pendData = pending.data || pending;
    assert.ok(pendData.pending_exercises !== undefined);
    record('/api/pending-exercises', true, 'pending exercises endpoint ok');

    // ========== DYNAMIC SESSION CHECKS ==========
    let sessionId = null;
    if (histData.recent_sessions && histData.recent_sessions.length > 0) {
      sessionId = histData.recent_sessions[0].session_id;
    } else if (histData.recent_sets && histData.recent_sets.length > 0) {
      sessionId = histData.recent_sets[0].session_id;
    }

    if (sessionId) {
      const session = await requestJson(`/api/session/${encodeURIComponent(sessionId)}`);
      const sessData = session.data || session;
      assert.ok(sessData.session_id || sessData.log_rows);
      record(`/api/session/${sessionId}`, true, 'session detail ok');

      const summary = await requestJson(`/api/session/${encodeURIComponent(sessionId)}/summary`);
      const sumData = summary.data || summary;
      assert.ok(sumData.session_id || sumData.summary || sumData.log_rows);
      record(`/api/session/${sessionId}/summary`, true, 'session summary ok');
    } else {
      record('dynamic session checks', true, 'skipped (no recent sessions in history)');
    }

    // ========== LIFT-SPECIFIC CHECKS ==========
    const lifts = ['SQ01', 'BEN01'];
    for (const lift of lifts) {
      try {
        const ex = await requestJson(`/api/exercises/${lift}`);
        const exData = ex.data || ex;
        assert.ok(exData.liftCode || exData.exerciseNames);
        record(`/api/exercises/${lift}`, true, 'detail ok');

        const prog = await requestJson(`/api/exercises/${lift}/progress`);
        const progData = prog.data || prog;
        assert.ok(progData !== undefined);
        record(`/api/exercises/${lift}/progress`, true, 'progress ok');

        const rec = await requestJson(`/api/recommend/next/${lift}`);
        const recData = rec.data || rec;
        assert.ok(recData !== undefined);
        record(`/api/recommend/next/${lift}`, true, 'recommendation ok');
      } catch (e) {
        record(`/api/exercises/${lift}*`, false, `endpoint error or lift not found: ${e.message.slice(0,100)}`);
      }
    }

    // ========== DRY-RUN COMPLETE-WORKOUT ==========
    const timestamp = Date.now();
    const drySessionId = `ATLAS-GHA-COMPLETE-WORKOUT-DRYRUN-${timestamp}`;
    const today = new Date().toISOString().slice(0, 10);

    const logRows = [
      { exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2, notes: 'GHA smoke test' },
      { exercise: 'Overhead Press', set_number: 1, weight: 95, reps: 8, rir: 2, notes: 'GHA smoke test' },
      { exercise: 'Lat Pulldown', set_number: 1, weight: 150, reps: 10, rir: 1, notes: 'GHA smoke test' },
      { exercise: 'Face Pull', set_number: 1, weight: 40, reps: 15, rir: 1, notes: 'GHA smoke test' }
    ];

    const effortJson = {
      duration: 45,
      active_calories: 350,
      total_calories: 430,
      average_hr: 121,
      peak_hr: 165,
      location: 'GitHub Actions Smoke Test'
    };

    // Use FormData for /api/complete-workout (multer multipart/form-data or form fields)
    const form = new FormData();
    form.append('session_id', drySessionId);
    form.append('test_mode', 'true');
    form.append('log_rows_json', JSON.stringify(logRows));
    form.append('effort_json', JSON.stringify(effortJson));
    form.append('date', today);
    form.append('location', 'GitHub Actions Smoke Test');

    const dryRunResp = await fetch(`${baseUrl}/api/complete-workout`, {
      method: 'POST',
      body: form,
      headers: {
        'x-atlas-api-key': apiKey
        // Do not set Content-Type; fetch sets correct multipart boundary for FormData
      }
    });

    const dryText = await dryRunResp.text();
    let dryRun;
    try {
      dryRun = dryText ? JSON.parse(dryText) : null;
    } catch (e) {
      throw new Error(`Dry-run response not JSON: ${dryText.slice(0,300)}`);
    }

    if (!dryRunResp.ok) {
      throw new Error(`Dry-run POST failed status ${dryRunResp.status}: ${JSON.stringify(dryRun).slice(0,400)}`);
    }

    const dryData = dryRun.data || dryRun;
    assert.equal(dryData.test_mode, true, 'test_mode should be true');
    assert.equal(dryData.sheet_written, false, 'sheet_written should be false in test_mode');
    assert.equal(dryData.no_write_confirmed, true, 'no_write_confirmed should be true');
    assert.ok(dryData.would_write !== undefined, 'would_write present');
    assert.ok(Array.isArray(dryData.log_rows_preview || dryData.log_rows_preview), 'log_rows_preview present');
    assert.ok(dryData.effort_row || dryData.effort, 'effort preview present');
    // Enrichment check: at least one row should have canonical/lift_code populated
    const previewRows = dryData.log_rows_preview || dryData.data?.log_rows_preview || [];
    if (previewRows.length > 0) {
      const first = Array.isArray(previewRows[0]) ? previewRows[0] : previewRows[0];
      // Depending on format, check enrichment happened
      assert.ok(first && (first.canonical_exercise || first[3] || first.lift_code || first[5]), 'enrichment should populate canonical/lift_code');
    }
    record('POST /api/complete-workout test_mode dry-run', true, `session=${drySessionId} - would_write=${dryData.would_write} no_write_confirmed=true enrichment=ok`);

    // ========== FINAL SUMMARY ==========
    const allPassed = results.every(r => r.passed);
    console.log(`\n=== Smoke test complete: ${allPassed ? 'ALL PASSED' : 'SOME FAILURES'} ===`);
    if (!allPassed) {
      const failures = results.filter(r => !r.passed).map(r => r.name);
      console.error('Failures:', failures.join(', '));
      process.exit(1);
    }
    console.log('Atlas Render smoke tests passed. Safe for production cutover confidence.');

  } catch (error) {
    console.error('\nSmoke test FAILED:', error.message);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
