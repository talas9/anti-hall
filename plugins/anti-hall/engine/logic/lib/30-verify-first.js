// Helpers shared by the verify-first protocol checks (verify-first-subagent, verify-first-full): the plugin root Node derives
// from the real location of hooks/verify-first-core.js, the root placeholder, the DevSwarm child test.
'use strict';
var vf = {
  judgeChild: function () {
    var e = ah.cfg('verify_first.judge_child_env');
    return ah.env.get(e.name) === e.on;
  },
  childWorkspace: function () {
    var v = ah.env.get(ah.cfg('verify_first.child_branch_env'));
    return v !== null && v.trim() !== '';
  },
  // `detectPlatform(payload) === 'codex'`: a non-empty turn_id, or a Codex rollout / `.codex` transcript path.
  codexPayload: function (p) {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return false;
    if (typeof p.turn_id === 'string' && p.turn_id !== '') return true;
    var tp = typeof p.transcript_path === 'string' ? p.transcript_path : '';
    return ah.cfg('verify_first.codex_transcript_patterns').some(function (src) { return ah.re.test(src, 'r', tp); });
  },
  dirname: function (p) {
    if (p === '/') return null;
    var i = p.lastIndexOf('/');
    return i < 0 ? null : (i === 0 ? '/' : p.slice(0, i));
  },
  // The directory two levels above the real hooks/verify-first-core.js under the root the host named; null when that
  // cannot be proven (the check then answers nothing and Node decides).
  pluginRoot: function (opts) {
    var given = opts !== null && typeof opts === 'object' && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
    if (given === null || given.charAt(0) !== '/') return null;
    var real = ah.fs.realpath(given + '/' + ah.cfg('verify_first.root_probe'));
    if (real === null) return null;
    var up = vf.dirname(real);
    return up === null ? null : vf.dirname(up);
  },
  withRoot: function (t, root) { return t.split(ah.cfg('verify_first.abs_marker')).join(root); },
  // True when the session might get the DevSwarm Primary sentence, which only Node can decide (the callers defer).
  primaryPossible: function () {
    if (ah.env.get(ah.cfg('verify_first.env_devswarm_disable')) === '1') return false;
    var mode = ah.settings.enum('verify_first.sw_supervisor_mode'), active;
    if (mode === 'off') active = false;
    else if (mode === 'on') active = true;
    else { var repo = ah.env.get(ah.cfg('verify_first.env_devswarm_repo')); active = repo !== null && repo.trim() !== ''; }
    if (!active) return false;
    var src = ah.env.get(ah.cfg('verify_first.env_devswarm_source_branch'));
    if (src !== null && src.trim() !== '') return false;
    return ah.settings.bool('verify_first.sw_dispatch_tier_text');
  },
  // The DevSwarm Primary dispatch-tier text gate (`primaryTierTextOn` / `noWorkspaceRepo` of hooks/lib): true = the text applies, false =
  // it is withheld, null = the answer depends on something the engine does not reproduce (an absent or relative working directory, a
  // repository layout the identity resolver cannot classify, a document over the read cap): the caller defers before writing anything.
  tierTextOn: function (p) {
    if (!vf.primaryPossible()) return false;
    var cwd = jx.isObj(p) ? p.cwd : undefined;
    if (!cwd) return null; // Node uses its own working directory
    if (typeof cwd !== 'string') return false;
    if (cwd.charAt(0) !== '/' || spawn.osHome() === null) return null;
    var r = vf.noWorkspaceRepo(ah.path.resolveAbs(cwd));
    return r === null ? null : !r;
  },
  noWorkspaceRepo: function (dir0) {
    var entries = ah.settings.str('verify_first.sw_no_ws_repos').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
    if (entries.indexOf('*') >= 0) return true;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var hit = e.charAt(0) === '/' ? (dir0 === e || dir0.indexOf(e + '/') === 0) : dir0.split('/').indexOf(e) >= 0;
      if (hit) return true;
    }
    if (!ah.settings.bool('verify_first.sw_no_ws_detect')) return false;
    var ctx = ah.repo.context(dir0);
    if (ctx.unsure) return null;
    var re = ah.cfg('verify_first.no_ws_pattern'), docs = ah.cfg('verify_first.no_ws_docs'), cap = ah.cfgNum('script.read_max_bytes');
    var dir = dir0;
    for (var n = 0, levels = ah.cfgNum('verify_first.no_ws_levels'); n < levels; n++) {
      for (var j = 0; j < docs.length; j++) {
        var f = ah.path.join(dir, docs[j]), size = ah.fs.size(f);
        if (size === null) continue;
        if (size > cap) return null;
        var t = ah.fs.readText(f, cap);
        if (t !== null && ah.re.test(re, 'i', t)) return true;
      }
      if (ctx.root === dir) break;
      var up = vf.dirname(dir);
      if (up === null || up === dir) break;
      dir = up;
    }
    return false;
  },
  // The session id as the UserPromptSubmit hooks use it (`payload.session_id` when truthy, `String(..)` of a number or true): a string,
  // null for none, or undefined for an id the engine does not spell exactly as JavaScript (an array or object): the caller defers.
  sessionOf: function (p) {
    var v = jx.isObj(p) ? p.session_id : undefined;
    if (v === undefined || v === null || v === false || v === 0 || v === '' || (typeof v === 'number' && isNaN(v))) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (v === true) return 'true';
    return undefined;
  },
  // `payload.transcript_path` when a non-empty string: the path, null for none, or undefined for a relative path (Node would resolve it
  // against its own working directory, which the engine does not share: the caller defers).
  transcriptOf: function (p) {
    var v = jx.isObj(p) ? p.transcript_path : undefined;
    if (typeof v !== 'string' || v === '') return null;
    return v.charAt(0) === '/' ? v : undefined;
  },
};
