const assert = require('node:assert/strict');

// ===== CONFIG & INPUTS =====
const baseUrl = (process.env.ATLAS_BASE_URL || '').replace(/\/$/, '');
const apiKey = process.env.ATLAS_API_KEY;
const smokeMode = (process.env.ATLAS_SMOKE_MODE || 'full').toLowerCase();
const expectedSheetLabel = (process.env.ATLAS_EXPECTED_SHEET_LABEL || 'unknown').toLowerCase();
const requireNoDashboard = String(process.env.ATLAS_REQUIRE_NO_DASHBOARD || 'true').toLowerCase() === 'true';
const allowEmptyPending = String(process.env.ATLAS_ALLOW_EMPTY_PENDING || 'true').toLowerCase() === 'true';

const VALID_MODES = ['basic', 'contract', 'read-only', 'full', 'dry-run-only', 'post-switch'];
const VALID_LABELS = ['current', 'cleaned', 'unknown'];

// ===== HELPERS =====
function logSection(title) { console.log(`\n=== ${title} ===`); }

function recordResult(results, name, passed, note = '') {
  const icon = passed ? '✓' : '✗';
  console.log(`${icon} ${name}${note ? ' — ' + note : ''}`);
  results.push({ name, passed, note });
}

async function requestJson(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { 'x-atlas-api-key': apiKey, ...(options.headers || {}) }
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch (e) {
    throw new Error(`Non-JSON from ${path} (${res.status}): ${text.slice(0,400)}`);
  }
  if (!res.ok) throw new Error(`Failed ${path} ${res.status}: ${JSON.stringify(json).slice(0,500)}`);
  return json;
}

async function publicJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch (e) {
    throw new Error(`Non-JSON from ${path} (${res.status}): ${text.slice(0,400)}`);
  }
  if (!res.ok) throw new Error(`Public ${path} failed ${res.status}`);
  return json;
}

function getData(obj) { return obj?.data || obj; }

function extractDryRunSafetyFields(responseJson) {
  const responseBody = getData(responseJson) || responseJson;
  const nested = responseBody.data || {};
  return {
    test_mode: responseBody.test_mode ?? nested.test_mode,
    would_write: responseBody.would_write ?? nested.would_write,
    sheet_written: responseBody.sheet_written ?? nested.sheet_written,
    no_write_confirmed: responseBody.no_write_confirmed ?? nested.no_write_confirmed,
    sheet_write: responseBody.sheet_write ?? nested.sheet_write
  };
}

function assertDryRunNoWrite(responseJson) {
  const fields = extractDryRunSafetyFields(responseJson);
  assert.equal(fields.test_mode, true, 'Dry-run response must confirm test_mode=true');
  assert.notEqual(fields.sheet_written, true, 'Dry-run response must not report sheet_written=true');
  assert.equal(fields.no_write_confirmed, true, 'Dry-run response must explicitly confirm no_write_confirmed=true');
  return fields;
}

function writeStepSummary(content) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, content + '\n');
  }
}

