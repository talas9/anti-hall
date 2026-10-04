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

const fs = require('fs');

function main() {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  if (!payload || payload.tool_name !== 'Bash') return;
  const cmd = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : '';
  const sid = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (!cmd || !sid) return;
  try { if (require('./lib/settings.js').get('guards', 'mergeSidePickAdvisory') === false) return; } catch (_) { /* default on */ }
  try { if (require('./skip-guard.js').isSkipped('merge-side-pick')) return; } catch (_) { /* fail open */ }
  const lib = require('./lib/merge-side-pick.js');
  const home = require('../companion/lib/test-home-guard.js').resolveHome(undefined, process.env);
  if (payload.hook_event_name === 'PostToolUse' || process.argv.includes('--post')) {
    lib.record(home, sid, cmd);
    return;
  }
  const pick = lib.pushCheck(home, sid, cmd);
  if (!pick) return;
  fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lib.advisory(pick) } }) + '\n');
}

try { main(); } catch (_) { /* fail open */ }
process.exit(0);
