# KB — Claude Code's hook system (current, as of 2026-09-04)

Reference only. This is a factual map of the hook surface Claude Code (the CLI/harness)
exposes today, sourced from official docs. **No analysis of anti-hall's own hooks and no
change proposals here** — that is a separate review pass, deliberately out of scope for
this document.

**Provenance:** verified against `code.claude.com/docs/en/hooks`,
`code.claude.com/docs/en/hooks-guide`, and `code.claude.com/docs/en/sub-agents` on
2026-09-04. Docs move — re-verify before relying on an exact payload field or exit-code
row for a decision with real consequences. Where the official docs did not state a fact,
this KB says `NOT IN OFFICIAL DOCS` rather than filling the gap.

**Out of scope:** the Codex port (`plugins/anti-hall/codex/`) has its own, different hook
surface (Codex CLI lifecycle hooks) — not covered by this document.

**Verification status:** most rows below are doc-sourced only and have NOT all been
empirically verified against live harness behavior — treat an un-annotated row as
"per docs, unconfirmed live" rather than independently tested. Where this plugin's own
68 hooks (`plugins/anti-hall/hooks/hooks.json`) demonstrate live, first-party behavior
that contradicts the docs for an event we actually register, the observed behavior is
recorded alongside the doc claim in that row, with the disagreement stated plainly
rather than one silently overriding the other.

**MEASURED vs DOCUMENTED — three classes of claim in this KB:**

1. **Doc-sourced** — taken directly from the official docs listed under Sources, unannotated.
2. **Contradicted-by-observation** — a doc claim this plugin's own live hooks disprove
   (see `PostToolUse` / `PostToolUseFailure` / `Stop` rows in §1, marked **Disputed**).
