# Claude Code harness feature surface vs anti-hall usage (audited 2026-08-01)

## 1. Purpose

A living map of what the Claude Code CLI/harness offers a plugin, what anti-hall
currently uses, and the gaps — so feature-adoption decisions are evidence-based
instead of vibes-based. Companion doc:
[`docs/superpowers/specs/2026-08-01-harness-feature-adoption.md`](./superpowers/specs/2026-08-01-harness-feature-adoption.md)
turns the gaps below into a phased adoption plan.

**Provenance:** every feature claim below was verified against the official
[code.claude.com/docs](https://code.claude.com/docs) tree on 2026-08-01.
Docs move — re-verify before acting, especially on exact hook payload contracts.

---

## 2. anti-hall CURRENT usage

| Feature | Used? | Evidence file | Notes |
|---|---|---|---|
| `SessionStart` hook | **USED** | `plugins/anti-hall/hooks/hooks.json` | 8 handlers: `verify-first-full.js`, `verify-first-orch.js`, `graphify-session.js`, `devswarm-child-role.js`, `version-alert.js`, `fable-availability.js`, `codex-availability.js`, `progress-prune.js`. Also covers `source=compact` re-injection (session resume after compaction). |
| `UserPromptSubmit` hook | **USED** | same | 5 handlers: `verify-first.js`, `task-tracker.js`, `limit-conserve-inject.js`, `devswarm-parent-inbox.js`, `devswarm-child-turn.js`. |
| `PreToolUse` hook | **USED** | same | Bash: `git-guard`, `command-guard`, `graphify-guard`, `merge-gate`. Write/Edit/MultiEdit: `api-guard`, `ship-it-guard`. Write/Edit/MultiEdit/NotebookEdit: `edit-guard`. Read: `inbox-read-guard`. Grep/Glob: `graphify-guard`. Agent+Task: `model-routing-guard`, `swarm-guard`, `phase-tracker`. |
| `SubagentStart` hook | **USED** | `hooks/verify-first-subagent.js` | Claude plugin only — not present in the Codex port (Codex has no equivalent lifecycle hook for sub-sessions today). |
| `Stop` hook | **USED** | same | `task-guard`, `tasklist-guard`, `graphify-reminder`, `speculation-guard`, `speculation-judge`, `codex-nudge`, `devswarm-parent-gate`, `devswarm-child-gate`. |
| `Monitor` tool | **USED (opt-in)** | `plugins/anti-hall/monitors/monitors.json` → `companion/lib/devswarm-wake-watch.js` | Watches a DevSwarm workspace's own mailbox count delta, edge-triggered wake. Gated to DevSwarm sessions (`DEVSWARM_REPO_ID`); dormant otherwise. |
| `run_in_background` | **USED** | orchestration guidance + the wake-watch process | Standard background-Bash pattern for long ops; also underlies the wake-watch companion. |
| `CronCreate` / `CronList` | **USED (opt-in)** | `hooks/lib/devswarm-wake.js` | DevSwarm self-wake fallback: an injected agent directive tells the agent to `CronCreate` its own wake job (Cron is a Claude tool, not a hook the plugin can register directly). |
| Skills | **USED** | `plugins/anti-hall/skills/` (14) + `plugins/anti-hall/codex/skills/` (17) | Claude: `activate`, `deadly-loop`, `deadly-loop-multi`, `debt`, `devswarm`, `doctor`, `flutter-debug`, `install-statusline`, `orchestration`, `root-cause`, `ship-it`, `simplify`, `system-briefing`, `update`. Codex: same set plus `context-conserve`, `omc`, `omx` (Codex-specific bridges), `model-policy`. |
| Statusline | **USED** | `plugins/anti-hall/statusline/` | Rich / simple / monorepo renderers + phase bar; installed via the `install-statusline` skill. |
| Subagent guards (`Agent`/`Task` matchers) | **USED** | `hooks.json` PreToolUse | `model-routing-guard`, `swarm-guard`, `phase-tracker` fire on both `Agent` and `Task` tool calls. |
| `Workflow` tool | **USED** | `plugins/anti-hall/skills/{deadly-loop,ship-it}/references/*.workflow.js` | Delivered as user-saved workflow templates — a plugin cannot ship a workflow directly as an installable command, so these ship as reference files a skill instructs the user/agent to save. |
| Plugin marketplace | **USED** | `.claude-plugin/marketplace.json`, `plugins/anti-hall/.claude-plugin/plugin.json` (v0.68.2) | Codex mirror at `plugins/anti-hall/codex/.codex-plugin/`. |
| **NOT USED** | — | — | `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStop`, `PreCompact`, `PostCompact`, `SessionEnd`, `Setup`, `Notification`, `TaskCreated`/`TaskCompleted` hooks, `ConfigChange`, `PermissionRequest`/`PermissionDenied`, `MessageDisplay`, `WorktreeCreate`/`WorktreeRemove`, `ScheduleWakeup` (referenced only in a code comment, not invoked), `CronDelete`, LSP servers (`.lsp.json`), output styles, Agent SDK / headless mode, MCP server ship-or-consume (deliberate CLI-over-MCP posture), sandboxing, checkpointing awareness. |

---

## 3. Full Claude Code harness feature surface (2026-08)

### Hook events
Source: [`/docs/en/hooks`](https://code.claude.com/docs/en/hooks).

| Event | One-line description |
|---|---|
| `SessionStart` | Fires when a session starts or resumes (incl. after `/compact`, `source=compact`). |
| `Setup` | Fires on first-time plugin/project setup. |
| `SessionEnd` | Fires when a session terminates. |
| `UserPromptSubmit` | Fires when the user submits a prompt, before the model sees it. |
| `UserPromptExpansion` | Fires when a prompt is expanded (e.g. slash-command/skill substitution). |
| `PreToolUse` | Fires before a tool call executes; can block/modify. |
| `PostToolUse` | Fires after a tool call completes successfully. |
| `PostToolUseFailure` | Fires after a tool call fails. |
| `PostToolBatch` | Fires after a batch of parallel tool calls completes. |
| `PermissionRequest` | Fires when a permission prompt would be shown. |
| `PermissionDenied` | Fires when a permission request is denied. |
| `Stop` | Fires when the agent is about to stop responding this turn. |
| `SubagentStart` | Fires when a spawned subagent session starts. |
| `SubagentStop` | Fires when a spawned subagent session stops. |
| `StopFailure` | Fires when a stop/completion attempt itself fails. |
| `TeammateIdle` | Fires when a teammate/agent in a multi-agent session goes idle. |
| `PreCompact` | Fires before context compaction runs. |
| `PostCompact` | Fires after context compaction completes. |
| `TaskCreated` | Fires when a task is added to the task list. |
| `TaskCompleted` | Fires when a task is marked complete. |
| `InstructionsLoaded` | Fires when CLAUDE.md/AGENTS.md/instruction files are loaded. |
| `ConfigChange` | Fires when settings/config files change. |
| `CwdChanged` | Fires when the working directory changes. |
| `FileChanged` | Fires when a watched file changes on disk. |
| `Notification` | Fires on harness notifications (e.g. permission-needed, idle). |
| `MessageDisplay` | Fires when a message is rendered to the user. |
| `WorktreeCreate` / `WorktreeRemove` | Fire on git worktree lifecycle events. |
| `Elicitation` | Fires when the harness elicits structured input (e.g. from MCP). |

### Long-running / background
Source: [`/docs/en/tools-reference`](https://code.claude.com/docs/en/tools-reference).

| Feature | One-line description |
|---|---|
| `Monitor` | Registers a background watcher process that can emit wake events. |
| Background `Bash` | Runs a shell command detached, polled/notified on completion. |
| `Task` / `Agent` tools | Spawn subagents/sub-sessions for delegated work. |
| `SendMessage` | Sends a message to another agent/teammate session. |
| `PushNotification` | Pushes a notification to the user outside the transcript. |
| `SendUserFile` | Delivers a file artifact to the user. |

### Scheduling
Source: [`/docs/en/scheduled-tasks`](https://code.claude.com/docs/en/scheduled-tasks), [`/docs/en/routines`](https://code.claude.com/docs/en/routines).

| Feature | One-line description |
|---|---|
| `/loop` | Re-runs a prompt/command on a recurring interval within a session. |
| `CronCreate` / `CronList` / `CronDelete` | Create/list/delete cron-style scheduled jobs that fire independent of an open REPL. |
| `ScheduleWakeup` | Schedules a one-time future wake for the current session. |
| Routines | Cloud-scheduled recurring agents (cron-driven, run headless). |
| `RemoteTrigger` | Triggers a remote/cloud agent run externally. |

### Plugin components
Sources: [`/docs/en/plugins`](https://code.claude.com/docs/en/plugins), [`/docs/en/plugins-reference`](https://code.claude.com/docs/en/plugins-reference), [`/docs/en/headless`](https://code.claude.com/docs/en/headless), [`/docs/en/settings`](https://code.claude.com/docs/en/settings), [`/docs/en/permissions`](https://code.claude.com/docs/en/permissions), [`/docs/en/memory`](https://code.claude.com/docs/en/memory).

| Feature | One-line description |
|---|---|
| Plugin system (`bin/`, `output-styles/`, `workflows/`, `monitors/`, `.mcp.json`, `.lsp.json`) | Declarative manifest surface a plugin ships components through. |
| Skills | Reusable, invokable instruction packages (`SKILL.md` + assets). |
| Slash commands | User-typed shortcuts that expand to a prompt/skill. |
| Subagents | Named agent personas with scoped tools/model. |
| Output styles | Alternate system-prompt presentation modes. |
| Statusline | Persistent status bar rendered above the input. |
| MCP | Model Context Protocol server integration (tools/resources). |
| LSP | Language Server Protocol integration for diagnostics/navigation. |
| Workflow tool | Programmatic multi-agent orchestration primitive. |
| Agent SDK / headless mode | Programmatic, non-interactive Claude Code execution. |
| Settings permissions | Allow/deny/ask rules for tools and commands. |
| Memory | `CLAUDE.md`/project-memory persistence layer. |

### Newer 2026 features

| Feature | One-line description | Doc |
|---|---|---|
| Checkpointing / rewind | Save and roll back to a prior conversation/file state. | [`/docs/en/checkpointing`](https://code.claude.com/docs/en/checkpointing) |
| Sandboxing | Contain tool execution (filesystem/network) inside a restricted boundary. | [`/docs/en/sandboxing`](https://code.claude.com/docs/en/sandboxing) |
| Permission modes | Named presets (default/acceptEdits/plan/bypass/etc.) governing tool approval. | [`/docs/en/permission-modes`](https://code.claude.com/docs/en/permission-modes) |
| Channels | Structured multi-party communication surface. | [`/docs/en/channels`](https://code.claude.com/docs/en/channels) |
| Sessions: resume / branch / fork | Session lifecycle operations beyond linear continuation. | — |
| Remote Control | Externally drive/observe a running session. | — |
| Worktrees | Git-worktree-scoped isolated session workspaces. | — |

### Flagged / unverified

- The `/docs/en/settings` summary listed hook names `beforeBash`/`afterBash`/`beforeWrite`/`afterWrite`/`configChange` that do **not** appear on `/docs/en/hooks`. Treat this as a summarization artifact — use the `/docs/en/hooks` event names (`PreToolUse`/`PostToolUse`/`ConfigChange`, etc.), not the settings-summary names.
- `agent-teams`, `agent-view`, `desktop-scheduled-tasks`, and the Remote Control page were referenced during this audit but **not fetched** — their contract is unverified.
- `/docs/en/llms.txt` returned **404** at audit time.

---

*Audited 2026-08-01. Re-verify hook contracts against current docs before building against them — see the adoption plan's Fable-review step. The
adoption plan was Fable-reviewed 2026-08-02, which corrected several hook
contracts assumed above: `PostCompact` cannot inject `additionalContext`
(side-effect-only), `SubagentStop` injects into the subagent's own turn
rather than the parent, and `ConfigChange` does not watch
`~/.anti-hall/skip.json`.*
