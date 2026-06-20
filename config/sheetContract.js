const { tabColumnContracts } = require('./columns');

const requiredSheetTabs = ['Metadata', 'Log_Cleaned', 'Exercise_Catalog', 'Effort', 'Logic', 'Session_Summary'];
const optionalSheetTabs = ['Dashboard', 'Coaching_Notes', 'Constraints', 'Deload_State'];

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

// Collapse a header cell to a comparison token: lower-cased, with any run of
// non-alphanumerics turned into a single underscore. This makes the check
// robust to benign formatting drift ("Lift Code" / "lift_code" / "LIFT_CODE"
// all match) while still catching a *reordered* column, where the field at a
// given position is a genuinely different name.
function canonicalHeaderToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Pure validator: compare a tab's actual header row (array of cell values) to
// its column contract. Position-sensitive — order matters. Returns a structured
// result; never throws. Tabs without a contract are reported known:false, ok:true
// (we don't police tabs Atlas doesn't write by index).
function validateTabHeader(tabName, actualHeader) {
  const expected = tabColumnContracts[tabName];
  const actual = Array.isArray(actualHeader) ? actualHeader : [];
  if (!expected) {
    return { tab: tabName, known: false, ok: true, expected: null, actual, mismatches: [] };
  }
  const mismatches = [];
  const len = Math.max(expected.length, actual.length);
  for (let i = 0; i < len; i += 1) {
    const exp = expected[i];
    const act = actual[i];
    const actToken = canonicalHeaderToken(act);
    if (exp == null) {
      mismatches.push({ index: i, expected: null, actual: act == null ? null : String(act), kind: 'extra_column' });
    } else if (actToken === '') {
      mismatches.push({ index: i, expected: exp, actual: act == null ? null : String(act), kind: 'missing_column' });
    } else if (canonicalHeaderToken(exp) !== actToken) {
      mismatches.push({ index: i, expected: exp, actual: String(act), kind: 'wrong_column' });
    }
  }
  return { tab: tabName, known: true, ok: mismatches.length === 0, expected, actual, mismatches };
}

// Validate a map of { tabName: headerRow } against the contracts. Returns the
// per-tab results plus the list of contract tabs whose headers drifted.
function buildHeaderContractStatus(tabHeaders) {
  const headers = tabHeaders || {};
  const tabs = {};
  const mismatchTabs = [];
  for (const tabName of Object.keys(headers)) {
    const result = validateTabHeader(tabName, headers[tabName]);
    tabs[tabName] = result;
    if (result.known && !result.ok) mismatchTabs.push(tabName);
  }
  return { tabs, mismatchTabs, ok: mismatchTabs.length === 0 };
}

module.exports = {
  requiredSheetTabs,
  optionalSheetTabs,
  getMissingRequiredTabs,
  buildSheetContractStatus,
  canonicalHeaderToken,
  validateTabHeader,
  buildHeaderContractStatus
};
