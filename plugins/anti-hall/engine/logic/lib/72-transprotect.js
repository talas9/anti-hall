// Transcript protection (GH #802): whether a path, or a Bash command's write, reaches a session transcript. Shared by command-guard
// (Bash) and edit-guard (Edit/Write/MultiEdit/NotebookEdit/apply_patch). Every table, pattern and text: transcript_protect.toml.
// Bash write targets come from the shared parser (wd.bashWrites, lib/72-workdetect.js), so write detection is one definition.
'use strict';
var tp = {
  homes: function () {
    var h = ah.home() || '', out = [];
    if (h) {
      out.push(h);
      var r = ah.fs.realpathEx(h);
      if (r && r.path && r.path !== h) out.push(r.path);
    }
    return out;
  },
  flags: function () { return ah.cfg('transcript_protect.case_insensitive') ? 'i' : ''; },
  fold: function (s) { return ah.cfg('transcript_protect.case_insensitive') ? s.toLowerCase() : s; },
  esc: function (s) { return s.replace(/[.+^${}()|[\]\\\/]/g, '\\$&'); },
  // a glob (`*` one part, `**` any depth, `?` one character) as a regular expression source
  globRe: function (g) {
    var out = '', i = 0;
    while (i < g.length) {
      var c = g.charAt(i);
      if (c === '*') {
        if (g.charAt(i + 1) === '*') {
          if (g.charAt(i + 2) === '/') { out += '(?:.*/)?'; i += 3; } else { out += '.*'; i += 2; }
        } else { out += '[^/]*'; i++; }
      } else if (c === '?') { out += '[^/]'; i++; } else { out += tp.esc(c); i++; }
    }
    return out;
  },
  // {res: [RegExp], roots: [dir], exact: [path]} for this payload: the protected globs under every spelling of the home, and the payload's own transcript
  build: function (payload) {
    var homes = tp.homes(), globs = ah.cfg('transcript_protect.globs'), f = tp.flags(), pat = { res: [], roots: [], exact: [] };
    globs.forEach(function (g) {
      var variants = [];
      if (g.charAt(0) === '~') homes.forEach(function (h) { variants.push(h + g.slice(1)); }); else variants.push(g);
      variants.forEach(function (v) {
        pat.res.push(new RegExp('^' + tp.globRe(v) + '$', f));
        var cut = v.search(/[*?]/), pre = cut < 0 ? v : v.slice(0, cut);
        if (cut >= 0) pre = pre.slice(0, pre.lastIndexOf('/'));
        if (pre) pat.roots.push(tp.fold(pre.replace(/\/+$/, '')));
      });
    });
    var t = payload && typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    if (t && t.charAt(0) === '/') {
      var abs = ah.path.resolveAbs(t), r = tp.real(abs);
      pat.exact.push(tp.fold(abs));
      if (r && r !== abs) pat.exact.push(tp.fold(r));
    }
    return pat;
  },
  // the canonical path of an existing file, or of a new one under an existing directory; null when neither exists
  real: function (abs) {
    var r = ah.fs.realpathEx(abs);
    if (r && r.path) return r.path;
    var at = abs.lastIndexOf('/');
    if (at <= 0) return null;
    var d = ah.fs.realpathEx(abs.slice(0, at));
    return d && d.path ? d.path + abs.slice(at) : null;
  },
  forms: function (abs) {
    var out = [abs], r = tp.real(abs);
    if (r && r !== abs) out.push(r);
    return out;
  },
  // whether an absolute path (as spelled, or through its links) is a protected transcript path
  isProtected: function (abs, pat) {
    var fs = tp.forms(abs);
    for (var i = 0; i < fs.length; i++) {
      if (pat.exact.indexOf(tp.fold(fs[i])) >= 0) return true;
      for (var j = 0; j < pat.res.length; j++) if (pat.res[j].test(fs[i])) return true;
    }
    return false;
  },
  // whether an absolute path is inside a protected folder (not the folder itself)
  insideRoot: function (abs, pat) {
    var fs = tp.forms(abs);
    for (var i = 0; i < fs.length; i++) {
      var f = tp.fold(fs[i]);
      for (var j = 0; j < pat.roots.length; j++) if (f.indexOf(pat.roots[j] + '/') === 0) return true;
    }
    return false;
  },
  // whether an absolute path is a protected folder or one of its parents (a remove or move of it takes the transcripts along)
  isParent: function (abs, pat) {
    var fs = tp.forms(abs);
    for (var i = 0; i < fs.length; i++) {
      var f = tp.fold(fs[i].replace(/\/+$/, ''));
      for (var j = 0; j < pat.roots.length; j++) if (pat.roots[j] === f || pat.roots[j].indexOf(f + '/') === 0) return true;
    }
    // a folder under a protected root (a project folder, a session's tool-results folder) that holds a protected file: among its own files
    // (always read, by name: a project folder holds its transcripts), or anywhere below it (the budgeted walk)
    if (!tp.insideRoot(abs, pat) || !ah.fs.isDir(abs)) return false;
    var dir = abs.replace(/\/+$/, ''), names = ah.fs.readdir(dir) || [];
    for (var k = 0; k < names.length; k++) {
      var p = tp.fold(dir + '/' + names[k]);
      if (pat.exact.indexOf(p) >= 0 || pat.res.some(function (r) { return r.test(p); })) return true;
    }
    return tp.contains(abs, pat);
  },
  // whether a folder holds a protected file at any depth. One budget per command (transcript_protect.walk_max_entries entries and
  // walk_budget_ms of time, shared by every folder the command names, kept on `pat`): past it, or below walk_max_depth, the walk FAILS OPEN
  // (the folder counts as holding none). A folder's own files are checked before its subfolders are entered.
  contains: function (dir, pat) {
    if (!pat.walk) pat.walk = { left: ah.cfg('transcript_protect.walk_max_entries'), until: ah.clock.now() + ah.cfg('transcript_protect.walk_budget_ms') };
    var budget = pat.walk, maxDepth = ah.cfg('transcript_protect.walk_max_depth');
    var walk = function (d, depth) {
      var names = ah.fs.readdir(d) || [], subs = [], i;
      for (i = 0; i < names.length; i++) {
        if (--budget.left < 0 || ah.clock.now() > budget.until) return false;
        var p = d + '/' + names[i];
        if (tp.isProtected(p, pat)) return true;
        if (ah.fs.isDir(p)) subs.push(p);
      }
      if (depth >= maxDepth) return false;
      for (i = 0; i < subs.length; i++) if (walk(subs[i], depth + 1)) return true;
      return false;
    };
    return walk(dir.replace(/\/+$/, ''), 0);
  },
  // a file_path of an edit tool as an absolute path (`~` is the home; a relative path is under `cwd`); null when it cannot be named
  resolve: function (fp, cwd) {
    if (typeof fp !== 'string' || fp === '') return null;
    if (fp === '~' || fp.indexOf('~/') === 0) { var h = ah.home() || ''; if (!h) return null; fp = h + fp.slice(1); }
    if (fp.charAt(0) === '/') return ah.path.resolveAbs(fp);
    return typeof cwd === 'string' && cwd.charAt(0) === '/' ? ah.path.resolve(cwd, fp) : null;
  },
  // Does an edit tool's target (a file_path) reach a transcript?
  editHit: function (fp, payload) {
    var abs = tp.resolve(fp, payload && payload.cwd);
    return abs !== null && tp.isProtected(abs, tp.build(payload));
  },
  // the command word (past leading NAME=value words and wrappers) and its non-option words, of one command part
  parts: function (seg) {
    var ws = wd.words(seg).words, wr = ah.cfg('workdetect.bash_wrappers'), at = 0;
    while (at < ws.length && (/^[A-Za-z_]\w*=/.test(ws[at]) || wr.indexOf(ws[at]) >= 0)) at++;
    if (at >= ws.length) return null;
    var args = ws.slice(at + 1);
    return { verb: ws[at].slice(ws[at].lastIndexOf('/') + 1), args: args, plain: args.filter(function (a) { return a !== '' && a !== '--' && a.charAt(0) !== '-'; }) };
  },
  // whether a folder directly holds a protected file (a project folder holds its transcripts; a memory folder holds notes)
  holds: function (dir, pat) {
    var names = ah.fs.readdir(dir) || [];
    for (var i = 0; i < names.length; i++) if (tp.isProtected(dir + '/' + names[i], pat)) return true;
    return false;
  },
  // `ln -s <source> <link>`: a link made inside a protected folder or to a transcript (or to a folder that holds transcripts, or the folder
  // that holds the projects) is a way round this check: a later write through it reaches a transcript (the link does not exist yet when the
  // command is judged). A link to a memory folder, or a link made elsewhere to something else, is not.
  linksTo: function (seg, pat) {
    var p = tp.parts(seg);
    if (p === null || p.plain.length < 2) return false;
    var link = wd.expand(p.plain[p.plain.length - 1], {}), srcs = p.plain.slice(0, -1), i;
    if (link !== null && link.charAt(0) === '/') {
      var la = ah.path.resolveAbs(link), dir = /\/$/.test(p.plain[p.plain.length - 1]) || ah.fs.isDir(la);
      if (tp.isProtected(la, pat)) return true;
      if (dir) for (i = 0; i < srcs.length; i++) if (tp.isProtected(la + '/' + srcs[i].replace(/\/+$/, '').replace(/^.*\//, ''), pat)) return true;
    }
    for (i = 0; i < srcs.length; i++) {
      var e = wd.expand(srcs[i], {});
      if (e === null || e.charAt(0) !== '/') continue;
      var abs = ah.path.resolveAbs(e);
      if (tp.isProtected(abs, pat) || tp.isParent(abs, pat)) return true;
      if (tp.insideRoot(abs, pat) && ah.fs.isDir(abs) && tp.holds(abs, pat)) return true;
    }
    return false;
  },
  // `cp`/`mv`/`rsync`/`ditto <sources> <folder>/` and `tar -x -C <folder>` / `unzip -d <folder>`: a file that lands IN a protected folder under
  // its own name. `w` is the last write the parser named in this command part: the destination.
  dirDest: function (seg, w, pat) {
    var p = tp.parts(seg);
    if (p === null) return false;
    var probe = w.abs + '/' + ah.cfg('transcript_protect.probe_name'), joined = [p.verb].concat(p.args).join(' ');
    if (ah.cfg('transcript_protect.extract_res').some(function (r) { return new RegExp(r).test(joined); })) return tp.isProtected(probe, pat);
    if (ah.cfg('transcript_protect.copy_verbs').indexOf(p.verb) < 0 || p.plain.length < 2) return false;
    // `cp -t DIR files`: the parser already names each file under DIR
    if (p.verb !== 'rsync' && p.args.some(function (a) { return a === '-t' || a.indexOf('--target-directory') === 0; })) return false;
    var dest = p.plain[p.plain.length - 1], srcs = p.plain.slice(0, -1);
    if (wd.remoteTarget(dest) || !(/(?:^|\/)\.?\/?$/.test(dest) || ah.fs.isDir(w.abs))) return false;
    var rec = ah.cfg('transcript_protect.recursive_opt_res').map(function (r) { return new RegExp(r); });
    if (p.args.some(function (a) { return a.charAt(0) === '-' && rec.some(function (r) { return r.test(a); }); }) || srcs.some(function (x) { return /(?:^|\/)\.?\/?$/.test(x); })) return tp.isProtected(probe, pat);
    for (var i = 0; i < srcs.length; i++) {
      var base = srcs[i].replace(/\/+$/, '').replace(/^.*\//, '');
      if (base !== '' && tp.isProtected(w.abs + '/' + base, pat)) return true;
    }
    return false;
  },
  // A write whose target the parser cannot name (`perl -pi`, `find -delete`, `truncate $(...)`): blocked when a word of its command part
  // names a protected folder mention (transcript_protect.anchors) that is, or holds, a protected path, or cannot be resolved (a glob, an
  // unknown variable). A part whose every such word is a plain non-protected path (`perl -pi -e .. <memory note>`) is allowed.
  unnamedHit: function (seg, pat, vars) {
    var ws = wd.words(seg).words;
    for (var i = 0; i < ws.length; i++) {
      if (tp.anchorAt(ws[i]) < 0) continue;
      var e = /[*?[]/.test(ws[i]) ? null : wd.expand(ws[i], vars);
      if (e === null || e.charAt(0) !== '/') return true;
      var abs = ah.path.resolveAbs(e);
      if (tp.isProtected(abs, pat) || tp.isParent(abs, pat)) return true;
    }
    return false;
  },
  // `NAME=value` shell assignments of a command, expanded in order (`S=~/scratch; F=$S/x`), for the literal check
  shellVars: function (command) {
    var vars = {}, re = /(?:^|[\s;&|(])([A-Za-z_]\w*)=((?:"[^"\n]*"|'[^'\n]*'|[^\s;&|()'"])+)/g, m;
    while ((m = re.exec(command)) !== null) {
      var e = wd.expand(m[2].replace(/^(["'])([\s\S]*)\1$/, '$2'), vars);
      if (e !== null && e.charAt(0) === '/') vars[m[1]] = e;
    }
    return vars;
  },
  // where an anchor fragment (transcript_protect.anchors) starts in a word, or -1 (an anchor glued to a name, an escape or a pattern
  // delimiter, transcript_protect.anchor_glued_re, is no folder mention)
  anchorAt: function (w) {
    var f = tp.fold(w), anchors = ah.cfg('transcript_protect.anchors').map(tp.fold), glued = new RegExp(ah.cfg('transcript_protect.anchor_glued_re'));
    for (var j = 0; j < anchors.length; j++) {
      var x = f.indexOf(anchors[j]);
      while (x >= 0) {
        if (x === 0 || !glued.test(f.charAt(x - 1))) return x;
        x = f.indexOf(anchors[j], x + 1);
      }
    }
    return -1;
  },
  // The folder an expression names, for the part of a path before its anchor fragment: the home (transcript_protect.home_expr_re), a
  // variable's value (a shell `NAME=value` of the command, or the value the code assigns it), or null when it is read at run time
  // (`process.argv[1]`, `tempfile.mkdtemp()`, a parameter): such a path is not a literal and is never blocked.
  baseOf: function (expr, ctx, depth) {
    var e = expr.trim().replace(/^\$?\{([^{}]*)\}$/, '$1').trim(), home = new RegExp('(?:' + ah.cfg('transcript_protect.home_expr_re') + ')$');
    if (home.test(e)) return ah.home() || null;
    var v = /^\$?([A-Za-z_]\w*)$/.exec(e) || /(?:^|[^\w.$])([A-Za-z_]\w*)$/.exec(e);
    if (!v || depth >= 2) return null;
    if (Object.prototype.hasOwnProperty.call(ctx.vars, v[1])) return ctx.vars[v[1]];
    var vals = tp.assigned(v[1], ctx.code);
    for (var i = 0; i < vals.length; i++) {
      var val = vals[i].replace(/\s*#.*$/, '').trim();
      if (home.test(val)) return ah.home() || null;
      var ps = tp.litPaths(val, ctx, depth + 1);
      if (ps.length) return ps[0];
    }
    return null;
  },
  // The absolute paths the path-like words of a piece of code spell. A word that expands to an absolute path is that path (a memory note or a
  // scratch-home copy stays itself). A word whose folder is an expression (`{home}/.claude/projects/...`, `$ENV{HOME}/...`,
  // `homedir()+'/.claude/projects/...'`, `S+'/.claude/projects/...'`) is taken from its anchor fragment on, under the folder that expression
  // names (tp.baseOf); a fragment that opens a relative path is under the payload's cwd. A glob pattern (`*`, `?`) names no file.
  litPaths: function (text, ctx, depth) {
    var re = new RegExp(ah.cfg('transcript_protect.token_re'), 'g'), op = new RegExp(ah.cfg('transcript_protect.path_join_re')), out = [], m;
    while ((m = re.exec(text)) !== null) {
      var w = m[0];
      if (/[*?]/.test(w) || (w.indexOf('/') < 0 && w.indexOf('~') < 0)) continue;
      var at = tp.anchorAt(w), e = wd.expand(w, ctx.vars);
      if (e !== null && e.charAt(0) === '/' && !(at >= 0 && at <= 1)) { out.push(ah.path.resolveAbs(e)); continue; }
      if (at < 0) continue;
      var inner = w.slice(0, at).replace(/\/+$/, ''), base = null;
      // `${os.homedir()}/...`: the word starts inside an interpolation the word cut split; its expression runs back to the `{`
      if (inner === '}') {
        var ob = text.lastIndexOf('{', m.index);
        while (ob > 0 && /[\w$.]/.test(text.charAt(ob - 1))) ob--;
        inner = ob >= 0 ? text.slice(ob, m.index + 1) : '';
      }
      if (inner !== '') base = tp.baseOf(inner, ctx, depth || 0);
      else {
        // the fragment opens a string: joined to the expression before it (`<expr> + '`, `<expr> / '`, `join(<expr>, '`), else relative
        var before = text.slice(Math.max(0, m.index - 200), m.index), j = op.exec(before);
        if (j) base = tp.baseOf(before.slice(0, j.index), ctx, depth || 0);
        else if (w.charAt(0) === '/') base = '';
        else base = ctx.cwd || null;
      }
      if (base !== null) out.push(ah.path.resolveAbs(base + '/' + w.slice(at)));
    }
    return out;
  },
  // Does a piece of code (a write call's own target argument, a receiver chain, a value a variable is assigned) hold a protected path LITERAL?
  litHit: function (text, pat, ctx) {
    return tp.litPaths(text, ctx, 0).some(function (p) { return tp.isProtected(p, pat); });
  },
  // the values the code assigns a variable (`name = <value>`, to the end of the line or statement)
  assigned: function (id, code) {
    var re = new RegExp('(?:^|[^\\w.$])' + id + '\\s*=(?!=)\\s*([^\\n;]*)', 'g'), m, out = [];
    while ((m = re.exec(code)) !== null && out.length < 8) out.push(m[1]);
    return out;
  },
  // whether a value a variable is assigned is a path (or a file opened on one): not a record (transcript_protect.record_value_re), and every
  // call in it is one that passes a path on (transcript_protect.path_calls: `os.path.expanduser(..)`, `Path(..)`, `open(..)`); data read
  // FROM a path (`pd.read_json('<transcript>')`, `T.replace('.jsonl', '.md')`) is not that path
  pathValue: function (v, rec) {
    if (rec.test(v)) return false;
    var ok = ah.cfg('transcript_protect.path_calls'), re = /([A-Za-z_]\w*)\s*\(/g, m;
    while ((m = re.exec(v)) !== null) if (ok.indexOf(m[1]) < 0) return false;
    return true;
  },
  // Does a write call's own target (argument text or receiver chain) hold a protected literal: spelled out, or in the value a variable it
  // names is assigned in the code (`T='<transcript>'; open(T,'a')`; an alias of one, `b=T`, two levels; a value that builds a record,
  // transcript_protect.record_value_re, is no path)? A target read at run time
  // (`sys.argv[1]`, `process.env.X`, a loop variable) holds no literal and is never blocked.
  argHit: function (arg, pat, ctx, depth) {
    if (tp.litHit(arg, pat, ctx)) return true;
    if ((depth || 0) >= 2) return false;
    var ids = (arg.match(/[A-Za-z_]\w*/g) || []).filter(function (x, i, all) { return all.indexOf(x) === i; }).slice(0, 8), rec = new RegExp(ah.cfg('transcript_protect.record_value_re'));
    for (var i = 0; i < ids.length; i++) {
      var vals = tp.assigned(ids[i], ctx.code);
      for (var j = 0; j < vals.length; j++) if (tp.pathValue(vals[j], rec) && tp.argHit(vals[j], pat, ctx, (depth || 0) + 1)) return true;
    }
    return false;
  },
  // The shell command text of a shell call's arguments: string literals as they are, an f-string's or a `+` concatenation's variable as the
  // first path its assigned value spells (`os.system('echo x >> ' + p)`, `subprocess.run(f'echo x >> {p}', shell=True)`).
  shellText: function (args, ctx) {
    var lre = /([fF]?)(['"])((?:\\.|(?!\2)[^\\])*)\2|([A-Za-z_][\w.]*)(?!\s*\()/g, out = [];
    var val = function (id) {
      var vals = tp.assigned(id, ctx.code);
      for (var i = 0; i < vals.length; i++) { var ps = tp.litPaths(vals[i], ctx, 1); if (ps.length) return ps[0]; }
      return '';
    };
    var text = args.join(','), l;
    while ((l = lre.exec(text)) !== null) {
      if (l[4] !== undefined) { if (/^\s*\+|\+\s*$/.test(text.slice(Math.max(0, l.index - 3), l.index) + text.slice(l.index + l[4].length, l.index + l[4].length + 3))) out.push(val(l[4])); continue; }
      out.push(l[1] ? l[3].replace(/\{([A-Za-z_]\w*)\}/g, function (_, id) { return val(id) || _; }) : l[3]);
    }
    return out.join(' ');
  },
  // A command split by what runs its heredoc bodies. `code` (the inline check's text, `-c`/`-e` scripts unescaped) keeps a body only when the
  // heredoc feeds an interpreter (transcript_protect.inline_interp_res: `python3 - <<EOF`). `shell` (the Bash write parse's text) keeps a
  // body as command lines when the heredoc feeds a shell (transcript_protect.shell_res: `bash <<'EOF'`), and drops a quoted-delimiter body
  // fed to anything else (`cat > gen.py <<'EOF'`: a file write judged by its own target; its text, often this check's own probes, does not
  // run). An unquoted body is left to the parse (its `$(...)` runs).
  bodies: function (command) {
    var interp = ah.cfg('transcript_protect.inline_interp_res').map(function (r) { return new RegExp(r, 'i'); }), sh = new RegExp(ah.cfg('transcript_protect.shell_res'), 'i');
    var code = [], shell = [], delim = null, keep = false, run = false, quoted = false, held = [], lines = command.split('\n'), hd = wd.re('workdetect.heredoc_delimiter');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (delim !== null) {
        if (line.trim() === delim) {
          if (!quoted && !run) shell.push.apply(shell, held.concat([line]));
          delim = null; held = [];
          continue;
        }
        if (keep) code.push(line);
        if (run) shell.push(line); else if (!quoted) held.push(line);
        continue;
      }
      code.push(line);
      var at = line.search(/<<(?!<)/), m = at < 0 ? null : hd.exec(line.slice(at));
      if (!m) { shell.push(line); continue; }
      delim = m[1].replace(/\\([^\n])|['"]/g, function (_, c) { return c || ''; });
      quoted = /['"\\]/.test(m[1]);
      var head = line.slice(0, at).split(/[;&|]/).pop();
      keep = interp.some(function (r) { return r.test(head); });
      run = sh.test(head);
      shell.push(run || quoted ? line.slice(0, at) + line.slice(at + m[0].length) : line);
    }
    if (delim !== null && !quoted && !run) shell.push.apply(shell, held);
    return { code: code.join('\n').replace(/\\(["'])/g, '$1'), shell: shell.join('\n') };
  },
  bashHit: function (command, payload) {
    var kinds = ah.cfg('transcript_protect.kinds'), pat = tp.build(payload);
    var cwd = payload && typeof payload.cwd === 'string' && payload.cwd.charAt(0) === '/' ? payload.cwd : null;
    // the parse is for a command that can name a protected path (a long commit message or script that never does is not parsed): it holds one of transcript_protect.hints, or runs inside a protected folder
    var low = tp.fold(command);
    if (!ah.cfg('transcript_protect.hints').some(function (h) { return low.indexOf(tp.fold(h)) >= 0; }) && !(cwd !== null && tp.insideRoot(cwd, pat))) return null;
    var sv = tp.shellVars(command), ws = wd.bashWrites(tp.bodies(command).shell, { cwd: cwd }), destr = new RegExp(ah.cfg('transcript_protect.destructive_re'), 'i'), i;
    var link = new RegExp(ah.cfg('transcript_protect.link_re'), 'i');
    var lastSegs = [], lastWrites = [];
    for (i = 0; i < ws.length; i++) {
      var w = ws[i];
      if (w.abs === null) {
        if (tp.unnamedHit(w.seg, pat, sv)) return kinds.unnamed;
        continue;
      }
      if (tp.isProtected(w.abs, pat)) return kinds.write;
      var at = lastSegs.indexOf(w.seg);
      if (at < 0) { lastSegs.push(w.seg); lastWrites.push(w); } else lastWrites[at] = w;
      // `ln -s <transcript> /tmp/x && echo >> /tmp/x`: a link to a transcript is a way round this check (the link does not exist yet when the command is judged)
      if (link.test(w.seg) && tp.linksTo(w.seg, pat)) return kinds.write;
      if (destr.test(w.seg) && tp.isParent(w.abs, pat)) return kinds.remove;
    }
    // a file that lands IN a protected folder (`cp x <project folder>/`, `tar -x -C <folder>`): the destination folder is the last write named
    for (i = 0; i < lastSegs.length; i++) if (tp.dirDest(lastSegs[i], lastWrites[i], pat)) return kinds.write;
    return tp.inlineHit(command, payload, pat) ? kinds.inline : null;
  },
  // the arguments (top-level, comma-separated, string-aware) of the call whose `(` is at `at`; null when the call never closes
  callArgs: function (text, at) {
    var out = [], depth = 0, cur = '', q = '', i;
    for (i = at; i < text.length; i++) {
      var c = text.charAt(i);
      if (q !== '') {
        cur += c;
        if (c === '\\' && i + 1 < text.length) { cur += text.charAt(++i); } else if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; if (depth > 1) cur += c; continue; }
      if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) { out.push(cur); return out; }
        cur += c; continue;
      }
      if (c === ',' && depth === 1) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    return null;
  },
  // the receiver chain of a method call whose `.` is at `dot` (`Path('<p>').expanduser()` of `Path('<p>').expanduser().open('a')`)
  receiver: function (text, dot) {
    var i = dot - 1;
    while (i >= 0 && /\s/.test(text.charAt(i))) i--;
    while (i >= 0) {
      var c = text.charAt(i);
      if (c === ')' || c === ']') {
        var depth = 0;
        for (; i >= 0; i--) {
          var d = text.charAt(i);
          if (d === ')' || d === ']') depth++;
          else if ((d === '(' || d === '[') && --depth === 0) break;
        }
        i--;
        continue;
      }
      if (/[\w.$]/.test(c)) { i--; continue; }
      break;
    }
    return text.slice(i + 1, dot);
  },
  // Inline interpreter code (python -c, node -e, perl -e, ruby -e, a heredoc fed to one, awk): a write call whose OWN target holds a protected
  // path literal (transcript_protect.inline_write_res, inline_calls, inline_receiver_re). A target that is not a literal is never blocked:
  // no static rule stops arbitrary code from writing a file, so this stops the plain forms and never blocks everyday reads and reports.
  inlineHit: function (command, payload, pat) {
    var code = tp.bodies(command).code, res = ah.cfg('transcript_protect.inline_write_res'), i, m, g;
    var ctx = { vars: tp.shellVars(command), code: code, cwd: payload && typeof payload.cwd === 'string' && payload.cwd.charAt(0) === '/' ? payload.cwd : null };
    for (i = 0; i < res.length; i++) {
      var wre = new RegExp(res[i], 'gi');
      while ((m = wre.exec(code)) !== null) {
        if (m[0] === '') { wre.lastIndex++; continue; }
        for (g = 1; g < m.length; g++) if (typeof m[g] === 'string' && tp.argHit(m[g], pat, ctx)) return true;
      }
    }
    var interp = ah.cfg('transcript_protect.inline_interp_res');
    if (!interp.some(function (r) { return new RegExp(r, 'i').test(command); })) return false;
    var rre = new RegExp(ah.cfg('transcript_protect.inline_receiver_re'), 'gi');
    while ((m = rre.exec(code)) !== null) if (tp.argHit(tp.receiver(code, m.index), pat, ctx)) return true;
    var roMode = new RegExp(ah.cfg('transcript_protect.inline_readonly_mode_re'), 'i'), hdl = new RegExp(ah.cfg('transcript_protect.inline_handle_re'), 'i');
    var families = ah.cfg('transcript_protect.inline_calls'), f;
    for (f = 0; f < families.length; f++) {
      var re = new RegExp(families[f].re, 'gi');
      while ((m = re.exec(code)) !== null) {
        var args = tp.callArgs(code, m.index + m[0].length - 1), kind = families[f].args;
        if (args === null) continue;
        if (kind === 'shell') {
          // a command string run by a shell, judged as a Bash command when it holds a protected path
          var cmd = tp.shellText(args, ctx);
          if (cmd !== '' && tp.litHit(cmd, pat, ctx) && tp.bashHit(cmd, payload) !== null) return true;
          continue;
        }
        if (kind === 'open') {
          // `open(target, mode ...)`; perl's 3-argument form puts a handle first: `open(my $f, '>>', target)`. No mode (or a read-only one) reads.
          var tgt = args[0], mode = args.length > 1 ? args[1] : '', kw = /^\s*(\w+)\s*=(?!=)\s*([\s\S]*)$/;
          if (args.length >= 3 && hdl.test(args[1]) && /^\s*(?:(?:my|our|local)\s+)?[$*\\]?\w+\s*$/.test(args[0])) { tgt = args[2]; mode = args[1]; }
          var km = kw.exec(mode);
          if (km) mode = /^(?:mode|flags)$/.test(km[1]) ? km[2] : '';
          for (var k = 2; k < args.length && mode === ''; k++) { var kk = kw.exec(args[k]); if (kk && /^(?:mode|flags)$/.test(kk[1])) mode = kk[2]; }
          if (mode === '' || roMode.test(mode.trim())) continue;
          if (tp.argHit(tgt, pat, ctx)) return true;
          continue;
        }
        var pick = kind === 'first' ? args.slice(0, 1) : kind === 'last' ? args.slice(-1) : args.slice(0, 2);
        if (pick.some(function (a) { return a.trim() !== '' && tp.argHit(a, pat, ctx); })) return true;
      }
    }
    return false;
  },
};
