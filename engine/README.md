# anti-hall engine (phase 3a: git-guard port)

**Off by default.** `engine.enabled` stays off; nothing in the plugin starts or calls this binary unless an owner turns it on. This branch is a prototype.

One binary, two roles: `engine serve` (resident daemon, one per socket) and `engine hook` (the hook client:
hook JSON on stdin, hook output JSON on stdout). `engine ctl ping|reload|stop` and `engine version` for ops.
Crates: serde, serde_json, regex. Unix only (macOS, Linux).

## Layout
- `src/hookio.rs` parse the hook payload (Claude Code and Codex share field names) and build per-event output
- `src/rules.rs` rules format v1 (JSON) + matcher; `rules.json` ships 3 example rules ported from git-guard / command-guard
- `src/gitguard/` the built-in `check = "git"`: a port of the Node git-guard (see "Built-in checks" below)
- `src/daemon.rs` singleton daemon, reload, version handoff; `src/client.rs` fail-open client; `src/paths.rs` socket/lock paths
- `tests/e2e.rs` real daemon end-to-end (isolated HOME + engine dir); `wall.zsh`, `base.js` measurements

## Hook I/O
| event | deny | warn / context |
|---|---|---|
| PreToolUse | `hookSpecificOutput.permissionDecision:"deny"` + reason | `hookSpecificOutput.additionalContext` |
| PostToolUse, UserPromptSubmit | `{"decision":"block","reason"}` | `hookSpecificOutput.additionalContext` |
| Stop | `{"decision":"block","reason"}`; never when `stop_hook_active` | `{"systemMessage"}` |
| SessionStart, SubagentStart | n/a (treated as context) | `hookSpecificOutput.additionalContext` |

Anything else, malformed input, or no match: print nothing, exit 0.

## Rules v1 (`~/.anti-hall/engine/rules.json`, or `$ANTIHALL_ENGINE_RULES`)
Fields per rule: `events`, `tools` (omit or `"*"` = any), `field` (dot path into `tool_input`, or `prompt`; default = command /
file_path / path / pattern / url, or the prompt on UserPromptSubmit), `pattern` (regex crate syntax, unanchored), `action`
(`deny|warn|context`), `message`, `paths` (apply only when payload `cwd` is at/under one of them). Rules apply in file order;
all matches contribute, any `deny` wins. Reload: SIGHUP, `engine ctl reload`, or file change (checked every ~200 ms). A rules file
that fails to parse keeps the previous rules.

## Rule schema (v1)
```json
{"version":1,"rules":[{
  "id":"git-no-force-push",        // optional, for logs/tests
  "events":["PreToolUse"],         // optional; omitted or "*" = any event
  "tools":["Bash"],                // optional; omitted or "*" = any tool
  "field":"command",               // optional dot path into tool_input, or "prompt"
  "pattern":"regex",               // Rust regex syntax (linear time), unanchored
  "action":"deny",                 // deny | warn | context
  "message":"...",
  "paths":["/abs/project"],        // optional; applies only when payload cwd is at/under one
  "check":"git",                   // optional built-in check (see below); then `pattern`/`message` are ignored
  "options":{"plugin_root":"/p"}   // optional, per check
}]}
```
Loaded in file order; all matches contribute; any `deny` wins. Reload on SIGHUP, `engine ctl reload`, or file change; a file that fails to parse keeps the previous rules.

## Daemon lifecycle
- Socket `~/.anti-hall/engine/e.sock` (override dir with `ANTIHALL_ENGINE_DIR`); if the path exceeds 100 bytes: `$TMPDIR/ah-<uid>.sock`, then `/tmp/ah-<uid>.sock`.
- `e.sock.lock` is flock'd for the daemon's lifetime and holds the daemon's pid; it is never deleted (deleting a lock file lets two daemons hold different inodes). Holding it proves an existing socket FILE is stale, so it is removed and rebound; anything that is not a socket is left alone. The kernel drops the lock if the daemon dies.
- Version handoff: every request carries the client's version (`ANTIHALL_ENGINE_VERSION`, default = crate version). A newer client makes the daemon answer that request, unlink the socket, drain queued connections and exit; the next client cold-starts the new build (the starting daemon waits up to 1.5 s for the old one to release the lock).

