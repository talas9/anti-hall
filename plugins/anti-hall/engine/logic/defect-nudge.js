// check = "defect-nudge" (SessionStart). A once-a-day, non-blocking nudge about the file-based defect channel
// (~/.anti-hall/defects/*.jsonl). In the anti-hall repository it counts unfinished reports; anywhere else it counts defects this
// project reported that now carry a later ruling. The line holds counts and ages only. The defect files are other agents' data:
// read-only here. The hook falls back to its own working directory when the payload has no cwd; a script does not know it, so it
// defers. Mirrors hooks/defect-nudge.js and the reading half of hooks/lib/defect-store.js. Keys and texts: session.toml (session.defect_*).
'use strict';

function dnExists(p) { return ah.fs.isFile(p) || ah.fs.isDir(p); }

function dnLines(file) {
  var raw = ah.fs.readText(file);
  if (raw === null) return [];
  var out = [];
  raw.split('\n').filter(function (l) { return l.length > 0; }).forEach(function (l) {
    var o;
    try { o = JSON.parse(l); } catch (e) { return; }
    if (o && typeof o === 'object') out.push(o);
  });
  return out;
}

function dnCmp(a, b) {
  var pa = sess.parseSemver(a), pb = sess.parseSemver(b);
  if (!pa || !pb) return null;
  for (var i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// The status and first-seen time a defect's lines derive.
function dnDerive(lines) {
  var status = ah.cfg('session.defect_open'), firstSeen = null, lastRuling = null;
  lines.forEach(function (o) {
    if (typeof o.at === 'string' && o.at && firstSeen === null) firstSeen = o.at;
    if (o.t === ah.cfg('session.defect_report')) {
      if (lastRuling && lastRuling.status === ah.cfg('session.defect_fixed') && lastRuling.fixedIn) {
        var c = dnCmp(o.v, lastRuling.fixedIn);
        if (c !== null && c >= 0) status = ah.cfg('session.defect_regressed');
      }
    } else if (o.t === ah.cfg('session.defect_backfill')) {
      if (typeof o.status === 'string') status = o.status;
    } else if (o.t === ah.cfg('session.defect_ruling')) {
      if (typeof o.status === 'string') { status = o.status; lastRuling = { status: o.status, fixedIn: typeof o.fixedIn === 'string' ? o.fixedIn : null }; }
    }
  });
  return { status: status, firstSeen: firstSeen };
}

function dnDaysAgo(iso, now) {
  // QuickJS reads a dotted version-like string ("0.0.0") as a date that V8 rejects; Node counts that as unparseable.
  if (typeof iso === 'string' && /^\d+(?:\.\d+){2,}$/.test(iso)) return 0;
  var ms = Date.parse(iso || '');
  if (!isFinite(ms)) return 0;
  return Math.max(0, Math.floor((now - ms) / ah.cfgNum('session.day_ms')));
}

// The lines of the defect's open file, else its archive copy, else its history copy; null when it has none.
function dnShow(defects, fp) {
  var ext = ah.cfg('session.defect_ext'), file = defects + '/' + fp + ext;
  if (!dnExists(file)) {
    var archive = defects + '/' + ah.cfg('session.archive_dir'), months = ah.fs.listDir(archive) || [], found = null;
    for (var i = 0; i < months.length; i++) {
      var cand = archive + '/' + months[i] + '/' + fp + ext;
      if (dnExists(cand)) { found = cand; break; }
    }
    var history = defects + '/' + ah.cfg('session.history_dir') + '/' + fp + ext;
    if (found === null && dnExists(history)) found = history;
    if (found === null) return null;
    file = found;
  }
  return dnLines(file);
}

function decide(p) {
  if (sess.judgeChild()) return 'allow';
  if (!ah.settings.bool('session.setting_defect_nudge') || ah.settings.skipped(ah.cfg('session.defect_nudge_guard'))) return 'allow';
  var cwd = p && typeof p.cwd === 'string' && p.cwd !== '' && ah.path.isAbsolute(p.cwd) ? p.cwd : null;
  var home = spawn.osHome();
  if (cwd === null || home === null) return 'defer';
  var stamp = ah.cfg('session.state_dir') + '/' + ah.cfg('session.defect_stamp'), now = ah.clock.now();
  var raw = ah.state.readText(stamp);
  if (raw !== null && raw.trim() !== '') {
    try {
      var last = JSON.parse(raw.trim());
      if (last && typeof last.lastSweep === 'number' && isFinite(last.lastSweep) && last.lastSweep <= now && (now - last.lastSweep) < ah.cfgNum('session.defect_throttle_ms')) return 'allow';
    } catch (e) { /* a corrupt stamp re-arms */ }
  }
  var defects = home + '/' + ah.cfg('session.state_dir') + '/' + ah.cfg('session.defects_dir'), ext = ah.cfg('session.defect_ext');
  var names = ah.fs.listDir(defects) || [];
  if (ah.fs.isDir(defects) && ah.fs.readdir(defects) === null) return 'defer'; // too many entries to list exactly
  var list = names.filter(function (n) { return n.endsWith(ext); }).map(function (n) {
    return { fp: n.slice(0, n.length - ext.length), lines: dnLines(defects + '/' + n) };
  });
  // arm the stamp first, best effort, as Node does before it sweeps
  try { ah.state.writeAtomic(stamp, JSON.stringify({ lastSweep: now })); } catch (e) { /* best effort */ }
  var guard = ah.cfg('session.defect_nudge_guard'), line = '';
  if (dnExists(ah.path.join(cwd, ah.cfg('session.anti_hall_marker')))) {
    var states = list.map(function (d) { return dnDerive(d.lines); });
    var active = states.filter(function (s) { return ah.cfg('session.defect_closed').indexOf(s.status) < 0; });
    var regressed = states.filter(function (s) { return s.status === ah.cfg('session.defect_regressed'); }).length;
    if (active.length > 0) {
      var oldest = 0;
      active.forEach(function (s) { oldest = Math.max(oldest, dnDaysAgo(s.firstSeen, now)); });
      line = text.message('tip', guard, {
        what: text.render(ah.cfg('session.defect_maintainer_what'), { active: active.length, regressed: regressed, oldest: oldest }),
        instead: ah.cfg('session.defect_maintainer_instead'),
      });
    }
  } else {
    var proj = ah.path.basename(cwd), count = 0;
    list.forEach(function (d) {
      var lines = dnShow(defects, d.fp);
      if (!lines) return;
      var lastOwn = -1;
      lines.forEach(function (l, i) { if (l.t === ah.cfg('session.defect_report') && l.proj === proj) lastOwn = i; });
      if (lastOwn === -1) return;
      if (lines.some(function (l, i) { return i > lastOwn && l.t === ah.cfg('session.defect_ruling'); })) count++;
    });
    if (count > 0) {
      line = text.message('tip', guard, { what: text.render(ah.cfg('session.defect_reporter_what'), { count: count }), instead: ah.cfg('session.defect_reporter_instead') });
    }
  }
  return line === '' ? 'allow' : sess.advisory(line);
}
