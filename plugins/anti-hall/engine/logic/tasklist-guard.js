// check = "tasklist-guard" (Stop; mirrors hooks/tasklist-guard.js). Blocks a Stop when real work was done and was not tracked as tasks,
// a task is stalled in progress, or the per-session progress file is missing or stale. Answers every Stop as Node does: the quiet
// ones with the file effects Node has there (the progress directory made, the progress and history indexes kept, the one
// resume-verification nudge and its marker), the plan-mode advisory, and the block itself with its loop state, dedupe and cap,
// handover advisories, stop-policy budget, acknowledgement and Jev consult. The task part of the transcript pass is the engine's
// (ah.transcript.tasks, variant scan); the work counting is wd (lib/72-workdetect.js). Anything this script cannot reproduce exactly
// (a form only V8 reads, a cut through a surrogate pair, a relative working directory) is decided before the first effect and
// deferred to the Node hook. Keys and texts: task_guards.toml and agent_controls.toml (tasklist_guard.*, workdetect.*, taskkit.*).
'use strict';

function tlN(k) { return ah.cfgNum('tasklist_guard.' + k); }
function tlT(k) { return ah.cfg('tasklist_guard.' + k); }

// `sanitizeReason(s)`: controls become spaces (newlines survive), runs of blanks collapse, blanks around a newline go, the text is
// trimmed and cut with an ellipsis; null when the cut would split a surrogate pair.
function tlSanitize(s) {
  var t = s.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
  var max = tlN('reason_max');
  if (t.length > max) {
    var cut = t.slice(0, max), last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) return null;
    return cut.replace(/\s+$/, '') + '…';
  }
  return t;
}

function tlJoin(root, segs) { return root + '/' + segs.join('/'); }

// `maintainSessionIndex(root, date, sid, kind)`: one line per session in <root>/.anti-hall/<kind>/INDEX.md, unless the index already
// mentions the session.
function tlIndex(root, date, sid, kind) {
  var rel = ah.cfg('paths.base_dir') + '/' + kind + '/' + ah.cfg('task_lifecycle_log.index_file');
  var f = jx.read(root + '/' + rel);
  if (f.text !== undefined && f.text.indexOf(sid) >= 0) return;
  if (f.big) return;
  var sep = ah.cfg('task_lifecycle_log.separator');
  try { ah.state.op(root, 'append', rel, '- ' + date + sep + sid + sep + '[' + kind + '](../' + date + '/' + sid + '.md)\n'); } catch (e) { /* every failure stops quietly */ }
}

function tlFresh(ts, lastWork, freshMs, now) {
  if (!isFinite(ts) || ts <= 0) return false;
  if (lastWork > 0) return lastWork <= ts + tlN('fresh_grace_ms');
  return now - ts <= freshMs;
}

