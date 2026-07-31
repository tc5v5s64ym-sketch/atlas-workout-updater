'use strict';

// The F10S/F10D gate harness (tests/e2e/gate/gate-server.js) must never LIE about its
// model posture. Its header claims "no LLM key is present, so every coach surface uses
// its deterministic fallback" — and on main that claim was false on any machine holding
// a local `.env`.
//
// ROOT CAUSE the tests below pin: the harness deletes the provider keys, then requires
// index.js, whose line 3 runs `require('dotenv').config()`. dotenv never OVERRIDES an
// existing variable, so the deletes looked safe — but a DELETED variable is not an
// existing one, so dotenv SET every deleted variable again from `.env`, after the
// deletes and before the first request. Measured on main: the "no LLM key" harness
// answered /api/coach/health with configured:true and called
// generativelanguage.googleapis.com for real.
//
// OFFLINE BY CONSTRUCTION: every case here uses a fake key and asserts only the
// harness's own posture surfaces (stdout line, /state, exit code). No case asks the
// harness to reach a provider — /api/coach/health is queried ONLY in the model-down
// cases, where `isConfigured()` is false and the route short-circuits before any fetch.
// Nothing here writes a Sheet: sheets.js is stubbed in-process by the harness itself.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE_SERVER = path.join(__dirname, '..', 'tests', 'e2e', 'gate', 'gate-server.js');
const FAKE_KEY = 'gate-posture-test-fake-key-never-valid';
const PROVIDER_KEYS = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

// A temp working directory, optionally holding a `.env`. The harness resolves `.env`
// from process.cwd(), so cwd is the whole reproduction — the repo root is never touched.
function makeCwd(dotenvBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-gate-posture-'));
  if (typeof dotenvBody === 'string') fs.writeFileSync(path.join(dir, '.env'), dotenvBody);
  return dir;
}

// Build the child env EXPLICITLY. The test host may itself export a real provider key
// (this is normal on an owner machine), and inheriting it would silently invalidate the
// "no key anywhere" cases below — the exact class of accident under test.
function childEnv(extra = {}) {
  const env = { ...process.env, ATLAS_GATE_KEY: 'gate-posture-key' };
  for (const key of PROVIDER_KEYS) delete env[key];
  delete env.ATLAS_GATE_MODEL_UP;
  return { ...env, ...extra };
}

// Spawn the harness and resolve once it reports its ports, or once it exits early.
function startGate({ cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATE_SERVER], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('gate-server did not report its ports within 40s')); }, 40000);
    child.stdout.on('data', d => {
      out += d;
      const app = out.match(/GATE_PORT=(\d+)/);
      const state = out.match(/GATE_STATE_PORT=(\d+)/);
      if (app && state) {
        clearTimeout(timer);
        resolve({ child, exited: false, stdout: out, stderr: err, appPort: app[1], statePort: state[1] });
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ child, exited: true, exitCode: code, stdout: out, stderr: err });
    });
  });
}

// Both helpers time out. If the model posture ever regresses, /api/coach/health would
// reach a real provider — a bounded failure is required, never a hung suite.
async function gateState(statePort) {
  const res = await fetch(`http://127.0.0.1:${statePort}/state`, { signal: AbortSignal.timeout(10000) });
  return res.json();
}

