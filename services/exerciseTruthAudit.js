'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// Normalize for canonical comparison: lowercase, collapse non-alphanumeric runs to a space.
// "Dips (Weighted)" and "Dips Weighted" are the same after norm(); "Deadlift" and
// "Conventional Deadlift" are not.
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Collapse ALL non-alphanumeric characters (including hyphens and spaces) for
// case/punctuation-only mismatch detection.
// "Pull-Up", "Pull Up", "pull up" → "pullup" (same normKey, different raw forms → Type 3)
function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toTitle(s) {
  return String(s || '').split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ');
}

// ── Source A: parser alias tables ──────────────────────────────────────────────
function loadSourceA() {
  const { EXERCISE_ALIASES, CONTEXTUAL_ALIASES } = require('./workoutTextParser');

  const aliasToCanonical = new Map();
  const canonicals = new Set();

  for (const [canonical, aliases] of EXERCISE_ALIASES) {
    canonicals.add(canonical);
    for (const a of [canonical, ...aliases]) {
      if (!aliasToCanonical.has(norm(a))) aliasToCanonical.set(norm(a), canonical);
    }
  }

  for (const [canonical, aliases] of Object.entries(CONTEXTUAL_ALIASES)) {
    canonicals.add(canonical);
    for (const a of aliases) {
      if (!aliasToCanonical.has(norm(a))) aliasToCanonical.set(norm(a), canonical);
    }
  }

  return {
    label: 'Parser (workoutTextParser.js — EXERCISE_ALIASES + CONTEXTUAL_ALIASES)',
    aliasToCanonical,
    canonicals,
  };
}

// ── Source B: data JSON files ──────────────────────────────────────────────────
function loadSourceB() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/exercise_catalog.v1.json'), 'utf8'));
  const aliasRows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/exercise_aliases.v1.json'), 'utf8'));

  const idToName = new Map(catalog.map(e => [e.exercise_id, e.name]));
  const aliasToCanonical = new Map();
  const canonicals = new Set(catalog.map(e => e.name));
  const orphanedAliasIds = new Set();

  for (const e of catalog) aliasToCanonical.set(norm(e.name), e.name);

  for (const e of aliasRows) {
    const canonical = idToName.get(e.exercise_id);
    if (!canonical) { orphanedAliasIds.add(e.exercise_id); continue; }
    const key = norm(e.alias);
    if (!aliasToCanonical.has(key)) aliasToCanonical.set(key, canonical);
  }

  return {
    label: 'Data JSON (exercise_catalog.v1.json + exercise_aliases.v1.json)',
    aliasToCanonical,
    canonicals,
    orphanedAliasIds: [...orphanedAliasIds].sort(),
  };
}

// ── Source C: coaching exercise JSON files ─────────────────────────────────────
function loadSourceC() {
  const indexData = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config/coaching/exercises/_index.json'), 'utf8')
  );

  const aliasToCanonical = new Map();
  const canonicals = new Set();

  for (const entry of indexData.exercises) {
    canonicals.add(entry.name);
    aliasToCanonical.set(norm(entry.name), entry.name);

    const filePath = path.join(ROOT, 'config/coaching/exercises', entry.file);
    if (!fs.existsSync(filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const alias of (data.aliases || [])) {
      const key = norm(alias);
      if (!aliasToCanonical.has(key)) aliasToCanonical.set(key, entry.name);
    }
  }

  return {
    label: 'Coaching JSON (config/coaching/exercises/*.json + _index.json)',
    aliasToCanonical,
    canonicals,
  };
}

// ── Source D: exerciseEnrichment.js (PREFERRED_ALIAS_TARGETS + SHORTHAND_EXPANSIONS) ──
function loadSourceD() {
  const { PREFERRED_ALIAS_TARGETS, SHORTHAND_EXPANSIONS } = require('./exerciseEnrichment');

  const aliasToCanonical = new Map();
  const canonicals = new Set();

  for (const [key, targets] of Object.entries(PREFERRED_ALIAS_TARGETS)) {
    // First target is the preferred canonical lookup key; title-case for display.
    const canonical = toTitle(targets[0]);
    canonicals.add(canonical);
    if (!aliasToCanonical.has(norm(key))) aliasToCanonical.set(norm(key), canonical);
  }

  for (const [key, expanded] of Object.entries(SHORTHAND_EXPANSIONS)) {
    const canonical = toTitle(expanded);
    canonicals.add(canonical);
    if (!aliasToCanonical.has(norm(key))) aliasToCanonical.set(norm(key), canonical);
  }

  return {
    label: 'Enrichment (exerciseEnrichment.js — PREFERRED_ALIAS_TARGETS + SHORTHAND_EXPANSIONS)',
    aliasToCanonical,
    canonicals,
  };
}