// `commandWritesToPath(cmd, target)`: a redirect whose target is exactly `target`, or a tee, cp or mv whose last argument is.
function tlWritesTo(cmd, target) {
  if (!target) return false;
  var m = /(?<![0-9&])>{1,2}(?!&)\s*("[^"]*"|'[^']*'|\S+)/.exec(cmd);
  if (m) {
    var raw = m[1].replace(/^["']/, '').replace(/["']$/, '');
    if (raw === target) return true;
  }
  var t = /\b(?:tee|cp|mv)\b[^;&|\n]*/.exec(cmd);
  if (!t) return false;
  var parts = t[0].split(/\s+/).filter(function (x) { return x && x.charAt(0) !== '-'; });
  return parts.length > 0 && parts[parts.length - 1] === target;
}

// The tool uses inside an entry (`collectToolUses`).
function tlToolUses(node, out) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  if (node.type === 'tool_use' && node.name) out.push(node);
  var keys = ah.cfg('taskstate.tools_collect_keys');
  for (var i = 0; i < keys.length; i++) {
    var v = node[keys[i]];
    if (Array.isArray(v)) v.forEach(function (it) { tlToolUses(it, out); });
    else if (v !== null && typeof v === 'object') tlToolUses(v, out);
  }
}

// The work counting of the transcript pass: {work, lastWork, lastProgressWrite}, 'quiet' (a JSON null entry makes the Node hook
// throw, so it decides nothing) or 'defer'.
function tlScanWork(path, progressAbs, cx) {
  var out = { work: 0, lastWork: 0, lastProgressWrite: 0 };
  var lines = rp.lines(path, tlN('window_bytes'));
  if (lines === null) return out;
  // a session with ONE user request: a write under a path that request names is the requested output (workdetect.request_path_re)
  var size = ah.fs.size(path);
  cx.requested = wd.requestedPaths(lines, cx, size !== null && size <= tlN('window_bytes'));
  for (var i = 0; i < lines.length; i++) {
    // only an entry that holds a tool use (or an escape that could spell one), and a bare `null`, can matter to the work count
    var raw = lines[i];
    if (raw.indexOf('tool_use') < 0 && raw.indexOf('\\u') < 0 && raw.indexOf('null') < 0) continue;
    var t = raw.trim();
    if (!t) continue;
    var r = jx.parse(t);
    if (r.unsure) return 'defer';
    if (r.invalid) continue;
    var entry = r.v;
    if (entry === null) return 'quiet';
    var ts = null;
    if (entry !== undefined && typeof entry.timestamp === 'string') {
      var ms = jx.isoMs(entry.timestamp);
      if (ms === undefined) return 'defer';
      ts = isNaN(ms) ? null : ms;
    }
    var uses = [];
    tlToolUses(entry, uses);
    for (var u = 0; u < uses.length; u++) {
      var tu = uses[u], name = typeof tu.name === 'string' ? tu.name : '';
      if (ah.cfg('workdetect.mutating_tools').indexOf(name) >= 0) {
        var fp = tu.input && typeof tu.input.file_path === 'string' ? tu.input.file_path : '';
        if (wd.counted(tu, cx)) { out.work++; if (ts !== null && ts > out.lastWork) out.lastWork = ts; }
        if (progressAbs && ts !== null && fp === progressAbs && ts > out.lastProgressWrite) out.lastProgressWrite = ts;
      } else if (name === 'Bash') {
        var cmd = tu.input && typeof tu.input.command === 'string' ? tu.input.command : '';
        if (wd.counted(tu, cx)) { out.work++; if (ts !== null && ts > out.lastWork) out.lastWork = ts; }
        if (progressAbs && ts !== null && cmd && wd.bashWork(wd.neutralize(cmd)) && tlWritesTo(cmd, progressAbs) && ts > out.lastProgressWrite) out.lastProgressWrite = ts;
      }
    }
  }
  return out;
}

// `checkResumeVerification`: the nudge text when a resumed handover was never verified, after recording that it was sent; null defers.
// A state stamp lands only once the reply was delivered (an undelivered nudge/block stays unsent and is sent again).
function tlStamp(home, rel, text) { return ah.state.op(home, 'after_reply', rel, text); }

function tlResume(home, sid, work, threshold, now) {
  if (!home || !sid || work < threshold) return '';
  var base = ah.cfg('paths.base_dir');
  var f = jx.read(home + '/' + base + '/' + tlT('resume_marker_prefix') + sid + '.json');
  if (f.big) return null;
  if (f.text === undefined) return '';
  var m = jx.parse(f.text);
  if (m.unsure) return null;
  if (m.invalid || !m.v || typeof m.v.handoverFile !== 'string' || !m.v.handoverFile) return '';
  var h = jx.read(m.v.handoverFile);
  if (h.text === undefined) return h.big ? null : '';
  if (h.text.indexOf(tlT('resume_verified_marker')) >= 0) return '';
  var firedRel = base + '/' + tlT('resume_nudged_prefix') + sid + '.json';
  if (ah.fs.kind(home + '/' + firedRel) !== null) return '';
  if (!tlStamp(home, firedRel, JSON.stringify({ nudged: true, ts: now }))) return '';
  return text.render(tlT('resume_text'), { file: m.v.handoverFile });
}

function tlSafe(s) { return s.replace(/[^A-Za-z0-9_.-]/g, '_'); }

function tlAckPath(home, session) {
  var dir = tlT('ack_dir');
  return home + '/' + ah.cfg('paths.base_dir') + '/' + dir + '/' + dir + '-' + tlSafe(session).slice(0, tlN('ack_session_max')) + tlT('state_ext');
}

// `entryIsEvidence(entry)` of lib/task-tool-evidence.js.
function tlEvidenceEntry(e) {
  if (!jx.isObj(e)) return false;
  var names = tlT('task_tool_names');
  if (e.type === 'assistant') {
    var c = e.message ? e.message.content : undefined;
    return Array.isArray(c) && c.some(function (b) { return !!b && b.type === 'tool_use' && names.indexOf(b.name) >= 0; });
  }
  if (e.type === 'attachment') {
    var a = e.attachment;
    if (a === null || typeof a !== 'object') return false;
    if (a.type === tlT('evidence_reminder')) return true;
    if (typeof a.type === 'string' && a.type.indexOf(tlT('evidence_deferred_prefix')) === 0) return Array.isArray(a.addedNames) && a.addedNames.indexOf(tlT('evidence_tool')) >= 0;
  }
  return false;
}

// `hasEvidence(transcriptPath)`: some line of the last 16 MB proves the session has task tools. null defers.
function tlHasEvidence(path) {
  var lines = rp.lines(path, tlN('wide_window_bytes'));
  if (lines === null) return false;
  var pre = tlT('evidence_names');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!pre.some(function (p) { return line.indexOf(p) >= 0; })) continue;
    var r = jx.parse(line.trim());
    if (r.unsure) return null;
    if (!r.invalid && tlEvidenceEntry(r.v)) return true;
  }
  return false;
}

