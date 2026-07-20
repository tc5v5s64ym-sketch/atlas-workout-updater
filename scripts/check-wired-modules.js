#!/usr/bin/env node
'use strict';

// Wired-or-deleted guard (Remediation PR-13; semantic-reachability upgrade — Phase 2 Work item 1a).
//
// Builds the PRODUCTION module graph from the real entrypoints and reports any
// `services/*.js` that is unreachable from production. A module that no
// production path can reach is dead weight: it ships, is maintained, and is
// tested, yet nothing runs it. This guard makes that state fail CI so a module
// is either WIRED (reachable) or DELETED (git preserves history) — with a single
// escape hatch, `config/wiring-allowlist.json`, for modules that are genuinely
// staged for imminent wiring. Every allowlist entry REQUIRES an expiry date and a
// roadmap link; an expired entry fails CI so the staging can never be permanent.
//
// FILE reachability is computed over three edge kinds:
//   1. Static `require('./literal')` / `import … from './literal'` / `import('./literal')`.
//   2. The declarative capability manifest — `config/coaching/manifests/capabilities.json`
//      lists each capability's `module.file`; the orchestrator resolves those at
//      runtime, so they are treated as roots (and per PR-13 must never be deleted).
//   3. Any additional dynamic-load roots declared in DYNAMIC_ROOTS below (kept
//      explicit so a reader can audit every non-static edge).
//
// SEMANTIC reachability (the Phase 2 upgrade) strengthens the question from "is
// this file required somewhere?" to "is its output actually CONSUMED?". A module
// can be file-reachable yet dead: `const x = require('./x')` where `x` is never
// referenced again imports a module whose output changes nothing. Semantic
// reachability follows an import edge only when its local binding is REFERENCED
// beyond the import statement — the tractable, deterministic proxy for "its
// output can flow into a decision". A service that is file-reachable but reached
// ONLY through such unreferenced (inert) edges is reported as INERT and fails the
// guard exactly like an unreachable module (unless allowlisted).
//
// The rule fails SAFE — it can only make a module look MORE orphaned, never keep
// a dead one falsely wired:
//   • side-effect imports (`require('./x')` with no binding), re-exports
//     (`module.exports = require('./x')`), and dynamic `import('./x')` carry no
//     attributable binding, so they are always treated as USED;
//   • a binding passed by value (`let f = classifyIntent`) or invoked indirectly
//     counts as referenced — so value-passed callbacks are never false-flagged;
//   • when binding parsing is uncertain, the edge is treated as USED.
// It therefore does NOT prove the output reaches a user-visible surface — that
// end-to-end judgement is the human job of the ownership/connectivity inventory
// (Phase 2 Work item 1b). This guard proves the necessary precondition: something
// references the module's output.
//
// Pure core (`analyze()`), so test/wiredModules.test.js asserts on it directly;
// the CLI wrapper prints a report and sets the exit code.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

// ── roots: the real production entrypoints ──────────────────────────────────
// Backend process entry + its two always-loaded siblings, every maintenance/CI
// script, every config module, and the frontend entry. scripts/ and config/ are
// production surfaces (they run in CI, at boot, or are imported by index.js).
function listFiles(dir, { recursive } = { recursive: false }) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (recursive) out.push(...listFiles(full, { recursive }));
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Capability-manifest module files are wired via the declarative orchestrator,
// not a static require — resolve them as roots. Never deletable (PR-13).
function manifestModuleRoots() {
  const manifestPath = path.join(ROOT, 'config', 'coaching', 'manifests', 'capabilities.json');
  if (!fs.existsSync(manifestPath)) return [];
  const caps = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const roots = [];
  for (const cap of Object.values(caps.capabilities || {})) {
    if (cap.status === 'missing') continue; // build-ahead slot; its file may not exist yet
    const file = cap.module && cap.module.file;
    if (typeof file === 'string' && fs.existsSync(path.join(ROOT, file))) roots.push(path.join(ROOT, file));
  }
  return roots;
}

// Explicit non-static production edges the static scan cannot see. Keep this
// list tiny and auditable; each entry is a real runtime load by a computed path.
const DYNAMIC_ROOTS = [
  // (none today — the capability manifest is the only dynamic-load surface, and
  // it is handled by manifestModuleRoots(). New computed-path requires go here.)
];

