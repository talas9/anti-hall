---
name: anti-hall-system-briefing
description: The agent-facing operator guide to anti-hall for Codex — glossary of terms, the hard rules, every skill and CLI verb with when to use it, every setting with its default, and where to read more; plus a DERIVED live inventory (`scripts/briefing.js`) of what is installed. Use when the user asks "brief me on anti-hall", "what does X mean", "which command/setting does Y", "what's in this build", or when onboarding an agent to install or run anti-hall. For "is it working", use anti-hall-doctor.
---

# System briefing — anti-hall operator guide for Codex (v0.108.0)

Resolve the plugin root from this SKILL.md's path (Codex does not expand plugin-root
variables in skill text):

```bash
ANTI_HALL_ROOT="$(cd "$(dirname "$SKILL_FILE")/../../.." && pwd)"
test -f "$ANTI_HALL_ROOT/.codex-plugin/plugin.json" || { echo "anti-hall plugin root not found relative to $SKILL_FILE — aborting" >&2; exit 1; }
```

Two parts: **(1) this guide** — terms, rules, skills, verbs, settings; **(2) a live
inventory** — `node "$ANTI_HALL_ROOT/scripts/briefing.js"` (or `--json`) enumerates the
hooks, helpers, skills and DevSwarm substrate this build ships, from `hooks.json` and the
files on disk. Codex has no `/config` panel and no statusline hook; skills are named
`anti-hall-<name>`. For "is it working", use `anti-hall-doctor`.

## Glossary

