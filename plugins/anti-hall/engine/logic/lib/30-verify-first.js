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
