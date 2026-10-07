# ah-engine reference

This reference is generated from the engine's registries and shipped defaults by `ah-engine docs --format md`; do not edit it by hand. A test fails when it differs from the generated text.

## Commands

Every command accepts `--json`. Read-only commands never change state.

| Command | Arguments | Read-only | Status | What it does |
|---|---|---|---|---|
| `backup` | `[--to <dir>]` | no | implemented | Make a consistent online snapshot of hot.db and archive.db with SQLite's backup API, scrubbed of secrets, in backups/<ms> or the given directory; prints its manifest. |
| `check` | `<name>` | yes | implemented | Run one built-in check in-process on a hook payload from stdin (used by the parity harness). |
| `config` | `[validate <file>]` | yes | implemented | Show the effective config and where each value comes from, or validate a config file; versions, rollback and export are planned (D18, they need the config database). |
| `ctl` | `<ping\|reload\|stop\|status>` | no | implemented | Send a control verb to the daemon: ping, reload, stop or status. |
| `docs` | `[--format md]` | yes | implemented | Print the generated reference: every command, setting, metric, impact kind, check and error code. |
| `gen-hooks` | `--host claude\|codex [--kind hooks\|registry\|list\|map]` | yes | implemented | Print a file generated from the dispatch table (D87): the thin hooks.json (one trigger per event), the per-hook registry, the wrapper's fallback list or its fallback map, for one host. |
| `hook` | `[--fallback <hook.js>] \| --event <Event> [--tool <Tool>] [--host claude\|codex] [--fallback-map <file>]` | no | implemented | The hook client: read one hook payload from stdin, ask the daemon, print the answer; falls back to the Node hook given by --fallback. With --event it is the per-event dispatcher: it runs every hook entry hooks.json registers for that event and tool, built-in checks in the engine and the rest as their Node hooks (--fallback-map overrides their commands), and combines the results the way the host would. |
| `impact` | `[--kind <kind>] [--project <hash>] [--window <7d>]` | yes | implemented | Show everything the engine affected: blocks by reason, warnings, context injected, fallbacks, and labelled savings estimates, including the NET of model-routing savings minus what injection and Jev cost (D77). |
| `jev` | `<ask\|status\|scrub>` | no | implemented | The optional Jev lane (D34-D38): `ask` reads JSON requests, one per stdin line, and prints each decision (a real call when Jev is enabled and keyed), `status` prints the resolved settings and each integration's mode without any key, `scrub` redacts secrets from JSON strings read one per stdin line. |
| `maintain` | `` | no | implemented | Size control (D26): move consumed messages, expired key values and old impact events from hot.db to archive.db, prune derived bookkeeping, checkpoint both WALs and VACUUM both databases; prints a report. |
| `metrics` | `[--check <name>] [--rollup <resolution> [--since <s>]]` | yes | implemented | Show the engine's metrics: counters, gauges and latency percentiles, optionally for one check; with --rollup, the stored rollups of one resolution (minute, hour), optionally for the last --since seconds. |
| `proj` | `<cwd> <put\|take\|len\|set\|setex\|get> [args]` | no | implemented | Per-project state in hot.db: a mailbox (put, take, len) and key-value pairs (set, setex with a TTL in seconds, get); the partition is derived from the cwd. |
| `reset` | `` | no | implemented | Clear the client breaker, the crash-loop stop and the failure record. |
| `restore` | `<snapshot-dir>` | no | implemented | Restore a snapshot directory: first keep the current state as an unscrubbed pre-restore snapshot (never deleted), stop the daemon, then swap the databases. |
| `schedule` | `<list\|run <job>\|history> [--job <name>] [--limit <n>]` | no | implemented | The scheduler (D33): `list` the jobs with their next run and last result, `run <job>` now (waits briefly for the result), or show the run `history` from hot.db; adding and removing jobs from the command line is planned (D33), today they come from schedules.toml and schedules.json. |
| `serve` | `` | no | implemented | Run the resident daemon in the foreground (the client starts it detached when needed). |
| `status` | `` | yes | implemented | Show the daemon's state: version, uptime, memory, counters, breaker and crash-loop state, rules, and a headline summary of what it did. |
| `stop` | `` | no | implemented | Ask the daemon to drain and exit. |
| `telemetry` | `[summary\|events\|rollup] [--window <7d>] [--kind <k>] [--limit <n>]` | no | implemented | Telemetry (D78): `summary` (invocations, outcomes, latency and injected bytes per hook and check), `events` (routing, spawn, Jev and spill events), `rollup` (move complete days into archive.db and apply the retention). Local only. |
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
| `verify-first` | UserPromptSubmit: the short rotating verify-first reminder, deduplicated per session; DevSwarm Primary sessions stay on Node (port of verify-first.js). |
| `idle-agent-sweep` | UserPromptSubmit: lists agents that finished but were never stopped or closed, and the call that ends each (port of idle-agent-sweep.js). |
| `emit-dedupe-reset` | SessionStart: marks a context loss in the session's emit-dedupe state so the next UserPromptSubmit blocks are re-emitted (port of emit-dedupe-reset.js). |

## Settings

Defaults ship in `defaults/*.toml`; a numeric setting with an environment variable can be overridden for one process.


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