function productionRoots() {
  const roots = [
    path.join(ROOT, 'index.js'),
    path.join(ROOT, 'sheets.js'),
    path.join(ROOT, 'middleware.js'),
    path.join(ROOT, 'src', 'app', 'atlasEntry.js'), // frontend entry
    ...listFiles(path.join(ROOT, 'scripts')),
    ...listFiles(path.join(ROOT, 'config'), { recursive: true }),
    ...manifestModuleRoots(),
    ...DYNAMIC_ROOTS.map((r) => path.join(ROOT, r)),
  ];
  return roots.filter((f) => fs.existsSync(f));
}

// ── static import extraction (literal specifiers only) ──────────────────────
// Comments are stripped FIRST (respecting string/template literals) so a
// commented-out or documented `require('./x')` never counts as a real edge —
// otherwise the guard would keep a dead module silently "wired" (a false
// negative that defeats its purpose). String CONTENTS are preserved because the
// specifier itself lives in a string; a stray `from '…'` inside a non-import
// string resolves to a bare/external specifier and is harmlessly ignored.
const IMPORT_RES = [
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,      // require('x')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,    // import('x')
  /\bfrom\s*['"]([^'"]+)['"]/g,                 // import … from 'x' / export … from 'x'
];

// Remove // and /* */ comments while preserving '…', "…", and `…` literal
// contents (so `//` inside a URL string or a require path is never mistaken for
// a comment). A small hand scanner — enough for require-graph extraction.
// Known limitation: regex literals (`/.../`) are not tracked, so a regex with a
// stray quote could flip the scanner into a string state and drop the rest of a
// file's edges. This FAILS SAFE — it can only make a module look MORE orphaned
// (CI goes red), never keep a dead module falsely wired — so it is self-correcting.
function stripComments(src) {
  let out = '';
  let state = 'code'; // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; i++) {
    const c = src[i], c2 = src[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && c2 === '/') { state = 'line'; i++; }
        else if (c === '/' && c2 === '*') { state = 'block'; i++; }
        else if (c === "'") { state = 'sq'; out += c; }
        else if (c === '"') { state = 'dq'; out += c; }
        else if (c === '`') { state = 'tpl'; out += c; }
        else out += c;
        break;
      case 'line':
        if (c === '\n') { state = 'code'; out += c; }
        break;
      case 'block':
        if (c === '*' && c2 === '/') { state = 'code'; i++; }
        break;
      case 'sq': case 'dq': case 'tpl':
        out += c;
        if (c === '\\') { if (c2 !== undefined) { out += c2; i++; } }
        else if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
        break;
    }
  }
  return out;
}

function extractSpecifiers(src) {
  const code = stripComments(src);
  const specs = new Set();
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

// ── semantic edge classification (Phase 2 Work item 1a) ─────────────────────
// Parse each import into { spec, bindings, used, sideEffect }. `used` answers the
// semantic question: is the imported binding REFERENCED anywhere beyond its own
// import statement? Bindings we cannot attribute (side-effect requires, dynamic
// imports, `module.exports = require(...)` re-exports) carry `sideEffect:true` and
// are always `used:true` — the guard must fail safe (never demote a live edge).
const BINDING_RES = [
  // const/let/var X = require('spec')  |  const {a, b: c} = require('spec')
  { re: /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z0-9_$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g, bind: 1, spec: 2 },
  // import X from 'spec' | import {a, b as c} from 'spec' | import * as X from 'spec'
  { re: /import\s+(\*\s+as\s+[A-Za-z0-9_$]+|\{[^}]*\}|[A-Za-z0-9_$]+)\s+from\s*['"]([^'"]+)['"]/g, bind: 1, spec: 2 },
];

// Local names a binding clause introduces. `{ a, b as c, d: e }` → [a, c, e]
// (the name used in code is the one AFTER `as`/`:`); `* as ns` → [ns]; `x` → [x].
function localBindings(bindRaw) {
  const raw = bindRaw.trim();
  if (raw.startsWith('{')) {
    return raw.slice(1, -1).split(',').map((part) => {
      const seg = part.trim();
      if (!seg) return null;
      const m = seg.match(/(?:\bas\b|:)\s*([A-Za-z0-9_$]+)\s*$/); // rename → local name after as/:
      if (m) return m[1];
      const first = seg.split(/[\s:]/)[0];
      return first || null;
    }).filter(Boolean);
  }
  if (raw.startsWith('*')) return [raw.replace(/\*\s+as\s+/, '').trim()].filter(Boolean);
  return [raw].filter(Boolean);
}

