# anti-hall Statusline

Portable Claude Code statusline plugin — wraps your existing statusline as
line 1 and adds a smart 3-tier line 2.  Line 2 behavior (3 tiers, highest
priority first): **phase progress bar** when an orchestration run is active →
**"orchestrating · N agents" activity bar** when recent subagent spawns are
detected (auto, no setup) → **context-window gauge** when idle.
No emojis, no project-specific fields, degrades gracefully when optional files
are absent.  Runs on **Windows, macOS, and Linux** via Node only
(no bash, no grep/sed/python3).

## Scripts

| Script | Purpose |
|---|---|
| `statusline.js` | Dispatcher — wraps base command or own render; prints line 1 + optional line 2 |
| `statusline-rich.js` | Rich line-1 renderer (project · git · model · effort · subagents · duration · ctx% · cost · GSD phase) |
| `statusline-monorepo.js` | Rich statusline for monorepos and GSD projects (own-dispatch fallback) |
| `statusline-simple.js` | Minimal statusline for plain repos (own-dispatch fallback) |
| `phase-bar.js` | Standalone phase bar printer (line 2 renderer, 3-tier) |
| `phase.js` | Phase state writer — called by orchestrators to update the progress bar |
| `install-statusline.js` | Idempotent installer — wraps your existing statusline + wires settings.json |
| `uninstall-statusline.js` | Restores original statusLine from base config or backup |

---

## Two-line output

`statusline.js` prints up to two lines on each Claude Code refresh:

```
<line 1>   — your existing statusline (or own dispatch)
<line 2>   — anti-hall line 2 (always on, 3-tier): phase bar → "orchestrating · N agents" → idle context gauge
```

### Line 1 — your existing statusline (wrapped)

When `~/.anti-hall/base-statusline.json` exists and has a `command` key,
`statusline.js` runs that command with the same stdin it received.  The base
command's stdout is used as-is — ANSI escape codes, colors, and emoji are
preserved byte-for-byte.

If no base config exists (or the base command errors), the dispatcher falls
back to its own monorepo/simple dispatch:

**Monorepo** (any of `.gitmodules`, `.gsd/`, `.planning/` found at git toplevel or cwd):

```
<model> | <current-task-or-gsd-state> | <dir-basename> [context-bar %]
```

**Simple** (any other repo or directory):

```
<model> | <branch> | <dir-basename> | <context%>
```

### Line 2 — always-on, 3-tier

Line 2 always renders something, picking the highest-priority tier that applies
(matching the top summary and `phase-bar.js`):

1. **Phase progress bar** — when a fresh orchestration phase-state exists:

   ```
   [█████████◓──────────] 60% | BUILD - anti-hall plugin 9/15
   ```

2. **"orchestrating · N agents" activity bar** — when no phase-state is set but
   recent subagent spawns are detected (auto, no setup).

3. **Context-window gauge** — when idle (no phase, no recent spawns):

   ```
   [███████████◐────────] 56% context · 128k/230k tokens
   ```

The spinner character (`◐`, `◓`, `◑`, `◒`) time-cycles each refresh. The phase
bar appears only when the phase-state file is present and well-formed; otherwise
line 2 falls through to the activity bar or the context gauge.

**Phase-state file:** `~/.anti-hall/phase-state.json`

```json
{ "code": "BUILD", "desc": "anti-hall plugin", "done": 9, "total": 15,
  "started": 1780222200000, "agents": 3, "step": "verifying" }
```

Required fields: `code`, `desc`, `done`, `total` (positive integer).
Optional fields: `started` (epoch ms), `agents` (count), `step` (current step).

---

## Installation

### Quick install (user scope — default)

```sh
node statusline/install-statusline.js
```

This writes to `~/.claude/settings.json`.

### Project scope

```sh
node statusline/install-statusline.js --project
```

This writes to `./.claude/settings.json` (creates the file if absent).

### Scope precedence

Claude Code merges settings in this order (last wins):

1. `~/.claude/settings.json` — user / global
2. `./.claude/settings.json` — project (version-controlled)
3. `./.claude/settings.local.json` — project-local (gitignored, highest priority)

