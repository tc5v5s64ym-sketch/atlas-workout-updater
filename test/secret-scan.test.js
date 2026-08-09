const test = require('node:test');
const assert = require('node:assert/strict');
const { rules } = require('../scripts/check-changed-files-for-secrets');

const ruleByName = Object.fromEntries(rules.map(rule => [rule.name, rule]));

// Built at runtime so this test file never contains a literal key that would
// trip the scanner when it scans its own changed files in CI.
const sampleGeminiKey = 'AIza' + 'B'.repeat(35); // "AIza" + 35 url-safe chars

test('scanner exposes the Gemini rules', () => {
  assert.ok(ruleByName['gemini-api-key-assignment'], 'GEMINI_API_KEY assignment rule must exist');
  assert.ok(ruleByName['google-ai-api-key'], 'raw Google/Gemini key-format rule must exist');
});

test('scanner exposes the Anthropic OAuth token rule', () => {
  assert.ok(ruleByName['anthropic-oauth-token'], 'Anthropic OAuth token rule must exist');
});

test('anthropic-oauth-token flags the raw sk-ant-oat token under any var name', () => {
  const rule = ruleByName['anthropic-oauth-token'];
  // Built at runtime so this test file never contains a literal token that
  // would trip the scanner when it scans its own changed files in CI.
  const sampleOauthToken = ['sk', 'ant', 'oat01'].join('-') + '-' + 'B'.repeat(24);
  assert.equal(rule.test(`CLAUDE_CODE_OAUTH_TOKEN=${sampleOauthToken}`, 'render.yaml'), true, 'a committed token must be flagged');
  assert.equal(rule.test(`SOME_VAR="${sampleOauthToken}"`, 'notes.md'), true, 'a leaked token under a different name is still caught');
  assert.equal(rule.test('starts with `sk-ant-oat...`', '.github/workflows/claude-code-review.yml'), false, 'the setup-instructions ellipsis is not a real token');
  assert.equal(rule.test('sk-ant-oat-tooshort', 'notes.md'), false, 'a short lookalike is not a token');
});

test('gemini-api-key-assignment flags a real key, allows the example placeholder', () => {
  const rule = ruleByName['gemini-api-key-assignment'];
  assert.equal(rule.test(`GEMINI_API_KEY=${sampleGeminiKey}`, 'render.yaml'), true, 'a committed key must be flagged');
  assert.equal(rule.test('GEMINI_API_KEY=replace_me', '.env.example'), false, 'the .env.example placeholder is allowed');
  assert.equal(rule.test('GEMINI_API_KEY=', '.env.example'), false, 'an empty .env.example value is allowed');
  assert.equal(rule.test('SOME_OTHER_VAR=hello', 'config.js'), false, 'unrelated assignments are not flagged');
});

test('google-ai-api-key flags the raw AIza token under any var name', () => {
  const rule = ruleByName['google-ai-api-key'];
  assert.equal(rule.test(`COACH_KEY="${sampleGeminiKey}"`), true, 'a leaked key under a different name is still caught');
  assert.equal(rule.test('AIza-too-short'), false, 'a short lookalike is not a key');
  assert.equal(rule.test('replace_me'), false, 'a placeholder is not a key');
});

// ── The identifier/credential boundary (owner ruling 2026-08-09) ──────────────
//
// A Supabase PROJECT REFERENCE is a non-secret project IDENTIFIER: not a
// password, key, token, or authorization mechanism. The scanner must give ONE
// answer matching that policy — the identifier passes, and everything that
// AUTHENTICATES still fails. These fixtures are assembled at runtime so this
// file never carries a literal credential the scanner would catch on itself.

const fakeRef = 'abcdefghijklmnopqrst'; // 20-char lowercase, the reference shape

test('no project-reference rule exists, and nothing replaced it', () => {
  assert.equal(
    ruleByName['supabase-project-reference'],
    undefined,
    'the project-reference rule is deleted under the owner ruling'
  );
  const identifierRules = rules.filter((rule) =>
    /project.?ref|projectreference/i.test(rule.name)
  );
  assert.deepEqual(identifierRules, [], 'no renamed or replacement identifier detector may exist');
});

test('a reference-only Supabase hostname or identifier is ALLOWED by every rule', () => {
  const allowed = [
    `db.${fakeRef}.supabase.co`,
    `https://${fakeRef}.supabase.co`,
    `postgres.${fakeRef}`,
    `ATLAS_SUPABASE_EXPECTED_PROJECT_REF=${fakeRef}`,
    `aws-0-us-west-2.pooler.supabase.com`,
    `postgres://postgres.${fakeRef}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`,
  ];
  for (const text of allowed) {
    const hits = rules.filter((rule) => rule.test(text, 'notes.md')).map((rule) => rule.name);
    assert.deepEqual(hits, [], `a bare identifier must not be a finding: ${text}`);
  }
});

test('a credential-bearing connection string still FAILS, on the same host', () => {
  const password = 'p' + 'A55w0rd'; // assembled so the file carries no literal credential
  const withPassword = [
    `postgres://atlas_app:${password}@db.${fakeRef}.supabase.co:5432/postgres`,
    `postgresql://postgres.${fakeRef}:${password}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`,
    `DB_URL="postgres://atlas_rebuild:${password}@db.${fakeRef}.supabase.co:5432/postgres"`,
  ];
  for (const text of withPassword) {
    const hits = rules.filter((rule) => rule.test(text, 'notes.md')).map((rule) => rule.name);
    assert.ok(
      hits.includes('postgres-connection-string-with-password'),
      `a password-bearing URI must be refused: ${text.replace(password, '<redacted>')}`
    );
  }
  // The identifier is free, the credential is not — on the identical host.
  const host = `db.${fakeRef}.supabase.co`;
  assert.deepEqual(rules.filter((r) => r.test(host, 'notes.md')), []);
  assert.ok(
    rules
      .filter((r) => r.test(`postgres://atlas_app:${password}@${host}:5432/postgres`, 'notes.md'))
      .map((r) => r.name)
      .includes('postgres-connection-string-with-password')
  );
});

test('secret keys, JWTs and role-URL assignments still FAIL', () => {
  const body = 'abcdefghijklmnopqrstuvwxyz012345';
  const jwt = ['eyJ' + 'a'.repeat(20), 'eyJ' + 'b'.repeat(20), 'c'.repeat(20)].join('.');
  const cases = [
    [`KEY=sb_secret_${body}`, 'supabase-api-key'],
    [`KEY=sb_publishable_${body}`, 'supabase-api-key'],
    [`SUPABASE_SERVICE_ROLE_KEY=${jwt}`, 'supabase-jwt-key'],
    ['ATLAS_SUPABASE_APP_URL=postgres://a-real-value/db', 'supabase-role-url-assignment'],
    ['ATLAS_SUPABASE_MIGRATE_URL=postgres://a-real-value/db', 'supabase-role-url-assignment'],
  ];
  for (const [text, expected] of cases) {
    const hits = rules.filter((rule) => rule.test(text, 'notes.md')).map((rule) => rule.name);
    assert.ok(hits.includes(expected), `${expected} must still fire on: ${text.slice(0, 40)}…`);
  }
  // The .env.example placeholders stay allowed.
  assert.deepEqual(rules.filter((r) => r.test('ATLAS_SUPABASE_APP_URL=replace_me', '.env.example')), []);
});
