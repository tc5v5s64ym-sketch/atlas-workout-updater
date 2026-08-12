'use strict';

// SCOPING THE FROZEN EXACT-DUPLICATE APPROVALS OUT OF A SYNTHETIC WORKBOOK.
//
// The frozen legacy identity map (`config/migration/legacy-session-identity-map.json`)
// carries three `EXCLUDE_SURPLUS_IDENTICAL` approvals over real PRODUCTION Effort
// content, and an approval whose multiplicity does not match the tab FAILS CLOSED —
// zero occurrences included (required review of `7240777`, P1; proven in
// `test/migrationExactDuplicateDisposition.test.js`).
//
// Every fixture in this lane is synthetic, because §8.4 forbids a real workout value
// in this repository. A synthetic workbook therefore holds none of that approved
// content, and all three approvals correctly report a mismatch — which would fail
// every backfill and sweep proof here for a reason that has nothing to do with what
// they prove.
//
// THE PRODUCTION RULE IS NEVER RELAXED TO MAKE A FIXTURE PASS. It is scoped instead:
// this module replaces the resolver's map with the same frozen map minus the
// approvals, at the ONE shared seam the backfill, the sweep and the reconciliation
// already read. Nothing in production gains a map-injection hook — those three still
// load the frozen file and only it — and the loader still validates whatever it is
// given, so a malformed map would still throw here.
//
// Require this module for its side effect, before the proofs run:
//
//     require('./support/syntheticIdentityMap');
//
// TEMPORARY: deleted at S4 with the map, the resolver and the backfill machinery.

const fs = require('fs');

const legacyMap = require('../../services/migrationLegacyIdentityMap');

const frozen = JSON.parse(fs.readFileSync(legacyMap.MAP_PATH, 'utf8'));
const scoped = { ...frozen, duplicate_dispositions: [] };

const real = legacyMap.resolveSheetRows;
legacyMap.resolveSheetRows = (concept, sheetRows, options = {}) =>
  real(concept, sheetRows, { ...options, map: options.map || scoped });

module.exports = { scoped };
