#!/usr/bin/env node
'use strict';

// Atlas live-retest harness — FIRST SLICE (scaffolding only).
//
// Purpose: give the owner a targeted, on-demand way to line up a known fixed-
// pending-live-retest bug for a real-app retest. This slice is deliberately
// conservative: it validates inputs, prints the selected scenario and exactly
// what a human should check, and EXITS. It performs no live HTTP calls, drives
// no browser, and NEVER writes to Google Sheets.
//
// It is NOT a merge gate and NOT a replacement for owner judgment — the owner
// still runs the real app and decides pass/fail. Live execution (browser drive
// / API probe) is a deliberate FUTURE slice that would require secrets and a
// non-write contract; it is intentionally absent here.
//
// Scenario sources: docs/BUG_TRIAGE_LEDGER.md (the 🟡 "fixed, live re-test" rows).

// --- Scenario catalogue -----------------------------------------------------
// Each entry is a self-contained description of one retest. `input` is the
// natural-language gym/chat input the owner would type; expected/forbidden
// describe the behaviour to confirm/deny in the real app.
const SCENARIOS = {
  'bug-20260629-153258': {
    bugId: 'BUG-20260629-153258',
    purpose: 'Coach "you missed rows" feedback must not dead-end at the generic "coach isn\'t available" message.',
    input: 'After logging a multi-exercise paste, tell Atlas in chat: "you missed a set".',
    expected: 'A natural, productive reply (e.g. "re-type the set and I\'ll log it") even when the LLM is momentarily down; the deterministic engine still owns logging.',
    forbidden: 'Any "couldn\'t reach the coach" / "coach isn\'t available" / "ask again" wording that reveals an LLM outage.',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — coach-fallback pair; trigger fixed by #699/#701, reveal removed in chatFallback.'
  },
  'bug-20260629-153312': {
    bugId: 'BUG-20260629-153312',
    purpose: 'Duplicate of -153258 — confirm the coach-fallback reveal is gone on the "missed rows" path.',
    input: 'Tell Atlas it missed rows after a paste that previously dropped a row.',
    expected: 'Natural mid-session reply; rows are no longer dropped (the underlying trigger is fixed).',
    forbidden: 'The generic "coach isn\'t available" fallback message.',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — dup of -153258.'
  },
  'bug-20260629-003505': {
    bugId: 'BUG-20260629-003505',
    purpose: 'The "restore session" banner tap must actually restore (was a no-op).',
    input: 'Trigger a restorable session, then tap the "restore session" banner.',
    expected: 'The banner is interactive and the prior session is restored on tap.',
    forbidden: 'Tapping the banner does nothing (silent no-op).',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — interactive restore banner, PR #678.'
  },
  'bug-20260629-002945': {
    bugId: 'BUG-20260629-002945',
    purpose: 'A bare bodyweight rep entry ("Knee raises 20 20 20") must surface a confirmation/clarification, not be silently dropped.',
    input: 'Type: "Knee raises 20 20 20".',
    expected: 'Atlas prompts for the bodyweight reps / shows a confirmation path instead of a silent failure.',
    forbidden: 'A silent drop (422 from /api/log-modality with no card and no prompt).',
    reference: 'docs/BUG_TRIAGE_LEDGER.md — knee-raise bodyweight prompt, PR A #680.'
  }
};

// --- Tiny CLI arg parser ----------------------------------------------------
// Supports `--key value` and `--key=value`. Falls back to env vars so the
// GitHub Actions workflow can pass inputs either way.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq !== -1) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[tok.slice(2)] = 'true'; // bare flag
      } else {
        out[tok.slice(2)] = next;
        i += 1;
      }
    }
  }
  return out;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function run(argv, env = process.env) {
  const args = parseArgs(argv);

  const scenarioKey = (args.scenario || env.SCENARIO || '').trim();
  // Default is the SAFE mode: dry-run / no-write unless explicitly disabled.
  const dryRunOnly = toBool(args['dry-run-only'] !== undefined ? args['dry-run-only'] : env.DRY_RUN_ONLY, true);
  const targetBaseUrl = (args['target-base-url'] || env.TARGET_BASE_URL || env.ATLAS_BASE_URL || '').trim();

  if (!scenarioKey) {
    console.error('ERROR: --scenario is required.');
    console.error(`Valid scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
    return 1;
  }

  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) {
    console.error(`ERROR: unknown scenario "${scenarioKey}".`);
    console.error(`Valid scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
    return 1;
  }

  const line = '─'.repeat(72);
  console.log(line);
  console.log(`Atlas live-retest harness (scaffolding) — scenario: ${scenarioKey}`);
  console.log(line);
  console.log(`Bug id            : ${scenario.bugId}`);
  console.log(`Purpose           : ${scenario.purpose}`);
  console.log(`Input to type     : ${scenario.input}`);
  console.log(`Expected behavior : ${scenario.expected}`);
  console.log(`Forbidden behavior: ${scenario.forbidden}`);
  console.log(`Reference         : ${scenario.reference}`);
  console.log(line);
  console.log(`Target base URL   : ${targetBaseUrl || '(none provided — set ATLAS_BASE_URL or --target-base-url)'}`);
  console.log(`Mode              : ${dryRunOnly ? 'DRY-RUN (no live calls, no Sheets writes)' : 'LIVE (requested)'}`);
  console.log(line);

  if (dryRunOnly) {
    console.log('DRY-RUN: nothing was executed. This slice only describes the retest;');
    console.log('the owner runs the real app and decides pass/fail. No Sheets writes occur.');
    return 0;
  }

  // Live execution is a deliberate future slice. This scaffolding refuses to
  // fabricate it: no browser drive, no API probe, and absolutely no production
  // Sheets writes from this script.
  console.log('LIVE mode requested, but live execution is NOT implemented in this slice.');
  console.log('No live calls were made and no Sheets writes occurred (by design).');
  console.log('Run the scenario manually in the real app, or wait for a future harness slice.');
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { SCENARIOS, parseArgs, toBool, run };
