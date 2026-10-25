// check = "precompact-snapshot" (PreCompact). Right before a compaction, write a mechanical snapshot of the session's continuation
// state to <repo>/.anti-hall/handovers/<date>/<session>/PRECOMPACT-<n>.md: git state, the task list read back from the transcript, the
// last user messages verbatim, and the newest handover. It never blocks the compaction and prints nothing; on any error it just
// writes no snapshot. The home is Node's os.homedir() (hookProc.nodeHome: HOME unset adopts the passwd home); a relative transcript
// path is opened from the absolute payload cwd. What the engine cannot reproduce exactly writes no
// snapshot (counted, native_unable): no home, the real home under a test marker, no local date, a sequence number too long to be exact;
// a relative HOME or working directory resolves against the stand-in directory and a checkout the resolver cannot classify is read as
// the directory itself (counted).
// Mirrors hooks/precompact-snapshot.js and hooks/lib/handover-find.js (lib/73-handover.js). Keys and texts: codex_handover.toml.
'use strict';

function psIsObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function psGit(cwd, args) {
  var r = ah.exec(ah.cfg('codex_handover.git_binary'), args, { cwd: cwd, timeoutMs: ah.cfgNum('codex_handover.precompact_git_timeout_ms') });
  return r === null || r.status !== 0 || r.truncated ? null : r.stdout;
}

function psGitState(cwd) {
  var status = psGit(cwd, ah.cfg('codex_handover.argv_status'));
  if (status === null) return null;
  var lines = status.split('\n').filter(Boolean), pre = ah.cfg('codex_handover.branch_prefix');
  var branchLine = lines[0] && lines[0].startsWith(pre) ? lines[0].slice(pre.length) : ah.cfg('codex_handover.branch_unknown');
  var dirty = lines.filter(function (l) { return !l.startsWith(pre); });
  var head = (psGit(cwd, ah.cfg('codex_handover.argv_log')) || '').trim() || ah.cfg('codex_handover.head_none');
  return { branchLine: branchLine, head: head, dirty: dirty };
}

function psTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (content.some(function (c) { return c && c.type === 'tool_result'; })) return '';
  return content.filter(function (c) { return c && c.type === 'text' && typeof c.text === 'string'; }).map(function (c) { return c.text; }).join('\n');
}

function psUserMessages(lines) {
  var out = [], notTyped = new RegExp(ah.cfg('codex_handover.not_typed_re'));
  (lines || []).forEach(function (line) {
    if (!line || (line.indexOf('"user"') === -1 && line.indexOf('user_message') === -1)) return;
    var e;
    try { e = JSON.parse(line); } catch (x) { return; }
    if (!e || typeof e !== 'object') return;
    var t = '';
    if (e.type === 'user' && !e.isMeta && !e.isSidechain && !e.isCompactSummary && e.message) t = psTextOf(e.message.content);
    else if (e.type === 'event_msg' && e.payload && e.payload.type === 'user_message' && typeof e.payload.message === 'string') t = e.payload.message;
    t = String(t || '').trim();
    if (!t || notTyped.test(t)) return;
    out.push({ ts: typeof e.timestamp === 'string' ? e.timestamp : '', text: t });
  });
  return out.slice(-ah.cfgNum('codex_handover.max_user_messages'));
}

