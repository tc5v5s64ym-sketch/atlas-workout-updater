'use strict';

// Reconstruct every Google Sheets READ ATTEMPT from a rehearsal/gate server log.
//
// Why this exists: F-SB4B qualifying session 1 (2026-08-05) exhausted its own Sheets read
// quota mid-session, and the corrective merged as PR #1271 on the strength of a harness
// that measured 46 reads for a complete session. The authorized non-counting debug run on
// 2026-08-06 then measured 116 observable reads with a rolling-60s peak of 87 — over
// Google's 60/minute limit — and threw 429s. This tool is how that was established, and
// its honesty is therefore load-bearing.
//
// TWO EVIDENCE MODES, and the difference matters.
//
// 1. STRUCTURED (current builds). `sheets.js` emits one `[sheets-read] {json}` line per
//    quota-metered ATTEMPT — first try and every retry — carrying the request id, the HTTP
//    method and path that caused it, the API method, the ranges, the attempt number, and
//    the outcome. Counts are exact, attribution is exact, and retries are counted.
//
// 2. LEGACY (archived logs). Older builds emitted one human line per logical read and
//    printed retries only through `console.warn`; builds before the F-SB4B read-budget
//    change also emitted nothing at all for `spreadsheets.get`. What is missing differs by
//    build, so the tool DETECTS per log which classes are absent and names them, rather
//    than assuming. A total missing any class is a LOWER BOUND, and no amount of
//    re-parsing recovers what was never written.
//
// The report says which mode it used and never presents a lower bound as a total. In
// particular it reports retries as **not observable** rather than as `0` when the log
// carries no retry evidence: the debug run's own artifact showed "retry attempts: 0" while
// the console had shown a 429 storm, because the retry lines went to a stream the file did
// not capture. Zero-because-none-happened and zero-because-unobservable are different
// facts and this tool no longer collapses them.
//
// Line prefixes are tolerated. The gate harness prefixes captured server output with
// `[gate-server] `, and an anchored pattern silently matched nothing.
//
// Read-only: parses a text file, contacts nothing, writes nothing but its own report.

const fs = require('fs');

// Strip the OUTER harness prefix before matching, and only that. `[gate-server] [sheets.js] …`
// and `[gate-server] [sheets-read] {…}` must parse exactly like their unprefixed forms.
//
// The negative lookahead is the whole point. This pattern used to strip every leading
// bracketed tag, which ate the SEMANTIC tag as well — `[sheets-read]` and `[sheets.js]` are
// what the patterns below match on, so a current-build log parsed as legacy mode with zero
// attempts and an archived log parsed as nothing at all. A tool that reports "0 read
// attempts" for a log full of reads is the exact false green this whole corrective exists to
// prevent, so `test/reconstructSessionReads.test.js` now pins both forms.
const PREFIX_RE = /^(?:\[(?!sheets-read\]|sheets\.js\])[^\]]+\]\s+)*/;

const STRUCTURED_RE = /^\[sheets-read\]\s+(\{.*\})$/;

// LEGACY patterns — one entry per API REQUEST as older builds logged it. Kept so archived
// logs (including the preserved qualifying-session-1 artifact) still parse, and never used
// when structured lines are present.
const LEGACY_READ_PATTERNS = [
  [/^\[sheets\.js\] Reading range (.+)$/, 'readValues'],
  [/^\[sheets\.js\] Reading (spreadsheet metadata)$/, 'getSpreadsheetTabs'],
  [/^\[sheets\.js\] Batch reading \d+ range\(s\): (.+)$/, 'prefetchRanges'],
  [/^\[sheets\.js\] Fetching Exercise_Catalog from range (.+)$/, 'getExerciseCatalog'],
  [/^\[sheets\.js\] Fetching composite-key columns from Log_Cleaned range (.+)$/, 'getLogCompositeKeys'],
  [/^\[sheets\.js\] Fetching recent rows from \S+ range (.+)$/, 'getRecentRows'],
  [/^\[sheets\.js\] Fetching rows from \S+ range (.+)$/, 'getSheetRows'],
  [/^\[sheets\.js\] Fetching header row from (.+)$/, 'getHeaderRow'],
];
const LEGACY_RETRY_RE = /^\[sheets\.js\] Transient read error on (.+?) \(attempt (\d+)\)/;
const REQ_RE = /^(\{"timestamp":.*"duration_ms":\d+.*\})$/;

