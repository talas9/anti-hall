// Shared read-only conservation decision. Account writes remain pending until the owning check accepts them.
'use strict';

// A JSON file under the home directory: {v} (parsed), {bad: true} (absent or not JSON), or {big: true} (too large to read here).
function lcReadJson(path) {
  var size = ah.fs.size(path);
  if (size === null) return { bad: true };
  if (size > ah.cfgNum('script.read_max_bytes')) return { big: true };
  var raw = ah.fs.readText(path);
  if (raw === null) return { bad: true };
  try { return { v: JSON.parse(raw) }; } catch (e) { return { bad: true }; }
}

// The account-switch guard: true when the logged-in account changed and the usage cache has not been refreshed since. The write of
// the account state Node makes at this point is not done here but left in `pend.w`: a case that cannot be settled must find nothing written.
function lcAccountStale(home, pend) {
  if (!ah.settings.bool('ctxbudget.set_limit_account_check')) return false;
  var cj = lcReadJson(home + '/' + ah.cfg('ctxbudget.claude_json'));
  if (cj.big) { ah.unable('limit-conserve-inject:claude_json_big'); return false; } // the account cannot be read: no account change is assumed
  var user = cj.v && typeof cj.v.userID === 'string' ? cj.v.userID : null;
  if (user === null) return false;
  var accountRel = ah.cfg('ctxbudget.account_state'), acc = lcReadJson(home + '/' + accountRel);
  if (acc.big) { ah.unable('limit-conserve-inject:account_big'); return false; } // the stored account state is left as it is
  var stored = acc.v && typeof acc.v === 'object' && typeof acc.v.userID === 'string' && typeof acc.v.usageCacheMtime === 'number' ? acc.v : null;
  var mtime = ah.fs.mtimeMs(home + '/' + ah.cfg('ctxbudget.usage_cache'));
  var write = function (m) { pend.w = function () { try { ah.state.writeAtomic(accountRel, text.render(ah.cfg('ctxbudget.lc_account_json'), { user: JSON.stringify(user), mtime: m === null ? ah.cfg('ctxbudget.json_null') : String(m) })); } catch (e) { /* best effort */ } }; };
  if (!stored) { write(mtime); return false; }
  if (stored.userID !== user) {
    if (mtime !== null && mtime <= stored.usageCacheMtime) return true;
    write(mtime);
    return false;
  }
  if (mtime !== null && mtime !== stored.usageCacheMtime) write(mtime);
  return false;
}

// The active conservation {reason, resetsAt}, or null when none.
function lcConserving(home, pend) {
  var mode = ah.settings.enum('ctxbudget.set_limit_mode');
  if (mode === 'on') return { reason: ah.cfg('ctxbudget.lc_reason_manual'), resetsAt: null };
  if (mode === 'off') return null;
  var threshold = ah.settings.num('ctxbudget.set_limit_threshold');
  var cache = lcReadJson(home + '/' + ah.cfg('ctxbudget.usage_cache'));
  if (cache.big) { ah.unable('limit-conserve-inject:usage_big'); return null; } // a usage cache over the read cap: no conservation
  if (cache.bad) return null;
  var parsed = cache.v, now = ah.clock.now();
  if (!parsed || typeof parsed !== 'object' || !parsed.data || typeof parsed.data !== 'object') return null;
  var d = parsed.data, ts = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0;
  var effective = function (pct, resetsAt) {
    if (resetsAt && typeof resetsAt === 'string') {
      var rt = new Date(resetsAt).getTime();
      if (isFinite(rt) && rt < now) return 0;
    } else if (ts > 0 && (now - ts) > ah.cfgNum('ctxbudget.usage_max_stale_ms')) return 0;
    return typeof pct === 'number' ? pct : 0;
  };
  var pcts = ah.cfg('ctxbudget.lc_bucket_pct'), resets = ah.cfg('ctxbudget.lc_bucket_resets'), names = ah.cfg('ctxbudget.lc_bucket_trip');
  var trips = [], candidates = [];
  for (var i = 0; i < pcts.length; i++) {
    if (effective(d[pcts[i]], d[resets[i]]) < threshold) continue;
    trips.push(names[i]);
    if (d[resets[i]]) {
      // a number or boolean is read by Date exactly as V8 reads it; an object or array goes through its text, which V8's legacy parser decides
      if (typeof d[resets[i]] === 'object') { ah.unable('limit-conserve-inject:resets_object'); continue; } // no reset time is read from it
      candidates.push(d[resets[i]]);
    }
  }
  if (!trips.length) return null;
  if (lcAccountStale(home, pend)) return null;
  var finite = candidates.filter(function (s) { return isFinite(new Date(s).getTime()); });
  finite.sort(function (a, b) { return new Date(a).getTime() - new Date(b).getTime(); });
  return { reason: trips.join('+'), resetsAt: finite.length ? finite[0] : null };
}


// Node's os.homedir() for this call: false when there is none or it is the real home under a test marker (Node's own guard then writes
// nothing); a relative HOME is resolved against the stand-in directory (counted).
function lcAdopt(p) {
  var why = hookProc.adoptHome();
  if (why === null) return true;
  ah.unable('limit-conserve-inject:' + why);
  if (why !== 'relative_home') return false;
  var h = hookProc.home(p);
  if (h === null) return false;
  ah.useHome(h);
  return true;
}

function lcSessionConserving(p, pend) {
  if (ah.env.get(ah.cfg('ctxbudget.judge_child_env')) === ah.cfg('ctxbudget.judge_child_on') || !lcAdopt(p)) return null;
  if (ah.settings.skipped(ah.cfg('ctxbudget.skip_limit_conserve'))) return null;
  return lcConserving(ah.home(), pend);
}
