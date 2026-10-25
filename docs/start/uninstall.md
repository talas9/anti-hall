---
title: Uninstall
description: Remove anti-hall from Claude Code or Codex, including legacy statusline cleanup and optional companions.
---

# Uninstall

## 1. Clean up an older anti-hall statusline (if present)

New anti-hall installs no longer add Claude `settings.statusLine`. If an older install
still has an anti-hall `statusLine`, do this first while the plugin files are still
there. Run this from the plugin directory:

```bash
~/.anti-hall/ah-engine/bin/ah-engine uninstall-statusline
```

It puts back the previous `statusLine` when a saved base command exists, otherwise it
removes the old anti-hall entry. The retired installer/updater/doctor paths do not
write or upgrade `statusLine`.

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

These background helpers are only present if you installed them:

```bash
~/.anti-hall/ah-engine/bin/ah-engine units status      # lists the engine unit and any old Node reaper/supervisor/ingest units
~/.anti-hall/ah-engine/bin/ah-engine units heal        # retires the old Node units (moved aside, never deleted)
~/.anti-hall/ah-engine/bin/ah-engine units uninstall   # unloads the engine unit
```

## 4. Your data

`~/.anti-hall/` holds your settings, the skip file and logs, and each project's
`.anti-hall/` folder holds its session notes. Neither is removed automatically. Delete them
yourself only if you want that state gone.
