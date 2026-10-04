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
   |-- telemetry                metrics (snapshots + rollups), the impact ledger, and the lock-free telemetry recorder, stored
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
- **Small guard ports.** `merge-side-pick`, `ship-it-guard`, `scan-throttle`, `coordinator-work-guard` and
  `compact-declaration-guard` are the five small guards ported from Node. They share `checks/guardkit`: the switch and
  skip-file lookup, the message layout, JavaScript-exact regex translation and a per-session state store that lives in
  memory until storage is wired in (planned, D22). Where the Node verdict cannot be reproduced exactly (a block whose
  stdout and stderr the reply cannot carry yet, a regex construct, a classifier that lives in another port) the check
  defers, so Node decides.

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
| Built-in `merge-side-pick` check (advisory on a push after a one-sided conflict resolution) with exact parity | implemented, state in memory | D29-D31, D75 |
| Built-in `compact-declaration-guard` check: allows new work unless the turn may hold a declaration (the common case, read from the transcript tail); a possible declaration, and so every block, defers to Node | implemented | D29-D31, D75 |
| Built-in `coordinator-work-guard` check: answers every call the payload proves is not the main thread (88 percent of recorded Bash calls); the window itself defers to Node until the command classifier is ported (planned, D75) | implemented in part | D29-D31, D75 |
| Built-in `scan-throttle` check (advisory throttle prefix for user-configured heavy scans) with exact parity; patterns it cannot match exactly defer | implemented | D29-D31, D75 |
| Built-in `ship-it-guard` check (opt-in plan gate for Edit, Write and MultiEdit; Bash and apply_patch defer to Node) with exact parity | implemented | D29-D31, D75 |
| Check trait and registry, typed errors, documented code | implemented | D30, D39 |
| Agent CLI: `--json` on every command, read-only vs state-changing registry, generated reference | implemented | D50 |
| Metrics (counters, gauges, latency percentiles) and `ah-engine metrics`; snapshots in hot.db, rollups in archive.db | implemented | D51 |
| Impact ledger and `ah-engine impact`, savings only as labelled estimates | implemented, stored in hot.db | D52 |
| Status headline summary | implemented | D50-D52 |
| Telemetry recorder: every hook, check and rule run counted by kind, hook or check, event and outcome with latency buckets and injected bytes; lock-free hot path; flushed to hot.db; daily rollups in archive.db; `ah-engine telemetry` | implemented | D78 |
| Routing telemetry: route events joined to spawn results by `spawn_key`, NET savings in `ah-engine impact` | implemented (the check that writes route events is not ported yet; pre-engine data comes from transcripts, B5) | D77 |
| The telemetry rollup as a scheduled daily job (`telemetry_rollup`) | implemented | D33, D78 |
| Embedded SQLite storage: `hot.db` and `archive.db`, WAL, configured durability, versioned migrations, the `Store` trait over SQLite | implemented | D19, D21, D73 |
| Tiered lifecycle: write-through to SQLite then memory, active items only, byte budget, key-value with TTL, pub/sub channels | implemented | D20, D22, D25 |
| Transcript index: one incremental read of a session transcript, facts instead of lines, rebuilt on truncation or rotation | implemented as a library, not yet used by any check (planned, D75) | D22, D75 |
| Per-repo git cache: HEAD, branch, upstream, remotes, aliases, config values and the dirty bit, proven fresh by a file signature | implemented as a library, not yet used by any check (planned, D75) | D61, D75 |
| Pushing channel notifications to sessions (Monitor) | planned (D45) | D45 |
| Size control: retention, the hot-to-archive mover, WAL checkpoints and VACUUM, `ah-engine maintain` | implemented | D26 |
| Compressed export of old chat | planned (D26, D45) | D26, D45 |
| Config files layered over the shipped defaults, watched, validated and swapped in atomically; `config` and `config validate` | implemented | D18 |
| Config loaded into versioned storage, `config versions`, `rollback`, `export`, restart handoff for restart-only keys | planned (D18) | D18 |
| Durable write spool when the engine is down or busy: retry with backoff, fsync'd spool, drained exactly once in order | implemented | D24 |
| Scheduler and ticker: engine-side jobs (maintain, backups if enabled, metrics snapshot, spool drain), jitter, catch-up, timeouts, retry and cooldown, run history, `ah-engine schedule` | implemented | D33 |
| Agent-targeted jobs delivered to a session's mailbox | planned (D45) | D45 |
| Adding and removing jobs from the command line, schedules in versioned config | planned (D33, D18) | D33, D18 |
| Mesh messaging, Monitor push, chat database | planned (D45) | D45 |
| Jev lane: Vercel and TypeSafe transports with fallback and breaker, Noul and Choice calls, off/shadow/on modes, add-block and advisory trust, cache, async queue with budgets, the `jev-assist.ndjson` rows, `ah-engine jev` | implemented, one-shot only | D34-D38 |
| Jev wired into the dispatcher and the daemon, spend budget watch, audit snippets, daily rollups, persisted breaker and cache | planned (D58, D38) | D38, D58 |
| Backups and restore: online snapshot of both databases, scrubbed; restore keeps the current state first | implemented | D27 |
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
| `ah-engine metrics` | yes | Metric series; `--check <name>` narrows to one check; `--rollup minute\|hour [--since <s>]` shows stored rollups. |
| `ah-engine impact` | yes | What the engine affected; `--kind`, `--project` filter, `--window <7d>` for the NET section. |
| `ah-engine telemetry` | no | `summary`, `events`, `rollup`: see Telemetry below. `summary` and `events` only read; `rollup` writes, idempotently. |
| `ah-engine docs` | yes | The generated reference (`--format md`, or `--json`). |
| `ah-engine check <name>` | yes | Run one check on a payload from stdin (parity harness). |
| `ah-engine version` | yes | The version this build reports. |
| `ah-engine ctl <verb>` | no | `ping`, `reload` (also re-reads the config files), `stop`, `status`, `config`. |
| `ah-engine stop` | no | Drain and exit. |
| `ah-engine reset` | no | Clear the breaker, crash-loop stop and failure record. |
| `ah-engine maintain` | no | Size control: move inactive rows to `archive.db`, prune derived bookkeeping, checkpoint and VACUUM; prints a report. |
| `ah-engine proj <cwd> <verb>` | no | Per-project state in `hot.db`: mailbox `put`, `take`, `len`; key-value `set`, `setex` (TTL in seconds), `get`. A write the engine cannot take is spooled. |
| `ah-engine jev <ask\|status\|scrub>` | no | The optional Jev lane: `ask` reads JSON requests (one per stdin line) and prints each decision, `status` prints the resolved settings and every integration's mode (never a key), `scrub` redacts secrets from JSON strings. |
| `ah-engine backup [--to <dir>]` | no | A consistent, scrubbed snapshot of `hot.db` and `archive.db`; prints its manifest. |
| `ah-engine restore <snapshot-dir>` | no | Keep the current state as a pre-restore snapshot, stop the daemon, swap in the snapshot. |
| `ah-engine config [--json]` | yes | The effective config with the source of every value (`default`, `config_toml`, `settings`, `env`), the files read, the active version, any rejected edit and settings pending a restart. Asks the running daemon, else reads the files. |
| `ah-engine config validate <file>` | yes | Check an engine TOML file against the schema: exit 0 when valid, 1 with the reason when not. |
| `ah-engine config versions`, `config rollback`, `config export` | no | planned (D18, they need the config database); they say so and exit 64. |
| `ah-engine schedule list\|run <job>\|history` | no | The scheduler's jobs with their next run and last result; run one now; the run history. |

