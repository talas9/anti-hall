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
**Provenance (2026-08-21):** the cross-session/agent-to-agent messaging, agent teams, and
§4 DevSwarm-implication material below was verified against the same docs tree on
2026-08-21 (local Claude Code version 2.1.238) and is additive to the 2026-08-01 audit —
none of the earlier claims were changed.

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

### Cross-session / agent-to-agent messaging

Local Claude Code version observed: **2.1.238**. Tools: `SendMessage`, `ListAgents`.

| target class | bidirectional | durable | wakes idle | addressable when not running |
|---|---|---|---|---|
| In-process subagents (spawned this session) | yes | **NO** | N/A (not idle-capable) | session-scoped only |
| Agent-team teammates | yes | **NO** | starts a turn when idle | only while session active |
| Other LOCAL Claude Code sessions (same machine) | yes | **NO** | starts a new turn if idle | **NO — message dropped if target not running** |
| Cloud/web sessions | one-way if sender not connected to Remote Control (receives, cannot reply) | **NO** | appears in conversation | only while running |
| Remote Control sessions (other machines) | yes, if sender is on Remote Control | **NO** | appears in conversation | only while running |

Documented behavior: *"The receiving Claude reads the message between tool calls during an
active turn. When the receiving session is idle, Claude Code starts a new turn with the
message."*

**DURABILITY VERDICT:** `SendMessage` is **live-session IPC, NOT a durable message bus.**
Messages to a non-running session are **dropped silently with no error to the sender**. No
ack, no read receipt, no replay, no queue-for-later. Does not survive the target's
exit/crash, `/clear`, `/compact`, or a machine restart.

**Nuance — do not overstate:** durability for offline targets is **UNDOCUMENTED**, not
documented-as-absent. Agent teams do persist a per-agent inbox JSON at
`~/.claude/teams/{team}/inboxes/{agent}.json`, so some on-disk state exists, but no
offline-delivery mechanism is described anywhere in the docs. Mark as **UNVERIFIED — needs
an empirical test** (see §4 below).

Source: [`/docs/en/cross-session-messaging`](https://code.claude.com/docs/en/cross-session-messaging.md), [`/docs/en/agent-teams`](https://code.claude.com/docs/en/agent-teams.md)

### Agent teams (EXPERIMENTAL)

Opt-in via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (v2.1.178+). Multiple coordinated
sessions, a shared task list, and direct messaging; split panes or in-process. Documented
limitations: **no session resumption with in-process teammates**, task status can lag, no
nested teams. Architecture: per-agent inbox JSON under `~/.claude/teams/{team}/inboxes/`.

**Flagged EXPERIMENTAL — unsuitable as the foundation for a shipped substrate today.**

Source: [`/docs/en/agent-teams`](https://code.claude.com/docs/en/agent-teams.md)

### Additions to the feature surface (absent from every prior doc in this repo — verified by grep)

| Feature | Status | One-line description |
|---|---|---|
| `ListAgents` | Stable | Enumerates addressable agents: in-process subagents, other local sessions, cloud sessions, and (when Remote Control is connected) the account's other sessions. Names are the address for `SendMessage`. |
| `EnterWorktree` / `ExitWorktree` | Stable | Worktree entry/exit tools. |
| Artifacts — `capabilities` | Gated per-account | Runtime capabilities for published interactive pages beyond static HTML. |
| `claude plugin eval` | Org-flag gated | Sandboxed plugin/skill testing. Graders: regex, LLM judge, `tool_used`, `file_exists`, baseline. `--json` v1 shape (`schemaVersion`, `cases[].arms.{with,without}[].graders`, `aggregates`), `--report` HTML, `--no-publish` local. Exit codes: 0 pass (default threshold 1.0), 1 fail/error/empty, 2 partial (cost-ceiling / auth-fail). |
| `Agent` tool `subagent_type: "fork"` | Stable (v2.1.212+) | Spawns a fork that inherits the parent's full context. |
| `Agent` tool `isolation: "worktree"` | Stable (v2.1.203+) | Runs the spawned agent in a temporary git worktree. |
| `Monitor` | Stable, with a gap | Unavailable on Bedrock/Vertex/Foundry. |
| `CronCreate` / `CronList` | Stable | Scheduled tasks within a session; restored on `--resume`. |

Source: [tools reference](https://code.claude.com/docs/en/tools-reference.md), [sub-agents](https://code.claude.com/docs/en/sub-agents.md), [hooks](https://code.claude.com/docs/en/hooks.md), [plugin eval](https://code.claude.com/docs/en/plugin-eval.md), [docs index](https://code.claude.com/docs/en/claude_code_docs_map.md)

---

## 4. Implication for anti-hall's DevSwarm mesh

**Question asked:** could Claude Code's native agent-to-agent messaging (`SendMessage` /
`ListAgents` / agent teams) REPLACE anti-hall's DevSwarm mesh store
(`~/.anti-hall/devswarm/store/<hash>/devswarm.db`, introduced v0.58.0)?

**Answer: NO — they solve different problems.** The mesh is a DURABLE system of record that
survives session death and supports replay/audit; `SendMessage` addresses only LIVE agents
and drops silently otherwise.

| property | DevSwarm mesh | `SendMessage` |
|---|---|---|
| Survives target death | ✅ | ❌ |
| Sender learns of non-delivery | ✅ | ❌ |
| Wakes an idle session | via cron + Monitor watcher | ✅ starts a new turn — genuinely better |
| Cross-machine | ❌ local SQLite | ✅ via Remote Control |
| Replay + audit | ✅ | ❌ |

**Recommended posture: LAYER, don't replace.** Keep the mesh as the durable store of
record; Claude's native messaging is a candidate LOW-LATENCY WAKE + live-coordination
layer over it — conceptually what
`plugins/anti-hall/companion/lib/devswarm-wake-watch.js` already does with a `Monitor`.
The one genuinely NEW capability it unlocks is **cross-machine** reach, which a local
SQLite mesh structurally cannot provide.

**Open / unverified:** an empirical test of what actually happens to a message sent to a
dead session — is the inbox JSON written and later drained, or is it truly dropped? Until
tested, treat durability as absent.

Assessed 2026-08-21 against Claude Code 2.1.238.

---

*Audited 2026-08-01. Re-verify hook contracts against current docs before building against them — see the adoption plan's Fable-review step. The
adoption plan was Fable-reviewed 2026-08-02, which corrected several hook
contracts assumed above: `PostCompact` cannot inject `additionalContext`
(side-effect-only), `SubagentStop` injects into the subagent's own turn
rather than the parent, and `ConfigChange` does not watch
`~/.anti-hall/skip.json`.*

*Extended 2026-08-21 (Claude Code 2.1.238): added the cross-session/agent-to-agent
messaging and agent-teams subsections plus §4's DevSwarm-mesh-vs-`SendMessage`
comparison. The empirical test of message delivery to a dead session (inbox JSON
written-and-drained vs. truly dropped) remains open — see §4.*
