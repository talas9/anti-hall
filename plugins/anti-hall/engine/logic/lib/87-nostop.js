// The no-stop facts shared by afk-mode (captures the owner's no-stop orders, holds a Stop), auto-handover and auto-handover-pause-nag
// (stay quiet about stopping points, /compact and /clear while the session must keep working) (GH #958). The per-session no-stop state is
// one small file, <state dir>/<afk.nostop_prefix><sid>.json = {on, since, holds}; the machine-wide AFK flag is read, never written, here.
// Keys and texts: afk.toml (afk.nostop_*, afk.msg_nostop_stop), ctxbudget.toml (ctxbudget.refresh_*).
'use strict';
var nostop = {
  rel: function (name) { return ah.cfg('replykit.state_dir') + '/' + name; },
  readJson: function (rel) {
    var t = ah.state.readText(rel);
    if (t === null) return null;
    try { var v = JSON.parse(t); return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; }
  },
  sid: function (p) {
    var raw = p && p.session_id !== undefined && p.session_id !== null ? String(p.session_id) : '';
    return raw.replace(new RegExp(ah.cfg('afk.session_id_unsafe'), 'g'), '');
  },
  sessRel: function (sid) { return nostop.rel(ah.cfg('afk.nostop_prefix') + sid + ah.cfg('replykit.json_ext')); },
  // The session's no-stop state ({on, since, holds}), or null when none is recorded or the feature is switched off.
  session: function (p) {
    if (!ah.settings.bool('afk.set_nostop')) return null;
    var sid = nostop.sid(p);
    if (!sid) return null;
    var s = nostop.readJson(nostop.sessRel(sid));
    return s !== null && s.on === true ? s : null;
  },
  write: function (p, s) {
    var sid = nostop.sid(p);
    if (!sid) return false;
    try { return ah.state.writeAtomic(nostop.sessRel(sid), JSON.stringify(s)); } catch (e) { return false; }
  },
  // Whether the machine-wide AFK flag is on (the master switch afk.enabled off means it never counts).
  afkOn: function () {
    if (!ah.settings.bool('afk.set_enabled')) return false;
    var f = nostop.readJson(nostop.rel(ah.cfg('afk.flag_file')));
    return f !== null && f.on === true;
  },
  // The session's tasks ([] none; null when the list cannot be read exactly: never a reason to hold or to stay quiet).
  tasks: function (p) {
    var home = ah.home(), tp = p && typeof p.transcript_path === 'string' ? p.transcript_path : null;
    if (!home) return null;
    var sid = p && p.session_id ? String(p.session_id) : undefined;
    if (tp === null && sid === undefined) return null;
    var r = tk.tasksOf(home, sid, tp === null ? undefined : tp, 'guard', true);
    if (r.unsure || r.unreadable) return null;
    return r.tasks || [];
  },
  // The open tasks of `tasks` that no live agent, DevSwarm workspace or running background job is working.
  uncovered: function (p, open) {
    if (open.length === 0) return [];
    var rows = [];
    try { rows = ah.transcript.trackedAgents(p); } catch (e) { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    var coord = new RegExp(ah.cfg('task_guard.coordinator_owner_re'), 'i');
    var bgLive = rows.some(function (r) { return typeof r.shellKind === 'string' && r.shellKind !== '' && r.live !== false; });
    var inProg = ah.cfg('taskstate.in_progress_statuses');
    return open.filter(function (t) {
      var o = typeof t.owner === 'string' ? t.owner.trim() : '';
      if (o !== '' && !coord.test(o) && (ah.transcript.trackedLiveness(o, rows) === true || tk.childAttended(o))) return false;
      if (bgLive && inProg.indexOf(tk.statusLc(t)) >= 0) return false;
      return true;
    });
  },
  // The task to name next: an in-progress one first, then the lowest id.
  next: function (list) {
    var inProg = ah.cfg('taskstate.in_progress_statuses'), best = null;
    list.forEach(function (t) {
      var a = inProg.indexOf(tk.statusLc(t)) >= 0, b = best !== null && inProg.indexOf(tk.statusLc(best)) >= 0;
      if (best === null || (a && !b) || (a === b && Number(t.id) < Number(best.id))) best = t;
    });
    return best;
  },
  subject: function (t) {
    var s = t && t.content && t.content !== t.id ? tk.oneLine(t.content, ah.cfgNum('afk.nostop_subject_max')) : '';
    return s !== '' ? s : ah.cfg('afk.nostop_subject_none');
  },
  // The newest change to the session's work: the latest modification of a task-store file or of today's progress file (ms), or 0.
  lastChangeMs: function (p) {
    var best = 0, home = ah.home(), sid = p && p.session_id ? String(p.session_id) : '';
    if (home && sid !== '' && !/[^A-Za-z0-9_-]/.test(sid)) {
      var base = home + '/' + ah.cfg('taskstate.store_base').join('/') + '/', named = tk.namedList(home), dirs = [];
      if (named !== null) dirs.push(base + named);
      else ah.cfg('taskstate.store_dir_names').forEach(function (n) { dirs.push(tk.followPointer(base, base + text.render(n, { sid: sid, sid8: sid.slice(0, 8) }))); });
      var suffix = ah.cfg('taskstate.store_file_suffix'), cap = ah.cfgNum('taskstate.store_max_files');
      dirs.forEach(function (d) {
        var names = ah.fs.readdir(d);
        if (names === null) return;
        names.slice(0, cap).forEach(function (n) {
          if (n.length < suffix.length || n.slice(-suffix.length) !== suffix) return;
          var m = ah.fs.mtimeMs(d + '/' + n);
          if (typeof m === 'number' && m > best) best = m;
        });
      });
    }
    var cwd = p && typeof p.cwd === 'string' && p.cwd.charAt(0) === '/' ? p.cwd : null, ssid = nostop.sid(p);
    if (cwd !== null && ssid) {
      var root = ah.project.root(cwd);
      if (root === null) root = cwd;
      var segs = ah.cfg('tasklist_guard.progress_dir').concat([new Date(ah.clock.now()).toISOString().slice(0, 10), ssid + '.md']);
      var pm = ah.fs.mtimeMs(root + '/' + segs.join('/'));
      if (typeof pm === 'number' && pm > best) best = pm;
    }
    return best;
  },
};
