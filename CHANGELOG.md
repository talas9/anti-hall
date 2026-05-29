# Changelog

All notable changes to the anti-hall plugin are documented here. The plugin pins an
explicit `version` in `plugin.json` only (the authority); the marketplace entry carries
no `version` to avoid the silent-precedence trap where `plugin.json` wins silently. Every
behavioral change MUST bump `plugin.json` `version` or installed users will not receive
the update.

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
- **PreCompact framing corrected (P2):** the `verify-first-full.js` PreCompact
  registration is an inert placeholder (PreCompact never injects context), not
  "summarized away"; SessionStart `source="compact"` is the sole survive-compaction
  mechanism. Corrected the hook header, README, and the 0.3.0 note above.
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
  is fresh post-reset context. A `PreCompact` registration is kept as
  an inert placeholder only: per the official docs, `additionalContext` is
  injected on exit 0 for UserPromptSubmit / UserPromptExpansion / SessionStart
  only, so a PreCompact hook delivers nothing today (kept in case a future Claude
  Code adds PreCompact context injection). A duplicate
  matcher-`"compact"` SessionStart entry was removed so the protocol is not
  double-injected after a compaction.
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
- **marketplace.json (P1-5, P1-6):** plugin `source` switched to an explicit
  GitHub source object (`{ "source": "github", "repo": "talas9/anti-hall",
  "path": "plugins/anti-hall" }`) so URL/marketplace installs resolve; removed the
  per-plugin `version` duplication (version now lives only in `plugin.json`).
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
