'use strict';

// The ONE row contract between a Google Sheets row and its Supabase counterpart.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §4 (field-by-field
// mapping), §4.7 (the blank-versus-null rule), §3.2-§3.5 (the export identity
// keys), §3.8 (the redacted comparison_result).
//
// Every S2 mechanism reads this module and nothing else for these three
// questions, so the shadow write, the reconciliation sweep, and the repair worker
// can never disagree about what a row IS, what its IDENTITY is, or whether two
// copies of it are EQUAL:
//
//   1. mapping     — a 12/9/13/16-cell Sheets row array <-> a Supabase row object;
//   2. identity    — the export identity key, byte-for-byte the key the Sheets
//                    dedupe already uses;
//   3. equality    — a normalised, provenance-excluded, field-level comparison,
//                    whose difference report redacts workout values to SHAPES.
//
// A divergence closes only on a passing re-comparison performed by compareRows()
// here. Two comparison implementations would be two authorities, which is exactly
// the defect this migration exists to remove.
//
// PURE. It holds no client, reads no environment, and performs no I/O.

const crypto = require('crypto');

const {
  logCleanedColumns,
  effortColumns,
  sessionPlansColumns,
  sessionPlanSetsColumns,
  exerciseCatalogColumns,
} = require('../config/columns');

// ── Value kinds ────────────────────────────────────────────────────────────────
//
// §4.7, stated once and applied everywhere:
//   TEXT   — a blank cell reads as NULL;
//   VOCAB  — a blank cell stays '', because '' is a MEMBER of an owner-frozen
//            vocabulary and means "not applicable to this event type";
//   INT / NUM / DATE — a blank cell reads as NULL, never 0 and never an epoch.
const TEXT = 'text';
const VOCAB = 'vocab';
const INT = 'int';
const NUM = 'num';
const DATE = 'date';
const TIMESTAMP = 'timestamp';

function blank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function normalizeDate(value) {
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }
  // The production Effort corpus contains two legacy session-stamped dates in
  // YYYYMMDD-(AM|PM) form. The period is identity provenance, not part of a SQL
  // DATE, so remove it only for this exact, observed shape. Validate the calendar
  // components arithmetically: Date-string parsing would be locale-dependent and
  // Date construction can normalise an impossible day into a different month.
  const legacySessionDate = raw.match(/^(\d{4})(\d{2})(\d{2})-(AM|PM)$/);
  if (legacySessionDate) {
    const year = Number(legacySessionDate[1]);
    const month = Number(legacySessionDate[2]);
    const day = Number(legacySessionDate[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]) {
      return `${legacySessionDate[1]}-${legacySessionDate[2]}-${legacySessionDate[3]}`;
    }
    // Preserve an invalid legacy-shaped value so the destination rejects it. A
    // migration contract may fail closed; it may never roll a bad date forward.
    return raw;
  }
  // A Date instance can arrive from a driver whose DATE parser was not pinned.
  // Use the UTC face deliberately: Postgres hands a date back at UTC midnight, so
  // the local face would shift the day west of Greenwich.
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return raw;
}

// Canonicalise ONE cell/column value to the form both sides are compared in.
// Sheets hands text; Postgres hands text, numbers-as-text (numeric), or Date.
function canonicalize(kind, value) {
  if (kind === VOCAB) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
  }
  if (blank(value)) return null;
  switch (kind) {
    case INT: {
      const n = Number(String(value).trim());
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case NUM: {
      const n = Number(String(value).trim());
      return Number.isFinite(n) ? n : null;
    }
    case DATE:
      return normalizeDate(value);
    case TIMESTAMP:
      return value instanceof Date ? value.toISOString() : String(value).trim();
    default:
      return String(value).trim();
  }
}

