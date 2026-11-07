'use strict';
/*
 * Persona artifact finalization (#1664).
 *
 * The privacy sweep and the SHA-256 hashes must certify the artifact bytes
 * AS PUBLISHED, after the last write. The old order swept first and wrote
 * after: the scorecard files, the rewritten evidence file, and afterAll's
 * raw server log + pageerrors were never swept or hashed, and the recorded
 * hashes went stale the moment those writes landed — so conditions 23/24
 * could not certify the final published bytes.
 *
 * The finalization order this module supports (see persona.spec.js §13):
 *   1. write every content artifact (fully redacted log, pageerrors);
 *   2. provisional sweep + score (conditions 23/24 judge this record);
 *   3. write the scorecard files + the evidence (provisional record);
 *   4. final sweep over every file except the evidence file itself, then
 *      rewrite the evidence with the final record;
 *   5. post-write verification: rescan + rehash every published byte.
 * After step 5 nothing writes to the artifact dir. A leak or a changed hash
 * fails the run instead of publishing a clean record over unswept bytes.
 *
 * One exclusion is structural and is recorded, not hidden: the evidence file
 * cannot hash itself, so it is excluded from its own file list
 * (`self_excluded`). Its final bytes ARE leak-scanned by the verification
 * step. Everything else listed carries a hash over its final bytes.
 *
 * (TEMPORARY persona-lane machinery; sunset: persona campaign close.)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SANDBOX_SPREADSHEET_ID, SANDBOX_SPREADSHEET_ID_LAST6 } = require('../../../config/sandboxSheet');

const EVIDENCE_FILENAME = 'persona-evidence.json';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The values that must never appear in a published artifact. Overrides exist
// for the unit test; the spec calls this with no arguments and gets the live
// workbook id + the run's credentials from the environment.
function buildForbiddenSecrets(overrides = {}) {
  const spreadsheetId = overrides.spreadsheetId ?? SANDBOX_SPREADSHEET_ID;
  const spreadsheetIdLast6 = overrides.spreadsheetIdLast6 ?? SANDBOX_SPREADSHEET_ID_LAST6;
  const serviceAccountEmail = overrides.serviceAccountEmail ?? process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const providerKey = overrides.providerKey ?? process.env.GEMINI_API_KEY;
  const scan = [
    { kind: 'workbook_id', re: spreadsheetId ? new RegExp(escapeRegExp(spreadsheetId), 'i') : null },
    { kind: 'private_key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
    { kind: 'service_account_email', re: serviceAccountEmail ? new RegExp(escapeRegExp(serviceAccountEmail), 'i') : null },
    { kind: 'provider_key', re: providerKey ? new RegExp(escapeRegExp(providerKey)) : null },
  ].filter((f) => f.re);
  return { scan, spreadsheetId, spreadsheetIdLast6, serviceAccountEmail, providerKey };
}

// Redact every forbidden value from text before it is published. The
// workbook id keeps its last 6 (the published form the scorecard names);
// a private-key block, the service-account email, and the provider key are
// replaced wholesale. Redaction is defense in depth — the sweep still fails
// the run on any leak — so a value the redaction missed is caught, not
// published.
function redactSecrets(text, forbidden) {
  let out = String(text);
  if (forbidden.spreadsheetId) out = out.split(forbidden.spreadsheetId).join(`…${forbidden.spreadsheetIdLast6}`);
  out = out.replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  if (forbidden.serviceAccountEmail) out = out.split(forbidden.serviceAccountEmail).join('[REDACTED SERVICE ACCOUNT EMAIL]');
  if (forbidden.providerKey) out = out.split(forbidden.providerKey).join('[REDACTED PROVIDER KEY]');
  return out;
}

// Sweep + hash every regular file in the artifact dir, in name order. The
// record names each leak (`<kind> in <name>`) and each file's SHA-256 over
// the bytes read here — the caller must run this after the last write to the
// swept files, or the hashes certify stale bytes.
function sweepArtifactDir(artDir, forbidden, { excludeNames = [] } = {}) {
  const files = [];
  const leaks = [];
  for (const name of fs.readdirSync(artDir).sort()) {
    if (excludeNames.includes(name)) continue;
    const full = path.join(artDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    const text = buf.toString('latin1');
    for (const f of forbidden.scan) if (f.re.test(text)) leaks.push(`${f.kind} in ${name}`);
    files.push({ name, sha256: sha256(buf), bytes: buf.length });
  }
  return { swept: true, leaks, files };
}

// Post-write verification: recompute the sweep over the published bytes and
// demand exact agreement with the record — no leak in any final file
// (including the record's own container, which the hash list excludes but
// the leak scan still covers), every recorded hash matching the published
// bytes, and no published file missing from the record. Throws on the first
// problem set found; a passing return means the record certifies the bytes
// on disk.
function verifyFinalArtifacts(artDir, record, forbidden, { selfExcludedName = EVIDENCE_FILENAME } = {}) {
  const problems = [];
  const actual = sweepArtifactDir(artDir, forbidden, { excludeNames: [selfExcludedName] });
  if (actual.leaks.length) problems.push(`artifact leakage in final bytes: ${actual.leaks.join(', ')}`);
  const recorded = new Map((record.files || []).map((f) => [f.name, f]));
  for (const f of actual.files) {
    const r = recorded.get(f.name);
    if (!r) problems.push(`artifact ${f.name} is published but has no recorded hash`);
    else if (r.sha256 !== f.sha256) problems.push(`artifact ${f.name} changed after the sweep (recorded ${r.sha256.slice(0, 12)}… vs final ${f.sha256.slice(0, 12)}…)`);
    else if (r.bytes !== f.bytes) problems.push(`artifact ${f.name} changed size after the sweep`);
  }
  for (const name of recorded.keys()) {
    if (!actual.files.some((f) => f.name === name)) problems.push(`artifact ${name} is recorded but no longer published`);
  }
  const containerPath = path.join(artDir, selfExcludedName);
  if (fs.existsSync(containerPath)) {
    const text = fs.readFileSync(containerPath).toString('latin1');
    for (const f of forbidden.scan) if (f.re.test(text)) problems.push(`${f.kind} in ${selfExcludedName}`);
  }
  if (problems.length) throw new Error(`persona final-artifact verification failed: ${problems.join('; ')}`);
  return { ok: true, checked: actual.files.length + 1 };
}

module.exports = {
  EVIDENCE_FILENAME,
  buildForbiddenSecrets,
  redactSecrets,
  sweepArtifactDir,
  verifyFinalArtifacts,
};
