#!/usr/bin/env node
/**
 * Atlas Exercise_Catalog maintenance — CONTROLLED APPEND.
 *
 * Appends rows to the `Exercise_Catalog` tab ONLY, using the repo's existing
 * Google Sheets client (sheets.js `appendRows`). Built to the owner's safety
 * contract:
 *   - Targets ONLY Exercise_Catalog. It refuses to touch any other tab, and
 *     hard-blocks the protected data tabs (Log_Cleaned, Effort, Bug_Reports, …).
 *   - DRY-RUN by default. It previews the plan and writes nothing unless you
 *     pass --confirm.
 *   - Duplicate check before writing: an input row is SKIPPED when its
 *     canonical name (or any of its variants) already matches an existing
 *     Canonical_Name / Original_Variants entry in the catalog.
 *   - After a real write it READS BACK the catalog and confirms each new
 *     Canonical_Name is present; exits non-zero if any is missing.
 *   - Never prints secrets. It only checks env presence via sheets.validateConfig().
 *
 * Usage:
 *   node scripts/catalog-maintenance.js --file rows.json            # dry-run preview
 *   node scripts/catalog-maintenance.js --file rows.json --confirm  # actually append
 *
 * rows.json is an array of objects:
 *   [{ "canonical_name": "Bicep Curl", "muscle_group": "Biceps",
 *      "lift_code": "BC01", "original_variants": "Bicep Curl, Bicep Curls" }]
 * `lift_code` and `original_variants` are optional (variants default to the
 * canonical name). canonical_name + muscle_group are required.
 *
 * Requires the same env as the server: GOOGLE_SHEETS_ID,
 * GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY.
 */

const fs = require('fs');
try { require('dotenv').config(); } catch { /* dotenv optional — host injects env */ }

// This tool is allowed to write to exactly one tab. Anything else is a bug.
const CATALOG_TAB = 'Exercise_Catalog';
// Never let this script anywhere near the trust-path / logged-data tabs.
const PROTECTED_TABS = ['Log_Cleaned', 'Effort', 'Bug_Reports', 'Constraints', 'Deload_State', 'Session_Summary', 'Logic', 'Metadata'];

// Header spellings the enrichment layer (services/exerciseEnrichment.js) accepts,
// in resolution priority, so this tool maps columns the same way the reader does.
const HEADER_ALIASES = {
  canonical: ['canonical_name', 'canonical name', 'canonicalname', 'canonical_exercise', 'canonical exercise', 'canonicalexercise', 'exercise', 'exercise_name', 'exercise name'],
  muscle: ['muscle_group', 'muscle group', 'musclegroup'],
  code: ['lift_code', 'lift code', 'liftcode'],
  variants: ['original_variants', 'original variants', 'originalvariant', 'original variant']
};

function normalizeKey(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[''""]/g, '')
    .replace(/\s+/g, ' ');
}

function splitVariants(value) {
  return String(value || '').split(/[,;|]/).map(v => v.trim()).filter(Boolean);
}

