---
name: anti-hall-install-statusline
description: Retired anti-hall statusline installer guidance. Use for "install the statusline" or OMC/anti-hall status.
---

# anti-hall statusline for Codex

## When to use

Explain that the anti-hall statusline has been retired. Use when the user asks for the anti-hall statusline in Codex or wants OMC/anti-hall status visibility.

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

The anti-hall statusline installer is now a no-op and must not be used to set up
Codex or Claude. It prints a retirement notice and writes no settings. The
uninstaller remains available to clean up old Claude `statusLine` installs.

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

Do not write Claude `.claude/settings.json` for statusline setup. If the user explicitly wants cleanup of an old Claude statusline, run the uninstall path only.
