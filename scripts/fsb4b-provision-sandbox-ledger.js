#!/usr/bin/env node
/**
 * F-SB4B — TEMPORARY sandbox ledger-tab provisioner. DELETE IN F-SB4C.
 *
 * Creates `Session_Plans` and `Session_Plan_Sets` in the repository-declared SANDBOX
 * workbook only, with the canonical headers from `config/columns.js`, so the F-SB4
 * owner-pattern rehearsal can prove scorecard items 11 and 12 (exact Session_Plans
 * events, exact Session_Plan_Sets binding and seal behavior). Without those tabs the
 * plan-ledger writers fail closed with `tab_missing` and the rehearsal cannot show the
 * canonical `substituted` item_outcome that Sessions 1, 2, 3 and 5 exist to test.
 *
 * ── AUTHORIZATION ──────────────────────────────────────────────────────────────
 * Owner ruling of 2026-08-02, option A, recorded in docs/ATLAS_V1_EXECUTION_PLAN.md
 * under "OWNER AUTHORIZATION 2026-08-02 — F-SB4B option A". It authorizes exactly this
 * and nothing wider:
 *   - the DECLARED SANDBOX WORKBOOK ONLY;
 *   - those two tabs only, with the canonical headers only;
 *   - as a TEMPORARY BRIDGE, removed in F-SB4C;
 *   - no production workbook schema change, and no production data written;
 *   - no broader schema-creation capability and no permanent fallback.
 *
 * ── WHY THIS IS A SEPARATE OPERATOR SCRIPT, NOT AN APP CAPABILITY ──────────────
 * The app must stay structurally unable to create a tab. `ensureSheetTab` is NOT on the
 * plan-ledger write path and the gate harness's sandbox guard refuses it unconditionally
 * — both of which this script leaves exactly as they are. Provisioning happens ONCE, out
 * of band, deliberately, by a human-run command that names its own authorization. That
 * keeps "the app never changes a schema" true while still letting the rehearsal run.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────────
 *   - The target workbook is `config/sandboxSheet.js`'s literal. It is never read from
 *     the environment: the ambient GOOGLE_SHEETS_ID resolves to a NON-sandbox workbook
 *     in an operator shell, so inheriting it would point this at production. It is
 *     asserted against the declared constant and refuses on any mismatch.
 *   - It creates ONLY the two named tabs. An existing tab is left untouched.
 *   - It writes ONLY a header row, and only when row 1 is empty.
 *   - It never deletes, never rewrites a populated cell, and never touches any other tab.
 *   - `--apply` is required; the default is a dry run that reports what it would do.
 *
 * Usage:
 *   node scripts/fsb4b-provision-sandbox-ledger.js            # dry run
 *   node scripts/fsb4b-provision-sandbox-ledger.js --apply    # create
 */

'use strict';

const { google } = require('googleapis');
const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6, isSandboxSpreadsheetId } =
  require('../config/sandboxSheet');
const { sessionPlansColumns, sessionPlanSetsColumns } = require('../config/columns');

// Exactly the two tabs the owner authorized, with exactly the canonical headers.
const AUTHORIZED_TABS = [
  { title: 'Session_Plans', header: sessionPlansColumns },
  { title: 'Session_Plan_Sets', header: sessionPlanSetsColumns },
];

function fail(message) {
  process.stderr.write(`F-SB4B provisioner REFUSED: ${message}\n`);
  process.exitCode = 2;
}

async function main() {
  const apply = process.argv.includes('--apply');

  // The one workbook this script may ever touch, asserted rather than assumed.
  const spreadsheetId = SANDBOX_SPREADSHEET_ID;
  if (!isSandboxSpreadsheetId(spreadsheetId)) {
    return fail('the resolved workbook is not the declared sandbox');
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return fail('GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be exported');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      type: 'service_account',
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const present = new Set((meta.data.sheets || []).map(s => String(s.properties.title || '')));

  process.stdout.write(`F-SB4B sandbox ledger provisioner — workbook last6 ${SANDBOX_SPREADSHEET_ID_LAST6}\n`);
  process.stdout.write(apply ? 'mode: APPLY\n\n' : 'mode: DRY RUN (pass --apply to create)\n\n');

  for (const tab of AUTHORIZED_TABS) {
    const exists = present.has(tab.title);
    if (!exists) {
      process.stdout.write(`${tab.title}: MISSING → create with ${tab.header.length} canonical columns\n`);
      if (apply) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: tab.title } } }] },
        });
      }
    } else {
      process.stdout.write(`${tab.title}: already present → left untouched\n`);
    }

    // Seed the header ONLY when row 1 is genuinely empty. An existing header — even a
    // wrong one — is left alone and reported, because silently rewriting a populated
    // row is a data rewrite, not provisioning.
    if (apply || exists) {
      let firstRow = null;
      if (exists) {
        const cur = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab.title}!1:1` });
        firstRow = (cur.data.values && cur.data.values[0]) || null;
      }
      if (!firstRow || !firstRow.length) {
        process.stdout.write(`${tab.title}: header row empty → seed canonical header\n`);
        if (apply) {
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${tab.title}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [[...tab.header]] },
          });
        }
      } else {
        const matches = firstRow.length === tab.header.length &&
          tab.header.every((c, i) => String(firstRow[i] || '').trim() === c);
        process.stdout.write(`${tab.title}: header present → ${matches ? 'matches the contract' : 'DOES NOT MATCH the contract (left untouched; investigate)'}\n`);
      }
    }
  }

  process.stdout.write('\nDone. This script is temporary F-SB4B machinery and is deleted in F-SB4C.\n');
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`F-SB4B provisioner failed: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}

module.exports = { AUTHORIZED_TABS };
