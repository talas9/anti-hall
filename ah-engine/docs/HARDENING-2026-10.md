# ah-engine hardening, October 2026

Record of the failures seen on 2026-10-10 and the work that addressed each one. Tracking issues: #158 (protection matrix), #21 (memory), #22 (late replies).

Rules for this document: every number comes from a measurement recorded in those issues or in the lane reports behind them. A number that was not measured is marked **unmeasured**. A cause is called "proven" only where a measurement or reproduction is cited. Status words: **done** (merged into a train or pushed with a passing test), **in progress** (work exists but is not pushed or not integrated), **open** (no fix yet).

Branch heads are on `origin` unless marked in progress. Fixes are on feature branches; "done" means verified on the branch, not necessarily deployed. Section 6 lists what is deployed.

## 1. Incident summary

Users of the engine saw, over one day:

- hook timeouts: a hung or dead daemon blocked every hook until the host's 10 s timeout;
- process pile-up: dozens of client processes, one per hook or statusline call;
- repeated memory-cap restarts: one live reading shows 59 restarts on the 128 MB cap in about 20 minutes ("rss over cap; restarting cleanly");
- high CPU, in particular on `Stop` events and on scheduled jobs;
- a crash loop: the accept loop stalled, the daemon force-exited, and was restarted.

The engine was switched off pending fixes. Each failure below got a root-cause pass first, then a fix, then a test that reproduces it.

## 2. Failures

### 2.1 Fail-fast client and the hang

