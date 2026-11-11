// Quiet scheduled turns (#709 PR-C), included by the registered parent-inbox check.
// The static Rust check registry cannot register a new name from TOML. The dispatch alias is mutually exclusive with
// parent-inbox, and both use this helper. This cannot silence other checks or prove host block avoids a model call.
// Native queue imports (--child), unread/unknown mail, live children and incomplete tick effects always fail open.
'use strict';
function igJson(path) {
  var raw = ah.fs.readText(path, ah.cfgNum('idle_gate.read_bytes'));
  if (raw === null || ah.fs.size(path) > ah.cfgNum('idle_gate.read_bytes')) return null;
  try { var v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; }
}
function igStable(v) {
  if (Array.isArray(v)) return '[' + v.map(igStable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + igStable(v[k]); }).join(',') + '}';
  return JSON.stringify(v);
}
function igPick(v, fields) {
  var out = {};
  fields.forEach(function (f) { if (Object.prototype.hasOwnProperty.call(v, f)) out[f] = v[f]; });
  return out;
}
function idleGate(p) {
  try { return igDecide(p); } catch (e) { return null; } // uncertainty keeps all normal behavior
}
function igDecide(p) {
  if (!ah.settings.bool('idle_gate.sw') || !p || !p.session_id || typeof p.cwd !== 'string') return null;
  var tp = p.transcript_path, prompt = p.prompt;
  if (!dedupe.scheduledTurn(tp, prompt)) return null;
  if (ah.re.test(ah.cfg('idle_gate.unsafe_pattern'), 'i', prompt)) return null;
  if (!ah.cfg('idle_gate.roster_only_patterns').some(function (re) { return ah.re.test(re, 'i', prompt); })) return null;
  var mailbox = new RegExp(ah.cfg('idle_gate.mailbox_pattern'), 'i').exec(prompt);
  if (!mailbox && !ah.settings.bool('idle_gate.owner_cron_opt_in')) return null;
  var tail = ah.fs.readTail(tp, ah.cfgNum('emit_dedupe.tail_bytes_wide'));
  if (tail === null) return null;
  var record = null;
  tail.split('\n').forEach(function (line) {
    try { var r = JSON.parse(line); if (r.type === ah.cfg('emit_dedupe.origin_record_type')) {
      var content = r.message && r.message.content;
      var resultOnly = Array.isArray(content) && content.length > 0 && content.every(function (b) { return b && b.type === ah.cfg('emit_dedupe.tool_result_block_type'); });
      if (!resultOnly) record = r;
    } } catch (e) { /* incomplete line is not proof */ }
  });
  if (!record || typeof record[ah.cfg('idle_gate.scheduled_task_key')] !== 'string' || !record[ah.cfg('idle_gate.scheduled_task_key')]) return null;
  var job = record[ah.cfg('idle_gate.scheduled_task_key')];
  var rel = ah.cfg('idle_gate.state_dir') + '/' + ah.sha1(String(p.session_id) + '\0' + job) + ah.cfg('mesh_write.json_suffix');
  var previous = dedupe.readState(rel);
  // An intervening changed/unread/unknown tick invalidates its prior clean baseline. Never persist an unproven fingerprint.
  ah.commit();
  if (!ah.state.writeAtomic(rel, '{}')) return null;
  var home = spawn.osHome(), identity = ah.mesh.repoKeyDetail(p.cwd);
  if (!home || identity.unsure || !identity.key) return null;
  var base = home + '/' + ah.cfg('devswarm_role.pg_devswarm_dir');
  var summary = igJson(base + '/' + ah.cfg('mesh_write.dir_summaries') + '/' + identity.key + ah.cfg('mesh_write.json_suffix'));
  if (!summary || !summary.workspaces || Array.isArray(summary.workspaces)) return null;
  if (summary.meshGapWithheld || summary.meshGap) return null;
  var rows = {}, ids = Object.keys(summary.workspaces).sort(), tickId = mailbox ? mailbox[1] : null;
  if (tickId && ids.indexOf(tickId) < 0) return null;
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i], row = summary.workspaces[id];
    if (!row || typeof row !== 'object' || row.unread !== 0 || row.directUnread > 0 || row.meshGapWithheld) return null;
    // Live-child ticks may need watcher rearming or native imports. Until those primitives are exposed, let them run.
    if (id !== tickId && ah.cfg('idle_gate.closed_statuses').indexOf(row.status) < 0) return null;
    var desc = igJson(base + '/' + ah.cfg('mesh_write.dir_workspaces') + '/' + id + ah.cfg('mesh_write.json_suffix'));
    if (!desc || typeof desc.inboxPath !== 'string' || typeof desc.cursorPath !== 'string') return null;
    var count = ah.mesh.countFor(identity.key, id, desc.inboxPath, desc.cursorPath, ah.clock.now());
    if (count.unsure || !count.known || count.unread !== 0) return null;
    rows[id] = igPick(row, ah.cfg('idle_gate.fingerprint_fields'));
  }
  var tasks = tk.tasksOf(home, p.session_id, tp, 'guard'), agents = ah.transcript.agentsWindow(tp);
  if (!tasks || tasks.unsure || tasks.unreadable || !agents || agents.unsure || !Array.isArray(agents.rows) || agents.rows.length) return null;
  if (p.background_tasks !== undefined && (!Array.isArray(p.background_tasks) || p.background_tasks.length)) return null;
  var now = ah.clock.now(), marker = null, beat = null, markerRel = null, beatRel = null;
  if (tickId) {
    markerRel = ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('mesh_write.dir_wake_tick') + '/' + tickId + ah.cfg('mesh_write.json_suffix');
    beatRel = ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('mesh_write.dir_heartbeats') + '/' + tickId + ah.cfg('mesh_write.json_suffix');
    marker = igJson(home + '/' + markerRel); beat = igJson(home + '/' + beatRel);
    if (!marker || marker.known !== true || marker.unreadTotal !== 0 || marker.meshGapWithheld || !beat) return null;
  }
  var storage = ah.env.get(ah.cfg('env.dir')) || home + '/' + ah.cfg('paths.base_dir') + '/' + ah.cfg('paths.state_dir');
  if (ah.fs.readHeadHex(storage + '/' + ah.cfg('storage.hot_file'), ah.cfgNum('idle_gate.sqlite_header_bytes')) !== ah.cfg('idle_gate.sqlite_header_hex')) return null;
  var facts = { prompt: ah.sha1(prompt), project: igPick(summary, ah.cfg('idle_gate.summary_fields')), children: rows, tasks: tasks.tasks, blocks: ah.sessionBlocks(p.session_id).current, background: p.background_tasks || [] };
  var hash = ah.sha1(igStable(facts)), age = now - previous.normalAt;
  var quiet = previous.hash === hash && age >= 0 && age < ah.cfgNum('idle_gate.max_quiet_s') * ah.cfgNum('idle_gate.ms_per_s');
  ah.commit();
  if (!ah.state.writeAtomic(rel, JSON.stringify({ hash: hash, normalAt: quiet ? previous.normalAt : now }))) return null;
  if (!quiet) return null;
  // Preserve the existing no-mail tick's marker and heartbeat, without inventing a watcher arm or importing native mail.
  if (tickId) {
    marker.ts = now; beat.ts = now; beat.state_ts = now;
    if (!ah.state.writeAtomic(markerRel, JSON.stringify(marker)) || !ah.state.writeAtomic(beatRel, JSON.stringify(beat))) return null;
  }
  ah.metric('waste_events_total', ['category', ah.cfg('idle_gate.category'), 'source', ah.cfg('idle_gate.source')]);
  var directive = ah.cfg('idle_gate.msg_one_line');
  if (ah.settings.enum('idle_gate.mode') === 'block') return { exact: { code: 0, out: text.render(ah.cfg('idle_gate.block_line'), { reason: JSON.stringify(directive) }), err: '' } };
  return { advisory: text.advisoryJson(ah.cfg('idle_gate.event'), directive) };
}
