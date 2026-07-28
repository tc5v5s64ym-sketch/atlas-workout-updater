# Atlas Controlled Technical Writing

This is the single canonical writing standard for text that an Atlas agent writes. Every implementation agent — Claude Code or Codex — follows it.

## Honest naming

This standard is **controlled technical writing inspired by ASD-STE100**. ASD-STE100 (ASD Simplified Technical English) is a published specification that restricts vocabulary and sentence structure in technical documentation.

Atlas does **not** claim formal ASD-STE100 compliance. This repository does not hold the complete controlled dictionary, and it runs no compliance process. Do not describe Atlas text as ASD-STE100 compliant, certified, or conformant in a document, a PR, a commit message, or a report.

## Where this standard applies

Apply it to text an agent writes for a human or for another agent:

- plans and card write-ups;
- reviews and advisory findings;
- failure reports and investigation notes;
- handoffs, including the mid-PR handoff in [`docs/BUILDER_PORTABILITY.md`](./BUILDER_PORTABILITY.md);
- implementation summaries, PR bodies, and the Atlas Merge Card;
- commit messages;
- documentation, comments, and log text that a person reads.

## Where this standard does not apply

- Atlas's user-facing coaching voice. `docs/COACHING_NOTE_VOICE.md`, `docs/COACH_VOICE_VALIDATION.md`, and `docs/ATLAS_VOICE_RATIFICATION_V1.md` govern that voice.
- Quoted evidence. Reproduce log lines, error text, test output, and owner instructions exactly, even when they break these rules.

This document is a writing standard. It selects no work, and it changes no product, safety, branch, merge, or sequencing rule. [`docs/ATLAS_V1_EXECUTION_PLAN.md`](./ATLAS_V1_EXECUTION_PLAN.md) remains the sole active work-selection authority.

## The rules

1. Use one term for one concept. When the code calls it a `turn_id`, call it a `turn_id` in every sentence. Do not switch to a synonym for variety.
2. Use active voice. Write "the guard failed the build", not "the build was failed by the guard".
3. Put one action in each instruction. Split a compound instruction into separate steps.
4. Keep sentences short when practical. Aim for about 20 words. Split a long sentence instead of adding another clause.
5. Put conditions before actions. Write "If the check is red, stop and report", not "Stop and report if the check is red".
6. Preserve exact technical names. Copy them; do not reword, shorten, or pretty-print them. This covers:
   - file paths;
   - functions;
   - API routes;
   - environment variables;
   - flags;
   - issue and PR numbers;
   - test names;
   - log markers;
   - commit SHAs.
7. Define an uncommon technical term when you first use it. Give the definition once, then reuse the same term.
8. Avoid idioms, metaphors, promotional language, and filler. Do not write "bulletproof", "rock solid", "under the hood", or "as you know".
9. Avoid vague instructions. Each of these hides the actual work:
   - make it better;
   - clean it up;
   - harden it;
   - fix everything;
   - use best practices.

   Name the file, the behaviour, and the wanted result instead.
10. Separate these four kinds of statement, and label which one you are making:
    - observed fact;
    - supported conclusion;
    - unverified hypothesis;
    - proposed action.
11. Report a failure in this order:
    1. expected behaviour;
    2. observed behaviour;
    3. evidence;
    4. exact failure boundary;
    5. next permitted action.
12. State what the evidence does not prove. Name the gap; do not leave it implied.
13. Do not start additional work unless the task authorizes it. Report the discovery, and file it where the campaign rules require.
14. Use numbered steps when order matters.
15. Use bullets only when order does not matter.
16. Do not hide uncertainty behind confident wording. If you did not verify a claim, say that you did not verify it.
17. Do not paraphrase exact evidence into a stronger claim. A timeout is a timeout; it is not proof of a deadlock.

## Example

Bad:

> "Atlas seems to get stuck somewhere after accepting the plan, so we should probably harden the API flow."

Good:

> "POST /api/session-plans/accept did not settle. The client waited indefinitely. Add a bounded timeout at this acceptance boundary."

The bad version hides the boundary behind "somewhere", states no evidence, and proposes vague work. The good version names the route, states the observed behaviour, and proposes one bounded action.

## Reporting template

Reuse this template for a failure report, an investigation note, or a handoff. Delete a field only when it does not apply, and say why.

The template lists the fields to fill. It does not set the order you present them in. When you report a failure, order the five failure fields as rule 11 requires: expected behaviour, observed behaviour, evidence, exact failure boundary, next permitted action. Keep each field name exactly as written below.

```text
Observed fact:
Supported conclusion:
Unverified hypothesis:
Expected behaviour:
Observed behaviour:
Evidence:
Exact failure boundary:
Next permitted action:
Not proved by this evidence:
```

## How both agents receive this standard

- Claude Code reads [`CLAUDE.md`](../CLAUDE.md), which requires this document.
- Codex reads [`AGENTS.md`](../AGENTS.md) and [`CODEX.md`](../CODEX.md). Both adapters point here and route through `CLAUDE.md`.

The rules live in this file only. Another document may point to this file; it must not restate the rules.
