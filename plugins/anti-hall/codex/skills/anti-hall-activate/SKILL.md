---
name: anti-hall-activate
description: Idempotent Codex setup for anti-hall. Use when the user asks to activate anti-hall, set it up for Codex, or install the Codex hooks.
---

# anti-hall activate for Codex

## When to use

Idempotent Codex setup for anti-hall. Use when the user asks to activate anti-hall, set it up for Codex, or install the Codex hooks.

Activation for Codex installs the supported Codex hook subset and writes an advisory sentinel. It does not touch Claude Code settings.

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — that
variable is only set for plugin-bundled hook commands (see
`https://github.com/talas9/anti-hall/blob/main/docs/KB-codex-platform-hooks-plugins.md`). Codex does show you this skill's own
file path when it selects the skill ("Codex starts with each skill's name,
description, and file path" — official Codex Skills doc). Resolve the plugin
root from that path before running anything below:

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -d "$ANTI_HALL_ROOT/.codex-plugin" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

1. Install project-local Codex hooks:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js"
```

2. For global Codex hooks instead:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js" --global
```

3. Verify:

```bash
node "$ANTI_HALL_ROOT/hooks/doctor.js"
codex features list
test -f .codex/hooks.json && sed -n '1,220p' .codex/hooks.json
```

4. Write sentinel:

```bash
node "$ANTI_HALL_ROOT/codex/scripts/write-activation-sentinel.js"
```

Codex limitations after activation:

- shell guards are hard hooks
- session/prompt/stop nudges are hooks
- edit-time `edit-guard`, `api-guard` and `ship-it-guard` (existence gate) are hard hooks on `apply_patch` edits (Codex 0.134+) and on shell writes whose target is literal in the command; a target in a variable, a glob or a script is not seen
- subagent lifecycle hooks are not available in Codex today

Use `anti-hall-doctor` to inspect the active state.