## Metrics and the impact ledger

**Metrics** are counters, gauges and latency histograms kept in memory and bounded. Latency percentiles are reported as
the upper bound of the histogram bucket that holds that rank, so they are upper estimates. The registered names are:
`requests`, `busy_replies`, `errors`, `budget_trips`, `panics`, `rejected_peers`, `hook_calls`, `hook_latency_us`,
`check_calls`, `check_decisions`, `check_latency_us`, `rule_hits`, `rss_kb`, `queue_depth`, `uptime_s`, and for the
memory layer `tier_items`, `tier_bytes`, `tier_hits`, `tier_misses`, `tier_evictions`, `tier_expired`, `bus_published`
and `bus_dropped`, for the writer `db_commits` and `db_writes` (fewer commits than writes means group commit is sharing syncs), and for
the spool `spool_applied` and `spool_quarantined`, for the scheduler `schedule_runs` and `schedule_missed`, and for
size control `db_hot_bytes`, `db_hot_wal_bytes`,
`db_archive_bytes`, `db_archive_wal_bytes`, `maintain_runs` and `maintain_last_ms`, and for the Jev lane `jev_calls`, `jev_verdicts`, `jev_cost_micro_usd`, `jev_timeouts`, `jev_cooldowns`, `jev_changed` and `jev_latency_us`.

