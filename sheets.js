const { google } = require('googleapis');
const { AsyncLocalStorage } = require('node:async_hooks');

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

// ── Provenance stamp: "this error came from a Sheets READ, and here is its class" ──
//
// A route that catches an exception around a read cannot otherwise tell an INPUT
// failure from an INFRASTRUCTURE failure. Both are plain Errors, and asking
// `classifySheetsReadError` directly does not answer it: that function classifies
// what a Sheets failure MEANS, and answers 'permanent' for anything it is handed —
// including a validation Error that never touched Google. Reading it as a provenance
// test would turn every genuine input rejection into a server fault.
//
// So the read path stamps its own escaping errors, HERE, where provenance is a fact
// rather than a guess. `classifySheetsReadError` stays the single authority for the
// class; this only records what it already decided, at the boundary that knows the
// error came from a read. Callers ask `sheetsReadFailureClass(error)` and get null
// for everything else — no message matching, and no second classifier.
//
// Symbol.for + non-enumerable: it must not serialize into a response body, must not
// appear in logs that spread the error, and must survive a module identity split
// under the suite's require.cache injection.
const SHEETS_READ_FAILURE = Symbol.for('atlas.sheetsReadFailure');

function stampSheetsReadFailure(error, label) {
  if (!error || typeof error !== 'object') return error;
  // First stamp wins: the innermost read that actually failed owns the class. A
  // caller that catches and rethrows must never be able to relabel it.
  if (!error[SHEETS_READ_FAILURE]) {
    Object.defineProperty(error, SHEETS_READ_FAILURE, {
      value: { class: classifySheetsReadError(error), range: label },
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
  return error;
}

/**
 * The read-failure class of an error that escaped a Sheets read, or null when the
 * error did not come from one. Null means "not infrastructure" — the caller keeps
 * whatever handling it already had.
 * @returns {'transient'|'permanent'|'range_unresolved'|null}
 */
function sheetsReadFailureClass(error) {
  const stamp = error && typeof error === 'object' ? error[SHEETS_READ_FAILURE] : null;
  return stamp ? stamp.class : null;
}

async function readWithRetry(label, operation, options = {}) {
  try {
    return await retryWithBackoff(operation, {
      ...READ_RETRY_DEFAULTS,
      ...options,
      isRetryable: isTransientReadError,
      onRetry: (error, attempt, delay) => {
        console.warn(`[sheets.js] Transient read error on ${label} (attempt ${attempt}): ${error.message}. Retrying in ${delay}ms`);
      }
    });
  } catch (error) {
    // Every read helper below funnels through here, so stamping once covers them all
    // — including a retry ladder that exhausted on quota, which is the exact case the
    // Save path was reporting to the owner as invalid input.
    throw stampSheetsReadFailure(error, label);
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

// ───────────────────────────────────────────────────────────────────────────────
// Request-scoped read batching (F-SB4B session read budget).
//
// WHY. Qualifying session 1 spent 78 Sheets reads inside one rolling minute against
// a 60/minute quota and starved itself. `docs/READ_BUDGET.md` budgets reads PER SAVE,
// so it could not see that. The reconstruction (scripts/reconstruct-session-reads.js)
// shows the demand is not one expensive read — it is MANY separate `values.get` calls,
// several of them the SAME range inside the SAME HTTP request.
//
// The mechanism is `spreadsheets.values.batchGet`: N ranges needed by one request cost
// ONE quota unit instead of N. Two rules keep it honest, and they are the whole design:
//
//   1. A batch lives for exactly ONE HTTP request. It is never a cross-request snapshot
//      of write-sensitive evidence. Log_Cleaned dedup keys, Effort session ids,
//      Deload_State, header-drift rows and the Session_Plans / Session_Plan_Sets ledger
//      are read FRESH on every request that consumes them — batching changes only how
//      many API calls carry them, never how old they are.
//   2. This adapter TRANSPORTS values. It parses nothing. Every helper below keeps its
//      own parsing and normalization, so the authority for interpreting a range is
//      unchanged whether the values arrived in a batch or in a single read.
//
// A write inside the request invalidates the written tab (see `invalidateTabCache`), so
// a read-after-write in the same request can never be served a pre-write value.
const readContextStorage = new AsyncLocalStorage();

/** Key a range so a COLUMNS-major read is never confused with a ROWS-major one. */
function cacheKey(range, majorDimension) {
  return majorDimension === 'COLUMNS' ? `${range}#COLUMNS` : range;
}

/** The tab a range belongs to. `Log_Cleaned!B:G` → `Log_Cleaned`; a bare tab name → itself. */
function tabOfRange(range) {
  const text = String(range || '');
  const bang = text.indexOf('!');
  return (bang === -1 ? text : text.slice(0, bang)).replace(/^'|'$/g, '');
}

/**
 * Run `fn` with a fresh request-scoped read context. Every read issued inside it is
 * deduplicated by range, and ranges declared through `declareRequestRanges` are fetched
 * in a single `values.batchGet` when the first of them is actually read. Outside a context every helper behaves exactly as before —
 * one read, one API call — so scripts and tests are unaffected.
 */
function runWithReadContext(fn) {
  return readContextStorage.run({ values: new Map(), inflight: new Map(), declared: null }, fn);
}

function currentReadContext() {
  return readContextStorage.getStore() || null;
}

/**
 * Declare the ranges this request is expected to need. Records the declaration; it
 * issues NOTHING by itself.
 *
 * Laziness is the load-bearing part, not an optimisation. An eager prefetch charges a
 * request for a batch even when the handler goes on to read nothing, so a route whose
 * declaration is broader than the path it actually takes would COST a read it never used
 * to make — measured at +6 reads across one session before this was made lazy. Deferring
 * to the first real read means the batch is paid for only by a request that was going to
 * read anyway, which is what makes an over-broad declaration genuinely free.
 *
 * No-op outside a request context.
 */
function declareRequestRanges(ranges) {
  const ctx = currentReadContext();
  if (!ctx) return;
  const wanted = [...new Set((Array.isArray(ranges) ? ranges : []).map(r => String(r || '')).filter(Boolean))];
  if (wanted.length) ctx.declared = wanted;
}

/**
 * Issue the declared ranges (plus `alsoNeeded`, the range that triggered this) as ONE
 * batchGet, and register each range's slice as in-flight.
 *
 * Failure is DEFERRED, deliberately: the rejection is only raised by a helper that
 * actually asks for one of these ranges. A declaration is allowed to be broader than a
 * given code path, so a range this request never reads must not be able to fail it. A
 * range the batch could not resolve falls back to an individual read, which preserves the
 * per-range `range_unresolved` handling callers already depend on (an optional tab such
 * as Deload_State is simply absent, not an error).
 */
function flushDeclaredRanges(ctx, alsoNeeded) {
  const declared = ctx.declared || [];
  ctx.declared = null;
  const wanted = [...new Set([alsoNeeded, ...declared])]
    .filter(range => !ctx.values.has(range) && !ctx.inflight.has(range));
  if (wanted.length < 2) return false;   // one range is a plain get; a batch would cost the same

  const label = `batchGet(${wanted.length} ranges)`;
  const promise = (async () => {
    const sheets = await getSheetsClient();
    console.log(`[sheets.js] Batch reading ${wanted.length} range(s): ${wanted.join(', ')}`);
    const response = await readWithRetry(label, () => sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: wanted
    }));
    const valueRanges = response.data.valueRanges || [];
    // batchGet returns valueRanges positionally, in the order the ranges were requested.
    // The `range` field it echoes is the RESOLVED A1 (`Log_Cleaned!B1:G997`), not the
    // requested string, so position is the only sound mapping. If the count ever fails to
    // match, refuse to guess: mapping the wrong values onto a range would hand a caller
    // another tab's data, which is worse than an extra read.
    if (valueRanges.length !== wanted.length) {
      throw new Error(`batchGet returned ${valueRanges.length} ranges for ${wanted.length} requested`);
    }
    const byRange = new Map();
    wanted.forEach((range, index) => byRange.set(range, valueRanges[index].values || []));
    return byRange;
  })();
  // Swallow here only so an unawaited rejection cannot crash the process; the error is
  // re-raised by `readValues` for the range that actually needs it.
  promise.catch(() => {});

  for (const range of wanted) {
    const slice = (async () => {
      const byRange = await promise;
      const values = byRange.get(range) || [];
      ctx.values.set(range, values);
      return values;
    })();
    slice.catch(() => {});
    ctx.inflight.set(range, slice);
  }
  return true;
}

/**
 * The single funnel every read helper below uses. Serves a request-scoped hit when one
 * exists, joins an in-flight fetch for the same range rather than issuing a second, and
 * otherwise performs exactly the `values.get` the helper used to perform itself.
 */
async function readValues(range, { majorDimension } = {}) {
  const key = cacheKey(range, majorDimension);
  const ctx = currentReadContext();

  if (ctx) {
    if (ctx.values.has(key)) return ctx.values.get(key);
    // First read of the request: collapse this range and everything the route declared
    // into one batchGet. A COLUMNS-major read stays out — batchGet carries one
    // majorDimension for the whole call, so mixing them would reshape the values.
    if (ctx.declared && !majorDimension) flushDeclaredRanges(ctx, key);
    const pending = ctx.inflight.get(key);
    if (pending) {
      try {
        return await pending;
      } catch (error) {
        // The batch that carried this range failed. A structural failure (a range that
        // does not resolve) degrades to the individual read this helper would have made,
        // so nothing about optional-tab handling changes. A transient or permanent
        // failure is the answer: it is exactly what a single read would have returned,
        // and it keeps the PR #1270 read-failure class intact for the 503 path.
        if (sheetsReadFailureClass(error) !== 'range_unresolved') throw error;
        ctx.inflight.delete(key);
      }
    }
  }

  const fetch = (async () => {
    const sheets = await getSheetsClient();
    console.log(`[sheets.js] Reading range ${range}`);
    const response = await readWithRetry(range, () => sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      ...(majorDimension ? { majorDimension } : {})
    }));
    return response.data.values || [];
  })();

  if (!ctx) return fetch;

  ctx.inflight.set(key, fetch);
  fetch.catch(() => {});
  try {
    const values = await fetch;
    ctx.values.set(key, values);
    return values;
  } finally {
    ctx.inflight.delete(key);
  }
}

/**
 * Drop every request-scoped value for one tab. Called by each write primitive so a
 * read-after-write inside the same request re-reads the sheet instead of replaying a
 * value captured before the write. Deload_State depends on this: begin/advance/resolve
 * append a row, and the state read after that append must see it.
 */
function invalidateTabCache(tabName) {
  const ctx = currentReadContext();
  if (!ctx) return;
  const tab = tabOfRange(tabName);
  for (const map of [ctx.values, ctx.inflight]) {
    for (const key of [...map.keys()]) {
      if (tabOfRange(key) === tab) map.delete(key);
    }
  }
  if (ctx.declared) {
    const kept = ctx.declared.filter(range => tabOfRange(range) !== tab);
    ctx.declared = kept.length ? kept : null;
  }
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
  invalidateTabCache(tabName);
  return response;
}

async function getColumnValues(tabName, column) {
  const range = `${tabName}!${column}:${column}`;
  const values = await readValues(range, { majorDimension: 'COLUMNS' });
  return (values[0] || []).slice();
}

/**
 * Exercise_Catalog — the ONE approved cross-request cache.
 *
 * It qualifies where no other range does: it is reference data the athlete's own writes
 * never touch on the Save path, and it was the single most-read range of the failed
 * session (14 of 78 reads). Every other range in this file stays uncached, because a
 * dedup key, an Effort session id, a Deload_State row, a header row or a ledger record is
 * write-sensitive evidence and a stale copy of it would corrupt a decision.
 *
 * The contract, and the reason for each clause:
 *   • server-owned — the value is read from the sheet, never supplied by a client;
 *   • bounded TTL, at most 60 s — a catalog edit is visible within one minute;
 *   • single-flight — simultaneous misses join ONE request instead of stampeding;
 *   • explicit expiry — an expired entry is DISCARDED at the point it expires, so no
 *     later branch can serve it;
 *   • no stale-after-expiry fallback — a failed refresh THROWS. It never returns the
 *     previous value, because a silently-frozen catalog is how a wrong lift_code gets
 *     written to the permanent record;
 *   • failure propagates — the error keeps the `readWithRetry` stamp, so the truthful
 *     503 classification from PR #1270 still applies to it;
 *   • never fabricates — an empty result is never cached and `[]` is never synthesized
 *     from an error. A caller that sees an empty catalog is seeing the sheet.
 */
const CATALOG_CACHE_TTL_MS = 60_000;
let catalogCacheEntry = null;     // { values, expiresAt }
let catalogCacheInflight = null;  // single-flight
const catalogCacheStats = { hits: 0, fetches: 0 };

async function getExerciseCatalog({ now = Date.now } = {}) {
  if (catalogCacheEntry) {
    if (now() < catalogCacheEntry.expiresAt) {
      catalogCacheStats.hits += 1;
      return catalogCacheEntry.values.slice();
    }
    // Explicit expiry: drop it here so no path below can fall back to it.
    catalogCacheEntry = null;
  }
  if (catalogCacheInflight) return catalogCacheInflight;

  const range = `Exercise_Catalog!A:Z`;
  catalogCacheStats.fetches += 1;
  catalogCacheInflight = (async () => {
    const sheets = await getSheetsClient();
    console.log(`[sheets.js] Fetching Exercise_Catalog from range ${range}`);
    const response = await readWithRetry(range, () => sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    }));
    // Outer-array copy for the same reason as readRange, and it matters more here: this
    // array outlives the request, so one caller's mutation would reach every later one.
    const values = (response.data.values || []).slice();
    // An empty catalog is never cached. It is far more likely to be a transient read of a
    // sheet mid-edit than the truth, and caching it would blind enrichment for a minute.
    if (values.length > 0) catalogCacheEntry = { values, expiresAt: now() + CATALOG_CACHE_TTL_MS };
    return values;
  })();

  try {
    return await catalogCacheInflight;
  } finally {
    catalogCacheInflight = null;
  }
}

