'use strict';

// Mechanical coverage for .github/workflows/merge-card-check.yml.
// The suite executes the workflow's real inline script. It proves the check
// catches missing fields, invalid closed forms, stale reviewed heads, wrong
// reviewer identity, and a non-passing required review. It deliberately does
// not test the meaning of prose.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/merge-card-check.yml');
const HEAD = 'a'.repeat(40);

function extractScript() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s+script:\s*\|\s*$/.test(line));
  if (start < 0) throw new Error('merge-card-check.yml has no inline script block');
  const indent = lines[start].match(/^\s*/)[0].length + 2;
  const script = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/)[0].length < indent) break;
    script.push(line.slice(Math.min(indent, line.length)));
  }
  return script.join('\n');
}

const SCRIPT = extractScript();

const FIELDS = {
  'Canonical plan card': 'Owner instruction 2026-08-10',
  Title: 'Simplify review governance',
  'Primary risk': 'auto-safe · medium',
  'Files / categories touched': 'governance only',
  'Current-state verdict': 'STILL BROKEN — confirmed against current main',
  'Builder surface': 'Codex',
  'Primary builder model': 'GPT-5',
  'Supporting / explore models': 'None',
  'Architecture / dispatch authority': 'ChatGPT',
  'Authority impact': 'CLAUDE.md remains the sole governance authority',
  'Tests / hard gates': 'node --test test/mergeCardMechanical.test.js — passing',
  'Advisory audit': 'not run',
  'Owner authorization required': 'No',
  'Live validation': 'N/A',
  'Merge authority': 'active builder merges exact passing head',
};

function card(options = {}) {
  const values = { ...FIELDS, ...(options.fields || {}) };
  const rows = Object.entries(values)
    .filter(([label]) => label !== options.omitField)
    .map(([label, value]) => '| **' + label + '** | ' + value + ' |');
  const reviewValues = {
    Required: 'NOT REQUIRED — no high-risk trigger fired',
    'Exact reviewed head': 'N/A',
    Reviewer: 'N/A',
    'Review outcome': 'N/A',
    'Findings and fix verification': 'N/A',
    ...(options.review || {}),
  };
  const reviewRows = Object.entries(reviewValues)
    .filter(([label]) => label !== options.omitReviewField)
    .map(([label, value]) => '- **' + label + '**: ' + value);
  return [
    '## 🟦 Atlas Merge Card',
    '',
    '| Field | Value |',
    '|---|---|',
    ...rows,
    '',
    '### Atlas Contract / Systems Review',
    '',
    ...reviewRows,
    '',
    '### Additional findings',
    '',
    options.findings || 'P3 idea was not fixed; prose is reviewer judgment.',
  ].join('\n');
}

async function validate(body, head = HEAD, files = ['docs/status.md']) {
  let failure = '';
  const core = {
    setFailed(message) { failure = String(message); },
    info() {},
  };
  const context = {
    repo: { owner: 'owner', repo: 'repo' },
    payload: { pull_request: { number: 1, body, head: { sha: head } } },
  };
  const github = {
    rest: { pulls: { listFiles() {} } },
    paginate: async () => files.map((filename) => ({ filename })),
  };
  await vm.runInNewContext(
    `(async () => {\n${SCRIPT}\n})()`,
    { context, core, github },
    { timeout: 1000 },
  );
  return failure;
}

function expectGreen(name, body, files) {
  test(name, async () => assert.equal(await validate(body, HEAD, files), ''));
}

function expectRed(name, body, pattern, files) {
  test(name, async () => {
    const message = await validate(body, HEAD, files);
    assert.notEqual(message, '', 'expected a mechanical failure');
    if (pattern) assert.match(message, pattern);
  });
}

expectGreen(
  'a complete NOT REQUIRED card passes for ordinary documentation',
  card(),
  ['docs/status.md'],
);
expectRed('the card heading is required', 'plain PR body', /Atlas Merge Card/);

for (const label of Object.keys(FIELDS)) {
  const escaped = label.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  expectRed('missing mechanical row: ' + label, card({ omitField: label }), new RegExp(escaped));
}

