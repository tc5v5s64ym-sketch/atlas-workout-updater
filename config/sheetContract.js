const requiredSheetTabs = ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'];
const optionalSheetTabs = ['Dashboard', 'Coaching_Notes', 'Constraints', 'Deload_State', 'Session_Plans', 'Session_Plan_Sets', 'Modality_Log', 'Brain_Shadow', 'Intent_Shadow', 'Flight_Recorder', 'Coach_Shadow', 'Coach_Response'];

// Normalize a header cell or column key to a comparable token: lowercase,
// strip everything that isn't a letter or digit. This unifies the variants a
// hand-edited sheet header and the canonical column key can take —
// "Session ID", "session_id", and "sessionId" all collapse to "sessionid".
function normalizeHeaderToken(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Validate an actual sheet header row against the expected column contract,
// position by position. A cell matches if its normalized token equals the
// expected column key or any of that column's accepted aliases (e.g. the
// per-column aliases in config/columns.js). Extra trailing columns beyond the
// contract are ignored — appended data still lands in the right place as long
// as positions 0..N-1 line up. Pure function, no I/O.
//
// Returns { ok, mismatches } where each mismatch is
// { index, expected, actual } (actual is null when the row is too short).
function validateHeaderRow(actualHeader, expectedColumns, aliases = {}) {
  const header = Array.isArray(actualHeader) ? actualHeader : [];
  const expected = Array.isArray(expectedColumns) ? expectedColumns : [];
  const mismatches = [];

  for (let i = 0; i < expected.length; i += 1) {
    const expectedKey = expected[i];
    const accepted = new Set(
      [expectedKey, ...(aliases[expectedKey] || [])].map(normalizeHeaderToken)
    );
    const hasCell = i < header.length;
    const actualToken = hasCell ? normalizeHeaderToken(header[i]) : '';
    if (!accepted.has(actualToken)) {
      mismatches.push({
        index: i,
        expected: expectedKey,
        actual: hasCell ? header[i] : null
      });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

function getMissingRequiredTabs(tabNames) {
  const present = new Set(tabNames || []);
  return requiredSheetTabs.filter(tab => !present.has(tab));
}

function buildSheetContractStatus(tabNames) {
  const present = new Set(tabNames || []);
  return {
    required: requiredSheetTabs.reduce((acc, tab) => {
      acc[tab] = present.has(tab);
      return acc;
    }, {}),
    optional: optionalSheetTabs.reduce((acc, tab) => {
      acc[tab] = present.has(tab);
      return acc;
    }, {}),
    missingRequiredTabs: getMissingRequiredTabs(tabNames)
  };
}

module.exports = {
  requiredSheetTabs,
  optionalSheetTabs,
  getMissingRequiredTabs,
  buildSheetContractStatus,
  normalizeHeaderToken,
  validateHeaderRow
};
