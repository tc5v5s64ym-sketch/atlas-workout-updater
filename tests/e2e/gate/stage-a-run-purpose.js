'use strict';

// ── Run purpose, Stage-A identity, and the qualifying-run preflight — declared ONCE ──
//
// The one gate runner (`tests/e2e/gate/stage-a-canary.spec.js` on `gate-server.js`) now
// serves TWO purposes, and the difference between them is the difference between proof
// that the machine path works and evidence that advances an owner-ruled acceptance streak.
// That distinction must be MECHANICAL, not a label an operator remembers to apply:
//
//   CANARY           — readiness proof. Never advances the Stage A streak. Always publishes
//                      stage_a_eligible = false, whatever else the run achieved.
//   STAGE_A_SESSION  — a count-eligible session under the 2026-07-31 two-stage owner ruling.
//                      May publish stage_a_eligible = true only when every rule here holds.
//
// Everything that decides "may this run count" lives in this module, so there is exactly one
// place to attack in a test and exactly one place a future change can weaken. Two consumers
// enforce the same functions at two different moments: `scripts/atlas-stage-a-session.js`
// refuses BEFORE the browser starts, and the scorecard re-checks the RECORDED facts after,
// so a run cannot claim eligibility on evidence it never carried.
//
// Pure: no clock, no filesystem, no network, no process, no environment access. The caller
// measures the world; this module decides what the measurements permit.
//
// Sunset: deleted with the rest of the temporary Phase 4 Stage-A machinery, in the same PR
// that records Stage A at 5/5 (see docs/ATLAS_V1_EXECUTION_PLAN.md).

const CANARY = 'CANARY';
const STAGE_A_SESSION = 'STAGE_A_SESSION';
const RUN_PURPOSES = Object.freeze([CANARY, STAGE_A_SESSION]);

// The owner ruling's streak length. A session number outside 1..5 is not a session in the
// streak the ruling defines, so it is refused rather than tolerated.
const STAGE_A_STREAK_LENGTH = 5;

const SHA_RE = /^[0-9a-f]{40}$/;

function normalizePurpose(value) {
  const s = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return RUN_PURPOSES.includes(s) ? s : null;
}

function isStageASessionNumber(n) {
  return Number.isInteger(n) && n >= 1 && n <= STAGE_A_STREAK_LENGTH;
}

// ── identities ─────────────────────────────────────────────────────────────────
//
// The session id is the product input the write path actually reads, so it is what a
// durable row carries and what the durable readback filters on. Making the purpose part
// of that id means a row in the workbook is self-identifying: nobody reading the sheet,
// the evidence, or the scorecard later can mistake a canary row for a Stage A row.
//
// The two families are deliberately disjoint, and each check refuses the OTHER family
// explicitly — a Stage A run that somehow minted a CANARY id must fail, not merely fail
// to match its own pattern.
function mintIdentities({ purpose, sessionNumber, stamp, nonce }) {
  const p = normalizePurpose(purpose);
  if (!p) throw new Error(`unknown run purpose "${purpose}" — expected one of ${RUN_PURPOSES.join(', ')}`);
  if (!stamp || !nonce) throw new Error('mintIdentities requires a stamp and a nonce');
  if (p === CANARY) {
    return {
      run_id: `canary-${stamp}-${nonce}`,
      session_id: `CANARY-${stamp}-${nonce}`,
      athlete_id: `canary-athlete-${nonce}`,
    };
  }
  if (!isStageASessionNumber(sessionNumber)) {
    throw new Error(`a Stage A session number must be an integer 1..${STAGE_A_STREAK_LENGTH}; got ${sessionNumber}`);
  }
  return {
    run_id: `stage-a-s${sessionNumber}-${stamp}-${nonce}`,
    session_id: `STAGEA-S${sessionNumber}-${stamp}-${nonce}`,
    athlete_id: `stage-a-athlete-${nonce}`,
  };
}

// Returns null when the identity belongs to the declared purpose, or a refusal string.
// Never throws: the scorecard calls it on evidence it did not mint.
function identityRefusal({ purpose, sessionNumber, sessionId }) {
  const p = normalizePurpose(purpose);
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!p) return `the run declared no recognized purpose (got "${purpose || ''}")`;
  if (!sid) return 'no synthetic session id was recorded';
  const hasCanaryMark = /CANARY/i.test(sid);
  const hasStageAMark = /STAGEA/i.test(sid);
  if (p === CANARY) {
    if (hasStageAMark) return `session id "${sid}" carries a Stage A marker on a CANARY run`;
    if (!/^CANARY-/i.test(sid)) return `session id "${sid}" does not carry the synthetic canary marker`;
    return null;
  }
  if (hasCanaryMark) {
    return `session id "${sid}" carries a CANARY marker — canary identity can never be Stage A evidence`;
  }
  if (!isStageASessionNumber(sessionNumber)) {
    return `a Stage A session number must be an integer 1..${STAGE_A_STREAK_LENGTH}; got ${sessionNumber}`;
  }
  const expected = new RegExp(`^STAGEA-S${sessionNumber}-`, 'i');
  if (!expected.test(sid)) {
    return `session id "${sid}" does not carry the Stage A session-${sessionNumber} marker (STAGEA-S${sessionNumber}-…)`;
  }
  return null;
}