function psTaskSnapshot(lines) {
  var todos = null, tasks = new Map(), pending = new Map(), words = ah.cfg('codex_handover.task_line_words');
  (lines || []).forEach(function (line) {
    if (!line) return;
    if (!words.some(function (w) { return line.indexOf(w) !== -1; })) return;
    var e;
    try { e = JSON.parse(line); } catch (x) { return; }
    if (!e || e.isSidechain === true || !e.message || !Array.isArray(e.message.content)) return;
    e.message.content.forEach(function (item) {
      if (!item) return;
      if (e.type === 'assistant' && item.type === 'tool_use') {
        var inp = item.input || {};
        if (item.name === 'TodoWrite' && Array.isArray(inp.todos)) {
          todos = inp.todos.map(function (t, i) { return { id: String(i + 1), subject: String((t && (t.content || t.subject)) || ''), status: (t && t.status) || ah.cfg('codex_handover.status_pending') }; });
        } else if (item.name === 'TaskCreate' && item.id) {
          pending.set(item.id, String(inp.subject || ''));
        } else if (item.name === 'TaskUpdate') {
          var id = inp.taskId != null ? String(inp.taskId) : inp.id != null ? String(inp.id) : null;
          if (id !== null) {
            var t = tasks.get(id) || { id: id, subject: '', status: ah.cfg('codex_handover.status_pending') };
            if (inp.status) t.status = inp.status;
            if (inp.subject) t.subject = String(inp.subject);
            tasks.set(id, t);
          }
        }
      } else if (e.type === 'user' && item.type === 'tool_result' && pending.has(item.tool_use_id)) {
        var txt = typeof item.content === 'string' ? item.content : psTextOf(item.content);
        var m = new RegExp(ah.cfg('codex_handover.task_created_re')).exec(txt || '');
        if (m) {
          var prior = tasks.get(m[1]);
          tasks.set(m[1], { id: m[1], subject: pending.get(item.tool_use_id), status: (prior && prior.status) || ah.cfg('codex_handover.status_pending') });
        }
        pending.delete(item.tool_use_id);
      }
    });
  });
  var list = (todos || []).concat(Array.from(tasks.values()).filter(function (t) { return t.status !== ah.cfg('codex_handover.status_deleted'); }));
  return (todos || tasks.size) ? list : null;
}

function psCell(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, ah.cfgNum('codex_handover.cell_max')); }

function psBuild(c) {
  var r = function (k, a) { return text.render(ah.cfg(k), a); }, L = [];
  L.push(r('codex_handover.snap_title', { session: c.sessionId, n: c.n, now: c.nowIso }), '', r('codex_handover.snap_intro', { trigger: c.trigger }), '', ah.cfg('codex_handover.snap_h_handover'));
  L.push(c.handover ? r('codex_handover.snap_handover_found', { path: c.handover.filePath, modified: new Date(c.handover.mtimeMs).toISOString() }) : ah.cfg('codex_handover.snap_handover_none'));
  L.push('', ah.cfg('codex_handover.snap_h_repo'), r('codex_handover.snap_pwd', { cwd: c.cwd }));
  if (!c.git) {
    L.push(ah.cfg('codex_handover.snap_not_git'));
  } else {
    var max = ah.cfgNum('codex_handover.max_dirty_listed');
    L.push(r('codex_handover.snap_branch', { branch: c.git.branchLine }), r('codex_handover.snap_head', { head: c.git.head }),
      r('codex_handover.snap_dirty', { count: c.git.dirty.length, clean: c.git.dirty.length ? '' : ah.cfg('codex_handover.snap_clean') }));
    c.git.dirty.slice(0, max).forEach(function (d) { L.push(ah.cfg('codex_handover.snap_indent') + d); });
    if (c.git.dirty.length > max) L.push(r('codex_handover.snap_more', { count: c.git.dirty.length - max }));
  }
  if (c.customInstructions) L.push('', ah.cfg('codex_handover.snap_h_custom'), c.customInstructions);
  L.push('', ah.cfg('codex_handover.snap_h_tasks'));
  if (!c.tasks) L.push(ah.cfg('codex_handover.snap_tasks_none'));
  else if (c.tasks.length === 0) L.push(ah.cfg('codex_handover.snap_tasks_empty'));
  else {
    L.push(ah.cfg('codex_handover.snap_table_head'), ah.cfg('codex_handover.snap_table_rule'));
    c.tasks.forEach(function (t) { L.push(r('codex_handover.snap_table_row', { id: psCell(t.id), subject: psCell(t.subject), status: psCell(t.status) })); });
  }
  L.push('', r('codex_handover.snap_h_messages', { count: c.messages.length }));
  if (c.messages.length === 0) L.push(ah.cfg('codex_handover.snap_messages_none'));
  var cap = ah.cfgNum('codex_handover.max_message_chars');
  c.messages.forEach(function (m, i) {
    L.push('', r('codex_handover.snap_msg_head', { i: i + 1, ts: m.ts ? ah.cfg('codex_handover.snap_ts_sep') + m.ts : '' }), ah.cfg('codex_handover.snap_fence_open'));
    L.push(m.text.length > cap ? r('codex_handover.snap_truncated', { head: m.text.slice(0, cap), count: m.text.length - cap }) : m.text);
    L.push(ah.cfg('codex_handover.snap_fence_close'));
  });
  L.push('');
  return L.join('\n');
}

