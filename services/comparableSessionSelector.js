'use strict';

// Comparable-session selector — #1338 (Corpus V2 §F.2).
//
// The engine's session-over-session comparisons used to be recency-only: the
// previous DISTINCT session's last working set, whatever band or context it
// was in. That authorized load bumps from incomparable sessions (a light,
// high-RIR session with the same rep count) and missed bumps the lifter had
// earned (a comparable session hidden behind a different-band session).
//
// This module picks the NEAREST COMPARABLE prior session for a lift:
//   - nearest rep/RIR band: |Δreps| ≤ 2, |ΔRIR| ≤ 1, e1RM within ±15% (the
//     one Epley calculator, services/estimatedOneRepMax.js — never a second
//     1RM formula);
//   - same fresh/fatigued context class: 'working' | 'deload' | 're-entry'.
//     'deload' reuses the engine's own rule (services/deloadPolicy.js): a
//     note tagged /deload/i, or a session top ≥7% below the established
//     working weight (max top of the prior three sessions, ≥2 priors).
//     're-entry' reuses the engine's own layoff band
//     (services/layoffGuard.js: 14–27 days → significant): the first session
//     for the lift after a ≥14-day gap from the previous session.
//   - validity guards: a candidate needs a recorded RIR (comparability
//     cannot be judged without one); warm-up-note rows never form a session;
//     when no prior session qualifies, the selector returns null — it NEVER
//     falls back to the most recent session. A missing comparison is a fact
//     the caller must respect (hold, don't bump), not a gap to paper over.
//
// Pure / deterministic: no Sheets, no LLM, no I/O. Rows are consumed in
// analytics.normalizeLogRow shape (date_clean, session_id, lift_code,
// weight, reps, rir, notes, set_number); the module never normalizes raw
// sheet arrays itself, so it stays free of a require cycle with analytics.

const { estimateOneRepMax } = require('./estimatedOneRepMax');
const { isWarmupNote } = require('./warmupTag');

// The selector's own bands, pinned by test/comparableSessionSelector.test.js.
const COMPARABLE_BANDS = {
  maxRepDelta: 2, // same rep band (corpus §F: a 6-rep and an 8-rep block read as comparable)
  maxRirDelta: 1, // same RIR band
  maxE1rmDeltaPct: 15, // same load band, in Epley e1RM terms
  deloadDropPct: 7, // engine's deload rule (services/deloadPolicy.js)
  reentryGapDays: 14, // engine's layoff band (services/layoffGuard.js)
};

