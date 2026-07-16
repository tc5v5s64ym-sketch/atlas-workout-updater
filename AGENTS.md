# Atlas Agent Compatibility Pointer

The canonical implementation-agent brief is [`CLAUDE.md`](CLAUDE.md). The sole active campaign is [`docs/ATLAS_V1_EXECUTION_PLAN.md`](docs/ATLAS_V1_EXECUTION_PLAN.md).

Read those two files first. This file exists only for tools that look for `AGENTS.md`; it defines no independent role, review, branch, merge, or sequencing rules.

To check Atlas at a glance — where the campaign is, whether prod is healthy, and whether the latest write+undo held — run `npm run atlas:status` (`-- --json` for the machine schema) or read the public, redacted `GET /.well-known/atlas-status.json`. No Sheet ID, tab name, or session id is required. Contract: [`docs/ATLAS_OPERATIONS_CONTRACT.md`](docs/ATLAS_OPERATIONS_CONTRACT.md).

Deterministic GitHub checks are hard gates. Codex comments are advisory. Claude holds standing authority to merge the exact passing head for authorized routine work; owner approval remains required only for the reserved safety/product categories defined in `CLAUDE.md` and `docs/OWNER_CHECKIN_RULES.md`.