// ── The four migrated concepts ─────────────────────────────────────────────────
//
// `sheetColumn` is the Sheets header the value comes from; `column` is the
// Supabase column it maps to. `compare: false` marks PROVENANCE — recorded_at is
// excluded from the content comparison exactly as it is today, and the surrogate
// `id`, `created_at` and `write_id` are never compared because Sheets does not
// carry them.
const CONCEPTS = {
  logged_sets: {
    table: 'atlas.logged_sets',
    tab: 'Log_Cleaned',
    sheetColumns: logCleanedColumns,
    fields: [
      { column: 'date_clean', sheetColumn: 'date_clean', kind: DATE },
      { column: 'session_id', sheetColumn: 'session_id', kind: TEXT },
      { column: 'exercise', sheetColumn: 'exercise', kind: TEXT },
      { column: 'canonical_exercise', sheetColumn: 'canonical_exercise', kind: TEXT },
      { column: 'muscle_group', sheetColumn: 'muscle_group', kind: TEXT },
      { column: 'lift_code', sheetColumn: 'lift_code', kind: TEXT },
      { column: 'set_number', sheetColumn: 'set_number', kind: INT },
      { column: 'weight', sheetColumn: 'weight', kind: NUM },
      { column: 'reps', sheetColumn: 'reps', kind: INT },
      { column: 'rir', sheetColumn: 'rir', kind: NUM },
      { column: 'notes', sheetColumn: 'notes', kind: TEXT },
      { column: 'volume_calc', sheetColumn: 'volume_calc', kind: NUM },
    ],
    // Exactly the composite key getLogCompositeKeys() builds today:
    // session_id||exercise||set_number, lower-cased whole.
    identity: (row) =>
      [
        String(row.session_id ?? '').trim().toLowerCase(),
        String(row.exercise ?? '').trim().toLowerCase(),
        String(canonicalize(INT, row.set_number) ?? '').trim(),
      ].join('||'),
    sessionIdOf: (row) => (blank(row.session_id) ? null : String(row.session_id).trim()),
  },

  session_effort: {
    table: 'atlas.session_effort',
    tab: 'Effort',
    sheetColumns: effortColumns,
    fields: [
      { column: 'effort_date', sheetColumn: 'date', kind: DATE },
      { column: 'session_id', sheetColumn: 'session_id', kind: TEXT },
      { column: 'duration', sheetColumn: 'duration', kind: TEXT },
      { column: 'active_calories', sheetColumn: 'active_calories', kind: NUM },
      { column: 'total_calories', sheetColumn: 'total_calories', kind: NUM },
      { column: 'average_hr', sheetColumn: 'average_hr', kind: NUM },
      { column: 'peak_hr', sheetColumn: 'peak_hr', kind: NUM },
      { column: 'location', sheetColumn: 'location', kind: TEXT },
      { column: 'notes', sheetColumn: 'notes', kind: TEXT },
    ],
    // One Effort row per session IS the existing duplicate-session guard.
    identity: (row) => String(row.session_id ?? '').trim().toLowerCase(),
    sessionIdOf: (row) => (blank(row.session_id) ? null : String(row.session_id).trim()),
  },

  session_plan_events: {
    table: 'atlas.session_plan_events',
    tab: 'Session_Plans',
    sheetColumns: sessionPlansColumns,
    fields: [
      { column: 'idempotency_key', sheetColumn: 'idempotency_key', kind: TEXT },
      { column: 'session_id', sheetColumn: 'session_id', kind: TEXT },
      { column: 'session_date', sheetColumn: 'session_date', kind: DATE },
      { column: 'plan_version', sheetColumn: 'plan_version', kind: INT },
      { column: 'event_type', sheetColumn: 'event_type', kind: TEXT },
      // '' on a session_closeout row, and the idempotency key is derived from it,
      // so it must not become NULL or the key would change.
      { column: 'plan_item_id', sheetColumn: 'plan_item_id', kind: VOCAB },
      { column: 'planned_order', sheetColumn: 'planned_order', kind: INT },
      { column: 'planned_lift_code', sheetColumn: 'planned_lift_code', kind: TEXT },
      { column: 'movement_pattern', sheetColumn: 'movement_pattern', kind: TEXT },
      { column: 'outcome', sheetColumn: 'outcome', kind: VOCAB },
      { column: 'performed_lift_code', sheetColumn: 'performed_lift_code', kind: TEXT },
      { column: 'closeout_status', sheetColumn: 'closeout_status', kind: VOCAB },
      { column: 'recorded_at', sheetColumn: 'recorded_at', kind: TIMESTAMP, compare: false },
    ],
    identity: (row) => String(row.idempotency_key ?? '').trim(),
    sessionIdOf: (row) => (blank(row.session_id) ? null : String(row.session_id).trim()),
  },

  session_plan_set_recommendations: {
    table: 'atlas.session_plan_set_recommendations',
    tab: 'Session_Plan_Sets',
    sheetColumns: sessionPlanSetsColumns,
    fields: [
      { column: 'idempotency_key', sheetColumn: 'idempotency_key', kind: TEXT },
      { column: 'session_id', sheetColumn: 'session_id', kind: TEXT },
      { column: 'session_date', sheetColumn: 'session_date', kind: DATE },
      { column: 'plan_version', sheetColumn: 'plan_version', kind: INT },
      { column: 'plan_item_id', sheetColumn: 'plan_item_id', kind: TEXT },
      { column: 'planned_lift_code', sheetColumn: 'planned_lift_code', kind: TEXT },
      { column: 'set_index', sheetColumn: 'set_index', kind: INT },
      { column: 'target_set_count', sheetColumn: 'target_set_count', kind: INT },
      // Blank becomes NULL, never 0 — a 0 target is a prescription, a blank is not.
      { column: 'target_weight', sheetColumn: 'target_weight', kind: NUM },
      { column: 'target_reps', sheetColumn: 'target_reps', kind: INT },
      { column: 'target_rir', sheetColumn: 'target_rir', kind: NUM },
      { column: 'recommendation_source', sheetColumn: 'recommendation_source', kind: TEXT },
      { column: 'supersedes_key', sheetColumn: 'supersedes_key', kind: TEXT },
      { column: 'confidence', sheetColumn: 'confidence', kind: TEXT },
      { column: 'closeout_write_id', sheetColumn: 'closeout_write_id', kind: TEXT },
      { column: 'recorded_at', sheetColumn: 'recorded_at', kind: TIMESTAMP, compare: false },
    ],
    identity: (row) => String(row.idempotency_key ?? '').trim(),
    sessionIdOf: (row) => (blank(row.session_id) ? null : String(row.session_id).trim()),
  },
};