## Reliability (phase 2)
Wire: every reply is `AHR1 <OK|BUSY|ERR> <len> <crc32>\n<body>\nAHEND\n` (`src/frame.rs`). Only a complete, checksummed OK frame is an answer; an empty body inside a valid OK frame means "nothing to say".
Client (`engine hook --fallback <hook.js>` or `ANTIHALL_ENGINE_FALLBACK`; node binary from `ANTIHALL_ENGINE_NODE`, default `node`): on truncated/empty/corrupt/BUSY/ERR/timeout/engine-absent/breaker-open/crash-loop it runs the Node hook and passes its stdout and exit code through. Plain allow (exit 0, no output) only when that fallback is also unavailable. The fallback is chosen by the caller, never by payload text.

| # | Item | Status | Tests (`tests/reliability.rs` unless noted) |
|---|---|---|---|
| 1 | Framing + fallback rule | done | `frame::tests::*` (every prefix of a frame rejected, every single-byte flip rejected); `bad_replies_run_the_node_fallback_never_allow` (7 bad-reply shapes), `engine_down_runs_fallback_and_plain_allow_only_without_one`, `healthy_engine_answers_and_fallback_is_not_run` |
| 2 | No hangs | done | `hung_engine_times_out_then_falls_back`, `default_client_deadline_is_about_two_seconds`, `oversize_input_skips_engine_and_daemon_rejects_oversize_requests` (1 MiB cap), `slow_sender_cannot_wedge_the_daemon` (read deadline), `cpu_budget_trips_to_fallback` (rule-eval deadline); accept = `poll` loop; write deadline `ANTIHALL_ENGINE_WRITE_MS` has no dedicated test |
| 3 | Watchdog + breaker | done | `stalled_loop_triggers_clean_exit_and_next_client_respawns`, `stuck_worker_triggers_exit`, `breaker_opens_after_repeated_failures_and_skips_engine` |
| 4 | Crash-loop protection | done | `crash_loop_stops_respawning_records_reason_and_advises_once` (3 SIGKILLs, no respawn, reason in `failure.json` / `engine.log`) |
| 5 | Single instance | done | `twenty_parallel_cold_clients_yield_exactly_one_daemon`, `stale_lock_from_dead_pid_is_recovered_but_live_engine_pid_is_not_stolen`, `non_socket_at_socket_path_is_never_deleted`; `e2e::concurrent_cold_starts_spawn_one_daemon`, `e2e::stale_socket_and_dead_lock_are_recovered` |
| 6 | CPU / memory | partial | `queue_overflow_answers_busy_and_clients_fall_back` (bounded pool + queue), `rate_limited_session_gets_busy_so_it_falls_back` + `daemon::tests::per_session_rate_limit_*`, `memory_limit_and_nice_are_applied_and_reported`, `rss_over_cap_restarts_cleanly_and_next_client_respawns`, `cpu_budget_trips_to_fallback`. Caveats: macOS rejects `setrlimit(RLIMIT_DATA)` with EINVAL (C probe), so there the RSS self-check (default cap 48 MB, every 10 s) is the only memory guard; the CPU budget is checked between rules, so a request overshoots by at most one rule; the per-project limiter shares the bucket code tested in `limits::tests` but has no dedicated e2e |
| 7 | Safety | partial | `socket_is_0600_and_state_dir_0700`, `long_path_socket_dir_is_private_and_owner_checked`, `symlinked_state_dir_is_refused`, `limits::tests::peer_uid_is_ours_and_a_foreign_expectation_is_rejected` (a foreign uid cannot be forged without root, so rejection is unit-tested, not end-to-end), `payload_text_is_never_executed`, `projects_are_isolated_through_the_daemon` + `store::tests::project_a_cannot_read_project_b`. No network: the source has no TCP/UDP socket (Unix socket only; verified by reading, no test) |
| 8 | Classification + advisory | done | `health::tests::classification_splits_env_from_permanent`, `scrub_removes_secrets_emails_and_home`, `merge_into_each_output_shape`, `environment_failure_gets_a_plain_hint_not_an_issue_request`, and the advisory assertions in the crash-loop test (once per session, issue URL, diagnostic block). Never files an issue |
| 9 | `status` | done | `status_reports_all_required_fields` (uptime, rss, cpu, queue depth, restarts, breaker, rules version/fingerprint; also works with the daemon down) |
| 10 | Parity harness | done | `parity/` (below) |
| 11 | Off by default | done | stated at the top |

