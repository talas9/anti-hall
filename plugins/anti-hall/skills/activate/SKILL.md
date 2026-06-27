---
name: activate
description: One-shot idempotent anti-hall setup. Checks statusline installation, reports model-routing state, writes a sentinel so it doesn't repeat. Use when the user says "activate anti-hall", "set up anti-hall", "run first-time setup", or "anti-hall activate". NOT auto-run — user-invoked only.
---

# anti-hall:activate

One-shot, idempotent first-time setup for anti-hall. Run this once after installing the
plugin. It is **never** auto-invoked — always user-triggered. Re-running is safe (idempotent).

## What it does

1. **Statusline check** — reads `~/.claude/settings.json` for an existing `statusLine`.
   - If none: installs the anti-hall statusline at user scope (delegates to the
     `install-statusline.js` script, same as `/anti-hall:install-statusline --user`).
   - If one exists (conflict): reports the existing command and offers two choices:
     - Accept: the existing line becomes **line 1** (anti-hall wraps it) — run the
       installer and it will auto-wrap the current value.
     - Skip: keep the existing statusline and install anti-hall at **project scope**
       instead (`--project` into `.claude/settings.local.json`).

2. **Model-routing state** — strict mode is now the **default** (v0.35.0+). No action
   needed. Reports: `ANTIHALL_MODEL_ROUTING` is unset (strict) or set to `advisory`
   (opt-out). Strict blocks omitted-model mechanical spawns unconditionally.
   To opt out: set `ANTIHALL_MODEL_ROUTING=advisory` in the project's
   `.claude/settings.json` env block.

3. **Sentinel write** — writes `~/.anti-hall/activated.json` with the activation
   timestamp and installed version so future runs report "already activated" and exit 0
   immediately. The sentinel is advisory — resetting it does not change any real config.

4. **Restart reminder** — prints a single "restart Claude Code to apply" note when the
   statusline was changed; skipped if already installed or no statusline change was made.

## Steps

1. **Check sentinel.** If `~/.anti-hall/activated.json` exists and is valid JSON,
   report the previous activation date + installed version and exit 0 (idempotent).

2. **Check statusline.** Delegate a subagent to read `~/.claude/settings.json` and
   report the current `statusLine` value (if any).

   - **No existing statusLine:** delegate a subagent to run:
     ```
     node "${CLAUDE_PLUGIN_ROOT}/statusline/install-statusline.js" --user
     ```
     Report its stdout verbatim. Set `statusline_changed = true`.

   - **Existing statusLine present:** report it to the user and ask:
     > "anti-hall can wrap this as line 1 (run the installer — it auto-wraps). Or
     > install anti-hall at project scope only (settings.local.json, this repo). Or
     > skip statusline setup entirely. Which do you prefer?"
     
     Depending on user's choice, delegate the appropriate installer invocation.
     If user says "wrap" or "install globally": run `--user`. If "project scope": run
     `--project`. If "skip": skip — set `statusline_changed = false`.

3. **Report model-routing.** No action required. Print:
   > "Model-routing: STRICT (default, v0.35.0+). Omitted-model mechanical spawns are
   > blocked. Set ANTIHALL_MODEL_ROUTING=advisory in your project's .claude/settings.json
   > env block to opt out."
   
   If `ANTIHALL_MODEL_ROUTING=advisory` is already set in the environment, print:
   > "Model-routing: ADVISORY (opted out). Set ANTIHALL_MODEL_ROUTING=advisory detected.
   > Remove it to restore strict-default blocking."

4. **Write sentinel.** Delegate a subagent to run:
   ```js
   const os = require('os');
   const fs = require('fs');
   const path = require('path');
   const dir = path.join(os.homedir(), '.anti-hall');
   fs.mkdirSync(dir, { recursive: true });
   fs.writeFileSync(
     path.join(dir, 'activated.json'),
     JSON.stringify({ activatedAt: new Date().toISOString(), version: '0.35.0' }, null, 2) + '\n'
   );
   console.log('Sentinel written.');
   ```

5. **Restart reminder.** If `statusline_changed = true`:
   > "**Restart Claude Code** (close and reopen) for the statusline to take effect.
   > statusLine is read only at startup — there is no hot-reload."

## What stays opt-in (unchanged)

These are NOT touched by activate — they remain opt-in and require explicit user action:

| Feature | How to enable |
|---------|--------------|
| `mcp-reaper` companion | `node plugins/anti-hall/companion/install-reaper.js` |
| `ANTIHALL_API_GUARD_THIRDPARTY` | Set env var to `1` in project settings |
| `ANTIHALL_SHIPIT_GATE` | Set env var to `1` in project settings |
| `ANTIHALL_MERGE_GATE` | Set env var to `1` in project settings |
| `ANTIHALL_SEMANTIC_JUDGE` | Set env var to `1` + `ANTHROPIC_API_KEY` |

## Important constraints

- **Never auto-run as a SessionStart side-effect.** This skill is user-invoked only.
  The always-on hooks (git-guard, api-guard, command-guard, model-routing-guard, etc.)
  are active from the moment the plugin is installed — no activation step needed for
  them. This skill only covers the statusline (which requires writing settings) and
  first-run orientation.
- **Delegate all file I/O to subagents.** The coordinator (main thread) must not run
  the installer directly — `command-guard` blocks heavy commands inline.
- **Reuse install-statusline.js** — do not reimplement its logic. The installer
  handles precedence checks, backup, gitignore, and the "already installed" exit-0
  case itself.