**Impact events** record what the engine did to a call: `block`, `advisory`, `warning`, `context` and `fallback`. They
are stored in `hot.db` with exact per-combination totals, so counts survive a restart; the project is only ever a short
hash, never a path.

**Savings are estimates, never measurements.** A model-routing saving is the actual tokens the routed agent used times
the price difference between the model it asked for and the model selected, assuming the original model would have used
the same tokens. The method text is printed next to every figure, prices come from a configured price table that carries
its own date and source, and no figure is shown while no routing event has been recorded (planned, D52). A measured
benchmark, when one exists, is shown next to the estimate with its task set, model and date. None is registered yet.

Metrics are counted in memory. Every `telemetry.snapshot_ms` (default a minute) and when the daemon exits, the counters
and histograms are snapshotted into `hot.db`, and the same snapshot is rolled up into `archive.db` per resolution
(`telemetry.rollups`: per minute kept 24 h, per hour kept 30 days; pruned by `ah-engine maintain`). A new daemon starts
from the last snapshot, so counts survive a restart; after a crash they lose at most what came after the last snapshot.
Gauges are live readings and are not kept. `ah-engine metrics --rollup minute --since 3600` lists the stored rollups.

## Telemetry (D78, D77)

Telemetry answers "what did the engine and the hooks do, how often, how long did it take and how much did it inject into
the model's context", without ever recording content. It is local only: nothing is uploaded, and it is disclosed in
`PRIVACY.md`. `telemetry.enabled` (default on) turns recording off; `telemetry.flush_ms` and `telemetry.retention_days`
tune it (all in `telemetry.toml`).

**What is recorded.** For every hook request the daemon serves, one row `k=hook`; for every built-in check it runs
(including the `git` check) one row `k=check` with the check as `h`; for every regex rule match one row with `h=rule`. Each
row is counted by `h` (hook or check), `e` (hook event) and `o` (outcome: `allow`, `block`, `advise`, `defer`, `error`,
`skip`), with a latency histogram (`ms` buckets, `telemetry.latency_buckets_us`) and `ib`, the bytes injected into model
context. The `hook` rows add up to the total injected; a check's own `ib` is attribution inside it. This is automatic: the
dispatcher records around every check, so a newly ported check needs no telemetry code. Rich events carry typed extras:
`route` (a model-routing decision: requested and parent model, task class, recommended tier, `down` / `up` / `allow` /
`exempt`, and the `spawn_key`), `spawn` (the result: the model that ran and its token usage, joined to the route event by
`spawn_key`), `jev` (integration, mode, verdict, cost) and `spill`. An event's text fields hold identifiers only: the type
refuses prose, and a line with an unknown field or text where an identifier belongs is rejected, so no prompt, transcript
or file text can be stored.

**Cost on the hook path.** Recording is a hash of the labels and a few relaxed atomic additions into a sharded table, plus
a bounded in-memory ring for rich events: no I/O and no shared lock. Measured by `tests/telemetry.rs` (release build): the
`record()` median is under 1 microsecond (the test asserts it, alone and with four threads hammering the same labels).

