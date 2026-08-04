const { google } = require('googleapis');

const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
const logSheetName = process.env.LOG_SHEET_NAME || 'Log_Cleaned';
const effortSheetName = process.env.EFFORT_SHEET_NAME || 'Effort';
// One literal, declared in config/sandboxSheet.js — see that file for why this id
// may not be copied into a second module.
const { SANDBOX_SPREADSHEET_ID: sandboxSpreadsheetId } = require('./config/sandboxSheet');

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

function getSafeSpreadsheetConfig(environment = process.env.NODE_ENV) {
  const id = spreadsheetId ? String(spreadsheetId).trim() : '';
  const localMode = environment === 'development' || environment === 'test' || environment === 'local';
  return {
    canVerify: Boolean(id),
    source: 'GOOGLE_SHEETS_ID',
    idLast6: id ? id.slice(-6) : null,
    id: localMode && id ? id : null,
    exactIdExposed: Boolean(localMode && id),
    isSandboxSheet: id === sandboxSpreadsheetId
  };
}

// Append is NOT idempotent — each successful call inserts another row, and the
// write_id idempotency guard lives one layer up in index.js (it dedupes across
// separate HTTP requests, not inside this retry loop). So we may only retry on
// errors where Google rejected the request *before* touching the spreadsheet:
// HTTP 429 (rate limit), and the equivalent rate-limit/quota reason codes Google
// sometimes returns as 403 — both are pre-write rejections.
//
// WRITE-5: a 503 (backend unavailable), like a 500 or a post-send timeout, is
// AMBIGUOUS — the append may have been committed on Google's side before the
// backend failed to respond — so retrying it here can silently double-write. It
// therefore propagates and is never retried in this loop; recovery defers to the
// upstream write_id idempotency + composite-key dedupe, which make the client's
// retry at-most-once. Only unambiguous pre-write rejections (429 / 403 quota) are
// retried in-request.
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
  if (status === 429) return true;
  // Any other explicit status is non-retryable — a 500/503 (or its message) must
  // NEVER be re-classified as retryable by the reason text below, or we reintroduce
  // the ambiguous-post-send double-append this guard exists to prevent. The reason is
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

// ── The one authority for what a FAILED Sheets READ means ─────────────────────
//
// A read is IDEMPOTENT. That single fact is why this classifier exists beside
// `isTransientAppendError` rather than reusing it: the append guard deliberately
// refuses to retry a 500/503/timeout because the row may already be committed and
// a retry would silently double-write (WRITE-5 above). A read carries no such
// hazard, so the ambiguous-upstream statuses that are FATAL for an append are
// exactly the ones that are SAFE to retry for a read. Sharing one predicate across
// both would force one of the two to be wrong.
//
// Before this existed, every read helper below was a bare API call that threw an
// unclassified error, so five callers each invented their own meaning for it:
// `driftShadow` message-matched, `sessionPlanCapture` / `sessionPlanSetsCapture` /
// `sessionPlanStore` read ANY failure as "the tab does not exist", and every
// `routes/reads.js` handler read ANY failure as a hard 500. The capture guess was
// the dangerous one — `tab_missing` is a member of `VERIFIED_EMPTY_SEAL_REASONS`
// (services/turnWriteArtifact.js), so a momentary Google outage could present as a
// VERIFIED-empty ledger. A missing tab is a durable schema fact the owner must fix;
// a transient outage is a retry. They must never collapse into each other.
//
// Three kinds, and only three — and NONE of them is "the tab is missing", because a
// single error object cannot prove that:
//   'range_unresolved' — Google could not resolve the requested range: HTTP 400,
//                   "Unable to parse range: <Tab>!A1". That wording has TWO causes —
//                   the tab is genuinely absent, OR the A1 range itself is malformed
//                   (a caller bug, an unescaped tab name, a bad column letter). The
//                   classifier cannot tell them apart, so it does not try. Absence is
//                   a DURABLE SCHEMA FACT and is established only by
//                   `confirmTabMissing` below, never inferred from wording. A 404 is
//                   not this either: it means the SPREADSHEET is missing or the id is
//                   wrong, which must never read as "that tab is empty".
//   'transient'   — the request did not complete for a reason unrelated to what the
//                   spreadsheet contains: rate limit, backend error, timeout, or a
//                   dropped socket. Bounded retry is safe and correct.
//   'permanent'   — anything else: bad credentials, revoked access, a missing
//                   spreadsheet. Retrying cannot help; fail closed.
// 408 is here and NOT in the append guard, and that is the whole point of keeping the
// two separate: a request timeout means the server gave up waiting for the request,
// which is safe to repeat for an idempotent read and ambiguous for an append.
const TRANSIENT_READ_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_TRANSPORT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

