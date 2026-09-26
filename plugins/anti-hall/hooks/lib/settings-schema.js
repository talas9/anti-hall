'use strict';
// settings-schema.js — THE declarative registry of every user-facing anti-hall
// setting (v0.108.0). Built from a read-only inventory sweep of every
// ANTIHALL_* env var, ~/.anti-hall/*.json config file, and statusline option
// in plugins/anti-hall (see scratchpad/settings-inventory.md for the sweep
// this schema was checked against — 73 user-facing / 28 internal knobs).
//
// WHAT LIVES HERE vs NOT: internal/test-only escape hatches (spawn-timeout
// overrides, mock endpoints, tmp-HOME allowances, doctor self-test knobs) are
// EXCLUDED entirely — they are not settings a user is meant to change. Every
// remaining knob is included; ones a user tunes rarely (retention days,
// timeouts, cooldowns) are marked `advanced: true` so `settings.js show`
// keeps the common case readable and puts tuning knobs behind `--all`.
//
// SHAPE: SECTIONS is an ordered array of { key, label, description, settings }.
// Each setting: {
//   key, type: 'boolean'|'number'|'string'|'enum'|'csv',
//   values,      // enum only: allowed string values
//   min, max,    // number only: inclusive bounds
//   default,     // the value used when nothing else resolves it
//   env,         // optional ANTIHALL_* env var that overrides everything else
//   legacy,      // optional { file, key } — a pre-settings.json config file
//                // (relative to ~/.anti-hall/) this value used to live in
//   pluginOption,// optional key exposed in plugin.json userConfig, read from
//                // CLAUDE_PLUGIN_OPTION_<KEY> (hook processes) or a read-only
//                // fallback scan of ~/.claude/settings.json's
//                // pluginConfigs["anti-hall"].options (other processes)
//   advanced,    // true = hidden from the default `show` table (use --all)
//   locked,      // true = SAFETY key: settings.js set() needs --confirmed
//                // (0.108.4) ONLY when the new value is the RISKY direction
//                // (see safetyDirection) — without it nothing changes and a
//                // one-line factual warning (built from `safetyNote`) is
//                // returned instead; normal precedence (env > file > /config
//                // > legacy > default) applies once confirmed. reset() never
//                // needs confirmation — removing an override is always the
//                // safe direction. The confirmation is the protection, not
//                // a refusal.
//   safetyDirection, // locked only: which new value is RISKY —
//                // 'off' (default when omitted) = risky when set to false
//                //   (turning a guard off); 'on' = risky when set to true
//                //   (turning a bypass on); 'add' = risky when the new csv
//                //   value adds a token the current value doesn't have
//                //   (widening an allow-list).
//   safetyNote,  // locked only: one plain sentence stating the CONSEQUENCE
//                // of the risky change — "what stops happening" (off/on) or
//                // what becomes possible (add) — used to build the warning
//   description,
// }
//
// Boolean env decoding is ONE generic rule for every boolean setting: the env
// var's value is looked up case-insensitively in TRUE_TOKENS/FALSE_TOKENS
// below; anything else is treated as unset (falls through to the next
// precedence source). This matches every boolean ANTIHALL_* var found in the
// inventory sweep, whether its on-value is '1'/'on'/'true' or its off-value is
// '0'/'off'/'false'.
const TRUE_TOKENS = ['1', 'on', 'true', 'yes'];
const FALSE_TOKENS = ['0', 'off', 'false', 'no'];

