---
name: anti-hall-ship-it
description: Codex-native ship-it workflow. Use to plan, implement, verify, and harden a change with rigor scaled to blast radius.
---

# anti-hall ship-it for Codex

This is the Codex-native equivalent of the Claude `ship-it` workflow. Do not run `ship-it.workflow.js`; Codex does not expose the Claude Workflow runtime.

## 1. Size the change

| Tier | Trigger | Path |
| --- | --- | --- |
| S | one file, clear fix, no hard-risk trigger | implement, verify, report |
| M | 2-5 files, modest design choices, no hard-risk trigger | short plan, implement, verify |
| L | more than 5 files, multi-phase, or any hard-risk trigger | durable plan, deadly-loop plan review, phased build, per-phase verification |

Hard-risk triggers: auth/security, schema/migration, production data, shell scripts, CI/workflow YAML, cross-repo work, LLM prompts.

## 2. Plan

For L work, write `PLAN.md` in `.planning/` if it exists, otherwise repo root. Include:

- intent
- decisions and trade-offs
- blast radius
- phases with exact files, read-first paths, steps, edge cases, and acceptance checks
- progress checklist
- owner/manual actions

## 3. Harden the plan

Run `anti-hall-deadly-loop` against the plan before code for L work. Debate/validation uses `gpt-5.5`.

## 4. Build and verify

Model routing:

- implementation: `gpt-5.4`
- planning/validation/debate: `gpt-5.5`
- mechanical command execution: `gpt-5.4-mini` or `gpt-5.3-codex-spark`

For each phase:

1. Read the relevant plan section.
2. Make only scoped edits.
3. Run the phase acceptance check.
4. Record evidence in the plan progress section.
5. For risky changes, run `anti-hall-deadly-loop` after the phase.

Claim done only after fresh verification output from this turn.