// Node's os.homedir() for this call: false when there is none or it is the real home under a test marker (Node's own guard then writes nothing);
// a relative HOME is resolved against the stand-in directory (counted).
function psAdopt(p) {
  var why = hookProc.adoptHome();
  if (why === null) return true;
  ah.unable('precompact-snapshot:' + why);
  ah.log(ah.cfg('codex_handover.precompact_unsure_log_kind'), why);
  if (why !== 'relative_home') return false;
  var h = hookProc.home(p);
  if (h === null) return false;
  ah.useHome(h);
  return true;
}

function decide(p) {
  if (!psAdopt(p)) return 'allow';
  if (!ah.settings.bool('codex_handover.setting_precompact')) return 'allow';
  if (!psIsObj(p)) return 'allow';
  var present = function (k) { return p[k] !== undefined && p[k] !== null; };
  if (present('agent_id') || present('agent_type') || ah.settings.skipped(ah.cfg('codex_handover.precompact_guard'))) return 'allow';
  var cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
  if (cwd === null) return 'allow';
  if (!ah.path.isAbsolute(cwd)) { ah.unable('precompact-snapshot:relative_cwd'); cwd = hookProc.cwd(p); } // resolved against the stand-in directory
  var sessionId = ho.sanitize(p.session_id === undefined || p.session_id === null ? '' : p.session_id);
  // handover-find repoRoot(cwd) against the call's home (ah.home(): HOME, or the passwd home adopted above), as Node's realHome()
  var ctx = ho.context(cwd), h = ah.home(), rh = ah.fs.realpath(h) || h;
  if (ctx.unsure) { ah.unable('precompact-snapshot:repo_root'); ctx = { unsure: false, toplevel: null, root: null }; } // a checkout the host cannot classify is read as the directory itself
  var repoRoot = ctx.toplevel && ctx.toplevel !== rh ? ctx.toplevel : cwd, today = ho.localDate();
  if (today === null) { ah.unable('precompact-snapshot:local_date', 'abandoned'); return 'allow'; } // no local date, no snapshot path
  var root = ah.path.join(repoRoot, ah.cfg('codex_handover.handovers_dir'));
  var tp = typeof p.transcript_path === 'string' ? p.transcript_path : null;
  if (tp) tp = hookProc.open(p, tp);
  var lines = null;
  if (tp) {
    var size = ah.fs.size(tp), tail = size === null || size === 0 ? null : ah.fs.readTail(tp, ah.cfgNum('codex_handover.transcript_tail_bytes'));
    if (tail !== null) lines = tail.split('\n');
  }
  var handover = ho.newestHandover(root, sessionId), dir = root + '/' + today + '/' + sessionId, n = 1, names = ah.fs.readdir(dir) || [];
  for (var i = 0; i < names.length; i++) {
    var m = ho.precompactRe.exec(names[i]);
    if (m) {
      if (m[1].length > ah.cfgNum('codex_handover.seq_max_digits')) { ah.unable('precompact-snapshot:seq_digits', 'abandoned'); return 'allow'; } // parseInt past 20 digits is implementation-defined: no new snapshot name
      n = Math.max(n, parseInt(m[1], 10) + 1);
    }
  }
  var triggers = ah.cfg('codex_handover.triggers');
  var body = psBuild({
    sessionId: sessionId, n: n, cwd: cwd, nowIso: new Date(ah.clock.now()).toISOString(),
    trigger: triggers.indexOf(p.trigger) >= 0 ? p.trigger : ah.cfg('codex_handover.trigger_unknown'),
    customInstructions: typeof p.custom_instructions === 'string' && p.custom_instructions.trim() ? p.custom_instructions.trim() : '',
    handover: handover, git: psGitState(cwd), tasks: lines === null ? null : psTaskSnapshot(lines), messages: lines === null ? [] : psUserMessages(lines),
  });
  // a cut through a surrogate pair leaves half of it; Node's file write turns a lone half into U+FFFD, and so does this
  body = body.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
  try {
    ah.state.op(repoRoot, 'write', ah.cfg('codex_handover.handovers_dir') + '/' + today + '/' + sessionId + '/' + ah.cfg('codex_handover.precompact_prefix') + n + ah.cfg('codex_handover.md_suffix'), body);
  } catch (e) { /* never block the compaction */ }
  return 'allow';
}
