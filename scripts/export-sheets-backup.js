#!/usr/bin/env node
/**
 * Atlas sheet backup exporter (READ-ONLY).
 *
 * Exports every tab of the production spreadsheet to timestamped JSON and CSV
 * files under ./backups/<timestamp>/. Never writes to Google Sheets.
 *
 * Usage:
 *   node scripts/export-sheets-backup.js            # back up all tabs
 *   node scripts/export-sheets-backup.js Log_Cleaned Effort   # specific tabs
 *
 * Requires the same env vars as the server: GOOGLE_SHEETS_ID,
 * GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

function toCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function rowsToCsv(rows) {
  return rows.map(row => row.map(toCsvCell).join(',')).join('\n') + '\n';
}

function buildBackupManifest({ spreadsheetId, tabs, timestamp }) {
  return {
    spreadsheet_id: spreadsheetId,
    exported_at: timestamp,
    tab_count: tabs.length,
    tabs: tabs.map(tab => ({ name: tab.name, rows: tab.rowCount }))
  };
}

async function createReadOnlySheetsClient() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      type: 'service_account'
    },
    // Read-only scope: this script cannot write even if it tried. Every
    // Sheets call in this file must go through this client — never through
    // sheets.js helpers, which build a full-scope (write-capable) client.
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function listTabs(sheets, spreadsheetId) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title'
  });
  return (response.data.sheets || []).map(sheet => String(sheet.properties.title || ''));
}

async function main() {
  const { validateConfig } = require('../sheets');

  validateConfig();

  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const requestedTabs = process.argv.slice(2);

  const sheets = await createReadOnlySheetsClient();

  const allTabs = await listTabs(sheets, spreadsheetId);
  const tabsToExport = requestedTabs.length
    ? allTabs.filter(tab => requestedTabs.includes(tab))
    : allTabs;

  if (requestedTabs.length) {
    const missing = requestedTabs.filter(tab => !allTabs.includes(tab));
    if (missing.length) {
      console.error(`Requested tabs not found in spreadsheet: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'backups', timestamp);
  fs.mkdirSync(outDir, { recursive: true });

  const manifestTabs = [];
  for (const tabName of tabsToExport) {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!A:Z`
    });
    const rows = response.data.values || [];
    const safeName = tabName.replace(/[^a-zA-Z0-9_-]/g, '_');

    fs.writeFileSync(path.join(outDir, `${safeName}.json`), JSON.stringify(rows, null, 2));
    fs.writeFileSync(path.join(outDir, `${safeName}.csv`), rowsToCsv(rows));
    manifestTabs.push({ name: tabName, rowCount: rows.length });
    console.log(`Exported ${tabName}: ${rows.length} rows`);
  }

  const manifest = buildBackupManifest({ spreadsheetId, tabs: manifestTabs, timestamp });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\nBackup complete: ${outDir}`);
  console.log(`Tabs exported: ${manifestTabs.length}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Backup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { rowsToCsv, toCsvCell, buildBackupManifest, listTabs };