const SECTIONS = [
  {
    key: 'autoHandover',
    label: 'Auto Handover',
    description: 'Automatic session-handover writing as context fills up.',
    settings: [
      { key: 'enabled', type: 'boolean', default: true, pluginOption: 'auto_handover_enabled', description: 'Write an automatic handover before context runs out.' },
      { key: 'pct', type: 'number', min: 1, max: 99, default: 85, env: 'ANTIHALL_AUTO_HANDOVER_PCT', pluginOption: 'auto_handover_pct', description: 'Context-usage percent that triggers an automatic handover.' },
      { key: 'maxTokens', type: 'number', pluginOption: 'auto_handover_max_tokens', min: 0, default: 0, env: 'ANTIHALL_AUTO_HANDOVER_MAX_TOKENS', description: 'Opt-in absolute context-token ceiling that also triggers the handover, whichever of pct/maxTokens fires first; 0 (the default) = no ceiling — the real per-session context window size (85% of it) is the only trigger unless a user explicitly sets this.' },
      { key: 'nag', type: 'boolean', default: true, pluginOption: 'auto_handover_nag', description: 'Nag (remind) the user when a handover is due but not yet written.' },
      { key: 'nagStepPct', type: 'number', pluginOption: 'auto_handover_nag_step_pct', min: 1, max: 100, default: 5, description: 'Percent increments between successive handover nags.' },
      { key: 'nagQuietMin', type: 'number', pluginOption: 'auto_handover_nag_quiet_min', min: 1, default: 15, description: 'Minutes to wait before repeating a handover nag.' },
      { key: 'gateNewWork', type: 'boolean', default: true, pluginOption: 'auto_handover_gate_new_work', description: 'Post-handover new-work gate: once context is past the threshold and this session\'s handover is written, the agent judges each new request\'s size before starting it and, if it needs more than gateBudgetPct of the context window, offers to park it in the task list + handover (start after /compact or /clear) or proceed if you insist. Quick questions, finishing the in-flight task, and spawning a DevSwarm workspace pass straight through. [read by: hooks/auto-handover.js, hooks/lib/auto-handover-gate.js]' },
      { key: 'gateBudgetPct', type: 'number', min: 1, max: 50, default: 5, pluginOption: 'auto_handover_gate_budget_pct', description: 'Context-window points a new request may use after the handover before the gate applies; also the measured backstop — one capped reminder to refresh the handover and offer to park the rest once usage grows this many points past where the handover was saved. [read by: hooks/auto-handover.js, hooks/lib/auto-handover-gate.js]' },
      { key: 'decisivePrompt', type: 'boolean', default: true, pluginOption: 'auto_handover_decisive_prompt', description: 'At a Stop (turn-ending) point once this session\'s handover exists and is fresh, tell the agent to end its reply with one prominent line naming the exact /compact (or /clear, or Codex /new) command — or, if the handover has gone stale since it was written, to refresh it first. Off reverts to the plain fire/pause-nag wording. [read by: hooks/auto-handover-pause-nag.js, hooks/lib/auto-handover-text.js]' },
    ],
  },
  {
    key: 'guards',
    label: 'Guards',
    description: 'On/off switches and tuning for the always-on safety guard hooks.',
    settings: [
      { key: 'mergeGate', type: 'boolean', default: false, env: 'ANTIHALL_MERGE_GATE', pluginOption: 'guards_merge_gate', description: 'Enable merge-readiness gate checks before merging. [verified: hooks/merge-gate.js:42 — default off, opt-in via =on]' },
      { key: 'shipitGate', type: 'boolean', pluginOption: 'guards_shipit_gate', default: false, env: 'ANTIHALL_SHIPIT_GATE', description: 'Enable the ship-it workflow gate. [verified: hooks/ship-it-guard.js:71 — default off, opt-in via =on]' },
      { key: 'outputVerifyGuard', type: 'boolean', pluginOption: 'guards_output_verify_guard', default: true, env: 'ANTIHALL_OUTPUT_VERIFY_GUARD', description: 'Output-verification guard (blocks unverified completion claims). [verified: hooks/output-verify-guard.js:198 — default on, =off disables]' },
      { key: 'failureRootCauseNudge', type: 'boolean', pluginOption: 'guards_failure_root_cause_nudge', default: true, env: 'ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE', description: 'Nudge toward root-cause analysis after a failure. [verified: hooks/failure-root-cause-nudge.js:49 — default on, =off disables]' },
      { key: 'repoSelfDrift', type: 'boolean', pluginOption: 'guards_repo_self_drift', default: true, env: 'ANTIHALL_REPO_SELF_DRIFT', description: "anti-hall's own repo-drift self-check hook. [verified: hooks/repo-self-drift.js:159 — default on, =off disables]" },
      { key: 'stashGuard', type: 'boolean', pluginOption: 'guards_stash_guard', default: false, env: 'ANTIHALL_STASH_GUARD', locked: true, safetyDirection: 'off', safetyNote: 'git stash commands that can silently drop uncommitted work will no longer be blocked', description: 'SAFETY (confirm to change — see settings.js set/reset). Arm the git-stash guard in command-guard: block mutating `git stash` (also armed per-repo via .anti-hall/protected-stashes). [verified: hooks/command-guard.js:1333 — default off, =1 arms]' },
      { key: 'emitDedupe', type: 'boolean', pluginOption: 'guards_emit_dedupe', default: true, env: 'ANTIHALL_EMIT_DEDUPE', description: 'Deduplicate repeated hook-emit output. [verified: hooks/lib/emit-dedupe.js:129 — default on, =0 disables]' },
      { key: 'injectionRepeatEvery', type: 'number', min: 0, default: 10, env: 'ANTIHALL_INJECTION_REPEAT_EVERY', pluginOption: 'guards_injection_repeat_every', advanced: true, description: 'Turns between full re-injections of a static UserPromptSubmit reminder block (VERIFY-FIRST, the DEVSWARM PRIMARY dispatch-tier/top-fan-out-tier suffixes) once its first-turn/post-compact copy has been consumed; set 0 to restore every-turn injection. [verified: hooks/verify-first.js, hooks/task-tracker.js — read via lib/emit-dedupe.js shouldEmit keepaliveTurns]' },
      { key: 'codexQuotaDetect', type: 'boolean', default: true, env: 'ANTIHALL_CODEX_QUOTA_DETECT', pluginOption: 'guards_codex_quota_detect', description: 'Detect a Codex-CLI quota/rate-limit exhaustion message in a codex:codex-rescue Agent result and record it to ~/.anti-hall/codex-availability.json so other lanes/sessions stop rediscovering the outage independently. [verified: hooks/codex-quota-detect.js — default on]' },
      { key: 'editGuardAllow', type: 'csv', default: '', env: 'ANTIHALL_EDIT_GUARD_ALLOW', pluginOption: 'guards_edit_guard_allow', locked: true, advanced: true, safetyDirection: 'add', safetyNote: 'those files can be edited without edit-guard\'s protection', description: 'SAFETY (confirm to change — see settings.js set/reset). Extra allowed file globs for edit-guard (comma/colon separated). [verified: hooks/edit-guard.js — no built-in default, empty means none]' },
      { key: 'allowSubagentMailbox', type: 'boolean', default: false, env: 'ANTIHALL_ALLOW_SUBAGENT_MAILBOX', pluginOption: 'guards_allow_subagent_mailbox', locked: true, advanced: true, safetyDirection: 'on', safetyNote: 'subagents can read/ack the Primary\'s mailbox, which is normally blocked', description: 'SAFETY (confirm to change — see settings.js set/reset). One-off allow for the subagent-mailbox command pattern. [verified: hooks/command-guard.js:1298 — default off, =1 allows]' },
      { key: 'allowReadOnlyVerify', type: 'boolean', default: true, env: 'ANTIHALL_ALLOW_READ_ONLY_VERIFY', pluginOption: 'guards_allow_read_only_verify', description: 'command-guard "narrow allow": lets the coordinator run a bounded, single-target read-only verification command inline (a --check/--dry-run/--list flag, a syntax-only compile check, one python3 -m pytest -q <file>, one or two explicit node --test files, ctest -R <name>, or a scratchpad-scoped git clone), only when piped to tail/head/grep -c/grep -m N/wc with no other segment left unaccounted for and no write redirect outside the scratchpad/tmp. [verified: hooks/command-guard.js isBoundedVerificationCommand — default on, =0/false disables]' },
      { key: 'projectCommandAllow', type: 'boolean', default: true, env: 'ANTIHALL_PROJECT_COMMAND_ALLOW', pluginOption: 'guards_project_command_allow', description: 'command-guard per-project allowlist: a repo may declare its own sanctioned exact commands (e.g. a deploy script that must never be delegated) in <repo-toplevel>/.anti-hall/command-allow.json, run inline in the MAIN THREAD ONLY. Default empty config means no behavior change. Kill-switch: false disables the carve-out entirely. [verified: hooks/command-guard.js matchedProjectCommandAllowPattern — default on]' },
      { key: 'allowPlainPush', type: 'boolean', default: true, env: 'ANTIHALL_ALLOW_PLAIN_PUSH', pluginOption: 'guards_allow_plain_push', description: 'command-guard "allow plain push": in the MAIN THREAD ONLY, lets `git add`/`git commit`/a plain `git push [remote] [ref]` (ref omitted, HEAD, or the current branch only), and &&/; chains made up only of those three, run inline instead of being delegated. --force/-f/--force-with-lease/--force-if-includes/--mirror/--delete/-d/--all/--tags/+refspec/src:dst-to-another-branch stay exactly as blocked as before; git-guard.js keeps its own independent force-push/AI-credit checks. [verified: hooks/command-guard.js isAllowedPlainPushChain — default on]' },
      { key: 'reaperMatch', type: 'string', default: '', env: 'ANTIHALL_REAPER_MATCH', advanced: true, description: 'Extra process-name pattern for the MCP session-end reaper. [verified: hooks/session-end-mcp-reaper.js — no built-in default, empty means none]' },
      { key: 'reaperExclude', type: 'string', default: '', env: 'ANTIHALL_REAPER_EXCLUDE', advanced: true, description: 'Excludes matching processes from the MCP reaper. [verified: hooks/session-end-mcp-reaper.js — no built-in default, empty means none]' },
      { key: 'reaperCodexBroker', type: 'boolean', default: true, env: 'ANTIHALL_REAPER_CODEX_BROKER', advanced: true, description: 'companion/mcp-reaper.js: REPORT (list in the reaper log, both dry-run and real runs) abandoned openai-codex plugin app-server-broker.mjs helper processes. REPORT-ONLY — this class is NEVER killed (a 2026-09-25 safety review found its detection could not be made reliable enough to act on automatically: unquoted --cwd paths with spaces, symlinked /tmp-vs-/private/tmp cwd mismatches, and the broker\'s own app-server child always looking like an "owner"). It is spawned detached+unref ON PURPOSE (PPID 1 is normal for a LIVE broker, not evidence of death), so a candidate is listed only when its --cwd directory no longer exists, or no live claude/codex process (excluding the broker\'s own descendants) has a realpath\'d cwd equal to/an ancestor of/a descendant of the realpath\'d --cwd, AND it is older than guards.reaperCodexBrokerMinAgeS. Matched by an exact script-name + codex-plugin-path signature, kept fully separate so this never loosens the MCP matcher (which alone can still trigger a real kill). Only takes effect when the opt-in companion reaper is installed and running. [verified: companion/mcp-reaper.js — default on, report-only]' },
      { key: 'reaperCodexBrokerMinAgeS', type: 'number', min: 0, default: 1800, env: 'ANTIHALL_REAPER_CODEX_BROKER_MIN_AGE_S', advanced: true, description: 'Minimum age in seconds an app-server-broker.mjs whose owner cannot be found must have before the report-only class above will list it (30 minutes by default — deliberately conservative since PPID gives no death signal for this class); an unresolvable age is always skipped, never listed. [verified: companion/mcp-reaper.js — default 1800s]' },
      { key: 'tasklistWorkThreshold', type: 'number', min: 1, default: 3, env: 'ANTIHALL_TASKLIST_WORK_THRESHOLD', advanced: true, description: 'Minimum work items before tasklist-guard fires. [verified: hooks/tasklist-guard.js:45 DEFAULT_WORK_THRESHOLD = 3]' },
      { key: 'progressFreshMs', type: 'number', min: 0, default: 1800000, env: 'ANTIHALL_PROGRESS_FRESH_MS', advanced: true, description: 'Freshness window (ms) for the progress file in tasklist-guard. [verified: hooks/tasklist-guard.js:46 DEFAULT_PROGRESS_FRESH_MS = 30*60*1000]' },
      { key: 'apiGuardThirdparty', type: 'boolean', default: false, env: 'ANTIHALL_API_GUARD_THIRDPARTY', advanced: true, description: 'Also verify installed 3rd-party package APIs, not just stdlib/builtins. [verified: hooks/api-guard.js:84 — default off, =1/true/yes/on enables]' },
      // ---- 0.108.4: on/off switches for every remaining guard (default = current behaviour) ----
      { key: 'modelRouting', type: 'enum', values: ['strict', 'advisory', 'off'], default: 'strict', env: 'ANTIHALL_MODEL_ROUTING', pluginOption: 'guards_model_routing', description: 'model-routing-guard (PreToolUse Agent/Task): strict blocks a mis-tiered spawn, advisory only warns, off disables the hook.' },
      { key: 'apiGuard', type: 'boolean', default: true, pluginOption: 'guards_api_guard', description: 'api-guard (PreToolUse Write/Edit): block fabricated stdlib/builtin APIs in written code.' },
      { key: 'speculationGuard', type: 'boolean', default: true, pluginOption: 'guards_speculation_guard', description: 'speculation-guard (Stop): block a turn that ends on unverified hedged claims.' },
      { key: 'claimLedger', type: 'boolean', default: true, pluginOption: 'guards_claim_ledger', description: 'claim-ledger (Stop, never blocks): record claims in the last reply that nothing in the session backs.' },
      { key: 'taskGuard', type: 'boolean', default: true, pluginOption: 'guards_task_guard', description: 'task-guard (Stop): block stopping while tracked tasks are still open.' },
      { key: 'tasklistGuard', type: 'boolean', default: true, pluginOption: 'guards_tasklist_guard', description: 'tasklist-guard (Stop): require a task list / progress file for multi-step work.' },
      { key: 'scanThrottle', type: 'boolean', default: true, env: 'ANTI_HALL_SCAN_THROTTLE', pluginOption: 'guards_scan_throttle', description: 'scan-throttle (PreToolUse Bash): run heavy repo-wide scans at background priority (nice/taskpolicy).' },
      { key: 'silentAgentNudge', type: 'boolean', default: true, env: 'ANTIHALL_SILENT_AGENT_NUDGE', pluginOption: 'guards_silent_agent_nudge', description: 'silent-agent-nudge (Stop): nudge once, advisory-only, when a background Agent launch in the transcript has no terminal notification and a stale/missing output_file (plus the ~/.anti-hall/agents/<id>.json heartbeat as an extra signal), past silentAgentNudgeMin. Never kills anything. [verified: hooks/silent-agent-nudge.js — default on, =off disables]' },
      { key: 'silentAgentNudgeMin', type: 'number', min: 1, default: 20, env: 'ANTIHALL_SILENT_AGENT_NUDGE_MIN', pluginOption: 'guards_silent_agent_nudge_min', advanced: true, description: 'Minutes of silence (no terminal task-notification + stale/missing output_file, or a stale heartbeat) before silent-agent-nudge fires. [verified: hooks/silent-agent-nudge.js DEFAULT_MIN = 20, mirrors agent-watchdog.js]' },
      { key: 'stopHookVersionDowngrade', type: 'boolean', default: true, env: 'ANTIHALL_STOP_HOOK_VERSION_DOWNGRADE', advanced: true, description: 'When installed_plugins.json (harness-owned) has re-registered a newer anti-hall version than this running session, downgrade nudge-class Stop-hook blocks (silent-agent-nudge, tasklist-guard, devswarm-parent-gate NEGLECT) to advisory (skip the block) until restart — a stale already-fixed nudge should not keep blocking. Never applied to safety guards. [verified: hooks/lib/stop-version-gate.js]' },
      { key: 'stopAck', type: 'boolean', default: true, env: 'ANTIHALL_STOP_ACK', advanced: true, description: 'Nudge-class Stop hooks (silent-agent-nudge, tasklist-guard) honor a per-signature session ack the agent writes to ~/.anti-hall/stop-ack/<session>.json once the user has explicitly confirmed a condition is a false positive — the same signature then stays advisory (never blocks again) for the rest of the session. Off disables the mechanism entirely (hooks block exactly as before it existed). Never applies to safety guards. [verified: hooks/lib/stop-ack.js]' },
    ],
  },
  {
    key: 'safety',
    label: 'Safety Guards',
    description: 'Switches for the safety-critical guards (force-push / AI self-credit / heavy-command and edit delegation / runaway spawns). Normal precedence applies (env > ~/.anti-hall/settings.json > /config > default): a value in settings.json counts like any other. `settings.js set` to the risky value, and a `reset` whose fallback value is risky, need `--confirmed` (a human direct command, or the user saying yes after a one-line factual warning); re-arming a guard never does. Off = the guard\'s core check no-ops; the per-guard skip.json escape hatch is unchanged.',
    settings: [
      { key: 'gitGuard', type: 'boolean', default: true, env: 'ANTIHALL_GIT_GUARD', pluginOption: 'safety_git_guard', locked: true, safetyDirection: 'off', safetyNote: 'force-pushes and AI credit lines in commits will no longer be stopped', description: 'git-guard: block force-push and AI self-credit in commits and gh pr/issue/release bodies.' },
      { key: 'commandGuard', type: 'boolean', default: true, env: 'ANTIHALL_COMMAND_GUARD', pluginOption: 'safety_command_guard', locked: true, safetyDirection: 'off', safetyNote: 'heavy commands (builds, tests, deploys, pushes) will run directly in the main session instead of being handed to a helper', description: 'command-guard core: make the coordinator delegate heavy commands (build/test/deploy/push). Its data-safety sub-guards (DevSwarm read/send/mailbox, armed stash guard) stay on.' },
      { key: 'editGuard', type: 'boolean', default: true, env: 'ANTIHALL_EDIT_GUARD', pluginOption: 'safety_edit_guard', locked: true, safetyDirection: 'off', safetyNote: 'edits to protected files like plugin config and secrets will no longer be stopped', description: 'edit-guard core: make the coordinator delegate file edits outside its own plan/state/handover files.' },
      { key: 'swarmGuard', type: 'boolean', default: true, env: 'ANTIHALL_SWARM_GUARD', pluginOption: 'safety_swarm_guard', locked: true, safetyDirection: 'off', safetyNote: 'nothing will stop runaway agent spawning that can overload the machine', description: 'swarm-guard: block agent spawns past the spawn-rate cap or under critical memory pressure.' },
    ],
  },
  {
    key: 'context',
    label: 'Context Injections',
    description: 'The verify-first protocol and the other text anti-hall injects at session start, per turn, and into subagents.',
    settings: [
      { key: 'verifyFirstSession', type: 'boolean', default: true, pluginOption: 'context_verify_first_session', description: 'verify-first-full (SessionStart): inject the full verify-first protocol (also re-injected after compaction).' },
      { key: 'verifyFirstOrchestration', type: 'boolean', default: true, pluginOption: 'context_verify_first_orchestration', description: 'verify-first-orch (SessionStart): inject the orchestration discipline for the main thread.' },
      { key: 'verifyFirstTurn', type: 'boolean', default: true, pluginOption: 'context_verify_first_turn', description: 'verify-first (UserPromptSubmit): the short per-turn verify-first nudge.' },
      { key: 'verifyFirstSubagent', type: 'boolean', default: true, pluginOption: 'context_verify_first_subagent', description: 'verify-first-subagent (SubagentStart): inject the protocol into every subagent.' },
      { key: 'taskTracker', type: 'boolean', default: true, pluginOption: 'context_task_tracker', description: 'task-tracker (UserPromptSubmit): the task-list discipline directive and per-turn reminder.' },
      { key: 'handoverResume', type: 'boolean', default: true, pluginOption: 'context_handover_resume', description: 'handover-resume (SessionStart): point a fresh or compacted session at the newest handover.' },
      { key: 'defectNudge', type: 'boolean', default: true, pluginOption: 'context_defect_nudge', description: 'defect-nudge (SessionStart): the once-a-day note about the defect channel.' },
    ],
  },
  {
    key: 'maintenance',
    label: 'Maintenance',
    description: 'Background housekeeping hooks: self-repair, pruning, snapshots, logs, and the session-end MCP sweep.',
    settings: [
      { key: 'repairOnReload', type: 'boolean', default: true, env: 'ANTIHALL_REPAIR_ON_RELOAD', pluginOption: 'maintenance_repair_on_reload', description: 'repair-on-reload (SessionStart/UserPromptSubmit): re-apply safe doctor repairs after a plugin update.' },
      { key: 'progressPrune', type: 'boolean', default: true, pluginOption: 'maintenance_progress_prune', description: 'progress-prune (SessionStart): archive stale per-session progress files into the history ledger.' },
      { key: 'precompactSnapshot', type: 'boolean', default: true, pluginOption: 'maintenance_precompact_snapshot', description: 'precompact-snapshot (PreCompact): write a mechanical continuation snapshot before compaction.' },
      { key: 'taskLifecycleLog', type: 'boolean', default: true, pluginOption: 'maintenance_task_lifecycle_log', description: 'task-lifecycle-log (TaskCreated/TaskCompleted): append task events to the per-session history ledger.' },
      { key: 'sessionEndReaper', type: 'boolean', default: true, env: 'ANTI_HALL_SESSION_END_REAPER', pluginOption: 'maintenance_session_end_reaper', description: 'session-end-mcp-reaper (SessionEnd): kill orphaned MCP-server processes this session left behind.' },
    ],
  },
  {
    key: 'versionAlerts',
    label: 'Version Alerts',
    description: 'Update-available nudges for anti-hall, Claude CLI, and DevSwarm.',
    settings: [
      { key: 'antiHall', type: 'boolean', pluginOption: 'version_alerts_anti_hall', default: true, env: 'ANTIHALL_VERSION_ALERT', description: 'Alert when a newer anti-hall version is available. [verified: hooks/version-alert.js:93 — default on, =off disables]' },
      { key: 'claudeCli', type: 'boolean', pluginOption: 'version_alerts_claude_cli', default: true, env: 'ANTIHALL_CLAUDE_CLI_VERSION_ALERT', description: 'Alert when a newer Claude CLI version is available. [verified: hooks/claude-cli-version.js:54 — default on, =off disables]' },
      { key: 'devswarm', type: 'boolean', pluginOption: 'version_alerts_devswarm', default: true, env: 'ANTIHALL_DEVSWARM_VERSION_ALERT', description: 'Alert when a newer DevSwarm/hivecontrol version is available. [verified: hooks/devswarm-version.js:157 — default on, =off disables]' },
    ],
  },
  {
    key: 'updates',
    label: 'Updates / Maintenance',
    description: '`/anti-hall:update` and its background sweep.',
    settings: [
      { key: 'quiet', type: 'boolean', pluginOption: 'updates_quiet', default: false, env: 'ANTIHALL_UPDATE_QUIET', description: 'Suppress update output (for scripted capture). [verified: skills/update/scripts/update.js:2687 — default off, =1 suppresses]' },
      { key: 'reconcileBudgetMs', type: 'number', min: 0, default: 60000, env: 'ANTIHALL_RECONCILE_BUDGET_MS', advanced: true, description: 'Time budget (ms) for the reconcile step during update; 0 = unlimited. [verified: scripts/devswarm.js DEFAULT_RECONCILE_BUDGET_MS = 60000]' },
      { key: 'postpullBudgetMs', type: 'number', min: 0, default: 90000, env: 'ANTIHALL_UPDATE_POSTPULL_BUDGET_MS', advanced: true, description: 'Time budget (ms) for the post-pull update sweep; 0 = unlimited. [verified: skills/update/scripts/update.js DEFAULT_POSTPULL_BUDGET_MS = 90000]' },
      { key: 'sweepBudgetMs', type: 'number', min: 0, default: 20000, env: 'ANTIHALL_UPDATE_SWEEP_BUDGET_MS', advanced: true, description: 'Overall time budget (ms) for the update sweep. [verified: skills/update/scripts/update.js DEFAULT_SWEEP_BUDGET_MS = 20000]' },
    ],
  },
  {
    key: 'limitConserve',
    label: 'Limit Conservation',
    description: 'Auto-downshift behavior as usage approaches plan limits.',
    settings: [
      { key: 'mode', type: 'enum', values: ['auto', 'on', 'off'], default: 'auto', env: 'ANTIHALL_LIMIT_CONSERVE', pluginOption: 'limit_conserve_mode', description: 'Force conservation mode on/off, or auto-detect from the OMC usage cache.' },
      { key: 'threshold', type: 'number', min: 1, max: 99, default: 85, env: 'ANTIHALL_LIMIT_THRESHOLD', pluginOption: 'limit_conserve_threshold', description: 'Usage percent that triggers conservation mode. [verified: hooks/limit-conserve.js:59 THRESHOLD = parseInt(...) || 85]' },
      { key: 'accountCheck', type: 'boolean', default: true, env: 'ANTIHALL_LIMIT_ACCOUNT_CHECK', advanced: true, description: 'Guard against stale usage-cache readings after an account switch. [verified: hooks/limit-conserve.js:111 — only the literal "off" disables it]' },
    ],
  },
  {
    key: 'jev',
    label: 'Jev (semantic decision engine)',
    description: 'Opt-in Jev "System One" classifier for triage/decisions.',
    settings: [
      { key: 'enabled', type: 'boolean', default: false, env: 'ANTIHALL_JEV', legacy: { file: 'jev.json', key: 'enabled' }, pluginOption: 'jev_enabled', description: 'Enable Jev (ANTIHALL_JEV=0 always force-disables regardless of this).' },
      { key: 'transport', type: 'enum', values: ['vercel', 'typesafe'], default: 'vercel', legacy: { file: 'jev.json', key: 'transport' }, pluginOption: 'jev_transport', description: 'Vercel AI Gateway passthrough (default) or a direct TypeSafe API call.' },
      { key: 'judgeModel', type: 'string', pluginOption: 'jev_judge_model', default: 'claude-haiku-4-5', env: 'ANTIHALL_JUDGE_MODEL', description: 'Model used for speculation-judge / jev-triage LLM calls.' },
      { key: 'semanticJudge', type: 'boolean', default: false, env: 'ANTIHALL_SEMANTIC_JUDGE', pluginOption: 'jev_semantic_judge', description: 'Enable the semantic speculation-judge hook (off = hook no-ops).' },
      { key: 'keyFile', type: 'string', default: '', legacy: { file: 'jev.json', key: 'keyFile' }, advanced: true, description: 'Credential key-file path (default depends on transport).' },
      { key: 'timeoutMs', type: 'number', min: 1, max: 3000, default: 1500, legacy: { file: 'jev.json', key: 'timeoutMs' }, advanced: true, description: 'Per-call timeout (ms), capped at 3000.' },
      { key: 'confidenceThreshold', type: 'number', min: 0, max: 1, default: 0.85, legacy: { file: 'jev.json', key: 'confidenceThreshold' }, advanced: true, description: 'Minimum confidence for a Jev answer to be trusted by callers.' },
      { key: 'triage', type: 'boolean', default: true, legacy: { file: 'jev.json', key: 'triage' }, advanced: true, description: 'Message-triage labeling once Jev is enabled.' },
      { key: 'triageUrgentThreshold', type: 'number', min: 0, max: 1, default: 0.9, legacy: { file: 'jev.json', key: 'triageUrgentThreshold' }, advanced: true, description: 'Confidence threshold for the urgent triage label. [verified: hooks/lib/jev-triage.js:51 DEFAULT_URGENT_THRESHOLD = 0.9]' },
      // jev-assist budget (0.108.0) — spend tracking, added alongside this schema;
      // behavior implemented separately in hooks/lib/jev-assist*.js. `watch` only
      // ever warns; it never auto-disables Jev (see budget.mode's description).
      { key: 'budget.mode', type: 'enum', values: ['unlimited', 'watch'], default: 'unlimited', legacy: { file: 'jev.json', key: 'budget.mode' }, pluginOption: 'jev_budget_mode', description: 'Jev spend: no limit, or warn when over budget (never auto-disables). [read by: hooks/lib/jev-assist.js readBudgetConfig, scripts/jev-report.js]' },
      { key: 'budget.usdPerDay', type: 'number', exclusiveMin: 0, default: null, optional: true, legacy: { file: 'jev.json', key: 'budget.usdPerDay' }, pluginOption: 'jev_budget_usd_per_day', description: 'optional: daily USD spend threshold, used only when budget.mode=watch. [read by: hooks/lib/jev-assist.js readBudgetConfig, scripts/jev-report.js]' },
      { key: 'budget.usdPerWeek', type: 'number', exclusiveMin: 0, default: null, optional: true, legacy: { file: 'jev.json', key: 'budget.usdPerWeek' }, pluginOption: 'jev_budget_usd_per_week', description: 'optional: weekly USD spend threshold, used only when budget.mode=watch. [read by: hooks/lib/jev-assist.js readBudgetConfig, scripts/jev-report.js]' },
      { key: 'weeklyNotice', type: 'boolean', pluginOption: 'jev_weekly_notice', default: true, legacy: { file: 'jev.json', key: 'weeklyNotice' }, description: 'Once-a-week SessionStart scorecard notice naming one integration worth promoting or turning off (Jev enabled only). [read by: hooks/jev-weekly-scorecard.js]' },
      // Audit / pricing / low-credit (0.108.0). Legacy home: the same keys in
      // ~/.anti-hall/jev.json (nested, e.g. {"audit": {"snippets": true}}).
      { key: 'audit.snippets', type: 'boolean', default: false, env: 'ANTIHALL_JEV_AUDIT_SNIPPETS', legacy: { file: 'jev.json', key: 'audit.snippets' }, advanced: true, description: 'Store a redacted ~200-char snippet for decisions Jev changed or would change in shadow mode (off by default: privacy). [read by: hooks/lib/jev-assist.js readAuditConfig]' },
      { key: 'budget.minCreditUsd', type: 'number', pluginOption: 'jev_budget_min_credit_usd', exclusiveMin: 0, default: null, optional: true, legacy: { file: 'jev.json', key: 'budget.minCreditUsd' }, description: 'optional: warn (once a day, budget.mode=watch only) when the gateway credit balance drops below this USD amount. [read by: scripts/jev-report.js readBudgetConfig]' },
      { key: 'prices', type: 'object', default: null, computed: true, legacy: { file: 'jev.json', key: 'prices' }, advanced: true, description: 'computed: per-model USD price table {model: {inPerMTok, outPerMTok}} (or a "default" entry), used only when the gateway reports tokens but no cost. File-only (no env, no CLI set) — edit ~/.anti-hall/settings.json directly. [read by: hooks/lib/jev-assist.js readPrices]' },
      { key: 'priceUsdPerMInput', type: 'number', min: 0, default: 0.042, env: 'ANTIHALL_JEV_PRICE_USD_PER_M_INPUT', advanced: true, description: "USD per 1M input tokens for the Jev judge call, used to compute costUsd when the gateway reports tokens but no cost and `prices` has no matching entry. Default is Jev's own published rate (verified: typesafe.ai, vercel.com/ai-gateway/models/jev, openrouter.ai/typesafe). [read by: hooks/lib/jev-assist.js computeCostUsd]" },
      { key: 'priceUsdPerMOutput', type: 'number', min: 0, default: 0, env: 'ANTIHALL_JEV_PRICE_USD_PER_M_OUTPUT', advanced: true, description: 'USD per 1M output tokens for the Jev judge call (default 0 — output is free on the verified rate). [read by: hooks/lib/jev-assist.js computeCostUsd]' },
    ],
  },
  {
    key: 'jevIntegrations',
    label: 'Jev integration',
    description: 'Per-integration trust mode for every Jev-assisted decision point (v0.108.4 — each of the 13 integrations gets its own row/setting; postHandoverGate added in 0.109.0; legacy home: jev.json "integrations.<id>" and, pre-0.108.4, settings.json jev["integrations.<id>"]). on = Jev may change the outcome (bounded by its own trust rule below), shadow = consulted + logged only, off = not consulted.',
    settings: [
      { key: 'speculation', type: 'enum', values: ['on', 'shadow', 'off'], default: 'on', legacy: { file: 'jev.json', key: 'integrations.speculation' }, pluginOption: 'jev_integration_speculation', description: 'Is this claim unsupported speculation (add-block trust: Jev may only turn a non-block baseline into a block). [read by: hooks/lib/jev-assist.js getMode, hooks/speculation-guard.js]' },
      { key: 'triage', type: 'enum', values: ['on', 'shadow', 'off'], default: 'on', legacy: { file: 'jev.json', key: 'integrations.triage' }, pluginOption: 'jev_integration_triage', description: 'Mesh message urgency/kind labeling (advisory: its own triage client, not the add-block/relax-block trust model). [read by: hooks/lib/jev-assist.js getMode, hooks/lib/jev-triage.js]' },
      { key: 'newRequest', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.newRequest' }, pluginOption: 'jev_integration_new_request', description: 'Classify a prompt as new-request/follow-up/correction/question (advisory trust). [read by: hooks/lib/jev-assist.js getMode, hooks/task-tracker.js]' },
      { key: 'claimLedger', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.claimLedger' }, pluginOption: 'jev_integration_claim_ledger', description: 'Is a flagged claim genuinely unsupported by evidence (relax-block trust: Jev may only turn a blocking baseline into a non-block). [read by: hooks/lib/jev-assist.js getMode, hooks/claim-ledger.js]' },
      { key: 'outputVerifyGuard', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.outputVerifyGuard' }, pluginOption: 'jev_integration_output_verify_guard', description: 'Does this test-runner output actually indicate a pass (advisory trust). [read by: hooks/lib/jev-assist.js getMode, hooks/output-verify-guard.js]' },
      { key: 'gitGuardSelfCredit', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.gitGuardSelfCredit' }, pluginOption: 'jev_integration_git_guard_self_credit', description: 'Does this commit/PR message contain paraphrased AI self-credit (add-block trust; never relaxes git-guard). [read by: hooks/lib/jev-assist.js getMode, hooks/git-guard.js]' },
      { key: 'modelRouting', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.modelRouting' }, pluginOption: 'jev_integration_model_routing', description: 'Is this agent-spawn task actually mechanical (relax-block trust). [read by: hooks/lib/jev-assist.js getMode, hooks/model-routing-guard.js]' },
      { key: 'tasklistTrivial', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.tasklistTrivial' }, pluginOption: 'jev_integration_tasklist_trivial', description: 'tasklist-guard: is this session a genuinely non-trivial, multi-part effort (relax-block trust; asked synchronously, 1.5 s cap, fail-open). [read by: hooks/lib/jev-assist.js getMode, hooks/tasklist-guard.js]' },
      { key: 'codexNudgeSubstantial', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.codexNudgeSubstantial' }, pluginOption: 'jev_integration_codex_nudge_substantial', description: 'codex-nudge: are these file edits genuinely substantial, not just formatting (relax-block trust; asked synchronously, 1.5 s cap, fail-open). [read by: hooks/lib/jev-assist.js getMode, hooks/codex-nudge.js]' },
      { key: 'mergeGateHedge', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.mergeGateHedge' }, pluginOption: 'jev_integration_merge_gate_hedge', description: 'Does this text hedge on merge-readiness (relax-block trust; askDetached fire-and-forget in shadow). [read by: hooks/lib/jev-assist.js getMode, hooks/merge-gate.js]' },
      { key: 'parentGateQuestion', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.parentGateQuestion' }, pluginOption: 'jev_integration_parent_gate_question', description: 'Is this unread child message really a question awaiting a reply (add-block trust; cache-only, zero network). [read by: hooks/lib/jev-assist.js getMode, hooks/devswarm-parent-gate.js]' },
      { key: 'supervisorBlockerLabel', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.supervisorBlockerLabel' }, pluginOption: 'jev_integration_supervisor_blocker_label', description: 'Is a stale child waiting-on-parent or genuinely wedged (advisory trust; cache-only, zero network). [read by: hooks/lib/jev-assist.js getMode]' },
      { key: 'findingDedup', type: 'enum', values: ['on', 'shadow', 'off'], default: 'on', legacy: { file: 'jev.json', key: 'integrations.findingDedup' }, pluginOption: 'jev_integration_finding_dedup', description: 'Do two deadly-loop TRIO findings describe the same underlying issue, for advisory duplicate-grouping (advisory trust); default on — 65/65 correct at confidence >=0.85 on a 30-day, 3-project offline benchmark (see CHANGELOG 0.108.4). [read by: hooks/lib/jev-assist.js getMode, scripts/finding-dedup.js]' },
      { key: 'postHandoverGate', type: 'enum', values: ['on', 'shadow', 'off'], default: 'off', pluginOption: 'jev_integration_post_handover_gate', description: 'Does this new request fit in the remaining post-handover context budget (advisory trust; askDetached fire-and-forget, zero latency). Default off: an offline benchmark (n=299) found park-recall 17.6% vs 28.8% for the agent\'s own size judgment plus the measured budget backstop, no gain over the baseline. [read by: hooks/lib/jev-assist.js getMode, hooks/auto-handover.js]' },
    ],
  },
  {
    key: 'devswarm',
    label: 'DevSwarm',
    description: 'Multi-workspace mesh orchestration, liveness, and supervisor tuning. Every consumer takes an explicit env parameter (for testability); settings.js routes these through getWithEnv() so a home derived from that SAME env is used, never os.homedir().',
    settings: [
      { key: 'hivecontrol', type: 'string', default: '', env: 'ANTIHALL_DEVSWARM_HIVECONTROL', pluginOption: 'devswarm_hivecontrol', description: 'Explicit path to the hivecontrol CLI binary (default: PATH lookup — no single default value; empty means "look it up").' },
      { key: 'supervisorMode', type: 'enum', values: ['auto', 'on', 'off'], default: 'auto', env: 'ANTIHALL_DEVSWARM_SUPERVISOR', pluginOption: 'devswarm_supervisor_mode', description: 'Force the DevSwarm supervisor context on/off, or auto-detect. [verified: hooks/lib/devswarm-detect.js:33 — mode falsy/unset -> auto]' },
      { key: 'requiredGates', type: 'csv', pluginOption: 'devswarm_required_gates', default: 'done,merged,tests_passed', env: 'ANTIHALL_DEVSWARM_REQUIRED_GATES', description: 'Merge gates required for DevSwarm tasks. [verified: companion/lib/devswarm-store.js:214 requiredGatesFrom — literal default array]' },
      { key: 'inboxCmd', type: 'string', pluginOption: 'devswarm_inbox_cmd', default: '', env: 'ANTIHALL_DEVSWARM_INBOX_CMD', description: 'Consumer-configured command to read pending mesh messages (no built-in default). [verified: hooks/command-guard.js:765 buildDevswarmReason — hasInboxCmd only true when explicitly set]' },
      { key: 'heldPartitions', type: 'csv', default: '', env: 'ANTIHALL_DEVSWARM_HELD_PARTITIONS', advanced: true, description: 'Owner-held mesh partition ids (comma-separated). A held partition is exempt from the per-turn "ORPHANED MESH" warning and from `reap-orphans`; it still appears in `diagnose`/`doctor` as held by owner. [verified: companion/lib/devswarm-store.js heldPartitionIdsFrom]' },
      { key: 'childGateStrict', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_CHILD_GATE_STRICT', advanced: true, description: 'Strict child-gate enforcement. [verified: hooks/devswarm-child-gate.js:530-536 strictEnabled — raw undefined -> "1" -> true; "0" disables]' },
      { key: 'parentGateCap', type: 'number', min: 2, max: 5, default: 3, env: 'ANTIHALL_DEVSWARM_PARENT_GATE_CAP', advanced: true, description: 'Caps the parent-gate wait/child count, clamped to [2,5]. [verified: hooks/devswarm-parent-gate.js:185 DEFAULT_CAP = 3]' },
      { key: 'parentGateNeglectMinUnread', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_PARENT_GATE_NEGLECT_MIN_UNREAD', advanced: true, description: 'Minimum real-unread count a genuinely NOT-busy child needs before the parent Stop gate hard-blocks on it; 0 = any real unread blocks (pre-existing sensitivity, unchanged default). A BUSY child (fresh real-work transcript, see parentGateBusyFreshMin) gets an advisory line instead, until its oldest unread passes parentGateBusyMaxAgeMin. A child waiting on its own question/plan approval always blocks. [verified: hooks/devswarm-parent-gate.js DEFAULT_NEGLECT_MIN_UNREAD = 0]' },
      { key: 'parentGateBusyFreshMin', type: 'number', min: 1, default: 5, env: 'ANTIHALL_DEVSWARM_PARENT_GATE_BUSY_FRESH_MIN', pluginOption: 'devswarm_parent_gate_busy_fresh_min', advanced: true, description: 'Minutes a child\'s transcript may be quiet and still count as busy for the parent Stop gate. Busy needs positive evidence: a transcript written within this window whose latest turn is real work (not a mailbox ping, not waiting). A live pid or a fresh heartbeat alone never counts. An unresolved tool call on a transcript quiet longer than this is treated as waiting (permission prompt or hung tool). [verified: hooks/devswarm-parent-gate.js DEFAULT_BUSY_FRESH_MIN = 5]' },
      { key: 'parentGateBusyMaxAgeMin', type: 'number', min: 1, default: 60, env: 'ANTIHALL_DEVSWARM_PARENT_GATE_BUSY_MAX_AGE_MIN', pluginOption: 'devswarm_parent_gate_busy_max_age_min', advanced: true, description: 'Age cap (minutes) on the busy advisory: once a busy child\'s oldest unread message is older than this, the parent Stop gate blocks anyway ("busy but hasn\'t read mail in Xm"). An unknown message age never qualifies for the advisory. [verified: hooks/devswarm-parent-gate.js DEFAULT_BUSY_MAX_AGE_MIN = 60]' },
      { key: 'parentGateNeglectGraceMin', type: 'number', min: 1, default: 1, env: 'ANTIHALL_DEVSWARM_PARENT_GATE_NEGLECT_GRACE_MIN', pluginOption: 'devswarm_parent_gate_neglect_grace_min', advanced: true, description: 'Grace window (minutes) for a plain unread backlog on the parent Stop gate: an unread message younger than this never counts as neglect by itself, independent of whether the child is separately provably busy — a Primary that just sent a child a message should not be hard-blocked seconds later, before the child has had a turn to read it. Never applies to a store-only (mesh-direct send, or dead/foreign-descriptor) row, and never suppresses an unanswered child question, an escalation, or unread older than this window. Default kept at 1 (not higher) so it never overlaps the 2-minute-old backlog this file\'s own busy/idle regressions use as their baseline "still neglect" fixture. [verified: hooks/devswarm-parent-gate.js DEFAULT_NEGLECT_GRACE_MIN = 1]' },
      { key: 'activeFloorPct', type: 'number', min: 0, max: 100, default: 50, env: 'ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT', advanced: true, description: 'Min percent of active workspaces kept in the archived cache (0 disables the floor). [verified: companion/lib/devswarm-archived-cache.js:226 DEFAULT_ACTIVE_FLOOR_PCT = 50]' },
      { key: 'archivedCacheMaxAgeMs', type: 'number', min: 0, default: null, computed: true, env: 'ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS', advanced: true, description: 'computed: no fixed default — 2x the reconcile sweep’s own resolved cooldown (itself env/default-derived), not a literal constant. [verified: companion/lib/devswarm-archived-cache.js:189-221 sweepIntervalMs/resolveArchivedCacheMaxAgeMs]' },
      { key: 'archivedGraceMs', type: 'number', min: 0, default: 600000, env: 'ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS', advanced: true, description: 'Grace period (ms) before a workspace is considered archived. [verified: companion/lib/devswarm-archived-cache.js:122 DEFAULT_ARCHIVED_GRACE_MS = 10*60*1000]' },
      { key: 'cooldownSec', type: 'number', min: 0, default: 600, env: 'ANTIHALL_DEVSWARM_COOLDOWN_SEC', advanced: true, description: 'Supervisor cooldown (sec) between recovery actions. [verified: companion/lib/liveness.js:43 DEFAULT_COOLDOWN_MS = 10*60*1000 -> 600s, imported by companion/devswarm-supervisor.js:39]' },
      { key: 'idleSec', type: 'number', min: 60, default: 900, env: 'ANTIHALL_DEVSWARM_IDLE_SEC', advanced: true, description: 'Supervisor idle threshold (sec). [verified: companion/lib/liveness.js:42 DEFAULT_IDLE_MS = 15*60*1000 -> 900s, imported by companion/devswarm-supervisor.js:39]' },
      { key: 'dormantMs', type: 'number', exclusiveMin: 0, default: 1800000, env: 'ANTIHALL_DEVSWARM_DORMANT_MS', advanced: true, description: 'Dormant-workspace threshold (ms). [verified: companion/lib/liveness.js:76 DEFAULT_DORMANT_MS = 30*60*1000]' },
      { key: 'drainTtlMs', type: 'number', min: 0, default: 600000, env: 'ANTIHALL_DEVSWARM_DRAIN_TTL_MS', advanced: true, description: 'TTL (ms) for the drain marker. [verified: companion/lib/devswarm-drain-marker.js:60 DEFAULT_TTL_MS = 10*60*1000]' },
      { key: 'graceSec', type: 'number', min: 1, max: 60, default: 5, env: 'ANTIHALL_DEVSWARM_GRACE_SEC', advanced: true, description: 'Grace window (sec) before recovery in devswarm-recover. [verified: companion/lib/recovery.js:62 DEFAULT_GRACE_MS = 5000 -> 5s]' },
      { key: 'maxRecoveries', type: 'number', min: 1, max: 20, default: 3, env: 'ANTIHALL_DEVSWARM_MAX_RECOVERIES', advanced: true, description: 'Max auto-recovery attempts. [verified: companion/lib/recovery.js:61 DEFAULT_MAX_RECOVERIES = 3]' },
      { key: 'intervalSec', type: 'number', min: 60, max: 120, default: 90, env: 'ANTIHALL_DEVSWARM_INTERVAL', advanced: true, description: 'Sweep interval (sec) used at supervisor install time, clamped [60,120]. [verified: companion/install-devswarm-supervisor.js:61 clampInterval default 90 for missing/garbage input]' },
      { key: 'migrateMarkRead', type: 'boolean', default: false, env: 'ANTIHALL_DEVSWARM_MIGRATE_MARK_READ', advanced: true, description: 'Mark migrated messages as read during state migration. [verified: companion/devswarm-migrate.js:96-98 resolveMarkRead — falls back to false when unset]' },
      { key: 'monitorTimeoutSec', type: 'number', min: 0, default: 30, env: 'ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC', advanced: true, description: 'Bounded cadence (sec) for monitor timeout in devswarm-ingest. [verified: companion/devswarm-ingest.js:91 DEFAULT_MONITOR_TIMEOUT_SEC = 30]' },
      { key: 'monitorNoOkFailMin', type: 'number', exclusiveMin: 0, default: 10, env: 'ANTIHALL_DEVSWARM_MONITOR_NO_OK_FAIL_MIN', advanced: true, description: 'Minutes without a successful monitor poll (since daemon start, or since the last success) before ingest health reads FAILING; inside the window a fresh daemon reads "starting up". [verified: hooks/lib/doctor-repair.js MONITOR_NO_OK_FAIL_MIN_DEFAULT = 10]' },
      { key: 'nudgeCooldownSec', type: 'number', min: 0, default: 120, env: 'ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC', advanced: true, description: 'Cooldown (sec) between supervisor nudges. [verified: companion/devswarm-supervisor.js:29 header + DEFAULT_NUDGE_COOLDOWN_MS/1000 = 120]' },
      { key: 'nudgeMaxAttempts', type: 'number', min: 1, max: 20, default: 2, env: 'ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS', advanced: true, description: 'Max nudge attempts before escalation. [verified: companion/lib/recovery.js DEFAULT_NUDGE_MAX_ATTEMPTS = 2, via companion/devswarm-supervisor.js:27 header + :100]' },
      { key: 'nudgeWindowSec', type: 'number', min: 1, default: 180, env: 'ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC', advanced: true, description: 'Window (sec) for counting nudge attempts. [verified: companion/lib/liveness.js:44 DEFAULT_NUDGE_WINDOW_MS = 3*60*1000 -> 180s, imported by companion/devswarm-supervisor.js:39]' },
      { key: 'postSpawnGraceSec', type: 'number', min: 0, max: 1800, default: 120, env: 'ANTIHALL_DEVSWARM_POST_SPAWN_GRACE_SEC', advanced: true, description: 'Grace period (sec) right after spawning a child workspace, clamped [0,1800]. [verified: companion/devswarm-supervisor.js:139 DEFAULT_POST_SPAWN_GRACE_MS = 2*60*1000 -> 120s]' },
      { key: 'reapedRetentionDays', type: 'number', exclusiveMin: 0, default: 30, env: 'ANTIHALL_DEVSWARM_REAPED_RETENTION_DAYS', advanced: true, description: 'Retention window (days) for reaped-workspace logs. [verified: hooks/lib/doctor-repair.js:2651 REAPED_RETENTION_DAYS_DEFAULT = 30]' },
      { key: 'receiptWindowMs', type: 'number', min: 0, default: 300000, env: 'ANTIHALL_DEVSWARM_RECEIPT_WINDOW_MS', advanced: true, description: 'Window (ms) for parent-reply receipt tracking. [verified: hooks/devswarm-parent-reply-tracker.js:167 RECEIPT_WINDOW_MS_DEFAULT = 5*60*1000]' },
      { key: 'archiveRequestRenagHours', type: 'number', min: 1, default: 24, env: 'ANTIHALL_DEVSWARM_ARCHIVE_REQUEST_RENAG_HOURS', advanced: true, description: 'Hours a pending archive-request suppresses the ARCHIVE-READY re-nudge and the CHILD NOT DRAINING nag for that child before re-nagging anyway. [verified: hooks/devswarm-parent-inbox.js resolveArchiveRequestRenagMs]' },
      { key: 'reconcileSweep', type: 'enum', values: ['auto', 'off'], default: 'auto', env: 'ANTIHALL_DEVSWARM_RECONCILE_SWEEP', advanced: true, description: 'Enable/disable the periodic reconcile sweep in the supervisor. [verified: companion/devswarm-supervisor.js:574 reconcileSweepEnabled — default "auto", only "off" disables]' },
      { key: 'reconcileSweepSec', type: 'number', min: 300, default: 900, env: 'ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC', advanced: true, description: 'Interval (sec) for the reconcile sweep, floor 300s. [verified: companion/devswarm-supervisor.js:554 DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS = 15*60*1000 -> 900s]' },
      { key: 'rowStaleMs', type: 'number', min: 0, default: 86400000, env: 'ANTIHALL_DEVSWARM_ROW_STALE_MS', advanced: true, description: 'Staleness threshold (ms) for workspace row selection. [verified: companion/lib/devswarm-row-select.js:54 DEFAULT_ROW_STALE_MS = 24*60*60*1000]' },
      { key: 'sendReceiptRetentionDays', type: 'number', exclusiveMin: 0, default: 7, env: 'ANTIHALL_DEVSWARM_SEND_RECEIPT_RETENTION_DAYS', advanced: true, description: 'Retention window (days) for send-receipt records. [verified: hooks/lib/doctor-repair.js:2652 SEND_RECEIPT_RETENTION_DAYS_DEFAULT = 7]' },
      { key: 'summaryRetentionDays', type: 'number', min: 0, default: 30, env: 'ANTIHALL_DEVSWARM_SUMMARY_RETENTION_DAYS', advanced: true, description: 'Retention window (days) for summary records. [verified: companion/lib/devswarm-store.js:3119 GC_STALE_SUMMARIES_DAYS_DEFAULT = 30]' },
      { key: 'wakeCron', type: 'string', default: '*/30 * * * *', env: 'ANTIHALL_DEVSWARM_WAKE_CRON', advanced: true, description: 'Wake-poll cron schedule override (treated as untrusted input). [verified: hooks/lib/devswarm-wake.js:67 WAKE_CRON_DEFAULT = \'*/30 * * * *\']' },
      { key: 'wakeWatchPollMs', type: 'number', min: 250, max: 60000, default: 2000, env: 'ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS', advanced: true, description: 'Poll interval (ms) for the wake-watch loop, clamped [250,60000]. [verified: companion/lib/devswarm-wake-watch.js:215 DEFAULT_POLL_MS = 2000]' },
      { key: 'childGateRetentionDays', type: 'number', exclusiveMin: 0, default: 14, env: 'ANTIHALL_DEVSWARM_CHILD_GATE_RETENTION_DAYS', advanced: true, description: 'Days a per-session child-gate state file is kept before the housekeeping/doctor sweep removes it. [verified: hooks/lib/doctor-repair.js CHILD_GATE_RETENTION_DAYS_DEFAULT = 14]' },
      { key: 'housekeepingSweep', type: 'enum', values: ['auto', 'off'], default: 'auto', env: 'ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP', advanced: true, description: 'Supervisor disk-hygiene sweep (reaped logs, child-gate state); only "off" disables it. [verified: companion/devswarm-supervisor.js housekeepingSweepEnabled]' },
      { key: 'housekeepingSweepSec', type: 'number', min: 300, default: 3600, env: 'ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP_SEC', advanced: true, description: 'Seconds between housekeeping sweeps, floor 300. [verified: companion/devswarm-supervisor.js DEFAULT_HOUSEKEEPING_SWEEP_COOLDOWN_MS = 60*60*1000]' },
      { key: 'supervisorLogRotateBytes', type: 'number', exclusiveMin: 0, default: 10485760, env: 'ANTIHALL_DEVSWARM_SUPERVISOR_LOG_ROTATE_BYTES', advanced: true, description: 'Size at which the supervisor rotates its own log. [verified: companion/devswarm-supervisor.js SUPERVISOR_LOG_ROTATE_BYTES_DEFAULT = 10*1024*1024]' },
      { key: 'inboxGraceSec', type: 'number', min: 0, default: 120, env: 'ANTIHALL_DEVSWARM_INBOX_GRACE_SEC', advanced: true, description: 'Grace window (sec) before a child\'s fresh unread is flagged, unless it heartbeats first; 0 = no grace. [verified: hooks/devswarm-parent-inbox.js DEFAULT_INBOX_GRACE_MS = 120*1000]' },
      { key: 'stableLauncher', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_STABLE_LAUNCHER', advanced: true, description: 'Point injected DevSwarm directive text (mailbox wake cron, Monitor re-arm, comms override, drain nudge) at a version-independent launcher under ~/.anti-hall/bin/ instead of the current hook\'s own version-pinned plugin-cache path, so crons/Monitors/handovers survive an anti-hall update without a manual recreate. false reverts to the raw versioned path. [verified: hooks/lib/stable-launcher.js installLaunchers; wired in devswarm-child-role.js/devswarm-parent-gate.js/devswarm-child-gate.js/devswarm-child-drain.js]' },
      { key: 'supervisorSweepBudgetMs', type: 'number', min: 0, default: 20000, env: 'ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS', advanced: true, description: 'Time budget (ms) for one supervisor sweep pass. [verified: companion/devswarm-supervisor.js:1029 DEFAULT_SUPERVISOR_SWEEP_BUDGET_MS = 20000]' },
      { key: 'supervisorBlockerLabelReaskSec', type: 'number', min: 60, default: 21600, env: 'ANTIHALL_DEVSWARM_SUPERVISOR_BLOCKER_LABEL_REASK_SEC', advanced: true, description: 'Seconds a supervisorBlockerLabel ask/log is suppressed while its input (childId+kind+ts) is unchanged, before a periodic re-ask fires anyway. [verified: companion/devswarm-supervisor.js DEFAULT_BLOCKER_LABEL_REASK_MS = 6*60*60*1000 -> 21600s]' },

      // ---- Workspace lifecycle (auto-archive) ----
      // Read by companion/lib/devswarm-lifecycle.js readSettings (nested
      // {"devswarm": {"autoArchive": {...}}} in settings.json also accepted).
      { key: 'autoArchive.mode', type: 'enum', values: ['on', 'dry-run', 'off'], default: 'on', env: 'ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE', pluginOption: 'devswarm_auto_archive_mode', description: 'Auto-archive finished workspaces (needs DevSwarm ≥ 2.5.3). [verified: companion/lib/devswarm-lifecycle.js DEFAULT_SETTINGS]' },
      { key: 'autoArchive.idleMin', type: 'number', min: 5, default: 30, env: 'ANTIHALL_DEVSWARM_AUTO_ARCHIVE_IDLE_MIN', pluginOption: 'devswarm_auto_archive_idle_min', advanced: true, description: 'Minutes idle before a finished workspace is eligible for auto-archive. [verified: companion/lib/devswarm-lifecycle.js DEFAULT_SETTINGS]' },
      { key: 'autoArchive.maxPerSweep', type: 'number', min: 1, max: 20, default: 3, env: 'ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MAX_PER_SWEEP', pluginOption: 'devswarm_auto_archive_max_per_sweep', advanced: true, description: 'Max workspaces auto-archived in one sweep. [verified: companion/lib/devswarm-lifecycle.js DEFAULT_SETTINGS]' },
      { key: 'autoArchive.ignorePings', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_AUTO_ARCHIVE_IGNORE_PINGS', pluginOption: 'devswarm_auto_archive_ignore_pings', advanced: true, description: 'Idle timer ignores a finished workspace\'s own mailbox-wake/heartbeat/status turns; real work (an AI turn, a tool call, a new message, a commit) still resets it. Off = any activity resets it. [verified: companion/lib/devswarm-lifecycle.js DEFAULT_IGNORE_PINGS]' },

      // ---- Retention ----
      // Read by companion/lib/devswarm-retention.js resolveSettings.
      { key: 'retention.days', type: 'number', min: 0, default: 30, env: 'ANTIHALL_DEVSWARM_RETENTION_DAYS', advanced: true, description: 'Days of message bodies kept before archive+prune; 0 = retention off. [verified: companion/lib/devswarm-retention.js DEFAULTS]' },
      { key: 'retention.maxStoreMB', type: 'number', min: 0, default: 100, env: 'ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB', advanced: true, description: 'Store size limit (MB): above it, oldest bodies are pruned regardless of age; 0 = no limit. [verified: companion/lib/devswarm-retention.js DEFAULTS]' },
      { key: 'retention.keepPerPartition', type: 'number', min: 0, default: 200, env: 'ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION', advanced: true, description: 'Newest messages per partition that are never pruned (age or size). [verified: companion/lib/devswarm-retention.js DEFAULTS]' },
      { key: 'retention.archive', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_RETENTION_ARCHIVE', advanced: true, description: 'Write pruned bodies to the gzip archive first (restorable via `devswarm.js retention restore`). [verified: companion/lib/devswarm-retention.js DEFAULTS]' },
      { key: 'retention.archiveMaxMB', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB', advanced: true, description: 'Archive size cap (MB); 0 (default) = never evict; above a set cap the oldest archive months are dropped. doctor warns past 500 MB. [verified: companion/lib/devswarm-retention.js DEFAULTS]' },

      // ---- 0.108.4: per-hook on/off switches (default = current behaviour) ----
      { key: 'parentGate', type: 'boolean', default: true, pluginOption: 'devswarm_parent_gate', description: 'devswarm-parent-gate (Stop): make a Primary attend to a child with unread mail or a stale verdict before stopping.' },
      { key: 'childGate', type: 'boolean', default: true, pluginOption: 'devswarm_child_gate', description: 'devswarm-child-gate (Stop): make a child workspace heartbeat/report to its parent before going idle.' },
      { key: 'parentInbox', type: 'boolean', default: true, pluginOption: 'devswarm_parent_inbox', description: 'devswarm-parent-inbox (UserPromptSubmit): inject the workspace roster and unread child mail into a Primary.' },
      { key: 'childTurn', type: 'boolean', default: true, pluginOption: 'devswarm_child_turn', description: 'devswarm-child-turn (UserPromptSubmit): inject a child workspace\'s pending mail each turn.' },
      { key: 'childRole', type: 'boolean', default: true, pluginOption: 'devswarm_child_role', description: 'devswarm-child-role (SessionStart): inject the mesh-only messaging directive into Primary and child sessions.' },
      { key: 'childDrain', type: 'boolean', default: true, pluginOption: 'devswarm_child_drain', description: 'devswarm-child-drain (PostToolUse Bash): re-surface a child\'s unread mail mid-task (throttled).' },
      { key: 'parentReplyTracker', type: 'boolean', default: true, pluginOption: 'devswarm_parent_reply_tracker', description: 'devswarm-parent-reply-tracker (PostToolUse Bash): record the Primary\'s direct replies so the parent gate can tell read from answered.' },
      { key: 'commsGuard', type: 'boolean', default: true, pluginOption: 'devswarm_comms_guard', description: 'devswarm-comms-guard (PreToolUse SendMessage): block SendMessage to a DevSwarm workspace (mesh messaging only).' },
      { key: 'inboxReadGuard', type: 'boolean', default: true, pluginOption: 'devswarm_inbox_read_guard', description: 'inbox-read-guard (PreToolUse Read): block raw Read-tool reads of the DevSwarm inbox/store (use the wrapper).' },
      { key: 'wakeWatch', type: 'boolean', default: true, pluginOption: 'devswarm_wake_watch', description: 'devswarm-wake-watch monitor: wake an idle session the moment new mesh mail lands (the cron fallback stays).' },
      { key: 'appSync', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_APP_SYNC', pluginOption: 'devswarm_app_sync', description: 'Supervisor app-DB sync: apply the DevSwarm app database (archive state, names, drift) every tick.' },
      { key: 'screenshotSync', type: 'boolean', default: true, pluginOption: 'devswarm_screenshot_sync', description: '`devswarm.js sync-ui`: reconcile a transcribed sidebar screenshot against the app DB.' },
      // ---- 0.108.5 ----
      { key: 'spawnFromOrigin', type: 'boolean', default: true, pluginOption: 'devswarm_spawn_from_origin', description: '`devswarm.js spawn`: fetch origin first and fast-forward the local default branch so a child never starts from stale tooling; refuses when it is behind and cannot be updated (unless --from-local). [read by: scripts/devswarm.js spawnSourceFreshness]' },
      // ---- 0.109.0: spawn speed ----
      { key: 'spawnFetchTtlSec', type: 'number', min: 0, default: 300, env: 'ANTIHALL_DEVSWARM_SPAWN_FETCH_TTL_SEC', pluginOption: 'devswarm_spawn_fetch_ttl_sec', advanced: true, description: '`devswarm.js spawn`: skip the origin fetch when the remote-tracking ref was already updated within this many seconds (0 = always fetch). [read by: scripts/devswarm.js spawnSourceFreshness]' },
      { key: 'spawnCreateTimeoutMs', type: 'number', min: 1000, default: 180000, env: 'ANTIHALL_DEVSWARM_SPAWN_CREATE_TIMEOUT_MS', pluginOption: 'devswarm_spawn_create_timeout_ms', advanced: true, description: 'Timeout (ms) for the `hivecontrol workspace create` call spawn makes; on timeout only our own child process is killed. [read by: scripts/devswarm.js cmdSpawn]' },
    ],
  },
  {
    key: 'statusline',
    label: 'Statusline',
    description: 'The rich statusline (version chip, phase bar, account segment).',
    settings: [
      { key: 'base', type: 'string', default: '', env: 'ANTIHALL_STATUSLINE_BASE', pluginOption: 'statusline_base', description: 'Shell command run as the line-1 base in consolidated statusline mode.' },
      { key: 'noEmail', type: 'boolean', default: false, env: 'ANTIHALL_STATUSLINE_NO_EMAIL', pluginOption: 'statusline_no_email', description: 'Suppress the email segment in the statusline.' },
    ],
  },
  {
    key: 'codexNudge',
    label: 'Codex Nudge',
    description: 'Hand-off nudge suggesting Codex for review/diagnosis.',
    settings: [
      { key: 'enabled', type: 'boolean', pluginOption: 'codex_nudge_enabled', default: true, env: 'ANTIHALL_CODEX_NUDGE', description: 'Enable the Codex hand-off nudge hook.' },
      { key: 'min', type: 'number', min: 1, default: 3, env: 'ANTIHALL_CODEX_NUDGE_MIN', advanced: true, description: 'Minimum substantial code-file edits before the nudge fires. [verified: hooks/codex-nudge.js:48 DEFAULT_MIN = 3]' },
    ],
  },
  {
    key: 'defects',
    label: 'Defects',
    description: 'The two-way defect-reporting channel.',
    settings: [
      { key: 'defaultProj', type: 'string', pluginOption: 'defects_default_proj', default: '', env: 'ANTIHALL_DEFECT_PROJ', description: 'Default project tag used when filing an anti-hall defect (max 64 chars).' },
    ],
  },
];

// NOT_TOGGLEABLE — parts of anti-hall that deliberately have NO on/off switch,
// with the reason. `settings.js show` prints this list so nothing is silently
// missing from the settings surface.
const NOT_TOGGLEABLE = [
  { name: 'skip-guard', reason: 'the user-consent escape hatch (~/.anti-hall/skip.json) every guard reads; not a feature, it is how a human pauses one.' },
  { name: 'coordinator-detect', reason: 'shared library that tells coordinator from subagent for command-guard / edit-guard; not a hook.' },
  { name: 'omc-detect', reason: 'shared library that lets task-guard / tasklist-guard defer to an active OMC loop; turning it off would deadlock those guards against the loop.' },
  { name: 'phase-tracker', reason: 'never blocks or injects; records spawns that the statusline phase bar reads. Off would only break the statusline.' },
  { name: 'fable-availability', reason: 'records whether a Fable model exists for model routing and skills; no output of its own.' },
  { name: 'codex-availability', reason: 'records whether the codex CLI is on PATH for routing and skills; no output of its own.' },
  { name: 'emit-dedupe-reset', reason: 'resets the emit-dedupe state after a context loss; off would hide DevSwarm blocks the model no longer holds. Use guards.emitDedupe instead.' },
  { name: 'agent-watchdog', reason: 'a manual helper script, not a registered hook; it only runs when you call it.' },
  { name: 'command-guard data-safety sub-guards', reason: 'DevSwarm read/send/subagent-mailbox guards prevent inbox cursor loss; they keep their own per-guard skip.json names. The stash guard is armed by guards.stashGuard.' },
];

function findSection(key) { return SECTIONS.find((s) => s.key === key) || null; }
function findSetting(section, key) {
  const s = findSection(section);
  if (!s) return null;
  return s.settings.find((x) => x.key === key) || null;
}
function allSettings() {
  const out = [];
  for (const s of SECTIONS) for (const st of s.settings) out.push({ section: s.key, ...st });
  return out;
}
function pluginOptionEntries() { return allSettings().filter((s) => s.pluginOption); }

module.exports = { SECTIONS, NOT_TOGGLEABLE, TRUE_TOKENS, FALSE_TOKENS, findSection, findSetting, allSettings, pluginOptionEntries };
