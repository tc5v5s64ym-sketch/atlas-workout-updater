'use strict';

// `npm run atlas:status` (and `npm run atlas:status -- --json`) — the agent-first
// Atlas Control Tower command. Answers "where are we / is prod healthy / did the
// latest write+undo hold" from repo root, with NO Sheet ID, tab name, session id,
// or doc path supplied. Full contract: docs/ATLAS_OPERATIONS_CONTRACT.md.
//
// Behaviour:
//   * If ATLAS_BASE_URL is set, it fetches the deployed, authoritative
//     GET /.well-known/atlas-status.json (public, no browser key) and presents it,
//     warning if the local HEAD differs from the deployed commit.
//   * Offline / no base URL / unreachable → it falls back to a local view assembled
//     from the checked-out plan + test ledger + env-presence flags. The deployed
//     commit is unknown offline, so health honestly degrades to "unknown".
//
// Read-only. Never writes a sheet, never calls an LLM, never prints a secret — the
// JSON it emits is the same bounded/redacted schema the endpoint serves.

const { execSync } = require('child_process');
const { buildLocalCliStatus, renderHuman } = require('../services/atlasStatus');

function printHelp() {
  process.stdout.write([
    'Atlas Control Tower — operational status',
    '',
    'Usage:',
    '  npm run atlas:status            Human-readable summary',
    '  npm run atlas:status -- --json  Machine-readable status document (the contract schema)',
    '',
    'Sources: deployed GET /.well-known/atlas-status.json (when ATLAS_BASE_URL is set),',
    'else a local view from docs/ATLAS_V1_EXECUTION_PLAN.md, docs/TEST_QUEUE.md, and env flags.',
    'No Sheet ID, tab name, or session id is required. See docs/ATLAS_OPERATIONS_CONTRACT.md.',
    ''
  ].join('\n'));
}

function localHeadShort() {
  try {
    return execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim();
  } catch (_) {
    return null;
  }
}

async function fetchDeployed(baseUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/.well-known/atlas-status.json`;
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, body };
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? 'timeout' : (e && e.message ? e.message : 'fetch failed');
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// Read-only Supabase migration facts for the status document (§3.8: the open
// divergence count and the oldest open row; §3.7: the catalog generation's age).
//
// TOTAL — it never throws, and it never reports a count it did not read. Prefers
// the atlas_readonly credential and falls back to the runtime role only when that
// is the only one configured, mirroring the existing rule that read-only tools
// build their own read-only client.
async function readSupabaseMigrationFacts() {
  const configured =
    (process.env.ATLAS_SUPABASE_READONLY_URL || '').trim().length > 0 ||
    (process.env.ATLAS_SUPABASE_APP_URL || '').trim().length > 0;
  const shadowWriteEnabled = process.env.ATLAS_SUPABASE_SHADOW_WRITE === '1';
  if (!configured) {
    return { observed: false, reason: 'not_configured', configured: false, shadow_write_enabled: shadowWriteEnabled };
  }

  let adapter;
  try {
    adapter = require('../services/supabaseAdapter');
  } catch (err) {
    return { observed: false, reason: `adapter_unavailable: ${err.message}`, configured: true, shadow_write_enabled: shadowWriteEnabled };
  }

  const role = (process.env.ATLAS_SUPABASE_READONLY_URL || '').trim() ? 'readonly' : 'app';
  try {
    const summary = await adapter.divergenceSummary(role);
    const catalogRows = await adapter.readExerciseCatalog(role);
    return {
      observed: true,
      reason: 'read_ok',
      configured: true,
      shadow_write_enabled: shadowWriteEnabled,
      open_divergences: Number(summary.open_count || 0),
      oldest_open_divergence_at: summary.oldest_open_at
        ? new Date(summary.oldest_open_at).toISOString()
        : null,
      // OWNER CORRECTION 2026-08-13: Supabase owns the catalog, so there is no
      // generation age and no servability verdict to report — a catalog cannot be
      // stale relative to itself. Its SIZE is still worth surfacing, because an
      // empty catalog is a real operational problem.
      catalog_rows: catalogRows.length,
    };
  } catch (err) {
    return { observed: false, reason: `read_failed: ${err.message}`, configured: true, shadow_write_enabled: shadowWriteEnabled };
  } finally {
    try {
      await adapter.close();
    } catch { /* the process is exiting anyway */ }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }
  const asJson = args.includes('--json');

  const base = (process.env.ATLAS_BASE_URL || '').trim();
  let status;
  const warnings = [];

  // Supabase hot-path migration (PR S2) — §3.8 names this command as an immediate
  // consumer of atlas.migration_divergences. Read-only, as atlas_readonly where
  // that credential exists. Every failure degrades to observed:false with its
  // reason: an unread divergence table is UNKNOWN, never a clean zero.
  const supabaseMigration = await readSupabaseMigrationFacts();
  if (!supabaseMigration.observed && supabaseMigration.configured) {
    warnings.push(`Supabase migration facts unavailable (${supabaseMigration.reason})`);
  }

  if (base) {
    const r = await fetchDeployed(base, 6000);
    if (r.ok && r.body && typeof r.body === 'object' && r.body.schema_version) {
      status = r.body;
      const local = localHeadShort();
      const deployed = status.deployed_commit;
      if (local && deployed && deployed !== 'unknown' && !local.startsWith(deployed) && !deployed.startsWith(local)) {
        warnings.push(`local HEAD ${local} differs from deployed ${deployed}`);
      }
      // The endpoint deliberately reports the migration block as NOT OBSERVED (it
      // opens no database connection). Overlay the CLI's real read when it got one,
      // and leave the endpoint's honest not-observed value when it did not.
      if (supabaseMigration.observed) status.supabase_migration = supabaseMigration;
    } else {
      status = buildLocalCliStatus({
        deployed_reason: `deployed status unreachable (${r.reason})`,
        supabase_migration: supabaseMigration,
      });
      warnings.push(`deployed status unreachable (${r.reason}); showing local view`);
    }
  } else {
    status = buildLocalCliStatus({
      deployed_reason: 'ATLAS_BASE_URL not set; local view only',
      supabase_migration: supabaseMigration,
    });
    warnings.push('ATLAS_BASE_URL not set; showing local view (set it in .env to check deployed prod)');
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(status)}\n`);
    for (const w of warnings) process.stdout.write(`  Note:        ${w}\n`);
  }
}

main().catch(err => {
  process.stderr.write(`atlas:status failed: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
});