// `nagForm`: 'full', 'reduced' or 'skip'; null defers.
function tlNagForm(f) {
  var full = tlT('form_full'), unset = '\u0000';
  var s = ah.settings.get('tasklist_guard.no_task_tools_setting', unset, f.pluginRoot);
  if (s.status === 'undecidable') return null;
  var explicit = !(s.status === 'value' && s.value === unset);
  var v = explicit ? (s.status === 'value' && typeof s.value === 'string' ? s.value : '') : tlT('form_reduced');
  if (!explicit) {
    var level = ah.settings.get('tasklist_guard.protocol_setting', undefined, f.pluginRoot);
    if (level.status === 'undecidable') return null;
    if (level.status === 'value' && level.value === full) return full;
  }
  var cfg = v === full ? full : (v === tlT('form_skip') ? tlT('form_skip') : tlT('form_reduced'));
  if (cfg === full || !f.codex) return full;
  var ev = tlHasEvidence(f.transcript);
  if (ev === null) return null;
  return ev ? full : cfg;
}

// {hash, blocks, started} of the loop-state file; null defers.
function tlReadState(path) {
  var out = { hash: '', blocks: 0, started: '' };
  var f = jx.read(path);
  if (f.big) return null;
  if (f.text === undefined) return out;
  var raw = f.text.trim();
  if (!raw) return out;
  var r = jx.parse(raw);
  if (r.unsure) return null;
  if (r.invalid || r.v === null || typeof r.v !== 'object') return out;
  if (typeof r.v.hash === 'string') out.hash = r.v.hash;
  if (typeof r.v.blocks === 'number' && isFinite(r.v.blocks)) out.blocks = r.v.blocks;
  if (typeof r.v.started === 'string') {
    var ms = jx.isoMs(r.v.started);
    if (ms === undefined) return null;
    if (!isNaN(ms)) out.started = r.v.started;
  }
  return out;
}

// `firstTranscriptIso(path)`: the first timestamped entry of the transcript head, as ISO text; '' when none; null defers.
function tlFirstIso(path) {
  var head = ah.fs.readText(path, tlN('head_bytes'));
  if (head === null) return '';
  var lines = head.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    var r = jx.parse(lines[i].trim());
    if (r.unsure) return null;
    if (r.invalid || !r.v || typeof r.v.timestamp !== 'string') continue;
    var ms = jx.isoMs(r.v.timestamp);
    if (ms === undefined) return null;
    if (!isNaN(ms)) return new Date(ms).toISOString();
  }
  return '';
}

// ---- an OMC autonomous loop (omc-detect.js isOmcLoopActive) ----

