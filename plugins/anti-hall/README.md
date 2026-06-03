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
| `verify-first-full.js` | SessionStart | Full Iron-Law + rationalization-table protocol, the always-on orchestration discipline, and the always-vs-conditional skill primer; survives compaction. |
| `verify-first.js` | UserPromptSubmit | Short, varying one-line nudge each turn (anti-habituation). |
| `git-guard.js` | PreToolUse (Bash) | Blocks AI self-credit commit trailers and `git push --force`. |
| `api-guard.js` | PreToolUse (Write/Edit/MultiEdit) | Blocks code that references a **non-existent** stdlib/builtin API — resolves `module.attr` in the code-to-be-written against the installed `python3`/`node` and refuses the write when the attribute is fabricated. The mechanical answer to API hallucination. Default = stdlib/builtins (import-safe); opt-in `ANTIHALL_API_GUARD_THIRDPARTY=1` also checks installed 3rd-party packages (off by default — verifying a package imports it, running its code at edit time). 0 FP + full in-scope catch on `eval/api-guard-bench.js`; never probes local/relative modules; fail-open; skip-hatch. |
| `command-guard.js` | PreToolUse (Bash) | Keeps the coordinator clean — blocks heavy commands inline, pushes them to subagents. Subagent-aware via payload, per-segment (quote-aware). |
| `swarm-guard.js` | PreToolUse (Agent/Task) | Anti-fork-bomb — spawn-rate cap + real reclaimable-memory check (`vm_stat` / `MemAvailable`, not `os.freemem()`). |
| `phase-tracker.js` | PreToolUse (Agent/Task) | Records every subagent spawn so the statusline shows live swarm activity. Never blocks. |
| `agent-watchdog.js` | CLI helper (not a hook) | Heartbeat enforcer — scans `~/.anti-hall/agents/*.json` and reports stale/hung subagents; run manually by the orchestration skill. |
| `task-tracker.js` | UserPromptSubmit | Injects task-list discipline (capture, prioritize, work in order) + a one-line freshness note when open/stale tasks exist. |
| `task-guard.js` | Stop | Blocks once if the session ends with open tasks. |
| `tasklist-guard.js` | Stop | Blocks when non-trivial work (≥ threshold file-mutating actions) wasn't tracked as tasks or lacks a fresh `.anti-hall-progress.md`; coexists with `task-guard` with its own independent block cap; capped + fail-open. |
| `skip-guard.js` | Escape hatch (shared primitive) | TTL'd `~/.anti-hall/skip.json` user-override read by the guards; granular per-guard, and a broad `all` skip excludes the destructive git-guard (must be named explicitly). |
| `graphify-session.js` | SessionStart | Primes "query the graph first" when a graphify graph exists. |
| `graphify-reminder.js` | Stop | One-time reminder to update the graph after real edits. |
| `speculation-guard.js` | Stop | Blocks once when the last assistant message contains hedge-word speculation without an evidence/uncertainty acknowledgment. Always-on (lexical, Tier 2). |
| `speculation-judge.js` | Stop | OPT-IN semantic judge: calls an LLM to catch confident inference-as-fact with no hedge word. Off by default; enabled by `ANTIHALL_SEMANTIC_JUDGE=1`. |
| `root-cause` / `orchestration` / `feature-launch` / `deadly-loop` (+ `deadly-loop-multi`, `install-statusline`, `doctor`) | Skills | Slash commands (see [Skills](#skills)). |
| `statusline/` | Statusline | Rich line 1 for ANY repo (monorepo or simple); the monorepo/simple renderer is only a fallback if the rich renderer yields nothing. Line 2 is an always-on phase/context bar. |

## How it works

### Verify-first protocol (the core)

- **SessionStart full protocol** — `verify-first-full.js` injects the FULL
  verify-first + root-cause protocol in the Superpowers **Iron Law +
  rationalization-table** form. It names the specific bypass excuses ("probably",
  "should work", "seems to", "I'll just assume", "looks done", "tests pass on first
  run") and includes a skill primer listing the core 4 skills (root-cause, orchestration,
  deadly-loop, feature-launch) and when to reach for each. It also carries the always-on
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
  (one of 12 facets of the Iron Law), so the per-turn slot stays high-salience
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
flags (`git push "--force"`), bundled `-f`, and `+refspec` pushes are all caught.
**Documented fail-open scope:** it inspects only inline `-m` / `--message` trailers,
so `-F <file>` / `--file` and editor commits are not scanned, and interpreter
wrappers (`sh -c "..."`, `xargs`, an aliased `g push`) can bypass it. These are
documented boundaries, not silent gaps.

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
  `<cwd>/.anti-hall-progress.md`). It coexists with `task-guard` (which drains declared
  tasks) and keeps an **independent block cap** (`MAX_BLOCKS=3` cumulative/session) so the
  two never compound. The progress file is gitignored, never created by the hook, and must
  be updated this session (default 30 min freshness window) to count. Fully fail-open.
  See [`docs/TASKLIST-GUARD.md`](../../docs/TASKLIST-GUARD.md).

### User-override escape hatch (skip-guard)

The user's explicit instruction outranks any guard. When the user **clearly and directly**
asks the agent to skip a guard, the agent records that consent via the shared `skip-guard.js`
primitive — a TTL'd JSON marker at `~/.anti-hall/skip.json`, e.g.
`{ "tasklist-guard": <unix-ms expiry>, "all": <unix-ms expiry> }`. Every guard checks it at
startup and fail-opens while it is in effect; the marker auto-expires (default 15 min) so a
safety guard is never left silently disabled.

- **Granular:** name a single guard (`"speculation-guard"`, `"tasklist-guard"`, …) or use
  `"all"` to cover the noisy guards at once.
- **Safe default:** a broad `"all"` skip does **not** cover the destructive `git-guard`
  (force-push / AI-credit trailer) — to skip that, the agent must name `"git-guard"`
  explicitly.
- **Fail direction is inverted from the hooks:** a missing/corrupt skip file makes
  `isSkipped` return false, so the guard stays **active**. A broken skip file must never
  silently disable protection.

> **Five Stop hooks are registered** (`task-guard`, `graphify-reminder`, `speculation-guard`,
> `speculation-judge`, `tasklist-guard`), all emitting the top-level `{"decision":"block","reason":...}`
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
  (`graphify-out/` or `.planning/graphs/`), primes the model to query the graph
  first for any issue/feature/function/code/doc lookup, and to keep it updated.
  Silent no-op when graphify isn't used.
- `graphify-reminder.js` (Stop) — after a session with real edits and a graph
  present, surfaces a one-time reminder to run `/graphify --obsidian`. A Stop hook
  cannot inject `additionalContext`, so it nudges with a single soft `decision:block`,
  capped via `os.tmpdir` state so it never loops — stop again to dismiss.

## Skills

**Always-on vs conditional.** The **root-cause** and **orchestration** disciplines are
**enforced always-on via the hook layer** — their core fires every session/turn through
`verify-first-full.js` (SessionStart) and `verify-first.js` (per-turn nudge), so they
apply without being invoked. The full step-by-step playbooks below are still available as
slash commands for when you want the deep version. **deadly-loop** and **feature-launch**
are **conditional skills invoked on match** — they are not forced every turn. The
always-on orchestration injection enforces a **bias toward delegation** — default to a
subagent for any work that touches files/tools/commands/search/build/test or could
balloon (to avoid the eager "I'll just do it inline" trap that pollutes the main thread),
handling inline only genuinely atomic things (a direct answer, a single known-line read,
the coordinator's own synthesis/decisions), and delegating immediately if a quick inline
task balloons; parallel agents when independent; commands via Haiku off-thread. It also
enforces **capture-every-request** task discipline (priority-sorted) and
**anti-sycophancy** (challenge a wrong premise with evidence; user agreement is not
correctness).

Invoke via slash command:

- **`/anti-hall:root-cause`** — evidence-driven debugging: reproduce, collect
  evidence, instrument when missing, trace the sequence to the original + root cause
  (not the surface symptom), prove the hypothesis, fix at the root, verify.
- **`/anti-hall:orchestration`** — swarm with a non-blocking main thread: delegate
  heavy/long work to background + parallel subagents, partition to avoid conflicts,
  distribute load across Claude **and** Codex when available, run commands via Haiku
  so raw output never pollutes the coordinator's context.
- **`/anti-hall:feature-launch`** — plan-first protocol: author the plan in plan
  mode (blending superpowers planning + GSD, not GSD-dependent), enumerate edge
  cases and simulate every scenario, harden the plan with the deadly-loop BEFORE any
  code, then build phase by phase running the deadly-loop after each phase.
- **`/anti-hall:deadly-loop`** — iterative parallel Reviewer + Critic debate +
  fix-waves until convergence (zero NEW P0s). The debate engine behind
  feature-launch's gates.
- **`/anti-hall:deadly-loop-multi`** — scaled-up deadly-loop: N Reviewer + N Critic
  pairs with diversified lenses, then dedup + synthesize (double / triple / quadruple).
- **`/anti-hall:install-statusline`** — writes the statusLine setting (global by
  default, per-project on request) and reminds you to restart.
- **`/anti-hall:doctor`** — health-check: confirms Node is found, every hook is
  present + syntax-valid, and the guards actually fire (live behavioral self-tests on
  e.g. git-guard / command-guard / swarm-guard / speculation-guard / tasklist-guard).

`MODEL-POLICY.md` is the shared roster (Reviewer = Opus latest max thinking;
Critic = Codex latest max reasoning when available, else a divergent 2nd Opus). It is
**triplicated** — see [Contributing](#contributing).

## Statusline (opt-in, one command)

Claude Code plugins cannot auto-apply the main statusline, so this is activated by an
installer. `statusline/` ships a dispatcher whose **line 1 is the rich renderer for
ANY repo** (project name, git, model, context%, cost, duration, subagents, optional
GSD phase). Only if the rich renderer yields nothing does it fall back to a
monorepo-aware renderer (`.gitmodules` / `.gsd/` / `.planning/`) or a **simple**
`model | branch | dir | context%` line. Line 2 is an always-on phase/context bar. No emojis.

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
  force-push logic. For a project-specific PreToolUse hard-gate sentinel (deploy CLIs,
  payment commands, bulk deletes), see
  `skills/feature-launch/references/PRE-TOOL-USE-HOOK.md`.
- **Task discipline / graphify** — edit the respective `hooks/*.js`. All hooks are
  fail-open: a bug in a hook must never wedge a turn.

## Troubleshooting / FAQ

- **Hooks not firing?** Restart Claude Code so a fresh session re-runs SessionStart,
  and ensure `node` is on `PATH` for the shell Claude Code launches hooks from
  (`node --version`). If `node` is missing, all hooks silently no-op.
- **Statusline didn't apply?** It is opt-in — run the installer above. If it reports
  "not found", run `/plugin install` first, then re-run, or locate the dir via `/plugin`.
- **Graphify reminder won't stop?** It is capped per session; stop again to dismiss.
  It only fires when a graph (`graphify-out/` or `.planning/graphs/`) is present.
- **git-guard let a force-push through?** Check the documented fail-open scope above
  (interpreter wrappers / aliases / `-F <file>` commits are out of scope by design).
- **Using Codex too?** Copy `AGENTS.md` (repo root) into your own repo root — it is
  not bundled by `/plugin install`. Verify with
  `codex --ask-for-approval never "Summarize current instructions"`.

## Test locally

```bash
# Full zero-dependency E2E suite (node:test, run from the repo root):
node --test                                                                  # 159 tests; CI runs the same on push/PR (.github/workflows/test.yml)

# Quick smoke-checks of individual hooks:
echo '{"hook_event_name":"SessionStart"}' | node hooks/verify-first-full.js  # full Iron-Law protocol + skill primer
echo '{"prompt":"x"}' | node hooks/verify-first.js                           # short varying nudge (varies by full stdin envelope)
echo '{"prompt":"y"}' | node hooks/verify-first.js                           # different envelope -> different nudge
claude --plugin-dir /path/to/anti-hall                                       # load in a throwaway session
```

## Contributing

- **Keep the 3 MODEL-POLICY.md copies in sync.** The roster file is triplicated
  (`skills/MODEL-POLICY.md` plus a copy under each of `skills/deadly-loop/references/`
  and `skills/feature-launch/references/`) because skill bundling requires each skill
  to carry its own `references/` copy and symlinks are stripped on install. Update
  **all three** together — they must stay byte-identical.
- **Bump the version on any behavioral change.** `plugin.json` `version` is the sole
  authority (the marketplace entry carries no `version`); without a bump, installed
  users do not receive the update. Add a `CHANGELOG.md` entry.
- **Keep hooks pure Node (built-ins only)** and fail-open, so they run unchanged on
  Windows, macOS, and Linux and never wedge a turn.

### Recommended companion: graphify

The `graphify-guard` and `graphify-session` hooks integrate with **graphify** — a
user-global knowledge-graph skill/CLI (not a marketplace plugin) that builds a semantic
graph of your codebase. When a `graphify-out/` or `.planning/graphs/` directory is
present, the hooks enforce querying the graph before raw code searches and remind the
model to keep it updated after significant edits. Both hooks no-op gracefully when
graphify is not present — there is no hard dependency, and the plugin installs and runs
identically with or without it.

### Codex / cross-tool

`AGENTS.md` is a prose mirror of the verify-first Iron Law + commit hygiene + task
discipline, so Codex agents inherit the same discipline (Codex `PreToolUse` cannot
inject context the way Claude's hooks do). It lives at the **marketplace repo root**,
NOT inside `plugins/anti-hall/`, so it ships only to people who clone this repo — a
`/plugin install` does not bundle it. Installed users who also run Codex must copy it
into their own repo root manually.

## License

MIT — see [LICENSE](../../LICENSE).
