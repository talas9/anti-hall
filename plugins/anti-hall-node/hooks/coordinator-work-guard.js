#!/usr/bin/env node
'use strict';
// coordinator-work-guard.js — the main-thread WORK window (coordinator-drift F1).
//
// PreToolUse Bash:            block a blockable WORK call when the session's
//                             window already holds blockAt - 1 WORK calls.
// PostToolUse Bash (--post):  record the call (WORK or not) in the window;
//                             one COORDINATOR DRIFT note per crossing of
//                             nudgeAt; then fold stale session files.
//
// WORK = command-guard classifyBashWork (state-changing git, gh mutations,
// Bash writes into non-notes repo files, script-file runs, inline code).
// Recovery commands and loosely matched inline code count but are never
// blocked. Main thread only (isCoordinator), Claude host only. Off with
// command-guard (safety.commandGuard off, or a command-guard skip), the same
// gate as command-guard's heavy check. The Pre verdict is stored by
// tool_use_id and reused at Post (the command may delete its own script).
// Settings:
// guards.coordinatorWorkWindowMinutes (0 = off), coordinatorWorkNudgeAt,
// coordinatorWorkBlockAt, coordinatorWorkMaxEntries. Skip key:
// coordinator-work-guard. Fail-open on every error.
const io = require('./lib/guard-io.js');

const GUARD = 'coordinator-work-guard';

function main(payload, env, argv, out) {
  if (!payload || typeof payload !== 'object' || payload.tool_name !== 'Bash') return 0;
  const sid = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (!sid) return 0;
  if (!require('./coordinator-detect.js').isCoordinator(payload, env)) return 0;
  if (require('./skip-guard.js').isSkipped('command-guard', env)) return 0;
  try { if (!require('./lib/settings.js').enabled('safety', 'commandGuard', require('./lib/settings.js').envOpts(env))) return 0; } catch (_) { /* run */ }
  const lib = require('./lib/coordinator-work.js');
  const cfg = lib.config(env);
  if (!cfg.tMs) return 0;
  const command = payload.tool_input && typeof payload.tool_input.command === 'string' ? payload.tool_input.command : '';
  const home = io.homeOf(env);
  const now = Date.now();
  const st = lib.readState(home, sid);
  const id = typeof payload.tool_use_id === 'string' && payload.tool_use_id && command.trim() ? payload.tool_use_id : '';
  const classify = () => (lib.provablyNotWork(command) || lib.isDevswarmBookkeeping(command)
    ? { work: false, blockable: false }
    : require('./command-guard.js').classifyBashWork(command, payload, { sessionStartTs: lib.sessionStart(st, now), env }));
  const skipped = () => require('./skip-guard.js').isSkipped(GUARD, env);

  if (!argv.includes('--post')) {
    const r = classify();
    const v = { work: r.work, blockable: r.blockable };
    const pre = lib.checkPre(st, { now, work: r.work, blockable: r.blockable }, cfg);
    if (!pre.wouldBlock) {
      if (id) lib.update(home, sid, (s) => { lib.rememberPre(s, id, v); });
      return 0;
    }
    if (skipped()) {
      lib.update(home, sid, (s) => { s.skippedWouldBlock++; if (id) lib.rememberPre(s, id, v); });
      lib.logTrip(home, { event: 'skipped', count: pre.count });
      return 0;
    }
    lib.update(home, sid, (s) => { s.blocks++; s.lastBlockAt = now; });
    lib.bumpMetrics(home, (m) => { m.blocks++; });
    lib.logTrip(home, { event: 'block', count: pre.count });
    const reason = lib.BLOCK(pre.count, cfg, require('./lib/skip-cmd.js').skipCommand(GUARD));
    out.json({ decision: 'block', reason });
    return 2;
  }

  const stored = id && st ? lib.takePre(st, id) : null;
  const work = stored ? stored.work : classify().work;
  let crossing = null;
  lib.update(home, sid, (s) => {
    if (id) lib.takePre(s, id);
    crossing = lib.stepPost(s, { now, work }, cfg).crossing;
  });
  if (crossing && cfg.nudgeAt > 0 && !skipped()) {
    lib.bumpMetrics(home, (m) => { m.nudges++; });
    lib.logTrip(home, { event: 'nudge', count: crossing.count });
    out.json({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lib.NUDGE(crossing.count, cfg) } });
  }
  lib.foldStale(home, now);
  return 0;
}

function evaluate(payload, env, opts) {
  const out = io.recorder();
  let code = 0;
  try { code = main(payload, env || process.env, (opts && opts.argv) || [], out); } catch (_) { code = 0; }
  return out.done(code === 2 ? 2 : 0);
}

module.exports = { evaluate };

if (require.main === module) io.runCli(evaluate);