**Persistence and the loss window.** The recorder flushes to `hot.db` every `telemetry.flush_ms` (default 10 s) and at a
clean shutdown, through the Store's writer. A `kill -9` (or power loss) loses exactly what was recorded after the last
flush: at most `telemetry.flush_ms` of data. Everything flushed survives (`tests/telemetry.rs` kills a daemon and reads the
database). Samples that could not be kept (a full table, an event overwritten in the ring before a flush) are counted in
`tel_dropped`, never silently lost. Counters also feed the metrics registry (`tel_events`, `tel_injected_bytes`), so
`ah-engine metrics` shows the same numbers.

**Daily rollups.** `hot.db` keeps one counter row per UTC day and (k, h, e, o). `ah-engine telemetry rollup` copies every
complete day into `archive.db` (counts, sums and latency histograms), replacing the archive row, so it is idempotent, and
removes hot rows older than `telemetry.retention_days` only after they are archived (and old events by the same
retention). The scheduler runs it daily (job `telemetry_rollup`, `schedule.telemetry_rollup_ms`); the command runs it by hand.

**Reading it.** `ah-engine telemetry summary [--window 7d]` (per hook and check: invocations, outcomes, p50/p95/p99 latency
upper bounds, injected bytes), `ah-engine telemetry events [--kind route] [--window 7d] [--limit n]`. With a daemon they
include data not yet flushed; without, they read the database and say so.

**NET savings.** `ah-engine impact --json [--window 7d]` joins route events to spawn results (a re-spawn after a steer is
compared against what the agent first asked for) and reports, in both directions, what steering saved (the tokens the agent
used times the price of the model it asked for minus the price of the model that ran) and what steering up cost, minus the
spenders: injected context (injected bytes over `telemetry.bytes_per_token`, priced as input tokens of the most common
parent model) and recorded Jev cost. Every figure is labelled an estimate and states its method. Prices come from
`impact.price_table`; it has no verified prices yet, so spawns are counted as unpriced and no dollar figure is invented.

## Storage

The daemon keeps what it records in two SQLite databases inside the state directory (D19, D21). SQLite is compiled into
the binary, so there is nothing to install; it was chosen over redb by measurement (D73).

| File | Holds | Durability |
|---|---|---|
| `hot.db` | frequent small writes: impact events and their totals, per-project mailboxes and key-value pairs, applied write ids | WAL, `synchronous=FULL`: a write is on disk before it is acknowledged |
| `archive.db` | append-mostly history: consumed messages, expired key values and old impact events moved out of `hot.db`; opened on first use | WAL, `synchronous=NORMAL`, batched commits (synced like `hot.db` while maintenance moves rows) |

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
- **The spool (D24).** `ah-engine proj` gives every write an id and sends it; while the daemon is absent (the client
  starts it), busy or failing, it retries with exponential backoff and jitter (`spool.retries`, `spool.backoff_ms`). If
  there is still no answer, a write (`put`, `set`, `setex`) is appended to `spool.log` in the state directory, framed,
  checksummed, under a file lock and fsync'd, and the command reports `spooled <id>`. A `take` is never spooled, since
  it needs an answer. The daemon applies the spool on start, every `spool.drain_ms`, and before each project write
  (so a spooled write lands before a newer direct one), in file order, which keeps each session's order
  (`AH_ENGINE_SESSION` names the session). Each record carries its write id, so applying it twice changes nothing. A
  record that is damaged, or that the store refuses for good (a full mailbox), goes to `spool.quarantine` with its
  reason; nothing is dropped. The spool is capped (`spool.max_bytes`): past the cap the write is refused, so the caller
  knows it was not kept. Hooks do not write project state today; they will use the same path when they do.