### engine.toml / daemon

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `daemon.accept_poll_ms` | `200` |  | ms | Accept-loop poll interval while serving. |
| `daemon.bucket_cap` | `4096` |  |  | Most distinct keys one token-bucket map tracks; idle full buckets are dropped first and unknown keys are refused under a key flood. |
| `daemon.busy_write_ms` | `100` |  | ms | Write timeout for the BUSY reply sent from the accept loop. |
| `daemon.drain_grace_ms` | `1000` |  | ms | After a drain starts, a worker or loop that has not finished in this long is cut off. |
| `daemon.drain_poll_ms` | `20` |  | ms | Accept-loop poll interval while draining. |
| `daemon.eval_budget_us` | `200000` | `AH_ENGINE_EVAL_BUDGET_US` | us | Per-request thread CPU budget for rule evaluation; 0 turns the budget off. |
| `daemon.forced_exit_code` | `75` |  |  | Exit status of a forced drain exit (sysexits EX_TEMPFAIL, 75); the next client call starts a fresh daemon. |
| `daemon.idle_check_ms` | `1000` |  | ms | How often the watchdog compares the last request time with idle_exit_s. |
| `daemon.idle_exit_s` | `0` | `AH_ENGINE_IDLE_EXIT_S` | s | Seconds without any request after which the daemon exits; 0 keeps it resident (default, D7: the scheduler and mailbox must keep running with no session open). |
| `daemon.lock_poll_ms` | `10` |  | ms | Poll interval while waiting for the singleton lock. |
| `daemon.lock_wait_ms` | `1500` |  | ms | How long a starting daemon waits for an outgoing (version-handoff) daemon to release the singleton lock. |
| `daemon.max_request` | `1048576` | `AH_ENGINE_MAX_REQUEST` | bytes | Largest request the daemon reads; the client sends nothing larger (it falls back instead). |
| `daemon.mem_mb` | `512` | `AH_ENGINE_MEM_MB` | MB | Data-segment limit applied with setrlimit; 0 = none. It is a ceiling against runaway allocation, not a budget (the RSS cap is the budget), and Linux enforces it on thread stacks, so it must exceed daemon.workers times git.stack_mb plus headroom or a check thread cannot start. macOS accepts the call but does not enforce it. |
| `daemon.nice` | `5` | `AH_ENGINE_NICE` |  | `nice` increment applied to the daemon process. |
| `daemon.project_burst` | `400` | `AH_ENGINE_PROJECT_BURST` |  | Token-bucket burst per project. |
| `daemon.project_rps` | `100` | `AH_ENGINE_PROJECT_RPS` |  | Sustained requests per second allowed per project; 0 = unlimited. |
| `daemon.queue` | `16` | `AH_ENGINE_QUEUE` |  | Connections that may wait for a worker; beyond this the daemon answers BUSY and the client falls back. |
| `daemon.read_ms` | `1000` | `AH_ENGINE_READ_MS` | ms | Total time a client has to deliver its request. |
| `daemon.read_poll_ms` | `100` |  | ms | Socket read timeout slice while collecting a request (the total is read_ms). |
| `daemon.rss_cap_kb` | `49152` | `AH_ENGINE_RSS_CAP_KB` | KB | Resident-set cap; above it the daemon drains and exits cleanly and the next call starts a fresh one; 0 = none. |
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

### engine.toml / health

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `health.advised_cap` | `500` |  |  | When more session stamps than this exist, stamps older than advised_expire_s are removed. |
| `health.advised_expire_s` | `172800` |  | s | Age after which a session stamp may be removed. |
| `health.advisory_ttl_ms` | `3600000` |  | ms | A recorded failure older than this no longer produces an advisory. |
| `health.context_events` | `PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SubagentStart` |  |  | Hook events whose output carries `additionalContext`; other events use `systemMessage` when an advisory is merged. |
| `health.crashy_kinds` | `crash, panic, start_fail, watchdog, rss` |  |  | Event kinds that count toward the crash-loop threshold. |
| `health.diag_lines` | `8` |  |  | Event-log lines included in the diagnostic block of a permanent-failure advisory. |
| `health.error_codes` | `3 entries, 3 entries, 3 entries, 3 entries, 3 entries` |  |  | Error-code classification: environment-class codes get a plain self-fix hint (a message key); every other code is a permanent failure that asks for an issue. |
| `health.event_text_max` | `300` |  | chars | Longest kind, code or detail written to one log line (newlines and tabs become spaces). |
| `health.log_cap` | `65536` |  | bytes | Event log size above which it is trimmed to its last log_keep_lines lines. |
| `health.log_keep_lines` | `200` |  |  | Lines kept when the event log is trimmed. |
| `health.pid_probe` | `ps, -p, {pid}, -o, command=` |  |  | Command used to read a process's command line when checking whether a pid is a live engine: the program, then its arguments with `{pid}` substituted. |
| `health.rss_probe` | `ps, -o, rss=, -p, {pid}` |  |  | Command used to read this process's resident set where /proc is unavailable (macOS): the program, then its arguments with `{pid}` substituted. |
| `health.scrub_patterns` | `7 items` |  |  | Patterns removed from anything that goes into a diagnostic: each item is [regex, replacement]. Order matters. |
| `health.serve_arg` | `serve` |  |  | Subcommand a daemon is started with; also how a live engine is recognised in the process list. |

### engine.toml / hook

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `hook.event_keys` | `hook_event_name, hookEventName, event` |  |  | Payload fields that can carry the event name, tried in order (Claude Code and Codex send `hook_event_name`). |
| `hook.warn_prefix` | `anti-hall warning: ` |  |  | Prefix of a `warn` rule's message in agent-visible output. |

### engine.toml / paths

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `paths.base_dir` | `.anti-hall` |  |  | Directory under the home directory that holds all anti-hall state. |
| `paths.fallback_tmp` | `/tmp` |  |  | Last-resort base for the short-path socket when TMPDIR is unset or too long. |
| `paths.lock_suffix` | `.lock` |  |  | Suffix appended to the socket path for the singleton lock file. |
| `paths.private_dir_prefix` | `anti-hall-` |  |  | Prefix of the private per-user directory that holds a short-path socket (the uid is appended). |
| `paths.rules_file` | `rules.json` |  |  | Rules file name inside the state directory. |
| `paths.short_socket_ext` | `.sock` |  |  | Extension of a short-path socket file (its name is a stable hash of the state directory). |
| `paths.socket_file` | `e.sock` |  |  | Socket file name inside the state directory. |
| `paths.socket_max_len` | `100` |  | bytes | Longest socket path used as is; unix socket paths are capped at 104 bytes on macOS (108 on Linux), so this leaves headroom. |
| `paths.state_dir` | `ah-engine` |  |  | Engine state directory name inside base_dir (D53). |

