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

module.exports = {
  appendRows,
  validateConfig,
  logSheetName,
  effortSheetName
};
