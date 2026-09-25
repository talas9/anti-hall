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
      { key: 'stashGuard', type: 'boolean', pluginOption: 'guards_stash_guard', default: false, env: 'ANTIHALL_STASH_GUARD', description: 'Arm stash-protection warnings in git-guard (also armed per-repo via .anti-hall/protected-stashes). [verified: hooks/command-guard.js:1333 — default off, =1 arms]' },
      { key: 'emitDedupe', type: 'boolean', pluginOption: 'guards_emit_dedupe', default: true, env: 'ANTIHALL_EMIT_DEDUPE', description: 'Deduplicate repeated hook-emit output. [verified: hooks/lib/emit-dedupe.js:129 — default on, =0 disables]' },
      { key: 'editGuardAllow', type: 'csv', default: '', env: 'ANTIHALL_EDIT_GUARD_ALLOW', advanced: true, description: 'Extra allowed file globs for edit-guard (comma/colon separated). [verified: hooks/edit-guard.js — no built-in default, empty means none]' },
      { key: 'allowSubagentMailbox', type: 'boolean', default: false, env: 'ANTIHALL_ALLOW_SUBAGENT_MAILBOX', advanced: true, description: 'One-off allow for the subagent-mailbox command pattern. [verified: hooks/command-guard.js:1298 — default off, =1 allows]' },
      { key: 'reaperMatch', type: 'string', default: '', env: 'ANTIHALL_REAPER_MATCH', advanced: true, description: 'Extra process-name pattern for the MCP session-end reaper. [verified: hooks/session-end-mcp-reaper.js — no built-in default, empty means none]' },
      { key: 'reaperExclude', type: 'string', default: '', env: 'ANTIHALL_REAPER_EXCLUDE', advanced: true, description: 'Excludes matching processes from the MCP reaper. [verified: hooks/session-end-mcp-reaper.js — no built-in default, empty means none]' },
      { key: 'tasklistWorkThreshold', type: 'number', min: 1, default: 3, env: 'ANTIHALL_TASKLIST_WORK_THRESHOLD', advanced: true, description: 'Minimum work items before tasklist-guard fires. [verified: hooks/tasklist-guard.js:45 DEFAULT_WORK_THRESHOLD = 3]' },
      { key: 'progressFreshMs', type: 'number', min: 0, default: 1800000, env: 'ANTIHALL_PROGRESS_FRESH_MS', advanced: true, description: 'Freshness window (ms) for the progress file in tasklist-guard. [verified: hooks/tasklist-guard.js:46 DEFAULT_PROGRESS_FRESH_MS = 30*60*1000]' },
      { key: 'apiGuardThirdparty', type: 'boolean', default: false, env: 'ANTIHALL_API_GUARD_THIRDPARTY', advanced: true, description: 'Also verify installed 3rd-party package APIs, not just stdlib/builtins. [verified: hooks/api-guard.js:84 — default off, =1/true/yes/on enables]' },
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
      // Per-integration Jev modes for the 0.108 integrations (legacy home: the
      // same ids under jev.json "integrations"). on = may change the outcome,
      // shadow = consulted + logged only, off = not consulted.
      { key: 'integrations.gitGuardSelfCredit', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.gitGuardSelfCredit' }, advanced: true, description: 'Jev check for paraphrased AI self-credit in commit/PR text (add-block only; never relaxes git-guard). [read by: hooks/lib/jev-assist.js getMode]' },
      { key: 'integrations.parentGateQuestion', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.parentGateQuestion' }, advanced: true, description: 'Parent gate: treat an unread child message Jev already labelled a question as awaiting a reply (cache-only, no network). [read by: hooks/lib/jev-assist.js getMode]' },
      { key: 'integrations.tasklistTrivial', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.tasklistTrivial' }, advanced: true, description: 'tasklist-guard: when on, a confident "small bounded chore" verdict (asked synchronously, 1.5 s cap, fail-open) skips the task-tracking nudge. [read by: hooks/lib/jev-assist.js getMode]' },
      { key: 'integrations.supervisorBlockerLabel', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.supervisorBlockerLabel' }, advanced: true, description: 'Supervisor report label: waiting-on-parent vs wedged, from cached triage labels (advisory, no network). [read by: hooks/lib/jev-assist.js getMode]' },
      { key: 'integrations.codexNudgeSubstantial', type: 'enum', values: ['on', 'shadow', 'off'], default: 'shadow', legacy: { file: 'jev.json', key: 'integrations.codexNudgeSubstantial' }, advanced: true, description: 'codex-nudge: when on, a confident "edits are trivial" verdict (asked synchronously, 1.5 s cap, fail-open) skips the Codex-review nudge. [read by: hooks/lib/jev-assist.js getMode]' },
      { key: 'weeklyNotice', type: 'boolean', pluginOption: 'jev_weekly_notice', default: true, legacy: { file: 'jev.json', key: 'weeklyNotice' }, description: 'Once-a-week SessionStart scorecard notice naming one integration worth promoting or turning off (Jev enabled only). [read by: hooks/jev-weekly-scorecard.js]' },
      // Audit / pricing / low-credit (0.108.0). Legacy home: the same keys in
      // ~/.anti-hall/jev.json (nested, e.g. {"audit": {"snippets": true}}).
      { key: 'audit.snippets', type: 'boolean', default: false, env: 'ANTIHALL_JEV_AUDIT_SNIPPETS', legacy: { file: 'jev.json', key: 'audit.snippets' }, advanced: true, description: 'Store a redacted ~200-char snippet for decisions Jev changed or would change in shadow mode (off by default: privacy). [read by: hooks/lib/jev-assist.js readAuditConfig]' },
      { key: 'budget.minCreditUsd', type: 'number', pluginOption: 'jev_budget_min_credit_usd', exclusiveMin: 0, default: null, optional: true, legacy: { file: 'jev.json', key: 'budget.minCreditUsd' }, description: 'optional: warn (once a day, budget.mode=watch only) when the gateway credit balance drops below this USD amount. [read by: scripts/jev-report.js readBudgetConfig]' },
      { key: 'prices', type: 'object', default: null, computed: true, legacy: { file: 'jev.json', key: 'prices' }, advanced: true, description: 'computed: per-model USD price table {model: {inPerMTok, outPerMTok}} (or a "default" entry), used only when the gateway reports tokens but no cost. File-only (no env, no CLI set) — edit ~/.anti-hall/settings.json directly. [read by: hooks/lib/jev-assist.js readPrices]' },
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
      { key: 'childGateStrict', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_CHILD_GATE_STRICT', advanced: true, description: 'Strict child-gate enforcement. [verified: hooks/devswarm-child-gate.js:530-536 strictEnabled — raw undefined -> "1" -> true; "0" disables]' },
      { key: 'parentGateCap', type: 'number', min: 2, max: 5, default: 3, env: 'ANTIHALL_DEVSWARM_PARENT_GATE_CAP', advanced: true, description: 'Caps the parent-gate wait/child count, clamped to [2,5]. [verified: hooks/devswarm-parent-gate.js:185 DEFAULT_CAP = 3]' },
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
      { key: 'nudgeCooldownSec', type: 'number', min: 0, default: 120, env: 'ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC', advanced: true, description: 'Cooldown (sec) between supervisor nudges. [verified: companion/devswarm-supervisor.js:29 header + DEFAULT_NUDGE_COOLDOWN_MS/1000 = 120]' },
      { key: 'nudgeMaxAttempts', type: 'number', min: 1, max: 20, default: 2, env: 'ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS', advanced: true, description: 'Max nudge attempts before escalation. [verified: companion/lib/recovery.js DEFAULT_NUDGE_MAX_ATTEMPTS = 2, via companion/devswarm-supervisor.js:27 header + :100]' },
      { key: 'nudgeWindowSec', type: 'number', min: 1, default: 180, env: 'ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC', advanced: true, description: 'Window (sec) for counting nudge attempts. [verified: companion/lib/liveness.js:44 DEFAULT_NUDGE_WINDOW_MS = 3*60*1000 -> 180s, imported by companion/devswarm-supervisor.js:39]' },
      { key: 'postSpawnGraceSec', type: 'number', min: 0, max: 1800, default: 120, env: 'ANTIHALL_DEVSWARM_POST_SPAWN_GRACE_SEC', advanced: true, description: 'Grace period (sec) right after spawning a child workspace, clamped [0,1800]. [verified: companion/devswarm-supervisor.js:139 DEFAULT_POST_SPAWN_GRACE_MS = 2*60*1000 -> 120s]' },
      { key: 'reapedRetentionDays', type: 'number', exclusiveMin: 0, default: 30, env: 'ANTIHALL_DEVSWARM_REAPED_RETENTION_DAYS', advanced: true, description: 'Retention window (days) for reaped-workspace logs. [verified: hooks/lib/doctor-repair.js:2651 REAPED_RETENTION_DAYS_DEFAULT = 30]' },
      { key: 'receiptWindowMs', type: 'number', min: 0, default: 300000, env: 'ANTIHALL_DEVSWARM_RECEIPT_WINDOW_MS', advanced: true, description: 'Window (ms) for parent-reply receipt tracking. [verified: hooks/devswarm-parent-reply-tracker.js:167 RECEIPT_WINDOW_MS_DEFAULT = 5*60*1000]' },
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
      { key: 'supervisorSweepBudgetMs', type: 'number', min: 0, default: 20000, env: 'ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS', advanced: true, description: 'Time budget (ms) for one supervisor sweep pass. [verified: companion/devswarm-supervisor.js:1029 DEFAULT_SUPERVISOR_SWEEP_BUDGET_MS = 20000]' },

      // ---- Workspace lifecycle (auto-archive) ----
      // Read by companion/lib/devswarm-lifecycle.js readSettings (nested
      // {"devswarm": {"autoArchive": {...}}} in settings.json also accepted).
      { key: 'autoArchive.mode', type: 'enum', values: ['on', 'dry-run', 'off'], default: 'on', env: 'ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE', pluginOption: 'devswarm_auto_archive_mode', description: 'Auto-archive finished workspaces (needs DevSwarm ≥ 2.5.3). [verified: companion/lib/devswarm-lifecycle.js DEFAULT_SETTINGS]' },
      { key: 'autoArchive.idleMin', type: 'number', min: 5, default: 30, env: 'ANTIHALL_DEVSWARM_AUTO_ARCHIVE_IDLE_MIN', pluginOption: 'devswarm_auto_archive_idle_min', advanced: true, description: 'Minutes idle before a finished workspace is eligible for auto-archive. [verified: companion/lib/devswarm-lifecycle.js DEFAULT_SETTINGS]' },
      { key: 'autoArchive.maxPerSweep', type: 'number', min: 1, max: 20, default: 3, env: 'ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MAX_PER_SWEEP', pluginOption: 'devswarm_auto_archive_max_per_sweep', advanced: true, description: 'Max workspaces auto-archived in one sweep. [verified: companion/lib/devswarm-lifecycle.js DEFAULT_SETTINGS]' },

      // ---- Retention ----
      // Read by companion/lib/devswarm-retention.js resolveSettings.
      { key: 'retention.days', type: 'number', min: 0, default: 30, env: 'ANTIHALL_DEVSWARM_RETENTION_DAYS', advanced: true, description: 'Days of message bodies kept before archive+prune; 0 = retention off. [verified: companion/lib/devswarm-retention.js DEFAULTS]' },
      { key: 'retention.maxStoreMB', type: 'number', min: 0, default: 100, env: 'ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB', advanced: true, description: 'Store size limit (MB): above it, oldest bodies are pruned regardless of age; 0 = no limit. [verified: companion/lib/devswarm-retention.js DEFAULTS]' },
      { key: 'retention.keepPerPartition', type: 'number', min: 0, default: 200, env: 'ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION', advanced: true, description: 'Newest messages per partition that are never pruned (age or size). [verified: companion/lib/devswarm-retention.js DEFAULTS]' },
      { key: 'retention.archive', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_RETENTION_ARCHIVE', advanced: true, description: 'Write pruned bodies to the gzip archive first (restorable via `devswarm.js retention restore`). [verified: companion/lib/devswarm-retention.js DEFAULTS]' },
      { key: 'retention.archiveMaxMB', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB', advanced: true, description: 'Archive size cap (MB); 0 (default) = never evict; above a set cap the oldest archive months are dropped. doctor warns past 500 MB. [verified: companion/lib/devswarm-retention.js DEFAULTS]' },
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

module.exports = { SECTIONS, TRUE_TOKENS, FALSE_TOKENS, findSection, findSetting, allSettings, pluginOptionEntries };
