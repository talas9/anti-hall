// What counts as a file-changing action in a transcript (D88 batch 6): a translation of hooks/lib/work-detect.js (`isCountedWork` and
// what it calls). One definition, shared by the tasklist Stop gate and any check that judges work. A relative path is judged against
// the session's directory (the payload's `cwd`); where that cannot be settled (no usable directory) it counts as not under the temp
// root (counted, native_unable at `workdetect.*`). Keys: task_guards.toml (workdetect.*, taskkit.*).
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
    var out = [], single = false, dbl = false;
    for (var i = 0; i < cmd.length; i++) {
      var c = cmd.charAt(i), hasNext = i + 1 < cmd.length;
      if (single) { out.push(' '); if (c === "'") single = false; continue; }
      if (dbl) {
        if (c === '\\' && hasNext) { out.push('  '); i++; continue; }
        out.push(' ');
        if (c === '"') dbl = false;
        continue;
      }
      if (c === "'") { single = true; out.push(' '); } else if (c === '"') { dbl = true; out.push(' '); } else out.push(c);
    }
    return out.join('');
  },
  // A redirect to a file; one into the null device writes nothing (GH #459: `cmd >/dev/null` is not a file change).
  fileRedirect: function (s) {
    var kept = s.replace(/(?<![0-9&])>{1,2}(?!&)\s*(\S+)/g, function (m, target) { return wd.re('workdetect.dev_null').test(target) ? ' ' : m; });
    return /(?<![0-9&])>{1,2}(?!&)/.test(kept);
  },
  // The first command segment that makes a Bash command count as work (the whole command when none does alone): what the block names.
  workSegment: function (cmd) {
    var segs = cmd.split(/&&|\|\||;|\||\n/);
    for (var i = 0; i < segs.length; i++) { var g = segs[i].trim(); if (g && wd.bashWork(wd.neutralize(g))) return g; }
    return cmd;
  },
  bashWork: function (n) { return wd.re('workdetect.always_work', 'i').test(n) || wd.re('workdetect.command_position', 'i').test(n) || wd.fileRedirect(n); },
  isUnder: function (path, root) { return path === root || (path.indexOf(root) === 0 && path.charAt(root.length) === '/'); },
  // `isUnderTmpRoot(p)`.
  underTmp: function (p, cx) {
    if (!p) return false;
    if (p.charAt(0) === '/') return wd.isUnder(ah.path.resolveAbs(p), cx.tmp);
    if (!cx.cwd || cx.cwd.charAt(0) !== '/') { ah.unable('workdetect:relative_no_cwd'); return false; }
    return wd.isUnder(ah.path.resolve(cx.cwd, p), cx.tmp);
  },
  // The paths a session's ONE user request names (cx.requested: [{raw, abs}]), or [] when the session has more than one request,
  // none, or the window does not hold the whole transcript. A path that is, or holds, the session directory is not an output.
  requestedPaths: function (lines, cx, complete) {
    if (!complete) return [];
    var skip = ah.cfg('workdetect.request_skip_prefixes'), trim = ah.cfg('workdetect.request_path_trim'), count = 0, raws = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (raw.indexOf('"user"') < 0) continue;
      var r = jx.parse(raw.trim());
      if (r.unsure) { ah.unable('workdetect:request_line_unsure'); continue; }
      var e = r.v;
      if (r.invalid || !e || e.type !== 'user' || e.isMeta === true || !e.message) continue;
      var c = e.message.content, txt = '', isResult = false;
      if (typeof c === 'string') txt = c;
      else if (Array.isArray(c)) {
        for (var k = 0; k < c.length; k++) {
          if (c[k] && c[k].type === ah.cfg('task_guard.tool_result_type')) isResult = true;
          else if (c[k] && c[k].type === 'text' && typeof c[k].text === 'string') txt += (txt ? '\n' : '') + c[k].text;
        }
      }
      var head = txt.trim();
      if (isResult || !head || skip.some(function (x) { return head.indexOf(x) === 0; })) continue;
      count++;
      var re = wd.re('workdetect.request_path_re', 'g'), m;
      while ((m = re.exec(txt)) !== null) {
        var t = (m[1] || m[2] || '');
        while (t.length > 0 && trim.indexOf(t.charAt(t.length - 1)) >= 0) t = t.slice(0, -1);
        if (t.length > 1) raws.push(t);
      }
    }
    if (count !== 1) return [];
    var home = ah.home(), out = [];
    for (var j = 0; j < raws.length; j++) {
      var abs;
      if (raws[j].charAt(0) === '/') abs = ah.path.resolveAbs(raws[j]);
      else if (raws[j].charAt(0) === '~') { if (!home || (raws[j].length > 1 && raws[j].charAt(1) !== '/')) continue; abs = ah.path.resolveAbs(home + raws[j].slice(1)); }
      else if (cx.cwd) abs = ah.path.resolve(cx.cwd, raws[j]);
      else continue;
      if (abs === '/' || (cx.cwd && wd.isUnder(ah.path.resolveAbs(cx.cwd), abs))) continue;
      out.push({ raw: raws[j], abs: abs });
    }
    return out;
  },
  // Whether `fp` is, or is inside, a path the single user request named.
  inRequested: function (fp, cx) {
    if (!cx.requested || cx.requested.length === 0) return false;
    var abs;
    if (fp.charAt(0) === '/') abs = ah.path.resolveAbs(fp);
    else if (cx.cwd) abs = ah.path.resolve(cx.cwd, fp);
    else return false;
    return cx.requested.some(function (r) { return wd.isUnder(abs, r.abs); });
  },
  // `isExcludedWritePath(fp)`: the scratchpad, an anti-hall state directory, or a copy under the temp root.
  excludedWritePath: function (fp, cx) {
    if (!fp) return false;
    if (wd.inRequested(fp, cx)) return true;
    if (wd.re('workdetect.scratchpad_path').test(fp) || wd.re('workdetect.state_dir').test(fp)) return true;
    return wd.underTmp(fp, cx);
  },
  // A session whose working directory is the scratchpad writes relative paths there (hooks/lib/work-detect.js hasExcludedPathHint).
  cwdScratch: function (cx) { return !!cx && !!cx.cwd && wd.re('workdetect.scratchpad_path').test(cx.cwd + '/'); },
  pathHint: function (cmd, root, cx) {
    return wd.cwdScratch(cx) || !!cmd && ((cx.requested || []).some(function (r) { return cmd.indexOf(r.raw) >= 0 || cmd.indexOf(r.abs) >= 0; }) || wd.re('workdetect.scratchpad_path').test(cmd) || wd.re('workdetect.state_dir').test(cmd) || (!!root && cmd.indexOf(root) >= 0));
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
  // ---- the files a command writes (GH #794: the work count names real files, never command strings) ----
  // The command split into simple commands at `&&`, `||`, `;`, `|`, a newline, a lone `&`, a parenthesis, a backtick or `$(`, cut where the
  // quote-blanked copy shows the separator (a separator inside a quoted span is text).
  segments: function (cmd) {
    var n = wd.neutralize(cmd), out = [], from = 0, re = /&&|\|\||;|\||\n|(?<![<>&])&(?![&>])|\$\(|[()`]/g, m;
    while ((m = re.exec(n)) !== null) { out.push(cmd.slice(from, m.index)); from = m.index + m[0].length; }
    out.push(cmd.slice(from));
    return out;
  },
  // One simple command read as words and redirect targets: {words: [text], redirects: [text]}. Quotes are removed, a backslash escapes
  // the next character, fd redirects (`2>&1`, `>&2`) and input redirects (`< f`, `<<EOF`) name no written file.
  words: function (seg) {
    var words = [], redirects = [], cur = '', has = false, i = 0, len = seg.length;
    function flush() { if (has) words.push(cur); cur = ''; has = false; }
    function readWord() {
      while (i < len && /\s/.test(seg.charAt(i))) i++;
      var w = '', any = false;
      while (i < len && !/\s/.test(seg.charAt(i))) {
        var c = seg.charAt(i);
        if (c === "'") { i++; while (i < len && seg.charAt(i) !== "'") w += seg.charAt(i++); i++; any = true; }
        else if (c === '"') { i++; while (i < len && seg.charAt(i) !== '"') { if (seg.charAt(i) === '\\' && i + 1 < len) i++; w += seg.charAt(i++); } i++; any = true; }
        else if (c === '\\' && i + 1 < len) { w += seg.charAt(i + 1); i += 2; any = true; }
        else if (c === '>' || c === '<') break;
        else { w += c; i++; any = true; }
      }
      return any ? w : null;
    }
    while (i < len) {
      var ch = seg.charAt(i);
      if (/\s/.test(ch)) { flush(); i++; continue; }
      if (ch === '>') {
        if (has && !/^(?:\d*|&)$/.test(cur)) flush(); else { cur = ''; has = false; }
        i++;
        if (seg.charAt(i) === '>') i++;
        if (seg.charAt(i) === '|') i++;
        if (seg.charAt(i) === '&') { i++; readWord(); continue; }
        var t = readWord();
        if (t !== null) redirects.push(t);
        continue;
      }
      if (ch === '<') {
        flush(); i++;
        if (seg.charAt(i) === '<') { i++; if (seg.charAt(i) === '-' || seg.charAt(i) === '<') i++; }
        readWord();
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '\\') { var q = readWord(); if (q !== null) { cur += q; has = true; } continue; }
      cur += ch; has = true; i++;
    }
    flush();
    return { words: words, redirects: redirects };
  },
  // The file arguments of a git command that changes working-tree files by name (workdetect.git_write_subcommands): `rm`/`mv`/`restore` name
  // their files; `checkout` names them after `--`, or, with no `--`, as the arguments that are existing files (a branch or ref is not one).
  // `args`: the words after `git`; `dir`: the working directory. Returns the file words (unresolved).
  gitWrites: function (args, dir, vars) {
    var table = ah.cfg('workdetect.git_write_subcommands'), sub = '', at = -1;
    for (var i = 0; i < args.length; i++) {
      if (args[i] === '-C' || args[i] === '-c') { i++; continue; }
      if (args[i].charAt(0) === '-') continue;
      sub = args[i]; at = i; break;
    }
    var mode = at >= 0 && Object.prototype.hasOwnProperty.call(table, sub) ? table[sub] : '';
    if (mode === '') return [];
    var rest = args.slice(at + 1), dashes = rest.indexOf('--'), out = [];
    if (mode === 'dashes' && dashes >= 0) return rest.slice(dashes + 1);
    for (var j = 0; j < rest.length; j++) {
      var a = rest[j];
      if (a === '--source' || a === '-s') { j++; continue; }
      if (a === '--' || a === '' || a.charAt(0) === '-') continue;
      if (mode === 'dashes') {
        var e = wd.expand(a, vars);
        if (e === null) continue;
        var abs = e.charAt(0) === '/' ? e : (dir ? ah.path.resolve(dir, e) : '');
        if (abs === '' || ah.fs.kind(abs) !== 'file') continue;
      }
      out.push(a);
    }
    return out;
  },
  // `$NAME` / `${NAME}` and a leading `~` read against `vars` (and HOME); null when a variable is not known (the path is then not a path
  // this count can name).
  expand: function (w, vars) {
    var home = ah.home() || '', bad = false;
    var r = w.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, function (m, a, b) {
      var k = a || b;
      if (Object.prototype.hasOwnProperty.call(vars, k)) return vars[k];
      if (k === 'HOME' && home) return home;
      bad = true; return m;
    });
    if (bad || r.indexOf('$') >= 0) return null;
    if (r === '~' || r.indexOf('~/') === 0) { if (!home) return null; r = home + r.slice(1); }
    return r;
  },
  // Whether a git command (the words after `git`) is one of the subcommands that change files without naming them (workdetect.git_unknown_subcommands).
  gitUnknown: function (args) {
    var table = ah.cfg('workdetect.git_unknown_subcommands'), sub = '', at = -1;
    for (var i = 0; i < args.length; i++) {
      if (args[i] === '-C' || args[i] === '-c') { i++; continue; }
      if (args[i].charAt(0) === '-') continue;
      sub = args[i]; at = i; break;
    }
    if (at < 0 || !Object.prototype.hasOwnProperty.call(table, sub)) return false;
    var want = table[sub], rest = args.slice(at + 1);
    // a dry run or a check (`git apply --check`, `git clean -n`) changes nothing (workdetect.git_readonly_flag_res)
    var ro = ah.cfg('workdetect.git_readonly_flag_res');
    if (Object.prototype.hasOwnProperty.call(ro, sub) && rest.some(function (a) { return ro[sub].some(function (re) { return new RegExp(re).test(a); }); })) return false;
    if (want.indexOf('*') >= 0) return true;
    if (want.indexOf('<none>') >= 0 && rest.filter(function (a) { return a !== '' && a.charAt(0) !== '-'; }).length === 0) return true;
    return rest.some(function (a) { return want.indexOf(a) >= 0; });
  },
  // Whether a simple command (its words from the command word on) writes files it does not name: an indirect runner over a write verb, a
  // file-changing git subcommand, or a command of workdetect.unknown_write_res (matched case-sensitively: `-I` is not `-i`, `-C` is not `-c`),
  // minus the dry runs and listings of workdetect.unknown_write_readonly_res. Returns null when the command writes nothing unnamed, else
  // `{targets: [word]}`: the destination words the command does name (workdetect.unknown_write_targets; `[]` when it names none, so the
  // write counts as one unknown file), judged like any other write target (a device file, a path outside the project).
  unknownWrite: function (cw) {
    var verb = cw[0].slice(cw[0].lastIndexOf('/') + 1), verbs = ah.cfg('workdetect.bash_write_verbs'), rest = cw.slice(1);
    if (verb === 'git') return wd.gitUnknown(rest) ? { targets: [] } : null;
    if (ah.cfg('workdetect.indirect_verbs').indexOf(verb) >= 0) {
      var found = null;
      for (var k = 0; k < rest.length && found === null; k++) {
        var v = rest[k].slice(rest[k].lastIndexOf('/') + 1);
        if (!Object.prototype.hasOwnProperty.call(verbs, v)) continue;
        if (verbs[v] === 'sed' && !rest.some(function (a) { return /^-[A-Za-z]*i/.test(a) || a.indexOf('--in-place') === 0; })) continue;
        found = k;
      }
      if (found === null) return null;
      // `find -exec cp {} DEST \;`: the destination of a `last`-mode verb is named by the command that follows the verb
      var vv = rest[found].slice(rest[found].lastIndexOf('/') + 1), tail = [];
      if (verbs[vv] === 'last') {
        var ends = ah.cfg('workdetect.indirect_end_words'), skip = ah.cfg('workdetect.indirect_skip_words');
        for (var m = found + 1; m < rest.length; m++) {
          if (ends.indexOf(rest[m]) >= 0) break;
          if (rest[m] !== '' && rest[m].charAt(0) !== '-' && skip.indexOf(rest[m]) < 0) tail.push(rest[m]);
        }
        if (tail.length > 0) return { targets: [tail[tail.length - 1]] };
      }
      return { targets: [] };
    }
    var joined = cw.join(' '), res = ah.cfg('workdetect.unknown_write_res'), hit = false, i;
    for (i = 0; i < res.length && !hit; i++) if (new RegExp(res[i]).test(joined)) hit = true;
    if (!hit) return null;
    var ro = ah.cfg('workdetect.unknown_write_readonly_res');
    for (i = 0; i < ro.length; i++) if (new RegExp(ro[i]).test(joined)) return null;
    var how = ah.cfg('workdetect.unknown_write_targets');
    if (!Object.prototype.hasOwnProperty.call(how, verb)) return { targets: [] };
    var spec = how[verb], plain = rest.filter(function (a) { return a !== '' && a.charAt(0) !== '-' && a.indexOf('=') < 0; });
    for (i = 0; i < spec.length; i++) {
      var key = spec[i];
      if (key === 'last') { if (plain.length > 1) return { targets: [plain[plain.length - 1]] }; continue; }
      if (key.charAt(key.length - 1) === '=') {
        for (var a = 0; a < rest.length; a++) if (rest[a].indexOf(key) === 0) return { targets: [rest[a].slice(key.length)] };
        continue;
      }
      for (var b = 0; b < rest.length - 1; b++) if (rest[b] === key) return { targets: [rest[b + 1]] };
    }
    return { targets: [] };
  },
  // The files one command writes. Returns [{abs, seg, kind}]: `abs` is the absolute path (null for one the count cannot name), `kind` is
  // `redirect` (a `>`/`>>`/`&>` target with output), `redirect_empty` (`: > f`, a bare `> f`), `tee`, `dest` (the destination of `cp`/`mv`) or `verb` (a file argument of a write
  // verb, workdetect.bash_write_verbs). A write whose target cannot be named (an unknown variable, a relative path with no working
  // directory, `patch`, `git apply`, `xargs sed -i`, `git stash pop`...) is `{abs: null, kind: 'unknown'}`: it counts as ONE unknown project
  // file, never zero (GH #794: a write the count cannot see makes the session look stale, not idle).
  bashWrites: function (cmd, cx, depth) {
    var body = cmd;
    if (cmd.indexOf('<<') >= 0) { var st = wd.stripHeredocBodies(cmd); if (st !== null) body = st; }
    var verbs = ah.cfg('workdetect.bash_write_verbs'), wrappers = ah.cfg('workdetect.bash_wrappers'), builtins = ah.cfg('workdetect.assign_builtins');
    var shells = ah.cfg('workdetect.shell_verbs'), emptyVerbs = ah.cfg('workdetect.empty_redirect_verbs'), out = [], vars = {};
    var segs = wd.segments(body), dir = cx.cwd, level = depth || 0;
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (!seg.trim()) continue;
      var rw = wd.words(seg), words = rw.words, targets = [];
      rw.redirects.forEach(function (t) { targets.push({ t: t, kind: 'redirect' }); });
      // leading NAME=value assignments (kept for later segments of the same command; `export NAME=value` too), then wrapper words
      var at = 0;
      for (;;) {
        if (at < words.length && /^[A-Za-z_]\w*=/.test(words[at])) {
          var eq = words[at].indexOf('=');
          var val = wd.expand(words[at].slice(eq + 1), vars);
          if (val !== null) vars[words[at].slice(0, eq)] = val;
          at++;
        } else if (at < words.length && builtins.indexOf(words[at]) >= 0) at++;
        else break;
      }
      while (at < words.length && wrappers.indexOf(words[at]) >= 0) at++;
      // `cd <dir>`: the segments after it run there (null when the directory cannot be told: a relative path is then not named)
      if (at < words.length && words[at] === 'cd') {
        var cdArg = words.slice(at + 1).filter(function (a) { return a.charAt(0) !== '-' || a === '-'; })[0];
        var cdTo = cdArg === undefined ? null : wd.expand(cdArg, vars);
        if (cdTo === null || cdTo === '-') dir = null;
        else if (cdTo.charAt(0) === '/') dir = ah.path.resolveAbs(cdTo);
        else dir = dir ? ah.path.resolve(dir, cdTo) : null;
        continue;
      }
      var unknown = false, nested = null;
      if (at >= words.length) targets.forEach(function (x) { x.kind = 'redirect_empty'; }); // a bare `> f` truncates
      if (at < words.length) {
        var verb = words[at].slice(words[at].lastIndexOf('/') + 1), mode = Object.prototype.hasOwnProperty.call(verbs, verb) ? verbs[verb] : '';
        var args = words.slice(at + 1);
        if (rw.redirects.length > 0 && (emptyVerbs.indexOf(verb) >= 0)) targets.forEach(function (x) { x.kind = 'redirect_empty'; });
        if (shells.indexOf(verb) >= 0) {
          // `bash -c 'cmd'`: the script is read for its own writes (down to shell_depth_max levels), else it counts as one unknown file
          var ci = -1;
          for (var q = 0; q < args.length; q++) if (/^-[A-Za-z]*c[A-Za-z]*$/.test(args[q])) { ci = q; break; }
          if (ci >= 0 && ci + 1 < args.length) {
            if (level < ah.cfgNum('workdetect.shell_depth_max')) nested = wd.bashWrites(args[ci + 1], { cwd: dir }, level + 1);
            else unknown = true;
          }
        } else if (mode === 'sed') {
          var inplace = args.some(function (a) { return /^-[A-Za-z]*i/.test(a) || a.indexOf('--in-place') === 0; });
          if (!inplace) mode = '';
          else {
            var scripted = false, rest = [];
            for (var k = 0; k < args.length; k++) {
              if (args[k] === '-e' || args[k] === '-f' || args[k] === '--expression' || args[k] === '--file') { scripted = true; k++; continue; }
              if (args[k] !== '' && (args[k].charAt(0) !== '-' || args[k] === '-')) rest.push(args[k]);
            }
            args = scripted ? rest : rest.slice(1);
            mode = 'all';
          }
        } else if (mode !== '') {
          // `cp -t DIR files`: the destination is the directory named by the option, not the last argument
          var tdir = null;
          if (mode === 'last') {
            for (var m = 0; m < args.length; m++) {
              if ((args[m] === '-t' || args[m] === '--target-directory') && m + 1 < args.length) { tdir = args[m + 1]; break; }
              if (args[m].indexOf('--target-directory=') === 0) { tdir = args[m].slice('--target-directory='.length); break; }
            }
          }
          args = args.filter(function (a) { return a !== '--' && !(a.charAt(0) === '-' && a.length > 1); });
          if (tdir !== null) {
            // each source lands in the directory under its own name: N files are N writes
            var srcs = args.filter(function (a) { return a !== tdir; }), base = tdir.replace(/\/+$/, '');
            args = srcs.length > 0 ? srcs.map(function (a) { return base + '/' + a.slice(a.lastIndexOf('/') + 1); }) : [tdir];
          }
          else if (mode === 'last') args = args.slice(-1);
          else if (mode === 'rest') args = args.slice(1);
        }
        if (mode !== '' && nested === null) {
          var destVerb = ah.cfg('workdetect.progress_dest_verbs').indexOf(verb) >= 0;
          args.forEach(function (a, idx) { targets.push({ t: a, kind: verb === 'tee' ? 'tee' : destVerb && idx === args.length - 1 ? 'dest' : 'verb' }); });
        }
        else if (verb === 'git') wd.gitWrites(args, dir, vars).forEach(function (a) { targets.push({ t: a, kind: 'verb' }); });
        else if (nested === null && mode === '') {
          var uw = wd.unknownWrite(words.slice(at));
          if (uw !== null) {
            if (uw.targets.length === 0) unknown = true;
            else uw.targets.forEach(function (a) { targets.push({ t: a, kind: 'verb' }); });
          }
        }
        if (verb === 'git' && wd.gitUnknown(args) && targets.length === rw.redirects.length) unknown = true;
      }
      var named = 0;
      for (var j = 0; j < targets.length; j++) {
        var e = wd.expand(targets[j].t, vars);
        if (e === '' || e === '-') continue;
        if (e === null) { unknown = true; continue; }
        var abs;
        if (e.charAt(0) === '/') abs = ah.path.resolveAbs(e);
        else if (dir) abs = ah.path.resolve(dir, e);
        else { ah.unable('workdetect:relative_no_cwd'); unknown = true; continue; }
        out.push({ abs: abs, seg: seg.trim(), kind: targets[j].kind });
        named++;
      }
      if (nested !== null) nested.forEach(function (w) { out.push(w); });
      if (unknown) out.push({ abs: null, seg: seg.trim(), kind: 'unknown' });
    }
    return out;
  },
  // Whether a written path is project work the tasklist gate counts: not the scratchpad, anti-hall's own progress/history/handover files,
  // the request's TMPDIR or a path named by the one user request (excludedWritePath), and not a device file (workdetect.excluded_path_res).
  // With a known project root (cx.root) a path outside the project and the session's directory is not project work either: all of them with
  // guards.tasklistProjectOnly on (cx.projectOnly), else those under a temp directory (workdetect.excluded_outside_res). A path inside
  // the project is never excluded by a temp pattern, so a project that lives under a temp directory keeps its own files.
  countablePath: function (abs, cx) {
    if (!abs) return false;
    var always = ah.cfg('workdetect.excluded_path_res');
    for (var i = 0; i < always.length; i++) if (new RegExp(always[i]).test(abs)) return false;
    // a path INSIDE the project is never excluded by where it lives (a project under TMPDIR, a subdirectory named `scratchpad`): only
    // anti-hall's own bookkeeping files (workdetect.state_dir) and what the one user request names are left out there
    if (cx.root && (wd.isUnder(abs, cx.root) || (cx.cwd && wd.isUnder(abs, cx.cwd)))) {
      return !(wd.inRequested(abs, cx) || wd.re('workdetect.state_dir').test(abs));
    }
    if (wd.excludedWritePath(abs, cx)) return false;
    if (!cx.root) return true;
    if (cx.projectOnly) return false;
    var outside = ah.cfg('workdetect.excluded_outside_res');
    for (var j = 0; j < outside.length; j++) if (new RegExp(outside[j]).test(abs)) return false;
    return true;
  },
  // Whether one write of `bashWrites` is project work: an unknown one is (counted as one file), a shell redirect into a log file is not
  // (workdetect.excluded_redirect_res), any other is judged by its path.
  countableWrite: function (w, cx) {
    if (w.kind === 'unknown') return true;
    if (w.kind === 'redirect' || w.kind === 'redirect_empty') {
      var logs = ah.cfg('workdetect.excluded_redirect_res');
      for (var i = 0; i < logs.length; i++) if (new RegExp(logs[i], 'i').test(w.abs)) return false;
    }
    return wd.countablePath(w.abs, cx);
  },
  // Whether a tool use writes at least one project file (the file-based count, GH #794): an Edit/Write path or a Bash command's write targets
  // (wd.bashWrites), judged by wd.countablePath. Shared by every check that asks "was there real work after time T".
  countedFiles: function (tu, cx) {
    var name = tu.name && typeof tu.name === 'string' ? tu.name : '', input = tu.input ? tu.input : null;
    if (ah.cfg('workdetect.never_work_tools').indexOf(name) >= 0) return false;
    if (ah.cfg('workdetect.mutating_tools').indexOf(name) >= 0) {
      var fp = input && typeof input.file_path === 'string' ? input.file_path : '';
      if (!fp) return false;
      if (fp.charAt(0) !== '/' && !cx.cwd) return false;
      return wd.countablePath(fp.charAt(0) === '/' ? ah.path.resolveAbs(fp) : ah.path.resolve(cx.cwd, fp), cx);
    }
    if (name !== 'Bash') return false;
    var cmd = input && typeof input.command === 'string' ? input.command : '';
    if (!cmd || wd.housekeepingOnly(cmd)) return false;
    return wd.bashWrites(cmd, cx).some(function (w) { return wd.countableWrite(w, cx); });
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
      // a session that only integrates (merges, cherry-picks, switches) what delegated workers committed made no edit of its own
      if (cx.skipIntegration) {
        var rest = n.replace(wd.re('workdetect.integration_work', 'ig'), ' ');
        if (rest !== n && !wd.bashWork(rest)) { cx.integrationSkipped = (cx.integrationSkipped || 0) + 1; return false; }
      }
      var scratchOnly = wd.pathHint(cmd, cx.tmp, cx) && !wd.re('workdetect.always_work', 'i').test(n) && wd.allPathsExcluded(n, cx);
      return !scratchOnly;
    }
    return false;
  },
};
