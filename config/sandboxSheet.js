'use strict';

// The repository-declared sandbox workbook — ONE literal, one authority.
//
// This id decided two different things in two different files: `sheets.js` used it to
// answer `getSafeSpreadsheetConfig().isSandboxSheet` (the runtime safety signal every
// write-adjacent guard reads), and `scripts/sim/harness.js` kept its own copy to decide
// whether a simulation may run in write mode. Two literals deciding "is this the sandbox"
// is an authority defect: correcting one and not the other would leave a guard that
// believes a workbook is the sandbox while another believes it is not.
//
// Both now consume this module, so the id is declared exactly once. It is a public
// workbook identifier, not a secret — it is already committed in this repository's
// history and carries no credential. Nothing here reads the environment: the ambient
// `GOOGLE_SHEETS_ID` is deliberately NOT consulted, because the whole point of the
// constant is to be the fixed thing an ambient value is compared AGAINST.

const SANDBOX_SPREADSHEET_ID = '1UuprDIBoV2Y9jEraOkKaqdX1PHE6ESiF9ZLFJH3CeXE';

// Last-6 is the only form safe to print in a transcript, log line, or PR body. Callers
// that need to show which workbook they resolved use this, never the full id.
const SANDBOX_SPREADSHEET_ID_LAST6 = SANDBOX_SPREADSHEET_ID.slice(-6);

function isSandboxSpreadsheetId(id) {
  return typeof id === 'string' && id.trim() === SANDBOX_SPREADSHEET_ID;
}

module.exports = {
  SANDBOX_SPREADSHEET_ID,
  SANDBOX_SPREADSHEET_ID_LAST6,
  isSandboxSpreadsheetId,
};
