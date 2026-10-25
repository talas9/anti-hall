# Development guide

How to build, test, run and release anti-hall from a fresh checkout on macOS or Linux (including WSL). Windows is not supported. It covers the plugin (skills, TOML defaults, engine rule logic) and the `ah-engine/` Rust engine. Anything not built yet is marked **planned (D-n)**, where `D-n` is an entry in [`ah-engine/DECISIONS.md`](../ah-engine/DECISIONS.md).

Every shell command in this guide is run by `ah-engine/scripts/doc-check.sh` in a fresh clone (see [Keeping this guide true](#keeping-this-guide-true)). A command that needs credentials, installs something globally or writes outside the clone is marked as skipped there.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Rust | `1.99.0`, pinned in [`ah-engine/rust-toolchain.toml`](../ah-engine/rust-toolchain.toml) with `rustfmt` and `clippy` | building and testing `ah-engine/` |
| Node.js | 22 or newer, optional | only the repo tools (`tools/`, `evals/`, the parity harnesses against the Node backup in `plugins/anti-hall-node`); anti-hall itself needs no Node |
| git | any recent | everything |
| `actionlint` | tested with 1.7.12 | linting `.github/workflows/*.yml` |
| `shellcheck` | tested with 0.11.0 | linting the shell scripts |
| `gh` | tested with 2.102.0 | pull requests and CI results |
| `claude` | tested with 2.1.288 | trying the plugin in Claude Code |

Install Rust with [rustup](https://rustup.rs); inside `ah-engine/` it then fetches the pinned toolchain on first use. Only the Rust and Node rows are enforced; the versions of the other tools are the ones this guide was checked with, not a requirement.

<!-- doc-check: skip (installs a toolchain globally) -->
```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Check the toolchain and Node:

```sh
(cd ah-engine && rustc --version && cargo --version)
grep channel ah-engine/rust-toolchain.toml
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' && node --version
```

<!-- doc-check: needs actionlint shellcheck gh -->
```sh
actionlint --version && shellcheck --version && gh --version
```

<!-- doc-check: skip (the claude launcher resolves its install from the real HOME) -->
```sh
claude --version
```

## Get the code

<!-- doc-check: skip (doc-check already runs in a fresh clone) -->
```sh
git clone https://github.com/talas9/anti-hall.git
cd anti-hall
git switch dev
```

Work happens on `dev`; the engine work is on `engine-proto` until it merges ([Branches and pull requests](#branches-and-pull-requests)). Run everything below from the repository root unless a block says otherwise.

## Build the engine

```sh
cd ah-engine
cargo build --release --locked
./target/release/ah-engine version
```

`--locked` makes the build fail instead of changing `Cargo.lock`. SQLite is compiled in, so nothing else is installed. Run cargo niced on a shared machine: `nice -n 19` with `CARGO_BUILD_JOBS=2`.

`scripts/build.sh` is the release build the CI uses (the host target, or `--target <triple>`). With `--checks` it first runs `cargo fmt --check`, clippy, the docs and the tests, then builds with the release flags, checks that the binary embeds no checkout path, and prints the artifact path and its sha256.

<!-- doc-check: long -->
```sh
ah-engine/scripts/build.sh --checks
```

### Faster local builds

Measured on one Apple-silicon machine (16 cores, `-j4`, single runs, so read differences under about 5 s as noise). Build times of the `ah-engine` crate with its 36 test executables:

| Build | Wall-clock |
|---|---|
| `cargo test --no-run`, dev profile, empty target dir | 57-68 s |
| the same after a one-line edit | 26-30 s |
| `cargo test --profile ci-test --no-run`, empty target dir | 104 s |
| `cargo test --release --no-run`, empty target dir (what the ubuntu gate builds) | 388 s |

- **Use the dev profile while you iterate.** It already sets `debug = "line-tables-only"`; setting `debug = false` or full debuginfo instead measured the same (57 s each, cold). Do not expect a gain from tuning it further.
- **`CARGO_INCREMENTAL=0`** did not make the local dev build faster or slower here (53 s cold and 26 s after an edit, against 57 s and 26-30 s with incremental on). It matters for a compiler cache: the sccache documentation says incrementally compiled crates cannot be cached, so set it when you use sccache. I did not measure sccache.
- **One target directory per clone.** Cargo locks the whole build directory: two builds in one `CARGO_TARGET_DIR` run one after the other (the second prints `Blocking waiting for file lock on build directory`), while two builds in separate target dirs ran in parallel (6.4 s each against 6.5 s plus 4.5 s of waiting, in a small test crate). So do not point several clones or agents at one shared `CARGO_TARGET_DIR`; keep the default `ah-engine/target` in each clone. Give it room: a dev test build is about 3 GB.
- **`SCCACHE_BASEDIRS`** (sccache documentation, not measured here): sccache keys include absolute paths, so clones in different directories only share cache hits when `SCCACHE_BASEDIRS` names their common parent. Set `RUSTC_WRAPPER=sccache` and `SCCACHE_BASEDIRS=<parent of your clones>` in your shell, never in a committed `.cargo/config.toml`. The crate you are editing is rebuilt either way; the cache saves the dependencies.
- **Release builds are the slow ones.** The `ci-test` profile builds the same test binaries 3.7 times faster than `--release`. Tests that need a release build (`mem_reload`, the latency budgets) still need `--release`.
- **Regenerate the generated files with one command**, `cargo run -q --bin ah-regen` (from `ah-engine/`): it rewrites `REFERENCE.md`, the hook files and the engine skills, and lists what changed. `--check` only lists them and exits 1 when a file is stale.

## Run the tests

| Suite | Command | Where |
|---|---|---|
| Engine, everything | `./test.sh` | `ah-engine/` |
| Engine, one former file (now a module of the single `it` test binary) | `cargo test --locked --test it -- <name>::` or `cargo nextest run -E 'test(/^<name>::/)'` | `ah-engine/tests/it/<name>.rs` |
| Engine, lint and docs | `cargo fmt --check`, clippy, `cargo doc` | `ah-engine/` |

All engine integration tests are ONE binary (`ah-engine/tests/it/main.rs`, one `mod` per former `tests/<name>.rs`), so the
crate compiles and links once instead of once per file. Three tests keep their own binary under `ah-engine/tests/` because they
`set_var` process-global variables (`HOME`, the proxy variables) and need a process to themselves under plain `cargo test`:
`config_hotswap`, `runtime_config` and `jev_http` (select them with `--test <name>`). Under nextest every test is its own
process anyway. Add a new test as a module of `tests/it/` (declare it in `main.rs`), not as a new file in `tests/`.

**Engine.** `./test.sh` runs the whole suite, then fails if any `ah-engine serve` daemon from this build tree is still alive (tests reap their own daemons and use their own `HOME`). Run one test runner at a time.

<!-- doc-check: long -->
```sh
cd ah-engine
./test.sh
```

```sh
cd ah-engine
cargo test --locked --test it -- no_hardcoded_tunables::
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked
```

**Engine test runner.** `./test.sh` uses [cargo-nextest](https://nexte.st) when it is installed (`cargo install --locked cargo-nextest`): one process per test, a per-test timeout from `ah-engine/.config/nextest.toml` (a hung test is killed and named instead of stalling the run), and the doctests through `cargo test --doc`. Without it, `./test.sh` prints how to install it and falls back to plain `cargo test`. Extra arguments go to the runner, so `./test.sh --no-fail-fast` works either way.

**Test packs (which tests when).** Three tiers, defined in one place, `ah-engine/.config/nextest.toml` (profiles `policy`, `lane`, `dev`, `release`; every name list lives there, none in code). Run them from `ah-engine/` with `nice -n 10`, `-j 2`:

| Pack | Command | What runs | Count / time |
|---|---|---|---|
| LANE | `scripts/lane-tests.sh <module>...` (= `cargo nextest run -j 2 --profile policy`, then `cargo nextest run -j 2 --profile lane -E 'test(~<module>)'`) | the touched module's tests (never the Node parity lanes, benches, soak or wall-clock drills) plus the policy gates: `no_hardcoded_tunables`, `no_compiled_config`, `compiled_logic_gate`, `process_env_reads`, `temp_leaks`, `defaults_keys`, `docs_coverage`, `reference`, `hooks_files`, `no_node` and the ratchets | seconds to a few minutes |
| DEV | `cargo nextest run -j 2 --profile dev` (before each live deploy) | policy gates; one recorded-golden replay per guard that BLOCKS (command and git for force push and destructive git, edit, merge, api, ask, broad-kill, ship-it, task, tasklist, speculation, verify-first), the dispatcher's block and fail-closed path, launcher and wrapper fail-open drills, crash-loop breaker and rollback, config load and hot swap, ack protocol basics, memory / CPU budget reporting. No live Node | 256 tests, about 5 min at `-j 2` |
| RELEASE | `AH_LIVE_NODE=1 cargo nextest run --profile release` (`AH_TEST_PROFILE=release ./test.sh` adds the clippy gate and the timed pass) | everything: goldens, replay, live-Node parity, soak, benches and heavy sweeps. Node parity runs only here and in the nightly | whole suite |

Other profiles: `default` (a local full run without the soak), `ci` (the pull-request gate), `nightly` (the schedule and a version tag; `test.sh` sets `AH_LIVE_NODE=1` for `nightly` and `release`), `soak`, `record`. To change what a pack runs, edit its `default-filter` in `nextest.toml`; `cargo nextest list --profile dev` shows the result. Every Node parity lane gets a 300 s timeout (heavy sweeps 1800 s) in every profile.

**Engine-vs-Node replays start the daemon first.** A replay that compares the engine with the Node hooks event by event (the frozen-sample replay of a release train) starts the engine daemon and waits until `ah-engine ctl ping` answers before it sends the first event. Events sent while no daemon listens measure the daemon's start-up window, not the engine's verdicts: before the cold-start fix every such call answered nothing, which showed up as the engine being weaker than Node on the first rows of a run, at a different row each run.

**Wall-clock assertions.** A test that asserts "took under N" stretches its upper bound with `common::scaled(Duration)` / `scaled_ms(u64)` (`ah-engine/tests/common/scale.rs`): the factor is `AH_TEST_TIME_SCALE` when set, else `ceil(load1 / (cores * load_per_core))` (both thresholds in `ah-engine/tests/budgets.toml`, `[time_scale]`), so it is 1 on a quiet machine and a bound is then exactly as written. Scale only an upper bound, never a "waited at least" lower bound. Set `AH_TEST_TIME_SCALE=1` to force the strict bound when checking the product's real contract.

**Mutation testing.** `ah-engine/scripts/mutants.sh <module>` runs [cargo-mutants](https://mutants.rs) on one `src/checks/` module (`cargo install --locked cargo-mutants`): it changes the code (flips a comparison, replaces a function body) and expects a test to fail; a surviving mutant is behaviour no test pins, or an equivalent mutant (a change with no observable effect, to be ignored). It is not part of the default gate: a run builds once per mutant, so scope it to one module. Config: `ah-engine/.cargo/mutants.toml`; survivors are listed in `target/mutants.out/missed.txt`.

<!-- doc-check: skip (a mutation run takes minutes; install cargo-mutants first) -->
```sh
cd ah-engine
scripts/mutants.sh git --list
```

**Heap diagnostics.** `ah-engine diag heap <payloads>` replays hook payloads (a JSON file, a JSON-lines file, or a directory of them) through every built-in check in one process and prints, per check, the heap peak, the bytes still allocated afterwards and the total allocated, measured with [dhat](https://docs.rs/dhat). It exists only in a build with `--features diag` (the release binary does not contain it), and it runs against a scratch `HOME`, never the real one. Use it to find which check holds memory on real payloads; RSS cannot, because macOS keeps freed pages. Read `current` with care: the first evaluation of a check includes one-time lazy state (compiled regexes), so a non-zero `current` is often a cache, not a leak; compare `peak` and `total` across checks.

<!-- doc-check: long -->
```sh
cd ah-engine
printf '%s\n' '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/tmp","tool_input":{"command":"git status"}}' > "$HOME/payloads.jsonl"
cargo run -q --locked --features diag -- diag heap "$HOME/payloads.jsonl"
```

`diagnostics.allocator` is the configured daemon allocator value (`jemalloc` by default, or `system`). The runtime switch is `AH_ENGINE_ALLOCATOR`: the engine reads that variable once with `getenv` before the first allocation; exactly `system` selects the system allocator, and unset or any other value selects jemalloc. The client passes the key through at daemon spawn: if `AH_ENGINE_ALLOCATOR` is not already set it reads `diagnostics.allocator` and sets the variable on the daemon (an invalid value is logged as `alloc_invalid` and falls back to jemalloc); set `AH_ENGINE_ALLOCATOR=system` directly to override for profiler runs. On macOS run the scratch daemon with `MallocStackLogging=1`, reproduce the hook, then inspect it with `malloc_history <pid> <address>`; on Linux run the same workload under `heaptrack -- ah-engine serve` (or start a scratch daemon through `heaptrack`) and open the resulting trace with `heaptrack_gui`. Under `system`, `status --memory` still reports the active allocator and counted Rust heap, while jemalloc stats are shown as `n/a`.

After you change a command, setting, metric, impact kind or check, regenerate the reference. A test fails when `REFERENCE.md` differs from the generated text.

```sh
cd ah-engine
cargo run -q --locked -- docs --format md > REFERENCE.md
git diff --stat -- REFERENCE.md
```

**Property tests, fuzzing and benchmarks.** The hand-written parsers (the heredoc parsers, the JavaScript-semantics JSON readers and the `when` glob matcher) have three layers of correctness tooling. None of it is linked into the release binary: `proptest` and `criterion` are dev-dependencies, and the fuzz crate is a separate workspace.

| Layer | What it checks | Where | Cost |
|---|---|---|---|
| Property tests | no panic, bounded time per input, structural invariants (a heredoc opener parses totally, JSON round-trips, `glob_match` equals a regex-compiled oracle) | `ah-engine/tests/it/prop_parsers.rs`, part of `./test.sh` | about 1,000 cases per property by default; `PROPTEST_CASES=100000` for a soak run |
| Fuzzing | no panic, no hang (`-timeout`), no OOM (`-rss_limit_mb`) on arbitrary bytes | `ah-engine/fuzz/` (three targets: `heredoc`, `json`, `glob`), nightly CI in `.github/workflows/ah-engine-fuzz.yml` | needs the nightly toolchain and `cargo install cargo-fuzz` |
| Benchmarks | `glob_match` (including the `*a` and `**a` worst cases for a backtracking matcher) | `ah-engine/benches/parsers.rs` | a few minutes |

A property or fuzz failure is a real bug: fix it at the root, check what the Node original does for the same input (D74: never weaker than Node), and keep the minimal input as a regression test. The proptest run prints the shrunk input; a fuzz crash leaves a reproducer under `ah-engine/fuzz/artifacts/<target>/`.

```sh
cd ah-engine
PROPTEST_CASES=20000 cargo test --locked --test it -- prop_parsers::
```

<!-- doc-check: skip (needs the nightly toolchain and cargo-fuzz, and runs for a bounded time) -->
```sh
cd ah-engine
rustup toolchain install nightly --profile minimal
cargo install cargo-fuzz
cargo +nightly fuzz run heredoc -- -max_total_time=60 -timeout=10 -rss_limit_mb=2048 -max_len=4096
cargo +nightly fuzz list
```

<!-- doc-check: skip (runs for minutes; the numbers depend on the machine) -->
```sh
cd ah-engine
cargo bench --locked --bench parsers
```

**Plugin.** There is no install step and no Node test suite. A plugin change (TOML defaults, skills, docs) is checked by loading it into the engine and reading the result:

<!-- doc-check: skip (needs an installed engine) -->
```sh
~/.anti-hall/ah-engine/bin/ah-hook doctor --check
```

A green local build is not a green CI run. CI runs on ubuntu and macOS, slower, with a real `HOME` and a detached `HEAD`; read the Actions result on your pull request. Never point anything you run at the real home: see "Isolation" in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Run the plugin against a local engine

The plugin's hooks run the thin client `~/.anti-hall/ah-engine/bin/ah-hook`, which calls the engine installed at `~/.anti-hall/ah-engine/bin/ah-engine` (the installer installs the release pinned by `ah-engine.lock` and never overwrites a binary it did not install, so a local build copied there stays). To keep a test run off your real home, exercise the engine directly, in a throwaway state directory (keep its path short, because the daemon's socket lives there):

```sh
E="$PWD/ah-engine/target/release/ah-engine"
export AH_ENGINE_DIR="$(mktemp -d /tmp/ah-dev.XXXXXX)"
export AH_ENGINE_RULES="$PWD/plugins/anti-hall/engine/rules.json"
PAYLOAD='{"session_id":"dev","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}'

# one check, in-process, no daemon: exit 2 and the reason on stderr is a block
echo "$PAYLOAD" | "$E" check git || test $? -eq 2

# the hook path: the client starts a daemon if none runs and prints the host's JSON answer (a block is exit 2); a check the
# engine defers runs the hook's Node command from the fallback map, found through the plugin root
export CLAUDE_PLUGIN_ROOT="$PWD/plugins/anti-hall" AH_ENGINE_PLUGIN_ROOT="$PWD/plugins/anti-hall"
echo "$PAYLOAD" | "$E" hook --event PreToolUse --tool Bash --host claude --fallback-map "$CLAUDE_PLUGIN_ROOT/../anti-hall-node/hooks/ah-fallback.map.json" || test $? -eq 2
# the daemon starts in the background while the first call is answered, so give it a few seconds to bind its socket
for _ in 1 2 3 4 5 6 7 8 9 10; do "$E" ctl ping >/dev/null 2>&1 && break; sleep 1; done
"$E" ctl ping
"$E" stop
```

## Install for development

**Claude Code.** Load the working copy for one session, without installing it:

<!-- doc-check: skip (starts an interactive Claude Code session) -->
```sh
claude --plugin-dir "$PWD/plugins/anti-hall"
```

Inside the session, `/reload-plugins` picks up edits. To use the marketplace build instead, run `/plugin marketplace add talas9/anti-hall` then `/plugin install anti-hall@anti-hall`.

**Codex.** The installer writes hook files; preview first, then install into a project or globally:

<!-- doc-check: skip (needs an installed engine under the real home) -->
```sh
~/.anti-hall/ah-engine/bin/ah-engine install-codex --dry-run
```

<!-- doc-check: skip (writes .codex/ in the clone, or ~/.codex with --global) -->
```sh
~/.anti-hall/ah-engine/bin/ah-engine install-codex
~/.anti-hall/ah-engine/bin/ah-engine install-codex --global
```

Check an install with `~/.anti-hall/ah-engine/bin/ah-engine doctor --check`, or ask "is anti-hall working" inside a session.

## Debug the engine

State lives in `~/.anti-hall/ah-engine/`, or in `AH_ENGINE_DIR` when set. The event log there is `ah-engine.log`: one line per start, crash, breaker change and failure, with secrets scrubbed. Every command accepts `--json`.

```sh
E="$PWD/ah-engine/target/release/ah-engine"
export AH_ENGINE_DIR="$(mktemp -d /tmp/ah-dev.XXXXXX)"
export AH_ENGINE_RULES="$PWD/plugins/anti-hall/engine/rules.json"
"$E" serve >"$AH_ENGINE_DIR/serve.out" 2>&1 &
DAEMON=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do "$E" ctl ping >/dev/null 2>&1 && break; sleep 0.5; done
"$E" ctl ping                  # liveness: pong <version> <pid>
"$E" status --json             # running, breaker, crashloop, rss, rules, counters
"$E" metrics --json            # counters, gauges, latency percentiles
"$E" config                    # effective config and where each value came from
cat "$AH_ENGINE_DIR/ah-engine.log"
"$E" ctl stop                  # also: reload (re-read rules and config)
wait "$DAEMON" || true
```

If hooks seem slow or the engine seems absent, read `running`, `breaker` and `crashloop` in `status --json`; `ah-engine reset` clears a breaker or crash-loop stop. The troubleshooting table in [AH-ENGINE.md](AH-ENGINE.md) lists the rest. Run a daemon in the foreground with `ah-engine serve` to see it directly. To debug a check without a daemon, pipe a payload to `ah-engine check <name>`. Plugin hooks write under `~/.anti-hall/` and `<project>/.anti-hall/`; `~/.anti-hall/ah-engine/bin/ah-engine doctor` explains what is wrong.

## A debugging session

A walkthrough for "the engine misbehaves on my machine", from a switch you can flip on a running install to a stack of a frozen
daemon. Every step names the setting behind it; the generated [reference](../ah-engine/REFERENCE.md) lists every flag, environment
variable and key. The same steps apply to the Codex port: the engine is one binary for both hosts, and a Codex hook payload goes
through `ah-engine hook --event <Event> --host codex` exactly like a Claude one.

**The rules of an experiment.** Never touch the live daemon's state: reproduce in a scratch home (step 7), read the live logs
only. Stop a process by its PID (`kill <pid>`), never by name (`pkill` also stops the daemons of your other sessions). Do not
roll back the engine on a hunch: roll back only when hooks exceed their timeout or the guards stop blocking.

1. **Debug mode on, and off again.** Debug mode is a run-time switch of the one release build; nothing is rebuilt. Turn it on for one
   command with `--debug`, for one process tree with `AH_ENGINE_DEBUG=1`, or for the daemon with the setting
   `diagnostics.debug_mode` (a plugin defaults file or your config file; the reference entry says whether a daemon restart is needed).
   Turn it off by dropping the flag, unsetting the variable or setting the key back to its default. Leave it off in normal use.
2. **Where the logs are.** The state directory is `~/.anti-hall/ah-engine/`, or `AH_ENGINE_DIR`. In it: `ah-engine.log` (the event
   log: starts, crashes, breaker changes, failures), `last-crash.json` (the daemon's last panic or abnormal exit, with its
   breadcrumb), `cli-crash.json` (the last panic of a command-line run or hook client; it is not a daemon crash and never counts
   as a restart), `mem.ndjson` (one memory line per request) and `mem-snapshot.json` (written when the memory cap trips).
   `ah-engine status --json` reads them for you: `health.degraded`, `health.restarts`, `health.last_crash`.
3. **Which thread is busy.** `ah-engine status --threads` prints the CPU % of every daemon thread over a short window, with the work
   counters per second behind it. `ah-engine status --memory` prints the heap against RSS, the budget of each cache and the
   sizes of the in-memory structures. Both are described in [CPU and memory profiling](AH-ENGINE.md#cpu-and-memory-profiling).
4. **A profile.** [samply](https://github.com/mstange/samply) works on both platforms: `samply record -p <pid>` samples the
   daemon until you stop it and opens the Firefox Profiler; on macOS the `ah-engine.dSYM` beside a local build (or the release's
   `symbols-<triple>` artifact for the same build) names the frames. Without samply, macOS has `sample <pid> 5 -file s.txt`,
   symbolised with `atos -o ah-engine.dSYM/Contents/Resources/DWARF/ah-engine -arch arm64 -l <load address> <address>`; Linux
   has `perf record -g -p <pid>`.
5. **A frozen daemon.** If `ah-engine ctl ping` does not answer, do not restart it first: take its stacks. With the debugger
   attached for only as long as the command runs:

   ```text
   rust-lldb -p <pid> --batch -o 'thread backtrace all' -o detach -o quit
   ```

   On Linux, `eu-stack -p <pid>` or `gdb -p <pid> -batch -ex 'thread apply all bt'`. Save the output next to
   `last-crash.json`, then restart the daemon (`ah-engine ctl stop`, or `kill <pid>`; the next hook call starts a fresh one).
6. **Memory.** `status --memory` first. If a number grows, `mem.ndjson` shows which request kind and event it grew on, and
   `mem-snapshot.json` is the picture at the moment the cap tripped. For allocation sites switch the allocator: set
   `diagnostics.allocator` to `system` (or run one daemon with `AH_ENGINE_ALLOCATOR=system`) and attach the platform's tools
   (`MallocStackLogging` and `leaks` on macOS, `heaptrack` on Linux); the details are under "Heap diagnostics" above. Switch back
   to the default afterwards; the daemon must restart for either change.
7. **Reproduce in a scratch home.** Never point an experiment at the live state. Copy what you need, read-only, into a scratch
   directory and run a second daemon there:

   ```text
   SCRATCH=$(mktemp -d /tmp/ah-debug.XXXXXX)
   ah-engine backup --to "$SCRATCH/snapshot"             # a consistent copy of the databases; the live ones are only read
   cp ~/.anti-hall/ah-engine/ah-engine.log "$SCRATCH/"    # logs are plain files
   export HOME="$SCRATCH/home" AH_ENGINE_DIR="$SCRATCH/state"
   mkdir -p "$HOME" "$AH_ENGINE_DIR"
   ah-engine serve >"$SCRATCH/serve.out" 2>&1 &           # its socket lives under AH_ENGINE_DIR, not next to the live one
   DAEMON=$!
   ah-engine ctl ping && ah-engine status --threads
   kill "$DAEMON"                                          # by PID, never by name
   ```

   Run the block in a subshell so that `HOME` and `AH_ENGINE_DIR` change nothing in your own shell, and remove the scratch
   directory when you are done.

**Worked example: a daemon at 55 to 60 % CPU with nothing to do.** `status` showed a healthy daemon (no restarts, no breaker). `status
--threads` named one thread: `ah-dswire`, the DevSwarm wire, at 55 to 60 % of a core while every hook worker was idle. The work
counters showed about 10 `dswire_reconciles` per second although no workspace changed: the thread was waking itself. Reading the
reconcile showed why. It opens each active workspace's SQLite store to count unread mail, and opening a store touches its `-shm`
index file; the store's directory was watched, so the touch became the next reconcile's trigger a tenth of a second later, forever.
The fix ignores file names ending in `realtime.ignore_suffixes` (default `-shm`) in the watcher, allows at most one event-driven
reconcile per `devswarm_wire.reconcile_min_gap_ms`, and reads the workspace descriptors once per reconcile instead of once per
open store. The proof is the same counters: a failing-first test saw 20 idle reconciles in 3 seconds before and none after, and a
benchmark with live-like data went from 22.0 % to 1.23 % of a core. The lesson for your own session: name the thread first
(`status --threads`), read the counters behind it, and only then read code.

## Porting a guard to the engine

The workflow is the one in D31 and D57: port check by check, each through parity, shadow and review. (Historical: every guard has been ported; the engine decides every hook and the Node hooks are a backup outside the published plugin. New guards are written for the engine only, see CONTRIBUTING.md.)

1. **Read the Node guard** and its tests under `plugins/anti-hall/hooks/` and `tests/hooks/`. The guard's `evaluate(payload, env)` is the authority; a mismatch is a Rust bug, never a reason to change the Node guard.
2. **Implement `Check`** in its own module under `ah-engine/src/checks/`, and list it in the registry. Put every table, limit and message in `plugins/anti-hall/engine/defaults/*.toml` (the `no_hardcoded_tunables` test fails otherwise) and cite the Node function each Rust function mirrors. Where the engine cannot decide exactly, return a deferral so Node decides; never guess.
3. **Parity.** Add `ah-engine/parity/run-<name>.js`, modelled on `run-git.js`. Its corpus is the guard's own Node test cases, real recorded commands and adversarial and fuzz cases. It must reach 100 percent in oneshot and daemon mode, and `run-git.js` must stay at 100 percent.
4. **Gates.** Format, clippy, docs and `./test.sh` green, then regenerate `REFERENCE.md` ([Run the tests](#run-the-tests)).
5. **Shadow** period (the engine runs beside Node and the two are compared on live traffic, before cutover): per entry with `mode = "shadow"` (the check runs beside the Node hook, which still decides, and `dispatch_shadow` logs whether they agree); before a release the whole dispatcher is also replayed against Node on a frozen payload sample. See "Install, go-live and rollback" in [AH-ENGINE.md](AH-ENGINE.md).
6. **Review**, then cutover per guard, then the Node guard is deleted (D31).

New capability goes into the engine, not into new Node code in the plugin (D80). Details of the extension points are in "How to extend it" in [AH-ENGINE.md](AH-ENGINE.md).

## Branches and pull requests

- `dev` is the working branch. Pushes to `dev` run only the path-filtered `ah-engine` workflow and `privacy-scan`, so run `cargo check` and a release build of what you touched before pushing.
- `main` is what users and the plugin directory install from. It changes only through a pull request from `dev`; a ruleset blocks direct pushes. A pull request to `main` from any other branch fails the required `dev-only` check.
- **Contributors open pull requests against `dev`.** The engine prototype lives on `engine-proto` and goes to `dev` by pull request when a phase is done and tested (D55).
- Never force-push. Commit messages are conventional (`fix(area): ...`, `feat(area): ...`, `docs: ...`) with no AI-credit lines ([CONTRIBUTING.md](../CONTRIBUTING.md)).

<!-- doc-check: skip (pushes and opens a pull request; needs gh auth) -->
```sh
git push origin dev
gh pr create --base dev --fill
gh pr checks
```

## Working method for features and fixes

How parallel contributors or agents work on `dev` without blocking each other. Later changes add their own subsections here.

### Merge model

| Branch | Required to merge | Source |
|---|---|---|
| `dev` | `tests-passed`, `privacy-scan` | ruleset "dev: required checks" |
| `main` | `dev-only`, `tests-passed`, `privacy-scan`, plus a pull request (merge commits only) | ruleset "main protection" |

- Every other job (`rust`, `ah-hook`, `doc-check`, `no-node`, `pr-title`, and so on) is **informational**: read it, but it does not block the merge.
- `tests-passed` is currently a placeholder job in `.github/workflows/test.yml` that only prints a line (the Node suite it once gated is retired). The engine suite is the `rust` job in `.github/workflows/ah-engine.yml`. A green `tests-passed` therefore does not prove the engine tests passed: read `rust` too.
- Merge as soon as the required checks pass. Open a follow-up only when an informational job points at the pull request's own code.
- Merge commits, never squash. `dev` reaches `main` by pull request only.

### Workflow rules

1. Before a batch, read once: the required checks (above), the CI timings of the last runs (`gh run list`) and local capacity (cores, free disk).
2. At most 2-3 concurrent builders, on disjoint files. A builder never edits files another builder owns.
3. Generated files are regenerated once, by one integrator, after the merges. Never hand-merge them; take either side and regenerate:

   | Generated | Regenerate (from `ah-engine/`) |
   |---|---|
   | `REFERENCE.md` | `cargo run -q --locked -- docs --format md > REFERENCE.md` |
   | Hook files per host (`hooks.json`, `hooks.registry.json`, fallback list) | `cargo run --bin ah-gen-fallback-list -- --repo ..` |
   | `anti-hall:engine*` skills (Claude and Codex) | `scripts/gen-engine-skills.sh` |

4. Before the first push run `cargo fmt`, `cargo check --tests --locked` and the fast drift tests (see "Local pre-push gate").
5. Commit early. Push as soon as it builds. Do not wait on CI; read it when it finishes.
6. Verify a delegated worker's "done" yourself, from the API or the test output, not from its report.
7. Put only verified facts in a task brief. An unchecked claim in a brief is copied as truth.
8. A timing-flaky test is fixed or quarantined through an issue, not re-run in a loop until it passes.

### Local pre-push gate

Run from `ah-engine/`, one test runner at a time, `nice -n 10`, `-j 2` where a command takes it.

| Step | Command |
|---|---|
| Format | `cargo fmt` (CI runs `cargo fmt --check`) |
| Compiles, tests included | `cargo check --tests --locked` |
| Fast drift tests (generated files, docs, policy) | `cargo test --locked --test it -- reference:: hooks_files:: roles:: docs_coverage:: no_hardcoded_tunables:: defaults_keys::` |
| Touched module plus policy gates | `scripts/lane-tests.sh <module>` |
| Lint | `cargo clippy --all-targets --locked -- -D warnings` |
| Before a live deploy | `cargo nextest run -j 2 --profile dev` |
| Everything CI runs on the engine | `./test.sh` |

The CI quick profile and change-detection job are described in their own subsection once merged.

## Releases

The plugin and the engine have separate versions and separate release procedures. A release is a maintainer task.

- **Plugin:** [RELEASING.md](../RELEASING.md). Bump `plugins/anti-hall/.claude-plugin/plugin.json` (the version authority; the Codex manifest, `package.json` and `package-lock.json` track it), add a `CHANGELOG.md` section, sweep the docs, run `node --test`, then a pull request `dev` to `main` and a tag after the merge. Check the GitHub Actions result before calling a release done.
- **Engine:** [`ah-engine/RELEASING.md`](../ah-engine/RELEASING.md). Bump `version` in `ah-engine/Cargo.toml`, run the prepare workflow, merge the pull request that updates `ah-engine.lock`, then push the tag `ah-engine-vX.Y.Z`.

## Repository layout

| Path | What |
|---|---|
| `plugins/anti-hall/hooks/` | Claude hooks, `hooks.json`, `doctor.js`, `lib/` (including `settings-schema.js`) |
| `plugins/anti-hall/codex/` | the Codex port: its `hooks.json`, skills, scripts and `install-codex.js` |
| `plugins/anti-hall/skills/`, `agents/`, `scripts/`, `companion/`, `monitors/`, `statusline/` | skills, agents, CLIs, opt-in companions, monitors, statusline |
| `ah-engine/` | the Rust engine: its own Cargo workspace, docs, tests and CI. Layout in [`ah-engine/README.md`](../ah-engine/README.md) |
| `ah-engine/src/`, `parity/`, `tests/`, `scripts/` | engine source, parity harnesses, tests, build and release scripts |
| `plugins/anti-hall/engine/` | the engine's configuration, which ships with the plugin: `defaults/*.toml` (every setting, table, message and the dispatch table, listed by `defaults/index.toml`) and `rules.json`. **Tune in these files; the engine only runs them.** It reads them at run time (start-up, plugin update, file change), never from `ah-engine/` and never from the binary |
| `tests/` | the plugin suite: `hooks/`, `hygiene/`, `codex/`, `scripts/`, `skills/`, `e2e/`, `helpers/`, `fixtures/` |
| `evals/anti-hall/`, `tools/eval/` | the benchmark suite (`claude plugin eval`) and the older fabrication A/B harness |
| `tools/` | generators and the docs-site builder (`gen-protocol.js`, `gen-agents-catalog.js`, `gen-kb-counts.js`, `build-site.js`) |
| `docs/` | the guide, the engine overview and the knowledge-base files |

## Coding standards

- **Plugin:** Node built-ins only, no dependencies, cross-platform. Hooks fail open: a parse, read or state error exits 0 and never blocks a turn. A guard blocks only on a positive match of the dangerous form. Large hook JSON goes out with `fs.writeSync(1, ...)`, not `process.stdout.write`.
- **Both ports:** a change to a hook, skill or model-routing doc lands on the Claude side and the Codex mirror, or the pull request says why one side does not apply ([AGENTS.md](../AGENTS.md)).
- **Settings:** every feature has a key in `plugins/anti-hall/engine/defaults/settings_cli.toml`; change settings through `/anti-hall:settings`, never by hand.
- **Engine:** no hardcoded tunables, tables or messages (D17): they live in the plugin's `engine/defaults/*.toml` with a `doc`, read at run time, never compiled in. Every public item has `//!` or `///` docs, errors are typed, and `rustfmt.toml` sets the width. Clippy and `cargo doc` run with warnings denied. Tests take no timing dependence (CI runners are slower), never touch the real home, and reap every daemon they start.
- **Dependencies:** a Rust crate you add is at its latest released version, and an old pin needs a written reason in `ah-engine/DECISIONS.md` (D84).
- **Docs:** a new hook, skill or setting is documented in `docs/GUIDE.md`, `llms.txt` and the briefing skill; the hygiene tests name what is missing. Mark unbuilt work "planned (D-n)".
- **Public repo:** shipped files stay project- and user-agnostic: no private names, paths or emails, other than the author credit.

## Keeping this guide true

`ah-engine/scripts/doc-check.sh` clones this checkout into a scratch directory, isolates `HOME`, runs `nice -n 19` with `CARGO_BUILD_JOBS=2`, and runs every fenced `sh` block of this file in order, stopping at the first failure. Only fences opened with exactly `` ```sh `` are run. Place one of these comments directly above a block to control it:

| Comment | Effect |
|---|---|
| `<!-- doc-check: skip (reason) -->` | not run: needs credentials, installs globally or writes outside the clone |
| `<!-- doc-check: needs tool ... -->` | run only when every tool is installed, otherwise skipped and reported |
| `<!-- doc-check: long -->` | a full test suite; skipped with `--fast` |

The CI job `doc-check` in `.github/workflows/ah-engine.yml` runs it on ubuntu and macOS.

<!-- doc-check: skip (it would run itself) -->
```sh
ah-engine/scripts/doc-check.sh --fast
```
