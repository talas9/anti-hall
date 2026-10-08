# ah-engine

A small resident Rust program that anti-hall's hooks can ask instead of starting a Node process per tool call.
Unix only (macOS and Linux, including WSL); Windows is not supported.

**Used when installed, Node otherwise.** The plugin's hooks are one thin trigger per event. If this binary is installed at
`~/.anti-hall/ah-engine/bin/ah-engine` (the plugin's bootstrap downloads it, sha256-checked against `ah-engine.lock`), the trigger asks it;
the engine answers what it can prove identical to the Node hook and defers the rest to Node. With no binary the Node hooks run as before.
Install, go-live, rollback and what still runs on Node: [`docs/AH-ENGINE.md`](../docs/AH-ENGINE.md).

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
| `src/cfgstore.rs` | config layering (env, `settings.json`, `config.toml`, defaults), file watching, atomic hot-swap, `config` command data (D18) |
| `src/checks/` | the `Check` trait and registry; `checks/git/` is the git-guard port (tokenizer, segments, aliases, heredoc, runners, launcher) |
| `src/checks/replykit/` | what the four response-correctness checks share (`speculation-guard`, `speculation-judge`, `claim-ledger`, `output-verify-guard`): JavaScript-faithful JSON, the transcript tail reader, the once-per-turn gate, the stale-state sweep; tables in `defaults/response_guards.toml` |
| `src/dispatch/` | the per-event dispatcher (D58): the table and host matcher rules, running Node hooks at once, the built-in checks, combining results as the host would |
| `src/rules.rs`, `src/hookio.rs` | the rules format (JSON) and hook payload to output translation |
| `src/telemetry/`, `src/metrics.rs`, `src/impact.rs`, `src/storage.rs` | metrics, the impact ledger, the lock-free telemetry recorder (`recorder`), its event schema, flush, rollups, routing join and NET savings, and reports (D78, D77), and the `Store` trait with its SQLite and in-memory stores |
| `src/tier.rs` | the in-memory layer: the byte-budgeted, TTL-aware `Tiered` cache of active items and the pub/sub bus |
| `src/schedule.rs` | the scheduler and ticker: job sources, due/catch-up/backoff rules, subprocess and in-process runs, run history |
| `src/backup.rs` | backup (online, scrubbed, self-contained snapshot) and restore (pre-restore snapshot kept, then swap) |
| `src/maintain.rs` | size control: the hot-to-archive mover, retention, checkpoints and VACUUM (`ah-engine maintain`) |
| `src/spool.rs` | the write spool: retry with backoff, framed fsync'd records, ordered idempotent drain, quarantine |
| `src/db.rs`, `src/sql.rs` | the SQLite pair (`hot.db`, `archive.db`): settings, versioned migrations, the group-committing writer; the schema and statements |
| `src/transcript/` | the per-session transcript index (X1): incremental reader, record parser (each function cites the Node reader it mirrors), registry |
| `src/gitcache/` | the per-repo git cache (X3, D61): repository discovery, the file signature, bounded git runs |
| `src/defaults.rs`, `src/defaults/load.rs`, `src/bootstrap.rs`, `build.rs` | the run-time loader of the plugin's `engine/defaults/*.toml` (validation, atomic snapshot, cache for the thin client, change watching) and the few names needed to find them; `build.rs` only collects the keys the source reads. The defaults themselves live in `plugins/anti-hall/engine/`, never in this crate |
| `src/docs.rs` | the reference generator |
| `tests/` | end-to-end and reliability tests against a real daemon, the no-hardcoding test, the defaults-keys test, the reference drift test, the agent CLI and residency tests |
| `tests/it/node_parity/` | one test binary of Node-vs-engine parity lanes (the ported hook checks: each runs the real Node hook as the reference); corpora are Rust, or JSON data under `session_corpus/` and `ctxbudget_corpus/` |
| `parity/` | the parity harnesses of the older lanes (git, command, Jev, dispatcher, merge-side-pick, scan-throttle, ship-it, compact declaration), and `transcript-facts.js` / `run-transcript.js` for the transcript index |
| `examples/transcript_facts.rs` | prints the facts the index derives from a transcript (the parity harness runs it) |
| `DECISIONS.md`, `REFERENCE.md` | the decision record and the generated reference |

## Build and test

```
cargo build --release          # binary: target/release/ah-engine
./test.sh                      # the full suite, then proves no daemon survived it
sh tests/wrapper-stress.sh     # wrapper flake check under 2x-core CPU load; slow, not in ./test.sh
cargo fmt --check && cargo clippy --all-targets -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps
cargo run -q -- docs --format md > REFERENCE.md   # after changing a command, setting, metric or check
```

Tests never touch the real home: each starts its own daemon in a temporary state directory with its own `HOME`, and a
shared reaper stops it (a test whose daemon survives fails). Cargo commands here are meant to run niced
(`nice -n 19`, `CARGO_BUILD_JOBS=2`), one test runner at a time.

## Building from source

The toolchain (the latest stable Rust, with rustfmt and clippy) is pinned by `ah-engine/rust-toolchain.toml`, and the crate is on edition 2024. Dependencies are kept at their latest versions by Dependabot and a weekly `ah-engine-deps` workflow; `cargo deny check` (`ah-engine/deny.toml`) and `cargo audit` gate licences and advisories (D84). From `ah-engine/`:

```
cargo build --release --locked      # binary: target/release/ah-engine
```

An offline build from the vendored source tarball published with each release uses
`cargo build --release --offline --frozen`. Release steps are in `ah-engine/RELEASING.md`.

## Using a locally built binary

Copy your build to `~/.anti-hall/ah-engine/bin/ah-engine`. The bootstrap never overwrites a binary it did not install, so a local
build stays until you delete it.

## Verifying release artifacts

Each release publishes the archives, a `.sha256` per archive and `SHA256SUMS`, with build provenance:

```
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify <asset> --repo talas9/anti-hall
```

## Reliability, in tests

| Item | Where it is tested |
|---|---|
| Framing and fallback: only a complete, checksummed reply is an answer; everything else runs the Node hook | `frame::tests`, `tests/it/reliability.rs` (`bad_replies_run_the_node_fallback_never_allow` and friends) |
| No hangs: hard client deadline, read deadline, oversize rejection, CPU budget | `hung_engine_times_out_then_falls_back`, `oversize_input_skips_engine_and_daemon_rejects_oversize_requests`, `slow_sender_cannot_wedge_the_daemon`, `cpu_budget_trips_to_fallback` |
| Watchdog, breaker, crash-loop stop | `stalled_loop_triggers_clean_exit_and_next_client_respawns`, `stuck_worker_triggers_exit`, `breaker_opens_after_repeated_failures_and_skips_engine`, `crash_loop_stops_respawning_records_reason_and_advises_once` |
| Single instance, stale lock and socket recovery | `twenty_parallel_cold_clients_yield_exactly_one_daemon`, `stale_lock_from_dead_pid_is_recovered_but_live_engine_pid_is_not_stolen`, `non_socket_at_socket_path_is_never_deleted` |
| Resource caps | `queue_overflow_answers_busy_and_clients_fall_back`, `rate_limited_session_gets_busy_so_it_falls_back`, `memory_limit_and_nice_are_applied_and_reported`, `rss_over_cap_restarts_cleanly_and_next_client_respawns` |
| Safety: socket mode, private directory, symlinks, peer uid, payload never executed, project isolation | `socket_is_0600_and_state_dir_0700`, `long_path_socket_dir_is_private_and_owner_checked`, `symlinked_state_dir_is_refused`, `payload_text_is_never_executed`, `projects_are_isolated_through_the_daemon` |
| Residency: stays up when idle by default; idle exit is a config key | `tests/it/agent_cli.rs` (`the_daemon_stays_resident_when_idle_by_default`, `idle_exit_is_a_config_key_and_is_reset_by_activity`) |
| Agent CLI: metrics, impact and status fed by real hook calls; `--json` everywhere; planned commands say so | `tests/it/agent_cli.rs` |
| Tiered lifecycle: write-through after commit, LRU budget loses nothing, TTL ends the lifecycle but keeps the row, a restart rebuilds only active items, idempotent write ids, pub/sub never blocks | `tier::tests`, `store::tests` |
| Scheduler: on time, a restart never runs a job twice, a missed window catches up once (or is skipped), a hung job is killed at its timeout and the next run happens, list/run/history with and without a daemon | `tests/it/schedule.rs`, `schedule::tests` |
| Persisted telemetry: metric snapshots and rollups and the impact ledger survive a clean restart and a SIGKILL; counting continues from the snapshot | `tests/it/agent_cli.rs` (`metrics_impact_and_rollups_survive_a_restart_and_a_kill`), `metrics::tests`, `storage::tests` |
| Telemetry (D78, D77): counters exact under concurrent hook calls, `record()` median under 1 microsecond, a flush survives restart and kill -9 with the loss window exactly what was not flushed, rollups idempotent, route events join spawn results, NET math on fixtures, no text can be stored | `tests/it/telemetry.rs`, `telemetry::{recorder,event,persist,rollup,route}::tests`, `daemon::tests` |
| Backup and restore: consistent and scrubbed (no unscrubbed page left), never overwrites a snapshot, restore keeps the current state and swaps, a damaged or newer snapshot changes nothing, CLI round trip with a live daemon | `backup::tests`, `tests/it/agent_cli.rs` (`backup_then_restore_through_the_cli_with_a_live_daemon`) |
| Size control: inactive rows move to the archive and active ones stay, totals stay exact, a crash between copy and remove loses and duplicates nothing, the impact cap moves the oldest, no hard delete unless configured, maintain beside a live daemon | `maintain::tests`, `tests/it/agent_cli.rs` (`maintain_runs_beside_a_live_daemon_and_is_reported_in_metrics`) |
| Spool: 100 writes with the engine down are applied exactly once and in order per session, a replay changes nothing, a busy engine makes the client spool, damage is quarantined, a take is never spooled | `tests/it/spool.rs`, `spool::tests` |
| Durability: SIGKILL mid-burst, 50 loops: every acknowledged write present, nothing torn, invented or duplicated, write ids match rows; group commit shares syncs within its window | `tests/it/durability.rs`, `db::tests::concurrent_writes_share_commits_within_the_window` |
| Transcript index: appended bytes only, truncation, rotation and in-place rewrite rebuild, a final unterminated line counted once, caps, registry bounds; facts equal the Node readers' on fixtures and on real transcripts | `tests/it/transcript_index.rs`, `tests/it/transcript_parity.rs`, `parity/run-transcript.js` |
| Git cache: every fact equals a fresh `git` before and after each mutation on a plain repository, a linked worktree and a submodule; each signed file invalidates on its own; the dirty bit is time-bounded and `dirty_exact` is not; a bypass environment and a timeout are errors, never cached | `tests/it/gitcache_parity.rs` |
| Dispatcher (D58): the table is the table of record and both `hooks.json` files are generated from it (D87); Node hooks run at once and a hook past its timeout is killed with its group; a block wins byte for byte; contexts merge in order; a guard event (PreToolUse, PermissionRequest, Stop, SubagentStop) whose Node hook cannot run, cannot start, dies, leaves incomplete output, or whose payload is cut off or unreadable fails closed (exit 2); the fail-closed invariant matrix crosses every guard event with every injected failure; a conflict is delivered as one merged answer; a join over the host cap is handed back (exit 75) on a non-guard event and delivered merged on a guard event; the table equals the generator's output | `tests/it/dispatch_table.rs`, `tests/it/dispatch_e2e.rs`, `tests/it/fail_closed_matrix.rs`, `dispatch::*::tests` |
| The daemon never answers from its own environment (git cache, config); a damaged exact reply, a signal-killed fallback and a timed-out fallback's helpers are handled | `tests/it/process_env_reads.rs`, `tests/it/gitcache_parity.rs`, `tests/it/fallback_read.rs`, `client::tests` |
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
- The Jev add-block consult (`gitGuardSelfCredit`) is performed as Node performs it, at the same three places (inline
  `-m` messages, `-F` files and heredocs, `gh` bodies), after the regex scan found nothing: synchronous, a 1500 ms budget,
  memoised per text, at most eight distinct texts and four seconds per command. Only mode `on` can add a block; the default
  `shadow` logs the ask and never changes the verdict. A message window that would cut a surrogate pair defers.
- A payload `serde_json` rejects but JS accepts (a lone surrogate escape) gets the same deferral.
- Pathological nesting (more than 1500 levels) and any panic also defer; the check runs on a 64 MB-stack thread.
- The PostToolUse `--audit` pass is the separate `git-audit` check (below). Plugin options stored in Claude's own settings are not read, only the
  environment form.

## Built-in checks: the small guards (`src/checks/guardkit`, one module per guard)

`merge-side-pick` (PreToolUse and PostToolUse on Bash; advisory only) is a port of `hooks/merge-side-pick.js`. PostToolUse
records a one-sided conflict resolution (`--ours`, `--theirs`, `-X ours`, `-s ours`) and test runs per session; a push while
a side-pick has no test run after it adds one advisory line. The shared helpers in `checks/guardkit` mirror
`hooks/lib/settings.js` (a switch resolves env, then `settings.json`, then the plugin option, then the default),
`hooks/skip-guard.js`, `hooks/lib/block-message.js`, and translate JavaScript regex sources kept in
`defaults/small_guards.toml` so `\s`, `\b`, `.` and the `i` flag keep their JavaScript meaning.

Deliberate differences from the Node guard:
- State is the Node file `~/.anti-hall/merge-side-pick-<session>.json` itself (`FileState`, same bytes, old files pruned as
  `state-prune.js` does), so a restart forgets nothing and a Node hook that answers for the same session in turn (a
  deferral) reads and writes the same record. The database-backed store replaces it later (planned, D22).
- The PostToolUse pass is selected by the event the entry is wired to (or `hook_event_name`), which is what `--post` stands
  for in the wiring. A silent PostToolUse answer is `Allow`, never `None` (`None` hands the call to the Node hook, which would
  record it a second time); the PreToolUse pass still answers `None` when silent, so the dispatcher runs its Node hook.
- The switch environment is the engine process's, not the hook client's (same limit as the git check); the switch files
  work. A cut of the stored command inside a surrogate pair defers to Node.
- `ship-it-guard` (opt-in, `guards.shipitGate`): Edit, Write and MultiEdit are decided here (existence gate on hard-risk
  paths, conformance advisory against a parsed `PLAN.md`). With the gate on, `Bash` (shell-write targets come from the
  command-guard parser, planned with its port) and `apply_patch` defer to Node, and so does a payload without an absolute
  `cwd` (Node would use its own process directory).
- `scan-throttle` (advisory; matches nothing unless `ANTI_HALL_THROTTLE_PATTERNS` is set): the patterns are JavaScript
  regexes, and the engine matches only a plain subset itself (literals, `.`, groups, alternation, quantifiers, simple
  classes, `^`/`$`, `\s \d \w \b`, escaped punctuation). Lookaround, back-references, counted repeats, Unicode escapes and
  non-ASCII patterns defer to Node. Its state (none) and its tool probe read the engine process's `PATH`.
- `coordinator-work-guard`, PreToolUse: only the exits the payload proves are decided here (not Bash, no session id, a
  subagent marker in the payload, which on the recorded field data is 88 percent of Bash calls); the block needs
  `classifyBashWork` from command-guard, which the engine does not have, so every other main-thread call defers to the Node
  guard (planned with the classifier, D75). PostToolUse (`--post`, `checks/coordinator_work/post.rs`): the engine keeps the
  window in the Node files (`coordinator-work-session-<id>.json` with its `.lock`, the metrics, the trips log, the fold
  stamp; same bytes, key order and number text) and answers the call when its classification is already known without the
  classifier: the Node PreToolUse pass stored its verdict under the call's `tool_use_id`, or the command is provably not
  work. Anything else defers to the Node hook, as does a window or metrics lock a live process holds. The lock is Node's
  format (`guardkit::filelock`: the JSON owner record, hard-link publish, takeover of a holder older than 5 s by
  rename-aside with token check) without the reclaim sidecar. Where the Node code lists a directory the engine sorts the
  names the way libuv does, so the fold order and the metrics key order agree.
- `git-audit` (PostToolUse on Bash, `src/checks/git/audit.rs`): the `--audit` pass of git-guard. After a commit-creating
  command (found with the PreToolUse scanner: `cd`, `git -C`, wrappers, aliases, eval and `sh -c`) it reads the last 20
  commits at HEAD of each repository involved and advises when one made in the last 15 minutes carries a self-credit
  trailer. A payload without an absolute `cwd` defers (Node would use its own directory).
- `failure-root-cause-nudge` (PostToolUseFailure on Bash, `src/checks/failure_nudge/`): the one-line root-cause reminder
  with its noise filter: silent for an interrupt, a harness refusal, an expected exit 1 of a predicate command
  (`expected.rs`, a port of `expected-failure.js`) and for repeats within a turn (`guardkit/turn_gate.rs`, a port of
  `turn-gate.js` over the Node file `turn-gate/tg-<session>.json`, rewritten with its key order by `guardkit/ojson.rs`).
  The Node turn gate passes `tg-` as the family name of its pruning sweep, which looks for `tg--*.json` and so never
  removes a file; that is kept so the files on disk stay the same (a finding for the Node side).
- `verify-first-subagent`, `verify-first-full` and `fable-availability` (context checks, never block; `checks/verify_first`,
  `checks/fable_availability`; parity test `tests/it/node_parity/verify_first.rs`): the protocol texts live in
  `defaults/verify_first.toml`, copied from `hooks/verify-first-core.js`, and the harness fails when either side drifts. The
  compact text names `<plugin root>/PROTOCOL.md`; the root is derived like Node does (the real location of
  `hooks/verify-first-core.js`), and a root the engine cannot prove defers. A payload the engine's JSON reader rejects
  defers for every hook (the dispatcher's rule). `fable-availability` writes the same state file as Node (key order
  `available`, `checkedAt`, `source`); a `~/.claude.json` the engine's reader rejects (after replacing unpaired surrogate
  escapes, which JSON.parse accepts) or nests deeper than its limit defers, so Node reads and writes it. The switches are the
  environment, `settings.json` and plugin options exactly as Node's `settings.js` resolves them; `DEVSWARM_SOURCE_BRANCH`
  joins the forwarded request environment for the child-workspace note.
