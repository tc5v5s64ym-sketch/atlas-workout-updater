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

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }
  const asJson = args.includes('--json');

  const base = (process.env.ATLAS_BASE_URL || '').trim();
  let status;
  const warnings = [];

  if (base) {
    const r = await fetchDeployed(base, 6000);
    if (r.ok && r.body && typeof r.body === 'object' && r.body.schema_version) {
      status = r.body;
      const local = localHeadShort();
      const deployed = status.deployed_commit;
      if (local && deployed && deployed !== 'unknown' && !local.startsWith(deployed) && !deployed.startsWith(local)) {
        warnings.push(`local HEAD ${local} differs from deployed ${deployed}`);
      }
    } else {
      status = buildLocalCliStatus({ deployed_reason: `deployed status unreachable (${r.reason})` });
      warnings.push(`deployed status unreachable (${r.reason}); showing local view`);
    }
  } else {
    status = buildLocalCliStatus({ deployed_reason: 'ATLAS_BASE_URL not set; local view only' });
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
