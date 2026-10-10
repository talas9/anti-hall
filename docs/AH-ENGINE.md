# ah-engine

`ah-engine` is anti-hall's core component: a small resident program that answers the hooks instead of a new Node process for every
tool call. The Node hooks are a temporary compatibility fallback during the migration; v1.0 removes them and the engine is then the only runtime. This page explains what it is, why it exists, what works today and what is not built yet. Anything not built
is marked **planned** with the number of its decision, for example planned (D33) for the scheduler; each number is an entry
in [`ah-engine/DECISIONS.md`](../ah-engine/DECISIONS.md).
The exact list of commands, settings, metrics and error codes is generated from the engine itself and lives in
[`ah-engine/REFERENCE.md`](../ah-engine/REFERENCE.md).

**Status: ready for release; the plugin installs it itself once a release pins it.** The plugin's hooks are one thin trigger
per event (`hooks/ah-hook.sh <Event>`). When the engine binary is installed, the trigger asks the engine, which decides
natively what it can prove identical to the Node hook and hands every other case to that Node hook, so it is never weaker
than Node. While the migration lasts, when the binary is absent or cannot answer, the trigger runs the temporary Node compatibility hooks (removed in v1.0). The binary is
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
  and `stale-agent-stop-note`, which share one streaming port of the transcript agent scan (see the README of `ah-engine/`); and the two edit and shell guards `merge-gate` and `api-guard`, which answer only what
  Node answers with no output and no side effect and defer the rest, so a possible block, a Jev shadow ask or an
  interpreter probe is always the Node hook's; and `edit-guard` (lane L12), which decides every target on the main thread
  as Node does (a block, the coordinator allowlist, the symlink and hard-link honesty walk, a Codex `apply_patch`) and
  defers only a call that needs the hook process's own working directory or home, or the JavaScript string form of an object; and the batch 14 to 16 ports: the spawn and comms guards `swarm-guard` (the spawn-rate and
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
| Built-in `handover-hygiene` check (SessionStart; `guards.handoverHygiene`): engine-only, no Node twin (fallback `hooks/handover-hygiene`, a shell no-op). Registers the project for the scheduled `handovers` job and tells the session once per distinct problem set when handovers are unindexed, stale, missing a brief, lack a Next action or carry a broken reference; the same script is the engine of `ah-engine handovers` and of the `handovers` job (`index --registered`, every `schedule.handovers_ms`). Tree layout, rules and texts: `handovers.*`. | implemented | D17, D88 |
| Built-in `engine-role-guard` check (PreToolUse on Bash; `context.roleGuard`): engine-only, no Node twin (fallback `hooks/engine-roles`, a shell no-op). Refuses an `ah-engine` command the caller's role may not run, per the `roles.matrix` in `roles.toml`: a subagent is told from the payload, a workspace child from `DEVSWARM_SOURCE_BRANCH`; the command line enforces the same matrix for what the environment proves (exit 77). | implemented | D17, D74, D87, D88 |
| Built-in `broad-kill-guard` check (PreToolUse on Bash, every agent: main session, workspace child, subagent, Codex; `guards.broadKill`, a locked safety switch): engine-only, no Node twin (fallback `hooks/broad-kill-guard`, a shell no-op), issue #38. Blocks `pkill`, `killall`, `killall5`, `fuser -k`, `kill -1` / `kill 0` and a kill fed by a name or port lookup (`kill $(pgrep ...)`, `pgrep ... \| xargs kill`); `kill <pid>` of an explicit PID and `pkill -P <pid or $$>` (the caller's own children; parent 1 is not a scope) stay allowed. `command-guard` is coordinator-only and cannot see a subagent's call, which is where the motivating incident came from. It reads simple commands (quotes, substitutions, heredocs a shell reads, `sh -c` / `eval` scripts); a script file, an interpreter's kill call or a remote `ssh host pkill` are out of its reach. The command lists, patterns and texts are plugin data (`broad_kill.toml`); its own failure allows. | implemented | D17, D74, D87, D88 |
| Built-in `engine-role-note` check (SessionStart, SubagentStart; `context.roleNote`): engine-only. Tells the session its role, the engine verbs that role may run and the main skill to read (`/anti-hall:engine`, `$anti-hall-engine` on Codex); capped at `roles.note_max`. | implemented | D17, D74, D87, D88 |
| Built-in `silent-agent-nudge` check (Stop): answers every Stop that does not nudge, including the rewrite of the nudge state file; a Stop that would nudge defers to Node, which words it and checks the running build | implemented in part | D29-D31, D75 |
| Built-in `merge-gate` check (opt-in false-done backstop): allows every Bash call Node allows with no output (gate off, not an auto-merge command, no hedge phrase in the recent assistant text); a hedge phrase defers to Node, which owns the block and the Jev shadow ask | implemented | D29-D31, D74, D75 |
| Built-in `api-guard` check: allows every call that reaches no interpreter probe (guard off, not Python or JavaScript, no verifiable module or global named, no code file named in a shell command or patch); everything else defers, so the probes stay with Node | implemented | D29-D31, D62, D74, D75 |
| Built-in `edit-guard` check: the launcher-directory block (every agent), every call that is not the main thread, and the verdict on every main-thread target (coordinator allowlist with the symlink and hard-link honesty walk, trusted per-project allowlist, harness plan file, session scratchpad, handover documents, plan mode, DevSwarm child workers and wording, Codex `apply_patch`), byte for byte; a call that needs the hook process's own working directory or home, or the DevSwarm Primary inline-work note past its threshold, defers (lane L12) | implemented | D29-D31, D74, D75, D88 |
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
| Built-in `inbox-read-guard`, `phase-tracker`, `orch-on-spawn`, `verify-first-orch` and `verify-first-orch-codex` checks (the spawn/path context ports) with exact parity on the paths they answer; the cases that need Node's own probes defer (`orch-on-spawn` takes the spawn-time claim itself and defers only the retry slot after the claim's lease, which needs the transcript scan; `phase-tracker` hashes any working directory in its JavaScript string form) | implemented | D29-D31, D74, D75, D88 |
| Built-in `handover-resume` and `precompact-snapshot` checks (handover persistence) with exact parity on the corpus; unreproducible cases defer | implemented | D29-D31, D74 |
| Built-in `codex-availability`, `codex-quota-detect` and `codex-nudge` checks (Codex availability and quota) with exact parity on the corpus; unreproducible cases defer | implemented | D29-D31, D74 |
| Built-in `model-routing` check for Agent/Task spawns: blocks execution-shaped flagship or inherited generic spawns and advises on routing mismatches | implemented | D29-D31, D75 |
| Built-in `verify-first`, `idle-agent-sweep` and `emit-dedupe-reset` checks (prompt emission, advisory only) over the shared emit-dedupe state file, with exact parity including the state files; a DevSwarm Primary session and anything JavaScript might read differently defer to Node | implemented | D29-D31, D74, D75 |
| Built-in `version-alert`, `devswarm-version`, `claude-cli-version` checks (SessionStart drift and update advisories from a cached probe): output and state file identical to Node on a fresh cache; a stale or absent cache defers because Node starts the detached refresh | implemented | D29-D31, D74, D75 |
| Built-in `repo-self-drift` check (KB hook and skill counts against disk, model-KB audit age): the scan, its cache and the once-per-finding advisories identical to Node | implemented | D29-D31, D74, D75 |
| Built-in `defect-nudge` check (once-a-day count of unfinished defect reports or of rulings on this project's reports; counts and ages only): identical to Node; a payload without a working directory or a date the time zone can change defers | implemented | D29-D31, D74, D75 |
| Built-in `progress-prune` check (archive stale per-session progress files into the history ledger before removing them; weekly gitignore reminder using the client's git): identical to Node; an unusual `.git` file or a slow git defers | implemented | D29-D31, D59, D74, D75 |
| Built-in `swarm-guard` check (Agent and Task spawns): memory-pressure and spawn-rate blocks with exact parity, the spawn log, trip log and lock file shared with the Node hook; a spawn that might get the shared-tree advisory defers before it is recorded | implemented, shared-tree advisory decided natively | D29-D31, D75 |
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
| Read-only reader of the per-repo DevSwarm stores Node writes (`ah-engine mesh`, `src/mesh.rs`): roster, per-workspace counts, messages, gates, cursors, reader cursors; byte-equal to Node's reader on every live store copy (parity P1). Stage 2 (`src/meshw/`, switch `mesh.engine_writes`, default off): `send`, `mesh read`, `mesh history`, `roster --ack` and `inbox ack-primary` (the successful path: the caller's own-partition cursor moves of a read receipt) with Node's store writes, locking and output, the summary projection refresh those verbs make (`summaries/<repoKey>.json`), a shadow mode that replays each store-writing verb on a store copy and logs the comparison, and deferral to Node for anything not reproduced exactly (decided before any write; after its own write the engine never reruns the verb in Node, it exits 70 instead). Turn it off with `{"mesh":{"engine_writes":"off"}}` in `~/.anti-hall/settings.json`. Still Node: ingest, a mesh group (sibling partitions) in `inbox read-primary` and `inbox tick`, plain `roster` for any project that has a row, and the sibling and NDJSON-inbox cursor moves of `ack-primary` | implemented in part | D45 |
| Jev lane: Vercel and TypeSafe transports with fallback and breaker, Noul and Choice calls, off/shadow/on modes, add-block and advisory trust, cache, async queue with budgets, the `jev-assist.ndjson` rows, `ah-engine jev` | implemented, one-shot only | D34-D38 |
| Jev wired into the dispatcher and the daemon, spend budget watch, audit snippets, daily rollups, persisted breaker and cache | planned (D58, D38) | D38, D58 |
| Operator helpers: `ah-engine jev-setup` (status, enable, disable, set-key, bind-generic-key, mode), `capability-scan`, `harvest`, `briefing`, byte-for-byte with the Node scripts | implemented | D81 |
| Operator commands `ah-engine update` (pull, cache sync, harness re-registration, changelog) and `ah-engine install-codex` (the Codex port installer), with the Node scripts' output and file effects; the post-pull stages are run by the engine (table `update_post.toml`): budget deferral, the DevSwarm gate and the one-time per-version markers are answered natively, the stages' real work on the stores and settings runs by the script's own stage function in a bounded Node subprocess | implemented | D81 |
| Backups and restore: online snapshot of both databases, scrubbed; restore keeps the current state first | implemented | D27 |
| Health check and repair: `ah-engine doctor` (platform and versions, hook scripts on disk, live self-tests of the built-in guards, statusline, Workflow templates, the repair pass) and `ah-engine migrate` (the persisted-state migrations and sweeps) | implemented for the plain-file steps; the DevSwarm-store steps and the spawn-based checks stay with the Node doctor | D81 |
| The DevSwarm store migrations, the statusline render, context footprint, supervisor, OMC and Codex detection, ingest units and the opt-in doctor flags in the engine doctor | planned (D81) | D81 |
| Issue log and opt-in upload | planned (D28) | D28 |
| Update checks as a scheduled job | planned (D44) | D44 |
| One dispatcher call per hook event: `ah-engine hook --event`, built-in checks in the engine, the other hooks as Node, combined in table order; the plugin's `hooks.json` is one thin trigger per event, generated from the table (`ah-engine gen-hooks`) | implemented on the `engine-proto` branch (the installed plugin changes when it merges) | D58, D75, D87 |
| Per-event and per-entry hook configuration (`[events.<Event>]`, `[entries.<id>]`: mode, max_rules, budget_ms, order) and the `when` predicate | implemented | D87 |
| Realtime watch facility (`src/watch/`, generic: directories and file names in, coalesced batches or one rescan signal out): OS file events (FSEvents, inotify) by default, stat polling for 9p, drvfs, NFS, SMB, FUSE and any directory the OS refuses; bounded queue; no consumer wired yet | implemented | R1 (DECISIONS.md, "Realtime watch backend") |
| Porting the other guards | planned (D57) | D57 |
| Prebuilt binaries for every Unix target, release automation (prepare, publish, sha256 and attestation), the plugin-side bootstrap with a pinned lock | implemented (see Install, go-live and rollback) | D56, D64, D67, D68 |

### Session-cache refresh (v1.0 lane L06)

`ah-engine refresh [--force] [--home <dir>]` handles the refresh requests the SessionStart checks write (the remote-latest release tag for `version-alert`, the Claude Code and DevSwarm CLI versions for the drift probes, and the reload repair for `repair-on-reload`), each as a bounded subprocess. Where the Node hooks started a detached refresh, the engine's checks write a request file, answer at once and let this job do the work; the scheduler runs it every `refresh.every_ms` (`refresh.toml`).

### Background units, the MCP reaper and the wake-watch monitor (v1.0 lane L08b)

- `ah-engine units <status|install|heal|uninstall> [--dry-run] [--bin <path>] [--json]` writes and loads the one engine unit (a launchd agent on macOS, a systemd user timer on Linux) and, on `heal`, moves aside (never deletes) the Node units whose duty the engine now runs. Every action is a ledger line, an engine log line and a telemetry item. `update` runs the heal as a post-pull stage and `doctor --repair` as a repair row (`units-heal`), idempotent and silent when nothing changed; the setting `maintenance.unitsHeal` (default on) switches both off.
- `ah-engine mcp-reaper run [--dry-run]` is the port of the standalone MCP orphan reaper (`companion/mcp-reaper.js`), run by the scheduled job `mcp_reaper` (`mcp_reaper.job_every_ms`). The setting `maintenance.mcpReaperJob` is `auto` by default: it runs once the Node reaper's opt-in was carried over by `units heal`, and never while a Node reaper unit is still installed, so the reaper never runs twice.
- `monitors/monitors.json` starts `ah-engine devswarm wake-watch --auto` directly. Until the runtime cutover (lane L17) the command falls back to the launcher `scripts/ah-run.sh`, which runs the Node watcher, when the engine answers 70, 75, 126 or 127 (it cannot load its defaults, defers, is not executable or is missing); any other engine exit is the watcher's own and is kept.

## Install, go-live and rollback

**Install.** The plugin ships `ah-engine.lock` (schema, engine version, tag and the sha256 of every release asset). On every
SessionStart, `hooks/ah-hook.sh` starts `hooks/ah-engine-bootstrap.sh` detached (only when the lock file is present and the
the wrapper's test-only binary override is unset). The script (POSIX sh, never fails a session):

1. detects the target (macOS arm64 or x86_64, Linux x86_64 or arm64 on glibc or musl, WSL as Linux; anything else, such as
   native Windows, is reported as unsupported and skipped);
2. downloads `ah-engine-vX.Y.Z-<triple>.tar.gz` from the GitHub Release over HTTPS (TLS 1.2 or newer, 120 s download limit,
   128 MB size cap; `curl`, or `wget` when there is no `curl`);
3. installs it to `~/.anti-hall/ah-engine/bin/ah-engine` **only if its sha256 equals the lock's entry**. There is no trust on
   first use: a mismatch is refused and nothing is installed. It extracts only the one expected binary from the archive and
   runs `ah-engine version` first: a binary that does not run or reports another version is not installed;
4. does it atomically and keeps the previous binary as `bin/ah-engine.prev`.

It is idempotent (the same lock does nothing), rate limited (a failed attempt for a lock is retried after 6 hours), and it never
overwrites a binary it did not install (a local build is left alone). Every outcome is written to
`~/.anti-hall/ah-engine/bootstrap.log`. A plugin tree without `ah-engine.lock` installs nothing and stays on Node. Opt out with
the setting `engine.bootstrap` = false (`/config`, `/anti-hall:settings`; stored in `~/.anti-hall/settings.json`) or the environment variable `AH_ENGINE_BOOTSTRAP=0`, which overrides the setting (see also [RELEASING.md](../ah-engine/RELEASING.md)). This download is the only network request the engine's install makes; see [PRIVACY.md](../PRIVACY.md).

**Updating the engine (`ah-update`).** One script, `hooks/ah-update.sh` (POSIX sh, no Node; deliberately outside the engine so a broken
engine stays fixable), moves the binary between three sources. Every URL, timeout and channel name is in `engine/ah-update.toml`.

| Command | What it does |
|---|---|
| `sh hooks/ah-update.sh --from FILE [--sha256 X]` | Offline: FILE is a release `.tar.gz` or a bare binary. The expected sha256 is `--sha256`, else the `SHA256SUMS` next to FILE, else `ah-engine.lock`; with none of them the sha is printed and `--yes` is required. A mismatch refuses. |
| `sh hooks/ah-update.sh --channel stable` | The latest `ah-engine-v*` release, checked against its `SHA256SUMS`, this plugin's lock when the versions match, and the GitHub build attestation when `gh` is installed and logged in (skipped with a note otherwise). |
| `sh hooks/ah-update.sh --channel dev` | The latest `ah-engine-dev-<sha8>` pre-release (built and attested by CI on each `engine-proto` push that changes `ah-engine/`). With the live kit installed it also syncs the plugin files at the commit the pre-release records, so engine and plugin do not drift. |
| `sh hooks/ah-update.sh --rollback` | Restores the previous binary (`bin/ah-engine.prev`); run again to toggle. With the live kit, restores the previous bundle and re-applies it. |

Each update smoke-tests the new binary (`version`), swaps it in atomically (the old one is kept as `.prev`), then restarts the daemon with
the engine's own `stop` and `serve`; any failure keeps the old binary. `--dry-run` checks everything and installs nothing. With the live
kit the binary and plugin go in through the kit (`bundle/` and a `go-live.sh` re-apply, `--live-select` picks the entries), so the kit's
own rollback keeps working. Setting `engine.autoUpdate` = `stable` or `dev` (default `off`) runs `--auto` from the engine scheduler, at most
once a day. The updater's only network requests are the GitHub release API and downloads, and `git fetch` of one commit for the dev plugin sync;
`ah-engine engine-update <same arguments>` runs the same script (the engine itself does no network access, and a broken engine is still
updated with the script by hand). The scheduler job `engine_update` (defaults file `engine_update.toml`) runs `engine-update --auto`
every 6 hours; the script does nothing unless `engine.autoUpdate` is set and limits itself to one check a day.

Memory diagnostics (issue #21, defaults file `diagnostics.toml`). With `diagnostics.mem_log` on (default) the daemon appends one NDJSON line
per served request to `mem.ndjson` in the state directory (rotated at `diagnostics.mem_log_max_bytes`): the request kind and event, the checks
that ran, the resident set, the allocator's allocated and resident bytes and the counted heap before and after, and the size of the
transcript file. When the resident-set cap trips (`diagnostics.mem_snapshot`) the daemon writes `mem-snapshot.json` before it drains:
allocator statistics, thread count, each worker's interpreter and regex cache, the transcript caches and the platform memory map.
`ah-engine status --memory` prints the live figures, the latest snapshot and a summary of the log (top events and checks by total
resident-set growth; a check's row counts every request it took part in, so rows overlap). Nothing here changes a decision.
see [PRIVACY.md](../PRIVACY.md).

**Go-live.** An engine check is trusted only after it has agreed with the Node hook it replaces. Before release the whole
dispatcher was replayed against Node (see [Measured results](#measured-results-pre-release)); per entry the engine can also run
beside Node on live traffic: `mode = "shadow"` on a guard entry that has a built-in check runs the check next to the Node hook,
which still decides, and logs `dispatch_shadow` with whether the two agree ([Dispatcher](#dispatcher), configuration of events and
entries). A check that cannot reproduce Node exactly defers (exit 75 from the engine, the wrapper then runs the Node hooks).

**Rollback.** In order of how much you want to undo:

| To undo | Do |
|---|---|
| one check | set `mode = "off"` on its `[entries."<id>"]` in the engine's `config.toml`: only the engine's check is skipped, its Node hook decides (hot reload, no restart) |
| the engine, for now | `ah-engine stop`, then remove `~/.anti-hall/ah-engine/bin/ah-engine`; the wrapper finds no binary (it looks at its test-only binary override, `~/.anti-hall/ah-engine/bin/ah-engine`, then `ah-engine` on `PATH`; remove a `PATH` copy too) and runs the Node hooks |
| the engine, for good | also set `engine.bootstrap` = false or the opt-out variable (see Install above), or the next SessionStart reinstalls the pinned binary |
| a bad engine build | copy `bin/ah-engine.prev` back over `bin/ah-engine`; the bootstrap then leaves it alone (its sha256 no longer matches the install marker), so the rollback sticks until you remove the binary or the lock changes |
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
| The blocking branch of several guards | `api-guard`'s interpreter probes, `merge-gate`'s hedge, `task-guard` and `tasklist-guard` Stops that would block, `silent-agent-nudge`, `devswarm-parent-gate`, and the command check's non-trivial verbs: the engine answers the quiet cases and defers any case that could block |
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
| `ah-engine docs` | yes | The generated reference (`--format md`, or `--json`), and the generated engine skill family (`--format skill-list`, `--format skill --name <skill> [--host claude\|codex]`). |
| `ah-engine gen-hooks --host claude\|codex [--kind hooks\|registry\|list\|map]` | yes | Print a file generated from the dispatch table: the thin `hooks.json` (one trigger per event), the per-hook registry, the wrapper's fallback list or its fallback map (D87). |
| `ah-engine check <name>` | yes | Run one check on a payload from stdin (parity harness). |
| `ah-engine version` | yes | The version this build reports. |
| `ah-engine ctl <verb>` | no | `ping`, `reload` (also re-reads the config files), `stop`, `status`, `config`. |
| `ah-engine stop` | no | Drain and exit. |
| `ah-engine reset` | no | Clear the breaker, crash-loop stop and failure record. |
| `ah-engine maintain` | no | Size control: move inactive rows to `archive.db`, prune derived bookkeeping, checkpoint and VACUUM; prints a report. |
| `ah-engine proj <cwd> <verb>` | no | Per-project state in `hot.db`: mailbox `put`, `take`, `len`; key-value `set`, `setex` (TTL in seconds), `get`. A write the engine cannot take is spooled. |
| `ah-engine jev <ask\|status\|scrub\|evidence>` | no | The optional Jev lane: `evidence` reads one evidence pack per stdin line and prints what the evidence gate did with it (see "The evidence gate" under the Jev lane); `ask` reads JSON requests (one per stdin line) and prints each decision, `status` prints the resolved settings and every integration's mode (never a key), `scrub` redacts secrets from JSON strings. |
| `ah-engine doctor [--check] [--repair\|--fix] [--dry-run] [--migrations-only] [--quiet]` | no | The health check and repair, in the Node doctor's layout and finding texts. Read-only unless `--repair`; `--dry-run` previews; `--migrations-only` with either prints only the migration report as one JSON line. Each built-in guard is run in-process on a crafted payload (a payload the engine defers is run through its Node hook, as the dispatcher would; with no Node it is reported as a deferral, never a pass). |
| `ah-engine migrate [--dry-run] [--home <dir>] [--cwd <dir>] [--plugin-root <dir>]` | no | The persisted-state migrations and sweeps of the Node doctor's repair pass, with Node's report: legacy progress/history copy, reply-state, gate-intent and auto-archive forward migrations, the `settings.json` migration, the Jev triage cache repair, the lock scratch sweep and the retention sweeps. Idempotent, fail-open, no repo file is moved or deleted. |
| `ah-engine jev-setup <status\|enable\|disable\|set-key\|bind-generic-key\|test\|mode\|review-due\|reviewed\|snooze>` | no | The port of `scripts/jev-setup.js` (D81): `status` prints the resolved settings, key presence yes or no, every integration's mode, the calls of the last 24 hours and the Vercel credit balance; `enable`, `disable`, `bind-generic-key` and `mode <integration> on\|shadow\|off` write `settings.json` and `jev.json` the way the script does (read-modify-write, key order kept, a corrupt file moved aside); `set-key` reads the key from stdin only and writes the key file with mode 0600; `test` makes one real gateway call per configured transport, each on its own, and `review-due [--json]`, `reviewed <integration>` and `snooze <integration> --days N` keep the durable shadow-review state (`~/.anti-hall/jev-review-state.json`). Every verb is answered natively (v1.0 lane L03). |
| `ah-engine jev_sweep` | no | The scheduled `jev_sweep` job (`jev::sweep`): one evidence sweep of the supervisor's Jev questions; it gathers the WaitKind, Loop and StepMap facts (plan, transcript, git, CI, mesh), runs them through the evidence gate (`jev_evidence.toml`) and records the telemetry; Node no longer asks those three questions. Takes no arguments; the home directory comes from the environment. |
| `ah-engine gh <status\|segment\|poll>` | no | GitHub realtime (#20, independent of DevSwarm): `status` prints the followed repos with their pull request, review, CI and mergeability, the rate budget, the hold in force and the measured rate-limit cost of 200 and 304 answers (state file only, no network); `segment [--cwd <dir>]` prints the statusline piece for the repo that holds the directory; `poll [--force]` runs one tick now. |
| `ah-engine gh_poll` | no | The scheduled `gh_poll` job (`ghrt::poll`): one tick of GitHub realtime; always exits 0. |
| `ah-engine agent_tick` | no | The scheduled `agent_tick` job: one agent-tracker tick (the same as `agents tick`); prints its counts with `--json`. |
| `ah-engine capability-scan [--root <plugin dir>]` | yes | The port of `scripts/capability-scan.js` (D81): which opt-in capabilities of a plugin tree are shipped and active on this machine, and how to enable the ones that are not; prints the JSON report, then one line per capability. |
| `ah-engine update [--check] [--post-pull-only]` | no | The port of `skills/update/scripts/update.js` (D81): `git pull --ff-only` of the marketplace clone (a dirty tree or a diverged history is a hard STOP with exit 1; an offline failure fails open), a copy of the plugin into a new version-pinned cache directory (never over or beside an existing one), `claude plugin update anti-hall@anti-hall` when the harness registry is behind (20 s bound, never answers a confirmation, `installed_plugins.json` is only read), the changelog delta, then one JSON status line and the human summary. `--check` compares versions only. The post-pull stages (`update_post.toml`, in `update.js`'s order, status keys in its key order) are run by the engine: the overall post-pull budget (`ANTIHALL_UPDATE_POSTPULL_BUDGET_MS`) defers a stage whole, a stage that is DevSwarm-only is answered with the closed-gate text outside a DevSwarm session, a one-time stage already stamped complete for the new version in `update-sweep-state.json` is answered with the script's "already completed" shape, and everything else runs by the script's own exported stage function in a bounded Node subprocess (so its answer, key order included, is the script's). Reconcile, the store folds and heals, the settings migration and the Codex hook cleanup stay in Node for their real work: their results come from `serde_json` maps (sorted keys) in the engine's ports, which cannot reproduce the script's key order. A plugin file a stage needs being missing is also left to the script. |
| `ah-engine install-codex [--global] [--dry-run] [--root <plugin dir>]` | no | The port of `codex/install-codex.js` (D81): merges the generated Codex hook registration into `.codex/hooks.json` (project, or the home directory with `--global`), replacing only anti-hall's own groups, and enables the hooks feature in `config.toml`. A file that changes is copied to `<file>.bak-<time>` first; `--dry-run` writes nothing; a second run changes nothing. |
| `ah-engine harvest [--dir <path>] [--stale-days <n>]` | yes | The port of `scripts/harvest-debt.js` (D81): the `anti-hall: <ceiling>, <when>` debt markers of a code tree, flagged when they have no payback trigger or sit in files git says are old. |
| `ah-engine briefing [--root <plugin dir>]` | yes | The port of `scripts/briefing.js` (D81): a derived inventory of a plugin tree, the registered hooks by event with the purpose from each hook's header comment, the skills, the DevSwarm substrate and the docs map. |
| `ah-engine settings <show\|get\|set\|reset\|judge\|trust-command-allow\|trust-edit-allow> [args] [--json]` | no | The port of `scripts/settings.js` (L9a), byte-for-byte; replaces `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.js" ...` in `skills/settings/SKILL.md` at the cutover. A run is also replayed by the Node script in a scratch home in the background (`ops.shadow_rate_settings`), a mismatch is a `shadow` telemetry event. |
| `ah-engine defect <report\|list\|show\|rule\|archive\|backfill\|recurring\|similar> [flags] [--json]` | no | The port of `scripts/defect.js` with the defect store and history (L9a), byte-for-byte; replaces `node plugins/anti-hall/scripts/defect.js ...` in `skills/defects/SKILL.md` at the cutover. Shadowed by Node like `settings` (`ops.shadow_rate_defect`). |
| `ah-engine auto-handover-config <get [--json]\|set <1-99>\|off\|on\|nag on\|off\|nag-step <n>\|nag-quiet <n>\|max-tokens <n>>` | no | The port of `scripts/auto-handover-config.js` (v1.0 lane L03): get or change the auto-handover trigger's settings (section `autoHandover`). The command reads the values as the settings store answers them (environment, file, plugin option, default) and writes the changed ones one key at a time through the same store as `settings set`; what to print and what changed is the plugin script `engine/logic/rules/operator-cli.js`. `ANTIHALL_AUTO_HANDOVER_PCT=0` still switches the trigger off outright. |
| `ah-engine dispatch-report [--json]` | yes | The port of `scripts/dispatch-report.js` (L03): effectiveness metrics of the parallel-dispatch demand (shown, followed, ignored, compliance, idle-neglect blocks), the Jev dispatch tier (verdicts, follow rate, accuracy proxies) and the coordinator-work window (nudges, blocks, work share per plugin version), from `dispatch-demand-metrics.json`, `coordinator-work-metrics.json` and the live session files; summaries and text are in `engine/logic/rules/operator-cli.js`. |
| `ah-engine finding-dedup [--file <findings.json>]` | yes | The port of `scripts/finding-dedup.js` (L03): the advisory duplicate-finding detector of the deadly-loop trio. It reads a JSON array of findings (stdin or `--file`), asks Jev (`findingDedup`, trust advisory, four pairs at a time, at most 200) whether candidate pairs describe the same root cause and prints `{"groups":[...]}` on stdout and one `possible duplicates` line per confirmed pair on stderr. It never collapses anything; with Jev off, unkeyed or the integration off it prints no groups. The pairing and grouping rules are `engine/logic/rules/operator-cli.js`. |
| `ah-engine coordinator-work-baseline <transcript.jsonl> [--from-line <n>] [--cwd <dir>] [--json]` | yes | The port of `scripts/coordinator-work-baseline.js` (L03): replays a transcript's main-thread Bash calls through the coordinator-work classifier and window and prints calls, work, the share as recorded and with enforcement, and the would-nudge and would-block counts. The replay is the plugin script `engine/logic/rules/coordinator-work-baseline.js` (built on `command.js` and `coordinator-work-guard.js` through `script.includes`); a command whose class only the hook process could tell is counted as not work and said once on stderr. |
| `ah-engine jev-report [--json] [--days N] [--window 24h\|7d] [--by project\|session] [--project <name>] [--weekly] [--since <iso>] [--until <iso>] [--exclude-window <iso>..<iso>] [--exclude-project <name>]`, `jev-report label <hash> [tp\|fp]`, `jev-report prune-audit --days N` | no | The port of `scripts/jev-report.js` (the Jev report of the `/anti-hall:jev` skill), byte-for-byte: the command reads the decision, triage, judge and supervision logs (every retained generation), the daily rollups, the human labels, `jev.json`, the budget settings and the cached Vercel credit balance, and the plugin script `engine/logic/rules/jev-report.js` aggregates and renders the text or `--json` report (KEEP / REVIEW / REMOVE verdicts included); `label` and `prune-audit` are the two forms that write the Jev logs, the report itself only refreshes the credit cache and the once-a-day low-credit latch. Every threshold, list and word is `jev_report.toml`; a run it cannot reproduce exits 75 and writes nothing, so `scripts/ah-run.sh jev-report` runs the Node script. |
| `ah-engine statusline` | no | The port of `statusline/statusline.js` and its renderers (L9a): reads the session JSON on stdin, prints the two lines; runs from the `statusLine` setting through the thin launcher `scripts/ah-run.sh`, which tries the engine first and runs `statusline/statusline.js` when the engine is absent or answers exit 75 (the same stdin goes to whichever runs; see `install-statusline` and the `migrate-statusline-engine` step). Sampled shadow against Node, off the hot path (`ops.shadow_rate_statusline`, per thousand). |
| `ah-engine phase <set\|advance\|step\|agents\|update\|clear> [args]` | no | The port of `statusline/phase.js` (L9a), byte-for-byte: writes the phase state (`~/.anti-hall/phase-state.json`) the status line's phase bar shows. Fails open like the script; a state that is not a JSON object, or `update` with a numeric key or `__proto__`, is left to Node (exit 75, nothing written). Replayed by Node in a scratch home (`ops.shadow_rate_phase`). |
| `ah-engine install-statusline` | no | Retired no-op kept for old invocations: prints that anti-hall no longer writes a command-backed `statusLine` and exits 0. |
| `ah-engine uninstall-statusline [--user\|--project] [--purge-base]` | no | The port of `statusline/uninstall-statusline.js` (L9a): restores the saved original statusLine, else the settings backup, else removes the key; the shared base is kept unless `--purge-base`. Same safeties and shadow as the installer (`ops.shadow_rate_uninstall`). |
| `ah-engine shadow-compare <dir>` | no | Internal: the detached half of a Node shadow; runs the Node version on a scratch home and logs a mismatch. |
| `ah-engine backup [--to <dir>]` | no | A consistent, scrubbed snapshot of `hot.db` and `archive.db`; prints its manifest. |
| `ah-engine restore <snapshot-dir>` | no | Keep the current state as a pre-restore snapshot, stop the daemon, swap in the snapshot. |
| `ah-engine config [--json]` | yes | The effective config with the source of every value (`default`, `config_toml`, `settings`, `env`), the files read, the active version, any rejected edit and settings pending a restart. Asks the running daemon, else reads the files. |
| `ah-engine config validate <file>` | yes | Check an engine TOML file against the schema: exit 0 when valid, 1 with the reason when not. |
| `ah-engine config heal` | no | Add the settings the edited engine files lack, taken from the pristine copy (existing text kept, the file backed up first, idempotent). The automatic heal skips a version-controlled checkout; this command does not. |
| `ah-engine config versions`, `config rollback`, `config export` | no | planned (D18, they need the config database); they say so and exit 64. |
| `ah-engine agents status\|tick [--json]` | no | The agent tracker: `status` lists every tracked agent (tokens, cache, tool calls, progress, last output, state, flags) with today's reminder and recovery totals and never changes anything; `tick` runs one tracker tick now. See The agent tracker. |
| `ah-engine schedule list\|run <job>\|history` | no | The scheduler's jobs with their next run and last result; run one now; the run history. |
| `ah-engine mesh <roster\|unread\|read\|dump> --db <devswarm.db> [--id <ws>] [--since <n>] [--last <n>]` | yes | Read a repo's DevSwarm store in place, read-only (D45 stage S0): the registered workspaces, the per-workspace counts, a workspace's messages (capped, with a resume position), and the full canonical dump the parity harness compares with Node's reader. Refuses a journal-backed store; never creates or writes one. |
| `ah-engine devswarm <status\|line\|supervisor\|recover\|advisory\|archive\|plan-prune\|prune\|help\|skip\|archive-ignore\|archive-unignore\|gate-intent\|notice\|plan\|scope\|gate\|workspaces\|logs\|wake-directive\|ready-check\|app-state\|app-sync\|done\|primary\|relay\|archive-request\|nudge\|supervision-report\|sync-ui\|retention\|unarchive\|migrate-owner-keys\|ensure\|register\|correct\|reap-orphans\|wake-watch\|register-primary\|diagnose\|healthcheck\|merge\|spawn\|respawn\|reconcile-registry\|reap-stale\|reconcile-active\|auto-archive>` | no | The DevSwarm realtime state and owner actions (lane dswire; `supervisor` prints who owns the supervisor duties and `recover --id <ws> --request <id>` kills and resumes one session on demand, lane l7: see the `devswarm` entry of the generated reference)), and the store-free `scripts/devswarm.js` verbs (lane l8: `help [<verb>]` and `<verb> --help`, `skip <guard> [--ttl <min>]`, `archive-ignore <id>`, `archive-unignore <id>`, `gate-intent --reason <text>`, `notice --list`, `plan set|show <id>`, `scope add <id>`, `gate <id> --set/--clear` (every gate but `merged`), `workspaces list`, `logs`, `wake-directive <id>` (child workspaces); lane l8b: `ready-check <sha>` (bounded git probes), `app-state [--json]` and `app-sync [--dry-run]` (the engine's app sync; a write needs Node's dry run to name the same markers first, a marker retirement is Node's); lane l8c (`src/meshw/actverbs.rs`, `reportverbs.rs`, `dssup/retention/cli.rs`): `done [<id>] [--summary]` (gate row with the head, plan close and its supervision event, one report to the Primary), `primary` outside the Primary checkout, `relay <seq> --to <id>`, `archive-request <id>` (a target with no descriptor or a fresh heartbeat), `nudge <id>` (the refusal for an unregistered id), `supervision-report [--days n] [--json]`, `sync-ui --titles-json <file>` (the dry run) and `retention status|run` (`run --dry-run`, and `run` on one store only after Node's read-only planner agrees on every row; `restore` and several stores are Node's) - lane l8h (`src/meshw/lifeverbs.rs`): `unarchive <id>` (the restore of the reconcile port's op list under the workspace lock; a registry row at another worktree or an unreadable descriptor is Node's), `migrate-owner-keys` (the ownerKey backfill over active and archived descriptors; the re-home of a descriptor stranded in the hash bucket is Node's), `ensure <id>` and `register <id> --worktree --session` (an idempotent ensure of a descriptor of this project, a new or updated registration in the cwd's project with the registry row and reader declare; every refusal, the re-home, an archived twin, a second registry row of the worktree and a store that does not exist yet are Node's), `correct <id> [--dry-run]` (the correction text from the plan and the stray state, the send through the native send, `warned_*` on the plan and the correction event) and `reap-orphans` (no project, every refusal of the apply path and a project with no orphaned partition; a partition with unread mail and no reader, and any retirement, are Node's); `register-primary` (the Primary's own registration with the child-builder and live-holder refusals), `diagnose` and `healthcheck` (the mesh-health projection with split classification; a project with an orphan partition is Node's) and, through `ah-engine mesh archive <id>`, `archive` (the local archive and the app leg with Node's retry; Node's witness is not run for it); lane dsB (`src/meshw/dsbverbs.rs`, the capability gate and bounded call of `hivecontrol.rs`): `merge [<args>]` (the `hivecontrol workspace check-merge` and `merge-into-source <args>` pass-through with Node's argument vector, working directory and error text, and the mesh broadcast of the outcome; it has no Node witness, which would merge a second time), `reconcile-registry` (one `workspace list all` read and the drift report), `reap-stale [--yes]` and `reconcile-active --active <ids> [--yes]` (the dry runs, and a confirmed run with nothing to archive; archiving is the `archive` verb's app leg, so a run that would archive is Node's), `auto-archive` (the plan when the app database is absent), `spawn <branch>` (the usage and create-option refusals; the create itself - source-freshness fetch, launch poll, title follow-up, wake coverage - is Node's) and `respawn <id>` (the usage refusal and the refusal of a caller outside the Primary checkout); `migrate` stays Node's - the central-log refusals listed under Mesh verbs (lane l8d) are answered and logged by the engine, every other case it cannot prove stays Node's before anything is written; same arguments, same stdout and files as Node, `--json` kept in place, role matrix `devswarm_wire.role_matrix`: `help` open to every role, the others main session only; `mesh.engine_writes` off sends them to Node, on makes the engine answer and defer the cases it cannot reproduce, `notice --post` and unreadable state included; the launcher routes the same verbs to `ah-engine mesh`, and a background Node witness logs a match or mismatch per answered call to `mesh-verify.jsonl`): `status` / `line` print the live workspace state and its statusline segment, `advisory --session <id>` the changes that session has not seen, `archive --id <ws> --request <id>`, `plan-prune --older-than <days>` and `prune --confirm-ids <ids> --plan <nonce>` run the hivecontrol actions at the owner's request with Node's preconditions, ledger and confirmations. Role matrix (`devswarm_wire.role_matrix`): reads are open to every role, the acting verbs are for the main session only (a subagent, a Codex session or a workspace child gets exit 64 before anything is read). `create` and `merge` stay with `scripts/devswarm.js` (exit 75, nothing done). `wake-watch [--auto]` is the idle-wake Monitor (`monitors/monitors.json` runs it through `scripts/ah-run.sh`, the Node watcher as the fallback): the port of `companion/lib/devswarm-wake-watch.js` with the same stdout lines, stderr diagnostics, lock, cursor file and exit codes (`tests/it/wake_watch_parity.rs` compares the two). It runs until the session ends, on the realtime watch layer plus Node's poll tick (`devswarm.wakeWatchPollMs`), roles main session and workspace child (`devswarm_wire.role_matrix`), and answers exit 75 before printing or writing anything when only Node can decide: a Primary with no live child (Node prints its one idle line), a checkout nested in another one, a settings file the engine cannot parse as JavaScript does, or an idle-skip that depends on the supervisor's active-list cache. All its text and numbers are in `wake_watch.toml`. |
| `ah-engine mesh <devswarm.js argv>` | no | D45 stage 2: the same argv as `node scripts/devswarm.js`. `mesh.engine_writes` off (default): Node runs it. shadow: Node runs it, the engine replays it on a copy of the store and logs the comparison to `mesh-shadow.jsonl` in the state directory. on: the engine answers `send`, `mesh read`, `mesh history`, `roster --ack`, `inbox ack-primary`, the plain `heartbeat`, `inbox tick <id>` (line and JSON form), the single-partition `inbox read-primary` and plain `roster` for a project with no rows itself (store write, lock and summary refresh) where it reproduces Node exactly and hands the rest to Node before writing anything; a failure after its own write exits 70 without rerunning Node (exit-code contract and per-verb telemetry: see Mesh verbs below). Off again: `{"mesh":{"engine_writes":"off"}}` in `~/.anti-hall/settings.json`. |
| `ah-engine handovers <index\|check\|search> [query] [--project <dir>] [--registered] [--force] [--limit <n>]` | no | The handover brief tree under `.anti-hall/handovers`: `index` rebuilds the root brief and the per-day briefs (`BRIEF.md` plus a typed `BRIEF.json` sidecar each: session, seq, title, situation, next action, decisions, owner preferences, files, commits, references, previous and next handover of the session, attached PreCompact snapshots) for the days whose files changed, writing only files whose bytes change; `check` lists unindexed or stale handovers, missing briefs, malformed handovers and broken references without writing (exit 3 when any); `search` ranks entries from the sidecars (words must all match; `date:`, `from:`, `to:`, `session:`, `kind:`, `file:`, `commit:`, `decision:`, `pref:` filters). Never edits a handover file and never deletes; the logic is the plugin script `handover-hygiene.js`, every rule and text a `handovers.*` setting. |

### Replacing the Node operator scripts (cutover notes)

These are the notes for the cutover lane; no SKILL.md or script text has been changed yet.

| Node today | Engine command | Notes for the cutover |
|---|---|---|
| `node skills/update/scripts/update.js [--check]` | `ah-engine update [--check]` | Same JSON status line, human summary and exit codes (1 only for the two STOPs). Progress lines on stderr are printed for the stages the engine runs itself (the harness registration). The stages that do real work (the DevSwarm store sweeps, the migrations) still need `update.js` in the pulled plugin tree and `node` on the PATH; without them such a stage reports `attempted: false` and why, and the stages the engine answers itself (closed gate, already done, deferred) need neither. |
| `node hooks/doctor.js [--repair]` | `ah-engine doctor [--repair]` | Ported earlier; see the doctor row above for the flags still on Node. |
| `node scripts/migrate-state.js` | `ah-engine migrate` | Ported earlier. |
| `node scripts/capability-scan.js` | `ah-engine capability-scan` | Ported earlier. |
| `node codex/install-codex.js [--global] [--dry-run]` | `ah-engine install-codex [--global] [--dry-run] [--root <plugin dir>]` | Same output and files. The plugin directory comes from `--root` or the plugin-root variable (Node derives it from its own location). The test-only refusal to write outside a temp dir is not carried over (the engine does not run under `node --test`). |

Shadow: `update --check` and `update` no longer start the Node script, and `install-codex` is engine-only (v1.0 lane L16): the Node `install-codex.js` remains only as the witness of the parity test (`tests/it/update_parity.rs`) until the decommission gate.

**Codex helper scripts as verbs (lane L16).** `ah-engine codex-limit-status` prints `isConserving()` as JSON (the limit-conservation decision of `limit-conserve-inject`: the `limitConserve.mode` setting, else the OMC usage cache with the threshold, reset-aware and snapshot-age rules and the account-switch guard) and `ah-engine codex-activate` writes the advisory `~/.anti-hall/codex-activated.json` marker; they replace `codex/scripts/limit-conserve-status.js` and `write-activation-sentinel.js`. The logic is the plugin script `engine/logic/rules/codex-scripts.js`; the keys are in `codex_scripts.toml` (and the `ctxbudget.*` keys it shares with the hook). `tests/it/codex_scripts_parity.rs` runs the Node script and the verb on identical scratch homes and compares them.

**Codex replay (lane L16).** `ah-engine/parity/codex-replay/codex_replay.py` records a Codex payload corpus (real Codex shell commands, `apply_patch` inputs and `spawn_agent` calls from the local Codex rollouts, read only; the Claude replay sample and the recorded guard goldens mapped to the Codex shape: patch text in `tool_input.command`, `turn_id`, `model`) and replays it two ways: `run node` runs every row of `hooks/ah-fallback.codex.list` as the host does, `run engine` runs `ah-engine hook --host codex` with the Node fallback disabled (a fallback row only records its id). `compare` classifies each call (identical, text-only, stricter, advisory-dropped, WEAKER, deferred) and separates a WEAKER call explained by a recorded engine defer row from an unexplained one; unexplained must be 0. Each side gets its own scratch HOME and sandbox, the DevSwarm variables are removed unless `--keep-devswarm`, and the engine daemon of the run is stopped at the end. The corpus itself stays local (it holds the owner's commands). `edit-guard` now answers a Codex `apply_patch` itself (launcher-directory deny over every Add/Update/Delete/Move path, non-main-thread allow); a main-thread patch and a malformed one still defer to Node. `tests/it/codex_apply_patch_e2e.rs` compares both guards with the Node hooks on identical scratch homes.

Two documented differences from `update.js`: when an update moves the version, Node runs its post-pull stages twice (the old
copy, then the new copy) and prints the second pass, which reports the one-time migrations as already completed; the engine
runs them once and prints that run. And the text of an operating-system error inside a status line (for example a failed
cache copy) is Rust's, not Node's.

## Metrics and the impact ledger

**Metrics** are counters, gauges and latency histograms kept in memory and bounded. Latency percentiles are reported as
the upper bound of the histogram bucket that holds that rank, so they are upper estimates. The registered names are:
`requests`, `busy_replies`, `errors`, `budget_trips`, `panics`, `rejected_peers`, `accept_errors` (accepts that failed with EMFILE and the like, by OS error code), `slow_replies` (replies finished after their client's deadline: slow but healthy), `hook_calls`, `hook_latency_us`, `dispatch_checks`,
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
`{"ts", "verb", "mode", "result", "reason", "ms"}`, with `verb` one of `Send`, `MeshRead` (also `roster --ack`), `MeshHistory`, `InboxAckPrimary`, `Heartbeat`, `InboxTick`, `InboxReadPrimary`, `Roster` and `result`:

| `result` | counts as | `reason` |
|---|---|---|
| `native` | a call the engine answered | empty |
| `defer` | a deferral (Node ran it) | the deferral case, e.g. `receipt-reader`, `cursor-import`, `not-owner`, `lock-busy` |
| `panic` | an engine error before any write (Node ran it) | empty |
| `committed-failure` | an error after the first write (exit 70) | the late deferral, or empty for a panic |

`ms` is the engine's own time for the attempt (it excludes Node's run after a deferral). Per verb: calls = lines, defers = `defer` lines, errors =
`panic` plus `committed-failure` lines, latency = `ms`. For example
`jq -s 'group_by(.verb)[] | {verb: .[0].verb, calls: length, defers: map(select(.result=="defer"))|length, errors: map(select(.result=="panic" or .result=="committed-failure"))|length, p50_ms: (map(.ms)|sort|.[length/2|floor])}' mesh-shadow.jsonl`.
Group `defer` lines by `reason` to see which unported case to port next.

**`heartbeat` (plain form) and the unread union.** `ah-engine mesh heartbeat <id> --session S [--progress N --phase T --wip T --blockers T]`
writes `heartbeats/<id>.json` and refreshes `liveness/<id>.json` to `alive` with `pending`, `notDraining` and `oldestUnreadAgeMs` from the
NDJSON-inbox + store-partition union (`src/meshw/union.rs`: Node's `unionUnread`, deduplicated by `_h`, the legacy line hash and, last, by
body; read bases from the partition's `reader_cursors` floor rows). Besides the heartbeat and verdict files it writes what the call asks for (below). It defers (before
writing anything; nothing is lost) when the call has no `--session` (Node would log the caller process), is
a `primary-<hash>` label, is a child addressing another id (Node warns on stderr), is a Primary checkout whose anchor session Node would
refresh, meets a partition without `#floor` rows (`cursor-import`),
a journal or unmarked store (`journal-backend`, `store-backend`), a store file it cannot open, a cursor file whose `line` is not a scalar,
or an inbox line whose `_h` is not a string, number or boolean, or an app database value it cannot convert like JavaScript (see below), or one of the write-side cases below.
`--step` for a workspace WITHOUT a plan is answered natively (`"plan":{"ok":false,"reason":"no-plan","hint":...}`, exactly Node's text). Telemetry: `Heartbeat` lines; the `reason` of a `defer` line is one of those
names.

**Heartbeat write side: `--summary` and a step plan (`src/meshw/plan.rs`, Node: `devswarm-lib/heartbeat-plan.js`, `companion/lib/devswarm-plan.js`,
`devswarm-supervision-metrics.js`).** `--summary TEXT` appends a heartbeat broadcast row (`is_heartbeat = 1`, sender = the id, urgency `mesh_write.hb_urgency_default`)
to the project's shared store and refreshes the summary projection, in Node's order (heartbeat record, verdict, row, summary, plan), after the ownership check
(the caller is the id, or owns it by its registry row, or by the identity family: cross-linked rows, the row's session, a placeholder). `--step N [--status S]`,
and a `--summary` for a workspace that has a plan, update the plan file read-modify-write under its lock (`<key>.json.lock`, 5 s wait, 30 s stale, dead holder taken over at once),
as an ordered JSON value so every key the supervisor keeps survives in place, and append the supervision events (`step`, `correction-followed`, `respawn-progress`) to
`logs/devswarm-supervision.ndjson`. A busy lock answers `lock-busy` and a bad step `bad-step` (exit 2), exactly as Node. Defers, before any write: a refused or first-claim
ownership (Node drops the summary and writes an attempt record), an archived workspace, no project, a bad `--urgency` (Node logs these through the verb-outcome log), a
plan whose steps are not objects or whose file is not UTF-8, a `respawn` that is an array, a non-ASCII summary for a workspace WITH a plan (JavaScript's UTF-16 slicing
and lowercase tables), a `devswarm.stepStallMin` set anywhere (env, settings, plugin option) when a correction is being matched, and a supervision log past 1 MB (rotation stays
Node's). A failure after the heartbeat record was written (a store another process holds past the busy timeout, a plan write error) exits 70 and Node is never run. The Node
check copies the store with SQLite's online backup (never a link) and compares stdout, the heartbeat, verdict and cache files, the plan, the log lines, the summary projection and the
appended row (without the process-ancestry nonce); `mesh-verify.jsonl` lines carry `diff` and a `detail` window of the first difference.

**The DevSwarm app database reader (`src/meshw/appdb.rs`, Node: `companion/lib/devswarm-app-db.js`).** A heartbeat for a workspace with a
descriptor asks whether the app reports the workspace archived (`builders.isActive = 0 AND isHidden = 1`; without an `isHidden` column, `isActive = 0`;
by id first, else by worktree: an active builder there means not archived, only archived twins mean archived). Archived: the verdict is NOT cleared to `alive`
and the answer carries `"appArchived":true`; the heartbeat record is still written. The reader opens the file read only and never waits for a lock
(`mesh_write.app_busy_timeout_ms`, Node's `node:sqlite` does not either), so a missing, empty, non-SQLite, truncated, exclusively locked or
schema-less database is "no opinion" exactly as in Node, and any read that fails in `builder_terminals`, `pull_requests` or `repositories` makes the whole
snapshot null, as in Node. It keeps Node's cross-invocation cache `<devswarm root>/cache/app-archived.json` (30 s, keyed by the database's mtime, size and `-wal` file's,
integer-like ids come first in the file, as `OVal` serialises them like JavaScript); the cache write happens after the heartbeat record. Defers (before any write): a relative `worktreePath` (resolved against the cwd by
Node), a text or blob value in `id`/`isActive`/`isHidden`/`builderType`/`worktreePath` (JavaScript converts them in ways the engine does not copy), an integer beyond 2^53, a cache
file whose `states` or an entry has the wrong shape. Keys: `mesh_write.app_*`.

**Node stays as a background check.** In `on` mode every answered `heartbeat` is verified: before the engine writes, the parts of the DevSwarm
root a heartbeat touches are copied into a scratch home (the store is linked, read only; the plan and app-cache directories are copied); after it answers, a detached copy of the engine
(`ah-engine mesh --shadow-verify ...`) runs the real `devswarm.js` there with the engine's clock (and the real app database, read only) and compares Node's stdout and the heartbeat,
verdict and app-cache files it wrote with the engine's. Node's write never runs twice on the real home. One line per call goes to `mesh-verify.jsonl` in
the state directory: `{"ts","verb","result","ms"}` with `result` `match`, `mismatch` (plus both outputs, capped, and `sameHeartbeat`/`sameVerdict`/`sameCache`) or `error` (Node could not run);
count mismatches per verb before trusting a port. Keys: `mesh_write.verify_*`.

**`inbox tick <id> [--quiet] [--json]` (`src/meshw/tick.rs`; Node: `cmdInboxTick`, `inboxTickQuietLine`, the `count` it runs).** A tick counts the unread mail of the
workspace (the same NDJSON + store union as the heartbeat, read at the caller's own `reader_cursors` rows when the caller is a declared
reader, else at the floor), refreshes three records and prints one line (`--quiet`), or `count`'s JSON with `action` renamed, `idMismatch` and
`watcherArmed` (no flag, or `--json`). Writes, all best effort as in Node: `wake-tick/<id>.json` (`ts`,
`unreadTotal`, `meshGapWithheld`, `known`, the carried-over `seq`), the heartbeat refresh (`ts`, `state_ts`, `version` of the existing
`heartbeats/<id>.json`, or a minimal `inbox-tick` record) and, when it found unread mail and a wake-watch lock exists, a line of
`cron-found-mail.jsonl` (kept to `mesh_write.cron_found_mail_cap`). The engine answers the steady state only: a descriptor with an inbox and
cursor file, one store partition (a second registry row of the same worktree is a mesh group that Node folds: defers), floor rows in place, a
live wake-watch lock (fresh within `mesh_write.wake_lock_stale_ms`, its pid not provably gone) so `watcherArmed` is `true`, no delivery-log
batch pending, spilled or left in the temp directory, and no trace of the `devswarm.tickRosterEvery` setting. An UNKNOWN count (the inbox or
its cursor file does not read) is answered in the line form: the union is then the store alone, `known` is `false` in the marker and the
line, and the `known:false` warning goes to stderr as Node prints it; the JSON form of an unknown count defers (its cursor and total
fields come from a second read of the broken files). Everything else defers before the first write: `--child` (it first imports the
native queue), an unarmed watcher (the idle, archived and limit skips and the re-arm cue stay in Node), a Primary whose anchor session
Node would refresh, a child addressing another id, a JSON form with more unread store rows than one call returns. Telemetry: `InboxTick`
lines. The background Node check (`mesh-verify.jsonl`) re-runs the real tick on a scratch copy of the DevSwarm root (store linked) with the
engine's clock and reader nonce and compares its output (the scratch home swapped for the real one), its refreshed heartbeat, its wake-tick
marker and its cron-found-mail file with the engine's. One difference from Node: Node opens the
store read-write (and would apply a pending schema migration); the engine opens it read only, so the migration waits for the next Node writer.

**`inbox read-primary <id> [--format text] [--json] [--session S]` (`src/meshw/readprimary.rs`; Node: `inbox-cmd.js`, `inbox-read.js`
`cmdInboxMessagesInner`, `cursors.js` `writeReadReceipt`).** A read that is not read-only: it files a read receipt, named by a fresh random
id (`r` + the clock in base 36 + 12 random hex digits), in `read-receipts/<id>/` and prints the unread rows with the `ackCommand` that applies it.
The engine reproduces the single-partition read: the unread store rows after the caller's read base (its own `reader_cursors` row, else the
floor), merged with the NDJSON inbox lines when the descriptor has one (sorted by `ts`, a row without one last), the forward marker, the instance
digest, `from`/`text`/`kind`/`bodyLength`, the `--format text` rendering, and the receipt record (`ops` own + nd, `hashes`, `reader`, `createdAt`) so that
`inbox ack-primary --receipt` (Node's, or the engine's for the own-partition op) accepts it. The parity test checks stdout, exit code, the store and the
whole home tree with the receipt id made equal, then has Node ack both receipts and compares the cursors again. Defers before the receipt is
written (Node then runs the verb): a flag the engine does not read (`--ack-as-owner`, `--legacy-ack-now`, `--unread`, `--with-broadcasts`,
another `--format`), a missing descriptor, an `unclaimed:` marker the engine cannot take off (no `--session` and no `CLAUDE_CODE_SESSION_ID`, so Node
derives the session from the process tree; a caller that cannot prove it owns the row; a descriptor whose store key differs from the caller's project;
a reconcile sweep's drain), a mesh group (sibling partitions are merged with gap withholding and caps), a caller that does not own the id,
a project mismatch, a store that does not exist yet, a partition without floor rows, a descriptor whose inbox or cursor file does not read, more unread
rows than `mesh_write.inbox_read_limit` (Node truncates per source), a legacy forward whose original hash Node derives, Jev triage that may be
enabled while there is mail to label (Node labels it and records outcome tracking), no stable launcher on disk (the `ackCommand` names the path
Node resolves), and an old receipt in the directory (Node prunes receipts past `mesh_write.receipt_keep_ms` as it writes). Once the receipt
exists nothing defers; if the receipt cannot be written the verb defers with only a directory created. **Lane l8d additions.** `--since` / `--tail` are Node's refusal (`window-flags-unsupported-on-acking-verb`, exit 2): the engine prints it and logs it to
the central log itself. An unclaimed row is promoted natively when the caller's own words prove it (`--session` or `CLAUDE_CODE_SESSION_ID`, and the id
is the caller's identity, cross-linked to its own row, or the sole unclaimed row of its worktree): every deferral of the read is settled first, then
the descriptor (`<id>.json.tmp` renamed over it) and the registry row (`upsertRegistry` with the path-change guard off, then the summary refresh) are
written, one `unclaimed-session-promoted` event goes to the central log, the read is worked out again over the promoted row and the result carries
`promotion: {promoted: true}`. `--ack-after-print` acks the receipt the read files, in the same call, and prints the ack as `autoAck`: the ack's
refusals and the moves the engine does not apply (a receipt op on an NDJSON inbox or a sibling partition, a partition whose legacy cursors still need
Node's import) are settled BEFORE the receipt is filed, so nothing is written for an ack the engine would have to hand to Node; once the receipt exists
a failed cursor write is reported in `autoAck.cursorWriteFailures`, as Node reports it, and the read is never rerun. Telemetry: `InboxReadPrimary` lines. The
background Node check runs the real verb on a scratch copy (a consistent copy of the store, the descriptors' NDJSON inbox and cursor files copied
under the scratch home so a later ack cannot race it) and compares its output and its receipt with both random ids and both homes made equal.

**Plain `roster` (`src/meshw/roster.rs`, `src/meshw/rosterrows.rs`, `src/meshw/hivecontrol.rs`; Node: `cmdRoster`, `rosterHints`, `rosterHumanText`, `hcRun`; lane l8f).**
The engine answers a project's roster with its rows, text table or `--json`, and writes nothing (Node's roster is a pure read: the summary projection, a read-only
app database, no cache write). A row is the store's workspace plus its hints: `worktree-gone`, `idle Nd` (the persisted liveness verdict), `archived` (anti-hall's own
marker or the app database's verdict) and `live session in archived workspace`, `dormant` / `idle (alive)` (the heartbeat, the transcript's modification time and
the descriptor's registration time against `devswarm.dormantMs` or `ANTIHALL_DEVSWARM_IDLE_MS`, and a running session process), `phantom`, `instance-split`
(two live nonces within `devswarm_cli.rr_split_gap_ms`), `done`/`archive-pending`, `app-live`. Archived descriptors of the project become rows; the app database
adds `appArchived`, the title, the `app` object (rank, pinned, focused, finish, brief, builder type) and orders the rows by sidebar rank; `appStillLive` reports
workspaces anti-hall archived that the app still shows; a `primary-<hash>` ghost row folds into its canonical row by alias, tombstone or the app's builder on
its worktree. The texts and numbers are `devswarm_cli.rr_*` in the plugin's defaults.
What stays Node's, decided before anything is printed (exit 75 to the wrapper, nothing written): a row whose session transcript exists (Node reads its tail to say
whether the child waits on a human), a row with a step plan, a native `hivecontrol` child that is not already a store row, a child whose repository id disagrees
with the trusted lookup (Node logs it), the split-brain fallback row, an archive marker a newer occupant of the id superseded (Node logs it), the supervisor's
active-list cache when a row could depend on it, a dormancy window set to zero or below, an id JavaScript would order as an array index, and every odd value the shared
readers defer on. `hivecontrol workspace list children` (and, for a child carrying a repository id, `workspace list all` without `DEVSWARM_REPO_ID`) is one bounded
call (`mesh_write.hivecontrol_timeout_ms`; the child gets a closed stdin; more than `mesh_write.hivecontrol_max_stdout_bytes` of output fails it; a
child that ignores the termination signal is killed after `mesh_write.hivecontrol_kill_grace_ms`, where Node would wait for it for ever); a missing
binary, a spawn error, a timeout, a signal, a non-zero exit, an empty or unparsable answer are all "no children", as in Node's fail-open
`fetchNativeChildren`. In front of the call sits Node's capability
gate: the binary is found as Node finds it (`ANTIHALL_DEVSWARM_HIVECONTROL`, `PATH`, `hivecontrol-path.json`, the DevSwarm app's copy on macOS), its probe is read
from `capabilities.json` (keyed by path, mtime and size), and a missing or stale probe, which makes Node spawn the binary and rewrite the cache with the
clock in it, defers; a build whose `workspace --help` lacks `list` and whose dormant line Node already recorded is refused without a spawn, as Node does.
Telemetry: `Roster` lines; the background Node check compares the output on a scratch copy.

**The central log (lane l8d, `src/meshw/clog.rs`).** The refusals and events Node writes to `~/.anti-hall/logs/devswarm.jsonl` (or `$ANTI_HALL_LOG_DIR`)
are written by the engine with the same line format (`JSON.stringify(entry)`, keys in Node's order), the same file, the same size bound with rotation to
`devswarm.jsonl.1`, and the same rotate lock (`devswarm.jsonl.rotate.lock`, taken over only when stale and not held by a live process; a writer that
cannot get it within the wait budget appends without it). Each entry carries the writer's pid: the engine's own, which is the true writer; the parity tests
and the Node witness blank the timestamp and the pid on both sides (`devswarm_cli.log_masks`). A call under `NODE_TEST_CONTEXT` without a log directory is
Node's (it refuses the real-home fallback). Answered natively because of it: the `--since/--tail` refusal of `inbox read-primary`, the argument and
identity refusals of `send` (no project, `--from` mismatch, target mode, `--question`/`--answers` on a broadcast, message source, empty body, urgency,
sending to oneself) and of `done` (no project, Primary checkout, another workspace's id, no identity).

**Still in Node, on purpose:** `inbox read-primary` and `inbox tick` for a mesh group (the sibling partitions are merged with gap withholding, caps
and a liveness gate on each sibling's ack), `inbox read-primary` when Jev triage may label what it prints, `inbox tick --child`, an unarmed watcher
(idle, archived and limit skips), and every plain `roster` of a project that has a row. In `shadow` mode a verb that can be replayed on a store copy logs
`match`/`mismatch`/`concurrent`/`defer`; `inbox ack-primary`, `heartbeat`, `inbox tick`, `inbox read-primary` and `roster` cannot (they consume or write
files outside the store, or spawn), so Node runs them and the line says `skipped`.

## DevSwarm realtime state (lane B1)

The engine keeps the live state of every DevSwarm workspace in one atomically swapped snapshot (`devswarm_rt`): lifecycle (`active`, `closed`, `archived`, `hidden`, `unknown`), paused, activity (`working`, `stuck`, `waiting_ci`, `done`, `unknown`), unread mail, plan step, last heartbeat and the linked PR. Every field carries its source, the time it was observed and a source signature; an unreadable source gives `unknown`, never a guess, and nothing is ever written back to a source. It is inert (no thread, no read, no write) when DevSwarm is not detected (no app database file and no workspace descriptor) or `devswarm_rt.mode` is `off`.

- **Paused.** No signal is proven yet. A workspace whose open terminals are all `resumable` is reported as `paused?` with that evidence and is never claimed paused until `devswarm_rt.paused_signal` is set to `panel_resumable` after an owner-confirmed crash fixture.
- **Reconcile.** The whole state is re-read at start (differences from the persisted state are flagged `while_down` with a notify hold of `restart_grace_ms`) and every `reconcile_ms`. A change a periodic or overflow reconcile finds is one events missed and counts in `rt_reconcile_repairs`; `rt_edges` counts every change emitted and `rt_shadow_mismatches` every difference from the Node witness.
- **Persistence.** hot.db tables `rt_entity` (latest record per workspace) and `rt_edges` (capped change log).
- **GitHub facts.** PR and CI facts come through the `GithubState` trait when the GitHub realtime feature supplies them; otherwise from the app database's `pull_requests.checkStatus`, whose freshness is its `lastSyncedAt`.
- **Shadow.** The comparison reads the Node witness's scratch-home tree (liveness verdicts, app-state cache), never the live Node files, and appends differences to `rt-shadow.ndjson`.

**Statusline dashboard.** After every reconcile the daemon writes a compact copy of the snapshot (`devswarm-line.json` in the state
directory: per open workspace its activity and when that was observed). The statusline's DevSwarm segment reads only that file, never
the DevSwarm database, and shows the counts by state (`ws ▶2 ⚠1 ⏳1 ✓2 open`: working, stuck, waiting on CI, done but still open). A copy older
than the stale limit, an unreadable app database, or one workspace's activity observed too long ago shows `?` instead of a guess. The
segment is on by default and is advisory only. Settings (`~/.anti-hall/settings.json`, `statusline.devswarm.*`, or the env named in
`devswarm_rt.toml`): `enabled`, `format` (`{parts}`), `max_chars`, `stale_ms`; the part texts, order and colors are `devswarm_rt.line_*`.

## DevSwarm wiring and the Node cutover (lane dswire)

The daemon starts the DevSwarm layer only where DevSwarm exists (the app database or a workspace descriptor) and `devswarm_rt.mode` is not `off`; otherwise no thread, watcher or file is created. One thread (`ah-dswire`) owns the file watcher over the app database directory and its `-wal`, the DevSwarm state directories, each active workspace's mesh store directory, transcript directory and git directory. A change is only a hint: the state is always re-derived from the sources. A watcher overflow is a full reconcile, and the scheduler job `devswarm_reconcile` (`devswarm_rt.reconcile_ms`) is the safety net; what it finds that events missed counts in `rt_reconcile_repairs`.

- **Actions from state.** After a reconcile that found a change of a kind in `devswarm_wire.act_edge_kinds` (or on every periodic and start-up reconcile) the engine runs the three automatic actions under Node's own settings (`devswarm.autoArchive.{mode,idleMin,maxPerSweep,ignorePings}`, `devswarm.nudgeMaxAttempts`, `devswarm.nudgeCooldownSec`): auto-archive of finished workspaces (executor `engine`), and poke / escalate of stale ones (only where their executor is `engine`; the default `auto` follows `devswarm_sup.mode`, see the cutover below). Sweeps are at least `act_min_gap_ms` apart; a change inside the gap is run when the gap has passed. Facts are re-read from the sources right before each action; the one deliberate narrowing is that the idle gate uses Node's pre-0.109 rule (newest heartbeat or transcript time), so the engine can archive later than Node but never earlier. A poke waits one `nudgeCooldownSec` before the next decision about that workspace. Owner actions go through `ah-engine devswarm` under the role matrix.
- **Consumers.** The `devswarm-rt-advisory` hook check (UserPromptSubmit, main thread only, engine-only; its Node fallback is a no-op; its decision is the plugin script `engine/logic/devswarm-rt-advisory.js`, the engine only reads the state and the session marker) tells each session once about the changes since the generation it last saw (`advisory_max_edges`, `advisory_max_chars`; a session's first look starts from now). `ah-engine devswarm line` prints the statusline segment. A change of kind `plan_step`, `activity`, `pr` or `checks`, or a commit or transcript write in a workspace, queues a per-child `jev::sweep::sweep_only` (the slow `jev_sweep` job stays as the safety net).
- **Telemetry.** `dswire_actions` (by kind and outcome), `dswire_standdown` (sweeps skipped because the executor is not the engine), `dswire_advisory`, `dswire_jev_dirty`, `dswire_stall_actions` (pokes and escalations of silent workspaces by kind and outcome), plus `rt_edges` and `rt_reconcile_repairs`.
- **Event-driven auto-archive and the done-but-open nag** (`src/dsact/events.rs`, `nag.rs`; on by default, settings `devswarm.autoArchive.eventTrigger` / `eventDebounceMs`, `devswarm.nag.{enabled,everyMs,hourlyCap}`). A `lifecycle`, `activity` or `pr` edge marks the workspace dirty; once quiet for the debounce the event path runs the same archive as the sweep (gates a-h, ledger key `auto-archive:<id>:<doneHead>`, a re-check against the live app database right before acting, a per-workspace in-flight lock shared with the timer sweep, a bounded call, a check that the app shows it archived). The timer sweep stays as the safety net. The nag tells the Primary once when a workspace is done (`devswarm_act.nag_done_requires`, clean, no unread, past idleMin) and still open, then a digest every `nag.everyMs`, capped per hour; it is silent for archived / closed workspaces and for ids auto-archive owns, and acts on nothing. Telemetry: every attempt is an `act` event (shared schema) and a line in `dsact.events` (feature, action, target, every gate's value, outcome, reason, latency); mistake signals (`unarchived`, `activity-after-archive`, `nag-ignored`) are `mistake` events about the action's key, recorded once. Metrics: `dsx_actions` (feature, outcome), `dsx_mistakes` (feature, signal), `dsx_latency_us`, and the gauges `dsx_auto_archive_success_rate`, `dsx_auto_archive_mistake_rate`, `dsx_nag_success_rate`, `dsx_nag_mistake_rate` (success = ok / (ok + failed); mistake rate = mistakes per ok).
- **Stuck and silent children on events (feature 5).** A workspace's silence clock is the newest of its heartbeat, its transcript and its git directory (`devswarm_rt.stall_sources`, `stall_git_paths`); with `devswarm_rt.stall_require_quiet_sources` at its default 3, activity on any of them resets it. The watcher reads the state again the moment a transcript or git event hits a workspace the state calls stuck, and the moment a working workspace's clock reaches `stall_ms` (`stall_check_min_gap_ms`), instead of waiting for the periodic reconcile. The poke and escalate are unchanged (the descriptor's own commands, `nudgeMaxAttempts` / `nudgeCooldownSec`, keys `poke:<id>:<n>` and `escalate:<id>`), and every condition is read again from its source right before: still active (not archived, hidden or closed), not paused (`paused?` counts), not waiting on CI, still silent on enough sources. Each action is written to the action log and followed up after `stall_followup_wait_ms`: a poke that changed nothing is a `nudge_no_change` mistake, an escalation after which the workspace worked again is `escalation_then_active`.
- **Action log and mistake report.** Every acting feature (`stall`, `merge_ready`) appends to `actions.ndjson` in the state directory: feature, action, target, the value of each decision input, the outcome (`ok`, `refused`, `failed`), the reason and the latency, plus the mistake signals found later and the follow-up results; the shared `act` / `mistake` telemetry events carry the same facts. `ah-engine telemetry actions [feature] [--window <ms>]` reports per feature the action counts by outcome, the success rate (ok of the actions that ran), the mistakes by kind and the mistake rate (distinct mistaken actions of the ok ones); `--mistake <feature> <action> <target> <kind>` records one the engine cannot see, such as an escalation the owner dismissed. Settings: `actions.toml`.

### DevSwarm supervisor cutover: what the kit's go-live must flip

The Node supervisor (`companion/devswarm-supervisor.js`, a launchd / systemd / cron job every 60-120 s) does more than archive, poke and escalate. Lane l7 gave every other duty to the engine's scheduler (job `devswarm_supervisor`, `src/dssup`, settings in `devswarm_sup.toml`), so the Node job can be switched off as a whole; lane l7b then moved the duties that are not store- or model-heavy into Rust. The inventory of what it does and what each duty became is in the lane notes (`SUPERVISOR-DUTIES.md`); in short:

| Duty | Now | Why the rest stays Node |
|---|---|---|
| log rotation, housekeeping (aged reaped logs and child-gate state) | **native** (`dssup::tick`, `dssup::housekeep`), Node's gate, state file, settings and result rows; Node's function runs only as the non-acting witness on a scratch mirror | - |
| `recover` (kill and resume of one session) | **native** (`dssup::kill`): Node's exactly-one-target confirm-gate, the identity re-check before SIGTERM and again before SIGKILL, the recovery log and the liveness verdict byte for byte; Node's read-only `findTarget` is the witness, and the engine stands down when it would signal a process Node does not confirm | - |
| the ingest drain | **native**, see "The ingest drain" below | - |
| liveness sweep: every workspace's verdict file | **native** (`dssup::liveness`): `computeLiveness` + `writeVerdict` byte for byte (heartbeat, transcript, last commit, mailbox union, sticky escalation, nudge window, never-launched). A workspace that is `stale`, has a Jev blocker or a step plan, or whose shape the engine will not reproduce goes to Node's own `sweepOnce` restricted to it (the engine never writes a `stale` verdict, so it can never nominate a workspace Node would not). A read-only Node computation over the live data (its file wrapper serves the old verdict and drops every write) is the witness | suppressors, poke / escalate, the forced parent notice for an urgent mesh unread, straying and the Jev blocker label, and the re-send of parked notices stay Node's (store writes through `notifyParentEscalation`, the Jev assist and the plan supervision) |
| deferred post-update stage | **native** tick (`dssup::deferred`): the rotation cursor, the marker peek and the nothing-pending answer (no Node process on a no-op tick); a stage that has work runs as Node's `runDeferredStage` | the stage bodies are the store folds of `update.js` (fold-all-stores, heal-orphan-partitions, fold-archived-rows, heal-registry-rows), thousands of lines that move user data |
| retention | **native** (`dssup::retention`): the first-run dry-run report (`retention-dry-run.json`, then the flip to `armed`), plan, archive-first tombstoning, space reclaim, the legacy journal fold and the archive-cap eviction, with the state / log files Node writes, under the agreement protocol below | the fold's eligibility (Node's store merge check) is asked of Node's own `foldLegacyJournal` in a dry run each time; the engine folds only the exact files it names |
| app sync | **native** (`dssup::appsync`): one read of the DevSwarm desktop app's database per tick (the snapshot, with its capability gate reduced to table / column / file presence), the archived markers, the names cache, the message-gap cross-check and `app-state.json` byte for byte; no Node process on a quiet tick | the retirement of a stale marker (restored descriptor, revived registry row, hard links under the per-id lock) is executed by Node's own `retireStaleArchivedMarkers`, after the agreement below |
| reconcile sweep | the engine owns the schedule, gate (cool-down state file), sweep lock, bound and record and runs Node's own function in a `node` subprocess, so every shared file stays Node's byte for byte | it orchestrates `devswarm.js reconcile` (per-worktree queue drain into the shared store), the mesh duplicate fold, the `hivecontrol` active-list probe with its repository scoping, the archived cache and start-up sampling: store folds and a subprocess probe, each of which wants its own corpus-and-witness lane; the cool-down (default 15 minutes) already keeps it off most ticks |

**Retention's safety bar.** A wrong write loses a user's message text, so the native sweep holds a stricter bar than "same as Node". Retention never deletes a row: it sets old, fully read message bodies to NULL after archiving them (positions, counts and dedupe depend on every row staying). The engine plans natively; Node's own `planStore` and a dry-run `pruneStore` plan the same store read only; the engine writes only when the two agree on the exact candidate rows, on every partition's statistics and on the counts chosen, and only when a second native plan taken after Node's is identical to the first (the store did not move under the comparison). A disagreement, a witness that cannot run (while `devswarm_sup.retention.requireWitness` is on, the default), or a changed store does NOTHING that run, is logged to the witness log (`match: false`) and is not tried again before `witness_every_ms`. The archive is written with the system `gzip` and each month's member is decompressed and compared with its input before the rows it holds are tombstoned; inside the tombstoning transaction every row is re-checked against the live database (same partition and hash, same position, not an open question, still older than the window when chosen by age, broadcast rows still under every cursor) so the rows tombstoned are always a subset of what Node's own transaction would tombstone. Anything the engine cannot read exactly like Node (a body that is not text, an unreadable table, a missing `gzip`) hands the whole sweep to Node's function, as before. The first-run dry-run report only writes `retention-dry-run.json`, the state's phase and one log line, but because the flip to `armed` is what later permits tombstoning, each store's summary is agreed with Node's planner first (a disagreement hands the sweep to Node). The legacy journal fold and the archive-cap eviction (the one retention step that removes archived text for good, and only when the user set `devswarm.retention.archiveMaxMB`) follow the same rule: the engine lists the files itself, asks Node's own function for the same list in a dry run, and writes or removes only on an exact match (a journal file that changed after it was read is kept; an archive file that changed after the plan was made is not removed). `devswarm_sup.dryRun.retention` plans and compares and logs without writing; `devswarm_sup.dryRun.verdicts` does the same for the liveness sweep. Naming `verdicts`, `deferred` or `retention` in `devswarm_sup.node_duties` hands that duty back to Node.

**App sync's safety bar.** The sync reads the app's database read only and writes four kinds of file. `app-state.json` and the names cache are derived caches. An archived marker (`archived/<id>.json`, the descriptor's own content plus `archivedBy` / `archivedAt`) is created only if it does not exist (written to a temporary file and linked into place, never overwritten, never torn) and never touches the descriptor it copies; it is written only when Node's `markAppArchivedDescriptors`, run as a dry run, names exactly the same workspaces in the same order. A stale marker (written from the app's state, older than ten minutes, whose workspace the app now shows open, never one anti-hall's own `archive` verb wrote) is retired only when Node's `retireStaleArchivedMarkers` dry run names exactly the same ids, and then by Node's own function. A disagreement, or a Node that cannot run, does nothing for that step, logs `match: false` (or `null`) to the witness log under `app_sync-mark` / `app_sync-retire`, and the rest of the sync still runs. Every `witness_every_ms` the engine's whole state document is also compared byte for byte with Node's own dry-run state (`app_sync` line). Anything the engine cannot read exactly like JavaScript (a blob or an integer past 2^53 in the app database, a relative path, a date string V8's parser might read differently, an object key JavaScript would order or treat specially, an id the locale collation might order differently from bytes, a descriptor whose `id` is not a string or number) hands the whole sync to Node's function, and every step is idempotent so a hand-over after a partial pass repeats nothing. `ANTIHALL_INGEST_DRY_RUN=1` computes everything and writes nothing; `devswarm.appSync` switches the sync off; naming `app_sync` in `devswarm_sup.node_duties` hands it back to Node.

An engine poke / escalation writes Node's liveness verdict and recovery log line in Node's exact bytes and sends the same one-time parent notice. `ah-engine devswarm recover --id <ws> --request <id>` is the on-demand kill-and-resume (main session only, never scheduled): the engine refuses an automated caller, an unsafe id, a repeated request, a workspace without a descriptor and one already recovered `maxRecoveries` times, then runs its own confirm-and-kill. Naming a duty in `devswarm_sup.node_duties` (`housekeeping`, `recover`) hands it back to Node's function, the rollback for one duty. The witness (`devswarm_sup.witness`, on by default) re-runs Node's function for a native duty on a scratch mirror (names, sizes and modification times, never contents) at most every `witness_every_ms` and logs one line per comparison to `~/.anti-hall/logs/devswarm-sup-witness.ndjson` (`match: false` is a mismatch).

**The switch** is one setting, `devswarm_sup.mode` (`~/.anti-hall/settings.json`, section `devswarm_sup`): `witness` (default) leaves every duty to the Node job and the engine runs none of them; `engine` makes the scheduler run them and turns the `auto` executor of poke and escalate (their new default) into `engine`. `devswarm_rt."act.<action>.executor"` is `auto | engine | node | off`; auto-archive stays `engine` by default, an unknown word reads as `node`, so a typo makes the engine stand down, never act twice. The engine never edits a settings file or a launchd / systemd unit.

**The double-run guard.** While the Node supervisor's log (`~/.anti-hall/devswarm-supervisor.log` or its `.1`) was written within `devswarm_sup.guard_ms` (default 6 minutes; Node writes one line per sweep), the engine's supervisor duties AND its poke / escalate stand down (`dswire_standdown`), whatever the mode or executor words say. So a go-live done in either order never has two actors; the engine simply waits until the Node job has been quiet.

**Go-live steps** (owner, in this order; each step is safe on its own):

1. `ah-engine devswarm supervisor` - note `mode: witness` and `nodeSupervisorRunning` (the age of Node's last log write in ms).
2. Stop the Node job: `node <plugin>/companion/install-devswarm-supervisor.js --uninstall` (removes the LaunchAgent `com.anti-hall.devswarm-supervisor`, or the systemd user timer, or the cron line). Do NOT set `ANTIHALL_DEVSWARM_SUPERVISOR=off` for this: that variable also switches the DevSwarm hook context off. Leave the ingest daemons (`com.anti-hall.devswarm-ingest.*`) running.
3. Set `{"devswarm_sup": {"mode": "engine"}}` in `~/.anti-hall/settings.json` (the daemon re-reads it; no restart). With the mode `engine` the `auto` executors of poke and escalate are the engine; setting `{"devswarm_rt": {"act.poke.executor": "engine", "act.escalate.executor": "engine"}}` as well is equivalent.
4. Verify after about `guard_ms`: `ah-engine devswarm supervisor` shows `mode: engine`, `nodeSupervisorRunning: null` and the executors `engine`; `ah-engine schedule history devswarm_supervisor` shows runs; `~/.anti-hall/logs/devswarm-supervisor-engine.ndjson` gains a line per tick with each duty's outcome; `~/.anti-hall/devswarm/liveness/*.json` keep being rewritten.
5. Roll back: `{"devswarm_sup": {"mode": "witness"}}` and `node <plugin>/companion/install-devswarm-supervisor.js` again. Auto-archive is independent: its own durable `auto-archived.json` (gate h) stops either side from repeating an archive at one HEAD, and `ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE=off` in a still-running Node job's environment keeps Node from archiving while the engine does.

**Go-live steps for the ingest drain** (after the supervisor steps; each step is safe on its own):

1. `ah-engine devswarm ingest` - note `mode: witness` and the projects (the working directories of the Node daemons' fresh heartbeats, plus `devswarm_ingest.projects`). Check each project's `lock` names the Node daemon.
2. Set `{"devswarm_ingest": {"mode": "engine"}}` in `~/.anti-hall/settings.json`. Nothing changes yet: while a Node daemon holds a project's lock the engine's drain for that project waits (it never takes a live holder's lock), so two consumers never read one destructive queue.
3. Uninstall the Node daemons one project at a time: `cd <project> && node <plugin>/companion/install-devswarm-ingest.js --uninstall` (removes `com.anti-hall.devswarm-ingest.<project key>` or its systemd / cron equivalent; stops the process). The engine takes the lock within `lock_retry_ms` (30 s) of the holder going away, replays any batch the Node daemon left open in the WAL (`wal/monitor-<project key>.ndjson`: same file, same format), and keeps the heartbeat (`heartbeats/ingest-<key>.json`) and the log (`~/.anti-hall/devswarm-ingest.log`) fresh in Node's shape, so `doctor` and the freshness banner read it as before.
4. Verify: `ah-engine devswarm ingest` shows the lock held by the engine's pid; `heartbeats/ingest-<key>.json` has `lastMonitorOkMs` moving; a message sent to a Primary appears in `summaries/<key>.json`. `~/.anti-hall/logs/devswarm-ingest-witness.ndjson` gains a `match: true` line every `witness_every_ms` once a batch with messages was drained.
5. Roll back: `{"devswarm_ingest": {"mode": "witness"}}` (the drain threads end at the next daemon start; the daemon waits at shutdown for a monitor call in flight, so nothing it already took off the queue is lost) and `node <plugin>/companion/install-devswarm-ingest.js` in each project again. Do not leave a Node daemon running while the engine owns a project: it exits at once on the engine's lock and its unit restarts it in a loop.
6. After the Node daemons are gone, `devswarm_ingest.legacy_probe` may be set to 0 (nothing legacy remains to wait for).

**The reconcile port** (`src/dssup/recon`, settings in `devswarm_recon.toml`) moves the state `reconcile` and the sweep tail write from Node to the engine one slice at a time, with the engine always the actor and Node only a witness. A planner reads the live home and returns an op list; the gate mirrors the inputs twice into scratch homes (SQLite stores by the online backup API), runs Node's own function on one mirror with its clock pinned and the engine's op list on the other, compares the normalised post-states byte for byte, and only on equality applies the same list to the real home, unit by unit, under the unit's per-workspace lock after re-checking every precondition. Anything not provably identical (a mismatch, a drifted precondition, a busy lock, an unmodelled state, Node absent) is handed back to Node with nothing written for it. The op vocabulary cannot delete or update a message row (a static test enforces it). Ported so far: the side files (sweep state, resume marker written atomically, name cache, repo-unknown marker, active snapshot with its partial-list floor, start-up sampling) and `healRegistry` / `rehomeMiskeyedRow` / `rehomeCore`; a mis-keyed row (`rehomeAcrossStores`) is still Node's. Slice S5 adds `healOrphanPartitions` (additive only): an orphan partition with a live descriptor and no worktree family is adopted, an orphan with no descriptor or another repository's descriptor is reported unhealable; archived orphans, worktree families (the forward into a survivor) and anything the summary projection cannot reproduce hand the whole store back to Node. It runs from the deferred post-update stage only when `devswarm_sup.sweep_tail_mode` is `engine` (default `node`), store by store before Node's own stage function, which keeps the stage marker. Slice S8 (`recon/stage.rs`) runs the four deferred post-update stages natively when `devswarm_sup.sweep_tail_mode` is `engine`: it walks the stage's pending-store list (`update-sweep-state.json`, written like Node's `recordSweepResult`/`recordRun`, tmp + rename, once at the end of the walk), one stage per supervisor tick within `devswarm_sup.set_sweep_budget_ms`, each store through its witnessed port or, when the engine cannot prove it, Node's own function for that one store in a bounded subprocess.

**The reconcile port** (`src/dssup/recon`, settings in `devswarm_recon.toml`) moves the state `reconcile` and the sweep tail write from Node to the engine one slice at a time, with the engine always the actor and Node only a witness. A planner reads the live home and returns an op list; the gate mirrors the inputs twice into scratch homes (SQLite stores by the online backup API), runs Node's own function on one mirror with its clock pinned and the engine's op list on the other, compares the normalised post-states byte for byte, and only on equality applies the same list to the real home, unit by unit, under the unit's per-workspace lock after re-checking every precondition. Anything not provably identical (a mismatch, a drifted precondition, a busy lock, an unmodelled state, Node absent) is handed back to Node with nothing written for it. The op vocabulary cannot delete or update a message row (a static test enforces it). Ported so far: the side files (sweep state, resume marker written atomically, name cache, repo-unknown marker, active snapshot with its partial-list floor, start-up sampling) and `healRegistry` / `rehomeMiskeyedRow` / `rehomeCore`; a mis-keyed row (`rehomeAcrossStores`) is still Node's. The mesh fold (`foldMeshDuplicates`, `foldGroupIntoSurvivor`, `rekeySubdirRegistryRows`, `retireWorktreeDuplicates`, `retireArchivedWorktreeGroup`, `ghostRegistryRows`, `forwardArchivedOrphanUnread`) runs only when `devswarm_sup.sweep_tail_mode` is `engine` (default `node`): the forward only adds rows, the one removal is the conditional registry delete Node performs, and any group whose survivor, anchor or summary needs liveness or the legacy cursor import goes back to Node whole.

**The reconcile port** (`src/dssup/recon`, settings in `devswarm_recon.toml`) moves the state `reconcile` and the sweep tail write from Node to the engine one slice at a time, with the engine always the actor and Node only a witness. A planner reads the live home and returns an op list; the gate mirrors the inputs twice into scratch homes (SQLite stores by the online backup API), runs Node's own function on one mirror with its clock pinned and the engine's op list on the other, compares the normalised post-states byte for byte, and only on equality applies the same list to the real home, unit by unit, under the unit's per-workspace lock after re-checking every precondition. Anything not provably identical (a mismatch, a drifted precondition, a busy lock, an unmodelled state, Node absent) is handed back to Node with nothing written for it. The op vocabulary cannot delete or update a message row (a static test enforces it). Ported so far: the side files (sweep state, resume marker written atomically, name cache, repo-unknown marker, active snapshot with its partial-list floor, start-up sampling) and `healRegistry` / `rehomeMiskeyedRow` / `rehomeCore`; a mis-keyed row (`rehomeAcrossStores`) is still Node's. **The drain of one workspace** (`recon::pull`, slice S3) reuses the pull `inbox tick --child` runs (`meshw::pull`): under the workspace's pull lock the engine plans the pull (every state it does not reproduce goes to Node before anything is touched), asks the non-destructive count and, for a count above zero, does the ONE destructive read and appends and fsyncs its raw bytes to the delivery log; only then does the witness run (Node's own `inbox pull` on one mirror against a recording hivecontrol that answers `0`, the engine's ensure and log replay on the other, post-states compared byte for byte), and only on equality the same replay is applied to the real home. A crash, a witness mismatch, a Node that cannot run, a shortfall, a date form the engine does not reproduce or a log write that failed leaves the captured batch PENDING in the log and Node's next pull replays it (idempotent by the content hash); the witness never reads the native queue. One deliberate difference from Node's own fresh pull: the closing record of a batch the engine captured itself is written by the replay code, so it also names the workspace it went `into`, and the records of the log are in capture order (new batch before the closing records of the older ones). **`reconcile` and the sweep** (`recon::sweep`, slice S4) port `cmdReconcile` (budget, resume rotation, git-root probe, archived and repository-unknown skips, Node's one retry after a native timeout, names, resume marker, result object), `distinctRepoKeys` and the duty. A project the engine cannot answer as a whole (a descriptor stranded in the legacy bucket, a registry row that must move to another store) and any workspace it does not drain is run by Node's own function; the mesh fold, the active-workspace probe and its cache and the start-up sampling stay Node's (`reconcileSweepIfDue` runs with the engine's results as the reconcile step's answer). The duty is switched by `devswarm_sup.reconcile_mode` (`node`, the default, runs Node's `reconcileSweepIfDue` unchanged; `engine` runs the port, witness-gated) and applies only while `devswarm_sup.mode` is `engine`.

**The ingest drain** (`src/dssup/ingest`, settings in `devswarm_ingest.toml`) is what `companion/devswarm-ingest.js` does, one thread per project, started by the daemon only when `devswarm_ingest.mode` is `engine`:

- *Single consumer.* The project's lock `locks/ingest-project-<repo key>.lock` is Node's file and protocol: a holder whose pid is known to be dead is taken over at once, an unknown holder when stale, **a live holder never**. The engine re-stamps it (and the heartbeat) at least every 30 s so a Node starter keeps respecting it, and stops when it finds the lock taken. While a legacy per-worktree consumer of the same repo (`locks/ingest-<worktree hash>.lock`, found with `git worktree list`) is alive the drain does not start, and it removes no lock file.
- *Loss-free.* `hivecontrol workspace monitor -i 3 -t 30` runs as a bounded subprocess in the project's main worktree with every `DEVSWARM_*` variable scrubbed (a daemon started from inside a workspace must not read that workspace's queue), killed by the engine only at its own hard limit (`-t` plus `hard_margin_ms`) and keeping what it printed before the kill. Every non-empty output is appended to the delivery WAL and fsynced **before** it is parsed (Node's format: a `batch` record, then `done` or `quarantine`); one iteration issues a new destructive read only when nothing is pending in the WAL and the WAL and its spill directory are writable, so a batch the store refuses (partition lock held, partition no longer registered) is replayed first, and a WAL that cannot be written spills the bytes and blocks reads instead of dropping them. Import is `INSERT OR IGNORE` by the `native:` content hash under the partition's lock after a "still registered here" recheck, then the summary is refreshed. A batch of no known shape is closed as `quarantine` (its bytes stay whole in the WAL) and a prefix goes to `quarantine/`, rate-limited, never pruned.
- *Node's breaker.* A missing or non-executable hivecontrol is a configuration fault: the backoff climbs 2 s, 5 s, 30 s, 2 min, 5 min and a line is logged only when the step changes (plus a rollup); a transient failure backs off 2 s x 2^(n-1) up to 5 min. Both ladders are tested against Node's functions.
- *The witness.* The engine mirrors each drained batch's raw bytes and the rows it wrote under `~/.anti-hall/witness/`. Every `witness_every_ms` Node's own `ingestPayload` runs over the mirror in a scratch HOME against an empty scratch store; per batch the message count, the lossy flag and every row's hash, time and body are compared, and every mirrored row is checked in the live store (a loss check). Node never reads the live queue or the live store. One line per comparison goes to `~/.anti-hall/logs/devswarm-ingest-witness.ndjson`.
- *Not ported.* The sweep of other projects' orphaned ingest lock files (the engine's lock takeover already reclaims a dead holder of its own project's lock) and the wedged-holder SIGKILL (the engine never signals a lock holder). A message time whose `Date.parse` form the engine does not reproduce uses the import time and counts in `tsFallbacks`. When the engine cannot derive the summary projection for an exotic store it logs `summary refresh deferred`; the next refresh by any writer updates it.

The Node witness runs non-acting (scratch HOME, recording stub, `devswarm_rt.witness_home`); `rt-shadow.ndjson` and `dsact.shadow` record agreement.

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

### Action and mistake events (one schema for every acting feature)

Every feature that acts emits one `act` event per action and, when a later observation shows the action should not have been
taken, one `mistake` event that points back at it. Both are ordinary telemetry events (identifiers and numbers only; field
names live in `telemetry.fields` in `telemetry.toml`). Emit with `telemetry::emit::act(&ActRec{..})` and
`telemetry::emit::mistake(&ActRec{..})`; any process may call them.

| Concept | Event field | Meaning |
| --- | --- | --- |
| feature | `h` | The feature, a stable lowercase name (`auto-archive`, `poke`, `nag`, ...). |
| action | `e` | The verb the feature performed (`archive`, `poke`, ...). |
| outcome | `o` | `act`: `allow` = ran and verified, `block` = refused, stale or unverifiable, `skip` = not applicable, `error`, `timeout`. `mistake`: always `advise`. |
| latency_ms | `ms` | Wall time of the action in whole milliseconds (`act` only). |
| target | `target` | What it acted on (a workspace id, a PR number); an identifier, never text. |
| inputs | `inputs` | A short digest of the decision inputs (optional). |
| reason | `reason` | `act`: why it was refused or failed (a stable word such as `stale`, `refused`, `in-doubt`). `mistake`: what showed it was wrong (`reopened`, `reverted`, ...). |
| action_id | `action_id` | The idempotency key of the action (cut to `telemetry.token_max_len`). A `mistake` carries the `action_id` of the `act` it refers to. |

The DevSwarm action layer (`dsact`) emits an `act` event for every action it attempts, including refusals, with the ledger
outcome word as the `reason`. `ah-engine devswarm ledger [--json] [--since 7d|36h|<days>]` (every role may run it; switch:
`devswarm_act.audit_enabled`, on) is the one report: per feature the runs, done, failed, refused, success rate
(done / finished), refusals by reason, mistaken actions and mistake rate (distinct mistaken actions / done), p50 and p95
latency; the action ledger (outcomes per kind, keys started and never finished); and the Node witness agreement from
`dsact.shadow`. A mistake whose `action_id` matches no `act` event is counted as `orphanMistakes`. `doctor` shows the same
data as an "Action audit" section when there is any, and warns above `devswarm_act.audit_failure_warn_pct` /
`audit_mistake_warn_pct`, for in-doubt keys and for witness disagreements. It only reads.

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

## Process watch (orphans, stuck agents, resource and disk warnings)

One scheduled job (`procwatch`, `schedule.procwatch_ms`, default 30 s) and one engine-only advisory check
(`procwatch-advisory`: SessionStart, UserPromptSubmit, PreToolUse) that look after the machine a Claude session runs on. All of
it is configuration (`procwatch.toml`, `resource_watch.toml`, `disk_watch.toml`, with settings keys in `/anti-hall:settings`
under Process watch, Resource watch and Disk watch). It is for every user: nothing in it names a project or a path outside the
plugin's own directories. It warns; the only thing that can stop a process is a per-class opt-in, and nothing is ever deleted.

| Part | Does | Default |
|---|---|---|
| Orphan sweep | lists (and, per class, stops) processes an ended Claude session left behind | every class `report` |
| Stuck agents | names background agents of this session with no output for `procwatch.stuckMinutes` (reuses the silent-agent-nudge detection); warn only | 20 min, cooldown 15 min |
| Resource watch | names a process under a live session using >= `resourceWatch.cpuPercent` for `cpuWindowSeconds`, or `memoryMb`; system swap and memory pressure | 90 % for 120 s, 4096 MB, 8192 MB swap |
| Disk watch | free space of the project, HOME and temp volumes against a warn and a critical floor (GB and percent); names the biggest build/cache directories as a suggestion; before heavy commands at critical | warn 20 GB / 10 %, critical 5 GB / 3 %, block off |

**What is an orphan.** Claude Code puts `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` (the session process) into the
environment of everything it starts. A process is a candidate only when it carries the marker, it is reparented (its parent is
init or gone), its owner `CLAUDE_PID` is not a live Claude session command that started before it (a recycled pid counts as
gone), no ancestor is a live session, it matches a class and the class's minimum age, and it is not protected (the live engine
under `~/.anti-hall/ah-engine*`, the plugin's hooks and companions, any Claude plugin cache). A process whose environment the
system will not show is not marked and is never touched. Classes: `dev_server`, `test_runner`, `build_daemon`, `mcp_server`,
`shell_task`, `other` (first match wins); `children = true` classes also list the descendants of a root. The owner's own classes go in
`procwatch-classes.toml` in the engine state directory (example: `plugins/anti-hall/engine/examples/procwatch-dev.toml`).
A kill is polite signal, `procwatch.grace_ms`, a fresh re-read of that one pid (same start time and command), then the forced
signal; one pid at a time, never by pattern, at most `procwatch.max_kills_per_run` a sweep. The MCP class reports what the
SessionEnd MCP reaper (a separate switch) would select, plus more; a test keeps it a superset.

**Telemetry.** Impact kinds `orphan_candidate`, `orphan_kill`, `resource_warning`, `stuck_agent_warning`, `disk_warning` and the
counter `procwatch_events` (labels kind and class). The sweep writes `procwatch-report.json` in the state directory (`cost_ms`, process
count, candidates, kills, recent warnings) which the advisory reads; the sweep's own cost on this Mac is about 50 ms for 990
processes with an orphan scan (release), and the resource-only sweep between scans reads the process table once.

**Crate.** `sysinfo` 0.39.6 (exact pin, released 2026-07-09), feature `system` only: the process table with parent, start time,
CPU, memory and environment, plus swap. It adds `sysinfo`, `objc2-core-foundation` and `objc2-io-kit` to the macOS graph (60 to 63 crates)
and nothing on Linux beyond itself. Disk free space is `libc::statvfs` (no extra crate); the macOS footprint
(`proc_pid_rusage`) and pressure level (`sysctlbyname`) are `libc` calls. `ps` is not parsed anywhere.

**Per-platform differences handled (one interface, `cfg(target_os)` behind it, fixtures for both):**

| Concern | macOS (arm64 and x86_64) | Linux (x86_64 and aarch64) |
|---|---|---|
| CPU % | per-core percent (100 = one core busy, above 100 for threads). The first reading of a process is 0 and is ignored; a warning needs every sample of the window. Apple Silicon: the percent is of one core's time whatever the core kind (performance or efficiency), so the same percent is less work on an efficiency core; the thresholds are per-core percent, not work | same semantics |
| Memory | physical footprint (`proc_pid_rusage`, compressed pages included, matches Activity Monitor); the resident size is the fallback | resident set |
| Swap and pressure | swap from sysinfo; `kern.memorystatus_vm_pressure_level` (1/2/4) | swap from sysinfo; `/proc/pressure/memory` `some avg10` (PSI), absent on kernels without it (then no pressure reading) |
| Environment of another process | `KERN_PROCARGS2`, own user only; system (SIP) binaries show none. No environment means not marked, so never touched. Lineage fallback (parent chain to a `claude` command) is used for the resource watch, where the process is still attached | `/proc/<pid>/environ`, own user (or root), NUL separated |
| Start time and age | seconds since the epoch from the system, no `ps` time formats | same |
| Reparenting | to `launchd` (pid 1) | to init/systemd, or a subreaper; WSL2 init is pid 1 or a relay: "parent is pid 1 or gone" covers both |
| Rosetta | an x86_64 process under Rosetta is listed and sampled like any other | n/a |
| Disk | `statvfs`; several APFS volumes share one container's free space, so volumes are told apart by device id and each is reported with its own path | `statvfs`; tmpfs reports its own limit |
| Signals and nice | `kill`, `setpriority` (its `which` argument is `int` on macOS, `unsigned` on glibc: the libc constant has the right type on each) | same calls |

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
| `procwatch` | process watch: orphans, resource use, report (see Process watch) | 30 s (`schedule.procwatch_ms`) | in the daemon |
| `agent_tick` | one agent-tracker tick (see The agent tracker) | a minute (`schedule.agent_tick_ms`) | a subprocess |

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

## The agent tracker

The engine follows every agent it can find and measures it, so a hung, looping or token-wasting agent is noticed and a quiet one is
reminded. It never kills, stops or edits an agent: it warns and reminds. Everything below is in `agent_tracker.toml`; the three
switches are `agents.tracker` (the whole feature), `agents.reminders` (queue nothing, only record) and `agents.ownerNotify` (default
off: the owner channel).

**What it follows.** Main Claude Code sessions, their subagents and background tasks (the transcripts under `~/.claude/projects`),
agents known only by a heartbeat file (`~/.anti-hall/agents/<id>.json`, the file the Node watchdog reads), and DevSwarm workspaces
(descriptor, plan and wake-watch lock under `~/.anti-hall/devswarm`; inert when that directory does not exist). Where the Claude Code
CLI's `claude agents --json` works it adds the host's own busy / waiting / blocked state and whether the process is gone. That source
is a bounded subprocess, probed once per Claude Code version (the result is cached; the version it was verified on, 2.1.295, is in
the config and shown by `agents status`), and any failure falls back to the transcripts. Human-formatted CLI output is never parsed.

**What it measures.** Per agent, read incrementally from a byte offset: input, output, cache-read and cache-write tokens (a message
repeated on several transcript lines is counted once), tool calls, errors, file edits, commits, passing test runs, plan or task steps
done, the last activity, the declared step, background shell commands and the wake paths armed. Progress units weigh a commit,
a finished step, a passing test run and a file edited for the first time (`agent_tracker.weights`).

**Signals** (thresholds in `agent_tracker.limits`): `hung` (a running turn with no activity: 20 min, 45 min while a tool call is
unanswered), `looping` (the same call 5 times in the last 30, the same file edited 9 times, the same error 4 times), `token_waste`
(600k tokens in 30 minutes with no progress unit; cache reads count 10%), `drift` (under 8% of the declared step's words appear in
the recent edits and commands), `heartbeat_stale` (a running heartbeat older than 20 min), `monitor_unarmed` (background tasks running
and no Monitor, cron or scheduled wake alive; for a DevSwarm workspace the wake-watch lock is missing, older than 2 minutes or its
process gone, which is the same rule `inbox tick` applies to `watcherArmed`).

**Reminders.** A flag must hold two ticks before a reminder. Each signal has a cooldown and a daily cap per agent, a tick has a cap,
and an agent with 3 undelivered reminders gets no more; a held-back reminder is recorded once per cooldown with its reason.
`agent_tracker.routes` says where each goes: to the agent itself, to its coordinator (a subagent's parent session, a workspace's
parent over the mesh, the newest main session for a heartbeat), or to the owner notices file.

**The honest limit.** The engine cannot wake an idle session. A queued reminder reaches a session at its next UserPromptSubmit or
PostToolUse, through the engine-only scripted check `agent-reminders` (plugin JavaScript, `engine/logic/agent-reminders.js`, which
advances a line cursor beside the queue and records the delivery). A DevSwarm workspace is reached through
`agent-tracker/mesh-outbox.ndjson`, the seam the mesh action layer takes nudge rows from. What lets an idle session wake at all is an
armed Monitor, cron or scheduled wake, which is why a missing one is a signal and its reminder carries the exact command.

**Telemetry.** Kind `agent` (schema in `telemetry.fields`; identifiers and numbers only): `series` (a sample per agent every 5 minutes:
tokens, tool calls, progress, flagged), `signal` (raised, with the number it tripped on), `reminder` (queued per channel, or held
back with the reason), `delivery` (a hook put it in front of the agent), `outcome` (`recovered` with the seconds since the reminder,
`false_positive` for a flag that cleared on its own while the agent made progress, `unrecovered` after `outcome_timeout_ms`,
`cleared`). `ah-engine telemetry summary` carries `detail.agent`: signals by name, reminders by channel, held back, recoveries and
the mean recovery time, false positives, and the tokens flagged agents burned. `agents status` prints today's totals from the
tracker's state file. The series is also kept in `agent-tracker/series.ndjson` (cut by age and size). The Node heartbeat watchdog is
the non-acting witness: a unit test runs it on the same heartbeat fixtures and requires the same stale set.

**Limits.** A session closed mid-turn looks hung until the CLI listing reports its process gone. Drift is a word-overlap heuristic
against the declared step (a TodoWrite or TaskUpdate item, or the DevSwarm plan step); it is off for an agent that declares no step. The
Jev Loop / WaitKind / StepMap verdicts of the evidence sweep are not an input yet.

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
- **The evidence gate (owner rule J1).** A model is asked, Jev or Haiku through the cascade, only when the concrete evidence a
  confident answer needs is in the call. For the supervisor integrations `devswarmWaitKind`, `devswarmLoop` and `devswarmStepMap`
  (`src/jev/evidence.rs`, configured per integration in `jev_evidence.toml`; `ah-engine jev evidence` is the entry point a
  supervisor calls with a pack of facts and sections), a decision goes: mode (an `off` integration writes nothing), then
  deterministic **rules** (a done, archived or held child is never asked about; running CI, an unanswered question to the parent,
  a report newer than anything received or a usage-limit pause mean *waiting*; a commit or progress in the last 60 minutes means
  *not looping*; one step in progress with no sequencing word, or a summary that quotes a step's text, *is* the step), then
  **sufficiency** (`required` minimums per integration: wait-kind needs 5 tool calls, 1 assistant text and mesh coverage; loop
  needs 10 tool calls; step-map needs 2 steps, a 15-character summary and an earlier summary that reported a step), then, for
  loop, a **candidate** check (the same command and error three times with no commit, or a revert: the model only confirms it).
  Only then is the labelled pack (`FACTS`, then line-numbered sections such as `[tool_calls.3]`, capped per section and in
  total) asked: wait-kind and loop go to Haiku directly (alias from `jev.judgeModel`, `daily_cap` per integration per UTC day, the
  answer must cite a line that exists or it is discarded), step-map goes through the shared Jev layer and its cascade (`cascade.escalate_below`
  0.8 for it; the cascade stays off until its own switch is turned on). Modes are untouched: nothing here enables an integration, and a
  `shadow` integration's answers are logged but never actionable. Hook-blocking paths never wait on Haiku.
- **The evidence sweep (`jev_sweep`).** The engine gathers the facts the gate needs; Node no longer asks these three questions.
  `src/jev/sweep.rs` runs as the scheduled job `jev_sweep` (every `schedule.jev_sweep_ms`, 15 minutes; a subprocess, so a timeout
  kills any model call it started) or by hand as `ah-engine jev sweep`. For each child with a plan file
  (`~/.anti-hall/devswarm/plans`) and each of the three integrations whose mode is not `off` it reads the plan, the end of the
  child's own transcript (tool calls, texts, errors, usage-limit text), `git log` of its worktree, the CI runs of its branch (the
  GitHub CLI) and the mesh store (what the child sent and was sent), builds the facts and sections, and hands them to the gate,
  which writes the decision row. A question whose subject has not changed is not asked again within `sweep.limits.reask_ms`. The
  sweep acts on an answer only when the integration is `on` and the gate called it actionable (`src/jev/sweep/act.rs`, as Node's
  supervisor did): WaitKind attaches its verdict (`stuck`, or waiting on CI/owner/peer) as a `jev` note to the child's idle and
  stall warnings in `devswarm/stray/<key>.json`; Loop attaches to the burn warning, else the stall warning, and a `looping` answer
  with neither adds Jev's own advisory `loop` warning (counted against `devswarm.strayWarnMax`); StepMap writes `inferred_step`
  into the plan under the plan lock (the plan label shows `~#N` while no step was reported). Loop needs 0.9 confidence. The
  supervisor rewrites the stray state each pass, so the sweep keeps the last acted-on note per subject and puts it back. Each
  effect appends the supervision log events Node wrote (`jev` once per subject, `warn` for the advisory warning). Loop counts the
  same error text repeating on the step as well as repeated commands and reverts. Hold, the stall window and the warning cap are
  read through the settings layer (`devswarm.heldPartitions`, `stepStallMin`, `strayWarnMax`: environment, `settings.json`,
  plugin option, default). The realtime layer's snapshot (archived, paused, the linked PR's CI) is used when the per-child sweep
  has it. Everything tunable is in `jev_sweep.toml`.
- **GitHub realtime (`ghrt`, feature #20).** Independent of DevSwarm: the repos followed are the git repos of the working
  directories of the user's live sessions. The daemon records the `cwd` of every hook it answers (at most once per
  `github_rt.note_every_ms` per directory, in `ghrt/cwds.json` under the engine state directory); the scheduled job `gh_poll`
  (a subprocess, `schedule.gh_poll_ms`, 20 s) drops directories older than `cwd_ttl_ms`, resolves each to its repo root,
  `origin` slug (hosts in `remote.hosts`; any other remote is listed as `not_github` and never asked about) and branch
  (a detached HEAD asks for no pull request, only its commit's checks), and polls what is due. Calls are `gh api -i` with
  `If-None-Match`; the answer is read from the status line, never the exit code (gh 2.102 exits 1 for a 304). Per repo: the
  pull requests of the branch, then (open) the pull request, its reviews and the branch rules that name the required checks,
  then the check runs and workflow runs of the head commit. Cadence by state: `poll_running_ms` while checks run,
  `poll_idle_ms` for an open pull request, `poll_nopr_ms` with none, `poll_done_ms` once merged or closed. A push is noticed
  by stat: the repo's HEAD, branch ref, remote-tracking ref (`refs/remotes/origin/<branch>`) and `packed-refs` (resolved
  through `rev-parse --absolute-git-dir --git-common-dir`, so linked worktrees work); a moved remote ref polls at once and,
  for `push_watch_ms`, a commit with no checks yet reads as running. A local commit alone does not poll. Rate limits: every
  response's `X-Ratelimit-*` is kept; calls in the window are held to `budget_pct` of the limit (the real limit once seen,
  `assumed_limit` before), and below `min_remaining` nothing is called until the reset. A 403/429/5xx waits `Retry-After`
  (capped by `backoff_max_ms`), or `backoff_ms` doubling per repeat; a 403 with `remaining: 0` waits for the reset; any other
  403/404 puts that repo aside for `poll_error_ms` without holding the others. `gh` missing, not logged in or offline are
  states shown by `gh status`, retried after `auth_retry_ms` / `offline_retry_ms`, with no output and no error from the job.
  **Measured, not assumed:** a 304 answered from an ETag does not move `X-Ratelimit-Used` (10 consecutive 304s on
  2026-10-08: used stayed 16; the 200 after them took it to 17), so 304s are not counted in the budget
  (`github_rt.count_304 = 0`); the poller records the `used` delta of every answer by kind (`gh status`, section `measure`) so
  this stays checked on every machine. Edges (CI red or green on a commit, pull request merged or closed, changes requested,
  approved, conflict) are compared against the status of the previous complete poll of the same branch (the first sight is a
  baseline and raises none), deduped by repo, kind and commit or pull request inside `edge_cooldown_ms`, and kept in
  `ghrt/edges.json` (`max_edges`). The rules (how an answer reads as a summary, a repo's status, the edges between two statuses,
  an edge's text, the statusline pieces, the polling cadence) are the plugin script `engine/logic/rules/gh-rt.js`, called through
  `script::call_fn` with the settings it needs; the poller keeps the plumbing. Consumers: `ah-engine gh status|segment`; the engine-only check `gh-rt-advisory`
  (UserPromptSubmit, plugin script `engine/logic/gh-rt-advisory.js`, fallback no-op `hooks/gh-rt-advisory`) tells each session
  about the edges of its own repo once, only for the kinds in `advisory_kinds`, newer than `advisory_max_age_ms`, at most
  `advisory_max_per_prompt` per prompt, with a per-session cursor file; owner notifications are opt-in (`notify_kinds` and
  `notify_argv`, both empty by default; substituted text has shell metacharacters removed). Everything tunable is in
  `github_rt.toml`; `settings.json` section `github_rt` overrides it (e.g. `{"github_rt": {"enabled": false, "budget_pct": 5}}`).
  **Merge readiness (feature 4).** When the pull request of a followed branch becomes ready (open, not a draft, CI green on its head with every required check present, no changes requested, approved when `ready_require_approval`, no conflict, GitHub's `mergeable_state` in `ready_ok_states`, not behind its base when `ready_require_up_to_date`; the rule is `ghReady` in `gh-rt.js`) a `ready` edge is recorded once per head commit (ledger key `ready:<repo>#<number>:<sha>`, `ghrt/ledger.ndjson`) and told to the sessions of the repo when `ready_notify` is on. With `ready_auto_merge` (default ON by owner decision; turn it off with `{"github_rt": {"ready_auto_merge": false}}` in `settings.json` or the engine config file) the engine then re-checks every condition live and runs `ready_merge_argv` (`gh pr merge <n> --repo <slug> --merge --match-head-commit <sha>`, never `--admin`, so branch protection and required reviews still decide; GitHub's refusal is logged as `refused`), once per head commit (key `merge:<repo>#<number>:<sha>`, claimed in the ledger before the command runs). Each notice and merge is in the action log (`ah-engine telemetry actions merge_ready`) with its inputs, outcome and latency, and `ready_followup` checks the merge afterwards: red checks on the merge commit, or a commit that reverts it, are mistake signals (`base_ci_red_after_merge`, `merged_then_reverted`). Without a GitHub remote or `gh` it does nothing.
- **Evidence telemetry.** One row per gate decision in `~/.anti-hall/logs/jev-evidence.ndjson` (emptied past 1 MB): `phase`
  (`rule`, `skipped` or `asked`), `source` (`rule`, `jev`, `haiku`, `none`), `reason` (`insufficient`, `rule-skip`,
  `no-candidate`, `daily-cap`, `bad-evidence-ref`, `low-confidence`, `shadow`, `no-answer`), the `rule`, the `label`, `confidence`,
  `evidenceRef`, `present` (the facts that had a value) and `missing` (the required items below their minimum, as `fact:min`), the
  `child` key the caller gave, and `ms`. Direct Haiku calls also leave the usual `judge-calls.ndjson` row. Never prompt text.
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
| `roles.toml` | the role matrix (which role may run which engine verb), role detection names, the engine skill areas and their size budgets, and the role note texts; the `anti-hall:engine` skills are generated from it and the registry (`ah-engine/scripts/gen-engine-skills.sh`) |
| `broad_kill.toml` | the broad-kill guard: blocked commands, the scoped `pkill -P` form, lookup patterns, wrappers and shells it looks through, and the block texts |
| `devswarm_role.toml` | names, switches and message templates of the `devswarm-child-role` and `devswarm-parent-gate` checks |
| `small_guards.toml` | patterns, switches, limits and messages of the small Bash guard ports and their shared helpers |
| `verify_first.toml` | the verify-first protocol texts (copied byte for byte from `hooks/verify-first-core.js`), the switches and message of the verify-first and fable-availability checks |
| `mcp_reaper.toml` | the session-end MCP sweep: its patterns, init names, age floor, cap, grace period, commands and audit log texts |
| `guards_v1.toml` | the v1.0 guard defers answered in plugin JavaScript (lane L07): the bounded host-spawn limits and interpreter probes of `api-guard`, the hook process stand-ins (`hook_proc.*`), the host key order of the output-verify scan, the Codex `apply_patch` parser and the guards' texts |
| `hardening.toml` | the hardening bar's own limits and wording (`tests/hardening_bar.rs`): what the engine must survive and the budgets it is held to |
| `guards_l12.toml` | the v1.0 main-thread half of `edit-guard` and the pending-marker half of `orch-on-spawn` (lane L12): the delegation, edit-allowlist, handover and unparseable-patch texts, the handover path parts, the DevSwarm descriptor and worktree locations, the inline-work counter's names, and the claim lease, suffixes and token of the spawn-time delivery |
| `units.toml` | the background-service units (`ah-engine units`, lane L08b): the unit names, launchd and systemd file shapes, the service-manager command lines, the ledger and lock files, the report words and the switch `maintenance.unitsHeal` |
| `agent_tracker.toml` | the agent tracker: every threshold, window, weight, route, cooldown, pattern, word, path and text, the Claude Code CLI source and the `agent-reminders` check |
| `host_proc.toml` | the generic process primitives (`ah.proc.*`, `ah.sleep`): the listing, age and service-manager commands and their bounds, the start-time forms, the signal and sleep caps |
| `task_tracker.toml` | the task-tracker directive and reminder texts, window and growth thresholds, the open-tasks line, the Jev label question and the demand-metrics file |
| `realtime.toml` | the realtime watch facility: backend, poll interval, debounce and ceiling, queue and directory caps, the filesystem types that are polled, SQLite side-file suffixes, the mount-table path, and the latency and CPU targets |
| `judge.toml` | the judge calls the engine makes itself: the local Claude CLI client, the speculation-judge prompts and evidence limits, the mesh-triage worker's prompts and budgets, and the Jev-first cascade (thresholds, prompts, telemetry words) |
| `spawn_context.toml` | paths, switches, limits, messages and the orchestration text of the spawn/path context ports |
| `inject_gate.toml` | the injection gate: its settings (`context.injectGate*`), what it recognises in the hooks' output, its state bounds and wire words |
| `ctxbudget.toml` | settings tables, state paths, limits and messages of the context-budget gates (`limit-conserve-inject`, `auto-handover`, `auto-handover-pause-nag`, `compact-advice-guard`) |
| `response_guards.toml` | patterns, switches, limits and messages of the four response-correctness ports (`speculation-guard`, `speculation-judge`, `claim-ledger`, `output-verify-guard`) and their shared helpers |
| `sibling_sweep.toml` | phrases, hedge and tool lists, messages, limits and the follow-through window of the sibling-sweep check; all read at call time through the config layers, so editing a settings file changes the next call |
| `handovers.toml` | layout, patterns, caps, severities, messages and search weights of the handover brief tree, read by `handover-hygiene.js`; a changed rule rebuilds every day brief on the next index run |
| `script.toml` | scripted check logic (D88 spike): the on/off switch, where check scripts and the owner override live, and the per-call time, heap and stack limits of the embedded QuickJS-NG runtime |
| `agent_controls.toml` | patterns, switches, limits and messages of ask-guard, silent-agent-nudge, stale-agent-stop-note and the transcript agent scan they share |
| `codex_handover.toml` | patterns, switches, limits, file names and messages of the handover and Codex hook ports and the JavaScript-behavior helpers they share |
| `devswarm_gates.toml` | switches, role and mode variables and the command pre-filter words of the DevSwarm child gate, reply tracker and drain checks |
| `mesh.toml` | the mesh store reader (D45 S0): store and marker file names, the SQLite busy timeout and page cache, the preview length, the read byte cap and the `--last` bounds; and `mesh.engine_writes` (off, shadow, on), the switch of the stage 2 mesh writers |
| `mesh_write.toml` | the mesh store writers (D45 stage 2, `ah-engine mesh <devswarm.js argv>`): Node's store names and statements' column list, the busy retry, the per-workspace lock budget and steal limits, the identity file and variable names, argv flag names, output texts, and the shadow log, scratch and snapshot settings |
| `devswarm_rt.toml` | DevSwarm realtime state (lane B1): the mode (`on` by default; the Node supervisor is a non-acting witness), stale / stall / reconcile / restart-grace times, the edge-log cap, the paused signal (`none` until an owner-confirmed crash fixture proves it), the app-database column names and the PR and CI status words, and the witness and shadow-log settings |
| `devswarm_act.toml` | the DevSwarm action layer (`src/dsact`, script `engine/logic/act/devswarm-act.js`): which kinds may start automatically (Node's auto-archive, poke, escalate) and which only on the owner's request (archive, create, merge, an approved delete), the allowed hivecontrol verbs with their minimum versions and argv templates, the bounded-call timeouts, the autoArchive / nudge settings (same keys, tiers and defaults as Node), the ledger, plan and log file names, the delete plan's expiry and caller rule, and the error texts |
| `devswarm_sup.toml` | the DevSwarm supervisor duties (lane l7, `src/dssup`): the switch `mode` (witness / engine), the tick and its budget, the double-run guard, the sweep lock, the duty table (native or a Node function run bounded), Node's cool-down settings, the verdict mirror, recover's refusals and texts |
| `devswarm_ingest.toml` | the native ingest drain (lane l7b, `src/dssup/ingest`): the switch `mode` (witness / engine), the projects, the monitor call and its breaker ladders, the lock and the legacy-consumer probe, the delivery WAL, quarantine and heartbeat files, the batch shape and hash, the Node witness and every log line |
| `devswarm_recon.toml` | the native port of DevSwarm `reconcile` and the sweep tail (lane recon, `src/dssup/recon`): the Node witness dispatcher and its limits, the normaliser, the side-file names and thresholds (sweep state, resume marker, name cache, repo-unknown marker, active snapshot floor, start-up sampling), the registry-heal texts, the archived-rows and twin-descriptor texts and file names (slice S7; the switch `devswarm_sup.sweep_tail_mode`, node by default) and every reason a unit is handed back to Node |

| `devswarm_recon.toml` | the native port of DevSwarm `reconcile` and the sweep tail (lane recon, `src/dssup/recon`): the Node witness dispatcher and its limits, the normaliser, the side-file names and thresholds (sweep state, resume marker, name cache, repo-unknown marker, active snapshot floor, start-up sampling), the registry-heal texts, the drain's witness stub and environment, the reconcile budget, retry and result texts, the Node snippets of the handed-back steps and every reason a unit is handed back to Node |
| `devswarm_wire.toml` | the DevSwarm wiring (`src/dswire`): the per-action cutover switches `devswarm_rt.act.<action>.executor`, the thread's wait and sweep gap, which changes trigger sweeps, the git time limit, the watched directories, the advisory / statusline / Jev-dirty settings and texts, the owner verbs and their role matrix, and the fact-reader file names |
| `devswarm_cli.toml` | the DevSwarm CLI verbs ported from `scripts/devswarm.js` that need no store (`src/meshw/simple.rs`): the verb list in dispatch order, the help table (synopsis and side-effect note of every verb), the texts, flag names, limits and paths of `help`, the unknown-command answer, `skip`, `archive-ignore`, `archive-unignore`, `gate-intent`, `notice --list`, `plan`, `scope`, `gate`, `workspaces`, `logs`, `wake-directive`, `ready-check`, `app-state`, `app-sync`, `done`, `primary`, `relay`, `archive-request`, `nudge`, `supervision-report`, `sync-ui` and `retention`, and the Node witness's scratch paths, links and program |
| `command.toml` | every table, pattern and limit of the command check (heavy verbs and patterns, light exceptions, wrapper grammar, cloud CLI grammars, write-scan markers, the defer triggers) |
| `commands.toml` | the command registry data |
| `schedules.toml` | the scheduled jobs (maintain, backup, metrics snapshot, spool drain) and the scheduler settings |
| `telemetry.toml` | the metric and impact-kind registries, the savings method and the telemetry settings (`telemetry.enabled`, `telemetry.flush_ms`, `telemetry.retention_days`, table sizes and window defaults) |
| `storage.toml` | database file names, SQLite durability settings, the writer queue and group-commit window, the in-memory layer, the spool, retention, backups |
| `config.toml` | config layering: file names, watch and debounce timing, boolean tokens, restart-only settings, config messages |
| `transcript.toml` | the transcript index: window and update caps, kept-fact counts, status sets, registry size and idle time |
| `gitcache.toml` | the git cache: git invocations, timeouts, TTLs, signed file names, the bypass environment, messages |
| `jev_sweep.toml` | the evidence sweep: the `jev_sweep` job and interval, where plans/transcripts/mesh stores are read, windows and limits, the transcript, git and CI commands and patterns, the evidence line words |
| `actions.toml` | the action log and its report: file names, rotation, the window, the features and the names of their mistake signals |
| `github_rt.toml` | GitHub realtime: the `gh_poll` job and interval, cadences, rate budget and backoff, which repos, the git and `gh` commands, endpoints, header and pattern names, status words, edge and advisory kinds, notification and statusline settings, the words |
| `jev_evidence.toml` | the evidence gate for the supervisor integrations: per-integration backend, daily cap, pack caps, required evidence, rules and question, the pack headings, the Haiku system prompt, the evidence log and its words |
| `jev.toml` | the Jev lane: vendor endpoints and models, budgets, breaker and fallback timing, the integration table with its default modes, cache and log limits, key-file rules, messages |
| `setup.toml` | the operator helper commands (`jev-setup`, `capability-scan`, `harvest`, `briefing`): the shared limits, the marker grammar and table widths, the briefing's scan limits, the settings lock timing, and the message texts, which are the Node scripts' own |
| `settings_cli.toml`, `operator.toml` | the operator tools `settings`, `defect` and `statusline`: the generated settings registry (`parity/gen-settings-cli.js`), the caps, enums, texts and colors, and the shadow sampling rates |
| `operator_cli.toml` | the verbs `auto-handover-config`, `dispatch-report`, `finding-dedup`, `coordinator-work-baseline`, the `jev-setup` review verbs and `test`, and the native answers of `defect` for the cases that used to defer: every text, name, number and the findings question; the rules are `engine/logic/rules/operator-cli.js` and `rules/coordinator-work-baseline.js` |
| `jev_report.toml` | the `jev-report` command: the report's thresholds (call and label minimums, the KEEP and REMOVE rates), every text of the report (the Node script's own, word for word), the log and cache file names and the credit-balance reasons; the rules that use them are the plugin script `engine/logic/rules/jev-report.js` |
| `wake_watch.toml` | the idle-wake Monitor `devswarm wake-watch`: its settings entries, tick and error back-off, lock timing, file names, the closed vocabulary of refusals and every event and diagnostic line (the Node watcher's own, word for word) |
| `slcfg.toml` | the status line helper commands `phase`, `install-statusline` and `uninstall-statusline`: their message texts (the Node scripts' own), file names, test-guard markers and the installer shadow's copy lists |
| `update_cli.toml` | the `update` and `install-codex` commands: marketplace, cache and registry paths, git and harness arguments and timeouts, the offline-failure patterns, every status and summary text, the Codex file names and the merge patterns |
| `update_post.toml` | the post-pull stages of `update`: the stage table (order, status key, plugin files needed, DevSwarm gate, one-time markers, the answers for a closed gate, a stage already done for the version and a deferred stage), the Node stage subprocess snippets and the status key order |
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

## Scripted check logic and the host API (D88)

A check whose decision logic is a rule, a pattern or a text does not live in the binary. It ships as an editable plugin script
(`engine/logic/<check>.js`, helpers in `engine/logic/lib/*.js`, owner override `~/.anti-hall/logic/`, a file of the same name
wins) and runs in an embedded QuickJS-NG interpreter, one runtime per worker thread. The engine keeps only the generic,
bounded primitives a script calls through `ah.*` (the raw functions are `ahHost`, shaped by `lib/00-ah.js`). Patterns, limits,
tables and texts are `defaults/*.toml` entries the script reads with `ah.cfg(key)`; a file edit, a plugin update or an owner
override applies on the next call. A script that cannot answer (an exception, a stack overflow, the time or heap limit, a
missing file) follows one rule: a check with a Node twin defers to it, an engine-only check blocks on a guard event and allows
quietly elsewhere. Time a primitive spends blocked (a child process, a lock wait, a Jev consult) is not script time.

Checks that decide in a script today: `api-guard`, `inbox-read-guard`, `orch-on-spawn`, `verify-first-subagent`,
`verify-first-full`, `fable-availability`, `edit-guard`, `git` (the git guard), `git-audit` (its PostToolUse audit, built on `git.js` through `script.includes`), `swarm-guard`, `sibling-sweep`, `handover-hygiene`, `task-lifecycle-log`, the three session gates (`jev-weekly-scorecard`, `jev-review-reminder`, `repair-on-reload`), `merge-side-pick`, `scan-throttle`, `merge-gate`, `dispatch-tier`, `model-routing`, `speculation-guard`, `speculation-judge` (every path that needs no model; a reply that needs the model defers to the Node hook), `silent-agent-nudge`, `task-guard`, `tasklist-guard`, `ask-guard`, `phase-tracker`, `failure-root-cause-nudge`, `output-verify-guard`, the six session-maintenance checks (`version-alert`, `devswarm-version`, `claude-cli-version`, `repo-self-drift`, `defect-nudge`, `progress-prune`), `emit-dedupe-reset`, `precompact-snapshot`, `handover-resume`, `limit-conserve-inject`, `auto-handover`, `command` (command-guard: the heavy-command gate, its carve-outs, the Bash edit parity and the DevSwarm and stash guards; its script is also the shared command classifier `classifyBashWork`) and `coordinator-work-guard` (the main-thread work window, built on `command.js` through `script.includes`; it classifies natively and keeps the window, metrics and trips files in the bytes and with the lock protocol the Node hook uses). `command.js` runs the Node functions of `hooks/command-guard.js` as they are, over a small compatibility layer (`fs`, `path`, `os`, `process`, `require`) that answers their file-system, path and settings questions from the primitives below; what only the Node hook process can see (its own working directory, a home it has to ask the system for) marks the call `unsure` and defers. Each has a
`verify-first-full`, `fable-availability`, `edit-guard`, `git` (the git guard), `git-audit` (its PostToolUse audit, built on `git.js` through `script.includes`), `swarm-guard`, `sibling-sweep`, `ask-guard`, `phase-tracker`, `failure-root-cause-nudge`, `output-verify-guard`, the six session-maintenance checks (`version-alert`, `devswarm-version`, `claude-cli-version`, `repo-self-drift`, `defect-nudge`, `progress-prune`), `emit-dedupe-reset`, `precompact-snapshot`, `handover-resume`, `limit-conserve-inject`, `auto-handover`, `dispatch-tier`, `model-routing`, `speculation-guard`, `speculation-judge` (every path that needs no model; a reply that needs the model defers to the Node hook), `silent-agent-nudge`, `task-guard`, `tasklist-guard`, `stale-agent-stop-note`, `claim-ledger`, `idle-agent-sweep`, `auto-handover-pause-nag`, `compact-advice-guard` and `session-end-mcp-reaper`. Each has a
golden corpus (`tests/golden/<check>.jsonl`, frozen from its compiled port before the port was removed) that the script must
reproduce byte for byte, and `parity/run-golden.js` replays the same corpus against the Node hook. A case may place events relative to the moment it is replayed (`{NOW-<ms>}`, `{ISO-<ms>}`, `{DATE}` in any string) and set `normTs` so clock readings, instants and calendar days in the answers and the watched files compare as `{TS}`, `{ISO}` and `{DATE}`; `"node": false` marks a case the Node hook cannot be given (a plugin root it resolves itself).

The host API (every primitive is read-only except the scoped writes, bounded, and returns `null` instead of throwing for an
ordinary failure):

| `ah.` call | What it does | Bounds |
|---|---|---|
| `cfg(key)`, `cfgNum(key)`, `cfgLive(key)` | a shipped defaults entry; a numeric one with its clamps; the value through the owner's editable layers (`settings.json`, `config.toml`, shipped) | `cfgLive` is cached per file stamp and defaults generation |
| `env.get(name)`, `env.passwdHome()` | a variable of the hook's own environment (never the daemon's) | |
| `settings.bool/enum/num/numStrict/str(key)`, `settings.skipped(guard)` | the effective value of a setting entry through the settings chain (`numStrict` drops a value below the entry's minimum, as the Node `settings.get` does; `str` is a free-text setting); an unexpired skip | |
| `settings.bool/enum/str/num(key)`, `settings.skipped(guard)` | the effective value of a setting entry through the settings chain (`str`: the first non-empty tier, trimmed); an unexpired skip | |
| `fs.isFile/isDir/size/readText/realpath/realpathEx` | file tests and reads (`realpathEx` tells a missing path from one that could not be examined) | reads capped by `script.read_max_bytes` |
| `fs.lstat(path)`, `fs.kind(path)`, `fs.mtimeMs(path)` | `{kind: file / dir / link / other, size, mtimeMs, mode, nlink}` of the path itself (links not followed), `null` when absent, `{kind: "error", code}` when it exists but cannot be examined; the kind alone; the modification time | |
| `fs.sha256File(path)`, `fs.readHeadHex(path, n)`, `uid()` | SHA-256 (hex) of a regular file; its first bytes as hex; the numeric user id | `script.read_max_bytes` |
| `fs.readdir(path)`, `fs.listDir(path)`, `fs.readlink(path)`, `fs.readTail(path, window)` | sorted entry names (`readdir` is capped, `listDir` is not and sorts by bytes); a link's target text; the last `window` bytes as text with the partial first line dropped | `script.readdir_max` entries, else `null`; `script.read_max_bytes` |
| `path.*`, `re.test/find/findAll` | Node `path` functions; linear-time regular expressions (flags `i`, `m`, `r`) | `script.regex_cache_max` compiled patterns per thread |
| `exec(prog, args, {cwd, env, timeoutMs})` | one allow-listed program (`script.exec_programs`, today `git`) in its own process group with the request's environment plus `env` on top, no stdin | `script.exec_timeout_max_ms`, `script.exec_max_calls` per call, `script.exec_output_max_bytes` per stream; `null` on a timeout or a start failure |
| `state.writeAtomic/appendFile/op(root, op, rel, text)` | the scoped writes: `rel` is relative to the home directory (or an absolute `root` named by `op`) and must start with `script.write_root`; `op` is `write`, `after_reply` (atomic, landing only once the reply was delivered), `append`, `mkdir`, `remove` or `rename` (the new path is the text) | no absolute path, no `..`, no link below the root, `script.write_max_bytes`, `script.write_path_max` |
| `state.readText(rel)`, `state.remove(rel)`, `state.sweep(dirRel, prefix, ageMs, max)` | the scoped read; delete one regular file (an absent file is the goal state; a link or directory is refused or left); delete the old regular files of a state sub-directory whose name starts with a non-empty prefix, oldest first | reads capped by `script.read_max_bytes`; `script.sweep_max_remove` deletions per call |
| `state.lock(rel, group, waitMs)`, `state.unlock(handle)` | the cross-process lock file (Node's lock protocol) under the same root, timings from the defaults group `<group>.lock_*` (`waitMs` replaces the group's wait) | `script.lock_max_held` locks at once, taken in the script's fixed order; any still held when the call ends is released by the engine, newest first |
| `state.prune(prefix, keep)`, `sessionState.get/probe/update(ns, key, fn)` | the state-file retention sweep of one writer prefix; the per-session state files the Node guards share, with an atomic locked read-modify-write | only that prefix, older than the TTL, throttled |
| `transcript.tailLines/agents/turnText` | the last lines of a file with byte offsets; the agents a transcript shows as running (id, description, launch input, launch / resume / last-seen times, output file); the current turn's assistant text | `script.tail_max_bytes`; a line JavaScript might read differently answers `unsure` |
| `transcript.tasks(path, variant, window, wide)` | the task list of a transcript tail, rebuilt as the Node hooks rebuild it (`guard`: task-guard, `state`: task-state, `scan`: the task part of tasklist-guard's pass), completed from before the window by the bounded subject backfill | the window you pass; where Node's wall clock would decide, or a record only JavaScript reads exactly, the answer is `unsure` |
| `transcript.agentScan(path, tailBytes, ignoreStops)` | every agent a transcript tail shows launched, adopted or live as a teammate, in launch order, with the ids whose terminal evidence stands and the teammates sent a message they have not reported on since (`pending`: name, agent id, send time, last report, last sign of life, live); `ignoreStops` skips a `TaskStop` with no result yet | `unsure` for a relative path or a line JavaScript might read differently; `null` when unreadable |
| `transcript.grep(path, bytes, needles, re, flags)` | the lines of the last `bytes` of a transcript (a cut first line dropped, lines split on `\n` alone) that contain every string of `needles` and, when `re` is given, match it: `{lines}`, `null` (unreadable) or `{unsure}` (a relative path, or more lines than `script.grep_max_bytes`). The script filters megabytes natively and reads only the few lines that matter |
| `transcript.countProof(path)` | the running agents with what the count rests on: `{rows: [{id, description}] \| null, seen: [launched ids], windowBytes}` (`rows` null: the count cannot be trusted, and `seen` and `windowBytes` say why), or `{unsure}` |
| `jev.cachePeek(hash)` | what the dispatch-tier annotation reads of the shared Jev cache entry under `hash`: `null` (none), `{unsure}` or `{answer, confidence}` (each null when the entry holds no string or finite number) |
| `transcript.evidence(path, windowBytes)` | the text evidence of the end of a transcript, record by record, in order: user prompts (`p`), tool results (`r`), hook attachments (`a`), tool-call inputs (`i`) and the non-blank assistant text with its message id (`t`), each as the plain string the Node hook builds | `transcript.evidence_max_bytes` window, `transcript.evidence_max_chars` of text in all; `unsure` for a relative path or a line JavaScript might read differently; `null` when unreadable |
| `re.numbers(src, flags, text, strip)` | the distinct finite numbers the matches of a regex spell in `text` (the characters of `strip` removed from each match first), sorted ascending, from one native pass | the text the script passes |
| `transcript.teammates(path, tailBytes)`, `transcript.codexAgents(path, tailBytes)` | the named in-process teammates (Claude) or `multi_agent_v1` agents (Codex rollout) the tail shows finished but never stopped or closed, with the time each went idle | `script.tail_max_bytes`; `unsure` as above |
| `proc.list()` | the process table `{rows: [{pid, ppid, cmd}]}` (the configured `ps` command); `null` when the listing failed, timed out, was cut or was too big, never an empty table for a listing that did not arrive | `hostproc.list_timeout_ms`, `hostproc.list_max_bytes` |
| `proc.ages(pids)`, `proc.managed(pids)` | `{ages: {pid: seconds}}` (elapsed seconds, else the start time read in local time; an unknown age is left out) and `{platform, managed: [pids], unverifiable}` (the pids the platform's service manager owns: the `launchctl` listing on macOS, the control-group file on Linux; `unverifiable` when the listing failed); both `{unsure: true}` for an output too big, a start time in a form the engine does not read, an ambiguous local time or a zone the engine and the hook might read differently | `hostproc.probe_timeout_ms`, `hostproc.probe_max_bytes` |
| `proc.signal(pid, forced)` | send the polite or the forced signal to ONE pid the script names after its own checks; `true` when sent. Refused (`false`, nothing sent) for a pid below `hostproc.min_signal_pid`, not an integer that fits the system call, the engine's own process or its parent, a pid the script's own `proc.list()` in this call did not show, a forced signal for a pid not first signalled politely in this call | `hostproc.signal_max_per_call` signals per call |
| `sleep(ms)` | wait; the wait is not script time | `hostproc.sleep_max_ms` at a time, `hostproc.sleep_total_max_ms` in a call |
| `jev.ask(spec)`, `jev.mode(id)`, `jev.deadlineLeftMs()` | one question to the Jev lane, detached or (with `sync`) answered, with its trust, cache key, judge label, `compare` verdict and project; with `relax` Node's `consultRelax` (asked here only while the integration is `on`, else detached and `null`); with `full` the whole decision `{outcome, jev, baseline, confidence, confident, ms, backend, reason, hash, changed}`; the mode of an integration; the time left of the request | the budget is clamped to the time left (`jev.relax_sync_cap_ms` for `relax`); time spent waiting is not script time; the caller owns the policy (count, total time) |
| `jev.recordOutcome(id, hash, outcome, source, projectFrom)`, `jev.cacheHas(hash)` | a decision-log row joining a later observed result to the decision with that hash; whether the shared answer cache holds an answer under a hash (`null`: a file only JavaScript reads) | no row for an empty id, hash or outcome |
| `homeGuard()`, `project.root(cwd)`, `jev.enabled()` | `{status: ok / guarded / unknown, home}`: the home directory state files may live under (guarded: a test run against the real home, so no state is read or written); the project root of an absolute working directory as the handover finder resolves it (`null` when it depends on Node's own directory, git or a `core.worktree` setting); whether the Jev master switch is on | |
| `plugin.versions(root)`, `sys.cores()` | `{running, registered, unsure}`: the version of the plugin manifest under `root` and the one the host's registry names; the CPU count as Node's `availableParallelism()` reads it (`null` when the engine cannot read it the same way) | |
| `clock.now()`, `clock.local(ms)`, `home()`, `pid()` | the engine's one clock (injectable for tests); the local calendar fields and zone offset of an instant; the request's home directory; the engine's process id | |
| `sys.memory()`, `platform()`, `repo.context(dir, ancestor)`, `scrub(text)`, `sha1(text)`, `fnv(text)`, `contentHash(parts)`, `log(kind, text)` | machine memory figures; the operating system; the checkout around a directory (`ancestor`: the Node `missingPath: 'ancestor'` option, default on); the engine's outbound secret scrubber; hashes (SHA-1, 64-bit FNV, the Jev content hash); a line in the event log | |
| `settings.get(key, dflt, root)`, `text.maskQuoted(text)`, `shell.heredocAt(cmd, i)` | the settings chain with the caller's fallback; the speculation guard's quoted-text masking; the heredoc opener parser | |

A script that is not a check at all is a rule set: `engine/logic/rules/<name>.js` defines global functions that engine code calls with
`script::call_fn("rules/<name>", "<function>", <json>)` and reads back as JSON (today `rules/gh-rt`, the GitHub realtime rules). The same
bounds apply (time, heap, the `ah.*` API); a call that fails gives no answer, and the caller decides what that means.

A script answers `null`, `'allow'`, `'defer'`, `{block: text}`, `{advisory: text}`, `{exact: {code, out, err}}`, or, for a routing check,
`{routed: {verdict, meta: [{requested_model, parent_model, task_class, recommended_tier, selected_model, outcome, spawn_key, delegate,
blocked}]}}`: the same verdict plus the route telemetry rows the daemon records before it handles the verdict. A shape of the wrong
kind, or a route row missing a field, is a script failure.

A scripted check's latency is held to `script.p95_budget_us` (or its entry in `script.p95_budget_by_check`) at the 95th percentile
(`cargo test --release --test script_latency -- --nocapture`). A check whose call legitimately takes longer than `script.time_limit_ms` (command-guard resolves repositories and runs `git`) has its own limit in `script.time_limit_by_check`.

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
dispatcher logs `dispatch_context_over_cap`. On an event that cannot block it then spills natively
(`dispatch.spill_over_cap`, on by default): the contexts that fit stay inline whole and in hook order, the rest is written
to a private file under `dispatch.spill_dir` in the state directory, and a last pointer line (`dispatch.msg_spill_pointer`)
names it, so nothing is cut and no Node hook runs; the spill is logged (`dispatch_context_spilled`) and counted in telemetry
as a `spill` event. It applies only when the join is exactly the hooks' contexts joined by `dispatch.context_joiner` and the
file can be written; otherwise (and with the spill off) the dispatcher prints a message on stderr and exits
`dispatch.defer_exit` (75), asking its wrapper to run the Node hooks one by one as the host does, or, with
`dispatch.defer_to_node` 0, delivers the join for the host to spill. Only a plain answer (exit 0, no JSON block) is handed
back, so a block or a decision is never lost to it. On a guard event it never exits 75: it delivers the merged answer, and
the host spills the over-cap context itself. **No Node (`dispatch.defer_to_node` 0).** The infrastructure, spent-budget and
panic paths that otherwise exit 75 answer by themselves: an event that cannot block skips its hooks (logged as
`dispatch_no_node_skipped`, one stderr line), a guard event follows `dispatch.failure_mode` for the path (`budget` and
`infra` closed, `panic` open by default; `dispatch_no_node_closed` / `dispatch_no_node_open`). Each answer is counted in
telemetry as the hook `dispatcher-<path>`. When one entry blocks, the advisories of the others are not shown; when several block, the
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
