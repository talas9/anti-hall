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
| `hook` | `[--fallback <hook.js>]` | no | implemented | The hook client: read one hook payload from stdin, ask the daemon, print the answer; falls back to the Node hook given by --fallback. |
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
| `hook` | `V <client-version> <hook payload JSON>` | `OK <hook output JSON or empty> \| BUSY \| ERR <reason>` | A hook payload evaluated against the rules and built-in checks. The client half-closes after writing; the reply is always a framed OK, BUSY or ERR, and anything else makes the client run the Node hook. |
| `impact` | `CTL impact [kind=<kind>] [project=<hash>] [recent=<n>] [window=<7d>]` | `OK <impact JSON>` | The impact ledger report as JSON. |
| `metrics` | `CTL metrics [check=<name>] [rollup=<resolution> since=<s>]` | `OK <metrics JSON>` | All metric series as JSON, optionally for one check; with rollup, the stored rollups of one resolution instead. |
| `ping` | `CTL ping` | `OK pong <version> <pid>` | Liveness probe; also how a starting daemon checks that a live one already owns the socket. |
| `project` | `P <cwd> [W <write-id> ]<put\|take\|len\|set\|setex\|get> [args]` | `OK <value> \| ERR <reason> \| BUSY` | A per-project operation on hot.db; the daemon derives the partition from the cwd, so a request cannot name another project's key. A write is answered only after it commits; the optional write id makes it idempotent. |
| `reload` | `CTL reload` | `OK ok` | Re-read the rules file now (it is also re-read on SIGHUP and on change). |
| `schedule` | `CTL schedule list \| run job=<name> \| history [job=<name>] [limit=<n>]` | `OK <schedule JSON>` | The scheduler: the jobs and their schedules, run one now, or the run history. |
| `status` | `CTL status` | `OK <status JSON>` | The daemon's state as JSON, including a headline summary. |
| `stop` | `CTL stop` | `OK ok` | Drain and exit. |
| `telemetry` | `CTL telemetry [summary\|events] [window=<7d>] [kind=<k>] [limit=<n>]` | `OK <telemetry JSON>` | The telemetry summary or its events as JSON, including what the daemon has recorded but not yet flushed (D78). |

## Checks

A rule selects a built-in check with `"check": "<name>"`; the check's tables, limits and messages are in its defaults file.

Rule fields (JSON): `id`, `events`, `tools`, `field`, `pattern` (regex), `check`, `options`, `action` (deny, warn or context), `message`, `paths`.

| Check | What it does |
|---|---|
| `git` | Port of the git-guard hook: blocks force pushes, remote ref deletion, AI self-credit in commits, handover commits, launcher-directory writes and the same through aliases, runners and heredocs |
| `merge-side-pick` | Advisory: a push after a conflict was resolved by taking one side wholesale, with no test run since (port of merge-side-pick.js). |
| `ship-it-guard` | Opt-in plan gate: blocks edits to hard-risk files with no PLAN.md and advises on files a plan's phases do not declare (port of ship-it-guard.js). |
| `scan-throttle` | Advisory: recommends the background-throttled form of a user-configured heavy scan command (port of scan-throttle.js). |
| `coordinator-work-guard` | Main-thread work window: allows subagent Bash calls in the engine; the window itself (classification, counters, block) stays with the Node guard until the command-guard port lands (port of coordinator-work-guard.js). |
| `compact-declaration-guard` | Allows new work unless the current turn may hold a SAFE TO COMPACT declaration; a possible declaration defers to the Node guard, which decides and blocks (port of compact-declaration-guard.js). |

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
| `client.fallback_ms` | `8000` | `AH_ENGINE_FALLBACK_MS` | ms | The Node fallback hook is killed after this long (then plain allow, since it is unavailable). |
| `client.fallback_poll_ms` | `2` |  | ms | Poll interval while the Node fallback runs. |
| `client.fallback_read_ms` | `500` |  | ms | Time allowed to collect the fallback's stdout after it exits. |
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

