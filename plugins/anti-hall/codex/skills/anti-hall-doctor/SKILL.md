---
name: anti-hall-doctor
description: Check anti-hall's Codex installation and runtime posture. Use when the user asks whether anti-hall is active in Codex, whether hooks are installed, or why a guard did or did not fire.
---

# anti-hall doctor for Codex

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

Run the existing doctor first:

```bash
node "$ANTI_HALL_ROOT/hooks/doctor.js"
```

Then verify Codex-specific surfaces:

```bash
codex features list
test -f .codex/hooks.json && sed -n '1,220p' .codex/hooks.json
test -f ~/.codex/config.toml && grep -n "hooks\\|codex_hooks" ~/.codex/config.toml
```

Interpretation:

- `SessionStart`, `UserPromptSubmit`, `PreToolUse`, and `Stop` anti-hall entries in `.codex/hooks.json` mean the Codex hook subset is installed.
- `[features].hooks = true` in Codex config means the current Codex runtime should load hooks.
- Missing edit-time `api-guard` / `ship-it-guard` hard blocks are expected in Codex; current Codex hook runtime does not provide Claude-equivalent `PreToolUse` for edits.
- Missing subagent lifecycle hooks are expected; Codex has no direct `SubagentStart` / `TaskCreated` / `TaskCompleted` equivalents.

If hooks are missing, install them:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js"
```

For global install:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js" --global
```
