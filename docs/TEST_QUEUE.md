# Atlas — Owner Live-Validation Queue

This file is the **owner-only** queue for live tests that cannot be automated — tests that require a real device, a real gym session, real credentials, or first-use confirmation of a gate that only fires once.

Each card is filed by Claude Code (or CODEX Review) when a feature ships but needs a live human confirmation before it is considered fully closed. The owner marks PASS or FAIL and notes any follow-up.

---

## Card format

| Field | Description |
|---|---|
| **Test ID** | Sequential identifier (LT-001, LT-002, …) |
| **Related PR / feature** | PR number and short name |
| **Shell / app version expected** | The `ATLAS_SHELL_BUILD` / server version that must be live before testing |
| **Steps** | Numbered steps the owner performs |
| **Expected result** | What "PASS" looks like |
| **Screenshot** | Paste a screenshot here when done (or note "N/A") |
| **Owner result** | PASS / FAIL — (fill in after testing) |
| **Follow-up if FAIL** | What to file / fix if the test fails |

---

## Pending

### LT-001 — Decision Desk author-association gate

| Field | Value |
|---|---|
| **Test ID** | LT-001 |
| **Related PR / feature** | Decision Desk author-association gate (`.github/workflows/codex-decision-desk.yml`) |
| **Shell / app version expected** | Any version with the Codex Decision Desk workflow active |
| **Steps** | 1. Open (or create) a PR that contains a `## 🧭 Codex Decision Request` comment posted by the Claude Code builder identity. 2. Observe whether the `codex-decision-desk` workflow triggers and responds. 3. Note the `author_association` value logged in the workflow run (visible in Actions → the triggered run). |
| **Expected result** | The gate correctly allows the builder identity (`OWNER`, `MEMBER`, or `COLLABORATOR` association) and the desk fires and returns a verdict. If the builder posts as `NONE`/`CONTRIBUTOR`, the desk is silently inert (fail-closed, never an implicit "yes") — in that case the fix is a precise login allowlist (do NOT loosen to `NONE` broadly). |
| **Screenshot** | — |
| **Owner result** | PASS / FAIL — |
| **Follow-up if FAIL** | If gate silently inert: add the builder bot's exact GitHub login to the `if` condition allowlist in the workflow. File a PR (workflow-only change, `[infrastructure]`). |

---

## Completed

*(none yet)*
