'use strict';

// THE COMPLETED-SESSION SHEETS EXPORTER — the asynchronous mirror worker.
//
// AUTHORITY: `docs/SUPABASE_HOT_PATH_MIGRATION.md` §5.4 ("The export must be
// durable AND idempotent"), §5.6, and gates §6.3 P14a-P14i. Owner correction
// 2026-08-13 sets the boundary this module must never cross.
//
// ── WHAT IT IS FOR ───────────────────────────────────────────────────────────
//
// After the S4 cutover Supabase is the sole authority for the workout hot path and
// Google Sheets is a HUMAN-READABLE EXPORT MIRROR of four tabs. Something has to
// project the authority onto that mirror. This is that something, and it is the
// only thing that writes those four tabs.
//
// ── THE ONE RULE THAT OUTRANKS EVERYTHING ELSE HERE ──────────────────────────
//
// NO WORKOUT REQUEST EVER AWAITS THIS MODULE. Not the Save, not the preview, not
// the approval, not the closeout, not undo, not a receipt retry. Every function
// below runs in the asynchronous worker, after closeout, and a total Google Sheets
// outage is invisible to the athlete: the workout is already committed in Supabase
// and is unaffected by any failure in here. That is the acceptance equation of the
// owner correction — a quota exhaustion of any kind must leave the workout passing.
//
// The consequence is deliberate: a backlog is the correct failure mode. The mirror
// falling behind is a reporting inconvenience; the workout failing is not.
//
// ── THE THREE MECHANISMS, AND WHY EACH EXISTS ────────────────────────────────
//
// 1. A DERIVED QUEUE. A session owes an export when a `session_closeout` event
//    exists for it and it is not yet exported, not `blocked`, and not inside a
//    backoff. Nothing is written at closeout to enqueue it, so nothing extra can be
//    lost — the row that proves the session closed IS the obligation. No outbox
//    table exists, because an outbox row can itself fail to be written.
//
// 2. A DETERMINISTIC DESTINATION, not a lock. A Postgres lock cannot fence a Google
//    Sheets call: an HTTP request already sent cannot be recalled, so a worker whose
//    connection dropped can still land its write after a replacement worker has
//    written the same rows. Exclusivity is therefore not attempted. Each session
//    reserves a durable per-tab block once (`atlas.sheets_mirror_allocations`) and
//    ALWAYS writes the same values into the same cells with `values.update`. A late
//    duplicate overwrites its own identical values and has nowhere else to go.
//    `values.append` is never used here, because an append picks its own address.
//
// 3. VERIFICATION SPANNING THE WHOLE TAB. A verifier that reads only its own block
//    cannot make a statement about the tab: a duplicate seeded outside the block
//    would be invisible to it. So the whole tab is read and each of this session's
//    identity keys must appear exactly once before the session is acknowledged.
//
// ── FAILURE IS CLASSIFIED, BECAUSE AN UNCLASSIFIED FAILURE IS AN INFINITE LOOP ─
//
// STRUCTURAL (`mirror_range_occupied`, `mirror_duplicate_identity`) means the sheet
// is not what the allocation says it is. Only the §5.7 owner rebuild can fix that,
// so the session becomes `blocked`: it leaves the queue immediately, consumes ZERO
// further Sheets reads, and stays visible in `npm run atlas:status` as owner action
// required. Retrying it would re-issue the expensive whole-tab read on every pass —
// which is the exact quota storm this migration exists to end.
//
// TRANSIENT (an API error, a timeout, a 429) retries on one declared policy:
// `now() + least(2 ^ attempts, 60)` minutes — 2, 4, 8, 16, 32, 60, 60 … — and at
// eight attempts becomes `blocked` rather than retrying forever. No jitter, so the
// schedule is reproducible in a proof.
//
// THE EXPORTER FAILS ITS OWN ACKNOWLEDGEMENT; IT NEVER FAILS THE WORKOUT. Every
// failure is session-addressable mirror state on `atlas.workout_sessions`. Nothing
// here writes `atlas.migration_divergences` — that table has no post-S4 consumer and
// is inert pending its drop.

const adapter = require('./supabaseAdapter');
const workoutAuthority = require('./workoutAuthority');
const sessionPlanStore = require('./sessionPlanStore');
const sessionPlanSetsStore = require('./sessionPlanSetsStore');

function sheetsModule() {
  // Required lazily so a test can inject its own through require.cache, matching the
  // pattern every other seam in this repository uses.
  return require('../sheets');
}

