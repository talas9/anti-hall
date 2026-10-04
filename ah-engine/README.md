# ah-engine

A small resident Rust program that anti-hall's hooks can ask instead of starting a Node process per tool call.
Unix only (macOS and Linux, including WSL); Windows is not supported.

**Off by default.** Nothing in the plugin starts or calls this binary unless an owner turns it on. This branch
(`engine-proto`) is the prototype; it does not change the plugin's behaviour.

- What it is, what works today and what is **planned (D-n)**: [`docs/AH-ENGINE.md`](../docs/AH-ENGINE.md)
- Every command, setting, metric, impact kind, check and error code (generated, cannot drift): [REFERENCE.md](REFERENCE.md)
- The versioned design decision record (D1 to D70): [DECISIONS.md](DECISIONS.md)

This directory is self-contained: its own Cargo workspace, CI (`.github/workflows/ah-engine.yml`), docs and tests. It is
never a submodule (D69).

## Layout

| Path | What |
|---|---|
| `src/main.rs`, `src/cli.rs` | the command line: registry of commands, `--json` everywhere |
| `src/daemon.rs`, `src/client.rs`, `src/frame.rs` | the resident daemon, the hook client, the framed wire protocol |
| `src/health.rs`, `src/limits.rs`, `src/paths.rs`, `src/config.rs` | breaker, crash loop, advisory, resource caps, locations, limits |
| `src/checks/` | the `Check` trait and registry; `checks/git/` is the git-guard port (tokenizer, segments, aliases, heredoc, runners, launcher) |
| `src/rules.rs`, `src/hookio.rs` | the rules format (JSON) and hook payload to output translation |
| `src/telemetry.rs`, `src/metrics.rs`, `src/impact.rs`, `src/storage.rs` | metrics, the impact ledger and the `Store` trait with its SQLite and in-memory stores |
| `src/tier.rs` | the in-memory layer: the byte-budgeted, TTL-aware `Tiered` cache of active items and the pub/sub bus |
| `src/maintain.rs` | size control: the hot-to-archive mover, retention, checkpoints and VACUUM (`ah-engine maintain`) |
| `src/spool.rs` | the write spool: retry with backoff, framed fsync'd records, ordered idempotent drain, quarantine |
| `src/db.rs`, `src/sql.rs` | the SQLite pair (`hot.db`, `archive.db`): settings, versioned migrations, the group-committing writer; the schema and statements |
| `src/defaults.rs`, `build.rs`, `defaults/*.toml` | shipped defaults, compiled into the binary from the TOML files |
| `src/docs.rs` | the reference generator |
| `tests/` | end-to-end and reliability tests against a real daemon, the no-hardcoding test, the defaults-keys test, the reference drift test, the agent CLI and residency tests |
| `parity/` | the parity harnesses against the Node guards |
| `DECISIONS.md`, `REFERENCE.md` | the decision record and the generated reference |

## Build and test

```
cargo build --release          # binary: target/release/ah-engine
./test.sh                      # the full suite, then proves no daemon survived it
cargo fmt --check && cargo clippy --all-targets -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps
cargo run -q -- docs --format md > REFERENCE.md   # after changing a command, setting, metric or check
```

Tests never touch the real home: each starts its own daemon in a temporary state directory with its own `HOME`, and a
shared reaper stops it (a test whose daemon survives fails). Cargo commands here are meant to run niced
(`nice -n 19`, `CARGO_BUILD_JOBS=2`), one test runner at a time.

## Building from source

The toolchain is pinned by `ah-engine/rust-toolchain.toml` (added by the release-CI change). From `ah-engine/`:

```
cargo build --release --locked      # binary: target/release/ah-engine
```

An offline build from the vendored source tarball published with each release (planned (D67)) uses
`cargo build --release --offline --frozen`. Release steps are in `ah-engine/RELEASING.md` (added by the release-CI change).

## Using a locally built binary

A configuration key and environment variable that point the plugin at a locally built binary are planned (D71); they will
be defined in `defaults/*.toml` like every other setting. Until then the plugin does not start the engine at all.

## Verifying release artifacts

Planned (D67), once the release workflow exists:

```
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify <asset> --repo talas9/anti-hall
```

## Reliability, in tests

