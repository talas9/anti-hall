# KB — cmux (terminal workspace for AI coding agents)

> Reference knowledge base for **cmux**, the terminal built for running AI coding
> agents (Claude Code, Codex, Gemini CLI, etc.) in parallel. Compiled from 11
> web sources (May 2025 – Jun 2026), 4 official. **Read the disambiguation in §1
> first** — two unrelated projects share the name "cmux".
>
> **Provenance caveat:** these are *sourced web claims*, not features verified
> in-repo. Resource/memory figures come from a community audit issue and may be
> fixed in versions after this research. Version/star counts are point-in-time.

## TL;DR

- **cmux (manaflow-ai)** is a **native macOS terminal app** (Swift + AppKit, built on
  **libghostty**) — NOT tmux, NOT a multiplexer-inside-a-TTY. No prefix key, no
  `.tmux.conf`. It is agent-aware: blue **notification rings** on panes, a vertical
  **sidebar** showing git branch / PR / CWD / ports / latest notification per workspace,
  an embedded **scriptable browser**, and a **Unix socket CLI** (`/tmp/cmux.sock`).
- It solves the *"which of my 5 agents is blocked?"* problem that plain terminals and
  tmux don't: per-workspace context + push notifications + subagents surfaced as real panes.
- **cmux (craigsc)** is a **completely separate** bash CLI — "tmux for Claude Code" — that
  wraps `git worktree` for isolated per-branch Claude sessions. Different project, different repo.
- **With Claude Code:** run `claude` in a pane like normal (no wrapper); use `cmux claude-teams`
  to surface teammates as native splits; wire **OSC 777** or a `cmux notify` stop-hook so blocked
  agents ring. **Gotchas:** heavy memory growth with many panes, orphaned `cmux hooks codex monitor`
  children reparented to launchd, and sandboxed agents can't reach the socket.

## 1. Disambiguation — two projects named "cmux"

| | **manaflow-ai/cmux** | **craigsc/cmux** |
|---|---|---|
| What | Native macOS GUI terminal | Bash CLI script |
| Built on | Ghostty / Swift / AppKit | Git + Claude CLI |
| Purpose | Terminal *workspace* for running any agent | *Worktree lifecycle* manager for Claude |
| Key commands | `cmux notify`, split, `cmux browser`, `cmux set-status` | `cmux new/start/cd/ls/merge/rm/init` |
| Install | `brew install --cask cmux` / DMG | `curl …/install.sh \| sh` |
| Stars (approx) | ~4,500 | small/niche |
| License | AGPL-3.0 | — |

They are not forks of each other. **This KB is primarily about manaflow-ai/cmux**
(the terminal the user runs Claude Code inside); §6 covers craigsc/cmux, and the two
compose well (run the craigsc worktree CLI *inside* the manaflow terminal).

## 2. What it is & the problem it solves

Running several Claude Code sessions in a plain terminal or tmux means: no signal for which
agent is blocked without switching panes; subagents/teammates run as hidden background
processes; no per-tab workspace context (branch/PR/CWD/ports); macOS notifications lack
project context; and browser testing needs a separate, unscriptable window.

cmux makes the **terminal itself agent-aware**. Architecture: Swift + AppKit (no Electron),
**libghostty** for terminal rendering, **Bonsplit** for layout, **WebKit** for the browser
pane, and a **Unix domain socket** at `/tmp/cmux.sock` for JSON IPC (near-instant, not PTY
scraping). Philosophy is explicitly *"a primitive, not a solution"* — composable tools
(terminal + browser + notifications + workspaces), not a prescribed workflow.

## 3. Key features

| Feature | Detail |
|---|---|
| Vertical tab sidebar | Live git branch, PR status/number, CWD, listening ports, latest notification text — zero config |
| Notification rings | Blue ring + sidebar highlight when an agent needs attention; `⌘⇧U` jump to latest unread; `⌘I` unified panel; dock badge |
| Split panes | `⌘D` vertical / `⌘⇧D` horizontal; Claude Code teammates spawn as native splits |
| Embedded browser | WebKit pane scriptable via `cmux browser snapshot\|click\|navigate\|fill\|eval`; agents verify their own web output |
| Socket / CLI API | All actions via JSON to `/tmp/cmux.sock` or `cmux` CLI (~80+ commands); `cmux-agent-mcp` exposes 81 as MCP tools |
| Session persistence | Restores windows, panes, CWDs, scrollback, **and agent sessions** across quit *and full reboot* |
| Status / progress / flash | `cmux set-status` (SF Symbols), `cmux set-progress` (bar), `cmux trigger-flash` (pane) |
| SSH workspaces | Remote pane creation with authenticated browser panes |
| iOS companion | Real-time terminal sync to iPhone/iPad (paid Founders tier) |
| Config | Terminal settings inherited from `~/.config/ghostty/config`; cmux settings in `~/.config/cmux/cmux.json` |

