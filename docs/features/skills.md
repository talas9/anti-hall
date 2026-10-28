---
title: Skills
description: The anti-hall skills you can call by name, and when to use each.
---

# Skills

Skills are step-by-step playbooks the assistant loads when you ask for them. In Claude
Code, call one as `/anti-hall:<name>`, or just describe what you want ("is anti-hall
working", "write a handover") and the matching skill is picked.

## Working well

| Skill | Use it when | What it does |
|---|---|---|
| `root-cause` | A bug, crash, failing or flaky test, "why is X failing" | Evidence first: reproduce, collect evidence, add logging if it is missing, prove the cause, then fix it and verify. No proven cause, no fix. |
| `ship-it` | Building a feature or fixing something, small or large | Scales to the size of the change: plan in plan mode, review the plan, build in phases, and verify each phase with fresh evidence. |
| `deadly-loop` | Before merging something risky (security, data, shell, CI, prompts) | Parallel Reviewer, Auditor and Critic agents debate the change and fix what they find, round after round, until no new serious findings appear. |
| `deadly-loop-multi` | You want a deeper review | Two to four deadly-loop passes in parallel, each with a different focus. |
| `orchestration` | Heavy, long or parallel work | Keeps the main session free: helper agents run in the background in parallel, and the main session checks their results. |
| `simplify` | "Simplify this", "deslop", over-engineered code | A cleanup that keeps behaviour the same and reports the net line change. |
| `debt` | Tracking a deliberate shortcut | Registers and audits `// anti-hall:` debt markers so shortcuts do not rot unnoticed. |
| `handover` | Before `/compact` or `/clear`, or at the end of a session | Writes a complete session handover. See [Handovers](handovers.md). |

## Running anti-hall

| Skill | Use it when | What it does |
|---|---|---|
| `doctor` | "Is anti-hall working?" | Live self-tests on every guard. `--repair` applies safe fixes. |
| `settings` | "Turn off X", "set auto-handover to 80%" | Shows or changes settings. See [Changing settings](../settings/index.md). |
| `update` | "Update anti-hall", "is anti-hall up to date" | Updates in place and shows the changelog. See [Update](../start/update.md). |
| `activate` | First-time setup | Installs the model-routing state; it does not add a Claude `statusLine`. |
| `install-statusline` | Old statusline muscle memory | Retired no-op. Use `uninstall-statusline` only to clean up older anti-hall `statusLine` installs. See [Statusline](statusline.md). |
| `system-briefing` | "Brief me on anti-hall", "what does X mean" | An operator guide to the terms, rules, commands and settings, with a live list of what is installed. |
| `defects` | "File an anti-hall bug", "did they fix my report" | Files and tracks reports about anti-hall itself. |
| `jev` | "Activate jev", "jev report" | Sets up and reports on the optional Jev classifier. |
| `devswarm` | Using DevSwarm workspaces | Explains and tunes the optional DevSwarm integration. See [DevSwarm](devswarm.md). |

## On Codex

The Codex port has its own skill set, named `anti-hall-<name>` (for example
`anti-hall-root-cause`, `anti-hall-doctor`). It mirrors most of the skills above, with
some differences where Codex works differently, such as no `/config` panel. The list is in
[the Codex port README](../../plugins/anti-hall/codex/README.md).

Every skill in detail: [Skills reference](../GUIDE.md#skills-reference-detailed).