const LOG_TAB = 'Log_Cleaned';
const EFFORT_TAB = 'Effort';
const PLANS_TAB = sessionPlanStore.SESSION_PLANS_TAB;
const PLAN_SETS_TAB = sessionPlanSetsStore.SESSION_PLAN_SETS_TAB;

// The declared retry policy of §5.4 mechanism 1. One formula, one cap, one ceiling.
const BACKOFF_CAP_MINUTES = 60;
const ATTEMPT_CEILING = 8;

const STRUCTURAL_RANGE_OCCUPIED = 'mirror_range_occupied';
const STRUCTURAL_DUPLICATE_IDENTITY = 'mirror_duplicate_identity';

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// ── THE EXPORT IDENTITY KEY, per tab (§5.4 mechanism 3) ──────────────────────
//
// The same key the database uses for the same concept, so the mirror and the
// authority cannot disagree about what "the same row" means:
//   - logged sets  → (session_id, exercise, set_number), the unique index;
//   - effort       → session_id, the primary key;
//   - both ledgers → idempotency_key, the primary key.
const TAB_SPECS = [
  {
    tab: LOG_TAB,
    identity: (row) => `${norm(row[1])}||${norm(row[2])}||${norm(row[6])}`,
    sessionOf: (row) => norm(row[1]),
    rowsFor: (sessionId) => workoutAuthority.loggedSetRows({ sessionId }),
  },
  {
    tab: EFFORT_TAB,
    identity: (row) => norm(row[1]),
    sessionOf: (row) => norm(row[1]),
    // `effortRows` has no per-session form: one Effort row per session means the
    // table is one row per workout, so filtering the small result here is cheaper
    // than adding a second statement and a second index to maintain.
    rowsFor: async (sessionId) =>
      (await workoutAuthority.effortRows()).filter((row) => norm(row[1]) === norm(sessionId)),
  },
  {
    tab: PLANS_TAB,
    identity: (row) => String(row[0] == null ? '' : row[0]).trim(),
    sessionOf: (row) => norm(row[1]),
    rowsFor: (sessionId) => workoutAuthority.planEventRows({ sessionId }),
  },
  {
    tab: PLAN_SETS_TAB,
    identity: (row) => String(row[0] == null ? '' : row[0]).trim(),
    sessionOf: (row) => norm(row[1]),
    rowsFor: (sessionId) => workoutAuthority.planSetRows({ sessionId }),
  },
];

/**
 * Classify an export failure. Structural failures name themselves; anything else —
 * an API error, a timeout, a 429 — is transient by default.
 *
 * DEFAULTING TO TRANSIENT IS THE SAFE DIRECTION. A transient failure that is really
 * structural costs at most eight bounded retries before the ceiling blocks it. A
 * structural failure mislabelled transient would retry a whole-tab read forever.
 */
function isStructural(reason) {
  return reason === STRUCTURAL_RANGE_OCCUPIED || reason === STRUCTURAL_DUPLICATE_IDENTITY;
}

/**
 * The next attempt time for a transient failure, from the declared policy.
 *
 * `attemptsAfterFailure` is the value the failure statement will have recorded, so
 * the first failure waits 2 minutes rather than 1.
 */
function nextAttemptAt(attemptsAfterFailure, now = new Date()) {
  const minutes = Math.min(2 ** attemptsAfterFailure, BACKOFF_CAP_MINUTES);
  return new Date(now.getTime() + minutes * 60_000);
}

/** Read a whole mirrored tab, header included, as raw cell rows. */
async function readWholeTab(tab) {
  const sheets = sheetsModule();
  // A1 with no row bound: the verifier's statement is about the WHOLE tab, and a
  // bounded read could not support it.
  return sheets.readRange(`${tab}!A:Z`);
}

/**
 * THE PRE-WRITE RANGE CHECK (§5.4 mechanism 2).
 *
 * Writing by absolute address is only correct while the allocated block still holds
 * what the allocator believes it holds. That is a stronger assumption than anything
 * Atlas made before the cutover, so it is VERIFIED rather than assumed.
 *
 * Every row of the allocated range must be blank or already carry THIS session's
 * identity. Another session's row, an unexpected value, or a short read is a
 * refusal — the worker writes nothing and the session becomes `blocked`. This turns
 * "silent overwrite, detected later" into "refusal, detected now".
 *
 * @param {Array[]} tabRows   the whole tab, row 1 at index 0
 * @param {object}  spec      the tab's identity/session contract
 * @param {object}  block     `{ start_row, row_count }`, 1-based sheet rows
 * @param {string}  sessionId the session the block belongs to
 * @returns {boolean} true when the range is safe to write
 */