// ── Audit engine ───────────────────────────────────────────────────────────────

function runAudit() {
  const sources = {
    A: loadSourceA(),
    B: loadSourceB(),
    C: loadSourceC(),
    D: loadSourceD(),
  };

  const sourceKeys = Object.keys(sources);

  // Type 1: same normalized alias → different normalized canonical across sources
  const allAliasKeys = new Set();
  for (const src of Object.values(sources)) {
    for (const k of src.aliasToCanonical.keys()) allAliasKeys.add(k);
  }

  const type1 = [];
  for (const alias of [...allAliasKeys].sort()) {
    const bySource = {};
    for (const [id, src] of Object.entries(sources)) {
      const canonical = src.aliasToCanonical.get(alias);
      if (canonical !== undefined) bySource[id] = canonical;
    }
    const uniqueCanonicals = new Set(Object.values(bySource).map(norm));
    if (uniqueCanonicals.size > 1) type1.push({ alias, bySource });
  }

  // Type 2: canonical present in some sources but missing in others
  // Group by normKey so "Pull-Up" and "Pull Up" count as the same canonical concept.
  const normKeyToEntry = new Map();
  for (const [id, src] of Object.entries(sources)) {
    for (const canonical of src.canonicals) {
      const key = normKey(canonical);
      if (!normKeyToEntry.has(key)) {
        normKeyToEntry.set(key, { representativeName: canonical, presentIn: new Set() });
      }
      normKeyToEntry.get(key).presentIn.add(id);
    }
  }

  const type2 = [];
  for (const [key, { representativeName, presentIn }] of [...normKeyToEntry.entries()].sort()) {
    const missingFrom = sourceKeys.filter(id => !presentIn.has(id));
    if (missingFrom.length > 0) {
      type2.push({
        canonical: representativeName,
        normKey: key,
        presentIn: [...presentIn].sort(),
        missingFrom: missingFrom.sort(),
      });
    }
  }

  // Type 3: canonical names that share a normKey but differ in raw form
  // (purely case/hyphen/space differences — e.g. "Pull-Up" vs "Pull-up" vs "Pull Up")
  const normKeyToForms = new Map();
  for (const src of Object.values(sources)) {
    for (const canonical of src.canonicals) {
      const key = normKey(canonical);
      if (!normKeyToForms.has(key)) normKeyToForms.set(key, new Set());
      normKeyToForms.get(key).add(canonical);
    }
  }

  const type3 = [];
  for (const [key, forms] of [...normKeyToForms.entries()].sort()) {
    if (forms.size > 1) type3.push({ normKey: key, forms: [...forms].sort() });
  }

  // Source-level statistics
  const sourceStats = Object.fromEntries(
    Object.entries(sources).map(([id, src]) => [
      id,
      {
        label: src.label,
        canonicalCount: src.canonicals.size,
        aliasCount: src.aliasToCanonical.size,
        orphanedAliasIds: src.orphanedAliasIds || [],
      },
    ])
  );

  return {
    sources: sourceStats,
    type1,
    type2,
    type3,
    stats: { type1: type1.length, type2: type2.length, type3: type3.length },
  };
}

// ── Blocking vs anchored classification (PR-06) ─────────────────────────────────
//
// PR-06 reconciled the two hand-maintained JSON sources — the catalog (B) and the
// coaching ontology (C) — to Dale's history convention. The parser (A) and the
// live write-path enrichment module (D) are NOT editable within PR-06 scope (owner
// decision, Option 1): the parser's canonical output is what gets written to
// Log_Cleaned, and enrichment's tables are lookup keys into the Exercise_Catalog
// sheet on the trust path. Their unification with the catalog is PR-14 (parser
// aliases generated from the catalog) and PR-15 (sheet/enrichment synced from JSON).
//
// So the audit test BLOCKS on any Type-1 conflict between the editable sources
// (B ↔ C), and grandfathers the parser/enrichment-anchored residuals via a
// documented allowlist. A conflict is:
//   • BLOCKING  — the editable sources B and C both map the alias and disagree.
//   • ANCHORED  — the divergence is due only to A and/or D; B and C agree (or are
//                 absent). These are the allowlisted residuals.
const EDITABLE_SOURCES = ['B', 'C'];

