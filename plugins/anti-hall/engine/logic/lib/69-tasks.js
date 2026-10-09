// Helpers the task Stop gates share (D88 batch 6; mirrors hooks/lib/task-state.js and the text helpers of task-guard.js and
// tasklist-guard.js): the task list from the engine's reconstruction, the one-line text sanitizer, the safe state key, the
// unknown-state note and the DevSwarm app database test. Keys: task_guards.toml (taskstate.*, taskkit.*, task_guard.*).
'use strict';
var tk = {
  // `String(x).replace(/[^A-Za-z0-9_.-]/g, '_')`, one underscore per UTF-16 unit.
  safeKey: function (s) { return String(s).replace(/[^A-Za-z0-9_.-]/g, '_'); },
  // The tasks of a transcript tail ('guard' variant): an array of the engine's task records, or null when the Node hook decides.
  tasks: function (path) {
    var r = ah.transcript.tasks(path, 'guard', ah.cfgNum('taskstate.tail_bytes'));
    if (r.unsure) return null;
    return r.unreadable ? [] : r.tasks;
  },
  statusLc: function (t) { return (t.status || '').toLowerCase(); },
  isOpen: function (t) { return ah.cfg('taskstate.open_statuses').indexOf(tk.statusLc(t)) >= 0; },
  isDone: function (t) { return ah.cfg('taskstate.done_statuses').indexOf(tk.statusLc(t)) >= 0; },
  // The blockedOn marker as the owner-blocked test reads it: a string trimmed and lowercased, else empty.
  blockedOnText: function (t) { return typeof t.blockedOn === 'string' ? t.blockedOn.trim().toLowerCase() : ''; },
  // oneLine: control characters become spaces, white space runs collapse, the text is trimmed and cut to `max` UTF-16 units with an
  // ellipsis; null when the cut would split a surrogate pair (the half cannot cross into the engine).
  oneLine: function (s, max) {
    var o = jx.replaceAll(ah.cfg('taskkit.control_chars'), '', s, ' ').replace(/\s+/g, ' ').trim();
    if (o.length > max) {
      var cut = o.slice(0, max), last = cut.charCodeAt(cut.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) return null;
      return cut.replace(/\s+$/, '') + ah.cfg('taskkit.ellipsis');
    }
    return o;
  },
  // Tasks whose status is unknown, and open tasks whose block state could not be established.
  unknownIds: function (tasks) {
    return tasks.filter(function (t) { return t.status === null || (tk.isOpen(t) && t.blockUnknown); }).map(function (t) { return t.id; });
  },
  // The unknown-state note and the write that goes with saying it: {note, write: function () -> note|''}; null when the Node hook decides.
  unknownNote: function (tasks, home, sessionId, tag) {
    var none = { note: '', write: function () { return ''; } };
    var ids = tk.unknownIds(tasks);
    if (ids.length === 0) return none;
    var count = ids.length;
    ids.sort();
    var hash = ah.sha1(ids.join('\u0000'));
    var dir = ah.cfg('paths.base_dir'), prefix = ah.cfg('taskstate.unknown_file_prefix');
    var rel = dir + '/' + prefix + '-' + tag + '-' + tk.safeKey(sessionId || 'nosession') + '.json';
    var lastHash = '', lastN = 0;
    var f = jx.read(home + '/' + rel);
    if (f.big) return null;
    if (f.text !== undefined) {
      var r = jx.parse(f.text.trim());
      if (r.unsure) return null;
      if (!r.invalid && r.v !== null && typeof r.v === 'object') {
        var h = r.v.hash;
        if (h) { if (typeof h === 'object') return null; lastHash = String(h); }
        var n = r.v.n;
        if (n !== null && n !== undefined && typeof n === 'object') return null;
        lastN = Number(n) || 0;
      }
    }
    if (lastHash === hash || lastN >= ah.cfgNum('taskstate.unknown_max_notes')) return none;
    var note = text.render(ah.cfg('taskstate.unknown_note_text'), { n: count });
    return {
      note: note,
      write: function () {
        if (!ah.state.writeAtomic(rel, JSON.stringify({ hash: hash, n: lastN + 1 }))) return '';
        ah.state.prune(prefix, rel.slice(rel.lastIndexOf('/') + 1));
        return note;
      },
    };
  },
  // The DevSwarm app database file `companion/lib/devswarm-app-db.js` names, or null when there is none.
  appDbPath: function (home) {
    var over = (ah.env.get(ah.cfg('task_guard.app_db_env')) || '').trim();
    if (over) return over.toLowerCase() !== ah.cfg('task_guard.app_db_off') ? over : null;
    if (!home) return null;
    var base;
    var plat = ah.platform();
    if (plat === 'macos') base = home + '/' + ah.cfg('task_guard.app_db_darwin_dir').join('/');
    else if (plat === 'linux') {
      var x = ah.env.get(ah.cfg('task_guard.app_db_xdg_env'));
      base = x ? x : home + '/' + ah.cfg('task_guard.app_db_linux_config');
    } else return null;
    return base + '/' + ah.cfg('task_guard.app_db_file').join('/');
  },
  // True when the answer needs the DevSwarm app database, which only the Node hook reads (`node:sqlite`): without the file Node's
  // answer is fixed (no record, nothing live).
  appDbPresent: function (home) { var p = tk.appDbPath(home); return p !== null && ah.fs.isFile(p); },
};
