// OMC / OMX coexistence facts shared by the checks that must agree on whether the OMC plugin is on (GH #981): edit-guard (a new
// handover under a foreign plugin's folder while that plugin is off), auto-handover-pause-nag (quiet while an OMC loop runs) and
// compact-advice-guard (defer to OMC's own context guard). Read-only: nothing here writes. The OMC plugin switch and loop
// state are read with task-guard's keys (task_guard.omc_*), so every check agrees on when OMC is on; keys of this lib: omc_coexist.*.
'use strict';
var omcx = {
  smallJson: function (path, max) {
    var size = ah.fs.size(path);
    if (size === null || size > max) return { none: true };
    var f = jx.read(path);
    if (f.text === undefined) return { none: true };
    var r = jx.parse(f.text);
    if (r.unsure) return { unsure: true };
    return r.invalid ? { none: true } : { v: r.v };
  },
  // A project directory the files may be read under: an absolute path without `.` or `..` segments, else null (only the home's files are read).
  cwdOk: function (cwd, tag) {
    if (typeof cwd !== 'string' || cwd === '') return null;
    if (cwd.charAt(0) !== '/' || cwd.split('/').some(function (s) { return s === '.' || s === '..'; })) { ah.unable(tag + ':omc_relative_cwd'); return null; }
    return cwd;
  },
  // True when the OMC plugin is enabled in the user's or the project's Claude Code settings (enabledPlugins), and not switched off by its env kill switch.
  enabled: function (home, cwd, tag) {
    if (ah.env.get(ah.cfg('task_guard.omc_disable_env')) === ah.cfg('task_guard.omc_disable_value')) return false;
    var dir = ah.cfg('task_guard.omc_claude_dir');
    var files = home ? [home + '/' + dir + '/' + ah.cfg('task_guard.omc_settings_file')] : [];
    cwd = omcx.cwdOk(cwd, tag);
    if (cwd) ah.cfg('task_guard.omc_project_settings').forEach(function (f) { files.push(cwd + '/' + dir + '/' + f); });
    for (var i = 0; i < files.length; i++) {
      var r = omcx.smallJson(files[i], ah.cfgNum('task_guard.omc_settings_max_bytes'));
      if (r.unsure) { ah.unable(tag + ':omc_settings_unsure'); continue; }
      if (r.none) continue;
      var plugins = jx.field(r.v, ah.cfg('task_guard.omc_plugins_key'));
      if (plugins && plugins[ah.cfg('task_guard.omc_plugin_id')] === true) return true;
    }
    return false;
  },
  // Whether the plugin named by a foreign-path owner (omc_coexist.owner_omc, ...) is on. An owner with no detector is never on.
  ownerEnabled: function (owner, home, cwd, tag) {
    if (owner === ah.cfg('omc_coexist.owner_omc')) return omcx.enabled(home, cwd, tag);
    return false;
  },
  // True while an OMC autonomous loop (ralph, ultrawork, autopilot, team ...) is active for this session: task-guard's tgOmcActive.
  loopActive: function (home, cwd, sid, now, tag) {
    var skip = ah.env.get(ah.cfg('task_guard.omc_skip_env')) || '';
    if (skip.split(',').some(function (s) { return s.trim() === ah.cfg('task_guard.omc_skip_token'); })) return false;
    if (!omcx.enabled(home, cwd, tag)) return false;
    cwd = omcx.cwdOk(cwd, tag);
    var rel = ah.cfg('task_guard.omc_state_dir').join('/');
    var root = cwd && ah.fs.isDir(cwd + '/' + rel) ? cwd + '/' + rel : home + '/' + rel;
    var files = ah.cfg('task_guard.omc_state_files');
    for (var i = 0; i < files.length; i++) {
      var r = omcx.smallJson(root + '/' + files[i], ah.cfgNum('task_guard.omc_state_max_bytes'));
      if (r.unsure) { ah.unable(tag + ':omc_state_unsure'); continue; }
      if (r.none || !jx.isObj(r.v) || r.v[ah.cfg('task_guard.omc_active_key')] !== true) continue;
      var found = false, keys = ah.cfg('task_guard.omc_ts_keys');
      for (var k = 0; k < keys.length && !found; k++) {
        var v = r.v[keys[k]], n = 0;
        if (typeof v === 'number') n = v;
        else if (typeof v === 'string') { n = jx.isoMs(v); if (n === undefined) { ah.unable(tag + ':omc_ts_form'); n = 0; } }
        if (!isFinite(n)) n = 0;
        if (n > 0 && now - n <= ah.cfgNum('task_guard.omc_fresh_ms')) found = true;
      }
      if (!found) continue;
      var s = r.v[ah.cfg('task_guard.omc_session_key')];
      if (s === undefined || s === null) return true;
      if (sid && String(s) === sid) return true;
    }
    return false;
  },
  // OMC's own Stop context guard blocked this session within omc_coexist.guard_recent_ms: its per-session block counter file was written
  // that recently (the file holds only a count, so its modification time is the block time).
  guardBlockedRecently: function (home, sid, now) {
    if (!sid || !new RegExp(ah.cfg('omc_coexist.guard_sid_re')).test(sid)) return false;
    var spec = ah.cfg('omc_coexist.guard_file');
    var m = ah.fs.mtimeMs(home + '/' + spec.dir + '/' + spec.prefix + sid + spec.ext);
    return m !== null && now - m >= 0 && now - m <= ah.cfgNum('omc_coexist.guard_recent_ms');
  }
};
