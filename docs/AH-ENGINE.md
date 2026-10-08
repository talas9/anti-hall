# ah-engine

`ah-engine` is a small resident program that anti-hall's hooks can ask instead of starting a new Node process for every
tool call. This page explains what it is, why it exists, what works today and what is not built yet. Anything not built
is marked **planned** with the number of its decision, for example planned (D33) for the scheduler; each number is an entry
in [`ah-engine/DECISIONS.md`](../ah-engine/DECISIONS.md).
The exact list of commands, settings, metrics and error codes is generated from the engine itself and lives in
[`ah-engine/REFERENCE.md`](../ah-engine/REFERENCE.md).

**Status: ready for release; the plugin installs it itself once a release pins it.** The plugin's hooks are one thin trigger
per event (`hooks/ah-hook.sh <Event>`). When the engine binary is installed, the trigger asks the engine, which decides
natively what it can prove identical to the Node hook and hands every other case to that Node hook, so it is never weaker
than Node. When the binary is absent or cannot answer, the trigger runs the Node hooks, exactly as before. The binary is
fetched by a shell bootstrap, checked against a sha256 pinned in the plugin ([Install, go-live and rollback](#install-go-live-and-rollback)).
Supported platforms: macOS and Linux (including WSL, which runs the Linux build). Windows is not supported yet.

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
   |-- checks (compiled in)     real logic a regex cannot express: the git and command checks
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
- **Small guard ports.** `merge-side-pick`, `ship-it-guard`, `scan-throttle`, `coordinator-work-guard` and
  `compact-declaration-guard` are the five small guards ported from Node. They share `checks/guardkit`: the switch and
  skip-file lookup, the message layout, JavaScript-exact regex translation and the per-session state files the Node guards
  keep under `~/.anti-hall/` (written in the same bytes, so a Node hook that answers for the same session in turn reads
  the same record; an in-memory store remains for tests; the database-backed store is planned, D22). Their PostToolUse
  companions run as checks too (`merge-side-pick` records, `coordinator-work-guard` keeps the work window, `git-audit`
  reads the recent commits, `failure-root-cause-nudge` answers PostToolUseFailure). Where the Node verdict cannot be reproduced exactly (a block whose
  stdout and stderr the reply cannot carry yet, a regex construct, a classifier that lives in another port) the check
  defers, so Node decides.
- **Prompt-emission ports.** `verify-first`, `idle-agent-sweep` and `emit-dedupe-reset` are the UserPromptSubmit and
  SessionStart context hooks of the dedupe family. They share `checks/emit_dedupe`, which reads and writes the very same
  per-session state file the Node hooks still use (`~/.anti-hall/emit-dedupe/dedupe-<session>.json`: key order, entry
  layout, the 24 hour key expiry, atomic write, suppression counter and the throttled sweep of idle session files). A
  state file, transcript line or timestamp that JavaScript might read differently defers the whole hook to Node before
  anything is written; so does a possible DevSwarm Primary session for `verify-first`, whose extra sentence depends on
  the repo's `CLAUDE.md` chain.
- **Context-budget gates.** `limit-conserve-inject`, `auto-handover` (both UserPromptSubmit), `auto-handover-pause-nag` and
  `compact-advice-guard` (both Stop) answer the case in which the Node hook injects nothing, blocks nothing and writes no
  file: the feature off or skipped, a subagent, context below the threshold, no usage bucket over its limit, a turn whose
  final text holds no compact-recommendation wording. Every other case (a fire, a nag, a re-arm, an active conservation,
  a possible recommendation) defers, so the files those hooks write (the per-session latch, the account-switch file, the
  emit-dedupe state, the once-per-declaration hash) are only ever written by the Node implementation (`checks/ctxbudget`,
  `defaults/ctxbudget.toml`).
- **Injection gate (token cuts).** After the Node hooks have run, the dispatcher passes on `limit-conserve-inject`,
  `task-tracker`, the DevSwarm comms-override line and `swarm-guard`'s shared-tree advisory only when the model does not
  already hold them (new, changed, or due again as a keepalive), per session and agent. State lives in the daemon, bounded
  (`inject_gate.max_sessions`, `inject_gate.max_slots`) and shown in `status` and the `inject_gate_*` gauges; `ah-engine ctl gate` prints
  per-session injected and kept-out bytes. Each cut is a setting (`context.injectGate*`); off, the Node output passes unchanged
  (`dispatch/inject.rs`, `gate.rs`, `defaults/inject_gate.toml`).
- **Session maintenance ports.** `version-alert`, `devswarm-version`, `claude-cli-version`, `repo-self-drift`,
  `defect-nudge` and `progress-prune` are the six SessionStart hooks that keep a small cache or ledger under the home
  directory. They are not guards (D74: non-guard hooks fail open) and they share `checks/session`: an order-preserving JSON
  value that prints numbers the way JavaScript does (the Node and Rust writers share the state files), the drift-cache
  mechanics and the JavaScript date and version reading. Each reproduces its Node hook's output bytes and its state-file
  writes. The engine never starts a background process: a stale version cache (Node spawns a detached probe), a payload with
  no working directory (Node reads its own), a `.git` file or date or JSON text it cannot read exactly like JavaScript, or a
  gitignore probe slower than `session.gitignore_probe_ms` all answer a deferral BEFORE anything is written, so the Node hook
  then runs whole and sees the state it would have seen.
- **Response-correctness ports.** `speculation-guard`, `speculation-judge`, `claim-ledger` (Stop) and `output-verify-guard`
  (PostToolUse on Bash) share `checks/replykit`: JavaScript-faithful JSON (key order and number text kept), the transcript
  tail reader, the once-per-turn gate and the stale-state sweep. The Jev call path is NOT ported with them: every call
  where Node would consult Jev (the master switch on for `speculation-guard`; a flagged turn or a test-runner output with
  the integration not `off` for `claim-ledger` and `output-verify-guard`; every opted-in call of `speculation-judge`,
  which is a model call with its own backends) defers to Node, so Jev-off installs are answered by the engine and
  Jev-on installs keep Node's exact behavior, log rows included. The block of `speculation-guard` is therefore never
  weaker than Node's (D74). The one deliberate difference with Jev off: Node's `claim-ledger` and `output-verify-guard`
  still append a `mode: "off"` row to the Jev decision log per consult; the engine's Jev layer never does (D35), and
  neither do these checks.
- **Handover and Codex ports.** `handover-resume` (SessionStart), `precompact-snapshot` (PreCompact), `codex-availability`
  (SessionStart), `codex-quota-detect` (PostToolUse on Agent) and `codex-nudge` (Stop) are ported from Node. They share
  `checks/jsport`, which reproduces the JavaScript behavior the hooks depend on (number formatting, `JSON.parse` key
  order, `Date` formatting and the part of `Date.parse` whose result is certain, UTF-16 string handling, the
  repository-identity resolver) and `checks/codex/quota.rs`, the quota record in `~/.anti-hall/codex-availability.json`.
  A case the port cannot reproduce exactly (a date string in an unfamiliar shape, a state file holding `__proto__`,
  a Codex result whose key order could change what matches, an enabled Jev consult for the nudge) defers, so Node
  decides; the deferral happens before any write the Node hook would repeat.
- **Task checks.** `task-lifecycle-log`, `dispatch-tier`, `task-guard` and `tasklist-guard` share `checks/taskkit` (the
  JavaScript string and truthiness semantics over a JSON value, the ledger text sanitizer, the UTC clock text, the project
  root resolvers `repoRoot` and `sessionProjectRoot` of `handover-find.js` answered from the file system alone, and the
  work-detection port of `lib/work-detect.js`) and `checks/taskstate` (the task list rebuilt from a transcript tail, the
  backfill that recovers records before the tail, and the unknown-state note). A task check does the file effects of its
  Node hook itself and answers exactly what Node would; anything it cannot reproduce byte for byte defers. The two Stop
  gates never block: they answer the Stops on which Node stays quiet and hand every Stop that would block, and every Stop
  whose decision needs a running-agent scan, to the Node hook (D74). `task-tracker` (UserPromptSubmit) stays on Node: its
  output depends on the emit-dedupe state, the Jev decision-log row written on every prompt and the agent scan, which are
  other lanes' ports.
- **DevSwarm role ports.** `devswarm-child-role` (SessionStart) and `devswarm-parent-gate` (Stop) share
  `checks/devswarm_role`. The Stop gate is a guard, so it is never weaker than Node (D74): the engine allows only where
  the Node hook exits silently before reading any mailbox (switch off, user skip, supervisor inactive, a child
  workspace, the judge child) and defers every session that could be blocked. The child-role check reproduces a child
  workspace's directive byte for byte when the stable launchers it names already exist with the content Node would write,
  and defers a Primary (seat adoption needs the DevSwarm CLI and the mailbox store, D45), a missing or stale launcher, and
  anything it cannot prove identical. The engine never writes a launcher.
- **Checks.** A check is Rust code behind the `Check` trait, registered by name in `checks::registry()`. Today there are
  sixty-one: `devswarm-child-role`, `devswarm-parent-gate`, `devswarm-child-gate`, `devswarm-parent-reply-tracker` and `devswarm-child-drain` (see DevSwarm role ports above and the table below), `task-lifecycle-log`, `dispatch-tier`, `task-guard` and `tasklist-guard` (see Task checks above), `devswarm-parent-inbox` and `devswarm-child-turn` (see DevSwarm prompt gates above), the five handover and Codex ports above, the four response-correctness ports above, `limit-conserve-inject`, `auto-handover`, `auto-handover-pause-nag` and `compact-advice-guard` (the
  context-budget gates above), `git` (a port of the git-guard hook with 100 percent agreement with the Node original on every corpus tried),
  `command` (a port of the command-guard hook that answers the commands Node allows in every context and defers the rest
  to the Node hook, also at 100 percent agreement), `model-routing` (the model-routing guard for Agent/Task spawns), and
  the five small guard ports above: `merge-side-pick`, `ship-it-guard`, `scan-throttle`, `coordinator-work-guard` and
  `compact-declaration-guard` (see the README of `ah-engine/`), and two PostToolUse-side checks: `git-audit` (the
  `--audit` pass of git-guard) and `failure-root-cause-nudge` (PostToolUseFailure), plus the three context checks `verify-first-subagent`
  (SubagentStart), `verify-first-full` (SessionStart) and `fable-availability` (SessionStart). The context checks are not
  guards: they inject text or record a fact, never block, and anything they cannot reproduce exactly defers to the Node
  hook (D74); the four spawn/path context ports below; and the three prompt-emission ports `verify-first` (the
  short rotating reminder), `idle-agent-sweep` (agents that finished but were never stopped) and `emit-dedupe-reset`
  (marks a context loss at SessionStart); the four context-budget gates; and the six session maintenance ports above:
  `version-alert`, `devswarm-version`, `claude-cli-version`, `repo-self-drift`, `defect-nudge` and `progress-prune`; and the three agent and transcript controls `ask-guard`, `silent-agent-nudge`
  and `stale-agent-stop-note`, which share one streaming port of the transcript agent scan (see the README of `ah-engine/`); and the three edit and shell guards `merge-gate`, `api-guard` and `edit-guard`, which answer only what
  Node answers with no output and no side effect (for `edit-guard`, also the launcher-directory block byte for byte) and
  defer the rest, so a possible block, a Jev shadow ask, an interpreter probe or a coordinator allowlist decision is always
  the Node hook's; and the batch 14 to 16 ports: the spawn and comms guards `swarm-guard` (the spawn-rate and
  memory-pressure limiter, with a lock file shared with the Node hook) and `devswarm-comms-guard`, and the session gates
  `jev-weekly-scorecard`, `jev-review-reminder` and `repair-on-reload`.
- **Node-only ports.** `task-tracker` (UserPromptSubmit, Claude and Codex entries) reproduces the directive/reminder cycle,
  the transcript-growth and window triggers, the keepalive and burst dedupe, the open-tasks line, the unknown-state note, the
  scoring of the previous turn's dispatch demand and the Jev `newRequest` label of each prompt (the same request through the
  engine's Jev lane). It hands to Node, before anything is written, a session that could be a DevSwarm Primary, a session with a
  task the per-turn DISPATCH NOW line would name (it counts running agents and asks Jev for a tier), a dispatch-tier outcome
  still to label, and any state file only JavaScript reads. `session-end-mcp-reaper` (SessionEnd) sweeps the MCP orphans a crashed
  session left behind with Node's exact selection rules (PID 1 must be init, parent PID 1, MCP command signature, not a test
  runner or user-excluded, old enough, not owned by the service manager, capped) and Node's audit log; it never signals more than
  Node would, never itself, its parent or a pid below 2, and hands to Node a user pattern it cannot translate exactly, a start
  time not in the `ps` form, an ambiguous local time and a request whose `TZ` differs from the daemon's. Compared with the real
  hooks in `tests/task_tracker_parity.rs` and `tests/mcp_reaper_parity.rs` (the latter on fake `ps` and `launchctl` programs).
