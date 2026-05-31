# Changelog

All notable changes to the anti-hall plugin are documented here. The plugin pins an
explicit `version` in `plugin.json` only (the authority); the marketplace entry carries
no `version` to avoid the silent-precedence trap where `plugin.json` wins silently. Every
behavioral change MUST bump `plugin.json` `version` or installed users will not receive
the update.

## 0.3.9

Phase-bar statusline enrichment: wider bar (20 chars), live percentage, longer description
(cap 32 chars), and optional extras (elapsed time in yellow when >20m, active agent count,
current step) rendered when present in phase-state.json.

- **`phase-bar.js` (statusline):** expanded bar width from 16 to 20 chars; added percentage
  render (e.g., "40%") in yellow after the bar; description cap increased from 16 to 32
  chars with ellipsis on overflow; optional extras appended in dim text when phase-state
  includes `elapsed`, `agents`, and `step` keys (e.g., "3m 3ag rendering bar"). Elapsed
  times >20m highlighted in yellow (e.g., "\[33m23m\[0m") to signal long-running phases.
  Backward-compatible: phase-state without these keys renders as before.

## 0.3.7

Consolidated enforcement wave: command-delegation as the top always-on rule, active
task-draining, swarm-guard, graphify-guard, concise-communication note, and
.graphifyignore.

- **`command-guard.js` (PreToolUse Bash, coordinator-only):** new hook that BLOCKS
  heavy/long/state-changing commands (build, test, deploy, push, pull, install,
  migrate, dumps, bulk scripts) when running in a coordinator context, requiring the
  model to delegate them to a subagent instead. Detection uses `CLAUDE_CODE_ENTRYPOINT`:
  `agent_tool` = subagent (pass-through); `cli`/`vscode`/`jetbrains`/etc. = coordinator
  (block). Fail-open on absent/unknown entrypoint. Registered in hooks.json.
  COORDINATOR-VS-SUBAGENT INVESTIGATION: `CLAUDE_CODE_ENTRYPOINT` is a documented
  Claude Code env var set to `agent_tool` when spawned via the Task tool, and inherited
  by hook child processes — this is a reliable signal. The hook is SHIPPED.
- **`swarm-guard.js` (PreToolUse Agent/Task):** new hook, OS-agnostic pure Node.
  Tracks spawn timestamps under `os.tmpdir()/anti-hall/swarm-spawns.log`; prunes
  entries older than 60s; blocks if spawns in last 60s >= 20 (CAP). Secondary check:
  blocks if `os.freemem()/os.totalmem() < 4%` (critical memory pressure). Both
  thresholds are conservative. Fail-open on any error. Registered for `Agent` and
  `Task` matchers in hooks.json.
- **`graphify-guard.js` (PreToolUse Grep/Glob/Bash):** new hook. If a graphify graph
  exists (`graphify-out/` or `.planning/graphs/` at cwd or git toplevel), blocks the
  FIRST code-navigation search of the session (Grep tool, Glob tool, or Bash with
  grep/rg/ag/find/git-grep as first verb) and redirects to `/graphify query`. Blocks
  ONCE per session per project (loop-safe via `os.tmpdir` marker); second call is
  always allowed. Graphify-query Bash commands (`/graphify`) are explicitly excluded.
  No-op when no graph is present. Fail-open. Registered for `Grep`, `Glob`, `Bash`.
- **`.graphifyignore` (repo root):** new file — excludes `graphify-out/`,
  `.planning/graphs/`, `node_modules/`, `dist/`, lock files, `.git/`, and common
  generated/build patterns from graphify indexing.
- **`verify-first-full.js` (SessionStart):** ORCHESTRATION DISCIPLINE block
  restructured. Command-delegation moved to item A as the TOP RULE with explicit
  wording: "NEVER run verbose/long/state-changing commands inline... ALWAYS delegate
  to a subagent... never fill the main context with raw command output — the most
  counterproductive thing a coordinator can do." Active task-draining added as item C:
  "pick up pending tasks and dispatch subagents to finalize them; run INDEPENDENT
  tasks in parallel (up to the concurrency cap, ~min(16, cores-2)); never spawn
  unbounded agents... a runaway swarm can make the OS unusable." Concise-communication
  added as item H: "Communicate concisely: enough to convey meaning, not pages; offer
  to expand if the user wants more detail." Always-apply disciplines summary updated
  to reflect command-delegation top rule, task-draining, concurrency cap, concise note.
