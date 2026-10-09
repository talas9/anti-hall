// What counts as a file-changing action in a transcript (D88 batch 6): a translation of hooks/lib/work-detect.js (`isCountedWork` and
// what it calls). One definition, shared by the tasklist Stop gate and any check that judges work. A relative path is judged against
// the session's directory (the payload's `cwd`); where that cannot be settled (a path that climbs out, a session directory under the
// temp root, no directory at all) the call throws `wd.UNSURE` and the check defers. Keys: task_guards.toml (workdetect.*, taskkit.*).
'use strict';
var wd = {
  UNSURE: { unsure: true },
  // `os.tmpdir()` of the request's environment.
  tmpdir: function () {
    var names = ah.cfg('taskkit.tmp_env_names'), p = '/tmp';
    for (var i = 0; i < names.length; i++) { var v = ah.env.get(names[i]); if (v) { p = v; break; } }
    return p.length > 1 && p.slice(-1) === '/' ? p.slice(0, -1) : p;
  },
  re: function (key, flags) { return jx.re(key, flags); },
  // Blank the contents of single- and double-quoted spans (delimiters included).
  neutralize: function (cmd) {
    var out = '', single = false, dbl = false;
    for (var i = 0; i < cmd.length; i++) {
      var c = cmd.charAt(i), hasNext = i + 1 < cmd.length;
      if (single) { out += ' '; if (c === "'") single = false; continue; }
      if (dbl) {
        if (c === '\\' && hasNext) { out += '  '; i++; continue; }
        out += ' ';
        if (c === '"') dbl = false;
        continue;
      }
      if (c === "'") { single = true; out += ' '; } else if (c === '"') { dbl = true; out += ' '; } else out += c;
    }
    return out;
  },
  fileRedirect: function (s) { return /(?<![0-9&])>{1,2}(?!&)/.test(s); },
  bashWork: function (n) { return wd.re('workdetect.always_work', 'i').test(n) || wd.re('workdetect.command_position', 'i').test(n) || wd.fileRedirect(n); },
  isUnder: function (path, root) { return path === root || (path.indexOf(root) === 0 && path.charAt(root.length) === '/'); },
  // `isUnderTmpRoot(p)`.
  underTmp: function (p, cx) {
    if (!p) return false;
    if (p.charAt(0) === '/') return wd.isUnder(ah.path.resolveAbs(p), cx.tmp);
    if (!cx.cwd || cx.cwd.charAt(0) !== '/') throw wd.UNSURE;
    if (p.split('/').indexOf('..') >= 0 || wd.isUnder(ah.path.resolveAbs(cx.cwd), cx.tmp)) throw wd.UNSURE;
    return false;
  },
  // `isExcludedWritePath(fp)`: the scratchpad, an anti-hall state directory, or a copy under the temp root.
  excludedWritePath: function (fp, cx) {
    if (!fp) return false;
    if (wd.re('workdetect.scratchpad_path').test(fp) || wd.re('workdetect.state_dir').test(fp)) return true;
    return wd.underTmp(fp, cx);
  },
  pathHint: function (cmd, root) {
    return !!cmd && (wd.re('workdetect.scratchpad_path').test(cmd) || wd.re('workdetect.state_dir').test(cmd) || (!!root && cmd.indexOf(root) >= 0));
  },
  allPathsExcluded: function (n, cx) {
    var toks = n.split(/\s+/).filter(Boolean);
    for (var i = 0; i < toks.length; i++) if (toks[i].indexOf('/') >= 0 && !wd.excludedWritePath(toks[i], cx)) return false;
    return true;
  },
  // `segmentEscapesHousekeeping(seg)`.
  escapesHousekeeping: function (seg) {
    var n = wd.neutralize(seg);
    if (n.indexOf('$(') >= 0 || n.indexOf('`') >= 0) return true;
    var m = /(?<![0-9&])>{1,2}(?!&)\s*(\S+)/.exec(n);
    return m ? !wd.re('workdetect.dev_null').test(m[1]) && !wd.re('workdetect.tmp_housekeeping_target', 'i').test(m[1]) : false;
  },
  // The command without heredoc bodies, or null when a body holds a command substitution.
  stripHeredocBodies: function (cmd) {
    var out = [], delim = null, lines = cmd.split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (delim !== null) {
        if (line.indexOf('$(') >= 0 || line.indexOf('`') >= 0) return null;
        if (line.trim() === delim) delim = null;
        continue;
      }
      out.push(line);
      var neutral = wd.neutralize(line), hash = -1;
      for (var i = 0; i < neutral.length; i++) if (neutral.charAt(i) === '#' && (i === 0 || /\s/.test(neutral.charAt(i - 1)))) { hash = i === 0 ? 0 : i - 1; break; }
      var code = hash >= 0 ? line.slice(0, hash) : line, scan = hash >= 0 ? neutral.slice(0, hash) : neutral, at = -1;
      for (var k = 0; k + 1 < scan.length; k++) {
        if (scan.charAt(k) === '<' && scan.charAt(k + 1) === '<' && !(k > 0 && scan.charAt(k - 1) === '<') && scan.charAt(k + 2) !== '<') {
          var bs = 0;
          while (k > bs && scan.charAt(k - 1 - bs) === '\\') bs++;
          if (bs % 2 === 0) { at = k; break; }
        }
      }
      if (at < 0) continue;
      var m = wd.re('workdetect.heredoc_delimiter').exec(code.slice(at));
      if (m) delim = m[1].replace(/\\([^\n\r\u2028\u2029])|['"]/g, function (_, c) { return c || ''; });
    }
    return out.join('\n');
  },
  // `isDevswarmHousekeepingOnly(rawCmd)`: every segment is a DevSwarm launcher verb or a crontab call, with no escaping write.
  housekeepingOnly: function (raw) {
    if (!raw) return false;
    var cmd = raw;
    if (raw.indexOf('<<') >= 0) { cmd = wd.stripHeredocBodies(raw); if (cmd === null) return false; }
    var segs = cmd.split(/&&|\|\||;|\||\n|(?<![<>])&(?!>)/), saw = false;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i].trim();
      if (!s) continue;
      saw = true;
      var cron = wd.re('workdetect.crontab_segment', 'i').exec(s);
      var isCron = cron !== null && !/[A-Za-z0-9_.-]/.test(s.charAt(cron[0].length));
      if (!wd.re('workdetect.devswarm_housekeeping', 'i').test(s) && !isCron) return false;
      if (wd.escapesHousekeeping(s)) return false;
    }
    return saw;
  },
  // `isCountedWork(tu)` for a tool-use block.
  counted: function (tu, cx) {
    var name = tu.name && typeof tu.name === 'string' ? tu.name : '';
    if (ah.cfg('workdetect.never_work_tools').indexOf(name) >= 0) return false;
    var input = tu.input ? tu.input : null;
    if (ah.cfg('workdetect.mutating_tools').indexOf(name) >= 0) {
      var fp = input && typeof input.file_path === 'string' ? input.file_path : '';
      return !wd.excludedWritePath(fp, cx);
    }
    if (name === 'Bash') {
      var cmd = input && typeof input.command === 'string' ? input.command : '';
      if (!cmd || wd.housekeepingOnly(cmd)) return false;
      var n = wd.neutralize(cmd);
      if (!wd.bashWork(n)) return false;
      var scratchOnly = wd.pathHint(cmd, cx.tmp) && !wd.re('workdetect.always_work', 'i').test(n) && wd.allPathsExcluded(n, cx);
      return !scratchOnly;
    }
    return false;
  },
};
