---
title: Changing settings
description: Where anti-hall's settings live and the three ways to change them.
---

# Changing settings

Every anti-hall setting lives in one file, `~/.anti-hall/settings.json`, grouped into
sections such as `guards`, `safety`, `autoHandover` and `statusline`. Nearly every hook
has an on/off switch there; `settings.js show` lists the few parts that have none, and why. The full list, with defaults, is the
[Settings reference](../../plugins/anti-hall/engine/defaults/settings_cli.toml).

## Three ways to change a setting

=== "Ask for it"

    Tell the assistant what you want, in plain words:

    ```text
    turn off the merge gate
    set auto-handover to 80%
    show my anti-hall settings
    ```

    The `settings` skill (`/anti-hall:settings`) applies the change with one command and
    only prints tables when you ask to see them.

=== "The /config panel"

    Claude Code's native `/config` panel (Claude Code 2.1.269 or newer) shows the
    headline switches: auto-handover on/off and its threshold, Jev, the DevSwarm
    supervisor mode, model routing, limit conservation, the four safety guards, and the
    API keys. Everything else is set through the skill or the command line.

=== "The command line"

    ```bash
    ~/.anti-hall/ah-engine/bin/ah-engine settings show                      # common settings, one table per section
    ~/.anti-hall/ah-engine/bin/ah-engine settings show --section jev --all  # one section, with advanced settings
    ~/.anti-hall/ah-engine/bin/ah-engine settings get autoHandover.pct
    ~/.anti-hall/ah-engine/bin/ah-engine settings set limitConserve.threshold 90
    ~/.anti-hall/ah-engine/bin/ah-engine settings reset limitConserve.threshold
    ```

    Every command takes `--json` for scripts.

## Which value wins

From highest to lowest:

1. an `ANTIHALL_*` environment variable;
2. `~/.anti-hall/settings.json`;
3. a value set in the `/config` panel;
4. an older per-feature config file (for example `~/.anti-hall/jev.json`);
5. the default.

The **Source** column of `settings.js show` tells you which one answered.

!!! note "A `/config` value equal to the default"
    The `/config` panel cannot tell "set to the default" apart from "never set". To pin a
    value that equals the default, set it in `settings.json` instead.

## Safety settings { #safety-settings }

Some settings protect you from destructive actions: the four `safety.*` guards
(`gitGuard`, `commandGuard`, `editGuard`, `swarmGuard`) and the settings that weaken them.
They are marked **safety** in the reference.

Changing one of these in the risky direction (turning a guard off, adding to an allow
list) needs confirmation. Without it nothing changes, and you get one plain line saying
what would stop being protected. A direct request from you counts as confirmation;
otherwise the assistant shows you that line and asks. On the command line, add
`--confirmed`. Turning a guard back on never needs confirmation.

## Codex

Codex has no `/config` panel. Use the `anti-hall-settings` skill or the command line;
both read and write the same `~/.anti-hall/settings.json`.
