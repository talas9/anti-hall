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
};
