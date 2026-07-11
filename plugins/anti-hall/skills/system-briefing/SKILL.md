---
name: system-briefing
description: Brief the agent that installs or operates anti-hall on how the whole system works — a DERIVED, live enumeration of every installed hook (grouped by event, each with its own one-line purpose), the shipped skills, the DevSwarm coordination substrate (mechanical triggers, store, CLI, auto-safe migration), and a docs/KB map. Generated from the actual hooks.json and the files on disk, never a hardcoded list, so it can't drift. Use when the user asks "brief me on anti-hall", "what's in this build", "how does the whole system work", "give me the anti-hall system overview", "what hooks/skills/substrate ship here", or when onboarding an agent to install or run anti-hall. For "is it actually working / do the guards fire", use the `doctor` skill instead.
---

# System briefing

The orientation companion to `doctor`. Where **doctor** answers *"is it running and do
the guards actually fire?"* (behavioral self-tests), **briefing** answers *"what IS this
build and how is it wired?"* — a complete, current inventory for the agent that installs
or operates anti-hall.

The briefing is **DERIVED, not written down.** It is generated live by
`scripts/briefing.js`, which reads the real `hooks/hooks.json` and the files on disk and
pulls each item's one-line purpose from that file's own header comment. Nothing here is a
hardcoded list, so a renamed hook, a new skill, or a changed substrate file updates the
briefing automatically — it cannot go stale.

## What it enumerates

- **Hooks, grouped by event** (`SessionStart` / `UserPromptSubmit` / `SubagentStart` /
  `Stop` / `PreToolUse`), each with its matcher and a one-line purpose read from the hook's
  own header — derived strictly from `hooks.json`, so the list is exactly what is wired.
- **Shared helpers** — the `.js` files in `hooks/` (and `hooks/lib/`) that are *not*
  registered as hooks (e.g. `coordinator-detect.js`, `verify-first-core.js`,
  `devswarm-detect.js`).
- **Skills** — every `skills/*/SKILL.md`, by name + description (from its frontmatter).
- **DevSwarm coordination substrate** — the four mechanical triggers
  (`devswarm-parent-inbox` / `devswarm-parent-gate` / `devswarm-child-turn` /
  `devswarm-child-gate`, plus the `devswarm-child-role` SessionStart layer), the store
  (`companion/lib/devswarm-store.js`), the CLI (`scripts/devswarm.js` + its subcommands),
  the auto-safe migration (`companion/devswarm-migrate.js` / `devswarm-ingest.js`), and the
  liveness supervisor + on-demand recovery.
- **docs / KB map** — each `docs/KB*.md` with its first heading, when the repo `docs/` tree
  is present (`docs/` is repo-clone-only; it does **not** ship with `/plugin install`, so an
  installed-plugin briefing notes that and points at the repo).

## How to run

`scripts/briefing.js` is a `node` script, and `command-guard` blocks heavy commands on the
main thread, so **delegate it to a Haiku subagent** (`model:"haiku"`) and relay the output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/briefing.js"          # human-readable briefing
node "${CLAUDE_PLUGIN_ROOT}/scripts/briefing.js" --json    # machine-readable, same data
```

Read-only and fail-soft: any unreadable section prints a note and the rest still renders.

## After the briefing

- To confirm the system is actually **live** (Node found, hooks syntax-valid, guards fire),
  run the **`doctor`** skill.
- For the DevSwarm layer specifically (activation, tunables, recovery), see the
  **`devswarm`** skill and `docs/KB-devswarm-hivecontrol.md`.
