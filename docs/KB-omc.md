# KB — oh-my-claudecode (OMC)

> Reference KB on **oh-my-claudecode (OMC)** — a multi-agent orchestration layer for
> Claude Code that anti-hall coexists with (anti-hall's `omc-detect.js` defers its Stop
> guards to OMC autonomous loops). Compiled from OMC's own shipped docs + public repo.
> Project/user-agnostic. Versions/agent counts move fast — treat specifics as directional.

## TL;DR

OMC is a **zero-config** orchestration layer for Claude Code. It loads via the Claude Code
**plugin marketplace** (no wrapper script needed), injects a `CLAUDE.md` system prompt,
registers lifecycle hooks, and exposes in-session slash skills plus an `omc` CLI. Canonical
launch: install the plugin → `/omc-setup` → use `/autopilot`, `/ralph`, `/team`,
`/ultrawork` inside any normal `claude` session. **No launcher/wrapper is required** for
basic use; the `omc` npm CLI is only needed for tmux-based `omc team` workers.

## What OMC is

A multi-agent layer on top of Claude Code (tagline: *"Don't learn Claude Code. Just use
OMC."*). Four interlocking systems:

1. **Hooks** — react to lifecycle events (SessionStart / UserPromptSubmit / PreToolUse /
   PostToolUse / Stop) via `system-reminder` injection. Key signals: `[MAGIC KEYWORD: …]`
   (trigger a skill), `The boulder never stops` (ralph/ultrawork persistence active).
2. **Skills** — injected behaviors callable as `/oh-my-claudecode:<name>` or via NL keyword
   triggers.
3. **Agents** — specialized subagents in tiered lanes (haiku/sonnet/opus), invoked as Claude
   Code subagents.
4. **State** — persists under `.omc/` across context resets (plans, sessions, handoffs,
   notepad, project memory). `.omc/` is gitignored except `.omc/skills/`.

## Activation / canonical launch

**No wrapper script is required.** Two supported surfaces:

**A — Plugin marketplace (recommended):**
```
/plugin marketplace add https://github.com/Yeachan-Heo/oh-my-claudecode
/plugin install oh-my-claudecode
/omc-setup            # or /oh-my-claudecode:omc-setup
```
This enables the plugin in `~/.claude/settings.json`; Claude Code then loads agents/skills/
hooks on every session. Just run `claude` normally — no wrapper, no env vars.

**B — npm CLI (adds the `omc` terminal command, needed for `omc team` tmux workers):**
```
npm i -g oh-my-claude-sisyphus@latest   # package name ≠ "oh-my-claudecode"
omc setup
```
The CLI gives terminal-level commands (`omc team`, `omc ask`, `omc wait`, `omc session`).
It does NOT replace the plugin for in-session skills.

> `omc-setup` rewrites the OMC `CLAUDE.md` + hooks + HUD wiring — **re-run it after every OMC
> update** (CLAUDE.md changes don't apply automatically). `omc-doctor` (`/omc-doctor` or
> `omc doctor`) is the health check (stale config, cache conflicts, missing hooks).

## Model routing

Three Claude tiers, per-agent defaults, `-low`/`-high` suffix overrides:
- **haiku** — quick lookups, discovery (`explore`, `writer`, `executor-low`).
- **sonnet** — standard implementation/tests/reviews (`executor`, `debugger`, `verifier`,
  `designer`, most domain agents).
- **opus** — architecture/deep analysis/planning (`architect`, `analyst`, `planner`,
  `critic`, `code-reviewer`, `executor-high`).

OMC claims ~30–50% token savings via this routing. External-CLI workers (Codex/Gemini/
Antigravity/Grok/Cursor) route via `omc ask` / `omc team` and env overrides
(`OMC_CODEX_DEFAULT_MODEL`, etc.).

## Key skills

| Skill | Trigger | Use when |
|---|---|---|
| `/team N:agent "…"` | explicit | Coordinated staged pipeline (plan→prd→exec→verify→fix). Canonical multi-agent surface. |
| `/autopilot "…"` | `autopilot:` | End-to-end autonomous build, minimal ceremony |
| `/ralph "…"` | `ralph` | Must-complete tasks; verify/fix loop until done |
| `/ultrawork "…"` | `ulw` | Maximum parallelism burst (mass fixes/refactors) |
| `/ralplan "…"` | `ralplan` | Consensus planning (Planner→Architect→Critic) before execution |
| `/deep-interview "…"` | `deep interview` | Socratic requirements clarification before code |
| `/ask <provider> "…"` | — | Second opinion from Codex/Gemini/Antigravity/Grok/Cursor |
| `/ccg` | `ccg` | Claude+Codex+Gemini tri-model fan-out, Claude synthesizes |

Team pipeline needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Kill switches: `DISABLE_OMC=1`,
`OMC_SKIP_HOOKS=<names>`.

## cmux + OMC + Claude Code (the combined stack)

Three distinct, complementary layers:
- **Claude Code** (`claude`) — the base agent runtime (tools, files, bash, conversation).
- **OMC** — orchestration *inside* Claude Code (multi-agent routing, subagents, skills,
  hooks, state, HUD, the `omc` CLI).
- **cmux / tmux** — the shell-level session manager (split panes, persistence, the substrate
  for `omc team` CLI workers).

```
Terminal (cmux / tmux)
 └─ pane 1: claude          ← Claude Code + OMC plugin (orchestrates subagents internally)
 └─ pane 2: omc team 2:codex "…"   ← OMC spawns external CLI workers into new panes
 └─ pane 3: [codex worker]
```

`omc team` actively creates panes for external workers; in-session `/team` runs natively with
no tmux workers. OMC detects the terminal: `$TMUX` set → tmux directly; cmux socket present →
native cmux splits via a tmux shim; plain terminal → a detached tmux session. See
[`KB-cmux.md`](./KB-cmux.md) for the terminal layer.

**Recommended setup:** install tmux/cmux → install OMC plugin + `/omc-setup` → (optional)
`npm i -g oh-my-claude-sisyphus` for `omc team` → run `claude` normally.

## Best practices & gotchas

- Start vague ideas with `/deep-interview` before `/autopilot` — saves wasted cycles.
- One primary loop authority per session (native `/goal` OR ralph OR team — not stacked).
- npm package is **`oh-my-claude-sisyphus`** (not `oh-my-claudecode`).
- Re-run `/omc-setup` after every update; `omc doctor` when things break.
- In-session skills don't work headless/CI — use the `omc` CLI there.
- `.omc/` state is local + gitignored (except `.omc/skills/`); a worktree's `.omc/` dies with
  the worktree unless centralized via `OMC_STATE_DIR`.

## Sources

- [OFFICIAL] OMC repo — https://github.com/Yeachan-Heo/oh-my-claudecode (README, `docs/ARCHITECTURE.md`, `docs/REFERENCE.md`)
- [OFFICIAL] OMC shipped docs — the plugin's bundled `README.md` / `ARCHITECTURE.md` / `REFERENCE.md` + the injected `CLAUDE-omc.md` system prompt (the in-session `/oh-my-claudecode:omc-reference` skill is the runtime source of truth — prefer it over web for the current catalog)
- npm — https://www.npmjs.com/package/oh-my-claude-sisyphus
- Project sites — https://oh-my-claudecode.dev/ , https://omc.vibetip.help/docs
- cmux ↔ OMC integration — https://cmux.com/docs/agent-integrations/oh-my-claudecode

_Compiled 2026-06-29 from OMC's shipped docs + public repo; agnostic. Specifics (version, agent
count) drift between releases — the in-session `omc-reference` skill is authoritative._
