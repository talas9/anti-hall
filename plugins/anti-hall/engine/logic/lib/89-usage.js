// The subscription usage snapshot every usage reader shares (GH #981): limit conservation (82), the spawn stand-down and swarm-guard (81),
// edit-guard's small-edit relief and the limit-status script. limitConserve.usageSource picks the file: omc-cache (the OMC plugin's
// usage cache, ctxbudget.usage_cache), statusline (anti-hall's statusline snapshot of the host's rate limits, ctxbudget.usage_statusline_file)
// or auto (the fresher of the two). A snapshot older than ctxbudget.usage_max_stale_ms is UNKNOWN, whatever its reset times say: a cache
// nothing refreshes any more must not keep a 70% weekly reading alive for days. Keys: ctxbudget.toml, omc_coexist.toml.
'use strict';
var usage = {
  // {path, parsed, ts} of one snapshot file, or null (absent, too big, not JSON, no data object). ts: its timestamp, else the file's mtime.
  readOne: function (path) {
    var size = ah.fs.size(path);
    if (size === null || size > ah.cfgNum('script.read_max_bytes')) return null;
    var raw = ah.fs.readText(path);
    if (raw === null) return null;
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') return null;
    var ts = typeof parsed.timestamp === 'number' && isFinite(parsed.timestamp) && parsed.timestamp > 0 ? parsed.timestamp : ah.fs.mtimeMs(path);
    return { path: path, parsed: parsed, ts: ts === null ? 0 : ts };
  },
  // The snapshot files of the configured source, in preference order.
  paths: function (home) {
    var src = ah.settings.enum('ctxbudget.set_usage_source');
    var omc = ah.path.join(home, ah.cfg('ctxbudget.usage_cache')), sl = ah.path.join(home, ah.cfg('ctxbudget.usage_statusline_file'));
    if (src === ah.cfg('ctxbudget.usage_source_omc')) return [omc];
    if (src === ah.cfg('ctxbudget.usage_source_statusline')) return [sl];
    return [sl, omc];
  },
  // The freshest snapshot of the configured source: {path, parsed, ts, stale}, or null when there is none. `stale`: older than
  // ctxbudget.usage_max_stale_ms (or of unknown age); a caller treats a stale snapshot as no reading.
  snapshot: function (home) {
    var best = null;
    usage.paths(home).forEach(function (p) {
      var s = usage.readOne(p);
      if (s !== null && (best === null || s.ts > best.ts)) best = s;
    });
    if (best === null) return null;
    var age = ah.clock.now() - best.ts;
    best.stale = !(best.ts > 0) || age > ah.cfgNum('ctxbudget.usage_max_stale_ms');
    return best;
  },
  // The snapshot to act on, or null: none, or stale (counted per reader, `tag`).
  fresh: function (home, tag) {
    var s = usage.snapshot(home);
    if (s === null) return null;
    if (s.stale) { try { ah.metric('usage_snapshot_stale', ['reader', tag]); } catch (e) { /* counting never fails a hook */ } return null; }
    return s;
  }
};
