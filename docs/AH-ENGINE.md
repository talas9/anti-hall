# ah-engine

`ah-engine` is a small resident program that anti-hall's hooks can ask instead of starting a new Node process for every
tool call. This page explains what it is, why it exists, what works today and what is not built yet. Anything not built
is marked **planned** with the number of its decision, for example planned (D33) for the scheduler; each number is an entry
in [`ah-engine/DECISIONS.md`](../ah-engine/DECISIONS.md).
The exact list of commands, settings, metrics and error codes is generated from the engine itself and lives in
[`ah-engine/REFERENCE.md`](../ah-engine/REFERENCE.md).

**Status: off by default.** Nothing in the plugin starts or calls the engine unless it is turned on, and the plugin still
runs its Node hooks. Supported platforms: macOS and Linux (including WSL). Windows is not supported.

## Why it exists

Each Bash tool call used to start nine Node hooks before the tool and six after. Measured on the plugin at the time, the
nine pre-tool hooks peak at about 409 MB combined and use 187 ms of CPU, and Node's own start-up is 65 to 100 percent
of each hook's cost (D1). The problem is bloat, not start-up time. The engine answers the same questions from one
long-lived process of about 5 MB, called by a client of about 2 MB that starts in about 2 ms (D2). Every figure is
labelled with how it was measured in the README of `ah-engine/`.

## How it works

```
 host (Claude Code / Codex)
   |  hook JSON on stdin
   v
 ah-engine hook  --fallback <node hook>          (client, ~2 MB, ~2 ms)
   |  one framed request over a unix socket, hard 2 s budget
   v
 ah-engine serve                                 (daemon, one per user, ~5 MB)
   |-- rules (JSON file)        regex rules: deny / warn / context
   |-- checks (compiled in)     real logic a regex cannot express: the git check
   |-- telemetry                metrics in memory; impact ledger in hot.db
   |-- project state            per-project mailbox and key-value pairs, in hot.db
   |-- memory layer             active key-value items (budgeted, TTL) + pub/sub channels
   `-- storage                  hot.db + archive.db (SQLite, bundled), one writer thread
