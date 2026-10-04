# ah-engine decision record

**Version: 1.59** (2026-10-05). Bump the minor version for each added or changed decision, and add a line to the Revision log at the end.

Status: living document. Owner decisions from 2026-10-04, recorded in the order they were made. Where a later decision supersedes an earlier one, that is stated. Branch: `engine-proto`.

## Why an engine

- **D1. The problem is bloat, not start time.** Measured on 0.201.0: each Bash call spawns 9 Node hooks before the tool runs and 6 after. The 9 PreToolUse hooks peak at about 409 MB combined and use 187 ms of CPU. Node start costs about 16 ms of CPU and 44 MB per process, which is 65–100% of each hook's cost. Machine-wide that is about 196k hook processes and about 68 CPU-minutes a day (estimate), plus about 300 MB of resident ingest daemons.
- **D2. Language: Rust.** Prototype measurements: the client uses 2.0 MB vs 44 MB for Node, a call takes 2.9 ms vs 19.7 ms, the daemon is 3.7 MB, and the binary is 1.1 MB. Shipping is unix-only: macOS and Linux, including WSL.
- **D3. One system-wide engine per user (the gateway).** Every project and session registers with it, sending project path, role (Rick, Meeseek or plain), plugin version and host. It replaces the DevSwarm daemons, cron ticks, supervisor, reaper, wake-watch and Jev worker.
  - Any agent that starts also starts the engine, and keeps a Monitor task running for the whole session so it can receive messages from the engine. The engine likewise receives messages from every agent: Ricks, Meeseeks and plain sessions.
  - Source: "we make one system wide very thin ... all projects report to it including project path ... any agent that starts starts it and have monitor task running all time so it can receive messages from it, and vice versa the engine can receive messages from all agents, ricks and meeseks" (2026-10-04T17:19:12Z).
- **D4. The engine is generic.** The binary is rebuilt only when the engine itself changes. Rules and behaviour are data.

## Process and lifecycle

- **D5. Every hook makes sure the engine is running.** A shared `ensure_running()` step checks for the engine and starts it under a lock. SessionStart pre-warms it without blocking.
- **D6. Single instance.** A lock file and a bind probe make sure 20 concurrent cold starts produce exactly one engine. Stale locks and sockets are recovered only after the old owner is verified dead.
- **D7. Resident.** The engine stays up after all sessions close, so the scheduler and mailbox keep running. Idle exit defaults to disabled; config can enable it. *Supersedes the earlier "idle exit" default.*
- **D8. Version handoff.** A newer client gets its answer, then the old engine drains and exits, and the next call starts the new build. Restart-only changes use drain-and-handoff. The engine never goes offline.

## Reliability and safety

- **D9. Never wedged.** The client enforces a hard total budget (about 2.5 s, from config) through a watchdog thread. The engine holds no locks across I/O, every channel is bounded, and workers send heartbeats. Subprocesses run with a timeout and are killed as a process group. hooks.json `timeout` is the final safety net.
- **D10. The watchdog is a last resort.** Every intervention is logged as a bug and counted in `status`. Normal tests and parity runs require zero interventions.
- **D11. Fallback, never a silent allow.** A truncated, empty, malformed, late or busy reply runs the Node guard for that hook. Allow happens only if the Node fallback is also unavailable. Replies are length-framed and checksummed.
- **D12. Error handling and recovery.**
  - Per-check `catch_unwind` with a time budget.
  - No panics on any input; the tokenizer is fuzzed.
  - Last-known-good config.
  - Fault-injection tests: kill -9, corrupt socket, unreadable config, disk full, slow git, clock jump.
- **D13. Retry, backoff, cooldown.**
  - Retries apply only to transient, idempotent failures, within the deadline.
  - Backoff is exponential with jitter.
  - The breaker has a cooldown with a half-open probe, and Jev gets a cooldown on 429.
- **D14. Error reporting.**
  - One reporter with typed codes, deduplicated and rate-limited, feeding the issue log.
  - Advisories appear at most once per session per code.
  - Environment errors get a self-fix hint. Permanent non-environment errors get a "please file an issue" advisory with a scrubbed diagnostic. Issues are never filed automatically.
- **D15. Resource caps.** Bounded pool and queue (overflow returns `busy`, which triggers the fallback), `nice`, a per-request CPU budget, an RSS budget, and per-session and per-project rate limits.
- **D16. Security.**
  - Socket mode 0600, directory 0700, owner-checked.
  - Peer uid is checked.
  - No network unless configured.
  - Never execute message payloads.
  - State is partitioned per project, with isolation tests.
  - Nothing is deleted outside the engine's own state dir.

## Configuration

- **D17. No hardcoding, enforced by tests.**
  - Every parameter, setting, table, message text, env-var name, path, limit and schedule lives in shipped `defaults/*.toml`, which user config overrides.
  - Code keeps only structural constants, each commented.
  - The embedded fallback `include_str!`s the same files.
  - The `no_hardcoded_tunables` test fails the build on violations.
  - A docs test checks that every key is documented, and the reverse.
- **D18. Config load model (final).**
  - Files are the source of truth.
  - On startup, on `engine reload`, or when the file watcher fires (debounced), all files are validated, then imported in one transaction into `hot.db` as a numbered version.
  - The active config is swapped atomically: no restart, data untouched, in-flight requests finish on the old version.
  - A bad edit keeps the current version.
  - CLI: `config versions`, `config rollback`, `config export`.
  - Restart-only keys (socket path, memory hard cap, DB paths) take effect through a handoff.
  - *Supersedes the earlier "no file watching" and "hot-reload" notes.*

## Data and storage

- **D19. Embedded storage only; nothing for the user to install.** Bundled SQLite (`rusqlite` with the bundled feature) is the planned backend for queries, transactions, FTS and JSON, and it is compatible in place with the existing `node:sqlite` DevSwarm store. A redb backend may be benchmarked. All storage sits behind a `Store` trait.
- **D20. Thin built-in "redis".** An in-memory layer inside the engine provides key-value with TTL, pub/sub channels (sessions, projects, roles) for Monitor push, bounded queues and counters. It has no separate server and no port.
- **D21. Two stores.**
  - `hot.db` (small, frequent access): config, rules, messages, schedule index, pending mailbox, registry, and rate and breaker state.
  - `archive.db` (large, append-only history): opened on demand, with caps and retention.
- **D22. Tiered lifecycle for ALL data.** Each write commits to SQLite first, then becomes active in memory. Memory holds only active items. When an item's lifecycle ends, it is dropped from memory and kept in SQLite. A restart rebuilds only the active items. One generic `Tiered<T>` mechanism covers every data kind.
- **D23. Real-time durability.** Every write is committed before it is acknowledged, using group commit. The default is WAL with `synchronous=FULL` for `hot.db`. Purely derived caches may stay memory-only and are labelled per kind.
- **D24. Nothing is lost with the engine down.** Hook writes retry with backoff. If the engine still fails, the write goes to a durable local spool: fsync'd, framed, checksummed, with an idempotency key. The engine drains the spool exactly once. Corrupt records go to quarantine and are never dropped. The spool is capped.
- **D25. Memory budget.**
  - Caches are LRU, capped in bytes.
  - SQLite `cache_size` is capped, mmap is off or capped, and results are streamed.
  - The RSS budget defaults to about 16 MB (target, to be measured). Over budget, caches are evicted first, then the engine restarts.
  - Tests with 100k chat rows, 10k requests and a 1-hour idle soak check flat RSS.
- **D26. Size control.** Config caps and retention, WAL checkpoints and VACUUM. Old chat is archived to a compressed export. Hard delete happens only with an explicit config value.
- **D27. Backup.** One state dir. `engine backup` makes a consistent online snapshot of both DBs, scrubbed. `engine restore` keeps the current state, then swaps.
- **D28. Issue log.** A local, deduplicated log with stable kinds, scrubbed, using a hashed repo key. Upload is opt-in only and must be disclosed in PRIVACY.md and README before it ships.

## Rules, checks and parity