function rangeIsWritable(tabRows, spec, block, sessionId) {
  const start = Number(block.start_row);
  const count = Number(block.row_count);
  for (let sheetRow = start; sheetRow < start + count; sheetRow += 1) {
    const row = tabRows[sheetRow - 1];
    // A row past the current tail is not occupied — the grid is extended before the
    // write, and an absent row is blank by definition.
    if (row === undefined) continue;
    const cells = Array.isArray(row) ? row : [];
    const blank = cells.every((cell) => String(cell == null ? '' : cell).trim() === '');
    if (blank) continue;
    if (spec.sessionOf(cells) !== norm(sessionId)) return false;
  }
  return true;
}

/**
 * THE WHOLE-TAB IDENTITY VERIFICATION (§5.4 mechanism 3).
 *
 * Each identity key this session wrote must appear EXACTLY ONCE across the entire
 * tab. Fewer than one means the write did not land; more than one means a duplicate
 * exists somewhere — possibly far outside the allocated block, which is precisely
 * what a block-scoped verifier could not see.
 *
 * A count greater than one is a DEFECT, NOT A TIDY-UP: the session is blocked and
 * the owner rebuild is the recovery. This module never deletes a Sheets row to
 * correct itself.
 */
function verifyIdentitiesOnce(tabRows, spec, expectedRows) {
  const counts = new Map();
  for (let i = 1; i < tabRows.length; i += 1) {
    const cells = Array.isArray(tabRows[i]) ? tabRows[i] : [];
    const key = spec.identity(cells);
    if (!key || key === '||||') continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const row of expectedRows) {
    const key = spec.identity(row);
    if (!key) continue;
    if ((counts.get(key) || 0) !== 1) {
      return { ok: false, key, seen: counts.get(key) || 0 };
    }
  }
  return { ok: true };
}

/**
 * Export ONE claimed session. Never throws for an export failure — it classifies,
 * records and returns. It throws only if the authority itself is unreachable, which
 * the caller treats as "stop this pass", not as a session-level verdict.
 *
 * @returns {Promise<object>} `{ session_id, exported, reason }`
 */
