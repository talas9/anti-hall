// Shared helpers of the task checks (mirror hooks/lib/handover-find.js `repoRoot`, companion/lib/identity.js `toplevel`, and the
// ledger text rules of hooks/task-lifecycle-log.js). Patterns and limits: engine/defaults/task_guards.toml (taskkit.*).
'use strict';
var task = {
  // The session id as a file-name part (`sanitizeSessionId`): unsafe characters removed, an empty result is the unknown id.
  sessionPathId: function (raw) {
    var safe = String(raw).replace(new RegExp(ah.cfg('taskkit.session_id_unsafe'), 'g'), '');
    return safe === '' ? ah.cfg('taskkit.unknown_session') : safe;
  },
  // `sanitizeText(s, max)`: a non-string is empty; control characters become spaces, white space collapses, the text is trimmed
  // and cut to `max` UTF-16 units with an ellipsis. null when the cut would split a surrogate pair (the engine cannot hold a
  // lone half, so the Node hook decides).
  sanitizeText: function (s, max) {
    if (typeof s !== 'string') return '';
    // Only a prefix long enough to hold `max` + 2 normalized characters is scanned: the cut text cannot depend on the rest.
    var ctl = new RegExp(ah.cfg('taskkit.control_chars'), 'g'), norm = function (x) { return x.replace(ctl, ' ').replace(/\s+/g, ' '); };
    for (var n = Math.max(max * 8, 4096); ; n *= 4) {
      var whole = n >= s.length, out = norm(whole ? s : s.slice(0, n));
      if (whole) {
        out = out.trim();
      } else {
        out = out.replace(/^\s+/, '');
        if (out.length < max + 2) continue;
      }
      if (out.length > max) {
        var hi = out.charCodeAt(max - 1), lo = out.charCodeAt(max);
        if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) return null;
        return out.slice(0, max) + ah.cfg('taskkit.ellipsis');
      }
      return out;
    }
  },
  under: function (child, parent) { return child === parent || (child.indexOf(parent) === 0 && child.charAt(parent.length) === '/'); },
  parent: function (d) {
    if (d === '/') return null;
    var i = d.lastIndexOf('/');
    return i <= 0 ? '/' : d.slice(0, i);
  },
  // The nearest ancestor of `dir` (inclusive) holding a `.git` entry of any kind.
  nearestDotGit: function (dir) {
    var name = ah.cfg('taskkit.git_entry');
    for (var d = dir; d !== null; d = task.parent(d)) if (ah.fs.kind((d === '/' ? '' : d) + '/' + name) !== null) return d;
    return null;
  },
  // The git directory behind `<top>/.git`: its real path, or null when the entry cannot be classified.
  gitDirOf: function (top) {
    var dot = (top === '/' ? '' : top) + '/' + ah.cfg('taskkit.git_entry'), k = ah.fs.kind(dot);
    if (k === null) return null;
    if (k === 'dir') return ah.fs.realpath(dot);
    var text = ah.fs.readText(dot);
    if (text === null) return null;
    var m = new RegExp(ah.cfg('taskkit.gitdir_line'), 'm').exec(text);
    if (!m || m[1] === undefined || m[1] === '') return null;
    var joined = ah.path.isAbsolute(m[1]) ? m[1] : top + '/' + m[1];
    var g = ah.fs.realpath(ah.path.resolveAbs(joined));
    return g !== null && ah.fs.isDir(g) ? g : null;
  },
  realHome: function (home) { var r = ah.fs.realpath(home); return r === null ? home : r; },
  // `repoRoot(cwd)`: the checkout that owns an absolute `cwd`, else `cwd` itself. null: the answer would depend on the Node
  // process's own directory (a relative cwd) or on an unknown home; the caller defers.
  repoRoot: function (cwd, home) {
    if (cwd === '' || !ah.path.isAbsolute(cwd) || home === '') return null;
    var real = ah.fs.realpath(ah.path.resolveAbs(cwd));
    if (real === null) return cwd;
    var top = task.nearestDotGit(real);
    if (top === null) return cwd;
    var g = task.gitDirOf(top);
    if (g === null) return cwd;
    if (task.under(real, g)) return cwd;
    return top === task.realHome(home) ? cwd : top;
  },
  // True when the first `[core]` section of a git config holds a `worktree = <value>` line.
  coreNamesWorktree: function (cfg) {
    var lines = cfg.split('\n').map(function (l) { return l.replace(/\r+$/, ''); }), i = 0;
    for (; i < lines.length; i++) if (lines[i].trim() === '[core]') break;
    if (i >= lines.length) return false;
    for (i++; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t.charAt(0) === '[') break;
      if (t.indexOf('worktree') === 0) {
        var rest = t.slice('worktree'.length).trim();
        if (rest.charAt(0) === '=' && rest.slice(1).trim() !== '') return true;
      }
    }
    return false;
  },
  commonDirNamesWorktree: function (g) {
    var c = ah.fs.readText(g + '/commondir');
    c = c === null ? '' : c.trim();
    if (c === '') return false;
    var common = ah.fs.realpath(ah.path.resolveAbs(g + '/' + c));
    if (common === null) common = g;
    var cfg = ah.fs.readText(common + '/config');
    return cfg !== null && task.coreNamesWorktree(cfg);
  },
  // `sessionProjectRoot(cwd)`: the outermost superproject's work tree. null where the checkout sits inside another one (a
  // submodule or nested repository) or names a work tree: only git can classify those, so the caller defers.
  sessionProjectRoot: function (cwd, home) {
    if (cwd === '' || !ah.path.isAbsolute(cwd) || home === '') return null;
    var real = ah.fs.realpath(ah.path.resolveAbs(cwd));
    if (real === null) return cwd;
    var top = task.nearestDotGit(real);
    if (top === null) return cwd;
    var g = task.gitDirOf(top);
    if (g === null) return cwd;
    if (task.under(real, g)) return cwd;
    var dotKind = ah.fs.kind((top === '/' ? '' : top) + '/' + ah.cfg('taskkit.git_entry'));
    var up = task.parent(top);
    if ((up !== null && task.nearestDotGit(up) !== null) || (dotKind !== 'dir' && task.commonDirNamesWorktree(g))) return null;
    return top === task.realHome(home) ? cwd : top;
  },
};