function isPositiveFinite(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function dayGap(a, b) {
  const ms = Date.parse(String(a || '')) - Date.parse(String(b || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86400000);
}

// Distinct sessions for the lift, chronological, each with its last working
// set (the engine's progression anchor for a session) and its top working
// weight. Warm-up-note rows never form or join a session.
function sessionsInOrder(rows, liftCode) {
  const code = String(liftCode || '').trim().toUpperCase();
  const byId = new Map();
  const sorted = [...rows]
    .filter(r => r && typeof r === 'object'
      && String(r.lift_code || '').toUpperCase() === code
      && isPositiveFinite(r.weight) && isPositiveFinite(r.reps)
      && !isWarmupNote(r.notes))
    .sort((a, b) => (a.date_clean || '').localeCompare(b.date_clean || '')
      || (a.session_id || '').localeCompare(b.session_id || '')
      || (Number(a.set_number) || 0) - (Number(b.set_number) || 0));
  for (const r of sorted) {
    const sid = String(r.session_id || '').trim();
    if (!sid) continue;
    const cur = byId.get(sid) || { session_id: sid, date_clean: r.date_clean || '', rows: [] };
    cur.rows.push(r);
    if (!cur.date_clean && r.date_clean) cur.date_clean = r.date_clean;
    byId.set(sid, cur);
  }
  const sessions = [...byId.values()].sort((a, b) => (a.date_clean || '').localeCompare(b.date_clean || '')
    || a.session_id.localeCompare(b.session_id));
  for (const s of sessions) {
    s.lastSet = s.rows[s.rows.length - 1];
    s.top = s.rows.reduce((m, r) => Math.max(m, Number(r.weight) || 0), 0);
    s.noteTaggedDeload = s.rows.some(r => /deload/i.test(String(r.notes || '')));
  }
  return sessions;
}

// Context class of one session, judged against the sessions before it:
// 'deload' (note-tagged, or top ≥7% below the established weight from the
// prior three sessions when ≥2 exist), 're-entry' (first session after a
// ≥14-day gap from the previous session for this lift), else 'working'.
function sessionContextClass(session, earlierSessions) {
  if (!session) return 'working';
  if (session.noteTaggedDeload) return 'deload';
  const priorTops = (earlierSessions || []).slice(-3).map(s => s.top).filter(isPositiveFinite);
  if (priorTops.length >= 2) {
    const established = Math.max(...priorTops);
    if (isPositiveFinite(established) && isPositiveFinite(session.top)
      && session.top < established * (1 - COMPARABLE_BANDS.deloadDropPct / 100)) return 'deload';
  }
  const prev = (earlierSessions || [])[(earlierSessions || []).length - 1];
  if (prev && session.date_clean && prev.date_clean) {
    const gap = dayGap(session.date_clean, prev.date_clean);
    if (gap !== null && gap >= COMPARABLE_BANDS.reentryGapDays) return 're-entry';
  }
  return 'working';
}

function e1rmDeltaPct(a, b) {
  // estimateOneRepMax throws on a non-positive weight / reps < 1; both sets
  // are guarded positive before this is called.
  const ea = estimateOneRepMax({ weight: a.weight, reps: a.reps }).value;
  const eb = estimateOneRepMax({ weight: b.weight, reps: b.reps }).value;
  if (!isPositiveFinite(eb)) return null;
  return Math.abs(ea - eb) / eb * 100;
}

// Nearest comparable prior session for `currentSet` (today's working set):
// same rep/RIR band, same context class, nearest first (rep distance, then
// RIR distance, then e1RM distance, then most recent). Returns
// { session_id, date_clean, set, context_class, distance } or null when no
// prior session qualifies — never the most recent session by default.
function selectComparableSession(rows, liftCode, currentSet) {
  const cur = currentSet && typeof currentSet === 'object' ? currentSet : null;
  if (!Array.isArray(rows) || !cur) return null;
  if (!isPositiveFinite(cur.weight) || !isPositiveFinite(cur.reps)) return null;
  if (!Number.isFinite(Number(cur.rir))) return null; // no RIR, no comparability

  const sessions = sessionsInOrder(rows, liftCode);
  if (!sessions.length) return null;

  const currentId = String(cur.session_id || '').trim();
  const currentIdx = currentId ? sessions.findIndex(s => s.session_id === currentId) : -1;
  // The current session is today's session when it is present in the rows;
  // otherwise every session is prior history (e.g. a just-logged set not yet
  // in the sheet). Candidates are the sessions strictly before it.
  const prior = currentIdx >= 0 ? sessions.slice(0, currentIdx) : sessions;
  if (!prior.length) return null;

  const currentSession = currentIdx >= 0
    ? sessions[currentIdx]
    : { session_id: currentId, date_clean: cur.date_clean || '', top: Number(cur.weight) || 0, noteTaggedDeload: /deload/i.test(String(cur.notes || '')) };
  const currentClass = sessionContextClass(currentSession, prior);

  let best = null;
  for (let i = 0; i < prior.length; i += 1) {
    const s = prior[i];
    const rep = s.lastSet;
    if (!Number.isFinite(Number(rep.rir))) continue; // RIR is the band's second axis
    const repDelta = Math.abs(Number(rep.reps) - Number(cur.reps));
    if (repDelta > COMPARABLE_BANDS.maxRepDelta) continue;
    const rirDelta = Math.abs(Number(rep.rir) - Number(cur.rir));
    if (rirDelta > COMPARABLE_BANDS.maxRirDelta) continue;
    const loadDelta = e1rmDeltaPct(rep, cur);
    if (loadDelta === null || loadDelta > COMPARABLE_BANDS.maxE1rmDeltaPct) continue;
    if (sessionContextClass(s, prior.slice(0, i)) !== currentClass) continue;
    const score = [repDelta, rirDelta, loadDelta];
    // Nearest first; ties break to the most recent session.
    const better = !best
      || score[0] < best.score[0]
      || (score[0] === best.score[0] && score[1] < best.score[1])
      || (score[0] === best.score[0] && score[1] === best.score[1] && score[2] < best.score[2])
      || (score[0] === best.score[0] && score[1] === best.score[1] && score[2] === best.score[2] && i > best.index);
    if (better) {
      best = {
        index: i,
        score,
        result: {
          session_id: s.session_id,
          date_clean: s.date_clean,
          set: rep,
          context_class: currentClass,
          distance: { reps: repDelta, rir: rirDelta, e1rm_pct: Math.round(loadDelta * 10) / 10 },
        },
      };
    }
  }
  return best ? best.result : null;
}

module.exports = { selectComparableSession, sessionContextClass, COMPARABLE_BANDS };
