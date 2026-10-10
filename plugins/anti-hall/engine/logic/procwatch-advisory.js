// check = "procwatch-advisory" (SessionStart, UserPromptSubmit, PreToolUse; engine-only, no Node twin). Turns the process watch's
// report (the scheduled `procwatch` job writes it: orphans, stops, resource warnings, free disk space) into ONE advisory per event,
// with cooldowns kept in a small state file. It reads facts and warns; it never signals a process and never deletes anything.
// At critical disk space a PreToolUse command that writes a lot of data is warned about, or blocked when the owner opted into
// diskWatch.blockAtCritical. A script failure defers to the no-op fallback hook: a broken script is silence, never a block.
// Every pattern, number and text is a setting (procwatch.toml, resource_watch.toml, disk_watch.toml).
'use strict';

// A file under the home directory (the state directory), read whole (capped by script.read_max_bytes); null when absent.
function pwRead(rel) { return ah.fs.readText(ah.home() + '/' + rel); }

function pwReport() {
  var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('paths.state_dir') + '/' + ah.cfg('procwatch.report_file');
  var raw = pwRead(rel);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function pwStateRel() { return ah.cfg('paths.base_dir') + '/' + ah.cfg('paths.state_dir') + '/' + ah.cfg('procwatch.state_rel'); }

function pwLoad() {
  var raw = pwRead(pwStateRel());
  if (raw === null) return { last: {}, dirty: false };
  try {
    var o = JSON.parse(raw);
    return { last: (o && typeof o.last === 'object' && o.last !== null && !Array.isArray(o.last)) ? o.last : {}, dirty: false };
  } catch (e) { return { last: {}, dirty: false }; }
}

// True (and remembered) when `key` has not fired within `cooldown` seconds.
function pwFire(st, key, nowS, cooldown) {
  var t = st.last[key];
  if (typeof t === 'number' && nowS - t < cooldown) return false;
  st.last[key] = nowS;
  st.dirty = true;
  return true;
}

function pwSave(st, nowS) {
  if (!st.dirty) return;
  var keep = ah.cfgNum('procwatch.state_keep_s');
  Object.keys(st.last).forEach(function (k) { if (nowS - st.last[k] > keep) delete st.last[k]; });
  try { ah.state.writeAtomic(pwStateRel(), JSON.stringify({ last: st.last })); } catch (e) { /* a lost cooldown record repeats one warning */ }
}

function pwMore(n, shown) { return n > shown ? text.render(ah.cfg('procwatch.msg_more'), { m: n - shown }) : ''; }

function pwMsg(kind, what, why, instead) {
  return text.message(kind, ah.cfg('procwatch.guard_name'), { what: what, why: why, instead: instead });
}

function pwProcLine(f) { return 'pid ' + f.pid + ' ' + String(f.cmd || '') + ' [' + String(f.class || '') + ']'; }

// The directory a process runs in, appended when the report knows it (which project owns the process).
function pwProcOwned(f) {
  return pwProcLine(f) + (typeof f.cwd === 'string' && f.cwd !== '' ? text.render(ah.cfg('procwatch.msg_proc_cwd'), { cwd: f.cwd }) : '');
}

function pwOrphans(r, sid, nowS, st, parts) {
  var o = r.orphans || {}, count = typeof o.count === 'number' ? o.count : 0;
  var cooldown = ah.cfgNum('procwatch.orphan_cooldown_s');
  // a given process is reported once per session (acknowledged in the state file): a process of another project that this session
  // cannot act on is not repeated every cooldown
  var listed = (Array.isArray(o.listed) ? o.listed : []).filter(function (f) { return st.last['orphan-ack:' + sid + ':' + f.pid + ':' + f.cmd] === undefined; });
  var unlisted = Math.max(0, count - (Array.isArray(o.listed) ? o.listed.length : 0));
  if (listed.length > 0 && pwFire(st, 'orphans:' + sid, nowS, cooldown)) {
    var max = ah.cfgNum('procwatch.orphan_max_named'), shown = listed.slice(0, max);
    shown.forEach(function (f) { st.last['orphan-ack:' + sid + ':' + f.pid + ':' + f.cmd] = nowS; });
    var modes = r.modes && typeof r.modes === 'object' ? Object.keys(r.modes).map(function (k) { return k + '=' + r.modes[k]; }).join(', ') : '';
    var n = listed.length + unlisted;
    parts.push(pwMsg('warn',
      text.render(ah.cfg('procwatch.msg_orphans_what'), { n: n, list: shown.map(pwProcOwned).join('; '), more: pwMore(n, shown.length) }),
      text.render(ah.cfg('procwatch.msg_orphans_why'), { modes: modes }), ah.cfg('procwatch.msg_orphans_instead')));
  }
  var stopped = (Array.isArray(r.kills) ? r.kills : []).filter(function (e) { return e.outcome !== 'gone' && typeof e.ts_s === 'number' && e.ts_s + cooldown > nowS; });
  if (stopped.length > 0 && pwFire(st, 'killed:' + sid, nowS, cooldown)) {
    parts.push(pwMsg('tip', text.render(ah.cfg('procwatch.msg_killed'), { n: stopped.length, list: stopped.map(pwProcLine).join('; ') }), '', ''));
  }
}

function pwResource(r, sid, myPid, st, parts) {
  var key = ah.cfg('procwatch.resource_shown_key') + ':' + sid + ':' + myPid;
  var since = typeof st.last[key] === 'number' ? st.last[key] : 0, newest = since, lines = [];
  (Array.isArray(r.resource) ? r.resource : []).forEach(function (w) {
    var ts = typeof w.ts_s === 'number' ? w.ts_s : 0, sp = typeof w.session_pid === 'number' ? w.session_pid : 0;
    var mine = sp === 0 || (myPid !== 0 && sp === myPid) || (sid !== '' && w.session === sid);
    if (ts <= since || !mine) return;
    if (ts > newest) newest = ts;
    if (w.kind === 'swap') lines.push(text.render(ah.cfg('resource_watch.msg_swap'), { used: w.usage, limit: w.limit }));
    else if (w.kind === 'pressure') lines.push(text.render(ah.cfg('resource_watch.msg_pressure'), { value: w.usage, limit: w.limit }));
    else lines.push(text.render(ah.cfg('resource_watch.msg_proc_what'), { name: w.name, pid: w.pid, session: sp, usage: w.usage, limit: w.limit }));
  });
  if (lines.length === 0) return;
  st.last[key] = newest;
  st.dirty = true;
  parts.push(pwMsg('warn', text.render(ah.cfg('resource_watch.msg_what'), { list: lines.join('; ') }), ah.cfg('resource_watch.msg_why'), ah.cfg('resource_watch.msg_instead')));
}

function pwDiskLines(low) {
  return low.map(function (v) { return text.render(ah.cfg('disk_watch.msg_vol'), { path: v.path, free: v.free, pct: v.pct, level: v.level }); });
}

function pwDiskInstead(disk) {
  var g = Array.isArray(disk.growth) ? disk.growth : [], growth = '';
  if (g.length > 0) growth = text.render(ah.cfg('disk_watch.msg_growth'), { list: g.map(function (e) { return e.path + ' (' + e.size + ')'; }).join(', ') });
  return text.render(ah.cfg('disk_watch.msg_instead'), { growth: growth });
}

function decide(p) {
  if (p === null || typeof p !== 'object') return 'allow';
  var event = p[ah.cfg('procwatch.f_event')];
  if (typeof event !== 'string' || ah.cfg('procwatch.advisory_events').indexOf(event) < 0) return 'allow';
  if (!ah.settings.bool('procwatch.sw_enabled') || ah.settings.skipped(ah.cfg('procwatch.guard_name'))) return 'allow';
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null) home = ah.env.get(ah.cfg('env.home_alt'));
  if (!home) return 'allow';
  var r = pwReport();
  if (r === null || typeof r.ts_s !== 'number') return 'allow';
  var nowS = Math.floor(Date.now() / 1000);
  if (nowS - r.ts_s > ah.cfgNum('procwatch.report_max_age_s')) return 'allow';
  var sid = typeof p[ah.cfg('procwatch.f_session')] === 'string' ? p[ah.cfg('procwatch.f_session')] : '';
  var mine = parseInt(ah.env.get(ah.cfg('procwatch.owner_var')) || '', 10);
  var myPid = isNaN(mine) ? 0 : mine;
  var st = pwLoad(), parts = [];

  // ---- disk: the report's volumes; a heavy command at critical is warned about (or blocked by opt-in) ----
  var disk = r.disk && typeof r.disk === 'object' ? r.disk : null;
  if (disk !== null && ah.settings.bool('disk_watch.sw_enabled')) {
    var low = (Array.isArray(disk.volumes) ? disk.volumes : []).filter(function (v) { return v.level !== 'ok'; });
    var critical = low.some(function (v) { return v.level === 'critical'; });
    var cooldown = ah.settings.num('disk_watch.cooldown_s');
    if (event === ah.cfg('procwatch.pre_tool_event')) {
      var input = p[ah.cfg('procwatch.f_tool_input')], cmd = input && typeof input === 'object' ? input[ah.cfg('procwatch.f_command')] : '';
      if (critical && typeof cmd === 'string' && ah.re.test(ah.cfg('disk_watch.heavy_command_re'), 'i', cmd)) {
        if (ah.settings.bool('disk_watch.block_at_critical')) {
          pwSave(st, nowS);
          return { block: text.message('block', ah.cfg('procwatch.guard_name'), { what: text.render(ah.cfg('disk_watch.msg_blocked'), { list: pwDiskLines(low).join('; ') }) }) };
        }
        if (pwFire(st, 'heavy:' + sid, nowS, cooldown)) {
          parts.push(pwMsg('warn', ah.cfg('disk_watch.msg_heavy') + ' ' + text.render(ah.cfg('disk_watch.msg_what'), { list: pwDiskLines(low).join('; ') }), ah.cfg('disk_watch.msg_why'), pwDiskInstead(disk)));
        }
      }
    } else if (low.length > 0 && pwFire(st, 'disk:' + sid + ':' + (critical ? 'critical' : 'warn'), nowS, cooldown)) {
      parts.push(pwMsg('warn', text.render(ah.cfg('disk_watch.msg_what'), { list: pwDiskLines(low).join('; ') }), ah.cfg('disk_watch.msg_why'), pwDiskInstead(disk)));
    }
  }
  if (event === ah.cfg('procwatch.pre_tool_event')) {
    pwSave(st, nowS);
    return parts.length > 0 ? { advisory: text.advisoryJson(event, parts.join('\n')) } : 'allow';
  }

  // ---- orphans, stops and resource warnings from the report ----
  pwOrphans(r, sid, nowS, st, parts);
  pwResource(r, sid, myPid, st, parts);
  pwSave(st, nowS);
  return parts.length > 0 ? { advisory: text.advisoryJson(event, parts.join('\n')) } : 'allow';
}
