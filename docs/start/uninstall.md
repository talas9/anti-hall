---
title: Uninstall
description: Remove anti-hall from Claude Code or Codex, including the optional statusline and companions.
---

# Uninstall

## 1. Remove the statusline (if you installed it)

Do this first, while the plugin files are still there. Ask the `install-statusline` skill
to uninstall it, or run this from the plugin directory:

```bash
node statusline/uninstall-statusline.js
```

It puts back the `statusLine` you had before.

## 2. Remove the plugin

=== "Claude Code"

    ```bash
    claude plugin uninstall anti-hall@anti-hall
    claude plugin marketplace remove anti-hall   # optional: also drop the marketplace
    ```

=== "Codex"

    The installer has no uninstall option. Open `.codex/hooks.json` (project) or
    `~/.codex/hooks.json` (global) and delete the hook groups whose command path contains
    `/plugins/anti-hall/hooks/`. The installer's `.bak-<timestamp>` files hold the version
    from before you installed. The `[features] hooks = true` line it added to
    `config.toml` is left alone.

## 3. Remove optional companions (if you installed them)

These background helpers are only present if you ran their installers. Run the uninstall
from `plugins/anti-hall/companion/` in a clone, or from the plugin directory:

```bash
node install-reaper.js --uninstall                # MCP orphan reaper
node install-devswarm-supervisor.js --uninstall   # DevSwarm liveness supervisor
node install-devswarm-ingest.js --uninstall       # DevSwarm ingest daemon
```

## 4. Your data

`~/.anti-hall/` holds your settings, the skip file and logs, and each project's
`.anti-hall/` folder holds its session notes. Neither is removed automatically. Delete them
yourself only if you want that state gone.
