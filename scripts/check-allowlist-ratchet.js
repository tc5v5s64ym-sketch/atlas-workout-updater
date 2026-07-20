'use strict';

// Drift Guard 3 — WIRING GUARD HARDENED (Phase 2; fully hard-enforced after Phase 5).
//
// Spec: docs/ATLAS_V1_EXECUTION_PLAN.md "Drift guards" #3 — "the allowlist becomes
// shrink-only; new entries require an owner-gate note; expiries fail red — never
// auto-extend." Published in CLAUDE.md.
//
// The existing wiring guard (scripts/check-wired-modules.js) already enforces the
// per-entry contract: every staged module needs a YYYY-MM-DD `expires` + a non-empty
// `roadmap`, an EXPIRED entry fails CI (never auto-extends), and a now-wired entry
// must be dropped. This guard adds the SHRINK-ONLY RATCHET on top: the staged
// `modules` list may never exceed `staged_modules_ceiling`. The ceiling ratchets DOWN
// as contracts wire out in Phases 3-5 (lower it in the same PR that removes an entry);
// RAISING it to stage a new module is a deliberate, reviewable edit that requires an
// owner-gate note recorded in the execution plan — so the escape hatch can only ever
// get smaller, never quietly grow.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ALLOWLIST = path.join(ROOT, 'config', 'wiring-allowlist.json');

/**
 * Pure analysis. `allowlist` is the parsed wiring-allowlist object (injected for
 * tests); defaults to the real file. Never throws — a load/parse failure is an error.
 */
function analyze(allowlist) {
  let data = allowlist;
  if (data === undefined) {
    try { data = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')); }
    catch (e) { return { valid: false, errors: [`cannot read config/wiring-allowlist.json: ${e.message}`] }; }
  }
  const errors = [];

  const modules = Array.isArray(data && data.modules) ? data.modules : null;
  if (!modules) return { valid: false, errors: ['wiring-allowlist.json: "modules" must be an array'] };

  const ceiling = data.staged_modules_ceiling;
  if (!Number.isInteger(ceiling) || ceiling < 0) {
    errors.push('staged_modules_ceiling: must be a non-negative integer (the shrink-only ratchet)');
  } else if (modules.length > ceiling) {
    errors.push(`shrink-only ratchet: modules has ${modules.length} entries but staged_modules_ceiling is ${ceiling} — the allowlist may not grow. Wire or drop an entry, or (to stage a new module) raise the ceiling with an owner-gate note recorded in the execution plan.`);
  }

  // The ceiling must carry the owner-gate note documenting the ratchet + raise rule.
  if (typeof data._ceiling_note !== 'string' || !data._ceiling_note.trim()) {
    errors.push('_ceiling_note: a non-empty note documenting the shrink-only ratchet + owner-gate raise rule is required');
  }

  return { valid: errors.length === 0, errors, count: modules.length, ceiling };
}

if (require.main === module) {
  const r = analyze();
  if (!r.valid) {
    console.error('❌ Wiring-guard ratchet FAILED:\n- ' + r.errors.join('\n- '));
    process.exit(1);
  }
  console.log(`✅ Wiring-guard ratchet OK — ${r.count}/${r.ceiling} staged modules (shrink-only; ceiling ratchets down as contracts wire).`);
}

module.exports = { analyze };
