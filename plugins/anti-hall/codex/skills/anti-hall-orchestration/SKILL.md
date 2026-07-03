---
name: anti-hall-orchestration
description: Codex-native orchestration discipline for multi-step or parallel work. Use when the task has several independent subtasks, needs review/verification, or risks bloating the main context.
---

# anti-hall orchestration for Codex

Keep the main agent as coordinator:

- Track every user request and interruption as a task.
- Prioritize highest-risk/highest-priority work first.
- Delegate noisy or long-running command execution to subagents where available.
- Keep subagent outputs compact: `{claim, evidence, verdict, blockers, next}` for substantial findings.
- Verify delegated claims independently before marking work complete.
- Do not end with open, silently dropped tasks.

Codex model distribution:

| Task shape | Model |
| --- | --- |
| Planning, ambiguous requirements, validation, debate | `gpt-5.5` |
| Implementation from an accepted plan | `gpt-5.4` |
| Mechanical command runner / cheap lookup | `gpt-5.4-mini` (default) — `gpt-5.3-codex-spark` is a distinct, faster/less-capable model, ChatGPT Pro only |

Codex does not have Claude Workflow JS. For 3+ parallel/nested work units, use a flat Codex orchestration plan: dispatch independent agents where available, write progress to a durable file, then synthesize and verify.