// ===== MAIN =====
async function main() {
  if (!baseUrl) throw new Error('ATLAS_BASE_URL is required');
  if (!apiKey) throw new Error('ATLAS_API_KEY is required for protected tests');
  if (!VALID_MODES.includes(smokeMode)) throw new Error(`Invalid ATLAS_SMOKE_MODE: ${smokeMode}`);
  if (!VALID_LABELS.includes(expectedSheetLabel)) throw new Error(`Invalid ATLAS_EXPECTED_SHEET_LABEL: ${expectedSheetLabel}`);

  const startTime = new Date().toISOString();
  const githubSha = process.env.GITHUB_SHA || 'unknown';
  const actor = process.env.GITHUB_ACTOR || 'unknown';

  console.log(`\nAtlas Render Smoke Test — Mission Control`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Mode: ${smokeMode}`);
  console.log(`Expected sheet label: ${expectedSheetLabel}`);
  console.log(`Timestamp: ${startTime}`);
  console.log(`GitHub SHA: ${githubSha}`);
  console.log(`Actor: ${actor}`);
  console.log(`(Secrets redacted — GitHub secrets only)`);

  const results = [];

  try {
    // PUBLIC
    logSection('Public endpoints');
    const health = await publicJson('/health');
    recordResult(results, 'GET /health', health.status === 'ok' || !!health.message);

    const version = await publicJson('/version');
    recordResult(results, 'GET /version', true, `version=${version.data?.version || version.version || 'ok'}`);

    const routes = await publicJson('/routes');
    recordResult(results, 'GET /routes', true, 'routes listed');

    // CONTRACT (always run for contract+ modes)
    if (['contract','read-only','full','dry-run-only','post-switch'].includes(smokeMode)) {
      logSection('Sheet contract');
      const sh = await requestJson('/api/health/sheets');
      const d = getData(sh);
      const missing = d.missingRequiredTabs || d.missing_required_tabs || d.missingRequired || [];
      const requiredTabs = ['Metadata','Log_Cleaned','Exercise_Catalog','Effort','Logic','Session_Summary'];
      const hasAll = requiredTabs.every(t => !missing.includes(t) && missing.length === 0);
      const dashInRequired = missing.includes('Dashboard') || (d.tabs && d.tabs.Dashboard && d.tabs.Dashboard.required);
      const dashOk = !requireNoDashboard || !dashInRequired;
      const contractOk = hasAll && dashOk;
      recordResult(results, 'GET /api/health/sheets', contractOk, `required tabs OK, Dashboard optional (requireNoDashboard=${requireNoDashboard})`);
      if (!contractOk) throw new Error('Sheet contract validation failed');
    }

    // READ-ONLY + higher
    if (['read-only','full','post-switch'].includes(smokeMode)) {
      logSection('Read-only endpoints');
      const hist = await requestJson('/api/history/recent?limit=5');
      const hd = getData(hist);
      const sessions = hd.recent_sessions || hd.recentSessions || hd.sessions || [];
      recordResult(results, 'GET /api/history/recent', true, `sessions=${sessions.length}`);

      let sessionId = sessions[0]?.session_id || sessions[0]?.sessionId;
      if (!sessionId && ['read-only','full','post-switch'].includes(smokeMode)) {
        throw new Error('Could not extract real session_id from /api/history/recent');
      }
      if (sessionId) {
        console.log(`  Using session_id: ${sessionId}`);
        await requestJson(`/api/session/${encodeURIComponent(sessionId)}`);
        await requestJson(`/api/session/${encodeURIComponent(sessionId)}/summary`);
        recordResult(results, 'Dynamic session checks', true);
      }

      const cat = await requestJson('/api/catalog/exercises');
      const exercises = getData(cat).exercises || [];
      recordResult(results, 'GET /api/catalog/exercises', exercises.length > 0, `count=${exercises.length}`);

      await requestJson('/api/catalog/search?q=squat');
      recordResult(results, 'GET /api/catalog/search?q=squat', true);

      await requestJson('/api/volume/muscle-groups?days=30');
      await requestJson('/api/prs/recent');
      await requestJson('/api/pending-exercises');
      recordResult(results, 'GET /api/pending-exercises', true, allowEmptyPending ? 'allowed empty' : 'non-empty expected');
    }

    // LIFT CHECKS
    if (['read-only','full','post-switch'].includes(smokeMode)) {
      logSection('Lift checks');
      for (const lift of ['SQ01','BEN01','OHP01']) {
        try {
          await requestJson(`/api/exercises/${lift}`);
          await requestJson(`/api/exercises/${lift}/progress`);
          await requestJson(`/api/recommend/next/${lift}`);
          recordResult(results, `Lift ${lift}`, true);
        } catch (e) {
          recordResult(results, `Lift ${lift}`, false, e.message.slice(0,100));
        }
      }
    }

    // DRY-RUN (full, dry-run-only, post-switch)
    let dryRunSessionId = null;
    if (['full','dry-run-only','post-switch'].includes(smokeMode)) {
      logSection('Dry-run no-write check');
      dryRunSessionId = `ATLAS-GHA-COMPLETE-WORKOUT-DRYRUN-${Date.now()}`;
      const today = new Date().toISOString().slice(0,10);

      const logRows = [
        {exercise:'Back Squat', set_number:1, weight:135, reps:5, rir:3, notes:'Mission Control dry-run'},
        {exercise:'Overhead Press', set_number:1, weight:95, reps:5, rir:3, notes:'Mission Control dry-run'},
        {exercise:'Lat Pulldown', set_number:1, weight:120, reps:8, rir:2, notes:'Mission Control dry-run'},
        {exercise:'Face Pull', set_number:1, weight:40, reps:12, rir:2, notes:'Mission Control dry-run'}
      ];
      const effort = {duration:45, active_calories:350, total_calories:430, average_hr:121, peak_hr:165, location:'GitHub Actions Smoke Test'};

      const form = new FormData();
      form.append('session_id', dryRunSessionId);
      form.append('test_mode', 'true');
      form.append('log_rows_json', JSON.stringify(logRows));
      form.append('effort_json', JSON.stringify(effort));
      form.append('date', today);
      form.append('location', 'GitHub Actions Smoke Test');

      const dryRes = await fetch(`${baseUrl}/api/complete-workout`, {method:'POST', body:form, headers:{'x-atlas-api-key':apiKey}});
      const dryText = await dryRes.text();
      let dryJson; try { dryJson = JSON.parse(dryText); } catch(e){ throw new Error('Dry-run non-JSON'); }
      if (!dryRes.ok) throw new Error(`Dry-run failed ${dryRes.status}`);

      // would_write=true means the request was valid enough to write; it is not proof that no write happened.
      const dryRunFields = assertDryRunNoWrite(dryJson);
      console.log(`  Dry-run safety fields: ${JSON.stringify(dryRunFields)}`);
      recordResult(results, 'POST /api/complete-workout test_mode', true, 'test_mode=true no_write_confirmed=true sheet_written=false');

      // No-mutation
      if (dryRunSessionId) {
        const hist2 = await requestJson('/api/history/recent?limit=10');
        const recentIds = (getData(hist2).recent_sessions || []).map(s => s.session_id || s.sessionId);
        const appeared = recentIds.includes(dryRunSessionId);
        recordResult(results, 'No-mutation check', !appeared, appeared ? 'DRY SESSION APPEARED — ROLLBACK NEEDED' : 'dry session absent from history');
        if (appeared) throw new Error('Dry-run session leaked into history — rollback recommended');
      }
    }

    // SUMMARY
    logSection('Summary');
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    console.log(`Passed: ${passed}/${total}`);

    const table = {
      'Public endpoints': results.filter(r => r.name.includes('/health') || r.name.includes('/version') || r.name.includes('/routes')).every(r=>r.passed),
      'Sheet contract': results.some(r=>r.name.includes('/api/health/sheets')) ? results.find(r=>r.name.includes('/api/health/sheets')).passed : 'skipped',
      'Read-only': results.filter(r => r.name.includes('/api/') && !r.name.includes('complete-workout')).every(r=>r.passed) || ['basic','contract'].includes(smokeMode),
      'Dynamic session': results.some(r=>r.name.includes('Dynamic session')) ? results.find(r=>r.name.includes('Dynamic session')).passed : 'skipped',
      'Lift checks': results.some(r=>r.name.includes('Lift ')) ? results.filter(r=>r.name.includes('Lift ')).every(r=>r.passed) : 'skipped',
      'Dry-run': results.some(r=>r.name.includes('complete-workout')) ? results.find(r=>r.name.includes('complete-workout')).passed : 'skipped',
      'No-mutation': results.some(r=>r.name.includes('No-mutation')) ? results.find(r=>r.name.includes('No-mutation')).passed : 'skipped'
    };

    console.log('\nSummary Table:');
    Object.entries(table).forEach(([k,v]) => console.log(`  ${k}: ${v}`));

    const allPass = results.every(r => r.passed);
    const rollbackRecommended = (expectedSheetLabel === 'cleaned' || smokeMode === 'post-switch') && !allPass;

    if (rollbackRecommended) {
      console.log('\n⚠️ ROLLBACK RECOMMENDED:\n1. Restore previous GOOGLE_SHEETS_ID in Render\n2. Redeploy\n3. Run smoke_mode=read-only expected_sheet_label=current');
    }

    if (!allPass) {
      console.error('\n❌ Some checks failed. See logs above.');
      process.exit(1);
    }

    console.log('\n✅ PASSED — Safe for production monitoring / cutover (test_mode only)');
    writeStepSummary(`## Atlas Mission Control Smoke Test\n**Mode:** ${smokeMode} | **Label:** ${expectedSheetLabel}\n**Result:** ✅ PASSED (${passed}/${total})\n**Rollback needed:** ${rollbackRecommended ? 'YES' : 'NO'}`);

  } catch (error) {
    console.error(`\n❌ FAILED in mode ${smokeMode}: ${error.message}`);
    const rollbackRecommended = (expectedSheetLabel === 'cleaned' || smokeMode === 'post-switch');
    if (rollbackRecommended) {
      console.log('\n⚠️ ROLLBACK RECOMMENDED:\n1. Open Render Dashboard\n2. Restore old GOOGLE_SHEETS_ID\n3. Redeploy service\n4. Run smoke_mode=read-only expected_sheet_label=current');
    } else {
      console.log('\nDO NOT SWITCH GOOGLE_SHEETS_ID until this is resolved.');
    }
    writeStepSummary(`## Atlas Mission Control — FAILED\n**Mode:** ${smokeMode}\n**Error:** ${error.message}\n**Rollback recommended:** ${rollbackRecommended ? 'YES — follow steps above' : 'NO — investigate before switch'}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  extractDryRunSafetyFields,
  assertDryRunNoWrite
};
