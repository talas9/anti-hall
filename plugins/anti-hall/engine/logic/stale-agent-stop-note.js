// check = "stale-agent-stop-note" (PreToolUse on TaskStop; advisory only, never blocks). When TaskStop names an agent that the
// transcript shows was sent a message (a teammate's inbox) or resumed (a background agent) after its last report, with no report
// since, one line says so: the agent may be working, and a report the coordinator read earlier describes the state before the
// message. It says nothing when the state is unknown. The scan is ah.transcript.agentScan (the pending messages, the launched
// agents and the terminal ids; a TaskStop with no result yet is not counted). A relative transcript path is read from the hook
// process's directory (lib/78-hook-proc.js); a transcript the host cannot read exactly as JavaScript would says nothing (the
// state is unknown; logged). Mirrors hooks/stale-agent-stop-note.js.
// Keys and texts: agent_controls.toml (stale_note.*).
'use strict';

function sanHhmm(ms) { return new Date(ms).toISOString().slice(11, 16) + ' UTC'; }

function sanOneLine(s, max) {
  var o = String(s).replace(new RegExp(ah.cfg('stale_note.control_re'), 'g'), ' ').replace(/\s+/g, ' ').trim();
  if (o.length > max) o = o.slice(0, max).trimEnd() + ah.cfg('stale_note.ellipsis');
  return o;
}

function sanNum(v) { return typeof v === 'number' && isFinite(v); }

function sanNote(scan, taskId, now) {
  if (!taskId) return null;
  var guard = ah.cfg('stale_note.guard_name'), max = ah.cfgNum('stale_note.name_max'), pm = null, i;
  for (i = 0; i < scan.pending.length; i++) {
    var q = scan.pending[i];
    if (q.name === taskId || (q.agentId && q.agentId === taskId)) { pm = q; break; }
  }
  if (pm) {
    var last = sanNum(pm.lastIdleMs) ? text.render(ah.cfg('stale_note.msg_pending_last'), { time: sanHhmm(pm.lastIdleMs) }) : '';
    var seen = sanNum(pm.lastSeenMs) && sanNum(pm.sentAtMs) && pm.lastSeenMs > pm.sentAtMs
      ? text.render(ah.cfg('stale_note.msg_pending_seen'), { min: String(Math.max(0, Math.round((now - pm.lastSeenMs) / 60000))) }) : '';
    // built piece by piece: a name that holds `{time}` must not be filled in a second time
    var what = '"' + sanOneLine(pm.name, max) + '"' + ah.cfg('stale_note.msg_pending_a') + sanHhmm(pm.sentAtMs) + ah.cfg('stale_note.msg_pending_b') + last +
      ah.cfg('stale_note.msg_pending_c');
    return text.message('warn', guard, { what: what, why: ah.cfg('stale_note.msg_pending_why') + seen, instead: ah.cfg('stale_note.msg_instead') });
  }
  var rec = null;
  for (i = 0; i < scan.launched.length; i++) if (scan.launched[i].id === taskId) { rec = scan.launched[i]; break; }
  if (rec && !rec.teammate && scan.terminal.indexOf(taskId) < 0 && sanNum(rec.resumedAtMs) && rec.resumedAtMs > 0) {
    var what2 = '"' + sanOneLine(taskId, max) + '"' + ah.cfg('stale_note.msg_resumed_a') + sanHhmm(rec.resumedAtMs) + ah.cfg('stale_note.msg_resumed_b');
    return text.message('warn', guard, { what: what2, why: ah.cfg('stale_note.msg_resumed_why'), instead: ah.cfg('stale_note.msg_instead') });
  }
  return null;
}

function decide(p) {
  if (!ah.settings.bool('stale_note.setting')) return 'allow';
  if (p === null || typeof p !== 'object' || Array.isArray(p) || p.tool_name !== ah.cfg('stale_note.tool')) return 'allow';
  var ti = p.tool_input, taskId = ti && ti.task_id, tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
  if (typeof taskId !== 'string' || !taskId || !tp) return 'allow';
  var scan = ah.transcript.agentScan(hookProc.open(p, tp), ah.cfgNum('stale_note.scan_bytes'), true);
  if (scan === null) return 'allow';
  if (scan.unsure) { ah.log('stale_note_scan_unsure', tp); return 'allow'; }
  var t = sanNote(scan, taskId, ah.clock.now());
  return t === null ? 'allow' : { advisory: text.advisoryJson('PreToolUse', t) };
}