Env knobs (all `ANTIHALL_ENGINE_*`): `WORKERS`(4) `QUEUE`(16) `MAX_REQUEST` `READ_MS`(1000) `WRITE_MS`(1000) `EVAL_BUDGET_US`(200000, 0 = off) `MEM_MB`(64) `RSS_CAP_KB`(49152) `RSS_CHECK_MS`(10000) `STUCK_MS`(8000) `STALL_MS`(5000) `NICE`(5) `SESSION_RPS/BURST`(50/200) `PROJECT_RPS/BURST`(100/400) `DEADLINE_MS`(2000) `BREAKER_N/WINDOW_S/COOLDOWN_S`(5/60/60) `CRASH_N/WINDOW_S/COOLDOWN_S`(4/600/1800) `FALLBACK_MS`(8000). `TEST_HOOKS=1` enables test-only verbs (`CTL sleep|stall|panic`). `engine reset` clears the breaker, crash-loop stop and failure record.

Failure advisory (once per session, only on calls served by the fallback): environment failures (disk full, permissions, socket path too long, fd limit, OS kill) print a plain self-fix hint; permanent ones print `⚠️ anti-hall · engine: stopped after repeated failures (<reason>). Using the built-in checks instead. Please file an issue: https://github.com/talas9/anti-hall/issues/new` plus a secret-scrubbed diagnostic block (version, OS, error code, last log lines).

State (all under the engine state dir): `engine.log` (64 KiB, trimmed), `failure.json`, `breaker.until`, `crashloop.until`, `daemon.run` (run marker; a leftover one with a dead pid is logged as one crash), `starts`, `advised/` (one empty file per advised session). Project-partitioned in-memory state (`P <cwd>` requests, `engine proj <cwd> put|take|len|set|get`): the daemon derives the partition from `cwd` (nearest `.git` ancestor); caps: 256 projects, 64 mailbox entries, 64 keys.

## Built-in checks (phase 3)
A rule with `"check":"git"` runs real logic instead of a regex: a port of the Node git-guard (PreToolUse on Bash) from the `dev` build 0.201.0 (bcddfb7), std + regex only (`src/gitguard/`, about 200 KiB over 10 files). It carries the shell tokenizer and segment splitter, wrapper and verb resolution (sudo/env/timeout/nice/flock/...), `eval`/`sh -c`/`env -S` payloads, xargs/find/parallel runners with placeholders, the heredoc data mask, force/delete push detection with git's option abbreviations, inline aliases, self-credit detection on every message route (`-m`, `--trailer`, `-F -`, `-F path`, `gh` bodies, whole-command trailer lines), config-valued commands, `~/.anti-hall/bin` launcher writes, the quote-blind backstops, and the handover-commit check. Alias resolution (`git config --get-regexp`), reused-message reads (`git log -1`) and the handover queries run `git` through `std::process::Command` with the same timeouts and budgets as Node.

Output follows the Node guard: a block is **exit 2 with the reason on stderr** (the daemon replies `AHEXIT 2\n<reason>`, the client prints it to stderr and exits 2); the handover-budget advisory is a stdout JSON line, exit 0. Settings are read per call from `$HOME/.anti-hall/settings.json` and `skip.json` (`safety.gitGuard`, `guards.gitGuardHeredocData`, `guards.gitAliasResolve`, `guards.gitReusedMessageCheck`, `guards.handoverCommitGuard`, a `git-guard` skip entry); the matching `ANTIHALL_*` / `CLAUDE_PLUGIN_OPTION_*` env overrides are read from the **daemon's** environment (fixed at its start). The override hint in block text names `<plugin_root>/scripts/devswarm.js`, with `plugin_root` from the rule's `options` or `ANTIHALL_ENGINE_PLUGIN_ROOT`.

