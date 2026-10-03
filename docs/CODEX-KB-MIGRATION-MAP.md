# Codex KB migration map

**Date:** 2026-06-30
**Purpose:** classify the existing anti-hall KB set and decide which Claude-specific docs need Codex equivalents before the Codex port is released.

## Classification

| Existing doc | Classification | Codex equivalent decision |
| --- | --- | --- |
| `docs/KB-claude-codex.md` | Claude Code hook/plugin/prompting backbone with some Codex content | **Create:** `docs/KB-codex-platform-hooks-plugins.md` |
| `docs/KB-claude-workflow-orchestration.md` | Claude Dynamic Workflows / Workflow-tool specific | **Create:** `docs/KB-codex-workflow-orchestration.md` |
| `docs/opus-4-8-swarm.md` | Claude/Opus multi-agent and managed-agent snapshot | **Covered by:** `docs/KB-codex-workflow-orchestration.md` plus model docs |
| `docs/KB-omc.md` | oh-my-claudecode specific | **Create:** `docs/KB-omx.md` |
| `docs/KB-fable-5.md`, `docs/opus-4-8-features.md` | Claude model-specific | **Create later if needed:** Codex model feature KB; current routing covered by `docs/KB-codex-vs-opus-coding.md` and official Codex model docs |
| `docs/KB-flutter-claude-debug.md` | Claude + Flutter debug-loop specific | **Create later if feature is ported:** Codex Flutter/debug UI KB using Codex IDE/app/browser/computer-use sources |
| `docs/TASK-WORK.md`, `docs/TASKLIST-GUARD.md` | Claude task tooling + anti-hall guard design | **Partially create later:** Codex task/progress discipline KB if Codex task hooks diverge materially; current Codex hooks/subagents covered in platform/workflow KBs |
| `docs/CONTEXT-PRESERVATION-KB.md` | Agent-context discipline, broadly model-agnostic | **No clone needed:** cite from Codex workflow KB and update only for Codex-specific context surfaces |
| `docs/KB-cmux.md` | Terminal workspace for multiple agent CLIs | **No clone needed:** already covers Claude, Codex, Gemini CLI |
| `docs/KB-codex-vs-opus-coding.md` | Cross-model comparison already includes Codex | **No clone needed:** keep as comparison KB |
| `docs/keynote-prompting-claude.md`, `docs/keynote-transcript.md` | Anthropic prompting talks | **No one-for-one needed:** use as prompting background, not Codex product facts |
| `docs/gsd-distilled.md`, `docs/superpowers-planning.md` | Planning/workflow pattern distillations | **No clone needed:** apply patterns through Codex feature-launch/workflow KBs |
| `docs/E2E-TESTING.md`, audit reports, dated plans | Repo/test/history artifacts | **No clone needed:** not product platform KBs |

## Immediate KB deliverables

1. `KB-codex-platform-hooks-plugins.md` — Codex equivalents for hooks, plugins, skills, MCP, AGENTS.md, config, permissions, marketplace structure.
2. `KB-codex-workflow-orchestration.md` — Codex equivalents for Workflow/swarm: subagents, worktrees, cloud tasks, app/CLI workflows, noninteractive/SDK/GitHub Action, OMX.
3. `KB-omx.md` — Codex equivalent for OMC.

## Acceptance rule

Each new Codex KB must include at least **10 sources**, with at least **2 official OpenAI sources**. Claims about anti-hall port alignment must cite either current repo files or the new KBs.