function tlOmcState(path, sid, now) {
  var size = ah.fs.size(path);
  if (size === null || size > tlN('omc_max_bytes')) return false;
  var f = jx.read(path);
  if (f.text === undefined) return false;
  var r = jx.parse(f.text);
  if (r.unsure) return null;
  if (r.invalid || r.v === null || typeof r.v !== 'object' || r.v.active !== true) return false;
  var keys = tlT('omc_ts_keys'), found = false;
  for (var i = 0; i < keys.length && !found; i++) {
    var v = r.v[keys[i]], n = 0;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string') { n = jx.isoMs(v); if (n === undefined) return null; }
    if (!isFinite(n)) n = 0;
    if (n > 0 && now - n <= tlN('omc_fresh_ms')) found = true;
  }
  if (!found) return false;
  var s = r.v.session_id;
  if (s === undefined || s === null) return true;
  if (!sid) return false;
  if (typeof s === 'object') return null;
  return String(s) === sid;
}

function tlOmcActive(p, home, now) {
  if (ah.env.get(tlT('omc_kill_env')) === '1') return false;
  var skip = ah.env.get(tlT('omc_skip_env'));
  if (skip !== null && skip.split(',').some(function (x) { return x.trim() === tlT('omc_skip_token'); })) return false;
  var cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
  var files = tlT('omc_settings_files');
  var sources = [home + '/' + files[0]];
  if (cwd) files.forEach(function (fl) { sources.push(cwd + '/' + fl); });
  var enabled = false;
  for (var i = 0; i < sources.length && !enabled; i++) {
    var size = ah.fs.size(sources[i]);
    if (size === null || size > tlN('omc_settings_max_bytes')) continue;
    var f = jx.read(sources[i]);
    if (f.text === undefined) continue;
    var r = jx.parse(f.text);
    if (r.unsure) return null;
    if (r.invalid || r.v === null || typeof r.v !== 'object') continue;
    var pl = r.v.enabledPlugins;
    if (pl && pl[tlT('omc_plugin')] === true) enabled = true;
  }
  if (!enabled) return false;
  var rel = tlT('omc_state_dir').join('/');
  var root = cwd && ah.fs.isDir(cwd + '/' + rel) ? cwd + '/' + rel : home + '/' + rel;
  var sid = p.session_id ? String(p.session_id) : null;
  var names = tlT('omc_state_files');
  for (var k = 0; k < names.length; k++) {
    var a = tlOmcState(root + '/' + names[k], sid, now);
    if (a === null) return null;
    if (a) return true;
  }
  return false;
}

// The newest handover state file another session left today, as a path relative to the root.
function tlPriorState(root, date, sid) {
  var segs = tlT('handovers_dir').concat([date]), relDay = segs.join('/'), day = root + '/' + relDay;
  var names = ah.fs.listDir(day);
  if (names === null) return null;
  var best = null, bestM = -1;
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (n === sid || ah.fs.kind(day + '/' + n) !== 'dir') continue;
    var sp = day + '/' + n + '/' + tlT('handover_state_file'), st = ah.fs.lstat(sp);
    if (!st || st.kind !== 'file') continue;
    if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = relDay + '/' + n + '/' + tlT('handover_state_file'); }
  }
  return best;
}

// The handover advisory that rides this block, if one is due: {marker (relative to the home), body, text}, null (none) or 'defer'.
function tlHandover(f, state, safe, reason) {
  var segs = tlT('handovers_dir').concat([f.date, f.sid]);
  var dir = f.root + '/' + segs.join('/'), ext = tlT('state_ext');
  if (!ah.fs.isDir(dir)) {
    var marker = ah.cfg('paths.base_dir') + '/' + tlT('advisory_prefix') + safe + ext;
    if (ah.fs.kind(f.home + '/' + marker) !== null) return null;
    var t = tlSanitize(reason + tlT('advisory_text'));
    return t === null ? 'defer' : { marker: marker, body: tlT('advisory_body'), text: t };
  }
  var names = ah.fs.listDir(dir) || [], newest = 0, re = new RegExp(tlT('handover_file_re'));
  for (var i = 0; i < names.length; i++) {
    if (!re.test(names[i])) continue;
    var m = ah.fs.mtimeMs(dir + '/' + names[i]);
    if (m !== null) newest = Math.max(newest, m);
  }
  var last = isFinite(f.scan.lastWork) ? f.scan.lastWork : 0;
  if (newest <= 0 || last <= 0 || last <= newest + tlN('handover_grace_ms')) return null;
  var smarker = ah.cfg('paths.base_dir') + '/' + tlT('stale_prefix') + safe + ext;
  if (ah.fs.kind(f.home + '/' + smarker) !== null) return null;
  var st = tlSanitize(reason + tlT('stale_text'));
  return st === null ? 'defer' : { marker: smarker, body: tlT('stale_body'), text: st };
}

