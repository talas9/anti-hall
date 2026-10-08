# ah-engine reference

This reference is generated from the engine's registries and shipped defaults by `ah-engine docs --format md`; do not edit it by hand. A test fails when it differs from the generated text.

## Commands

Every command accepts `--json`. Read-only commands never change state.

| Command | Arguments | Read-only | Status | What it does |
|---|---|---|---|---|
| `backup` | `[--to <dir>]` | no | implemented | Make a consistent online snapshot of hot.db and archive.db with SQLite's backup API, scrubbed of secrets, in backups/<ms> or the given directory; prints its manifest. |
| `briefing` | `[--root <plugin dir>]` | yes | implemented | A derived inventory of a plugin tree (D81, the port of scripts/briefing.js): every registered hook by event with the purpose from its own header comment, the skills, the DevSwarm substrate and the docs map. |
| `capability-scan` | `[--root <plugin dir>]` | yes | implemented | A read-only gap report (D81, the port of scripts/capability-scan.js): for each opt-in capability of a plugin tree, whether it is shipped and whether it is active on this machine, and how to enable it; prints the JSON report, then one line per capability. |
| `check` | `<name>` | yes | implemented | Run one built-in check in-process on a hook payload from stdin (used by the parity harness). |
| `config` | `[validate <file>\|heal]` | no | implemented | Show the effective config and where each value comes from, validate a config file, or `heal` the plugin's edited defaults (add the settings they lack from the pristine copy, also in a version-controlled checkout); versions, rollback and export are planned (D18, they need the config database). |
| `ctl` | `<ping\|reload\|stop\|status>` | no | implemented | Send a control verb to the daemon: ping, reload, stop or status. |
| `defect` | `<report\|list\|show\|rule\|archive\|backfill\|recurring\|similar> [flags] [--json]` | no | implemented | File, list, show and rule anti-hall defect reports and query the bug history (L9a, the port of scripts/defect.js): `report`, `list [--mine\|--open\|--unfinished]`, `show <fp>`, `rule <fp> --status ...`, `archive`, and the history verbs `backfill`, `recurring` and `similar`; the store is ~/.anti-hall/defects/. |
| `docs` | `[--format md]` | yes | implemented | Print the generated reference: every command, setting, metric, impact kind, check and error code. |
| `doctor` | `[--check] [--repair\|--fix] [--dry-run] [--migrations-only] [--quiet] [--home <dir>] [--cwd <dir>] [--plugin-root <dir>]` | no | implemented | The health check and repair of anti-hall (D81), with the Node doctor's report layout and finding texts: the platform and versions, the hook scripts the registry names, the live behaviour of the guards (each built-in check run in-process on a crafted payload; a payload the engine defers to its Node hook is reported as a deferral, never a pass), the statusline configuration and the saved Workflow templates. Read-only by default; `--repair` (or `--fix`) runs the repair pass of `migrate` after the diagnostics, `--dry-run` previews it, and `--migrations-only` with either prints only the migration report as JSON. |
| `gen-hooks` | `--host claude\|codex [--kind hooks\|registry\|list\|map]` | yes | implemented | Print a file generated from the dispatch table (D87): the thin hooks.json (one trigger per event), the per-hook registry, the wrapper's fallback list or its fallback map, for one host. |
| `handovers` | `<index\|check\|search> [query] [--project <dir>] [--registered] [--force] [--limit <n>]` | no | implemented | The handover brief tree: `index` rebuilds the root brief and the per-day briefs (BRIEF.md plus a typed BRIEF.json) of the changed days under .anti-hall/handovers (`--registered` walks every project the SessionStart check has seen, `--force` rebuilds all days), `check` reports unindexed or stale handovers, missing briefs, malformed handovers and broken references without writing (exit 3 when there are any), `search <words> [date:..] [session:..] [decision:..] [file:..]` ranks entries from the sidecars. Never edits a handover file and never deletes. The logic is the plugin script handover-hygiene.js; the scheduled job `handovers` runs `index --registered`. |
| `harvest` | `[--dir <path>] [--stale-days <n>]` | yes | implemented | Scan a code tree for deliberate-debt markers, `anti-hall: <ceiling>, <when>` in any comment syntax (D81, the port of scripts/harvest-debt.js), and flag the ones with no payback trigger or in files untouched for the stale window. |
| `hook` | `[--fallback <hook.js>] \| --event <Event> [--tool <Tool>] [--host claude\|codex] [--fallback-map <file>]` | no | implemented | The hook client: read one hook payload from stdin, ask the daemon, print the answer; falls back to the Node hook given by --fallback. With --event it is the per-event dispatcher: it runs every hook entry hooks.json registers for that event and tool, built-in checks in the engine and the rest as their Node hooks (--fallback-map overrides their commands), and combines the results the way the host would. |
| `impact` | `[--kind <kind>] [--project <hash>] [--window <7d>]` | yes | implemented | Show everything the engine affected: blocks by reason, warnings, context injected, fallbacks, and labelled savings estimates, including the NET of model-routing savings minus what injection and Jev cost (D77). |
| `install-codex` | `[--global] [--dry-run] [--root <plugin dir>]` | no | implemented | Install the anti-hall hooks for Codex (D81, lane L9b, the port of codex/install-codex.js): merge the generated hook registration into .codex/hooks.json (project, or --global for the home directory), replacing only anti-hall's own groups, and enable the hooks feature in config.toml. A changed file is copied to <file>.bak-<time> first; --dry-run writes nothing. |
| `install-statusline` | `[--user\|--project] [--consolidate]` | no | implemented | Put the anti-hall status line into the host's statusLine setting (L9a, the port of statusline/install-statusline.js): `--user` (default, ~/.claude/settings.json) or `--project` (./.claude/settings.local.json), `--consolidate` to merge an existing status line into one line. Wraps an existing statusLine as line 1, backs the settings up once, never clobbers other keys, a re-run changes nothing. |
| `jev` | `<ask\|status\|scrub\|evidence>` | no | implemented | The optional Jev lane (D34-D38): `ask` reads JSON requests, one per stdin line, and prints each decision (a real call when Jev is enabled and keyed), `status` prints the resolved settings and each integration's mode without any key, `scrub` redacts secrets from JSON strings read one per stdin line. |
| `jev-setup` | `<status\|enable\|disable\|set-key\|bind-generic-key\|mode> [--transport vercel\|typesafe] [--fallback vercel\|typesafe\|none] [--role fallback] [--vendor vercel\|typesafe]` | no | implemented | Activate, configure and inspect the opt-in Jev classifier (D81, the port of scripts/jev-setup.js): `status` (resolved settings, key presence yes or no, every integration's mode, calls in the last 24 hours, the Vercel credit balance), `enable` and `disable`, `set-key` (the key is read from stdin only and written 0600), `bind-generic-key`, and `mode <integration> on\|shadow\|off`; `test` and the review verbs stay in the Node script. |
| `jev_sweep` | `` | no | implemented | The scheduled Jev evidence sweep (the `jev_sweep` job): gathers the WaitKind, Loop and StepMap facts of the supervisor's questions (plan, transcript, git, CI, mesh) and runs them through the evidence gate, writing its telemetry; takes no arguments and reads the home directory from the environment. |
| `maintain` | `` | no | implemented | Size control (D26): move consumed messages, expired key values and old impact events from hot.db to archive.db, prune derived bookkeeping, checkpoint both WALs and VACUUM both databases; prints a report. |
| `mesh` | `<roster\|unread\|read\|dump> --db <devswarm.db> [--id <ws>] [--since <n>] [--last <n>] \| <devswarm.js argv>` | no | implemented | DevSwarm mesh store (D45). With `--db`: the read-only S0 reader (stage S0): `roster` lists the registered workspaces, `unread` the per-workspace counts, `read --id <ws>` its messages (`--since <n>` skips the first n, `--last <n>` the newest n, capped by mesh.read_byte_cap), `dump` the full canonical dump the parity harness compares with Node; the store is opened read-only and never created, and a journal-backed store is refused. Without `--db` (stage 2): the words after `mesh` are a `scripts/devswarm.js` argv, run per the `mesh.engine_writes` switch: off (default) hands it to Node; shadow lets Node act and replays it on a scratch copy of the store, logging the comparison (mesh_write.shadow_log); on answers `send`, `mesh read`, `mesh history` and `roster --ack` in the engine (same output, exit code, store rows and locks as Node) and hands everything it cannot reproduce exactly, and every other verb, to Node. |
| `metrics` | `[--check <name>] [--rollup <resolution> [--since <s>]]` | yes | implemented | Show the engine's metrics: counters, gauges and latency percentiles, optionally for one check; with --rollup, the stored rollups of one resolution (minute, hour), optionally for the last --since seconds. |
| `migrate` | `[--dry-run] [--home <dir>] [--cwd <dir>] [--plugin-root <dir>]` | no | implemented | The persisted-state migrations and sweeps of the Node doctor's repair pass (D81): the legacy progress and history copy, the reply-state, gate-intent and auto-archive state forward-migrations, the settings.json migration from the legacy jev.json and the stored plugin options, the Jev triage cache repair, the lock scratch sweep and the retention sweeps, with Node's report; `--dry-run` previews and writes nothing. Steps that need the DevSwarm stores are left to the Node doctor while DevSwarm state is present. |
| `phase` | `<set\|advance\|step\|agents\|update\|clear> [args]` | no | implemented | Write or update the phase state the status line's phase bar shows (L9a, the port of statusline/phase.js): `set <code> <desc> <done> <total>`, `advance [n]`, `step <text>`, `agents <n>`, `update key=value ...`, `clear`; the state is ~/.anti-hall/phase-state.json. Fails open. |
| `proj` | `<cwd> <put\|take\|len\|set\|setex\|get> [args]` | no | implemented | Per-project state in hot.db: a mailbox (put, take, len) and key-value pairs (set, setex with a TTL in seconds, get); the partition is derived from the cwd. |
| `reset` | `` | no | implemented | Clear the client breaker, the crash-loop stop and the failure record. |
| `restore` | `<snapshot-dir>` | no | implemented | Restore a snapshot directory: first keep the current state as an unscrubbed pre-restore snapshot (never deleted), stop the daemon, then swap the databases. |
| `schedule` | `<list\|run <job>\|history> [--job <name>] [--limit <n>]` | no | implemented | The scheduler (D33): `list` the jobs with their next run and last result, `run <job>` now (waits briefly for the result), or show the run `history` from hot.db; adding and removing jobs from the command line is planned (D33), today they come from schedules.toml and schedules.json. |
| `serve` | `` | no | implemented | Run the resident daemon in the foreground (the client starts it detached when needed). |
| `settings` | `<show\|get\|set\|reset\|judge\|trust-command-allow\|trust-edit-allow> [args] [--json]` | no | implemented | Show or change any anti-hall setting (L9a, the port of scripts/settings.js): `show [--section <key>] [--all]`, `get <section.key>`, `set <section.key> <value> [--confirmed]`, `reset <section.key> [--confirmed]`, `judge on\|off\|status`, and `trust-command-allow` / `trust-edit-allow [<repo>] [--confirmed]`; the settings.json file and the registry are the plugin's own. |
| `shadow-compare` | `<scratch dir>` | no | implemented | Internal: the detached half of a Node shadow (L9a). Runs the Node version of a sampled operator command on a scratch home and logs a mismatch to telemetry; started by the engine, not by people. |
| `status` | `[--memory]` | yes | implemented | Show the daemon's state: version, uptime, memory, counters, breaker and crash-loop state, rules, and a headline summary of what it did. |
| `statusline` | `(session JSON on stdin)` | no | implemented | The two-line status line the host runs after each turn (L9a, the port of statusline/statusline.js and its renderers): reads the session JSON on stdin; line 1 is the configured base command or the rich line, line 2 the phase bar, swarm activity or context gauge. Fails open. |
| `stop` | `` | no | implemented | Ask the daemon to drain and exit. |
| `telemetry` | `[summary\|events\|rollup] [--window <7d>] [--kind <k>] [--limit <n>]` | no | implemented | Telemetry (D78): `summary` (invocations, outcomes, latency and injected bytes per hook and check), `events` (routing, spawn, Jev and spill events), `rollup` (move complete days into archive.db and apply the retention). Local only. |
| `uninstall-statusline` | `[--user\|--project] [--purge-base]` | no | implemented | Take the anti-hall status line out of the host's settings (L9a, the port of statusline/uninstall-statusline.js): restores the saved original statusLine, else the settings backup, else removes the key; `--project` for ./.claude/settings.local.json, `--purge-base` to also remove the shared base configuration. |
| `update` | `[--check] [--post-pull-only]` | no | implemented | Update anti-hall (D81, lane L9b, the port of skills/update/scripts/update.js): `git pull --ff-only` of the marketplace clone (a dirty tree or a diverged history is a hard STOP, offline fails open), a copy of the plugin into a new version-pinned cache directory, the harness's own `claude plugin update` when its registry is behind (bounded, never answering a confirmation; installed_plugins.json is only read), the changelog delta, then one JSON status line and a human summary. `--check` only compares versions. The DevSwarm store sweeps and the settings migration still run by the plugin's own update.js --post-pull-only and are merged into the status. |
| `version` | `` | yes | implemented | Print the version this build reports. |

## Socket protocol

| Name | Request | Reply | What it does |
|---|---|---|---|
| `hook` | `V <client-version> E <request env JSON> <hook payload JSON>` | `OK <hook output JSON or empty> \| BUSY \| ERR <reason>` | A hook payload evaluated against the rules and built-in checks. The client half-closes after writing; the reply is always a framed OK, BUSY or ERR, and anything else makes the client run the Node hook. |
| `impact` | `CTL impact [kind=<kind>] [project=<hash>] [recent=<n>] [window=<7d>]` | `OK <impact JSON>` | The impact ledger report as JSON. |
| `metrics` | `CTL metrics [check=<name>] [rollup=<resolution> since=<s>]` | `OK <metrics JSON>` | All metric series as JSON, optionally for one check; with rollup, the stored rollups of one resolution instead. |
| `ping` | `CTL ping` | `OK pong <version> <pid>` | Liveness probe; also how a starting daemon checks that a live one already owns the socket. |
| `project` | `P <cwd> [W <write-id> ]<put\|take\|len\|set\|setex\|get> [args]` | `OK <value> \| ERR <reason> \| BUSY` | A per-project operation on hot.db; the daemon derives the partition from the cwd, so a request cannot name another project's key. A write is answered only after it commits; the optional write id makes it idempotent. |
| `reload` | `CTL reload` | `OK ok` | Re-read the rules file now (it is also re-read on SIGHUP and on change). |
| `schedule` | `CTL schedule list \| run job=<name> \| history [job=<name>] [limit=<n>]` | `OK <schedule JSON>` | The scheduler: the jobs and their schedules, run one now, or the run history. |
| `status` | `CTL status` | `OK <status JSON>` | The daemon's state as JSON, including a headline summary. |
| `stop` | `CTL stop` | `OK ok` | Drain and exit. |
| `telemetry` | `CTL telemetry [summary\|events] [window=<7d>] [kind=<k>] [limit=<n>]` | `OK <telemetry JSON>` | The telemetry summary or its events as JSON, including what the daemon has recorded but not yet flushed (D78). |
| `dispatch` | `D <client-version> <meta JSON: host, event, tool, root> <hook payload JSON>` | `OK <JSON array of [id, verdict, text]> \| BUSY \| ERR <reason>` | The built-in checks of one event's dispatch table, evaluated by the daemon; the client runs the other entries and every deferral as their Node hooks. |

## Checks

A rule selects a built-in check with `"check": "<name>"`; the check's tables, limits and messages are in its defaults file.

Rule fields (JSON): `id`, `events`, `tools`, `field`, `pattern` (regex), `check`, `options`, `action` (deny, warn or context), `message`, `paths`.

| Check | What it does |
|---|---|
| `git` | Port of the git-guard hook: blocks force pushes, remote ref deletion, AI self-credit in commits, handover commits, launcher-directory writes and the same through aliases, runners and heredocs |
| `merge-side-pick` | Advisory: a push after a conflict was resolved by taking one side wholesale, with no test run since (port of merge-side-pick.js). |
| `ship-it-guard` | Opt-in plan gate: blocks edits to hard-risk files with no PLAN.md and advises on files a plan's phases do not declare (port of ship-it-guard.js). |
| `scan-throttle` | Advisory: recommends the background-throttled form of a user-configured heavy scan command (port of scan-throttle.js). |
| `coordinator-work-guard` | Main-thread work window. PreToolUse: allows subagent Bash calls in the engine and defers the rest (the classification and the block stay with Node). PostToolUse: records the call in the window, nudges once per crossing and folds stale session files, when the call's classification is already known (the Node pre-verdict of the same tool call) or provably not work; otherwise defers (port of coordinator-work-guard.js). |
| `compact-declaration-guard` | Allows new work unless the current turn may hold a SAFE TO COMPACT declaration; a possible declaration defers to the Node guard, which decides and blocks (port of compact-declaration-guard.js). |
| `command` | command-guard (PreToolUse on Bash): heavy-command and Bash-write delegation gate; the engine answers the commands allowed in every context and every command of a payload-proven subagent, and defers the rest to the Node hook. |
| `model-routing` | Anti-waste Agent/Task model routing: blocks execution-shaped flagship or inherited generic spawns and advises on routing mismatches (port of model-routing-guard.js). |
| `failure-root-cause-nudge` | Advisory after a failed Bash call: trace the cause before patching; silent for expected exit-1 predicates, interrupts, harness refusals and repeats within a turn (port of failure-root-cause-nudge.js). |
| `git-audit` | Advisory after a commit-creating git command: a commit made in the last 15 minutes carries an AI self-credit trailer (port of git-guard.js --audit). |
| `verify-first-subagent` | SubagentStart context: injects the verify-first protocol (compact, or full when context.protocolLevel is full) into every spawned subagent (port of verify-first-subagent.js). |
| `verify-first-full` | SessionStart context: injects the verify-first protocol and discipline index for the session, Claude or Codex text (port of verify-first-full.js). |
| `fable-availability` | SessionStart: records whether a Fable model is available (from the host's model cache) in ~/.anti-hall/fable-availability.json and tells the session when it is (port of fable-availability.js). |
| `inbox-read-guard` | Blocks a Read of the raw DevSwarm inbox; a Read of the raw store defers to Node, which probes the wrapper; dormant unless DevSwarm is active (port of inbox-read-guard.js). |
| `phase-tracker` | Records each Agent or Task spawn in ~/.anti-hall (the statusline's live swarm bar and the running-agents heartbeat); never blocks (port of phase-tracker.js). |
| `orch-on-spawn` | Silent unless a spawn-time delivery is pending: answers every case where Node would print nothing; a pending marker defers to Node, which owns the claim race (port of orch-on-spawn.js). |
| `verify-first-orch` | SessionStart orchestration text for the Claude entry: composes the full or compact text and keeps the delivery marker; a DevSwarm session defers to Node (port of verify-first-orch.js --host=claude). |
| `verify-first-orch-codex` | SessionStart orchestration text for the Codex entry (the same hook without --host=claude, so never Claude-confident): composes the full or compact text and keeps the delivery marker; a DevSwarm session defers to Node. |
| `verify-first` | UserPromptSubmit: the short rotating verify-first reminder, deduplicated per session; DevSwarm Primary sessions stay on Node (port of verify-first.js). |
| `idle-agent-sweep` | UserPromptSubmit: lists agents that finished but were never stopped or closed, and the call that ends each (port of idle-agent-sweep.js). |
| `emit-dedupe-reset` | SessionStart: marks a context loss in the session's emit-dedupe state so the next UserPromptSubmit blocks are re-emitted (port of emit-dedupe-reset.js). |
| `limit-conserve-inject` | UserPromptSubmit: injects the limit-conservation directive while conservation is on or a usage bucket is at the threshold (account-switch guard and emit-dedupe as in Node), else an empty context; defers only what JavaScript could read differently (port of limit-conserve-inject.js). |
| `auto-handover` | UserPromptSubmit: the threshold fire, the soft advisory, the milestone nag, the latch re-arm and the post-handover gate with its backstop, latch and inferred-window writes as in Node; defers the gate on a prompt with text (Node logs a Jev decision row there) and what JavaScript could read differently (port of auto-handover.js). |
| `auto-handover-pause-nag` | Stop: the Stop-side fire with the decisive good-point line, the pause nag (step, quiet window, open tasks, recent spawns, handover freshness) and the re-arm, latch writes as in Node; defers only what JavaScript could read differently (port of auto-handover-pause-nag.js). |
| `compact-advice-guard` | Stop: blocks, once per declaration, a final reply that recommends compacting at low context or just after a compact (phrase analysis, latch exception and record as in Node); defers a text with a line terminator other than LF and what JavaScript could read differently (port of compact-advice-guard.js). |
| `version-alert` | SessionStart advisory: a newer anti-hall release is available or already mirrored locally (port of version-alert.js); a stale remote cache defers to Node, which starts the refresh. |
| `devswarm-version` | SessionStart advisory: the DevSwarm CLI drifted by major or minor from the verified version (port of devswarm-version.js); a stale cache defers to Node, which starts the probe. |
| `claude-cli-version` | SessionStart advisory: the Claude Code CLI drifted by major or minor from the audited version (port of claude-cli-version.js); a stale cache defers to Node, which starts the probe. |
| `repo-self-drift` | SessionStart advisory: docs/KB.md's claimed hook and skill counts differ from disk, or the model KBs were audited too long ago (port of repo-self-drift.js). |
| `defect-nudge` | SessionStart advisory, at most daily: unfinished defect reports (in the anti-hall repository) or rulings on defects this project reported (port of defect-nudge.js); counts and ages only. |
| `progress-prune` | SessionStart maintenance: archives stale per-session progress files into the history ledger before removing them, and reminds weekly to git-ignore .anti-hall/ (port of progress-prune.js). |
| `speculation-guard` | Stop gate: blocks once per reply that states something with a hedge word and no evidence or uncertainty flag, asks Jev (speculation, add-block; speculationFramed, relax-block) and records the outcome of the previous block; defers the causal-claim scan, a payload without the reply text and a reply window that would cut a surrogate pair (port of speculation-guard.js). |
| `speculation-judge` | Stop: the opt-in semantic judge; answers every path without a model call, and in a one-shot process asks the Claude CLI judge itself (jev.judgeBackend cli); an Anthropic API call, and a model call inside the daemon, stay with Node (port of speculation-judge.js). |
| `claim-ledger` | Stop, never blocks: records the checkable claims of the last reply that no evidence in the session backs; asks the Jev shadow question (claimLedger) for each flag on the shared Jev lane without waiting (port of claim-ledger.js). |
| `output-verify-guard` | PostToolUse advisory: flags a test-runner output with both a passing and a failing signal; asks the Jev shadow question (outputVerifyGuard) without waiting (port of output-verify-guard.js). |
| `ask-guard` | Advises on or blocks a question put to the user, and notes background agents still in flight (port of ask-guard.js). |
| `silent-agent-nudge` | Stop: nudges once per silent background agent (the block text, the nudge state, the stale-build downgrade and the per-session ack of the Node hook) and answers every Stop that would not nudge (port of silent-agent-nudge.js). |
| `stale-agent-stop-note` | Advisory: a TaskStop on an agent that was sent a message or resumed after its last report (port of stale-agent-stop-note.js). |
| `merge-gate` | Opt-in false-done backstop: answers every Bash call natively, including the block of an auto-merge after an unresolved self-hedge and the Jev shadow ask that goes with a hedge; defers only a relative transcript path, a transcript line the engine cannot parse and a text window that would cut a surrogate pair (port of merge-gate.js). |
| `api-guard` | Fabricated-API guard: answers every call the Node api-guard would allow without probing an interpreter (guard off or skipped, a target that is not Python or JavaScript, code that names no verifiable module or global, a Bash command that names no code file, or whose text cannot hold a verifiable reference or cannot write a file) and defers the rest, so every interpreter probe stays with the Node hook (port of api-guard.js). |
| `edit-guard` | Coordinator delegation gate for Edit, Write, MultiEdit and NotebookEdit: answers the launcher-directory block and every call that is not the main thread (subagent or no recognised entry point) exactly as the Node edit-guard does, and defers every main-thread call and every apply_patch to the Node hook, which owns the allowlists, the symlink honesty checks, plan mode, the trusted per-project allowlist and the DevSwarm wording (port of edit-guard.js). |
| `devswarm-comms-guard` | Blocks SendMessage to a peer session whose cwd is a DevSwarm workspace while DevSwarm is active, and labels other known targets (port of devswarm-comms-guard.js). |
| `swarm-guard` | Blocks an agent spawn past the spawn-rate cap or under critical memory pressure, and adds the shared-tree advisory to an allowed write-capable spawn that shares a working tree with a running write-capable agent (port of swarm-guard.js and lib/shared-tree-note.js). |
| `jev-weekly-scorecard` | Stays silent when the weekly Jev scorecard notice cannot be due (Jev off, notice off, child workspace, checked within a week); when the check is due and the Jev decision log holds no rows it stamps the weekly latch itself; otherwise defers to the Node hook, which builds the report (port of jev-weekly-scorecard.js). |
| `jev-review-reminder` | Stays silent when no session-start Jev notice can be due (Jev and the semantic judge off, the recommend notice off or shown within 30 days, a subagent turn, a non-interactive run); shows the recommend-Jev notice and stamps its latch itself when that is the only notice due; otherwise defers to the Node hook (port of jev-review-reminder.js). |
| `repair-on-reload` | Stays silent when no repair can start (switch off, subagent turn, skipped, nothing pending at the running version, cooldown); otherwise defers to the Node hook, which takes the lock and starts the detached repair (port of the gates of repair-on-reload.js). |
| `codex-availability` | SessionStart: probes PATH for a real codex executable, records it, folds a Codex job-log usage-limit error into the quota record and tells the session (port of codex-availability.js). |
| `codex-quota-detect` | Advisory: records a Codex quota or rate-limit exhaustion reported by a codex:codex-rescue Agent result, once, in the shared availability file (port of codex-quota-detect.js). |
| `codex-nudge` | Stop: one soft nudge to get a Codex second opinion after several substantial code edits with no Codex review; defers when Jev is enabled for it (port of codex-nudge.js). |
| `precompact-snapshot` | PreCompact: writes a mechanical continuation snapshot (git state, task list, last user messages) before compaction and never blocks it (port of precompact-snapshot.js). |
| `handover-resume` | SessionStart: points a fresh or compacted session at the newest handover with git facts measured now (port of handover-resume.js). |
| `task-lifecycle-log` | Appends one line per TaskCreated/TaskCompleted event to the per-session history ledger and its index (port of task-lifecycle-log.js). |
| `dispatch-tier` | Asks Jev (dispatchTier, detached) how a new or changed task should be dispatched, once per task text, and keeps the request marker in dispatch-tier-state.json; does nothing while the integration is off (port of dispatch-tier.js). |
| `task-guard` | Stop gate: blocks a Stop while tasks are open (the idle-neglect block when dispatchable work has no running agent, else the generic block), with the loop state, the per-prompt budget and the OMC and live-agent steps aside of the Node hook; hands a Stop whose answer needs the DevSwarm app database to Node (port of task-guard.js). |
| `tasklist-guard` | Stop gate: blocks a Stop after untracked work, tasks stalled in progress or a missing or stale progress file, with the Node hook's loop state, dedupe, cap, handover advisories, stop-policy budget and acknowledgement; answers the quiet Stops, plan mode and the resume-verification nudge with the same file effects (port of tasklist-guard.js). |
| `devswarm-parent-inbox` | DevSwarm Primary prompt hook: answers the silent cases (not a Primary, DevSwarm inactive, switch off, judge child) in the engine; an active Primary defers to the Node hook, which owns the roster, mailbox and dedupe state (port of the gate of devswarm-parent-inbox.js). |
| `devswarm-child-turn` | DevSwarm child prompt hook: answers the silent cases (not a child workspace, DevSwarm inactive, switch off, judge child) in the engine; an active child defers to the Node hook, which writes the heartbeat and descriptor and renders the mailbox (port of the gate of devswarm-child-turn.js). |
| `devswarm-child-role` | SessionStart: injects the DevSwarm mesh-only messaging directive for a child workspace (port of devswarm-child-role.js); a Primary session, a stale stable launcher or anything else it cannot prove byte-identical defers to Node. |
| `devswarm-parent-gate` | Stop: allows without running Node when the Node gate would exit silently before reading any mailbox (switch off, user skip, supervisor inactive, child workspace, judge child, or the model already continuing after a Stop block); every other session defers to the Node gate (port of devswarm-parent-gate.js, early exits only). |
| `devswarm-child-gate` | DevSwarm child Stop gate: allows the stop when the hook cannot act (switch off, skip recorded, not a DevSwarm child); a child workspace defers to the Node gate, which owns the heartbeat state, the stop budgets, the mailbox store and the hivecontrol probe (port of devswarm-child-gate.js). |
| `devswarm-parent-reply-tracker` | DevSwarm Primary reply tracker: allows every Bash call that is not a devswarm send (switch off, child workspace, other tool, command without the devswarm and send words); a plausible send defers to the Node hook, which records the reply state (port of devswarm-parent-reply-tracker.js). |
| `devswarm-child-drain` | DevSwarm child mailbox drain nudge: allows the call when the hook cannot act (switch off, not a DevSwarm child) and when it would stay silent before counting any mail (not a Bash call, a subagent's call, an `inbox read-primary` command, no usable workspace id, no descriptor naming an inbox); anything that needs the unread count defers to the Node hook, which reads the mailbox store and keeps the throttle state (port of devswarm-child-drain.js). |
| `sibling-sweep` | Stop and SubagentStop reminder: when the reply states the cause of a bug in a fix context and the turn shows no search for other occurrences of the same pattern, asks once per cause to search, fix or list every occurrence and state the search run; counts reminders and follow-through (engine-only, no Node twin). |
| `handover-hygiene` | SessionStart advisory (engine-only, no Node twin): reports handovers that are unindexed, stale, missing a brief or malformed (no front matter, no Situation or Next action, a broken reference) once per distinct problem set; the same script builds the handover brief tree (`ah-engine handovers index\|check\|search`) and runs as the `handovers` scheduled job. |
| `session-end-mcp-reaper` | SessionEnd sweep of orphaned MCP server processes (parent PID 1, MCP command signature, old enough, not service-managed, never test runners), with Node's selection rules and audit log; a user pattern or start time it cannot read exactly defers to Node (port of session-end-mcp-reaper.js). |
| `task-tracker` | UserPromptSubmit task-list discipline: the full directive or the short reminder (window, transcript growth, keepalive and burst dedupe as Node keeps them), the open-tasks line, the newRequest Jev label of each prompt and the previous turn's demand score; a session that could be a DevSwarm Primary, or has a task the per-turn DISPATCH NOW line would name or a dispatch-tier outcome still to record, defers to Node (port of task-tracker.js). |

## Settings

Defaults ship with the plugin in `engine/defaults/*.toml` and are read at run time; a numeric setting with an environment variable can be overridden for one process.


### engine.toml / atomic

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `atomic.tmp_suffix` | `.tmp` |  |  | Suffix of the temporary file every atomic state write goes through before the rename (a `.json` target keeps a `.json` ending after it). |

### engine.toml / client

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `client.breaker_cooldown_s` | `60` | `AH_ENGINE_BREAKER_COOLDOWN_S` | s | How long the breaker stays open once tripped. |
| `client.breaker_n` | `5` | `AH_ENGINE_BREAKER_N` |  | Engine failures within the window that open the breaker (the client then skips the engine). |
| `client.breaker_window_s` | `60` | `AH_ENGINE_BREAKER_WINDOW_S` | s | Window in which breaker failures are counted. |
| `client.cold_start_poll_ms` | `1` |  | ms | Poll interval while waiting for a cold-started daemon. |
| `client.cold_start_wait_ms` | `40` |  | ms | How long a client with no fallback waits for a cold-started daemon before giving up (prints nothing). |
| `client.crash_cooldown_s` | `1800` | `AH_ENGINE_CRASH_COOLDOWN_S` | s | How long respawning stays stopped after a crash loop. |
| `client.crash_n` | `4` | `AH_ENGINE_CRASH_N` |  | Daemon deaths within the window that stop respawning. |
| `client.crash_window_s` | `600` | `AH_ENGINE_CRASH_WINDOW_S` | s | Window in which daemon deaths are counted. |
| `client.ctl_timeout_ms` | `1500` |  | ms | Deadline for a control exchange (ping, status, reload, stop, project ops). |
| `client.deadline_ms` | `2000` | `AH_ENGINE_DEADLINE_MS` | ms | Overall deadline for one engine exchange (connect, write, read); a hard watchdog thread enforces it. |
| `client.deadline_slack_ms` | `50` |  | ms | Extra wait for the exchange thread to report after the deadline before the client declares a timeout. |
| `client.fallback_ms` | `8000` | `AH_ENGINE_FALLBACK_MS` | ms | The Node fallback hook must finish, and its stdout and stderr must reach EOF, within this long. A hook still running at the deadline is killed (then plain allow, since it is unavailable); one that finished with output still unread is an error outcome, never an empty stdout. |
| `client.fallback_poll_ms` | `2` |  | ms | Poll interval while the Node fallback runs. |
| `client.max_reply` | `2097152` |  | bytes | Largest reply the client reads. |
| `client.max_stdin` | `8388608` |  | bytes | Largest hook payload the client reads from stdin. |
| `client.slow_probe_ms` | `200` |  | ms | After an exchange times out, how long the client waits for a ping: a daemon that answers is slow but healthy (logged as client_slow, not counted toward the breaker); one that does not counts as a failure. |

### engine.toml / daemon

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `daemon.accept_error_backoff_ms` | `50` |  | ms | Sleep after an accept that failed for a reason other than nothing pending (a full descriptor table, EMFILE): the pending connection would make poll fire again at once, so without it the accept loop spins at full CPU. Kept well under daemon.stall_ms. |
| `daemon.accept_poll_ms` | `200` |  | ms | Accept-loop poll interval while serving. |
| `daemon.bucket_cap` | `4096` |  |  | Most distinct keys one token-bucket map tracks; idle full buckets are dropped first and unknown keys are refused under a key flood. |
| `daemon.busy_write_ms` | `100` |  | ms | Write timeout for the BUSY reply sent from the accept loop. |
| `daemon.close_max_ms` | `30000` |  | ms | Longest a drain's exit timer waits for the database close (the commit of everything queued) once it has started, so a timer that fires during the close cannot lose queued commits. A close wedged longer than this is cut off. |
| `daemon.drain_grace_ms` | `1000` |  | ms | After a drain starts, a worker or loop that has not finished in this long is cut off. |
| `daemon.drain_max_ms` | `10000` |  | ms | Longest a clean drain (handoff, stop, idle exit, SIGTERM) may take before the daemon exits anyway, so a worker stuck while draining can never keep the process (and the singleton lock) alive with its socket already gone. Above daemon.stuck_ms, so the stuck-worker check normally ends such a drain first. |
| `daemon.drain_poll_ms` | `20` |  | ms | Accept-loop poll interval while draining. |
| `daemon.eval_budget_us` | `200000` | `AH_ENGINE_EVAL_BUDGET_US` | us | Per-request thread CPU budget for rule evaluation; 0 turns the budget off. |
| `daemon.forced_exit_code` | `75` |  |  | Exit status of a forced drain exit (sysexits EX_TEMPFAIL, 75); the next client call starts a fresh daemon. |
| `daemon.idle_check_ms` | `1000` |  | ms | How often the watchdog compares the last request time with idle_exit_s. |
| `daemon.idle_exit_s` | `0` | `AH_ENGINE_IDLE_EXIT_S` | s | Seconds without any request after which the daemon exits (the next hook call starts a fresh one, and the scheduler catches up its missed jobs); 0 keeps it resident. 0 by default: the daemon is always resident so the scheduler and mailbox keep running after every session closes (D7). A daemon whose state dir, lock file or executable is gone still exits on its own (daemon.orphan_check_ms). |
| `daemon.lock_poll_ms` | `10` |  | ms | Poll interval while waiting for the singleton lock. |
| `daemon.lock_wait_ms` | `1500` |  | ms | How long a starting daemon waits for an outgoing (version-handoff) daemon to release the singleton lock. |
| `daemon.malloc_conf` | `narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0` |  |  | Allocator purge tuning handed to the daemon at start (jemalloc `malloc_conf` syntax): one arena for the four worker threads (less fragmentation) and decay 0 (freed pages go back to the OS at once; the system allocators keep them, which left RSS at 2.5x the live heap). Measured on 1000 mixed calls, this Mac: system allocator 45-48 MB RSS, jemalloc with only decay 0 37 MB, with narenas:1 as well 32 MB (live heap 16 MB), adding tcache:false 27 MB but p50 call latency 10 ms against 6.5-7 ms, so tcache stays on. empty = the allocator's own defaults. A variable the caller already set is not overridden. |
| `daemon.malloc_conf_vars` | `_RJEM_MALLOC_CONF, MALLOC_CONF` |  |  | Environment variables the allocator reads its tuning from (the crate's prefixed name and the plain one). |
| `daemon.max_request` | `1048576` | `AH_ENGINE_MAX_REQUEST` | bytes | Largest request the daemon reads; the client sends nothing larger (it falls back instead). |
| `daemon.mem_mb` | `512` | `AH_ENGINE_MEM_MB` | MB | Data-segment limit applied with setrlimit; 0 = none. It is a ceiling against runaway allocation, not a budget (the RSS cap is the budget), and Linux enforces it on thread stacks, so it must exceed daemon.workers times git.stack_mb plus headroom or a check thread cannot start. macOS accepts the call but does not enforce it. |
| `daemon.nice` | `5` | `AH_ENGINE_NICE` |  | `nice` increment applied to the daemon process. |
| `daemon.orphan_check_ms` | `2000` |  | ms | How often a daemon checks that its state directory, its lock file (same inode) and its executable still exist; once one is gone it drains and exits, so a daemon whose files were removed under it (a test's temporary dir, an uninstall) never runs on unreachable. |
| `daemon.project_burst` | `400` | `AH_ENGINE_PROJECT_BURST` |  | Token-bucket burst per project. |
| `daemon.project_rps` | `100` | `AH_ENGINE_PROJECT_RPS` |  | Sustained requests per second allowed per project; 0 = unlimited. |
| `daemon.queue` | `16` | `AH_ENGINE_QUEUE` |  | Connections that may wait for a worker; beyond this the daemon answers BUSY and the client falls back. |
| `daemon.read_ms` | `1000` | `AH_ENGINE_READ_MS` | ms | Total time a client has to deliver its request. |
| `daemon.read_poll_ms` | `100` |  | ms | Socket read timeout slice while collecting a request (the total is read_ms). |
| `daemon.reply_slack_ms` | `150` |  | ms | Time kept back from a request's client deadline (client.deadline_ms, or what a dispatch request says) to write the reply: the inner budgets that could outlast the client's wait (a git call, a Jev consult) are clamped to the deadline minus this, so a slow dependency costs a fallback, not a lost answer. |
| `daemon.rss_cap_kb` | `65536` | `AH_ENGINE_RSS_CAP_KB` | KB | Resident-set cap; above it the daemon drains and exits cleanly and the next call starts a fresh one; 0 = none. Set from measurement, not guessed: steady state of the 61-check engine on a mixed real-payload replay (5000 calls, a 142 MB transcript read by the Stop checks) is 33-36 MB RSS with jemalloc (aarch64-apple-darwin, linux-gnu) and 45-52 MB with the system allocator (x86_64-apple-darwin, musl, which the allocator crate does not support); live heap is 16-18 MB in both. The cap sits above the larger figure, so only growth trips it. The previous 48 MB cap sat inside the system-allocator steady state, so the daemon restarted every ~10 s and the crash-loop breaker switched it off. |
| `daemon.rss_check_ms` | `10000` | `AH_ENGINE_RSS_CHECK_MS` | ms | How often the watchdog samples resident memory. |
| `daemon.rules_check_ms` | `200` |  | ms | How often the daemon checks the rules file (and SIGHUP) for a change. |
| `daemon.session_burst` | `200` | `AH_ENGINE_SESSION_BURST` |  | Token-bucket burst per session. |
| `daemon.session_rps` | `50` | `AH_ENGINE_SESSION_RPS` |  | Sustained requests per second allowed per session; 0 = unlimited. |
| `daemon.stall_ms` | `5000` | `AH_ENGINE_STALL_MS` | ms | An accept loop silent for longer than this trips a drain and exit. |
| `daemon.start_fail_exit_code` | `78` |  |  | Exit status when the daemon cannot start (sysexits EX_CONFIG, 78). |
| `daemon.stuck_ms` | `8000` | `AH_ENGINE_STUCK_MS` | ms | A worker busy on one request for longer than this trips a drain and exit. |
| `daemon.watchdog_tick_ms` | `250` | `AH_ENGINE_WATCHDOG_TICK_MS` | ms | How often the watchdog thread wakes to look at heartbeats. |
| `daemon.worker_wait_ms` | `200` |  | ms | How long an idle worker sleeps on the queue before looking again. |
| `daemon.workers` | `4` | `AH_ENGINE_WORKERS` |  | Worker threads evaluating requests. |
| `daemon.write_ms` | `1000` | `AH_ENGINE_WRITE_MS` | ms | Time allowed to write a reply. |

### engine.toml / defaults_load

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `defaults_load.backup_infix` | `.bak-` |  |  | What separates a defaults file's name from the time stamp of its one-time backup, taken before the first heal writes the file. |
| `defaults_load.lkg_keep` | `3` |  |  | How many last-known-good copies of the defaults (one per engine version, plugin root and shipped content) the state directory keeps; older ones are removed. |
| `defaults_load.msg_fallback` | `defaults {file} {key} rejected ({why}): using the {layer} copy` |  |  | Event-log detail when a defaults file or setting was rejected and another layer answered. Placeholders: {file}, {key} (empty for a whole file), {layer} (lkg or pristine), {why}. |
| `defaults_load.msg_heal` | `defaults {file}: added missing {keys} from the pristine copy (backup {backup})` |  |  | Event-log detail (and `config heal` output) when missing settings were added to an edited defaults file from the pristine copy. Placeholders: {file}, {keys}, {backup} (the backup file, or empty when one already existed). |
| `defaults_load.msg_heal_failed` | `defaults {file}: could not add missing {keys}: {err}` |  |  | Event-log detail (and `config heal` output) when missing settings could not be added. Placeholders: {file}, {keys}, {err}. |
| `defaults_load.msg_heal_none` | `nothing to heal: the edited defaults have every setting of the pristine copy` |  |  | Printed by `config heal` when no edited defaults file lacks a setting of the pristine copy. |
| `defaults_load.msg_heal_skipped` | `defaults {file}: missing keys {keys}: run `ah-engine config heal` to add them` |  |  | Event-log detail when missing settings were not written because the plugin root is a version-controlled checkout. Placeholders: {file}, {keys}. |
| `defaults_load.msg_lkg_failed` | `could not write the last-known-good defaults: {err}` |  |  | Event-log detail when the last-known-good copy of the defaults could not be written. Placeholder: {err}. |
| `defaults_load.vcs_markers` | `.git` |  |  | Entries (a directory or a file) that mark a version-controlled checkout: when the plugin root or a directory above it holds one, missing settings are never written into its files automatically (only `ah-engine config heal` writes there). |

### engine.toml / discard

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `discard.log_interval_ms` | `60000` |  | ms | A best-effort operation that fails (a state write the engine fails open on) is logged once per reason code in this many milliseconds; repeats inside the window are dropped so a failing disk cannot flood the event log. |
| `discard.log_kind` | `discard` |  |  | The event-log kind of every line a best-effort operation writes when it fails; the reason code is the line's code. |

### engine.toml / env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `env.dir` | `AH_ENGINE_DIR` |  |  | Overrides the state directory (default: base_dir/state_dir under the home directory). |
| `env.done_file` | `AH_ENGINE_DONE_FILE` |  |  | A file the dispatcher creates once it has dispatched an event and decided its exit code (D87). The reliability wrapper sets it, so that an engine exit code of a hook's own (1, say) is told from an engine failure and is not answered by running every hook a second time. |
| `env.fallback` | `AH_ENGINE_FALLBACK` |  |  | Path of the Node hook the client runs when the engine cannot answer (the `--fallback` argument wins). |
| `env.home` | `HOME` |  |  | Home directory variable. |
| `env.home_alt` | `USERPROFILE` |  |  | Fallback home directory variable (used by the git check when the home variable is unset). |
| `env.node` | `AH_ENGINE_NODE` |  |  | The Node binary used to run the fallback hook. |
| `env.nospawn` | `AH_ENGINE_NOSPAWN` |  |  | When set, the client never starts a daemon (tests, and hosts that manage the daemon themselves). |
| `env.plugin_root` | `AH_ENGINE_PLUGIN_ROOT` |  |  | Plugin install directory, used by built-in checks that build override commands (a rule's `options.plugin_root` wins). |
| `env.rules` | `AH_ENGINE_RULES` |  |  | Overrides the rules file path. |
| `env.session` | `AH_ENGINE_SESSION` |  |  | Session id a `proj` write is spooled under; spooled writes keep their order per session (D24). |
| `env.test_hooks` | `AH_ENGINE_TEST_HOOKS` |  |  | When set, the daemon accepts the test-only control verbs (sleep, stall, panic). Never set in production. |
| `env.tmpdir` | `TMPDIR` |  |  | Temporary directory variable, used for the short-path socket fallback. |
| `env.version` | `AH_ENGINE_VERSION` |  |  | Overrides the version this build reports and compares for handoff (the plugin version in production, arbitrary in tests). |

### engine.toml / files

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `files.advised_dir` | `advised` |  |  | Directory with one empty file per session that has already seen the failure advisory. |
| `files.backups_dir` | `backups` |  |  | Directory inside the state directory that holds backups and pre-restore snapshots (D27); nothing in it is ever deleted by the engine. |
| `files.breaker_until` | `breaker.until` |  |  | Marker holding the time (ms since the epoch) until which the client breaker stays open. |
| `files.crashloop_until` | `crashloop.until` |  |  | Marker holding the time until which respawning is stopped after a crash loop. |
| `files.failure` | `failure.json` |  |  | Last recorded failure, for the once-per-session advisory. |
| `files.log` | `ah-engine.log` |  |  | Event log file name (state directory). |
| `files.reaped_prefix` | `daemon.run.reaped.` |  |  | Prefix of the temporary name a stale run marker is renamed to when it is claimed (the pid is appended). |
| `files.run_marker` | `daemon.run` |  |  | Written while a daemon runs; a leftover one with a dead pid is logged as one crash. |
| `files.schedules_override` | `schedules.json` |  |  | User overrides of the shipped schedules (D33): JSON, `{"jobs": {"<name>": {...}}}`; read when the daemon starts. |
| `files.spool` | `spool.log` |  |  | The write spool: project writes a client could not deliver, applied by the daemon in order (D24). |
| `files.spool_quarantine` | `spool.quarantine` |  |  | Spool records that could not be parsed or that the store refused for good, kept with their reason, never dropped (D24). |
| `files.starts` | `starts` |  |  | Counter of daemon starts, surfaced as `starts` and `restarts` in status. |
| `files.telemetry_inbox` | `telemetry-inbox.jsonl` |  |  | Events recorded by processes other than the daemon (the hook dispatcher, one-shot commands), one JSON line each, in the state directory; the daemon reads and empties it on every telemetry flush. |

### engine.toml / health

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `health.advised_cap` | `500` |  |  | When more session stamps than this exist, stamps older than advised_expire_s are removed. |
| `health.advised_expire_s` | `172800` |  | s | Age after which a session stamp may be removed. |
| `health.advisory_ttl_ms` | `3600000` |  | ms | A recorded failure older than this no longer produces an advisory. |
| `health.context_events` | `PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SubagentStart` |  |  | Hook events whose output carries `additionalContext`; other events use `systemMessage` when an advisory is merged. |
| `health.crashy_kinds` | `crash, panic, start_fail, watchdog, rss` |  |  | Event kinds that count toward the crash-loop threshold. |
| `health.degraded_kinds` | `defaults_fallback, defaults_heal_skipped` |  |  | Event-log kinds that mark the engine degraded while one is in the degraded window (a defaults file or setting that fell back to the last-known-good or pristine copy, or missing settings that could not be healed). |
| `health.degraded_window_s` | `3600` |  | s | The window over which `status` counts self-restarts and Node fallbacks, and over which a restart marks the engine degraded (shown by `status`, the shadow report and, once per session, in the session context). |
| `health.diag_lines` | `8` |  |  | Event-log lines included in the diagnostic block of a permanent-failure advisory. |
| `health.error_codes` | `3 entries, 3 entries, 3 entries, 3 entries, 3 entries` |  |  | Error-code classification: environment-class codes get a plain self-fix hint (a message key); every other code is a permanent failure that asks for an issue. |
| `health.event_text_max` | `300` |  | chars | Longest kind, code or detail written to one log line (newlines and tabs become spaces). |
| `health.log_cap` | `65536` |  | bytes | Event log size above which it is trimmed to its last log_keep_lines lines. |
| `health.log_keep_lines` | `200` |  |  | Lines kept when the event log is trimmed. |
| `health.pid_probe` | `ps, -p, {pid}, -o, command=` |  |  | Command used to read a process's command line when checking whether a pid is a live engine: the program, then its arguments with `{pid}` substituted. |
| `health.probe_poll_ms` | `2` |  | ms | How often a running probe command is checked for completion. |
| `health.probe_timeout_ms` | `1000` |  | ms | Longest a pid or memory probe command (health.pid_probe, health.rss_probe) may run; it runs on the hook path, so a wedged one is cut off and reads as no answer. |
| `health.proc_cmdline` | `/proc/{pid}/cmdline` |  |  | Where Linux keeps a process's command line (NUL-separated); read instead of running the pid probe. `{pid}` is substituted. |
| `health.rss_probe` | `ps, -o, rss=, -p, {pid}` |  |  | Command used to read this process's resident set where /proc is unavailable (macOS): the program, then its arguments with `{pid}` substituted. |
| `health.scrub_patterns` | `7 items` |  |  | Patterns removed from anything that goes into a diagnostic: each item is [regex, replacement]. Order matters. |
| `health.serve_arg` | `serve` |  |  | Subcommand a daemon is started with; also how a live engine is recognised in the process list. |

### engine.toml / hook

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `hook.event_keys` | `hook_event_name, hookEventName, event` |  |  | Payload fields that can carry the event name, tried in order (Claude Code and Codex send `hook_event_name`). |
| `hook.warn_prefix` | `anti-hall warning: ` |  |  | Prefix of a `warn` rule's message in agent-visible output. |

### engine.toml / load

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `load.events_cap` | `32` |  |  | Most distinct hook events listed per minute bucket; past it the rest are counted together. |
| `load.minutes_kept` | `60` |  |  | How many one-minute buckets of request load the daemon keeps (a rolling window; older buckets are dropped, so memory does not grow with traffic). |
| `load.proc_buckets_us` | `12 items` |  |  | Upper edges of the processing-time histogram (microseconds) the per-minute p95 is read from. |
| `load.saturation_wait_ms` | `100` |  | ms | A call that waited longer than this between accept and the start of its processing marks that minute saturated: calls are waiting on each other. |
| `load.saturation_window_minutes` | `10` |  | min | `status` reports the engine saturated while a saturated minute lies within this many minutes. |
| `load.sessions_cap` | `1024` |  |  | Most distinct session ids remembered per minute bucket; past it sessions are only counted. |
| `load.wait_noise_us` | `1000` |  | us | A wait up to this long between accept and processing is the hand-off between two threads, not queueing; only longer waits count as `calls_that_waited`. |

### engine.toml / paths

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `paths.base_dir` | `.anti-hall` |  |  | Directory under the home directory that holds all anti-hall state. |
| `paths.fallback_tmp` | `/tmp` |  |  | Last-resort base for the short-path socket when TMPDIR is unset or too long. |
| `paths.lock_suffix` | `.lock` |  |  | Suffix appended to the socket path for the singleton lock file. |
| `paths.plugin_rules_file` | `engine/rules.json` |  |  | The shipped rules file, relative to the plugin root (the engine reads it from the plugin, never from its own install). |
| `paths.private_dir_prefix` | `anti-hall-` |  |  | Prefix of the private per-user directory that holds a short-path socket (the uid is appended). |
| `paths.rules_file` | `rules.json` |  |  | Name of the user's rules override inside the state directory; when that file exists it replaces the plugin's rules file. |
| `paths.short_socket_ext` | `.sock` |  |  | Extension of a short-path socket file (its name is a stable hash of the state directory). |
| `paths.socket_file` | `e.sock` |  |  | Socket file name inside the state directory. |
| `paths.socket_max_len` | `100` |  | bytes | Longest socket path used as is; unix socket paths are capped at 104 bytes on macOS (108 on Linux), so this leaves headroom. |
| `paths.state_dir` | `ah-engine` |  |  | Engine state directory name inside base_dir (D53). |

### engine.toml / proc

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `proc.read_grace_ms` | `500` |  | ms | After a helper process (git, ps, vm_stat, a scheduled job) exits, the least time its output may take to reach end of file (it may also use what is left of the command's own timeout, as Node's spawnSync does); a process it left behind that still holds a pipe is then killed with its group and the output counts as unread, never as a whole answer. |

### engine.toml / request_env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `request_env.allow` | `42 items` |  |  | The environment variables the client forwards with every request, and the only ones the daemon evaluates a check with (never its own environment). A trailing `*` matches a prefix. PATH is read by scan-throttle. DISABLE_ANTIHALL_DEVSWARM and DEVSWARM_REPO_ID decide whether DevSwarm is active, CLAUDE_CONFIG_DIR locates the host's transcripts and NODE_TEST_CONTEXT marks a test run (inbox-read-guard, orch-on-spawn, verify-first-orch). DEVSWARM_SOURCE_BRANCH (non-empty in a DevSwarm child workspace) is read by verify-first-subagent. verify-first also reads DEVSWARM_REPO_ID, DEVSWARM_SOURCE_BRANCH and DISABLE_ANTIHALL_DEVSWARM to see whether the session could be a DevSwarm Primary. DEVSWARM_SOURCE_BRANCH also marks a DevSwarm child workspace for ask-guard. DEVSWARM_REPO_ID, DEVSWARM_SOURCE_BRANCH and DISABLE_ANTIHALL_DEVSWARM are also read by the DevSwarm prompt gates (devswarm-parent-inbox, devswarm-child-turn). DEVSWARM_BUILDER_ID and DEVSWARM_AI_AGENT (with the repo id, the source branch and the DISABLE_ANTIHALL_DEVSWARM kill switch) are read by the devswarm-child-role and devswarm-parent-gate checks. CLAUDE_PLUGIN_OPTION_* carry the plugin options the guards' switch chain reads. The rest are what the git check needs to see the client's git, never the daemon's: the `gitcache.bypass_env` names, XDG_CONFIG_HOME (locates git's config), the GIT_CONFIG_* variables (GIT_CONFIG_COUNT with its KEY_n/VALUE_n pairs travel together, since git exits 128 on a COUNT without its KEY_0; PARAMETERS and NOSYSTEM likewise), GIT_EXEC_PATH (locates git's helpers) and the object-store variables GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES and GIT_NO_REPLACE_OBJECTS. LANG and LC_* are not forwarded: the git calls discard stderr and read only config data from stdout. TZ decides the local calendar date and local-time date strings of the handover and Codex checks, and TMPDIR, TMP and TEMP locate the session scratchpad the Codex nudge exempts, and decide where `os.tmpdir()` points in the task checks (scratch paths do not count as work). DISABLE_OMC and OMC_SKIP_HOOKS are the oh-my-claudecode kill switches task-guard reads before it steps aside for an OMC loop. |
| `request_env.incomplete_key` | `ah_env_incomplete` |  |  | Reserved name, never a forwardable variable, that carries the request's incomplete flag inside the forwarded environment object (the client's variables were dropped or it had no HOME), so the daemon's checks defer to the Node guards. |
| `request_env.line_prefix` | `E ` |  |  | Prefix of the request line that carries the forwarded environment as one JSON object. |
| `request_env.max_bytes` | `65536` |  | bytes | Largest forwarded environment (sum of names and values); a client whose allowed variables exceed it forwards none of them and the request is marked incomplete, so every check defers to the Node guard (a missing or empty HOME marks it incomplete too). |

### engine.toml / store

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `store.key_cache_cap` | `1024` |  |  | Most cwd-to-project-key mappings cached (cleared when full) so the hot path does not stat per request. |
| `store.kv_cap` | `64` |  |  | Most active (unexpired) key-value pairs per project. |
| `store.mailbox_cap` | `64` |  |  | Most pending (unconsumed) mailbox entries per project. |
| `store.max_projects` | `256` |  |  | Most project partitions holding a key or a pending message; a write that would start one more is refused. |
| `store.value_cap` | `65536` |  | bytes | Largest stored value. |

### git.toml / git

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `git.add_commit_value_opts` | `15 items` |  |  | Options of commit-style commands that take a value, skipped when scanning for a broad add. |
| `git.alias_depth` | `3` |  |  | Deepest alias or shell-definition expansion that is rescanned. |
| `git.argv_alias_list` | `config, -z, --get-regexp, ^alias\.` |  |  | git arguments that list configured aliases (NUL separated). |
| `git.argv_commit_template` | `config, --path, --get, commit.template` |  |  | git arguments that read the configured commit template path. |
| `git.argv_diff_names` | `diff, --name-only, --diff-filter=d, -z` |  |  | git arguments that list changed file names, deleted files excluded. |
| `git.argv_diff_relative` | `-c, diff.relative=false` |  |  | git configuration passed so diff paths are repo-relative. |
| `git.argv_git_dir` | `rev-parse, --git-dir` |  |  | git arguments that print the git directory of a repo. |
| `git.argv_log_message` | `log, -1, --format=%B, {rev}, --` |  |  | git arguments that print one commit message; {rev} is the revision. |
| `git.backstop_commit_subs` | `commit, merge, commit-tree, interpret-trailers, tag` |  |  | Subcommands whose messages the backstop scan checks for AI self-credit. |
| `git.block_emoji` | `⛔` |  |  | Leading symbol of a block message. |
| `git.block_mark` | ` anti-hall · git-guard: ` |  |  | Product and guard label after the symbol; also the marker alias notes are inserted after. |
| `git.budget_handover_evals` | `50` |  |  | Commit evaluations the handover check may do per command. |
| `git.budget_handover_queries` | `8` |  |  | Distinct git queries the handover check may run per command. |
| `git.budget_launcher_fs` | `64` |  |  | Filesystem probes the launcher check may spend per command. |
| `git.cd_max_chars` | `4096` |  | chars | A tracked cd directory longer than this many characters is dropped (a command that long is not worth resolving). |
| `git.cd_max_segments` | `64` |  |  | A tracked cd directory with more path segments than this is dropped. |
| `git.chain_joiner` | `` -> `` |  |  | Separator between the aliases of a chain in a note. |
| `git.check_summary` | `Port of the git-guard hook: blocks force pushes, remote ref deletion, AI self...` |  |  | One-line description of the check for the generated reference. |
| `git.commit_cluster_value_flags` | `mFCct` |  |  | Short commit flags that take a value inside a cluster (-m, -F, -C, -c, -t). |
| `git.commit_creating` | `9 items` |  |  | Subcommands that create a commit, where self-credit and handover checks apply. |
| `git.commit_hash_len` | `40` |  |  | Length of a full commit hash, used to shorten it in messages. |
| `git.commit_hash_short` | `12` |  |  | Length a commit hash is shortened to in messages. |
| `git.commit_long` | `48 items` |  |  | Long options of the commit subcommand, for resolving abbreviations in reused-message checks. |
| `git.commit_long_value` | `14 items` |  |  | Long options of the commit subcommand that take a value. |
| `git.copy_verbs` | `cp, mv, install, ln, rsync, ditto` |  |  | Commands that copy, move or link files, checked for a launcher-directory target. |
| `git.credit_coauthor_alts` | `7 items` |  |  | Text after a Co-Authored-By trailer that names an AI tool (case-insensitive prefix match). |
| `git.credit_generated_alts` | `claude code, claude, chatgpt, codex, copilot` |  |  | Names after a "Generated with" footer that count as an AI tool. |
| `git.credit_gpt` | `2 entries` |  |  | A gpt- model name in a trailer: the prefix and the version digits that count. |
| `git.credit_label_gh_words` | `2` |  |  | How many non-flag words of a gh command name it in a credit-elsewhere block message (git-guard.js creditElsewhereLabel: `gh pr create`). |
| `git.file_write_tip` | `\nTip: this file's content was scanned as shell. Write the file with the Writ...` |  |  | Added to a block when the command writes a file with shell text: the file was scanned as shell. |
| `git.find_exec_flags` | `-exec, -execdir, -ok, -okdir` |  |  | find actions that run a command. |
| `git.forward_config_indexed` | `KEY_, VALUE_` |  |  | GIT_CONFIG_<prefix><n> variable families that are forwarded. |
| `git.forward_config_names` | `GLOBAL, SYSTEM, NOSYSTEM, COUNT, PARAMETERS` |  |  | GIT_CONFIG_<name> variables that are forwarded. |
| `git.forward_env_names` | `GIT_DIR, GIT_WORK_TREE, HOME, XDG_CONFIG_HOME` |  |  | Environment names a wrapper forwards to git (config and repo location). |
| `git.gh_actions` | `create, edit, comment, merge` |  |  | gh actions whose bodies are checked. |
| `git.gh_body_markers` | `claude.com/claude-code, chatgpt.com/codex, <noreply@anthropic.com>` |  |  | Markers in a gh pr, issue or release body or title that credit an AI tool. |
| `git.gh_file_opts` | `--body-file, -F, --notes-file` |  |  | gh options that name a file holding body text as the next word. |
| `git.gh_file_prefixes` | `--body-file=, --notes-file=` |  |  | gh options that name a file holding body text after an equals sign. |
| `git.gh_subs` | `pr, issue, release` |  |  | gh subcommands whose bodies are checked. |
| `git.gh_value_opts` | `7 items` |  |  | gh options that carry body or title text as the next word. |
| `git.gh_value_prefixes` | `--body=, --title=, --notes=, --subject=` |  |  | gh options that carry body or title text after an equals sign. |
| `git.git_binary` | `git` |  |  | The git program the check runs for read-only queries. |
| `git.git_builtins` | `129 items` |  |  | git subcommands, so an alias that shadows one is not mistaken for a built-in. |
| `git.git_hook_names` | `24 items` |  |  | git hook file names (a heredoc written to one is a script, not data). |
| `git.git_opts_with_value` | `7 items` |  |  | git global options that take a value, skipped when finding the subcommand. |
| `git.git_timeout_ms` | `1500` |  | ms | Timeout for the git query that resolves aliases. |
| `git.guard_name` | `git-guard` |  |  | The guard id this check answers to in skip.json and in the skip command. |
| `git.handover_dir_prefix` | `.anti-hall/handovers/` |  |  | Directory under which handovers live (never committed). |
| `git.handover_git_timeout_ms` | `3000` |  | ms | Timeout for each git query of the handover check. |
| `git.handover_skipped_advisory` | `anti-hall git-guard: the handover-commit check was skipped for {n} commit(s) ...` |  |  | Advisory when the handover check ran out of budget. Placeholder: {n}. |
| `git.hd_assign` | `^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./~+@%:,=-]+)$` |  |  | A standalone literal assignment `NAME=value` beside a data heredoc (git-guard.js HD_ASSIGN_RE); group 1 is the name, group 2 the value. |
| `git.hd_bad_dirs` | `10 items` |  |  | Directory names whose files a heredoc must not be written into (hooks, config, credentials). |
| `git.hd_data_ext` | `12 items` |  |  | File extensions a heredoc may be written to as plain data. |
| `git.hd_deny_first` | `59 items` |  |  | First words that make a heredoc consumer a script runner, so the heredoc is not data. |
| `git.hd_gh_actions` | `create, edit, comment` |  |  | gh actions a heredoc body may feed. |
| `git.hd_gh_spec` | `8 entries` |  |  | Option grammar for gh pr, issue and release commands fed by a heredoc (same fields as hd_specs). |
| `git.hd_gh_subs` | `pr, issue, release` |  |  | gh subcommands a heredoc body may feed. |
| `git.hd_notes_subs` | `add, append, show, list` |  |  | git notes subcommands a heredoc message may feed. |
| `git.hd_read_long` | `35 items` |  |  | Read-only long options accepted for log, diff and show in a heredoc-fed command. |
| `git.hd_read_opt` | `10 items` |  |  | Read-only long options with an optional value. |
| `git.hd_read_val` | `11 items` |  |  | Read-only long options with a required value. |
| `git.hd_sed_operand` | `^[A-Za-z0-9_./~$+@%:,=][A-Za-z0-9_./~$+@%:,=-]*$` |  |  | A plain-word operand of a neighbouring sed: no leading dash, no flag (git-guard.js hdSedOk). |
| `git.hd_sed_range` | `^sed[ \t]+-n[ \t]+[0-9]+(?:,[0-9]+)?p(?:[ \t]+[A-Za-z0-9_./~$+@%:,=][A-Za-z0-...` |  |  | The only sed shape that may sit beside a data heredoc: a fixed print range `sed -n <N>[,<M>]p <files>` with plain-word operands (git-guard.js HD_SED_RANGE_RE; the JavaScript negative lookahead on an operand's first character is the equivalent first-character class). |
| `git.hd_sed_script` | `^[0-9]+(?:,[0-9]+)?p$` |  |  | The fixed print-range script word of a neighbouring sed (git-guard.js hdSedOk). |
| `git.hd_sinks_basic` | `/dev/null, /dev/stdout, /dev/stderr` |  |  | Device paths a heredoc may be written to. |
| `git.hd_sinks_fd` | `/dev/fd/1, /dev/fd/2` |  |  | Extra descriptor paths accepted as data sinks in redirects. |
| `git.hd_specs` | `10 entries` |  |  | Option grammar per git subcommand for heredoc-fed commands: s = short flags, v = short flags with a value, o = short flags with an optional value, l / big_l / big_o = long flags (none / required value / optional value), num = numeric -<n> allowed, strict = unknown options are not data, read = also accept the shared read-only option sets, l_extra = more long flags. |
| `git.hd_var_deny` | `20 items` |  |  | Variable names (case-insensitive) a standalone assignment beside a data heredoc must not set: ones the shell or the allowed tools read implicitly (git-guard.js HD_VAR_DENY). |
| `git.hd_var_deny_prefix` | `13 items` |  |  | Variable-name prefixes (case-insensitive) a standalone assignment beside a data heredoc must not set: loader, git/gh config, ssh, locale and language-runtime hooks (git-guard.js HD_VAR_DENY_PREFIX). |
| `git.heredoc_git_msg_subs` | `commit, tag, notes, merge` |  |  | git subcommands that take a message from a heredoc. |
| `git.heredoc_safe_verbs` | `28 items` |  |  | Commands a data heredoc may be fed to without being treated as a shell script. |
| `git.jev_backstop_ms` | `500` |  | ms | Extra time Node's synchronous worker is allowed beyond the budget; counted in the total-time guard (Node: the +500 in the guard). |
| `git.jev_budget_ms` | `1500` |  | ms | Time budget of one self-credit consult (Node: CONSULT_BUDGET_MS). |
| `git.jev_consult_cap` | `8` |  |  | Most distinct texts one command may consult Jev about (Node: JEV_CONSULT_CAP). |
| `git.jev_false` | `no AI self-credit of any kind` |  |  | The label for a false answer of the self-credit question. |
| `git.jev_id` | `gitGuardSelfCredit` |  |  | The Jev integration id of the self-credit question (add-block trust). |
| `git.jev_instructions` | `Does this commit message, or PR/issue/release body or title, credit an AI ass...` |  |  | The Noul question of the self-credit ask (byte-identical to the Node guard's). |
| `git.jev_state_chars` | `4000` |  |  | How many UTF-16 units of a message the self-credit ask evaluates (Node: String(text).slice(0, 4000)). |
| `git.jev_total_budget_ms` | `4000` |  | ms | Most time one command may spend on self-credit consults in total; past it a consult is skipped and the regex verdict stands (Node: JEV_TOTAL_BUDGET_MS). |
| `git.jev_true` | `credits an AI assistant as author/co-author/contributor, in any phrasing` |  |  | The label for a true answer of the self-credit question. |
| `git.label_allowed` | `Allowed here: ` |  |  | Label of the allowed-here line. |
| `git.label_instead` | `Do instead: ` |  |  | Label of the remedy line. |
| `git.label_override` | `Override (only if the user explicitly asked): ` |  |  | Label of the override line. |
| `git.label_why` | `Why: ` |  |  | Label of the reason line. |
| `git.launcher_dir_pattern` | `(?i)\.anti-hall[\\/]+bin(?:[\\/]\|$)` |  |  | Pattern (case-insensitive) that recognises a path inside the plugin launcher directory. |
| `git.launcher_hops` | `10` |  |  | Most symlink hops followed when resolving a dangling launcher link. |
| `git.max_chain` | `10` |  |  | Longest git alias chain followed before giving up. |
| `git.more_marker` | `, ...` |  |  | Appended to a list that was cut short. |
| `git.noop_editors` | `true, :, cat` |  |  | Commit editors that leave the message untouched, so a reused message is used verbatim. |
| `git.note_env_alias_def` | `defining a git alias via `{name}` to run a blocked command:` |  |  | Note on a block found inside an alias defined through GIT_CONFIG_VALUE_<n>. Placeholder: {name}. |
| `git.note_git_alias_def` | `defining git alias `{name}` to run a blocked command:` |  |  | Note on a block found inside an alias definition made with -c or git config. Placeholder: {name}. |
| `git.note_git_alias_use` | `via git alias `{chain}`:` |  |  | Note on a block reached through a git alias chain. Placeholder: {chain}. |
| `git.note_shell_alias_def` | `defining shell alias `{name}` to run a blocked command:` |  |  | Note on a block found inside a shell alias definition. Placeholder: {name}. |
| `git.note_shell_def_use` | `via shell {kind} `{name}`:` |  |  | Note on a block reached through a shell alias or function. Placeholders: {kind}, {name}. |
| `git.opt_wrappers` | `8 entries` |  |  | Option grammar of wrappers with options: s = short flags without a value, v = short flags with a value, l = long flags without a value, big_l = long flags with a value, ops = operands consumed before the wrapped command. |
| `git.origin_amend` | `HEAD (`--amend` reuses it)` |  |  | Where a reused message came from: an amend. |
| `git.origin_commit` | `commit `{ref}`` |  |  | Where a reused message came from: a named commit. Placeholder: {ref}. |
| `git.origin_template` | `the commit template` |  |  | Where a reused message came from: the commit template. |
| `git.parallel_separators` | `:::, ::::, :::+, ::::+` |  |  | GNU parallel argument-source separators. |
| `git.push_cmdsubst_heredoc_note` | ` Heredoc bodies are scanned as shell even when a script only reads them as te...` |  |  | Appended to the remedy of the push_cmdsubst block when the command contains a heredoc. |
| `git.push_long_opts` | `27 items` |  |  | Long options of the push subcommand, for expanding unambiguous abbreviations such as --force-w. |
| `git.re_file_write_echo` | `\b(?:echo\|printf)\b` |  |  | JavaScript regex source: echo or printf, which with a redirect counts as a file write without a heredoc. |
| `git.re_file_write_heredoc` | `<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?` |  |  | JavaScript regex source: a heredoc operator, one half of the shape that earns the file-write tip. |
| `git.re_file_write_redirect` | `(?:^\|[\s;&\|(])>{1,2}\s*[^\s&;\|<>()0-9][^\s&;\|<>()]*` |  |  | JavaScript regex source: a > or >> redirect whose target is a file name (not a descriptor), the other half of the file-write shape. |
| `git.re_file_write_tee` | `\btee\b\s+(?:-a\s+)?[^\s&;\|<>()-][^\s&;\|<>()]*` |  |  | JavaScript regex source: a tee into a file, which counts as a redirect for the file-write shape. |
| `git.setting_alias_resolve` | `6 entries` |  |  | Switch for git alias and shell definition resolution. |
| `git.setting_git_guard` | `6 entries` |  |  | Master switch of the check: settings.json section and key, environment variable and plugin-option name. |
| `git.setting_handover_guard` | `6 entries` |  |  | Switch for the handover-commit guard. |
| `git.setting_heredoc_data` | `6 entries` |  |  | Switch for data-heredoc masking. |
| `git.setting_reused_message` | `6 entries` |  |  | Switch for the reused-commit-message check. |
| `git.shell_verbs` | `bash, sh, zsh, dash, ksh, ash` |  |  | Shell programs whose `-c` argument is itself a script to scan. |
| `git.skip_command` | `node '{script}' skip {key}` |  |  | Command that records a skip for a guard; {script} is the quoted script path and {key} the guard id. |
| `git.skip_script` | `scripts/devswarm.js` |  |  | Script, relative to the plugin directory, that records a skip for a guard. |
| `git.word_alias` | `alias` |  |  | The word for a shell alias in notes. |
| `git.word_function` | `function` |  |  | The word for a shell function in notes. |
| `git.wrapper_value_opts` | `3 entries` |  |  | Options of the sudo, timeout and nice wrappers that take a value, so the word after them is not the wrapped command (git-guard.js SUDO_VAL and the timeout and nice branches). |
| `git.wrappers` | `18 items` |  |  | Words that run another command and are looked through when finding what a segment really executes (git-guard.js WRAPPERS). |
| `git.xargs_long_other` | `12 items` |  |  | xargs long options without a value. |
| `git.xargs_long_req` | `arg-file, delimiter, max-args, max-procs, max-chars, process-slot-var` |  |  | xargs long options that take a value. |
| `git.xargs_short_opt` | `eil` |  |  | xargs short options with an optional attached value. |
| `git.xargs_short_req` | `adEILnPsJRS` |  |  | xargs short options that take a value. |

### git.toml / git_audit

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `git_audit.argv_log` | `7 items` |  |  | git arguments of the audit's log query; {dir} is the repository directory and {n} the number of commits. Fields are separated by US (0x1f) and records end with RS (0x1e). |
| `git_audit.cd_verb` | `cd` |  |  | The verb whose directory argument moves the audit's working directory. |
| `git_audit.commits` | `20` |  |  | How many commits at HEAD the audit reads. |
| `git_audit.dir_opt` | `-C` |  |  | The global git option that changes the repository directory. |
| `git_audit.eval_verb` | `eval` |  |  | The verb whose payload is scanned as a command. |
| `git_audit.event` | `PostToolUse` |  |  | The hook event name in the audit's output. |
| `git_audit.field_sep` | `` |  |  | The character that separates the fields of one commit record (US). |
| `git_audit.git_verb` | `git` |  |  | The verb of a git command. |
| `git_audit.max_buffer` | `1048576` |  |  | Largest log output, in bytes, the audit accepts from one repository (Node's child-process buffer cap: a larger output is dropped). |
| `git_audit.max_depth` | `3` |  |  | How deep eval and shell -c payloads are followed when looking for commit-creating git commands. |
| `git_audit.msg` | `anti-hall git-guard (audit): recent commit(s) on HEAD (committed in the last ...` |  |  | Advisory text. Placeholders: {window_min} (minutes) and {hits} (comma separated short hashes). |
| `git_audit.opts_with_value` | `-c, --git-dir, --work-tree, --namespace, --config-env` |  |  | Global git options that take a value in the next word (skipped when looking for the repository directory). |
| `git_audit.record_sep` | `` |  |  | The character that ends one commit record of the audit's log output (RS). |
| `git_audit.summary` | `Advisory after a commit-creating git command: a commit made in the last 15 mi...` |  |  | One-line description of the git-audit check in the generated reference. |
| `git_audit.timeout_ms` | `4000` |  | ms | Timeout of the git log the audit runs in each repository. |
| `git_audit.window_s` | `900` |  |  | How recent, in seconds, a commit must be for the audit to look at it. |

### command.toml / command

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `command.agent_markers` | `agent_id, agent_type` |  |  | The payload fields that mark a subagent (coordinator-detect.js). |
| `command.allow_dir_rel` | `.anti-hall` |  |  | The per-project allowlist directory, relative to the repository toplevel. |
| `command.allow_file_rel` | `.anti-hall/command-allow.json` |  |  | The per-project command allowlist file. |
| `command.allow_list_key` | `patterns` |  |  | The key of the command allowlist file that holds the patterns. |
| `command.allow_subagent_mailbox_setting` | `7 entries` |  |  | guards.allowSubagentMailbox: a one-off allow of the subagent mailbox verbs (default off). |
| `command.allow_trust_file_rel` | `.anti-hall/trusted-command-allow.json` |  |  | The record of trusted command allowlists, relative to the home directory. |
| `command.audit_file` | `command-allow.ndjson` |  |  | The audit log of allowlisted commands. |
| `command.audit_logs_dir` | `logs` |  |  | The log directory under the state directory. |
| `command.audit_state_dir` | `.anti-hall` |  |  | The anti-hall state directory under the home directory. |
| `command.background_chain_delims` | `;, &&, \\|, end` |  |  | Delimiters a background scratch script chain may use. |
| `command.background_script_interpreters` | `python3, node, sh, bash` |  |  | Interpreters of a background scratch script (command-guard.js BACKGROUND_SCRIPT_INTERPRETERS). |
| `command.cd_contexts_max` | `8` |  |  | Most working-directory possibilities kept per segment after a cd (command-guard.js cdAwareContexts). |
| `command.cd_delims` | `&&, ;, \\|\\|, \n` |  |  | The delimiters after which a leading cd carries into the next segment (command-guard.js cdAwareContexts). |
| `command.check_flag_refused_verbs` | `20 items` |  |  | Verbs that never get the --check/--dry-run/--list inline allowance (command-guard.js CHECK_FLAG_REFUSED_VERBS). |
| `command.check_summary` | `command-guard (PreToolUse on Bash): heavy-command and Bash-write delegation g...` |  |  | One-line description of the command check for the generated reference. |
| `command.child_env` | `DEVSWARM_SOURCE_BRANCH` |  |  | The environment variable that marks a DevSwarm child workspace (devswarm-role.js isChildWorkspace). |
| `command.classify_pull_subs` | `pull, fetch` |  |  | git subcommands that label a block a remote pull or fetch. |
| `command.classify_push_subs` | `push` |  |  | git subcommands that label a block a remote push. |
| `command.claude_subagent` | `a subagent` |  |  | How the block messages name a worker on Claude. |
| `command.cli_entrypoint` | `cli` |  |  | The entry point value of the terminal CLI. |
| `command.cloud_binaries` | `gcloud, gh, kubectl` |  |  | Cloud CLIs with a read-only inspect exemption (command-guard.js CLOUD_BINARIES). |
| `command.cloud_mutating_verbs` | `17 items` |  |  | Words that disqualify the gh/kubectl read-only exemption (command-guard.js CLOUD_MUTATING_VERBS). |
| `command.cloud_readonly_verbs` | `describe, list, get, view` |  |  | First words after gh/kubectl that read only (command-guard.js CLOUD_READONLY_VERBS). |
| `command.codex_cheap` | `a sub-agent (spawn_agent, fast-tier model)` |  |  | How the block messages name the cheap worker on Codex (host-text.js CODEX_CHEAP). |
| `command.codex_patch_tool` | `apply_patch` |  |  | The tool name that marks a Codex payload on its own (coordinator-detect.js isCodexPayload). |
| `command.codex_subagent` | `a sub-agent (spawn_agent)` |  |  | How the block messages name a worker on Codex (host-text.js CODEX_SUBAGENT). |
| `command.control_keyword_prefix` | `^\s*(?:(?:do\|then\|else\|if\|while\|until\|!)\s+)+` |  |  | Leading shell keywords stripped before a segment is judged (command-guard.js CONTROL_KEYWORD_PREFIX_RE). |
| `command.curl_bare_flags` | `--silent, --show-error, --fail` |  |  | Valueless curl flags of the token-authorized silent GET. |
| `command.defer_path_parts` | `inbox, store` |  |  | If the command or the payload cwd has one of these as a path component (lower-cased; split at slashes, backslashes, blanks and shell punctuation), the engine defers: the raw DevSwarm inbox/store read guard denies only paths whose first component under the DevSwarm root is one of them (lib/devswarm-inbox-paths.js classifyDevswarmPath). |
| `command.defer_substrings` | `devswarm.js, stash` |  |  | If the command, lower-cased with quotes and backslashes removed, contains any of these, the engine defers: the DevSwarm subagent-mailbox guard needs the literal script name (devswarm.js) and the git-stash guard a `stash` word, and both need state the engine does not mirror. |
| `command.devswarm_cli_rel` | `scripts/devswarm.js` |  |  | The devswarm CLI, relative to the plugin root. |
| `command.devswarm_cli_verbs` | `hivecontrol, devswarm` |  |  | If any segment the DevSwarm read/send guards scan has one of these as its effective verb, the engine defers (command-guard.js DEVSWARM_CLI_VERBS). |
| `command.devswarm_inbox_dir` | `inbox` |  |  | The inbox directory under the DevSwarm root (a raw read is blocked). |
| `command.devswarm_root_rel` | `.anti-hall/devswarm` |  |  | The DevSwarm state root under the home directory. |
| `command.devswarm_store_dir` | `store` |  |  | The store directory under the DevSwarm root. |
| `command.dsread_guard` | `devswarm-read-guard` |  |  | The skip id and message id of the DevSwarm destructive-read guard. |
| `command.dssend_guard` | `devswarm-send-guard` |  |  | The skip id of the DevSwarm native-send guard. |
| `command.edit_file_rel` | `.anti-hall/edit-allow.json` |  |  | The per-project edit allowlist file. |
| `command.edit_guard_name` | `edit-guard` |  |  | The skip.json id of edit-guard, whose verdict the Bash edit parity applies. |
| `command.edit_list_key` | `paths` |  |  | The key of the edit allowlist file that holds the paths. |
| `command.edit_trust_file_rel` | `.anti-hall/trusted-edit-allow.json` |  |  | The record of trusted edit allowlists, relative to the home directory. |
| `command.eg_allow_setting` | `6 entries` |  |  | guards.editGuardAllow: extra file globs edit-guard allows (comma or colon separated, empty by default). |
| `command.eg_claude_dir` | `.claude` |  |  | The host's configuration directory under the home directory. |
| `command.eg_default_allow` | `10 items` |  |  | Files and globs edit-guard always allows (edit-guard.js DEFAULT_ALLOW). |
| `command.eg_edit_allow_file` | `.anti-hall/edit-allow.json` |  |  | The repository-relative path of the edit allowlist, which no one edits through the guard. |
| `command.eg_hooks_file` | `hooks.json` |  |  | A file with this name is never allowed by the per-project edit allowlist. |
| `command.eg_plan_mode` | `plan` |  |  | The permission mode in which non-source files may be edited. |
| `command.eg_plans_rel` | `.claude/plans` |  |  | The host's plan directory under the home directory. |
| `command.eg_project_deny_segments` | `.git, .anti-hall, .claude, .codex, .husky, .githooks` |  |  | Path segments the per-project edit allowlist never reaches (edit-guard.js PROJECT_EDIT_DENY_SEGMENTS). |
| `command.entrypoint_env` | `CLAUDE_CODE_ENTRYPOINT` |  |  | The environment variable that names the host entry point (coordinator-detect.js isCoordinator). |
| `command.file_read_verbs` | `12 items` |  |  | Verbs that read file contents (the raw DevSwarm inbox read guard). |
| `command.gcloud_boolean_flags` | `--quiet, --uri` |  |  | gcloud flags without a value the read-only grammar accepts (command-guard.js GCLOUD_BOOLEAN_FLAGS). |
| `command.gcloud_inspect_verbs` | `describe, list, get, view, read` |  |  | gcloud command-path verbs that read only (command-guard.js GCLOUD_INSPECT_VERBS). |
| `command.gcloud_logging_group` | `logging` |  |  | The only gcloud group whose `read` verb is read-only (command-guard.js `g.path[last] !== 'logging'`). |
| `command.gcloud_read_verbs` | `describe, list, get-iam-policy, read` |  |  | The gcloud verbs of the narrow read-only access. |
| `command.gcloud_refused_path` | `^(?:access\|ssh\|scp\|run\|sign\|print-[^\n\r]*\|attach-[^\n\r]*\|detach-[^\n\r]*\|ad...` |  |  | gcloud command-path words that refuse the read-only grammar (command-guard.js GCLOUD_REFUSED_PATH_RE). |
| `command.gcloud_sink_verbs` | `tail, head, wc, grep` |  |  | Sinks the narrow gcloud read may pipe into besides jq. |
| `command.gcloud_token_vars` | `T, TOKEN, ACCESS_TOKEN, GCLOUD_TOKEN` |  |  | Variable names the gcloud token prefix may use. |
| `command.gcloud_value_flags` | `8 items` |  |  | gcloud flags whose separated value the whole-command read-only form accepts (command-guard.js GCLOUD_VALUE_FLAGS). |
| `command.gh_api_field_flags` | `-f, -F, --field, --raw-field` |  |  | gh api options that send a request body (command-guard.js isHeavyGhSegment and GH_GQL_FIELD_FLAGS). |
| `command.gh_api_mutating_methods` | `POST, PATCH, PUT, DELETE` |  |  | gh api methods that are heavy (command-guard.js GH_API_MUTATING_METHODS). |
| `command.gh_gql_bool_flags` | `--paginate, --slurp, --silent, -i, --include, --verbose` |  |  | gh api graphql options without a value (command-guard.js GH_GQL_BOOL_FLAGS). |
| `command.gh_gql_value_flags` | `8 items` |  |  | gh api graphql options that take a value (command-guard.js GH_GQL_VALUE_FLAGS). |
| `command.gh_mutating_subcommands` | `6 entries` |  |  | gh group and subcommand pairs that are heavy (command-guard.js GH_MUTATING_SUBCOMMANDS, plus `workflow run`). |
| `command.git_branch_argv` | `symbolic-ref, --short, HEAD` |  |  | The git arguments that print the current branch (plain-push carve-out). |
| `command.git_fetch_dangerous_flags` | `--prune, -p, --prune-tags, --force, -f` |  |  | git fetch options that rewrite or delete local refs (command-guard.js GIT_FETCH_DANGEROUS_FLAGS). |
| `command.git_global_value_opts` | `8 items` |  |  | git global options that take a value (command-guard.js GIT_GLOBAL_VALUE_OPTS). |
| `command.git_heavy_subs` | `push, pull, clone` |  |  | git subcommands that are always heavy (command-guard.js isHeavyGitSegment). |
| `command.git_timeout_ms` | `5000` |  | ms | How long a git question of the plain-push carve-out may take (command-guard.js: 5000 ms). |
| `command.guard_name` | `command-guard` |  |  | The guard id command-guard answers to in skip.json and in its messages. |
| `command.heavy_default_label` | `heavy` |  |  | The category label when a heavy command has no classification. |
| `command.heavy_pattern_label` | `heavy-pattern` |  |  | The category label of a heavy command found by a pattern. |
| `command.heavy_patterns` | `7 items` |  |  | Patterns over the quote-neutralized segment that make it heavy (command-guard.js HEAVY_PATTERNS). |
| `command.heavy_verbs` | `63 items` |  |  | Effective verbs that are always heavy in the main thread (command-guard.js HEAVY_VERBS). |
| `command.ide_entrypoint_prefix` | `terminal_ide_` |  |  | Entry points that start with this are IDE terminals (a main thread). |
| `command.ide_entrypoints` | `vscode, jetbrains, vim, emacs` |  |  | Entry points of editor hosts (main threads). |
| `command.inbox_cmd_setting` | `6 entries` |  |  | devswarm.inboxCmd: a consumer-configured command to read pending mesh messages (no default). |
| `command.inline_other_flags` | `-e, -E` |  |  | The inline-code flags of perl, ruby and node (command-guard.js inlineCodeBody). |
| `command.inline_python_flags` | `-c` |  |  | The inline-code flag of the python interpreters (command-guard.js inlineCodeBody). |
| `command.inline_verbs` | `python, python3, perl, ruby, node` |  |  | Interpreters whose inline code is scanned for literal write targets (command-guard.js INLINE_VERBS). |
| `command.inline_write_markers` | `open, File, createWriteStream, .write(` |  |  | If inline interpreter code contains any of these, it may name a literal write target and the engine defers (a superset of command-guard.js INLINE_OPEN_RE, INLINE_PERL_OPEN3_RE, INLINE_PERL_OPEN2_RE, INLINE_WRITEFILE_RE and INLINE_FILE_WRITE_RE, which all need one of them). |
| `command.jq_refused_words` | `env, input, inputs, input_filename, import, include` |  |  | jq words the narrow gcloud read refuses in a filter (environment, input and import access). |
| `command.jq_safe_flags` | `9 items` |  |  | jq flags the narrow gcloud read accepts. |
| `command.launcher_marker` | `.anti-hall` |  |  | A command without this text cannot name a stable launcher. |
| `command.launcher_scripts` | `devswarm.js, wake-watch.js` |  |  | The stable launcher scripts under ~/.anti-hall/bin that are light (command-guard.js ANTI_HALL_CLI_PATTERNS). |
| `command.light_exceptions` | `17 items` |  |  | Patterns over the raw segment (and the segment without a leading `timeout N`) that make it light (command-guard.js LIGHT_EXCEPTIONS, the entries without a negative lookahead; a trailing `(?=\s\|$)` is written as `(?:\s\|$)`). |
| `command.light_exceptions_neg` | `3 entries, 3 entries, 3 entries` |  |  | LIGHT_EXCEPTIONS entries of the form HEAD`\b(?![^\n]*NOT)`: the segment is light when some match of `head` ends (at a word boundary, right after the text `end`) where `not_after` does not match before the end of that line (jev-report.js, doctor.js and `go env`). |
| `command.mailbox_flag_skip` | `(?:-\S+(?:\s+[^-\s]\S*)?\s+)*` |  |  | Regex source: optional flags (with an optional value each) before a devswarm.js verb (command-guard.js FLAG_SKIP_SRC). |
| `command.mailbox_guard` | `devswarm-subagent-mailbox-guard` |  |  | The skip id of the subagent mailbox guard. |
| `command.mailbox_js_prefix` | `(?:node\s+)?(?:\S*[\\/])?scripts[\\/]devswarm\.js` |  |  | Regex source: an invocation of the devswarm.js CLI (command-guard.js DEVSWARM_JS_PREFIX_SRC). |
| `command.max_classify_len` | `65536` |  |  | Commands longer than this many characters are deferred to the Node hook (command-guard.js MAX_CLASSIFY_LEN: the Node guard switches to a head/tail scan above it). |
| `command.max_depth` | `3` |  |  | Nesting depth of inline shells, eval and command substitutions the heavy and write scans follow (command-guard.js `d < 3`). |
| `command.msg_dsread_inbox_cmd_prefix` | `read via the configured ANTIHALL_DEVSWARM_INBOX_CMD, or ` |  |  | Added before the text above when a consumer-configured inbox command is set. |
| `command.msg_dsread_instead` | ``devswarm.js inbox pull <id>` then `devswarm.js inbox read <id>` (durable cur...` |  |  | What to do instead of a native read. |
| `command.msg_dsread_monitor_what` | ``hivecontrol workspace monitor` is blocked.` |  |  | Heading of the monitor block. |
| `command.msg_dsread_monitor_why` | `It is a long-poll with no default timeout: it hangs the shell until a message...` |  |  | Why monitor is blocked. |
| `command.msg_dsread_override` | `set DISABLE_ANTIHALL_DEVSWARM=1 to disable the read-guard entirely` |  |  | The override of the native read block. |
| `command.msg_dsread_rm_allowed` | ``message-count` reflects the NATIVE queue only; a 0 does not mean nothing is ...` |  |  | What stays allowed. |
| `command.msg_dsread_rm_what` | ``hivecontrol workspace read-messages` is blocked.` |  |  | Heading of the read-messages block. |
| `command.msg_dsread_rm_why` | `It mark-reads and drains the native queue, losing messages the durable inbox ...` |  |  | Why read-messages is blocked. |
| `command.msg_edit_instead` | `spawn {sub} to make this edit and have it report a tight summary.` |  |  | What to do instead ({sub} names the worker). |
| `command.msg_edit_instead_tier` | `workspace-scale matter (feature/fix/deploy, own branch + review): `node scrip...` |  |  | What to do instead for a DevSwarm Primary whose repo allows workspaces. |
| `command.msg_edit_notes` | `session notes/reports in .anti-hall/history/** or the scratchpad; repo docs n...` |  |  | What stays allowed (Claude). |
| `command.msg_edit_notes_codex` | `session notes/reports in .anti-hall/history/**; repo docs need {sub} or a tru...` |  |  | What stays allowed (Codex). |
| `command.msg_edit_override` | `{skip} (records consent in ~/.anti-hall/skip.json, 15-min TTL), then retry` |  |  | The override line ({skip} is the command above). |
| `command.msg_edit_skip_cmd` | `node {cli} skip edit-guard` |  |  | The command that records consent to skip edit-guard ({cli} is the quoted devswarm CLI path). |
| `command.msg_edit_what` | `Bash (sed -i/perl -i/tee/cp/mv/redirect/inline-code write) blocked: the {who}...` |  |  | Heading of the Bash edit parity block ({who} is the next text). |
| `command.msg_edit_who_coord` | `coordinator` |  |  | Who is blocked otherwise. |
| `command.msg_edit_who_orch` | `orchestrator` |  |  | Who is blocked when DevSwarm is active. |
| `command.msg_edit_why` | `Raw edits never happen in the main thread; the coordinator synthesizes a summ...` |  |  | Why a Bash write is blocked. |
| `command.msg_edit_why_orch` | `Raw edits in the main thread flood it; a worker returns a tight summary instead.` |  |  | Why a Bash write is blocked while DevSwarm is active. |
| `command.msg_heavy_allowed` | `piped to tail/head/wc/grep -c: `node --test <1-2 files>`, `python3 -m pytest ...` |  |  | What stays allowed inline (first part). |
| `command.msg_heavy_allowed_claude` | `; or a read-only scratchpad script (executable, absolute path, no VAR= prefix...` |  |  | End of the allowed text on Claude (the scratchpad script path). |
| `command.msg_heavy_allowed_codex` | `.` |  |  | End of the allowed text on Codex. |
| `command.msg_heavy_cd_hint` | ` To run the check inline, use `cd <dir> &&`, not `;`.` |  |  | Added when the same command joined with && would qualify for the inline check. |
| `command.msg_heavy_delegate` | `delegate to {to} (it returns a short summary)` |  |  | What to do instead ({to} names the worker). |
| `command.msg_heavy_detail_category` | ` (category: {label})` |  |  | Detail of a block caused by a heavy pattern or category. |
| `command.msg_heavy_detail_verb` | ` (verb: {label})` |  |  | Detail of a block caused by a heavy verb. |
| `command.msg_heavy_instead_tier` | `workspace-scale matter (feature/fix/deploy): `node scripts/devswarm.js spawn ...` |  |  | What to do instead for a DevSwarm Primary whose repo allows workspaces. |
| `command.msg_heavy_plain` | `heavy command` |  |  | The kind of any other heavy command. |
| `command.msg_heavy_remote` | `state-changing remote command` |  |  | The kind of a state-changing remote command. |
| `command.msg_heavy_what` | `{kind}{detail} blocked in the main thread.` |  |  | Heading of the heavy-command block ({kind} and {detail} are the next two texts). |
| `command.msg_heavy_why` | `Raw output floods the main thread.` |  |  | Why a heavy command is blocked. |
| `command.msg_mailbox_allowed` | ``inbox count`, `inbox peek-primary`, `mesh read --peek`, plain `roster`.` |  |  | What stays allowed. |
| `command.msg_mailbox_guard` | `devswarm-mailbox` |  |  | The message id of the mailbox block. |
| `command.msg_mailbox_instead` | `report what you learned to your parent; the main thread drains the mailbox it...` |  |  | What to do instead. |
| `command.msg_mailbox_override` | `set ANTIHALL_ALLOW_SUBAGENT_MAILBOX=1 to disable this guard entirely` |  |  | The override of the mailbox block. |
| `command.msg_mailbox_what` | `a DevSwarm mailbox verb (inbox pull/ack/ack-primary/read/read-primary/drain-p...` |  |  | Heading of the subagent mailbox block. |
| `command.msg_mailbox_why` | `A subagent that acks or reads advances the shared cursor, so the main thread ...` |  |  | Why a subagent may not touch the mailbox. |
| `command.msg_rawread_inbox_guard` | `devswarm-inbox-read` |  |  | The message id of the raw inbox read block. |
| `command.msg_rawread_inbox_instead` | ``devswarm.js inbox pull <id>` then `devswarm.js inbox read <id>`.` |  |  | What to do instead of a raw inbox read. |
| `command.msg_rawread_inbox_what` | `a shell read of the raw DevSwarm inbox file is blocked.` |  |  | Heading of the raw inbox read block. |
| `command.msg_rawread_inbox_why` | `It does not drain the queue, but bypasses the durable cursor, so messages get...` |  |  | Why a raw inbox read is blocked. |
| `command.msg_rawread_override` | `set DISABLE_ANTIHALL_DEVSWARM=1 to disable this guard entirely` |  |  | The override of the raw read block. |
| `command.msg_send_guard` | `devswarm-mesh-only` |  |  | The message id of the native-send block. |
| `command.msg_send_instead` | ``node scripts/devswarm.js send --to-primary --message-file <path>` (or `--to ...` |  |  | What to do instead of a native send. |
| `command.msg_send_override` | `set DISABLE_ANTIHALL_DEVSWARM=1 to disable this guard entirely` |  |  | The override of the native-send block. |
| `command.msg_send_what` | ``hivecontrol workspace {kind}` is blocked.` |  |  | Heading of the native-send block. |
| `command.msg_send_why` | `anti-hall's shared mesh store is the only agent-initiated messaging transport...` |  |  | Why a native send is blocked. |
| `command.msg_stash_allowed` | ``git stash list` (read-only).` |  |  | What stays allowed. |
| `command.msg_stash_instead` | `commit the work (even as a WIP commit); never delegate a stash to a subagent.` |  |  | What to do instead of a stash. |
| `command.msg_stash_scope_armed` | `this repo (guard armed: .anti-hall/protected-stashes exists or ANTIHALL_STASH...` |  |  | Scope text for an armed repository. |
| `command.msg_stash_scope_subagent` | `a subagent (workers must never touch the coordinator's working tree via stash)` |  |  | Scope text for a subagent. |
| `command.msg_stash_what` | ``git stash {sub}` is blocked for {scope}.` |  |  | Heading of the git stash block ({sub} is the subcommand, {scope} the next two texts). |
| `command.msg_stash_why` | `A stash can swallow another agent's protected WIP (defect b08b26566b92).` |  |  | Why a stash is blocked. |
| `command.nice_value_flags` | `-n, --adjustment` |  |  | nice options that take a value (command-guard.js effectiveVerb). |
| `command.node_eval_deny` | `8 items` |  |  | Patterns that make a `node -e` payload unsafe (command-guard.js NODE_EVAL_UNSAFE_RE, NODE_EVAL_BRACKET_ACCESS_RE and the inline denials of isSafeNodeEvalPayload). |
| `command.node_eval_flags` | `-e, --eval` |  |  | node options whose next word is inline code (command-guard.js isSafeNodeEval). |
| `command.node_fs_method_call` | `(?:\brequire\(\s*['"]fs['"]\s*\)\|\bfs)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(` |  |  | An fs API call in a `node -e` payload; group 1 is the method (command-guard.js NODE_FS_METHOD_CALL_RE). |
| `command.node_fs_read_allowlist` | `readFileSync, readdirSync, statSync, existsSync, lstatSync` |  |  | fs methods a safe `node -e` payload may call (command-guard.js NODE_FS_READ_ALLOWLIST). |
| `command.node_script_ext` | `(?i)\.(?:js\|mjs\|cjs)$` |  |  | Script file extensions of node for the flagged-interpreter test (command-guard.js isFlaggedInterpreterScript). |
| `command.pattern_first_verbs` | `grep, sed, awk` |  |  | Verbs whose first operand is a pattern, blanked before the heavy patterns run (command-guard.js PATTERN_FIRST_VERBS). |
| `command.pipeline_ends` | `end, ;, &&, \\|\\|, \n` |  |  | The delimiters that end a pipeline in the bounded verification scan (command-guard.js PIPELINE_ENDS). |
| `command.plain_read_git_segments` | `^git\s+log\s+--oneline(?:\s+-\d+)?\s*$, ^git\s+status(?:\s+(?:--short\\|-s))?\...` |  |  | Exact shapes of one plain read-only git segment inside a chain, after a trailing `2>&1` is stripped (command-guard.js PLAIN_LOG_SEGMENT_RE, PLAIN_STATUS_SEGMENT_RE, PLAIN_SHOW_SEGMENT_RE, PLAIN_REVPARSE_SEGMENT_RE; the JavaScript negative lookahead on the first character is the equivalent first-character class). |
| `command.plugin_manifest_rel` | `.claude-plugin/plugin.json` |  |  | The plugin manifest, relative to a plugin root. |
| `command.plugin_name` | `anti-hall` |  |  | The name anti-hall's manifest carries. |
| `command.port_digits_max` | `5` |  |  | Most digits a URL port may have. |
| `command.port_max` | `65535` |  |  | Largest TCP port a URL may carry. |
| `command.python_script_ext` | `(?i)\.py$` |  |  | Script file extension of the other interpreters for the flagged-interpreter test (command-guard.js isFlaggedInterpreterScript). |
| `command.scratch_leaf` | `scratchpad` |  |  | Name of the scratchpad directory of a session. |
| `command.scratch_uid_prefix` | `claude-` |  |  | Prefix of the per-user directory under a tmp root that holds session scratchpads. |
| `command.script_check_interpreter` | `^(?:python[0-9.]*\|node\|ruby\|perl\|php)$` |  |  | Interpreters whose flagged script runs are heavy (command-guard.js SCRIPT_CHECK_INTERPRETER_RE). |
| `command.setting_allow_bg_scratch` | `7 entries` |  |  | guards.allowBackgroundScratchScripts: the background scratch script allowance (default on). |
| `command.setting_allow_gcloud_reads` | `7 entries` |  |  | guards.allowGcloudReads: the narrow read-only Google Cloud access (default on). |
| `command.setting_allow_plain_push` | `7 entries` |  |  | guards.allowPlainPush: the plain git push chain allowance (default on). |
| `command.setting_allow_read_only_verify` | `7 entries` |  |  | guards.allowReadOnlyVerify: the bounded single-target verification allowance (default on). |
| `command.setting_allow_read_only_verify_scripts` | `7 entries` |  |  | guards.allowReadOnlyVerifyScripts: the script form of that allowance (default on). |
| `command.setting_bash_edit_parity` | `7 entries` |  |  | guards.bashEditParity: edit-guard's verdict applied to Bash writes (default on). |
| `command.setting_project_command_allow` | `7 entries` |  |  | guards.projectCommandAllow: the per-project command allowlist (default on). |
| `command.setting_project_edit_allow` | `7 entries` |  |  | guards.projectEditAllow: the per-project edit allowlist (default on). |
| `command.shell_verbs` | `bash, sh, zsh, dash, ksh, ash` |  |  | Shell programs whose `-c` argument or heredoc body is itself a script (lib/shell-scan.js SHELL_VERBS). |
| `command.sqlite_dangerous` | `(?i)(^\|[\s;])\.(shell\|system\|output\|once\|import\|save)\b\|\bATTACH\b` |  |  | sqlite3 dot-commands and SQL that write despite -readonly (command-guard.js SQLITE_DANGEROUS_RE). |
| `command.stash_global_value_opts` | `-C, -c, --git-dir, --work-tree, --namespace, --exec-path` |  |  | git global options that take a value, skipped to find the subcommand (git-stash guard). |
| `command.stash_guard` | `git-stash-guard` |  |  | The skip id and message id of the git stash guard. |
| `command.stash_guard_setting` | `7 entries` |  |  | guards.stashGuard: arms the git stash guard for every repository (default off). |
| `command.stash_marker_rel` | `.anti-hall/protected-stashes` |  |  | The per-repository file that arms the stash guard, relative to the toplevel. |
| `command.stash_mutating_subs` | `push, pop, drop, clear, apply, save` |  |  | git stash subcommands the guard blocks. |
| `command.stash_push_value_flags` | `-m, --message` |  |  | git stash push flags that take a value. |
| `command.stash_read_subs` | `list, show, branch` |  |  | git stash subcommands that never mutate. |
| `command.store_deny_patterns` | `9 items` |  |  | Paths under the store directory that are raw store files (lib/devswarm-inbox-paths.js isStoreDenyTarget). A raw store read depends on the store module being present, so the engine defers it. |
| `command.subagent_entrypoint` | `agent_tool` |  |  | The entry point value of a subagent process. |
| `command.sudo_value_flags` | `16 items` |  |  | sudo options that take a value (command-guard.js effectiveVerb SUDO_VAL). |
| `command.taskpolicy_value_flags` | `-c, -t, -p` |  |  | taskpolicy options that take a value (command-guard.js effectiveVerb). |
| `command.test_keywords` | `7 items` |  |  | Words after which a `[[` or `((` is at command position, so its `<`/`>` are comparisons, not redirects (command-guard.js TEST_KEYWORDS). |
| `command.tier_detect_setting` | `7 entries` |  |  | jev.dispatchTierDetectNoWorkspaces: also read CLAUDE.md and AGENTS.md for the no-workspaces rule (default on). |
| `command.tier_doc_files` | `CLAUDE.md, AGENTS.md` |  |  | The repository docs searched for the no-workspaces rule. |
| `command.tier_doc_levels` | `8` |  |  | How many directory levels the no-workspaces search climbs (dispatch-tier.js: 8). |
| `command.tier_repos_setting` | `6 entries` |  |  | jev.dispatchTierNoWorkspaceRepos: repositories where workspaces are off-limits (comma separated, empty by default). |
| `command.tier_text_setting` | `7 entries` |  |  | devswarm.dispatchTierText: the DevSwarm Primary dispatch-tier text (default on). |
| `command.timeout_prefix` | `^\s*timeout\s+(?:-[ks]\s+\S+\s+\|-\S+\s+)*\d+[smhd]?\s+` |  |  | A leading `timeout [opts] N` stripped for the light-exception test (command-guard.js TIMEOUT_PREFIX_RE). |
| `command.timeout_value_flags` | `-s, --signal, -k, --kill-after` |  |  | timeout options that take a value (command-guard.js effectiveVerb). |
| `command.tmp_default` | `/tmp` |  |  | os.tmpdir() when none is set. |
| `command.tmp_env_names` | `TMPDIR, TMP, TEMP` |  |  | The variables os.tmpdir() reads, in order. |
| `command.tmp_fixed_roots` | `/tmp, /private/tmp` |  |  | The tmp roots added after os.tmpdir() (scratchpad.js tmpRoots). |
| `command.trailing_stderr_merge` | `\s+2>&1\s*$` |  |  | A trailing `2>&1` stripped before a plain git chain segment is classified (command-guard.js TRAILING_STDERR_MERGE_RE). |
| `command.verify_syntax_only_compilers` | `c++, cc, gcc, clang, clang++, g++` |  |  | Compilers whose -fsyntax-only run is an inline check. |
| `command.verify_trivial_verbs` | `cd, pwd, true` |  |  | Verbs that are harmless in a verification chain. |
| `command.whole_command_clis` | `12 items` |  |  | CLIs whose whole-command read-only form (version query or gcloud read piped to a closed sink) is light (command-guard.js isWholeCommandReadOnlyForm and VERSION_CLI_RE). |
| `command.wrappers` | `18 items` |  |  | Words skipped when finding a segment's effective verb (command-guard.js WRAPPERS). |
| `command.write_target_unknowable` | `$`*?[]{}` |  |  | A write target containing one of these characters cannot be resolved and is skipped (command-guard.js resolveWriteTarget). |

### telemetry.toml / telemetry

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `telemetry.bytes_per_token` | `4` |  | bytes | Bytes of injected context counted as one token when `impact` estimates what injection costs. |
| `telemetry.cmd_record` | `mesh, migrate, jev-setup, doctor:--repair\\|--fix, config:heal` |  |  | The engine commands whose runs are recorded as `cmd` events (they write state). Each entry is a command word, or `command:arg\|arg` to record only runs that carry one of those arguments (`doctor:--repair\|--fix` records a repair, not a read-only check; `config:heal` records the heal, not the show). |
| `telemetry.daemon_event_label` | `snapshot` |  |  | The `e` label of the daemon health snapshot events. |
| `telemetry.daemon_label` | `daemon` |  |  | The `h` label of the daemon health snapshot events. |
| `telemetry.default_window_days` | `7` |  | days | Window the `telemetry` and `impact` reports cover unless --window is given. |
| `telemetry.enabled` | `true` |  |  | Record telemetry (D78). Local only: nothing is uploaded. Off stops recording; what was already stored stays. |
| `telemetry.fields` | `5 entries` |  |  | The extra fields of the event kinds whose schema is data. Each entry is `name:type`, with type `num` (a whole number) or `tok` (an identifier: letters, digits and `._:/[]@+-`, at most token_max_len bytes). A reader refuses any field a kind does not list, so prose cannot be stored. node: one Node hook the dispatcher ran (h = hook id, e = hook event, o = allow\|block\|advise\|error\|timeout, ms = wall time, ib = stdout bytes; exit = exit code when it exited, fate = ran\|timeout\|spawn\|died\|incomplete, err_bytes = stderr bytes). cmd: one run of a state-writing engine command (h = command, e = its first argument or `-`, o = allow\|error, ms = duration; items = what it changed, exit = exit code). daemon: a health snapshot (h and e are daemon_label and daemon_event_label, o = allow, or advise when degraded; fields are readings). model: one model call, recorded by `telemetry::emit::model(&ModelCall { backend, model, purpose, outcome, micros, tokens_in, tokens_out })` once per finished call, from any process (the daemon records at once; any other process appends to the telemetry inbox for the daemon to read); backend and model are identifiers (the model ALIAS, never a pinned version or prompt text), outcome is Allow, Error or Timeout, the token counts are None when the backend did not report them (h = backend, e = model alias, o = allow\|error\|timeout, ms = latency; tokens_in/tokens_out when known, purpose = what the call was for; counted by backend, alias and outcome with a latency histogram and shown in `telemetry summary` under detail.model). jev: the detail of a Jev call beside integration, mode, verdict and cost_uc (conf_pm = confidence in thousandths, backend = jev\|cache\|baseline-only, breaker = open\|closed, error = the failure reason, absent when there was none). |
| `telemetry.flush_ms` | `10000` | `AH_ENGINE_TELEMETRY_FLUSH_MS` | ms | How often the recorder's counters and events are stored in hot.db, and at shutdown. A kill -9 loses at most this much (the data recorded since the last flush). |
| `telemetry.health_snapshot_ms` | `60000` | `AH_ENGINE_HEALTH_SNAPSHOT_MS` | ms | How often the daemon records a `daemon` health snapshot event (resident set, its cap, restarts, degraded flag, queue and worker load, saturation). Events are kept for retention_days and capped by max_event_rows. |
| `telemetry.hook_label` | `hook` |  |  | The `h` label of the whole-hook telemetry row (one per hook request, whatever checks ran inside it). |
| `telemetry.impact_persisted_note` | `stored in hot.db: totals and events survive a restart` |  |  | Printed with impact output when the events are stored in hot.db. |
| `telemetry.inbox_max_bytes` | `4194304` |  | bytes | Largest the telemetry inbox may grow while no daemon reads it; events appended beyond that are not kept (the daemon empties the file on every flush). |
| `telemetry.inherit_prefix` | `inherit:` |  |  | Prefix used when a route event records an inherited model. The model-routing hook can use a parent_model field from the hook payload; otherwise it records inherit:unknown because no current settings source exposes the parent model. |
| `telemetry.latency_buckets_us` | `10 items` |  | us | Upper bounds of the latency histogram buckets; a quantile is reported as the upper bound of the bucket holding that rank, so it is an upper estimate. |
| `telemetry.link_window_s` | `7200` |  | s | How long before a spawn result a routing decision with the same spawn key still belongs to it (D77). |
| `telemetry.max_event_rows` | `200000` |  |  | Most events kept in hot.db; the oldest beyond this are removed when `telemetry rollup` runs. |
| `telemetry.max_events` | `5000` | `AH_ENGINE_MAX_EVENTS` |  | Most impact events kept in memory (oldest dropped first); counts per kind are kept exactly in separate counters. |
| `telemetry.max_series` | `128` |  |  | Most distinct label combinations kept per metric; further combinations are counted under one overflow series. |
| `telemetry.metrics_persisted_note` | `counters and histograms are snapshotted to hot.db every telemetry.snapshot_ms...` |  |  | Printed with metrics output when counters and histograms are snapshotted to hot.db. |
| `telemetry.net_method` | `estimate: routing saved minus routing spent up, minus the estimated cost of i...` |  |  | How the NET figure of `impact` is computed, shown next to it. |
| `telemetry.no_event_label` | `-` |  |  | The `e` label used when the hook event is unknown. |
| `telemetry.not_persisted_note` | `kept in memory by the running daemon and reset when it exits` |  |  | Printed with metrics, and with impact output when storage could not open, while they live in memory only. |
| `telemetry.overflow_label` | `other` |  |  | Label value used for series beyond max_series. |
| `telemetry.project_key_len` | `12` |  |  | Hex digits of the hashed project key shown in impact events (the project path itself is never stored). |
| `telemetry.recent_default` | `20` |  |  | How many of the most recent impact events `impact` shows unless asked for more. |
| `telemetry.retention_days` | `30` |  | days | How many days of per-day counter rows and events stay in hot.db; older ones are removed by `telemetry rollup` after they are archived in archive.db, where the daily rollups are kept. |
| `telemetry.ring_size` | `2048` |  |  | Rich events (routing decisions, spawn results, Jev calls, spills) held in memory between flushes; older ones are overwritten and counted as dropped. |
| `telemetry.rollups` | `3 entries, 3 entries` |  |  | Metric rollup resolutions in archive.db: each bucket keeps the last snapshot taken in it, and buckets older than keep_s are pruned by `ah-engine maintain` (derived data, D59). |
| `telemetry.rule_label` | `rule` |  |  | The `h` label of the telemetry row counting regex rule matches. |
| `telemetry.shards` | `4` |  |  | Counter tables the hot path spreads threads over, so threads rarely share a cache line. |
| `telemetry.slots` | `256` |  |  | Label combinations (kind, hook or check, event, outcome) one shard holds; rounded up to a power of two. A full table counts the sample as dropped instead of waiting. |
| `telemetry.snapshot_ms` | `60000` | `AH_ENGINE_SNAPSHOT_MS` | ms | Interval of the scheduled metrics snapshot job, which keeps the counters in hot.db and their rollups in archive.db (D51); the daemon also keeps one when it exits. |
| `telemetry.summary_event_limit` | `5000` |  |  | Most events of one kind `telemetry summary` reads to build its jev, cmd, model and daemon sections. |
| `telemetry.token_max_len` | `64` |  | bytes | Longest identifier a telemetry event may hold in any text field (hook, event, model, task class, spawn key); longer ones are cut. Event text fields hold identifiers only, never prose. |

### storage.toml / backup

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `backup.journal_mode` | `DELETE` |  |  | Journal mode a snapshot file is left in: DELETE makes it one self-contained file with no WAL beside it. |
| `backup.manifest_file` | `manifest.json` |  |  | File in each snapshot directory that lists its databases, their sizes, schema versions and integrity checks. |
| `backup.pages_per_step` | `256` |  |  | Pages the online backup copies per step; between steps the daemon's writer can commit. |
| `backup.pause_ms` | `0` |  | ms | Pause between backup steps (and after a step finds the source busy). |
| `backup.pre_restore_prefix` | `pre-restore-` |  |  | Name prefix of the snapshot a restore takes of the current state before it swaps (the time in ms follows). |
| `backup.scrub_columns` | `mailbox.body, kv.value, applied.result` |  |  | Text columns (`table.column`) a backup scrubs of secrets and the home path, in both databases where the table exists; project keys are kept so a restore can find each project's data. |
| `backup.stop_wait_ms` | `5000` |  | ms | How long a restore waits for the daemon to stop and release its lock before it gives up without changing anything. |

### storage.toml / retention

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `retention.applied_s` | `2592000` |  | s | Applied write ids older than this are forgotten (derived bookkeeping, D59); a spooled write older than this would be applied again, so it is far longer than any spool wait. |
| `retention.archive_delete_after_s` | `0` |  | s | Archived user data (messages, key values, impact events) older than this is deleted; 0 means never, the default (D26: hard delete only with an explicit value). |
| `retention.batch_rows` | `1000` |  |  | Rows moved per archive transaction (archive.db commits in batches). |
| `retention.impact_hot_rows` | `100000` |  | rows | Most impact events kept in hot.db; the oldest beyond this move to archive.db. |
| `retention.impact_hot_s` | `2592000` |  | s | An impact event moves from hot.db to archive.db once it is this old (its totals stay in hot.db). |
| `retention.kv_expired_s` | `86400` |  | s | A key value moves from hot.db to archive.db this long after its TTL ended. |
| `retention.mailbox_consumed_s` | `604800` |  | s | A consumed mailbox message moves from hot.db to archive.db this long after it was consumed. |
| `retention.max_batches` | `10000` |  |  | Most batches one maintenance run moves per table, so a run stays bounded. |
| `retention.schedule_runs_s` | `2592000` |  | s | Scheduler run history older than this is forgotten by `maintain` (a derived log, D59). |

### storage.toml / spool

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `spool.backoff_max_ms` | `400` |  | ms | Longest retry delay. |
| `spool.backoff_ms` | `20` | `AH_ENGINE_SPOOL_BACKOFF_MS` | ms | First retry delay; each retry doubles it, up to backoff_max_ms, with random jitter of up to half the delay. |
| `spool.backoff_shift_max` | `16` |  |  | The largest doubling exponent of a spool retry delay (backoff_ms times 2^n, at most this power), before backoff_max_ms; it keeps the shift from overflowing. |
| `spool.drain_ms` | `1000` | `AH_ENGINE_SPOOL_DRAIN_MS` | ms | Interval of the scheduled spool drain job (it also drains on start and before each project write). |
| `spool.lock_poll_ms` | `5` |  | ms | How often a waiter retries the spool's lock. |
| `spool.lock_wait_ms` | `500` |  | ms | Longest a client append or a daemon drain waits for the spool's lock file (<spool>.lock); past it the caller gives up and says why instead of hanging behind a stuck holder. |
| `spool.max_bytes` | `16777216` | `AH_ENGINE_SPOOL_MAX_BYTES` | bytes | Largest spool; a write that would grow it past this is refused instead of spooled, so the client learns it was not kept. |
| `spool.retries` | `4` | `AH_ENGINE_SPOOL_RETRIES` |  | Retries of a project write before it is spooled (the first attempt is not counted). |
| `spool.verbs` | `put, set, setex` |  |  | Project verbs a client may spool when the engine is down or busy: writes whose answer it does not need. |

### storage.toml / storage

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `storage.ack_timeout_ms` | `1000` | `AH_ENGINE_ACK_TIMEOUT_MS` | ms | How long a request waits for its write to commit before it is answered with an error (the client then retries or spools; the write id makes a late commit harmless); kept below client.ctl_timeout_ms so the client hears the error. |
| `storage.archive_file` | `archive.db` |  |  | The database for append-mostly history, inside the state directory; opened on first use (D21). |
| `storage.archive_synchronous` | `NORMAL` |  |  | SQLite synchronous level for archive.db, which takes batched, re-runnable moves and rollups. |
| `storage.batch_max` | `256` |  |  | Most writes committed in one transaction. |
| `storage.busy_timeout_ms` | `1000` |  | ms | How long a connection waits for another connection's lock before the statement fails. |
| `storage.cache_kb` | `512` |  | KB | SQLite page cache per connection; capped so the daemon's memory stays flat (D25). |
| `storage.fullfsync` | `0` | `AH_ENGINE_FULLFSYNC` |  | 1 makes SQLite use F_FULLFSYNC on macOS, which also survives power loss at a large cost in commit rate (D73: 479 against 43k commits per second measured); 0 keeps the plain fsync. Off until metrics decide. |
| `storage.group_commit_ms` | `0` | `AH_ENGINE_GROUP_COMMIT_MS` | ms | Group-commit window: after taking a write, the writer waits up to this long for more before committing them together (D23); 0 commits at once with whatever is already queued, which still groups writes that arrive during a commit. |
| `storage.hot_file` | `hot.db` |  |  | The database for frequent small writes (impact events, project state, metric snapshots), inside the state directory (D21). |
| `storage.hot_synchronous` | `FULL` |  |  | SQLite synchronous level for hot.db; FULL syncs every commit, so an acknowledged write survives a process crash (D23, D73). |
| `storage.journal_mode` | `WAL` |  |  | SQLite journal mode for both databases; WAL lets readers run while the writer commits (D73). |
| `storage.mmap_kb` | `0` |  | KB | SQLite memory-mapped I/O per connection; 0 turns it off so file pages are not counted in the daemon's resident set (D25). |
| `storage.wal_autocheckpoint` | `1000` |  | pages | WAL pages after which SQLite checkpoints on its own (between explicit checkpoints by `ah-engine maintain`). |
| `storage.wal_suffix` | `-wal` |  |  | Suffix SQLite gives a database's write-ahead log file; used to report WAL sizes. |
| `storage.write_queue` | `1024` | `AH_ENGINE_WRITE_QUEUE` |  | Writes that may wait for the writer thread; beyond this a write is refused as busy (the client retries, then spools). |

### storage.toml / tier

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `tier.budget_kb` | `2048` | `AH_ENGINE_TIER_BUDGET_KB` | KB | Memory budget of the active key-value items; past it the least recently used item is dropped from memory (SQLite keeps it). |
| `tier.bus_channels` | `1024` |  |  | Most pub/sub channels with subscribers at once. |
| `tier.bus_queue` | `256` |  |  | Notifications each pub/sub subscriber can hold; a full queue loses notifications (counted), never data. |
| `tier.item_overhead` | `96` |  | bytes | Bytes charged per item on top of its text, for the map and ordering entries that hold it. |
| `tier.project_channel_prefix` | `project:` |  |  | Channel name prefix for a project's notifications; the hashed project key follows it. |

### config.toml / config

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `config.debounce_ms` | `300` | `AH_ENGINE_CONFIG_DEBOUNCE_MS` | ms | A change must stay unchanged this long before it is loaded, so a half-written or rapidly edited file is read once. |
| `config.false_tokens` | `0, off, false, no` |  |  | Words a settings.json boolean may be written as to mean false (matches FALSE_TOKENS in hooks/lib/settings-schema.js). |
| `config.restart_only` | `7 items` |  |  | Settings (or key prefixes ending in a dot) that only take effect when the daemon starts; an edit is held as pending until then. |
| `config.settings_file` | `settings.json` |  |  | Name of anti-hall's settings file inside the base directory (the file hooks/lib/settings.js reads). |
| `config.true_tokens` | `1, on, true, yes` |  |  | Words a settings.json boolean may be written as to mean true (matches TRUE_TOKENS in hooks/lib/settings-schema.js). |
| `config.user_file` | `config.toml` |  |  | Name of the engine's own user config (TOML) inside the state directory. |
| `config.watch_ms` | `500` | `AH_ENGINE_CONFIG_WATCH_MS` | ms | How often the daemon checks the config files for a change. |

### config.toml / env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `env.config` | `AH_ENGINE_CONFIG` |  |  | Overrides the path of the engine's own user config file (default: config.toml in the state directory). |
| `env.settings` | `AH_ENGINE_SETTINGS` |  |  | Overrides the path of anti-hall's settings.json (default: settings.json in the base directory under the home directory). |

### transcript.toml / transcript

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `transcript.assistant_text_max_bytes` | `1048576` |  | bytes | Longest last-assistant text kept; the rest is cut at a character boundary and flagged. |
| `transcript.final_statuses` | `completed failed stopped` |  |  | Task-notification statuses the DevSwarm idle gate treats as final (companion/lib/devswarm-idle.js FINAL_STATUS), case-insensitive. |
| `transcript.fingerprint_bytes` | `256` |  | bytes | Leading bytes of the file hashed to notice a rewritten or rotated transcript. |
| `transcript.idle_ttl_ms` | `21600000` |  | ms | How long the registry keeps an index nobody asked for; a dropped index is rebuilt from the file on the next request. |
| `transcript.initial_window_bytes` | `1572864` |  | bytes | Bytes read from the end of a transcript the first time it is indexed (a long transcript is never read from the start); mirrors MAX_TAIL_BYTES of hooks/lib/transcript-tail.js. |
| `transcript.malformed_kind` | `malformed` |  |  | Kind name that counts non-empty lines that are not a JSON object. |
| `transcript.max_indexes` | `32` |  |  | Most transcripts the registry indexes at once; the least recently used one is dropped beyond this. |
| `transcript.max_kinds` | `64` |  |  | Most distinct record kinds counted separately; further kinds are counted under the overflow kind. |
| `transcript.max_update_bytes` | `8388608` |  | bytes | Most appended bytes one refresh reads; when more than this was appended since the last refresh the index skips ahead to the newest bytes and counts a gap instead of stalling the hook. |
| `transcript.msg_io` | `Cannot read the transcript {path}: {err}.` |  |  | Printed when a transcript cannot be read; {path} and {err} are filled in. |
| `transcript.non_prompt_prefixes` | `<task-notification, <command-, <local-command, <system-reminder` |  |  | Text starts that mark a user entry as injected, not typed (hooks/lib/inference-check.js lastUserPrompt). |
| `transcript.notifications_kept` | `2048` |  |  | How many of the newest task-notification blocks the index keeps. |
| `transcript.overflow_kind` | `other` |  |  | Kind name that collects records whose type is missing or not a string, and kinds beyond the limit. |
| `transcript.prompt_max_bytes` | `65536` |  | bytes | Longest last typed prompt kept; the rest is cut at a character boundary and flagged. |
| `transcript.recent_tool_uses` | `64` |  |  | How many of the newest tool uses of any tool the index keeps. |
| `transcript.task_events` | `4096` |  |  | How many of the newest task-tool uses and results the index keeps. |
| `transcript.task_input_max_bytes` | `65536` |  | bytes | Largest serialized task-tool input kept as is; a larger input is replaced by null and flagged. |
| `transcript.task_result_max_bytes` | `1024` |  | bytes | Longest task-tool result text kept; the rest is cut at a character boundary and flagged. |
| `transcript.task_statuses_kept` | `256` |  |  | How many of the newest task_status attachments (agents re-injected by a compaction) the index keeps. |
| `transcript.task_tools` | `TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet` |  |  | Names of the task tools whose uses and string results are kept in order, so a task list can be rebuilt from the index (mirrors hooks/lib/task-state.js). |
| `transcript.terminal_statuses` | `completed failed stopped killed cancelled canceled` |  |  | Task-notification statuses that mean an agent has ended (hooks/lib/agent-scan.js TERMINAL_NOTIFICATION_STATUS), case-insensitive. |
| `transcript.tool_input_max_bytes` | `4096` |  | bytes | Largest serialized tool input kept as is for a recent tool use; a larger input is replaced by null and flagged. |

### gitcache.toml / gitcache

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `gitcache.alias_prefix` | `alias.` |  |  | Prefix of the config names that `argv_aliases` prints, removed from each alias name. |
| `gitcache.argv_aliases` | `config, -z, --get-regexp, ^alias\.` |  |  | git arguments that list configured aliases, NUL separated. |
| `gitcache.argv_branch` | `symbolic-ref --short HEAD` |  |  | git arguments that print the current branch name (fails on a detached HEAD). |
| `gitcache.argv_config_get` | `config --get` |  |  | git arguments that read one config value; the key is appended. |
| `gitcache.argv_config_path` | `config --path --get` |  |  | git arguments that read one path-valued config value with `~` expanded; the key is appended. |
| `gitcache.argv_git_dir` | `rev-parse --absolute-git-dir` |  |  | git arguments that print the absolute git directory. |
| `gitcache.argv_head` | `rev-parse HEAD` |  |  | git arguments that print the commit HEAD points to. |
| `gitcache.argv_remotes` | `remote` |  |  | git arguments that list the configured remotes. |
| `gitcache.argv_status` | `status --porcelain=v1` |  |  | git arguments that print the working tree state in the stable porcelain format. |
| `gitcache.argv_toplevel` | `rev-parse --show-toplevel` |  |  | git arguments that print the work tree root. |
| `gitcache.argv_upstream` | `rev-parse --abbrev-ref --symbolic-full-name @{upstream}` |  |  | git arguments that print the upstream of the current branch (fails when none is set). |
| `gitcache.bypass_env` | `11 items` |  |  | Environment variables that change how git finds or reads a repository; with any of them set the cache refuses, and the caller runs git itself. |
| `gitcache.dir_remote_refs` | `refs/remotes` |  |  | Directory of remote-tracking refs, relative to the common directory. |
| `gitcache.dirty_ttl_ms` | `1000` |  | ms | Lifetime of the cached dirty bit. A working-tree edit changes none of the signed files, so the dirty bit is bounded by time; a destructive decision must use the exact read instead. |
| `gitcache.dot_git` | `.git` |  |  | Name of the entry that marks a work tree (a directory, or a file for a submodule or linked worktree). |
| `gitcache.env_home` | `HOME` |  |  | Environment variable that holds the home directory. |
| `gitcache.env_xdg_config` | `XDG_CONFIG_HOME` |  |  | Environment variable that holds the XDG config directory. |
| `gitcache.file_commondir` | `commondir` |  |  | Name of the file inside a linked worktree's git directory that points to the common directory. |
| `gitcache.file_config` | `config` |  |  | Name of the repository config file inside the common directory; its stat is part of the signature. |
| `gitcache.file_config_worktree` | `config.worktree` |  |  | Name of the per-worktree config file inside the git directory; its stat is part of the signature. |
| `gitcache.file_head` | `HEAD` |  |  | Name of the HEAD file inside the git directory; its content is part of the signature. |
| `gitcache.file_index` | `index` |  |  | Name of the index file inside the git directory; its stat is part of the signature. |
| `gitcache.file_packed_refs` | `packed-refs` |  |  | Name of the packed refs file inside the common directory; its stat is part of the signature. |
| `gitcache.git_binary` | `git` |  |  | The git program the cache runs on a miss. |
| `gitcache.gitdir_prefix` | `gitdir:` |  |  | Start of the line in a `.git` file that names the git directory. |
| `gitcache.global_configs` | `.gitconfig, .config/git/config, /etc/gitconfig` |  |  | Global and system config files whose stat is part of every signature, relative to the home directory when not absolute (an alias or setting can live in any of them). |
| `gitcache.head_ref_prefix` | `ref:` |  |  | Start of a HEAD file's content when HEAD names a branch ref. |
| `gitcache.idle_ttl_ms` | `3600000` |  | ms | How long the cache keeps a repository nobody asked about. |
| `gitcache.max_config_keys` | `64` |  |  | Most distinct config keys memoized per repository; the memos of a repository are dropped when a further key would exceed this. |
| `gitcache.max_ref_dirs` | `32` |  |  | Most remote-tracking directories whose mtime is signed for the upstream fact. |
| `gitcache.max_repos` | `64` |  |  | Most repositories cached at once; the least recently used one is dropped beyond this. |
| `gitcache.msg_bypassed` | `The cache is bypassed because {name} is set.` |  |  | Printed when the environment changes how git finds the repository, so the cache refuses; {name} is filled in. |
| `gitcache.msg_gitfile` | `{path} is not a valid gitdir file.` |  |  | Printed when a `.git` file does not name a git directory; {path} is filled in. |
| `gitcache.msg_not_resolved` | `No git work tree found at or above {dir}.` |  |  | Printed when no repository can be found for a directory; {dir} is filled in. |
| `gitcache.msg_run` | `Could not run git {args}: {err}.` |  |  | Printed when git could not be run or timed out; {args} and {err} are filled in. |
| `gitcache.poll_ms` | `2` |  | ms | How often the cache checks whether a running git child has exited. |
| `gitcache.run_env` | `GIT_OPTIONAL_LOCKS=0, GIT_TERMINAL_PROMPT=0` |  |  | Environment assignments (NAME=value) added to every git invocation; GIT_OPTIONAL_LOCKS=0 keeps `status` from rewriting the index and so invalidating the cache. |
| `gitcache.timeout_ms` | `3000` |  | ms | Wall-clock limit of one git invocation; the child is killed as a process group when it passes. |
| `gitcache.ttl_ms` | `60000` |  | ms | Hard lifetime of a cached fact even when its signature has not changed (D61); the signature, not this, is what makes a fact fresh. |
| `gitcache.xdg_git_config` | `git/config` |  |  | Path of git's config below the XDG config directory. |

### schedules.toml / job

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `job.backup` | `11 entries` |  |  | A scrubbed backup of both databases (D27); off until schedule.backup_ms is set. Runs as a subprocess. |
| `job.handovers` | `11 entries` |  |  | Keep the handover brief trees (BRIEF.md and BRIEF.json per day, plus the root brief) of every registered project current: rebuilds only the days whose handover files changed, writes only files whose bytes change, never edits a handover and never deletes. Runs `ah-engine handovers index --registered` as a subprocess; off when schedule.handovers_ms is 0. |
| `job.maintain` | `11 entries` |  |  | Size control (D26): move inactive rows to archive.db, prune derived data, checkpoint and VACUUM; runs as a subprocess so a timeout can kill it. |
| `job.metrics_snapshot` | `11 entries` |  |  | Keep a snapshot of the metrics counters and histograms in hot.db and its rollups in archive.db (D51). |
| `job.spool_drain` | `11 entries` |  |  | Apply writes clients spooled while the engine was down or busy (D24); the daemon also drains on start and before each project write. |
| `job.telemetry_rollup` | `11 entries` |  |  | Roll complete days of telemetry counters up into archive.db and apply the telemetry retention (D78); idempotent, so a repeat or a catch-up changes nothing. |

### schedules.toml / schedule

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `schedule.action_args` | `1 entries` |  |  | The command line (after the program name, before --json) of a subprocess action whose command is not just its name. |
| `schedule.actions` | `8 items` |  |  | Actions a job may name; anything else in a user override is refused and logged. |
| `schedule.backoff_shift_max` | `30` |  |  | The largest doubling exponent of a failed job's retry delay (backoff_ms times 2^(failures-1), at most this power), before the job's backoff_max_ms cap; it keeps the shift from overflowing. |
| `schedule.backup_ms` | `0` | `AH_ENGINE_BACKUP_MS` | ms | Interval of the backup job (D27); 0 (the default) turns it off. |
| `schedule.detail_max` | `2000` |  | chars | Longest result detail kept with a run in the history (longer text is cut). |
| `schedule.handovers_ms` | `600000` | `AH_ENGINE_HANDOVERS_MS` | ms | Interval of the handovers job; 0 turns it off. |
| `schedule.history_default` | `50` |  |  | Runs `schedule history` lists unless asked for more. |
| `schedule.maintain_ms` | `86400000` | `AH_ENGINE_MAINTAIN_MS` | ms | Interval of the maintain job (D26); 0 turns it off. |
| `schedule.run_wait_ms` | `5000` |  | ms | How long `schedule run <job>` waits for the run it asked for before answering that it is still running; below daemon.stuck_ms. |
| `schedule.subprocess_actions` | `maintain, backup, jev_sweep, handovers` |  |  | Actions that run as an `ah-engine <action> --json` subprocess in its own process group, so a timeout kills it and everything it started. |
| `schedule.telemetry_rollup_ms` | `86400000` | `AH_ENGINE_TELEMETRY_ROLLUP_MS` | ms | Interval of the telemetry rollup job (D78); 0 turns it off. |
| `schedule.test_sleep_argv` | `sleep, 3600` |  |  | Command the test-only `test_sleep` action runs (accepted only when the test-hooks variable is set), to exercise timeouts. |
| `schedule.tick_ms` | `1000` | `AH_ENGINE_TICK_MS` | ms | Longest the ticker sleeps between checks; it wakes earlier when a job is due sooner or `schedule run` asks. |

### small_guards.toml / api_guard

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `api_guard.code_name_pattern` | `\.(?:py\|pyi\|js\|mjs\|cjs\|ts\|tsx\|jsx)` |  |  | Regex source (case-insensitive) that finds a code file name inside a Bash command or an apply_patch text. Written without a word boundary, so it finds every spelling the Node guard's own pattern finds, and more. |
| `api_guard.extension_pattern` | `\.([a-z]+)$` |  |  | Regex source (case-insensitive) of a file name's extension, group 1. |
| `api_guard.guard_name` | `api-guard` |  |  | The guard id this check answers to in skip.json. |
| `api_guard.js_extensions` | `js, mjs, cjs, ts, tsx, jsx` |  |  | File extensions (lower-case) the guard checks as JavaScript or TypeScript. |
| `api_guard.js_globals` | `17 items` |  |  | JavaScript global builtins whose members the Node guard verifies by default. |
| `api_guard.js_require_word` | `require` |  |  | The text a JavaScript module reference needs before the guard can resolve an attribute against it. |
| `api_guard.node_builtins` | `23 items` |  |  | Node built-in modules whose attributes the Node guard verifies by default. |
| `api_guard.noise_pattern` | `[^A-Za-z0-9_.]` |  |  | Regex source (global) of the characters dropped from a Bash command before the verifiable-reference test: every character that is not an ASCII letter, digit, underscore or dot. The code a shell write puts in a file is built from the command text by quote removal and escape decoding, so its words are contiguous runs of what remains. |
| `api_guard.python_extensions` | `py, pyi` |  |  | File extensions (lower-case) the guard checks as Python. |
| `api_guard.python_import_word` | `import` |  |  | The word a Python module reference needs before the guard can resolve an attribute against it. |
| `api_guard.python_stdlib` | `46 items` |  |  | Python standard-library modules whose attributes the Node guard verifies by default. |
| `api_guard.setting` | `6 entries` |  |  | Where the guard's own on/off switch is read from (guards.apiGuard, default on). |
| `api_guard.shell_setting` | `6 entries` |  |  | Where the switch for checking the code a shell write puts in a file is read from (guards.shellWriteChecks, default on). |
| `api_guard.shell_write_pattern` | `[>]\|\btee\b\|\bsed\b\|\bperl\b\|\bcp\b\|\bmv\b\|\bopen\b\|createWriteStream\|File(?:...` |  |  | Regex source (case-sensitive) of the Node pre-filter that says a Bash command could write a file (a redirect, tee, an in-place editor, cp or mv, an inline-code write); a command it does not match yields no code chunk, so the guard allows it. |
| `api_guard.summary` | `Fabricated-API guard: answers every call the Node api-guard would allow witho...` |  |  | One-line description of the api-guard check in the generated reference. |
| `api_guard.thirdparty_setting` | `6 entries` |  |  | Where the switch for also verifying installed third-party packages is read from (guards.apiGuardThirdparty, default off). |
| `api_guard.tool_edit` | `Edit` |  |  | Tool whose code is `tool_input.new_string`. |
| `api_guard.tool_multi` | `MultiEdit` |  |  | Tool whose code is the `new_string` of each entry of `tool_input.edits`. |
| `api_guard.tool_patch` | `apply_patch` |  |  | Codex tool whose patch text carries the code. |
| `api_guard.tool_shell` | `Bash` |  |  | Tool whose command can write a code file. |
| `api_guard.tool_write` | `Write` |  |  | Tool whose code is `tool_input.content`. |

### small_guards.toml / compact_decl

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `compact_decl.agent_markers` | `agent_id, agent_type` |  |  | Payload fields that, present and non-null, prove the call comes from a subagent. |
| `compact_decl.bash_work_always` | `7 items` |  |  | Regex sources (case-insensitive) of shell commands that change state wherever they appear in a command with quoted text blanked. |
| `compact_decl.bash_work_command_position` | `(?:\A\|[\n\r  ;&\|`(]\|\$\()\s*(?:rm\|cp\|mv\|tee\|mkdir\|touch\|make\|chmod)\b` |  |  | Regex source (case-insensitive) of the bare state-changing verbs, which count only at command position (line start, or after a separator, parenthesis, backtick or substitution). |
| `compact_decl.bash_work_extra` | `\bgit\s+(?:push\|tag)\b\|\bgh\s+pr\s+(?:merge\|create)\b` |  |  | Regex source (case-insensitive) of the pushes, tags and pull-request writes this guard counts as work on top of the shared list. |
| `compact_decl.codex_text_types` | `output_text, text` |  |  | Content block types that carry assistant text in a Codex rollout entry. |
| `compact_decl.compact_command` | `^\s*<command-name>\s*/compact\s*</command-name>` |  |  | Regex source for the compact command line the host writes as a user entry. |
| `compact_decl.deep_json_depth` | `100` |  |  | Nesting depth beyond which a transcript line the engine cannot parse is deferred to Node (the Node parser has no such limit). |
| `compact_decl.guard_name` | `compact-declaration-guard` |  |  | The guard id this check answers to in skip.json. |
| `compact_decl.handover_file` | `(?s)(?:^\|/)\.anti-hall/handovers/[^/]` |  |  | Rust regex source, tested on a resolved path, for a file inside the handovers directory: writing it is the very thing a block tells the agent to do, so it is never new work. |
| `compact_decl.not_typed` | `^\s*<(task-notification\|local-command-\|system-reminder\|bash-std(out\|err))` |  |  | Regex source for injected user content that never starts a turn (task notification, local command output, system reminder, shell output). |
| `compact_decl.notify` | `^\s*<task-notification>` |  |  | Regex source for a background task notification. |
| `compact_decl.reminder_tags` | `2 entries` |  |  | Opening and closing tag of an injected system reminder, which may precede the real prompt. |
| `compact_decl.safe_word` | `safe` |  |  | Word a declaration must contain (compared without regard to ASCII case); a turn without it cannot hold one. |
| `compact_decl.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.compactDeclarationGuard, default on; it has no environment variable). |
| `compact_decl.summary` | `Allows new work unless the current turn may hold a SAFE TO COMPACT declaratio...` |  |  | One-line description of the compact-declaration-guard check in the generated reference. |
| `compact_decl.tail_bytes` | `1572864` |  |  | How many bytes from the end of the transcript are read (the Node guard reads the same). |
| `compact_decl.work_tools` | `Agent, Task, Write, Edit, MultiEdit, NotebookEdit` |  |  | Tools that always start new work (spawns and file edits). |

### small_guards.toml / coordinator_work

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `coordinator_work.agent_markers` | `agent_id, agent_type` |  |  | Payload fields the host puts on a subagent's hook payload and never on the main thread's. |
| `coordinator_work.block_setting` | `5 entries` |  |  | The Nth work call in the window is blocked (guards.coordinatorWorkBlockAt); 0 means never. |
| `coordinator_work.cap_setting` | `5 entries` |  |  | Safety cap on the stored window timestamps per session (guards.coordinatorWorkMaxEntries). |
| `coordinator_work.codex_markers` | `turn_id, model` |  |  | Payload fields that, both non-empty strings, identify a Codex payload. |
| `coordinator_work.codex_tool` | `apply_patch` |  |  | The tool name only Codex sends; a payload naming it is a Codex payload. |
| `coordinator_work.command_guard_name` | `command-guard` |  |  | The skip.json key of command-guard, which also silences the work window. |
| `coordinator_work.command_guard_setting` | `6 entries` |  |  | Where command-guard's on/off switch is read from (safety.commandGuard, default on); the work window is off with it. |
| `coordinator_work.coordinator_entrypoint_prefix` | `terminal_ide_` |  |  | Prefix of the CLAUDE_CODE_ENTRYPOINT values (IDE terminals) that also mean the main thread. |
| `coordinator_work.coordinator_entrypoints` | `cli, vscode, jetbrains, vim, emacs` |  |  | CLAUDE_CODE_ENTRYPOINT values that mean the interactive main thread. |
| `coordinator_work.counters` | `calls, work, blocks, skippedWouldBlock` |  |  | The counters a window file keeps and the metrics fold, by their key in the files. |
| `coordinator_work.entrypoint_env` | `CLAUDE_CODE_ENTRYPOINT` |  |  | The environment variable that names the host entry point. |
| `coordinator_work.fold_stamp_file` | `.coordinator-work-fold-stamp.json` |  |  | Name of the stamp file that throttles folding stale window files into the metrics. |
| `coordinator_work.fold_throttle_ms` | `21600000` |  |  | Minimum time between two folds of stale window files into the metrics (6 hours). |
| `coordinator_work.git_output_flag` | `output\|^-o` |  |  | Regex source of a git argument that writes output to a file (so the command is not read-only). |
| `coordinator_work.git_verb` | `git` |  |  | The verb of a git command. |
| `coordinator_work.guard_name` | `coordinator-work-guard` |  |  | The guard id this check answers to in skip.json and in messages. |
| `coordinator_work.lock_isolation_env` | `ANTIHALL_TEST_HOME_ISOLATED` |  |  | The variable that marks an isolated test home (enables the lock wait override). |
| `coordinator_work.lock_suffix` | `.lock` |  |  | Suffix of a lock file next to the file it guards. |
| `coordinator_work.lock_wait_env` | `ANTIHALL_COORDINATOR_WORK_LOCK_WAIT_MS` |  |  | Test-only variable that overrides the lock wait (honoured only with the isolation flag set). |
| `coordinator_work.lock_wait_ms` | `250` |  |  | How long a lock held by another process is waited for before the call is handed to the Node hook. |
| `coordinator_work.main_entrypoint_prefix` | `terminal_ide_` |  |  | Entry point prefix of a main-thread session started from a terminal inside an IDE. |
| `coordinator_work.main_entrypoints` | `cli, vscode, jetbrains, vim, emacs` |  |  | Entry point values (exact) of a main-thread session. |
| `coordinator_work.metrics_file` | `coordinator-work-metrics.json` |  |  | Name of the metrics file under the state directory. |
| `coordinator_work.nudge_instead` | `delegate the rest to a subagent now.` |  |  | Advisory advice without a block threshold. |
| `coordinator_work.nudge_instead_block` | `delegate the rest to a subagent now; call {block_at} in the window is blocked.` |  |  | Advisory advice with a block threshold; {block_at} is the call that is blocked. |
| `coordinator_work.nudge_setting` | `5 entries` |  |  | Work calls in the window at which one advisory is shown (guards.coordinatorWorkNudgeAt); 0 means no advisory. |
| `coordinator_work.nudge_what` | `{count} state-changing calls in the main thread within {minutes} min.` |  |  | Advisory headline; {count} is the number of work calls in the window and {minutes} the window length. |
| `coordinator_work.plugin_json` | `.claude-plugin/plugin.json` |  |  | Path of the plugin manifest, relative to the plugin root; its version stamps new window files. |
| `coordinator_work.post_event` | `PostToolUse` |  |  | The event name of the pass that records calls into the window. |
| `coordinator_work.pre_cap` | `20` |  |  | How many pre-call verdicts (kept until the matching post-call) a window file holds. |
| `coordinator_work.readonly_git_subs` | `8 items` |  |  | git subcommands that only read. |
| `coordinator_work.readonly_verbs` | `22 items` |  |  | Verbs that only read; a command built from these is not work. |
| `coordinator_work.safe_arg` | `^[A-Za-z0-9_.\/:=@%+,-]+$` |  |  | Regex source of an argument word of a command that is provably not work. |
| `coordinator_work.safe_command` | `^[A-Za-z0-9 \t\n_.\/:=@%+,&\|;-]*$` |  |  | Regex source (JavaScript syntax) of the only characters a command may hold to be provably not work. |
| `coordinator_work.safe_max_len` | `4096` |  |  | Longest command, in UTF-16 units, that is tested for being provably not work. |
| `coordinator_work.safe_verb` | `^[a-z-]+$` |  |  | Regex source of the verb word of a command that is provably not work. |
| `coordinator_work.segment_split` | `&&\|\\|\\|\|;\|\\|\|\n` |  |  | Regex source that splits a provably-not-work candidate into segments (&&, \|\|, ;, \|, newline). |
| `coordinator_work.session_file_prefix` | `coordinator-work-session-` |  |  | Prefix of a per-session window file under the state directory. |
| `coordinator_work.session_id_max` | `80` |  |  | Longest session id part, in UTF-16 units, of a window file name. |
| `coordinator_work.subagent_entrypoint` | `agent_tool` |  |  | CLAUDE_CODE_ENTRYPOINT value of a subagent process. |
| `coordinator_work.summary` | `Main-thread work window. PreToolUse: allows subagent Bash calls in the engine...` |  |  | One-line description of the coordinator-work-guard check in the generated reference. |
| `coordinator_work.trip_nudge` | `nudge` |  |  | The event name a nudge is logged under in the trips log. |
| `coordinator_work.trips_file` | `coordinator-work-trips.log` |  |  | Name of the JSONL log of nudges and blocks. |
| `coordinator_work.trips_max_bytes` | `1048576` |  |  | Size at which the trips log is rotated to its .1 file. |
| `coordinator_work.unknown_version` | `unknown` |  |  | The version text used when the manifest cannot be read. |
| `coordinator_work.version_keys` | `sessions, calls, work, blocks, skippedWouldBlock` |  |  | The keys of one version's entry in the metrics file, in file order: the number of folded sessions, then the counters. |
| `coordinator_work.window_setting` | `5 entries` |  |  | Minutes of the work window (guards.coordinatorWorkWindowMinutes); 0 turns the window off. |

### small_guards.toml / devswarm_prompt

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `devswarm_prompt.branch_env` | `DEVSWARM_SOURCE_BRANCH` |  |  | Environment variable whose non-blank value marks a child workspace (hooks/lib/devswarm-role.js). |
| `devswarm_prompt.child_setting` | `6 entries` |  |  | Where the devswarm.childTurn switch (default on) is read from: no environment variable, then settings.json, then the plugin option. |
| `devswarm_prompt.child_summary` | `DevSwarm child prompt hook: answers the silent cases (not a child workspace, ...` |  |  | One-line description of the devswarm-child-turn check in the generated reference. |
| `devswarm_prompt.judge_env` | `ANTIHALL_JUDGE_CHILD` |  |  | Environment variable that marks a Jev judge child process; its hooks do nothing (hooks/lib/judge-child-exit.js). Only the exact value in judge_value counts. |
| `devswarm_prompt.judge_value` | `1` |  |  | The value of judge_env that silences the hook. |
| `devswarm_prompt.kill_env` | `DISABLE_ANTIHALL_DEVSWARM` |  |  | Hard kill switch of the DevSwarm integration (hooks/lib/devswarm-detect.js): the exact value in kill_value makes the integration inactive. |
| `devswarm_prompt.kill_value` | `1` |  |  | The value of kill_env that deactivates the DevSwarm integration. |
| `devswarm_prompt.mode_setting` | `7 entries` |  |  | Where devswarm.supervisorMode is read from: environment variable, settings.json, then the plugin option; `values` are the accepted words and `manifest_default` is the default the plugin manifest declares for the option (a stored option equal to it counts as unset, as in hooks/lib/settings.js). |
| `devswarm_prompt.parent_setting` | `6 entries` |  |  | Where the devswarm.parentInbox switch (default on) is read from: no environment variable, then settings.json, then the plugin option. |
| `devswarm_prompt.parent_summary` | `DevSwarm Primary prompt hook: answers the silent cases (not a Primary, DevSwa...` |  |  | One-line description of the devswarm-parent-inbox check in the generated reference. |
| `devswarm_prompt.repo_env` | `DEVSWARM_REPO_ID` |  |  | Environment variable whose non-blank value makes the DevSwarm integration active in auto mode. |

### small_guards.toml / edit_guard

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `edit_guard.edit_tools` | `Edit, Write, MultiEdit, NotebookEdit` |  |  | The tools whose target file the guard checks. |
| `edit_guard.guard_name` | `edit-guard` |  |  | The guard id this check answers to in skip.json and in messages. |
| `edit_guard.launcher_dir` | `.anti-hall, bin` |  |  | Path of the stable launcher directory under the home directory, as its parts. A write into it is blocked for every agent. |
| `edit_guard.msg_launcher_allowed` | `the rest of .anti-hall/** (handovers, progress, history, state).` |  |  | What stays allowed next to the launcher directory. |
| `edit_guard.msg_launcher_instead` | `leave that directory alone.` |  |  | Launcher-directory block advice. |
| `edit_guard.msg_launcher_what` | `{tool} into ~/.anti-hall/bin/ (the stable launcher directory) is blocked.` |  |  | Launcher-directory block headline; {tool} is the tool name. |
| `edit_guard.msg_launcher_why` | `anti-hall installs and refreshes those files itself; overwriting one would ru...` |  |  | Launcher-directory block reason. |
| `edit_guard.notebook_tool` | `NotebookEdit` |  |  | The tool whose target is `tool_input.notebook_path` instead of `tool_input.file_path`. |
| `edit_guard.patch_tool` | `apply_patch` |  |  | The Codex tool whose targets are the files of a patch; the engine has no patch parser, so it defers. |
| `edit_guard.setting` | `6 entries` |  |  | Where the guard's on/off switch is read from (safety.editGuard, default on). |
| `edit_guard.summary` | `Coordinator delegation gate for Edit, Write, MultiEdit and NotebookEdit: answ...` |  |  | One-line description of the edit-guard check in the generated reference. |

### small_guards.toml / expected_failure

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `expected_failure.assign` | `^[A-Za-z_][A-Za-z0-9_]*=` |  |  | Regex source of a leading VAR=value assignment word. |
| `expected_failure.bail` | `<<\|\bset\s+-[A-Za-z]*e\|\bset\s+-o\b\|\bpipefail\b\|\berrexit\b\|\btrap\b\|\bexec\...` |  |  | Regex source of the constructs that make the last statement not decide the exit status (heredocs, set -e, pipefail, trap, exec, eval, shells run with -e). |
| `expected_failure.command_v` | `^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*command\s+-[vV]\b` |  |  | Regex source of the command -v / command -V form (with optional leading assignments). |
| `expected_failure.command_v_verb` | `command -v` |  |  | The verb name reported for the command -v form. |
| `expected_failure.comment_or_empty` | `^\s*(?:#\|$)` |  |  | Regex source of a statement that is a comment or empty. |
| `expected_failure.control` | `^(?:if\|for\|while\|until\|case\|select\|function\|do\|then\|else\|fi\|done\|esac)\b` |  |  | Regex source of a statement that starts a shell control construct (never classified). |
| `expected_failure.exit_code` | `^\s*Exit code (\d+)\b` |  |  | Regex source of the exit code stated in a failed tool call's error text; group 1 is the number. |
| `expected_failure.git_predicates` | `^(?:-C\s+\S+\s+)?diff\b.*(?:--quiet\\|--exit-code)\b, ^(?:-C\s+\S+\s+)?merge-b...` |  |  | Regex sources (JavaScript syntax) over the arguments of a git command that make it a predicate (exit 1 is the answer). |
| `expected_failure.git_verb` | `git` |  |  | The verb whose read-only predicate forms are recognised by git_predicates. |
| `expected_failure.pass_through` | `command, builtin, env, time, nice, nohup` |  |  | Wrappers that pass the inner command's exit status through unchanged. |
| `expected_failure.predicate_exit` | `1` |  |  | The only exit code (as text) that counts as a predicate's answer. |
| `expected_failure.predicate_verbs` | `15 items` |  |  | Verbs whose exit status 1 means no, different or false rather than broken. |
| `expected_failure.redirect_split` | `\s(?:2?>\|&>\|<)` |  |  | Regex source that finds the first redirection in a deciding command. |
| `expected_failure.refusal` | `^\s*This (?:agent\|session) is isolated in the worktree\b` |  |  | Regex source of an error text that is a harness refusal: the command never ran. |
| `expected_failure.subst` | `\$\(\|`` |  |  | Regex source of a command substitution (dollar-parenthesis or backtick). |
| `expected_failure.trailing_and` | `&&\s*$` |  |  | Regex source of a statement ending in a double ampersand. |
| `expected_failure.trailing_bg` | `&\s*$` |  |  | Regex source of a statement ending in an ampersand. |
| `expected_failure.trivial_verbs` | `echo, printf, true, :` |  |  | Statements that cannot fail on their own and may sit in an && chain. |

### small_guards.toml / failure_nudge

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `failure_nudge.cmd_close` | ``)` |  |  | Text after the shown command in the advisory headline. |
| `failure_nudge.cmd_open` | ` (`` |  |  | Text before the shown command in the advisory headline. |
| `failure_nudge.ellipsis` | `…` |  |  | Text appended to a cut command. |
| `failure_nudge.event` | `PostToolUseFailure` |  |  | The hook event name in the advisory's output. |
| `failure_nudge.filter_setting` | `6 entries` |  |  | Where the noise-filter switch is read from (guards.failureNudgeFilter, default on). |
| `failure_nudge.gate_key` | `failure-root-cause-nudge` |  |  | The turn-gate key under which the once-per-turn state of this advisory is kept. |
| `failure_nudge.guard_name` | `failure-root-cause-nudge` |  |  | The skip.json key that silences this hook. |
| `failure_nudge.max_cmd_len` | `80` |  |  | Longest command text, in UTF-16 units, shown in the advisory before it is cut. |
| `failure_nudge.message_guard` | `root-cause` |  |  | The guard label shown in the advisory. |
| `failure_nudge.msg_instead` | `before retrying or patching, trace WHY it failed (see /anti-hall:root-cause) ...` |  |  | Advisory advice. |
| `failure_nudge.msg_what` | `this command failed{cmd}.` |  |  | Advisory headline; {cmd} is the shown command part or empty. |
| `failure_nudge.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.failureRootCauseNudge, default on). |
| `failure_nudge.summary` | `Advisory after a failed Bash call: trace the cause before patching; silent fo...` |  |  | One-line description of the failure-root-cause-nudge check in the generated reference. |

### small_guards.toml / guardkit

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `guardkit.claude_settings_file` | `.claude/settings.json` |  |  | The host's own settings file, relative to the home directory, where plugin options are stored. |
| `guardkit.destructive_guards` | `git-guard, devswarm-read-guard, git-stash-guard` |  |  | Guards that a broad skip of everything does not cover; they must be named in the skip file. |
| `guardkit.false_tokens` | `0, off, false, no` |  |  | Environment or settings strings that mean off (compared after trimming and lower-casing). |
| `guardkit.icons` | `6 entries` |  |  | Leading icon of a block or advisory message, by kind. |
| `guardkit.jev_legacy_file` | `.anti-hall/jev.json` |  |  | The legacy Jev settings file (settings.js reads it below settings.json for the Jev keys), relative to the home directory. |
| `guardkit.js_space` | `\t\n\x0b\x0c\r    -     　﻿` |  |  | Characters JavaScript treats as white space, written as the body of a regex character class; used to translate the JS escapes for white space exactly (Rust's own class differs: it has U+0085 and lacks U+FEFF). |
| `guardkit.line_terminators` | `\n\r  ` |  |  | Characters JavaScript's dot excludes, as the body of a regex character class. |
| `guardkit.lock_stale_ms` | `5000` |  |  | Age, in milliseconds, after which another process's lock on a window file or the metrics is considered abandoned and is taken over (the same limit for a live, a dead and an unknown holder). |
| `guardkit.lock_step_ms` | `5` |  |  | Pause between two attempts to take a held lock. |
| `guardkit.migration_markers_file` | `.anti-hall/update-sweep-state.json` |  |  | The per-migration marker file, relative to the home directory. |
| `guardkit.msg_head` | ` anti-hall · ` |  |  | Text between the icon and the guard name in every block or advisory message. |
| `guardkit.msg_labels` | `4 entries` |  |  | Labels of the optional lines of a block or advisory message. |
| `guardkit.plugin_config_keys` | `anti-hall, anti-hall@anti-hall` |  |  | Keys of the host settings file's pluginConfigs map under which this plugin's options may be stored, lowest priority first. |
| `guardkit.plugin_manifest` | `.claude-plugin/plugin.json` |  |  | The plugin manifest, relative to the plugin root (its version is the one the settings migration stamp is compared with). |
| `guardkit.plugin_option_prefix` | `CLAUDE_PLUGIN_OPTION_` |  |  | Prefix of the environment variables the host sets from plugin options. |
| `guardkit.prune_stamp` | `.prune-stamp-{prefix}.json` |  |  | Name of the stamp file that throttles the pruning sweep; {prefix} is the state-file family. |
| `guardkit.prune_stamp_key` | `lastSweep` |  |  | Key of the stamp file that holds the time of the last sweep. |
| `guardkit.prune_throttle_ms` | `21600000` |  |  | Minimum time, in milliseconds, between two pruning sweeps of one state-file family (6 hours). |
| `guardkit.prune_ttl_ms` | `604800000` |  |  | How old, in milliseconds, a per-session state file must be before the pruning sweep removes it (7 days). |
| `guardkit.render_reserve` | `32` |  | bytes | Extra bytes reserved beyond a message template's length when its placeholders are filled (a capacity hint, not a limit). |
| `guardkit.session_key_max` | `120` |  |  | Longest session key, in UTF-16 units, after the characters outside letters, digits, dot, underscore and hyphen are replaced (the Node state file name limit). |
| `guardkit.settings_dir` | `.anti-hall` |  |  | The anti-hall directory under the home directory, where the legacy settings files live. |
| `guardkit.settings_file` | `.anti-hall/settings.json` |  |  | Settings file, relative to the home directory. |
| `guardkit.settings_migration_key` | `migrateSettingsFromLegacy` |  |  | Key of the marker that says the legacy settings were forward-migrated into settings.json for a plugin version. |
| `guardkit.skip_all_key` | `all` |  |  | Key of the skip file that skips every guard not listed in destructive_guards. |
| `guardkit.skip_file` | `.anti-hall/skip.json` |  |  | Skip file, relative to the home directory (a skipped guard is allowed until its expiry time). |
| `guardkit.state_cap` | `4096` |  |  | How many per-session state entries the in-memory guard state keeps before it evicts the least recently written one. |
| `guardkit.state_dir_name` | `.anti-hall` |  |  | Name of the directory under the home directory that holds the per-session state files the Node guards share with the engine. |
| `guardkit.state_ext` | `.json` |  |  | Extension of a per-session state file. |
| `guardkit.true_tokens` | `1, on, true, yes` |  |  | Environment or settings strings that mean on (compared after trimming and lower-casing). |

### small_guards.toml / merge_gate

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `merge_gate.env_assign` | `^[A-Za-z_][A-Za-z0-9_]*=` |  |  | Regex source of a leading environment assignment the scan skips before the command word. |
| `merge_gate.guard_name` | `merge-gate` |  |  | The guard id this check answers to in skip.json. |
| `merge_gate.hedge_patterns` | `first[- ]pass, not pixel[- ]perfect` |  |  | Self-hedge phrases with punctuation or spacing variants: regex sources (case-insensitive) matched against the recent assistant output. |
| `merge_gate.hedge_phrases` | `7 items` |  |  | Self-hedge phrases, matched case-insensitively as plain text in the recent assistant output. |
| `merge_gate.injected_user` | `^\s*(<(task-notification\|system-reminder\|command-name\|command-message\|local-c...` |  |  | Regex source (case-insensitive) of the user-role bodies that are not a human typing (task notifications, system reminders, hook feedback, cross-session messages). |
| `merge_gate.jev_false` | `no unresolved hedge` |  |  | The label for a false answer of the mergeGateHedge question. |
| `merge_gate.jev_id` | `mergeGateHedge` |  |  | The Jev integration id of the shadow question asked when a hedge is found on a merge command. |
| `merge_gate.jev_instructions` | `Does the recent reply text below contain an UNRESOLVED self-hedge (e.g. "pend...` |  |  | The Noul question text of the mergeGateHedge shadow ask (byte-identical to the Node gate's). |
| `merge_gate.jev_state_chars` | `4000` |  |  | How many trailing UTF-16 units of the assistant text the mergeGateHedge ask evaluates (Node: text.slice(-4000)). |
| `merge_gate.jev_true` | `unresolved hedge present` |  |  | The label for a true answer of the mergeGateHedge question. |
| `merge_gate.merge_rules` | `2 entries, 3 entries, 4 entries, 2 entries, 2 entries` |  |  | The command shapes that are an auto-merge intent. verb: the command word (after leading assignments); prefix: the words that must follow it, in order; includes_any: when present, at least one of these words must appear after the prefix; needs_target: when true, a word after the prefix must match protected_target. |
| `merge_gate.msg_instead` | `verify it against its agreed criterion or get owner sign-off, then merge.` |  |  | The block message's alternative. |
| `merge_gate.msg_override` | `set ANTIHALL_MERGE_GATE=off, or skip merge-gate` |  |  | The block message's override line. |
| `merge_gate.msg_what` | `auto-merge blocked: your recent output flagged a deliverable as pending/unver...` |  |  | The block message's first line; {hedge} is the last hedge phrase found. |
| `merge_gate.msg_why` | `A self-issued hedge blocks auto-merge (false-done backstop).` |  |  | The block message's reason. |
| `merge_gate.non_human_origins` | `human, user` |  |  | The origin kinds of a user record that still count as a human typing. |
| `merge_gate.protected_target` | `^(main\|master\|develop\|origin\/(main\|master\|develop))$` |  |  | Regex source (case-insensitive) of the branch names a plain `git merge` must name to count as an auto-merge. |
| `merge_gate.resolutions` | `owner approved, owner signed off, sign-off received, fidelity verified, verif...` |  |  | Phrases that resolve a hedge when a REAL user prompt typed after the hedge contains one (case-insensitive plain text); the assistant can never clear its own hedge. |
| `merge_gate.segment_split` | `&&\|\\|\\|\|[;&\|\n]` |  |  | Regex source that splits a Bash command into the segments the auto-merge scan looks at (shell separators; quotes are not honoured, on purpose, as in the Node gate). |
| `merge_gate.setting` | `6 entries` |  |  | Where the opt-in switch is read from (guards.mergeGate, default off). |
| `merge_gate.summary` | `Opt-in false-done backstop: answers every Bash call natively, including the b...` |  |  | One-line description of the merge-gate check in the generated reference. |
| `merge_gate.system_reminder` | `<system-reminder>[\s\S]*?<\/system-reminder>` |  |  | Regex source (case-insensitive) of a system-reminder block, removed from a user prompt before it is judged. |
| `merge_gate.window_bytes` | `131072` |  | bytes | How much of the end of the transcript is scanned for a self-hedge (the same bounded tail the Node gate reads). |

### small_guards.toml / merge_side_pick

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `merge_side_pick.cmd_keep` | `120` |  |  | How many UTF-16 units of the side-pick command are kept for the advisory. |
| `merge_side_pick.dry_run` | `\s(?:--dry-run\|-n)\b` |  |  | Regex that marks a push segment as a dry run, which is not a push. |
| `merge_side_pick.fallback_cmd` | `a side-pick` |  |  | Text used for the side-pick command when none was recorded. |
| `merge_side_pick.git_prefix` | `(?:^\|\s)git(?:\s+-C\s+\S+\|\s+-c\s+\S+\|\s+--no-pager)*\s+` |  |  | Regex source that every git pattern starts with: the git word with optional -C, -c and --no-pager options. |
| `merge_side_pick.guard_name` | `merge-side-pick` |  |  | The guard id this check answers to in skip.json and in messages. |
| `merge_side_pick.msg_instead` | `run the tests first, review the discarded side in `git diff`, then push.` |  |  | Advisory advice. |
| `merge_side_pick.msg_what` | `pushing after a conflict was resolved by taking one side wholesale ({pick}) w...` |  |  | Advisory headline; {pick} is the recorded side-pick command. |
| `merge_side_pick.msg_why` | `taking --ours/--theirs (or -X ours/theirs) silently drops the other side's ch...` |  |  | Advisory reason. |
| `merge_side_pick.pick_tails` | `(?:checkout\\|restore)\b[^\n]*?\s--(?:ours\\|theirs)\b, (?:merge\\|pull\\|rebase\...` |  |  | Regex sources, each appended to git_prefix, that recognise taking one side of a conflict wholesale (checkout or restore --ours, -X ours, -s ours). |
| `merge_side_pick.push_tail` | `push\b` |  |  | Regex source appended to git_prefix that recognises a push. |
| `merge_side_pick.quote_masks` | `\x27[^\x27\n]*\x27, "(?:[^"\\\n]\\|\\.)*"` |  |  | Regexes whose matches (quoted spans) are blanked before a command is split into segments, so quoted text is never mistaken for a command (maskShellQuotes). |
| `merge_side_pick.segment_split` | `[;&\|\n]+` |  |  | Regex that splits a masked command into segments (semicolon, ampersand, pipe, newline). |
| `merge_side_pick.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.mergeSidePickAdvisory, default on). |
| `merge_side_pick.state_ns` | `merge-side-pick` |  |  | Namespace of this check's per-session state in the guard state store. |
| `merge_side_pick.summary` | `Advisory: a push after a conflict was resolved by taking one side wholesale, ...` |  |  | One-line description of the merge-side-pick check in the generated reference. |
| `merge_side_pick.test_patterns` | `11 items` |  |  | Regex sources that recognise a test run in a command segment. |

### small_guards.toml / model_routing

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `model_routing.advisory_mode` | `advisory` |  |  | Routing-mode value that downgrades omitted-model strict blocks to advisories. |
| `model_routing.code_fence_re` | ````[\s\S]*?```` |  |  | Regex for fenced code spans stripped before planning and reasoning regexes. |
| `model_routing.complex` | `18 items` |  |  | Complex/planning signal phrases whose presence vetoes rows that steer to haiku. |
| `model_routing.deploy_floor_default` | `sonnet` |  |  | Default deploy/migration/secret model floor. |
| `model_routing.deploy_floor_env` | `ANTIHALL_MODEL_ROUTING_DEPLOY_FLOOR` |  |  | Environment variable that sets the deploy/migration/secret minimum model floor. |
| `model_routing.deploy_floor_key` | `modelRoutingDeployFloor` |  |  | Settings key containing the deploy/migration/secret model floor. |
| `model_routing.deploy_floor_off` | `off` |  |  | Deploy-floor value that disables the deploy/migration/secret floor. |
| `model_routing.deploy_floor_option` | `guards_model_routing_deploy_floor` |  |  | Claude plugin option key for guards.modelRoutingDeployFloor. |
| `model_routing.deploy_floor_values` | `sonnet, opus, off` |  |  | Valid guards.modelRoutingDeployFloor enum values. |
| `model_routing.deploy_strong_re` | `\b(deploy\w*\|redeploy\w*\|migrat\w*\|rollbacks?\|roll\s+back\|token\s+rotation\|ro...` |  |  | Strong deploy/migration/secret regex that activates the deploy floor. |
| `model_routing.deploy_weak_aliases` | `1 entries` |  |  | Weak deploy/migration/secret words normalized before distinct-kind counting. This mirrors Node's production -> prod policy. |
| `model_routing.deploy_weak_re` | `\b(prod\|production\|secrets?\|credentials?)\b` |  |  | Weak deploy/migration/secret words; two distinct kinds activate the deploy floor. |
| `model_routing.deploy_weak_threshold` | `2` |  |  | Number of distinct weak deploy/migration/secret signal kinds needed to activate the deploy floor. |
| `model_routing.explore_type` | `Explore` |  |  | Subagent type recommended for read-only research-shaped generic spawns. |
| `model_routing.flagship_models` | `opus, fable` |  |  | Explicit model enum values treated as flagship tiers for row 1 and row 3. |
| `model_routing.generic_type` | `general-purpose` |  |  | The generic subagent type whose spawns are eligible for the generic-agent routing rows. |
| `model_routing.guard_name` | `model-routing-guard` |  |  | The guard id this check answers to in skip.json and in messages. |
| `model_routing.handover_guard` | `handover` |  |  | The guard label used in the handover-delegation advisory. |
| `model_routing.handover_noun_re` | `\b(handover\|handoff)\b` |  |  | Handover noun regex for the handover-delegation advisory. |
| `model_routing.handover_state_json` | `{"advised":true}` |  |  | JSON written to cap the handover-delegation advisory. |
| `model_routing.handover_state_prefix` | `model-routing-guard-handover-state-` |  |  | Prefix of the per-session handover-delegation advisory cap file. |
| `model_routing.handover_state_suffix` | `.json` |  |  | Suffix of the per-session handover-delegation advisory cap file. |
| `model_routing.handover_verb_re` | `\b(write\|prepare\|create\|author\|draft)\b` |  |  | Handover write-verb regex for the handover-delegation advisory. |
| `model_routing.hard_execution` | `run script, install, build, run tests, git push, deploy` |  |  | Mechanical signals that suppress the row-1 research exemption. |
| `model_routing.inline_code_re` | ``[^`]*`` |  |  | Regex for inline code spans stripped before planning and reasoning regexes. |
| `model_routing.jev_budget_ms` | `1200` |  | ms | Synchronous Jev budget for model-routing relaxation, matching the Node hook. |
| `model_routing.jev_choice_authoring` | `Writing or editing substantial code/content that requires judgment.` |  |  | Jev choice description for authoring tasks. |
| `model_routing.jev_choice_mechanical` | `Execution-only: running commands, fetching/building/testing/deploying, no aut...` |  |  | Jev choice description for mechanical tasks. |
| `model_routing.jev_choice_plan_review` | `Planning, architecture, review, critique, or debate work.` |  |  | Jev choice description for planning/review tasks. |
| `model_routing.jev_choice_research` | `Investigation, research, or audit work — read-only or reporting.` |  |  | Jev choice description for research tasks. |
| `model_routing.jev_id` | `modelRouting` |  |  | Jev integration id used by the Node model-routing guard. |
| `model_routing.jev_label_authoring` | `authoring` |  |  | Jev answer label for authoring work. |
| `model_routing.jev_label_mechanical` | `mechanical` |  |  | Jev answer label that keeps the model-routing block. |
| `model_routing.jev_label_plan_review` | `plan-review` |  |  | Jev answer label for planning/review work. |
| `model_routing.jev_label_research` | `research` |  |  | Jev answer label for research work. |
| `model_routing.jev_question_instructions` | `Classify the SHAPE of this agent-spawn task from its description/prompt.` |  |  | Jev choice-question instructions for model-routing relaxation. |
| `model_routing.jev_state_limit` | `4000` |  | utf16-code-units | Maximum JavaScript UTF-16 code units sent to Jev for model-routing relaxation. |
| `model_routing.key_prefix_chars` | `256` |  | characters | Characters of the spawn prompt hashed (never stored) into the route event's spawn_key, with the session, parent agent and subagent type, so a retry after a deny (new tool_use_id, changed model) joins the first decision. Known limit: two spawns by one agent in one session whose prompts share this prefix and subagent type share a key. |
| `model_routing.mechanical` | `19 items` |  |  | Mechanical execution-only signal phrases, matched as token phrases after compatibility folding. |
| `model_routing.mechanical_shape_re` | `\b(run\s+exactly\|run\s+only\|run\s+(?:this\|these\|the\s+following)\s+(?:exact\s...` |  |  | Fixed-command or bounded-output regex used to suppress row-4 false positives. |
| `model_routing.message_guard` | `model-routing` |  |  | The guard label used in ordinary routing advisory text. |
| `model_routing.mode_env` | `ANTIHALL_MODEL_ROUTING` |  |  | Environment variable whose value advisory downgrades strict omitted-model blocks. |
| `model_routing.mode_option` | `guards_model_routing` |  |  | Claude plugin option key for guards.modelRouting. |
| `model_routing.mode_values` | `strict, advisory, off` |  |  | Valid guards.modelRouting enum values. |
| `model_routing.model_rank` | `4 entries` |  |  | Rank table for the deploy/migration/secret model floor. |
| `model_routing.msg_deploy_low_extra` | ` It also looks planning-shaped; consider opus or fable for deeper reasoning.` |  |  | Extra row-4 planning note appended to a haiku deploy-floor advisory when applicable. |
| `model_routing.msg_deploy_low_instead` | `use model:'{floor}' or higher.{extra}` |  |  | Deploy-floor advisory advice for too-low explicit model spawns. |
| `model_routing.msg_deploy_low_what` | `deploy/migration/secret-shaped spawn runs on '{model}'.` |  |  | Deploy-floor advisory headline for too-low explicit model spawns. |
| `model_routing.msg_deploy_omitted_instead` | `set model:'{floor}' or higher, never haiku.` |  |  | Deploy-floor advisory advice for omitted-model spawns. |
| `model_routing.msg_deploy_omitted_what` | `deploy/migration/secret-shaped spawn sets no explicit model.` |  |  | Deploy-floor advisory headline for omitted-model spawns. |
| `model_routing.msg_deploy_why` | `Auth/secret edge cases get mishandled by a cheap model.` |  |  | Deploy-floor advisory reason. |
| `model_routing.msg_fail_closed_instead` | `run the Node hook fallback or set an explicit safe model before spawning.` |  |  | Fail-closed advice for internal model-routing errors. |
| `model_routing.msg_fail_closed_what` | `model-routing could not safely evaluate this spawn.` |  |  | Fail-closed headline for internal model-routing errors. |
| `model_routing.msg_fail_closed_why` | `The built-in check hit a decode/config/runtime error; a silent allow would vi...` |  |  | Fail-closed reason for internal model-routing errors. |
| `model_routing.msg_handover_instead` | `invoke the handover skill yourself in the session that holds the memory.` |  |  | Handover-delegation advisory advice. |
| `model_routing.msg_handover_what` | `this spawn looks like it writes a session handover.` |  |  | Handover-delegation advisory headline. |
| `model_routing.msg_handover_why` | `A subagent never lived this session, so its reconstruction loses decision/tri...` |  |  | Handover-delegation advisory reason. |
| `model_routing.msg_row1_instead` | `respawn with model:'haiku' (or 'sonnet' if it authors code).` |  |  | Row-1 block advice. |
| `model_routing.msg_row1_jev_instead` | `if it is genuinely mechanical work, prefer model:'haiku'.` |  |  | Row-1 Jev relaxation advisory advice. |
| `model_routing.msg_row1_jev_what` | `execution-shaped spawn on a flagship model ('{model}'); Jev judged it non-mec...` |  |  | Row-1 Jev relaxation advisory headline. |
| `model_routing.msg_row1_research_what` | `execution-shaped spawn on a flagship model ('{model}'), exempt from blocking ...` |  |  | Row-1 research-exempt advisory headline. |
| `model_routing.msg_row1_role_instead` | `if it is genuinely mechanical work, prefer model:'haiku'.` |  |  | Row-1 role-exempt advisory advice. |
| `model_routing.msg_row1_role_what` | `execution-shaped spawn on a flagship model ('{model}'), exempt because a deba...` |  |  | Row-1 role-exempt advisory headline. |
| `model_routing.msg_row1_what` | `execution-shaped task on a flagship model (model: '{model}') is blocked.` |  |  | Row-1 block headline. |
| `model_routing.msg_row1_why` | `This hook cannot see the parent model; execution-only work needs an explicit ...` |  |  | Row-1 block reason. |
| `model_routing.msg_row2_adv_instead` | `set model:'haiku' (or 'sonnet' if it authors code).` |  |  | Row-2 advisory advice. |
| `model_routing.msg_row2_adv_what` | `execution-shaped spawn sets no explicit model.` |  |  | Row-2 advisory headline. |
| `model_routing.msg_row2_adv_why` | `An omitted model inherits the orchestrator's, so mechanical work may run on a...` |  |  | Row-2 advisory reason. |
| `model_routing.msg_row2_block_instead` | `set model:'haiku' (or 'sonnet' for code) on the spawn.` |  |  | Row-2 strict block advice. |
| `model_routing.msg_row2_block_override` | `set ANTIHALL_MODEL_ROUTING=advisory to downgrade this block to an advisory` |  |  | Row-2 strict block override text. |
| `model_routing.msg_row2_block_what` | `execution-shaped spawn with no explicit model is blocked (strict default).` |  |  | Row-2 strict block headline. |
| `model_routing.msg_row2_block_why` | `An omitted model inherits the orchestrator's and cannot be verified here; on ...` |  |  | Row-2 strict block reason. |
| `model_routing.msg_row2_jev_instead` | `if it is genuinely mechanical work, prefer model:'haiku'.` |  |  | Row-2 Jev relaxation advisory advice. |
| `model_routing.msg_row2_jev_what` | `omitted-model spawn looks execution-shaped; Jev judged it non-mechanical, so ...` |  |  | Row-2 Jev relaxation advisory headline. |
| `model_routing.msg_row3_instead` | `unless that agent is pinned to a flagship on purpose, prefer model:'haiku'.` |  |  | Row-3 advisory advice. |
| `model_routing.msg_row3_what` | `execution-shaped task on a flagship model ('{model}') via custom subagent_typ...` |  |  | Row-3 advisory headline. |
| `model_routing.msg_row4_instead` | `consider opus or fable for deeper reasoning.` |  |  | Row-4 advisory advice. |
| `model_routing.msg_row4_what` | `planning-shaped task (architecture/design/plan/brainstorm/deep review) runs o...` |  |  | Row-4 advisory headline. |
| `model_routing.msg_row6_instead` | `re-dispatch as subagent_type:'Explore' (WebSearch/WebFetch, no Agent tool, so...` |  |  | Row-6 advisory advice. |
| `model_routing.msg_row6_what` | `research/read-only-shaped spawn uses subagent_type:'general-purpose'.` |  |  | Row-6 advisory headline. |
| `model_routing.msg_row6_why` | `general-purpose carries the Agent tool and can recurse; chains waste ~7x toke...` |  |  | Row-6 advisory reason. |
| `model_routing.msg_update_instead` | `run `node <path>/update.js ...` directly in the main session.` |  |  | Update-in-session block advice. |
| `model_routing.msg_update_what` | `a subagent spawn that runs the anti-hall update is blocked.` |  |  | Update-in-session block headline. |
| `model_routing.msg_update_why` | `update.js runs migrations and the main session must judge the result.` |  |  | Update-in-session block reason. |
| `model_routing.off_mode` | `off` |  |  | Routing-mode value that disables model-routing. |
| `model_routing.planning_intent_re` | `\b(architect(?:ure)?\|brainstorm\|design\s+(?:a\|the\|an)\b\|plan\s+(?:a\|the\|an\|ou...` |  |  | Strict planning-intent regex for the row-4 haiku advisory. |
| `model_routing.readonly_override_re` | `\b(?:report\s+only\|read[- ]?only\|(?:do\s+not\|don'?t\|never)\s+(?:edit\|modify\|w...` |  |  | Explicit read-only statement regex that overrides ambiguous write words for row 6. |
| `model_routing.readonly_re` | `\b(verbatim\|read[- ]?only\|mechanical\|append\s*only\|run\s+exactly\|do\s+nothing...` |  |  | Read-only/mechanical marker regex used to suppress row-4 false positives. |
| `model_routing.reasoning_re` | `\b(analy[sz]\w*\|synthesi[sz]\w*\|summari[sz]\w*\|reconcil\w*\|evaluat\w*\|interpr...` |  |  | Heavy reading and synthesis regex that vetoes rows steering to haiku. |
| `model_routing.research_re` | `\b(research\|investigate\|find\|search\|audit\|survey\|read[ -]?only\|locate\|map\|gat...` |  |  | Research/read-only regex for the row-1 research exemption and row-6 Explore advisory. |
| `model_routing.review_design_verb_re` | `\b(review\|audit\|design\|architect(?:ure)?\|plan\|brainstorm\|critique\|analy[sz]e\|...` |  |  | Review/design/analysis verb regex that keeps row 4 live despite read-only markers. |
| `model_routing.role_word_re` | `\b(reviewer\|auditor\|critic\|debate\|deadly[- ]?loop)\b` |  |  | Debate-role exemption regex matched against the description only. |
| `model_routing.routing_mode_default` | `strict` |  |  | Default model-routing mode when no setting or env override is present. |
| `model_routing.scan_limit` | `131072` |  | utf16-code-units | Maximum JavaScript UTF-16 code units of description plus prompt scanned for routing keywords (String.prototype.slice parity). |
| `model_routing.session_safe_re` | `[^A-Za-z0-9_.-]` |  |  | Regex whose non-matching characters are replaced in the handover advisory state file name. |
| `model_routing.setting_key` | `modelRouting` |  |  | Settings key containing the model-routing mode. |
| `model_routing.setting_section` | `guards` |  |  | Settings section containing the model-routing settings. |
| `model_routing.state_dir` | `.anti-hall` |  |  | State directory, relative to home, for the handover-delegation advisory cap. |
| `model_routing.summary` | `Anti-waste Agent/Task model routing: blocks execution-shaped flagship or inhe...` |  |  | One-line description of the model-routing check in the generated reference. |
| `model_routing.tier_haiku` | `haiku` |  |  | The cheap execution model tier recommended by rows 1, 2 and 3. |
| `model_routing.tier_inherit` | `inherit` |  |  | Pseudo-tier used in telemetry when an omitted model inherits from the parent. |
| `model_routing.tier_main` | `main` |  |  | Pseudo-tier used when the guard forces work back to the main session. |
| `model_routing.tier_opus` | `opus` |  |  | The planning advisory's default stronger tier. |
| `model_routing.unknown_session` | `unknown-session` |  |  | Fallback session id used in the handover advisory state file name. |
| `model_routing.update_node_re` | `\bnode\s+["']?\S*update\.js\b` |  |  | Regex for node commands that run an update.js script. |
| `model_routing.update_qualifier` | `anti-hall` |  |  | Lowercase qualifier required with a generic update.js command before it is treated as an anti-hall update-in-session. |
| `model_routing.update_setting` | `6 entries` |  |  | Where the update-in-session switch is read from (guards.updateInSession, default on). |
| `model_routing.update_skill_path_re` | `\bnode\s+["']?\S*skills[\\/]update[\\/]scripts[\\/]update\.js\b` |  |  | Regex for node commands that run anti-hall's update skill script. |
| `model_routing.update_slash_re` | `\b(?:run\|invoke\|execute)\s+`?/anti-hall:update\b` |  |  | Regex for explicit requests to invoke the anti-hall update skill. |
| `model_routing.write_imperative_re` | `(?:^\|[\n\r\u2028\u2029]\|[.;:!?]\s+\|\b(?:then\|and\|also\|please\|to)\s+)(?:tag\|re...` |  |  | Instruction-position ambiguous write/execute regex that suppresses the row-6 Explore advisory. |
| `model_routing.write_phrase_re` | `\bsave\s+(?:[\w-]+\s+){0,4}?(?:to\|into)\s+\S\|\bclone\s+(?:\S+\s+){0,3}?(?:int...` |  |  | Explicit write phrase regex that suppresses the row-6 Explore advisory even when read-only override words are present. |
| `model_routing.write_re` | `\b(write\|edit\|modif\|commit\|push\|changelog\|create\s+(?:an?\s+\|the\s+\|new\s+)?f...` |  |  | Write/execute regex that suppresses the row-6 Explore advisory. |

### small_guards.toml / scan_throttle

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `scan_throttle.assign_one` | `^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]\|\\.)*"\|\x27[^\x27]*\x27\|[^\s]*)` |  |  | Regex source of one leading NAME=value assignment (quoted or unquoted value). |
| `scan_throttle.darwin` | `2 entries` |  |  | The macOS throttle tool that must exist on PATH, and the prefix it gives. |
| `scan_throttle.guard_name` | `scan-throttle` |  |  | The guard id this check answers to in messages. |
| `scan_throttle.known_prefixes` | `taskpolicy -c utility nice -n 19 , ionice -c 3 nice -n 19 , nice -n 19 ` |  |  | Every throttle prefix this check itself generates; a command that already starts with one is left alone. |
| `scan_throttle.linux` | `4 entries` |  |  | The Linux throttle tool that must exist on PATH, the prefix it gives, and the optional I/O tool with its own prefix. |
| `scan_throttle.msg_first_instead` | `re-run it background-throttled: `{throttled}`.` |  |  | Advice when the scan is the first simple command; {throttled} is the command with the prefix in place. |
| `scan_throttle.msg_first_what` | `this is a heavy repo-wide scan; the command was NOT modified.` |  |  | Advisory headline when the scan is the first simple command. |
| `scan_throttle.msg_first_why` | `To keep the machine responsive.` |  |  | Advisory reason when the scan is the first simple command. |
| `scan_throttle.msg_group_instead` | `consider running the scan background-throttled, e.g. `{prefix} <that command>`.` |  |  | Advice when the scan is not the first simple command; {prefix} is the throttle prefix without its trailing space. |
| `scan_throttle.msg_group_what` | `a repo-wide scan command was detected in a compound or grouped command (not t...` |  |  | Advisory headline when the scan is not the first simple command. |
| `scan_throttle.path_separator` | `:` |  |  | Separator of the entries of the PATH variable. |
| `scan_throttle.path_var` | `PATH` |  |  | Name of the variable that holds the executable search path. |
| `scan_throttle.pattern_escapes` | `.-/\()[]*+?\|^$sSdDwWbBnt{}` |  |  | Characters that may follow a backslash in a user pattern the engine matches itself (escaped punctuation, class escapes, newline, tab). |
| `scan_throttle.pattern_literal_chars` | ` !#%&',-/:;<=>@_"~`ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz012345...` |  |  | ASCII characters a user pattern may contain as plain literals for the engine to match it itself; a pattern with any other construct defers to the Node guard, whose regex engine is the authority. |
| `scan_throttle.patterns_env` | `ANTI_HALL_THROTTLE_PATTERNS` |  |  | Environment variable holding the comma-separated regex sources of the scan commands to advise on; with none set the check matches nothing. |
| `scan_throttle.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.scanThrottle, default on; the old ANTI_HALL_SCAN_THROTTLE name is an alias). |
| `scan_throttle.summary` | `Advisory: recommends the background-throttled form of a user-configured heavy...` |  |  | One-line description of the scan-throttle check in the generated reference. |
| `scan_throttle.unsafe_start_chars` | `)(;{}\|&`` |  |  | Characters that, as the first character where the prefix would go, make the position unsafe (subshell, group, separator, backtick). |
| `scan_throttle.unsafe_start_subst` | `$(` |  |  | Text that, at the position where the prefix would go, starts a command substitution and makes the position unsafe. |

### small_guards.toml / ship_it

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `ship_it.deferred_tools` | `Bash, apply_patch` |  |  | Tool names whose targets the engine cannot derive exactly (shell writes need the command-guard parser, apply_patch needs the Codex patch parser): with the gate on they defer to the Node guard. |
| `ship_it.files_end` | `\n-[ \t]*[\w][\w ]*:\|\n###[ \t]` |  |  | Regex source (case-insensitive) that finds where a files value ends: the next field bullet or phase heading. |
| `ship_it.files_head` | `\n-[ \t]*files:[ \t]*` |  |  | Regex source (case-insensitive) of the files field a phase declares, up to where its value starts. |
| `ship_it.guard_name` | `ship-it-guard` |  |  | The guard id this check answers to in skip.json and in messages. |
| `ship_it.hard_risk` | `7 items` |  |  | Regex sources (case-insensitive) of hard-risk paths: CI workflows, migrations, auth, security. |
| `ship_it.msg_adv_instead` | `if intentional, proceed; if not, update the PLAN.md Blast radius / phase `fil...` |  |  | Advisory advice. |
| `ship_it.msg_adv_what` | `{file} does not appear in any phase's declared "files:" list in {plan} (advis...` |  |  | Advisory headline; {file} is the first target outside the declared files and {plan} the plan path. |
| `ship_it.msg_adv_why` | `It may be a legitimate shared-file touch (`files:` is free text, so false pos...` |  |  | Advisory reason. |
| `ship_it.msg_block_instead` | `create PLAN.md (repo root) first.` |  |  | Block advice. |
| `ship_it.msg_block_override` | `if this is genuinely a smaller change, unset ANTIHALL_SHIPIT_GATE or use the ...` |  |  | Block override hint. |
| `ship_it.msg_block_what` | `L-risk file {file} edited with no PLAN.md.` |  |  | Block headline; {file} is the first hard-risk file. |
| `ship_it.msg_block_why` | `This path is a hard-risk trigger (migration / auth / CI-workflow / security);...` |  |  | Block reason. |
| `ship_it.non_code_ext` | `\.(md\|mdx\|markdown\|txt\|rst)$` |  |  | Regex source (case-insensitive), tested on the lower-cased base name, for documentation extensions that are never gated. |
| `ship_it.non_code_name` | `plan.md` |  |  | Lower-cased base name that is never gated (the plan file itself). |
| `ship_it.non_code_test_dir` | `(^\|[\\/])(tests?\|__tests__\|spec)([\\/]\|$)` |  |  | Regex source (case-insensitive), tested on the whole path, for test directories that are never gated. |
| `ship_it.non_code_test_file` | `\.(test\|spec)\.[a-z0-9]+$` |  |  | Regex source (case-insensitive), tested on the lower-cased base name, for test file names that are never gated. |
| `ship_it.phase_head` | `^###[ \t]+` |  |  | Regex source a phase section must start with. |
| `ship_it.phase_split` | `\n###[ \t]+` |  |  | Regex source that finds the line break before each phase heading, where the Phases section is split. |
| `ship_it.phases_end` | `\n##[ \t]+\S` |  |  | Regex source that finds where the Phases section ends: the next level-two heading. |
| `ship_it.phases_head` | `(?:^\|\n)##[ \t]+Phases\b` |  |  | Regex source (case-insensitive) of the line that opens the Phases section of a plan. |
| `ship_it.plan_file` | `PLAN.md` |  |  | Name of the plan file looked for in the working directory. |
| `ship_it.setting` | `6 entries` |  |  | Where the opt-in switch is read from (guards.shipitGate, default off). |
| `ship_it.summary` | `Opt-in plan gate: blocks edits to hard-risk files with no PLAN.md and advises...` |  |  | One-line description of the ship-it-guard check in the generated reference. |
| `ship_it.token_ext_max` | `10` |  |  | Longest dotted extension that makes a token without a slash look like a path. |
| `ship_it.token_separators` | `,`"'()` |  |  | Characters that separate path tokens inside a files value, besides white space. |
| `ship_it.token_trim` | `.,;:` |  |  | Trailing characters stripped from a path token. |

### small_guards.toml / turn_gate

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `turn_gate.agent_prefix` | `agent:` |  |  | Prefix of the turn id of a subagent (its whole run is one turn). |
| `turn_gate.dir` | `turn-gate` |  |  | Directory under the state directory that holds the per-session turn-gate files. |
| `turn_gate.injected_re` | `^\s*<(?:task-notification\|system-reminder\|local-command\|command-name\|command-...` |  |  | Regex source (JavaScript syntax) of the text an injected, non-human user entry starts with. |
| `turn_gate.main_label` | `main` |  |  | The slot label used for the main thread. |
| `turn_gate.max_sigs` | `16` |  |  | How many distinct advisory signatures one key remembers per turn. |
| `turn_gate.prefix` | `tg` |  |  | Family name of a turn-gate state file: the file is `<prefix>-<session>.json` and the pruning sweep takes the same name (the Node hook passes `tg` and the sweep appends the dash itself, commit ef0a30b). |
| `turn_gate.session_max` | `80` |  |  | Longest session id part, in UTF-16 units, of a turn-gate file name. |
| `turn_gate.tail_bytes` | `524288` |  |  | How many bytes at the end of the transcript are read to find the newest human prompt. |

### spawn_context.toml / inbox_read

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `inbox_read.devswarm_root` | `.anti-hall/devswarm` |  |  | Path of the DevSwarm state root under the home directory. |
| `inbox_read.guard_inbox` | `devswarm-inbox-read` |  |  | Guard name in the message that blocks a raw inbox read. |
| `inbox_read.inbox_segment` | `inbox` |  |  | First path segment under the DevSwarm root whose files are the raw inbox. |
| `inbox_read.msg_inbox_instead` | ``devswarm.js inbox pull <id>` then `devswarm.js inbox read <id>`.` |  |  | What to do instead of reading the inbox. |
| `inbox_read.msg_inbox_what` | `reading the raw DevSwarm inbox file directly is blocked.` |  |  | What the inbox block says was blocked. |
| `inbox_read.msg_inbox_why` | `It does not drain the queue, but bypasses the durable cursor, so messages get...` |  |  | Why the inbox block applies. |
| `inbox_read.msg_override` | `set DISABLE_ANTIHALL_DEVSWARM=1 to disable this guard entirely` |  |  | How to disable the guard entirely. |
| `inbox_read.setting` | `6 entries` |  |  | Where the on/off switch is read from (devswarm.inboxReadGuard, default on; it has no environment variable). |
| `inbox_read.skip_name` | `devswarm-read-guard` |  |  | Name of the skip-file entry that disables the guard (a broad skip of everything does not cover it). |
| `inbox_read.store_patterns` | `9 items` |  |  | Store-relative paths that are the raw store (JavaScript regex sources): the database and its sidecars and the journal files, per project key and in the old flat layout. |
| `inbox_read.store_segment` | `store` |  |  | First path segment under the DevSwarm root whose files are the raw store. |
| `inbox_read.summary` | `Blocks a Read of the raw DevSwarm inbox; a Read of the raw store defers to No...` |  |  | One-line description of the inbox-read-guard check in the generated reference. |
| `inbox_read.tool` | `Read` |  |  | The only tool the guard looks at. |

### spawn_context.toml / orch_on_spawn

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `orch_on_spawn.agent_markers` | `agent_id, agent_type` |  |  | Payload fields whose mere presence (not null) marks a subagent's own call. |
| `orch_on_spawn.spawn_tools` | `Agent, Task, Workflow, spawn_agent, collaborationspawn_agent` |  |  | Tool names that are a spawn: a call to any other named tool is ignored. |
| `orch_on_spawn.summary` | `Silent unless a spawn-time delivery is pending: answers every case where Node...` |  |  | One-line description of the orch-on-spawn check in the generated reference. |

### spawn_context.toml / orch_state

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `orch_state.codex_orch_full_on_setting` | `7 entries` |  |  | Where the Codex delivery mode of the full orchestration rules is read from (context.codexOrchFullOn). |
| `orch_state.decisions` | `pending, none` |  |  | The decisions a marker may hold: the first is the one meaning the full text is still owed to the first spawn. |
| `orch_state.dir` | `orch-full` |  |  | Directory of the orchestration markers and claims, relative to the state root. |
| `orch_state.full_level` | `full` |  |  | The protocol level that sends today's full text everywhere. |
| `orch_state.orch_full_on_setting` | `7 entries` |  |  | Where the delivery mode of the full orchestration rules is read from (context.orchFullOn). |
| `orch_state.prefix` | `orch-full` |  |  | File-name prefix of every marker, claim and temporary file. |
| `orch_state.protocol_setting` | `7 entries` |  |  | Where the protocol level (compact or full) is read from (context.protocolLevel). |
| `orch_state.setting` | `6 entries` |  |  | Where the orchestration on/off switch is read from (context.verifyFirstOrchestration, default on; it has no environment variable). |
| `orch_state.skip_name` | `orch-on-spawn` |  |  | Name of the skip-file entry that turns the spawn-time delivery off. |
| `orch_state.stamp_prefix` | `.prune-stamp-` |  |  | File-name prefix of the prune stamp (the prefix is appended). |
| `orch_state.throttle_ms` | `21600000` |  | ms | Shortest time between two prune sweeps. |
| `orch_state.ttl_ms` | `604800000` |  | ms | How old a marker or claim must be (by modification time) before the prune sweep removes it. |

### spawn_context.toml / phase_tracker

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `phase_tracker.agents_dir` | `agents` |  |  | Directory of the running-agents heartbeats, relative to the state root. |
| `phase_tracker.cwd_hash_len` | `12` |  |  | How many hex characters of the working directory's SHA-1 the derived tag keeps. |
| `phase_tracker.cwd_tag_prefix` | `cwd-` |  |  | Prefix of the session tag derived from the working directory. |
| `phase_tracker.heartbeat_file` | `recent-spawn.json` |  |  | The rolling heartbeat file written on every spawn, inside the agents directory. |
| `phase_tracker.keep_ms` | `300000` |  | ms | How long a spawn timestamp stays in the log. |
| `phase_tracker.log_file` | `agent-spawns.log` |  |  | The spawn log, relative to the state root. |
| `phase_tracker.summary` | `Records each Agent or Task spawn in ~/.anti-hall (the statusline's live swarm...` |  |  | One-line description of the phase-tracker check in the generated reference. |
| `phase_tracker.tag_max` | `64` |  |  | Longest session tag written next to a spawn timestamp. |
| `phase_tracker.unknown_tag` | `unknown` |  |  | The session tag when the payload names neither a session nor a directory. |

### spawn_context.toml / spawn_ctx

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `spawn_ctx.devswarm_kill_env` | `DISABLE_ANTIHALL_DEVSWARM` |  |  | Environment variable that, set to the kill value, turns DevSwarm detection off entirely (hooks/lib/devswarm-detect.js). |
| `spawn_ctx.devswarm_kill_value` | `1` |  |  | The value of the DevSwarm kill variable that disables detection. |
| `spawn_ctx.devswarm_repo_env` | `DEVSWARM_REPO_ID` |  |  | Environment variable DevSwarm sets in the processes it spawns; a non-blank value means the session runs under DevSwarm. |
| `spawn_ctx.judge_child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | Environment variable that marks a judge child process; a hook that sees it set to the judge value does nothing (hooks/lib/judge-child-exit.js). |
| `spawn_ctx.judge_child_value` | `1` |  |  | The value of the judge-child variable that turns a hook into a no-op. |
| `spawn_ctx.real_home_optout_env` | `ANTIHALL_ALLOW_REAL_HOME_TEST` |  |  | Environment variable that lets a test run use the real home anyway (companion/lib/test-home-guard.js). |
| `spawn_ctx.state_root` | `.anti-hall` |  |  | Directory under the home directory that holds every state file these hooks read or write. |
| `spawn_ctx.supervisor_setting` | `7 entries` |  |  | Where the DevSwarm supervisor mode (auto, on, off) is read from (devswarm.supervisorMode). |
| `spawn_ctx.test_markers` | `NODE_TEST_CONTEXT, ANTIHALL_TEST, ANTIHALL_TEST_ISOLATION` |  |  | Environment variables that mark a test run; under one of them a state path inside the real user home is refused (companion/lib/test-home-guard.js). |
| `spawn_ctx.unknown_session` | `unknown-session` |  |  | Session id used in a state file name when the real one sanitizes to nothing (hooks/lib/handover-find.js). |

### spawn_context.toml / verify_first_orch

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `verify_first_orch.codex_transcript_patterns` | `(^\\|[\\/])rollout-[^\\/]*\.jsonl$, [\\/]\.codex[\\/]` |  |  | Transcript paths that identify a Codex session (JavaScript regex sources): a rollout file, or any path under a .codex directory. |
| `verify_first_orch.compact_body` | `A/E. Delegate builds/tests/deploys/installs, noisy commands and broad searche...` |  |  | Lines of the compact orchestration text, after the first line. |
| `verify_first_orch.compact_delivery` | `; sent in full on your first spawn` |  |  | The phrase added to the compact first line when the full text follows on the first spawn. |
| `verify_first_orch.compact_first` | `ORCHESTRATION (main thread = coordinator; letters match the full rules A-N in...` |  |  | First line of the compact orchestration text. |
| `verify_first_orch.compact_mn_codex` | `M/N. Workers do not re-delegate; read-only research -> a read-only sub-agent;...` |  |  | The compact model-routing line for a Codex session. |
| `verify_first_orch.config_dir_default` | `.claude` |  |  | The host's config directory under the home directory when the variable is not set. |
| `verify_first_orch.config_dir_env` | `CLAUDE_CONFIG_DIR` |  |  | Environment variable that moves the host's config directory. |
| `verify_first_orch.delivery_placeholder` | `<delivery>` |  |  | Placeholder in the compact first line that is replaced by the spawn-delivery phrase, or by nothing. |
| `verify_first_orch.event` | `SessionStart` |  |  | The only event the hook answers. |
| `verify_first_orch.full_lines` | `15 items` |  |  | Lines of the full orchestration text for a Claude session, joined with a newline. |
| `verify_first_orch.full_lines_codex` | `15 items` |  |  | Lines of the full orchestration text for a Codex session, joined with a newline. |
| `verify_first_orch.mn_prefix` | `M/N.` |  |  | How the compact body's model-routing line starts (that line is swapped for the Codex one). |
| `verify_first_orch.projects_dir` | `projects` |  |  | Directory of the host's transcripts, relative to the host's config directory. |
| `verify_first_orch.root_placeholder` | `<abs>` |  |  | Placeholder in the compact text that is replaced by the plugin root. |
| `verify_first_orch.summary` | `SessionStart orchestration text for the Claude entry: composes the full or co...` |  |  | One-line description of the verify-first-orch check in the generated reference. |
| `verify_first_orch.summary_codex` | `SessionStart orchestration text for the Codex entry (the same hook without --...` |  |  | One-line description of the verify-first-orch-codex check in the generated reference. |

### jev.toml / env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `env.jev_audit_snippets` | `ANTIHALL_JEV_AUDIT_SNIPPETS` |  |  | Switch variable of the audit snippets: a boolean word turns them on or off ahead of the settings (Node: ANTIHALL_JEV_AUDIT_SNIPPETS). |
| `env.jev_enabled` | `ANTIHALL_JEV` |  |  | Master switch variable: 1 force-enables Jev, 0 force-disables it and wins over every file setting (Node: ANTIHALL_JEV). |
| `env.jev_integration_prefix` | `ANTIHALL_JEV_` |  |  | Prefix of the per-integration kill switch: the integration id in upper snake case is appended and a value of 0 forces that one integration off (Node: ANTIHALL_JEV_<ID>). |
| `env.jev_key_generic` | `CLAUDE_PLUGIN_OPTION_JEV_API_KEY` |  |  | The legacy vendor-less key option, used only for the vendor it is bound to (Node: CLAUDE_PLUGIN_OPTION_JEV_API_KEY). |
| `env.jev_key_typesafe` | `CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY` |  |  | The key stored in the plugin's options screen for the TypeSafe vendor; it is only ever sent to TypeSafe (Node: CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY). |
| `env.jev_key_vercel` | `CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY` |  |  | The key stored in the plugin's options screen for the Vercel vendor; it is only ever sent to Vercel (Node: CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY). |
| `env.jev_legacy_key_typesafe` | `TYPESAFE_API_KEY` |  |  | Legacy TypeSafe key variable, read only when the jev.allowLegacyKeyRead setting is on (Node: TYPESAFE_API_KEY). |
| `env.jev_legacy_key_vercel` | `AI_GATEWAY_API_KEY` |  |  | Legacy Vercel key variable, read only when the jev.allowLegacyKeyRead setting is on (Node: AI_GATEWAY_API_KEY). |
| `env.jev_option_prefix` | `CLAUDE_PLUGIN_OPTION_` |  |  | Prefix Claude Code gives the plugin options it exports to hook processes; the option name in upper case is appended. |
| `env.jev_test_endpoint` | `ANTIHALL_JEV_TEST_ENDPOINT` |  |  | Test-only endpoint override for the primary transport; honoured only for a loopback host, so a key can never be sent elsewhere (Node: ANTIHALL_JEV_TEST_ENDPOINT). |
| `env.jev_test_endpoint_typesafe` | `ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE` |  |  | Test-only endpoint override for the TypeSafe transport, loopback only (Node: ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE). |
| `env.jev_test_endpoint_vercel` | `ANTIHALL_JEV_TEST_ENDPOINT_VERCEL` |  |  | Test-only endpoint override for the Vercel transport, loopback only (Node: ANTIHALL_JEV_TEST_ENDPOINT_VERCEL). |

### jev.toml / jev

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `jev.async_budget_ms` | `3000` |  | ms | Time budget of an asynchronous (fire-and-forget) call: nobody waits for it, so it may use the full ceiling (Node: DETACHED_DEFAULT_BUDGET_MS). |
| `jev.audit_file` | `jev-audit.ndjson` |  |  | The opt-in audit-snippet log, relative to the log directory (Node: jev-audit.ndjson); redacted snippets of decisions that changed the outcome. |
| `jev.audit_head_chars` | `200` |  |  | Characters kept from the start of an audit snippet (Node: SNIPPET_HEAD). |
| `jev.audit_max_bytes` | `1048576` |  | bytes | The audit log rotates (one backup) once it is larger than this (Node: LOG_MAX_BYTES). |
| `jev.audit_plain_chars` | `200` |  |  | Characters kept of a head-only audit snippet after the scrub (Node: slice(0, 200)). |
| `jev.audit_scrub_chars` | `2000` |  |  | Characters of the judged text scrubbed for a head-only audit snippet (Node: state.slice(0, 2000)). |
| `jev.audit_tail_chars` | `400` |  |  | Characters kept from the end of a tail-weighted audit snippet, whose verdict sits at the end of the text (Node: SNIPPET_TAIL). |
| `jev.audit_tail_ids` | `outputVerifyGuard` |  |  | Integrations whose audit snippet keeps head and tail (the verdict is at the end of the judged text). |
| `jev.balance_body_bytes` | `2048` |  | bytes | How much of an error body is read to classify an out-of-balance answer; the body is never logged (Node: slice(0, 2048)). |
| `jev.balance_pattern` | `insufficient\|credit\|balance\|quota\|billing` |  |  | A 400 or 403 body matching this expression (case-insensitive) is an out-of-balance answer and makes the call fallback-eligible (Node: BALANCE_BODY_RE). |
| `jev.bool_false_tokens` | `0, off, false, no` |  |  | Words that read as false in an environment or settings value (Node: FALSE_TOKENS). |
| `jev.bool_true_tokens` | `1, on, true, yes` |  |  | Words that read as true in an environment or settings value (Node: TRUE_TOKENS). |
| `jev.breaker_cooldown_ms` | `300000` |  | ms | How long an open breaker skips its vendor before a probe is allowed (Node: BREAKER_COOLDOWN_MS). |
| `jev.breaker_file` | `cache/jev-breaker.json` |  |  | The breaker state file, relative to the anti-hall home directory; the same file the Node hooks use, so both see one breaker (Node: jev-breaker.json under cache/). |
| `jev.breaker_threshold` | `3` |  |  | Consecutive fallback-eligible failures that open a vendor's breaker (Node: BREAKER_THRESHOLD). |
| `jev.budget_file` | `jev-budget.json` |  |  | The budget-watch state file in jev.state_dir: the day, the spend so far and the day a warning was last given (Node: jev-budget.json). |
| `jev.cache_file` | `cache/jev-assist.json` |  |  | The answer cache file, relative to the anti-hall home directory; the same file the Node hooks use (Node: cache/jev-assist.json), so a text asked by either side is asked once. |
| `jev.cache_max_depth` | `128` |  |  | Nesting past which the answer cache file is left alone: only JavaScript reads it, so the engine neither serves from it nor rewrites it (JSON.parse reads deeper than this port does). |
| `jev.cache_max_entries` | `500` |  |  | Answers the content-hash cache keeps; the oldest is evicted first (Node: CACHE_MAX_ENTRIES). |
| `jev.confidence_threshold` | `0.85` |  |  | Default minimum confidence for an answer to count as trusted, a decimal between 0 and 1 (Node: DEFAULT_CONFIDENCE_THRESHOLD). |
| `jev.detached_args` | `jev, ask, --json` |  |  | The arguments of the detached process a one-shot caller starts for an ask nobody waits for (reads one request line on stdin, as `jev ask` does). |
| `jev.drain_poll_ms` | `2` |  | ms | How often `drain` checks whether the asynchronous queue has emptied (tests and shutdown only). |
| `jev.endpoint_typesafe` | `https://api.typesafe.ai/v1/systemone` |  |  | TypeSafe's own direct API endpoint (Node: TYPESAFE.endpoint). |
| `jev.endpoint_vercel` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` |  |  | Vercel AI Gateway TypeSafe passthrough that serves the Jev system-one API (Node: jev-client.js GATEWAY.endpoint). |
| `jev.env_cache_cap` | `8` |  |  | Distinct session environments whose resolved settings are kept (the engine serves many sessions, each with its own environment); the oldest is dropped first. |
| `jev.fallback_reserve_ms` | `600` |  | ms | Budget held back from the primary for the fallback when one is configured (Node: FALLBACK_RESERVE_MS). |
| `jev.fallback_reserve_pct` | `40` |  |  | The reserve is at most this percent of the total budget (Node: Math.floor(totalMs * 0.4)). |
| `jev.hash_len` | `16` |  |  | Hex characters of the SHA-256 content hash kept as the cache key and the log's h field (Node: slice(0, 16)). |
| `jev.integrations` | `21 entries` |  |  | Default mode of every known integration, on, shadow or off: the Node settings schema's jevIntegrations defaults. Jev only changes an outcome in on mode, and never removes a block or advisory (D36). |
| `jev.key_file_max_bytes` | `4096` |  | bytes | Largest key file that is read (Node: MAX_KEY_FILE_BYTES). |
| `jev.key_file_roots` | `.config, .anti-hall` |  |  | Directories under the home directory a key file must really live in once symlinks are resolved (Node: readKeyFile). |
| `jev.key_file_typesafe` | `.config/typesafe/key` |  |  | Default key file for the TypeSafe vendor, relative to the home directory; read only when jev.allowLegacyKeyRead is on (Node: defaultKeyFilePath). |
| `jev.key_file_vercel` | `.config/vercel/ai-gateway-key` |  |  | Default key file for the Vercel vendor, relative to the home directory; read only when jev.allowLegacyKeyRead is on (Node: defaultKeyFilePath). |
| `jev.lane_cap` | `8` |  |  | How many home directories keep a resident Jev lane at once (one per user in practice; the oldest is dropped past the cap). |
| `jev.latency_samples_max` | `4096` |  |  | Most call-latency samples held between two metrics flushes; past it new samples are dropped until the flush drains them (a bound on memory if the flush stalls). |
| `jev.legacy_file` | `jev.json` |  |  | The legacy Jev config file, relative to the anti-hall home directory, read below settings.json (Node: jev.json). |
| `jev.legacy_on_default` | `speculation, triage` |  |  | Integrations that predate the per-integration modes and stay on by default; consulted only for an id missing from the table (Node: LEGACY_ON_DEFAULT). |
| `jev.legacy_triage_key` | `triage` |  |  | Id of the integration that the pre-integrations-map triage switch (jev.triage set to false) still turns off. |
| `jev.log_dir` | `logs` |  |  | The directory of the Jev logs (decision log, audit log, daily rollups), relative to the anti-hall home directory. |
| `jev.log_file` | `logs/jev-assist.ndjson` |  |  | The decision log, relative to the anti-hall home directory, in the row shape the Node jev report reads (Node: logs/jev-assist.ndjson). |
| `jev.log_max_bytes` | `2097152` |  | bytes | Size at which the decision log rotates (Node: DECISION_LOG_MAX_BYTES). |
| `jev.log_off_rows` | `1` |  |  | 1 (default) also logs a row for a call whose integration is off or whose Jev is disabled, as the Node client does, so the `jev report` call-volume view is unchanged by the move to the engine; 0 writes nothing and does no I/O at all for such a call. |
| `jev.log_rotated_files` | `10` |  |  | Rotated generations kept, .1 to .N (Node: the jev.logRotatedFiles setting). |
| `jev.max_response_bytes` | `1048576` |  | bytes | Largest response body read from a vendor; a longer one is treated as unparsable, so a misbehaving endpoint cannot grow the daemon's memory (D15). |
| `jev.max_timeout_ms` | `3000` |  | ms | Hard ceiling on any configured or per-call timeout, so a Jev call can never outlast the hook that asked (Node: MAX_TIMEOUT_MS). |
| `jev.min_fallback_ms` | `150` |  | ms | Below this much remaining budget no real call can finish, so the fallback is skipped (Node: MIN_FALLBACK_MS). |
| `jev.model_typesafe` | `jev-latest` |  |  | Model name sent to the direct TypeSafe transport (Node: TYPESAFE.model). |
| `jev.model_vercel` | `typesafe-ai/jev` |  |  | Model name sent to the Vercel transport (Node: GATEWAY.model). |
| `jev.price_usd_per_m_input` | `0.042` |  |  | USD per million input tokens used when a response reports tokens but no cost; Jev's own published rate (Node: jev.priceUsdPerMInput). |
| `jev.price_usd_per_m_output` | `0` |  |  | USD per million output tokens used when a response reports tokens but no cost; output is free on the published rate (Node: jev.priceUsdPerMOutput). |
| `jev.question_version` | `v1` |  |  | Part of the cache key, bumped when a question's wording changes so old answers are not reused (Node: QUESTION_VERSION). |
| `jev.queue_cap` | `64` |  |  | Calls the asynchronous queue holds; a call that finds it full is logged as busy and gets its baseline, so the queue can never grow without bound (D15). |
| `jev.relax_sync_cap_ms` | `1500` |  | ms | Longest a relax-block consult inside a hook that is about to nudge or block waits for Jev when the integration is on; a slower answer keeps today's verdict (Node: RELAX_SYNC_CAP_MS). |
| `jev.retry_status_min` | `500` |  |  | An HTTP status at or above this one is a retry-eligible failure of the primary (Node: status >= 500). |
| `jev.retry_statuses` | `402, 429` |  |  | HTTP statuses below jev.retry_status_min that are retry-eligible (Node: 402, 429). |
| `jev.retry_statuses_balance` | `400, 403` |  |  | HTTP statuses that are retry-eligible only when the response body names an exhausted balance (Node: 400 and 403 with the balance pattern). |
| `jev.rollup_dir` | `jev-daily` |  |  | Directory of the daily rollups, relative to the log directory (Node: jev-daily); one JSON file per UTC day. |
| `jev.scrub_failed_text` | `[REDACTED_UNSCRUBBED]` |  |  | What the scrubber returns instead of the text when one of jev.scrub_rules does not compile: nothing unscrubbed ever leaves. |
| `jev.scrub_rules` | `17 items` |  |  | The outbound secret-scrub rules every Jev request body passes through, in order (Node: hooks/lib/secret-scrub.js scrubSecrets, rule for rule): `pattern` (Rust regex syntax: JavaScript look-behind is `no_alnum_before`, a hit right after an ASCII letter or digit is skipped; `\s` is spelled as JavaScript's whitespace set; the `i` flag as explicit [xX] classes), `to` the replacement (`${n}` a group). A rule that does not compile makes the scrubber redact the whole text (jev.scrub_failed_text). |
| `jev.settings_file` | `settings.json` |  |  | The unified settings file, relative to the anti-hall home directory (Node: settings.json). |
| `jev.settings_recheck_ms` | `2000` |  | ms | How often the settings files are re-checked for changes: at most one stat of each of the two files per window, taken by the first call after it elapses; between checks a call costs one clock read, so an off Jev stays off the hot path. |
| `jev.state_dir` | `state` |  |  | Directory of the Jev budget-watch state, relative to the anti-hall home directory (Node: state/). |
| `jev.timeout_ms` | `1500` |  | ms | Per-call time budget for one Jev call, request, headers and body together (Node: DEFAULT_TIMEOUT_MS). |
| `jev.turn_ref_window_bytes` | `65536` |  | bytes | How much of the end of a transcript is scanned for the turn pointer on a decision row (Node: the 64 KiB window of turnRefFromTranscript). |
| `jev.unlisted_mode` | `shadow` |  |  | Mode of an integration id that is not in the table (Node: every id that is not one of the legacy on-by-default ones). |

### judge.toml / cascade

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `cascade.answer_key` | `answer` |  |  | The field of the model's JSON reply that holds its answer: true or false for a yes/no question, an option label for a pick-one question. |
| `cascade.backend` | `cascade` |  |  | The backend name a telemetry row gives an escalation (Jev first, the model second). |
| `cascade.backend_settings` | `2 entries` |  |  | Integrations whose own backend setting can name the cascade (value `cascade`), switching it on for that integration: the Jev integration id to the defaults entry of its backend setting. |
| `cascade.cache_suffix` | `cascade` |  |  | Appended to a decision's cache key to store the model's re-judged answer beside Jev's; the next ask of the same decision reads it. |
| `cascade.confidence_key` | `confidence` |  |  | The field of the model's JSON reply that holds its confidence, a number in [0,1]. |
| `cascade.default_mode` | `off` |  |  | The cascade switch of an integration that names none in cascade.modes or in the jevCascade settings section: on or off. off keeps today's behaviour. |
| `cascade.enabled_setting` | `6 entries` |  |  | Global kill switch of the cascade. false turns it off for every integration whatever their own switch says. Setting jev.cascade, env ANTIHALL_JEV_CASCADE. |
| `cascade.env_prefix` | `ANTIHALL_JEV_CASCADE_` |  |  | Prefix of the per-integration cascade environment switch; the snake-cased upper-case id is appended (ANTIHALL_JEV_CASCADE_MODEL_ROUTING). A boolean word wins over every other source. |
| `cascade.err_busy` | `busy` |  |  | Telemetry error word: too many escalations were running, so this one was skipped. |
| `cascade.escalate_below` | `1 entries` |  |  | Per-integration confidence under which Jev's answer is escalated to the model, keyed by the Jev integration id, as a decimal in [0,1] in text. An integration not listed escalates below its own act threshold (jev.confidenceThreshold). |
| `cascade.inflight_cap` | `4` |  |  | Escalations that may run in the background at once; an escalation past it is skipped (its Jev answer stands) and recorded as busy. |
| `cascade.input_evidence` | `\nEVIDENCE:\n` |  |  | Heading of the evidence in the model's input. |
| `cascade.input_jev` | `\nFIRST CLASSIFIER ANSWERED: {answer} (confidence {confidence})\n` |  |  | The line that shows the first classifier's answer and confidence ({answer}, {confidence}); written only when cascade.show_setting is true. |
| `cascade.input_options` | `\nALLOWED ANSWERS:\n` |  |  | Heading of the allowed answers in the model's input; each option follows as `label: meaning`. |
| `cascade.input_question` | `QUESTION:\n` |  |  | Heading of the question in the model's input. |
| `cascade.max_evidence` | `6000` |  |  | UTF-16 units of the evidence text the model sees. |
| `cascade.modes` | `0 entries` |  |  | Per-integration cascade switch (on or off), keyed by the Jev integration id, ahead of cascade.default_mode. The owner's jevCascade.<id> setting wins over it. |
| `cascade.on` | `on` |  |  | The word that turns a per-integration cascade switch on. |
| `cascade.settings_section` | `jevCascade` |  |  | The settings.json section that holds the owner's per-integration cascade switch (jevCascade.<id> = on\|off). |
| `cascade.show_setting` | `6 entries` |  |  | Whether the model sees Jev's answer and confidence next to the evidence (true) or judges the evidence alone (false), so anchoring can be A/B tested. Setting jev.cascadeShowJevAnswer, env ANTIHALL_JEV_CASCADE_SHOW_JEV_ANSWER. |
| `cascade.system_prompt` | `You are the second opinion on a classification decision. You are given a QUES...` |  |  | The system prompt of the model that re-judges an answer Jev was unsure about. |
| `cascade.timeout_ms` | `25000` |  | ms | How long the model may take to re-judge one escalated answer. |

### judge.toml / judge

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `judge.anthropic_env_optin` | `6 entries` |  |  | The home-only switch that lets ANTHROPIC_API_KEY count as a key (guards.allowAnthropicEnvKey; no env, no plugin option). |
| `judge.anthropic_key_env` | `CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY` |  |  | The plugin option that holds the Anthropic API key (Node credentials.js: CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY). Only its presence is read here. |
| `judge.anthropic_legacy_env` | `ANTHROPIC_API_KEY` |  |  | The legacy key variable, which counts only when guards.allowAnthropicEnvKey is on in the home settings file. Only its presence is read here. |
| `judge.arg_model` | `{model}` |  |  | The argv element replaced by the model alias. |
| `judge.arg_system` | `{system}` |  |  | The argv element replaced by the system prompt of the call. |
| `judge.backend_auto` | `auto` |  |  | The judgeBackend value that picks api when an Anthropic key is visible, else cli. |
| `judge.backend_cli` | `cli` |  |  | The judgeBackend value for the local Claude CLI, which the engine runs itself. |
| `judge.backend_haiku_cli` | `haiku-cli` |  |  | The backend name a telemetry row gives a call through the Claude CLI. |
| `judge.backend_jev` | `jev` |  |  | The backend name a telemetry row gives a Jev call. |
| `judge.backend_setting` | `7 entries` |  |  | How the judge reaches the model: jev.judgeBackend (env ANTIHALL_JUDGE_BACKEND), api (default), cli or auto (api when an Anthropic key is visible, else cli). |
| `judge.cli_args` | `15 items` |  |  | The judge's argv after the program name: no tools, no MCP servers, no settings files, every hook disabled, JSON output (Node: cliArgs). An element that is exactly the model or system placeholder is replaced by that value. |
| `judge.cli_bin` | `claude` |  |  | The program the judge runs, looked up on the PATH of the hook's own environment (Node: spawn('claude')). |
| `judge.err_answer` | `answer` |  |  | Telemetry error word: the model's answer did not parse into the expected decision. |
| `judge.err_exit` | `exit` |  |  | Telemetry error word: the CLI exited non-zero or by a signal. |
| `judge.err_output` | `output` |  |  | Telemetry error word: the CLI's output was not the JSON it promises, or reported is_error. |
| `judge.err_spawn` | `spawn` |  |  | Telemetry error word: the CLI could not be started. |
| `judge.err_timeout` | `timeout` |  |  | Telemetry error word: the call ran past its timeout and was killed. |
| `judge.error_field` | `is_error` |  |  | The field of the CLI's JSON output that is truthy when the call failed. |
| `judge.fence_close_re` | `\s*```$` |  |  | Trailing code fence removed before parsing (Node: /\s*```$/). |
| `judge.fence_open_re` | `^```(?:json)?\s*` |  |  | Leading code fence a model may wrap its JSON in, removed before parsing (Node: /^```(?:json)?\s*/i). |
| `judge.model_setting` | `6 entries` |  |  | Where the model alias is read from: jev.judgeModel (env ANTIHALL_JUDGE_MODEL, plugin option jev_judge_model), default the alias haiku. Always an alias: the CLI resolves it to the latest model, nothing pins a version. |
| `judge.poll_ms` | `5` |  |  | How often the call checks whether the child has exited. |
| `judge.read_chunk` | `65536` |  |  | Bytes read from the child's stdout at a time. |
| `judge.result_field` | `result` |  |  | The field of the CLI's JSON output that holds the model's answer text (claude -p --output-format json). |
| `judge.stdout_cap` | `1000000` |  |  | Stdout is collected while it is shorter than this many bytes (Node: if (out.length < 1e6) out += d); the rest is discarded. |
| `judge.telemetry_log` | `logs/judge-calls.ndjson` |  |  | One row per model call the engine makes (integration, backend, model, latency, confidence, error; never the prompt, the reply or a key), relative to the anti-hall home directory. Empty turns the rows off. |
| `judge.telemetry_max_bytes` | `1048576` |  |  | The telemetry log is emptied before a row that would take it past this size. |
| `judge.tmp_attempts` | `16` |  |  | How many random names are tried for the private working directory before the call gives up (a name that exists is skipped). |
| `judge.tmp_env` | `TMPDIR, TMP, TEMP` |  |  | The variables that name the temporary directory, in the order os.tmpdir() reads them. |
| `judge.tmp_fallback` | `/tmp` |  |  | The temporary directory when none of judge.tmp_env is set (os.tmpdir() on POSIX). |
| `judge.tmp_prefix` | `antihall-judge-` |  |  | Name prefix of the private empty working directory each call gets (Node: fs.mkdtempSync(os.tmpdir()/antihall-judge-)); it is removed when the call ends, so a planted CLAUDE.md cannot steer the judge. |
| `judge.tmp_suffix_len` | `6` |  |  | Random characters appended to the prefix (mkdtemp's XXXXXX). |

### judge.toml / judge_evidence

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `judge_evidence.default_tool` | `shell` |  |  | The tool name of a Codex call that names none. |
| `judge_evidence.fences` | ````, ~~~` |  |  | The code fences whose bodies count as pasted evidence (Node: fencedBlocks /(```\|~~~)[^\n]*\n([\s\S]*?)\1/g). |
| `judge_evidence.max_chunk` | `20000` |  |  | UTF-16 units kept of one evidence chunk (Node: MAX_CHUNK). |
| `judge_evidence.observe_tools_re` | `^(?:bash\|read\|grep\|glob\|ls\|notebookread\|webfetch\|websearch\|exec_command\|shell...` |  |  | Tool names whose input counts as evidence (Node: OBSERVE_INPUT_TOOLS, case-insensitive). |
| `judge_evidence.output_suffix` | `_output` |  |  | A Codex payload type ending in this is a tool output. |
| `judge_evidence.prompt_skip_re` | `^\s*<(?:task-notification\|command-\|local-command\|system-reminder)` |  |  | A user text that starts with one of these tags is not the user's request (Node: lastUserPrompt). |
| `judge_evidence.task_notification` | `<task-notification>` |  |  | A user text holding this tag counts as evidence whole. |
| `judge_evidence.words` | `11 entries` |  |  | Transcript type and role values the collectors match (Claude and Codex transcript shapes). |

### judge.toml / speculation_judge

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `speculation_judge.backend_jev` | `jev` |  |  | The speculationBackend value that leaves the speculation question to Jev alone. |
| `speculation_judge.backend_setting` | `7 entries` |  |  | Which backend answers the speculation question when the semantic judge is on: haiku (default, today's behaviour: the judge asks the model, except while Jev's own speculation integration is on) jev (the judge never asks the model; speculation-guard's Jev path is the only semantic check) or cascade (as jev, with the Jev-first cascade switched on for the speculation integration: a Jev answer under the escalation threshold is re-judged by the model in the background and applies from the next turn). Setting jev.speculationBackend, env ANTIHALL_JEV_SPECULATION_BACKEND. |
| `speculation_judge.claim_bidi_re` | `[‪-‮⁦-⁩]` |  |  | Bidi overrides and isolates removed from the judge's claim (U+202A-U+202E, U+2066-U+2069). |
| `speculation_judge.claim_controls_re` | `[\x00-\x1F\x7F-\x9F]` |  |  | Control characters replaced by a space in the judge's claim (Node: /[\x00-\x1F\x7F-\x9F]/g). |
| `speculation_judge.claim_default` | `an unverified factual claim` |  |  | The claim named in the block when the judge gave none (Node: sanitizeClaim fallback). |
| `speculation_judge.claim_ellipsis` | `…` |  |  | Appended to a claim cut at claim_max. |
| `speculation_judge.claim_max` | `120` |  |  | UTF-16 units of the judge's claim kept in the block reason. |
| `speculation_judge.claim_ws_re` | `\s+` |  |  | White space runs collapsed to one space in the judge's claim (Node: /\s+/g). |
| `speculation_judge.decision_allow` | `allow` |  |  | The decision value that allows. |
| `speculation_judge.decision_block` | `block` |  |  | The decision value that blocks. |
| `speculation_judge.evidence_window` | `1048576` |  |  | Bytes of the transcript tail read for the user request and the tool evidence (Node: 1024 * 1024). |
| `speculation_judge.hash_suffix` | `:judge` |  |  | Appended to the reply before hashing it, so the judge's hashes never collide with speculation-guard's. |
| `speculation_judge.input_evidence` | `\n\nTOOL EVIDENCE (most recent last):\n` |  |  | Heading of the tool evidence in the judge input. |
| `speculation_judge.input_item` | `[{n}] ` |  |  | Prefix of each evidence chunk; {n} is its 1-based number. |
| `speculation_judge.input_message` | `\n\nMESSAGE to evaluate:\n\n` |  |  | Heading of the reply in the judge input. |
| `speculation_judge.input_no_evidence` | `(none)` |  |  | Shown when there is no tool evidence. |
| `speculation_judge.input_no_request` | `(not available)` |  |  | Shown when there is no user request. |
| `speculation_judge.input_request` | `USER REQUEST:\n` |  |  | Heading of the user request in the judge input. |
| `speculation_judge.jev_id` | `speculation` |  |  | The Jev integration whose mode on makes the judge stand down (Node: getMode('speculation') === 'on'). |
| `speculation_judge.max_blocks` | `3` |  |  | Blocks per session after which the judge stays quiet (Node: MAX_BLOCKS). |
| `speculation_judge.max_chunk` | `1500` |  |  | UTF-16 units one evidence chunk may contribute (Node: Math.min(1500, ...)). |
| `speculation_judge.max_evidence` | `6000` |  |  | UTF-16 units of tool evidence the judge sees, newest chunks first (Node: MAX_EVIDENCE). |
| `speculation_judge.max_message` | `8000` |  |  | UTF-16 units of the reply the judge sees (Node: MAX_MESSAGE). |
| `speculation_judge.max_request` | `2000` |  |  | UTF-16 units of the user request the judge sees (Node: MAX_REQUEST). |
| `speculation_judge.msg_instead` | `verify it with a tool, or say what is unverified ('I don't know, here is what...` |  |  | What to do instead. |
| `speculation_judge.msg_what` | `your reply states '{claim}' as fact, but nothing this session checked shows i...` |  |  | What the block says; {claim} is the sanitized claim. |
| `speculation_judge.msg_why` | `Unverified claims read as facts.` |  |  | Why the block matters. |
| `speculation_judge.reply_window` | `524288` |  |  | Bytes of the transcript tail read for the reply when the payload does not carry it (Node: readTranscriptTail default 512 KB). |
| `speculation_judge.state_prefix` | `judge-state-` |  |  | Name prefix of the per-session state file under the anti-hall directory (Node: judge-state-<session>.json). |
| `speculation_judge.system_prompt` | `You are an anti-hallucination evaluator for a coding assistant.\nYour job: as...` |  |  | The judge's system prompt (judge-core.js JUDGE_SYSTEM), byte for byte. |
| `speculation_judge.timeout_ms` | `25000` |  |  | The CLI judge's timeout (Node: runCliJudge timeoutMs 25000; the Stop hook's budget is 30 s). |

### judge.toml / triage

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `triage.backend_haiku` | `haiku` |  |  | The triageBackend value that skips Jev and asks the model alone. |
| `triage.backend_setting` | `7 entries` |  |  | Which backend labels mesh messages: jev (default, today's behaviour: Jev first, the Anthropic API fills a missing label when a key is visible) haiku (the model alone, through jev.judgeBackend) or cascade (as jev, then a label Jev left open is re-judged by the model, shown Jev's answer, through the Claude CLI). Setting jev.triageBackend, env ANTIHALL_JEV_TRIAGE_BACKEND. |
| `triage.default_timeout_ms` | `2000` |  |  | The whole run's budget when the request names none (Node: 2000). |
| `triage.default_urgent_threshold` | `0.9` |  |  | The confidence an urgent answer needs when the request names none (Node: 0.9). |
| `triage.input_prefix` | `Message:\n\n` |  |  | Prefix of the message in the Haiku request (Node: 'Message:\n\n' + text). |
| `triage.integration` | `triage` |  |  | The integration name telemetry rows of triage calls carry. |
| `triage.kind_criteria` | `question-needs-answer, The message asks the recipient a direct question that ...` |  |  | The kind labels and their criteria, in the order Node sends them (KIND_QUESTION.criteria). |
| `triage.kind_instructions` | `Classify this mesh message by what kind of response, if any, it needs from th...` |  |  | The Jev Choice question that classifies a mesh message's kind (Node: KIND_QUESTION.instructions). |
| `triage.kind_key` | `kind` |  |  | The question key of the kind question in the multi-question call. |
| `triage.label_haiku` | `haiku` |  |  | The backend label of a result the model answered (appended as +haiku after jev). |
| `triage.label_jev` | `jev` |  |  | The backend label of a result Jev answered. |
| `triage.label_unknown` | `unknown` |  |  | The backend label when nobody can be named (Node: 'unknown'). |
| `triage.max_text` | `4000` |  |  | UTF-16 units of the message sent to Jev or the model (Node: slice(0, 4000)). |
| `triage.min_remaining_ms` | `50` |  |  | A call starts only with more than this much of the budget left, and gets at least this much (Node: 50). |
| `triage.normal` | `normal` |  |  | The urgency label of a message that can wait. |
| `triage.system_prompt` | `You triage one internal coordination message between two AI agent workspaces....` |  |  | The Haiku triage system prompt (Node: HAIKU_SYSTEM), byte for byte. |
| `triage.urgency_false` | `The message is a routine status update, a done-report, an FYI, or anything el...` |  |  | URGENCY_QUESTION criteria.false. |
| `triage.urgency_instructions` | `Does this mesh message require URGENT, immediate attention — a blocker, or a ...` |  |  | The Jev Noul question that asks whether a mesh message is urgent (Node: URGENCY_QUESTION.instructions). |
| `triage.urgency_key` | `urgency` |  |  | The question key of the urgency question in the multi-question call. |
| `triage.urgency_true` | `The message is a live blocker or an unanswered question gating the sender's p...` |  |  | URGENCY_QUESTION criteria.true. |
| `triage.urgent` | `urgent` |  |  | The urgency label of an urgent message. |

### jev_evidence.toml / evidence

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `evidence.answer_key` | `answer` |  |  | The field of a Haiku reply that holds its answer. |
| `evidence.cfg` | `3 entries` |  |  | The evidence gate of each supervisor integration, keyed by its Jev integration id (fields described in the header). devswarmWaitKind: stuck or waiting (design card 4.5): asked only with enough transcript and mesh evidence and only when no rule settles it; a done, archived or held child is never asked about, and running CI, an unanswered question to the parent, a report newer than anything received or a usage-limit pause each mean waiting. devswarmLoop (card 4.10): a rule decides; recent progress means not looping, and the model only confirms a candidate (the same command and error repeated, or a change reverted). devswarmStepMap (card 4.6): asked only for a plan with at least two steps, a summary of enough text and an earlier summary that reported a step; one step in progress with no sequencing word, or a summary that quotes a step's text, decides without a model. |
| `evidence.confidence_key` | `confidence` |  |  | The field of a Haiku reply that holds its confidence. |
| `evidence.date_chars` | `10` |  |  | Characters of an ISO timestamp that make its UTC date, which the per-day Haiku cap counts by. |
| `evidence.dur_placeholder` | `{dur}` |  |  | The placeholder in a question that the caller's `dur` text (how long there was no progress) replaces. |
| `evidence.earlier_line` | `step {step}: {text}` |  |  | How one earlier summary is written in the evidence pack: {step} the step it reported ({unreported} when none), {text} its text. |
| `evidence.fact_line` | `{name} = {value}` |  |  | How one fact is written in the facts block: {name} and {value}. |
| `evidence.heading_evidence` | `\nEVIDENCE:\n` |  |  | Heading written before the evidence pack in the model's input. |
| `evidence.heading_facts` | `FACTS:\n` |  |  | Heading of the facts block of the evidence pack. |
| `evidence.heading_options` | `\nALLOWED ANSWERS:\n` |  |  | Heading written before the allowed answers in the model's input; each option follows as `label: meaning`. |
| `evidence.heading_question` | `QUESTION:\n` |  |  | Heading written before the question in the model's input. |
| `evidence.heading_section` | `\n{section}:\n` |  |  | Heading of one pack section ({section}). |
| `evidence.kind_steps` | `steps` |  |  | The `kind` value of an integration whose question is a pick-one over the numbered steps of a plan. |
| `evidence.line_id` | `[{section}.{i}]` |  |  | How a pack line is labelled so an answer can cite it: {section} the section name, {i} the line number starting at 1. |
| `evidence.log` | `logs/jev-evidence.ndjson` |  |  | One row per evidence-gate decision (asked, skipped for insufficient evidence, decided by a rule, over the daily cap), relative to the anti-hall home directory. Each row names the facts that were present and the required ones that were missing. Empty turns the rows off. |
| `evidence.log_max_bytes` | `1048576` |  |  | The evidence log is emptied before a row that would take it past this size. |
| `evidence.plan_line` | `{n} [{status}] {text}` |  |  | How one plan step is written in the evidence pack: {n} the step number, {status} its status, {text} its text. |
| `evidence.ref_key` | `evidence_ref` |  |  | The field of a Haiku reply that names the evidence line it rests on. |
| `evidence.stepmap_doing_status` | `doing` |  |  | The status word of a plan step that is in progress. |
| `evidence.stepmap_sequence_words` | `7 items` |  |  | Words that make a summary span more than one step, so the single in-progress step is not assumed (design card 4.6). |
| `evidence.system_prompt` | `You judge one decision for a supervisor of coding agents. You are given a QUE...` |  |  | System prompt of a direct Haiku evidence call. The answer must name the pack line it rests on; an answer whose line does not exist is discarded. |
| `evidence.timeout_ms` | `25000` |  | ms | How long a direct Haiku evidence call may take. These calls run supervisor-side and never inside a hook that blocks. |
| `evidence.token_min_len` | `3` |  |  | Shortest word (in characters) that counts when a summary is compared with a step's text for overlap. |
| `evidence.unreported` | `none` |  |  | What an earlier summary that reported no step shows in place of the step number. |
| `evidence.usage` | `usage: ah-engine jev evidence < pack.json  (one JSON object per line: id, fac...` |  |  | The usage line of `ah-engine jev evidence` when its input is missing or malformed. |
| `evidence.words` | `21 entries` |  |  | The words the evidence gate uses in its result and log rows: phases (rule, skipped, asked), sources (jev, haiku, rule, none), the skip reasons and the answer shapes. |

### jev_sweep.toml / job

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `job.jev_sweep` | `11 entries` |  |  | Gather the evidence of each live child workspace and put the supervisor's Jev questions (is a quiet child stuck or waiting, is it looping, which plan step does a summary describe) through the evidence gate. Runs as a subprocess so a timeout kills it and every model call it started; 0 turns it off. The modes of the three integrations decide whether any child is looked at. |

### jev_sweep.toml / schedule

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `schedule.jev_sweep_ms` | `900000` | `AH_ENGINE_JEV_SWEEP_MS` | ms | Interval of the jev_sweep job; 0 turns it off. |

### jev_sweep.toml / sweep

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `sweep.ci` | `5 entries` |  |  | The CI runs of the child's branch ({branch}), asked of the GitHub CLI; off when enabled is false or the command is missing, and then the ci_running fact is simply absent. running_statuses: run statuses that mean still running. Output is JSON with these fields. |
| `sweep.duration` | `3 entries` |  |  | Duration units: minutes in an hour and hours in a day, and the largest value shown in the smaller unit before the next is used (the same rule as the plan's own duration text). |
| `sweep.env` | `2 entries` |  |  | Environment variables that override a sweep setting the plugin's settings file also holds (the sweep reads the environment only): held_partitions is a comma-separated list of workspace ids the owner holds (never asked about); step_stall_min is the minutes without step progress after which a child is quiet (it replaces limits.step_stall_ms when it is a number of at least 1). |
| `sweep.git` | `4 entries` |  |  | Read-only git commands run in the child's worktree ({wt}); {branch} is the branch name the second one printed. log prints one commit per line as <epoch seconds><log_sep><subject>. timeout_ms bounds each. |
| `sweep.integrations` | `devswarmWaitKind, devswarmLoop, devswarmStepMap` |  |  | The integrations the sweep gathers evidence for, in the order they are decided. |
| `sweep.limits` | `19 entries` |  |  | Bounds of one sweep. step_stall_ms: a child with no step progress this long is quiet (WaitKind) and one on the same step for loop_factor times it is a loop candidate. lookback_min: how far back repeated commands, errors and owner prompts are counted. tool_tail, text_tail: tool calls and assistant texts put in the pack. tail_bytes: the end of the transcript that is read. arg_cap, text_cap, err_cap, msg_cap: characters kept of a tool argument, an assistant text, an error and a mesh message. max_children: children examined per sweep. reask_ms: a question whose subject has not changed is not asked again before this. max_steps_map: a plan with more steps is not asked about. step_match_ms: a summary sent with a step belongs to the step whose own timestamp is within this of it. commit_lookback: commits read from git. mesh_sent: the newest messages the child sent that are read. |
| `sweep.paths` | `10 entries` |  |  | Where the sweep reads, relative to the anti-hall home directory unless noted: plans (one JSON per child), workspaces (descriptors), archived (archive records), store (per-repo mesh stores), state (the sweep's own re-ask memory); transcripts is relative to the user home, and the transcript of a child is <transcripts>/<its worktree path with / \ : . replaced by the dash>/<session id><transcript_ext>. |
| `sweep.transcript` | `7 entries` |  |  | How a transcript line is read. arg_keys: the tool input fields tried in order for the one-line argument of a tool call. edit_tools: tools that edit a file (their file_path field is counted). revert_patterns: a command containing one counts as a revert. background_tools: tools that start a background job. usage_limit_patterns: a recent assistant text or tool error containing one (case-insensitive) means the child is paused on a usage limit. skip_prompt_prefixes: user lines that start this way are not owner prompts. task_note_prefix: a user line that starts this way is a background-task notification. |
| `sweep.words` | `16 entries` |  |  | The words the sweep writes into evidence lines and its result. line_tool: {ago} {name} {arg}. line_text: {ago} {text}. line_msg: {ago} {dir} {ask} {text}. line_ci: {name} {status} {ago}. line_repeat: {cmd} {n}. line_error: {text}. line_commit: {ago} {subject}. line_summary: {ago} {text}. dir_out and dir_in: the direction words of a mesh line; ask: written when the message asked for a reply. dur_m, dur_h, dur_d: the duration suffixes (minutes, hours, days); plan_state_done, plan_state_doing: the status words a plan step uses. result keys are fixed. |

### dispatch.toml / dispatch

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `dispatch.blocking_decisions` | `2 entries` |  |  | JSON fields and values that block without exit 2: a top-level decision, or a hookSpecificOutput permissionDecision. |
| `dispatch.context_cap` | `2 entries` |  |  | Per host, the characters of one hook's additionalContext the host delivers inline (Claude: 10000, documented at code.claude.com/docs/en/hooks; over it the host spills the whole value to a file and leaves a ~2000 character preview). The dispatcher joins several hooks' contexts into one value, so a join over the cap is logged as dispatch_context_over_cap; the host then spills it the way it spills any over-cap hook output, and nothing is cut by the engine. Codex documents its cap in tokens; the same count is a conservative proxy. |
| `dispatch.context_joiner` | `\n\n` |  |  | Text placed between the additionalContext values of several hooks when they are joined into one. |
| `dispatch.decision_precedence` | `deny, defer, ask, allow` |  |  | PreToolUse permissionDecision values, strongest first: the combined decision is the strongest any hook returned (Claude docs: deny > defer > ask > allow). |
| `dispatch.default_host` | `claude` |  |  | The host whose table is used when `--host` is not given. |
| `dispatch.default_timeout_s` | `600` |  | s | The timeout of a Node hook whose hooks.json entry has none (0 in the table): the host's own default for a command hook (600 s on Claude per docs/KB-claude-code-hooks.md; Codex's default is not verified here, so the same bound is used). Never zero: a zero timeout would kill the hook at its first poll. |
| `dispatch.defer_exit` | `75` |  |  | Exit code with which the dispatcher asks its wrapper to run the event's Node hooks one by one, as the host does (the joined output could not be delivered faithfully). EX_TEMPFAIL; the host reads it as a non-blocking hook error and shows stderr, so without a wrapper the deferral is visible, never silent. |
| `dispatch.exact_chars` | `_- ,\|` |  |  | Besides letters and digits, the characters a Claude matcher may contain and still be an exact name or list. |
| `dispatch.fallback_lists` | `2 entries` |  |  | Per host, the wrapper's fallback list relative to the plugin root (the same files as dispatch.generated_files): a defaults load is rejected when a list runs hooks for an event the table has no row for, and the dispatcher answers an event without a row with the neutral no-op only when this list marks it as a thin trigger. |
| `dispatch.gen_default_kind` | `hooks` |  |  | The file `gen-hooks` prints when `--kind` is not given. |
| `dispatch.generated_files` | `2 entries` |  |  | Per host and kind of generated file (hooks, registry, list, map), its path relative to the repository root. `tests/hooks_files.rs` requires each committed file to equal what `gen-hooks` prints and `ah-gen-fallback-list` writes them. |
| `dispatch.guard_events` | `PreToolUse, PermissionRequest, Stop, SubagentStop` |  |  | Events whose hooks can block (guards): PreToolUse and PermissionRequest decide a tool call (Claude ignores exit 2 on PermissionRequest, so a fail-closed exit 2 there is harmless, and the event stays listed so a hook registered on it later is guarded from the start), Stop and SubagentStop can refuse to let the agent finish. When the dispatcher cannot run the Node hook of such an event it fails CLOSED (exit 2 with dispatch.msg_fail_closed): a deferral there must never read as an allow (D74). |
| `dispatch.hooks_claude_PostToolUse` | `8 items` |  |  | The claude PostToolUse hook entries, in dispatch order. |
| `dispatch.hooks_claude_PostToolUseFailure` | `5 entries` |  |  | The claude PostToolUseFailure hook entries, in dispatch order. |
| `dispatch.hooks_claude_PreCompact` | `5 entries` |  |  | The claude PreCompact hook entries, in dispatch order. |
| `dispatch.hooks_claude_PreToolUse` | `21 items` |  |  | The claude PreToolUse hook entries, in dispatch order. |
| `dispatch.hooks_claude_SessionEnd` | `5 entries` |  |  | The claude SessionEnd hook entries, in dispatch order. |
| `dispatch.hooks_claude_SessionStart` | `17 items` |  |  | The claude SessionStart hook entries, in dispatch order. |
| `dispatch.hooks_claude_Stop` | `12 items` |  |  | The claude Stop hook entries, in dispatch order. |
| `dispatch.hooks_claude_SubagentStart` | `5 entries` |  |  | The claude SubagentStart hook entries, in dispatch order. |
| `dispatch.hooks_claude_SubagentStop` | `5 entries` |  |  | The claude SubagentStop hook entries, in dispatch order. |
| `dispatch.hooks_claude_TaskCompleted` | `5 entries` |  |  | The claude TaskCompleted hook entries, in dispatch order. |
| `dispatch.hooks_claude_TaskCreated` | `5 entries` |  |  | The claude TaskCreated hook entries, in dispatch order. |
| `dispatch.hooks_claude_UserPromptSubmit` | `8 items` |  |  | The claude UserPromptSubmit hook entries, in dispatch order. |
| `dispatch.hooks_codex_PostToolUse` | `5 entries, 5 entries, 5 entries, 5 entries` |  |  | The codex PostToolUse hook entries, in dispatch order. |
| `dispatch.hooks_codex_PreCompact` | `5 entries` |  |  | The codex PreCompact hook entries, in dispatch order. |
| `dispatch.hooks_codex_PreToolUse` | `9 items` |  |  | The codex PreToolUse hook entries, in dispatch order. |
| `dispatch.hooks_codex_SessionStart` | `16 items` |  |  | The codex SessionStart hook entries, in dispatch order. |
| `dispatch.hooks_codex_Stop` | `11 items` |  |  | The codex Stop hook entries, in dispatch order. |
| `dispatch.hooks_codex_SubagentStop` | `5 entries` |  |  | The codex SubagentStop hook entries, in dispatch order. |
| `dispatch.hooks_codex_UserPromptSubmit` | `8 items` |  |  | The codex UserPromptSubmit hook entries, in dispatch order. |
| `dispatch.in_process` | `0` | `AH_ENGINE_DISPATCH_IN_PROCESS` |  | Run the built-in checks inside the hook client (1) instead of asking the daemon (0, the default). |
| `dispatch.list_banner` | `# Generated from the dispatch table by `ah-engine gen-hooks`. Event rows are:...` |  |  | The first line of the generated fallback list. |
| `dispatch.list_comment_mark` | `#` |  |  | The mark that starts a comment line of the generated fallback list. |
| `dispatch.list_empty_word` | `empty` |  |  | The word that marks an event row of the fallback list whose event has no table entry (a thin trigger only): the wrapper answers it with the neutral no-op. |
| `dispatch.list_event_mark` | `@` |  |  | The mark that starts an event row of the generated fallback list (the wrapper reads the same mark). |
| `dispatch.list_separators` | `\|,` |  |  | Characters that separate the names of an exact-list matcher. |
| `dispatch.match_all` | `, *` |  |  | Matcher values that match every occurrence of the event. |
| `dispatch.matcher_field` | `9 entries` |  |  | Per event, the payload field a matcher is tested against; on an event not listed here the matcher is ignored. |
| `dispatch.matcher_mode` | `2 entries` |  |  | Per host, how a matcher is read: exact_or_regex (Claude: only letters, digits and the exact_chars is an exact name or a list split on \| and comma, anything else an unanchored regex) or regex (Codex: always an unanchored regex). |
| `dispatch.max_timeout_s` | `86400` | `AH_ENGINE_DISPATCH_MAX_TIMEOUT_S` | s | An upper bound on any Node hook's timeout, whatever its hooks.json entry says (the default is above every real timeout, so it changes nothing; tests lower it to exercise a hook that never exits). |
| `dispatch.message_joiner` | `\n` |  |  | Text placed between the systemMessage values of several hooks when they are joined into one. |
| `dispatch.msg_bad_map` | `cannot read the fallback map {path}: {err}` |  |  | Error printed when the `--fallback-map` file cannot be read as a JSON object of events to hook ids to commands. |
| `dispatch.msg_conflict` | `hooks {ids} returned outputs that cannot be combined into one` |  |  | Reason logged when several hooks returned output one hook output cannot combine. |
| `dispatch.msg_context_over_cap` | `joined context is {len} characters, over the {cap} the host delivers inline` |  |  | Event-log detail when the joined additionalContext of an event is over the host's inline cap. |
| `dispatch.msg_defer` | `dispatcher deferred the whole call: {why}` |  |  | Event-log detail when the dispatcher cannot answer an event and defers the whole call. |
| `dispatch.msg_defer_separately` | `anti-hall: the joined {event} context is {len} characters, over the {cap} the...` |  |  | Printed on stderr with dispatch.defer_exit when the joined output is over the host's cap. Placeholders: {event}, {len}, {cap}. |
| `dispatch.msg_fail_closed` | `anti-hall: the engine could not run the guards for {event} ({why}). The call ...` |  |  | Printed on stderr (exit 2) when a guard event's Node hooks cannot run. Placeholders: {event}, {why}. |
| `dispatch.msg_fail_closed_stop` | `anti-hall: the engine could not run the guards for {event} ({why}). The agent...` |  |  | Printed on stderr (exit 2) when a Stop or SubagentStop cannot run its guards and the block is still within dispatch.stop_block_cap. Placeholders: {event}, {why}. |
| `dispatch.msg_hook_died` | `the hook was killed by a signal or could not be waited for` |  |  | Event-log detail when a Node hook was killed by a signal or could not be waited for. |
| `dispatch.msg_hook_spawn` | `the hook's command could not be started: {errno} {err}` |  |  | Event-log detail when a Node hook's command could not be started (the event code is the hook id). Placeholders: {errno} (os<n>, the OS error number), {err} (its text). |
| `dispatch.msg_hook_timeout` | `the hook ran past its timeout and was killed; the host discards a timed-out hook` |  |  | Event-log detail when a Node hook was still running at its timeout and was killed with its group (the host discards such a hook, so the call goes on). |
| `dispatch.msg_infra_defer` | `anti-hall: the engine could not dispatch {event} ({why}); the Node hooks decide` |  |  | Printed on stderr with dispatch.defer_exit when an infrastructure fault (a hook the OS would not start, an unreadable payload or fallback map, a usage error, the event's budget spent) keeps the dispatcher from deciding: the wrapper then runs the Node hooks. Placeholders: {event}, {why}. |
| `dispatch.msg_no_fallback` | `entry {id} deferred with no runnable Node command` |  |  | Reason logged when a deferred hook entry has no runnable Node command. |
| `dispatch.msg_no_row` | `the dispatch table has no well-formed row for {host} {event}: the Node hooks ...` |  |  | Deferral reason when the dispatch table has no well-formed row for an event the fallback list does not mark as a thin trigger. Placeholders: {host}, {event}. |
| `dispatch.msg_panic` | `the dispatcher hit an internal error: the Node hooks decide` |  |  | Deferral reason (event log and stderr) when the dispatcher panicked on a guard event: the Node hooks answer instead of a block. |
| `dispatch.msg_skipped_entry` | `entry {id} skipped: no runnable Node command` |  |  | Event-log detail when a non-guard event goes on without an entry that has no runnable Node command. Placeholder: {id}. |
| `dispatch.msg_skipped_entry_stderr` | `anti-hall: skipped {event} Node hook {id}: no runnable Node command` |  |  | Printed on stderr when a non-guard event goes on without an entry that has no runnable Node command. Placeholders: {event}, {id}. |
| `dispatch.msg_spool_sweep` | `removed {n} stale dispatch stdin spool file(s)` |  |  | Event-log detail when stale named raw-payload spool files were removed. Placeholder: {n}. |
| `dispatch.msg_stdin_over_cap` | `the hook payload is larger than {max} bytes; built-in checks are skipped and ...` |  |  | Event-log detail when the payload on stdin is longer than client.max_stdin and is sent to Node hooks through an anonymous open file. Placeholder: {max}. |
| `dispatch.msg_stop_active` | `anti-hall: the engine could not run the guards for {event} ({why}), and a Sto...` |  |  | Printed on stderr (exit 0) when a Stop or SubagentStop would fail closed but the host says a Stop hook already blocked this turn (stop_hook_active). Placeholders: {event}, {why}. |
| `dispatch.msg_stop_capped` | `anti-hall: the engine could not run the guards for {event} ({why}) {cap} time...` |  |  | Printed on stderr (exit 0) when a Stop or SubagentStop would fail closed once more than dispatch.stop_block_cap times in a row. Placeholders: {event}, {cap}, {why}. |
| `dispatch.msg_stop_uncounted` | `anti-hall: the engine could not run the guards for {event} ({why}) and cannot...` |  |  | Printed on stderr (exit 0) when a Stop or SubagentStop would fail closed but the consecutive-block count cannot be recorded, so the loop could not be bounded. Placeholders: {event}, {why}. |
| `dispatch.msg_unknown_host` | `unknown host {host}: the dispatch table has {hosts}` |  |  | Error printed when `--host` names a host the dispatch table does not have. |
| `dispatch.msg_unknown_kind` | `unknown kind {kind}: gen-hooks prints hooks, registry, list or map` |  |  | Error printed by `gen-hooks` when `--kind` names a file it does not generate. Placeholder: {kind}. |
| `dispatch.msg_why_died` | `hook {id} was killed before it could answer` |  |  | Reason in dispatch.msg_fail_closed when a guard event's Node hook was killed by a signal. Placeholder: {id}. |
| `dispatch.msg_why_incomplete` | `hook {id} finished with incomplete output` |  |  | Reason in dispatch.msg_fail_closed when a guard event's Node hook finished but a process it left behind kept its output open, so the output is incomplete. Placeholder: {id}. |
| `dispatch.msg_why_spawn` | `hook {id} could not be started` |  |  | Reason in dispatch.msg_infra_defer when a guard event's Node hook could not be started (EAGAIN, EMFILE, ENOMEM: the Node hooks then decide). Placeholder: {id}. |
| `dispatch.payload_hash_checks` | `verify-first` |  |  | Built-in checks whose Node hook derives something from the exact stdin bytes (verify-first rotates its reminder by the SHA-1 of the whole payload): the dispatcher hands these the SHA-1 of the raw payload, computed only when one of them is selected. |
| `dispatch.plain_context_events` | `UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch` |  |  | Events on which plain-text stdout (exit 0) is context for the model (docs/KB-claude-code-hooks.md: UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch). When the dispatcher must deliver such text next to a hook's JSON it folds it into the merged additionalContext instead of moving it to stderr, where the model would not see it. |
| `dispatch.poll_ms` | `2` |  | ms | How often the dispatcher checks whether its Node hooks have finished. |
| `dispatch.read_ms` | `2000` |  | ms | How long the dispatcher waits for a finished Node hook's output pipes to drain. |
| `dispatch.reason_joiner` | `\n\n` |  |  | Text placed between the block reasons of several hooks that block the same event, when they are joined into the one block the dispatcher answers (the host shows the model every hook's block reason; Claude Code gives each Stop/SubagentStop block its own message). |
| `dispatch.rerun_reserve_ms` | `5000` |  | ms | The least host time that must be left (the event's longest hooks.json timeout minus the time the dispatcher has used) for a spent budget to defer to the wrapper's Node rerun (dispatch.defer_exit). With less left the rerun would be killed by the host, which treats a timed-out hook as an allow, so a guard event fails closed instead. |
| `dispatch.root_vars` | `2 entries` |  |  | Per host, the environment variables that hold the plugin root, first set one wins; the host exports them to hook commands, a command naming an unset one cannot run, and a built-in check gets the root as its plugin_root. |
| `dispatch.shell` | `/bin/sh, -c` |  |  | The shell a Node hook command runs under, with its command flag (hooks.json commands are shell-form strings). |
| `dispatch.spool_stale_s` | `1800` |  | s | Age at which a named raw-payload stdin spool file from an older build or unlink failure is considered stale and removed. Keep this larger than the longest hook timeout. |
| `dispatch.stop_block_cap` | `2` |  |  | How many consecutive fail-closed blocks a Stop or SubagentStop may answer in one session before every later one fails open with a log (the count resets when the guards run fine again). |
| `dispatch.stop_events` | `Stop, SubagentStop` |  |  | Guard events whose exit 2 keeps the agent running instead of denying one call (Stop, SubagentStop). A fail-closed block there must be bounded, or an agent whose hooks cannot run could never finish: the payload's stop_hook_active true fails open, and so do more than dispatch.stop_block_cap consecutive fail-closed blocks in one session (the Node Stop hooks make the same stop_hook_active check). |
| `dispatch.stop_state_dir` | `stop-blocks` |  |  | The directory under the state dir holding one consecutive-block counter file per event and session. |
| `dispatch.stop_state_max_age_days` | `7` |  | days | Counter files of the Stop block counter older than this many days are removed (a session that ended while its guards were failing leaves one behind). |
| `dispatch.stop_unknown_session` | `unknown` |  |  | Counter key for a Stop whose payload names no session (unreadable or cut off). |
| `dispatch.thin_command` | `sh "${{var}}/hooks/ah-hook.sh" {event}{extra}` |  |  | The command of each event's thin trigger in the generated hooks.json (D87). Placeholders: {var} the host's plugin-root variable (the first of dispatch.root_vars), {event} the event, {extra} the host's dispatch.thin_host_args. |
| `dispatch.thin_events` | `2 entries` |  |  | Per host, the events that get a thin trigger in the generated hooks.json besides the events the table has entries for (D87; WorktreeCreate and WorktreeRemove are excluded on Claude because a hook there replaces the operation and cannot be a silent trigger). |
| `dispatch.thin_host_args` | `2 entries` |  |  | Per host, the extra arguments of the thin trigger's command: the wrapper reads the host's table and fallback list from `--host` (Claude is the wrapper's default). |
| `dispatch.thin_timeout_s` | `10` |  | s | The timeout of the thin trigger of an event the table has no entry for (an event with entries takes the longest timeout among them). |
| `dispatch.tool_aliases` | `2 entries` |  |  | Per host, extra names a tool also answers to when matching (Codex: matcher values Edit and Write also match apply_patch). |

### hooks.toml / hooks

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `hooks.cfg_default_label` | `default` |  |  | The `cfg` label of the dispatch_entries metric when the hook configuration is the shipped default. |
| `hooks.entry_enabled` | `true` |  |  | Default of `enabled` in `[entries.<id>]`: whether the entry runs (false is the same as mode = off; on a guard entry only allowed when it has a built-in check). |
| `hooks.entry_fields` | `enabled, mode, when` |  |  | The fields an `[entries.<id>]` section may hold. |
| `hooks.entry_mode` | `on` |  |  | Default of `mode` in `[entries.<id>]`: on, shadow (runs and is logged, never changes the outcome) or off (skipped). On a guard-event entry shadow and off are allowed only when the entry has a built-in check, whose Node hook then stays the real decider. |
| `hooks.entry_when` | `0 entries` |  |  | Default of `when` in `[entries.<id>]`: no predicate (the entry applies whenever its matcher does). A table row may carry its own `when`, and `[entries.<id>] when` overrides it (not on a guard entry). |
| `hooks.event_budget_ms` | `0` |  | ms | Default of `budget_ms` in `[events.<Event>]`: the wall budget of one occurrence of the event (0 = none). Once it has passed the engine starts no further entry, lets the ones already running finish within their own timeouts, and on a guard event (unless a hook that ran blocked) hands the event to the wrapper's Node hooks with dispatch.defer_exit while no Node hook has started and no built-in check has answered (a spent budget is a slow machine, not a verdict); once one has, the wrapper's rerun would repeat it, so the event fails closed instead. |
| `hooks.event_enabled` | `true` |  |  | Default of `enabled` in `[events.<Event>]`: whether the event is used at all (false is the same as mode = off). |
| `hooks.event_fields` | `enabled, mode, max_rules, budget_ms, order` |  |  | The fields an `[events.<Event>]` section may hold. |
| `hooks.event_max_rules` | `0` |  | entries | Default of `max_rules` in `[events.<Event>]`: the most entries evaluated per occurrence of the event (0 = all). The entries after the first max_rules, in order, are skipped and counted as skipped (max_rules). Not allowed above 0 on a guard event. |
| `hooks.event_mode` | `on` |  |  | Default of `mode` in `[events.<Event>]`: on (the event's entries decide), shadow (they run and are logged but never change the outcome) or off (the event is skipped and answered with the neutral no-op). |
| `hooks.event_order` | `` |  |  | Default of `order` in `[events.<Event>]`: entry ids that run and combine before the others, in this order (empty = the table's order). An id the event's table does not have is a config error. |
| `hooks.modes` | `on, shadow, off` |  |  | The values `mode` may take, in `[events.<Event>]` and `[entries.<id>]`. |
| `hooks.msg_budget` | `the event's budget passed before {id} could run` |  |  | Why a guard event is handed to the Node hooks (dispatch.defer_exit) when its budget_ms has passed before an entry could start. Placeholder: {id}. |
| `hooks.msg_cfg_bad_mode` | `mode {value} is not one of {allowed}` |  |  | Config error detail: `mode` is not one of hooks.modes. Placeholders: {value}, {allowed}. |
| `hooks.msg_cfg_bad_type` | `{field} must be {expected}` |  |  | Config error detail: a field has the wrong type. Placeholders: {field}, {expected}. |
| `hooks.msg_cfg_guard_entry` | `{id} decides on guard event {event} only through its Node hook, so {what} wou...` |  |  | Config error detail: an entry of a guard event has no built-in check, so its Node hook is its only decider and must keep running. Placeholders: {id}, {event}, {what}. |
| `hooks.msg_cfg_guard_event` | `{event} is a guard event and cannot be configured into a silent allow ({what})` |  |  | Config error detail: a guard event (PreToolUse, PermissionRequest, Stop, SubagentStop) was configured so a guard could silently allow. Placeholders: {event}, {what}. |
| `hooks.msg_cfg_guard_when` | `{id} is a guard entry of {event}: its `when` can only come from the dispatch ...` |  |  | Config error detail: a `when` override on a guard entry. Placeholders: {id}, {event}. |
| `hooks.msg_cfg_project_guard` | `a project file may not configure guard events or their entries ({what})` |  |  | Config error detail: the project file names a guard event or guard entry. Placeholders: {what}. |
| `hooks.msg_cfg_range` | `{field} = {value} is outside {min} to {max}` |  |  | Config error detail: a number is outside its bounds. Placeholders: {field}, {value}, {min}, {max}. |
| `hooks.msg_cfg_unknown_entry` | `{id} is not an entry of the dispatch table` |  |  | Config error detail: `[entries.<id>]` names an entry no host's table has. Placeholder: {id}. |
| `hooks.msg_cfg_unknown_event` | `{event} is not an event of the dispatch table` |  |  | Config error detail: `[events.<Event>]` names an event neither host's table or thin trigger list has. Placeholder: {event}. |
| `hooks.msg_cfg_unknown_field` | `{field} is not a field here (allowed: {allowed})` |  |  | Config error detail: a section holds a field it does not have. Placeholders: {field}, {allowed}. |
| `hooks.msg_cfg_unknown_order` | `order names {id}, which the {event} table does not have` |  |  | Config error detail: `order` names an id the event's table does not have. Placeholders: {id}, {event}. |
| `hooks.msg_plan_event` | `cfg={cfg} ran=[{ran}] skipped_predicate=[{predicate}] skipped_max_rules=[{max...` |  |  | Event-log detail of a dispatch that skipped, shadowed or cut entries. Placeholders: {cfg} the config hash, {ran}, {predicate}, {max_rules}, {budget}, {shadowed}, {off}: comma lists of entry ids. |
| `hooks.msg_shadow_event` | `{id} agree={agree} engine_exit={engine} node_exit={node}` |  |  | Event-log detail when a shadowed built-in check's answer is compared with the Node hook that decided. Placeholders: {id}, {agree}, {engine}, {node}. |
| `hooks.msg_when_bad_pointer` | `the pointer {pointer} must start with /` |  |  | Config error detail: a `field` condition's JSON pointer does not start with a slash. Placeholder: {pointer}. |
| `hooks.msg_when_bad_regex` | `the regex {pattern} is invalid: {err}` |  |  | Config error detail: a condition's regular expression does not compile. Placeholders: {pattern}, {err}. |
| `hooks.msg_when_bad_session` | `bad session condition: {what}` |  |  | Config error detail: a `session` condition is malformed. Placeholders: {what}. |
| `hooks.msg_when_bad_value` | `bad condition value: {what}` |  |  | Config error detail: a condition holds a value it cannot use. Placeholders: {what}. |
| `hooks.msg_when_depth` | `a predicate may nest at most {max} levels` |  |  | Config error detail: a `when` predicate nests deeper than allowed. Placeholder: {max}. |
| `hooks.msg_when_env_not_forwarded` | `{name} is not in request_env.allow, so the request never carries it` |  |  | Config error detail: an `env` condition names a variable the request environment does not carry (request_env.allow), so it could never be set. Placeholder: {name}. |
| `hooks.msg_when_unknown_fact` | `{name} is not a transcript fact (allowed: {allowed})` |  |  | Config error detail: a `transcript` condition names a fact the index does not expose. Placeholders: {name}, {allowed}. |
| `hooks.msg_when_unknown_kind` | `a condition needs exactly one of {allowed}, found: {found}` |  |  | Config error detail: a `when` condition names no condition kind, or more than one. Placeholders: {found}, {allowed}. |
| `hooks.msg_when_unknown_op` | `a condition needs exactly one test of {allowed}, found: {found}` |  |  | Config error detail: a leaf condition has no test, or more than one. Placeholders: {found}, {allowed}. |
| `hooks.msg_when_unknown_setting` | `{key} is not a setting the engine has loaded` |  |  | Config error detail: a `setting` condition names a setting the engine's loaded settings do not have. Placeholder: {key}. |
| `hooks.outcomes` | `ran, skipped_predicate, skipped_max_rules, skipped_budget, shadowed, off` |  |  | The words the telemetry uses for what happened to a table entry in one dispatch, in this order: ran, skipped_predicate (its `when` was false), skipped_max_rules (cut by max_rules), skipped_budget (the event's budget had passed), shadowed (ran, never changed the outcome) and off (configured off, or a guard entry's engine check turned off so its Node hook decides). |
| `hooks.project_file` | `.anti-hall/engine.toml` |  |  | The project-level hook configuration file, relative to the payload's cwd; read when it exists, below the user file in precedence. It may not configure guard events or guard entries. |
| `hooks.reasons` | `23 entries` |  |  | Short reasons the config errors above quote in their {what} placeholder. |
| `hooks.session_max_keys` | `4096` |  |  | The most session-condition counters kept at once; past it the oldest are dropped (a dropped counter starts again, which only makes its condition fire sooner). |
| `hooks.session_ops` | `first, every, at_least` |  |  | The per-session counters a `session` condition may use: first (true the first time per session within the TTL), every (true on the 1st, then every Nth evaluation: a once-per-N-turns dedupe) and at_least (true once the evaluation count in the session reaches N). |
| `hooks.session_ttl_s` | `3600` |  | s | How long the engine keeps a `session` condition's state after its last evaluation (a condition's own `ttl_s` overrides it). |
| `hooks.transcript_facts` | `9 entries` |  |  | The transcript-index facts a `transcript` condition may read, with their types (int, bool or str). Only facts the index already computes: records, compact_boundaries, sidechain_rows, meta_rows (counts), has_last_prompt and has_last_assistant (whether the index holds them), last_tool (the newest tool use's name), terminal_agents (background agents with a terminal notification) and unresolved_agents (agents a compaction re-injected as live that no terminal notification closed). |
| `hooks.when_kinds` | `9 items` |  |  | The condition kinds a `when` predicate may be built from: the combinators all, any and not (over other conditions), and the leaf kinds tool (the payload's tool name), field (a JSON pointer into the payload), setting (a boolean or enum of the engine's loaded settings), env (a variable of the request environment) , session (per-session state the engine keeps in memory) and transcript (a fact of the transcript index). |
| `hooks.when_max_depth` | `8` |  |  | How deep combinators (all, any, not) may nest in one `when` predicate. |
| `hooks.when_ops` | `7 items` |  |  | The tests a leaf condition may apply to its value (exactly one per condition): equals, in (a list), regex (unanchored), glob (`*` within a path segment, `**` across segments, `?` one character), exists (true or false), at_least and at_most (integers). |

### verify_first.toml / fable_availability

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `fable_availability.access_list` | `4 entries` |  |  | Config key holding the model access list, and the field of each entry that names the model. |
| `fable_availability.config_file` | `.claude.json` |  |  | The host's own config file, relative to the home directory, that holds the model cache. |
| `fable_availability.guard_name` | `fable-availability` |  |  | The guard id used in the availability message. |
| `fable_availability.msg_instead` | `pass args.fableAvailable=true into ship-it/deadly-loop Workflow invocations s...` |  |  | Do-instead line of the availability message. |
| `fable_availability.msg_what` | `Fable is available this session (per ~/.claude.json).` |  |  | First line of the availability message. |
| `fable_availability.msg_why` | `Fable routing is re-enabled per MODEL-POLICY.md (2026-07-12); revisit if Fabl...` |  |  | Why line of the availability message. |
| `fable_availability.needle` | `fable` |  |  | Lower-case text a model name must contain to count as a Fable model. |
| `fable_availability.options_list` | `4 entries` |  |  | Config key holding the extra model options, the fields of each entry that may name the model, and the flag that disables an entry. |
| `fable_availability.state_file` | `.anti-hall/fable-availability.json` |  |  | The state file this check writes, relative to the home directory. |
| `fable_availability.summary` | `SessionStart: records whether a Fable model is available (from the host's mod...` |  |  | One-line description of the fable-availability check in the generated reference. |
| `fable_availability.unknown_source` | `unknown` |  |  | The source recorded when the model cache says nothing about Fable. |

### verify_first.toml / verify_first

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `verify_first.abs_marker` | `<abs>` |  |  | Placeholder in the compact protocol texts that is replaced by the plugin root directory. |
| `verify_first.child_branch_env` | `DEVSWARM_SOURCE_BRANCH` |  |  | Environment variable that is non-empty in a DevSwarm child workspace (devswarm-role.js isChildWorkspace). |
| `verify_first.child_note` | `You are a subagent inside a DevSwarm child workspace: do NOT run devswarm.js ...` |  |  | The note a subagent gets when the session is a DevSwarm child workspace (CHILD_WORKSPACE_MAILBOX_NOTE). |
| `verify_first.codex_transcript_patterns` | `(^\\|[\\/])rollout-[^\\/]*\.jsonl$, [\\/]\.codex[\\/]` |  |  | Regexes (JavaScript syntax) over transcript_path that mark a Codex payload (auto-handover-text.js detectPlatform): a rollout file name, or a .codex directory. |
| `verify_first.compact_session` | `ANTI-HALL VERIFY-FIRST (re-sent at session start and after compaction). Full ...` |  |  | The compact SessionStart protocol; each <abs> is replaced by the plugin root directory (coreCompactSession). |
| `verify_first.compact_subagent` | `ANTI-HALL VERIFY-FIRST. Full protocol: <abs>/PROTOCOL.md - Read it when a rul...` |  |  | The compact subagent protocol before the WORKER line; each <abs> is replaced by the plugin root directory (coreCompactSubagent). |
| `verify_first.full_claude` | `VERIFY-FIRST + ROOT-CAUSE PROTOCOL (re-stated so it survives context growth a...` |  |  | The verify-first protocol a Claude session receives at SessionStart when context.protocolLevel is full (verify-first-core.js CORE_FULL then DISCIPLINES_INDEX, joined by newlines, byte for byte). |
| `verify_first.full_codex` | `VERIFY-FIRST + ROOT-CAUSE PROTOCOL (re-stated so it survives context growth a...` |  |  | The same full text for a Codex session (DISCIPLINES_INDEX_CODEX in place of DISCIPLINES_INDEX). |
| `verify_first.guard_subagent` | `verify-first-subagent` |  |  | The guard id verify-first-subagent answers to in skip.json. |
| `verify_first.judge_child_env` | `2 entries` |  |  | Environment variable that marks the headless judge child; a hook that runs in it prints nothing. |
| `verify_first.mn_line` | `M/N. Workers do not re-delegate; read-only research -> Explore; 3+ parallel/n...` |  |  | The model-routing and no-re-delegation line the compact SessionStart text gains when the orchestration hook is switched off (Claude). |
| `verify_first.mn_line_codex` | `M/N. Workers do not re-delegate; read-only research -> a read-only sub-agent;...` |  |  | The same line for a Codex session. |
| `verify_first.root_probe` | `hooks/verify-first-core.js` |  |  | File under the plugin root whose real location gives the plugin root, the way Node derives it (the directory two levels above hooks/verify-first-core.js, symbolic links resolved). |
| `verify_first.setting_level` | `5 entries` |  |  | Where the protocol size is read from (context.protocolLevel: compact or full, default compact). |
| `verify_first.setting_orchestration` | `6 entries` |  |  | Where the on/off switch of the orchestration hook is read from (context.verifyFirstOrchestration, default on); when off, the compact SessionStart text carries the model-routing line itself. |
| `verify_first.setting_session` | `6 entries` |  |  | Where the on/off switch of verify-first-full is read from (context.verifyFirstSession, default on). |
| `verify_first.setting_subagent` | `6 entries` |  |  | Where the on/off switch of verify-first-subagent is read from (context.verifyFirstSubagent, default on). |
| `verify_first.subagent_full` | `VERIFY-FIRST + ROOT-CAUSE PROTOCOL (re-stated so it survives context growth a...` |  |  | The full protocol a spawned subagent receives when context.protocolLevel is full (CORE_LINES, SUBAGENT_DISCIPLINES, TEAMMATE_REPORTING_NOTE). |
| `verify_first.summary_full` | `SessionStart context: injects the verify-first protocol and discipline index ...` |  |  | One-line description of the verify-first-full check in the generated reference. |
| `verify_first.summary_subagent` | `SubagentStart context: injects the verify-first protocol (compact, or full wh...` |  |  | One-line description of the verify-first-subagent check in the generated reference. |
| `verify_first.worker` | `WORKER: do the task yourself; do not re-delegate unless told to. Your assignm...` |  |  | The WORKER line that follows the compact subagent protocol. |

### prompt_emit.toml / emit_dedupe

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `emit_dedupe.attachment_type` | `hook_additional_context` |  |  | The transcript attachment type the host writes for a delivered hook context. |
| `emit_dedupe.file_prefix` | `dedupe` |  |  | Prefix of a session's state file name (dedupe-<session>.json) and of the sweep stamp. |
| `emit_dedupe.hook_event` | `UserPromptSubmit` |  |  | The hook event whose delivered context counts as a block's delivery. |
| `emit_dedupe.key_ttl_ms` | `86400000` |  | ms | A block key unseen for this long is dropped from the session file when it is next written. |
| `emit_dedupe.max_pending_ms` | `600000` |  | ms | A copy still undelivered after this long (a queued prompt the user cancelled, say) is emitted again. |
| `emit_dedupe.ms_per_minute` | `60000` |  |  | Milliseconds in a minute (converts the window setting and the sweep thresholds). |
| `emit_dedupe.num_window_min` | `6 entries` |  |  | Where the fallback suppression window is read from (context.dedupeWindowMin, minutes, default 20): used when the transcript cannot show whether a block was delivered; 0 turns the whole feature off. |
| `emit_dedupe.prune_stamp_prefix` | `.prune-stamp-` |  |  | Prefix of the stamp file that throttles the sweep of idle session files. |
| `emit_dedupe.prune_throttle_ms` | `21600000` |  | ms | The sweep of idle session files runs at most this often. |
| `emit_dedupe.prune_ttl_ms` | `604800000` |  | ms | A session file not modified for this long is removed by the sweep (never the file of the session being written). |
| `emit_dedupe.reset_key` | `__reset` |  |  | The state key that records the last context loss. |
| `emit_dedupe.segment_sep` | `\n\n` |  |  | How the hooks join their blocks into one additionalContext; a delivery may hold the emitted block as a run of whole segments. |
| `emit_dedupe.session_safe_max` | `128` |  |  | Longest session part of a state file name, in UTF-16 units, after characters outside letters, digits, dot, underscore and hyphen become underscores. |
| `emit_dedupe.state_dir` | `.anti-hall/emit-dedupe` |  |  | The session state directory, relative to the home directory. |
| `emit_dedupe.stats_key` | `__stats` |  |  | The state key that holds the suppression counter doctor reports. |
| `emit_dedupe.summary` | `SessionStart: marks a context loss in the session's emit-dedupe state so the ...` |  |  | One-line description of the emit-dedupe-reset check in the generated reference. |
| `emit_dedupe.sw_enabled` | `5 entries` |  |  | Where the emit-dedupe on/off switch is read from (guards.emitDedupe, default on): off emits every block every time and records nothing. |
| `emit_dedupe.tail_bytes` | `262144` |  | bytes | The first transcript window searched for a block's delivery. |
| `emit_dedupe.tail_bytes_wide` | `4194304` |  | bytes | The wider transcript window searched once when the first has no delivery and the file is larger than it. |
| `emit_dedupe.ts_tolerance_ms` | `1000` |  | ms | How far before a block's own timestamp a transcript attachment may be stamped and still count as its delivery. |
| `emit_dedupe.window_default_ms` | `15000` |  | ms | The fallback window when the setting cannot be read, and the gap that counts as a new turn when the transcript is unusable. |

### prompt_emit.toml / idle_sweep

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `idle_sweep.be_many` | `s are` |  |  | The words after `finished agent` when several agents are idle. |
| `idle_sweep.be_one` | ` is` |  |  | The words after `finished agent` when one agent is idle. |
| `idle_sweep.block_close` | `\n</teammate-message>` |  |  | The end of one teammate message block, with the newline before it. |
| `idle_sweep.block_open` | `<teammate-message teammate_id="` |  |  | The start of one teammate message block, up to its opening quote of the teammate id. |
| `idle_sweep.call_claude` | `TaskStop {"task_id":"{id}"}` |  |  | The call that stops a Claude teammate; {id} is its name. |
| `idle_sweep.call_codex` | `close_agent {"target":"{id}"}` |  |  | The call that closes a Codex agent; {id} is its id. |
| `idle_sweep.codex_arg_keys` | `target, id, agent_id` |  |  | Arguments of an agent tool call that name one agent. |
| `idle_sweep.codex_arg_list_key` | `targets` |  |  | The argument of an agent tool call that names several agents. |
| `idle_sweep.codex_call_names` | `spawn_agent, wait_agent, close_agent, send_input, resume_agent` |  |  | The agent tool calls the scan follows. |
| `idle_sweep.codex_close_call` | `close_agent` |  |  | The call that closes an agent. |
| `idle_sweep.codex_finished_keys` | `completed, errored` |  |  | Keys of a wait_agent status entry that mean the agent finished. |
| `idle_sweep.codex_prefilter` | `_agent, send_input, function_call_output` |  |  | A rollout line is read only when it holds one of these. |
| `idle_sweep.codex_retask_calls` | `send_input, resume_agent` |  |  | The calls that give an agent more work. |
| `idle_sweep.codex_spawn_call` | `spawn_agent` |  |  | The call whose output names a new agent. |
| `idle_sweep.codex_wait_call` | `wait_agent` |  |  | The call whose output reports agent statuses. |
| `idle_sweep.dedupe_key` | `idle-agent-sweep` |  |  | The emit-dedupe key of the advisory. |
| `idle_sweep.ellipsis` | `…` |  |  | Appended to a label that was cut. |
| `idle_sweep.env_test_isolation` | `ANTIHALL_TEST_ISOLATION` |  |  | When this variable is 1, the injected clock below is honoured (tests and replays only, as in the Node hook). |
| `idle_sweep.env_test_now` | `ANTIHALL_TEST_NOW_MS` |  |  | The injected clock, in milliseconds, honoured only when the isolation variable is 1. |
| `idle_sweep.event` | `UserPromptSubmit` |  |  | The hook event name in the check's output. |
| `idle_sweep.guard_name` | `idle-agents` |  |  | The guard id the advisory names. |
| `idle_sweep.idle_marker` | `idle_notification` |  |  | The text a teammate's end-of-turn report carries. |
| `idle_sweep.inbox_marker` | `'s inbox` |  |  | Text of a SendMessage result for a teammate. |
| `idle_sweep.instead` | `if you have no more work for them, {verb} each one, e.g. {call} (one call per...` |  |  | Advisory advice; {verb} close or stop, {call} the exact call for the first agent. |
| `idle_sweep.label_max` | `60` |  |  | Longest agent label shown, in UTF-16 units. |
| `idle_sweep.launch_phrase` | `Async agent launched successfully` |  |  | What a background agent's launch tool result begins with. |
| `idle_sweep.launch_tools` | `Agent, Task` |  |  | The tools whose results can be a launch or a teammate spawn. |
| `idle_sweep.max_named` | `10` |  |  | How many agents the advisory names; the rest are counted. |
| `idle_sweep.more` | `, and {m} more` |  |  | Appended to the list when agents beyond the named ones exist; {m} is how many. |
| `idle_sweep.ms_per_minute` | `60000` |  |  | Milliseconds in a minute (idle ages are shown and compared in minutes). |
| `idle_sweep.not_a_report_keys` | `12 items` |  |  | Keys the host stamps on typed, queued, tool-result and compaction records; a genuine teammate report carries none of them (isSidechain only when true). |
| `idle_sweep.notification_tag` | `<task-notification>` |  |  | The tag a background task's completion notice starts with; a turn that is one is not a human turn. |
| `idle_sweep.num_count` | `5 entries` |  |  | Where the idle-agent count that fires the advisory is read from (guards.idleAgentSweepCount, default 3). |
| `idle_sweep.num_minutes` | `5 entries` |  |  | Where the idle minutes that fire the advisory for any one agent are read from (guards.idleAgentSweepMin, default 15). |
| `idle_sweep.prefilter` | `10 items` |  |  | A transcript line is read only when it holds one of these (the Node scan's cheap pre-filter, in the same terms). |
| `idle_sweep.queued_marker` | `Message queued for delivery to` |  |  | Text of a SendMessage result for an agent that is still running. |
| `idle_sweep.re_agent_id` | `agentId:\s*([0-9a-fA-F]{6,40})` |  |  | The agent id in a launch result's text (JavaScript regex). |
| `idle_sweep.re_codex_dir` | `[\\/]\.codex[\\/]` |  |  | A path under a .codex directory (JavaScript regex). |
| `idle_sweep.re_codex_id` | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |  |  | A Codex agent id (JavaScript regex, ignore case). |
| `idle_sweep.re_codex_rollout` | `(^\|[\\/])rollout-[^\\/]*\.jsonl$` |  |  | A Codex rollout transcript path (JavaScript regex). |
| `idle_sweep.re_control_chars` | `[\x00-\x1F\x7F-\x9F]` |  |  | Control characters replaced by a space in a label (JavaScript regex, replaced globally). |
| `idle_sweep.re_finished_reason` | `^(available\|failed)$` |  |  | Idle reasons that end a teammate's work (JavaScript regex). |
| `idle_sweep.re_hex_id` | `^[0-9a-fA-F]{6,40}$` |  |  | A background agent id (JavaScript regex). |
| `idle_sweep.re_inbox_message` | `^Message sent to (.+)\x27s inbox$` |  |  | A teammate send result's message; the group is the teammate's name (JavaScript regex). |
| `idle_sweep.re_minutes` | `\(\d+m\)` |  |  | The age shown after an agent, which the dedupe hash ignores (JavaScript regex, replaced globally). |
| `idle_sweep.re_notification_block` | `<task-notification>([\s\S]*?)</task-notification>` |  |  | One task-notification block of a text (JavaScript regex, global). |
| `idle_sweep.re_queued_message` | `^Message queued for delivery to\s` |  |  | A queued-delivery result's message (JavaScript regex). |
| `idle_sweep.re_resume_message` | `^Resuming\s+agent\s+([0-9a-fA-F]{6,40})` |  |  | A resume result's message (JavaScript regex, ignore case). |
| `idle_sweep.re_status` | `<status>([^<]*)</status>` |  |  | The status inside one notification block (JavaScript regex). |
| `idle_sweep.re_system_reminder_notice` | `<system-reminder>\s*<task-notification>` |  |  | A notification block directly inside a system-reminder block (JavaScript regex). |
| `idle_sweep.re_task_id` | `<task-id>([^<]*)</task-id>` |  |  | The task id inside one notification block (JavaScript regex). |
| `idle_sweep.re_terminal_status` | `^(completed\|failed\|stopped\|killed\|cancelled\|canceled)$` |  |  | Notification and attachment statuses that mean an agent ended (JavaScript regex, ignore case). |
| `idle_sweep.report_future_skew_ms` | `5000` |  | ms | A report's inner timestamp further than this after its entry's own timestamp is forged or garbage and is ignored. |
| `idle_sweep.report_prefix` | `Another Claude session sent a message:` |  |  | What a teammate report entry's text begins with. |
| `idle_sweep.resume_tools` | `SendMessage, Agent, Task` |  |  | The tools whose results can resume an agent. |
| `idle_sweep.scan_bytes` | `12582912` |  | bytes | How much of the transcript tail is read: wide enough that a teammate's spawn record is in the window with its reports. |
| `idle_sweep.send_tools` | `SendMessage` |  |  | The tools whose results can be a message sent to a teammate. |
| `idle_sweep.skip_name` | `idle-agent-sweep` |  |  | The name that ~/.anti-hall/skip.json uses to skip this hook. |
| `idle_sweep.spawned_status` | `teammate_spawned` |  |  | The `toolUseResult.status` of a named teammate's spawn. |
| `idle_sweep.summary` | `UserPromptSubmit: lists agents that finished but were never stopped or closed...` |  |  | One-line description of the idle-agent-sweep check in the generated reference. |
| `idle_sweep.sw_enabled` | `4 entries` |  |  | Where the on/off switch is read from (guards.idleAgentSweep, default on). |
| `idle_sweep.task_stop_marks` | `"name":"TaskStop", "name": "TaskStop"` |  |  | How a TaskStop call appears in a transcript line. |
| `idle_sweep.what` | `{n} finished agent{be} idle and not {past}: {shown}{more}.` |  |  | Advisory headline; {n} agents, {be} the verb phrase, {past} closed or stopped, {shown} the named agents, {more} the overflow. |
| `idle_sweep.why` | `{why_head} until it is {past}.` |  |  | Advisory reason; {why_head} is the platform's reason, {past} closed or stopped. |
| `idle_sweep.words_claude` | `3 entries` |  |  | The platform words of the Claude advisory. |
| `idle_sweep.words_codex` | `3 entries` |  |  | The platform words of the Codex advisory. |

### prompt_emit.toml / prompt_emit

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `prompt_emit.judge_child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | When this variable is 1 the hook runs inside the `claude -p` judge child, whose hooks must do nothing (hooks/lib/judge-child-exit.js): the check answers with no output and no state. |

### prompt_emit.toml / verify_first

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `verify_first.dedupe_key` | `verify-first` |  |  | The emit-dedupe key of the reminder. |
| `verify_first.dedupe_normalized` | `VERIFY-FIRST` |  |  | What every rotating line is normalized to before hashing, so a different line is still the same block. |
| `verify_first.dedupe_normalized_primary` | `VERIFY-FIRST+PRIMARY` |  |  | What the block is normalized to before hashing when the Primary sentence is appended. |
| `verify_first.env_devswarm_disable` | `DISABLE_ANTIHALL_DEVSWARM` |  |  | Setting this variable to 1 turns the DevSwarm integration off. |
| `verify_first.env_devswarm_repo` | `DEVSWARM_REPO_ID` |  |  | The variable DevSwarm sets for a session it runs; a non-blank value makes the session a DevSwarm session in auto mode. |
| `verify_first.env_devswarm_source_branch` | `DEVSWARM_SOURCE_BRANCH` |  |  | The variable DevSwarm sets for a child workspace; a non-blank value means this session is a child, never a Primary. |
| `verify_first.event` | `UserPromptSubmit` |  |  | The hook event name in the check's output. |
| `verify_first.no_ws_docs` | `CLAUDE.md, AGENTS.md` |  |  | The repo documents searched for the no-workspaces rule, at each directory level, in this order. |
| `verify_first.no_ws_levels` | `8` |  |  | How many directory levels the search climbs from the working directory (it stops earlier at the repository root). |
| `verify_first.no_ws_pattern` | `no\s+workspaces?\s+for\s+real\s+work` |  |  | JavaScript regex source (flags: i) matched against a repo's CLAUDE.md / AGENTS.md: a match means the repo forbids workspaces for real work, so the Primary dispatch-tier text is withheld. |
| `verify_first.nudges` | `20 items` |  |  | The rotating reminder lines, in the order the Node hook lists them (the index is the payload digest modulo their number). |
| `verify_first.num_repeat_every` | `6 entries` |  |  | Where the repeat interval is read from (guards.injectionRepeatEvery, delivered turns, default 10); 0 repeats the reminder every turn. |
| `verify_first.prefix` | `VERIFY-FIRST: ` |  |  | Text in front of the rotating line. |
| `verify_first.primary_joiner` | ` ` |  |  | Text between the rotating line and the Primary sentence. |
| `verify_first.primary_nudge` | `DEVSWARM PRIMARY: the workspace is your TOP fan-out tier. A workspace-scale M...` |  |  | The sentence appended to the rotating line in a DevSwarm Primary session that may dispatch workspaces (byte-identical to the Node hook's DEVSWARM_PRIMARY_NUDGE). |
| `verify_first.summary` | `UserPromptSubmit: the short rotating verify-first reminder, deduplicated per ...` |  |  | One-line description of the verify-first check in the generated reference. |
| `verify_first.sw_dispatch_tier_text` | `4 entries` |  |  | Where the switch of the DevSwarm Primary dispatch-tier text is read from (devswarm.dispatchTierText, default on). |
| `verify_first.sw_no_ws_detect` | `4 entries` |  |  | Where the switch of the CLAUDE.md / AGENTS.md no-workspaces detection is read from (jev.dispatchTierDetectNoWorkspaces, default on). |
| `verify_first.sw_no_ws_repos` | `4 entries` |  |  | Where the list of repos that forbid workspaces is read from (jev.dispatchTierNoWorkspaceRepos, comma separated: absolute path prefixes, directory names, or * for all). |
| `verify_first.sw_supervisor_mode` | `6 entries` |  |  | Where the DevSwarm supervisor mode is read from (devswarm.supervisorMode: auto, on or off, default auto): the first condition of the Primary gate. |
| `verify_first.sw_turn` | `4 entries` |  |  | Where the on/off switch is read from (context.verifyFirstTurn, default on). |

### ctxbudget.toml / ctxbudget

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `ctxbudget.account_state` | `.anti-hall/limit-conserve-account.json` |  |  | The account-switch state file of limit conservation, relative to the home directory (hooks/limit-conserve.js ACCOUNT_STATE_FILE). |
| `ctxbudget.advice_good_word` | `good` |  |  | The word that opens the good-point-to recommendation wording. |
| `ctxbudget.advice_needs_good` | `compact, clear, /new` |  |  | Words that, together with the word good, can form a good-point-to recommendation (good point to compact, /clear or /new). |
| `ctxbudget.advice_needs_safe` | `compact, /clear, reset, /new` |  |  | Words that, together with the word safe, can form a compact recommendation (safe to compact, safe to /clear, safe for a reset or /new); a final text with none of the pairs holds no recommendation. |
| `ctxbudget.advice_prefilter` | `compact, clear, reset, /new` |  |  | Substrings whose absence from the whole transcript tail (and from every unicode escape) proves that no assistant text of it can hold a compact recommendation. |
| `ctxbudget.advice_safe_word` | `safe` |  |  | The word that opens the safe-to and safe-for recommendation wordings. |
| `ctxbudget.advice_slash_compact` | `/compact` |  |  | The slash command whose mention alone can be a recommendation (run /compact, a standalone /compact line). |
| `ctxbudget.ah_backstop_instead` | `refresh the handover now ({skill}: write the next HANDOVER-<n>.md) so it cove...` |  |  | The backstop's instructions; {skill} the handover skill, {reset} the reset commands. |
| `ctxbudget.ah_backstop_what` | `post-handover budget exceeded: context is ~{pct}%, more than {b} points past ...` |  |  | The backstop's first line; {pct} context percent, {b} budget, {hp} handover percent. |
| `ctxbudget.ah_bloat` | `As context grows the model gets less efficient and more prone to hallucinatio...` |  |  | The sentence on why a large context hurts (BLOAT_SENTENCE). |
| `ctxbudget.ah_budget` | `~{b}% of the context window{tok}` |  |  | The budget label of the gate; {b} is the budget percent, {tok} the token clause. |
| `ctxbudget.ah_budget_tokens` | ` (~{k}K tokens)` |  |  | The token clause of the budget label; {k} is the budget in thousands of tokens. |
| `ctxbudget.ah_ceiling` | ` ({k}K)` |  |  | The ceiling clause of the token fire line; {k} is the ceiling in thousands. |
| `ctxbudget.ah_clear_claude` | `/clear` |  |  | The command that starts a fresh session on Claude. |
| `ctxbudget.ah_clear_codex` | `/new` |  |  | The command that starts a fresh session on Codex. |
| `ctxbudget.ah_codex_dir` | `.codex` |  |  | The directory name whose presence in a transcript path marks a Codex session. |
| `ctxbudget.ah_compact_claude` | `/compact focus: continuation state is in {path}; keep pending tasks, the user...` |  |  | The compact command on Claude; {path} is the expected handover path. |
| `ctxbudget.ah_compact_codex` | `/compact` |  |  | The compact command on Codex. |
| `ctxbudget.ah_compact_no_path` | `<the HANDOVER*.md path you wrote>` |  |  | The compact command's path when no handover path is known. |
| `ctxbudget.ah_default_status` | `pending` |  |  | The status a task without one has. |
| `ctxbudget.ah_fire_main_file` | `; by the skill's own date/sequence rules its main file is {path}` |  |  | The clause naming the expected main handover file ({path}). |
| `ctxbudget.ah_fire_step1` | `(1) write an anti-hall session handover YOURSELF, following the contract of {...` |  |  | The start of the fire directive's instructions; {skill} names the handover skill. |
| `ctxbudget.ah_fire_step2` | `; (2) tell the user it was done and list every path you saved under .anti-hal...` |  |  | Step 2 of the fire directive. |
| `ctxbudget.ah_fire_step3_claude` | `(3) urge them to compact (or /clear) soon and give them this exact command to...` |  |  | Step 3 of the fire directive on Claude; {cmd} is the compact command to paste. |
| `ctxbudget.ah_fire_step3_codex` | `(3) urge them to run /compact (or /new for a fresh chat) soon (Codex re-point...` |  |  | Step 3 of the fire directive on Codex. |
| `ctxbudget.ah_fire_tail` | `whether they would like to reach a good stopping point first. {bloat} This fi...` |  |  | The end of the fire directive's instructions; {bloat} is the bloat sentence. |
| `ctxbudget.ah_fire_why` | `It preserves the session's work against auto-compact. Do it without asking th...` |  |  | The Why line of the fire directive. |
| `ctxbudget.ah_freshness_grace_ms` | `1000` |  | ms | How much later than the handover file the last counted work may be and the handover still count as fresh (handover-freshness.js MTIME_GRACE_MS). |
| `ctxbudget.ah_gate_allowed` | `a quick question, finishing the in-flight task the handover names, or spawnin...` |  |  | The gate's Allowed line. |
| `ctxbudget.ah_gate_ask_claude` | `ask the user with AskUserQuestion (two options)` |  |  | How the gate asks on Claude. |
| `ctxbudget.ah_gate_ask_codex` | `ask the user to choose between two options` |  |  | How the gate asks on Codex. |
| `ctxbudget.ah_gate_instead` | `if it is bigger than the budget, do not start it; {ask}: (a) add it to the ta...` |  |  | The gate's instructions; {ask} how to ask, {reset} the reset commands. |
| `ctxbudget.ah_gate_override` | `if the user has explicitly insisted on proceeding, proceed` |  |  | The gate's override line. |
| `ctxbudget.ah_gate_what` | `post-handover new-work gate (context ~{pct}%, handover saved at ~{hp}%; budge...` |  |  | The gate's first line; {pct} context percent, {hp} handover percent, {budget} the budget label. |
| `ctxbudget.ah_gate_why` | `Before starting this request, judge YOURSELF whether it needs more than that ...` |  |  | The gate's Why line. |
| `ctxbudget.ah_guard` | `auto-handover` |  |  | The guard name every auto-handover message carries. |
| `ctxbudget.ah_handover_dir_rel` | `.anti-hall/handovers` |  |  | The handovers directory relative to the repository, as the fire directive shows it. |
| `ctxbudget.ah_handover_name` | `HANDOVER.md` |  |  | The name of a session's first handover file. |
| `ctxbudget.ah_handover_name_n` | `HANDOVER-{n}.md` |  |  | The name of a session's n-th handover file ({n} from 2). |
| `ctxbudget.ah_hash_tag_len` | `16` |  |  | Hex digits of the transcript path's SHA-1 that tag a session without a usable id (auto-handover-state.js sessionTag). |
| `ctxbudget.ah_heading_mark` | `##` |  |  | The Markdown mark that opens a handover section heading (followed by white space). |
| `ctxbudget.ah_heading_next` | `Next action` |  |  | The handover section whose done-word marks the task complete. |
| `ctxbudget.ah_heading_open` | `Open items` |  |  | The handover section whose emptiness marks the task complete. |
| `ctxbudget.ah_housekeeping` | `inbox tick, peer check, BROADCAST bug sweep` |  |  | The built-in markers (case-insensitive substrings) of a scheduled housekeeping prompt that never gets the new-work gate (auto-handover-gate.js HOUSEKEEPING_MARKERS). |
| `ctxbudget.ah_label_estimated` | ` (ESTIMATED, assuming a standard 200k window; for a 1M-context session set AN...` |  |  | The estimate clause for any other estimated window. |
| `ctxbudget.ah_label_inferred` | ` (inferred 1M window: observed usage already exceeded the standard 200k, so t...` |  |  | The estimate clause when the window was inferred to be one million tokens. |
| `ctxbudget.ah_line_complete` | `🟢 **GOOD POINT TO {clear} NOW**: handover saved at {path}. Task looks complet...` |  |  | The good-point line when the task looks complete; {clear} the fresh-session command, {path} the handover path. |
| `ctxbudget.ah_line_continue` | `🟢 **GOOD POINT TO /compact NOW**: handover saved at {path}. /compact keeps wo...` |  |  | The good-point line otherwise; {clear} the fresh-session command, {path} the handover path. |
| `ctxbudget.ah_marker_seps` | `,, :` |  |  | The characters that separate the extra housekeeping markers of the setting (csvToMarkers splits on each). |
| `ctxbudget.ah_mtime_slack_ms` | `2000` |  | ms | How much older than the fire a handover file may be and still count as this arm's handover (auto-handover-gate.js MTIME_SLACK_MS). |
| `ctxbudget.ah_nag_instead` | `{bloat} Mention {reset} to the user again when convenient.` |  |  | The milestone nag's instructions; {bloat} the bloat sentence, {reset} the reset commands. |
| `ctxbudget.ah_nag_what` | `context is now ~{pct}% (handover already saved earlier this session).` |  |  | The milestone nag's first line; {pct} is the rounded percent. |
| `ctxbudget.ah_next_done_words` | `none, done, complete, nothing` |  |  | The whole-section texts (an optional trailing dot allowed, any case) that say Next action is done. |
| `ctxbudget.ah_open_empty_words` | `none, n/a, -, —, (none)` |  |  | The whole-section texts (an optional trailing dot allowed, any case) that say Open items is empty. |
| `ctxbudget.ah_open_statuses` | `pending, in_progress` |  |  | The task statuses that count as open work and hold back the pause nag. |
| `ctxbudget.ah_parts_sep` | `\n\n` |  |  | What joins the parts of one auto-handover context (backstop, gate, nag). |
| `ctxbudget.ah_pause_instead` | `{bloat} Mention {reset} to the user now.` |  |  | The pause nag's instructions; {bloat} the bloat sentence, {reset} the reset commands. |
| `ctxbudget.ah_pause_what` | `good stopping point: context is still ~{pct}% and a handover is already saved.` |  |  | The pause nag's first line; {pct} is the rounded percent. |
| `ctxbudget.ah_proto_key` | `__proto__` |  |  | The object key Object.assign does not copy as data; a latch holding it defers to Node. |
| `ctxbudget.ah_reset_claude` | `/compact or /clear` |  |  | How the Claude texts name the reset commands. |
| `ctxbudget.ah_reset_codex` | `/compact or /new` |  |  | How the Codex texts name the reset commands. |
| `ctxbudget.ah_rollout_prefix` | `rollout-` |  |  | The file name prefix of a Codex rollout transcript. |
| `ctxbudget.ah_rollout_suffix` | `.jsonl` |  |  | The file name suffix of a Codex rollout transcript. |
| `ctxbudget.ah_skill_claude` | `the /anti-hall:handover skill` |  |  | How the Claude texts name the handover skill. |
| `ctxbudget.ah_skill_codex` | `the anti-hall-handover skill (pick it with /skills if it is not already loaded)` |  |  | How the Codex texts name the handover skill. |
| `ctxbudget.ah_soft_instead` | `consider checking with the user about writing a handover and compacting/clear...` |  |  | The soft advisory's instructions; {bloat} the bloat sentence. |
| `ctxbudget.ah_soft_what` | `context looks high (~{pct}%, ESTIMATED).` |  |  | The soft advisory's first line; {pct} is the rounded percent. |
| `ctxbudget.ah_soft_why` | `This session's exact context window could not be determined, so treat this as...` |  |  | The soft advisory's Why line. |
| `ctxbudget.ah_spawn_activity_ms` | `120000` |  | ms | How recent a logged subagent spawn must be to hold back the pause nag (statusline phase-bar ACTIVITY_MS). |
| `ctxbudget.ah_spawn_log` | `.anti-hall/agent-spawns.log` |  |  | The subagent spawn log, relative to the home directory (one `<ms> <session tag>` line per spawn). |
| `ctxbudget.ah_suffix_fresh` | `\n\nEnd your reply to the user with exactly this line, verbatim: {line}` |  |  | The decisive suffix for a fresh handover; {line} is the good-point line. |
| `ctxbudget.ah_suffix_no_path` | `<the HANDOVER*.md path you saved>` |  |  | The handover path the decisive line shows when none is known. |
| `ctxbudget.ah_suffix_stale` | `\n\n⚠️ The saved handover is stale (work continued after it was written): ref...` |  |  | The decisive suffix when the handover went stale; {line} is the good-point line. |
| `ctxbudget.ah_suffix_unknown` | `\n\nEnd your reply to the user with exactly this line, verbatim: 📝 Handover s...` |  |  | The decisive suffix when the handover's freshness is unknown; {path} is the handover path. |
| `ctxbudget.ah_task_id_keys` | `taskId, id, task_id` |  |  | The input fields a task update names its task by, in order. |
| `ctxbudget.ah_task_tools` | `TodoWrite, TaskCreate, TaskUpdate` |  |  | The tool names whose calls the open-task scan reads: the list writer, the task creator, the task updater (in that order). |
| `ctxbudget.ah_unknown_session` | `unknown-session` |  |  | The session directory name a handover path uses when the session id sanitizes to nothing. |
| `ctxbudget.ah_via_pct` | `pct` |  |  | The firedVia word of a percent crossing. |
| `ctxbudget.ah_via_stop_prefix` | `stop-` |  |  | The prefix the Stop-side fire records in the latch's firedVia. |
| `ctxbudget.ah_via_tokens` | `tokens` |  |  | The firedVia word of a token-ceiling crossing. |
| `ctxbudget.ah_what_pct` | `context is at ~{pct}%{label}: write a handover now.` |  |  | The fire directive's first line for a percent crossing; {pct} is the rounded percent, {label} the estimate clause. |
| `ctxbudget.ah_what_tokens` | `context is ~{usedK}K tokens, past your autoHandover.maxTokens ceiling{ceiling...` |  |  | The fire directive's first line for a token-ceiling crossing; {usedK} is the tokens in thousands, {ceiling} the ceiling clause. |
| `ctxbudget.ca_advice` | `ctxbudget.ca_advice_safe_to, ctxbudget.ca_advice_good_point, ctxbudget.ca_adv...` |  |  | The recommendation patterns of compact-advice.js ADVICE_RES, in order (keys of this file); see the pattern entries for their token syntax. |
| `ctxbudget.ca_advice_command` | `\b(?:run\|type\|use\|do\|then\|now\|recommend(?:ed)?\|suggest(?:ed)?){S}*:?{S}*`*/co...` |  |  | Rust regex source (as ca_advice_safe_to): /compact offered as an instruction (run, then, now ...). |
| `ctxbudget.ca_advice_good_point` | `\bgood{S}+(?:point\|time\|moment){S}+(?:to\|for){S}+(?:/?compact\|/?clear\|/new)\b` |  |  | Rust regex source (as ca_advice_safe_to): the good point/time/moment to compact wording. |
| `ctxbudget.ca_advice_line` | `(?m)^[ \t]*(?:[-*+]\|[0-9]+[.)])?[ \t]*`*/compact\b(?:[ \t]+(?:now\|focus:{S}*{...` |  |  | Rust regex source (as ca_advice_safe_to, multiline; {NS} JavaScript non-white space): a standalone /compact invocation line. |
| `ctxbudget.ca_advice_safe_for` | `\bsafe{S}+for{S}+(?:a{S}+)?(?:context{S}+)?(?:reset\|compaction\|/?compact\|/new)\b` |  |  | Rust regex source (as ca_advice_safe_to): the Codex safe-for-a-reset wording. |
| `ctxbudget.ca_advice_safe_to` | `\bsafe{S}+to{S}+(?:/compact\|compact\|/clear)\b` |  |  | Rust regex source, matched against the text with ASCII letters lowered ({S} JavaScript white space, \b ASCII): the bare safe-to-compact wording. |
| `ctxbudget.ca_all_caps` | `^SAFE{S}+TO{S}+(?:/?COMPACT\|/CLEAR)$` |  |  | Rust regex source (case kept) of the capitalized SAFE TO COMPACT form, which counts wherever it sits except in a table cell. |
| `ctxbudget.ca_backtick` | ``[^`\n]{0,400}`` |  |  | Rust regex source of an inline-code span, blanked unless it is an instruction naming a slash command. |
| `ctxbudget.ca_backtick_lookback` | `40` |  |  | UTF-16 units before an inline-code span the instruction tests look at. |
| `ctxbudget.ca_bare_safe_index` | `0` |  |  | Position in ca_advice of the bare safe-to wording (it counts only at a sentence or line start unless written in capitals). |
| `ctxbudget.ca_blockquote` | `(?m)^[ \t]*>[^\n]*$` |  |  | Rust regex source (multiline) of a blockquote line, blanked before the phrase analysis. |
| `ctxbudget.ca_codex_tool_types` | `function_call, tool_call, shell_call` |  |  | Words whose presence in a Codex response item's type makes it a tool call. |
| `ctxbudget.ca_command_index` | `3` |  |  | Position in ca_advice of the instruction wording (it counts only at a sentence or line start). |
| `ctxbudget.ca_conditional_before` | `\b(?:if\|when\|once\|after\|until)\b[^:\n]{0,60}:{S}*$` |  |  | Rust regex source (lowered text) tested on the units before a match: a conditional lead-in ending in a colon (CONDITIONAL_BEFORE_RE). |
| `ctxbudget.ca_ctx_low` | `low` |  |  | The context clause of the instructions when the percent is unknown. |
| `ctxbudget.ca_ctx_pct` | `{pct}%` |  |  | The context clause of the instructions when the percent is known ({pct} rounded). |
| `ctxbudget.ca_dquote` | `”[^”\n]{0,400}”\|“[^”\n]{0,400}”\|"[^"\n]{0,400}"` |  |  | Rust regex source of a double-quoted span (curly or straight), blanked before the phrase analysis. |
| `ctxbudget.ca_fenced` | ````(?s:.)*?```` |  |  | Rust regex source of a fenced code block, blanked before the phrase analysis. |
| `ctxbudget.ca_green_hi` | `55357` |  |  | The high UTF-16 unit of the green circle emoji, which the non-unicode pattern classes of compact-advice.js name one unit at a time. |
| `ctxbudget.ca_green_lo` | `57314` |  |  | The low UTF-16 unit of the green circle emoji. |
| `ctxbudget.ca_guard` | `compact-advice-guard` |  |  | The guard name of the compact-advice block. |
| `ctxbudget.ca_instead` | `retract it in one line, e.g. "RETRACT SAFE TO COMPACT: context is {ctx}; no n...` |  |  | The block's instructions; {ctx} is the context clause. |
| `ctxbudget.ca_instr_line` | `(?:^\|\n)[ \t]*(?:[-*+]\|[0-9]+[.)])?[ \t]*$` |  |  | Rust regex source tested on the units before an inline-code span: it opens its own (optionally bulleted) line. |
| `ctxbudget.ca_instr_verb` | `\b(?:run\|type\|use\|do\|then\|now\|recommend(?:ed)?\|suggest(?:ed)?){S}*:?{S}*$` |  |  | Rust regex source (lowered text) tested on the units before an inline-code span: it follows an instruction verb. |
| `ctxbudget.ca_lead_deco` | `*_`"'“”✅⏳❌⚠️-•>` |  |  | Decoration (besides white space and the green circle) walked over back to a sentence or line start; one character per UTF-16 unit. |
| `ctxbudget.ca_lead_words` | `23 items` |  |  | Short interjections that may open a sentence before a comma and a declaration (LEAD_INTERJECTION_RE, any ASCII case). |
| `ctxbudget.ca_line_retract` | `(?m)^[ \t]*[*_`>\-•]*[ \t]*retract(?:ed\|ing)?\b` |  |  | Rust regex source (lowered text, multiline) of a line that begins with a retraction (LINE_RETRACT_RE). |
| `ctxbudget.ca_marker_line` | `^[ \t]*(?:#{1,6}[ \t]+)?(?:[-*+•][ \t]+)?[*_`✅🟢⏳ \t]*(?:HANDOVER[ \t]+COMPLET...` |  |  | Rust regex source (case kept, real characters) of a line that holds only the declaration marker (MARKER_LINE_RE). |
| `ctxbudget.ca_meta_before` | `\bwill{S}+(?:only{S}+)?(?:say\|write\|declare){S}*$\|\bwhen{S}+i{S}+(?:say\|write...` |  |  | Rust regex source (lowered text) tested on the units before a match: a sentence about when the marker is written (META_BEFORE_RE). |
| `ctxbudget.ca_negation_after` | `^[^.!?\n]{0,30}[,;]{S}*(?:but{S}+\|and{S}+)?first\b\|^{S}*(?:after\|once\|when\|if)\b` |  |  | Rust regex source (lowered text) tested on the units after a match: a declaration gated on something first (NEGATION_AFTER_RE). |
| `ctxbudget.ca_negation_before` | `(?:\bnot{S}+yet\b\|\bnot\b\|n['’]t\b\|\bnever\b\|\bno{S}+need\b\|\bno{S}+reason\b\|...` |  |  | Rust regex source (lowered text) tested on the units before a match: a negation or a not-yet condition (NEGATION_BEFORE_RE). |
| `ctxbudget.ca_quote_close_before` | `.,;:!?)]}` |  |  | Characters (besides white space and the end) before which a single quote closes a quoted span. |
| `ctxbudget.ca_quote_max` | `400` |  |  | The most UTF-16 units between two single quotes that count as a quoted span. |
| `ctxbudget.ca_quote_open_after` | `([{` |  |  | Characters (besides white space) after which a single quote opens a quoted span. |
| `ctxbudget.ca_recent_n` | `a compact happened {n} turns ago` |  |  | The reason when a compact happened {n} turns ago. |
| `ctxbudget.ca_recent_now` | `a compact happened earlier in this turn` |  |  | The reason when a compact happened in this very turn. |
| `ctxbudget.ca_recent_one` | `a compact happened {n} turn ago` |  |  | The reason when a compact happened one turn ago ({n}). |
| `ctxbudget.ca_retract` | `\bretract(?:ed\|ing)?\b[{ws}:,\-—–*_`"'“”]*(?:the{S}+)?(?:[*_`✅{G1}{G2}]{S}*)*...` |  |  | Rust regex source (lowered text; {ws} the white space set in a class, {G1}/{G2} the stand-ins of the green circle's two UTF-16 units) of a retraction (RETRACT_RE). |
| `ctxbudget.ca_sentence_end` | `.!?:` |  |  | Characters that end a sentence before a declaration. |
| `ctxbudget.ca_slash_cmd` | `/(?:compact\|clear\|new)\b` |  |  | Rust regex source (lowered text) of a slash command a quoted or inline-code span may name and still count. |
| `ctxbudget.ca_state_dir` | `compact-advice` |  |  | The directory under the state root that holds the once-per-declaration records of the compact-advice guard. |
| `ctxbudget.ca_state_json` | `{"hash":{hash},"at":{at}}` |  |  | The once-per-declaration record; {hash} is the JSON-quoted SHA-1 of the final text, {at} the time in ms. |
| `ctxbudget.ca_tokens_vias` | `tokens, stop-tokens` |  |  | The firedVia words of a token-ceiling fire, whose SAFE declaration is allowed even at a low percent. |
| `ctxbudget.ca_what` | `your reply recommends compacting ("{phrase}") but {why}.` |  |  | The block's first line; {phrase} is the recommendation, {why} the reasons. |
| `ctxbudget.ca_why` | `"No background agents running" is necessary, not sufficient; only the auto-ha...` |  |  | The block's Why line. |
| `ctxbudget.ca_why_join` | `, and ` |  |  | What joins the reasons. |
| `ctxbudget.ca_why_pct` | `context is {pct}% (auto-handover threshold {threshold}%)` |  |  | The reason when the context is known; {pct} rounded, {threshold} the auto-handover threshold. |
| `ctxbudget.ca_why_unknown` | `context % is unknown` |  |  | The reason when the context is unknown. |
| `ctxbudget.ca_window_after` | `40` |  |  | UTF-16 units after a match the negation pattern looks at. |
| `ctxbudget.ca_window_before` | `60` |  |  | UTF-16 units before a match the negation patterns look at. |
| `ctxbudget.claude_json` | `.claude.json` |  |  | The host file whose top-level userID names the logged-in account, relative to the home directory (read only that field). |
| `ctxbudget.context_window_env` | `ANTIHALL_CONTEXT_WINDOW_TOKENS` |  |  | Environment variable that overrides the context window size, in tokens (always wins over the other window sources). |
| `ctxbudget.deep_json_depth` | `100` |  |  | Nesting depth beyond which a transcript or state line the engine cannot parse is deferred to Node (the Node parser has no such limit). |
| `ctxbudget.default_window` | `200000` |  | tokens | The context window assumed when no source states one, in tokens (the reading is then flagged as unknown). |
| `ctxbudget.env_pct_off` | `ANTIHALL_AUTO_HANDOVER_PCT` |  |  | Environment variable that, when it parses to 0, disables auto-handover outright (the one rule the settings schema cannot express). |
| `ctxbudget.home_env` | `HOME` |  |  | Environment variable that holds the home directory (Node's os.homedir() reads it first on POSIX). |
| `ctxbudget.inferred_json` | `{"inferred":true,"ts":{ts}}` |  |  | The inferred-window latch body; {ts} is the time it was written, in ms. |
| `ctxbudget.inferred_suffix` | `.inferred-1m.json` |  |  | File name suffix of the inferred one-million-token window latch next to a session's context reading. |
| `ctxbudget.inferred_window` | `1000000` |  | tokens | The window assumed once the observed usage has exceeded the default window, in tokens. |
| `ctxbudget.json_null` | `null` |  |  | The JSON literal null. |
| `ctxbudget.judge_child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | Environment variable the judge child sets to 1 so that every hook is a no-op (hooks/lib/judge-child-exit.js). |
| `ctxbudget.judge_child_on` | `1` |  |  | The value of the judge child variable that turns the hooks into no-ops. |
| `ctxbudget.latch_dir` | `auto-handover` |  |  | The directory under the state root that holds the per-session auto-handover latch files. |
| `ctxbudget.lc_account_json` | `{"userID":{user},"usageCacheMtime":{mtime}}` |  |  | The account-switch state file body as Node writes it; {user} is the JSON-quoted account id, {mtime} the cache mtime in ms (or null). |
| `ctxbudget.lc_bucket_pct` | `fiveHourPercent, weeklyPercent, sonnetWeeklyPercent` |  |  | The usage-cache fields holding each bucket percent, in the order the trips are listed. |
| `ctxbudget.lc_bucket_resets` | `fiveHourResetsAt, weeklyResetsAt, sonnetWeeklyResetsAt` |  |  | The usage-cache fields holding each bucket reset time, parallel to lc_bucket_pct. |
| `ctxbudget.lc_bucket_trip` | `5h, weekly, sonnetWeekly` |  |  | The name each tripped bucket has in the directive reason, parallel to lc_bucket_pct. |
| `ctxbudget.lc_dedupe_key` | `limit-conserve` |  |  | The emit-dedupe key of the limit-conservation directive. |
| `ctxbudget.lc_downshift` | `Main-model downshift: if the main agent is on the flagship model (Claude Opus...` |  |  | The main-model downshift text at the end of the directive (limit-conserve-inject.js DOWNSHIFT_DIRECTIVE). |
| `ctxbudget.lc_guard` | `limit-conserve` |  |  | The guard name the limit-conservation directive carries (hooks/lib/block-message.js guard). |
| `ctxbudget.lc_instead` | `route execution to Codex (codex:codex-rescue, separate limit) and cheap Claud...` |  |  | The start of the Do instead line of the directive (the reset clause and the downshift text follow). |
| `ctxbudget.lc_keepalive_turns` | `10` |  | turns | The emit-dedupe keepalive of the directive: an unchanged, delivered directive is re-sent after this many turns. |
| `ctxbudget.lc_reason_manual` | `manual-on` |  |  | The directive reason when the mode setting forces conservation on. |
| `ctxbudget.lc_resets_at` | ` Defer non-urgent heavy work until reset at {at}.` |  |  | The reset clause when a tripped bucket states its reset time ({at}, as the cache wrote it). |
| `ctxbudget.lc_resets_next` | ` Defer non-urgent heavy work until the next reset.` |  |  | The reset clause when no tripped bucket states a reset time. |
| `ctxbudget.lc_what` | `limit conservation is active ({reason}).` |  |  | The first line of the directive; {reason} is the tripped buckets joined with + (or the manual reason). |
| `ctxbudget.lc_why` | `Usage is near a plan limit.` |  |  | The Why line of the directive. |
| `ctxbudget.pct_dir` | `context-pct` |  |  | The directory under the state root that holds the statusline context readings (context-pct) and the inferred-window latches. |
| `ctxbudget.pct_fresh_ms` | `600000` |  | ms | How old a statusline context reading may be and still be used before the transcript is consulted instead. |
| `ctxbudget.session_tag_max` | `64` |  |  | Characters of a session id kept in a state file tag (hooks/lib/auto-handover-state.js sessionTag). |
| `ctxbudget.set_ah_decisive` | `8 entries` |  |  | The autoHandover.decisivePrompt setting: the decisive good-point line at a Stop once the handover exists. |
| `ctxbudget.set_ah_enabled` | `8 entries` |  |  | The autoHandover.enabled setting: write an automatic handover before the context runs out. |
| `ctxbudget.set_ah_gate` | `8 entries` |  |  | The autoHandover.gateNewWork setting: the post-handover new-work gate. |
| `ctxbudget.set_ah_gate_budget` | `10 entries` |  |  | The autoHandover.gateBudgetPct setting: the context points a request may use after the handover, and the backstop step. |
| `ctxbudget.set_ah_markers` | `8 entries` |  |  | The autoHandover.gateHousekeepingMarkers setting: extra comma-separated housekeeping prompt markers (a text). |
| `ctxbudget.set_ah_max_tokens` | `9 entries` |  |  | The autoHandover.maxTokens setting: an absolute token ceiling that also triggers the handover (0 means none). |
| `ctxbudget.set_ah_nag` | `8 entries` |  |  | The autoHandover.nag setting: remind when a handover is due. |
| `ctxbudget.set_ah_nag_quiet` | `9 entries` |  |  | The autoHandover.nagQuietMin setting: the minutes between two nags at a quiet pause. |
| `ctxbudget.set_ah_nag_step` | `10 entries` |  |  | The autoHandover.nagStepPct setting: the context points between two nags. |
| `ctxbudget.set_ah_pct` | `10 entries` |  |  | The autoHandover.pct setting: the context percent that triggers the handover. |
| `ctxbudget.set_ca_margin` | `10 entries` |  |  | The guards.compactAdviceMarginPct setting: context points below autoHandover.pct at which a /compact recommendation counts as low-context. |
| `ctxbudget.set_ca_recent` | `10 entries` |  |  | The guards.compactAdviceRecentTurns setting: a compact boundary within this many turns makes a /compact recommendation a block (0: off). |
| `ctxbudget.set_compact_advice_guard` | `8 entries` |  |  | The guards.compactAdviceGuard setting: block a /compact recommendation made at low context or just after a compact. |
| `ctxbudget.set_limit_account_check` | `8 entries` |  |  | The limitConserve.accountCheck setting: hold a high usage reading stale after an account switch until the cache is refreshed. |
| `ctxbudget.set_limit_mode` | `9 entries` |  |  | The limitConserve.mode setting: force conservation on or off, or auto-detect from the usage cache. |
| `ctxbudget.set_limit_threshold` | `10 entries` |  |  | The limitConserve.threshold setting: the usage percent at which conservation starts. |
| `ctxbudget.skip_auto_handover` | `auto-handover` |  |  | The skip-file name of the auto-handover and auto-handover-pause-nag guards. |
| `ctxbudget.skip_compact_advice` | `compact-advice-guard` |  |  | The skip-file name of the compact-advice-guard. |
| `ctxbudget.skip_limit_conserve` | `limit-conserve` |  |  | The skip-file name of the limit-conserve-inject guard. |
| `ctxbudget.state_root` | `.anti-hall` |  |  | The directory under the home directory that holds the guards' state files. |
| `ctxbudget.stop_block_line` | `{"decision":"block","reason":{reason}}\n` |  |  | The stdout line of a Stop hook that blocks with {reason} (already JSON-quoted), newline included. |
| `ctxbudget.summary_auto_handover` | `UserPromptSubmit: the threshold fire, the soft advisory, the milestone nag, t...` |  |  | One-line description of the auto-handover check in the generated reference. |
| `ctxbudget.summary_compact_advice` | `Stop: blocks, once per declaration, a final reply that recommends compacting ...` |  |  | One-line description of the compact-advice-guard check in the generated reference. |
| `ctxbudget.summary_limit_conserve` | `UserPromptSubmit: injects the limit-conservation directive while conservation...` |  |  | One-line description of the limit-conserve-inject check in the generated reference. |
| `ctxbudget.summary_pause_nag` | `Stop: the Stop-side fire with the decisive good-point line, the pause nag (st...` |  |  | One-line description of the auto-handover-pause-nag check in the generated reference. |
| `ctxbudget.tail_bytes` | `1572864` |  | bytes | How many bytes of the end of a transcript the guards read (hooks/lib/transcript-tail.js MAX_TAIL_BYTES). |
| `ctxbudget.token_count_marker` | `token_count` |  |  | Substring that a Codex rollout line must hold to be parsed as a token_count reading. |
| `ctxbudget.ups_empty` | `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext"...` |  |  | The exact stdout line of a UserPromptSubmit hook that injects nothing (an empty additionalContext), newline included. |
| `ctxbudget.ups_line` | `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext"...` |  |  | The stdout line of a UserPromptSubmit hook that injects {text} (already JSON-quoted), newline included. |
| `ctxbudget.usage_cache` | `.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json` |  |  | The OMC usage cache file, relative to the home directory. |
| `ctxbudget.usage_marker` | `"usage"` |  |  | Substring that a Claude transcript line must hold to be parsed as an assistant usage reading. |
| `ctxbudget.usage_max_stale_ms` | `21600000` |  | ms | Snapshot age beyond which a bucket without a usable reset time counts as 0 percent (hooks/limit-conserve.js MAX_STALE_MS). |

### inject_gate.toml / inject_gate

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `inject_gate.comms_hooks` | `devswarm-child-turn, devswarm-parent-inbox` |  |  | Dispatch entry ids whose output carries the DevSwarm comms-override line. |
| `inject_gate.comms_markers` | `💡 anti-hall · devswarm-comms: mesh only, When mentioning a workspace to the h...` |  |  | Segment prefixes (segments are separated by a blank line) of the static DevSwarm comms lines the comms cut gates. |
| `inject_gate.cut_comms` | `comms` |  |  | Telemetry label of cut 3. |
| `inject_gate.cut_limit` | `limit` |  |  | Telemetry label of cut 1. |
| `inject_gate.cut_swarm` | `swarm` |  |  | Telemetry label of cut 4. |
| `inject_gate.cut_task` | `task` |  |  | Telemetry label of cut 2. |
| `inject_gate.field_ctx` | `additionalContext` |  |  | The field of that object the gate rewrites. |
| `inject_gate.field_hso` | `hookSpecificOutput` |  |  | The object of a hook's JSON output that carries the context. |
| `inject_gate.hash_chars` | `16` |  |  | Hex characters of the SHA-1 kept as a block's fingerprint. |
| `inject_gate.hash_input_max_chars` | `32` |  |  | Most characters of a client-sent block fingerprint the gate keeps before comparing (twice `hash_chars`, so every string the daemon holds is bounded whatever a client sends). |
| `inject_gate.id_max` | `128` |  |  | Characters of a session or agent id kept (longer ids are cut). |
| `inject_gate.iso_re` | `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z\|[+-]\d{2}:\d{2})` |  |  | An ISO 8601 timestamp (a reset time whose milliseconds jitter from one reading to the next); the hash sees it rounded to the minute. |
| `inject_gate.limit_hook` | `limit-conserve-inject` |  |  | Dispatch entry id of the limit-conservation injector. |
| `inject_gate.limit_keepalive` | `⚠️ anti-hall · limit-conserve: still active (directive unchanged since it was...` |  |  | What an unchanged limit-conservation directive becomes on its keepalive turn (the full directive was injected earlier in the same context). |
| `inject_gate.max_sessions` | `128` |  |  | Sessions the gate remembers; past it the least recently used session is evicted (an evicted session simply gets its next injection whole). |
| `inject_gate.max_slots` | `32` |  |  | Gated blocks remembered per session (the oldest is dropped past it). |
| `inject_gate.note_sep` | ` ` |  |  | Separator task-tracker puts between its reminder and its freshness note. |
| `inject_gate.num_comms_every` | `6 entries` |  |  | Turns between keepalives of the unchanged comms-override line (context.injectGateCommsEvery). |
| `inject_gate.num_limit_every` | `6 entries` |  |  | Turns between keepalives of an unchanged limit-conservation directive (context.injectGateLimitEvery). |
| `inject_gate.num_swarm_every` | `6 entries` |  |  | Turns between repeats of an unchanged shared-tree advisory (context.injectGateSwarmEvery). |
| `inject_gate.num_task_every` | `6 entries` |  |  | Turns between short task-tracker reminders and unchanged freshness notes (context.injectGateTaskEvery). |
| `inject_gate.reply_emit` | `e` |  |  | Reply word: pass the block on as it is. |
| `inject_gate.reply_keepalive` | `k` |  |  | Reply word: pass the block's short keepalive form instead. |
| `inject_gate.reply_suppress` | `s` |  |  | Reply word: drop the block (the model already holds it). |
| `inject_gate.segment_sep` | `\n\n` |  |  | Separator the gated hooks put between the segments of one additionalContext. |
| `inject_gate.slot_overhead_bytes` | `96` |  |  | Bytes counted per remembered block besides its name, for the memory figure shown beside the cap. |
| `inject_gate.start_event` | `SessionStart` |  |  | The event whose dispatch means the context may have been lost (start, resume, clear, compaction): the session's gate state is cleared so the next injection is whole. |
| `inject_gate.sw_comms` | `5 entries` |  |  | Cut 3 (context.injectGateComms, default on): the DevSwarm comms-override line and the workspace-title instruction are passed on once per session, when changed, and as a keepalive every N turns. |
| `inject_gate.sw_limit` | `5 entries` |  |  | Cut 1 (context.injectGateLimit, default on): limit-conserve-inject is passed on only when the conservation directive changed (usage band, reset time to the minute), else a short keepalive every N turns. |
| `inject_gate.sw_master` | `5 entries` |  |  | Master switch of the injection gate (context.injectGate, default on): off hands every gated hook's Node output through unchanged. |
| `inject_gate.sw_swarm` | `5 entries` |  |  | Cut 4 (context.injectGateSwarm, default on): swarm-guard's shared-tree advisory is passed on when new or changed, and again only after N turns. |
| `inject_gate.sw_task` | `5 entries` |  |  | Cut 2 (context.injectGateTask, default on): task-tracker's short reminder is passed on only every N turns (its long form always passes), and its freshness note only when it changed. |
| `inject_gate.swarm_hooks` | `swarm-guard, swarm-guard#2` |  |  | Dispatch entry ids of swarm-guard (Agent and Task matchers). |
| `inject_gate.swarm_marker` | `anti-hall · shared-tree` |  |  | Text that marks a swarm-guard advisory as the shared-tree one (any other advisory passes untouched). |
| `inject_gate.task_hook` | `task-tracker` |  |  | Dispatch entry id of the task tracker. |
| `inject_gate.task_long_prefix` | `💡 anti-hall · task-tracker: capture EVERY user request` |  |  | How the long task-tracker directive starts (it is always passed on and restarts the short reminder's turn count). |
| `inject_gate.task_short` | `💡 anti-hall · task-tracker: capture every request as a priority-sorted task; ...` |  |  | The exact short task-tracker reminder hooks/task-tracker.js prints on a turn that is not the long form (a test keeps it equal to the Node text). |
| `inject_gate.ups_event` | `UserPromptSubmit` |  |  | The event whose dispatch counts as one turn of the session. |

### session.toml / session

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `session.anti_hall_dir` | `.anti-hall` |  |  | The per-project directory that holds progress, history and handovers. |
| `session.anti_hall_marker` | `plugins/anti-hall/.claude-plugin/plugin.json` |  |  | The file whose presence in the working directory marks the anti-hall repository itself (the maintainer's view). |
| `session.archive_dir` | `archive` |  |  | Archived defects, relative to the defect store; one directory per month. |
| `session.archive_entry` | `\n## Archived progress (pruned {pruned_at})\n\n{quote}\n` |  |  | What is appended to the history ledger for one pruned progress file; {pruned_at} is the UTC time and {quote} the quoted content. |
| `session.case_reload` | `reload` |  |  | The case name stored in the reload advisory's dedupe key. |
| `session.case_update` | `update` |  |  | The case name stored in the update advisory's dedupe key. |
| `session.changelog_file` | `CHANGELOG.md` |  |  | The changelog of a mirrored release, relative to its directory. |
| `session.check_ignore_args` | `check-ignore, -q, .anti-hall/probe` |  |  | The git arguments (after -C <root>) that ask whether .anti-hall/ is ignored: exit 0 ignored, 1 not ignored. |
| `session.claim_max_digits` | `15` |  |  | The most digits of a claimed count compared here; a longer one is rounded by JavaScript, so the hook defers. |
| `session.claude_cli_baseline` | `2.1.238` |  |  | The Claude Code version the harness KB was last audited against (hooks/lib/claude-cli-baseline.js); a test keeps the two equal. |
| `session.claude_cli_cache` | `.anti-hall/claude-cli-version.json` |  |  | The Claude CLI version cache the background probe writes, under the home directory. |
| `session.claude_cli_guard` | `claude-cli-version` |  |  | The guard id of claude-cli-version, in its messages and in the skip file. |
| `session.claude_cli_instead` | `see docs/KB-claude-code-harness-features.md.` |  |  | Advice of the Claude CLI drift advisory. |
| `session.claude_cli_summary` | `SessionStart advisory: the Claude Code CLI drifted by major or minor from the...` |  |  | One-line description of the claude-cli-version check in the generated reference. |
| `session.claude_cli_what` | `Claude Code CLI {installed} is installed; anti-hall's harness KB is audited a...` |  |  | Headline of the Claude CLI drift advisory; {installed}, {baseline} and {newer} (the older-suffix or nothing). |
| `session.cwd_key_prefix` | `cwd_` |  |  | Prefix of the throttle key made from a working directory. |
| `session.day_ms` | `86400000` |  | ms | Milliseconds in a day, for the UTC date arithmetic of the hooks. |
| `session.defect_backfill` | `backfill` |  |  | The line type of a defect imported from git history. |
| `session.defect_closed` | `fixed, wontfix, notabug, dup` |  |  | The statuses that mean a defect is finished (everything else is unfinished work). |
| `session.defect_ext` | `.jsonl` |  |  | The extension of a defect file. |
| `session.defect_fixed` | `fixed` |  |  | The ruling status that opens the regression cycle. |
| `session.defect_maintainer_instead` | `run /anti-hall:defects.` |  |  | Advice of the maintainer's nudge. |
| `session.defect_maintainer_what` | `{active} unfinished defect reports ({regressed} regressed), oldest {oldest}d.` |  |  | Headline of the maintainer's nudge; {active}, {regressed} and {oldest} are counts and days. |
| `session.defect_nudge_guard` | `defect-nudge` |  |  | The guard id of defect-nudge, in its messages and in the skip file. |
| `session.defect_nudge_summary` | `SessionStart advisory, at most daily: unfinished defect reports (in the anti-...` |  |  | One-line description of the defect-nudge check in the generated reference. |
| `session.defect_open` | `open` |  |  | The status of a defect nobody has ruled on. |
| `session.defect_regressed` | `regressed` |  |  | The derived status of a fixed defect reported again by a build at or after its fix. |
| `session.defect_report` | `report` |  |  | The line type of a report. |
| `session.defect_reporter_instead` | `run /anti-hall:defects mine.` |  |  | Advice of the reporter's nudge. |
| `session.defect_reporter_what` | `rulings on {count} defects you reported.` |  |  | Headline of the reporter's nudge; {count} is the number of defects with a later ruling. |
| `session.defect_ruling` | `ruling` |  |  | The line type of a ruling. |
| `session.defect_stamp` | `.defects-nudge-stamp.json` |  |  | The once-a-day stamp of the defect sweep, relative to the state directory. |
| `session.defect_throttle_ms` | `86400000` |  | ms | The least time between two defect sweeps. |
| `session.defects_dir` | `defects` |  |  | The defect store, relative to the state directory. |
| `session.devswarm_baseline` | `2.5.1` |  |  | The DevSwarm CLI version anti-hall's integration was verified against (hooks/lib/devswarm-baseline.js); a test keeps the two equal. |
| `session.devswarm_cache` | `.anti-hall/devswarm-version.json` |  |  | The DevSwarm version cache the background probe writes, under the home directory. |
| `session.devswarm_guard` | `devswarm-version` |  |  | The guard id of devswarm-version, in its messages and in the skip file. |
| `session.devswarm_instead` | `see docs/KB-devswarm-hivecontrol.md.` |  |  | Advice of the DevSwarm drift advisory. |
| `session.devswarm_summary` | `SessionStart advisory: the DevSwarm CLI drifted by major or minor from the ve...` |  |  | One-line description of the devswarm-version check in the generated reference. |
| `session.devswarm_what` | `DevSwarm {installed} is installed; anti-hall's integration is verified agains...` |  |  | Headline of the DevSwarm drift advisory; {installed}, {baseline} and {newer} (the older-suffix or nothing). |
| `session.dot_git` | `.git` |  |  | The name that marks a git checkout's root. |
| `session.drift_cache_ttl_ms` | `86400000` |  | ms | How long a drift probe's cache (claude-cli-version, devswarm-version, repo-self-drift) counts as fresh; an older one makes Node refresh it, which defers the engine's answer. |
| `session.drift_counts_line` | `anti-hall repo self-drift — {parts} (docs/KB.md)` |  |  | The count-drift advisory line; {parts} are the differing counts. |
| `session.drift_hooks_part` | `hooks: KB.md claims {claimed}, actual {actual}` |  |  | The hook-count part of the count-drift line. |
| `session.drift_skills_part` | `skills: KB.md claims {claimed}, actual {actual}` |  |  | The skill-count part of the count-drift line. |
| `session.drift_stale_line` | `anti-hall model KBs last audited {date} ({age}d ago, threshold {threshold}d) ...` |  |  | The model-KB staleness advisory line; {date}, {age} and {threshold} are the audit date and the days. |
| `session.drift_why` | `Behavior may have drifted.` |  |  | The Why line of the DevSwarm and Claude CLI drift advisories. |
| `session.event` | `SessionStart` |  |  | The only event these hooks run on, and the event name in the advisory envelope they print. |
| `session.git_binary` | `git` |  |  | The git program the gitignore probe runs, found on the PATH the client forwarded. |
| `session.git_poll_ms` | `5` |  | ms | How often the gitignore probe checks whether git has finished. |
| `session.git_scrub_env` | `GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_PREFIX` |  |  | Environment variables removed before git runs, so the answer derives from the project directory alone. |
| `session.gitdir_tag` | `gitdir:` |  |  | The prefix of the single line of a `.git` file that points at the real git directory. |
| `session.gitignore_guard` | `gitignore-hint` |  |  | The guard id of the gitignore reminder in its message. |
| `session.gitignore_instead` | `add `.anti-hall/` to .gitignore (or run /anti-hall:doctor --repair).` |  |  | Advice of the gitignore reminder. |
| `session.gitignore_probe_ms` | `1000` | `AH_ENGINE_GITIGNORE_PROBE_MS` | ms | The longest the engine waits for the gitignore probe before it hands the hook to Node. Node waits 3000 ms, but the client gives up on the engine after client.deadline_ms, so a longer wait here could answer after the client has already left; a test keeps the shipped value below that deadline. |
| `session.gitignore_remind_ms` | `604800000` |  | ms | The least time between two gitignore reminders for one project. |
| `session.gitignore_state_file` | `gitignore-hint-state.json` |  |  | The per-project gitignore reminder state, relative to the state directory. |
| `session.gitignore_what` | `.anti-hall/ is not git-ignored in this repo.` |  |  | Headline of the gitignore reminder. |
| `session.gitignore_why` | `Session notes must never be committed.` |  |  | Why line of the gitignore reminder. |
| `session.headline_max` | `160` |  |  | The longest changelog highlight quoted, in UTF-16 units. |
| `session.highlight_prefix` | `Highlight: ` |  |  | The prefix of the changelog highlight line. |
| `session.history_dir` | `history` |  |  | Backfilled history, relative to the defect store or to the project's .anti-hall directory (the progress ledger). |
| `session.hooks_claim_re` | `Hooks:\s*\*\*(\d+)\*\*\s*`\.js`\s*files` |  |  | Regex source (JavaScript syntax) of the hook count docs/KB.md claims; the first group is the number. |
| `session.hooks_dir` | `hooks` |  |  | The hooks directory, relative to the plugin root. |
| `session.js_ext` | `.js` |  |  | The extension that makes a file in the hooks directory count as a hook. |
| `session.judge_child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | The environment variable that marks the judge child process, inside which every hook is a silent no-op (judge-child-exit.js). |
| `session.judge_child_on` | `1` |  |  | The value of the judge-child variable that turns the no-op on. |
| `session.kb_installed` | `docs/KB.md` |  |  | Where docs/KB.md sits in an installed plugin, relative to the plugin root. |
| `session.kb_repo` | `../../docs/KB.md` |  |  | Where docs/KB.md sits in the development repository (three levels above the hooks directory), relative to the plugin root. |
| `session.marketplace_dir` | `.claude/plugins/marketplaces/anti-hall` |  |  | The marketplace clone, under the home directory; the host's plugin registry sits two levels above it. |
| `session.marketplace_env` | `ANTIHALL_MARKETPLACE_DIR` |  |  | The environment variable that points the update skill at another marketplace directory (used by its tests); honoured only for an absolute path to an existing directory. |
| `session.md_ext` | `.md` |  |  | The extension of a progress or history file. |
| `session.mirror_cache_root` | `.claude/plugins/cache/anti-hall/anti-hall` |  |  | Where the update skill mirrors each release, one version-named directory each, under the home directory. |
| `session.model_kb_audit_date` | `2026-09-03` |  |  | The UTC date (YYYY-MM-DD) the model KBs were last audited (hooks/lib/repo-audit-baseline.js); a test keeps the two equal. |
| `session.older_suffix` | ` (newer)` |  |  | Appended to a drift advisory when the installed version is OLDER than the audited baseline. |
| `session.parts_sep` | `; ` |  |  | Separator between the parts of the count-drift line. |
| `session.plugin_json` | `.claude-plugin/plugin.json` |  |  | The running plugin's manifest, relative to the plugin root. |
| `session.progress_dir` | `progress` |  |  | Per-session progress files, relative to the project's .anti-hall directory; one directory per UTC date. |
| `session.progress_prune_summary` | `SessionStart maintenance: archives stale per-session progress files into the ...` |  |  | One-line description of the progress-prune check in the generated reference. |
| `session.progress_skip` | `legacy, INDEX.md` |  |  | Entries of the progress directory that are never pruned. |
| `session.progress_state_file` | `progress-prune-state.json` |  |  | The per-directory prune throttle state, relative to the state directory. |
| `session.prune_safety_ms` | `21600000` |  | ms | A progress file modified more recently than this is never archived. |
| `session.prune_throttle_ms` | `86400000` |  | ms | The least time between two prune passes of one working directory. |
| `session.quote_prefix` | `> ` |  |  | Prefix of every archived line (a Markdown block quote). |
| `session.registry_file` | `installed_plugins.json` |  |  | The host's plugin registry, relative to the plugins root. |
| `session.registry_key` | `anti-hall@anti-hall` |  |  | The registry key of this plugin. |
| `session.registry_max_bytes` | `4194304` |  | bytes | The largest registry file read (a bigger one counts as unreadable). |
| `session.reload_instead` | `tell the user now: run /reload-plugins (Claude; restart Claude Code if a hook...` |  |  | Advice for that case when the registry does not name a newer build than the running one. |
| `session.reload_instead_ahead` | `tell the user now: run /reload-plugins to load it (if a hook or skill path st...` |  |  | Advice for that case when the registry already names a newer build than the running one ({running} is the running version). |
| `session.reload_mark_file` | `.anti-hall/version-alert-reload.json` |  |  | The once-per-session marker of the reload advisory, under the home directory (separate from the remote-latest cache). |
| `session.reload_what` | `v{mirrored} is already downloaded (you are running v{running}).` |  |  | Headline when a newer release is already mirrored and the registry is up to date; {mirrored} and {running} are the two versions. |
| `session.repo_self_drift_cache` | `.anti-hall/repo-self-drift.json` |  |  | The repo-self-drift scan cache, under the home directory. |
| `session.repo_self_drift_guard` | `repo-self-drift` |  |  | The guard id of repo-self-drift, in the skip file. |
| `session.repo_self_drift_summary` | `SessionStart advisory: docs/KB.md's claimed hook and skill counts differ from...` |  |  | One-line description of the repo-self-drift check in the generated reference. |
| `session.setting_claude_cli` | `5 entries` |  |  | Switch: alert when the Claude Code CLI drifted from the audited version (versionAlerts.claudeCli). |
| `session.setting_defect_nudge` | `5 entries` |  |  | Switch: the once-a-day note about the defect channel (context.defectNudge); it has no environment variable. |
| `session.setting_devswarm` | `5 entries` |  |  | Switch: alert when the DevSwarm CLI drifted from the verified version (versionAlerts.devswarm). |
| `session.setting_gitignore_hint` | `5 entries` |  |  | Switch: the weekly reminder to git-ignore .anti-hall/ (guards.gitignoreHint). |
| `session.setting_progress_prune` | `5 entries` |  |  | Switch: archive stale per-session progress files into the history ledger (maintenance.progressPrune); it has no environment variable. |
| `session.setting_repo_self_drift` | `5 entries` |  |  | Switch: anti-hall's own repo-drift self-check (guards.repoSelfDrift). |
| `session.setting_version_alert` | `5 entries` |  |  | Switch: alert when a newer anti-hall release is available (versionAlerts.antiHall). |
| `session.skills_claim_re` | `Claude\s*\n?>?\s*skills:\s*\*\*(\d+)\*\*` |  |  | Regex source (JavaScript syntax) of the skill count docs/KB.md claims; the first group is the number. |
| `session.skills_dir` | `skills` |  |  | The skills directory, relative to the plugin root. |
| `session.staleness_threshold_days` | `60` |  |  | How many days after the audit the model KBs count as stale (hooks/lib/repo-audit-baseline.js); a test keeps the two equal. |
| `session.state_dir` | `.anti-hall` |  |  | The anti-hall state directory, under the home directory. |
| `session.unregistered_instead` | `tell the user now: run /anti-hall:update (Claude; syncs the cache AND the har...` |  |  | Advice for that case. |
| `session.unregistered_what` | `v{mirrored} is downloaded locally (you are running v{running}) but the Claude...` |  |  | Headline when a newer release is mirrored but the host has not registered it. |
| `session.unregistered_why` | `A reload alone will not pick it up until the harness registers it.` |  |  | Why line for that case. |
| `session.update_instead` | `tell the user now: run /anti-hall:update (Claude) or the anti-hall-update ski...` |  |  | Advice for that case. |
| `session.update_what` | `v{latest} is available (you are running v{running}).` |  |  | Headline when the remote-latest cache names a newer release; {latest} and {running} are the two versions. |
| `session.version_alert_guard` | `version-alert` |  |  | The guard id of version-alert, in its messages and in the skip file. |
| `session.version_alert_summary` | `SessionStart advisory: a newer anti-hall release is available or already mirr...` |  |  | One-line description of the version-alert check in the generated reference. |
| `session.version_alert_ttl_ms` | `7200000` |  | ms | How long the remote-latest cache counts as fresh (a release can ship within a day, so this is short). |
| `session.version_check_file` | `.anti-hall/version-check.json` |  |  | The remote-latest cache the background refresh writes, under the home directory. |

### response_guards.toml / claim_ledger

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `claim_ledger.cls_hard` | `hard` |  |  | The class of a flag that would block once blocking is turned on. |
| `claim_ledger.cls_soft` | `soft` |  |  | The class of a flag that would only nudge. |
| `claim_ledger.context_chars` | `160` |  |  | How many UTF-16 units of the line around a flagged token are recorded. |
| `claim_ledger.count_re` | `(\d{1,6}(?:[.,]\d+)?)\s*(ms\|s\|sec\|seconds\|minutes\|min\|hours\|days?\|weeks?\|work...` |  |  | Regex source (case-insensitive) of a count with a unit noun. The Node source starts with a look-behind that rejects a number glued to an identifier character; the check applies that rule by hand, because the regex engine has no look-behind. |
| `claim_ledger.days_ago_re` | `\b\d+\s+days?\s+ago\b` |  |  | Regex source (case-insensitive) of an N days ago claim. |
| `claim_ledger.dir` | `claim-ledger` |  |  | Directory of the ledger files under the state directory. |
| `claim_ledger.event` | `Stop` |  |  | The only event this check answers. |
| `claim_ledger.guard_name` | `claim-ledger` |  |  | The guard id this check answers to in skip.json. |
| `claim_ledger.jev_false` | `supported by evidence` |  |  | The label for a false answer of the claimLedger question. |
| `claim_ledger.jev_id` | `claimLedger` |  |  | The Jev integration id of the shadow question asked for each flagged claim. |
| `claim_ledger.jev_instructions` | `Is this claim unsupported by evidence in the message (no matching value/SHA/s...` |  |  | The Noul question text of the claimLedger shadow ask (byte-identical to the Node hook's). |
| `claim_ledger.jev_true` | `unsupported by evidence` |  |  | The label for a true answer of the claimLedger question. |
| `claim_ledger.kind_count` | `count` |  |  | The kind of a flag for a count with a unit noun. |
| `claim_ledger.kind_days_ago` | `days-ago` |  |  | The kind of a flag for an N days ago claim. |
| `claim_ledger.kind_sha` | `sha` |  |  | The kind of a flag for a git SHA. |
| `claim_ledger.kind_state` | `state-no-tool` |  |  | The kind of a flag for a runtime-state claim made in a turn with no tool call. |
| `claim_ledger.kind_task` | `task` |  |  | The kind of a flag for a task N of claim. |
| `claim_ledger.last_ext` | `.last` |  |  | Extension of the file that holds the hash of the last message recorded for a session. |
| `claim_ledger.ledger_ext` | `.jsonl` |  |  | Extension of the per-session ledger of flagged claims (one JSON line per flagged reply). |
| `claim_ledger.max_flags` | `40` |  |  | Most flags recorded for one reply. |
| `claim_ledger.number_re` | `\d[\d,]*(?:\.\d+)?` |  |  | Regex source of a number in the evidence (thousands separators allowed). |
| `claim_ledger.role_assistant` | `assistant` |  |  | The role of an assistant transcript entry. |
| `claim_ledger.role_attachment` | `attachment` |  |  | The role of a hook attachment transcript entry. |
| `claim_ledger.role_user` | `user` |  |  | The role of a user transcript entry. |
| `claim_ledger.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.claimLedger, default on). |
| `claim_ledger.sha_re` | `\b[0-9a-f]{7,40}\b` |  |  | Regex source of a git SHA (7 to 40 lower-case hex digits). |
| `claim_ledger.state_re` | `\b(?:still\|currently)\s+(?:running\|live\|active\|pending\|blocked)\b` |  |  | Regex source (case-insensitive) of a runtime-state claim. |
| `claim_ledger.summary` | `Stop, never blocks: records the checkable claims of the last reply that no ev...` |  |  | One-line description of the claim-ledger check in the generated reference. |
| `claim_ledger.task_re` | `\btask\s+\d+\s+of\b` |  |  | Regex source (case-insensitive) of a task N of claim. |
| `claim_ledger.type_text` | `text` |  |  | The content block type of a text block. |
| `claim_ledger.type_tool_result` | `tool_result` |  |  | The content block type of a tool result. |
| `claim_ledger.type_tool_use` | `tool_use` |  |  | The content block type of a tool call. |
| `claim_ledger.window_bytes` | `2097152` |  | bytes | How much of the end of the transcript counts as evidence (a huge transcript cannot slow the hook). |

### response_guards.toml / output_verify

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `output_verify.bit_exit` | `a non-zero exit code ({code})` |  |  | One signal of the advisory; {code} is the exit code. |
| `output_verify.bit_fail` | `a failure signal ({hit})` |  |  | One signal of the advisory; {hit} is the quoted failing text. |
| `output_verify.bit_pass` | `a passing signal ({hit})` |  |  | One signal of the advisory; {hit} is the quoted passing text. |
| `output_verify.bits_sep` | ` AND ` |  |  | What joins the signals in the advisory headline. |
| `output_verify.blob_fields` | `tool_response, tool_output` |  |  | The payload fields the scanned text is built from, in order. |
| `output_verify.count_marker` | `(\d+)` |  |  | Text in a signal pattern that marks a captured count: such a pattern only hits on a non-zero count, so a clean summary like 0 failed is not a failure. |
| `output_verify.env_assign_re` | `^[A-Za-z_][A-Za-z0-9_]*=` |  |  | Regex source of a leading environment assignment word, which is skipped. |
| `output_verify.event` | `PostToolUse` |  |  | The only event this check answers. |
| `output_verify.exit_code_re` | `exit[_ ]?code["']?\s*[:=]\s*(-?\d+)` |  |  | Regex source (case-insensitive) of an exit code written as text in the output. |
| `output_verify.exit_fields` | `exit_code, exitCode, exit_status, exitStatus` |  |  | The fields of an object tool response that may hold the exit code, in the order they are tried. |
| `output_verify.fail_patterns` | `10 items` |  |  | The failing signals, in the order they are tried: regex source, case-insensitive flag, and whether it must start a line. |
| `output_verify.guard_name` | `output-verify-guard` |  |  | The guard id this check answers to in skip.json, in messages and as the once-per-turn key. |
| `output_verify.jev_false` | `not a genuine mixed result` |  |  | The label for a false answer of the outputVerifyGuard question. |
| `output_verify.jev_id` | `outputVerifyGuard` |  |  | The Jev integration id of the shadow question asked for each test-runner output. |
| `output_verify.jev_instructions` | `Does this test-runner output show a GENUINELY mixed pass/fail result (some te...` |  |  | The Noul question text of the outputVerifyGuard shadow ask (byte-identical to the Node hook's). |
| `output_verify.jev_state_chars` | `4000` |  |  | How many UTF-16 units of the output the outputVerifyGuard shadow ask evaluates (Node: blob.slice(0, 4000)). |
| `output_verify.jev_true` | `genuinely mixed pass/fail` |  |  | The label for a true answer of the outputVerifyGuard question. |
| `output_verify.line_terminators` | `\n  ` |  |  | The characters after which a pattern anchored to the start of a line may match (JavaScript's multi-line anchor). |
| `output_verify.msg_instead` | `before reporting "tests pass" / "build succeeded", re-read the full output an...` |  |  | Advisory advice. |
| `output_verify.msg_what` | `this Bash command's output contains {bits} in the same run (advisory, not a b...` |  |  | Advisory headline; {bits} are the signals found. |
| `output_verify.msg_why` | `A mixed summary is not a clean pass.` |  |  | Advisory reason. |
| `output_verify.once_setting` | `6 entries` |  |  | Where the once-per-turn switch is read from (guards.outputVerifyOncePerTurn, default on). |
| `output_verify.pass_patterns` | `8 items` |  |  | The passing signals, in the order they are tried: regex source, case-insensitive flag, and whether it must start a line. |
| `output_verify.path_sep_re` | `[\\/]` |  |  | Regex source of a path separator; the last part of a command word is its verb, so /usr/bin/pytest counts as pytest. |
| `output_verify.run_word` | `run` |  |  | The optional word between a package manager and its test script (npm run test). |
| `output_verify.runner_subcommands` | `7 entries` |  |  | Command verbs that are test runners with this first argument (an optional run word may come before it). |
| `output_verify.runner_verbs` | `pytest, jest, vitest, cargo` |  |  | Command verbs that are test runners on their own. |
| `output_verify.scan_cap` | `200000` |  |  | Longest scanned text, in UTF-16 units; a longer one is cut to its head and its tail so the trailing summary line survives. |
| `output_verify.segment_split_re` | `&&\|\\|\\|\|[;&\|\n]` |  |  | Regex source that splits a command into simple commands (and, or, semicolon, ampersand, pipe, newline). |
| `output_verify.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.outputVerifyGuard, default on). |
| `output_verify.sig_sep` | `\|` |  |  | What joins the signals into the once-per-turn signature. |
| `output_verify.summary` | `PostToolUse advisory: flags a test-runner output with both a passing and a fa...` |  |  | One-line description of the output-verify-guard check in the generated reference. |
| `output_verify.tool` | `Bash` |  |  | The only tool whose output is read. |
| `output_verify.truncation_marker` | `\n...(truncated)...\n` |  |  | What joins the head and the tail of a cut scan text. |
| `output_verify.ws_split_re` | `\s+` |  |  | Regex source that splits a simple command into words. |

### response_guards.toml / reply_turn_gate

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `reply_turn_gate.agent_prefix` | `agent:` |  |  | Prefix of the turn id of a subagent payload: a subagent's turn is its own whole run. |
| `reply_turn_gate.dir` | `turn-gate` |  |  | Directory of the gate's state files under the state directory. |
| `reply_turn_gate.injected_re` | `^\s*<(?:task-notification\|system-reminder\|local-command\|command-name\|command-...` |  |  | Regex source of the text an injected block starts with (notifications and reminders), which is never a human prompt. |
| `reply_turn_gate.main_agent` | `main` |  |  | The agent part of a slot key for the main agent (a payload without an agent id). |
| `reply_turn_gate.max_sigs` | `16` |  |  | How many signatures one slot remembers for a turn (the oldest beyond this are dropped). |
| `reply_turn_gate.prefix` | `tg` |  |  | Family name of a gate state file (`<prefix>-<session>.json`, the sanitised session id and the JSON extension follow); also the family name of its stale-file sweep, which appends the dash itself. |
| `reply_turn_gate.session_max` | `80` |  |  | Longest session part of a gate state file name, in UTF-16 units. |
| `reply_turn_gate.sig_max` | `200` |  |  | Longest advisory signature kept, in UTF-16 units. |
| `reply_turn_gate.tail_bytes` | `524288` |  | bytes | How much of the end of the transcript is read to find the newest human prompt. |
| `reply_turn_gate.type_text` | `text` |  |  | The content block type of a text block. |
| `reply_turn_gate.type_tool_result` | `tool_result` |  |  | The content block type of a tool result: an entry holding one is not a human prompt. |
| `reply_turn_gate.type_user` | `user` |  |  | The type of a user transcript entry. |
| `reply_turn_gate.user_marker` | `"user"` |  |  | Text a transcript line must contain to be considered as a human prompt (a cheap filter before parsing). |

### response_guards.toml / replykit

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `replykit.json_ext` | `.json` |  |  | File extension of the JSON state files (also the suffix the stale-file sweep looks for). |
| `replykit.json_max_depth` | `256` |  |  | Deepest JSON nesting the state-file parser reads; deeper input is left to the Node hook, which has a larger stack. |
| `replykit.prune_stamp_prefix` | `.prune-stamp-` |  |  | Prefix of the stamp file that records the last sweep of stale state files of one writer (the writer's own prefix and the JSON extension follow). |
| `replykit.prune_throttle_ms` | `21600000` |  | ms | The sweep of stale state files runs at most once per this long for each writer (6 hours). |
| `replykit.prune_ttl_ms` | `604800000` |  | ms | A per-session state file untouched for this long is removed by the sweep (7 days: long enough that no live session is ever swept). |
| `replykit.role_assistant` | `assistant` |  |  | The role value of an assistant transcript entry. |
| `replykit.state_dir` | `.anti-hall` |  |  | The per-user state directory under the home directory, where the guards keep their state files. |
| `replykit.unsure_parse_errors` | `surrogate, hex escape, recursion limit, out of range` |  |  | Fragments of the JSON parser's error text that mark input the Node hook might still parse (a lone surrogate escape or a short hex escape, a number beyond the double range, nesting beyond the recursion limit): the whole call is then left to Node instead of the line being skipped. |

### response_guards.toml / speculation_guard

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `speculation_guard.ack_ci` | `13 items` |  |  | Regex sources (case-insensitive) of the acknowledgments that make hedging honest: any one in the reply lifts the block. |
| `speculation_guard.ack_cs` | `\b\w+\.\w+:\d+\b` |  |  | Regex sources (case-sensitive) of the acknowledgments that make hedging honest: a file:line citation such as main.js:42. |
| `speculation_guard.backtick_re` | ``[^`\n]+`` |  |  | Regex source of an inline code span. |
| `speculation_guard.curly_double_re` | `“[^“”\n]*”` |  |  | Regex source of a curly double-quoted span. |
| `speculation_guard.curly_single_re` | `‘[^‘’\n]*’` |  |  | Regex source of a curly single-quoted span. |
| `speculation_guard.event` | `Stop` |  |  | The only event this check answers. |
| `speculation_guard.fence_line_re` | `^[ \t]{0,3}(`{3,}\|~{3,})` |  |  | Regex source of a code fence line; the first group is the fence marker. |
| `speculation_guard.frame_heading` | `^\s*#{1,6}\s+(.+?)\s*#*\s*$` |  |  | Regex source of a markdown heading line; group 1 is its text. |
| `speculation_guard.frame_heading_label` | `^LABEL\b` |  |  | Regex source (case-insensitive) a heading's text must start with to frame what is under it (the token LABEL is replaced by frame_label). |
| `speculation_guard.frame_inline` | `\(unverified\)\|\bnot yet measured\b` |  |  | Regex source (case-insensitive) of an inline frame on the hit's own line. |
| `speculation_guard.frame_label` | `(?:expected\|plan\|should\s+be\s+\w+\|should\s+still(?:\s+\w+)?\|unverified\|not\s...` |  |  | Regex source of the labels that frame a hedge as an expectation or a plan (Node: FRAME_LABEL_CORE). |
| `speculation_guard.frame_line_prefix` | `^\s*(?:(?:[-*+\u2022]\|\d+[.)])\s+)?LABEL\s*[:)]` |  |  | Regex source of a line that starts with a frame label, with an optional list marker (the token LABEL is replaced by frame_label); case-insensitive. |
| `speculation_guard.framed_false` | `Genuine expectation/plan: a test-plan entry, acceptance criterion, or hypothe...` |  |  | The label for a false answer of the framed-expectation question. |
| `speculation_guard.framed_instructions` | `This hedge sits under a heading or line labelled as a plan/expectation (e.g. ...` |  |  | The Noul question of the framed-expectation ask (byte-identical to the Node hook's FRAMED_JEV_QUESTION). |
| `speculation_guard.framed_true` | `Unverified claim presented as fact: despite the label, it asserts what IS tru...` |  |  | The label for a true answer of the framed-expectation question. |
| `speculation_guard.guard_name` | `speculation-guard` |  |  | The guard id this check answers to in skip.json and in messages. |
| `speculation_guard.inference_setting` | `6 entries` |  |  | The switch of the causal-claim scan (guards.inferenceCheck, default off); the scan reads tool evidence and stays on Node, so with the switch on a reply without a hedge is left to Node. |
| `speculation_guard.jev_false` | `Not speculative: it reports what a tool actually showed (command output such ...` |  |  | The label for a false answer of the speculation question. |
| `speculation_guard.jev_framed_id` | `speculationFramed` |  |  | The Jev integration id of the framed-expectation question (relax-block trust). |
| `speculation_guard.jev_id` | `speculation` |  |  | The Jev integration id of the speculation question (add-block trust). |
| `speculation_guard.jev_instructions` | `Is this assistant message speculative, i.e. does it assert a cause or an outc...` |  |  | The Noul question of the speculation ask (byte-identical to the Node hook's JEV_QUESTION). |
| `speculation_guard.jev_state_chars` | `8000` |  |  | How many UTF-16 units of the reply the two Jev asks evaluate (Node: jevText.slice(0, 8000)). |
| `speculation_guard.jev_true` | `Speculative: it asserts a cause, a fix, or a done/works/passes/resolved outco...` |  |  | The label for a true answer of the speculation question. |
| `speculation_guard.judge_log` | `logs/jev-judge.ndjson` |  |  | The speculation guard's own Jev decision log, relative to the anti-hall home directory (Node: logs/jev-judge.ndjson); holds no message text and no key. |
| `speculation_guard.judge_log_max_bytes` | `1048576` |  | bytes | The judge log is emptied before an append once it is larger than this (Node: JEV_LOG_MAX_BYTES). |
| `speculation_guard.markers` | `15 items` |  |  | Regex sources (case-insensitive) of the hedge words that assert something as probably true without evidence, in the order they are tried. |
| `speculation_guard.max_blocks` | `3` |  |  | Most blocks per session: after this many the guard stays quiet whatever the reply says (the text changes as the model reworks it, which defeats the per-text dedupe). |
| `speculation_guard.modal_markers` | `must be, should be` |  |  | Lower-cased hedge matches that may state a requirement instead of a guess; each occurrence is judged on its own. |
| `speculation_guard.msg_instead` | `verify it with a tool, or say what is unverified ('I don't know, here is what...` |  |  | Block advice. |
| `speculation_guard.msg_what` | `your reply states something speculative ('{marker}') without verifying it or ...` |  |  | Block headline; {marker} is the hedge found. |
| `speculation_guard.msg_what_jev` | `your reply asserts a cause or outcome without citing evidence (command output...` |  |  | Block headline when Jev added the block. |
| `speculation_guard.msg_why` | `Unverified claims read as facts.` |  |  | Block reason. |
| `speculation_guard.obligation_re` | `^\s+(measured\|verified\|tested\|checked\|reviewed\|documented\|validated\|approved\|...` |  |  | Regex source (case-insensitive) of what follows a must-be or should-be that names a real obligation, which is a requirement and not a guess. |
| `speculation_guard.obligation_window` | `40` |  |  | How many UTF-16 units after a must-be or should-be are read for the obligation word. |
| `speculation_guard.outcome_evidence` | `evidence-added` |  |  | Outcome recorded for the previous block when this reply carries an acknowledgment. |
| `speculation_guard.outcome_override` | `user-override` |  |  | Outcome recorded for the previous block when the user skipped the guard. |
| `speculation_guard.outcome_repeat` | `repeat-speculation` |  |  | Outcome recorded for the previous block when this reply hedges again. |
| `speculation_guard.prune_prefix` | `speculation-guard-state` |  |  | Prefix of the stale-file sweep of the per-session state files. |
| `speculation_guard.quote_char` | `"` |  |  | The straight double quote that pairs within one line. |
| `speculation_guard.quote_line_re` | `^[ \t]{0,3}>` |  |  | Regex source of a blockquote line (up to three spaces of indent, then a greater-than sign). |
| `speculation_guard.quote_separators` | `2 entries, 2 entries, 2 entries, 2 entries` |  |  | Where a blockquote line turns from the quoted material to the session's own words (an em dash, a double hyphen between spaces, a semicolon or comma then so); the earliest wins. |
| `speculation_guard.requirement_line_re` | `^\s*(?:(?:[-*+•]\|\d+[.)])\s+)?(?:requirement\|acceptance(?:\s+criteria)?\|ac\|sp...` |  |  | Regex source (case-insensitive) of a line that starts with an explicit requirement label, after an optional list bullet. |
| `speculation_guard.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.speculationGuard, default on). |
| `speculation_guard.source_jev` | `jev` |  |  | The source recorded in the pending outcome of a block Jev added. |
| `speculation_guard.source_regex` | `regex` |  |  | The source recorded in the pending outcome of a block this check made (the Node hook reads it when it reports the outcome). |
| `speculation_guard.state_prefix` | `speculation-guard-state-` |  |  | Prefix of the per-session state file name under the state directory (the sanitised session id and the JSON extension follow). |
| `speculation_guard.straight_re` | `"[^"\n]*"` |  |  | Regex source of a straight-quoted span inside one line. |
| `speculation_guard.summary` | `Stop gate: blocks once per reply that states something with a hedge word and ...` |  |  | One-line description of the speculation-guard check in the generated reference. |
| `speculation_guard.window_bytes` | `524288` |  | bytes | How much of the end of the transcript is read to find the last assistant message when the payload does not carry it. |

### response_guards.toml / speculation_judge

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `speculation_judge.child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | The environment variable the judge's own `claude -p` child carries; a hook that runs inside the child does nothing (no recursion). |
| `speculation_judge.child_value` | `1` |  |  | The value of the judge-child variable that means this process is the judge's child. |
| `speculation_judge.event` | `Stop` |  |  | The only event this check answers. |
| `speculation_judge.guard_name` | `speculation-judge` |  |  | The guard id this check answers to in skip.json. |
| `speculation_judge.setting` | `6 entries` |  |  | Where the opt-in switch is read from (jev.semanticJudge, default off). |
| `speculation_judge.summary` | `Stop: the opt-in semantic judge; answers every path without a model call, and...` |  |  | One-line description of the speculation-judge check in the generated reference. |

### agent_controls.toml / agent_scan

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `agent_scan.agent_tool` | `Agent` |  |  | Name of the tool whose input carries the description of a launched agent. |
| `agent_scan.delivery_tools` | `TaskOutput, SendMessage` |  |  | Tools whose tool_result can deliver an agent's result. |
| `agent_scan.empty_object` | `{}` |  |  | What JSON.stringify gives for a missing tool input. |
| `agent_scan.inbox_phrase` | `'s inbox` |  |  | Phrase of the result of a message sent to a teammate's inbox. |
| `agent_scan.json_unsupported` | `recursion limit, out of range` |  |  | Fragments of a JSON parser error that mean the text is JSON to JavaScript but not to serde (nesting past the parser's limit, a number past f64 range); such a line defers to the Node hook. |
| `agent_scan.launch_text` | `Async agent launched successfully` |  |  | Text a launch tool_result begins with. |
| `agent_scan.launch_tools` | `Agent, Task` |  |  | Tools whose tool_result can be a launch of an agent. |
| `agent_scan.not_a_report_keys` | `12 items` |  |  | Keys the host stamps on records that come from a person, a queue, a tool result or a compaction, and never on a real teammate report (NOT_A_REPORT_KEYS). |
| `agent_scan.notification_tag` | `<task-notification>` |  |  | The opening tag of a completion notice. |
| `agent_scan.object_string` | `[object Object]` |  |  | What String() gives for an object. |
| `agent_scan.pending_silence_ms` | `1200000` |  | ms | How long a teammate with an unanswered message still counts as running without a sign of life (PENDING_MESSAGE_SILENCE_MS of hooks/lib/agent-scan.js). |
| `agent_scan.prefilter` | `10 entries` |  |  | Substrings that decide whether a transcript line is parsed at all: a launch, a completion notice, an Agent or TaskStop tool call (with and without a space after the colon), a tool result, a tool use, a task_status attachment and a teammate idle notice. |
| `agent_scan.queued_phrase` | `Message queued for delivery to` |  |  | Phrase of the result of a message queued for a running agent. |
| `agent_scan.re_agent_id` | `agentId:\s*([0-9a-fA-F]{6,40})` |  |  | JavaScript regex source of the agent id in a launch result. |
| `agent_scan.re_hex_id` | `^[0-9a-fA-F]{6,40}$` |  |  | Rust regex source of a whole agent id. |
| `agent_scan.re_hex_run` | `[0-9a-fA-F]{7,40}` |  |  | Rust regex source of a run of hex digits that may name an agent by prefix. |
| `agent_scan.re_inbox_send` | `^Message sent to (.+)'s inbox$` |  |  | JavaScript regex source of the message of a send to a teammate's inbox. |
| `agent_scan.re_iso_date` | `^([0-9]{4})-([0-9]{2})-([0-9]{2})$` |  |  | Rust regex source of the ISO date alone (read as UTC midnight). |
| `agent_scan.re_iso_datetime` | `^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0...` |  |  | Rust regex source of the ISO date-time with an explicit zone that the scan reads itself; other timestamp forms defer to the Node hook. |
| `agent_scan.re_notification_block` | `(?s)<task-notification>(.*?)</task-notification>` |  |  | Rust regex source of one completion notice block, lazily to the first closing tag. |
| `agent_scan.re_notification_in_reminder` | `<system-reminder>\s*<task-notification>` |  |  | JavaScript regex source of a completion notice directly inside a system reminder. |
| `agent_scan.re_output_file` | `output_file:\s*(\S+)` |  |  | JavaScript regex source of the output file in a launch result. |
| `agent_scan.re_queued_message` | `^Message queued for delivery to\s` |  |  | JavaScript regex source of the message of a send to a running agent. |
| `agent_scan.re_resume_message` | `^Resuming\s+agent\s+([0-9a-fA-F]{6,40})` |  |  | JavaScript regex source (case-insensitive) of the start of a resume message. |
| `agent_scan.re_running_row` | `·\s*running\b` |  |  | JavaScript regex source (case-insensitive) of a status row that says an agent is still running. |
| `agent_scan.re_status` | `<status>([^<]*)</status>` |  |  | Rust regex source of the status inside a notice. |
| `agent_scan.re_surrogate_escape` | `\\u[dD][89a-fA-F][0-9a-fA-F]{2}` |  |  | Rust regex source of an escape for a UTF-16 surrogate half: JavaScript reads a lone one, serde does not, so text that holds one and fails to parse defers to the Node hook. |
| `agent_scan.re_task_id` | `<task-id>([^<]*)</task-id>` |  |  | Rust regex source of the task id inside a notice. |
| `agent_scan.re_teammate_block` | `(?s)\A<teammate-message teammate_id="([^"]+)"[^>]*>\n(.*?)\n</teammate-message>` |  |  | Rust regex source of one teammate message block at the start of the text, lazily to the first closing line. |
| `agent_scan.report_future_skew_ms` | `5000` |  | ms | How far past its own entry a teammate report's inner timestamp may lie before the report is treated as forged (REPORT_FUTURE_SKEW_MS). |
| `agent_scan.resume_skew_slack_ms` | `2000` |  | ms | How far before a resume record a terminal notice may be stamped and still stand (RESUME_SKEW_SLACK_MS). |
| `agent_scan.resume_tools` | `SendMessage, Agent, Task` |  |  | Tools whose tool_result can be a resume of an agent. |
| `agent_scan.resumed_key` | `resumedAgentId` |  |  | Field of a resume tool_result that holds the full agent id. |
| `agent_scan.resuming_word` | `Resuming` |  |  | Word a resume tool_result carries. |
| `agent_scan.retain_bytes` | `8388608` |  | bytes | Most text of tool results the scan keeps for its delivered-but-unnotified safety net; a scan that would keep more defers to the Node hook so the daemon's memory stays bounded. |
| `agent_scan.safe_int` | `9007199254740991` |  |  | Largest integer JavaScript prints exactly (2^53 - 1); a tool input holding a number outside it is judged by the Node hook, whose number text differs. |
| `agent_scan.send_tools` | `SendMessage` |  |  | Tools whose tool_result can be a message sent to a teammate's inbox. |
| `agent_scan.sidechain_key` | `isSidechain` |  |  | The one key of the list above that only counts when it is true. |
| `agent_scan.sidechain_prefix` | `agent-a` |  |  | Prefix of a subagent transcript's file name. |
| `agent_scan.stop_tool` | `TaskStop` |  |  | Name of the tool that stops an agent. |
| `agent_scan.subagents_dir` | `subagents` |  |  | Directory, beside a transcript's own name, that holds the transcripts of its subagents. |
| `agent_scan.tail_bytes` | `1572864` |  | bytes | Bytes read from the end of a transcript by the default scan (MAX_TAIL_BYTES of hooks/lib/transcript-tail.js). |
| `agent_scan.teammate_report_prefix` | `Another Claude session sent a message:` |  |  | Text a teammate report entry begins with. |
| `agent_scan.transcript_ext` | `.jsonl` |  |  | Extension of a transcript file. |
| `agent_scan.undefined_string` | `undefined` |  |  | What String() gives for a missing value. |
| `agent_scan.utc_suffix` | ` UTC` |  |  | Suffix of a clock time in a note. |
| `agent_scan.wide_tail_bytes` | `12582912` |  | bytes | Bytes read by the one widened scan that proves a zero running-agent count on a transcript longer than the default window (WIDE_TAIL_BYTES of hooks/lib/agent-scan.js). |

### agent_controls.toml / ask_guard

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `ask_guard.advise_instead` | `take the recommended option, say which you took, and continue; list anything ...` |  |  | What to do instead, in the standing-rule advice. |
| `ask_guard.advise_what` | `do not hold work on a question.` |  |  | Headline of the standing-rule advice. |
| `ask_guard.block_allowed` | `a question about a destructive or irreversible action, with the question head...` |  |  | What stays allowed, in the block message. |
| `ask_guard.block_instead` | `decide the recommended option yourself, state it in your reply, and continue;...` |  |  | What to do instead, in the block message. |
| `ask_guard.block_what` | `AskUserQuestion blocked by guards.noBlockingQuestions.` |  |  | Headline of the block message. |
| `ask_guard.block_why` | `Work should not wait on a question.` |  |  | Why line of the block message. |
| `ask_guard.child_env` | `DEVSWARM_SOURCE_BRANCH` |  |  | Environment variable whose non-blank value marks a child workspace. |
| `ask_guard.child_text` | `\nChild workspace: send the question to your parent with `devswarm.js send --...` |  |  | Sentence appended in a child workspace, which asks its parent instead of the user. |
| `ask_guard.guard_name` | `ask-guard` |  |  | The guard id this check answers to in skip.json and in messages. |
| `ask_guard.log_event` | `marker-allowed` |  |  | Event name of a logged marker. |
| `ask_guard.log_file` | `.anti-hall/logs/ask-guard.ndjson` |  |  | NDJSON log of allowed question markers, relative to the home directory. |
| `ask_guard.marker_re` | `^(DESTRUCTIVE\|CREDENTIAL):` |  |  | Rust regex source of the marker a question starts with when it is allowed in block mode. |
| `ask_guard.mode_setting` | `7 entries` |  |  | Where the question mode is read from (guards.noBlockingQuestions: off, advise or block; default off). |
| `ask_guard.note_control_re` | `[\x00-\x1f\x7f]+` |  |  | Rust regex source of the control characters collapsed to a space in an agent description. |
| `ask_guard.note_desc_max` | `60` |  |  | Longest description, in UTF-16 units, the in-flight note shows for an agent. |
| `ask_guard.note_head` | ` background agent` |  |  | Text after the count in the in-flight note. |
| `ask_guard.note_join` | `; ` |  |  | Separator between agent names in the note. |
| `ask_guard.note_many` | `s are` |  |  | Suffix and verb of the note for several agents. |
| `ask_guard.note_max_listed` | `5` |  |  | Most agents the in-flight note names. |
| `ask_guard.note_mid` | ` still in flight (` |  |  | Text between the verb and the agent names in the note. |
| `ask_guard.note_more` | `, +{n} more` |  |  | Template of the tail of the agent list; {n} is how many more there are. |
| `ask_guard.note_one` | ` is` |  |  | Verb of the note for one agent. |
| `ask_guard.note_setting` | `6 entries` |  |  | Where the in-flight agents note switch is read from (guards.questionAgentsNote, default on). |
| `ask_guard.note_tail` | `). They may act on one of these options before the answer arrives: pause them...` |  |  | Text that ends the in-flight note. |
| `ask_guard.note_unnamed` | `unnamed agent` |  |  | Name the in-flight note gives an agent with no description. |
| `ask_guard.summary` | `Advises on or blocks a question put to the user, and notes background agents ...` |  |  | One-line description of the ask-guard check in the generated reference. |
| `ask_guard.tool` | `AskUserQuestion` |  |  | The tool this check answers. |

### agent_controls.toml / guardkit

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `guardkit.js_decimal_re` | `^[+-]?(?:[0-9]+\.?[0-9]*\|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$` |  |  | Rust regex source of the text JavaScript's Number() reads as a decimal number (the hexadecimal, octal and binary forms are read separately). |

### agent_controls.toml / silent_nudge

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `silent_nudge.ack_dir` | `.anti-hall/stop-ack` |  |  | Directory of the per-session stop-ack files, relative to the home directory. |
| `silent_nudge.ack_file_ext` | `.json` |  |  | Extension of a stop-ack file. |
| `silent_nudge.ack_file_prefix` | `stop-ack-` |  |  | Prefix of a stop-ack file name, before the sanitized session id. |
| `silent_nudge.ack_hint` | `Override (only if the user explicitly confirmed this exact condition is fine)...` |  |  | The override sentence appended to the nudge (stop-ack.js ackHint); {key} is hook:signature, {now} the time, {path} the ack file. |
| `silent_nudge.ack_no_session` | `nosession` |  |  | Session part of a stop-ack file name when there is no session id. |
| `silent_nudge.ack_sep` | `:` |  |  | Separator between the hook name and the signature in a stop-ack key. |
| `silent_nudge.ack_session_max` | `128` |  |  | Longest sanitized session id in a stop-ack file name, in characters. |
| `silent_nudge.ack_setting` | `6 entries` |  |  | Where the stop-ack switch is read from (guards.stopAck, default on; hooks/lib/stop-ack.js). |
| `silent_nudge.ack_subject_sep` | `,` |  |  | Separator between the sorted agent ids the stop-ack signature is computed over. |
| `silent_nudge.agents_dir` | `.anti-hall/agents` |  |  | Directory of subagent heartbeat files, relative to the home directory. |
| `silent_nudge.control_re` | `[\x00-\x1f\x7f-\u{9f}]` |  |  | Rust regex source of the control characters turned into spaces in a name the nudge shows. |
| `silent_nudge.ellipsis` | `…` |  |  | Text appended to a name that was cut. |
| `silent_nudge.ever_key` | `everNudged` |  |  | Field of the state file that holds the once-per-agent records. |
| `silent_nudge.ever_nudged_ttl_ms` | `2592000000` |  | ms | How long a once-per-agent nudge record is kept (30 days). |
| `silent_nudge.ever_sep` | `::` |  |  | Separator between session id and agent id in a once-per-agent key. |
| `silent_nudge.expecting` | `a JSON object` |  |  | Parser error text for a state file member that is not a JSON object. |
| `silent_nudge.finished_words` | `done complete completed finished stopped success succeeded error failed` |  |  | Heartbeat statuses (case-insensitive, whole text) that mean the agent finished. |
| `silent_nudge.guard_name` | `silent-agent-nudge` |  |  | The guard id this check answers to in skip.json. |
| `silent_nudge.heartbeat_ext` | `.json` |  |  | Extension of a heartbeat file. |
| `silent_nudge.heartbeat_skip_name` | `recent-spawn.json` |  |  | Name of the orchestration-live marker that shares the heartbeat directory and is never a heartbeat. |
| `silent_nudge.heartbeat_skip_prefix` | `devswarm-` |  |  | Prefix of the DevSwarm tooling files that share the heartbeat directory and are never heartbeats. |
| `silent_nudge.judge_child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | Environment variable that, set to its marker value, makes every hook a no-op (the judge child's hooks must never run). |
| `silent_nudge.judge_child_value` | `1` |  |  | Value of the judge-child variable that disables the hook. |
| `silent_nudge.key_heartbeat` | `h:` |  |  | Prefix of a heartbeat-sourced nudge key. |
| `silent_nudge.key_transcript` | `t:` |  |  | Prefix of a transcript-sourced nudge key. |
| `silent_nudge.label_max` | `60` |  |  | Longest agent description, id or heartbeat step, in UTF-16 units, the nudge names (oneLine's max). |
| `silent_nudge.max_named` | `3` |  |  | How many silent agents the nudge names before it says how many more there are (MAX_NAMED). |
| `silent_nudge.min_default` | `20` |  |  | Minutes of silence used when the setting is not a number of at least 1 (DEFAULT_MIN of the hook). |
| `silent_nudge.min_setting` | `7 entries` |  |  | Where the silence threshold in minutes is read from (guards.silentAgentNudgeMin, default 20, at least 1). |
| `silent_nudge.missing` | `missing` |  |  | Snapshot of an agent whose output file is missing. |
| `silent_nudge.msg_allowed` | `set ANTIHALL_SILENT_AGENT_NUDGE=off to silence this nudge` |  |  | Allowed-here line of the nudge. |
| `silent_nudge.msg_instead` | `check on {them} (TaskOutput), or re-dispatch with tighter scope if dead (Task...` |  |  | Do-instead line of the nudge; {them} is the pronoun for one agent or several. |
| `silent_nudge.msg_item` | `{label} — silent {mins}m` |  |  | One named silent agent in the nudge. |
| `silent_nudge.msg_item_sep` | `; ` |  |  | Text between two named silent agents. |
| `silent_nudge.msg_more` | `, +{n} more` |  |  | Tail of the list when more agents are silent than are named. |
| `silent_nudge.msg_what` | `{count} of your own background subagent(s) have gone silent past the {min}m t...` |  |  | Headline of the nudge. |
| `silent_nudge.msg_why` | `Advisory only; nothing was auto-killed.` |  |  | Why line of the nudge. |
| `silent_nudge.nudged_key` | `nudged` |  |  | Field of the state file that holds the per-snapshot records. |
| `silent_nudge.pronoun_many` | `them` |  |  | The pronoun for several silent agents. |
| `silent_nudge.pronoun_one` | `it` |  |  | The pronoun for one silent agent. |
| `silent_nudge.resume_mark` | `@r` |  |  | Marker between an agent id or snapshot and the resume time. |
| `silent_nudge.scan_bytes` | `67108864` |  | bytes | Bytes of the transcript tail the check scans (NUDGE_SCAN_BYTES). |
| `silent_nudge.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.silentAgentNudge, default on). |
| `silent_nudge.sidechain_file_prefix` | `agent-` |  |  | Prefix of an agent's own sidechain transcript file name. |
| `silent_nudge.signature_len` | `16` |  |  | Hex characters of the SHA-1 a stop-ack signature keeps. |
| `silent_nudge.state_file` | `.anti-hall/silent-agent-nudge-state.json` |  |  | Nudge state file, relative to the home directory. |
| `silent_nudge.summary` | `Stop: nudges once per silent background agent (the block text, the nudge stat...` |  |  | One-line description of the silent-agent-nudge check in the generated reference. |
| `silent_nudge.version_gate_setting` | `6 entries` |  |  | Where the stale-build downgrade switch is read from (guards.stopHookVersionDowngrade, default on; hooks/lib/stop-version-gate.js). |

### agent_controls.toml / stale_note

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `stale_note.control_re` | `[\x00-\x1f\x7f-\u{9f}]` |  |  | Rust regex source of the control characters turned into spaces in a name. |
| `stale_note.ellipsis` | `…` |  |  | Text appended to a name that was cut. |
| `stale_note.guard_name` | `stale-stop` |  |  | The guard id this check shows in its advisory. |
| `stale_note.msg_instead` | `advisory only; the stop is not blocked.` |  |  | What the advisory says about the stop. |
| `stale_note.msg_pending_a` | ` was sent a message at ` |  |  | Text between the quoted name and the send time in the headline for a teammate sent a message. |
| `stale_note.msg_pending_b` | `, after its last report` |  |  | Text between the send time and the last report time in that headline. |
| `stale_note.msg_pending_c` | `, and has not reported since.` |  |  | Text that ends that headline. |
| `stale_note.msg_pending_last` | ` ({time})` |  |  | Template of the last report time, appended to the headline; {time} is the clock time. |
| `stale_note.msg_pending_seen` | ` Its own transcript was last written {min} min ago.` |  |  | Template appended to the why line when the teammate's own transcript was written after the send; {min} is how many minutes ago. |
| `stale_note.msg_pending_why` | `It may be working on that message.` |  |  | Why line for a teammate sent a message. |
| `stale_note.msg_resumed_a` | ` was resumed at ` |  |  | Text between the quoted name and the resume time in the headline for a resumed background agent. |
| `stale_note.msg_resumed_b` | `, after its last report, and has not reported since.` |  |  | Text that ends that headline. |
| `stale_note.msg_resumed_why` | `It may be working.` |  |  | Why line for a resumed background agent. |
| `stale_note.name_max` | `60` |  |  | Longest agent name or id, in UTF-16 units, the advisory shows. |
| `stale_note.scan_bytes` | `67108864` |  | bytes | Bytes of the transcript tail the check reads (the send can sit well before the shared 1.5 MB window). |
| `stale_note.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.staleAgentStopNote, default on). |
| `stale_note.summary` | `Advisory: a TaskStop on an agent that was sent a message or resumed after its...` |  |  | One-line description of the stale-agent-stop-note check in the generated reference. |
| `stale_note.tool` | `TaskStop` |  |  | The tool this check answers. |

### spawn_guards.toml / devswarm_comms

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `devswarm_comms.agent_id_re` | `^a[0-9a-f]{4,}(?:-[0-9a-f-]+)?$` |  |  | A background agent's raw id: a, then hex digits, optionally dash-separated groups (JavaScript regex, case-insensitive). |
| `devswarm_comms.coordinator_target` | `main` |  |  | The SendMessage target that is the session's own coordinator address, not a peer. |
| `devswarm_comms.disable_env` | `DISABLE_ANTIHALL_DEVSWARM` |  |  | Environment variable that, set to its off value, switches the DevSwarm integration off. |
| `devswarm_comms.disable_value` | `1` |  |  | The value of the disable variable that switches the DevSwarm integration off. |
| `devswarm_comms.guard_name` | `devswarm-comms-guard` |  |  | Guard name in the block message and the skip file. |
| `devswarm_comms.label_name` | `devswarm-comms` |  |  | Guard name in the advisory labels. |
| `devswarm_comms.msg_block_instead` | `use the DevSwarm mesh: `node plugins/anti-hall/scripts/devswarm.js send --to ...` |  |  | What to do instead of the blocked send. |
| `devswarm_comms.msg_block_what` | `SendMessage target "{to}" resolves to a DevSwarm workspace-backed peer sessio...` |  |  | What the block says; {to} is the target and {cwd} the peer session's directory. |
| `devswarm_comms.msg_block_why` | `Direct Claude remote-agent messaging between a DevSwarm Primary/child and a w...` |  |  | Why the block applies. |
| `devswarm_comms.msg_main_what` | `SendMessage target "main" is this session's own coordinator address, not a cr...` |  |  | What the label says for the coordinator address. |
| `devswarm_comms.msg_ok_what` | `target "{to}" resolves to a live session (cwd: {cwd}) that is not a DevSwarm ...` |  |  | What the label says for a live peer session that is not a workspace; {to} is the target and {cwd} the session's directory. |
| `devswarm_comms.ref_re` | `^(.*?)\s*\[[0-9a-f]{4,16}\]\s*$` |  |  | A target with a trailing bracketed reference such as `name [3fa9c1]`; group 1 is the bare name (JavaScript regex, case-insensitive). |
| `devswarm_comms.repo_id_env` | `DEVSWARM_REPO_ID` |  |  | Environment variable DevSwarm sets in a session it runs; in auto mode its presence means DevSwarm is active. |
| `devswarm_comms.repos_root` | `.devswarm/repos` |  |  | The DevSwarm workspace registry root, relative to the home directory. |
| `devswarm_comms.session_file_suffix` | `.json` |  |  | Suffix of a session index file. |
| `devswarm_comms.sessions_dir` | `.claude/sessions` |  |  | Where the host keeps one JSON file per session, relative to the home directory. |
| `devswarm_comms.setting` | `6 entries` |  |  | The switch devswarm.commsGuard (on by default); off makes the guard a no-op. |
| `devswarm_comms.summary` | `Blocks SendMessage to a peer session whose cwd is a DevSwarm workspace while ...` |  |  | One-line description of the devswarm-comms-guard check in the generated reference. |
| `devswarm_comms.supervisor_setting` | `7 entries` |  |  | The setting devswarm.supervisorMode (auto, on or off): whether DevSwarm counts as active for this session. |
| `devswarm_comms.tool` | `SendMessage` |  |  | The only tool this guard decides on. |

### spawn_guards.toml / swarm_guard

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `swarm_guard.agent_type_fields` | `subagent_type, agentType, agent_type` |  |  | Spawn input fields that name the agent type, first non-empty one wins (the trip log label). |
| `swarm_guard.allow_fields` | `tools, allowed_tools, allowedTools` |  |  | Spawn input fields that list the tools an agent may use, first non-empty one wins. |
| `swarm_guard.deny_fields` | `disallowedTools, disallowed_tools` |  |  | Spawn input fields that list the tools an agent may not use, first non-empty one wins. |
| `swarm_guard.exact_int_limit` | `9007199254740992` |  |  | The largest integer a JavaScript number prints exactly in decimal (2 to the 53rd); a spawn log holding a larger entry is left to the Node hook. |
| `swarm_guard.guard_name` | `swarm-guard` |  |  | Guard name in the block message and the skip file. |
| `swarm_guard.isolation_values` | `worktree, remote` |  |  | Values of the spawn's isolation field that give the agent its own working tree, lower-case. |
| `swarm_guard.lock_boot_slop_s` | `5` |  | s | Two boot times closer than this many seconds are the same boot (the uptime clock has whole-second resolution). |
| `swarm_guard.lock_file` | `swarm-spawns.lock` |  |  | The lock that serializes the read-count-append of the spawn log. |
| `swarm_guard.lock_reclaim_stale_ms` | `5000` |  | ms | A lock-takeover marker older than this belongs to a reclaimer that died and may be taken over. |
| `swarm_guard.lock_release_step_ms` | `10` |  | ms | The pause between those tries. |
| `swarm_guard.lock_release_tries` | `5` |  |  | How many times releasing the lock tries to take the takeover marker before it removes its own lock unguarded. |
| `swarm_guard.lock_stale_ms` | `5000` |  | ms | A spawn-log lock older than this is taken over, whatever its holder. |
| `swarm_guard.lock_step_ms` | `5` |  | ms | The pause between attempts to take the spawn-log lock. |
| `swarm_guard.lock_wait_ms` | `50` |  | ms | How long a spawn waits for the spawn-log lock before it is allowed unrecorded (the guard never deadlocks a spawn). |
| `swarm_guard.log_file` | `swarm-spawns.log` |  |  | The spawn log: one millisecond timestamp per allowed spawn. |
| `swarm_guard.mem_floor_percent` | `4` |  |  | A spawn is blocked when available memory is below this percent of total memory. |
| `swarm_guard.meminfo_available_re` | `MemAvailable:\s+(\d+)\s+kB` |  |  | The available-memory line of the Linux memory report, in kB (JavaScript regex). |
| `swarm_guard.meminfo_path` | `/proc/meminfo` |  |  | The Linux memory report. |
| `swarm_guard.meminfo_total_key` | `MemTotal:` |  |  | The total-memory line prefix of the Linux memory report, in kB. |
| `swarm_guard.msg_mem` | `anti-hall swarm-guard: memory pressure critical ({avail} MB available of {tot...` |  |  | The block reason for critical memory pressure; {avail} and {total} are megabytes. |
| `swarm_guard.msg_rate_instead` | `pause new agents and let running ones finish, then launch the next wave; resp...` |  |  | What to do instead of spawning past the cap. |
| `swarm_guard.msg_rate_what` | `agent spawn-rate ceiling reached ({count} spawns in the last 60s, cap is {cap}).` |  |  | What the rate block says; {count} is the spawns in the window and {cap} the cap. |
| `swarm_guard.msg_rate_why` | `A runaway swarm can make the OS unusable.` |  |  | Why the rate block applies. |
| `swarm_guard.msg_shared_instead` | `pass isolation:"worktree", serialize them, or give each its own scratch clone.` |  |  | What to do instead, when the repo does not forbid worktrees. |
| `swarm_guard.msg_shared_instead_no_worktrees` | `serialize them or give each its own scratch clone.` |  |  | What to do instead, when the repo forbids worktrees. |
| `swarm_guard.msg_shared_what` | `another write-capable agent is still running in this working tree, and this s...` |  |  | What the shared-tree advisory says. |
| `swarm_guard.msg_shared_why` | `Two such agents can stage and commit each other's uncommitted changes.` |  |  | Why the shared-tree advisory applies. |
| `swarm_guard.proc_pidns` | `/proc/self/ns/pid` |  |  | The Linux link that names this process's pid namespace. |
| `swarm_guard.proc_uptime` | `/proc/uptime` |  |  | The Linux file that holds the uptime in seconds. |
| `swarm_guard.re_in_place` | `\bin\s+place\b\|\bin\s+(?:the\s+)?(?:session\s+)?repo\b\|\brepo\s+files\b\|\b(?:...` |  |  | JavaScript regex source (case-insensitive): a statement that the spawn works in place in the session repo, which cancels the scratch reading. |
| `swarm_guard.re_no_worktrees` | `\bno\s+(?:git\s+)?worktrees?\b` |  |  | JavaScript regex source (case-insensitive) matched against the CLAUDE.md / AGENTS.md files of the repo: a rule that forbids worktrees, which drops the isolation hint from the advisory. |
| `swarm_guard.re_scratch_negated` | `\b(?:not\|no\|without\|instead\s+of)\s+(?:in\s+\|a\s+\|the\s+\|any\s+)?scratch\b` |  |  | JavaScript regex source (case-insensitive): a negated scratch statement, which cancels the scratch reading. |
| `swarm_guard.read_only_types` | `13 items` |  |  | Agent types that cannot edit files (their definitions exclude the editing tools), lower-case. |
| `swarm_guard.repo_docs` | `CLAUDE.md, AGENTS.md` |  |  | The files read at each directory level when looking for the no-worktrees rule. |
| `swarm_guard.repo_docs_levels` | `8` |  |  | How many directory levels up from the spawn's working directory the rule search climbs at most. |
| `swarm_guard.scratch_alternatives` | `\bwork(?:ing)?\s+(?:in\\|inside)\s+(?:a\\|an\\|the\\|your)?\s*scratch\s+(?:clone\...` |  |  | JavaScript regex sources, joined with \| and matched case-insensitively against the spawn's prompt and description: the statements that establish a scratch working location outside the session's git tree. |
| `swarm_guard.scratch_path` | `[\x60'"]?(?:\/private\/tmp\/\|\/tmp\/\|\/var\/folders\/\|[^\s\x60'"]*scratchpad\b)` |  |  | JavaScript regex source for a scratch location in a spawn prompt (a /tmp, /private/tmp, /var/folders or scratchpad path); {path} in the scratch alternatives is replaced by it. |
| `swarm_guard.setting` | `6 entries` |  |  | The switch safety.swarmGuard (on by default); off makes the guard a no-op. |
| `swarm_guard.shared_tree_label` | `shared-tree` |  |  | Guard name in the shared-tree advisory. |
| `swarm_guard.shared_tree_setting` | `6 entries` |  |  | The switch guards.sharedTreeAgentNote (on by default): the advisory for a write-capable spawn that shares a working tree with a running write-capable agent. |
| `swarm_guard.spawn_cap` | `20` |  |  | How many agent spawns are allowed inside the window before the next one is blocked. |
| `swarm_guard.state_dir` | `.anti-hall` |  |  | The directory of the spawn log, lock and trip log, relative to the home directory. |
| `swarm_guard.summary` | `Blocks an agent spawn past the spawn-rate cap or under critical memory pressu...` |  |  | One-line description of the swarm-guard check in the generated reference. |
| `swarm_guard.sysctl_boottime` | `kern.boottime` |  |  | The macOS sysctl name that holds the boot time (the lock records it to tell machines apart). |
| `swarm_guard.sysctl_memsize` | `hw.memsize` |  |  | The macOS sysctl name that holds the total physical memory in bytes. |
| `swarm_guard.trip_file` | `swarm-trips.log` |  |  | The trip log: one line per blocked spawn, never read by the rate decision. |
| `swarm_guard.unknown_label` | `unknown` |  |  | The spawn label in the trip log when the payload names no tool. |
| `swarm_guard.vm_default_page_size` | `4096` |  |  | The page size assumed when the memory tool does not print one. |
| `swarm_guard.vm_labels` | `free, inactive, speculative` |  |  | The page kinds that count as available memory (reclaimable on demand). |
| `swarm_guard.vm_page_size_re` | `page size of (\d+) bytes` |  |  | The page size line of the memory tool's output (JavaScript regex). |
| `swarm_guard.vm_pages_re` | `Pages {label}:\s+(\d+)` |  |  | A pages line of the memory tool's output, with {label} replaced by free, inactive or speculative (JavaScript regex). |
| `swarm_guard.vm_stat_path` | `/usr/bin/vm_stat` |  |  | The macOS tool that reports memory pages (an absolute path, so a changed PATH cannot shadow it). |
| `swarm_guard.vm_stat_poll_ms` | `2` |  | ms | How often the wait for the memory tool checks whether it has finished. |
| `swarm_guard.vm_stat_timeout_ms` | `1500` |  | ms | How long the memory tool may run before the memory gate is skipped. |
| `swarm_guard.window_ms` | `60000` |  | ms | The rolling window the spawn cap counts in. |
| `swarm_guard.write_tools` | `edit, write, multiedit, notebookedit` |  |  | Tools that make an agent write-capable, lower-case. |
| `swarm_guard.write_tools_every` | `edit, write, multiedit` |  |  | The write tools a disallowed list must all contain for the agent to count as read-only. |

### session_gates.toml / jev_review

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `jev_review.headless_setting` | `6 entries` |  |  | The setting jev.recommendNoticeHeadless (off by default): show the recommend notice in a non-interactive run too. |
| `jev_review.latch_key` | `lastShownTs` |  |  | The key of the recommend notice latch that holds the time it was last shown. |
| `jev_review.latch_tmp_suffix` | `.tmp` |  |  | What the Node notice appends after the latch path, a dot and its process id to name the temporary file of an atomic write. |
| `jev_review.protocol_full` | `full` |  |  | The protocol level that turns the headless recommend notice on by default. |
| `jev_review.protocol_level_setting` | `7 entries` |  |  | The setting context.protocolLevel; while jev.recommendNoticeHeadless is not set anywhere, the full level turns the headless notice on. |
| `jev_review.recommend_latch_file` | `state/jev-recommend-notice.json` |  |  | The recommend notice latch, relative to the anti-hall directory: the time it was last shown. |
| `jev_review.recommend_notice` | `Tell the user now, verbatim, bold kept:\n**Recommended: enable Jev, the optio...` |  |  | The recommend-Jev notice the session receives (hooks/lib/jev-recommend.js: the directive line, then shortNotice()), byte for byte. |
| `jev_review.recommend_setting` | `6 entries` |  |  | The setting jev.recommendNotice (on by default): the one-in-30-days notice recommending Jev while it is off. |
| `jev_review.remind_every_ms` | `2592000000` |  | ms | How long after it was shown the recommend notice stays quiet. |
| `jev_review.summary` | `Stays silent when no session-start Jev notice can be due (Jev and the semanti...` |  |  | One-line description of the jev-review-reminder check in the generated reference. |

### session_gates.toml / jev_weekly

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `jev_weekly.decision_log` | `logs/jev-assist.ndjson` |  |  | The Jev decision log the weekly report reads, relative to the anti-hall directory; its rotated generations are this name plus a dot and a number. |
| `jev_weekly.latch_file` | `state/jev-weekly-notice.json` |  |  | The weekly latch, relative to the anti-hall directory: the time of the last check. |
| `jev_weekly.latch_key` | `lastCheckedTs` |  |  | The key of the weekly latch that holds the time of the last check. |
| `jev_weekly.latch_tmp_infix` | `.tmp.` |  |  | What the Node hook puts between the latch path and its process id to name the temporary file of an atomic write. |
| `jev_weekly.notice_setting` | `8 entries` |  |  | The setting jev.weeklyNotice (on by default; a legacy jev.json value is honoured). |
| `jev_weekly.period_ms` | `604800000` |  | ms | How often the scorecard check may run. |
| `jev_weekly.summary` | `Stays silent when the weekly Jev scorecard notice cannot be due (Jev off, not...` |  |  | One-line description of the jev-weekly-scorecard check in the generated reference. |

### session_gates.toml / repair_reload

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `repair_reload.cooldown_file` | `repair-on-reload.last.json` |  |  | The record of the last repair start, relative to the anti-hall directory. |
| `repair_reload.cooldown_ms` | `3600000` |  | ms | How long after a repair start no other one starts at the same plugin version. |
| `repair_reload.guard_name` | `repair-on-reload` |  |  | Hook name in the skip file. |
| `repair_reload.migration_keys` | `11 items` |  |  | The keys of the data migrations a reload repairs (the non-opt-in migrations of companion/lib/migrations.js); a test compares this list with the Node one, so a migration added there fails the build until it is added here. |
| `repair_reload.setting` | `6 entries` |  |  | The switch maintenance.repairOnReload (on by default). |
| `repair_reload.summary` | `Stays silent when no repair can start (switch off, subagent turn, skipped, no...` |  |  | One-line description of the repair-on-reload check in the generated reference. |
| `repair_reload.version_re` | `^\d+\.\d+\.\d+$` |  |  | A plain three-part version (JavaScript regex). |

### session_gates.toml / session_gates

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `session_gates.agent_key_markers` | `agent_id, agent_type` |  |  | Payload keys whose presence (with a value other than null) marks a subagent turn. |
| `session_gates.allow_real_home_env` | `ANTIHALL_ALLOW_REAL_HOME_TEST` |  |  | Environment variable that lets a test run use the real home directory anyway. |
| `session_gates.anti_hall_dir` | `.anti-hall` |  |  | The anti-hall directory under the home directory. |
| `session_gates.child_branch_env` | `DEVSWARM_SOURCE_BRANCH` |  |  | Environment variable DevSwarm sets in a child workspace (a non-blank value marks the session as a child). |
| `session_gates.codex_fields` | `turn_id, model` |  |  | Payload fields that are both non-empty strings on every Codex turn. |
| `session_gates.codex_tool` | `apply_patch` |  |  | The tool name only Codex has; its presence marks a Codex payload. |
| `session_gates.default_event` | `SessionStart` |  |  | The hook event name an advisory carries when the payload names none (a non-empty string hook_event_name wins). |
| `session_gates.entrypoint_env` | `CLAUDE_CODE_ENTRYPOINT` |  |  | Environment variable that names how the host was started. |
| `session_gates.headless_prefix` | `sdk-` |  |  | Entry point names starting with this are non-interactive (SDK) runs. |
| `session_gates.jev_config_file` | `jev.json` |  |  | The legacy Jev configuration file, relative to the anti-hall directory. |
| `session_gates.jev_enabled_setting` | `8 entries` |  |  | The setting jev.enabled (off by default; a legacy jev.json value is honoured). |
| `session_gates.jev_semantic_judge_setting` | `6 entries` |  |  | The setting jev.semanticJudge (off by default). |
| `session_gates.judge_child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | Environment variable the judge child process runs with; every one of these hooks does nothing in it. |
| `session_gates.judge_child_value` | `1` |  |  | The value of that variable that marks the judge child. |
| `session_gates.sidechain_flags` | `isSidechain, is_sidechain` |  |  | Payload keys that mark a sidechain (subagent) turn when exactly true. |
| `session_gates.test_markers` | `NODE_TEST_CONTEXT, ANTIHALL_TEST, ANTIHALL_TEST_ISOLATION` |  |  | Environment variables that mark a test run; with one set, the Node hook refuses to use the real (password database) home directory (companion/lib/test-home-guard.js). |

### codex_handover.toml / codex_handover

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `codex_handover.agent_type_keys` | `subagent_type, agentType, agent_type` |  |  | The fields of a spawn that can name the agent type, in the order they are tried. |
| `codex_handover.argv_count` | `rev-list, --count, --since=@{since}, HEAD` |  |  | The git arguments that count the commits since a time; {since} is epoch seconds. |
| `codex_handover.argv_head` | `rev-parse, --short, HEAD` |  |  | The git arguments that print the short HEAD hash. |
| `codex_handover.argv_log` | `log, -1, --format=%h %s` |  |  | The git arguments that print the newest commit's short hash and subject. |
| `codex_handover.argv_porcelain` | `status, --porcelain` |  |  | The git arguments that list the dirty files for the resume freshness line. |
| `codex_handover.argv_status` | `status, --porcelain=v1, --branch` |  |  | The git arguments that list the branch line and the dirty files for a snapshot. |
| `codex_handover.argv_super` | `-C, {root}, rev-parse, --show-superproject-working-tree` |  |  | The git arguments that print the superproject checkout of a repository; {root} is the repository. |
| `codex_handover.avail_context_codex` | `Codex binary detected on PATH (per a SessionStart PATH probe). This is NECESS...` |  |  | The availability text for a Codex session (no Claude models, Workflow scripts or codex:codex-rescue agent type). |
| `codex_handover.avail_event` | `SessionStart` |  |  | The hook event name in the availability advisory. |
| `codex_handover.avail_guard` | `codex-availability` |  |  | The guard id the availability messages answer to. |
| `codex_handover.avail_instead` | `Workflow scripts have no filesystem and cannot read this fact, so pass args.c...` |  |  | Advice line of the availability tip. |
| `codex_handover.avail_note_instead` | `route correctness review to {tier} until then.` |  |  | Advice of the unavailability warning; {tier} is where to route the review. |
| `codex_handover.avail_note_what` | `Codex unavailable until {until} ({reason}).` |  |  | Headline of the warning that Codex is unavailable; {until} is an ISO time and {reason} the recorded reason. |
| `codex_handover.avail_source` | `path-probe` |  |  | The source recorded with a PATH probe result. |
| `codex_handover.avail_summary` | `SessionStart: probes PATH for a real codex executable, records it, folds a Co...` |  |  | One-line description of the codex-availability check in the generated reference. |
| `codex_handover.avail_tier_claude` | `Sonnet` |  |  | Where a Claude session routes review while Codex is unavailable. |
| `codex_handover.avail_tier_codex` | `a lower gpt tier` |  |  | Where a Codex session routes review while Codex is unavailable. |
| `codex_handover.avail_what` | `Codex binary detected on PATH (per a SessionStart PATH probe).` |  |  | Headline of the availability tip when the Codex binary is on PATH. |
| `codex_handover.avail_why` | `Necessary but not sufficient: it does not prove Codex is authenticated or fun...` |  |  | Reason line of the availability tip. |
| `codex_handover.availability_file` | `.anti-hall/codex-availability.json` |  |  | The shared Codex availability and quota file, relative to the home directory. |
| `codex_handover.branch_prefix` | `## ` |  |  | The prefix of the branch line of `git status --porcelain --branch`. |
| `codex_handover.branch_unknown` | `(unknown)` |  |  | The branch shown when git gives no branch line. |
| `codex_handover.cell_max` | `200` |  |  | Longest table cell in a snapshot, in UTF-16 units. |
| `codex_handover.checklist_title` | `Resume-verification checklist` |  |  | The heading text of a handover's resume-verification checklist (compared without case). |
| `codex_handover.codex_binary` | `codex` |  |  | The executable name probed on PATH. |
| `codex_handover.codex_dir_name` | `.codex` |  |  | The directory name that marks a Codex path. |
| `codex_handover.cooldown_default_label` | `(cooldown default)` |  |  | What the quota advisory says when the outage has no end time. |
| `codex_handover.core_worktree_key` | `worktree` |  |  | The key that, in a git directory's config, names a submodule checkout; a config holding it is left to the Node hook. |
| `codex_handover.date_max_ms` | `8640000000000000` |  | ms | The largest time a JavaScript Date holds, in milliseconds either side of the epoch. |
| `codex_handover.default_cooldown_ms` | `21600000` |  | ms | How long an outage with no usable end time is assumed to last. |
| `codex_handover.detail_files` | `state.md, decisions.md, trials.md, knowledge.md` |  |  | The detail files a handover may sit beside, in the order the resume lists them. |
| `codex_handover.detail_state` | `state.md` |  |  | The detail file that holds the task list snapshot. |
| `codex_handover.detail_trials` | `trials.md` |  |  | The detail file that holds the do-not-repeat list. |
| `codex_handover.details_sep` | ` / ` |  |  | Separator of the detail file names in the resume steps. |
| `codex_handover.detect_scan_cap` | `20000` |  |  | How much of a Codex result is searched for a quota message, in UTF-16 units. |
| `codex_handover.detect_summary` | `Advisory: records a Codex quota or rate-limit exhaustion reported by a codex:...` |  |  | One-line description of the codex-quota-detect check in the generated reference. |
| `codex_handover.git_binary` | `git` |  |  | The git executable the hooks run. |
| `codex_handover.git_max_buffer` | `1048576` |  | bytes | Most output a git call may produce before it counts as failed. |
| `codex_handover.git_poll_ms` | `2` |  | ms | How often a running git call is checked for completion. |
| `codex_handover.git_scrub_env` | `GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_PREFIX` |  |  | Git location variables removed before the identity resolver asks git, so its answer derives from the directory alone. |
| `codex_handover.gitdir_key` | `gitdir:` |  |  | The key of a `.git` file that names the real git directory. |
| `codex_handover.handover_plain` | `HANDOVER.md` |  |  | The name of the first handover of a session. |
| `codex_handover.handover_prefix` | `HANDOVER` |  |  | The start of a handover file name. |
| `codex_handover.handovers_dir` | `.anti-hall/handovers` |  |  | Where handovers and snapshots live, relative to the repository root. |
| `codex_handover.head_none` | `(no commits)` |  |  | The HEAD shown when the repository has no commit. |
| `codex_handover.identity_git_timeout_ms` | `10000` |  | ms | Time limit of the git call that finds a superproject. |
| `codex_handover.index_file` | `INDEX.md` |  |  | The handover index file name. |
| `codex_handover.index_sep` | `·` |  |  | The column separator of an INDEX.md row. |
| `codex_handover.index_seq_prefix` | `seq ` |  |  | The text before the sequence number in the sequence column of an INDEX.md row. |
| `codex_handover.iso_ms_tail` | `5` |  |  | How many characters the milliseconds and the zone end of an ISO time take (`.123Z`), which the writer note replaces by `Z`. |
| `codex_handover.job_log_suffix` | `.log` |  |  | The suffix of a Codex job log file name. |
| `codex_handover.job_logs_dir` | `jobs` |  |  | The directory of job logs inside each repository state directory. |
| `codex_handover.job_max_age_ms` | `86400000` |  | ms | Oldest job log that is scanned, by modification time. |
| `codex_handover.job_max_dirs` | `20` |  |  | How many repository job directories are scanned for a usage-limit error. |
| `codex_handover.job_max_files` | `10` |  |  | How many job logs are scanned for a usage-limit error. |
| `codex_handover.job_state_dir` | `.claude/plugins/data/codex-openai-codex/state` |  |  | Where the Codex companion keeps its background job state, relative to the home directory. |
| `codex_handover.job_tail_bytes` | `8192` |  | bytes | How much of the end of a job log is read. |
| `codex_handover.json_max_depth` | `512` |  |  | Deepest nesting of a state file the port reads; deeper is left to the Node hook. |
| `codex_handover.json_suffix` | `.json` |  |  | The suffix of a per-session state file name. |
| `codex_handover.judge_child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | Environment variable that marks a Jev judge child process, whose hooks do nothing. |
| `codex_handover.judge_child_on` | `1` |  |  | Value of the judge child variable that turns the hooks into no-ops. |
| `codex_handover.max_dirty_listed` | `50` |  |  | How many dirty files a snapshot lists. |
| `codex_handover.max_message_chars` | `4000` |  |  | Longest user message a snapshot keeps whole, in UTF-16 units. |
| `codex_handover.max_submodule_hops` | `32` |  |  | Most superproject levels the identity resolver climbs. |
| `codex_handover.max_user_messages` | `10` |  |  | How many of the last user messages a snapshot keeps. |
| `codex_handover.md_suffix` | `.md` |  |  | The suffix of a handover or snapshot file name. |
| `codex_handover.months` | `12 items` |  |  | Month names, lower case, in calendar order (a date string may use the full name or its first three letters). |
| `codex_handover.neg_instead` | `the handover skill writes under .anti-hall/handovers/; check there.` |  |  | Advice line when no handover exists at all. |
| `codex_handover.neg_what` | `No session handover found under .anti-hall/handovers/.` |  |  | Headline when no handover exists at all. |
| `codex_handover.neg_why` | `If one was written this session, it may be in the wrong location.` |  |  | Reason line when no handover exists at all. |
| `codex_handover.not_typed_re` | `^<(task-notification\|local-command-\|system-reminder\|bash-std(out\|err)\|command...` |  |  | JavaScript source of the harness-injected user entries that are not something the user typed. |
| `codex_handover.nudge_agent_re` | `^codex\b\|^codex:` |  |  | JavaScript source (flag i) of an agent type that is a Codex agent. |
| `codex_handover.nudge_agent_tools` | `Agent, Task` |  |  | Tool names that spawn an agent. |
| `codex_handover.nudge_allowed` | `skip it if the change is trivial, already reviewed, or Codex is unavailable.` |  |  | Allowed line of the Codex nudge. |
| `codex_handover.nudge_child_keys` | `content, message, messages, tool_uses, parts` |  |  | Keys under which a transcript entry nests further entries that may hold tool calls. |
| `codex_handover.nudge_code_ext_re` | `\.(js\|jsx\|mjs\|cjs\|ts\|tsx\|vue\|svelte\|dart\|py\|go\|rs\|java\|kt\|swift\|c\|cc\|cpp\|h\|hp...` |  |  | JavaScript source (flag i) of the file names that count as code for the Codex nudge. |
| `codex_handover.nudge_codex_word` | `codex` |  |  | The word in a skill call that marks a Codex review (compared without case). |
| `codex_handover.nudge_edit_tools` | `Edit, Write, MultiEdit` |  |  | Tool names whose calls count as code edits. |
| `codex_handover.nudge_guard` | `codex-nudge` |  |  | The guard id of the Codex nudge: its messages, its skip-file key and its escape hatch. |
| `codex_handover.nudge_instead` | `before calling it done, spawn a `codex:codex-rescue` agent (or run /codex:res...` |  |  | Advice line of the Codex nudge. |
| `codex_handover.nudge_jev_edits_label` | `edits: ` |  |  | The second line of the Codex nudge question's summary, before the edit count. |
| `codex_handover.nudge_jev_false` | `trivial — only comments/strings/log lines/formatting changed` |  |  | The criterion of a false answer to the Codex nudge question. |
| `codex_handover.nudge_jev_files` | `20` |  |  | How many edited file names the Codex nudge question's summary lists. |
| `codex_handover.nudge_jev_files_label` | `files: ` |  |  | The first line of the Codex nudge question's summary, before the file list. |
| `codex_handover.nudge_jev_id` | `codexNudgeSubstantial` |  |  | The Jev integration the Codex nudge consults. |
| `codex_handover.nudge_jev_instructions` | `This session is about to be nudged to get an independent Codex review because...` |  |  | The question the Codex nudge puts to Jev (a noul question; Node: the `instructions` of the codexNudgeSubstantial consult). |
| `codex_handover.nudge_jev_true` | `genuinely substantial — logic/behavior changed` |  |  | The criterion of a true answer to the Codex nudge question. |
| `codex_handover.nudge_max` | `2` |  |  | The most Codex nudges a session gets. |
| `codex_handover.nudge_min_default` | `3` |  |  | Edits needed before the Codex nudge fires when nothing sets the threshold. |
| `codex_handover.nudge_min_env` | `ANTIHALL_CODEX_NUDGE_MIN` |  |  | Environment variable of the Codex nudge threshold. |
| `codex_handover.nudge_min_floor` | `1` |  |  | Lowest value the Codex nudge threshold can take (a smaller setting is raised to it). |
| `codex_handover.nudge_min_key` | `min` |  |  | Settings key of the Codex nudge threshold (codexNudge.min). |
| `codex_handover.nudge_more` | `, …` |  |  | Text after the listed file names when there are more. |
| `codex_handover.nudge_names_sep` | `, ` |  |  | Separator of the file names the nudge lists. |
| `codex_handover.nudge_override` | `set ANTIHALL_CODEX_NUDGE=off to silence` |  |  | Override line of the Codex nudge. |
| `codex_handover.nudge_section` | `codexNudge` |  |  | Settings section of the Codex nudge threshold. |
| `codex_handover.nudge_session_hash_len` | `16` |  |  | Length of the transcript-path hash used as the session key when a payload has no session id. |
| `codex_handover.nudge_sig_sep` | `\|` |  |  | Separator of the sorted base names the nudge signature hashes. |
| `codex_handover.nudge_skill_tool` | `Skill` |  |  | The tool name that invokes a skill. |
| `codex_handover.nudge_state_prefix` | `codex-nudge-state` |  |  | The start of the Codex nudge per-session state file name (and the prune stamp key). |
| `codex_handover.nudge_summary` | `Stop: one soft nudge to get a Codex second opinion after several substantial ...` |  |  | One-line description of the codex-nudge check in the generated reference. |
| `codex_handover.nudge_tail_bytes` | `524288` |  | bytes | How much of the end of the transcript the Codex nudge reads. |
| `codex_handover.nudge_what` | `this session made {edits} substantial code edit(s) across {files} file(s) ({n...` |  |  | Headline of the Codex nudge; {edits} edits across {files} files, {names} the first file names and {more} the sign of more. |
| `codex_handover.nudge_why` | `An independent Codex review catches correctness bugs (off-by-one, races, subt...` |  |  | Reason line of the Codex nudge. |
| `codex_handover.ordinal_re` | `(\d)(?:st\|nd\|rd\|th)\b` |  |  | JavaScript source (flag i) of a day number with its ordinal suffix. |
| `codex_handover.path_separator` | `:` |  |  | Separator of the entries of the PATH variable. |
| `codex_handover.precompact_git_timeout_ms` | `2000` |  | ms | Time limit of each git call of the PreCompact snapshot. |
| `codex_handover.precompact_guard` | `precompact-snapshot` |  |  | The guard id of the PreCompact snapshot (its skip-file key). |
| `codex_handover.precompact_prefix` | `PRECOMPACT-` |  |  | The start of a PreCompact snapshot file name, through the dash before its number. |
| `codex_handover.precompact_summary` | `PreCompact: writes a mechanical continuation snapshot (git state, task list, ...` |  |  | One-line description of the precompact-snapshot check in the generated reference. |
| `codex_handover.prefix_continuation` | `A session handover was found for this continuation` |  |  | Lead-in of the resume pointer after a clear or compaction. |
| `codex_handover.prefix_previous` | `A previous session left a handover` |  |  | Lead-in of the resume pointer at a fresh start. |
| `codex_handover.projects_dir` | `.claude/projects` |  |  | The host's per-project transcript directory, relative to the home directory. |
| `codex_handover.proto_key` | `__proto__` |  |  | A key whose merge into an object JavaScript treats specially; a state file holding it is left to the Node hook. |
| `codex_handover.prune_stamp_prefix` | `.prune-stamp-` |  |  | The start of the prune throttle stamp file name. |
| `codex_handover.prune_throttle_ms` | `21600000` |  | ms | The least time between two sweeps for stale Codex nudge state files. |
| `codex_handover.prune_ttl_ms` | `604800000` |  | ms | Age after which a per-session Codex nudge state file is removed. |
| `codex_handover.quota_default_reason` | `quota exhausted` |  |  | The reason recorded for an outage that gives none. |
| `codex_handover.quota_event` | `PostToolUse` |  |  | The hook event name in the quota advisory. |
| `codex_handover.quota_guard` | `codex-quota` |  |  | The guard id the quota advisory answers to. |
| `codex_handover.quota_instead` | `route correctness review to Sonnet.` |  |  | Advice line of the quota advisory. |
| `codex_handover.quota_re` | `\b(out of\|exceed(?:ed\|s)?\|exhausted\|hit (?:your\|the)\|ran out of)\b[^.\n]{0,40...` |  |  | JavaScript source (flag i) of the Codex quota or rate-limit exhaustion message. |
| `codex_handover.quota_reason_chars` | `120` |  |  | How much of a quota message is kept as its reason, in UTF-16 units. |
| `codex_handover.quota_reason_max` | `300` |  |  | Longest reason stored in the quota record, in UTF-16 units. |
| `codex_handover.quota_target_words` | `quota, rate limit, usage limit` |  |  | Words a quota message needs; text with none of them cannot be one (compared without case). |
| `codex_handover.quota_what` | `codex:codex-rescue reported quota exhaustion ({reason}).` |  |  | Headline of the quota advisory; {reason} is the reason found in the result. |
| `codex_handover.quota_why` | `Recorded to ~/.anti-hall/codex-availability.json until {until}; Codex is unav...` |  |  | Reason line of the quota advisory; {until} is an ISO time or the cooldown label. |
| `codex_handover.rescue_re` | `^codex[:/-]?(?:codex-)?rescue$` |  |  | JavaScript source (flag i) of the agent type of the Codex rescue seat. |
| `codex_handover.resume_do_instead` | `Do instead: follow this guided resume path.` |  |  | The line before the numbered resume steps. |
| `codex_handover.resume_event` | `SessionStart` |  |  | The hook event name in the resume advisory when the payload names none. |
| `codex_handover.resume_freshness` | `Freshness (measured now): HEAD {head}; {commits} commit(s) since this handove...` |  |  | The git freshness line; {head}, {commits} and {dirty}. |
| `codex_handover.resume_git_timeout_ms` | `1500` |  | ms | Time limit of each git call of the handover resume. |
| `codex_handover.resume_guard` | `handover-resume` |  |  | The guard id the handover resume messages answer to. |
| `codex_handover.resume_head` | `💡 anti-hall · handover-resume: {prefix}: {path} ({seq_label}{pred} \| date {da...` |  |  | First line of the resume pointer; {prefix}, {path}, {seq_label}, {pred}, {date}, {sid} and {outcome}. |
| `codex_handover.resume_max_age_ms` | `604800000` |  | ms | Oldest handover or snapshot the resume still points at. |
| `codex_handover.resume_note` | `Note: this handover supersedes the auto-compact summary and any legacy CONTIN...` |  |  | Closing note of the resume pointer. |
| `codex_handover.resume_outcome` | ` -- INDEX.md outcome: {outcome}` |  |  | The outcome part of the resume pointer; {outcome}. |
| `codex_handover.resume_pred` | `, predecessor {pred}` |  |  | The predecessor part of the resume pointer; {pred}. |
| `codex_handover.resume_sources` | `clear, compact` |  |  | The SessionStart sources that count as a continuation (clear or compaction). |
| `codex_handover.resume_state_prefix` | `handover-resume-state-` |  |  | The start of the per-session resume state file name. |
| `codex_handover.resume_summary` | `SessionStart: points a fresh or compacted session at the newest handover with...` |  |  | One-line description of the handover-resume check in the generated reference. |
| `codex_handover.resume_writer` | `Writer kept running: session {sid} kept running {min} min after this handover...` |  |  | The writer-kept-running line; {sid}, {min} and {iso}. |
| `codex_handover.rollout_prefix` | `rollout-` |  |  | The start of a Codex rollout transcript file name. |
| `codex_handover.rollout_suffix` | `.jsonl` |  |  | The end of a Codex rollout transcript file name. |
| `codex_handover.rule_file_claude` | `CLAUDE.md` |  |  | The rules file a Claude session re-reads. |
| `codex_handover.rule_file_codex` | `AGENTS.md` |  |  | The rules file a Codex session re-reads. |
| `codex_handover.scratch_leaf` | `scratchpad` |  |  | The scratchpad directory name inside the session directory. |
| `codex_handover.scratch_prefix` | `claude-` |  |  | The start of the per-user scratchpad directory name, before the user id. |
| `codex_handover.seq_max_digits` | `15` |  |  | Most digits of a handover sequence number the port reads; more is left to the Node hook. |
| `codex_handover.serde_range_msg` | `number out of range` |  |  | Start of the error text of the engine's JSON parser for a number out of range (JavaScript parses it). |
| `codex_handover.serde_recursion_msg` | `recursion limit exceeded` |  |  | Start of the error text of the engine's JSON parser for nesting past its limit (JavaScript parses it). |
| `codex_handover.setting_nudge` | `5 entries` |  |  | Where the Codex nudge switch is read from (codexNudge.enabled, default on). |
| `codex_handover.setting_precompact` | `4 entries` |  |  | Where the PreCompact snapshot switch is read from (maintenance.precompactSnapshot, default on). |
| `codex_handover.setting_quota_detect` | `5 entries` |  |  | Where the Codex quota detection switch is read from (guards.codexQuotaDetect, default on). |
| `codex_handover.setting_resume` | `4 entries` |  |  | Where the handover resume switch is read from (context.handoverResume, default on). |
| `codex_handover.snap_branch` | `branch: {branch}` |  |  | The branch line of a snapshot. |
| `codex_handover.snap_clean` | ` (clean)` |  |  | The suffix of the dirty files line when none is dirty. |
| `codex_handover.snap_dirty` | `dirty files: {count}{clean}` |  |  | The dirty files line of a snapshot; {count} and {clean}. |
| `codex_handover.snap_fence_close` | `````` |  |  | The line that closes a quoted message. |
| `codex_handover.snap_fence_open` | `````text` |  |  | The line that opens a quoted message. |
| `codex_handover.snap_h_custom` | `## /compact instructions (verbatim)` |  |  | Heading of the compact instructions section of a snapshot. |
| `codex_handover.snap_h_handover` | `## Newest handover` |  |  | Heading of the newest handover section of a snapshot. |
| `codex_handover.snap_h_messages` | `## Last {count} user message(s), verbatim, oldest first` |  |  | Heading of the user messages section; {count}. |
| `codex_handover.snap_h_repo` | `## Repo state` |  |  | Heading of the repository state section of a snapshot. |
| `codex_handover.snap_h_tasks` | `## Task list snapshot (from the transcript)` |  |  | Heading of the task list section of a snapshot. |
| `codex_handover.snap_handover_found` | `{path} (modified {modified})` |  |  | The newest handover line; {path} and {modified} (an ISO time). |
| `codex_handover.snap_handover_none` | `none found under .anti-hall/handovers/ — no HANDOVER*.md exists for this repo` |  |  | The newest handover line when none exists. |
| `codex_handover.snap_head` | `HEAD: {head}` |  |  | The HEAD line of a snapshot. |
| `codex_handover.snap_indent` | `    ` |  |  | The indent of a listed dirty file. |
| `codex_handover.snap_intro` | `Mechanical crash dump written by anti-hall's PreCompact hook right before com...` |  |  | Explanation line of a snapshot; {trigger} is the compaction trigger. |
| `codex_handover.snap_messages_none` | `none found in the readable transcript tail` |  |  | The user messages line when none was found. |
| `codex_handover.snap_more` | `    … +{count} more` |  |  | The line after the listed dirty files when more exist; {count}. |
| `codex_handover.snap_msg_head` | `### {i}{ts}` |  |  | Heading of one user message; {i} and {ts}. |
| `codex_handover.snap_newer` | `Pre-compaction snapshot (newer than the handover): {path} -- anti-hall's PreC...` |  |  | Snapshot line when the snapshot is newer than the handover; {path}. |
| `codex_handover.snap_not_git` | `git: not a git repository (or git unavailable)` |  |  | The git line of a snapshot outside a repository. |
| `codex_handover.snap_older` | `Pre-compaction snapshot (older than the handover, which already covers it): {...` |  |  | Snapshot line when the handover is newer; {path}. |
| `codex_handover.snap_pwd` | `pwd: {cwd}` |  |  | The working directory line of a snapshot. |
| `codex_handover.snap_table_head` | `\| id \| subject \| status \|` |  |  | The header row of the task table. |
| `codex_handover.snap_table_row` | `\| {id} \| {subject} \| {status} \|` |  |  | One task table row; {id}, {subject} and {status}. |
| `codex_handover.snap_table_rule` | `\|---\|---\|---\|` |  |  | The rule row of the task table. |
| `codex_handover.snap_tasks_empty` | `empty list` |  |  | The task list line for an empty list. |
| `codex_handover.snap_tasks_none` | `not derivable — no TodoWrite/TaskCreate/TaskUpdate calls in the readable tran...` |  |  | The task list line when no list could be read. |
| `codex_handover.snap_title` | `# PRECOMPACT snapshot — {session} · #{n} · {now}` |  |  | First line of a snapshot; {session}, {n} and {now}. |
| `codex_handover.snap_truncated` | `{head}\n[… truncated {count} chars]` |  |  | A message cut at the limit; {head} is what is kept and {count} how much was cut. |
| `codex_handover.snap_ts_sep` | ` · ` |  |  | Separator before a message timestamp. |
| `codex_handover.snaponly_instead` | `read it fully before trusting the compact summary; once state is re-establish...` |  |  | Advice line when only a snapshot exists. |
| `codex_handover.snaponly_what` | `no HANDOVER*.md was written for this session, but a pre-compaction snapshot e...` |  |  | Headline when only a snapshot exists; {path} and {written}. |
| `codex_handover.snaponly_why` | `It holds git state, a task-list snapshot and the last user messages verbatim,...` |  |  | Reason line when only a snapshot exists. |
| `codex_handover.state_dir` | `.anti-hall` |  |  | The per-user state directory, relative to the home directory. |
| `codex_handover.status_deleted` | `deleted` |  |  | The status that removes a task from the snapshot. |
| `codex_handover.status_pending` | `pending` |  |  | The status of a task that has none. |
| `codex_handover.step_checklist` | `Run its Resume-verification checklist (git status, pwd, {rule} re-read, smoke...` |  |  | Resume step when the handover has a checklist; {rule} and {path}. |
| `codex_handover.step_continue` | `Continue from the single Next Action.` |  |  | Resume step: continue. |
| `codex_handover.step_details` | `Load detail files ONLY as needed via the pointer table ({files}).` |  |  | Resume step: the detail files; {files}. |
| `codex_handover.step_generic` | `No Resume-verification checklist section was found in it -- fall back to a ge...` |  |  | Resume step when the handover has no checklist; {rule} and {path}. |
| `codex_handover.step_read` | `Read {path} FULLY -- front matter (first ~15 lines) carries Situation + Next ...` |  |  | Resume step: read the handover; {path}. |
| `codex_handover.step_readback` | `READ-BACK: before any new work, tell the user in your own words (not a paste)...` |  |  | Resume step: tell the user what was understood. |
| `codex_handover.step_tasks` | `Recreate/reconcile your task list from state.md's Task list snapshot BEFORE w...` |  |  | Resume step: rebuild the task list. |
| `codex_handover.step_trials` | `Check trials.md do-not-repeat list before re-attempting anything.` |  |  | Resume step: the do-not-repeat list. |
| `codex_handover.task_created_re` | `Task #(\d+) created successfully` |  |  | JavaScript source of the result text that carries a new task's number. |
| `codex_handover.task_line_words` | `TodoWrite, TaskCreate, TaskUpdate, created successfully` |  |  | Words a transcript line must contain to be parsed for the task list. |
| `codex_handover.tmp_default` | `/tmp` |  |  | The temporary directory when none of those variables is set. |
| `codex_handover.tmp_env` | `TMPDIR, TMP, TEMP` |  |  | Environment variables that name the temporary directory, first set one wins. |
| `codex_handover.tmp_roots` | `/tmp, /private/tmp` |  |  | Temporary directories always searched for the session scratchpad, besides the one the environment names. |
| `codex_handover.transcript_tail_bytes` | `1572864` |  | bytes | How much of the end of the transcript the PreCompact snapshot reads. |
| `codex_handover.trigger_unknown` | `unknown-trigger` |  |  | What a snapshot records for any other trigger. |
| `codex_handover.triggers` | `manual, auto` |  |  | The PreCompact trigger values a snapshot records as they are. |
| `codex_handover.try_again_re` | `\btry again (?:at\|after\|on)?\s*([A-Za-z0-9:,+\-\/ ]{1,60})` |  |  | JavaScript source (flag i) of the usage-limit wording that names when to try again. |
| `codex_handover.tz_var` | `TZ` |  |  | The environment variable that sets the time zone; a request whose value differs from this process's has its local-time conversions left to the Node hook. |
| `codex_handover.unknown_session` | `unknown-session` |  |  | The session name used when a payload carries no usable session id. |
| `codex_handover.until_re` | `\b(?:until\|resets?(?: at)?\|resum(?:e\|ing)(?: at)?\|available again(?: at)?)\s+...` |  |  | JavaScript source (flag i) of a trailing clause that names when Codex is back; the original lookahead after the terminator is written as a consumed character, which changes neither the match start nor the capture. |
| `codex_handover.utc_words` | `utc, gmt, z` |  |  | Words after a date and time that mean UTC (compared without case). |
| `codex_handover.weekdays` | `7 items` |  |  | Weekday names, lower case (a date string may lead with one, full or its first three letters). |
| `codex_handover.writer_grace_ms` | `300000` |  | ms | How long after a handover its writer may keep writing before the resume says it kept running. |

### task_guards.toml / dispatch_tier

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `dispatch_tier.jev_id` | `dispatchTier` |  |  | The Jev integration id the dispatch-tier hook asks. |
| `dispatch_tier.json_max_depth` | `128` |  |  | Deepest JSON nesting the state file parser reads; deeper input is left to the Node hook. |
| `dispatch_tier.max_sessions` | `50` |  |  | Sessions the state file keeps recommendation tracking for; the longest untouched go first. |
| `dispatch_tier.owner_marker_setting` | `6 entries` |  |  | Where the switch of the owner-blocked marker is read from (guards.taskGuardOwnerBlockedMarker, default on): a task marked as waiting on the owner is never classified. |
| `dispatch_tier.owner_subject_re` | `^\s*owner(:\|\s+decision\b)` |  |  | JavaScript regex source (case-insensitive) of a subject that marks a task as waiting on the owner (OWNER: ... or OWNER DECISION ...). |
| `dispatch_tier.owner_values` | `owner, user, human, external` |  |  | The blockedOn values (trimmed, lowercase) that mark a task as waiting on the owner. |
| `dispatch_tier.question_instructions` | `Classify how an orchestrating agent should dispatch this task.` |  |  | The question put to Jev (a choice question over the three tiers). |
| `dispatch_tier.request_ttl_ms` | `600000` |  | ms | How long a request marker stops the same task text from being asked again while the first ask may still be in flight; older markers are dropped when the state is written. |
| `dispatch_tier.state_file` | `dispatch-tier-state.json` |  |  | The state file (requested markers and per-session tracking), inside the anti-hall directory of the home. |
| `dispatch_tier.summary` | `Asks Jev (dispatchTier, detached) how a new or changed task should be dispatc...` |  |  | One-line description of the dispatch-tier check in the generated reference. |
| `dispatch_tier.text_cap` | `600` |  |  | Most UTF-16 units of a task's text (subject, newline, description) that Jev is asked about. |
| `dispatch_tier.tier_subagent` | `the DEFAULT when unsure: a lookup, a bug fix, a UI text or copy change, any c...` |  |  | The description of the subagent tier in the question. |
| `dispatch_tier.tier_workflow` | `breadth-first or parallelisable work: 3 or more clearly independent or nested...` |  |  | The description of the workflow tier in the question. |
| `dispatch_tier.tier_workspace` | `a large multi-step feature, migration or release spanning several files or co...` |  |  | The description of the workspace tier in the question. |
| `dispatch_tier.tools` | `TaskCreate, TaskUpdate` |  |  | The task tools whose text changes the hook classifies. |

### task_guards.toml / task_guard

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `task_guard.agent_max_age_default_min` | `30` |  |  | The agent age limit used when the setting does not resolve to a number, in minutes. |
| `task_guard.agent_max_age_setting` | `6 entries` |  |  | Minutes after which a running agent that names no task stops counting as cover in the proven count (guards.idleNeglectAgentMaxAgeMin; 0 = never). |
| `task_guard.agents_dir` | `agents` |  |  | The directory of agent heartbeat files inside the anti-hall directory (the legacy liveness signal). |
| `task_guard.agents_ext` | `.json` |  |  | The file ending of an agent heartbeat file. |
| `task_guard.agents_fresh_ms` | `1200000` |  | ms | How long an agent heartbeat counts as a running agent. |
| `task_guard.agents_line` | `[task-guard] open tasks remain but live agents are active — deferring Stop bl...` |  |  | The advisory printed instead of the generic block while agents are live. |
| `task_guard.agents_ts_key` | `ts` |  |  | The heartbeat file's time field (milliseconds); without it the file time is used. |
| `task_guard.app_db_darwin_dir` | `Library, Application Support` |  |  | The application data directory under the home directory on macOS, as path segments. |
| `task_guard.app_db_env` | `ANTIHALL_DEVSWARM_APP_DB` |  |  | The environment variable that names the DevSwarm app database (or `off`). |
| `task_guard.app_db_file` | `DevSwarm, devswarm.db` |  |  | The DevSwarm app database under the application data directory, as path segments. |
| `task_guard.app_db_linux_config` | `.config` |  |  | The configuration directory under the home directory on Linux. |
| `task_guard.app_db_off` | `off` |  |  | The override value (lowercase) that turns the DevSwarm app database off. |
| `task_guard.app_db_xdg_env` | `XDG_CONFIG_HOME` |  |  | The environment variable that moves the configuration directory on Linux. |
| `task_guard.block_json` | `{"decision":"block","reason":{reason}}\n` |  |  | The stdout line of a block; `{reason}` is the reason as a JSON string. |
| `task_guard.budget_at_field` | `lastAt` |  |  | The bucket field holding the time of the last block. |
| `task_guard.budget_bucket` | `prompt` |  |  | The last part of the budget bucket key (`<session>\|task-guard\|<this>`). |
| `task_guard.budget_count_field` | `count` |  |  | The bucket field holding the blocks made for that prompt. |
| `task_guard.budget_key_field` | `promptKey` |  |  | The bucket field holding the prompt the count belongs to. |
| `task_guard.budget_setting` | `6 entries` |  |  | Most Stop blocks per user prompt (guards.stopNagBudgetPerPrompt; 0 = no budget). |
| `task_guard.cap_ceiling` | `16` |  |  | The highest CPU-based parallel cap. |
| `task_guard.cap_fallback_cores` | `4` |  |  | The CPU count assumed when none is reported. |
| `task_guard.cap_floor` | `1` |  |  | The lowest CPU-based parallel cap. |
| `task_guard.cap_formula` | `~min(16, cores-2)` |  |  | The parallel cap as the idle-neglect block names it when no number was computed (the legacy rule). |
| `task_guard.cap_reserve` | `2` |  |  | CPUs kept free when the parallel cap is derived from the CPU count. |
| `task_guard.codex_patch_tool` | `apply_patch` |  |  | The Codex tool name that marks a Codex payload on its own. |
| `task_guard.coordinator_owner_re` | `^(main\|orchestrator\|coordinator)$` |  |  | JavaScript regex source (case-insensitive) of an owner that is the orchestrator itself; such a task still counts as unowned. |
| `task_guard.dispatch_demand_setting` | `5 entries` |  |  | Whether running agents are counted per task from this session's transcript (guards.dispatchDemand, default on); off restores the legacy rule (any fresh agent heartbeat silences the idle-neglect block). |
| `task_guard.dispatch_list_max` | `12` |  |  | Most tasks the idle-neglect block names. |
| `task_guard.generic_allowed` | `a genuinely blocked task: mark it via {upd} with blockedBy:[<open task id>] o...` |  |  | The allowed-here line of the generic block; `{upd}` is the task update tool. |
| `task_guard.generic_instead` | `pick up pending tasks and dispatch subagents to finish them in parallel (up t...` |  |  | The do-instead line of the generic block; `{upd}` is the task update tool. |
| `task_guard.generic_what` | `stop blocked: open tasks remain: {list}{more}.` |  |  | The first line of the generic block; `{list}` is the listed tasks, `{more}` the tail. |
| `task_guard.generic_why` | `Tasks should not sit neglected when the session stops.` |  |  | The why line of the generic block. |
| `task_guard.guard_name` | `task-guard` |  |  | The guard id of task-guard (the skip key and the message prefix). |
| `task_guard.hash_sep` | ` ` |  |  | The separator between the task ids hashed into the loop state (a NUL character). |
| `task_guard.idle_allowed` | `a task blocked on the OWNER (hardware, a human decision): mark it metadata.bl...` |  |  | The allowed-here line of the idle-neglect block. |
| `task_guard.idle_devswarm` | ` Delegated to a DevSwarm workspace: set the task owner ({upd} owner) to the w...` |  |  | The sentence the idle-neglect block adds while a DevSwarm workspace is live; `{upd}` is the task update tool. |
| `task_guard.idle_hash_tags` | `idle, no-agents` |  |  | The words that start the hashed text of an idle-neglect block, so its loop state never equals a generic block's. |
| `task_guard.idle_instead` | `dispatch them now in parallel (one background agent each, cap {cap}), or stop...` |  |  | The do-instead line of the idle-neglect block; `{cap}` is the parallel cap, `{upd}` the task update tool, `{devswarm}` the DevSwarm sentence (or nothing). |
| `task_guard.idle_what` | `stop blocked: {n} non-blocked, unassigned task(s) have no in-flight agent: {l...` |  |  | The first line of the idle-neglect block; `{n}` is how many tasks, `{list}` the listed ones, `{more}` the tail. |
| `task_guard.idle_why` | `Dispatchable work is sitting idle.` |  |  | The why line of the idle-neglect block. |
| `task_guard.in_progress_re` | `in[-_]?progress` |  |  | JavaScript regex source (case-insensitive) of an in-progress status (tested unanchored, as Node does). |
| `task_guard.js_object_text` | `[object Object]` |  |  | JavaScript's `String()` of a plain object. |
| `task_guard.judge_child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | The environment variable that marks a judge child process; every task hook is a no-op there. |
| `task_guard.label_max` | `40` |  |  | Longest task subject in the idle-neglect block's list, in UTF-16 units. |
| `task_guard.label_priority_prefix_re` | `^\s*P\d\s*[:\-—]\s*` |  |  | JavaScript regex source (case-insensitive) of a priority prefix (`P1: `, `P0 - `) removed from a subject in the idle-neglect list. |
| `task_guard.label_sep` | `, ` |  |  | The separator between the tasks of the idle-neglect list. |
| `task_guard.list_max` | `5` |  |  | Most tasks the generic block names. |
| `task_guard.list_sep` | `; ` |  |  | The separator between the tasks of the generic block's list. |
| `task_guard.max_blocks` | `5` |  |  | Most Stop blocks task-guard makes in one session (both kinds counted); after that every Stop is let through. |
| `task_guard.max_parallel_setting` | `6 entries` |  |  | A fixed cap on running background agents (guards.maxParallelDispatch); 0 uses the CPU-based cap. |
| `task_guard.metrics_counters` | `demandsShown, demandsFollowed, demandsIgnored, idleNeglectBlocks` |  |  | The counters of the metrics file, each reset to 0 when it is not a finite number of at least 0, in this order. |
| `task_guard.metrics_file` | `dispatch-demand-metrics.json` |  |  | The dispatch-demand metrics file inside the anti-hall directory (the idle-neglect block counts itself there). |
| `task_guard.metrics_idle_key` | `idleNeglectBlocks` |  |  | The counter an idle-neglect block increments. |
| `task_guard.metrics_pending_key` | `pending` |  |  | The metrics file's per-session pending-demand object (kept as is, made an empty object when it is not one). |
| `task_guard.min_priority_setting` | `7 entries` |  |  | The priority floor of the idle-neglect block (guards.idleNeglectMinPriority): a pending task below it is backlog and never nags. |
| `task_guard.more` | ` (and {n} more)` |  |  | The tail of a block's list when tasks were left out; `{n}` is how many. |
| `task_guard.ms_per_minute` | `60000` |  |  | Milliseconds in a minute (the unit conversion of the agent age limit). |
| `task_guard.note_line` | `[task-guard] {note}\n` |  |  | The line that carries the unknown-state note; `{note}` is the note. |
| `task_guard.omc_active_key` | `active` |  |  | The state field that must be exactly true. |
| `task_guard.omc_claude_dir` | `.claude` |  |  | The Claude Code settings directory (under the home directory and the project). |
| `task_guard.omc_disable_env` | `DISABLE_OMC` |  |  | The environment variable that turns OMC off. |
| `task_guard.omc_disable_value` | `1` |  |  | The value of the OMC kill switch that turns it off. |
| `task_guard.omc_fresh_ms` | `7200000` |  | ms | How old an OMC loop's newest time may be for the loop to count as active. |
| `task_guard.omc_line` | `[task-guard] OMC autonomous loop active — deferring Stop block to avoid deadl...` |  |  | The advisory printed instead of a block while an OMC autonomous loop is active. |
| `task_guard.omc_plugin_id` | `oh-my-claudecode@omc` |  |  | The OMC plugin's id in the enabled-plugins list. |
| `task_guard.omc_plugins_key` | `enabledPlugins` |  |  | The settings field that lists enabled plugins. |
| `task_guard.omc_project_settings` | `settings.json, settings.local.json` |  |  | The project's Claude Code settings files, in the order read. |
| `task_guard.omc_session_key` | `session_id` |  |  | The state field that ties a loop to one session. |
| `task_guard.omc_settings_file` | `settings.json` |  |  | The user's Claude Code settings file inside the settings directory. |
| `task_guard.omc_settings_max_bytes` | `262144` |  |  | Largest settings file read for the OMC plugin switch; a larger one counts as not enabling it. |
| `task_guard.omc_skip_env` | `OMC_SKIP_HOOKS` |  |  | The environment variable that lists OMC hooks to skip (comma separated). |
| `task_guard.omc_skip_token` | `persistent-mode` |  |  | The skip-list entry that turns OMC's persistent mode off. |
| `task_guard.omc_state_dir` | `.omc, state` |  |  | OMC's state directory (under the project, else under the home directory), as path segments. |
| `task_guard.omc_state_files` | `8 items` |  |  | The OMC loop state files, in the order checked. |
| `task_guard.omc_state_max_bytes` | `65536` |  |  | Largest OMC state file read; a larger one counts as malformed. |
| `task_guard.omc_ts_keys` | `last_checked_at, updated_at, started_at` |  |  | The state fields that may carry a fresh time, in the order tried. |
| `task_guard.pending_status` | `pending` |  |  | The status (lowercase) of a task that can be dispatched now. |
| `task_guard.priority_default_rank` | `1` |  |  | The rank of a task with no priority or an unrecognised one (fail-open: it counts as P1). |
| `task_guard.priority_low` | `low, deferred` |  |  | Priority words (lowercase) that rank below the default. |
| `task_guard.priority_low_rank` | `2` |  |  | The rank of a low or deferred task. |
| `task_guard.priority_rank_re` | `^p([0-9]+)$` |  |  | JavaScript regex source of a priority label with a rank (`p0`, `p1`, ...), matched on the trimmed lowercase label. |
| `task_guard.prompt_id_key` | `prompt_id` |  |  | The Stop payload field that names the prompt. |
| `task_guard.proven_only_setting` | `5 entries` |  |  | Block on idle neglect only when a dispatchable task is uncovered under every placement of the agents that name no task (guards.idleNeglectProvenOnly, default on). |
| `task_guard.prune_advisory` | `[task-guard] {n} completed/cancelled tasks in the list (> {limit}) — advisory...` |  |  | The advisory printed when the list holds many completed tasks; `{n}` is how many and `{limit}` the limit. |
| `task_guard.prune_setting` | `6 entries` |  |  | How many completed or cancelled tasks the list may hold before the Stop advisory suggests pruning them (guards.pruneCompletedTasksAfter). |
| `task_guard.session_hash_len` | `16` |  |  | How many hex characters of the transcript path hash name a session that has no id. |
| `task_guard.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.taskGuard, default on). |
| `task_guard.state_blocks_key` | `blocks` |  |  | The loop state file's field for the number of blocks made this session. |
| `task_guard.state_hash_key` | `hash` |  |  | The loop state file's field for the hash of the last blocked set. |
| `task_guard.state_prefix` | `last-stop-taskset-` |  |  | Prefix of the per-session file that holds the last blocked task set (`last-stop-taskset-<session>`). |
| `task_guard.status_max` | `24` |  |  | Longest task status in the generic block's list, in UTF-16 units. |
| `task_guard.status_open` | `open` |  |  | What the generic block shows for a task without a status. |
| `task_guard.stop_policy_dir` | `devswarm, stop-policy` |  |  | The budget files' directory inside the anti-hall directory, as path segments. |
| `task_guard.stop_policy_ext` | `.json` |  |  | The ending of a session's budget file. |
| `task_guard.subject_max` | `60` |  |  | Longest task subject in the generic block's list, in UTF-16 units. |
| `task_guard.subject_unknown` | `(subject unknown)` |  |  | What the generic block shows for a task whose subject was never seen. |
| `task_guard.summary` | `Stop gate: blocks a Stop while tasks are open (the idle-neglect block when di...` |  |  | One-line description of the task-guard check in the generated reference. |
| `task_guard.task_ref_re` | `#(\d+)\b` |  |  | JavaScript regex source of a task number named in an agent's description (`#12`); such an agent covers that task. |
| `task_guard.tool_result_type` | `tool_result` |  |  | The content block type of a tool result (not a real user prompt). |
| `task_guard.unknown_tag` | `guard` |  |  | The tag of the unknown-state note's state file for task-guard. |
| `task_guard.update_claude` | `TaskUpdate` |  |  | How the block messages name the task update tool on Claude Code. |
| `task_guard.update_codex` | `update your task list` |  |  | How the block messages name the task update on Codex, which has no task tools. |
| `task_guard.user_type` | `user` |  |  | The transcript entry type of a user turn. |
| `task_guard.workspace_prefix_re` | `^(workspace\|ws\|devswarm)\s*[:#]\s*` |  |  | JavaScript regex source (case-insensitive) of the prefix removed from an owner before it is looked up as a DevSwarm workspace. |

### task_guards.toml / task_lifecycle_log

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `task_lifecycle_log.events` | `TaskCreated, TaskCompleted` |  |  | The hook events the ledger records. |
| `task_lifecycle_log.history_dir` | `.anti-hall, history` |  |  | The ledger directory under the project root, as path segments. |
| `task_lifecycle_log.index_name` | `INDEX.md` |  |  | The index file name inside the history directory. |
| `task_lifecycle_log.ledger_ext` | `.md` |  |  | The ledger file extension. |
| `task_lifecycle_log.separator` | ` · ` |  |  | The separator between the fields of a ledger line (a middle dot with a space on each side). |
| `task_lifecycle_log.setting` | `6 entries` |  |  | Where the on/off switch is read from (maintenance.taskLifecycleLog, default on). |
| `task_lifecycle_log.subject_max` | `200` |  |  | Longest task subject kept in a ledger line, in UTF-16 units. |
| `task_lifecycle_log.summary` | `Appends one line per TaskCreated/TaskCompleted event to the per-session histo...` |  |  | One-line description of the task-lifecycle-log check in the generated reference. |
| `task_lifecycle_log.task_id_max` | `200` |  |  | Longest task id kept in a ledger line, in UTF-16 units. |
| `task_lifecycle_log.teammate_max` | `100` |  |  | Longest teammate name kept in a ledger line, in UTF-16 units. |

### task_guards.toml / taskkit

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `taskkit.codex_dir` | `[\\/]\.codex[\\/]` |  |  | JavaScript regex source of a path with a `.codex` directory in it. |
| `taskkit.codex_rollout` | `(^\|[\\/])rollout-[^\\/]*\.jsonl$` |  |  | JavaScript regex source of a Codex rollout transcript path. |
| `taskkit.control_chars` | `[\x00-\x1F\x7F-\x9F]` |  |  | Characters a ledger line replaces with a space (C0 controls, DEL and C1 controls), as the body of a JavaScript regex class. |
| `taskkit.ellipsis` | `…` |  |  | What is appended to a ledger field that was cut to its limit. |
| `taskkit.exact_digits` | `15` |  |  | Most significant digits a JSON number may have for its text to be taken as JavaScript prints it; a number with more digits is left to the Node hook (several shortest round-trip texts exist and the two languages may pick different ones). |
| `taskkit.git_entry` | `.git` |  |  | The name of the entry that marks a git checkout root. |
| `taskkit.gitdir_line` | `^\s*gitdir:\s*(.+?)\s*$` |  |  | JavaScript regex source of the line that names the git directory in a `.git` file (the `m` flag applies). |
| `taskkit.session_id_unsafe` | `[^A-Za-z0-9_-]` |  |  | Characters that are removed from a session id before it becomes part of a ledger file name (JavaScript regex source of a negated class). |
| `taskkit.tmp_env_names` | `TMPDIR, TMP, TEMP` |  |  | The environment variables `os.tmpdir()` reads for the temp directory, in order; without any the temp directory is /tmp. |
| `taskkit.unknown_session` | `unknown-session` |  |  | The session id used in a file name when the payload carries none, or only characters a file name part may not hold (the Node `UNKNOWN_SESSION`). |

### task_guards.toml / tasklist_guard

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `tasklist_guard.ack_dir` | `stop-ack` |  |  | Directory of the acknowledgement files under the anti-hall state directory; also the file prefix (`<dir>/<dir>-<session>.json`). |
| `tasklist_guard.ack_hint` | `Override (only if the user explicitly confirmed this exact condition is fine)...` |  |  | The acknowledgement hint appended to a block; {key}, {now} and {path} are filled in. |
| `tasklist_guard.ack_session_max` | `128` |  |  | Longest session part of an acknowledgement file name. |
| `tasklist_guard.ack_setting` | `6 entries` |  |  | guards.stopAck: honor a per-signature acknowledgement of this block for the rest of the session. |
| `tasklist_guard.ack_sig_len` | `16` |  |  | How many hex digits of the SHA-1 of the dedupe hash make the acknowledgement signature. |
| `tasklist_guard.advisory_body` | `{"advised":true}` |  |  | Contents of the no-handover advisory marker. |
| `tasklist_guard.advisory_prefix` | `tasklist-guard-handover-advisory-` |  |  | Prefix of the once-per-session marker of the no-handover advisory (`<prefix><session>.json`). |
| `tasklist_guard.advisory_text` | `\n💡 anti-hall · handover: no handover exists yet after significant work.\nDo ...` |  |  | The no-handover advisory appended to a block. |
| `tasklist_guard.append_claude` | `append with the Edit tool or a one-line `>>`, never the Write tool` |  |  | How to append to the history file (Claude wording). |
| `tasklist_guard.append_codex` | `append with a one-line `>>`, never overwrite it` |  |  | How to append to the history file (Codex wording). |
| `tasklist_guard.budget_setting` | `6 entries` |  |  | guards.stopNagBudgetPerPrompt: blocks per user prompt (0 = off). |
| `tasklist_guard.codex_fields` | `turn_id, model` |  |  | Payload fields that, all non-empty strings, mark a Codex payload (isCodexPayload). |
| `tasklist_guard.codex_tool` | `apply_patch` |  |  | A tool name only Codex payloads carry (isCodexPayload). |
| `tasklist_guard.evidence_deferred_prefix` | `deferred_tools` |  |  | Prefix of the attachment type that lists deferred tools. |
| `tasklist_guard.evidence_names` | `TaskCreate, TaskUpdate, TodoWrite, task_reminder` |  |  | Tool names, attachment types and prefixes that can make a transcript line evidence of task tools (the cheap pre-filter). |
| `tasklist_guard.evidence_reminder` | `task_reminder` |  |  | Attachment type that proves task tools exist. |
| `tasklist_guard.evidence_tool` | `TaskCreate` |  |  | The deferred tool name that proves task tools exist. |
| `tasklist_guard.form_full` | `full` |  |  | The full nag form (and the protocol level that selects it). |
| `tasklist_guard.form_reduced` | `reduced` |  |  | The reduced nag form. |
| `tasklist_guard.form_skip` | `skip` |  |  | The nag form that says nothing. |
| `tasklist_guard.fresh_grace_ms` | `1000` |  |  | How far the newest counted work may run ahead of a progress file's time and still count as covered by it. |
| `tasklist_guard.fresh_setting` | `6 entries` |  |  | How long (ms) a progress file counts as fresh when no work time is known (guards.progressFreshMs). |
| `tasklist_guard.guard_name` | `tasklist-guard` |  |  | The guard id of tasklist-guard (the skip key and the message prefix). |
| `tasklist_guard.handover_file_re` | `^HANDOVER(?:-\d+)?\.md$` |  |  | JavaScript regex source of a handover file name. |
| `tasklist_guard.handover_grace_ms` | `1000` |  |  | How far the newest counted work may run past the newest handover's time before the handover counts as stale. |
| `tasklist_guard.handover_state_file` | `state.md` |  |  | The state file a session handover leaves (the prior-snapshot pointer looks for it). |
| `tasklist_guard.handovers_dir` | `.anti-hall, handovers` |  |  | The handovers directory under the project root, as path segments. |
| `tasklist_guard.head_bytes` | `65536` |  |  | How much of the start of the transcript is read for the session start time (firstTranscriptIso). |
| `tasklist_guard.header` | `<!-- session: {session} \| started: {started} -->` |  |  | The header a new progress file gets; {session} is the raw session id (or the unknown-session id), {started} the session start. |
| `tasklist_guard.history_dir` | `.anti-hall, history` |  |  | The history directory under the project root, as path segments. |
| `tasklist_guard.instead_capture` | `Capture the work as priority-sorted tasks via TaskCreate/TaskUpdate (TaskList...` |  |  | What to do instead: capture the work as tasks (Claude wording). |
| `tasklist_guard.instead_capture_codex` | `Capture the work as priority-sorted tasks in your task list (check it first t...` |  |  | What to do instead: capture the work as tasks (Codex wording). |
| `tasklist_guard.instead_files` | `{progress} (done/in-progress/next); a new file gets this header on top: {head...` |  |  | The rest of what to do instead; {progress}, {header}, {history} and {append} are filled in. |
| `tasklist_guard.instead_reduced` | `list the open tasks and status in your reply, priority first. Progress: {prog...` |  |  | What to do instead, reduced nag; {progress} and {history} are the files. |
| `tasklist_guard.instead_reset` | `recreate the open tasks with TaskCreate (see the progress file / handover), t...` |  |  | Lead of what to do instead after a task store reset (Claude wording). |
| `tasklist_guard.instead_reset_codex` | `recreate the open tasks in your task list (see the progress file / handover),...` |  |  | Lead of what to do instead after a task store reset (Codex wording). |
| `tasklist_guard.instead_stalled` | `dispatch a background agent for EACH now (do not serialize to one), or set id...` |  |  | What to do about tasks stalled in progress. |
| `tasklist_guard.jev_false` | `a small bounded chore — task tracking would be overhead, not help` |  |  | What a false answer means. |
| `tasklist_guard.jev_id` | `tasklistTrivial` |  |  | The Jev integration consulted before the nag (relax-block: a confident trivial verdict in on mode skips it). |
| `tasklist_guard.jev_instructions` | `This session is about to be nudged to track its work as tasks / refresh its p...` |  |  | The question put to Jev (a noul question). |
| `tasklist_guard.jev_state` | `workCount={work} threshold={threshold} sawTaskActivity={saw} hasStaleInProgre...` |  |  | The session summary Jev judges; the fields are the work count, threshold, the three sub-causes and the open task count. |
| `tasklist_guard.jev_true` | `genuinely non-trivial — multi-part, benefits from task tracking` |  |  | What a true answer means. |
| `tasklist_guard.json_max_depth` | `1000` |  |  | Nesting limit of the JSON state files read on the block path (deeper text defers to Node). |
| `tasklist_guard.low_priorities` | `p2, low, deferred` |  |  | Priorities (lowercase) below the actionable floor for the stalled-in-progress count. |
| `tasklist_guard.marketplace_dir` | `.claude/plugins/marketplaces/anti-hall` |  |  | The marketplace clone under the home directory (update.js resolvePaths). |
| `tasklist_guard.marketplace_env` | `ANTIHALL_MARKETPLACE_DIR` |  |  | Test-only override of the marketplace clone (an absolute path to an existing directory). |
| `tasklist_guard.max_blocks` | `3` |  |  | How many blocks one session gets at most (MAX_BLOCKS); a session at the cap stops quietly. |
| `tasklist_guard.no_task_tools_setting` | `8 entries` |  |  | The nag form for a session positively known to lack task tools (guards.tasklistNoTaskTools: reduced, full or skip). |
| `tasklist_guard.omc_fresh_ms` | `7200000` |  |  | How recent a loop state's timestamp must be for the loop to count as active. |
| `tasklist_guard.omc_kill_env` | `DISABLE_OMC` |  |  | Environment variable that disables oh-my-claudecode (value 1). |
| `tasklist_guard.omc_max_bytes` | `65536` |  |  | Largest loop state file read; a bigger one counts as malformed. |
| `tasklist_guard.omc_plugin` | `oh-my-claudecode@omc` |  |  | The enabledPlugins key of oh-my-claudecode. |
| `tasklist_guard.omc_settings_files` | `.claude/settings.json, .claude/settings.local.json` |  |  | The Claude settings files that can enable oh-my-claudecode: the home one, then the project's two. |
| `tasklist_guard.omc_settings_max_bytes` | `262144` |  |  | Largest Claude settings file read when checking that oh-my-claudecode is enabled. |
| `tasklist_guard.omc_skip_env` | `OMC_SKIP_HOOKS` |  |  | Environment variable listing skipped oh-my-claudecode hooks (comma separated). |
| `tasklist_guard.omc_skip_token` | `persistent-mode` |  |  | The skipped hook that turns the loop detection off. |
| `tasklist_guard.omc_state_dir` | `.omc, state` |  |  | The oh-my-claudecode state directory under the working directory, else the home directory, as path segments. |
| `tasklist_guard.omc_state_files` | `8 items` |  |  | The oh-my-claudecode loop state files (omc-detect.js). |
| `tasklist_guard.omc_text` | `[tasklist-guard] OMC autonomous loop active — deferring Stop block to avoid d...` |  |  | Printed instead of the block while an oh-my-claudecode autonomous loop is active. |
| `tasklist_guard.omc_ts_keys` | `last_checked_at, updated_at, started_at` |  |  | Timestamp fields of a loop state, in order. |
| `tasklist_guard.open_hash_len` | `16` |  |  | How many hex digits of the SHA-1 of the open task ids go into the dedupe signal. |
| `tasklist_guard.open_ids_sep` | ` ` |  |  | Separator of the sorted open task ids that are hashed into the dedupe signal. |
| `tasklist_guard.plan_mode_text` | `[tasklist-guard] PLAN MODE — Stop not blocked (progress-file writes are not p...` |  |  | The advisory printed instead of a decision while the session is in plan mode. |
| `tasklist_guard.plan_mode_value` | `plan` |  |  | The permission_mode value (compared in lowercase) that marks plan mode. |
| `tasklist_guard.plugin_json` | `.claude-plugin/plugin.json` |  |  | The plugin manifest under the plugin root (the running version). |
| `tasklist_guard.policy_dir` | `devswarm, stop-policy` |  |  | The stop-policy state directory under the anti-hall state directory, as path segments. |
| `tasklist_guard.policy_prompt_kind` | `prompt` |  |  | Stop-policy bucket kind of the per-prompt budget. |
| `tasklist_guard.policy_reduced_cap` | `1` |  |  | How many reduced nags one session gets. |
| `tasklist_guard.policy_reduced_kind` | `no-task-tools` |  |  | Stop-policy bucket kind of the reduced nag (blocks at most once per session). |
| `tasklist_guard.policy_tail_bytes` | `1572864` |  |  | How much of the end of the transcript is read for the prompt key (transcript-tail.js MAX_TAIL_BYTES). |
| `tasklist_guard.policy_user_marker` | `"user"` |  |  | Text a transcript line must hold to be read as a possible user prompt. |
| `tasklist_guard.prior_snapshot` | ` A prior session's snapshot exists at {path}: recreate your task list from it...` |  |  | Appended to the no-tasks reason when another session of today left a handover state file; {path} is its path. |
| `tasklist_guard.progress_dir` | `.anti-hall, progress` |  |  | The progress directory under the project root, as path segments. |
| `tasklist_guard.protocol_setting` | `8 entries` |  |  | context.protocolLevel: full makes the nag form default to full when guards.tasklistNoTaskTools is not set. |
| `tasklist_guard.reason_max` | `2000` |  |  | Longest block reason, in UTF-16 units; longer text is cut and ends with an ellipsis. |
| `tasklist_guard.registry_file` | `installed_plugins.json` |  |  | The host's plugin registry, beside the marketplaces directory. |
| `tasklist_guard.registry_key` | `anti-hall@anti-hall` |  |  | The registry entry of this plugin. |
| `tasklist_guard.registry_max_bytes` | `4194304` |  |  | Largest registry file read (readJsonBounded). |
| `tasklist_guard.registry_scopes` | `user, project` |  |  | Registry entry scopes, in order of preference. |
| `tasklist_guard.resume_marker_prefix` | `handover-resume-state-` |  |  | Prefix of the per-session marker the handover resume writes (`<prefix><session>.json` under the anti-hall state directory). |
| `tasklist_guard.resume_nudged_prefix` | `resume-verify-nudged-` |  |  | Prefix of the per-session file that records the one resume-verification nudge. |
| `tasklist_guard.resume_text` | `A session handover was resumed this session ({file}) but no `resume-verified:...` |  |  | The resume-verification nudge; `{file}` is the handover file. |
| `tasklist_guard.resume_verified_marker` | `resume-verified:` |  |  | The text a resumed handover must contain once its resume has been verified. |
| `tasklist_guard.session_hash_len` | `16` |  |  | How many hex digits of the transcript path's SHA-1 stand in for a missing session id. |
| `tasklist_guard.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.tasklistGuard, default on). |
| `tasklist_guard.signal_sep` | `\|` |  |  | Separator of the parts of the dedupe signal. |
| `tasklist_guard.stale_body` | `{"warned":true}` |  |  | Contents of the stale-handover advisory marker. |
| `tasklist_guard.stale_prefix` | `tasklist-guard-handover-stale-` |  |  | Prefix of the once-per-session marker of the stale-handover advisory (`<prefix><session>.json`). |
| `tasklist_guard.stale_text` | `\n⚠️ anti-hall · handover: the saved handover is stale (work happened after i...` |  |  | The stale-handover advisory appended to a block. |
| `tasklist_guard.state_ext` | `.json` |  |  | File extension of the per-session state and marker files. |
| `tasklist_guard.state_prefix` | `tasklist-guard-state` |  |  | Family name of the per-session loop state file (`<prefix>-<session>.json` under the anti-hall state directory); also the prune family. |
| `tasklist_guard.summary` | `Stop gate: blocks a Stop after untracked work, tasks stalled in progress or a...` |  |  | One-line description of the tasklist-guard check in the generated reference. |
| `tasklist_guard.task_tool_names` | `TaskCreate, TaskUpdate, TodoWrite` |  |  | The tool names that count as task activity. |
| `tasklist_guard.threshold_setting` | `6 entries` |  |  | How many counted file-changing actions make a session non-trivial (guards.tasklistWorkThreshold). |
| `tasklist_guard.version_setting` | `6 entries` |  |  | guards.stopHookVersionDowngrade: skip the block while the host registered a newer anti-hall than the running one. |
| `tasklist_guard.what_no_tasks` | `stop blocked: {n} file-changing actions this session but NO tasks tracked.` |  |  | Block headline when work was done and no task was tracked; {n} is the work count. |
| `tasklist_guard.what_progress` | `stop blocked: {n} file-changing actions but {path} is missing or stale.` |  |  | Block headline when the progress file is missing or stale; {n} is the work count, {path} the progress file. |
| `tasklist_guard.what_reduced` | `stop blocked: {n} file-changing actions, no tasks tracked.` |  |  | Block headline of the reduced nag (a session without task tools); {n} is the work count. |
| `tasklist_guard.what_reset` | `the task store was reset (session restore).` |  |  | Block headline when the task store was reset (a session restore). |
| `tasklist_guard.what_stalled` | `stop blocked: {n} tasks are in_progress but NO background agent is live.` |  |  | Block headline when tasks are in progress with no live agent; {n} is the count. |
| `tasklist_guard.why_no_tasks` | `Work this size needs a task list and a progress file.` |  |  | Block reason when no task was tracked. |
| `tasklist_guard.why_progress` | `The progress file must track what was done.` |  |  | Block reason when the progress file is missing or stale. |
| `tasklist_guard.why_reduced` | `Untracked work gets lost.` |  |  | Block reason of the reduced nag. |
| `tasklist_guard.why_reset` | `The old task ids are gone, not un-tracked.` |  |  | Block reason when the task store was reset. |
| `tasklist_guard.why_stalled` | `They are stalled, not worked in parallel.` |  |  | Block reason when tasks are stalled in progress. |
| `tasklist_guard.wide_window_bytes` | `16777216` |  |  | How much of the transcript the fallback search for any task activity reads when the scan window held none (16 MiB). |
| `tasklist_guard.window_bytes` | `524288` |  |  | How much of the end of the transcript the work and task scan reads (512 KiB). |
| `tasklist_guard.work_bucket_max` | `8` |  |  | Highest work bucket in the dedupe signal (the work count divided by the threshold, floored, capped here). |

### task_guards.toml / taskstate

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `taskstate.backfill_chunk_bytes` | `1048576` |  |  | How much of the transcript the backfill reads at a time. |
| `taskstate.backfill_exact_bytes` | `8388608` |  |  | How far back the backfill scans before the engine hands the call to Node. Node stops after 150 ms of wall clock (64 MiB at most); the engine scans a fixed number of bytes instead so its answer never depends on machine speed, and past this bound it defers rather than guess where Node would have stopped. |
| `taskstate.backfill_max_candidates` | `256` |  |  | How many unpaired task-creation results the backfill remembers while scanning backward. |
| `taskstate.backfill_max_subject` | `200` |  |  | Longest subject the backfill recovers, in UTF-16 units. |
| `taskstate.backfill_prefix_scan_bytes` | `8388608` |  |  | How far past the window start the backfill looks for the end of the line that straddles it. |
| `taskstate.done_statuses` | `completed, done, cancelled, canceled` |  |  | Statuses (lowercase) that count as completed for the completed-task advisory. |
| `taskstate.id_keys` | `taskId, id, task_id` |  |  | The input fields a task tool call may name its task id in, in order: the harness's `taskId`, then `id`, then `task_id`. |
| `taskstate.open_statuses` | `pending, in_progress, in-progress` |  |  | Statuses (lowercase) that make a task open. |
| `taskstate.prune_stamp_prefix` | `.prune-stamp-` |  |  | Prefix of the stamp file that throttles one prefix's sweep. |
| `taskstate.prune_throttle_hours` | `6` |  |  | The sweep of one file prefix runs at most once per this many hours. |
| `taskstate.prune_ttl_days` | `7` |  |  | Per-session state files older than this many days are removed by the opportunistic sweep. |
| `taskstate.re_created` | `^Task\s+#(\d+)\s+created\s+successfully` |  |  | JavaScript regex source (case-insensitive) of the tool result that announces a new task and names its number. |
| `taskstate.re_list_empty` | `^\s*No\s+tasks\s+found\b` |  |  | JavaScript regex source (case-insensitive) of the TaskList result that says the task store is empty. |
| `taskstate.re_not_found` | `^\s*Task\s*(?:#\S+)?\s*not\s+found\b` |  |  | JavaScript regex source (case-insensitive) of the TaskGet or TaskUpdate result that says one task id does not exist. |
| `taskstate.since_status_re` | `^(pending\|in[-_]?progress)$` |  |  | JavaScript regex source (case-insensitive) of the TaskUpdate statuses that restart a task's clock (`sinceMs`, read by the idle-neglect proof). |
| `taskstate.tail_bytes` | `1572864` |  |  | How much of the end of a transcript the task reconstruction reads (the Node `MAX_TAIL_BYTES`, 1.5 MiB). |
| `taskstate.terminal_status_re` | `^(completed\|done\|cancelled\|canceled\|deleted)$` |  |  | JavaScript regex source (case-insensitive) of the statuses that close a task for the backfill (`TERMINAL`). |
| `taskstate.tools_collect_keys` | `content, message, messages, tool_uses, parts` |  |  | The object keys the tool-use collector descends into, in order (the Node `collectToolUses`). |
| `taskstate.unknown_file_prefix` | `last-unknown` |  |  | Prefix of the per-session file that remembers which unknown set was last announced. |
| `taskstate.unknown_max_notes` | `3` |  |  | How many times the unknown-state note may be printed for one session and tag. |
| `taskstate.unknown_note_text` | `{n} task(s) in an unknown state (their records are too far back to read) — re...` |  |  | The unknown-state note; `{n}` is the number of tasks. |

### task_guards.toml / workdetect

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `workdetect.always_work` | `\bgit\s+(?:commit\|rebase\|merge\|cherry-pick\|stash\|reset\|apply\|am)\b\|\bgit\s+(?...` |  |  | JavaScript regex source (case-insensitive) of the shell commands that always count as work: git history and dependency mutations, `sed -i`, installs and `patch`. |
| `workdetect.command_position` | `(?:^\|[\n\r\u2028\u2029;&\|`(]\|\$\()\s*(?:rm\|cp\|mv\|tee\|mkdir\|touch\|make\|chmod)\b` |  |  | Regex source (case-insensitive) of the bare file verbs that count as work only at command position: at the start of a line, or after a separator, an opening parenthesis, a backtick or `$(`. A JavaScript `^` with the multiline flag also matches after a carriage return and the two Unicode line separators, which the character class lists. |
| `workdetect.crontab_segment` | `^[({\s]*crontab` |  |  | Regex source (case-insensitive) of the start of a crontab call at command position, optionally inside a leading subshell paren; a name that continues with a word character, dot or hyphen is not a crontab call (checked in code). |
| `workdetect.dev_null` | `\/dev\/null` |  |  | Regex source of the null device, a redirect target that never counts as a write. |
| `workdetect.devswarm_housekeeping` | `^\s*(?:node\s+)?(?:\S*[\\/])?devswarm\.js\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*(?:i...` |  |  | Regex source (case-insensitive) of a command segment that is only DevSwarm mesh housekeeping through the stable launcher: an inbox, heartbeat, send, relay, notice, nudge, roster or wake-directive verb. |
| `workdetect.heredoc_delimiter` | `^<<-?\s*((?:[^\s;&\|()<>'"\\]\|'[^'\n]*'\|"[^"\n]*"\|\\[^\n])+)` |  |  | Regex source of a heredoc operator and its delimiter word, which may be partly quoted or escaped; group 1 is the word. |
| `workdetect.mutating_tools` | `Edit, Write, MultiEdit, NotebookEdit` |  |  | File-mutating tools: each call counts as work unless it targets an excluded path. |
| `workdetect.never_work_tools` | `Agent, Task, CronCreate, CronDelete` |  |  | Tools that start or schedule work and never change a file themselves. |
| `workdetect.scratchpad_path` | `\/scratchpad\/` |  |  | Regex source of a path inside the session scratchpad (a segment literally named scratchpad); writes there are message passing, not project work. |
| `workdetect.state_dir` | `(?:^\|[\s/])\.anti-hall\/(?:progress\|history\|handovers)\/` |  |  | Regex source of a path inside anti-hall's own progress, history or handover directories; writing the bookkeeping the guard asks for is not work. |
| `workdetect.tmp_housekeeping_target` | `\/scratchpad\/\|(?:^\|\/)tmp\/` |  |  | Regex source (case-insensitive) of the redirect targets a housekeeping crontab install may write to: the scratchpad or a tmp directory. |

### devswarm_role.toml / devswarm_role

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `devswarm_role.agent_env` | `DEVSWARM_AI_AGENT` |  |  | Environment variable naming the workspace's agent (claude, codex, ...); only claude is told about the idle-wake cron and monitor tools. |
| `devswarm_role.bin_dir` | `.anti-hall/bin` |  |  | The directory of the stable launchers, relative to the home directory. |
| `devswarm_role.branch_env` | `DEVSWARM_SOURCE_BRANCH` |  |  | Environment variable that tells a child workspace (non-empty) from a Primary (empty or unset). |
| `devswarm_role.builder_env` | `DEVSWARM_BUILDER_ID` |  |  | Environment variable holding the workspace id the injected commands name. |
| `devswarm_role.child_summary` | `SessionStart: injects the DevSwarm mesh-only messaging directive for a child ...` |  |  | One-line description of the devswarm-child-role check in the generated reference. |
| `devswarm_role.claude_agent` | `claude` |  |  | The agent name that has the idle-wake cron and monitor tools. |
| `devswarm_role.cron_charset` | `0123456789*/,-` |  |  | The only characters a cron field may contain (anything else would let the setting inject text into the directive). |
| `devswarm_role.cron_fields` | `5` |  |  | How many whitespace-separated fields a valid cron schedule has. |
| `devswarm_role.gate_guard` | `devswarm-parent-gate` |  |  | The skip-file name of the parent gate. |
| `devswarm_role.gate_summary` | `Stop: allows without running Node when the Node gate would exit silently befo...` |  |  | One-line description of the devswarm-parent-gate check in the generated reference. |
| `devswarm_role.hooks_dir` | `hooks` |  |  | The plugin's hooks directory, relative to the plugin root; the Node hooks resolve their own location from it (real path). |
| `devswarm_role.id_extra_chars` | `._-` |  |  | Characters besides ASCII letters and digits that a workspace id may contain. |
| `devswarm_role.id_placeholder` | `<DEVSWARM_BUILDER_ID>` |  |  | What the injected commands name when the workspace id is absent or unsafe. |
| `devswarm_role.judge_env` | `ANTIHALL_JUDGE_CHILD` |  |  | Environment variable that marks the claude -p judge child; hooks that load in it exit silently. |
| `devswarm_role.kill_env` | `DISABLE_ANTIHALL_DEVSWARM` |  |  | Environment variable whose value 1 switches the DevSwarm integration off (checked before the supervisor mode). |
| `devswarm_role.launcher_cli` | `2 entries` |  |  | The stable launcher of the DevSwarm CLI: its file name under the bin directory and the script it resolves, relative to the plugin root. |
| `devswarm_role.launcher_src` | `#!/usr/bin/env node\n'use strict';\n// AUTO-GENERATED by anti-hall (hooks/lib...` |  |  | The source of a generated stable launcher (placeholders {segments}: the JSON array of the target's path parts, {fallback}: the JSON string of the target's absolute path at generation time). Compared byte for byte with the file on disk, never executed or written by the engine. |
| `devswarm_role.launcher_watcher` | `2 entries` |  |  | The stable launcher of the mailbox watcher: its file name under the bin directory and the script it resolves, relative to the plugin root. |
| `devswarm_role.msg_base` | `💡 anti-hall · devswarm-comms: anti-hall's shared mesh store is this workspace...` |  |  | The mesh-only messaging directive of a child workspace (placeholder {cli}: the DevSwarm CLI path). |
| `devswarm_role.msg_expiry_inline` | ` + re-arm on its final/expired event` |  |  | The monitor-expiry clause when the monitor is also re-armed inline on its own expiry. |
| `devswarm_role.msg_expiry_tick` | `. Do NOT re-arm inline when it emits its final/expired event — reply in one l...` |  |  | The monitor-expiry clause when re-arming happens only from the cron tick. |
| `devswarm_role.msg_wake_claude` | ` MAILBOX WAKE (do this NOW, on your FIRST turn): call `CronList`. If ANY exis...` |  |  | The mailbox-wake text of a claude workspace (placeholders {cli}, {watcher}, {id}, {cron}, {expiry}). |
| `devswarm_role.msg_wake_other` | ` MAILBOX WAKE: this workspace runs `{agent}`, which has NO idle-wake primitiv...` |  |  | The mailbox-wake text of a workspace whose agent is not claude (placeholders {cli}, {id}, {agent}). |
| `devswarm_role.out_prefix` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":` |  |  | The SessionStart hook output up to the directive text (host protocol; the text follows as a JSON string). |
| `devswarm_role.out_suffix` | `}}` |  |  | The SessionStart hook output after the directive text. |
| `devswarm_role.real_home_escape` | `ANTIHALL_ALLOW_REAL_HOME_TEST` |  |  | Environment variable that lifts the real-home refusal of the Node settings reader (tests that need the real home). |
| `devswarm_role.repo_env` | `DEVSWARM_REPO_ID` |  |  | Environment variable DevSwarm sets for a session under it; its presence is the auto-mode detection of an active supervisor. |
| `devswarm_role.sw_child_role` | `4 entries` |  |  | Switch devswarm.childRole (default on): off makes the SessionStart hook a no-op. |
| `devswarm_role.sw_parent_gate` | `4 entries` |  |  | Switch devswarm.parentGate (default on): off makes the Stop gate a no-op. |
| `devswarm_role.sw_rearm` | `5 entries` |  |  | Switch devswarm.rearmOnTickOnly (default on): re-arm a lapsed monitor only from the cron tick, never inline on the monitor's own expiry. |
| `devswarm_role.sw_stable_launcher` | `4 entries` |  |  | Switch devswarm.stableLauncher (default on): point the injected text at the version-independent launchers under the anti-hall bin directory instead of the plugin's own versioned path. |
| `devswarm_role.sw_supervisor_mode` | `6 entries` |  |  | Setting devswarm.supervisorMode (auto, on or off): force the supervisor context on or off, or detect it from the environment. default is also the manifest default the plugin option is compared with. |
| `devswarm_role.sw_wake_cron` | `4 entries` |  |  | Setting devswarm.wakeCron: the cron schedule of the mailbox-wake job, untrusted text that is validated before it is injected. |
| `devswarm_role.test_markers` | `ANTIHALL_TEST, ANTIHALL_TEST_ISOLATION` |  |  | Environment variables that mark a test run; with one of them set and the home equal to the real home the Node settings reader refuses, so the check defers rather than guess what Node does. |

### devswarm_gates.toml / devswarm_gates

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `devswarm_gates.bash_tool` | `Bash` |  |  | The tool name the reply tracker and the drain nudge observe. |
| `devswarm_gates.child_drain_setting` | `6 entries` |  |  | Where the devswarm-child-drain on/off switch is read from (devswarm.childDrain, default on; no environment variable). |
| `devswarm_gates.child_drain_summary` | `DevSwarm child mailbox drain nudge: allows the call when the hook cannot act ...` |  |  | One-line description of the devswarm-child-drain check in the generated reference. |
| `devswarm_gates.child_gate_guard_name` | `devswarm-child-gate` |  |  | The guard id the devswarm-child-gate check answers to in skip.json. |
| `devswarm_gates.child_gate_setting` | `6 entries` |  |  | Where the devswarm-child-gate on/off switch is read from (devswarm.childGate, default on; no environment variable). |
| `devswarm_gates.child_gate_summary` | `DevSwarm child Stop gate: allows the stop when the hook cannot act (switch of...` |  |  | One-line description of the devswarm-child-gate check in the generated reference. |
| `devswarm_gates.kill_env` | `DISABLE_ANTIHALL_DEVSWARM` |  |  | Environment variable that, set to exactly `1`, turns the DevSwarm integration off for the process. |
| `devswarm_gates.kill_env_value` | `1` |  |  | The value of the kill variable that turns the integration off. |
| `devswarm_gates.mode_off` | `off` |  |  | Supervisor mode value that forces the integration off. |
| `devswarm_gates.mode_on` | `on` |  |  | Supervisor mode value that forces the integration on. |
| `devswarm_gates.readside_builder_env` | `DEVSWARM_BUILDER_ID` |  |  | Environment variable that holds a child workspace's own id (the name of its descriptor file). |
| `devswarm_gates.readside_command_field` | `command` |  |  | Field of the tool input that holds the Bash command. |
| `devswarm_gates.readside_descriptor_dir` | `.anti-hall/devswarm/workspaces` |  |  | Directory of the workspace descriptors, relative to the home directory. |
| `devswarm_gates.readside_descriptor_ext` | `.json` |  |  | File extension of a workspace descriptor. |
| `devswarm_gates.readside_id_extra` | `._-` |  |  | Characters besides ASCII letters and digits that a workspace id may contain (an id with `..` is never safe). |
| `devswarm_gates.readside_inbox_field` | `inboxPath` |  |  | Descriptor field naming the workspace's durable inbox file; without it the drain nudge has nothing to count and stays silent. |
| `devswarm_gates.readside_input_field` | `tool_input` |  |  | Hook payload field that holds the tool's input. |
| `devswarm_gates.readside_read_primary_re` | `\binbox\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*read-primary\b` |  |  | JavaScript regex source (case-insensitive) for a Bash command that reads the Primary-originated channel (`inbox ... read-primary`); the drain nudge skips that one call so it does not contradict the read's own follow-up instruction. |
| `devswarm_gates.readside_stop_field` | `stop_hook_active` |  |  | Stop payload field that is exactly `true` when the model is already continuing because of an earlier Stop block; the Primary Stop gate then allows without reading anything. |
| `devswarm_gates.readside_subagent_fields` | `agent_id, agent_type` |  |  | Payload fields the host stamps only on a subagent's own calls; either one present and not null marks the call as a subagent's, which the drain nudge never addresses. |
| `devswarm_gates.readside_tool_field` | `tool_name` |  |  | Hook payload field that names the tool of a PostToolUse call. |
| `devswarm_gates.reply_tracker_setting` | `6 entries` |  |  | Where the devswarm-parent-reply-tracker on/off switch is read from (devswarm.parentReplyTracker, default on; no environment variable). |
| `devswarm_gates.reply_tracker_summary` | `DevSwarm Primary reply tracker: allows every Bash call that is not a devswarm...` |  |  | One-line description of the devswarm-parent-reply-tracker check in the generated reference. |
| `devswarm_gates.repo_id_env` | `DEVSWARM_REPO_ID` |  |  | Environment variable DevSwarm sets on a workspace's processes; non-empty means the supervisor is in play in auto mode. |
| `devswarm_gates.send_words` | `devswarm, send` |  |  | Words that must both appear (ASCII case-insensitive, at word boundaries, in any order) in a Bash command for it to plausibly be a devswarm send; `devswarm` also matches before `.js`. |
| `devswarm_gates.source_branch_env` | `DEVSWARM_SOURCE_BRANCH` |  |  | Environment variable DevSwarm sets only on a child workspace; non-empty means this session is a child. |
| `devswarm_gates.supervisor_mode` | `6 entries` |  |  | Where the DevSwarm supervisor mode (auto, on, off) is read from (devswarm.supervisorMode; headline plugin option). |

### migrate.toml / migrate

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `migrate.action` | `migrations-only` |  |  | The action word of the JSON report of the migration pass. |
| `migrate.auto_archive_action` | `auto-archive` |  |  | The action word of a successful automatic archive in the log. |
| `migrate.auto_archive_log` | `devswarm-auto-archive.ndjson` |  |  | The log of automatic archives under the logs directory, one JSON record per line. |
| `migrate.auto_archived_file` | `auto-archived.json` |  |  | The durable record of automatic archives under the DevSwarm directory. |
| `migrate.base_dir` | `.anti-hall` |  |  | The per-user anti-hall directory under the home directory. |
| `migrate.corrupt_infix` | `.corrupt-` |  |  | Appended (with a millisecond stamp) to the name a corrupt settings file is renamed to. |
| `migrate.cursors` | `5 entries` |  |  | The cursor sweeps: the cursor and inbox directories under the DevSwarm directory, the separator of a sibling watermark name, and the pattern of a per-instance cursor file name. |
| `migrate.day_ms` | `86400000` |  | ms | Milliseconds in a retention day. |
| `migrate.devswarm_dir` | `devswarm` |  |  | The DevSwarm state directory under the anti-hall directory. |
| `migrate.devswarm_section` | `devswarm` |  |  | The settings section the DevSwarm retention windows and the drain marker time to live are read from. |
| `migrate.devswarm_state_dirs` | `workspaces, store, archived, archived-retired, recovery-intent` |  |  | The DevSwarm directories whose contents the engine does not migrate (workspace descriptors, per-project stores, archive markers, recovery intents): while any holds an entry, the store-backed migrations are left to the Node doctor. |
| `migrate.drain_dir` | `drain` |  |  | The directory of in-flight drain markers under the DevSwarm directory. |
| `migrate.drain_ttl` | `3 entries` |  |  | The drain marker time to live: the settings entry (section and key; its environment variable and bounds are in migrate_settings.toml) and the default when no source sets it. |
| `migrate.errno_fallback` | `2 entries` |  |  | Node's error code and description used for an error not in the table. |
| `migrate.errnos` | `7 items` |  |  | Node's error code and description for the operating-system errors a state file call can meet, by errno. |
| `migrate.gate_acks_default` | `0` |  |  | The value a gate-loop state file's acknowledgement count gets when it lacks one. |
| `migrate.gate_acks_key` | `intentAcks` |  |  | The key of the acknowledgement count a gate-loop state file gains when it lacks it. |
| `migrate.gate_intents_key` | `intents` |  |  | The key of the stated-intent map a gate-loop state file gains when it lacks it. |
| `migrate.gate_state_excluded_re` | `(?i)-replies\.json$` |  |  | A parent-gate JSON file whose name matches this is a reply-state file, not a gate-loop state file (case-insensitive). |
| `migrate.host_settings_file` | `.claude/settings.json` |  |  | The host's settings file under the home directory, read for the plugin options it stores (never written). |
| `migrate.ids` | `19 entries` |  |  | The step ids of the report (Node's), and the action word of the steps whose action differs from their id. |
| `migrate.integrations_key_prefix` | `integrations.` |  |  | The prefix of the old dotted key of a per-integration value inside the jev section. |
| `migrate.jev_integration_ids` | `13 items` |  |  | The Jev integration ids whose per-integration value moved from the jev section to the jevIntegrations section of settings.json. |
| `migrate.jev_triage_cache` | `cache/jev-triage.json` |  |  | The Jev triage cache under the anti-hall directory. |
| `migrate.json_depth` | `128` |  |  | The deepest nesting of a JSON state file this port reads the way JavaScript does; a file nested deeper is left alone. |
| `migrate.json_ext` | `.json` |  |  | The extension of a JSON state file. |
| `migrate.legacy_dest` | `.anti-hall/history/legacy` |  |  | Where the legacy state files are copied to, relative to the project root. |
| `migrate.legacy_files` | `.anti-hall-progress.md, .anti-hall-history.md` |  |  | The legacy root-level state files copied into the dated history structure. |
| `migrate.lock_scratch_re` | `\.lock\.(?:reclaim\.)?(?:tmp\|reap\|hb)[-.]\|\.lock\.reclaim$` |  |  | The name pattern of the scratch files a lock leaves behind when a process dies mid-acquire, mid-refresh or mid-reclaim. |
| `migrate.lock_scratch_stale_ms` | `900000` |  | ms | A lock scratch file older than this can belong to no operation still running and is removed. |
| `migrate.locks_dir` | `locks` |  |  | The directory of the DevSwarm locks under the DevSwarm directory. |
| `migrate.logs_dir` | `logs` |  |  | The log directory under the anti-hall directory. |
| `migrate.markers_file` | `update-sweep-state.json` |  |  | The per-version completion markers of the migrations, shared with the Node update and supervisor (a JSON object under the anti-hall directory). |
| `migrate.max_dir_entries` | `200000` |  |  | The most entries of one directory a step lists at once; a larger directory is reported as an error instead of being held in memory (the retention sweeps stream a directory and have no such limit). |
| `migrate.max_file_bytes` | `16777216` |  | bytes | The most bytes of one state file a step reads (the files are small: settings, markers, reply state, cursors); a larger file is left as it is and noted, so no read costs more than this in memory. |
| `migrate.max_line_bytes` | `4194304` |  | bytes | The longest line of a log a step reads (one JSON record); a longer line is skipped and counted, never buffered whole. |
| `migrate.max_notes` | `200` |  |  | The most notes (errors a step swallowed) a run keeps and prints. |
| `migrate.parent_gate_dir` | `parent-gate` |  |  | The directory of the parent-gate state files under the DevSwarm directory. |
| `migrate.plugin_config_keys` | `anti-hall, anti-hall@anti-hall` |  |  | The keys the host may store this plugin's answers under in its settings file, lowest priority first. |
| `migrate.plugin_manifest` | `.claude-plugin/plugin.json` |  |  | The plugin manifest under the plugin root, whose version stamps a migration as done. |
| `migrate.plugin_option_env_prefix` | `CLAUDE_PLUGIN_OPTION_` |  |  | The prefix of the environment variable the host exports for each plugin option (followed by the upper-cased option name). |
| `migrate.registry` | `11 items` |  |  | The all-store forward-migrations of the Node migration registry, in order, as id:marker-key. Each needs the DevSwarm stores, so the engine reports them done only when there is no DevSwarm state and otherwise leaves them to the Node doctor. |
| `migrate.replies_re` | `-replies\.json$` |  |  | The name pattern of a reply-state file. |
| `migrate.reply_passes` | `3` |  |  | How many times a reply-state rewrite re-reads its source before it gives up (a reply keeps arriving) and leaves the file as it is. |
| `migrate.retention_sweeps` | `7 entries, 7 entries, 7 entries, 7 entries, 7 entries` |  |  | The age-based retention sweeps: id, directory (relative to the base, or to the DevSwarm directory when devswarm is true), file suffix, the environment variable of the window (used alone, as a positive integer, when key is empty), the settings key it is read through (section devswarm), and the default window in days. |
| `migrate.safe_id_re` | `^[A-Za-z0-9._-]+$` |  |  | The pattern of an identifier that is safe to use in a file name. |
| `migrate.settings_file` | `settings.json` |  |  | The unified settings file under the anti-hall directory. |
| `migrate.settings_lock_stale_ms` | `30000` |  | ms | A settings lock older than this is taken over by the next writer. |
| `migrate.settings_lock_step_ms` | `20` |  | ms | The pause between attempts to take the settings lock. |
| `migrate.settings_lock_suffix` | `.lock` |  |  | Appended to the settings file path to name the lock the Node settings writer takes. |
| `migrate.settings_lock_wait_ms` | `2000` |  | ms | How long a settings write waits for the lock before it gives up. |
| `migrate.settings_marker_key` | `migrateSettingsFromLegacy` |  |  | The marker key of the settings forward-migration. |
| `migrate.settings_section_integrations` | `jevIntegrations` |  |  | The settings section the per-integration values live in now. |
| `migrate.settings_section_jev` | `jev` |  |  | The settings section the per-integration values used to live in. |
| `migrate.store_dir` | `store` |  |  | The directory of the per-project DevSwarm stores under the DevSwarm directory. |
| `migrate.store_hash_res` | `^[0-9a-fA-F]{8}$, ^[a-z0-9-]{1,40}-[0-9a-f]{6}$` |  |  | The name patterns of a store directory: the legacy eight-hex form and the repository-key form. |
| `migrate.store_journal_dir` | `journal` |  |  | The journal directory inside a store, which also holds locks. |
| `migrate.summaries` | `3 entries` |  |  | The stale-summary sweep: the directory under the DevSwarm directory, the settings key of the window (section devswarm) and its default in days. |
| `migrate.test_markers` | `NODE_TEST_CONTEXT, ANTIHALL_TEST, ANTIHALL_TEST_ISOLATION` |  |  | Environment variables whose presence marks a test run, in which a state-changing run refuses to touch the real home directory. |
| `migrate.tmp_ext` | `.tmp` |  |  | The extension of the scratch file an atomic write goes through. |
| `migrate.unclaimed_prefix` | `unclaimed:` |  |  | The prefix of the synthetic session id a workspace carries until its real session is known. |
| `migrate.walk_depth` | `1` |  |  | How many levels of subdirectories a retention sweep descends into (the receipts directory is partitioned by day, one level). |
| `migrate.workspaces_dir` | `workspaces` |  |  | The directory of the workspace descriptors under the DevSwarm directory. |

### migrate.toml / migrate_msg

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `migrate_msg.already_applied` | `already applied for {version} (marker)` |  |  | A migration already stamped for this plugin version. Placeholder: {version}. |
| `migrate_msg.archive_records` | `{n} auto-archive record(s)` |  |  | The detail of the auto-archive state step. Placeholder: {n}. |
| `migrate_msg.could_not_list` | `could not list {dir}: {error}` |  |  | A sweep that could not list a directory. Placeholders: {dir}, {error}. |
| `migrate_msg.could_not_raise` | `could not raise {path}: {error}` |  |  | A cursor file that could not be raised. Placeholders: {path}, {error}. |
| `migrate_msg.could_not_remove` | `could not remove {path}: {error}` |  |  | A file a retention sweep could not remove. Placeholders: {path}, {error}. |
| `migrate_msg.deferred` | `left to the Node doctor: DevSwarm store state is present and the engine does ...` |  |  | A step that needs the DevSwarm stores, which the engine does not migrate yet, while DevSwarm state is present. |
| `migrate_msg.deferred_git` | `left to the Node doctor: the git location of the working directory cannot be ...` |  |  | The legacy copy when the git location of the working directory cannot be confirmed without Node. |
| `migrate_msg.dir_too_large` | `directory has more than {cap} entries` |  |  | A directory with more entries than a step lists at once. Placeholder: {cap}. |
| `migrate_msg.drain_not_removed` | `failed to remove stale drain marker {id}` |  |  | A stale drain marker that could not be removed. Placeholder: {id}. |
| `migrate_msg.drain_removed` | `removed stale drain marker {id} (age {age}ms)` |  |  | A stale drain marker that was removed. Placeholders: {id}, {age}. |
| `migrate_msg.dry_run` | `[dry-run] would migrate: {detail}` |  |  | A step that would migrate, in a preview. Placeholder: {detail}. |
| `migrate_msg.gate_files` | `{n} gate-state file(s)` |  |  | The detail of the gate-intents step. Placeholder: {n}. |
| `migrate_msg.heal_dry_run` | `[dry-run] would sweep every per-project store registry for mis-keyed/stale ro...` |  |  | The registry heal step in a preview. |
| `migrate_msg.heal_none` | `checked 0 registry row(s) across 0 store(s) — nothing mis-keyed/stale` |  |  | The registry heal step when there is no store to sweep. |
| `migrate_msg.lock_scratch` | `{n} stale lock scratch file(s)` |  |  | The lock scratch sweep's count. Placeholder: {n}. |
| `migrate_msg.marker_failed` | ` — marker write failed; retries next run` |  |  | Appended to a step whose completion marker could not be written. |
| `migrate_msg.migrated` | `migrated: {detail}` |  |  | A step that migrated. Placeholder: {detail}. |
| `migrate_msg.no_cwd` | `cannot determine the working directory ({error}); pass --cwd <dir>` |  |  | The working directory cannot be determined and --cwd was not given. Placeholder: {error}. |
| `migrate_msg.no_home` | `no home directory: set HOME or pass --home <dir>` |  |  | The migrate command when no home directory is known. |
| `migrate_msg.no_lock_dirs` | `no lock dirs` |  |  | The lock scratch sweep when no lock directory exists. |
| `migrate_msg.node_error` | `{code}: {text}, {syscall} '{path}'` |  |  | A file call's error as Node prints it. Placeholders: {code}, {text}, {syscall}, {path}. |
| `migrate_msg.not_stamped` | ` — not stamped, retries next run` |  |  | Appended when a settings migration finished cleanly but its marker could not be written. |
| `migrate_msg.note_growing` | `{path} kept changing while it was rewritten; left as it is` |  |  | A reply-state file that kept growing while it was rewritten; it is left as it is. Placeholder: {path}. |
| `migrate_msg.note_io` | `{error}` |  |  | A file call that failed and that the step could not put in a row. Placeholders: {what}, {path}, {error}. |
| `migrate_msg.note_line` | `note: {note}` |  |  | One note on stderr: an error a step swallowed and could not put in a row. Placeholder: {note}. |
| `migrate_msg.note_lock_busy` | `{path} is being written by another process; skipped, retried next run` |  |  | The settings file is locked by another writer past the wait limit; nothing was written. Placeholder: {path}. |
| `migrate_msg.note_long_lines` | `{n} line(s) of {path} are longer than the read limit and were skipped` |  |  | Lines of a log too long to read, skipped. Placeholders: {path}, {n}. |
| `migrate_msg.note_not_object` | `{path} is not a JSON object; left as it is` |  |  | A gate-loop state file that is not a JSON object; it is left as it is. Placeholder: {path}. |
| `migrate_msg.note_unparseable` | `{path} is not valid JSON; left as it is` |  |  | A state file that does not parse as JSON; it is left exactly as it is. Placeholder: {path}. |
| `migrate_msg.note_unsure` | `{path} holds JSON this build does not read exactly as Node does; left as it is` |  |  | A state file with content this port cannot read the way JavaScript does; it is left as it is and counted as an error. Placeholder: {path}. |
| `migrate_msg.nothing` | `nothing to migrate` |  |  | A step with nothing to do. |
| `migrate_msg.nothing_to_repair` | `nothing to repair` |  |  | The Jev triage cache repair when no entry is poisoned. |
| `migrate_msg.raised` | `{id} raised: {error}` |  |  | A step that raised an error. Placeholders: {id}, {error}. |
| `migrate_msg.real_home_refused` | `refused in a test run: {home} is the real user home; isolate HOME or pass --h...` |  |  | The migrate command in a test run pointed at the real home. Placeholder: {home}. |
| `migrate_msg.reply_files` | `{n} reply-state file(s)` |  |  | The detail of the reply-state step. Placeholder: {n}. |
| `migrate_msg.row_line` | `[{status}] {id}: {msg}` |  |  | One line of the migrate report for a person. Placeholders: {status}, {id}, {msg}. |
| `migrate_msg.settings_errors` | `; {n} error(s)` |  |  | Appended to the settings migration's result when some fields failed. Placeholder: {n}. |
| `migrate_msg.settings_migrated` | `{n} legacy field(s) forward-migrated into settings.json` |  |  | The settings migration's result. Placeholder: {n}. |
| `migrate_msg.still_pending` | `still pending after migrate: {detail}` |  |  | A step whose work was still pending after it ran. Placeholder: {detail}. |
| `migrate_msg.summary` | `{fixed} fixed, {skipped} skipped, {failed} failed` |  |  | The last line of the migrate report for a person. Placeholders: {fixed}, {skipped}, {failed}. |
| `migrate_msg.sweep_failed` | `{n} of {total} item(s) failed: {msgs}` |  |  | A sweep some of whose items failed. Placeholders: {n}, {total}, {msgs}. |
| `migrate_msg.sweep_handled` | `{n} item(s) handled` |  |  | A sweep that handled items. Placeholder: {n}. |
| `migrate_msg.sweep_nothing` | `nothing to do` |  |  | A sweep that had nothing to do. |
| `migrate_msg.sweep_nothing_pending` | `nothing pending` |  |  | A sweep in a preview that found nothing. |
| `migrate_msg.sweep_pending` | `{n} item(s) pending (dry run — nothing touched)` |  |  | A sweep in a preview that found items. Placeholder: {n}. |
| `migrate_msg.too_large` | `file larger than {cap} bytes` |  |  | A file too large to read whole. Placeholder: {cap}. |
| `migrate_msg.triage_dry_run` | `[dry-run] would drop {n} poisoned no-label cache entries` |  |  | The Jev triage cache repair in a preview. Placeholder: {n}. |
| `migrate_msg.triage_fixed` | `dropped {n} poisoned no-label jev-triage cache entries (re-triaged on next re...` |  |  | The Jev triage cache repair's result. Placeholders: {n}, {kept}. |
| `migrate_msg.triage_not_object` | `jev-triage cache is not an object — left alone` |  |  | The Jev triage cache repair when the cache is not an object. |
| `migrate_msg.triage_raised` | `raised: {error}` |  |  | The Jev triage cache repair when it raised. Placeholder: {error}. |
| `migrate_msg.triage_unreadable` | `no readable jev-triage cache — nothing to repair` |  |  | The Jev triage cache repair when the cache cannot be read. |
| `migrate_msg.unknown_version` | `(unknown)` |  |  | The version shown when the plugin manifest cannot be read. |
| `migrate_msg.watermark_declined` | `no registry rows readable in any store — watermark sweep declined (never dele...` |  |  | The sibling watermark sweep when no store has a registry row to compare against (it never deletes on an empty read). |

### migrate_settings.toml / migrate

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `migrate.settings_schema` | `299 items` |  |  | Every settings entry the forward-migration of settings.json reads: section, key, type, bounds, default, environment names, legacy file and key, and plugin option. |

### doctor.toml / doctor

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `doctor.decision_block_re` | `"decision"\s*:\s*"block"` |  |  | The pattern of a Stop hook's block decision in what a guard prints. |
| `doctor.default_event` | `PreToolUse` |  |  | The hook event a self-test payload is evaluated as when it names none. |
| `doctor.hooks_dir` | `hooks` |  |  | The hooks directory under the plugin root. |
| `doctor.hooks_json` | `hooks.json` |  |  | The generated hook registration file under the hooks directory. |
| `doctor.hooks_registry` | `hooks.registry.json` |  |  | The per-hook registry under the hooks directory, which lists the hook scripts the thin triggers hand to the engine. |
| `doctor.max_hook_output` | `1048576` |  | bytes | The most bytes of a Node hook's output a live self-test keeps. |
| `doctor.node_default` | `node` |  |  | The Node binary a live self-test runs a deferred hook with when the engine's own variable for it is not set. |
| `doctor.node_timeout_ms` | `30000` |  | ms | How long a Node hook gets in a live self-test before it is killed and the self-test fails. |
| `doctor.passthrough_env` | `PATH, TMPDIR` |  |  | The process environment variables a live self-test keeps (the rest of its environment is the test's own). |
| `doctor.platform_names` | `3 entries` |  |  | Node's name for each operating system and architecture Rust names differently (process.platform and process.arch). |
| `doctor.plugin_root_envs` | `CLAUDE_PLUGIN_ROOT, CODEX_PLUGIN_ROOT` |  |  | Environment variables that name the plugin root, first set one wins, after the engine's own and the --plugin-root flag. |
| `doctor.poll_ms` | `20` |  | ms | How often a live self-test checks whether its Node hook has finished. |
| `doctor.script_re` | `[\w-]+\.js` |  |  | The name pattern of a hook script in the registry. |
| `doctor.selftest_home_prefix` | `anti-hall-doctor-` |  |  | The name prefix of the throwaway home the live self-tests run against. |
| `doctor.selftests` | `21 items` |  |  | The live self-tests. Each runs the named built-in check in-process (when the engine defers the payload, as the dispatcher would, its Node hook `script` is run instead) on the payload with the given environment (HOME is always the throwaway home) and expects: block (the guard denies: exit 2), allow (it does not), stop-block (a Stop decision of block), or alert-stale (see version-alert). `ok` and `bad` are the findings; `warn` is used instead of `bad` when set. |
| `doctor.stale_version` | `999.0.0` |  |  | The version the version-alert self-test caches as newer than the running one. |
| `doctor.statusline_marker` | `statusline.js` |  |  | A statusLine command that contains this is the anti-hall dispatcher. |
| `doctor.statusline_scopes` | `3 entries, 3 entries, 3 entries` |  |  | Where a statusLine command may be configured, in order: label and file relative to the project (a leading ~ means the home directory). |
| `doctor.statusline_shown` | `48` |  |  | How many UTF-16 units of a custom statusLine command the doctor shows. |
| `doctor.transcript_file` | `t.jsonl` |  |  | The file name of the throwaway transcript a Stop self-test reads. |
| `doctor.unhandled_flags` | `--prune-cache, --reclaim-ingest-lock, --repair-ingest-orphans, --repair-test-...` |  |  | Flags of the Node doctor that the engine doctor does not handle yet; each is reported and the run continues. |
| `doctor.version_alert_env` | `ANTIHALL_VERSION_ALERT=` |  |  | Environment pairs of the version-alert self-test (the off switch is cleared so an inherited one cannot fake a pass). |
| `doctor.version_alert_payload` | `{"hook_event_name":"SessionStart","session_id":"{SID}"}` |  |  | The SessionStart payload of the version-alert self-test; {SID} is a unique session id. |
| `doctor.version_alert_re` | `"additionalContext"\s*:\s*"[^"]*version-alert: v{stale} is available \(you ar...` |  |  | The pattern of the version nudge in what the version-alert check prints; {stale} is the cached newer version, already escaped. |
| `doctor.version_alert_script` | `version-alert.js` |  |  | The Node hook that answers the version-alert self-test when the engine defers it. |
| `doctor.version_alert_sessions` | `doctor-va-stale, doctor-va-current` |  |  | Session id prefixes of the stale-cache and current-cache version-alert runs. |
| `doctor.version_check_file` | `version-check.json` |  |  | The cached latest-version file the version-alert self-test seeds, under the anti-hall directory. |
| `doctor.workflow_dir` | `.claude/workflows` |  |  | The directory of saved Workflow templates under the home directory and under the project (relative to each). |
| `doctor.workflow_patterns` | `(?i)^deadly-loop.*\.js$, (?i)^ship-it.*\.js$` |  |  | The names of the saved Workflow templates the doctor looks for (case-insensitive patterns). |

### doctor.toml / doctor_msg

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `doctor_msg.capture_failed` | `the output of {script} could not be captured` |  |  | The thread that captured a Node hook's output failed. Placeholder: {script}. |
| `doctor_msg.daemon_down` | `the engine daemon is not running (it starts on the first hook call)` |  |  | The engine daemon is not running, which is normal until the first hook call. |
| `doctor_msg.daemon_up` | `the engine daemon is running ({reply})` |  |  | The engine daemon is running. Placeholder: {reply}. |
| `doctor_msg.deferred` | `{check}: the engine defers this self-test to its Node hook, so it was not exe...` |  |  | A live self-test the engine could not decide itself: the check defers this payload to its Node hook. Placeholder: {check}. |
| `doctor_msg.engine_version` | `ah-engine {version}` |  |  | The engine version finding. Placeholder: {version}. |
| `doctor_msg.head_engine` | `Engine` |  |  | The heading of the engine section. |
| `doctor_msg.head_environment` | `Environment` |  |  | The heading of the environment section. |
| `doctor_msg.head_guards` | `Guard behavior (live self-tests)` |  |  | The heading of the live self-test section. |
| `doctor_msg.head_hooks` | `Hooks (present)` |  |  | The heading of the hooks section. |
| `doctor_msg.head_statusline` | `Statusline` |  |  | The heading of the statusline section. |
| `doctor_msg.head_unhandled` | `Not handled by the engine doctor` |  |  | The heading of the section that lists flags the engine doctor does not handle. |
| `doctor_msg.head_workflows` | `Workflow templates (deadly-loop / ship-it)` |  |  | The heading of the Workflow templates section. |
| `doctor_msg.hook_missing` | `{file} — REGISTERED BUT MISSING` |  |  | A registered hook script is not on disk. Placeholder: {file}. |
| `doctor_msg.hook_present` | `{file} present` |  |  | A registered hook script is on disk. Placeholder: {file}. |
| `doctor_msg.hook_timeout` | `{script} did not finish within the self-test time limit` |  |  | A Node hook did not finish a live self-test in time. Placeholder: {script}. |
| `doctor_msg.hooks_invalid` | `hooks.json invalid or unreadable: {error}` |  |  | hooks.json or its registry does not parse. Placeholder: {error}. |
| `doctor_msg.hooks_valid` | `hooks.json is valid JSON ({n} hook script(s) registered)` |  |  | hooks.json and its registry parse. Placeholder: {n}. |
| `doctor_msg.no_plugin_root` | `plugin root not found (pass --plugin-root <dir> or set AH_ENGINE_PLUGIN_ROOT)...` |  |  | The doctor could not find the plugin root, so the checks that read the plugin's files were skipped. |
| `doctor_msg.not_json` | `{file} is not valid JSON` |  |  | A plugin file that does not parse as JSON. Placeholder: {file}. |
| `doctor_msg.platform` | `Platform {platform} / {arch}` |  |  | The platform finding. Placeholders: {platform}, {arch}. |
| `doctor_msg.plugin_version` | `anti-hall plugin version {version}` |  |  | The plugin version finding. Placeholder: {version}. |
| `doctor_msg.repair_failed` | `FAILED [{id}] {msg}` |  |  | A repair row that failed. Placeholders: {id}, {msg}. |
| `doctor_msg.repair_fixed` | `FIXED [{id}] {msg}` |  |  | A repair row that fixed something. Placeholders: {id}, {msg}. |
| `doctor_msg.repair_gated` | `GATED [{id}] {msg}` |  |  | A repair row held back by a gate. Placeholders: {id}, {msg}. |
| `doctor_msg.repair_heading` | `Repair` |  |  | The heading of the repair section. |
| `doctor_msg.repair_heading_dry` | `Repair (dry-run — no changes written)` |  |  | The heading of the repair section in a preview. |
| `doctor_msg.repair_none` | `nothing to repair` |  |  | The repair pass found no rows and nothing failed. |
| `doctor_msg.repair_read_only` | `read-only run — nothing was changed. Run with --repair to apply the safe repa...` |  |  | The note under the repair heading when no repair was asked for. |
| `doctor_msg.repair_skipped` | `skipped [{id}] {msg}` |  |  | A repair row that did nothing. Placeholders: {id}, {msg}. |
| `doctor_msg.row_bad` | `❌` |  |  | The marker in front of a failing finding. |
| `doctor_msg.row_ok` | `✅` |  |  | The marker in front of a passing finding. |
| `doctor_msg.row_prefix_info` | `i` |  |  | The marker in front of an informational finding. |
| `doctor_msg.row_warn` | `⚠️` |  |  | The marker in front of a warning. |
| `doctor_msg.statusline_installed` | `statusline installed ({label}) -> anti-hall dispatcher` |  |  | The statusline is the anti-hall dispatcher. Placeholder: {label}. |
| `doctor_msg.statusline_none` | `no statusLine configured — run the install-statusline skill (then restart)` |  |  | No statusLine is configured. |
| `doctor_msg.statusline_set` | `statusline set ({label}) -> {command}…` |  |  | A custom statusline is configured. Placeholders: {label}, {command}. |
| `doctor_msg.title` | `anti-hall doctor v{version}` |  |  | The first line of the report. Placeholder: {version}. |
| `doctor_msg.unhandled_flag` | `{flag} is not handled by the engine doctor yet (D81); run the Node doctor for it` |  |  | A flag of the Node doctor that the engine doctor does not handle. Placeholder: {flag}. |
| `doctor_msg.unknown_version` | `(unknown)` |  |  | The version shown when the plugin manifest cannot be read. |
| `doctor_msg.verdict_fail` | `❌ anti-hall · doctor: {fail} failure(s), {pass} passed, {warn} warning(s)` |  |  | The verdict when something failed. Placeholders: {fail}, {pass}, {warn}. |
| `doctor_msg.verdict_ok` | `✅ anti-hall · doctor: active, {pass} checks passed` |  |  | The verdict when nothing failed. Placeholder: {pass}. |
| `doctor_msg.verdict_warn` | `, {warn} warning(s)` |  |  | Appended to the passing verdict when there are warnings. Placeholder: {warn}. |
| `doctor_msg.version_alert_bad` | `version-alert did NOT behave correctly for stale-vs-current cache` |  |  | The version-alert self-test failed. |
| `doctor_msg.version_alert_ok` | `version-alert nudges on a stale cached version and stays silent when current` |  |  | The version-alert self-test passed. |
| `doctor_msg.workflow_found` | `saved workflow template(s) found: {files}` |  |  | Saved Workflow templates exist. Placeholder: {files}. |
| `doctor_msg.workflow_missing` | `no saved deadly-loop/ship-it Workflow template found in ~/.claude/workflows/ ...` |  |  | No saved deadly-loop or ship-it Workflow template exists. |

### setup.toml / env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `env.setup_host_plugin_root` | `CLAUDE_PLUGIN_ROOT` |  |  | The plugin-root variable the host exports to hooks and skills; `capability-scan` and `briefing` read the plugin tree it names when `--root` is not given. |

### setup.toml / setup

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `setup.brief_caps_header_max` | `40` |  |  | Longest all-capitals comment line that is treated as a section header and skipped (Node: 40). |
| `setup.brief_cli_file` | `scripts/devswarm.js` |  |  | The DevSwarm command-line script, relative to the plugin root. |
| `setup.brief_code_words` | `7 items` |  |  | Words that, starting a line before any header comment, mean the file has no header comment. |
| `setup.brief_colors` | `6 entries` |  |  | The terminal colour codes of the briefing: bold, cyan, dim, yellow, green, reset (used only when the output is a terminal). |
| `setup.brief_command_key` | `command` |  |  | The member of a hook that holds its command. |
| `setup.brief_comment` | `//` |  |  | The line-comment leader of the hook scripts, whose first comment is the purpose line. |
| `setup.brief_companion_dir` | `companion/` |  |  | The companion directory, relative to the plugin root, as it prefixes a companion's name. |
| `setup.brief_dashes` | `—–` |  |  | The dash characters (em dash, en dash) that separate a file name from its purpose in a header comment. |
| `setup.brief_derived_line` | `Derived live from hooks.json + the files on disk — not a hardcoded list.` |  |  | The second line of the briefing. |
| `setup.brief_docs_note` | `docs/ is repo-clone-only and not bundled with /plugin install — clone github....` |  |  | What the briefing says when the repository docs are not part of the install. |
| `setup.brief_docs_prefix` | `docs/` |  |  | What a docs file's name is shown with. |
| `setup.brief_docs_rel` | `../../docs` |  |  | The repository docs directory, relative to the plugin root. |
| `setup.brief_doctor_line` | `Health check (do the guards actually fire?): node hooks/doctor.js` |  |  | The last line of the briefing. |
| `setup.brief_ellipsis` | `…` |  |  | What ends a skill description that was cut. |
| `setup.brief_ellipsis_cut` | `3` |  |  | How many characters shorter than the limit a cut description is before the ellipsis (Node: 3). |
| `setup.brief_fence` | `---` |  |  | The line that opens and closes a skill file's frontmatter. |
| `setup.brief_file_min` | `4` |  |  | The shortest file-name lead (one character and the extension) removed from a purpose line, in characters (Node: 4). |
| `setup.brief_group_cli` | `CLI` |  |  | The title of the command-line group. |
| `setup.brief_group_mechanical` | `mechanical triggers (hooks)` |  |  | The title of the group of mechanical-trigger hooks. |
| `setup.brief_group_store` | `store` |  |  | The title of the store group. |
| `setup.brief_group_supervisor` | `liveness supervisor + recovery` |  |  | The title of the supervisor group. |
| `setup.brief_header_lines` | `30` |  |  | How many lines of a file's start are searched for its header comment (Node: 30). |
| `setup.brief_heading_mark` | `#` |  |  | The mark that starts a Markdown heading. |
| `setup.brief_heading_max` | `160` |  |  | Longest knowledge-base heading (Node: 160). |
| `setup.brief_hooks_dir` | `hooks` |  |  | The hooks directory of a plugin tree. |
| `setup.brief_hooks_key` | `hooks` |  |  | The member of the hook registry that holds the events, and of each group that holds its hooks. |
| `setup.brief_js_suffix` | `.js` |  |  | What a hook script's name ends with. |
| `setup.brief_kb_prefix` | `KB` |  |  | What a knowledge-base file's name starts with. |
| `setup.brief_kb_suffix` | `.md` |  |  | What a knowledge-base file's name ends with. |
| `setup.brief_key_desc` | `description:` |  |  | The frontmatter key that holds a skill's description. |
| `setup.brief_key_name` | `name:` |  |  | The frontmatter key that holds a skill's name. |
| `setup.brief_lead_sep` | `::` |  |  | What follows the project name in a header comment's lead (`anti-hall :: name`). |
| `setup.brief_lib_dir` | `lib` |  |  | The helper directory inside the hooks directory. |
| `setup.brief_lookahead_lines` | `8` |  |  | How many comment lines after a bare module name are searched for the real purpose (Node: 8). |
| `setup.brief_matcher_key` | `matcher` |  |  | The member of a hook group that holds its tool matcher. |
| `setup.brief_mechanical_hooks` | `devswarm-parent-inbox.js, devswarm-parent-gate.js, devswarm-child-turn.js, de...` |  |  | The DevSwarm mechanical-trigger hooks the briefing lists when present. |
| `setup.brief_migration_files` | `devswarm-migrate.js, devswarm-ingest.js` |  |  | The DevSwarm migration companions the briefing lists when present. |
| `setup.brief_migration_title` | `migration (auto-safe: idempotent, non-destructive, single-consumer-locked, co...` |  |  | The heading of the DevSwarm migration group. |
| `setup.brief_name_seps` | `:` |  |  | The characters, besides white space and the dashes, that may follow a hook's own name at the start of its purpose line. |
| `setup.brief_no_header` | `(no header comment)` |  |  | The purpose shown for a hook file with no header comment. |
| `setup.brief_plugin_json` | `.claude-plugin/plugin.json` |  |  | The plugin manifest, relative to the plugin root. |
| `setup.brief_project_tag` | `anti-hall` |  |  | The project name a hook's header comment may lead with, removed from its purpose line. |
| `setup.brief_purpose_max` | `240` |  |  | Longest purpose line, in UTF-16 units (Node: 240). |
| `setup.brief_registry_file` | `hooks.registry.json` |  |  | The per-hook registry under hooks/ that the briefing groups by event. |
| `setup.brief_rule_chars` | `-=*` |  |  | The characters a rule line in a header comment is made of. |
| `setup.brief_rule_min` | `3` |  |  | The fewest characters of a rule line (dashes, equals signs, asterisks) that is skipped in a header comment (Node: 3). |
| `setup.brief_scan_bytes` | `262144` |  | bytes | How much of a hook file's start is read to find its header comment (Node reads the file and looks at its first 38 lines). |
| `setup.brief_scope_sep` | ` — ` |  |  | What joins a scope tag to the purpose that follows it. |
| `setup.brief_shebang` | `#!` |  |  | The start of an interpreter line, which is skipped when looking for the header comment. |
| `setup.brief_skill_desc_max` | `200` |  |  | Longest skill description before it is cut with an ellipsis (Node: 200). |
| `setup.brief_skill_file` | `SKILL.md` |  |  | The file in a skill directory that describes the skill. |
| `setup.brief_skills_dir` | `skills` |  |  | The skills directory of a plugin tree. |
| `setup.brief_store_file` | `companion/lib/devswarm-store.js` |  |  | The DevSwarm store module, relative to the plugin root. |
| `setup.brief_strict_word` | `use strict` |  |  | The text of the strict-mode directive, which is skipped when looking for the header comment. |
| `setup.brief_sub_indent` | `3` |  |  | The number of white-space characters before a subcommand name in the DevSwarm script's comment block (Node: 3). |
| `setup.brief_sub_marker` | `// SUBCOMMANDS` |  |  | The comment line after which the DevSwarm script documents its subcommands. |
| `setup.brief_sub_sep` | ` · ` |  |  | What separates the DevSwarm subcommands in the briefing. |
| `setup.brief_supervisor_files` | `devswarm-supervisor.js, devswarm-recover.js, install-devswarm-supervisor.js, ...` |  |  | The DevSwarm supervisor and recovery companions the briefing lists when present. |
| `setup.brief_unknown_version` | `(unknown)` |  |  | The version shown when plugin.json cannot be read. |
| `setup.brief_unreadable` | `(unreadable)` |  |  | The purpose shown for a hook file that cannot be read. |
| `setup.brief_version_key` | `version` |  |  | The member of the plugin manifest that holds the version. |
| `setup.cap_companion_dir` | `companion` |  |  | The directory of a plugin tree that holds the companion installers. |
| `setup.cap_const_fmt` | `const {name} = ` |  |  | How an installer declares a constant on its own line. Placeholder: name. |
| `setup.cap_const_label` | `LABEL` |  |  | The name of the installer constant that holds its launchd label. |
| `setup.cap_const_unit` | `UNIT` |  |  | The name of the installer constant that holds its systemd unit name. |
| `setup.cap_cron_marker` | `# {unit}` |  |  | The managed marker line of a unit in the crontab. Placeholder: unit. |
| `setup.cap_crontab_binary` | `crontab` |  |  | The program `capability-scan` asks for the managed cron markers on Linux. |
| `setup.cap_enabled_service` | `default.target.wants/{unit}.service` |  |  | Where an enabled continuous service shows up under the systemd directory. Placeholder: unit. |
| `setup.cap_enabled_timer` | `timers.target.wants/{unit}.timer` |  |  | Where an enabled timer shows up under the systemd directory. Placeholder: unit. |
| `setup.cap_export_fmts` | `{name},, {name}:` |  |  | The two ways an installer lists the function among its exports (a shorthand entry, a keyed entry). Placeholder: name. |
| `setup.cap_fn_decl_fmt` | `function {name}(` |  |  | How an installer declares its unit-listing function. Placeholder: name. |
| `setup.cap_hash_len` | `8` |  |  | The length of a per-worktree suffix, in hexadecimal digits. |
| `setup.cap_how_companion` | `node "${CLAUDE_PLUGIN_ROOT}/companion/{file}"` |  |  | How a companion is enabled. Placeholder: file. |
| `setup.cap_how_migrations` | `node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate-state.js"` |  |  | How pending state migrations are applied. |
| `setup.cap_how_statusline` | `node "${CLAUDE_PLUGIN_ROOT}/statusline/install-statusline.js" --user` |  |  | How the status line is enabled. |
| `setup.cap_installer_prefix` | `install-` |  |  | What a companion installer's file name starts with. |
| `setup.cap_installer_suffix` | `.js` |  |  | What a companion installer's file name ends with. |
| `setup.cap_key_max` | `40` |  |  | The longest head of a per-project suffix, in characters. |
| `setup.cap_key_tail` | `6` |  |  | The length of the hexadecimal tail of a per-project suffix. |
| `setup.cap_label_sep` | `.` |  |  | What separates a launchd label from its per-worktree or per-project suffix. |
| `setup.cap_launchagents_dir` | `Library/LaunchAgents` |  |  | The macOS per-user launchd directory, under the home directory. |
| `setup.cap_legacy_dir` | `.anti-hall/history/legacy` |  |  | Where the legacy progress and history files are copied, relative to the project root. |
| `setup.cap_legacy_files` | `.anti-hall-progress.md, .anti-hall-history.md` |  |  | The legacy root progress and history files whose copy under .anti-hall/history/legacy is the state migration. |
| `setup.cap_listing_fn` | `listInstalledIngestUnits` |  |  | The name of the installer export that lists every installed unit; an installer that exports it is checked with it (the per-worktree readback contract). |
| `setup.cap_name_migrations` | `state-migrations` |  |  | The capability name of the state migrations. |
| `setup.cap_name_statusline` | `statusline` |  |  | The capability name of the status line. |
| `setup.cap_os_names` | `2 entries` |  |  | Operating-system names as Node reports them, by the name Rust reports. |
| `setup.cap_plat_darwin` | `darwin` |  |  | The platform name of macOS. |
| `setup.cap_plat_linux` | `linux` |  |  | The platform name of Linux. |
| `setup.cap_plat_win32` | `win32` |  |  | The platform name of Windows. |
| `setup.cap_plist_suffix` | `.plist` |  |  | The end of a launchd job file's name. |
| `setup.cap_service_suffix` | `.service` |  |  | The end of a systemd service file's name. |
| `setup.cap_state_active` | `active` |  |  | How the text report says a capability is active. |
| `setup.cap_state_inactive` | `available, not active` |  |  | How the text report says a capability is shipped but not active. |
| `setup.cap_status_command_key` | `command` |  |  | The member of the status-line setting that holds its command. |
| `setup.cap_status_key` | `statusLine` |  |  | The settings member that configures the status line. |
| `setup.cap_status_project_files` | `.claude/settings.local.json, .claude/settings.json` |  |  | The project-scope settings files a status line may be configured in, strongest first, relative to the working directory. |
| `setup.cap_status_user_files` | `.claude/settings.json` |  |  | The user-scope settings files a status line may be configured in, relative to the home directory. |
| `setup.cap_statusline_marker` | `statusline.js` |  |  | The file name a status line command must contain for the statusline capability to count as active. |
| `setup.cap_systemd_dir` | `.config/systemd/user` |  |  | The Linux per-user systemd directory, under the home directory. |
| `setup.cap_timer_suffix` | `.timer` |  |  | The end of a systemd timer file's name. |
| `setup.cap_unit_sep` | `-` |  |  | What separates a systemd unit name from its per-worktree or per-project suffix. |
| `setup.compare_chunk_bytes` | `65536` |  | bytes | Size of the chunks two files are compared in, so that neither is held in memory whole. |
| `setup.corrupt_fmt` | `{file}.corrupt-{ms}` |  |  | Where a file that is not a JSON object is moved. Placeholders: file, ms. |
| `setup.credit_fields` | `balance, total_used` |  |  | The field names of the credit endpoint's answer: the balance and the total used. |
| `setup.credit_local_reasons` | `unsupported-transport, disabled, no-key` |  |  | Credit-balance answers that are local configuration answers, never cached. |
| `setup.credit_reason_unsupported` | `unsupported-transport` |  |  | The credit answer when neither transport is Vercel. |
| `setup.credit_silent_reasons` | `unsupported-transport, disabled` |  |  | Credit-balance answers `status` prints nothing for. |
| `setup.credits_cache_file` | `cache/jev-credits.json` |  |  | The cached credit balance, relative to the anti-hall home directory, the same file the Node report reads. |
| `setup.credits_endpoint` | `https://ai-gateway.vercel.sh/v1/credits` |  |  | The Vercel AI Gateway credit-balance endpoint `jev-setup status` reads (Node: CREDITS_ENDPOINT). |
| `setup.credits_ttl_ms` | `900000` |  | ms | How long a cached credit balance is served before the endpoint is asked again (Node: 15 minutes). |
| `setup.day_ms` | `86400000` |  | ms | The window of the `calls (last 24h)` count, in milliseconds. |
| `setup.diag_generic_bound` | `jev_api_key is bound to {bound}; set {option} for {vendor} (or re-bind the ge...` |  |  | Why a present vendor-less key was not used. Placeholders: bound, vendor, option. |
| `setup.diag_prefix` | `anti-hall jev: ` |  |  | The prefix of a diagnostic line the Jev client prints on stderr. |
| `setup.disagreement_keys` | `enabled, transport, fallbackTransport` |  |  | The `jev.*` keys a status warning compares between the legacy jev.json and the value the hooks use. |
| `setup.err_io` | `{what}: {source}` |  |  | How an operating-system failure reads. Placeholders: what, source. |
| `setup.fail_prefix` | `❌ anti-hall · jev-setup: ` |  |  | The prefix of every error line `jev-setup` prints. |
| `setup.fmt_brief_derived` | `{d}{line}{x}` |  |  | The second line of the briefing. Placeholders: d, x, line. |
| `setup.fmt_brief_dev_h` | `\n{b}DevSwarm coordination substrate{x}` |  |  | The heading of the DevSwarm section. Placeholders: b, x. |
| `setup.fmt_brief_doc` | `  {g}{file}{x} — {title}` |  |  | One knowledge-base file. Placeholders: g, x, file, title. |
| `setup.fmt_brief_docs_h` | `\n{b}docs / KB map{x}` |  |  | The heading of the docs map. Placeholders: b, x. |
| `setup.fmt_brief_event` | `  {y}{event}{x}` |  |  | An event heading. Placeholders: y, x, event. |
| `setup.fmt_brief_group` | `  {y}{title}{x}` |  |  | A group heading inside the DevSwarm section. Placeholders: y, x, title. |
| `setup.fmt_brief_hook` | `    {g}{file}{x}{matcher} — {purpose}` |  |  | One registered hook. Placeholders: g, x, file, matcher, purpose. |
| `setup.fmt_brief_hooks_h` | `\n{b}Hooks (by event){x}` |  |  | The heading of the hook list. Placeholders: b, x. |
| `setup.fmt_brief_item` | `    {g}{file}{x} — {purpose}` |  |  | One file of a DevSwarm group. Placeholders: g, x, file, purpose. |
| `setup.fmt_brief_last` | `\n{d}{line}{x}` |  |  | The last line of the briefing. Placeholders: d, x, line. |
| `setup.fmt_brief_matcher` | ` {d}[{matcher}]{x}` |  |  | A hook's tool matcher. Placeholders: d, x, matcher. |
| `setup.fmt_brief_note` | `  {d}{note}{x}` |  |  | A dim note. Placeholders: d, x, note. |
| `setup.fmt_brief_shared` | `  {g}{file}{x} — {purpose}` |  |  | One helper. Placeholders: g, x, file, purpose. |
| `setup.fmt_brief_shared_h` | `\n{b}Shared helpers (not registered as hooks){x}` |  |  | The heading of the helper list. Placeholders: b, x. |
| `setup.fmt_brief_skill` | `  {g}{name}{x} — {description}` |  |  | One skill. Placeholders: g, x, name, description. |
| `setup.fmt_brief_skills_h` | `\n{b}Skills{x}` |  |  | The heading of the skill list. Placeholders: b, x. |
| `setup.fmt_brief_subs` | `    {d}subcommands: {list}{x}` |  |  | The subcommand list of the DevSwarm script. Placeholders: d, x, list. |
| `setup.fmt_brief_title` | `{c}{b}anti-hall system briefing{x} {d}v{version}{x}` |  |  | The first line of the briefing. Placeholders: c, b, d, x (colours), version. |
| `setup.fmt_cached` | ` (cached)` |  |  | What follows a credit balance that came from the cache. |
| `setup.fmt_cap_hint` | `  -> {how}` |  |  | The hint after an inactive capability. Placeholder: how. |
| `setup.fmt_cap_line` | `{name}: {state}{hint}` |  |  | One line of the text report. Placeholders: name, state, hint. |
| `setup.fmt_disabled` | `jev disabled` |  |  | Said by `disable` when it is done. |
| `setup.fmt_enabled` | `jev enabled (transport: {transport}, fallback: {fallback})` |  |  | Said by `enable` when it is done. Placeholders: transport, fallback. |
| `setup.fmt_harvest_title` | `\n{title}\n` |  |  | The title block of the `harvest` text table. Placeholder: title. |
| `setup.fmt_harvest_total` | `\nTotal: {total}  Rot-risk: {rot}  With-trigger: {trigger}` |  |  | The last line of the `harvest` text table. Placeholders: total, rot, trigger. |
| `setup.fmt_key_saved` | `key saved for {vendor}` |  |  | Said by `set-key` when it is done. Placeholder: vendor. |
| `setup.fmt_mode_set` | `{integration} mode set to {value}` |  |  | Said by `mode` when it is done. Placeholders: integration, value. |
| `setup.fmt_status_calls` | `calls (last 24h): {count}` |  |  | The call-count line. Placeholder: count. |
| `setup.fmt_status_enabled` | `enabled: {value}` |  |  | The first line of `jev-setup status`. Placeholder: value. |
| `setup.fmt_status_fallback` | `fallback transport: {value}` |  |  | The fallback line of `jev-setup status`. Placeholder: value. |
| `setup.fmt_status_fallback_diag` | `  fallback: {text}` |  |  | A fallback diagnostic line of `jev-setup status`. Placeholder: text. |
| `setup.fmt_status_fallback_key` | `fallback key present: {value}` |  |  | The fallback key line of `jev-setup status`. Placeholder: value. |
| `setup.fmt_status_indent` | `  {text}` |  |  | An indented note line of `jev-setup status`. Placeholder: text. |
| `setup.fmt_status_integration` | `  {id}: {mode}` |  |  | One integration line. Placeholders: id, mode. |
| `setup.fmt_status_integrations` | `integrations:` |  |  | The heading of the integration list. |
| `setup.fmt_status_key` | `key present: {value}` |  |  | The key line of `jev-setup status`. Placeholder: value. |
| `setup.fmt_status_notice` | `notice: {text}` |  |  | A notice line of `jev-setup status`. Placeholder: text. |
| `setup.fmt_status_transport` | `transport: {value}` |  |  | The transport line of `jev-setup status`. Placeholder: value. |
| `setup.fmt_what` | `{action} {path}` |  |  | How an action and its target read together in an error. Placeholders: action, path. |
| `setup.git_args` | `log, -1, --format=%ct, --` |  |  | The arguments of the git call that gives a file's last commit time, before the `--` and the file. |
| `setup.git_binary` | `git` |  |  | The git program `harvest` asks for a file's last commit time. |
| `setup.git_output_max_bytes` | `64` |  |  | Most bytes of git's answer to a last-commit-time question that are read; the answer is one number. |
| `setup.git_poll_ms` | `5` |  | ms | How often `harvest` checks whether git has answered. |
| `setup.git_timeout_ms` | `5000` |  | ms | Longest `harvest` waits for git to name one file's last commit time (Node: 5000 ms); a slower answer counts as no answer. |
| `setup.harvest_binary_check_bytes` | `4096` |  | bytes | How much of a file's start is checked for a NUL byte before it is treated as binary and skipped (Node: 4096). |
| `setup.harvest_cell_gap` | `2` |  |  | The ceiling and trigger cells are cut to their column width minus this (Node: 2). |
| `setup.harvest_closers` | `*/, -->` |  |  | The comment terminators trimmed off a marker's text (block comments and HTML comments). |
| `setup.harvest_default_stale_days` | `90` |  | days | Days after which an untouched file's marker counts as stale when --stale-days is not given (Node: 90). |
| `setup.harvest_ellipsis` | `...` |  |  | What replaces the start of a file name that is too long for its column. |
| `setup.harvest_file_gap` | `2` |  |  | A file name longer than its column width minus this is shortened (Node: 2). |
| `setup.harvest_file_tail_gap` | `5` |  |  | A shortened file name keeps the last (column width minus this) characters (Node: 5). |
| `setup.harvest_headers` | `FILE, LINE, CEILING, WHEN, ROT-RISK` |  |  | The column headings of the `harvest` text table: file, line, ceiling, trigger, rot risk. |
| `setup.harvest_leaders` | `//, #, --, /*, <!--` |  |  | The comment leaders a debt marker may follow, in the order the Node pattern tries them. |
| `setup.harvest_max_file_bytes` | `2097152` |  | bytes | Largest file `harvest` reads (Node: 2 MB); bigger files are skipped. |
| `setup.harvest_none` | `(none)` |  |  | What the trigger cell shows when a marker has no trigger. |
| `setup.harvest_reason_sep` | `; ` |  |  | What joins two rot reasons. |
| `setup.harvest_rot_yes` | `YES: {reason}` |  |  | What the rot-risk cell starts with when a marker is a rot risk. Placeholder: reason. |
| `setup.harvest_rule_char` | `-` |  |  | The character the rule under the `harvest` table header is drawn with. |
| `setup.harvest_rule_extra` | `30` |  |  | How much longer than the four columns the rule under the `harvest` table header is (Node: 30). |
| `setup.harvest_skip_dirs` | `.git, node_modules` |  |  | Directory names `harvest` never descends into (names starting with a dot are skipped too). |
| `setup.harvest_tag` | `anti-hall:` |  |  | The word that makes a comment a debt marker, after the comment leader. |
| `setup.harvest_w_ceiling` | `20` |  |  | Width of the ceiling column of the `harvest` text table (Node: 20). |
| `setup.harvest_w_file` | `40` |  |  | Width of the file column of the `harvest` text table (Node: 40). |
| `setup.harvest_w_line` | `6` |  |  | Width of the line column of the `harvest` text table (Node: 6). |
| `setup.harvest_w_rot` | `40` |  |  | Longest rot-risk text of the `harvest` text table (Node: 40). |
| `setup.harvest_w_when` | `26` |  |  | Width of the trigger column of the `harvest` text table (Node: 26). |
| `setup.json_keys` | `7 entries` |  |  | The settings keys `jev-setup` writes and reads: the settings section, the integration sections, and the keys of the section. |
| `setup.json_max_depth` | `512` |  |  | Nesting past which a JSON file the helper commands read is treated as unreadable (JSON.parse reads deeper than the port does). |
| `setup.kill_switch_value` | `0` |  |  | The value of a per-integration kill-switch variable that turns the integration off. |
| `setup.kind_boolean` | `boolean` |  |  | The word the settings-key tables use for a key that must be true or false. |
| `setup.known_integrations` | `21 items` |  |  | The integrations `jev-setup status` always lists, in the order the Node script lists them (every one has a settings key). |
| `setup.lock_boot_slop_s` | `5` |  | s | Two boot times closer than this many seconds are the same boot. |
| `setup.lock_reclaim_stale_ms` | `5000` |  | ms | A takeover marker of the settings lock older than this is taken over (Node: 5000 ms). |
| `setup.lock_record_max_bytes` | `4096` |  | bytes | Most bytes read of a settings lock file, which holds one small JSON record. |
| `setup.lock_release_step_ms` | `10` |  | ms | The pause between those tries. |
| `setup.lock_release_tries` | `5` |  |  | How many times releasing the settings lock tries to take the takeover marker. |
| `setup.lock_stale_ms` | `30000` |  | ms | A settings lock held longer than this is taken over (Node: 30000 ms). |
| `setup.lock_step_ms` | `20` |  | ms | The pause between tries for the settings lock (Node: 20 ms). |
| `setup.lock_suffix` | `.lock` |  |  | What is added to the settings file's name to name its lock file. |
| `setup.lock_wait_ms` | `2000` |  | ms | How long a settings write waits for the lock (Node: 2000 ms). |
| `setup.log_max_bytes` | `16777216` |  | bytes | Most bytes of one Jev decision-log file `jev-setup status` reads to count the last day's calls; the log rotates at 2 MB. |
| `setup.log_outcome_type` | `outcome` |  |  | The `type` of a decision-log row that records an outcome, not a call. |
| `setup.log_rotated_suffix` | `.1` |  |  | The end of the first rotated decision-log file's name. |
| `setup.msg_bind_usage` | `bind-generic-key: --vendor vercel\|typesafe is required` |  |  | Why `bind-generic-key` refused: no vendor. |
| `setup.msg_bound` | `jev.genericKeyVendor = {vendor}: the generic jev_api_key and jev.keyFile are ...` |  |  | Said by `bind-generic-key` after it re-bound the generic key. Placeholder: vendor. |
| `setup.msg_could_not_set` | `could not set jev.{key}: {error}` |  |  | A settings write failed. Placeholders: key, error. |
| `setup.msg_credit_na` | `credit balance (vercel): n/a ({reason})` |  |  | A status line: the credit balance could not be read. Placeholder: reason. |
| `setup.msg_credit_nokey` | `credit balance (vercel): n/a (no vercel key visible to this process)` |  |  | A status line: the credit balance needs a Vercel key this process cannot see. |
| `setup.msg_credit_ok` | `credit balance (vercel): ${amount}{cached}` |  |  | A status line with the Vercel credit balance. Placeholders: amount, cached. |
| `setup.msg_credit_typesafe` | `credit balance (typesafe): not available (TypeSafe has no balance endpoint)` |  |  | A status line: TypeSafe has no credit-balance endpoint. |
| `setup.msg_disagree` | `  warning: ~/.anti-hall/jev.json says {key}={legacy} but {winner} wins with {...` |  |  | A status warning: the legacy jev.json holds another value than the one the hooks use. Placeholders: key, legacy, winner, effective. |
| `setup.msg_enable_bad_fallback` | `enable: invalid --fallback "{value}" (expected vercel\|typesafe\|none)` |  |  | Why `enable` refused a fallback. Placeholder: value. |
| `setup.msg_enable_bad_transport` | `enable: invalid --transport "{value}" (expected vercel\|typesafe)` |  |  | Why `enable` refused a transport. Placeholder: value. |
| `setup.msg_expected_boolean` | `expected a boolean (true/false/on/off/1/0), got {got}` |  |  | Why a settings write was refused: the value is not a boolean. Placeholder: got. |
| `setup.msg_fallback_equal` | `note: a fallback equal to the primary transport is treated as none` |  |  | Said by `enable` when the fallback named equals the primary and so counts as none. |
| `setup.msg_fallback_note` | `  note: with a fallback, text can be sent to the second vendor when the prima...` |  |  | A status line warning that a fallback can send text to a second vendor. |
| `setup.msg_generic_bound` | `generic key (jev_api_key / jev.keyFile) bound to: {vendor} (change only with ...` |  |  | A status line naming the vendor the generic key is bound to. Placeholder: vendor. |
| `setup.msg_git_reader_panicked` | `warning: reading git's answer failed; the file has no last-commit time` |  |  | The thread that reads git's answer ended abnormally, so the file has no last-commit time. |
| `setup.msg_lock_not_released` | `warning: the settings lock had changed hands and was left in place` |  |  | The settings lock was not ours any more when it was released, and was left alone. |
| `setup.msg_migration_notice` | `a legacy Jev key file/env var exists but anti-hall no longer reads credential...` |  |  | A legacy Jev key exists on the machine but is not read. |
| `setup.msg_mode_usage` | `mode: usage is `mode <integration> on\|shadow\|off`` |  |  | Why `mode` refused: a missing integration or a mode that is not on, shadow or off. |
| `setup.msg_must_be_one_of` | `must be one of: {values}` |  |  | Why a settings write was refused: the value is not an allowed word. Placeholder: values. |
| `setup.msg_no_home` | `the home directory is not set` |  |  | Printed by the helper commands when the home directory variable is not set, because their files live under it. |
| `setup.msg_no_key_notice` | `no Jev key visible to this process: a key stored as a plugin option (the plug...` |  |  | Why a process other than a hook finds no Jev key. |
| `setup.msg_no_plugin_root` | `no plugin tree to read: pass --root <plugin directory>, or run it where the h...` |  |  | Printed when a command that reads a plugin tree was given neither --root nor a plugin-root variable. |
| `setup.msg_no_trigger` | `no payback trigger (when is absent)` |  |  | The rot reason of a marker with no payback trigger. |
| `setup.msg_none_found` | `No anti-hall debt markers found.` |  |  | Printed by `harvest` when the tree holds no marker. |
| `setup.msg_rejected` | `Jev key file rejected ({why}): it must be a regular file under ~/.config or ~...` |  |  | Why a present Jev key file was refused. Placeholder: why. |
| `setup.msg_setkey_bad_role` | `set-key: invalid --role "{value}" (expected fallback)` |  |  | Why `set-key` refused a role. Placeholder: value. |
| `setup.msg_setkey_bad_transport` | `set-key: invalid --transport "{value}" (expected vercel\|typesafe)` |  |  | Why `set-key` refused a transport. Placeholder: value. |
| `setup.msg_setkey_empty` | `set-key: no key received on stdin — pipe the key in, e.g. `printf '%s' "$KEY"...` |  |  | Why `set-key` refused: nothing arrived on stdin. |
| `setup.msg_setkey_no_fallback` | `set-key --role fallback: no fallback transport is configured — run `enable --...` |  |  | Why `set-key --role fallback` refused: no fallback is configured. |
| `setup.msg_setkey_nonprintable` | `set-key: key contains non-printable characters — aborting` |  |  | Why `set-key` refused: the key holds a control character. |
| `setup.msg_setkey_note` | `note: the hooks only read this key file when jev.allowLegacyKeyRead is on (cu...` |  |  | Said by `set-key` while the hooks do not read the key file. Placeholder: option. |
| `setup.msg_setkey_too_large` | `set-key: more than {max} bytes on stdin; a key is a short single line` |  |  | Why `set-key` refused: more than the limit arrived on stdin. Placeholder: max. |
| `setup.msg_settings_busy` | `settings.json is being written by another process (pid {pid}); retry` |  |  | Why a settings write was refused: another process holds the lock. Placeholder: pid. |
| `setup.msg_settings_not_updated` | `⚠️ anti-hall · jev-setup: settings.json not updated: {error}` |  |  | A per-integration mode was written to jev.json but not to settings.json. Placeholder: error. |
| `setup.msg_stale` | `file not touched in >{days} days` |  |  | The rot reason of a marker in a file not touched for the stale window. Placeholder: days. |
| `setup.msg_table_title` | `anti-hall debt markers` |  |  | The title line of the `harvest` text table. |
| `setup.msg_too_large` | `{path} is larger than {max} bytes, so it is not read` |  |  | Why a file was not read: it is larger than the limit. Placeholders: path, max. |
| `setup.msg_treated_absent` | `warning: {error}; treated as absent` |  |  | A file or directory could not be read and is treated as absent, as the Node script treats it. Placeholder: error. |
| `setup.msg_unbound_warning` | `warning: no key for {vendor} is visible to this process, and the stored gener...` |  |  | Said by `enable` when a chosen vendor has no key of its own and the generic key is bound to the other vendor. Placeholders: vendor, bound, option. |
| `setup.msg_unknown_setting` | `unknown setting: {setting}` |  |  | Why a settings write was refused: the key is not one this command writes. Placeholder: setting. |
| `setup.msg_unsupported_json` | `{path} holds JSON this build cannot rewrite safely; it was left unchanged` |  |  | Why a file was not rewritten: it holds JSON this build cannot read faithfully, so it is left unchanged. Placeholder: path. |
| `setup.msg_usage` | `💡 anti-hall · jev-setup: usage: ah-engine jev-setup status\|enable [--transpor...` |  |  | Usage line of `ah-engine jev-setup`. |
| `setup.option_name_fmt` | `jev_{vendor}_api_key` |  |  | The plugin option that holds a vendor's key. Placeholder: vendor. |
| `setup.read_max_bytes` | `8388608` |  | bytes | Largest configuration or state file the helper commands read; a larger file is refused, never read in part or held in memory. |
| `setup.reason_multiline` | `content is not a single line without whitespace` |  |  | Why a key file was refused: it is not one line without white space. |
| `setup.reason_not_file` | `not a regular file` |  |  | Why a key file was refused: it is not a regular file. |
| `setup.reason_outside` | `path is outside ~/.config and ~/.anti-hall` |  |  | Why a key file was refused: its real path lies outside the allowed directories. |
| `setup.reason_too_large` | `larger than {max} bytes` |  |  | Why a key file was refused: it is too large. Placeholder: max. |
| `setup.reason_unreadable` | `unreadable` |  |  | Why a key file was refused: it could not be read. |
| `setup.role_fallback` | `fallback` |  |  | The value of --role that names the fallback transport. |
| `setup.settings_entries` | `4 entries` |  |  | The settings keys `jev-setup` writes, by section.key, with what a value must be: boolean, or the name of the list of allowed words. |
| `setup.stdin_max_bytes` | `65536` |  | bytes | Most bytes `jev-setup set-key` reads from stdin; a key is a short single line. |
| `setup.tier_keys` | `3 entries` |  |  | How each key that a status warning compares is read: what it must be (boolean, or the list of allowed words), its default, and the plugin-option suffix. |
| `setup.tmp_fmt` | `{file}.tmp.{pid}` |  |  | The temporary file a write goes through. Placeholders: file, pid. |
| `setup.valid_fallbacks` | `none, vercel, typesafe` |  |  | The values a fallback transport may take. |
| `setup.valid_modes` | `on, shadow, off` |  |  | The modes an integration may be set to. |
| `setup.valid_transports` | `vercel, typesafe` |  |  | The vendors a primary transport or a key may name. |
| `setup.warn_prefix` | `⚠️ anti-hall · jev: ` |  |  | The prefix of a warning line the Jev client prints on stderr. |
| `setup.what_create_dir` | `create directory` |  |  | What was being done when a directory could not be created, followed by its path. |
| `setup.what_crontab` | `ask crontab for the managed cron markers` |  |  | What was being done when the crontab could not be read. |
| `setup.what_cwd` | `read the current directory` |  |  | What was being done when the current directory could not be read. |
| `setup.what_git` | `ask git for a last-commit time` |  |  | What was being done when git could not be run for a last-commit time. |
| `setup.what_list` | `list` |  |  | What was being done when a directory could not be listed, followed by its path. |
| `setup.what_read` | `read` |  |  | What was being done when a file could not be read, followed by its path. |
| `setup.what_read_stdin` | `read standard input` |  |  | What was being done when standard input could not be read. |
| `setup.what_remove` | `remove` |  |  | What was being done when a leftover temporary file could not be removed, followed by its path. |
| `setup.what_resolve` | `resolve` |  |  | What was being done when the plugin tree named by --root could not be resolved, followed by its path. |
| `setup.what_set_aside` | `move aside` |  |  | What was being done when a corrupt file could not be moved aside. |
| `setup.what_stat` | `examine` |  |  | What was being done when a path could not be examined, followed by its path. |
| `setup.what_write` | `write` |  |  | What was being done when a file could not be written, followed by its path. |
| `setup.what_write_stdout` | `write to standard output` |  |  | What was being done when writing to standard output failed. |
| `setup.winner_env` | `the environment` |  |  | How a status warning names the environment when it is the tier that wins. |
| `setup.winner_file` | `~/.anti-hall/settings.json` |  |  | How a status warning names the settings file when it is the tier that wins. |
| `setup.winner_option` | `the /config plugin option` |  |  | How a status warning names the plugin option when it is the tier that wins. |
| `setup.word_no` | `no` |  |  | The word `status` prints for a false answer. |
| `setup.word_none` | `none` |  |  | The word for no fallback transport. |
| `setup.word_undefined` | `undefined` |  |  | How a missing value reads in a message (JavaScript's word for it). |
| `setup.word_unknown` | `unknown` |  |  | The word for an answer that could not be determined. |
| `setup.word_yes` | `yes` |  |  | The word `status` prints for a true answer. |

### mesh.toml / mesh

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `mesh.backend_marker` | `BACKEND` |  |  | File name of the marker that pins a store directory to one backend (Node's `BACKEND` file). |
| `mesh.backend_sqlite` | `sqlite` |  |  | The marker text of a SQLite-backed store. Any other marker (the journal backend) means Node owns the store and the reader refuses it. |
| `mesh.busy_timeout_ms` | `3000` |  |  | How long a read waits for a SQLite lock held by a Node writer, in milliseconds; the same 3 s Node's store uses. |
| `mesh.cache_kib` | `256` |  |  | SQLite page cache for one open store, in KiB. Keeps one open reader to well under a megabyte of resident memory (D45 section 7). |
| `mesh.db_flag` | `--db` |  |  | The flag that selects the read-only S0 reader (`ah-engine mesh <roster\|unread\|read\|dump> --db <file>`); without it the words after `mesh` are a devswarm.js argv. |
| `mesh.engine_writes` | `off` |  |  | Who runs the mesh verbs that write the store (`ah-engine mesh send\|mesh read\|mesh history\|roster --ack`): off (Node, the engine only forwards), shadow (Node acts; the engine replays each call on a scratch copy and logs whether it would have done the same, in mesh_write.shadow_log) or on (the engine acts where it reproduces Node exactly, Node elsewhere; after the engine's own write it never reruns the verb in Node). Set it in settings.json (`mesh.engine_writes`) or the engine's config.toml. To turn it off: `{"mesh":{"engine_writes":"off"}}` in ~/.anti-hall/settings.json (or delete the key; off is the default). |
| `mesh.engine_writes_modes` | `off, shadow, on` |  |  | The words of mesh.engine_writes, in this order: off, shadow, on. Anything else reads as off. |
| `mesh.js_safe_int` | `9007199254740991` |  |  | The largest integer JavaScript represents exactly (2^53 - 1). Node's sqlite binding throws on a larger value, so the reader fails the same way instead of rounding, which keeps the two readers byte-equal. |
| `mesh.last_default` | `5` |  |  | How many of a workspace's newest messages `mesh read --last` returns when no count is given. |
| `mesh.last_max` | `100` |  |  | The most messages `mesh read --last` returns whatever count is asked for; the reader never holds more message bodies than this at once. |
| `mesh.missing_table_error` | `no such table` |  |  | Lower-cased text of the SQLite error for a table the store does not have yet (an older Node schema); a reader that meets it answers with no rows, as Node does. |
| `mesh.preview_chars` | `120` |  |  | Characters of a pending question's body the reader returns as its preview; the same 120 Node's PREVIEW_MAX keeps. |
| `mesh.read_byte_cap` | `4194304` |  |  | Most message-body bytes one `mesh read` call prints before it stops and reports where to resume (D45 section 7: bodies are never cached and a batch is capped). |

### mesh_write.toml / env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `env.mesh_now` | `AH_ENGINE_MESH_NOW_MS` |  |  | Pins `Date.now()` of an `ah-engine mesh` verb, in epoch milliseconds (the parity tests pin Node's `ctx.now` the same way). Never set in production. |

### mesh_write.toml / mesh_write

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `mesh_write.action_ack_primary` | `ack-primary` |  |  | The `action` of an ack-primary result. |
| `mesh_write.action_heartbeat` | `heartbeat` |  |  | The `action` of a heartbeat result. |
| `mesh_write.action_mesh_history` | `mesh-history` |  |  | `action` of a mesh history result. |
| `mesh_write.action_mesh_read` | `mesh-read` |  |  | `action` of a mesh read result. |
| `mesh_write.action_send` | `send` |  |  | `action` of a send result. |
| `mesh_write.alias_file` | `sender-aliases.json` |  |  | The sender alias map under the DevSwarm state directory (devswarm-sender-alias.js). |
| `mesh_write.alias_key` | `aliases` |  |  | The object of that file holding the aliases. |
| `mesh_write.allowed_urgency` | `low, normal, high, urgent` |  |  | send's urgency words (Node's ALLOWED_URGENCY). |
| `mesh_write.app_busy_timeout_ms` | `0` |  |  | How long a locked app database is waited for: Node's node:sqlite waits not at all, so a locked database reads as unavailable. |
| `mesh_write.app_cache_dir` | `cache` |  |  | Directory under the DevSwarm root of the cross-invocation archived-verdict cache. |
| `mesh_write.app_cache_file` | `app-archived.json` |  |  | The cache file. |
| `mesh_write.app_cache_ttl_ms` | `30000` |  |  | How long a cached verdict map is trusted (CROSS_CACHE_TTL_MS). |
| `mesh_write.app_col_active` | `isActive` |  |  | The `builders` open flag column. |
| `mesh_write.app_col_builder_type` | `builderType` |  |  | The `builders` type column. |
| `mesh_write.app_col_hidden` | `isHidden` |  |  | The `builders` hidden flag column (archived = hidden and not active). |
| `mesh_write.app_col_id` | `id` |  |  | The `builders` id column. |
| `mesh_write.app_col_worktree` | `worktreePath` |  |  | The `builders` worktree column. |
| `mesh_write.app_cols_builder_terminals` | `13 items` |  |  | Every `builder_terminals` column the snapshot reads (SCHEMA.builder_terminals). |
| `mesh_write.app_cols_builders` | `16 items` |  |  | Every `builders` column the snapshot reads (SCHEMA.builders). |
| `mesh_write.app_cols_pull_requests` | `10 items` |  |  | Every `pull_requests` column the snapshot reads (SCHEMA.pull_requests). |
| `mesh_write.app_cols_repositories` | `id, path, name, defaultBaseBranch` |  |  | Every `repositories` column the snapshot reads (SCHEMA.repositories). |
| `mesh_write.app_core_columns` | `id, isActive` |  |  | The `builders` columns without which Node's app snapshot is null. |
| `mesh_write.app_db_linux` | `DevSwarm/devswarm.db` |  |  | The DevSwarm app database under the config directory on Linux. |
| `mesh_write.app_db_macos` | `Library/Application Support/DevSwarm/devswarm.db` |  |  | The DevSwarm app database under the home directory on macOS. |
| `mesh_write.app_db_off` | `off` |  |  | Its disabling value. |
| `mesh_write.app_max_exact_int` | `9007199254740991` |  |  | Integers beyond this magnitude are not exact JavaScript numbers; a database holding one in a column the verdict reads defers. |
| `mesh_write.app_prompt_column` | `initialPrompt` |  |  | The terminal column read as its length only (never its text). |
| `mesh_write.app_table_builders` | `builders` |  |  | The app's builder (workspace) table. |
| `mesh_write.app_table_pull_requests` | `pull_requests` |  |  | The app's pull-request table, read by the snapshot. |
| `mesh_write.app_table_repositories` | `repositories` |  |  | The app's repository table, read by the snapshot (a failed read of any of the three makes the snapshot null, as in Node). |
| `mesh_write.app_table_terminals` | `builder_terminals` |  |  | The app's terminal table, read by the snapshot besides `builders`. |
| `mesh_write.app_wal_suffix` | `-wal` |  |  | Suffix of the app database's write-ahead log, part of the cache signature. |
| `mesh_write.archive_request_marker` | `[[ANTIHALL_ARCHIVE_REQUEST]]` |  |  | Body marker of an archive-request send (devswarm-store.js ARCHIVE_REQUEST_MARKER). |
| `mesh_write.backend_journal` | `journal` |  |  | The marker text of Node's journal backend; a store pinned to it is Node's alone. |
| `mesh_write.boolean_only_flags` | `9 items` |  |  | Flags that never take a value (Node's BOOLEAN_ONLY_FLAGS). |
| `mesh_write.broadcast_partition` | `*mesh-broadcast*` |  |  | The shared partition every broadcast and heartbeat row lands in (Node's BROADCAST_PARTITION_ID). |
| `mesh_write.builder_type_primary` | `primary` |  |  | The builder type of a Primary checkout. |
| `mesh_write.busy_retries` | `5` |  |  | Attempts of a write that meets SQLITE_BUSY after the busy timeout (Node's SQLITE_BUSY_MAX_RETRIES). |
| `mesh_write.busy_retry_base_ms` | `20` |  |  | Fixed part of the sleep between those attempts, in milliseconds (Node: 20). |
| `mesh_write.busy_retry_jitter_ms` | `40` |  |  | Random part of that sleep, in milliseconds (Node: up to 40). |
| `mesh_write.busy_text` | `database is locked` |  |  | Lower-cased text of a SQLite busy error (Node's isSqliteBusyError also matches it). |
| `mesh_write.channel_store_cursor` | `store-cursor` |  |  | The `channel` of a failed own-partition cursor move in an ack result. |
| `mesh_write.claude_dir` | `.claude` |  |  | The harness's directory under the home directory. |
| `mesh_write.commondir_file` | `commondir` |  |  | The file of a linked worktree's git directory naming the common directory. |
| `mesh_write.cron_found_mail_cap` | `1000` |  |  | How many lines the cron-found-mail file keeps (core.js CRON_FOUND_MAIL_CAP). |
| `mesh_write.csv_separator` | `,` |  |  | Separator of a comma-separated setting. |
| `mesh_write.cursor_base_suffix` | `#base` |  |  | Suffix of a partition's legacy baseline cursor file name (cursors/<id>#base.json). |
| `mesh_write.cursor_floor_reader` | `#floor` |  |  | The reader key of a partition's floor row in reader_cursors (reader-cursors.js FLOOR). |
| `mesh_write.cursor_inst_sep` | `#inst-` |  |  | Separator of a legacy per-instance store cursor file name (cursors/<id>#inst-<short>.json). |
| `mesh_write.cursor_line_field` | `line` |  |  | Field of a JSON cursor file that holds its position (devswarm-inbox-cursor.js readCursor). |
| `mesh_write.cursor_log_cap` | `2000` |  |  | Records a cursor-write journal keeps (CURSOR_LOG_CAP); older ones move to the `.1` file. |
| `mesh_write.cursor_log_old_suffix` | `.1` |  |  | Suffix of the file that receives the records rotated out of a journal. |
| `mesh_write.cursor_log_unknown_key` | `unknown` |  |  | Journal file name used when the project key is missing or unsafe. |
| `mesh_write.cursor_max_digits` | `15` |  |  | Longest all-digit NDJSON cursor file the engine reads (parseInt of a longer digit string is only approximated by the specification, so such a file goes to Node). |
| `mesh_write.cursor_namespaces` | `store, nd` |  |  | The two cursor namespaces of `reader_cursors`, in Node's order (NAMESPACES): the store and the NDJSON inbox. |
| `mesh_write.cursor_ns_nd` | `nd` |  |  | The reader_cursors namespace of the durable NDJSON inbox side. |
| `mesh_write.cursor_ns_store` | `store` |  |  | The reader_cursors namespace of the store side. |
| `mesh_write.default_tmpdir` | `/tmp` |  |  | The temp directory when none of those variables is set. |
| `mesh_write.dir_anti_hall` | `.anti-hall` |  |  | anti-hall's directory under the home directory. |
| `mesh_write.dir_archived` | `archived` |  |  | The archived workspace descriptors directory under the DevSwarm state directory (row-state.js archiveCompleteIds). |
| `mesh_write.dir_cache` | `cache` |  |  | anti-hall's cache directory under its home directory (Jev's triage label cache lives there). |
| `mesh_write.dir_cursor_log` | `cursor-log` |  |  | Directory of the cursor-write journals under the DevSwarm root (cursors.js cursorLogPath). |
| `mesh_write.dir_cursors` | `cursors` |  |  | The legacy cursor files directory under the DevSwarm state directory (reader-cursors.js cursorsDir). |
| `mesh_write.dir_devswarm` | `devswarm` |  |  | The DevSwarm state directory under it. |
| `mesh_write.dir_drain` | `drain` |  |  | Directory of the drain markers under the DevSwarm root (devswarm-drain-marker.js). |
| `mesh_write.dir_heartbeats` | `heartbeats` |  |  | The heartbeats directory under the DevSwarm state directory. |
| `mesh_write.dir_liveness` | `liveness` |  |  | Directory of the persisted liveness verdicts under the DevSwarm root (liveness.js livenessPathFor). |
| `mesh_write.dir_locks` | `locks` |  |  | The locks directory under the DevSwarm state directory. |
| `mesh_write.dir_logs` | `logs` |  |  | Directory under the home's `.anti-hall` that holds the supervision event log. |
| `mesh_write.dir_plans` | `plans` |  |  | The plans directory under the DevSwarm state directory (devswarm-plan.js). |
| `mesh_write.dir_read_receipts` | `read-receipts` |  |  | Directory of read receipts under the DevSwarm root (readReceiptDir). |
| `mesh_write.dir_send_receipts` | `send-receipts` |  |  | The send receipts directory under the DevSwarm state directory (one JSON file per send, by UTC day). |
| `mesh_write.dir_state` | `state` |  |  | anti-hall's state directory under its home directory. |
| `mesh_write.dir_store` | `store` |  |  | The per-repo stores directory under the DevSwarm state directory. |
| `mesh_write.dir_summaries` | `summaries` |  |  | The per-project summary projections directory under the DevSwarm state directory (summaries/<repoKey>.json). |
| `mesh_write.dir_wake_tick` | `wake-tick` |  |  | The wake-tick marker directory under the DevSwarm state directory (core.js wakeTickDir). |
| `mesh_write.dir_wal` | `wal` |  |  | The delivery write-ahead-log directory under the DevSwarm state directory (devswarm-read-wal.js). |
| `mesh_write.dir_wal_spill` | `wal-spill` |  |  | The directory the delivery log spills batches to when the log itself is not writable. |
| `mesh_write.dir_workspaces` | `workspaces` |  |  | The workspace descriptors directory under the DevSwarm state directory. |
| `mesh_write.done_setby_prefix` | `devswarm-done@` |  |  | Setter prefix of a done gate that carries the HEAD sha (devswarm-store.js DONE_GATE_SETBY_PREFIX). |
| `mesh_write.dot_git` | `.git` |  |  | A checkout's git entry. |
| `mesh_write.dur_fmt_day` | `{v}d` |  |  | `dur()` in days; `{v}` is the count. |
| `mesh_write.dur_fmt_hour` | `{v}h` |  |  | `dur()` in hours; `{v}` is the count. |
| `mesh_write.dur_fmt_min` | `{v}m` |  |  | `dur()` in minutes; `{v}` is the count. |
| `mesh_write.dur_hours_before_days` | `48` |  |  | `dur()` shows hours below this many hours and days from it. |
| `mesh_write.dur_hours_per_day` | `24` |  |  | Hours in a day, for `dur()`. |
| `mesh_write.dur_min_per_hour` | `60` |  |  | Minutes in an hour, for `dur()`. |
| `mesh_write.dur_ms_per_min` | `60000` |  |  | Milliseconds in the minute `dur()` counts in. |
| `mesh_write.env_app_db` | `ANTIHALL_DEVSWARM_APP_DB` |  |  | The variable that points at (or, with `off`, disables) the DevSwarm app database. |
| `mesh_write.env_builder_id` | `DEVSWARM_BUILDER_ID` |  |  | The variable DevSwarm sets to a workspace's builder id. |
| `mesh_write.env_home` | `HOME` |  |  | The home directory variable (os.homedir() on POSIX). |
| `mesh_write.env_jev` | `ANTIHALL_JEV` |  |  | The variable that forces Jev on (1) or off (0). |
| `mesh_write.env_off_value` | `0` |  |  | Its off value. |
| `mesh_write.env_on_value` | `1` |  |  | Its on value. |
| `mesh_write.env_project_dir` | `CLAUDE_PROJECT_DIR` |  |  | The harness's project directory variable (projectCwdFor's last fallback). |
| `mesh_write.env_session_id` | `CLAUDE_CODE_SESSION_ID` |  |  | The variable naming the caller's session (the Primary seat guard reads it). |
| `mesh_write.env_source_branch` | `DEVSWARM_SOURCE_BRANCH` |  |  | The environment variable that marks a DevSwarm child workspace (devswarm-role.js isChildWorkspace). |
| `mesh_write.env_store_backend` | `ANTIHALL_DEVSWARM_STORE_BACKEND` |  |  | The variable that forces Node's store backend (ANTIHALL_DEVSWARM_STORE_BACKEND). |
| `mesh_write.env_tmpdir` | `TMPDIR, TMP, TEMP` |  |  | The environment variables that name the temp directory, in the order Node's os.tmpdir() reads them. |
| `mesh_write.env_verify_nonce` | `AH_ENGINE_VERIFY_NONCE` |  |  | The environment variable that hands the engine's reader nonce to the tick verifier (the detached verifier does not share the caller's process ancestry, which Node derives the reader from); it is the name the verify_tick_node_snippet reads. |
| `mesh_write.env_xdg_config` | `XDG_CONFIG_HOME` |  |  | The XDG config directory variable (Linux). |
| `mesh_write.err_cursor_import_needed` | `reader_cursors floor row missing (legacy import needed)` |  |  | Failure text when a partition has no floor row and the engine will not import the legacy cursors itself (Node's reader-cursors import). |
| `mesh_write.ev_correction_followed` | `correction-followed` |  |  | Supervision event type: step progress arrived within the stall window of a correction. |
| `mesh_write.ev_respawn_progress` | `respawn-progress` |  |  | Supervision event type: first step progress in a respawned workspace. |
| `mesh_write.ev_step` | `step` |  |  | Supervision event type: a child reported a step status change. |
| `mesh_write.exit_committed_failure` | `70` |  |  | Exit code when the engine failed AFTER its write was committed (a panic): Node is NOT run then, since running the verb again would write twice (sysexits EX_SOFTWARE, 70). Deliberately NOT 75: exit 75 (EX_TEMPFAIL) means 'deferred, nothing written' everywhere in the engine (dispatch.defer_exit), and a caller that sees 75 may run Node. |
| `mesh_write.exit_defer` | `75` |  |  | Exit code meaning: the engine did not act and wrote nothing, so the caller should run the verb in Node (sysexits EX_TEMPFAIL, 75). `ah-engine mesh` runs a deferred verb in Node itself, so it exits with this only when it cannot start Node (it replaces the former 127 for that case). Never used after a write: see exit_committed_failure. |
| `mesh_write.exit_signal_base` | `128` |  |  | A Node child killed by signal N exits as this plus N (the shell convention). |
| `mesh_write.field_cursor_path` | `cursorPath` |  |  | Descriptor field naming the durable inbox's cursor file. |
| `mesh_write.field_enabled` | `enabled` |  |  | Jev's on/off field. |
| `mesh_write.field_id` | `id` |  |  | The descriptor field holding the workspace id. |
| `mesh_write.field_inbox_path` | `inboxPath` |  |  | The descriptor field holding the NDJSON inbox path. |
| `mesh_write.field_kind` | `kind` |  |  | Field of a triage label that holds its kind. |
| `mesh_write.field_owner_key` | `ownerKey` |  |  | A descriptor's owner store key (a re-home candidate when it is the legacy hash bucket). |
| `mesh_write.field_repo_key` | `repoKey` |  |  | A descriptor's persisted project key. |
| `mesh_write.field_session_id` | `sessionId` |  |  | A descriptor's session field. |
| `mesh_write.field_worktree_path` | `worktreePath` |  |  | A descriptor's worktree field. |
| `mesh_write.file_cron_found_mail` | `cron-found-mail.jsonl` |  |  | The cron-found-mail measurement file under the DevSwarm state directory (core.js cronFoundMailPath). |
| `mesh_write.flag_ack` | `ack` |  |  | roster's consume flag. |
| `mesh_write.flag_ack_as_owner` | `ack-as-owner` |  |  | The flag that skips the ownership check of ack-primary. |
| `mesh_write.flag_answers` | `answers` |  |  | send's reply-correlation flag. |
| `mesh_write.flag_blockers` | `blockers` |  |  | The repeatable heartbeat flag for blockers. |
| `mesh_write.flag_broadcast` | `broadcast` |  |  | send's broadcast flag. |
| `mesh_write.flag_cc_primary` | `cc-primary` |  |  | send's copy-the-Primary flag (Node only). |
| `mesh_write.flag_dash_h` | `-h` |  |  | The `-h` word. |
| `mesh_write.flag_from` | `from` |  |  | send's redundant sender declaration. |
| `mesh_write.flag_h` | `h` |  |  | Short help flag name (`--h`). |
| `mesh_write.flag_help` | `help` |  |  | Help flag name. |
| `mesh_write.flag_json` | `json` |  |  | Raw JSON output flag. |
| `mesh_write.flag_last` | `last` |  |  | mesh read's newest-N flag. |
| `mesh_write.flag_message` | `message` |  |  | send's body flag. |
| `mesh_write.flag_message_file` | `message-file` |  |  | send's body-from-file flag. |
| `mesh_write.flag_message_stdin` | `message-stdin` |  |  | send's body-from-stdin flag. |
| `mesh_write.flag_peek` | `peek` |  |  | mesh read's non-consuming flag. |
| `mesh_write.flag_phase` | `phase` |  |  | The heartbeat flag for the phase text. |
| `mesh_write.flag_progress` | `progress` |  |  | The heartbeat flag for the progress percentage. |
| `mesh_write.flag_question` | `question` |  |  | send's needs-reply flag. |
| `mesh_write.flag_quiet` | `quiet` |  |  | send's one-line output flag. |
| `mesh_write.flag_receipt` | `receipt` |  |  | The ack-primary flag naming the read receipt. |
| `mesh_write.flag_seq` | `seq` |  |  | mesh read's explicit baseline flag. |
| `mesh_write.flag_session` | `session` |  |  | The heartbeat flag naming the session; without it Node logs the caller (heartbeat-callers.log), which the engine cannot reproduce, so the call goes to Node. |
| `mesh_write.flag_since` | `since` |  |  | mesh read's time filter (Node only). |
| `mesh_write.flag_status` | `status` |  |  | The heartbeat flag that names a step's status. |
| `mesh_write.flag_step` | `step` |  |  | The heartbeat flag that records plan progress; with it the call goes to Node. |
| `mesh_write.flag_summary` | `summary` |  |  | The heartbeat flag that also broadcasts a mesh heartbeat row; with it the call goes to Node. |
| `mesh_write.flag_tail` | `tail` |  |  | A window flag the acking inbox verbs refuse (INBOX_WINDOW_FLAGS); with --since it sends the call to Node. |
| `mesh_write.flag_to` | `to` |  |  | send's recipient flag. |
| `mesh_write.flag_to_primary` | `to-primary` |  |  | send's Primary flag. |
| `mesh_write.flag_type` | `type` |  |  | send's type flag (`--type broadcast`). |
| `mesh_write.flag_urgency` | `urgency` |  |  | send's urgency flag. |
| `mesh_write.flag_wip` | `wip` |  |  | The repeatable heartbeat flag for work in progress. |
| `mesh_write.floor_reader` | `#floor` |  |  | The reader name of the floor row in `reader_cursors` (FLOOR). |
| `mesh_write.gate_done` | `done` |  |  | The gate a child's `done` verb sets. |
| `mesh_write.gate_merged_verified` | `merged_verified` |  |  | The report-only gate recording the merged ancestry check. |
| `mesh_write.gate_owner` | `owner` |  |  | The journal `gate` of a cursor move of the caller's own partition. |
| `mesh_write.git_config_file` | `config` |  |  | A git directory's config file. |
| `mesh_write.git_core_section` | `[core]` |  |  | The config section holding `worktree`. |
| `mesh_write.git_modules_dir` | `modules` |  |  | Where a superproject keeps absorbed submodule git directories. |
| `mesh_write.git_worktree_key` | `worktree` |  |  | The `core.worktree` key (an absorbed submodule's git directory carries it; the engine then defers to Node). |
| `mesh_write.gitdir_key` | `gitdir:` |  |  | The key of a `.git` file pointing at its git directory. |
| `mesh_write.hb_plan_hint` | `no step plan for {id} — run `devswarm.js plan set {id} --steps "1. …\n2. …"` ...` |  |  | The `plan.hint` of a heartbeat --step for a workspace that has no plan; `{id}` is the workspace id. |
| `mesh_write.hb_plan_no_plan` | `no-plan` |  |  | The `plan.reason` of a heartbeat --step for a workspace that has no plan. |
| `mesh_write.hb_urgency_default` | `low` |  |  | The urgency of a heartbeat --summary broadcast when --urgency is not given. |
| `mesh_write.heal_healthy` | `daemonHealthy` |  |  | The self-heal field of a healthy daemon. |
| `mesh_write.heal_no_worktree` | `no-worktree` |  |  | daemonWarning when the cwd is not in a checkout. |
| `mesh_write.heal_stale` | `stale` |  |  | daemonWarning when the ingest daemon looks stale or missing. |
| `mesh_write.heal_warning` | `daemonWarning` |  |  | The self-heal field naming a daemon problem. |
| `mesh_write.heartbeat_source` | `cli-heartbeat` |  |  | The `source` a CLI heartbeat stamps on its record (cmdHeartbeat). |
| `mesh_write.heartbeat_source_tick` | `inbox-tick` |  |  | The `source` a tick stamps on a heartbeat record it has to create (cmdInboxTick). |
| `mesh_write.held_partitions_default` | `` |  |  | Schema default of devswarm.heldPartitions (none held). |
| `mesh_write.held_partitions_env` | `ANTIHALL_DEVSWARM_HELD_PARTITIONS` |  |  | Environment variable of devswarm.heldPartitions. |
| `mesh_write.held_partitions_key` | `heldPartitions` |  |  | settings.json key of the owner-held partition ids. |
| `mesh_write.held_partitions_option` | `` |  |  | Plugin option of devswarm.heldPartitions (it has none: empty). |
| `mesh_write.held_partitions_option_default` | `` |  |  | Manifest default of that plugin option (unused while it has none). |
| `mesh_write.history_seq` | `0` |  |  | The baseline `mesh history` reads from. |
| `mesh_write.id_lock_boot_slop_s` | `5` |  |  | Two boot times this close are one boot (lock.js BOOT_SLOP_S). |
| `mesh_write.id_lock_budget_ms` | `2000` |  |  | How long one acquire keeps retrying a lock held by a live, fresh holder before the verb reports lockBusy (Node: 2000). |
| `mesh_write.id_lock_reclaim_stale_ms` | `5000` |  |  | A takeover marker (`<lock>.reclaim`) older than this is abandoned (lock.js RECLAIM_STALE_MS). |
| `mesh_write.id_lock_release_step_ms` | `10` |  |  | Pause between those attempts (lock.js RELEASE_SIDECAR_STEP_MS). |
| `mesh_write.id_lock_release_tries` | `5` |  |  | Attempts a release makes to take the takeover marker (lock.js RELEASE_SIDECAR_TRIES). |
| `mesh_write.id_lock_stale_ms` | `900000` |  |  | A lock older than this is taken over whoever holds it (Node's LOCK_STALE_MS, 15 minutes). |
| `mesh_write.id_lock_step_ms` | `25` |  |  | Pause between those retries, in milliseconds (Node: 25). |
| `mesh_write.ingest_beat_prefix` | `ingest-` |  |  | File-name prefix of a project's ingest-daemon heartbeat (ingest-health.js ingestHeartbeatPath). |
| `mesh_write.ingest_beat_stale_ms` | `180000` |  |  | An ingest heartbeat older than this is not fresh (ingest-health.js HEARTBEAT_STALE_MS, 3 minutes). |
| `mesh_write.ingest_lock_prefix` | `ingest-project-` |  |  | File-name prefix of a project's ingest-daemon lock (ingest-health.js ingestProjectLockPath). |
| `mesh_write.jev_cache_file` | `jev-triage.json` |  |  | Jev triage's label cache file under anti-hall's cache directory (jev-triage.js cachePath). |
| `mesh_write.jev_file` | `jev.json` |  |  | Jev's own config file under anti-hall's directory (jev-triage.js jevConfigPath). |
| `mesh_write.jev_hash_hex` | `32` |  |  | Hex characters of a triage cache key (jev-triage.js hashMessage: sha256, first 32). |
| `mesh_write.jev_pending_file` | `jev-triage-pending.json` |  |  | Jev triage's pending labeled messages under anti-hall's state directory (jev-triage.js pendingPath). |
| `mesh_write.jev_question_kind` | `question-needs-answer` |  |  | The triage label kind of a message that asks a question (jev-triage.js). |
| `mesh_write.js_false` | `false` |  |  | JavaScript's text for false, as a tick line prints a boolean. |
| `mesh_write.js_null` | `null` |  |  | `String(null)`. |
| `mesh_write.js_true` | `true` |  |  | JavaScript's text for true, as a tick line prints a boolean. |
| `mesh_write.js_undefined` | `undefined` |  |  | `String(undefined)`. |
| `mesh_write.json_suffix` | `.json` |  |  | File-name suffix of a JSON record. |
| `mesh_write.kind_child` | `child` |  |  | Sender identity kind: a child workspace's registered id. |
| `mesh_write.kind_declared` | `declared` |  |  | Caller identity kind: DEVSWARM_BUILDER_ID was trusted. |
| `mesh_write.kind_deleted` | `deleted` |  |  | Context kind of a path that does not exist. |
| `mesh_write.kind_linked` | `linked-worktree` |  |  | Context kind of a linked worktree. |
| `mesh_write.kind_main` | `main` |  |  | Context kind of a main checkout. |
| `mesh_write.kind_non_git` | `non-git` |  |  | Context kind of a path outside any checkout. |
| `mesh_write.kind_resolved` | `resolved` |  |  | Caller identity kind: the cwd is a checkout. |
| `mesh_write.kind_submodule_prefix` | `submodule-in-` |  |  | Prefix of a submodule context kind. |
| `mesh_write.kind_unresolvable` | `unresolvable` |  |  | Caller identity kind: neither (a hash of the raw cwd). |
| `mesh_write.lbl_all_done` | `steps {total}/{total} done · {tail}` |  |  | The finish label head when every step is done; `{total}` is the step count, `{tail}` the progress part. |
| `mesh_write.lbl_blocked_many` | `{k} blocked` |  |  | A finish label part for several blocked steps. |
| `mesh_write.lbl_blocked_one` | `#{n} blocked` |  |  | A finish label part for exactly one blocked step. |
| `mesh_write.lbl_doing_many` | `{k} doing` |  |  | A finish label part for several steps in progress. |
| `mesh_write.lbl_doing_one` | `doing #{n}` |  |  | A finish label part for exactly one step in progress; `{n}` is its number. |
| `mesh_write.lbl_done_of` | `{done}/{total} done` |  |  | The done count of a finish label. |
| `mesh_write.lbl_done_reported_part` | `done-reported {dur} ago, awaiting Primary` |  |  | A finish label part once the child reported done; `{dur}` is the time since. |
| `mesh_write.lbl_done_reported_tail` | `done-reported, awaiting Primary` |  |  | The tail of the all-done label once the child reported done. |
| `mesh_write.lbl_inferred` | `~#{n}` |  |  | A finish label part for an inferred step. |
| `mesh_write.lbl_no_progress` | `no progress yet` |  |  | The progress part of a finish label before any progress. |
| `mesh_write.lbl_plan_changed` | ` (plan changed)` |  |  | Appended to the done count after the plan was replaced or a done step re-opened. |
| `mesh_write.lbl_progress_ago` | `progress {dur} ago` |  |  | The progress part of a finish label; `{dur}` is the time since the last progress. |
| `mesh_write.lbl_sep` | ` · ` |  |  | Separator of the parts of a plan's finish label. |
| `mesh_write.legacy_cursor_forbidden` | `#, .seen-` |  |  | Texts a partition id must not contain to have legacy cursor files (reader-cursors.js legacySafeId). |
| `mesh_write.legacy_cursor_short_len` | `6` |  |  | Length of the hex instance tag in a legacy cursor file name (reader-cursors.js listLegacy). |
| `mesh_write.legacy_hash_prefix` | `legacy:` |  |  | Prefix of the dedupe hash of one physical legacy inbox line (devswarm-unread.js legacyLineHash). |
| `mesh_write.liveness_alive` | `alive` |  |  | The `status` a heartbeat writes into the liveness verdict (a heartbeat is proof of life). |
| `mesh_write.lock_suffix` | `.lock` |  |  | File-name suffix of a lock file. |
| `mesh_write.log_ns_store` | `reader_cursors:store` |  |  | The journal `ns` of a store-namespace reader cursor move. |
| `mesh_write.max_ppid_hops` | `6` |  |  | Parent hops the reader-nonce walk takes looking for a harness session record (reader-identity.js MAX_PPID_HOPS). |
| `mesh_write.max_submodule_hops` | `32` |  |  | Superproject hops a resolution takes (identity.js MAX_SUBMODULE_HOPS). |
| `mesh_write.merged_setby_prefix` | `devswarm-merged@` |  |  | Setter prefix of a merged_verified gate that carries the HEAD sha (devswarm-store.js MERGED_VERIFIED_SETBY_PREFIX). |
| `mesh_write.mesh_hash_prefix` | `mesh:` |  |  | Prefix of a store-direct mesh message's dedupe hash (Node's meshMessageHash namespace). |
| `mesh_write.mesh_id_hex` | `8` |  |  | Hex characters of the worktree hash in a meshId (and of hashFromWorkspaceId). |
| `mesh_write.messages_added_columns` | `9 items` |  |  | The additive `messages` columns Node's ensureMessagesMeshColumns adds to an older table, in Node's order, as `name TYPE`. |
| `mesh_write.min_plausible_start_ms` | `1000000000000` |  |  | A recorded reader start time below this is not an epoch-milliseconds value, so no pid-reuse conclusion is drawn from it. |
| `mesh_write.mode_on` | `on` |  |  | The `mode` of an on-mode record in the shadow log. |
| `mesh_write.mode_shadow` | `shadow` |  |  | The `mode` of a shadow record in the shadow log. |
| `mesh_write.monitor_failure_threshold` | `3` |  |  | Consecutive monitor failures that make a live ingest daemon FAILING (doctor-repair.js MONITOR_FAILURE_FAIL_THRESHOLD). |
| `mesh_write.month_names` | `12 items` |  |  | Month abbreviations of that start time, January first (what Date.parse reads). |
| `mesh_write.ms_per_minute` | `60000` |  |  | Milliseconds in a minute (the unit conversion of that setting). |
| `mesh_write.msg_committed_failure` | `ah-engine mesh: the write was committed but the engine failed before printing...` |  |  | Stderr line for that case. |
| `mesh_write.msg_mesh_read_hint` | `consumed broadcasts stay re-readable without moving any cursor: `mesh history...` |  |  | `hint` of a consuming mesh read. |
| `mesh_write.msg_no_node_cli` | `ah-engine mesh: cannot find scripts/devswarm.js (no plugin root); run the ver...` |  |  | stderr line when the plugin root (and so Node's CLI) is unknown. |
| `mesh_write.msg_node_exec_failed` | `ah-engine mesh: could not start node: {err}` |  |  | stderr line when starting Node failed. Placeholder: {err}. |
| `mesh_write.msg_not_verified` | `send appended a row (hash {hash}) but the readback against partition {partiti...` |  |  | `error` of that send. Placeholders: {hash}, {partition} (JSON-quoted). |
| `mesh_write.msg_registry_collision` | `[devswarm-store] upsertRegistry: id {id} already maps to worktree_path {exist...` |  |  | stderr line of a registry upsert refused by the id-collision guard. Placeholders: {id}, {existing}, {incoming} (JSON-quoted). |
| `mesh_write.mtype_broadcast` | `broadcast` |  |  | The `mtype` of a broadcast (also `send --type broadcast`). |
| `mesh_write.mtype_direct` | `direct` |  |  | The `mtype` of a direct message. |
| `mesh_write.ndjson_created_field` | `createdAt` |  |  | The field of an NDJSON line that carries its creation time (second choice, the native pull shape). |
| `mesh_write.ndjson_hash_field` | `_h` |  |  | The field of an NDJSON inbox line that carries the content hash of a natively drained message. |
| `mesh_write.ndjson_suffix` | `.ndjson` |  |  | Suffix of a journal file. |
| `mesh_write.ndjson_ts_field` | `ts` |  |  | The field of an NDJSON line that carries its timestamp (first choice). |
| `mesh_write.node_bin` | `node` |  |  | The Node binary the engine hands a verb to. |
| `mesh_write.node_cli` | `scripts/devswarm.js` |  |  | Node's mesh CLI, relative to the plugin root. |
| `mesh_write.nonce_prefix` | `h:` |  |  | Prefix of a reader nonce (`h:<pid>:<startMs>`). |
| `mesh_write.not_draining_age_ms` | `1200000` |  |  | Age of the oldest unread row past which a backlog is also flagged notDraining (liveness.js NOT_DRAINING_AGE_MS, 20 minutes). |
| `mesh_write.ns_store` | `store` |  |  | The store cursor namespace of `reader_cursors` (the position in the store's messages). |
| `mesh_write.on_native` | `native` |  |  | On-mode result: the engine answered the call itself. |
| `mesh_write.op_nd` | `nd` |  |  | The `k` of a read-receipt op that moves the NDJSON inbox cursor (Node's). |
| `mesh_write.op_own` | `own` |  |  | The `k` of a read-receipt op that moves the caller's own partition cursor. |
| `mesh_write.op_sibling` | `sibling` |  |  | The `k` of a read-receipt op that moves a sibling partition's cursor (Node's). |
| `mesh_write.pid_reuse_margin_ms` | `1000` |  |  | A process whose start time is later than the recorded one by more than this is a reused pid (PID_REUSE_MARGIN_MS). |
| `mesh_write.plan_activity_keep` | `5` |  |  | How many recent activity signatures a plan keeps (ACTIVITY_KEEP). |
| `mesh_write.plan_bad_status_text` | `--status must be one of {list}` |  |  | The error of `heartbeat --status S` when S is not an allowed status; `{list}` is the allowed statuses. |
| `mesh_write.plan_bad_step_text` | `--step must be an integer from 1 to {n}` |  |  | The error of `heartbeat --step N` when N is not an integer within the plan; `{n}` is the number of steps. |
| `mesh_write.plan_lock_busy_hint` | `the plan file is locked by another writer — the heartbeat itself was recorded...` |  |  | The `plan.hint` of a heartbeat whose plan file stayed locked. |
| `mesh_write.plan_lock_stale_ms` | `30000` |  |  | A plan lock older than this is taken over (PLAN_LOCK_STALE_MS). |
| `mesh_write.plan_lock_step_ms` | `15` |  |  | The pause between attempts at the plan's lock (Node: 10 ms plus up to 10 ms of jitter). |
| `mesh_write.plan_lock_wait_ms` | `5000` |  |  | How long a plan write waits for the plan's lock (PLAN_LOCK_WAIT_MS). |
| `mesh_write.plan_reason_bad_step` | `bad-step` |  |  | The `plan.reason` of a heartbeat whose --step or --status is invalid. |
| `mesh_write.plan_reason_lock_busy` | `lock-busy` |  |  | The `plan.reason` of a heartbeat whose plan file stayed locked by another writer. |
| `mesh_write.plan_sig_hex` | `12` |  |  | Hex characters of an activity signature (the sha1 prefix). |
| `mesh_write.plan_status_blocked` | `blocked` |  |  | The step status word for a blocked step. |
| `mesh_write.plan_status_default` | `doing` |  |  | The step status of `heartbeat --step` when --status is not given. |
| `mesh_write.plan_status_doing` | `doing` |  |  | The step status word for a step in progress. |
| `mesh_write.plan_status_done` | `done` |  |  | The step status word for a finished step. |
| `mesh_write.plan_status_sep` | `\|` |  |  | Joins the allowed statuses in the --status error text. |
| `mesh_write.plan_statuses` | `doing, done, blocked` |  |  | The step statuses `heartbeat --status` accepts (STEP_STATUSES). |
| `mesh_write.plan_summary_keep` | `3` |  |  | How many recent heartbeat summaries a plan keeps (SUMMARY_KEEP). |
| `mesh_write.plan_summary_text_max` | `200` |  |  | Characters of a heartbeat summary kept in the plan (recordSummary). |
| `mesh_write.plugin_manifest_dir` | `.claude-plugin` |  |  | Directory of the plugin manifest under the plugin root. |
| `mesh_write.plugin_manifest_file` | `plugin.json` |  |  | The plugin manifest whose `version` a heartbeat stamps (runningAntiHallVersion). |
| `mesh_write.primary_prefix` | `primary-` |  |  | Prefix of a worktree meshId (`primary-<hash>`). |
| `mesh_write.ps_bin` | `ps` |  |  | The process-table tool the nonce walk runs, as Node does. |
| `mesh_write.ps_lstart_args` | `-o, lstart=, -p` |  |  | Its arguments for one process's start time, followed by the pid (liveness.js processStartMs). |
| `mesh_write.ps_poll_ms` | `5` |  |  | How often the process snapshot checks whether `ps` has finished. |
| `mesh_write.ps_ppid_args` | `-A, -o, pid=,ppid=` |  |  | Its arguments for the pid/parent table (reader-identity.js defaultPpidTable). |
| `mesh_write.ps_snapshot_args` | `-A, -o, pid=,lstart=` |  |  | Arguments of the one `ps` call that snapshots every process with its start time (psSnapshot). |
| `mesh_write.ps_snapshot_timeout_ms` | `5000` |  |  | Time limit of that call (psSnapshot's 5000). |
| `mesh_write.quiet_broadcast` | `(broadcast)` |  |  | The {to} of a broadcast in the quiet line. |
| `mesh_write.quiet_fail` | `ok:false {why}` |  |  | `send --quiet` line of a failed send. Placeholder: {why}. |
| `mesh_write.quiet_failed` | `send failed` |  |  | The {why} of a failed send with neither error nor reason. |
| `mesh_write.quiet_ok` | `sent seq {seq} -> {to}, {bytes} bytes, ok` |  |  | `send --quiet` line of a delivered send. Placeholders: {seq}, {to}, {bytes}. |
| `mesh_write.quiet_unknown` | `(unknown)` |  |  | The {to} of a send with no recipient in the quiet line. |
| `mesh_write.reason_not_verified` | `send-not-verified` |  |  | `reason` of a send whose readback did not find the row. |
| `mesh_write.receipt_id_prefix` | `r` |  |  | A read receipt id is this letter followed by lowercase letters and digits (readReadReceipt's /^r[a-z0-9]+$/). |
| `mesh_write.receipt_ttl_ms` | `86400000` |  |  | Age past which a read receipt can no longer be acked (READ_RECEIPT_TTL_MS, 24 hours). |
| `mesh_write.repo_key_hex` | `6` |  |  | Hex characters of the common-dir hash in a repoKey. |
| `mesh_write.repo_name_fallback` | `repo` |  |  | A repo name that sanitizes to nothing. |
| `mesh_write.repo_name_max` | `40` |  |  | Length cap of a repo name in a repoKey (identity.js MAX_NAME_LEN). |
| `mesh_write.required_gates_default` | `done,merged,tests_passed` |  |  | Schema default of devswarm.requiredGates. |
| `mesh_write.required_gates_env` | `ANTIHALL_DEVSWARM_REQUIRED_GATES` |  |  | Environment variable of devswarm.requiredGates (settings-schema.js). |
| `mesh_write.required_gates_fallback` | `done, merged, tests_passed` |  |  | The gates used when the setting lists none (devswarm-store.js DEFAULT_REQUIRED_GATES). |
| `mesh_write.required_gates_key` | `requiredGates` |  |  | settings.json key of the gates a workspace needs before it is archive-ready. |
| `mesh_write.required_gates_option` | `devswarm_required_gates` |  |  | Plugin option (/config) of devswarm.requiredGates. |
| `mesh_write.required_gates_option_default` | `done,merged,tests_passed` |  |  | The plugin option's manifest default; a plugin option equal to it does not override (settings.js readPluginOption). |
| `mesh_write.result_committed` | `committed-failure` |  |  | Log result of a call that failed after its write was committed. |
| `mesh_write.retire_pin_age_ms` | `60000` |  |  | A foreign reader row must be this old before an ack looks for proof that its process ended (RETIRE_PIN_AGE_MS). |
| `mesh_write.send_lock_attempts` | `3` |  |  | Whole lock acquisitions a direct send tries before reporting lockBusy (Node's SEND_LOCK_RETRY_ATTEMPTS). |
| `mesh_write.send_lock_max_shift` | `8` |  |  | Cap on the backoff exponent (a guard; Node's 3 attempts never reach it). |
| `mesh_write.send_lock_retry_base_ms` | `150` |  |  | Backoff base between those attempts: base * 2^attempt plus up to base of jitter (Node's SEND_LOCK_RETRY_BASE_MS). |
| `mesh_write.sessions_dir` | `sessions` |  |  | The harness's per-process session records under it (`<pid>.json`). |
| `mesh_write.setting_monitor_no_ok_fail_min` | `4 entries` |  |  | Where devswarm.monitorNoOkFailMin is read from (minutes without a successful monitor poll before the daemon reads FAILING). |
| `mesh_write.settings_devswarm_section` | `devswarm` |  |  | The settings.json section of the DevSwarm settings. |
| `mesh_write.settings_file` | `settings.json` |  |  | anti-hall's settings file under its directory. |
| `mesh_write.settings_jev_section` | `jev` |  |  | The settings section Jev reads. |
| `mesh_write.shadow_backup_pages` | `1000000` |  |  | Pages per step of the store snapshot (SQLite online backup); large means one step. |
| `mesh_write.shadow_backup_pause_ms` | `0` |  |  | Pause between snapshot steps, in milliseconds. |
| `mesh_write.shadow_concurrent` | `concurrent` |  |  | Shadow result: something differs, but another writer added rows between the snapshot and Node's write (the seq can differ). |
| `mesh_write.shadow_defer` | `defer` |  |  | Shadow result: the engine would have handed this call to Node (the reason says why). |
| `mesh_write.shadow_dir` | `mesh-shadow` |  |  | Scratch directory (under the engine state directory) of one shadow replay; removed when it ends. |
| `mesh_write.shadow_home` | `home` |  |  | The scratch home the replay writes its side files into (receipts), under that directory. |
| `mesh_write.shadow_log` | `mesh-shadow.jsonl` |  |  | The shadow log, one JSON line per replayed call, under the engine state directory. |
| `mesh_write.shadow_log_cap` | `2000` |  |  | Most characters of each side's stdout a mismatch record keeps. |
| `mesh_write.shadow_match` | `match` |  |  | Shadow result: stdout, exit code and the written row all equal Node's. |
| `mesh_write.shadow_mismatch` | `mismatch` |  |  | Shadow result: something differs and no other writer touched the store meanwhile. |
| `mesh_write.shadow_no_store` | `no-store` |  |  | Defer reason when the project has no store file yet. |
| `mesh_write.shadow_panic` | `panic` |  |  | Shadow result: the engine path panicked (caught; Node's result was unaffected). |
| `mesh_write.shadow_skipped` | `skipped` |  |  | Log result of a shadow-mode call for a verb that cannot be replayed on a store copy: Node ran it, the engine only counted it. |
| `mesh_write.short_nonce_len` | `6` |  |  | Hex characters of the short form of a reader key in the cursor journal (shortInstanceNonce: sha1, first 6). |
| `mesh_write.step_stall_default_min` | `30` |  |  | Minutes of the step stall window when no setting is given (devswarm.stepStallMin). |
| `mesh_write.step_stall_env` | `ANTIHALL_DEVSWARM_STEP_STALL_MIN` |  |  | The environment variable of the devswarm.stepStallMin setting. |
| `mesh_write.step_stall_key` | `stepStallMin` |  |  | The settings.json key (in the devswarm section) of the step stall window. |
| `mesh_write.step_stall_option` | `devswarm_step_stall_min` |  |  | The plugin option name of the step stall window. |
| `mesh_write.store_file` | `devswarm.db` |  |  | File name of a per-repo store (`devswarm.db`). |
| `mesh_write.summary_failed` | `summary-failed` |  |  | Log result of a summary refresh the engine could not do after its write (Node's next derive refreshes the file). |
| `mesh_write.summary_pending_questions_cap` | `200` |  |  | Most per-sender pending questions a summary keeps per workspace (devswarm-store.js DEFAULT_PENDING_QUESTIONS_CAP). |
| `mesh_write.summary_recent_cap` | `50` |  |  | Most broadcast runs a summary keeps in recent[] (devswarm-store.js DEFAULT_RECENT_CAP). |
| `mesh_write.supervision_log` | `devswarm-supervision.ndjson` |  |  | The supervision event log (one JSON line per plan step event), under the logs directory. |
| `mesh_write.supervision_max_bytes` | `1048576` |  |  | Size above which Node rotates the supervision log before appending; the engine defers a plan write while the log is above it (rotation stays Node's). |
| `mesh_write.synthetic_session_prefix` | `unclaimed:` |  |  | The same prefix as the routing code names it (SYNTHETIC_SESSION_PREFIX). |
| `mesh_write.tick_line` | `tick {id}: unread {unread}, known {known}, meshGap {gap}, watcherArmed {armed}` |  |  | The one line `inbox tick --quiet` prints (inboxTickQuietLine); `{id}`, `{unread}`, `{known}`, `{gap}` and `{armed}` are filled in. |
| `mesh_write.tick_roster_env` | `ANTIHALL_DEVSWARM_TICK_ROSTER_EVERY` |  |  | The environment variable of that setting. |
| `mesh_write.tick_roster_setting` | `tickRosterEvery` |  |  | Name of the setting (devswarm.tickRosterEvery) that makes a quiet tick append the roster; any trace of it sends the tick to Node. |
| `mesh_write.tick_settings_files` | `.anti-hall/settings.json, .claude/settings.json` |  |  | The settings files, relative to the home directory, in which a trace of the roster setting sends a tick to Node. |
| `mesh_write.tick_tmp_suffix` | `.tick.tmp` |  |  | Suffix of the staged file a tick marker or heartbeat refresh is written to before the rename (after `.<pid>.<clock>`). |
| `mesh_write.tmp_suffix` | `.tmp` |  |  | Suffix of a staged file before its rename. |
| `mesh_write.unclaimed_prefix` | `unclaimed:` |  |  | Prefix of a session id that no real session claimed yet (the seat ignores it). |
| `mesh_write.urgency_default` | `normal` |  |  | send's urgency when none is given. |
| `mesh_write.urgency_rank` | `low, normal, high, urgent` |  |  | Urgency words from lowest to highest (devswarm-store.js URGENCY_RANK); any other word is ignored. |
| `mesh_write.value_required_flags` | `message, message-file` |  |  | Flags that always take the next word as their value (Node's VALUE_REQUIRED_FLAGS). |
| `mesh_write.verb_ack_primary` | `ack-primary` |  |  | The inbox sub-verb that applies a read receipt's cursor moves. |
| `mesh_write.verb_heartbeat` | `heartbeat` |  |  | The heartbeat verb. |
| `mesh_write.verb_help` | `help` |  |  | The help verb. |
| `mesh_write.verb_history` | `history` |  |  | Its history subcommand. |
| `mesh_write.verb_inbox` | `inbox` |  |  | The inbox verb. |
| `mesh_write.verb_mesh` | `mesh` |  |  | The mesh verb. |
| `mesh_write.verb_read` | `read` |  |  | Its read subcommand. |
| `mesh_write.verb_roster` | `roster` |  |  | The roster verb (`roster --ack` is `mesh read`). |
| `mesh_write.verb_send` | `send` |  |  | The send verb. |
| `mesh_write.verb_tick` | `tick` |  |  | The tick subverb of `inbox`. |
| `mesh_write.verify_cap` | `600` |  |  | Characters of each output kept in a mismatch record. |
| `mesh_write.verify_copy_dirs` | `7 items` |  |  | Directories of the DevSwarm root copied into the scratch home before the engine writes (what Node reads or writes for a heartbeat). |
| `mesh_write.verify_dir` | `mesh-verify` |  |  | Directory in the state directory that holds the scratch homes of pending verifications. |
| `mesh_write.verify_error` | `error` |  |  | Log result of a verification that could not run Node. |
| `mesh_write.verify_flag` | `--shadow-verify` |  |  | The word after `mesh` that makes the engine run as the background verifier of an answered heartbeat (never a devswarm.js verb). |
| `mesh_write.verify_link_dirs` | `store` |  |  | Directories of the DevSwarm root linked, not copied, into the scratch home (read only for a heartbeat). |
| `mesh_write.verify_log` | `mesh-verify.jsonl` |  |  | File in the state directory that receives one JSON line per background verification (`verb`, `result` match or mismatch, `ms`; on a mismatch both outputs, capped). |
| `mesh_write.verify_match` | `match` |  |  | Log result of a verification whose Node output and written files equal the engine's. |
| `mesh_write.verify_mismatch` | `mismatch` |  |  | Log result of a verification that found a difference. |
| `mesh_write.verify_names_heartbeat` | `sameHeartbeat, sameVerdict, sameCache` |  |  | The names under which a heartbeat verification mismatch reports whether the heartbeat record, the liveness verdict and the app-state cache are equal. |
| `mesh_write.verify_names_tick` | `sameHeartbeat, sameMarker, sameCronFound` |  |  | The names under which a tick verification mismatch reports whether the heartbeat record, the wake-tick marker and the cron-found-mail file are equal. |
| `mesh_write.verify_node_snippet` | `const c=require(process.argv[1]);const r=c.run(process.argv.slice(3),{now:Num...` |  |  | The Node program of the verifier: runs the real devswarm.js `run()` with the engine's clock, prints the result object the CLI would print. Arguments: the CLI path, the clock, then the verb's argv. |
| `mesh_write.verify_nonce_col` | `11` |  |  | Index of the instance_nonce column in the row query of the background check (left out of the comparison). |
| `mesh_write.verify_row_name` | `row` |  |  | The name the background check gives the appended mesh row when it differs. |
| `mesh_write.verify_tick_copy_dirs` | `11 items` |  |  | Directories of the DevSwarm root copied into the scratch home before the engine writes for a tick (what Node reads or writes for it). |
| `mesh_write.verify_tick_copy_files` | `cron-found-mail.jsonl` |  |  | Files of the DevSwarm root copied into the scratch home before the engine writes for a tick. |
| `mesh_write.verify_tick_node_snippet` | `const c=require(process.argv[1]);const r=c.run(process.argv.slice(3),{now:Num...` |  |  | The Node program of the tick verifier: runs the real devswarm.js `run()` with the engine's clock and prints the line `inbox tick --quiet` would print. Arguments: the CLI path, the clock, then the verb's argv. |
| `mesh_write.verify_window_after` | `100` |  |  | Bytes from the first difference on that the background check logs from a differing file. |
| `mesh_write.verify_window_before` | `60` |  |  | Bytes before the first difference that the background check logs from a differing file. |
| `mesh_write.wake_lock_prefix` | `wake-watch-` |  |  | File-name prefix of the wake-watch lock of a workspace in the locks directory (devswarm-wake-watch.js lockPathFor). |
| `mesh_write.wake_lock_stale_ms` | `120000` |  |  | A wake-watch lock older than this is not a live watcher (devswarm-wake-watch.js WATCH_LOCK_STALE_MS). |
| `mesh_write.wake_lock_suffix` | `.lock` |  |  | File-name suffix of the wake-watch lock. |
| `mesh_write.wal_lastresort_prefix` | `anti-hall-wal-lastresort-` |  |  | Prefix of the last-resort delivery batches written to the temp directory; their presence sends a tick to Node. |
| `mesh_write.wal_suffix` | `.ndjson` |  |  | File-name suffix of a delivery log. |
| `mesh_write.write_seq_column` | `write_seq` |  |  | The registry's per-row write counter column (Node's ensureRegistryWriteSeqColumn). |
| `mesh_write.xdg_default` | `.config` |  |  | Its default under the home directory. |

### sibling_sweep.toml / sibling_sweep

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `sibling_sweep.agent_tools` | `Agent, Task` |  |  | Tool names that start a subagent; one whose subagent type is a search agent counts as a search. |
| `sibling_sweep.b_text` | `text` |  |  | Content block type of a text block. |
| `sibling_sweep.b_tool_use` | `tool_use` |  |  | Content block type of a tool call. |
| `sibling_sweep.bash_search_re` | `(?:^\|[\s;&\|(`])(?:rg\|grep\|egrep\|fgrep\|ugrep\|ag\|ack)(?:\s\|$)\|\bgit\s+(?:-C\s+\...` |  |  | Regex source of a shell command that searches the codebase: rg, grep and relatives as a command word, git grep, git log -S/-G/--grep. |
| `sibling_sweep.bash_tool` | `Bash` |  |  | The tool name of a shell call, whose command is read for a search program. |
| `sibling_sweep.cause_cues` | `8 items` |  |  | Regex sources, any of which states the cause of a bug in the assertive form (root-cause statements, 'caused by', 'the bug was', 'found the bug', a Cause label). Matched sentence by sentence after markdown emphasis, fenced code and quoted lines are removed. |
| `sibling_sweep.child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | The environment variable the judge and Jev children carry; a hook that runs inside one does nothing (no recursion, no reminders to a classifier). |
| `sibling_sweep.child_value` | `1` |  |  | The value of the child variable that means this process is a judge or Jev child. |
| `sibling_sweep.code_span` | ``` |  |  | The character that opens and closes an inline code span; the first span of the cause sentence names the pattern in the reminder. |
| `sibling_sweep.edit_tools` | `Edit, Write, MultiEdit, NotebookEdit` |  |  | Tool names that change a file; one in the turn makes it a fix context. |
| `sibling_sweep.events` | `Stop, SubagentStop` |  |  | The events this check answers; the payload's hook_event_name must be one of them. |
| `sibling_sweep.f_active` | `stop_hook_active` |  |  | Payload field that is true when the Stop is already a continuation of a Stop block; the check then only resolves follow-through and never reminds again. |
| `sibling_sweep.f_agent` | `agent_id` |  |  | Payload field holding the subagent id (SubagentStop, and Stop inside a subagent). |
| `sibling_sweep.f_agent_transcript` | `agent_transcript_path` |  |  | Payload field holding the subagent's own transcript path; it wins over the session transcript when present. |
| `sibling_sweep.f_command` | `command` |  |  | Tool input field holding a shell command. |
| `sibling_sweep.f_event` | `hook_event_name` |  |  | Payload field holding the event name. |
| `sibling_sweep.f_reply` | `last_assistant_message` |  |  | Payload field holding the reply being stopped. |
| `sibling_sweep.f_session` | `session_id` |  |  | Payload field holding the session id. |
| `sibling_sweep.f_subagent_type` | `subagent_type` |  |  | Tool input field holding a subagent's type. |
| `sibling_sweep.f_tool_input` | `input` |  |  | Content block field holding the tool input. |
| `sibling_sweep.f_tool_name` | `name` |  |  | Content block field holding the tool name. |
| `sibling_sweep.f_transcript` | `transcript_path` |  |  | Payload field holding the session transcript path. |
| `sibling_sweep.fence_re` | ````[\s\S]*?```` |  |  | Regex source of a fenced code block, which is removed before matching (code and logs are not statements). |
| `sibling_sweep.fix_context_re` | `\b(?:fix(?:ed\|es\|ing)?\|patch(?:ed\|es)?\|resolv(?:ed\|es\|ing)\|repair(?:ed\|s)?\|co...` |  |  | Regex source of fix words: the reply is about a bug being fixed (an edit tool call in the turn also makes it a fix context). |
| `sibling_sweep.follow_window` | `12` |  | tool calls | Follow-through: the search counts as following the reminder when a search tool call is among the first this many tool calls after the reminded reply. |
| `sibling_sweep.guard_name` | `sibling-sweep` |  |  | The guard id this check answers to in skip.json and in messages. |
| `sibling_sweep.hard_breaks` | `\n;` |  |  | Characters that always end a sentence (a newline and a semicolon). |
| `sibling_sweep.hash_chars` | `200` |  | chars | How many characters of the normalised cause sentence feed its identity hash (the once-per-cause key). |
| `sibling_sweep.hash_short` | `10` |  |  | How many hex characters of a cause hash are written to the telemetry log. |
| `sibling_sweep.hedge_any_re` | `\b(?:probably\|possibly\|presumably\|perhaps\|maybe\|apparently\|supposedly\|seems?\|...` |  |  | Regex source of words that make the whole sentence a guess, a plan or a question rather than a finding: it is then no cause statement. |
| `sibling_sweep.hedge_before_re` | `\b(?:if\|unless\|suppose\|assuming\|whether\|may\|might\|could\|would\|should\|can\|cann...` |  |  | Regex source tested on the few characters just before the cue: a negation, condition, intent or modal there voids the cue ('to find the root cause', 'if it was caused by', 'may be caused by', 'not caused by'). |
| `sibling_sweep.injected_re` | `^\s*<(?:task-notification\|system-reminder\|local-command\|command-name\|command-...` |  |  | Regex source of the text an injected user block starts with (notifications, reminders, command echoes), which is not a human prompt and so does not start a turn. |
| `sibling_sweep.line_max_bytes` | `524288` |  | bytes | A transcript line longer than this is skipped unparsed (almost always one huge tool result); it bounds the memory of the one line being read. |
| `sibling_sweep.log` | `logs/sibling-sweep.ndjson` |  |  | The telemetry log, relative to the anti-hall home directory: one JSON line per detected cause statement (reminded, swept, capped, duplicate, no fix context) and per resolved follow-through; holds no message text, only hashes and counts. |
| `sibling_sweep.log_max_bytes` | `1048576` |  | bytes | The telemetry log is emptied before an append once it is larger than this (the same bound as the other guard logs). |
| `sibling_sweep.max_causes` | `8` |  |  | The most distinct causes remembered for one turn. |
| `sibling_sweep.max_events` | `4000` |  |  | The most events (assistant texts and tool calls) kept for one turn; older ones are dropped, the newest kept. |
| `sibling_sweep.max_per_scope` | `6` |  |  | The most reminders for one session scope (the session, or one subagent of it); past it the check only counts. |
| `sibling_sweep.meta_re` | `\broot[- ]cause[- ](?:claim\|attribution\|statement\|skill\|nudge\|guard\|hook\|prot...` |  |  | Regex source of mentions of the root-cause machinery itself (the skill, the nudge, a guard, a protocol): a sentence that holds one is about the tooling, not a bug cause. |
| `sibling_sweep.min_span_chars` | `3` |  | chars | The shortest inline code span that names the pattern in the reminder (a one or two character span is punctuation, not a name). |
| `sibling_sweep.msg_allowed` | `one honest line is enough when there is none: name the search and say it foun...` |  |  | What stays allowed, in the reminder. |
| `sibling_sweep.msg_bad_setting` | `sibling-sweep: ignoring an invalid value ({setting}), using the shipped one` |  |  | Daemon log line, written once per process, when a settings file holds an invalid value for a sibling_sweep setting (a pattern that does not compile, a rejected config file); the shipped value is used instead. Placeholder: {setting}. |
| `sibling_sweep.msg_instead` | `search the codebase for the same pattern (rg, grep or Glob), fix or list ever...` |  |  | What to do, in the reminder. |
| `sibling_sweep.msg_log_failed` | `sibling-sweep: cannot write {what}: {error}` |  |  | Daemon log line, written once per process, when the telemetry log or the state file cannot be written. Placeholders: {what}, {error}. |
| `sibling_sweep.msg_override` | `guards.siblingSweep=off in /anti-hall:settings` |  |  | How to turn the reminder off, in the reminder. |
| `sibling_sweep.msg_pattern` | ` ({pattern})` |  |  | The text that names the pattern in the reminder. Placeholder: {pattern}. |
| `sibling_sweep.msg_what` | `this reply states the cause of a bug{pattern} and the turn shows no search fo...` |  |  | What happened, in the reminder. Placeholder: {pattern} (the pattern named from the cause statement, or empty). |
| `sibling_sweep.msg_why` | `a bug cause is rarely unique: fixing one site and calling it done leaves its ...` |  |  | Why it matters, in the reminder. |
| `sibling_sweep.question_terminator` | `?` |  |  | The terminator that makes a sentence a question; a question is never a cause statement. |
| `sibling_sweep.quote_line_re` | `(?m)^[ \t]*>.*$` |  |  | Regex source of a quoted line (a Markdown quote), removed before matching. |
| `sibling_sweep.search_agent_types` | `Explore, explore, oh-my-claudecode:explore` |  |  | Subagent types that are search agents. |
| `sibling_sweep.search_tool_re` | `(?:^\|__)(?:ast_grep_search\|lsp_find_references\|rip_grep_packages\|grep\|find_re...` |  |  | Regex source of tool names that are searches by their name (MCP structural search, find-references, ripgrep servers). |
| `sibling_sweep.search_tools` | `Grep, Glob` |  |  | Tool names whose use is a codebase search (matched exactly). |
| `sibling_sweep.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.siblingSweep, default on). A Jev mode for the judgement parts (is this a cause statement, did the search cover the pattern) is a later addition and is not wired. |
| `sibling_sweep.snippet_chars` | `100` |  | chars | The longest excerpt of the cause sentence shown in the reminder when the pattern is named from the message. |
| `sibling_sweep.state_prefix` | `sibling-sweep` |  |  | Prefix of the per-scope state file name under the state directory (the sanitised session id, the agent id and the JSON extension follow). |
| `sibling_sweep.state_session_max` | `80` |  | chars | The most characters of the session id and of the agent id in the state file name. |
| `sibling_sweep.strip_chars` | `*` |  |  | Characters removed from the text before matching (markdown emphasis markers), so a bold 'Root cause:' label reads as plain text. |
| `sibling_sweep.subagent_event` | `SubagentStop` |  |  | The event name that is a subagent's own stop (the telemetry scope label differs and the agent's own transcript is read). |
| `sibling_sweep.summary` | `Stop and SubagentStop reminder: when the reply states the cause of a bug in a...` |  |  | One-line description of the sibling-sweep check in the generated reference. |
| `sibling_sweep.sweep_statement_re` | `\b(?:searched\\|grepp?ed\\|scanned\\|swept\\|checked\\|looked\\|audited\\|rg\\|ran)\b...` |  |  | Regex sources, any of which is an explicit statement that other occurrences were searched for ('searched for other occurrences', 'no other occurrences', 'all call sites fixed', 'sibling sweep'). |
| `sibling_sweep.t_assistant` | `assistant` |  |  | Transcript entry type of an assistant entry. |
| `sibling_sweep.t_user` | `user` |  |  | Transcript entry type of a user entry. |
| `sibling_sweep.terminators` | `.!?` |  |  | Characters that end a sentence when followed by white space or the end of the text (a newline and a semicolon always end one). |
| `sibling_sweep.text_max_bytes` | `65536` |  | bytes | The most of one assistant text that is scanned for a cause statement. |
| `sibling_sweep.what_log` | `the telemetry log` |  |  | The {what} of `msg_log_failed` when the telemetry log cannot be written. |
| `sibling_sweep.what_state` | `the state file` |  |  | The {what} of `msg_log_failed` when the per-scope state file cannot be read or written. |
| `sibling_sweep.what_transcript` | `the transcript read` |  |  | The {what} of `msg_log_failed` when the transcript cannot be read. |
| `sibling_sweep.window_bytes` | `1048576` |  | bytes | The most of the transcript's end that is read to find the turn (one streaming pass, never the whole file). |
| `sibling_sweep.window_chars` | `48` |  | chars | How many characters before a cue are searched for a hedge or negation that voids the cue. |

### limits.toml / agent_scan

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `agent_scan.reader_buf_bytes` | `1048576` |  | bytes | Capacity of the buffered reader over the tail of a transcript the agent scan reads. |

### limits.toml / codex_handover

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `codex_handover.nudge_shown_files` | `3` |  |  | How many edited file names the Codex handover nudge lists before it adds the more-marker. |

### limits.toml / coordinator_work

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `coordinator_work.block_default` | `7` |  |  | Default of the coordinator work block threshold when the setting is absent or unusable. |
| `coordinator_work.cap_default` | `50` |  |  | Default of the coordinator work tracked-call cap when the setting is absent or unusable. |
| `coordinator_work.nudge_default` | `4` |  |  | Default of the coordinator work nudge threshold when the setting is absent or unusable. |
| `coordinator_work.window_default` | `10` |  |  | Default of the coordinator work window setting, in minutes, when the setting is absent or unusable. |

### limits.toml / dispatch

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `dispatch.stop_id_max_chars` | `64` |  |  | Longest session or agent id the stop-loop guard keeps in a state file name; the rest is cut. |

### limits.toml / git

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `git.handover_adds_max` | `50` |  |  | Most `git add` commands the git check remembers in one command line when it looks for a staged handover file. |
| `git.max_recursion` | `1500` |  |  | Deepest nesting of wrapper commands (`xargs xargs ...`) the git check follows before it defers to Node, whose own stack overflows at about this depth. |
| `git.path_arg_max_chars` | `4096` |  |  | Longest directory argument (in characters) the git check tracks through a `cd`; a longer one is left to Node. |
| `git.self_credit_coauthor_key` | `co-authored-by` |  |  | The trailer key (lowercase) that credits a co-author; an AI tool named after it is a self-credit. |
| `git.self_credit_generated_prefix` | `generated with ` |  |  | The footer prefix (lowercase, with its trailing space) after which an AI tool name is a self-credit. |
| `git.self_credit_trailer_keys` | `co-authored-by, generated-with, generated with` |  |  | The trailer keys (lowercase) that a `-c trailer.<key>.key=` remap must not write a credit under. |
| `git.shown_hits` | `3` |  |  | How many commit hashes the handover message names before it adds the more-marker. |

### limits.toml / gitcache

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `gitcache.content_cap_bytes` | `4096` |  | bytes | Bytes of a signed file read when the cache fingerprints a repository (a HEAD or a loose ref is a few dozen bytes). |

### limits.toml / guardkit

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `guardkit.settings_seen_max` | `256` |  |  | Most settings files the guard kit remembers the validity of before it starts over. |
| `guardkit.tail_reader_buf_bytes` | `65536` |  | bytes | Capacity of the buffered reader the shared transcript tail reader (`guardkit::tail::tail_lines`) streams lines through. |

### limits.toml / io

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `io.chunk_bytes` | `65536` |  | bytes | Size of the buffer used to copy a hook payload between pipes and files: spooling stdin, scanning it for the tool name, feeding a spooled file to a hook. |
| `io.small_chunk_bytes` | `8192` |  | bytes | Size of the buffer used to read a request from the daemon socket and a hook child's output. |

### limits.toml / jev

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `jev.what_create_dir` | `create the directory of` |  |  | What the decision log was doing when creating its directory failed. |
| `jev.what_read_requests` | `read the requests from stdin` |  |  | What the Jev `ask` command was doing when reading its stdin failed. |
| `jev.what_read_texts` | `read the texts from stdin` |  |  | What the Jev `scrub` command was doing when reading its stdin failed. |

### limits.toml / model_routing

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `model_routing.fail_closed_marker` | `model-routing fail-closed` |  |  | The reason carried by the last-resort block when even the fail-closed message could not be built. |

### limits.toml / task_lifecycle_log

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `task_lifecycle_log.index_file` | `INDEX.md` |  |  | Name of the per-kind session index file the lifecycle log maintains under the state directory. |

### limits.toml / taskstate

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `taskstate.no_tasks_marker` | `No tasks found` |  |  | The text in a task tool result that says the list is empty. |

### script.toml / script

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `script.call_memory_bytes` | `16777216` |  | bytes | Heap a single script call may allocate above the runtime's size after its scripts were loaded; past it the call fails and defers. |
| `script.enabled` | `1` | `AH_ENGINE_SCRIPT` |  | 1: a check whose script exists runs the script instead of its compiled port; 0: the compiled port always runs (the parity baseline). |
| `script.engine_only_checks` | `sibling-sweep, handover-hygiene` |  |  | Checks with NO Node twin (their fallback command is a no-op). When one of these scripts cannot answer, the safe outcome is the engine's own: BLOCK on a guard event (dispatch.guard_events), ALLOW quietly on any other event. Every other check defers to its Node hook on a script failure, so a broken script never changes a decision. |
| `script.entry` | `decide` |  |  | Global function a check script defines; it is called with the hook payload and returns the verdict. |
| `script.exec_max_calls` | `64` |  |  | Most `ah.exec` runs one script call may start; past it the call answers null. |
| `script.exec_output_max_bytes` | `4194304` |  | bytes | Largest stdout (and, separately, stderr) `ah.exec` hands back; the rest is cut and `truncated` is set. |
| `script.exec_poll_ms` | `2` |  | ms | How often the bounded runner checks whether an `ah.exec` child has finished. |
| `script.exec_programs` | `git` |  |  | Program names `ah.exec` may run (bare names, resolved through the request's PATH). Anything else answers null. |
| `script.exec_timeout_max_ms` | `5000` |  | ms | Longest wall-clock time one `ah.exec` run may take whatever the script asks for; the run's process group is killed at the limit. |
| `script.ext` | `.js` |  |  | File extension of a check script and of a lib file. |
| `script.includes` | `1 entries` |  |  | Scripts a check script builds on: check name to the names of other scripts in the logic directory, loaded as libraries (after the shared helpers, before the check's own script, which then defines the entry). A listed script that does not exist makes the check's script unavailable. |
| `script.lib_dir` | `lib` |  |  | Sub-directory (of both the shipped and the override directory) whose `*.js` files are evaluated, in file-name order, before a check script. |
| `script.logic_dir` | `engine/logic` |  |  | Directory of the shipped check scripts, relative to the plugin root. |
| `script.msg_bad_verdict` | `unexpected verdict {value}` |  |  | Logged reason (then the call defers) when a script returns a value that is not a verdict. |
| `script.msg_env_incomplete` | `request environment incomplete` |  |  | Reason logged (then the failure policy applies) when the request's environment is incomplete, so no check can be evaluated. |
| `script.msg_fail_closed` | `anti-hall {check}: BLOCKED. Its check script failed ({why}) and this guard ha...` |  |  | Block reason of an engine-only check on a guard event whose script could not answer. Placeholders: {check}, {why}. |
| `script.msg_invalid_pattern` | `invalid pattern {src}` |  |  | Error a script sees when it hands `ah.re.*` a pattern that does not compile. |
| `script.msg_no_request` | `no request state` |  |  | Error a host function raises when it is called outside a check call (no request state). |
| `script.msg_no_script` | `no script file` |  |  | Reason logged (then the failure policy applies) when a check whose logic is a script has no script file. |
| `script.msg_not_number` | `{key} is not a number` |  |  | Error a script sees when it asks `ah.cfgNum` for a key whose value is not a number. |
| `script.msg_settings_unreadable` | `settings file readable only by JavaScript` |  |  | Reason logged (then the failure policy applies) when the settings file holds something only JavaScript can parse. |
| `script.msg_unknown_key` | `unknown defaults key {key}` |  |  | Error a script sees when it asks `ah.cfg` for a key that is not shipped. |
| `script.msg_unknown_op` | `unknown file operation {op}` |  |  | Error a script sees when it asks a file operation the host does not have. Placeholder: {op}. |
| `script.msg_write_refused` | `write refused: {why}` |  |  | Error a script sees when its write was refused. Placeholder: {why}. |
| `script.override_dir` | `.anti-hall/logic` |  |  | Owner override directory, relative to the home directory: a script (or lib file) of the same name there takes precedence over the shipped one. |
| `script.p95_budget_by_check` | `4 entries` |  |  | Per-check own-p95 allowance (us) for scripted checks whose latency includes waiting on a child process or a disk sync, which the compiled port paid as well. Measured 2026-10-08 on the golden corpora (release, no LTO, loaded machine), compiled port then script: git p50 92 then 432 us, p95 13,902 then 22,324 us (the p95 is the `git` child processes of alias and handover lookups plus the longest commands' tokenizing); sibling-sweep p50 12,154 then 2,453 us, p95 13,261 then 3,903 us (the compiled state write fsynced). A check not listed here is held to script.p95_budget_us. |
| `script.p95_budget_us` | `1000` |  | us | Latency a scripted check may ADD over its compiled port at the 95th percentile, per call (the D88 go/no-go gate measures against it; the primitives a script calls, such as a transcript read, cost the same either way). |
| `script.read_max_bytes` | `4194304` |  | bytes | Upper bound of one `ah.fs.readText` read, whatever the script asks for. |
| `script.readdir_max` | `10000` |  |  | Most entries `ah.fs.readdir` returns; a directory with more entries answers null (a partial listing is never returned as a whole). |
| `script.regex_cache_max` | `256` |  |  | Compiled regular expressions kept per worker thread for `ah.re.*`; the cache is cleared when it is full. |
| `script.stack_bytes` | `262144` |  | bytes | Largest interpreter stack one script call may use. |
| `script.sweep_max_remove` | `200` |  |  | Most files one `ah.state.sweep` call may delete, whatever the script asks for. |
| `script.tail_buf_bytes` | `65536` |  | bytes | Size of the buffer `ah.transcript.tailLines` reads a file through. |
| `script.tail_max_bytes` | `16777216` |  | bytes | Largest window `ah.transcript.tailLines` reads from the end of a file, whatever the script asks for. |
| `script.time_limit_by_check` | `2 entries` |  |  | Per-check wall-clock limit of one script call (ms), replacing script.time_limit_ms. A key is the check name, or `<check>:<event>` for one event, which wins. handover-hygiene reads and writes a whole directory tree, so its command-line and scheduled-job runs (event Cli) get seconds; its SessionStart advisory only lists and stats files. |
| `script.time_limit_ms` | `50` | `AH_ENGINE_SCRIPT_TIME_MS` | ms | Wall-clock limit of one script call; past it the interpreter is interrupted and the call defers to Node (never a silent allow). |
| `script.write_max_bytes` | `1048576` |  | bytes | Largest text one `ah.state.writeAtomic` call may write; a larger text is refused. |
| `script.write_path_max` | `240` |  |  | Longest relative path one `ah.state.writeAtomic` call may name. |
| `script.write_root` | `.anti-hall` |  |  | The one directory under the home directory that a script may write to through `ah.state.writeAtomic` (a path must start with it; nothing outside it, no link below it). |
| `script.write_sync` | `0` |  |  | 1: a scripted write fsyncs the file before the atomic rename (survives a power cut, costs several milliseconds per write); 0: it does not (a reader still never sees a half-written file, and the state a script keeps is advisory and rebuilt at the next run). |
| `script.write_why_home` | `no absolute home directory` |  |  | Refusal reason of a scripted write when the request has no absolute home directory. |
| `script.write_why_link` | `symbolic link below the write root` |  |  | Refusal reason of a scripted write that would pass through a symbolic link below the write root. |
| `script.write_why_path` | `path outside the allowed shape` |  |  | Refusal reason of a scripted write whose path is absolute, outside the write root, too long, or has an empty, `.` or `..` part. |
| `script.write_why_size` | `text over the size cap` |  |  | Refusal reason of a scripted write whose text is over script.write_max_bytes. |

### mcp_reaper.toml / mcp_reaper

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `mcp_reaper.act_reasons` | `prompt_input_exit, other` |  |  | The SessionEnd reasons on which the sweep runs at all; any other reason (clear, resume, logout) does nothing and runs no process listing. |
| `mcp_reaper.action_kill` | `kill` |  |  | The audit log action of the forced signal. |
| `mcp_reaper.action_skip` | `skip` |  |  | The audit log action of a candidate that was skipped. |
| `mcp_reaper.action_term` | `term` |  |  | The audit log action of the polite signal. |
| `mcp_reaper.cgroup_marker` | `.service` |  |  | The text in a control-group file that marks a systemd service. |
| `mcp_reaper.cgroup_path` | `/proc/{pid}/cgroup` |  |  | The control-group file of a process; `{pid}` is the process id. |
| `mcp_reaper.etimes_command` | `ps, -o, pid=,etimes=, -p` |  |  | The age probe that reports elapsed seconds (Linux); the pid list is appended as the last argument. |
| `mcp_reaper.etimes_line_re` | `^\s*(\d+)\s+(\d+)\s*$` |  |  | JavaScript regex source (case-sensitive) of one elapsed-seconds line: pid, seconds. |
| `mcp_reaper.event_scan` | `scan` |  |  | The audit log event name of a completed scan. |
| `mcp_reaper.event_skip` | `skip` |  |  | The audit log event name of a sweep that did not run. |
| `mcp_reaper.exclude_setting` | `4 entries` |  |  | Where the user's exclusion pattern is read from (guards.reaperExclude, a JavaScript regular expression, empty = none): a process it matches is never reaped. |
| `mcp_reaper.grace_ms` | `500` |  | ms | How long the sweep waits between the polite signal and the re-check that decides who gets the forced one. |
| `mcp_reaper.init_names` | `launchd, systemd, init` |  |  | The program names PID 1 must carry for the sweep to run at all: in a container PID 1 is the entrypoint and every child of it is normal, not a leaked orphan. |
| `mcp_reaper.launchctl_command` | `launchctl, list` |  |  | The command that lists the processes the macOS service manager owns. |
| `mcp_reaper.launchctl_header_re` | `^PID\s` |  |  | JavaScript regex source (case-insensitive) of the header line of the service-manager listing. |
| `mcp_reaper.log_dir` | `logs` |  |  | The audit log directory under the base directory. |
| `mcp_reaper.log_file` | `session-end-reaper.log` |  |  | The audit log file name. |
| `mcp_reaper.log_max_bytes` | `5242880` |  | bytes | The audit log stops growing past this size. |
| `mcp_reaper.lstart_command` | `ps, -o, pid=,lstart=, -p` |  |  | The age probe that reports the start time (macOS and BSD, which have no elapsed-seconds column); the pid list is appended as the last argument. |
| `mcp_reaper.lstart_form_re` | `^(Mon\|Tue\|Wed\|Thu\|Fri\|Sat\|Sun) (Jan\|Feb\|Mar\|Apr\|May\|Jun\|Jul\|Aug\|Sep\|Oct\|Nov\|D...` |  |  | JavaScript regex source (case-sensitive) of the one start-time text the engine reads itself, the form `ps -o lstart=` prints: weekday, month, day of month, time, year. Any other text is handed to Node, whose date parser the engine does not reproduce. |
| `mcp_reaper.lstart_line_re` | `^\s*(\d+)\s+(.+?)\s*$` |  |  | JavaScript regex source (case-sensitive) of one start-time line: pid, start time. |
| `mcp_reaper.match_setting` | `4 entries` |  |  | Where the user's extra MCP process pattern is read from (guards.reaperMatch, a JavaScript regular expression, empty = none). |
| `mcp_reaper.max_default` | `16` |  |  | The cap on processes reaped per sweep. |
| `mcp_reaper.max_env` | `ANTI_HALL_SESSION_END_REAPER_MAX` |  |  | The environment variable that sets the cap on processes reaped per sweep (read like the age floor). |
| `mcp_reaper.max_exact_id` | `9007199254740992` |  |  | Process ids at or above this are handed to Node: the engine holds an id exactly as JavaScript prints it only below 2^53. |
| `mcp_reaper.max_hour` | `23` |  |  | The largest hour of a start time the engine reads itself (the form allows 24 to 29, which JavaScript carries into the next day). |
| `mcp_reaper.mcp_self_re` | `mcp-reaper` |  |  | JavaScript regex source (case-insensitive) of a command line that is never an MCP server: the reaper tooling itself. |
| `mcp_reaper.min_age_default_s` | `60` |  | s | The age floor in seconds: a process younger than this is never reaped. |
| `mcp_reaper.min_age_env` | `ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S` |  |  | The environment variable that sets the age floor in seconds (a number, read the way JavaScript's Number reads it; anything not a finite number of at least zero falls back to the default). |
| `mcp_reaper.min_year` | `1970` |  |  | The earliest year of a start time the engine reads itself. |
| `mcp_reaper.modelctx_re` | `@?modelcontextprotocol\b` |  |  | JavaScript regex source (case-insensitive) of the @modelcontextprotocol package scope, always a match. |
| `mcp_reaper.months` | `12 items` |  |  | The month abbreviations of the start-time form, January first. |
| `mcp_reaper.node_module` | `companion/mcp-reaper.js` |  |  | The Node companion module the hook reuses for its signature test, relative to the plugin root. The Node hook does nothing when it cannot load it, so the engine acts only where it is present. |
| `mcp_reaper.orphan_ppid` | `1` |  |  | The parent pid that marks an orphan: the kernel reparents a process whose parent died to PID 1. |
| `mcp_reaper.platform_launchd` | `macos` |  |  | The Rust operating-system name on which the service-manager listing is consulted (Node's darwin). |
| `mcp_reaper.platform_systemd` | `linux` |  |  | The Rust operating-system name on which the control-group file is consulted (Node's linux). |
| `mcp_reaper.poll_ms` | `2` |  | ms | How often a running command is checked for completion. |
| `mcp_reaper.probe_max_bytes` | `1048576` |  | bytes | The largest age-probe or service-manager output the sweep reads; a bigger one is handed to Node. |
| `mcp_reaper.probe_timeout_ms` | `2000` |  | ms | How long an age probe or the service-manager listing may take (an age probe that times out leaves the age unknown, so the process is not reaped; a service-manager listing that times out skips every candidate). |
| `mcp_reaper.ps_command` | `ps, -axo, pid=,ppid=,command=` |  |  | The process listing command and its arguments: pid, parent pid and command line of every process. |
| `mcp_reaper.ps_line_re` | `^\s*(\d+)\s+(\d+)\s+(.*)$` |  |  | JavaScript regex source (case-sensitive) of one process listing line: pid, parent pid, command line. |
| `mcp_reaper.ps_max_bytes` | `33554432` |  | bytes | The largest process listing accepted; a bigger one is treated as a failed listing and the sweep does nothing. |
| `mcp_reaper.ps_timeout_ms` | `3000` |  | ms | How long the process listing may take before the sweep gives up and does nothing. |
| `mcp_reaper.read_ms` | `1000` |  | ms | The least time to wait for a finished command's output after it exits; it may also use what is left of the command's timeout. Output that never arrives fails the command (never an empty listing). |
| `mcp_reaper.reason_fields` | `reason, end_reason` |  |  | The payload fields that carry the reason, in order: the measured wire field first, the documented one as a fallback. |
| `mcp_reaper.reason_launchd` | `launchd-managed` |  |  | The audit log reason for a candidate the macOS service manager owns. |
| `mcp_reaper.reason_launchd_unverifiable` | `launchd-unverifiable` |  |  | The audit log reason for every candidate when the service-manager listing failed. |
| `mcp_reaper.reason_pid1` | `pid1-not-init` |  |  | The audit log reason when PID 1 is not an init process. |
| `mcp_reaper.reason_systemd` | `systemd-service` |  |  | The audit log reason for a candidate that is a systemd service. |
| `mcp_reaper.runner_exclude_res` | `7 items` |  |  | JavaScript regex sources (case-insensitive) of test runners and dev servers that are never reaped, even when a file name merely looks like an MCP server. |
| `mcp_reaper.runtime_re` | `^(node\|nodejs\|npx\|npm\|pnpm\|yarn\|deno\|bun\|python\|python3\|uvx\|uv)$` |  |  | JavaScript regex source (case-sensitive) of the program names (argv0 basename) that legitimately launch MCP servers. |
| `mcp_reaper.scoped_re` | `(^\|\s)@[a-z0-9][a-z0-9._-]*/mcp([\s/]\|$)` |  |  | JavaScript regex source (case-insensitive) of an `@scope/mcp` package token (right bound consumed, as for the suffix pattern). |
| `mcp_reaper.setting` | `6 entries` |  |  | Where the reaper's on/off switch is read from (maintenance.sessionEndReaper, default on; the deprecated environment alias is read too). |
| `mcp_reaper.start_program` | `mcp` |  |  | The program name that may itself be the `mcp start` command. |
| `mcp_reaper.start_re` | `(^\|\s)mcp\s+start(\s\|$)` |  |  | JavaScript regex source (case-insensitive) of `mcp start` as a discrete command token. |
| `mcp_reaper.suffix_argv0_re` | `-mcp$` |  |  | JavaScript regex source (case-insensitive) of a program name that is itself a `<name>-mcp` binary. |
| `mcp_reaper.suffix_re` | `(^\|[\s/])([a-z0-9][a-z0-9._-]*-mcp)([\s/]\|$)` |  |  | JavaScript regex source (case-insensitive) of a `<name>-mcp` package token, bounded on the left by the start, white space or a slash and on the right by white space, a slash or the end (the right bound is consumed here; see the header). |
| `mcp_reaper.summary` | `SessionEnd sweep of orphaned MCP server processes (parent PID 1, MCP command ...` |  |  | One-line description of the session-end-mcp-reaper check in the generated reference. |
| `mcp_reaper.token_argv0_re` | `^(mcp[-_]server\|server-sequential-thinking)` |  |  | JavaScript regex source (case-insensitive) of a program name that is itself such a token. |
| `mcp_reaper.token_re` | `(^\|[\s/])(mcp[-_]server\|server-sequential-thinking)` |  |  | JavaScript regex source (case-insensitive) of a boundary-anchored mcp-server or server-sequential-thinking token. |
| `mcp_reaper.tz_env` | `TZ` |  |  | The environment variable that moves the time zone Node would read a start time in; when a request sets it the start time is handed to Node. |

### task_tracker.toml / task_tracker

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `task_tracker.blocked_tail` | ` (+{n} blocked: {why})` |  |  | The tail naming tasks that wait on someone else; `{n}` is how many and `{why}` who. |
| `task_tracker.codex_from` | `as a task (TaskCreate) ` |  |  | The words of the directive that name the Claude-only task tool; the Codex text swaps the first occurrence. |
| `task_tracker.codex_to` | `as an item in your task/plan list ` |  |  | What the Codex text says in their place. |
| `task_tracker.control_re` | `[\x00-\x1F\x7F-\x9F]` |  |  | JavaScript regex source (case-sensitive) of the control characters a quoted subject replaces with a space. |
| `task_tracker.dd_setting` | `6 entries` |  |  | Where the per-turn dispatch demand switch is read from (guards.dispatchDemand, default on): while it is on, a session with a task the demand line would name is left to Node. |
| `task_tracker.dedupe_key` | `task-tracker` |  |  | The emit-dedupe key of the directive and the combined text. |
| `task_tracker.dedupe_short_key` | `task-tracker-short` |  |  | The emit-dedupe key of the short reminder, kept apart so the keepalive can ration it. |
| `task_tracker.done_statuses` | `completed, done, cancelled, canceled` |  |  | Statuses (lowercase) that mean a task no longer blocks the ones waiting on it. |
| `task_tracker.ellipsis` | `…` |  |  | What ends a subject that was cut. |
| `task_tracker.event` | `UserPromptSubmit` |  |  | The hook event name in the output. |
| `task_tracker.full_level` | `full` |  |  | The protocol level at which the directive keeps the non-blocking clause (any other level drops it). |
| `task_tracker.future_tolerance_ms` | `300000` |  | ms | How far ahead of now a stored timestamp may be (clock skew) before it counts as corrupt and the window is treated as expired. |
| `task_tracker.growth_bytes` | `245760` |  | bytes | How much the transcript may grow after a full directive before the next prompt injects it again (about 60 thousand tokens, where adherence to an instruction starts to decay). |
| `task_tracker.guard_name` | `task-tracker` |  |  | The guard name in the message header and in the skip file. |
| `task_tracker.in_progress_re` | `in[-_]?progress` |  |  | JavaScript regex source (case-insensitive) of a status that means in progress. |
| `task_tracker.instead_head` | `give each task a priority (metadata.priority: P0/P1/P2) and keep the list sor...` |  |  | The start of the full directive's 'Do instead' line. |
| `task_tracker.instead_tail` | `report progress; never finish a turn with a silently dropped request.` |  |  | The end of the full directive's 'Do instead' line. |
| `task_tracker.jev_id` | `newRequest` |  |  | The Jev integration that labels each prompt. |
| `task_tracker.jev_instructions` | `Classify the user's message below.` |  |  | The instruction Jev gets with the prompt. |
| `task_tracker.jev_label_texts` | `a new, previously-unstated request or task, continuing or elaborating on work...` |  |  | What each label means, in the order of the labels. |
| `task_tracker.jev_labels` | `new-request, follow-up, correction, question` |  |  | The labels Jev may answer with, in order. |
| `task_tracker.jev_state_limit` | `4000` |  |  | How much of the prompt Jev sees, in UTF-16 units. |
| `task_tracker.json_max_depth` | `64` |  |  | How deeply nested a state file may be before the engine hands the read to Node. |
| `task_tracker.main_owner_re` | `^(main\|orchestrator\|coordinator)$` |  |  | JavaScript regex source (case-insensitive) of an owner that still counts as unowned (the coordinator itself). |
| `task_tracker.metrics_counters` | `demandsShown, demandsFollowed, demandsIgnored, idleNeglectBlocks` |  |  | The counters of the metrics file, in the order a fresh file lists them. |
| `task_tracker.metrics_file` | `dispatch-demand-metrics.json` |  |  | The file that counts the dispatch demands shown, followed and ignored. |
| `task_tracker.metrics_followed` | `demandsFollowed` |  |  | The counter of demands a spawn followed. |
| `task_tracker.metrics_ignored` | `demandsIgnored` |  |  | The counter of demands no spawn followed. |
| `task_tracker.metrics_pending` | `pending` |  |  | The key of the metrics file that holds the demands still to be scored, per session. |
| `task_tracker.metrics_pending_ttl_ms` | `86400000` |  | ms | How long a demand waits to be scored before it is dropped. |
| `task_tracker.non_blocking` | `keep the MAIN thread non-blocking by delegating heavy/long work to background...` |  |  | The clause the compact protocol level leaves out of the directive (the session core already carries it). |
| `task_tracker.note_joiner` | ` ` |  |  | What joins the directive or the reminder and the open-tasks line inside one text. |
| `task_tracker.open_some` | `open tasks: {n}{blocked}{tail} — update or close them.` |  |  | The open-tasks line when tasks are open; `{n}` the count, `{blocked}` the blocked-tasks tail, `{tail}` the oldest in-progress subject. |
| `task_tracker.open_zero` | `open tasks: 0{blocked}.` |  |  | The open-tasks line when no countable task is open; `{blocked}` is the blocked-tasks tail. |
| `task_tracker.owner_word` | `owner` |  |  | Who a blocked task waits on when it names nobody. |
| `task_tracker.pending_status` | `pending` |  |  | The status (lowercase) of a task nobody has started. |
| `task_tracker.primary_instead` | `a workspace-scale MATTER (feature/fix/deploy: multi-step, own branch, own rev...` |  |  | The 'instead' line of the DevSwarm Primary dispatch-tier block. |
| `task_tracker.primary_key` | `task-tracker-primary` |  |  | The emit-dedupe key of the Primary block, rationed apart from the reminder. |
| `task_tracker.primary_what` | `Primary dispatch tier: classify each task before you dispatch it.` |  |  | The 'what' line of the DevSwarm Primary dispatch-tier block. |
| `task_tracker.prune_prefix` | `task-tracker` |  |  | The prefix the sweep of stale per-session state files is stamped under. |
| `task_tracker.segment_joiner` | `\n\n` |  |  | What joins the short reminder and the open-tasks line in the output (a separate segment, so the dedupe store sees it consumed). |
| `task_tracker.session_hash_len` | `16` |  |  | How many hexadecimal digits of the working directory's hash name a session that has no id. |
| `task_tracker.session_key_max` | `80` |  |  | How many characters of a session id name its metrics entry. |
| `task_tracker.setting` | `6 entries` |  |  | Where the check's on/off switch is read from (context.taskTracker, default on). |
| `task_tracker.spawn_marker` | `"tool_use"` |  |  | The text a transcript line must hold to be looked at as a possible spawn. |
| `task_tracker.spawn_name_re` | `"name":\s*"(Agent\|Task\|Workflow)"` |  |  | JavaScript regex source (case-sensitive) of the tool name field of a spawn line. |
| `task_tracker.spawn_names` | `Agent, Task, Workflow` |  |  | The tools that spawn an agent. |
| `task_tracker.state_prefix` | `task-tracker-` |  |  | Prefix of the per-session state file that remembers when the full directive was last injected. |
| `task_tracker.state_suffix` | `.json` |  |  | Suffix of the per-session state file. |
| `task_tracker.subject_max` | `50` |  |  | The longest subject the open-tasks line quotes, in UTF-16 units. |
| `task_tracker.subject_tail` | ` (oldest in_progress subject: {subject})` |  |  | The tail naming the oldest in-progress task; `{subject}` is its quoted subject. |
| `task_tracker.subject_unknown` | `(subject unknown)` |  |  | What stands for a subject that was never learned. |
| `task_tracker.summary` | `UserPromptSubmit task-list discipline: the full directive or the short remind...` |  |  | One-line description of the task-tracker check in the generated reference. |
| `task_tracker.unknown_session` | `unknown` |  |  | The session name used when a request has none. |
| `task_tracker.unknown_tag` | `tracker` |  |  | The tag the unknown-state note is throttled under. |
| `task_tracker.what_full` | `capture EVERY user request as a task (TaskCreate) before starting work, so no...` |  |  | The first line of the full directive. |
| `task_tracker.what_short` | `capture every request as a priority-sorted task; keep statuses current; deleg...` |  |  | The short per-turn reminder. |
| `task_tracker.why_joiner` | `/` |  |  | What joins the distinct reasons tasks are blocked. |
| `task_tracker.window_ms` | `21600000` |  | ms | How long the full directive stays fresh before it is injected again. |

### settings_cli.toml / settings_cli

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `settings_cli.items` | `299 items` |  |  | Every setting with the fields `settings show` prints: type, default (null kept), advanced, locked, safetyNote and description. |
| `settings_cli.not_toggleable` | `9 items` |  |  | The parts of anti-hall that deliberately have no switch, with the reason `settings show` prints. |
| `settings_cli.sections` | `16 items` |  |  | The settings sections in display order: key, label, description. |

### operator.toml / defect

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `defect.ansi_re` | `\x1b\[[0-9;]*[a-zA-Z]` |  |  | An ANSI control sequence. |
| `defect.any_word` | `(any)` |  |  | The cause shown for a component hotspot. |
| `defect.archive_age_ms` | `2592000000` |  |  | How long a closed defect stays in the open directory after its last report (30 days), in milliseconds. |
| `defect.archive_dir` | `archive` |  |  | The archive of ruled, stale defects, inside the store directory. |
| `defect.backfill_failed` | `❌ anti-hall · defect: backfill could not read git history at {repo}: {msg}` |  |  | A history that could not be read. Placeholders: repo, msg. |
| `defect.cause_enum` | `12 items` |  |  | The root-cause taxonomy of the optional cause field. |
| `defect.cause_other` | `other` |  |  | The cause given when no rule matches. |
| `defect.cause_rules` | `11 items` |  |  | The keyword rules that classify a fix commit into a root cause: the cause, its patterns (JavaScript syntax, matched against the lower-cased subject and body) and its case-insensitive patterns. The highest score wins, ties go to the rule listed first. |
| `defect.changelog_file` | `CHANGELOG.md` |  |  | The changelog read by `backfill`, at the repository root. |
| `defect.cl_any_heading` | `^#` |  |  | Any changelog heading. |
| `defect.cl_bullet` | `^[-*]\s+(.*)$` |  |  | A changelog bullet; group 1 is its text. |
| `defect.cl_continuation` | `^\s+\S` |  |  | A continuation line of a changelog bullet. |
| `defect.cl_heading` | `^##\s+v?(\d+\.\d+\.\d+)\b` |  |  | A changelog release heading; group 1 is the version. |
| `defect.class_enum` | `8 items` |  |  | The defect classes a report may name. |
| `defect.closed_statuses` | `fixed, wontfix, notabug, dup` |  |  | The derived statuses that mean a defect is finished. |
| `defect.col_cause` | `CAUSE` |  |  | The column heading `CAUSE`. |
| `defect.col_commit` | `COMMIT` |  |  | The column heading `COMMIT`. |
| `defect.col_component` | `COMPONENT` |  |  | The column heading `COMPONENT`. |
| `defect.col_components` | `COMPONENTS` |  |  | The column heading `COMPONENTS`. |
| `defect.col_count` | `COUNT` |  |  | The column heading `COUNT`. |
| `defect.col_dates` | `DATES` |  |  | The column heading `DATES`. |
| `defect.col_score` | `SCORE` |  |  | The column heading `SCORE`. |
| `defect.col_summary` | `SUMMARY` |  |  | The column heading `SUMMARY`. |
| `defect.col_top_cause` | `TOP CAUSE` |  |  | The column heading `TOP CAUSE`. |
| `defect.col_version` | `VERSION` |  |  | The column heading `VERSION`. |
| `defect.col_versions` | `VERSIONS` |  |  | The column heading `VERSIONS`. |
| `defect.collation_symbols` | ` _-,;:!?.'"()[]{}@*/\&#%`^+<=>\|~$` |  |  | The printable ASCII symbols in the order the root collation sorts them (before digits and letters). |
| `defect.commit_cap` | `64` |  |  | Cap of the commit field of a ruling. |
| `defect.component_cap` | `120` |  |  | Cap of the component field. |
| `defect.component_steps` | `^\.\/ => , ^plugins\/anti-hall\/ => , \/lib\/ => /, \.(c\\|m)?js$\\|\.(sh\\|py\\|...` |  |  | The steps that reduce a path to its module, each `regex => replacement` in order: separators, leading ./, the plugin directory, lib segments, the file extension. |
| `defect.control_re` | `[\x00-\x1f\x7f]` |  |  | A control character. |
| `defect.dash` | `-` |  |  | Shown for a missing value in the text reports. |
| `defect.default_top` | `10` |  |  | How many rows the text reports show unless --top says otherwise. |
| `defect.deferred` | `this input needs the Node defect tool to answer exactly; nothing was written` |  |  | Said when the input needs the Node tool to answer exactly; nothing was written. |
| `defect.dir` | `defects` |  |  | The defect store directory, under the base directory of the home. |
| `defect.err_line` | `❌ anti-hall · defect: {e}` |  |  | An error line of `defect`. Placeholder: e. |
| `defect.explicit_word` | ` (explicit)` |  |  | Marks an explicit regression. |
| `defect.extra_keys` | `7 items` |  |  | The optional fields a record can carry; the last line with one wins. |
| `defect.field_caps` | `5 entries` |  |  | The length caps, in UTF-16 units, of the narrative and identifying fields of a report or ruling. |
| `defect.file_ext` | `.jsonl` |  |  | The extension of a defect file. |
| `defect.fix_subject` | `^fix(\(([^)]*)\))?!?:\s*` |  |  | A fix commit subject (case-insensitive); group 2 is the scope. |
| `defect.flag_not_valid` | `--{k} is not a valid flag for `{cmd}`` |  |  | An unknown flag. Placeholders: k, cmd. |
| `defect.flag_valid_for` | `--{k} is valid for `{others}`, not `{cmd}`` |  |  | A flag typed against the wrong subcommand. Placeholders: k, others, cmd. |
| `defect.fp_len` | `12` |  |  | Length of a fingerprint (and of the supersededBy field). |
| `defect.git_bin` | `git` |  |  | The git program `backfill` runs. |
| `defect.git_command_failed` | `Command failed: {cmd}` |  |  | First line of a git failure. Placeholder: cmd. |
| `defect.git_dir_flag` | `-C` |  |  | The git flag that names the repository directory. |
| `defect.git_log_args` | `log, --no-merges, --no-renames, --numstat, --format={rs}%H{us}%aI{us}%s{us}%b...` |  |  | The arguments of the git log that lists the commits ({rs} and {us} are the two separators). |
| `defect.git_revlist_args` | `rev-list, {tag}` |  |  | The arguments of the git command that lists the commits under a tag. |
| `defect.git_spawn_failed` | `spawnSync {bin} ENOENT` |  |  | Why git could not run. Placeholder: bin. |
| `defect.git_tag_args` | `tag, --list` |  |  | The arguments of the git command that lists the tags. |
| `defect.history_changelog_cap` | `600` |  |  | Cap of a backfilled changelog bullet. |
| `defect.history_dir` | `history` |  |  | Where `backfill` keeps the fixed bugs imported from git history, inside the store directory. |
| `defect.history_subject_cap` | `200` |  |  | Cap of a backfilled commit subject. |
| `defect.hotspot_component_min` | `3` |  |  | Fixes of one component that make it a hotspot. |
| `defect.hotspot_pair_min` | `2` |  |  | Fixes of one component and cause that make a hotspot. |
| `defect.identity_cap` | `64` |  |  | Cap of a project identity. |
| `defect.indent` | `  ` |  |  | In front of every row of the text reports. |
| `defect.key_at` | `at` |  |  | The record or result key `at`. |
| `defect.key_chunks` | `chunks` |  |  | The record or result key `chunks`. |
| `defect.key_commit` | `commit` |  |  | The record or result key `commit`. |
| `defect.key_component` | `component` |  |  | The record or result key `component`. |
| `defect.key_field` | `field` |  |  | The record or result key `field`. |
| `defect.key_fix_commit` | `fixCommit` |  |  | The record or result key `fixCommit`. |
| `defect.key_fixed_in` | `fixedIn` |  |  | The record or result key `fixedIn`. |
| `defect.key_for_type` | `forType` |  |  | The record or result key `forType`. |
| `defect.key_fp` | `fp` |  |  | The record or result key `fp`. |
| `defect.key_of` | `of` |  |  | The record or result key `of`. |
| `defect.key_outcome` | `outcome` |  |  | The record or result key `outcome`. |
| `defect.key_overflow` | `overflow` |  |  | The record or result key `overflow`. |
| `defect.key_part` | `part` |  |  | The record or result key `part`. |
| `defect.key_seq` | `seq` |  |  | The record or result key `seq`. |
| `defect.key_status` | `status` |  |  | The record or result key `status`. |
| `defect.key_t` | `t` |  |  | The record or result key `t`. |
| `defect.key_text` | `text` |  |  | The record or result key `text`. |
| `defect.key_truncated` | `truncated` |  |  | The record or result key `truncated`. |
| `defect.key_v` | `v` |  |  | The record or result key `v`. |
| `defect.kind_component` | `component` |  |  | The hotspot kind for one component. |
| `defect.kind_pair` | `component+cause` |  |  | The hotspot kind for a component and cause. |
| `defect.label_proj_flag` | `--proj` |  |  | Names the --proj flag in a truncation warning. |
| `defect.label_proj_setting` | `defects.defaultProj` |  |  | Names the default-project setting in a truncation warning. |
| `defect.list_sep` | `, ` |  |  | Between items of a listed message. |
| `defect.loose_cap` | `5000` |  |  | Cap of the project and session fields (bounds pathological input only). |
| `defect.marker_written` | `, marker written` |  |  | Added when a truncation marker was written into the value. |
| `defect.max_archive_files` | `1000` |  |  | Most files in the archive across all month buckets. |
| `defect.max_file_bytes` | `65536` |  |  | Most bytes of one defect file. |
| `defect.max_line_bytes` | `4096` |  |  | Most bytes of one NDJSON line. |
| `defect.max_open_files` | `200` |  |  | Most open defect files; a new defect past it is refused. |
| `defect.max_report_lines` | `20` |  |  | Most report lines of one defect. |
| `defect.no_repo` | `no-repo` |  |  | The project of a report filed outside any repository. |
| `defect.none` | `none` |  |  | Shown under a report section with no rows. |
| `defect.nonsource_dir` | `(^\|\/)(tests?\|__tests__\|fixtures\|docs\|eval)\/` |  |  | Directories whose files never name a component. |
| `defect.notice` | `{pointer} [truncated from {n} chars]` |  |  | The marker appended to a truncated value. Placeholders: pointer, n. |
| `defect.notice_pointer` | ` (rest continued in this record's overflow lines - see `defect show`)` |  |  | Prepended to the truncation marker when the cut tail was kept in overflow lines. |
| `defect.null_word` | `null` |  |  | How a missing value reads as text in a comparison. |
| `defect.others_sep` | ``, `` |  |  | Between the subcommands named in a wrong-flag message. |
| `defect.out_defect_full` | `defect-full` |  |  | The outcome word `defect-full`. |
| `defect.out_exists` | `exists` |  |  | The outcome word `exists`. |
| `defect.out_found` | `found` |  |  | The outcome word `found`. |
| `defect.out_invalid_cause` | `invalid-cause` |  |  | The outcome word `invalid-cause`. |
| `defect.out_invalid_class` | `invalid-class` |  |  | The outcome word `invalid-class`. |
| `defect.out_invalid_regression` | `invalid-regression-of` |  |  | The outcome word `invalid-regression-of`. |
| `defect.out_invalid_severity` | `invalid-severity` |  |  | The outcome word `invalid-severity`. |
| `defect.out_invalid_status` | `invalid-status` |  |  | The outcome word `invalid-status`. |
| `defect.out_not_found` | `not-found` |  |  | The outcome word `not-found`. |
| `defect.out_occurrence_appended` | `occurrence-appended` |  |  | The outcome word `occurrence-appended`. |
| `defect.out_occurrence_capped` | `occurrence-capped` |  |  | The outcome word `occurrence-capped`. |
| `defect.out_recorded` | `recorded` |  |  | The outcome word `recorded`. |
| `defect.out_registry_full` | `registry-full` |  |  | The outcome word `registry-full`. |
| `defect.out_ruled` | `ruled` |  |  | The outcome word `ruled`. |
| `defect.out_too_large` | `too-large` |  |  | The outcome word `too-large`. |
| `defect.out_write_unverified` | `write-unverified` |  |  | The outcome word `write-unverified`. |
| `defect.overflow_chunk_bytes` | `3200` |  |  | Bytes of one spilled overflow chunk, well under the line cap. |
| `defect.pad_cut` | `~ ` |  |  | Ends a column cut to its width. |
| `defect.pair_sep` | `` |  |  | Joins a component and cause into a grouping key. |
| `defect.proj_key` | `defaultProj` |  |  | The setting that holds the default project. |
| `defect.proj_section` | `defects` |  |  | The settings section of the default project. |
| `defect.reason_archive_full` | `archive-full` |  |  | Why a closed defect was not archived. |
| `defect.reason_too_recent` | `too-recent` |  |  | Why a closed defect was not archived. |
| `defect.rec_by_cause` | `BY CAUSE` |  |  | Heading of the per-cause table. |
| `defect.rec_by_component` | `BY COMPONENT` |  |  | Heading of the per-component table. |
| `defect.rec_hotspots` | `HOTSPOTS (component fixed >= {component_min}x, or same component+cause >= {pa...` |  |  | Heading of the hotspots. Placeholders: component_min, pair_min. |
| `defect.rec_more` | `  ... {n} more (--top N / --json)` |  |  | More regressions than shown. Placeholder: n. |
| `defect.rec_regression_row` | `  {what} {fixed} re-fixes {was} {earlier} {component} [{cause}]{explicit}` |  |  | One likely regression row. Placeholders: what, fixed, was, earlier, component, cause, explicit. |
| `defect.rec_regressions` | `LIKELY REGRESSIONS (same component+cause fixed again within {window} releases...` |  |  | Heading of the likely regressions. Placeholder: window. |
| `defect.rec_since` | ` since {since}` |  |  | Added to the total line when --since was given. Placeholder: since. |
| `defect.rec_total` | `{total} records{since} (reported + backfill)` |  |  | First line of `recurring`. Placeholders: total, since. |
| `defect.regression_extra` | `3` |  |  | Extra report lines allowed past the cap when the defect is fixed or regressed. |
| `defect.regression_window` | `5` |  |  | Releases within which a second fix of the same component and cause is a likely regression. |
| `defect.repo_hash_hex` | `6` |  |  | Hex digits of the hash in a project key. |
| `defect.repo_name_cap` | `40` |  |  | Cap of the readable repository name in a project key. |
| `defect.repo_word` | `repo` |  |  | The repository name when nothing readable is left. |
| `defect.rs_char` | `` |  |  | Separates commits in the git log format. |
| `defect.ruling_status_enum` | `ack, fixed, wontfix, notabug, dup, partial` |  |  | The statuses a ruling may set. |
| `defect.severity_enum` | `p0, p1, p2` |  |  | The severities a report may name. |
| `defect.short_sha` | `7` |  |  | Characters of a commit hash shown in the text reports. |
| `defect.sim_none` | `no similar past fixes found` |  |  | Said when `similar` finds nothing. |
| `defect.skill_file` | `(^\|\/)skills\/[^/]+\/SKILL\.md$` |  |  | A skill document path. |
| `defect.skill_suffix` | `\/SKILL\.md$` |  |  | The skill document name removed to name its directory. |
| `defect.source_ext` | `\.(c\|m)?js$\|\.(sh\|py\|ts)$` |  |  | A file that can name a fix's component: shipped code. |
| `defect.source_reported` | `reported` |  |  | The source of a record that was reported, not backfilled. |
| `defect.span_sep` | `..` |  |  | Between the two ends of a version or date span. |
| `defect.status_fixed` | `fixed` |  |  | The status of a fixed defect. |
| `defect.status_open` | `open` |  |  | The status of a defect nobody has ruled on. |
| `defect.status_regressed` | `regressed` |  |  | The derived status of a fixed defect that reappeared in a build at or after the fix. |
| `defect.step_sep` | ` => ` |  |  | Separates a regex from its replacement in a component step. |
| `defect.stop_words` | `the and for not but with from into that this than then when what does never n...` |  |  | Words ignored when matching a new bug against past fixes. |
| `defect.subject_version` | `^fix(\([^)]*\))?!?:\s*v(\d+\.\d+(?:\.\d+)?)\b` |  |  | A fix subject that names its own release (case-insensitive); group 2 is the version. |
| `defect.summary_cap` | `100` |  |  | Characters of a summary shown by `similar`. |
| `defect.t_backfill` | `backfill` |  |  | The line type `backfill`. |
| `defect.t_overflow` | `overflow` |  |  | The line type `overflow`. |
| `defect.t_report` | `report` |  |  | The line type `report`. |
| `defect.t_ruling` | `ruling` |  |  | The line type `ruling`. |
| `defect.tag_re` | `^v?\d+\.\d+\.\d+$` |  |  | A release tag. |
| `defect.test_file` | `\.test\.(c\|m)?js$\|\.spec\.(c\|m)?js$` |  |  | A test file name. |
| `defect.tested_module` | `^tests\/(.+?)(\.[a-z0-9-]+)*\.test\.(c\|m)?js$` |  |  | A test file path; group 1 is the module it tests. |
| `defect.true_word` | `true` |  |  | How a bare flag reads as text. |
| `defect.trunc_part` | `{k} ({len} chars -> cap {cap}{marked})` |  |  | One cut field. Placeholders: k, len, cap, marked. |
| `defect.unclassified` | `(unclassified)` |  |  | The group of records with no component or cause. |
| `defect.unknown_word` | `unknown` |  |  | The version or session when none is known. |
| `defect.unreleased` | `unreleased` |  |  | The release of a fix not in any release. |
| `defect.us_char` | `` |  |  | Separates the fields of a commit in the git log format. |
| `defect.usage` | `💡 anti-hall · defect: usage: defect.js <report\|list\|show\|rule\|archive\|backfil...` |  |  | Usage of `defect`. |
| `defect.usage_rule` | `💡 anti-hall · defect: usage: defect.js rule <fp> --status ...` |  |  | Usage of `defect rule`. |
| `defect.usage_show` | `💡 anti-hall · defect: usage: defect.js show <fp>` |  |  | Usage of `defect show`. |
| `defect.usage_similar` | `💡 anti-hall · defect: usage: defect.js similar <text...> [--component X] [--t...` |  |  | Usage of `defect similar`. |
| `defect.v_cap` | `40` |  |  | Cap of the version fields. |
| `defect.valid_flags` | `8 items` |  |  | The closed set of flags of each subcommand (the first word is the subcommand). |
| `defect.valid_flags_line` | `valid flags for `{cmd}`: {list}` |  |  | Lists the flags a subcommand accepts. Placeholders: cmd, list. |
| `defect.version_re` | `^v?\d+\.\d+\.\d+$` |  |  | A version given to --since. |
| `defect.warn_identity` | `⚠️ anti-hall · defect: {label} truncated to fit the identity cap: {n} chars -...` |  |  | A project identity cut to its cap. Placeholders: label, n, cap. |
| `defect.warn_truncated` | `⚠️ anti-hall · defect: content was truncated to fit the defect schema: {parts}` |  |  | Fields cut to fit the schema. Placeholder: parts. |

### operator.toml / env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `env.antihall_session_id` | `ANTIHALL_SESSION_ID` |  |  | The session id anti-hall exports when the host does not. |
| `env.claude_session_id` | `CLAUDE_SESSION_ID` |  |  | The session id the host exports; `defect report` files a report under it. |

### operator.toml / ops

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `ops.advanced_hidden` | `_{count} advanced setting(s) hidden — rerun with `--all` to show them._` |  |  | Line shown when a section has advanced settings and `--all` was not given. Placeholder: count. |
| `ops.advanced_label` | `**Advanced:**` |  |  | Heading of the advanced settings table. |
| `ops.advanced_suffix` | ` (advanced)` |  |  | After the name of an advanced setting in the tables. |
| `ops.allow_kinds` | `2 entries` |  |  | Per allowlist kind: the file in the repository, the per-user trust record and the key of the list in the file. |
| `ops.backend_api` | `api` |  |  | Backend name when the paid API judge is used. |
| `ops.backend_api_api` | ` (speculation-judge calls the Anthropic API)` |  |  | Detail when the judge calls the Anthropic API. |
| `ops.backend_api_cli` | ` (speculation-judge calls the local claude CLI, jev.judgeBackend={backend})` |  |  | Detail when the judge calls the local CLI. Placeholder: backend. |
| `ops.backend_jev` | `jev` |  |  | Backend name when the speculation guard asks Jev. |
| `ops.backend_jev_detail` | ` (speculation-guard asks Jev; the paid API judge exits early{tail}` |  |  | Detail when the backend is Jev. Placeholder: tail. |
| `ops.backend_lexical` | `lexical` |  |  | Backend name when only the lexical guard runs. |
| `ops.backend_lexical_detail` | ` (lexical speculation-guard only)` |  |  | Detail when only the lexical guard runs. |
| `ops.backend_line` | `backend: {backend}{detail}` |  |  | The backend line of `judge`. Placeholders: backend, detail. |
| `ops.cell_sep` | ` \| ` |  |  | Between two cells of a settings table row. |
| `ops.code_quote` | ``` |  |  | The quote around an object value in the settings tables. |
| `ops.cost_line` | `Cost: {cost}.` |  |  | The cost line of `judge on`. Placeholder: cost. |
| `ops.defer_exit` | `75` |  |  | Exit code of an operator command that leaves the work to the Node tool because it cannot reproduce the Node behaviour exactly (nothing is written). |
| `ops.edit_absolute` | `absolute path` |  |  | Why an edit path is ignored. |
| `ops.edit_backslash` | `backslash (use / separators)` |  |  | Why an edit path is ignored. |
| `ops.edit_dotdot` | `.. path segment` |  |  | Why an edit path is ignored. |
| `ops.edit_empty` | `empty or padded with whitespace` |  |  | Why an edit path is ignored. |
| `ops.edit_everything` | `matches every file` |  |  | Why an edit path is ignored. |
| `ops.edit_home` | `home-relative path` |  |  | Why an edit path is ignored. |
| `ops.empty_value` | `(empty)` |  |  | How `settings` prints an empty or missing value. |
| `ops.false_word` | `false` |  |  | The value `judge off` stores. |
| `ops.get_line` | `{name} = {value} (source: {source}, default: {default})` |  |  | Output of `settings get`. Placeholders: name, value, source, default. |
| `ops.heading_prefix` | `## ` |  |  | In front of a section label in `settings show`. |
| `ops.integrations_title` | `**Jev integrations — effective mode** (what the runtime applies, including th...` |  |  | Heading of the Jev integrations table. |
| `ops.jev_detail_plain` | `)` |  |  | Tail of the Jev detail when the judge switch is off. |
| `ops.jev_detail_skipped` | `, API judge skipped)` |  |  | Tail of the Jev detail when the judge switch is on. |
| `ops.jev_effective_key` | `jevEffectiveIntegrations` |  |  | The key of the effective-integrations list in `settings show --json`. |
| `ops.jev_integrations_section` | `jevIntegrations` |  |  | The settings section of the per-integration Jev modes. |
| `ops.jev_section` | `jev` |  |  | The settings section of the Jev switches. |
| `ops.js_compile` | `new RegExp(globalThis.__ah_pattern)` |  |  | The script that checks a regex source compiles, in the embedded interpreter. |
| `ops.js_pattern_var` | `__ah_pattern` |  |  | The name of the global the embedded interpreter receives a regex source in. |
| `ops.judge_auto` | `auto` |  |  | The backend value that uses the API with a key and the CLI without. |
| `ops.judge_backend_default` | `api` |  |  | The backend `judge` assumes when none is set. |
| `ops.judge_backend_key` | `judgeBackend` |  |  | The setting that names how the judge reaches the model. |
| `ops.judge_cli` | `cli` |  |  | The backend value that runs the local Claude CLI. |
| `ops.judge_cost_api` | `about $0.0001–0.001 and 1–3 s per turn end, estimated, not measured; precisio...` |  |  | What the API judge costs. |
| `ops.judge_cost_cli` | `no API bill (your Claude login's usage) and about 5–6 s per turn end, measure...` |  |  | What the CLI judge costs. |
| `ops.judge_line` | `judge: {state}{extra}` |  |  | First line of `judge`. Placeholders: state, extra. |
| `ops.judge_model_default` | `haiku` |  |  | The model alias `judge status` shows when none is set. |
| `ops.judge_model_key` | `judgeModel` |  |  | The setting that names the judge model. |
| `ops.judge_no_key_lines` | `No key visible here. Add one so the judge can call the Anthropic API:,   Clau...` |  |  | Said by `judge on` when no key is visible and the API would be used. |
| `ops.judge_still_on` | ` (still on via env ANTIHALL_SEMANTIC_JUDGE)` |  |  | Added after `judge: on` when `judge off` finds it still on. |
| `ops.judge_switch_key` | `semanticJudge` |  |  | The setting that switches the semantic judge. |
| `ops.judge_verbs` | `on, off, status` |  |  | The verbs of `settings judge`. |
| `ops.key_found` | `key: found (value not shown)` |  |  | The key line when an Anthropic key is visible. |
| `ops.key_missing` | `key: not visible to this process` |  |  | The key line when no key is visible. |
| `ops.kind_command` | `command` |  |  | The name of the command allowlist kind. |
| `ops.kind_edit` | `edit` |  |  | The name of the edit allowlist kind. |
| `ops.list_sep` | `, ` |  |  | Separator of the values listed in a settings message. |
| `ops.lock_busy` | `settings.json is being written by another process; run the Node settings tool...` |  |  | Said when another process holds the settings lock past the wait budget; the Node tool names the holder, so the command leaves the change to it. |
| `ops.locked_suffix` | ` (safety: needs --confirmed)` |  |  | After the name of a safety setting in the tables. |
| `ops.logs_default` | `jev-assist.ndjson` |  |  | Where every other integration logs. |
| `ops.logs_triage` | `jev-triage.ndjson (+ outcome rows in jev-assist.ndjson)` |  |  | Where the triage integration logs. |
| `ops.mode_off` | `off` |  |  | The word for an integration or switch that is off. |
| `ops.mode_on` | `on` |  |  | The word for an integration or switch that is on. |
| `ops.model_line` | `model: {model}` |  |  | The model line of `judge status`. Placeholder: model. |
| `ops.not_toggleable_intro` | `These parts have no switch on purpose:` |  |  | Introduction of the list of parts without a switch. |
| `ops.not_toggleable_line` | `- `{name}`: {reason}` |  |  | One part without a switch. Placeholders: name, reason. |
| `ops.not_toggleable_title` | `## Not toggleable` |  |  | Heading of the list of parts without a switch. |
| `ops.pat_alt` | `top-level \| alternation` |  |  | Why a command pattern is ignored. |
| `ops.pat_end` | `must end with $` |  |  | Why a command pattern is ignored. |
| `ops.pat_not_string` | `not a string` |  |  | Why an allowlist entry is ignored: it is not a string. |
| `ops.pat_regex` | `invalid regex` |  |  | Why a command pattern is ignored. |
| `ops.pat_start` | `must start with ^` |  |  | Why a command pattern is ignored. |
| `ops.pat_wildcard` | `unbounded wildcard ({what})` |  |  | Why a command pattern is ignored. Placeholder: what (the wildcard). |
| `ops.pat_word` | `must begin with a literal command word after ^` |  |  | Why a command pattern is ignored. |
| `ops.reset_line` | `{name} reset -> {value}` |  |  | Output of `settings reset`. Placeholders: name, value. |
| `ops.row_bad` | `! ` |  |  | Between the indent and an ignored allowlist entry. |
| `ops.row_ignored` | `   (ignored: {why})` |  |  | After an ignored allowlist entry. Placeholder: why. |
| `ops.row_indent` | `  ` |  |  | In front of an allowlist row. |
| `ops.row_ok` | `  ` |  |  | Between the indent and a valid allowlist entry. |
| `ops.rule_cell` | `---` |  |  | One header-rule cell of a settings table. |
| `ops.safety_add` | `Adding {list} to edit-guard's allow list means {note}. Ask the user to confir...` |  |  | Warning for widening an allow list. Placeholders: list, note. |
| `ops.safety_change` | `Changing {guard} means {note}. Ask the user to confirm, then re-run with --co...` |  |  | Warning for re-targeting a bound credential. Placeholders: guard, note. |
| `ops.safety_note_default` | `this weakens a safety guard` |  |  | The consequence named when a safety setting has no note of its own. |
| `ops.safety_turn` | `Turning {verb} {guard} means {note}. Ask the user to confirm, then re-run wit...` |  |  | Warning for turning a guard off or a bypass on. Placeholders: verb, guard, note. |
| `ops.safety_verb_off` | `off` |  |  | The verb of a warning about turning a guard off. |
| `ops.safety_verb_on` | `on` |  |  | The verb of a warning about turning a bypass on. |
| `ops.script_defect` | `scripts/defect.js` |  |  | The Node defect script, relative to the plugin root. |
| `ops.script_settings` | `scripts/settings.js` |  |  | The Node settings script, relative to the plugin root. |
| `ops.script_statusline` | `statusline/statusline.js` |  |  | The Node status line dispatcher, relative to the plugin root. |
| `ops.set_err_bool` | `expected a boolean (true/false/on/off/1/0), got {got}` |  |  | Why a value is not a boolean. Placeholder: got (JSON text). |
| `ops.set_err_enum` | `must be one of: {values}` |  |  | A value outside the allowed words. Placeholder: values. |
| `ops.set_err_exclusive_min` | `must be > {bound}` |  |  | A number at or below the exclusive minimum. Placeholder: bound. |
| `ops.set_err_max` | `must be <= {bound}` |  |  | A number above the maximum. Placeholder: bound. |
| `ops.set_err_min` | `must be >= {bound}` |  |  | A number below the minimum. Placeholder: bound. |
| `ops.set_err_number` | `expected a number, got {got}` |  |  | Why a value is not a number. Placeholder: got (JSON text). |
| `ops.set_err_object` | `this setting is file-only (edit ~/.anti-hall/settings.json directly); it cann...` |  |  | Why a file-only setting cannot be set. |
| `ops.set_line` | `{name} = {value}` |  |  | Output of `settings set`. Placeholders: name, value. |
| `ops.settings_err` | `❌ anti-hall · settings: {error}` |  |  | An error line of `settings`. Placeholder: error. |
| `ops.settings_sources` | `5 entries` |  |  | The label `settings` prints for each tier a value can come from. |
| `ops.settings_unknown_section` | `❌ anti-hall · settings: unknown section: {name}` |  |  | Unknown `--section`. Placeholder: name. |
| `ops.settings_unknown_setting` | `❌ anti-hall · settings: unknown setting: {name} (expected section.key)` |  |  | Unknown setting name. Placeholder: name. |
| `ops.settings_usage` | `💡 anti-hall · settings: usage: settings.js <show\|get\|set\|reset\|judge\|trust-co...` |  |  | Usage of `settings`. |
| `ops.settings_usage_judge` | `💡 anti-hall · settings: usage: settings.js judge on\|off\|status` |  |  | Usage of `settings judge`. |
| `ops.settings_usage_set` | `💡 anti-hall · settings: usage: settings.js set <section.key> <value>` |  |  | Usage of `settings set`. |
| `ops.shadow_child_env` | `AH_ENGINE_SHADOW_CHILD` |  |  | Set in the shadow child so it never starts a shadow of its own. |
| `ops.shadow_command` | `shadow-compare` |  |  | The internal command that runs one comparison. |
| `ops.shadow_copy` | `7 items` |  |  | The entries of ~/.anti-hall the Node shadow gets a private copy of (everything it may change); compared after both runs. |
| `ops.shadow_copy_bytes` | `16777216` |  |  | Most bytes copied into one shadow home. |
| `ops.shadow_digest_bytes` | `8` |  |  | Bytes of the content digest in the shadow state comparison. |
| `ops.shadow_dir` | `shadow` |  |  | The shadow scratch directory, inside the engine state directory. |
| `ops.shadow_dry_env` | `ANTIHALL_INGEST_DRY_RUN` |  |  | The dry-run switch every Node script honours. |
| `ops.shadow_engine_err` | `engine.err` |  |  | The engine stderr of a sampled run. |
| `ops.shadow_engine_out` | `engine.out` |  |  | The engine stdout of a sampled run. |
| `ops.shadow_event` | `shadow` |  |  | The command name of the telemetry event a comparison leaves. |
| `ops.shadow_home_word` | `HOME` |  |  | Replaces the real and the scratch home in compared text. |
| `ops.shadow_ignore_ext` | `.lock, .tmp` |  |  | File name endings left out of the state comparison. |
| `ops.shadow_job_file` | `job.json` |  |  | The comparison job file. |
| `ops.shadow_keep` | `20` |  |  | How many mismatching comparisons keep their files for review. |
| `ops.shadow_link_home` | `.claude, .claude.json` |  |  | The home entries the Node shadow reads through links. |
| `ops.shadow_lock_ext` | `.lock` |  |  | Lock files are never linked into the shadow home. |
| `ops.shadow_masks` | `7 items` |  |  | Patterns replaced before comparing (`regex => replacement`): clock values and animation frames. |
| `ops.shadow_node` | `node` |  |  | The Node program the shadow runs when AH_ENGINE_NODE is not set. |
| `ops.shadow_per` | `1000` |  |  | The sampling denominator of the shadow rates. |
| `ops.shadow_rate_defect` | `1000` | `AH_ENGINE_SHADOW_RATE_DEFECT` |  | How many runs in a thousand of the defect command are also run by the Node version in the background and compared (0 turns the shadow off). The engine result is always the real one. |
| `ops.shadow_rate_settings` | `1000` | `AH_ENGINE_SHADOW_RATE_SETTINGS` |  | How many runs in a thousand of the settings command are also run by the Node version in the background and compared (0 turns the shadow off). The engine result is always the real one. |
| `ops.shadow_rate_statusline` | `50` | `AH_ENGINE_SHADOW_RATE_STATUSLINE` |  | How many runs in a thousand of the statusline command are also run by the Node version in the background and compared (0 turns the shadow off). The engine result is always the real one. |
| `ops.shadow_report` | `engine exit {want}, node exit {got}\n--- engine stdout\n{e_out}\n--- node std...` |  |  | The report a mismatching comparison leaves. Placeholders: want, got, e_out, n_out, e_err, n_err, e_state, n_state. |
| `ops.shadow_report_file` | `mismatch.txt` |  |  | The report left by a mismatching comparison. |
| `ops.shadow_skip` | `context-pct, ah-engine, ah-node-shadow, shadow` |  |  | The entries of ~/.anti-hall the Node shadow never sees. |
| `ops.shadow_stdin_file` | `stdin.bin` |  |  | The stdin of a sampled run. |
| `ops.shadow_timeout_ms` | `20000` |  |  | Longest a Node shadow run may take. |
| `ops.speculation_id` | `speculation` |  |  | The Jev integration that decides the speculation backend. |
| `ops.state_invalid_json` | `not valid JSON` |  |  | The allowlist file state. |
| `ops.state_unreadable` | `unreadable` |  |  | The allowlist file state. |
| `ops.table_headers` | `Setting, Value, Default, Source, Description` |  |  | The columns of a settings table. |
| `ops.table_headers_integrations` | `Integration, Effective, Configured, Source, Logs to` |  |  | The columns of the Jev integrations table. |
| `ops.true_word` | `true` |  |  | The value `judge on` stores. |
| `ops.trust_done` | `trusted {repo}/{rel} (sha256 {hash}):` |  |  | First line after a trust is recorded. Placeholders: repo, rel, hash. |
| `ops.trust_missing` | `no {rel} in {top}` |  |  | No allowlist file. Placeholders: rel, top. |
| `ops.trust_not_git` | `not inside a git repository: {target}` |  |  | No repository. Placeholder: target. |
| `ops.trust_state` | `{rel} in {top} is {state}` |  |  | An unusable allowlist file. Placeholders: rel, top, state. |
| `ops.trust_symlink` | `refusing a symlinked {rel} (or .anti-hall dir) in {top}` |  |  | A symlinked allowlist. Placeholders: rel, top. |
| `ops.trust_unsure` | `the repository layout needs the Node settings tool to classify; nothing was r...` |  |  | Said when the repository layout cannot be classified exactly; the Node tool decides. |
| `ops.trust_warning` | `{what}{repo} without delegating them. Re-run with --confirmed to trust this e...` |  |  | The confirmation request. Placeholders: what, repo, hash. |
| `ops.trust_what_command` | `Trusting lets the main thread run these commands in ` |  |  | What trusting a command allowlist allows. |
| `ops.trust_what_edit` | `Trusting lets the main thread edit files matching these paths in ` |  |  | What trusting an edit allowlist allows. |
| `ops.trust_write_failed` | `could not write {path}: {error}` |  |  | The trust record could not be written. Placeholders: path, error. |
| `ops.undefined_word` | `undefined` |  |  | What the Node tool prints for a missing argument. |
| `ops.verb_defect` | `defect` |  |  | The shadow name of the defect command. |
| `ops.verb_settings` | `settings` |  |  | The shadow name of the settings command. |
| `ops.verb_statusline` | `statusline` |  |  | The shadow name of the status line. |

### operator.toml / statusline

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `statusline.active_ms` | `60000` |  |  | How recently a task output must have changed to count as active, in milliseconds. |
| `statusline.activity_ms` | `120000` |  |  | How recent a spawn must be to count as active, in milliseconds. |
| `statusline.activity_template` | `[{cells}] {cyan}orchestrating{reset} {dim}·{reset} {blue}{count} agent{plural...` |  |  | The swarm activity line. Placeholders: cells cyan reset dim blue count plural. |
| `statusline.agent_icon` | `🤖 ` |  |  | Before the subagent count. |
| `statusline.agent_infix` | `-agent-` |  |  | Marks a todo file of an agent. |
| `statusline.agent_many` | ` agents` |  |  | The word after several agents. |
| `statusline.agent_one` | ` agent` |  |  | The word after one agent. |
| `statusline.ahead_behind_re` | `\+(\d+)\s+-(\d+)` |  |  | The ahead and behind counts. |
| `statusline.bar_empty` | `─` |  |  | An empty bar cell. |
| `statusline.bar_fill` | `█` |  |  | A filled bar cell. |
| `statusline.bar_width` | `20` |  |  | Cells of a bar. |
| `statusline.base_file` | `base-statusline.json` |  |  | The base status line configuration, in the base directory. |
| `statusline.base_key` | `base` |  |  | The setting that holds the base command. |
| `statusline.base_max_buffer` | `262144` |  |  | Most bytes a base command may print. |
| `statusline.branch_ab` | `# branch.ab ` |  |  | The git status line that counts commits ahead and behind. |
| `statusline.branch_head` | `# branch.head ` |  |  | The git status line that names the branch. |
| `statusline.branch_icon` | `🌿` |  |  | Before a branch. |
| `statusline.chip_label` | `AH: V` |  |  | The version chip label. |
| `statusline.claude_dir` | `.claude` |  |  | The host configuration directory name. |
| `statusline.claude_dir_prefix` | `claude-` |  |  | Temp directories of the host start with this. |
| `statusline.claude_json` | `.claude.json` |  |  | The host account file in the home directory. |
| `statusline.clock_icon` | `⏱ ` |  |  | Before the duration. |
| `statusline.compact_default` | `16.5` |  |  | The auto-compact buffer, in percent, when no window is set. |
| `statusline.compact_env` | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` |  |  | The auto-compact window variable. |
| `statusline.config_dir_env` | `CLAUDE_CONFIG_DIR` |  |  | The variable that moves the host configuration directory. |
| `statusline.consolidated_file` | `consolidated-base.json` |  |  | The consolidated base configuration, in the base directory. |
| `statusline.consolidated_timeout_ms` | `3000` |  |  | Longest a consolidated base command may run, in milliseconds. |
| `statusline.context_template` | `{bar} {col}{pct}%{reset} {dim}context{reset}{tokens}` |  |  | The context gauge line. Placeholders: bar col pct reset dim tokens. |
| `statusline.ctx_mark` | `● ` |  |  | Before the context percentage. |
| `statusline.cwd_tag_prefix` | `cwd-` |  |  | Prefix of a session tag made from a directory. |
| `statusline.default_model` | `Claude Code` |  |  | The model shown when nothing names one. |
| `statusline.default_project` | `project` |  |  | The project shown when the directory has no name. |
| `statusline.default_user` | `user` |  |  | The git user shown when none is configured. |
| `statusline.desc_max` | `32` |  |  | Longest phase description shown. |
| `statusline.detached` | `(detached)` |  |  | The branch name of a detached head. |
| `statusline.dir` | `statusline` |  |  | The status line directory of the plugin. |
| `statusline.dir_icon` | `📂 ` |  |  | Before the sub-directory. |
| `statusline.down` | `↓` |  |  | Commits behind. |
| `statusline.ellipsis` | `...` |  |  | Ends a cut label. |
| `statusline.email_icon` | `✉ ` |  |  | Before the account email. |
| `statusline.git_bin` | `git` |  |  | The git program. |
| `statusline.git_branch_args` | `rev-parse, --abbrev-ref, HEAD` |  |  | The git question the simple line asks for the branch. |
| `statusline.git_dir_args` | `rev-parse, --absolute-git-dir` |  |  | The git question for the git directory. |
| `statusline.git_max_buffer` | `4194304` |  |  | Most bytes one git answer may have. |
| `statusline.git_name_args` | `config, user.name` |  |  | The git question for the user name. |
| `statusline.git_stash_args` | `stash, list` |  |  | The git question for the stash. |
| `statusline.git_status_args` | `status, --porcelain=v2, --branch` |  |  | The git question for branch and changes. |
| `statusline.git_timeout_ms` | `1500` |  |  | Longest one git question may take, in milliseconds. |
| `statusline.git_top_args` | `rev-parse, --show-toplevel` |  |  | The git question for the project root. |
| `statusline.gitmodules` | `.gitmodules` |  |  | The file that marks a monorepo. |
| `statusline.header_mark` | `▊ ` |  |  | Starts the rich line. |
| `statusline.in_progress` | `in_progress` |  |  | The status of the task in progress. |
| `statusline.inner_timeout_ms` | `2500` |  |  | Longest a base command may run, in milliseconds. |
| `statusline.level_red` | `90` |  |  | Context percentage from which the gauge is red. |
| `statusline.level_yellow` | `70` |  |  | Context percentage from which the gauge is yellow. |
| `statusline.max_keys` | `max_tokens, total_tokens, context_size` |  |  | The context_window fields that carry the window size. |
| `statusline.model_id_skip` | `1` |  |  | Words skipped when a model id is shown as a name. |
| `statusline.model_id_take` | `2` |  |  | Words kept when a model id is shown as a name. |
| `statusline.model_words` | `2 entries, 2 entries, 2 entries, 2 entries` |  |  | The model families recognised in a model id or setting, in priority order. |
| `statusline.no_color_env` | `NO_COLOR` |  |  | The variable that turns colors off. |
| `statusline.no_email_key` | `noEmail` |  |  | The setting that hides the account email. |
| `statusline.output_ext` | `.output` |  |  | A task output file ends with this. |
| `statusline.own_re` | `^node\s+"?([^"\|;&<>]+?\.js)"?\s*$` |  |  | A base command that runs one of the plugin's own renderers. |
| `statusline.pct_dir` | `context-pct` |  |  | Where the context figure is kept for the hooks, in the base directory. |
| `statusline.pct_min_delta` | `1` |  |  | Smallest change of the context figure that is written before the interval has passed. |
| `statusline.pct_write_interval_ms` | `30000` |  |  | Least time between two writes of the context figure, in milliseconds. |
| `statusline.phase_colors` | `10 entries` |  |  | The colors of the phase bar. |
| `statusline.phase_file` | `phase-bar.js` |  |  | The phase bar file. |
| `statusline.phase_slow_secs` | `1200` |  |  | Seconds after which a phase's elapsed time turns yellow. |
| `statusline.phase_stale_ms` | `1800000` |  |  | How old a phase state may be before it is ignored, in milliseconds. |
| `statusline.phase_state_file` | `phase-state.json` |  |  | The phase state file. |
| `statusline.phase_template` | `{bar} {yellow}{pct}%{reset} {dim}\|{reset} {bold}{magenta}{code}{reset} {dim}-...` |  |  | The phase bar line. Placeholders: bar yellow pct reset dim bold magenta code white desc cyan done total extra. |
| `statusline.plural_s` | `s` |  |  | The plural ending. |
| `statusline.poll_ms` | `2` |  |  | How often a bounded child is checked, in milliseconds. |
| `statusline.porcelain_cap` | `500` |  |  | Most git status lines read. |
| `statusline.read_chunk` | `8192` |  |  | Bytes read at a time from a child process. |
| `statusline.read_grace_ms` | `200` |  |  | Extra time to collect a finished child's output, in milliseconds. |
| `statusline.rich_colors` | `16 entries` |  |  | The colors of the rich line. |
| `statusline.rich_file` | `statusline-rich.js` |  |  | The rich renderer file. |
| `statusline.safe_bidi` | `[\u202a-\u202e\u2066-\u2069]` |  |  | Bidirectional overrides removed from labels. |
| `statusline.safe_controls` | `[\x00-\x1F\x7F-\x9F]` |  |  | Control characters removed from labels. |
| `statusline.safe_csi` | `\x1b[@-_][0-?]*[ -/]*[@-~]?` |  |  | Control sequences removed from labels. |
| `statusline.safe_esc_any` | `\x1b.` |  |  | Any other escape pair removed from labels. |
| `statusline.safe_osc` | `\x1b\][^\x07\x1b]*(?:\x07\|\x1b\\)?` |  |  | Operating-system command sequences removed from labels. |
| `statusline.section` | `statusline` |  |  | The settings section of the status line. |
| `statusline.sep` | `│` |  |  | Between the segments of the rich line. |
| `statusline.session_file` | `session.json` |  |  | The local session file. |
| `statusline.settings_file` | `settings.json` |  |  | The project settings file. |
| `statusline.settings_local_file` | `settings.local.json` |  |  | The local project settings file. |
| `statusline.shell` | `sh` |  |  | The shell that runs a base command. |
| `statusline.shell_flag` | `-c` |  |  | The shell flag that takes the command. |
| `statusline.simple_colors` | `9 entries` |  |  | The colors of the simple and monorepo lines. |
| `statusline.simple_git_timeout_ms` | `2000` |  |  | Longest the simple renderer waits for git, in milliseconds. |
| `statusline.simple_join` | ` \| ` |  |  | Between the segments of the simple line. |
| `statusline.simple_model` | `Claude` |  |  | The model shown when the input names none. |
| `statusline.spawn_log` | `agent-spawns.log` |  |  | The agent spawn log, in the base directory. |
| `statusline.spinner` | `◐, ◓, ◑, ◒` |  |  | The spinner frames. |
| `statusline.stash_icon` | `📦 ` |  |  | Before the stash count. |
| `statusline.stdin_watchdog_ms` | `3000` |  |  | Longest the status line waits for its input, in milliseconds. |
| `statusline.step_max` | `28` |  |  | Longest phase step shown. |
| `statusline.sweep_ms` | `400` |  |  | Milliseconds the activity sweep stays on one cell. |
| `statusline.tag_max` | `64` |  |  | Longest session tag. |
| `statusline.tasks_dir` | `tasks` |  |  | The tasks directory of a session. |
| `statusline.tmp_default` | `/tmp` |  |  | The temp directory when no variable names one. |
| `statusline.tmp_dir` | `anti-hall` |  |  | The phase state directory under the temp directory. |
| `statusline.tmp_env` | `TMPDIR, TMP, TEMP` |  |  | The variables that name the temp directory, first match wins. |
| `statusline.todos_dir` | `todos` |  |  | The todos directory inside the host configuration directory. |
| `statusline.tofixed_limit` | `1e21` |  |  | From this cost a number prints in exponent form, which the port leaves to Node. |
| `statusline.tree_icon` | `🌳` |  |  | Before a linked worktree's branch. |
| `statusline.up` | `↑` |  |  | Commits ahead. |
| `statusline.update_star` | `★ ` |  |  | Marks an available update. |
| `statusline.used_keys` | `used_tokens, tokens` |  |  | The context_window fields that carry the used tokens. |
| `statusline.user_mark` | `● ` |  |  | Before the git user. |
| `statusline.version_check` | `version-check.json` |  |  | The version check cache, in the base directory. |
| `statusline.worktree_re` | `[/\\]\.git[/\\]worktrees[/\\]` |  |  | A git directory of a linked worktree. |
| `statusline.xy_offset` | `2` |  |  | Where the staged and unstaged letters start in a git status line. |

### slcfg.toml / env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `env.dispatcher_override` | `ANTIHALL_DISPATCHER_OVERRIDE` |  |  | Test-only switch of the installer: names the dispatcher path to embed without checking that it exists (Node: ANTIHALL_DISPATCHER_OVERRIDE). |

### slcfg.toml / ops

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `ops.script_install` | `statusline/install-statusline.js` |  |  | The Node installer, relative to the plugin root. |
| `ops.script_phase` | `statusline/phase.js` |  |  | The Node phase script, relative to the plugin root. |
| `ops.script_uninstall` | `statusline/uninstall-statusline.js` |  |  | The Node uninstaller, relative to the plugin root. |
| `ops.shadow_cwd_dir` | `cwd` |  |  | The scratch working directory of an installer shadow, inside its scratch directory. |
| `ops.shadow_cwd_word` | `CWD` |  |  | Replaces the real and the scratch working directory in compared text. |
| `ops.shadow_inst_cwd` | `.claude/settings.json, .claude/settings.local.json, .claude/settings.json.bak...` |  |  | The files under the working directory the installer shadow copies into its scratch working directory and compares afterwards. |
| `ops.shadow_inst_cwd_tag` | `c:` |  |  | Prefix of a working-directory-relative file in the installer shadow's state digest. |
| `ops.shadow_inst_home` | `.claude/settings.json, .claude/settings.json.bak-antihall, .anti-hall/base-st...` |  |  | The files under the home directory the installer shadow copies into its scratch home and compares afterwards. |
| `ops.shadow_inst_home_tag` | `h:` |  |  | Prefix of a home-relative file in the installer shadow's state digest. |
| `ops.shadow_inst_link` | `.claude/plugins` |  |  | The home entries the installer shadow reads through links (the Node installer only checks that the marketplace dispatcher exists). |
| `ops.shadow_rate_install` | `1000` | `AH_ENGINE_SHADOW_RATE_INSTALL` |  | How many runs in a thousand of install-statusline are also run by the Node installer in the background, on a scratch copy of the settings (never a second real write), and compared (0 turns the shadow off). |
| `ops.shadow_rate_phase` | `1000` | `AH_ENGINE_SHADOW_RATE_PHASE` |  | How many runs in a thousand of the phase command are also run by the Node version in the background and compared (0 turns the shadow off). The engine result is always the real one. |
| `ops.shadow_rate_uninstall` | `1000` | `AH_ENGINE_SHADOW_RATE_UNINSTALL` |  | How many runs in a thousand of uninstall-statusline are also run by the Node uninstaller in the background, on a scratch copy of the settings, and compared (0 turns the shadow off). |
| `ops.verb_install` | `install-statusline` |  |  | The shadow name of the status line installer. |
| `ops.verb_phase` | `phase` |  |  | The shadow name of the phase command. |
| `ops.verb_uninstall` | `uninstall-statusline` |  |  | The shadow name of the status line uninstaller. |

### slcfg.toml / slcfg

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `slcfg.advisory_1` | `ADVISORY: --consolidate was requested but this install is not yet in consolid...` |  |  | --consolidate on an existing plain install. |
| `slcfg.advisory_2` | `  To switch modes, uninstall first, then re-run with --consolidate:` |  |  | How to switch modes. |
| `slcfg.advisory_3` | `    node statusline/install-statusline.js --uninstall   # or remove statusLin...` |  |  | The uninstall hint. |
| `slcfg.advisory_4` | `    node statusline/install-statusline.js --consolidate` |  |  | The reinstall hint. |
| `slcfg.already_1` | `Already installed — the effective statusLine already points at anti-hall stat...` |  |  | The effective statusLine already is the dispatcher. |
| `slcfg.backed_up_1` | `Backed up: {path}` |  |  | A backup was made. Placeholders: path. |
| `slcfg.backed_up_2` | `       to: {path}` |  |  | A backup was made. Placeholders: path. |
| `slcfg.backup_exists` | `Backup already exists: {path} (not overwritten)` |  |  | A backup exists already. Placeholders: path. |
| `slcfg.backup_failed_1` | `⚠️ anti-hall · install-statusline: Could not create backup: {msg}` |  |  | stderr: the installer's backup failed. Placeholders: msg. |
| `slcfg.backup_failed_2` | `Proceeding without backup.` |  |  | stderr: it goes on. |
| `slcfg.backup_suffix` | `.bak-antihall` |  |  | Appended to a settings file's name for its one-time backup. |
| `slcfg.base_kept_1` | `Existing base-statusline.json kept (global, shared) — not overwritten:` |  |  | The shared base configuration already exists. |
| `slcfg.base_kept_3` | `  Line 1 for repos without their own helper falls back to the rich renderer.` |  |  | What line 1 does then. |
| `slcfg.base_saved` | `Saved existing statusLine as base (line 1 wrapper):` |  |  | The existing statusLine was saved as the line-1 base. |
| `slcfg.base_write_failed_1` | `⚠️ anti-hall · install-statusline: Could not write {path}: {msg}` |  |  | stderr: the base could not be written. Placeholders: path msg. |
| `slcfg.base_write_failed_2` | `Why: the statusline will still work but your previous statusline will not be ...` |  |  | stderr: what that means. |
| `slcfg.claude_dir` | `.claude` |  |  | The host's configuration directory (in the home directory and in a project). |
| `slcfg.command_line` | `  command: {cmd}` |  |  | A command shown after its file. Placeholders: cmd. |
| `slcfg.command_prefix` | `node "` |  |  | Before the dispatcher path in the statusLine command. |
| `slcfg.command_suffix` | `"` |  |  | After the dispatcher path in the statusLine command. |
| `slcfg.consolidate_nothing_1` | `NOTE: --consolidate requested but no existing statusLine found to wrap.` |  |  | --consolidate without an existing statusLine. |
| `slcfg.consolidate_nothing_2` | `  Installing anti-hall statusline directly (no consolidated base).` |  |  | What happens instead. |
| `slcfg.consolidate_nothing_3` | `  You can set ANTIHALL_STATUSLINE_BASE="<cmd>" env var in the statusLine comm...` |  |  | How to set a base later. |
| `slcfg.consolidate_nothing_4` | `  or write ~/.anti-hall/consolidated-base.json manually later.` |  |  | How to set a base later, continued. |
| `slcfg.consolidated_2` | `  The anti-hall statusline will run this base command, capture its output,` |  |  | What the consolidated mode does. |
| `slcfg.consolidated_3` | `  and APPEND the AH version chip (AH: Vx.x.x / ★) as a single merged line.` |  |  | What the consolidated mode does, continued. |
| `slcfg.consolidated_4` | `  Fail-open: if the base command errors, the full rich anti-hall line is shown.` |  |  | What happens when the base fails. |
| `slcfg.consolidated_do_instead` | `Do instead: run without --consolidate to install normally (consolidated mode ...` |  |  | stderr: what to do about it. |
| `slcfg.consolidated_saved` | `CONSOLIDATED MODE: saved existing statusLine as passthrough base:` |  |  | The existing statusLine was kept as the consolidated base. |
| `slcfg.consolidated_write_failed` | `⚠️ anti-hall · install-statusline: Could not write {path}: {msg}` |  |  | stderr: the consolidated base could not be written. Placeholders: path msg. |
| `slcfg.create_failed` | `❌ anti-hall · install-statusline: Could not create {path}: {msg}` |  |  | stderr: it could not be created. Placeholders: path msg. |
| `slcfg.created` | `Created: {path}` |  |  | A local settings file was created. Placeholders: path. |
| `slcfg.deferred` | `this input needs the Node script to answer exactly; nothing was written` |  |  | Said when the input needs the Node script to answer exactly (for example a settings file the engine cannot parse the way JavaScript does); nothing was written. |
| `slcfg.dispatcher_dev` | `  (dev/__dirname fallback)` |  |  | After the dispatcher path when it is the one next to the installer. |
| `slcfg.dispatcher_file` | `statusline.js` |  |  | The status line dispatcher script. |
| `slcfg.dispatcher_line` | `Dispatcher: {path}{note}` |  |  | The first line of the installer. Placeholders: path note. |
| `slcfg.dispatcher_stable` | `  (stable marketplace path)` |  |  | After the dispatcher path when it is the marketplace one. |
| `slcfg.done` | `Done. {path} updated.` |  |  | The settings file was updated. Placeholders: path. |
| `slcfg.empty_settings` | `{}\n` |  |  | What a missing project-local settings file is created with. |
| `slcfg.err_copyfile` | `{err}, copyfile '{from}' -> '{to}'` |  |  | Node's wording of a failed file copy. Placeholders: err from to. |
| `slcfg.err_mkdir` | `{err}, mkdir '{path}'` |  |  | Node's wording of a failed directory creation. Placeholders: err path. |
| `slcfg.err_open` | `{err}, open '{path}'` |  |  | Node's wording of a failed file open. Placeholders: err path. |
| `slcfg.errno_table` | `8 items` |  |  | Operating-system errors as Node words them (`number CODE description`); the same numbers on Linux and macOS. |
| `slcfg.errno_unknown` | `UNKNOWN: unknown error` |  |  | The words for an error the table does not know. |
| `slcfg.flag_consolidate` | `--consolidate` |  |  | The install option that merges the existing status line and the anti-hall chip into one line. |
| `slcfg.flag_project` | `--project` |  |  | The option that selects the project scope. |
| `slcfg.flag_purge` | `--purge-base` |  |  | The uninstall option that also removes the shared base configuration. |
| `slcfg.git_program` | `git` |  |  | The program that tells whether the local settings file is tracked. |
| `slcfg.git_timeout_ms` | `2000` |  |  | Longest the tracked-file question may take, in milliseconds. |
| `slcfg.git_tracked_args` | `ls-files, --error-unmatch, .claude/settings.local.json` |  |  | Its arguments. |
| `slcfg.gitignore_failed` | `⚠️ anti-hall · install-statusline: Could not update .gitignore: {msg}` |  |  | stderr: the ignore file could not be extended. Placeholders: msg. |
| `slcfg.gitignore_file` | `.gitignore` |  |  | The project's ignore file. |
| `slcfg.gitignore_has` | `.gitignore already ignores {entry}` |  |  | The ignore file already has the entry. Placeholders: entry. |
| `slcfg.gitignore_updated` | `Updated .gitignore: added {entry}` |  |  | The ignore file was extended. Placeholders: entry. |
| `slcfg.indent_line` | `  {text}` |  |  | A value shown under a note. Placeholders: text. |
| `slcfg.inst_not_found_1` | `❌ anti-hall · install-statusline: statusline.js not found at: {path}` |  |  | stderr: the dispatcher is missing. Placeholders: path. |
| `slcfg.inst_not_found_2` | `Do instead: keep the installer in the same directory as statusline.js.` |  |  | stderr: what to do about it. |
| `slcfg.inst_refused` | `⛔ anti-hall · install-statusline: refused under a test: {path} is outside a t...` |  |  | stderr: the installer refuses to write user configuration under a test. Placeholders: path. |
| `slcfg.installed_dir_install` | `/anti-hall/` |  |  | The installer treats a command that also contains this directory part as the anti-hall dispatcher. |
| `slcfg.installed_dir_uninstall` | `anti-hall/` |  |  | The uninstaller treats a command (backslashes turned into slashes) that also contains this directory part as the anti-hall dispatcher. |
| `slcfg.installed_marker` | `statusline.js` |  |  | A statusLine command that contains this names the dispatcher. |
| `slcfg.local_entry` | `.claude/settings.local.json` |  |  | The ignore-file line that keeps the local settings out of version control. |
| `slcfg.local_file` | `settings.local.json` |  |  | The host's project-local settings file (highest precedence, not committed). |
| `slcfg.new_statusline` | `New statusLine:` |  |  | Heading of the new value. |
| `slcfg.no_changes` | `No changes made.` |  |  | Nothing was changed. |
| `slcfg.no_command_1` | `Existing statusLine has no command string (type: {kind})` |  |  | The existing statusLine has no command string. Placeholders: kind. |
| `slcfg.no_command_2` | `Nothing to wrap — line 1 will use own dispatch.` |  |  | What happens then. |
| `slcfg.no_existing` | `No existing statusLine — line 1 will use own dispatch.` |  |  | There is no statusLine yet. |
| `slcfg.no_old_statusline` | `No existing statusLine.` |  |  | There was no old value. |
| `slcfg.note_project_1` | `NOTE: .claude/settings.json (committed) defines a statusLine:` |  |  | A committed project statusLine exists. |
| `slcfg.note_project_2` | `  Installing into settings.local.json so anti-hall takes precedence (local > ...` |  |  | Why the installer writes the local file. |
| `slcfg.note_user_1` | `NOTE: ~/.claude/settings.json (user/global) defines a statusLine:` |  |  | A user-level statusLine exists. |
| `slcfg.note_user_2` | `  Installing into settings.local.json will take precedence over it.` |  |  | What the local file will do to it. |
| `slcfg.old_statusline` | `Old statusLine:` |  |  | Heading of the old value. |
| `slcfg.phase_advance` | `advance` |  |  | The `phase` subcommand that advances the count. |
| `slcfg.phase_agents` | `agents` |  |  | The `phase` subcommand that sets the agent count. |
| `slcfg.phase_clear` | `clear` |  |  | The `phase` subcommand that removes the state. |
| `slcfg.phase_key_agents` | `agents` |  |  | The phase field that holds the agent count. |
| `slcfg.phase_key_done` | `done` |  |  | The phase field that holds the finished count. |
| `slcfg.phase_key_step` | `step` |  |  | The phase field that holds the step text. |
| `slcfg.phase_proto_key` | `__proto__` |  |  | A field name the engine does not merge (JavaScript treats it as the object's prototype); `update` with it is left to the Node script. |
| `slcfg.phase_set` | `set` |  |  | The `phase` subcommand that starts a phase. |
| `slcfg.phase_set_keys` | `code, desc, done, total, started` |  |  | The fields `set` writes, in order. |
| `slcfg.phase_step` | `step` |  |  | The `phase` subcommand that sets the step text. |
| `slcfg.phase_undefined` | `undefined` |  |  | How a missing subcommand reads in that message. |
| `slcfg.phase_unknown` | `❌ anti-hall · phase: unknown command "{cmd}"` |  |  | stderr of `phase` for an unknown subcommand. Placeholders: cmd. |
| `slcfg.phase_update` | `update` |  |  | The `phase` subcommand that merges fields. |
| `slcfg.refresh_interval` | `1` |  |  | The statusLine refreshInterval written by the installer, in seconds. |
| `slcfg.refused_2` | `Do instead: isolate HOME/cwd.` |  |  | stderr: what to do about it. |
| `slcfg.restart_1` | `IMPORTANT: Restart Claude Code (close and reopen) for the change to take effect.` |  |  | The installer's restart reminder. |
| `slcfg.restart_2` | `  statusLine is read only at startup — there is no hot-reload.` |  |  | Why a restart is needed. |
| `slcfg.scope_line` | `Scope:    {scope}` |  |  | The scope line. Placeholders: scope. |
| `slcfg.scope_phase_1` | `  The phase bar (line 2) appears once an orchestration phase writes` |  |  | Closing note about the phase bar. |
| `slcfg.scope_phase_2` | `  ~/.anti-hall/phase-state.json.` |  |  | Closing note about the phase bar, continued. |
| `slcfg.scope_project` | `project` |  |  | The name of the project scope in messages. |
| `slcfg.scope_project_1` | `Scope: project-local only (.claude/settings.local.json).` |  |  | Closing note for the project scope. |
| `slcfg.scope_project_2` | `  This setting is gitignored and applies to this machine only.` |  |  | Closing note for the project scope. |
| `slcfg.scope_user` | `user` |  |  | The name of the user scope in messages. |
| `slcfg.scope_user_1` | `Scope: user/global (~/.claude/settings.json).` |  |  | Closing note for the user scope. |
| `slcfg.scope_user_2` | `  The bar appears in every repo on this machine.` |  |  | Closing note for the user scope. |
| `slcfg.settings_file` | `settings.json` |  |  | The host's settings file. |
| `slcfg.settings_line` | `Settings: {path}` |  |  | The settings file line. Placeholders: path. |
| `slcfg.shell_safe_extra` | ` _.-:/\~` |  |  | Characters besides ASCII letters and digits allowed in a path embedded into the statusLine command. |
| `slcfg.source_local` | `  Source: settings.local.json (project-local, highest precedence)` |  |  | Where an installed statusLine came from. |
| `slcfg.source_project` | `  Source: settings.json (project)` |  |  | Where an installed statusLine came from. |
| `slcfg.source_user` | `  Source: ~/.claude/settings.json (user/global)` |  |  | Where an installed statusLine came from. |
| `slcfg.stable_dir` | `.claude/plugins/marketplaces/anti-hall/plugins/anti-hall/statusline` |  |  | The status line directory of the marketplace installation, relative to the home directory (stable across plugin updates). |
| `slcfg.test_markers` | `NODE_TEST_CONTEXT, ANTIHALL_TEST_ISOLATION` |  |  | Environment variables whose presence means the installer runs under a test: it then refuses to write user configuration outside a temporary directory. |
| `slcfg.tmp_default` | `/tmp` |  |  | The temporary directory when none of those variables is set. |
| `slcfg.tmp_env` | `TMPDIR, TMP, TEMP` |  |  | The environment variables the operating system's temporary directory is read from, in order. |
| `slcfg.tmp_roots` | `/tmp, /private/tmp` |  |  | Directories that count as temporary for the test guard, besides the operating system's own. |
| `slcfg.tmp_roots_macos` | `/var/folders, /private/var/folders` |  |  | More temporary directories on macOS (a child started with a stripped environment has no TMPDIR). |
| `slcfg.to_uninstall` | `To uninstall:` |  |  | Heading of the uninstall hint. |
| `slcfg.tracked_1` | `⚠️ anti-hall · install-statusline: .claude/settings.local.json is currently t...` |  |  | The local settings file is tracked by git. |
| `slcfg.tracked_2` | `  It contains a machine-absolute path and should NOT be committed.` |  |  | Why that is a problem. |
| `slcfg.tracked_3` | `  To untrack it:` |  |  | How to fix it. |
| `slcfg.tracked_4` | `    git rm --cached .claude/settings.local.json` |  |  | The command that fixes it. |
| `slcfg.type_command` | `command` |  |  | The statusLine type value. |
| `slcfg.u_backup_line` | `  {path}` |  |  | The backup path. Placeholders: path. |
| `slcfg.u_backup_no_sl` | `Backup had no statusLine key — statusLine removed.` |  |  | The backup had no statusLine. |
| `slcfg.u_current` | `  current statusLine: {cmd}` |  |  | The statusLine that is there. Placeholders: cmd. |
| `slcfg.u_kept_base` | `Kept shared base config (global, used by other projects): {path}` |  |  | The shared base was kept. Placeholders: path. |
| `slcfg.u_kept_base2` | `  Pass --purge-base to remove it once anti-hall is uninstalled everywhere.` |  |  | How to remove it. |
| `slcfg.u_no_backup` | `(No backup or base config was available; key deleted directly.)` |  |  | No backup or base was available. |
| `slcfg.u_none` | `(none)` |  |  | Shown for a missing command. |
| `slcfg.u_not_antihall_1` | `NOTE: the statusLine in {path} does not point at the` |  |  | The statusLine is not the dispatcher. Placeholders: path. |
| `slcfg.u_not_antihall_2` | `anti-hall dispatcher — leaving it untouched, skipping the base-config restore.` |  |  | The statusLine is not the dispatcher, continued. |
| `slcfg.u_not_found` | `❌ anti-hall · uninstall-statusline: {path} not found.` |  |  | stderr: the settings file does not exist. Placeholders: path. |
| `slcfg.u_nothing` | `Nothing to uninstall — statusLine key is already absent from {path}` |  |  | There is no statusLine to remove. Placeholders: path. |
| `slcfg.u_purged_a` | `Purged shared base config (--purge-base): {path}` |  |  | The shared base was removed. Placeholders: path. |
| `slcfg.u_purged_a2` | `  NOTE: any OTHER project still pointing at the anti-hall dispatcher` |  |  | A warning about other projects. |
| `slcfg.u_purged_a3` | `  will lose its line-1 wrapper and fall back to the rich renderer.` |  |  | A warning about other projects, continued. |
| `slcfg.u_removed` | `Removed statusLine from {path}:` |  |  | The statusLine was removed. Placeholders: path. |
| `slcfg.u_restart` | `Restart Claude Code (close and reopen) for the change to take effect.` |  |  | The uninstaller's restart reminder. |
| `slcfg.u_restore_failed` | `❌ anti-hall · uninstall-statusline: Could not restore {path}: {msg}` |  |  | stderr: the restore failed. Placeholders: path msg. |
| `slcfg.u_restored_backup` | `Restored {path} from backup:` |  |  | The whole file was restored from the backup. Placeholders: path. |
| `slcfg.u_restored_base` | `Restored original statusLine from: {path}` |  |  | The original command was restored. Placeholders: path. |
| `slcfg.u_restored_sl` | `Restored statusLine: {json}` |  |  | The statusLine of the backup. Placeholders: json. |
| `slcfg.u_write_failed` | `❌ anti-hall · uninstall-statusline: Could not write {path}: {msg}` |  |  | stderr: the write failed. Placeholders: path msg. |
| `slcfg.uninst_backup_failed` | `⚠️ anti-hall · uninstall-statusline: Could not create backup: {msg}` |  |  | stderr: the uninstaller's backup failed. Placeholders: msg. |
| `slcfg.uninst_refused` | `⛔ anti-hall · uninstall-statusline: refused under a test: {path} is outside a...` |  |  | stderr: the same for the uninstaller. Placeholders: path. |
| `slcfg.uninstall_file` | `uninstall-statusline.js` |  |  | The uninstaller script named in the installer's closing hint. |
| `slcfg.uninstall_hint` | `  node "{path}"` |  |  | The uninstall command. Placeholders: path. |
| `slcfg.unsafe_1` | `⛔ anti-hall · install-statusline: dispatcher path contains shell metacharacte...` |  |  | stderr: the dispatcher path has shell metacharacters. |
| `slcfg.unsafe_2` | `  Path: {path}` |  |  | stderr: the path. Placeholders: path. |
| `slcfg.unsafe_3` | `  To install manually, add to {path}:` |  |  | stderr: manual installation. Placeholders: path. |
| `slcfg.unsafe_4` | `    "statusLine": { "type": "command", "command": "node \"/path/to/statusline...` |  |  | stderr: the manual entry. |
| `slcfg.user_missing` | `❌ anti-hall · install-statusline: {path} not found. Is Claude Code installed?` |  |  | stderr: the user settings file does not exist. Placeholders: path. |
| `slcfg.write_failed_1` | `❌ anti-hall · install-statusline: Could not write {path}: {msg}` |  |  | stderr: the settings file could not be written. Placeholders: path msg. |
| `slcfg.write_failed_2` | `Do instead: restore from backup:` |  |  | stderr: how to get back. |
| `slcfg.write_failed_3` | `  node "{path}"` |  |  | stderr: the restore command. Placeholders: path. |

### update_cli.toml / codex_install

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `codex_install.backup_fmt` | `{file}.bak-{stamp}` |  |  | The name of the copy kept of a file before it changes: the file name, then this with the time. |
| `codex_install.changed` | `changed` |  |  | State word. |
| `codex_install.config_file` | `config.toml` |  |  | The Codex configuration file inside it. |
| `codex_install.dir` | `.codex` |  |  | The Codex configuration directory name (under the home directory for --global, else under the working directory). |
| `codex_install.err_home` | `install-codex: cannot find the home directory` |  |  | Printed when --global is asked for and no home directory can be found. |
| `codex_install.err_hooks` | `install-codex: cannot read the hook registration {path}: {error}` |  |  | Printed when the generated registration cannot be read or has no `hooks`. |
| `codex_install.err_no_root` | `install-codex: cannot find the plugin directory (pass --root <dir> or set the...` |  |  | Printed when the plugin directory cannot be found. |
| `codex_install.err_write` | `install-codex: cannot write {path}: {error}` |  |  | Printed when a file cannot be written. |
| `codex_install.features_heading` | `[features]` |  |  | The [features] table heading. |
| `codex_install.features_new` | `[features]\nhooks = true\n` |  |  | The table appended to a file with none. |
| `codex_install.features_nl` | `[features]\n` |  |  | The heading with its line break, replaced by itself plus the hooks setting. |
| `codex_install.features_nl_hooks` | `[features]\nhooks = true\n` |  |  | The replacement. |
| `codex_install.features_with_hooks_re` | `(?m)\[features\][\s\S]*?^\s*hooks\s*=` |  |  | A [features] table that already sets `hooks`. |
| `codex_install.heading` | `anti-hall Codex install ({scope}): {status}\n` |  |  | First output line. |
| `codex_install.hook_group_re` | `/plugins/anti-hall/hooks/\|/hooks/ah-hook\.sh"` |  |  | A hook command that belongs to anti-hall (after backslashes become slashes): a path under its hooks directory, or its thin trigger. |
| `codex_install.hooks_file` | `hooks.json` |  |  | The Codex hooks file inside it. |
| `codex_install.line_config` | `- config: {path} {state}\n` |  |  | Output line. |
| `codex_install.line_hooks` | `- hooks: {path} {state}\n` |  |  | Output line. |
| `codex_install.notes` | `- note: edit guards run on apply_patch only (Codex >= 0.134); shell writes by...` |  |  | The closing notes, each one output line. |
| `codex_install.root_token` | `${PLUGIN_ROOT}` |  |  | The placeholder in that file the installer replaces with the plugin directory. |
| `codex_install.scope_global` | `global` |  |  | Scope word. |
| `codex_install.scope_project` | `project` |  |  | Scope word. |
| `codex_install.separator` | `\n\n` |  |  | What replaces that trailing whitespace before an appended table. |
| `codex_install.status_done` | `updated` |  |  | Status word. |
| `codex_install.status_dry` | `would update` |  |  | Status word for --dry-run. |
| `codex_install.thin_hooks_rel` | `codex/hooks/hooks.json` |  |  | The generated one-wrapper-call-per-event registration, relative to the plugin directory. |
| `codex_install.trailing_ws_re` | `\s*$` |  |  | Trailing whitespace of a file. |
| `codex_install.unchanged` | `unchanged` |  |  | State word. |

### update_cli.toml / env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `env.claude_execpath` | `CLAUDE_CODE_EXECPATH` |  |  | The running Claude Code binary; the fallback `update` runs `plugin update` with when `claude` is not on the PATH. |
| `env.update_marketplace_dir` | `ANTIHALL_MARKETPLACE_DIR` |  |  | Overrides the marketplace clone `update` works on (an absolute path to an existing directory, else ignored with a warning). Test-only escape hatch. |
| `env.update_postpull_budget` | `ANTIHALL_UPDATE_POSTPULL_BUDGET_MS` |  |  | Time budget in ms for the post-pull stages of `update` (0 = unlimited); also sizes the wait for the Node stage run. |
| `env.update_quiet` | `ANTIHALL_UPDATE_QUIET` |  |  | When 1 (or true), `update` prints no `[update] <stage> start/done` progress lines on stderr. Settings key updates.quiet is the other source. |
| `env.update_reexec` | `ANTIHALL_UPDATE_REEXEC` |  |  | Set by `update` on the Node stage run it starts, so that run never starts another. |

### update_cli.toml / operator

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `operator.codex_script_rel` | `codex/install-codex.js` |  |  | The Node installer inside the plugin directory. |
| `operator.dry_run_flag` | `--dry-run` |  |  | The flag that makes install-codex write nothing (given to the Node shadow run). |
| `operator.shadow` | `1` |  |  | 1 = the Node version of an operator command runs read-only beside the engine's (update: `--check` after the update; install-codex: `--dry-run` before the write) and a difference in the reported result is logged. The engine's result is always the real one; the Node script is never run in a way that repeats a side effect. 0 = off. |
| `operator.shadow_check_log` | `update --check shadow mismatch: node={node} engine={engine}` |  |  | Event-log text when the Node `update.js --check` prints a different status line than `update --check`. |
| `operator.shadow_codex_log` | `install-codex shadow mismatch: node={node} engine={engine}` |  |  | Event-log text when the Node `install-codex.js --dry-run` reports something other than what the engine then wrote. |
| `operator.shadow_timeout_ms` | `30000` |  | ms | How long the Node shadow run may take before it is abandoned (nothing is logged for an abandoned run). |
| `operator.shadow_update_log` | `update shadow mismatch: node --check reports latest {nl}, the engine updated ...` |  |  | Event-log text when the Node `update.js --check` disagrees with the engine's update about the latest version. |

### update_cli.toml / update

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `update.cache_rel` | `cache/anti-hall/anti-hall` |  |  | The version-pinned cache root, relative to the plugins root (two levels above the marketplace clone). |
| `update.changelog_file` | `CHANGELOG.md` |  |  | The changelog at the top of the marketplace clone. |
| `update.check_flag` | `--check` |  |  | The flag that only compares versions. |
| `update.claude_bin` | `claude` |  |  | The Claude Code binary the harness registration runs. |
| `update.confirm_re` | `(?i)accept-command\|sha256` |  |  | A harness reply that asks for a confirmation (command-source installs); the engine never supplies it. |
| `update.confirm_shown` | `300` |  |  | How many UTF-16 units of that reply are shown. |
| `update.default_postpull_budget_ms` | `90000` |  | ms | The post-pull stages' overall budget when the environment does not set one. |
| `update.enoent` | `ENOENT` |  |  | The error word for a binary that is not there. |
| `update.failed_re` | `(?i-u)\bSTOP\b\|dirty\|diverged\|failed\|error` |  |  | The words in a status action that make the human summary read as a failure. |
| `update.git_bin` | `git` |  |  | The git binary. |
| `update.git_default_ref` | `origin/HEAD` |  |  | The remote ref used when the branch has no upstream. |
| `update.git_error_fallback` | `git error` |  |  | The reason when a git error has no text at all. |
| `update.git_failed_error` | `Command failed: {cmd}` |  |  | What a call that exited non-zero with nothing on stderr reads as. |
| `update.git_fetch` | `fetch, --quiet` |  |  | git arguments: fetch without merging (`--check`). |
| `update.git_pull` | `pull, --ff-only` |  |  | git arguments: fast-forward only. Never a merge, a rebase or a force. |
| `update.git_show` | `show` |  |  | git arguments to read a file from a ref: the word, then `<ref>:<path>` is appended. |
| `update.git_spawn_error` | `spawnSync {prog} {code}` |  |  | What a git call that could not start reads as ({code} is ENOENT for a missing binary). |
| `update.git_status` | `status, --porcelain` |  |  | git arguments: is the clone clean. |
| `update.git_timeout_error` | `spawnSync {prog} ETIMEDOUT` |  |  | What a call that ran past its timeout reads as. |
| `update.git_timeout_ms` | `20000` |  | ms | How long one git call of `update` may take before it fails into the offline path. |
| `update.git_upstream` | `rev-parse, --abbrev-ref, --symbolic-full-name, @{u}` |  |  | git arguments: the upstream ref of the current branch. |
| `update.harness_args` | `plugin, update, anti-hall@anti-hall` |  |  | The arguments the harness registration runs the Claude binary with. |
| `update.harness_timeout_ms` | `20000` |  | ms | How long `claude plugin update` may take before the registration is reported as failed. |
| `update.heading_re` | `^##\s+v?([0-9]+(?:\.[0-9]+)*)(?-u:\b)` |  |  | A changelog section heading; the first group is the version. |
| `update.installed_json` | `installed_plugins.json` |  |  | The harness-owned registry of installed plugins under the plugins root. `update` reads it and never writes it. |
| `update.json_max_depth` | `512` |  |  | Nesting past which a JSON file `update` reads counts as unreadable. |
| `update.kept_local` | `installed, latest, updated, action, cacheSynced` |  |  | The status keys the engine computes itself and never takes from the Node stage run. |
| `update.marketplace_rel` | `.claude/plugins/marketplaces/anti-hall` |  |  | The marketplace clone of the plugin, relative to the home directory. |
| `update.max_bytes` | `4194304` |  | bytes | Largest manifest, registry or changelog `update` reads; a larger file counts as unread. |
| `update.node_script_rel` | `skills/update/scripts/update.js` |  |  | The Node update script inside the plugin directory, run with --post-pull-only for the stages the engine does not port (the DevSwarm store sweeps and the settings migration). |
| `update.null_word` | `null` |  |  | How a missing version reads inside a text. |
| `update.offline_patterns` | `19 items` |  |  | The ONLY pull-failure shapes that fail open (case-insensitive): network, resolver and no-git errors. Any other pull failure is a hard STOP. |
| `update.plugin_json_rel` | `.claude-plugin/plugin.json` |  |  | The plugin manifest inside the plugin directory (its version is the version authority). |
| `update.plugin_src_rel` | `plugins/anti-hall` |  |  | The plugin directory inside the marketplace clone. |
| `update.poll_ms` | `25` |  | ms | How often `update` checks a child process it waits for. |
| `update.post_pull_flag` | `--post-pull-only` |  |  | The flag that runs only the post-pull part (also the flag passed to the Node stage script). |
| `update.reexec_margin_ms` | `60000` |  | ms | Extra wait for the Node stage run beyond its budget and the harness registration (one overrunning stage plus process start). |
| `update.reexec_value` | `1` |  |  | The value of the stage-run marker variable. |
| `update.remote_manifest` | `plugins/anti-hall/.claude-plugin/plugin.json` |  |  | The manifest as git names it on a remote ref (`--check` reads the remote version from it). |
| `update.semver_re` | `^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$` |  |  | A version string: X.Y.Z with an optional pre-release or build suffix; no path separators. Fully anchored. |
| `update.settings_file` | `.anti-hall/settings.json` |  |  | The settings file, relative to the home directory (updates.quiet is read from it). |
| `update.undefined_word` | `undefined` |  |  | How a missing stage field reads inside a text. |
| `update.v_strip_re` | `^[vV]` |  |  | A leading v on a version. |
| `update.version_prefix_re` | `^([0-9]+(?:\.[0-9]+)*)` |  |  | The leading numeric part of a version string. |
| `update.zero_version` | `0` |  |  | The version a missing remote version is compared as. |
| `update.zero_word` | `0` |  |  | How a missing count reads. |

### update_cli.toml / update_human

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `update_human.action` | `  action:    {value}` |  |  | Summary line. |
| `update_human.bit_archived` | `archived` |  |  | The skip reason when a result names none. |
| `update_human.bit_duplicate` | `duplicate {n}` |  |  | Reconcile result part. |
| `update_human.bit_error` | `ERROR: {error}` |  |  | Reconcile result part. |
| `update_human.bit_imported` | `imported {n}` |  |  | Reconcile result part. |
| `update_human.bit_locked` | `locked — another pull in progress, skipped` |  |  | Reconcile result part. |
| `update_human.bit_lost` | `LOST {n}` |  |  | Reconcile result part. |
| `update_human.bit_sep` | `, ` |  |  | Separator of the parts of one reconcile result. |
| `update_human.bit_skipped` | `skipped: {reason}` |  |  | Reconcile result part. |
| `update_human.cache_synced` | ` (cache synced)` |  |  | Appended to the updated line when the cache was synced. |
| `update_human.changelog_head` | `Changelog delta:` |  |  | Heading above the changelog delta. |
| `update_human.head` | `{icon} anti-hall · update: {state}` |  |  | First summary line. |
| `update_human.icon_failed` | `❌` |  |  | Summary icon: not updated. |
| `update_human.icon_ok` | `✅` |  |  | Summary icon: already up to date. |
| `update_human.icon_updated` | `⬆️` |  |  | Summary icon: updated. |
| `update_human.installed` | `  installed: {value}` |  |  | Summary line. |
| `update_human.latest` | `  latest:    {value}` |  |  | Summary line. |
| `update_human.latest_none` | `?` |  |  | The version in the head line when none is known. |
| `update_human.reconcile_item` | `    - {id}: {bits}` |  |  | One reconcile result. |
| `update_human.stage_lines` | `20 items` |  |  | The stage lines of the summary, in order: the status key, the line prefix (with its padding), and which detail follows (`reconcile` and `heal` list more). |
| `update_human.state_failed` | `not updated` |  |  | Head state. |
| `update_human.state_ok` | `already up to date` |  |  | Head state. |
| `update_human.state_updated` | `updated to v{latest}` |  |  | Head state. |
| `update_human.store_item` | `    - {repoKey}: {rows}` |  |  | One healed store. |
| `update_human.unknown` | `(unknown)` |  |  | Shown for a missing installed version. |
| `update_human.updated` | `  updated:   {value}{synced}` |  |  | Summary line. |

### update_cli.toml / update_msg

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `update_msg.available` | `update available ({installed} → {latest}) — run without --check to apply` |  |  | `--check` action when a newer version exists. |
| `update_msg.cache_copied` | `copied {version}` |  |  | Cache sync reason. |
| `update_msg.cache_failed` | `copy failed: {error}` |  |  | Cache sync reason. |
| `update_msg.cache_has` | `cache already has {version}` |  |  | Cache sync reason. |
| `update_msg.cache_no_root` | `cache root absent (nothing to mirror)` |  |  | Cache sync reason. |
| `update_msg.cache_no_src` | `plugin source dir missing` |  |  | Cache sync reason. |
| `update_msg.cache_no_target` | `no target version` |  |  | Cache sync reason. |
| `update_msg.cache_unsafe` | `unsafe version string` |  |  | Cache sync reason. |
| `update_msg.check_failed` | `check failed (offline / no git): {reason}` |  |  | `--check` action when the remote could not be read. |
| `update_msg.harness_confirm` | `harness update requires confirmation — run manually: {cmd} (see: {text})` |  |  | Detail when the harness asks for a confirmation. |
| `update_msg.harness_done` | `harness re-registered to {latest} — run /reload-plugins to load it (restart C...` |  |  | Detail after a successful registration. |
| `update_msg.harness_failed` | `harness update failed — run manually: {cmd}, then run /reload-plugins ({reason})` |  |  | Detail after a failed registration. |
| `update_msg.harness_manual` | `run manually: {cmd} — then run /reload-plugins (restart Claude Code only if a...` |  |  | Action after a failed harness registration. |
| `update_msg.harness_noop` | `harness already registered at latest (or version unknown) — nothing to do` |  |  | Detail when the harness already registers the latest version. |
| `update_msg.harness_ok` | `run /reload-plugins — the harness now registers {latest} (restart Claude Code...` |  |  | Action after a successful harness registration. |
| `update_msg.lag_ahead` | ` [installed_plugins.json reports {json}, cache shows {cache} — run /reload-pl...` |  |  | Appended when the registry is AHEAD of the cache. |
| `update_msg.lag_behind` | ` [installed_plugins.json reports {json}, cache shows {cache} — run {cmd}, the...` |  |  | Appended when the harness registry is BEHIND the cache. |
| `update_msg.no_git` | `offline / no git — cannot update: {reason}` |  |  | Action when git cannot read the clone. |
| `update_msg.no_home` | `update: cannot find the home directory` |  |  | Printed when no home directory can be found. |
| `update_msg.override_ignored` | `warning: ANTIHALL_MARKETPLACE_DIR ignored (not an absolute path to an existin...` |  |  | Printed first when the marketplace override is not an absolute path to an existing directory. |
| `update_msg.pull_offline` | `update failed (offline / network): {reason}` |  |  | Action when the pull failed with an offline shape. |
| `update_msg.pull_stop` | `STOP: git pull --ff-only failed (likely divergence) — resolve manually in {di...` |  |  | Action when the pull failed any other way: a hard STOP. |
| `update_msg.reason_failed` | `the Node stage run failed` |  |  | Why the Node stages are missing: the run failed. |
| `update_msg.reason_unusable` | `the Node stage run printed no usable status` |  |  | Why the Node stages are missing: it printed nothing usable. |
| `update_msg.reexec_failed` | ` (post-pull re-exec of {latest}'s update.js failed — kept local stage results...` |  |  | Appended to the action when the Node stage run failed. |
| `update_msg.reexec_raised` | ` (post-pull re-exec raised: {error} — kept local stage results)` |  |  | Appended to the action when starting the Node stage run raised. |
| `update_msg.reexec_unusable` | ` (post-pull re-exec of {latest}'s update.js produced no usable status — kept ...` |  |  | Appended to the action when the Node stage run printed nothing usable. |
| `update_msg.reload` | `run /reload-plugins` |  |  | Action when the cache was synced and nothing else is needed. |
| `update_msg.remote_json_bad` | `invalid JSON in the remote manifest` |  |  | The reason when the remote manifest is not JSON. |
| `update_msg.stage_done` | `[update] {name} done {ms}ms\n` |  |  | Progress line on stderr after a stage. |
| `update_msg.stage_harness` | `harness-register` |  |  | The name of the harness-registration stage in the progress lines. |
| `update_msg.stage_start` | `[update] {name} start\n` |  |  | Progress line on stderr before a stage. |
| `update_msg.stages_unavailable` | ` (post-pull stages not run: {reason})` |  |  | Appended to the action when the DevSwarm and settings stages could not be run (no Node, or no stage script) and no version change was involved. |
| `update_msg.stop_dirty` | `STOP: marketplace clone has local changes — refusing to pull. Resolve them in...` |  |  | Action when the clone has local changes: a hard STOP. |
| `update_msg.unknown_error` | `unknown error` |  |  | The reason when a failed registration has no text. |
| `update_msg.unknown_installed` | `unknown-installed-version — could not determine the installed anti-hall versi...` |  |  | Action when no source yields an installed version: never reported as up to date. |
| `update_msg.up_to_date` | `already up to date` |  |  | Action when nothing is newer. |

### handovers.toml / handovers

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `handovers.advisory_max_files` | `2000` |  |  | A SessionStart check looks at no more than this many files; a larger tree is checked by the scheduled job and the CLI only. |
| `handovers.advisory_max_lines` | `6` |  |  | Most problem lines the SessionStart advisory lists. |
| `handovers.bullet_re` | `^\s*(?:[-*+]\|\d+[.)])\s+(.*\S)\s*$` |  |  | A bullet or numbered list line; group 1 = its text. |
| `handovers.child_env` | `ANTIHALL_JUDGE_CHILD` |  |  | The environment variable the judge and Jev children carry; a hook that runs inside one does nothing. |
| `handovers.child_value` | `1` |  |  | The value of the child variable that means this process is a judge or Jev child. |
| `handovers.cli_event` | `Cli` |  |  | The event name the CLI verbs and the scheduled job pass to the script (it selects the larger time limit of script.time_limit_by_check). |
| `handovers.cmd_index` | `ah-engine handovers index` |  |  | The command the advisory tells the owner to run. |
| `handovers.commit_re` | `(?:`\|\(\|@\|\bcommit\s)((?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40})(?![\w-])` |  |  | A commit-like hash (7 to 40 hex characters with a letter and a digit) written in backticks, in parentheses, after @ or after the word commit. Matched globally; group 1 = the hash. |
| `handovers.commits_max` | `40` |  |  | Most commit-like hashes kept per handover. |
| `handovers.companion_kinds` | `4 entries` |  |  | Session companion files and what they are (file name to kind). Any other .md file in a session directory is kind `other`. |
| `handovers.date_re` | `^\d{4}-\d{2}-\d{2}$` |  |  | A day directory name. |
| `handovers.day_brief` | `BRIEF.md` |  |  | File name of a day brief, inside the day directory. |
| `handovers.day_sidecar` | `BRIEF.json` |  |  | File name of a day brief's machine-readable sidecar, inside the day directory. |
| `handovers.day_title` | `Handover brief {date}` |  |  | Title of a day brief. Placeholder: {date}. |
| `handovers.decisions_heading_re` | `\b(?:decisions?\|decided\|rulings?)\b` |  |  | A heading whose bullets are decisions taken. |
| `handovers.decisions_max` | `24` |  |  | Most decisions (and, separately, open decisions) kept per handover. |
| `handovers.dir` | `.anti-hall/handovers` |  |  | The handovers directory, relative to the project root. It must start with the state directory (script.write_root) because the briefs are written there. |
| `handovers.ellipsis` | `…` |  |  | Appended where a text was cut. |
| `handovers.emphasis_re` | `\*\*\|^(?:Situation\|Next action)\s*:\s*` |  |  | Markdown emphasis markers and a leading `Situation:` / `Next action:` label that are removed from a summary text. Matched globally. |
| `handovers.events` | `SessionStart` |  |  | The hook events the check answers. |
| `handovers.exempt_kinds` | `legacy` |  |  | Entry kinds not held to the front-matter, Situation and Next-action rules. |
| `handovers.external_re` | `^(?:[a-z][a-z0-9+.-]*:\|#)` |  |  | A link target that is not a file (scheme, anchor, mail). |
| `handovers.file_ref_re` | ``((?:[A-Za-z0-9_.~@-]+/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})`` |  |  | A backtick-quoted file path in the text: group 1 = the path (it has a directory part and an extension). Recorded in the typed `files` field. |
| `handovers.files_max` | `60` |  |  | Most file paths kept per handover. |
| `handovers.first_paragraph_fallback` | `1` |  |  | 1: a handover with neither front-matter Situation nor a situation heading takes the first paragraph after its title as the situation (source `first_paragraph`); 0: it is left empty and reported. |
| `handovers.fm_next_key` | `Next action` |  |  | Front-matter key of the next action. |
| `handovers.fm_predecessor_key` | `Predecessor` |  |  | Front-matter key of the predecessor handover (a path). |
| `handovers.fm_situation_key` | `Situation` |  |  | Front-matter key of the situation summary. |
| `handovers.fm_title_key` | `handover` |  |  | Front-matter key of the handover's own one-line title. |
| `handovers.force_flag` | `--force` |  |  | The flag that makes `index` rebuild every day, not only the changed ones. |
| `handovers.front_matter_max_lines` | `60` |  |  | Most lines a front-matter block may span before it is taken as not closed. |
| `handovers.generated_note` | `Generated by `ah-engine handovers index` from the handover files; do not edit...` |  |  | The line every generated brief carries under its title. |
| `handovers.guard_name` | `handover-hygiene` |  |  | The guard id this check answers to in skip.json and in messages. |
| `handovers.handover_re` | `^HANDOVER(?:-(\d+))?\.md$` |  |  | A numbered handover file (group 1 = its sequence number, absent = 1). The same pattern as the Node handover finder (hooks/lib/handover-find.js). |
| `handovers.heading_re` | `^(#{1,6})\s+(.*?)\s*#*\s*$` |  |  | A Markdown heading: group 1 = the hashes, group 2 = its text. |
| `handovers.headline_chars` | `140` |  |  | Longest day or session headline in the root brief (characters). |
| `handovers.hidden_prefix` | `.` |  |  | Directories and files whose name starts with this are skipped (tool state such as .omc). |
| `handovers.item_chars` | `300` |  |  | Longest single decision, preference or title kept (characters). |
| `handovers.job_max_projects` | `16` |  |  | Most registered projects one scheduled run walks. |
| `handovers.labels` | `28 entries` |  |  | Labels of the rendered briefs. |
| `handovers.legacy_dir_re` | `^legacy` |  |  | A session directory of a handover written before the session layout existed (it has no session id): its entries are kind `legacy` and are not held to the front-matter rules. |
| `handovers.legacy_index` | `INDEX.md` |  |  | File name of the append-only row index the handover skill writes. The engine only links to it and never edits it. |
| `handovers.limit_flag` | `--limit` |  |  | The flag that caps the number of search hits. |
| `handovers.list_show_max` | `8` |  |  | Most items of a list field shown in a rendered brief before `+N more` (the sidecar holds all that were kept). |
| `handovers.lock_boot_slop_s` | `5` |  |  | Slack (seconds) when a lock's recorded boot time is compared with this machine's. |
| `handovers.lock_file_prefix` | `.anti-hall/handover-index-` |  |  | Prefix of the per-project index lock file in the state directory (relative to the home directory); the project root's hash follows. |
| `handovers.lock_file_suffix` | `.lock` |  |  | Suffix of the per-project index lock file. |
| `handovers.lock_reclaim_stale_ms` | `5000` |  | ms | A lock-takeover marker older than this belongs to a reclaimer that died and may be taken over. |
| `handovers.lock_release_step_ms` | `10` |  | ms | The pause between those tries. |
| `handovers.lock_release_tries` | `5` |  |  | How many times releasing the lock tries to take the takeover marker before it removes its own lock unguarded. |
| `handovers.lock_stale_ms` | `60000` |  | ms | An index lock older than this is taken over, whatever its holder. |
| `handovers.lock_step_ms` | `20` |  | ms | The pause between attempts to take the index lock. |
| `handovers.lock_wait_ms` | `2000` |  | ms | How long an index run waits for another run on the same project before it reports `busy`. |
| `handovers.md_ext` | `.md` |  |  | The extension of the files the index looks at. |
| `handovers.md_link_re` | `\]\(([^)\s]+)\)` |  |  | A Markdown link whose target is checked when it is relative (group 1 = the target). |
| `handovers.meta_line_re` | `^\s*(?:\*\*)?(?:Trigger\|Date\|Repository\|Repo\|Predecessor\|Current release\|Curr...` |  |  | A metadata line at the top of an older handover (`Trigger: ...`, `Date: ...`): when a handover has no Situation, the first paragraph after such lines is taken instead. |
| `handovers.msg_advisory_instead` | `run `{cmd}` (the scheduled job also repairs the briefs); handover files are n...` |  |  | What to do. Placeholder: {cmd}. |
| `handovers.msg_advisory_what` | `{count} handover problem(s), {days} day brief(s) out of date in {project}` |  |  | The advisory's first line. Placeholders: {count} (problems), {days} (days needing a rebuild), {project}. |
| `handovers.msg_advisory_why` | `later searches for changes, work and decisions read the handover briefs; an u...` |  |  | Why it matters. |
| `handovers.msg_busy` | `another handover index run is in progress for this project; try again shortly` |  |  | Printed when another index run holds the project's lock. |
| `handovers.msg_check_clean` | `{project}: {handovers} handover(s) in {days} day(s): indexed, no problems` |  |  | Printed by `check` when everything is indexed and valid. Placeholders: {project}, {handovers}, {days}. |
| `handovers.msg_check_summary` | `{project}: {problems} problem(s), {stale} day brief(s) out of date` |  |  | Summary line of `check` with problems. Placeholders: {project}, {problems}, {stale}. |
| `handovers.msg_index_done` | `{project}: {handovers} handover(s) in {days} day(s); rebuilt {rebuilt} day(s)...` |  |  | Summary of an index run. Placeholders: {project}, {handovers}, {days}, {rebuilt}, {written}, {problems}. |
| `handovers.msg_loose_title` | `Without a handover` |  |  | Heading of the day-brief section that lists session directories with snapshots or companion files but no handover. |
| `handovers.msg_more` | `... and {n} more (run `ah-engine handovers check`)` |  |  | The last advisory line when more problems exist. Placeholder: {n}. |
| `handovers.msg_more_items` | `+{n} more` |  |  | Shown after a cut list. Placeholder: {n}. |
| `handovers.msg_no_project` | `no .anti-hall/handovers directory found from here upward` |  |  | Printed when no handovers directory is found from the working directory upward. |
| `handovers.msg_not_indexed` | `no handover index yet; run `{cmd}` first` |  |  | Printed by `search` when the project has handovers but no sidecars yet. Placeholder: {cmd}. |
| `handovers.msg_problem_line` | `[{severity}] {code} {where} {detail}` |  |  | One problem line of the advisory and of `check`. Placeholders: {severity}, {code}, {where}, {detail}. |
| `handovers.msg_recorded` | `{n} problem(s) recorded in the index` |  |  | Detail of the advisory line that stands for problems recorded in the index by the last run. Placeholder: {n}. |
| `handovers.msg_script_failed` | `the handover-hygiene script could not run ({why}); the plugin's engine/logic/...` |  |  | Printed by the CLI when the handover script could not answer. Placeholder: {why}. |
| `handovers.msg_search_hit` | `{score}  {id}  {title}\n    {path}\n    {snippet}` |  |  | One search hit. Placeholders: {score}, {id}, {title}, {path}, {snippet}. |
| `handovers.msg_search_howto` | ``ah-engine handovers search <words> [date:2026-09] [session:ID] [decision:WOR...` |  |  | The search hint in the root brief. |
| `handovers.msg_search_none` | `no handover matches: {query}` |  |  | Printed when a search finds nothing. Placeholder: {query}. |
| `handovers.msg_search_total` | `{shown} of {total} match(es)` |  |  | Heading of the hit list. Placeholders: {shown}, {total}. |
| `handovers.msg_usage` | `usage: ah-engine handovers index [--project DIR] [--registered] [--force] \| c...` |  |  | Printed for `ah-engine handovers` without a known verb. |
| `handovers.named_re` | `^HANDOVER-([A-Za-z][A-Za-z0-9_.-]*)\.md$` |  |  | A named handover file (group 1 = its name), e.g. HANDOVER-ENGINE-LANES.md. |
| `handovers.next_heading_re` | `^(?:next action\|next actions\|next step\|next steps\|what to do next\|resume)\b` |  |  | A heading that opens the next-action section when the front matter has no Next action. |
| `handovers.none_text` | `(none)` |  |  | Shown for an empty field. |
| `handovers.open_decisions_heading_re` | `^(?:open\|pending\|undecided)\b.*\b(?:decisions?\|questions?)\b` |  |  | A heading whose bullets are decisions still open (checked before the decisions pattern). |
| `handovers.other_kind` | `other` |  |  | The kind of a .md file in a session directory that is neither a handover, a snapshot nor a known companion. |
| `handovers.path_ref_re` | `\.anti-hall/handovers/[^\s`)\]'"<>*…]+\.md` |  |  | A handover path mentioned in the text (checked: it must resolve). Matched globally. |
| `handovers.predecessor_re` | `^\s*(?:Predecessor\|Previous handover\|Continues\|Resumes)\s*:\s*`?([^\s`)]+)` |  |  | A body line that names the predecessor handover (group 1 = the path). |
| `handovers.preferences_heading_re` | `\b(?:owner rules\|owner preferences\|preferences\|standing rules\|rules in force)\b` |  |  | A heading whose bullets are the owner's standing rules and preferences. |
| `handovers.preferences_max` | `24` |  |  | Most preferences kept per handover. |
| `handovers.problems_max` | `12` |  |  | Most problems kept per handover entry. |
| `handovers.project_flag` | `--project` |  |  | The flag that names the project root (default: the working directory, then its parents). |
| `handovers.read_max_bytes` | `262144` |  | bytes | Most bytes read from one handover; a larger file is indexed from this head and flagged `too_large`. |
| `handovers.refs_max` | `60` |  |  | Most references (handover paths and relative links) kept and checked per handover. |
| `handovers.registered_flag` | `--registered` |  |  | The flag that makes `index` walk every registered project instead of one. |
| `handovers.registry_file` | `.anti-hall/handover-projects.json` |  |  | The registry of project roots whose handovers the scheduled job keeps indexed, relative to the home directory. A SessionStart in a project with handovers registers it. |
| `handovers.registry_max` | `64` |  |  | Most projects the registry keeps; the least recently seen is dropped past this. |
| `handovers.registry_refresh_ms` | `3600000` |  | ms | A project already in the registry is re-recorded at most this often (the registry is a file in the home directory; a session start must not rewrite it every time). |
| `handovers.required_by_kind` | `2 entries` |  |  | Which problem codes apply to which entry kind: a handover must carry front matter, a Situation and a Next action; a named handover (an addendum) needs only a Situation. |
| `handovers.root_brief` | `BRIEF.md` |  |  | File name of the root brief (a tree root: it references one brief per day). |
| `handovers.root_days_max` | `400` |  |  | Most days the root brief's table lists (newest first); the sidecar lists them all. |
| `handovers.root_sidecar` | `BRIEF.json` |  |  | File name of the root brief's machine-readable sidecar. |
| `handovers.root_title` | `Handover brief (root)` |  |  | Title of the root brief. |
| `handovers.run_budget_ms` | `20000` |  | ms | How long one index run keeps rebuilding days before it stops and reports `partial` (the rest is picked up by the next run). It must stay under the script's time limit (script.time_limit_by_check). |
| `handovers.schema` | `1` |  |  | Version of the sidecar layout. A sidecar of another version is rebuilt (never read as current). |
| `handovers.search_filters` | `9 entries` |  |  | Filter prefixes a query may use (`date:2026-09`, `from:`, `to:`, `session:`, `kind:`, `file:`, `commit:`, `decision:`, `pref:`): the prefix to the entry field it narrows. |
| `handovers.search_limit` | `20` |  |  | Default number of search hits. |
| `handovers.search_limit_max` | `200` |  |  | Most search hits whatever the flag asks. |
| `handovers.search_snippet_chars` | `160` |  |  | Characters of context a hit's snippet shows around the first match. |
| `handovers.search_weights` | `10 entries` |  |  | How much a query word is worth in each field of an entry (a word must match somewhere; the score ranks the hits). |
| `handovers.setting` | `6 entries` |  |  | Where the on/off switch is read from (guards.handoverHygiene, default on). Off silences the SessionStart advisory and the scheduled job; the CLI verbs still work. |
| `handovers.severities` | `16 entries` |  |  | Severity of each problem code: error, warn or info. The SessionStart advisory counts error and warn; info problems (a missing front matter or Situation, a legacy layout) show in `check` and in the briefs only. |
| `handovers.sig_keys` | `64 items` |  |  | The settings that decide what a brief contains. A change to any of them (or to handovers.schema) rebuilds every day brief on the next index run, so a tuned rule never leaves stale briefs behind. |
| `handovers.situation_heading_re` | `^(?:situation\|executive summary\|summary\|current state\|where we are\|state of p...` |  |  | A heading that opens the situation section when the front matter has no Situation. |
| `handovers.snapshot_handover_re` | `^(\S+\.md)(?:\s\|$)` |  |  | The line of a snapshot that names the newest handover it was taken beside (group 1 = the path). |
| `handovers.snapshot_head_bytes` | `4096` |  | bytes | Bytes read from the top of a PreCompact snapshot (it only needs its title line and the handover it names). |
| `handovers.snapshot_heading_re` | `^newest handover\b` |  |  | The heading of a snapshot section that holds the handover path. |
| `handovers.snapshot_re` | `^PRECOMPACT-(\d+)\.md$` |  |  | A PreCompact snapshot file (group 1 = its number). A snapshot is attached to the handover it names, never indexed as a handover. |
| `handovers.snapshot_stamp_re` | `(\d{4}-\d{2}-\d{2}T[\d:.]+Z)` |  |  | The timestamp in a snapshot's title line (group 1). |
| `handovers.summary` | `SessionStart advisory (engine-only, no Node twin): reports handovers that are...` |  |  | One-line description of the handover-hygiene check in the generated reference. |
| `handovers.summary_chars` | `600` |  |  | Longest situation or next-action text kept in an entry (characters; longer is cut with an ellipsis). |
| `handovers.title_prefix_re` | `^Handover\s*[:—–-]\s*(?=\S)` |  |  | A leading `Handover` word that is dropped from a title when something follows it. |
| `handovers.verbs` | `index, check, search` |  |  | The sub-commands of `ah-engine handovers`. |
| `handovers.walk_up_max` | `8` |  |  | How many parent directories are tried when the working directory has no handovers directory (a session started in a sub-directory). |

## Messages

Text lives in `messages.toml` (and `git.toml` for the git check's block messages); keys and what they are for:

| Key | When it is shown |
|---|---|
| `msg.advisory_defaults` | Appended to the degraded notice when defaults fell back to another layer. Placeholders: {count} fallbacks in the window, {last} the last one's detail. |
| `msg.advisory_degraded` | Once-per-session notice that the engine is running below full strength. Placeholders: {restarts} self-restarts and {fallbacks} fallbacks to Node in the last {mins} minutes, {log} the event-log path. |
| `msg.advisory_env` | Once-per-session advisory for an environment-class failure. Placeholder: {hint}. |
| `msg.advisory_permanent` | Once-per-session advisory for a permanent failure; nothing is ever filed automatically. Placeholders: {reason}, {diagnostics}. |
| `msg.backup_exists` | A backup destination already holds a snapshot. Placeholder: {path}. |
| `msg.cli_no_daemon` | Printed to stderr when a control command finds no daemon. |
| `msg.cli_not_running` | Printed in place of a report when no daemon is running (`--json` output carries running=false). |
| `msg.cli_planned` | Printed when a planned command is run. Placeholders: {command}, {decision}. |
| `msg.cli_unknown` | Printed to stderr for an unknown command. Placeholder: {command}. |
| `msg.cli_usage` | Usage text for an unknown or missing subcommand. The command list is generated from the command registry. |
| `msg.client_bad_frame` | Exchange failure when the reply frame was damaged. Placeholder: {err}. |
| `msg.client_bad_socket` | Exchange failure when the socket path is not a socket owned by this user. |
| `msg.client_connect` | Exchange failure when connecting failed. Placeholder: {err}. |
| `msg.client_fallback_unavailable` | Printed on stderr when stdin cannot safely be sent to the engine and the Node fallback cannot answer. Guard events exit 2; non-guard events exit 0 with this note. |
| `msg.client_io` | Exchange failure for another I/O step. Placeholders: {what}, {err}. |
| `msg.client_no_fallback_guard` | Printed on stderr (exit dispatch.defer_exit) when the legacy `hook` command gets a guard event, the engine cannot answer and no Node fallback was given: the caller must run the Node hook, never take silence as an allow. |
| `msg.client_timeout` | Exchange failure when the hard deadline passed. |
| `msg.client_what_stat` | The step named in msg.client_io when the socket path cannot be examined (a permission or path error, not a missing socket). |
| `msg.diagnostics` | Secret-scrubbed diagnostic block attached to a permanent-failure advisory. Placeholders: {version}, {os}, {arch}, {code}, {log}. |
| `msg.dispatch_stdin_spool` | Reason (event log and stderr, with dispatch.defer_exit) when the hook's stdin payload cannot be read, or an over-cap payload cannot be spooled for the Node hooks. Placeholder: {err}. |
| `msg.dispatch_stdin_utf8` | Reason in dispatch.msg_fail_closed when a guard event's stdin payload is not valid UTF-8. |
| `msg.docs_checks_note` | Paragraph under the checks heading of the generated reference. |
| `msg.docs_intro` | Opening paragraph of the generated reference. |
| `msg.docs_rule_fields` | Paragraph listing the fields of a rule in the generated reference. |
| `msg.err_db_busy` | The storage writer queue is full. |
| `msg.err_db_journal` | The journal mode could not be set. Placeholder: {mode}. |
| `msg.err_db_schema` | A database was written by a newer build of the engine. Placeholders: {db}, {found}, {known}. |
| `msg.err_db_sql` | A storage operation failed inside SQLite. Placeholder: {err}. |
| `msg.err_db_timeout` | A write did not commit in time; it may still commit, and its write id makes a retry harmless. |
| `msg.err_db_unavailable` | Storage is not open. |
| `msg.err_mailbox_full` | The project mailbox is full. |
| `msg.err_mesh_backend` | A mesh reader refused a store directory whose BACKEND marker is not sqlite. Placeholders: {path}, {backend}. |
| `msg.err_mesh_missing` | A mesh reader was pointed at a store file that does not exist (a reader never creates one). Placeholder: {path}. |
| `msg.err_mesh_range` | A store value is an integer JavaScript cannot represent exactly, which Node's reader rejects too. Placeholder: {value}. |
| `msg.err_mesh_sql` | A mesh read failed in SQLite or hit a value it cannot read the way Node does. Placeholder: {err}. |
| `msg.err_mesh_usage` | The mesh command was called without a verb or without --db. |
| `msg.err_not_dir` | A state or socket directory is not a plain directory. Placeholder: {path}. |
| `msg.err_path_io` | An OS error on a path. Placeholders: {path}, {err}. |
| `msg.err_rules_action` | A rule has an unknown action. Placeholders: {index}, {action}. |
| `msg.err_rules_check` | A rule names an unknown check. Placeholders: {index}, {name}. |
| `msg.err_rules_json` | Rules file is not valid JSON. Placeholder: {err}. |
| `msg.err_rules_pattern` | A rule's pattern is not a valid regular expression. Placeholders: {index}, {id}, {err}. |
| `msg.err_rules_version` | Rules file version is not supported. Placeholder: {version}. |
| `msg.err_too_many_keys` | The project key limit was reached. |
| `msg.err_too_many_projects` | The project partition limit was reached. |
| `msg.err_unknown_check` | `check` was asked for a check that is not registered. Placeholder: {name}. |
| `msg.err_unknown_verb` | A project operation verb is not known. Placeholder: {verb}. |
| `msg.err_value_too_large` | A stored value exceeds the per-value cap. |
| `msg.err_wrong_owner` | A state or socket directory belongs to another user. Placeholders: {path}, {found}, {expected}. |
| `msg.exit_reason_handoff` | Drain reason for a handoff to a newer build or a stop request. |
| `msg.exit_reason_idle` | Drain reason for idle exit (only when daemon.idle_exit_s is set). |
| `msg.exit_reason_rss` | Drain reason for exceeding the memory cap. |
| `msg.exit_reason_sigterm` | Drain reason for SIGTERM. |
| `msg.exit_reason_stall` | Drain reason for a stalled loop. |
| `msg.exit_reason_stuck` | Drain reason for a stuck worker. |
| `msg.failure_stall` | Failure reason when the accept loop stalled. |
| `msg.failure_stuck` | Failure reason when a worker is stuck. |
| `msg.fallback_read_error` | Printed on stderr when reading the Node fallback's output failed part-way, so the output is incomplete and no decision exists (exit 1). |
| `msg.fallback_read_timeout` | Printed on stderr when the Node fallback finished but its output could not be read to the end in time, so no decision exists. In the legacy direct forced-fallback path this exits 2 for guard events and 0 for non-guard events; otherwise it exits 1. |
| `msg.fallback_signal` | Printed on stderr when the Node fallback was killed by a signal, so no decision exists. In the legacy direct forced-fallback path this exits 2 for guard events and 0 for non-guard events; otherwise it exits 1. Placeholder: {signal}. |
| `msg.hint_disk_full` | Self-fix hint when the disk is full (error code os28). |
| `msg.hint_fds` | Self-fix hint when the process ran out of file descriptors. |
| `msg.hint_memory` | Self-fix hint when the OS killed or starved the daemon. Placeholder: {env_mem}. |
| `msg.hint_socket_path` | Self-fix hint when the socket path is too long. Placeholder: {env_dir}. |
| `msg.hint_state_dir` | Self-fix hint when the state directory is not writable or not private. Placeholders: {state_dir}, {env_dir}. |
| `msg.impact_no_routing` | Status shown in place of a model-routing saving figure while no routing events are recorded. |
| `msg.log_accept_error` | Event-log detail (rate-limited) when the daemon's accept failed for a reason other than nothing pending. Placeholders: {code} (os<n>), {err}. |
| `msg.log_accept_recovered` | Event-log detail when the daemon accepts a connection again after accept failures (logged then, because a full descriptor table can keep the failure's own log line from being written). Placeholders: {n}, {code} (os<n> of the last failure). |
| `msg.log_bind_fail` | Start-failure detail when binding the socket fails. Placeholders: {path}, {err}. |
| `msg.log_budget` | Log detail when a rule evaluation exceeded its CPU budget. |
| `msg.log_crash` | Log detail when a daemon is found dead without a clean exit. Placeholder: {pid}. |
| `msg.log_daemon_killed` | Log detail when the daemon was killed by a signal while starting. |
| `msg.log_daemon_spawn_failed` | Event-log detail (kind spawn_fail, code os<n>) when the client could not start the daemon (fork or exec failed: EAGAIN, ENOMEM, a missing executable). Placeholder: {err}. |
| `msg.log_fallback_read_error` | Log detail when reading the Node fallback's stdout or stderr failed part-way. |
| `msg.log_fallback_read_timeout` | Log detail when the Node fallback finished but its stdout or stderr was still open at the deadline. |
| `msg.log_fallback_signal` | Log detail when the Node fallback was killed by a signal (out of memory, a crash). |
| `msg.log_fallback_timeout` | Log detail when the Node fallback did not finish in time. |
| `msg.log_lock_fail` | Start-failure detail when the lock file cannot be opened. Placeholders: {path}, {err}. |
| `msg.log_lock_no_daemon` | Log detail when a starting daemon gives up on the singleton lock while no daemon answers on the socket. Placeholders: {path}, {pid} (the pid the lock file names, may be empty). |
| `msg.log_not_socket` | Start-failure detail when something other than a socket sits at the socket path. Placeholder: {path}. |
| `msg.log_operator_reset` | Log detail for `reset`. |
| `msg.log_panic` | Log and failure detail when a request handler panicked. |
| `msg.log_proc_spawn` | Event-log detail (rate-limited, code proc_spawn_failed) when a helper process could not be started. Placeholders: {what} (the program), {code} (os<n>), {err}. |
| `msg.log_proc_timeout` | Event-log detail (rate-limited, code proc_timeout) when a helper process ran past its timeout and its process group was killed. Placeholders: {what}, {ms}. |
| `msg.log_proc_unread` | Event-log detail (rate-limited, code proc_unread) when a helper exited but its output did not reach end of file within proc.read_grace_ms (a process it left behind held a pipe); its group was killed. Placeholder: {what}. |
| `msg.log_pruned` | Event-log detail when maintenance forgets old applied write ids. Placeholder: {n}. |
| `msg.log_restored` | Event-log detail of a restore. Placeholders: {from}, {kept}. |
| `msg.log_rss` | Log detail when the daemon is over its memory cap. Placeholders: {rss}, {cap}. |
| `msg.log_stall` | Log detail when the accept loop stalled. |
| `msg.log_start` | Log detail for a daemon start. Placeholders: {version}, {pid}, {rlimit}. |
| `msg.log_stuck` | Log detail when a worker is stuck. Placeholder: {i}. |
| `msg.metrics_quantile_note` | Printed with every latency histogram: how to read its percentiles. |
| `msg.no_price_for_model` | Said by `impact` for a model that is not in the price table, instead of a guessed figure. Placeholder: {model}. |
| `msg.reason_breaker` | Recorded reason when the client breaker opens. Placeholders: {n}, {secs}, {why}. |
| `msg.reason_crashloop` | Recorded reason when the daemon keeps dying. Placeholders: {n}, {secs}. |
| `msg.regex_literal_invalid` | Panic text when a literal regular expression in the source does not compile (a bug the tests catch). |
| `msg.reply_budget` | ERR body when evaluation exceeded the CPU budget. |
| `msg.reply_defer` | ERR body when a built-in check defers to the Node hook. |
| `msg.reply_internal` | ERR body after a contained panic. |
| `msg.reply_malformed` | ERR body for a hook payload that is not JSON. |
| `msg.reply_missing_cwd` | ERR body for a project request without a cwd. |
| `msg.reply_read_deadline` | ERR body when the client did not deliver its request in time. |
| `msg.reply_read_error` | ERR body for a socket read error. |
| `msg.reply_test_panic` | Panic text of the test-only `panic` verb. |
| `msg.reply_too_large` | ERR body for an oversize request. |
| `msg.reply_unknown_request` | ERR body for a request the daemon does not understand. |
| `msg.restore_daemon_busy` | A restore could not stop the daemon or take its lock in time. |
| `msg.restore_damaged` | A snapshot database failed its integrity check. Placeholders: {path}, {check}. |
| `msg.restore_no_hot` | A snapshot directory has no hot.db. Placeholder: {path}. |
| `msg.schedule_agent_planned` | Result of an agent-targeted job until mailbox delivery exists (D45). |
| `msg.schedule_daemon_gone` | An in-process job found the daemon gone (it was exiting). |
| `msg.schedule_failed` | Event-log detail of a failed run. Placeholders: {job}, {detail}. |
| `msg.schedule_snapshot_failed` | The metrics snapshot job could not keep its snapshot. |
| `msg.schedule_timeout` | Detail of a run that passed its timeout. |
| `msg.schedule_unknown_action` | A job names an action the scheduler does not know; the job is ignored. Placeholders: {job}, {action}. |
| `msg.schedule_unknown_job` | `schedule run` named a job that is not configured. Placeholder: {job}. |
| `msg.spool_damaged` | Quarantine reason for spool bytes that are not a valid record. |
| `msg.spool_full` | Printed by `proj` when the spool is full, so the write was not kept. |
| `msg.spool_io` | Printed by `proj` when the spool could not be written. Placeholder: {err}. |
| `msg.spool_rewrite_failed` | Log detail when the spool could not be replaced after a drain. The old spool stays whole (the records already applied are applied again, harmlessly, by their write ids). Placeholders: {err} the OS error, {n} unapplied records still in it. |
| `msg.spool_spooled` | Printed by `proj` when the engine could not take a write and it was spooled. Placeholder: {id}. |
| `msg.state_open` | Status text for a breaker that is open. Placeholder: {secs}. |
| `msg.state_stopped` | Status text for a crash-loop stop that is active. Placeholder: {secs}. |
| `msg.storage_off` | Status value when the daemon runs without storage (unit tests, or before it opened). |
| `msg.storage_ok` | Status value when the databases are open. |
| `msg.tel_err` | A telemetry value was refused. Placeholders: {code} (stable short code) and {field} (the field, when one is named). |
| `msg.tel_loss_window` | Printed with the telemetry summary: how much a crash can lose. Placeholder: {flush_ms}. |
| `msg.tel_net_status` | Status shown with the model-routing saving once routing decisions exist. Placeholders: {n} decisions, {days} days. |
| `msg.tel_no_db` | The telemetry rollup cannot run: storage did not open. |
| `git.msg_commit_credit` | Block: an inline commit message with an AI self-credit. |
| `git.msg_commit_file_credit` | Block: a commit message read from a file or heredoc with an AI self-credit. |
| `git.msg_commit_file_jev` | Block: Jev judged a commit message read from a file or heredoc to credit an AI assistant (paraphrased). |
| `git.msg_commit_jev` | Block: Jev judged an inline commit message to credit an AI assistant (paraphrased). |
| `git.msg_creating_credit` | Block: a commit-creating command with an AI self-credit line. Placeholder: {sub}. |
| `git.msg_creating_credit_elsewhere` | Block: a commit-creating command is chained with another git/gh command that carries the AI self-credit. Placeholders: {sub}, {elsewhere} (the carrying command, e.g. `gh pr create`). |
| `git.msg_delete_ref` | Block: remote ref deletion. Placeholder: {skip}. |
| `git.msg_find_push` | Block: a push through find -exec. |
| `git.msg_force_push` | Block: a force push. |
| `git.msg_gh_credit` | Block: a gh pr, issue or release body or title carries an AI self-credit. |
| `git.msg_gh_credit_elsewhere` | Block: a gh pr, issue or release command is chained with another git/gh command that carries the AI self-credit. Placeholder: {elsewhere} (the carrying command, e.g. `git commit`). |
| `git.msg_gh_jev` | Block: Jev judged a gh body or title to credit an AI assistant (paraphrased). |
| `git.msg_handover` | Block: a commit that includes a session handover. Placeholders: {shown}, {skip}. |
| `git.msg_launcher` | Block: a write into the launcher directory. |
| `git.msg_push_cmdsubst` | Block: a push argument produced by command substitution. |
| `git.msg_reused_message` | Block: a reused commit message carries an AI self-credit. Placeholder: {origin}. |
| `git.msg_runner_no_subcommand` | Block: a runner with git and no subcommand beside a force or delete flag. Placeholder: {runner}. |
| `git.msg_runner_placeholder` | Block: a runner placeholder stands for the command or subcommand beside a force or delete flag. |
| `git.msg_runner_push` | Block: a push through xargs or parallel. Placeholder: {runner}. |
| `git.msg_trailer_remap` | Block: a trailer remap to an AI self-credit key. |
| `msg.cfg_err_hooks` | A hook configuration section ([events.*], [entries.*]) is invalid (D87). |
| `msg.cfg_err_io` | A config file could not be read. |
| `msg.cfg_err_not_object` | settings.json is valid JSON but not an object. |
| `msg.cfg_err_parse` | A config file is not valid TOML or JSON. |
| `msg.cfg_err_range` | A numeric config value is outside the setting's bounds. |
| `msg.cfg_err_type` | A config value has the wrong type. |
| `msg.cfg_err_unknown` | A config file names a setting the engine does not have. |
| `msg.cfg_err_unsupported` | A TOML value has a type that settings cannot hold. |
| `msg.cfg_invalid_cli` | Printed by `config validate` when the file is invalid (the reason follows). |
| `msg.cfg_log_applied` | Event-log detail when a new config version became active. |
| `msg.cfg_log_pending` | Event-log detail when an edit changed settings that only apply at the next start. |
| `msg.cfg_show_error` | The last rejected config edit, in `config` output. |
| `msg.cfg_show_file` | One config file line of `config` output. |
| `msg.cfg_show_header` | First line of `config` output. |
| `msg.cfg_show_pending` | Settings waiting for a restart, in `config` output. |
| `msg.cfg_show_setting` | One setting line of `config` output. |
| `msg.cfg_state_absent` | A config file does not exist. |
| `msg.cfg_state_present` | A config file exists. |
| `msg.cfg_type_boolean` | Type name used in config errors. |
| `msg.cfg_type_integer` | Type name used in config errors. |
| `msg.cfg_type_list` | Type name used in config errors. |
| `msg.cfg_type_other` | Type name used in config errors for a value of another kind. |
| `msg.cfg_type_string` | Type name used in config errors. |
| `msg.cfg_type_table` | Type name used in config errors. |
| `msg.cfg_valid` | Printed by `config validate` when the file is valid. |
| `msg.cfg_validate_usage` | Printed by `config validate` without a file. |
| `msg.jev_bad_default_mode` | Why the shipped integration table is invalid: an integration lists a mode that is not on, shadow or off. Placeholder: id. |
| `msg.jev_endpoint_ignored` | Printed once per process to stderr when a test endpoint override is refused because its host is not loopback; it never names the URL or a key. |
| `msg.jev_generic_key_bound` | Why a vendor-less Jev key option was not used: it is bound to the other vendor. Placeholders: bound, option, vendor. |
| `msg.jev_key_multiline` | Why a Jev key file was refused: its content is not a single line without whitespace. |
| `msg.jev_key_not_file` | Why a Jev key file was refused: it is not a regular file. |
| `msg.jev_key_outside_roots` | Why a Jev key file was refused: it does not really live under one of the allowed directories. |
| `msg.jev_key_too_large` | Why a Jev key file was refused: it is larger than the limit. Placeholder: max. |
| `msg.jev_key_unreadable` | Why a Jev key file was refused: it could not be read. |
| `msg.jev_no_home` | Printed by `ah-engine jev` when the home directory variable is not set, because the settings and the log live under it. |
| `msg.jev_unknown_question_type` | Why a Jev request was refused: its question type is neither noul nor choice. Placeholder: kind. |
| `msg.jev_usage` | Usage line of `ah-engine jev`. |
| `msg.jev_triage_defer` | Said on stderr when `jev triage` leaves the run to the Node worker (it would need the Anthropic API, which only Node calls); the exit code is dispatch.defer_exit. |
| `msg.cli_usage_restore` | The usage line of `restore`. |
| `msg.cli_usage_schedule_run` | The usage line of `schedule run`. |
| `msg.client_what_timeout` | What the client was doing when a socket option could not be set (the {what} of msg.client_io). |

## Metrics

| Name | Kind | Unit | Labels | What it counts |
|---|---|---|---|---|
| `accept_errors` | counter | errors | code | Accept calls that failed for a reason other than nothing pending (EMFILE, ENFILE, ENOBUFS, ENOMEM), by OS error code (os<n>); each one backs the accept loop off for daemon.accept_error_backoff_ms. |
| `budget_trips` | counter | evaluations |  | Evaluations cut off by the per-request CPU budget. |
| `bus_dropped` | gauge | notifications |  | Pub/sub notifications a full subscriber queue could not take since the daemon started (the data stays in SQLite). |
| `bus_published` | gauge | notifications |  | Pub/sub notifications delivered to subscriber queues since the daemon started. |
| `busy_replies` | counter | requests |  | Requests answered BUSY (queue full or rate limited), which made the client fall back. |
| `check_calls` | counter | runs | check | Built-in check runs, by check. |
| `check_decisions` | counter | runs | check, decision | Built-in check outcomes, by check and decision (allow, block, advisory, defer). |
| `check_latency_us` | histogram | us | check | Wall time of a built-in check run, by check. |
| `db_archive_bytes` | gauge | bytes |  | Size of archive.db (0 until it is first used). |
| `db_archive_wal_bytes` | gauge | bytes |  | Size of archive.db's write-ahead log. |
| `db_commits` | gauge | commits |  | hot.db transactions the writer committed since the daemon started; fewer than db_writes means group commit is sharing syncs. |
| `db_hot_bytes` | gauge | bytes |  | Size of hot.db. |
| `db_hot_wal_bytes` | gauge | bytes |  | Size of hot.db's write-ahead log. |
| `db_writes` | gauge | writes |  | Writes carried by those transactions since the daemon started. |
| `dispatch_checks` | counter | entries | event, check, answer | Built-in check entries the dispatcher sent to the daemon, by event, check and answer (decided, or defer = its Node hook ran instead) (D58). |
| `dispatch_entries` | counter | entries | event, entry, outcome, cfg | What the dispatcher's plan did to each table entry of an event it asked the daemon about (D87): ran, skipped_predicate, skipped_max_rules, skipped_budget, shadowed or off, by event, entry, outcome and the hash of the non-default hook configuration the plan was made under (`default` when none). |
| `errors` | counter | requests |  | Requests answered ERR. |
| `hook_calls` | counter | requests | event | Hook requests served, by hook event. |
| `hook_latency_us` | histogram | us | event | Wall time to serve a hook request inside the daemon, by hook event. |
| `inject_emitted` | counter | blocks | cut | Gated hook blocks passed on whole, by cut (injection gate). |
| `inject_emitted_bytes` | counter | bytes | cut | Bytes of the gated hook blocks that were injected (whole blocks, and the short keepalive forms), by cut. |
| `inject_gate_bytes` | gauge | bytes |  | Estimated memory of the injection gate state. |
| `inject_gate_evictions` | gauge | items |  | Sessions or blocks the gate dropped to stay within its bounds since the daemon started. |
| `inject_gate_sessions` | gauge | sessions |  | Sessions the injection gate holds state for (bounded by inject_gate.max_sessions). |
| `inject_gate_slots` | gauge | blocks |  | Gated blocks remembered across all sessions. |
| `inject_keepalive` | counter | blocks | cut | Unchanged gated blocks passed on again because their keepalive turn came, by cut. |
| `inject_suppressed` | counter | blocks | cut | Gated hook blocks the model already held and the gate dropped, by cut. |
| `inject_suppressed_bytes` | counter | bytes | cut | Bytes the gate kept out of the context (the dropped blocks, and what a keepalive form saved over the whole block), by cut. |
| `maintain_last_ms` | gauge | ms |  | When the last maintenance run happened, in ms since the epoch (0: never). |
| `maintain_runs` | gauge | runs |  | Maintenance runs recorded in hot.db (D26). |
| `panics` | counter | panics |  | Request-handler panics that were contained. |
| `queue_depth` | gauge | connections |  | Connections waiting for a worker when status or metrics is read. |
| `rejected_peers` | counter | connections |  | Connections dropped because the peer uid was not ours. |
| `requests` | counter | requests |  | Requests the daemon handled, any type. |
| `rss_kb` | gauge | KB |  | Resident set of the daemon, sampled when status or metrics is read. |
| `rule_hits` | counter | matches | action | Regex rule matches, by action (deny, warn, context). |
| `schedule_missed` | counter | runs | job | Runs that caught up a missed window or skipped it, by job (D33). |
| `schedule_runs` | counter | runs | job, status | Scheduled runs that finished, by job and status (ok, failed, timeout, planned, skipped) (D33). |
| `slow_replies` | counter | replies |  | Replies finished after their client's deadline had passed: slow but healthy (the client fell back to Node), counted apart from errors. |
| `spool_applied` | counter | writes |  | Spooled writes the daemon applied (D24). |
| `spool_quarantined` | counter | records |  | Spool records moved to quarantine: damaged, or refused for good by the store (D24). |
| `tel_dropped` | counter | samples | reason | Telemetry samples or events that could not be kept: slots (a counter table was full) or ring (an event was overwritten before it was flushed). |
| `tel_events` | counter | invocations | k, h, e, o | Telemetry invocations recorded, by kind (k), hook or check (h), hook event (e) and outcome (o) (D78). |
| `tel_injected_bytes` | counter | bytes | h, e | Bytes injected into model context, by hook or check (h) and hook event (e). The whole-hook rows (h=hook) add up to the total; a per-check row is attribution inside it (D78). |
| `tier_bytes` | gauge | bytes |  | Bytes charged to the in-memory layer's budget (D25). |
| `tier_evictions` | gauge | items |  | Items dropped from memory to stay within the budget since the daemon started (SQLite keeps them). |
| `tier_expired` | gauge | items |  | Items dropped from memory because their TTL ended since the daemon started (SQLite keeps them). |
| `tier_hits` | gauge | reads |  | Key-value reads answered from memory since the daemon started. |
| `tier_items` | gauge | items |  | Active key-value items held in memory (D22). |
| `tier_misses` | gauge | reads |  | Key-value reads that went to SQLite since the daemon started. |
| `uptime_s` | gauge | s |  | Seconds since the daemon started. |
| `jev_calls` | counter | calls | backend, mode | Jev decisions asked for, by backend (jev, cache or baseline-only) and mode. |
| `jev_changed` | counter | decisions |  | Decisions in on mode where Jev changed the outcome (always an added block or advisory). |
| `jev_cooldowns` | counter | calls |  | Jev calls skipped because a vendor's circuit breaker was open. |
| `jev_cost_micro_usd` | counter | micro-usd |  | Cost of fresh Jev calls in millionths of a US dollar, as reported by the vendor or priced from the reported tokens; a cache hit adds nothing. Never an estimate of what a judge call would have cost. |
| `jev_latency_us` | histogram | us |  | Latency of fresh Jev network calls. |
| `jev_timeouts` | counter | calls |  | Jev calls that ran out of their time budget. |
| `jev_verdicts` | counter | decisions | id, verdict | What each Jev decision did, by integration and verdict: added or changed (an on-mode outcome moved), would-change (a shadow call that would have moved it), none (Jev agreed with the baseline) or no-answer (it failed or was skipped). |

## Impact kinds

| Kind | What it records |
|---|---|
| `advisory` | A check returned an advisory instead of a decision (for example the handover-budget notice). |
| `block` | A check or rule blocked a call. The reason is the check or rule id. |
| `context` | A context-action rule matched and injected text for the agent. |
| `fallback` | The engine could not or would not answer (a check deferred, or the request failed) and the client ran the Node hook instead. |
| `route` | A model-routing decision at agent spawn (D78/D86). Route events carry requested_model, parent_model, task_class, recommended_tier, selected_model, outcome and spawn_key; legacy route rows without selected_model are read with a deterministic fallback. A forced cheaper-model delegation also records a delegate event with spawn_key, requested_model, selected_model and task_class, never prompt or description text. |
| `warning` | A warn-action rule matched and added a warning for the agent. |

## Error codes

Environment-class codes get a plain self-fix hint; any other code is a permanent failure that asks for an issue.

| Codes | Class | Self-fix hint |
|---|---|---|
| `os28` | env | the disk is full (no space left); free some space, then it recovers by itself |
| `os13`, `os1`, `unsafe_dir` | env | ah-engine's state directory is not writable or not private; fix its ownership (chown to yourself) and permissions (chmod 700 ~/.anti-hall/ah-engine), or set AH_ENGINE_DIR to a directory you own |
| `os36`, `os22`, `path_too_long` | env | the socket path is too long; set AH_ENGINE_DIR to a shorter path (e.g. /tmp/ah) |
| `os24`, `os23` | env | the process ran out of file descriptors; raise `ulimit -n` or close other programs |
| `os12`, `sig9` | env | the OS killed or starved ah-engine (low memory); close other programs or lower AH_ENGINE_MEM_MB |
