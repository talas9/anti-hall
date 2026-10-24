---
name: anti-hall-engine-mesh
description: "Use when you need to read workspace messages, unread counts or the per-project mailbox through the engine."
---

# Mesh

Read the DevSwarm message store and per-project mailboxes.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine mesh` | `<unread\|dump\|read <id>> [--db <devswarm.db>] [--since <n>] [--last <n>] \| roster --db <devswarm.db> \| <mesh verb argv>` DevSwarm mesh store (D45) | main, codex, workspace*, subagent |
| `ah-engine proj` | `<cwd> <put\|take\|len\|set\|setex\|get> [args]` Per-project state in hot.db: a mailbox (put, take, len) and key-value pairs (set, setex with a... | main, codex, workspace* |

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._
