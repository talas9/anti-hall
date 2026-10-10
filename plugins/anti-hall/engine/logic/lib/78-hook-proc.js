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
  // `os.homedir()`, absolute (null only when neither the variable nor the passwd entry gives one).
  home: function (p) {
    var h = ah.env.get(ah.cfg('env.home'));
    if (h === null || h === '') h = ah.env.passwdHome();
    if (h === null || h === '') return null;
    return ah.path.isAbsolute(h) ? h : hookProc.resolve(p, h);
  },
  // `t` with every lone surrogate (which a Node string may hold and a host call cannot take) replaced by U+FFFD: the same length in
  // UTF-16 units, so offsets the host returns index the original text.
  usv: function (t) { return t.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd'); },
};
