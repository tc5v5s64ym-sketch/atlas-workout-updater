'use strict';

// PR-GATEA1 — the provenance seam is wired end to end (source introspection).
//
// The classifier + recorders are behavior-tested (evidenceProvenance.test.js,
// shadowProvenance.test.js). This guard proves the SEAM: the real UI attaches the
// athlete_ui marker, every coach-engine shadow call site classifies the request,
// and synthetic sources identify themselves — so a fresh GATE-A window counts only
// genuine athlete traffic. It also pins that provenance is telemetry-only (it flows
// into observe* calls, never into a served response).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('client: the api() wrapper attaches x-atlas-request-origin (athlete_ui, or playwright under automation)', () => {
  const api = read('src/app/api.js');
  // The marker is computed from navigator.webdriver: automation → synthetic, else athlete_ui.
  assert.match(api, /navigator\.webdriver\s*===\s*true\s*\)\s*\?\s*'playwright'\s*:\s*'athlete_ui'/,
    'automation (WebDriver) sends a synthetic marker, never athlete_ui');
  assert.match(api, /'x-atlas-request-origin':\s*uiOrigin/, 'the computed marker rides the header');
  // The provenance marker sits in the ALWAYS-built base headers object, so it is
  // sent unconditionally on every api() call.
  const headerLine = api.split('\n').find(l => l.includes("'x-atlas-request-origin'"));
  assert.ok(/const headers = \{/.test(headerLine), 'the marker rides the unconditional base headers object');
  // The api-key header is now CONDITIONAL — the durable session cookie is primary
  // (F04C); the legacy key header is attached only while a raw key is still stored.
  assert.match(api, /if \(key\) headers\['x-atlas-api-key'\] = key;/,
    'the legacy key header is conditional, not unconditional');
});

test('client: the composer intent-observe POST body carries the webdriver-aware request_origin (bypasses api())', () => {
  const app = read('src/app/app.js');
  const idx = app.indexOf("fetch('/api/debug/intent-observe'");
  assert.ok(idx > -1, 'the intent-observe POST exists');
  // Scope to the fetch call itself (up to its trailing .catch) so the assertion is
  // robust to additive fields like credentials, not a brittle fixed char window.
  const end = app.indexOf('.catch(', idx);
  const block = app.slice(idx, end > -1 ? end : idx + 1200);
  assert.match(block, /navigator\.webdriver\s*===\s*true\s*\)\s*\?\s*'playwright'\s*:\s*'athlete_ui'/,
    'the body marker is also automation-aware since this POST bypasses the api.js header seam');
});

test('server: every coach-engine shadow call site classifies the request via evidenceForRequest(req)', () => {
  const idx = read('index.js');
  assert.match(idx, /const \{ evidenceForRequest \} = require\('\.\/services\/evidenceProvenance'\)/, 'index.js imports the classifier');
  // All three orchestration gates + their failure paths pass evidence.
  const orchestrations = idx.match(/observeBrainOrchestration\(\{[\s\S]*?\}\)/g) || [];
  assert.equal(orchestrations.length, 3, 'exactly the three coach-engine gates');
  for (const call of orchestrations) {
    assert.match(call, /evidence:\s*evidenceForRequest\(req\)/, `orchestration call must classify: ${call.slice(0, 60)}…`);
  }
  const failures = idx.match(/observeBrainFailure\(\{[^}]*\}\)/g) || [];
  assert.ok(failures.length >= 4, 'the failure paths are wired too');
  for (const call of failures) {
    assert.match(call, /evidence:\s*evidenceForRequest\(req\)/, `failure call must classify: ${call.slice(0, 60)}…`);
  }
});

test('server: the intent-observe route classifies from the body marker + fails closed', () => {
  const co = read('routes/coachOps.js');
  // The destructure also carries EVIDENCE_CLASSES since the 2026-07-31 synthetic
  // containment fix, so match the classifier import without pinning the full list.
  assert.match(co, /const \{ evidenceForRequest[^}]*\} = require\('\.\.\/services\/evidenceProvenance'\)/);
  assert.match(co, /req\.body\.request_origin/, 'reads the body marker (this POST bypasses the header seam)');
  assert.match(co, /evidenceForRequest\(req,\s*\{\s*bodyOrigin\s*\}\)/, 'passes the body marker to the classifier');
  assert.match(co, /observeChatMessage\(message,\s*\{[^}]*evidence[^}]*\}\)/, 'forwards the verdict to the shadow recorder');
});

test('synthetic sources identify themselves — smoke marks synthetic, the sim harness keeps its simulation header', () => {
  const smoke = read('scripts/smoke-test-render.js');
  assert.match(smoke, /'x-atlas-request-origin':\s*'smoke'/, 'production smoke traffic marks itself synthetic');
  const sim = read('scripts/sim/harness.js');
  assert.match(sim, /'x-atlas-simulation'/, 'the sim harness still sends the simulation header (reused as a synthetic signal)');
});

test('telemetry-only: provenance flows into observe* calls, never into a served recommendation object', () => {
  const idx = read('index.js');
  // evidenceForRequest is referenced ONLY inside observe* call params — never assigned
  // onto rec/recommendation/result or returned in a response.
  const badAssign = /(rec|recommendation|result)\.(evidence|request_origin|evidence_class)\s*=/;
  assert.ok(!badAssign.test(idx), 'provenance must never be written onto a served object');
});