// The newest real user entry's uuid in the policy window (stop-policy.js promptKey): a string, '' (none) or null (defer).
function tlPromptKey(f) {
  var pid = f.p.prompt_id;
  if (typeof pid === 'string' && pid) return pid;
  var tail = ah.fs.readTail(f.transcript, tlN('policy_tail_bytes'));
  if (tail === null || tail === '') return '';
  var lines = tail.split('\n');
  for (var i = lines.length - 1; i >= 0; i--) {
    var t = lines[i].trim();
    if (!t || t.indexOf(tlT('policy_user_marker')) < 0) continue;
    var r = jx.parse(t);
    if (r.unsure) return null;
    if (r.invalid || !jx.isObj(r.v)) continue;
    var e = r.v;
    if (e.type !== 'user' || e.isMeta === true || e.isSidechain === true) continue;
    if (typeof e.uuid !== 'string' || !e.uuid) continue;
    var c = e.message ? e.message.content : undefined, real = false;
    if (typeof c === 'string') real = c.trim() !== '';
    else if (Array.isArray(c)) real = c.some(function (b) { return !!b && b.type !== 'tool_result'; });
    if (real) return e.uuid;
  }
  return '';
}

// The Jev consult (`tasklistTrivial`, relax-block): true when Jev, in `on` mode, confidently judged the session trivial.
function tlJev(f, jevState) {
  var r = ah.jev.ask({
    id: tlT('jev_id'), relax: true, sync: true, trust: 'relax_block', baseline: true, state: jevState,
    sessionId: f.rawSid ? f.rawSid : undefined, turnRefFrom: f.transcript,
    question: { type: 'noul', instructions: tlT('jev_instructions'), criteria: [['true', tlT('jev_true')], ['false', tlT('jev_false')]] },
  });
  return r === false;
}

