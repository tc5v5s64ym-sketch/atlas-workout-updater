# Atlas Agent Compatibility Pointer

The canonical implementation-agent brief for Atlas is [`CLAUDE.md`](CLAUDE.md).
Read it first. This file exists only for tools and integrations that still look
for `AGENTS.md`; it defines no independent role, review, branch, or merge rules
and does not override `CLAUDE.md`.

Everything an agent needs — roles, the review and merge model (deterministic
hard gates, the clean-context cold review, the risk-triggered ChatGPT Atlas
Contract Review), owner-reserved categories, branch policy (`claude/<concern>`
and `agent/<concern>`), the current-state verification gate, the
preview → approve → write trust loop, the Sheet schema contracts, and the
deterministic-engine / LLM boundary — lives in `CLAUDE.md` and the docs it
references (`docs/AGENT_WORKFLOW.md`, `docs/AUTOMATION_PROTOCOL.md`,
`docs/OWNER_CHECKIN_RULES.md`, `docs/DECISION_ROUTING.md`,
`docs/INVARIANTS.md`, `docs/CONSTITUTION.md`).
