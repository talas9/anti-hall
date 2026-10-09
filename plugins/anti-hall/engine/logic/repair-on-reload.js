// check = "repair-on-reload" (SessionStart and UserPromptSubmit): starts a migrations-only repair when the running plugin version has
// migrations still pending. Answers every case in which the Node hook stays silent (switch off, subagent turn, skipped, nothing pending at
// the running version, cooldown); anything else defers: past that point the hook takes `repair-on-reload.lock`, starts `doctor.js
// --repair --migrations-only` as a DETACHED process, re-points the lock at the child's pid, stamps the cooldown only when the spawn
// started, and prunes old repair logs, none of which depends on anything but the spawn's outcome. This script builds on
// jev-review-reminder.js (script.includes). Mirrors hooks/repair-on-reload.js. Keys: session_gates.toml (repair_reload.*).
'use strict';

function rrTriple(v) {
  if (!new RegExp(ah.cfg('repair_reload.version_re')).test(v)) return null;
  return v.split('.').map(Number);
}

function rrAtLeast(a, b) {
  for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i] >= 0;
  return true;
}

function rrPending(version) {
  var f = jx.read(ah.home() + '/' + ah.cfg('guardkit.migration_markers_file')), markers = {};
  if (f.text !== undefined) {
    var r = jx.parse(f.text.trim());
    if (!r.invalid && !r.unsure && jx.isObj(r.v)) markers = r.v;
  }
  return ah.cfg('repair_reload.migration_keys').some(function (k) {
    var m = markers[k], done = jx.isObj(m) && typeof m.completedVersion === 'string' ? rrTriple(m.completedVersion) : null;
    return !(done !== null && rrAtLeast(done, version));
  });
}

function rrInCooldown(version) {
  var last = sgReadObject(ah.cfg('repair_reload.cooldown_file'));
  if (last === null || last.version !== version) return false;
  if (typeof last.ts !== 'number' || !isFinite(last.ts)) return false;
  var age = ah.clock.now() - last.ts;
  return age >= 0 && age < ah.cfgNum('repair_reload.cooldown_ms');
}

function decide(p, opts) {
  if (!sgHomeKnown()) return 'defer';
  var root = sgRoot(opts);
  if (sgJudgeChild()) return 'allow';
  var en = ah.settings.get('repair_reload.setting', undefined, root);
  if (en.status === 'undecidable') return 'defer';
  if (en.status === 'value' && (en.value === false || en.value === 'off')) return 'allow';
  if (jx.isObj(p) && sgT('agent_key_markers').some(function (k) { return p[k] !== undefined && p[k] !== null; })) return 'allow';
  if (ah.settings.skipped(ah.cfg('repair_reload.guard_name'))) return 'allow';
  if (root === '') return 'defer';
  var mf = ah.fs.readText(root + '/' + ah.cfg('guardkit.plugin_manifest')), version = null;
  if (mf !== null) { var r = jx.parse(mf); if (r.unsure) return 'defer'; if (!r.invalid && jx.isObj(r.v) && typeof r.v.version === 'string' && r.v.version !== '') version = r.v.version; }
  if (version === null) return 'allow';
  // a version that is not a plain three-part one is compared by Node with NaN arithmetic; leave it to Node
  var running = version.trim() === version ? rrTriple(version) : null;
  if (running === null) return 'defer';
  if (!rrPending(running)) return 'allow';
  if (rrInCooldown(version)) return 'allow';
  return 'defer';
}
