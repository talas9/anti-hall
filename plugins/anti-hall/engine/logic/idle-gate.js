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
// Read every record, not the live-only agent index: terminal agents and queued attachments still need a turn.
function igTurn(tp, prompt) {
  var scan = ah.transcript.grep(tp, ah.cfgNum('emit_dedupe.tail_bytes_wide'), [], '', '');
  if (!scan || scan.unsure || !Array.isArray(scan.lines)) return null;
  var anchor = false, unsafe = false, malformed = false, record = null, tickUses = {};
  scan.lines.forEach(function (line) {
    if (!line.trim()) return;
    var r;
    try { r = JSON.parse(line); } catch (e) { malformed = true; return; }
    if (!r || typeof r !== 'object') { malformed = true; return; }
    var content = r.message && r.message.content;
    if (r.isSidechain || r.attachment !== undefined || r.attachments !== undefined || (r.message && r.message.attachments !== undefined)) { unsafe = true; return; }
    if (r.type === ah.cfg('emit_dedupe.assistant_record_type')) {
      if (Array.isArray(content) && content.some(function (b) { return !b || (b.type !== ah.cfg('transcript.ev_type_text') && b.type !== ah.cfg('transcript.ev_type_tool_use')); })) { unsafe = true; return; }
      var uses = Array.isArray(content) ? content.filter(function (b) { return b && b.type === ah.cfg('transcript.ev_type_tool_use'); }) : [];
      if (!uses.length) {
        var textBody = typeof content === 'string' ? content : Array.isArray(content) ? content.map(function (b) { return b && typeof b.text === 'string' ? b.text : ''; }).join('') : '';
        if (!textBody.trim() || (Array.isArray(content) && content.some(function (b) { return !b || b.type !== ah.cfg('transcript.ev_type_text'); }))) { unsafe = true; return; }
        anchor = true; unsafe = false; tickUses = {};
      }
      uses.forEach(function (b) {
        var command = b.input && typeof b.input.command === 'string' ? new RegExp(ah.cfg('idle_gate.mailbox_pattern'), 'i').exec(b.input.command) : null;
        if (command && b.input.command.trim() === prompt.trim() && typeof b.id === 'string') tickUses[b.id] = command[1];
        else unsafe = true;
      });
      return;
    }
    if (!anchor) return;
    if (r.type !== ah.cfg('emit_dedupe.origin_record_type')) { unsafe = true; return; }
    var resultOnly = Array.isArray(content) && content.length > 0 && content.every(function (b) { return b && b.type === ah.cfg('emit_dedupe.tool_result_block_type'); });
    if (resultOnly) {
      content.forEach(function (b) {
        var out = typeof b.content === 'string' ? b.content : '';
        var match = new RegExp(ah.cfg('idle_gate.tick_output_pattern')).exec(out);
        if (!tickUses[b.tool_use_id] || b.is_error || !match || match[1] !== tickUses[b.tool_use_id] || Number(match[2]) !== 0 || match[3] !== ah.cfg('mesh_write.js_true') || match[4] !== ah.cfg('mesh_write.js_false')) unsafe = true;
        delete tickUses[b.tool_use_id];
      });
      return;
    }
    if (Array.isArray(content) && content.some(function (b) { return !b || b.type !== ah.cfg('transcript.ev_type_text'); })) { unsafe = true; return; }
    var body = typeof content === 'string' ? content : Array.isArray(content) ? content.map(function (b) { return b && typeof b.text === 'string' ? b.text : ''; }).join('') : '';
    if (ah.cfg('emit_dedupe.uncounted_origins').indexOf(r[ah.cfg('emit_dedupe.origin_field')]) < 0 || body.trim() !== prompt.trim()) unsafe = true;
    record = r;
  });
  return anchor && !unsafe && !malformed && !Object.keys(tickUses).length ? record : null;
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
  var record = igTurn(tp, prompt);
  if (!record || typeof record[ah.cfg('idle_gate.scheduled_task_key')] !== 'string' || !record[ah.cfg('idle_gate.scheduled_task_key')]) return null;
  var job = record[ah.cfg('idle_gate.scheduled_task_key')];
  var rel = ah.cfg('idle_gate.state_dir') + '/' + ah.sha1(String(p.session_id) + '\0' + job) + ah.cfg('mesh_write.json_suffix');
  var baseline = ah.state.readText(rel), previous = {};
  if (baseline !== null) {
    try { previous = JSON.parse(baseline); } catch (e) { return null; }
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return null;
    if (Object.keys(previous).length && (typeof previous.hash !== 'string' || typeof previous.normalAt !== 'number' || !isFinite(previous.normalAt))) return null;
  }
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
    // The summary has no per-sibling mailbox freshness proof. A live count cannot validate its cached sibling facts.
    if (id !== tickId && ah.cfg('idle_gate.closed_statuses').indexOf(row.status) < 0) return null;
    if (id !== tickId) return null;
    var desc = igJson(base + '/' + ah.cfg('mesh_write.dir_workspaces') + '/' + id + ah.cfg('mesh_write.json_suffix'));
    if (!desc || typeof desc.inboxPath !== 'string' || typeof desc.cursorPath !== 'string') return null;
    var count = ah.mesh.countFor(identity.key, id, desc.inboxPath, desc.cursorPath, ah.clock.now());
    if (count.unsure || !count.known || count.unread !== 0) return null;
    rows[id] = igPick(row, ah.cfg('idle_gate.fingerprint_fields'));
  }
  var tasks = tk.tasksOf(home, p.session_id, tp, 'guard'), agents = ah.transcript.agentsWindow(tp);
  if (!tasks || tasks.unsure || tasks.unreadable || !agents || agents.unsure || !Array.isArray(agents.rows) || agents.rows.length) return null;
  if (!Array.isArray(tasks.tasks) || tk.unknownIds(tasks.tasks).length) return null;
  if (ah.cfg('idle_gate.reject_actionable_tasks') && tasks.tasks.some(function (t) {
    if (!tk.isOpen(t) || tk.blockedOnText(t)) return false;
    var blocked = (t.blockedBy || []).some(function (id) { return tasks.tasks.some(function (other) { return String(other.id) === String(id) && tk.isOpen(other); }); });
    return !blocked; // all live agents already disqualify this gate, so no live owner can cover this task
  })) return null;
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