- **Size control (D26).** `ah-engine maintain` moves what has left its active life from `hot.db` to `archive.db`:
  consumed messages after `retention.mailbox_consumed_s`, key values expired longer than `retention.kv_expired_s`,
  impact events older than `retention.impact_hot_s` or beyond `retention.impact_hot_rows` (their totals stay). Each
  batch is committed to `archive.db` before it leaves `hot.db`, and a repeated copy is a no-op, so a crash in between
  loses and duplicates nothing. It then forgets applied write ids older than `retention.applied_s` (derived
  bookkeeping, D59), checkpoints both WALs and VACUUMs both databases, and records the run. Archived user data is never
  deleted unless `retention.archive_delete_after_s` is set (default 0, D26). It runs in its own process against the
  files, beside a live daemon or without one; SQLite's locks keep the two apart, and a daemon write that meets the lock
  is retried and, if need be, spooled. The scheduler runs it as the daily `maintain` job (`schedule.maintain_ms`).
- **Backup and restore (D27).** `ah-engine backup` copies both databases with SQLite's online backup API, so the
  snapshot is consistent while the daemon writes, into `backups/<ms>/` in the state directory (or `--to <dir>`, never
  over an existing snapshot). The copy is scrubbed: message bodies, values and recorded results
  (`backup.scrub_columns`) lose anything that looks like a secret and the home path, the file is VACUUMed so no
  unscrubbed page remains, and each file is integrity-checked and listed in `manifest.json`. Project keys stay as they
  are, because a restore needs them. `ah-engine restore <dir>` checks the snapshot first (integrity, schema version),
  then keeps the current state as an unscrubbed `backups/pre-restore-<ms>/` snapshot that it never deletes, stops the
  daemon and holds its lock so none starts, and copies each database into place with the same API. The next hook call
  starts a daemon on the restored state.
- **Versioned schema.** Each database records how many migrations it has run (`PRAGMA user_version`); opening applies
  the missing ones, each in its own transaction, and re-running them changes nothing. A database written by a newer build
  is refused rather than rewritten.

## Shared read paths: the transcript index and the git cache

Two facts sources the guards will share instead of each re-reading a transcript or spawning `git` themselves. Both are
libraries inside the engine (`src/transcript/`, `src/gitcache/`); no check calls them yet, the checks that do are ported
in wave 2 (planned, D75).

**Transcript index (`ah_engine::transcript`).** At least 20 hooks read the session transcript, each in its own process,
so a Stop with 11 hooks read the same tail up to 11 times. An `Index` follows one transcript file and keeps a byte
offset at a line boundary. A refresh reads only the appended bytes. The first refresh reads the last
`transcript.initial_window_bytes` (the same 1.5 MB window and dropped partial first line as `hooks/lib/transcript-tail.js`).
What it keeps, all bounded by `transcript.toml`:

| Fact | Mirrors |
|---|---|
| record counts by kind, malformed lines, sidechain, meta and compact-summary rows, compaction boundaries | the filters in `devswarm-idle.js`, `inference-check.js` and `compact-advice.js` |
| the newest assistant text, in the deduplicated and in the legacy extraction | `speculation-guard.js` `collectTextFromEntryDedup` and `collectTextFromEntryLegacy` |
| the newest typed user prompt | `inference-check.js` `lastUserPrompt` |
| the newest tool uses of any tool | `task-state.js` `collectTU` |
| the task-tool uses and their string results, in order | what `task-state.js` `reconstructTasks` reads |
| every `<task-notification>` block, from all three transcript shapes (a `user` entry, an `attachment` prompt, a `queue-operation` content), with the terminal-agent view of `agent-scan.js` and the final-key view of `devswarm-idle.js` | `notificationTexts`, `finishedTaskKeys`, `scanTranscript` |
| `task_status` attachments that a compaction writes for live agents | `agent-scan.js` |

Safety: a file smaller than the offset (truncation), a different device or inode (rotation), or a changed start or
changed bytes just before the offset (a rewrite) throws the facts away and rebuilds them from the file, so the index can
always be recreated from the transcript alone. A last line without a newline is shown through a one-record overlay and
never counted twice. More than `transcript.max_update_bytes` appended between two refreshes skips ahead to the newest
bytes and counts a gap. An `Indexes` registry holds one index per path, at most `transcript.max_indexes`, and drops an
idle one after `transcript.idle_ttl_ms` (D22: memory holds only active items). Parity with the Node readers is checked by
`tests/transcript_parity.rs` and, over real transcripts, by `parity/run-transcript.js`.

