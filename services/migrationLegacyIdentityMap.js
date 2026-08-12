'use strict';

// THE ONE FROZEN LEGACY IDENTITY AUTHORITY, and the ONE resolver both migration
// consumers call.
//
// TEMPORARY — S4 deletes this module, `config/migration/legacy-session-identity-map.json`,
// and every branch that reads them, after a successful production apply and a clean
// reconciliation. No legacy grammar enters the permanent runtime: `SESSION_ID_SHAPE`
// in the row contract is untouched, live session-id generation is untouched, and
// translation happens only here, at migration read time.
//
// Design authority: docs/SUPABASE_HOT_PATH_MIGRATION.md §5.3; owner rulings recorded
// 2026-08-12 (cards 1-7 and the prior 1046/1054 ruling), carried in the map itself.
//
// ── WHY ONE RESOLVER RATHER THAN A LOOKUP HELPER ─────────────────────────────
// A map-aware backfill beside a map-unaware sweep would report every translated row
// as a divergence: Sheets holds the legacy string, Supabase the canonical one. The
// two consumers therefore do not each decide what a row is — they call
// `resolveSheetRows` and take its verdicts verbatim. There is no second mapping
// path to drift from.
//
// ── FAIL CLOSED ──────────────────────────────────────────────────────────────
// A legacy session_id absent from the map resolves to `unmapped_legacy`, which the
// backfill and the sweep both treat as a completeness failure. Nothing is guessed,
// nothing is defaulted, and no row is silently skipped. A malformed map, a duplicate
// source key, or a canonical target that fails the live identity shape throws at
// load rather than translating anything.
//
// ── OWNER-DECLARED IS NOT DERIVED ────────────────────────────────────────────
// Slot is carried by NO legacy id, and 30 sessions carry no period evidence at all.
// Those values are the owner's declaration, and the map records them as
// `OWNER_DECLARED` per component so no reader can mistake them for source evidence.

const crypto = require('crypto');
const path = require('path');

const contract = require('./migrationRowContract');

const MAP_PATH = path.join(__dirname, '..', 'config', 'migration', 'legacy-session-identity-map.json');

const DISPOSITIONS = new Set(['MAP', 'MERGE_INTO_EXISTING']);
const PROVENANCE = new Set([
  'source_derived_embedded_in_id',
  'source_derived_carried_by_id',
  'source_derived_row_date_column',
  'cross_tab_structurally_derived',
  'OWNER_DECLARED',
]);

// NUL, assembled rather than written, so this source file stays plain text. It is the
// fingerprint's cell separator: no cell value can contain it, so no two different rows
// can be joined into the same string.
const CELL_SEPARATOR = String.fromCharCode(0);

// A row's content identity, for the rows that CANNOT be keyed by session identity:
// the two identityless Log_Cleaned fragments (no key at all) and the excluded half of
// the Effort duplicate (its key is shared with the row that survives). A sheet row
// NUMBER would break the moment a row moved; content does not.
function rowFingerprint(cells) {
  return crypto
    .createHash('sha256')
    .update((cells || []).map((cell) => String(cell ?? '').trim()).join(CELL_SEPARATOR))
    .digest('hex')
    .slice(0, 16);
}

function validate(map) {
  const problems = [];
  if (!map || map.frozen !== true) problems.push('map is not marked frozen');
  if (map && map.owner_approved !== true) problems.push('map is not owner-approved');
  if (!map || !Array.isArray(map.sessions)) problems.push('map.sessions is not an array');

  const seen = new Set();
  for (const entry of (map && map.sessions) || []) {
    const key = String(entry.legacy_session_id ?? '').trim();
    const where = key || '<blank legacy_session_id>';
    if (!key) { problems.push('an entry has a blank legacy_session_id'); continue; }
    const lower = key.toLowerCase();
    if (seen.has(lower)) problems.push(`duplicate source key: ${where}`);
    seen.add(lower);

    if (!DISPOSITIONS.has(entry.disposition)) problems.push(`${where}: unknown disposition ${entry.disposition}`);
    // A canonical target must satisfy the LIVE identity shape. This is the guard that
    // keeps legacy grammar out of the destination: the map may only ever produce an
    // id the current contract already accepts.
    if (!contract.parseSessionId(entry.canonical_session_id)) {
      problems.push(`${where}: canonical_session_id ${entry.canonical_session_id} fails the canonical identity shape`);
    }
    const provenance = entry.provenance || {};
    for (const component of ['date', 'period', 'slot']) {
      if (!PROVENANCE.has(provenance[component])) {
        problems.push(`${where}: ${component} provenance ${provenance[component]} is not a declared provenance`);
      }
    }
    // Slot is carried by no legacy id in the corpus. If a future entry ever claims a
    // derived slot, that claim is a lie about the evidence and must fail here.
    if (provenance.slot !== 'OWNER_DECLARED') problems.push(`${where}: slot provenance must be OWNER_DECLARED`);
  }

  for (const entry of (map && map.excluded_sessions) || []) {
    if (entry.disposition !== 'EXCLUDE') problems.push(`excluded session ${entry.session_id}: disposition must be EXCLUDE`);
    if (!String(entry.session_id ?? '').trim()) problems.push('an excluded session has a blank session_id');
    if (!String(entry.owner_ruling ?? '').trim()) problems.push(`excluded session ${entry.session_id}: no owner_ruling recorded`);
  }
  for (const entry of (map && map.excluded_rows) || []) {
    if (entry.disposition !== 'EXCLUDE') problems.push(`excluded row ${entry.row_fingerprint}: disposition must be EXCLUDE`);
    if (!/^[0-9a-f]{16}$/.test(String(entry.row_fingerprint ?? ''))) {
      problems.push(`excluded row: ${entry.row_fingerprint} is not a row fingerprint`);
    }
    if (!contract.CONCEPT_NAMES.includes(entry.concept)) problems.push(`excluded row ${entry.row_fingerprint}: unknown concept ${entry.concept}`);
    if (!String(entry.owner_ruling ?? '').trim()) problems.push(`excluded row ${entry.row_fingerprint}: no owner_ruling recorded`);
  }

  if (problems.length) {
    throw new Error(`legacy identity map is invalid — ${problems.length} problem(s): ${problems.join('; ')}`);
  }
  return map;
}

