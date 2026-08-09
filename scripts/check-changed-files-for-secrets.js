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

  // ── Supabase (added by PR S2, before any credential is configured) ──────────
  //
  // docs/SUPABASE_HOT_PATH_MIGRATION.md §8.4. Under §8.1 the credentials that
  // MATTER are Postgres connection strings and role passwords — Atlas uses no
  // service-role key and no anon key. Both are matched anyway, so a later
  // reintroduction of the Data API cannot slip a key past the scanner.
  //
  // Every rule below matches AUTHENTICATION MATERIAL. None matches an
  // identifier. That boundary is the owner's 2026-08-09 ruling, and it is the
  // one answer this scanner gives.
  {
    // A Postgres URI carrying an inline password. Catches the Supavisor
    // session-mode strings this design uses under ANY variable name, and any
    // other user:password@host Postgres URI. A password-less URI (the shape
    // .env.example and every doc uses) does not match.
    //
    // A LOOPBACK host is exempt, and that is not a softening: a credential for
    // 127.0.0.1, ::1 or localhost cannot be a production credential, and the
    // repository legitimately carries several — the CI Postgres service
    // container, and the deliberately-unreachable endpoints the shadow-lane
    // proofs point at to show a Save survives a dead database. Exempting by
    // HOST rather than by file keeps the rule mechanical: no file gets a
    // blanket pass, and a real hosted credential in any of those files still
    // fails.
    name: "postgres-connection-string-with-password",
    test: (text) =>
      /postgres(?:ql)?:\/\/[A-Za-z0-9._%+-]+:[^\s:@/'"]+@(?!127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/.test(text),
  },
  {
    // Any assignment of the four scoped-role connection strings to a real value.
    // The example file may carry a blank or `replace_me`.
    name: "supabase-role-url-assignment",
    test: (text, file) => {
      const matches = text.match(/^ATLAS_SUPABASE_(?:APP|READONLY|MIGRATE|REBUILD)_URL\s*=\s*(.+)$/gm) || [];
      return matches.some((line) => !isAllowedExampleValue(line, file));
    },
  },
  // NOTE: there is deliberately NO project-reference rule. The owner ruled on
  // 2026-08-09 that a Supabase PROJECT REFERENCE is a non-secret project
  // IDENTIFIER — not a password, key, token, or authorization mechanism — so a
  // bare reference or a reference-bearing hostname is not a finding, and no
  // detector or masking mechanism replaces the rule that was removed (§8.4).
  // A reference that appears WITH a credential still fails, on the credential
  // rules below: `postgres-connection-string-with-password` matches the whole
  // hosted URI regardless of which host it names. The identifier is free; the
  // thing that authenticates is not.
  {
    // Service-role and anon JWTs. Atlas uses neither; matching them is what
    // keeps that true.
    name: "supabase-jwt-key",
    test: (text) => /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text),
  },
  {
    // The newer publishable/secret key format (sb_publishable_… / sb_secret_…).
    name: "supabase-api-key",
    test: (text) => /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{20,}\b/.test(text),
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
