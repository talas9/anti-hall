---
title: Troubleshooting
description: Run the doctor, understand common anti-hall messages, and turn a check off.
---

# Troubleshooting

## Start with the doctor

Ask **"is anti-hall working"**, or run `/anti-hall:doctor`. The doctor checks that Node is
found and every hook is present and valid, then runs live self-tests to confirm the guards
actually fire. It also checks optional integrations (oh-my-claudecode, Codex, DevSwarm)
only when they are present.

| Command | What it does |
|---|---|
| `/anti-hall:doctor` | Check everything and report. |
| `/anti-hall:doctor --repair` | Also apply safe fixes, such as adding `.anti-hall/` to `.git/info/exclude`. |
| `node plugins/anti-hall/hooks/doctor.js --check` | The same check from a clone, without the assistant. |

## Common problems

??? question "Nothing happens. Are the hooks running?"
    Hooks run as `node <hook>.js`. If `node` is not on the `PATH` of the shell Claude Code
    starts hooks from, every hook is skipped without an error. Check `node --version`
    (22 or newer), then restart Claude Code so a new session starts.

??? question "The statusline does not show"
    It is not installed automatically: run `/anti-hall:install-statusline`. Then restart
    Claude Code once, because the `statusLine` setting is only read at startup.

??? question "An update did not take effect"
    Run `/reload-plugins` after `/anti-hall:update`. Restart Claude Code only if a hook or
    skill path still shows the old version. Coming from 0.107.x or older: run
    `claude plugin update anti-hall@anti-hall` once, then restart.

??? question "A guard blocks something legitimate"
    Tell the assistant to skip that guard for now (it expires after 15 minutes), or turn
    the guard off with its setting. See [Turning a check off](#turning-a-check-off). If
    you think it is a bug, file it: say **"file an anti-hall bug"** (the `defects` skill)
    or [open an issue](https://github.com/talas9/anti-hall/issues/new/choose).

??? question "git-guard let a force-push through"
    `git-guard` reads the command text. It sees through `bash -c`, aliases defined in the
    command, `xargs` and common wrappers, but not a shell alias or function defined in
    your shell profile. See [what guards do not do](features/guards.md#what-guards-do-not-do).

??? question "anti-hall files show up in `git status`"
    Add `.anti-hall/` to your `.gitignore`, or run `/anti-hall:doctor --repair`.

## What the messages mean

Every block message has the same shape:

```text
⛔ anti-hall · <guard>: <what was stopped>
Why: <the reason>
Do instead: <the other path>
```

The assistant is meant to read it and take the other path. You only need to act if you
disagree with the block.

| Message starts with | Means | Usually |
|---|---|---|
| `git-guard: force push is blocked` | A force-push was attempted. | Push normally, or do the force-push yourself if you really mean it. |
| `git-guard: a commit message with an AI/assistant self-credit trailer` | The commit carried a `Co-Authored-By` or "Generated with" line. | The assistant re-runs the commit without it. |
| `command-guard: heavy command ... blocked in the main thread` | The main session tried to run a long command itself. | The assistant hands it to a helper agent. |
| `edit-guard: Edit blocked` | The main session tried to edit a project file itself. | The assistant hands the edit to a helper agent. |
| `speculation-guard: your reply states something speculative` | A reply ended on an unchecked guess. | The assistant checks, or says what is unverified. |

The first symbol tells you the kind: ⛔ is a block, ⚠️ a warning and 💡 a tip. The
root-cause nudge after a failed command, for example, is a 💡 tip:

```text
💡 anti-hall · root-cause: this command failed (...).
Do instead: before retrying or patching, trace WHY it failed (see /anti-hall:root-cause)
rather than guessing a fix from the symptom.
```

## Turning a check off { #turning-a-check-off }

**For a few minutes:** tell the assistant, for example "skip the tasklist-guard for now".
It records your consent in `~/.anti-hall/skip.json`, and the skip expires after 15 minutes
by default. A skip for `"all"` never covers `git-guard`; that one has to be named.

**For good:** turn off its setting. Say "turn off the speculation guard", or use the
command line:

```bash
node plugins/anti-hall/scripts/settings.js set guards.speculationGuard false
```

The four `safety.*` guards need confirmation to turn off
([Safety settings](settings/index.md#safety-settings)). The setting for each guard is in
[Guards and checks](features/guards.md#the-main-guards).

| To quiet | Setting |
|---|---|
| The root-cause nudge after a failed command | `guards.failureRootCauseNudge` |
| The silent-agent nudge | `guards.silentAgentNudge` |
| Handover reminders | `autoHandover.nag` |
| The Codex hand-off nudge | `codexNudge.enabled` |
| Limit-conservation advice | `limitConserve.mode` = `off` |
| The update check | `versionAlerts.antiHall` |

## Still stuck

- Search these docs (press ++slash++ or ++s++).
- [Ask a question or report a bug](https://github.com/talas9/anti-hall/issues/new/choose).
- Everything in one place: [the full guide's troubleshooting section](GUIDE.md#troubleshooting--faq).
