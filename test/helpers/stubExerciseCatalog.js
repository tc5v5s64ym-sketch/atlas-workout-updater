'use strict';

// Stub services/exerciseCatalog.js so a test never opens a Supabase connection.
//
// WHY THIS EXISTS. OWNER CORRECTION 2026-08-13 moved the exercise catalog off
// Google Sheets, so `sheets.getExerciseCatalog` no longer exists and stubbing the
// sheets module no longer controls the catalog. Without this helper the real
// reader runs, and because index.js loads dotenv, a developer machine with a
// populated `.env` would have the SUITE CONNECT TO THE REAL SUPABASE PROJECT over
// the network — slow, non-hermetic, and a test reaching production data.
//
// It follows the repository's existing pattern: require.cache injection performed
// BEFORE `../index` is loaded, exactly as the sheets stub is.
//
// Call it before requiring the app under test:
//
//     require('./helpers/stubExerciseCatalog').installExerciseCatalogStub(rows);
//     const { app } = require('../index');

const path = require('node:path');

const MODULE_PATH = require.resolve(path.join(__dirname, '..', '..', 'services', 'exerciseCatalog.js'));

// ── A TEST MUST NEVER OPEN A SUPABASE CONNECTION ─────────────────────────────
//
// index.js calls `dotenv.config()`, so on a machine with a populated `.env` the
// runtime roles are configured inside the suite. Before this guard, a test that
// loaded the app and reached a catalog read CONNECTED TO THE REAL PROJECT — which
// is slow, non-hermetic, and a test touching the owner's production data. It was
// observed: the failure `relation "atlas.exercise_catalog" does not exist` came
// back from a live database that had not been migrated.
//
// Blanking the role variables makes `adapter.isConfigured()` false and
// `poolFor()` throw SUPABASE_NOT_CONFIGURED immediately, so any unstubbed path
// fails FAST and LOUDLY instead of silently reaching the network.
const ROLE_VARS = ['ATLAS_SUPABASE_APP_URL', 'ATLAS_SUPABASE_READONLY_URL',
  'ATLAS_SUPABASE_MIGRATE_URL', 'ATLAS_SUPABASE_REBUILD_URL'];

function neutralizeSupabaseEnv() {
  for (const name of ROLE_VARS) delete process.env[name];
  process.env.ATLAS_SUPABASE_SHADOW_WRITE = '0';
}

/**
 * By default it DELEGATES to the suite's existing sheets stub.
 *
 * Every affected suite already declares its catalog fixture as
 * `getExerciseCatalog` inside its fake sheets module. Reading that fixture at call
 * time — rather than requiring each suite to restate it — means the cutover
 * changes one line per file and no test's data changes. A suite whose stub has no
 * catalog gets an empty one, which is what an empty `Exercise_Catalog` returned.
 *
 * @param {string[][]|(() => string[][]|Promise<string[][]>)} [rows]
 *        Explicit rows, or a getter. Omit to delegate to the sheets stub.
 */
function installExerciseCatalogStub(rows) {
  neutralizeSupabaseEnv();
  const real = require(MODULE_PATH);

  async function readRows() {
    if (typeof rows === 'function') return rows();
    if (Array.isArray(rows)) return rows;
    // Delegate. Required lazily so the suite's own require.cache injection wins.
    const sheets = require(path.join(__dirname, '..', '..', 'sheets.js'));
    if (typeof sheets.getExerciseCatalog === 'function') return sheets.getExerciseCatalog();
    return [];
  }

  require.cache[MODULE_PATH] = {
    id: MODULE_PATH,
    filename: MODULE_PATH,
    loaded: true,
    exports: {
      // The one read the runtime performs. It copies, because the real reader
      // builds a fresh array per call and a shared array would let a mutation in
      // one test reach the next.
      readExerciseCatalogRows: async () => (await readRows()).map((row) => row.slice()),
      // Pure and side-effect free, so the REAL implementation is kept: stubbing it
      // would let a projection defect pass unnoticed.
      catalogRowFromInput: real.catalogRowFromInput,
    },
  };
}

module.exports = { installExerciseCatalogStub, MODULE_PATH };