function classifySheetsReadError(error) {
  if (!error) return 'permanent';
  // Same status-before-code ordering as isTransientAppendError, and for the same
  // reason: on a gaxios error `.code` is the transport cause, not the HTTP status.
  const status = Number(
    error.status != null ? error.status
      : (error.response && error.response.status != null) ? error.response.status
        : NaN
  );
  const apiError = (error.response && error.response.data && error.response.data.error) || null;
  const nested = (apiError && Array.isArray(apiError.errors)) ? apiError.errors : [];
  const message = String((error && error.message) || '');
  const apiMessage = String((apiError && apiError.message) || '');

  // EVERY place Google can name why it rejected the request, tested together rather
  // than in `first || second` order. The order mattered and was wrong: a Sheets quota
  // rejection arrives as HTTP 403 with `error.status: 'PERMISSION_DENIED'` AND
  // `error.errors[0].reason: 'userRateLimitExceeded'` — the errors array nested under
  // `response.data.error`, not on the error object. So the truthy 'PERMISSION_DENIED'
  // short-circuited the check, the nested reason was never read at all, and a
  // retryable quota response was classified permanent. Collect, then test all.
  const reasonSignals = [
    error.errors && error.errors[0] && error.errors[0].reason,
    apiError && apiError.status,
    apiMessage,
    ...nested.map(e => e && e.reason),
    ...nested.map(e => e && e.message),
    message,
  ].filter(Boolean).map(String);

  // Google's own range-parse rejection, matched narrowly — never a loose "not found",
  // which is also how a missing SPREADSHEET and a revoked permission read. This says
  // only that the range did not resolve. It does NOT say the tab is absent: the same
  // wording is returned for a malformed A1 range, and `readRange` accepts arbitrary
  // A1 from its callers. Claiming absence here would let a caller bug produce
  // `tab_missing`, which is a member of VERIFIED_EMPTY_SEAL_REASONS — a malformed
  // range could then present a ledger as verified-empty. Use `confirmTabMissing`.
  const RANGE_PARSE = /unable to parse range/i;
  if (RANGE_PARSE.test(message) || RANGE_PARSE.test(apiMessage)
    || nested.some(e => e && RANGE_PARSE.test(String(e.message || '')))) {
    return 'range_unresolved';
  }

  if (TRANSIENT_READ_STATUSES.has(status)) return 'transient';
  // A 403 is transient ONLY when Google names rate limiting or quota; a 403 for a
  // revoked service account is permanent and must not be retried three times.
  if (status === 403) {
    return reasonSignals.some(s => /rateLimit|quota|RESOURCE_EXHAUSTED/i.test(s)) ? 'transient' : 'permanent';
  }
  // Any other explicit HTTP status is a decision the server made about this exact
  // request; repeating it produces the same answer.
  if (Number.isFinite(status)) return 'permanent';

  // No HTTP status at all — the request never got an answer. Now the transport code
  // is the signal, and a bare socket failure is retryable.
  const code = String((error && error.code) || '');
  if (TRANSIENT_TRANSPORT_CODES.has(code)) return 'transient';
  if (/socket hang up|network|timeout|timed out|ECONNRESET|EAI_AGAIN/i.test(message)) return 'transient';
  return 'permanent';
}

function isTransientReadError(error) {
  return classifySheetsReadError(error) === 'transient';
}