function partitionType1(type1) {
  const blocking = [];
  const anchored = [];
  for (const entry of type1) {
    const editable = EDITABLE_SOURCES
      .filter(id => entry.bySource[id] !== undefined)
      .map(id => norm(entry.bySource[id]));
    const editableDisagree = new Set(editable).size > 1;
    if (editableDisagree) blocking.push(entry);
    else anchored.push(entry);
  }
  return { blocking, anchored };
}

// ── Markdown report formatter ──────────────────────────────────────────────────

function formatMarkdown(audit) {
  const lines = [];
  const { blocking, anchored } = partitionType1(audit.type1);

  lines.push('# Exercise Truth Audit');
  lines.push('');
  lines.push('> **Status:** Reconciled + blocking (PR-06, Atlas Remediation Plan v2).');
  lines.push('> The two hand-maintained JSON sources — catalog (B) and coaching ontology (C) —');
  lines.push('> were reconciled to Dale\'s history convention. `test/exerciseTruthAudit.test.js`');
  lines.push('> now **fails** on any catalog↔coaching (B↔C) Type-1 conflict. Parser (A) /');
  lines.push('> enrichment (D) anchored residuals are grandfathered in');
  lines.push('> `docs/verification/EXERCISE_TRUTH_ALLOWLIST.json` (resolved by PR-14 / PR-15).');
  lines.push('> This file is generated by the test; do not hand-edit.');
  lines.push('');

  lines.push('## Reconciliation policy (PR-06)');
  lines.push('');
  lines.push('Winner selection for each Type-1 conflict, applied by editing **JSON only** (no');
  lines.push('parser or write-path change):');
  lines.push('');
  lines.push('1. **Parser (A) name when A participates** — the parser is the canonical Atlas');
  lines.push('   surfaces/logs today, so it is the strongest history signal (frozen; PR-14 will');
  lines.push('   regenerate parser aliases from the catalog).');
  lines.push('2. **Enrichment (D) name when D participates and A does not** — D encodes Dale\'s');
  lines.push('   shorthand→lift_code history (frozen; PR-15 syncs it from the catalog).');
  lines.push('3. **Otherwise the coarse, unqualified movement name** — Dale logs the movement,');
  lines.push('   not the apparatus, so equipment/position qualifiers (Barbell/Dumbbell/Cable/');
  lines.push('   Machine/Standing/Bodyweight/One-Arm/Lying) are dropped from the shared canonical.');
  lines.push('');
  lines.push('Edits: catalog (B) granular entries renamed to the coarse winner; coaching (C)');
  lines.push('coarse entries had variant-specific aliases removed where the catalog keeps a');
  lines.push('distinct exercise. The owner-reserved Bicep-Curl↔Dumbbell-Curl distinction was NOT');
  lines.push('folded (`services/exerciseEnrichment.js`); the mis-alias `bicep curl → Dumbbell');
  lines.push('Curl` was removed from the catalog instead.');
  lines.push('');
  lines.push('**Ambiguous picks recorded** (two defensible canonicals; chose the common-usage /');
  lines.push('history form):');
  lines.push('');
  lines.push('| Alias family | Winner | Loser | Rationale |');
  lines.push('|---|---|---|---|');
  lines.push('| tricep pushdown | Tricep Pushdown | Triceps Pushdown | matches parser spelling "Tricep" (history) |');
  lines.push('| cable fly / crossover | Cable Fly | Cable Chest Fly | shorter form; matches the Cable Fly identity fix (#490 family) |');
  lines.push('| cable chop | Cable Woodchopper | Cable Woodchop | full common name |');
  lines.push('| rear delt | Rear Delt Fly | Dumbbell Rear Delt Raise | common gym term; apparatus dropped |');
  lines.push('| cable row | Cable Row | Seated Cable Row | coarse; parser still says "Seated Row" (anchored) |');
  lines.push('| dip (movement) | Dip | Parallel-Bar Dip | coarse; the weighted-dips concept stays "Dips" |');
  lines.push('');

  lines.push('## Sources');
  lines.push('');
  for (const [id, s] of Object.entries(audit.sources)) {
    lines.push(`**${id} — ${s.label}**`);
    lines.push(`- Canonical count: ${s.canonicalCount}`);
    lines.push(`- Alias-to-canonical entries: ${s.aliasCount}`);
    if (s.orphanedAliasIds && s.orphanedAliasIds.length > 0) {
      lines.push(`- ⚠ Alias rows referencing unknown exercise_ids (${s.orphanedAliasIds.length}): ${s.orphanedAliasIds.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| Type | Count | Description |');
  lines.push('|------|------:|-------------|');
  lines.push(`| 1 (blocking, B↔C) | ${blocking.length} | Editable catalog↔coaching aliases resolving to different canonicals — **must be 0** |`);
  lines.push(`| 1 (anchored, A/D) | ${anchored.length} | Parser/enrichment residuals, allowlisted for PR-14 / PR-15 |`);
  lines.push(`| 2 | ${audit.stats.type2} | Canonical exercises present in some sources but absent from others |`);
  lines.push(`| 3 | ${audit.stats.type3} | Case / punctuation / hyphenation-only mismatches between canonical names |`);
  lines.push('');

  // ── Type 1: blocking (B↔C) ──
  lines.push('## Type 1 (blocking) — Catalog ↔ Coaching Conflicts');
  lines.push('');
  lines.push('*Aliases where the two editable JSON sources (catalog B, coaching C) disagree.*');
  lines.push('*The audit test FAILS on any entry here. PR-06 reconciled all of these to zero.*');
  lines.push('');
  if (blocking.length === 0) {
    lines.push('✅ No blocking (B↔C) conflicts — the catalog and coaching ontology agree on every shared alias.');
    lines.push('');
  } else {
    for (const { alias, bySource } of blocking) {
      lines.push(`### \`${alias}\``);
      for (const [src, canonical] of Object.entries(bySource)) {
        lines.push(`- **${src}:** \`${canonical}\``);
      }
      lines.push('');
    }
  }

  // ── Type 1: anchored (A/D) ──
  lines.push('## Type 1 (anchored) — Parser / Enrichment Residuals');
  lines.push('');
  lines.push('*The editable sources (B, C) agree; the divergence is a frozen source — the parser*');
  lines.push('*(A, its output is what Log_Cleaned records) or the write-path enrichment module (D).*');
  lines.push('*These are grandfathered in `EXERCISE_TRUTH_ALLOWLIST.json` and resolved by PR-14 / PR-15.*');
  lines.push('');
  if (anchored.length === 0) {
    lines.push('No anchored residuals.');
    lines.push('');
  } else {
    for (const { alias, bySource } of anchored) {
      lines.push(`### \`${alias}\``);
      for (const [src, canonical] of Object.entries(bySource)) {
        lines.push(`- **${src}:** \`${canonical}\``);
      }
      lines.push('');
    }
  }

  // ── Type 2 ──
  lines.push('## Type 2 — Missing Canonicals');
  lines.push('');
  lines.push('*Exercises present in some sources but absent from others.*');
  lines.push('*Grouped by "missing from" pattern for readability.*');
  lines.push('');
  if (audit.type2.length === 0) {
    lines.push('No Type 2 gaps found — all canonicals are present in every source.');
    lines.push('');
  } else {
    // Group by missingFrom signature for readability
    const groups = new Map();
    for (const entry of audit.type2) {
      const sig = entry.missingFrom.join(',');
      if (!groups.has(sig)) groups.set(sig, { missingFrom: entry.missingFrom, entries: [] });
      groups.get(sig).entries.push(entry);
    }

    for (const { missingFrom, entries } of groups.values()) {
      lines.push(`### Missing from: ${missingFrom.map(s => `**${s}**`).join(', ')}`);
      lines.push('');
      lines.push('| Exercise | Present In |');
      lines.push('|----------|-----------|');
      for (const e of entries) {
        lines.push(`| ${e.canonical} | ${e.presentIn.join(', ')} |`);
      }
      lines.push('');
    }
  }

  // ── Type 3 ──
  lines.push('## Type 3 — Case / Punctuation Mismatches');
  lines.push('');
  lines.push('*Canonical names that are identical except for capitalization, hyphens, or spaces.*');
  lines.push('');
  if (audit.type3.length === 0) {
    lines.push('No Type 3 mismatches found.');
    lines.push('');
  } else {
    for (const { normKey: key, forms } of audit.type3) {
      lines.push(`- **\`${key}\`:** ${forms.map(f => `\`${f}\``).join(' vs ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { runAudit, formatMarkdown, partitionType1, EDITABLE_SOURCES };
