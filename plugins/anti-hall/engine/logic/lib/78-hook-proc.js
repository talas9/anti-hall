// What a Node hook read from its own process and the daemon cannot see (v1.0 lane L07): the working directory (`process.cwd()`)
// and the home directory (`os.homedir()`). The engine answers them from the request instead of deferring: the payload's cwd when
// it is absolute, else the first absolute directory among the configured stand-ins (hook_proc.cwd_envs; a relative payload cwd
// resolves against it), and HOME as Node's `os.homedir()` reads it (the variable when set and non-empty, the passwd entry
// otherwise; a relative value resolved against the working directory, as every Node path call on it would be). Also the text a
// host call can take from a string Node would have kept as it is (`usv`).
'use strict';
var hookProc = {
  // The directory the hook process would have run in, before the payload's own cwd is considered.
  base: function () {
    var names = ah.cfg('hook_proc.cwd_envs');
    for (var i = 0; i < names.length; i++) {
      var v = ah.env.get(names[i]);
      if (v !== null && ah.path.isAbsolute(v)) return ah.path.resolveAbs(v);
    }
    return ah.cfg('hook_proc.cwd_last');
  },
  // `payload.cwd || process.cwd()`, made absolute.
  cwd: function (p) {
    var c = p !== null && typeof p === 'object' ? p.cwd : undefined;
    if (typeof c === 'string' && c !== '') return ah.path.isAbsolute(c) ? c : ah.path.resolveAbs(hookProc.base() + '/' + c);
    return hookProc.base();
  },
  // `path.resolve(cwd, q)` for the hook process of payload `p`.
  resolve: function (p, q) { return ah.path.isAbsolute(q) ? ah.path.resolveAbs(q) : ah.path.resolveAbs(hookProc.cwd(p) + '/' + q); },
  // The path a file read opens: an absolute `q` as it is (the kernel, not a lexical normalisation, decides `dir/..` and a trailing
  // slash), a relative one joined to the hook process's directory.
  open: function (p, q) { return ah.path.isAbsolute(q) ? q : hookProc.cwd(p) + '/' + q; },
  // `os.homedir()`, absolute (null only when neither the variable nor the passwd entry gives one).
  home: function (p) {
    var h = ah.env.get(ah.cfg('env.home'));
    if (h === null || h === '') h = ah.env.passwdHome();
    if (h === null || h === '') return null;
    return ah.path.isAbsolute(h) ? h : hookProc.resolve(p, h);
  },
  // The payload's cwd when it is an absolute path (the directory the host runs the hook in), else null.
  absCwd: function (p) { var c = p !== null && typeof p === 'object' ? p.cwd : undefined; return typeof c === 'string' && ah.path.isAbsolute(c) ? c : null; },
  // The path a Node hook would open, where that is known exactly: an absolute `q` as it is, a relative one joined to an absolute payload
  // cwd; null when only the hook process's own directory (not in the payload) could resolve it.
  openKnown: function (p, q) { if (ah.path.isAbsolute(q)) return q; var c = hookProc.absCwd(p); return c === null ? null : c + '/' + q; },
  // Node's `os.homedir()` for the hook process: HOME when set (even empty or relative: libuv takes it as it is), else the passwd
  // entry. {home, passwd} (absolute; `passwd` true when it came from the passwd entry, so the call must adopt it with ah.useHome),
  // {relative: true} (HOME set but relative or empty: Node resolves every path on it against its own directory, which the engine
  // cannot see) or {none: true} (neither gives a home).
  nodeHome: function () {
    var h = ah.env.get(ah.cfg('env.home')), passwd = h === null;
    if (passwd) h = ah.env.passwdHome();
    if (h === null) return { none: true };
    if (!ah.path.isAbsolute(h)) return { relative: true };
    return { home: h, passwd: passwd };
  },
  // companion/lib/test-home-guard.js `resolveHome`: true when a test marker (spawn_ctx.test_markers) is set without the opt-out and
  // `h` is the real (passwd) home, which the Node hooks refuse to use under a test.
  testGuarded: function (h) {
    var set = function (k) { var v = ah.env.get(k); return v !== null && v !== ''; };
    if (set(ah.cfg('spawn_ctx.real_home_optout_env')) || !ah.cfg('spawn_ctx.test_markers').some(set)) return false;
    var real = ah.env.passwdHome();
    return real !== null && real !== '' && ah.path.resolveAbs(h) === ah.path.resolveAbs(real);
  },
  // The home a Node hook would use, made the call's home: null when the call may go on, else why the engine cannot use it as Node
  // does (relative_home, no_home, test_guard: the passwd home is the real one under a test marker, never touched); the caller defers.
  adoptHome: function () {
    var nh = hookProc.nodeHome();
    if (nh.relative) return 'relative_home';
    if (nh.none) return 'no_home';
    if (nh.passwd) {
      if (hookProc.testGuarded(nh.home)) return 'test_guard';
      ah.useHome(nh.home);
    }
    return null;
  },
  // `t` with every lone surrogate (which a Node string may hold and a host call cannot take) replaced by U+FFFD: the same length in
  // UTF-16 units, so offsets the host returns index the original text.
  usv: function (t) { return t.toWellFormed(); }, // the interpreter's own native pass (a script regex over a 200 KB output cost ~8 ms)
};