**Git cache (`ah_engine::gitcache`).** Guards spawn `git` for the branch, the remotes, the aliases, the work tree root
and the dirty state. `GitCache::repo(dir, env)` finds the repository the way git does from a directory (a `.git`
directory, or a `gitdir:` file for a submodule or a linked worktree, with `commondir` followed) and returns a handle whose
methods answer from memory while a signature of the repository's files is unchanged, else run `git` once.

| Fact | Method | Fresh equivalent |
|---|---|---|
| work tree root, absolute git directory | `toplevel`, `git_dir` | `rev-parse --show-toplevel`, `--absolute-git-dir` |
| commit and branch | `head`, `branch` | `rev-parse HEAD`, `symbolic-ref --short HEAD` |
| upstream and remotes | `upstream`, `remotes` | `rev-parse --abbrev-ref --symbolic-full-name @{upstream}`, `remote` |
| aliases | `aliases` | `config -z --get-regexp ^alias\.`, parsed like `git-alias-scan.js` |
| one config value | `config_get`, `config_path` | `config --get`, `config --path --get` |
| dirty bit | `dirty`, `dirty_exact` | `status --porcelain=v1` |

The signature (D61) holds the content of `HEAD` and of the branch ref it names, and the stat (device, inode, size, mtime,
ctime) of the index, the repository and per-worktree config, `packed-refs`, the user's global and system config, and, for
the upstream fact, the remote-tracking directories. Git replaces these files by rename, so a commit, a checkout, a config
change or a fetch changes the signature even within one clock tick. A hard TTL (`gitcache.ttl_ms`) applies as well.
Limits that the signature cannot see are handled in the open: a working-tree edit changes none of those files, so the
dirty bit has its own short TTL (`gitcache.dirty_ttl_ms`) and `dirty_exact` always asks git (a destructive decision must
use it); `include.path` and `GIT_*` overrides are not signed, so a call whose environment sets one of
`gitcache.bypass_env` is refused (`Bypassed`) and the caller runs git itself. A run that times out or fails to start is an
error and is never remembered; an exit status other than 0 is remembered as "git said no". `tests/gitcache_parity.rs`
compares every fact with a fresh `git` invocation on a plain repository, a linked worktree and a submodule, before and
after commits, amends, resets, branch switches, detached HEAD, `pack-refs`, config changes, fetches and stashes.

## Scheduler

The engine runs its own jobs on an internal ticker; nothing outside it (cron, a hook, a session) has to trigger them
(D33). The jobs ship in `schedules.toml`; `schedules.json` in the state directory can change or disable one, or add one
that uses a known action (`{"jobs": {"maintain": {"every_ms": 3600000}}}`); it is read when the daemon starts, and job
definitions in the config database are planned (D18). A shipped job's interval is a setting (`schedule.maintain_ms`,
`schedule.backup_ms`, `telemetry.snapshot_ms`, `spool.drain_ms`) read through the layered config on every planning pass,
so setting it in `config.toml`, `settings.json` or the environment takes effect without a restart; 0 pauses the job.

| Job | Does | Default interval | Runs as |
|---|---|---|---|
| `maintain` | size control (D26) | daily (`schedule.maintain_ms`) | a subprocess, killed with its process group at its timeout |
| `backup` | a scrubbed backup (D27) | off (`schedule.backup_ms` = 0) | a subprocess |
| `metrics_snapshot` | metrics snapshot and rollups (D51) | a minute (`telemetry.snapshot_ms`) | in the daemon |
| `spool_drain` | applies spooled writes (D24) | a second (`spool.drain_ms`) | in the daemon |

- **Timing.** The ticker sleeps until the next job is due (at most `schedule.tick_ms`). Each next run is one interval
  after the current one starts, plus up to `jitter_ms`, so jobs do not run in step.
- **No double runs.** A job never overlaps itself. A persisted job's next time is committed to `hot.db` before its run
  starts, so a restart (or a crash) never runs it twice; runs a killed daemon left open are marked `interrupted`.
