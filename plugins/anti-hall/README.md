# anti-hall

A Claude Code plugin that enforces **verify-first** discipline and ships the
workflow skills that go with it. It fights four failure modes:

1. **Eagerness** — answering/acting before investigating.
2. **Hallucination** — stating unverified facts (file contents, API behavior, values) as truth.
3. **Solution-before-diagnosis** — proposing fixes before proving the root cause.
4. **Fake completion** — claiming work is done/fixed/passing without running the check.

## Components

### Hooks (always-on)
- **`verify-first-full.js`** (`SessionStart` **and** `PreCompact`) — injects the
  FULL verify-first + root-cause protocol in the Superpowers **Iron Law +
  rationalization-table** form (names the specific bypass excuses: "probably",
  "should work", "seems to", "I'll just assume", "looks done", "tests pass on first
  run"), plus a **skill primer** listing the plugin's skills and when to reach for
  each. SessionStart is the primacy slot. SessionStart re-fires after a compaction
  with `source="compact"`, so the no-matcher SessionStart registration also
  re-injects the protocol across the compaction boundary (when context is largest
  and adherence is worst) — that is the actual survive-compaction mechanism. The
  `PreCompact` registration is an inert placeholder: per the official docs only
  UserPromptSubmit / UserPromptExpansion / SessionStart inject `additionalContext`,
  so a PreCompact hook delivers nothing today (it is kept only in case a future
  Claude Code adds PreCompact context injection). Compaction is survived solely by
  the SessionStart `source="compact"` re-fire above.
- **`verify-first.js`** (`UserPromptSubmit`) — injects a **short, varying** one-line
  nudge each turn (one of 5 facets of the Iron Law, chosen deterministically by a
  SHA-1 hash (Node `crypto`) of the prompt) so the per-turn slot stays high-salience instead of being
  habituated and tuned out. The full protocol lives in the SessionStart/PreCompact
  hook above.
- **`graphify-session.js`** (`SessionStart`) — if the project has a graphify graph
  (`graphify-out/` or `.planning/graphs/`), primes the model to **query the graph
  first** for any issue/feature/function/code/doc lookup, and to keep it updated.
  Silent no-op when graphify isn't used.
- **`graphify-reminder.js`** (`Stop`) — after a session with real edits and a graph
  present, surfaces a **one-time** reminder to run `/graphify --obsidian`. A Stop hook
  cannot inject `additionalContext` (only UserPromptSubmit / UserPromptExpansion /
  SessionStart can, per the official docs), so the only channel that reaches the model
  on Stop is a `decision:block`. It therefore nudges with a single soft block, capped
  via `os.tmpdir` state so it never loops — stop again to dismiss. The same
  "keep the graph updated" guidance also lives in the SessionStart primer
  (`graphify-session.js`), which IS a context-injection event.
- **`task-tracker.js`** (`UserPromptSubmit`) — injects the task-list discipline
  directive on every turn: capture every request as a task before acting, assign
  priority (`P0/P1/P2`), keep the list sorted highest-priority-first and work tasks
  in that order, keep statuses current, delegate heavy work to background subagents,
  and report progress. Nothing is silently dropped.
- **`task-guard.js`** (`Stop`, loop-safe) — when the session is about to stop with
  open tasks (`pending`/`in_progress`) still in the list, blocks **once** to prompt
  the model to continue, complete, or explicitly defer them. Loop-safe: if the exact
  same open-task set was already blocked on (nothing changed), the guard skips to
  prevent infinite loops. Fail-open on any parse/read/state error.
> **Two Stop hooks coexist** (`graphify-reminder` + `task-guard`), both registered
> and both emitting the top-level `{"decision":"block","reason":...}` Stop schema.
> Claude Code does not merge `reason` strings across Stop hooks: if both fire on the
> same Stop, both block but only one reason is shown that turn. This is acceptable —
> each is capped (graphify-reminder nudges once per session; task-guard caps at
> `MAX_BLOCKS`), so the other surfaces on a subsequent Stop. Neither is silently
> lost; they are sequenced, not dropped.

- **`git-guard.js`** (`PreToolUse` on Bash) — mechanically **blocks** commits whose
  **inline** `-m`/`--message` carries a `Co-Authored-By`/self-credit trailer
  (including the canonical emoji-prefixed `Generated with [Claude Code]` footer) and
  blocks `git push --force`. Commits take no AI credit; history rewrites are a
  deliberate human action. **Scope:** it inspects only inline `-m`/`--message`
  trailers — `-F <file>` / `--file` and editor commits are NOT scanned (fail-open),
  and interpreter wrappers (`sh -c "git push --force"`, `xargs`, an aliased `g push`)
  bypass it. These are documented fail-open boundaries, not silent gaps.

### Skills
- **`root-cause`** — evidence-driven debugging: reproduce, collect evidence,
  instrument when missing, trace the sequence to the original + root cause (not the
  surface symptom), prove the hypothesis, fix at the root, verify.
- **`orchestration`** — swarm with a non-blocking main thread: delegate heavy/long
  work to background + parallel subagents, partition to avoid conflicts, distribute
  load across Claude **and** Codex when available, run commands via Haiku so raw
  output never pollutes the coordinator's context.
- **`feature-launch`** — plan-first protocol: author the plan in **plan mode**
  (blending superpowers planning + GSD, not GSD-dependent), enumerate edge cases and
  simulate every scenario, then **harden the plan with the deadly-loop BEFORE any
  code**, then build phase by phase running the **deadly-loop after each phase**.
- **`deadly-loop`** — iterative parallel Reviewer + Critic debate + fix-waves until
  convergence (zero NEW P0s). The debate engine used by feature-launch's gates.
- **`MODEL-POLICY.md`** — shared roster: Reviewer = Opus latest max thinking;
  Critic = Codex latest max reasoning when available, else a divergent 2nd Opus.

### Statusline (opt-in, one command)
Claude Code plugins cannot auto-apply the main statusline, so this is activated by an
installer. `statusline/` ships a dispatcher that shows a **rich** line in a monorepo
(`.gitmodules` / `.gsd/` / `.planning/`) and a **simple** `model | branch | dir |
context%` line otherwise — no emojis. Install:

```bash
# Find the installed plugin dir (Claude Code nests it under
# ~/.claude/plugins/marketplaces/<marketplace>/plugins/anti-hall) and run the
# Node installer. A dir only counts if it actually contains the plugin manifest,
# so the marketplace dir itself is never mistaken for the plugin dir. If nothing
# is found, the plugin isn't installed yet — run `/plugin install` first, or
# locate the dir via `/plugin`.
DIR=$(for d in ~/.claude/plugins/marketplaces/*/plugins/anti-hall ~/.claude/plugins/*/plugins/anti-hall ~/.claude/plugins/*/anti-hall; do [ -f "$d/.claude-plugin/plugin.json" ] && echo "$d"; done 2>/dev/null | head -1)
[ -n "$DIR" ] && node "$DIR/statusline/install-statusline.js" || echo "anti-hall not found under ~/.claude/plugins — install it first (/plugin install), then re-run."
```

See `statusline/STATUSLINE.md` for details and how to revert.

### Codex / cross-tool
- **`AGENTS.md`** (repo root) — prose mirror of the verify-first Iron Law + commit
  hygiene + task discipline, so Codex agents inherit the same discipline (Codex
  `PreToolUse` cannot inject context the way Claude's hooks do). Verify it loads
  with `codex --ask-for-approval never "Summarize current instructions"`.

## Test locally
```bash
echo '{"hook_event_name":"SessionStart"}' | node hooks/verify-first-full.js  # full Iron-Law protocol + skill primer
echo '{"prompt":"x"}' | node hooks/verify-first.js                           # short varying nudge (varies by prompt)
echo '{"prompt":"y"}' | node hooks/verify-first.js                           # different prompt -> different nudge
claude --plugin-dir /path/to/anti-hall                                    # load in a throwaway session
```

## Requirements
- **Node.js (>= 18) on `PATH`** — every hook is launched as `node "<plugin>/hooks/<name>.js"`.
  Claude Code does NOT guarantee a user-installed `node` on the hook shell's `PATH`,
  and it is not bundled by this plugin. On a machine with no global Node install
  (common on a fresh Windows box or for non-JS developers), the hooks fail to
  launch and the guards (force-push / self-credit block, verify-first, task
  discipline) silently do not run. Install Node from <https://nodejs.org> and
  verify with `node --version` before relying on the protections. "Runs unchanged
  on Windows/macOS/Linux" means OS-portable given Node — Node itself is the one
  hard prerequisite.

## Install (any machine, any repo)
```bash
/plugin marketplace add talas9/anti-hall
/plugin install anti-hall@anti-hall
```
The hooks apply globally once enabled. The statusline needs the one-command installer
above. Tune the full protocol by editing `hooks/verify-first-full.js` (SessionStart
/ PreCompact) and the per-turn nudges in `hooks/verify-first.js`.
