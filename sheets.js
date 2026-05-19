const { google } = require('googleapis');

const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
const logSheetName = process.env.LOG_SHEET_NAME || 'Log';
const effortSheetName = process.env.EFFORT_SHEET_NAME || 'Effort';

function validateConfig() {
  if (!spreadsheetId || !clientEmail || !privateKeyRaw) {
    throw new Error(
      'Missing Google Sheets configuration. Set GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_PRIVATE_KEY in your environment.'
    );
  }
}

function getPrivateKey() {
  return privateKeyRaw.replace(/\\n/g, '\n');
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: getPrivateKey(),
      type: 'service_account'
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function appendRows(tabName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Rows must be a non-empty array.');
  }

  console.log(`[sheets.js] Appending ${rows.length} row(s) to "${tabName}" tab`);
  console.log(`[sheets.js] Row data:`, JSON.stringify(rows));

  const sheets = await getSheetsClient();
  const range = `${tabName}!A1`;
  console.log(`[sheets.js] Using range: ${range} for spreadsheet ID: ${spreadsheetId}`);
  
  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: rows
    }
  });

  console.log(`[sheets.js] API Response - Updated range: ${response.data.updates?.updatedRange}`);
  console.log(`[sheets.js] API Response - Updated rows: ${response.data.updates?.updatedRows}`);
  console.log(`[sheets.js] Successfully appended to "${tabName}". Full response:`, JSON.stringify(response.data));
  return response;
}

async function getColumnValues(tabName, column) {
  const sheets = await getSheetsClient();
  const range = `${tabName}!${column}:${column}`;
  console.log(`[sheets.js] Fetching column ${column} from ${tabName}`);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: 'COLUMNS'
  });

  return response.data.values?.[0] || [];
}

async function getExerciseCatalog() {
  const sheets = await getSheetsClient();
  const range = `Exercise_Catalog!A:Z`;
  console.log(`[sheets.js] Fetching Exercise_Catalog from range ${range}`);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  return response.data.values || [];
}

async function getRecentRows(tabName, maxRows = 100) {
  const sheets = await getSheetsClient();
  const range = `${tabName}!A:Z`;
  console.log(`[sheets.js] Fetching recent rows from ${tabName} range ${range}`);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  const rows = response.data.values || [];
  if (rows.length <= 1) return [];
  // exclude header row
  const dataRows = rows.slice(1);
  return dataRows.slice(-maxRows).map(r => r.map(cell => (cell === undefined ? '' : cell)));
}

async function getSpreadsheetTabs() {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title'
  });
  return (response.data.sheets || []).map(sheet => String(sheet.properties.title || ''));
}

async function getEffortSessionIds() {
  const values = await getColumnValues(effortSheetName, 'B');
  return values
    .map(value => String(value).trim())
    .filter(value => value && value.toLowerCase() !== 'session id');
}

async function getLogCompositeKeys() {
  // Fetch session_id (B), exercise (C), set_number (G) columns and combine to composite keys
  const sessionIds = await getColumnValues(logSheetName, 'B');
  const exercises = await getColumnValues(logSheetName, 'C');
  const setNumbers = await getColumnValues(logSheetName, 'G');

  const keys = [];
  const maxLen = Math.max(sessionIds.length, exercises.length, setNumbers.length);
  for (let i = 0; i < maxLen; i += 1) {
    const sid = String(sessionIds[i] || '').trim();
    const ex = String(exercises[i] || '').trim();
    const setn = String(setNumbers[i] || '').trim();
    if (!sid || !ex || !setn) continue;
    // Skip header rows that might contain column titles
    if (/session id/i.test(sid) || /exercise/i.test(ex) || /set_number/i.test(setn)) continue;
    keys.push(`${sid.toLowerCase()}||${ex.toLowerCase()}||${setn.toLowerCase()}`);
  }
  return keys;
}

module.exports = {
  appendRows,
  validateConfig,
  getExerciseCatalog,
  getEffortSessionIds,
  getLogCompositeKeys,
  getRecentRows,
  getSpreadsheetTabs,
  logSheetName,
  effortSheetName
};