// ── the canonical Stage A count ────────────────────────────────────────────────
//
// The count lives in docs/ATLAS_V1_EXECUTION_PLAN.md, in the owner ruling's own words —
// `Stage A: <k>/5.` — and NOT in a second machine-readable file, because a second file is
// a second authority and the two would drift the moment one PR updated only one of them.
//
// Every occurrence must agree. Fail-closed on all three ambiguous outcomes: no occurrence
// at all, occurrences that disagree, and an unreadable document. A parser that guessed here
// would be guessing whether a session may count.
function parseCanonicalStageACount(planText) {
  if (typeof planText !== 'string' || planText.trim() === '') {
    return { ok: false, count: null, reason: 'the execution plan could not be read' };
  }
  const found = [...planText.matchAll(/Stage A:\s*(\d+)\s*\/\s*5/g)].map((m) => Number(m[1]));
  if (found.length === 0) {
    return { ok: false, count: null, reason: 'the execution plan states no `Stage A: <k>/5` count' };
  }
  const distinct = [...new Set(found)];
  if (distinct.length > 1) {
    return {
      ok: false,
      count: null,
      reason: `the execution plan states conflicting Stage A counts (${distinct.join(', ')}); refusing to guess which governs`,
    };
  }
  const count = distinct[0];
  if (!Number.isInteger(count) || count < 0 || count > STAGE_A_STREAK_LENGTH) {
    return { ok: false, count: null, reason: `the execution plan states an impossible Stage A count ${count}` };
  }
  return { ok: true, count, reason: null, occurrences: found.length };
}

// ── the qualifying-run preflight ───────────────────────────────────────────────
//
// Every refusal is collected rather than short-circuited, so an operator sees everything
// blocking the run in one message instead of fixing them one restart at a time.
//
// `ok` is true only when the refusal list is empty. There is no override flag and no
// "--force": a rule that can be waived at the keyboard is not a mechanical requirement.
function evaluateStageAPreflight(input) {
  const i = input && typeof input === 'object' ? input : {};
  const refusals = [];
  const add = (r) => refusals.push(r);

  const purpose = normalizePurpose(i.purpose);
  if (purpose !== STAGE_A_SESSION) {
    add(`this preflight governs STAGE_A_SESSION runs only; got "${i.purpose || 'no purpose'}"`);
  }

  // Stage A is model-up only. A deterministic-fallback session proves the machine path but
  // not the product the owner is about to spend five real workouts on.
  if (i.mode !== 'model-up') {
    add(`Stage A sessions are model-up only; got "${i.mode || 'no posture'}"`);
  }

  const n = i.sessionNumber;
  if (!isStageASessionNumber(n)) {
    add(`--session must be an integer 1..${STAGE_A_STREAK_LENGTH} (there is no default); got ${n === undefined ? 'nothing' : JSON.stringify(n)}`);
  }

  // The canonical count decides which session number is next. This is what refuses a
  // skipped, repeated, stale, or out-of-order session: session N is legal only at N-1.
  const prior = i.priorStageACount;
  if (!Number.isInteger(prior) || prior < 0 || prior > STAGE_A_STREAK_LENGTH) {
    add(`the canonical Stage A count is unreadable (${i.priorCountReason || 'no count recorded'}); refusing to run`);
  } else if (isStageASessionNumber(n) && prior !== n - 1) {
    add(`session ${n} requires the canonical count to be ${n - 1}/${STAGE_A_STREAK_LENGTH}; the plan records ${prior}/${STAGE_A_STREAK_LENGTH}`);
  }

  const git = i.git && typeof i.git === 'object' ? i.git : {};
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

  // Sandbox posture and credentials. These are NOT-STARTED conditions by the owner ruling's
  // session-start boundary: a run refused here never began, so it is not a failed session.
  const env = i.env && typeof i.env === 'object' ? i.env : {};
  if (env.childCarriesWorkbookId === true) {
    add('the child environment carries a GOOGLE_SHEETS_ID — the sandbox id is the gate server\'s to assign');
  }
  if (env.sandboxLiveDeclared !== true) {
    add('the child environment does not declare the sandbox-live posture');
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

  const idRefusal = identityRefusal({ purpose: i.purpose, sessionNumber: n, sessionId: i.sessionId });
  if (idRefusal) add(idRefusal);

  return { ok: refusals.length === 0, refusals };
}

module.exports = {
  CANARY,
  STAGE_A_SESSION,
  RUN_PURPOSES,
  STAGE_A_STREAK_LENGTH,
  normalizePurpose,
  isStageASessionNumber,
  mintIdentities,
  identityRefusal,
  parseCanonicalStageACount,
  evaluateStageAPreflight,
};
