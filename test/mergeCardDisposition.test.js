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

// Owner instruction 2026-08-03 — every body must now carry the review section, so the
// shared fixtures below include a satisfied one. Its own presence/content rules are
// exercised in the dedicated suite at the bottom of this file.
const REVIEW_OK = [
  '### Atlas Contract / Systems Review',
  '',
  '- Required: not required — no trigger applies',
  '- Exact reviewed head: n/a',
  '- Reviewer: n/a',
  '- Findings and dispositions: n/a',
  '',
].join('\n');
// Owner instruction 2026-08-05 — every body must now also declare who performed the
// work, so the shared fixture carries a satisfied attribution block. Its own rules are
// exercised in the dedicated suite at the bottom of this file.
const ATTRIBUTION_OK = [
  '| **Builder surface** | Cursor |',
  '| **Primary builder model** | Kimi K3 |',
  '| **Supporting / explore models** | None |',
  '| **Architecture / dispatch authority** | ChatGPT |',
  '',
].join('\n');
const CARD = `## 🟦 Atlas Merge Card\n\n${ATTRIBUTION_OK}\n${REVIEW_OK}`;
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

  // Codex P2 — a value of ":" is punctuation, not content. All three must reject it.
  it('fails a declaration whose values are only another colon', () => {
    const failure = check(findings([
      '- ADDED TO BOUNDED BACKLOG:',
      '  - added::',
      '  - removed/archived/promoted::',
      '  - counts::',
    ].join('\n')));
    assert.match(failure, /must record one disposition|added:|removed|counts:/);
    for (const label of ['added:', 'removed/archived/promoted:', 'counts:']) {
      assert.ok(failure.includes(label), `${label} not demanded: ${failure}`);
    }
  });

  it('fails when one declaration is real and the others are punctuation', () => {
    const failure = check(findings([
      '- ADDED TO BOUNDED BACKLOG:',
      '  - added: closeout banner double-fires',
      '  - removed/archived/promoted::',
      '  - counts::',
    ].join('\n')));
    assert.ok(failure.includes('removed/archived/promoted:'), failure);
    assert.ok(failure.includes('counts:'), failure);
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

// Owner instruction 2026-08-03 — the Atlas Contract / Systems Review block. The four
// fields exist so a review names what it read. An unfilled block must fail the check,
// or a risk-triggered PR could claim a review it never had while the gate stayed green
// (Codex P1, PR #1257). These run the REAL workflow source, like every test above.
describe('merge card — the Atlas Contract / Systems Review block', () => {
  const REVIEW_BLOCK = fs.readFileSync(TEMPLATE, 'utf8')
    .split(/^### Atlas Contract \/ Systems Review$/m)[1];
  // A card whose OTHER required section is already satisfied, so each assertion below
  // measures the review block alone.
  const CARD_OK = `## 🟦 Atlas Merge Card\n\n${ATTRIBUTION_OK}\n### Additional findings\n\n- None\n\n`;

  it('fails when the review section is deleted outright', () => {
    const failure = check(`## 🟦 Atlas Merge Card\n\n${ATTRIBUTION_OK}\n### Additional findings\n\n- None\n`);
    assert.match(failure, /missing the "Atlas Contract \/ Systems Review" section/,
      'a deleted review section must fail — sentinels catch retained placeholders, not removed ones');
  });

  it('the template actually ships the block', () => {
    assert.ok(REVIEW_BLOCK, 'the PR template must carry an "### Atlas Contract / Systems Review" heading');
    for (const field of ['Required:', 'Exact reviewed head:', 'Reviewer:', 'Findings and dispositions:']) {
      assert.ok(REVIEW_BLOCK.includes(field), `${field} missing from the review block`);
    }
  });

  it('rejects the block left exactly as the template ships it', () => {
    const failure = check(`${CARD_OK}### Atlas Contract / Systems Review${REVIEW_BLOCK.split(/^### /m)[0]}`);
    assert.match(failure, /template placeholder/, 'an untouched review block must fail the check');
  });

  // The bite: each sentinel is load-bearing on its own. Remove one field's placeholder
  // and that field alone must stop being reported — proving the check reads all three
  // rather than tripping once on something else.
  // Placeholders are READ FROM THE SHIPPED TEMPLATE, never retyped. Hardcoding them
  // would let a template rewording silently un-guard a field while this suite stayed
  // green — the exact hardcoded-evidence false green the review lane exists to catch
  // (exact-head review of PR #1257, F4). Derived here, every field's real placeholder
  // must be bitten by some sentinel.
  const FIELD_PLACEHOLDERS = (() => {
    const out = [];
    for (const line of REVIEW_BLOCK.split('\n')) {
      const m = /^[ \t]*-[ \t]*([^:]+):[ \t]*<!--[ \t]*(.+?)[ \t]*-->[ \t]*$/.exec(line);
      if (m) out.push([m[1].trim(), m[2].trim()]);
    }
    return out;
  })();

  it('every review field in the template carries a placeholder this suite can bite', () => {
    assert.equal(FIELD_PLACEHOLDERS.length, 4,
      `expected 4 placeholder-carrying review fields, found ${FIELD_PLACEHOLDERS.length}: ${JSON.stringify(FIELD_PLACEHOLDERS)}`);
  });

  for (const [field, placeholder] of FIELD_PLACEHOLDERS) {
    it(`catches the unfilled "${field}" placeholder specifically`, () => {
      const failure = check(`${CARD_OK}### Atlas Contract / Systems Review\n\n- x: <!-- ${placeholder} -->\n`);
      assert.match(failure, /template placeholder/,
        `the template's own "${field}" placeholder must trip a sentinel; got: ${failure || '(passed)'}`);
    });
  }

  // The Required verdict has TWO carriers: this bullet and the merge-card table row.
  // The row is READ FROM THE TEMPLATE for the same reason the bullets are — retyping it
  // would let a row rewording silently kill that sentinel while this suite stayed green
  // (exact-head review of PR #1257, F4/C).
  const TABLE_ROW = (() => {
    const line = fs.readFileSync(TEMPLATE, 'utf8').split('\n')
      .find((l) => /^\|.*Atlas Contract \/ Systems Review.*\|/.test(l));
    return line || null;
  })();

  it('the template ships a merge-card row for the review, carrying a placeholder', () => {
    assert.ok(TABLE_ROW, 'the merge-card table must carry an Atlas Contract / Systems Review row');
    assert.match(TABLE_ROW, /<!--.*-->/, 'that row must ship an unfilled placeholder to guard');
  });

  it('catches the unfilled Required verdict in the merge-card table row too', () => {
    const failure = check(`${CARD_OK}${TABLE_ROW}\n`);
    assert.match(failure, /template placeholder/,
      `the table row's unfilled verdict must fail too; got: ${failure || '(passed)'}`);
  });

  it('passes once every field carries a real value', () => {
    const filled = [
      '### Atlas Contract / Systems Review',
      '',
      '- Required: required — the PR changes a scorecard',
      '- Exact reviewed head: 50d75cbe1c59847ad91084bc75ae02b45330ed77',
      '- Reviewer: clean-context systems review',
      '- Findings and dispositions: one P1, fixed',
      '',
    ].join('\n');
    assert.equal(check(`${CARD_OK}${filled}`), '');
  });

  // The other legitimate verdict: a PR that genuinely fired no trigger must be able to
  // say so and pass. A guard that only accepted "required" would push PRs to claim a
  // review they did not need.
  it('passes an explicit not-required verdict with a reason', () => {
    const filled = [
      '### Atlas Contract / Systems Review',
      '',
      '- Required: not required — documentation only; no trigger in the list applies',
      '- Exact reviewed head: n/a',
      '- Reviewer: n/a',
      '- Findings and dispositions: n/a',
      '',
    ].join('\n');
    assert.equal(check(`${CARD_OK}${filled}`), '');
  });

  // The retired row must not come back: its template field no longer exists, so the
  // sentinel could only false-fail a body that quotes the old wording.
  it('no longer trips on a body quoting the retired status wording', () => {
    const failure = check(`${CARD_OK}${REVIEW_OK}The old row allowed NON-BLOCKING / READY / BLOCKING / not risk-triggered.\n`);
    assert.equal(failure, '', 'quoting the retired wording is prose, not an unfilled field');
  });
});

// Owner instruction 2026-08-05 — merge-card attribution (surface and model neutrality).
// Atlas work may be implemented by any owner-approved agent on any approved surface, so
// every PR declares which surface and model performed it. These run the REAL workflow
// source, like every test above.
//
// The fields are DECLARED EVIDENCE. This check cannot tell a true model name from a false
// one; it can only tell a claim from a blank, which is exactly the false green it exists
// to close — a PR that silently omits its surface would otherwise go green.
describe('merge card — attribution fields', () => {
  const TEMPLATE_BODY = fs.readFileSync(TEMPLATE, 'utf8');
  const FIELDS = [
    'Builder surface',
    'Primary builder model',
    'Supporting / explore models',
    'Architecture / dispatch authority',
  ];
  const rows = (overrides = {}) => FIELDS
    .map((f) => `| **${f}** | ${Object.prototype.hasOwnProperty.call(overrides, f) ? overrides[f] : 'x'} |`)
    .join('\n');
  const card = (attribution) => `## 🟦 Atlas Merge Card\n\n${attribution}\n\n${REVIEW_OK}### Additional findings\n\n- None\n\n### Post-merge\n\nx\n`;

  it('accepts a fully declared attribution block', () => {
    assert.equal(check(card(rows({
      'Builder surface': 'Cursor',
      'Primary builder model': 'Kimi K3',
      'Supporting / explore models': 'Grok 4.5 — repository investigation only',
      'Architecture / dispatch authority': 'ChatGPT',
    }))), '');
  });

  it('accepts None for Supporting / explore models', () => {
    assert.equal(check(card(rows({ 'Supporting / explore models': 'None' }))), '');
  });

  // MUTATION 4 — `None` in a field that must name a real actor (exact-head review of PR
  // #1268, P1). A non-empty check alone let `Builder surface: None` satisfy the required
  // check while declaring none of the attribution it exists to require. `None` is the one
  // value whose permitted scope CLAUDE.md defines exactly, so it is the one this literal
  // check can enforce.
  const NONE_FORBIDDEN = FIELDS.filter((f) => f !== 'Supporting / explore models');

  for (const field of NONE_FORBIDDEN) {
    for (const written of ['None', 'none', 'NONE', 'None.', '  None  ', '**None**']) {
      it(`fails when "${field}" is ${JSON.stringify(written)}, and names only that field`, () => {
        const failure = check(card(rows({ [field]: written })));
        assert.match(failure, new RegExp(`attribution field "${field.replace('/', '\\/')}" may not be None`));
        for (const other of FIELDS) {
          if (other === field) continue;
          assert.ok(!failure.includes(`"${other}"`), `${other} must not be reported: ${failure}`);
        }
      });
    }
  }

  it('fails every forbidden None at once, naming each field', () => {
    const failure = check(card(rows(Object.fromEntries(NONE_FORBIDDEN.map((f) => [f, 'None'])))));
    for (const field of NONE_FORBIDDEN) {
      assert.ok(failure.includes(`"${field}" may not be None`), `${field} not reported: ${failure}`);
    }
    assert.ok(!failure.includes('"Supporting / explore models"'), failure);
  });

  it('accepts None for Supporting / explore models in every casing', () => {
    for (const written of ['None', 'none', 'NONE', 'None.', '**None**']) {
      assert.equal(check(card(rows({ 'Supporting / explore models': written }))), '',
        `Supporting / explore models must still accept ${JSON.stringify(written)}`);
    }
  });

  it('rejects None in the bullet shape too, not only the table row', () => {
    const bullets = FIELDS.map((f) => `- ${f}: ${f === 'Builder surface' ? 'None' : 'x'}`).join('\n');
    assert.match(check(card(bullets)), /attribution field "Builder surface" may not be None/);
  });

  // The bite must be NARROW: a real value that merely contains the word must pass, or the
  // guard would push a truthful declaration into a workaround.
  it('does not trip on a real value that merely contains the word "none"', () => {
    assert.equal(check(card(rows({
      'Builder surface': 'Claude Code',
      'Primary builder model': 'the surface withholds the model identity; none is displayed',
      'Architecture / dispatch authority': 'ChatGPT (no supporting authority — none delegated)',
    }))), '');
  });

  it('accepts the bullet shape as well as the table row', () => {
    const bullets = FIELDS.map((f) => `- ${f}: x`).join('\n');
    assert.equal(check(card(bullets)), '');
  });

  // MUTATION 1 — a missing field. Each of the four is load-bearing on its own: dropping
  // one must name that field and no other, which proves the check reads all four rather
  // than tripping once on something else.
  for (const missing of FIELDS) {
    it(`fails when "${missing}" is absent, and names only that field`, () => {
      const kept = FIELDS.filter((f) => f !== missing).map((f) => `| **${f}** | x |`).join('\n');
      const failure = check(card(kept));
      assert.match(failure, new RegExp(`missing the required attribution field "${missing.replace('/', '\\/')}"`));
      for (const other of FIELDS) {
        if (other === missing) continue;
        assert.ok(!failure.includes(`"${other}"`), `${other} must not be reported: ${failure}`);
      }
    });
  }

  // MUTATION 2 — a blank value. Silence is not a declaration.
  for (const blanked of FIELDS) {
    it(`fails when "${blanked}" is blank`, () => {
      const failure = check(card(rows({ [blanked]: '' })));
      assert.match(failure, new RegExp(`attribution field "${blanked.replace('/', '\\/')}" is blank`));
    });
  }

  // MUTATION 3 — a retained template placeholder. Placeholders are READ FROM THE SHIPPED
  // TEMPLATE, never retyped: hardcoding them would let a template rewording silently
  // un-guard a field while this suite stayed green.
  const TEMPLATE_PLACEHOLDERS = (() => {
    const out = [];
    for (const line of TEMPLATE_BODY.split('\n')) {
      const m = /^[ \t]*\|[ \t]*\*{2}([^*|]+)\*{2}[ \t]*\|[ \t]*(<!--[\s\S]*?-->)[ \t]*\|[ \t]*$/.exec(line);
      if (m && FIELDS.includes(m[1].trim())) out.push([m[1].trim(), m[2]]);
    }
    return out;
  })();

  it('the template ships all four attribution rows, each with a placeholder this suite can bite', () => {
    assert.equal(TEMPLATE_PLACEHOLDERS.length, 4,
      `expected 4 placeholder-carrying attribution rows, found ${TEMPLATE_PLACEHOLDERS.length}: ${JSON.stringify(TEMPLATE_PLACEHOLDERS)}`);
  });

  for (const [field, placeholder] of TEMPLATE_PLACEHOLDERS) {
    it(`fails when "${field}" is left as the shipped placeholder`, () => {
      const failure = check(card(rows({ [field]: placeholder })));
      assert.match(failure, new RegExp(`attribution field "${field.replace('/', '\\/')}" is blank or still a template placeholder`));
    });
  }

  it('accepts a real value that keeps the placeholder comment beside it', () => {
    const [field, placeholder] = TEMPLATE_PLACEHOLDERS[0];
    assert.equal(check(card(rows({ [field]: `Cursor ${placeholder}` }))), '');
  });

  it('the shipped template carries the attribution guidance, not a second attribution system', () => {
    assert.match(TEMPLATE_BODY, /sole attribution authority/i);
    assert.match(TEMPLATE_BODY, /[Nn]ever guess a model identity/);
    assert.match(TEMPLATE_BODY, /do not add a commit trailer,\s+model registry,\s+label taxonomy,\s+or tracking database/i);
  });
});
