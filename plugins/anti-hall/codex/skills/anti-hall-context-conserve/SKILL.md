---
name: anti-hall-context-conserve
description: Codex-native context and usage conservation mode. Use when the user asks for context conservative mode, limit conservation, cheap-model routing, or reducing context/token burn while keeping work moving.
---

# anti-hall context-conserve for Codex

This is the Codex port of anti-hall limit/context conservation. It combines hook nudges, model routing, and output hygiene; it does not depend on Claude Workflow JS.

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — that
variable is only set for plugin-bundled hook commands (see
`docs/KB-codex-platform-hooks-plugins.md`). Codex does show you this skill's own
file path when it selects the skill ("Codex starts with each skill's name,
description, and file path" — official Codex Skills doc). Resolve the plugin
root from that path before running anything below:

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

## Activation

Project-local hooks are installed by `anti-hall-activate`:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js"
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
node -e "const {isConserving}=require('$ANTI_HALL_ROOT/hooks/limit-conserve.js'); console.log(JSON.stringify(isConserving(), null, 2))"
```

## Main-model downshift (flagship preservation)

When conservation is active and the **main/coordinator** agent is on `gpt-5.6-sol`, switch it to `gpt-5.6-terra` **(1M-context variant only)** to preserve the flagship weekly bucket.

- **Target**: `gpt-5.6-terra` at 1M context — same context window, lower cost.
- **NEVER** downshift to `gpt-5.4-mini` (only 400k context; context loss is unacceptable).
- Keep `gpt-5.6-sol` for delegated hard-reasoning subagents and on-demand escalation.
- Codex cannot self-switch its own model — **surface this recommendation to the user** or let OMX/orchestration layer set it.
- **Long-context cost premium:** both `gpt-5.6-terra` and `gpt-5.6-sol` incur a confirmed 2× input / 1.5×
  output multiplier once a request exceeds ~272K input tokens — this applies regardless of which
  of the two you're on. For a very-large-context task (a big repo dump, a huge diff), consider
  capping scope or routing to a Claude model instead (no equivalent premium up to 1M there). See
  `docs/KB-token-usage-models.md` §2/§7.

## Codex routing policy

When conservation is active:

- keep the coordinator concise; do not paste broad command output into the main thread
- use `explore` / `gpt-5.4-mini` for codebase lookup (`gpt-5.6-luna` when 5.6-era capability/cutoff matters; `gpt-5.3-codex-spark` is a distinct, faster/less-capable model, ChatGPT Pro only)
- use `gpt-5.4-mini` (default) for mechanical command running
- use `gpt-5.6-terra` for settled implementation
- reserve `gpt-5.6-sol` for planning, root-cause, validation, code review, and debate gates
- if a model is unavailable or rate-limited, record the limitation and choose the nearest safe fallback; do not retry-loop

## Context hygiene rules

- Query graphify before broad repo search when `graphify-out/` exists.
- Delegate noisy tests/builds/checks and require compact summaries.
- Report only changed files, validation evidence, and remaining blockers.
- Do not claim quantitative token savings without a measured benchmark.

## What is not hard-enforced in Codex

Codex does not expose Claude's Agent/Task `PreToolUse` hook surface for hard model-routing blocks. The Codex port enforces this via skill instructions, AGENTS.md, and `UserPromptSubmit` nudges instead of pretending it can block every spawn.