- **Spawn/path context ports.** `inbox-read-guard` (PreToolUse on Read), `phase-tracker` (PreToolUse on Agent and Task),
  `orch-on-spawn` (PreToolUse on spawns), `verify-first-orch` (SessionStart, the Claude entry) and `verify-first-orch-codex` (the Codex entry: the same hook without the `--host=claude` flag, so no session is ever Claude-confident and the host's config directory is never read; same coverage otherwise). They share
  `checks/spawnctx`: the home directory the state files live under (with the test-run refusal of the real home), the
  DevSwarm detector, session-id sanitizing and the orchestration marker with its prune sweep. Each was compared against
  the real Node hook on a corpus of 70 to 103 payloads, on exit code, stdout bytes, stderr bytes and the state files left
  behind, with an isolated home per side (`tests/it/spawn_ctx_parity.rs`). What stays with Node, by design: a Read inside the
  raw DevSwarm store (the block depends on a module probe), a pending orchestration marker (the claim race and the
  transcript scan), a session where DevSwarm is active for `verify-first-orch` (whether it is a Primary changes the text),
  a working directory that is not a string, and a relative path or config directory that Node resolves against its own
  working directory. A deferral touches no state.
  ten: `git` (a port of the git-guard hook with 100 percent agreement with the Node original on every corpus tried),
  `compact-declaration-guard` (see the README of `ah-engine/`).
- **DevSwarm prompt gates.** `devswarm-parent-inbox` and `devswarm-child-turn` (the two DevSwarm UserPromptSubmit hooks) answer
  their silent cases in the engine: not a Primary / not a child workspace, DevSwarm inactive (kill switch, `devswarm.supervisorMode`
  off, auto mode without `DEVSWARM_REPO_ID`), the hook's own switch off, or a Jev judge child. A session that is an active Primary
  or an active child defers to the Node hook, which owns the workspace roster, the mailbox and the dedupe state (they need the
  engine-owned mesh and mailbox, D45, first). The engine renders nothing and keeps no dedupe state of its own for these hooks.

## What works today

| Area | Status | Decision |
|---|---|---|
| Daemon and client, single instance, version handoff, resident by default | implemented | D5-D8 |
| Never wedged: hard client budget, watchdog, breaker, crash-loop stop, bounded queue, per-request CPU budget | implemented | D9-D15 |
| Node fallback on every failure, never a silent allow | implemented | D11 |
| Failure classification, once-per-session advisory, secret-scrubbed diagnostics | implemented | D14 |
| Socket 0600, private directory, peer uid check, no network in the daemon | implemented | D16 |
| Shipped defaults for every tunable, table, message, path, env-var name, limit and timeout | implemented | D17 |
| Built-in `git` check with exact parity to git-guard | implemented | D29-D31 |
| Built-in `merge-side-pick` check (advisory on a push after a one-sided conflict resolution; its PostToolUse pass records into `~/.anti-hall/merge-side-pick-<session>.json`, the Node file) with exact parity | implemented | D29-D31, D75 |
| Built-in `compact-declaration-guard` check: allows new work unless the turn may hold a declaration (the common case, read from the transcript tail); a possible declaration, and so every block, defers to Node | implemented | D29-D31, D75 |
| Built-in `coordinator-work-guard` check: PreToolUse answers every call the payload proves is not the main thread and defers the rest (the block needs the command classifier, planned, D75); PostToolUse keeps the work window in the Node files (nudge, metrics, trips log, stale-file fold) whenever the call's classification is already stored by the Node PreToolUse pass or provably not work, and defers otherwise | implemented in part | D29-D31, D75 |
| Built-in `git-audit` check: the PostToolUse `--audit` pass of git-guard (recent commits with a self-credit trailer after a commit-creating command) with exact parity | implemented | D29-D31, D75 |
| Built-in `failure-root-cause-nudge` check: the PostToolUseFailure advisory with its noise filter (expected exit-1 predicates, harness refusals, once per turn through the Node turn-gate file) with exact parity | implemented | D29-D31, D75 |
| Built-in `scan-throttle` check (advisory throttle prefix for user-configured heavy scans) with exact parity; patterns it cannot match exactly defer | implemented | D29-D31, D75 |
| Built-in `ship-it-guard` check (opt-in plan gate for Edit, Write and MultiEdit; Bash and apply_patch defer to Node) with exact parity | implemented | D29-D31, D75 |
| Built-in `limit-conserve-inject`, `auto-handover`, `auto-handover-pause-nag` and `compact-advice-guard` checks: the quiet case of each hook, exact (stdout bytes, exit code and no state written); every fire, nag, re-arm, active conservation and possible compact recommendation defers to Node | implemented | D29-D31, D74, D75 |
| Built-in `output-verify-guard` check (advisory when a test run shows both a passing and a failing signal, once per turn): exact parity, 118 payload steps against the Node hook; a call Jev would be asked about, and an object output whose key order could change the answer, defer | implemented | D29-D31, D74, D75 |
| Built-in `claim-ledger` check (Stop, ledger only): the ledger and last-message files byte for byte, 91 steps against Node; a flagged turn Jev would be asked about defers | implemented | D29-D31, D74, D75 |
| Built-in `speculation-guard` check (Stop block on an unverified hedge, once per text, three per session): exact parity, 138 steps against Node, state file included; Jev on, the Stop after a block and `guards.inferenceCheck` on defer | implemented | D29-D31, D74, D75 |
| Built-in `speculation-judge` check: the off path of the opt-in model judge (switch off, judge child, skip) is answered; every opted-in call defers to Node, which makes the model call | implemented in part | D29-D31, D74, D75 |
| Built-in `ask-guard` check (PreToolUse on AskUserQuestion: the off, advise and block modes, the DESTRUCTIVE and CREDENTIAL markers and their log, the in-flight agents note) with exact parity; a transcript only JavaScript can read defers | implemented | D29-D31, D75 |
| Built-in `stale-agent-stop-note` check (PreToolUse on TaskStop: the advisory for an agent sent a message or resumed after its last report) with exact parity | implemented | D29-D31, D75 |
| Built-in `sibling-sweep` check (Stop, SubagentStop; `guards.siblingSweep`): engine-only, no Node twin (the table's fallback command is `hooks/sibling-sweep`, a shell no-op, so with the engine down nothing runs). Reminds once per cause per turn, capped per scope, when a reply states a bug's cause in a fix context and the turn shows no search for other occurrences of the pattern; the reminder travels as the one-shot Stop continuation JSON. Every phrase, message, limit and the follow-through window is a `sibling_sweep.*` setting read from the config files at call time, so tuning is a file edit and not a rebuild. Counts reminders and follow-through in `~/.anti-hall/logs/sibling-sweep.ndjson`. | implemented | D17, D74, D87 |
| Built-in `silent-agent-nudge` check (Stop): answers every Stop that does not nudge, including the rewrite of the nudge state file; a Stop that would nudge defers to Node, which words it and checks the running build | implemented in part | D29-D31, D75 |
| Built-in `merge-gate` check (opt-in false-done backstop): allows every Bash call Node allows with no output (gate off, not an auto-merge command, no hedge phrase in the recent assistant text); a hedge phrase defers to Node, which owns the block and the Jev shadow ask | implemented | D29-D31, D74, D75 |
| Built-in `api-guard` check: allows every call that reaches no interpreter probe (guard off, not Python or JavaScript, no verifiable module or global named, no code file named in a shell command or patch); everything else defers, so the probes stay with Node | implemented | D29-D31, D62, D74, D75 |
| Built-in `edit-guard` check: the launcher-directory block (every agent) byte for byte, and every call that is not the main thread; every main-thread call and every `apply_patch` defers to Node, which owns the allowlists, honesty checks and DevSwarm wording | implemented | D29-D31, D74, D75 |
| Built-in `task-lifecycle-log` check (TaskCreated and TaskCompleted: the per-session history ledger line and its index entry) with exact parity of exit code, output and the files written; a relative `cwd`, a field cut through a surrogate pair and a number JavaScript prints differently defer to Node | implemented | D29-D31, D74, D75 |
| Built-in `dispatch-tier` check (PostToolUse on TaskCreate and TaskUpdate): asks Jev (`dispatchTier`, detached, advisory) once per task text, with the shared answer cache and the request marker in `dispatch-tier-state.json` as Node keeps them (DECISIONS 1.93); does nothing while the integration is off, and defers only input it cannot read exactly | implemented | D29-D31, D74, D75 |
| Built-in `task-guard` check (Stop): the Stops where no task is open (loop state removed, pruning advisory and unknown-state note printed exactly); every Stop with an open task, and every transcript record it cannot read exactly, defers to Node | implemented | D29-D31, D74, D75 |
| Built-in `tasklist-guard` check (Stop): the Stops on which Node does not block, with its file effects (progress directory, progress and history indexes, the resume-verification marker and nudge, the plan-mode advisory); every Stop that would block defers to Node | implemented | D29-D31, D74, D75 |
| Built-in `devswarm-child-role` check (SessionStart): a child workspace's mesh-only messaging and mailbox-wake directive, byte for byte, when the stable launchers are current; a Primary, a missing launcher and the rest defer to Node | implemented in part | D29-D31, D45, D74 |
| Built-in `devswarm-parent-gate` check (Stop): the silent exits of the Node gate that happen before it reads any mailbox; every session that could be blocked defers to Node, so the gate is never weaker | implemented in part | D29-D31, D45, D74 |
| Built-in `command` check: command-guard's always-allowed commands and every command of a payload-proven subagent, exact; every other command defers to Node | implemented | D29-D31 |
| `command` check blocks (needs the hook's environment and a stdout-carrying block verdict) | planned (D57) | D57 |
| Built-in `verify-first-subagent` and `verify-first-full` checks: the verify-first protocol text (compact or full, Claude or Codex) injected at SubagentStart and SessionStart, byte for byte; a plugin root that cannot be proven defers | implemented | D29-D31, D74 |
| Built-in `fable-availability` check: reads the host's model cache, writes `~/.anti-hall/fable-availability.json` and prints the availability note when a Fable model is entitled; a config file the engine's JSON reader rejects defers | implemented | D29-D31, D74 |
| Built-in `inbox-read-guard`, `phase-tracker`, `orch-on-spawn`, `verify-first-orch` and `verify-first-orch-codex` checks (the spawn/path context ports) with exact parity on the paths they answer; the cases that need Node's own probes defer | implemented | D29-D31, D74, D75 |
| Built-in `handover-resume` and `precompact-snapshot` checks (handover persistence) with exact parity on the corpus; unreproducible cases defer | implemented | D29-D31, D74 |
| Built-in `codex-availability`, `codex-quota-detect` and `codex-nudge` checks (Codex availability and quota) with exact parity on the corpus; unreproducible cases defer | implemented | D29-D31, D74 |
| Built-in `model-routing` check for Agent/Task spawns: blocks execution-shaped flagship or inherited generic spawns and advises on routing mismatches | implemented | D29-D31, D75 |
| Built-in `verify-first`, `idle-agent-sweep` and `emit-dedupe-reset` checks (prompt emission, advisory only) over the shared emit-dedupe state file, with exact parity including the state files; a DevSwarm Primary session and anything JavaScript might read differently defer to Node | implemented | D29-D31, D74, D75 |
| Built-in `version-alert`, `devswarm-version`, `claude-cli-version` checks (SessionStart drift and update advisories from a cached probe): output and state file identical to Node on a fresh cache; a stale or absent cache defers because Node starts the detached refresh | implemented | D29-D31, D74, D75 |
| Built-in `repo-self-drift` check (KB hook and skill counts against disk, model-KB audit age): the scan, its cache and the once-per-finding advisories identical to Node | implemented | D29-D31, D74, D75 |
| Built-in `defect-nudge` check (once-a-day count of unfinished defect reports or of rulings on this project's reports; counts and ages only): identical to Node; a payload without a working directory or a date the time zone can change defers | implemented | D29-D31, D74, D75 |
| Built-in `progress-prune` check (archive stale per-session progress files into the history ledger before removing them; weekly gitignore reminder using the client's git): identical to Node; an unusual `.git` file or a slow git defers | implemented | D29-D31, D59, D74, D75 |
| Built-in `swarm-guard` check (Agent and Task spawns): memory-pressure and spawn-rate blocks with exact parity, the spawn log, trip log and lock file shared with the Node hook; a spawn that might get the shared-tree advisory defers before it is recorded | implemented, advisory deferred | D29-D31, D75 |
| Built-in `devswarm-comms-guard` check (SendMessage to a DevSwarm workspace peer) with exact parity; a relative session directory defers | implemented | D29-D31, D75 |
| Built-in `jev-weekly-scorecard`, `jev-review-reminder` and `repair-on-reload` checks: silent when provably nothing would be printed or written, otherwise the Node hook runs (report, review log, migrations and the detached repair stay in Node, D60); no state file is written by the engine | implemented in part | D29-D31, D60, D75 |
| Built-in `devswarm-child-gate`, `devswarm-parent-reply-tracker` and `devswarm-child-drain` checks: answer what the Node hook decides before it reads anything but the environment, the settings files and the payload (switch off, skip recorded, not a DevSwarm child, a Bash call that is not a `devswarm send`); a child workspace, and a plausible send, defer to Node, which owns the mailbox store reads, the stop budgets, the hivecontrol probe and the reply-state writes (needs the mailbox in the engine, D45) | implemented in part | D29-D31, D45, D74 |
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
| Read-only reader of the per-repo DevSwarm stores Node writes (`ah-engine mesh`, `src/mesh.rs`): roster, per-workspace counts, messages, gates, cursors, reader cursors; byte-equal to Node's reader on every live store copy (parity P1). Stage 2 (`src/meshw/`, switch `mesh.engine_writes`, default off): `send`, `mesh read`, `mesh history`, `roster --ack` and `inbox ack-primary` (the successful path: the caller's own-partition cursor moves of a read receipt) with Node's store writes, locking and output, the summary projection refresh those verbs make (`summaries/<repoKey>.json`), a shadow mode that replays each store-writing verb on a store copy and logs the comparison, and deferral to Node for anything not reproduced exactly (decided before any write; after its own write the engine never reruns the verb in Node, it exits 70 instead). Turn it off with `{"mesh":{"engine_writes":"off"}}` in `~/.anti-hall/settings.json`. Still Node: `inbox read-primary`, `heartbeat`, `inbox tick`, plain `roster`, and ingest (their shared unread count, the loss-free NDJSON-plus-store union, is not ported yet), and the sibling and NDJSON-inbox cursor moves of `ack-primary` | implemented in part | D45 |
| Jev lane: Vercel and TypeSafe transports with fallback and breaker, Noul and Choice calls, off/shadow/on modes, add-block and advisory trust, cache, async queue with budgets, the `jev-assist.ndjson` rows, `ah-engine jev` | implemented, one-shot only | D34-D38 |
| Jev wired into the dispatcher and the daemon, spend budget watch, audit snippets, daily rollups, persisted breaker and cache | planned (D58, D38) | D38, D58 |
| Operator helpers: `ah-engine jev-setup` (status, enable, disable, set-key, bind-generic-key, mode), `capability-scan`, `harvest`, `briefing`, byte-for-byte with the Node scripts | implemented | D81 |
| Backups and restore: online snapshot of both databases, scrubbed; restore keeps the current state first | implemented | D27 |
| Health check and repair: `ah-engine doctor` (platform and versions, hook scripts on disk, live self-tests of the built-in guards, statusline, Workflow templates, the repair pass) and `ah-engine migrate` (the persisted-state migrations and sweeps) | implemented for the plain-file steps; the DevSwarm-store steps and the spawn-based checks stay with the Node doctor | D81 |
| The DevSwarm store migrations, the statusline render, context footprint, supervisor, OMC and Codex detection, ingest units and the opt-in doctor flags in the engine doctor | planned (D81) | D81 |
| Issue log and opt-in upload | planned (D28) | D28 |
| Update checks as a scheduled job | planned (D44) | D44 |
| One dispatcher call per hook event: `ah-engine hook --event`, built-in checks in the engine, the other hooks as Node, combined in table order; the plugin's `hooks.json` is one thin trigger per event, generated from the table (`ah-engine gen-hooks`) | implemented on the `engine-proto` branch (the installed plugin changes when it merges) | D58, D75, D87 |
| Per-event and per-entry hook configuration (`[events.<Event>]`, `[entries.<id>]`: mode, max_rules, budget_ms, order) and the `when` predicate | implemented | D87 |
| Porting the other guards | planned (D57) | D57 |
| Prebuilt binaries for every Unix target, release automation (prepare, publish, sha256 and attestation), the plugin-side bootstrap with a pinned lock | implemented (see Install, go-live and rollback) | D56, D64, D67, D68 |

## Install, go-live and rollback

**Install.** The plugin ships `ah-engine.lock` (schema, engine version, tag and the sha256 of every release asset). On every
SessionStart, `hooks/ah-hook.sh` starts `hooks/ah-engine-bootstrap.sh` detached. The script (POSIX sh, never fails a session):

1. detects the target (macOS arm64 or x86_64, Linux x86_64 or arm64 on glibc or musl, WSL as Linux; anything else, such as
   native Windows, is reported as unsupported and skipped);
2. downloads `ah-engine-vX.Y.Z-<triple>.tar.gz` from the GitHub Release over HTTPS;
3. installs it to `~/.anti-hall/ah-engine/bin/ah-engine` **only if its sha256 equals the lock's entry**. There is no trust on
   first use: a mismatch is refused and nothing is installed;
4. does it atomically and keeps the previous binary as `bin/ah-engine.prev`.

It is idempotent (the same lock does nothing), rate limited (a failed attempt for a lock is retried after 6 hours), and it never
overwrites a binary it did not install (a local build is left alone). Every outcome is written to
`~/.anti-hall/ah-engine/bootstrap.log`. A plugin tree without `ah-engine.lock` installs nothing and stays on Node. Opt out with
the setting `engine.bootstrap` = false (`/config`, `/anti-hall:settings`; stored in `~/.anti-hall/settings.json`) or the environment variable `AH_ENGINE_BOOTSTRAP=0`, which overrides the setting (see also [RELEASING.md](../ah-engine/RELEASING.md)). This download is the only network request the engine's install makes; see [PRIVACY.md](../PRIVACY.md).

**Go-live.** An engine check is trusted only after it has agreed with the Node hook it replaces. Before release the whole
dispatcher was replayed against Node (see [Measured results](#measured-results-pre-release)); per entry the engine can also run
beside Node on live traffic: `mode = "shadow"` on a guard entry that has a built-in check runs the check next to the Node hook,
which still decides, and logs `dispatch_shadow` with whether the two agree ([Dispatcher](#dispatcher), configuration of events and
entries). A check that cannot reproduce Node exactly defers (exit 75 from the engine, the wrapper then runs the Node hooks).

**Rollback.** In order of how much you want to undo:

| To undo | Do |
|---|---|
| one check | set `mode = "off"` on its `[entries."<id>"]` in the engine's `config.toml`: only the engine's check is skipped, its Node hook decides (hot reload, no restart) |
| the engine, for now | `ah-engine stop`, then remove `~/.anti-hall/ah-engine/bin/ah-engine`; the wrapper finds no binary and runs the Node hooks |
| the engine, for good | also set `engine.bootstrap` = false or the opt-out variable (see Install above), or the next SessionStart reinstalls the pinned binary |
| a bad engine build | copy `bin/ah-engine.prev` back over `bin/ah-engine` |
| a bad plugin edit of the engine files | nothing to do: the layered failover below falls back by itself |

Whatever the engine cannot do, the Node hooks do; Node is the permanent floor.

## What still runs on Node

The engine does not replace Node yet; it answers what it can prove identical and leaves the rest. Honest list of what stays
on Node today (each is a deferral, so Node's answer is the one the host sees):

| Stays on Node | Why |
|---|---|
| DevSwarm mesh writes (mailbox, roster, cursors, archive) and the DevSwarm daemons (ingest, liveness supervisor, reaper) | the engine only reads the per-repo store in place (`ah-engine mesh`, read-only); engine-owned mesh writes are planned (D45) |
| Every call that would consult Jev (the Jev integrations: speculation, claim ledger, output verify, git self-credit, model routing, tasklist, codex nudge, merge-gate hedge, parent-gate question, and the rest of the `jevIntegrations` table) | the engine has the Jev lane as a library and `ah-engine jev`, but the dispatcher does not call it yet (planned, D58, D38); with Jev off the engine answers, with Jev on Node keeps its exact behavior |
| The semantic judge (`speculation-judge`'s model call to Haiku, directly or through your `claude` CLI) | a model call with its own backends; the engine answers only the judge-off path |
| The statusline | a separate Node process the host runs for the status bar; not a hook |
| The blocking branch of several guards | `edit-guard` on the main thread, `api-guard`'s interpreter probes, `merge-gate`'s hedge, `task-guard` and `tasklist-guard` Stops that would block, `silent-agent-nudge`, `devswarm-parent-gate`, and the command check's non-trivial verbs: the engine answers the quiet cases and defers any case that could block |
| SessionStart context over the 10,000 character host cap, and cases with a stale cache or a date, JSON or regex construct the engine cannot read exactly like JavaScript | the whole hook defers before anything is written, so Node sees the state it would have seen |
| `task-tracker`, the doctor's DevSwarm migrations, the statusline render, supervisor and OMC/Codex detection | see "What works today" for the planned items (D81) |

Platforms: macOS and Linux (including WSL). Windows is not supported yet, and neither the bootstrap nor the engine runs there.

## Measured results (pre-release)

These are pre-release measurements from one replay, not a guarantee and not a field result. Setup: a frozen sample of 2113 real
hook payloads, replayed once through the exact go-live bundle (engine binary plus plugin tree) and once through the Node hooks of
the same plugin tree, each side in its own pristine sandbox and isolated home, concurrently, paced at 0.15 s per payload.

| Measure | Result |
|---|---|
| Blocks Node made that the engine did not (ENGINE-WEAKER) | 0 of 68 (the engine blocked all 68) |
| Output identical to Node | 2059 of 2113 payloads |
| Differences | 30 text-only, 7 advisory dropped by the injection gate on purpose, 2 stricter, 15 SessionStart deferrals (over the context cap, so Node runs in production) |
| Hook rows answered natively by the engine | 87.0 percent (8748 of 10051); 54.1 percent of calls needed no Node fallback at all |
| CPU per call, engine (client plus daemon) | about 35.5 ms (client 28.2 ms including the Node hooks it launched, daemon 7.4 ms) |
| CPU per call, the Node hooks alone | 158.2 ms |

Known gap found by the same replay and not yet fixed: when two hooks block and one of them was deferred to Node, the engine's
output can keep only one block reason (5 payloads), and `task-guard`'s informational "deferring Stop block" notice is not printed
(6 payloads). The decision (block) is the same in every one of them. The figures depend on the sample, the machine and the load; the
full report and the per-event table are kept with the release notes of the engine.

## Commands

Every command accepts `--json` and prints one JSON object. Read-only commands never change state. The full table, with
arguments, is in the generated reference.

| Command | Read-only | What it does |
|---|---|---|
| `ah-engine hook` | no | The hook client: payload on stdin, answer on stdout. With `--event` it is the per-event dispatcher (see Dispatcher). |
| `ah-engine serve` | no | Run the daemon in the foreground. |
| `ah-engine status` | yes | State, uptime, memory, counters, breaker, rules and a headline summary. |
| `ah-engine metrics` | yes | Metric series; `--check <name>` narrows to one check; `--rollup minute\|hour [--since <s>]` shows stored rollups. |
| `ah-engine impact` | yes | What the engine affected; `--kind`, `--project` filter, `--window <7d>` for the NET section. |
| `ah-engine telemetry` | no | `summary`, `events`, `rollup`: see Telemetry below. `ah-engine telemetry summary [--window 7d]` is the one to run first: per hook and check, invocations, outcomes, latency and injected bytes. `summary` and `events` only read; `rollup` writes, idempotently. |
| `ah-engine docs` | yes | The generated reference (`--format md`, or `--json`). |
| `ah-engine gen-hooks --host claude\|codex [--kind hooks\|registry\|list\|map]` | yes | Print a file generated from the dispatch table: the thin `hooks.json` (one trigger per event), the per-hook registry, the wrapper's fallback list or its fallback map (D87). |
| `ah-engine check <name>` | yes | Run one check on a payload from stdin (parity harness). |
| `ah-engine version` | yes | The version this build reports. |
| `ah-engine ctl <verb>` | no | `ping`, `reload` (also re-reads the config files), `stop`, `status`, `config`. |
| `ah-engine stop` | no | Drain and exit. |
| `ah-engine reset` | no | Clear the breaker, crash-loop stop and failure record. |
| `ah-engine maintain` | no | Size control: move inactive rows to `archive.db`, prune derived bookkeeping, checkpoint and VACUUM; prints a report. |
| `ah-engine proj <cwd> <verb>` | no | Per-project state in `hot.db`: mailbox `put`, `take`, `len`; key-value `set`, `setex` (TTL in seconds), `get`. A write the engine cannot take is spooled. |
| `ah-engine jev <ask\|status\|scrub>` | no | The optional Jev lane: `ask` reads JSON requests (one per stdin line) and prints each decision, `status` prints the resolved settings and every integration's mode (never a key), `scrub` redacts secrets from JSON strings. |
| `ah-engine doctor [--check] [--repair\|--fix] [--dry-run] [--migrations-only] [--quiet]` | no | The health check and repair, in the Node doctor's layout and finding texts. Read-only unless `--repair`; `--dry-run` previews; `--migrations-only` with either prints only the migration report as one JSON line. Each built-in guard is run in-process on a crafted payload (a payload the engine defers is run through its Node hook, as the dispatcher would; with no Node it is reported as a deferral, never a pass). |
| `ah-engine migrate [--dry-run] [--home <dir>] [--cwd <dir>] [--plugin-root <dir>]` | no | The persisted-state migrations and sweeps of the Node doctor's repair pass, with Node's report: legacy progress/history copy, reply-state, gate-intent and auto-archive forward migrations, the `settings.json` migration, the Jev triage cache repair, the lock scratch sweep and the retention sweeps. Idempotent, fail-open, no repo file is moved or deleted. |
| `ah-engine jev-setup <status\|enable\|disable\|set-key\|bind-generic-key\|mode>` | no | The port of `scripts/jev-setup.js` (D81): `status` prints the resolved settings, key presence yes or no, every integration's mode, the calls of the last 24 hours and the Vercel credit balance; `enable`, `disable`, `bind-generic-key` and `mode <integration> on\|shadow\|off` write `settings.json` and `jev.json` the way the script does (read-modify-write, key order kept, a corrupt file moved aside); `set-key` reads the key from stdin only and writes the key file with mode 0600. `test` and the review verbs stay in the Node script. |
| `ah-engine capability-scan [--root <plugin dir>]` | yes | The port of `scripts/capability-scan.js` (D81): which opt-in capabilities of a plugin tree are shipped and active on this machine, and how to enable the ones that are not; prints the JSON report, then one line per capability. |
| `ah-engine harvest [--dir <path>] [--stale-days <n>]` | yes | The port of `scripts/harvest-debt.js` (D81): the `anti-hall: <ceiling>, <when>` debt markers of a code tree, flagged when they have no payback trigger or sit in files git says are old. |
| `ah-engine briefing [--root <plugin dir>]` | yes | The port of `scripts/briefing.js` (D81): a derived inventory of a plugin tree, the registered hooks by event with the purpose from each hook's header comment, the skills, the DevSwarm substrate and the docs map. |
| `ah-engine backup [--to <dir>]` | no | A consistent, scrubbed snapshot of `hot.db` and `archive.db`; prints its manifest. |
| `ah-engine restore <snapshot-dir>` | no | Keep the current state as a pre-restore snapshot, stop the daemon, swap in the snapshot. |
| `ah-engine config [--json]` | yes | The effective config with the source of every value (`default`, `config_toml`, `settings`, `env`), the files read, the active version, any rejected edit and settings pending a restart. Asks the running daemon, else reads the files. |
| `ah-engine config validate <file>` | yes | Check an engine TOML file against the schema: exit 0 when valid, 1 with the reason when not. |
| `ah-engine config heal` | no | Add the settings the edited engine files lack, taken from the pristine copy (existing text kept, the file backed up first, idempotent). The automatic heal skips a version-controlled checkout; this command does not. |
| `ah-engine config versions`, `config rollback`, `config export` | no | planned (D18, they need the config database); they say so and exit 64. |
| `ah-engine schedule list\|run <job>\|history` | no | The scheduler's jobs with their next run and last result; run one now; the run history. |
| `ah-engine mesh <roster\|unread\|read\|dump> --db <devswarm.db> [--id <ws>] [--since <n>] [--last <n>]` | yes | Read a repo's DevSwarm store in place, read-only (D45 stage S0): the registered workspaces, the per-workspace counts, a workspace's messages (capped, with a resume position), and the full canonical dump the parity harness compares with Node's reader. Refuses a journal-backed store; never creates or writes one. |
| `ah-engine mesh <devswarm.js argv>` | no | D45 stage 2: the same argv as `node scripts/devswarm.js`. `mesh.engine_writes` off (default): Node runs it. shadow: Node runs it, the engine replays it on a copy of the store and logs the comparison to `mesh-shadow.jsonl` in the state directory. on: the engine answers `send`, `mesh read`, `mesh history`, `roster --ack` and `inbox ack-primary` itself (store write, lock and summary refresh) where it reproduces Node exactly and hands the rest to Node before writing anything; a failure after its own write exits 70 without rerunning Node (exit-code contract and per-verb telemetry: see Mesh verbs below). Off again: `{"mesh":{"engine_writes":"off"}}` in `~/.anti-hall/settings.json`. |

## Metrics and the impact ledger

**Metrics** are counters, gauges and latency histograms kept in memory and bounded. Latency percentiles are reported as
the upper bound of the histogram bucket that holds that rank, so they are upper estimates. The registered names are:
`requests`, `busy_replies`, `errors`, `budget_trips`, `panics`, `rejected_peers`, `hook_calls`, `hook_latency_us`, `dispatch_checks`,
`check_calls`, `check_decisions`, `check_latency_us`, `rule_hits`, `rss_kb`, `queue_depth`, `uptime_s`, and for the
memory layer `tier_items`, `tier_bytes`, `tier_hits`, `tier_misses`, `tier_evictions`, `tier_expired`, `bus_published`
and `bus_dropped`, for the writer `db_commits` and `db_writes` (fewer commits than writes means group commit is sharing syncs), and for
the spool `spool_applied` and `spool_quarantined`, for the scheduler `schedule_runs` and `schedule_missed`, and for
size control `db_hot_bytes`, `db_hot_wal_bytes`,
`db_archive_bytes`, `db_archive_wal_bytes`, `maintain_runs` and `maintain_last_ms`, and for the Jev lane `jev_calls`, `jev_verdicts`, `jev_cost_micro_usd`, `jev_timeouts`, `jev_cooldowns`, `jev_changed` and `jev_latency_us`, and for the injection gate `inject_emitted`, `inject_emitted_bytes`, `inject_keepalive`, `inject_suppressed`, `inject_suppressed_bytes` (by cut) and the memory gauges `inject_gate_sessions`, `inject_gate_slots`, `inject_gate_bytes` and `inject_gate_evictions`.

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

## Mesh verbs: the exit-code contract and per-verb telemetry (D45 stage 2)

**Exit codes of `ah-engine mesh <devswarm.js argv>`** (`mesh_write.exit_defer`, `mesh_write.exit_committed_failure`):

| Code | Meaning | Caller does |
|---|---|---|
| the verb's own | the engine answered (or Node did, after a deferral); the code is the verb's result | passes it through |
| 75 | DEFERRED, NOTHING WRITTEN, and the engine could not start Node itself (no Node CLI, `node` not found) | runs the verb in Node; the stable launcher does, and logs the fallback in `mesh-route.log` |
| 70 | the engine WROTE and then failed (a panic, or a late deferral that is a bug) | reports it; never runs Node: running the verb again would write twice |

A deferral is always decided before the first store write, and `ah-engine mesh` runs a deferred verb in Node itself, so 75 is rare. 75 is never
returned after a write: that is 70, a different code on purpose, because 75 is the one code a caller may answer by running Node. The decision is
one pure function (`meshw::next_step`) unit-tested for every combination; `tests/mesh_ack_parity.rs` proves, for every deferral case of
`inbox ack-primary`, that an engine that cannot run Node exits 75, prints nothing, and leaves the store and the home tree byte-identical.

**Telemetry per verb.** Each `on`-mode call appends one JSON line to `mesh-shadow.jsonl` in the state directory:
`{"ts", "verb", "mode", "result", "reason", "ms"}`, with `verb` one of `Send`, `MeshRead`, `MeshHistory`, `InboxAckPrimary` and `result`:

| `result` | counts as | `reason` |
|---|---|---|
| `native` | a call the engine answered | empty |
| `defer` | a deferral (Node ran it) | the deferral case, e.g. `receipt-reader`, `cursor-import`, `not-owner`, `lock-busy` |
| `panic` | an engine error before any write (Node ran it) | empty |
| `committed-failure` | an error after the first write (exit 70) | the late deferral, or empty for a panic |

`ms` is the engine's own time for the attempt (it excludes Node's run after a deferral). Per verb: calls = lines, defers = `defer` lines, errors =
`panic` plus `committed-failure` lines, latency = `ms`. For example
`jq -s 'group_by(.verb)[] | {verb: .[0].verb, calls: length, defers: map(select(.result=="defer"))|length, errors: map(select(.result=="panic" or .result=="committed-failure"))|length, p50_ms: (map(.ms)|sort|.[length/2|floor])}' mesh-shadow.jsonl`.
Group `defer` lines by `reason` to see which unported case to port next. In `shadow` mode a verb that can be replayed on a store copy logs
`match`/`mismatch`/`concurrent`/`defer`; `inbox ack-primary` cannot (it consumes a receipt file outside the store), so Node runs it and the line
says `skipped`.

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
a bounded in-memory ring for rich events: no I/O and no shared lock. Measured by `tests/it/telemetry.rs` (release build): the
`record()` median is under 1 microsecond (the test asserts it, alone and with four threads hammering the same labels).

**Persistence and the loss window.** The recorder flushes to `hot.db` every `telemetry.flush_ms` (default 10 s) and at a
clean shutdown, through the Store's writer. A `kill -9` (or power loss) loses exactly what was recorded after the last
flush: at most `telemetry.flush_ms` of data. Everything flushed survives (`tests/it/telemetry.rs` kills a daemon and reads the
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
  `tests/it/durability.rs` kills the daemon with SIGKILL in the middle of a burst of writes from four threads, fifty times
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
`tests/it/transcript_parity.rs` and, over real transcripts, by `parity/run-transcript.js`.

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
error and is never remembered; an exit status other than 0 is remembered as "git said no". `tests/it/gitcache_parity.rs`
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
  use, a full queue answered with the baseline). Answers are cached by content hash, bounded to 500 entries, in the same
  file the Node hooks use (`~/.anti-hall/cache/jev-assist.json`, Node's shape and its read-merge-rename protocol, DECISIONS 1.93),
  so a text asked by either side is asked once. An entry the engine writes also names the vendor chain (vendors, models,
  endpoints), so one session's answer is never served to a session that would have asked someone else, and an answer from a
  test endpoint override is never cached.
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
  the daemon opens no network connection (only the opt-in `ah-engine jev ask` and `jev-setup status` commands do, and only when Jev is on); payload text is never executed; state is partitioned per project.
- **No deletion.** The engine deletes nothing outside its own state directory.

## Configuration and data files

**Tune in the plugin files; the engine only runs them.** Every setting, table, message text, dispatch row and rule ships with
the plugin in `plugins/anti-hall/engine/` (`defaults/*.toml`, listed by `defaults/index.toml`, and `rules.json`), is updated
with the plugin, and is read by the engine AT RUN TIME. Nothing of it is compiled into the binary (a test scans the binary for
the shipped texts), so tuning a hook, a rule or a message is an edit of a plugin file and never a rebuild.

How it is loaded:

| When | What happens |
|---|---|
| start-up | the daemon finds the plugin root (below), reads and validates every file (a malformed, undocumented or duplicated entry, a bad hook row, or a setting this engine version reads that the plugin lacks, is rejected with a reason code), and writes one small validated **snapshot cache** (`defaults.cache`) into the state directory |
| a defaults file changes | the daemon polls the files (`config.watch_ms`, settled for `config.debounce_ms`), validates the whole set, and swaps in the new snapshot atomically: no restart, in-flight requests finish on the old one. An invalid edit keeps the last good snapshot and logs `defaults_invalid` with the reason code (`parse`, `doc`, `missing_key`, ...); `status` shows it as `config.last_error` |
| the plugin is updated | a new directory at the same path shows as a changed file set; a new path arrives with the next request (`AH_ENGINE_PLUGIN_ROOT`, set by the wrapper from its own location, or the host's plugin-root variable) and is adopted when its index is newer than the active one, so two plugin versions in use at once cannot flip the daemon |
| the thin hook client | reads the snapshot cache (one file, only the keys a call asks for) instead of parsing 28 files; it parses the plugin files itself only when the cache is missing or belongs to another plugin root |
| an edited file is invalid | that file (or that setting) falls back to the last-known-good copy, then to the pristine copy ([Layered failover and self-heal](#layered-failover-and-self-heal)) |
| nothing loadable | no plugin root, or the edited, last-known-good and pristine copies all fail: the engine answers "unavailable" (exit code 75, which the wrapper turns into the Node hooks), logs why (`defaults.error` in the state directory and stderr) and never falls back to values compiled into the binary, because there are none |

The plugin root is the first of: `AH_ENGINE_PLUGIN_ROOT` (an explicit choice: if it has no `engine/defaults/index.toml` the load
fails), `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, the root recorded in the snapshot cache, a development checkout found by walking up
from the executable. The rules file is the `AH_ENGINE_RULES` override, else `rules.json` in the state directory when the user put
one there, else the plugin's `engine/rules.json`. The few fixed names this needs are in `src/bootstrap.rs`.

Files:

| File | Holds |
|---|---|
| `index.toml` | not settings: the list of the defaults files, in order, and the sub-directory (`hooks.d`) of further files |
| `limits.toml` | limits, buffer sizes, phrases and short texts that were literals in the source (the late additions of the no-compiled-config sweep) |
| `engine.toml` | environment variable names, paths and file names, daemon and client limits, project store caps, health policy, hook adapter, socket protocol |
| `messages.toml` | every message the engine produces (failure hints, advisories, replies, errors, command-line text) |
| `git.toml` | every table, limit, setting name and block message of the git check |
| `task_guards.toml` | switches, limits, file layout and messages of the task checks and their shared helpers |
| `devswarm_role.toml` | names, switches and message templates of the `devswarm-child-role` and `devswarm-parent-gate` checks |
| `small_guards.toml` | patterns, switches, limits and messages of the small Bash guard ports and their shared helpers |
| `verify_first.toml` | the verify-first protocol texts (copied byte for byte from `hooks/verify-first-core.js`), the switches and message of the verify-first and fable-availability checks |
| `mcp_reaper.toml` | the session-end MCP sweep: its patterns, init names, age floor, cap, grace period, commands and audit log texts |
| `task_tracker.toml` | the task-tracker directive and reminder texts, window and growth thresholds, the open-tasks line, the Jev label question and the demand-metrics file |
| `judge.toml` | the judge calls the engine makes itself: the local Claude CLI client, the speculation-judge prompts and evidence limits, the mesh-triage worker's prompts and budgets, and the Jev-first cascade (thresholds, prompts, telemetry words) |
| `spawn_context.toml` | paths, switches, limits, messages and the orchestration text of the spawn/path context ports |
| `inject_gate.toml` | the injection gate: its settings (`context.injectGate*`), what it recognises in the hooks' output, its state bounds and wire words |
| `ctxbudget.toml` | settings tables, state paths, limits and messages of the context-budget gates (`limit-conserve-inject`, `auto-handover`, `auto-handover-pause-nag`, `compact-advice-guard`) |
| `response_guards.toml` | patterns, switches, limits and messages of the four response-correctness ports (`speculation-guard`, `speculation-judge`, `claim-ledger`, `output-verify-guard`) and their shared helpers |
| `sibling_sweep.toml` | phrases, hedge and tool lists, messages, limits and the follow-through window of the sibling-sweep check; all read at call time through the config layers, so editing a settings file changes the next call |
| `script.toml` | scripted check logic (D88 spike): the on/off switch, where check scripts and the owner override live, and the per-call time, heap and stack limits of the embedded QuickJS-NG runtime |
| `agent_controls.toml` | patterns, switches, limits and messages of ask-guard, silent-agent-nudge, stale-agent-stop-note and the transcript agent scan they share |
| `codex_handover.toml` | patterns, switches, limits, file names and messages of the handover and Codex hook ports and the JavaScript-behavior helpers they share |
| `devswarm_gates.toml` | switches, role and mode variables and the command pre-filter words of the DevSwarm child gate, reply tracker and drain checks |
| `mesh.toml` | the mesh store reader (D45 S0): store and marker file names, the SQLite busy timeout and page cache, the preview length, the read byte cap and the `--last` bounds; and `mesh.engine_writes` (off, shadow, on), the switch of the stage 2 mesh writers |
| `mesh_write.toml` | the mesh store writers (D45 stage 2, `ah-engine mesh <devswarm.js argv>`): Node's store names and statements' column list, the busy retry, the per-workspace lock budget and steal limits, the identity file and variable names, argv flag names, output texts, and the shadow log, scratch and snapshot settings |
| `command.toml` | every table, pattern and limit of the command check (heavy verbs and patterns, light exceptions, wrapper grammar, cloud CLI grammars, write-scan markers, the defer triggers) |
| `commands.toml` | the command registry data |
| `schedules.toml` | the scheduled jobs (maintain, backup, metrics snapshot, spool drain) and the scheduler settings |
| `telemetry.toml` | the metric and impact-kind registries, the savings method and the telemetry settings (`telemetry.enabled`, `telemetry.flush_ms`, `telemetry.retention_days`, table sizes and window defaults) |
| `storage.toml` | database file names, SQLite durability settings, the writer queue and group-commit window, the in-memory layer, the spool, retention, backups |
| `config.toml` | config layering: file names, watch and debounce timing, boolean tokens, restart-only settings, config messages |
| `transcript.toml` | the transcript index: window and update caps, kept-fact counts, status sets, registry size and idle time |
| `gitcache.toml` | the git cache: git invocations, timeouts, TTLs, signed file names, the bypass environment, messages |
| `jev.toml` | the Jev lane: vendor endpoints and models, budgets, breaker and fallback timing, the integration table with its default modes, cache and log limits, key-file rules, messages |
| `setup.toml` | the operator helper commands (`jev-setup`, `capability-scan`, `harvest`, `briefing`): the shared limits, the marker grammar and table widths, the briefing's scan limits, the settings lock timing, and the message texts, which are the Node scripts' own |
| `dispatch.toml` | the dispatcher's settings and the hand-maintained per-event table of hook entries (the table of record: the plugin's `hooks.json` files are generated from it) |
| `hooks.toml` | the hook configuration: defaults of `[events.<Event>]` and `[entries.<id>]`, the `when` predicate vocabulary, the plan outcomes and their messages |
| `hooks.d/*.toml` | optional: per-batch `[events.<Event>]` / `[entries."<id>"]` defaults (one file per batch of ported hooks, so parallel lanes do not edit a shared file) |
| `prompt_emit.toml` | switches, limits, patterns and messages of the prompt-emission checks (`verify-first`, `idle-agent-sweep`, `emit-dedupe-reset`) and the emit-dedupe store they share |
| `session.toml` | the session-maintenance checks: switches, cache and ledger file names, time limits, baselines, claim patterns and messages |
| `spawn_guards.toml` | switches, limits, paths, memory-tool grammar and messages of the swarm-guard and devswarm-comms-guard ports |
| `migrate.toml` | the layout of the state `migrate` and `doctor --repair` work on (paths, file-name patterns, retention windows, the migration registry, read limits) and the report texts, which are Node's byte for byte |
| `migrate_settings.toml` | the settings schema as the `settings.json` migration reads it, generated from `settings-schema.js` (`parity/gen-migrate-schema.js`; a test fails when the two differ) |
| `doctor.toml` | the doctor's finding texts, the table of live self-tests (check, payload, environment, expected outcome, finding texts) and the flags it does not handle yet |
| `session_gates.toml` | switches, latch files, windows and the default-migration key list of the jev-weekly-scorecard, jev-review-reminder and repair-on-reload gates |

Each setting is a table with `value`, `doc` and optionally `env` (an environment variable that overrides a numeric value for
one process), `min`, `max` and `unit`. Code reads them through one module; a test fails the build if a tunable, table or
message is written in Rust instead (`no_hardcoded_tunables`), and another if code and defaults disagree. User-level
overrides are layered on at start and on every change (below); persisting each version in storage is planned (D18).

### Layered failover and self-heal

The engine files in `plugins/anti-hall/engine/defaults/` are meant to be edited, so a bad edit must not take the guards down.
Every load, per file and per setting, tries these layers in order and each layer passes the same validation:

1. **edited**: the plugin's `engine/defaults/` (what you or an update changed);
2. **last-known-good**: `<state dir>/defaults.lkg/<stamp>/`, a copy of every edited file that last validated in full, stamped with
   the engine version, plugin root and plugin version (older stamps beyond `defaults_load.lkg_keep` are removed);
3. **pristine**: the plugin's read-only `engine/defaults.pristine/`, byte-identical to the shipped defaults;
4. **Node**: if all three fail the engine answers "unavailable" (exit 75) and the wrapper runs the Node hooks.

Each fallback is logged (`defaults_fallback` with a reason code) and marks the engine degraded; the state is shown by
`ah-engine status` and advised once per session.

**Self-heal.** A setting the edited files lack (an older file after an engine update, or a deleted table) is taken from the pristine
copy for that run and reported. The automatic heal then appends the missing table to the edited file, keeping the existing text
byte for byte, after backing the file up once beside it; the new text must parse and read back as the pristine value or nothing
is written, and a second run finds nothing to add. The automatic heal never writes into a version-controlled checkout;
`ah-engine config heal` does it on request, including there.

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

## Dispatcher

`ah-engine hook --event <Event> [--tool <Tool>] [--host claude|codex] [--fallback-map <file>]` stands in for every hook
the plugin used to register for that event (D58). Its table, `dispatch.toml` (hand-maintained since D87: it is the table of
record), lists each host's entries per event in combine order with the exact command, timeout and matcher, which built-in
check (today: `git` and the other ported guards, on PreToolUse) answers an entry, and optionally a `when` predicate. The
plugin's `hooks.json` files are generated from it (`ah-engine gen-hooks`, or `ah-gen-fallback-list --repo ..` for all of
them) and `tests/it/hooks_files.rs` fails on a byte of difference.

**One thin trigger per event (D87).** `hooks/hooks.json` has exactly one entry per event and no matcher:
`sh "${CLAUDE_PLUGIN_ROOT}/hooks/ah-hook.sh" <Event>` (Codex: `${PLUGIN_ROOT}`, plus `--host codex`), with the longest timeout
of the event's entries. It covers every event of the table and every event in `dispatch.thin_events`: all 33 Claude Code
events of the official reference except `WorktreeCreate` and `WorktreeRemove` (a WorktreeCreate hook replaces the default
worktree creation and a non-zero exit on either fails the operation, so there is no neutral pass-through; decision D87
exception), and the ten Codex events. The engine matches, filters and orders from the table and the config; an event the
table has no entry for answers the host with the neutral no-op (exit 0, no output) and the wrapper's fallback list marks it
`empty`. The per-hook registry the old `hooks.json` was (`hooks/hooks.registry.json`, `codex/hooks/hooks.registry.json`) is
generated too: nothing in the host reads it, the plugin's Node readers (doctor, briefing, hook-latency, tests) and the
manual Codex installer use it to know which hook scripts exist. A new hook is a row in the table; nothing else lists hooks.

1. The entries whose matcher selects the payload are chosen the way the host chooses them: on Claude a matcher of
   plain names is an exact name or list and anything else an unanchored regex; on Codex every matcher is a regex and
   `Edit`/`Write` also match `apply_patch`. When nothing matches, the dispatcher says nothing and starts nothing.
2. Every entry without a built-in check starts at once as its Node hook, under the shell, with the payload on stdin and
   its own timeout. A hook past its timeout is killed with its process group and counts as saying nothing.
3. The built-in checks run in the daemon (`D` request; or in the client when `dispatch.in_process` is 1). An entry whose
   check defers, and every check when the daemon cannot answer, runs as its Node hook too (D11). `--fallback-map` (a
   JSON object of event, then hook id, to command) replaces an entry's Node command.
4. The results are combined the way the host combines separate hooks. Both hosts run matching hooks in parallel and
   read each one's output on its own (the Claude Code and Codex hook docs, quoted in `dispatch.toml`):
   - the first entry that exited 2 is the answer, byte for byte; failing that, the first whose JSON blocks;
   - when exactly one entry said anything, its output, stderr and exit code pass through unchanged;
   - several JSON answers merge: `additionalContext` and `systemMessage` values are joined in order, the strongest
     `permissionDecision` wins with its reason, any other field must agree, and stderr is concatenated.

**Configuration of events and entries (D87).** Two kinds of section, in the engine's `config.toml` (state dir) or a project
file (`.anti-hall/engine.toml` under the payload's cwd, below the user file in precedence; `hooks.project_file`):

```toml
[events.PostToolUse]              # any event of either host's table or thin triggers
mode      = "on"                  # on | shadow (run and log, never change the outcome) | off (skip, answer neutral); enabled = false is off
max_rules = 3                     # entries evaluated per occurrence (0 = all); the rest are counted as skipped (max_rules)
budget_ms = 400                   # wall budget: after it no new entry starts, running ones finish within their own timeouts
order     = ["output-verify-guard"]  # these ids run and combine first; an id the event's table lacks is an error

[entries."git-guard:audit"]       # a table entry by id, or "PostToolUse/git-guard:audit" for one event only
mode = "shadow"
when = { field = "/tool_input/command", regex = '^git ' }   # replaces the row's own `when`
```

Every key has a documented default (`hooks.event_*`, `hooks.entry_*`) and the whole file is validated when it is read: a bad
key rejects the file, the daemon keeps the previous snapshot and reports the error through `last_error`, and a one-shot
client reads the layer as empty and logs `config_invalid`. **Guard events never become a silent allow:** on PreToolUse,
PermissionRequest, Stop and SubagentStop, `mode` off or shadow and `enabled = false` are errors, `max_rules` must stay 0, and a
`when` cannot be overridden on a guard entry; `mode` off or shadow on a guard ENTRY is allowed only when it has a built-in check,
because its Node hook then still runs as the real decider (off skips only the engine's check; shadow runs the check beside the Node
hook and logs `dispatch_shadow` with whether the two agree). A project file may not configure guard events or entries at all.
`budget_ms` is allowed on a guard event: a built-in check's Node hook that cannot start in time fails the event closed.

**The `when` predicate (D87).** A table row or an `[entries.*]` override may carry `when`, a declarative filter that decides
per occurrence whether the entry applies (no `when` = it applies whenever its matcher does). Leaves: `tool` (a name or a
list), `field` (a JSON pointer into the payload, so `/tool_input/file_path` reads a tool-input field), `setting` (a boolean
switch of the shipped switch tables, such as `guards.shipitGate`, resolved from the request environment, then the loaded
`settings.json`, then the default, or one of the engine's own settings), `env` (a variable of the request environment,
`request_env.allow` only), `session` (`first`, `every = N` or `at_least = N` counters kept in memory per session with a TTL)
and `transcript` (a fact of the transcript index: `records`, `compact_boundaries`, `sidechain_rows`, `meta_rows`,
`has_last_prompt`, `has_last_assistant`, `last_tool`, `terminal_agents`, `unresolved_agents`). Each leaf takes exactly one
test (`equals`, `in`, `regex`, `glob`, `exists`, `at_least`, `at_most`); `all`, `any` and `not` combine them. Evaluation is
three-valued and an unknown answer applies the entry, so a guard is never skipped because the engine could not tell: a
one-shot client keeps no session counters and has no transcript index, so those two kinds are unknown there (the daemon
side of that is wired when a real entry first uses them). Predicates are not attached to any shipped row yet.

**The plan and its telemetry.** For each occurrence the plan applies, in order: the event's mode, its `order`, each entry's
mode, its `when`, then `max_rules`. Every entry is counted under one outcome: `ran`, `skipped_predicate`, `skipped_max_rules`,
`skipped_budget`, `shadowed` or `off`. A dispatch that skipped, shadowed or turned anything off, or ran under a non-default
config, writes one `dispatch_plan` event (with the config hash); the counters are the `dispatch_entries` metric, by event,
entry and outcome, and `config --json` reports the hash of the user file's hook sections (`hooks_hash`).

**The environment (D76).** A hook runs in its host's environment, not the daemon's. The client forwards the variables on
`request_env.allow` (`defaults/engine.toml`) with each `V` and `D` request, and every check runs against that
environment, never the daemon's own; a request without one gets an empty environment. The reply frame magic carries the
protocol version (`AHR2`), so a client and a daemon of different protocols fall back to Node.

**Exact output.** A check can answer with exact exit code, stdout and stderr bytes (`Verdict::Exact`), for guards whose
output is not the plain exit-2 block, for example the JSON block `io.blockDecision` produces.

**What one process cannot say.** The host shows each hook's `additionalContext` as its own reminder, with its own size
cap (10,000 characters on Claude, about 2,500 tokens on Codex); the dispatcher joins them into one value, which the
host caps as a whole. A join of several hooks' contexts over the cap is therefore not delivered as separate values: the
dispatcher logs `dispatch_context_over_cap`. On an event that cannot block it also prints a message on stderr and exits
`dispatch.defer_exit` (75), asking its wrapper to run the Node hooks one by one as the host does (the host shows that
non-blocking error, so it is never silent); only a plain answer (exit 0, no JSON block) is handed back, so a block or a
decision is never lost to it. On a guard event it never exits 75: it delivers the merged answer, and the host spills the
over-cap context itself. When one entry blocks, the advisories of the others are not shown; when several block, the
one block answered carries every block reason in table order (`dispatch.reason_joiner`), as the host would show the model
each of them. An empty `additionalContext` (a quiet turn, or a context the injection gate cut) is left out, never printed
empty. Results that cannot be
combined exactly (plain text next to another answer, a non-zero exit other than 2 next to another answer, two different
values for one field) are delivered as one answer and logged as `dispatch_conflict`: the JSON objects among the stdouts of
the hooks that exited 0 are merged into one line (the host reads a whole stdout as one object or as text, so two JSON lines
would lose every decision), a field set differently keeps the first hook's value, plain text next to JSON moves to
stderr, and the stderr of all hooks is kept.

**Stop never blocks forever (D74).** Exit 2 on `Stop` or `SubagentStop` keeps the agent running, so a fail-closed block there
that can never clear would stop it finishing. On those events (`dispatch.stop_events`) a payload with `stop_hook_active` true
fails open (exit 0, a note on stderr, `dispatch_stop_open` in the log), and so does every fail-closed block after
`dispatch.stop_block_cap` (2) consecutive ones in a session (counter files under `stop-blocks/` in the state dir, reset
when the guards run fine again). For an over-cap payload the engine does not decide from a capped prefix: Node's Stop
hooks receive the full bytes first, and the cap applies only if they cannot run or make no decision. A hook's own block is
never affected.

**Guards fail closed (D74).** The guard events (`dispatch.guard_events`: `PreToolUse`, `PermissionRequest`, `Stop`,
`SubagentStop`) never turn a failure into a silent allow. The call answers exit 2 with `dispatch.msg_fail_closed` on stderr
(the log has `dispatch_defer`) when a Node hook cannot run (no runnable command, an unreadable `--fallback-map`, a usage
error such as an unknown host, a panic), cannot be started, is killed by a signal, or finishes with incomplete output, and
when the payload cannot be read. A payload longer than `client.max_stdin` skips the engine's own checks and routes the full
bytes to the matching Node hooks from the raw stdin spool; the engine fails closed only if those hooks cannot run or make
no guard decision. A hook that exits 2 (or prints a JSON block) keeps its block even if a leftover process holds its pipes
open. A payload the dispatcher cannot parse, or that names no tool, selects every entry of the event instead of none. A
hook that runs past its timeout stays the host's own discard (no decision), and is logged (`dispatch_hook_timeout`).
`tests/it/fail_closed_matrix.rs` crosses every guard event with every injected failure and asserts one invariant: exit 2 with
a message, or the result Node's hooks would give, never exit 0 with nothing printed unless a hook that ran allowed. Any
other event runs the hooks it can and logs `dispatch_defer` for the ones it cannot. The plugin is wired to the dispatcher on the
`engine-proto` branch through the thin triggers above (D75, D87).

**Raw stdin spool (D87).** Payloads within `client.max_stdin` are delivered from memory and do not touch the spool. Only an
over-cap payload needs the raw stdin spool; if it cannot be created, a guard event fails closed with a clear stderr reason,
while a non-guard event exits 0 with a stderr note and a log/telemetry record when the state dir is usable. The over-cap
spool is anonymous on Unix: it is created in the private state dir and immediately unlinked, then each Node child receives
stdin from a feeder using positional reads so children do not share file offsets. A startup sweep removes stale named
`dispatch-stdin-*.tmp` regular files left by older builds or unlink failures after `dispatch.spool_stale_s`; it does not
follow symlinks or remove fresh/non-matching files.

**Parity.** `parity/run-dispatch.js` runs every matching Node hook of an event as its own process (as the host does),
combines them with an independent model of the host (`parity/dispatch-lib.js`), and compares exit code, stdout and
stderr byte for byte with one dispatcher call; `parity/fuzz-dispatch.js` drives the merge with fake hooks. The
results are in the README of `ah-engine/`.

## How to extend it

- **A new check.** Implement `Check` in its own module under `src/checks/`, list it in `checks::registry()`, put its
  tables and messages in a defaults file, and port its Node source with a parity corpus (`parity/`). The generated
  reference picks it up on its own.
- **A new setting, message, metric or impact kind.** Add the table to the right defaults file with a `doc`, use it from
  code, then regenerate `REFERENCE.md` (`cargo run -q -- docs --format md > REFERENCE.md`). The tests tell you if you forgot.
- **A new command.** Add its data to `commands.toml`, a handler in `src/cli.rs`, and regenerate the reference.
- **A new host.** Hosts share the hook payload field names today; a host with a different shape needs an adapter
  (D30). The dispatcher (D58) already keeps a table and matcher rules per host in `dispatch.toml`.

## Building from source

The toolchain (the latest stable Rust, with rustfmt and clippy) is pinned by `ah-engine/rust-toolchain.toml`, and the crate is on edition 2024. Dependencies are kept at their latest versions by Dependabot and a weekly `ah-engine-deps` workflow; `cargo deny check` (`ah-engine/deny.toml`) and `cargo audit` gate licences and advisories (D84). From `ah-engine/`:

```
cargo build --release --locked      # binary: target/release/ah-engine
```

An offline build from the vendored source tarball published with each release uses
`cargo build --release --offline --frozen`. Release steps are in `ah-engine/RELEASING.md`.

## Using a locally built binary

Copy your build to `~/.anti-hall/ah-engine/bin/ah-engine`. The wrapper uses the binary at that path, and the bootstrap never
overwrites a binary it did not install (it checks the marker `bootstrap.installed` and the recorded binary sha256), so a local
build stays until you delete it. A binary-path override exists for the test suite only and is ignored otherwise.

## Verifying release artifacts

Each release publishes the archives, a `.sha256` per archive and `SHA256SUMS`, with build provenance:

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
| Stop it | `ah-engine stop`. It starts again on the next hook call while the binary is installed; to turn it off, see Rollback. |
| Undo a bad restore | Every restore keeps the state before it in `backups/pre-restore-<ms>/`; restore that directory. |
| `hot.db` keeps growing | Run `ah-engine maintain` (it reports what it moved and the sizes before and after); see the `retention.*` settings. |
| `proj` printed `spooled <id>` | The engine was down or busy; the write is safe in `spool.log` and is applied when the engine runs. |
| `spool.quarantine` has entries | Records that were damaged or refused for good (for example a full mailbox), each with its reason; nothing was dropped. |
| The engine says it is degraded | An engine file fell back to the last-known-good or pristine copy. `ah-engine config --json` shows `last_error`; fix the edit, or `ah-engine config heal` for a missing setting. |
| A check misbehaves | Run `ah-engine check git` with the payload on stdin to see its verdict without a daemon. |

## FAQ

**Does it send anything off my machine?** No. Telemetry is local only. The one network request the install makes is the one-time
binary download from the GitHub Release (sha256-checked against the plugin's lock; the opt-out variable named in Install skips it). The daemon
opens no connection; only the opt-in Jev commands do. Any upload of diagnostics would be opt-in and disclosed first (D28, planned).

**What if the engine crashes or disagrees with the Node hook?** A crash or a bad answer falls back to the Node hook. A
disagreement is a bug in the engine: the parity harness compares exit code, stdout and stderr with the Node guard, and a
mismatch is fixed in Rust, never by changing the guard (D31).

**Why Rust?** The client uses about 2 MB against 44 MB for a Node process and answers in about 2 ms against about 20 ms
(D2). Numbers and how they were measured are in the README of `ah-engine/`.

**Is it on?** It is used whenever its binary is installed at `~/.anti-hall/ah-engine/bin/ah-engine`, which the plugin's bootstrap does
once a release pins one in `ah-engine.lock`. With no binary, or after opting out of the bootstrap and removing it, the Node hooks run as before
([Rollback](#install-go-live-and-rollback)). `ah-engine status --json` and `ah-engine telemetry summary` show what it is doing.