// Blank the CONTENTS of string/template literals (delimiters kept, newlines
// preserved) so a binding name that only appears inside an unrelated string —
// `logger.debug('helper')` — is not miscounted as a real reference. Template
// interpolations `${…}` ARE kept, because `${helper}` is a genuine use. A small
// hand scanner mirroring stripComments; comments are assumed already removed.
function blankStringLiterals(code) {
  let out = '';
  let state = 'code'; // code | sq | dq | tpl | tplExpr
  let exprDepth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i], c2 = code[i + 1];
    const blank = c === '\n' ? '\n' : ' ';
    switch (state) {
      case 'code':
        if (c === "'") { state = 'sq'; out += c; }
        else if (c === '"') { state = 'dq'; out += c; }
        else if (c === '`') { state = 'tpl'; out += c; }
        else out += c;
        break;
      case 'sq': case 'dq':
        if (c === '\\') { out += blank; if (c2 !== undefined) { out += (c2 === '\n' ? '\n' : ' '); i++; } break; }
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) { state = 'code'; out += c; }
        else out += blank;
        break;
      case 'tpl':
        if (c === '\\') { out += blank; if (c2 !== undefined) { out += (c2 === '\n' ? '\n' : ' '); i++; } break; }
        if (c === '`') { state = 'code'; out += c; }
        else if (c === '$' && c2 === '{') { state = 'tplExpr'; exprDepth = 1; out += '${'; i++; }
        else out += blank;
        break;
      case 'tplExpr': // interpolation body is real code — keep it, track brace depth
        out += c;
        if (c === '{') exprDepth++;
        else if (c === '}') { exprDepth--; if (exprDepth === 0) state = 'tpl'; }
        break;
    }
  }
  return out;
}

