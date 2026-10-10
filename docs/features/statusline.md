---
title: Statusline
description: The optional two-line Claude Code statusline, how to install it, and how to combine it with one you already have.
---

# Statusline

anti-hall ships an optional two-line statusline for Claude Code. Plugins cannot set the
statusline on their own, so it is a separate, one-command install.

## What it shows

**Line 1** shows the project, git branch and state, model, effort, running subagents,
session duration, context use and cost. It also shows an anti-hall version chip
(`AH: Vx.y.z`): plain when you are up to date, **yellow** with a `★` when a new minor
version is out, **red** when a new major version is out.

**Line 2** changes with what is happening, highest priority first:

1. a **phase progress bar** while an orchestration run reports phases;
2. **"orchestrating · N agents"** while helper agents are being spawned;
3. otherwise, a **context-window gauge**.

## Install

Ask **"install the statusline"**, or run `/anti-hall:install-statusline`. It writes the
`statusLine` entry in `~/.claude/settings.json` (for all projects by default, or for one
project if you ask). **Restart Claude Code once** afterwards: Claude Code only reads
`statusLine` at startup.

### Keep the statusline you already have

If you already use a statusline (for example the oh-my-claudecode HUD), install with
`--consolidate`. Your existing statusline stays as line 1 and anti-hall adds its line 2.
The base command is saved in `~/.anti-hall/consolidated-base.json`; to set it yourself,
use the `statusline.base` setting.

## Settings

| To | Use |
|---|---|
| Hide the account email segment | `statusline.noEmail` = `true` |
| Set the line-1 command in consolidated mode | `statusline.base` |

All statusline settings: [Settings reference](../../plugins/anti-hall/hooks/lib/settings-schema.js).

## Remove it

Ask the `install-statusline` skill to uninstall it, or run
`node statusline/uninstall-statusline.js` from the plugin directory. It restores the
`statusLine` you had before.

## Codex

Codex's status line only accepts its own built-in items, so the anti-hall statusline is
Claude Code only.
