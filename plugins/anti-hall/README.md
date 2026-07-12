# anti-hall

> A Claude Code plugin that enforces verify-first discipline and ships the workflow
> skills that go with it.

It fights four failure modes common to coding assistants:

1. **Eagerness** — answering or acting before investigating.
2. **Hallucination** — stating unverified facts (file contents, API behavior, values) as truth.
3. **Fix-before-diagnosis** — proposing fixes before proving the root cause.
4. **Fake completion** — claiming work is done, fixed, or passing without running the check.

## Quickstart

```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```

The hooks apply globally once enabled. The statusline is a separate one-command
install (see [Statusline](#statusline-opt-in-one-command)).

To try it without installing, load it into a throwaway session from a local clone:

```bash
claude --plugin-dir /path/to/anti-hall
```

## Requirements

> **Node.js >= 18 on `PATH` is the one hard prerequisite.** Every hook and the
> statusline are pure Node.js (built-ins only) and are launched as
> `node "<plugin>/hooks/<name>.js"`. Claude Code does NOT guarantee a user-installed
> `node` on the hook shell's `PATH`, and this plugin does not bundle one. If `node`
> is unreachable by the hook shell, Claude Code **silently skips every anti-hall
> hook** — the git-guard force-push/self-credit block and the verify-first/task
> injections are simply OFF, with nothing surfaced. There is intentionally **no
> shell-based preflight**: a `.sh` detector cannot run on a stock Windows shell
> (cmd.exe / PowerShell have no `sh` on `PATH`) — the exact bare-machine case it
> would target — so it would never reach the operators who need it. Install Node
> from <https://nodejs.org> and verify with `node --version` before relying on the
> protections.

## Features

| Component | Event | Purpose |
|---|---|---|
| `verify-first-full.js` | SessionStart | Full Iron-Law + rationalization-table protocol, the always-on orchestration and **scope & fidelity** disciplines (simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish what was asked / drop nothing), and the always-vs-conditional skill primer; survives compaction. |
| `verify-first-subagent.js` | SubagentStart | Re-injects the Iron Law + rationalization table + positive rules + scope-fidelity into each spawned subagent. Deliberately omits the orchestration/delegate block (subagents are workers; re-injecting it would recreate deep nesting). Shared core extracted to `verify-first-core.js`. |
| `verify-first-core.js` | Shared module (not a hook) | Single source of truth for the Iron Law content shared by `verify-first-full.js` and `verify-first-subagent.js` — prevents drift between the two hooks. |
| `verify-first.js` | UserPromptSubmit | Short, varying one-line nudge each turn (anti-habituation). |
| `git-guard.js` | PreToolUse (Bash) | Blocks AI self-credit attribution — in `git commit` trailers AND in `gh pr/issue/release create\|edit\|comment` `--body`/`--title` (the 🤖 footer, Co-Authored-By, claude.com/claude-code link) — plus `git push --force`. Inline values only (`--body-file` is fail-open). |
| `api-guard.js` | PreToolUse (Write/Edit/MultiEdit) | Blocks code that references a **non-existent** stdlib/builtin API — resolves `module.attr` in the code-to-be-written against the installed `python3`/`node` and refuses the write when the attribute is fabricated. The mechanical answer to API hallucination. Default = stdlib/builtins (import-safe); opt-in `ANTIHALL_API_GUARD_THIRDPARTY=1` also checks installed 3rd-party packages (off by default — verifying a package imports it, running its code at edit time). 0 FP + full in-scope catch on `eval/api-guard-bench.js`; never probes local/relative modules; fail-open; skip-hatch. |
| `command-guard.js` | PreToolUse (Bash) | Keeps the coordinator clean — blocks heavy commands inline, pushes them to subagents. Subagent-aware via payload, per-segment (quote-aware). Under a DevSwarm-active session it also redirects destructive native `hivecontrol` inbox reads (all contexts, own skip `devswarm-read-guard`): `hivecontrol workspace monitor` blocks unconditionally, `read-messages` blocks only with durable-inbox evidence (`ANTIHALL_DEVSWARM_INBOX_CMD` or a workspace descriptor `inboxPath`); quoted DATA mentions are not false-positives. |
| `edit-guard.js` | PreToolUse (Write/Edit/MultiEdit/NotebookEdit) | Blocks a COORDINATOR from editing files directly — requires delegating the edit to a subagent (always allowed; DevSwarm-aware block wording when the liveness supervisor is active, topology-aware: "primary/main orchestrator" vs "sub-orchestrator"). Root-anchored allowlist (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`, `.claude/**`, `.omc/**`, `.anti-hall/**`, root `PLAN.md`/`STATE.json`), extensible via `ANTIHALL_EDIT_GUARD_ALLOW`. Skip-guard hatch: `edit-guard` (not in the destructive set). Fail-open. |
| `coordinator-detect.js` | Shared module (not a hook) | The single coordinator-vs-subagent discriminator, extracted from `command-guard.js` so `edit-guard.js` (and `graphify-guard.js`) reuse the exact same detection logic instead of duplicating it. |
| `model-routing-guard.js` | PreToolUse (Agent/Task) | Anti-waste routing — classifies spawn descriptions (mechanical vs complex) and blocks/advises toward the cheapest fitting model. Strict by default (v0.35.0+): unconditional block on omitted-model mechanical spawns. Set `ANTIHALL_MODEL_ROUTING=advisory` (**project-scoped env**) to opt out and revert to advisory-only. Debate role-words in spawn description downgrade row-1 block to advisory. Fail-open; unknown model tokens always allowed. |
| `omc-detect.js` | Shared helper (not a hook) | Detects whether an oh-my-claudecode autonomous loop is active + fresh. Consumed by `task-guard` / `tasklist-guard` to suppress Stop-blocks to advisory when an OMC loop is running, preventing deadlock. Fail-open = NOT deferring. Kill-switches: `DISABLE_OMC=1` or `OMC_SKIP_HOOKS` including `persistent-mode`. |
| `hooks/lib/devswarm-detect.js` | Shared helper (not a hook) | **OPTIONAL, feature-gated** — mirrors `omc-detect.js` for the opt-in DevSwarm liveness supervisor: reports whether it should be considered active for this session/environment. Dormant (zero effect, byte-for-byte identical to today) unless `DEVSWARM_REPO_ID` is set (auto mode) or `ANTIHALL_DEVSWARM_SUPERVISOR=on`. Consumed by `doctor.js`'s per-workspace DevSwarm check. Fail-open = NOT active. Kill-switch: `DISABLE_ANTIHALL_DEVSWARM=1`. |
| `hooks/lib/devswarm-role.js` | Shared helper (not a hook) | **OPTIONAL** — topology gate distinct from `devswarm-detect.js`: answers only "is THIS session a DevSwarm CHILD workspace?" via `DEVSWARM_SOURCE_BRANCH` (non-empty = child, empty/unset = Primary). Fail-open = Primary. Consumed by `devswarm-child-role.js`. |
| `hooks/devswarm-child-role.js` | SessionStart | **OPTIONAL, feature-gated** — Layer 1 of the DevSwarm layered recovery model: for a DevSwarm CHILD workspace only (both `devswarm-detect.js` active AND `devswarm-role.js` child), injects a reminder to proactively self-report idleness (`hivecontrol workspace message-parent`) rather than sit unnoticed. Silent no-op for Primary/non-DevSwarm sessions. |
| `devswarm-parent-inbox.js` | UserPromptSubmit | **OPTIONAL, feature-gated** — mechanical trigger for the "Primary neglects child workspaces" failure (claude-code#39755). For a Primary DevSwarm session only: each turn surfaces the real unread/idle state of active workspaces, and recommends archiving any workspace the store derived as complete (`archive_ready`). Reads the durable-inbox files + the supervisor's verdicts + `summary.json`; never runs git/`computeLiveness` on the hot path. **(0.54.1)** Also injects a compact live table EVERY turn — one row per active workspace: status (`escalated`>`stale`>`archive-ready`>`active`, attention first) / finish-rate (required gates met/total + optional heartbeat %) / unread / last-activity; capped at 12 rows with a logged `+N more`. Silent no-op otherwise. |
| `devswarm-parent-gate.js` | Stop | **OPTIONAL, feature-gated** — Primary-only, capped/loop-safe. Blocks the Primary from ending its turn while a child still has unread backlog past its cursor OR the supervisor already judged a child stale/escalated. Reads only files (fs cursor + the supervisor's verdict file) — no git, no live liveness on the ~30 s Stop path. Fail-open. |
| `devswarm-child-turn.js` | UserPromptSubmit | **OPTIONAL, feature-gated** — child-only. Writes a turn-authored heartbeat (`heartbeats/<branch>.json`, never a background ticker) and reminds the child to report to its parent. **(0.54.1)** Also surfaces a non-destructive unread-count check against the child's OWN durable descriptor inbox — PARTIAL: this only makes an already-populated durable inbox visible to the child; nothing shipped yet drains the child's native parent→child queue into it (v0.54.2 follow-up). Silent no-op otherwise. |
| `devswarm-child-gate.js` | Stop | **OPTIONAL, feature-gated** — child-only, capped/loop-safe. Forces the child to self-report to its parent before going idle, so a child that finishes a turn pings the parent instead of dropping off its radar. **(0.54.1)** Over-nag fix: stays silent when the child's own turn-authored heartbeat is already fresh (<5 min) — no forced duplicate report every Stop. Fail-open. |
| `swarm-guard.js` | PreToolUse (Agent/Task) | Anti-fork-bomb — spawn-rate cap + real reclaimable-memory check (`vm_stat` / `MemAvailable`, not `os.freemem()`). A blocked spawn also logs one line to `~/.anti-hall/swarm-trips.log` (observation only — doesn't feed the rate window). |
| `phase-tracker.js` | PreToolUse (Agent/Task) | Records every subagent spawn so the statusline shows live swarm activity. It also writes a rolling `~/.anti-hall/agents/recent-spawn.json` heartbeat that `agentsRunning()` consumes, so the Stop guards know when parallel work is live. Never blocks. |
| `agent-watchdog.js` | CLI helper (not a hook) | Heartbeat enforcer — scans `~/.anti-hall/agents/*.json` and reports stale/hung subagents; run manually by the orchestration skill. |
| `task-tracker.js` | UserPromptSubmit | Injects task-list discipline (capture, prioritize, work in order) + a one-line freshness note when open/stale tasks exist. |
| `limit-conserve-inject.js` | UserPromptSubmit | **Limit-conservation mode.** Injects a token-conservation nudge when context usage reaches `ANTIHALL_LIMIT_THRESHOLD` (default 85%). `ANTIHALL_LIMIT_CONSERVE`: `auto` (default) reads the OMC usage cache; `on` forces the nudge; `off` disables. Auto mode requires OMC; without it, manual on/off only. Skip-guard hatch: `limit-conserve`. |
| `limit-conserve.js` | Shared helper (not a hook) | Reads the OMC usage cache and applies threshold logic; consumed by `limit-conserve-inject.js`. **Account-aware:** tracks the logged-in Claude account's `userID` (`~/.claude.json`) alongside the usage cache's mtime; if the account changed since last seen and the cache hasn't been refreshed under the new account yet, the stale reading is deactivated rather than mis-applied across accounts. Kill-switch: `ANTIHALL_LIMIT_ACCOUNT_CHECK=off`. |
| `task-guard.js` | Stop | Blocks once if the session ends with open tasks. |
| `tasklist-guard.js` | Stop | Blocks when non-trivial work (≥ threshold file-mutating actions) wasn't tracked as tasks or lacks a fresh per-session progress file (`.anti-hall/progress/<date>/<session-id>.md`); coexists with `task-guard` with its own independent block cap; capped + fail-open. |
| `skip-guard.js` | Escape hatch (shared primitive) | TTL'd `~/.anti-hall/skip.json` user-override read by the guards; granular per-guard, and a broad `all` skip excludes the destructive git-guard (must be named explicitly). |
| `version-alert.js` | SessionStart (non-blocking) | Alerts when a newer anti-hall version is available. Reads running version vs a cached latest (`~/.anti-hall/version-check.json`); emits a one-line "vX available — /anti-hall:update" if behind. When the cache is absent/stale, spawns a DETACHED, unref'd `git ls-remote --tags` refresh and stays silent that session — never blocks on network. Off-switch: `ANTIHALL_VERSION_ALERT=off`; skip-guard hatch. |
| `fable-availability.js` | SessionStart (non-blocking) | Reads `~/.claude.json`'s `modelAccessCache`/`additionalModelOptionsCache` (the same cache Claude Code's own `/model` selector renders from) once per session — no live API probe, fail-open, silent unless Fable 5 is actually available. When available, threads `args.fableAvailable=true` into ship-it/deadly-loop Workflow invocations so the Reviewer seat's fallback chain extends to Fable 5 → Sonnet 5 → Opus. |
| `codex-availability.js` | SessionStart (non-blocking) | OS-agnostic PATH probe (Windows `PATHEXT`-aware) for a real `codex` executable; writes `~/.anti-hall/codex-availability.json` (`{available, checkedAt, source}`) once per session so coordinators/skills read the cached fact instead of re-probing. Proves reachability only, NOT authentication/readiness — a runtime spawn can still fail even when `available:true`. Registered on both the Claude plugin and the Codex port. Fail-open. |
| `graphify-session.js` | SessionStart | Primes "query the graph first" when a graphify graph exists. |
| `graphify-reminder.js` | Stop | One-time reminder to update the graph after real edits. |
| `speculation-guard.js` | Stop | Blocks once when the last assistant message contains hedge-word speculation without an evidence/uncertainty acknowledgment. Always-on (lexical, Tier 2). |
| `speculation-judge.js` | Stop | OPT-IN semantic judge: calls an LLM to catch confident inference-as-fact with no hedge word. Off by default; enabled by `ANTIHALL_SEMANTIC_JUDGE=1`. |
| `codex-nudge.js` | Stop (advisory) | Nudges once/session for an independent Codex second-opinion review when substantial code shipped with no Codex review; off-switch ANTIHALL_CODEX_NUDGE=off. |
| `ship-it-guard.js` | PreToolUse (Write/Edit/MultiEdit) | **OPT-IN, default OFF** — the only opt-in code-edit gate. With `ANTIHALL_SHIPIT_GATE` ∈ {1,true,yes,on}, blocks a CODE edit on a hard-risk path (migration / auth / `.github/workflows` / security) when no `PLAN.md` exists (repo root). Also does a conformance advisory (never blocks) for edits outside a PLAN.md's declared `files:` list. Enforces artifact existence only (not plan quality), conservative, fail-open. No effect when unset. |
| `merge-gate.js` | PreToolUse (Bash) | **OPT-IN, default OFF** — a backstop, not a guarantee. With `ANTIHALL_MERGE_GATE` ∈ {1,true,yes,on}, blocks an auto-merge (`gh pr merge` incl. `--auto`, `gh pr review --approve`, `git merge --no-ff/--ff` into main/master/develop, and `hivecontrol workspace merge-into-source`/`merge-from-source`) when the agent's own recent output carries an UNRESOLVED self-hedge ("pending review" / "first-pass" / "needs your eyes" / …) not followed by a resolution token. Keyword-heuristic, bypassable, fail-open, cannot hard-loop; no effect when unset. |
| `root-cause` / `orchestration` / `ship-it` / `deadly-loop` (+ `deadly-loop-multi`, `install-statusline`, `doctor`, `system-briefing`, `update`, `flutter-debug`, `activate`, `simplify`, `debt`, `devswarm`) | Skills | Slash commands (see [Skills](#skills)). |
| `statusline/` | Statusline | Rich line 1 for ANY repo (monorepo or simple); the monorepo/simple renderer is only a fallback if the rich renderer yields nothing. Line 2 is an always-on phase/context bar. |
| `companion/mcp-reaper.js` (+ `install-reaper.js`) | Interval companion (not a hook) | **OPT-IN**, macOS + Linux. Kills ONLY orphaned MCP-server processes (parent already died). Install via `node companion/install-reaper.js` (`--uninstall` to remove); Windows is a documented no-op. See [`companion/README.md`](companion/README.md). |
| `companion/devswarm-supervisor.js` (+ `install-devswarm-supervisor.js`) | Interval companion (not a hook) | **OPT-IN and OPTIONAL** — dormant with zero effect unless DevSwarm is in use (feature-gated via `devswarm-detect.js`, same optionality model as the OMC/OMX integration). Detects a wedged/idle DevSwarm workspace agent from outbound activity (session transcript + git/worktree) and pokes it (an optional descriptor `nudgeCommand`) or escalates (log + optional `escalateCommand`) — **never kills**. Install via `node companion/install-devswarm-supervisor.js` (`--uninstall` to remove); macOS + Linux full, Windows detection-only. Workaround for claude-code#39755. |
| `companion/devswarm-recover.js` | On-demand CLI (not a hook) | **OPT-IN and OPTIONAL** — the ONLY path in DevSwarm that ever kills a process. `node companion/devswarm-recover.js <workspace-id>` resolves the one confirmed wedged `claude` target and kill+resumes it (`claude --resume`), headless or interactive (naming the id is the deliberate override). Same confirm-gate safety as the old always-on supervisor. Windows: escalate-only. |
| `companion/lib/devswarm-store.js` | Substrate lib (not a hook) | **OPTIONAL** — the persistent write/derive side of the DevSwarm substrate. ONE API, TWO backends chosen by feature-detecting `node:sqlite` (→ WAL sqlite, else an append-only NDJSON journal — dependency-free, green on Node 18/20 through 22/24). **Hooks never open the DB**: it derives a `summary.json` projection (atomic tmp+rename) that hooks read. Tracks messages/registry/cursors + per-workspace append-only completion `gates`, and derives `archive_ready` when all required gates (configurable, default `done,merged,tests_passed`) are met. anti-hall stays agnostic about what any consumer gate means. |
| `scripts/devswarm.js` | CLI (not a hook) | **OPTIONAL** — THE structured interface (CLI over MCP; stable JSON on stdout). Subcommands: `register`/`ensure`, `heartbeat`, `inbox count\|read\|ack` (the durable-inbox cursor primitive — `ack` is the parent-gate's non-skip clear path), `inbox pull` (child-side reception drain — auto-ensures the descriptor, then ONE bounded guard-safe pull: non-destructive `message-count` gate → at-most-one bounded `read-messages`, never `monitor` → atomic idempotent NDJSON append + store parity), `workspaces list`, `gate --set/--clear`, `nudge`, `archive` (archive-by-absence on anti-hall's own registry — hivecontrol has no teardown command, so it SURFACES a manual "remove workspace in the DevSwarm app" step; never deletes), `archive-ignore`/`archive-unignore`, `migrate`. `command-guard` has a root-anchored LIGHT_EXCEPTION for it so the guard doesn't block its own wrapper. |
| `companion/devswarm-migrate.js` (+ `devswarm-ingest.js`) | Substrate lib / daemon (not a hook) | **OPTIONAL** — `migrate` dual-reads existing on-disk state (JSON registry + legacy NDJSON inboxes) into the store: **idempotent** (dedupe hash), **non-destructive** (reads sources only — legacy files stay byte-for-byte, rollback always possible), single-consumer-locked, and count-verified before it reports success. `devswarm-ingest.js` = the one supervised daemon wrapping the native `monitor` → store; refuses to start if another monitor consumer is running (lockfile), enforcing the single-native-consumer invariant. |
| `companion/install-devswarm-ingest.js` | Installer (not a hook) | **OPTIONAL — new in 0.54.1.** Installs/refreshes `devswarm-ingest.js` as a CONTINUOUS supervised daemon (unlike the periodic supervisor sweep): macOS LaunchAgent with `KeepAlive` (re-exec on exit), Linux `systemd --user` `.service` with `Restart=always` (cron fallback — every minute, restart-if-dead — when `systemctl` is absent; up to ~60 s revive gap on a cron-only Linux host after a crash). Distinct label (`com.anti-hall.devswarm-ingest`) and log (`~/.anti-hall/devswarm-ingest.log`) from the supervisor. Idempotent; safe to install redundantly (the daemon's own single-consumer lock means only one instance ever runs). Windows: documented no-op (no pure-Node long-running user scheduler). **Autonomous refresh:** the `update` skill runs this installer's `how` command automatically (no offer, no ask) whenever an update happens inside an active DevSwarm session, same posture as the supervisor installer — closing the gap where the ingest daemon existed in code but nothing started it. **Cwd caveat:** the daemon drains the workspace of the git worktree it is INSTALLED FROM (`hivecontrol` resolves a workspace by cwd, not env) — the installer bakes that install-time worktree as the unit's `WorkingDirectory` and refuses to install if run from a non-git-worktree cwd. |

## Codex port

This repository now ships a separate Codex-native port without moving or rewriting the Claude plugin surface.

- Codex manifest: [`plugins/anti-hall/.codex-plugin/plugin.json`](.codex-plugin/plugin.json)
- Codex installer: [`plugins/anti-hall/codex/install-codex.js`](codex/install-codex.js)
- Codex docs: [`plugins/anti-hall/codex/README.md`](codex/README.md)
- Codex skills: [`plugins/anti-hall/codex/skills/`](codex/skills/)

Install project-local Codex hooks:

```bash
node plugins/anti-hall/codex/install-codex.js
```

Install global Codex hooks:

```bash
node plugins/anti-hall/codex/install-codex.js --global
```

The Codex installer registers the supported hook subset only: SessionStart, UserPromptSubmit, Bash PreToolUse, and Stop. Claude-only edit-time gates and lifecycle hooks stay documented as skill/workflow protocols in Codex until Codex payload adapters and tests prove parity. The Claude `.claude-plugin` manifest, hooks, skills, statusline, and companion files remain in their existing locations.

Codex statusline boundary: Claude Code's command-backed statusline can append the anti-hall `AH: Vx.y.z` chip. Codex/OMX `[tui].status_line` is documented as built-in item IDs only, so the Codex port does not add an unsupported custom anti-hall footer item.

Codex repo marketplace compatibility is provided by [`../../.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json), which points Codex at `./plugins/anti-hall` using the official local marketplace shape.

## How it works

### Verify-first protocol (the core)

- **SessionStart full protocol** — `verify-first-full.js` injects the FULL
  verify-first + root-cause protocol in the Superpowers **Iron Law +
  rationalization-table** form. It names the specific bypass excuses ("probably",
  "should work", "seems to", "I'll just assume", "looks done", "tests pass on first
  run") and includes a skill primer listing the core 4 skills (root-cause, orchestration,
  deadly-loop, ship-it) and when to reach for each. It also carries the always-on
  **output-presentation rule K** ("PRESENT FOR SCANNABILITY"): organize output with
  GitHub-flavored markdown — tables for comparisons/status, **bold** verdicts, `code` for
  flags/paths/commands, fenced blocks for output, emoji as a leading status glyph (signal,
  not decoration), and avoid renderer-dropped syntax. Styling organizes, never pads.
  SessionStart is the primacy slot.
- **Surviving compaction** — SessionStart re-fires after a compaction with
  `source="compact"`. The no-matcher SessionStart registration therefore re-injects
  the protocol across the compaction boundary, exactly when context is largest and
  adherence is worst. This is the sole compaction-survival mechanism. The hook is
  deliberately **not** registered on `PreCompact`: per the official docs, only
  UserPromptSubmit / UserPromptExpansion / SessionStart can inject
  `additionalContext`, so a PreCompact hook would deliver nothing.
- **Per-turn nudge** — `verify-first.js` injects ONE short one-liner per turn
  (one of 17 facets of the Iron Law), so the per-turn slot stays high-salience
  instead of being habituated and tuned out. The facet is chosen deterministically
  by a SHA-1 hash of the **entire UserPromptSubmit stdin envelope** — which carries
  `session_id` / `transcript_path` / `cwd` alongside the prompt. So the nudge is
  reproducible for a given full envelope, and the same prompt text in a different
  session or cwd intentionally rotates to a different facet (extra novelty against
  habituation). Nothing from stdin is echoed back into the injected text.

### git-guard

`git-guard.js` (PreToolUse on Bash) mechanically **blocks** two things:

- Commits whose inline `-m` / `--message` carries a `Co-Authored-By` / self-credit
  trailer (including the canonical emoji-prefixed `Generated with [Claude Code]`
  footer). Commits take no AI credit.
- `git push --force` (and quoted/bundled variants). History rewrites are a
  deliberate human action.

It uses a **quote-aware tokenizer** that inspects argv positions, so quoted force
flags (`git push "--force"`), bundled `-f`, `+refspec` pushes, and a trailing
`--force` after a `2>&1` redirect are all caught. It also **unwraps** `bash -c` /
`sh -c` / `zsh -c` / `dash -c` / `ksh -c` / `ash -c` shell wrappers and re-inspects
the payload, so `bash -c "git push --force"` and `bash -c '...Co-Authored-By:
Claude...'` cannot smuggle either block past it that way.
**Documented fail-open scope:** it inspects only inline `-m` / `--message` trailers,
so `-F <file>` / `--file` and editor commits are not scanned, and `xargs` / an
aliased `g push` can still bypass it. These are documented boundaries, not silent
gaps.

### Task discipline

- `task-tracker.js` (UserPromptSubmit) injects the directive every turn: capture
  every request as a task before acting, assign priority (`P0/P1/P2`), keep the list
  sorted highest-priority-first and work in that order, keep statuses current,
  delegate heavy work to background subagents, and report progress. Nothing is
  silently dropped.
- `task-guard.js` (Stop, loop-safe) blocks **once** when the session is about to
  stop with open tasks (`pending` / `in_progress`) still in the list, prompting the
  model to continue, complete, or explicitly defer them. If the exact same open-task
  set was already blocked on (nothing changed), it skips to prevent infinite loops.
  Fail-open on any parse/read/state error.
- `tasklist-guard.js` (Stop) blocks when **non-trivial work** — ≥
  `ANTIHALL_TASKLIST_WORK_THRESHOLD` (default 3) file-mutating actions — happened without
  task tracking (or with more than one task `in_progress`, or without a fresh
  **per-session** progress file at `<cwd>/.anti-hall/progress/<date>/<session-id>.md`
  (`<date>` = UTC `YYYY-MM-DD`, `<session-id>` = the sanitized Claude Code session id) —
  collision-free across concurrent sessions on the same project, replacing the old
  single shared `.anti-hall-progress.md`. It coexists with `task-guard` (which drains
  declared tasks) and keeps an **independent block cap** (`MAX_BLOCKS=3` cumulative/session)
  so the two never compound. The progress file is gitignored, never created by the hook, and
  must be updated this session (default 30 min freshness window) to count. A running
  `.anti-hall/progress/INDEX.md` (and the history-side equivalent) is maintained via
  atomic single-line appends only — never a read-modify-rewrite. Fully fail-open.
  See [`docs/TASKLIST-GUARD.md`](../../docs/TASKLIST-GUARD.md).

### User-override escape hatch (skip-guard)

The user's explicit instruction outranks any guard. When the user **clearly and directly**
asks the agent to skip a guard, the agent records that consent via the shared `skip-guard.js`
primitive — a TTL'd JSON marker at `~/.anti-hall/skip.json`, e.g.
`{ "tasklist-guard": <unix-ms expiry>, "all": <unix-ms expiry> }`. Every guard checks it at
startup and fail-opens while it is in effect; the marker auto-expires (default 15 min) so a
safety guard is never left silently disabled.

- **Granular:** name a single guard (`"speculation-guard"`, `"tasklist-guard"`, `"limit-conserve"`, …) or use
  `"all"` to cover the noisy guards at once.
- **Safe default:** a broad `"all"` skip does **not** cover the destructive `git-guard`
  (force-push / AI-credit trailer) — to skip that, the agent must name `"git-guard"`
  explicitly.
- **Fail direction is inverted from the hooks:** a missing/corrupt skip file makes
  `isSkipped` return false, so the guard stays **active**. A broken skip file must never
  silently disable protection.

> **Six Stop hooks are registered** (`task-guard`, `graphify-reminder`, `speculation-guard`,
> `speculation-judge`, `tasklist-guard`, `codex-nudge`), all emitting the top-level `{"decision":"block","reason":...}`
> Stop schema. Claude Code does not merge `reason` strings across Stop hooks: if multiple fire on
> the same Stop, all block but only one reason is shown that turn. `task-guard` is registered
> **first** because open-task discipline is higher-stakes, so its reason wins precedence.
> Each is capped (graphify-reminder nudges once per session; task-guard caps at `MAX_BLOCKS`;
> speculation-guard blocks once per distinct speculative message hash; speculation-judge
> blocks once per distinct message hash; `tasklist-guard` has its own independent block cap
> — `MAX_BLOCKS=3` cumulative per session — so it never compounds with `task-guard`), so the
> others surface on subsequent Stops.
> `speculation-judge` is a no-op unless `ANTIHALL_SEMANTIC_JUDGE=1` — it never blocks in
> the default configuration.

### speculation-guard

`speculation-guard.js` (Stop) provides **lexical enforcement** of the no-speculation
Iron Law at the output boundary — after the model has already produced a reply.

**How it works:**

1. Reads `transcript_path` from stdin, parses the JSONL, and extracts the **last
   assistant message** (all text content blocks concatenated).
2. Scans for **speculation markers** (case-insensitive, word-boundary):
   `very plausibly`, `plausibly`, `presumably`, `I suspect`, `my guess`, `I'd guess`,
   `I bet`, `likely`, `probably`, `must be`, `should be` (but not `should I`),
   `seems to be`, `appears to be`, `I think it's`, `my hunch`.
3. Suppresses the block if the **same message** also contains an evidence/uncertainty
   **acknowledgment**: `verified`, `I don't know`, `haven't checked`, `not verified`,
   `unverified`, `let me verify`, `I'll check`, `I will check`, `need to confirm`,
   `to confirm`, a `file.ext:line` citation, `running`, `per the data`, `the data shows`.
   This allows honest hedging ("I haven't checked, but it might be X — let me verify")
   while blocking silent inference-as-fact.
4. **Block-once / loop-safe:** hashes the last message text; stores the blocked hash
   in `~/.anti-hall/speculation-guard-state-<session>.json`. If the same message hash
   was already blocked (nothing changed between Stops), skips the block — the model
   was nudged once and had a chance to respond. Never wedges.
5. **Fail-open:** any parse/read/write error exits 0 without blocking or writing to
   stderr. A bug here never wedges a session.

**Known limit — confident inference without hedge words.** The guard is lexical: it
catches hedged speculation (`probably`, `likely`, `I suspect`, etc.) but cannot catch a
confidently-stated inference-as-fact that uses no hedge word at all ("the cause is the
old build" with zero hedging). That class requires semantic judgment — covered by the
opt-in **Tier 3 semantic judge** described below.

### Three tiers of anti-speculation enforcement

| Tier | Component | On by default | Mechanism | Cost / latency |
|---|---|---|---|---|
| 1 | `verify-first-full.js` + `verify-first.js` | Always-on | Protocol injection (SessionStart + per-turn nudge): names every rationalization bypass including confident inference-as-fact and hedge-word speculation. | Zero (no API call; text injection only). |
| 2 | `speculation-guard.js` | On by default | Lexical Stop hook: scans for 15 hedge-word markers, suppresses when acknowledgment present. Catches hedged speculation. Cannot catch confident inference-as-fact with no hedge word. | Zero (pure Node, no API call). |
| 3 | `speculation-judge.js` | OPT-IN (off by default) | Semantic Stop hook: calls an LLM judge via the Anthropic API to assess whether the last message asserts an unverified fact with no hedge word and no acknowledgment. Catches the gap Tier 2 misses. | ~$0.0001-0.001 per turn + ~1-3 s latency. Requires `ANTHROPIC_API_KEY`. |

### speculation-judge (Tier 3, OPT-IN)

`speculation-judge.js` is registered in `hooks.json` but **exits 0 immediately** unless
`ANTIHALL_SEMANTIC_JUDGE=1` is set. When unset (the default), it has zero cost, zero
latency, and zero network activity — it is as if it were not registered at all.

**To enable:**

```bash
# Add to ~/.zshrc / ~/.bashrc / ~/.profile, then restart Claude Code:
export ANTIHALL_SEMANTIC_JUDGE=1
export ANTHROPIC_API_KEY=sk-ant-...    # required; judge is fail-open if absent
```

Or set both variables in the `env` block of your `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTIHALL_SEMANTIC_JUDGE": "1",
    "ANTHROPIC_API_KEY": "sk-ant-..."
  }
}
```

**To disable:** unset `ANTIHALL_SEMANTIC_JUDGE` (or set it to any value other than `"1"`).

**What it catches:** confidently-stated inference-as-fact with no hedge word — e.g.,
"The cause is the old build artifact." with no tool verification and no uncertainty
acknowledgment. The judge prompt instructs the model to ALLOW honest hedging, quoted
text, hypotheticals, plans, and general software knowledge; it only blocks definitive
unverified factual claims.

**Fail-open:** any error (absent `ANTHROPIC_API_KEY`, API unavailable, timeout, bad
JSON response) exits 0 without blocking. A failure here never wedges a session.

**Loop-safe:** hashes the last message text (with a `":judge"` suffix to keep the
namespace separate from `speculation-guard`'s hashes). If the same message hash was
already blocked, skips — the model was nudged once and had a chance to respond.

**Misfire caveat:** LLM judges are not perfect. The conservative judge prompt reduces
false positives, but some misfires will occur — particularly on messages that describe
what code does based on reading it (which IS verified by inspection). If misfires are
frequent in your workflow, disable `ANTIHALL_SEMANTIC_JUDGE` and rely on Tiers 1 + 2.

**Cost and latency detail:** one `claude-haiku-4-5` call per Stop event when enabled.
At current Haiku pricing this is roughly $0.0001-0.001 per turn; latency is roughly
1-3 s added to each Stop. For projects where confident inference-as-fact is the primary
failure mode and the cost/latency is acceptable, Tier 3 closes the gap Tier 2 leaves open.

### graphify hooks (optional)

- `graphify-session.js` (SessionStart) — if the project has a graphify graph
  (`graphify-out/`), primes the model to query the graph
  first for any issue/feature/function/code/doc lookup, and to keep it updated.
  Silent no-op when graphify isn't used.
- `graphify-reminder.js` (Stop) — after a session with real edits and a graph
  present, surfaces a one-time reminder to run `graphify update .`. A Stop hook
  cannot inject `additionalContext`, so it nudges with a single soft `decision:block`,
  capped via `os.tmpdir` state so it never loops — stop again to dismiss.

## Skills

**Always-on vs conditional.** The **root-cause** and **orchestration** disciplines are
**enforced always-on via the hook layer** — their core fires every session/turn through
`verify-first-full.js` (SessionStart) and `verify-first.js` (per-turn nudge), so they
apply without being invoked. The full step-by-step playbooks below are still available as
slash commands for when you want the deep version. **deadly-loop** and **ship-it**
are **conditional skills invoked on match** — they are not forced every turn. The
always-on orchestration injection enforces a **bias toward delegation** — default to a
subagent for any work that touches files/tools/commands/search/build/test or could
balloon (to avoid the eager "I'll just do it inline" trap that pollutes the main thread),
handling inline only genuinely atomic things (a direct answer, a single known-line read,
the coordinator's own synthesis/decisions), and delegating immediately if a quick inline
task balloons; parallel agents when independent; commands via Haiku off-thread. It now
also **defaults delegated heavy/parallel work to the background** — the coordinator passes
`run_in_background` itself so the user needn't background it manually, while still
verifying each on completion (never fire-and-forget). It also
enforces **verify delegated work** — a subagent's "done/passing" is an unverified claim
re-checked against ground truth (re-run the authoritative check, or use a separate
verifier, reconciling multiple workers against ground truth) before marking complete —
**capture-every-request** task discipline (priority-sorted),
**anti-sycophancy** (challenge a wrong premise with evidence; user agreement is not
correctness), and **scope & fidelity** (solve the actual problem with the simplest
sufficient solution; intent over letter; confirm before expanding scope; match rigor to
blast radius; finish what was asked and drop nothing).

Invoke via slash command:

- **`/anti-hall:root-cause`** — evidence-driven debugging: reproduce, collect
  evidence, instrument when missing, trace the sequence to the original + root cause
  (not the surface symptom), prove the hypothesis, fix at the root, verify.
- **`/anti-hall:orchestration`** — swarm with a non-blocking main thread: delegate
  heavy/long work to background + parallel subagents, partition to avoid conflicts,
  distribute load across Claude **and** Codex when available, run commands via Haiku
  so raw output never pollutes the coordinator's context.
- **`/anti-hall:ship-it`** — one lean workflow for shipping any change, scaled S/M/L
  to blast radius: brainstorm + plan in plan mode (ExitPlanMode is the approval gate;
  blends superpowers planning ideas — standalone, no external dependency), enumerate edge cases, harden
  the plan with the deadly-loop BEFORE any code, fan large work out as a Workflow swarm,
  and verify each phase with fresh evidence + a vacuous-test guard, running the
  deadly-loop after each phase until zero NEW P0/P1s. **L tier** adds a resumable
  `.anti-hall/ship-it/<slug>/STATE.json` (plan hash + per-phase status + an escalation
  counter capped at 2 build→re-plan loops), logs accepted P2 findings to
  `decisions.md`, routes build seats Codex-primary with Sonnet-5 failover (a
  cross-model guard skips the Sonnet 5 Reviewer when a phase's build fell back to
  Sonnet 5, to avoid same-model self-review), and closes out with a session-history
  entry + `SUMMARY.md` + a `graphify update .` trigger.
- **`/anti-hall:deadly-loop`** — iterative parallel Reviewer + Critic debate +
  fix-waves until convergence (zero NEW P0/P1s). The debate engine behind
  ship-it's gates. On convergence, writes an ADVISORY
  `~/.anti-hall/approvals/<repo>@<HEAD-sha>.json` record (`"proof": false` —
  not authorization; a real gate must still enforce its own check).
- **`/anti-hall:deadly-loop-multi`** — scaled-up deadly-loop: N Reviewer + N Critic
  pairs with diversified lenses, then dedup + synthesize (double / triple / quadruple).
- **`/anti-hall:install-statusline`** — writes the statusLine setting (global by
  default, per-project on request) and reminds you to restart. `--consolidate` merges
  with an existing statusline (e.g., OMC HUD) instead of replacing it; base persisted
  to `~/.anti-hall/consolidated-base.json`. Env: `ANTIHALL_STATUSLINE_BASE` pins the
  base expression explicitly.
- **`/anti-hall:doctor`** — health-check: confirms Node is found, every hook is
  present + syntax-valid, and the guards actually fire (live behavioral self-tests on
  e.g. git-guard / command-guard / swarm-guard / speculation-guard / tasklist-guard).
  Also **env-aware**: detects and tests each optional integration only when it's
  actually present — OMC (plugin-enabled + live-loop check), Codex/OMX (config/skills
  detection), and the DevSwarm liveness supervisor (supervisor-companion-installed
  state plus a per-workspace liveness self-test; `nudged` reads as WARN, not FAIL) —
  silent and skipped for any integration that isn't in play.
- **`/anti-hall:update`** — updates anti-hall in place: `git pull --ff-only` the
  marketplace clone, syncs the version-pinned cache (semver-anchored, traversal-proof),
  prints the changelog delta between installed and latest, then instructs
  `/reload-plugins` for in-session reload. Hooks and statusline pick up from disk
  immediately; `/reload-plugins` refreshes the skill list and version label. `--check`
  mode answers "is anti-hall up to date?" without pulling or writing. After a pull, also
  runs `scripts/migrate-state.js` once per repo (idempotent) to fold legacy root
  `.anti-hall-progress.md` / `.anti-hall-history.md` into `.anti-hall/history/legacy/`,
  then a **dynamic capability scan** (`scripts/capability-scan.js`, read-only) reports
  each opt-in capability shipped in this build (companions discovered from
  `companion/install-*.js`, statusline, pending state migrations) as available-vs-active
  on this machine, with the exact command to enable any gap — never auto-installs.
- **`/anti-hall:devswarm`** — explains anti-hall's optional DevSwarm integration: the
  `hivecontrol` reference KB, the designed-but-unbuilt workspace-tier orchestration, the
  shipped **layered recovery model** (child self-report → supervisor poke → escalate —
  the automatic path never kills), and the **on-demand `devswarm-recover` CLI** (the
  only path that ever kills), including the full activation checklist and tunable env
  vars.

`MODEL-POLICY.md` is the shared TRIO roster (Reviewer = Sonnet 5 `model:"sonnet"` effort `xhigh`;
Auditor = latest Opus `model:"opus"` divergent regression/coupling lens effort `high`;
Critic = Codex latest `xhigh` reasoning when available, else a divergent Opus adversarial persona). It is
**duplicated** — see [Contributing](#contributing).

## Statusline (opt-in, one command)

Claude Code plugins cannot auto-apply the main statusline, so this is activated by an
installer. `statusline/` ships a dispatcher whose **line 1 is the rich renderer for
ANY repo** (project name, git, model, context%, cost, duration, subagents). Line 1
also shows an **anti-hall version chip** (`AH: Vx.y.z`) between the
cost and email segments: `★` prefix in YELLOW for a new minor version, RED for a new
major version, plain dim when up-to-date (fail-open if no version-check cache exists).
Only if the rich renderer yields nothing does it fall back to a
monorepo-aware renderer (`.gitmodules`) or a **simple**
`model | branch | dir | context%` line. Line 2 is an always-on phase/context bar. No emojis.

**Consolidated mode (`--consolidate`):** pass `--consolidate` to merge with an existing
`statusLine` (e.g., the OMC HUD) instead of replacing it. The existing base is detected
from current settings or read from `ANTIHALL_STATUSLINE_BASE` (env), and is persisted to
`~/.anti-hall/consolidated-base.json` for subsequent sessions. Use this mode when you
already have another statusline and want anti-hall to extend it rather than overwrite it.

```bash
# Find the installed plugin dir and run the Node installer. Claude Code installs a
# plugin under the cache dir, versioned per marketplace/plugin
# (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ — for this plugin that is
# ~/.claude/plugins/cache/anti-hall/anti-hall/<version>/), but older layouts nest it
# under marketplaces/. We search all of them. A dir only counts if it contains the
# plugin manifest, so a parent dir is never mistaken for the plugin dir.
DIR=$(for d in \
  ~/.claude/plugins/cache/*/anti-hall/*/ \
  ~/.claude/plugins/cache/*/anti-hall/ \
  ~/.claude/plugins/cache/anti-hall/*/ \
  ~/.claude/plugins/cache/anti-hall/ \
  ~/.claude/plugins/marketplaces/*/plugins/anti-hall \
  ~/.claude/plugins/*/plugins/anti-hall \
  ~/.claude/plugins/*/anti-hall; do \
  [ -f "$d/.claude-plugin/plugin.json" ] && echo "$d"; done 2>/dev/null | head -1)
[ -n "$DIR" ] && node "$DIR/statusline/install-statusline.js" || echo "anti-hall not found under ~/.claude/plugins (cache or marketplaces) — install it first (/plugin install), then re-run, or locate the dir via /plugin."
```

**Cross-platform (Windows PowerShell / cmd / any OS with Node)** — the bash loop
above relies on glob expansion and `[ -f ... ]`, which a stock Windows shell lacks.
This pure-Node one-liner does the same search and runs the installer (identical on
Windows, macOS, and Linux):

```bash
node -e "const fs=require('fs'),p=require('path'),os=require('os');const root=p.join(os.homedir(),'.claude','plugins');const isPlugin=d=>p.basename(d)==='anti-hall'&&fs.existsSync(p.join(d,'.claude-plugin','plugin.json'))&&fs.existsSync(p.join(d,'statusline','install-statusline.js'));const find=(d,n)=>{if(n<0||!fs.existsSync(d))return null;if(isPlugin(d))return d;let e=[];try{e=fs.readdirSync(d,{withFileTypes:true})}catch(_){return null}for(const x of e)if(x.isDirectory()){const r=find(p.join(d,x.name),n-1);if(r)return r}return null};const dir=find(root,6);if(!dir){console.error('anti-hall not found under '+root+' — install it first (/plugin install), or locate the dir via /plugin.');process.exit(1)}require('child_process').execFileSync(process.execPath,[p.join(dir,'statusline','install-statusline.js')],{stdio:'inherit'})"
```

To do it by hand, run `/plugin` to find the install path, then invoke the installer
directly: `node "<full-path>/anti-hall/statusline/install-statusline.js"`.

See `statusline/STATUSLINE.md` for details and how to revert.

## Configuration / tuning

- **Verify-first wording** — edit `hooks/verify-first-full.js` (the full SessionStart
  protocol) and the `NUDGES` array in `hooks/verify-first.js` (the per-turn one-liners).
- **Hard gates / force patterns** — `hooks/git-guard.js` holds the commit-trailer and
  force-push logic; `command-guard.js` and the other always-on guards cover deploy CLIs,
  payment commands, and bulk deletes at command dispatch. `ship-it` relies on these
  always-on guards for its hard safety boundaries rather than a bespoke per-project
  sentinel.
- **Task discipline / graphify** — edit the respective `hooks/*.js`. All hooks are
  fail-open: a bug in a hook must never wedge a turn.

## Troubleshooting / FAQ

- **Hooks not firing?** Restart Claude Code so a fresh session re-runs SessionStart,
  and ensure `node` is on `PATH` for the shell Claude Code launches hooks from
  (`node --version`). If `node` is missing, all hooks silently no-op.
- **Statusline didn't apply?** It is opt-in — run the installer above. If it reports
  "not found", run `/plugin install` first, then re-run, or locate the dir via `/plugin`.
- **Graphify reminder won't stop?** It is capped per session; stop again to dismiss.
  It only fires when a graph (`graphify-out/`) is present.
- **git-guard let a force-push through?** Check the documented fail-open scope above
  (`xargs` / aliases / `-F <file>` commits are out of scope by design; `bash -c`/`sh -c`
  wrappers are unwrapped and inspected, not a bypass).
- **Using Codex too?** Copy `AGENTS.md` (repo root) into your own repo root — it is
  not bundled by `/plugin install`. Verify with
  `codex --ask-for-approval never "Summarize current instructions"`.

## Test locally

```bash
# Full zero-dependency E2E suite (node:test, run from the repo root):
node --test                                                                  # 783 pass +2 platform-skip (785 total); CI runs the same on push/PR (.github/workflows/test.yml)

# Quick smoke-checks of individual hooks:
echo '{"hook_event_name":"SessionStart"}' | node hooks/verify-first-full.js  # full Iron-Law protocol + skill primer
echo '{"prompt":"x"}' | node hooks/verify-first.js                           # short varying nudge (varies by full stdin envelope)
echo '{"prompt":"y"}' | node hooks/verify-first.js                           # different envelope -> different nudge
claude --plugin-dir /path/to/anti-hall                                       # load in a throwaway session
```

## Contributing

- **Keep the 2 MODEL-POLICY.md copies in sync.** The TRIO roster file is duplicated
  (`skills/MODEL-POLICY.md` plus a copy under `skills/deadly-loop/references/`) because
  skill bundling requires the skill to carry its own `references/` copy and symlinks are
  stripped on install. Update **both** together — they must stay byte-identical.
- **Bump the version on any behavioral change.** `plugin.json` `version` is the sole
  authority (the marketplace entry carries no `version`); without a bump, installed
  users do not receive the update. Add a `CHANGELOG.md` entry.
- **Keep hooks pure Node (built-ins only)** and fail-open, so they run unchanged on
  Windows, macOS, and Linux and never wedge a turn.

### Recommended optional: oh-my-claudecode (OMC)

[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) is a **recommended
optional** dependency. anti-hall installs and runs fully standalone without it. Two
features gain automatic behavior when OMC is installed:

- **`limit-conserve` auto mode** — `limit-conserve-inject.js` reads the OMC usage
  cache (`~/.anti-hall/omc-usage-cache.json`) to detect the live context percentage.
  Without OMC, the hook operates in manual `on`/`off` mode only. **Account-aware:** if
  the logged-in Claude account changes and the usage cache hasn't refreshed under the
  new account yet, conservation mode deactivates rather than apply a stale reading
  across accounts. Kill-switch: `ANTIHALL_LIMIT_ACCOUNT_CHECK=off`.
- **Consolidated statusline** — `install-statusline --consolidate` merges the anti-hall
  bar with the OMC HUD. The version chip in consolidated mode reads OMC session state.

Without OMC, both features fall back gracefully (limit-conserve manual only; consolidated
mode still works but requires `ANTIHALL_STATUSLINE_BASE` to specify the base). No errors,
no breaking change.

### Recommended companion: graphify

The `graphify-guard` and `graphify-session` hooks integrate with **graphify** — a
user-global knowledge-graph skill/CLI (not a marketplace plugin) that builds a semantic
graph of your codebase. When a `graphify-out/` directory is
present, the hooks enforce querying the graph before raw code searches and remind the
model to keep it updated after significant edits. Both hooks no-op gracefully when
graphify is not present — there is no hard dependency, and the plugin installs and runs
identically with or without it.

### Opt-in companion: mcp-reaper (macOS + Linux)

`companion/mcp-reaper.js` is an **opt-in interval companion** (not a hook) that kills
**orphaned** MCP-server processes — ones leaked when their spawner (a Claude / codex /
npm / node session) exited without cleaning them up. Install with
`node companion/install-reaper.js` (macOS → 60 s LaunchAgent; Linux → `systemd --user`
timer, cron fallback); remove with `--uninstall`. **Safety invariant:** a process is
reaped only if its command matches a generic MCP signature **and** its parent is a
reaper/init (launchd / init / `systemd --user`) — because Unix reparents a dead process's
children, a *live* MCP always has a live spawner as parent, so killing an in-use server is
impossible by construction. Recognizes Python MCPs too (`uvx`/`uv` + underscore
`mcp_server_*` forms). **Limitation:** an MCP run as a LaunchAgent / `systemd --user`
unit / OS service shares init as a parent (like a leaked orphan) and can be reaped —
exclude it via `ANTIHALL_REAPER_EXCLUDE='name|name'`. Env knobs: `MCP_REAP_DRYRUN=1`,
`MCP_REAP_GRACE`, `ANTIHALL_REAPER_MATCH`, `ANTIHALL_REAPER_EXCLUDE`.
**Windows is a documented no-op** — it has no parent-death
reparenting and recycles PIDs, so external orphan detection is unsafe there; the correct
fix is Job Objects set by the spawner. See [`companion/README.md`](companion/README.md).

### Opt-in companion: DevSwarm layered recovery (macOS + Linux full, Windows detection-only)

`companion/devswarm-supervisor.js` is a second **opt-in interval companion** (not a
hook) — a workaround for claude-code#39755, where a `claude` session can silently wedge
(process alive, listener dead) with no upstream headless recovery. It is **OPTIONAL**,
exactly like the OMC/OMX integration: dormant with zero effect unless DevSwarm is
actually in use, gated by `hooks/lib/devswarm-detect.js` (modeled on `omc-detect.js`)
and the presence of published workspace descriptors under
`~/.anti-hall/devswarm/workspaces/*.json`.

**The seam:** anti-hall ships only the generic supervisor. A DevSwarm-aware consumer
publishes the workspace descriptor (`id`, `worktreePath`, `sessionId`, `inboxPath`,
`cursorPath`, optional `nudgeCommand`/`escalateCommand`); anti-hall never assumes
DevSwarm's internals beyond that JSON shape.

**Three escalating layers, and the automatic path never kills:**
1. **Child self-report** — `hooks/devswarm-child-role.js` (SessionStart, child-workspace
   only) reminds an idle child to proactively message its parent via `hivecontrol
   workspace message-parent`.
2. **Supervisor poke** — each sweep computes liveness from **outbound** activity only
   (the session's own transcript mtime + git/worktree commit activity — both must be
   idle, plus a pending unread backlog, before a workspace is nominated `stale`); on
   `stale`, it fires the descriptor's optional `nudgeCommand` and persists verdict
   `nudged`.
3. **Escalate-to-parent** — once the poke budget (`ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS`)
   is exhausted, it persists a terminal `escalated` verdict and fires the optional
   `escalateCommand`. Nothing above ever resolves a pid or sends a signal.

Install with `node companion/install-devswarm-supervisor.js` (`--uninstall` to remove,
`--dry-run` to preview). macOS → LaunchAgent; Linux → `systemd --user` timer (cron
fallback); default sweep interval 90 s (`ANTIHALL_DEVSWARM_INTERVAL`, clamped 60-120).
Env knobs: `ANTIHALL_DEVSWARM_SUPERVISOR` (`off`/`on`/`auto`, default `auto`),
`DISABLE_ANTIHALL_DEVSWARM=1` (hard kill-switch). Sweep thresholds are also env-tunable
(all seconds; invalid/absent falls back to the default, clamped):
`ANTIHALL_DEVSWARM_IDLE_SEC` (default `900`, min 60), `ANTIHALL_DEVSWARM_COOLDOWN_SEC`
(default `600`, min 0), `ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS` (default `2`, clamped
1–20), `ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC` (default `180`, min 1),
`ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC` (default `120`, min 0). `doctor.js` runs a
matching per-workspace check that stays silent unless DevSwarm is active; a `nudged`
verdict reads as WARN (no more stuck-timer/FAIL check — the automatic path never kills,
so there's no kill-then-resume window to watch for being "stuck").

**On-demand kill: `companion/devswarm-recover.js <workspace-id>`** — the ONLY path in
DevSwarm that ever kills a process, invoked explicitly per workspace (e.g. on an
`escalated` verdict). Precise targeted kill: identity-bound (worktree + session uuid),
abstains on any ambiguity (0 or >1 candidates), re-confirms identity on fresh data
immediately before each signal (a pid recycled mid-grace is never SIGKILLed), signals
the process **group** (not just the pid) so orphaned MCP children are cleaned up too,
and — unlike the automatic path — targets an **interactive** `claude` session too, not
just headless (naming the id on the command line is the deliberate override). Capped at
`ANTIHALL_DEVSWARM_MAX_RECOVERIES` (default `3`, clamped 1–20) auto-recoveries before
escalating instead of restart-looping; `ANTIHALL_DEVSWARM_GRACE_SEC` (default `5`,
clamped 1–60) is the SIGTERM→SIGKILL grace window. **Windows is a documented no-op for
recovery** — a running process's cwd is not obtainable in pure Node on Windows, so the
cwd confirm-gate that makes the kill safe cannot run; detection-only use from a session
is still possible.

### Codex / cross-tool

`AGENTS.md` is a prose mirror of the verify-first Iron Law + commit hygiene + task
discipline, so Codex agents inherit the same discipline (Codex `PreToolUse` cannot
inject context the way Claude's hooks do). It lives at the **marketplace repo root**,
NOT inside `plugins/anti-hall/`, so it ships only to people who clone this repo — a
`/plugin install` does not bundle it. Installed users who also run Codex must copy it
into their own repo root manually.

## License

MIT — see [LICENSE](../../LICENSE).
