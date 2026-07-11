'use strict';

// GATE A eligible-window scorecard — READ-ONLY CLI (Soul Plan PR-GATEA2).
//
// Reads the Brain_Shadow diagnostic tab and prints a GATE A scorecard computed
// over ONLY eligible athlete_ui evidence (services/gateAScorecard.js). It performs
// NO Sheet writes and NO mutation — it calls getSheetRows (read) and, optionally,
// writes a LOCAL report file under docs/verification/. It never promotes anything.
//
// Usage:
//   node scripts/gate-a-scorecard.js --env=production            # print JSON+MD
//   node scripts/gate-a-scorecard.js --env=sandbox --format=md
//   node scripts/gate-a-scorecard.js --env=production --out=docs/verification/gatea_scorecard.md
//
// --env is REQUIRED and must match the resolved workbook (production vs sandbox);
// a mismatch fails closed so the tool can never silently read the wrong workbook.

const { computeScorecard, renderMarkdown } = require('../services/gateAScorecard');

const SHADOW_TAB = 'Brain_Shadow';

function parseArgs(argv) {
  const a = {};
  for (const tok of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(tok) || /^--([^=]+)$/.exec(tok);
    if (m) a[m[1]] = m[2] === undefined ? true : m[2];
  }
  return a;
}

// Detect the header row (must carry the provenance columns) and split off data.
function splitHeader(rows) {
  const first = Array.isArray(rows) && rows.length ? rows[0] : null;
  const looksLikeHeader = Array.isArray(first) && first.map(c => String(c).toLowerCase()).includes('evidence_class');
  if (!looksLikeHeader) {
    throw new Error(`${SHADOW_TAB}: no provenance header row found (expected a header containing "evidence_class"). Add the GATEA1 headers per docs/verification/GATEA1_WINDOW_RESET_RUNBOOK.md before scoring.`);
  }
  return { header: first, dataRows: rows.slice(1) };
}

// The testable core. `getRows(tab)` is injected; `config` describes the resolved
// workbook. Returns { scorecard, markdown, meta } and NEVER writes to Sheets.
async function runGateAScorecard({ getRows, env, config, asOf, regionOf, tabName = SHADOW_TAB } = {}) {
  const wantEnv = String(env || '').toLowerCase();
  if (wantEnv !== 'production' && wantEnv !== 'sandbox') {
    throw new Error('GATE A scorecard: pass --env=production or --env=sandbox (explicit selection is required).');
  }
  const isSandbox = config && config.isSandboxSheet === true;
  const resolvedEnv = isSandbox ? 'sandbox' : 'production';
  if (resolvedEnv !== wantEnv) {
    throw new Error(`GATE A scorecard: --env=${wantEnv} but the resolved workbook is ${resolvedEnv} (id ${config && config.id ? config.id : 'unknown'}). Refusing to read the wrong workbook.`);
  }
  const rows = await getRows(tabName);
  const { header, dataRows } = splitHeader(rows);
  const scorecard = computeScorecard(dataRows, { header, asOf, regionOf });
  // Fail-closed safety signal: after a proper window reset the active tab holds NO
  // pre-provenance rows. Surface it loudly if any are present.
  const stale = scorecard.excluded.by_reason.missing_provenance || 0;
  const meta = {
    workbook_id: config && config.id ? config.id : null,
    env: resolvedEnv,
    tab: tabName,
    rows_read: rows.length,
    stale_pre_provenance_rows: stale,
  };
  return { scorecard, markdown: renderMarkdown(scorecard), meta };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const format = String(args.format || 'both').toLowerCase();
  let getSafeSpreadsheetConfig, getSheetRows;
  try {
    ({ getSafeSpreadsheetConfig, getSheetRows } = require('../sheets'));
  } catch (e) {
    console.error('Cannot load the Sheets adapter (missing Google credentials?). This tool reads production/sandbox Sheets and must run in a credentialed environment.');
    process.exit(2);
  }
  const config = getSafeSpreadsheetConfig();
  // Print exactly which workbook + tab we are about to READ (no secrets).
  console.error(`[gate-a-scorecard] reading tab "${SHADOW_TAB}" from workbook ${config.id || 'unknown'} (${config.isSandboxSheet ? 'sandbox' : 'production'}) — READ-ONLY, no writes`);

  let out;
  try {
    out = await runGateAScorecard({
      getRows: (tab) => getSheetRows(tab),
      env: args.env,
      config,
      asOf: args.asOf || new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[gate-a-scorecard] ${e.message}`);
    process.exit(2);
  }

  if (out.meta.stale_pre_provenance_rows > 0) {
    console.error(`[gate-a-scorecard] WARNING: ${out.meta.stale_pre_provenance_rows} pre-provenance rows in the ACTIVE tab — was the window reset per the runbook? (They are excluded, never counted.)`);
  }

  const jsonStr = JSON.stringify({ meta: out.meta, scorecard: out.scorecard }, null, 2);
  if (format === 'json') process.stdout.write(jsonStr + '\n');
  else if (format === 'md') process.stdout.write(out.markdown + '\n');
  else process.stdout.write(out.markdown + '\n\n```json\n' + jsonStr + '\n```\n');

  if (args.out && typeof args.out === 'string') {
    const fs = require('fs');
    const body = format === 'json' ? jsonStr : out.markdown + '\n\n```json\n' + jsonStr + '\n```\n';
    fs.writeFileSync(args.out, body);
    console.error(`[gate-a-scorecard] wrote local report ${args.out} (no Sheet was written)`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e && e.message ? e.message : e); process.exit(2); });
}

module.exports = { runGateAScorecard, splitHeader, parseArgs, SHADOW_TAB };
