#!/usr/bin/env node
'use strict';

// `npm run check:supabase-safety` — the repository half of §6.1 P10 and §8.5.
//
// P10 has two halves. The DASHBOARD half — Supabase's production auto-deploy and
// automatic-migration toggles shown OFF at the exact head — is OWNER EVIDENCE and
// cannot be produced from inside this repository; the merge card records it as
// such. This guard proves the REPOSITORY half, which is the half a commit can
// actually break:
//
//   1. NO GITHUB-TRIGGERED PATH HOLDS A PRODUCTION CREDENTIAL. No workflow
//      references a Supabase production secret, access token, or project ref.
//   2. NO WORKFLOW APPLIES A MIGRATION TO A HOSTED PROJECT. `supabase link`,
//      `supabase db push`, and `supabase migration up --linked` are refused.
//   3. THE APPLIER CANNOT REACH A HOSTED PROJECT. scripts/apply-supabase-
//      migrations.js keeps its hosted-host refusal, and the refusal has no flag
//      that lifts it.
//   4. THE P2 DATABASE IS INDEPENDENT OF THE SUPABASE GITHUB INTEGRATION —
//      the proof job uses a plain Postgres service container, so the integration
//      can be disabled entirely and P2 still runs. That is what keeps a required
//      proof off a paid plan (ruling D3).
//
// A setting nobody has looked at is a setting nobody controls; a guard that only
// reads a document is not a guard.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const APPLIER = path.join(ROOT, 'scripts', 'apply-supabase-migrations.js');
const CI = path.join(WORKFLOW_DIR, 'ci.yml');

// Commands that push schema to a LINKED (hosted) project. `supabase db reset`
// and `supabase migration new` are local and are not on this list.
const HOSTED_APPLY_COMMANDS = [
  /supabase\s+link\b/,
  /supabase\s+db\s+push\b/,
  /supabase\s+migration\s+up\b[^\n]*--linked/,
  /supabase\s+db\s+remote\b/,
];

// Secret names that would mean a GitHub-triggered path can authenticate to the
// hosted project. The preview path (if the owner ever enables it) gets
// preview-branch credentials from the integration, never these.
const PRODUCTION_SECRET_NAMES = [
  /secrets\.\s*SUPABASE_ACCESS_TOKEN/i,
  /secrets\.\s*SUPABASE_DB_PASSWORD/i,
  /secrets\.\s*SUPABASE_PROJECT_(?:ID|REF)/i,
  /secrets\.\s*SUPABASE_SERVICE_ROLE/i,
  /secrets\.\s*ATLAS_SUPABASE_(?:APP|READONLY|MIGRATE|REBUILD)_URL/i,
];

function workflowFiles() {
  if (!fs.existsSync(WORKFLOW_DIR)) return [];
  return fs
    .readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => path.join(WORKFLOW_DIR, name));
}

function analyze() {
  const failures = [];

  for (const file of workflowFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    for (const pattern of PRODUCTION_SECRET_NAMES) {
      if (pattern.test(text)) {
        failures.push(
          `${rel}: references a Supabase production credential (${pattern}). ` +
            'No GitHub-triggered path may hold one — production schema application is an owner gate (§8.5).'
        );
      }
    }
    for (const pattern of HOSTED_APPLY_COMMANDS) {
      if (pattern.test(text)) {
        failures.push(
          `${rel}: runs a command that applies schema to a LINKED Supabase project (${pattern}). ` +
            'No branch merge, push, workflow run, or GitHub event may apply a migration to Atlas Production (§8.5).'
        );
      }
    }
  }

  // The applier's structural refusal.
  if (!fs.existsSync(APPLIER)) {
    failures.push('scripts/apply-supabase-migrations.js is missing — the from-empty P2 database has no builder.');
  } else {
    const applier = fs.readFileSync(APPLIER, 'utf8');
    if (!/HOSTED_SUPABASE_HOST/.test(applier) || !/HOSTED_TARGET_REFUSED/.test(applier)) {
      failures.push(
        'scripts/apply-supabase-migrations.js no longer refuses a hosted Supabase host. ' +
          'That refusal is what makes CI structurally unable to reach Atlas Production.'
      );
    }
    if (!/TARGET_NOT_EMPTY/.test(applier)) {
      failures.push(
        'scripts/apply-supabase-migrations.js no longer refuses a non-empty target. ' +
          'P2 requires a database created FROM EMPTY; a carried-over database hides the defect P1 exists to catch.'
      );
    }
    if (/--force|--allow-hosted|ALLOW_HOSTED/.test(applier)) {
      failures.push(
        'scripts/apply-supabase-migrations.js appears to expose an override for the hosted-host refusal. ' +
          'There is deliberately no flag that lifts it.'
      );
    }
  }

  // The P2 job must exist and must use a plain Postgres service container, so the
  // proof runs with the Supabase integration disabled entirely.
  if (!fs.existsSync(CI)) {
    failures.push('.github/workflows/ci.yml is missing.');
  } else {
    const ci = fs.readFileSync(CI, 'utf8');
    if (!/test:pg/.test(ci)) {
      failures.push(
        '.github/workflows/ci.yml does not run `npm run test:pg`. §6.1 P2 requires the ' +
          'from-empty Postgres proof on every run; a proof that is not wired to CI is not a gate.'
      );
    }
    if (!/image:\s*postgres/.test(ci)) {
      failures.push(
        '.github/workflows/ci.yml does not declare a plain Postgres service container. ' +
          'A Supabase preview branch may NOT be the P2 database (ruling D3: Free tier, and a ' +
          'PR-scoped branch is not a per-run from-empty database).'
      );
    }
    if (/supabase\/setup-cli|supabase\/postgres/.test(ci)) {
      failures.push(
        '.github/workflows/ci.yml pulls in the Supabase CLI or image. P2 needs no Supabase plan at all; ' +
          'keeping it plain Postgres is what makes the proof independent of the integration.'
      );
    }
  }

  return failures;
}

function run() {
  const failures = analyze();
  if (failures.length) {
    console.error('Supabase migration safety guard FAILED:');
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log('Supabase migration safety guard OK — no GitHub-triggered path can apply schema to Atlas Production.');
}

module.exports = { analyze, HOSTED_APPLY_COMMANDS, PRODUCTION_SECRET_NAMES };

if (require.main === module) run();