- **Missed windows.** After the machine slept or the engine was down, a job set to `catch_up = "once"` runs once, then one
  interval later; a job set to `"skip"` waits for its next window. Never once per missed window.
- **Timeouts, retries, cooldown.** A run past its `timeout_ms` is stopped (a subprocess job is killed with its process
  group; an in-process one is recorded as timed out and the job waits for it before running again). A failed run is
  retried with exponential backoff (`retries`, `backoff_ms`, `backoff_max_ms`), then the job cools down (`cooldown_ms`).
- **History.** Every run of a persisted job, and every failed run of the others, is kept in `hot.db`
  (`ah-engine schedule history`); `maintain` forgets runs older than `retention.schedule_runs_s`.
- **Agent jobs.** A job of kind `agent` is meant for a session's mailbox; until that lands (planned, D45) each of its
  runs is recorded with the status `planned` (D45), never as a failure.

## The Jev lane

Jev is TypeSafe's "System One" decision model, reached through the Vercel AI Gateway or TypeSafe's own API. It is optional
and off by default: with it off, missing, over budget or failing, every caller gets its own deterministic baseline, which is
exactly what it would get without the lane (D35). Anything a deterministic rule can decide never goes to Jev (D34); only
judgement calls do.

- **Questions.** A Noul question is yes/no (the answer is true when the reported probability is at least a half, and the
  confidence is how far from a half it is); a Choice question picks one labelled option. The request body is written byte
  for byte as the Node client writes it, after the one outbound scrub that redacts secrets (tokens, keys, URLs with
  credentials, emails, long opaque runs).
- **Vendors and keys.** The primary vendor is `jev.transport`; an optional backup (`jev.fallbackTransport`) is tried once,
  inside the same time budget, after a timeout, a network error, a 5xx, a 402, a 429, or a 400 or 403 that names an exhausted
  balance. A rejected key (401) is never masked by the backup. Each vendor has its own circuit breaker: after three
  consecutive eligible failures it is skipped for five minutes, then probed once. A key goes only to the vendor it was entered
  for, only in the Authorization header; a redirect is never followed and a proxy variable is never used. A test endpoint
  override is honoured only for a loopback host (`127.0.0.1`, `[::1]`, or `localhost`, which is rewritten to the literal so it is
  never resolved), and the connection is made through a resolver that returns only loopback addresses.
- **Modes.** Each integration (the table in `jev.toml`, with the defaults from the Node settings schema) is `off`, `shadow`
  or `on`. `shadow` consults Jev and logs what it would have changed but never changes an outcome. `on` applies the call's
  trust rule: `add-block` may turn a non-blocking baseline into a block; `advisory` may supply a label or an advisory. Jev
  never removes a block or an advisory, and it is never the only safety gate (D36). The Node `relax-block` rule is observe-only
  here.
- **Cost of being off.** A disabled Jev costs a call one settings snapshot and nothing else: no hash, cache lookup, network,
  thread or log write.
- **Budget, queue, cache.** A call has a time budget (default 1.5 s, at most 3 s) covering connect, request and body. A
  caller either waits for it (`ask`) or queues it and moves on (`ask_async`: a bounded queue, a worker thread started on first
  use, a full queue answered with the baseline). Answers are cached by content hash, bounded to 500 entries, in memory for
  now (persisting them in `hot.db` is planned, D21). The key covers the vendor, model and endpoint, so one session's answer is
  never served to a session that would have asked someone else, and an answer from a test endpoint override is never cached.
- **The log.** One row per decision in `~/.anti-hall/logs/jev-assist.ndjson`, in the row shape `jev report` reads: hashes,
  verdicts, confidences, latencies, costs and the reason a call produced nothing; never prompt text, never a key. It rotates
  at 2 MB. The daily rollups and the spend budget watch the Node client also writes are planned (D38).
