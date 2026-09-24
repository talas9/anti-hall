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
      { key: 'mergeGate', type: 'boolean', default: false, env: 'ANTIHALL_MERGE_GATE', pluginOption: 'guards_merge_gate', description: 'Enable merge-readiness gate checks before merging. [verified: hooks/merge-gate.js:42 — default off, opt-in via =on]' },
      { key: 'shipitGate', type: 'boolean', default: false, env: 'ANTIHALL_SHIPIT_GATE', description: 'Enable the ship-it workflow gate. [verified: hooks/ship-it-guard.js:71 — default off, opt-in via =on]' },
      { key: 'outputVerifyGuard', type: 'boolean', default: true, env: 'ANTIHALL_OUTPUT_VERIFY_GUARD', description: 'Output-verification guard (blocks unverified completion claims). [verified: hooks/output-verify-guard.js:198 — default on, =off disables]' },
      { key: 'failureRootCauseNudge', type: 'boolean', default: true, env: 'ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE', description: 'Nudge toward root-cause analysis after a failure. [verified: hooks/failure-root-cause-nudge.js:49 — default on, =off disables]' },
      { key: 'repoSelfDrift', type: 'boolean', default: true, env: 'ANTIHALL_REPO_SELF_DRIFT', description: "anti-hall's own repo-drift self-check hook. [verified: hooks/repo-self-drift.js:159 — default on, =off disables]" },
      { key: 'stashGuard', type: 'boolean', default: false, env: 'ANTIHALL_STASH_GUARD', description: 'Arm stash-protection warnings in git-guard (also armed per-repo via .anti-hall/protected-stashes). [verified: hooks/command-guard.js:1333 — default off, =1 arms]' },
      { key: 'emitDedupe', type: 'boolean', default: true, env: 'ANTIHALL_EMIT_DEDUPE', description: 'Deduplicate repeated hook-emit output. [verified: hooks/lib/emit-dedupe.js:129 — default on, =0 disables]' },
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
      { key: 'antiHall', type: 'boolean', default: true, env: 'ANTIHALL_VERSION_ALERT', description: 'Alert when a newer anti-hall version is available. [verified: hooks/version-alert.js:93 — default on, =off disables]' },
      { key: 'claudeCli', type: 'boolean', default: true, env: 'ANTIHALL_CLAUDE_CLI_VERSION_ALERT', description: 'Alert when a newer Claude CLI version is available. [verified: hooks/claude-cli-version.js:54 — default on, =off disables]' },
      { key: 'devswarm', type: 'boolean', default: true, env: 'ANTIHALL_DEVSWARM_VERSION_ALERT', description: 'Alert when a newer DevSwarm/hivecontrol version is available. [verified: hooks/devswarm-version.js:157 — default on, =off disables]' },
    ],
  },
  {
    key: 'updates',
    label: 'Updates / Maintenance',
    description: '`/anti-hall:update` and its background sweep.',
    settings: [
      { key: 'quiet', type: 'boolean', default: false, env: 'ANTIHALL_UPDATE_QUIET', description: 'Suppress update output (for scripted capture). [verified: skills/update/scripts/update.js:2687 — default off, =1 suppresses]' },
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
      { key: 'judgeModel', type: 'string', default: 'claude-haiku-4-5', env: 'ANTIHALL_JUDGE_MODEL', description: 'Model used for speculation-judge / jev-triage LLM calls.' },
      { key: 'semanticJudge', type: 'boolean', default: false, env: 'ANTIHALL_SEMANTIC_JUDGE', pluginOption: 'jev_semantic_judge', description: 'Enable the semantic speculation-judge hook (off = hook no-ops).' },
      { key: 'keyFile', type: 'string', default: '', legacy: { file: 'jev.json', key: 'keyFile' }, advanced: true, description: 'Credential key-file path (default depends on transport).' },
      { key: 'timeoutMs', type: 'number', min: 1, max: 3000, default: 1500, legacy: { file: 'jev.json', key: 'timeoutMs' }, advanced: true, description: 'Per-call timeout (ms), capped at 3000.' },
      { key: 'confidenceThreshold', type: 'number', min: 0, max: 1, default: 0.85, legacy: { file: 'jev.json', key: 'confidenceThreshold' }, advanced: true, description: 'Minimum confidence for a Jev answer to be trusted by callers.' },
      { key: 'triage', type: 'boolean', default: true, legacy: { file: 'jev.json', key: 'triage' }, advanced: true, description: 'Message-triage labeling once Jev is enabled.' },
      { key: 'triageUrgentThreshold', type: 'number', min: 0, max: 1, default: 0.9, legacy: { file: 'jev.json', key: 'triageUrgentThreshold' }, advanced: true, description: 'Confidence threshold for the urgent triage label. [verified: hooks/lib/jev-triage.js:51 DEFAULT_URGENT_THRESHOLD = 0.9]' },
      // jev-assist budget (0.108.0) — spend tracking, added alongside this schema;
      // behavior implemented separately in hooks/lib/jev-assist*.js. `watch` only
      // ever warns; it never auto-disables Jev (see budget.mode's description).
      { key: 'budget.mode', type: 'enum', values: ['unlimited', 'watch'], default: 'unlimited', pluginOption: 'jev_budget_mode', description: 'Jev spend: no limit, or warn when over budget (never auto-disables). [source: jev-assist budget (0.108.0)]' },
      { key: 'budget.usdPerDay', type: 'number', exclusiveMin: 0, default: null, optional: true, pluginOption: 'jev_budget_usd_per_day', description: 'optional: daily USD spend threshold, used only when budget.mode=watch. [source: jev-assist budget (0.108.0)]' },
      { key: 'budget.usdPerWeek', type: 'number', exclusiveMin: 0, default: null, optional: true, pluginOption: 'jev_budget_usd_per_week', description: 'optional: weekly USD spend threshold, used only when budget.mode=watch. [source: jev-assist budget (0.108.0)]' },
    ],
  },
  // REMOVED (v0.108.0 hardening pass): a `devswarm` section — hivecontrol,
  // supervisor mode, required gates, and ~25 mesh/supervisor tuning knobs
  // (cooldownSec, idleSec, nudge*, retention days, wake cadence, etc.) — was
  // drafted here with every default hand-verified against its source
  // constant, then removed before ship. Every one of those ANTIHALL_DEVSWARM_*
  // consumers takes an explicit `env` PARAMETER (for testability) rather than
  // reading `process.env` directly, so wiring settings.get() into them safely
  // requires threading a `home` parameter through each resolver first — their
  // default `os.homedir()` fallback would otherwise risk a unit test that
  // passes a synthetic env object silently reading the REAL developer
  // machine's ~/.anti-hall/settings.json. Showing them on the settings page
  // as controllable without that wiring would be a fake control. The real
  // ANTIHALL_DEVSWARM_* env vars are unaffected and keep working exactly as
  // before; re-add this section once each resolver accepts an injectable home.
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
      { key: 'min', type: 'number', min: 1, default: 3, env: 'ANTIHALL_CODEX_NUDGE_MIN', advanced: true, description: 'Minimum substantial code-file edits before the nudge fires. [verified: hooks/codex-nudge.js:48 DEFAULT_MIN = 3]' },
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
