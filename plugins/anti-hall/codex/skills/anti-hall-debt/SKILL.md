---
name: anti-hall-debt
description: Register or audit deliberate technical debt markers in Codex. Use when the user asks to track debt, audit shortcuts, or list anti-hall debt markers.
---

# anti-hall debt for Codex

## When to use

Register or audit deliberate technical debt markers in Codex. Use when the user asks to track debt, audit shortcuts, or list anti-hall debt markers.

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

Run the existing pure-Node debt harvester:

```bash
node "$ANTI_HALL_ROOT/scripts/harvest-debt.js"
node "$ANTI_HALL_ROOT/scripts/harvest-debt.js" --json
node "$ANTI_HALL_ROOT/scripts/harvest-debt.js" --dir src --stale-days 60
```

Debt marker format:

```js
// anti-hall: <ceiling>, <when>
```

Examples:

```js
// anti-hall: 30 lines, when a third backend needs it
// anti-hall: O(n^2), when n > 1000
```

Rules:

- A marker is for deliberate, budgeted debt only.
- If there is no concrete trigger after the comma, treat it as rot-risk.
- A marker is not permission to leave broken behavior or unfinished work.