- **`verify-first.js` (per-turn nudge):** added two new nudges to the rotation —
  explicit command-delegation top rule; concise-communication note. Concurrency-cap
  language added to the task-list nudge. Hash-mod rotation auto-scales.
- **`task-guard.js` (Stop):** block reason now includes active task-draining
  instruction: "pick up pending tasks... run independent tasks in parallel (up to
  the concurrency cap, ~min(16, cores-2)); do not let tasks sit neglected."
- **`AGENTS.md` + plugin `README.md`:** command-delegation top rule added to
  orchestration section; concurrency cap added; active task-draining added; concise-
  communication added; "Recommended companion: graphify" section added (soft note —
  hooks no-op without it, no hard dependency).
- **Version bump 0.3.6 -> 0.3.7.**

## 0.3.6

Promote TWO disciplines to always-on ENFORCED via the hook layer, while keeping TWO
skills conditional. Root-cause and orchestration now fire every session/turn; deadly-loop
and feature-launch remain invoked-on-match.

- **`verify-first-full.js` (SessionStart):** added an always-apply ORCHESTRATION
  DISCIPLINE block framed as a BIAS TOWARD DELEGATION — non-blocking main thread;
  priority-sorted task list capturing every request and interruption; default to
  delegating any work that touches files/tools/commands/search/build/test or could balloon
  (avoid the eager "I'll just do it inline" trap), handle inline only genuinely atomic
  things (a direct answer, a single known-line read, the coordinator's own
  synthesis/decisions), delegate immediately if a quick inline task balloons; parallel
  agents when independent; noisy commands via a cheap-model subagent (Haiku/Codex)
  off-thread; report/synthesize. Reframed the skill primer into "ALWAYS APPLY (enforced):
  root-cause + orchestration + anti-sycophancy disciplines" vs "INVOKE WHEN IT MATCHES:
  /anti-hall:deadly-loop, /anti-hall:feature-launch (plus the root-cause/orchestration full
  playbooks on demand)". Anti-sycophancy named explicitly. Iron Law + rationalization table
  kept intact.
- **`verify-first.js` (per-turn nudge):** added three orchestration/anti-sycophancy
  one-liners to the rotation (bias-toward-delegation default-to-subagent; noisy commands
  via Haiku off-thread; capture every request/interruption in a priority-sorted list +
  parallel independent agents). The hash-mod rotation auto-scales to the new count;
  fail-open unchanged.
- **READMEs + AGENTS.md:** note that root-cause + orchestration are enforced always-on via
  hooks while deadly-loop + feature-launch are conditional skills invoked on match;
  documented the bias-toward-delegation default, capture-every-request, and anti-sycophancy.
- **Version bump 0.3.5 -> 0.3.6.**

## 0.3.5

Production-doc finalization + doc-vs-code reconciliation: rewrite the READMEs, add
`llms.txt`, and remove the never-registered PreCompact claims.

- **Production README rewrite:** both the top-level `README.md` and the plugin
  `README.md` were rewritten for readability and structure — tagline, the four
  failure modes, quickstart, requirements (with the honest Node-on-PATH no-op
  caveat), a features table, plain-English how-it-works, the `/anti-hall:*` skills,
  statusline install, configuration/tuning, troubleshooting/FAQ, contributing (the
  3 MODEL-POLICY copies must stay in sync), and license. The top README is the
  short overview; depth lives in the plugin README. Accurate to the real code
  (7 Node hooks, 4 skills, Node statusline).
- **`llms.txt` added:** an LLM-oriented index at the repo root (llms.txt standard) —
  H1 title, blockquote summary, and linked sections for the README, plugin README,
  CHANGELOG, AGENTS.md, KB doc, each skill SKILL.md, and each hook.
