#!/usr/bin/env node
/**
 * `npm run atlas:review-live` — "Review my latest live app test." READ-ONLY.
 *
 * F09C. Answers, from repo root and local `.env` alone (no Sheet ID / tab / session id
 * supplied): "did my most recent real app session hold the trust boundaries?"
 *
 * It builds ON TOP of scripts/flight-review.js (session grouping, cross-tab correlation,
 * anomaly detection — it does NOT duplicate those readers), and adds:
 *   - automatic selection of the NEWEST genuine session (prefers flight_session_id; falls
 *     back to the newest UNLINKED server rows — the v141 shape — so a broken session is
 *     still reviewed, not silently skipped);
 *   - joins Session_Plans + Effort alongside Flight_Recorder / Intent_Shadow / Brain_Shadow
 *     / Log_Cleaned;
 *   - deployment/build-change detection within the session;
 *   - a PASS / FAIL / UNKNOWN verdict per trust criterion, where UNKNOWN means MISSING
 *     EVIDENCE (never a false green) — a hard problem is FAIL, and anything unproven is
 *     UNKNOWN, never PASS.
 *
 * Trust discipline (mirrors scripts/flight-review.js and the Operations Contract):
 *   - READ-ONLY (spreadsheets.readonly scope); never mutates a tab; never touches the
 *     trust/write path; proposes no fixes.
 *   - Secrets are redacted and payloads truncated (reuses flight-review's parsers).
 *   - Prints to stdout / a gitignored outputs/ dir only; never commits a private report.
 *
 * Usage:
 *   npm run atlas:review-live
 *   npm run atlas:review-live -- --json
 *   npm run atlas:review-live -- --session=<flight_session_id>
 *   npm run atlas:review-live -- --from-dir=backups/<ts>     # offline, from a backup export
 *   npm run atlas:review-live -- --window-mins=5 --sheet=<spreadsheetId>
 *
 * Sheet selection precedence (same as flight-review): --sheet > FLIGHT_REVIEW_SHEET_ID >
 * GOOGLE_SHEETS_ID. Live path also needs GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const fr = require('./flight-review');
const { sessionPlansColumns, effortColumns } = require('../config/columns');

// flight-review's tabs + the two owner-session sidecars this review also joins.
const REVIEW_TABS = ['Flight_Recorder', 'Brain_Shadow', 'Intent_Shadow', 'Log_Cleaned', 'Bug_Reports', 'Session_Plans', 'Effort'];
const REVIEW_COLUMNS = Object.assign({}, fr.KNOWN_COLUMNS, {
  Session_Plans: sessionPlansColumns,
  Effort: effortColumns
});

const V = { PASS: 'PASS', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' };

// The client-visible event types (what the athlete did / what Atlas showed) vs the
// server-only ones (the api flow). The v141 defect is: server rows present, client rows absent.
const CLIENT_EVENT_TYPES = ['user_input', 'user_action', 'screen_rendered', 'card_rendered', 'coach_message_rendered', 'session_state_changed', 'bug_marker'];
const SERVER_EVENT_TYPES = ['api_request', 'api_response'];

function sumCounts(counts, keys) {
  return keys.reduce((n, k) => n + (Number(counts && counts[k]) || 0), 0);
}

function byTimeThenRow(a, b) {
  const ta = fr.parseTimestamp(a.captured_at);
  const tb = fr.parseTimestamp(b.captured_at);
  if (ta != null && tb != null && ta !== tb) return ta - tb;
  return (a._row || 0) - (b._row || 0);
}

// Parse the raw per-tab rows into record corpora using the extended column contract.
function toReviewCorpora(raw) {
  const corpora = {};
  const rowCounts = {};
  for (const tab of REVIEW_TABS) {
    if (!raw[tab]) { corpora[tab] = []; rowCounts[tab] = null; continue; }
    const records = fr.rowsToRecords(raw[tab], REVIEW_COLUMNS[tab]);
    corpora[tab] = records;
    rowCounts[tab] = records.length;
  }
  return { corpora, rowCounts };
}

// A time gap (default 30 min) that separates distinct unlinked (server-only) sessions, so a
// week of orphan rows isn't lumped into one giant pseudo-session.
const UNLINKED_GAP_MS = 30 * 60000;

// Cluster the unlinked (blank flight_session_id) server rows into time-gap-separated
// pseudo-sessions, each with its own first/last time — so the NEWEST broken cluster can be
// compared against the linked sessions on the same time axis.
function clusterUnlinked(rows, gapMs) {
  const sorted = (rows || []).slice().sort(byTimeThenRow);
  const gap = typeof gapMs === 'number' && gapMs >= 0 ? gapMs : UNLINKED_GAP_MS;
  const clusters = [];
  let cur = null;
  let prevT = null;
  for (const e of sorted) {
    const t = fr.parseTimestamp(e.captured_at);
    if (!cur || (prevT != null && t != null && (t - prevT) > gap)) { cur = []; clusters.push(cur); }
    cur.push(e);
    if (t != null) prevT = t;
  }
  return clusters.map(events => {
    const times = events.map(e => fr.parseTimestamp(e.captured_at)).filter(t => t != null);
    return {
      flight_session_id: '(unlinked)',
      events,
      first_at_ms: times.length ? Math.min(...times) : null,
      last_at_ms: times.length ? Math.max(...times) : null
    };
  });
}

function sessionEndMs(s) {
  if (s.last_at_ms != null) return s.last_at_ms;
  if (s.first_at_ms != null) return s.first_at_ms;
  return -Infinity;
}

// Pick the NEWEST session to review. Crucially, LINKED sessions and UNLINKED (server-only)
// clusters are compared on the SAME time axis: in the exact v141 shape this command exists to
// catch, the newest owner session can have ONLY unlinked server rows while older LINKED
// sessions sit in the same cumulative tab — so preferring "any linked session" would review
// an old good session and silently skip the newest broken one (a false green). We instead
// select the candidate with the latest end time. (Codex P1.)
function selectLatestSession(frRecords, opts) {
  const { sessions, noSession } = fr.groupBySession(frRecords || []);
  if (opts && opts.session) {
    const want = String(opts.session).trim();
    const hit = sessions.find(s => s.flight_session_id === want);
    if (hit) return { session: hit, mode: 'linked', other_session_count: sessions.length - 1 };
    return { session: null, mode: 'none', other_session_count: sessions.length, requested_missing: want };
  }
  const unlinked = clusterUnlinked(noSession, opts && opts.unlinkedGapMs);
  const candidates = [
    ...sessions.map(s => ({ session: s, mode: 'linked' })),
    ...unlinked.map(s => ({ session: s, mode: 'server-only' }))
  ];
  if (!candidates.length) return { session: null, mode: 'none', other_session_count: 0 };
  candidates.sort((a, b) => sessionEndMs(a.session) - sessionEndMs(b.session));
  const latest = candidates[candidates.length - 1];
  return { session: latest.session, mode: latest.mode, other_session_count: candidates.length - 1 };
}

// Correlate sidecar rows (Session_Plans / Effort) to the session by workout session id, else
// by session date. Returns the matched records with how they matched.
function correlateSidecar(rows, idSet, dateSet) {
  const out = [];
  for (const r of rows || []) {
    const sid = String(r.session_id || '').trim().toLowerCase();
    const d = String(r.session_date || r.date || r.date_clean || '').trim();
    if (sid && idSet.has(sid)) out.push({ match: 'session_id', rec: r });
    else if (d && dateSet.has(d)) out.push({ match: 'date', rec: r });
  }
  return out;
}

// True when a Session_Plans row carries a set-level prescription (target weight/reps/rir).
// Session_Plans today has no set-level target columns (finding #8 → F10A), so this stays
// false — which correctly yields UNKNOWN, not a false PASS.
function planRowHasSetTarget(rec) {
  const keys = ['target_weight', 'target_reps', 'target_rir', 'planned_weight', 'planned_reps', 'set_count', 'target_sets'];
  return keys.some(k => {
    const v = rec[k];
    return v != null && String(v).trim() !== '';
  });
}

function crit(id, title, verdict, detail, missing) {
  return { id, title, verdict, detail: detail || '', missing: missing === true };
}

// Evaluate the trust criteria for the selected session. Every criterion is PASS / FAIL /
// UNKNOWN; UNKNOWN means MISSING EVIDENCE (never a false green).
function evaluateCriteria(evidence, session, mode, sidecar) {
  const counts = (evidence && evidence.event_type_counts) || {};
  const clientEvents = sumCounts(counts, CLIENT_EVENT_TYPES);
  const serverEvents = sumCounts(counts, SERVER_EVENT_TYPES);
  const apiCalls = (evidence && evidence.api_calls) || [];
  const anomalies = (evidence && evidence.anomalies) || [];
  const out = [];

  // 1. Client replay captured — the exact FR-REPLAY-1 / v141 seam.
  if (clientEvents > 0) {
    out.push(crit('client_replay', 'Client replay captured', V.PASS,
      `${clientEvents} client event(s) captured (user input / actions / cards / coach / session-state).`));
  } else if (serverEvents > 0) {
    out.push(crit('client_replay', 'Client replay captured', V.FAIL,
      `${serverEvents} server api row(s) but ZERO client events — the v141 shape (client recorder never activated; see F09B).`));
  } else {
    out.push(crit('client_replay', 'Client replay captured', V.UNKNOWN,
      'No Flight Recorder events for this session.', true));
  }

  // 2. Server↔client session linkage.
  if (serverEvents === 0) {
    out.push(crit('session_linkage', 'Server rows linked to the session', V.UNKNOWN,
      'No server api rows to link.', true));
  } else if (mode === 'server-only') {
    out.push(crit('session_linkage', 'Server rows linked to the session', V.FAIL,
      'Server api rows carry no flight_session_id/seq (unlinked) — cannot stitch the replay.'));
  } else {
    out.push(crit('session_linkage', 'Server rows linked to the session', V.PASS,
      `Server api rows carry this session's flight_session_id (${session.flight_session_id}).`));
  }

  // 3. No server errors (5xx — e.g. the coaching-notes 503).
  const fivexx = apiCalls.filter(c => c.status_class === '5xx');
  if (fivexx.length) {
    out.push(crit('no_server_errors', 'No server (5xx) errors', V.FAIL,
      `${fivexx.length} 5xx response(s): ` + fivexx.slice(0, 4).map(c => `${c.endpoint || '?'}→${c.status}`).join(', ')));
  } else if (apiCalls.length) {
    const fourxx = apiCalls.filter(c => c.status_class === '4xx');
    out.push(crit('no_server_errors', 'No server (5xx) errors', V.PASS,
      fourxx.length ? `No 5xx; ${fourxx.length} 4xx present (review if unexpected).` : 'No 4xx/5xx responses.'));
  } else {
    out.push(crit('no_server_errors', 'No server (5xx) errors', V.UNKNOWN, 'No api responses captured.', true));
  }

  // 4. Confirmation matches actual logged rows.
  const mismatch = anomalies.find(a => a.type === 'session_confirm_mismatch' && a.severity !== 'info');
  const confirmMsgs = ((evidence && evidence.coach_messages) || []).filter(c => fr.parseConfirmClaim(c.text));
  const loggedRows = ((evidence && evidence.workout_rows_written) || []).length;
  if (mismatch) {
    out.push(crit('confirm_matches_actual', 'Final confirmation matches actual', V.FAIL, mismatch.detail));
  } else if (confirmMsgs.length && loggedRows > 0) {
    out.push(crit('confirm_matches_actual', 'Final confirmation matches actual', V.PASS,
      `Confirmation claim(s) reconcile with ${loggedRows} correlated log row(s).`));
  } else {
    out.push(crit('confirm_matches_actual', 'Final confirmation matches actual', V.UNKNOWN,
      confirmMsgs.length ? 'A confirmation was shown but no log rows correlate (rejected/abandoned preview, or a correlation gap).'
        : 'No confirmation-and-log evidence for this session.', true));
  }

  // 5. Plan captured with set-level targets (Session_Plans). Absent today → UNKNOWN, not a
  //    false green (finding #8 → F10A adds the set-level ledger).
  const planRows = sidecar.session_plans || [];
  const planWithTargets = planRows.filter(p => planRowHasSetTarget(p.rec));
  if (planWithTargets.length) {
    out.push(crit('plan_captured', 'Plan captured with set-level targets', V.PASS,
      `${planWithTargets.length} Session_Plans row(s) carry set-level target weight/reps/rir.`));
  } else if (planRows.length) {
    out.push(crit('plan_captured', 'Plan captured with set-level targets', V.UNKNOWN,
      `${planRows.length} Session_Plans row(s) correlate but none carry set-level targets (Session_Plans has no set-level schema yet — F10A).`, true));
  } else {
    out.push(crit('plan_captured', 'Plan captured with set-level targets', V.UNKNOWN,
      'No Session_Plans rows correlate to this session.', true));
  }

  // 6. Write verified (Log + Effort, with a success write response). A rejected preview
  //    writes NOTHING and is not a failure — so absence of a verified write is UNKNOWN, never
  //    FAIL (a real write failure surfaces as a 5xx above or a confirm mismatch). A success
  //    response with no correlated rows is a correlation gap to investigate, still UNKNOWN.
  const writeOk = apiCalls.some(c => c.event_type === 'api_response' && /log-?workout|complete-?workout/i.test(c.endpoint) && c.status_class === '2xx');
  const effortRows = (sidecar.effort || []).length;
  if (writeOk && loggedRows > 0) {
    out.push(crit('write_verified', 'Write verified (Log + Effort)', V.PASS,
      `A successful write response correlates with ${loggedRows} Log row(s)${effortRows ? ` and ${effortRows} Effort row(s)` : ''}.`));
  } else if (writeOk) {
    out.push(crit('write_verified', 'Write verified (Log + Effort)', V.UNKNOWN,
      'A write response is present but no Log rows correlate (a rejected/dry-run preview, or a correlation gap — verify manually).', true));
  } else {
    out.push(crit('write_verified', 'Write verified (Log + Effort)', V.UNKNOWN,
      loggedRows > 0 ? `${loggedRows} log row(s) correlate but no success write response is captured.`
        : 'No verified write for this session (a rejected preview writes nothing — not a failure).', true));
  }

  return out;
}

function overallFrom(criteria) {
  if (criteria.some(c => c.verdict === V.FAIL)) return V.FAIL;
  if (criteria.some(c => c.verdict === V.UNKNOWN)) return V.UNKNOWN;
  return V.PASS;
}

// Pure core: parsed corpora → the review object. No IO, no network — the CLI and the
// tests both call this.
function reviewCorpora(corpora, opts) {
  const options = opts || {};
  const windowMs = Math.max(0, (options.windowMins == null ? 5 : options.windowMins)) * 60000;
  const picked = selectLatestSession(corpora.Flight_Recorder, options);

  if (!picked.session) {
    return {
      generated_at: options.now || null,
      source: options.source || null,
      session: null,
      mode: picked.mode,
      overall: V.UNKNOWN,
      reason: picked.requested_missing ? `requested session ${picked.requested_missing} not found` : 'no Flight Recorder sessions found',
      criteria: [],
      build_change: { detected: false, versions: [] },
      other_session_count: picked.other_session_count || 0
    };
  }

  const session = picked.session;
  const evidence = fr.buildSessionEvidence(session, corpora, { windowMs });

  // Sidecar joins (Session_Plans + Effort) by workout session id, else by date.
  const idSet = new Set([session.flight_session_id, ...(evidence.workout_session_ids || [])]
    .map(s => String(s || '').trim().toLowerCase()).filter(Boolean));
  const dateSet = fr.sessionDateSet(session, windowMs);
  const sidecar = {
    session_plans: correlateSidecar(corpora.Session_Plans, idSet, dateSet),
    effort: correlateSidecar(corpora.Effort, idSet, dateSet)
  };

  // Build-change detection within the session (the split-build caveat).
  const versions = [];
  for (const e of session.events) {
    const v = String(e.app_version || '').trim();
    if (v && !versions.includes(v)) versions.push(v);
  }

  const criteria = evaluateCriteria(evidence, session, picked.mode, sidecar);

  return {
    generated_at: options.now || null,
    source: options.source || null,
    session: {
      flight_session_id: session.flight_session_id,
      mode: picked.mode,
      first_at: evidence.first_at,
      last_at: evidence.last_at,
      event_count: evidence.event_count,
      event_type_counts: evidence.event_type_counts,
      workout_session_ids: evidence.workout_session_ids,
      log_rows: evidence.workout_rows_written.length,
      effort_rows: sidecar.effort.length,
      plan_rows: sidecar.session_plans.length
    },
    build_change: { detected: versions.length > 1, versions },
    overall: overallFrom(criteria),
    criteria,
    anomalies: evidence.anomalies,
    other_session_count: picked.other_session_count || 0
  };
}

// ---- human rendering ------------------------------------------------------------------
function mark(verdict) {
  if (verdict === V.PASS) return '✅ PASS';
  if (verdict === V.FAIL) return '❌ FAIL';
  return '❔ UNKNOWN';
}

function renderHuman(review) {
  const L = [];
  L.push('Atlas — latest live app-test review');
  L.push('='.repeat(40));
  if (review.source) L.push(`Source:      ${review.source}`);
  if (!review.session) {
    L.push(`Overall:     ${mark(review.overall)}`);
    L.push(`Reason:      ${review.reason || 'no session'}`);
    return L.join('\n');
  }
  const s = review.session;
  L.push(`Session:     ${s.flight_session_id}  (${s.mode})`);
  L.push(`Window:      ${s.first_at || '?'} → ${s.last_at || '?'}   events: ${s.event_count}`);
  L.push(`Correlated:  ${s.log_rows} Log · ${s.effort_rows} Effort · ${s.plan_rows} Session_Plans`);
  if (review.build_change.detected) {
    L.push(`Build change: ⚠️  ${review.build_change.versions.join(' → ')} (split-build caveat)`);
  }
  L.push('');
  L.push(`Overall:     ${mark(review.overall)}`);
  L.push('');
  L.push('Trust criteria:');
  for (const c of review.criteria) {
    L.push(`  ${mark(c.verdict)}  ${c.title}`);
    if (c.detail) L.push(`           ${c.detail}`);
  }
  if (review.other_session_count) {
    L.push('');
    L.push(`(${review.other_session_count} older session(s) not shown — pass --session=<id> to review one.)`);
  }
  L.push('');
  L.push('UNKNOWN = missing evidence, never a pass. Read-only; no sheet was modified.');
  return L.join('\n');
}

// ---- IO shell (live sheets / offline dir) ---------------------------------------------
function parseArgs(argv) {
  const opts = { json: false, windowMins: 5, fromDir: null, sheet: null, session: null };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--window-mins=')) opts.windowMins = Number(a.slice('--window-mins='.length)) || 5;
    else if (a.startsWith('--from-dir=')) opts.fromDir = a.slice('--from-dir='.length);
    else if (a.startsWith('--sheet=')) opts.sheet = a.slice('--sheet='.length);
    else if (a.startsWith('--session=')) opts.session = a.slice('--session='.length);
  }
  return opts;
}

async function loadFromSheets(spreadsheetId) {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      type: 'service_account'
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] // read-only: cannot write even if it tried
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const present = new Set((meta.data.sheets || []).map(s => String(s.properties.title || '')));
  const raw = {};
  for (const tab of REVIEW_TABS) {
    if (!present.has(tab)) { raw[tab] = null; continue; }
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A:Z` });
    raw[tab] = resp.data.values || [];
  }
  return raw;
}

function loadFromDir(dir) {
  const raw = {};
  for (const tab of REVIEW_TABS) {
    const file = path.join(dir, `${tab}.json`);
    if (!fs.existsSync(file)) { raw[tab] = null; continue; }
    try { raw[tab] = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { raw[tab] = null; }
  }
  return raw;
}

function helpText() {
  return [
    'Atlas — review my latest live app test (READ-ONLY)',
    '',
    'Usage:',
    '  npm run atlas:review-live                 Human summary of the newest session',
    '  npm run atlas:review-live -- --json       Machine-readable review',
    '  npm run atlas:review-live -- --session=<flight_session_id>',
    '  npm run atlas:review-live -- --from-dir=backups/<ts>   (offline)',
    '',
    'No Sheet ID / tab / session id needed: reads local .env + config/sheetContract.js.',
    'See docs/AGENT_LIVE_TESTING.md. atlas:status answers general health; this reviews the newest app session.',
    ''
  ].join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(helpText()); return; }

  let raw;
  let source;
  if (opts.fromDir) {
    source = `local-dir:${opts.fromDir}`;
    raw = loadFromDir(opts.fromDir);
  } else {
    try { require('dotenv').config(); } catch { /* dotenv optional */ }
    const spreadsheetId = opts.sheet || process.env.FLIGHT_REVIEW_SHEET_ID || process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      process.stderr.write('Missing live-sheet config. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY, and a sheet id via --sheet / FLIGHT_REVIEW_SHEET_ID / GOOGLE_SHEETS_ID (or use --from-dir=<backup>).\n');
      process.exitCode = 1;
      return;
    }
    source = 'live-sheets';
    raw = await loadFromSheets(spreadsheetId);
  }

  const { corpora } = toReviewCorpora(raw);
  const review = reviewCorpora(corpora, {
    windowMins: opts.windowMins,
    session: opts.session,
    source,
    now: new Date().toISOString()
  });

  if (opts.json) process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
  else process.stdout.write(`${renderHuman(review)}\n`);
}

module.exports = {
  REVIEW_TABS,
  REVIEW_COLUMNS,
  toReviewCorpora,
  selectLatestSession,
  clusterUnlinked,
  correlateSidecar,
  planRowHasSetTarget,
  evaluateCriteria,
  reviewCorpora,
  renderHuman,
  overallFrom,
  V
};

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`atlas:review-live failed: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
