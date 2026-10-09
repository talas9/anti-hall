'use strict';
// emitBlock(reason, jsonObj?) — the one exit-2 block for a PreToolUse guard that
// both hosts honor. Writes jsonObj (default { decision: 'block', reason }) to
// stdout, the same reason to stderr, then exits 2.
//
// Codex reads stdout JSON only on exit 0; on exit 2 it takes the reason from
// stderr, and an empty stderr makes it record a failed hook and let the tool call
// through (codex-rs/hooks/src/events/pre_tool_use.rs, rust-v0.160.0). Claude Code
// shows the JSON blocking decision's reason when there is one, stderr otherwise
// (code.claude.com/docs/en/hooks, "Exit code 2"), so the identical stderr text
// leaves Claude's message unchanged.
//
// fs.writeSync, not process.stdout/stderr.write: an exit right after an async pipe
// write can truncate large output on macOS.

const fs = require('fs');

function emitBlock(reason, jsonObj) {
  const text = String(reason);
  try { fs.writeSync(1, JSON.stringify(jsonObj || { decision: 'block', reason: text }) + '\n'); } catch (_) { /* still block */ }
  try { fs.writeSync(2, text + '\n'); } catch (_) { /* still block */ }
  process.exit(2);
}

module.exports = { emitBlock };
