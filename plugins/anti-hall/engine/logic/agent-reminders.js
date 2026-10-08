// check = "agent-reminders" (UserPromptSubmit and PostToolUse; engine-only, no Node twin). The agent tracker (ah-engine, job
// agent_tick) queues reminders and advisories in <state>/agent-tracker/reminders/<agent or session id>.ndjson. This check puts the
// ones not yet taken in front of the agent that owns the queue, at its next hook event, and records the delivery so the tracker can
// measure whether reminders work. A queue is append-only for the tracker; this check only advances a line cursor beside it.
// Every name, limit and text is a setting (agent_tracker.toml), read through ah.cfg. It fails open: a problem delivers nothing.
'use strict';

function arSafe(id) {
  var max = ah.cfg('agent_reminders.key_max'), out = '';
  for (var i = 0; i < id.length && i < max; i++) out += /[A-Za-z0-9._-]/.test(id.charAt(i)) ? id.charAt(i) : '_';
  return out;
}

function decide(p) {
  if (p === null || typeof p !== 'object') return 'allow';
  var f = ah.cfg('agent_reminders.fields'), event = typeof p[f.event] === 'string' ? p[f.event] : '';
  if (ah.cfg('agent_reminders.events').indexOf(event) < 0) return 'allow';
  if (!ah.settings.bool('agent_tracker.remind_setting') || ah.settings.skipped(ah.cfg('agent_reminders.guard_name'))) return 'allow';
  var key = typeof p[f.agent] === 'string' && p[f.agent] !== '' ? p[f.agent] : (typeof p[f.session] === 'string' ? p[f.session] : '');
  if (key === '') return 'allow';
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null) home = ah.env.get(ah.cfg('env.home_alt'));
  if (!home) return 'allow';
  var paths = ah.cfg('agent_tracker.paths');
  var dir = ah.cfg('paths.base_dir') + '/' + paths.dir, name = arSafe(key);
  var queue = dir + '/' + paths.reminders + '/' + name + paths.queue_ext, cursor = queue + paths.cursor_ext;
  var size = ah.fs.size(ah.path.join(home, queue));
  if (size === null || size === 0) return 'allow';
  var raw = ah.fs.readText(ah.path.join(home, queue));
  if (raw === null) return 'allow';
  var lines = raw.split('\n').filter(function (l) { return l !== ''; });
  var taken = 0, cur = ah.fs.readText(ah.path.join(home, cursor));
  if (cur !== null && /^\s*[0-9]+\s*$/.test(cur)) taken = parseInt(cur, 10);
  if (taken >= lines.length) return 'allow';
  var limit = ah.cfg('agent_tracker.spam').max_per_delivery, items = [], rows = [];
  for (var i = taken; i < lines.length && items.length < limit; i++) {
    taken = i + 1;
    var r;
    try { r = JSON.parse(lines[i]); } catch (e) { continue; }
    if (r === null || typeof r !== 'object' || typeof r.text !== 'string') continue;
    items.push(r.text);
    rows.push(JSON.stringify({ id: r.id, key: name, signal: r.signal, agent: r.agent, ts: Date.now() }));
  }
  if (!ah.state.writeAtomic(cursor, String(taken))) return 'allow';
  if (items.length === 0) return 'allow';
  ah.state.appendFile(dir + '/' + paths.delivered, rows.join('\n') + '\n');
  return { advisory: ah.cfg('agent_reminders.header') + '\n' + items.join('\n') };
}
