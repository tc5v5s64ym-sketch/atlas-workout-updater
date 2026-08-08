'use strict';

// Give the four scoped roles a LOGIN for the duration of one proof run.
//
// The migration creates atlas_app, atlas_migrate, atlas_readonly and
// atlas_rebuild as NOLOGIN with no password, because a password in a migration
// file is a committed credential (§8.4). The least-privilege proof (§6.1 P7c)
// must nonetheless connect AS each role — a statement proven only as superuser
// proves nothing about the deployed system.
//
// So this bootstrap mints a random password per role per run, hands back the
// connection strings, and writes nothing to disk. Against `Atlas Production` the
// equivalent step is the owner's, performed out of band.
//
// PROOF-ONLY. No production path requires it, and it is never imported by the
// server.

const crypto = require('crypto');
const { Client } = require('pg');

const ROLE_NAMES = Object.freeze(['atlas_app', 'atlas_migrate', 'atlas_readonly', 'atlas_rebuild']);

function randomPassword() {
  // Hex only: a connection URI must be able to carry it without escaping, and an
  // escaping bug in a proof harness would look like a permission failure.
  return crypto.randomBytes(24).toString('hex');
}

function urlForRole(baseUrl, role, password) {
  const parsed = new URL(baseUrl);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

async function grantLoginToScopedRoles(targetUrl) {
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  const credentials = {};
  try {
    for (const role of ROLE_NAMES) {
      const password = randomPassword();
      // Identifiers are from the frozen list above, never from input.
      await client.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
      // Without CONNECT the role authenticates and then cannot open the database,
      // which would read as an authentication failure rather than as the grant
      // question under test.
      await client.query(`GRANT CONNECT ON DATABASE ${client.database} TO ${role}`);
      credentials[role] = urlForRole(targetUrl, role, password);
    }
  } finally {
    await client.end();
  }
  return credentials;
}

module.exports = { grantLoginToScopedRoles, ROLE_NAMES };