// ── The only way to establish that a tab is absent ────────────────────────────
//
// `tab_missing` is a DURABLE SCHEMA FACT: it tells the owner to create a tab, and
// it is one of only two reasons that let a closeout be read as a VERIFIED-empty
// ledger (VERIFIED_EMPTY_SEAL_REASONS, services/turnWriteArtifact.js). A fact that
// consequential may not be inferred from an error message.
//
// The wording alone is not proof. Google returns "Unable to parse range" both when
// the tab is genuinely absent AND when the A1 range is malformed — an unescaped tab
// name, a bad column letter, a caller passing arbitrary A1 to `readRange`. Treating
// the message as absence would let a programming error present a ledger as
// verified-empty.
//
// So absence requires TWO independent things, both confirmed here:
//   1. the spreadsheet metadata was READABLE — we successfully looked; and
//   2. the specifically requested tab is NOT in it.
//
// Everything else answers false, and the caller reports an ordinary read error:
// a malformed range against a tab that DOES exist, a metadata read that failed, a
// caller with no tab name to confirm, or an error that never mentioned the range.
// Fail closed in every direction — the cost of a false `error` is a retry, and the
// cost of a false `tab_missing` is an unverified ledger presented as verified.
//
// `opts.listTabs` is injectable for the same reason `retryWithBackoff` takes a
// `sleep`: a test must be able to drive this without a live spreadsheet. Production
// callers pass nothing and get the real, bounded-retry metadata read.
async function confirmTabMissing(error, tabName, opts = {}) {
  if (classifySheetsReadError(error) !== 'range_unresolved') return false;
  const name = String(tabName == null ? '' : tabName).trim();
  if (!name) return false; // nothing to confirm against ⇒ never claim absence
  const listTabs = opts.listTabs || getSpreadsheetTabs;
  let tabs;
  try {
    tabs = await listTabs();
  } catch (_) {
    return false; // could not look ⇒ not evidence of absence
  }
  if (!Array.isArray(tabs)) return false;
  return !tabs.includes(name);
}

// Bounded, read-only retry. Shorter and shallower than the append profile: a read
// sits in front of a user-facing request, so the worst case here is 3 attempts and
// ~0.9s of added latency, not a 3.5s stall. `options` exists so a test can inject
// its own `sleep` and prove the policy without waiting on the wall clock; the
// helpers below always call it with the default profile.
const READ_RETRY_DEFAULTS = { maxAttempts: 3, baseDelayMs: 300 };

function readWithRetry(label, operation, options = {}) {
  return retryWithBackoff(operation, {
    ...READ_RETRY_DEFAULTS,
    ...options,
    isRetryable: isTransientReadError,
    onRetry: (error, attempt, delay) => {
      console.warn(`[sheets.js] Transient read error on ${label} (attempt ${attempt}): ${error.message}. Retrying in ${delay}ms`);
    }
  });
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

  const response = await readWithRetry(range, () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    majorDimension: 'COLUMNS'
  }));

  return response.data.values?.[0] || [];
}

async function getExerciseCatalog() {
  const sheets = await getSheetsClient();
  const range = `Exercise_Catalog!A:Z`;
  console.log(`[sheets.js] Fetching Exercise_Catalog from range ${range}`);

  const response = await readWithRetry(range, () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  }));

  return response.data.values || [];
}

async function getRecentRows(tabName, maxRows = 100) {
  const sheets = await getSheetsClient();
  const range = `${tabName}!A:Z`;
  console.log(`[sheets.js] Fetching recent rows from ${tabName} range ${range}`);

  const response = await readWithRetry(range, () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  }));

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

  const response = await readWithRetry(range, () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  }));

  const rows = response.data.values || [];
  if (rows.length <= 1) return [];
  const dataRows = rows.slice(1).map(row => row.map(cell => (cell === undefined ? '' : cell)));
  return Number.isFinite(maxRows) ? dataRows.slice(0, maxRows) : dataRows;
}

async function getHeaderRow(tabName) {
  const sheets = await getSheetsClient();
  const range = `${tabName}!1:1`;
  console.log(`[sheets.js] Fetching header row from ${tabName}`);

  const response = await readWithRetry(range, () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  }));

  return response.data.values?.[0] || [];
}