```

- **Client.** Reads the hook payload, asks the daemon, prints the answer. If anything is wrong (no daemon, busy, timeout,
  damaged reply, open breaker, crash loop) it runs the Node hook named by `--fallback` and passes its output and exit
  code through. It only allows silently when that Node hook is also unavailable (D11).
- **Daemon.** One per user, started by the first client that finds none (D5, D6). It stays up after the last session
  closes (D7): idle exit exists as the setting `daemon.idle_exit_s`, default 0 meaning disabled. A newer client gets its
  answer, then the old daemon drains and exits so the next call starts the new build (D8).
- **Rules.** `rules.json`, evaluated in file order; every match contributes and any `deny` wins. A rule may name a built-in
  check instead of a pattern.
- **Checks.** A check is Rust code behind the `Check` trait, registered by name. Today there is one: `git`, a port of the
  git-guard hook with 100 percent agreement with the Node original on every corpus tried (see the README of `ah-engine/`).

## What works today

| Area | Status | Decision |
|---|---|---|
| Daemon and client, single instance, version handoff, resident by default | implemented | D5-D8 |
| Never wedged: hard client budget, watchdog, breaker, crash-loop stop, bounded queue, per-request CPU budget | implemented | D9-D15 |
| Node fallback on every failure, never a silent allow | implemented | D11 |
| Failure classification, once-per-session advisory, secret-scrubbed diagnostics | implemented | D14 |
| Socket 0600, private directory, peer uid check, no network | implemented | D16 |
| Shipped defaults for every tunable, table, message, path, env-var name, limit and timeout | implemented | D17 |
| Built-in `git` check with exact parity to git-guard | implemented | D29-D31 |
| Check trait and registry, typed errors, documented code | implemented | D30, D39 |
| Agent CLI: `--json` on every command, read-only vs state-changing registry, generated reference | implemented | D50 |
| Metrics (counters, gauges, latency percentiles) and `ah-engine metrics` | implemented, in memory | D51 |
| Impact ledger and `ah-engine impact`, savings only as labelled estimates | implemented, stored in hot.db | D52 |
| Status headline summary | implemented | D50-D52 |
| Embedded SQLite storage: `hot.db` and `archive.db`, WAL, configured durability, versioned migrations, the `Store` trait over SQLite | implemented | D19, D21, D73 |
| Tiered lifecycle: write-through to SQLite then memory, active items only, byte budget, key-value with TTL, pub/sub channels | implemented | D20, D22, D25 |
| Pushing channel notifications to sessions (Monitor) | planned (D45) | D45 |
| Retention, archive mover, checkpoints and VACUUM | planned (D26) | D26 |
| Config loaded into versioned storage with reload and rollback | planned (D18) | D18 |
| Durable write spool when the engine is down | planned (D24) | D24 |
| Scheduler and ticker, `ah-engine schedule` | planned (D33) | D33 |
| Mesh messaging, Monitor push, chat database | planned (D45) | D45 |
| Jev decision lane inside the engine | planned (D34-D38) | D34-D38 |
| Backups and restore, `ah-engine backup` and `restore` | planned (D27) | D27 |
| Issue log and opt-in upload | planned (D28) | D28 |
| Update checks as a scheduled job | planned (D44) | D44 |
| One dispatcher call per hook event | planned (D58) | D58 |
| Porting the other guards | planned (D57) | D57 |
| Prebuilt binaries for every Unix target, release automation | planned (D56, D64, D67, D68) | D56, D64, D67, D68 |

## Commands

Every command accepts `--json` and prints one JSON object. Read-only commands never change state. The full table, with
arguments, is in the generated reference.

| Command | Read-only | What it does |
|---|---|---|
| `ah-engine hook` | no | The hook client: payload on stdin, answer on stdout. |
| `ah-engine serve` | no | Run the daemon in the foreground. |
| `ah-engine status` | yes | State, uptime, memory, counters, breaker, rules and a headline summary. |
| `ah-engine metrics` | yes | Metric series; `--check <name>` narrows to one check. |
| `ah-engine impact` | yes | What the engine affected; `--kind`, `--project` filter. |
| `ah-engine docs` | yes | The generated reference (`--format md`, or `--json`). |
| `ah-engine check <name>` | yes | Run one check on a payload from stdin (parity harness). |
| `ah-engine version` | yes | The version this build reports. |
| `ah-engine ctl <verb>` | no | `ping`, `reload`, `stop`, `status`. |
| `ah-engine stop` | no | Drain and exit. |
| `ah-engine reset` | no | Clear the breaker, crash-loop stop and failure record. |
| `ah-engine proj <cwd> <verb>` | no | Per-project state in `hot.db`: mailbox `put`, `take`, `len`; key-value `set`, `setex` (TTL in seconds), `get`. |
| `ah-engine schedule`, `config`, `backup`, `restore` | no | planned (D33, D18, D27); they say so and exit 64. |

## Metrics and the impact ledger

**Metrics** are counters, gauges and latency histograms kept in memory and bounded. Latency percentiles are reported as
the upper bound of the histogram bucket that holds that rank, so they are upper estimates. The registered names are:
`requests`, `busy_replies`, `errors`, `budget_trips`, `panics`, `rejected_peers`, `hook_calls`, `hook_latency_us`,
`check_calls`, `check_decisions`, `check_latency_us`, `rule_hits`, `rss_kb`, `queue_depth`, `uptime_s`, and for the
memory layer `tier_items`, `tier_bytes`, `tier_hits`, `tier_misses`, `tier_evictions`, `tier_expired`, `bus_published`
and `bus_dropped`, and for the writer `db_commits` and `db_writes` (fewer commits than writes means group commit is
sharing syncs).

**Impact events** record what the engine did to a call: `block`, `advisory`, `warning`, `context` and `fallback`. They
are stored in `hot.db` with exact per-combination totals, so counts survive a restart; the project is only ever a short
hash, never a path.

**Savings are estimates, never measurements.** A model-routing saving is the actual tokens the routed agent used times
the price difference between the model it asked for and the model selected, assuming the original model would have used
the same tokens. The method text is printed next to every figure, prices come from a configured price table that carries
its own date and source, and no figure is shown while no routing event has been recorded (planned, D52). A measured
benchmark, when one exists, is shown next to the estimate with its task set, model and date. None is registered yet.

Metrics live in memory only and reset when the daemon exits; snapshots in `hot.db` and rollups in `archive.db` are
planned (D51).

## Storage

The daemon keeps what it records in two SQLite databases inside the state directory (D19, D21). SQLite is compiled into
the binary, so there is nothing to install; it was chosen over redb by measurement (D73).

| File | Holds | Durability |
|---|---|---|
| `hot.db` | frequent small writes: impact events and their totals, per-project mailboxes and key-value pairs, applied write ids | WAL, `synchronous=FULL`: a write is on disk before it is acknowledged |
| `archive.db` | append-mostly history; opened on first use | WAL, `synchronous=NORMAL`, batched commits |

- **One writer, group commit (D23).** A single writer thread owns the `hot.db` write connection. Requests hand it their
  writes over a bounded queue (`storage.write_queue`; when it is full the write is refused as busy). The writer takes a
  write, gathers more for up to `storage.group_commit_ms` (default 0: only what is already queued, which still groups
  writes that arrive during a commit), commits them in one transaction and only then answers each one. Each write sits
  in its own savepoint, so a refused write never undoes its neighbours. Reads use a second connection.
- **Acknowledged means committed.** A project write is answered only after its transaction is on disk; a write that does
  not commit within `storage.ack_timeout_ms` is answered with an error, and its write id makes a retry harmless. The test
  `tests/durability.rs` kills the daemon with SIGKILL in the middle of a burst of writes from four threads, fifty times
  in a row, and checks after each restart that every acknowledged write is present, nothing present was invented or
  torn, and every write id matches exactly one row.
- **Hooks never wait on storage.** Impact events from the hook path are queued without waiting; a later read first waits
  for everything queued before it, so it sees them. If storage cannot open, the daemon logs why, shows it as `storage` in
  `status`, and keeps serving hooks with the impact ledger in memory.
- **Settings are keys.** Journal mode, synchronous level, `storage.fullfsync` (macOS power-loss safety, off by default:
  it cost about 99 percent of the commit rate when measured, D73), page cache, mmap, timeouts and the writer queue are all
  in `storage.toml`.
- **Tiered lifecycle (D20, D22, D25).** A write commits to SQLite first; only then does the writer make it active in
  memory, so memory follows the commit order and never holds anything SQLite does not. Memory holds only active items:
  a key set with `setex` stops being active when its TTL passes (it is dropped from memory and its row stays in SQLite),
  and past the byte budget (`tier.budget_kb`) the least recently used item is dropped, which loses nothing. A restart
  starts with an empty memory layer and promotes items again as they are read. A read that races a write never promotes
  the older value.
- **Pub/sub.** Each committed mailbox `put` or key `set` is announced on the channel `project:<hashed project>`. A
  subscriber has a bounded queue; publishing never blocks, and a slow subscriber loses notifications (counted as
  `bus_dropped`), never data. Delivering these to sessions is the Monitor push, planned (D45).
- **Idempotent writes.** A project write may carry a write id (`W <id>` in the request). The writer records the id with
  the result in the same transaction, so a repeat returns the first answer and changes nothing.
- **Nothing in memory alone.** Without storage every project operation is refused, so the client can retry and spool it.
- **Versioned schema.** Each database records how many migrations it has run (`PRAGMA user_version`); opening applies
  the missing ones, each in its own transaction, and re-running them changes nothing. A database written by a newer build
  is refused rather than rewritten.

## Reliability and safety

- **Hard budget.** The client enforces a total deadline (default 2 s) with a watchdog thread; `hooks.json`'s own timeout is
  the last safety net.
- **Fallback, never a silent allow.** A truncated, empty, corrupt, late or busy reply, an open breaker or a crash loop all
  run the Node hook (D11). Replies are length-framed and checksummed.
- **Breaker and crash loop.** Five failures in a minute open the breaker for a minute; four daemon deaths in ten minutes
  stop respawning for half an hour. Both are recorded and reported once per session.
- **Resource caps.** Bounded worker pool and queue (overflow answers busy, which means fallback), a per-request CPU budget,
  an RSS cap that restarts the daemon cleanly, `nice`, and per-session and per-project rate limits.
- **Security.** The socket is mode 0600 in a private 0700 directory the daemon owner-checks; the peer's uid is checked;
  there is no network code; payload text is never executed; state is partitioned per project.
- **No deletion.** The engine deletes nothing outside its own state directory.

## Configuration and data files

Defaults ship in `ah-engine/defaults/` and are compiled into the binary:

| File | Holds |
|---|---|
| `engine.toml` | environment variable names, paths and file names, daemon and client limits, project store caps, health policy, hook adapter, socket protocol |
| `messages.toml` | every message the engine produces (failure hints, advisories, replies, errors, command-line text) |
| `git.toml` | every table, limit, setting name and block message of the git check |
| `commands.toml` | the command registry data |
| `telemetry.toml` | the metric and impact-kind registries and the savings method |
| `storage.toml` | database file names, SQLite durability settings and the writer queue |

Each setting is a table with `value`, `doc` and optionally `env` (an environment variable that overrides a numeric value for
one process), `min`, `max` and `unit`. Code reads them through one module; a test fails the build if a tunable, table or
message is written in Rust instead (`no_hardcoded_tunables`), and another if code and defaults disagree. User-level
overrides loaded from files and versioned storage are planned (D18).

State lives in `~/.anti-hall/ah-engine/` (override with `AH_ENGINE_DIR`): `hot.db` and `archive.db`, the event log,
`failure.json`, the breaker and crash-loop markers, the run marker, the start counter and the per-session advisory stamps. The rules file is
`rules.json` there, or the path in `AH_ENGINE_RULES`.

## How to extend it

- **A new check.** Implement `Check` in its own module under `src/checks/`, list it in `checks::registry()`, put its
  tables and messages in a defaults file, and port its Node source with a parity corpus (`parity/`). The generated
  reference picks it up on its own.
- **A new setting, message, metric or impact kind.** Add the table to the right defaults file with a `doc`, use it from
  code, then regenerate `REFERENCE.md` (`cargo run -q -- docs --format md > REFERENCE.md`). The tests tell you if you forgot.
- **A new command.** Add its data to `commands.toml`, a handler in `src/cli.rs`, and regenerate the reference.
- **A new host.** Hosts share the hook payload field names today; a host with a different shape needs an adapter
  (D30). The planned dispatcher (D58) will make that explicit.

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

## Troubleshooting

| Symptom | What to do |
|---|---|
| Hooks are slow or the engine seems absent | `ah-engine status --json`: look at `running`, `breaker` and `crashloop`. |
| An advisory says the engine stopped after repeated failures | It is already running on the Node hooks. `ah-engine reset` clears the stop; file an issue with the diagnostic block it printed. |
| "state directory is not writable" | Fix ownership and mode 700 of `~/.anti-hall/ah-engine`, or point `AH_ENGINE_DIR` at a directory you own. |
| "socket path is too long" | Set `AH_ENGINE_DIR` to a shorter path. |
| Stop it | `ah-engine stop`. It starts again on the next hook call unless the engine is turned off. |
| A check misbehaves | Run `ah-engine check git` with the payload on stdin to see its verdict without a daemon. |

## FAQ

**Does it send anything off my machine?** No. The engine has no network code. Any upload of diagnostics would be opt-in
and disclosed first (D28, planned).

**What if the engine crashes or disagrees with the Node hook?** A crash or a bad answer falls back to the Node hook. A
disagreement is a bug in the engine: the parity harness compares exit code, stdout and stderr with the Node guard, and a
mismatch is fixed in Rust, never by changing the guard (D31).

**Why Rust?** The client uses about 2 MB against 44 MB for a Node process and answers in about 2 ms against about 20 ms
(D2). Numbers and how they were measured are in the README of `ah-engine/`.

**Is it on?** No. It stays off until parity and a shadow period pass (D31, D41).