## 4. cmux vs tmux / iTerm2 / Warp

| | cmux | tmux | iTerm2 | Warp |
|---|---|---|---|---|
| Type | Native macOS GUI app | Multiplexer inside any TTY | macOS terminal | Electron terminal |
| Agent notifications | First-class (rings, sidebar, dock) | Manual setup | No workspace context | Platform-locked AI |
| Subagent → pane | Automatic (Claude teams) | No | No | No |
| Embedded scriptable browser | Yes | No | No | No |
| GPU-accelerated | Yes (libghostty) | No | No | No |
| Config burden | Ghostty config + cmux.json | `.tmux.conf` + prefix key | Prefs UI | Prefs UI |
| Memory | High (~1.2 GB/53 min, see §7) | Minimal | Moderate | High (Electron) |

## 5. cmux + Claude Code workflow

**Install:** `brew tap manaflow-ai/cmux && brew install --cask cmux` (or DMG from releases; auto-updates via Sparkle).

**Launch Claude:** open a pane, `cd` to the project, run `claude`. **No wrapper or special config** —
cmux is just the terminal.

**Teammates as panes:** `cmux claude-teams` runs Claude Code in teammate mode; cmux intercepts teammate
spawns and opens them as native split panes with sidebar metadata auto-populated. NOTE: a plain `claude`
session's subagents do **not** auto-surface — they run hidden inside the parent unless teams mode is used.

**Wire notifications** so a blocked agent rings (three interchangeable methods):
1. **OSC 777** (recommended, zero deps): agent emits `\x1b]777;notify;Title;Body\x07`; cmux catches it natively.
2. **CLI stop-hook**: add `cmux notify "Agent needs input"` to Claude Code's Stop/Notification hook in `~/.claude/settings.json`.
3. **OSC 9 / 99**: iTerm2-/Kitty-compatible sequences also work.

cmux's own hook layer translates Claude's OSC into `cmux claude-hook <subcommand>`, which classifies
the notification and routes it to the ring/panel/Notification Center.

**MCP amplifier:** `npm install -g cmux-agent-mcp && cmux-agent-mcp init` gives any MCP agent 81 tools
mapping to cmux CLI — spawn a 2×2 grid of agents, broadcast/targeted commands, `cmux_session_recover`
after a crash, browser automation. Hierarchy: Window → Workspace → Pane → Surface → Panel.

**Multi-agent UX stack** (one practitioner framing, danielvaughan): cmux = *visual* layer; **ACPX** =
*protocol* layer (headless JSON-RPC client, named sessions, queue/cancel); **OMX** = *orchestration*
layer (Codex-CLI based, isolated git worktrees by default). cmux visualizes; the others route/spawn.

## 6. craigsc/cmux — the worktree CLI (separate project)

"Run a fleet of Claude agents on the same repo — each in its own worktree, zero conflicts, one command each."
Pure bash over `git worktree` + the Claude CLI. Worktrees live in `.worktrees/<branch>/` (add to `.gitignore`).

| Command | Purpose |
|---|---|
| `cmux new <branch>` | Create isolated worktree+branch, run `.cmux/setup` hook, launch Claude |
| `cmux start <branch>` | Resume an existing worktree's session |
| `cmux cd / ls` | Navigate into / list active worktrees |
| `cmux merge [branch]` | Merge worktree branch into primary checkout |
| `cmux rm [branch]` | Delete worktree and branch |
| `cmux init` | Generate the `.cmux/setup` hook with Claude's help |

`new` creates a *new* worktree+session; `start` continues an *existing* one. The `.cmux/setup` hook handles
project init (symlink secrets, install deps, codegen). Composes with manaflow-ai/cmux: run it inside that terminal.

## 7. Gotchas

