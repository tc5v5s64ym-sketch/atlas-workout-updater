'use strict';

// ── F-SB4B rehearsal run purpose, identities, and the qualifying-run preflight ──
// TEMPORARY F-SB4B machinery (sunset: F-SB4C), adapted from the proven Stage A module
// (stage-a-run-purpose.js, sunset PR #1234) under the owner resolution recorded in
// docs/ATLAS_V1_EXECUTION_PLAN.md (F-SB4B, 2026-08-03).
//
// Everything that decides "may this run count toward the rehearsal streak" lives here,
// so there is exactly one place to attack in a test and exactly one place a future
// change can weaken. Two consumers enforce the same functions at two moments:
// `scripts/atlas-rehearsal-session.js` refuses BEFORE the browser starts, and the
// scorecard re-checks the RECORDED facts after, so a run cannot claim eligibility on
// evidence it never carried.
//
// THE IDENTITY RULE DIFFERS FROM STAGE A, deliberately (recorded isolation rule 3):
// Stage A pre-seeded the workout session id into the write path. The rehearsal NEVER
// does — the accepted-plan product path obtains the identity from the server allocator
// (PR #1246), and the runner captures the returned identity for evidence correlation
// only. So this module mints RUN and ATHLETE identities (the correlation family), and
// its identity check runs INVERTED for the workout id: a workout session id carrying
// the runner's own family marker is mechanical proof of pre-seeding and REFUSES;
// a qualifying workout id must be server-shaped (`YYYYMMDD-AM|PM-NN`).
//
// Pure: no clock, no filesystem, no network, no process, no environment access.

const REHEARSAL_SESSION = 'REHEARSAL_SESSION';
const RUN_PURPOSES = Object.freeze([REHEARSAL_SESSION]);
const REHEARSAL_STREAK_LENGTH = 5;

const SHA_RE = /^[0-9a-f]{40}$/;
// The server allocator's shape (services/sessionId.js nextAvailableSessionId).
const SERVER_SESSION_ID_RE = /^\d{8}-(AM|PM)-\d{2}$/i;

function normalizePurpose(value) {
  const s = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return RUN_PURPOSES.includes(s) ? s : null;
}

function isRehearsalSessionNumber(n) {
  return Number.isInteger(n) && n >= 1 && n <= REHEARSAL_STREAK_LENGTH;
}

// Correlation identities only — the workout session id is deliberately NOT minted here.
function mintIdentities({ sessionNumber, stamp, nonce }) {
  if (!stamp || !nonce) throw new Error('mintIdentities requires a stamp and a nonce');
  if (!isRehearsalSessionNumber(sessionNumber)) {
    throw new Error(`a rehearsal session number must be an integer 1..${REHEARSAL_STREAK_LENGTH}; got ${sessionNumber}`);
  }
  return {
    run_id: `fsb4b-s${sessionNumber}-${stamp}-${nonce}`,
    athlete_id: `fsb4b-athlete-${nonce}`,
  };
}

// The INVERTED workout-identity check (isolation rules 3–4). Returns null when the
// captured workout id is legitimate, or a refusal string. Never throws.
function workoutIdentityRefusal({ workoutSessionId }) {
  const sid = typeof workoutSessionId === 'string' ? workoutSessionId.trim() : '';
  if (!sid) return 'no server-allocated workout session id was captured — the accepted-plan path must have allocated one';
  if (/FSB4B/i.test(sid) || /STAGEA/i.test(sid) || /CANARY/i.test(sid)) {
    return `workout session id "${sid}" carries a runner family marker — a pre-seeded identity bypasses the server allocator the rehearsal exists to prove (isolation rule 3)`;
  }
  if (!SERVER_SESSION_ID_RE.test(sid)) {
    return `workout session id "${sid}" is not server-allocator-shaped (YYYYMMDD-AM|PM-NN) — it did not come from the product's allocation authority`;
  }
  return null;
}

// The correlation family check: the RUN identity must carry this session's marker so a
// prior rehearsal's artifacts can never satisfy this session's assertions (rule 5).
function runIdentityRefusal({ sessionNumber, runId }) {
  const rid = typeof runId === 'string' ? runId.trim() : '';
  if (!isRehearsalSessionNumber(sessionNumber)) {
    return `a rehearsal session number must be an integer 1..${REHEARSAL_STREAK_LENGTH}; got ${sessionNumber}`;
  }
  if (!new RegExp(`^fsb4b-s${sessionNumber}-`, 'i').test(rid)) {
    return `run id "${rid}" does not carry the rehearsal session-${sessionNumber} marker (fsb4b-s${sessionNumber}-…)`;
  }
  return null;
}

