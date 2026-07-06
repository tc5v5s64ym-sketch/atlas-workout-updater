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

// ── Markdown report formatter ──────────────────────────────────────────────────

function formatMarkdown(audit) {
  const lines = [];

  lines.push('# Exercise Truth Audit');
  lines.push('');
  lines.push('> **Status:** Report-only (PR-05, Atlas Remediation Plan v2). No data or parser behavior was changed.');
  lines.push('> This file is generated by `test/exerciseTruthAudit.test.js` and committed as evidence for PR-06.');
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
  lines.push(`| 1 | ${audit.stats.type1} | Aliases resolving to different canonical names across sources |`);
  lines.push(`| 2 | ${audit.stats.type2} | Canonical exercises present in some sources but absent from others |`);
  lines.push(`| 3 | ${audit.stats.type3} | Case / punctuation / hyphenation-only mismatches between canonical names |`);
  lines.push('');

  // ── Type 1 ──
  lines.push('## Type 1 — Alias Conflicts');
  lines.push('');
  lines.push('*An alias string that resolves to different canonical names in different sources.*');
  lines.push('*PR-06 must resolve every Type-1 conflict to a single winner before the audit test becomes blocking.*');
  lines.push('');
  if (audit.type1.length === 0) {
    lines.push('No Type 1 conflicts found.');
    lines.push('');
  } else {
    for (const { alias, bySource } of audit.type1) {
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

module.exports = { runAudit, formatMarkdown };
