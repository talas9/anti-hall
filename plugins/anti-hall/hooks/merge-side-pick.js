#!/usr/bin/env node
// anti-hall :: merge-side-pick (PreToolUse + PostToolUse, matcher Bash, ADVISORY ONLY)
//
// PostToolUse: records a wholesale side-pick conflict resolution (`git checkout
// --ours|--theirs`, `git merge -X ours|theirs`, ...) and test runs, per session.
// PreToolUse: on `git push`, when a side-pick has no test run after it, adds one
// advisory line. Never blocks, never denies. Setting: guards.mergeSidePickAdvisory
// (default on). Same file on Claude and Codex (payload: session_id + tool_input.command).
// Fail-open: any error -> exit 0, no output.
'use strict';

const io = require('./lib/guard-io.js');

function main(payload, env, argv, out) {
  if (!payload || payload.tool_name !== 'Bash') return;
  const cmd = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : '';
  const sid = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (!cmd || !sid) return;
  try { if (require('./lib/settings.js').get('guards', 'mergeSidePickAdvisory') === false) return; } catch (_) { /* default on */ }
  try { if (require('./skip-guard.js').isSkipped('merge-side-pick')) return; } catch (_) { /* fail open */ }
  const lib = require('./lib/merge-side-pick.js');
  const home = require('../companion/lib/test-home-guard.js').resolveHome(undefined, env);
  if (payload.hook_event_name === 'PostToolUse' || argv.includes('--post')) {
    lib.record(home, sid, cmd);
    return;
  }
  const pick = lib.pushCheck(home, sid, cmd);
  if (!pick) return;
  out.json({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lib.advisory(pick) } });
}

function evaluate(payload, env, opts) {
  const out = io.recorder();
  try { main(payload, env || process.env, (opts && opts.argv) || [], out); } catch (_) { /* fail open */ }
  return out.done(0);
}

module.exports = { evaluate };

if (require.main === module) io.runCli(evaluate);
