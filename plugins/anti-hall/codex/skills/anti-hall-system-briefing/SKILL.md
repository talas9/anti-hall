---
name: anti-hall-system-briefing
description: Brief the agent that installs or operates anti-hall (in Codex/OMX) on how the whole system works — a DERIVED, live enumeration of every installed hook, the shipped skills, the DevSwarm coordination substrate (mechanical triggers, store, CLI, auto-safe migration), and a docs/KB map. Generated from the real hooks.json and files on disk, never a hardcoded list, so it can't drift. Use when the user asks "brief me on anti-hall", "what's in this build", "how does the whole system work", or when onboarding an agent to install/run anti-hall. For "is it actually installed in Codex / do the guards fire", use anti-hall-doctor.
---

# anti-hall system briefing for Codex

The orientation companion to `anti-hall-doctor`. Where **doctor** answers *"is it installed
and do the guards fire?"*, **briefing** answers *"what IS this build and how is it wired?"* —
a complete, current inventory for the agent that installs or operates anti-hall.

The briefing is **DERIVED, not written down.** `scripts/briefing.js` reads the real
`hooks/hooks.json` and the files on disk and pulls each item's one-line purpose from that
file's own header comment — nothing is a hardcoded list, so it cannot drift.

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — that variable is
only set for plugin-bundled hook commands (see `docs/KB-codex-platform-hooks-plugins.md`).
Codex shows you this skill's own file path when it selects the skill. Resolve the plugin
root from that path first:

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

## Run the briefing

```bash
node "$ANTI_HALL_ROOT/scripts/briefing.js"          # human-readable briefing
node "$ANTI_HALL_ROOT/scripts/briefing.js" --json    # machine-readable, same data
```

It enumerates, all derived live:

- **Hooks by event** (`SessionStart` / `UserPromptSubmit` / `SubagentStart` / `Stop` /
  `PreToolUse`), each with its matcher + a one-line purpose from the hook's own header —
  straight from `hooks.json`. Note: the Codex port hard-registers only the events Codex can
  enforce (`SessionStart`, `UserPromptSubmit`, Bash `PreToolUse`, `Stop`); the Claude
  edit-time and subagent-lifecycle hooks the briefing lists are represented as Codex
  skills/protocols (run `anti-hall-doctor` for the Codex-specific install posture).
- **Shared helpers** — `hooks/`(+`lib/`) `.js` files not registered as hooks.
- **Skills** — every `skills/*/SKILL.md` by name + description.
- **DevSwarm coordination substrate** — the four mechanical triggers, the store
  (`companion/lib/devswarm-store.js`), the CLI (`scripts/devswarm.js` + subcommands), the
  auto-safe migration (`companion/devswarm-migrate.js` / `devswarm-ingest.js`), and the
  liveness supervisor + on-demand recovery.
- **docs / KB map** — each `docs/KB*.md` with its first heading when the repo `docs/` tree
  is present (`docs/` is repo-clone-only; it does not ship with a plugin install).

Read-only and fail-soft: any unreadable section prints a note and the rest still renders.

## After the briefing

- To confirm the Codex install is live and the guards fire, run **`anti-hall-doctor`**.
- For the DevSwarm layer (activation, tunables, recovery), see **`anti-hall-devswarm`** and
  `docs/KB-devswarm-hivecontrol.md`.
