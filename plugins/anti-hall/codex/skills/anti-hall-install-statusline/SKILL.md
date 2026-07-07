---
name: anti-hall-install-statusline
description: Explain and install anti-hall statusline support where available. Use when the user asks for the anti-hall statusline in Codex or wants OMC/anti-hall status visibility.
---

# anti-hall statusline for Codex

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

The existing anti-hall statusline installer targets Claude Code `statusLine` settings:

```bash
node "$ANTI_HALL_ROOT/statusline/install-statusline.js" --help
```

Codex/OMX `[tui].status_line` uses documented built-in footer item IDs, not a command-backed renderer. Do **not** append an arbitrary `anti-hall-version` item unless Codex documents custom item support. For Codex, use these supported pieces:

- phase/progress state writer:

```bash
node "$ANTI_HALL_ROOT/statusline/phase.js"
```

- statusline renderer smoke check:

```bash
node "$ANTI_HALL_ROOT/statusline/statusline.js"
```

- OMX HUD/statusline built-ins through `omx hud` and `[tui].status_line`
- OMC-compatible consolidated state is still read by anti-hall helpers when present.

Do not write Claude `.claude/settings.json` when the user asked for Codex-only setup. If the user explicitly wants Claude statusline too, use the original Claude skill or script.