- **Memory / resource use (significant).** A community audit of **v0.64.2** (issue #3586) found a
  **1.2 GB physical footprint after ~53 min of light use** (peak 1.4 GB, 645 MB swapped), **119 threads
  at idle**, 798 small leaks (NSCTFont), **9,000+ SwiftUI `AnyTrackedValue` retentions**, and **477 MB of
  IOSurface address space allocated but empty**. Earlier v0.63.x reports reached 70+ GB swap on 16 GB Macs
  with typing lag. Active dev area — check release notes before upgrading; many simultaneous agent panes push this further.
- **Orphaned monitor children.** The same audit found multiple `cmux hooks codex monitor` processes
  **reparented to launchd (PID 1)** after teardown (~270 MB combined) — the *exact* MCP-orphan failure mode
  the repo's own memguard/reaper guards against. Monitor with `pgrep -fl 'cmux hooks'`; kill if accumulated.
- **Sandboxing breaks the socket.** Agents in a sandbox that blocks `/tmp/cmux.sock` lose all socket
  features *silently* (`Failed to connect to socket at /tmp/cmux.sock`). Verify with `cmux --version` from
  inside the pane; fall back to OSC-sequence notifications if the sandbox can't be opened.
- **Notification flakiness.** Issue #2322 documents inconsistent delay between task completion and ring
  delivery; if the socket is slow it falls back to OSC with different timing. Check `ls /tmp/cmux.sock` first.
- **Subagent detection caveat.** cmux surfaces subagents as panes only via Claude **teams** mode
  (`cmux claude-teams`); a regular `claude` session's subagents stay hidden in the parent process.
- **macOS-only & AGPL-3.0.** No native Linux/Windows build (Windows port = `wmux`); AGPL affects commercial redistribution.

## 8. Uncertain / not verified

- Exact current version/star count (point-in-time: ~v0.61–0.64, ~4.5k stars across sources).
- Whether the §7 memory issues are fixed in versions after this research — **not re-checked in-repo**.
- The `cmux-agent-mcp` and ACPX/OMX layers are third-party / practitioner tooling, not first-party cmux.

## Sources

1. [OFFICIAL] cmux GitHub (manaflow-ai) — https://github.com/manaflow-ai/cmux — active 2025–2026 — canonical repo; README, releases, issues
2. [OFFICIAL] cmux.com — https://cmux.com/ — active — feature overview, docs index, pricing (free/AGPL + paid Founders)
3. [OFFICIAL] cmux Docs · Introduction — https://manaflow-ai-cmux.mintlify.app/introduction — active — "primitive not a solution"; architecture
4. [OFFICIAL] cmux Docs · Notifications — https://manaflow-ai-cmux.mintlify.app/features/notifications — active — OSC 9/99/777, `cmux notify`, shortcuts
5. cmux: Native macOS Terminal for AI Agents — DEV (ArshTechPro) — https://dev.to/arshtechpro/cmux-the-native-macos-terminal-built-for-running-ai-coding-agents-in-parallel-52il — 2025-05-25 — vs tmux/iTerm2/Warp; hook scripts; v0.61
6. cmux: Native macOS Terminal for AI Coding Agents — Better Stack — https://betterstack.com/community/guides/ai/cmux-terminal/ — 2026-03-06 — socket API deep-dive; sandboxing gotcha
7. cmux Complete Guide — Gardenee/agmazon — https://agmazon.com/blog/articles/technology/202603/cmux-terminal-ai-guide-en.html — 2026-03-25 — split-panel render bugs; AGPL note
8. craigsc/cmux — "tmux for Claude Code" — https://github.com/craigsc/cmux — active — separate worktree-lifecycle bash CLI
9. cmux-agent-mcp — https://github.com/multiagentcognition/cmux-agent-mcp — active — 81 MCP tools wrapping cmux CLI; session recovery
10. cmux, ACPX & OMX: Three Layers of Multi-Agent UX — danielvaughan — https://codex.danielvaughan.com/2026/04/09/cmux-acpx-omx-three-layers-multi-agent-ux/ — 2026-04-09 — visual/protocol/orchestration stack
11. Memory audit: cmux v0.64.2 (Issue #3586) — https://github.com/manaflow-ai/cmux/issues/3586 — 2026 — 1.2 GB footprint, 119 threads, orphaned codex monitors

_Compiled 2026-06-29 from a WEB-only research sweep; claims are sourced, not verified in-repo. All URLs fetched and confirmed to resolve at compile time._