- **Doc-accuracy fixes (4 × P2):**
  - Top README "What's inside" now states the FULL protocol injects at SessionStart
    (re-firing on compaction via `source=compact`) and a SHORT varying nudge per turn
    at UserPromptSubmit — not "the full protocol every turn".
  - `feature-launch/references/PRE-TOOL-USE-HOOK.md` no longer cites non-existent
    "Phase A.5.5" / "A.5.3"; it now points to "Phase A.5 (AFK readiness gate)" to
    match the prose (no sub-numbers) in `feature-launch/SKILL.md`.
  - `verify-first.js` comments + plugin README now state the per-turn nudge is hashed
    from the FULL stdin envelope (varies by session/cwd), not "reproducible for a
    given prompt". Runtime behavior unchanged.
  - `PRE-TOOL-USE-HOOK.md` example sentinel: added an explicit false-block/bypass
    tradeoff caveat and a pointer to the shipped quote-aware `git-guard.js`
    tokenizer; `--no-verify` / `--no-gpg-sign` patterns anchored to a flag boundary.
- **PreCompact placeholder claims removed (P1):** `hooks.json` registers
  `verify-first-full.js` ONLY on `SessionStart` — there is no `PreCompact`
  registration block and never was in the shipped manifest. Every doc that
  described an "inert PreCompact placeholder registration" was inaccurate. Removed
  those claims from `verify-first-full.js` (banner + header + the dead
  `name === 'PreCompact'` echo branch), the plugin `README.md`, and `AGENTS.md`.
  Compaction survival is unchanged: it relies solely on the no-matcher
  `SessionStart` re-fire with `source="compact"`, which IS registered. The earlier
  0.3.0/0.3.1 notes below describing a kept PreCompact placeholder are superseded
  by this entry.
- **AGENTS.md scope clarified (P2):** `AGENTS.md` lives at the marketplace repo
  root, not under `plugins/anti-hall/`, so it is NOT bundled by `/plugin install`
  (the plugin `source` is `./plugins/anti-hall`). `plugin.json` description and the
  plugin `README.md` now state it is a repo-root Codex mirror for clone-based use
  that installed users must copy manually.
- **0.3.0 marketplace-source note corrected (P2):** the 0.3.0 entry claimed the
  marketplace plugin `source` switched to a GitHub source object; the file actually
  uses the relative path `./plugins/anti-hall`. Corrected the 0.3.0 note to match
  the file (the relative path resolves because `marketplace add talas9/anti-hall`
  clones the whole repo).

## 0.3.4

Close the quoted-flag force-push bypass in git-guard.

- **git-guard: quoted force flags / refspecs / subcommand now BLOCK (P1):** the
  force-push guard previously skipped any token that came entirely from inside quotes
  (`quotedOnly`). For argument-level flag/refspec/subcommand detection that was wrong —
  the POSIX shell strips quotes before git runs, so `git push "--force"`,
  `git push '--force'`, `git push "-f"`, `git push origin '+main'`, and
  `git "push" --force origin main` are byte-for-byte equivalent to their unquoted forms
  and DO rewrite published history, yet all five were reported ALLOW. `isForcePush()`
  now matches `--force`/`--force-with-lease`/bundled `-f`/`+refspec` regardless of
  quoting, and `gitSubcommand()` resolves a quoted subcommand token (e.g. `"push"`)
  instead of bailing to `sub=null` and leaving the command uninspected. Quoting still
  only changes meaning for commit-message CONTENT (a `--force`/`+main` inside an `-m`
  value), which is inspected separately on the `commit` path — never in a push arg
  list — so `git commit -m "fix --force bug"` is not false-blocked. Verified against the
  block/allow matrix (5 bypass cases now block; all prior blocks and legitimate pushes
  unchanged).

## 0.3.3

Portability finalization pass — restore the all-pure-Node guarantee.

