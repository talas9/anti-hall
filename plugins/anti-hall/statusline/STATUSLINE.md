# anti-hall Statusline

Portable Claude Code statusline plugin — no emojis, no project-specific fields,
degrades gracefully when optional files are absent.

## Scripts

| Script | Purpose |
|---|---|
| `statusline-monorepo.js` | Rich statusline for monorepos and GSD projects |
| `statusline-simple.js` | Minimal statusline for plain repos |
| `statusline.sh` | Dispatcher — auto-selects the right script per repo type |
| `install-statusline.sh` | One-shot installer — wires `statusline.sh` into your settings.json |

---

## What each script shows

### statusline-monorepo.js

```
<model> | <current-task-or-gsd-state> | <dir-basename> [context-bar %]
```

- **model** — `model.display_name` from the Claude Code stdin JSON (dim)
- **current task** — in-progress todo `activeForm` from the session's todos file (bold)
- **GSD state** — when no active todo: milestone, phase, progress bar, or next recommended
  action parsed from `.planning/STATE.md` (dim). Omitted when `.planning/` is absent.
- **dir-basename** — `path.basename(workspace.current_dir)` (dim)
- **context bar** — 10-char `[##########]` bar + % (green/yellow/orange/red; omitted when
  context window data is absent)

Optional features (read from `.planning/config.json`):

| config key | type | effect |
|---|---|---|
| `statusline.show_last_command` | boolean | appends `last: /cmd` from transcript |
| `statusline.context_position` | `"end"` / `"front"` | moves context bar before or after middle segment |

Context bridge: writes `$TMPDIR/claude-ctx-<session>.json` for the context-monitor
PostToolUse hook (best-effort, silent on failure).

### statusline-simple.js

```
<model> | <branch> | <dir-basename> | <context%>
```

- **model** — `model.display_name` (dim)
- **branch** — current git branch (blue; omitted when not in a git repo)
- **dir-basename** — project folder name (dim)
- **context%** — raw `100 - remaining_percentage` (green/yellow/red; omitted when absent)

No `.planning/`, no todos, no GSD. Always safe to run on any project.

---

## Monorepo detection rule (statusline.sh)

`statusline.sh` runs from the **git toplevel** of the current repo.
It picks `statusline-monorepo.js` when **any** of these exist at the git toplevel:

- `.gitmodules` (git submodules present)
- `.gsd/` directory (GSD project)
- `.planning/` directory (GSD / planning state)

Otherwise it picks `statusline-simple.js`.

---

## Installation

Plugins cannot auto-apply a main `statusLine` — Claude Code's plugin settings.json
supports only `agent` and `subagentStatusLine`. The installer wires things up for
you by editing your personal `~/.claude/settings.json`.

```bash
bash statusline/install-statusline.sh
```

The installer:
1. Backs up `~/.claude/settings.json` to `~/.claude/settings.json.bak-anti-hall`
2. Prints the existing `statusLine` value (if any)
3. Sets `statusLine` to `{ "type": "command", "command": "bash <path>/statusline.sh", "padding": 0 }`
4. Prints the new value and revert instructions

The script is idempotent — running it again just overwrites the statusLine with the
same value (the backup is refreshed each time).

---

## Revert

```bash
cp ~/.claude/settings.json.bak-anti-hall ~/.claude/settings.json
```

Or manually remove / replace the `statusLine` key in `~/.claude/settings.json`.

---

## Why an installer instead of auto-apply

Claude Code evaluates `statusLine` from the user's `~/.claude/settings.json`. A
plugin's own `settings.json` supports `agent` and `subagentStatusLine`, but the main
`statusLine` (the bar shown in every session) must come from the user-level settings
file. The installer is therefore the correct and only activation step.