// ── the canonical rehearsal count ──────────────────────────────────────────────
// The count lives in docs/ATLAS_V1_EXECUTION_PLAN.md in the owner insertion's own
// field — `Rehearsal (F-SB4): <k>/5` — and NOT in a second machine-readable file.
// Every DIGIT occurrence must agree; the template occurrence (`<k>/5`) never matches.
// Fail-closed on: no occurrence, disagreement, unreadable document.
function parseCanonicalRehearsalCount(planText) {
  if (typeof planText !== 'string' || planText.trim() === '') {
    return { ok: false, count: null, reason: 'the execution plan could not be read' };
  }
  const found = [...planText.matchAll(/Rehearsal \(F-SB4\):\s*(\d+)\s*\/\s*5/g)].map((m) => Number(m[1]));
  if (found.length === 0) {
    return { ok: false, count: null, reason: 'the execution plan states no `Rehearsal (F-SB4): <k>/5` count' };
  }
  const distinct = [...new Set(found)];
  if (distinct.length > 1) {
    return { ok: false, count: null, reason: `the execution plan states conflicting rehearsal counts (${distinct.join(', ')}); refusing to guess which governs` };
  }
  const count = distinct[0];
  if (!Number.isInteger(count) || count < 0 || count > REHEARSAL_STREAK_LENGTH) {
    return { ok: false, count: null, reason: `the execution plan states an impossible rehearsal count ${count}` };
  }
  return { ok: true, count, reason: null, occurrences: found.length };
}

// ── the qualifying-run preflight ───────────────────────────────────────────────
// Every refusal is collected rather than short-circuited. `ok` is true only when the
// list is empty; there is no override flag and no --force.
function evaluateRehearsalPreflight(input) {
  const i = input && typeof input === 'object' ? input : {};
  const refusals = [];
  const add = (r) => refusals.push(r);

  if (normalizePurpose(i.purpose) !== REHEARSAL_SESSION) {
    add(`this preflight governs REHEARSAL_SESSION runs only; got "${i.purpose || 'no purpose'}"`);
  }
  // Model-up only: a deterministic-fallback session proves the machine path but not the
  // product the owner is about to trust with real workouts.
  if (i.mode !== 'model-up') {
    add(`rehearsal sessions are model-up only; got "${i.mode || 'no posture'}"`);
  }
  const n = i.sessionNumber;
  if (!isRehearsalSessionNumber(n)) {
    add(`--session must be an integer 1..${REHEARSAL_STREAK_LENGTH} (there is no default); got ${n === undefined ? 'nothing' : JSON.stringify(n)}`);
  }
  // The canonical count decides which session number is next: session N is legal only
  // at N-1 — this refuses a skipped, repeated, stale, or out-of-order session.
  const prior = i.priorRehearsalCount;
  if (!Number.isInteger(prior) || prior < 0 || prior > REHEARSAL_STREAK_LENGTH) {
    add(`the canonical rehearsal count is unreadable (${i.priorCountReason || 'no count recorded'}); refusing to run`);
  } else if (isRehearsalSessionNumber(n) && prior !== n - 1) {
    add(`session ${n} requires the canonical count to be ${n - 1}/${REHEARSAL_STREAK_LENGTH}; the plan records ${prior}/${REHEARSAL_STREAK_LENGTH}`);
  }

  const git = i.git && typeof i.git === 'object' ? i.git : {};
  if (i.originRefreshed !== true) {
    add('`git fetch origin main` did not succeed, so origin/main may be stale — the staleness check cannot be trusted');
  }
  if (git.branch !== 'main') {
    add(`a qualifying run must execute on main; the working branch is "${git.branch || 'unknown'}"`);
  }
  if (git.clean !== true) {
    add('a qualifying run requires a clean worktree; uncommitted changes are present');
  }
  if (!SHA_RE.test(String(git.head || ''))) {
    add(`HEAD is not a resolved commit sha (got "${git.head || 'nothing'}")`);
  }
  if (!SHA_RE.test(String(git.originHead || ''))) {
    add(`origin/main is not a resolved commit sha (got "${git.originHead || 'nothing'}")`);
  } else if (git.head !== git.originHead) {
    add(`HEAD ${String(git.head).slice(0, 7)} does not equal origin/main ${String(git.originHead).slice(0, 7)} — the source tree is stale`);
  }

  const env = i.env && typeof i.env === 'object' ? i.env : {};
  if (env.childCarriesWorkbookId === true) {
    add('the child environment carries a GOOGLE_SHEETS_ID — the sandbox id is the gate server\'s to assign');
  }
  if (env.childCarriesWorkoutSessionId === true) {
    add('the child environment carries a pre-seeded workout session id — the server allocator mints it at acceptance (isolation rule 3)');
  }
  if (env.rehearsalPostureDeclared !== true) {
    add('the child environment does not declare the combined rehearsal posture (sandbox-live + ledger)');
  }
  if (env.declaredWorkbookIsSandbox !== true) {
    add('the declared workbook is not the repository-declared sandbox');
  }
  if (env.nodeEnvProduction === true) {
    add('the child environment carries a production NODE_ENV fingerprint');
  }
  if (env.hasServiceAccountEmail !== true) add('GOOGLE_SERVICE_ACCOUNT_EMAIL is not exported');
  if (env.hasPrivateKey !== true) add('GOOGLE_PRIVATE_KEY is not exported');
  if (env.hasProviderKey !== true) add('GEMINI_API_KEY is not exported, so model-up cannot be proven');

  const runRef = runIdentityRefusal({ sessionNumber: n, runId: i.runId });
  if (runRef) add(runRef);

  return { ok: refusals.length === 0, refusals };
}

module.exports = {
  REHEARSAL_SESSION,
  RUN_PURPOSES,
  REHEARSAL_STREAK_LENGTH,
  SERVER_SESSION_ID_RE,
  normalizePurpose,
  isRehearsalSessionNumber,
  mintIdentities,
  workoutIdentityRefusal,
  runIdentityRefusal,
  parseCanonicalRehearsalCount,
  evaluateRehearsalPreflight,
};