- **Removed `node-preflight.sh` (P1):** the POSIX-shell preflight added in 0.3.2 could
  not run on the platform it targeted. Claude Code executes a hook `command` via the
  system shell, which on a stock Windows box is cmd.exe/PowerShell — neither has `sh`
  on `PATH`. On the exact "fresh Windows box with no Node" case the preflight existed
  to warn about, `sh` is also absent, so `sh node-preflight.sh` failed to launch and
  the "anti-hall hooks are INACTIVE" warning never fired — the precise silent-off
  failure it was meant to prevent. The plugin's single non-Node component was also its
  least portable. Rather than ship a `.sh`/`.cmd`/`.ps1` matrix, the missing-Node case
  is now handled the same way as git-guard's other fail-open boundaries: documented as
  a hard, verify-before-relying prerequisite (README "Requirements" + install steps,
  "verify with `node --version`"). With the `.sh` gone, the manifest/README "all hooks
  pure Node, run unchanged on Windows/macOS/Linux given Node" claim is once again true.
- **Manifest/CHANGELOG vs README reconciled (P2):** plugin.json's "All hooks and the
  statusline are pure Node" description and the 0.3.0 "no `.sh`, no bash" note no longer
  contradict the shipped hooks — there is no shell hook to contradict them. README,
  manifest, and CHANGELOG now agree.

## 0.3.2

Deadly-loop finalization pass (round 1 + round 2 findings; 0 P0, converged).

- **git-guard `--force-if-includes` false-block (P1):** `--force-if-includes` /
  `--no-force-if-includes` is a safety modifier (a no-op on its own, only meaningful
  alongside `--force-with-lease`), not a force push. It is no longer a force trigger,
  so a bare `git push --force-if-includes origin main` is ALLOWED. `--force`, `-f`,
  `--force-with-lease`, and `+refspec` still BLOCK.
- **statusline installer cache-path discovery (P1):** the one-command installer glob
  now covers the real install layout `~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`
  (verified against an actual install) plus the KB's shallower documented forms, keeping
  the existing marketplace globs and the `.claude-plugin/plugin.json` existence guard, so
  it no longer prints "not found" on a correctly installed plugin.
- **node-absent honest documentation (P1):** every hook launches as `node <hook>.js`;
  if `node` is absent from the hook shell's `PATH`, all hooks (including the git-guard
  safety) silently do not run. A POSIX-shell `node-preflight.sh` SessionStart hook now
  emits a loud one-time warning when `node` is missing (a node-based preflight cannot
  detect its own missing interpreter), and the README install steps state the Node >= 18
  requirement prominently and tell users to verify `node --version` before relying on
  the protections.
- **git-guard ANSI-C inline self-credit bypass (P2):** a `git commit -m $'fix\n\nCo-authored-by: ...'`
  kept its `\n` literal after tokenizing, slipping past the line-anchored trailer
  regexes. Self-credit detection now also tests an escape-normalized copy of each inline
  message (`\n`/`\r`/`\t` interpreted), so the ANSI-C inline form is blocked too.
- **marketplace.json capability claim (P2):** changed "PreCompact re-injection" to
  "SessionStart re-injection (fires with source=compact)" to match the code — PreCompact
  context injection is inert (forward-compat placeholder), SessionStart `source=compact`
  is the sole compaction-survival mechanism.
- **install-statusline.js ungrounded field (P2):** dropped the undocumented `padding: 0`
  field; the installer writes only the doc-grounded `{ type: "command", command }`.
- **MODEL-POLICY triplication sync note (P2):** the three byte-identical MODEL-POLICY.md
  copies (needed because skill bundling carries each skill's own `references/` copy and
  symlinks are stripped on install) now each carry a SYNC NOTE header, plus a README
  maintainer note, instructing that all three be updated together.
- **Stop-hook precedence (P2):** `task-guard` is now registered before `graphify-reminder`
  on `Stop` so the higher-stakes open-task discipline reason wins when both fire (Claude
  Code does not merge Stop reasons); README caveat updated.
- **statusline blink removed (P2):** the >=80% context tier in `statusline-monorepo.js`
  no longer uses SGR 5 (blink, inconsistently supported); it uses bold bright-red
  256-color, consistent with the other tiers.
- **per-turn nudge wording (P2):** README clarified that the verify-first nudge varies
  **by prompt** (deterministic SHA-1 of the prompt), not strictly per turn — an identical
  repeated prompt reproduces the same facet.