// The fifth declared divergence concept. It is NOT a row concept: its identity is
// the sync generation's content_hash, not an export identity key (§3.8).
const CATALOG_CONCEPT = 'exercise_catalog';

const CONCEPT_NAMES = Object.freeze(Object.keys(CONCEPTS));

function conceptSpec(concept) {
  const spec = CONCEPTS[concept];
  if (!spec) throw new Error(`Unknown migration concept: ${concept}`);
  return spec;
}

// ── Mapping ────────────────────────────────────────────────────────────────────

// A Sheets row ARRAY (positional, contract order) -> a Supabase row OBJECT.
// Short rows are legal: Sheets omits trailing empty cells, and a missing cell is
// a blank cell, not an error.
function rowFromSheet(concept, cells) {
  const spec = conceptSpec(concept);
  const out = {};
  for (const field of spec.fields) {
    const index = spec.sheetColumns.indexOf(field.sheetColumn);
    const raw = index >= 0 ? (Array.isArray(cells) ? cells[index] : undefined) : undefined;
    out[field.column] = canonicalize(field.kind, raw);
  }
  return out;
}

// A Supabase row OBJECT (as the driver returns it) -> the same canonical shape.
function rowFromSupabase(concept, row) {
  const spec = conceptSpec(concept);
  const out = {};
  for (const field of spec.fields) {
    out[field.column] = canonicalize(field.kind, row ? row[field.column] : undefined);
  }
  return out;
}

// The canonical row back to a Sheets row ARRAY. NULL writes an empty cell (§4.7
// rule 4). Used by the sweep's difference report and by the S4 export's identity
// checks; it is the inverse of rowFromSheet for every value the contract keeps.
function sheetCellsFromRow(concept, row) {
  const spec = conceptSpec(concept);
  const byColumn = new Map(spec.fields.map((f) => [f.sheetColumn, f]));
  return spec.sheetColumns.map((sheetColumn) => {
    const field = byColumn.get(sheetColumn);
    if (!field) return '';
    const value = row ? row[field.column] : null;
    return value === null || value === undefined ? '' : String(value);
  });
}

