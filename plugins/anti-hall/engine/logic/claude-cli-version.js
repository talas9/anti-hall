// check = "claude-cli-version" (SessionStart). Probe 2 of the drift family: when the Claude Code version a background probe cached
// differs by major or minor from the version the harness KB was audited against, say so once per (installed, baseline) pair. A stale
// or absent cache asks the engine's refresh job for the probe (sess.requestRefresh) and says nothing this session, as Node did
// when it started its detached refresh process. Mirrors hooks/claude-cli-version.js. Keys: session.toml (session.claude_cli_*).
'use strict';
function decide() {
  if (spawn.osHome() === null) return 'defer';
  return sess.driftProbe({ setting: 'session.setting_claude_cli', guard: 'session.claude_cli_guard', cache: 'session.claude_cli_cache',
    baseline: 'session.claude_cli_baseline', what: 'session.claude_cli_what', instead: 'session.claude_cli_instead', keyed: true, probe: 'claude_cli' });
}
