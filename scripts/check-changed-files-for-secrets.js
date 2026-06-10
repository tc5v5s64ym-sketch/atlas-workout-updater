const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const range = process.argv[2] || "origin/main...HEAD";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function changedFiles() {
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
];

function isAllowedExampleValue(line, file) {
  if (file !== ".env.example") return false;
  const value = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  return value === "" || value === "replace_me" || value === "example";
}

const failures = [];

for (const file of changedFiles()) {
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

if (failures.length) {
  for (const failure of failures) {
    console.error(`${failure.file}: possible secret matched ${failure.rule}`);
  }
  process.exit(1);
}

console.log("Changed-file secret scan OK");