/** Test-only: forget the catalog cache so a test starts from a cold, honest state. */
function _resetExerciseCatalogCache() {
  catalogCacheEntry = null;
  catalogCacheInflight = null;
  catalogCacheStats.hits = 0;
  catalogCacheStats.fetches = 0;
}

async function getRecentRows(tabName, maxRows = 100) {
  const range = `${tabName}!A:Z`;
  const rows = await readValues(range);
  if (rows.length <= 1) return [];
  // exclude header row
  const dataRows = rows.slice(1).map(row => row.map(cell => (cell === undefined ? '' : cell)));
  return dataRows.slice(-maxRows);
}

async function getSheetRows(tabName, maxRows = Infinity) {
  const range = `${tabName}!A:Z`;
  const rows = await readValues(range);
  if (rows.length <= 1) return [];
  const dataRows = rows.slice(1).map(row => row.map(cell => (cell === undefined ? '' : cell)));
  return Number.isFinite(maxRows) ? dataRows.slice(0, maxRows) : dataRows;
}

async function getHeaderRow(tabName) {
  const range = `${tabName}!1:1`;
  const values = await readValues(range);
  return (values[0] || []).slice();
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
  const range = `${logSheetName}!B:G`;
  const rows = await readValues(range);

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
  // Outer-array copy: a request-scoped hit hands back the SAME array to every caller in
  // the request, so returning it raw would let one caller's mutation reach the next.
  return (await readValues(rangeA1)).slice();
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
  invalidateTabCache(tabName);
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
  invalidateTabCache(tabName);
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
  sheetsReadFailureClass,
  confirmTabMissing,
  readWithRetry,
  logSheetName,
  effortSheetName,
  // Request-scoped read batching (F-SB4B session read budget).
  runWithReadContext,
  declareRequestRanges,
  invalidateTabCache,
  CATALOG_CACHE_TTL_MS,
  _resetExerciseCatalogCache,
  _exerciseCatalogCacheStats: () => ({ ...catalogCacheStats })
};
