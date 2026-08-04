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

// ── RUN PURPOSE (F-SB4B corrective, owner instruction 2026-08-03) ──────────────
// TWO purposes, both explicit, neither the default. The runner, the scenarios, the
// browser, the provider, the sandbox, the durable evidence, the adjudicator, and the
// privacy sweep are IDENTICAL under both — the only differences are recorded here.
//
//   REHEARSAL_SESSION (qualifying) — may advance the streak. Requires the canonical
//     count to equal session_number - 1, exact clean main, and 25/25. It is the only
//     purpose that can publish rehearsal_eligible=true.
//
//   REHEARSAL_DEBUG (diagnostic) — proves the SCENARIOS on exact clean main without
//     touching the count. It does NOT require prior count == session_number - 1, it
//     can score all 25 conditions PASS, and it ALWAYS publishes
//     rehearsal_eligible=false. It can never advance or authorize a count.
//
// WHY THIS EXISTS. Before this, one scorecard condition (`source_tree_verified`)
// conflated two unrelated questions: "is the source tree clean and exact?" and "is
// this session number legal at the canonical count?". At count 0/5 a Session 2 run
// therefore FAILED that condition no matter how the product behaved, which made a
// five-scenario non-counting sweep from exact main impossible. The practice that grew
// around it — running from an off-main tree so the source check failed for a
// DIFFERENT reason and the run quietly did not count — used a failure as a mode
// switch. That is the competing authority this replaces: purpose is now declared, not
// inferred from which check happened to go red.
const REHEARSAL_SESSION = 'REHEARSAL_SESSION';
const REHEARSAL_DEBUG = 'REHEARSAL_DEBUG';
const RUN_PURPOSES = Object.freeze([REHEARSAL_SESSION, REHEARSAL_DEBUG]);
const QUALIFYING_PURPOSE = REHEARSAL_SESSION;
const REHEARSAL_STREAK_LENGTH = 5;

// The single predicate every consumer asks. A purpose that is absent, unknown, or
// malformed is NOT qualifying — eligibility fails closed.
function isQualifyingPurpose(value) {
  return normalizePurpose(value) === QUALIFYING_PURPOSE;
}

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
// The CURRENT count lives in exactly one place: the ACTIVE `CAMPAIGN STATE:` line's
// streak field in docs/ATLAS_V1_EXECUTION_PLAN.md (the plan's own mandated format,
// `Rehearsal (F-SB4): <k>/5`, recorded beside the stage streaks). The plan also
// intentionally preserves DATED HISTORICAL statements of the count (owner insertions,
// resolution blocks, "Counting unchanged" lines) that keep their original numbers
// forever — after Session 1 the active field reads 1/5 while history still reads 0/5.
// A whole-document every-occurrence-must-agree scan therefore refuses every session
// after the first, so ONLY markers on a `CAMPAIGN STATE:` line participate here, and
// historical evidence is never rewritten to appease the parser.
// Fail-closed on: unreadable document, no current marker, more than one current
// marker (two state lines, or two markers on one), malformed marker, impossible count.
function parseCanonicalRehearsalCount(planText) {
  if (typeof planText !== 'string' || planText.trim() === '') {
    return { ok: false, count: null, reason: 'the execution plan could not be read' };
  }
  const stateLines = planText.split('\n').filter((l) => l.includes('CAMPAIGN STATE:'));
  const markers = [];
  for (const line of stateLines) {
    // The colon after (F-SB4) is optional: the mandated format carries it, the live
    // streak field historically omits it — both name the same current field. The
    // template `<k>/5` never matches (no digits).
    for (const m of line.matchAll(/Rehearsal \(F-SB4\):?\s*(\d+)\s*\/\s*5/g)) markers.push(Number(m[1]));
  }
  if (markers.length === 0) {
    return { ok: false, count: null, reason: 'the active CAMPAIGN STATE line carries no current `Rehearsal (F-SB4): <k>/5` marker' };
  }
  if (markers.length > 1) {
    return { ok: false, count: null, reason: `the plan carries ${markers.length} current CAMPAIGN STATE rehearsal markers (${markers.join(', ')}); exactly one must exist` };
  }
  const count = markers[0];
  if (!Number.isInteger(count) || count < 0 || count > REHEARSAL_STREAK_LENGTH) {
    return { ok: false, count: null, reason: `the execution plan states an impossible rehearsal count ${count}` };
  }
  return { ok: true, count, reason: null, occurrences: 1 };
}

// ── the qualifying-run preflight ───────────────────────────────────────────────
// Every refusal is collected rather than short-circuited. `ok` is true only when the
// list is empty; there is no override flag and no --force.
function evaluateRehearsalPreflight(input) {
  const i = input && typeof input === 'object' ? input : {};
  const refusals = [];
  const add = (r) => refusals.push(r);

  const purpose = normalizePurpose(i.purpose);
  const qualifying = purpose === QUALIFYING_PURPOSE;
  if (purpose === null) {
    add(`declare a run purpose explicitly: ${RUN_PURPOSES.join(' or ')}; got "${i.purpose || 'no purpose'}"`);
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
  // THE COUNT RULE — qualifying only. Session N is legal only at N-1, which refuses a
  // skipped, repeated, stale, or out-of-order qualifying session. A DEBUG run is not
  // bound by it: it can never advance the count, so ordering it against the count
  // would only forbid the diagnostic sweep this purpose exists to allow. The count is
  // still READ under both purposes and recorded in the evidence, so a debug run's
  // artifacts state the count they ran at.
  const prior = i.priorRehearsalCount;
  const countReadable = Number.isInteger(prior) && prior >= 0 && prior <= REHEARSAL_STREAK_LENGTH;
  if (qualifying) {
    if (!countReadable) {
      add(`the canonical rehearsal count is unreadable (${i.priorCountReason || 'no count recorded'}); refusing to run`);
    } else if (isRehearsalSessionNumber(n) && prior !== n - 1) {
      add(`session ${n} requires the canonical count to be ${n - 1}/${REHEARSAL_STREAK_LENGTH}; the plan records ${prior}/${REHEARSAL_STREAK_LENGTH}`);
    }
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
  REHEARSAL_DEBUG,
  QUALIFYING_PURPOSE,
  isQualifyingPurpose,
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