### telemetry.toml / telemetry

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `telemetry.bytes_per_token` | `4` |  | bytes | Bytes of injected context counted as one token when `impact` estimates what injection costs. |
| `telemetry.default_window_days` | `7` |  | days | Window the `telemetry` and `impact` reports cover unless --window is given. |
| `telemetry.enabled` | `true` |  |  | Record telemetry (D78). Local only: nothing is uploaded. Off stops recording; what was already stored stays. |
| `telemetry.flush_ms` | `10000` | `AH_ENGINE_TELEMETRY_FLUSH_MS` | ms | How often the recorder's counters and events are stored in hot.db, and at shutdown. A kill -9 loses at most this much (the data recorded since the last flush). |
| `telemetry.hook_label` | `hook` |  |  | The `h` label of the whole-hook telemetry row (one per hook request, whatever checks ran inside it). |
| `telemetry.impact_persisted_note` | `stored in hot.db: totals and events survive a restart` |  |  | Printed with impact output when the events are stored in hot.db. |
| `telemetry.inherit_prefix` | `inherit:` |  |  | Prefix the Node routing log puts on a model name that was inherited from the parent rather than named; ignored when pricing. |
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
| `coordinator_work.codex_markers` | `turn_id, model` |  |  | Payload fields that, both non-empty strings, identify a Codex payload. |
| `coordinator_work.summary` | `Main-thread work window: allows subagent Bash calls in the engine; the window...` |  |  | One-line description of the coordinator-work-guard check in the generated reference. |

### small_guards.toml / guardkit

| Key | Default | Env override | Unit | What it is |
|---|---|---|---|---|
| `guardkit.claude_settings_file` | `.claude/settings.json` |  |  | The host's own settings file, relative to the home directory, where plugin options are stored. |
| `guardkit.destructive_guards` | `git-guard, devswarm-read-guard, git-stash-guard` |  |  | Guards that a broad skip of everything does not cover; they must be named in the skip file. |
| `guardkit.false_tokens` | `0, off, false, no` |  |  | Environment or settings strings that mean off (compared after trimming and lower-casing). |
| `guardkit.icons` | `6 entries` |  |  | Leading icon of a block or advisory message, by kind. |
| `guardkit.js_space` | `\t\n\x0b\x0c\r    -     　﻿` |  |  | Characters JavaScript treats as white space, written as the body of a regex character class; used to translate the JS escapes for white space exactly (Rust's own class differs: it has U+0085 and lacks U+FEFF). |
| `guardkit.line_terminators` | `\n\r  ` |  |  | Characters JavaScript's dot excludes, as the body of a regex character class. |
| `guardkit.msg_head` | ` anti-hall · ` |  |  | Text between the icon and the guard name in every block or advisory message. |
| `guardkit.msg_labels` | `4 entries` |  |  | Labels of the optional lines of a block or advisory message. |
| `guardkit.plugin_config_keys` | `anti-hall, anti-hall@anti-hall` |  |  | Keys of the host settings file's pluginConfigs map under which this plugin's options may be stored, lowest priority first. |
| `guardkit.plugin_option_prefix` | `CLAUDE_PLUGIN_OPTION_` |  |  | Prefix of the environment variables the host sets from plugin options. |
| `guardkit.session_key_max` | `120` |  |  | Longest session key, in UTF-16 units, after the characters outside letters, digits, dot, underscore and hyphen are replaced (the Node state file name limit). |
| `guardkit.settings_file` | `.anti-hall/settings.json` |  |  | Settings file, relative to the home directory. |
| `guardkit.skip_all_key` | `all` |  |  | Key of the skip file that skips every guard not listed in destructive_guards. |
| `guardkit.skip_file` | `.anti-hall/skip.json` |  |  | Skip file, relative to the home directory (a skipped guard is allowed until its expiry time). |
| `guardkit.state_cap` | `4096` |  |  | How many per-session state entries the in-memory guard state keeps before it evicts the least recently written one. |
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
| `msg.client_io` | Exchange failure for another I/O step. Placeholders: {what}, {err}. |
| `msg.client_timeout` | Exchange failure when the hard deadline passed. |
| `msg.diagnostics` | Secret-scrubbed diagnostic block attached to a permanent-failure advisory. Placeholders: {version}, {os}, {arch}, {code}, {log}. |
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
| `route` | A model-routing decision at agent spawn (D77). The check is the routing check and the reason is what it did: down, up, allow or exempt. |
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
