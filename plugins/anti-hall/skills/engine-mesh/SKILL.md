---
name: engine-mesh
description: "Use when you need to read workspace messages, unread counts or the per-project mailbox through the engine."
---

# Mesh

Read the DevSwarm message store and per-project mailboxes.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine mesh` | `<unread\|dump\|read <id>> [--db <devswarm.db>] [--since <n>] [--last <n>] \| roster --db <devswarm.db> \| <mesh verb argv>` DevSwarm mesh store (D45) | main, codex, workspace*, subagent |
| `ah-engine proj` | `<cwd> <put\|take\|len\|set\|setex\|get> [args]` Per-project state in hot.db: a mailbox (put, take, len) and key-value pairs (set, setex with a... | main, codex, workspace* |

## Switches

- `devswarm.wakeWatch` = true: Workspace wake-watch switch (default on): off never arms it, cron fallback stays
- `devswarm.wakeWatchCoalesce` = true: The setting devswarm.wakeWatchCoalesce (default on; GH #884): one wake per state change, not one...
- `devswarm.wakeWatchIdleSkip` = true: The setting devswarm.wakeWatchIdleSkip: a Primary with no live child workspace need not arm...
- `devswarm.wakeWatchPollMs` = 2000: The setting devswarm.wakeWatchPollMs: the tick of the watcher in milliseconds (lock heartbeat,...
- `devswarm.wakeWatchRewakeMs` = 600000: The setting devswarm.wakeWatchRewakeMs: how long after a wake held mail waits before a child...
- `devswarm.wakeWatchRearmCooldownMs` = 1800000: Minimum gap between watcher arm orders, milliseconds

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._
