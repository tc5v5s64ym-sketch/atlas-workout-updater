'use strict';

// §6.1 P3 — the BROWSER rung: the athlete-facing response is byte-identical with
// the shadow write enabled and disabled.
//
// This drives the REAL client against the REAL server (index.js via
// gate-server.js: real routes, real parser, real trust loop, real proof fields),
// with Google Sheets replaced in-process by the gate harness's in-memory stub.
// The response compared is the one the BROWSER actually received, captured off
// the wire — not a re-serialisation and not a server-side observation.
//
// ── WHAT THIS RUNG CAN AND CANNOT SHOW ────────────────────────────────────────
// The Playwright job has no database, so "shadow enabled" HERE means enabled and
// FAILING. That is the more dangerous half of P3 and it is the half a browser can
// prove: an athlete must never see a shadow failure. The other half — enabled and
// SUCCEEDING against a real from-empty Postgres database — is proven at the same
// level of the response by test-pg/shadowInert.test.js, which the Supabase schema
// proof job runs. Neither rung alone discharges P3; the merge card records the split.
//
// Nothing here can reach Google or Supabase. No Google credential is loaded, and
// the Supabase connection string below points at a closed port on loopback.

const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fsp = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE_KEY = 'playwright-gate-key';

// Exactly the envelope fields that are non-deterministic per request. Anything
// else differing between the two runs is a real difference and fails this proof.
function normalize(raw) {
  return raw
    .replace(/"requestId":"[^"]*"/g, '"requestId":"<normalized>"')
    .replace(/"duration_ms":\d+/g, '"duration_ms":<normalized>')
    .replace(/"timestamp":"[^"]*"/g, '"timestamp":"<normalized>"')
    // The two runs must use different write_ids or the second Save would replay
    // the first as a duplicate and the comparison would be vacuous.
    .replace(/"write_id":"[^"]*"/g, '"write_id":"<normalized>"');
}

async function bootGateServer(extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, 'gate', 'gate-server.js')], {
    env: {
      ...process.env,
      ATLAS_GATE_KEY: GATE_KEY,
      // A PRIVATE receipt store per gate-server.
      //
      // services/idempotency.js persists to /tmp/atlas-idempotency.json, which is
      // shared by every process on the runner — and this spec runs in BOTH the
      // chromium and mobile-chromium projects. Left alone, the second project's
      // server rehydrates the first project's receipts, replays the Save as a
      // duplicate, and returns a different body, so the byte-identity comparison
      // fails on a duplicate rather than on anything the shadow lane did.
      ATLAS_IDEMPOTENCY_FILE: path.join(
        fsp.mkdtempSync(path.join(os.tmpdir(), 'atlas-p3-')),
        'idempotency.json'
      ),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gate-server did not report its port within 30s')), 30000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d);
      const app = buf.match(/GATE_PORT=(\d+)/);
      if (app) { clearTimeout(timer); resolve(app[1]); }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[gate-server] ${d}`));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`gate-server exited early (${code})`)); });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

// One Save, performed BY THE BROWSER against the real server, with the raw
// response body captured exactly as the client received it.
async function saveFromBrowser(page, base, writeId) {
  await page.addInitScript((key) => { localStorage.setItem('atlas_api_key', key); }, GATE_KEY);
  await page.goto(`${base}/app/`);
  await page.waitForLoadState('networkidle');

  return page.evaluate(async ({ apiKey, id }) => {
    const response = await fetch('/api/log-workout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atlas-api-key': apiKey },
      body: JSON.stringify({
        session_id: '20260808-AM-04',
        date: '2026-08-08',
        write_id: id,
        log_rows: [
          { date_clean: '2026-08-08', session_id: '20260808-AM-04', exercise: 'Back Squat', set_number: 1, weight: 225, reps: 5, rir: 2, notes: '' },
          { date_clean: '2026-08-08', session_id: '20260808-AM-04', exercise: 'Back Squat', set_number: 2, weight: 225, reps: 5, rir: 2, notes: '' },
        ],
      }),
    });
    return { status: response.status, raw: await response.text() };
  }, { apiKey: GATE_KEY, id: writeId });
}

test.describe('Supabase shadow write is inert (§6.1 P3)', () => {
  test('the response the browser receives is byte-identical with the shadow lane off and on', async ({ page }) => {
    test.setTimeout(180000);

    // Run 1 — the lane is OFF, which is production's configuration today.
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    const off = await bootGateServer({ ATLAS_SUPABASE_SHADOW_WRITE: '0' });
    let offResult;
    try {
      offResult = await saveFromBrowser(page, off.base, `p3-lane-disabled-${run}`);
    } finally {
      off.child.kill('SIGTERM');
    }

    // Run 2 — the lane is ON and its database is unreachable, so every shadow
    // write fails. The athlete must not be able to tell.
    const on = await bootGateServer({
      ATLAS_SUPABASE_SHADOW_WRITE: '1',
      ATLAS_SUPABASE_APP_URL: 'postgres://nobody:nothing@127.0.0.1:1/nonexistent',
      ATLAS_SUPABASE_CONNECT_TIMEOUT_MS: '1500',
    });
    let onResult;
    try {
      onResult = await saveFromBrowser(page, on.base, `p3-lane-enabled-${run}`);
    } finally {
      on.child.kill('SIGTERM');
    }

    expect(offResult.status).toBe(200);
    expect(onResult.status).toBe(offResult.status);
    expect(normalize(onResult.raw)).toBe(normalize(offResult.raw));

    // And no shadow vocabulary leaks into what the athlete's client can see.
    const lower = onResult.raw.toLowerCase();
    for (const leak of ['supabase', 'shadow', 'divergence', 'postgres']) {
      expect(lower).not.toContain(leak);
    }

    // The W1-W3 proof fields still come from the Sheets append, unchanged.
    const body = JSON.parse(onResult.raw);
    expect(body.data.sheet_write).toBe('success');
    expect(body.data.test_mode).toBe(false);
    expect(body.data.log_rows_written).toBe(2);
  });
});