## 0.3.1

Deadly-loop finalization pass — applies the remaining open findings, all verified
against the official Claude Code hooks docs.

- **graphify-reminder now actually reaches the model (P1):** a Stop hook does NOT
  inject `additionalContext` (only UserPromptSubmit / UserPromptExpansion /
  SessionStart do, per the official docs), so the previous stdout-`additionalContext`
  emission was a silent no-op. The reminder is now surfaced via the only Stop
  channel that reaches the model — a **one-time soft block**
  (`{"decision":"block","reason":...}`), capped + deduped via `os.tmpdir` state so
  it nudges at most once per session and never loops. The "keep the graph updated"
  guidance also lives in the SessionStart primer, which IS a context-injection event.
- **git-guard emoji self-credit (P1):** the `Generated with <AI>` detector now
  catches the canonical footer even when prefixed by a leading glyph/emoji
  (e.g. the robot-emoji `Generated with [Claude Code]` footer) while still allowing
  prose ("we generated with care"). Verified against the full block/allow matrix.
- **Node prerequisite documented prominently (P1):** added a **Requirements**
  section to the top-level README and the plugin description, and aligned the plugin
  README to Node >= 18. Hooks invoke a bare `node`; without a global Node on `PATH`
  every hook (including the git-guard safety) silently fails to launch.
- **git-guard scope caveat (P2):** README now states the guard inspects only inline
  `-m`/`--message` trailers — `-F`/`--file`, editor commits, and interpreter
  wrappers (`sh -c`, `xargs`, aliases) are documented fail-open boundaries.
- **KB §1.4 corrected (P2):** UserPromptSubmit context injection uses **nested**
  `hookSpecificOutput.additionalContext` (not flat); added an explicit note that
  context injection is event-gated to UserPromptSubmit / UserPromptExpansion /
  SessionStart, so `Stop`/`PreCompact` `additionalContext` is inert.
- **PreCompact framing corrected (P2):** clarified that PreCompact never injects
  context (not "summarized away"); SessionStart `source="compact"` is the sole
  survive-compaction mechanism. (Superseded in 0.3.5: the PreCompact registration
  was never actually present in `hooks.json`, so all PreCompact-placeholder claims
  were removed rather than reworded.)
- **Two-Stop-hook coexistence noted (P2):** `graphify-reminder` + `task-guard` both
  emit the top-level Stop `decision`/`reason` schema; Claude Code does not merge
  reasons, but each is capped so neither is lost (they sequence across Stops).

## 0.3.0

KB-driven effectiveness + portability revision (see `docs/PLUGIN-REVIEW.md`),
plus a full OS-agnostic Node rewrite and the deadly-loop hardening pass.

- **OS-agnostic Node rewrite (portability):** every hook and the statusline +
  its installer are now pure Node.js using only built-ins (`fs`, `path`, `os`,
  `crypto`, `child_process`) — no `.sh`, no bash/grep/sed/cksum/jq/python3, no
  `/dev/stdin`. The only spawned subprocess is `git` itself. They run unchanged
  on Windows, macOS, and Linux **given Node.js on `PATH`** — Node is the one hard
  prerequisite (see README "Requirements"); without a global `node` the hooks
  cannot launch and the guards silently do not run. `hooks.json` invokes each as
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.js"` (explicit `node`, not a
  shebang, since Windows ignores shebangs).