3. **MEASURED** — established this session by direct experiment in an isolated scratch
   environment, not sourced from docs at all (docs are silent or wrong on these). Each
   MEASURED claim below states its method so it can be re-run. Where any of these three
   classes conflict, **observation wins** — a doc statement (or a doc's silence) never
   overrides a reproduced measurement.

---

## 1. The complete event table (33 events)

Granularity is the single most load-bearing column here — it tells you whether a hook
fires once per session, once per turn, once per tool call, once per subagent, or only on
a state-change edge.

| # | Event | Fires when | Granularity | Key payload fields | Can block? | Can inject context? | Async? |
|---|---|---|---|---|---|---|---|
| 1 | `SessionStart` | Session begins or resumes | Per session | `session_id`, `cwd`, `permission_mode`; matcher: `startup`/`resume`/`clear`/`compact`/`fork` | Yes — exit 2 | Yes — `additionalContext` | Supported |
| 2 | `Setup` | `--init-only`, or `--init`/`--maintenance` in `-p` mode | Per session init | `session_id`, `cwd`; matcher: `init`/`maintenance` | Yes — exit 2 | Yes | Supported |
| 3 | `UserPromptSubmit` | User submits a prompt, before Claude processes it | Per turn | `session_id`, `prompt_id`, `cwd`, `permission_mode`, `prompt_text` | Yes — exit 2 blocks and erases the prompt | Yes — `additionalContext`, `updatedInput`; plain-text stdout also visible | Not supported (timeout default 30s) |
| 4 | `UserPromptExpansion` | A typed slash command expands into a prompt, before it reaches Claude | Per turn (slash commands only) | `session_id`, `cwd`; matcher: command name | Yes — exit 2 blocks the expansion | Yes — `updatedInput` | Not supported (timeout default 30s) |
| 5 | `PreToolUse` | Before a tool call executes | Per tool call | `session_id`, `prompt_id`, `cwd`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`, `agent_id`/`agent_type` if subagent | Yes — exit 2, or `permissionDecision: "deny"/"block"` | Yes — `additionalContext`, `updatedInput`, `hookSpecificOutput` | Supported; timeout default 600s (30s on some) |
| 6 | `PermissionRequest` | A tool call needs a permission decision | Per tool call (permission gate) | `session_id`, `cwd`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id` | **No** — exit 2 is not honored for this event | Limited — `additionalContext` only | Supported |
| 7 | `PermissionDenied` | Auto mode denies a tool call (including denials without a classifier verdict) | Per tool call (post-denial) | `session_id`, `cwd`, `permission_mode`, `tool_name`, `tool_input` | No — output/exit code ignored | `hookSpecificOutput.retry: true` tells the model it may retry | Supported |
| 8 | `PostToolUse` | After a tool call succeeds | Per tool call | `session_id`, `tool_name`, `tool_input`, `tool_output`, `agent_id`/`agent_type` | No (tool already ran); exit 2 shows stderr to Claude | **Disputed.** Per docs: no structured injection (stderr shown to Claude on exit 2 only). Per observation: **contradicted** — `plugins/anti-hall/hooks/output-verify-guard.js:185-194` and `plugins/anti-hall/hooks/devswarm-child-drain.js:150-155` both emit `hookSpecificOutput.additionalContext` on `PostToolUse`, and these injections have been confirmed landing live, repeatedly, in this session's own transcript (including while auditing this row). Docs and observation disagree; both are recorded rather than one silently overriding the other. | Supported |
| 9 | `PostToolUseFailure` | After a tool call fails | Per tool call | same shape as `PostToolUse` plus `tool_error` | No; exit 2 shows stderr to Claude | **Disputed**, same pattern as row 8. Per docs: no. Per observation: **contradicted** — `plugins/anti-hall/hooks/failure-root-cause-nudge.js:79-80` emits `hookSpecificOutput.additionalContext` on `PostToolUseFailure`, and it was observed landing live in this session (fired twice while auditing this KB, on two failed Bash commands). | Supported |
| 10 | `PostToolBatch` | After a full batch of parallel tool calls resolves, before the next model call | Per batch of tool calls (no matcher support — always fires) | `session_id`, `prompt_id`, `tool_batch` array | Yes — exit 2 stops the agentic loop before the next model call | Yes — `additionalContext` | Supported |
| 11 | `Stop` | Claude finishes responding | Per turn (no matcher) | `session_id`, `prompt_id`, `last_assistant_message`, `stop_reason` | Yes — exit 2 prevents stopping, continues the conversation | **Disputed.** Docs are internally ambiguous here (the decision-control field table lists `additionalContext` as available to events on "the standard decision model", which includes Stop, but the separate stdout-visibility list names only `UserPromptSubmit`/`UserPromptExpansion`/`SessionStart`/`PostModelSwitch` as events where stdout reaches Claude — Stop is not on that list). This plugin's own hooks resolve the ambiguity empirically: **none of the 8 registered `Stop` hooks** (`task-guard.js`, `tasklist-guard.js`, `speculation-guard.js`, `speculation-judge.js`, `codex-nudge.js`, `devswarm-parent-gate.js`, `devswarm-child-gate.js`) emit `additionalContext`; all route their only model-reaching text through the top-level `{"decision":"block","reason":"..."}` field instead. `plugins/anti-hall/hooks/graphify-reminder.js:8-19` documents why in comments: an earlier version emitted `additionalContext` on `Stop` and observed it as a **silent no-op** — the reminder never reached the model until switched to `decision:block`. Recorded as contradicted-by-observation rather than resolved. | Supported |
| 12 | `StopFailure` | Turn ends due to an API error | Per turn | `session_id`, `error_type`, `error_message`; matcher: error type (e.g. `rate_limit`, `authentication_failed`) | No — output/exit code ignored except `terminalSequence` | No (only `terminalSequence` honored) | Supported |
| 13 | `TeammateIdle` | An agent-team teammate is about to go idle | Per team event (no matcher) | `session_id`, `agent_type`, `agent_id`, team context | Yes — exit 2 prevents the teammate from going idle | Yes — `additionalContext` | Supported |
| 14 | `InstructionsLoaded` | A CLAUDE.md or `.claude/rules/*.md` file is loaded into context | Per load event (session start and lazy loads) | `session_id`, `file_path`, `file_content`, load reason | Yes — exit 2 | Yes — `additionalContext`; matcher: `session_start`/`nested_traversal`/`path_glob_match`/`include`/`compact` | Supported |
| 15 | `ConfigChange` | A configuration file changes during a session | Per config change | `session_id`, `config_source`, `config_changes` | Yes — exit 2 blocks the change (except `policy_settings`) | Yes — `additionalContext`; matcher: `user_settings`/`project_settings`/`local_settings`/`policy_settings`/`skills` | Supported |
| 16 | `CwdChanged` | Working directory changes (e.g. `cd`) | Per directory change (no matcher — always fires) | `session_id`, `cwd`, `previous_cwd` | Yes — exit 2 | Yes | Supported (async event) |
| 17 | `DirectoryAdded` | A working directory is added mid-session via `/add-dir` or SDK `register_repo_root` | Per directory addition | `session_id`, `directory_path`, `added_via`; matcher: `slash_command`/`register_repo_root` | Yes — exit 2 | Yes | Supported (async event) |
| 18 | `FileChanged` | A watched file changes on disk **— but only if `watchPaths` was registered first; see §1a, MEASURED, undocumented** | Per file change | Per docs: `session_id`, `file_path`, `change_type` (created/modified/deleted). **MEASURED** (§1a): actual observed fields on fire were `session_id`, `file_path`, `event` (e.g. `"change"`) — `event` was observed where docs describe `change_type`; not reconciled further. Matcher: literal filenames only (exact-match set, not regex) | Yes — exit 2 | Yes — `additionalContext` | True async event |
| 19 | `WorktreeCreate` | A worktree is being created (`--worktree`, `isolation: "worktree"`, or a background session) | Per worktree creation (no matcher) | `session_id`, `worktree_path`, `worktree_type`, `parent_path` | Yes — **any nonzero exit** aborts creation, regardless of JSON | Limited — no structured-output support | Not supported |
| 20 | `WorktreeRemove` | A worktree is being removed (session exit, subagent finish, deletion) | Per worktree removal (no matcher) | `session_id`, `worktree_path`, `removal_reason` | Yes — exit 2 | Yes | Supported (async event) |
| 21 | `PreCompact` | Before context compaction | Per compaction event | `session_id`, `context_size_before`; matcher: `manual`/`auto` | Yes — exit 2 | Yes | Not supported |
| 22 | `PostCompact` | After context compaction completes | Per compaction event | `session_id`, `context_size_before`, `context_size_after`; matcher: `manual`/`auto` | No | Yes — `additionalContext` | Supported (async event) |
| 23 | `PreModelSwitch` | Before Claude Code applies a model switch (user- or client-requested) | Per model-switch event | `session_id`, `from_model`, `to_model` (canonical name), `switch_reason`; matcher: canonical model name | Yes — exit 2 can block the switch; timeout-exceeded also blocks | Yes — `additionalContext` | Not supported (sequential; timeout default 30s) |
| 24 | `PostModelSwitch` | After the session's model changes (including changes Claude Code makes itself) | Per model change | `session_id`, `from_model`, `to_model`, `switch_reason`, `switch_source` | No | Yes — `additionalContext`; plain-text stdout also visible | Supported (async event, timeout default 30s) |
| 25 | `Notification` | Claude Code sends a notification | Per notification | `session_id`, `notification_type`, `notification_title`, `notification_message`; matcher over ~10 notification types (`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_*`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_*`) | No — output ignored | No | Supported |
| 26 | `MessageDisplay` | Assistant message text is displayed (display-only) | During message streaming (no matcher) | `session_id`, `prompt_id`, `message_content`, `is_final` | No | No — output ignored | Supported; timeout default 10s |
| 27 | `SubagentStart` | A subagent is spawned | Per subagent invocation | `session_id`, `agent_id`, `agent_type`, `subagent_config`; matcher: agent type (`general-purpose`, `Explore`, `Plan`, custom names, or plugin-scoped `^my-plugin:reviewer$`) | Yes — exit 2 | Yes — `additionalContext` | Supported |
| 28 | `SubagentStop` | A subagent finishes | Per subagent completion | `session_id`, `prompt_id`, `agent_id`, `agent_type`, `last_assistant_message`, `stop_reason` | Yes — exit 2 prevents the subagent from stopping | Yes — `additionalContext` | Supported |
| 29 | `TaskCreated` | A task is being created via `TaskCreate` | Per task creation | `session_id`, `task_id`, `task_title`, `task_description`, `task_scope` | Yes — exit 2 rolls back the task creation | Yes — `additionalContext`, `updatedInput` | Supported |
| 30 | `TaskCompleted` | A task is being marked completed | Per task completion (state change) | `session_id`, `task_id`, `task_title`, `task_status`, `task_outcome` | Yes — exit 2 prevents the task from being marked complete | Yes — `additionalContext` | Supported |
| 31 | `Elicitation` | An MCP server requests user input during a tool call | Per MCP elicitation request | `session_id`, `mcp_server`, `elicitation_prompt`, `mcp_tool_use_id` | Yes — exit 2 (note: an exit-2 hook's `hookSpecificOutput` is ignored) | Yes — `hookSpecificOutput.elicitationResponse` | Supported |
| 32 | `ElicitationResult` | After a user responds to an MCP elicitation, before the response returns to the server | Per elicitation response | `session_id`, `mcp_server`, `mcp_tool_use_id`, `user_response`, `original_elicitation` | Yes — exit 2 (same caveat as above) | Yes — `hookSpecificOutput.updatedResponse` | Supported |
| 33 | `SessionEnd` | Session terminates | Per session | **CORRECTED, MEASURED 2026-09-05 via a real `claude -p` probe**: the field is `reason` (`clear`/`resume`/`logout`/`prompt_input_exit`/`other`), NOT `end_reason` — the row previously stated `end_reason` here, sourced from the official docs page, but the actual observed wire payload never carries that key. Full observed key set: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`, `reason`. A consumer should read `reason` as primary and may accept `end_reason` only as a defensive fallback alias in case a future/different harness build reintroduces it. | No | No | Not supported; all `SessionEnd` hooks share a 1.5s budget (raised up to 60s if a configured per-hook timeout exceeds it) |

**Note on the anti-hall research prompt's 21-event baseline:** that list was missing 12
events found here — `Setup`, `UserPromptExpansion`, `PermissionDenied`, `PostToolBatch`,
`StopFailure`, `CwdChanged`, `FileChanged`, `PostCompact`, `MessageDisplay`,
`TaskCreated`, `Elicitation`, `ElicitationResult`. All 33 are now accounted for above.

---

## 1a. `FileChanged` — undocumented `watchPaths` requirement (MEASURED)

Neither `code.claude.com/docs/en/hooks` nor `code.claude.com/docs/en/hooks-guide`
mentions this, and it was not previously recorded in this KB. This is the most
consequential finding in this section.

- **Method:** in an isolated scratch environment, a `FileChanged` matcher was declared
  in settings with no other configuration. A watched file was touched (create/modify)
  across multiple runs.
- **Result:** the hook **never fired, zero times across multiple runs**. Declaring a
  `FileChanged` matcher registers nothing to watch by itself.
- **Root cause (MEASURED):** the actual watch list is populated from
  `hookSpecificOutput.watchPaths` — an array of **absolute paths** — returned by a
  **`SessionStart`** hook. Only after a `SessionStart` hook returned `watchPaths` did the
  corresponding `FileChanged` hook begin firing on changes to those paths.
- **Corroboration:** the function name `updateWatchPaths` appears in the CLI binary's
  strings output, consistent with a watch-list populated at session start rather than
  from the `FileChanged` matcher config alone.
- **Matcher semantics still hold once wired up:** the `matcher` field remains a literal-
  filename filter, not a glob (per §1's existing note) — but since `watchPaths` is
  computed fresh at session start, a hook author can compute dynamic/session-specific
  absolute paths there without needing glob support in the matcher.
- **Payload observed on fire:** `session_id`, `file_path`, and `event` (e.g. `"change"`)
  — see the reconciliation note against the docs' `change_type` field in §1, row 18.
- **Practical implication:** any `FileChanged` hook that isn't paired with a
  `SessionStart` hook returning `hookSpecificOutput.watchPaths` for the same paths is
  dead configuration — it will never fire, silently, with no error indicating why.

---

## 2. Handler types

| Type | What it is | Config shape (core fields) | When to use it | What it returns |
|---|---|---|---|---|
| `command` | Runs a local shell command/script | `command`, optional `args` (exec form if present, else shell form via `sh -c`/PowerShell), `async`, `asyncRewake`, `shell`, `timeout`, `statusMessage`, `if`, `once`. JSON on stdin. | Default choice — deterministic local logic, guards, formatting, logging | stdout/stderr + exit code; stdout parsed as JSON if it starts with `{` and ends with `}`, else treated as plain text |
| `http` | POSTs the hook JSON to an HTTP endpoint | `url`, `headers`, `allowedEnvVars` (env vars usable in header interpolation), `timeout`. Must match `allowedHttpHookUrls` allowlist if one is configured. | Centralized/remote policy services, integrating an existing web backend | Response body, parsed like `command` stdout |
| `mcp_tool` | Calls a tool on an already-connected MCP server | `server` (or scoped `plugin:<plugin-name>:<server-name>`), `tool`, `input` (supports `${path}` substitution from hook JSON), `timeout` | Reusing an MCP server's own logic/tools as a hook decision-maker | The tool's text content, parsed like `command` stdout |
| `prompt` | Sends the hook's input JSON to a Claude model (Haiku by default) for a judgment call | `prompt` (with `$ARGUMENTS` placeholder for hook input JSON), `model` (optional override), `timeout` (default 30s) | Decisions needing judgment rather than a deterministic rule | JSON: `"ok": true` proceeds; `"ok": false` behavior is event-specific — e.g. on `Stop`/`SubagentStop` the `reason` is fed back to Claude to keep it working unless `"impossible": true`; on `PreToolUse` the tool call is denied (turn ends by default, or `continueOnBlock: true` feeds the `reason` back as the tool error instead — pre-v2.1.210 default behavior was the reverse); on `PostToolUse` similarly gated by `continueOnBlock`; on `PostToolBatch`/`UserPromptSubmit`/`UserPromptExpansion` the turn ends and `reason` shows as a warning line |
| `agent` (experimental) | Spawns a subagent with tools (Read, Grep, Glob, etc.) to evaluate the hook | `prompt`, `model`, `timeout` (default 60s) | Judgment calls that need to actually inspect the repo/files before deciding | Subagent's JSON decision. Explicitly marked experimental — may change |

---

## 3. Async execution

| Mode | Behavior |
|---|---|
| `async: true` | Fire-and-forget — runs in the background, hook output is ignored, session continues immediately. `timeout` is not enforced when `async: true`. Use for logging/monitoring/non-critical side effects. |
| `asyncRewake: true` | Runs in the background. **On exit code 2**, it wakes Claude — the hook's stderr (or stdout if stderr is empty) is shown to Claude as a system reminder so it can react to a long-running background failure. |

**`asyncRewake` precision, as documented and where docs stop:**
- The field description states only: "If `true`, runs in the background and wakes Claude
  on exit code 2. The hook's stderr, or stdout if stderr is empty, is shown to Claude as
  a system reminder so it can react to a long-running background failure."
- There is no separate row for `asyncRewake` in the exit-code-behavior table — it appears
  to inherit the "exit 2 blocks/shows-to-Claude" semantics of its host event rather than
  defining a distinct code path.
- **Whether the wake reaches an IDLE (finished-turn) session versus only a currently
  RUNNING session is NOT IN OFFICIAL DOCS.** The phrase "wakes Claude" is not disambiguated
  further in either the hooks reference or the hooks guide. Do not assume either behavior
  without testing — this is exactly the kind of ambiguity the research brief asked to flag
  rather than resolve by guessing.

**MEASURED — `FileChanged` fires while a session is IDLE, but does NOT wake it:**

- **Method:** a background session was allowed to finish its turn and reach idle status
  (no pending model call). The watched file (registered via the §1a `watchPaths`
  mechanism) was then touched externally, from outside the session.
- **Result:** the `FileChanged` hook process **did fire**, with a correctly populated
  payload. But the idle session's transcript gained **zero** new entries — nothing
  surfaced to it. The hook runs; the idle session never sees the result.
- **Conclusion:** `FileChanged` hooks alone are not a mechanism for waking an idle
  session. This is consistent with the upstream issue this plugin already cites
  (`anthropics/claude-code#44380`) on hooks not reliably reaching an idle session.
- **UNTESTED HYPOTHESIS — do not treat as fact:** since a `FileChanged` hook process
  does execute while the session is idle (confirmed above), and `asyncRewake` is
  documented to surface a hook's stderr to Claude on exit code 2, it is possible that
  pairing `FileChanged` with `asyncRewake: true` and an exit-2 stderr payload forms a
  working idle-wake path — even though a plain (non-`asyncRewake`) `FileChanged` hook,
  as measured above, does not wake an idle session. **This has not been tested.** The
  experiment that would settle it: register a `FileChanged` hook with `asyncRewake:
  true` whose handler exits 2 and writes a sentinel to stderr; put the session in the
  same finished-turn idle state as above; touch the watched file externally; then check
  whether the idle session's transcript gains a new system-reminder entry containing the
  sentinel (as it would for a mid-turn `asyncRewake` wake) versus staying silent (as the
  plain `FileChanged` case above did). Until that experiment runs, this is an open
  question, not a finding.

**Timeout defaults:**

| Hook type | Default | Documented overrides |
|---|---|---|
| `command`, `http`, `mcp_tool` | 600s | 30s on `UserPromptSubmit`, `UserPromptExpansion`, `PreModelSwitch`, `PostModelSwitch`; 10s on `MessageDisplay`; ignored entirely when `async: true` |
| `prompt` | 30s | Same per-event overrides apply where relevant |
| `agent` | 60s | Same per-event overrides apply where relevant |
| `SessionEnd` (any handler type) | Shared 1.5s budget across all `SessionEnd` hooks | Raised up to 60s total if any configured per-hook `timeout` exceeds the 1.5s budget |

**Injected-output size cap:** NOT IN OFFICIAL DOCS. Neither the hooks reference nor the
hooks guide states a documented byte/character cap on `additionalContext` or other
hook-injected output. Do not assume a specific number — **and per the MEASURED finding
below, "no documented cap" does not mean "no cap."**

**MEASURED — injected-context cap is exactly 10,000 chars, and truncation is silent:**

- **Method:** a `SessionStart` hook in an isolated scratch environment emitted
  `hookSpecificOutput.additionalContext` containing a sentinel string at the very start
  and another at the very end of an N-character payload, for several values of N.
- **Result:**

  | N (payload length) | Start sentinel | End sentinel |
  |---|---|---|
  | 10,000 | visible | visible |
  | 10,001 | visible | **LOST** |
  | 10,020–12,000 | visible | **LOST** |

- The cap sits at exactly 10,000 characters of injected context. Above that, the payload
  is truncated from the tail — the start sentinel always survives, the end sentinel
  never does past the boundary.
- **Truncation is silent**: no error surfaced to Claude, nothing appeared in `--debug`
  output, and nothing was logged to the debug-file log. A hook author has no signal that
  their payload was cut.
- **Consequence for this plugin:** the ~15.3k-char doctrine payload this plugin injects
  at session start is split across two separate `SessionStart` registrations
  (`plugins/anti-hall/hooks/verify-first-full.js:13-19` and
  `plugins/anti-hall/hooks/verify-first-orch.js:11-16`) specifically to stay under this
  cap per hook. That split is **justified by this measurement and should stay** — a
  single combined registration would silently lose roughly the back third of the
  doctrine text with no error anywhere.

---

## 4. Frontmatter hooks (agents and skills)

### Agent (subagent) frontmatter

```yaml
---
name: agent-name
hooks:
  PreToolUse:
    - matcher: "ToolName"
      hooks:
        - type: command
          command: "./scripts/validate.sh"
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "./scripts/run-linter.sh"
  Stop:
    - hooks:
        - type: command
          command: "./scripts/on-finish.sh"
---
```

- Only **three** events are supported in agent frontmatter: `PreToolUse`, `PostToolUse`,
  and `Stop`.
- `Stop` in a subagent's frontmatter is automatically converted to `SubagentStop` at
  runtime, since a subagent doesn't have a `Stop` event of its own.
- Frontmatter hooks fire "when the agent is spawned as a subagent through the Agent tool
  or an @-mention, and when the agent runs as the main session via `--agent` or the
  `agent` setting."
- **Trust requirement:** project-level subagent frontmatter hooks require the workspace
  trust dialog to be accepted for the folder containing the agent file. Until trusted,
  the subagent still runs, but Claude Code silently skips its frontmatter hooks and logs
  an error to the debug log. User-level subagents (home-directory agent files) and
  CLI-defined subagents are not gated this way.
- **Plugin subagents cannot define hooks at all** — for security reasons, plugin
  subagents don't support the `hooks`, `mcpServers`, or `permissionMode` frontmatter
  fields.

### Skill frontmatter

- Docs confirm skill frontmatter hooks exist and apply for "the rest of the session once
  the skill is invoked," and are shareable (defined in the skill file itself).
- The exact supported-event list and YAML shape for skill frontmatter hooks specifically
  (as distinct from the agent frontmatter shape above) is **NOT IN OFFICIAL DOCS** in the
  material retrieved for this KB — the hooks guide points to a `#hooks-in-skills-and-agents`
  reference section rather than spelling out a skill-specific event list inline. Do not
  assume it is identical to the agent frontmatter's three-event set without re-checking
  that section directly.

---

## 5. Output contract per event class

**Exit codes:**

| Code | Meaning | Blocks? | JSON honored? |
|---|---|---|---|
| `0` | Success | No | Yes — stdout parsed as JSON if well-formed, else plain text |
| `1` | Generic error | No | Yes, if valid JSON | 
| `2` | Blocking error | **Yes**, for events that support blocking (see table in §1) | Yes, but JSON cannot override a block once exit 2 is returned |
| Other (nonzero) | Varies by event | Mostly no, with named exceptions (`WorktreeCreate` blocks on ANY nonzero exit) | Yes, if valid JSON |

**What exit 2 means per event** (only the events where it does something):
- `PreToolUse`: blocks the tool call
- `UserPromptSubmit`: blocks the prompt and erases it
- `UserPromptExpansion`: blocks the expansion
- `Stop`: prevents stopping, continues the conversation
- `ConfigChange`: blocks the change (except `policy_settings`)
- `PreModelSwitch`: blocks the model switch
- `WorktreeCreate`: any nonzero exit aborts creation
- `PostToolUse` / `PostToolUseFailure`: tool already ran — exit 2 instead shows stderr to
  Claude (does not undo the tool call)
- `PermissionRequest`, `StopFailure`, `Notification`: exit 2 is **ignored** for these
  three events specifically

**JSON output shape** (`hookSpecificOutput`), fields observed across events:
`hookEventName`, `permissionDecision` (`allow`/`deny`/`block`), `permissionDecisionReason`,
`additionalContext`, `updatedInput`, `retry`, `terminalSequence`, `systemMessage`,
`elicitationResponse`, `updatedResponse`.

- `systemMessage` is metadata only — visible in the debug log, not to Claude.
- `terminalSequence` is OS-visible (desktop notification/bell/window title), not chat
  content.
- `additionalContext` is the general-purpose "inject into Claude's context" field, but is
  only honored on the events marked "Yes" in §1's block/inject columns — for events like
  `Notification`, `MessageDisplay`, `StopFailure`, and `SessionEnd`, injection is
  **inert** even if a hook returns it.
- **Multi-line JSON without an enclosing object is NOT parsed as JSON** — it is treated as
  plain text instead. JSON output must start with `{` and end with `}`.

**Matcher resolution:** an exact-match/list matcher may contain only
`[A-Za-z0-9_,| -]` (e.g. `Bash`, `Edit|Write`, `Edit, Write`); any other character makes
it a regex (e.g. `^Bash$`, `mcp__.*__write.*`). Tool events match on `tool_name`; model
events match on the canonical model name; notification events match on
`notification_type`; etc. Tool-event hooks also support a scoped `if` condition using
permission-rule syntax (e.g. `"if": "Bash(rm *)"`, `"if": "Edit(*.ts)"`) to filter within
an already-matched group — Bash argument matching is best-effort, and the hook still runs
if Claude Code cannot statically determine what a command expands to.

---

## 6. Gotchas (docs-warned)

- **`PermissionRequest`, `StopFailure`, and `Notification` do not honor exit code 2** —
  using it to block on these three events is a no-op; the docs call this out explicitly
  as a common "why doesn't my block work" mistake.
- **`PostToolUse`/`PostToolUseFailure` cannot undo a tool call** — the tool has already
  run by the time these fire; exit 2 only surfaces stderr to Claude, it does not roll
  anything back.
- **`WorktreeCreate` blocks on ANY nonzero exit code**, not just 2 — this is the one
  event where the general "only exit 2 blocks" rule doesn't hold.
- **`async: true` ignores `timeout` entirely** — don't rely on a configured timeout to
  bound a fire-and-forget hook.
- **`SessionEnd` hooks share a single 1.5-second budget** across all configured
  `SessionEnd` hooks combined, not 1.5s per hook — a slow `SessionEnd` hook can starve
  others. The budget only rises (up to 60s) if a hook's own configured `timeout` exceeds
  1.5s.
- **MEASURED 2026-09-05 (round 3, live `claude -p` with a real stdio MCP server, sampled
  every 500ms, 3/3 runs)**: on a CLEAN exit, Claude Code shuts down and reaps its own MCP
  server children BEFORE `SessionEnd` fires — the MCP child process was already gone from
  `ps` by the time `SessionEnd` ran in every run. On a hard crash (`kill -9` the claude
  process), `SessionEnd` does NOT run at all. Practical implication: a `SessionEnd` hook
  can never observe or clean up ITS OWN session's still-running MCP children on a clean
  exit (there aren't any left to find), and cannot run at all to react to a crash of its
  own session — the only thing such a hook can usefully do is sweep MCP-signature
  processes reparented to PID 1 that were LEFT BEHIND by a PREVIOUSLY crashed session,
  at the start of whatever session's `SessionEnd` runs next.
- **Elicitation and ElicitationResult**: an exit-2 hook's `hookSpecificOutput` is ignored
  for these two events specifically — the block takes effect but any structured response
  payload in the same output is dropped.
- **`FileChanged` matches literal filenames only**, not regex/glob path patterns — it's
  an exact-match set (e.g. `.envrc|.env`), so a glob-style matcher silently won't match
  what you expect.
- **Project-level subagent frontmatter hooks fail open, silently** — if the containing
  folder isn't trusted, the subagent still runs but its hooks are skipped with only a
  debug-log entry, not a visible error.
- **Plugin subagents cannot ship `hooks`, `mcpServers`, or `permissionMode` frontmatter
  at all** — a plugin author who wants subagent-scoped hooks needs a different mechanism
  (e.g. the plugin's own top-level `hooks/hooks.json` instead).
- **Hooks merge across levels rather than replacing** — user, project, project-local, and
  managed-policy hook configs for the same event all run; there is no override semantics,
  only accumulation. `disableAllHooks: true` is the only way to suppress a level, and
  cannot disable managed-policy hooks unless set at the managed-policy level itself.

---

## Sources

- https://code.claude.com/docs/en/hooks — hook event reference, handler types, async
  execution, output contract, matcher resolution
- https://code.claude.com/docs/en/hooks-guide — hook setup walkthrough, hook location
  precedence table, prompt-based hook decision semantics
- https://code.claude.com/docs/en/sub-agents — agent frontmatter hooks, trust
  requirements, plugin-subagent restrictions
