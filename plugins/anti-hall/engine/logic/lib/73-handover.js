// Shared helpers of the handover checks (mirror hooks/lib/handover-find.js): the session id, the local date, the repository root
// a project's handovers live under and the search for the newest handover. Names, patterns and limits: codex_handover.toml
// (codex_handover.*).
'use strict';
var ho = {
  sanitize: function (raw) {
    var safe = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
    return safe || ah.cfg('codex_handover.unknown_session');
  },
  // `localDate()`: the local calendar date as YYYY-MM-DD, or null when the zone is not the engine's own (a request that sets TZ to a
  // zone other than UTC).
  localDate: function () {
    var tz = ah.env.get(ah.cfg('codex_handover.tz_var')), pad = function (n) { return String(n).padStart(2, '0'); };
    if (tz !== null) {
      // a request that names UTC itself has its date from the UTC clock; any other zone is Node's to apply
      if (ah.cfg('codex_handover.utc_zone_names').indexOf(tz) < 0) return null;
      var u = new Date(ah.clock.now());
      return u.getUTCFullYear() + '-' + pad(u.getUTCMonth() + 1) + '-' + pad(u.getUTCDate());
    }
    var t = ah.clock.local(ah.clock.now());
    return t.year + '-' + pad(t.month) + '-' + pad(t.day);
  },
  // `repoRoot(cwd)`: the git top level, or cwd itself when there is none or it is the home directory. null: the host cannot say.
  // The checkout around a directory the way hooks/lib/handover-find.js asks for it: a path that does not exist has none (the host's
  // own answer would look at its nearest existing ancestor, which Node's default does not).
  context: function (cwd) {
    if (ah.fs.realpath(cwd) === null) return { unsure: false, toplevel: null, root: null };
    return ah.repo.context(cwd);
  },
  repoRoot: function (cwd) {
    var ctx = ho.context(cwd);
    if (ctx.unsure) return null;
    var rh = ah.fs.realpath(spawn.osHome() || '') || spawn.osHome();
    return ctx.toplevel && ctx.toplevel !== rh ? ctx.toplevel : cwd;
  },
  handoversRoot: function (cwd) {
    var r = ho.repoRoot(cwd);
    return r === null ? null : ah.path.join(r, ah.cfg('codex_handover.handovers_dir'));
  },
  dirs: function (p) {
    var names = ah.fs.readdir(p);
    if (names === null) return [];
    return names.filter(function (n) { return ah.fs.kind(p + '/' + n) === 'dir'; });
  },
  // Every file of the session directories under root whose name matches `re` (a RegExp): {filePath, mtimeMs, date, sessionId, seq}.
  collect: function (root, re, only) {
    var out = [];
    ho.dirs(root).forEach(function (date) {
      ho.dirs(root + '/' + date).forEach(function (sid) {
        if (only && sid !== only) return;
        var sp = root + '/' + date + '/' + sid, files = ah.fs.readdir(sp);
        if (files === null) return;
        files.forEach(function (f) {
          var m = re.exec(f);
          if (!m) return;
          var fp = sp + '/' + f, st = ah.fs.lstat(fp), real = ah.fs.isFile(fp);
          if (!st || !real) return;
          out.push({ filePath: fp, mtimeMs: ah.fs.mtimeMs(fp), date: date, sessionId: sid, seq: m[1] ? parseInt(m[1], 10) : 1 });
        });
      });
    });
    return out;
  },
  handoverRe: /^HANDOVER(?:-(\d+))?\.md$/,
  precompactRe: /^PRECOMPACT-(\d+)\.md$/,
  newestHandover: function (root, want) {
    var c = ho.collect(root, ho.handoverRe, null);
    if (c.length === 0) return null;
    var pool = c;
    if (want) { var same = c.filter(function (x) { return x.sessionId === want; }); if (same.length > 0) pool = same; }
    pool.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });
    return pool[0];
  },
};
