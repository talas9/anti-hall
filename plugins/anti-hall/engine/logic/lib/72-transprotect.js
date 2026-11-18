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
  // whether a command part names a protected path among its words (`ln -s <transcript> x`)
  linksTo: function (seg, pat) {
    var ws = wd.words(seg).words;
    for (var i = 0; i < ws.length; i++) {
      if (ws[i].charAt(0) === '-') continue;
      var e = wd.expand(ws[i], {});
      if (e === null || e.charAt(0) !== '/') continue;
      var abs = ah.path.resolveAbs(e);
      if (tp.isProtected(abs, pat) || tp.insideRoot(abs, pat) || tp.isParent(abs, pat)) return true;
    }
    return false;
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
    for (i = 0; i < ws.length; i++) {
      var w = ws[i];
      if (w.abs === null) {
        var seg = tp.fold(w.seg);
        if (anchors.some(function (a) { return seg.indexOf(a) >= 0; })) return kinds.unnamed;
        continue;
      }
      if (tp.isProtected(w.abs, pat)) return kinds.write;
      // `ln -s <transcript> /tmp/x && echo >> /tmp/x`: a link to a transcript is a way round this check (the link does not exist yet when the command is judged)
      if (link.test(w.seg) && tp.linksTo(w.seg, pat)) return kinds.write;
      if (destr.test(w.seg) && tp.isParent(w.abs, pat)) return kinds.remove;
    }
    // inline code (python -c, node -e, a heredoc script) that names a protected path and writes
    var words = command.match(new RegExp(ah.cfg('transcript_protect.token_re'), 'g')) || [], named = false;
    for (i = 0; i < words.length && !named; i++) {
      if (words[i].indexOf('/') < 0 && words[i].indexOf('~') < 0) continue;
      var e = wd.expand(words[i], {});
      if (e !== null && e.charAt(0) === '/' && tp.isProtected(ah.path.resolveAbs(e), pat)) named = true;
    }
    if (named) {
      var res = ah.cfg('transcript_protect.inline_write_res');
      for (i = 0; i < res.length; i++) if (new RegExp(res[i], 'i').test(command)) return kinds.inline;
    }
    return null;
  },
};