| Term | Meaning |
|---|---|
| Iron Law | No claim without evidence; no fix without a proven root cause. Everything else enforces it. |
| coordinator / worker | The main thread plans, delegates and verifies; subagents (workers) do heavy reads, commands and edits. `command-guard`/`edit-guard` enforce it on the coordinator. |
| guard | A PreToolUse/Stop hook that blocks mechanically (git-guard, command-guard, edit-guard, …). |
| nudge / advisory | Injected text that informs but never blocks. |
| skip | A TTL'd per-guard override in `~/.anti-hall/skip.json`, written only on the user's explicit request; `all` never covers git-guard. |
| Tier 1 / 2 / 2.5 / 3 | Anti-speculation layers: protocol injection; hedge-word `speculation-guard`; `claim-ledger` (confident claims with no evidence, ledger-only); opt-in LLM `speculation-judge`. |
| handover | A self-written, lossless session record in `.anti-hall/handovers/` so a fresh session resumes cold. Auto-handover asks for one at 85% context or 170k tokens (UserPromptSubmit, or once at a Stop). `precompact-snapshot.js` (PreCompact) also writes a mechanical `PRECOMPACT-<n>.md` safety-net snapshot before every compaction and never blocks it. |
| known / unknown window | Whether the context window size is known (statusline figure, Codex rollout, env, sticky, inferred 1M). Unknown → a soft advisory only, never the mandatory handover directive. |
| settings store | `~/.anti-hall/settings.json`; precedence env > file > `/config` > legacy file > default. `*` below = advanced (hidden unless `show --all`). |
| repair / migration marker | Idempotent data repairs (`companion/lib/migrations.js`) stamped per version in `~/.anti-hall/update-sweep-state.json`; run by update, `doctor --repair`, and on reload. |
| Jev | Optional LLM classifier ("System One") consulted by some hooks. |
| on / shadow / off | Jev per-integration mode: on = may change the outcome; shadow = asked and logged, outcome unchanged; off = not consulted. |
| KEEP / REVIEW / REMOVE | `jev-report` verdict per integration from its measured value. |
| tp / fp | Human precision labels on a Jev decision (`jev-report.js label <hash> tp\|fp`). |
| budget watch | `jev.budget.mode=watch`: warns on spend/low credit; never disables Jev. |
| DevSwarm | Multi-workspace AI IDE; `hivecontrol` is its CLI. All DevSwarm features are dormant outside it. |
| Primary | The DevSwarm workspace on the repo's main checkout that orchestrates. |
| child | A workspace the Primary spawned (own worktree and branch). |
| mesh | anti-hall's per-project message store shared by the Primary and its children; the only allowed channel (`devswarm.js send`/`inbox`). |
| repoKey | The per-project store key (derived from the git common dir). |
| partition | One mailbox inside the mesh store (per workspace, plus broadcast). |
| reader cursor / floor | A reader's read position in a partition (`h:<pid>:<startMs>`); the `#floor` is the monotone position every live reader has passed. Unread = total − cursor. |
| ack / receipt | `read-primary` reads without advancing; the returned `inbox ack-primary <id> --receipt <rid>` acknowledges. |
| stale anti-hall <v> | A workspace whose heartbeat records an older anti-hall build than this machine has; restart that session (not neglect). |
| inbox grace | Fresh unread to a child is not nagged for `devswarm.inboxGraceSec` (120 s) unless it heartbeats first. |
| harness registration | `installed_plugins.json`, the harness's record of which build to load; `update` refreshes it via `claude plugin update`, which needs a full RESTART (not `/reload-plugins`). |
| Primary seat | The Primary's mesh id (`primary-<hash>`, same partitions and cursors). A new session adopts it only when the holder has closed; while two sessions conflict, the other one's sends/acks/spawns/merges are refused until `devswarm.js primary takeover`. |
| sender label | A message's `from`: a child sends as its workspace id, only the Primary checkout as `primary-<hash>`; old child labels map to the child via `sender-aliases.json`. |
| twin / identity family | Several registry rows for one workspace (e.g. slug row + UUID row), grouped and retired together. |
| archive (anti-hall) | `devswarm.js archive`: tombstone in anti-hall's registry; never touches the app. |
| archive / close / delete (app) | App archive = hidden + inactive, recoverable, worktree kept; close = inactive only (not archived); delete = row removed, permanent. |
| auto-archive | Supervisor archives a child in the app only when done, merged, clean, drained, not the Primary, unfocused 10 min and idle; always by explicit workspace id; DevSwarm >= 2.5.3. |
| prune | Deleting archived workspaces: only an owner-approved exact id list with a plan nonce (`prune-archived`). Never automated. |
| retention | Old message bodies archived to gzip then pruned (rows, positions, hashes stay). |
| app DB | The DevSwarm app's own SQLite DB, read read-only as ground truth (titles, rank, archived, PRs, session map). |
| capability gate | Every DevSwarm verb/table/column/app file is checked by version + detection; a missing surface sleeps and doctor names it. |
| supervisor / ingest daemon | Opt-in companions: the periodic sweep (poke → escalate, app sync, auto-archive, retention) and the per-project monitor → store daemon. |
| poke / escalate / recover | Recovery ladder: nudge a stale child, then tell the Primary; only `devswarm-recover.js <id>` ever kills. |
| finish gates | `done`, `merged`, `tests_passed` (`devswarm.requiredGates`) set via `devswarm.js gate --set`. |

## Hard rules

- Verify before claiming; label inference; say "I don't know"; done = verified against the agreed criteria.
- Never force-push; never add AI self-credit to commits or PR/issue/release text (git-guard).
- Never delete data without the user's explicit confirmation. No automated job may delete or disable anything; automated jobs detect and report only. DevSwarm deletion = `prune-archived` with an owner-approved exact list.
- `archive`/`delete` via hivecontrol always name the workspace id (2.5.3 defaults to the CURRENT workspace otherwise).
- DevSwarm messaging goes through the mesh only (no native `message-child`/`message-parent`, no `SendMessage` to a workspace).
- Never call the DevSwarm app's local HTTP API or `hivecontrol workspace check-merge` from automation.
- Change settings only via `/anti-hall:settings` / `scripts/settings.js`; never delete legacy config files.
- Skips only on the user's explicit request; git-guard must be named.

## Skills (Claude `/anti-hall:<name>` · Codex `anti-hall-<name>`)

