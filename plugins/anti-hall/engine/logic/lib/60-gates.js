// Shared helpers of the session gates (jev-weekly-scorecard, jev-review-reminder, repair-on-reload): the checks that answer
// "nothing to say" themselves when they can prove the Node hook would print and write nothing, and defer otherwise.
// Keys: engine/defaults/session_gates.toml (session_gates.*).
'use strict';
var gates = {
  UNDECIDABLE: 'undecidable',
  // Run `f`; a settings answer that needs the plugin root the request lacks (or a file too large to read) defers.
  run: function (f) {
    try { return f(); } catch (e) { if (e === gates.UNDECIDABLE) return 'defer'; throw e; }
  },
  homeKnown: function () {
    var h = ah.env.get(ah.cfg('env.home'));
    return h !== null && ah.path.isAbsolute(h);
  },
  judgeChild: function () { return ah.env.get(ah.cfg('session_gates.judge_child_env')) === ah.cfg('session_gates.judge_child_value'); },
  pluginRoot: function (opts) {
    if (opts !== null && typeof opts === 'object' && typeof opts.plugin_root === 'string') return opts.plugin_root;
    var r = ah.env.get(ah.cfg('env.plugin_root'));
    return r === null ? '' : r;
  },
  // `get(section, key, dflt)`: the value, or undefined for "nothing"; throws UNDECIDABLE.
  setting: function (key, dflt, root) {
    var r = ah.settings.get(key, dflt, root);
    if (r.status === 'undecidable') throw gates.UNDECIDABLE;
    return r.status === 'value' ? r.value : undefined;
  },
  isTrue: function (key, dflt, root) { return gates.setting(key, dflt, root) === true; },
  // A small JSON object file under the home directory, or null (absent, unreadable, not an object). A file past the read cap
  // cannot be read whole here, so the Node hook decides.
  readObject: function (rel) {
    var path = ah.home() + '/' + rel, size = ah.fs.size(path);
    if (size !== null && size > ah.cfgNum('script.read_max_bytes')) throw gates.UNDECIDABLE;
    var t = ah.fs.readText(path);
    if (t === null) return null;
    var v;
    try { v = JSON.parse(t); } catch (e) { return null; }
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  },
  // The time stored under `key` in a small state file, when it is a finite number.
  storedTime: function (rel, key) {
    var o = gates.readObject(ah.cfg('session_gates.anti_hall_dir') + '/' + rel);
    return o !== null && typeof o[key] === 'number' && isFinite(o[key]) ? o[key] : undefined;
  },
  // `readJevJson(home).enabled === true`: the strict reading of the legacy file, the fallback value Node passes.
  legacyEnabledStrict: function () {
    var o = gates.readObject(ah.cfg('session_gates.anti_hall_dir') + '/' + ah.cfg('session_gates.jev_config_file'));
    return o !== null && o.enabled === true;
  },
  eventName: function (p) {
    var e = p !== null && typeof p === 'object' ? p.hook_event_name : undefined;
    return typeof e === 'string' && e !== '' ? e : ah.cfg('session_gates.default_event');
  },
  isObject: function (p) { return p !== null && typeof p === 'object' && !Array.isArray(p); },
};
