'use strict';

// Reconstruct every Google Sheets READ ATTEMPT from a rehearsal/gate server log, and
// attribute each one to the HTTP request that issued it.
//
// Why this exists: F-SB4B qualifying session 1 (2026-08-05) exhausted its own Sheets
// read quota mid-session. `docs/READ_BUDGET.md` budgets reads PER SAVE and its guard
// counts sheets.js helpers — neither can see what a COMPLETE owner-pattern session
// actually demands in one rolling minute. This script measures the real thing from a
// real log, so the session budget is set from evidence rather than estimated.
//
// Attribution model, stated plainly because it bounds the result: sheets.js logs a read
// as it is issued, and the request logger logs a request when it COMPLETES. So a read
// belongs to the next completed request logged after it. Under concurrency that can
// misattribute a read between two overlapping requests — it never loses or invents one,
// so per-request counts are approximate while TOTALS are exact. Totals are what the
// budget is written against.
//
// Read-only: parses a text file, contacts nothing, writes nothing but its own report.

const fs = require('fs');

// One entry per API REQUEST, which is what Google's quota meters.
//
// Since the F-SB4B read-batching change, `sheets.js` logs a line only when it actually
// issues a request: a range served from the request-scoped batch, or from the
// Exercise_Catalog cache, prints nothing and costs nothing. The per-helper lines below
// ('Fetching rows from …', 'Fetching composite-key columns …', …) are the PRE-change
// wording and are kept so this script still reads the qualifying-session-1 log and any
// other archived log truthfully. A post-change log uses the first two patterns.
const READ_PATTERNS = [
  // label, regex capturing the range
  [/^\[sheets\.js\] Reading range (.+)$/, 'readValues'],
  [/^\[sheets\.js\] Batch reading \d+ range\(s\): (.+)$/, 'prefetchRanges'],
  [/^\[sheets\.js\] Fetching Exercise_Catalog from range (.+)$/, 'getExerciseCatalog'],
  [/^\[sheets\.js\] Fetching composite-key columns from Log_Cleaned range (.+)$/, 'getLogCompositeKeys'],
  [/^\[sheets\.js\] Fetching recent rows from \S+ range (.+)$/, 'getRecentRows'],
  [/^\[sheets\.js\] Fetching rows from \S+ range (.+)$/, 'getSheetRows'],
  [/^\[sheets\.js\] Fetching header row from (.+)$/, 'getHeaderRow'],
];
const RETRY_RE = /^\[sheets\.js\] Transient read error on (.+?) \(attempt (\d+)\)/;
const REQ_RE = /^\{"timestamp":"([^"]+)","method":"([^"]+)","path":"([^"]+)","status":(\d+)[^}]*"duration_ms":(\d+)/;

function reconstruct(logText) {
  const attempts = [];   // every read ATTEMPT, including retries
  const retries = [];
  let pending = [];      // reads seen since the last completed request

  for (const raw of logText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const retry = RETRY_RE.exec(line);
    if (retry) {
      retries.push({ range: retry[1], attempt: Number(retry[2]) });
      // A logged retry means the PREVIOUS attempt failed and another is being issued.
      pending.push({ caller: 'retry', range: retry[1], retry: true, attemptNo: Number(retry[2]) + 1 });
      continue;
    }

    let matched = false;
    for (const [re, caller] of READ_PATTERNS) {
      const m = re.exec(line);
      if (m) { pending.push({ caller, range: m[1], retry: false, attemptNo: 1 }); matched = true; break; }
    }
    if (matched) continue;

    const req = REQ_RE.exec(line);
    if (req) {
      const [, timestamp, method, path, status, duration] = req;
      for (const p of pending) {
        attempts.push({ ...p, timestamp, endpoint: `${method} ${path}`, status: Number(status), duration_ms: Number(duration) });
      }
      pending = [];
    }
  }
  // Reads issued before any request completed (server boot / preflight) or left dangling
  // by a request that never logged: keep them, attributed honestly as unattributed.
  for (const p of pending) attempts.push({ ...p, timestamp: null, endpoint: '(unattributed)', status: null, duration_ms: null });
  return { attempts, retries };
}

function summarize(attempts) {
  const byEndpoint = new Map();
  const byRange = new Map();
  const byCaller = new Map();
  for (const a of attempts) {
    byEndpoint.set(a.endpoint, (byEndpoint.get(a.endpoint) || 0) + 1);
    byRange.set(a.range, (byRange.get(a.range) || 0) + 1);
    byCaller.set(a.caller, (byCaller.get(a.caller) || 0) + 1);
  }
  const sortDesc = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]);
  return { byEndpoint: sortDesc(byEndpoint), byRange: sortDesc(byRange), byCaller: sortDesc(byCaller) };
}

/** Worst rolling-60s window of read ATTEMPTS — the number Google's quota actually meters. */
function peakRollingMinute(attempts) {
  const stamped = attempts.filter(a => a.timestamp).map(a => Date.parse(a.timestamp)).sort((a, b) => a - b);
  let peak = 0; let start = 0; let peakAt = null;
  for (let end = 0; end < stamped.length; end++) {
    while (stamped[end] - stamped[start] >= 60_000) start++;
    const count = end - start + 1;
    if (count > peak) { peak = count; peakAt = new Date(stamped[start]).toISOString(); }
  }
  return { peak, window_start: peakAt, stamped_total: stamped.length };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/reconstruct-session-reads.js <server-log.txt> [--json]');
    process.exit(2);
  }
  const { attempts, retries } = reconstruct(fs.readFileSync(file, 'utf8'));
  const s = summarize(attempts);
  const rolling = peakRollingMinute(attempts);
  const retryAttempts = attempts.filter(a => a.retry).length;

  const report = {
    total_read_attempts: attempts.length,
    retry_attempts: retryAttempts,
    // The demand that would exist with a healthy quota: attempts MINUS the extra
    // attempts retries added. This is the number a budget must be written against,
    // because retry amplification is a CONSEQUENCE of exceeding it, not a cause.
    counterfactual_no_quota_attempts: attempts.length - retryAttempts,
    peak_rolling_minute: rolling,
    unattributed: attempts.filter(a => a.endpoint === '(unattributed)').length,
    by_endpoint: s.byEndpoint,
    by_range: s.byRange,
    by_caller: s.byCaller,
    retries_observed: retries,
  };

  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log(`Read attempts total          : ${report.total_read_attempts}`);
  console.log(`  of which retry attempts    : ${report.retry_attempts}`);
  console.log(`Counterfactual (no quota)    : ${report.counterfactual_no_quota_attempts}`);
  console.log(`Peak rolling 60s window      : ${rolling.peak} attempts (from ${rolling.window_start})`);
  console.log(`Unattributed (pre-request)   : ${report.unattributed}`);
  console.log('\nBy range:');
  for (const [range, n] of s.byRange) console.log(`  ${String(n).padStart(3)}  ${range}`);
  console.log('\nBy caller:');
  for (const [caller, n] of s.byCaller) console.log(`  ${String(n).padStart(3)}  ${caller}`);
  console.log('\nBy endpoint:');
  for (const [ep, n] of s.byEndpoint) console.log(`  ${String(n).padStart(3)}  ${ep}`);
}

if (require.main === module) main();
module.exports = { reconstruct, summarize, peakRollingMinute };