let cache = null;

function loadMap(override) {
  if (override) return validate(override);
  if (!cache) {
    // eslint-disable-next-line global-require
    cache = validate(require(MAP_PATH));
  }
  return cache;
}

function indexMap(map) {
  const sessions = new Map();
  for (const entry of map.sessions) sessions.set(String(entry.legacy_session_id).trim().toLowerCase(), entry);
  const excludedSessions = new Map();
  for (const entry of map.excluded_sessions || []) excludedSessions.set(String(entry.session_id).trim().toUpperCase(), entry);
  const excludedRows = new Map();
  for (const entry of map.excluded_rows || []) excludedRows.set(`${entry.concept}|${entry.row_fingerprint}`, entry);
  return { sessions, excludedSessions, excludedRows };
}

// ── THE ONE RESOLVER ──────────────────────────────────────────────────────────
//
// Verdicts, in the order they are decided:
//
//   blank            — a padded empty array; not a row (PR #1285's predicate)
//   excluded_row     — an explicit frozen row-level EXCLUDE
//   no_identity      — a real row with an empty export identity; still a FAILURE
//   excluded_session — the resolved canonical session carries a frozen EXCLUDE
//   canonical        — already canonical; PASSES THROUGH UNTRANSLATED
//   translated       — a mapped legacy id, session_id rewritten to canonical
//   unmapped_legacy  — a legacy id absent from the map; a FAILURE, never a skip
//
// `rows` carries the rows eligible to be WRITTEN. `unmappedRows` carries the rows
// that must still be COMPARED — Sheets holds them and Supabase cannot, so the sweep
// and the reconciliation index them and open the divergence, while the backfill
// writes neither. Both consumers read the same verdicts; they differ only in which
// of the two lists their job needs, and that difference is stated here rather than
// re-decided in either of them.
function resolveSheetRows(concept, sheetRows, options = {}) {
  const map = loadMap(options.map);
  const index = indexMap(map);
  const counts = {
    blank: 0,
    excluded_row: 0,
    no_identity: 0,
    excluded_session: 0,
    canonical: 0,
    translated: 0,
    unmapped_legacy: 0,
  };
  const rows = [];
  // Unmapped rows, kept in their SOURCE form. They are never written, but the
  // comparison lanes still index them: Sheets is the authority and holds a row
  // Supabase lacks, so it must surface as a durable divergence rather than vanish
  // into a counter. This is the treatment a duplicate identity already gets — the
  // divergence is opened, the repair worker refuses it, and only the owner resolves
  // it. Splitting them from `rows` is what stops the backfill writing one.
  const unmappedRows = [];
  const unmapped = [];

  for (const cells of sheetRows || []) {
    if (contract.isBlankSheetRow(cells)) { counts.blank += 1; continue; }

    const fingerprintKey = `${concept}|${rowFingerprint(cells)}`;
    if (index.excludedRows.has(fingerprintKey)) { counts.excluded_row += 1; continue; }

    const row = contract.rowFromSheet(concept, cells);
    if (contract.isIdentityless(contract.identityKey(concept, row))) { counts.no_identity += 1; continue; }

    const sessionId = contract.sessionIdOf(concept, row);
    if (!sessionId) { counts.canonical += 1; rows.push(row); continue; }

    if (contract.parseSessionId(sessionId)) {
      // ALREADY CANONICAL — never translated, never rewritten. The map may only
      // exclude it, and only through an explicit frozen entry.
      if (index.excludedSessions.has(sessionId.trim().toUpperCase())) { counts.excluded_session += 1; continue; }
      counts.canonical += 1;
      rows.push(row);
      continue;
    }

    const entry = index.sessions.get(sessionId.trim().toLowerCase());
    if (!entry) {
      counts.unmapped_legacy += 1;
      unmapped.push(sessionId.trim());
      unmappedRows.push(row);
      continue;
    }
    const canonical = entry.canonical_session_id;
    if (index.excludedSessions.has(String(canonical).trim().toUpperCase())) { counts.excluded_session += 1; continue; }
    counts.translated += 1;
    rows.push({ ...row, session_id: canonical });
  }

  return { rows, unmappedRows, counts, unmapped: [...new Set(unmapped)] };
}

module.exports = {
  MAP_PATH,
  loadMap,
  rowFingerprint,
  resolveSheetRows,
};
