---
name: anti-hall-activate
description: Idempotent Codex setup for anti-hall. Use when the user asks to activate anti-hall, set it up for Codex, or install the Codex hooks.
---

# anti-hall activate for Codex

Activation for Codex installs the supported Codex hook subset and writes an advisory sentinel. It does not touch Claude Code settings.

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
node -e "const fs=require('fs'),os=require('os'),path=require('path');const d=path.join(os.homedir(),'.anti-hall');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'codex-activated.json'),JSON.stringify({activatedAt:new Date().toISOString(),scope:process.cwd()},null,2)+'\n')"
```

Codex limitations after activation:

- shell guards are hard hooks
- session/prompt/stop nudges are hooks
- edit-time `api-guard` and `ship-it-guard` are not hard hooks in Codex today
- subagent lifecycle hooks are not available in Codex today

Use `anti-hall-doctor` to inspect the active state.
