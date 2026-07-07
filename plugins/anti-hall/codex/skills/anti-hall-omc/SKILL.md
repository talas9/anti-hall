---
name: anti-hall-omc
description: Inspect or integrate optional oh-my-claudecode/OMC state with anti-hall in Codex. Use when the user asks whether OMC is installed for Codex or why anti-hall did not install OMC.
---

# anti-hall OMC integration for Codex

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

OMC is a recommended optional companion, not an anti-hall dependency.

Anti-hall uses OMC when present for:

- limit-conserve auto mode
- OMC autonomous-loop deference in task guards
- consolidated status/progress state where available

Check local OMC state:

```bash
find .omc ~/.omc -maxdepth 3 -type f 2>/dev/null | head -80
grep -RIn "oh-my-claudecode@omc\\|enabledPlugins" .omc ~/.codex ~/.agents 2>/dev/null | head -80
```

Check anti-hall's OMC helper:

```bash
node --check "$ANTI_HALL_ROOT/hooks/omc-detect.js"
```

Do not install OMC automatically from anti-hall activation. It changes separate global/project state and should be explicit.

If the user explicitly asks to install OMC for Codex, first verify the current official install path from the OMC repository/docs, then install using that documented path. Do not infer a command from stale Claude plugin docs.
