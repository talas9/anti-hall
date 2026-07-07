---
name: anti-hall-update
description: Check or update anti-hall from the local marketplace clone. Use when the user asks to update anti-hall, check whether anti-hall is current, or refresh the Codex port files.
---

# anti-hall update for Codex

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

Use the existing pure-Node update helper:

```bash
node "$ANTI_HALL_ROOT/skills/update/scripts/update.js" --check
node "$ANTI_HALL_ROOT/skills/update/scripts/update.js"
```

For Codex, also re-run the Codex hook installer after a successful update:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js"
```

or for global Codex hooks:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js" --global
```

Do not force-pull, rebase, or delete plugin cache directories. If the update helper reports a dirty tree, diverged branch, offline state, or missing marketplace clone, surface that result and stop.

After updating, restart Codex or start a fresh session if plugin/skill discovery does not reflect the new files immediately.
