// Shared helpers of the session-maintenance checks (mirror hooks/lib/drift-baseline.js and the common shape of the SessionStart
// hooks version-alert, devswarm-version, claude-cli-version, repo-self-drift, defect-nudge and progress-prune). Files, limits,
// switches and texts: session.toml (session.*).
'use strict';
var sess = {
  // The silent no-op of every hook inside the judge child (judge-child-exit.js).
  judgeChild: function () { return ah.env.get(ah.cfg('session.judge_child_env')) === ah.cfg('session.judge_child_on'); },
  // The plugin root the dispatcher names (opts.plugin_root, else the environment), resolved to its real path; null when unknown.
  pluginRoot: function (opts) {
    var given = opts !== null && typeof opts === 'object' && typeof opts.plugin_root === 'string' && opts.plugin_root !== '' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
    if (given === null || given === '') return null;
    return ah.fs.realpath(given);
  },
  advisory: function (t) { return { advisory: text.advisoryJson(ah.cfg('session.event'), t) }; },
  // A cache file under the home directory: the parsed object when it is an object with a finite checkedAt (and passes `extra`), else null.
  readCache: function (rel, extra) {
    var raw = ah.state.readText(rel);
    if (raw === null) return null;
    var o;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    if (typeof o.checkedAt !== 'number' || !isFinite(o.checkedAt)) return null;
    if (extra && !extra(o)) return null;
    return o;
  },
  // The age must be non-negative: a clock rolled back reads as stale.
  isFresh: function (cache, now, ttl) {
    if (!cache) return false;
    var age = now - cache.checkedAt;
    return age >= 0 && age < ttl;
  },
  stable: function (key) {
    if (!key || typeof key !== 'object') return JSON.stringify(key);
    var sorted = {};
    Object.keys(key).sort().forEach(function (k) { sorted[k] = key[k]; });
    return JSON.stringify(sorted);
  },
  alreadyAdvised: function (cache, key) {
    var la = cache && cache.lastAdvised;
    if (!la || typeof la !== 'object') return false;
    return sess.stable(la) === sess.stable(key);
  },
  // Best-effort rewrite of the cache with lastAdvised = key.
  persist: function (rel, cache, key) {
    try { ah.state.writeAtomic(rel, JSON.stringify(Object.assign({}, cache, { lastAdvised: key }))); } catch (e) { /* a nicety */ }
  },
  parseSemver: function (v) {
    if (typeof v !== 'string' || !v) return null;
    var m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
    if (!m) return null;
    var a = [parseInt(m[1], 10), parseInt(m[2], 10), m[3] !== undefined ? parseInt(m[3], 10) : 0];
    return a.every(isFinite) ? a : null;
  },
  // {advise, reason}: a major or minor difference either way advises.
  classify: function (installed, baseline) {
    var a = sess.parseSemver(installed), b = sess.parseSemver(baseline);
    if (!a || !b) return { advise: false, reason: 'unparseable' };
    if (a[0] === b[0] && a[1] === b[1]) return { advise: false, reason: installed === baseline ? 'match' : 'patch' };
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) return { advise: true, reason: 'newer' };
    return { advise: true, reason: 'older' };
  },
  // Ask the engine's refresh job (`ah-engine refresh`, engine/defaults/refresh.toml) to run `probe`: where the Node hook started a
  // detached refresh process, the check writes a request file and answers silently, as the Node hook did that session. Best
  // effort: an unwritten request is written again by the next session that finds the cache stale.
  requestRefresh: function (probe, extra) {
    var body = Object.assign({ requestedAt: ah.clock.now() }, extra || {});
    try { ah.state.writeAtomic(ah.cfg('refresh.request_dir') + '/' + probe + ah.cfg('refresh.request_ext'), JSON.stringify(body)); } catch (e) { /* the next session asks again */ }
  },
  // The drift probe of an installed tool: the cache says what is installed; a stale cache asks the refresh job for the probe
  // and says nothing this session (the Node hook started the probe and said nothing).
  driftProbe: function (o) {
    if (sess.judgeChild()) return 'allow';
    if (!ah.settings.bool(o.setting) || ah.settings.skipped(ah.cfg(o.guard))) return 'allow';
    var now = ah.clock.now(), rel = ah.cfg(o.cache), cache = sess.readCache(rel);
    if (!sess.isFresh(cache, now, ah.cfgNum('session.drift_cache_ttl_ms'))) { sess.requestRefresh(o.probe); return 'allow'; }
    if (cache.installed === null || typeof cache.installed !== 'string' || !cache.installed) return 'allow';
    var baseline = ah.cfg(o.baseline), drift = sess.classify(cache.installed, baseline);
    if (!drift.advise) return 'allow';
    var key = o.keyed ? { installed: cache.installed, baseline: baseline } : null;
    if (o.keyed ? sess.alreadyAdvised(cache, key) : (cache.lastAdvised && typeof cache.lastAdvised === 'object' && cache.lastAdvised.installed === cache.installed && cache.lastAdvised.baseline === baseline)) return 'allow';
    var t = text.message('warn', ah.cfg(o.guard), {
      what: text.render(ah.cfg(o.what), { installed: cache.installed, baseline: baseline, newer: drift.reason === 'older' ? ah.cfg('session.older_suffix') : '' }),
      why: ah.cfg('session.drift_why'), instead: ah.cfg(o.instead),
    });
    sess.persist(rel, cache, key !== null ? key : { installed: cache.installed, baseline: baseline });
    return sess.advisory(t);
  },
};
