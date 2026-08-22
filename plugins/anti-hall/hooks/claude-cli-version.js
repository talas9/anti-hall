#!/usr/bin/env node
// anti-hall :: claude-cli-version (SessionStart)
//
// Detects the installed Claude Code CLI version and, when it differs
// (major/minor) from the version anti-hall's harness-feature KB
// (docs/KB-claude-code-harness-features.md) was last audited against,
// injects a ONE-LINE advisory additionalContext nudge. This is Probe 2 of
// anti-hall's drift-probe family (see hooks/devswarm-version.js for Probe 1,
// hooks/repo-self-drift.js for Probe 3) — mirrors devswarm-version.js's shape
// exactly, sharing its mechanics via hooks/lib/drift-baseline.js.
//
// DESIGN (non-blocking, cached):
//   - Cache at ~/.anti-hall/claude-cli-version.json =
//     { installed, baseline, checkedAt, source, lastAdvised? }.
//   - Fresh cache (<24h) => read and return, no spawn.
//   - Stale/absent cache => spawn a DETACHED background refresh
//     (claude-cli-version-refresh.js) then exit immediately. NEVER block
//     SessionStart on a spawn.
//   - installed === null (CLI absent / unparseable) => FAIL-OPEN AND SILENT.
//   - Comparison is SEMVER-AWARE: MAJOR/MINOR drift advises; PATCH-only
//     drift is silent (unparseable either side is also silent).
//   - DEDUPE: once advised for a given (installed, baseline) pair, it is not
//     repeated while that exact pair holds. Either value changing re-arms.
//
// Escape hatches:
//   - ANTIHALL_CLAUDE_CLI_VERSION_ALERT=off disables the hook.
//   - skip.json { "claude-cli-version": <future-ms> } (or "all") disables it.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { hook_event_name, session_id, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always (fail-open on ANY error).

'use strict';

const path = require('path');
const {
  cacheFilePath,
  classifyVersionDrift,
  readCache,
  isFresh,
  alreadyAdvisedKey,
  persistAdvisedKey,
  emitAdvisory,
  spawnDetachedRefresh,
} = require('./lib/drift-baseline.js');
const { CLAUDE_CLI_BASELINE } = require('./lib/claude-cli-baseline.js');

const CACHE_FILE = cacheFilePath('claude-cli-version.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const BASELINE = CLAUDE_CLI_BASELINE;

function main() {
  if ((process.env.ANTIHALL_CLAUDE_CLI_VERSION_ALERT || '').toLowerCase() === 'off') return;

  try {
    const sg = require('./skip-guard.js');
    if (sg.isSkipped('claude-cli-version')) return;
  } catch (_) { /* skip-guard missing => no-op */ }

  const now = Date.now();

  let cache = null;
  try {
    cache = readCache(CACHE_FILE);
  } catch (_) {
    cache = null; // absent or malformed => treat as stale
  }

  if (!isFresh(cache, now, CACHE_TTL_MS)) {
    spawnDetachedRefresh(path.join(__dirname, 'claude-cli-version-refresh.js'));
    return;
  }

  // FAIL-OPEN AND SILENT: CLI absent or unparseable => nothing to advise.
  if (cache.installed === null || typeof cache.installed !== 'string' || !cache.installed) return;

  const drift = classifyVersionDrift(cache.installed, BASELINE);
  if (!drift.advise) return;

  const key = { installed: cache.installed, baseline: BASELINE };
  if (alreadyAdvisedKey(cache, key)) return;

  const additionalContext = drift.reason === 'older'
    ? `Claude Code CLI ${cache.installed} installed; anti-hall's harness KB is audited against ` +
      `${BASELINE} (newer) — behavior may have drifted, see docs/KB-claude-code-harness-features.md`
    : `Claude Code CLI ${cache.installed} installed; anti-hall's harness KB is audited against ` +
      `${BASELINE} — behavior may have drifted, see docs/KB-claude-code-harness-features.md`;

  emitAdvisory(additionalContext);
  persistAdvisedKey(CACHE_FILE, cache, key);
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    // Fail-open: unexpected throw, etc.
  }
  process.exit(0);
}

module.exports = {
  BASELINE,
  CACHE_FILE,
};