| Item | Where it is tested |
|---|---|
| Framing and fallback: only a complete, checksummed reply is an answer; everything else runs the Node hook | `frame::tests`, `tests/reliability.rs` (`bad_replies_run_the_node_fallback_never_allow` and friends) |
| No hangs: hard client deadline, read deadline, oversize rejection, CPU budget | `hung_engine_times_out_then_falls_back`, `oversize_input_skips_engine_and_daemon_rejects_oversize_requests`, `slow_sender_cannot_wedge_the_daemon`, `cpu_budget_trips_to_fallback` |
| Watchdog, breaker, crash-loop stop | `stalled_loop_triggers_clean_exit_and_next_client_respawns`, `stuck_worker_triggers_exit`, `breaker_opens_after_repeated_failures_and_skips_engine`, `crash_loop_stops_respawning_records_reason_and_advises_once` |
| Single instance, stale lock and socket recovery | `twenty_parallel_cold_clients_yield_exactly_one_daemon`, `stale_lock_from_dead_pid_is_recovered_but_live_engine_pid_is_not_stolen`, `non_socket_at_socket_path_is_never_deleted` |
| Resource caps | `queue_overflow_answers_busy_and_clients_fall_back`, `rate_limited_session_gets_busy_so_it_falls_back`, `memory_limit_and_nice_are_applied_and_reported`, `rss_over_cap_restarts_cleanly_and_next_client_respawns` |
| Safety: socket mode, private directory, symlinks, peer uid, payload never executed, project isolation | `socket_is_0600_and_state_dir_0700`, `long_path_socket_dir_is_private_and_owner_checked`, `symlinked_state_dir_is_refused`, `payload_text_is_never_executed`, `projects_are_isolated_through_the_daemon` |
| Residency: stays up when idle by default; idle exit is a config key | `tests/agent_cli.rs` (`the_daemon_stays_resident_when_idle_by_default`, `idle_exit_is_a_config_key_and_is_reset_by_activity`) |
| Agent CLI: metrics, impact and status fed by real hook calls; `--json` everywhere; planned commands say so | `tests/agent_cli.rs` |
| Tiered lifecycle: write-through after commit, LRU budget loses nothing, TTL ends the lifecycle but keeps the row, a restart rebuilds only active items, idempotent write ids, pub/sub never blocks | `tier::tests`, `store::tests` |
| Size control: inactive rows move to the archive and active ones stay, totals stay exact, a crash between copy and remove loses and duplicates nothing, the impact cap moves the oldest, no hard delete unless configured, maintain beside a live daemon | `maintain::tests`, `tests/agent_cli.rs` (`maintain_runs_beside_a_live_daemon_and_is_reported_in_metrics`) |
| Spool: 100 writes with the engine down are applied exactly once and in order per session, a replay changes nothing, a busy engine makes the client spool, damage is quarantined, a take is never spooled | `tests/spool.rs`, `spool::tests` |
| Durability: SIGKILL mid-burst, 50 loops: every acknowledged write present, nothing torn, invented or duplicated, write ids match rows; group commit shares syncs within its window | `tests/durability.rs`, `db::tests::concurrent_writes_share_commits_within_the_window` |
| Storage: WAL and configured durability, versioned idempotent migrations, a newer schema refused, acknowledged only after commit, queued writes committed on close; both `Store` backends behave the same | `db::tests`, `storage::tests` |

Known limits: CI runs the whole suite on ubuntu and macOS (`.github/workflows/ah-engine.yml`); the Linux CI run found a real
bug the macOS runs could not show: Linux counts thread stacks against `RLIMIT_DATA`, so the old 64 MB ceiling left no room
for the git check's 64 MB-stack thread and every git command was deferred to Node. The ceiling (`daemon.mem_mb`) is now
512 MB, a test keeps it above workers x stack, and a failed check thread logs a `check_spawn_fail` event. macOS accepts
`setrlimit(RLIMIT_DATA)` but does not enforce it, so there the RSS self-check is the memory guard; the CPU budget is checked
between rules, so a request overshoots by at most one rule.

## Built-in checks: the git check

A rule with `"check": "git"` runs a port of the Node git-guard (PreToolUse on Bash, from `dev` at bcddfb7). A block is
exit 2 with the reason on stderr, as in Node; the handover-budget advisory is a stdout JSON line. Each Rust function cites
the Node function it mirrors in its doc comment.

Deliberate differences from the Node guard:
- The Jev add-block consult is not performed. Only mode `on` with Jev enabled can change a verdict, so then the check
  defers: the daemon replies ERR and the client runs the Node hook.
- A payload `serde_json` rejects but JS accepts (a lone surrogate escape) gets the same deferral.
- Pathological nesting (more than 1500 levels) and any panic also defer; the check runs on a 64 MB-stack thread.
- The PostToolUse `--audit` pass is not ported. Plugin options stored in Claude's own settings are not read, only the
  environment form.

## Parity harness (`parity/`)