- Session maintenance (`version-alert`, `devswarm-version`, `claude-cli-version`, `repo-self-drift`, `defect-nudge`,
  `progress-prune`; SessionStart, never blocking): output bytes and state-file writes equal the Node hooks'
  (`tests/it/node_parity/session.rs`). The engine never starts a background process, so a stale or absent version cache (Node starts a
  detached probe) answers a deferral, and so does anything it cannot read exactly like JavaScript (a payload with no absolute
  `cwd`, a date that depends on the time zone, a `.git` file in an unusual shape, JSON with a lone surrogate escape, a git
  probe slower than `session.gitignore_probe_ms`). A deferral always comes before the first write, so Node then sees the
  state it would have seen. Switches and the home directory come from the client's forwarded environment (D76).
- `merge-gate` (opt-in, `guards.mergeGate`): decided entirely here: the records of the transcript tail, the quote mask, the
  hedge and its resolution by a real typed user prompt, the block, and the `mergeGateHedge` Jev shadow ask (asked on the
  shared Jev lane without waiting). A relative transcript path, a transcript line the engine cannot parse and an ask window
  that would cut a surrogate pair defer.
- `api-guard`: decided here only where Node reaches no interpreter probe: the guard or skip switch, a tool that carries no
  code, a target that is not a Python or JavaScript file (by extension, as Node), and code in which no candidate can exist
  (a conservative superset of Node's candidate extraction: no `import` word or no stdlib module name in Python, no global
  followed by a dot and no `require` of a verifiable module in JavaScript). A Bash command or `apply_patch` text that
  names any code file (`.py`, `.js`, `.ts` and the other extensions) defers, whatever the write shape (redirect, `tee`,
  heredoc, `sed -i`, `python -c`), so the engine is never weaker than Node's shell-write parser. The probes and the
  runtime versions in the block text stay with Node.
