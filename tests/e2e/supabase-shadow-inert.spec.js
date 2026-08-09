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
  // Both ports. The state server is where the harness reports what the app actually
  // appended, which is how the S3 refusal test proves ZERO side effects by
  // measurement rather than by reading the response body back to itself.
  const ports = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gate-server did not report its port within 30s')), 30000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d);
      const app = buf.match(/GATE_PORT=(\d+)/);
      const state = buf.match(/GATE_STATE_PORT=(\d+)/);
      if (app && state) { clearTimeout(timer); resolve({ app: app[1], state: state[1] }); }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[gate-server] ${d}`));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`gate-server exited early (${code})`)); });
  });
  return { child, base: `http://127.0.0.1:${ports.app}`, state: `http://127.0.0.1:${ports.state}` };
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
    //
    // ── WHY THIS RUN NOW DECLARES A FREEZE POSTURE (PR S3) ────────────────────
    // Until S3, "Supabase configured but unreachable" meant exactly one thing: the
    // shadow write fails. From S3 on it means TWO things, because the seven
    // beginWrite routes now read atlas.write_freeze before any side effect and
    // refuse unless that read succeeds (§5.3, owner ruling D7). An unreachable
    // database therefore ALSO refuses the write — deliberately, and that refusal is
    // proven on its own below.
    //
    // Conflating the two would destroy this test's actual subject. What P3 asks is
    // whether a SHADOW FAILURE is visible to the athlete, so the freeze must ADMIT
    // while the shadow write genuinely fails. `ATLAS_GATE_WRITE_FREEZE=open` gives
    // the control a readable row; the shadow lane keeps the dead connection string
    // and keeps failing for real.
    const on = await bootGateServer({
      ATLAS_SUPABASE_SHADOW_WRITE: '1',
      ATLAS_SUPABASE_APP_URL: 'postgres://nobody:nothing@127.0.0.1:1/nonexistent',
      ATLAS_SUPABASE_CONNECT_TIMEOUT_MS: '1500',
      ATLAS_GATE_WRITE_FREEZE: 'open',
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

  // ── PR S3 — the accepted cost, proven at the browser rung ───────────────────
  //
  // §5.3 states it plainly and before the code was written: "From the S3 deploy
  // onward, an affected write depends on a successful Supabase freeze read on that
  // request. If Supabase is unreachable, the seven beginWrite routes refuse — even
  // though Sheets is still the authority for every one of them until S4."
  //
  // Failing OPEN on a read error was REJECTED, because a blip inside the cutover
  // window would reopen writes with no operator knowing — the exact defect the
  // control exists to prevent. This test is that decision, made visible from the
  // browser: the athlete gets an explicit refusal, never a silent drop and never an
  // unverified success.
  test('S3: with Supabase unreachable the Save is REFUSED with an explicit reason, and nothing is written', async ({ page }) => {
    test.setTimeout(180000);
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    // A REAL unreachable database — no stubbed error. The freeze read fails because
    // there is genuinely nothing on that port.
    const unreachable = await bootGateServer({
      ATLAS_SUPABASE_SHADOW_WRITE: '0',
      ATLAS_SUPABASE_APP_URL: 'postgres://nobody:nothing@127.0.0.1:1/nonexistent',
      ATLAS_SUPABASE_CONNECT_TIMEOUT_MS: '1500',
    });
    let result;
    let stateAfter;
    try {
      result = await saveFromBrowser(page, unreachable.base, `s3-freeze-unreachable-${run}`);
      stateAfter = await (await fetch(`${unreachable.state}/`)).json();
    } finally {
      unreachable.child.kill('SIGTERM');
    }

    expect(result.status).toBe(503);

    const body = JSON.parse(result.raw);
    expect(body.status).toBe('error');
    expect(body.details.error_code).toBe('writes_frozen');
    // A CONTROL FAILURE, not an owner freeze — and the body says which, so an
    // operator is never left guessing between "Dale froze writes" and "the control
    // could not be read".
    expect(body.details.freeze_state).toBe('read_failed');
    expect(body.details.freeze_reason).toBeNull();
    // The no-write proof fields the trust loop already uses.
    expect(body.details.sheet_written).toBe(false);
    expect(body.details.no_write_confirmed).toBe(true);

    // ZERO SIDE EFFECTS, measured at the harness rather than inferred from the body.
    expect(stateAfter.appends).toEqual([]);
    expect(stateAfter.deletes).toEqual([]);

    // And still no internal vocabulary in what the athlete's client can see.
    const lower = result.raw.toLowerCase();
    for (const leak of ['supabase', 'shadow', 'divergence', 'postgres']) {
      expect(lower).not.toContain(leak);
    }
  });
});
