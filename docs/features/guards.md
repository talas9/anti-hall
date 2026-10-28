---
title: Guards and checks
description: What each anti-hall guard stops, what its message looks like, and how to turn it off.
---

# Guards and checks

A **guard** is a hook that can stop a step before it happens (a command, an edit, an
agent spawn) or send a reply back before the turn ends. Guards are rules and patterns,
not a model, so they are fast and predictable. They can also be wrong: every guard has a
setting, and you can skip one for a short while.

## How a block looks

Every message has one leading emoji and at most two lines: what was stopped, then one
action. Messages aim for 160 characters and never exceed 250. Long instructions and
skip hints stay in a details file, linked only when the action needs them.

<div class="ah-term" markdown>

```text
⛔ git safety: commit has an AI co-author line.
Do instead: remove the Co-Authored-By line and commit again.
```

</div>

## The main guards

| Guard | What it stops | Setting to turn it off |
|---|---|---|
| `git-guard` | Force-pushes, pushes that delete a remote branch or tag, and AI credit lines in commits and in `gh` PR, issue and release text. | `safety.gitGuard` |
| `command-guard` | The main session running heavy commands (builds, test suites, deploys, pushes) itself instead of handing them to a helper agent. | `safety.commandGuard` |
| `edit-guard` | The main session editing project files itself instead of handing the edit to a helper agent. | `safety.editGuard` |
| `swarm-guard` | Spawning agents faster than the spawn-rate cap, or while memory is critically low. | `safety.swarmGuard` |
| `api-guard` | Written code that calls a standard-library or built-in function that does not exist. | `guards.apiGuard` |
| `speculation-guard` | A reply that ends on hedged, unchecked claims ("probably", "should be", "I suspect"). | `guards.speculationGuard` |
| `output-verify-guard` | "Done" or "it passes" claims with no check that was actually run. | `guards.outputVerifyGuard` |
| `task-guard` | Stopping while tracked tasks are still open. | `guards.taskGuard` |
| `tasklist-guard` | Multi-step work with no task list or no fresh progress file. | `guards.tasklistGuard` |
| `model-routing-guard` | Spawning a helper agent on a model tier that does not fit the job. | `guards.modelRouting` (`strict`, `advisory` or `off`) |

The four `safety.*` guards are **locked**: turning one off needs your direct request or a
confirmation (see [Changing settings](../settings/index.md#safety-settings)). All settings,
including the opt-in gates (`guards.mergeGate`, `guards.shipitGate`), are in the
[Settings reference](../../plugins/anti-hall/engine/defaults/settings_cli.toml).

## Why the main session hands work off

`command-guard` and `edit-guard` keep the main conversation (the "coordinator") small.
Long command output and file edits go to helper agents, which return a short summary. The
coordinator keeps the overview and checks each helper's result instead of trusting it.

<div class="ah-term" markdown>

```text
⛔ command check: this heavy command was stopped in the main thread.
Do instead: hand the command to a helper agent.
```

</div>

Short checks are still allowed in the main session, such as one or two test files piped
to `tail`, or a `--check` / `--dry-run` run. Long instructions and skip hints are saved in
`~/.anti-hall/block-details/`. A message links its details file only when the action needs it.

## Checking claims

`speculation-guard` reads the assistant's last reply when the turn ends. If it states
something with a hedge word and does not say it is unverified, the reply is sent back
once:

<div class="ah-term" markdown>

```text
⛔ claim check: your reply makes an unverified claim ("probably").
Do instead: verify the claim or label it unverified.
```

</div>

Honest hedging passes: a reply that says "I haven't checked" or "not verified", cites a
`file:line`, or says it will verify, is not blocked. The same reply is never blocked twice,
so a session cannot get stuck in a loop.

This check only sees hedge words. Two optional checks also look at confident claims with
no hedge word; both are **off by default** because, when measured, they were wrong too
often or added a delay to every turn. See
[Opt-in checks for confident claims](../GUIDE.md#opt-in-checks-for-confident-claims).

## The verify-first protocol

Besides the guards, anti-hall adds a short set of working rules to each session (verify
before claiming, prove the cause before fixing, check delegated work), and a one-line
reminder each turn. The rules are added again after a compaction. `context.protocolLevel`
switches between the compact text (default) and the full text.

## Skipping a guard for a while

If a guard is in your way, tell the assistant, for example **"skip the speculation-guard
for now"**. It records your consent in `~/.anti-hall/skip.json`, per guard and per session
(key `<guard>@<session-id>`), and the skip expires after 15 minutes by default. A skip
applies only to the session that set it; `--global` (owner-set) covers every session.

- `"all"` covers the noisy guards at once, but **never** `git-guard`. To skip that one,
  name it.
- If the skip file is missing or damaged, the guards stay **on**.

To turn a guard off for good, use its setting instead:
[Turning a check off](../troubleshooting.md#turning-a-check-off).

## What guards do not do

- They read command text; they do not run it. `git-guard` sees through `bash -c`, git and
  shell aliases defined in the command, `xargs`, `find -exec` and common wrappers, but not
  a shell alias or function from your shell profile.
- A commit message written in an editor or by a `commit-msg` hook does not exist before
  the commit. It is checked right after, and the assistant is told to reword it.
- Writes made through the shell are checked for common forms (`cat >`, `tee`, `sed -i`).
  A variable or glob as the target, `dd`, `install`, `rsync` and scripts that write when
  they run are let through.
- Hooks are built to fail open: if one hits an error (bad input, a file it cannot read),
  it lets the step through rather than wedging your session. A skip file is the
  exception, as noted above.

The complete list of limits: [Limits and escape hatches](../GUIDE.md#limits-and-escape-hatches).
Every hook in detail: [the full guide](../GUIDE.md#hook-reference--plugin-features-table-detailed-per-hook).