Write to the scope that makes sense for your workflow.  If you want the
statusline everywhere, use `--user`.  If you want it only in one project
(or want the project to configure it without affecting your global settings),
use `--project`.

### What the installer does

1. Detects scope from `--user` / `--project` flag (`--user` is default).
2. Checks if `statusLine` already points at this `statusline.js`.  If so,
   prints "Already installed" and exits without any changes (dedup — never
   double-wraps).
3. If a different `statusLine.command` exists in the target file, saves it to
   `~/.anti-hall/base-statusline.json` so `statusline.js` can delegate line 1
   to it.
4. Backs up the settings file once to `<settings>.bak-antihall` (never
   overwrites an existing backup).
5. Sets `statusLine` to:
   ```json
   { "type": "command", "command": "node \"<abs-path>/statusline.js\"",
     "padding": 0, "refreshInterval": 1 }
   ```
   The absolute path is resolved from `__dirname` at install time — it points
   to wherever the plugin is actually installed, regardless of scope.
6. Reports old command, new command, base-config path, and uninstall
   instructions.

**Restart Claude Code** (close and reopen) after running the installer.

---

## Uninstall

```sh
node statusline/uninstall-statusline.js [--user|--project]
```

The uninstaller tries three strategies in order:

1. If `~/.anti-hall/base-statusline.json` exists, restores that command as
   the `statusLine.command` (your original statusline is back) and removes the
   base config file.
2. Else if `<settings>.bak-antihall` exists, restores the entire settings file
   from the backup.
3. Else removes only the `statusLine` key from the current settings file.

Idempotent — safe to run multiple times.  **Restart Claude Code** after
uninstalling.

---

## Base-statusline config

File: `~/.anti-hall/base-statusline.json`

```json
{ "command": "node \"/path/to/your/original-statusline.js\"" }
```

Written automatically by the installer when it detects an existing
`statusLine.command`.  You can also write it manually if you want to set a
specific base command without going through the installer.

- If the file is absent, line 1 uses own dispatch (monorepo / simple).
- If the file exists but the base command exits non-zero or times out,
  line 1 falls back to own dispatch (fail-open).
- The base command receives the same stdin bytes that Claude Code sends to
  the statusline (the session context JSON).

---

## phase.js — Phase state writer

`phase.js` is the **data source** for the phase bar.  The orchestrator and
feature-launch skill call it as real work progresses.  Writes to
`~/.anti-hall/phase-state.json`.

### Usage

```sh
node phase.js set <code> <desc> <done> <total>   # start/replace the phase
node phase.js advance [n]                         # done += n (default 1)
node phase.js step "<text>"                       # set current step text
node phase.js agents <n>                          # set active subagent count
node phase.js update key=value ...                # merge arbitrary fields
node phase.js clear                               # remove state (bar hides)
```

### Example

```sh
node phase.js set BUILD "anti-hall plugin" 0 15
node phase.js agents 3
node phase.js step "verifying syntax"
node phase.js advance 2
node phase.js step "running tests"
node phase.js advance 9
node phase.js clear
```

Fail-open: any error exits 0 without throwing.

---

## Monorepo detection rule (own dispatch fallback)

`statusline.js` checks the **git toplevel** of the current repo (falling back
to cwd) when using its own dispatch.  It picks `statusline-monorepo.js` when
**any** of these exist at the toplevel:

- `.gitmodules` (git submodules present)
- `.gsd/` directory (GSD project)
- `.planning/` directory (planning state present)

Otherwise picks `statusline-simple.js`.

Detection uses `fs.existsSync` — no bash, no grep, fully cross-platform.

---

## Cross-platform note

All scripts are pure Node (built-ins only: `fs`, `path`, `os`,
`child_process`).  No bash, grep, sed, cksum, or python3 required.
Git detection uses `child_process.execFileSync('git', ...)` and degrades
gracefully when git is absent.  Windows path separators are handled via
`path.join` / `path.basename`.  Home directory is resolved via `os.homedir()`
on all platforms.  No paths are hardcoded — all paths are resolved at runtime
from `__dirname` and `os.homedir()`.