- `edit-guard`: the launcher-directory deny (`~/.anti-hall/bin`, literal path or an existing symlink into it) is decided
  here for every agent with the Node block's exact bytes (stdout JSON, exit 2, nothing on stderr). A call that is not the
  main thread (subagent marker, `agent_tool` entry point or no recognised entry point, from the request environment) is
  allowed as Node allows it. Every main-thread call, every `apply_patch` (no patch parser), a relative cwd or home, a
  non-string path and a request environment without a home directory defer; the allowlists, symlink and hard-link honesty
  checks, plan mode, the trusted per-project allowlist and the DevSwarm wording stay with Node.
- `coordinator-work-guard`: only the exits the payload proves are decided here (not Bash, no session id, a subagent marker
  in the payload, which on the recorded field data is 88 percent of Bash calls). The window (counters, nudge, block) needs
  `classifyBashWork` from command-guard and the hook's `CLAUDE_CODE_ENTRYPOINT`, neither of which the engine has yet, so
  every main-thread call defers to the Node guard, which keeps all of the window's state; the engine keeps none, so the
  two cannot disagree. The window moves in with the command-guard port (planned, D75).
- `devswarm-parent-inbox`, `devswarm-child-turn`: the gate of the two DevSwarm prompt hooks. Silent cases (not a Primary or not
  a child, DevSwarm inactive, the hook's switch off, a Jev judge child) are answered; an active Primary or child defers to the
  Node hook, which owns the roster, the mailbox and the dedupe state until the engine owns the mesh and mailbox (D45).
- `compact-declaration-guard`: decides whether the call is new work (Node's patterns, quotes blanked, handover edits
  exempt), reads the last 1.5 MB of `transcript_path` itself (the shared transcript index is another lane), rebuilds the
  current turn's assistant text with Node's turn rules and allows unless that text contains "safe", which both
  declaration phrasings need. A turn that might declare defers to Node, which owns the phrase analysis and the block; the
  block (a JSON decision on stdout, the reason on stderr, exit 2) is a shape the engine's reply cannot carry yet, so
  every block is a deferral. A transcript line serde rejects but JavaScript may accept (lone surrogate escape, extreme
  nesting or exponent) also defers.
- `limit-conserve-inject`, `auto-handover`, `auto-handover-pause-nag`, `compact-advice-guard` (`src/checks/ctxbudget/`): each
  answers the case in which its Node hook prints nothing and writes nothing (see `defaults/ctxbudget.toml` for every file
  name, setting and limit) and defers every other case. The settings the hooks read (`limitConserve.*`, `autoHandover.*`,
  `guards.compactAdviceGuard`) resolve environment, then `settings.json`, then the plugin option, then the default, with
  JavaScript's number and string coercions. The home directory is `HOME` (Node's `os.homedir()`); a request without an
  absolute one defers. A reading that needs a state write (the inferred one-million-token window), a tag that is a hash of
  the transcript path, and a relative `transcript_path` defer to Node. Parity: `cargo test --release --test
  it -- node_parity::ctxbudget` (`tests/it/node_parity/ctxbudget.rs`).
