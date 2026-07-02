# Atlas Conversation Acceptance-Test Suite

## What this is

The feel-spec for Atlas's conversational behavior. These are acceptance tests for how Atlas should *sound and behave*, not implementation tasks. The engine decides; Atlas voices it — every workout and coaching decision in these scripts is illustrative of engine output, never of the LLM inventing numbers.

## The two libraries

- [`pressure-scenarios.md`](pressure-scenarios.md) — **P-001 to P-025.** Edge cases and hard moments: safety events (pain, red flags, illness, concerning weight-loss talk), gym chaos (equipment unavailable, time crunch), user pushback (deload resistance, max-out requests, program challenges), conflicting signals, and motivation dips.
- [`everyday-sessions.md`](everyday-sessions.md) — **N-001 to N-040.** Ordinary sessions — the 90% case. These define Atlas's personality: brevity on normal days, energy matching, scarce and specific praise, one-question maximum, the always-answerable progression clock, zero guilt, utility over thoroughness.

## ID rules (stable addresses)

IDs are permanent. Never renumber. New scenarios are appended with the next number. Future categories get new prefixes (reserved: S- safety-dedicated, GC- gym chaos, L- lifestyle, E- education, R- long-term relationship, F- freestyle) — P- and N- are already in use.

## How to use this suite

Any future work touching **coach voice, logging, plan flow, session finish, substitutions, safety behavior, or conversation UX** must consult the relevant scenarios before and after the change. The review question is: *"Run Atlas against P-0xx / N-0xx — does it still feel like the coach we designed?"* A change that makes a scenario read worse is a regression even if all technical checks pass.

## Origin note

Derived from Dale's original conversation-first mock session and expanded into a scenario library (June–July 2026). The original mock remains the seed document.