function identityKey(concept, row) {
  return conceptSpec(concept).identity(row || {});
}

// ── IS THIS ROW REPRESENTABLE AT ALL? ──────────────────────────────────────────
//
// *Added by the required Atlas Contract / Systems Review of `65310b3`, finding 3.*
//
// A row whose export identity is entirely blank cannot be matched, compared,
// repaired, or given a divergence — a divergence is keyed BY identity. Both
// consumers of this contract used to drop such a row silently, so an authoritative
// Sheets row that Supabase can never represent vanished from every count and the
// migration still reported clean. That is the exact false green the S3 gates exist
// to prevent, and it is why this predicate lives here, beside `identityKey`, rather
// than being re-derived in the sweep and in the backfill.
//
// EMPTY, NOT MERELY PARTIAL. `session_id||exercise||set_number` with every part
// blank joins to `'||||'`, and a single-component key joins to `''` — both are
// identityless. A PARTIAL key (`'20260801-AM-01||||'`) is deliberately NOT: it is
// still a distinguishable identity, it is still indexed, and Supabase's NOT NULL
// columns will surface it as a genuine divergence rather than as a disappearance.
//
// Nothing here invents an identity. Recognising that a row has none is the whole
// point; guessing one would make it representable and hide the defect.
function isIdentityless(key) {
  if (key === null || key === undefined) return true;
  return String(key).split('||').every((part) => part.trim() === '');
}

// ── IS THIS A ROW AT ALL? ──────────────────────────────────────────────────────
//
// A DIFFERENT QUESTION FROM `isIdentityless`, and the distinction is the whole
// point. `isIdentityless` asks whether a row's export identity is empty; this asks
// whether the SHEETS ROW ITSELF carries any cell at all.
//
// Google Sheets' `values.get` pads: a stray row far below the data block forces
// every intervening row to be returned as an all-blank array. Those padded arrays
// are not history, not authoritative, and not owner-actionable — they are the
// absence of a row. Counting them as identityless authoritative rows made the
// backfill escalate 924 empty Effort arrays to the owner and buried the two
// genuinely identityless Log_Cleaned rows inside that number.
//
// ONE NON-BLANK CELL IS ENOUGH TO DISQUALIFY. A row carrying a single populated
// cell is a real row with no usable identity, and it MUST keep failing the
// migration. Widening this predicate to "looks mostly empty" would re-create the
// silent-drop defect that `isIdentityless` was added to remove.
//
// SHEETS SIDE ONLY, by construction: it accepts the positional cell ARRAY that
// `getSheetRows` returns. A Supabase row arrives as an object, is not an array,
// and can therefore never be classified blank by this predicate.
function isBlankSheetRow(cells) {
  if (!Array.isArray(cells)) return false;
  return cells.every((cell) => cell === undefined || cell === null || String(cell).trim() === '');
}

function sessionIdOf(concept, row) {
  return conceptSpec(concept).sessionIdOf(row || {});
}

// ── The session parent, derived rather than sourced ────────────────────────────
//
// §5.2: every shadow transaction inserts its atlas.workout_sessions parent first,
// and the parent is DERIVABLE — session_id carries its own YYYYMMDD-{AM|PM}-NN
// structure (services/sessionId.js), which yields session_date, period and slot by
// parsing alone. No extra source is needed and none is invented.
const SESSION_ID_SHAPE = /^(\d{4})(\d{2})(\d{2})-(AM|PM)-(\d{2})$/;

function parseSessionId(sessionId) {
  const match = SESSION_ID_SHAPE.exec(String(sessionId ?? '').trim().toUpperCase());
  if (!match) return null;
  const [, year, month, day, period, slot] = match;
  const slotNumber = Number(slot);
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 99) return null;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;
  return {
    session_id: String(sessionId).trim(),
    session_date: `${year}-${month}-${day}`,
    period,
    slot: slotNumber,
  };
}

// ── Equality, and the redacted difference report ───────────────────────────────