| Skill | Use when |
|---|---|
| `root-cause` | any bug, failure, flaky test, unexplained behaviour — before fixing |
| `orchestration` | work is heavy, long or parallelizable |
| `deadly-loop` / `deadly-loop-multi` | hardening a risky change before merge (multi = 2–4× the trio) |
| `ship-it` | shipping any change, scaled S/M/L |
| `simplify` | trimming recent code without changing behaviour |
| `debt` | registering or auditing deliberate shortcuts |
| `handover` | end of session, before `/clear` or `/compact`, or when auto-handover asks |
| `doctor` | "is anti-hall working?", guards not firing, repairs |
| `update` | "update anti-hall" / "is it current?" |
| `activate` | first-run setup |
| `install-statusline` | installing the two-line statusline |
| `settings` | showing/changing any setting (incl. auto-handover) |
| `system-briefing` | this guide; "brief me on anti-hall" |
| `devswarm` | anything DevSwarm: mesh, recovery, auto-archive, prune, retention, app DB, screenshot sync |
| `jev` | activating/configuring/reporting on Jev |
| `defects` | filing or checking anti-hall defect reports |
| `flutter-debug` | driving and fixing a running Flutter app |
| Codex only: `context-conserve`, `model-policy`, `omc`, `omx` | limit conservation, model routing table, OMC state, oh-my-codex integration |

## CLI verbs (run from the plugin root; heavy ones via a subagent)

- `scripts/settings.js` — `show` [--all] [--section s] [--json] (list), `get <section.key>`, `set <section.key> <value>` (validated), `reset <section.key>` (drop the override).
- `scripts/auto-handover-config.js` — `get`, `set <1-99>`, `off`, `on`, `nag on|off`, `max-tokens <n>`, `nag-step <n>`, `nag-quiet <n>` (alias over `autoHandover.*`).
- `scripts/jev-setup.js` — `status`, `enable`, `disable`, `set-key`, `test`, `mode <integration> on|shadow|off`.
- `scripts/jev-report.js` — (no verb) the report [--json] [--window 24h|7d] [--by project|session] [--project <name>] [--weekly]; `label <hash> tp|fp`; `prune-audit` (trim audit snippets).
- `scripts/defect.js` — `report`, `list`, `show`, `rule`, `archive`.
- `hooks/doctor.js` — health check; `--repair` applies safe fixes. `skills/update/scripts/update.js` — update; `--check` compares only.
- `scripts/devswarm.js` (`help <verb>` for detail) — mailbox: `send` (post to --to/--to-primary/--broadcast), `inbox` (count/read/pull/read-primary/ack-primary/peek-primary), `roster` (who is on the mesh), `mesh` (read the mesh), `heartbeat` (liveness + summary), `wake-directive` (reprint the wake instructions); registry: `register`, `ensure`, `register-primary` (Primary checkout only), `primary` (`status` shows the Primary seat; `takeover` demotes a conflicting session), `workspaces`, `migrate`, `migrate-owner-keys`, `reconcile`, `reconcile-registry`, `reconcile-active`, `reap-stale`, `reap-orphans`; lifecycle: `spawn` (create a workspace), `merge`, `gate` (finish gates), `gate-intent` (state why a Stop block is intentional), `nudge`, `archive`, `unarchive`, `archive-ignore`, `archive-unignore`, `archive-request` (ask a child to archive itself), `auto-archive` (show the plan), `prune-archived` (owner-approved delete), `retention` (status/run/restore); app DB: `app-state`, `app-sync`, `sync-ui` (screenshot sync); health: `diagnose`, `healthcheck`, `logs`; `skip <guard> [--ttl m]` (user-requested skip only).
- `companion/devswarm-recover.js <id>` — the only path that kills (one named, confirmed-wedged workspace).
- Installers: `companion/install-reaper.js`, `install-devswarm-supervisor.js`, `install-devswarm-ingest.js`, `statusline/install-statusline.js` (`--dry-run` / `--uninstall` where supported).

## Settings (defaults; `*` = advanced)

