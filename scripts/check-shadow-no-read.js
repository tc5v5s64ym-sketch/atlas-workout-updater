'use strict';

// Drift Guard — SHADOW NO-READ-PATH GUARD (Fable P3 B-21, issue #1742).
//
// Coach_Response and Intent_Shadow are OBSERVATION-ONLY tabs. Production runs
// them in shadow form (ATLAS_INTENT_ROUTER=shadow, ATLAS_INTERACTION_TRACE=shadow,
// ATLAS_COACH_SHADOW_PERSIST=1 — coordinator-confirmed from the Render service
// config, issue #1742 comment 6860065167), so they DO store model output verbatim.
// That store is by design (same posture as Coach_Shadow, which the owner reviews);
// the boundary obligation is that no write path or answer path ever READS either
// tab as a source of facts. If this guard passes, B-21 closes as accepted-designed.
//
// What this guard pins (runtime code only — services/, routes/, src/, index.js):
//   R1 shadow-tab-read — no Sheets read call (getSheetRows, getRecentRows,
//      getHeaderRow/getHeader, readValues, readRange, getColumnValues, getRows,
//      readRows) may take a Coach_Response / Intent_Shadow reference (literal,
//      A1 range, or the RESPONSE_TAB / SHADOW_TAB constant) as its target.
//      The ONE exception is the header-validation read inside the two write
//      modules (getHeader(RESPONSE_TAB) / getHeader(SHADOW_TAB)): it reads the
//      header LABELS to fail closed on a column mismatch, never row facts.
//   R2 shadow-tab-constant-leak — the RESPONSE_TAB / SHADOW_TAB constants may
//      not be used outside their defining write modules, so a future read cannot
//      reach a shadow tab through the constant instead of the literal.
//   R3 intent-ring-consumer — the intent-shadow in-memory ring (getShadowLog)
//      has exactly ONE runtime consumer: GET /api/debug/intent-shadow, the
//      auth-gated debug endpoint that serves the ring (never the Sheet tab).
//      No other file may require services/intentShadow, and no other
//      getShadowLog use may appear in routes/coachOps.js.
//
// Deliberate scope limits (documented, not hidden):
//   • scripts/ is NOT scanned: the offline owner/agent review tooling there
//     (scripts/flight-review.js, scripts/atlas-review-live.js) reads
//     Intent_Shadow rows to produce the human review surface — that IS the
//     designed use ("owner reviews the tab"). Scripts never serve an athlete
//     response and never write a workout tab.
//   • Comments are stripped before matching (same approach as
//     scripts/check-banned-patterns.js), so a comment or doc sentence that
//     merely names a tab is never flagged; prose string literals (e.g. the
//     gateAScorecard note) are fine too — only a READ call is a violation.
//   • A read reached through an intermediate variable (const t = RESPONSE_TAB;
//     getSheetRows(t)) is not caught by the literal scan; R2 makes that
//     indirection a violation the moment the constant is used outside its
//     home module, and the runtime poison test in test/api-smoke.test.js
//     (B-21 block) catches any read that actually executes.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'services', 'routes'];
const SCAN_ROOT_FILES = ['index.js'];

// The two shadow tabs. Coach_Shadow is NOT in scope here: it stores presence
// flags only, never model text, and its own module is the write home.
const SHADOW_TABS = ['Coach_Response', 'Intent_Shadow'];

// Sheets read entry points (sheets.js exports + the local getHeader alias the
// write modules use). Appends and ensure() are writes/setup, never reads.
const READ_CALLS = [
  'getSheetRows',
  'getRecentRows',
  'getHeaderRow',
  'getHeader',
  'readValues',
  'readRange',
  'getColumnValues',
  'getRows',
  'readRows',
];

// Header validation is the one sanctioned read, and only inside the write
// modules that own the tab (it reads labels, never row facts).
const HEADER_READ_HOME = new Set([
  'services/coachResponseSheet.js',
  'services/coachShadowSheet.js',
]);

// Where each shadow-tab constant may be used. The constant NAME is shared:
// three write modules each define their own module-local SHADOW_TAB for a
// different tab (Brain_Shadow, Coach_Shadow, Intent_Shadow), and
// coachResponseSheet.js alone defines RESPONSE_TAB. A file that DEFINES its
// own constant is a write home; a file that USES one without defining it must
// have imported it — that is the leak this rule catches.
const SHADOW_CONSTANTS = ['RESPONSE_TAB', 'SHADOW_TAB'];
const CONSTANT_DEF = (constant) => new RegExp(`\\b(?:const|let|var)\\s+${constant}\\s*=`);

const INTENT_SHADOW_MODULE = /require\(\s*['"](?:\.\.\/services\/intentShadow|\.\/intentShadow)['"]\s*\)/;
const DEBUG_ENDPOINT = '/api/debug/intent-shadow';
const DEBUG_WINDOW_LINES = 2; // the ring read sits on the line right under the route line

// Blank out comment content while preserving line count/positions, so the guard
// matches only real code — never a comment that legitimately documents a tab
// (same approach as scripts/check-banned-patterns.js; string literals are
// preserved — only // and /* */ comments are stripped).
function stripComments(content) {
  const lines = String(content).split('\n');
  let inBlock = false;
  return lines.map((line) => {
    let out = '';
    for (let i = 0; i < line.length; i += 1) {
      if (inBlock) {
        if (line[i] === '*' && line[i + 1] === '/') { inBlock = false; i += 1; }
        continue;
      }
      if (line[i] === '/' && line[i + 1] === '*') { inBlock = true; i += 1; continue; }
      if (line[i] === '/' && line[i + 1] === '/') break; // rest of the line is a comment
      out += line[i];
    }
    return out;
  });
}

function _walk(absDir, out) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) _walk(abs, out);
    else if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(abs);
  }
}

