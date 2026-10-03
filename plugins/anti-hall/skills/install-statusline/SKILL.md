---
name: install-statusline
description: Install or enable the anti-hall statusline (rich line-1 statusline + phase bar) in the current repo or globally. Use when the user asks to "install the statusline", "add the bar", "enable the phase bar here", "set up the statusline in this project", or "show the statusline everywhere". Writes the statusLine entry into the correct settings file (user scope by default, project-local on request) and reminds the user to restart.
---

# Install Statusline

Sets up the anti-hall two-line statusline:
- **Line 1** — a rich generic statusline (project name, git branch/worktree/stash/staged-modified-untracked, ahead/behind, model, effort, subagent count, session duration, context-window %, cost). Rendered by the plugin's own `statusline-rich.js` — works in any repo.
- **Line 2** — the phase bar, shown while an orchestration phase is active (`~/.anti-hall/phase-state.json`).

## Critical facts (do not skip)

1. **A plugin cannot provide a statusline.** It is a `settings.json` entry, so it MUST be written into settings. That is what this skill does.
2. **`statusLine` is read only at Claude Code startup — no hot-reload.** After installing, the user MUST restart Claude Code in that scope before the bar appears. **Always say this.**
3. **Precedence model** (Claude Code merges in this order, **last wins / highest precedence**):
   ```
   ~/.claude/settings.json          (user — global, lowest precedence)
   ./.claude/settings.json          (project — version-controlled)
   ./.claude/settings.local.json    (project-local — gitignored, HIGHEST)
   ```
   **Why this matters:** if a project's committed `settings.json` defines a `statusLine`, it **shadows** any user-global install — the user sees the project setting, not anti-hall. To reliably show anti-hall inside a project, you must install into `settings.local.json` (highest precedence AND gitignored, so machine-absolute paths don't leak into git).
4. **Default scope:**
   - `--user` → `~/.claude/settings.json` — bar appears in **every repo** on this machine.
   - `--project` (or per-project request) → `./.claude/settings.local.json` — this repo only, highest precedence, gitignored.
   - **The installer writes to `settings.local.json` for per-project scope** (NOT `settings.json`). This is intentional: settings.local.json cannot be accidentally committed.
5. **Stable dispatcher path.** The installer resolves the path to `statusline.js` in this order:
   - `~/.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/statusline/statusline.js` (stable across updates — preferred)
   - `__dirname/statusline.js` (dev / direct repo run — fallback)
   It **never** bakes a versioned cache path (`.../cache/anti-hall/anti-hall/<version>/...`) because that path breaks silently on every plugin update.
6. **Never hand-edit `~/.anti-hall/base-statusline.json`.** It is GLOBAL and shared by every project that points at the dispatcher; the installer already protects it (won't clobber an existing one).
7. **Precedence check.** Before writing, the installer reads `statusLine` across all three scopes and prints a note if a committed `settings.json` would be shadowed, or if anti-hall is already the effective statusLine (`already installed — exit 0`).
8. **Gitignore.** When installing `--project`, the installer auto-appends `.claude/settings.local.json` to `.gitignore` if missing, and warns if the file is already git-tracked.

## Steps

1. Decide scope from the user's words:
   - Global ("everywhere", "all repos") → `--user` (default)
   - "This repo / project only" → `--project`
2. Run the installer. It is a `node` script (a state change), so **delegate it to a subagent** — do not run it inline in the coordinator (the command-guard blocks heavy commands on the main thread). Brief the subagent to run exactly:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/statusline/install-statusline.js" [--user|--project]
   ```
   and report its stdout verbatim.
3. Tell the user: **restart Claude Code** in that scope for the statusline to take effect. The phase bar (line 2) appears once an orchestration phase writes `~/.anti-hall/phase-state.json`.

## Uninstall

Delegate `node "${CLAUDE_PLUGIN_ROOT}/statusline/uninstall-statusline.js"` to a subagent; it restores the previous statusLine from the backup. Restart afterward.
