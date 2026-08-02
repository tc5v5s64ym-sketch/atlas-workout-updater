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
const { sessionPlansColumns, effortColumns, sessionPlanSetsColumns } = require('../config/columns');
const { parseRow: parseLedgerRow, effectivePlan: ledgerEffectivePlan } = require('../services/sessionPlanLedger');

// flight-review's tabs + the owner-session sidecars this review also joins.
// Session_Plan_Sets is OPTIONAL sheet-side (it does not exist before the owner's
// F10D production enablement) — absence reads as UNREADABLE for the seal
// criterion, which yields UNKNOWN, never an inferred PASS.
const REVIEW_TABS = ['Flight_Recorder', 'Brain_Shadow', 'Intent_Shadow', 'Log_Cleaned', 'Bug_Reports', 'Session_Plans', 'Effort', 'Session_Plan_Sets'];
const REVIEW_COLUMNS = Object.assign({}, fr.KNOWN_COLUMNS, {
  Session_Plans: sessionPlansColumns,
  Effort: effortColumns,
  Session_Plan_Sets: sessionPlanSetsColumns
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

// A TOTAL, deterministic ordering over candidate sessions.
//
// The previous comparator was `endA - endB`, and `sessionEndMs` returns
// -Infinity for a session whose timestamps are all unparseable. Two such
// sessions produced `-Infinity - -Infinity` = NaN, and a NaN comparator leaves
// the sort order implementation-defined — so two runs over the SAME data could
// pick different sessions. That is one of the two ways a text run and a --json
// run disagreed. Every branch below returns a real number, and the final
// tie-break is the session id, so identical input always yields an identical
// pick regardless of run, output mode, or engine.
function compareCandidates(a, b) {
  const ea = sessionEndMs(a.session);
  const eb = sessionEndMs(b.session);
  if (ea !== eb) {
    if (ea === -Infinity) return -1;
    if (eb === -Infinity) return 1;
    return ea < eb ? -1 : 1;
  }
  const fa = a.session.first_at_ms == null ? -Infinity : a.session.first_at_ms;
  const fb = b.session.first_at_ms == null ? -Infinity : b.session.first_at_ms;
  if (fa !== fb) {
    if (fa === -Infinity) return -1;
    if (fb === -Infinity) return 1;
    return fa < fb ? -1 : 1;
  }
  const ia = String(a.session.flight_session_id || '');
  const ib = String(b.session.flight_session_id || '');
  if (ia !== ib) return ia < ib ? -1 : 1;
  return a.mode < b.mode ? -1 : (a.mode > b.mode ? 1 : 0);
}

// Pick the NEWEST session to review. Crucially, LINKED sessions and UNLINKED (server-only)
// clusters are compared on the SAME time axis: in the exact v141 shape this command exists to
// catch, the newest owner session can have ONLY unlinked server rows while older LINKED
// sessions sit in the same cumulative tab — so preferring "any linked session" would review
// an old good session and silently skip the newest broken one (a false green). We instead
// select the candidate with the latest end time. (Codex P1.)
//
// An explicitly requested session ALWAYS WINS, and the returned `selection` block
// records how the pick was made so a text run and a --json run can be compared
// field by field instead of trusted.
function selectLatestSession(frRecords, opts) {
  const { sessions, noSession } = fr.groupBySession(frRecords || []);
  if (opts && opts.session) {
    const want = String(opts.session).trim();
    const hit = sessions.find(s => s.flight_session_id === want);
    if (hit) {
      return {
        session: hit,
        mode: 'linked',
        other_session_count: sessions.length - 1,
        selection: { basis: 'explicit', requested: want, candidate_count: sessions.length, ambiguous: false, reason: '' }
      };
    }
    return {
      session: null,
      mode: 'none',
      other_session_count: sessions.length,
      requested_missing: want,
      selection: { basis: 'explicit', requested: want, candidate_count: sessions.length, ambiguous: false, reason: `requested session ${want} not found` }
    };
  }
  const unlinked = clusterUnlinked(noSession, opts && opts.unlinkedGapMs);
  const candidates = [
    ...sessions.map(s => ({ session: s, mode: 'linked' })),
    ...unlinked.map(s => ({ session: s, mode: 'server-only' }))
  ];
  if (!candidates.length) {
    return {
      session: null,
      mode: 'none',
      other_session_count: 0,
      selection: { basis: 'latest', requested: null, candidate_count: 0, ambiguous: false, reason: '' }
    };
  }
  candidates.sort(compareCandidates);
  const latest = candidates[candidates.length - 1];

  // Two DIFFERENT sessions ending at the same instant cannot be separated by
  // "newest". The tie-break above still makes the pick reproducible, but a
  // reproducible guess is still a guess — so the ambiguity is reported and the
  // verdict fails closed rather than vouching for a session nobody chose.
  const tied = candidates.filter(c => sessionEndMs(c.session) === sessionEndMs(latest.session));
  const tiedDistinct = new Set(tied.map(c => `${c.mode}:${c.session.flight_session_id}`));
  const ambiguous = tiedDistinct.size > 1;

  return {
    session: latest.session,
    mode: latest.mode,
    other_session_count: candidates.length - 1,
    selection: {
      basis: 'latest',
      requested: null,
      candidate_count: candidates.length,
      ambiguous,
      reason: ambiguous
        ? `${tiedDistinct.size} sessions share the newest end time (${Array.from(tiedDistinct).sort().join(', ')}) — "newest" cannot name one; pass --session=<flight_session_id>`
        : ''
    }
  };
}

// STRICT correlation for closeout-truth rows (the seal criterion's inputs): a row
// that CARRIES a session_id correlates only when that id matches — the date
// fallback applies only to id-less rows. Without this, an earlier same-day
// session's sealed ledger rows and finalized event pollute the reviewed
// session's verdict (Codex P2, this PR): a neighbor's seal could PASS the wrong
// session, or a correct one could FAIL on the neighbor's mixed ids.
function correlateSidecarStrict(rows, idSet, dateSet) {
  const out = [];
  for (const r of rows || []) {
    const sid = String(r.session_id || '').trim().toLowerCase();
    const d = String(r.session_date || r.date || r.date_clean || '').trim();
    if (sid) {
      if (idSet.has(sid)) out.push({ match: 'session_id', rec: r });
    } else if (d && dateSet.has(d)) {
      out.push({ match: 'date', rec: r });
    }
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

// F10D — evaluate the Session_Plan_Sets seal for the session. PASS only when every
// correlated ledger row is sealed under ONE closeout_write_id, the history chain is
// valid, the rows agree on one workout session identity, and the finalized
// Session_Plans closeout tells the same story. Unreadable tab/rows are UNKNOWN
// (never inferred); pre-closeout unsealed checkpoints are UNKNOWN, not a failure;
// every mixed / conflicting / partially sealed / malformed state is FAIL with the
// exact evidence rows and a concise reason.
function evaluateLedgerSeal(planSetRecs, ledgerReadable, sessionPlansRecs) {
  const title = 'Plan ledger sealed to the closeout (Session_Plan_Sets)';
  if (!ledgerReadable) {
    return crit('ledger_sealed', title, V.UNKNOWN,
      'Session_Plan_Sets tab is absent or unreadable — the seal cannot be verified (never inferred). Before F10D production enablement this is the expected state.', true);
  }
  const rows = (planSetRecs || []).map(x => x.rec);
  const finalized = (sessionPlansRecs || []).some(x =>
    String(x.rec.event_type || '').trim() === 'session_closeout' &&
    String(x.rec.closeout_status || '').trim() === 'finalized');
  if (!rows.length) {
    return crit('ledger_sealed', title, V.UNKNOWN,
      finalized
        ? 'A finalized closeout correlates but ZERO Session_Plan_Sets rows do — no accepted-plan checkpoint for this session (freestyle, or a checkpoint gap to investigate).'
        : 'No Session_Plan_Sets rows correlate to this session (no accepted plan checkpoint — freestyle, or pre-F10D history).', true);
  }

  const sheetRows = rows.map(r => Number(r._row)).filter(n => Number.isFinite(n));
  const lastCol = String.fromCharCode(64 + sessionPlanSetsColumns.length);
  const evidenceRange = sheetRows.length
    ? `Session_Plan_Sets!A${Math.min(...sheetRows)}:${lastCol}${Math.max(...sheetRows)}`
    : 'Session_Plan_Sets!(row numbers unavailable)';
  const rowRef = r => (Number.isFinite(Number(r._row)) ? `row ${r._row}` : 'row ?');

  // One workout session identity across every correlated ledger row.
  const sids = [...new Set(rows.map(r => String(r.session_id || '').trim()).filter(Boolean))];
  if (sids.length > 1) {
    return crit('ledger_sealed', title, V.FAIL,
      `Correlated ledger rows span ${sids.length} session_ids (${sids.slice(0, 3).join(', ')}…) — tabs disagree on session identity. Evidence: ${evidenceRange}.`);
  }

  // Chain validity through the SAME fail-closed selectors the seal itself uses.
  const rawRows = rows.map(r => sessionPlanSetsColumns.map(c => (r[c] == null ? '' : String(r[c]))));
  const unparseable = rawRows.filter(r => parseLedgerRow(r).malformed);
  if (unparseable.length) {
    return crit('ledger_sealed', title, V.FAIL,
      `${unparseable.length} ledger row(s) are structurally unparseable — malformed history. Evidence: ${evidenceRange}.`);
  }
  const itemIds = [...new Set(rawRows.map(r => parseLedgerRow(r).rec.plan_item_id).filter(Boolean))];
  for (const itemId of itemIds) {
    const eff = ledgerEffectivePlan(rawRows, itemId);
    const bad = eff.find(e => e.confidence === 'no_reliable_target' && e.reason === 'malformed_chain');
    if (bad) {
      const diag = Array.isArray(bad.diagnostics) && bad.diagnostics.length ? bad.diagnostics[0] : 'invalid chain';
      return crit('ledger_sealed', title, V.FAIL,
        `Malformed revision chain for item ${itemId} set ${bad.set_index} (${diag}) — the seal would refuse this history. Evidence: ${evidenceRange}.`);
    }
  }

  const sealed = rows.filter(r => String(r.closeout_write_id || '').trim() !== '');
  const unsealed = rows.filter(r => String(r.closeout_write_id || '').trim() === '');
  const sealIds = [...new Set(sealed.map(r => String(r.closeout_write_id).trim()))];

  if (sealIds.length > 1) {
    return crit('ledger_sealed', title, V.FAIL,
      `Conflicting closeout_write_ids on one session (${sealIds.slice(0, 2).map(s => `${s.slice(0, 12)}…`).join(' vs ')}) — a closeout must seal under ONE id. Evidence: ${evidenceRange}.`);
  }
  if (sealed.length && unsealed.length) {
    return crit('ledger_sealed', title, V.FAIL,
      `Partially sealed: ${sealed.length} of ${rows.length} row(s) carry closeout_write_id; unsealed ${unsealed.slice(0, 4).map(rowRef).join(', ')}. Evidence: ${evidenceRange}.`);
  }
  if (!sealed.length) {
    if (finalized) {
      return crit('ledger_sealed', title, V.FAIL,
        `Session_Plans records a finalized closeout but ZERO of ${rows.length} ledger row(s) are sealed — the tabs disagree on the closeout. Evidence: ${evidenceRange}.`);
    }
    return crit('ledger_sealed', title, V.UNKNOWN,
      `${rows.length} checkpoint row(s) present, none sealed, and no finalized closeout — pre-closeout state (a rejected or not-yet-saved session), not a failure. Evidence: ${evidenceRange}.`, true);
  }
  if (!finalized) {
    return crit('ledger_sealed', title, V.FAIL,
      `All ${sealed.length} ledger row(s) sealed under ${sealIds[0].slice(0, 12)}… but no finalized Session_Plans closeout correlates — the tabs disagree on the closeout. Evidence: ${evidenceRange}.`);
  }
  return crit('ledger_sealed', title, V.PASS,
    `All ${sealed.length} of ${rows.length} correlated ledger row(s) sealed under one closeout_write_id (${sealIds[0].slice(0, 12)}…), chain valid, one session identity, matching the finalized closeout. Evidence: ${evidenceRange}.`);
}

// Evaluate the trust criteria for the selected session. Every criterion is PASS / FAIL /
// UNKNOWN; UNKNOWN means MISSING EVIDENCE (never a false green).
function evaluateCriteria(evidence, session, mode, sidecar, selection) {
  const ledgerReadable = sidecar && sidecar.ledger_readable === true;
  const logCorrelation = (evidence && evidence.log_correlation) || { basis: 'none', ambiguous: false, reason: '', distinct_session_ids: [] };
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

  // 7. F10D — the Session_Plan_Sets seal (see evaluateLedgerSeal for the rules).
  out.push(evaluateLedgerSeal(sidecar.plan_sets || [], ledgerReadable, sidecar.session_plans_strict || sidecar.session_plans || []));

  // 8. Correlation identity — is this evidence provably THIS session's?
  //    Every criterion above reads correlated rows, so a wrong join makes the
  //    whole verdict unreliable. This states the join's basis outright, and goes
  //    UNKNOWN (never a pass) whenever the tool could not name one session.
  const title = 'Evidence correlates to exactly one session';
  if (selection && selection.ambiguous) {
    out.push(crit('correlation_identity', title, V.UNKNOWN, selection.reason, true));
  } else if (logCorrelation.ambiguous) {
    out.push(crit('correlation_identity', title, V.UNKNOWN,
      `${logCorrelation.reason}. Date-based correlation was refused for the log and every sidecar tab — pass --workout-session=<session_id> to correlate exactly.`, true));
  } else if (logCorrelation.basis === 'explicit_session_id') {
    out.push(crit('correlation_identity', title, V.PASS,
      'Correlated by an explicitly supplied workout session id — exact join, no date heuristic used.'));
  } else if (logCorrelation.basis === 'session_id') {
    out.push(crit('correlation_identity', title, V.PASS,
      'Correlated by a workout session id discovered in the transcript — exact join, no date heuristic used.'));
  } else if (logCorrelation.basis === 'date_window') {
    const named = logCorrelation.distinct_session_ids || [];
    out.push(crit('correlation_identity', title, V.PASS,
      `Correlated by the local-date window (no workout session id in the transcript); the matched rows name ${named.length ? `one workout (${named[0]})` : 'no competing workout'}.`));
  } else {
    out.push(crit('correlation_identity', title, V.UNKNOWN,
      'No Log rows correlate by id or date, so no evidence could be attributed to this session.', true));
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
      other_session_count: picked.other_session_count || 0,
      selection: picked.selection || null
    };
  }

  const session = picked.session;
  // An explicitly supplied workout identity always wins over every heuristic.
  const explicitWorkoutSessionIds = (options.workoutSessionIds || [])
    .map(s => String(s || '').trim()).filter(Boolean);
  const evidence = fr.buildSessionEvidence(session, corpora, { windowMs, explicitWorkoutSessionIds });
  const logCorrelation = evidence.log_correlation || { basis: 'none', ambiguous: false, reason: '', distinct_session_ids: [] };

  // Sidecar joins run against the ESTABLISHED workout identity — the explicit id
  // when one was supplied, else the ids discovered in the transcript, else the
  // single workout the date fallback resolved. Building this from raw transcript
  // discovery instead would re-admit an identity the explicit id was meant to
  // replace.
  const idSet = new Set([session.flight_session_id, ...(logCorrelation.established_session_ids || [])]
    .map(s => String(s || '').trim().toLowerCase()).filter(Boolean));
  // The date fallback is refused wholesale when it cannot name one workout, or
  // when an exact identity was supplied. Refusing it HERE too matters: correlating
  // the log strictly while still date-matching the sidecars would attribute another
  // session's plan, effort and ledger rows to this verdict — the precise silent
  // mis-attribution this fix exists to prevent.
  const dateSet = (logCorrelation.ambiguous || explicitWorkoutSessionIds.length)
    ? new Set()
    : fr.sessionDateSet(session, windowMs);
  // EVERY sidecar join is id-strict: a row that carries a workout id correlates
  // only when that id is the established one, and the date fallback serves id-less
  // rows alone. The permissive variant let a row naming workout B attach to
  // workout A's verdict purely because it shared a candidate date — so plan
  // capture, write verification and correlation identity could all report PASS on
  // evidence drawn from two different workouts.
  const sidecar = {
    session_plans: correlateSidecarStrict(corpora.Session_Plans, idSet, dateSet),
    effort: correlateSidecarStrict(corpora.Effort, idSet, dateSet),
    plan_sets: correlateSidecarStrict(corpora.Session_Plan_Sets, idSet, dateSet),
    // The finalized-closeout scan for the seal criterion is likewise id-strict —
    // a neighbor same-day session's finalized event must not vouch for this one.
    session_plans_strict: correlateSidecarStrict(corpora.Session_Plans, idSet, dateSet),
    // Readability is an explicit signal, never inferred from emptiness: the CLI
    // threads rowCounts (null = tab absent/unreadable); pure-corpora callers mark
    // readability by providing the key at all (undefined/null = unreadable).
    ledger_readable: options.rowCounts
      ? options.rowCounts.Session_Plan_Sets != null
      : corpora.Session_Plan_Sets != null
  };

  // Build-change detection within the session (the split-build caveat).
  const versions = [];
  for (const e of session.events) {
    const v = String(e.app_version || '').trim();
    if (v && !versions.includes(v)) versions.push(v);
  }

  const criteria = evaluateCriteria(evidence, session, picked.mode, sidecar, picked.selection);

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
      ledger_rows: sidecar.plan_sets.length,
      plan_rows: sidecar.session_plans.length
    },
    build_change: { detected: versions.length > 1, versions },
    overall: overallFrom(criteria),
    criteria,
    anomalies: evidence.anomalies,
    other_session_count: picked.other_session_count || 0,
    selection: picked.selection || null,
    log_correlation: logCorrelation
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
  // Both output modes print the same selection and correlation facts, so a text
  // run and a --json run can be compared directly instead of taken on trust.
  if (review.selection) {
    L.push(`Selected by: ${review.selection.basis}${review.selection.requested ? ` (--session=${review.selection.requested})` : ''}   candidates: ${review.selection.candidate_count}`);
    if (review.selection.ambiguous) L.push(`  ⚠️  ambiguous: ${review.selection.reason}`);
  }
  L.push(`Window:      ${s.first_at || '?'} → ${s.last_at || '?'}   events: ${s.event_count}`);
  L.push(`Correlated:  ${s.log_rows} Log · ${s.effort_rows} Effort · ${s.plan_rows} Session_Plans · ${s.ledger_rows != null ? s.ledger_rows : '?'} Session_Plan_Sets`);
  if (review.log_correlation) {
    L.push(`Join basis:  ${review.log_correlation.basis}`);
    if (review.log_correlation.ambiguous) L.push(`  ⚠️  ${review.log_correlation.reason}`);
  }
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
  const opts = { json: false, windowMins: 5, fromDir: null, sheet: null, session: null, workoutSessionIds: [] };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--window-mins=')) opts.windowMins = Number(a.slice('--window-mins='.length)) || 5;
    else if (a.startsWith('--from-dir=')) opts.fromDir = a.slice('--from-dir='.length);
    else if (a.startsWith('--sheet=')) opts.sheet = a.slice('--sheet='.length);
    else if (a.startsWith('--session=')) opts.session = a.slice('--session='.length);
    // Repeatable, and comma-separated for convenience. Naming the workout makes
    // correlation exact and switches the date heuristic off completely.
    else if (a.startsWith('--workout-session=')) {
      for (const id of a.slice('--workout-session='.length).split(',')) {
        const v = id.trim();
        if (v) opts.workoutSessionIds.push(v);
      }
    }
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
    '  npm run atlas:review-live -- --workout-session=<session_id>   Exact join; no date heuristic',
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

  const { corpora, rowCounts } = toReviewCorpora(raw);
  const review = reviewCorpora(corpora, {
    windowMins: opts.windowMins,
    session: opts.session,
    workoutSessionIds: opts.workoutSessionIds,
    source,
    rowCounts,
    now: new Date().toISOString()
  });

  if (opts.json) process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
  else process.stdout.write(`${renderHuman(review)}\n`);
}

module.exports = {
  REVIEW_TABS,
  REVIEW_COLUMNS,
  toReviewCorpora,
  parseArgs,
  compareCandidates,
  selectLatestSession,
  clusterUnlinked,
  correlateSidecarStrict,
  planRowHasSetTarget,
  evaluateCriteria,
  evaluateLedgerSeal,
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
