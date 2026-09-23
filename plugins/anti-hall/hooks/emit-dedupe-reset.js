#!/usr/bin/env node
// anti-hall :: emit-dedupe-reset (SessionStart, ALL sources — no matcher)
//
// lib/emit-dedupe.js suppresses UserPromptSubmit blocks the model already
// received (an unchanged WORKSPACES table / ORPHANED MESH banner, or a copy still
// waiting in the same queued delivery). After a context loss — /compact keeps the
// SAME session_id and transcript_path; /clear, resume and startup begin a new
// context — the model no longer holds those blocks, so this hook writes a
// per-session reset marker { resetAt } and every record emitted before it is
// treated as absent: the next invocation re-emits even an unchanged block.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { session_id, transcript_path, cwd, source, hook_event_name }
//   stdout : nothing (state-only hook, no context injected)
//   exit 0 : always — fail-open on any error, never blocks session start.
// Pure Node built-ins.

'use strict';

const fs = require('fs');
const os = require('os');

try {
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')) || {}; } catch (_) { payload = {}; }
  const sessionId = payload && payload.session_id != null ? String(payload.session_id) : '';
  if (sessionId) {
    require('./lib/emit-dedupe.js').resetSession({ home: os.homedir(), sessionId });
  }
} catch (_) {
  // Fail-open.
}
process.exit(0);