- **Symptom:** a hung or dead daemon blocked every hook until the host timeout (10 s).
- **Root cause:** the client had no short deadline of its own. Reference: #158 matrix row 1. A client-side contributor is measured: on macOS the client's `set_*_timeout` calls fail with `EINVAL` (see 2.4), so deadlines could not be relied on. Hang duration under the fix is **unmeasured** until the branch lands.
- **Fix:** client deadline of about 300 ms (config), fail open, `ah-hook.sh` under 1 s tested against a hung daemon. Branch `fix/failfast-client`.
- **Test:** hung-daemon test in the hook script suite (specified in #158 row 1).
- **Status:** **in progress**. Not pushed. This is the deploy gate (section 6).
- **Related audit finding (ERROR-AUDIT):** guard failures in the client path fail closed in some cases and some failure reasons are not logged. Integration must verify internal errors, as opposed to deliberate block verdicts, fail open with a logged reason.

### 2.2 Client pile-up

- **Symptom:** dozens of client processes, one per hook or statusline call.
- **Root cause:** clients waited on a stuck daemon and each call spawned another; no marker told later clients the daemon was down and nothing serialized the spawn (#158 rows 2-3).
- **Fix:** daemon-down marker so clients fail open at once, single-flight spawn lock, no client outlives its deadline. Branch `fix/failfast-client`.
- **Test:** pile-up test against a hung daemon (specified in #158).
- **Status:** **in progress**, not pushed.

### 2.3 Statusline

- **Symptom:** statusline clients hung and multiplied.
- **Fix:** the statusline is no longer installed by the engine's installer; uninstall is kept for old installs. Branch `fix/failfast-client`.
- **Test:** `tests/statusline/install-uninstall.test.js` is rewritten on that branch.
- **Status:** **in progress**, not pushed.

### 2.4 Accept-loop stall and crash loop

- **Symptom:** the daemon reported `accept loop stalled`, force-exited and restarted repeatedly.
- **Proven root cause** (branch `fix/158-stall-hang`):
  - Darwin `AF_UNIX` `set_write_timeout` returned `EINVAL`, so worker I/O deadlines were not enforced and I/O could block without bound.
  - The full-queue path wrote its BUSY reply synchronously from the accept thread.
  - The watchdog heartbeat (`loop_beat`) was refreshed only outside the inner accept drain, so a burst of accepts could be reported as a stall while accepting was progressing (a watchdog false positive).
  - The original 5 s production stall was **not** reproduced with 100 scratch clients. The false-positive shape was reproduced by lowering the config-driven stall threshold.
- **Fix:** commit `7ca7cd15`. Server reads and writes use non-blocking fd I/O with `poll` and absolute deadlines (config); the accept loop refreshes the heartbeat while draining; full-queue BUSY is one non-blocking best-effort write and drop. Obsolete keys `daemon.read_poll_ms` and `daemon.busy_write_ms` were removed.
- **Test:** `accept_loop_survives_a_hundred_client_flood_with_silent_peers`: 100 clients including 20 silent peers and no-read peers; 70 well-behaved clients get OK or BUSY, silent peers get framed read-deadline errors, no watchdog restart, no `watchdog stall` log line.
- **Status:** server side **done**. The client still treats the Darwin `EINVAL` as an engine failure; mirroring the poll-deadline path is part of `fix/failfast-client` (in progress).
- **Open sub-item:** a crash-loop breaker (after N restarts in a window, disable the engine and fall back automatically) is **open** (#158 row 4, planned for live18).
- **Open sub-item:** a diagnostics binary reported as hanging on `version` did not reproduce. A four-way matrix (config or not, `MallocStackLogging=lite` or not) all exited 0 and printed the version. No hang point is proven and no allocator patch was made. `diagnostics.malloc_stack_logging` is now an accepted key. Root cause **open**, likely environment-specific (unverified).

### 2.5 `RLIMIT_DATA` EINVAL (`mem_limit err:22`)

- **Symptom:** `mem_limit err:22` at daemon start.
- **Proven root cause:** macOS rejects `setrlimit(RLIMIT_DATA)` with `EINVAL`; reproduced in a scratch daemon start, the daemon kept running.
- **Fix:** commit `7ca7cd15`: `apply_mem_limit` reports `unsupported:rlimit_data` on macOS; Linux behaviour unchanged (`ok:<mb>` or `err:<errno>`). macOS relies on the footprint cap (2.6).
- **Test:** `memory_limit_and_nice_are_applied_and_reported`.
- **Status:** **done**. The wider rule from #158 row 6 (an invalid setting is logged and skipped, never fatal) is **in progress**.

### 2.6 RSS vs footprint: false restarts

- **Symptom:** restarts on the 128 MB cap while the process held less private memory.
- **Proven root cause:** the cap counted resident set size, which includes shared code pages. Live reading at 20 minutes: RSS 106 MB against `phys_footprint` 79 MB.
- **Fix:** `daemon.mem_metric` (default `footprint`) selects the metric for the cap; shipped in train live16 (`ba961789`, deployed, attested).
- **Test:** `rss_over_cap_restarts_cleanly_and_next_client_respawns` in the reliability suite.
- **Status:** **done**. Live 15-minute run after the change: 152 logged requests, no cap trip; footprint 39 to 73 MB.

### 2.7 Heap growth (#21)

- **Symptom:** memory grew with requests and tripped the cap.
- **Proven root cause**, from per-call-site attribution (system allocator build with stack logging, 3000-call replay, 4 concurrent):
  - **Regex cache duplicated per worker.** Each of 4 workers compiled and kept its own copy of the same patterns: 139 distinct patterns, about 3.3 MB compiled per copy. The count cap (256) was never reached (maximum seen 132), so it bounded nothing.
  - **QuickJS checks held per worker.** Each worker keeps every check it has run (73 checks, about 5 MB per worker, 4 workers); flat once all are loaded. Growth between 1500 and 3000 calls was checks first used late. It is not a leak and not a ratcheting limit (size after collection equals size before; the call limit is recomputed only when a check is loaded).
  - `daemon::serve` 17 MB flat is thread stacks (address-space reservations), left unchanged.
- **Fix** (branch `fix/21-quickjs-regex`, commit `e21c92cf`; all limits in plugin config `script.*`): one process-wide byte-bounded LRU regex cache (`regex_cache_bytes`, entry cap, compile size limits from config); per-worker soft limit (`runtime_soft_bytes`) that unloads the least recently called checks; absolute per-runtime ceiling (`runtime_max_bytes`).
- **Trade-off, measured:** a 3 MB soft limit made the replay about twice as slow (reload thrash); default is 4 MB (a few percent).
- **Before and after** (same replay, 3000 calls, 4 concurrent):

| Site | 1500 before | 1500 after | 3000 before | 3000 after |
|---|---|---|---|---|
| `script::ensure_entry` | 17.7 MB | 14.3 MB | 18.2 MB | 14.7 MB |
| `script::host::with_call` | 16.0 MB | 6.8 MB | 17.5 MB | 6.4 MB |
| regex compile | 13.0 MB | 1.9 MB | 14.6 MB | 2.0 MB |
| `daemon::serve` (thread stacks) | 17.2 MB | 17.2 MB | 17.2 MB | 17.2 MB |
| heap total | 73.1 MB | 49.6 MB | 77.1 MB | 51.7 MB |
| RSS | 192.7 MB | 164.5 MB | 192.4 MB | 166.5 MB |

  Growth from 1500 to 3000 across the three script and regex sites: about +3.5 MB before, about +0.1 MB after. Footprint readings were noisy between snapshots; RSS and heap are the figures to trust.
- **Test:** interpreter memory stays in a band over many calls; the shared regex cache is byte-bounded and shared across threads.
- **Status:** **done** (in train live17).

### 2.8 Remaining growth is bounded

- After 2.7, a 1500/3000/6000-call attribution: heap 49.51, 51.71, 51.17 MB. Plateau from 3000 to 6000 (-0.5 MB).
- The residual +2.0 MB between 1500 and 3000 comes from two structures that fill to a cap: the telemetry event ring (`telemetry.ring_size` = 2048 events, about 0.55 MB; about 2030 events were held at 6000) and SQLite page caches (`storage.cache_kb` = 512 KB per connection, several connections). Others are tens of KB.
- Caveats: neither cap was observed to be reached (the page caches were still rising, +415 KB between 3000 and 6000); a 12000-call run would confirm the plateau (**unmeasured**). A 50k-call soak is **unmeasured**.
- Earlier profiling (replay, production allocator): RSS 29 MB at 0 calls, 75 at 1k, 84 at 5k, 90 at 20k; resident minus allocated stays 7-8 MB, so growth was live Rust heap, not allocator retention.
- **Status:** conclusion **done**; confirmation run **open**.

### 2.9 Single instance, idle exit, scheduled jobs, idle CPU, CPU budget

Branch `fix/158-lifecycle-cpu`, commit `baf70d09`.

- **Multiple instances.** Fix: a lifetime OS lock on the socket lock file; stale-lock recovery checks the recorded holder PID. Test: 10 concurrent starts leave exactly one daemon and nine immediate, clear exits.
- **Not closing.** Fix: idle exit, default 1800 s from plugin config. Tests: exits cleanly after inactivity, restarts on the next hook, does not exit with a request in flight.
- **Failing scheduled jobs.** `gh_poll` and `refresh` failed while still exiting 0, so failure was invisible. Now: actionable failure returns non-zero, no-work and no-session state skips, TOML-configured exponential backoff. Idle verification over 120 s observed no scheduled child processes.
- **CPU guardrails.** A per-request CPU budget (config) fails open after logging when exceeded; a sustained-CPU self-check logs a warning and backs off scheduled jobs.
- **Idle CPU.** 0.265802 CPU-s over 120 s with no requests = 0.2215 % of one core. (An earlier progress note on #158 said 0.43 %; the lifecycle report above is the verified run.)
- **CPU per request** (before to after, N=30, concurrency 3, one transcript copy):

| Event | Before | After |
|---|---|---|
| Stop | 431.678 ms | 388.574 ms |
| UserPromptSubmit | 72.464 ms | 68.441 ms |
| PreToolUse | 5.742 ms | 5.714 ms |
| PostToolUse | 1.809 ms | 1.781 ms |
| SubagentStart | 1.018 ms | 0.772 ms |

  The Stop reduction includes the fail-open budget behaviour; it is not purely an optimisation.
- **Status:** **done** on the branch (not yet in a train per #158; integration planned for live18).

### 2.10 Stop scan CPU (#22)

- **Symptom:** late replies under load. Open-loop measurement at 50 calls/s: client p50 20 ms, p95 312 ms, p99 534 ms; queue wait p95 164 ms. At 200 calls/s the daemon was overloaded (1,919 connection resets and 71 BUSY of 4,000).
- **Proven cause:** `Stop` events (about 3 % of traffic, 187 of the slowest 190 requests) run the scripted transcript scans `tasklist-guard` and `silent-agent-nudge`, 300-450 ms of engine CPU each. Four workers held by those requests make ordinary calls queue. Git is not the dominant contributor (subprocess time zero at p95, 20-25 ms at p99).
- **Fix 1 (done, train live15, #22 evidence at `14740bf9`):** a transcript that fits the scan window keeps its walk per path and the next scan reads only appended bytes; the task-activity search uses `memchr::memmem`. CPU per call before to after: 33 MB transcript, nudge 96 to 1.5 ms and tasklist-guard 209 to 33 ms; 3.9 MB, nudge 16.7 to 3.3 ms; 156 MB (window slides), nudge 225 to 147 ms. Differential test compares kept scans with fresh scans at every step of a growing, rewritten and replaced file and on 10 real transcripts at 24 cut points each.
- **Not fixed:** a transcript longer than the scan window (64 MiB for the nudge, 12 MiB for the widened tasklist scan) slides its window on every append and still scans afresh. The lifecycle profile still shows `agent_scan/scan_transcript` at 878 of 1408 active samples (62.4 %), and `silent-agent-nudge` is still the top Stop check at 220 ms per request.
- **Fix 2:** branch `fix/22-agent-scan-cpu`. **In progress**, not pushed.
- Caveat: these latency figures were taken on a loaded host and are upper bounds; a quiet-machine re-measurement is **unmeasured**.

### 2.11 Orphan scratch daemons, runtime allocator switch

- **Symptom:** 21 orphaned scratch daemons, about 1.3 GB (#158 row 10); live memory could not be attributed to call sites.
- **Fix** (branch `fix/158-alloc-orphans`, commit `8c1d271b`): scratch daemons record their PID and exit when their parent or socket goes away; doctor lists non-live `serve` processes. A custom global allocator wraps jemalloc and the system allocator and picks one once, before the first allocation, from `AH_ENGINE_ALLOCATOR` (`jemalloc` or `system`). The client sets it when it spawns the daemon from plugin config `diagnostics.allocator` (default `jemalloc`); an invalid value is logged and falls back to jemalloc. It never switches after start. The client hook-up is in train `live17` commit `6aaa036f`.
- **Status:** **done**.

### 2.12 Memory module (soft and hard limits, global budget, guard test)

Branch `feat/mem-module`, commit `ba9abe27`.

- Every long-lived holder registers a byte estimator plus `shrink(target)` and `recycle()`, and gets `mem.<holder>_soft_bytes`, `_hard_bytes`, `_low_water_pct` from the plugin's `defaults/mem.toml`; `mem.global_*` bounds the process.
- **Soft** (usage at or over soft): count, log once per excursion (rate-limited), evict LRU to the low-water mark, keep serving; re-arms only at or under low-water, so a holder hovering at the limit is one excursion.
- **Hard** (an insert would cross hard): refuse the insert (cache miss; a script call fails open) and recycle the holder once per excursion; while the process total is over global hard, inserts are refused.
- **Restart:** if the total, or a holder that cannot shrink, stays over hard for `mem.global_restart_after_s`, the watchdog asks for a clean restart through the existing drain path and logs `memory restart`.
- `BoundedCache<K,V>` is a Mutex around the existing tiered LRU. Migrated: regex cache, QuickJS per-worker limits, transcript-tail cache, leaked config values. Helper process output is capped at `mem.proc_output_max_bytes`.
- `status --memory` shows each holder against its limits with trigger counts and level.
- **Guard test** (`tests/it/mem_guard.rs`, allowlist `tests/mem_allowlist.txt`): fails on a `static`, `thread_local` or `OnceLock` collection, a lock-wrapped collection field, or any collection field of the daemon shared state outside `src/mem`, unless listed with a bound and a reason. The scan is textual; a collection behind a type alias (`Buckets`, `KeyCache`) is not seen.
- **Tests:** unit tests for eviction, hard refusal, restart timing, no flapping; a daemon end-to-end where a lowered global hard limit restarts the daemon and logs why.
- **Status:** **done** on the branch (targeted tests, gates and clippy green per the lane report); planned for live18. Follow-ups listed in 2.14.

### 2.13 Error handling

- **Audit** (against `ba961789`): coverage is partial. Request, dispatch, client and native-check boundaries catch many panics, but the global panic hook is empty, scheduler and service threads are not uniformly wrapped, crash breadcrumbs are PID-only, and many fallible operations are dropped through `.ok()` or `let _ =`. Non-test dangerous total is 363: 351 range or index, 9 `panic!`, 3 `unreachable!`, 0 `.unwrap()`, 0 `.expect(`, 0 `todo!`.
- **Fixes (branch `fix/158-error-handling`):** panic boundaries for scheduler, DB, watchdog, telemetry, ingest and jobs; a contextual panic hook; a crash breadcrumb; the top 20 silent drops logged; clippy `panic` and `unreachable` denied with an indexing ratchet.
- **Status:** **in progress**, not pushed.

### 2.14 Unbounded holders

- **Audit** (source-only, against `engine-proto`): 108 findings; by pattern P1 long-lived collections 29, P2 ratcheting limits 2, P3 unreleased or churned resources 15, P4 allocation hot spots 23, P5 queues and logs 27, P6 CPU or retry loops 12 (counted once per pattern matched).
- **Top 10**, with state:

| # | Site | State |
|---|---|---|
| 1 | QuickJS pool and relative heap limit | fixed (2.7) |
| 2 | defaults snapshots leak on reload | counted by the mem module (`defaults_leak`); not removed |
| 3 | derived defaults caches leak one generation per reload | open |
| 4 | per-thread regex cache | fixed (2.7) |
| 5 | devswarm realtime snapshots and edges | open |
| 6 | ingest manager thread per project | open |
| 7 | transcript-tail cache | on the mem module (2.12) |
| 8 | kept transcript walks and clone-on-answer | open; byte caps in `fix/21-bounded-caches` (in progress) |
| 9 | helper stdout and stderr in unbounded buffers | fixed in the mem module (capped) |
| 10 | Jev lane workers and count-only queues | open |

- **Fixes in progress:** `fix/158-holders` and `fix/21-bounded-caches` (byte-weighted transcript caches, retained walk payload bytes counted). Neither is pushed.
- **Status:** **in progress**.

### 2.15 Disk guard

- **Symptom:** a measurement driver filled the disk with 113 GB of fixture copies.
- **Intended fix:** drivers reuse one fixture copy and abort below a free-disk floor (config); the floor is enforced in drivers and builds, not only in rules.
- **Status:** **open**. No branch or test exists for this item in the evidence reviewed.

## 3. Hypotheses that were disproven or not supported

| Hypothesis | Result |
|---|---|
| The transcript caches (tail answer cache, kept Stop walks) are the main heap holder | Per-call-site attribution did not show them among the top growers. The growers were the QuickJS pool and the regex cache. `fix/21-bounded-caches` does not touch those sites. The caches stay on the bounded-holder list (2.14) but are not the main cause. |
| QuickJS relative-limit ratchet | Not a ratchet: size after collection equals size before, and the call limit is recomputed only when a check is loaded. The growth was checks first used late, kept per worker. |
| SQLite or other C-library malloc | Measured small: system malloc in use 2.6 MB at one reading, 1.3 to 3.3 MB (SQLite 1.2 to 3.2 MB) over 15 live minutes. |
| Large transcripts grow the heap per call | Not supported. The original replay already used 33-156 MB transcripts, and a 211 MB real transcript gave the same plateau (91-98 MB). Allocation churn is large (about 1 M allocations per Stop) but the memory is freed. |
| Allocator retention or fragmentation | Not supported: resident minus allocated stays 7-8 MB (production allocator). |
| Git subprocesses dominate late replies | Not supported: subprocess time is zero at p95 and 20-25 ms at p99; the cost is the scripted transcript scans. |
| Time-driven growth at idle | Not supported: RSS stayed flat over 8 idle minutes with real state. |

## 4. Protections matrix

From #158. Each row closes only with a test that reproduces the failure.

| Failure | Automatic protection | Status |
|---|---|---|
| Hung or dead daemon blocks hooks | Client deadline about 300 ms, fail open, hook script under 1 s | in progress (`fix/failfast-client`) |
| Client pile-up | Daemon-down marker, single-flight spawn, no client outlives its deadline | in progress |
| Statusline clients hang and multiply | Statusline removed from what is installed; uninstall kept | in progress |
| Crash loop (accept stall, forced exit) | Server deadlines and heartbeat fix (done); crash-loop breaker with automatic fallback | stall fix done; breaker open |
| Experimental binary replaced the live engine | Binary changes only through the deploy kit; checksum against manifest at start; last-known-good restored automatically | open |
| `mem_limit err:22` | Reported unsupported on macOS; invalid setting logged and skipped | done for RLIMIT_DATA; general rule in progress |
| Memory cap measured RSS | Cap on `phys_footprint` (`daemon.mem_metric`) | done (live16) |
| Unbounded caches grow the heap | Shared byte-bounded caches, soft and hard limits, global budget, guard test | done on branches (`fix/21-quickjs-regex`, `feat/mem-module`); remaining holders in progress |
| Memory not attributable to call sites | Runtime allocator switch (`diagnostics.allocator`) | done (`fix/158-alloc-orphans`) |
| Orphaned scratch daemons | PID record, exit with parent or socket, doctor lists strays | done |
| Driver filled the disk | Single fixture copy, free-disk floor | open |
| Stop checks rescan whole transcripts | Incremental scans | done (live15); over-window case in progress |
| Multiple daemons, no idle exit | Lifetime lock, idle exit | done on branch (`fix/158-lifecycle-cpu`) |
| Failing jobs exit 0 | Non-zero on failure, backoff | done on branch |
| Runaway CPU | Per-request CPU budget, sustained-CPU self-check | done on branch |
| Panics and swallowed errors | Panic boundaries, contextual hook, crash breadcrumb | in progress (`fix/158-error-handling`) |
| Repo automation fell to a paid model slot | Off by default, circuit breaker on 401/402/429 | done (#150) |
| PRs merged before CI finished | Required status checks on `dev` as well as `main` | done (#158 row 14) |

## 5. How to diagnose memory and CPU now

- **`ah-engine status --memory`**: process totals plus, with the mem module, each holder against its soft and hard limits, trigger counts and level. On a cap trip, `mem-snapshot.json` records allocator, threads, per-worker QuickJS before and after GC, regex cache, transcript caches, ledger and `vmmap` output.
- **Per-request memory log:** `diagnostics.mem_log` writes one NDJSON line per request (RSS, footprint, jemalloc allocated and resident, counted heap, system malloc, SQLite, checks, transcript size).
- **`diagnostics.allocator`** (plugin config, default `jemalloc`): set it to `system` and restart the daemon to attribute every live allocation to its call site with the platform tools, without a rebuild:
  - macOS: run the daemon with `MallocStackLogging=lite`, then `malloc_history <pid> -allBySize` and `heap <pid>`. Build with symbols (release builds strip them by default).
  - Linux: `heaptrack`.
  - Known gap: summed `malloc_history` came out about 1.22x the `heap -s` total in the attribution run; the cause was not investigated.
- **`ah-engine diag heap <payload-file|dir>...`:** replays hook payloads through every built-in check in one process and measures per-check heap peaks. It exists only in a build with the `diag` feature (see `src/diag.rs`).
- **Cap metric:** `daemon.mem_metric` (default `footprint`). Compare `footprint <pid>` with RSS before reading a restart as growth.
- **Per-stage latency:** `profile.stage_log` (path, empty = off) and `profile.js_stats_every`; the profiling drivers (`memrun.sh`, `latrun.sh`, `stages.py`, `mem21.py`) are on the profiling branch `perf/21-22-profiling` and are not on `engine-proto`. Builds: `--features prof` (jemalloc stats), `--features dhat-heap` (needs unstripped symbols).
- **CPU:** idle CPU is read over a quiet window; per-request CPU by event and by check comes from the metrics. The sustained-CPU self-check logs a warning when it trips.
- **Host rules for profiling:** keep a free-disk floor, reuse one fixture copy, and use scratch homes and sockets so the profile never touches live state.

## 6. Release status

| Train | Contents | State |
|---|---|---|
| live15 | incremental Stop scans (#22) | deployed |
| live16 (`ba961789`) | memory diagnostics, cap on footprint | deployed, binary attestation verified |
| live17 | `fix/158-stall-hang`, `fix/21-quickjs-regex`, `fix/158-alloc-orphans`, client allocator wiring (`6aaa036f`) | built and soaked; **not deployed** |
| live18 | mem module, error handling, crash-loop breaker and rollback, remaining audit items; the lifecycle and CPU branch per #158 | planned |

**live17 checks.**
- Full gate: 1928 tests, 1927 passed, 1 timed out at 300 s (`dssup_liveness::engine_verdicts_equal_nodes_on_random_corpora`, a Node-parity test that was already flagged slow, over 120 s, in the same run). A 60-test targeted rerun passed 60 of 60 and the log ends with exit code 100; the origin of that exit code was not verified. A separate 216-test targeted run passed 216 of 216. The timed-out test's pass status in isolation is **unmeasured**.
- Replay: gate and replay reported passed in #158 (zero weaker replies is the bar). The replay log is not summarised here; counts are **unmeasured** in this document.
- Soak: 30 minutes, process alive at every sample, 0 panics, 0 start-log lines. A parallel driver sent 99,600 calls with RSS between 63.5 and 74.2 MB after warm-up (31.7 MB at 0 calls). The CPU column below was sampled while that driver was running, so it is load CPU, not idle CPU.

| min | footprint MB | heap MB | CPU % (interval) | threads | RSS MB |
|---|---|---|---|---|---|
| 0 | 63 | 50.5 | 0 | 13 | 69.0 |
| 5 | 67 | 54.2 | 93.0 | 11 | 72.8 |
| 10 | 67 | 54.3 | 94.9 | 11 | 73.5 |
| 15 | 67 | 53.5 | 93.6 | 11 | 72.8 |
| 20 | 66 | 54.2 | 93.5 | 11 | 75.5 |
| 25 | 66 | 52.9 | 82.7 | 11 | 66.8 |
| 30 | 66 | 51.0 | 82.2 | 11 | 66.8 |

  Footprint is flat at 66-67 MB from minute 5 to 30. Sustained CPU near 82-95 % of one core under the driver is a load figure; whether it is acceptable per request is addressed by the CPU work in 2.9 and 2.10 and is not claimed here.

**Deploy gate.** live17 is not deployed until the fail-fast client fix (`fix/failfast-client`) is merged into it and a quick gate passes. After that the maintainer's explicit go-ahead is required. Then a live telemetry watch (restarts, memory, process count, crashes). The engine stays off until the matrix rows that gate go-live pass.