function reconstruct(logText) {
  const attempts = [];
  const requests = [];
  const legacyRetries = [];
  let pending = [];          // legacy mode only: reads seen since the last completed request
  let structuredSeen = false;
  let legacyRetryLineSeen = false;
  let quotaTextSeen = false;
  let metadataLineSeen = false;

  for (const raw of logText.split('\n')) {
    const line = raw.trim().replace(PREFIX_RE, '');
    if (!line) continue;

    if (/Quota exceeded|RESOURCE_EXHAUSTED/i.test(line)) quotaTextSeen = true;

    // ── structured ──────────────────────────────────────────────────────────
    const structured = STRUCTURED_RE.exec(line);
    if (structured) {
      let record;
      try { record = JSON.parse(structured[1]); } catch { record = null; }
      if (record) {
        structuredSeen = true;
        attempts.push({
          mode: 'structured',
          request_id: record.request_id || null,
          endpoint: record.http_method && record.http_path
            ? `${record.http_method} ${record.http_path}` : '(no request context)',
          api: record.api || 'unknown',
          ranges: Array.isArray(record.ranges) ? record.ranges : [String(record.ranges || '')],
          attempt: Number(record.attempt) || 1,
          retry: (Number(record.attempt) || 1) > 1,
          outcome: record.outcome || null,
          quota_rejection: Boolean(record.quota_rejection),
          timestamp: record.at || null,
        });
        continue;
      }
    }

    // ── legacy ──────────────────────────────────────────────────────────────
    const legacyRetry = LEGACY_RETRY_RE.exec(line);
    if (legacyRetry) {
      legacyRetryLineSeen = true;
      legacyRetries.push({ range: legacyRetry[1], attempt: Number(legacyRetry[2]) });
      pending.push({ mode: 'legacy', caller: 'retry', ranges: [legacyRetry[1]], retry: true, attempt: Number(legacyRetry[2]) + 1 });
      continue;
    }

    let matched = false;
    for (const [re, caller] of LEGACY_READ_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        if (caller === 'getSpreadsheetTabs') metadataLineSeen = true;
        pending.push({ mode: 'legacy', caller, ranges: m[1].split(', '), retry: false, attempt: 1 });
        matched = true;
        break;
      }
    }
    if (matched) continue;

    const req = REQ_RE.exec(line);
    if (req) {
      let parsed;
      try { parsed = JSON.parse(req[1]); } catch { parsed = null; }
      if (!parsed) continue;
      requests.push(parsed);
      const endpoint = `${parsed.method} ${String(parsed.path || '').split('?')[0]}`;
      for (const p of pending) {
        attempts.push({ ...p, timestamp: parsed.timestamp, endpoint, request_id: parsed.requestId || null });
      }
      pending = [];
    }
  }

  for (const p of pending) {
    attempts.push({ ...p, timestamp: null, endpoint: '(unattributed)', request_id: null });
  }

  // In structured mode the legacy pending-attribution is meaningless; drop it so the two
  // modes are never mixed into one total.
  const structuredAttempts = attempts.filter(a => a.mode === 'structured');
  const usedStructured = structuredSeen && structuredAttempts.length > 0;

  return {
    mode: usedStructured ? 'structured' : 'legacy',
    attempts: usedStructured ? structuredAttempts : attempts.filter(a => a.mode === 'legacy'),
    requests,
    legacyRetries,
    retriesObservable: usedStructured || legacyRetryLineSeen,
    // `spreadsheets.get` was unlogged before the F-SB4B read-budget change, so a legacy
    // log that carries no metadata line is missing that whole class of metered read.
    metadataObservable: usedStructured || metadataLineSeen,
    quotaTextSeen,
  };
}

function summarize(attempts) {
  const byEndpoint = new Map();
  const byRanges = new Map();
  const byApi = new Map();
  for (const a of attempts) {
    byEndpoint.set(a.endpoint, (byEndpoint.get(a.endpoint) || 0) + 1);
    const key = (a.ranges || []).join(', ');
    byRanges.set(key, (byRanges.get(key) || 0) + 1);
    byApi.set(a.api || a.caller || 'unknown', (byApi.get(a.api || a.caller || 'unknown') || 0) + 1);
  }
  const sortDesc = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]);
  return { byEndpoint: sortDesc(byEndpoint), byRanges: sortDesc(byRanges), byApi: sortDesc(byApi) };
}

