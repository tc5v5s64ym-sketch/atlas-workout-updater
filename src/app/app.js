/* Atlas frontend — read-only views + approve-before-save workout logger.
 * Golden rule: AI/backend can parse, prepare, and preview. The owner approves.
 * Only then does Atlas write. Preview always runs with test_mode=true.
 */



// Shell build tag baked INTO this bundle (mirrors the service-worker cache name in
// public/sw.js). The Settings badge shows it next to the server /version: if the
// server reports a newer build but this tag is stale/absent, the browser is running
// a cached service-worker shell — i.e. a "fix didn't take" is a stale shell, not a
// code bug. Bump this whenever the SW cache version bumps (a test pins them equal).
import { API_KEY_STORAGE, api, authState, friendlyTransportMessage, getApiKey, isConnected, refreshSessionStatus, sessionLogin, sessionLogout } from './api.js';
import { BUG_REPORT_ACTION_LIMIT, BUG_REPORT_ERROR_LIMIT, BUG_REPORT_RECENT_API_LIMIT, BUG_REPORT_REDACTED, BUG_REPORT_SECRET_VALUE_PATTERNS, BUG_REPORT_SIZE_BUDGET, BUG_REPORT_STORAGE_KEY_RE, atlasActionLog, atlasRecentApiRequests, atlasRecentErrors, recordAtlasAction, recordAtlasError } from './bugReport.js';
import { el, loadExerciseDatalist, renderTable, setStatus, svgBarChart, svgLineChart } from './dom.js';
import { loadHistory, loadSessions } from './historyView.js';
import { liftListCache, loadProgressLiftList, openLiftDrillDown, renderTrends } from './progressView.js';
import { checkConnection, runHealthCheck, setBoxSpan } from './settingsHealth.js';
import { buildSessionTally } from './sessionTally.js';
import * as sessionQuestion from './sessionQuestion.js';
// PR-10 — single state store (session/plan slice). These loose top-level `let`s
// used to live here; ownership moved to store.js so every surface reads one source
// of truth. Getters return the live reference; setters take the reassignments the
// old `let`s did. Snapshot persistence is the store's persist()/hydrate() seam.
import {
  getActivePlannedSession, setActivePlannedSession,
  getSessionChromeExpanded, setSessionChromeExpanded,
  getCoachSuggestionEngaged, setCoachSuggestionEngaged,
  getPendingSubstitution, setPendingSubstitution,
  getSessionLog, setSessionLog,
  getSessionCompleted, setSessionCompleted,
  getSessionSavedLog, setSessionSavedLog,
  getSessionRevisions, setSessionRevisions,
  getSessionImplicitRecs, setSessionImplicitRecs,
  getCoachDiscussionSinceLog, setCoachDiscussionSinceLog,
  getPendingReplacement, setPendingReplacement,
  getPendingSetRevision, setPendingSetRevision,
  getAtlasLastError, setHistoryLoaded,
  persistSessionSnapshot, hydrateSessionSnapshot, clearPersistedSnapshot,
} from './store.js';
// PR-F — the "Start this plan" acceptance orchestrator (pure/DI; app.js injects the
// real store/persist/start/api deps). Identity minting + snapshot + sidecar POST live
// there so this file's diff stays a thin adapter.
import { runAcceptance } from './planAcceptance.js';
// PR-G1 — explicit item-outcome capture (skipped / substituted). Pure/DI; app.js
// fires it non-blocking from the explicit skip/substitution handlers.
import { runOutcome } from './planOutcome.js';
// PR-H — explicit session closeout (finalized / abandoned). Pure/DI; wired ONLY at
// the explicit Finish/End-session and Start-over/discard affordances (never inside
// the implicit endPlannedSession cleanup paths).
import { runCloseout as runPlanCloseout } from './planCloseout.js'; // aliased — app.js already has a save-flow runCloseout()
// PR-I5 — mid-plan completed-boundary eligibility (pure/DI). Selects the most recently
// logged still-unresolved accepted item so "Done with <exercise>" stays reachable after
// the cursor auto-advances past a just-logged item.
import { mostRecentCompletablePlanItem } from './planCompletion.js';
// F10 — THE authoritative planned-slot completion selector (pure/DI). Keyed on
// plan_item_id + slot position; name/liftCode used ONLY as logged-evidence to
// attribute a log to one slot (exact-outranks-substring + ambiguity refusal). Every
// remaining/completion surface routes through it so they can never disagree.
import { remainingSlotNames, variantSatisfies, planSlotStatuses, firstUnloggedSlot } from './planSlotStatuses.js';
// F10B — the client session ledger: build future-set-only revisions from an explicit
// mid-session recommendation (a substitution), append-only, and count performed sets
// so a completed set is never revised. Revisions live in the store (getSessionRevisions)
// and are checkpointed to the dry-run /revision sidecar.
import { buildFutureRevisions, appendRevisions, performedSetCount as ledgerPerformedSetCount } from './sessionLedger.js';
import { isExplicitEndorsement } from './endorsedSetRevision.js';
// #1189 — the prescription-only set-revision proposal lane (propose → approve → revise). Pure
// logic only: construction, the deterministic id, the staleness test, the proposal line, and
// follow-up classification. No new machinery — approval drives emitEndorsedSetRevision below.
import {
  buildSetRevisionProposal, isSetRevisionProposalFresh,
  formatSetRevisionProposalLine, formatSetRevisionPrescription, classifySetRevisionFollowup,
} from './pendingSetRevision.js';
// F09G (CONVO-LOG-1) — hold a parser bodyweight-rep clarification and commit exactly
// those detected reps on a short affirmation ("Just log it"), so clarified sets are
// never dropped nor fabricated.
import { setPendingClarification, resolvePendingClarification, clearPendingClarification } from './pendingClarification.js';
import {
  approvalCorrelation,
  beginCorrelatedPreview,
  completeCorrelatedPreview,
  resolveCorrelatedPreviewSession,
  retireCorrelatedPreview,
  waitForTurnResponse,
} from './turnCorrelation.js';

const ATLAS_SHELL_BUILD = 'v145';




          
                   // last N UI actions, e.g. "tap restore" → nothing









// Unhandled JS errors / promise rejections never reach api(), so a UI lockup or a silent
// "tapped X, nothing happened" would otherwise leave no trace. Capture them, and leave a
// breadcrumb for every tap (capture phase, so a stopPropagation handler still logs).
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => recordAtlasError({
    source: 'window.onerror',
    message: (e && e.message) || String(e),
    where: e ? [e.filename, e.lineno, e.colno].filter(v => v != null).join(':') || null : null
  }));
  window.addEventListener('unhandledrejection', (e) => recordAtlasError({
    source: 'unhandledrejection',
    message: (e && e.reason && (e.reason.message || String(e.reason))) || 'unhandled rejection'
  }));
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('button, .tab, [role="button"], a');
    if (!t) return;
    recordAtlasAction('tap', (t.id || t.getAttribute('aria-label') || t.textContent || '').trim().slice(0, 60));
  }, true);
}















/* ===== Inline SVG charts (no dependencies) ===== */









/* ===== Exercise catalog datalist (typeahead) ===== */



/* ===== Tabs ===== */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'dashboard') loadDashboard();
    if (btn.dataset.tab === 'body') loadBodyTab();
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'progress') loadProgressLiftList();
    if (btn.dataset.tab === 'settings') loadPendingExercises();
  });
});

/* ===== History tab ===== */































// The list auto-loads on first History visit (loadHistory above). nav.js calls
// this to force a fresh fetch when jumping here from a chat reply.
//
// #1163's temporary `window.atlasEndorseSetRevision` global lived here. #1188 shipped it as the
// narrowest public surface that let that slice ship, and documented it as TEMPORARY: it had no
// in-app caller, and any script on the page could reach a function that rewrites the remaining
// sets. #1189's proposal lane now calls the internal `emitEndorsedSetRevision` directly from
// `approvePendingSetRevision`, so the global has no remaining caller and is deleted.
window.atlasRefreshSessions = () => {
  setHistoryLoaded(true);
  loadSessions();
};

/* ===== Connection check ===== */



/* ===== Settings ===== */

document.getElementById('settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const key = document.getElementById('api-key-input').value.trim();
  const statusBox = document.getElementById('settings-status');
  if (!key) {
    setStatus(statusBox, 'Enter an API key first.', 'error');
    return;
  }
  // Prefer a durable server session so the raw key is never persisted in this
  // browser. Fall back to the legacy localStorage key only when the server has
  // not enabled sessions yet (503) or is unreachable — never on a rejected key.
  const result = await sessionLogin(key);
  document.getElementById('api-key-input').value = '';
  if (result.ok) {
    localStorage.removeItem(API_KEY_STORAGE);
    setStatus(statusBox, 'Atlas connected on this device.', 'ok');
  } else if (result.status === 401) {
    setStatus(statusBox, 'That key was not accepted. Check it and try again.', 'error');
    return;
  } else {
    // 503 (sessions not enabled) or a transport failure — keep the legacy key so
    // the owner is never locked out before the session secret is provisioned.
    localStorage.setItem(API_KEY_STORAGE, key);
    setStatus(statusBox, 'API key saved to this browser.', 'ok');
  }
  loadDashboard();
  loadCoachPlan();
  loadWeeklyCoach();
});

document.getElementById('clear-key-btn').addEventListener('click', async () => {
  await sessionLogout();
  localStorage.removeItem(API_KEY_STORAGE);
  setStatus(document.getElementById('settings-status'), 'Disconnected on this device.', 'ok');
});

// Reflect the SERVER's auth verdict in Settings so it can never disagree with Coach or
// the reads — all three derive from the one server-authoritative state. Only fills the
// box when the server has actually decided ('authenticated' / 'unauthenticated'); on an
// unsettled 'unknown' (status probe timed out) it stays blank so Settings never CLAIMS a
// state the server didn't confirm. Won't clobber an explicit in-page connect/disconnect.
function reflectSettingsAuth() {
  const box = document.getElementById('settings-status');
  if (!box || box.textContent) return;
  const state = authState();
  if (state === 'authenticated') {
    setStatus(box, 'Atlas connected on this device.', 'ok');
  } else if (state === 'unauthenticated') {
    setStatus(box, 'Connect Atlas to sync your training on this device.', 'muted');
  }
}

/* ===== Backend health / debug ===== */





document.getElementById('check-sheets-btn')?.addEventListener('click', () => {
  runHealthCheck('/api/health/sheets', 'Google Sheets', document.getElementById('health-result'));
});

document.getElementById('check-openai-btn')?.addEventListener('click', () => {
  runHealthCheck('/api/health/openai', 'OpenAI', document.getElementById('health-result'));
});

document.getElementById('load-version-btn')?.addEventListener('click', async () => {
  const box = document.getElementById('debug-result');
  setBoxSpan(box, 'muted', 'Loading…');
  try {
    const res = await fetch('/version');
    const data = await res.json().catch(() => null);
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = JSON.stringify(data, null, 2);
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not load: ${err.message}`);
  }
});

// Diagnostic: probe the coach LLM (Gemini) so a "Coach is unavailable" / robotic
// templated reply can be explained — shows configured/model/ok and the exact reason
// (missing key, 401/403 bad key, 404 bad model, 429 quota, timeout). Read-only.
document.getElementById('test-coach-btn')?.addEventListener('click', async () => {
  const box = document.getElementById('debug-result');
  setBoxSpan(box, 'muted', 'Testing coach connection…');
  try {
    const res = await api('/api/coach/health');
    const d = (res && res.data) || {};
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = [
      `configured: ${d.configured}`,
      `model:      ${d.model}`,
      `ok:         ${d.ok}`,
      d.ok ? 'The coach LLM is reachable — replies should be intelligent, not templated.' : `reason:     ${d.reason || 'unknown'}`,
    ].join('\n');
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not run coach test: ${err.message}`);
  }
});

// Diagnostic: dump the LIVE in-session plan/completion state — so a wrong "next up"
// or a stale composer placeholder can be diagnosed from the actual runtime values
// (sessionCompleted, remaining, nextPlanned), which the static code can't always
// explain after a mid-session swap. Read-only; no writes, no effect on the workout.
// Tap it right after a wrong handoff and screenshot it.
document.getElementById('load-session-state-btn')?.addEventListener('click', () => {
  const box = document.getElementById('debug-result');
  try {
    const liteEx = arr => (Array.isArray(arr) ? arr.map(e => ({
      name: e.canonicalName || e.canonical_exercise || e.name || e.exercise || '',
      liftCode: e.liftCode || e.lift_code || ''
    })) : []);
    const recommended = ((lastIntentData && lastIntentData.intents) || []).find(i => i.recommended);
    const state = {
      shell: ATLAS_SHELL_BUILD,
      activePlannedSession: getActivePlannedSession()
        ? { index: getActivePlannedSession().index, exercises: liteEx(getActivePlannedSession().exercises) }
        : null,
      suggestedPlan: recommended ? liteEx(recommended.exercises) : null,
      plannedExerciseOrder: plannedExerciseOrder(),
      sessionCompleted: [...getSessionCompleted()],
      remainingPlannedExercises: remainingPlannedExercises(),
      firstUnloggedPlannedLift: firstUnloggedPlannedLift()
    };
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = JSON.stringify(state, null, 2);
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not read session state: ${err.message}`);
  }
});

// Glanceable build badge in Settings: always-visible deployed commit + boot time,
// so "is the live app current?" is a glance, not a Debug-JSON dig. /version is
// public (no auth), so a plain fetch works; failures degrade quietly.
// Module-local: only written here and read by the bug-report payload below —
// never crosses a module boundary, so it stays a plain app.js let (not store-owned).
let atlasServerVersion = null;
(async function populateBuildInfo() {
  // The running-shell tag is baked into THIS bundle — set it first and
  // unconditionally (its own prominent line) so it shows even if /version is
  // unreachable. This is the truth about which JS is actually loaded; the server
  // build line below can read "current" while the browser runs a cached shell.
  const shellEl = document.getElementById('shell-version');
  if (shellEl) shellEl.textContent = ATLAS_SHELL_BUILD;
  const el = document.getElementById('build-version');
  if (!el) return;
  try {
    const res = await fetch('/version');
    const body = await res.json().catch(() => null);
    const v = (body && body.data) || body || {};
    atlasServerVersion = v;
    const raw = String(v.version || 'unknown');
    const short = /^[0-9a-f]{7,40}(-dirty)?$/i.test(raw) ? raw.slice(0, 7) : raw;
    // Lead with the PR number when the build captured it — "PR #461" is something
    // you can compare to the last PR merged; the SHA stays for precision.
    const id = (v.pr != null) ? `PR #${v.pr} · ${short}` : short;
    let when = '';
    if (v.deployed_at) {
      const d = new Date(v.deployed_at);
      if (!Number.isNaN(d.getTime())) when = `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
    }
    el.textContent = when ? `${id} · deployed ${when}` : id;
  } catch (_) {
    el.textContent = 'unavailable';
  }
})();

document.getElementById('load-debug-config-btn')?.addEventListener('click', async () => {
  const box = document.getElementById('debug-result');
  setBoxSpan(box, 'muted', 'Loading…');
  try {
    const res = await api('/api/debug/config');
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = JSON.stringify(res.data || res, null, 2);
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not load: ${err.message}`);
  }
});

// Diagnostic: verify the hybrid coaching engine end-to-end from the app. Calls the
// read-only recommendation endpoint for a fixed lift (BEN01) and dumps the raw JSON,
// so you can confirm at a glance that `recommendation.brian` is attached (proving
// ATLAS_COACH_ENGINE=hybrid is live) while the existing `next_target` still appears.
// Read-only: same endpoint the app already uses; no writes, no trust-loop touch.
document.getElementById('test-brian-btn')?.addEventListener('click', async () => {
  const box = document.getElementById('debug-result');
  setBoxSpan(box, 'muted', 'Testing Brian (BEN01)…');
  try {
    const res = await api('/api/recommend/next/BEN01');
    const pre = document.createElement('pre');
    pre.className = 'debug-pre';
    pre.textContent = JSON.stringify(res.data || res, null, 2);
    box.replaceChildren(pre);
  } catch (err) {
    setBoxSpan(box, 'muted', `Could not run Brian test: ${err.message}`);
  }
});

/* ===== Hybrid Coach Compare v1 (dev-only) =====
 * Developer-only evaluation UI: fetches one lift's /api/recommend/next response and,
 * only when hybridCompare.shouldShowCompareCard() confirms hybrid mode + a validated
 * Brian decision, renders Legacy vs Brian side by side with a preference button row.
 * Read-only — the fetch is the same production endpoint; a preference selection only
 * appends a feedback entry to localStorage (services/pure helpers in hybridCompare.js).
 * No write path, no trust-loop, no effect on the recommendation itself. */

let hybridCompareState = null;

function renderHybridCompareSummary(container, summary) {
  const lines = Object.entries(summary || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => el('p', { text: `${k}: ${v}` }));
  container.replaceChildren(...(lines.length ? lines : [el('p', { class: 'muted', text: 'No data' })]));
}

document.getElementById('hybrid-compare-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const liftCode = (document.getElementById('hybrid-compare-liftcode').value || '').trim();
  const statusEl = document.getElementById('hybrid-compare-status');
  const cardEl = document.getElementById('hybrid-compare-card');
  const savedEl = document.getElementById('hybrid-compare-saved');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  cardEl.hidden = true;
  savedEl.textContent = '';
  hybridCompareState = null;
  if (!liftCode) {
    setBoxSpan(statusEl, 'muted', 'Enter a lift code.');
    return;
  }
  setBoxSpan(statusEl, 'muted', `Comparing ${liftCode}…`);
  // Disabled for the duration of the fetch so a second Compare click can't
  // race this one — without this, a slower response for an earlier lift code
  // could resolve after a later one and silently overwrite its result.
  if (submitBtn) submitBtn.disabled = true;
  try {
    const recRes = await api(`/api/recommend/next/${encodeURIComponent(liftCode)}`);
    const recommendation = recRes.data || recRes;
    if (!window.hybridCompare.shouldShowCompareCard(recommendation)) {
      setBoxSpan(statusEl, 'muted', `Not available — no validated Brian decision was attached for ${liftCode} (requires ATLAS_COACH_ENGINE=hybrid; see "Show config" above).`);
      return;
    }
    hybridCompareState = { liftCode, recommendation };
    renderHybridCompareSummary(document.getElementById('hybrid-compare-legacy'), window.hybridCompare.summarizeLegacy(recommendation));
    renderHybridCompareSummary(document.getElementById('hybrid-compare-brian'), window.hybridCompare.summarizeBrian(recommendation));
    setBoxSpan(statusEl, 'status-ok', `Comparing ${liftCode} — hybrid mode confirmed.`);
    cardEl.hidden = false;
  } catch (err) {
    setBoxSpan(statusEl, 'status-error', `Could not compare: ${err.message}`);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

function saveHybridComparePreference(preference) {
  const savedEl = document.getElementById('hybrid-compare-saved');
  if (!hybridCompareState) {
    setBoxSpan(savedEl, 'muted', 'Run Compare first.');
    return;
  }
  try {
    const noteEl = document.getElementById('hybrid-compare-note');
    const entry = window.hybridCompare.buildComparisonEntry({
      timestamp: new Date().toISOString(),
      liftCode: hybridCompareState.liftCode,
      preference,
      note: noteEl ? noteEl.value : '',
      recommendation: hybridCompareState.recommendation
    });
    const list = window.hybridCompare.saveComparisonEntry(localStorage, entry);
    setBoxSpan(savedEl, 'status-ok', `Saved: ${preference} (${hybridCompareState.liftCode}) — ${list.length} saved locally.`);
  } catch (err) {
    setBoxSpan(savedEl, 'status-error', `Could not save: ${err.message}`);
  }
}

document.getElementById('hybrid-compare-prefer-legacy')?.addEventListener('click', () => saveHybridComparePreference('legacy'));
document.getElementById('hybrid-compare-prefer-brian')?.addEventListener('click', () => saveHybridComparePreference('brian'));
document.getElementById('hybrid-compare-prefer-neither')?.addEventListener('click', () => saveHybridComparePreference('neither'));

function bugReportId(now = new Date()) {
  const stamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  return `BUG-${stamp}`;
}

export function redactBugReportString(value) {
  let out = value;
  for (const pattern of BUG_REPORT_SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, (match, keyName) => {
      if (typeof keyName === 'string' && keyName) return `${keyName}=${BUG_REPORT_REDACTED}`;
      return BUG_REPORT_REDACTED;
    });
  }
  return out;
}

function redactBugReportValue(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const safeValue = redactBugReportString(value);
    return safeValue.length > 12000 ? `${safeValue.slice(0, 12000)}...[truncated]` : safeValue;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactBugReportValue(item, seen));
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = BUG_REPORT_STORAGE_KEY_RE.test(key) ? BUG_REPORT_REDACTED : redactBugReportValue(raw, seen);
  }
  return out;
}

function collectAtlasStorage(storage) {
  const out = {};
  if (!storage) return out;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !/^atlas/i.test(key)) continue;
      out[key] = BUG_REPORT_STORAGE_KEY_RE.test(key) ? BUG_REPORT_REDACTED : storage.getItem(key);
    }
  } catch (err) {
    out.storage_error = err.message;
  }
  return out;
}

// Bodyweight sets (weight null/''/0) read as reps, never "0×N" — one rule for
// every renderer of LOGGED set data in this file (owner live find 2026-07-03;
// coach-conversation.js and nav.js carry their own copies inside their IIFEs).
// Engine TARGETS keep their own rendering — this is for history only.
export function formatSetLoad(weight, reps, sep = ' × ') {
  const loaded = weight != null && weight !== '' && Number(weight) !== 0;
  return loaded ? `${weight}${sep}${reps}` : `${reps} reps`;
}

function currentRouteForBugReport() {
  const activeSurface = document.body.getAttribute('data-surface') || null;
  const activeTab = document.querySelector('.tab.active')?.id || null;
  return [location.pathname + location.search + location.hash, activeSurface, activeTab].filter(Boolean).join(' | ');
}

function visibleMessagesForBugReport() {
  return Array.from(document.querySelectorAll('#thread-messages .chat-bubble'))
    .slice(-6)
    .map(node => ({
      role: node.classList.contains('chat-bubble-user') ? 'user' : 'assistant',
      text: node.textContent.trim().slice(0, 2000)
    }));
}

function pendingRowsForBugReport() {
  const rows = [];
  for (const tr of Array.from(setsTableBody?.children || [])) {
    rows.push({
      exercise: tr.querySelector('.set-exercise')?.value || '',
      set_number: tr.querySelector('.set-number')?.value || '',
      weight: tr.querySelector('.set-weight')?.value || '',
      reps: tr.querySelector('.set-reps')?.value || '',
      rir: tr.querySelector('.set-rir')?.value || '',
      notes: tr.querySelector('.set-notes')?.value || ''
    });
  }
  return rows;
}

function currentSheetForBugReport() {
  return {
    session_id: document.getElementById('log-session-id')?.value || pendingWrite?.sessionId || pendingWrite?.payload?.session_id || '',
    date: document.getElementById('log-date')?.value || pendingWrite?.date || pendingWrite?.payload?.date || ''
  };
}

// Disabled/hidden state of the controls behind the trust-loop bugs: "Save greyed out"
// and "composer won't let me type" are ABOUT a stuck state — capture it directly instead
// of inferring it from pending_write.
function uiStateForBugReport() {
  const prop = (id, name) => {
    const node = document.getElementById(id);
    return node ? !!node[name] : null;
  };
  return {
    composer_disabled: prop('workout-text', 'disabled'),
    preview_btn_disabled: prop('preview-btn', 'disabled'),
    approve_btn_disabled: prop('approve-btn', 'disabled'),
    parsed_rows_hidden: prop('parsed-rows-editor', 'hidden'),
    preview_panel_hidden: prop('preview-panel', 'hidden'),
    resume_notice_hidden: prop('session-resume-notice', 'hidden')
  };
}

// Service-worker / cache state — "a fix didn't take" is usually a stale shell, not a code
// bug. A waiting SW or an old cache key makes that diagnosable in one glance. Async, so
// it's merged in by the async save path rather than the sync payload builder.
async function serviceWorkerStateForBugReport() {
  const out = { supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator };
  try {
    if (navigator.serviceWorker) {
      out.controller = !!navigator.serviceWorker.controller;
      const reg = navigator.serviceWorker.getRegistration ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) {
        out.active = !!reg.active;
        out.waiting = !!reg.waiting;       // update downloaded but not yet applied = stale shell
        out.installing = !!reg.installing;
      }
    }
    if (typeof caches !== 'undefined' && caches.keys) {
      out.cache_keys = (await caches.keys()).filter(k => /atlas/i.test(k));
    }
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  }
  return out;
}

function buildAtlasBugReportPayload(note, options = {}) {
  const now = options.now || new Date();
  const payload = {
    bug_id: options.bugId || bugReportId(now),
    timestamp: now.toISOString(),
    note: note || '',
    route: currentRouteForBugReport(),
    composer_text: workoutTextInput?.value || '',
    visible_messages: visibleMessagesForBugReport(),
    active_session_object: typeof getCanonicalSession === 'function' ? getCanonicalSession() : null,
    active_planned_session: getActivePlannedSession() || null,
    pending_exercises: pendingRowsForBugReport(),
    parsed_rows: pendingRowsForBugReport(),
    pending_preview: previewContent ? previewContent.textContent.trim().slice(0, 4000) : '',
    pending_write: pendingWrite || null,
    write_id: pendingWrite?.writeId || pendingWrite?.payload?.write_id || '',
    last_error: getAtlasLastError(),
    recent_errors: atlasRecentErrors.slice(-BUG_REPORT_ERROR_LIMIT),
    action_log: atlasActionLog.slice(-BUG_REPORT_ACTION_LIMIT),
    ui_state: uiStateForBugReport(),
    current_sheet: currentSheetForBugReport(),
    storage: {
      localStorage: collectAtlasStorage(window.localStorage),
      sessionStorage: collectAtlasStorage(window.sessionStorage)
    },
    app_version: {
      shell: ATLAS_SHELL_BUILD,
      version: atlasServerVersion?.version || null,
      deployed_at: atlasServerVersion?.deployed_at || null,
      pr: atlasServerVersion?.pr || null,
      git_sha: atlasServerVersion?.version || null,
      build_timestamp: atlasServerVersion?.deployed_at || null
    },
    browser: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      online: navigator.onLine,
      // The server only sees UTC; the session-id / date bugs (AM/PM boundary) are
      // local-clock-sensitive, so capture the device clock and connection quality.
      local_time: now.toString(),
      timezone_offset_min: now.getTimezoneOffset(),
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })(),
      connection: (navigator.connection && {
        effective_type: navigator.connection.effectiveType || null,
        downlink: navigator.connection.downlink ?? null,
        rtt: navigator.connection.rtt ?? null
      }) || null
    },
    recent_api_requests: atlasRecentApiRequests.slice(-BUG_REPORT_RECENT_API_LIMIT).map(r => ({ ...r }))
  };
  // The report rides in one Google Sheets cell (~50k char limit). Request/response bodies
  // are the elastic part, so if we're over budget shed them oldest-first until we fit —
  // the notes, errors, session state, and breadcrumbs (the diagnosis) always survive.
  let trim = 0;
  while (JSON.stringify(payload).length > BUG_REPORT_SIZE_BUDGET && trim < payload.recent_api_requests.length) {
    delete payload.recent_api_requests[trim].request_body;
    delete payload.recent_api_requests[trim].response_body;
    trim += 1;
  }
  return redactBugReportValue(payload);
}

async function exposeBugReportJson(payload, targetBox) {
  const json = JSON.stringify(payload, null, 2);
  try { await navigator.clipboard?.writeText(json); } catch { /* clipboard unavailable */ }
  const pre = document.createElement('pre');
  pre.className = 'debug-pre';
  pre.textContent = json;
  if (targetBox) targetBox.appendChild(pre);
}

async function saveAtlasBugReport(note, options = {}) {
  const payload = buildAtlasBugReportPayload(note, options);
  // Service-worker / cache state is async, so it's merged after the sync build. Values are
  // booleans + cache names (no secrets), so they're safe to attach post-redaction.
  try { payload.service_worker = await serviceWorkerStateForBugReport(); } catch { /* best-effort */ }
  const statusTarget = options.statusTarget || loggerStatus || document.getElementById('debug-result');
  try {
    const res = await api('/api/bug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const bugId = res?.data?.bug_id || payload.bug_id;
    setStatus(statusTarget, `Bug report saved â€” ${bugId}`, 'ok');
    return { ok: true, bugId, payload };
  } catch (err) {
    payload.recent_api_requests = atlasRecentApiRequests.slice(-BUG_REPORT_RECENT_API_LIMIT);
    setStatus(statusTarget, 'Bug report could not be saved. Copy report JSON?', 'error');
    await exposeBugReportJson(payload, statusTarget);
    return { ok: false, error: err, payload };
  }
}

function parseBugCommand(text) {
  const match = String(text || '').match(/^\/bug(?:\s+([\s\S]*))?$/i);
  return match ? (match[1] || '').trim() : null;
}

document.getElementById('report-bug-btn')?.addEventListener('click', () => {
  const box = document.getElementById('debug-result');
  box.innerHTML = '';
  const note = window.prompt ? window.prompt('Bug note?') : '';
  saveAtlasBugReport(note || '', { statusTarget: box });
});

/* ===== Dashboard (read-only) ===== */

function startLift(exercise, liftCode, targetWeight, targetReps, targetSets) {
  // Switch to Log Workout tab
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const logBtn = document.querySelector('[data-tab="logger"]');
  if (logBtn) logBtn.classList.add('active');
  const logTab = document.getElementById('tab-logger');
  if (logTab) logTab.classList.add('active');

  // The coach top-card was retired (composer-chat UI simplification): the Coach
  // tab is just the composer + conversation thread. startLift now only switches to
  // the logger and pre-fills the composer; the engine's read reaches the athlete
  // through the thread, not a stacked top-of-tab panel.

  // Pre-fill workout textarea if empty
  const textarea = document.getElementById('workout-text');
  if (textarea && !textarea.value.trim()) {
    textarea.value = `${exercise} ${targetWeight} ${targetReps} x${targetSets}`;
  }
}

// Dashboard "not connected" placeholder — the connect prompt appears only when the
// server has confirmed the negative (a real 401 / a sessions-enabled status saying so),
// never from a synchronous client flag. Module-level so it's reusable and testable.
function renderDashboardConnectPrompt() {
  const pickBox = document.getElementById('todays-pick');
  if (pickBox) pickBox.innerHTML = '<span class="muted">Connect Atlas in Settings to see today\'s plan.</span>';
  for (const id of ['progress-snapshot', 'intent-grid', 'coaching', 'weekly-summary', 'recent-history', 'recent-prs', 'stalls']) {
    const target = document.getElementById(id);
    if (target) target.innerHTML = '<span class="muted">Connect Atlas in Settings to load data.</span>';
  }
}

async function loadDashboard() {
  // Fast path: the server has ALREADY confirmed this browser is unauthenticated, so
  // prompt to connect without a doomed round-trip. Server-authoritative, not a
  // synchronous flag — isConnected() is false only after a real 401 / negative status.
  if (!isConnected()) { renderDashboardConnectPrompt(); return; }

  // Fire intent-recommendation + progress/summary first — they feed the above-fold region.
  const [intentResult, summaryResult] = await Promise.allSettled([
    api('/api/plan/intent-recommendation'),
    api('/api/progress/summary')
  ]);

  const intentData = intentResult.status === 'fulfilled' ? (intentResult.value.data || {}) : null;
  const summaryData = summaryResult.status === 'fulfilled' ? (summaryResult.value.data || {}) : null;

  // A real 401 on the optimistic attempt is the authoritative not-connected signal
  // (see renderDashboardConnectPrompt) — a transport failure is not, so it falls through.
  if (!intentData && intentResult.reason && intentResult.reason.status === 401) {
    renderDashboardConnectPrompt();
    return;
  }

  if (intentData) lastIntentData = intentData;

  if (intentData) {
    renderTodaysRead(intentData);
    renderCoachReadStrip(intentData, summaryData);
    renderTodaysPick(intentData);
    renderIntentGrid(intentData);
    renderPatternBoard(intentData);
    setOtherTrainingHint(intentData);
  } else {
    const pickBox = document.getElementById('todays-pick');
    if (pickBox) pickBox.innerHTML = '<span class="muted">Could not load today\'s pick.</span>';
  }

  if (summaryData) {
    renderConsistencyLine(summaryData);
    renderProgressSnapshot(summaryData);
    setGlanceHint('this-week-hint', buildConsistencyText(summaryData));
  } else {
    const line = document.getElementById('consistency-line');
    if (line) line.innerHTML = '<span class="muted">Could not load.</span>';
  }

  wireStartSessionBtn(intentData);

  // Coach-first home opener (owner 2026-07-03, PR-1): hand the coach hero a
  // deterministic, engine-grounded coaching DECISION built from the SAME startup
  // fetch — no second network call, no LLM. coach-conversation.js paints it into
  // the guide box; it degrades to the default tagline when the engine named no
  // session (cold start / offline / no key).
  emitGlanceReady(intentData);

  // Below-fold sources load independently; each fills its own glance card.
  loadCoaching();
  loadWeeklySummary();
  loadRecentHistory();
  loadRecentPrs();
  loadStalls();
}

// Coach-first home opener (owner 2026-07-03, PR-1): the hero speaks a coaching
// DECISION, not a dashboard. Deterministic + LLM-free — every word is the
// engine's. The recommended session's own focus states today's call; its own
// why_today sentence (worded verbatim) gives the one-line reason; a fixed
// conversational invitation opens the door. Removed on purpose — the dashboard
// tells the owner named: the "{Weekday}. Today's read: {label}." announcement,
// the stacked consistency + freshest-pattern facts wall, and any days-since.
// TODAY-ONLY: focus and why_today are single-session engine output — nothing
// here forecasts a future session or invents a posture the engine did not pick.
// Returns '' (→ nothing dispatched) when the engine named no session, so the
// default tagline stands.
function buildCoachOpener(intentData) {
  const todaysRead = (intentData && intentData.todays_read) || {};
  const intents = (intentData && Array.isArray(intentData.intents)) ? intentData.intents : [];
  const rec = intents.find(i => i && i.recommended) ||
              intents.find(i => i && i.id && i.id === todaysRead.recommended_intent_id) ||
              null;
  // The decision is the recommended session's focus — a short phrase in the
  // engine (recommended_reason === top.focus) and the fixtures alike. Fall back
  // through the read's own fields; with nothing named, there is no opener.
  const decision = ((rec && rec.focus) || todaysRead.recommended_reason ||
                    todaysRead.recommended_label || '').toString().trim();
  if (!decision) return '';
  // The reason is the engine's OWN why_today sentence, worded verbatim — never
  // invented, never a forecast (why_today is single-session). Dropped when it's a
  // near-duplicate of the call (the low-data default why_today can mirror the focus,
  // e.g. 'Good time for heavy compound work' vs 'Heavy compound work') so the opener
  // never restates itself.
  const why = (rec && Array.isArray(rec.why_today) && rec.why_today.length)
    ? (rec.why_today[0] || '').toString().trim() : '';
  const reason = (why && !isNearDuplicateReason(why, decision)) ? `${endSentence(why)} ` : '';
  return `${reason}Today, let's make it ${lowerLead(decision)}. Ready when you are — or tell me to change the plan.`;
}

// End a borrowed clause as its own sentence (strip any trailing terminal
// punctuation — . ; : , ! ? — and connectors, then add a single period, so a
// why_today ending in '!'/'?' never double-punctuates to 'Ready?.').
function endSentence(s) {
  const t = s.toString().trim().replace(/[\s.;:,!?—–-]+$/, '');
  return t ? `${t}.` : '';
}

// Lowercase only a plain leading capital so a label reads mid-sentence; leave
// acronyms (OHP, RIR) and already-lowercase text untouched.
function lowerLead(s) {
  const t = s.toString().trim();
  return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

// Near-duplicate guard: the engine's low-data default why_today can restate the
// focus ('Good time for heavy compound work' vs 'Heavy compound work'). Word-
// boundary containment (either phrase wholly inside the other, punctuation-
// insensitive) → the opener drops the reason clause rather than echo the call.
// Whole-word bounded so a shared stem ('push' vs 'pushing patterns are fresh')
// is NOT treated as a duplicate.
function isNearDuplicateReason(why, decision) {
  const norm = s => s.toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const w = norm(why), d = norm(decision);
  if (!w || !d) return false;
  const wp = ` ${w} `, dp = ` ${d} `;
  return wp.includes(dp) || dp.includes(wp);
}

// Resolve the recommended intent's focus (the "call") — shared by the compressed
// opener and its signature.
function recommendedFrom(intentData) {
  const todaysRead = (intentData && intentData.todays_read) || {};
  const intents = (intentData && Array.isArray(intentData.intents)) ? intentData.intents : [];
  const rec = intents.find(i => i && i.recommended) ||
              intents.find(i => i && i.id && i.id === todaysRead.recommended_intent_id) || null;
  const decision = ((rec && rec.focus) || todaysRead.recommended_reason ||
                    todaysRead.recommended_label || '').toString().trim();
  return { todaysRead, rec, decision };
}

// Anti-repetition (PR-2, display-only): a same-day reopen with UNCHANGED engine
// state should not re-brief the full paragraph. The compressed continuation is a
// short, floored line (never blank) that words the SAME decision the engine
// already made — it invents nothing. openerSignature identifies "this engine read
// today" from the engine's own output; the ledger (coach-conversation.js) uses it
// to choose full-vs-compressed. Deliberately NOT here: varying the ANGLE and
// withdrawing advice ignored twice are coaching decisions and stay owner-gated for
// the engine (North-Star opener endpoint) — the frontend only de-dups an identical
// render, never decides what to coach.
function compressedOpener(intentData) {
  const { decision } = recommendedFrom(intentData);
  if (!decision) return '';
  return `Still here. ${decision} whenever you're ready.`;
}
function openerDayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;  // local calendar day
}
function openerSignature(intentData) {
  const { todaysRead } = recommendedFrom(intentData);
  const id = todaysRead.recommended_intent_id;
  if (!id) return '';  // no read → no signature → never compresses
  const gap = todaysRead.days_since_last_session ?? '';
  return `${openerDayKey()}|${id}|${gap}`;
}

// Dispatch the deterministic coach opener for the hero (coach-conversation.js
// paints it) — built from loadDashboard's own fetch, no second call, no LLM.
// Dispatches nothing when the engine named no session, so the default hero
// stands (degradation = doing nothing). Carries a same-day de-dup signature + a
// compressed continuation so a repeat reopen doesn't re-brief.
function emitGlanceReady(intentData) {
  if (typeof document === 'undefined') return;
  const opener = buildCoachOpener(intentData);
  if (!opener) return;  // nothing meaningful → the default hero stands
  document.dispatchEvent(new CustomEvent('atlas:glance-ready', {
    detail: {
      opener,
      compressed: compressedOpener(intentData),
      signature: openerSignature(intentData),
      day: openerDayKey()
    }
  }));
}

/* ===== Coach plan card (read-only, Coach surface) =====
 * Surfaces today's focus, the lift to pick back up, its last working set, and
 * the next-set suggestion — all from existing read endpoints. It never writes.
 * A missing API key or a failed/empty fetch leaves the card hidden so the
 * logger is never blocked. */
async function loadCoachPlan() {
  const card = document.getElementById('coach-plan-card');
  if (!card) return;
  if (!isConnected()) { card.hidden = true; return; }

  const [intentResult, planResult] = await Promise.allSettled([
    api('/api/plan/intent-recommendation'),
    api('/api/plan/today')
  ]);

  const todaysRead = intentResult.status === 'fulfilled'
    ? (intentResult.value.data?.todays_read || {})
    : {};
  const recs = planResult.status === 'fulfilled'
    ? (planResult.value.data?.recommendations || [])
    : [];

  const focusReason = todaysRead.recommended_reason || '';
  const topRec = recs[0] || null;

  // The focus headline already shows in the read-strip above, so this card adds
  // only the supporting reason + the actionable next-lift detail. Nothing to
  // add → stay quiet rather than render an empty shell.
  if (!focusReason && !topRec) { card.hidden = true; return; }

  renderCoachPlan(card, { focusReason, topRec });
  card.hidden = false;
}

function renderCoachPlan(card, { focusReason, topRec }) {
  card.innerHTML = '';
  card.appendChild(el('div', { class: 'coach-plan-kicker', text: 'Today’s plan' }));

  // 1) Supporting reason for today's focus (the label itself lives in the
  //    read-strip above, so it isn't repeated here).
  if (focusReason) {
    card.appendChild(el('div', { class: 'coach-plan-reason', text: focusReason }));
  }

  if (topRec) {
    const name = topRec.exercise_name || topRec.liftCode;
    card.appendChild(el('div', { class: 'coach-plan-lift', text: name }));

    // 2) Last relevant session context.
    const sets = topRec.last_working_sets || [];
    const last = sets.length ? sets[sets.length - 1] : null;
    if (last && (last.weight != null || last.reps != null)) {
      const rir = last.rir == null ? '' : ` @ RIR ${last.rir}`;
      const when = last.date_clean ? `Last (${last.date_clean})` : 'Last';
      card.appendChild(el('div', { class: 'coach-plan-last', text: `${when}: ${formatSetLoad(last.weight, last.reps)}${rir}` }));
    }

    // 3) Recommended next lift / weight / reps.
    const t = topRec.next_target;
    if (t && (t.weight != null || t.reps != null)) {
      card.appendChild(el('div', { class: 'coach-plan-target', text: `Next: ${t.weight} × ${t.reps} · ${t.sets} sets` }));
    }

    // 4) Short plain-English coaching sentence.
    if (topRec.recommendation) {
      card.appendChild(el('p', { class: 'coach-plan-suggestion', text: topRec.recommendation }));
    }
  }
}

/* ===== Weekly coach check-in card (read-only, Coach surface) =====
 * A short "how's this week going" summary: sessions, volume trend, which lifts
 * are progressing vs steady, and one nudge. Read-only; a missing key or a failed
 * core fetch leaves the card hidden so the logger is never blocked. */
async function loadWeeklyCoach() {
  const card = document.getElementById('weekly-coach-card');
  if (!card) return;
  if (!isConnected()) { card.hidden = true; return; }

  const [reportResult, insightsResult] = await Promise.allSettled([
    api('/api/report/weekly'),
    api('/api/coaching/insights')
  ]);

  // report/weekly is the core source — without it there's nothing to show.
  if (reportResult.status !== 'fulfilled') { card.hidden = true; return; }
  const report = reportResult.value.data || {};
  const fatigue = insightsResult.status === 'fulfilled'
    ? (insightsResult.value.data?.fatigue || {})
    : {};

  renderWeeklyCoach(card, report, fatigue);
  card.hidden = false;
}

function renderWeeklyCoach(card, report, fatigue) {
  card.innerHTML = '';
  card.appendChild(el('div', { class: 'coach-plan-kicker', text: 'This week' }));

  const sessions = Number(report.sessions_count || 0);
  if (!sessions) {
    card.appendChild(el('div', { class: 'weekly-coach-summary', text: 'No training logged in the last 7 days yet.' }));
    card.appendChild(el('p', { class: 'weekly-coach-nudge', text: 'Nudge: a short session restarts your momentum.' }));
    return;
  }

  const clauses = [`${sessions} session${sessions === 1 ? '' : 's'}`];

  // Volume trend vs recent average (fatigue ratio), expressed as a percentage.
  if (fatigue && Number.isFinite(fatigue.ratio)) {
    const pct = Math.round((fatigue.ratio - 1) * 100);
    if (pct >= 3) clauses.push(`volume up ${pct}%`);
    else if (pct <= -3) clauses.push(`volume down ${-pct}%`);
    else clauses.push('volume steady');
  }

  const progressing = (report.prs || []).map(p => p.exercise || p.lift_code).filter(Boolean).slice(0, 2);
  if (progressing.length) clauses.push(`${progressing.join(' & ')} progressing`);

  const steady = (report.stalls_or_watchouts || []).map(s => s.exercise || s.liftCode).filter(Boolean).slice(0, 2);
  if (steady.length) clauses.push(`${steady.join(' & ')} steady`);

  card.appendChild(el('div', { class: 'weekly-coach-summary', text: `${clauses.join(', ')}.` }));

  const nudge = pickWeeklyNudge(report);
  if (nudge) card.appendChild(el('p', { class: 'weekly-coach-nudge', text: `Nudge: ${nudge}` }));
}

// Prefer a recommendation for a lift flagged as steady/stalled (where a nudge
// helps most); otherwise fall back to the top lift's recommendation.
function pickWeeklyNudge(report) {
  const recs = (report.recommendations || []).filter(r => r.recommendation);
  if (!recs.length) return '';
  const watchoutCodes = new Set((report.stalls_or_watchouts || []).map(s => String(s.liftCode || '').toUpperCase()));
  const watch = recs.find(r => watchoutCodes.has(String(r.lift_code || '').toUpperCase()));
  return (watch || recs[0]).recommendation;
}

/* ===== Training Snapshot (read-only — rendered from loadDashboard's progress/summary fetch) ===== */

function renderProgressSnapshot(s) {
  const box = document.getElementById('progress-snapshot');
  if (!box) return;
  box.innerHTML = '';

  const target = Number(s.streak_target_per_week || 3);
  const grid = el('div', { class: 'metric-grid' });
  const metrics = [
    [s.total_sessions, 'Total sessions'],
    [s.average_sessions_per_week, 'Avg / week'],
    [s.total_sets, 'Total sets'],
    [`${s.current_week_sessions ?? 0}/${target}`, 'This week']
  ];
  for (const [value, label] of metrics) {
    grid.appendChild(el('div', { class: 'metric-tile' }, [
      el('div', { class: 'metric-value', text: String(value ?? '—') }),
      el('div', { class: 'metric-label', text: label })
    ]));
  }
  box.appendChild(grid);

  // Consistency streak — fire is for showing up, not overtraining.
  const streak = Number(s.weekly_streak || 0);
  if (streak > 0) {
    box.appendChild(el('div', { class: 'streak-line streak-active', text: `\u{1F525} ${streak}-week streak` }));
    box.appendChild(el('p', { class: 'streak-sub', text: `You've hit ${target}+ sessions/week for ${streak} week${streak === 1 ? '' : 's'} in a row.` }));
  } else {
    const remaining = Math.max(0, target - Number(s.current_week_sessions || 0));
    box.appendChild(el('div', { class: 'streak-line streak-paused', text: 'Streak paused' }));
    box.appendChild(el('p', { class: 'streak-sub', text: `Log ${remaining} more session${remaining === 1 ? '' : 's'} this week to restart your ${target}x/week streak.` }));
  }

  // 12-week consistency strip
  const weeks = s.sessions_by_week || [];
  if (weeks.length) {
    const strip = el('div', { class: 'consistency-strip' });
    const max = Math.max(target, ...weeks.map(w => Number(w.sessions) || 0));
    for (const w of weeks) {
      const sessions = Number(w.sessions) || 0;
      const cls = sessions === 0 ? 'week-bar week-bar-zero' : sessions >= target ? 'week-bar week-bar-hit' : 'week-bar';
      const bar = el('div', { class: cls });
      bar.style.height = `${Math.max(6, Math.round((sessions / max) * 38))}px`;
      bar.title = `Week of ${w.week_start}: ${sessions} session${sessions === 1 ? '' : 's'}`;
      strip.appendChild(bar);
    }
    box.appendChild(strip);
    box.appendChild(el('p', { class: 'muted small', text: `Each bar = 1 week · ${target}+ sessions lights a streak week · last ${weeks.length} weeks` }));
  }
}

/* ===== Intent Dashboard — rendering handled by loadDashboard ===== */

// Plain-language overrides so the glance layer never needs gym jargon.
const FRIENDLY_PATTERN_LABELS = { Hinge: 'Hips & back', Pressing: 'Push', Pulling: 'Pull', 'Lower body': 'Legs' };
const FRIENDLY_STATUS_WORDS = { fatigued: 'Worked', recovering: 'Recovering', ready: 'Ready', fresh: 'Fresh', unknown: '—' };

// One-line readiness tooltip: when last trained, how recovered, how hard that session was.
function readinessTitle(p) {
  const parts = [p.detail || p.status || ''];
  if (p.recovery != null) parts.push(`${Math.round(p.recovery * 100)}% recovered`);
  if (p.effortIntensity != null) parts.push(`last effort ${Math.round(p.effortIntensity * 100)}%`);
  return parts.filter(Boolean).join(' · ');
}

function renderTodaysRead(data) {
  const box = document.getElementById('todays-read');
  if (!box) return;
  const todaysRead = data.todays_read || {};
  const patterns = todaysRead.patterns || [];

  box.innerHTML = '';

  const dotRow = el('div', { class: 'pattern-dots' });
  for (const p of patterns) {
    const status = p.status || 'unknown';
    const rawLabel = p.label || p.pattern;
    const pct = p.recovery == null ? 0 : Math.round(p.recovery * 100);
    const recoveryFill = el('div', { class: `pattern-recovery-fill pattern-dot-${status}` });
    recoveryFill.style.setProperty('--fill', `${pct}%`);
    const recoveryBar = el('div', { class: 'pattern-recovery', title: readinessTitle(p) }, [recoveryFill]);
    const wrap = el('div', { class: 'pattern-dot-wrap' }, [
      el('div', { class: `pattern-dot pattern-dot-${status}`, title: readinessTitle(p) }),
      el('div', { class: 'pattern-dot-label', text: FRIENDLY_PATTERN_LABELS[rawLabel] || rawLabel }),
      el('div', { class: `pattern-dot-status pattern-status-${status}`, text: FRIENDLY_STATUS_WORDS[status] || status }),
      recoveryBar
    ]);
    dotRow.appendChild(wrap);
  }
  box.appendChild(dotRow);

  // recommended_label and reason now live in #todays-pick via renderTodaysPick
  if (!patterns.length) box.hidden = true;
  else box.hidden = false;
}

// Composer-first Phase A — the glance line. One row of passive awareness above
// the hero (the design review's deliberate "know without asking" affordance):
// streak · per-pattern readiness dots · today's context. Upgraded IN PLACE from
// the shipped read-strip rather than adding a rival element (Invariant I1).
// Read-only; every value verbatim from the two dashboard fetches that already
// run at startup — the streak from /api/progress/summary, dots and today-label
// from /api/plan/intent-recommendation. Renders whatever subset exists.
function renderCoachReadStrip(data, summary) {
  const strip = document.getElementById('coach-read-strip');
  if (!strip) return;
  const todaysRead = data.todays_read || {};
  const patterns = todaysRead.patterns || [];
  const streak = summary ? Number(summary.weekly_streak || 0) : 0;
  if (!patterns.length && !(streak > 0)) return;
  // Composer-first Phase B3: the glance line is the tap-to-expand affordance —
  // cache what it shows so the expansion artifact words the same facts.
  lastGlanceData = { patterns, streak, summary: summary || null, todaysRead };
  strip.setAttribute('role', 'button');
  strip.tabIndex = 0;
  strip.setAttribute('aria-label', 'Where you stand — tap for details');
  strip.title = 'Tap for details';
  strip.innerHTML = '';
  if (streak > 0) {
    strip.appendChild(el('span', { class: 'strip-streak', text: `\u{1F525} ${streak}-wk streak` }));
  }
  const dots = el('div', { class: 'strip-dots' });
  for (const p of patterns) {
    const status = p.status || 'unknown';
    const rawLabel = p.label || p.pattern;
    const friendly = `${FRIENDLY_PATTERN_LABELS[rawLabel] || rawLabel}: ${FRIENDLY_STATUS_WORDS[status] || status}`;
    const recovery = p.recovery == null ? '' : ` (${Math.round(p.recovery * 100)}% recovered)`;
    dots.appendChild(el('span', {
      class: `strip-dot pattern-dot-${status}`,
      title: `${friendly}${recovery}`
    }));
  }
  strip.appendChild(dots);
  if (todaysRead.recommended_label) {
    strip.appendChild(el('span', { class: 'strip-rec', text: `Today: ${todaysRead.recommended_label}` }));
  }
}

/* ===== Glance expansion (composer-first Phase B3) =====
 * Tapping the glance line expands it into an in-thread status artifact — the
 * "1 row, tap→artifact" affordance of the adopted design. READ-ONLY and
 * deterministic: it words only the facts the strip already holds (cached at
 * render time — no fetch, no LLM, no write). The Progress tab keeps the full
 * detail; this is its glance-expansion demotion, evidence-first. */
let lastGlanceData = null;

function renderGlanceArtifact() {
  if (!lastGlanceData) return;
  const thread = document.getElementById('thread-messages');
  if (!thread) return;
  const { patterns, streak, summary, todaysRead } = lastGlanceData;

  const wrap = el('div', { class: 'glance-artifact' });
  wrap.appendChild(el('div', { class: 'chip-reply-title', text: 'Where you stand' }));

  if (summary) {
    wrap.appendChild(el('div', { class: 'chip-reply-row', text: buildConsistencyText(summary) }));
  } else if (streak > 0) {
    wrap.appendChild(el('div', { class: 'chip-reply-row', text: `\u{1F525} ${streak}-week streak` }));
  }

  for (const p of patterns) {
    const status = p.status || 'unknown';
    const rawLabel = p.label || p.pattern;
    const label = FRIENDLY_PATTERN_LABELS[rawLabel] || rawLabel;
    const word = FRIENDLY_STATUS_WORDS[status] || status;
    const recovery = p.recovery == null ? '' : ` · ${Math.round(p.recovery * 100)}% recovered`;
    const days = p.daysSince == null ? '' : ` · last trained ${p.daysSince}d ago`;
    wrap.appendChild(el('div', { class: `chip-reply-row glance-row-${status}`, text: `${label}: ${word}${recovery}${days}` }));
  }

  if (todaysRead.recommended_label) {
    wrap.appendChild(el('div', { class: 'chip-reply-row', text: `Today: ${todaysRead.recommended_label}` }));
  }

  const more = el('a', { href: '#', class: 'chip-reply-more', text: 'Full progress →' });
  more.addEventListener('click', ev => {
    ev.preventDefault();
    // Phase D: the surface toggle is gone — land on Today via the tab engine
    // (same route the drawer's Progress row uses).
    document.querySelector('.tab-btn[data-tab="dashboard"]')?.click();
  });
  wrap.appendChild(more);

  const bubble = el('div', { class: 'chat-bubble chat-bubble-atlas' });
  bubble.appendChild(wrap);
  // Re-tap refreshes rather than clutters (review #808): if the newest thread
  // message is already a glance artifact, replace it in place; only append
  // when the conversation has moved on since the last expansion.
  const last = thread.lastElementChild;
  if (last && last.querySelector && last.querySelector('.glance-artifact')) {
    last.replaceWith(bubble);
  } else {
    thread.appendChild(bubble);
  }
  requestAnimationFrame(() => bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

// One listener at startup; the strip only becomes tappable (role/tabindex set
// in renderCoachReadStrip) once it has content, and the guard above makes an
// early tap a no-op.
document.getElementById('coach-read-strip')?.addEventListener('click', renderGlanceArtifact);
document.getElementById('coach-read-strip')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renderGlanceArtifact(); }
});

function renderIntentGrid(data) {
  const box = document.getElementById('intent-grid');
  if (!box) return;
  box.innerHTML = '';
  const intents = data.intents || [];
  const grid = el('div', { class: 'intent-grid' });
  for (const intent of intents) {
    const tileClass = `intent-tile${intent.recommended ? ' intent-tile-recommended' : ''}`;
    const tile = el('button', { type: 'button', class: tileClass });
    if (intent.recommended) {
      tile.appendChild(el('span', { class: 'intent-star', text: '★ ' }));
    }
    tile.appendChild(el('span', { class: 'intent-tile-label', text: intent.label }));
    if (intent.focus) {
      tile.appendChild(el('span', { class: 'intent-tile-focus', text: intent.focus }));
    }
    tile.addEventListener('click', () => openIntentDrawer(intent));
    grid.appendChild(tile);
  }
  box.appendChild(grid);
  box.appendChild(el('p', { class: 'muted hint', text: 'Tap any tile to see the coaching brief and start a session.' }));
}

// Per-movement-pattern recovery board. The backend already returns `patterns`
// (Pressing / Pulling / Lower body / Hinge / Core) on the intent-recommendation
// response, each with a readiness status and a plain-language detail line. This
// surfaces them as tiles sorted so the most-recovered / overdue patterns lead —
// a glance at what's ready to train and what's still resting. Tapping a tile
// asks the coach for a session focused on that pattern (read-only — no write).
const PATTERN_STATUS_META = {
  fresh:      { label: 'Fresh',      rank: 0 },
  ready:      { label: 'Ready',      rank: 1 },
  recovering: { label: 'Recovering', rank: 2 },
  fatigued:   { label: 'Fatigued',   rank: 3 },
  unknown:    { label: 'No data',    rank: 4 }
};

function renderPatternBoard(data) {
  const box = document.getElementById('pattern-board');
  if (!box) return;
  box.innerHTML = '';
  const patterns = ((data.todays_read && data.todays_read.patterns) || []).filter(p => p && p.label);
  if (!patterns.length) {
    box.appendChild(el('p', { class: 'muted', text: 'Log a few sessions and Atlas can track recovery per movement.' }));
    setGlanceHint('pattern-board-hint', '');
    return;
  }

  // Overdue / most-recovered first; never-trained patterns sink to the bottom.
  const sorted = [...patterns].sort((a, b) => {
    const ra = PATTERN_STATUS_META[a.status]?.rank ?? 9;
    const rb = PATTERN_STATUS_META[b.status]?.rank ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.daysSince ?? -1) - (a.daysSince ?? -1);
  });

  const grid = el('div', { class: 'pattern-board' });
  for (const p of sorted) {
    const status = PATTERN_STATUS_META[p.status] ? p.status : 'unknown';
    const meta = PATTERN_STATUS_META[status];
    // Rotation-overdue flag: a fully recovered pattern untouched for a while is
    // the clearest coverage gap — mirror the intent engine's "fresh" rotation cue.
    const overdue = (status === 'fresh' || status === 'unknown') && (p.daysSince == null || p.daysSince >= 5);

    const tile = el('button', { type: 'button', class: `pattern-tile pattern-${status}` });
    const top = el('div', { class: 'pattern-tile-top' }, [
      el('span', { class: 'pattern-tile-label', text: p.label }),
      el('span', { class: `pattern-pill pattern-pill-${status}`, text: meta.label })
    ]);
    if (overdue) top.appendChild(el('span', { class: 'pattern-overdue', text: 'overdue' }));
    tile.appendChild(top);
    if (p.detail) tile.appendChild(el('span', { class: 'pattern-tile-detail', text: p.detail }));
    tile.addEventListener('click', () => {
      // The board lives on the Today surface but the coach reply lands in the
      // Coach thread — switch there first so the answer is visible, not orphaned.
      document.querySelector('.tab-btn[data-tab="logger"]')?.click();
      routeMessageToCoach(`What should I train for ${p.label.toLowerCase()} today?`);
    });
    grid.appendChild(tile);
  }
  box.appendChild(grid);
  box.appendChild(el('p', { class: 'muted hint', text: 'Tap a movement to ask Atlas for a session focused on it.' }));

  const ready = patterns.filter(p => p.status === 'fresh' || p.status === 'ready').length;
  const resting = patterns.filter(p => p.status === 'fatigued').length;
  const parts = [];
  if (ready) parts.push(`${ready} ready`);
  if (resting) parts.push(`${resting} resting`);
  setGlanceHint('pattern-board-hint', parts.join(' · ') || 'Recovery tracked');
}

/* ===== Today — hero card, consistency line, start-session wiring ===== */

function renderTodaysPick(data) {
  const box = document.getElementById('todays-pick');
  if (!box) return;
  box.innerHTML = '';
  const todaysRead = data.todays_read || {};
  const intents = data.intents || [];
  const recommended = intents.find(i => i.recommended);

  if (!todaysRead.recommended_label) {
    box.appendChild(el('p', { class: 'muted', text: 'Log a few sessions and Atlas can start suggesting what to train.' }));
    return;
  }

  box.appendChild(el('div', { class: 'today-pick-headline', text: `Today: ${todaysRead.recommended_label}` }));

  const whyLines = recommended?.why_today?.slice(0, 2) || [];
  const reason = whyLines.length
    ? whyLines[0]
    : todaysRead.recommended_reason || recommended?.focus || '';
  if (reason) {
    box.appendChild(el('p', { class: 'today-pick-reason', text: reason }));
  }
  if (whyLines.length > 1) {
    box.appendChild(el('p', { class: 'today-pick-reason muted', text: whyLines[1] }));
  }

  // Composer-first Phase B: the card is a LINK into the canonical in-thread
  // Coach's Pick, not a second recommendation home of its own.
  const link = el('button', { type: 'button', class: 'today-pick-link', text: 'Open with your coach →' });
  // No constraints from a plain entry point — call with none so the click Event is
  // never mistaken for a constraints object (the default recommendation).
  link.addEventListener('click', () => openCoachPickInThread());
  box.appendChild(link);
}

// Composer-first Phase B — the ONE canonical recommendation. Every "today's
// recommendation" entry point (pick card, START SESSION, nav's session link,
// a typed "what are we doing today?") lands here: switch to the coach surface
// and render the same in-thread Coach's Pick (window.atlasOpenCoachPick, which
// engages the suggestion). The intent DRAWER remains only for the
// non-recommended "Other training options" grid.
function openCoachPickInThread(constraints) {
  // Land on the coach surface via the tab engine (the Phase D header has no
  // surface toggle; the hidden logger tab-btn is the programmatic route).
  document.querySelector('.tab-btn[data-tab="logger"]')?.click();
  // `constraints` (requested first exercise / focus) flow to the authoritative pipeline;
  // undefined for the plain entry points (link/tile), which keep the default recommendation.
  if (typeof window.atlasOpenCoachPick === 'function') window.atlasOpenCoachPick(constraints);
}

function buildConsistencyText(s) {
  const target = Number(s.streak_target_per_week || 3);
  const streak = Number(s.weekly_streak || 0);
  const current = Number(s.current_week_sessions || 0);
  if (streak > 0) {
    return `\u{1F525} ${streak}-week streak · ${current}/${target} this week`;
  }
  const remaining = Math.max(0, target - current);
  return `${current}/${target} sessions this week · ${remaining} more to restart your streak`;
}

function renderConsistencyLine(s) {
  const box = document.getElementById('consistency-line');
  if (!box) return;
  box.textContent = buildConsistencyText(s);
}

function setOtherTrainingHint(data) {
  const intents = data.intents || [];
  const others = intents.filter(i => !i.recommended);
  setGlanceHint('other-training-hint', others.length ? `${others.length} other option${others.length === 1 ? '' : 's'}` : 'See all options');
}

function wireStartSessionBtn(data) {
  const btn = document.getElementById('start-session-btn');
  if (!btn) return;
  if (!data) { btn.hidden = true; return; }
  const recommended = (data.intents || []).find(i => i.recommended);

  // Composer-first Phase B: the recommendation's action routes to the ONE
  // canonical in-thread Coach's Pick (typeSuggestedWorkout handles both the
  // structured-plan and no-exercises cases), never a second drawer home.
  if (recommended) {
    btn.textContent = 'START SESSION';
    btn.hidden = false;
    btn.onclick = () => openCoachPickInThread();
  } else {
    btn.hidden = true;
  }
}

// Normalize an intent's exercise entry to one shape. Intents emit
// { exercise, lift_code, target_weight, target_reps, target_sets, reason };
// also tolerate a next_target shape just in case. `rir` is carried through so
// the suggested-workout display can show it (and never silently drop it).
function normalizePlanExercise(raw) {
  if (!raw) return { name: '', canonicalName: '', liftCode: '', weight: null, reps: null, sets: null, rir: null, reason: '' };
  const t = raw.next_target || {};
  const pick = (...vals) => { for (const v of vals) if (v != null) return v; return null; };
  return {
    // Idempotent: also reads an already-normalized entry's plain `.name`/`.weight`
    // keys (PR-12) so a single stored model can be re-rendered by appendWorkoutPlan
    // without a second, drift-prone re-mapping. The raw API-intent keys keep priority.
    name: raw.exercise || raw.exercise_name || raw.name || raw.lift_code || raw.liftCode || '',
    // canonicalName mirrors currentPlanForChat's preference (canonical_exercise first)
    // so resolveCompletedIdentity and current_plan[].name always agree.
    canonicalName: raw.canonical_exercise || raw.canonicalExercise || raw.canonicalName || '',
    liftCode: raw.lift_code || raw.liftCode || '',
    weight: pick(raw.target_weight, t.weight, raw.weight),
    reps: pick(raw.target_reps, t.reps, raw.reps),
    sets: pick(raw.target_sets, t.sets, raw.sets),
    rir: pick(raw.target_rir, t.rir, raw.rir),
    reason: raw.reason || ''
  };
}

/* ===== Active planned session (in-memory, Start Session) =====
 * Slice 1: track the recommended workout as a queue with a cursor, show a
 * banner with the current step, and open each item in the logger via startLift.
 * No persistence; logging/preview/save stays exactly as it was.
 * PR-10: activePlannedSession / sessionChromeExpanded now live in store.js. */

// Whether the lifter has ENGAGED today's coach suggestion (tapped Coach's Pick),
// as opposed to merely having the dashboard open. `loadDashboard()` always loads
// `lastIntentData` to render the home-screen pick, but a *displayed* suggestion is
// not an *active plan* — so plannedExerciseEntries() must only treat lastIntentData
// as the plan once the lifter actually engages it. Without this gate, a cold
// direct-composer log was narrated as if mid-plan ("Moving on — next up: …") and
// the composer was pre-filled with the next suggested lift. Set true by Coach's
// Pick (typeSuggestedWorkout), false by Freestyle; an active planned session takes
// precedence regardless. Defaults false on every load (no persistence).
// PR-10: coachSuggestionEngaged now lives in store.js.

// Step 373b: when the lifter declares a swap for the current step ("Lat bar is
// taken, I'll do seated rows instead"), we record the prescribed (swapped-out)
// lift here. The NEXT logged exercise is treated as the substitute and replaces
// that slot in the live session. Gated on an explicit swap declaration so it
// never misfires on ordinary added work.
// PR-10: pendingSubstitution now lives in store.js.

// getActivePlannedSession / getSessionCompleted are imported from store.js and
// re-exported on window below for coach-conversation.js (the coach layer must
// never mutate the session directly — only app.js advances/ends it via
// advancePlannedSession and endPlannedSession).

// The active training intent id (e.g. 'recovery_pump', 'deload_reset'). A started
// session carries it on activePlannedSession; but an ENGAGED Coach's Pick that the
// lifter logs against WITHOUT a mutation never materializes one (activePlannedSession
// stays null — see ensureActivePlannedSession), so fall back to the engaged
// suggestion's recommended intent. Without this, a Recovery/Pump session logged
// straight from Coach's Pick lost its intent and got an "add load" nudge
// (BUG-20260629-204817). Returns null in freestyle / when nothing is engaged.
function getActiveIntentId() {
  if (getActivePlannedSession() && getActivePlannedSession().intentId) return getActivePlannedSession().intentId;
  if (getCoachSuggestionEngaged() && lastIntentData) {
    const rec = ((lastIntentData.intents) || []).find(i => i && i.recommended);
    if (rec && rec.id) return rec.id;
  }
  return null;
}

// P0 Active Workout State Unification — the ONE canonical view of the in-progress
// workout, derived from the authoritative store (the planned order from
// plannedExerciseEntries() + the logged set sessionCompleted[]) through the shared
// public/activeSession.js model. Every consumer (composer prefill, next-up router,
// recap, preview/save) derives from THIS in the read-consolidation slice, so they
// can never disagree about identity / completion / order again. Built fresh on each
// call from the store, so there is no second copy to keep in sync. Returns null
// when no plan is active. (Sub-PR 1 establishes it; Sub-PR 2 wires the readers.)
function getCanonicalSession() {
  const AS = (typeof window !== 'undefined' && window.activeSession) || (typeof activeSession !== 'undefined' ? activeSession : null);
  if (!AS) return null;
  const entries = plannedExerciseEntries();
  if (!entries.length && !(Array.isArray(getSessionCompleted()) && getSessionCompleted().length)) return null;
  let s = AS.createActiveSession({
    exercises: entries.map(e => ({ name: e.canonical || e.name, liftCode: e.liftCode || '' }))
  });
  // Replay logged completions onto the canonical session THROUGH the F10 selector
  // (F10S1): a planned slot is marked done in the AS model only when the selector says
  // it COMPLETED — attribution alone is not completion once the slot's required set
  // count is known (one performed set must not complete a 3-set slot; the slot stays
  // the AS model's current exercise while in progress). A logged name that attributes
  // to NO slot is an off-plan insert (Hammer Curls / Knee Raises) so it is
  // represented, not dropped — exactly as before.
  const completions = Array.isArray(getSessionCompleted()) ? getSessionCompleted() : [];
  const statuses = planSlotStatuses(activePlanForSlots(), completions, getSessionLog());
  const attributed = new Set(statuses.filter(x => x.attributedName).map(x => String(x.attributedName).toLowerCase()));
  for (const slot of statuses) {
    if (slot.status === 'completed' && slot.name) s = AS.markCompleted(s, slot.name);
  }
  for (const name of completions) {
    if (attributed.has(String(name).toLowerCase())) continue; // plan work (done or in progress)
    s = AS.markCompleted(AS.insertExercise(s, { name }), name); // off-plan insert
  }
  return s;
}

// Map a canonical ActiveSession to the `plan_exercises` save payload (B2 — the
// save surface derives from the SAME canonical model the confirmation card, coach
// context, mid-session sub-payload, and preview read, so it can never drift from
// the visible session). PURE — no globals, no I/O — so the Node tests run the
// identical logic. Planned-origin only: an off-plan insert (Hammer Curls / Knee
// Raises) is logged work but never a PRESCRIBED source, so it must not enter the
// substitution inference (inferPrescribedPairs) as a planned lift. Completed and
// pending planned slots are BOTH kept: a fulfilled planned lift must stay so its
// logged row is exact-matched and claimed (preventing a false broad-region pair),
// and a still-pending planned lift is the legitimate substitution source.
function planExercisesFromCanonical(session) {
  if (!session || !Array.isArray(session.exercises)) return [];
  return session.exercises
    .filter(e => e && e.source !== 'inserted')
    .map(e => ({ name: e.name, ...(e.liftCode ? { lift_code: e.liftCode } : {}) }))
    .filter(p => p.name);
}

// Coach-suggestion engagement flag accessors for the coach layer (coach-conversation.js).
// setCoachSuggestionEngaged() fires when the lifter taps Coach's Pick; clear on Freestyle.
// PR-10: get/setCoachSuggestionEngaged are imported from store.js; setter re-exported
// on window below for coach-conversation.js.

// Step 373b: replace a prescribed slot in the LIVE planned session with the
// actually-logged substitute, so the swapped-out lift leaves remaining and the
// substitute is what gets marked done. Inline mirror of applySubstitution in
// services/sessionPlanExecutor.js (the browser can't require() the service).
// keep in sync with applySubstitution in services/sessionPlanExecutor.js
// Returns true when the live plan actually changed (a slot was swapped or a
// duplicate slot removed), false on any no-op/early-return — so the caller only
// announces a swap that really happened (PR-570 cosmetic note).
function applySessionSubstitution(prescribedName, subName, subLiftCode, prescription) {
  if (!getActivePlannedSession() || !Array.isArray(getActivePlannedSession().exercises)) return false;
  if (!prescribedName || !subName) return false;
  const exs = getActivePlannedSession().exercises;
  const prescKey = String(prescribedName).toLowerCase();
  const subKey = String(subName).toLowerCase();
  if (subKey === prescKey) return false; // nothing to swap
  const idx = exs.findIndex(e =>
    (e.canonicalName || e.name || '').toLowerCase() === prescKey ||
    (e.name || '').toLowerCase() === prescKey);
  if (idx === -1) return false;
  // PR-G1: the substituted item KEEPS the original planned item's immutable
  // plan_item_id (read off the slot before it is replaced/spliced). The replacement
  // slot below retains it so a later action still resolves the accepted item.
  const originalItemId = exs[idx].plan_item_id;
  // F10B — the ACCEPTED plan's set count for this slot (the v1 ledger grain), read
  // BEFORE the in-place swap below overwrites it. A revision bounds its future sets by
  // THIS count so every revised set has a v1 predecessor — never by the substitute's own
  // prescribed set count (which can differ and would dangle/strand the chain).
  const originalSetCount = exs[idx].sets;
  const subCode = String(subLiftCode || '').toLowerCase();
  // Dedupe: if the substitute is already a slot elsewhere, drop the prescribed
  // slot instead of duplicating it (one logged set must not close two slots).
  const dupElsewhere = exs.some((e, i) => i !== idx && (
    (e.canonicalName || e.name || '').toLowerCase() === subKey ||
    (subCode && (e.liftCode || '').toLowerCase() === subCode)
  ));
  if (dupElsewhere) {
    exs.splice(idx, 1);
    // Cursor must follow the removed slot, clamped so it never points past the
    // end (removing the current+last slot would otherwise crash the banner).
    // keep in sync with clampCursorAfterRemoval in services/sessionPlanExecutor.js
    let next = getActivePlannedSession().index;
    if (next > idx) next -= 1;
    if (next >= exs.length) next = Math.max(0, exs.length - 1);
    getActivePlannedSession().index = Math.max(0, next);
  } else {
    // AC3: use the prescription from the substitute-check API when available so the
    // replacement slot carries the correct weight/reps/sets instead of null.
    const p = prescription && typeof prescription === 'object' ? prescription : {};
    exs[idx] = {
      name: subName, canonicalName: subName, liftCode: subLiftCode || '',
      weight: p.weight != null ? p.weight : null,
      reps: p.reps != null ? p.reps : null,
      // F10S2/F10S1: with no explicit substitute prescription (the one-turn
      // "instead of" directive carries none), the slot KEEPS the original's set
      // count — the athlete is doing the original prescription with a different
      // movement, and dropping the count would let one substitute set complete a
      // multi-set slot (the multiplicity rule needs requiredSets to survive).
      sets: p.sets != null ? p.sets : (originalSetCount != null ? originalSetCount : null),
      rir: p.rir != null ? p.rir : null,
      reason: 'substituted',
      // Keep the ORIGINAL planned item's identity on the slot (PR-G1) — the item was
      // substituted, not replaced by a new plan item.
      plan_item_id: originalItemId
    };
    // F10B — the in-place swap is an EXPLICIT mid-session recommendation for THIS slot's
    // FUTURE (unperformed) sets. Checkpoint it as a durable revision (append-only,
    // reload-safe, dry-run), bounded by the accepted set count so every revised set has a
    // v1 predecessor. Performed sets stay frozen; driven by the explicit swap, NEVER by a
    // performed value. (The dedupe branch above removes the slot → no future sets → no
    // revision.)
    if (originalItemId) emitFutureSetRevision(originalItemId, subLiftCode, prescription, prescribedName, originalSetCount);
  }
  renderActiveSessionBanner();
  // PR-G1: emit the explicit `substituted` outcome — the accepted item keeps its
  // planned_lift_code (resolved server-side by plan_item_id) and records the actual
  // performed_lift_code. Fails closed if the slot had no identity (unaccepted plan).
  if (originalItemId) emitPlanItemOutcome({ plan_item_id: originalItemId, outcome: 'substituted', performed_lift_code: subLiftCode });
  return true;
}

// F10B — form and checkpoint the durable set-level revision(s) for an explicit
// mid-session recommendation on an ACCEPTED plan slot. Builds one revision per FUTURE
// (unperformed) set from the explicit prescription (never from a performed value),
// appends them append-only to the session revisions (persisted for reload), and posts
// each to the dry-run /revision checkpoint. No-op without an accepted plan, a canonical
// substitute code, or a complete explicit target — it never fabricates a revision.
// `acceptedSetCount` is the slot's ACCEPTED (v1) set count — the ledger grain the
// revision is bounded by, so every revised set has a v1 predecessor (an increased
// substitute set count can never create a dangling chain, a decreased one can never
// strand a stale v1 row). The substitute's own prescribed set count is deliberately NOT
// used for the bound.
function emitFutureSetRevision(planItemId, subLiftCode, prescription, prescribedName, acceptedSetCount) {
  const plan = getActivePlannedSession();
  // Returns TRUE only when revisions were actually built, persisted and posted. A caller that
  // reports success on a no-op would tell the athlete their plan changed when session truth did
  // not move (Codex P2, #1163).
  if (!plan || plan.accepted !== true || !planItemId) return false; // only an accepted plan carries ledger identity
  const p = prescription && typeof prescription === 'object' ? prescription : {};
  const revisions = buildFutureRevisions({
    plan_item_id: planItemId,
    planned_lift_code: subLiftCode,
    target_weight: p.weight,
    target_reps: p.reps,
    target_rir: p.rir,
    target_set_count: acceptedSetCount,
    performedCount: ledgerPerformedSetCount(getSessionLog(), prescribedName),
    sessionRevisions: getSessionRevisions(),
  });
  if (!revisions.length) return false;
  setSessionRevisions(appendRevisions(getSessionRevisions(), revisions));
  if (typeof saveSessionSnapshot === 'function') saveSessionSnapshot(); // durable across reload
  for (const revision of revisions) {
    Promise.resolve(api('/api/session-plan-sets/revision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: plan.session_id, session_date: plan.session_date, plan_version: plan.plan_version, revision }),
    })).catch(() => { /* non-blocking sidecar — never unwinds the workout */ });
  }
  return true;
}

// #1163 — the NON-SUBSTITUTION entry point for an explicitly endorsed set-level prescription
// change ("keep back squat, drop the rest to 185x5"). Before this existed,
// `emitFutureSetRevision` had exactly ONE caller — inside `applySessionSubstitution` — so a
// set-level revision was captured only as a side effect of a movement swap, and an endorsement
// that changed load or reps while keeping the movement reached no capture at all.
//
// It adds NO new machinery. The revision building, future-set bound, append-only chain, reload
// persistence, and checkpoint POST are all the existing lane: this only supplies the trigger and
// carries the planned lift code through UNCHANGED, so the movement is not claimed to have
// changed. It deliberately does NOT emit an item_outcome — a load change is not a substitution,
// and recording one would corrupt the movement-level planned-versus-completed record.
//
// Fails closed on anything short of an unambiguous endorsement: a decline, a question, or a bare
// acknowledgement never rewrites the remaining sets.
function emitEndorsedSetRevision(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const planItemId = o.plan_item_id;
  const liftCode = o.planned_lift_code;
  const prescribedName = o.prescribed_name;
  if (!planItemId || !liftCode || !prescribedName) return false;
  // When the caller passes the athlete's words, they must be an explicit endorsement. A caller
  // that has already established consent by another route may omit the field entirely; passing
  // an empty or non-endorsing message is always a refusal.
  if (Object.prototype.hasOwnProperty.call(o, 'endorsement')
    && !isExplicitEndorsement(o.endorsement)) return false;
  // Propagate the REAL outcome. An unaccepted plan, an incomplete prescription, or a movement
  // whose sets are all already performed emits nothing — and must not be reported as captured.
  return emitFutureSetRevision(planItemId, liftCode, o.prescription, prescribedName, o.accepted_set_count) === true;
}

// F10C — a DETERMINISTIC plan_item_id for the implicit recommendation of an unannounced
// lift: stable per (session, lift) so a re-log of the same off-plan exercise is
// idempotent (identical server idempotency_key → one ledger row at F10D, one client rec),
// and distinct from the crypto-UUID ids minted for accepted slots.
function implicitPlanItemId(sessionId, liftCode) {
  const s = String(sessionId || '').replace(/[^a-zA-Z0-9]/g, '');
  const c = String(liftCode || '').replace(/[^a-zA-Z0-9]/g, '');
  return `pi_impl_${s}_${c}`;
}

// F10C — is a just-logged exercise OFF the accepted plan (unannounced)? Reuses the F10
// slot selector in ISOLATION (one completion vs the plan's slots, no explicit outcomes)
// so this can never diverge from how a log is attributed to a slot. Off-plan ⟺ the
// name/liftCode ATTRIBUTES to no slot (F10S1: attribution, not completion — an
// in-progress multi-set slot is very much ON plan). No plan / no slots → not off-plan
// (nothing to recommend against — implicit recs are scoped to accepted-plan sessions).
function isOffPlanLoggedExercise(plan, name, liftCode) {
  if (!plan || !Array.isArray(plan.exercises) || !plan.exercises.length) return false;
  const statuses = planSlotStatuses({ exercises: plan.exercises }, [{ name, liftCode }]);
  return !statuses.some(s => s.attributedName || s.status === 'completed');
}

// F10C — append an implicit recommendation, deduped by its (deterministic) plan_item_id
// so a double-fire or a reload never duplicates it. Append-only; returns a NEW array.
function appendImplicitRec(recs, rec) {
  const base = Array.isArray(recs) ? recs.slice() : [];
  if (!rec || !rec.plan_item_id || base.some(r => r.plan_item_id === rec.plan_item_id)) return base;
  base.push(rec);
  return base;
}

// F10C — form and checkpoint the IMPLICIT recommendation for an exercise the athlete
// logged WITHOUT asking (unannounced/off-plan). The server DERIVES it leakage-safe from
// prior sessions (the current session is excluded there), so this only triggers the
// derivation and stores a RELIABLE result for reload; a no_reliable_target result stores
// nothing (no row, §4A rule 5). No-op without an accepted plan (which carries the pv_
// identity), a canonical lift code, or when this lift already has an implicit rec this
// session. Dry-run, non-blocking — never unwinds the workout.
function emitImplicitRecommendation(exerciseName, liftCode) {
  const plan = getActivePlannedSession();
  if (!plan || plan.accepted !== true) return; // scoped to accepted-plan sessions (pv_ identity)
  const code = String(liftCode || '').trim();
  if (!code) return; // an implicit recommendation needs a canonical lift code
  const planItemId = implicitPlanItemId(plan.session_id, code);
  if (getSessionImplicitRecs().some(r => r.plan_item_id === planItemId)) return; // one per lift/session
  Promise.resolve(api('/api/session-plan-sets/implicit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: plan.session_id, session_date: plan.session_date, plan_version: plan.plan_version,
      item: { plan_item_id: planItemId, planned_lift_code: code, exercise_name: exerciseName || '' },
    }),
  })).then((res) => {
    const d = res && res.data && res.data.derivation;
    if (!d || d.confidence !== 'reliable') return; // no_reliable_target → store nothing (no row)
    // Guard a STALE response: if the session changed while /implicit was in flight (save /
    // start-over / discard / a different accepted plan), drop it — never append an old
    // session's recommendation into a later session's cache + snapshot (which would undo a
    // reset and cross-contaminate the reload cache). The store update happens in this async
    // callback (the derivation is server-side), so this re-check is required.
    const cur = getActivePlannedSession();
    if (!cur || cur.accepted !== true || cur.session_id !== plan.session_id || cur.plan_version !== plan.plan_version) return;
    setSessionImplicitRecs(appendImplicitRec(getSessionImplicitRecs(), {
      plan_item_id: planItemId, planned_lift_code: code, exercise_name: exerciseName || '',
      target_weight: d.target_weight, target_reps: d.target_reps, target_rir: d.target_rir, target_set_count: 1,
    }));
    if (typeof saveSessionSnapshot === 'function') saveSessionSnapshot(); // durable across reload
  }).catch(() => { /* non-blocking sidecar — never unwinds the workout */ });
}

// PR-2 (Workout Sheet drag-to-reorder): move a PENDING plan slot to a new position in
// the LIVE plan. The visible order lives in ONE place — activePlannedSession.exercises —
// which getCanonicalSession() / plannedExerciseOrder() / remainingPlannedExercises() all
// derive from, so permuting it here is the WHOLE mutation (no dual-write, no cursor
// drift).
//
// keep in sync with activeSession.reorderExercise (src/app/activeSession.js) — the pure
// engine over the CANONICAL model. Same RULE: completed slots and the CURRENT lift (the
// first unlogged one) are PINNED; only the pending region AFTER the current is permuted.
// Different SIGNATURE by design: the engine's toIndex is pending-RELATIVE (an index among
// the pending entries), whereas this live twin takes ABSOLUTE indices into the rich
// activePlannedSession.exercises (the sheet card's slot − 1) and resolves the pending run
// itself. The two are proven to yield identical ActiveSession state by the
// workout-sheet-reorder e2e (CASE D/E), which drives this wrapper and compares it against
// activeSession.reorderExercise for the same logical move.
//
// It is a PLAN MUTATION, not a data write: no write_id, no Sheets call, no proof fields,
// and NO Session_Plans outcome — a reorder has no outcome vocabulary (the item is neither
// completed, skipped, nor substituted), so unlike skip/substitute it emits nothing to the
// capture lane. fromIndex/toIndex are positions in activePlannedSession.exercises (the
// sheet card's slot number − 1). Returns true only when the order actually changed.
function reorderPlannedExercise(fromIndex, toIndex) {
  const plan = getActivePlannedSession();
  if (!plan || !Array.isArray(plan.exercises)) return false;
  const exs = plan.exercises;
  const from = Math.trunc(Number(fromIndex));
  const to = Math.trunc(Number(toIndex));
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || from >= exs.length || to < 0 || to >= exs.length) return false;
  // The pending region: plan slots not yet logged, in order (pending[0] = the current
  // lift). Completed slots are pinned in place; a skipped slot never exists here (skip
  // splices it out). Completion identity matches remainingPlannedExercises exactly.
  const completed = new Set(getSessionCompleted().map(c => String(c).toLowerCase()));
  const isPending = e => {
    const n = String((e && (e.canonicalName || e.name)) || '').toLowerCase();
    return n && !completed.has(n);
  };
  const pending = [];
  for (let i = 0; i < exs.length; i++) if (isPending(exs[i])) pending.push(i);
  const srcPos = pending.indexOf(from);
  const destPos = pending.indexOf(to);
  if (srcPos <= 0) return false;          // the source must be a pending, NON-current slot
  if (destPos < 1) return false;          // never land on/ahead of the current (or a pinned slot)
  if (srcPos === destPos) return false;   // unchanged
  const pendingEntries = pending.map(i => exs[i]);
  const [moved] = pendingEntries.splice(srcPos, 1);
  pendingEntries.splice(destPos, 0, moved);
  pending.forEach((i, k) => { exs[i] = pendingEntries[k]; });
  // The current lift never moved (pending[0] is pinned), so keep the cursor on it — the
  // banner/composer keep following the same in-progress lift.
  plan.index = pending.length ? pending[0] : Math.max(0, Math.min(Number(plan.index) || 0, exs.length - 1));
  renderActiveSessionBanner();
  if (typeof renderSessionPin === 'function') renderSessionPin();
  // Propagate through the ONE canonical event so the pin and the sheet re-render — but
  // with an EMPTY detail: a reorder must not narrate a coach bubble or re-point the
  // composer (the coach handler skips both on empty summary/current). The sheet shows
  // its own lightweight toast.
  document.dispatchEvent(new CustomEvent('atlas:plan-mutated', { detail: { summary: '', current: null, reorder: true } }));
  return true;
}

function startPlannedSession(intent) {
  const exercises = (intent.exercises || []).map(normalizePlanExercise).filter(ex => ex.name);
  if (!exercises.length) return;
  // Lifecycle symmetry (Step 373b): a new session never inherits a stale swap.
  setPendingSubstitution(null);
  setActivePlannedSession({
    label: intent.label || 'Recommended session',
    // The plan intent id (e.g. 'deload_reset') rides along so the in-workout
    // reaction can flip on a deload day — see fetchReaction.
    intentId: intent.id || null,
    exercises,
    index: 0
  });
  // Hide the home-screen hero so the active-session banner and coach panel
  // are the only things visible. hideHomeEmpty() in coach-conversation.js does
  // the same op but is private to that IIFE.
  document.getElementById('coach-empty')?.setAttribute('hidden', '');
  renderActiveSessionBanner();
  // Step 385: begin the deload state machine when a deload_reset session starts.
  // Fire-and-forget — never block the session UI. 409 = already in deload, fine.
  if (intent.id === 'deload_reset') {
    api('/api/deload/begin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ focus: 'strength', reason: 'owner started deload session' })
    }).catch(() => {});
  }
  saveSessionSnapshot();   // persist the started plan for resume safety
  const first = exercises[0];
  startLift(first.name, first.liftCode, first.weight, first.reps, first.sets || 3);
}

// ── PR-F: "Start this plan" — the authoritative plan-acceptance boundary ───────
// The ONLY new acceptance action (docs/SESSION_PLANS_CAPTURE_SPEC.md §5). Thin
// adapter: gather real deps and delegate to runAcceptance (planAcceptance.js), which
// mints opaque pv_/pi_ identity, stores + persists the immutable accepted snapshot,
// starts the workout, and fires the non-blocking /accept sidecar POST. The workout
// starts regardless of the flag/sidecar; memory language is shown only on
// captured===true. `_acceptInFlight` guards a double-tap from minting a 2nd revision.
//
// #1165 — BOUNDED sidecar wait. runAcceptance awaits postAccept before it resolves, and
// the mid-session gate's held-set resume runs only on that resolution, so a sidecar that
// never settles stranded the athlete's set forever behind a blank UI (reproduced in
// tests/e2e/gate/acceptance-sidecar-stall.spec.js). api() sets no timeout by design, so
// the bound lives HERE, on this one call — not as a global api() timeout.
const ACCEPT_SIDECAR_TIMEOUT_MS = 10000;
let _acceptInFlight = false;
async function acceptDisplayedPlan(rec) {
  if (_acceptInFlight) return { started: false, ignored: true, message: null };
  _acceptInFlight = true;
  // Set when the bound below fires, so the caller can say the plan record is UNCONFIRMED
  // instead of showing nothing. It never upgrades a claim: runAcceptance treats the abort
  // as any other sidecar failure, so captured stays false and no persistence is asserted.
  let sidecarTimedOut = false;
  try {
    const exercises = ((rec && rec.exercises) || []).map(normalizePlanExercise).filter(ex => ex.name);
    const sessionDate = getLocalDateString();
    const sessionIdEl = typeof document !== 'undefined' ? document.getElementById('log-session-id') : null;
    const existingId = sessionIdEl && sessionIdEl.value ? sessionIdEl.value.trim() : '';
    const sessionId = existingId || generateSessionId(sessionDate);
    const cryptoObj = (typeof window !== 'undefined' && window.crypto) ? window.crypto
      : (typeof crypto !== 'undefined' ? crypto : null);
    const accepted = await runAcceptance({ label: rec && rec.label, id: rec && rec.id, exercises }, {
      crypto: cryptoObj,
      guard: {},
      sessionId,
      sessionDate,
      // A newly-accepted session must not inherit a stale swap from an
      // abandoned/reloaded prior session (mirrors startPlannedSession's
      // setPendingSubstitution(null), Step 373b) — cleared as the accepted plan is
      // stored, before it is persisted.
      setActivePlan: (plan) => { setPendingSubstitution(null); setSessionRevisions([]); setSessionImplicitRecs([]); setActivePlannedSession(plan); },
      persist: () => {
        document.getElementById('coach-empty')?.setAttribute('hidden', '');
        if (sessionIdEl && !existingId) sessionIdEl.value = sessionId; // reuse this id on the eventual save
        saveSessionSnapshot();
      },
      startWorkout: (plan) => {
        renderActiveSessionBanner();
        const first = plan.exercises[0];
        if (first) startLift(first.name, first.liftCode, first.weight, first.reps, first.sets || 3);
      },
      // #1165 — the ONE awaited sidecar call, bounded so acceptance always settles.
      // On timeout the request is aborted: api() never retries an AbortError, and
      // runAcceptance's catch keeps the accepted snapshot with captured=false — so a
      // stall degrades to "started, unconfirmed", never a stranded set and never a
      // persistence claim. No write path is reachable from here.
      postAccept: (payload) => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller
          ? setTimeout(() => { sidecarTimedOut = true; controller.abort(); }, ACCEPT_SIDECAR_TIMEOUT_MS)
          : null;
        const request = api('/api/session-plans/accept', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          ...(controller ? { signal: controller.signal } : {}),
        });
        return timer ? request.finally(() => clearTimeout(timer)) : request;
      },
      // F10B — durably checkpoint the accepted plan as the set-level ledger v1 (design
      // amendment A2). Non-blocking sidecar; dry-run until F10D. Same additive shape as
      // postAccept — never the preview→approve→write path.
      postLedgerCheckpoint: (payload) => api('/api/session-plan-sets/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }),
    });
    return sidecarTimedOut ? { ...accepted, sidecarTimedOut: true } : accepted;
  } finally {
    _acceptInFlight = false;
  }
}

// PR-G1 — fire an EXPLICIT item outcome (skipped / substituted) for the current
// accepted plan, non-blocking. Identity is the immutable plan_item_id read off the
// slot by the caller; runOutcome fails closed (no event) when the plan isn't an
// accepted session or the id is unknown — never a lift-code/name/position fallback.
// Fire-and-forget: the workout action already happened; a sidecar failure never
// blocks it, and retries reuse the same event identity (server idempotency).
function emitPlanItemOutcome(outcomeInput) {
  const plan = getActivePlannedSession();
  if (!plan || plan.accepted !== true) return; // only accepted plans carry identity
  runOutcome(plan, outcomeInput, {
    postOutcome: (payload) => api('/api/session-plans/outcome', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
  }).catch(() => { /* runOutcome never throws; belt-and-suspenders */ });
}

// PR-H — fire an EXPLICIT session closeout (finalized / abandoned) for the current
// accepted plan, non-blocking. Reads the immutable session_id + plan_version off the
// plan and fails closed for a non-accepted session. Wired ONLY at the explicit
// Finish/End-session and Start-over/discard affordances — NEVER inside the implicit
// endPlannedSession cleanup paths. Fire-and-forget: the local close/discard proceeds
// regardless; a sidecar failure never blocks it, and retries reuse the same identity.
function emitPlanCloseout(closeoutStatus) {
  const plan = getActivePlannedSession();
  if (!plan || plan.accepted !== true) return; // closeout only for an accepted session
  runPlanCloseout(plan, closeoutStatus, {
    postCloseout: (payload) => api('/api/session-plans/closeout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
  }).catch(() => { /* runPlanCloseout never throws; belt-and-suspenders */ });
}

// ── P0 Sub-PR 2a: deterministic plan mutation from explicit user intent ────────
// A swap/skip the lifter STATES ("skip deadlifts and do squats") mutates the
// canonical session IMMEDIATELY — the app state owns the change, not LLM prose.

// Resolve a free-text exercise phrase to a catalog canonical name + lift code, so
// a swapped-in slot carries the canonical identity a later log will match.
// Singularization is conservative: it drops a trailing plural "s" ONLY when it
// follows a non-"s" character ("squats"→"squat", "curls"→"curl") so genuine
// "ss" endings are preserved ("press" stays "press", "leg press" stays intact) —
// the loose every-word strip mis-bound lifts (PR-570 review). Falls back to the raw phrase.
function resolveCatalogExercise(phrase) {
  const raw = String(phrase == null ? '' : phrase).trim();
  if (!raw || typeof document === 'undefined') return { name: raw, liftCode: '' };
  const dl = document.getElementById('exercise-catalog');
  const opts = dl ? Array.from(dl.options || []) : [];
  const singular = s => { const t = String(s || '').toLowerCase().trim(); return /[^s]s$/.test(t) ? t.slice(0, -1) : t; };
  const key = raw.toLowerCase();
  const skey = singular(raw);
  // Refuse to guess on ambiguity (mirrors findMatchIndex, PR-570 review): exact name
  // → UNIQUE singular-equal → UNIQUE substring. If >1 (or 0) match, leave the slot as
  // the raw phrase rather than arbitrarily binding by catalog order; a later log
  // re-resolves identity through the trust loop anyway.
  let opt = opts.find(o => (o.value || '').toLowerCase() === key);
  if (!opt) {
    const eq = opts.filter(o => singular(o.value) === skey);
    if (eq.length === 1) opt = eq[0];
  }
  if (!opt) {
    const sub = opts.filter(o => { const v = singular(o.value); return v && (v.includes(skey) || skey.includes(v)); });
    if (sub.length === 1) opt = sub[0];
  }
  // `matched` is true ONLY when a catalog option was found (not an echoed raw
  // phrase) — callers that must not act on an unknown phrase gate on it.
  return opt ? { name: opt.value, liftCode: opt.label || '', matched: true } : { name: raw, liftCode: '', matched: false };
}

// Skip a planned exercise: SPLICE it out of the live queue (it stops showing as
// current/remaining) and clamp the cursor. Note this differs from
// activeSession.skipExercise, which RETAINS the slot as status:'skipped' — here the
// live activePlannedSession store has no skipped state, so we remove the slot
// (consistent with the existing applySessionSubstitution dedupe path). Representing
// a skipped slot as skipped (vs absent) in the canonical recap is deferred to 2b
// (see BACKLOG.md).
function skipPlannedExercise(name) {
  if (!getActivePlannedSession() || !Array.isArray(getActivePlannedSession().exercises)) return false;
  const key = String(name || '').toLowerCase();
  const idx = getActivePlannedSession().exercises.findIndex(e =>
    (e.canonicalName || e.name || '').toLowerCase() === key || (e.name || '').toLowerCase() === key);
  if (idx === -1) return false;
  // PR-G1: capture the immutable plan_item_id off the slot BEFORE splicing (accepted
  // plans only), so the explicit skip can emit its outcome by identity — not by the
  // name/position that the splice destroys.
  const removedItemId = getActivePlannedSession().exercises[idx].plan_item_id;
  getActivePlannedSession().exercises.splice(idx, 1);
  let next = getActivePlannedSession().index;
  if (next > idx) next -= 1;
  if (next >= getActivePlannedSession().exercises.length) next = Math.max(0, getActivePlannedSession().exercises.length - 1);
  getActivePlannedSession().index = Math.max(0, next);
  renderActiveSessionBanner();
  if (removedItemId) emitPlanItemOutcome({ plan_item_id: removedItemId, outcome: 'skipped' });
  return true;
}

// Tell the coach layer a mutation happened so it can confirm it + re-point the
// composer to the new current exercise (composer ownership stays in coach-conversation).
function announcePlanMutation(summary, currentName) {
  renderActiveSessionBanner();
  document.dispatchEvent(new CustomEvent('atlas:plan-mutated', {
    detail: { summary: summary || '', current: currentName || null }
  }));
}

// Materialize a mutable active session from an ENGAGED Coach's Pick suggestion.
// A typed Coach's Pick (typeSuggestedWorkout) sets coachSuggestionEngaged + leaves
// the plan in lastIntentData WITHOUT a started activePlannedSession — so an explicit
// swap/skip had nothing mutable to act on and fell through to the coach (live-gym
// v48: "let's do rdls instead of deadlifts" hit the coach-down fallback instead of
// swapping). On the first mutation, promote the suggestion to a live session
// (carrying its prescription) so the deterministic swap/skip works in BOTH states.
// Returns true when an active session exists (or was just materialized).
function ensureActivePlannedSession() {
  if (getActivePlannedSession() && Array.isArray(getActivePlannedSession().exercises) && getActivePlannedSession().exercises.length) return true;
  if (!getCoachSuggestionEngaged() || !lastIntentData) return false;
  const intents = (lastIntentData && lastIntentData.intents) || [];
  const rec = intents.find(i => i.recommended);
  const exercises = (rec && Array.isArray(rec.exercises) ? rec.exercises : [])
    .map(normalizePlanExercise).filter(ex => ex.name);
  if (!exercises.length) return false;
  setActivePlannedSession({
    label: (rec && rec.label) || 'Recommended session',
    intentId: (rec && rec.id) || null,
    exercises,
    index: 0
  });
  renderActiveSessionBanner();
  return true;
}

// Classify an explicit swap/skip and apply it to the canonical session. Returns
// true when handled (caller then skips the substitute/coach routing). A non-mutation
// message, or no active plan (freestyle), or a target not in the plan → false (fall
// through). Materializes an engaged suggestion into a live session ONLY for a genuine
// mutation, so freestyle/no-plan logging stays untouched.
function tryApplyPlanMutation(text) {
  const PM = (typeof window !== 'undefined' && window.planMutationIntent) || null;
  if (!PM) return false;
  const intent = PM.classifyMutationIntent(text);
  if (!intent) return false;                  // classify FIRST — never materialize on non-mutations
  // This deterministic sync path handles a one-sided SKIP only. An IMPLICIT substitution
  // (engine picks the sub) is async (tryApplyImplicitSubstitution); an EXPLICIT REPLACE is
  // now a GATED PROPOSAL (tryProposeReplacement, which runs BEFORE this lane) — a direct
  // "replace X with Y" must never immediately mutate the plan (production trust fix
  // FR-20260723031748). Guard defensively so a replace can never fall into the immediate
  // splice below even if the proposer declined it.
  if (intent.action !== 'skip') return false;
  if (!ensureActivePlannedSession()) return false; // no plan at all (freestyle) → fall through
  // Resolve the (possibly compound, e.g. "deadlifts/rdls") target to PENDING plan
  // slots via the canonical session — singular-aware (matches "Romanian Deadlift")
  // and never matching a completed/skipped slot (no re-opening finished work).
  const canon = getCanonicalSession();
  const planEntries = canon && Array.isArray(canon.exercises) && canon.exercises.length
    ? canon.exercises
    : getActivePlannedSession().exercises.map(e => ({ name: e.canonicalName || e.name, liftCode: e.liftCode || '', status: 'pending' }));
  const curName = () => {
    // After a mutation (splice/replace), firstUnloggedPlannedLift gives the correct
    // new current exercise — the stale cursor may not have advanced yet.
    const unlogged = firstUnloggedPlannedLift();
    if (unlogged) return unlogged;
    const cur = getActivePlannedSession().exercises[getActivePlannedSession().index];
    return cur ? (cur.canonicalName || cur.name) : null;
  };
  // A POSITIONAL intent ("swap next workout for dips", "swap to dips", "replace next
  // exercise with dips") names the slot by position — resolve it to the current/next
  // PENDING slot, not by fuzzy-matching a lift name (the live repro: "next workout"
  // matched nothing, fell through to the coach, and the LLM removed Dips). Otherwise
  // resolve the (possibly compound) target phrase to matching pending slots.
  const targetNames = intent.positional
    ? [firstUnloggedPlannedLift()].filter(Boolean)
    : PM.resolvePlanTargets(intent.target, planEntries);
  if (!targetNames.length) return false; // no pending slot to act on → let the coach handle it

  if (intent.action === 'skip') {
    // Skip ALL matched slots only for a GENUINELY COMPOUND target ("skip
    // deadlifts/rdls"). A single token that fuzzily over-matched several slots
    // ("skip press" → Bench Press + Overhead Press) skips only the first — it must
    // not remove planned work the lifter never named (mirrors the replace path).
    const toSkip = PM.splitTargets(intent.target).length > 1 ? targetNames : targetNames.slice(0, 1);
    toSkip.forEach(skipPlannedExercise);
    announcePlanMutation(`Skipped ${toSkip.join(', ')}.`, curName());
    return true;
  }
  return false; // not a skip we can apply here → fall through
}

// ── Atomic exercise REPLACEMENT via a gated proposal ─────────────────────────
// A direct "replace X with Y" command ("remove back squats and change it out for bench
// press", "swap squats for bench", "instead of squats, bench") is ONE atomic operation:
// source → replacement. It must NOT immediately delete the source or silently activate the
// replacement (production trust failure FR-20260723031748: "remove back squats and change
// it out for bench press" one-sidedly skipped Back Squat and dropped the replacement).
// Instead it stages ONE pending proposal (store.pendingReplacement) with the replacement's
// authoritative prescription, and the plan is mutated only once the athlete APPROVES.
// Read-only planning: resolves the prescription from the read-only /api/recommend/next
// engine route; NO Sheet write occurs until (and only via) the existing log/accept boundary.
// Runs BEFORE tryApplyPlanMutation and the SME/coach routes (req 4/5). Returns true when it
// staged (or is holding) a proposal; false to fall through.
async function tryProposeReplacement(text) {
  const PM = (typeof window !== 'undefined' && window.planMutationIntent) || null;
  const AR = (typeof window !== 'undefined' && window.activeReplacement) || null;
  if (!PM || !AR) return false;
  const intent = PM.classifyMutationIntent(text);
  if (!intent || intent.action !== 'replace') return false;   // only an explicit replace
  if (!ensureActivePlannedSession()) return false;            // no plan → coach handles it
  const planExercises = getActivePlannedSession().exercises || [];
  const canon = getCanonicalSession();
  const planEntries = canon && Array.isArray(canon.exercises) && canon.exercises.length
    ? canon.exercises
    : planExercises.map(e => ({ name: e.canonicalName || e.name, liftCode: e.liftCode || '', status: 'pending' }));
  // Resolve the SOURCE slot (positional → the current pending lift; else the named target).
  const targetNames = intent.positional
    ? [firstUnloggedPlannedLift()].filter(Boolean)
    : PM.resolvePlanTargets(intent.target, planEntries);
  if (!targetNames.length) return false; // no pending slot named → coach handles it
  const sourceName = targetNames[0];
  // Resolve the REPLACEMENT identity. A NAMED swap keeps an unknown-but-typed exercise
  // (the named source is strong evidence of a real substitution); a positional/destination
  // swap requires a real catalog exercise, else it is likely a coaching phrase.
  const resolved = resolveCatalogExercise(intent.substitute);
  if (intent.positional && !resolved.matched) return false;
  if (!resolved.name) return false;
  // A "replacement" that collapses to the SOURCE is not a swap — the movement is staying. It is
  // a PRESCRIPTION-ONLY change, which this lane structurally cannot carry (its proposal id,
  // position and approve executor are all built around source → replacement, and approval would
  // record a `substituted` outcome for a movement that never moved). Hand it to the sibling
  // set-revision lane rather than dropping the turn (#1189).
  if (String(resolved.name).toLowerCase() === String(sourceName).toLowerCase()) {
    return tryProposeSetRevision(sourceName);
  }
  // Resolve the replacement's AUTHORITATIVE prescription from the read-only engine route.
  // Never invents a load: an unresolved load is carried as an explicit unresolved state.
  let prescription = null;
  if (resolved.liftCode) {
    try {
      const rec = await api(`/api/recommend/next/${encodeURIComponent(resolved.liftCode)}`);
      // api() returns the server's standard { status, data } envelope; the engine puts
      // next_target and target_rir INSIDE data (same read as the other two recommend/next
      // consumers). Reading the target off the top-level envelope would always be null → every
      // proposal would falsely show "no authoritative load" and approval would discard the
      // engine prescription (Codex P1, 2026-07-23).
      const data = (rec && rec.data) || null;
      const t = (data && data.next_target) || null;
      if (t) prescription = { weight: t.weight ?? null, reps: t.reps ?? null, sets: t.sets ?? null, rir: (data.target_rir ?? t.rir ?? null) };
    } catch (_) { prescription = null; } // engine unavailable → unresolved-load proposal
  }
  const proposal = AR.buildReplacementProposal({
    source: { name: sourceName },
    replacement: { name: resolved.name, lift_code: resolved.liftCode, ...(prescription || {}) },
    planExercises,
  });
  setPendingReplacement(proposal);
  persistSessionSnapshot(document.getElementById('log-session-id')?.value || null);
  renderReplacementProposal(proposal);
  return true;
}

// Render the pending replacement PROPOSAL to the coach thread — one coherent proposal with
// the complete proposed prescription and an Approve / Reject affordance. The plan is NOT
// mutated here; approval is what applies it. Reuses the coach layer via an event so the
// composer stays the single owner of thread rendering.
function renderReplacementProposal(proposal) {
  const AR = window.activeReplacement;
  document.dispatchEvent(new CustomEvent('atlas:replacement-proposed', {
    detail: { proposal, line: AR.formatProposalLine(proposal) }
  }));
}

// APPROVE the pending replacement: remove exactly the source and insert exactly the
// replacement in the SAME planned position, ONCE, via the tested applySessionSubstitution
// executor (it preserves order + plan_item_id and emits the substituted outcome). Idempotent:
// a re-tap after it is applied (source already gone / no pending proposal) is a no-op. No
// Sheet write occurs. Returns true when an approval was handled.
function approvePendingReplacement(fromCard) {
  const proposal = getPendingReplacement();
  if (!proposal || proposal.status !== 'pending') return false;
  // A tap on a stale card (its proposal was superseded by a newer pending one) must never
  // apply the newer swap. When the decision carries the card's own proposal id, it must match
  // the current pending proposal; a mismatch is a no-op (Codex P1). The conversational path
  // (a typed "yes"/"do bench") passes no card, so it always targets the current proposal.
  if (fromCard && fromCard.proposal_id && fromCard.proposal_id !== proposal.proposal_id) return false;
  const planExercises = (getActivePlannedSession() && getActivePlannedSession().exercises) || [];
  const AR = window.activeReplacement;
  // Fail closed on a stale proposal (the plan changed under it) — never apply to the wrong slots.
  if (!AR.isProposalFresh(proposal, planExercises)) {
    setPendingReplacement(null);
    persistSessionSnapshot(document.getElementById('log-session-id')?.value || null);
    announcePlanMutation('That plan changed, so I didn\'t apply the swap. Tell me again what to replace.', firstUnloggedPlannedLift());
    return true;
  }
  const r = proposal.replacement || {};
  const prescription = { weight: r.weight ?? null, reps: r.reps ?? null, sets: r.sets ?? null, rir: r.rir ?? null };
  const swapped = applySessionSubstitution(proposal.source.name, r.name, r.lift_code || '', prescription);
  setPendingReplacement(null);
  persistSessionSnapshot(document.getElementById('log-session-id')?.value || null);
  if (swapped) {
    announcePlanMutation(`Replaced ${proposal.source.name} with ${r.name}.`, curNameAfterMutation());
  } else {
    // Source already gone (e.g. approved twice) — idempotent no-op, not a phantom swap.
    announcePlanMutation('', curNameAfterMutation());
  }
  return true;
}

// REJECT / cancel the pending replacement — the plan is left exactly as it was.
function rejectPendingReplacement(fromCard) {
  const proposal = getPendingReplacement();
  if (!proposal) return false;
  // Same stale-card guard as approve: a reject tap on a superseded card must not discard the
  // newer pending proposal (Codex P1). A typed rejection passes no card and targets the current.
  if (fromCard && fromCard.proposal_id && fromCard.proposal_id !== proposal.proposal_id) return false;
  setPendingReplacement(null);
  persistSessionSnapshot(document.getElementById('log-session-id')?.value || null);
  announcePlanMutation(`Kept ${proposal.source && proposal.source.name ? proposal.source.name : 'the plan'} as-is.`, firstUnloggedPlannedLift());
  return true;
}

// The current lift after a plan mutation (the new first unlogged slot).
function curNameAfterMutation() {
  const unlogged = firstUnloggedPlannedLift();
  if (unlogged) return unlogged;
  const s = getActivePlannedSession();
  const cur = s && s.exercises[s.index];
  return cur ? (cur.canonicalName || cur.name) : null;
}

// Resolve a follow-up turn against a PENDING replacement proposal (production sequence:
// "No let's do bench press" / "yes bench" → approve; "what weight should I put on the bar"
// → answer from the proposal, never a broad benchmark challenge). Returns true when the turn
// was a response to the proposal (approve / reject / prescription query); false to fall
// through with the proposal still pending. Deterministic + read-only; never calls the coach.
function tryResolvePendingReplacement(text) {
  const AR = (typeof window !== 'undefined' && window.activeReplacement) || null;
  if (!AR) return false;
  const proposal = getPendingReplacement();
  if (!proposal || proposal.status !== 'pending') return false;
  // A brand-new, self-contained explicit replacement ("replace RDL with leg press") typed while
  // a proposal is pending is a NEW command, not a follow-up to the old one — even when it shares a
  // word with the pending replacement ("leg PRESS" vs "bench PRESS", which would otherwise read as
  // an approval). Defer it to tryProposeReplacement (which stages the new proposal, superseding
  // this one); the stale card is then inert via the proposal-id guard on approve/reject.
  const PM = (typeof window !== 'undefined' && window.planMutationIntent) || null;
  if (PM) {
    const intent = PM.classifyMutationIntent(text);
    if (intent && intent.action === 'replace' && !intent.positional && intent.substitute) return false;
  }
  const kind = AR.classifyFollowup(text, proposal);
  if (kind === 'approve') return approvePendingReplacement();
  if (kind === 'reject') return rejectPendingReplacement();
  if (kind === 'query') {
    // Weight/prescription truth boundary (req 7): the replacement is PROPOSED, not yet
    // active. State the proposed authoritative prescription (or that no load is resolved) and
    // ask for approval — never a broad Bench Press benchmark/challenge, never an invented load.
    const r = proposal.replacement || {};
    const rx = AR.formatReplacementPrescription(r);
    const msg = rx
      ? `${r.name} is the proposed replacement for ${proposal.source.name} — not active yet. Proposed target: ${rx}. Approve the swap and I'll set it.`
      : `${r.name} is the proposed replacement for ${proposal.source.name} — not active yet, and I don't have an authoritative load for it. Tell me the weight and approve, and I'll set it.`;
    announcePlanMutation(msg, firstUnloggedPlannedLift());
    return true;
  }
  return false; // unrelated turn — keep the proposal pending, route normally
}

// ── Prescription-only SET REVISION via a gated proposal (#1189) ───────────────
// The sibling of the replacement lane above, for the case it structurally cannot carry: the
// movement STAYS in the plan and only its remaining prescription changes. #1188 shipped the
// capture entry point (emitEndorsedSetRevision) but nothing in the real conversation reached
// it, so a set-level revision was still only ever a side effect of a movement swap.
//
// Read-only planning: the target is resolved from the read-only /api/recommend/next engine
// route and NEVER invented; nothing is revised until the athlete approves; no Sheet write
// occurs (the revision checkpoint POST underneath remains a dry-run sidecar while
// SESSION_PLAN_SETS_WRITE_ENABLED is 0). Returns true when it staged a proposal.
async function tryProposeSetRevision(slotName) {
  const plan = getActivePlannedSession();
  if (!plan || plan.accepted !== true) return false;   // only an accepted plan carries ledger identity
  const exercises = Array.isArray(plan.exercises) ? plan.exercises : [];
  const AR = (typeof window !== 'undefined' && window.activeReplacement) || null;
  if (!AR) return false;
  // Resolve the slot with the SAME resolver the replacement lane uses, so the two lanes can
  // never disagree about which slot a phrase named.
  const idx = AR.findSlotIndex(exercises, slotName);
  if (idx === -1) return false;
  const slot = exercises[idx] || {};
  const liftCode = slot.liftCode || slot.lift_code || '';
  if (!slot.plan_item_id || !liftCode) return false;   // no ledger identity → nothing to revise
  // Resolve the AUTHORITATIVE target from the read-only engine. An unresolved target stages NO
  // proposal — an invented number would be a coaching claim the engine never made.
  let prescription = null;
  try {
    const rec = await api(`/api/recommend/next/${encodeURIComponent(liftCode)}`);
    // next_target / target_rir live INSIDE the standard { status, data } envelope — the same
    // read the replacement lane and the other recommend/next consumers do.
    const data = (rec && rec.data) || null;
    const t = (data && data.next_target) || null;
    if (t) prescription = { weight: t.weight ?? null, reps: t.reps ?? null, rir: (data.target_rir ?? t.rir ?? null) };
  } catch (_) { prescription = null; }  // engine unavailable → no proposal, never a guess
  const proposal = buildSetRevisionProposal({
    plan_item_id: slot.plan_item_id,
    planned_lift_code: liftCode,                       // UNCHANGED — the movement does not move
    prescribed_name: slot.canonicalName || slot.name,
    prescription,
    accepted_set_count: slot.sets,                     // the v1 grain the revision is bounded by
    from: { weight: slot.weight, reps: slot.reps, rir: slot.rir },
    plan_version: plan.plan_version,
    proposed_at: new Date().toISOString(),
  });
  if (!proposal) return false;   // nothing usable to propose (no target, or it changes nothing)
  // Staging supersedes any older proposal; the older card is then inert via the proposal-id
  // guard on approve/reject below.
  setPendingSetRevision(proposal);
  persistSessionSnapshot(document.getElementById('log-session-id')?.value || null);
  renderSetRevisionProposal(proposal);
  return true;
}

// Render the pending set-revision PROPOSAL to the coach thread with an Approve / Keep it
// affordance. Nothing is revised here; approval is what applies it.
function renderSetRevisionProposal(proposal) {
  document.dispatchEvent(new CustomEvent('atlas:set-revision-proposed', {
    detail: { proposal, line: formatSetRevisionProposalLine(proposal) }
  }));
}

// APPROVE the pending set revision: emit the endorsed revision for this slot's FUTURE sets
// exactly ONCE, through #1188's capture entry point. The planned lift code is carried through
// UNCHANGED and NO `substituted` item_outcome is emitted — a load change is not a substitution,
// and recording one would corrupt the movement-level planned-versus-completed record. Completed
// sets are untouched (the revision builder bounds itself to unperformed sets). Idempotent: the
// proposal is cleared here, so a re-tap finds nothing, and appendRevisions dedupes underneath.
// No Sheet write occurs. Returns true when an approval was handled.
function approvePendingSetRevision(fromCard) {
  const proposal = getPendingSetRevision();
  if (!proposal || proposal.status !== 'pending') return false;
  // A tap on a stale card (its proposal was superseded by a newer pending one) must never apply
  // the newer revision — the same guard the replacement lane carries. The conversational path
  // passes no card, so it always targets the current proposal.
  if (fromCard && fromCard.proposal_id && fromCard.proposal_id !== proposal.proposal_id) return false;
  const plan = getActivePlannedSession();
  const exercises = (plan && plan.exercises) || [];
  // Fail closed on a stale proposal (the plan version moved, the slot is gone, or the movement
  // changed under it) — never revise whatever the plan became.
  if (!isSetRevisionProposalFresh(proposal, exercises, plan && plan.plan_version)) {
    setPendingSetRevision(null);
    persistSessionSnapshot(document.getElementById('log-session-id')?.value || null);
    announcePlanMutation('That plan changed, so I didn\'t revise those sets. Tell me again what to change.', firstUnloggedPlannedLift());
    return true;
  }
  const captured = emitEndorsedSetRevision({
    plan_item_id: proposal.plan_item_id,
    planned_lift_code: proposal.planned_lift_code,
    prescribed_name: proposal.prescribed_name,
    prescription: proposal.prescription,
    accepted_set_count: proposal.accepted_set_count,
    // No `endorsement` field: consent was established by the tap or by the explicit
    // endorsement the follow-up router already validated, not by re-parsing prose here.
  });
  setPendingSetRevision(null);
  persistSessionSnapshot(document.getElementById('log-session-id')?.value || null);
  // Report only what actually happened. When every set is already performed there is no future
  // set to revise, and claiming a revision would tell the athlete their plan changed when
  // session truth never moved.
  const rx = formatSetRevisionPrescription(proposal.prescription);
  announcePlanMutation(
    captured
      ? `Kept ${proposal.prescribed_name} — the rest of the sets are ${rx}.`
      : `${proposal.prescribed_name} has no sets left to revise, so I left it as logged.`,
    firstUnloggedPlannedLift(),
  );
  return true;
}

// REJECT the pending set revision — the plan is left exactly as it was, and a later bare "yes"
// finds nothing (identity is never reconstructed from prose).
function rejectPendingSetRevision(fromCard) {
  const proposal = getPendingSetRevision();
  if (!proposal) return false;
  if (fromCard && fromCard.proposal_id && fromCard.proposal_id !== proposal.proposal_id) return false;
  setPendingSetRevision(null);
  persistSessionSnapshot(document.getElementById('log-session-id')?.value || null);
  announcePlanMutation(`Left ${proposal.prescribed_name || 'the plan'} as-is.`, firstUnloggedPlannedLift());
  return true;
}

// Resolve a follow-up turn against a PENDING set-revision proposal. Returns true when the turn
// was a decision (approve / reject) or a question the proposal answers; false to fall through
// with the proposal still pending. Deterministic + read-only; never calls the coach.
function tryResolvePendingSetRevision(text) {
  const proposal = getPendingSetRevision();
  if (!proposal || proposal.status !== 'pending') return false;
  const kind = classifySetRevisionFollowup(text, proposal);
  if (kind === 'approve') return approvePendingSetRevision();
  if (kind === 'reject') return rejectPendingSetRevision();
  if (kind === 'query') {
    // Ask Why. A question is neither approval nor rejection, so the proposal stays ACTIVE and
    // UNAPPLIED — Atlas answers from the stored proposal (never an invented number) and the
    // athlete can still decide.
    const rx = formatSetRevisionPrescription(proposal.prescription);
    const from = formatSetRevisionPrescription(proposal.from);
    announcePlanMutation(
      from
        ? `That's the engine's next target for ${proposal.prescribed_name}: ${rx}, in place of ${from}. ${proposal.prescribed_name} stays in the plan either way — approve and I'll set the rest of the sets.`
        : `That's the engine's next target for ${proposal.prescribed_name}: ${rx}. ${proposal.prescribed_name} stays in the plan either way — approve and I'll set the rest of the sets.`,
      firstUnloggedPlannedLift(),
    );
    return true;
  }
  return false; // unrelated turn — keep the proposal pending, route normally
}

// An IMPLICIT substitution — the athlete declined the current/named lift and asked
// for "something else" WITHOUT naming it (classifier action 'substitute', production
// bug 2026-07-11). Resolve the target slot, ask the DETERMINISTIC recommender
// (services/substitutionRecommender via the read-only /api/suggest-substitute) for a
// valid substitute, and replace the slot IN PLACE with the SAME executor the explicit
// swap uses — so the substitute becomes the active exercise and the remaining plan
// order is preserved. Falls through (false) when there is no plan, no matching slot,
// or no known substitute; the coach then handles it. Async because the recommender is
// server-side (its quality/pattern chain is not in the browser bundle).
async function tryApplyImplicitSubstitution(text) {
  const submitSeq = typeof previewRequestSeq === 'number' ? previewRequestSeq : null;
  const PM = (typeof window !== 'undefined' && window.planMutationIntent) || null;
  if (!PM) return false;
  const intent = PM.classifyMutationIntent(text);
  if (!intent || intent.action !== 'substitute') return false;
  if (!ensureActivePlannedSession()) return false;
  const canon = getCanonicalSession();
  const planEntries = canon && Array.isArray(canon.exercises) && canon.exercises.length
    ? canon.exercises
    : getActivePlannedSession().exercises.map(e => ({ name: e.canonicalName || e.name, liftCode: e.liftCode || '', status: 'pending' }));
  // Positional ("give me something else") → the current pending slot; else resolve the
  // named target ("squats" → Back Squat) to a pending slot. Never re-opens finished work.
  const targetNames = intent.positional
    ? [firstUnloggedPlannedLift()].filter(Boolean)
    : PM.resolvePlanTargets(intent.target, planEntries);
  if (!targetNames.length) return false; // no pending slot to act on → let the coach handle it
  const targetName = targetNames[0];
  // CONTEXT: the exercises still ahead in the plan (the next slot first) so the engine
  // avoids a substitute that duplicates them back-to-back (the live redundancy: Leg
  // Press picked while Single-Leg Seated Leg Press was next). Order-agnostic downstream.
  const planExs = (getActivePlannedSession() && getActivePlannedSession().exercises) || [];
  const targetIdx = planExs.findIndex(e => (e.canonicalName || e.name || '').toLowerCase() === targetName.toLowerCase());
  const remainingPlan = (targetIdx >= 0 ? planExs.slice(targetIdx + 1) : planExs)
    .map(e => e.canonicalName || e.name)
    .filter(n => n && n.toLowerCase() !== targetName.toLowerCase());
  // The deterministic substitute (no LLM, no invented number). `intent:'substitute'`
  // tells the read-only endpoint the client already classified a swap request, so it
  // recommends without needing a constraint keyword ("busy"/"taken").
  let rec = null;
  try {
    const res = await api('/api/suggest-substitute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, current_exercise: targetName, intent: 'substitute', remaining_plan: remainingPlan })
    });
    if (submitSeq !== null && submitSeq !== previewRequestSeq) return false;
    rec = res && res.data && res.data.recommendation;
  } catch { return false; }
  if (!rec || !rec.recommendation) return false; // no known substitute → fall through to the coach
  // Resolve the substitute's catalog identity for its lift code (same tiers the named
  // swap uses); keep the recommender's name if the catalog doesn't know it.
  const resolvedSub = resolveCatalogExercise(rec.recommendation);
  const subName = (resolvedSub && resolvedSub.matched && resolvedSub.name) || rec.recommendation;
  const subCode = (resolvedSub && resolvedSub.liftCode) || '';
  const swapped = applySessionSubstitution(targetName, subName, subCode, rec.next_target || null);
  if (!swapped) return false; // e.g. the recommender returned the same lift → nothing changed
  // Re-point to the ACTUAL current lift after the in-place swap (now the substitute).
  const cur = firstUnloggedPlannedLift();
  announcePlanMutation(`Swapped ${targetName} → ${subName}.`, cur || subName);
  return true;
}

// ── P0 PR 4: deterministic exercise-identity correction (AC7) ──────────────────
// "sorry that was squats" relabels the JUST-LOGGED lift in the session buffers, so
// the card/recap/write rows agree — deterministically, even when the coach LLM is
// down (the exact live-gym failure). The app state owns the relabel; the coach only
// confirms it.

// Small edit distance for the correction lane's typo tier — inputs are single
// words, so the O(len²) DP is trivial.
function correctionEditDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Typo-tolerant word equality (owner live find 2026-07-03: 'prep' must meet
// 'press'): exact, singular-equal, or a near-miss — both words ≥4 chars, a shared
// ≥3-char prefix, edit distance ≤2. The prefix anchor keeps short real-word
// neighbors apart ('pull' never meets 'push'; 3-letter words must match exactly,
// so 'leg' never meets 'lat').
function correctionWordEq(a, b) {
  if (a === b) return true;
  const sg = w => (/[^s]s$/.test(w) ? w.slice(0, -1) : w);
  const x = sg(a), y = sg(b);
  if (x === y) return true;
  if (x.length < 4 || y.length < 4) return false;
  if (x.slice(0, 3) !== y.slice(0, 3)) return false;
  return correctionEditDistance(x, y) <= 2;
}

// Word list for the subset tier: lowercase, hyphens/slashes → spaces, deduped
// (mirrors planMutationIntent's wordSet; singularization lives in correctionWordEq).
function correctionWords(s) {
  return [...new Set(String(s == null ? '' : s).toLowerCase()
    .replace(/[-/]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean))];
}

// Resolve a correction's TO side when the catalog tiers (exact/singular/unique-
// substring) miss — the ≥2-word word-subset/typo tier against PLAN names first,
// then catalog names: "single leg seated leg prep" (typo'd) must still reach
// "Single-Leg Seated Leg Press". Refuses on ambiguity at each source (mirrors
// resolveCatalogExercise, PR-570) — a phrase matching two names relabels nothing.
function resolveCorrectionTargetName(phrase) {
  const words = correctionWords(phrase);
  if (words.length < 2) return null; // ≥2-word minimum — a lone word never typo-guesses
  const matches = names => {
    const hits = [];
    for (const n of names) {
      const nw = correctionWords(n);
      if (words.every(w => nw.some(cw => correctionWordEq(w, cw))) && !hits.includes(n)) hits.push(n);
    }
    return hits;
  };
  const plan = matches(plannedExerciseEntries().map(e => e.name));
  if (plan.length) return plan.length === 1 ? plan[0] : null;
  const dl = typeof document !== 'undefined' ? document.getElementById('exercise-catalog') : null;
  const cat = matches(Array.from((dl && dl.options) || []).map(o => o.value).filter(Boolean));
  return cat.length === 1 ? cat[0] : null;
}

// Resolve a correction's FROM side ("sorry SLSLP is …") against the DISTINCT
// buffered lift names, newest first — the mis-typed name is usually the latest
// group, and is often catalog-UNKNOWN, which is exactly why it needs correcting.
// Tiers: exact → singular-equal → substring → word-subset/typo (single-word
// phrases get the typo tier only against single-word names).
function resolveBufferedLiftName(phrase) {
  const raw = String(phrase == null ? '' : phrase).trim().toLowerCase();
  if (!raw) return null;
  const names = [];
  for (let i = getSessionLog().length - 1; i >= 0; i--) {
    const n = getSessionLog()[i].exercise;
    if (n && !names.includes(n)) names.push(n);
  }
  const sg = s => { const t = String(s || '').toLowerCase().trim(); return /[^s]s$/.test(t) ? t.slice(0, -1) : t; };
  const sraw = sg(raw);
  let hit = names.find(n => n.toLowerCase() === raw);
  if (!hit) hit = names.find(n => sg(n) === sraw);
  if (!hit) hit = names.find(n => { const v = sg(n); return v && (v.includes(sraw) || sraw.includes(v)); });
  if (!hit) {
    const pw = correctionWords(raw);
    hit = names.find(n => {
      const nw = correctionWords(n);
      if (pw.length >= 2) return pw.every(w => nw.some(cw => correctionWordEq(w, cw)));
      return pw.length === 1 && nw.length === 1 && correctionWordEq(pw[0], nw[0]);
    });
  }
  return hit || null;
}

function tryApplyIdentityCorrection(text) {
  const IC = (typeof window !== 'undefined' && window.identityCorrection) || null;
  if (!IC || !Array.isArray(getSessionLog()) || !getSessionLog().length) return false; // nothing logged to correct
  const intent = IC.classifyIdentityCorrection(text);
  if (!intent) return false;
  // The lift being corrected: the "X is Y" form names it — resolve X against the
  // BUFFERED lift names, typo-tolerantly (owner live find 2026-07-03: "Sorry slslp
  // is single leg seated leg prep" must relabel the buffered Slslp group). The
  // legacy that-was form corrects the most-recently-logged lift, as before. An
  // "X is Y" whose X is not a buffered lift is NOT an identity correction — fall
  // through to the coach untouched.
  const oldName = intent.from
    ? resolveBufferedLiftName(intent.from)
    : getSessionLog()[getSessionLog().length - 1].exercise;
  if (!oldName) return false;
  const resolved = resolveCatalogExercise(intent.to);
  // Only relabel to a phrase that resolves to a KNOWN name. Catalog tiers first
  // (exact/singular/unique-substring — an ordinary remark like "actually that was
  // tough" never names a real lift, PR-574 review); then the ≥2-word word-subset/
  // typo tier against plan + catalog names, so a typo'd correction still lands.
  const newName = (resolved.matched && resolved.name) || resolveCorrectionTargetName(intent.to);
  if (!newName) return false;
  if (oldName.toLowerCase() === newName.toLowerCase()) return false;
  // ── ADD-5: identity-correction targeting guard ────────────────────────────
  // A demonstrative correction ("i meant X" / "sorry that was X") re-identifies the
  // exercise IN FOCUS — normally the just-logged lift, which the correction is
  // re-labeling. But when the session has moved on — a different exercise is the
  // active thing being discussed/clarified, or the corrected identity is already
  // its OWN logged group — the correction does NOT refer to the completed lift
  // sitting at the tail of the log. Silently relabeling that completed lift to an
  // unrelated identity corrupts the permanent record (live bug: Bench Press logged,
  // incline flyes then discussed, "I meant incline dumbbell flyes" turned the Bench
  // Press rows into flyes). In that case we refuse the silent mutation and ASK,
  // instead of guessing at a target. The "X is Y" (intent.from) form is user-named
  // and keeps its existing, deliberate buffered-lift resolution.
  if (!intent.from) {
    const tailId = resolveCompletedIdentity(oldName);
    const targetId = resolveCompletedIdentity(newName);
    if (targetId !== tailId) {
      // (a) the corrected identity already exists as its OWN logged group (so the
      //     correction plainly refers to that group, not the unrelated tail lift), or
      // (b) a DISTINCT exercise is the active thing being clarified — focus has
      //     moved off the tail lift.
      const targetIsOwnGroup = getSessionLog().some(
        s => s.exercise !== oldName && resolveCompletedIdentity(s.exercise) === targetId
      );
      // Focus has moved off the tail lift when the user has discussed something with
      // the coach since logging it (the durable signal that survives the discuss→coach
      // route — the headline repro), or a distinct exercise is the active parse context.
      const focus = (typeof activeExercise === 'string' && activeExercise.trim()) || '';
      const focusMovedOn = getCoachDiscussionSinceLog() ||
        (!!focus && resolveCompletedIdentity(focus) !== tailId);
      if (targetIsOwnGroup || focusMovedOn) {
        askIdentityCorrectionClarification(oldName, newName);
        return true; // handled by asking — the completed lift is left exactly as logged
      }
    }
  }
  if (intent.from) {
    // A name correction applies to the WHOLE mis-labeled group, wherever its sets
    // sit in the log — later sets of another lift don't shield it.
    for (let i = 0; i < getSessionLog().length; i++) {
      if (getSessionLog()[i].exercise === oldName) getSessionLog()[i] = { ...getSessionLog()[i], exercise: newName };
    }
  } else {
    // The lift being corrected is the most-recently-logged one — relabel its
    // TRAILING contiguous run of sets (an earlier, separately-logged occurrence is
    // untouched).
    for (let i = getSessionLog().length - 1; i >= 0 && getSessionLog()[i].exercise === oldName; i--) {
      getSessionLog()[i] = { ...getSessionLog()[i], exercise: newName };
    }
  }
  // Reconcile completion identity: drop the old resolved name iff no remaining set
  // still backs it, and ensure the new resolved name is present (in log order).
  const oldResolved = resolveCompletedIdentity(oldName);
  const newResolved = resolveCompletedIdentity(newName);
  const oldStillBacked = getSessionLog().some(s => resolveCompletedIdentity(s.exercise) === oldResolved);
  if (!oldStillBacked) {
    const idx = getSessionCompleted().indexOf(oldResolved);
    if (idx !== -1) getSessionCompleted().splice(idx, 1);
  }
  if (!getSessionCompleted().includes(newResolved)) getSessionCompleted().push(newResolved);
  announceIdentityCorrection(oldName, newName);
  return true;
}

// Tell the coach layer a correction happened so it can confirm it (read-only
// narration; the engine owns the relabel). Mirrors announcePlanMutation.
function announceIdentityCorrection(fromName, toName) {
  renderActiveSessionBanner();
  document.dispatchEvent(new CustomEvent('atlas:identity-corrected', {
    detail: { from: fromName || '', to: toName || '' }
  }));
}

// ADD-5: ask the lifter to disambiguate instead of relabeling a completed lift we
// are NOT sure the correction refers to. Read-only narration — it mutates NOTHING
// (no logged rows, no completion list, no plan, no write path): the tail lift stays
// exactly as logged. The coach layer renders the question; the lifter can re-state
// the correction naming the lift ("<logged> is <target>") to apply it deliberately.
function askIdentityCorrectionClarification(loggedName, targetName) {
  document.dispatchEvent(new CustomEvent('atlas:identity-correction-ambiguous', {
    detail: { logged: loggedName || '', target: targetName || '' }
  }));
}

function renderActiveSessionBanner() {
  const banner = document.getElementById('active-session-banner');
  if (!banner) return;
  banner.innerHTML = '';
  if (!getActivePlannedSession()) {
    banner.hidden = true;
    setSessionChromeExpanded(false);
    document.body.classList.remove('session-active');
    return;
  }
  syncPlannedIndexToCanonical();
  const { label, exercises, index } = getActivePlannedSession();
  const current = exercises[index];
  if (!current) {
    banner.hidden = true;
    setSessionChromeExpanded(false);
    document.body.classList.remove('session-active');
    return;
  }
  banner.appendChild(el('div', { class: 'active-session-title', text: `▶ ${label}` }));
  banner.appendChild(el('div', { class: 'active-session-step', text: `Step ${index + 1} of ${exercises.length}: ${current.name}` }));
  const row = el('div', { class: 'active-session-actions' });
  if (index < exercises.length - 1) {
    const nextBtn = el('button', { type: 'button', class: 'secondary', text: 'Next exercise →' });
    nextBtn.addEventListener('click', advancePlannedSession);
    row.appendChild(nextBtn);
  }
  // PR-I5: the explicit completed boundary — "Done with <exercise>" for the MOST
  // RECENTLY LOGGED accepted item that is still unresolved (outcome≠completed, has a
  // performed set). The plan cursor auto-advances past a just-logged item, so gating on
  // the CURRENT slot left the boundary unreachable mid-plan; target the last-logged item
  // instead (owner-approved "target last-logged item"). The button carries that item's
  // immutable plan_item_id — completion never re-resolves by name/lift-code/position, and
  // a substituted slot displays the performed exercise while completing the original id.
  // The evidence gates visibility; the CLICK is the authoritative event (logging a set
  // and cursor movement never emit completed).
  const activePlan = getActivePlannedSession();
  const doneTarget = activePlan && activePlan.accepted === true
    ? mostRecentCompletablePlanItem(activePlan, getSessionCompleted())
    : null;
  if (doneTarget) {
    const doneBtn = el('button', { type: 'button', class: 'secondary start-done-btn', text: `Done with ${doneTarget.name}` });
    doneBtn.addEventListener('click', () => { if (doneBtn.disabled) return; doneBtn.disabled = true; completePlanItemById(doneTarget.plan_item_id); });
    row.appendChild(doneBtn);
  }
  const endBtn = el('button', { type: 'button', class: 'secondary', text: 'End session' });
  // PR-H: an explicit "End session" is a `finalized` closeout (emit BEFORE the plan
  // is cleared, so its session_id/plan_version are still in scope). Gated on an
  // accepted plan; the implicit endPlannedSession callers do NOT emit.
  endBtn.addEventListener('click', () => { emitPlanCloseout('finalized'); endPlannedSession(); });
  row.appendChild(endBtn);
  banner.appendChild(row);
  // Collapsed by default (owner directive 2026-07-03): the card takes space
  // from the thread — the session pin is the always-visible row, and tapping
  // it expands this card. The glance strip steps aside for the session.
  document.body.classList.add('session-active');
  banner.hidden = !getSessionChromeExpanded();
  // Plan engagement/mutation/restore all route through this render — the
  // session pin re-derives from the same canonical state at each of those
  // moments (composer-first Phase A).
  renderSessionPin();
}

// PR-I5 — the ONLY authoritative `completed` emitter: the athlete explicitly taps
// "Done with <exercise>". Logging a set, cursor movement ("Next" / auto-advance), and
// chat text NEVER emit completed. Completes a SPECIFIC accepted item resolved strictly
// by its immutable plan_item_id (never by name / lift-code / array position), marks it
// done LOCALLY (so it can't be completed again), persists the snapshot (no re-complete
// after a reload), fires the non-blocking sidecar, and re-renders so the NEXT most-recent
// eligible item surfaces. It deliberately does NOT move the plan cursor — automatic
// advancement (logging / "Next") is unchanged. Guarded against double-taps + re-completion.
// `completed` means the athlete SAYS they are finished with this planned item; it does
// NOT claim every prescribed set was performed or saved.
function completePlanItemById(planItemId) {
  const plan = getActivePlannedSession();
  if (!plan || plan.accepted !== true || !planItemId) return;
  const item = (plan.items || []).find(it => it && it.plan_item_id === planItemId);
  if (!item || item.outcome === 'completed') return; // no re-complete / double-tap guard
  item.outcome = 'completed';                        // local completion state (prevents re-complete)
  saveSessionSnapshot();                             // survive reload — no re-complete after a resume
  emitPlanItemOutcome({ plan_item_id: item.plan_item_id, outcome: 'completed' }); // non-blocking sidecar
  renderActiveSessionBanner();                       // surface the next eligible item; cursor unchanged
}

// B2 canonical state — the plan-card banner renders its "current step" from
// activePlannedSession.index, but a logged set advances only the canonical session
// (sessionCompleted); the index cursor lags until "Next exercise →" is tapped. So
// the plan card would show a just-logged lift as still-current while the composer,
// next-up router, and save payload have already moved on. Reconcile the index
// forward to the canonical current (first unlogged planned lift) so the plan card
// derives from the SAME canonical session as every other surface. Forward-only —
// it never rewinds, so a deliberate swap-advance (Step 379) is never undone — and
// it never mutates the exercise list. No-op when the activeSession model is
// unavailable (the banner then falls back to the raw index cursor).
function syncPlannedIndexToCanonical() {
  if (!getActivePlannedSession() || !Array.isArray(getActivePlannedSession().exercises)) return;
  const AS = (typeof window !== 'undefined' && window.activeSession) ||
             (typeof activeSession !== 'undefined' ? activeSession : null);
  if (!AS) return;
  const canon = getCanonicalSession();
  const cur = canon && AS.currentExercise(canon);
  if (!cur) return; // nothing pending (all logged/skipped) — leave the cursor as-is
  const key = String(cur.name || '').toLowerCase();
  const target = getActivePlannedSession().exercises.findIndex(
    e => (e.canonicalName || e.name || '').toLowerCase() === key
  );
  if (target > getActivePlannedSession().index) getActivePlannedSession().index = target;
}

function advancePlannedSession() {
  if (!getActivePlannedSession()) return;
  setPendingSubstitution(null);
  // Advance past the banner's current exercise. Two cases:
  // • Already logged (in sessionCompleted): just increment the cursor so the banner
  //   moves to the next slot. The canonical session already shows the next exercise
  //   because it derives "current" from the first-unlogged entry.
  // • Not logged (user clicked "Next" without logging): treat as skipped (absent) —
  //   splice it so the canonical session stays in sync with the banner position.
  const bannerCur = getActivePlannedSession().exercises[getActivePlannedSession().index];
  if (bannerCur) {
    const completedSet = new Set((getSessionCompleted() || []).map(c => String(c).toLowerCase()));
    const bannerKey = (bannerCur.canonicalName || bannerCur.name || '').toLowerCase();
    if (bannerKey && !completedSet.has(bannerKey)) {
      if (!skipPlannedExercise(bannerCur.canonicalName || bannerCur.name)) {
        if (getActivePlannedSession().index >= getActivePlannedSession().exercises.length - 1) { endPlannedSession(); return; }
        getActivePlannedSession().index += 1;
        renderActiveSessionBanner();
      }
      // skipPlannedExercise already called renderActiveSessionBanner if it spliced.
    } else {
      if (getActivePlannedSession().index >= getActivePlannedSession().exercises.length - 1) { endPlannedSession(); return; }
      getActivePlannedSession().index += 1;
      renderActiveSessionBanner();
    }
  }
  // Start the next exercise from the canonical session (first still-pending lift)
  // so the composer and plan queue are always derived from the same source.
  const next = currentPlannedExercise();
  if (!next) { endPlannedSession(); return; }
  startLift(next.canonicalName || next.name, next.liftCode, next.weight, next.reps, next.sets || 3);
}

function endPlannedSession() {
  // Step 385: advance the deload machine exactly once per session (not per write).
  // The deloadWritten flag is set in the approve handler on the first confirmed
  // live write; firing here instead of per-write keeps the session-count correct.
  if (getActivePlannedSession()?.intentId === 'deload_reset' && getActivePlannedSession()?.deloadWritten) {
    api('/api/deload/advance', { method: 'POST' })
      .then(r => {
        const state = r?.data?.state;
        if (state?.training_state === 'POST_DELOAD_EVALUATION') {
          api('/api/deload/resolve', { method: 'POST' }).catch(() => {});
        }
      })
      .catch(() => {});
  }
  setActivePlannedSession(null);
  setPendingSubstitution(null);
  renderActiveSessionBanner();
}

function normalizePlanEditExercise(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return normalizePlanExercise({ exercise: raw });
  const ex = normalizePlanExercise({
    exercise: raw.name || raw.exercise,
    canonical_exercise: raw.canonicalName || raw.canonical_exercise || raw.name || raw.exercise,
    lift_code: raw.liftCode || raw.lift_code,
    target_weight: raw.weight,
    target_reps: raw.reps,
    target_sets: raw.sets,
    target_rir: raw.rir,
    reason: raw.rationale || raw.reason || ''
  });
  return ex && ex.name ? ex : null;
}

function matchesPlanEditName(ex, wanted) {
  const key = String(wanted || '').toLowerCase().trim();
  if (!key) return false;
  const names = [ex && ex.name, ex && ex.canonicalName].map(n => String(n || '').toLowerCase().trim()).filter(Boolean);
  return names.some(n => n === key || n.includes(key) || key.includes(n));
}

// The strong form of matchesPlanEditName: the wanted name IS the slot's identity
// (case-insensitive name or canonicalName), no substring fallback.
function planEditNameEquals(ex, wanted) {
  const key = String(wanted || '').toLowerCase().trim();
  if (!key) return false;
  return [ex && ex.name, ex && ex.canonicalName].some(n => String(n || '').toLowerCase().trim() === key);
}

function clampActivePlanIndex() {
  if (!getActivePlannedSession() || !Array.isArray(getActivePlannedSession().exercises)) return;
  if (!getActivePlannedSession().exercises.length) {
    endPlannedSession();
    return;
  }
  const max = getActivePlannedSession().exercises.length - 1;
  getActivePlannedSession().index = Math.max(0, Math.min(Number(getActivePlannedSession().index) || 0, max));
}

function ensureChatPlannedSession() {
  if (getActivePlannedSession() && Array.isArray(getActivePlannedSession().exercises)) return getActivePlannedSession();
  setActivePlannedSession({
    label: 'Coach plan',
    intentId: null,
    exercises: [],
    index: 0
  });
  setPendingSubstitution(null);
  return getActivePlannedSession();
}

// PR-12 (Bug 3): returns { applied, exercises } — `exercises` is the SINGLE
// normalized model the chat block renders, the very array stored on
// activePlannedSession (replace) or the subset just appended (add). The chat
// caller renders these instead of re-mapping edit.exercises a second time, so the
// rendered block, the active-session banner, and the store can never drift apart.
// `exercises` is [] for a remove (nothing new to show) or an unapplied edit.
function applyProposedPlanEdit(edit) {
  const none = { applied: false, exercises: [] };
  if (!edit || typeof edit !== 'object' || !Array.isArray(edit.exercises)) return none;
  const action = edit.action;
  const exercises = edit.exercises.map(normalizePlanEditExercise).filter(ex => ex && ex.name);
  if (!exercises.length) return none;

  if (action === 'replace_plan') {
    setActivePlannedSession({
      label: edit.label || 'Coach plan',
      intentId: null,
      exercises,
      index: 0
    });
    setPendingSubstitution(null);
    setSessionCompleted([]);
    setSessionRevisions([]); setSessionImplicitRecs([]); // a replaced plan starts a fresh recommendation ledger
    renderActiveSessionBanner();
    return { applied: true, exercises };
  }

  if (action === 'add_exercises') {
    const session = ensureChatPlannedSession();
    const existing = new Set(session.exercises.map(ex => String(ex.canonicalName || ex.name || '').toLowerCase()));
    const added = [];
    for (const ex of exercises) {
      const key = String(ex.canonicalName || ex.name || '').toLowerCase();
      if (!key || existing.has(key)) continue;
      session.exercises.push(ex);
      existing.add(key);
      added.push(ex);
    }
    if (added.length) {
      clampActivePlanIndex();
      renderActiveSessionBanner();
    }
    return { applied: added.length > 0, exercises: added };
  }

  if (action === 'remove_exercises') {
    if (!getActivePlannedSession() || !Array.isArray(getActivePlannedSession().exercises)) return none;
    const wanted = exercises.map(ex => ex.name).filter(Boolean);
    const slots = getActivePlannedSession().exercises;
    // Wrong-target guard (sibling of resolvePlanTargets, PR #993): a wanted name
    // that matches some slot EXACTLY removes only exact matches — the bidirectional
    // substring fallback must not also sweep a longer-named slot the athlete never
    // named ("Leg Press" removing "Single-Leg Seated Leg Press"). A name with no
    // exact slot keeps the substring behavior (an LLM-echoed alias still resolves).
    const exactByName = new Map(wanted.map(name => [name, slots.some(ex => planEditNameEquals(ex, name))]));
    // The identity keys (name + canonicalName, lowercased) of every slot an exact
    // wanted name removes — the evidence cleanup below clears by THESE, so a slot
    // exact-matched via its canonicalName still gets its `name`-keyed completed
    // evidence cleared (review note on #994: the two sweeps stay symmetric).
    const exactIdentities = new Map(wanted.filter(name => exactByName.get(name)).map(name => {
      const ids = new Set();
      for (const ex of slots) {
        if (!planEditNameEquals(ex, name)) continue;
        for (const n of [ex.name, ex.canonicalName]) {
          const k = String(n || '').toLowerCase().trim();
          if (k) ids.add(k);
        }
      }
      return [name, ids];
    }));
    const before = slots.length;
    getActivePlannedSession().exercises = slots.filter(ex =>
      !wanted.some(name => exactByName.get(name) ? planEditNameEquals(ex, name) : matchesPlanEditName(ex, name))
    );
    const removed = getActivePlannedSession().exercises.length !== before;
    if (removed) {
      // The completed-evidence cleanup follows the SAME per-name precedence, so an
      // exact removal never clears the logged evidence of a similarly-named lift —
      // but DOES clear every identity of the slot(s) it actually removed.
      setSessionCompleted(getSessionCompleted().filter(done =>
        !wanted.some(name => {
          const key = String(name || '').toLowerCase().trim();
          const d = String(done || '').toLowerCase();
          if (!key) return false;
          if (exactByName.get(name)) return d === key || exactIdentities.get(name).has(d);
          return d === key || d.includes(key) || key.includes(d);
        })
      ));
      clampActivePlanIndex();
      renderActiveSessionBanner();
    }
    return { applied: removed, exercises: [] };
  }

  return { applied: false, exercises: [] };
}

document.addEventListener('atlas:plan-edit-proposed', e => {
  const outcome = applyProposedPlanEdit(e.detail && e.detail.edit) || { applied: false, exercises: [] };
  if (outcome.applied) {
    // Owner live find (2026-07-03): a chat-applied swap must follow through to
    // the composer exactly like the deterministic mutation lane — same signal,
    // EMPTY summary (the chat reply already narrates; no extra bubble), so the
    // placeholder re-points to the new current exercise.
    announcePlanMutation('', firstUnloggedPlannedLift());
  }
  // PR-12 (Bug 3): hand the applied model back so the chat block renders the SAME
  // normalized exercises stored here — a single source of presentation truth.
  if (e.detail && e.detail.result && typeof e.detail.result === 'object') {
    e.detail.result.applied = outcome.applied;
    e.detail.result.exercises = outcome.exercises;
  }
  const applied = outcome.applied;
  try {
    document.dispatchEvent(new CustomEvent('atlas:plan-edit-applied', {
      detail: { applied, edit: e.detail && e.detail.edit }
    }));
  } catch { /* diagnostic event is optional */ }
});

// A tap on the pending-replacement proposal card (Approve / Keep it) — apply or reject the
// staged replacement through the SAME idempotent handlers the conversational "yes"/"no"
// path uses. Repeated taps are no-ops (the card disables itself and the handlers no-op once
// the proposal is resolved). No Sheet write occurs.
document.addEventListener('atlas:replacement-decision', e => {
  const decision = e && e.detail && e.detail.decision;
  // Bind the decision to the proposal that RENDERED the card (Codex P1, 2026-07-23): if a
  // second proposal superseded this card's proposal in the store, a tap on the older, still
  // visible card must NOT apply the newer swap. approve/reject verify the id before mutating.
  const fromCard = e && e.detail && e.detail.proposal;
  if (decision === 'approve') approvePendingReplacement(fromCard);
  else if (decision === 'reject') rejectPendingReplacement(fromCard);
});

// A tap on the pending SET-REVISION proposal card (Approve / Keep it) — apply or clear the
// staged prescription change through the SAME idempotent handlers the conversational
// "yes"/"no" path uses. The decision is bound to the proposal that RENDERED the card, so a tap
// on an older, still-visible card can never apply a newer revision. No Sheet write occurs.
document.addEventListener('atlas:set-revision-decision', e => {
  const decision = e && e.detail && e.detail.decision;
  const fromCard = e && e.detail && e.detail.proposal;
  if (decision === 'approve') approvePendingSetRevision(fromCard);
  else if (decision === 'reject') rejectPendingSetRevision(fromCard);
});

// Open the recommended workout — Composer-first Phase B: routes to the ONE
// canonical in-thread Coach's Pick (which does its own read-only fetch and
// degrades gracefully), no longer a second drawer rendering of the same pick.
// eslint-disable-next-line no-unused-vars -- global export consumed by other browser scripts; Phase 1 PR-08/09
function openTodaySessionPlan() {
  openCoachPickInThread();
}

// Phrases that ask for the recommended workout rather than logging a set.
// Workout shorthand always carries numbers, so any digit rules a phrase out —
// this keeps "Bench 225 5/2 x3" on the normal parse/preview path.
// Only the "today"-scoped "what should I do TODAY" is a day-planning ask; the
// bare "what should I do" must stay off this route — during an active session
// sessionQuestion.js answers it from the live prescription (next-up), and
// claiming it here would steal that lane.
function looksLikeSessionRequest(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || /\d/.test(t)) return false;
  // Workout-GENERATION requests ("plan me a workout", "plan me a workout but have it start
  // with back squats", "build me a pull workout") must reach the AUTHORITATIVE recommendation
  // pipeline here, not the free-form /api/coach/chat pseudo-plan lane (2026-07-22 failure).
  if (sessionQuestion.isWorkoutGenerationRequest(t)) return true;
  return /\b(recommended (workout|session)|what should i train|what (should|do) (i|we) do today|what are we doing|today'?s plan|what'?s the plan|what (workout|session) (would|do|should|can) you (suggest|recommend)|(suggest|recommend) (a |an |me |today'?s )?(\w+ )?(workout|session)|do (my|the|your) (workout|session)|let'?s (do|start|run) (it|this|the workout|my workout|the session|your recommended workout))\b/.test(t);
}

// Composer-first Phase B2: phrases that ask to SEE a stored artifact — the
// last session or the weekly report. These render the existing read-only
// in-thread artifact (nav.js renderers) deterministically instead of falling
// through to the LLM chat. Any digit rules a phrase out, so workout shorthand
// ("Bench 225 5/2") can never be swallowed by an artifact render. Returns the
// artifact kind ('last_session' | 'weekly_report') or false.
function looksLikeArtifactRequest(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || /\d/.test(t)) return false;
  if (/\b(show|see|pull up|open|view)\b[^?.!]*\blast (session|workout)\b/.test(t) ||
      /\bwhat did i do\b[^?.!]*\blast (time|session|workout)\b/.test(t) ||
      /^\s*(my )?last (session|workout)\??\s*$/.test(t)) {
    return 'last_session';
  }
  if (/\b(weekly (report|summary)|(show|see|view)\b[^?.!]*\b(my|this) week|this week'?s (report|summary|training)|how (was|did) (my|the) week)\b/.test(t)) {
    return 'weekly_report';
  }
  return false;
}

function looksLikeCorrection(text) {
  const t = String(text || '').trim().toLowerCase();
  return /\b(actually[,. ]|i was wrong|that'?s wrong|correction[,: ]|meant to (say|log|write|do)\b|should have been|that was wrong|i meant\b|wrong (weight|reps|sets|exercise)|oops[,. ]|my mistake|i made a mistake)\b/.test(t);
}

// End-of-session compilation trigger: the lifter has been logging sets
// conversationally and now wants Atlas to compile them into one preview.
function looksLikeLogIt(text) {
  // Accept straight or curly apostrophes — mobile keyboards autocorrect to curly.
  // An OPTIONAL leading closeout-acknowledgment ("done," / "ok" / "that's it" /
  // "finished") may precede the core phrase, so natural combined commands like
  // "Done, log it." / "that's it, log it" / "ok done log it" still close out (live-gym
  // v49: "Done, log it." was wrongly routed to the coach). The whole string must still
  // match end-to-end and must not end in "?" — a question ("should I log it?") never
  // closes out.
  const t = String(text || '');
  if (/\?\s*$/.test(t)) return false;
  return /^\s*(?:(?:ok(?:ay)?|alright|cool|great|sweet|nice|yep|yeah|done|finished|that['’]?s\s+(?:it|all)|we['’]?re?\s+done)[,.\s]+){0,2}(log\s+it|log\s+that|log\s+the\s+session|log\s+this\s+session|log\s+this\s+workout|save\s+the\s+session|save\s+it|ok\s+log\s+it|alright\s+log\s+it|compile\s+(the\s+)?session|that['’]?s?\s+all|that['’]?s\s+it(\s+for\s+(today|now))?|we['’]?re?\s+done(\s+logging)?|done(\s+for\s+today)?|finish(\s+session)?|end\s+(the\s+)?session)\s*[.!]?\s*$/i.test(t);
}

function showCorrectionPrompt(capturedText) {
  const thread = document.getElementById('thread-messages');
  if (!thread) return;

  const bubble = el('div', { class: 'chat-bubble chat-bubble-atlas correction-prompt' });
  bubble.appendChild(el('div', { text: "Looks like you’re correcting the last saved session. What would you like to do?" }));

  const actions = el('div', { class: 'correction-actions' });

  const replaceBtn = el('button', { class: 'approve correction-replace-btn', type: 'button', text: 'Replace last saved session' });
  replaceBtn.addEventListener('click', async () => {
    bubble.remove();
    await handleUndoLastWrite();
    workoutTextInput.value = capturedText;
    workoutTextInput.focus();
  });

  const newBtn = el('button', { class: 'secondary correction-new-btn', type: 'button', text: 'Log as new session' });
  newBtn.addEventListener('click', () => {
    bubble.remove();
    lastWrite = null;
    workoutTextInput.value = capturedText;
    document.getElementById('logger-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  const cancelBtn = el('button', { class: 'secondary correction-cancel-btn', type: 'button', text: 'Cancel' });
  cancelBtn.addEventListener('click', () => bubble.remove());

  actions.appendChild(replaceBtn);
  actions.appendChild(newBtn);
  actions.appendChild(cancelBtn);
  bubble.appendChild(actions);
  thread.appendChild(bubble);
  bubble.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openIntentDrawer(intent) {
  const drawer = document.getElementById('intent-drawer');
  const content = document.getElementById('intent-drawer-content');
  if (!drawer || !content) return;

  content.innerHTML = '';

  content.appendChild(el('h2', { class: 'drawer-title', text: intent.label }));
  if (intent.recommended) {
    content.appendChild(el('span', { class: 'drawer-recommended-badge', text: 'Recommended for today' }));
  }

  // Glance layer: at most two plain "why" lines, then the workout itself.
  if (intent.why_today && intent.why_today.length) {
    content.appendChild(el('h3', { class: 'drawer-section-title', text: 'Why today' }));
    content.appendChild(el('ul', { class: 'drawer-list' }, intent.why_today.slice(0, 2).map(w => el('li', { text: w }))));
  }

  // Everything analytical folds behind one tap — the data is all still there.
  const moreSections = [];
  if (intent.why_today && intent.why_today.length > 2) {
    moreSections.push(['More reasons', intent.why_today.slice(2)]);
  }
  if (intent.data_points && intent.data_points.length) moreSections.push(['The numbers behind this', intent.data_points]);
  if (intent.what_it_protects && intent.what_it_protects.length) moreSections.push(['What it protects', intent.what_it_protects]);
  if (intent.watch_for && intent.watch_for.length) moreSections.push(['Watch for', intent.watch_for]);
  if (intent.pivot_logic && intent.pivot_logic.length) moreSections.push(['If something feels off', intent.pivot_logic]);
  if (moreSections.length) {
    const fold = el('details', { class: 'drawer-more' });
    fold.appendChild(el('summary', { text: 'More detail' }));
    for (const [title, items] of moreSections) {
      fold.appendChild(el('h3', { class: 'drawer-section-title', text: title }));
      fold.appendChild(el('ul', { class: 'drawer-list' }, items.map(item => el('li', { text: item }))));
    }
    content.appendChild(fold);
  }

  if (intent.exercises && intent.exercises.length) {
    content.appendChild(el('h3', { class: 'drawer-section-title', text: 'Exercises' }));
    const exList = el('div', { class: 'drawer-exercises' });
    for (const raw of intent.exercises) {
      const ex = normalizePlanExercise(raw);
      const nameEl = el('span', { class: 'drawer-exercise-name', text: ex.name });
      const targetEl = ex.weight != null
        ? el('span', { class: 'drawer-exercise-target', text: `${ex.weight} × ${ex.reps}${ex.sets ? ` × ${ex.sets}` : ''}` })
        : el('span', { class: 'drawer-exercise-target muted', text: 'best effort' });
      exList.appendChild(el('div', { class: 'drawer-exercise-row' }, [nameEl, targetEl]));
      if (ex.reason) exList.appendChild(el('div', { class: 'drawer-exercise-reason', text: ex.reason }));
      // P0 AC12: surface the barbell loadability note (server-snapped target) so the
      // lifter sees why the weight was nudged to a loadable plate total.
      if (raw && raw.loadability_note) exList.appendChild(el('div', { class: 'drawer-exercise-reason muted', text: raw.loadability_note }));
    }
    content.appendChild(exList);

    const firstEx = normalizePlanExercise(intent.exercises[0]);
    if (firstEx.name) {
      const actionRow = el('div', { class: 'drawer-action-row' });
      // Start Session begins the guided in-memory session; Modify Plan just
      // drops into the logger on the first lift (via startLift), editable.
      const startBtn = el('button', { type: 'button', class: 'approve intent-start-btn', text: 'Start Session' });
      startBtn.addEventListener('click', async () => {
        // F10D acceptance boundary: the drawer's start is the SAME acceptance as
        // "Start this plan" — never a second unaccepted start path (the canary's
        // gap: a plan-like session with no identity, no Session_Plans acceptance,
        // and no ledger checkpoint). acceptDisplayedPlan mints identity, captures
        // acceptance, checkpoints the ledger, and starts the workout; the sidecar
        // is non-blocking so the workout still starts on an honest degrade.
        if (startBtn.disabled) return;
        startBtn.disabled = true;
        closeIntentDrawer();
        try { await acceptDisplayedPlan(intent); } finally { startBtn.disabled = false; }
      });
      const modifyBtn = el('button', { type: 'button', class: 'secondary intent-modify-btn', text: 'Modify Plan' });
      modifyBtn.addEventListener('click', () => {
        closeIntentDrawer();
        startLift(firstEx.name, firstEx.liftCode, firstEx.weight, firstEx.reps, firstEx.sets || 3);
      });
      actionRow.appendChild(startBtn);
      actionRow.appendChild(modifyBtn);
      content.appendChild(actionRow);
    }
  }

  drawer.hidden = false;
  const panel = drawer.querySelector('.intent-drawer-panel');
  if (panel) panel.scrollTop = 0;
}

function closeIntentDrawer() {
  const drawer = document.getElementById('intent-drawer');
  if (drawer) drawer.hidden = true;
}

// eslint-disable-next-line no-unused-vars -- global export consumed by other browser scripts; Phase 1 PR-08/09
async function loadTodaysPlan() {
  const box = document.getElementById('todays-plan');
  try {
    const res = await api('/api/plan/today');
    const recs = res.data?.recommendations || [];
    box.innerHTML = '';

    box.appendChild(el('p', { class: 'muted small mb-8', text: 'Tap any card to start that lift. These are progression targets, not a required order.' }));

    if (!recs.length) {
      box.appendChild(el('p', { class: 'muted', text: 'Log a few sessions and Atlas can start giving better suggestions.' }));
      return;
    }

    const grid = el('div', { class: 'plan-grid' });
    for (const r of recs) {
      const t = r.next_target;
      const confidenceClass = r.confidence === 'high' ? 'plan-card-high' : r.confidence === 'medium' ? 'plan-card-medium' : 'plan-card-low';
      const exerciseName = r.exercise_name || r.liftCode;
      const card = el('div', { class: `plan-card ${confidenceClass} plan-card-startable` }, [
        el('div', { class: 'plan-card-lift' }, [
          el('span', { class: 'plan-card-lift-name', text: exerciseName })
        ]),
        el('div', { class: 'plan-card-target', text: `${t.weight} × ${t.reps}` }),
        el('div', { class: 'plan-card-sets', text: `${t.sets} sets` }),
        el('div', { class: 'plan-card-rec', text: r.recommendation }),
        el('div', { class: 'plan-card-footer' }, [
          el('span', { class: 'plan-card-tap-hint', text: 'Tap to start' }),
          el('a', { class: 'lift-link plan-card-progress-link', href: '#', 'data-lift': r.liftCode, text: 'View progress' })
        ])
      ]);
      card.addEventListener('click', e => {
        if (e.target.closest('.lift-link')) return;
        startLift(exerciseName, r.liftCode, t.weight, t.reps, t.sets);
      });
      grid.appendChild(card);
    }
    box.appendChild(grid);
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

// One friendly line in the glance row so the data is digestible without opening.
function setGlanceHint(id, text) {
  const hint = document.getElementById(id);
  if (hint) hint.textContent = text || '';
}

async function loadCoaching() {
  const box = document.getElementById('coaching');
  try {
    const res = await api('/api/coaching/insights');
    const data = res.data || {};
    box.innerHTML = '';

    const fatigue = data.fatigue || {};
    setGlanceHint('coaching-hint', fatigue.status === 'high' ? 'Ease off a touch this week' : 'On track ✓');
    const fatigueClass = fatigue.status === 'high' ? 'preview-warnings' : 'preview-ok';
    box.appendChild(el('div', { class: fatigueClass }, [
      el('strong', { text: `Fatigue: ${fatigue.status || 'unknown'}` }),
      el('span', { text: fatigue.ratio !== null && fatigue.ratio !== undefined ? ` (this week is ${fatigue.ratio}× your recent weekly average)` : '' }),
      el('p', { text: fatigue.guidance || '' })
    ]));

    const deloads = data.deload_suggestions || [];
    if (deloads.length) {
      box.appendChild(el('h3', { text: 'Deload suggestions' }));
      box.appendChild(el('ul', {}, deloads.map(d => {
        // Show the exercise name to the lifter; the lift code stays in data-lift
        // purely as the click-through target (it's for data sorting, not display).
        // Exception: code-less log rows group under the synthetic 'UNKNOWN' code,
        // whose progress view is empty — keep the code visible there rather than
        // label it with a name the link can't actually navigate to.
        const label = (d.liftCode === 'UNKNOWN') ? d.liftCode : (d.exercise || d.liftCode);
        const li = el('li', {}, [
          el('a', { class: 'lift-link', href: '#', 'data-lift': d.liftCode, text: label }),
          document.createTextNode(`: ${d.suggestion}`)
        ]);
        return li;
      })));
    } else {
      box.appendChild(el('p', { class: 'muted', text: 'No deloads needed — no lift has been stalled 4+ sessions.' }));
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

async function loadWeeklySummary() {
  const box = document.getElementById('weekly-summary');
  try {
    const res = await api('/api/summary/weekly');
    const data = res.data || {};
    box.innerHTML = '';
    const highlights = data.highlights || [];
    setGlanceHint('weekly-summary-hint', highlights.length ? highlights[0] : 'No sessions yet this week');
    if (!highlights.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No training logged in the last 7 days.' }));
      return;
    }
    box.appendChild(el('ul', {}, highlights.map(h => el('li', { text: h }))));

    const breakdown = Object.entries(data.muscleGroupBreakdown || {})
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    if (breakdown.length) {
      box.appendChild(el('h3', { text: 'Volume by muscle group' }));
      box.appendChild(svgBarChart(breakdown, { label: 'Weekly volume by muscle group' }));
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

async function loadRecentHistory() {
  const box = document.getElementById('recent-history');
  try {
    const res = await api('/api/history/recent?limit=10');
    const sets = res.data?.recent_sets || [];
    box.innerHTML = '';
    setGlanceHint('recent-history-hint', sets.length ? `Last: ${sets[0].exercise} · ${sets[0].date_clean}` : 'Nothing logged yet');
    if (!sets.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No recent sets.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Exercise', 'Set', 'Weight', 'Reps', 'RIR'],
      sets.map(s => [s.exercise, s.set_number, s.weight, s.reps, s.rir])
    ));
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

async function loadRecentPrs() {
  const box = document.getElementById('recent-prs');
  try {
    const res = await api('/api/prs/recent');
    const prs = res.data?.prs || [];
    box.innerHTML = '';
    setGlanceHint('recent-prs-hint', prs.length ? `${prs.length} personal best${prs.length === 1 ? '' : 's'} 🎉` : 'Your bests will land here');
    if (!prs.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No PRs recorded yet.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Lift', 'Best weight', 'Best reps', 'Best est. 1RM'],
      prs.map(pr => [
        pr.exercise || pr.liftCode,
        pr.bestWeightSet ? `${formatSetLoad(pr.bestWeightSet.weight, pr.bestWeightSet.reps)} (${pr.bestWeightSet.date_clean})` : '—',
        pr.bestRepSet ? `${formatSetLoad(pr.bestRepSet.weight, pr.bestRepSet.reps)} (${pr.bestRepSet.date_clean})` : '—',
        pr.bestEstimated1RMSet ? `${pr.bestEstimated1RMSet.estimated_1rm} (${pr.bestEstimated1RMSet.date_clean})` : '—'
      ])
    ));
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

async function loadStalls() {
  const box = document.getElementById('stalls');
  try {
    const res = await api('/api/stalls?minSessions=3');
    const stalls = res.data?.stalls || [];
    box.innerHTML = '';
    setGlanceHint('stalls-hint', stalls.length ? `${stalls.length} lift${stalls.length === 1 ? '' : 's'} could use a change` : 'All clear ✓');
    if (!stalls.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No stalled lifts — keep it up.' }));
      return;
    }
    const table = el('table', {});
    const thead = el('thead', {}, el('tr', {}, ['Lift', 'Sessions stalled', 'Last best weight', 'Since'].map(h => el('th', { text: h }))));
    const tbody = el('tbody', {}, stalls.map(s => el('tr', {}, [
      el('td', {}, el('a', { class: 'lift-link', href: '#', 'data-lift': s.liftCode, text: s.exercise || s.liftCode })),
      el('td', { text: String(s.sessions_stalled) }),
      el('td', { text: String(s.last_best_weight) }),
      el('td', { text: String(s.first_session_date) })
    ])));
    table.appendChild(thead);
    table.appendChild(tbody);
    box.appendChild(table);
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
}

/* ===== Progress ===== */

document.getElementById('progress-form').addEventListener('submit', async e => {
  e.preventDefault();
  const liftCode = document.getElementById('progress-lift-code').value.trim();
  const resultBox = document.getElementById('progress-result');
  const recBox = document.getElementById('recommendation-result');
  resultBox.innerHTML = '<span class="muted">Loading…</span>';
  recBox.innerHTML = '<span class="muted">Loading…</span>';

  try {
    const res = await api(`/api/exercises/${encodeURIComponent(liftCode)}/progress`);
    const data = res.data || {};
    resultBox.innerHTML = '';

    const trendPill = el('span', { class: `pill ${data.recent_trend}`, text: `trend: ${data.recent_trend}` });
    resultBox.appendChild(el('p', {}, [`${data.sessions?.length || 0} sessions for ${data.liftCode}`, trendPill]));

    const weights = data.best_weight_over_time || [];
    if (weights.length) {
      const oneRms = data.estimated_1rm_over_time || [];
      const volumes = data.volume_over_time || [];

      resultBox.appendChild(el('h3', { text: 'Best weight over time' }));
      resultBox.appendChild(svgLineChart(
        weights.map(w => ({ x: w.date, y: w.best_weight })),
        { label: 'Best weight over time' }
      ));
      resultBox.appendChild(el('h3', { text: 'Estimated 1RM over time' }));
      resultBox.appendChild(svgLineChart(
        oneRms.map(r => ({ x: r.date, y: r.estimated_1rm })),
        { color: '#16a34a', label: 'Estimated 1RM over time' }
      ));

      resultBox.appendChild(el('h3', { text: 'Session detail' }));
      resultBox.appendChild(renderTable(
        ['Date', 'Session', 'Best weight', 'Est. 1RM', 'Volume'],
        weights.map((w, i) => [w.date, w.session_id, w.best_weight, oneRms[i]?.estimated_1rm ?? '', volumes[i]?.volume ?? ''])
      ));
    } else {
      resultBox.appendChild(el('span', { class: 'muted', text: 'No working sets found for this lift code.' }));
    }
  } catch (err) {
    resultBox.textContent = '';
    resultBox.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }

  try {
    const res = await api(`/api/recommend/next/${encodeURIComponent(liftCode)}`);
    const data = res.data || {};
    recBox.innerHTML = '';

    if (data.next_target) {
      const t = data.next_target;
      const confidenceClass = data.confidence === 'high' ? 'ok' : data.confidence === 'medium' ? 'warn' : 'muted';
      recBox.appendChild(el('div', { class: 'next-target-card' }, [
        el('div', { class: 'next-target-weight', text: `${t.weight}` }),
        el('div', { class: 'next-target-meta', text: `× ${t.reps} reps · ${t.sets} sets` })
      ]));
      recBox.appendChild(el('p', { text: data.recommendation }));
      recBox.appendChild(el('p', { class: 'muted', text: data.reasoning }));
      const meta = [
        data.sessions_analyzed ? `${data.sessions_analyzed} sessions analyzed` : '',
        data.e1rm_trend ? `e1RM trend: ${data.e1rm_trend}` : '',
        data.confidence ? `confidence: ${data.confidence}` : ''
      ].filter(Boolean).join('  ·  ');
      if (meta) recBox.appendChild(el('p', { class: `muted small ${confidenceClass}`, text: meta }));
    } else {
      recBox.appendChild(el('p', { text: data.recommendation || '' }));
      recBox.appendChild(el('p', { class: 'muted', text: data.reasoning || '' }));
    }

    const rd = data.rule_decision;
    if (rd && rd.decision !== 'no_data' && rd.reasoning) {
      recBox.appendChild(el('p', { class: 'small muted', text: rd.reasoning }));
    }
  } catch (err) {
    recBox.textContent = '';
    recBox.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
});

/* ===== Progress lift list (name-based) ===== */



























// Timeframe selector — recomputes from cache, no re-fetch.
document.getElementById('trends-frame')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-frame]');
  if (btn) renderTrends(btn.dataset.frame);
});



document.getElementById('lift-drilldown-back')?.addEventListener('click', () => {
  const drillCard = document.getElementById('lift-drilldown-card');
  if (drillCard) drillCard.hidden = true;
  // loadProgressLiftList shows the list card and populates it (uses cache if available).
  loadProgressLiftList();
});

/* ===== Weekly Report ===== */

document.getElementById('weekly-report-btn').addEventListener('click', async () => {
  const box = document.getElementById('weekly-report-result');
  const btn = document.getElementById('weekly-report-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  box.innerHTML = '<span class="muted">Loading…</span>';
  try {
    const res = await api('/api/report/weekly');
    const data = res.data || {};
    box.innerHTML = '';
    if (data.summary_markdown) {
      box.appendChild(el('pre', { class: 'summary-pre' }, [data.summary_markdown]));
    }
    if (data.prs && data.prs.length) {
      box.appendChild(el('h3', { text: 'Improvements this week' }));
      box.appendChild(renderTable(
        ['Lift', 'Prior best', 'This week'],
        data.prs.map(p => [p.exercise || p.lift_code, `${p.prev_best} lb`, `${p.this_week_best} lb`])
      ));
    }
    if (data.stalls_or_watchouts && data.stalls_or_watchouts.length) {
      box.appendChild(el('h3', { text: 'Watchouts' }));
      box.appendChild(renderTable(
        ['Lift', 'Sessions stalled', 'Last best'],
        data.stalls_or_watchouts.map(s => [s.exercise || s.liftCode, s.sessions_stalled, `${s.last_best_weight} lb`])
      ));
    }
    if (!data.sessions_count) {
      box.appendChild(el('p', { class: 'muted', text: 'No training data logged in this period.' }));
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load weekly report';
  }
});

/* ===== Lift-link navigation (dashboard → progress) ===== */

document.addEventListener('click', e => {
  const link = e.target.closest('.lift-link');
  if (!link) return;
  e.preventDefault();
  const liftCode = link.dataset.lift;
  if (!liftCode) return;
  // Switch to Progress tab (surface switch if needed)
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const progressBtn = document.querySelector('[data-tab="progress"]');
  if (progressBtn) progressBtn.classList.add('active');
  const progressTab = document.getElementById('tab-progress');
  if (progressTab) progressTab.classList.add('active');
  // Pre-fill the hidden legacy form (keeps existing event handler bindings
  // working if anything dispatches submit directly on it).
  const liftInput = document.getElementById('progress-lift-code');
  if (liftInput) liftInput.value = liftCode;
  // Determine exercise name for the drill-down title.
  // Try the lift-list cache first, then fall back to liftCode itself.
  const cached = (liftListCache || []).find(r => r.liftCode === liftCode);
  const exerciseName = cached?.exercise_name || link.dataset.exerciseName || liftCode;
  openLiftDrillDown(exerciseName, liftCode);
});

/* ===== Catalog search ===== */

document.getElementById('catalog-search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = document.getElementById('catalog-search-q').value.trim();
  const box = document.getElementById('catalog-search-result');
  if (!q) return;
  box.innerHTML = '<span class="muted">Searching…</span>';
  try {
    const res = await api(`/api/catalog/search?q=${encodeURIComponent(q)}`);
    const results = res.data?.results || [];
    box.innerHTML = '';
    if (!results.length) {
      box.appendChild(el('span', { class: 'muted', text: 'No matching exercises.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Canonical name', 'Muscle group', 'Lift code', 'Variants'],
      results.map(r => [r.canonical_name, r.muscle_group, r.lift_code, (r.variants || []).join(', ')])
    ));
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Search failed: ${err.message}` }));
  }
});

/* ===== Exercise Detail ===== */

document.getElementById('detail-form').addEventListener('submit', async e => {
  e.preventDefault();
  const liftCode = document.getElementById('detail-lift-code').value.trim();
  const box = document.getElementById('detail-result');
  if (!liftCode) return;
  box.innerHTML = '<span class="muted">Loading…</span>';
  try {
    const res = await api(`/api/exercises/${encodeURIComponent(liftCode)}/detail`);
    const data = res.data || {};
    box.innerHTML = '';

    if (!data.sessions_count) {
      box.appendChild(el('p', { class: 'muted', text: `No data found for lift code "${liftCode}".` }));
      return;
    }

    // Summary line: name · code · N sessions · trend pill
    const trendPill = el('span', { class: `pill ${data.volume_trend}`, text: `trend: ${data.volume_trend}` });
    const nameStr = data.exercise_names.length ? data.exercise_names.join(' / ') : data.lift_code;
    const summaryLine = el('p', {}, [`${nameStr} · ${data.lift_code} · ${data.sessions_count} sessions `, trendPill]);
    box.appendChild(summaryLine);

    // Best recent set
    if (data.best_recent_set) {
      const s = data.best_recent_set;
      const setText = s.rir != null ? `${formatSetLoad(s.weight, s.reps)} @${s.rir}` : formatSetLoad(s.weight, s.reps);
      box.appendChild(el('p', { class: 'small muted', text: `Best recent set (30 days): ${setText} on ${s.date}` }));
    }

    // Last sessions table
    if (data.last_sessions.length) {
      box.appendChild(el('h3', { text: 'Last sessions' }));
      box.appendChild(renderTable(
        ['Date', 'Best weight', 'Est. 1RM', 'Volume', 'Sets'],
        data.last_sessions.map(s => [s.date, s.best_weight ?? '—', s.estimated_1rm ?? '—', s.volume ?? '—', s.sets])
      ));
    }

    // Recommendation
    if (data.recommendation) {
      const r = data.recommendation;
      box.appendChild(el('p', { class: 'muted', text: r.recommendation }));
      if (r.next_target) {
        const t = r.next_target;
        box.appendChild(el('p', { class: 'small muted', text: `Next target: ${t.weight} × ${t.reps} × ${t.sets} sets · confidence: ${r.confidence}` }));
      }
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Could not load: ${err.message}` }));
  }
});

/* ===== Session search ===== */

document.getElementById('session-search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const params = new URLSearchParams();
  const liftCode = document.getElementById('ss-lift-code').value.trim();
  const exercise = document.getElementById('ss-exercise').value.trim();
  const muscleGroup = document.getElementById('ss-muscle-group').value.trim();
  const dateFrom = document.getElementById('ss-date-from').value;
  const dateTo = document.getElementById('ss-date-to').value;
  if (liftCode) params.set('liftCode', liftCode);
  if (exercise) params.set('exercise', exercise);
  if (muscleGroup) params.set('muscleGroup', muscleGroup);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);

  const box = document.getElementById('session-search-result');
  box.innerHTML = '<span class="muted">Searching…</span>';
  try {
    const res = await api(`/api/search/sessions?${params.toString()}`);
    const data = res.data || {};
    const sets = data.rows || [];
    const sessionCount = data.session_ids?.length ?? 0;
    box.innerHTML = '';
    box.appendChild(el('p', { class: 'muted', text: `${sets.length} set(s) found across ${sessionCount} session(s).` }));
    if (!sets.length) return;
    box.appendChild(renderTable(
      ['Date', 'Session', 'Exercise', 'Set', 'Weight', 'Reps', 'RIR', 'Notes'],
      sets.slice(0, 100).map(s => [s.date_clean, s.session_id, s.canonical_exercise || s.exercise, s.set_number, s.weight, s.reps, s.rir, s.notes])
    ));
    if (sets.length > 100) {
      box.appendChild(el('p', { class: 'muted', text: `Showing first 100 of ${sets.length} rows.` }));
    }
  } catch (err) {
    box.textContent = '';
    box.appendChild(el('span', { class: 'muted', text: `Search failed: ${err.message}` }));
  }
});

/* ===== Workout logger (approve-before-save) ===== */

const setsTableBody = document.querySelector('#sets-table tbody');
const previewPanel = document.getElementById('preview-panel');
const previewContent = document.getElementById('preview-content');
const loggerStatus = document.getElementById('logger-status');
const workoutTextInput = document.getElementById('workout-text');
const parsedRowsEditor = document.getElementById('parsed-rows-editor');

// Pending approval state. Set only after a successful dry-run preview;
// cleared whenever the form changes so stale previews can never be approved.
let pendingWrite = null;
// Correlation is deliberately separate from pendingWrite: it exists before the async
// preview starts, so a newer initiation can retire an in-flight predecessor even when
// the predecessor has not produced a pending write yet.
let activePreviewCorrelation = null;

// F07 / CLIENT-3: monotonic preview-request identity. Bumped at the start of every preview
// submit; each async parse/dry-run response only updates preview state (the parsed rows and
// pendingWrite) while its captured seq still matches the latest. A slow OLDER response whose
// seq is stale is dropped, so it can never overwrite a NEWER request's preview or pending write.
let previewRequestSeq = 0;

// In-thread effort cards mirror the global approve button. When a preview is
// replaced or invalidated, an older card no longer matches the live pendingWrite,
// so its Save must be permanently neutralised — otherwise clicking a stale card
// would fire the newest preview's write. Each card registers a cleanup here;
// invalidatePreview() runs them all.
const effortCardCleanups = [];
// eslint-disable-next-line no-unused-vars -- global export consumed by other browser scripts; Phase 1 PR-08/09
function registerEffortCardCleanup(fn) { effortCardCleanups.push(fn); }
function runEffortCardCleanups() {
  while (effortCardCleanups.length) {
    const fn = effortCardCleanups.pop();
    try { fn(); } catch { /* card already removed from the DOM */ }
  }
}
let lastParsedWorkoutText = '';
let lastParserStatus = null;
let activeExercise = null;
// ADD-5 (PR-24 slice 2): `coachDiscussionSinceLog` — true once a message has been
// handled as coach discussion/question SINCE the last set was logged — is now
// store-owned (session slice) via get/setCoachDiscussionSinceLog. Unlike
// activeExercise (which the coach route nulls), it survives the discuss→coach route,
// so a later demonstrative correction can tell "re-identify the lift I just logged"
// (fast path) from "I'm talking about something else now" (must not silently relabel
// the completed lift). Reset when a set enters the log buffer (emitSetLogged).
let lastPrescribed = null;
// F10S2 — the one-turn "instead of <original>" directive from the LAST parse
// (parsed.substitution.for). One-shot: reset at every new parse, consumed (armed
// into the deferred-swap lane) at the chat-lane log commit, so it can never
// linger across turns and mis-bind a later, unrelated log.
let lastParseSubstitution = null;
// Card/advisory consistency (owner 07-02): the exercise name the unknown-lift
// advisory flagged on the LAST parse (null when the lift resolved). Threaded into
// the atlas:set-logged detail so the ✓ confirmation card marks the name instead of
// contradicting the advisory with full confidence.
let lastUnverifiedExercise = null;
// Cached when the Today dashboard loads so routeMessageToCoach can include
// the current plan order in coach context (for "why in this order?" questions).
let lastIntentData = null;

// Set by handleLogIt() before re-submitting the form with compiled workout
// text. When true, the submit handler skips the "route to coach" branch and
// runs the parse → preview path so the lifter sees the final session preview.
// Cleared immediately after being read — single-use gate.
let sessionCompiledAwaitingPreview = false;

// P0 (#1123) — LATCHED closeout-stage guard. Once a closeout dry-run preview has
// been staged from sessionLog, this stays true until the session resets (a verified
// approved write or a deliberate Start Over / discard — all of which fire
// atlas:session-reset and clear it below). It exists because
// `sessionCompiledAwaitingPreview` is single-use: after the first closeout preview it
// resets, so a later plain preview-btn submit — with the buffered closeout rows still
// in the editor — used to satisfy the ordinary mid-workout log branch and call
// emitSetLogged, appending those same rows back into sessionLog (5 squat sets → 10,
// duplicating permanent history). While this latch is set, a submit that introduces NO
// new parsed input (a plain re-preview/edit of the staged table) REBUILDS the closeout
// preview from the (edited) editor table instead of re-logging it. A genuinely new set
// typed after Finish DOES parse new input and still logs normally, so "log one more set"
// after Finish is never lost (Codex #1125). Fail-closed: once staged, an ambiguous
// re-preview never re-enters the append lane.
let closeoutPreviewStaged = false;
let latestSetResponseCompletion = null;

// Populated after a successful manual write. Cleared only after undo or when
// the user explicitly picks "Log as new" in the correction dialog. NOT cleared
// by invalidatePreview so the correction guard can fire even after the user
// starts typing a correction in the same textarea.
let lastWrite = null;

// True while a live write request is in-flight. Guards against double-submit
// from rapid clicks before the button's disabled state is processed by the browser.
let writeInFlight = false;

// Cache last-time lookups to avoid redundant API calls within a session.
const lastTimeCache = new Map();

// Cache the per-lift recommendations (keyed by canonical exercise name) so the
// live "Next" hint costs at most one /api/plan/today fetch per session.
let planTodayByNameCache = null;

// Drop the live-hint caches after a write so the next "Last"/"Next" hint
// reflects the freshly logged sets rather than pre-write data.
function clearLiveHintCaches() {
  lastTimeCache.clear();
  planTodayByNameCache = null;
}

async function getPlanTodayByName() {
  if (planTodayByNameCache) return planTodayByNameCache;
  const map = new Map();
  try {
    const res = await api('/api/plan/today');
    for (const r of (res.data?.recommendations || [])) {
      if (r.exercise_name) map.set(String(r.exercise_name).toLowerCase(), r);
    }
  } catch {
    // best-effort — leave the map empty so the Next hint just doesn't show
  }
  planTodayByNameCache = map;
  return map;
}

// Resolve a recommendation for a typed exercise name: exact canonical match
// first, then a loose contains match ("bench" ↔ "Bench Press").
async function lookupNextTarget(name) {
  const map = await getPlanTodayByName();
  const key = name.toLowerCase();
  if (map.has(key)) return map.get(key);
  for (const [exName, rec] of map) {
    if (exName.includes(key) || key.includes(exName)) return rec;
  }
  return null;
}

async function showLastTimeHint(exerciseInput, hintEl) {
  const exercise = exerciseInput.value.trim();
  if (!exercise || !isConnected()) { hintEl.textContent = ''; return; }
  const stillCurrent = () => exerciseInput.value.trim().toLowerCase() === exercise.toLowerCase();

  let data = lastTimeCache.get(exercise.toLowerCase());
  if (!data) {
    try {
      const res = await api(`/api/exercises/last-session?exercise=${encodeURIComponent(exercise)}`);
      data = res.data || {};
      lastTimeCache.set(exercise.toLowerCase(), data);
    } catch {
      hintEl.textContent = '';
      return;
    }
  }

  if (!stillCurrent()) return;
  hintEl.textContent = '';
  if (data.sets && data.sets.length) {
    const summary = data.sets.map(s => formatSetLoad(s.weight, s.reps, '×')).join('  ');
    hintEl.appendChild(el('div', { text: `Last (${data.date}): ${summary}` }));
  }

  // Live next-set coaching: the recommended target/cue for this lift, if any.
  const rec = await lookupNextTarget(exercise);
  if (!stillCurrent()) return;
  if (rec && rec.next_target) {
    const t = rec.next_target;
    const tip = rec.recommendation || `${t.weight} × ${t.reps}`;
    hintEl.appendChild(el('div', { class: 'next-target-hint', text: `Next: ${tip}` }));
  }
}

function addSetRow(values = {}) {
  const exerciseInput = el('input', { type: 'text', class: 'set-exercise', value: values.exercise || '', placeholder: 'Bench Press', list: 'exercise-catalog' });
  const hintEl = el('div', { class: 'last-time-hint' });
  exerciseInput.addEventListener('blur', () => showLastTimeHint(exerciseInput, hintEl));
  if (values.exercise) showLastTimeHint(exerciseInput, hintEl);

  const row = el('tr', {}, [
    el('td', {}, [exerciseInput, hintEl]),
    el('td', {}, el('input', { type: 'number', class: 'set-number', value: values.set_number || String(setsTableBody.children.length + 1), min: '1' })),
    el('td', {}, el('input', { type: 'number', class: 'set-weight', value: values.weight ?? '', min: '0', step: 'any' })),
    el('td', {}, el('input', { type: 'number', class: 'set-reps', value: values.reps ?? '', min: '0' })),
    el('td', {}, el('input', { type: 'number', class: 'set-rir', value: values.rir ?? '', min: '0', max: '10' })),
    el('td', {}, el('input', { type: 'text', class: 'set-notes', value: values.notes || '' })),
    el('td', {}, el('button', { type: 'button', class: 'remove-set', text: '✕' }))
  ]);
  row.querySelector('.remove-set').addEventListener('click', () => {
    // F06 follow-up: if this row is a folded manual ("+ Add set") row, drop its
    // session-buffer entry too — otherwise the removed set resurrects on the next buffer
    // rebuild and reaches the write. Parser / buffer-rebuilt rows carry no manualId, so
    // their removal is unchanged.
    const mid = row.dataset ? row.dataset.manualId : '';
    if (mid && typeof getSessionLog === 'function') {
      const buf = getSessionLog();
      const idx = buf.findIndex(e => e && String(e._manualId) === String(mid));
      if (idx !== -1) buf.splice(idx, 1);
    }
    row.remove();
    invalidatePreview();
  });
  // F06 / CLIENT-2: remember the exercise name this row was BUILT with, so a rebuild can
  // match it to its session-buffer entry even after the lifter renames the exercise (the
  // buffer is still keyed by the original name). And flag any field the moment the lifter
  // changes it, so the correction is folded back into the buffer before the table is rebuilt
  // — otherwise logging another set reverts it to the parser value.
  row.dataset.originExercise = String(values.exercise || '');
  // A folded manual row keeps its stable id across rebuilds so its ✕ removal (above) can
  // find and drop the matching buffer entry.
  if (values._manualId) row.dataset.manualId = String(values._manualId);
  for (const cls of ['.set-exercise', '.set-weight', '.set-reps', '.set-rir', '.set-notes']) {
    const input = row.querySelector(cls);
    if (input) input.addEventListener('input', () => { input.dataset.userEdited = '1'; });
  }
  setsTableBody.appendChild(row);
  parsedRowsEditor.hidden = false;
}

document.getElementById('add-set-btn').addEventListener('click', () => addSetRow());

document.getElementById('copy-last-session-btn').addEventListener('click', async () => {
  const statusBox = document.getElementById('copy-last-session-status');
  setStatus(statusBox, 'Loading last session…', 'ok');
  try {
    const res = await api('/api/history/recent?limit=100');
    const sets = res.data?.recent_sets || [];
    if (!sets.length) {
      setStatus(statusBox, 'No prior sessions found.', 'error');
      return;
    }
    // Find the most recent session (last session_id in the list)
    const lastSessionId = sets[sets.length - 1].session_id;
    const sessionSets = sets.filter(s => s.session_id === lastSessionId);
    setsTableBody.innerHTML = '';
    parsedRowsEditor.hidden = false;
    for (const s of sessionSets) {
      addSetRow({ exercise: s.canonical_exercise || s.exercise, set_number: s.set_number });
    }
    lastParsedWorkoutText = workoutTextInput.value.trim();
    invalidatePreview();
    setStatus(statusBox, `Copied ${sessionSets.length} exercise slots from session ${lastSessionId}. Fill in weights and reps.`, 'ok');
  } catch (err) {
    setStatus(statusBox, `Could not load: ${err.message}`, 'error');
  }
});

function generateSessionId(dateValue) {
  const compact = String(dateValue || '').replace(/[^0-9]/g, '');
  const suffix = new Date().getHours() < 12 ? 'AM' : 'PM';
  return `${compact}-${suffix}-01`;
}

export function getLocalDateString(dateTime = new Date()) {
  const year = dateTime.getFullYear();
  const month = String(dateTime.getMonth() + 1).padStart(2, '0');
  const day = String(dateTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function collectLogRows(sessionId, date) {
  const rows = [];
  for (const tr of setsTableBody.children) {
    const exercise = tr.querySelector('.set-exercise').value.trim();
    if (!exercise) continue;
    rows.push({
      date_clean: date,
      session_id: sessionId,
      exercise,
      set_number: tr.querySelector('.set-number').value,
      weight: tr.querySelector('.set-weight').value,
      reps: tr.querySelector('.set-reps').value,
      rir: tr.querySelector('.set-rir').value,
      notes: tr.querySelector('.set-notes').value
    });
  }
  return rows;
}

function splitWorkoutLine(line) {
  const match = line.match(/^(.+?)\s+(\d+(?:\.\d+)?(?:\s|x|×).*)$/i);
  if (!match) return null;
  return { exercise: match[1].trim(), setText: match[2].trim() };
}

function parseSetSegment(segment) {
  const repeatMatch = segment.match(/\b(?:x|×)\s*(\d+)\s*$/i);
  const repeat = repeatMatch ? Number(repeatMatch[1]) : 1;
  const cleaned = repeatMatch ? segment.slice(0, repeatMatch.index).trim() : segment.trim();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(?:x|×|for)?\s*(\d+)(?:\s*\/\s*(\d+(?:\.\d+)?)|\s*(?:rir|@)\s*(\d+(?:\.\d+)?))?$/i);
  if (!match) return null;
  return {
    weight: match[1],
    reps: match[2],
    rir: match[3] || match[4] || '',
    repeat: Number.isFinite(repeat) && repeat > 0 ? repeat : 1
  };
}

function parseWorkoutText(text) {
  const rows = [];
  const errors = [];
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (const rawLine of lines) {
    // Added-load bodyweight ("Dips +25 8/2"): mirror the backend slash parser
    // (services/workoutTextParser.js, PR 486 slice 2b/#526) so the OFFLINE local
    // fallback recognizes it too — otherwise splitWorkoutLine can't find the load
    // and the set silently routes to the coach instead of buffering. A token-LEADING
    // "+" (start / after a space) is dropped so the external load reads as Weight;
    // a "+" wedged between digits ("225+25") is left intact. No bodyweight auto-add.
    const line = rawLine.replace(/(^|\s)\+(\d)/g, '$1$2');
    const parsedLine = splitWorkoutLine(line);
    if (!parsedLine) {
      errors.push(`Could not parse line: ${line}`);
      continue;
    }

    const segments = parsedLine.setText
      .split(/[,;]/)
      .map(segment => segment.trim())
      .filter(Boolean);
    if (!segments.length) {
      errors.push(`No sets found for: ${parsedLine.exercise}`);
      continue;
    }

    let setNumber = 1;
    for (const segment of segments) {
      const parsedSet = parseSetSegment(segment);
      if (!parsedSet) {
        errors.push(`Could not parse set "${segment}" for ${parsedLine.exercise}`);
        continue;
      }
      for (let i = 0; i < parsedSet.repeat; i += 1) {
        rows.push({
          exercise: parsedLine.exercise,
          set_number: String(setNumber),
          weight: parsedSet.weight,
          reps: parsedSet.reps,
          rir: parsedSet.rir,
          notes: ''
        });
        setNumber += 1;
      }
    }
  }

  return { rows, errors };
}

// Atlas writes this token into a log row's `notes` to mark a warm-up set. It MUST
// stay in sync with services/warmupTag.js (WARMUP_NOTE_TOKEN / isWarmupNote) — the
// server-side reader that keeps tagged warm-ups OUT of the weight-bump decision
// while they still count in volume. A unit test cross-checks that what we write
// here is recognized by isWarmupNote.
const WARMUP_LOG_NOTE = 'warm-up';

// Build editable set-rows directly from a display-block paste the normalizer has
// already parsed (exercise-name headers + per-line sets — the live composer/app
// export format like "135lbs 10 · warm-up" / "245lbs 6/2"). Warm-up sets are tagged
// in `notes` (logged + counted in volume, excluded only from the bump decision per
// the owner rule) — never dropped, never given a fabricated RIR. The exercise NAME
// is passed through; canonical/lift_code/muscle are resolved server-side on write
// (enrichAndFormatLogRows), exactly as for any other parsed row.
function rowsFromDisplayBlocks(blocks) {
  const rows = [];
  for (const block of blocks) {
    let setNumber = 1;
    for (const s of block.sets) {
      rows.push({
        exercise: block.name,
        set_number: String(setNumber),
        weight: s.weight == null ? '0' : String(s.weight),
        reps: s.reps == null ? '' : String(s.reps),
        rir: s.rir == null ? '' : String(s.rir),
        notes: s.warmup ? WARMUP_LOG_NOTE : ''
      });
      setNumber += 1;
    }
  }
  return rows;
}

function parserStatusNode(status) {
  if (!status) return null;
  const label = status.source === 'backend' ? 'Parsed by backend parser' : 'Parsed locally';
  return el('div', { class: 'parser-status', text: label });
}

function rowsFromBackendParsedWorkout(parsed) {
  // Multi-exercise log (several lifts in one message, split + parsed server-side):
  // flatten every exercise's sets into rows so they all land in the one preview →
  // approve → write card, exactly like a single-exercise log. Same row shape as
  // the single-exercise branch below; the server already resolved each exercise.
  if (parsed && parsed.intent === 'log_sets_multi' && Array.isArray(parsed.exercises)) {
    const rows = [];
    for (const ex of parsed.exercises) {
      const name = ex.canonical_name || ex.exercise || ex.raw_name || '';
      if (!name || !Array.isArray(ex.sets)) continue;
      ex.sets.forEach((set, index) => rows.push({
        exercise: name,
        set_number: String(index + 1),
        weight: set.weight == null ? '0' : String(set.weight),
        reps: set.reps == null ? '' : String(set.reps),
        rir: set.rir == null ? '' : String(set.rir),
        notes: set.load_note ? set.load_note : ''
      }));
    }
    if (rows.length) return rows;
    // No rows resolved → fall through to the clarification error below.
  }

  if (!parsed || parsed.intent !== 'log_sets' || !Array.isArray(parsed.sets)) {
    let message = parsed?.message || parsed?.warnings?.join(' | ') || 'Parser needs clarification.';
    if (parsed?.intent === 'finish_session') {
      message = 'That looks like a finish/save command. Enter or review workout rows first, then run Preview before approving a write.';
    } else if (parsed?.intent === 'effort_capture') {
      message = 'That looks like watch/effort data. Enter it in the Effort fields below.';
    }
    const err = new Error(message);
    err.noFallback = true;
    err.displayMessage = message;
    // Carry the parser's verdict so the caller can tell a FAILED LOG ATTEMPT (a
    // recognized exercise whose sets didn't resolve) apart from a question/chat.
    // This lets a malformed set surface a format hint instead of silently becoming
    // a coach message (the live-audit "looks logged but wasn't" trust gap).
    err.parsedIntent = parsed?.intent || null;
    err.recognizedExercise = (parsed?.partial && parsed.partial.exercise) || null;
    // F09G (CONVO-LOG-1): carry the reps the parser ALREADY detected (e.g. bare-rep
    // bodyweight knee raises) so a clarification can HOLD them and a "Just log it" can
    // commit them — instead of silently discarding partial.sets here.
    err.partialSets = (parsed?.partial && Array.isArray(parsed.partial.sets)) ? parsed.partial.sets : null;
    // Multi-line partial-log (owner 2026-07-02): when NO line resolved, the parser
    // still returns per-line specifics — carry them so the caller can surface the
    // first specific ask ("Which row — seated, bent-over…?") instead of routing a
    // paste full of sets to the coach.
    err.unresolvedLines = Array.isArray(parsed?.unresolved) ? parsed.unresolved : null;
    // True when the backend BLOCKED a multi-exercise blob. Lets the caller route a
    // newline-separated, one-exercise-per-line message to the line-based local parser
    // (each line is unambiguous) instead of dropping it to the coach. Same-line mixing
    // (no newline) stays blocked — see rowsFromWorkoutInput.
    err.multipleExercises = Array.isArray(parsed?.warnings) && parsed.warnings.includes('multiple_exercises_in_input');
    throw err;
  }

  const exercise = parsed.canonical_name || parsed.exercise || parsed.raw_name || '';
  if (!exercise) throw new Error('Parser did not return an exercise.');

  return parsed.sets.map((set, index) => ({
    exercise,
    set_number: String(index + 1),
    weight: set.weight == null ? '0' : String(set.weight),
    reps: set.reps == null ? '' : String(set.reps),
    rir: set.rir == null ? '' : String(set.rir),
    notes: set.load_note ? set.load_note : ''
  }));
}

async function parseWorkoutTextWithBackend(workoutText) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let result;
  try {
    result = await api('/api/parse-workout-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: workoutText,
        context: {
          // When the lifter names no exercise, a bare set sequence attaches to the
          // active lift; if none is active yet but a planned workout is open, fall
          // back to the first unlogged planned lift (the composer's "next up") so
          // "140 15 230 4/2…" lands on Bench instead of dead-ending at "Which
          // exercise is this for?". Still test_mode dry-run — preview/approval
          // rules are unchanged; with no plan context it keeps asking to clarify.
          activeExercise: activeExercise || firstUnloggedPlannedLift(),
          activeSessionType: null,
          todayPlan: null
        },
        test_mode: true
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = result?.data || {};
  if (data.test_mode !== true || data.sheet_written !== false || data.no_write_confirmed !== true) {
    // A flaky/partial response that can't prove its own no-write safety is
    // untrustworthy, so we DISCARD it entirely and let the caller re-parse
    // locally. This is fallback-eligible (no noFallback): the local parser is
    // pure client-side and never writes, the missing proof was the backend's
    // problem with a response we're throwing away, and the real write still
    // goes through preview→approve→write. Dropping a clearly-typed set into
    // chat on flaky signal is the worse failure.
    throw new Error('Backend parser did not prove no-write safety.');
  }

  const parsed = data.parsed;
  const intent = parsed?.intent;

  if (intent === 'delete_last_set') {
    return { intent: 'delete_last_set', rows: null, warnings: data.warnings || [] };
  }
  if (intent === 'update_last_set') {
    return { intent: 'update_last_set', rows: null, update: parsed.update, warnings: data.warnings || [] };
  }

  const rows = rowsFromBackendParsedWorkout(parsed);
  if (!rows.length) {
    // A log_sets response with no actual sets is a partial/garbled response —
    // fallback-eligible (no noFallback) so the local parser can recover a
    // clearly-typed set on flaky signal instead of dropping it into chat.
    throw new Error('Backend parser did not produce any set rows.');
  }
  return {
    intent: 'log_sets',
    rows,
    warnings: data.warnings || [],
    prescribed: Array.isArray(parsed.prescribed) ? parsed.prescribed : null,
    kbIdentity: data.kb_identity || null,
    // Multi-line partial-log (owner 2026-07-02): lines the parser could not resolve,
    // each with its own specific ask — surfaced by rowsFromWorkoutInput so a clean
    // paste never silently drops its one ambiguous line.
    unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved : null,
    // F10S2/F10S6c — the one-turn "instead of <original>" directive must survive this
    // rebuilt shape, or the arming block downstream never sees it (Codex P1 on #1062).
    substitution: (parsed.substitution && parsed.substitution.for) ? parsed.substitution : null
  };
}

function populateSetRows(rows) {
  setsTableBody.innerHTML = '';
  for (const row of rows) addSetRow(row);
  parsedRowsEditor.hidden = rows.length === 0;
}

function deleteLastSetRow() {
  const rows = Array.from(setsTableBody.children);
  if (!rows.length) return;
  rows[rows.length - 1].remove();
  if (!setsTableBody.children.length) parsedRowsEditor.hidden = true;
}

function applyUpdateToLastRow(update) {
  if (!update) return;
  const rows = Array.from(setsTableBody.children);
  if (!rows.length) return;
  const lastRow = rows[rows.length - 1];
  if (update.weight != null) lastRow.querySelector('.set-weight').value = String(update.weight);
  if (update.reps != null) lastRow.querySelector('.set-reps').value = String(update.reps);
  if (update.rir != null) lastRow.querySelector('.set-rir').value = String(update.rir);
}

// When a conversational log names a lift the parser can't resolve ("Lat pull",
// "Incline") but the lead clearly refers to the current pending PLANNED lift,
// re-parse with the planned lift's full name substituted so the sets attach to it
// instead of dead-ending in chat ("Noted — keep logging…"). Returns rows or null.
// Frontend-only: it calls the SAME backend parser with a resolved name — no parser
// grammar change. Gated tightly — only fires when the lead (the words before the
// first number) alias-matches the pending planned lift, so an unrelated new lift
// never mis-attaches; with no plan / no match it returns null and the normal
// chat-clarify fallback runs.
async function rowsFromUnresolvedPlannedLead(workoutText) {
  const planned = firstUnloggedPlannedLift();
  if (!planned) return null;
  const tokens = String(workoutText || '').trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && !/\d/.test(tokens[i])) i += 1;
  if (i === 0 || i >= tokens.length) return null; // no lead name, or no set tokens
  const lead = tokens.slice(0, i).join(' ').toLowerCase();
  const p = String(planned).toLowerCase();
  if (!(lead === p || p.includes(lead) || lead.includes(p))) return null;
  const rebuilt = `${planned} ${tokens.slice(i).join(' ')}`;
  try {
    const retry = await parseWorkoutTextWithBackend(rebuilt);
    return retry && retry.intent === 'log_sets' ? retry.rows : null;
  } catch {
    return null;
  }
}

// Normalize an exercise phrase to singular-word tokens for family matching.
function bareLeadTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

// Plan-aware disambiguation of a BARE/generic leading exercise term. When the lifter
// types a short generic name ("rows", "bench", "curls") whose words are a subset of a
// planned exercise's name, and the plan has EXACTLY ONE such exercise, rewrite the
// lead to that planned name so it logs as the specific movement — the session plan is
// the highest-confidence reference after the lifter's own words ("seated row is the
// only row planned, so 'rows' means seated row"). Pure and conservative:
//   • only the leading name (the words before the first set number) is considered;
//   • fires only on a UNIQUE family match — zero or multiple planned matches → text
//     unchanged, so the existing alias/ask/default behavior stands;
//   • a lead that is already as specific as (or more specific than) the plan entry is
//     left alone (its tokens wouldn't be a strict subset needing a rewrite).
function rewriteBareLeadAgainstPlan(text, plannedNames) {
  const raw = String(text == null ? '' : text);
  const m = raw.match(/^(\s*)([A-Za-z][A-Za-z' -]*?)\s+(\d[\s\S]*)$/);
  if (!m) return text;
  const leadTokens = bareLeadTokens(m[2]);
  if (!leadTokens.length) return text;
  const names = Array.isArray(plannedNames) ? plannedNames.filter(Boolean) : [];
  const matches = [];
  for (const name of names) {
    const nameTokens = bareLeadTokens(name);
    const nameSet = new Set(nameTokens);
    // Generic match: every lead word appears in the plan name, and the lead is not
    // MORE specific than the plan entry (lead tokens ⊆ plan tokens).
    if (leadTokens.length <= nameTokens.length && leadTokens.every(t => nameSet.has(t))) {
      if (!matches.includes(name)) matches.push(name);
    }
  }
  if (matches.length !== 1) return text;                 // ambiguous or no match → leave it
  if (bareLeadTokens(matches[0]).join(' ') === leadTokens.join(' ')) return text; // already specific
  return `${m[1]}${matches[0]} ${m[3]}`;
}

// Planned exercise names for bare-lead disambiguation — still-unlogged first (the one
// the lifter is on), then the full plan; deduped, order-preserving.
function planNamesForDisambiguation() {
  const remaining = typeof remainingPlannedExercises === 'function' ? remainingPlannedExercises() : [];
  const planned = typeof plannedExerciseOrder === 'function' ? plannedExerciseOrder() : [];
  const seen = new Set();
  const out = [];
  for (const n of [...remaining, ...planned]) {
    const key = String(n || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

async function rowsFromWorkoutInput() {
  lastParseSubstitution = null; // F10S2: one-shot — every new parse starts clean
  let workoutText = workoutTextInput.value.trim();
  // Plan-aware disambiguation: a bare generic lead ("rows", "bench", "curls") means
  // the plan's unique exercise of that family. Rewrite it to that planned name BEFORE
  // parsing so it logs as the specific movement; with no plan (or an ambiguous /
  // absent match) it is byte-identical and the existing alias/ask/default stands.
  workoutText = rewriteBareLeadAgainstPlan(workoutText, planNamesForDisambiguation());
  if (!workoutText || workoutText === lastParsedWorkoutText) return;

  // F06/CLIENT-2: fold preview hand-edits into the buffer before this reparse wipes the table.
  reconcileSessionLogFromTable();

  // F07/CLIENT-3: capture this parse's request identity. If a newer submit supersedes it while
  // we await the backend, the stale rows are dropped instead of overwriting the table.
  const parseSeq = previewRequestSeq;

  // Multi-exercise display-block paste — the live composer / app-export format:
  // bare exercise-name headers with per-line sets ("135lbs 10 · warm-up" warm-ups,
  // "245lbs 6/2" working sets), several exercises stacked. The proven single-line
  // parser can't read it (name and sets are on separate lines), so it dropped to the
  // coach ("Noted — keep logging") and lost every set. Detect it deterministically
  // and build the rows here; warm-ups are tagged, and the rows flow through the SAME
  // preview → approve → write loop, unchanged. Conservative: the normalizer returns
  // isDisplayBlock:false for single-line / slash / ambiguous input, so existing
  // parsing is untouched.
  if (typeof displayBlockNormalizer !== 'undefined' && displayBlockNormalizer &&
      typeof displayBlockNormalizer.normalizeDisplayBlocks === 'function') {
    const blocked = displayBlockNormalizer.normalizeDisplayBlocks(workoutText);
    if (blocked.isDisplayBlock && blocked.blocks.length) {
      // kg gate: Atlas logs in pounds. Never silently log kg as lb — ask the lifter
      // to convert rather than corrupt the weight. `handled` keeps the catch from
      // routing this to the coach.
      const hasKg = blocked.blocks.some(b => b.sets.some(s => s.unit === 'kg'));
      if (hasKg) {
        lastParsedWorkoutText = workoutText;
        const e = new Error('Atlas logs in pounds — convert the kg values and paste again.');
        e.displayMessage = e.message;
        e.handled = true;
        throw e;
      }
      const blockRows = rowsFromDisplayBlocks(blocked.blocks);
      if (blockRows.length) {
        populateSetRows(blockRows);
        lastParserStatus = { source: 'display-block' };
        activeExercise = blockRows[blockRows.length - 1].exercise || null;
        parsedRowsEditor.hidden = true;
        lastParsedWorkoutText = workoutText;
        lastPrescribed = null;
        return;
      }
    }
  }

  let parsed;
  try {
    parsed = await parseWorkoutTextWithBackend(workoutText);
  } catch (backendError) {
    // Re-parse a shorthand-named lift that refers to the pending planned lift, so
    // "Lat pull"/"Incline" attach to "Lat Pulldown"/"Incline DB Press" instead of
    // routing to chat. ONLY when the backend actually responded but couldn't resolve
    // rows (noFallback) — for network/5xx we skip it and go straight to the local
    // fallback (which already gets firstUnloggedPlannedLift as activeExercise),
    // avoiding a wasted ~8s re-parse timeout when offline at the gym.
    const replanned = !shouldUseLocalFallback(backendError)
      ? await rowsFromUnresolvedPlannedLead(workoutText)
      : null;
    if (replanned && replanned.length) {
      // F07 / CLIENT-3: this fallback also runs after an await — drop it if superseded.
      if (parseSeq !== previewRequestSeq) return;
      populateSetRows(replanned);
      lastParserStatus = { source: 'backend-replanned' };
      activeExercise = replanned[0]?.exercise || null;
      parsedRowsEditor.hidden = true;
      lastParsedWorkoutText = workoutText;
      lastPrescribed = null;
      return;
    }
    // Multi-line, one-exercise-per-line strength logging (Fix A). The backend
    // INTENTIONALLY blocks a multi-exercise blob (ambiguous same-line mixing), but
    // newline-separated lines are each unambiguous, so route them to the line-based
    // local parser — which the noFallback block would otherwise bypass — so ALL lines
    // log instead of dropping to the coach (the "looks logged but wasn't" trust gap).
    // Guards: only when the backend flagged multiple_exercises_in_input AND the input
    // actually spans newlines (so same-line mixing stays blocked), AND the local parse
    // is CLEAN (no per-line errors) — an uncertain line is never silently logged.
    if (backendError.multipleExercises && /\n/.test(workoutText)) {
      const multi = parseWorkoutText(workoutText, { activeExercise: activeExercise || firstUnloggedPlannedLift() });
      if (!multi.errors.length && multi.rows.length) {
        if (parseSeq !== previewRequestSeq) return; // F07/CLIENT-3: drop a superseded parse
        populateSetRows(multi.rows);
        lastParserStatus = { source: 'local-multiline' };
        activeExercise = multi.rows[0]?.exercise || null;
        parsedRowsEditor.hidden = true;
        lastParsedWorkoutText = workoutText;
        lastPrescribed = null;
        return;
      }
      // Ambiguous/partial multi-line → fall through to the existing path (never log
      // uncertain rows). Same-line mixing (no newline) never reaches here.
    }
    if (!shouldUseLocalFallback(backendError)) throw backendError;
    console.warn('[atlas] parse-workout-text unavailable, using local fallback:', backendError.message);
    const localResult = parseWorkoutText(workoutText, { activeExercise: activeExercise || firstUnloggedPlannedLift() });
    if (localResult.errors.length > 0) throw new Error(localResult.errors.join(' | '));
    if (!localResult.rows.length) throw new Error('Workout text did not produce any set rows.');
    if (parseSeq !== previewRequestSeq) return; // F07/CLIENT-3: drop a superseded parse
    populateSetRows(localResult.rows);
    lastParserStatus = { source: 'local' };
    parsedRowsEditor.hidden = true;
    lastParsedWorkoutText = workoutText;
    lastPrescribed = null;
    return;
  }

  // F07 / CLIENT-3: a newer submit superseded this parse while the backend ran — drop the
  // stale rows so they can't overwrite the newer request's table.
  if (parseSeq !== previewRequestSeq) return;

  if (parsed.intent === 'delete_last_set') {
    deleteLastSetRow();
    setStatus(loggerStatus, 'Last set removed.', 'ok');
    lastParsedWorkoutText = workoutText;
    return;
  }

  if (parsed.intent === 'update_last_set') {
    applyUpdateToLastRow(parsed.update);
    setStatus(loggerStatus, 'Last set updated.', 'ok');
    lastParsedWorkoutText = workoutText;
    return;
  }

  populateSetRows(parsed.rows);
  lastParserStatus = { source: 'backend' };
  activeExercise = parsed.rows[0]?.exercise || null;
  parsedRowsEditor.hidden = true;
  lastParsedWorkoutText = workoutText;
  lastPrescribed = parsed.prescribed || null;
  // F10S2 — the parser recognized a one-turn "<substitute log> instead of <original>"
  // (F10S6c) and carried the replaced exercise. Hold it one-shot; the chat-lane log
  // commit arms the deferred-swap lane with it so THIS turn's logged exercise binds
  // to the named planned slot (its original plan_item_id).
  lastParseSubstitution = (parsed.substitution && parsed.substitution.for)
    ? String(parsed.substitution.for) : null;

  // The parser couldn't confidently resolve a lift name and echoed the typed
  // text instead of guessing a real lift. Surface it so the wrong history isn't
  // saved — the exercise field is editable, so a tap fixes it before approval.
  // But the parser's internal alias map is NARROWER than the exercise catalog: a
  // real lift like "Cable Fly" is `unknown_exercise` to the parser yet known to
  // the catalog. Only warn when it's truly unresolved — unknown to the catalog
  // too — so a successfully-parsed, catalog-known lift never gets "didn't catch
  // that" on top of its confirmation card.
  lastUnverifiedExercise = null;
  // Card/advisory consistency (owner 07-02) — per ROW, not just rows[0], and
  // computed BEFORE the unresolved-lines early return (QA sweep 2026-07-03):
  // a multi-line paste can carry an unknown name on ANY line, and a paste with
  // BOTH an unresolved line and an unknown name used to return early on the
  // ask and let the unknown sail to the sheet with a full-confidence ✓ card —
  // the exact Curls bug class. Every truly-unresolved name now feeds the
  // card's "check name" chip regardless of which status line wins below.
  // kbIdentity is the server's identity for the PRIMARY lift, so it only
  // vouches for row 0.
  const unverifiedNames = [];
  {
    const seenNames = new Set();
    (parsed.rows || []).forEach((row, i) => {
      const name = row && row.exercise;
      if (!name || seenNames.has(name)) return;
      seenNames.add(name);
      if (shouldWarnUnknownLift(parsed.warnings, name, liftCodeFromCatalog, i === 0 ? parsed.kbIdentity : null)) {
        unverifiedNames.push(name);
      }
    });
  }
  if (unverifiedNames.length) {
    lastUnverifiedExercise = unverifiedNames.length === 1 ? unverifiedNames[0] : unverifiedNames;
  }

  // Multi-line partial-log (owner 2026-07-02): the clean lines are captured above;
  // each unresolved line gets its OWN specific ask so it can be re-typed — never
  // silently dropped, never the generic "keep logging" fallback. Its composer
  // status takes precedence over the unknown-lift advisory below (a re-typed line
  // re-runs both checks); the check-name chips still render either way, because
  // lastUnverifiedExercise was set above this return.
  if (Array.isArray(parsed.unresolved) && parsed.unresolved.length) {
    parsedRowsEditor.hidden = false;
    const first = parsed.unresolved[0];
    const extra = parsed.unresolved.length > 1 ? ` (+${parsed.unresolved.length - 1} more like it)` : '';
    setStatus(loggerStatus,
      `Captured the rest — one line needs a check: "${first.line}"${extra} — ${first.message} Re-type that line and I'll add it.`,
      'warn');
    return;
  }

  if (unverifiedNames.length) {
    // B2 — the composer status and the chat confirmation card must agree about the
    // same input. The set IS captured: these rows flow to the very same confirmation
    // card / preview as any other log (emitSetLogged buffers them, then closeout
    // saves them), so the composer must NOT contradict that with a failure message
    // implying the lift was dropped. Surface one consistent name-review advisory
    // instead — gated by the identical shouldWarnUnknownLift check as before
    // (KB/catalog-known lifts still get no advisory). No write-path/trust-loop
    // change; the unresolved names are still flagged for the lifter to correct.
    parsedRowsEditor.hidden = false;
    if (unverifiedNames.length === 1) {
      setStatus(loggerStatus, `I don't recognize "${unverifiedNames[0]}" — check the exercise name before it's saved.`, 'warn');
    } else {
      setStatus(loggerStatus, `I don't recognize ${unverifiedNames.map(n => `"${n}"`).join(', ')} — check those exercise names before they're saved.`, 'warn');
    }
  }
}

// Whether to warn that a lift wasn't caught. True only when the parser flagged
// `unknown_exercise` AND the catalog doesn't recognize the resolved name either —
// i.e. the parser truly failed to resolve a real lift. A catalog hit (the parser
// map is just narrower than the catalog) means it's a real lift; no warning.
function shouldWarnUnknownLift(warnings, exerciseName, catalogLookup, kbIdentity) {
  if (!(Array.isArray(warnings) && warnings.includes('unknown_exercise'))) return false;
  // The server attaches a KB identity when the exercise resolver recognizes the
  // lift (e.g. Cable Fly) even though the parser's narrower catalog flagged it
  // unknown. That is the SAME identity source the card/voice trust — so honor it
  // here too and don't split-brain a real lift into a "didn't catch that" warning.
  if (kbIdentity && kbIdentity.exercise_id) return false;
  const known = typeof catalogLookup === 'function' && exerciseName && catalogLookup(exerciseName);
  return !known;
}

function shouldUseLocalFallback(err) {
  return err.noFallback !== true &&
    (err.status === undefined || err.status >= 500);
}

function effortMode() {
  return document.querySelector('input[name="effort-mode"]:checked').value;
}

document.querySelectorAll('input[name="effort-mode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    document.getElementById('effort-manual').hidden = effortMode() !== 'manual';
    document.getElementById('effort-screenshot').hidden = effortMode() !== 'screenshot';
    invalidatePreview();
  });
});

// The effort panel's own submit affordance. Manual effort (and the device-screenshot
// sub-mode) live inside the logger form, but the only control that submitted them was
// the composer's ↑ button — so after typing effort there was no obvious next step and
// it "just sat there" (owner live-test gap, 2026-06-28). This button dispatches the
// SAME logger-form submit the ↑ does, so manual effort + the buffered session flow
// into one preview through the identical preview→approve→write path. It opens NO new
// write path and changes no trust-loop semantics — it is purely a more discoverable
// trigger for the existing submit handler (the same dispatch runCloseout already uses).
document.getElementById('effort-preview-btn')?.addEventListener('click', () => {
  document.getElementById('logger-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
});

// Explicit "Finish session" affordance for freestyle logging — so closing out a
// session no longer depends on knowing the "done"/"log it" chat keyword. It is a
// contextual control: shown once a set is logged this session, hidden on reset/save.
// Clicking it runs the SAME closeout as "log it" (handleLogIt → runCloseout →
// preview → review card), so it opens no new write path and the preview→approve→write
// trust loop is unchanged — nothing is saved until the lifter approves the review card.
function setFinishSessionVisible(visible) {
  const btn = typeof document !== 'undefined' ? document.getElementById('finish-session-btn') : null;
  if (btn) btn.hidden = !visible;
}
// PR-H: the explicit "Finish session" affordance is a `finalized` closeout (emit
// before the save-review flow; gated on an accepted plan → no-op for freestyle).
// F10D — finishing opens the closeout CONFIRMATION; the finalized closeout event
// records only when the owner APPROVES the save (the approve handler emits it).
// A rejected/abandoned confirmation writes nothing — including this event.
document.getElementById('finish-session-btn')?.addEventListener('click', () => { handleLogIt(); });
document.addEventListener('atlas:set-logged', () => setFinishSessionVisible(true));
document.addEventListener('atlas:session-reset', () => setFinishSessionVisible(false));
// The pin re-derives (and hides) on every session reset — same signal that
// clears the finish button, so the two can never disagree about "in progress".
document.addEventListener('atlas:session-reset', renderSessionPin);
// #1123: a session reset is the ONLY thing that clears the closeout-stage latch — it
// fires on a verified approved write, Start Over, and discard-of-restored, i.e. exactly
// when sessionLog is cleared. So the latch is true only between a staged closeout and
// the next reset, and can never leak the append-block into a genuinely new session.
document.addEventListener('atlas:session-reset', () => { closeoutPreviewStaged = false; });
document.addEventListener('atlas:session-reset', () => { latestSetResponseCompletion = null; });

function collectManualEffort(sessionId, date, location, notes) {
  const duration = document.getElementById('effort-duration').value.trim();
  const activeCal = document.getElementById('effort-active-cal').value;
  const totalCal = document.getElementById('effort-total-cal').value;
  const avgHr = document.getElementById('effort-avg-hr').value;
  const peakHr = document.getElementById('effort-peak-hr').value;

  const anyFilled = duration || activeCal || totalCal || avgHr || peakHr;
  if (!anyFilled) return null;
  if (!duration || !activeCal || !totalCal || !avgHr || !peakHr) {
    throw new Error('Effort needs duration, active calories, total calories, average HR, and peak HR (or leave all blank).');
  }

  return {
    date,
    session_id: sessionId,
    duration,
    active_calories: Number(activeCal),
    total_calories: Number(totalCal),
    average_hr: Number(avgHr),
    peak_hr: Number(peakHr),
    location: location || '',
    notes: notes || ''
  };
}

function extractLiftCodes(logRowsPreview) {
  const seen = new Set();
  const codes = [];
  for (const row of (logRowsPreview || [])) {
    const code = String(row[5] || '').trim();
    if (code && !seen.has(code)) { seen.add(code); codes.push(code); }
  }
  return codes;
}

// F10D — the closeout confirmation context: one bounded item per accepted plan
// slot, LABELING the server's summary (the seal never depends on these — the
// server validates and bounds them, and they can only make verification
// stricter). A substituted slot's CURRENT liftCode is the PERFORMED lift; its
// original planned code lives in the durable ledger, joined server-side by the
// slot's immutable plan_item_id.
function closeoutContextItems() {
  // The context walks the ACCEPTED IDENTITY SPINE (session.items — immutable
  // plan_item_ids + planned codes), not the mutable working view: an explicitly
  // declined slot leaves `exercises` entirely, and without the spine its item
  // never reached the confirmation at all (the F10D proving pack caught the
  // skipped slot rendering as a bare ledger code). The working view + statuses
  // then label each surviving slot's outcome.
  const s = getActivePlannedSession();
  if (!s) return [];
  let statuses = [];
  try { statuses = planSlotStatuses(activePlanForSlots(), getSessionCompleted(), getSessionLog()) || []; } catch { statuses = []; }
  // The RAW session slot objects (never the plannedExerciseEntries projection —
  // it drops `reason`, which erased the substituted outcome). Status order and
  // slot order both derive from the session's exercises, index-aligned.
  const viewByItemId = new Map();
  (Array.isArray(s.exercises) ? s.exercises : []).forEach((ex, i) => {
    if (ex && ex.plan_item_id && !viewByItemId.has(ex.plan_item_id)) {
      viewByItemId.set(ex.plan_item_id, { ex, st: statuses[i] || {} });
    }
  });
  const spineItems = (Array.isArray(s.items) ? s.items : []).filter(it => it && it.plan_item_id);
  const spine = spineItems.length ? spineItems.map(it => it.plan_item_id)
    : [...viewByItemId.keys()];
  const plannedCodeById = new Map(spineItems.map(it => [it.plan_item_id, it.planned_lift_code || '']));
  return spine.map(plan_item_id => {
    const hit = viewByItemId.get(plan_item_id);
    if (!hit) {
      // The slot was removed from the working view (explicit decline). The
      // accepted identity still reaches the confirmation as skipped work.
      return { plan_item_id, planned_lift_code: plannedCodeById.get(plan_item_id) || '', outcome: 'skipped' };
    }
    const { ex, st } = hit;
    const substituted = ex.reason === 'substituted';
    const performedSets = Number(st.performedSets || 0);
    // Outcome labels only what is derivable: completed / substituted / skipped
    // (zero performed sets). A started-but-incomplete slot sends no outcome —
    // the summary's per-set unperformed flags carry the partial truth.
    const outcome = substituted ? 'substituted'
      : st.status === 'completed' ? 'completed'
        : performedSets === 0 ? 'skipped' : '';
    // A one-turn substitution can rename the slot before enrichment assigns its
    // code — resolve the performed code from the client catalog so the summary
    // can join the substitute's actuals (name-grain server fallback backstops).
    const performedCode = ex.liftCode || liftCodeFromCatalog(ex.canonicalName || ex.name) || '';
    return {
      plan_item_id,
      planned_lift_code: substituted ? '' : (ex.liftCode || plannedCodeById.get(plan_item_id) || ''),
      ...(substituted ? { performed_lift_code: performedCode } : {}),
      name: ex.name || '',
      ...(outcome ? { outcome } : {}),
    };
  });
}

// ── F10D acceptance boundary (owner canary finding, 2026-07-18) ────────────────
// A DISPLAYED recommendation is never an active plan: without the explicit
// "Start this plan" acceptance there is no plan identity, no Session_Plans
// acceptance row, and no Session_Plan_Sets checkpoint — so a set logged from an
// unaccepted plan surface would silently train outside the ledger (the first
// production canary's exact shape). The gate holds the COMMIT (client state
// only — never a write path) and offers the ONE existing acceptance action.
// Genuinely freeform logging never gates: nothing displayed, or a set unrelated
// to a merely-displayed pick, passes straight through; an accepted session
// (including one restored on reload — `accepted` persists in the snapshot)
// never re-asks.
let blockedLogText = null;
let blockedLogSeq = 0;
function displayedRecommendation() {
  const intents = (lastIntentData && lastIntentData.intents) || [];
  const rec = intents.find(i => i.recommended) || null;
  return rec && Array.isArray(rec.exercises) && rec.exercises.length ? rec : null;
}
function unacceptedPlanGateRec(logRows) {
  const s = getActivePlannedSession();
  if (s && s.accepted === true) return null;             // formal plan active
  const rec = displayedRecommendation();
  if (!rec) return null;                                 // nothing displayed → freeform
  if (rec.id === 'deload_reset') return null;            // deload keeps its own owner-gated flow
  // An ENGAGED pick or a materialized-but-unaccepted session is a plan surface
  // acting plan-like without identity — the boundary applies to any set.
  const onPlanSurface = getCoachSuggestionEngaged() === true
    || Boolean(s && Array.isArray(s.exercises) && s.exercises.length);
  if (onPlanSurface) return rec;
  // Merely displayed: gate only a set visibly FROM the plan (name or catalog
  // code, so an alias like "RDL" cannot slip past "Romanian Deadlift").
  const keys = new Set();
  for (const ex of rec.exercises) {
    const nm = String(ex.exercise || ex.name || '').toLowerCase().trim();
    if (nm) {
      keys.add(nm);
      const catCode = String(liftCodeFromCatalog(nm) || '').toLowerCase().trim();
      if (catCode) keys.add(catCode);
    }
    const code = String(ex.lift_code || ex.liftCode || '').toLowerCase().trim();
    if (code) keys.add(code);
  }
  const fromPlan = (logRows || []).some(r => {
    const nm = String((r && r.exercise) || '').toLowerCase().trim();
    if (!nm) return false;
    if (keys.has(nm)) return true;
    const code = String(liftCodeFromCatalog(nm) || '').toLowerCase().trim();
    return Boolean(code && keys.has(code));
  });
  return fromPlan ? rec : null;
}
// Called by the acceptance card AFTER window.atlasAcceptPlan resolves started
// (or honestly degrades — the sidecar is non-blocking): releases the held
// message back through the ONE submit path, where the now-accepted session
// passes the gate and the set logs into the plan normally.
//
// Returns TRUE only when the stash was actually replayed into the submit path. The
// caller must never narrate the held set's fate on a false return (advisory P1,
// PR #1179): every early exit below means this text was deliberately NOT resumed,
// and a "still being logged" line would then vouch for a set that was dropped.
window.atlasResumeBlockedLog = () => {
  const text = blockedLogText;
  blockedLogText = null;
  if (!text || !workoutTextInput) return false;
  // CLIENT-3 discipline: if ANY newer submit began after this stash was written
  // (e.g. the athlete's next message was still in flight when they tapped Start —
  // it passes the now-accepted gate and commits ITSELF), the stash is stale and
  // replaying it would DUPLICATE a set. The newest message always wins; a
  // dropped stale stash costs at most a retype, never a duplicate row.
  if (previewRequestSeq !== blockedLogSeq) return false;
  workoutTextInput.value = text;
  // The REAL submit gesture (a bare synthetic 'submit' event does not run the
  // form's submission machinery): click the submit button, exactly as the
  // athlete would, so the held message re-enters the one submit path.
  const previewBtn = document.getElementById('preview-btn');
  const form = document.getElementById('logger-form');
  if (previewBtn) { previewBtn.click(); return true; }
  if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return true; }
  return false;
};

// Hand the just-previewed sets to the conversation layer (coach-conversation.js)
// so it can type a coaching note with an inline Save. Read-only narration: it
// never writes — Save just clicks #approve-btn, which stays gated by the dry-run
// proof. Best-effort; a missing listener is a no-op.
function emitCoachPreview(rows, liftCodes, effortOnly, effort, substitutions, dateInfo, closeoutSummary) {
  try {
    document.dispatchEvent(new CustomEvent('atlas:preview-ready', {
      detail: {
        rows: rows || [],
        liftCodes: liftCodes || [],
        effortOnly: Boolean(effortOnly),
        effort: effort || null,
        substitutions: Array.isArray(substitutions) ? substitutions : [],
        // B5: the resolved workout date + its source (manual | screenshot |
        // today_fallback) so the in-thread review card can show — and let the owner
        // correct — the date before approving. null source = nothing to show.
        dateInfo: (dateInfo && dateInfo.date) ? dateInfo : null,
        // P0 wiring 2b: the recap's completed/remaining view derives from the ONE
        // canonical session (identity reconciled against the mutated plan), so it
        // can't disagree with what was logged. null when nothing was logged.
        recap: canonicalSessionRecap(),
        // F10D — the server-assembled single-confirmation summary (both truths +
        // the exact rows to write and seal), present only on a session closeout.
        closeoutSummary: closeoutSummary || null
      }
    }));
  } catch { /* narration is optional */ }
}

// P0 wiring 2b: derive the end-of-session recap from the canonical ActiveSession,
// so "what you did / what's still on the plan" reconciles each logged lift's
// identity against the (possibly swapped/skipped) plan through the shared model —
// never the divergent raw-string remaining. Returns null when there is no session
// OR when nothing was actually logged (hasLoggedWork()=false), so an all-skipped /
// empty session is never narrated as a completed workout. Read-only: it informs
// narration only and never changes which rows are written (the written sets still
// come from sessionLog — the canonical model carries identity, not set data).
function canonicalSessionRecap() {
  const AS = (typeof window !== 'undefined' && window.activeSession) || (typeof activeSession !== 'undefined' ? activeSession : null);
  const s = AS ? getCanonicalSession() : null;
  // F10S1: an IN-PROGRESS slot (sets logged, below its required count) is logged work
  // even though the AS model does not mark it completed — the raw session log is the
  // evidence. Without this, a 1-of-3 session would falsely report "nothing logged yet".
  if (!AS || !s || !(AS.hasLoggedWork(s) || getSessionLog().length)) return null;
  const completed = AS.completedExercises(s).map(e => e.name).filter(Boolean);
  // F10 — recap remaining derives from the ONE authoritative selector (the same source
  // the pin/next-up/closeout/Workout Sheet read), which folds in the ADD-4 variant rule.
  return {
    completed,
    remaining: remainingPlannedExercises()
  };
}

// In-workout: hand a just-LOGGED (not previewed) set to the conversation layer
// for a readback + adjusted-next coaching reaction. No write, no preview, no
// Save — purely narration off the client-parsed rows. The set text rides along
// so the end-of-session compile can reconstruct the full workout.
// Structured client-side buffer of every set logged this session. The end-of-
// session save (done / effort / screenshot) is built from THIS — never from a
// Gemini compile or a re-parse — so it's reliable and identical across triggers.
// PR-10: sessionLog now lives in store.js.
// Unique exercise names logged this session. Sent in chat context as
// plan_completed so the server can compute which planned exercises remain.
// Cleared alongside sessionLog at save and on startOver.
// PR-10: sessionCompleted now lives in store.js.
// DISPLAY-ONLY ledger of exercises already SAVED during this workout. A save
// concludes the session (sessionLog is cleared, and the next set auto-increments
// to a new session_id), so without this a later closeout in the same gym session
// showed only the post-save sets — earlier, already-saved exercises looked
// "missing" from the confirm/review card even though they're safely on the sheet.
// This is NEVER part of any write payload (the write comes from the server-
// previewed buffer / edit table); it is reset only on a deliberate fresh start
// (startOver / discard restored), NOT on save.
// PR-10: sessionSavedLog now lives in store.js.
// A closeout screenshot is optional evidence, not workout text. When the plan is
// already complete, choosing a file under the composer must not auto-route to
// /api/complete-workout; "done" still saves the buffered session rows.
let closeoutScreenshotFile = null;
let closeoutScreenshotEffort = null;
// RC2: the date source resolved for a closeout screenshot save
// (manual | screenshot | today_fallback). Drives a preview banner so the chosen
// workout date is visible — and correctable — before the owner approves.
let closeoutScreenshotDateSource = null;
// RC2: whether the owner EXPLICITLY typed a workout date. A closeout screenshot's
// own date only wins when this is false. setDefaultDate() sets #log-date's value
// programmatically (no input event), so the default-today never trips this.
let logDateManuallyEntered = false;

/* ===== Mobile PWA session persistence/resume safety =====
 * Live gym testing on a phone home-screen icon can lose the in-memory session to a
 * reload, force-quit, or accidental swipe. We snapshot ONLY the in-progress session
 * buffers — sessionLog (the set data), sessionCompleted (resolved identities), and
 * activePlannedSession (the live plan/cursor) — to localStorage, and restore them on
 * load so the lifter resumes mid-session. This is persistence/resume ONLY: it never
 * changes coaching, parsing, or the preview→approve→write trust loop — the snapshot
 * is the SAME data the buffers already hold, written/read defensively. The snapshot
 * is cleared on a successful save and on Start Over. Recency-gated so a stale snapshot
 * (>12h) is ignored rather than resurrecting yesterday's half-session.
 * PR-10: the snapshot's state serialization / parse / validation + localStorage I/O
 * (incl. the recency gate and the v1→v2 shape bump that carries pendingSubstitution)
 * moved into store.js behind persistSessionSnapshot()/hydrateSessionSnapshot()/
 * clearPersistedSnapshot(). app.js keeps only the DOM half: the #log-session-id
 * field and the resume-notice banner. */

function saveSessionSnapshot() {
  // The stable session_id (a DOM value) rides along so a re-preview after restore
  // reuses the SAME id, letting the server's row-level dedup catch duplicate rows
  // even though the write_id is regenerated across page loads. The store owns the
  // "nothing in progress → drop the snapshot" guard.
  const sessionIdEl = typeof document !== 'undefined' ? document.getElementById('log-session-id') : null;
  const sessionId = sessionIdEl ? sessionIdEl.value.trim() : '';
  persistSessionSnapshot(sessionId);
}

function clearSessionSnapshot() {
  clearPersistedSnapshot();
  // Also hide the resume notice so it doesn't linger after a save or Start Over.
  try {
    const notice = typeof document !== 'undefined' ? document.getElementById('session-resume-notice') : null;
    if (notice) notice.hidden = true;
  } catch { /* ignore */ }
}

// Discard a restored in-progress session entirely — buffer, plan (deload-aware via
// endPlannedSession), closeout state, the session_id, and the snapshot — so a fresh
// workout starts clean. Triggered by the restore banner's swipe-to-trash action.
function discardRestoredSession() {
  setSessionLog([]);
  setSessionCompleted([]);
  setSessionRevisions([]); setSessionImplicitRecs([]);
  setSessionSavedLog([]);     // discarding the restored workout also clears its saved recap
  endPlannedSession();
  closeoutScreenshotFile = null;
  closeoutScreenshotEffort = null;
  closeoutScreenshotDateSource = null;
  const sidEl = typeof document !== 'undefined' ? document.getElementById('log-session-id') : null;
  if (sidEl) sidEl.value = '';
  clearSessionSnapshot();   // removes the persisted snapshot AND hides the notice
  document.dispatchEvent(new CustomEvent('atlas:session-reset'));
}

// Tap the restore banner → bring the recovered workout into view: populate the editable
// rows from the buffer and reveal them, so the restored sets are visible and saveable
// (the session stays buffered — this only un-hides what was silently restored).
function restoreSessionToView() {
  if (!Array.isArray(getSessionLog()) || !getSessionLog().length) return;
  populateSetRows(buildRowsFromSessionLog());
  if (parsedRowsEditor) {
    parsedRowsEditor.hidden = false;
    // The rows editor is a <details> — revealing it (hidden=false) only shows the
    // collapsed "Edit rows" summary. Open it so "tap to view" actually surfaces the
    // restored sets instead of an empty-looking disclosure (BUG-20260629-054925).
    parsedRowsEditor.open = true;
    if (parsedRowsEditor.scrollIntoView) parsedRowsEditor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const notice = typeof document !== 'undefined' ? document.getElementById('session-resume-notice') : null;
  if (notice) notice.hidden = true;
  // A restored session has logged work — surface the explicit finish affordance too.
  setFinishSessionVisible(true);
}

// iOS-style swipe-to-reveal-trash + tap-to-restore on the resume banner. Horizontal
// drags slide the content left to expose the trash; a tap (no real drag) restores.
function wireResumeNoticeGestures(content) {
  const REVEAL = 64, OPEN_AT = 36;
  let startX = 0, startY = 0, dx = 0, revealed = false, dragging = false, horizontal = false;
  const place = x => { content.style.transform = `translateX(${x}px)`; };
  content.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    dx = 0; dragging = true; horizontal = false; content.style.transition = 'none';
  }, { passive: true });
  content.addEventListener('touchmove', e => {
    if (!dragging) return;
    dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!horizontal && Math.abs(dx) < Math.abs(dy)) { dragging = false; place(revealed ? -REVEAL : 0); return; }
    horizontal = true;
    place(Math.max(-REVEAL, Math.min(0, (revealed ? -REVEAL : 0) + dx)));
  }, { passive: true });
  content.addEventListener('touchend', () => {
    if (dragging) content.style.transition = '';
    dragging = false;
    // Only an actual HORIZONTAL swipe toggles the trash. A vertical-aborted gesture
    // (horizontal stays false) leaves dx at the aborting frame, so without this gate a
    // steep diagonal scroll could still reveal the trash — snap back to the current state.
    if (horizontal && dx < -OPEN_AT) { revealed = true; place(-REVEAL); }
    else if (horizontal && dx > OPEN_AT) { revealed = false; place(0); }
    else place(revealed ? -REVEAL : 0);   // a tap falls through to the click handler
  }, { passive: true });
  // Tap (no meaningful drag) restores; a closed-state click with the trash hidden also
  // restores. A swipe leaves |dx| large, so suppress the synthetic click it fires.
  content.addEventListener('click', () => {
    if (horizontal && Math.abs(dx) > 8) { dx = 0; return; }
    if (revealed) { revealed = false; place(0); return; }
    restoreSessionToView();
  });
}

// Show a banner when the previous session is restored. The owner can TAP it to bring the
// recovered workout into view, or SWIPE it to reveal a trash can and discard the session.
// (A saved workout never reaches here — see the post-write reset; restore is only for an
// unsaved, lost in-progress session.) Auto-hidden when clearSessionSnapshot fires.
function renderResumeNotice(setCount, sets) {
  const notice = typeof document !== 'undefined' ? document.getElementById('session-resume-notice') : null;
  if (!notice || !setCount) return;
  const exercises = [...new Set((sets || []).map(s => s.exercise).filter(Boolean))];
  let msg = `Session restored — ${setCount} set${setCount === 1 ? '' : 's'} logged`;
  if (exercises.length) {
    const preview = exercises.slice(0, 3).join(', ') + (exercises.length > 3 ? ', …' : '');
    msg += ` (${preview})`;
  }
  notice.innerHTML = '';
  // Trash layer sits behind the content; swiping the content left exposes it.
  const trash = el('button', { type: 'button', class: 'resume-trash', title: 'Discard restored session', 'aria-label': 'Discard restored session', text: '🗑' });
  // PR-H: the explicit trash discard of a restored session is an `abandoned` closeout
  // (emit before discardRestoredSession clears state; gated on an accepted plan). Kept
  // at the click site so discardRestoredSession stays pure for its eval-harness tests.
  trash.addEventListener('click', () => { emitPlanCloseout('abandoned'); discardRestoredSession(); });
  notice.appendChild(trash);
  // Content layer (slides). Tap to view the recovered workout.
  const content = el('div', { class: 'resume-content' }, [
    el('span', { class: 'resume-notice-text', text: msg }),
    el('span', { class: 'resume-hint', text: 'tap to view · swipe to discard' })
  ]);
  notice.appendChild(content);
  wireResumeNoticeGestures(content);
  notice.hidden = false;
}

// Restore a recent in-progress session on load. Defensive: a malformed/old snapshot
// is ignored (and cleared), never partially applied. Returns true when a session was
// resumed (caller re-renders the banner). Read-only restore — no network, no writes.
function restoreSessionSnapshot() {
  // The store reads + validates the snapshot (recency gate, malformed guard, and the
  // "only resume genuinely-LOGGED work" rule — a snapshot carrying ONLY an engaged
  // plan with no logged sets must NOT silently reactivate guided mode on the next app
  // open; that hijacks a fresh freestyle log with a phantom "1 of N / next up" from a
  // plan the lifter never re-engaged, owner live find 2026-07-03) and applies it to
  // the slice. It ALSO restores pendingSubstitution now (SESS-2). app.js does only the
  // DOM half: the session_id field, the resume notice, and re-arming guided mode.
  const res = hydrateSessionSnapshot();
  if (!res.resumed) return false;
  // Restore the stable session_id so re-preview after resume uses the same id.
  if (res.sessionId) {
    const sessionIdEl = typeof document !== 'undefined' ? document.getElementById('log-session-id') : null;
    if (sessionIdEl) sessionIdEl.value = res.sessionId;
  }
  const log = getSessionLog();
  renderResumeNotice(log.length, log);
  if (getActivePlannedSession()) { setCoachSuggestionEngaged(true); renderActiveSessionBanner(); }
  // Re-surface a restored replacement PROPOSAL — the plan was never half-mutated (nothing is
  // removed before approval), so a reload simply re-presents the SAME proposal against the
  // intact plan. Discard it (never apply) if the plan changed under it (stale fingerprint).
  const pending = getPendingReplacement();
  if (pending) {
    const AR = (typeof window !== 'undefined' && window.activeReplacement) || null;
    const planExercises = (getActivePlannedSession() && getActivePlannedSession().exercises) || [];
    if (AR && AR.isProposalFresh(pending, planExercises)) {
      renderReplacementProposal(pending);
    } else {
      setPendingReplacement(null);
      persistSessionSnapshot(res.sessionId || null);
    }
  }
  // Re-surface a restored SET-REVISION proposal the same way (#1189) — nothing was revised
  // before approval, so a reload simply re-presents the SAME proposal against the intact plan.
  // Discard it (never apply) if the plan version moved or the slot changed under it.
  const pendingRevision = getPendingSetRevision();
  if (pendingRevision) {
    const plan = getActivePlannedSession();
    if (isSetRevisionProposalFresh(pendingRevision, (plan && plan.exercises) || [], plan && plan.plan_version)) {
      renderSetRevisionProposal(pendingRevision);
    } else {
      setPendingSetRevision(null);
      persistSessionSnapshot(res.sessionId || null);
    }
  }
  return true;
}

// Warn before a refresh/close ONLY when there are logged sets not yet saved — so an
// accidental swipe/reload during a session can't silently drop unsaved work. No
// warning when nothing is logged (a fresh app or a just-saved session). Standard
// beforeunload contract: setting returnValue triggers the browser's native prompt.
function hasUnsavedSessionState() {
  return Array.isArray(getSessionLog()) && getSessionLog().length > 0;
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', e => {
    saveSessionSnapshot();                 // persist first so even "Leave" resumes
    if (hasUnsavedSessionState()) { e.preventDefault(); e.returnValue = ''; }
  });
  // Backgrounding the PWA (app switch / lock) is the common loss point on iOS —
  // snapshot on hide so a later force-quit still resumes.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSessionSnapshot(); });
}

// The planned exercises the lifter is working through, in the VISIBLE plan order,
// WITH their identity fields (name + canonical + liftCode). Source: a formally-
// started planned session if one exists, else the cached coach-suggested plan
// (lastIntentData's recommended intent). This is the single source of truth for
// post-log identity so every surface (sessionCompleted, plannedQueue, nextPlanned,
// handoff, composer, set-effort reroute) resolves a logged lift to the SAME
// planned name — whether or not the lifter tapped "Start Session".
function plannedExerciseEntries() {
  if (getActivePlannedSession() && getActivePlannedSession().exercises.length) {
    return getActivePlannedSession().exercises.map(ex => ({
      name: ex.canonicalName || ex.name,
      canonical: ex.canonicalName || ex.name,
      liftCode: ex.liftCode || '',
      // F10: carry the immutable slot identity so the completion selector keys on it
      // (present on an accepted plan; null for a chat/suggested plan → position-keyed).
      plan_item_id: ex.plan_item_id != null ? ex.plan_item_id : null,
      // F10S1: carry the prescribed set count — the selector's multiplicity rule
      // (one performed set must not complete a 3-set slot) reads it as requiredSets.
      sets: ex.sets != null ? ex.sets : null
    })).filter(e => e.name);
  }
  // A displayed home-screen suggestion is NOT an active plan: only treat
  // lastIntentData as the plan once the lifter has ENGAGED Coach's Pick. Without
  // this gate, a cold direct-composer log (no session started, no pick tapped) was
  // narrated as if mid-plan — "Moving on — next up: <suggested lift>" + composer
  // pre-fill + a phantom next_move_advisory. Freestyle / ad-hoc logging stays clean.
  if (!getCoachSuggestionEngaged()) return [];
  const intents = (lastIntentData && lastIntentData.intents) || [];
  const recommended = intents.find(i => i.recommended);
  const exs = recommended && Array.isArray(recommended.exercises) ? recommended.exercises : [];
  return exs.map(ex => ({
    name: ex.canonical_exercise || ex.exercise,
    canonical: ex.canonical_exercise || ex.exercise,
    liftCode: ex.lift_code || ex.liftCode || '',
    // F10S1: an engaged Coach's Pick carries its prescribed set count too, so the
    // multiplicity rule holds before "Start this plan" materializes the session
    // (a prescribed 3-set pick logged directly must not complete on one set).
    sets: ex.target_sets != null ? ex.target_sets : (ex.sets != null ? ex.sets : null)
  })).filter(e => e.name);
}

// The ordered exercise names (visible plan order). Unchanged contract — the names
// are exactly what currentPlanForChat / resolveCompletedIdentity emit.
function plannedExerciseOrder() {
  return plannedExerciseEntries().map(e => e.name);
}

// The planned exercises (visible order) NOT yet completed this session — the ONE
// shared "remaining after this log" source for nextPlanned, the bare-set attach
// target, and the set-effort reroute queue, so they can never disagree. Completion
// identity is normalized by resolveCompletedIdentity, so a logged alias
// ("Dips (Weighted)" / "Lat pull") is matched to its planned name
// ("Weighted Dip" / "Lat Pulldown") and correctly excluded.
// F10: the plan shape the completion selector reads — the unified planned entries
// (started session OR engaged Coach's Pick, each carrying its plan_item_id when
// accepted) plus the accepted items[] that hold the authoritative explicit-outcome
// lane (Done/skip). One builder so every routed surface reads the SAME plan.
function activePlanForSlots() {
  const sess = getActivePlannedSession();
  return {
    exercises: plannedExerciseEntries(),
    items: sess && Array.isArray(sess.items) ? sess.items : [],
  };
}

function remainingPlannedExercises() {
  // F10 — route through the ONE authoritative selector: pending slot names, keyed by
  // plan_item_id + slot position. Duplicate names stay slot-distinct (one logged set
  // never clears every same-named slot), a recognized substitution/variant satisfies
  // its original slot, and an ambiguous substring leaves the slot unresolved.
  // F10S1 — the per-set log engages the multiplicity rule: a slot below its required
  // set count stays remaining (in progress), so next-up holds on it.
  return remainingSlotNames(activePlanForSlots(), getSessionCompleted(), getSessionLog());
}

function isPlanCloseoutAwaitingSave() {
  return getSessionLog().length > 0 &&
    plannedExerciseOrder().length > 0 &&
    remainingPlannedExercises().length === 0;
}

// RC2 (FB closeout date): the vision parser returns a screenshot date ONLY when it
// is visible and unambiguous (strict YYYY-MM-DD), else null — so a present, valid ISO
// date is a "confident" signal. Anything else is treated as absent (→ today fallback).
function isConfidentScreenshotDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const d = new Date(`${value.trim()}T00:00:00`);
  if (Number.isNaN(d.getTime()) || getLocalDateString(d) !== value.trim()) return false;
  // Plausibility window (live incident 07-02: the vision model weekday-matched a
  // yearless "June 28" header to 2020 — a valid-looking date with an invented year).
  // Mirrors the server guard: ≤2 days ahead, ≤400 days back; outside → not confident
  // → today-fallback + the visible warning, never silently used.
  const today = new Date(`${getLocalDateString()}T00:00:00`);
  const diffDays = (d.getTime() - today.getTime()) / 86400000;
  return diffDays <= 2 && diffDays >= -400;
}

// Resolve the workout date for a closeout SAVE carrying an Apple Watch screenshot.
// Priority: an EXPLICITLY-entered manual date wins; else a confidently-parsed
// screenshot date wins; else fall back to today (flagged so the preview warns). The
// chosen date is authoritative for the log rows, session_id, effort row, and preview
// copy so they can never disagree (the "July 27 screenshot saved as today" bug).
// Returns { date, source } with source ∈ manual | screenshot | today_fallback.
function resolveCloseoutWorkoutDate({ manualDate, manualEntered, screenshotDate, today }) {
  if (manualEntered && typeof manualDate === 'string' && manualDate.trim()) {
    return { date: manualDate.trim(), source: 'manual' };
  }
  if (isConfidentScreenshotDate(screenshotDate)) {
    return { date: screenshotDate.trim(), source: 'screenshot' };
  }
  return { date: today, source: 'today_fallback' };
}

// Shared date-source notice for the save preview (used by both the log-workout and
// complete-workout previews) — keeps the copy identical wherever a date is resolved.
function renderDateSourceNotice(source, date) {
  if (!date) return null;
  if (source === 'today_fallback') {
    const warn = el('div', { class: 'preview-warnings preview-date-warning' }, [
      '⚠️ Date not found in screenshot — saving as ',
      el('strong', { text: date }),
      ' (today). If this workout is from a different day, change the date field above and preview again.'
    ]);
    return warn;
  }
  if (source === 'screenshot') {
    return el('div', { class: 'preview-ok preview-date-source', text: `Date from screenshot: ${date}` });
  }
  if (source === 'manual') {
    return el('div', { class: 'preview-ok preview-date-source', text: `Date (manual): ${date}` });
  }
  return null;
}

function effortRowFromParsedEffort(effort, sessionId, date, location, notes) {
  if (!effort) return null;
  return {
    date,
    session_id: sessionId,
    duration: effort.duration,
    active_calories: effort.activeCalories,
    total_calories: effort.totalCalories,
    average_hr: effort.averageHR,
    peak_hr: effort.peakHR,
    location: location || '',
    notes: notes || ''
  };
}

// Resolve a lift_code for an exercise NAME from the loaded catalog datalist
// (option value = canonical_name, label = lift_code). This lets completion bridge
// a logged catalog canonical ("Dips (Weighted)") to a planned lift BY CODE without
// any network call — so conversational logging issues NO preview request (the
// mid-session no-write guardrail stays intact). Empty string when unresolved.
function liftCodeFromCatalog(name) {
  if (!name || typeof document === 'undefined') return '';
  const dl = document.getElementById('exercise-catalog');
  if (!dl) return '';
  const key = String(name).toLowerCase();
  const opt = Array.from(dl.options || []).find(o => (o.value || '').toLowerCase() === key);
  return opt ? (opt.label || '') : '';
}

// The first planned exercise (visible order) not yet logged this session — the
// lift a bare set sequence ("140 15 190 10 230 4/2…") should attach to when the
// lifter names no exercise, and the next-up handoff target. Null when there's no
// plan (started OR suggested) or it's complete. Shared by emitSetLogged's next-up
// and the parse context. Read-only — never changes what gets written or how.
function firstUnloggedPlannedLift() {
  return remainingPlannedExercises()[0] || null;
}

// Composer-first Phase A — the session header pin: the ONE persistent piece of
// in-workout UI (current lift · sets done · next up). Derived from the SAME
// canonical selectors the plan card and handoff read (firstUnloggedPlannedLift /
// remainingPlannedExercises / the sessionLog buffer), so it can never disagree
// with them. Display-only. Guided sessions show the next planned lift; freestyle
// deliberately omits "next" (B9 — the Next UI stays quiet during freestyle):
// the pin then shows only the last logged lift and the running set count.
// Hidden whenever nothing is in progress; the atlas:session-reset listener and
// the emitSetLogged/banner hooks keep it in lockstep with the session state.
function renderSessionPin() {
  const pin = document.getElementById('session-pin');
  if (!pin) return;
  const setsDone = getSessionLog().length;
  const planned = plannedExerciseOrder();
  const guided = planned.length > 0;
  if (!setsDone && !guided) { pin.hidden = true; pin.textContent = ''; return; }
  const remaining = guided ? remainingPlannedExercises() : [];
  // F10S4 (owner smoke 2026-07-18) — the pin shows sets completed for the CURRENT
  // PLANNED ITEM only, never the whole session (the failure: "Back Squat · 4 sets
  // in" after 1 RDL + 3 Front Squat sets). Identity AND count come from the same
  // selector verdict every other surface reads (firstUnloggedSlot → performedSets/
  // requiredSets). Freestyle (no plan) keeps the session total — there is no
  // planned item to attribute to.
  const currentSlot = guided
    ? firstUnloggedSlot(activePlanForSlots(), getSessionCompleted(), getSessionLog())
    : null;
  const current = guided
    ? ((currentSlot && currentSlot.name) || remaining[0] || planned[planned.length - 1])
    : (setsDone ? getSessionLog()[getSessionLog().length - 1].exercise : null);
  const next = guided && remaining.length > 1 ? remaining[1] : null;
  const itemSets = currentSlot ? (currentSlot.performedSets || 0) : setsDone;
  const setsText = currentSlot
    ? (currentSlot.requiredSets != null
      ? `${itemSets} of ${currentSlot.requiredSets} sets`
      : `${itemSets} set${itemSets === 1 ? '' : 's'} in`)
    : `${setsDone} set${setsDone === 1 ? '' : 's'} in`;
  pin.textContent = '';
  if (current) pin.appendChild(el('span', { class: 'pin-lift', text: String(current) }));
  pin.appendChild(el('span', { class: 'pin-sets', text: setsText }));
  if (next) pin.appendChild(el('span', { class: 'pin-next', text: `next: ${next}` }));
  // The pin is the tap target for the collapsed plan card (dropdown) whenever a
  // live session exists. Wired once — the element persists across re-renders.
  const expandable = Boolean(getActivePlannedSession());
  if (expandable) {
    pin.appendChild(el('span', { class: 'pin-chevron', text: getSessionChromeExpanded() ? '\u25B4' : '\u25BE' }));
    pin.setAttribute('role', 'button');
    pin.tabIndex = 0;
    pin.setAttribute('aria-expanded', String(getSessionChromeExpanded()));
    pin.setAttribute('aria-controls', 'active-session-banner');
    pin.title = 'Session controls';
    if (!pin.dataset.chromeWired) {
      pin.dataset.chromeWired = '1';
      const toggle = () => {
        if (!getActivePlannedSession()) return;
        setSessionChromeExpanded(!getSessionChromeExpanded());
        renderActiveSessionBanner();
      };
      pin.addEventListener('click', toggle);
      pin.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
  } else {
    pin.removeAttribute('role');
    pin.removeAttribute('aria-expanded');
    pin.tabIndex = -1;
  }
  pin.hidden = false;
}

// Returns the currently-active planned exercise (first unlogged) with prescription
// details. Uses the canonical session to determine which exercise is current so
// the stale `activePlannedSession.index` cursor (which lags after a logged set
// until "Next exercise →" is clicked) never drives a substitute check or plan-step
// payload. Falls back to the index-based entry when activeSession is unavailable.
// (P0 PR 2 — docs/ACTIVE_SESSION_STATE_DIAGNOSIS.md)
function currentPlannedExercise() {
  if (!getActivePlannedSession() || !Array.isArray(getActivePlannedSession().exercises)) return null;
  const AS = (typeof window !== 'undefined' && window.activeSession) ||
             (typeof activeSession !== 'undefined' ? activeSession : null);
  if (!AS) {
    // activeSession module unavailable — fall back to index-based entry so
    // advancePlannedSession() doesn't silently end the session.
    return getActivePlannedSession().exercises[getActivePlannedSession().index] || null;
  }
  const canon = getCanonicalSession();
  const cur = canon && AS.currentExercise(canon);
  if (!cur) return null; // all exercises logged — caller (advancePlannedSession) ends session correctly

  // Step 379 guard: if the lifter declared a swap for this exact exercise
  // (pendingSubstitution is set and the prescribed name matches the canonical current),
  // the swap hasn't been applied yet (emitSetLogged applies it at log time), so
  // sessionCompleted still excludes the swapped-out lift — meaning the canonical session
  // would keep returning it as "current" on every subsequent message. Skip it here and
  // peek at the next unswapped remaining exercise instead, so substitute checks and the
  // plan payload always send the actual next-up lift, not the declared-taken one.
  let name = cur.name;
  if (getPendingSubstitution()) {
    const prescKey = (getPendingSubstitution().prescribed || '').toLowerCase();
    if (prescKey && name.toLowerCase() === prescKey) {
      const nextName = remainingPlannedExercises().find(n => n.toLowerCase() !== prescKey);
      if (!nextName) return null;
      name = nextName;
    }
  }

  const key = name.toLowerCase();
  return getActivePlannedSession().exercises.find(
    ex => (ex.canonicalName || ex.name || '').toLowerCase() === key
  ) || { name, liftCode: cur.liftCode || '', canonicalName: name };
}

// Editor-ready rows from the buffer, numbering sets per exercise.
// F06 / CLIENT-2: fold the lifter's hand-edits in the preview table back into the session
// buffer so they stay authoritative when the table is rebuilt from that buffer (e.g. at the
// next closeout, after another set is logged). Rows map to buffer entries the SAME way
// buildRowsFromSessionLog numbers them — by exercise + per-exercise occurrence order — and
// only a field the lifter actually changed (data-user-edited) overwrites the buffer. Inert
// when nothing was hand-edited, so the parser-driven flow is unchanged.
// Stable id for a manually-added ("+ Add set") row, so folding it into the session
// buffer is idempotent across repeated reconciles before a rebuild.
let manualRowSeq = 0;

function reconcileSessionLogFromTable() {
  const rows = setsTableBody && setsTableBody.children;
  if (!rows || !rows.length) return;
  const buffer = (typeof getSessionLog === 'function') ? getSessionLog() : null;
  if (!buffer || !buffer.length) return;
  const byExercise = new Map();
  const byManualId = new Map();
  for (const entry of buffer) {
    if (entry && entry._manualId) byManualId.set(String(entry._manualId), entry);
    const key = String(entry.exercise || '').trim().toLowerCase();
    if (!byExercise.has(key)) byExercise.set(key, []);
    byExercise.get(key).push(entry);
  }
  const cursor = new Map();
  const val = (tr, cls) => { const input = tr.querySelector(cls); return input ? input.value : ''; };
  const FIELDS = [['.set-exercise', 'exercise'], ['.set-weight', 'weight'], ['.set-reps', 'reps'], ['.set-rir', 'rir'], ['.set-notes', 'notes']];
  for (const tr of rows) {
    if (!tr || typeof tr.querySelector !== 'function') continue;
    // A manually-added row already folded on an earlier pass re-matches by its stable id
    // (so it is never folded twice); a manual row is fully authoritative — take all fields.
    const manualId = (tr.dataset && tr.dataset.manualId) || '';
    if (manualId && byManualId.has(manualId)) {
      const entry = byManualId.get(manualId);
      for (const [cls, field] of FIELDS) entry[field] = val(tr, cls);
      continue;
    }
    // Match on the name the row was BUILT with (its buffer key), NOT the current input value
    // — otherwise a renamed exercise misses its entry and every edit on that row is dropped.
    const origin = (tr.dataset ? tr.dataset.originExercise : undefined) ?? tr.querySelector('.set-exercise')?.value;
    const key = String(origin || '').trim().toLowerCase();
    const list = byExercise.get(key);
    const i = cursor.get(key) || 0;
    const entry = list ? list[i] : null;
    if (entry) {
      cursor.set(key, i + 1);
      // Exercise is preserved too (the unknown-lift "check the name" flow depends on it).
      for (const [cls, field] of FIELDS) {
        const input = tr.querySelector(cls);
        if (input && input.dataset.userEdited === '1') entry[field] = input.value;
      }
      continue;
    }
    // No buffer entry AND the row was built with no origin exercise → a manually-added
    // ("+ Add set") row (parser / buffer-rebuilt / copy-last-session rows all carry their
    // origin name). Fold it into the session buffer with a stable id so it survives the
    // rebuild and reaches the write — otherwise a hand-added row is silently dropped the
    // next time the table rebuilds from the buffer. Only a row with real content (a named
    // exercise + a weight or reps) is folded; a blank scaffold is ignored (collectLogRows
    // skips it too). This makes the added row authoritative pending-session state BEFORE
    // any rebuild, matched by stable id rather than list position.
    const builtEmpty = tr.dataset && tr.dataset.originExercise === '';
    const exercise = val(tr, '.set-exercise').trim();
    if (builtEmpty && exercise && (val(tr, '.set-weight') !== '' || val(tr, '.set-reps') !== '')) {
      const id = manualId || `manual-${++manualRowSeq}`;
      if (tr.dataset) tr.dataset.manualId = id;
      buffer.push({ exercise, weight: val(tr, '.set-weight'), reps: val(tr, '.set-reps'), rir: val(tr, '.set-rir'), notes: val(tr, '.set-notes'), _manualId: id });
    }
  }
}

// ⚠️ CLOSEOUT RECONSTRUCTION LANE — RECOVERY-ONLY; VERIFY EVERY ROW (H-17; Phase 2 paper-hygiene label).
// Rebuilds the editable preview table from the sessionLog buffer at closeout. This RECONSTRUCTS
// what was logged rather than capturing it fresh, so a buffer/table divergence can silently revert
// or mislabel a row (the CLIENT-2 defect) — every reconstructed row must be verified against the
// buffer (reconcileSessionLogFromTable() folds hand-edits back BEFORE any rebuild) before the
// preview→approve→write loop reads it. This lane is retired once buffer capture is proven
// (Phase 5g; ownership inventory "closeout adapt").
function buildRowsFromSessionLog() {
  const counts = new Map();
  return getSessionLog().map(s => {
    const n = (counts.get(s.exercise) || 0) + 1;
    counts.set(s.exercise, n);
    // Carry a folded manual row's stable id across the rebuild so its ✕ removal can still
    // drop the matching buffer entry (otherwise a removed manual set would resurrect).
    return { exercise: s.exercise, set_number: String(n), weight: s.weight, reps: s.reps, rir: s.rir, notes: s.notes || '', _manualId: s._manualId };
  });
}

// Ordered, de-duplicated exercise names from a set-buffer ([{exercise,…}]). Pure —
// preserves first-seen order, drops blanks/dupes. Used to recap what was logged.
function orderedUniqueExercises(rows) {
  const seen = new Set();
  const out = [];
  for (const s of (Array.isArray(rows) ? rows : [])) {
    const name = s && s.exercise != null ? String(s.exercise).trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// A read-only "already saved this session" recap for the confirm/review card, so a
// closeout after a mid-workout save still shows the earlier, already-saved
// exercises. Returns null when nothing was saved yet this workout. DISPLAY ONLY —
// these names never enter a write payload; the write is the previewed buffer.
function renderSavedThisSessionRecap() {
  const names = orderedUniqueExercises(getSessionSavedLog());
  if (!names.length) return null;
  return el('div', { class: 'saved-this-session muted small' }, [
    el('span', { text: `Already saved this session: ${names.join(', ')} ✓` })
  ]);
}

// Resolve the best stable identity for plan_completed tracking against the ACTIVE
// plan source (a started session OR the coach-suggested plan — plannedExerciseEntries),
// so completion is recognized in BOTH flows. Returns the planned name exactly as
// plannedExerciseOrder / currentPlanForChat emit it, so the server's name-based
// computePlanState and the client's remaining-queue filter both match.
// Priority:
//   1. lift_code match (authoritative catalog identity from the enrichment row)
//   2. canonical_exercise exact match → planned canonical/display name
//   3. raw-name alias/contains match (mirrors planStepFor / getNextExerciseInPlan)
//      so "Lat pull" → "Lat Pulldown" and "Weighted dips" → "Weighted Dip" resolve
//   4. fall back to the raw logged exercise name
function resolveCompletedIdentity(rawName, enrichmentRow) {
  const entries = plannedExerciseEntries();
  if (entries.length) {
    // lift_code is the reliable bridge across naming differences ("Dips (Weighted)"
    // vs planned "Weighted Dip"). Prefer the enrichment's code (started flow);
    // otherwise resolve it from the catalog datalist by the logged canonical / raw
    // name — no network call, so conversational logging issues no preview request.
    const loggedCode = (enrichmentRow && enrichmentRow.lift_code)
      || liftCodeFromCatalog(enrichmentRow && enrichmentRow.canonical_exercise)
      || liftCodeFromCatalog(rawName)
      || '';
    if (loggedCode) {
      const codeKey = String(loggedCode).toLowerCase();
      // TWO-SIDED code bridge (owner live find 2026-07-03): a chat-created plan
      // carries no lift codes, so resolve the ENTRY's code from the catalog too
      // — "Rdl" (RDL01 via the variant-aware datalist) must reach the plan slot
      // "Romanian Deadlift" (RDL01 via its canonical name) even when the
      // best-effort enrichment call never returned.
      const match = entries.find(e => {
        const entryCode = e.liftCode || liftCodeFromCatalog(e.canonical) || liftCodeFromCatalog(e.name) || '';
        return entryCode && entryCode.toLowerCase() === codeKey;
      });
      if (match) return match.name;
    }
    const canonical = (enrichmentRow && enrichmentRow.canonical_exercise) || '';
    if (canonical) {
      const key = canonical.toLowerCase();
      const match = entries.find(e => e.canonical.toLowerCase() === key || e.name.toLowerCase() === key);
      if (match) return match.name;
    }
    const rk = String(rawName || '').toLowerCase();
    if (rk) {
      // F10 / SESS-5: exact name outranks any substring, and an ambiguous alias
      // REFUSES to guess. A logged name aliases a slot only as an ABBREVIATION
      // contained in it ("Lat pull" ⊂ "Lat Pulldown") or as a recognized equipment/
      // angle VARIANT of it ("Incline Dumbbell Flyes" → "Dumbbell Flyes"); the
      // movement-crossing reverse direction ("Romanian Deadlift" over a bare
      // "Deadlift" slot) is NOT an alias and never resolves. Each tier attributes
      // only when EXACTLY ONE planned entry matches — otherwise it falls through to
      // the raw name (leaving the completion for the slot selector to refuse too).
      const exact = entries.find(e => e.name.toLowerCase() === rk);
      if (exact) return exact.name;
      const aliasable = entries.filter(e => {
        const n = e.name.toLowerCase();
        return n.includes(rk) || variantSatisfies(rk, n);
      });
      if (aliasable.length === 1) return aliasable[0].name;
      // Word-subset tier (mirrors planMutationIntent's resolver): every word of
      // the logged name present in the slot name, two-word minimum — bridges
      // "single leg press" → "Single-Leg Seated Leg Press" without codes. Same
      // unique-only refusal so an ambiguous multi-word alias never guesses.
      const words = s => new Set(String(s).toLowerCase().replace(/[-/]+/g, ' ').split(/\s+/)
        .map(w => (/[^s]s$/.test(w) ? w.slice(0, -1) : w)).filter(Boolean));
      const rawWords = [...words(rk)];
      if (rawWords.length >= 2) {
        const wsubs = entries.filter(e => {
          const ew = words(e.name);
          return rawWords.every(w => ew.has(w));
        });
        if (wsubs.length === 1) return wsubs[0].name;
      }
    }
  }
  return rawName;
}

function emitSetLogged(logObjs, text, substitutions, enrichment) {
  const byExercise = [];
  const seen = new Map();
  // Build a lookup from raw exercise name → enrichment row for identity resolution.
  const enrichMap = new Map();
  if (Array.isArray(enrichment)) {
    for (const e of enrichment) { if (e && e.exercise) enrichMap.set(e.exercise, e); }
  }
  // Step 373b: if a swap was declared for the current step, the first logged
  // exercise is the substitute — apply it to the live session BEFORE resolving
  // completed identities, so the substitute (not the swapped-out lift) is what
  // gets marked done and what leaves remaining.
  if (getPendingSubstitution() && getActivePlannedSession() && Array.isArray(logObjs) && logObjs.length && logObjs[0].exercise) {
    const primaryRaw = logObjs[0].exercise;
    const enr = enrichMap.get(primaryRaw) || {};
    applySessionSubstitution(getPendingSubstitution().prescribed, enr.canonical_exercise || primaryRaw, enr.lift_code || '', getPendingSubstitution().prescription || null);
    setPendingSubstitution(null);
  }
  for (const o of (logObjs || [])) {
    if (!o.exercise) continue;
    if (!seen.has(o.exercise)) { const g = { exercise: o.exercise, sets: [] }; seen.set(o.exercise, g); byExercise.push(g); }
    seen.get(o.exercise).sets.push({
      weight: o.weight,
      reps: o.reps,
      rir: (o.rir === '' || o.rir == null) ? null : Number(o.rir)
    });
    // Track the best available planned identity for plan_completed wiring so the
    // server's name-based computePlanState can mark the exercise as done even
    // when the logged canonical name differs from the plan entry name.
    const completedName = resolveCompletedIdentity(o.exercise, enrichMap.get(o.exercise));
    // Accumulate the raw set into the session buffer for the end-of-session save.
    // F10S1: the row also carries its RESOLVED identity (`canonical`) — the only moment
    // it is known — so per-slot set COUNTING can match alias-form raw rows ("RDL") to
    // their planned identity ("Romanian Deadlift"). Additive field; the save/editor
    // paths map explicit fields and ignore it.
    getSessionLog().push({ exercise: o.exercise, canonical: completedName, weight: o.weight, reps: o.reps, rir: o.rir, notes: o.notes || '' });
    if (!getSessionCompleted().includes(completedName)) getSessionCompleted().push(completedName);
  }
  // F10C — an exercise logged that is NOT on the accepted plan (and not the declared
  // substitution applied above, which now IS a slot) is UNANNOUNCED: form an independent
  // implicit recommendation for it (leakage-safe, derived server-side, dry-run). Driven
  // ONLY by a logged off-plan exercise — never for a planned slot or a substitute.
  {
    const plan = getActivePlannedSession();
    if (plan && plan.accepted === true) {
      for (const g of byExercise) {
        const enr = enrichMap.get(g.exercise) || {};
        const canonical = enr.canonical_exercise || g.exercise;
        const code = enr.lift_code || '';
        if (code && isOffPlanLoggedExercise(plan, canonical, code)) emitImplicitRecommendation(canonical, code);
      }
    }
  }
  if (byExercise.length) {
    const loggedSessionId = ((logObjs || [])
      .find(o => o && typeof o.session_id === 'string' && o.session_id.trim())
      ?.session_id || '').trim();
    // ADD-5: a set was just logged — the just-logged lift is the fresh focus again,
    // so an immediate demonstrative correction re-identifies IT (fast path restored).
    setCoachDiscussionSinceLog(false);
    try {
      // nextPlanned (the handoff/composer target) and plannedQueue (the set-effort
      // reroute queue) derive from the SAME remaining-after-this-log source, so the
      // handoff, composer placeholder, and reroute can never disagree — and a lift
      // just completed (under any alias) is never re-offered or deferred.
      // Read-only narration; suggestion-only — it never reorders or mutates the plan.
      const remaining = remainingPlannedExercises();
      const nextPlanned = remaining[0] || null;
      const plannedQueue = remaining;
      // Plan complete = a plan exists (started OR coach-suggested) and nothing
      // remains. Derive it from the SAME remaining state as nextPlanned so the two
      // can't disagree. The old check only consulted activePlannedSession, so in the
      // coach-suggestion flow (activePlannedSession === null) it was ALWAYS false —
      // after the last logged lift the closeout never fired and the handoff fell
      // through to the divergent getNextExerciseInPlan fallback, resurrecting an
      // already-completed lift (the live "wanted weighted dips again" bug).
      // keep in sync with computeCloseout in services/sessionCloseout.js
      const planIsComplete = plannedExerciseOrder().length > 0 && remaining.length === 0;
      document.dispatchEvent(new CustomEvent('atlas:set-logged', {
        detail: {
          exercises: byExercise,
          text: text || '',
          ...(loggedSessionId ? { sessionId: loggedSessionId } : {}),
          planIsComplete,
          nextPlanned,
          // The completed-lift names this session, so the handoff's /api/plan/today
          // fallback can reject a next-up that's already done (its order can diverge
          // from what was actually logged — the source of the resurrected lift).
          completed: [...getSessionCompleted()],
          // The engaged plan's exercise order (active session OR engaged Coach's Pick;
          // empty when freestyling). The handoff uses it to reject a fallback next-up
          // that isn't part of today's session — so the /api/plan/today lookup can't
          // surface a stored-program lift the lifter isn't following (the live
          // "next up: Hammer Curls" that wasn't in the plan, and the off-plan lift that
          // overrode the closeout once the engaged plan was already complete).
          plannedOrder: plannedExerciseOrder(),
          ...(plannedQueue.length ? { plannedQueue } : {}),
          ...(Array.isArray(substitutions) && substitutions.length ? { substitutions } : {}),
          // Card/advisory consistency (owner 07-02): the parser-unrecognized name (if
          // any) so the confirmation card marks it "check name" instead of a bare ✓.
          ...(lastUnverifiedExercise ? { unverified: lastUnverifiedExercise } : {})
        }
      }));
    } catch { /* narration is optional */ }
  }
  // The session lives in the buffer (sessionLog) above, not the parsed-rows
  // editor — clear the transient rows so the end-of-session save rebuilds the
  // FULL session from the buffer.
  // F06 / CLIENT-2: preserve any hand-edits still in the table before wiping it (belt-and-
  // suspenders for log paths that reach here without a reparse). Inert when nothing was edited.
  reconcileSessionLogFromTable();
  if (setsTableBody) setsTableBody.innerHTML = '';
  if (parsedRowsEditor) parsedRowsEditor.hidden = true;
  // Every logged set refreshes the session pin (current lift · sets in · next).
  renderSessionPin();
  lastParsedWorkoutText = '';
  invalidatePreview();
  // B2 canonical state — a logged set advanced the canonical session, so refresh the
  // plan card to the new current step (syncPlannedIndexToCanonical) instead of leaving
  // it stuck on the just-logged lift. Guarded for the emit test harness.
  if (typeof renderActiveSessionBanner === 'function') renderActiveSessionBanner();
  // persist the just-logged set for resume safety (guarded for the emit test harness)
  if (typeof saveSessionSnapshot === 'function') saveSessionSnapshot();
}

// `justLoggedSet` (optional) anchors the recommendation on the set the lifter
// just logged — under session-level save it isn't in the sheet yet, so without
// it the recommendation reflects the PREVIOUS session. Other callers (preview,
// post-write) omit it and get the history-only recommendation, unchanged.
async function fetchReaction(liftCode, justLoggedSet) {
  if (!liftCode || !isConnected()) return null;
  try {
    const params = new URLSearchParams();
    // Thread the active plan intent (e.g. 'recovery_pump' / 'deload_reset') so the
    // engine's reaction AND the next-set prescription flip on a recovery day — an
    // easy/high-RIR set reads on-plan, not "add weight". Sourced via getActiveIntentId
    // so an engaged-but-unmaterialized Coach's Pick still carries its intent
    // (BUG-20260629-204817).
    const intentId = getActiveIntentId();
    if (intentId) params.set('intentId', intentId);
    if (justLoggedSet && justLoggedSet.weight != null && justLoggedSet.reps != null) {
      params.set('w', String(justLoggedSet.weight));
      params.set('reps', String(justLoggedSet.reps));
      if (justLoggedSet.rir != null && justLoggedSet.rir !== '') params.set('rir', String(justLoggedSet.rir));
    }
    const qs = params.toString();
    const path = `/api/recommend/next/${encodeURIComponent(liftCode)}${qs ? `?${qs}` : ''}`;
    const res = await api(path);
    return res.data || null;
  } catch {
    return null;
  }
}

// Constraint detection: call the substitute endpoint and dispatch the result.
// Returns true when a recommendation card was dispatched, false otherwise.
// Callers use the return value to decide whether to fall back to the coach route
// — the coach is suppressed only when a card was actually rendered, so an
// exercise not in the ~14-entry catalog still gets a coach reply.
async function checkAndSuggestSubstitute(text) {
  const submitSeq = typeof previewRequestSeq === 'number' ? previewRequestSeq : null;
  if (!text || !getActivePlannedSession() || !getActivePlannedSession().exercises.length) return false;
  // Canonical current exercise; the index can lag after a logged set.
  const currentEx = currentPlannedExercise();
  if (!currentEx || !currentEx.name || !isConnected()) return false;
  try {
    const res = await api('/api/suggest-substitute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, current_exercise: currentEx.name })
    });
    if (submitSeq !== null && submitSeq !== previewRequestSeq) return false;
    const rec = res && res.data && res.data.recommendation;
    if (rec) {
      // Step 373b / AC3: record the prescribed lift and target before moving the cursor.
      setPendingSubstitution({ prescribed: currentEx.canonicalName || currentEx.name,
        prescription: rec.next_target || null });
      // Step 379: move past the taken slot without clearing the deferred swap; clamp at the end.
      if (getActivePlannedSession().index < getActivePlannedSession().exercises.length - 1) {
        getActivePlannedSession().index += 1;
        renderActiveSessionBanner();
      }
      document.dispatchEvent(new CustomEvent('atlas:substitute-suggested', {
        detail: { prescribed: currentEx.name, ...rec }
      }));
      return true;
    }
  } catch { /* best-effort */ }
  return false;
}

// Did the just-saved session set a PR for this lift? Reads the fresh PR list
// (which already includes the rows we just wrote) and matches each best set's
// session_id to the session we saved. Read-only and best-effort — any failure
// just yields no PR label.
async function fetchSessionPrLabel(liftCode, sessionId) {
  if (!liftCode || !sessionId || !isConnected()) return '';
  try {
    const res = await api('/api/prs/recent');
    const prs = res.data?.prs || [];
    const code = String(liftCode).toUpperCase();
    const pr = prs.find(p => String(p.liftCode || '').toUpperCase() === code);
    if (!pr) return '';
    if (pr.bestWeightSet?.session_id === sessionId) return `weight PR at ${pr.bestWeightSet.weight} lb`;
    if (pr.bestEstimated1RMSet?.session_id === sessionId) return 'estimated 1RM PR';
    if (pr.bestRepSet?.session_id === sessionId) return `rep PR — ${pr.bestRepSet.reps} @ ${pr.bestRepSet.weight} lb`;
    return '';
  } catch {
    return '';
  }
}

// Is this lift currently flagged as stalled? Read-only and best-effort.
async function fetchStall(liftCode) {
  if (!liftCode || !isConnected()) return null;
  try {
    const res = await api('/api/stalls');
    const stalls = res.data?.stalls || [];
    const code = String(liftCode).toUpperCase();
    return stalls.find(s => String(s.liftCode || '').toUpperCase() === code) || null;
  } catch {
    return null;
  }
}

// Attach best-effort PR + stall context to a recommendation so buildVerdict can
// rank them above the trend signals. Read-only; any failure simply leaves the
// fields empty and the verdict falls back to the trend/fallback lines.
async function attachVerdictContext(rec, liftCode, sessionId) {
  const [prLabel, stall] = await Promise.all([
    fetchSessionPrLabel(liftCode, sessionId),
    fetchStall(liftCode)
  ]);
  rec.prLabel = prLabel;
  rec.stall = stall;
  return rec;
}

async function verifyWrittenRange(range, sessionId, expectedRows) {
  if (!range || !sessionId || !isConnected()) return false;
  try {
    const params = new URLSearchParams({ range, session_id: sessionId });
    if (expectedRows) params.set('expected_rows', String(expectedRows));
    const res = await api(`/api/log-workout/verify-range?${params}`);
    return res?.data?.verified === true;
  } catch {
    return false;
  }
}

function renderAtlasSuggestion(rec) {
  if (!rec || !rec.next_target || !rec.last_working_sets || !rec.last_working_sets.length) return null;
  const lastSet = rec.last_working_sets[rec.last_working_sets.length - 1];
  const target = rec.next_target;
  const lastLabel = lastSet.rir != null ? `${formatSetLoad(lastSet.weight, lastSet.reps)} @${lastSet.rir}` : formatSetLoad(lastSet.weight, lastSet.reps);
  const targetLabel = `${target.weight} × ${target.reps} × ${target.sets}`;
  const rows = [
    ['Last', lastLabel],
    ['Target', targetLabel],
  ];
  if (rec.reasoning) rows.push(['Why', rec.reasoning]);
  const sessionNote = rec.sessions_analyzed ? ` · ${rec.sessions_analyzed} sessions` : '';
  return el('div', { class: 'atlas-suggestion' }, [
    el('div', { class: 'suggestion-header', text: `Atlas — ${rec.liftCode}${sessionNote}` }),
    ...rows.map(([label, value]) => el('div', { class: 'suggestion-row' }, [
      el('span', { class: 'suggestion-label', text: label }),
      el('span', { text: value }),
    ])),
  ]);
}

// Pull the previewed sets for one lift code out of the 12-column preview rows.
// Columns: 5 lift_code · 7 weight · 8 reps · 9 rir.
function previewSetsForLift(rows, liftCode) {
  const code = String(liftCode).toUpperCase();
  return (rows || [])
    .filter(r => String(r[5] || '').toUpperCase() === code)
    .map(r => ({
      weight: Number(r[7]),
      reps: Number(r[8]),
      rir: r[9] === '' || r[9] == null ? null : Number(r[9])
    }));
}

// Deterministic "are these previewed sets progress?" hint, comparing today's
// top set to last session's top set and the recommended next target.
function previewProgressHint(todayTopWeight, lastSet, target) {
  if (!lastSet || !Number.isFinite(lastSet.weight)) {
    return 'first time logging this — sets your baseline';
  }
  if (!Number.isFinite(todayTopWeight) || todayTopWeight <= 0) return null;
  const diff = Math.round((todayTopWeight - lastSet.weight) * 10) / 10;
  if (diff > 0) return `above last session (+${diff} lb)`;
  if (diff === 0) {
    return target && Number.isFinite(target.weight) && target.weight > todayTopWeight
      ? 'matching last top set — clear your reps/RIR to earn the next jump'
      : 'matching last top set';
  }
  return `below last top set (${lastSet.weight} lb)`;
}

// One compact per-exercise coaching card for the preview: last session's top
// set and a plain-English coaching hint. Read-only.
function renderPreviewCoachCard(rec, liftCode, todaySets) {
  if (!todaySets || !todaySets.length) return null;
  const name = (rec && rec.exercise_name) || liftCode;
  const lastSets = (rec && rec.last_working_sets) || [];
  const lastSet = lastSets.length ? lastSets[lastSets.length - 1] : null;
  const target = rec && rec.next_target;
  const todayTop = Math.max(0, ...todaySets.map(s => (Number.isFinite(s.weight) ? s.weight : 0)));

  const rows = [];
  if (lastSet && Number.isFinite(lastSet.weight)) {
    const rir = lastSet.rir != null ? ` @ RIR${lastSet.rir}` : '';
    rows.push(['Last', `${formatSetLoad(lastSet.weight, lastSet.reps)}${rir}`]);
  }
  // Hint prefers the plain-English recommendation; falls back to the progress
  // comparison so a card always carries a usable cue.
  const hint = (rec && rec.recommendation) || previewProgressHint(todayTop, lastSet, target);
  if (hint) rows.push(['Hint', hint]);

  if (!rows.length) return null;
  return el('div', { class: 'atlas-suggestion' }, [
    el('div', { class: 'suggestion-header', text: name }),
    ...rows.map(([label, value]) => el('div', { class: 'suggestion-row' }, [
      el('span', { class: 'suggestion-label', text: label }),
      el('span', { text: value }),
    ])),
  ]);
}

// Deterministic post-write coach verdict. Priority: PR in the just-saved
// session, then a stall/watchout, then the e1RM/top-set trend, then a plain
// fallback. PR + stall context ride on the rec object (rec.prLabel / rec.stall)
// so the call site stays a single buildVerdict(rec).
function buildVerdict(rec) {
  if (!rec || !rec.last_working_sets || !rec.last_working_sets.length) return null;

  // PR in the session we just saved takes top billing.
  if (rec.prLabel) return rec.prLabel;

  // Stall / watchout: this lift hasn't progressed in N sessions.
  if (rec.stall && rec.stall.sessions_stalled) {
    return `no progression in ${rec.stall.sessions_stalled} sessions — consider a deload`;
  }

  const rule = rec.rule_decision;

  // holdUntilClean: criterion met → load
  if (rule?.decision === 'load') {
    return rule.criterion_progress
      ? `${rule.criterion_progress} — ready to load`
      : 'standard met — ready to load';
  }

  // holdUntilClean: hold → show progress
  if (rule?.decision === 'hold' && rule.criterion_progress) {
    return rule.criterion_progress;
  }

  // e1RM trending down — flag it
  if (rec.e1rm_trend === 'down') {
    return 'e1RM trending down';
  }

  // Weight increase vs any of the last 5 sets (recent-best, not all-time)
  const allSets = rec.last_working_sets;
  const lastSet = allSets[allSets.length - 1];
  const prevWeights = allSets.slice(0, -1).map(s => s.weight || 0).filter(w => w > 0);
  if (prevWeights.length > 0 && lastSet.weight > Math.max(...prevWeights)) {
    return `weight up to ${lastSet.weight} lb`;
  }

  // e1RM trending up
  if (rec.e1rm_trend === 'up') {
    return 'e1RM trending up';
  }

  // Fallback — nothing notable, but acknowledge the save.
  return 'no major trend change detected yet';
}

function invalidatePreview() {
  // F07 / CLIENT-3: invalidation supersedes any in-flight preview. Bump the request seq so a
  // dry-run/parse that resolves AFTER a form edit / cancel / start-over is dropped by the guards
  // — otherwise the stale response would re-create pendingWrite and re-enable Save for the very
  // preview the edit was meant to invalidate.
  previewRequestSeq++;
  if (activePreviewCorrelation) {
    retireCorrelatedPreview(activePreviewCorrelation);
    activePreviewCorrelation = null;
  }
  pendingWrite = null;
  runEffortCardCleanups();
  lastParserStatus = null;
  previewPanel.hidden = true;
  previewContent.innerHTML = '';
  const btn = document.getElementById('approve-btn');
  btn.disabled = true;
  btn.textContent = 'Write to Google Sheets';
  const note = document.getElementById('preview-gate-note');
  if (note) note.textContent = 'Run a preview above to enable this button.';
}

document.getElementById('logger-form').addEventListener('input', invalidatePreview);

function startOverWorkout() {
  workoutTextInput.value = '';
  lastParsedWorkoutText = '';
  setSessionLog([]);
  setSessionCompleted([]);
  setSessionRevisions([]); setSessionImplicitRecs([]);
  setSessionSavedLog([]);     // deliberate fresh start — forget this workout's saved recap
  clearSessionSnapshot();   // a deliberate reset must not resume the old session
  document.dispatchEvent(new CustomEvent('atlas:session-reset'));
  closeoutScreenshotFile = null;
  closeoutScreenshotEffort = null;
  closeoutScreenshotDateSource = null;
  setsTableBody.innerHTML = '';
  parsedRowsEditor.hidden = true;
  const effortDetails = document.getElementById('effort-details');
  if (effortDetails) {
    effortDetails.hidden = true;
    effortDetails.open = false;
    ['effort-duration', 'effort-active-cal', 'effort-total-cal', 'effort-avg-hr', 'effort-peak-hr'].forEach(id => {
      const inp = document.getElementById(id);
      if (inp) inp.value = '';
    });
    const fileInp = document.getElementById('effort-image');
    if (fileInp) fileInp.value = '';
    const manualRadio = document.querySelector('input[name="effort-mode"][value="manual"]');
    if (manualRadio) manualRadio.checked = true;
  }
  invalidatePreview();
  workoutTextInput.focus();
}

// PR-H: an explicit "Start over" is an `abandoned` closeout (emit before the state
// is cleared; gated on an accepted plan → no-op for freestyle).
document.getElementById('start-over-btn')?.addEventListener('click', () => { emitPlanCloseout('abandoned'); startOverWorkout(); });

async function waitForLatestSetTurn() {
  if (!latestSetResponseCompletion) return;
  const pending = latestSetResponseCompletion;
  try { await pending; } catch { /* coaching prose is optional */ }
  if (latestSetResponseCompletion === pending) latestSetResponseCompletion = null;
}

// End-of-session compilation: take the in-memory chat history, ask the server
// to extract the workout sets the lifter logged conversationally, then populate
// the composer and trigger a normal parse → preview → approve flow.
async function handleLogIt() {
  // P0 closeout trust: NEVER return silently. Every path below either drives the
  // preview or sets a visible status; this wrapper guarantees a visible message even
  // if an unexpected throw occurs (the "log it disappeared" bug must be impossible).
  try {
    await runCloseout();
  } catch (err) {
    setStatus(loggerStatus, `Couldn't close out the session: ${err && err.message ? err.message : 'unexpected error'}. Nothing was saved — try again.`, 'error');
  }
}

async function runCloseout() {
  await waitForLatestSetTurn();
  // CANONICAL SOURCE OF TRUTH: build the closeout rows from the structured set
  // buffer (sessionLog) — the same source getCanonicalSession() derives from. No
  // Gemini, no re-parse. This is what the visible logged cards were rendered from,
  // so if cards exist, this finds them.
  if (getSessionLog().length) {
    // Only repopulate from the buffer if the table is empty. If the user already
    // ran closeout and then edited or deleted rows (e.g. to fix a bad-RIR row),
    // preserve their edits — don't overwrite with the original bad rows again.
    if (!setsTableBody.children.length) {
      populateSetRows(buildRowsFromSessionLog());
    }
    sessionCompiledAwaitingPreview = true;
    document.getElementById('logger-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return;
  }

  // Live-audit Bug #2: after a save the buffer is reset. With an EMPTY buffer AND a
  // prior save this session (lastWrite set), "log it" has nothing new — say so
  // plainly instead of recompiling the already-saved chat history, which both
  // implied a fresh save ("session logged / great work") and risked re-writing the
  // sets already on the sheet. New sets logged after a save DO buffer (sessionLog
  // non-empty → the branch above), so this only fires when there is genuinely
  // nothing new to log.
  if (lastWrite) {
    setStatus(loggerStatus, 'Nothing new to log since your last save — log some sets first.', 'warn');
    return;
  }

  const turns = typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];

  // The buffer is empty AND nothing was saved. Before the LLM compile, check the
  // canonical session: if it shows completed work (e.g. after a reload the plan +
  // completions survived but the raw set buffer didn't), the set details aren't in
  // memory to rebuild — say so honestly and route to manual entry, NEVER the false
  // "no sets" while the lifter can see logged cards (P0 closeout trust).
  const canon = typeof getCanonicalSession === 'function' ? getCanonicalSession() : null;
  const AS = (typeof window !== 'undefined' && window.activeSession) || null;
  const canonHasWork = !!(canon && AS && typeof AS.hasLoggedWork === 'function' && AS.hasLoggedWork(canon));

  if (!turns.length) {
    setStatus(loggerStatus, canonHasWork
      ? "I can see your logged exercises, but their set details aren't in memory to compile (the app may have reloaded). Re-enter the sets in the composer and tap Save — nothing was lost on your sheet."
      : "No conversation yet — log some sets in the chat first, then say 'log it'.", 'error');
    return;
  }

  setStatus(loggerStatus, 'Compiling session from conversation…', 'ok');

  let workoutText;
  try {
    const res = await api('/api/session/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: turns })
    });
    workoutText = res.data?.workout_text || null;
  } catch (err) {
    // Compile is the LLM fallback; when it's down, do NOT claim "no sets". Say the
    // compile is unavailable and route to manual entry.
    setStatus(loggerStatus, `Couldn't compile the session right now (the coach may be offline). Type your sets in the composer and tap Save — nothing was saved yet.`, 'error');
    return;
  }

  if (!workoutText) {
    // Distinguish a genuine empty conversation from "the compiler found nothing but
    // the lifter clearly logged work" — never a flat false "no sets" when canonical
    // state shows completed exercises.
    setStatus(loggerStatus, canonHasWork
      ? "I couldn't recompile your sets from the conversation, but I can see you logged exercises. Re-enter them in the composer and tap Save — nothing was saved yet."
      : "Couldn't find any sets in the conversation — did you log any exercises? You can type them in the composer directly.", 'error');
    return;
  }

  setStatus(loggerStatus, '', 'ok');
  workoutTextInput.value = workoutText;
  invalidatePreview();
  // Signal the submit handler to run parse → preview instead of routing to coach.
  sessionCompiledAwaitingPreview = true;
  document.getElementById('logger-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

// One write_id per previewed workout: if the live write is retried (double
// tap, network blip), the backend recognises the id and refuses to append
// twice, returning proof the original write completed instead.
function generateWriteId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `w-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function hasLogWorkoutNoWriteProof(result) {
  const data = result?.data || {};
  return data.test_mode === true &&
    data.sheet_write === 'skipped' &&
    data.sheet_written === false &&
    data.no_write_confirmed === true;
}

function hasCompleteWorkoutNoWriteProof(result) {
  const data = result?.data?.data || {};
  return data.test_mode === true &&
    data.sheet_write === 'skipped' &&
    data.sheet_written === false &&
    data.no_write_confirmed === true;
}

// Modality (cardio / circuit / timed-hold) dry-run no-write proof. The
// /api/log-modality dry-run returns its proof at result.data (like the manual
// log-workout path), NOT nested under data.data.
function hasLogModalityNoWriteProof(result) {
  const data = result?.data || {};
  return data.test_mode === true &&
    data.sheet_write === 'skipped' &&
    data.sheet_written === false &&
    data.no_write_confirmed === true;
}

function previewProofFromResult(result, mode) {
  const data = (mode === 'manual' || mode === 'modality') ? (result?.data || {}) : (result?.data?.data || {});
  return {
    mode,
    test_mode: data.test_mode,
    sheet_write: data.sheet_write,
    sheet_written: data.sheet_written,
    no_write_confirmed: data.no_write_confirmed,
    created_at_ms: Date.now()
  };
}

function pendingWriteHasPreviewProof(write) {
  if (!write || !write.previewProof) return false;
  const proof = write.previewProof;
  if (proof.test_mode !== true || proof.sheet_written !== false || proof.no_write_confirmed !== true) return false;
  if (proof.mode === 'manual' && proof.sheet_write !== 'skipped') return false;
  if (proof.mode === 'modality' && proof.sheet_write !== 'skipped') return false;
  if ((proof.mode === 'screenshot' || proof.mode === 'effort-only') && proof.sheet_write !== 'skipped') return false;
  return true;
}

// PR 486 frontend wiring — the modality (cardio / interval / circuit / timed-hold)
// trust loop. MIRRORS the slash trust loop and never alters it: a dry-run preview
// proves no-write, the existing #approve-btn is the only write trigger, and the
// real write goes through /api/log-modality only on explicit approval.
const MODALITY_LOG_LABELS = ['Date', 'Session', 'Modality', 'Exercise', 'Duration (s)', 'Distance (m)', 'Rounds', 'Rest (s)', 'Level', 'RPE', 'Avg HR', 'Notes'];
// Human label for the preview heading, keyed by the parser's modality value
// (services/multiModalityParser.js). Falls back to a generic heading so a hold
// never reads "Cardio".
const MODALITY_HEADINGS = {
  cardio_steady: 'Cardio',
  cardio_interval: 'Intervals',
  circuit: 'Circuit / conditioning',
  timed_hold: 'Timed hold'
};

function renderModalityPreview(preview) {
  previewContent.innerHTML = '';
  const label = MODALITY_HEADINGS[preview.modality] || 'Conditioning';
  previewContent.appendChild(el('h3', { text: `${label} to write (Modality_Log)` }));
  const row = Array.isArray(preview.row) ? preview.row : [];
  // Key/value list of exactly what will be written — blanks omitted for clarity.
  const pairs = MODALITY_LOG_LABELS
    .map((label, i) => [label, row[i]])
    .filter(([, v]) => v !== '' && v !== null && v !== undefined);
  previewContent.appendChild(renderTable(['Field', 'Value'], pairs));
  previewContent.appendChild(el('div', { class: 'muted small', text: 'Writes one row to the Modality_Log tab. Strength sets are unaffected.' }));
  previewPanel.hidden = false;
  previewPanel.open = true;
}

// Question-shaped input must reach the coach, not a write preview. The modality
// recognizer is name+quantity based, so "how was my 5km run?" carries a cardio word
// and a distance and would otherwise stage a (garbage-exercise) write preview. We
// suppress only CLEAR questions — a trailing "?" or an interrogative lead word —
// and deliberately omit log-ambiguous verbs (did/do/does/ran) so a real entry like
// "Did 5k run 30:00" is never blocked. Fail-open toward the coach: a suppressed
// input simply routes to chat, never to a write.
function looksLikeModalityQuestion(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  return /^(how|hows|what|whats|why|when|where|who|which|whose|should|was|were|is|are|can|could|would|will)\b/.test(t);
}

// Try to stage a modality input as a previewed-but-unwritten approval. Returns
// true when it owned the input (a recognized modality was previewed, OR a friendly
// fail-closed message was shown); false when the input is NOT a modality (the
// caller then falls through to the coach). Read-only: only a test_mode dry-run runs
// here — the actual write happens solely in the #approve-btn handler.
async function tryPreviewModality(text, sessionId, date, submitSeq) {
  // Staleness outranks every early return that would permit fallthrough. In
  // particular, a late question-shaped A must not reach coach routing after B.
  if (submitSeq !== previewRequestSeq) return true;
  if (!text || !date) return false;
  // A question about training is for the coach — never stage it as a write preview.
  if (looksLikeModalityQuestion(text)) return false;
  let result;
  const correlationPreview = beginCorrelatedPreview({ sessionId });
  activePreviewCorrelation = correlationPreview;
  try {
    const previewPayload = { text, session_id: sessionId, date, test_mode: true };
    if (correlationPreview) previewPayload.correlation = correlationPreview.correlation;
    result = await api('/api/log-modality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(previewPayload),
      ...(correlationPreview ? {
        responseHeaders: responseHeaders => completeCorrelatedPreview(correlationPreview, responseHeaders)
      } : {})
    });
  } catch (err) {
    // A superseded modality attempt owned its original input. It must not fall
    // through into a stale coach response after a newer submit has taken over.
    if (submitSeq !== previewRequestSeq) return true;
    // 422 = not a recognized modality → let the caller route to the coach.
    // Any other failure → we can't trust a preview, so we never stage a write.
    return false;
  }
  // Initiation order owns the review card. A late A response may complete its
  // retired correlation, but it cannot replace B's pending preview or approval.
  if (submitSeq !== previewRequestSeq) return true;
  const data = result?.data || {};
  if (!data.modality || !Array.isArray(data.modality_row_preview)) return false;
  // Fail closed: never enable approval without the dry-run no-write proof.
  if (!hasLogModalityNoWriteProof(result)) {
    setStatus(loggerStatus, "Couldn't safely preview that cardio/conditioning entry — nothing was staged to write.", 'error');
    return true;
  }
  pendingWrite = {
    mode: 'modality',
    text,
    sessionId,
    date,
    writeId: generateWriteId(),
    correlationPreview,
    previewProof: previewProofFromResult(result, 'modality')
  };
  renderModalityPreview({ modality: data.modality, row: data.modality_row_preview });
  document.getElementById('approve-btn').disabled = !pendingWriteHasPreviewProof(pendingWrite);
  setStatus(loggerStatus, `Previewed ${String(data.modality).replace(/_/g, ' ')} — review and approve to write.`, 'ok');
  return true;
}

// True when the lifter has attached effort (a screenshot, or any manual effort
// field) — used to tell a genuine effort/log attempt apart from a plain chat
// message so we only route to the coach when there's nothing to log.
function hasAnyEffortInput() {
  if (effortMode() === 'screenshot') {
    return Boolean(document.getElementById('effort-image').files[0]);
  }
  return ['effort-duration', 'effort-active-cal', 'effort-total-cal', 'effort-avg-hr', 'effort-peak-hr']
    .some(id => (document.getElementById(id).value || '').trim());
}

// The sets currently in the preview editor (unsaved), passed to the coach as
// read-only context so "is this a good set?" can be answered. Empty when nothing
// is in the editor. Never includes anything not already on screen.
function currentPreviewRowsForChat() {
  const rows = [];
  for (const tr of Array.from(setsTableBody.children)) {
    const weight = tr.querySelector('.set-weight')?.value;
    const reps = tr.querySelector('.set-reps')?.value;
    const rir = tr.querySelector('.set-rir')?.value;
    if (!weight && !reps) continue;
    rows.push({
      exercise: activeExercise || null,
      weight: weight === '' || weight == null ? null : Number(weight),
      reps: reps === '' || reps == null ? null : Number(reps),
      rir: rir === '' || rir == null ? null : Number(rir)
    });
  }
  return rows;
}

// Returns today's plan exercises as {name, rationale} objects for the coach
// context, so the model can answer "why in this order?" and "what's left?"
// without claiming it lacks the sequence.
//
// AUTHORITATIVE SOURCE (Roadmap Step 373): when a planned session is live, the
// coach must see the SAME plan the lifter is actually running — including any
// accepted substitutions and the live cursor — not a separately re-fetched
// recommendation. The name key is `canonicalName || name`, matching exactly what
// resolveCompletedIdentity writes into sessionCompleted, so the server's
// name-based computePlanState reconciles completed↔remaining instead of drifting.
// Only when no session is active do we fall back to the cached recommendation.
function currentPlanForChat() {
  if (getActivePlannedSession() && Array.isArray(getActivePlannedSession().exercises) && getActivePlannedSession().exercises.length) {
    return getActivePlannedSession().exercises.slice(0, 10).map(ex => ({
      name: ex.canonicalName || ex.name || null,
      rationale: ex.reason || null,
      weight: ex.weight ?? null,
      reps: ex.reps ?? null,
      sets: ex.sets ?? null,
      rir: ex.rir ?? null
    })).filter(e => e.name);
  }
  // Fallback: the cached recommended intent (no active session yet).
  if (!lastIntentData) return [];
  const intents = lastIntentData.intents || [];
  const recommended = intents.find(i => i.recommended);
  const exercises = recommended && Array.isArray(recommended.exercises) ? recommended.exercises : [];
  return exercises.slice(0, 10).map(ex => ({
    name: ex.canonical_exercise || ex.exercise || null,
    rationale: ex.focus || ex.reason || null,
    weight: ex.target_weight ?? ex.weight ?? null,
    reps: ex.target_reps ?? ex.reps ?? null,
    sets: ex.target_sets ?? ex.sets ?? null,
    rir: ex.target_rir ?? ex.rir ?? null
  })).filter(e => e.name);
}

// Hand a non-loggable message to the coach. Read-only narration: app.js only
// dispatches; coach-conversation.js does the /api/coach/chat round-trip and
// types the reply. This NEVER touches the trust loop or the write path.
function routeMessageToCoach(text) {
  const preview = currentPreviewRowsForChat();
  const plan = currentPlanForChat();
  const context = {};
  // #1165 slice 2: the coach request must name the same explicit session the later
  // preview/write uses, or the server correctly refuses the cross-route claim.
  const correlationDate = document.getElementById('log-date')?.value?.trim() || getLocalDateString();
  const correlationSessionId = (getActivePlannedSession()?.session_id
    || document.getElementById('log-session-id')?.value?.trim()
    || generateSessionId(correlationDate));
  if (correlationSessionId) context.session_id = correlationSessionId;
  if (preview.length) context.current_preview = preview;
  if (plan.length) context.current_plan = plan;
  // Deterministic per-exercise session tally (targeted validation sweep 2026-07-09):
  // the coach used to infer set counts and per-exercise weights from the capped
  // 8-turn transcript, which fabricated weights, undercounted sets past the window,
  // and lost substitution identity. Send the authoritative count/weight/identity
  // straight from the session buffer so the coach reads facts instead of guessing.
  // Read-only, additive — never touches the preview→approve→write path.
  const sessionTally = buildSessionTally(getSessionLog(), plan.map(p => p.name));
  if (sessionTally) context.session_tally = sessionTally;
  // Step 375 + composer plan edits: send plan_completed whenever the client has
  // an authoritative visible plan (started OR chat/suggested) — even when it's
  // still empty ([]). Gating only on activePlannedSession left chat-rendered plans
  // without plan_state, so later composer edits were based on a non-authoritative
  // transcript instead of the same plan state debug/composer use.
  if (plannedExerciseOrder().length > 0) context.plan_completed = [...getSessionCompleted()];
  // F10S3 (owner smoke 2026-07-18) — the canonical selector's VERDICT travels with the
  // question: planned/completed/remaining from the ONE multiplicity-aware selector the
  // rail/pin/recap read, so the server's session-state answers ("what's next?",
  // "are we done?") can never disagree with what the athlete sees. The server
  // validates, bounds, and recomputes isComplete; old clients without this field fall
  // back to the server-side name-matcher unchanged.
  if (plannedExerciseOrder().length > 0) {
    const remaining = remainingPlannedExercises();
    context.plan_state = {
      planned: plannedExerciseOrder(),
      completed: [...getSessionCompleted()],
      remaining,
      isComplete: remaining.length === 0,
    };
  }
  // Phase 4 H-08A — carry the AUTHORITATIVE client active session (the same canonical
  // getCanonicalSession() model the save payload/confirmation card/bug report derive from) so
  // the server can build the canonical WorkoutSession from real slot identity instead of
  // reverse-engineering it from the lossy plan_state name arrays. Additive + bounded: ONLY the
  // four contract fields per slot (name, liftCode, status, source) — no set details, prose,
  // history, ids, or secrets. Sent only when a real session exists; old clients omit it and the
  // server keeps working (packet.session stays null). Read-only; the server consumes it only in
  // the flag-gated CoachTurnPacket shadow and never changes its answer because of it.
  const canonical = (typeof getCanonicalSession === 'function') ? getCanonicalSession() : null;
  if (canonical && Array.isArray(canonical.exercises) && canonical.exercises.length) {
    context.active_session = {
      exercises: canonical.exercises.map(e => ({ name: e.name, liftCode: e.liftCode, status: e.status, source: e.source })),
    };
  }
  // Defer one tick so chat.js's submit listener paints the user bubble first —
  // without this, the Atlas "Thinking…" bubble appends before the user bubble.
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('atlas:chat-message', {
      detail: { text, context }
    }));
  }, 0);
  setTimeout(() => { workoutTextInput.value = ''; }, 0);
  invalidatePreview();
}

// Intent-router SHADOW observation (Phase C2, widened 2026-07-03). The composer
// submit handler below fans a typed message into ~8 deterministic lanes that each
// return before any /api/coach/chat call (set logs, session/artifact asks, log-it,
// plan mutations + identity corrections that never touch the network at all), so
// the old server-side observation at /api/coach/chat only ever saw the residue —
// the shadow log missed most typed messages. Observing here, at the ONE chokepoint
// every composer submission passes through, captures them all exactly once.
// OBSERVE-ONLY: fire-and-forget, never awaited, never blocks or alters the submit /
// reply / write path; the server no-ops when ATLAS_INTENT_ROUTER != shadow.
function observeComposerText(text) {
  const message = (text || '').trim();
  if (!message) return;
  // A BARE fetch, not api() (review #838): api() records every failure into
  // atlasLastError / the request history that bug reports capture, so a dropped
  // observation (e.g. a Render cold-start blip) would leave a diagnostic trace —
  // contradicting "observation must never surface." A bare authenticated fetch
  // with a swallowed rejection makes a dropped observation truly invisible.
  try {
    fetch('/api/debug/intent-observe', {
      method: 'POST',
      credentials: 'same-origin', // session cookie authenticates post-migration (F04C)
      headers: { 'Content-Type': 'application/json', ...(getApiKey() ? { 'x-atlas-api-key': getApiKey() } : {}) },
      // app_version stamps the Intent_Shadow diagnostics row with the running shell
      // build, so the owner can tell which build produced an observation.
      // request_origin marks this as genuine athlete-UI activity for GATE A evidence
      // provenance (PR-GATEA1) — this POST bypasses the api.js header seam, so the
      // marker rides the body. Under browser automation send a synthetic marker
      // instead; the server still verifies same-origin browser provenance + fails
      // closed on non-prod/test/sim.
      body: JSON.stringify({
        message,
        app_version: ATLAS_SHELL_BUILD,
        request_origin: (typeof navigator !== 'undefined' && navigator.webdriver === true) ? 'playwright' : 'athlete_ui'
      })
    }).catch(() => { /* observation must never surface to the lifter */ });
  } catch { /* nor throw into the submit path */ }
}

function bindClarifiedRowsToCurrentSession(rows) {
  const date = document.getElementById('log-date')?.value?.trim() || getLocalDateString();
  const sessionInput = document.getElementById('log-session-id');
  const sessionId = sessionInput?.value?.trim() || generateSessionId(date);
  if (sessionInput) sessionInput.value = sessionId;
  for (const row of rows) row.session_id = sessionId;
  return sessionId;
}

document.getElementById('logger-form').addEventListener('submit', async e => {
  e.preventDefault();

  // Paint the user's message bubble FIRST — before any routing, coach reply,
  // preview card, or logged-set reaction can append an Atlas bubble. Doing this
  // synchronously at the top of the handler guarantees the pasted workout shows
  // ABOVE its response (the owner-reported inversion where a multi-exercise paste's
  // ✓ confirmation rendered above the paste bubble). chat.js's addUserBubble
  // dedupes a repeated consecutive bubble, so this never double-paints.
  const submittedText = (workoutTextInput.value || '').trim();
  if (submittedText && typeof window.atlasAddUserBubble === 'function') {
    window.atlasAddUserBubble(submittedText);
  }

  // Shadow observation, BEFORE any deterministic lane can claim + return: this is
  // the one chokepoint every free-text composer submission passes through, so the
  // intent-router shadow lane sees them all (owner find 2026-07-03). Fire-and-forget.
  observeComposerText(submittedText);

  const bugNote = parseBugCommand(submittedText);
  if (bugNote !== null) {
    await saveAtlasBugReport(bugNote);
    setTimeout(() => { workoutTextInput.value = ''; }, 0);
    return;
  }

  // Training-plan questions ("what are we doing today", "what should I train")
  // route to the ONE canonical in-thread Coach's Pick (Phase B) — the same
  // structured, engagement-carrying render every other recommendation entry
  // point uses. With the home tiles retired (owner directive 2026-07-03), the
  // typed sentence IS the pick's entry; a chat-prose answer here would be a
  // second recommendation voice.
  if (looksLikeSessionRequest(workoutTextInput.value)) {
    // Carry the athlete's structured constraints (requested first exercise, focus) into the
    // authoritative pipeline so it can honor them — never a client-built plan.
    const genConstraints = sessionQuestion.extractGenerationConstraints(workoutTextInput.value);
    setTimeout(() => { workoutTextInput.value = ''; }, 0);
    openCoachPickInThread(genConstraints);
    return;
  }

  // Composer-first Phase B2: deterministic artifact asks ("show my last
  // session", "weekly report") render the existing read-only artifact INLINE
  // in the thread — a deterministic read stays deterministic, no LLM between
  // the lifter and their own numbers. If a renderer is unavailable the ask
  // falls through to the coach chat below (never silence).
  const artifactKind = looksLikeArtifactRequest(workoutTextInput.value);
  if (artifactKind) {
    const renderer = artifactKind === 'last_session'
      ? window.atlasChipAnswerLast
      : window.atlasChipAnswerReport;
    if (typeof renderer === 'function') {
      setTimeout(() => { workoutTextInput.value = ''; }, 0);
      renderer();
      return;
    }
  }

  // F09G (CONVO-LOG-1): a short affirmation ("Just log it", "yes", "log it") RESOLVES a
  // held bodyweight-rep clarification — committing exactly the reps the parser already
  // detected — BEFORE the closeout / "log it" routing, so those sets are never dropped
  // and "Just log it" is never mistaken for a session close. ("Done" is deliberately not
  // an affirmation here, so it still closes out.)
  {
    const resolvedRows = resolvePendingClarification(workoutTextInput.value.trim());
    if (resolvedRows) {
      const affirmText = workoutTextInput.value.trim();
      workoutTextInput.value = '';
      // This early-return path runs before the normal submit block derives its session.
      // Bind the clarified rows now so atlas:set-logged can mint the coach response
      // ticket for this exact session and closeout retains that resulting canonical turn.
      const clarificationSessionId = bindClarifiedRowsToCurrentSession(resolvedRows);
      emitSetLogged(resolvedRows, affirmText, [], null);
      latestSetResponseCompletion = waitForTurnResponse({ sessionId: clarificationSessionId });
      return;
    }
  }

  // "Log it" / "done" — compile the full conversational session from chat
  // history and run the normal parse → preview → approve flow on the result.
  if (looksLikeLogIt(workoutTextInput.value)) {
    workoutTextInput.value = '';
    await handleLogIt();
    return;
  }

  // After a successful save, correction language triggers a "Replace / Log as
  // new / Cancel" prompt rather than silently appending a second workout.
  if (lastWrite) {
    const correctionText = workoutTextInput.value.trim();
    if (correctionText && looksLikeCorrection(correctionText)) {
      setTimeout(() => { workoutTextInput.value = ''; }, 0);
      showCorrectionPrompt(correctionText);
      return;
    }
  }

  // Capture text before the async clear fires — the catch block needs it to
  // decide whether to route to the coach.
  const pendingChatText = workoutTextInput.value.trim();

  // Clear the composer immediately — chat.js already captured it for the user
  // bubble, so this just empties the box while Atlas thinks.
  setTimeout(() => { workoutTextInput.value = ''; }, 0);

  setStatus(loggerStatus, '', 'ok');
  invalidatePreview();
  // F07 / CLIENT-3: invalidatePreview() just bumped the seq, making this submit the latest
  // preview request. Its async responses only apply while previewRequestSeq still equals
  // submitSeq — a later submit or a form edit (both bump the seq) supersedes this one.
  const submitSeq = previewRequestSeq;
  // RC2: a FRESH submit starts with no date-source banner. The closeout branch below
  // re-sets it when a screenshot drives the save. Gating on sessionCompiledAwaitingPreview
  // preserves it across the closeout RE-ENTRY (which skips that branch but must still
  // render the banner). This stops a stale "Date from screenshot" label from leaking onto
  // a later normal preview if a closeout preview was abandoned without Start Over.
  if (!sessionCompiledAwaitingPreview) closeoutScreenshotDateSource = null;

  const mode = effortMode();
  const date = document.getElementById('log-date').value.trim();
  if (!date && mode !== 'screenshot') {
    setStatus(loggerStatus, 'Date is required.', 'error');
    return;
  }
  const sessionIdInput = document.getElementById('log-session-id');
  const sessionId = sessionIdInput.value.trim() || (date ? generateSessionId(date) : '');
  const location = document.getElementById('log-location').value.trim();
  const notes = document.getElementById('log-notes').value.trim();
  let file = null;
  if (mode === 'screenshot') {
    const imageInput = document.getElementById('effort-image');
    file = imageInput.files[0] || null;
  }

  if (file && !pendingChatText && !sessionCompiledAwaitingPreview && isPlanCloseoutAwaitingSave()) {
    closeoutScreenshotFile = file;
    closeoutScreenshotEffort = null;
    setStatus(loggerStatus, 'Reading screenshot effort...', 'ok');
    try {
      closeoutScreenshotEffort = await parseWorkoutImage(file);
      if (submitSeq !== previewRequestSeq) return;
      setStatus(loggerStatus, 'Effort read from screenshot — opening your preview to save.', 'ok');
    } catch {
      if (submitSeq !== previewRequestSeq) return;
      setStatus(loggerStatus, "I couldn't read effort from the screenshot. I can still save the workout without effort data.", 'warn');
    }
    // RC2: the screenshot's own date is authoritative for this save unless the owner
    // explicitly typed a date. Resolve it and apply to BOTH #log-date and the session_id
    // BEFORE handleLogIt re-submits, so the rebuilt log rows, session_id, effort row,
    // pendingWrite payload, and preview banner all share the chosen date — never silently
    // today. An absent/ambiguous screenshot date falls back to today (and the preview warns).
    const resolvedCloseout = resolveCloseoutWorkoutDate({
      manualDate: date,
      manualEntered: logDateManuallyEntered,
      screenshotDate: closeoutScreenshotEffort && closeoutScreenshotEffort.date,
      today: getLocalDateString()
    });
    closeoutScreenshotDateSource = resolvedCloseout.source;
    document.getElementById('log-date').value = resolvedCloseout.date;
    // The screenshot's date may set the WORKOUT DATE — never the session
    // identity: an accepted session's id (and its Session_Plans + ledger
    // checkpoint rows) was minted at acceptance, and re-deriving the id from a
    // cross-day screenshot date forked the closeout away from its own ledger
    // (seal → no_rows, honestly unverified, unrecoverable by retry). Keep the
    // accepted id; fall back to the existing input, then to a date-derived id
    // only when no session identity exists yet.
    const acceptedShotSid = (getActivePlannedSession() && getActivePlannedSession().accepted === true
      && getActivePlannedSession().session_id) || '';
    sessionIdInput.value = acceptedShotSid || sessionIdInput.value.trim() || generateSessionId(resolvedCloseout.date);
    // FB: the screenshot upload IS the completion signal at closeout — drive the
    // EXISTING closeout (handleLogIt → runCloseout → preview → approve → write) directly
    // instead of staging the effort and waiting for a separate "done". On re-entry the
    // closeoutAttachmentOnly path (below) folds the parsed effort into the normal
    // log-workout preview. Approve-before-write is preserved — this never writes
    // directly; it opens the same preview "done" would, so write_id idempotency and the
    // lastWrite "nothing new" guard still backstop any later "done".
    await handleLogIt();
    return;
  }

  // #1123: capture whether THIS submit introduces NEW parsed input. rowsFromWorkoutInput()
  // advances lastParsedWorkoutText ONLY on a real parse; it early-returns (leaving the
  // value — and the editor table — untouched) when there is no new/changed workout text,
  // i.e. a plain re-preview of the already-staged closeout table. That distinction lets the
  // closeout-stage guard block the re-preview REPLAY without swallowing a genuinely new
  // "log one more set after Finish", which must still append to the buffer.
  const parsedTextBeforeSubmit = lastParsedWorkoutText;
  let logRows = [];
  try {
    await rowsFromWorkoutInput();
    logRows = collectLogRows(sessionId, date);
  } catch (err) {
    // An already-handled, user-facing condition (e.g. the kg gate) shows its own
    // message and must NOT fall through to the coach/parse-error routing.
    if (err && err.handled) {
      setStatus(loggerStatus, err.displayMessage || err.message, 'warn');
      activeExercise = null;
      return;
    }
    // Text that isn't a loggable workout, with no effort attached, is treated as
    // a question for the coach rather than a parse error — so "was that a good
    // session?" or just "Bench" gets a conversation instead of a red dead-end.
    // For constraint messages during an active session, try the substitute endpoint
    // first. If a card was dispatched, skip the coach route (one response per message).
    // If no recommendation exists in the catalog, fall through to the coach as normal.
    if (pendingChatText && !hasAnyEffortInput()) {
      // Trust gap (live-audit PR 2): a MALFORMED SET must not silently become a coach
      // message — the coach's confident readback then "looks logged" but never wrote.
      // Fire only on an unambiguous failed slash-log: the parser recognized an
      // exercise (recognizedExercise), returned needs_clarification, AND the input
      // carried slash-set notation. Surface the format hint instead of routing to the
      // coach. Questions (no recognized exercise / no slash) and bare partials like
      // "Bench 225" (no slash → coach still asks conversationally) are unaffected.
      if (err.parsedIntent === 'needs_clarification' && err.recognizedExercise && /\d+\s*\/\s*\d+/.test(pendingChatText)) {
        setStatus(loggerStatus, `${err.displayMessage} Check the format, e.g. "Bench 225 5/2".`, 'warn');
        activeExercise = null;
        return;
      }
      // Multi-line partial-log (owner 2026-07-02): a paste where NO line resolved
      // still carries per-line specifics — surface the first ask instead of letting
      // set notation sink into the coach (the fluent-readback-over-empty-buffer gap).
      if (err.parsedIntent === 'needs_clarification' && Array.isArray(err.unresolvedLines) &&
          err.unresolvedLines.length && /\d+\s*\/\s*\d+/.test(pendingChatText)) {
        setStatus(loggerStatus, `${err.displayMessage} Re-type that line and I'll add it.`, 'warn');
        activeExercise = null;
        return;
      }
      // F09G (CONVO-LOG-1): a needs_clarification that ALREADY carries detected reps
      // (bare-rep bodyweight, e.g. "Knee raises 15 12 10") HOLDS those sets and surfaces
      // the bounded question, so a following short "Just log it" commits exactly them.
      // Without this the partial.sets were discarded and the sets silently dropped from
      // the session buffer (and thus from the final confirmation). setPendingClarification
      // returns truthy only when there are usable detected sets to hold.
      if (err.parsedIntent === 'needs_clarification' && setPendingClarification(err)) {
        setStatus(loggerStatus, err.displayMessage, 'warn');
        activeExercise = null;
        return;
      }
      // A PENDING replacement proposal owns the follow-up turn first (production trust fix
      // FR-20260723031748): "No let's do bench press" / "yes bench" approves it, "what weight
      // should I put on the bar" answers from the proposal — never a modality probe, a
      // one-sided skip, the SME, or a broad Bench Press benchmark challenge. A loggable set
      // parsed+logged above, so it never reaches here; only a conversational follow-up does.
      if (tryResolvePendingReplacement(pendingChatText)) {
        activeExercise = null;
        return;
      }
      // A PENDING SET-REVISION proposal owns the follow-up turn the same way (#1189): an
      // explicit endorsement approves it, a decline clears it, and a question is answered from
      // the stored proposal while it stays pending. An ambiguous acknowledgement falls through
      // untouched — it is not consent to rewrite the remaining sets.
      if (tryResolvePendingSetRevision(pendingChatText)) {
        activeExercise = null;
        return;
      }
      // A cardio / interval / circuit / timed-hold input isn't a slash workout, so
      // the slash parser threw above. Try the modality trust loop (dry-run preview
      // → approve → /api/log-modality) before treating it as a coach question. On a
      // 422 / non-modality this returns false and we fall through to the coach.
      if (await tryPreviewModality(pendingChatText, sessionId, date, submitSeq)) {
        activeExercise = null;
        return;
      }
      if (submitSeq !== previewRequestSeq) return;
      // An EXPLICIT REPLACE ("replace back squats with bench", "remove squats and change out
      // for bench") stages ONE gated proposal — source stays, replacement is not activated
      // until approval — BEFORE the skip/suggest/coach routes (req 4/5), so a direct
      // replacement can never be split into a one-sided skip plus a free-form chat challenge.
      if (await tryProposeReplacement(pendingChatText)) {
        activeExercise = null;
        return;
      }
      if (submitSeq !== previewRequestSeq) return;
      // P0 Sub-PR 2a: an EXPLICIT swap/skip ("skip deadlift, do squats") mutates
      // the canonical session deterministically — before the suggest/coach routes,
      // so the change lands in app state, not just chat prose.
      if (tryApplyPlanMutation(pendingChatText)) {
        activeExercise = null;
        return;
      }
      // An implicit substitution ("I don't want to do squats, give me something else")
      // — the athlete declined a lift and asked for an unnamed replacement. Resolve a
      // deterministic substitute and swap it in place, before the suggest/coach routes.
      if (await tryApplyImplicitSubstitution(pendingChatText)) {
        activeExercise = null;
        return;
      }
      if (submitSeq !== previewRequestSeq) return;
      // P0 PR 4: an EXPLICIT identity correction ("sorry that was squats") relabels
      // the just-logged lift deterministically — before the suggest/coach routes, so
      // it lands in app state even when the coach LLM is down.
      if (tryApplyIdentityCorrection(pendingChatText)) {
        activeExercise = null;
        return;
      }
      // ADD-5: reaching here means the message was NOT a log, modality, plan
      // mutation, or identity correction — it is coach discussion/a question. The
      // session focus has left the just-logged lift, so a later demonstrative
      // correction must not silently relabel that completed lift (it asks instead).
      setCoachDiscussionSinceLog(true);
      const suggested = await checkAndSuggestSubstitute(pendingChatText);
      if (submitSeq !== previewRequestSeq) return;
      if (!suggested) routeMessageToCoach(pendingChatText);
      // Clear the stale active-exercise context so the next bare shorthand input
      // (e.g. "15 12/2 x3" after "leg extension is taken, doing laterals first")
      // cannot silently attach to the wrong exercise. The parser will ask
      // "Which exercise is this for?" instead of inheriting the prior lift.
      activeExercise = null;
      return;
    }
    setStatus(loggerStatus, err.displayMessage || `Could not parse workout text: ${err.message}`, 'error');
    return;
  }

  let manualEffort = null;
  try {
    if (mode === 'manual') {
      manualEffort = collectManualEffort(sessionId, date, location, notes);
    }
  } catch (err) {
    setStatus(loggerStatus, err.message, 'error');
    return;
  }

  const closeoutAttachmentOnly = file && closeoutScreenshotFile === file && sessionCompiledAwaitingPreview;
  if (closeoutAttachmentOnly) file = null;
  if (closeoutAttachmentOnly && closeoutScreenshotEffort) {
    manualEffort = effortRowFromParsedEffort(closeoutScreenshotEffort, sessionId, date, location, notes);
  }

  // Screenshot upload and manual effort form are end-of-session triggers.
  // If the lifter logged sets conversationally (the editor is empty because each
  // set went to the buffer), rebuild the FULL session so one preview covers both
  // the workout rows AND the effort data. Prefer the structured buffer; fall back
  // to the conversational compile only when the buffer is empty.
  if (!logRows.length && (file || manualEffort) && getSessionLog().length) {
    const compileDate = mode === 'screenshot' ? '' : (date || getLocalDateString());
    const compileSessionId = mode === 'screenshot' ? '' : (sessionId || generateSessionId(date || getLocalDateString()));
    populateSetRows(buildRowsFromSessionLog());
    logRows = collectLogRows(compileSessionId, compileDate);
  }
  if (!logRows.length && (file || manualEffort)) {
    const turns = typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];
    if (turns.length) {
      setStatus(loggerStatus, 'Compiling session…', 'ok');
      try {
        const compileRes = await api('/api/session/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: turns })
        });
        const compiledText = compileRes.data?.workout_text;
        if (compiledText) {
          // Screenshot mode: leave date_clean and session_id blank so the
          // server can stamp them with the screenshot-resolved date/session_id
          // (normalizeLogRowObject falls back to topLevelDate/topLevelSessionId
          // when the row fields are falsy). Manual effort uses the form date.
          const compileDate = mode === 'screenshot' ? '' : (date || getLocalDateString());
          const compileSessionId = mode === 'screenshot' ? '' : (sessionId || generateSessionId(compileDate));
          workoutTextInput.value = compiledText;
          try {
            await rowsFromWorkoutInput();
            logRows = collectLogRows(compileSessionId, compileDate);
          } finally {
            workoutTextInput.value = '';
            lastParsedWorkoutText = '';
          }
        }
      } catch {
        // Compilation failed or Gemini unavailable — fall through to effort-only preview
      }
      setStatus(loggerStatus, '', 'ok');
    }
  }

  // F10D readiness — a screenshot uploaded WITH workout rows IS a session-closeout
  // signal and must run through the SAME single confirmation as "done" and typed
  // effort (owner directive, 2026-07-18): parse the effort here, resolve the
  // screenshot-date authority (RC2 — a typed date still wins), re-stamp the rows
  // under the resolved identity so Log_Cleaned and Effort can never disagree, and
  // fold everything into the ONE log-workout closeout payload — confirmation,
  // seal, finalized event, verification, and the reachable retry all inherited.
  // The plan-complete upload already routes here via the FB lane above
  // (closeoutScreenshotFile → handleLogIt → closeoutAttachmentOnly, which nulls
  // `file` before this point); this closes the freestyle / incomplete-plan /
  // typed-rows shapes that previously staged a /api/complete-workout write with
  // no confirmation. An unreadable screenshot still closes out the ROWS honestly
  // (warned, effortless) — never a silent drop, never a second workflow.
  // Effort-only uploads (no rows anywhere) keep their existing lane unchanged.
  let screenshotConvertedCloseout = false;
  // The resolved identity must reach the PAYLOAD too (Codex P1, this PR): the
  // server keys readLedgerRows / recordCloseoutEvent / sealCloseout off the
  // top-level session_id and date, so stale lexicals here would stamp Log/Effort
  // with the screenshot identity while sealing a different session.
  let screenshotResolvedSessionId = null;
  let screenshotResolvedDate = null;
  if (mode === 'screenshot' && file && logRows.length) {
    setStatus(loggerStatus, 'Reading screenshot effort...', 'ok');
    let parsedShotEffort = null;
    try {
      parsedShotEffort = await parseWorkoutImage(file);
      if (submitSeq !== previewRequestSeq) return;
    } catch {
      if (submitSeq !== previewRequestSeq) return;
      setStatus(loggerStatus, "I couldn't read effort from the screenshot. I can still save the workout without effort data.", 'warn');
    }
    const resolvedShot = resolveCloseoutWorkoutDate({
      manualDate: date,
      manualEntered: logDateManuallyEntered,
      screenshotDate: parsedShotEffort && parsedShotEffort.date,
      today: getLocalDateString()
    });
    closeoutScreenshotDateSource = resolvedShot.source;
    document.getElementById('log-date').value = resolvedShot.date;
    const resolvedShotSessionId = sessionIdInput.value.trim() || generateSessionId(resolvedShot.date);
    sessionIdInput.value = resolvedShotSessionId;
    screenshotResolvedSessionId = resolvedShotSessionId;
    screenshotResolvedDate = resolvedShot.date;
    if (getSessionLog().length) populateSetRows(buildRowsFromSessionLog());
    logRows = collectLogRows(resolvedShotSessionId, resolvedShot.date);
    if (parsedShotEffort) {
      manualEffort = effortRowFromParsedEffort(parsedShotEffort, resolvedShotSessionId, resolvedShot.date, location, notes);
    }
    file = null;
    screenshotConvertedCloseout = true;
  }

  const effortOnly = !logRows.length && Boolean(file || manualEffort);
  if (!logRows.length && !effortOnly) {
    // Pure text with nothing to log → route to the coach (same as the parse
    // fallback above). Empty input still shows the gentle hint.
    const chatText = workoutTextInput.value.trim();
    if (chatText) {
      routeMessageToCoach(chatText);
      return;
    }
    setStatus(loggerStatus, 'Enter workout text first, then preview. You can edit parsed rows after preview.', 'error');
    return;
  }

  // In-workout coaching (session-level save): a logged set is coached in-thread
  // — readback + adjusted-next prescription — and is NEVER previewed or written.
  // The single review + write happens only on an explicit END trigger:
  // "done"/"log it" (which sets sessionCompiledAwaitingPreview), an Apple Watch
  // screenshot, or manual effort. This makes "no mid-workout Save" a STRUCTURAL
  // invariant — the preview/approve/write surface is unreachable from logging a
  // set, by construction (not just hidden by styling).
  // #1123: a plain re-preview of the staged closeout table parses no new input, so it must
  // NOT re-enter this append lane (that was the 5→10 replay). A genuinely new set typed
  // after Finish DID parse new input and must still log here — otherwise it would be staged
  // as a one-row closeout and the buffered work would be dropped on the approved write.
  const isCloseoutRePreview = closeoutPreviewStaged && lastParsedWorkoutText === parsedTextBeforeSubmit;
  if (logRows.length && !file && !manualEffort && !sessionCompiledAwaitingPreview && !screenshotConvertedCloseout && !isCloseoutRePreview) {
    // F10D acceptance boundary: a set from an unaccepted displayed/engaged plan
    // holds HERE — nothing commits — until the athlete presses the one existing
    // "Start this plan" action. The held message resumes through this same
    // submit path after acceptance; freeform surfaces never reach this block.
    const gateRec = unacceptedPlanGateRec(logRows);
    if (gateRec) {
      // Composer-chat simplification (owner): the acceptance boundary keeps its
      // DATA guarantee — a displayed plan is never treated as an active, ledgered
      // session without acceptance — but drops its UI card. A set logged from an
      // unaccepted plan surface now SILENTLY accepts that plan through the SAME
      // acceptDisplayedPlan path the retired "Start this plan" button called
      // (minting identity + the Session_Plans acceptance + the Session_Plan_Sets
      // checkpoint), then resumes the held set through the one submit path. No
      // card, no button — the set still lands INSIDE the ledger, never outside it.
      blockedLogText = pendingChatText || lastParsedWorkoutText || '';
      blockedLogSeq = submitSeq;
      acceptDisplayedPlan(gateRec).then(result => {
        if (result && result.started) {
          // Accepted: release the held set back through the one submit path, where
          // the now-accepted session passes the gate and logs normally.
          const resumed = typeof window.atlasResumeBlockedLog === 'function'
            && window.atlasResumeBlockedLog() === true;
          // #1165 — a sidecar that hit its bound leaves the plan record UNCONFIRMED. Say
          // so, quietly and without claiming persistence: the set itself is logging
          // normally (the resume above), and nothing here writes. Set AFTER the resume
          // because the resumed submit clears the status line on its way in.
          // Gated on `resumed` (advisory P1): a superseded stash was deliberately NOT
          // replayed, and this line must never vouch for a set that was dropped — the
          // newer submit that superseded it drives its own status.
          if (resumed && result.sidecarTimedOut) {
            setStatus(loggerStatus, "Atlas couldn't confirm the plan record just now — your set is still being logged.", 'warn');
          }
        } else if (result && result.ignored) {
          // A concurrent acceptance is already in flight; its resume replays the
          // newest stash (newest message wins — never a duplicate). Leave it be.
        } else {
          // Blocked (e.g. an unresolved exercise): drop the stash and SURFACE it so
          // the set is never silently swallowed. The athlete can retype and resend.
          blockedLogText = null;
          setStatus(loggerStatus, (result && result.message) || "Atlas couldn't start that plan just now — try again.", 'error');
        }
      }).catch(() => {
        blockedLogText = null;
        setStatus(loggerStatus, "Atlas couldn't start that plan just now — try again.", 'error');
      });
      // Nothing committed yet: clear the parsed table AND the reparse memo, so the
      // resumed (identical) text re-parses instead of collecting an empty table.
      if (setsTableBody) setsTableBody.innerHTML = '';
      lastParsedWorkoutText = '';
      activeExercise = null;
      return;
    }
    // Substitution classification: if the parser extracted a skip-notation pair
    // ("Deadlift skipped - platform busy"), classify it here where lastPrescribed
    // and the log rows are already assembled, then pass the engine's verdict into
    // the event so coach-conversation.js only words it — never calls a write path.
    // Best-effort: any failure is silent and never blocks the mid-session set note.
    let midSessionSubstitutions = [];
    let midSessionEnrichment = null;
    const hasPrescribed = Array.isArray(lastPrescribed) && lastPrescribed.length > 0;
    const hasPlan = getActivePlannedSession() && getActivePlannedSession().exercises.length > 0;
    if (hasPrescribed || hasPlan) {
      try {
        const loggedExercise = logRows[0] ? logRows[0].exercise || '' : '';
        const subPayload = {
          session_id: sessionId,
          date,
          test_mode: 'true',
          prescribed: hasPrescribed ? lastPrescribed.map(p => ({
            exercise: p.exercise,
            logged_exercise: loggedExercise,
            ...(p.reason ? { reason: p.reason } : {})
          })) : [],
          log_rows: logRows
        };
        if (hasPlan) {
          // Send only the current plan step, not the full plan. Use canonical session
          // so a stale cursor (after logging without clicking "Next") never reports the
          // already-logged exercise as the active plan step.
          const currentEx = currentPlannedExercise();
          if (currentEx) {
            subPayload.plan_exercises = [{
              name: currentEx.canonicalName || currentEx.name,
              ...(currentEx.liftCode ? { lift_code: currentEx.liftCode } : {})
            }];
          }
        }
        const subResult = await api('/api/log-workout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subPayload)
        }).catch(() => null);
        midSessionSubstitutions = subResult?.data?.substitutions || [];
        // Enrichment gives us canonical_exercise + lift_code per row so that
        // resolveCompletedIdentity can map the logged name back to the planned
        // exercise name (e.g. "Barbell Row" → "Rows" via matching lift_code).
        midSessionEnrichment = subResult?.data?.enrichment || null;
      } catch { /* best-effort — classification never blocks the set note */ }
    }
    // F09G: a real set log supersedes any held bodyweight-rep clarification (the lifter
    // moved on and logged other work without affirming it).
    clearPendingClarification();
    // F10S2 — a one-turn "<substitute log> instead of <original>" directive rode the
    // parse; arm the EXISTING deferred-swap lane (Step 373b) so this log's first
    // exercise replaces the named planned slot, binding to its original plan_item_id
    // (outcome + F10B revision + completion identity all follow that one lane).
    // One-shot either way — a directive with no active plan simply drops.
    if (lastParseSubstitution && getActivePlannedSession()) {
      setPendingSubstitution({ prescribed: lastParseSubstitution, prescription: null });
    }
    lastParseSubstitution = null;
    emitSetLogged(logRows, pendingChatText, midSessionSubstitutions, midSessionEnrichment);
    const loggedSessionId = ((logRows || [])
      .find(row => row && typeof row.session_id === 'string' && row.session_id.trim())
      ?.session_id || '').trim();
    latestSetResponseCompletion = waitForTurnResponse({ sessionId: loggedSessionId });
    return;
  }
  // F10D — remember whether THIS preview is the session closeout before the
  // one-shot flag resets. EVERY end-of-session trigger counts (Codex P1, PR
  // #1069): the compiled "done"/"log it"/Finish path (the flag), typed manual
  // effort attached to buffered rows, AND a screenshot uploaded with rows (the
  // converted lane above — flagged separately so an unreadable screenshot's
  // rows-only closeout still gets its confirmation).
  const isSessionCloseout = sessionCompiledAwaitingPreview === true
    || closeoutPreviewStaged === true   // #1123: a re-preview of an already-staged closeout is still a closeout
    || (logRows.length > 0 && Boolean(manualEffort))
    || screenshotConvertedCloseout;
  sessionCompiledAwaitingPreview = false;
  // #1123: latch the closeout stage so it survives the single-use flag reset above. From
  // here a re-preview/edit that parses no new input rebuilds the closeout preview from the
  // editor table (the mid-workout append lane above is skipped for it), until the session
  // resets on a verified write or deliberate Start Over.
  if (isSessionCloseout) closeoutPreviewStaged = true;

  const previewBtn = document.getElementById('preview-btn');
  previewBtn.disabled = true;
  previewBtn.textContent = 'Previewing…';

  // Multiple sessions per day: a fresh effort-only upload (a later run/ride after the
  // gym session was already saved) must NOT be forced to …-01 and collide with the
  // earlier session. When the owner hasn't explicitly tagged a session_id, send it BLANK
  // for effort-only uploads so the server auto-increments (…-02, …-03 via
  // nextAvailableSessionId). A concluded save clears #log-session-id, so the next upload
  // starts blank = "a new session". Uploads that carry workout rows keep the resolved id
  // so Log_Cleaned and Effort never disagree on session_id (BACKLOG: multi-session for
  // screenshot-with-sets).
  const explicitSessionId = sessionIdInput.value.trim();
  const completeWorkoutSessionId = effortOnly ? explicitSessionId : sessionId;

  try {
    // F07 / CLIENT-3: a newer preview submit superseded this one during the parse — abandon
    // this stale request before issuing its dry-run so it can't overwrite the newer preview.
    if (submitSeq !== previewRequestSeq) return;
    if (mode === 'screenshot' && file) {
      if (!file) throw new Error('Choose a screenshot file, or switch to manual effort entry.');

      // B5 (owner live bug 07-02): #log-date is auto-filled with today, so sending it
      // unconditionally stamped every screenshot save with an owner-"typed" date — and
      // a manual date beats the screenshot date server-side, so the screenshot's own
      // date could NEVER win and date_source read 'manual', suppressing even the
      // today-fallback warning. Send the date ONLY when the owner actually entered one
      // (logDateManuallyEntered — a real input event, same flag RC2 uses); blank lets
      // the server resolve screenshot-date → today-fallback and report an honest
      // date_source. Mirrors the RC5 blank-session_id pattern. Preview ↔ write parity
      // holds: pendingWrite.date below captures the server-RESOLVED date, which the
      // approve step re-sends, so what was previewed is exactly what is written.
      const screenshotDateField = logDateManuallyEntered ? date : '';
      const correlationPreview = beginCorrelatedPreview({
        sessionId: completeWorkoutSessionId || sessionId,
        ...(!completeWorkoutSessionId ? { provisionalSessionId: sessionId } : {}),
      });
      activePreviewCorrelation = correlationPreview;
      const result = await submitCompleteWorkout({ file, logRows, sessionId: completeWorkoutSessionId,
        date: screenshotDateField,
        location, notes, testMode: true, correlationPreview
      });
      if (!hasCompleteWorkoutNoWriteProof(result)) {
        throw new Error('Preview did not prove no-write safety. Nothing can be written.');
      }
      // F07 / CLIENT-3: a newer submit superseded this one while its dry-run was in flight —
      // drop the stale response BEFORE it stamps the shared #log-date / #log-session-id or
      // rebuilds the pending write.
      if (submitSeq !== previewRequestSeq) return;
      const resolvedData = result?.data?.data || {};
      const resolvedDate = resolvedData.date || date || getLocalDateString();
      const resolvedSessionId = resolvedData.session_id || sessionId || generateSessionId(resolvedDate);
      if (correlationPreview && !resolveCorrelatedPreviewSession(correlationPreview, resolvedSessionId)) {
        throw new Error('Preview session correlation could not be bound to the server-resolved session.');
      }
      document.getElementById('log-date').value = resolvedDate;
      sessionIdInput.value = resolvedSessionId;
      pendingWrite = {
        mode: 'screenshot',
        file,
        logRows,
        sessionId: resolvedSessionId,
        date: resolvedDate,
        location,
        notes,
        effortOnly,
        writeId: generateWriteId(),
        correlationPreview,
        // The effort metrics the owner is reviewing. On approval we write THESE,
        // not a second vision parse of the same image — so what gets saved is
        // exactly what was shown. See the approve handler's screenshot branch.
        parsedEffort: resolvedData.parsed_effort || null,
        // Already-saved session (re-used dated screenshot): the dry-run flags it; the
        // live write would refuse it, so gate approve off rather than send the owner
        // into a "Duplicate session" error on tap.
        duplicateSession: Boolean(resolvedData.duplicate_check && resolvedData.duplicate_check.duplicate_session),
        previewProof: previewProofFromResult(result, 'screenshot')
      };
      renderCompleteWorkoutPreview(result);
    } else if (effortOnly) {
      const correlationPreview = beginCorrelatedPreview({
        sessionId: completeWorkoutSessionId || sessionId,
        ...(!completeWorkoutSessionId ? { provisionalSessionId: sessionId } : {}),
      });
      activePreviewCorrelation = correlationPreview;
      const result = await submitCompleteWorkout({ logRows, sessionId: completeWorkoutSessionId, date,
        location, notes,
        manualEffort, testMode: true, correlationPreview
      });
      if (!hasCompleteWorkoutNoWriteProof(result)) {
        throw new Error('Preview did not prove no-write safety. Nothing can be written.');
      }
      // F07 / CLIENT-3: drop a superseded dry-run response BEFORE it stamps #log-session-id or
      // rebuilds the pending write (see the screenshot branch above).
      if (submitSeq !== previewRequestSeq) return;
      // Capture the server-resolved session_id (auto-incremented when we sent it blank) so
      // the live write reuses the SAME id the preview computed, and the field/summary show
      // the real …-02 instead of a forced …-01. Mirrors the screenshot branch above.
      const resolvedEffortData = result?.data?.data || {};
      const resolvedEffortSessionId = resolvedEffortData.session_id || completeWorkoutSessionId || sessionId;
      if (correlationPreview && !resolveCorrelatedPreviewSession(correlationPreview, resolvedEffortSessionId)) {
        throw new Error('Preview session correlation could not be bound to the server-resolved session.');
      }
      sessionIdInput.value = resolvedEffortSessionId;
      pendingWrite = { mode: 'effort-only', logRows, sessionId: resolvedEffortSessionId, date, location, notes, manualEffort, effortOnly: true, writeId: generateWriteId(), correlationPreview,
        // Mirror the screenshot path: an already-saved session disables approve so the
        // graceful "already saved" preview note doesn't lead to a live 409 on tap.
        duplicateSession: Boolean(result?.data?.data?.duplicate_check?.duplicate_session),
        previewProof: previewProofFromResult(result, 'effort-only') };
      renderCompleteWorkoutPreview(result);
    } else {
      const effortRow = manualEffort;

      // A converted screenshot closeout carries its RESOLVED identity on the
      // payload — the same identity its re-stamped rows and effort row carry —
      // so the summary, seal, and finalized event address the same session the
      // appends are stamped with (Codex P1, this PR).
      const payload = {
        session_id: screenshotResolvedSessionId || sessionId,
        date: screenshotResolvedDate || date,
        log_rows: logRows, test_mode: 'true', write_id: generateWriteId()
      };
      if (effortRow) payload.effort_row = effortRow;
      // F10D — the session closeout sends the confirmation context, so the dry-run
      // returns the single-confirmation summary and the SAME approved payload seals
      // the ledger AND records the finalized Session_Plans closeout event under its
      // write_id (server-side, with proof — Codex P1, PR #1069). The accepted
      // plan's opaque pv_ token rides along so the server can address the event;
      // freestyle sessions send it blank. Per-message previews never send any of it.
      if (isSessionCloseout) {
        payload.closeout_context = {
          plan_version: (getActivePlannedSession() && getActivePlannedSession().accepted === true
            && getActivePlannedSession().plan_version) || '',
          items: closeoutContextItems(),
        };
      }
      if (lastPrescribed && lastPrescribed.length > 0 && logRows.length > 0) {
        const loggedExercise = logRows[0].exercise || '';
        payload.prescribed = lastPrescribed.map(p => ({ exercise: p.exercise, logged_exercise: loggedExercise, ...(p.reason ? { reason: p.reason } : {}) }));
      }
      if (getActivePlannedSession() && getActivePlannedSession().exercises.length > 0) {
        // B2: derive the closeout plan_exercises from the canonical active session
        // (the same model the card / coach / preview / mid-session sub-payload read),
        // not the raw activePlannedSession holder — so the save payload can never
        // disagree with the visible session. Off-plan inserts are excluded so a
        // logged accessory is never mis-attributed as a prescribed substitution
        // source. Falls back to the raw plan only when the canonical model is
        // unavailable, so this never regresses a session that has no canonical view.
        const canon = getCanonicalSession();
        const canonicalPlan = canon ? planExercisesFromCanonical(canon) : [];
        payload.plan_exercises = canonicalPlan.length
          ? canonicalPlan
          : getActivePlannedSession().exercises.map(ex => ({
              name: ex.name,
              ...(ex.liftCode ? { lift_code: ex.liftCode } : {})
            }));
      }

      const correlationPreview = beginCorrelatedPreview({ sessionId: payload.session_id });
      activePreviewCorrelation = correlationPreview;
      if (correlationPreview) payload.correlation = correlationPreview.correlation;
      const result = await api('/api/log-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // Cold-start resilience: this is the test_mode DRY-RUN preview (idempotent,
        // proof-field-guarded, no write) — safe to retry once on a transport failure.
        // The live write at the approve handler never sets this.
        retryTransport: true,
        ...(correlationPreview ? {
          responseHeaders: responseHeaders => completeCorrelatedPreview(correlationPreview, responseHeaders)
        } : {})
      });
      if (!hasLogWorkoutNoWriteProof(result)) {
        throw new Error('Preview did not prove no-write safety. Nothing can be written.');
      }
      // F07 / CLIENT-3: drop a superseded dry-run response — a newer submit's preview wins.
      if (submitSeq !== previewRequestSeq) return;
      pendingWrite = { mode: 'manual', payload, sessionCloseout: isSessionCloseout,
        correlationPreview,
        previewProof: previewProofFromResult(result, 'manual')
      };
      renderLogWorkoutPreview(result, effortRow);
    }
    // Session-level save: the in-thread review card (atlas:preview-ready) is the
    // single review surface, so the legacy #preview-panel stays hidden. Its
    // #approve-btn remains the gated write trigger that the review card's Save
    // clicks — enabled here only once the dry-run proved no-write safety.
    previewPanel.hidden = true;
    parsedRowsEditor.hidden = false;
    // An already-saved session has nothing new to write and the live write would 409,
    // so gate approve off and say so — no dead-end "Duplicate session" on tap.
    const alreadySaved = Boolean(pendingWrite && pendingWrite.duplicateSession);
    document.getElementById('approve-btn').disabled = alreadySaved || !pendingWriteHasPreviewProof(pendingWrite);
    const gateNote = document.getElementById('preview-gate-note');
    if (gateNote) gateNote.textContent = alreadySaved
      ? 'This workout is already saved — nothing new to write.'
      : effortOnly
        ? 'Review the dry-run above, then click to write Effort only.'
        : 'Review the dry-run above, then click to write.';
  } catch (err) {
    // Surface the server's INNER cause when present (api() carries the response body
    // on err.body; standardError puts the detail at body.details.error). The generic
    // "Failed to complete workout ingestion" hid WHY the screenshot/effort preview
    // 500'd — show the cause so it's diagnosable from the gym (live-gym v49).
    const d = err && err.body && err.body.details;
    const detail = d && (typeof d === 'string' ? d : (d.error || null));
    // A transport-level failure (post-retry) gets the honest cold-start line
    // instead of Safari's cryptic "Load failed"; HTTP errors keep the server copy.
    const friendly = friendlyTransportMessage(err);
    const fullMsg = friendly
      ? `Preview failed: ${friendly}`
      : `Preview failed: ${err.message}${detail ? ` — ${detail}` : ''}`;
    // Highlight any rows the server named in the error (e.g. "row 2: rir must be 0–10").
    const badRowNums = [...fullMsg.matchAll(/\brow\s+(\d+)\b/gi)].map(m => Number(m[1]) - 1);
    if (badRowNums.length && setsTableBody) {
      Array.from(setsTableBody.children).forEach((tr, idx) => {
        tr.classList.toggle('row-error', badRowNums.includes(idx));
      });
      setStatus(loggerStatus, fullMsg + ' — Fix or delete the highlighted row(s), then Preview again.', 'error');
    } else {
      setStatus(loggerStatus, fullMsg, 'error');
    }
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview — no data saved';
  }
});

// Pre-fill the manual effort form fields with parsed values so the user can
// correct them (e.g. add a missing peak HR) and re-preview.
function prefillEffortForm(effort) {
  if (!effort) return;
  const dur = document.getElementById('effort-duration');
  const cal = document.getElementById('effort-active-cal');
  const tot = document.getElementById('effort-total-cal');
  const avg = document.getElementById('effort-avg-hr');
  const peak = document.getElementById('effort-peak-hr');
  const radio = document.querySelector('input[name="effort-mode"][value="manual"]');
  const details = document.getElementById('effort-details');

  if (dur && effort.duration != null) dur.value = effort.duration;
  if (cal && effort.activeCalories != null) cal.value = effort.activeCalories;
  if (tot && effort.totalCalories != null) tot.value = effort.totalCalories;
  if (avg && effort.averageHR != null) avg.value = effort.averageHR;
  if (peak && effort.peakHR != null) peak.value = effort.peakHR;
  if (radio && !radio.checked) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (details) { details.hidden = false; details.open = true; }
  document.getElementById('effort-details')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (peak && effort.peakHR == null) peak.focus();
}

// Map the previewed/normalized effort metrics back to the effort_json shape the
// backend's manual-effort path accepts (normalizeManualEffortMetrics). A missing
// peak HR is preserved as-is (null/'' is optional and survives the round trip).
function effortJsonFromParsedEffort(effort) {
  if (!effort) return null;
  return {
    duration: effort.duration,
    activeCalories: effort.activeCalories,
    totalCalories: effort.totalCalories,
    averageHR: effort.averageHR,
    peakHR: effort.peakHR,
    workoutType: effort.workoutType
  };
}

async function submitCompleteWorkout({
  file, logRows, sessionId, date, location, notes, manualEffort, testMode, writeId,
  correlationPreview
}) {
  const form = new FormData();
  if (file) form.append('image', file);
  form.append('log_rows_json', JSON.stringify(logRows || []));
  if (sessionId) form.append('session_id', sessionId);
  if (date) form.append('date', date);
  if (location) form.append('location', location);
  if (notes) form.append('notes', notes);
  if (manualEffort) form.append('effort_json', JSON.stringify(manualEffort));
  if (testMode) form.append('test_mode', 'true');
  // Only the live write carries the write_id; the server uses it to refuse a
  // retried append. Dry-run previews never consume idempotency state.
  if (writeId && !testMode) form.append('write_id', writeId);
  const correlation = testMode
    ? correlationPreview?.correlation
    : approvalCorrelation(correlationPreview);
  if (correlation) form.append('correlation', JSON.stringify(correlation));
  // Cold-start resilience: DRY-RUN previews may retry once on a transport-level
  // failure (idempotent, no write). The live write never sets this.
  return api('/api/complete-workout', {
    method: 'POST',
    body: form,
    ...(testMode ? { retryTransport: true } : {}),
    ...(testMode && correlationPreview ? {
      responseHeaders: responseHeaders => completeCorrelatedPreview(correlationPreview, responseHeaders)
    } : {})
  });
}

async function parseWorkoutImage(file) {
  const form = new FormData();
  form.append('image', file);
  const result = await api('/api/parse-workout-image', { method: 'POST', body: form });
  const parsed = result?.data?.parsed || null;
  if (!parsed) throw new Error('No effort metrics returned from screenshot.');
  return parsed;
}

// Compact one-line confirmation of what the write will contain. The full
// per-set detail is already editable in the "Edit parsed rows" table, so the
// preview only needs the count + exercises + session for a final sanity check.
function renderRowsSummary(rows) {
  if (!rows || !rows.length) {
    return el('div', { class: 'preview-rows-summary', text: 'No workout sets to write.' });
  }
  const counts = new Map();
  for (const r of rows) {
    const name = r[2] || 'Unknown';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const exercises = [...counts.entries()].map(([name, n]) => `${name} ×${n}`).join(', ');
  const date = rows[0][0] || '';
  const sessionId = rows[0][1] || '';
  return el('div', { class: 'preview-rows-summary' }, [
    el('strong', { text: `${rows.length} set${rows.length === 1 ? '' : 's'} to write` }),
    el('span', { text: ` — ${exercises}` }),
    el('span', { class: 'preview-rows-meta', text: [date, sessionId].filter(Boolean).join(' · ') })
  ]);
}

function renderWarnings(warnings) {
  if (!warnings || !warnings.length) {
    return el('div', { class: 'preview-ok', text: 'No warnings. All exercises matched the catalog.' });
  }
  return el('div', { class: 'preview-warnings' }, [
    el('strong', { text: 'Warnings — review before approving:' }),
    el('ul', {}, warnings.map(w => el('li', { text: w })))
  ]);
}

function renderAutoMatches(autoMatches) {
  if (!autoMatches || !autoMatches.length) return null;
  return el('div', { class: 'preview-auto-match' }, [
    el('strong', { text: 'Auto-matched — verify these are correct:' }),
    el('ul', {}, autoMatches.map(m => el('li', { text: m })))
  ]);
}

function renderRuleFlags(ruleFlags) {
  if (!ruleFlags || !ruleFlags.length) return null;
  const severityClass = ruleFlags.some(f => f.severity === 'error')
    ? 'preview-warnings'
    : ruleFlags.some(f => f.severity === 'warning') ? 'preview-warnings' : 'preview-auto-match';
  return el('div', { class: severityClass }, [
    el('strong', { text: 'Coach flags:' }),
    el('ul', {}, ruleFlags.map(f => el('li', { text: f.reasoning })))
  ]);
}

function renderUnknownExerciseSuggestions(pendingExercises) {
  if (!pendingExercises || !pendingExercises.length) return null;
  const items = pendingExercises.map(pe => {
    const matches = pe.closest_matches || [];
    const hint = matches.length
      ? `Did you mean: ${matches.map(m => `${m.canonical_exercise}${m.lift_code ? ` (${m.lift_code})` : ''}`).join(', ')}`
      : 'No close catalog matches found — add this exercise to Exercise_Catalog.';
    return el('li', {}, [
      el('strong', { text: `"${pe.exercise}" — ` }),
      document.createTextNode(hint)
    ]);
  });
  return el('div', { class: 'preview-warnings' }, [
    el('strong', { text: 'Unknown exercises — catalog suggestions:' }),
    el('ul', {}, items)
  ]);
}

function renderLogWorkoutPreview(result, effortRow) {
  const data = result.data || {};
  previewContent.innerHTML = '';
  const parseStatus = parserStatusNode(lastParserStatus);
  if (parseStatus) previewContent.appendChild(parseStatus);
  const logAutoMatches = renderAutoMatches(data.auto_matches);
  if (logAutoMatches) previewContent.appendChild(logAutoMatches);
  previewContent.appendChild(renderWarnings(data.warnings));
  const logRuleFlags = renderRuleFlags(data.rule_flags);
  if (logRuleFlags) previewContent.appendChild(logRuleFlags);
  const logSuggestions = renderUnknownExerciseSuggestions(data.pending_exercises);
  if (logSuggestions) previewContent.appendChild(logSuggestions);
  // RC2: when this save came from a closeout screenshot, show the chosen workout date
  // and its source so the owner sees (and can correct) it before approving. The date
  // shown is exactly the one in the write payload, so preview ↔ saved date can't drift.
  if (closeoutScreenshotDateSource) {
    const dsDate = (pendingWrite && pendingWrite.payload && pendingWrite.payload.date)
      || document.getElementById('log-date').value || '';
    const dsNotice = renderDateSourceNotice(closeoutScreenshotDateSource, dsDate);
    if (dsNotice) previewContent.appendChild(dsNotice);
  }
  previewContent.appendChild(renderRowsSummary(data.log_rows_preview || []));
  // Show exercises already saved earlier in this same workout (display only) so the
  // confirm card reflects the FULL session, not just the post-save buffer. Additive:
  // it never affects data.log_rows_preview or the write payload.
  const savedRecap = renderSavedThisSessionRecap();
  if (savedRecap) previewContent.appendChild(savedRecap);
  if (effortRow) {
    previewContent.appendChild(el('h3', { text: 'Effort row to write' }));
    previewContent.appendChild(renderTable(
      ['Date', 'Session', 'Duration', 'Active cal', 'Total cal', 'Avg HR', 'Peak HR', 'Location', 'Notes'],
      [data.effort_row_preview || Object.values(effortRow)]
    ));
  }
  const liftCodes = extractLiftCodes(data.log_rows_preview);
  if (pendingWrite) pendingWrite.liftCodes = liftCodes;
  if (liftCodes.length && isConnected()) {
    // Per-exercise in-preview coaching: each lift's last set + a coaching hint.
    // Read-only and best-effort — a failed lookup for one lift just drops its
    // card and never blocks the preview or the save.
    const coachBox = el('div', {}, [el('div', { class: 'muted small', text: 'Coaching' })]);
    previewContent.appendChild(coachBox);
    for (const code of liftCodes) {
      const slot = el('div', {});
      coachBox.appendChild(slot);
      const todaySets = previewSetsForLift(data.log_rows_preview, code);
      fetchReaction(code).then(rec => {
        const node = renderPreviewCoachCard(rec, code, todaySets);
        if (node) slot.replaceWith(node);
      }).catch(() => {});
    }
  }
  // Manual effort + sets writes via /api/log-workout; surface its metrics in the
  // single review card too (normalize the snake_case effort_row to the grid shape).
  const reviewEffort = effortRow ? {
    duration: effortRow.duration,
    activeCalories: effortRow.active_calories,
    totalCalories: effortRow.total_calories,
    averageHR: effortRow.average_hr,
    peakHR: effortRow.peak_hr
  } : null;
  // B5: the log-workout preview's date is the write-payload date; the source is the
  // closeout-screenshot resolution when one ran (RC2), else 'manual' only when the
  // owner actually typed a date. A plain default-today set log passes source null,
  // so ordinary set logging renders no date notice — unchanged look.
  const logDateInfo = {
    date: (pendingWrite && pendingWrite.payload && pendingWrite.payload.date)
      || document.getElementById('log-date').value || '',
    source: closeoutScreenshotDateSource || (logDateManuallyEntered ? 'manual' : null)
  };
  emitCoachPreview(data.log_rows_preview, liftCodes, false, reviewEffort, data.substitutions,
    logDateInfo.source ? logDateInfo : null, data.closeout_summary || null);
}

function renderCompleteWorkoutPreview(result) {
  // complete-workout nests its body one level deeper than log-workout
  const outer = result.data || {};
  const data = outer.data || {};
  const effortOnly = data.effort_only === true;
  previewContent.innerHTML = '';
  const parseStatus = parserStatusNode(lastParserStatus);
  if (parseStatus) previewContent.appendChild(parseStatus);
  const completeAutoMatches = renderAutoMatches(outer.auto_matches);
  if (completeAutoMatches) previewContent.appendChild(completeAutoMatches);
  previewContent.appendChild(renderWarnings(outer.warnings));
  const completeSuggestions = renderUnknownExerciseSuggestions(outer.pending_exercises);
  if (completeSuggestions) previewContent.appendChild(completeSuggestions);

  // B5: surface the resolved workout date and its source so the owner can catch
  // a mismatch (e.g. a June 12 screenshot imported on June 26 defaulting to today).
  // When the date fell back to today — because the screenshot date wasn't visible
  // or extractable — show a warning and prompt correction BEFORE the approve step.
  const completeDateNotice = renderDateSourceNotice(data.date_source, data.date || '');
  if (completeDateNotice) previewContent.appendChild(completeDateNotice);

  const dup = data.duplicate_check || {};
  if (dup.duplicate_session) {
    // The effort session is already on the sheet (e.g. re-importing the same dated
    // screenshot). The dry-run surfaces this gracefully instead of a hard "Duplicate
    // session" error; the live write still refuses to double-save (approve is disabled
    // below). Word it as "already saved", never as a failure.
    const sess = data.session_id ? ` (session ${data.session_id})` : '';
    previewContent.appendChild(el('div', { class: 'preview-warnings preview-date-warning',
      text: `✓ This workout is already saved${sess}. Nothing new will be written — you don't need to save it again.` }));
  }
  if (dup.duplicate_log_rows > 0) {
    previewContent.appendChild(el('div', { class: 'preview-warnings', text: `${dup.duplicate_log_rows} row(s) will be skipped as duplicates.` }));
  }

  if (effortOnly) {
    previewContent.appendChild(el('div', { class: 'preview-ok', text: 'Effort-only preview — no workout sets will be written.' }));
  } else {
    previewContent.appendChild(renderRowsSummary(data.rows_to_write || []));
  }
  const completeLiftCodes = extractLiftCodes(data.rows_to_write);
  if (pendingWrite) pendingWrite.liftCodes = completeLiftCodes;
  // B5: the server resolved this preview's date (manual > screenshot > today) and
  // reports the source — hand both to the review card so the owner SEES the date
  // (and the today-fallback warning) on the conversation surface, not just in the
  // hidden legacy panel above.
  emitCoachPreview(data.rows_to_write, completeLiftCodes, effortOnly, data.parsed_effort || null, null,
    data.date ? {
      date: data.date,
      source: data.date_source || null,
      // The implausible screenshot date the server refused (e.g. a weekday-matched
      // wrong year) — the card words the fallback honestly and offers the picker.
      ...(data.screenshot_date_rejected ? { rejected: data.screenshot_date_rejected } : {})
    } : null);
  if (completeLiftCodes.length && isConnected()) {
    const suggestionSlot = el('div', {});
    previewContent.appendChild(suggestionSlot);
    fetchReaction(completeLiftCodes[0]).then(rec => {
      const node = renderAtlasSuggestion(rec);
      if (node) suggestionSlot.replaceWith(node);
    }).catch(() => {});
  }

  // Effort details collapse behind "Review technical details" — the in-thread
  // .review card (with the watch metrics) is the primary view for screenshots.
  const effort = data.parsed_effort || {};
  const peakHrCell = effort.peakHR == null ? 'not visible in screenshot' : effort.peakHR;
  const effortDetailsInner = el('div', {}, [
    el('h3', { text: data.effort_source === 'manual'
      ? 'Parsed effort (manual entry)'
      : (data.effort_source === 'screenshot_unreadable' || data.screenshot_unreadable)
        ? "Effort couldn't be read from the screenshot"
        : 'Parsed effort (from screenshot)' }),
    renderTable(
      ['Duration', 'Active cal', 'Total cal', 'Avg HR', 'Peak HR', 'Type'],
      [[effort.duration, effort.activeCalories, effort.totalCalories, effort.averageHR, peakHrCell, effort.workoutType]]
    )
  ]);
  if (effort.peakHR == null) {
    const chip = el('div', { class: 'effort-missing-chip' });
    chip.innerHTML = '&#9888;&#65039; Peak HR not captured — ';
    const fixLink = el('a', { href: '#', class: 'effort-fix-link', text: 'enter it manually' });
    fixLink.addEventListener('click', ev => { ev.preventDefault(); prefillEffortForm(effort); });
    chip.appendChild(fixLink);
    effortDetailsInner.appendChild(chip);
  } else {
    const editLink = el('a', { href: '#', class: 'effort-fix-link', text: 'Edit effort values' });
    editLink.addEventListener('click', ev => { ev.preventDefault(); prefillEffortForm(effort); });
    effortDetailsInner.appendChild(editLink);
  }
  effortDetailsInner.appendChild(el('p', { class: 'muted', text: `Session quality score: ${data.quality_score ?? '—'} / 100` }));
  previewContent.appendChild(el('details', { class: 'preview-technical-details' }, [
    el('summary', { text: 'Review technical details' }),
    effortDetailsInner
  ]));
  const approveBtn = document.getElementById('approve-btn');
  approveBtn.textContent = effortOnly ? 'Write Effort to Google Sheets' : 'Write to Google Sheets';
}

document.getElementById('cancel-preview-btn').addEventListener('click', invalidatePreview);

async function handleUndoLastWrite(expected) {
  if (!lastWrite) return;
  // CLIENT-1 guard (audit 2026-07-07): a saved review card binds the identity of
  // the write it represents (its log_appended_range) at save time. If that no
  // longer matches the current lastWrite, a NEWER write has since happened — refuse,
  // so an older card's Undo can never delete the newer write. `expected` is null for
  // the direct "Undo last write" button and for effort-only cards (which target the
  // latest write by definition); the appended range uniquely identifies the rows, so
  // it is the sole discriminator (session_id is server-minted and only forwarded).
  if (expected && expected.log_appended_range
      && expected.log_appended_range !== lastWrite.log_appended_range) {
    setStatus(loggerStatus, 'That workout is no longer your most recent save — Undo only affects your latest write.', 'error');
    return;
  }
  const { log_appended_range, session_id, log_rows_written } = lastWrite;
  const undoBtn = loggerStatus.querySelector('.undo-write-btn');
  if (undoBtn) {
    undoBtn.disabled = true;
    undoBtn.textContent = 'Undoing…';
  }
  try {
    await api('/api/log-workout/undo-last', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        log_appended_range,
        session_id,
        rows_to_delete: log_rows_written,
        confirm_delete: true
      })
    });
    lastWrite = null;
    setHistoryLoaded(false); // sheet changed — History re-fetches on next visit
    setStatus(loggerStatus, 'Last write undone.', 'ok');
  } catch (err) {
    setStatus(loggerStatus, `Undo failed: ${err.message}`, 'error');
    if (undoBtn) {
      undoBtn.disabled = false;
      undoBtn.textContent = 'Undo last write';
      loggerStatus.appendChild(undoBtn);
    }
  }
}

// The end-of-session review card's "Undo" reuses this exact backend path —
// no reimplementation of the undo/delete logic. A card may pass its bound write
// identity so the guard above can refuse a stale card (CLIENT-1).
window.atlasUndoLastWrite = handleUndoLastWrite;

// CLIENT-1: review cards bind their write identity at save time so their Undo can
// be refused once a newer write supersedes it. Returns a snapshot copy (never the
// live ref) of the current write's identity, or null when there is no undoable write.
window.atlasCurrentWriteIdentity = () => (lastWrite && lastWrite.log_appended_range)
  ? { log_appended_range: lastWrite.log_appended_range, session_id: lastWrite.session_id }
  : null;

document.getElementById('approve-btn').addEventListener('click', async () => {
  if (writeInFlight) return;
  if (!pendingWriteHasPreviewProof(pendingWrite)) {
    setStatus(loggerStatus, 'No previewed workout to approve. Run a preview first.', 'error');
    invalidatePreview();
    return;
  }

  writeInFlight = true;
  const approveBtn = document.getElementById('approve-btn');
  approveBtn.disabled = true;
  approveBtn.textContent = 'Writing to Sheets…';

  const reactionLiftCodes = pendingWrite.liftCodes || [];
  // Captured up front — the preview teardown below nulls pendingWrite, and
  // the success message still needs to know which kind of write this was.
  const wasEffortOnly = pendingWrite.effortOnly === true;
  const wasModality = pendingWrite.mode === 'modality';
  // F10D — a session closeout's approval also seals the plan ledger; the success
  // copy must reflect the seal verdict honestly, and the finalized closeout event
  // records only on THIS approval (rejection writes nothing).
  const wasSessionCloseout = pendingWrite.sessionCloseout === true;
  let closeoutSealUnverified = false;
  let pendingLastWrite = null;
  let duplicateBlocked = false;
  try {
    if (pendingWrite.mode === 'screenshot' || pendingWrite.mode === 'effort-only') {
      const writeArgs = { ...pendingWrite, testMode: false };
      // Write the previewed metrics, not a re-parse: send effort_json, drop the image.
      if (pendingWrite.mode === 'screenshot' && pendingWrite.parsedEffort) {
        writeArgs.file = null;
        writeArgs.manualEffort = effortJsonFromParsedEffort(pendingWrite.parsedEffort);
      }
      const writeResult = await submitCompleteWorkout(writeArgs);
      const writeData = writeResult?.data?.data || {};
      // Server-side idempotency: a retried write_id is refused with proof the
      // original write completed. Strict — accept only when the original itself
      // confirmed a sheet write.
      duplicateBlocked = writeData.duplicate_write === true &&
        writeData.sheet_write === 'skipped_duplicate' &&
        writeData.original_sheet_written === true;
      if (!duplicateBlocked) {
        if (writeData.effort_only === true) {
          if (writeData.effort_written !== true || writeData.sheet_written !== true) {
            throw new Error('Effort-only write did not confirm an Effort sheet write. Verify Sheets before approving again.');
          }
        } else {
          const rowsWritten = writeData.log_rows_written;
          if (!rowsWritten || rowsWritten === 0) {
            throw new Error(`Write completed but log_rows_written=${rowsWritten ?? 'missing'}. Verify Sheets before approving again.`);
          }
        }
      }
    } else if (pendingWrite.mode === 'modality') {
      // Live modality write — mirrors the slash approve branch: omit test_mode so
      // the server performs the real append, carry the write_id from the dry-run
      // for idempotency, and require an explicit success proof before declaring it
      // saved. Writes only to Modality_Log; never touches Log_Cleaned/Effort.
      const modalityPayload = {
        text: pendingWrite.text,
        session_id: pendingWrite.sessionId,
        date: pendingWrite.date,
        write_id: pendingWrite.writeId
      };
      const correlation = approvalCorrelation(pendingWrite.correlationPreview);
      if (correlation) modalityPayload.correlation = correlation;
      const writeResult = await api('/api/log-modality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modalityPayload)
      });
      const writeData = writeResult?.data || {};
      // Idempotent replay: a duplicate write_id is echoed back with sheet_written
      // false; the original row is already on the sheet, so treat it as blocked.
      duplicateBlocked = writeData.duplicate_write === true && writeData.sheet_written === false;
      if (!duplicateBlocked) {
        if (writeData.sheet_write !== 'success' || writeData.sheet_written !== true) {
          throw new Error(`Modality write did not confirm success (sheet_write=${writeData.sheet_write ?? 'missing'}). Check Sheets.`);
        }
      }
    } else {
      const realPayload = { ...pendingWrite.payload };
      delete realPayload.test_mode;
      const correlation = approvalCorrelation(pendingWrite.correlationPreview);
      if (correlation) realPayload.correlation = correlation;
      else delete realPayload.correlation;
      const writeResult = await api('/api/log-workout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(realPayload)
      });
      const writeData = writeResult?.data || {};
      // Server-side idempotency: a retried write_id is refused with proof the
      // original write completed. Strict — all three fields must agree, and
      // the original must itself have been a confirmed success.
      duplicateBlocked = writeData.duplicate_write === true &&
        writeData.sheet_write === 'skipped_duplicate' &&
        writeData.original_sheet_write === 'success';
      if (!duplicateBlocked) {
        if (writeData.sheet_write !== 'success') {
          throw new Error(`Write response did not confirm success (sheet_write=${writeData.sheet_write ?? 'missing'}). Check Sheets.`);
        }
        const logRowsWritten = Number(writeData.log_rows_written || 0);
        const effortRowsWritten = Number(writeData.effort_rows_written || 0);
        if (!(logRowsWritten > 0 || effortRowsWritten > 0)) {
          throw new Error(`Write confirmed but log_rows_written=${writeData.log_rows_written ?? 'missing'} and effort_rows_written=${writeData.effort_rows_written ?? 'missing'}. Verify Sheets before approving again.`);
        }
      }
      // F10D — the verification verdict rides the same response. The SERVER now
      // owns the finalized Session_Plans closeout event (recorded inside this same
      // approved write, with proof — Codex P1, PR #1069), so no client-side
      // fire-and-forget emission remains for the approved path; a rejected
      // confirmation therefore writes nothing at all. `closeout_fully_verified`
      // is false when the ledger seal failed, a planned session had no ledger
      // rows to bind, or the closeout event could not be recorded.
      if (wasSessionCloseout && writeData.closeout_fully_verified === false) {
        closeoutSealUnverified = true;
      }
      // Capture undo details in a local — invalidatePreview() (called below) clears lastWrite.
      // On a blocked duplicate the original response is echoed back, so the
      // same undo details still point at the rows the first write appended.
      if (writeData.logAppendedRange) {
        pendingLastWrite = {
          log_appended_range: writeData.logAppendedRange,
          session_id: realPayload.session_id,
          log_rows_written: writeData.log_rows_written
        };
      }
      // Step 385: mark that this deload session had a confirmed live write so
      // endPlannedSession knows to advance the state machine exactly once.
      if (getActivePlannedSession()?.intentId === 'deload_reset' && !duplicateBlocked) {
        getActivePlannedSession().deloadWritten = true;
      }
    }
    // F10D (Codex P2, PR #1069): keep the promised retry REACHABLE. The rows are
    // committed — only the ledger binding is unverified — so instead of tearing
    // the preview down, keep the staged write alive with a FRESH write_id (the
    // same id would just replay the recorded failed response), drop the
    // already-written effort row (a retry must never 409 on the duplicate-session
    // guard), and re-enable Save. The retry lands in the server's all-duplicate
    // lane: zero re-appends, idempotent seal + closeout-event re-attempt.
    if (closeoutSealUnverified) {
      lastWrite = pendingLastWrite;
      if (pendingWrite && pendingWrite.payload) {
        pendingWrite.payload.write_id = generateWriteId();
        delete pendingWrite.payload.effort_row;
      }
      approveBtn.disabled = false;
      approveBtn.textContent = 'Retry ledger seal';
      setStatus(
        loggerStatus,
        'Workout written to Google Sheets ✓ — but the plan-ledger record could not be verified. Your sets are safe; tap Save again to re-verify (no rows will duplicate).',
        'warn'
      );
      return;
    }
    invalidatePreview();
    setHistoryLoaded(false); clearLiveHintCaches(); // sheet changed
    document.getElementById('logger-form').reset();
    setsTableBody.innerHTML = '';
    parsedRowsEditor.hidden = true;
    lastParsedWorkoutText = '';
    lastParserStatus = null;
    activeExercise = null;
    lastPrescribed = null;
    setDefaultDate();
    setStatus(
      loggerStatus,
      duplicateBlocked
        ? 'Duplicate tap blocked — this workout was already written. ✓'
        : wasModality ? 'Cardio / conditioning written to Google Sheets. ✓'
          : wasEffortOnly ? 'Effort written to Google Sheets. ✓' : 'Workout written to Google Sheets. ✓',
      'ok'
    );
    // Always reflect the write that just happened. Screenshot / effort-only
    // writes produce no undoable log range (pendingLastWrite stays null), so
    // this clears any stale manual range — otherwise a correction after an
    // effort save would Replace-via-undo the wrong (older) rows.
    lastWrite = pendingLastWrite;
    // Remember the exercises this save wrote (DISPLAY ONLY) before the buffer is
    // cleared below, so a later closeout in the SAME workout still shows them in the
    // confirm/review card — a save concludes the session and the next set starts a
    // new session_id, so without this ledger the earlier work looked "missing."
    // Gated on a real log write (pendingLastWrite); effort-only / screenshot saves
    // append no Log_Cleaned rows and are skipped. Never re-written.
    if (pendingLastWrite && Array.isArray(getSessionLog()) && getSessionLog().length) {
      for (const s of getSessionLog()) getSessionSavedLog().push({ exercise: s.exercise });
    }
    // RC4: reset the session on ANY confirmed save — NOT gated on pendingLastWrite (undo
    // state, null for screenshot/effort-only saves). Gating it left a saved session in
    // memory that re-snapshotted and restored as a ghost. endPlannedSession() (not a bare
    // null) keeps Step 385's deload teardown firing before the plan is cleared.
    setSessionLog([]);
    setSessionCompleted([]);
    setSessionRevisions([]); setSessionImplicitRecs([]);
    endPlannedSession();
    closeoutScreenshotFile = null;
    closeoutScreenshotEffort = null;
    // Multiple sessions per day: a saved session is concluded, so clear its session_id from
    // the field. The next upload then starts blank and the server auto-increments it to a
    // NEW session (…-02) instead of re-sending the just-written id and colliding.
    const savedSessionIdField = document.getElementById('log-session-id');
    if (savedSessionIdField) savedSessionIdField.value = '';
    closeoutScreenshotDateSource = null;
    clearSessionSnapshot();   // saved — don't resume this (now-written) session
    document.dispatchEvent(new CustomEvent('atlas:session-reset'));

    if (pendingLastWrite) {
      const undoBtn = el('button', { class: 'secondary undo-write-btn', text: 'Undo last write' });
      // No bound identity — this button always targets the just-completed write.
      // Wrap so the click Event is not passed as the CLIENT-1 expected-identity arg.
      undoBtn.addEventListener('click', () => handleUndoLastWrite());
      loggerStatus.appendChild(undoBtn);
    }
    if (pendingLastWrite?.log_appended_range) {
      verifyWrittenRange(
        pendingLastWrite.log_appended_range,
        pendingLastWrite.session_id,
        pendingLastWrite.log_rows_written
      ).then(ok => {
        loggerStatus.appendChild(el('div', { class: 'parser-status', text: ok
          ? 'Verified in Sheet ✓'
          : 'Write succeeded, but readback verification unavailable' }));
      });
    }
    if (reactionLiftCodes.length) {
      fetchReaction(reactionLiftCodes[0]).then(async rec => {
        if (!rec) return;
        await attachVerdictContext(rec, reactionLiftCodes[0], pendingLastWrite?.session_id);
        const verdict = buildVerdict(rec);
        const lines = [];
        if (verdict) {
          lines.push(el('div', { class: 'suggestion-row' }, [
            el('span', { class: 'suggestion-label', text: 'Logged' }),
            el('span', { text: verdict }),
          ]));
        }
        if (rec.recommendation && rec.next_target) {
          lines.push(el('div', { class: 'suggestion-row' }, [
            el('span', { class: 'suggestion-label', text: 'Next' }),
            el('span', { text: rec.recommendation }),
          ]));
        }
        if (!lines.length) return;
        loggerStatus.appendChild(el('div', { class: 'atlas-suggestion' }, lines));
      }).catch(() => {});
    }
    loadDashboard();
    approveBtn.textContent = 'Written ✓';
  } catch (err) {
    setStatus(loggerStatus, `Write failed: ${err.message}`, 'error');
    approveBtn.disabled = false;
    approveBtn.textContent = 'Write to Google Sheets';
  } finally {
    writeInFlight = false;
  }
});

/* ===== Session loader (correct an existing session) ===== */

document.getElementById('load-session-btn').addEventListener('click', async () => {
  const sessionId = document.getElementById('load-session-id').value.trim();
  const statusBox = document.getElementById('load-session-status');
  if (!sessionId) {
    setStatus(statusBox, 'Enter a session ID first.', 'error');
    return;
  }
  try {
    const res = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const data = res.data || {};
    document.getElementById('log-date').value = data.date || '';
    document.getElementById('log-session-id').value = data.session_id || '';
    setsTableBody.innerHTML = '';
    parsedRowsEditor.hidden = false;
    for (const row of (data.rows || [])) {
      addSetRow({
        exercise: row.exercise,
        set_number: row.set_number,
        weight: row.weight,
        reps: row.reps,
        rir: row.rir,
        notes: row.notes
      });
    }
    lastParsedWorkoutText = workoutTextInput.value.trim();
    invalidatePreview();
    setStatus(statusBox, `Loaded ${data.set_count} sets from session ${sessionId}. Edit what needs fixing, then preview.`, 'ok');
  } catch (err) {
    setStatus(statusBox, `Could not load session: ${err.message}`, 'error');
  }
});

/* ===== Body tab — Bodyweight ===== */

let pendingBwWrite = null;
let activeBwPreviewCorrelation = null;
let bwPreviewSeq = 0;

function hasBodyweightNoWriteProof(result) {
  const data = result?.data || {};
  return data.test_mode === true &&
    data.sheet_write === 'skipped' &&
    data.sheet_written === false &&
    data.no_write_confirmed === true;
}

function pendingBodyweightHasPreviewProof(write) {
  return write?.previewProof?.test_mode === true &&
    write.previewProof.sheet_write === 'skipped' &&
    write.previewProof.sheet_written === false &&
    write.previewProof.no_write_confirmed === true;
}

function hasBodyweightWriteProof(result) {
  const data = result?.data || {};
  const duplicateBlocked = data.duplicate_write === true &&
    data.sheet_write === 'skipped_duplicate' &&
    data.original_sheet_write === 'success';
  return duplicateBlocked || (data.sheet_write === 'success' && data.sheet_written === true);
}

function bwInvalidate() {
  // A form edit, cancel, or newer submit retires every response issued under the
  // previous generation. Late responses can finish, but cannot rebuild approval.
  bwPreviewSeq++;
  if (activeBwPreviewCorrelation) {
    retireCorrelatedPreview(activeBwPreviewCorrelation);
    activeBwPreviewCorrelation = null;
  }
  pendingBwWrite = null;
  document.getElementById('bw-preview-panel').hidden = true;
  document.getElementById('bw-preview-content').innerHTML = '';
  const btn = document.getElementById('bw-approve-btn');
  btn.disabled = true;
  btn.textContent = 'Write to Google Sheets';
  const previewBtn = document.getElementById('bw-preview-btn');
  if (previewBtn) {
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview — no data saved';
  }
  const note = document.getElementById('bw-gate-note');
  if (note) note.textContent = 'Run a preview above to enable this button.';
}

document.getElementById('bw-form').addEventListener('input', bwInvalidate);

document.getElementById('bw-form').addEventListener('submit', async e => {
  e.preventDefault();
  bwInvalidate();
  const submitSeq = bwPreviewSeq;
  const bwStatus = document.getElementById('bw-status');
  setStatus(bwStatus, '', 'ok');

  const date = document.getElementById('bw-date').value;
  const weight = document.getElementById('bw-weight').value;
  const notes = document.getElementById('bw-notes').value.trim();

  const previewBtn = document.getElementById('bw-preview-btn');
  previewBtn.disabled = true;
  previewBtn.textContent = 'Previewing…';

  try {
    const correlationSessionId = (getActivePlannedSession()?.session_id
      || document.getElementById('log-session-id')?.value?.trim()
      || generateSessionId(date));
    const correlationPreview = beginCorrelatedPreview({ sessionId: correlationSessionId });
    activeBwPreviewCorrelation = correlationPreview;
    const previewPayload = { date, weight: Number(weight), notes, test_mode: 'true' };
    if (correlationPreview) {
      previewPayload.session_id = correlationSessionId;
      previewPayload.correlation = correlationPreview.correlation;
    }
    const result = await api('/api/bodyweight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(previewPayload),
      ...(correlationPreview ? {
        responseHeaders: responseHeaders => completeCorrelatedPreview(correlationPreview, responseHeaders)
      } : {})
    });
    // Preserve the newest initiated preview regardless of completion order. This
    // also covers an edit/cancel that retired the request without starting another.
    if (submitSeq !== bwPreviewSeq) return;
    const data = result.data || {};
    if (!hasBodyweightNoWriteProof(result)) {
      throw new Error('Preview did not prove no-write safety. Nothing can be written.');
    }
    const content = document.getElementById('bw-preview-content');
    content.innerHTML = '';
    const entry = data.entry_preview || {};
    content.appendChild(renderTable(
      ['Date', 'Weight', 'Notes'],
      [[entry.date, entry.weight, entry.notes]]
    ));

    pendingBwWrite = {
      date,
      weight: Number(weight),
      notes,
      write_id: generateWriteId(),
      correlationSessionId,
      correlationPreview,
      previewProof: {
        test_mode: data.test_mode,
        sheet_write: data.sheet_write,
        sheet_written: data.sheet_written,
        no_write_confirmed: data.no_write_confirmed
      }
    };
    document.getElementById('bw-preview-panel').hidden = false;
    document.getElementById('bw-approve-btn').disabled = !pendingBodyweightHasPreviewProof(pendingBwWrite);
    const gateNote = document.getElementById('bw-gate-note');
    if (gateNote) gateNote.textContent = 'Review above, then click to write.';
  } catch (err) {
    if (submitSeq !== bwPreviewSeq) return;
    // Surface the server's inner cause when present (parity with the logger preview
    // catch — PR-581 review note 2), so a bodyweight 500 is diagnosable too.
    const bd = err && err.body && err.body.details;
    const bdetail = bd && (typeof bd === 'string' ? bd : (bd.error || null));
    const bwFriendly = friendlyTransportMessage(err);
    setStatus(bwStatus, bwFriendly ? `Preview failed: ${bwFriendly}` : `Preview failed: ${err.message}${bdetail ? ` — ${bdetail}` : ''}`, 'error');
  } finally {
    // A stale request must not change the button state owned by a newer submit.
    // Plain form invalidation already restores the button in bwInvalidate().
    if (submitSeq === bwPreviewSeq) {
      previewBtn.disabled = false;
      previewBtn.textContent = 'Preview — no data saved';
    }
  }
});

document.getElementById('bw-cancel-btn').addEventListener('click', bwInvalidate);

document.getElementById('bw-approve-btn').addEventListener('click', async () => {
  if (!pendingBodyweightHasPreviewProof(pendingBwWrite)) {
    bwInvalidate();
    return;
  }
  const approveBtn = document.getElementById('bw-approve-btn');
  const bwStatus = document.getElementById('bw-status');
  approveBtn.disabled = true;
  approveBtn.textContent = 'Writing to Sheets…';
  try {
    const livePayload = {
      date: pendingBwWrite.date,
      weight: pendingBwWrite.weight,
      notes: pendingBwWrite.notes,
      write_id: pendingBwWrite.write_id
    };
    const correlation = approvalCorrelation(pendingBwWrite.correlationPreview);
    if (correlation) {
      livePayload.session_id = pendingBwWrite.correlationSessionId;
      livePayload.correlation = correlation;
    }
    const result = await api('/api/bodyweight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(livePayload)
    });
    if (!hasBodyweightWriteProof(result)) {
      throw new Error('Bodyweight write did not return success proof. Verify Sheets before approving again.');
    }
    bwInvalidate();
    document.getElementById('bw-form').reset();
    document.getElementById('bw-date').value = getLocalDateString();
    setStatus(bwStatus, 'Bodyweight written to Google Sheets. ✓', 'ok');
    loadBwHistory();
  } catch (err) {
    setStatus(bwStatus, `Write failed: ${err.message}`, 'error');
    approveBtn.disabled = false;
    approveBtn.textContent = 'Write to Google Sheets';
  }
});

// Trend-first body view: a big current weight + 30-day change + a line of the
// last 90 days. Bodyweight direction isn't inherently good or bad (down is the
// goal on a cut), so the delta stays a neutral readout — no green/red judgment.
function renderBwGlance(glance, data, entries) {
  if (!glance) return;
  glance.innerHTML = '';
  if (!entries.length) {
    glance.appendChild(el('p', { class: 'muted', text: 'Log your weight to start a trend.' }));
    return;
  }
  const last = entries[entries.length - 1];
  const latest = (data.latest && data.latest.weight != null) ? Number(data.latest.weight) : Number(last.weight);
  const latestDate = (data.latest && data.latest.date) || last.date;
  const unit = data.unit ? ` ${data.unit}` : '';

  // 30-day change: compare to the entry nearest 30 days before the latest.
  const cutoff = Date.parse(latestDate) - 30 * 86400000;
  let baseline = entries[0];
  for (const e of entries) { if (Date.parse(e.date) <= cutoff) baseline = e; else break; }
  const delta = latest - Number(baseline.weight);
  const arrow = delta < 0 ? '▼' : (delta > 0 ? '▲' : '·');

  glance.appendChild(el('div', { class: 'bw-now' }, [
    el('div', { class: 'bw-w' }, [document.createTextNode(String(latest)), el('small', { text: unit })]),
    el('div', { class: 'bw-delta' }, [
      el('b', { text: `${arrow} ${Math.abs(delta).toFixed(1)}` }),
      el('span', { text: 'LAST 30 DAYS' })
    ])
  ]));
  glance.appendChild(el('div', { class: 'bw-chart' }, [
    svgLineChart(entries.map(e => ({ x: e.date, y: Number(e.weight) })),
      { color: '#E8772E', label: 'Bodyweight over time', height: 120 })
  ]));
}

async function loadBwHistory() {
  const glance = document.getElementById('bw-glance');
  const box = document.getElementById('bw-history');
  const hint = document.getElementById('bw-history-hint');
  if (!isConnected()) {
    if (glance) glance.innerHTML = '<span class="muted">Connect Atlas in Settings.</span>';
    if (box) box.innerHTML = '<span class="muted">Connect Atlas in Settings.</span>';
    return;
  }
  try {
    const res = await api('/api/bodyweight/history?days=90');
    const data = res.data || {};
    const entries = data.entries || [];
    renderBwGlance(glance, data, entries);
    if (box) {
      box.innerHTML = '';
      if (!entries.length) {
        box.appendChild(el('span', { class: 'muted', text: 'No bodyweight entries in the last 90 days.' }));
      } else {
        box.appendChild(renderTable(
          ['Date', 'Weight', 'Notes'],
          entries.slice().reverse().slice(0, 20).map(e => [e.date, e.weight, e.notes])
        ));
      }
    }
    if (hint) hint.textContent = entries.length ? `${entries.length} entries` : '';
  } catch (err) {
    // A real 401 → prompt to connect; a transport failure → the network line; else the
    // server's own message. Never a "set your key" prompt on a connection blip.
    const msg = err && err.status === 401
      ? 'Connect Atlas in Settings.'
      : (friendlyTransportMessage(err) || `Could not load: ${err.message}`);
    if (glance) {
      glance.textContent = '';
      glance.appendChild(el('span', { class: 'muted', text: msg }));
    }
  }
}

async function loadPendingExercises() {
  const box = document.getElementById('pending-exercises');
  if (!isConnected()) {
    box.innerHTML = '<span class="muted">Connect Atlas in Settings.</span>';
    return;
  }
  try {
    const res = await api('/api/pending-exercises');
    const items = res.data?.pending_exercises || [];
    box.innerHTML = '';
    if (!items.length) {
      box.appendChild(el('span', { class: 'muted', text: 'All exercises in recent sessions matched the catalog.' }));
      return;
    }
    box.appendChild(renderTable(
      ['Exercise (as typed)', 'Closest catalog match', 'Lift code'],
      items.map(item => {
        const best = item.closest_matches?.[0];
        return [item.exercise, best?.canonical_exercise ?? '—', best?.lift_code ?? '—'];
      })
    ));
    box.appendChild(el('p', { class: 'muted', text: `${items.length} exercise(s) need catalog entries. Add them to Exercise_Catalog with the canonical name and a variant matching what you type.` }));
  } catch (err) {
    box.textContent = '';
    const msg = err && err.status === 401
      ? 'Connect Atlas in Settings.'
      : (friendlyTransportMessage(err) || `Could not load: ${err.message}`);
    box.appendChild(el('span', { class: 'muted', text: msg }));
  }
}

async function loadBodyTab() {
  // Pending/unrecognised exercises moved to Settings → Data; Body is trend-first.
  await loadBwHistory();
}

/* ===== Temporary app.js → satellite bridge (PR-09) =====
 * app.js is now an ES module (was a classic global script). The still-unconverted
 * satellite modules (coach-conversation.js, drawer.js) call these app.js functions
 * as BARE globals — which resolved for free while app.js was classic. As a module,
 * app.js's top-level declarations are module-scoped, so we re-expose exactly the
 * symbols the satellites reference on `window` (bare identifiers in a module resolve
 * to global-object properties). This block is assigned at module load, before any
 * satellite handler can fire. It SHRINKS to nothing once the satellites import these
 * directly (PR-10/PR-11). The `window.atlas*` hooks below/elsewhere are unchanged. */
window.api = api;
window.fetchReaction = fetchReaction;
window.getApiKey = getApiKey;
// F04C: modules that gate on "is the owner connected?" must consult isConnected()
// (a durable session cookie OR a legacy key), never getApiKey() alone — after the
// cookie migration the raw key is gone but the session is live. Exposed as a global
// for the browser-global modules (drawer.js, coach-conversation.js).
window.isConnected = isConnected;
window.addSetRow = addSetRow;
window.emitSetLogged = emitSetLogged;
window.getActiveIntentId = getActiveIntentId;
window.getActivePlannedSession = getActivePlannedSession;
window.getSessionCompleted = getSessionCompleted;
window.invalidatePreview = invalidatePreview;
window.normalizePlanExercise = normalizePlanExercise;
window.previewSetsForLift = previewSetsForLift;
window.setCoachSuggestionEngaged = setCoachSuggestionEngaged;
window.getPlanTodayByName = getPlanTodayByName;
// app.js top-level VALUES the satellites read bare (data tables + the preview table
// DOM ref) — same transitional bridge, resolved once at load.
window.FRIENDLY_PATTERN_LABELS = FRIENDLY_PATTERN_LABELS;
window.FRIENDLY_STATUS_WORDS = FRIENDLY_STATUS_WORDS;
window.setsTableBody = setsTableBody;
// e2e test-support: the Playwright suite drives these planned-session helpers via
// page.evaluate (they were reachable as classic-script globals). Exposing this small
// subset is strictly less than the old "every function is global" surface. Removed
// when the e2e suite drives them through real UI actions (test-hardening follow-up).
window.startPlannedSession = startPlannedSession;
// PR-F: the coach-conversation IIFE calls this to accept the displayed plan (the
// authoritative acceptance boundary). Now that the plan-card "Start this plan" button
// is retired, acceptance auto-fires at the log gate, which reads the displayed plan
// from lastIntentData via displayedRecommendation().
window.atlasAcceptPlan = acceptDisplayedPlan;
// The Coach's Pick flow (coach-conversation.js) fetches /api/plan/intent-recommendation
// on its own and does NOT go through loadDashboard. Keep the acceptance gate's source
// (lastIntentData → displayedRecommendation) aligned with the plan actually shown, so
// logging-is-acceptance accepts the DISPLAYED pick — never a stale dashboard cache, and
// never nothing when the dashboard fetch returned null/empty. Same endpoint + shape as
// loadDashboard's assignment; only refreshes when the response actually carries intents.
window.atlasSyncDisplayedIntent = (intentData) => {
  if (intentData && Array.isArray(intentData.intents) && intentData.intents.length) {
    lastIntentData = intentData;
  }
};
window.firstUnloggedPlannedLift = firstUnloggedPlannedLift;
window.plannedExerciseOrder = plannedExerciseOrder;
window.remainingPlannedExercises = remainingPlannedExercises;
// Workout Sheet (PR-1) reads the logged sets to summarize done/current cards. Its own
// module (workoutSheet.js) mounts + wires itself to #session-pin; app.js only exposes
// this read-only selector (the plan/remaining selectors above are already exposed).
window.getSessionLog = getSessionLog;
// Workout Sheet (PR-2) dispatches the drag-to-reorder plan mutation through this one
// deterministic wrapper (the sheet contains ZERO plan logic). getCanonicalSession is
// exposed READ-ONLY so the equivalence test can prove the drag path yields the same
// ActiveSession state as invoking activeSession.reorderExercise directly.
window.reorderPlannedExercise = reorderPlannedExercise;
window.getCanonicalSession = getCanonicalSession;

/* ===== Init ===== */

function setDefaultDate() {
  const today = getLocalDateString();
  document.getElementById('log-date').value = today;
  document.getElementById('bw-date').value = today;
  // RC2: returning the field to the default today is NOT an explicit owner choice, so
  // clear the manual-entry latch. Without this, a one-time manual date edit would stay
  // "manual" for the PWA's lifetime — and after a post-save reset (which calls this) a
  // later closeout screenshot would be forced under today, re-introducing the RC2 bug.
  logDateManuallyEntered = false;
}

// RC2: a real keystroke/picker change on the date field marks it as an EXPLICIT
// manual entry, so a closeout screenshot's own date won't override the owner's choice.
// Programmatic setDefaultDate()/value assignments don't fire 'input', so they never
// trip this — only genuine owner input does.
document.getElementById('log-date')?.addEventListener('input', () => { logDateManuallyEntered = true; });

setDefaultDate();
checkConnection();
// Mobile resume safety: if a recent in-progress session was snapshotted before a
// reload/force-quit/background, restore it so the lifter picks up mid-session.
restoreSessionSnapshot();
// Durable owner session bootstrap (F04C): learn whether this browser is
// authenticated by a cookie, and — one time — migrate any legacy localStorage key
// into a session cookie and delete the raw key. This runs BEFORE the first data
// loads so the connection gates see the correct state for a cookie-only owner.
// Every branch degrades safely: with sessions disabled or the status call failing,
// isConnected() falls back to the localStorage key exactly as before.
(async () => {
  try {
    const status = await refreshSessionStatus();
    if (status && status.sessions_enabled && !status.authenticated) {
      const legacyKey = getApiKey();
      if (legacyKey) {
        const migrated = await sessionLogin(legacyKey);
        if (migrated.ok) localStorage.removeItem(API_KEY_STORAGE);
      }
    }
  } catch (_) { /* never block the app on session bootstrap */ }
  // Make Settings agree with the server verdict on reopen (never a second, independent
  // client truth). Runs after the status probe / migration have settled the auth state.
  reflectSettingsAuth();
  loadDashboard();
  loadCoachPlan();
  loadWeeklyCoach();
  loadExerciseDatalist();
})();

document.getElementById('intent-drawer-backdrop')?.addEventListener('click', closeIntentDrawer);
document.getElementById('intent-drawer-close')?.addEventListener('click', closeIntentDrawer);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // offline shell is an optional enhancement — the app works without it
  });
}
