const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function changedFiles(range) {
  let output = "";
  try {
    output = git(["diff", "--name-only", "--diff-filter=ACMR", range]);
  } catch {
    output = git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD~1...HEAD"]);
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => fs.existsSync(file) && !file.endsWith(".env"));
}

function isAllowedExampleValue(line, file) {
  if (file !== ".env.example") return false;
  const value = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  return value === "" || value === "replace_me" || value === "example";
}

const rules = [
  {
    name: "openai-key-assignment",
    test: (text) => /OPENAI_API_KEY\s*=\s*sk[-_A-Za-z0-9]{10,}/.test(text),
  },
  {
    name: "private-key-block",
    test: (text) => /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/.test(text),
  },
  {
    name: "atlas-api-key-assignment",
    test: (text, file) => {
      const matches = text.match(/^ATLAS_API_KEY\s*=\s*(.+)$/gm) || [];
      return matches.some((line) => !isAllowedExampleValue(line, file));
    },
  },
  {
    name: "google-private-key-assignment",
    test: (text, file) => {
      const matches = text.match(/^GOOGLE_PRIVATE_KEY\s*=\s*(.+)$/gm) || [];
      return matches.some((line) => !isAllowedExampleValue(line, file));
    },
  },
  {
    name: "gemini-api-key-assignment",
    test: (text, file) => {
      const matches = text.match(/^GEMINI_API_KEY\s*=\s*(.+)$/gm) || [];
      return matches.some((line) => !isAllowedExampleValue(line, file));
    },
  },
  {
    // Google AI / Gemini API keys are "AIza" + 35 url-safe chars. Catch the raw
    // token anywhere, so a leaked key is flagged even under a different var name.
    name: "google-ai-api-key",
    test: (text) => /AIza[0-9A-Za-z_-]{35}/.test(text),
  },
  {
    // Anthropic OAuth token (used as CLAUDE_CODE_OAUTH_TOKEN in the Claude Code
    // Review, Codex Decision Desk, and Atlas Decision Desk workflows). Prefixed
    // "sk-ant-oat" + a version segment + a long token body; catch it raw, under
    // any var name, the same way the Gemini key rule does.
    name: "anthropic-oauth-token",
    test: (text) => /sk-ant-oat[0-9]*-[A-Za-z0-9_-]{20,}/.test(text),
  },
];

function scan(files) {
  const failures = [];
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (rule.test(text, file)) {
        failures.push({ file, rule: rule.name });
      }
    }
  }
  return failures;
}

function run(range = "origin/main...HEAD") {
  const failures = scan(changedFiles(range));
  if (failures.length) {
    for (const failure of failures) {
      console.error(`${failure.file}: possible secret matched ${failure.rule}`);
    }
    process.exit(1);
  }
  console.log("Changed-file secret scan OK");
}

module.exports = { rules, isAllowedExampleValue, scan };

if (require.main === module) {
  run(process.argv[2]);
}
