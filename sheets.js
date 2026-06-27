const { google } = require('googleapis');

const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
const logSheetName = process.env.LOG_SHEET_NAME || 'Log_Cleaned';
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

// Append is NOT idempotent — each successful call inserts another row, and the
// write_id idempotency guard lives one layer up in index.js (it dedupes across
// separate HTTP requests, not inside this retry loop). So we may only retry on
// errors where Google rejected the request *before* touching the spreadsheet:
// HTTP 429 (rate limit) / 503 (backend unavailable), and the equivalent
// rate-limit/quota reason codes Google sometimes returns as 403. A post-send
// timeout or a 500 is ambiguous — the rows might already be written — so those
// propagate and are never retried, to avoid a silent double-append.
function isTransientAppendError(error) {
  if (!error) return false;
  // Read the numeric HTTP status FIRST. On a gaxios GaxiosError (gaxios 7 via
  // googleapis), the HTTP status lives on `.status` / `.response.status`, while
  // `.code` is the transport cause (e.g. 'ETIMEDOUT') — non-numeric. Reading
  // `.code` first would turn a real 429/503 into NaN and silently skip the retry.
  const status = Number(
    error.status != null ? error.status
      : (error.response && error.response.status != null) ? error.response.status
        : error.code
  );
  if (status === 429 || status === 503) return true;
  // Any other explicit status is non-retryable — a 500 (or its message) must NEVER
  // be re-classified as retryable by the reason text below, or we reintroduce the
  // ambiguous-post-send double-append this guard exists to prevent. The reason is
  // consulted ONLY for a 403 (quota/rate-limit rejection — rejected before write)
  // or a status-less error. The reason match is correspondingly narrow:
  // rate-limit/quota only (NOT backendError/unavailable, which are 500/503 signals).
  if (Number.isFinite(status) && status !== 403) return false;
  const reason = (error.errors && error.errors[0] && error.errors[0].reason)
    || (error.response && error.response.data && error.response.data.error
      && (error.response.data.error.status || error.response.data.error.message))
    || '';
  return /rateLimit|quota/i.test(String(reason));
}

// Bounded exponential backoff. `sleep` is injectable so tests run instantly and
// don't depend on wall-clock time. Retries only while `isRetryable(error)` is
// true; any non-retryable error throws immediately, and the last error throws
// once attempts are exhausted.
async function retryWithBackoff(operation, options = {}) {
  const maxAttempts = options.maxAttempts || 4; // 1 initial + 3 retries
  const baseDelayMs = options.baseDelayMs || 500; // 500 / 1000 / 2000
  const isRetryable = options.isRetryable || (() => false);
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const onRetry = options.onRetry || (() => {});

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      onRetry(error, attempt, delay);
      await sleep(delay);
    }
  }
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

  const sheets = await getSheetsClient();
  const range = `${tabName}!A1`;
  console.log(`[sheets.js] Using range: ${range}`);
  
  const response = await retryWithBackoff(
    () => sheets.spreadsheets.values.append({
      spreadsheetId,
      range: range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: rows
      }
    }),
    {
      isRetryable: isTransientAppendError,
      onRetry: (error, attempt, delay) => {
        console.warn(`[sheets.js] Transient append error on "${tabName}" (attempt ${attempt}): ${error.message}. Retrying in ${delay}ms`);
      }
    }
  );

  console.log(`[sheets.js] Appended to "${tabName}": ${response.data.updates?.updatedRows} row(s) at ${response.data.updates?.updatedRange}`);
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
  const dataRows = rows.slice(1).map(row => row.map(cell => (cell === undefined ? '' : cell)));
  return dataRows.slice(-maxRows);
}

async function getSheetRows(tabName, maxRows = Infinity) {
  const sheets = await getSheetsClient();
  const range = `${tabName}!A:Z`;
  console.log(`[sheets.js] Fetching rows from ${tabName} range ${range}`);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  const rows = response.data.values || [];
  if (rows.length <= 1) return [];
  const dataRows = rows.slice(1).map(row => row.map(cell => (cell === undefined ? '' : cell)));
  return Number.isFinite(maxRows) ? dataRows.slice(0, maxRows) : dataRows;
}

async function getHeaderRow(tabName) {
  const sheets = await getSheetsClient();
  const range = `${tabName}!1:1`;
  console.log(`[sheets.js] Fetching header row from ${tabName}`);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  return response.data.values?.[0] || [];
}

async function getSpreadsheetTabs() {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties'
  });
  return (response.data.sheets || []).map(sheet => String(sheet.properties.title || ''));
}

async function ensureSheetTab(tabName, headerRow = []) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties'
  });
  const existing = (meta.data.sheets || []).find(sheet => sheet.properties.title === tabName);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: tabName }
          }
        }]
      }
    });
  }

  if (Array.isArray(headerRow) && headerRow.length) {
    const current = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!1:1`
    });
    if (!current.data.values || !current.data.values.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tabName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headerRow] }
      });
    }
  }
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

async function readRange(rangeA1) {
  const sheets = await getSheetsClient();
  console.log(`[sheets.js] Reading range ${rangeA1}`);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rangeA1
  });
  return response.data.values || [];
}

async function deleteRowsByRange(tabName, startIndex, endIndex) {
  // startIndex: 0-based inclusive. endIndex: 0-based exclusive.
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties'
  });
  const sheet = (meta.data.sheets || []).find(s => s.properties.title === tabName);
  if (!sheet) {
    throw new Error(`Sheet tab "${tabName}" not found in spreadsheet.`);
  }
  const sheetId = sheet.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex, endIndex }
        }
      }]
    }
  });
}

module.exports = {
  appendRows,
  readRange,
  deleteRowsByRange,
  validateConfig,
  getExerciseCatalog,
  getEffortSessionIds,
  getLogCompositeKeys,
  getRecentRows,
  getSheetRows,
  getHeaderRow,
  getSpreadsheetTabs,
  ensureSheetTab,
  isTransientAppendError,
  retryWithBackoff,
  logSheetName,
  effortSheetName
};
