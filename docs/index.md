---
title: Home
description: Verify-first guardrails for Claude Code and Codex. Hooks that block made-up APIs, force-pushes, AI commit credit and unverified "done" claims.
hide:
  - navigation
  - toc
---

<div class="ah-hero" markdown>

![anti-hall](assets/logo.svg)

# anti-hall

<p class="ah-tagline">Make Claude Code and Codex <strong>check before they claim</strong>.</p>

[Install](start/install.md){ .md-button .md-button--primary }
[See the guards](features/guards.md){ .md-button }

</div>

## What it is

anti-hall is a plugin for **Claude Code**, with a separate port for **Codex**. It adds
hooks (small programs the assistant's harness runs before and after each step) and a set
of skills you can call by name. Together they stop the assistant from:

- **stating things it has not checked**: a library function that does not exist, "it
  works" without running anything, "done" with tasks still open;
- **taking risky git actions**: force-pushes, and AI credit lines in commit messages and
  GitHub PR, issue or release text;
- **flooding your main conversation**: heavy commands and file edits go to helper agents,
  and runaway agent spawning is capped.

It is pure Node.js with no dependencies. It runs on macOS and Linux (including WSL on
Windows). Everything it keeps stays on your machine, apart from one update check, which
you can turn off ([details](#network-and-privacy)).

<div class="grid cards" markdown>

- :material-check-decagram: **Verify first**

    No claim without a check: speculation, "done" and made-up APIs are sent back.

- :octicons-shield-check-16: **Safe git**

    No force-pushes, no AI credit lines in commits or GitHub text.

- :material-speedometer: **Fast**

    A Rust engine answers hooks from memory; Node is the exact fallback.

</div>

## Install in one minute

You need **Node.js 22 or newer** on your `PATH` (`node --version`).

=== "Claude Code"

    ```text
    /plugin marketplace add talas9/anti-hall
    /plugin install anti-hall@anti-hall
    ```

=== "Codex"

    ```bash
    git clone https://github.com/talas9/anti-hall.git
    node anti-hall/plugins/anti-hall/codex/install-codex.js --global
    ```

Then add `.anti-hall/` to your project's `.gitignore`, because anti-hall keeps per-project
session notes there. To check it works, ask the assistant **"is anti-hall working"**.
Full steps: [Install](start/install.md).

## What you'll notice in your first session

Most of anti-hall is quiet. You will see it when the assistant tries one of the things it
is there to stop. Each message says what was stopped, why, and what to do instead. The
assistant reads it and changes course; you rarely need to do anything.

**The assistant tries to force-push.** The command never runs:

<div class="ah-term" markdown>

```text
⛔ anti-hall · git-guard: force push is blocked.
Why: Rewriting published history is a deliberate human action.
Do instead: do it manually with explicit owner confirmation, never from an automated push.
```

</div>

**The assistant guesses instead of checking.** A reply that ends on "probably" with
nothing to back it up is sent back once:

<div class="ah-term" markdown>

```text
⛔ anti-hall · speculation-guard: your reply states something speculative ('probably')
without verifying it or flagging it as unverified.
Why: Unverified claims read as facts.
Do instead: verify it with a tool, or say what is unverified ('I don't know, here is what
I would check'), then continue.
```

</div>

**The main session runs a long command itself.** Builds, test suites and deploys go to a
helper agent, which returns a short summary instead of pages of output:

<div class="ah-term" markdown>

```text
⛔ anti-hall · command-guard: heavy command (verb: npm) blocked in the main thread.
Why: Raw output floods the main thread.
```

</div>

**Other things you will see:**

- Work is tracked as a task list, and the assistant is asked not to stop while tasks are
  still open ([Task tracking](features/tasks.md)).
- When the context window reaches 85%, the assistant writes a handover file and suggests
  `/compact` or `/clear` ([Handovers and context](features/handovers.md)).
- An optional two-line statusline shows your project, git state, model, context use and
  agent activity ([Statusline](features/statusline.md)).

Not happy with a check? Every guard has a setting, and you can tell the assistant to
skip one for a short while. See [Turning a check off](troubleshooting.md#turning-a-check-off).

## Network and privacy

There is no telemetry or analytics. One request is on by default: an update check to
GitHub (a tag-list request with no project data), which you can turn off with the
`versionAlerts.antiHall` setting. The optional classifier features (Jev, the semantic judge,
mesh triage) are off by default and only send the text they judge to the provider you
configure. Everything else stays in `~/.anti-hall/` and `<repo>/.anti-hall/`. The full
table is in [PRIVACY.md](../PRIVACY.md).

!!! tip "Not happy with a check?"
    Every guard has a setting, and you can tell the assistant to skip one for a short
    while. See [Turning a check off](troubleshooting.md#turning-a-check-off).

## Where next

<div class="grid cards" markdown>

- :material-rocket-launch: **[Getting started](start/install.md)**

    Install, update and uninstall on Claude Code and Codex.

- :material-shield-check: **[Guards and checks](features/guards.md)**

    What each guard stops and how to turn it off.

- :material-speedometer: **[Rust engine](features/engine.md)**

    One resident process answers hooks fast; Node is the safety net.

- :material-tune: **[Settings](settings/index.md)**

    Every setting with its default, generated from the code.

- :material-lifebuoy: **[Troubleshooting](troubleshooting.md)**

    The doctor, common messages, and what they mean.

- :octicons-git-pull-request-16: **[Contributing](contributing.md)**

    Branch flow, tests, and where the contributor docs live.

</div>