- **Parity.** `parity/run-jev.js` checks request bodies, headers, decisions, log rows, settings and the scrub against the Node
  client (`ah-engine/parity/run-jev.js`). The deliberate differences (relax-block, a `true` advisory baseline, no row for an
  off call) are asserted separately.

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
| `small_guards.toml` | patterns, switches, limits and messages of the small Bash guard ports and their shared helpers |
| `commands.toml` | the command registry data |
| `schedules.toml` | the scheduled jobs (maintain, backup, metrics snapshot, spool drain) and the scheduler settings |
| `telemetry.toml` | the metric and impact-kind registries, the savings method and the telemetry settings (`telemetry.enabled`, `telemetry.flush_ms`, `telemetry.retention_days`, table sizes and window defaults) |
| `storage.toml` | database file names, SQLite durability settings, the writer queue and group-commit window, the in-memory layer, the spool, retention, backups |
| `config.toml` | config layering: file names, watch and debounce timing, boolean tokens, restart-only settings, config messages |
| `transcript.toml` | the transcript index: window and update caps, kept-fact counts, status sets, registry size and idle time |
| `gitcache.toml` | the git cache: git invocations, timeouts, TTLs, signed file names, the bypass environment, messages |
| `jev.toml` | the Jev lane: vendor endpoints and models, budgets, breaker and fallback timing, the integration table with its default modes, cache and log limits, key-file rules, messages |

Each setting is a table with `value`, `doc` and optionally `env` (an environment variable that overrides a numeric value for
one process), `min`, `max` and `unit`. Code reads them through one module; a test fails the build if a tunable, table or
message is written in Rust instead (`no_hardcoded_tunables`), and another if code and defaults disagree. User-level
overrides are layered on at start and on every change (below); persisting each version in storage is planned (D18).

### Config layering and hot-swap (D18)

Highest layer first, mirroring `get()` in `plugins/anti-hall/hooks/lib/settings.js`:

1. **Environment**: the setting's own `env` variable (numeric settings).
2. **`settings.json`**: `~/.anti-hall/settings.json` (or `AH_ENGINE_SETTINGS`), the file the Node settings code reads. The setting `section.key` is `settings[section]` then `key`, flat or dotted-nested, coerced like Node (trimmed, bad values fall through, numbers clamped, booleans accept `1/on/true/yes` and `0/off/false/no`).
3. **`config.toml`** in the state directory (or `AH_ENGINE_CONFIG`): the engine's own file, written as `[daemon]` then `queue = 32`. It is strict: an unknown key, a wrong type or an out-of-range number invalidates the file.
4. **The shipped default.**

The daemon watches both files (polling, `config.watch_ms`, debounced by `config.debounce_ms`) and on `ctl reload`/SIGHUP.
A change is parsed and validated first and swapped in only if valid; a request takes one snapshot when it starts and sees
that version throughout. An invalid or unreadable file keeps the last good config and logs `config_invalid`; a deleted
file falls back to the next layer. A corrupt `settings.json` counts as invalid here (Node reads it as empty), so a
half-written edit cannot swap the daemon to defaults. Settings in `config.restart_only` keep their running value until
the next start and are listed as `pending_restart`; an automatic handoff for them is planned (D18). Today the swap
reaches every daemon limit (`daemon.*`: request and reply deadlines, size and CPU budgets, queue, rate limits, watchdog
and idle timing); moving the remaining readers of shipped defaults onto the snapshot is incremental work (D17).

State lives in `~/.anti-hall/ah-engine/` (override with `AH_ENGINE_DIR`): `hot.db` and `archive.db`, the write spool
`spool.log` and its `spool.quarantine`, the `backups/` directory, the optional `schedules.json`, the event log,
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
| Undo a bad restore | Every restore keeps the state before it in `backups/pre-restore-<ms>/`; restore that directory. |
| `hot.db` keeps growing | Run `ah-engine maintain` (it reports what it moved and the sizes before and after); see the `retention.*` settings. |
| `proj` printed `spooled <id>` | The engine was down or busy; the write is safe in `spool.log` and is applied when the engine runs. |
| `spool.quarantine` has entries | Records that were damaged or refused for good (for example a full mailbox), each with its reason; nothing was dropped. |
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