// Is `name` referenced at least `min` times in `code`? Uses identifier
// boundaries that respect `$`/`_` (JS `\b` mistreats `$`). Callers pass the code
// with the binding's OWN import statement already removed and string literals
// blanked, so `min` is 1 (any surviving occurrence is a genuine downstream
// reference) — this also stops a module named after its binding
// (`require('./dead')` for `dead`) from self-referencing through its specifier.
function isReferenced(name, code, min = 2) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`, 'g');
  return (code.match(re) || []).length >= min;
}

function classifyEdges(src) {
  const code = stripComments(src);
  const edges = [];
  const bindingRanges = [];
  // Pass 1 — binding edges. Usage is checked against the code with THIS import
  // statement removed AND string literals blanked, so neither the declaration,
  // its specifier string, nor an unrelated string mention self-counts; any
  // surviving occurrence (threshold 1) is a real downstream reference.
  for (const p of BINDING_RES) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(code)) !== null) {
      const spec = m[p.spec];
      const bindings = localBindings(m[p.bind]);
      const residual = code.slice(0, m.index) + code.slice(m.index + m[0].length);
      const usageText = blankStringLiterals(residual);
      // No parseable binding → cannot attribute usage → fail safe as used.
      const used = bindings.length === 0 ? true : bindings.some((b) => isReferenced(b, usageText, 1));
      edges.push({ spec, bindings, used, sideEffect: false });
      bindingRanges.push([m.index, m.index + m[0].length]);
    }
  }
  // Pass 2 — side-effect / non-binding edges (bare `require('x')`, dynamic
  // `import('x')`, re-export `… from 'x'`, `module.exports = require('x')`). Detect
  // them from the code with every BINDING STATEMENT blanked, so a bare load of a
  // spec that is ALSO bound-but-unused still surfaces as a real side-effect edge
  // rather than being suppressed by the binding. No attributable binding → used.
  const chars = code.split('');
  for (const [s, e] of bindingRanges) {
    for (let i = s; i < e; i++) if (chars[i] !== '\n') chars[i] = ' ';
  }
  for (const spec of extractSpecifiers(chars.join(''))) {
    edges.push({ spec, bindings: [], used: true, sideEffect: true });
  }
  return edges;
}

// Resolve a relative specifier to a .js file on disk (append .js, or /index.js).
function resolveSpecifier(spec, fromFile) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // bare / node_modules — external
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

// ── graph walk ──────────────────────────────────────────────────────────────
// FILE reachability: follow every static import edge (unchanged baseline).
function reachableFiles(roots) {
  const visited = new Set();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const spec of extractSpecifiers(src)) {
      const resolved = resolveSpecifier(spec, file);
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }
  return visited;
}

// SEMANTIC reachability: follow an import edge only when its binding is actually
// referenced by the consuming module (see classifyEdges). A module reached only
// through inert (imported-but-unreferenced) edges never enters this set.
function reachableSemantic(roots) {
  const visited = new Set();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const edge of classifyEdges(src)) {
      if (!edge.used) continue;
      const resolved = resolveSpecifier(edge.spec, file);
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }
  return visited;
}

// ── allowlist ────────────────────────────────────────────────────────────────
function loadAllowlist() {
  const p = path.join(ROOT, 'config', 'wiring-allowlist.json');
  if (!fs.existsSync(p)) return { modules: [] };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`config/wiring-allowlist.json is not valid JSON: ${e.message}`); }
}

// ── analysis ─────────────────────────────────────────────────────────────────
// `today` is injectable so the guard's expiry logic is testable without the clock.
//
// The allowlist has TWO categories:
//   • `modules`  — staged for imminent wiring; each REQUIRES a YYYY-MM-DD `expires`
//     + a `roadmap` link, and an expired entry fails CI (staging can't be forever).
//     Capped small (the brief targets ≤ 8) so it never becomes a dumping ground.
//   • `testOnly` — modules that are production-unreachable BY DESIGN because they are
//     test/CI tooling (e.g. the exercise-truth audit that powers a blocking test).
//     They need a `reason`, never expire, and are not "staged" — they are correct.
function analyze({ today = new Date() } = {}) {
  const roots = productionRoots();
  const fileReachable = reachableFiles(roots);
  const semReachable = reachableSemantic(roots);
  const fileReachableRel = new Set([...fileReachable].map(rel));
  const semReachableRel = new Set([...semReachable].map(rel));

  const services = listFiles(path.join(ROOT, 'services')).map(rel).sort();
  // Orphans use SEMANTIC reachability now: a service whose output nothing
  // references is an orphan even if some file `require`s it. `inert` is the
  // subset that IS file-reachable but only through unreferenced bindings — the
  // "wired on paper, dead in practice" case the semantic upgrade newly catches.
  const orphans = services.filter((f) => !semReachableRel.has(f));
  const inert = orphans.filter((f) => fileReachableRel.has(f));

  const allow = loadAllowlist();
  const allowErrors = [];

  // staged modules
  const stagedByFile = new Map();
  for (const entry of allow.modules || []) {
    if (!entry || typeof entry.file !== 'string') { allowErrors.push('staged allowlist entry missing "file"'); continue; }
    if (typeof entry.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      allowErrors.push(`${entry.file}: "expires" must be a YYYY-MM-DD date`);
    }
    if (typeof entry.roadmap !== 'string' || !entry.roadmap.trim()) {
      allowErrors.push(`${entry.file}: "roadmap" link/reason is required`);
    }
    stagedByFile.set(entry.file, entry);
  }

  // test-only tooling
  const testOnlyByFile = new Map();
  for (const entry of allow.testOnly || []) {
    if (!entry || typeof entry.file !== 'string') { allowErrors.push('testOnly allowlist entry missing "file"'); continue; }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      allowErrors.push(`${entry.file}: testOnly entries require a "reason"`);
    }
    testOnlyByFile.set(entry.file, entry);
  }

  const todayStr = today.toISOString().slice(0, 10);
  const expired = [];
  const staleAllow = []; // allowlisted but no longer an orphan, or file gone → remove it
  for (const [file, entry] of stagedByFile) {
    if (!fs.existsSync(path.join(ROOT, file))) { staleAllow.push(`${file} (file does not exist)`); continue; }
    if (!orphans.includes(file)) { staleAllow.push(`${file} (now wired — drop the staged allowlist entry)`); continue; }
    if (entry.expires && entry.expires < todayStr) expired.push(`${file} (expired ${entry.expires})`);
  }
  for (const file of testOnlyByFile.keys()) {
    if (!fs.existsSync(path.join(ROOT, file))) { staleAllow.push(`${file} (testOnly — file does not exist)`); continue; }
    if (!orphans.includes(file)) staleAllow.push(`${file} (testOnly — now reachable from production; drop the entry)`);
  }

  const unwired = orphans.filter((f) => !stagedByFile.has(f) && !testOnlyByFile.has(f));

  // `inert` orphans that are neither allowlisted nor testOnly are already counted
  // in `unwired`, so `ok` covers them. We surface them separately for a precise,
  // actionable message (remove the dead import or wire the output).
  const inertUnwired = inert.filter((f) => !stagedByFile.has(f) && !testOnlyByFile.has(f));

  const ok = unwired.length === 0 && expired.length === 0 && staleAllow.length === 0 && allowErrors.length === 0;
  return {
    ok,
    rootCount: roots.length,
    reachableCount: semReachable.size,
    fileReachableCount: fileReachable.size,
    serviceCount: services.length,
    orphans,
    inert,
    inertUnwired,
    allowlisted: [...stagedByFile.keys()].filter((f) => orphans.includes(f)),
    testOnly: [...testOnlyByFile.keys()].filter((f) => orphans.includes(f)),
    unwired,
    expired,
    staleAllow,
    allowErrors,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function formatReport(r) {
  const lines = [];
  lines.push(`Wired-or-deleted guard — ${r.serviceCount} services; ${r.reachableCount} files semantically reachable `
    + `(${r.fileReachableCount} file-reachable) from ${r.rootCount} production roots.`);
  lines.push('');
  if (r.allowErrors.length) {
    lines.push('MALFORMED allowlist entries (each needs file + YYYY-MM-DD expires + roadmap):');
    r.allowErrors.forEach((e) => lines.push(`  ✗ ${e}`));
    lines.push('');
  }
  if (r.inertUnwired && r.inertUnwired.length) {
    lines.push(`INERT services/*.js — file-reachable but every import edge is unreferenced, so their output is dead (${r.inertUnwired.length}):`);
    r.inertUnwired.forEach((f) => lines.push(`  ✗ ${f}  — reference the binding (wire the output), delete the dead import, or allowlist it`));
    lines.push('');
  }
  if (r.unwired.length) {
    lines.push(`UNWIRED services/*.js unreachable from production and NOT allowlisted (${r.unwired.length}):`);
    r.unwired.forEach((f) => lines.push(`  ✗ ${f}  — wire it, delete it, or allowlist it (with expiry + roadmap)`));
    lines.push('');
  }
  if (r.expired.length) {
    lines.push(`EXPIRED allowlist entries — wire or delete now (${r.expired.length}):`);
    r.expired.forEach((f) => lines.push(`  ✗ ${f}`));
    lines.push('');
  }
  if (r.staleAllow.length) {
    lines.push(`STALE allowlist entries — remove them (${r.staleAllow.length}):`);
    r.staleAllow.forEach((f) => lines.push(`  ✗ ${f}`));
    lines.push('');
  }
  if (r.allowlisted.length) {
    lines.push(`Allowlisted (staged, not yet wired — ${r.allowlisted.length}):`);
    r.allowlisted.forEach((f) => lines.push(`  • ${f}`));
    lines.push('');
  }
  if (r.testOnly && r.testOnly.length) {
    lines.push(`Test-only tooling (production-unreachable by design — ${r.testOnly.length}):`);
    r.testOnly.forEach((f) => lines.push(`  • ${f}`));
    lines.push('');
  }
  lines.push(r.ok ? '✅ All services are wired or explicitly (and validly) allowlisted.'
                  : '❌ Wiring guard failed — see above.');
  return lines.join('\n');
}

if (require.main === module) {
  const r = analyze();
  process.stdout.write(formatReport(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}

module.exports = {
  analyze, formatReport, productionRoots,
  reachableFiles, reachableSemantic,
  extractSpecifiers, classifyEdges, localBindings, isReferenced,
  stripComments, blankStringLiterals,
};
