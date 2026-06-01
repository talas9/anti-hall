---
name: install-statusline
description: Install or enable the anti-hall statusline (rich line-1 statusline + phase bar) in the current repo or globally. Use when the user asks to "install the statusline", "add the bar", "enable the phase bar here", "set up the statusline in this project", or "show the statusline everywhere". Writes the statusLine entry into settings.json (user scope by default, project scope on request) and reminds the user to restart.
---

# Install Statusline

Sets up the anti-hall two-line statusline:
- **Line 1** — a rich generic statusline (project name, git branch/worktree/stash/staged-modified-untracked, ahead/behind, model, effort, subagent count, session duration, context-window %, cost, and the GSD `.planning` phase when present). Rendered by the plugin's own `statusline-rich.js` — works in any repo.
- **Line 2** — the phase bar, shown while an orchestration phase is active (`~/.anti-hall/phase-state.json`).

## Critical facts (do not skip)

1. **A plugin cannot provide a statusline.** It is a `settings.json` entry, so it MUST be written into settings. That is what this skill does.
2. **`statusLine` is read only at Claude Code startup — no hot-reload.** After installing, the user MUST restart Claude Code in that scope before the bar appears. Always say this.
3. **Scope** (Claude Code merges, last wins): `~/.claude/settings.json` (user, global) → `./.claude/settings.json` (project) → `./.claude/settings.local.json` (project-local).
   - **Global (default):** the bar appears in every repo. Use `--user`.
   - **This repo only:** use `--project` (writes `./.claude/settings.json`). The project file gets a machine-absolute path — make sure it is gitignored.
4. **Never hand-edit `~/.anti-hall/base-statusline.json`.** It is GLOBAL and shared by every project that points at the dispatcher; the installer already protects it (won't clobber an existing one).

## Steps

1. Decide scope from the user's words: global ("everywhere", "all repos") → `--user` (default); "this repo / project only" → `--project`.
2. Run the installer. It is a `node` script (a state change), so **delegate it to a subagent** — do not run it inline in the coordinator (the command-guard blocks heavy commands on the main thread). Brief the subagent to run exactly:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/statusline/install-statusline.js" [--user|--project]
   ```
   and report its stdout verbatim.
3. If scope is `--project`, ensure `.claude/settings.json` (and `.claude/settings.local.json`) are in the repo's `.gitignore` — the statusLine command contains a machine-absolute path that must not be committed.
4. Tell the user: **restart Claude Code** in that scope for the statusline to take effect. The phase bar (line 2) appears once an orchestration phase writes `~/.anti-hall/phase-state.json`.

## Uninstall

Delegate `node "${CLAUDE_PLUGIN_ROOT}/statusline/uninstall-statusline.js"` to a subagent; it restores the previous statusLine from the backup. Restart afterward.