async function exportClaimedSession(claim, { now = new Date() } = {}) {
  const sessionId = claim.session_id;
  const attemptsAfterFailure = Number(claim.sheets_export_attempts || 0) + 1;

  const fail = async (reason, detail) => {
    const structural = isStructural(reason);
    const state = structural || attemptsAfterFailure >= ATTEMPT_CEILING ? 'blocked' : 'retry_backoff';
    await adapter.recordExportFailure(sessionId, claim.export_claim_token, {
      error: detail ? `${reason}: ${detail}` : reason,
      state,
      // A blocked session has no next attempt: it has left the queue.
      nextAttemptAt: state === 'blocked' ? null : nextAttemptAt(attemptsAfterFailure, now),
    });
    return { session_id: sessionId, exported: false, reason, state };
  };

  // 1. What the authority says this session is. This is the projection source, and
  //    it is the only source — the mirror is never consulted about content.
  let projection;
  try {
    projection = await Promise.all(TAB_SPECS.map(async (spec) => ({
      spec,
      rows: await spec.rowsFor(sessionId),
    })));
  } catch (error) {
    return fail('authority_read_failed', error && error.message);
  }

  // 2. Reserve a durable block per tab THAT HAS ROWS. A tab with no rows receives no
  //    allocation and does not advance its cursor (§6.3 P14g) — a session logged
  //    without watch data must not consume an `Effort` row it will never fill.
  const rowCounts = {};
  for (const { spec, rows } of projection) {
    if (rows.length) rowCounts[spec.tab] = rows.length;
  }
  if (Object.keys(rowCounts).length === 0) {
    // A closed session with no exportable rows is complete by definition.
    const acked = await adapter.acknowledgeExport(sessionId, claim.export_claim_token);
    return { session_id: sessionId, exported: acked, reason: acked ? null : 'claim_superseded' };
  }

  let allocations;
  try {
    allocations = await adapter.allocateMirrorBlocks(sessionId, rowCounts);
  } catch (error) {
    return fail('allocation_failed', error && error.message);
  }

  // 3. Pre-write: read each tab whole and refuse if any allocated range is not ours.
  //    The read is the same one mechanism 3 needs, so the check costs nothing extra.
  const preWrite = new Map();
  for (const { spec, rows } of projection) {
    if (!rows.length) continue;
    let tabRows;
    try {
      tabRows = await readWholeTab(spec.tab);
    } catch (error) {
      return fail('tab_read_failed', `${spec.tab}: ${error && error.message}`);
    }
    preWrite.set(spec.tab, tabRows);
    const block = allocations[spec.tab];
    if (!block) return fail('allocation_failed', `no block for ${spec.tab}`);
    if (!rangeIsWritable(tabRows, spec, block, sessionId)) {
      return fail(STRUCTURAL_RANGE_OCCUPIED, `${spec.tab} rows ${block.start_row}-${block.end_row}`);
    }
  }

  // 4. Write each block to its exact allocated range. Idempotent by destination.
  for (const { spec, rows } of projection) {
    if (!rows.length) continue;
    const block = allocations[spec.tab];
    try {
      await sheetsModule().updateRangeValues(spec.tab, Number(block.start_row), rows);
    } catch (error) {
      // An ambiguous write may or may not have landed. That is safe here precisely
      // because the destination is deterministic: the retry rewrites the same values
      // into the same cells, and the verifier below is what decides whether the tab
      // is correct — never an assumption about whether this call succeeded.
      return fail('sheets_write_failed', `${spec.tab}: ${error && error.message}`);
    }
  }

  // 5. Verify the WHOLE tab, then acknowledge. A death between the write and the
  //    acknowledgement is safe: the restart re-claims, rewrites the same cells,
  //    verifies and acknowledges.
  for (const { spec, rows } of projection) {
    if (!rows.length) continue;
    let tabRows;
    try {
      tabRows = await readWholeTab(spec.tab);
    } catch (error) {
      return fail('tab_read_failed', `${spec.tab}: ${error && error.message}`);
    }
    const verdict = verifyIdentitiesOnce(tabRows, spec, rows);
    if (!verdict.ok) {
      return fail(STRUCTURAL_DUPLICATE_IDENTITY, `${spec.tab} key ${verdict.key} seen ${verdict.seen}x`);
    }
  }

  // The claim token is the acknowledgement guard: a superseded worker's token no
  // longer matches, so its late acknowledgement matches zero rows and cannot mark a
  // session exported on the strength of a stale observation.
  const acknowledged = await adapter.acknowledgeExport(sessionId, claim.export_claim_token);
  return {
    session_id: sessionId,
    exported: acknowledged,
    reason: acknowledged ? null : 'claim_superseded',
  };
}

/**
 * Run one pass of the worker: claim and export sessions until the queue is empty or
 * `maxSessions` is reached.
 *
 * BOUNDED ON PURPOSE. An unbounded pass would hold the process on a large backlog
 * and issue an unbounded number of whole-tab reads in one burst.
 */
async function runExportPass({ maxSessions = 10, now = new Date() } = {}) {
  const results = [];
  for (let i = 0; i < maxSessions; i += 1) {
    let claim;
    try {
      claim = await adapter.claimExportSession();
    } catch (error) {
      // The authority is unreachable. Stop the pass; the workout is unaffected.
      return { results, stopped: 'authority_unavailable', detail: error && error.message };
    }
    if (!claim) break;
    results.push(await exportClaimedSession(claim, { now }));
  }
  return { results, stopped: null };
}

/**
 * The backlog `npm run atlas:status` reports, so a stalled mirror is visible rather
 * than silent. Read-only.
 */
async function exportStatus() {
  const [backlog, blocked] = await Promise.all([
    adapter.exportBacklog(),
    adapter.listBlockedExports(),
  ]);
  return {
    sessions_owed: Number(backlog?.sessions_owed || 0),
    sessions_blocked: Number(backlog?.sessions_blocked || 0),
    oldest_session_id: backlog?.oldest_session_id || null,
    oldest_session_date: backlog?.oldest_session_date || null,
    blocked: (blocked || []).map((row) => ({
      session_id: row.session_id,
      session_date: row.session_date,
      error: row.sheets_export_error,
      attempts: Number(row.sheets_export_attempts || 0),
    })),
  };
}

module.exports = {
  runExportPass,
  exportClaimedSession,
  exportStatus,
  // Exported for the proofs: each is a pure decision the design names explicitly.
  nextAttemptAt,
  rangeIsWritable,
  verifyIdentitiesOnce,
  isStructural,
  TAB_SPECS,
  ATTEMPT_CEILING,
  BACKOFF_CAP_MINUTES,
  STRUCTURAL_RANGE_OCCUPIED,
  STRUCTURAL_DUPLICATE_IDENTITY,
};