Deliberate differences from the Node guard:
- **Jev add-block consult** (`gitGuardSelfCredit`) is not performed. Only mode `on` with Jev enabled can change a verdict, so in that configuration the check answers `AHFALLBACK`, the daemon replies ERR and the client runs the Node hook (`--fallback`); in the default `shadow` mode the engine writes no `jev-assist` telemetry rows.
- A payload `serde_json` rejects but JS accepts (a lone surrogate escape) gets the same ERR, so Node decides.
- Pathological nesting (`xargs xargs ...` more than 1500 deep) and any panic in the port answer `AHFALLBACK` too: the check runs on a 64 MB-stack thread so it cannot overflow a worker, and Node (which allows on its own stack overflow) decides. The substitution scanners stop at 1500 levels and scan the raw text, as Node's caller does after its own overflow.
- The PostToolUse `--audit` pass (recent-commit trailer audit) is not ported.
- Plugin options stored in Claude's own settings are not read, only the env form.
- Relative file reads (`-F path`, `--body-file`, templates) resolve against the payload `cwd`, as Node resolves them against the hook's cwd.

## Parity harness (`parity/`) - full outcome for the git check
`parity/run-git.js` runs each command through the Node git-guard (authority) and the engine and compares **exit code, stdout and stderr** exactly. `--mode oneshot` runs `engine gitguard` (the logic in-process, no daemon), `--mode daemon` runs `engine hook` against a real daemon (framing, exit code, stderr passthrough), `--mode both` does both. Corpora: `build-corpus.js --maxlen 0` (the 1253-line phase-2 corpus, uncapped), `build-git-corpus.js` (git-related commands sampled from the real recorded-command corpus, half uniform, half from the risky shapes), the git-guard test payloads (the Node test suite run with its spawn helper dual-running the engine on every git-guard payload, same env, HOME and cwd), the adversarial probe lists from this week (`tfa*`, `gg*`, replayed through a recording shim) and two fuzzers (`fuzz-git.js`: mutation of all of the above, and `--gen`: grammar composition).

| corpus | n | node blocks | agreement (exit + stdout + stderr) |
|---|---|---|---|
| committed `corpus.jsonl` (<=400 chars) | 526 | 141 | **100%** oneshot and daemon |
| uncapped phase-2 corpus | 1253 | 362 | **100%** oneshot and daemon |
| real recorded git commands (seeded sample) | 5000 | 117 | **100%** oneshot and daemon |
| git-guard Node test payloads (11 test files, 1311 tests pass) | 1366 | - | **100%** (7 deferred to Node: 5 Jev mode `on`, 2 empty/malformed stdin) |
| adversarial probe lists (tfa, tfa2, tfa4-6, gg*) | 536 | 399 | **100%** oneshot and daemon |
| mutation fuzz, seeds 7, 11, 31 | 46000 | 17489 | **100%** (7 payloads deferred to Node: lone-surrogate JSON escapes) |
| grammar fuzz, seeds 5 and 77 | 30000 | 17772 | **100%** |

Two real mismatch classes were found and fixed on the way: advisory JSON key order (serde sorted the keys) and per-segment O(n) work that made 20000-segment commands slow (cached per request, as Node caches per process).

## Parity harness (`parity/`) - decision agreement (phase 2, regex rules)
`node build-corpus.js --cmds <cmds.jsonl> --tests <repo>/tests/hooks > corpus.jsonl`, then `node run.js --engine ../target/release/engine --hooks <repo>/plugins/anti-hall/hooks --corpus corpus.jsonl`. Runs each command through the Node hook and the engine (isolated HOME and engine dir) and diffs decision and message. The committed `corpus.jsonl` (526 lines, kept under the 256 KiB source cap) = up to 120 relevant + 120 benign commands per rule, each at most 400 chars, from real recorded commands plus single-line literals from the Node guard tests. The 400-char cut drops the long heredoc-heavy commands, so it flatters the engine; the uncapped build (`--cap 250`, no length limit; 1252 lines, 1.1 MB, not committed) is the harder measure.

