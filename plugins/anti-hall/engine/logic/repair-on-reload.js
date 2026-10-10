// check = "repair-on-reload" (SessionStart and UserPromptSubmit): the gates of hooks/repair-on-reload.js. Answers "no repair can
// start" itself (switch off, subagent turn, skipped, nothing pending at the running version, cooldown); past all of them it asks
// the engine's refresh job for the repair (engine/defaults/refresh.toml) instead of starting a detached process. Keys: engine/defaults/session_gates.toml
// (session_gates.*, repair_reload.*).
'use strict';

// `[major, minor, patch]` of a plain three-part version, or null.
function triple(v) {
  if (!new RegExp(ah.cfg('repair_reload.version_re')).test(v)) return null;
  return v.split('.').map(parseFloat);
}

// `semverCmp(a, b) >= 0` for two plain versions.
function atLeast(a, b) {
  for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i] >= 0;
  return true;
}

// `repairPending(home, version)`: some default migration has no marker at the running version or newer.
function repairPending(version) {
  var markers = gates.readObject(ah.cfg('guardkit.migration_markers_file')) || {};
  return ah.cfg('repair_reload.migration_keys').some(function (k) {
    var m = markers[k], done = gates.isObject(m) && typeof m.completedVersion === 'string' ? triple(m.completedVersion) : null;
    return !(done !== null && atLeast(done, version));
  });
}

// `inCooldown(home, now, version)`.
function inCooldown(version) {
  var last = gates.readObject(ah.cfg('session_gates.anti_hall_dir') + '/' + ah.cfg('repair_reload.cooldown_file'));
  if (last === null || last.version !== version) return false;
  var ts = last.ts;
  if (typeof ts !== 'number' || !isFinite(ts)) return false;
  var age = Date.now() - ts;
  return age >= 0 && age < ah.cfgNum('repair_reload.cooldown_ms');
}

function decide(p, opts) {
  if (!gates.homeKnown()) return 'defer';
  return gates.run(function () {
    var root = gates.pluginRoot(opts);
    if (gates.judgeChild()) return 'allow';
    var on = gates.setting('repair_reload.setting', undefined, root);
    if (on === false || on === 'off') return 'allow';
    if (gates.isObject(p) && ah.cfg('session_gates.agent_key_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; })) return 'allow';
    if (ah.settings.skipped(ah.cfg('repair_reload.guard_name'))) return 'allow';
    if (root === '') return 'defer';
    var raw = ah.fs.readText(root + '/' + ah.cfg('guardkit.plugin_manifest')), manifest = null;
    if (raw !== null) { try { manifest = JSON.parse(raw); } catch (e) { manifest = null; } }
    var version = gates.isObject(manifest) && typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null;
    if (version === null) return 'allow';
    // A version that is not a plain three-part one is compared by Node with NaN arithmetic; leave it to Node.
    var running = version.trim() === version ? triple(version) : null;
    if (running === null) return 'defer';
    if (!repairPending(running)) return 'allow';
    if (inCooldown(version)) return 'allow';
    // Past every gate the Node hook took `repair-on-reload.lock` and started `doctor.js --repair --migrations-only` detached.
    // The engine asks its refresh job instead (probe `repair`): the job re-checks the cooldown, takes the same lock, runs the
    // engine's own migrations-only repair bounded and stamps the cooldown once it started. Silent, as Node.
    sess.requestRefresh('repair', { version: version, pluginRoot: root });
    return 'allow';
  });
}
