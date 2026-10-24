---
name: activate
description: "First-time anti-hall setup: model routing and activation sentinel. Use for \"activate anti-hall\", \"set up anti-hall\"."
---

# anti-hall:activate

## When to use

One-shot idempotent anti-hall setup. Reports model-routing state, writes a sentinel so it doesn't repeat, and does not install the retired statusline. Use when the user says "activate anti-hall", "set up anti-hall", "run first-time setup", or "anti-hall activate". NOT auto-run — user-invoked only.

One-shot, idempotent first-time setup for anti-hall. Run this once after installing the
plugin. It is **never** auto-invoked — always user-triggered. Re-running is safe (idempotent).

## What it does

0. **Engine install (explicit)** — the hooks run the thin client `~/.anti-hall/ah-engine/bin/ah-hook`; until it is installed they pass
   through with one notice per session, and nothing is downloaded on its own (`engine.bootstrap` defaults to false). If
   `~/.anti-hall/ah-engine/bin/ah-hook` is missing, ask the user, then install it with standard tools (the plugin ships
   no installer script; every step is sha256-pinned to `ah-engine.lock`):
   a. Read `${CLAUDE_PLUGIN_ROOT}/ah-engine.lock` (JSON): `version`, and `assets["ah-engine-v<version>-<triple>.tar.gz"]` = the pinned sha256.
   b. Pick `<triple>` for this machine: macOS `aarch64-apple-darwin` (Apple silicon, also an Intel shell under Rosetta: check
      `sysctl -n sysctl.proc_translated` = 1) or `x86_64-apple-darwin`; Linux `<aarch64|x86_64>-unknown-linux-<gnu|musl>` (musl
      when `/lib/ld-musl-*` exists or `ldd --version` names musl, else gnu). Any other platform: stop and tell the user.
   c. Download `https://github.com/talas9/anti-hall/releases/download/ah-engine-v<version>/ah-engine-v<version>-<triple>.tar.gz`
      into a fresh temp directory (`curl -fsSL --proto '=https' --tlsv1.2 -o <tmp>/asset.tar.gz <url>`).
   d. Verify its sha256 (`shasum -a 256` or `sha256sum`) equals the pinned value. On a mismatch delete the temp directory, report
      it and STOP: never install an unverified archive.
   e. Extract only the two members `ah-engine-v<version>-<triple>/ah-engine` and `.../ah-hook` (`tar -xzOf <archive> <member>
      > <tmp>/<name>`, never the archive's own paths) into `~/.anti-hall/ah-engine/bin/`, `chmod 755` both.
   f. Run `~/.anti-hall/ah-engine/bin/ah-hook --plugin-root "${CLAUDE_PLUGIN_ROOT}" install --lock "${CLAUDE_PLUGIN_ROOT}/ah-engine.lock" -v`: the one
      implementation of install and update (it records the integrity of the installed engine and wires the rest).

1. **Statusline retired** — do not write Claude `statusLine`. If an older anti-hall statusline exists, tell the user `uninstall-statusline` remains available for cleanup.

2. **Model-routing state** — strict mode is now the **default** (v0.35.0+). No action
   needed. Reports: `ANTIHALL_MODEL_ROUTING` is unset (strict) or set to `advisory`
   (opt-out). Strict blocks omitted-model mechanical spawns unconditionally.
   To opt out: set `ANTIHALL_MODEL_ROUTING=advisory` in the project's
   `.claude/settings.json` env block.

3. **Sentinel write** — writes `~/.anti-hall/activated.json` with the activation
   timestamp and installed version so future runs report "already activated" and exit 0
   immediately. The sentinel is advisory — resetting it does not change any real config.

4. **No restart reminder** — activation no longer changes `statusLine`.

## Steps

1. **Check sentinel.** If `~/.anti-hall/activated.json` exists and is valid JSON,
   report the previous activation date + installed version and exit 0 (idempotent).

2. **Do not install statusline.** If an old anti-hall `statusLine` is causing trouble, use `uninstall-statusline`; otherwise leave user settings untouched.

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

5. **No restart reminder.** There is no activation-time settings change.

## What stays opt-in (unchanged)

These are NOT touched by activate — they remain opt-in and require explicit user action:

| Feature | How to enable |
|---------|--------------|
| `mcp-reaper` companion | `~/.anti-hall/ah-engine/bin/ah-engine units heal` (the engine runs the reaper as a scheduled job; see `mcp-reaper`) |
| `ANTIHALL_API_GUARD_THIRDPARTY` | Set env var to `1` in project settings |
| `ANTIHALL_SHIPIT_GATE` | Set env var to `1` in project settings |
| `ANTIHALL_MERGE_GATE` | Set env var to `1` in project settings |
| Semantic judge | Set `jev.semanticJudge` to true (or `ANTIHALL_SEMANTIC_JUDGE=1`) + store `anthropic_api_key` in the plugin options |

## Important constraints

- **Never auto-run as a SessionStart side-effect.** This skill is user-invoked only.
  The always-on hooks (git-guard, api-guard, command-guard, model-routing-guard, etc.)
  are active from the moment the plugin is installed — no activation step needed for
  them. This skill now covers first-run orientation only.
- **Do not call install-statusline.** It is a retained no-op and must not be used as setup.