- **verify-first restructured (P0-1, P0-3):** the FULL protocol moved to a
  SessionStart injection (`verify-first-full.js`), rewritten in the Superpowers
  "ONE Iron Law + rationalization/excuse table" form (names the specific bypass
  excuses: "probably", "should work", "seems to", "I'll just assume", "this looks
  done", "tests pass on first run"). The per-turn `UserPromptSubmit`
  (`verify-first.js`) is now a SHORT nudge that VARIES per turn (one of 5
  one-liners, chosen deterministically by a SHA-1 hash (Node `crypto`) of the
  prompt) to fight habituation. JSON emitted via `JSON.stringify`, no jq.
- **Survive compaction (P0-2):** the protocol persists across the compaction
  reset via the no-matcher `SessionStart` registration — Claude Code re-fires
  `SessionStart` after a compaction with `source="compact"`, and that injection
  is fresh post-reset context. (This note originally also described keeping a
  `PreCompact` registration as an inert placeholder; superseded in 0.3.5 — no
  PreCompact registration was ever present in `hooks.json`, and all such claims
  were removed. Per the official docs `additionalContext` is injected on exit 0
  for UserPromptSubmit / UserPromptExpansion / SessionStart only, so a PreCompact
  hook would deliver nothing.) A duplicate matcher-`"compact"` SessionStart entry
  was removed so the protocol is not double-injected after a compaction.
- **git-guard force-push hardening (deadly-loop):** force-push detection now
  resists prefix/wrapper/subshell bypasses and `+refspec` variants — env-prefix
  (`FOO=bar git push --force`), wrappers (`command`/`exec`/`sudo`/`env`/`time`/
  `nohup`/`nice -n N`/`timeout 5`), subshell grouping (`(git push --force)`),
  global git options (`-c x=y push --force`), positional `+refspec` (with `--`
  end-of-options handling), and backslash-newline line continuations. Self-credit
  trailer detection is anchored to start-of-line trailer form so a prose mention
  ("docs: explain output generated with claude code") no longer false-blocks,
  while real `Co-Authored-By:` / `Generated with <AI>` trailer lines still block.
  Verified against an 18-case block/allow matrix.
- **AGENTS.md mirror (P0-4):** new repo-root `AGENTS.md` (<32 KiB) mirroring the
  verify-first Iron Law + commit/push hygiene + task discipline, so Codex
  subagents inherit the discipline (Codex `PreToolUse` cannot inject context).
- **Skill primer (P1-1):** SessionStart now lists the plugin's skills
  (root-cause, deadly-loop, feature-launch, orchestration) + when to reach for
  each, folded into `verify-first-full.js`.
- **MODEL-POLICY (P1-2):** documented `effort` default `high` / recommended max
  `xhigh` with fallback-to-`high` when unsupported (gpt-5.4-mini, Bedrock cmb);
  added the `codex` CLI-alias-in-subprocess caveat (detect in the executing
  shell, try an absolute path); added an anti-sycophancy clause (user agreement
  != correctness).
- **marketplace.json (P1-5, P1-6):** plugin `source` is the relative path
  `"./plugins/anti-hall"`, which resolves because `/plugin marketplace add
  talas9/anti-hall` clones the whole repo (the relative path is taken from the
  marketplace root inside that clone); removed the per-plugin `version`
  duplication (version now lives only in `plugin.json`).
- **KB (`docs/KB-claude-codex.md`):** added §9 "Anthropic Prompting 101" and §10
  "Claude Opus 4.8 features relevant to this plugin", plus their source URLs.
- **CHANGELOG header:** corrected "bump both manifests" to "bump `plugin.json`
  only (the authority)".

## 0.2.1

- Fix `git-guard` self-credit regex: removed the bare `ai` alternation that
  false-blocked legitimate human trailers (e.g. `Co-authored-by: Ai ...`). Now matches
  specific AI/assistant signatures only.
- Add this CHANGELOG.

## 0.2.0

- Add skills: `root-cause` (evidence-driven debugging), `orchestration` (non-blocking
  swarm; Claude+Codex load split; commands via Haiku), `feature-launch` (plan-first,
  deadly-loop-hardened, edge-case/scenario simulated), `deadly-loop` (iterative
  Reviewer+Critic debate), and shared `MODEL-POLICY.md` (Opus + Codex roster).
- Add graphify hooks: `graphify-session` (SessionStart, query-graph-first) and
  `graphify-reminder` (Stop, keep-graph-updated).
- Add `git-guard` (PreToolUse/Bash): block self-credit commit trailers and force push.
- Add conditional statusline (rich for monorepos, simple otherwise) + installer.
- Strengthen `verify-first` injection: no-jumping-to-conclusions, no-cause-no-fix,
  instrument-don't-guess, no-fake-completion, label claims.

## 0.1.0

- Initial release: `verify-first` UserPromptSubmit hook + marketplace scaffold.
