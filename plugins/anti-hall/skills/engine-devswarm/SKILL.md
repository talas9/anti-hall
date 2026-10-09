---
name: engine-devswarm
description: "Use when working in or with DevSwarm workspaces and a DevSwarm gate, role directive or wake guard applies."
---

# DevSwarm

The DevSwarm role, gate and wake guards.

## Verbs

| Verb | What it does | Roles |
|---|---|---|
| `ah-engine devswarm` | `<status\|line\|supervisor\|ingest\|recover --id <ws> --request <id>\|advisory --session <id>\|archive --id <ws> --request <id>\|plan-prune --older-than <days>\|prune --confirm-ids <ids> --plan <nonce>\|help [<verb>]\|skip <guard> [--ttl <min>]\|archive-ignore <id>\|archive-unignore <id>\|gate-intent --reason <text>\|notice --list\|plan set\|show <id>\|scope add <id> --glob <g> --note <t>\|gate <id> --set <csv> --clear <csv>\|workspaces list\|logs [--limit <n>]\|wake-directive <id>\|ready-check <sha> [--base <ref>]\|app-state [--json]\|app-sync [--dry-run]\|done [--summary <text>]\|primary [status\|takeover] [--session <id>]\|relay <seq> --to <id> [--note-file <path>]\|archive-request <childId> [--reason <text>]\|nudge <id>\|supervision-report [--days <n>] [--json]\|sync-ui --titles-json <file> [--yes]\|retention status\|run [--dry-run] [--store <key>]>` The DevSwarm realtime state and owner actions (lane dswire) | main, codex, workspace, subagent (owner args: archive, plan-prune, prune, recover, create, merge, skip, archive-ignore, archive-unignore, gate-intent, notice) |

## Guards

- `devswarm-version`: SessionStart advisory: the DevSwarm CLI drifted by major or minor from the verified version (port of devswarm-version.js); a stale cache...
- `devswarm-comms-guard`: Blocks SendMessage to a peer session whose cwd is a DevSwarm workspace while DevSwarm is active, and labels other known targets (port of...
- `devswarm-parent-inbox`: DevSwarm Primary prompt hook: answers the silent cases (not a Primary, DevSwarm inactive, switch off, judge child) in the engine; an...
- `devswarm-child-turn`: DevSwarm child prompt hook: answers the silent cases (not a child workspace, DevSwarm inactive, switch off, judge child) in the engine;...
- `devswarm-child-role`: SessionStart: injects the DevSwarm mesh-only messaging directive for a child workspace (port of devswarm-child-role.js); a Primary...
- `devswarm-parent-gate`: Stop: allows without running Node when the Node gate would exit silently before reading any mailbox (switch off, user skip, supervisor...
- `devswarm-child-gate`: DevSwarm child Stop gate: allows the stop when the hook cannot act (switch off, skip recorded, not a DevSwarm child); a child workspace...
- `devswarm-parent-reply-tracker`: DevSwarm Primary reply tracker: allows every Bash call that is not a devswarm send (switch off, child workspace, other tool, command...
- `devswarm-child-drain`: DevSwarm child mailbox drain nudge: allows the call when the hook cannot act (switch off, not a DevSwarm child) and when it would stay...
- `devswarm-rt-advisory`: Tells the main session which DevSwarm workspace changes (stuck, CI, PR, lifecycle) it has not seen yet; engine-only

## Switches

- `devswarm.inboxCmd` = "": devswarm.inboxCmd: a consumer-configured command to read pending mesh messages (no default)
- `devswarm.dispatchTierText` = true: devswarm.dispatchTierText: the DevSwarm Primary dispatch-tier text (default on)
- `devswarm.childTurn` = true: Where the devswarm.childTurn switch (default on) is read from: no environment variable, then settings.json, then the plugin option
- `devswarm.parentInbox` = true: Where the devswarm.parentInbox switch (default on) is read from: no environment variable, then settings.json, then the plugin option
- `devswarm.inboxReadGuard` = true: Where the on/off switch is read from (devswarm.inboxReadGuard, default on; it has no environment variable)
- `devswarm.heldPartitions` = "": Where the owner's held workspace ids are read from: devswarm.heldPartitions (a comma-separated list) through the engine's settings layer...
- `devswarm.stepStallMin` = 30: Where the quiet-child window is read from: devswarm.stepStallMin (minutes) through the engine's settings layer (the environment...
- `devswarm.strayWarnMax` = 2: Where the most straying warnings per signal and step are read from: devswarm.strayWarnMax (0 turns warnings off) through the engine's...
- `devswarm.commsGuard` = true: The switch devswarm.commsGuard (on by default); off makes the guard a no-op
- `devswarm.childRole` = true: Switch devswarm.childRole (default on): off makes the SessionStart hook a no-op
- `devswarm.parentGate` = true: Switch devswarm.parentGate (default on): off makes the Stop gate a no-op
- `devswarm.rearmOnTickOnly` = true: Switch devswarm.rearmOnTickOnly (default on): re-arm a lapsed monitor only from the cron tick, never inline on the monitor's own expiry
- `devswarm.stableLauncher` = true: Switch devswarm.stableLauncher (default on): point the injected text at the version-independent launchers under the anti-hall bin...
- `devswarm.wakeCron` = "7,37 * * * *": Setting devswarm.wakeCron: the cron schedule of the mailbox-wake job, untrusted text that is validated before it is injected
- `devswarm.childDrain` = true: Where the devswarm-child-drain on/off switch is read from (devswarm.childDrain, default on; no environment variable)
- `devswarm.childGate` = true: Where the devswarm-child-gate on/off switch is read from (devswarm.childGate, default on; no environment variable)
- `devswarm.parentReplyTracker` = true: Where the devswarm-parent-reply-tracker on/off switch is read from (devswarm.parentReplyTracker, default on; no environment variable)
- `devswarm.drainTtlMs` = 600000: The drain marker time to live: the settings entry (section and key; its environment variable and bounds are in migrate_settings.toml)...
- `devswarm.monitorNoOkFailMin` = 10: Where devswarm.monitorNoOkFailMin is read from (minutes without a successful monitor poll before the daemon reads FAILING)
- `devswarm.spawnCreateTimeoutMs` = 180000: Timeout of `workspace create` in ms
- `devswarm.dormantMs` = 1800000: How long a workspace whose session transcript resolves may stay silent before the roster calls it dormant (Node: devswarm.dormantMs, a...
- `devswarm.monitorTimeoutSec` = 30: The -t of every monitor call: it long-polls at most this long, then exits (an empty exit is a quiet poll, not an error)

_Generated from the engine registry by `ah-engine docs --format skill`; do not edit by hand._
