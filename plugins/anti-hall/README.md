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
| `task-tracker.js` | UserPromptSubmit | Injects task-list discipline (capture, prioritize, work in order). |
| `task-guard.js` | Stop | Blocks once if the session ends with open tasks. |
| `graphify-session.js` | SessionStart | Primes "query the graph first" when a graphify graph exists. |
| `graphify-reminder.js` | Stop | One-time reminder to update the graph after real edits. |
| `root-cause` / `orchestration` / `feature-launch` / `deadly-loop` | Skills | Slash commands (see [Skills](#skills)). |
| `statusline/` | Statusline | Rich line for monorepos, simple line otherwise. |

## How it works

### Verify-first protocol (the core)

- **SessionStart full protocol** — `verify-first-full.js` injects the FULL
  verify-first + root-cause protocol in the Superpowers **Iron Law +
  rationalization-table** form. It names the specific bypass excuses ("probably",
  "should work", "seems to", "I'll just assume", "looks done", "tests pass on first
  run") and includes a skill primer listing each skill and when to reach for it.
  SessionStart is the primacy slot.
- **Surviving compaction** — SessionStart re-fires after a compaction with
  `source="compact"`. The no-matcher SessionStart registration therefore re-injects
  the protocol across the compaction boundary, exactly when context is largest and
  adherence is worst. This is the sole compaction-survival mechanism. The hook is
  deliberately **not** registered on `PreCompact`: per the official docs, only
  UserPromptSubmit / UserPromptExpansion / SessionStart can inject
  `additionalContext`, so a PreCompact hook would deliver nothing.
- **Per-turn nudge** — `verify-first.js` injects ONE short one-liner per turn
  (one of 5 facets of the Iron Law), so the per-turn slot stays high-salience
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

> **Two Stop hooks coexist** (`task-guard` + `graphify-reminder`), both emitting the
> top-level `{"decision":"block","reason":...}` Stop schema. Claude Code does not
> merge `reason` strings across Stop hooks: if both fire on the same Stop, both block
> but only one reason is shown that turn. `task-guard` is registered **first** because
> open-task discipline is higher-stakes, so its reason wins precedence. Each is capped
> (graphify-reminder nudges once per session; task-guard caps at `MAX_BLOCKS`), so the
> other surfaces on a subsequent Stop. Neither is dropped — they are sequenced.

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

`MODEL-POLICY.md` is the shared roster (Reviewer = Opus latest max thinking;
Critic = Codex latest max reasoning when available, else a divergent 2nd Opus). It is
**triplicated** — see [Contributing](#contributing).

## Statusline (opt-in, one command)

Claude Code plugins cannot auto-apply the main statusline, so this is activated by an
installer. `statusline/` ships a dispatcher that shows a **rich** line in a monorepo
(`.gitmodules` / `.gsd/` / `.planning/`) and a **simple** `model | branch | dir |
context%` line otherwise. No emojis.

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
