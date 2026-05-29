# anti-hall Statusline

Portable Claude Code statusline plugin — no emojis, no project-specific fields,
degrades gracefully when optional files are absent.
Runs on **Windows, macOS, and Linux** via Node only (no bash, no grep/sed/python3).

## Scripts

| Script | Purpose |
|---|---|
| `statusline.js` | Dispatcher — auto-selects the right renderer per repo type |
| `statusline-monorepo.js` | Rich statusline for monorepos and GSD projects |
| `statusline-simple.js` | Minimal statusline for plain repos |
| `install-statusline.js` | Cross-platform installer — wires `statusline.js` into your settings.json |

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
  context window data is absent or non-numeric)

Optional features (read from `.planning/config.json`):

| config key | type | effect |
|---|---|---|
| `statusline.show_last_command` | boolean | appends `last: /cmd` from transcript |
| `statusline.context_position` | `"end"` / `"front"` | moves context bar before or after middle segment |

### statusline-simple.js

```
<model> | <branch> | <dir-basename> | <context%>
```

- **model** — `model.display_name` (dim)
- **branch** — current git branch via `git rev-parse --abbrev-ref HEAD` (blue; omitted when not in a git repo)
- **dir-basename** — project folder name (dim)
- **context%** — `100 - remaining_percentage` (green/yellow/red; omitted when absent or non-numeric)

No `.planning/`, no todos, no GSD-specific logic. Always safe to run on any project.

---

## Monorepo detection rule (statusline.js)

`statusline.js` checks the **git toplevel** of the current repo (falling back to cwd).
It picks `statusline-monorepo.js` when **any** of these exist at the toplevel:

- `.gitmodules` (git submodules present — primary generic signal)
- `.gsd/` directory (GSD project — optional, degrades gracefully when absent)
- `.planning/` directory (planning state present — optional, degrades gracefully when absent)

Otherwise it picks `statusline-simple.js`.

Detection uses Node `fs.existsSync` — no bash, no grep, fully cross-platform.

---

## Installation

Plugins cannot auto-apply a main `statusLine` — Claude Code's plugin settings.json
supports only `agent` and `subagentStatusLine`. The installer wires things up for
you by editing your personal `~/.claude/settings.json`.

### Step 1 — find the installed plugin directory

After `/plugin marketplace add talas9/anti-hall` or `/plugin install`, the plugin
lives in your Claude Code plugins cache. The exact path appears in the install output.
It typically looks like:

```
~/.claude/plugins/anti-hall/
```

or on Windows:

```
%USERPROFILE%\.claude\plugins\anti-hall\
```

### Step 2 — run the installer

```
node /path/to/anti-hall/statusline/install-statusline.js
```

The installer resolves all paths automatically. Replace `/path/to/anti-hall` with
the actual directory from Step 1.

The installer:
1. Backs up `~/.claude/settings.json` to `~/.claude/settings.json.bak-anti-hall`
2. Prints the existing `statusLine` value (if any)
3. Sets `statusLine` to `{ "type": "command", "command": "node \"<abs-path>/statusline.js\"", "padding": 0 }`
   — the path is fully quoted, so spaces in the install directory are safe
4. Prints the new value and revert instructions

The installer is idempotent — running it again just overwrites the statusLine with the
same value (the backup is refreshed each time).

---

## Revert

```
cp ~/.claude/settings.json.bak-anti-hall ~/.claude/settings.json
```

Or manually remove / replace the `statusLine` key in `~/.claude/settings.json`.

---

## Cross-platform note

All statusline scripts are pure Node (built-ins only: `fs`, `path`, `os`,
`child_process`). No bash, grep, sed, cksum, or python3 required. Git branch
detection uses `child_process.execFileSync('git', ...)` which works on every OS
where git is installed; it degrades gracefully (omits the branch segment) when git
is absent or the directory is not a git repo.

Windows path separators are handled via `path.join`/`path.basename`. The installer
resolves `~` via `os.homedir()` on all platforms.

---

## Why an installer instead of auto-apply

Claude Code evaluates `statusLine` from the user's `~/.claude/settings.json`. A
plugin's own `settings.json` supports `agent` and `subagentStatusLine`, but the main
`statusLine` (the bar shown in every session) must come from the user-level settings
file. The installer is therefore the correct and only activation step.
