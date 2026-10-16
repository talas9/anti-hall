---
title: Update
description: Update anti-hall on Claude Code and Codex, and see what changed.
---

# Update

## Claude Code

Ask **"update anti-hall"**, or run `/anti-hall:update`. The skill:

1. pulls the latest release into the plugin's marketplace clone;
2. prints the changelog entries between your version and the new one;
3. tells you to run `/reload-plugins`.

Hooks are read from disk, so they pick up the new version right away.
`/reload-plugins` refreshes the skill list and version text. Restart Claude Code only
if a hook or skill path still shows the old version afterwards, or if you want the
session-start text injected again.

To check without changing anything, ask **"is anti-hall up to date"** (the skill's
`--check` mode).

anti-hall also tells you when a newer version exists. That check is the one network
request anti-hall makes by default; turn it off with `versionAlerts.antiHall`.

!!! warning "Coming from 0.107.x or older"
    Run `claude plugin update anti-hall@anti-hall` once, then restart Claude Code. The old
    updater cannot register 0.108.0 or later with Claude Code. Later updates do this
    themselves.

## Codex

The Codex hooks run from the clone you installed from, so updating the clone updates
them:

```bash
cd /path/to/anti-hall
git pull --ff-only
```

After pulling, re-run the installer with the same options you used before, so hooks added
since your install are registered too. It is safe to re-run: it replaces its own entries
in `hooks.json` and leaves your other hooks alone.

```bash
node /path/to/anti-hall/plugins/anti-hall/codex/install-codex.js --global
```

## After an update

Some updates repair state written by older versions. This runs by itself after a plugin
reload or a new version, and you can run it by hand with `/anti-hall:doctor --repair`.

What changed in each release: [Changelog](../../CHANGELOG.md).