Results (decision agreement on the two git rules):
| corpus | n | agreement | force-push | AI-credit |
|---|---|---|---|---|
| committed (526 lines, <=400 chars) | 406 | **94.1%** (382/406) | 87.2% | 100% |
| uncapped (1252 lines) | 1000 | **89.8%** (898/1000) | 81.2% | 98.4% |

On the uncapped corpus the engine over-blocks 86 commands whose force-push text is only data (heredocs, `echo`) and under-blocks 16 (aliases, `-c` prefixes, redirect-before-flag, heredoc fed to a shell). All mismatches are one class: the Node guard tokenizes (heredoc bodies, quoting, aliases, redirections, `$(...)`) and a regex cannot. So the force-push and AI-credit rules are **examples, not ports**: a port needs the tokenizer in Rust, or the guard stays fallback-only. `rm-rf-root-or-home` has no Node counterpart (command-guard.js neither blocks nor warns on it), so it is an example with no parity claim.

## Phase 3 checklist
- [x] Real port of git-guard (this section above): 100% full-outcome agreement on every corpus
- [ ] Real port of command-guard (tokenizer shared with git-guard: `src/gitguard/shell.rs`) and re-run parity to 100%
- [ ] Port the PostToolUse `--audit` pass; a Jev client in the engine so the `on` deferral can go
- [ ] Wire the plugin shims (`hooks.json`) to `engine hook --fallback`, behind `engine.enabled`; settings key + `/anti-hall:settings` entry
- [ ] Linux run of `tests/reliability.rs` (only macOS verified; the `SO_PEERCRED` and Linux `RLIMIT_DATA` paths are compiled out here)
- [ ] End-to-end tests for the per-project rate limit and the write deadline
- [ ] Mailbox / ingest / Jev work from the design doc (only the partitioned store API exists)
- [ ] Idle shutdown (`engine.idleExitMin`), `nice` only for background work
- [ ] Binary distribution (signing) and directory-review impact (design doc section 8)

## Background process disclosure
When enabled, the first hook call starts `engine serve` as a detached background process (no launchd/systemd unit). It runs per user, listens only on a Unix socket in a private (0700) directory, makes no network connections, runs at lowered priority, and exits cleanly when it exceeds its memory cap, stalls, is stopped (`engine ctl stop`, SIGTERM) or is replaced by a newer build. It deletes nothing outside its own state dir. If it keeps failing it stops respawning (crash-loop stop) and hooks run on the Node implementation.

## Measurements
git check, warm daemon, `zsh wall-git.zsh <git-guard.js>` (macOS, brew rust 1.99, release build; the first run was on a quiet machine, a second run under load from other agents read 8.7-10.7 ms vs 44-48 ms):

| | engine client | Node git-guard.js |
|---|---|---|
| wall, force-push block (median of 30) | 2.7 ms | 24.4 ms |
| wall, allow (`git status && ls -la`) | 2.9 ms | 24.7 ms |
| wall, commit with heredoc body | 2.7 ms | 21.0 ms |
| peak RSS per call (median of 10) | 2.0 MB | 47.9 MB |

Daemon RSS 4.3 MB idle and 4.3 MB after 1000 commit-with-heredoc requests. A 480 KB command of 30000 `git commit -m x;` segments plus a trailing force push takes about 0.01 s in the engine (Node: 0.04 s; `time`, 3 runs each, quiet machine).

Phase 2 numbers (regex rules only):
macOS, brew rust 1.99, release build (opt-level z, lto), quiet machine, `zsh wall.zsh` (phase 2 build, framed protocol):

| | Rust client | node baseline |
|---|---|---|
| peak RSS per call (median of 10) | 2.0 MB | 44.1 MB |
| wall per call, daemon warm (median of 30, incl. `echo \|` + fork) | 2.9 ms | 19.7 ms |
| no daemon, spawn off, no fallback (median) | 2.7 ms | n/a |
| daemon cannot start, no fallback (median) | 5.5 ms | n/a |

Binary 1.1 MB. Daemon RSS 3.66 MB idle and after 1000 requests (4 worker threads). A call that has to run the Node fallback costs the engine attempt plus a normal Node hook run.