expectRed(
  'a retained HTML placeholder is blank',
  card({ fields: { 'Tests / hard gates': '<!-- exact command -->' } }),
  /Tests \/ hard gates.*blank/i
);
expectRed(
  'the current-state verdict uses a closed opening',
  card({ fields: { 'Current-state verdict': 'NOT CHECKED' } }),
  /must open/i
);
expectGreen(
  'later current-state prose is not semantically parsed',
  card({ fields: {
    'Current-state verdict': 'STILL BROKEN or ALREADY FIXED — reviewer must judge this bad prose',
  } })
);

const required = {
  Required: 'REQUIRED — governance review machinery changed',
  'Exact reviewed head': HEAD,
  Reviewer: 'ChatGPT',
  'Review outcome': 'PASS',
  'Findings and fix verification': 'No blockers remain on this exact head',
};

expectGreen('a passing required review on the exact head passes', card({ review: required }));
expectGreen(
  'a passing required review covers a mechanically high-risk write path',
  card({ review: required }),
  ['services/appendWriteProof.js'],
);
expectRed(
  'a mechanically high-risk write path cannot claim NOT REQUIRED',
  card(),
  /mechanically high-risk path/i,
  ['services/appendWriteProof.js'],
);
expectRed(
  'the live coaching authority route cannot claim NOT REQUIRED',
  card(),
  /routes\/coachOps\.js/i,
  ['routes/coachOps.js'],
);
expectRed(
  'a Supabase migration cannot claim NOT REQUIRED',
  card(),
  /supabase\/migrations/i,
  ['supabase/migrations/202608100001_example.sql'],
);
expectRed(
  'a hard-gate workflow cannot claim NOT REQUIRED',
  card(),
  /merge-card-check\.yml/i,
  ['.github/workflows/merge-card-check.yml'],
);
expectRed(
  'a required review needs a 40-character SHA',
  card({ review: { ...required, 'Exact reviewed head': 'abc1234' } }),
  /40-character SHA/i
);
expectRed(
  'a stale required review fails',
  card({ review: { ...required, 'Exact reviewed head': 'b'.repeat(40) } }),
  /not the PR head/i
);
expectRed(
  'the required lane has one reviewer identity',
  card({ review: { ...required, Reviewer: 'Codex' } }),
  /Reviewer: ChatGPT/i
);
expectRed(
  'a blocking required review cannot merge',
  card({ review: { ...required, 'Review outcome': 'BLOCKING' } }),
  /outcome: PASS/i
);
expectRed(
  'a pending required review cannot merge',
  card({ review: { ...required, 'Review outcome': 'PENDING' } }),
  /outcome: PASS/i
);
expectRed(
  'required-review notes cannot be blank',
  card({ review: { ...required, 'Findings and fix verification': '<!-- notes -->' } }),
  /fix verification.*blank/i
);
expectRed(
  'a review field cannot be omitted',
  card({ omitReviewField: 'Review outcome' }),
  /missing "Review outcome"/i
);
expectRed(
  'an unknown review decision fails closed',
  card({ review: { Required: 'MAYBE' } }),
  /REQUIRED or NOT REQUIRED/i
);
expectRed(
  'NOT REQUIRED uses N/A for the reviewed head',
  card({ review: { 'Exact reviewed head': HEAD } }),
  /Exact reviewed head: N\/A/i
);
expectRed(
  'NOT REQUIRED uses N/A for reviewer',
  card({ review: { Reviewer: 'ChatGPT' } }),
  /Reviewer: N\/A/i
);
expectRed(
  'NOT REQUIRED uses N/A for outcome',
  card({ review: { 'Review outcome': 'PASS' } }),
  /Review outcome: N\/A/i
);

expectGreen(
  'review prose and negation are not semantically parsed',
  card({
    review: {
      ...required,
      'Findings and fix verification':
        'P1 was not fixed; this is reviewer judgment, not a regex target',
    },
    findings: 'ADDED TO BOUNDED BACKLOG without counts — CI does not parse this prose.',
  })
);
