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
| Planning, ambiguous requirements, validation, debate | `gpt-5.6-sol` |
| Implementation from an accepted plan | `gpt-5.6-terra` |
| Mechanical command runner / cheap lookup | `gpt-5.4-mini` (default; `gpt-5.6-luna` available when 5.6-era capability/cutoff matters) — `gpt-5.3-codex-spark` is a distinct, faster/less-capable model, ChatGPT Pro only |

Codex does not have Claude Workflow JS. For 3+ parallel/nested work units, use a flat Codex orchestration plan: dispatch independent agents where available, write progress to a durable file, then synthesize and verify.

## Inside DevSwarm: the workspace is the TOP fan-out tier

If this session is a DevSwarm **Primary** (`DEVSWARM_REPO_ID` set, `DEVSWARM_SOURCE_BRANCH` empty), a subagent is **not** your top decomposition primitive — a **child workspace** is. The shared hooks that inject this doctrine (`verify-first-full.js`, `verify-first.js`, `task-tracker.js`) and the shared `command-guard.js` heavy-command redirect are the SAME files Codex registers in `codex/hooks/hooks.json`, so this fires for a Codex Primary too.

| Work | Tier |
| --- | --- |
| A workspace-scale **matter** — a feature, a fix, a deploy: multi-step, wants its own branch + worktree, its own agent session and token budget, its own review/merge | **Child workspace**: `node scripts/devswarm.js spawn <branch> -p "<brief>"` (guard-exempt — run it inline) |
| A read-only lookup, a single command, a scoped investigation, a review/verify pass, a mechanical transform | Subagent / cheap model, as above |

They compose, they do not compete: the Primary splits into workspace-sized chunks; each child then fans out internally (`omx team`/workers on Codex, subagents on Claude) and never spawns grandchildren. A CHILD workspace spawns no workspaces. Heuristic source: `docs/KB-devswarm-hivecontrol.md` §8.1–8.2. **Caveat:** `devswarm.js spawn` is agent-agnostic plain Node and invokable from Codex, but the mesh CLI is not yet formally promoted for Codex/OMX (see `anti-hall-devswarm`, "Codex mesh support") — the DOCTRINE and the guard redirect nevertheless fire for a Codex Primary today, because those hooks are shared.
