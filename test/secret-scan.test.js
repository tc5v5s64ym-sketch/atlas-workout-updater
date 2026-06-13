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
