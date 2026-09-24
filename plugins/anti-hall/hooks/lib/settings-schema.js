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
      { key: 'pct', type: 'number', min: 1, max: 99, default: 85, pluginOption: 'auto_handover_pct', description: 'Context-usage percent that triggers an automatic handover.' },
      { key: 'nag', type: 'boolean', default: true, pluginOption: 'auto_handover_nag', description: 'Nag (remind) the user when a handover is due but not yet written.' },
      { key: 'nagStepPct', type: 'number', min: 1, max: 100, default: 5, description: 'Percent increments between successive handover nags.' },
      { key: 'nagQuietMin', type: 'number', min: 1, default: 15, description: 'Minutes to wait before repeating a handover nag.' },
    ],
  },
  {
    key: 'guards',
    label: 'Guards',
    description: 'On/off switches and tuning for the always-on safety guard hooks.',
    settings: [
      { key: 'mergeGate', type: 'boolean', default: false, env: 'ANTIHALL_MERGE_GATE', pluginOption: 'guards_merge_gate', description: 'Enable merge-readiness gate checks before merging.' },
      { key: 'shipitGate', type: 'boolean', default: false, env: 'ANTIHALL_SHIPIT_GATE', description: 'Enable the ship-it workflow gate.' },
      { key: 'outputVerifyGuard', type: 'boolean', default: true, env: 'ANTIHALL_OUTPUT_VERIFY_GUARD', description: 'Output-verification guard (blocks unverified completion claims).' },
      { key: 'failureRootCauseNudge', type: 'boolean', default: true, env: 'ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE', description: 'Nudge toward root-cause analysis after a failure.' },
      { key: 'repoSelfDrift', type: 'boolean', default: true, env: 'ANTIHALL_REPO_SELF_DRIFT', description: "anti-hall's own repo-drift self-check hook." },
      { key: 'stashGuard', type: 'boolean', default: false, env: 'ANTIHALL_STASH_GUARD', description: 'Arm stash-protection warnings in git-guard (also armed per-repo via .anti-hall/protected-stashes).' },
      { key: 'emitDedupe', type: 'boolean', default: true, env: 'ANTIHALL_EMIT_DEDUPE', description: 'Deduplicate repeated hook-emit output.' },
      { key: 'editGuardAllow', type: 'csv', default: '', env: 'ANTIHALL_EDIT_GUARD_ALLOW', advanced: true, description: 'Extra allowed file globs for edit-guard (comma/colon separated).' },
      { key: 'allowSubagentMailbox', type: 'boolean', default: false, env: 'ANTIHALL_ALLOW_SUBAGENT_MAILBOX', advanced: true, description: 'One-off allow for the subagent-mailbox command pattern.' },
      { key: 'reaperMatch', type: 'string', default: '', env: 'ANTIHALL_REAPER_MATCH', advanced: true, description: 'Extra process-name pattern for the MCP session-end reaper.' },
      { key: 'reaperExclude', type: 'string', default: '', env: 'ANTIHALL_REAPER_EXCLUDE', advanced: true, description: 'Excludes matching processes from the MCP reaper.' },
      { key: 'tasklistWorkThreshold', type: 'number', min: 1, default: 3, env: 'ANTIHALL_TASKLIST_WORK_THRESHOLD', advanced: true, description: 'Minimum work items before tasklist-guard fires.' },
      { key: 'progressFreshMs', type: 'number', min: 0, default: 900000, env: 'ANTIHALL_PROGRESS_FRESH_MS', advanced: true, description: 'Freshness window (ms) for the progress file in tasklist-guard.' },
      { key: 'apiGuardThirdparty', type: 'boolean', default: false, env: 'ANTIHALL_API_GUARD_THIRDPARTY', advanced: true, description: 'Also verify installed 3rd-party package APIs, not just stdlib/builtins.' },
    ],
  },
  {
    key: 'versionAlerts',
    label: 'Version Alerts',
    description: 'Update-available nudges for anti-hall, Claude CLI, and DevSwarm.',
    settings: [
      { key: 'antiHall', type: 'boolean', default: true, env: 'ANTIHALL_VERSION_ALERT', description: 'Alert when a newer anti-hall version is available.' },
      { key: 'claudeCli', type: 'boolean', default: true, env: 'ANTIHALL_CLAUDE_CLI_VERSION_ALERT', description: 'Alert when a newer Claude CLI version is available.' },
      { key: 'devswarm', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_VERSION_ALERT', description: 'Alert when a newer DevSwarm/hivecontrol version is available.' },
    ],
  },
  {
    key: 'updates',
    label: 'Updates / Maintenance',
    description: '`/anti-hall:update` and its background sweep.',
    settings: [
      { key: 'quiet', type: 'boolean', default: false, env: 'ANTIHALL_UPDATE_QUIET', description: 'Suppress update output (for scripted capture).' },
      { key: 'reconcileBudgetMs', type: 'number', min: 0, default: 20000, env: 'ANTIHALL_RECONCILE_BUDGET_MS', advanced: true, description: 'Time budget (ms) for the reconcile step during update; 0 = unlimited.' },
      { key: 'postpullBudgetMs', type: 'number', min: 0, default: 90000, env: 'ANTIHALL_UPDATE_POSTPULL_BUDGET_MS', advanced: true, description: 'Time budget (ms) for the post-pull update sweep; 0 = unlimited.' },
      { key: 'sweepBudgetMs', type: 'number', min: 0, default: 20000, env: 'ANTIHALL_UPDATE_SWEEP_BUDGET_MS', advanced: true, description: 'Overall time budget (ms) for the update sweep.' },
    ],
  },
  {
    key: 'limitConserve',
    label: 'Limit Conservation',
    description: 'Auto-downshift behavior as usage approaches plan limits.',
    settings: [
      { key: 'mode', type: 'enum', values: ['auto', 'on', 'off'], default: 'auto', env: 'ANTIHALL_LIMIT_CONSERVE', pluginOption: 'limit_conserve_mode', description: 'Force conservation mode on/off, or auto-detect from the OMC usage cache.' },
      { key: 'threshold', type: 'number', min: 1, max: 99, default: 85, env: 'ANTIHALL_LIMIT_THRESHOLD', pluginOption: 'limit_conserve_threshold', description: 'Usage percent that triggers conservation mode.' },
      { key: 'accountCheck', type: 'boolean', default: true, env: 'ANTIHALL_LIMIT_ACCOUNT_CHECK', advanced: true, description: 'Guard against stale usage-cache readings after an account switch.' },
    ],
  },
  {
    key: 'jev',
    label: 'Jev (semantic decision engine)',
    description: 'Opt-in Jev "System One" classifier for triage/decisions.',
    settings: [
      { key: 'enabled', type: 'boolean', default: false, env: 'ANTIHALL_JEV', legacy: { file: 'jev.json', key: 'enabled' }, pluginOption: 'jev_enabled', description: 'Enable Jev (ANTIHALL_JEV=0 always force-disables regardless of this).' },
      { key: 'transport', type: 'enum', values: ['vercel', 'typesafe'], default: 'vercel', legacy: { file: 'jev.json', key: 'transport' }, pluginOption: 'jev_transport', description: 'Vercel AI Gateway passthrough (default) or a direct TypeSafe API call.' },
      { key: 'judgeModel', type: 'string', default: 'claude-haiku-4-5', env: 'ANTIHALL_JUDGE_MODEL', description: 'Model used for speculation-judge / jev-triage LLM calls.' },
      { key: 'semanticJudge', type: 'boolean', default: false, env: 'ANTIHALL_SEMANTIC_JUDGE', pluginOption: 'jev_semantic_judge', description: 'Enable the semantic speculation-judge hook (off = hook no-ops).' },
      { key: 'keyFile', type: 'string', default: '', legacy: { file: 'jev.json', key: 'keyFile' }, advanced: true, description: 'Credential key-file path (default depends on transport).' },
      { key: 'timeoutMs', type: 'number', min: 1, max: 3000, default: 1500, legacy: { file: 'jev.json', key: 'timeoutMs' }, advanced: true, description: 'Per-call timeout (ms), capped at 3000.' },
      { key: 'confidenceThreshold', type: 'number', min: 0, max: 1, default: 0.85, legacy: { file: 'jev.json', key: 'confidenceThreshold' }, advanced: true, description: 'Minimum confidence for a Jev answer to be trusted by callers.' },
      { key: 'triage', type: 'boolean', default: true, legacy: { file: 'jev.json', key: 'triage' }, advanced: true, description: 'Message-triage labeling once Jev is enabled.' },
      { key: 'triageUrgentThreshold', type: 'number', min: 0, max: 1, default: 0.9, legacy: { file: 'jev.json', key: 'triageUrgentThreshold' }, advanced: true, description: 'Confidence threshold for the urgent triage label.' },
    ],
  },
  {
    key: 'devswarm',
    label: 'DevSwarm',
    description: 'Multi-workspace mesh orchestration, liveness, and supervisor tuning.',
    settings: [
      { key: 'hivecontrol', type: 'string', default: '', env: 'ANTIHALL_DEVSWARM_HIVECONTROL', pluginOption: 'devswarm_hivecontrol', description: 'Explicit path to the hivecontrol CLI binary (default: PATH lookup).' },
      { key: 'supervisorMode', type: 'enum', values: ['auto', 'on', 'off'], default: 'auto', env: 'ANTIHALL_DEVSWARM_SUPERVISOR', pluginOption: 'devswarm_supervisor_mode', description: 'Force the DevSwarm supervisor context on/off, or auto-detect.' },
      { key: 'requiredGates', type: 'csv', default: 'done,merged,tests_passed', env: 'ANTIHALL_DEVSWARM_REQUIRED_GATES', description: 'Merge gates required for DevSwarm tasks.' },
      { key: 'inboxCmd', type: 'string', default: '', env: 'ANTIHALL_DEVSWARM_INBOX_CMD', description: 'Consumer-configured command to read pending mesh messages.' },
      { key: 'childGateStrict', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_CHILD_GATE_STRICT', advanced: true, description: 'Strict child-gate enforcement.' },
      { key: 'parentGateCap', type: 'number', min: 1, default: 10, env: 'ANTIHALL_DEVSWARM_PARENT_GATE_CAP', advanced: true, description: 'Caps the parent-gate wait/child count.' },
      { key: 'activeFloorPct', type: 'number', min: 0, max: 100, default: 50, env: 'ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT', advanced: true, description: 'Min percent of active workspaces kept in the archived cache (0 disables the floor).' },
      { key: 'archivedCacheMaxAgeMs', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS', advanced: true, description: 'Max age (ms) for archived-workspace cache entries (default: 2x sweep interval).' },
      { key: 'archivedGraceMs', type: 'number', min: 0, default: 600000, env: 'ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS', advanced: true, description: 'Grace period (ms) before a workspace is considered archived.' },
      { key: 'cooldownSec', type: 'number', min: 0, default: 600, env: 'ANTIHALL_DEVSWARM_COOLDOWN_SEC', advanced: true, description: 'Supervisor cooldown (sec) between recovery actions.' },
      { key: 'idleSec', type: 'number', min: 60, default: 900, env: 'ANTIHALL_DEVSWARM_IDLE_SEC', advanced: true, description: 'Supervisor idle threshold (sec).' },
      { key: 'dormantMs', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_DORMANT_MS', advanced: true, description: 'Dormant-workspace threshold (ms).' },
      { key: 'drainTtlMs', type: 'number', min: 0, default: 600000, env: 'ANTIHALL_DEVSWARM_DRAIN_TTL_MS', advanced: true, description: 'TTL (ms) for the drain marker.' },
      { key: 'graceSec', type: 'number', min: 1, max: 60, default: 30, env: 'ANTIHALL_DEVSWARM_GRACE_SEC', advanced: true, description: 'Grace window (sec) before recovery in devswarm-recover.' },
      { key: 'maxRecoveries', type: 'number', min: 1, max: 20, default: 5, env: 'ANTIHALL_DEVSWARM_MAX_RECOVERIES', advanced: true, description: 'Max auto-recovery attempts.' },
      { key: 'intervalSec', type: 'number', min: 60, max: 120, default: 90, env: 'ANTIHALL_DEVSWARM_INTERVAL', advanced: true, description: 'Sweep interval (sec) used at supervisor install time.' },
      { key: 'migrateMarkRead', type: 'boolean', default: false, env: 'ANTIHALL_DEVSWARM_MIGRATE_MARK_READ', advanced: true, description: 'Mark migrated messages as read during state migration.' },
      { key: 'monitorTimeoutSec', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_MONITOR_TIMEOUT_SEC', advanced: true, description: 'Bounded cadence (sec) for monitor timeout in devswarm-ingest.' },
      { key: 'nudgeCooldownSec', type: 'number', min: 0, default: 120, env: 'ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC', advanced: true, description: 'Cooldown (sec) between supervisor nudges.' },
      { key: 'nudgeMaxAttempts', type: 'number', min: 1, max: 20, default: 2, env: 'ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS', advanced: true, description: 'Max nudge attempts before escalation.' },
      { key: 'nudgeWindowSec', type: 'number', min: 1, default: 180, env: 'ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC', advanced: true, description: 'Window (sec) for counting nudge attempts.' },
      { key: 'postSpawnGraceSec', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_POST_SPAWN_GRACE_SEC', advanced: true, description: 'Grace period (sec) right after spawning a child workspace.' },
      { key: 'reapedRetentionDays', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_REAPED_RETENTION_DAYS', advanced: true, description: 'Retention window (days) for reaped-workspace logs.' },
      { key: 'receiptWindowMs', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_RECEIPT_WINDOW_MS', advanced: true, description: 'Window (ms) for parent-reply receipt tracking.' },
      { key: 'reconcileSweep', type: 'enum', values: ['auto', 'off'], default: 'auto', env: 'ANTIHALL_DEVSWARM_RECONCILE_SWEEP', advanced: true, description: 'Enable/disable the periodic reconcile sweep in the supervisor.' },
      { key: 'reconcileSweepSec', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC', advanced: true, description: 'Interval (sec) for the reconcile sweep.' },
      { key: 'rowStaleMs', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_ROW_STALE_MS', advanced: true, description: 'Staleness threshold (ms) for workspace row selection.' },
      { key: 'sendReceiptRetentionDays', type: 'number', min: 0, default: 7, env: 'ANTIHALL_DEVSWARM_SEND_RECEIPT_RETENTION_DAYS', advanced: true, description: 'Retention window (days) for send-receipt records.' },
      { key: 'summaryRetentionDays', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_SUMMARY_RETENTION_DAYS', advanced: true, description: 'Retention window (days) for summary records.' },
      { key: 'wakeCron', type: 'string', default: '', env: 'ANTIHALL_DEVSWARM_WAKE_CRON', advanced: true, description: 'Wake-poll cron schedule override (treated as untrusted input).' },
      { key: 'wakeWatchPollMs', type: 'number', min: 0, default: 0, env: 'ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS', advanced: true, description: 'Poll interval (ms) for the wake-watch loop.' },
      { key: 'supervisorSweepBudgetMs', type: 'number', min: 0, default: 0, env: 'ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS', advanced: true, description: 'Time budget (ms) for one supervisor sweep pass.' },
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
      { key: 'enabled', type: 'boolean', default: true, env: 'ANTIHALL_CODEX_NUDGE', description: 'Enable the Codex hand-off nudge hook.' },
      { key: 'min', type: 'number', min: 1, default: 3, env: 'ANTIHALL_CODEX_NUDGE_MIN', advanced: true, description: 'Minimum substantial code-file edits before the nudge fires.' },
    ],
  },
  {
    key: 'defects',
    label: 'Defects',
    description: 'The two-way defect-reporting channel.',
    settings: [
      { key: 'defaultProj', type: 'string', default: '', env: 'ANTIHALL_DEFECT_PROJ', description: 'Default project tag used when filing an anti-hall defect (max 64 chars).' },
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
