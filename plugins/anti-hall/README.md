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

> **Node.js >= 22 on `PATH` is the one hard prerequisite.** Every hook and the
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
| `verify-first-full.js` | SessionStart | The verify-first FOUNDATION: full Iron-Law + rationalization-table protocol, the always-on **scope & fidelity** discipline (simplest sufficient solution; intent over letter; confirm before expanding scope; match rigor to blast radius; finish what was asked / drop nothing), and the always-vs-conditional skill/disciplines index; survives compaction. |
| `verify-first-orch.js` | SessionStart | The companion to `verify-first-full.js` carrying the always-on **orchestration discipline** ruleset (rules A–N + the DevSwarm-Primary workspace-tier rule W). SPLIT from `verify-first-full.js` in 0.60.0 because the combined ~15.3k-char payload exceeded the ~10k per-hook injection cap — over which Claude Code spills the overflow to a file instead of delivering it inline, so only ~2k chars landed and rules A–N + rule W reached no session inline. Each half is now under the cap; zero content dropped. Survives compaction. |
| `verify-first-subagent.js` | SubagentStart | Re-injects the Iron Law + rationalization table + positive rules + scope-fidelity into each spawned subagent. Deliberately omits the orchestration/delegate block (subagents are workers; re-injecting it would recreate deep nesting). Shared core extracted to `verify-first-core.js`. |
| `verify-first-core.js` | Shared module (not a hook) | Single source of truth for the Iron Law content shared by `verify-first-full.js` and `verify-first-subagent.js` — prevents drift between the two hooks. |
| `verify-first.js` | UserPromptSubmit | Short, varying one-line nudge each turn (anti-habituation). |
| `git-guard.js` | PreToolUse (Bash) | Blocks AI self-credit attribution — in `git commit` trailers AND in `gh pr/issue/release create\|edit\|comment` `--body`/`--title` (the 🤖 footer, Co-Authored-By, claude.com/claude-code link) — plus `git push --force`. Inline values only (`--body-file` is fail-open). |
| `api-guard.js` | PreToolUse (Write/Edit/MultiEdit) | Blocks code that references a **non-existent** stdlib/builtin API — resolves `module.attr` in the code-to-be-written against the installed `python3`/`node` and refuses the write when the attribute is fabricated. The mechanical answer to API hallucination. Default = stdlib/builtins (import-safe); opt-in `ANTIHALL_API_GUARD_THIRDPARTY=1` also checks installed 3rd-party packages (off by default — verifying a package imports it, running its code at edit time). 0 FP + full in-scope catch on `eval/api-guard-bench.js`; never probes local/relative modules; fail-open; skip-hatch. |
| `command-guard.js` | PreToolUse (Bash) | Keeps the coordinator clean — blocks heavy commands inline, pushes them to subagents. Subagent-aware via payload, per-segment (quote-aware). Under a DevSwarm-active session it also redirects destructive native `hivecontrol` inbox reads (all contexts, own skip `devswarm-read-guard`): `hivecontrol workspace monitor` blocks unconditionally, `read-messages` blocks only with durable-inbox evidence (`ANTIHALL_DEVSWARM_INBOX_CMD` or a workspace descriptor `inboxPath`); quoted DATA mentions are not false-positives. |
| `output-verify-guard.js` | PostToolUse (Bash, advisory) | **v0.69.0, Harness Phase-1.** Scans a completed Bash call's own stdout/stderr for common test/build-runner signatures (jest/vitest/pytest/go test/npm run build/tsc) and flags when BOTH a passing signal ("8 passed", "PASS", "ok") and a failing signal ("2 failed", "FAIL", a confirmed non-zero exit) appear in the SAME run — the shape of a partial-pass summary easy to mis-report as a clean "tests pass". Fail-open on any shape surprise (the exact PostToolUse Bash `tool_response` field shape is undocumented); never blocks. |
| `failure-root-cause-nudge.js` | PostToolUseFailure (Bash, advisory) | **v0.69.0, Harness Phase-1.** Fires when a Bash tool call fails (non-zero exit/tool-level error); injects one short reminder pointing at `/anti-hall:root-cause` — deliberately terse since OMC already injects its own root-cause reminders in this harness. Fail-open always; off-switch `ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE=off`; skip-guard hatch `failure-root-cause-nudge`. |
| `edit-guard.js` | PreToolUse (Write/Edit/MultiEdit/NotebookEdit) | Blocks a COORDINATOR from editing files directly — requires delegating the edit to a subagent (always allowed; DevSwarm-aware block wording when the liveness supervisor is active, topology-aware: "primary/main orchestrator" vs "sub-orchestrator"). Root-anchored allowlist (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`, `.claude/**`, `.omc/**`, `.anti-hall/**`, root `PLAN.md`/`plan.md`/`STATE.json`/`CONTINUE-HERE.md`, `*.continue-here.md`, the out-of-cwd `.claude/projects/**/memory/**` store), extensible via `ANTIHALL_EDIT_GUARD_ALLOW`. Skip-guard hatch: `edit-guard` (not in the destructive set). Fail-open. **v0.64.0:** also exempts PLAN MODE for non-source targets, narrowed by an `isLikelySource` classifier so undelegated source-file writes stay blocked even in plan mode. |
| `coordinator-detect.js` | Shared module (not a hook) | The single coordinator-vs-subagent discriminator, extracted from `command-guard.js` so `edit-guard.js` (and `graphify-guard.js`) reuse the exact same detection logic instead of duplicating it. |
| `model-routing-guard.js` | PreToolUse (Agent/Task) | Anti-waste routing — classifies spawn descriptions (mechanical vs complex) and blocks/advises toward the cheapest fitting model. Strict by default (v0.35.0+): unconditional block on omitted-model mechanical spawns. Set `ANTIHALL_MODEL_ROUTING=advisory` (**project-scoped env**) to opt out and revert to advisory-only. Debate role-words in spawn description downgrade row-1 block to advisory. Fail-open; unknown model tokens always allowed. |
| `omc-detect.js` | Shared helper (not a hook) | Detects whether an oh-my-claudecode autonomous loop is active + fresh. Consumed by `task-guard` / `tasklist-guard` to suppress Stop-blocks to advisory when an OMC loop is running, preventing deadlock. Fail-open = NOT deferring. Kill-switches: `DISABLE_OMC=1` or `OMC_SKIP_HOOKS` including `persistent-mode`. |
| `hooks/lib/devswarm-detect.js` | Shared helper (not a hook) | **OPTIONAL, feature-gated** — mirrors `omc-detect.js` for the opt-in DevSwarm liveness supervisor: reports whether it should be considered active for this session/environment. Dormant (zero effect, byte-for-byte identical to today) unless `DEVSWARM_REPO_ID` is set (auto mode) or `ANTIHALL_DEVSWARM_SUPERVISOR=on`. Consumed by `doctor.js`'s per-workspace DevSwarm check. Fail-open = NOT active. Kill-switch: `DISABLE_ANTIHALL_DEVSWARM=1`. |
| `hooks/lib/devswarm-role.js` | Shared helper (not a hook) | **OPTIONAL** — topology gate distinct from `devswarm-detect.js`: answers only "is THIS session a DevSwarm CHILD workspace?" via `DEVSWARM_SOURCE_BRANCH` (non-empty = child, empty/unset = Primary). Fail-open = Primary. Consumed by `devswarm-child-role.js`. |
| `hooks/devswarm-child-role.js` | SessionStart | **OPTIONAL, feature-gated** — Layer 1 of the DevSwarm layered recovery model: for a DevSwarm CHILD workspace only (both `devswarm-detect.js` active AND `devswarm-role.js` child), injects a reminder to proactively self-report idleness (`hivecontrol workspace message-parent`) rather than sit unnoticed. Silent no-op for Primary/non-DevSwarm sessions. **v0.65.0:** also injects the blocking-question escalation protocol into every workspace — a child forwards a blocked decision to its parent (`send --to-primary`) with the options, its recommendation, and the default it will take if unanswered by its deadline, keeps working every other unblocked item, and proceeds on that default while flagging the assumption loudly; only an unauthorized destructive/irreversible action is a hard stop. Ladder is child → parent → human, never child → human; the parent side gets the matching reply-and-escalate directive. |
| `devswarm-parent-inbox.js` | UserPromptSubmit | **OPTIONAL, feature-gated** — mechanical trigger for the "Primary neglects child workspaces" failure (claude-code#39755). For a Primary DevSwarm session only: each turn surfaces the real unread/idle state of active workspaces, and recommends archiving any workspace the store derived as complete (`archive_ready`). Reads the durable-inbox files + the supervisor's verdicts + `summary.json`; never runs git/`computeLiveness` on the hot path. **(0.54.1)** Also injects a compact live table EVERY turn — one row per active workspace: status (`escalated`>`stale`>`archive-ready`>`idle`>`active`>`dormant`, attention first) / finish-rate (required gates met/total + optional heartbeat %) / unread / last-activity; capped at 12 rows with a logged `+N more`. **(0.60.0)** A row idle beyond `ANTIHALL_DEVSWARM_IDLE_MS` (default 6h, ms) is relabeled `active`→`idle` — a view-only demotion (no delete, no gate change, no archive) so a long-verified-done workspace stops reading as "active" forever; never overrides `escalated`/`stale`/`archive-ready`. **(0.67.0)** Each row now renders `name (shortid)` instead of a bare UUID, reading the `devswarm-names.js` fs cache only — never spawns `hivecontrol` on this hot path — falling back to the raw id when no name is cached. **(v0.70.0)** The normal-tier unread segment's wording was softened from a per-turn "STOP ... before continuing" imperative to advisory phrasing (`tierOf` already routes urgent/high workspaces to the separate loud segment, which is unchanged). **(v0.70.1)** New `dormant` tier (rank 5, sorts last, below even `active`): a DevSwarm mesh/registry row outlives its workspace — closing a workspace in the DevSwarm app deletes nothing (registry row, worktree, descriptor, and `hivecontrol workspace list` entry all survive) — so a row whose newest known activity signal is at least `ANTIHALL_DEVSWARM_DORMANT_MS` old (default 30 min, ms) is labeled `dormant` instead of `active`/`idle`, since only heartbeat/verdict AGE reliably separates a live workspace from one closed with no teardown signal. It demotes, it never hides — a dormant row still renders with its unread count, only ranked last, so a genuinely-live-but-quiet workspace can never go invisible; it never overrides `escalated`/`stale`/`archive-ready`, and the threshold is a heuristic, not proof a workspace is closed. **(v0.74.0)** Report-only git ground-truth risk markers are appended to a row's workspace-title cell (never a new column): `⚠ no upstream` or `⚠ N unpushed` (from the child's heartbeat-carried `gitPushState` probe, `companion/lib/devswarm-git-truth.js`), and `merged (unverified)` on an `archive-ready` row whose `merged` gate was self-declared but never proven by git ancestry (`merged_verified !== true`). Never blocks or implies anything beyond "look before archiving". Silent no-op otherwise. |
| `devswarm-parent-gate.js` | Stop | **OPTIONAL, feature-gated** — Primary-only, capped/loop-safe. Blocks the Primary from ending its turn while a child still has unread backlog past its cursor OR the supervisor already judged a child stale/escalated OR **(0.56.0)** the Primary's OWN summary-projected unread is nonzero (read from `summary.json`, no DB open) — surfaced with the same imperative "STOP and read them FIRST via `devswarm.js inbox read-primary <id>`" wording the child gate uses, so a Primary can no longer end its turn while sitting on its own unread inbound. **(0.61.1)** "Unread backlog" now counts only REAL unread — system-generated poke/mirror noise (`companion/lib/devswarm-noise.js` `isNoiseText`) is excluded, closing a ghost-workspace feedback loop where a backlog consisting solely of the Primary's own mirrored poke nagged on every Stop; an unparseable row/unreadable inbox still counts as real (fail-open). Registration also now precreates an empty durable inbox so a freshly-registered child reads as known/empty, not absent. **(0.62.0)** A `stale`/`escalated` verdict is now suppressed (never gates on the liveness axis) when the workspace has a FRESH heartbeat — definitive proof-of-life, since a heartbeat is emitted only by the workspace's own live session — while the real-unread coordination axis is untouched (a live, heartbeating workspace with genuine unread backlog still gates). Reads only files (fs cursor + the supervisor's verdict file + the summary projection + the heartbeat file) — no git, no live liveness on the ~30 s Stop path. Fail-open. **(v0.69.0)** The gate can no longer be satisfied by merely READING a child's blocking `--question` — it now requires an OBSERVED reply, checked against a durable per-project reply-state file (`companion/lib/devswarm-reply-state.js`) that `devswarm-parent-reply-tracker.js` writes on every successful `send --to <id> --question`. The forced-ack cap can no longer silence an unanswered question forever — once exhausted it escalates once with distinct wording instead of going silently quiet; every Primary turn also re-asserts the obligation. **(v0.71.0)** `devswarm-reply-state.js`'s storage is now an append-only JSONL log instead of a lockfile read-modify-write: `recordReply` is one `O_APPEND` write (no lock), `readReplyState` folds the log with a fail-closed newline separator, a 480-byte record cap, and a `__proto__`-safe fold accumulator — structurally eliminating the disclosed steal-branch TOCTOU. A loss-safe migration (`migrateReplyState`) is wired into `update.js`/`doctor-repair.js`. |
| `devswarm-parent-reply-tracker.js` | PostToolUse (Bash) | **NEW in v0.69.0, OPTIONAL/feature-gated, Primary only, observe-only** — watches every Bash call for a successful `devswarm.js send --to <id> --question ...` and records it via `devswarm-reply-state.js`'s `recordReply()`, keyed by a durable per-project `repoKey` (not a Claude `session_id`) so `devswarm-parent-gate.js` can tell "read" apart from "decided and replied". Anti-spoof guarded (the response shape alone is not trusted without the input command also plausibly being a real `send` call); never blocks, writes nothing to stdout; fail-open on every error. |
| `devswarm-child-turn.js` | UserPromptSubmit | **OPTIONAL, feature-gated** — child-only. Writes a turn-authored heartbeat (`heartbeats/<DEVSWARM_BUILDER_ID>.json`, unique per child — falls back to a sanitized/hashed `<branch>` key only when `DEVSWARM_BUILDER_ID` is absent; never a background ticker) and reminds the child to report to its parent. **(0.54.1)** Also surfaces a non-destructive unread-count check against the child's OWN durable descriptor inbox — PARTIAL: this only makes an already-populated durable inbox visible to the child; nothing shipped yet drains the child's native parent→child queue into it (v0.54.2 follow-up). **(0.56.0)** The unread surfacing is now IMPERATIVE PRIORITY wording ("STOP and address... FIRST"), scans unread lines for a `[[ANTIHALL_ARCHIVE_REQUEST]]` marker and surfaces a distinct confirm-then-archive segment when found, and mechanically writes/refreshes the child's own descriptor every turn (MERGE-preserving) so the parent can always discover it. Silent no-op otherwise. **(v0.69.0)** Self-continue directive: tells the child to keep issuing tool calls across rounds of a multi-round autonomous task within the same turn, reserving `Stop` for a genuine block, final completion, or an unrecoverable error — cutting the wake-cycle (supervisor cron) latency a per-round idle-out previously cost. Shared verbatim with the Codex port. **(v0.74.0)** `writeHeartbeat` also attaches one report-only `gitPushState` probe per turn (`companion/lib/devswarm-git-truth.js`) — `noUpstream`/`unpushed`, resolved from the worktree at `cwd`, omitted entirely (never fabricated) when the worktree or probe doesn't resolve — surfaced to the parent as a risk marker by `devswarm-parent-inbox.js`. |
| `devswarm-child-gate.js` | Stop | **OPTIONAL, feature-gated** — child-only, capped/loop-safe. Forces the child to self-report to its parent before going idle, so a child that finishes a turn pings the parent instead of dropping off its radar. **(0.54.1)** Heartbeat-freshness silencing REVERTED: the brief v0.54.0 "fresh heartbeat satisfies the gate" logic false-silenced a child that worked <5 min then stopped without reporting, so the gate always demands at least one real report per unchanged blocking state, bounded only by the per-episode cap `MAX_BLOCKS = 2`. **(0.56.0)** STRICT mode (`ANTIHALL_DEVSWARM_CHILD_GATE_STRICT`, default ON) backs the durable-inbox check with one bounded non-destructive `hivecontrol workspace message-count` probe (5 s timeout) when the durable check shows nothing, to catch a native backlog the child never `inbox pull`ed. Fail-open. **(v0.73.0)** Reads the shared union unread primitive (`companion/lib/devswarm-unread.js`, NDJSON ∪ store-only mesh-direct backlog, hash-deduped) instead of NDJSON alone, and splits its messaging into "CHILD NOT DRAINING" vs "YOUR INBOX" segments naming the workspace by title. |
| `devswarm-child-drain.js` | PostToolUse (Bash) | **NEW in v0.73.0, OPTIONAL/feature-gated, child-only, throttled.** Closes the SkyCrew field gap where a DevSwarm child has no mid-turn re-entry: `devswarm-child-turn.js` fires once per `UserPromptSubmit`, never during a long autonomous task, so a mesh-direct `send --to` (store-only, invisible to an NDJSON-only reader) could sit unnoticed while the child kept working. Mirrors the Primary-only `devswarm-parent-reply-tracker.js` (same PostToolUse/Bash registration shape) but child-only: on every Bash call, reads the shared union unread primitive against the child's own descriptor and, when unread > 0, injects a drain reminder — throttled to re-inject only when the unread count changes or a 10-minute window elapses, so a busy child isn't nagged on every tool call. Fail-open throughout. |
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
| `fable-availability.js` | SessionStart (non-blocking) | Reads `~/.claude.json`'s `modelAccessCache`/`additionalModelOptionsCache` (the same cache Claude Code's own `/model` selector renders from) once per session — no live API probe, fail-open, silent unless Fable is actually available. When available, threads `args.fableAvailable=true` into ship-it/deadly-loop Workflow invocations so the Reviewer seat's fallback chain extends to Fable → Sonnet → Opus. |
| `codex-availability.js` | SessionStart (non-blocking) | OS-agnostic PATH probe (Windows `PATHEXT`-aware) for a real `codex` executable; writes `~/.anti-hall/codex-availability.json` (`{available, checkedAt, source}`) once per session so coordinators/skills read the cached fact instead of re-probing. Proves reachability only, NOT authentication/readiness — a runtime spawn can still fail even when `available:true`. Registered on both the Claude plugin and the Codex port. Fail-open. |
| `graphify-session.js` | SessionStart | Primes "query the graph first" when a graphify graph exists. |
| `handover-resume.js` | SessionStart | On a fresh session (including after `/clear` or compaction), surfaces the latest `.anti-hall/handovers/` entry (if any) and guides a structured resume from it — supersedes the lossy default compact summary. Fail-open (silent no-op if no handover exists). Registered on both the Claude plugin and the Codex port. |
| `graphify-reminder.js` | Stop | One-time reminder to update the graph after real edits. |
| `speculation-guard.js` | Stop | Blocks once when the last assistant message contains hedge-word speculation without an evidence/uncertainty acknowledgment. Always-on (lexical, Tier 2). |
| `speculation-judge.js` | Stop | OPT-IN semantic judge: calls an LLM to catch confident inference-as-fact with no hedge word. Off by default; enabled by `ANTIHALL_SEMANTIC_JUDGE=1`. |
| `codex-nudge.js` | Stop (advisory) | Nudges once/session for an independent Codex second-opinion review when substantial code shipped with no Codex review; off-switch ANTIHALL_CODEX_NUDGE=off. |
| `ship-it-guard.js` | PreToolUse (Write/Edit/MultiEdit) | **OPT-IN, default OFF** — the only opt-in code-edit gate. With `ANTIHALL_SHIPIT_GATE` ∈ {1,true,yes,on}, blocks a CODE edit on a hard-risk path (migration / auth / `.github/workflows` / security) when no `PLAN.md` exists (repo root). Also does a conformance advisory (never blocks) for edits outside a PLAN.md's declared `files:` list. Enforces artifact existence only (not plan quality), conservative, fail-open. No effect when unset. |
| `merge-gate.js` | PreToolUse (Bash) | **OPT-IN, default OFF** — a backstop, not a guarantee. With `ANTIHALL_MERGE_GATE` ∈ {1,true,yes,on}, blocks an auto-merge (`gh pr merge` incl. `--auto`, `gh pr review --approve`, `git merge --no-ff/--ff` into main/master/develop, and `hivecontrol workspace merge-into-source`/`merge-from-source`) when the agent's own recent output carries an UNRESOLVED self-hedge ("pending review" / "first-pass" / "needs your eyes" / …) not followed by a resolution token. Keyword-heuristic, bypassable, fail-open, cannot hard-loop; no effect when unset. |
| `root-cause` / `orchestration` / `ship-it` / `deadly-loop` (+ `deadly-loop-multi`, `install-statusline`, `doctor`, `system-briefing`, `update`, `flutter-debug`, `activate`, `simplify`, `debt`, `devswarm`, `handover`) | Skills | Slash commands (see [Skills](#skills)). |
| `statusline/` | Statusline | Rich line 1 for ANY repo (monorepo or simple); the monorepo/simple renderer is only a fallback if the rich renderer yields nothing. Line 2 is an always-on phase/context bar. |
| `companion/mcp-reaper.js` (+ `install-reaper.js`) | Interval companion (not a hook) | **OPT-IN**, macOS + Linux. Kills ONLY orphaned MCP-server processes (parent already died). Install via `node companion/install-reaper.js` (`--uninstall` to remove); Windows is a documented no-op. See [`companion/README.md`](companion/README.md). |
| `companion/devswarm-supervisor.js` (+ `install-devswarm-supervisor.js`) | Interval companion (not a hook) | **OPT-IN and OPTIONAL** — dormant with zero effect unless DevSwarm is in use (feature-gated via `devswarm-detect.js`, same optionality model as the OMC/OMX integration). Detects a wedged/idle DevSwarm workspace agent from outbound activity (session transcript + git/worktree) and pokes it (an optional descriptor `nudgeCommand`) or escalates (log + optional `escalateCommand`) — **never kills**. Install via `node companion/install-devswarm-supervisor.js` (`--uninstall` to remove); macOS + Linux full, Windows detection-only. Workaround for claude-code#39755. **v0.66.0:** a cooldown-gated reconcile sweep now also runs on this existing supervisor, so stranded mesh messages self-recover instead of sitting until an update or a manual repair happens to invoke `reconcile` — it uses the same single-consumer lock as the drains, so it cannot race a live one. |
| `companion/devswarm-recover.js` | On-demand CLI (not a hook) | **OPT-IN and OPTIONAL** — the ONLY path in DevSwarm that ever kills a process. `node companion/devswarm-recover.js <workspace-id>` resolves the one confirmed wedged `claude` target and kill+resumes it (`claude --resume`), headless or interactive (naming the id is the deliberate override). Same confirm-gate safety as the old always-on supervisor. Windows: escalate-only. |
| `companion/lib/devswarm-store.js` | Substrate lib (not a hook) | **OPTIONAL** — the persistent write/derive side of the DevSwarm substrate. ONE API, TWO backends chosen by feature-detecting `node:sqlite` (→ WAL sqlite, else an append-only NDJSON journal — dependency-free, green on Node 18/20 through 22/24). **Hooks never open the DB**: it derives a `summary.json` projection (atomic tmp+rename) that hooks read. Tracks messages/registry/cursors + per-workspace append-only completion `gates`, and derives `archive_ready` when all required gates (configurable, default `done,merged,tests_passed`) are met. anti-hall stays agnostic about what any consumer gate means. **(v0.70.0)** New read-side filter `archivedOnlyIds` excludes a genuinely archived workspace (`archived/<id>.json` present, `workspaces/<id>.json` absent) from the LIVE per-turn projection immediately, without waiting for a `doctor`/`update` migration run — an archived workspace with real unread still surfaces via the `orphans[]` pass (no lost signal); structurally cannot hide a live row (a live workspace has its own descriptor by definition), fails open to an empty set on any read error. |
| `scripts/devswarm.js` | CLI (not a hook) | **OPTIONAL** — THE structured interface (CLI over MCP; stable JSON on stdout). Subcommands: `register`/`ensure`, `heartbeat`, `inbox count\|read\|ack` (the durable-inbox cursor primitive — `ack` is the parent-gate's non-skip clear path), `inbox pull` (child-side reception drain — auto-ensures the descriptor, then ONE bounded guard-safe pull: non-destructive `message-count` gate → at-most-one bounded `read-messages`, never `monitor` → atomic idempotent NDJSON append + store parity), `inbox messages`/`read-primary` (Primary/store non-destructive read — bodies straight from the store, no descriptor needed; **ack-ownership guard, 0.56.0:** `--ack` refuses [`ok:false`] unless the caller's own identity, derived from cwd as ground truth, matches `<id>` — `DEVSWARM_BUILDER_ID` cannot override a *different* cwd-derived identity; pass `--ack-as-owner` for a legitimate cross-workspace ack), `workspaces list`, `gate --set/--clear`, `nudge`, `archive` (archive-by-absence on anti-hall's own registry — hivecontrol has no teardown command, so it SURFACES a manual "remove workspace in the DevSwarm app" step; never deletes; **v0.70.1:** `<id>` also resolves an unambiguous shortId/prefix, matching the id shown in the injection/roster table — an ambiguous prefix archives nothing and lists the candidates; `isSafeId` still gates), `archive-request` (**0.56.0**, PARENT-side send-only — posts a `[[ANTIHALL_ARCHIVE_REQUEST]]` message to the child via `hivecontrol workspace message-child`, asking it to archive; never verifies merged/tested/deployed itself, never archives on the child's behalf), `archive-ignore`/`archive-unignore`, `migrate` (`ANTIHALL_DEVSWARM_MIGRATE_MARK_READ=1` marks an imported legacy backlog as already-read). `command-guard` has a root-anchored LIGHT_EXCEPTION for it so the guard doesn't block its own wrapper. **v0.61.0 mesh self-heal:** drain-aware routing on `send` resolves to the partition a child is actually draining, plus a phantom-only rescue on the child's first mechanical self-register; new read-only `diagnose` (mesh-health detail: split/duplicate detection, orphans, stale partitions) and `healthcheck [--json]` (pass/fail, exit 0/2, for monitors/CI/the ingest daemon) verbs; register-time dedup filtered through a new `isForwardable` noise filter (forwards only real directs, never poke/hash-mirror junk); `roster`/`workspaces list`/`diagnose` are now pure reads (no `summary.json` write side-effect). **v0.62.0:** `unarchive <id>` (reverses `archive` — restores an archived descriptor + registry row); `migrate-owner-keys` (forward-migration backfilling/re-homing a descriptor's `ownerKey`, idempotent/fail-open/no-delete); `reap-stale [--yes|--confirm]` (dry-run-by-default reaper for descriptors verdicted stale/escalated, gated by fresh-heartbeat/recent-git-activity safety checks); `reconcile-active [--active id,...] [--allow-empty] [--stdin] [--yes|--confirm]` (archives every current workspace NOT in an explicit active set, dry-run by default); `send --to` now ALSO accepts a row's own `id` (the registry primary key) as a fallback when the meshId match finds nothing, and `roster` now prints `meshId` alongside `id` on every row — closes an addressing footgun where a value copied straight from `roster` used to fail closed as `unregistered-recipient`; `reconcile` runs a mis-keyed/stray-registry-row self-heal pre-pass (`healRegistry`) before computing its drain targets, and `doctor --fix`/`update` ALSO sweep every per-project store for this directly (AUTO-SAFE, no DevSwarm-active gate needed), idempotent and no-delete. **v0.66.0:** `heartbeat` and `reconcile`'s aggregate `ok` no longer report success while a mesh broadcast failed or an individual drain target crashed/timed out — a genuinely absent hivecontrol is a benign skip, not a failure; `logs` now reads rotated history, not just the live file. **v0.67.0:** `spawn` sets a human-readable title after a successful `hivecontrol workspace create`, via a SEPARATE best-effort `hivecontrol workspace update-title -b <branch> "<title>"` call derived from the `-p` brief (first non-empty line, one leading markdown marker stripped, whitespace collapsed, 60-char word-boundary truncation) unless the caller already passed `-t/--title`; `spawn`'s pass-through of the original argv to `hivecontrol workspace create` is untouched. `reconcile` caches whatever label hivecontrol already has for a pre-existing workspace but never invents one for a workspace with no brief on record. Fixed a raw NUL byte (a deliberate collision-proof sentinel key, offset 81252) that made `grep` treat the 245KB file as binary — replaced with the `\x00` escape, runtime string unchanged — and a `hasFlag` redeclaration collision where a new helper silently shadowed the pre-existing one and broke `--yes`/`--confirm` detection across `reconcile-active` and `reap-stale`. **v0.70.1:** `roster` now appends the same `dormant` hint (via `companion/lib/liveness.js`'s `isDormantActivity`) that `devswarm-parent-inbox.js`'s table uses, so the two can never disagree about which rows are still transacting. **v0.70.0 mesh/store hardening:** `foldArchivedRegistryRows` (new) folds ALL registry rows sharing an archived id's worktree (not just its own row) and picks the forward survivor by LIVENESS (`pickArchiveForwardSurvivor`), fixing a P0 where a real question could forward into a dead partition; ships as a dual-path migration wired into both `update.js` and `doctor --fix`'s `migrationFix('fold-archived-rows', ...)` — idempotent, fail-open-honestly, no-delete (message rows are never deleted, only registry rows are tombstoned after their unread forwards). `archive` also gained a descriptor-conflict self-heal (`archivedTombstoneIsOrphaned`, decided by inode not registry state, fail-closed on any incomplete scan) unblocking re-archive of an id whose `archived/<id>.json` was a stale leftover from a prior archive generation. **v0.71.0:** `register-primary`'s `--session` now defaults to `CLAUDE_CODE_SESSION_ID` (was the workspace hash), so a Primary registry row resolves its real transcript for liveness reads instead of a synthetic id nothing else recognizes. **v0.74.0:** `gate --set merged` now also runs a best-effort git-ancestry check (`companion/lib/devswarm-git-truth.js`'s `gitMergedInto`, HEAD vs. the resolved default branch) and persists the verdict as a separate `merged_verified` gate row alongside `merged` — REPORT-ONLY, the `merged` gate is set regardless of the verdict (a squash/rebase merge legitimately breaks ancestry even though the work IS merged); a resolved-false verdict prints a stderr warning and shows as `merged (unverified)` on the parent roster, an unresolvable check (no default branch / spawn failure) omits `merged_verified` entirely. |
| `companion/lib/devswarm-names.js` | Substrate lib (not a hook) | **OPTIONAL — new in 0.67.0.** The shared fs-backed name cache behind human-readable workspace names: written by `devswarm.js` (`spawn`'s `update-title` call, `reconcile`'s pre-existing-workspace label cache) and read by `devswarm-parent-inbox.js`'s status table. Atomic tmp+rename write; a read failure fails open (falls back to the raw id). |
| `companion/lib/devswarm-git-truth.js` | Substrate lib (not a hook) | **OPTIONAL — new in 0.74.0.** Two independent, fail-open git ground-truth probes for a DevSwarm child worktree: `gitPushState` (unpushed-commit count + whether an upstream is even configured) and `gitMergedInto` (best-effort HEAD-vs-default-branch ancestry check). REPORT-ONLY throughout — `null` on any probe failure (never a fabricated fact), same argv-array `spawnSync` convention as `liveness.js`'s `defaultGitCommitTs`. Called from `devswarm-child-turn.js` (heartbeat push-state) and `scripts/devswarm.js`'s `gate --set merged` (merged-gate verification). |
| `foldMeshDuplicates` (in `scripts/devswarm.js`) | Migration (not a hook) | **v0.61.0** — folds every prior mesh store shape (phantom rows, dual/legacy pairs, subdir-split registrations, stale entries) onto one canonical survivor per worktree, keyed by git-toplevel canonical identity (a child registered from a subdirectory now resolves to the same mesh identity as its toplevel). Idempotent, non-destructive (forward-before-tombstone; message rows are never deleted), fail-open. Wired into both `update.js` (runs post-update) and `doctor`'s auto-safe repair (the dry-run detect pass doubles as a read-only mesh-shape check under `--check`, then applies). |
| `companion/devswarm-migrate.js` (+ `devswarm-ingest.js`) | Substrate lib / daemon (not a hook) | **OPTIONAL** — `migrate` dual-reads existing on-disk state (JSON registry + legacy NDJSON inboxes) into the store: **idempotent** (dedupe hash), **non-destructive** (reads sources only — legacy files stay byte-for-byte, rollback always possible), single-consumer-locked, and count-verified before it reports success. `devswarm-ingest.js` = the one supervised daemon wrapping the native `monitor` → store; refuses to start if another monitor consumer is running (lockfile), enforcing the single-native-consumer invariant. |
| `companion/install-devswarm-ingest.js` | Installer (not a hook) | **OPTIONAL — new in 0.54.1.** Installs/refreshes `devswarm-ingest.js` as a CONTINUOUS supervised daemon (unlike the periodic supervisor sweep): macOS LaunchAgent with `KeepAlive` (re-exec on exit), Linux `systemd --user` `.service` with `Restart=always` (cron fallback — every minute, restart-if-dead — when `systemctl` is absent; up to ~60 s revive gap on a cron-only Linux host after a crash). Distinct label (`com.anti-hall.devswarm-ingest`) and log (`~/.anti-hall/devswarm-ingest.log`) from the supervisor. Idempotent; safe to install redundantly (the daemon's own single-consumer lock means only one instance ever runs). Windows: documented no-op (no pure-Node long-running user scheduler). **Autonomous refresh:** the `update` skill runs this installer's `how` command automatically (no offer, no ask) whenever an update happens inside an active DevSwarm session, same posture as the supervisor installer — closing the gap where the ingest daemon existed in code but nothing started it. **Cwd caveat:** the daemon drains the workspace of the git worktree it is INSTALLED FROM (`hivecontrol` resolves a workspace by cwd, not env) — the installer bakes that install-time worktree as the unit's `WorkingDirectory` and refuses to install if run from a non-git-worktree cwd. **v0.65.0:** root-caused an ENOENT storm — the daemon spawned `hivecontrol` by bare name while the service manager supplied only a minimal `PATH`, so every monitor cycle failed invisibly. The installer now discovers the binary once at install time and bakes it into the generated launchd/systemd/cron unit (never a hardcoded path); the daemon resolves it from an explicit option, `ANTIHALL_DEVSWARM_HIVECONTROL`, or `PATH`. Permanent faults (ENOENT/EACCES/ENOTDIR) now escalate through a capped backoff instead of storming the log, sliced so the heartbeat keeps writing. Orphaned ingest locks are swept on daemon start with positive-confirmation-only removal (a recycled pid or zombie holder no longer blocks restart forever; unknown holder states block by default). **v0.66.0:** a monitor batch that arrives but fails to parse is now logged and quarantined to disk instead of vanishing via the consume-on-read native queue (a well-formed empty result is still normal, not an error); the singleton supervisor unit now carries the same resolved `hivecontrol` path as the per-project units. |

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
  SessionStart is the primacy slot. Its companion `verify-first-orch.js` (also
  SessionStart) carries the always-on orchestration ruleset (rules A–N + the
  DevSwarm-Primary workspace-tier rule W) — split out in 0.60.0 so both halves
  clear the ~10k per-hook injection cap and land 100% inline instead of one
  spilling to a file past ~2k chars.
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
| 1 | `verify-first-full.js` + `verify-first-orch.js` + `verify-first.js` | Always-on | Protocol injection (SessionStart + per-turn nudge): names every rationalization bypass including confident inference-as-fact and hedge-word speculation. | Zero (no API call; text injection only). |
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

**Cost and latency detail:** one `claude-haiku-4-5` call per Stop event when enabled
(env-overridable via `ANTIHALL_JUDGE_MODEL`; the one hardcoded model id in this codebase,
since it's a direct Anthropic API call with no alias-resolution support).
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
`verify-first-full.js` + `verify-first-orch.js` (SessionStart) and `verify-first.js`
(per-turn nudge), so they apply without being invoked. The full step-by-step playbooks below are still available as
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
  `decisions.md`, routes build seats Codex-primary with Sonnet failover (a
  cross-model guard skips the Sonnet Reviewer when a phase's build fell back to
  Sonnet, to avoid same-model self-review), and closes out with a session-history
  entry + `SUMMARY.md` + a `graphify update .` trigger. **v0.67.0:** the per-phase
  gate previously ignored dead review seats entirely, so fewer live seats produced
  fewer findings and a silently PASSING `converged: true` — missing review coverage
  is no longer indistinguishable from a clean pass. The gate result now carries
  `totalSeats`/`liveSeats`/`deadSeats`/`degraded`/`seatReports`, and `converged`
  requires `deadSeats === 0` — a phase that loses a seat now correctly fails to
  converge where it previously passed silently. Also honors `args.codexAvailable`
  (mirroring deadly-loop, including the Opus adversarial-persona fallback).
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
  silent and skipped for any integration that isn't in play. **v0.61.0:** repair mode
  also auto-safe-folds every prior DevSwarm mesh-store shape (phantom/dual/subdir-split/
  stale) onto one canonical worktree via `foldMeshDuplicates`; the dry-run detect pass
  doubles as a read-only mesh-shape check under `--check`. **v0.65.0:** the heartbeat now
  carries the monitor outcome, so an ingest daemon that is alive but failing every cycle
  (e.g. a permanent ENOENT/EACCES/ENOTDIR config fault) is reported as a FAILURE rather
  than healthy, with a one-line in-session banner; a heartbeat missing these fields
  (pre-upgrade daemon) reads as unknown, never a fault. New explicit, opt-in
  `--reclaim-ingest-lock` sweeps orphaned locks and reclaims a contended one (positive OS
  confirmation required before any removal), then reinstalls — never runs automatically.
  Install-time also detects a memory-guard/reaper script that would kill the
  service-managed daemon and reports the exact allowlist entry to add.
- **`/anti-hall:update`** — updates anti-hall in place: `git pull --ff-only` the
  marketplace clone, syncs the version-pinned cache (semver-anchored, traversal-proof),
  prints the changelog delta between installed and latest, then instructs
  `/reload-plugins` for in-session reload. Hooks and statusline pick up from disk
  immediately; `/reload-plugins` refreshes the skill list and version label. `--check`
  mode answers "is anti-hall up to date?" without pulling or writing. After a pull, also
  runs `scripts/migrate-state.js` once per repo (idempotent) to fold legacy root
  `.anti-hall-progress.md` / `.anti-hall-history.md` into `.anti-hall/history/legacy/`,
  runs the same `foldMeshDuplicates` DevSwarm mesh-store migration doctor's repair uses
  (v0.61.0), then a **dynamic capability scan** (`scripts/capability-scan.js`, read-only)
  reports each opt-in capability shipped in this build (companions discovered from
  `companion/install-*.js`, statusline, pending state migrations) as available-vs-active
  on this machine, with the exact command to enable any gap — never auto-installs.
- **`/anti-hall:devswarm`** — explains anti-hall's optional DevSwarm integration: the
  `hivecontrol` reference KB, the designed-but-unbuilt workspace-tier orchestration, the
  shipped **layered recovery model** (child self-report → supervisor poke → escalate —
  the automatic path never kills), and the **on-demand `devswarm-recover` CLI** (the
  only path that ever kills), including the full activation checklist and tunable env
  vars. **v0.61.0:** also covers the mesh **self-heal** set — drain-aware routing +
  phantom-only rescue, the `orphans[]`/`staleRegistryPartitions[]` health projection,
  the `diagnose`/`healthcheck` read-only verbs, and `foldMeshDuplicates` migration.
- **`/anti-hall:handover`** — writes a comprehensive, organized, minimal-but-lossless
  session handover under `.anti-hall/handovers/`: a global index plus a per-session
  `HANDOVER.md` (front-loaded, fixed SBAR-derived schema, ≤200 lines) and detail files
  (`state.md`/`decisions.md`/`trials.md`/`knowledge.md`), sequence-chained to prior
  handovers, so a fresh session can resume without re-deriving or guessing anything.
  Paired with the `handover-resume.js` SessionStart hook, which surfaces the latest
  handover automatically after `/clear` or compaction. Codex mirror:
  `codex/skills/anti-hall-handover`.

`MODEL-POLICY.md` is the shared TRIO roster (Reviewer = Sonnet `model:"sonnet"` effort `xhigh`;
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
any OS with Node; anti-hall itself is tested on macOS + Linux only — Windows is
untested and not officially supported, though this snippet has no POSIX-only calls):

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
node --test                                                                  # 2693 pass +2 skipped (2695 total); CI runs the same on push/PR (.github/workflows/test.yml)

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
  macOS and Linux (CI-tested) and never wedge a turn. Windows is untested and not
  officially supported (v0.69.0 dropped it from the CI matrix); avoid POSIX-only calls
  regardless, since pure-Node code may still work there.

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
so there's no kill-then-resume window to watch for being "stuck"). **v0.66.0:** doctor no
longer reaps a unit as "confirmed running and healthy" from a weaker second health check
that omitted the pid guard and the monitor-fault check — there is now one `daemonHealth`
definition, used by every consumer including this reaper.

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