async function coachHealth(appPort) {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/coach/health`, {
    headers: { 'x-atlas-api-key': 'gate-posture-key' },
    signal: AbortSignal.timeout(10000),
  });
  return (await res.json()).data;
}

// ── 1. THE REGRESSION: a local .env cannot silently convert model-down into model-up ──
test('gate posture: a local .env carrying GEMINI_API_KEY cannot make the default harness model-up', async () => {
  const cwd = makeCwd(`GEMINI_API_KEY=${FAKE_KEY}\n`);
  const gate = await startGate({ cwd, env: childEnv() });
  assert.equal(gate.exited, false, `harness must start in the default posture (stderr: ${gate.stderr})`);
  try {
    const state = await gateState(gate.statePort);
    assert.equal(state.model_posture, 'model-down', 'a .env key must not change the posture');
    assert.equal(state.provider_key_present, false, 'dotenv must not restore the deleted provider key');

    // The live surface, not just the harness's self-report: the app itself must agree.
    // configured:false means isConfigured() saw no key, so no provider call is possible.
    const health = await coachHealth(gate.appPort);
    assert.equal(health.configured, false, '/api/coach/health must report the provider unconfigured');
    assert.equal(health.ok, false);
  } finally { gate.child.kill(); }
});

// ── 2. Default gate harness remains model-down, including against a dev shell export ──
test('gate posture: the default harness is model-down even when the spawning shell exports a key', async () => {
  const cwd = makeCwd(null);
  const gate = await startGate({ cwd, env: childEnv({ GEMINI_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY }) });
  assert.equal(gate.exited, false, `harness must start (stderr: ${gate.stderr})`);
  try {
    assert.match(gate.stdout, /GATE_MODEL_POSTURE=model-down/, 'the posture line must be printed for the transcript');
    const state = await gateState(gate.statePort);
    assert.equal(state.model_posture, 'model-down');
    assert.equal(state.provider_key_present, false, 'an exported key must be deleted and stay deleted');
    const health = await coachHealth(gate.appPort);
    assert.equal(health.configured, false);
  } finally { gate.child.kill(); }
});

test('gate posture: the default harness is model-down with no key anywhere (the CI baseline)', async () => {
  const cwd = makeCwd(null);
  const gate = await startGate({ cwd, env: childEnv() });
  assert.equal(gate.exited, false, `harness must start (stderr: ${gate.stderr})`);
  try {
    const state = await gateState(gate.statePort);
    assert.equal(state.model_posture, 'model-down');
    assert.equal(state.provider_key_present, false);
  } finally { gate.child.kill(); }
});

// ── 3. Explicit model-up remains available ───────────────────────────────────────────
test('gate posture: ATLAS_GATE_MODEL_UP=1 with a key present yields an explicit model-up harness', async () => {
  const cwd = makeCwd(null);
  const gate = await startGate({ cwd, env: childEnv({ ATLAS_GATE_MODEL_UP: '1', GEMINI_API_KEY: FAKE_KEY }) });
  assert.equal(gate.exited, false, `explicit model-up must remain available (stderr: ${gate.stderr})`);
  try {
    assert.match(gate.stdout, /GATE_MODEL_POSTURE=model-up/);
    const state = await gateState(gate.statePort);
    assert.equal(state.model_posture, 'model-up');
    assert.equal(state.provider_key_present, true, 'model-up keeps the provider key reachable');
    // Deliberately NOT calling /api/coach/health here: with a key present that route
    // pings the provider for real. Reaching a provider is a property of the RUN, and
    // proving it is the operator's job — never a unit test's.
  } finally { gate.child.kill(); }
});

// ── 4. Model-up is never inferred, and a failed model-up never false-passes ──────────
test('gate posture: model-up is never inferred from a key alone — only the explicit flag selects it', async () => {
  const cwd = makeCwd(`GEMINI_API_KEY=${FAKE_KEY}\n`);
  const gate = await startGate({ cwd, env: childEnv({ GEMINI_API_KEY: FAKE_KEY }) });
  assert.equal(gate.exited, false, `harness must start (stderr: ${gate.stderr})`);
  try {
    // Key in the shell AND key in .env — the two ways a provider becomes "available"
    // by accident. Neither selects model-up; only ATLAS_GATE_MODEL_UP=1 does.
    const state = await gateState(gate.statePort);
    assert.equal(state.model_posture, 'model-down');
    assert.equal(state.provider_key_present, false);
  } finally { gate.child.kill(); }
});

test('gate posture: a model-up run with no key fails closed instead of degrading to model-down', async () => {
  const cwd = makeCwd(null);
  const gate = await startGate({ cwd, env: childEnv({ ATLAS_GATE_MODEL_UP: '1' }) });
  // Kill unconditionally: when this expectation REGRESSES the harness stays up, and a
  // leaked live server keeps the test runner's event loop open until it is timed out.
  try {
    assert.equal(gate.exited, true, 'a model-up harness with no provider key must not serve a spec');
    assert.equal(gate.exitCode, 2, 'the posture failure must be a distinct non-zero exit');
    assert.match(gate.stderr, /GATE_POSTURE_ERROR/, 'the failure must name itself as a posture error');
    assert.doesNotMatch(gate.stdout, /GATE_PORT=/, 'no port may be published by a mislabeled harness');
  } finally { gate.child.kill(); }
});

test('gate posture: a scripted coach can never be served as a model-up run', async () => {
  const cwd = makeCwd(null);
  const gate = await startGate({
    cwd,
    env: childEnv({ ATLAS_GATE_MODEL_UP: '1', ATLAS_GATE_COACH_SCRIPT: '1', GEMINI_API_KEY: FAKE_KEY }),
  });
  try {
    // The stub replaces services/coach outright, so no provider is reachable no matter
    // how many keys are present. Serving that as model-up is the same lie in a costume.
    assert.equal(gate.exited, true, 'the contradictory posture combination must be refused');
    assert.equal(gate.exitCode, 2);
    assert.match(gate.stderr, /GATE_POSTURE_ERROR/);
  } finally { gate.child.kill(); }
});

// ── 5. The deterministic-baseline deletes share the root cause and must also hold ────
// The same dotenv window restored the telemetry and ledger write-enable flags, so the
// default posture could claim dry-run while SESSION_PLAN_SETS_WRITE_ENABLED was on.
// This pins the write-posture half of the same fix — a false write posture is the more
// dangerous of the two.
test('gate posture: a local .env cannot switch the default harness out of its dry-run ledger posture', async () => {
  const cwd = makeCwd([
    'SESSION_PLAN_SETS_WRITE_ENABLED=1',
    'ATLAS_SESSION_PLANS_WRITE=1',
    'ATLAS_FLIGHT_RECORDER=1',
    'ATLAS_INTERACTION_TRACE=shadow',
    '',
  ].join('\n'));
  const gate = await startGate({ cwd, env: childEnv() });
  assert.equal(gate.exited, false, `harness must start (stderr: ${gate.stderr})`);
  try {
    const state = await gateState(gate.statePort);
    assert.equal(state.ledger_sandbox, false, 'the default posture is the dry-run ledger posture');
    // The harness deleted these before loading the app; dotenv must not have restored them.
    const health = await coachHealth(gate.appPort);
    assert.equal(health.configured, false, 'the model posture holds alongside the write posture');
    // Zero appends: the flags that would make telemetry middleware write are still off.
    assert.deepEqual(state.appends, [], 'a booted harness must have appended nothing');
  } finally { gate.child.kill(); }
});
