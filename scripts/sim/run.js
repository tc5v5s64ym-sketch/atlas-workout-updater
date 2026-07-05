#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { runSimulation, SANDBOX_SHEET_ID } = require('./harness');

function parseArgs(argv) {
  const args = {
    mode: 'read-only',
    scenarioFile: path.join(__dirname, 'scenarios.json'),
    outputDir: path.join(process.cwd(), 'outputs', 'sim'),
    baseUrl: process.env.ATLAS_SIM_BASE_URL,
    apiKey: process.env.ATLAS_API_KEY,
    sheetId: process.env.ATLAS_SIM_SHEET_ID,
    enableWriteScenarios: false,
    runs: 1,
    delayMs: 0,
    retryAttempts: undefined,
    retryDelayMs: undefined,
    enableShadowObservation: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--mode') args.mode = next();
    else if (arg === '--base-url') args.baseUrl = next();
    else if (arg === '--api-key') args.apiKey = next();
    else if (arg === '--sheet-id') args.sheetId = next();
    else if (arg === '--scenarios') args.scenarioFile = path.resolve(next());
    else if (arg === '--output-dir') args.outputDir = path.resolve(next());
    else if (arg === '--sandbox') args.sheetId = SANDBOX_SHEET_ID;
    else if (arg === '--enable-write-scenarios') args.enableWriteScenarios = true;
    else if (arg === '--runs') args.runs = next();
    else if (arg === '--delay-ms') args.delayMs = next();
    else if (arg === '--retry-attempts') args.retryAttempts = next();
    else if (arg === '--retry-delay-ms') args.retryDelayMs = next();
    else if (arg === '--enable-shadow-observation') args.enableShadowObservation = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Atlas Simulation Harness v1

Usage:
  node scripts/sim/run.js --base-url http://127.0.0.1:3000
  node scripts/sim/run.js --mode write --sandbox --enable-write-scenarios --base-url http://127.0.0.1:3000
  node scripts/sim/run.js --mode write --sandbox --enable-write-scenarios --runs 100 --base-url http://127.0.0.1:3000

Safety:
  Read-only is the default. Write scenarios require --mode write --sandbox
  --enable-write-scenarios, and the server must confirm the sandbox sheet.

Options:
  --mode read-only|write       Default: read-only
  --base-url URL               Local Atlas server URL, or ATLAS_SIM_BASE_URL
  --api-key KEY                Atlas API key, or ATLAS_API_KEY
  --sheet-id ID                Required for write mode; must be the sandbox ID
  --sandbox                    Uses the known sandbox simulation sheet ID
  --enable-write-scenarios     Runs sandbox-only synthetic workout sessions
  --runs N                     Number of sandbox mock sessions, 1-100. Default: 1
  --delay-ms N                 Delay between write runs to avoid Sheets quota. Default: 0
  --retry-attempts N           Transient retry attempts per local request. Default: 5
  --retry-delay-ms N           Delay before retrying transient quota/rate failures. Default: 65000
  --enable-shadow-observation  Sandbox-gated: posts prompts to /api/debug/intent-observe
  --scenarios PATH             Scenario JSON file
  --output-dir PATH            Report output directory
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const report = await runSimulation(args);
  console.log(`Atlas simulation complete: ${report.scenario_count} scenarios`);
  console.log(`Mode: ${report.mode}`);
  if (report.write_scenario_count) console.log(`Write scenarios: ${report.write_scenario_count}`);
  if (report.run_summary && report.run_summary.runs_completed) {
    console.log(`Runs: completed=${report.run_summary.runs_completed}, passed=${report.run_summary.runs_passed}, failed=${report.run_summary.runs_failed}, rows_written=${report.run_summary.rows_written}`);
    if (report.delay_ms) console.log(`Delay ms: ${report.delay_ms}`);
    console.log(`Retries used: ${report.run_summary.retry_attempts_used || 0}`);
    console.log(`Brain_Shadow entries: ${report.run_summary.brain_shadow_entries}`);
    console.log(`Brain_Shadow diverged: ${report.run_summary.brain_shadow_diverged || 0}`);
    console.log(`Brain_Shadow failures: ${report.run_summary.brain_shadow_failures || 0}`);
    console.log(`Intent_Shadow entries: ${report.run_summary.intent_shadow_entries || 0}`);
    if (report.variation_summary) {
      console.log(`Variation: exercises=${report.variation_summary.unique_exercises}, muscle_groups=${report.variation_summary.unique_muscle_groups}, session_types=${report.variation_summary.session_types.join(',')}`);
    }
    if (report.run_summary.flagged_odd_results.length) {
      console.warn(`Flagged odd results: ${report.run_summary.flagged_odd_results.length}`);
    }
  }
  console.log(`Pass: ${report.pass === false ? 'false' : 'true'}`);
  if (report.server_sheet_verification) {
    const sheet = report.server_sheet_verification;
    console.log(`Server sheet: sandbox=${sheet.isSandboxSheet === true}, production=${sheet.isProductionSheet === true}, last6=${sheet.idLast6 || 'unknown'}`);
  } else {
    console.log('Server sheet: unverified');
  }
  if (Array.isArray(report.warnings) && report.warnings.length) {
    for (const warning of report.warnings) {
      console.warn(`Warning: ${warning}`);
    }
  }
  if (report.report_paths) {
    console.log(`JSON: ${report.report_paths.json}`);
    console.log(`Markdown: ${report.report_paths.markdown}`);
  }
  if (report.pass === false) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