// A SHAPE, never a value. §3.8 requires comparison_result to redact workout values;
// a difference report that quotes the load and the rep count is workout data in a
// migration-control table.
function shapeOf(value) {
  if (value === null || value === undefined) return 'null';
  if (value === '') return 'empty';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `int(${String(Math.abs(value)).length})` : 'decimal';
  }
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'date';
  return `text(len=${text.length})`;
}

// Compare two CANONICAL rows of one concept, field by field, excluding
// provenance. Returns { equal, differences } where every difference carries the
// field name and both SHAPES — never the values.
function compareRows(concept, sheetRow, supabaseRow) {
  const spec = conceptSpec(concept);
  const differences = [];
  for (const field of spec.fields) {
    if (field.compare === false) continue;
    const left = sheetRow ? sheetRow[field.column] : undefined;
    const right = supabaseRow ? supabaseRow[field.column] : undefined;
    const a = canonicalize(field.kind, left);
    const b = canonicalize(field.kind, right);
    if (a === b) continue;
    // Text identity is case-insensitive for the two columns whose existing dedupe
    // and ownership checks already trim and lower-case (§3, conventions).
    if (
      (field.column === 'session_id' || field.column === 'exercise') &&
      typeof a === 'string' &&
      typeof b === 'string' &&
      a.toLowerCase() === b.toLowerCase()
    ) {
      continue;
    }
    differences.push({ field: field.column, sheets: shapeOf(a), supabase: shapeOf(b) });
  }
  return { equal: differences.length === 0, differences };
}

// ── The catalog's content identity ─────────────────────────────────────────────
//
// SHA-256 over the normalised source rows, in order (§3.7). The hash is the
// generation's version identity and the exercise_catalog divergence's
// identity_key, so both sides must compute it the same way — which is why it
// lives here beside the row contract rather than inside the sync.
function normalizeCatalogRows(rows) {
  const header = exerciseCatalogColumns.map((h) => h.toLowerCase());
  const out = [];
  for (const cells of rows || []) {
    if (!Array.isArray(cells)) continue;
    const first = String(cells[0] ?? '').trim();
    if (!first) continue;
    // Skip the header row wherever it appears, matching the existing reader.
    if (header[0] === first.toLowerCase()) continue;
    out.push({
      exercise: first.toLowerCase(),
      display_exercise: first,
      muscle_group: canonicalize(TEXT, cells[1]),
      lift_code: canonicalize(TEXT, cells[2]),
      canonical_exercise: canonicalize(TEXT, cells[3]),
    });
  }
  out.sort((a, b) => (a.exercise < b.exercise ? -1 : a.exercise > b.exercise ? 1 : 0));
  return out;
}

// Field and record separators are control characters that cannot occur in a
// catalog cell, so no arrangement of cell contents can forge a different row set
// with the same hash.
const HASH_FIELD_SEPARATOR = '\u0000';
const HASH_RECORD_SEPARATOR = '\u0001';

function catalogContentHash(normalizedRows) {
  const hash = crypto.createHash('sha256');
  for (const row of normalizedRows || []) {
    hash.update(
      [
        row.exercise,
        row.display_exercise,
        row.muscle_group ?? '',
        row.lift_code ?? '',
        row.canonical_exercise ?? '',
      ].join(HASH_FIELD_SEPARATOR)
    );
    hash.update(HASH_RECORD_SEPARATOR);
  }
  return hash.digest('hex');
}

module.exports = {
  CONCEPTS,
  CONCEPT_NAMES,
  CATALOG_CONCEPT,
  conceptSpec,
  canonicalize,
  rowFromSheet,
  rowFromSupabase,
  sheetCellsFromRow,
  identityKey,
  isIdentityless,
  isBlankSheetRow,
  sessionIdOf,
  parseSessionId,
  compareRows,
  shapeOf,
  normalizeCatalogRows,
  catalogContentHash,
  // Kinds are exported so a test can assert the §4.7 rule directly rather than
  // through a concept that happens to use it.
  KINDS: Object.freeze({ TEXT, VOCAB, INT, NUM, DATE, TIMESTAMP }),
};
