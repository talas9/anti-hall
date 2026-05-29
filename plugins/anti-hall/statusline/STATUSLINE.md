# anti-hall Statusline

Portable Claude Code statusline plugin — no emojis, no project-specific fields,
degrades gracefully when optional files are absent.
Runs on **Windows, macOS, and Linux** via Node only (no bash, no grep/sed/python3).

## Scripts

| Script | Purpose |
|---|---|
| `statusline.js` | Dispatcher — auto-selects renderer, prints line 1 + optional line 2 |
| `statusline-monorepo.js` | Rich statusline for monorepos and GSD projects |
| `statusline-simple.js` | Minimal statusline for plain repos |
| `phase-bar.js` | Standalone phase bar printer (also embedded in statusline.js) |
| `install-statusline.js` | Idempotent installer — wires `statusline.js` into settings.json |
| `uninstall-statusline.js` | Restores previous statusLine from backup, or removes the key |

---

## Two-line output

`statusline.js` prints up to two lines on each Claude Code refresh:

```
<line 1>   — always printed
<line 2>   — printed only when os.tmpdir()/anti-hall/phase-state.json exists and is valid
```

### Line 1 — monorepo or simple statusline

**Monorepo** (any of `.gitmodules`, `.gsd/`, `.planning/` found at git toplevel or cwd):

```
<model> | <current-task-or-gsd-state> | <dir-basename> [context-bar %]
```

**Simple** (any other repo or directory):

```
<model> | <branch> | <dir-basename> | <context%>
```

### Line 2 — phase bar (conditional)

```
| [####------] P2 build 2/5
```

The spinner character (`|`, `/`, `-`, `\`) time-cycles every 250 ms, giving a live
feel between refreshes. Line 2 is omitted entirely when the phase-state file is
absent or malformed — never an error.

**Phase-state file:** `$TMPDIR/anti-hall/phase-state.json`

```json
{ "code": "P2", "desc": "build", "done": 2, "total": 5 }
```

Required fields: `code` (string), `desc` (string), `done` (integer), `total` (positive integer).

---

## Monorepo detection rule

`statusline.js` checks the **git toplevel** of the current repo (falling back to cwd).
It picks `statusline-monorepo.js` when **any** of these exist at the toplevel:

- `.gitmodules` (git submodules present)
- `.gsd/` directory (GSD project)
- `.planning/` directory (planning state present)

Otherwise picks `statusline-simple.js`.

Detection uses `fs.existsSync` — no bash, no grep, fully cross-platform.

---

## statusline-monorepo.js details

```
<model> | <current-task-or-gsd-state> | <dir-basename> [context-bar %]
```

- **model** — `model.display_name` (dim)
- **current task** — in-progress todo `activeForm` from the session todos file (bold)
- **GSD state** — when no active todo: milestone, phase, progress bar, or next action
  parsed from `.planning/STATE.md` (dim). Omitted when `.planning/` is absent.
- **dir-basename** — `path.basename(workspace.current_dir)` (dim)
- **context bar** — 10-char `[##########]` bar + % (green/yellow/orange/red; omitted when
  context data is absent or non-numeric)

Optional config (read from `.planning/config.json`):

| config key | type | effect |
|---|---|---|
| `statusline.show_last_command` | boolean | appends `last: /cmd` from transcript |
| `statusline.context_position` | `"end"` / `"front"` | moves context bar position |

---

## statusline-simple.js details

```
<model> | <branch> | <dir-basename> | <context%>
```

- **model** — `model.display_name` (dim)
- **branch** — current git branch (blue; omitted when not a git repo)
- **dir-basename** — project folder name (dim)
- **context%** — `100 - remaining_percentage` (green/yellow/red; omitted when absent)

---

## Installation

Plugins cannot auto-apply a main `statusLine` — Claude Code's plugin settings.json
supports only `agent` and `subagentStatusLine`. The installer wires things up by
editing your personal `~/.claude/settings.json`.

### Run the installer

```
node statusline/install-statusline.js
```

The installer:
1. Checks if `statusLine` already points at this script — if so, prints "already
   installed" and exits without making any changes (dedup).
2. Backs up `~/.claude/settings.json` to `~/.claude/settings.json.bak-antihall-statusline`
   — only on the first install; does not overwrite an existing backup.
3. Prints the old `statusLine` value (if any).
4. Sets `statusLine` to `{ "type": "command", "command": "node \"<abs-path>/statusline.js\"" }`.
5. Prints the new value and uninstall instructions.

**Restart Claude Code** (close and reopen) after running the installer for the
changed `statusLine` to take effect.

---

## Uninstall

```
node statusline/uninstall-statusline.js
```

The uninstaller:
1. If `~/.claude/settings.json.bak-antihall-statusline` exists, restores the entire
   settings.json from that backup (reverting all changes the installer made).
2. If no backup exists, removes only the `statusLine` key from the current settings.json.
3. Reports what it did. Idempotent — safe to run multiple times.

**Restart Claude Code** after uninstalling.

---

## Cross-platform note

All scripts are pure Node (built-ins only: `fs`, `path`, `os`, `child_process`).
No bash, grep, sed, cksum, or python3 required. Git detection uses
`child_process.execFileSync('git', ...)` and degrades gracefully when git is absent.

Windows path separators are handled via `path.join`/`path.basename`. Home directory
is resolved via `os.homedir()` on all platforms.
