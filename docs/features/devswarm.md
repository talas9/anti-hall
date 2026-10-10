---
title: DevSwarm workspaces
description: anti-hall's optional integration with DevSwarm, an app that runs many agent workspaces side by side.
---

# DevSwarm workspaces

[DevSwarm](https://devswarm.ai/) is a desktop app that runs several coding-agent
workspaces side by side, each on its own branch, driven from a `hivecontrol` CLI.
anti-hall has an optional integration for it.

!!! info "Optional and dormant"
    Nothing here runs unless you are in a DevSwarm session or have installed one of its
    companions. The rest of anti-hall does not depend on it.

## The idea

One session is the **Primary**: it plans the work and hands features or fixes to
**child workspaces**. Each child works on its own branch and reports back. anti-hall
handles the parts that go wrong when many agents run at once.

| Area | What anti-hall does |
|---|---|
| **Messages** | The Primary and its children talk through one mailbox per session, kept by anti-hall (`scripts/devswarm.js send`, `inbox`, `roster`). DevSwarm's own messaging is blocked so nothing is lost or read twice. |
| **One Primary** | There is one Primary per project. A new session takes the seat only when the holder has closed. |
| **Visibility** | Each turn, the Primary sees a table of its workspaces: title, state, pull request, unread messages. It is not allowed to stop with unread or unanswered questions. |
| **Recovery** | A stuck child is handled in layers: the child reports itself, a supervisor nudges it, then the Primary is told. The automatic path never kills a session; only the on-demand `devswarm-recover` command does. |
| **Finishing** | A child that is merged runs `devswarm.js done`. When the merge is proven (its commit is on the default branch), the workspace is archived automatically (DevSwarm 2.5.3 or newer). Deleting archived workspaces needs your approval. |
| **Ground truth** | anti-hall reads the DevSwarm app's own database (read-only) to know which workspaces exist, are archived, or have a pull request. |

## Optional companions

These are background helpers you install yourself; nothing installs them for you.

| Companion | What it does | Install from `plugins/anti-hall/companion/` |
|---|---|---|
| Liveness supervisor | Checks every 90 seconds for stuck workspaces and nudges them. | `node install-devswarm-supervisor.js` |
| Ingest daemon | Reads DevSwarm's workspace messages continuously and files them into anti-hall's message store. | `node install-devswarm-ingest.js` |

They run as a launchd agent on macOS, or a systemd user unit on Linux (cron when `systemctl` is missing). Uninstall with
`--uninstall` ([Uninstall](../start/uninstall.md#3-remove-optional-companions-if-you-installed-them)).

## Settings and help

- Every DevSwarm setting is in the `devswarm` section of the
  [Settings reference](../../plugins/anti-hall/hooks/lib/settings-schema.js).
- Ask the `devswarm` skill for anything about a stuck workspace or the supervisor.
- Background: [DevSwarm and hivecontrol](../KB-devswarm-hivecontrol.md) and
  [The DevSwarm app database](../KB-devswarm-app-db.md).
- Full detail: [DevSwarm in the full guide](../GUIDE.md#devswarm-current-state).
