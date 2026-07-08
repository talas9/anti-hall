---
name: anti-hall-update
description: Check or update anti-hall from the local marketplace clone. Use when the user asks to update anti-hall, check whether anti-hall is current, or refresh the Codex port files.
---

# anti-hall update for Codex

## Resolve the plugin root

Codex does not expand `${PLUGIN_ROOT}` inside a skill's own instructions — that
variable is only set for plugin-bundled hook commands (see
`docs/KB-codex-platform-hooks-plugins.md`). Codex does show you this skill's own
file path when it selects the skill ("Codex starts with each skill's name,
description, and file path" — official Codex Skills doc). Resolve the plugin
root from that path before running anything below:

```bash
# SKILL_FILE = the absolute path Codex showed you for this SKILL.md.
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

Use the existing pure-Node update helper:

```bash
node "$ANTI_HALL_ROOT/skills/update/scripts/update.js" --check
node "$ANTI_HALL_ROOT/skills/update/scripts/update.js"
```

For Codex, also re-run the Codex hook installer after a successful update:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js"
```

or for global Codex hooks:

```bash
node "$ANTI_HALL_ROOT/codex/install-codex.js" --global
```

Do not force-pull, rebase, or delete plugin cache directories. If the update helper reports a dirty tree, diverged branch, offline state, or missing marketplace clone, surface that result and stop.

After a successful update, also run the capability scan to find what's missing on this machine vs what this build ships:

```bash
node "$ANTI_HALL_ROOT/scripts/capability-scan.js"
```

Read-only — it never installs anything. It reports each opt-in capability (companions under `companion/install-*.js`, statusline, pending state migrations) as `{name, available, active, how}`. Present a concise available-vs-active summary:
- `state-migrations` at `active: false` — run `node "$ANTI_HALL_ROOT/scripts/migrate-state.js"` (idempotent, safe to re-run) to fold it, same as the Claude-side update flow.
- **DevSwarm liveness supervisor** — **autonomously install-or-refresh it
  whenever this update is running inside a DevSwarm session, no offer, no
  ask.** Check `devswarm-detect`'s `isDevswarmActive(process.env)` — true only
  when `DEVSWARM_REPO_ID` is set, i.e. the current session really is a DevSwarm
  workspace (do NOT trigger on machine-level descriptor presence alone; the
  session might be running outside DevSwarm). If inside a DevSwarm session, run
  its `how` command (`node companion/install-devswarm-supervisor.js`)
  regardless of the capability scan's `active` value. The installer is
  idempotent (`launchctl unload && load` on macOS / systemd reload on Linux),
  so this both first-installs when absent and refreshes an already-installed
  supervisor so the next sweep runs this build's code. **Report it** plainly
  ("DevSwarm session detected — installed/refreshed the liveness supervisor to
  `<version>`"). Fail-open: an install/refresh failure is reported, never fatal
  to the update. If NOT inside a DevSwarm session, do **not** install — just
  note it's available. (Safe to do unprompted: the supervisor's automatic
  sweep never kills — killing is only the separate on-demand
  `devswarm-recover` CLI. Defense in depth: the installed daemon is inert
  without work — it only ever acts on descriptors under
  `~/.anti-hall/devswarm/workspaces/`, so it no-ops when DevSwarm isn't
  actually running.)
- Any other opt-in capability at `active: false` (e.g. mcp-reaper — no
  active-integration signal) — guide, don't auto-install: print its `how`
  command and let the user decide.
- `active: 'unknown'` — the probe couldn't determine state (fail-open); mention it as unverified rather than claiming either state.
- `active: true` for everything — say so briefly; no gaps to report.

After updating, restart Codex or start a fresh session if plugin/skill discovery does not reflect the new files immediately.