/** Worst rolling-60s window of read ATTEMPTS — the number Google's quota meters. */
function peakRollingMinute(attempts) {
  const stamped = attempts.filter(a => a.timestamp).map(a => Date.parse(a.timestamp)).sort((a, b) => a - b);
  let peak = 0; let start = 0; let peakAt = null;
  for (let end = 0; end < stamped.length; end++) {
    while (stamped[end] - stamped[start] >= 60_000) start++;
    const count = end - start + 1;
    if (count > peak) { peak = count; peakAt = new Date(stamped[start]).toISOString(); }
  }
  return { peak, window_start: peakAt, stamped_total: stamped.length, unstamped: attempts.length - stamped.length };
}

/** The endpoint call manifest — how many times the CLIENT called each path. */
function requestManifest(requests) {
  const byEndpoint = new Map();
  for (const r of requests) {
    if (!String(r.path || '').startsWith('/api/')) continue;
    const key = `${r.method} ${String(r.path).split('?')[0]}`;
    byEndpoint.set(key, (byEndpoint.get(key) || 0) + 1);
  }
  return [...byEndpoint.entries()].sort((a, b) => b[1] - a[1]);
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/reconstruct-session-reads.js <server-log.txt> [--json]');
    process.exit(2);
  }
  const result = reconstruct(fs.readFileSync(file, 'utf8'));
  const { attempts, mode, retriesObservable, metadataObservable, quotaTextSeen, requests } = result;
  const s = summarize(attempts);
  const rolling = peakRollingMinute(attempts);
  const retryAttempts = attempts.filter(a => a.retry).length;
  const quotaRejections = attempts.filter(a => a.quota_rejection).length;

  const report = {
    evidence_mode: mode,
    // A legacy log records neither retries nor `spreadsheets.get`, so its total is a
    // values-read LOWER BOUND. Naming that here stops the number being quoted as a total.
    total_is: (mode === 'structured' || (retriesObservable && metadataObservable))
      ? 'complete_attempt_count' : 'lower_bound',
    metadata_reads_observable: metadataObservable,
    total_read_attempts: attempts.length,
    retry_attempts: retriesObservable ? retryAttempts : null,
    retry_attempts_observable: retriesObservable,
    quota_rejections: mode === 'structured' ? quotaRejections : null,
    quota_text_seen_in_log: quotaTextSeen,
    peak_rolling_minute: rolling,
    http_requests_captured: requests.length,
    request_manifest: requestManifest(requests),
    by_endpoint: s.byEndpoint,
    by_ranges: s.byRanges,
    by_api: s.byApi,
  };

  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log(`Evidence mode                : ${mode}`);
  if (mode !== 'structured') {
    const missing = [];
    if (!metadataObservable) missing.push('spreadsheets.get (metadata) reads');
    if (!retriesObservable) missing.push('retry attempts');
    console.log('  ⚠ legacy log — one line per logical read, not per metered attempt.');
    console.log(missing.length
      ? `    NOT RECORDED by this log: ${missing.join('; ')}. The total below is a LOWER BOUND;`
        + '\n    re-parsing cannot recover what was never written.'
      : '    Metadata reads and retries ARE present in this log.');
  }
  console.log(`Read attempts (${report.total_is === 'complete_attempt_count' ? 'exact' : 'lower bound'})  : ${report.total_read_attempts}`);
  if (retriesObservable) {
    console.log(`  of which retry attempts    : ${retryAttempts}`);
  } else {
    console.log('  of which retry attempts    : NOT OBSERVABLE — this log carries no retry evidence.');
    if (quotaTextSeen) {
      console.log('    ⚠ but quota-rejection text IS present, so retries almost certainly occurred and are UNCOUNTED.');
    }
  }
  if (mode === 'structured') console.log(`Quota rejections             : ${quotaRejections}`);
  console.log(`Peak rolling 60s window      : ${rolling.peak} attempts (from ${rolling.window_start})`);
  if (rolling.unstamped) console.log(`  unstamped (excluded)       : ${rolling.unstamped}`);
  console.log(`HTTP requests captured       : ${requests.length}`);

  console.log('\nClient request manifest (how many times each endpoint was CALLED):');
  for (const [ep, n] of report.request_manifest) console.log(`  ${String(n).padStart(3)}  ${ep}`);
  console.log('\nReads by API method:');
  for (const [api, n] of s.byApi) console.log(`  ${String(n).padStart(3)}  ${api}`);
  console.log('\nReads by ranges:');
  for (const [ranges, n] of s.byRanges.slice(0, 20)) console.log(`  ${String(n).padStart(3)}  ${ranges}`);
  console.log('\nReads by endpoint:');
  for (const [ep, n] of s.byEndpoint) console.log(`  ${String(n).padStart(3)}  ${ep}`);
}

if (require.main === module) main();
module.exports = { reconstruct, summarize, peakRollingMinute, requestManifest };
