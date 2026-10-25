// rules = "codex-scripts": the two Codex-only helper scripts as engine verbs (v1.0 lane L16; ports of codex/scripts/limit-conserve-status.js
// and codex/scripts/write-activation-sentinel.js). `ah-engine codex-limit-status` and `codex-activate` hand in the resolved settings
// (mode, where the mode came from, threshold, account check) and the working directory and print the text this script returns.
// `limitStatus` is isConserving() of hooks/limit-conserve.js, evaluated the same way (reset-aware, snapshot-age bound, account-switch
// guard); `activate` is the advisory marker the anti-hall-activate skill writes. Keys: codex_scripts.toml and ctxbudget.toml.
'use strict';

function csAbsent() {
  return { active: false, reason: 'cache-absent', weekly: null, fiveHour: null, sonnetWeekly: null, source: 'manual-only', stale: false, resetsAt: null };
}

function csJson(path) {
  var raw = ah.fs.readText(path, 0);
  if (raw === null) return { bad: true };
  try { return { v: JSON.parse(raw) }; } catch (e) { return { bad: true }; }
}

// isAccountSwitchStale of limit-conserve.js: the account state file is read and kept current exactly as Node does.
function csAccountStale(home, input, cacheMtime) {
  if (!input.accountCheck) return false;
  var cj = csJson(home + '/' + ah.cfg('ctxbudget.claude_json'));
  var user = cj.v && typeof cj.v.userID === 'string' ? cj.v.userID : null;
  if (user === null) return false;
  var rel = ah.cfg('ctxbudget.account_state'), acc = csJson(home + '/' + rel);
  var stored = acc.v && typeof acc.v === 'object' && typeof acc.v.userID === 'string' && typeof acc.v.usageCacheMtime === 'number' ? acc.v : null;
  var write = function (m) {
    try { ah.state.writeAtomic(rel, JSON.stringify({ userID: user, usageCacheMtime: m })); } catch (e) { /* best effort, as in Node */ }
  };
  if (!stored) { write(cacheMtime); return false; }
  if (stored.userID !== user) {
    if (cacheMtime !== null && cacheMtime <= stored.usageCacheMtime) return true;
    write(cacheMtime);
    return false;
  }
  if (cacheMtime !== null && cacheMtime !== stored.usageCacheMtime) write(cacheMtime);
  return false;
}

function limitStatus(input) {
  var r = csEvaluate(input);
  return { text: JSON.stringify(r, null, 2) + '\n' };
}

function csEvaluate(input) {
  try {
    var home = input.home, mode = input.mode;
    var base = { weekly: null, fiveHour: null, sonnetWeekly: null, stale: false, resetsAt: null };
    var src = input.modeSource === 'env' ? 'env' : 'settings';
    if (mode === 'on') return { active: true, reason: 'manual-on', weekly: null, fiveHour: null, sonnetWeekly: null, source: src, stale: false, resetsAt: null };
    if (mode === 'off') return { active: false, reason: '', weekly: null, fiveHour: null, sonnetWeekly: null, source: src, stale: false, resetsAt: null };
    var cachePath = home + '/' + ah.cfg('ctxbudget.usage_cache');
    var raw = ah.fs.readText(cachePath, 0);
    if (raw === null) return csAbsent();
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return csAbsent(); }
    if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') return csAbsent();
    var now = ah.clock.now(), threshold = input.threshold;
    var ts = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0;
    var stale = ts > 0 ? (now - ts) > ah.cfgNum('codex_scripts.stale_ms') : true;
    var d = parsed.data, maxStale = ah.cfgNum('ctxbudget.usage_max_stale_ms');
    var eff = function (pct, resetsAt) {
      if (resetsAt && typeof resetsAt === 'string') {
        var rt = new Date(resetsAt).getTime();
        if (isFinite(rt) && rt < now) return 0;
      } else if (ts > 0 && (now - ts) > maxStale) return 0;
      return typeof pct === 'number' ? pct : 0;
    };
    var pcts = ah.cfg('ctxbudget.lc_bucket_pct'), resets = ah.cfg('ctxbudget.lc_bucket_resets'), names = ah.cfg('ctxbudget.lc_bucket_trip');
    var level = [], trips = [];
    for (var i = 0; i < pcts.length; i++) {
      level.push(eff(d[pcts[i]], d[resets[i]]));
      if (level[i] >= threshold) trips.push(i);
    }
    var mtime = ah.fs.mtimeMs(cachePath);
    var accountStale = trips.length > 0 && csAccountStale(home, input, mtime);
    var active = !accountStale && trips.length > 0;
    var resetsAt = null;
    if (active) {
      var cands = [];
      trips.forEach(function (i) { if (d[resets[i]]) cands.push(d[resets[i]]); });
      if (cands.length) {
        var finite = cands.filter(function (s) { return isFinite(new Date(s).getTime()); });
        finite.sort(function (a, b) { return new Date(a).getTime() - new Date(b).getTime(); });
        resetsAt = finite.length ? finite[0] : null;
      }
    }
    return {
      active: active,
      reason: active ? trips.map(function (i) { return names[i]; }).join('+') : '',
      weekly: typeof d.weeklyPercent === 'number' ? d.weeklyPercent : null,
      fiveHour: typeof d.fiveHourPercent === 'number' ? d.fiveHourPercent : null,
      sonnetWeekly: typeof d.sonnetWeeklyPercent === 'number' ? d.sonnetWeeklyPercent : null,
      source: 'cache',
      stale: stale,
      resetsAt: resetsAt,
    };
  } catch (e) {
    return csAbsent();
  }
}

// -> {ok}: the marker body as the Node script writes it; `at` is the ISO time, `cwd` the working directory.
function activate(input) {
  var body = JSON.stringify({ activatedAt: input.at, scope: input.cwd }, null, 2) + '\n';
  var ok = ah.state.writeAtomic(ah.cfg('codex_scripts.sentinel_rel'), body);
  return { ok: ok !== false };
}