function _defaultFiles() {
  const out = [];
  for (const d of SCAN_DIRS) _walk(path.join(ROOT, d), out);
  for (const f of SCAN_ROOT_FILES) out.push(path.join(ROOT, f));
  return out.map((abs) => ({ path: path.relative(ROOT, abs), content: fs.readFileSync(abs, 'utf8') }));
}

// Does `text` reference a shadow tab (literal, A1 range, or constant)?
function _referencesShadowTab(text) {
  for (const tab of SHADOW_TABS) {
    if (text.includes(`'${tab}'`) || text.includes(`"${tab}"`) || text.includes(`${tab}!`)) return tab;
  }
  if (/\bRESPONSE_TAB\b/.test(text)) return 'RESPONSE_TAB';
  if (/\bSHADOW_TAB\b/.test(text)) return 'SHADOW_TAB';
  return null;
}

/**
 * Pure analysis. `files` is an optional [{ path, content }] list (injected for tests);
 * defaults to the real runtime files under SCAN_DIRS + index.js. Never throws.
 */
function analyze(files) {
  const list = Array.isArray(files) ? files : _defaultFiles();
  const violations = [];
  for (const { path: rel, content } of list) {
    const lines = stripComments(content);
    const joined = lines.join('\n');

    // R1 — a Sheets read call targeting a shadow tab.
    for (const call of READ_CALLS) {
      const callRe = new RegExp(`\\b${call}\\s*\\(`, 'g');
      let m;
      while ((m = callRe.exec(joined)) !== null) {
        const window = joined.slice(m.index, m.index + 200);
        const tab = _referencesShadowTab(window);
        // Same-line reverse order: the tab literal precedes the call on its line.
        const lineStart = joined.lastIndexOf('\n', m.index) + 1;
        const lineEnd = joined.indexOf('\n', m.index);
        const lineText = joined.slice(lineStart, lineEnd === -1 ? joined.length : lineEnd);
        const tabOnLine = _referencesShadowTab(lineText);
        const ref = tab || tabOnLine;
        if (!ref) continue;
        // Sanctioned: header validation inside the write modules.
        if ((call === 'getHeader' || call === 'getHeaderRow') && HEADER_READ_HOME.has(rel)) continue;
        const lineNo = joined.slice(0, m.index).split('\n').length;
        violations.push({
          file: rel, line: lineNo, rule: 'shadow-tab-read',
          detail: `${call}() targets ${ref} — no write/answer path may read Coach_Response or Intent_Shadow as a source of facts (B-21)`,
        });
      }
    }

    // R2 — a shadow-tab constant used in a file that does not define its own.
    // (A module-local definition is a write home; a bare use elsewhere means
    // the constant was imported — the leak that would let a read reach a
    // shadow tab without naming it.)
    for (const constant of SHADOW_CONSTANTS) {
      if (CONSTANT_DEF(constant).test(joined)) continue; // defines its own — a write home
      const constRe = new RegExp(`\\b${constant}\\b`, 'g');
      let m;
      while ((m = constRe.exec(joined)) !== null) {
        const lineNo = joined.slice(0, m.index).split('\n').length;
        violations.push({
          file: rel, line: lineNo, rule: 'shadow-tab-constant-leak',
          detail: `${constant} used without a local definition — a shadow-tab constant must not leak out of its write module (B-21)`,
        });
      }
    }

    // R3 — the intent-shadow ring has exactly one runtime consumer, the debug endpoint.
    const requiresIntentShadow = INTENT_SHADOW_MODULE.test(joined);
    if (requiresIntentShadow && rel !== 'routes/coachOps.js') {
      const lineNo = joined.split('\n').findIndex((l) => INTENT_SHADOW_MODULE.test(l)) + 1;
      violations.push({
        file: rel, line: lineNo, rule: 'intent-ring-consumer',
        detail: `requires services/intentShadow outside routes/coachOps.js — the ring is served only by GET ${DEBUG_ENDPOINT} (B-21)`,
      });
    }
    if (rel === 'routes/coachOps.js') {
      lines.forEach((line, i) => {
        if (!/\bgetShadowLog\s*\(/.test(line)) return;
        const windowStart = Math.max(0, i - DEBUG_WINDOW_LINES);
        const nearDebugRoute = lines.slice(windowStart, i + 1).some((l) => l.includes(DEBUG_ENDPOINT));
        if (!nearDebugRoute) {
          violations.push({
            file: rel, line: i + 1, rule: 'intent-ring-consumer',
            detail: `getShadowLog() outside GET ${DEBUG_ENDPOINT} — the intent ring must not feed any other route (B-21)`,
          });
        }
      });
    }
  }
  return { valid: violations.length === 0, violations };
}

if (require.main === module) {
  const r = analyze();
  if (!r.valid) {
    console.error('❌ Shadow no-read-path guard FAILED — a write/answer path reads a shadow tab:');
    for (const v of r.violations) console.error(`  - ${v.file}:${v.line}  [${v.rule}]  ${v.detail}`);
    process.exit(1);
  }
  console.log('✅ Shadow no-read-path guard passed — no runtime path reads Coach_Response or Intent_Shadow (B-21).');
}

module.exports = { analyze, stripComments, SHADOW_TABS, READ_CALLS };
