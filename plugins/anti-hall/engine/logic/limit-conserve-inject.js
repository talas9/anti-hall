// check = "limit-conserve-inject" (UserPromptSubmit). Conservation is active when the mode is `on`, or when `auto` and a usage bucket
// of the OMC cache is at or over the threshold and the account-switch guard does not hold the reading stale. Then the directive is
// built and emit-dedupe (lib/74-emit-dedupe.js) decides whether to send it this turn; everything else prints the empty context line.
// The account-switch state file is read and written as Node does. The home is Node's os.homedir() (hookProc.adoptHome: HOME unset
// adopts the passwd home); a relative transcript path is opened for emit-dedupe from the payload cwd or the stand-in
// directory; a number or boolean reset time is read by Date exactly as V8 reads it. What the engine cannot reproduce exactly is decided
// natively and counted (native_unable): no home or the real home under a test marker prints nothing, a usage cache, ~/.claude.json
// or account state over the read cap means no conservation / no account change, an object reset time is skipped, an emit-dedupe
// timestamp only V8 reads is decided on what the engine reads. Mirrors hooks/limit-conserve-inject.js and hooks/limit-conserve.js. Keys and texts: ctxbudget.toml (ctxbudget.*).
'use strict';

function lcEmpty() { return { exact: { code: 0, out: ah.cfg('ctxbudget.ups_empty'), err: '' } }; }

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

// The reset time at minute precision (Node's minuteRounded): the cache's millisecond jitter would change the text every turn.
function lcMinuteRounded(iso) {
  var r = ah.cfg('ctxbudget.lc_reset_round'), t = new Date(iso).getTime();
  if (!isFinite(t)) return String(iso);
  return new Date(Math.round(t / r.ms) * r.ms).toISOString().replace(r.cut, r.to);
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

function decide(p) {
  if (ah.env.get(ah.cfg('ctxbudget.judge_child_env')) === ah.cfg('ctxbudget.judge_child_on')) return 'allow';
  if (!lcAdopt(p)) return lcEmpty();
  var home = ah.home();
  if (ah.settings.skipped(ah.cfg('ctxbudget.skip_limit_conserve'))) return lcEmpty();
  var tp = p && typeof p.transcript_path === 'string' && p.transcript_path !== '' ? p.transcript_path : null;
  var pend = { w: null }; // the account-state write, done once nothing can be handed back
  var active = lcConserving(home, pend);
  if (active === null) { if (pend.w) pend.w(); return lcEmpty(); }
  var resets = active.resetsAt !== null ? text.render(ah.cfg('ctxbudget.lc_resets_at'), { at: lcMinuteRounded(active.resetsAt) }) : ah.cfg('ctxbudget.lc_resets_next');
  var built = text.message('warn', ah.cfg('ctxbudget.lc_guard'), {
    what: text.render(ah.cfg('ctxbudget.lc_what'), { reason: active.reason }), why: ah.cfg('ctxbudget.lc_why'),
    instead: ah.cfg('ctxbudget.lc_instead') + resets + ' ' + ah.cfg('ctxbudget.lc_downshift'),
  });
  var sid = p && typeof p.session_id === 'string' ? p.session_id : null;
  var emit = true;
  if (sid !== null) {
    var o = { sessionId: sid, transcriptPath: tp, readPath: tp !== null ? hookProc.open(p, tp) : null, key: ah.cfg('ctxbudget.lc_dedupe_key'), content: built, keepaliveTurns: ah.cfgNum('ctxbudget.lc_keepalive_turns') };
    if (!dedupe.canDecide(o)) ah.unable('limit-conserve-inject:dedupe_unsure'); // a transcript timestamp only V8 reads: decided on what the engine reads
    if (pend.w) pend.w();
    emit = dedupe.shouldEmit(o);
  }
  if (sid === null && pend.w) pend.w();
  return emit ? { exact: { code: 0, out: text.render(ah.cfg('ctxbudget.ups_line'), { text: JSON.stringify(built) }), err: '' } } : lcEmpty();
}