### engine.toml / request_env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `request_env.allow` | `34 items` |  |  | The environment variables the client forwards with every request, and the only ones the daemon evaluates a check with (never its own environment). A trailing `*` matches a prefix. PATH is read by scan-throttle. DISABLE_ANTIHALL_DEVSWARM and DEVSWARM_REPO_ID decide whether DevSwarm is active, CLAUDE_CONFIG_DIR locates the host's transcripts and NODE_TEST_CONTEXT marks a test run (inbox-read-guard, orch-on-spawn, verify-first-orch). DEVSWARM_SOURCE_BRANCH (non-empty in a DevSwarm child workspace) is read by verify-first-subagent. verify-first also reads DEVSWARM_REPO_ID, DEVSWARM_SOURCE_BRANCH and DISABLE_ANTIHALL_DEVSWARM to see whether the session could be a DevSwarm Primary. CLAUDE_PLUGIN_OPTION_* carry the plugin options the guards' switch chain reads. The rest are what the git check needs to see the client's git, never the daemon's: the `gitcache.bypass_env` names, XDG_CONFIG_HOME (locates git's config), the GIT_CONFIG_* variables (GIT_CONFIG_COUNT with its KEY_n/VALUE_n pairs travel together, since git exits 128 on a COUNT without its KEY_0; PARAMETERS and NOSYSTEM likewise), GIT_EXEC_PATH (locates git's helpers) and the object-store variables GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES and GIT_NO_REPLACE_OBJECTS. LANG and LC_* are not forwarded: the git calls discard stderr and read only config data from stdout. |
| `request_env.line_prefix` | `E ` |  |  | Prefix of the request line that carries the forwarded environment as one JSON object. |
| `request_env.max_bytes` | `65536` |  | bytes | Largest forwarded environment (sum of names and values); a client whose allowed variables exceed it forwards none of them, and the checks that read the environment then see an empty one. |

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
| `git.child_poll_ms` | `1` |  | ms | Poll interval while a git child process runs. |
| `git.child_read_ms` | `500` |  | ms | Time allowed to collect the output of a child process after it exits. |
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
| `git.hd_sinks_basic` | `/dev/null, /dev/stdout, /dev/stderr` |  |  | Device paths a heredoc may be written to. |
| `git.hd_sinks_fd` | `/dev/fd/1, /dev/fd/2` |  |  | Extra descriptor paths accepted as data sinks in redirects. |
| `git.hd_specs` | `10 entries` |  |  | Option grammar per git subcommand for heredoc-fed commands: s = short flags, v = short flags with a value, o = short flags with an optional value, l / big_l / big_o = long flags (none / required value / optional value), num = numeric -<n> allowed, strict = unknown options are not data, read = also accept the shared read-only option sets, l_extra = more long flags. |
| `git.heredoc_git_msg_subs` | `commit, tag, notes, merge` |  |  | git subcommands that take a message from a heredoc. |
| `git.heredoc_safe_verbs` | `21 items` |  |  | Commands a data heredoc may be fed to without being treated as a shell script. |
| `git.jev_file` | `.anti-hall/jev.json` |  |  | Jev configuration file, relative to the home directory. |
| `git.jev_settings` | `8 entries` |  |  | Names the Jev add-block consult is switched by: the global enable env var, the per-integration env var, the settings.json integration key and mode value. |
| `git.label_allowed` | `Allowed here: ` |  |  | Label of the allowed-here line. |
| `git.label_instead` | `Do instead: ` |  |  | Label of the remedy line. |
| `git.label_override` | `Override (only if the user explicitly asked): ` |  |  | Label of the override line. |
| `git.label_why` | `Why: ` |  |  | Label of the reason line. |
| `git.launcher_dir_pattern` | `(?i)\.anti-hall[\\/]+bin(?:[\\/]\|$)` |  |  | Pattern (case-insensitive) that recognises a path inside the plugin launcher directory. |
| `git.launcher_hops` | `10` |  |  | Most symlink hops followed when resolving a dangling launcher link. |
| `git.max_chain` | `10` |  |  | Longest git alias chain followed before giving up. |
| `git.max_nest` | `1500` |  |  | Nesting limit for the substitution scanners (JS overflows its stack far deeper and its caller then scans the raw text, which is what a bail-out means here). |
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
| `git.plugin_option_prefix` | `CLAUDE_PLUGIN_OPTION_` |  |  | Prefix of the environment variables the host sets from plugin options. |
| `git.push_cmdsubst_heredoc_note` | ` Heredoc bodies are scanned as shell even when a script only reads them as te...` |  |  | Appended to the remedy of the push_cmdsubst block when the command contains a heredoc. |
| `git.push_long_opts` | `27 items` |  |  | Long options of the push subcommand, for expanding unambiguous abbreviations such as --force-w. |
| `git.redirect_words` | `11 items` |  |  | Shell redirection operators, which are not command words. |
| `git.setting_alias_resolve` | `4 entries` |  |  | Switch for git alias and shell definition resolution. |
| `git.setting_git_guard` | `4 entries` |  |  | Master switch of the check: settings.json section and key, environment variable and plugin-option name. |
| `git.setting_handover_guard` | `4 entries` |  |  | Switch for the handover-commit guard. |
| `git.setting_heredoc_data` | `4 entries` |  |  | Switch for data-heredoc masking. |
| `git.setting_reused_message` | `4 entries` |  |  | Switch for the reused-commit-message check. |
| `git.settings_file` | `.anti-hall/settings.json` |  |  | Settings file, relative to the home directory. |
| `git.shell_verbs` | `bash, sh, zsh, dash, ksh, ash` |  |  | Shell programs whose `-c` argument is itself a script to scan. |
| `git.skip_command` | `node '{script}' skip {key}` |  |  | Command that records a skip for a guard; {script} is the quoted script path and {key} the guard id. |
| `git.skip_file` | `.anti-hall/skip.json` |  |  | Skip file, relative to the home directory (a skipped guard is allowed until its expiry time). |
| `git.skip_script` | `scripts/devswarm.js` |  |  | Script, relative to the plugin directory, that records a skip for a guard. |
| `git.stack_mb` | `64` |  | MB | Stack size of the thread the check runs on: the parsers recurse on nested input, so a pathological command must not overflow a daemon worker. |
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
| `command.check_summary` | `command-guard (PreToolUse on Bash): heavy-command and Bash-write delegation g...` |  |  | One-line description of the command check for the generated reference. |
| `command.cloud_binaries` | `gcloud, gh, kubectl` |  |  | Cloud CLIs with a read-only inspect exemption (command-guard.js CLOUD_BINARIES). |
| `command.cloud_mutating_verbs` | `17 items` |  |  | Words that disqualify the gh/kubectl read-only exemption (command-guard.js CLOUD_MUTATING_VERBS). |
| `command.cloud_readonly_verbs` | `describe, list, get, view` |  |  | First words after gh/kubectl that read only (command-guard.js CLOUD_READONLY_VERBS). |
| `command.control_keyword_prefix` | `^\s*(?:(?:do\|then\|else\|if\|while\|until\|!)\s+)+` |  |  | Leading shell keywords stripped before a segment is judged (command-guard.js CONTROL_KEYWORD_PREFIX_RE). |
| `command.defer_path_parts` | `inbox, store` |  |  | If the command or the payload cwd has one of these as a path component (lower-cased; split at slashes, backslashes, blanks and shell punctuation), the engine defers: the raw DevSwarm inbox/store read guard denies only paths whose first component under the DevSwarm root is one of them (lib/devswarm-inbox-paths.js classifyDevswarmPath). |
| `command.defer_substrings` | `devswarm.js, stash` |  |  | If the command, lower-cased with quotes and backslashes removed, contains any of these, the engine defers: the DevSwarm subagent-mailbox guard needs the literal script name (devswarm.js) and the git-stash guard a `stash` word, and both need state the engine does not mirror. |
| `command.devswarm_cli_verbs` | `hivecontrol, devswarm` |  |  | If any segment the DevSwarm read/send guards scan has one of these as its effective verb, the engine defers (command-guard.js DEVSWARM_CLI_VERBS). |
| `command.gcloud_boolean_flags` | `--quiet, --uri` |  |  | gcloud flags without a value the read-only grammar accepts (command-guard.js GCLOUD_BOOLEAN_FLAGS). |
| `command.gcloud_inspect_verbs` | `describe, list, get, view, read` |  |  | gcloud command-path verbs that read only (command-guard.js GCLOUD_INSPECT_VERBS). |
| `command.gcloud_logging_group` | `logging` |  |  | The only gcloud group whose `read` verb is read-only (command-guard.js `g.path[last] !== 'logging'`). |
| `command.gcloud_refused_path` | `^(?:access\|ssh\|scp\|run\|sign\|print-[^\n\r]*\|attach-[^\n\r]*\|detach-[^\n\r]*\|ad...` |  |  | gcloud command-path words that refuse the read-only grammar (command-guard.js GCLOUD_REFUSED_PATH_RE). |
| `command.gcloud_value_flags` | `8 items` |  |  | gcloud flags whose separated value the whole-command read-only form accepts (command-guard.js GCLOUD_VALUE_FLAGS). |
| `command.gh_api_field_flags` | `-f, -F, --field, --raw-field` |  |  | gh api options that send a request body (command-guard.js isHeavyGhSegment and GH_GQL_FIELD_FLAGS). |
| `command.gh_api_mutating_methods` | `POST, PATCH, PUT, DELETE` |  |  | gh api methods that are heavy (command-guard.js GH_API_MUTATING_METHODS). |
| `command.gh_gql_bool_flags` | `--paginate, --slurp, --silent, -i, --include, --verbose` |  |  | gh api graphql options without a value (command-guard.js GH_GQL_BOOL_FLAGS). |
| `command.gh_gql_value_flags` | `8 items` |  |  | gh api graphql options that take a value (command-guard.js GH_GQL_VALUE_FLAGS). |
| `command.gh_mutating_subcommands` | `6 entries` |  |  | gh group and subcommand pairs that are heavy (command-guard.js GH_MUTATING_SUBCOMMANDS, plus `workflow run`). |
| `command.git_fetch_dangerous_flags` | `--prune, -p, --prune-tags, --force, -f` |  |  | git fetch options that rewrite or delete local refs (command-guard.js GIT_FETCH_DANGEROUS_FLAGS). |
| `command.git_global_value_opts` | `8 items` |  |  | git global options that take a value (command-guard.js GIT_GLOBAL_VALUE_OPTS). |
| `command.git_heavy_subs` | `push, pull, clone` |  |  | git subcommands that are always heavy (command-guard.js isHeavyGitSegment). |
| `command.heavy_patterns` | `7 items` |  |  | Patterns over the quote-neutralized segment that make it heavy (command-guard.js HEAVY_PATTERNS). |
| `command.heavy_verbs` | `63 items` |  |  | Effective verbs that are always heavy in the main thread (command-guard.js HEAVY_VERBS). |
| `command.inline_other_flags` | `-e, -E` |  |  | The inline-code flags of perl, ruby and node (command-guard.js inlineCodeBody). |
| `command.inline_python_flags` | `-c` |  |  | The inline-code flag of the python interpreters (command-guard.js inlineCodeBody). |
| `command.inline_verbs` | `python, python3, perl, ruby, node` |  |  | Interpreters whose inline code is scanned for literal write targets (command-guard.js INLINE_VERBS). |
| `command.inline_write_markers` | `open, File, createWriteStream, .write(` |  |  | If inline interpreter code contains any of these, it may name a literal write target and the engine defers (a superset of command-guard.js INLINE_OPEN_RE, INLINE_PERL_OPEN3_RE, INLINE_PERL_OPEN2_RE, INLINE_WRITEFILE_RE and INLINE_FILE_WRITE_RE, which all need one of them). |
| `command.light_exceptions` | `17 items` |  |  | Patterns over the raw segment (and the segment without a leading `timeout N`) that make it light (command-guard.js LIGHT_EXCEPTIONS, the entries without a negative lookahead; a trailing `(?=\s\|$)` is written as `(?:\s\|$)`). |
| `command.light_exceptions_neg` | `3 entries, 3 entries, 3 entries` |  |  | LIGHT_EXCEPTIONS entries of the form HEAD`\b(?![^\n]*NOT)`: the segment is light when some match of `head` ends (at a word boundary, right after the text `end`) where `not_after` does not match before the end of that line (jev-report.js, doctor.js and `go env`). |
| `command.max_classify_len` | `65536` |  |  | Commands longer than this many characters are deferred to the Node hook (command-guard.js MAX_CLASSIFY_LEN: the Node guard switches to a head/tail scan above it). |
| `command.max_depth` | `3` |  |  | Nesting depth of inline shells, eval and command substitutions the heavy and write scans follow (command-guard.js `d < 3`). |
| `command.nice_value_flags` | `-n, --adjustment` |  |  | nice options that take a value (command-guard.js effectiveVerb). |
| `command.node_eval_deny` | `8 items` |  |  | Patterns that make a `node -e` payload unsafe (command-guard.js NODE_EVAL_UNSAFE_RE, NODE_EVAL_BRACKET_ACCESS_RE and the inline denials of isSafeNodeEvalPayload). |
| `command.node_eval_flags` | `-e, --eval` |  |  | node options whose next word is inline code (command-guard.js isSafeNodeEval). |
| `command.node_fs_method_call` | `(?:\brequire\(\s*['"]fs['"]\s*\)\|\bfs)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(` |  |  | An fs API call in a `node -e` payload; group 1 is the method (command-guard.js NODE_FS_METHOD_CALL_RE). |
| `command.node_fs_read_allowlist` | `readFileSync, readdirSync, statSync, existsSync, lstatSync` |  |  | fs methods a safe `node -e` payload may call (command-guard.js NODE_FS_READ_ALLOWLIST). |
| `command.node_script_ext` | `(?i)\.(?:js\|mjs\|cjs)$` |  |  | Script file extensions of node for the flagged-interpreter test (command-guard.js isFlaggedInterpreterScript). |
| `command.pattern_first_verbs` | `grep, sed, awk` |  |  | Verbs whose first operand is a pattern, blanked before the heavy patterns run (command-guard.js PATTERN_FIRST_VERBS). |
| `command.python_script_ext` | `(?i)\.py$` |  |  | Script file extension of the other interpreters for the flagged-interpreter test (command-guard.js isFlaggedInterpreterScript). |
| `command.script_check_interpreter` | `^(?:python[0-9.]*\|node\|ruby\|perl\|php)$` |  |  | Interpreters whose flagged script runs are heavy (command-guard.js SCRIPT_CHECK_INTERPRETER_RE). |
| `command.shell_verbs` | `bash, sh, zsh, dash, ksh, ash` |  |  | Shell programs whose `-c` argument or heredoc body is itself a script (lib/shell-scan.js SHELL_VERBS). |
| `command.sqlite_dangerous` | `(?i)(^\|[\s;])\.(shell\|system\|output\|once\|import\|save)\b\|\bATTACH\b` |  |  | sqlite3 dot-commands and SQL that write despite -readonly (command-guard.js SQLITE_DANGEROUS_RE). |
| `command.sudo_value_flags` | `16 items` |  |  | sudo options that take a value (command-guard.js effectiveVerb SUDO_VAL). |
| `command.taskpolicy_value_flags` | `-c, -t, -p` |  |  | taskpolicy options that take a value (command-guard.js effectiveVerb). |
| `command.test_keywords` | `7 items` |  |  | Words after which a `[[` or `((` is at command position, so its `<`/`>` are comparisons, not redirects (command-guard.js TEST_KEYWORDS). |
| `command.timeout_prefix` | `^\s*timeout\s+(?:-[ks]\s+\S+\s+\|-\S+\s+)*\d+[smhd]?\s+` |  |  | A leading `timeout [opts] N` stripped for the light-exception test (command-guard.js TIMEOUT_PREFIX_RE). |
| `command.timeout_value_flags` | `-s, --signal, -k, --kill-after` |  |  | timeout options that take a value (command-guard.js effectiveVerb). |
| `command.whole_command_clis` | `12 items` |  |  | CLIs whose whole-command read-only form (version query or gcloud read piped to a closed sink) is light (command-guard.js isWholeCommandReadOnlyForm and VERSION_CLI_RE). |
| `command.wrappers` | `18 items` |  |  | Words skipped when finding a segment's effective verb (command-guard.js WRAPPERS). |
| `command.write_target_unknowable` | `$`*?[]{}` |  |  | A write target containing one of these characters cannot be resolved and is skipped (command-guard.js resolveWriteTarget). |

### telemetry.toml / telemetry

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `telemetry.bytes_per_token` | `4` |  | bytes | Bytes of injected context counted as one token when `impact` estimates what injection costs. |
| `telemetry.default_window_days` | `7` |  | days | Window the `telemetry` and `impact` reports cover unless --window is given. |
| `telemetry.enabled` | `true` |  |  | Record telemetry (D78). Local only: nothing is uploaded. Off stops recording; what was already stored stays. |
| `telemetry.flush_ms` | `10000` | `AH_ENGINE_TELEMETRY_FLUSH_MS` | ms | How often the recorder's counters and events are stored in hot.db, and at shutdown. A kill -9 loses at most this much (the data recorded since the last flush). |
| `telemetry.hook_label` | `hook` |  |  | The `h` label of the whole-hook telemetry row (one per hook request, whatever checks ran inside it). |
| `telemetry.impact_persisted_note` | `stored in hot.db: totals and events survive a restart` |  |  | Printed with impact output when the events are stored in hot.db. |
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
| `spool.drain_ms` | `1000` | `AH_ENGINE_SPOOL_DRAIN_MS` | ms | Interval of the scheduled spool drain job (it also drains on start and before each project write). |
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
| `job.maintain` | `11 entries` |  |  | Size control (D26): move inactive rows to archive.db, prune derived data, checkpoint and VACUUM; runs as a subprocess so a timeout can kill it. |
| `job.metrics_snapshot` | `11 entries` |  |  | Keep a snapshot of the metrics counters and histograms in hot.db and its rollups in archive.db (D51). |
| `job.spool_drain` | `11 entries` |  |  | Apply writes clients spooled while the engine was down or busy (D24); the daemon also drains on start and before each project write. |
| `job.telemetry_rollup` | `11 entries` |  |  | Roll complete days of telemetry counters up into archive.db and apply the telemetry retention (D78); idempotent, so a repeat or a catch-up changes nothing. |

### schedules.toml / schedule

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `schedule.actions` | `maintain, backup, metrics_snapshot, spool_drain, telemetry_rollup, noop` |  |  | Actions a job may name; anything else in a user override is refused and logged. |
| `schedule.backup_ms` | `0` | `AH_ENGINE_BACKUP_MS` | ms | Interval of the backup job (D27); 0 (the default) turns it off. |
| `schedule.detail_max` | `2000` |  | chars | Longest result detail kept with a run in the history (longer text is cut). |
| `schedule.history_default` | `50` |  |  | Runs `schedule history` lists unless asked for more. |
| `schedule.maintain_ms` | `86400000` | `AH_ENGINE_MAINTAIN_MS` | ms | Interval of the maintain job (D26); 0 turns it off. |
| `schedule.run_wait_ms` | `5000` |  | ms | How long `schedule run <job>` waits for the run it asked for before answering that it is still running; below daemon.stuck_ms. |
| `schedule.subprocess_actions` | `maintain, backup` |  |  | Actions that run as an `ah-engine <action> --json` subprocess in its own process group, so a timeout kills it and everything it started. |
| `schedule.telemetry_rollup_ms` | `86400000` | `AH_ENGINE_TELEMETRY_ROLLUP_MS` | ms | Interval of the telemetry rollup job (D78); 0 turns it off. |
| `schedule.test_sleep_argv` | `sleep, 3600` |  |  | Command the test-only `test_sleep` action runs (accepted only when the test-hooks variable is set), to exercise timeouts. |
| `schedule.tick_ms` | `1000` | `AH_ENGINE_TICK_MS` | ms | Longest the ticker sleeps between checks; it wakes earlier when a job is due sooner or `schedule run` asks. |

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
| `guardkit.js_space` | `\t\n\x0b\x0c\r    -     　﻿` |  |  | Characters JavaScript treats as white space, written as the body of a regex character class; used to translate the JS escapes for white space exactly (Rust's own class differs: it has U+0085 and lacks U+FEFF). |
| `guardkit.line_terminators` | `\n\r  ` |  |  | Characters JavaScript's dot excludes, as the body of a regex character class. |
| `guardkit.lock_stale_ms` | `5000` |  |  | Age, in milliseconds, after which another process's lock on a window file or the metrics is considered abandoned and is taken over (the same limit for a live, a dead and an unknown holder). |
| `guardkit.lock_step_ms` | `5` |  |  | Pause between two attempts to take a held lock. |
| `guardkit.msg_head` | ` anti-hall · ` |  |  | Text between the icon and the guard name in every block or advisory message. |
| `guardkit.msg_labels` | `4 entries` |  |  | Labels of the optional lines of a block or advisory message. |
| `guardkit.plugin_config_keys` | `anti-hall, anti-hall@anti-hall` |  |  | Keys of the host settings file's pluginConfigs map under which this plugin's options may be stored, lowest priority first. |
| `guardkit.plugin_option_prefix` | `CLAUDE_PLUGIN_OPTION_` |  |  | Prefix of the environment variables the host sets from plugin options. |
| `guardkit.prune_stamp` | `.prune-stamp-{prefix}.json` |  |  | Name of the stamp file that throttles the pruning sweep; {prefix} is the state-file family. |
| `guardkit.prune_stamp_key` | `lastSweep` |  |  | Key of the stamp file that holds the time of the last sweep. |
| `guardkit.prune_throttle_ms` | `21600000` |  |  | Minimum time, in milliseconds, between two pruning sweeps of one state-file family (6 hours). |
| `guardkit.prune_ttl_ms` | `604800000` |  |  | How old, in milliseconds, a per-session state file must be before the pruning sweep removes it (7 days). |
| `guardkit.session_key_max` | `120` |  |  | Longest session key, in UTF-16 units, after the characters outside letters, digits, dot, underscore and hyphen are replaced (the Node state file name limit). |
| `guardkit.settings_file` | `.anti-hall/settings.json` |  |  | Settings file, relative to the home directory. |
| `guardkit.skip_all_key` | `all` |  |  | Key of the skip file that skips every guard not listed in destructive_guards. |
| `guardkit.skip_file` | `.anti-hall/skip.json` |  |  | Skip file, relative to the home directory (a skipped guard is allowed until its expiry time). |
| `guardkit.state_cap` | `4096` |  |  | How many per-session state entries the in-memory guard state keeps before it evicts the least recently written one. |
| `guardkit.state_dir_name` | `.anti-hall` |  |  | Name of the directory under the home directory that holds the per-session state files the Node guards share with the engine. |
| `guardkit.state_ext` | `.json` |  |  | Extension of a per-session state file. |
| `guardkit.tmp_suffix` | `tmp` |  |  | Suffix of the temporary file a state file is written through before the rename. |
| `guardkit.true_tokens` | `1, on, true, yes` |  |  | Environment or settings strings that mean on (compared after trimming and lower-casing). |

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
| `turn_gate.prefix` | `tg-` |  |  | File-name prefix of a turn-gate state file (the Node code also hands it to the pruning sweep as the family name). |
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

### jev.toml / env

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
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
| `jev.balance_body_bytes` | `2048` |  | bytes | How much of an error body is read to classify an out-of-balance answer; the body is never logged (Node: slice(0, 2048)). |
| `jev.balance_pattern` | `insufficient\|credit\|balance\|quota\|billing` |  |  | A 400 or 403 body matching this expression (case-insensitive) is an out-of-balance answer and makes the call fallback-eligible (Node: BALANCE_BODY_RE). |
| `jev.bool_false_tokens` | `0, off, false, no` |  |  | Words that read as false in an environment or settings value (Node: FALSE_TOKENS). |
| `jev.bool_true_tokens` | `1, on, true, yes` |  |  | Words that read as true in an environment or settings value (Node: TRUE_TOKENS). |
| `jev.breaker_cooldown_ms` | `300000` |  | ms | How long an open breaker skips its vendor before a probe is allowed (Node: BREAKER_COOLDOWN_MS). |
| `jev.breaker_threshold` | `3` |  |  | Consecutive fallback-eligible failures that open a vendor's breaker (Node: BREAKER_THRESHOLD). |
| `jev.cache_max_entries` | `500` |  |  | Answers the content-hash cache keeps; the oldest is evicted first (Node: CACHE_MAX_ENTRIES). |
| `jev.confidence_threshold` | `0.85` |  |  | Default minimum confidence for an answer to count as trusted, a decimal between 0 and 1 (Node: DEFAULT_CONFIDENCE_THRESHOLD). |
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
| `jev.legacy_file` | `jev.json` |  |  | The legacy Jev config file, relative to the anti-hall home directory, read below settings.json (Node: jev.json). |
| `jev.legacy_on_default` | `speculation, triage` |  |  | Integrations that predate the per-integration modes and stay on by default; consulted only for an id missing from the table (Node: LEGACY_ON_DEFAULT). |
| `jev.legacy_triage_key` | `triage` |  |  | Id of the integration that the pre-integrations-map triage switch (jev.triage set to false) still turns off. |
| `jev.log_file` | `logs/jev-assist.ndjson` |  |  | The decision log, relative to the anti-hall home directory, in the row shape the Node jev report reads (Node: logs/jev-assist.ndjson). |
| `jev.log_max_bytes` | `2097152` |  | bytes | Size at which the decision log rotates (Node: DECISION_LOG_MAX_BYTES). |
| `jev.log_off_rows` | `0` |  |  | 1 also logs a row for a call whose integration is off or whose Jev is disabled, as the Node client does; 0 (default) writes nothing and does no I/O at all for such a call, so a disabled Jev costs the hot path nothing. |
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
| `jev.settings_file` | `settings.json` |  |  | The unified settings file, relative to the anti-hall home directory (Node: settings.json). |
| `jev.settings_recheck_ms` | `2000` |  | ms | How often the settings files are re-checked for changes: at most one stat of each of the two files per window, taken by the first call after it elapses; between checks a call costs one clock read, so an off Jev stays off the hot path. |
| `jev.timeout_ms` | `1500` |  | ms | Per-call time budget for one Jev call, request, headers and body together (Node: DEFAULT_TIMEOUT_MS). |
| `jev.unlisted_mode` | `shadow` |  |  | Mode of an integration id that is not in the table (Node: every id that is not one of the legacy on-by-default ones). |

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
| `dispatch.gen_default_kind` | `hooks` |  |  | The file `gen-hooks` prints when `--kind` is not given. |
| `dispatch.generated_files` | `2 entries` |  |  | Per host and kind of generated file (hooks, registry, list, map), its path relative to the repository root. `tests/hooks_files.rs` requires each committed file to equal what `gen-hooks` prints and `ah-gen-fallback-list` writes them. |
| `dispatch.guard_events` | `PreToolUse, PermissionRequest, Stop, SubagentStop` |  |  | Events whose hooks can block (guards): PreToolUse and PermissionRequest decide a tool call (Claude ignores exit 2 on PermissionRequest, so a fail-closed exit 2 there is harmless, and the event stays listed so a hook registered on it later is guarded from the start), Stop and SubagentStop can refuse to let the agent finish. When the dispatcher cannot run the Node hook of such an event it fails CLOSED (exit 2 with dispatch.msg_fail_closed): a deferral there must never read as an allow (D74). |
| `dispatch.hooks_claude_PostToolUse` | `8 items` |  |  | The claude PostToolUse hook entries, in dispatch order. |
| `dispatch.hooks_claude_PostToolUseFailure` | `5 entries` |  |  | The claude PostToolUseFailure hook entries, in dispatch order. |
| `dispatch.hooks_claude_PreCompact` | `5 entries` |  |  | The claude PreCompact hook entries, in dispatch order. |
| `dispatch.hooks_claude_PreToolUse` | `21 items` |  |  | The claude PreToolUse hook entries, in dispatch order. |
| `dispatch.hooks_claude_SessionEnd` | `5 entries` |  |  | The claude SessionEnd hook entries, in dispatch order. |
| `dispatch.hooks_claude_SessionStart` | `16 items` |  |  | The claude SessionStart hook entries, in dispatch order. |
| `dispatch.hooks_claude_Stop` | `11 items` |  |  | The claude Stop hook entries, in dispatch order. |
| `dispatch.hooks_claude_SubagentStart` | `5 entries` |  |  | The claude SubagentStart hook entries, in dispatch order. |
| `dispatch.hooks_claude_TaskCompleted` | `5 entries` |  |  | The claude TaskCompleted hook entries, in dispatch order. |
| `dispatch.hooks_claude_TaskCreated` | `5 entries` |  |  | The claude TaskCreated hook entries, in dispatch order. |
| `dispatch.hooks_claude_UserPromptSubmit` | `8 items` |  |  | The claude UserPromptSubmit hook entries, in dispatch order. |
| `dispatch.hooks_codex_PostToolUse` | `5 entries, 5 entries, 5 entries, 5 entries` |  |  | The codex PostToolUse hook entries, in dispatch order. |
| `dispatch.hooks_codex_PreCompact` | `5 entries` |  |  | The codex PreCompact hook entries, in dispatch order. |
| `dispatch.hooks_codex_PreToolUse` | `9 items` |  |  | The codex PreToolUse hook entries, in dispatch order. |
| `dispatch.hooks_codex_SessionStart` | `15 items` |  |  | The codex SessionStart hook entries, in dispatch order. |
| `dispatch.hooks_codex_Stop` | `10 items` |  |  | The codex Stop hook entries, in dispatch order. |
| `dispatch.hooks_codex_UserPromptSubmit` | `8 items` |  |  | The codex UserPromptSubmit hook entries, in dispatch order. |
| `dispatch.in_process` | `0` | `AH_ENGINE_DISPATCH_IN_PROCESS` |  | Run the built-in checks inside the hook client (1) instead of asking the daemon (0, the default). |
| `dispatch.list_banner` | `# Generated from the dispatch table by `ah-engine gen-hooks`. Event rows are:...` |  |  | The first line of the generated fallback list. |
| `dispatch.list_empty_word` | `empty` |  |  | The word that marks an event row of the fallback list whose event has no table entry (a thin trigger only): the wrapper answers it with the neutral no-op. |
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
| `dispatch.msg_hook_spawn` | `the hook's command could not be started` |  |  | Event-log detail when a Node hook's command could not be started. |
| `dispatch.msg_hook_timeout` | `the hook ran past its timeout and was killed; the host discards a timed-out hook` |  |  | Event-log detail when a Node hook was still running at its timeout and was killed with its group (the host discards such a hook, so the call goes on). |
| `dispatch.msg_no_fallback` | `entry {id} deferred with no runnable Node command` |  |  | Reason logged when a deferred hook entry has no runnable Node command. |
| `dispatch.msg_panic` | `the dispatcher hit an internal error` |  |  | Reason given in dispatch.msg_fail_closed when the dispatcher panicked. |
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
| `dispatch.msg_why_spawn` | `hook {id} could not be started` |  |  | Reason in dispatch.msg_fail_closed when a guard event's Node hook could not be started. Placeholder: {id}. |
| `dispatch.payload_hash_checks` | `verify-first` |  |  | Built-in checks whose Node hook derives something from the exact stdin bytes (verify-first rotates its reminder by the SHA-1 of the whole payload): the dispatcher hands these the SHA-1 of the raw payload, computed only when one of them is selected. |
| `dispatch.plain_context_events` | `UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch` |  |  | Events on which plain-text stdout (exit 0) is context for the model (docs/KB-claude-code-hooks.md: UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch). When the dispatcher must deliver such text next to a hook's JSON it folds it into the merged additionalContext instead of moving it to stderr, where the model would not see it. |
| `dispatch.poll_ms` | `2` |  | ms | How often the dispatcher checks whether its Node hooks have finished. |
| `dispatch.read_ms` | `2000` |  | ms | How long the dispatcher waits for a finished Node hook's output pipes to drain. |
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
| `hooks.event_budget_ms` | `0` |  | ms | Default of `budget_ms` in `[events.<Event>]`: the wall budget of one occurrence of the event (0 = none). Once it has passed the engine starts no further entry, lets the ones already running finish within their own timeouts, and on a guard event fails closed as the fail-closed matrix defines. |
| `hooks.event_enabled` | `true` |  |  | Default of `enabled` in `[events.<Event>]`: whether the event is used at all (false is the same as mode = off). |
| `hooks.event_fields` | `enabled, mode, max_rules, budget_ms, order` |  |  | The fields an `[events.<Event>]` section may hold. |
| `hooks.event_max_rules` | `0` |  | entries | Default of `max_rules` in `[events.<Event>]`: the most entries evaluated per occurrence of the event (0 = all). The entries after the first max_rules, in order, are skipped and counted as skipped (max_rules). Not allowed above 0 on a guard event. |
| `hooks.event_mode` | `on` |  |  | Default of `mode` in `[events.<Event>]`: on (the event's entries decide), shadow (they run and are logged but never change the outcome) or off (the event is skipped and answered with the neutral no-op). |
| `hooks.event_order` | `` |  |  | Default of `order` in `[events.<Event>]`: entry ids that run and combine before the others, in this order (empty = the table's order). An id the event's table does not have is a config error. |
| `hooks.modes` | `on, shadow, off` |  |  | The values `mode` may take, in `[events.<Event>]` and `[entries.<id>]`. |
| `hooks.msg_budget` | `the event's budget passed before {id} could run` |  |  | Why a guard event fails closed when its budget_ms has passed before a built-in check's Node hook could start. Placeholder: {id}. |
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
| `hooks.reasons` | `11 entries` |  |  | Short reasons the config errors above quote in their {what} placeholder. |
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
| `emit_dedupe.tmp_suffix` | `.tmp` |  |  | Suffix of the temporary file a state write goes through before the atomic rename. |
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
| `verify_first.env_devswarm_disable` | `DISABLE_ANTIHALL_DEVSWARM` |  |  | Setting this variable to 1 turns the DevSwarm integration off. |
| `verify_first.env_devswarm_repo` | `DEVSWARM_REPO_ID` |  |  | The variable DevSwarm sets for a session it runs; a non-blank value makes the session a DevSwarm session in auto mode. |
| `verify_first.env_devswarm_source_branch` | `DEVSWARM_SOURCE_BRANCH` |  |  | The variable DevSwarm sets for a child workspace; a non-blank value means this session is a child, never a Primary. |
| `verify_first.event` | `UserPromptSubmit` |  |  | The hook event name in the check's output. |
| `verify_first.nudges` | `20 items` |  |  | The rotating reminder lines, in the order the Node hook lists them (the index is the payload digest modulo their number). |
| `verify_first.num_repeat_every` | `6 entries` |  |  | Where the repeat interval is read from (guards.injectionRepeatEvery, delivered turns, default 10); 0 repeats the reminder every turn. |
| `verify_first.prefix` | `VERIFY-FIRST: ` |  |  | Text in front of the rotating line. |
| `verify_first.summary` | `UserPromptSubmit: the short rotating verify-first reminder, deduplicated per ...` |  |  | One-line description of the verify-first check in the generated reference. |
| `verify_first.sw_dispatch_tier_text` | `4 entries` |  |  | Where the switch of the DevSwarm Primary dispatch-tier text is read from (devswarm.dispatchTierText, default on). |
| `verify_first.sw_supervisor_mode` | `6 entries` |  |  | Where the DevSwarm supervisor mode is read from (devswarm.supervisorMode: auto, on or off, default auto): the first condition of the Primary gate. |
| `verify_first.sw_turn` | `4 entries` |  |  | Where the on/off switch is read from (context.verifyFirstTurn, default on). |

## Messages

Text lives in `messages.toml` (and `git.toml` for the git check's block messages); keys and what they are for:

| Key | When it is shown |
|---|---|
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
| `msg.client_timeout` | Exchange failure when the hard deadline passed. |
| `msg.diagnostics` | Secret-scrubbed diagnostic block attached to a permanent-failure advisory. Placeholders: {version}, {os}, {arch}, {code}, {log}. |
| `msg.dispatch_stdin_spool` | Reason in dispatch.msg_fail_closed when an over-cap stdin payload cannot be spooled for Node hooks. Placeholder: {err}. |
| `msg.dispatch_stdin_spool_note` | Printed on stderr when a non-guard event has an over-cap stdin payload but the anonymous spool file could not be created. Placeholders: {event}, {err}. |
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
| `msg.fallback_read_timeout` | Printed on stderr when the Node fallback finished but its output could not be read to the end in time, so no decision exists. In the legacy direct forced-fallback path this exits 2 for guard events and 0 for non-guard events; otherwise it exits 1. |
| `msg.fallback_signal` | Printed on stderr when the Node fallback was killed by a signal, so no decision exists. In the legacy direct forced-fallback path this exits 2 for guard events and 0 for non-guard events; otherwise it exits 1. Placeholder: {signal}. |
| `msg.hint_disk_full` | Self-fix hint when the disk is full (error code os28). |
| `msg.hint_fds` | Self-fix hint when the process ran out of file descriptors. |
| `msg.hint_memory` | Self-fix hint when the OS killed or starved the daemon. Placeholder: {env_mem}. |
| `msg.hint_socket_path` | Self-fix hint when the socket path is too long. Placeholder: {env_dir}. |
| `msg.hint_state_dir` | Self-fix hint when the state directory is not writable or not private. Placeholders: {state_dir}, {env_dir}. |
| `msg.impact_no_routing` | Status shown in place of a model-routing saving figure while no routing events are recorded. |
| `msg.log_bind_fail` | Start-failure detail when binding the socket fails. Placeholders: {path}, {err}. |
| `msg.log_budget` | Log detail when a rule evaluation exceeded its CPU budget. |
| `msg.log_check_spawn` | Log detail when a built-in check's thread cannot start, so every command is deferred to Node. Placeholder: {err}. |
| `msg.log_crash` | Log detail when a daemon is found dead without a clean exit. Placeholder: {pid}. |
| `msg.log_daemon_killed` | Log detail when the daemon was killed by a signal while starting. |
| `msg.log_fallback_read_timeout` | Log detail when the Node fallback finished but its stdout or stderr was still open at the deadline. |
| `msg.log_fallback_signal` | Log detail when the Node fallback was killed by a signal (out of memory, a crash). |
| `msg.log_fallback_timeout` | Log detail when the Node fallback did not finish in time. |
| `msg.log_lock_fail` | Start-failure detail when the lock file cannot be opened. Placeholders: {path}, {err}. |
| `msg.log_not_socket` | Start-failure detail when something other than a socket sits at the socket path. Placeholder: {path}. |
| `msg.log_operator_reset` | Log detail for `reset`. |
| `msg.log_panic` | Log and failure detail when a request handler panicked. |
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
| `git.msg_creating_credit` | Block: a commit-creating command with an AI self-credit line. Placeholder: {sub}. |
| `git.msg_delete_ref` | Block: remote ref deletion. Placeholder: {skip}. |
| `git.msg_find_push` | Block: a push through find -exec. |
| `git.msg_force_push` | Block: a force push. |
| `git.msg_gh_credit` | Block: a gh pr, issue or release body or title carries an AI self-credit. |
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

## Metrics

| Name | Kind | Unit | Labels | What it counts |
|---|---|---|---|---|
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