- **Auto Handover**: `autoHandover.enabled`=true, `autoHandover.pct`=85, `autoHandover.maxTokens`=0, `autoHandover.nag`=true, `autoHandover.nagStepPct`=5, `autoHandover.nagQuietMin`=15
- **Guards**: `guards.mergeGate`=false, `guards.shipitGate`=false, `guards.outputVerifyGuard`=true, `guards.failureRootCauseNudge`=true, `guards.repoSelfDrift`=true, `guards.stashGuard`=false (safety: --confirmed), `guards.emitDedupe`=true, `guards.editGuardAllow`=—* (safety: --confirmed), `guards.allowSubagentMailbox`=false* (safety: --confirmed), `guards.reaperMatch`=—*, `guards.reaperExclude`=—*, `guards.tasklistWorkThreshold`=3*, `guards.progressFreshMs`=1800000*, `guards.apiGuardThirdparty`=false*, `guards.modelRouting`=strict, `guards.apiGuard`=true, `guards.speculationGuard`=true, `guards.claimLedger`=true, `guards.taskGuard`=true, `guards.tasklistGuard`=true, `guards.scanThrottle`=true
- **Safety Guards**: `safety.gitGuard`=true (safety: --confirmed), `safety.commandGuard`=true (safety: --confirmed), `safety.editGuard`=true (safety: --confirmed), `safety.swarmGuard`=true (safety: --confirmed)
- **Context Injections**: `context.verifyFirstSession`=true, `context.verifyFirstOrchestration`=true, `context.verifyFirstTurn`=true, `context.verifyFirstSubagent`=true, `context.taskTracker`=true, `context.handoverResume`=true, `context.defectNudge`=true
- **Maintenance**: `maintenance.repairOnReload`=true, `maintenance.progressPrune`=true, `maintenance.precompactSnapshot`=true, `maintenance.taskLifecycleLog`=true, `maintenance.sessionEndReaper`=true
- **Version Alerts**: `versionAlerts.antiHall`=true, `versionAlerts.claudeCli`=true, `versionAlerts.devswarm`=true
- **Updates / Maintenance**: `updates.quiet`=false, `updates.reconcileBudgetMs`=60000*, `updates.postpullBudgetMs`=90000*, `updates.sweepBudgetMs`=20000*
- **Limit Conservation**: `limitConserve.mode`=auto, `limitConserve.threshold`=85, `limitConserve.accountCheck`=true*
- **Jev (semantic decision engine)**: `jev.enabled`=false, `jev.transport`=vercel, `jev.judgeModel`=claude-haiku-4-5, `jev.semanticJudge`=false, `jev.keyFile`=—*, `jev.timeoutMs`=1500*, `jev.confidenceThreshold`=0.85*, `jev.triage`=true*, `jev.triageUrgentThreshold`=0.9*, `jev.budget.mode`=unlimited, `jev.budget.usdPerDay`=—, `jev.budget.usdPerWeek`=—, `jev.weeklyNotice`=true, `jev.audit.snippets`=false*, `jev.budget.minCreditUsd`=—, `jev.prices`=—*, `jev.priceUsdPerMInput`=0.042*, `jev.priceUsdPerMOutput`=0*
- **Jev integration**: `jevIntegrations.speculation`=on, `jevIntegrations.triage`=on, `jevIntegrations.newRequest`=shadow, `jevIntegrations.claimLedger`=shadow, `jevIntegrations.outputVerifyGuard`=shadow, `jevIntegrations.gitGuardSelfCredit`=shadow, `jevIntegrations.modelRouting`=shadow, `jevIntegrations.tasklistTrivial`=shadow, `jevIntegrations.codexNudgeSubstantial`=shadow, `jevIntegrations.mergeGateHedge`=shadow, `jevIntegrations.parentGateQuestion`=shadow, `jevIntegrations.supervisorBlockerLabel`=shadow, `jevIntegrations.findingDedup`=on
- **DevSwarm**: `devswarm.hivecontrol`=—, `devswarm.supervisorMode`=auto, `devswarm.requiredGates`=done,merged,tests_passed, `devswarm.inboxCmd`=—, `devswarm.heldPartitions`=—*, `devswarm.childGateStrict`=true*, `devswarm.parentGateCap`=3*, `devswarm.activeFloorPct`=50*, `devswarm.archivedCacheMaxAgeMs`=—*, `devswarm.archivedGraceMs`=600000*, `devswarm.cooldownSec`=600*, `devswarm.idleSec`=900*, `devswarm.dormantMs`=1800000*, `devswarm.drainTtlMs`=600000*, `devswarm.graceSec`=5*, `devswarm.maxRecoveries`=3*, `devswarm.intervalSec`=90*, `devswarm.migrateMarkRead`=false*, `devswarm.monitorTimeoutSec`=30*, `devswarm.nudgeCooldownSec`=120*, `devswarm.nudgeMaxAttempts`=2*, `devswarm.nudgeWindowSec`=180*, `devswarm.postSpawnGraceSec`=120*, `devswarm.reapedRetentionDays`=30*, `devswarm.receiptWindowMs`=300000*, `devswarm.archiveRequestRenagHours`=24*, `devswarm.reconcileSweep`=auto*, `devswarm.reconcileSweepSec`=900*, `devswarm.rowStaleMs`=86400000*, `devswarm.sendReceiptRetentionDays`=7*, `devswarm.summaryRetentionDays`=30*, `devswarm.wakeCron`=*/30 * * * **, `devswarm.wakeWatchPollMs`=2000*, `devswarm.childGateRetentionDays`=14*, `devswarm.housekeepingSweep`=auto*, `devswarm.housekeepingSweepSec`=3600*, `devswarm.supervisorLogRotateBytes`=10485760*, `devswarm.inboxGraceSec`=120*, `devswarm.supervisorSweepBudgetMs`=20000*, `devswarm.autoArchive.mode`=on, `devswarm.autoArchive.idleMin`=30*, `devswarm.autoArchive.maxPerSweep`=3*, `devswarm.retention.days`=30*, `devswarm.retention.maxStoreMB`=100*, `devswarm.retention.keepPerPartition`=200*, `devswarm.retention.archive`=true*, `devswarm.retention.archiveMaxMB`=0*, `devswarm.parentGate`=true, `devswarm.childGate`=true, `devswarm.parentInbox`=true, `devswarm.childTurn`=true, `devswarm.childRole`=true, `devswarm.childDrain`=true, `devswarm.parentReplyTracker`=true, `devswarm.commsGuard`=true, `devswarm.inboxReadGuard`=true, `devswarm.wakeWatch`=true, `devswarm.appSync`=true, `devswarm.screenshotSync`=true
- **Statusline**: `statusline.base`=—, `statusline.noEmail`=false
- **Codex Nudge**: `codexNudge.enabled`=true, `codexNudge.min`=3*
- **Defects**: `defects.defaultProj`=—

Env-only: `ANTIHALL_CONTEXT_WINDOW_TOKENS`, `ANTI_HALL_THROTTLE_PATTERNS`, `ANTIHALL_DEVSWARM_APP_DB` (path or `off`). "(safety: --confirmed)" = a safety key: `set`/`reset` need `--confirmed` (a human direct command, or the agent asking the user and getting a yes) — without it nothing changes and a one-line factual warning is returned instead; a direct user ask to change it IS the confirmation. No switch on purpose: skip-guard, coordinator-detect, omc-detect, phase-tracker, fable-availability, codex-availability, emit-dedupe-reset, agent-watchdog, command-guard's data-safety sub-guards (`settings.js show` gives the reasons).

## Where to look

`llms.txt` (every hook/skill/script/setting in one page) · `docs/GUIDE.md` (per-hook detail, settings) · `docs/KB-devswarm-hivecontrol.md` + `docs/KB-devswarm-app-db.md` (DevSwarm) · `docs/KB-jev-classifier.md` (Jev) · `CHANGELOG.md` (what changed) · `AGENTS.md` (the protocol for Codex). `docs/` ships only with a repo clone.