async function getSpreadsheetTabs() {
  const sheets = await getSheetsClient();
  const response = await readWithRetry('spreadsheet metadata', () => sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties'
  }));
  return (response.data.sheets || []).map(sheet => String(sheet.properties.title || ''));
}

// NOT wrapped in readWithRetry, deliberately. This helper CREATES a tab: its reads
// are the probe that decides whether to run a schema mutation, so retrying them
// changes when a tab gets created, not merely how a read is reported. It is a
// write-path helper that happens to read, and it stays outside the read-robustness
// change. test/sheetsReadFailureAuthority.test.js pins that exclusion.
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
  // Composite keys need session_id (B), exercise (C) and set_number (G). Those
  // three columns fall inside the contiguous B:G span, so a SINGLE range read
  // (ROWS-major) fetches them together — one API request instead of the three
  // per-column reads this used to issue. On the Save hot path (dry-run preview +
  // live write, once each) that removes two redundant Log_Cleaned reads per
  // request; during a gym session's burst of Saves that is real quota saved.
  // Result is identical: within each row, index 0 is B, 1 is C, 5 is G; a row
  // missing any of the three, or a header row, is skipped exactly as before.
  const sheets = await getSheetsClient();
  const range = `${logSheetName}!B:G`;
  console.log(`[sheets.js] Fetching composite-key columns from ${logSheetName} range ${range}`);

  const response = await readWithRetry(range, () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  }));
  const rows = response.data.values || [];

  const keys = [];
  for (const row of rows) {
    const sid = String((row && row[0]) || '').trim();   // column B — session_id
    const ex = String((row && row[1]) || '').trim();    // column C — exercise
    const setn = String((row && row[5]) || '').trim();  // column G — set_number
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
  const response = await readWithRetry(rangeA1, () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rangeA1
  }));
  return response.data.values || [];
}

// F10D closeout seal — a BOUNDED batch update of ONE column's cells. cells is
// [{ row, value }] with `row` the 1-based SHEET row (header = row 1). This is the
// only value-update primitive in sheets.js: it can never touch more than the named
// column, and callers pass explicit rows — no ranges are inferred. Contiguous rows
// are grouped into single ranges to keep the batch small. Returns the raw API
// response; the AUTHORITATIVE proof is response.data.totalUpdatedCells.
async function updateColumnCells(tabName, columnLetter, cells) {
  if (!/^[A-Z]{1,2}$/.test(String(columnLetter || ''))) {
    throw new Error('updateColumnCells: columnLetter must be an A1 column letter.');
  }
  const list = Array.isArray(cells) ? cells : [];
  if (list.length === 0) throw new Error('updateColumnCells: cells must be a non-empty array.');
  for (const c of list) {
    if (!c || !Number.isInteger(c.row) || c.row < 2) {
      throw new Error('updateColumnCells: each cell needs an integer sheet row ≥ 2 (row 1 is the header).');
    }
  }
  // Group contiguous rows (sorted) into single-column ranges.
  const sorted = [...list].sort((a, b) => a.row - b.row);
  const data = [];
  let run = null;
  for (const c of sorted) {
    if (run && c.row === run.end + 1) {
      run.end = c.row;
      run.values.push([String(c.value == null ? '' : c.value)]);
    } else {
      if (run) data.push(run);
      run = { start: c.row, end: c.row, values: [[String(c.value == null ? '' : c.value)]] };
    }
  }
  if (run) data.push(run);

  console.log(`[sheets.js] Updating ${list.length} cell(s) in "${tabName}" column ${columnLetter} (${data.length} range(s))`);
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: data.map(r => ({
        range: `${tabName}!${columnLetter}${r.start}:${columnLetter}${r.end}`,
        values: r.values
      }))
    }
  });
  console.log(`[sheets.js] Updated ${response.data.totalUpdatedCells} cell(s) in "${tabName}"`);
  return response;
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
  updateColumnCells,
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
  getSafeSpreadsheetConfig,
  isTransientAppendError,
  retryWithBackoff,
  classifySheetsReadError,
  isTransientReadError,
  confirmTabMissing,
  readWithRetry,
  logSheetName,
  effortSheetName
};
