# Development guide

How to build, test, run and release anti-hall from a fresh checkout on macOS or Linux (including WSL). Windows is not supported. It covers the plugin (Node hooks, skills, scripts) and the `ah-engine/` Rust engine. Anything not built yet is marked **planned (D-n)**, where `D-n` is an entry in [`ah-engine/DECISIONS.md`](../ah-engine/DECISIONS.md).

Every shell command in this guide is run by `ah-engine/scripts/doc-check.sh` in a fresh clone (see [Keeping this guide true](#keeping-this-guide-true)). A command that needs credentials, installs something globally or writes outside the clone is marked as skipped there.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Rust | `1.99.0`, pinned in [`ah-engine/rust-toolchain.toml`](../ah-engine/rust-toolchain.toml) with `rustfmt` and `clippy` | building and testing `ah-engine/` |
| Node.js | 22 or newer (`engines` in `package.json`; CI runs 22 and 24) | the plugin, which is still the live implementation, plus `tools/`, `evals/` and the parity harnesses. No `npm install`: everything is built-ins only |
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

## Run the tests

| Suite | Command | Where |
|---|---|---|
| Engine, everything | `./test.sh` | `ah-engine/` |
| Engine, one file | `cargo test --locked --test <name>` | `ah-engine/tests/` |
| Engine, lint and docs | `cargo fmt --check`, clippy, `cargo doc` | `ah-engine/` |
| Plugin | `node --test` | repo root |
| Generated files | `node tools/gen-*.js --check` | repo root |
| Parity harnesses | `node parity/run-*.js` | `ah-engine/parity/` |
| Evals | `node evals/anti-hall/run.js` | repo root, spends money |

**Engine.** `./test.sh` runs the whole suite, then fails if any `ah-engine serve` daemon from this build tree is still alive (tests reap their own daemons and use their own `HOME`). Run one test runner at a time.

<!-- doc-check: long -->
```sh
cd ah-engine
./test.sh
```

```sh
cd ah-engine
cargo test --locked --test no_hardcoded_tunables
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --locked
```

After you change a command, setting, metric, impact kind or check, regenerate the reference. A test fails when `REFERENCE.md` differs from the generated text.

```sh
cd ah-engine
cargo run -q --locked -- docs --format md > REFERENCE.md
git diff --stat -- REFERENCE.md
```

**Plugin.** From the repo root, with no install step. The suite includes the `evals/` unit tests and the docs and link checks.

<!-- doc-check: long -->
```sh
node --test
```

```sh
node --test tests/hygiene/docs-links.test.js
node tools/gen-protocol.js --check
node tools/gen-agents-catalog.js --check
node tools/gen-kb-counts.js --check
node plugins/anti-hall/hooks/doctor.js --check
```

A green local run is not a green CI run. CI runs on ubuntu and macOS, slower, with a real `HOME` and a detached `HEAD`; read the Actions result on your pull request. Tests must never touch the real home: see "Test isolation" in [CONTRIBUTING.md](../CONTRIBUTING.md).

**Evals.** `evals/anti-hall/run.js` runs the benchmark suite through `claude plugin eval`. It needs a logged-in `claude`, spends API money and requires `--max-cost-usd`; read [BENCHMARK-METHOD.md](BENCHMARK-METHOD.md) first. The harness's own unit tests run as part of `node --test`.

<!-- doc-check: skip (needs claude login and spends API money) -->
```sh
node evals/anti-hall/run.js --arm anti-hall --max-cost-usd 3 --label smoke
```

**Parity harnesses.** A ported guard must give the same exit code, stdout and stderr as its Node original ([D31](../ah-engine/DECISIONS.md)). Build the release binary first. `--mode both` runs the check in-process and through a real daemon, which the harness starts and waits for.

```sh
cd ah-engine/parity
node run-git.js --engine ../target/release/ah-engine --hooks ../../plugins/anti-hall/hooks --corpus corpus.jsonl --mode both --out /tmp/ah-git-mismatches.json
```

`corpus.jsonl` is the committed git corpus; the number to reach is 100 percent, with every command the engine cannot decide exactly deferred to Node. The harnesses for the other ports (`run-merge-side-pick.js`, `run-ship-it-guard.js`, `run-scan-throttle.js`, `run-coordinator-work-guard.js`, `run-compact-declaration-guard.js`) also need a file of recorded commands, which is not in the repository, so a clone cannot run them as they are:

<!-- doc-check: skip (needs a recorded-commands file that is not in the repository) -->
```sh
cd ah-engine/parity
node run-merge-side-pick.js --engine ../target/release/ah-engine --hooks ../../plugins/anti-hall/hooks --cmds <recorded-commands.jsonl>
```

The six session-maintenance ports (`version-alert`, `devswarm-version`, `claude-cli-version`, `repo-self-drift`, `defect-nudge`, `progress-prune`) are scripts that read and write files, so their harness `run-session.js` needs no recorded commands: every scenario is a fixture directory (home, project, plugin root). It runs the real Node hook (with a spy that records and suppresses any process it would start), then the engine, on the same paths and fresh copies of the fixture, and compares exit code, stdout and every file under home and project. It takes a few minutes and needs `git` and `node` on the `PATH`.

<!-- doc-check: skip (about 2,400 scenarios; run on demand) -->
```sh
cd ah-engine/parity
node run-session.js --engine ../target/release/ah-engine --repo ../.. --hook all
```

## Run the plugin against a local engine

The plugin does not start or call the engine today: the engine is off by default, and the plugin runs its Node hooks. The configuration key and environment variable that point the plugin at a locally built binary are **planned (D71)**. Until then, exercise the engine directly, in a throwaway state directory (keep its path short, because the daemon's socket lives there):

```sh
E="$PWD/ah-engine/target/release/ah-engine"
export AH_ENGINE_DIR="$(mktemp -d /tmp/ah-dev.XXXXXX)"
export AH_ENGINE_RULES="$PWD/ah-engine/rules.json"
PAYLOAD='{"session_id":"dev","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}'

# one check, in-process, no daemon: exit 2 and the reason on stderr is a block
echo "$PAYLOAD" | "$E" check git || test $? -eq 2

# the hook path: the client starts a daemon if none runs and prints the host's JSON answer
echo "$PAYLOAD" | "$E" hook
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

```sh
node plugins/anti-hall/codex/install-codex.js --dry-run
```

<!-- doc-check: skip (writes .codex/ in the clone, or ~/.codex with --global) -->
```sh
node plugins/anti-hall/codex/install-codex.js
node plugins/anti-hall/codex/install-codex.js --global
```

Check an install with `node plugins/anti-hall/hooks/doctor.js --check`, or ask "is anti-hall working" inside a session.

## Debug the engine

State lives in `~/.anti-hall/ah-engine/`, or in `AH_ENGINE_DIR` when set. The event log there is `ah-engine.log`: one line per start, crash, breaker change and failure, with secrets scrubbed. Every command accepts `--json`.

```sh
E="$PWD/ah-engine/target/release/ah-engine"
export AH_ENGINE_DIR="$(mktemp -d /tmp/ah-dev.XXXXXX)"
export AH_ENGINE_RULES="$PWD/ah-engine/rules.json"
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

If hooks seem slow or the engine seems absent, read `running`, `breaker` and `crashloop` in `status --json`; `ah-engine reset` clears a breaker or crash-loop stop. The troubleshooting table in [AH-ENGINE.md](AH-ENGINE.md) lists the rest. Run a daemon in the foreground with `ah-engine serve` to see it directly. To debug a check without a daemon, pipe a payload to `ah-engine check <name>`. Plugin hooks write under `~/.anti-hall/` and `<project>/.anti-hall/`; `node plugins/anti-hall/hooks/doctor.js` explains what is wrong.

## Porting a guard to the engine

The workflow is the one in D31 and D57: port check by check, each through parity, shadow and review. The plugin stays Node and live until a guard has passed all three.

1. **Read the Node guard** and its tests under `plugins/anti-hall/hooks/` and `tests/hooks/`. The guard's `evaluate(payload, env)` is the authority; a mismatch is a Rust bug, never a reason to change the Node guard.
2. **Implement `Check`** in its own module under `ah-engine/src/checks/`, and list it in the registry. Put every table, limit and message in `ah-engine/defaults/*.toml` (the `no_hardcoded_tunables` test fails otherwise) and cite the Node function each Rust function mirrors. Where the engine cannot decide exactly, return a deferral so Node decides; never guess.
3. **Parity.** Add `ah-engine/parity/run-<name>.js`, modelled on `run-git.js`. Its corpus is the guard's own Node test cases, real recorded commands and adversarial and fuzz cases. It must reach 100 percent in oneshot and daemon mode, and `run-git.js` must stay at 100 percent.
4. **Gates.** Format, clippy, docs and `./test.sh` green, then regenerate `REFERENCE.md` ([Run the tests](#run-the-tests)).
5. **Shadow** period (the engine runs beside Node and the two are compared on live traffic, before cutover): **planned**, see D31 and D41. The engine stays off by default (`engine.enabled`) until parity and the shadow period pass.
6. **Review**, then cutover per guard, then the Node guard is deleted (D31).

New capability goes into the engine, not into new Node code in the plugin (D80). Details of the extension points are in "How to extend it" in [AH-ENGINE.md](AH-ENGINE.md).

## Branches and pull requests

- `dev` is the working branch. Pushes to `dev` run no CI, so run `node --test` (and the engine suite when you touched `ah-engine/`) before pushing.
- `main` is what users and the plugin directory install from. It changes only through a pull request from `dev`; a ruleset blocks direct pushes. A pull request to `main` from any other branch fails the required `dev-only` check.
- **Contributors open pull requests against `dev`.** The engine prototype lives on `engine-proto` and goes to `dev` by pull request when a phase is done and tested (D55).
- Never force-push. Commit messages are conventional (`fix(area): ...`, `feat(area): ...`, `docs: ...`) with no AI-credit lines ([CONTRIBUTING.md](../CONTRIBUTING.md)).

<!-- doc-check: skip (pushes and opens a pull request; needs gh auth) -->
```sh
git push origin dev
gh pr create --base dev --fill
gh pr checks
```

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
| `ah-engine/src/`, `defaults/`, `parity/`, `tests/`, `scripts/` | engine source, shipped defaults (TOML), parity harnesses, tests, build and release scripts |
| `tests/` | the plugin suite: `hooks/`, `hygiene/`, `codex/`, `scripts/`, `skills/`, `e2e/`, `helpers/`, `fixtures/` |
| `evals/anti-hall/`, `eval/` | the benchmark suite (`claude plugin eval`) and the older fabrication A/B harness |
| `tools/` | generators and the docs-site builder (`gen-protocol.js`, `gen-agents-catalog.js`, `gen-kb-counts.js`, `build-site.js`) |
| `docs/` | the guide, the engine overview and the knowledge-base files |

## Coding standards

- **Plugin:** Node built-ins only, no dependencies, cross-platform. Hooks fail open: a parse, read or state error exits 0 and never blocks a turn. A guard blocks only on a positive match of the dangerous form. Large hook JSON goes out with `fs.writeSync(1, ...)`, not `process.stdout.write`.
- **Both ports:** a change to a hook, skill or model-routing doc lands on the Claude side and the Codex mirror, or the pull request says why one side does not apply ([AGENTS.md](../AGENTS.md)).
- **Settings:** every feature has a key in `plugins/anti-hall/hooks/lib/settings-schema.js`; change settings through `/anti-hall:settings`, never by hand.
- **Engine:** no hardcoded tunables, tables or messages (D17): they live in `defaults/*.toml` with a `doc`. Every public item has `//!` or `///` docs, errors are typed, and `rustfmt.toml` sets the width. Clippy and `cargo doc` run with warnings denied. Tests take no timing dependence (CI runners are slower), never touch the real home, and reap every daemon they start.
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
