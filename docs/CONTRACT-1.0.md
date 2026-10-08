# anti-hall 1.0 contract

What semantic versioning freezes at 1.0. Anything listed here is a public surface: after
1.0, breaking it needs a MAJOR release. Anything not listed is internal and may change in
any release.

Status: **draft**, written against the `dev` branch at plugin version 0.202.0. Every item
names the file it comes from; when this document and the code disagree, the code is
right and this document gets a fix.

| Surface | Count | Source of truth |
|---|---|---|
| Settings keys | 273 in 14 sections | `plugins/anti-hall/hooks/lib/settings-schema.js` (`SECTIONS`) |
| `devswarm.js` verbs | 47 | `plugins/anti-hall/scripts/devswarm.js` (the `run()` switch; `help` lists it) |
| Other user-facing CLIs | 6 | `settings.js`, `doctor.js`, `update.js`, `migrate-state.js`, `capability-scan.js` |
| Hook scripts | 62 (72 registrations, 12 events) | `plugins/anti-hall/hooks/hooks.registry.json` (`hooks.json` itself is one thin trigger per event, generated from the engine's dispatch table) |
| Codex hook scripts | 44 (49 registrations, 7 events) | `plugins/anti-hall/codex/hooks/hooks.registry.json` (`hooks.json`: one thin trigger per event) |
| Skills | 18 Claude, 21 Codex | `plugins/anti-hall/skills/`, `plugins/anti-hall/codex/skills/` |

## 1. Settings keys

**Schema:** `plugins/anti-hall/hooks/lib/settings-schema.js`. Each entry has `key`, `type`
(`boolean`, `number`, `string`, `enum`, `csv`, `object`), `default`, and optionally `env`,
`values`, `min`/`max`, `legacy`, `pluginOption`, `advanced`, `locked`, `homeOnly`. A key is
addressed as `<section>.<key>` (for example `safety.gitGuard`, `devswarm.autoArchive.mode`).

| Section | Label | Keys | Headline keys (keep a native `/config` row) |
|---|---|---|---|
| `autoHandover` | Auto Handover | 10 | `enabled`, `pct` |
| `guards` | Guards | 74 | `modelRouting` |
| `safety` | Safety Guards | 4 | `gitGuard`, `commandGuard`, `editGuard`, `swarmGuard` |
| `context` | Context Injections | 20 | |
| `maintenance` | Maintenance | 5 | |
| `versionAlerts` | Version Alerts | 3 | |
| `updates` | Updates / Maintenance | 5 | |
| `limitConserve` | Limit Conservation | 3 | `mode` |
| `jev` | Jev (semantic decision engine) | 31 | `enabled` |
| `jevIntegrations` | Jev integration | 21 | |
| `devswarm` | DevSwarm | 92 | `supervisorMode` |
| `statusline` | Statusline | 2 | |
| `codexNudge` | Codex Nudge | 2 | |
| `defects` | Defects | 1 | |

Of the 273 keys: 137 are `advanced` (hidden from `settings.js show` without `--all`), 194
have an env override, 13 are `locked` (safety keys), 3 are `homeOnly`. The full list with
defaults is [GUIDE.md, "Every setting"](./GUIDE.md#every-setting);
`tests/hygiene/docs-coverage.test.js` fails if any schema key is missing from it.

**Precedence** (`plugins/anti-hall/hooks/lib/settings.js`, `get()` and `resolveBelowFile()`),
highest first:

1. **env**: the key's own env var (`entry.env`), then any deprecated `envAliases` (the canonical `ANTIHALL_*` name wins when both are set), when the value parses for the key's type. `guards.scanThrottle` and `maintenance.sessionEndReaper` keep their old `ANTI_HALL_SCAN_THROTTLE` / `ANTI_HALL_SESSION_END_REAPER` names as aliases.
   Booleans accept `1/on/true/yes` and `0/off/false/no`, case-insensitive; anything else
   falls through.
2. **user settings file**: `~/.anti-hall/settings.json`, `[section][key]` (a dotted key may
   also be nested).
3. **plugin option**: `CLAUDE_PLUGIN_OPTION_<KEY>` in hook processes, or
   `pluginConfigs["anti-hall"].options` in `~/.claude/settings.json` for other processes.
4. **legacy file**: the pre-`settings.json` config file named in `entry.legacy` (for
   example `~/.anti-hall/jev.json`). Until the one-time settings migration is stamped for
   the installed version, this tier is read before tier 3.
5. **default**: the caller's `dflt` argument, else the schema default.

There is **no project-level settings tier**: the resolver reads no file inside the repo.
`homeOnly` keys skip tiers 1, 3 and 4 (only `settings.json`, then default), so a project's
`.claude/settings.json` `env` block cannot flip them. `locked` keys read through the same
chain; only writing them in the risky direction needs `--confirmed`.

**Frozen at 1.0:**

| Change | Bump |
|---|---|
| Rename or remove a key, or move it to another section | MAJOR |
| Change a default's meaning (`true` to `false`, a wider allow-list, different units) | MAJOR |
| Rename or remove a key's env var or plugin-option name | MAJOR |
| Narrow a key's accepted values (drop an enum value, tighten `min`/`max`) | MAJOR |
| Reorder the precedence tiers | MAJOR |
| Add a key, an enum value, or an env alias | MINOR |
| Retune a default within the same meaning (a timeout, a retention count) | MINOR |
| Move a key into or out of `advanced` (display only; its plugin-option name stays readable) | PATCH |

A removed key must keep being read as a legacy source for one MAJOR cycle, and its value
forward-migrated (`companion/lib/migrations.js` `migrateSettingsFromLegacy`).

## 2. CLI verbs

### `scripts/devswarm.js`

Source: the `run()` switch in `plugins/anti-hall/scripts/devswarm.js`. `devswarm.js help`
(and `help --short`, `help <verb>`, `<verb> --help`, `-h`) lists the verbs from that switch,
and so does the `unknown command:` error, so neither can drift from the dispatcher. 47 verbs:

| Group | Verbs |
|---|---|
| Identity and status | `primary`, `register`, `ensure`, `register-primary`, `heartbeat`, `done`, `gate`, `gate-intent`, `plan`, `scope` |
| Messaging | `inbox`, `send`, `relay`, `mesh`, `wake-directive`, `notice` |
| Lifecycle | `archive`, `unarchive`, `archive-ignore`, `archive-unignore`, `archive-request`, `auto-archive`, `prune-archived`, `reap-orphans`, `reap-stale`, `respawn`, `correct`, `nudge`, `spawn`, `merge` |
| Repair and migration | `migrate`, `migrate-owner-keys`, `reconcile`, `reconcile-registry`, `reconcile-active`, `retention` |
| Read-only views | `workspaces`, `roster`, `logs`, `diagnose`, `healthcheck`, `ready-check`, `supervision-report`, `app-state`, `app-sync`, `sync-ui` |
| Guard escape | `skip` |

`inbox` subcommands (`scripts/devswarm-lib/inbox-cmd.js`): `count`, `read`, `ack`, `pull`,
`messages`, `read-primary`, `ack-primary`, `peek-primary`, `drain-primary-legacy`, `tick`.

**Output and exit codes** (`main()` in `devswarm.js`):

- Default stdout is **one JSON object** per call, `{ ok, action?, ... }`. Exit 0 when
  `ok` is true, 2 otherwise. Adding fields to that object is MINOR; removing or retyping
  one is MAJOR.
- Human-line renderings, each overridden by `--json`: `healthcheck`, `diagnose`,
  `app-state`, `supervision-report`, `help`, plain `roster`, `send --quiet`,
  `inbox read-primary --format text`, `inbox tick --quiet`.
- Machine-read lines (frozen format):
  - `inbox tick <id> --quiet` (`inboxTickQuietLine`):
    `tick <id>: unread <n>, known <bool>, meshGap <bool>, watcherArmed <true|false|idle-skip|limit-skip|archived-skip>`,
    optionally followed by a roster block; on failure `ok:false <reason>`.
  - `send --quiet` (`sendQuietLine` in `devswarm-lib/send.js`):
    `sent seq <n> -> <to>, <bytes> bytes, ok`, one line per recipient; on failure
    `ok:false <reason>` or `ok:false -> <to>: <reason>`.
- Stable flags: `--json`, `--quiet`, `--dry-run`, `--to`, `--to-primary`, `--broadcast`,
  `--message`, `--message-file`, `--urgency`, `--receipt`, `--limit`, `--since`, `--tail`,
  `--set`, `--clear`, `--summary`, `--apply`, `--max`, `--ttl`, `--all`.
- Safety refusals are part of the contract: `reap-orphans --apply` needs `--max` and a
  human (`--i-am-a-human` or a TTY) and is refused outright (`automation-refused`) while
  `ANTIHALL_DEVSWARM_AUTOMATION=1` is set; `prune-archived` deletes only with `--confirm-ids` and
  `--plan`; `--since`/`--tail` are rejected on every ack-bearing read.

### Other user-facing scripts

| Script | Stable invocations | Machine-read output |
|---|---|---|
| `scripts/settings.js` | `show [--section K] [--all]`, `get <s.k>`, `set <s.k> <v> [--confirmed]`, `reset <s.k> [--confirmed]`, `judge on\|off\|status`, `trust-command-allow [<repo>]`, `trust-edit-allow [<repo>]` | `--json` on every verb; a gated write returns `{ok:false, needsConfirmation:true, warning}`; exit 1 on error |
| `hooks/doctor.js` | plain (read-only), `--check`, `--repair` (alias `--fix`), `--dry-run`, `--quiet`, `--migrations-only`, `--logs`, `--confirmed` (only with `--prune-cache`) | exit 0 when every check passes, 1 otherwise |
| `skills/update/scripts/update.js` | plain (full update), `--check` (no pull, no writes) | first stdout line is one JSON status object (test-only `ANTIHALL_MARKETPLACE_DIR` aside) `{installed, latest, updated, cacheSynced, action, ingestHeal?, reconcile?, harnessRegistered?}`; exit 1 only on a hard STOP (dirty clone, non-fast-forward) |
| `scripts/migrate-state.js` | `[dir]`, `--planning`, `--mark-read`, `--restore-planning [--dir <wt>]` | copy-only; originals never deleted |
| `scripts/capability-scan.js` | plain (human), `--json` | `--json` prints only the JSON report |
| `scripts/coordinator-work-baseline.js` | `<transcript.jsonl> [--from-line N] [--cwd DIR] [--json]` | `--json` prints `{calls, work, share, attemptedShare, wouldNudge, wouldBlock}` |

`doctor.js` also has narrow, human-invoked repair flags (`--repair-ingest-orphans`,
`--repair-test-stores`, `--repair-resurrected`, `--reclaim-ingest-lock`, `--prune-cache`,
each with `--apply`); their names are stable, their report text is not.
`update.js --post-pull-only` is an internal re-exec handshake, not a public flag.

**Skill names** are stable too: `/anti-hall:<name>` for the 18 Claude skills and
`anti-hall-<name>` for the 21 Codex skills. Renaming or removing one is MAJOR.

## 3. Hook contracts

Source: `plugins/anti-hall/hooks/hooks.json`. "May" lists what the script can emit:
**block** (Stop `{"decision":"block"}`, or PreToolUse exit 2 / deny), **context**
(`additionalContext` or an advisory message), **record** (writes state only; no model-facing
output). "Setting" is the key that turns the hook off (section 1). "Skip" is the
`~/.anti-hall/skip.json` name (`hooks/skip-guard.js`).

| Hook | Event (matcher) | May | Setting | Skip | Codex |
|---|---|---|---|---|---|
| `verify-first` | UserPromptSubmit | context | `context.verifyFirstTurn` | — | yes |
| `task-tracker` | UserPromptSubmit | context | `context.taskTracker` | `task-tracker` | yes |
| `idle-agent-sweep` | UserPromptSubmit | context | `guards.idleAgentSweep` | `idle-agent-sweep` | yes |
| `limit-conserve-inject` | UserPromptSubmit | context | `limitConserve.mode` | `limit-conserve` | yes |
| `devswarm-parent-inbox` | UserPromptSubmit | context | `devswarm.parentInbox` | — | yes |
| `devswarm-child-turn` | UserPromptSubmit | context | `devswarm.childTurn` | — | yes |
| `repair-on-reload` | UserPromptSubmit, SessionStart | context | `maintenance.repairOnReload` | `repair-on-reload` | yes |
| `auto-handover` | UserPromptSubmit | context | `autoHandover.enabled` | `auto-handover` | yes |
| `task-lifecycle-log` | TaskCreated, TaskCompleted | record | `maintenance.taskLifecycleLog` | — | no |
| `verify-first-subagent` | SubagentStart | context | `context.verifyFirstSubagent` | `verify-first-subagent` | no |
| `verify-first-full` | SessionStart | context | `context.verifyFirstSession` | — | yes |
| `verify-first-orch` | SessionStart | context | `context.verifyFirstOrchestration` | — | yes |
| `orch-on-spawn` | PreToolUse (Agent\|Task\|Workflow) | context | `context.verifyFirstOrchestration` | `orch-on-spawn` | no |
| `devswarm-child-role` | SessionStart | context | `devswarm.childRole` | — | yes |
| `version-alert` | SessionStart | context | `versionAlerts.antiHall` | `version-alert` | yes |
| `fable-availability` | SessionStart | context | none (not toggleable) | — | no |
| `codex-availability` | SessionStart | context | none (not toggleable) | — | yes |
| `devswarm-version` | SessionStart | context | `versionAlerts.devswarm` | `devswarm-version` | yes |
| `claude-cli-version` | SessionStart | context | `versionAlerts.claudeCli` | `claude-cli-version` | yes |
| `repo-self-drift` | SessionStart | context | `guards.repoSelfDrift` | `repo-self-drift` | yes |
| `progress-prune` | SessionStart | context | `maintenance.progressPrune` | — | yes |
| `handover-resume` | SessionStart | context | `context.handoverResume` | — | yes |
| `jev-weekly-scorecard` | SessionStart | context | `jev.weeklyNotice` | — | yes |
| `jev-review-reminder` | SessionStart | context | `jev.reviewReminder` | — | yes |
| `emit-dedupe-reset` | SessionStart | record | none (not toggleable) | — | yes |
| `defect-nudge` | SessionStart | context | `context.defectNudge` | `defect-nudge` | yes |
| `task-guard` | Stop | block | `guards.taskGuard` | `task-guard` | yes |
| `tasklist-guard` | Stop | block | `guards.tasklistGuard` | `tasklist-guard` | yes |
| `speculation-guard` | Stop | block | `guards.speculationGuard` | `speculation-guard` | yes |
| `speculation-judge` | Stop | block | `jev.semanticJudge` | `speculation-judge` | yes |
| `claim-ledger` | Stop | record | `guards.claimLedger` | `claim-ledger` | yes |
| `codex-nudge` | Stop | block | `codexNudge.enabled` | `codex-nudge` | no |
| `devswarm-parent-gate` | Stop | block | `devswarm.parentGate` | `devswarm-parent-gate` | yes |
| `devswarm-child-gate` | Stop | block | `devswarm.childGate` | `devswarm-child-gate` | yes |
| `auto-handover-pause-nag` | Stop | block | `autoHandover.nag` | `auto-handover` | yes |
| `silent-agent-nudge` | Stop | block | `guards.silentAgentNudge` | `silent-agent-nudge` | yes |
| `compact-advice-guard` | Stop | block | `guards.compactAdviceGuard` | `compact-advice-guard` | yes |
| `compact-declaration-guard` | PreToolUse(Agent/Task/Write/Edit/MultiEdit/NotebookEdit/Bash) | block | `guards.compactDeclarationGuard` | `compact-declaration-guard` | yes |
| `git-guard` | PreToolUse(Bash), PostToolUse(Bash) | block, context | `safety.gitGuard` | `git-guard` | yes |
| `command-guard` | PreToolUse(Bash) | block | `safety.commandGuard` | `devswarm-read-guard`, `devswarm-send-guard`, `devswarm-subagent-mailbox-guard`, `git-stash-guard`, `command-guard`, `edit-guard` (Bash edit parity only) | yes |
| `merge-gate` | PreToolUse(Bash) | block | `guards.mergeGate` (opt-in) | `merge-gate` | yes |
| `coordinator-work-guard` | PreToolUse(Bash), PostToolUse(Bash) | block, context | `guards.coordinatorWorkWindowMinutes` (0 = off) | `coordinator-work-guard` | no |
| `scan-throttle` | PreToolUse(Bash) | context | `guards.scanThrottle` | — | no |
| `api-guard` | PreToolUse(Write/Edit/MultiEdit; Codex: apply_patch) | block | `guards.apiGuard` | `api-guard` | yes (apply_patch) |
| `ship-it-guard` | PreToolUse(Write/Edit/MultiEdit; Codex: apply_patch) | block, context | `guards.shipitGate` (opt-in) | `ship-it-guard` | yes (apply_patch; existence gate only) |
| `edit-guard` | PreToolUse(Write/Edit/MultiEdit/NotebookEdit; Codex: apply_patch) | block, context | `safety.editGuard` | `edit-guard` | yes (apply_patch) |
| `inbox-read-guard` | PreToolUse(Read) | block | `devswarm.inboxReadGuard` | `devswarm-read-guard` | no |
| `model-routing-guard` | PreToolUse(Agent), PreToolUse(Task) | block, context | `guards.modelRouting` | `model-routing-guard` | no |
| `swarm-guard` | PreToolUse(Agent), PreToolUse(Task) | block, context | `safety.swarmGuard` | `swarm-guard` | no |
| `phase-tracker` | PreToolUse(Agent), PreToolUse(Task) | record | none (not toggleable) | — | no |
| `devswarm-comms-guard` | PreToolUse(SendMessage) | block, context | `devswarm.commsGuard` | `devswarm-comms-guard` | no |
| `ask-guard` | PreToolUse(AskUserQuestion) | block, context | `guards.questionAgentsNote`, `guards.noBlockingQuestions` (opt-in) | `ask-guard` | no |
| `stale-agent-stop-note` | PreToolUse(TaskStop) | context | `guards.staleAgentStopNote` | — | no |
| `output-verify-guard` | PostToolUse(Bash) | context | `guards.outputVerifyGuard` | `output-verify-guard` | no |
| `devswarm-parent-reply-tracker` | PostToolUse(Bash) | context | `devswarm.parentReplyTracker` | — | yes |
| `devswarm-child-drain` | PostToolUse(Bash) | context | `devswarm.childDrain` | — | yes |
| `codex-quota-detect` | PostToolUse(Agent) | context | `guards.codexQuotaDetect` | — | no |
| `dispatch-tier` | PostToolUse(TaskCreate/TaskUpdate) | record | `jevIntegrations.dispatchTier` | — | no |
| `failure-root-cause-nudge` | PostToolUseFailure(Bash) | context | `guards.failureRootCauseNudge` | `failure-root-cause-nudge` | no |
| `precompact-snapshot` | PreCompact | record | `maintenance.precompactSnapshot` | `precompact-snapshot` | yes |
| `session-end-mcp-reaper` | SessionEnd | record | `maintenance.sessionEndReaper` | — | no |

Not registered in `hooks.json` and so not covered: `doctor.js` (a CLI, section 2),
`agent-watchdog.js` (a manual helper), the `*-refresh.js` workers, and the shared modules
`skip-guard.js`, `coordinator-detect.js`, `omc-detect.js`, `limit-conserve.js`,
`session-history-index.js` and `verify-first-core.js` (libraries). The one monitor,
`devswarm-wake-watch` (`plugins/anti-hall/monitors/monitors.json`), is stable by name.

**Kill switches**, narrowest first:

1. **skip file:** `~/.anti-hall/skip.json`, `{"<skip name>": <unix-ms expiry>}`. A
   broad `"all"` entry covers every guard except `git-guard`, `devswarm-read-guard` and
   `git-stash-guard` (`DESTRUCTIVE` in `skip-guard.js`), which must be named. Also written
   by `devswarm.js skip <guard> [--ttl <minutes>]`.
2. **setting:** the key in the table, through the normal precedence. Locked `safety.*`
   keys need `--confirmed` to turn off.
3. **plugin:** disabling the plugin in the harness removes every hook.

Hooks marked "none (not toggleable)" are listed in `NOT_TOGGLEABLE`
(`settings-schema.js`) with the reason.

**General guarantees** (frozen):

- **Fail-open.** A parse, read or state error exits 0 without blocking
  (`CONTRIBUTING.md`, "Fail-open"). A guard blocks only on a positive match. The suite
  tests empty and malformed stdin per hook (`docs/E2E-TESTING.md`).
- **Output cap.** Claude Code caps a hook's model-facing text (`additionalContext`,
  `systemMessage`, Stop `reason`) at 10,000 characters; past that it spills to a file and
  only a preview (the first 2,000 characters) plus the file path arrives inline, and Claude is not asked to read the file (https://code.claude.com/docs/en/hooks, "Output limits"). anti-hall keeps every injecting hook at or under 10,000
  characters (`tests/hooks/injection-cap.test.js`), and an over-cap payload is split across
  hooks, never silently shortened. One deliberate exception (cost-trim Phase 3): the default `context.protocolLevel=compact` sends a shorter core that keeps every load-bearing clause inline and points at the generated `PROTOCOL.md` for the rest; `context.protocolLevel=full` restores the complete text byte for byte on every channel (`tests/hygiene/cost-trim-goldens.test.js`).
- **Loop-safe Stop gates.** A blocking Stop hook never wedges a session: each dedupes
  or caps its repeats (for example `speculation-guard` blocks once per message hash,
  `codex-nudge` at most twice per session). The four on `hooks/lib/stop-policy.js`
  (`devswarm-parent-gate`, `devswarm-child-gate`, `auto-handover-pause-nag`,
  `compact-advice-guard`) also honour `stop_hook_active`.
- **No network unless documented.** Hooks make no network calls except those listed in
  [`PRIVACY.md`](../PRIVACY.md): the update check (`git ls-remote --tags`, on by default),
  the one-time download of the optional `ah-engine` binary from the GitHub Release (sha256-pinned in `ah-engine.lock`; `AH_ENGINE_BOOTSTRAP=0` skips it), and the opt-in Jev, semantic-judge and triage calls. A new outbound call is a MINOR
  change that must land in `PRIVACY.md` in the same release; a new default-on one is MAJOR.
- **No automated deletion.** Automatic paths (hooks, `update.js`, `doctor --repair`,
  the supervisor) never delete messages, user files or repo content. Deletion-class
  repairs are opt-in flags (`migrations.js` `optIn: true`, `prune-archived --confirm-ids`).

Frozen per hook: its script name, event, matcher, the setting and skip name, and its
"May" column. Turning a "context" hook into a "block" hook is MAJOR; the reverse is MINOR.

## 4. On-disk state

**Stable paths** (format changes ship a forward migration; removal is MAJOR):

| Path | What | Source |
|---|---|---|
| `~/.anti-hall/settings.json` | `{ "<section>": { "<key>": value } }` | `hooks/lib/settings.js` |
| `~/.anti-hall/skip.json` | `{ "<guard>": <unix-ms expiry> }` | `hooks/skip-guard.js` |
| `~/.anti-hall/trusted-command-allow.json` | repo realpath to sha256 of the trusted allowlist | `hooks/lib/command-allow.js` |
| `~/.anti-hall/defects/` | local defect reports | `hooks/lib/defect-store.js` |
| `~/.anti-hall/logs/` | JSONL event and error logs | `companion/lib/anti-hall-log.js` |
| `~/.anti-hall/devswarm/` | mesh root: `workspaces/`, `archived/`, `heartbeats/`, `store/<hash>/devswarm.db` (or `journal/` on the fallback backend), `summaries/`, `ignore.json`, `maintainer-notices.jsonl` | `companion/lib/liveness.js`, `companion/lib/devswarm-store.js` |
| `~/.anti-hall/update-sweep-state.json` | per-version migration markers | `companion/lib/migrations.js` |
| `~/.anti-hall/jev.json` | legacy Jev config, read-only fallback | `settings-schema.js` `legacy` |
| `~/.anti-hall/coordinator-work-session-<id>.json` (+ `.lock`), `coordinator-work-metrics.json` (+ `.lock`), `coordinator-work-trips.log` (JSONL, rotated to `.1` at 1 MiB), `.coordinator-work-fold-stamp.json` | the main-thread work window: per-session state, folded per-version metrics, nudge/block trips | `hooks/lib/coordinator-work.js` |
| `<repo>/.anti-hall/progress/` | `INDEX.md` + `<YYYY-MM-DD>/<session>.md` | `hooks/tasklist-guard.js` |
| `<repo>/.anti-hall/history/` | `INDEX.md` + `<YYYY-MM-DD>/<session>.md`; `legacy/` | `hooks/task-lifecycle-log.js`, `scripts/migrate-state.js` |
| `<repo>/.anti-hall/handovers/` | `INDEX.md` + `<date>/<session>/<name>` | `hooks/lib/auto-handover-text.js`, `hooks/lib/handover-find.js` |
| `<repo>/.anti-hall/command-allow.json`, `edit-allow.json` | per-project allowlists (used only once trusted) | `hooks/lib/command-allow.js` |

Everything else under `~/.anti-hall/` (`cache/`, `state/`, `agents/`, `bin/`, `ah-engine/` (the optional engine's binary, state databases, local telemetry and last-known-good copies), every
`*-state.json`, lock and marker files, the SQLite schema inside `devswarm.db`) is internal:
its location and format may change in any release.

**Migration guarantee** (`companion/lib/migrations.js` header; run by `update.js`,
`doctor --repair` and `repair-on-reload`):

- **Idempotent.** Each migration is stamped in `update-sweep-state.json` only after
  `isRunComplete()`; a re-run is a no-op.
- **No-delete.** Messages and files are forwarded before a registry row is tombstoned;
  legacy sources are read, never removed (`settings.js` header, `migrate-state.js` header).
- **All prior forms.** A release that changes a persisted shape also repairs every earlier
  shape of it, with a seeded-bad-state test (for example `tests/companion/migrations.test.js`,
  `settings-migration.test.js`, `legacy-plugin-options-migration.test.js`).
- **Fail-open.** A per-store error is counted, never thrown, and leaves the marker unset so
  the next run retries.

## 5. Claude and Codex parity

Both ports ship from one plugin directory, and the Codex hooks run the **same hook
scripts** (`codex/hooks/hooks.json` points at `${PLUGIN_ROOT}/hooks/*.js`).

**Guaranteed identical:**

- **Version.** `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` carry the same
  version (`tests/hygiene/manifest-drift.test.js`).
- **Hook set.** Every Claude hook is on Codex too, unless `CLAUDE_ONLY_ALLOWLIST` in
  `manifest-drift.test.js` gives a reason; stale allowlist entries also fail.
- **Installer.** `install-codex.js` writes the generated Codex `hooks.json` (one wrapper call per event, built from
  `plugins/anti-hall/engine/defaults/dispatch.toml`) with `${PLUGIN_ROOT}` resolved to the checkout
  (`tests/codex/codex-hook-parity.test.js`).
- **Stop behaviour.** The shared Stop hooks run and fail open on a Codex-shaped payload
  (`tests/codex/codex-jev-hooks-parity.test.js`).
- **Settings, CLIs, state.** The schema, precedence, `settings.js`, `devswarm.js` and every
  path in section 4 are one code path on both.
- **Skill paths.** Codex skills resolve the plugin root at run time
  (`tests/codex/skill-paths.test.js`).

**Known differences** (allowlisted, `plugins/anti-hall/codex/README.md` "Parity Notes"):

| Difference | Reason |
|---|---|
| 18 hooks are Claude-only (the "no" rows in section 3) | Per-hook reasons are in `CLAUDE_ONLY_ALLOWLIST` (`tests/hygiene/manifest-drift.test.js`): `codex-nudge` is self-referential inside Codex, `scan-throttle` is not yet ported, `coordinator-work-guard` waits on a verified Codex PostToolUse payload and coordinator detection, `output-verify-guard` reads Claude's `tool_response` shape. The rest follow from Codex surface gaps: it has no `TaskCreated`/`TaskCompleted`/`SessionEnd`/`PostToolUseFailure` event (it does fire `SubagentStart`, with `agent_id`/`agent_type`: a captured codex-cli 0.160.0 payload and `codex-rs/hooks/src/events/session_start.rs` at rust-v0.160.0; `verify-first-subagent` is not registered there yet because its Codex payload has no tests), reports file edits only as `apply_patch` (edit-guard, api-guard and ship-it-guard's existence gate run there; shell writes bypass them), and has no `Agent`, `Task`, `Read`, `SendMessage`, `AskUserQuestion` or `TaskStop` matcher |
| No `/config` on Codex | locked keys use `--confirmed` or the env var |
| `deadly-loop-multi` is Claude-only | it multiplies the Claude trio |
| Codex-only skills: `anti-hall-context-conserve`, `anti-hall-model-policy`, `anti-hall-omc`, `anti-hall-omx` | Codex-side orchestration and routing guidance |
| DevSwarm supervisor and `devswarm-recover` are Claude-only | they recover Claude Code sessions |

Removing a hook from Codex that is not on the allowlist, or adding a Claude-only difference
without an allowlist reason, fails CI. Closing a known difference is MINOR.

## 6. Not covered

These may change in any release, including a PATCH:

- **Internal modules:** everything under `hooks/lib/`, `companion/lib/`,
  `scripts/devswarm-lib/`, and every exported function. Only the CLIs and hook scripts are
  public.
- **Skill-run helper scripts:** `scripts/defect.js`, `jev-report.js`, `jev-setup.js`,
  `briefing.js`, `dispatch-report.js`, `auto-handover-config.js`, `finding-dedup.js`,
  `harvest-debt.js`, `devswarm-store-leak-report.js`, `companion/devswarm-recover.js` and the
  `companion/install-*.js` scripts. Skills invoke them, but their flags and output are not
  frozen; only the scripts in section 2 are stable CLIs.
- **Message wording:** guard block reasons, advisory and nudge text, human report lines,
  `help` synopses, warnings, and the verify-first discipline text. Only the machine-read
  lines in section 2 are frozen.
- **Advisory policy:** when an advisory fires, its thresholds within a setting's meaning,
  and which shapes a guard recognises (a guard catching more dangerous forms is a fix,
  not a break).
- **Jev internals:** prompts, model ids, confidence thresholds, decision log format, and
  the on/shadow/off defaults of each `jevIntegrations.*` key.
- **Internal state** (section 4), statusline layout, log line contents, test helpers.
- **Experimental surfaces:** anything a doc or setting description labels experimental
  or shadow.

## 7. Versioning rules

| Bump | Examples for this plugin |
|---|---|
| **MAJOR** | rename `safety.gitGuard`; change `guards.mergeGate`'s default to on; drop a `devswarm.js` verb or the `inbox tick --quiet` format; remove `ok` from the JSON envelope; move `settings.json`; rename a skip name; make a context hook block; delete data in an automatic path; raise the minimum Node version |
| **MINOR** | add a setting, verb, flag, hook, skill or JSON field; add an enum value; add a documented opt-in network call; port a Claude-only hook to Codex; retune a default within its meaning |
| **PATCH** | fix a false positive or a missed dangerous form; reword a message; fix docs; refactor internals; add a migration repairing an earlier bad state; test-only changes |

Rules that apply to every release (`RELEASING.md`): `plugin.json` is the only version
authority, both manifests are bumped together, and a release is done only when CI is green.
A deprecation lands in a MINOR with a CHANGELOG note and keeps working until the next MAJOR.
