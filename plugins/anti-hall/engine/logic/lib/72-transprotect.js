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
    return false;
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
  // whether text names a protected path among its path-like words (a spelled-out path in a script)
  named: function (text, pat) {
    var words = text.match(new RegExp(ah.cfg('transcript_protect.token_re'), 'g')) || [];
    for (var i = 0; i < words.length; i++) {
      if (words[i].indexOf('/') < 0 && words[i].indexOf('~') < 0) continue;
      var e = wd.expand(words[i], {});
      if (e !== null && e.charAt(0) === '/' && tp.isProtected(ah.path.resolveAbs(e), pat)) return true;
    }
    return false;
  },
  // Does one write call's own target argument reach a protected path: spelled out, or through a variable the command assigns? `command` is the
  // whole script. An argument read at run time (transcript_protect.indirect_arg_re) or a bare variable never assigned cannot be tied to a path:
  // then the command naming a protected path anywhere counts.
  argHit: function (arg, command, pat) {
    if (tp.named(arg, pat)) return true;
    var indirect = new RegExp(ah.cfg('transcript_protect.indirect_arg_re'), 'i');
    if (indirect.test(arg)) return tp.named(command, pat);
    var ids = (arg.match(/[A-Za-z_]\w*/g) || []).filter(function (x, i, all) { return all.indexOf(x) === i; }).slice(0, 8), unresolved = /^\s*[A-Za-z_]\w*\s*$/.test(arg);
    for (var i = 0; i < ids.length; i++) {
      var re = new RegExp('(?:^|[^\\w.])' + ids[i] + '\\s*=(?!=)\\s*([^\\n;]*)', 'g'), m;
      while ((m = re.exec(command)) !== null) {
        unresolved = false;
        if (tp.named(m[1], pat) || (indirect.test(m[1]) && tp.named(command, pat))) return true;
      }
    }
    return unresolved && tp.named(command, pat);
  },
  // The kind (transcript_protect.kinds: write, remove, unnamed, inline) of the first write of a Bash command to a protected path, else null.
  bashHit: function (command, payload) {
    var kinds = ah.cfg('transcript_protect.kinds'), pat = tp.build(payload);
    var cwd = payload && typeof payload.cwd === 'string' && payload.cwd.charAt(0) === '/' ? payload.cwd : null;
    // the parse is for a command that can name a protected path (a long commit message or script that never does is not parsed): it holds one of transcript_protect.hints, or runs inside a protected folder
    var low = tp.fold(command);
    if (!ah.cfg('transcript_protect.hints').some(function (h) { return low.indexOf(tp.fold(h)) >= 0; }) && !(cwd !== null && tp.insideRoot(cwd, pat))) return null;
    var ws = wd.bashWrites(command, { cwd: cwd }), destr = new RegExp(ah.cfg('transcript_protect.destructive_re'), 'i'), i;
    var anchors = ah.cfg('transcript_protect.anchors').map(tp.fold), link = new RegExp(ah.cfg('transcript_protect.link_re'), 'i');
    var lastSegs = [], lastWrites = [];
    for (i = 0; i < ws.length; i++) {
      var w = ws[i];
      if (w.abs === null) {
        var seg = tp.fold(w.seg);
        if (anchors.some(function (a) { return seg.indexOf(a) >= 0; })) return kinds.unnamed;
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
    // inline code (python -c, node -e, a heredoc script, awk): a write call whose own target argument is a protected path
    var res = ah.cfg('transcript_protect.inline_write_res');
    for (i = 0; i < res.length; i++) {
      var re = new RegExp(res[i], 'gi'), m;
      while ((m = re.exec(command)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        var any = false, g;
        for (g = 1; g < m.length; g++) {
          if (typeof m[g] !== 'string') continue;
          any = true;
          if (tp.argHit(m[g], command, pat)) return kinds.inline;
        }
        if (!any && tp.named(command, pat)) return kinds.inline;
      }
    }
    return null;
  },
};