function tlFire(f) {
  var home = f.home, p = f.p;
  if (!ah.env.get(ah.cfg('env.home'))) return 'defer';
  var stale = false;
  if (f.needsAgents) {
    var ag = ah.transcript.agents(f.transcript);
    if (ag !== null && ag.unsure) return 'defer';
    stale = ag !== null && ag.rows.length === 0;
  }
  var scan = f.scan;
  if (scan.sawTaskActivity && !stale && f.progressFresh) return 'allow';
  var form = tlNagForm(f);
  if (form === null) return 'defer';
  if (form === tlT('form_skip')) return 'allow';
  var reduced = form === tlT('form_reduced');
  var work = scan.work;
  var jevState = text.render(tlT('jev_state'), { work: work, threshold: String(f.threshold), saw: String(scan.sawTaskActivity), stale: String(stale), fresh: String(f.progressFresh), open: scan.openTaskIds.length });

  // loop state
  var session = f.rawSid ? f.rawSid : ah.sha1(f.transcript).slice(0, tlN('session_hash_len'));
  var safe = tlSafe(session);
  var stateDirRel = ah.cfg('paths.base_dir'), ext = tlT('state_ext');
  var stateRel = stateDirRel + '/' + tlT('state_prefix') + '-' + safe + ext;
  var bucket = Math.min(Math.floor(work / f.threshold), tlN('work_bucket_max'));
  var ids = scan.openTaskIds.slice().sort();
  var openHash = ah.sha1(ids.join(tlT('open_ids_sep'))).slice(0, tlN('open_hash_len'));
  var bit = function (b) { return b ? '1' : '0'; };
  var signal = [String(bucket), bit(scan.sawTaskActivity), bit(stale), bit(f.progressFresh), openHash].join(tlT('signal_sep'));
  var hash = ah.sha1(signal);
  var prior = tlReadState(home + '/' + stateRel);
  if (prior === null) return 'defer';
  if (hash === prior.hash || prior.blocks >= tlN('max_blocks')) { tlJev(f, jevState); return 'allow'; }

  // everything below is read or computed before the first effect
  var started = prior.started;
  if (!started) {
    var first = tlFirstIso(f.transcript);
    if (first === null) return 'defer';
    started = first ? first : new Date(f.now).toISOString();
  }
  var guard = ah.homeGuard();
  if (guard.status === 'unknown') return 'defer';
  var hm = guard.status === 'ok' ? guard.home : null;
  var versionStale = false;
  if (hm !== null && ah.settings.bool('tasklist_guard.version_setting')) {
    if (!f.pluginRoot) return 'defer';
    var v = ah.plugin.versions(f.pluginRoot);
    if (v.unsure) return 'defer';
    versionStale = !!(v.registered && v.running && jx.isSemver(v.registered) && jx.isSemver(v.running) && jx.cmpVersions(v.running, v.registered) < 0);
  }
  var sig = ah.sha1(hash).slice(0, tlN('ack_sig_len'));
  var ackKey = tlT('guard_name') + ':' + sig;
  var acked = false;
  if (hm !== null && ah.settings.bool('tasklist_guard.ack_setting')) {
    var a = jx.read(tlAckPath(hm, session));
    if (a.big) return 'defer';
    if (a.text !== undefined) {
      var ar = jx.parse(a.text);
      if (ar.unsure) return 'defer';
      acked = !ar.invalid && jx.isObj(ar.v) && typeof ar.v[ackKey] === 'number' && isFinite(ar.v[ackKey]) && ar.v[ackKey] > 0;
    }
  }
  var codex = p.tool_name === tlT('codex_tool') || tlT('codex_fields').every(function (k) { return typeof p[k] === 'string' && p[k] !== ''; });
  var progressPath = f.progressAbs ? f.progressAbs : f.progressRel;
  var historyPath = f.historyAbs ? f.historyAbs : f.historyRel;
  var header = text.render(tlT('header'), { session: f.rawSid ? f.rawSid : ah.cfg('taskkit.unknown_session'), started: started });
  var what, why;
  if (!scan.sawTaskActivity && scan.taskStoreReset) { what = tlT('what_reset'); why = tlT('why_reset'); }
  else if (!scan.sawTaskActivity) {
    what = text.render(tlT('what_no_tasks'), { n: String(work) });
    why = tlT('why_no_tasks');
    var prior2 = f.root ? tlPriorState(f.root, f.date, f.sid) : null;
    if (prior2) why += text.render(tlT('prior_snapshot'), { path: prior2 });
  } else if (stale) { what = text.render(tlT('what_stalled'), { n: String(scan.inProgressCount) }); why = tlT('why_stalled'); }
  else { what = text.render(tlT('what_progress'), { n: String(work), path: progressPath }); why = tlT('why_progress'); }
  var instead;
  if (reduced) {
    if (!scan.taskStoreReset) { what = text.render(tlT('what_reduced'), { n: String(work) }); why = tlT('why_reduced'); }
    instead = text.render(tlT('instead_reduced'), { progress: progressPath, history: historyPath });
  } else {
    instead = '';
    if (!scan.sawTaskActivity && scan.taskStoreReset) instead += codex ? tlT('instead_reset_codex') : tlT('instead_reset');
    if (stale && scan.sawTaskActivity) instead += tlT('instead_stalled');
    instead += codex ? tlT('instead_capture_codex') : tlT('instead_capture');
    instead += text.render(tlT('instead_files'), { progress: progressPath, header: header, history: historyPath, append: codex ? tlT('append_codex') : tlT('append_claude') });
  }
  var base = text.message('block', tlT('guard_name'), { what: what, why: why, instead: instead });
  var reason = tlSanitize(base);
  if (reason === null) return 'defer';
  var omc = tlOmcActive(p, home, f.now);
  if (omc === null) return 'defer';
  var advisory = null;
  if (f.root && !reduced) { advisory = tlHandover(f, stateDirRel, safe, reason); if (advisory === 'defer') return 'defer'; }
  // the stop-policy state for this Stop, read before anything is written
  var policy = null;
  if (hm !== null) {
    var bv = ah.settings.num('tasklist_guard.budget_setting'), budget = isFinite(bv) && bv > 0 ? Math.floor(bv) : 0;
    var promptKey = '';
    if (budget > 0) { promptKey = tlPromptKey(f); if (promptKey === null) return 'defer'; }
    if (promptKey || reduced) {
      var prel = stateDirRel + '/' + tlT('policy_dir').join('/') + '/' + safe + ext, buckets = {};
      var pf = jx.read(hm + '/' + prel);
      if (pf.big) return 'defer';
      if (pf.text !== undefined) {
        var pr = jx.parse(pf.text);
        if (pr.unsure) return 'defer';
        if (!pr.invalid && jx.isObj(pr.v)) buckets = pr.v;
      }
      policy = { rel: prel, buckets: buckets, budget: budget, key: promptKey };
    } else policy = { rel: null, buckets: {}, budget: 0, key: '' };
  }
  var finalReason = advisory ? advisory.text : reason;
  if (hm !== null) {
    var hint = text.render(tlT('ack_hint'), { key: ackKey, now: String(ah.clock.now()), path: tlAckPath(hm, session) });
    finalReason = tlSanitize(finalReason + '\n' + hint);
    if (finalReason === null) return 'defer';
  }
  var out = JSON.stringify({ decision: 'block', reason: finalReason }) + '\n';

  // effects, in Node order
  var relaxed = tlJev(f, jevState);
  if (relaxed || versionStale || acked) return 'allow';
  if (omc) return { exact: { code: 0, out: tlT('omc_text'), err: '' } };
  if (advisory) { try { tlStamp(home, advisory.marker, advisory.body); } catch (e) { /* best-effort cap */ } }
  if (policy !== null && policy.rel !== null) {
    var now = ah.clock.now(), bk = function (kind) { return safe + '|' + tlT('guard_name') + '|' + kind; };
    var spent = false;
    if (policy.key) {
      var k = bk(tlT('policy_prompt_kind')), b = policy.buckets[k];
      var count = b !== null && typeof b === 'object' && b.promptKey === policy.key && typeof b.count === 'number' && isFinite(b.count) ? b.count : 0;
      if (count >= policy.budget) spent = true;
      else {
        policy.buckets[k] = { promptKey: policy.key, count: count + 1, lastAt: now };
        spent = !tlStamp(home, policy.rel, JSON.stringify(policy.buckets));
      }
    }
    if (spent) return 'allow';
    if (reduced) {
      var rk = bk(tlT('policy_reduced_kind')), rb = policy.buckets[rk];
      var rc = rb !== null && typeof rb === 'object' && typeof rb.count === 'number' && isFinite(rb.count) ? rb.count : 0;
      if (rc >= tlN('policy_reduced_cap')) return 'allow';
      policy.buckets[rk] = { count: rc + 1, lastAt: now };
      if (!tlStamp(home, policy.rel, JSON.stringify(policy.buckets))) return 'allow';
    }
  }
  if (!tlStamp(home, stateRel, JSON.stringify({ hash: hash, blocks: prior.blocks + 1, started: started }))) return 'allow';
  ah.state.prune(tlT('state_prefix'), stateRel.slice(stateRel.lastIndexOf('/') + 1));
  return { exact: { code: 0, out: out, err: '' } };
}

