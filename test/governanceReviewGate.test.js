"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const workflowDir = path.join(repoRoot, ".github", "workflows");

function workflowFiles() {
  return fs
    .readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => path.join(workflowDir, name));
}

test("governance does not reintroduce the custom Codex review check adapter", () => {
  const deletedAdapters = [
    path.join(workflowDir, "codex-code-review.yml"),
    path.join(workflowDir, "codex-review-refresh.yml"),
  ];

  for (const file of deletedAdapters) {
    assert.equal(
      fs.existsSync(file),
      false,
      `${path.relative(repoRoot, file)} must stay deleted`,
    );
  }

  for (const file of workflowFiles()) {
    const relative = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, "utf8");

    assert.doesNotMatch(
      text,
      /\bname:\s*['"]?Codex review['"]?\b/i,
      `${relative} must not publish a Codex review check`,
    );
    assert.doesNotMatch(
      text,
      /github\.rest\.checks\.create/i,
      `${relative} must not create duplicate native-review check runs`,
    );
    assert.doesNotMatch(
      text,
      /pull_request_review/i,
      `${relative} must not use review events to refresh a required check`,
    );
  }
});

test("governance does not parse native Codex bot wording as an approval contract", () => {
  const activeFiles = [
    "AGENTS.md",
    "CODEX.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/workflows/merge-card-check.yml",
    "docs/AGENT_WORKFLOW.md",
    "docs/AUTOMATION_PROTOCOL.md",
    "docs/OWNER_CHECKIN_RULES.md",
  ];

  const bannedPhraseContracts = [
    /Codex Review: Didn't find any major issues\./i,
    /\*\*Reviewed commit:\*\*/i,
    /reviewThreads/i,
    /P\(\[0-3\]\) Badge/i,
  ];

  for (const relative of activeFiles) {
    const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    for (const pattern of bannedPhraseContracts) {
      assert.doesNotMatch(
        text,
        pattern,
        `${relative} must not depend on ${pattern}`,
      );
    }
  }
});

test("merge-card check requires native review SHA to match the current PR head", () => {
  const text = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "merge-card-check.yml"),
    "utf8",
  );

  assert.match(
    text,
    /pull_request\.head\.sha/,
    "merge-card check must read the current PR head SHA",
  );
  assert.match(
    text,
    /reviewedSha\.toLowerCase\(\) !== expectedHeadSha\.toLowerCase\(\)/,
    "merge-card check must reject stale native review SHAs",
  );
});

test("merge-card check requires affirmative no-unresolved P0/P1 wording", () => {
  const text = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "merge-card-check.yml"),
    "utf8",
  );

  assert.match(
    text,
    /no unresolved current-head P0\\\/P1/,
    "merge-card check must require affirmative no-unresolved current-head P0/P1 evidence",
  );
});