`parity/run-git.js` runs each command through the Node git-guard (the authority) and the engine and compares exit code,
stdout and stderr exactly:

```
node run-git.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks --corpus corpus.jsonl [--mode oneshot|daemon|both]
```

`--mode oneshot` runs `ah-engine check git` (the logic in-process), `--mode daemon` runs `ah-engine hook` against a real
daemon, `both` does both. It waits for its daemon to exit before it finishes. Re-run after this phase against the Node
hooks at dev bcddfb7:

| corpus | n | agreement |
|---|---|---|
| committed `corpus.jsonl` (<=400 chars) | 526 | **100%** oneshot and daemon |
| uncapped phase-2 corpus | 1253 | **100%** oneshot |
| real recorded git commands (seeded sample) | 5000 | **100%** oneshot |
| adversarial probe lists | 536 | **100%** oneshot |
| mutation fuzz, seed set 1 | 6000 | **100%** oneshot |
| grammar fuzz, seed set 1 | 15000 | **100%** oneshot |

Earlier phases also ran the git-guard Node test payloads (1366, 7 deferred) and larger fuzz sets (46000 and 30000 lines)
at 100%; those corpora are not committed (size cap).

`parity/run.js` is the phase-2 decision-agreement harness for the regex rules; the force-push and AI-credit regex rules
are examples, not ports, because a regex cannot tokenize shell.

## Measurements

Same machine, same session, quiet, macOS, brew rust 1.99, release build (`opt-level = "z"`, lto), `zsh wall-git.zsh
<git-guard.js>`: git check through the warm daemon against the Node git-guard, same payloads.

| | phase 3a build | this build | Node git-guard.js |
|---|---|---|---|
| client wall, force-push block (median of 30) | 2.4 ms | 2.4 ms | 21.9-22.7 ms |
| client wall, allow | 2.9 ms | 2.4 ms | 22.3-23.8 ms |
| client wall, commit with heredoc | 2.4 ms | 2.4 ms | 19.0-19.3 ms |
| client peak RSS (median of 10) | 2.1 MB | 2.3 MB | 47.7 MB |
| daemon RSS, idle | 4.7 MB | 5.1 MB | n/a |
| daemon RSS after 1000 commit-with-heredoc requests | 4.7 MB | 5.2 MB | n/a |
| binary size | 1.35 MB | 1.57 MB | n/a |

The extra daemon memory is the git check's tables (built once into sets) and the telemetry. Reading defaults costs
nothing at run time: `build.rs` compiles `defaults/*.toml` into static data. The first version of the defaults parsed the
TOML at every start; measured by alternating the two builds in the same minute, `ah-engine version` took 3.7 to 3.8 ms
with the parse and 1.9 to 2.1 ms with the compiled-in data (a plain `true` takes 1.2 ms on this machine), so the parse
nearly doubled the client's start-up and was replaced.

## Background process disclosure

When enabled, the first hook call starts `ah-engine serve` as a detached background process (no launchd or systemd unit).
It runs per user, listens only on a Unix socket in a private (0700) directory, makes no network connections, runs at
lowered priority, and exits cleanly when it exceeds its memory cap, stalls, is stopped (`ah-engine stop`, SIGTERM) or is
replaced by a newer build. It stays up when idle unless `daemon.idle_exit_s` is set. It deletes nothing outside its own
state directory. If it keeps failing it stops respawning (crash-loop stop) and hooks run on the Node implementation.

## Phase checklist

- [x] Rename, layout, own CI, decision record (D49, D53, D69)
- [x] Code standards: Check trait and registry, typed errors, docs everywhere, fmt, clippy `-D warnings`, doc, `deny(missing_docs)` (D30, D39)
- [x] No hardcoding: shipped defaults and the enforcement tests (D17)
- [x] Agent CLI: `--json`, registry, generated reference, metrics, impact ledger, status summary (D50-D52)
- [x] Leak fix and residency (D7)
- [x] README and `docs/AH-ENGINE.md` (D54)
- [x] Storage backend: SQLite pair, WAL, configured durability, versioned migrations, `Store` over SQLite (D19, D21, D73)
- [x] Tiered lifecycle and the in-memory layer: key-value with TTL, pub/sub, byte budget (D20, D22, D25)
- [x] Durability and group commit, with the kill -9 crash test (D23)
- [x] Spool (D24)
- [x] Size control and retention, `ah-engine maintain` (D26)
- [ ] Storage: backup, persisted metrics (D27, D51): this phase
- [ ] Scheduler (D33), mailbox (D45), Jev lane (D34-D38), config in storage (D18), build and release CI (D56, D64, D67, D68), porting the other guards (D57): later phases
