// check = "phase-tracker" (PreToolUse on Agent and Task). The hook never decides anything: it records each subagent spawn so the
// statusline can show live swarm activity. It appends a timestamp and a per-session tag to the spawn log (keeping the last few
// minutes of every session's lines) and rewrites the rolling heartbeat file. Both writes are best effort; the answer is always
// "allow, say nothing" (never a deferral once something was written: Node would record the spawn a second time).
// Mirrors hooks/phase-tracker.js. A payload whose working directory is not a string defers (Node would hash its JavaScript
// string form). Keys: spawn_context.toml (phase_tracker.*).
'use strict';

function ptTruthy(v) { return !!v; }

// The session id, else a short hash of the working directory, else the unknown tag; null when Node's answer cannot be reproduced.
function ptTag(p) {
  var raw = '';
  var data = p !== null && typeof p === 'object' ? p : null;
  if (data !== null && typeof data.session_id === 'string' && data.session_id.trim()) {
    raw = data.session_id.trim();
  } else if (data !== null) {
    var cwd = data.cwd || (data.workspace && data.workspace.current_dir) || '';
    if (cwd) {
      if (typeof cwd !== 'string') return null;
      raw = ah.cfg('phase_tracker.cwd_tag_prefix') + ah.sha1(cwd).slice(0, ah.cfgNum('phase_tracker.cwd_hash_len'));
    }
  }
  var clean = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, ah.cfgNum('phase_tracker.tag_max'));
  return clean || ah.cfg('phase_tracker.unknown_tag');
}

function decide(p) {
  var home = spawn.osHome();
  if (home === null) return 'defer';
  var tag = ptTag(p);
  if (tag === null) return 'defer';
  var now = ah.clock.now();
  var root = ah.cfg('spawn_ctx.state_root');
  var logRel = root + '/' + ah.cfg('phase_tracker.log_file'), logPath = home + '/' + logRel;
  var lines = [], keep = ah.cfgNum('phase_tracker.keep_ms'), old = '', readable = true;
  var kind = ah.fs.kind(logPath);
  if (kind !== null) {
    old = kind === 'dir' ? null : ah.fs.readText(logPath);
    readable = old !== null;
  }
  if (readable) {
    lines = old.trim().split(/\r?\n/).filter(function (l) { var ms = parseInt(l, 10); return isFinite(ms) && (now - ms) < keep; });
    lines.push(Math.floor(now) + ' ' + tag);
    try { ah.state.writeAtomic(logRel, lines.join('\n') + '\n'); } catch (e) { return 'defer'; } // refused before anything was written
  }
  try { ah.state.writeAtomic(root + '/' + ah.cfg('phase_tracker.agents_dir') + '/' + ah.cfg('phase_tracker.heartbeat_file'), '{"ts":' + Math.floor(now) + '}'); } catch (e) { /* best effort, as in Node */ }
  return 'allow';
}