- **D29. Rules are structured data.** Each rule has an event, a tool, an optional path scope, a regex pattern or a named built-in check, an action (deny, warn or context) and a message.
- **D30. Modular and dynamic.**
  - A `Check` trait plus a registry; rules refer to checks by name.
  - Every check table (git-guard's flag allowlists, wrappers, extensions, banned dirs, thresholds, messages) lives in TOML defaults, overridable and reloadable.
  - Event, output and host types are generic, so a new event or host needs only an adapter.
- **D31. Exact parity with Node.**
  - The harness compares exit code, stdout and stderr against today's Node guards.
  - Corpora: real commands, guard test payloads and the adversarial probes.
  - Target: 100%. A mismatch is a Rust bug, never a reason to change the Node guard.
  - Then a shadow period, then the same adversarial reviews, then cutover per guard, then the Node guard is deleted.
  - Measured lesson: regex rules matched git-guard only 90–94% of the time, so complex guards are ported as built-in logic.
- **D32. Guards return decisions.** Node guards are refactored from `process.exit` to `evaluate()`, because exits inside fail-open try/catch blocks turned blocks into allows when guards ran in-process.

## Scheduler

- **D33. A dynamic scheduler and ticker.**
  - Declared schedules live in `schedules.toml`. Runtime and agent-added jobs, plus run state, live in the DB.
  - The ticker sleeps until the next due job, then delivers to the target session's mailbox, and the Monitor push wakes the session.
  - Delivery is at-least-once, using job ids, with a per-job missed-run policy, jitter, expiry and offline handling.
  - CLI: `engine schedule …`. Cron stays as the fallback wake (existing owner rule).
  - The engine's internal ticker runs schedules itself. No external trigger is needed: nothing has to come from cron, a hook, a user prompt or a session for a job to run.
  - Engine-side jobs run entirely inside the engine: the update check (D44), retention and archive mover (D26), issue-log flush (D28), WAL checkpoint and backups (D27).
  - Only agent-targeted jobs (a reminder, a sweep for a Primary) need delivery to a session's mailbox via Monitor push. They wait in the mailbox if no session is connected.
  - Cron stays only as a fallback wake for sessions (existing rule); it is not a schedule trigger.
  - Schedule definitions live in a file or the DB, whichever is more standard (D33 uses both: declared in file, runtime in DB).
  - Source: "the engien will help us also not needing a trigger for it to run the schedules" (2026-10-04T18:02:33Z); "ticker for the dynamic schedular to call agent to do things over monitor task, and the schedular tasks should be in a file also or db which ever is more standard" (17:54:36Z).

## Jev

- **D34. Static things never go to Jev.** A deterministic Rust rule decides anything it can. Jev handles only real judgement calls.
- **D35. Jev is optional.** Every Jev-handled decision also has the non-Jev path. With Jev off, missing, over budget or timed out, behaviour equals the current method. Tests cover both paths, and parity is checked with Jev off.
- **D36. Jev safety.** Jev may add a block or advisory but never remove one, and it is never the sole safety gate. It has a per-call budget and timeout, a warm connection, a cache and an async queue.
- **D37. Recommendation text.** The README and GUIDE say "optional, recommended". They give measured per-feature gains (error rate, cost against the Haiku judge, latency) only after the benchmark phase measures Jev on vs off. No blanket claims. The intended pitch is "highly recommended": the two together should have a lower error rate, and cost less because the Haiku judge call is skipped when Jev is trusted (speculation-judge.js ~298). Both claims are **hypotheses until the benchmark phase measures them**, and the published text uses only the measured per-feature numbers.
  - Source: 2026-10-04T17:47:58Z and 17:48:11Z.
- **D38. All Jev work moves into the engine,** following the per-feature verdicts from the Jev review.
  - Jev may make real decisions inside the engine, not only classify. Rust plus Jev together should stay well under Node's latency ("you can utilize JEV even more with rust so you can make it actually decide for rust, and since it is super fast, and also JEV is fast both together won't be as slow as node", 2026-10-04T17:46:05Z). Only judgement calls, never "simple mechanical things" (17:46:27Z).

### Jev lane implementation (Wave 1, lane `w1-jev`)

The lane is the `src/jev/` module (settings in `defaults/jev.toml`), a port of the Node client and assist layer. Each Rust
item cites its Node source in its doc comment; the module doc has the file-by-file table.

- **HTTP client: `ureq` 3 over `rustls`, ring provider, webpki roots.** Pure Rust: no OpenSSL, no async runtime. Why this one:
  it is blocking, which matches the daemon's thread model (no tokio to start, no executor in a 3.7 MB daemon); it exposes
  exactly the knobs the key rules need (no redirects, no proxy, status returned instead of raised, one global deadline); it
  has a connection pool, which is the "warm connection" of D36. `ring` comes in through `rustls` and is used directly only for
  SHA-256, so the content hash costs no extra crate. Cost, measured on this machine (macOS arm64, release profile
  `opt-level = "z"`, LTO, strip), the same source with and without the lane: 2,829,856 bytes (engine-proto f25e6fe) against
  3,894,080 bytes, +1,064,224 bytes (+1.0 MiB, +37.6%). The same delta (+1,064,224) was measured at the lane's first build
  on the earlier base e072e99 (2,579,712 to 3,643,936), so later additions to the lane fit inside the segment padding. That figure is the
  whole lane (the Jev code and `ureq`, `rustls`, `ring`, `webpki-roots` and their small helpers); the code and the
  dependencies were not measured apart. `ah-engine version` start-up, 1,000 runs each, alternating, on a heavily loaded machine
  (load average about 130): median 7.28 ms without the lane, 6.97 ms with it, so no measurable cost (the difference is noise;
  nothing in the lane runs at start-up, every table is a lazy `OnceLock`). Not built or measured: `reqwest`, `minreq`, `attohttpc`, a hand-written TLS layer. `ring` needs a C
  compiler to build, which the bundled SQLite already needs. A cargo feature that drops the lane from a slim build is
  possible; not done, because Jev has to be switchable at run time anyway (D35).
- **Keys.** Resolved by vendor (`credentials.rs`): the vendor's own option; the vendor-less option only for the vendor it is
  bound to; the legacy variables and key file only behind the home-only `jev.allowLegacyKeyRead`. A `Key` has no `Display`
  and a redacted `Debug`. The transport sends it only in the Authorization header, never follows a redirect (a 3xx is a
  network error and the redirect target is never contacted, tested against a real loopback server), and ignores proxy
  variables in the environment (the Node `fetch` does not use them either; `ureq` would by default). The test endpoint
  override (`ANTIHALL_JEV_TEST_ENDPOINT*`) is honoured only for a loopback host without credentials (rules in the review-fixes
  paragraph below).
- **Trust (D36), deliberately stricter than Node in two places.** `add-block` is identical. `advisory` never lowers a
  baseline of `true` (Node's can). `relax-block`, which lets Jev turn a block into a non-block in Node, is observe-only: the
  call is consulted and logged like a shadow call and never changes the outcome. A caller that needs a block removed
  decides that itself, deterministically. These are the only differences in the decision rows (the harness asserts them
  separately).
- **Hot path.** With Jev disabled or the integration off, `ask` returns after one clock read and one settings snapshot: no
  hashing, no cache lookup, no network, no thread and, unlike Node, no log row (the key `jev.log_off_rows` restores it). The
  settings files are re-checked at most every `jev.settings_recheck_ms`: the exact I/O of an off call is at most one `stat` of
  each of the two files (`settings.json`, `jev.json`) per window, taken by the first call after the window elapses, and none
  otherwise. Zero I/O between change notifications needs the daemon's config watcher to call `Jev::reload`; that wiring is
  planned with the dispatcher (D58), and the config lane's watcher does not cover `jev.json` today. The asynchronous path (`ask_async`) does not even
  queue an off call; its worker thread starts on the first real call, the queue is bounded (`jev.queue_cap`, a full queue is
  logged as `busy`), and the thread ends when the lane is dropped.
- **Review fixes (Codex security review, 2026-10-05).**
  - *Cache poisoning across sessions.* The cache key (`Jev::cache_key_of`) is the SHA-256 of the integration, the question
    version, the vendor chain (each vendor, its model and its endpoint) and the text or explicit cache key. A session with a
    different vendor, fallback or model never shares an entry. An answer obtained through a test endpoint override is never
    written, and a session with an override never reads, the cache. A hit is served only after the calling session passed
    the `enabled`, mode and key checks; a session with no key for its primary vendor gets `no-key`, not a borrowed answer. The
    logged `h` is still Node's short hash.
  - *Budget overflow.* Every entry point (`decide`, `decide_multi`, the fallback split) clamps its budget to
    `jev.max_timeout_ms` and uses `saturating_mul` and `saturating_sub`; tested with `u64::MAX`. Deviation from Node:
    `jevDecideMulti` applies no ceiling to an explicit timeout; the engine does.
  - *Loopback.* `src/jev/loopback.rs` follows the WHATWG host parser where the Node comparison depends on it: `127.1`,
    `2130706433`, `0x7f.1`, `0177.0.0.1`, `127.0.0.1.`, percent-encoded hosts and `[0:0:0:0:0:0:0:1]` are accepted (as in
    Node); `127.0.0.1.evil.com`, `localhost.`, `[::ffff:7f00:1]` and anything with credentials are refused. An accepted URL is
    stored canonically with the host rewritten to the literal `127.0.0.1` or `[::1]`, so `localhost` is never resolved through
    DNS or a hosts file. The transport sends any loopback URL through a second `ureq` agent whose resolver returns only
    loopback addresses, so the peer a key is sent to is loopback by construction. Deliberately stricter than Node: a
    non-ASCII host (IDNA would map full-width characters to `127.0.0.1`) and `http:127.0.0.1` or three slashes, which Node
    accepts; the harness asserts the engine refuses them.
  - *Key text in memory.* The per-environment memo is keyed by a SHA-256 digest of the environment (length-prefixed), not by
    text that contains key values. The resolved settings still hold the environment, because key lookup needs it; that
    is unchanged.
  - *TLS roots.* `cargo tree -e features` shows the `rustls` feature of `ureq` pulls `rustls-webpki-roots` and `webpki-roots`
    and nothing from the platform: no `rustls-platform-verifier`, no `rustls-native-certs`, no `security-framework` in the
    tree. Roots are the compiled-in Mozilla set, never the system store.
- **Parity (D31).** `parity/run-jev.js` compares, against the Node files on dev: the outbound scrub over 37,005 texts (real
  commands from the field corpus plus fuzz), the request bodies and headers, the decisions and the `jev-assist.ndjson` rows
  over a matrix of integrations x trust x baselines x server behaviour x fallback x breaker x redirect x timeout x cache, and
  the resolved settings and modes over a settings matrix; the shipped integration table is checked against
  `settings-schema.js`. Only the one-shot CLI path exists: the lane is not wired into the daemon until the dispatcher lane lands.
- **JavaScript details reproduced on purpose:** the scrub patterns use look-behind and back-references and JavaScript's `\s`
  and ASCII-only `\b` and `i`, none of which the `regex` crate matches by default, so each is translated by hand (module doc
  of `scrub.rs`); a Choice question's integer-like keys go out first and ascending, as `JSON.stringify` orders them; a
  numeric setting is clamped, not rejected, as Node's settings resolver does; the decision layer reads
  `confidenceThreshold` from the legacy jev.json before settings.json, as `jev-assist.js` does.
- **Per-session environment (D76).** `AskRequest.env` carries the calling session's environment (the switches, kill switches,
  plugin-option keys and test endpoints that decision obeys); the files are read once and shared, and each distinct
  environment's resolution is memoized in a small bounded set (`jev.env_cache_cap`) until a file changes. Without it the engine's
  own environment applies, which is only right for the one-shot CLI. The dispatcher lane supplies the env.
- **Telemetry (D78).** Counters registered in `defaults/jev.toml` and drained into the metrics registry with `JevStats::drain_into`:
  `jev_calls` (backend, mode), `jev_verdicts` (integration, verdict: added, changed, would-change, none, no-answer),
  `jev_cost_micro_usd`, `jev_timeouts`, `jev_cooldowns`, `jev_changed`, `jev_latency_us` (histogram). They are plain atomics and a
  small lock-guarded list: no I/O, no text. `hooks/lib/telemetry.js` does not exist on dev yet (3d36268), so the names follow the
  D78 text; align them when it lands. Writing the Jev decisions into the impact ledger is planned (D52).
- **Settings.** The lane resolves its own settings (`settings.rs`) with the Node precedence for the `jev` and `jevIntegrations`
  keys, rather than through the config lane's `cfgstore`, because it reads Node's keys and the legacy `jev.json`. Folding
  it into the layered config (and its hot-swap) is planned (D18).
- **Not done, planned (D38):** the spend budget watch and audit snippets (opt-in, off by default), the daily rollups written
  when the log rotates, the credit-balance call, the `jev-triage` worker and the per-integration callers (they belong with the
  guard and dispatcher lanes), persisting the breaker and the answer cache in `hot.db` behind the `Store` trait (D21, D22:
  the cache sits behind its own `JevCache` trait now because the storage lane owns `Store`), recording Jev decisions in the
  impact ledger (D52), and the plugin-option tier that Node reads from Claude's stored options file (D18).

## Code standards

- **D39. Organised and documented.**
  - One concern per module, with `//!` module docs and `///` on every pub item.
  - Comments explain why, and each ported rule cites its Node source.
  - `cargo fmt`, `clippy -D warnings`, `cargo doc` clean and `deny(missing_docs)`.
  - Typed error enums, and no unexplained `unwrap`.

## Shipping and review

- **D40. Work in parallel on a separate branch.** `engine-proto` runs alongside the dev release work. Commit source only, never binaries. Keep files under 256 KiB. Finish all current tasks on `dev` too, and keep working on both simultaneously.
  - Source: "that should be in a separate branch, and should finish the current work in dev on all the tasks" (2026-10-04T17:20:25Z); "ok continue working simultaniously" (17:37:39Z).
- **D41. Directory review.** Binaries are held for review rather than banned (official checklist), and background processes must be disclosed. The engine ships to `main` only after the current listing clears. It stays off by default (`engine.enabled`) until parity and the shadow period pass.
- **D42. Codex.** Same engine and adapter. The Codex public directory rejects plugins with lifecycle hooks, so Codex uses marketplace or local install only.

## Plugin updates

- **D44. Update checks move into the engine.**
  - Today, hooks such as `version-alert-refresh.js` and `version-alert` check for new plugin versions themselves.
  - Instead, the engine runs the update check as a scheduled job: interval in config, network only as configured, retry, backoff and cooldown.
  - It caches the result in `hot.db`, and hooks read only the cached status to show the "update available" notice. Hooks make no network calls.
  - The engine never auto-installs. Updating stays the user's or the `/anti-hall:update` skill's action.
  - When an update is installed, the version handoff (D8) restarts the engine on the new build.

## Consolidation, docs and shipping details

- **D45. Engine scope: messaging, loops and chat DB.**
  - The engine owns the DevSwarm mesh messaging, the Monitor tasks, and loops, schedulers, watchers and reminders.
  - It also owns the DB of chat between DevSwarm agents, replacing the SQL store used today.
  - All parameters for these come from the config file; nothing is hardcoded in the binary (D17).
  - Source: "the messaging of the mesh of the devswarm and the monitore tasks and the engine should read also from the config file ... it should be able to maintain loops and schedulars and watchers and reminders and the db of the chat between devswarm as we use some sql now" (2026-10-04T17:33:05Z); "ok good so we can offload almost everything to the rust engine" (17:30:50Z).
- **D46. Consolidate hooks and skills without trade-offs.**
  - Consolidate where possible without exceeding file-size limits, without packing or bundling files into blobs, and without hurting performance.
  - This is a separate track from the engine (see `consolidation-plan-2026-10-04.md`); the engine is the larger lever for the same bloat.
  - Source: "we have now a lot of hooks and skills, any chance we can consolidate some without exceeding file size or packing them or affect performance?" (2026-10-04T17:06:06Z).
- **D47. README states platform support.** The README must say that Unix-based systems are supported, including WSL, and that Windows is not supported at the moment. Complements D2.
  - Source: "we need to metion support in readme that we support unix based systems including wsl but not windows at the moemnt" (2026-10-04T17:08:26Z).
- **D48. `plugin.json` `supportUrl` is the GitHub issues link.** The directory form reads it from the file (the form does not let the owner edit it), so the file must hold the issues URL for `talas9/anti-hall`.
  - Source: "shouldn't this be the issues link in gh? ... plugin.json key: supportUrl" (2026-10-04T16:58:13Z); "the form doesn't let me it picks them up from the file" (16:59:41Z).
- **D49. Plan review gate.** The final task is a review pass through this whole plan, confirming every D-item is implemented (the checklist below). The plan is versioned, and every change bumps the version and adds a Revision log line.
  - Source: "go back in the chat history and note all in the plan / so when we review when done we make sure all implimented / add task at end to go through the plan in review / and have it have version as well" (2026-10-04T18:01:17Z to 18:01:49Z).

## Measurement

- **D43. Benchmark at every phase.** Tokens, CPU, memory and latency for engine vs Node use the same harness on a quiet machine. Every number is labelled measured or estimated. Tokens are expected to stay equal because parity covers injected text; the gains come from the process model.

## Skill awareness

- **D50. The anti-hall skills know the engine in full detail and can't go stale.**
  - The system-briefing skill (Claude `skills/system-briefing`, Codex `anti-hall-system-briefing`) gets an "Engine" section covering:
    - every CLI command and its flags: `engine serve/hook/status/reload/stop`, `config versions/rollback/export`, `schedule list/add/remove`, `backup/restore`, and later ones;
    - every socket request type and reply;
    - every config, rules, schedule, check-table and message file, with its keys and defaults;
    - `status` fields;
    - error codes with their self-fix hints;
    - how to add a check, rule, schedule or host adapter.
  - It also covers the settings, doctor, update and devswarm skills where they touch the engine.
  - Single source:
    - This section is **generated** from the engine itself, using `engine docs --format md`, which reads the command registry, protocol enum, defaults files, error enum and check registry. It is never hand-written.
    - A drift test fails the build whenever the generated text differs from the committed skill text, so every new endpoint, key or error code has to land in the skill in the same commit.
    - Claude and Codex parity is checked by the same test.
  - Source: owner 2026-10-04 ("make the skill of antihall fully aware of the engine in details and make sure it is always up to date with all endpoints and usage").
  - **The agent uses the engine directly, not only through hooks.** Agents (Claude, Codex, Ricks and Meeseeks) call the engine themselves through a CLI that has `--json` on every command (owner preference: CLI over MCP). They use it to:
    - read `status` and recent errors;
    - add, list or remove schedules and reminders;
    - send and read mesh messages;
    - query the issue log and history;
    - run `config` versions, reload and rollback;
    - trigger a backup.
  - command-guard allowlists the read-only engine commands and gates the state-changing ones the same way as other tools.
  - The SessionStart core carries a short pointer ("the anti-hall engine is available via `engine …`; see the system-briefing skill"), so every agent knows it exists without loading the full reference.
  - Source: owner 2026-10-04 ("so agent is aware of the engine and all usage", "not only hooks").

## Metrics

- **D51. Built-in metrics the agent can always pull.**
  - The engine tracks counters, gauges and latency histograms, all in memory and bounded:
    - per check: calls, decisions (allow/deny/warn/context), p50/p95/p99 latency, errors and fallbacks;
    - per hook event and host: calls and latency;
    - Jev: calls, cache hits, cost, latency, timeouts and cooldowns;
    - the scheduler: jobs run, late or missed, and failures;
    - the mailbox: queued, delivered, consumed and spooled;
    - resources: RSS against budget, CPU, queue depth, breaker and watchdog events;
    - storage: DB sizes, WAL size, mover and retention runs;
    - config: version and reload results.
  - Metrics are snapshotted to `hot.db` on a ticker interval from config, and the series are rolled up into `archive.db` (for example per-minute data kept for 24 h and per-hour data kept for 30 d, as config defaults). Memory stays flat.
  - Agents pull metrics with `engine metrics [--since …] [--check …] [--json]`, and `status` shows a summary.
  - Metrics feed the benchmarks, the article and doctor.
  - Every metric name is registered, so `engine docs` lists it (D50). Nothing is sent off the machine; any upload follows the D28 opt-in rules.
  - Source: owner 2026-10-04 ("add metrics tracking in the engine so the agent can always pull them").

- **D52. Impact ledger: everything the engine affected, with honest savings.**
  - **Observed facts, counted exactly.** Every engine action is recorded as an impact event, with a stable kind, the check, the project as a hashed key, and a timestamp:
    - blocks and warnings, with the reason code;
    - context injected;
    - judgements by Jev or the judge: the verdict, its cost and its latency;
    - model-routing changes at agent spawn: the model asked for or inherited, and the model selected;
    - fallbacks, recoveries and spooled writes;
    - schedule runs;
    - mail delivered.
  - **Savings are always labelled with their method.**
    - *Model-routing savings* = the actual tokens the routed agent used × (price of the original model − price of the selected model). This rests on the stated assumption that the original model would have used the same tokens, so it is shown as an **estimate** under that label.
    - Prices come from a config price table, never hardcoded. The table carries its own date and source.
    - Jev cost is the actual cost recorded per call. Any "cost vs Haiku judge" figure is an estimate based on the same counterfactual.
  - **Measured benchmarks sit beside the estimates.** Where a controlled with/without benchmark exists (B1 routing), the report shows its measured median with provenance (task set, model, date) next to the running estimate. This follows the plugin's own rule never to present a per-run counterfactual as a measured saving.
  - **Pulling it:** `engine impact [--since] [--kind] [--project] [--json]` gives totals and breakdowns: blocks by reason, judgements, routings, estimated savings with their method, and measured benchmark references. `status` shows the headline counts.
  - **Storage:** rolled up the same way as D51, with the same no-network rule.
  - Source: owner 2026-10-04 ("see savings and judgements and token saved by selecting cheaper models done by the engine and all things the engine had impact on").

## Name and documentation

- **D53. Name: `ah-engine`.** This covers the binary, the process name users see in `ps`/`top`/Activity Monitor, and the source dir `ah-engine/`. The Cargo crate is `ah_engine`.
  - It is the owner's choice. On 2026-10-04 it was checked free on crates.io, Homebrew, npm and the local PATH. Earlier candidates `anti-hall-engine` and `antihalld` were superseded.
  - Subcommands: `ah-engine serve | hook | status | metrics | impact | schedule | config | backup | restore | docs | stop`. The process title shows the mode.
  - State dir: `~/.anti-hall/ah-engine/`. Docs: `docs/AH-ENGINE.md`.
  - The name comes from defaults (D17), with one build-time constant.
- **D54. Full documentation.**
  - **`docs/AH-ENGINE.md`**, hand-written, explains what the engine is and why it exists. It covers:
    - the architecture (client, daemon, ticker, stores, in-memory layer);
    - every feature (checks, rules, scheduler, mailbox/mesh, Jev lane, metrics, impact ledger, spool, backups, update checks);
    - the lifecycle (start, handoff, resident, crash-loop);
    - reliability and the never-wedged guarantees;
    - security and privacy;
    - config and data files;
    - how to extend it;
    - troubleshooting;
    - a short FAQ.
  - **A generated reference** (`ah-engine docs`) lists every command, request type, config key, rule and check field, schedule field, metric, impact kind and error code.
  - Both are linked from the README, GUIDE and system-briefing skill.
  - Drift tests (D50) keep the generated parts in sync. A docs-coverage test fails if a registered feature is missing from AH-ENGINE.md.
  - Source: owner 2026-10-04 ("the engine must be fully documented and what it does and all features and work in it and also pick clear name").

- **D55. Integration path.** When a phase is done and tested, `engine-proto` gets a PR into `dev`. The coordinator re-runs the full suite and the engine tests, verifies them, and merges. The engine stays off by default (`engine.enabled`) until parity and the shadow period pass. `dev` to `main` still goes only through the release PR, after the directory review.
  - Source: owner 2026-10-04 ("when done and tested pr to dev and merge").

- **D56. Automated builds; no manual steps.**
  - **Local:** `ah-engine/build.sh`, with targets driven by a config file:
    - runs fmt, clippy, tests and docs generation (D50), then a release build;
    - writes a SHA-256 checksum next to each binary;
    - prints the binary size and the measured idle RSS;
    - `--target <triple>` builds a single target; the default is the host target.
  - **CI:** a GitHub Actions workflow builds every supported target (macOS arm64 and x86_64, Linux x86_64 and aarch64; musl for Alpine is optional), runs the full Rust test suite on each, and uploads the binaries plus `SHA256SUMS` as release assets when a version is tagged.
  - Binaries are never committed to git (D41).
  - How the plugin obtains the binary is an open item and must be decided before it ships:
    - (a) build locally if `cargo` is present;
    - (b) download the release asset for the installed version, verify its checksum, and disclose this in the README and PRIVACY.md (a download-and-run step is a scan risk);
    - (c) both, with (a) preferred.
    Until it is decided, the plugin stays on the Node path.
  - Source: owner 2026-10-04 ("add build script so we don't have to do it manually everytime").

## Offload map (from engine-offload-map-2026-10-04.md, 96 rows)

- **D57. Phases follow the Rust decision.** The gateway design's "Node engine phase 0" is dropped. Phases follow D31/D55: port check by check to ah-engine, each through parity, shadow and review.
- **D58. One dispatcher call per event.**
  - Each event uses a single hooks.json entry that calls `ah-engine hook --event <E>`. The engine does the matching and runs every check for that event in-process, under per-check isolation (D12).
  - Read-type events use a cheap path filter in the client, so events that no rule cares about never wake the engine.
  - Estimated effect: about 196k processes a day falls to about 25k, and about 4,100 CPU-seconds a day falls to about 100–150 (estimate; the benchmark phase will measure it).
- **D59. Pruning stays consistent with no-delete.** The prune jobs (`progress-prune`, `cache-prune`, `state-prune`) delete only anti-hall's own expired, derived state and cache files inside its state dir, which D16 allows. User or agent content (chat, messages, history) is always archived, never deleted (D26). Every prune target is listed in config and logged.
- **D60. Tools that stay in Node.** `doctor`, `update`, `migrate-state`, `devswarm-recover` and `devswarm-migrate` remain Node one-off tools. They must work with ah-engine down. `doctor` reads engine status when it's available and diagnoses the engine when it isn't.
- **D61. Per-repo git cache contract.**
  - Cache entries are keyed by repo path plus the mtimes of HEAD, the index, config and the refs.
  - Any mtime change invalidates the entry, and a hard TTL from config also applies.
  - Alias and config lookups are cached the same way.
  - Results must never be served stale across a commit or a config change; there's a test for this.
  - **Implemented (wave 1, `src/gitcache/`):** the entry's key is the work tree root plus a hash of the git environment. The signature holds the content of `HEAD` and of the loose ref it names (small files, so a same-tick rewrite cannot hide) and the stat (device, inode, size, mtime, ctime) of the index, the config, `config.worktree`, `packed-refs`, the global and system config files, and, for the upstream fact only, the remote-tracking directories. The signature is taken before the answer is computed. A working-tree edit changes none of these files, so the dirty bit is bounded by its own TTL and `dirty_exact` always asks git; a guard must use it for a destructive decision (D-new-5). `GIT_DIR`, `GIT_CONFIG*` and the other variables in `gitcache.bypass_env` make the cache refuse. The facts are produced by running git once on a miss, so a cached answer equals a fresh one by construction; `tests/gitcache_parity.rs` proves it across mutations.
- **D62. api-guard probes.** api-guard's interpreter probes stay as subprocesses that the engine runs, under the same timeout and process-group kill as other subprocesses (D9). Each probe's result is cached by content hash.
- **D63. Measurement gaps to close in the benchmark phase.**
  - git and ps subprocesses spawned by hooks;
  - statusline render counts;
  - Codex event frequencies;
  - Agent, Read, SendMessage, PreCompact and SessionEnd frequencies.
- Offload totals (estimates): resident memory about 511 MB → about 46 MB, and a Bash-pre burst of 409 MB → about 2–18 MB. The full per-item map and the draft rules, schedules, settings and messages files are in `engine-offload-map-2026-10-04.md`.

- **D64. Prebuilt for every Unix target; users never build.**
  - CI builds every supported Unix target on each release tag:
    - macOS arm64 and x86_64;
    - Linux x86_64 and aarch64, each in gnu and musl variants (musl covers Alpine and old glibc);
    - Linux armv7;
    - FreeBSD x86_64, best-effort via cross.
  - The target list lives in a config file (D17).
  - Every binary is tested on its target, or under emulation where native runners don't exist, and checksummed.
  - **Delivery (owner: "post it with repo so user doesn't have to build").** Prebuilt binaries ship with the plugin, so no user ever needs `cargo`. There are two ways to do it, and the build supports both:
    - (a) **Commit the per-target binaries** into the plugin, under `ah-engine/bin/<target>/`. This works fully offline. The cost is real: the official directory checklist holds any compiled executable, and any non-image file over 256 KiB, for manual review (the binary is about 1.1 MB). Every release would also add about 5–10 MB to git history.
    - (b) **Attach the binaries to the GitHub release.** On first use or `/anti-hall:update`, the plugin downloads the binary for the installed version and target and checks it against the committed `SHA256SUMS`. That keeps git and the directory scan clean, but the download must be disclosed (README and PRIVACY.md) and it needs network once.
  - Decision (**owner confirmed 2026-10-04**): build both. The default is (b), with the checksum file committed in the repo. Switch to (a) after the current directory listing clears, if the owner confirms the review hold is acceptable.
  - **Version pairing (owner).** The plugin only ever downloads and runs the ah-engine build from the **same release** as the installed plugin version:
    - The URL is pinned to the release tag that matches `plugin.json`'s version: `v<plugin-version>/ah-engine-<target>`.
    - `SHA256SUMS` for that version is committed in the plugin, so a binary from another version fails verification.
    - The binary reports its own version, and the client refuses a mismatched one.
    - There's no "latest" download, and no fetching of newer or older builds. If the paired asset is missing, for example on a plugin version released before ah-engine existed, the client **never substitutes another version**. ah-engine stays off and the Node path runs.
    - After a plugin update, the next hook fetches the newly paired binary and the version handoff (D8) switches over.
  - The client picks the right binary at runtime. If none fits, the engine stays off and the Node path runs.
  - Source: owner 2026-10-04 ("it should build to every possible unix system and post it with repo so user doesn't have to build").

- **D67. The release build runs automatically in the repo, and checksums ship with each version.**
  - **Step 1, prepare.** Triggered by the release PR into dev (the version bump). The workflow builds and tests every target, computes `SHA256SUMS`, and commits that file into the plugin on the release branch. The binaries are kept as workflow artifacts.
  - **Step 2, publish.** Triggered by the version tag. The workflow attaches the **exact step-1 binaries**, with no rebuild, to the GitHub release, then re-verifies them against the committed `SHA256SUMS`.
  - **Release assets (owner: "attach all arch and source"):** every release carries:
    - the binary for each target (`ah-engine-<version>-<target>`);
    - `ah-engine-<version>-src.tar.gz`, a source archive with the dependencies vendored (`cargo vendor`), so anyone can build offline from exactly the shipped source;
    - `SHA256SUMS`, covering every asset;
    - GitHub artifact attestations (build provenance), which are free on public repos and let users verify that a binary came from this workflow and this commit.
  - **Standards (owner: "as per standards").** The release follows the common Rust conventions:
    - per-target archives named with the target triple: `ah-engine-<version>-<target-triple>.tar.gz`, each with a top-level dir holding the binary, LICENSE and README;
    - a `.sha256` file per asset plus a combined `SHA256SUMS`;
    - semver `vX.Y.Z` tags.
  - `cargo-dist` (the de-facto generator for this layout) is evaluated with its shell installers disabled, so no `curl | sh`. It is adopted only if it supports the D67 prepare/publish flow; otherwise the workflow is hand-written to the same conventions.
  - A tag that has no matching step-1 artifacts or checksum file makes the workflow fail. Unverified binaries are never published.
  - `RELEASING.md` documents both steps.
  - Cost: $0, since the repo is public and uses standard runners. Estimated 5–8 minutes per release.
  - Source: owner 2026-10-04 ("why not implementing the build in the repo when released").

- **D68. Rebuild ah-engine only when it actually changed.** (Owner: "not every release will have engine changed".)
  - **Build fingerprint.** The prepare step hashes everything that affects the binaries: the `ah-engine/` source, `Cargo.lock`, the Rust toolchain version, the targets config and the build flags.
    - If the hash matches the last published ah-engine build, **nothing is built**. The plugin release reuses that existing engine release, at zero CI cost.
    - A docs-only or Node-only plugin release never triggers a Rust build.
  - **ah-engine gets its own semver.** Releases are tagged `ah-engine-vX.Y.Z` and carry the full asset set from D67. The version is bumped only when the fingerprint changes.
  - **The plugin pins one exact ah-engine version** in a committed manifest (`ah-engine.lock`) that holds the version, the fingerprint and the SHA256SUMS of every asset. This refines D64:
    - "paired build" now means **the ah-engine version pinned by this plugin version**, not a rebuild per plugin release;
    - the plugin downloads only that pinned version, verifies it against the committed checksums, and never substitutes any other version;
    - an older plugin keeps its old pin forever.
  - The prepare step updates `ah-engine.lock` automatically when a new engine build is published. A test checks that the lock's fingerprint matches the source in the same commit, so a release can't ship engine code that doesn't match its pin.

- **D69. Repo layout: monorepo now, a separate repo later, never a submodule.** (**Owner confirmed 2026-10-04.**)
  - **Now:** ah-engine lives in this repo (`ah-engine/`, outside `plugins/anti-hall`), so a parity port (Rust check against Node guard) changes and tests both sides in one PR.
  - **Later:** once the migration is done and the engine API (protocol, check registry, data-file schemas) is stable, move it to its own repo, `talas9/ah-engine`, with its own issues, CI and releases. The plugin keeps shipping the rules, config and data files, and pins the engine through `ah-engine.lock` (D68).
  - **Never a submodule:**
    - it isn't known whether plugin install fetches submodules;
    - users don't need the engine source, only the pinned binary;
    - submodule `.git` files have already broken path resolvers in this project;
    - submodule pointer bumps are easy to commit by accident.
  - Source: owner question 2026-10-04 ("separate repo and use it as submodule? Or this will complicate things?").

## End-of-work steps (in order)

- **D65. Repo cleanup.** Once the migration is done, inventory old and unused files and dirs:
  - Node guards replaced by ah-engine (the DELETE-AFTER rows);
  - stale scripts, eval leftovers and dead fixtures;
  - anything not referenced by hooks.json, code, tests, docs or the release.
  Each one is proven unused with git grep, tests and CI. The removal list needs the owner's explicit OK before anything is deleted, and lands as a PR to dev with the full suite green.
- **D66. Docs and comments review, one by one.** Every doc (README, GUIDE, docs/*, AH-ENGINE.md, CONTRACT, KB, llms.txt, AGENTS.md, both Codex READMEs, skills) and the code comments are checked against:
  - the current code and features;
  - the file structure;
  - link targets and anchors;
  - settings keys and counts;
  - the CONTRACT specs.
  Stale text is fixed, and drift tests are added where it could recur. Both Claude and Codex are covered.
- **Order:** engine work, then cleanup, then docs review, then the final plan review (D49).
- Source: owner 2026-10-04 ("when done clean the repo files of old and unused files and dir and also review the docs and comments one by one to match new code and features and structures and links and specs").

## Future idea (analysis only; NOT approved for implementation)

- **D70 (proposal). Rule-adherence supervisor, built on ah-engine and Jev.**
  - **Owner idea:**
    - On first init, read the host and project CLAUDE.md/AGENTS.md and consolidate them into one rule set.
    - Then send each agent reply and command to Jev, which checks whether the agent still follows the rules and isn't drifting. This targets drift at high context.
    - A second checker covers incoming user prompts: it makes sure decisions the user gives mid-task, and the issues they report, aren't ignored or dropped.
    - It is non-blocking, at a small overhead cost.
  - **Owner constraint:** analyse it only for now. Implement it only after the engine is stable and released, under strict testing and metrics.
  - **Initial analysis:**
    - **Fit.** It is a judgement task, so it belongs in the Jev lane (D34). It is async and non-blocking (D36), runs in the background (D33), and records its results in the impact ledger (D52).
    - **Design sketch.** Consolidated rules are stored as a versioned rule set in hot.db, re-built whenever a CLAUDE.md changes (watched like config, D18). Two passes:
      - an *outgoing* pass over the agent's replies and tool calls, flagging rule violations and drift;
      - an *incoming* pass that extracts user decisions and reported issues into a commitments list, then checks later turns honour them.
    - **Output.** An advisory to the agent at the next turn, never a block, with evidence: the rule it broke, a quote of the violating text, and the turn.
    - **Cost control.** Sample instead of judging every reply, or batch per turn. Use a deterministic pre-filter (D34) so only candidate violations reach Jev. Cache by rule-set plus content hash, and give it its own budget.
    - **Risks.**
      - Jev precision: the judge measured only 0.78–0.81, so false nags are likely. Gate it on benchmark-style precision measurements.
      - Privacy: replies and prompts are sent to the Jev endpoint. That needs opt-in and disclosure in PRIVACY.md and the README.
      - Token/API cost per turn.
      - Rule extraction from free-form CLAUDE.md is itself fuzzy.
      - Overlap with the existing task-tracker, tasklist-guard and speculation guards. Reuse them rather than duplicating.
    - **Acceptance before shipping (proposed):**
      - a labelled drift corpus;
      - measured precision ≥ 0.9 at the default threshold;
      - measured recall for dropped user decisions;
      - per-turn cost and latency;
      - a shadow period first.
  - **Status:** proposal. Track it as a separate task after the engine release.

## Implementation checklist (filled in during the final review)

Each D-item gets a status (`done` / `partial` / `not started` / `superseded`) with evidence: commit, test name, or file:line. Release is gated on every non-superseded item being `done`, or explicitly deferred by the owner.

| D | Status | Evidence |
|---|---|---|
| D1–D69 | not started | — |

## Revision log

- **1.0** (2026-10-04): initial record, D1–D43.
- **1.1** (2026-10-04): D44 added (update checks move into the engine). Version, checklist and revision log added.
- **1.2** (2026-10-04): decisions-sweep over the chat history. Added D45 (engine scope: mesh messaging, loops, watchers, reminders, chat DB), D46 (consolidation constraints), D47 (README platform support), D48 (`supportUrl` = GitHub issues), D49 (plan review gate). Amended D3 (every agent starts the engine and keeps a Monitor task), D33 (no external trigger needed; engine-side vs agent-targeted jobs; file-or-DB schedules; cron fallback wake only; clarified in 1.3), D37 (recommendation rationale), D38 (Jev decides in-engine), D40 (finish dev work first, run simultaneously). Checklist range extended to D1–D49.
- **1.3** (2026-10-04): D33 clarified per owner: the internal ticker runs all schedules itself; engine-side jobs (update check, retention/archive, issue-log flush, WAL checkpoint, backups) never touch a session; only agent-targeted jobs use mailbox delivery via Monitor push; cron is a session fallback wake only. This resolves the 1.2 ambiguity.
- **1.4** (2026-10-04): D37 reworded so "lower error rate" and "cheaper" are hypotheses until the benchmark phase measures them; published text uses only measured numbers.
- **1.5** (2026-10-04): D50 added: the skills document the engine fully, generated from the engine source, with a drift test.
- **1.6** (2026-10-04): D50 extended so agents use the engine directly through a JSON CLI, not only through hooks. Adds the command-guard allowlist and a SessionStart pointer.
- **1.7** (2026-10-04): D51 added: built-in metrics with snapshots and rollups, pulled via `engine metrics --json`.
- **1.8** (2026-10-04): D52 added: impact ledger with exact observed counts and labelled savings estimates (counterfactual method stated, price table in config), alongside measured benchmark references.
- **1.9** (2026-10-04): D53 sets the name to `anti-hall-engine`. D54 adds full documentation: hand-written docs/ENGINE.md, a generated reference, and drift and coverage tests.
- **1.10** (2026-10-04): D53 renamed from `anti-hall-engine` to `antihalld` per the owner ("not engine"). The docs file becomes docs/ANTIHALLD.md, the state dir ~/.anti-hall/daemon/, and the source dir antihalld/. The word "engine" in other D-items refers to the same component.
- **1.11** (2026-10-04): D53 final name is `ah-engine` (crate `ah_engine`), checked free on crates.io, brew, npm and PATH. D55 added: phase PRs from engine-proto into dev, merged after the coordinator verifies.
- **1.12** (2026-10-04): D56 added: local build.sh plus a CI multi-target build that attaches checksummed release assets; how the binary is obtained is listed as an open item.
- **1.13** (2026-10-04): D57–D63 added from the offload map: Rust phases, one dispatcher per event, prune vs no-delete, Node tools, git cache contract, api-guard probes, measurement gaps.
- **1.14** (2026-10-04): D64 added: prebuilt binaries for every Unix target, so users never build. Delivery is (b) release assets with committed checksums by default, with (a) binaries committed in the repo after the listing clears. This resolves the open item in D56.
- **1.15** (2026-10-04): D64 delivery confirmed by the owner: build both, default to (b) release assets.
- **1.16** (2026-10-04): D64 version pairing: the plugin downloads only the ah-engine build tagged with its own version, verified by that version's committed checksums. The client also checks the binary's self-reported version. No "latest" fetch.
- **1.17** (2026-10-04): D64 states explicitly that an older plugin never pulls a newer build. If its paired build is missing, it stays on Node (owner).
- **1.18** (2026-10-04): D65 (repo cleanup, owner OK needed before any delete) and D66 (one-by-one docs and comments review) added, with the end-of-work order: engine work, cleanup, docs review, final plan review.
- **1.19** (2026-10-04): D67 added: an automated two-step release build in the repo. Prepare commits SHA256SUMS; publish attaches the same artifacts. A tag without prepare fails.
- **1.20** (2026-10-04): D67 release assets: binaries for every target, a vendored source tarball, SHA256SUMS over everything, and build-provenance attestations.
- **1.21** (2026-10-04): D67 follows the standard Rust release layout (target-triple archives, per-asset .sha256 plus SHA256SUMS, semver tags). cargo-dist is evaluated with installers disabled.
- **1.22** (2026-10-04): D68 added. ah-engine is rebuilt only when its build fingerprint changes, and has its own semver and releases. The plugin pins an exact engine version plus checksums in ah-engine.lock, which refines D64's pairing.
- **1.23** (2026-10-04): D69 added: monorepo while porting, a separate repo once the API is stable, never a submodule.
- **1.24** (2026-10-04): D69 confirmed by the owner.
- **1.25** (2026-10-04): D70 proposal recorded: Jev-backed rule-adherence and drift supervisor plus a user-decision tracker. Analysis only; implementation deferred until after the engine release.
- **1.26** (2026-10-04): implementation of D30/D39 in `ah-engine/`: a `Check` trait plus registry in `src/checks/`, the git check split into modules named after their concern, typed error enums, `ah-engine check <name>` replacing the ad-hoc `gitguard` subcommand, and the `AH_ENGINE_*` environment prefix. No behaviour change (git parity stays 100%).
- **1.27** (2026-10-04): implementation of D17, D50-D52 and D7 in `ah-engine/`. Shipped defaults are `defaults/*.toml` (compiled into the binary as static data by `build.rs` instead of parsed at start: parsing nearly doubled client start-up, 3.7-3.8 ms against 1.9-2.1 ms measured), one table per setting (`value`, `doc`, optional `env`/`min`/`max`/`unit`); the `no_hardcoded_tunables` test enforces them. Every command takes `--json` and sits in a registry marked read-only or state-changing; `docs` is generated from the registries and committed as `REFERENCE.md` with a drift test. Metrics and the impact ledger are in memory behind a `Store` trait until the storage phase, and savings are shown only as labelled estimates (no figure while no routing events exist). Idle exit is the config key `daemon.idle_exit_s`, default 0 (disabled), per D7. The test suite reaps every daemon it starts and a wrapper (`test.sh`) fails the run if any survives.
- **1.28** (2026-10-04): D54 implemented: `docs/AH-ENGINE.md` (hand-written) plus a docs-coverage test that fails if a registered command, check, metric, impact kind or defaults file is missing from it, if a line says "planned" without a decision number, or if it names an environment variable that does not exist. Unbuilt features are listed there as planned (D-n).
- **1.29** (2026-10-04): D15 refined after Linux CI found that the 64 MB data-segment ceiling left no room for the git check thread's 64 MB stack (Linux counts thread stacks against RLIMIT_DATA): `daemon.mem_mb` is a ceiling against runaway allocation, default 512 MB, and must exceed workers x `git.stack_mb`; the RSS cap stays the budget.
- **1.30** (2026-10-05): storage phase step 1 (D19, D21, D73) implemented: `rusqlite` with the `bundled` feature; `hot.db` (WAL, `synchronous=FULL`) and `archive.db` (WAL, `synchronous=NORMAL`, opened on first use) in the state dir; every SQLite setting is a key in the new `defaults/storage.toml`, with `storage.fullfsync` default 0 (off) as D73 left open; schema migrations are versioned by `PRAGMA user_version`, each in its own transaction, idempotent, and a newer schema is refused. One writer thread owns the hot.db write connection and commits whatever is queued in one transaction, one savepoint per write. The `Store` trait takes `&self` (so no caller holds a lock across a store call, D9) and has a SQLite implementation (`SqliteStore`); `MemStore` stays for tests and as the fallback when storage cannot open. Impact events from the hook path are queued without waiting (the hook reply never waits on storage, D9); a read first waits for the writes queued before it. The SQL lives in `src/sql.rs`, allowlisted in `no_hardcoded_tunables` as code (every tunable is a bound parameter).
- **1.31** (2026-10-05): storage step 2 (D20, D22, D25) implemented. Project state (mailboxes, key-value pairs) moved from memory into hot.db (migration v2). The writer commits first and then updates the in-memory layer (`src/tier.rs`): a generic byte-budgeted LRU `Tiered<K, V>` that holds only active items (TTL via `setex`; an expired item leaves memory and keeps its row) and pub/sub channels with bounded per-subscriber queues (publish never blocks; a slow subscriber loses notifications, never data). A read promotes a value from SQLite only if no write happened meanwhile. Without storage every project operation is refused rather than kept in memory alone. A consumed message is marked, not deleted. Writes may carry a write id (`W <id>`), recorded with the result in the same transaction, so a repeat is a no-op that returns the first answer. Mailbox data is not cached in memory (a take is a write and a count is an indexed query), so the generic tier currently serves key-value items; pushing channel notifications to sessions is the Monitor push of D45.
- **1.32** (2026-10-05): storage step 3 (D23) implemented. The group-commit window is the key `storage.group_commit_ms` (default 0: commit at once with whatever is already queued, so a lone write pays no added latency; writes arriving during a commit still share the next one). `db_commits` and `db_writes` show the grouping. Crash test `tests/durability.rs`: 50 loops of SIGKILL in the middle of a four-thread write burst (puts and key sets with write ids) against one state dir; after each restart every acknowledged write is present (a key holds its last acknowledged value or a later one), every present value was sent and is intact (self-checksummed), nothing is present twice, and applied write ids match rows one to one. A mutation check (acknowledging before the commit) makes it fail at once. Measured locally: 50 loops in about 2 s, about 11k acknowledged writes. The kill is a process crash; power loss is the separate `storage.fullfsync` question (D73), not tested here.
- **1.33** (2026-10-05): storage step 4 (D24) implemented in `src/spool.rs`. `ah-engine proj` gives each write an id, retries with exponential backoff and jitter (`spool.retries`, `spool.backoff_ms`, `spool.backoff_max_ms`; it starts the daemon if none answers), then appends spoolable writes (`spool.verbs`: put, set, setex) to `spool.log`: framed (`AHS1 <len> <crc32>`), under an exclusive file lock, fsync'd before it reports `spooled <id>`; capped by `spool.max_bytes` (past the cap the write is refused, never silently kept or lost). The daemon maps transient storage failures to BUSY (retry and spool) and refusals (caps) to ERR. It drains on start, every `spool.drain_ms` on its own thread, and before each project write, so spooled writes land before newer direct ones; records apply in file order (order per session, named by `AH_ENGINE_SESSION`), each with its write id, so a replay is a no-op. Damaged or refused records go to `spool.quarantine` with their reason. Tests: 100 writes with no engine across 4 sessions, then start: all 100 present once and in order, and a full replay of the same records changes nothing (`tests/spool.rs`); a busy engine (rate limited) makes the client spool and the drainer applies it. Scope note: hooks write no project state yet, so D24's "hook writes" use this path once they do.
- **1.34** (2026-10-05): storage step 5 (D26, D59) implemented as `ah-engine maintain` (`src/maintain.rs`), a CLI command for now because the scheduler is a later phase (D33). Per-table retention and caps are keys (`retention.*`): consumed messages, expired key values and impact events (by age and by the `retention.impact_hot_rows` cap; totals stay in hot.db) move from hot.db to archive.db (migrations hot v3, archive v2). Each batch commits to archive.db first, with hot.db's synchronous level, then leaves hot.db; copies keep their keys, so a crash between the two leaves a duplicate the next run ignores (tested). Only derived bookkeeping is pruned (applied write ids past `retention.applied_s`, logged, D59); archived user data is hard-deleted only when `retention.archive_delete_after_s` is set, default 0 (never). Both WALs are checkpointed (TRUNCATE) and both databases VACUUMed; each run's report is stored in hot.db and surfaced as `maintain_runs`, `maintain_last_ms` and the `db_*_bytes` gauges. `maintain` runs in its own process beside a live daemon: SQLite's locks separate them, the in-memory layer holds only active items, and a move never takes an active one (a key set again since its copy stays). Not done here: the compressed export of old chat (D26) belongs with the chat DB (D45).
- **1.35** (2026-10-05): storage step 6 (D27) implemented in `src/backup.rs`; the `backup` and `restore` commands lose their planned marker. `backup [--to <dir>]` uses SQLite's online backup API on both databases (consistent while the daemon writes), leaves each copy as one file (journal mode DELETE), scrubs the columns in `backup.scrub_columns` with the diagnostics scrubber (secrets, home path), VACUUMs so no unscrubbed page remains, integrity-checks, and writes `manifest.json`; it never overwrites an existing snapshot. `restore <dir>` validates the snapshot (integrity, schema not newer), keeps the current state as an unscrubbed `backups/pre-restore-<ms>` snapshot that is never deleted, stops the daemon and holds its singleton lock, then copies each database into place with the backup API and reopens it in WAL with migrations applied; a database missing from the snapshot is left as it is. **Deviation (recorded):** "scrubbed" covers the text columns that hold agent-written content; project keys (paths) are kept unhashed, because hashing them would make a restore unable to find each project's data. Snapshots stay in the private (0700) state dir by default. Scheduled backups wait for the scheduler (D33).
- **1.36** (2026-10-05): storage step 7 (D51, D52) implemented. Both registries persist through the `Store` trait, which gains `save_metrics`, `load_metrics` and `rollups` (SQLite and in-memory implementations). Impact events and exact totals were already in hot.db (1.30). Metrics: a snapshot of counters and histograms (gauges are live readings, not kept) goes to hot.db every `telemetry.snapshot_ms` (default 60 s, on its own thread, not the D33 scheduler) and at a clean exit, and into per-resolution rollup buckets in archive.db (`telemetry.rollups`: minute kept 24 h, hour kept 30 days, the D51 example values; pruned by `maintain` as derived data, D59). A new daemon imports the last snapshot, so counting continues; after a crash it loses at most what came after the last snapshot. `metrics --rollup <resolution> [--since <s>]` lists rollups. Test: `metrics_impact_and_rollups_survive_a_restart_and_a_kill` (clean stop, then SIGKILL).
- **1.37** (2026-10-05): storage phase measured (README, Measurements, "Storage phase"; `scripts/measure-storage.py`), alternating the pre-storage build and this one under the same (heavy: load average 167-177) machine load. Medians: CLI write 10.8 ms against 7.9 ms (process start-up dominates), CLI read 8.6 against 8.8 ms, acknowledged socket writes 614 ops/s (each synced, FULL) against 1,482 for in-memory, daemon RSS 4.2 MB idle and 5.2 MB after 10k writes (D25 target 16 MB; D73 measured 7.3 MB at default caches), binary +1.04 MiB (D73: +1.8 MB). The D73 caveat "no kill tests" is closed by the 50-loop SIGKILL test (1.32); a quiet-machine re-run and a concurrency (group commit) benchmark belong to the benchmark wave (D75 wave 4).
- **1.38** (2026-10-05): D18 file part implemented (`src/cfgstore.rs`, `defaults/config.toml`). Layers, highest first: env, `settings.json` (same file and key lookup as `hooks/lib/settings.js`: `get()`, `lookup()`, `coerceValue()`), the engine's own `config.toml` in the state dir, shipped defaults; the TOML sits where Node puts its "below the file" tiers because no engine setting declares a plugin-option or legacy source. Deviations from Node, each deliberate: (1) a corrupt `settings.json` is an invalid config (the last good one stays), where Node reads it as `{}`, because a watching daemon would otherwise swap to defaults mid-edit; (2) `config.toml` is strict (unknown key, wrong type, out of range is invalid) where `settings.json` is lenient (clamps, falls through). Watching is polling file metadata (mtime, size, inode) every `config.watch_ms` with a `config.debounce_ms` settle time instead of the `notify` crate: no per-OS dependency tree, no trouble with atomic-rename editors and deleted files, two tiny files. The swap is an `Arc<Snapshot>` behind an `RwLock` held only to clone or replace the pointer; a request takes one snapshot and uses it throughout. Restart-only settings (`config.restart_only`) keep the running value and show as `pending_restart`; the automatic handoff D18 mentions for them is planned (D18). Today the swap reaches every `Config` limit; other readers of the shipped defaults still read the compiled-in values until moved onto the snapshot (planned, D17). Persisting versions in the DB, `config versions`, `rollback`, `export` stay planned (D18, Wave 2).
- **1.39** (2026-10-05): shared read paths implemented as libraries (D75 wave 1, no check uses them yet, planned in wave 2): the per-session transcript index (`src/transcript/`, `defaults/transcript.toml`; D22) and the per-repo git cache (`src/gitcache/`, `defaults/gitcache.toml`; D61). The index reads only appended bytes, keeps bounded facts that mirror the Node transcript readers (including all three task-notification shapes), and rebuilds from the file on truncation, rotation or rewrite; the cache serves git facts while a file signature is unchanged. D61 gained an implementation note (signature contents, dirty-bit TTL and the exact read, bypass environment). Parity: `tests/transcript_parity.rs` and `parity/run-transcript.js` against the Node readers, `tests/gitcache_parity.rs` against fresh `git` on fixture repositories.
- **1.40** (2026-10-05): D33 scheduler and ticker implemented (`src/schedule.rs`, `defaults/schedules.toml`, migration hot v5). An internal ticker runs the jobs with no outside trigger. Jobs come from a `ScheduleSource`; today `FileSource` reads the shipped `job.*` entries plus the user's `schedules.json` (JSON, read once at start). Engine-side jobs: `maintain` (daily) and `backup` (off by default) run as `ah-engine <action> --json` subprocesses in their own process group so a timeout kills them; `metrics_snapshot` and `spool_drain` run in the daemon and replace their former private timers. Each interval is a named setting (`every_key`) read through the D18 layered config on every planning pass, so `schedule.maintain_ms` and the others can be set in config.toml, settings.json or the environment and a hot-swap applies without a restart (0 pauses a job); the job definitions themselves come from `schedules.json` until schedules move into the config DB. Jitter per job; a persisted job's next time is committed before the run starts, so a restart never runs it twice; a missed window catches up once (`catch_up = "once"`) or is skipped, never once per window; a timeout, then retries with exponential backoff, then a cooldown; a run history in hot.db (all runs of persisted jobs, failed runs of the others; pruned by `maintain` after `retention.schedule_runs_s`). Agent-targeted jobs go through the `AgentDelivery` trait; until the mailbox lane (D45) its stand-in records them as `planned`, never failed. `ah-engine schedule list | run <job> | history` replaces the planned exit 64; list and history also work without a daemon. Not done here: adding and removing jobs from the command line and schedules in the DB (D33, with D18). An in-process job past its timeout cannot be killed; the run is recorded as a timeout and the job waits for it before running again (subprocess jobs are killed).
- **1.41** (2026-10-05, lane w1-ports-small): D29-D31, D75. First small guard port: `merge-side-pick` (`src/checks/merge_side_pick/`) plus the shared `src/checks/guardkit/` (switch chain, skip file, message layout, JavaScript-exact regex translation, bounded in-memory per-session state behind the `SessionState` trait). `Check` gains `run_payload` (default: `run`) for checks that need payload fields a `Subject` lacks; the daemon and `ah-engine check` call it. Defaults in `defaults/small_guards.toml`. Parity: `parity/run-merge-side-pick.js` at 100% oneshot and daemon.
- **1.42** (2026-10-05, lane w1-ports-small): D29-D31, D75. First small guard port: `merge-side-pick` (`src/checks/merge_side_pick/`) plus the shared `src/checks/guardkit/` (switch chain, skip file, message layout, JavaScript-exact regex translation, bounded in-memory per-session state behind the `SessionState` trait). `Check` gains `run_payload` (default: `run`) for checks that need payload fields a `Subject` lacks; the daemon and `ah-engine check` call it. Defaults in `defaults/small_guards.toml`. Parity: `parity/run-merge-side-pick.js` at 100% oneshot and daemon.
- **1.43** (2026-10-05, lane w1-ports-small): D29-D31, D75. `ship-it-guard` ported (`src/checks/ship_it/`): Edit, Write and MultiEdit decided in the engine; with the gate on, Bash (needs the command-guard shell-write parser) and apply_patch (Codex patch parser) defer to Node, as does a payload without an absolute cwd. `parity/run-ship-it-guard.js`: 13048 scenarios (real Edit/Write targets and real path tokens, risk-directory rewrites, 400 fuzzed plans, switch and skip variants) at 100% outside the deliberate deferrals.
- **1.44** (2026-10-05, lane w1-ports-small): D29-D31, D75. First small guard port: `merge-side-pick` (`src/checks/merge_side_pick/`) plus the shared `src/checks/guardkit/` (switch chain, skip file, message layout, JavaScript-exact regex translation, bounded in-memory per-session state behind the `SessionState` trait). `Check` gains `run_payload` (default: `run`) for checks that need payload fields a `Subject` lacks; the daemon and `ah-engine check` call it. Defaults in `defaults/small_guards.toml`. Parity: `parity/run-merge-side-pick.js` at 100% oneshot and daemon.
- **1.45** (2026-10-05, lane w1-ports-small): D29-D31, D75. `ship-it-guard` ported (`src/checks/ship_it/`): Edit, Write and MultiEdit decided in the engine; with the gate on, Bash (needs the command-guard shell-write parser) and apply_patch (Codex patch parser) defer to Node, as does a payload without an absolute cwd. `parity/run-ship-it-guard.js`: 13048 scenarios (real Edit/Write targets and real path tokens, risk-directory rewrites, 400 fuzzed plans, switch and skip variants) at 100% outside the deliberate deferrals.
- **1.46** (2026-10-05, lane w1-ports-small): D29-D31, D75. `scan-throttle` ported (`src/checks/scan_throttle/`). The offload map listed throttle counters for it; the Node guard has no state, only a user-pattern match, so none is kept. User patterns are JavaScript regexes: a validated plain subset is matched with the translated Rust regex, everything else defers (no guessing). `jsre` gains `\D`, `\W` and a fallible compile. `parity/run-scan-throttle.js`: 11290 scenarios over 109 environments (pattern sets, switches, PATH variants, real field commands, fuzz) at 100% outside the deliberate deferrals (non-plain patterns only).
- **1.47** (2026-10-05, lane w1-ports-small): D29-D31, D75. First small guard port: `merge-side-pick` (`src/checks/merge_side_pick/`) plus the shared `src/checks/guardkit/` (switch chain, skip file, message layout, JavaScript-exact regex translation, bounded in-memory per-session state behind the `SessionState` trait). `Check` gains `run_payload` (default: `run`) for checks that need payload fields a `Subject` lacks; the daemon and `ah-engine check` call it. Defaults in `defaults/small_guards.toml`. Parity: `parity/run-merge-side-pick.js` at 100% oneshot and daemon.
- **1.48** (2026-10-05, lane w1-ports-small): D29-D31, D75. `ship-it-guard` ported (`src/checks/ship_it/`): Edit, Write and MultiEdit decided in the engine; with the gate on, Bash (needs the command-guard shell-write parser) and apply_patch (Codex patch parser) defer to Node, as does a payload without an absolute cwd. `parity/run-ship-it-guard.js`: 13048 scenarios (real Edit/Write targets and real path tokens, risk-directory rewrites, 400 fuzzed plans, switch and skip variants) at 100% outside the deliberate deferrals.
- **1.49** (2026-10-05, lane w1-ports-small): D29-D31, D75. `scan-throttle` ported (`src/checks/scan_throttle/`). The offload map listed throttle counters for it; the Node guard has no state, only a user-pattern match, so none is kept. User patterns are JavaScript regexes: a validated plain subset is matched with the translated Rust regex, everything else defers (no guessing). `jsre` gains `\D`, `\W` and a fallible compile. `parity/run-scan-throttle.js`: 11290 scenarios over 109 environments (pattern sets, switches, PATH variants, real field commands, fuzz) at 100% outside the deliberate deferrals (non-plain patterns only).
- **1.50** (2026-10-05, lane w1-ports-small): D29-D31, D75. `coordinator-work-guard` ported in part (`src/checks/coordinator_work/`): the payload-provable exits (not Bash, no session id, subagent markers by the exact Node truthiness rules, including the Codex variant) are answered; every main-thread call defers, because the window needs `classifyBashWork` (command-guard port) and `CLAUDE_CODE_ENTRYPOINT` from the hook's environment. The engine keeps no window state, so there is no state to disagree with Node's. Offload effect measured on the field data: 238360 of 269361 recorded Bash calls (88 percent) carry subagent markers. `parity/run-coordinator-work-guard.js`: 8327 scenarios, 0 mismatches; deferrals are exactly the main-thread calls.
- **1.51** (2026-10-05, lane w1-ports-small): D29-D31, D75. First small guard port: `merge-side-pick` (`src/checks/merge_side_pick/`) plus the shared `src/checks/guardkit/` (switch chain, skip file, message layout, JavaScript-exact regex translation, bounded in-memory per-session state behind the `SessionState` trait). `Check` gains `run_payload` (default: `run`) for checks that need payload fields a `Subject` lacks; the daemon and `ah-engine check` call it. Defaults in `defaults/small_guards.toml`. Parity: `parity/run-merge-side-pick.js` at 100% oneshot and daemon.
- **1.52** (2026-10-05, lane w1-ports-small): D29-D31, D75. `ship-it-guard` ported (`src/checks/ship_it/`): Edit, Write and MultiEdit decided in the engine; with the gate on, Bash (needs the command-guard shell-write parser) and apply_patch (Codex patch parser) defer to Node, as does a payload without an absolute cwd. `parity/run-ship-it-guard.js`: 13048 scenarios (real Edit/Write targets and real path tokens, risk-directory rewrites, 400 fuzzed plans, switch and skip variants) at 100% outside the deliberate deferrals.
- **1.53** (2026-10-05, lane w1-ports-small): D29-D31, D75. `scan-throttle` ported (`src/checks/scan_throttle/`). The offload map listed throttle counters for it; the Node guard has no state, only a user-pattern match, so none is kept. User patterns are JavaScript regexes: a validated plain subset is matched with the translated Rust regex, everything else defers (no guessing). `jsre` gains `\D`, `\W` and a fallible compile. `parity/run-scan-throttle.js`: 11290 scenarios over 109 environments (pattern sets, switches, PATH variants, real field commands, fuzz) at 100% outside the deliberate deferrals (non-plain patterns only).
- **1.54** (2026-10-05, lane w1-ports-small): D29-D31, D75. `coordinator-work-guard` ported in part (`src/checks/coordinator_work/`): the payload-provable exits (not Bash, no session id, subagent markers by the exact Node truthiness rules, including the Codex variant) are answered; every main-thread call defers, because the window needs `classifyBashWork` (command-guard port) and `CLAUDE_CODE_ENTRYPOINT` from the hook's environment. The engine keeps no window state, so there is no state to disagree with Node's. Offload effect measured on the field data: 238360 of 269361 recorded Bash calls (88 percent) carry subagent markers. `parity/run-coordinator-work-guard.js`: 8327 scenarios, 0 mismatches; deferrals are exactly the main-thread calls.
- **1.55** (2026-10-05, lane w1-ports-small): D29-D31, D75. `compact-declaration-guard` ported (`src/checks/compact_decl/`): the new-work test (`BASH_WORK_RE` with its two lookarounds done by hand, quote blanking, handover exemption) and the transcript-tail turn reconstruction are exact; the phrase analysis (`compact-advice.js` `findAdvice`) is not ported, a turn whose text contains "safe" defers to Node. Blocks (stdout JSON plus stderr, exit 2) defer because the engine reply carries one or the other, not both: the dispatcher lane's reply format may remove that limit. `parity/run-compact-declaration-guard.js`: 17458 scenarios (hand-written transcripts, 700 windows of real Claude and Codex transcripts, 6000 real commands plus 6000 fuzzed ones and 1500 real file paths against an active declaration) with 0 mismatches and 0 work-classification divergences.
- **1.56** (2026-10-05): the Jev lane (D34-D38) implemented as `src/jev/`: HTTPS client (`ureq` over `rustls`, +1.0 MiB measured), Vercel and TypeSafe transports with a per-vendor breaker and a fallback, Noul and Choice questions, off/shadow/on modes with `add-block` and `advisory` trust (relax-block observe-only, D36), a content-hash cache, async queue with budgets, and the `jev-assist.ndjson` rows; `ah-engine jev ask|status|scrub`; `parity/run-jev.js` at 100%.
- **1.57** (2026-10-05): the Jev lane (D34-D38) implemented as `src/jev/`: HTTPS client (`ureq` over `rustls`, +1.0 MiB measured), Vercel and TypeSafe transports with a per-vendor breaker and a fallback, Noul and Choice questions, off/shadow/on modes with `add-block` and `advisory` trust (relax-block observe-only, D36), a content-hash cache, async queue with budgets, and the `jev-assist.ndjson` rows; `ah-engine jev ask|status|scrub`; `parity/run-jev.js` at 100%.
- **1.58** (2026-10-05): Jev lane review fixes (Codex security review): the answer cache is keyed by vendor chain, model and endpoint and never holds an answer from a test endpoint override (a hit also needs the calling session's key); every timeout is clamped to `jev.max_timeout_ms` with saturating arithmetic; the loopback rule follows the WHATWG host forms Node accepts (`127.1`, `2130706433`, `0x7f.1`), refuses `localhost.` and IPv4-mapped IPv6, rewrites `localhost` to the literal and dials only loopback addresses; the per-environment memo holds a SHA-256 digest, not key text; the exact off-path I/O is documented; the `ureq` roots are webpki, not the system store (evidence in the Jev section). Parity: loopback rule 3,576 URL cases plus an engine-stricter list, and the cache cases assert the no-cache-through-override deviation.
- **1.59** (2026-10-05): D78 (revised 1.35 in the plan record) and D77 implemented as `src/telemetry/` (the former `telemetry.rs` became `telemetry/mod.rs`). Event schema: fixed short fields `k`, `h`, `e`, `o`, `ms` (latency in whole ms, rounded up), `ib`, plus typed extras for `route`, `spawn`, `jev` and `spill`; every string an event holds is a `Token` (identifier characters only, at most `telemetry.token_max_len`), and the JSON reader rejects unknown fields, so no text can be stored (tested). Hot path: sharded open-addressed counter tables of atomics and a ring of rich events written by index (`telemetry::recorder`); measured `record()` median 18 ns alone and with four threads on the same labels, asserted under 1 microsecond by `tests/telemetry.rs`. Wiring: `hookio::Observer` is unchanged; the daemon's observer now carries the hook event, so every check and rule run, and every whole hook request, records invocation, outcome, ms and injected bytes with no per-check code. Persistence: a flusher thread stores deltas and events through `Op::Telemetry` (hot.db migration v6 (the scheduler took v5): per-day counters with a JSON latency histogram, and events) every `telemetry.flush_ms` and at shutdown; cursors move only after the store accepted the write, and an unanswered write (timeout) is not retried, so a count is never doubled; the loss window on `kill -9` is what came after the last flush (tested with a real daemon). Counters are mirrored into the D51 registry as `tel_events`, `tel_injected_bytes`, `tel_dropped`. Rollups: `TelDb::rollup` copies complete days into archive.db (migration v4, replace, so idempotent) and prunes hot rows past `telemetry.retention_days` only after archiving and only if unchanged. `ah-engine telemetry summary|events|rollup|import` and `ah-engine impact --window` added. Route linking joins `spawn` to `route` events by `spawn_key`; a re-spawn after a steer is compared against the first request. `impact` computes NET: saved and spent-up in both directions from linked pairs, minus injected context and Jev cost, all labelled estimates, unpriced models counted not guessed. **Deviations (recorded):** (1) the settings are `telemetry.flush_ms` and `telemetry.retention_days` (the engine's snake_case), not camelCase; (2) `impact.price_table` stays empty (units are now micro-dollars per million tokens): no price has been verified, so `impact` reports the join and no dollar figure until prices are added; (3) the daily rollup is the scheduler job `telemetry_rollup` (`schedule.telemetry_rollup_ms`, in-process, persisted history, catch-up once) and `telemetry rollup` runs the same code by hand; the flush has its own thread because its interval (default 10 s, minimum 50 ms) is a durability setting that a schedules.json override must not be able to turn off; (4) the model-routing check is not ported, so route events come from the Node log via `telemetry import`, and `Telemetry::route` is the call the ported check will make; (5) the Node file format is the short-field schema in `telemetry::event`; the Node lane's current `routing-events.ndjson` rows (`decision`, `spawn_result`) have other names and are not read by `import` until that lane writes this schema; (6) storage files touched additively: `sql.rs` (migrations and statements), `db.rs` (one `Op` variant and one match arm), `storage.rs` (a default `Store::db()` method).
