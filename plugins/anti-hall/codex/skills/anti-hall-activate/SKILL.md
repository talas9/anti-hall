---
name: anti-hall-activate
description: Idempotent Codex setup for anti-hall. Use when the user asks to activate anti-hall, set it up for Codex, or install the Codex hooks.
---

# anti-hall activate for Codex

## When to use

Idempotent Codex setup for anti-hall. Use when the user asks to activate anti-hall, set it up for Codex, or install the Codex hooks.

Activation for Codex installs the supported Codex hook subset and writes an advisory sentinel. It does not touch Claude Code settings.

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

0. Install the thin client and the engine if `~/.anti-hall/ah-engine/bin/ah-hook` is missing (nothing is downloaded on its own:
   `engine.bootstrap` defaults to false; ask the user first). The plugin ships no installer script; do these steps with standard
   tools, pinned to the sha256 in `ah-engine.lock`:

   a. Read `$ANTI_HALL_ROOT/ah-engine.lock` (JSON): `version`, and `assets["ah-engine-v<version>-<triple>.tar.gz"]` = the pinned sha256.
   b. Pick `<triple>` for this machine: macOS `aarch64-apple-darwin` (Apple silicon, also an Intel shell under Rosetta: check
      `sysctl -n sysctl.proc_translated` = 1) or `x86_64-apple-darwin`; Linux `<aarch64|x86_64>-unknown-linux-<gnu|musl>` (musl
      when `/lib/ld-musl-*` exists or `ldd --version` names musl, else gnu). Any other platform: stop and tell the user.
   c. Download `https://github.com/talas9/anti-hall/releases/download/ah-engine-v<version>/ah-engine-v<version>-<triple>.tar.gz`
      into a fresh temp directory (`curl -fsSL --proto '=https' --tlsv1.2 -o <tmp>/asset.tar.gz <url>`).
   d. Verify its sha256 (`shasum -a 256` or `sha256sum`) equals the pinned value. On a mismatch delete the temp directory, report
      it and STOP: never install an unverified archive.
   e. Extract only the two members `ah-engine-v<version>-<triple>/ah-engine` and `.../ah-hook` (`tar -xzOf <archive> <member>
      > <tmp>/<name>`, never the archive's own paths) into `~/.anti-hall/ah-engine/bin/`, `chmod 755` both.
   f. Run `~/.anti-hall/ah-engine/bin/ah-hook --plugin-root "$ANTI_HALL_ROOT" install --lock "$ANTI_HALL_ROOT/ah-engine.lock" -v`: the one
      implementation of install and update (it records the integrity of the installed engine and wires the rest).

1. Install project-local Codex hooks:

```bash
"$HOME/.anti-hall/ah-engine/bin/ah-engine" install-codex
```

2. For global Codex hooks instead:

```bash
"$HOME/.anti-hall/ah-engine/bin/ah-engine" install-codex --global
```

3. Verify:

```bash
~/.anti-hall/ah-engine/bin/ah-engine doctor
codex features list
test -f .codex/hooks.json && sed -n '1,220p' .codex/hooks.json
```

4. Write sentinel:

```bash
~/.anti-hall/ah-engine/bin/ah-engine codex-activate
```

Codex limitations after activation:

- shell guards are hard hooks
- session/prompt/stop nudges are hooks
- edit-time `edit-guard`, `api-guard` and `ship-it-guard` (existence gate) are hard hooks on `apply_patch` edits (Codex 0.134+) and on shell writes whose target is literal in the command; a target in a variable, a glob or a script is not seen
- subagent lifecycle hooks are not available in Codex today

Use `anti-hall-doctor` to inspect the active state.