// Resolve a column index from a header row using the alias table.
function resolveColumnIndex(header, aliasList) {
  const normHeader = header.map(normalizeKey);
  for (const alias of aliasList) {
    const idx = normHeader.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function resolveColumns(header) {
  return {
    canonical: resolveColumnIndex(header, HEADER_ALIASES.canonical),
    muscle: resolveColumnIndex(header, HEADER_ALIASES.muscle),
    code: resolveColumnIndex(header, HEADER_ALIASES.code),
    variants: resolveColumnIndex(header, HEADER_ALIASES.variants)
  };
}

// Build the set of identities (normalized canonical names + variants) already in the catalog.
function buildExistingIdentitySet(dataRows, cols) {
  const set = new Set();
  for (const row of dataRows) {
    if (cols.canonical >= 0 && row[cols.canonical]) set.add(normalizeKey(row[cols.canonical]));
    if (cols.variants >= 0 && row[cols.variants]) {
      splitVariants(row[cols.variants]).forEach(v => set.add(normalizeKey(v)));
    }
  }
  return set;
}

// Position an input row's values into a cell array aligned to the catalog's columns.
function rowToCells(input, cols) {
  const width = Math.max(cols.canonical, cols.muscle, cols.code, cols.variants) + 1;
  const cells = new Array(width).fill('');
  if (cols.canonical >= 0) cells[cols.canonical] = input.canonical_name;
  if (cols.muscle >= 0) cells[cols.muscle] = input.muscle_group;
  if (cols.code >= 0) cells[cols.code] = input.lift_code || '';
  if (cols.variants >= 0) cells[cols.variants] = input.original_variants || input.canonical_name;
  return cells;
}

// Pure planner: decide which input rows to write vs skip (duplicate), and the
// exact cell arrays to append. No I/O — unit-tested without network/creds.
//   header:   the catalog header row (array of strings)
//   dataRows: existing catalog data rows (header excluded)
//   inputs:   [{canonical_name, muscle_group, lift_code?, original_variants?}]
function planCatalogAppend(header, dataRows, inputs) {
  const cols = resolveColumns(header);
  if (cols.canonical < 0) {
    throw new Error('Exercise_Catalog header has no recognizable Canonical_Name / Exercise column.');
  }
  const existing = buildExistingIdentitySet(dataRows, cols);

  const toWrite = [];
  const skipped = [];
  const invalid = [];
  const seenThisRun = new Set();

  for (const input of inputs) {
    const canonical = String(input.canonical_name || '').trim();
    const muscle = String(input.muscle_group || '').trim();
    if (!canonical || !muscle) {
      invalid.push({ input, reason: 'missing required canonical_name or muscle_group' });
      continue;
    }
    const identities = [canonical, ...splitVariants(input.original_variants)].map(normalizeKey).filter(Boolean);
    const dupHit = identities.find(id => existing.has(id));
    if (dupHit) {
      skipped.push({ canonical_name: canonical, reason: `already in catalog (matches "${dupHit}")` });
      continue;
    }
    // Guard against the same identity appearing twice within one input batch.
    const selfHit = identities.find(id => seenThisRun.has(id));
    if (selfHit) {
      skipped.push({ canonical_name: canonical, reason: `duplicate within this batch (matches "${selfHit}")` });
      continue;
    }
    identities.forEach(id => seenThisRun.add(id));
    toWrite.push({ input, cells: rowToCells(input, cols) });
  }

  return { cols, toWrite, skipped, invalid };
}

function parseArgs(argv) {
  const args = { confirm: false, file: null, tab: CATALOG_TAB };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirm') args.confirm = true;
    else if (a === '--file') { args.file = argv[i + 1]; i += 1; }
    else if (a === '--tab') { args.tab = argv[i + 1]; i += 1; }
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
    else if (a.startsWith('--tab=')) args.tab = a.slice('--tab='.length);
  }
  return args;
}

function loadInputRows(file) {
  if (!file) throw new Error('No --file provided. Pass a JSON array of catalog rows.');
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Input file must be a JSON array of row objects.');
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Hard tab guard — this tool only ever touches Exercise_Catalog.
  if (args.tab !== CATALOG_TAB) {
    console.error(`Refusing to operate on "${args.tab}". This tool only touches ${CATALOG_TAB}.`);
    if (PROTECTED_TABS.includes(args.tab)) console.error(`"${args.tab}" is a protected data tab and must never be written by this script.`);
    process.exit(2);
  }

  const inputs = loadInputRows(args.file);
  if (!inputs.length) {
    console.error('Input file contained no rows. Nothing to do.');
    process.exit(1);
  }

  // sheets.js reads creds from env at require time; validateConfig throws a clear
  // message (no secret values) if any are missing.
  const { validateConfig, getHeaderRow, getExerciseCatalog, appendRows } = require('../sheets');
  validateConfig();

  const header = await getHeaderRow(CATALOG_TAB);
  const allRows = await getExerciseCatalog();          // includes header at index 0
  const dataRows = allRows.length > 1 ? allRows.slice(1) : [];

  const { cols, toWrite, skipped, invalid } = planCatalogAppend(header, dataRows, inputs);

  console.log(`\n=== Exercise_Catalog maintenance — ${args.confirm ? 'WRITE' : 'DRY-RUN'} ===`);
  console.log(`Header: ${header.join(' | ')}`);
  console.log(`Existing data rows: ${dataRows.length}`);
  console.log(`\nWould append ${toWrite.length} row(s):`);
  for (const w of toWrite) console.log(`  + ${w.cells.join(' | ')}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} duplicate row(s):`);
    for (const s of skipped) console.log(`  - ${s.canonical_name} — ${s.reason}`);
  }
  if (invalid.length) {
    console.log(`\nRejected ${invalid.length} invalid row(s):`);
    for (const v of invalid) console.log(`  ! ${JSON.stringify(v.input)} — ${v.reason}`);
  }

  if (!args.confirm) {
    console.log('\nDRY-RUN — no write performed. Re-run with --confirm to append the rows above.');
    return;
  }
  if (!toWrite.length) {
    console.log('\nNothing new to write (all rows were duplicates or invalid). No append performed.');
    return;
  }

  console.log(`\nAppending ${toWrite.length} row(s) to ${CATALOG_TAB} …`);
  await appendRows(CATALOG_TAB, toWrite.map(w => w.cells));

  // Read-back: confirm every newly written canonical name is now present.
  const after = await getExerciseCatalog();
  const afterData = after.length > 1 ? after.slice(1) : [];
  const afterSet = buildExistingIdentitySet(afterData, cols);
  console.log('\nRead-back verification:');
  let allConfirmed = true;
  for (const w of toWrite) {
    const ok = afterSet.has(normalizeKey(w.input.canonical_name));
    console.log(`  ${ok ? '✓ confirmed' : '✗ MISSING'}: ${w.input.canonical_name}`);
    if (!ok) allConfirmed = false;
  }
  if (!allConfirmed) {
    console.error('\nOne or more rows were not found on read-back. Investigate before retrying.');
    process.exit(1);
  }
  console.log('\nDone — all appended rows confirmed present.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Catalog maintenance failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  normalizeKey,
  splitVariants,
  resolveColumns,
  buildExistingIdentitySet,
  rowToCells,
  planCatalogAppend,
  parseArgs,
  CATALOG_TAB,
  PROTECTED_TABS
};
