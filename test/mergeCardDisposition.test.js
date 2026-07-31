'use strict';

// Merge-card "Additional findings" validation (owner ruling 2026-07-30, final form 2026-07-31 —
// bounded backlog ledger).
//
// The check lives inline in .github/workflows/merge-card-check.yml. These tests run THAT source,
// not a copy: the workflow's `script:` body is extracted and executed with a stubbed `core` and
// `context`, so a change to the workflow that breaks the contract fails here.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'merge-card-check.yml');
const TEMPLATE = path.join(ROOT, '.github', 'PULL_REQUEST_TEMPLATE.md');

/** Pull the inline `script: |` body out of the workflow, de-indented. */
function extractScript() {
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  const marker = yaml.indexOf('script: |');
  assert.ok(marker > 0, 'merge-card-check.yml must carry an inline script block');
  const lines = yaml.slice(yaml.indexOf('\n', marker) + 1).split('\n');
  const indent = lines[0].match(/^\s*/)[0].length;
  const body = [];
  for (const line of lines) {
    if (line.trim() === '') { body.push(''); continue; }
    if (line.match(/^\s*/)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const SCRIPT = extractScript();

/** Run the real check against a PR body; returns the failure message, or '' when it passed. */
function check(body) {
  let failure = '';
  const core = { setFailed: (m) => { failure = m; }, info: () => {} };
  const context = { payload: { pull_request: { body } } };
  // eslint-disable-next-line no-new-func
  new Function('core', 'context', SCRIPT)(core, context);
  return failure;
}

const CARD = '## 🟦 Atlas Merge Card\n\n';
const findings = (lines) => `${CARD}### Additional findings\n\n${lines}\n\n### Post-merge\n\nx\n`;

describe('merge card — Additional findings dispositions', () => {
  it('accepts each of the five allowed dispositions', () => {
    assert.equal(check(findings('- None')), '');
    assert.equal(check(findings('- FIXED NOW: corrected the guard message')), '');
    assert.equal(check(findings('- REJECTED: speculative, no evidence')), '');
    assert.equal(check(findings('- OWNER DECISION REQUIRED: schema change')), '');
    assert.equal(
      check(findings([
        '- ADDED TO BOUNDED BACKLOG:',
        '  - added: closeout banner double-fires on reload',
        '  - removed/archived/promoted: archived the resolved PARSE-6 record',
        '  - counts: items 282 → 282 · lines 787 → 787 · cap 787 → 787',
      ].join('\n'))),
      '',
    );
  });

  it('fails when the Additional findings section is missing', () => {
    const failure = check(`${CARD}### Post-merge\n\nx\n`);
    assert.match(failure, /missing the "Additional findings" section/);
  });

  it('fails when the section carries no recognized disposition', () => {
    const failure = check(findings('- we looked at some things'));
    assert.match(failure, /must record one disposition/);
  });

  it('names all five dispositions in its guidance', () => {
    const failure = check(findings('- nothing recognizable here'));
    for (const d of ['None', 'FIXED NOW', 'REJECTED', 'ADDED TO BOUNDED BACKLOG', 'OWNER DECISION REQUIRED']) {
      assert.ok(failure.includes(d), `${d} missing from the guidance: ${failure}`);
    }
  });
});

describe('merge card — bounded-intake declaration', () => {
  const intake = (extra) => findings(['- ADDED TO BOUNDED BACKLOG:', ...extra].join('\n'));

  it('fails a claimed intake that names no removed item', () => {
    const failure = check(intake([
      '  - added: closeout banner double-fires',
      '  - counts: items 282 → 282 · lines 787 → 787 · cap 787 → 787',
    ]));
    assert.match(failure, /removed\/archived\/promoted/);
  });

  it('fails a claimed intake that reports no counts', () => {
    const failure = check(intake([
      '  - added: closeout banner double-fires',
      '  - removed/archived/promoted: archived PARSE-6',
    ]));
    assert.match(failure, /counts:/);
  });

  it('fails a claimed intake that names no added item', () => {
    const failure = check(intake([
      '  - removed/archived/promoted: archived PARSE-6',
      '  - counts: items 282 → 282 · lines 787 → 787 · cap 787 → 787',
    ]));
    assert.match(failure, /added:/);
  });

  it('fails when the disposition line claims an addition with no declaration at all', () => {
    const failure = check(findings('- ADDED TO BOUNDED BACKLOG: closeout banner item'));
    assert.match(failure, /added:|removed|counts:/);
  });

  it('does not fail an untouched scaffold whose declaration lines are all empty', () => {
    const failure = check(findings([
      '- None',
      '- ADDED TO BOUNDED BACKLOG:',
      '  - added:',
      '  - removed/archived/promoted:',
      '  - counts:',
    ].join('\n')));
    assert.equal(failure, '', failure);
  });

  it('does not demand a declaration from a PR that added nothing', () => {
    assert.equal(check(findings('- None')), '');
    assert.equal(check(findings('- REJECTED: duplicate of an existing record')), '');
  });
});

describe('merge card — the shipped template satisfies its own check', () => {
  it('passes the unfilled Additional findings block', () => {
    const template = fs.readFileSync(TEMPLATE, 'utf8');
    const heading = /^[ \t]*#{2,4}[ \t]*Additional findings[ \t]*$/im.exec(template);
    assert.ok(heading, 'the template must carry an Additional findings heading');
    const section = template.slice(heading.index + heading[0].length).split(/\n[ \t]*#{2,4}[ \t]+/)[0];
    for (const d of ['None', 'FIXED NOW', 'REJECTED', 'ADDED TO BOUNDED BACKLOG', 'OWNER DECISION REQUIRED']) {
      assert.ok(section.includes(d), `${d} missing from the PR template`);
    }
    // The rest of the unfilled template still trips the placeholder sentinels, which is by
    // design; assert only that the findings block itself raises no complaint.
    const failure = check(`${CARD}${template.slice(heading.index)}`);
    assert.ok(!/Additional findings/.test(failure), failure);
    assert.ok(!/ADDED TO BOUNDED BACKLOG requires/.test(failure), failure);
  });
});