function decide(p, opts) {
  if (ah.env.get(ah.cfg('task_guard.judge_child_env')) === '1') return 'allow';
  if (!ah.settings.bool('tasklist_guard.setting') || ah.settings.skipped(tlT('guard_name'))) return 'allow';
  if (p === null || typeof p !== 'object') p = {};
  if (typeof p.permission_mode === 'string' && p.permission_mode.toLowerCase() === tlT('plan_mode_value')) {
    return { exact: { code: 0, out: tlT('plan_mode_text'), err: '' } };
  }
  var transcript = p.transcript_path;
  if (!transcript || typeof transcript !== 'string') return 'allow';
  var home = ah.home();
  if (!home) return 'defer';
  var rawSid = p.session_id !== undefined && p.session_id !== null ? String(p.session_id) : '';
  var sid = rawSid.replace(new RegExp(ah.cfg('taskkit.session_id_unsafe'), 'g'), '') || ah.cfg('taskkit.unknown_session');
  var now = ah.clock.now();
  var date = new Date(now).toISOString().slice(0, 10);
  var progressSegs = tlT('progress_dir').concat([date, sid + '.md']), historySegs = tlT('history_dir').concat([date, sid + '.md']);
  var cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
  var root = null;
  if (cwd !== null) { root = ah.project.root(cwd); if (root === null) return 'defer'; }
  var progressAbs = root !== null ? tlJoin(root, progressSegs) : null, historyAbs = root !== null ? tlJoin(root, historySegs) : null;
  var codexPlat = typeof p.turn_id === 'string' && p.turn_id !== '' || new RegExp(ah.cfg('taskkit.codex_rollout')).test(transcript) || new RegExp(ah.cfg('taskkit.codex_dir')).test(transcript);
  var cx = { tmp: wd.tmpdir(), cwd: cwd !== null && cwd.charAt(0) === '/' ? cwd : null };
  var work;
  try { work = tlScanWork(transcript, progressAbs, cx); } catch (e) { if (e === wd.UNSURE) return 'defer'; throw e; }
  if (work === 'defer') return 'defer';
  if (work === 'quiet') return 'allow';
  var t = ah.transcript.tasks(transcript, 'scan', tlN('window_bytes'), tlN('wide_window_bytes'));
  if (t.unsure) return 'defer';
  if (t.quiet) return 'allow';
  var scan = {
    work: work.work, lastWork: work.lastWork, lastProgressWrite: work.lastProgressWrite,
    sawTaskActivity: !!t.sawTaskActivity, taskStoreReset: !!t.taskStoreReset, inProgressCount: t.inProgressCount || 0, openTaskIds: t.openTaskIds || [],
  };
  var needsAgents = scan.inProgressCount > 1 && !codexPlat;
  var threshold = ah.settings.num('tasklist_guard.threshold_setting');
  var freshMs = ah.settings.num('tasklist_guard.fresh_setting');

  // progress-file freshness (fail-open layering: an unreadable cwd or progress directory never blocks)
  var progressFresh = true;
  if (cwd !== null && root !== null) {
    if (cwd.charAt(0) !== '/') return 'defer';
    if (ah.fs.isDir(cwd)) {
      var dirRel = tlT('progress_dir').concat([date]).join('/');
      if (ah.state.op(root, 'mkdir', dirRel)) {
        var ps = ah.fs.lstat(progressAbs);
        if (ps && ps.kind === 'file') { tlIndex(root, date, sid, 'progress'); progressFresh = tlFresh(ps.mtimeMs, scan.lastWork, freshMs, now); }
        else progressFresh = false;
      }
    }
  }
  if (!progressFresh && isFinite(scan.lastProgressWrite) && scan.lastProgressWrite > 0 && tlFresh(scan.lastProgressWrite, scan.lastWork, freshMs, now)) progressFresh = true;
  // the history index is kept whenever the session's own history file exists
  if (root !== null) { var hs = ah.fs.lstat(historyAbs); if (hs && hs.kind === 'file') tlIndex(root, date, sid, 'history'); }
  // the resume-verification nudge: independent of the block decision below
  var resume = tlResume(home, sid, scan.work, threshold, now);
  if (resume === null) return 'defer';
  if (resume) {
    var rr = tlSanitize(resume);
    if (rr === null) return 'defer';
    return { exact: { code: 0, out: JSON.stringify({ decision: 'block', reason: rr }) + '\n', err: '' } };
  }
  if (scan.work < threshold) return 'allow';
  // two or more tasks in progress on a Claude session are stalled only when no agent is running, which the block path finds out
  if (!needsAgents && scan.sawTaskActivity && progressFresh) return 'allow';
  var pluginRoot = opts !== null && typeof opts === 'object' && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root')) || '';
  var f = {
    p: p, home: home, pluginRoot: pluginRoot, transcript: transcript, rawSid: rawSid, sid: sid, date: date, root: root, now: now,
    progressRel: progressSegs.join('/'), historyRel: historySegs.join('/'), progressAbs: progressAbs, historyAbs: historyAbs,
    scan: scan, needsAgents: needsAgents, progressFresh: progressFresh, threshold: threshold, codex: codexPlat,
  };
  try { return tlFire(f); } catch (e2) { if (e2 === wd.UNSURE) return 'defer'; throw e2; }
}