- `swarm-guard` (PreToolUse on Agent and Task): the memory gate (macOS `vm_stat`, Linux `MemAvailable`, never the OS "free"
  figure) and the spawn-rate gate are exact, including the spawn log, the trip log and the lock file, whose format and
  takeover protocol are the Node ones (`checks/guardkit/nodelock.rs`), so the Node hook and the engine can run against the
  same files. The shared-tree advisory needs the running-agent scan of the session transcript, which is not ported: when
  it could be due (a write-capable, non-isolated spawn with a transcript, the advisory switch on) the check defers BEFORE it
  records the spawn, so Node counts it once; a block never defers. Any trouble taking the lock, reading memory or writing
  the log allows the spawn, as in Node. A spawn log holding a number above 2^53 defers (JavaScript would print it rounded).
- `devswarm-comms-guard` (PreToolUse on SendMessage): reads the host's `~/.claude/sessions/*.json` index in name order and
  blocks a target whose session works under `~/.devswarm/repos`; the labels and the silent cases are Node's. A relative
  session directory (Node resolves it against the hook's own working directory) defers.
- `jev-weekly-scorecard`, `jev-review-reminder` and `repair-on-reload` are gates, not ports: each stops at the first
  condition under which the Node hook prints and writes nothing (switch off, subagent turn, child workspace, a latch
  younger than its window, a repair stamped at the running version or cooling down) and otherwise defers to the Node hook,
  which builds the report, reads the review log or takes the lock and starts the detached repair (D60: the repair
  implementation stays callable with the engine down). The engine never writes a state file for them. The list of default
  migration keys is shipped in `defaults/session_gates.toml` and a test compares it with `companion/lib/migrations.js`.
  Codex registers the same three hooks, so the same checks answer its table; it registers neither `swarm-guard` nor
  `devswarm-comms-guard`.
- Handover and Codex hook ports (`handover-resume`, `precompact-snapshot`, `codex-availability`, `codex-quota-detect`,
  `codex-nudge`): see DECISIONS 1.75. They answer exactly as Node does or defer; they read the request's environment
  (`HOME`, `PATH`, `TZ`, `TMPDIR`) and write the same files (`~/.anti-hall/codex-availability.json`,
  `codex-nudge-state-<session>.json`, `handover-resume-state-<session>.json`, `<repo>/.anti-hall/handovers/.../PRECOMPACT-<n>.md`).
  Parity: `cargo test --release --test it -- node_parity::b78 codex_ handover_resume precompact` (`tests/it/node_parity/b78*.rs`).
- A check that needs more than the `Subject` (session id, transcript path, agent markers) implements
  `Check::run_payload`; its `run` defers, so a caller that cannot supply the payload never gets a silent allow.
## Scripted checks (D88)

A check whose decision is editable plugin JavaScript is registered as a `Scripted` entry (a name and a summary) and answered by `engine/logic/<check>.js` on the embedded QuickJS (`src/script`). Batch 1: `api-guard`, `inbox-read-guard`, `orch-on-spawn`, `verify-first-subagent`, `verify-first-full`, `fable-availability`, `edit-guard`; the older `ship-it-guard` and `compact-declaration-guard` have a script and a compiled port. A script defines `decide(payload, opts, event)` and returns `'allow'`, `'defer'`, `null` (nothing to say, Node decides), `{block}`, `{advisory}` or `{exact: {code, out, err}}`. Its API is `ah.*` (`engine/logic/lib/00-ah.js`): `cfg`, `env`, `settings`, `fs`, `path`, `re`, `transcript`, and `state.writeAtomic` (the only write: atomic, under `~/.anti-hall`, size-capped, no link below the root). Shared helpers: `lib/10-text.js` (message layout), `20-spawn.js` (home, state home, DevSwarm), `30-verify-first.js`, `40-coordinator.js`. Edit a script in the plugin, or override it file by file in `~/.anti-hall/logic/`; the next call reloads it. A script that cannot answer defers to the Node hook; an engine-only check blocks on a guard event and allows elsewhere (`script.engine_only_checks`). Parity: `tests/golden/<check>.jsonl` (frozen from the compiled port) is replayed by `script::tests` and, against the Node hook, by `node parity/run-golden.js <check> hooks/<check>.js`. The v1.0 gate is `compiled_logic_checks_remaining` reaching 0 (`tests/compiled_logic_gate.rs`).

## Built-in checks: agent and transcript controls (`src/checks/agent_scan`, `ask_guard`, `silent_agent_nudge`, `stale_agent_stop_note`)

Three Node hooks read the session transcript to learn which background agents and named teammates are running, and share
one parser, `hooks/lib/agent-scan.js`. `checks/agent_scan` is its port. It streams the transcript tail line by line (the
Node hook reads it whole), so a 64 MiB window never sits in the daemon's memory; what it keeps is the small state the walk
needs, plus the answers to `TaskOutput` and `SendMessage` calls for the delivered-but-unnotified safety net, bounded by
`agent_scan.retain_bytes`.

- `ask-guard` (PreToolUse on AskUserQuestion, `guards.noBlockingQuestions` off, advise or block, and
  `guards.questionAgentsNote`): the three modes, the `DESTRUCTIVE:` and `CREDENTIAL:` markers (their use is appended to
  `~/.anti-hall/logs/ask-guard.ndjson`, after the decision is final, so a deferral never leaves a duplicate line), the
  child-workspace sentence (`DEVSWARM_SOURCE_BRANCH` is now forwarded to the engine) and the note naming agents still in
  flight. A block is the JSON decision on stdout with exit 2, as Node writes it.
- `stale-agent-stop-note` (PreToolUse on TaskStop, `guards.staleAgentStopNote`): the advisory line for an agent that was sent
  a message or resumed after its last report. Reads the last 64 MiB.
- `sibling-sweep` (Stop and SubagentStop, `guards.siblingSweep`; engine-only, no Node twin): a reply that states the cause of
  a bug in a fix context with no search for other occurrences of the same pattern in the turn gets one reminder to search,
  fix or list every occurrence and state the search (once per cause per turn, capped per scope). Every phrase, message, limit
  and the follow-through window is a `sibling_sweep.*` setting read from the config files at call time (`settings.json`
  section `sibling_sweep`, the engine's `config.toml`, the shipped `defaults/sibling_sweep.toml`): tuning is a file edit,
  not a rebuild. Telemetry: `~/.anti-hall/logs/sibling-sweep.ndjson` (`cause` and `followthrough` rows, hashes and counts only).
- `silent-agent-nudge` (Stop, `guards.silentAgentNudge`, `guards.silentAgentNudgeMin`): every Stop that does not nudge is
  answered here, including the rewrite of `~/.anti-hall/silent-agent-nudge-state.json` (pruned to the agents still live,
  the same bytes Node writes, the order of its keys kept). A Stop that WOULD nudge is deferred before anything is written:
  the text carries the stop-ack hint, and whether the running build may block at all is `stop-version-gate`, which only
  the Node hook can answer for itself.

Deliberate differences from the Node hooks:
- Anything JavaScript reads that this port cannot reproduce exactly defers to Node: a JSON line with a lone surrogate
  escape (or any unparsable line that holds one), nesting past serde's limit, a number past f64 range, a timestamp that is
  not an ISO date-time with `Z` or an offset (V8's legacy date parser reads many other forms, and local time depends on the
  hook's time zone), a tool input holding a float or an integer past 2^53 (its JavaScript text differs), a description cut
  inside a surrogate pair, a state file with a list member or number-like keys, and a request without `HOME`.
- `silent-agent-nudge` does not write the slow-run diagnostics line the Node hook adds to the central log for a transcript
  over 8 MB; the engine records its own latency.
- The scan stops being exact when the answers to `TaskOutput` and `SendMessage` calls exceed `agent_scan.retain_bytes`
  (8 MiB): the call defers.
## Built-in checks: the task checks (`src/checks/taskkit`, `src/checks/taskstate`, one module per hook)

`task-lifecycle-log`, `dispatch-tier`, `task-guard` and `tasklist-guard` port the task hooks of batches 9 and 10. Their
tables, patterns, limits and texts are in `defaults/task_guards.toml`. Every check either answers exactly what the Node
hook would (exit code, stdout and the files it writes) or defers, so the engine is never a weaker guard than Node (D74).
`tests/it/node_parity/fx.rs` is the harness: it runs the real Node hook with an isolated `HOME` and the engine check on identical
worlds and compares exit code, stdout, stderr and the whole file tree; `fx_lifecycle.rs`, `fx_dispatch_tier.rs`,
`fx_task_guard.rs` and `fx_tasklist_guard.rs` hold the corpora (hand-written shapes, fuzz, and, with
`AH_PARITY_REAL_TRANSCRIPTS=1`, real transcripts for the two Stop gates). Run them with
`cargo test --release --test it -- node_parity::dispatch_tier task_lifecycle task_guard tasklist_guard`.

- `task-lifecycle-log` (TaskCreated, TaskCompleted): the ledger line and the index entry, exactly. The project root is the
  nearest `.git` ancestor of the real path (`taskkit/root.rs`, from the file system alone, no git process). A relative
  `cwd`, a field cut through a surrogate pair and a number JavaScript prints with a different digit string defer.
- `dispatch-tier` (PostToolUse on TaskCreate and TaskUpdate): asks Jev (`dispatchTier`) once per task text, detached.
  Integration off (the default while Jev is disabled) means nothing is read or written. Otherwise the check builds the
  task text (a TaskUpdate's from the reconstructed task plus the update), skips owner-blocked tasks, skips a text that has
  a verdict in the shared answer cache or a live request marker, writes the marker (`dispatch-tier-state.json`) and
  starts the ask (DECISIONS 1.93).
- `task-guard` (Stop): rebuilds the task list from the last 1.5 MiB of the transcript with both Node reconstructions
  (`taskstate/parse.rs`), recovers records before the window (`taskstate/backfill.rs`) and answers only the Stops with no
  open task: the loop state file is removed, and the pruning advisory and the unknown-state note are printed as Node
  prints them. Every Stop with an open task defers (its decision needs the running-agent scan, OMC loop detection and the
  stop budget). The backfill scans a fixed number of bytes where Node stops after 150 ms; the engine defers when the
  search needs more, so its answer never depends on machine speed.
- `tasklist-guard` (Stop): the single-pass scan (`tasklist_guard/scan.rs`, work detection in `taskkit/workdetect.rs`),
  the progress-file freshness rules with their file effects, the plan-mode advisory and the resume-verification nudge. A
  Stop that would block defers (Node owns the block text, the loop state, the Jev consult, the acknowledgement and the
  stop budget), and so does one that needs the running-agent scan (two or more tasks in progress on a Claude session). A
  relative path in a tool call is judged against the payload's `cwd`, which can only make the engine count more work than
  Node, never less.
- Not ported: `task-tracker` (UserPromptSubmit). Its output depends on the emit-dedupe state (batch 4), the Jev
  decision-log row it writes on every prompt, the DevSwarm primary tier and the agent scan, and the Node source moved on
  the development branch after this lane's base.

## Built-in checks: the command check

A rule with `"check": "command"` runs a port of the Node command-guard (PreToolUse on Bash; source `dev` at 3d36268),
the most frequent Bash hook. Its code is in `src/checks/command/`, its tables, patterns and limits in
`defaults/command.toml`, and each Rust function cites the Node function it mirrors.

**What the engine answers today: only the allows that hold in every context.** command-guard's blocks depend on things
the engine cannot reproduce exactly yet: the hook's own environment (`CLAUDE_CODE_ENTRYPOINT` decides coordinator vs
subagent, plus DevSwarm and settings switches; a daemon only sees its own environment), DevSwarm state files, edit-guard's
verdict on a written path, the repo's command allowlist, and git subprocesses for the plain-push carve-out. Its block is
also a stdout JSON line plus stderr, which the `Block` verdict cannot carry. So the check returns Allow only when Node
allows the command whatever the context, and Defer otherwise (the client then runs the Node hook, D11):

1. no DevSwarm or stash guard can fire (DevSwarm CLI verb in any scanned segment, `devswarm.js`, `stash`, or an
   `inbox`/`store` path component in the command or the cwd);
2. no write target the edit-guard parity branch would judge (redirects, tee, `sed -i`, `perl -i`, cp/mv, and inline
   interpreter code that might name one; targets with `$`, globs, braces or a leading `~` are skipped as in Node);
3. not heavy (`isHeavyCommand`, ported in full, except the stable-launcher light exception, which depends on the home
   directory and is never granted).

A payload that proves a subagent (agent markers, read as the coordinator-work check reads them) only needs test 1: Node
answers a subagent with exit 0 right after the DevSwarm and stash guards, before the write and heavy tests. That is the
common case on field data, where most Bash calls come from subagents. The main thread still needs the hook environment.

Parity (`parity/run-command.js`, Node command-guard at dev 3b64965 as the authority; exit code, stdout and stderr compared
exactly; the daemon column runs the production path, where a deferral runs the real Node hook):

| corpus | cases | oneshot | daemon | engine answered |
|---|---|---|---|---|
| the guard's own Node tests (973 tests, 1826 distinct payloads and environments, captured by a spy) | 1826 | **100%** | **100%** | 17.5% |
| real field commands (20,000, half biased to the shapes the guard judges), coordinator and subagent | 40,000 | **100%** | **100%** | 77.8% |
| fuzz and adversarial (6,000), 13 caller profiles (markers empty, null, type-only, Codex shapes, DevSwarm active, stash armed) | 78,000 | **100%** | | 70.7% |
| non-ASCII injection into trigger-bearing commands (5,229), 5 profiles | 26,145 | **100%** | **100%** | 9.2% |
| real field commands (3,000) x 13 profiles | 39,000 | **100%** | | 75.3% |

`parity/field-rate-command.js` measures the defer rate on the recorded field corpus (every 9th recorded call, 29,930 rows,
subagent flag taken from the row): **12.3% deferred overall** (5.1% for subagent calls, 68.3% for main-thread calls, which
need the hook environment). The corpus is mostly subagent calls, so most Bash hook runs no longer start Node.

Every predicate errs only toward Defer. Any command longer than 65536 characters defers, and so does any command with a
non-ASCII character unless a subagent is proven: the write and heavy tests lean on JavaScript's UTF-16 indexing, wider `\s`
and case folding, while the trigger test of test 1 is exact on the command with the non-ASCII characters dropped or turned
into blanks (a character that lower-cases to ASCII still defers). Exact blocks are planned (D57) once the
engine carries the hook's environment and a block verdict with a stdout part.

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

`parity/run-jev.js` is the Jev lane's harness. The Node client at dev 3d36268 is the authority; both sides talk to a
loopback mock server and a fixture home, never the real network or home. It compares the outbound scrub, the HTTP request
bodies and headers, the decisions and the `jev-assist.ndjson` rows, and the resolved settings and modes:

```
node run-jev.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks --cmds <cmds.jsonl> [--scrub-n 12000 --fuzz-n 25000 --body-n 150]
```

| what | n | agreement |
|---|---|---|
| outbound scrub: real recorded commands (8,400 with secret-like text, 3,600 without) plus fuzz (25,000) plus edge cases | 37005 | **100%** |
| decisions (modes x trust x baselines x server answers x fallback x breaker x redirect x timeout x cache) | 711 | **100%** |
| request bodies and headers, per vendor | 1398 | **100%** |
| `jev-assist.ndjson` rows, field for field and in key order | 699 | **100%** |
| resolved settings and modes over a settings matrix | 418 | **100%** |
| shipped integration table against `settings-schema.js` | 43 | **100%** |

The one deliberate difference (a `true` advisory baseline is never lowered, D36) is asserted separately, not skipped;
relax-block and the `mode: "off"` row of a skipped call are identical to Node's and compared in full. The breaker state is
Node's own file (`cache/jev-breaker.json`), so hooks and engine share one breaker. A mutation run (a changed scrub rule and breaker threshold) drops agreement to 99.7%, so the
harness is not vacuous.

`parity/run.js` is the phase-2 decision-agreement harness for the regex rules; the force-push and AI-credit regex rules
are examples, not ports, because a regex cannot tokenize shell.

## Dispatcher parity and timing (`parity/run-dispatch.js`)

`ah-engine hook --event PreToolUse` against the separate Node hooks it replaces, Node hooks from `dev` at 3d36268:
the reference runs every matching hook as its own process at once (as the host does) and combines their outputs with
`parity/dispatch-lib.js`, an independent model of the host; the dispatcher answers git-guard with the built-in `git`
check and runs the other hooks through Node. Exit code, stdout and stderr are compared byte for byte (no trimming).
Each side has its own temporary HOME, every item its own session, and commands run in a throwaway git repo.

```
node run-dispatch.js --plugin <repo>/plugins/anti-hall --corpus corpus.jsonl [--host claude|codex] [--mode oneshot|daemon|both]
node fuzz-dispatch.js --out <dir> --n 3000 && node run-dispatch.js --plugin ... --corpus <dir>/corpus.jsonl --fallback-map <dir>/map.json
```

| corpus | host | n | oneshot (in-process checks) | daemon |
|---|---|---|---|---|
| committed git corpus `corpus.jsonl` | claude (9 Bash hooks) | 526 | **100%** | **100%** |
| real recorded commands, seeded sample | claude | 5000 | **100%** | **100%** |
| adversarial: several guards at once, odd payloads (no cwd, bad cwd, no command, numeric command) | claude | 61 | **100%** | **100%** |
| combination fuzz (`fuzz-dispatch.js`, seed 11): fake hooks printing blocks, JSON blocks, contexts, messages, decisions, plain text, non-zero exits, conflicting fields | claude | 3000 (707 blocks, 922 single, 873 merged, 392 conflicts) | **100%** | **100%** |
| committed git corpus | codex (7 Bash hooks) | 526 | **100%** | **100%** |
| review round 1 re-run (guards fail closed, conflicts in order): git corpus, claude and codex | claude, codex | 526 each | **100%** | **100%** |
| review round 1 re-run: real recorded commands, spread sample | claude | 1500 | **100%** | **100%** |
| review round 1 re-run: combination fuzz (seed 11, 141 conflicts delivered in order) | claude | 1000 | **100%** | **100%** |
| review round 2 re-run (fail-closed matrix, merged conflicts): git corpus | claude, codex | 526 each | **100%** | **100%** |
| review round 2 re-run: real recorded commands, spread sample (2 blocked) | claude | 1500 | **100%** | **100%** |
| review round 2 re-run: combination fuzz (seed 11; 221 blocks, 283 single, 454 merged, 141 conflicts delivered as one merged answer) | claude | 1000 | **100%** | **100%** |
| review round 4 re-run (genuine Stop block kept past a failed sibling, git alias from `GIT_CONFIG_*` env; corpus now 529): git corpus | claude, codex | 529 each | **100%** | **100%** |
| review round 4 re-run: real recorded commands, spread sample | claude | 1500 | **100%** | **100%** |
| review round 4 re-run: combination fuzz (seed 11) | claude | 1000 | **100%** | **100%** |
| adversarial | codex | 61 | **100%** | **100%** |
| real recorded commands, first 1250 of the sample | codex | 1250 | **100%** | **100%** |

The real-command sample is mostly silent in a fresh repo (13 of 5000 blocked, none produced two outputs), so the merge
rules rest on the fuzz corpus. Changing the context joiner and the decision order on purpose dropped the fuzz run to
95.5%, so the harness does see a wrong merge.

Wall time and CPU of a whole Bash PreToolUse event, median of 30, same machine and minute, with other work running
(CPU = the caller's child processes, so the daemon's own CPU is not counted):

| command | 9 Node hooks at once (host) | 9 Node hooks one by one | dispatcher, daemon | dispatcher, in-process |
|---|---|---|---|---|
| `ls -la` (allow) | 37 ms, 250 ms CPU | 240 ms, 220 ms CPU | 37 ms, 217 ms CPU | 38 ms, 227 ms CPU |
| force push (block) | 77 ms, 320 ms CPU | 417 ms, 353 ms CPU | 85 ms, 309 ms CPU | 85 ms, 310 ms CPU |
| commit then push | 105 ms, 391 ms CPU | 423 ms, 382 ms CPU | 67 ms, 319 ms CPU | 67 ms, 340 ms CPU |

With one of nine hooks built in, the event costs about what the host's parallel Node hooks cost: eight Node processes
still start. Each ported check removes one Node process per event; the D58 savings arrive with the ports (D57).

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

The extra daemon memory is the git check's tables (built once into sets) and the telemetry. Reading defaults is a snapshot lookup: the plugin's `engine/defaults/*.toml` are read at run time by the daemon, and the thin
client reads a one-file validated cache of them. (Before the amendment of D17 they were compiled into the binary, because the
first version of the defaults parsed the TOML at every start; measured by alternating the two builds in the same minute, `ah-engine version` took 3.7 to 3.8 ms
with the parse and 1.9 to 2.1 ms with the compiled-in data (a plain `true` takes 1.2 ms on this machine), so the parse
nearly doubled the client's start-up and was replaced; the cache keeps that win without compiling anything in, see D17.)

### Storage phase (D19-D27, D51, D52)

Measured 2026-10-05 on the same machine (macOS, M4 Max, brew rust 1.99, release build), **under heavy load**: other
lanes were compiling in parallel and the load average was 167-177 throughout, so absolute times are upper bounds. To make
the comparison fair, the build before storage (087b7f5, in-memory project state) and this build were run alternately,
three rounds each, with the same script (`scripts/measure-storage.py`: isolated HOME and state dir, a daemon started by a hook
call, empty rules). Values are the median of the three rounds; CLI times are each the median of 40 calls.

| | before storage (087b7f5) | this build | D73 bench (for reference) |
|---|---|---|---|
| CLI write, `proj <cwd> set k v` (wall, process spawn included) | 7.9 ms | 10.8 ms | n/a |
| CLI read, `proj <cwd> get k` | 8.8 ms | 8.6 ms | n/a |
| CLI `version` (no daemon involved: the spawn cost under this load) | 7.8 ms | 7.2 ms | n/a |
| acknowledged writes over the socket, one sequential client | 1,482 ops/s (memory, nothing synced) | 614 ops/s (each committed with `synchronous=FULL`) | 43k commits/s in-process, FULL |
| daemon RSS, idle | 2.6 MB | 4.2 MB | SQLite 7.3 MB at default caches |
| daemon RSS after 10k acknowledged writes | 2.8 MB | 5.2 MB | |
| `hot.db` / its WAL after 10k writes | n/a | 268 KB / 4.0 MB (the WAL auto-checkpoints at 1000 pages) | |
| after `ah-engine maintain` (16 ms) | n/a | `hot.db` 252 KB, WAL 4 KB, `archive.db` 20 KB | |
| binary size | 1,573,424 bytes | 2,663,328 bytes (+1.04 MiB) | SQLite +1.8 MB, redb +0.7 MB |

Reading it: under this load the CLI's cost is dominated by process start-up (the `version` row), so a durable write
costs about 1 to 3 ms more than the in-memory one and a read (served from the memory layer) costs the same. Over the
socket, the transport alone allows about 1.5k requests per second here; durability brings that to about 600, about 1 ms
per acknowledged write, which includes the full sync before each reply. That is far below D73's 43k in-process commits per
second because each request here is a new connection, a thread handoff and one commit per write (a single sequential
client cannot share a group commit: `db_commits` equalled `db_writes` at 10,040). The daemon stays within about a third of
the D25 target of 16 MB after 10k writes; the page cache is capped at 512 KB per connection (`storage.cache_kb`) and mmap is
off, which is why it is below D73's 7.3 MB. The binary grows by 1.04 MiB for the bundled SQLite, less than the 1.8 MB D73
measured (that bench used default features and no `opt-level = "z"`). A quiet-machine re-run is part of the benchmark
wave (D75, wave 4).

## Background process disclosure

When the binary is installed, the first hook call starts `ah-engine serve` as a detached background process (no launchd or systemd unit).
It runs per user, listens only on a Unix socket in a private (0700) directory, makes no network connections (only the opt-in `jev` commands do), runs at
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
- [x] Backup and restore (D27)
- [x] Metrics and impact persisted through the SQLite `Store` (D51, D52)
- [x] Storage phase measured (README, Measurements)
- [x] Config files: layered over the defaults, watched, validated, hot-swapped; `config`, `config validate` (D18, file part)
- [x] Shared read paths: transcript index (X1) and per-repo git cache (X3, D61); no check uses them yet (D75 wave 2)
- [x] Scheduler and ticker, `ah-engine schedule` (D33)
- [x] Jev lane: client, transports, modes, trust, cache, log, parity harness (D34-D38); wiring it into the dispatcher is planned (D58)
- [x] Per-event dispatcher: hand-maintained table, `hooks.json` generated from it with a byte-for-byte test, host matcher rules, Node hooks at once, built-in checks in the daemon or in-process, host-faithful combination, whole-event parity (D58)
- [ ] Mailbox (D45), config in storage and rollback (D18), build and release CI (D56, D64, D67, D68), porting the other guards (D57): later phases
