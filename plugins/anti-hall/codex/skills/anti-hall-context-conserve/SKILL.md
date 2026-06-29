---
name: anti-hall-context-conserve
description: Codex-native context and usage conservation mode. Use when the user asks for context conservative mode, limit conservation, cheap-model routing, or reducing context/token burn while keeping work moving.
---

# anti-hall context-conserve for Codex

This is the Codex port of anti-hall limit/context conservation. It combines hook nudges, model routing, and output hygiene; it does not depend on Claude Workflow JS.

## Activation

Project-local hooks are installed by `anti-hall-activate`:

```bash
node plugins/anti-hall/codex/install-codex.js
```

The installer registers `hooks/limit-conserve-inject.js` on `UserPromptSubmit` so conservation instructions are injected when active.

Manual controls:

```bash
export ANTIHALL_LIMIT_CONSERVE=on    # force conservation
export ANTIHALL_LIMIT_CONSERVE=off   # disable conservation
export ANTIHALL_LIMIT_THRESHOLD=85   # default threshold
```

Status check:

```bash
node -e "const {isConserving}=require('./plugins/anti-hall/hooks/limit-conserve.js'); console.log(JSON.stringify(isConserving(), null, 2))"
```

## Codex routing policy

When conservation is active:

- keep the coordinator concise; do not paste broad command output into the main thread
- use `explore` / `gpt-5.3-codex-spark` for codebase lookup
- use `gpt-5.4-mini` or `gpt-5.3-codex-spark` for mechanical command running
- use `gpt-5.4` for settled implementation
- reserve `gpt-5.5` for planning, root-cause, validation, code review, and debate gates
- if a model is unavailable or rate-limited, record the limitation and choose the nearest safe fallback; do not retry-loop

## Context hygiene rules

- Query graphify before broad repo search when `graphify-out/` exists.
- Delegate noisy tests/builds/checks and require compact summaries.
- Report only changed files, validation evidence, and remaining blockers.
- Do not claim quantitative token savings without a measured benchmark.

## What is not hard-enforced in Codex

Codex does not expose Claude's Agent/Task `PreToolUse` hook surface for hard model-routing blocks. The Codex port enforces this via skill instructions, AGENTS.md, and `UserPromptSubmit` nudges instead of pretending it can block every spawn.
