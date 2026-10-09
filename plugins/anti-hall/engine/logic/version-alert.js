// check = "version-alert" (SessionStart). Two independent cases, as in Node. Case 2 (checked first, no network): a newer release is
// already mirrored into the local plugin cache than the one running, so the user only needs to reload; the advice depends on whether
// the host's plugin registry has caught up. Case 1: a fresh remote-latest cache names a newer release, so the user needs to update.
// A stale or absent remote cache makes Node start a detached refresh process, which is Node's job, so the script defers then (before
// writing anything). Mirrors hooks/version-alert.js. Keys and texts: session.toml (session.*).
'use strict';

function vaGreater(a, b) {
  var parse = function (s) { return String(s).replace(/^v/, '').split('.').map(function (n) { var x = parseInt(n, 10); return isFinite(x) ? x : NaN; }); };
  var x = parse(a), y = parse(b);
  if ([x[0], x[1], x[2], y[0], y[1], y[2]].some(isNaN)) return false;
  if (x[0] !== y[0]) return x[0] > y[0];
  if (x[1] !== y[1]) return x[1] > y[1];
  return x[2] > y[2];
}

// The highest vX.Y.Z-named directory under the plugin cache root, or null.
function vaNewestMirrored(root) {
  var names = ah.fs.listDir(root);
  if (names === null) return null;
  var versions = names.filter(function (n) { return /^v?\d+\.\d+\.\d+$/.test(n) && ah.fs.kind(root + '/' + n) === 'dir'; });
  if (!versions.length) return null;
  versions.sort(function (a, b) { return vaGreater(a, b) ? -1 : (vaGreater(b, a) ? 1 : 0); });
  return versions[0];
}

// The first bullet under that version's heading in the mirrored copy's CHANGELOG.md, or null.
function vaHeadline(home, dir) {
  var raw = ah.fs.readText(home + '/' + ah.cfg('session.mirror_cache_root') + '/' + dir + '/' + ah.cfg('session.changelog_file'));
  if (raw === null) return null;
  var bare = dir.replace(/^v/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), heading = new RegExp('^##\\s+v?' + bare + '\\b');
  var inSection = false, lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (heading.test(lines[i])) { inSection = true; continue; }
    if (inSection) {
      if (/^##\s+/.test(lines[i])) break;
      var m = /^-\s+(.+)/.exec(lines[i].trim());
      if (m) return m[1].slice(0, ah.cfgNum('session.headline_max'));
    }
  }
  return null;
}

function vaIsSemver(v) { return typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v.trim().replace(/^v/i, '')); }

// The version the host's plugin registry (installed_plugins.json) names, found the way the update skill finds it; null when none.
function vaHarnessVersion(home) {
  var marketplace = home + '/' + ah.cfg('session.marketplace_dir'), override = ah.env.get(ah.cfg('session.marketplace_env'));
  if (override !== null && override !== '' && ah.path.isAbsolute(override) && ah.fs.isDir(override)) marketplace = override;
  var file = ah.path.resolveAbs(marketplace + '/../..') + '/' + ah.cfg('session.registry_file');
  var size = ah.fs.size(file);
  if (size === null || size > ah.cfgNum('session.registry_max_bytes')) return null;
  var raw = ah.fs.readText(file), data;
  if (raw === null) return null;
  try { data = JSON.parse(raw); } catch (e) { return null; }
  if (!data || typeof data !== 'object') return null;
  var reg = data.plugins && typeof data.plugins === 'object' ? data.plugins : data, entry = reg[ah.cfg('session.registry_key')];
  if (Array.isArray(entry)) {
    var valid = entry.filter(function (e) { return e && typeof e === 'object' && vaIsSemver(e.version); });
    var pick = valid.find(function (e) { return e.scope === 'user'; }) || valid.find(function (e) { return e.scope === 'project'; }) || valid[0];
    return pick ? pick.version : null;
  }
  if (typeof entry === 'string') return vaIsSemver(entry) ? entry : null;
  if (entry && typeof entry === 'object' && vaIsSemver(entry.version)) return entry.version;
  return null;
}

function decide(p, opts) {
  if (sess.judgeChild()) return 'allow';
  var home = spawn.osHome(), root = sess.pluginRoot(opts);
  if (home === null || root === null) return 'defer';
  var guard = ah.cfg('session.version_alert_guard');
  if (!ah.settings.bool('session.setting_version_alert') || ah.settings.skipped(guard)) return 'allow';
  if (p && typeof p === 'object' && (p.agent_id || p.agent_type || p.isSidechain === true || p.is_sidechain === true)) return 'allow';
  var sessionId = p && typeof p.session_id === 'string' ? p.session_id : '';
  // the running version: plugin.json beside the hooks directory; unreadable or without a version, Node throws and says nothing
  var raw = ah.fs.readText(root + '/' + ah.cfg('session.plugin_json')), running;
  if (raw === null) return 'allow';
  try { var pj = JSON.parse(raw); running = pj.version; } catch (e) { return 'allow'; }
  if (typeof running !== 'string' || !running) return 'allow';
  var now = ah.clock.now();
  // CASE 2: a newer release is already mirrored locally: reload only
  var mirrored = vaNewestMirrored(home + '/' + ah.cfg('session.mirror_cache_root'));
  if (mirrored && vaGreater(mirrored, running)) {
    var markFile = ah.cfg('session.reload_mark_file'), marker = sess.readCache(markFile);
    var key = { 'case': ah.cfg('session.case_reload'), sessionId: sessionId, mirrored: mirrored, running: running };
    if (sessionId && marker && sess.alreadyAdvised(marker, key)) return 'allow';
    var headline = vaHeadline(home, mirrored), harness = vaHarnessVersion(home), registered = true, ahead = false;
    if (vaIsSemver(harness)) {
      if (vaGreater(mirrored, harness)) registered = false;
      else if (vaGreater(harness, running)) ahead = true;
    }
    var hl = headline ? ah.cfg('session.highlight_prefix') + headline : '', vars = { mirrored: mirrored, running: running };
    var t = registered
      ? text.message('update', guard, { what: text.render(ah.cfg('session.reload_what'), vars), instead: text.render(ah.cfg(ahead ? 'session.reload_instead_ahead' : 'session.reload_instead'), vars), extra: [hl] })
      : text.message('update', guard, { what: text.render(ah.cfg('session.unregistered_what'), vars), why: ah.cfg('session.unregistered_why'), instead: ah.cfg('session.unregistered_instead'), extra: [hl] });
    if (sessionId) sess.persist(markFile, marker || { checkedAt: now }, key);
    return sess.advisory(t);
  }
  // CASE 1: the remote-latest cache; stale or absent, Node starts the detached refresh probe, so Node runs
  var file = ah.cfg('session.version_check_file');
  var cache = sess.readCache(file, function (c) { return typeof c.latest === 'string'; });
  if (!sess.isFresh(cache, now, ah.cfgNum('session.version_alert_ttl_ms'))) return 'defer';
  if (!vaGreater(cache.latest, running)) return 'allow';
  var k1 = { 'case': ah.cfg('session.case_update'), sessionId: sessionId, latest: cache.latest, running: running };
  if (sessionId && sess.alreadyAdvised(cache, k1)) return 'allow';
  var t1 = text.message('update', guard, { what: text.render(ah.cfg('session.update_what'), { latest: cache.latest, running: running }), instead: ah.cfg('session.update_instead') });
  if (sessionId) sess.persist(file, cache, k1);
  return sess.advisory(t1);
}
