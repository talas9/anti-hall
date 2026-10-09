// check = "handover-hygiene" (SessionStart advisory; also the engine of `ah-engine handovers index|check|search` and of the
// `handovers` scheduled job, which call this script with the event "Cli"). Engine-only, no Node twin.
//
// It keeps the handover tree searchable: one root brief (BRIEF.md + BRIEF.json) that references one brief per day, and each day
// brief references every handover of that day with typed fields (session, seq, title, situation, next action, decisions, owner
// preferences, files, commits, references, links to the previous and next handover of the session, attached PreCompact
// snapshots). The briefs are rebuilt only for the days whose files changed; every write is atomic and skipped when the bytes
// would not change, so a re-run is a no-op. The handover files themselves are never edited and nothing is ever deleted.
// Rules, patterns, caps and texts: handovers.toml. The host gives file listing, reading and the scoped atomic write.
'use strict';

var hh = null; // the state of the call in progress

// ---- small helpers ----------------------------------------------------------------------------------------------------

function hhRe(key, flags) {
  var src = ah.cfg(key), id = key + '|' + (flags || '');
  var c = hh.res[id];
  if (!c || c.src !== src) { c = hh.res[id] = { src: src, re: new RegExp(src, flags || '') }; }
  c.re.lastIndex = 0;
  return c.re;
}
function hhClean(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function hhPlain(s) { return hhClean(String(s).replace(new RegExp(ah.cfg('handovers.emphasis_re'), 'gi'), '')); }
function hhCut(s, n) {
  var a = Array.from(s);
  return a.length <= n ? s : a.slice(0, n).join('').replace(/\s+$/, '') + ah.cfg('handovers.ellipsis');
}
function hhOut(code, out, err) { return { exact: { code: code, out: out === undefined ? '' : out, err: err === undefined ? '' : err } }; }
function hhTpl(key, args) { return text.render(ah.cfg(key), args); }
function hhSeverity(code) { var m = ah.cfg('handovers.severities'); return m[code] || 'warn'; }
function hhProblem(code, detail, src) {
  var p = { code: code, severity: hhSeverity(code), detail: detail || '' };
  if (src) p.src = src;
  return p;
}
function hhEsc(s) { return String(s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' '); }
function hhLink(label, rel) { return '[' + String(label).replace(/([\[\]])/g, '\\$1') + '](' + encodeURI(rel) + ')'; }
function hhUniq(list) { var seen = {}, out = []; list.forEach(function (x) { if (!Object.prototype.hasOwnProperty.call(seen, x)) { seen[x] = 1; out.push(x); } }); return out; }
function hhLabel(k) { return ah.cfg('handovers.labels')[k]; }
function hhParse(text0) { try { return JSON.parse(text0); } catch (e) { return null; } }
function hhNow() { return Date.now(); }

// ---- finding the project ------------------------------------------------------------------------------------------------

// The nearest directory at or above `start` that has a handovers directory (never the home directory itself: that holds
// anti-hall's own global state).
function hhFindRoot(start) {
  if (!start || !ah.path.isAbsolute(start)) return null;
  var dir = ah.path.resolveAbs(start), rel = ah.cfg('handovers.dir'), home = ah.path.resolveAbs(ah.home() || '/');
  for (var i = 0; i <= ah.cfgNum('handovers.walk_up_max'); i++) {
    if (dir !== home && ah.fs.isDir(dir + '/' + rel)) return dir;
    var up = ah.path.resolveAbs(dir + '/..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// ---- scanning the tree (names, sizes and mtimes only) ---------------------------------------------------------------------

function hhIsHidden(name) { return name.indexOf(ah.cfg('handovers.hidden_prefix')) === 0; }

function hhScan(maxFiles) {
  var out = { days: [], stray: [], files: 0, truncated: false };
  var names = ah.fs.listDir(S_hdir()) || [];
  var dateRe = hhRe('handovers.date_re');
  var ext = ah.cfg('handovers.md_ext');
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (hhIsHidden(n)) continue;
    var st = ah.fs.lstat(S_hdir() + '/' + n);
    if (!st || st.kind !== 'dir') continue;
    if (!dateRe.test(n)) { out.stray.push(n); continue; }
    var day = { date: n, sessions: [] };
    var sess = ah.fs.listDir(S_hdir() + '/' + n) || [];
    for (var j = 0; j < sess.length; j++) {
      var sid = sess[j];
      if (hhIsHidden(sid)) continue;
      var sst = ah.fs.lstat(S_hdir() + '/' + n + '/' + sid);
      if (!sst || sst.kind !== 'dir') continue;
      var files = [];
      var fnames = ah.fs.listDir(S_hdir() + '/' + n + '/' + sid) || [];
      for (var k = 0; k < fnames.length; k++) {
        var f = fnames[k];
        if (hhIsHidden(f) || f.length <= ext.length || f.slice(-ext.length) !== ext) continue;
        if (maxFiles && out.files >= maxFiles) { out.truncated = true; continue; }
        var fst = ah.fs.lstat(S_hdir() + '/' + n + '/' + sid + '/' + f);
        if (!fst || fst.kind !== 'file') continue; // a link is never followed
        files.push({ name: f, size: fst.size, mtimeMs: fst.mtimeMs });
        out.files++;
      }
      day.sessions.push({ sid: sid, files: files });
    }
    out.days.push(day);
  }
  return out;
}
function S_hdir() { return hh.hdir; }

// The fingerprint of a day: its files with sizes and mtimes, and the rules that read them (a changed rule rebuilds the day).
function hhSig() {
  if (hh.sig === undefined) {
    var keys = ah.cfg('handovers.sig_keys'), parts = [String(ah.cfgNum('handovers.schema'))];
    keys.forEach(function (k) { parts.push(JSON.stringify(ah.cfg(k))); });
    hh.sig = ah.fnv(parts.join('\n'));
  }
  return hh.sig;
}
function hhDayFp(day) {
  var parts = [hhSig()];
  day.sessions.forEach(function (s) { s.files.forEach(function (f) { parts.push(s.sid + '/' + f.name + '|' + f.size + '|' + f.mtimeMs); }); });
  return ah.fnv(parts.join('\n'));
}

// ---- reading one handover ------------------------------------------------------------------------------------------------

function hhFrontMatter(lines) {
  var first = lines[0];
  if (first === undefined || !/^---\s*$/.test(first)) return { fm: null, next: 0 };
  var max = Math.min(lines.length, ah.cfgNum('handovers.front_matter_max_lines'));
  for (var j = 1; j < max; j++) {
    if (/^---\s*$/.test(lines[j])) {
      var map = {}, last = null;
      for (var i = 1; i < j; i++) {
        var m = /^([A-Za-z][A-Za-z0-9 _-]*?)\s*:\s*(.*)$/.exec(lines[i]);
        if (m && !/^\s/.test(lines[i])) { last = m[1].toLowerCase(); map[last] = m[2]; }
        else if (last !== null && /^\s+\S/.test(lines[i])) map[last] += ' ' + lines[i].trim();
      }
      return { fm: map, next: j + 1 };
    }
  }
  return { fm: null, next: 0 };
}

function hhSections(lines, from) {
  var headingRe = hhRe('handovers.heading_re'), out = [], fence = false;
  for (var i = from; i < lines.length; i++) {
    var l = lines[i];
    if (/^\s*(?:```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    var m = headingRe.exec(l);
    if (m) out.push({ level: m[1].length, title: m[2], at: i });
  }
  out.forEach(function (s, idx) {
    var end = lines.length;
    for (var k = idx + 1; k < out.length; k++) if (out[k].level <= s.level) { end = out[k].at; break; }
    s.start = s.at + 1; s.end = end;
  });
  return out;
}

function hhSectionText(lines, s) {
  var parts = [];
  for (var i = s.start; i < s.end; i++) {
    var l = lines[i];
    if (/^\s*#{1,6}\s/.test(l) || /^\s*(?:```|~~~)/.test(l) || /^\s*$/.test(l)) continue;
    parts.push(l.trim().replace(/^[-*+]\s+/, ''));
  }
  return hhClean(parts.join(' '));
}
function hhSectionItems(lines, s, max) {
  var bullet = hhRe('handovers.bullet_re'), out = [], para = [], cap = ah.cfgNum('handovers.item_chars');
  for (var i = s.start; i < s.end && out.length < max; i++) {
    var m = bullet.exec(lines[i]);
    if (m) out.push(hhCut(hhClean(m[1].replace(/\*\*/g, '')), cap));
    else if (/\S/.test(lines[i]) && !/^\s*#{1,6}\s/.test(lines[i]) && !/^\s*(?:```|~~~)/.test(lines[i])) para.push(lines[i].trim());
  }
  if (out.length === 0 && para.length > 0) out.push(hhCut(hhClean(para.join(' ')), cap));
  return out;
}
function hhFirstParagraph(lines, from) {
  var meta = hhRe('handovers.meta_line_re'), para = [];
  for (var i = from; i < lines.length; i++) {
    var l = lines[i];
    if (/^\s*#{1,6}\s/.test(l)) { if (para.length) break; continue; }
    if (/^\s*$/.test(l)) { if (para.length) break; continue; }
    if (para.length === 0 && meta.test(l)) { // a metadata line (Trigger:, Date:, ...): the paragraph that follows is the summary
      while (i + 1 < lines.length && /\S/.test(lines[i + 1])) i++;
      continue;
    }
    para.push(l.trim());
  }
  return hhClean(para.join(' '));
}

function hhNormRef(root, base, target) {
  // A project-relative path (or null when the target is outside the project or not a file path).
  var t = target.replace(/#.*$/, '').replace(/[.,;:]+$/, '');
  if (t === '') return null;
  var abs;
  if (ah.path.isAbsolute(t)) abs = ah.path.resolveAbs(t);
  else if (t.indexOf('.anti-hall/') === 0) abs = ah.path.resolve(root, t);
  else abs = ah.path.resolve(root + '/' + base, t);
  var rel = ah.path.relative(root, abs);
  return rel.indexOf('..') === 0 || rel === '' ? null : rel;
}

function hhParseDoc(text0, sid, root, fileDirRel) {
  var lines = text0.split(/\r?\n/);
  var fmr = hhFrontMatter(lines), fm = fmr.fm;
  var secs = hhSections(lines, fmr.next);
  var info = { frontMatter: fm !== null, title: '', situation: '', next: '', source: 'none', decisions: [], open: [], prefs: [], files: [], commits: [], refs: [], predecessor: null };
  var cap = ah.cfgNum('handovers.summary_chars'), icap = ah.cfgNum('handovers.item_chars');
  var fmGet = function (key) { var v = fm ? fm[ah.cfg(key).toLowerCase()] : undefined; return v === undefined ? '' : hhClean(v); };
  var h1 = null;
  for (var q = 0; q < secs.length; q++) if (secs[q].level === 1) { h1 = secs[q]; break; }
  var title = h1 ? hhClean(h1.title) : '';
  var tp = hhRe('handovers.title_prefix_re');
  if (title) title = title.replace(tp, '');
  info.title = hhCut(title || fmGet('handovers.fm_title_key'), icap);
  // situation
  var sit = fmGet('handovers.fm_situation_key');
  if (sit) { info.situation = hhCut(hhPlain(sit), cap); info.source = 'front_matter'; }
  var nxt = fmGet('handovers.fm_next_key');
  if (nxt) info.next = hhCut(hhPlain(nxt), cap);
  var sitRe = hhRe('handovers.situation_heading_re', 'i'), nextRe = hhRe('handovers.next_heading_re', 'i');
  var openRe = hhRe('handovers.open_decisions_heading_re', 'i'), decRe = hhRe('handovers.decisions_heading_re', 'i'), prefRe = hhRe('handovers.preferences_heading_re', 'i');
  secs.forEach(function (s) {
    var t = hhClean(s.title).replace(/^[\d.)\s]+/, '').replace(/[*_`]/g, '');
    if (!info.situation && sitRe.test(t)) { var x = hhSectionText(lines, s); if (x) { info.situation = hhCut(hhPlain(x), cap); info.source = 'heading'; } }
    else if (!info.next && nextRe.test(t)) { var y = hhSectionText(lines, s); if (y) info.next = hhCut(hhPlain(y), cap); }
    if (openRe.test(t)) info.open = info.open.concat(hhSectionItems(lines, s, ah.cfgNum('handovers.decisions_max')));
    else if (prefRe.test(t)) info.prefs = info.prefs.concat(hhSectionItems(lines, s, ah.cfgNum('handovers.preferences_max')));
    else if (decRe.test(t)) info.decisions = info.decisions.concat(hhSectionItems(lines, s, ah.cfgNum('handovers.decisions_max')));
  });
  if (!info.situation && ah.cfgNum('handovers.first_paragraph_fallback') === 1) {
    var para = hhFirstParagraph(lines, h1 ? h1.start : fmr.next);
    if (para) { info.situation = hhCut(hhPlain(para), cap); info.source = 'first_paragraph'; }
  }
  info.decisions = hhUniq(info.decisions).slice(0, ah.cfgNum('handovers.decisions_max'));
  info.open = hhUniq(info.open).slice(0, ah.cfgNum('handovers.decisions_max'));
  info.prefs = hhUniq(info.prefs).slice(0, ah.cfgNum('handovers.preferences_max'));
  // files, commits
  var m, fre = new RegExp(ah.cfg('handovers.file_ref_re'), 'g'), cre = new RegExp(ah.cfg('handovers.commit_re'), 'g');
  var files = [], commits = [];
  while ((m = fre.exec(text0)) !== null) files.push(m[1]);
  while ((m = cre.exec(text0)) !== null) if (sid.indexOf(m[1]) !== 0 && fileDirRel.indexOf(m[1]) < 0) commits.push(m[1]);
  info.files = hhUniq(files).slice(0, ah.cfgNum('handovers.files_max'));
  info.commits = hhUniq(commits).slice(0, ah.cfgNum('handovers.commits_max'));
  // references: handover paths mentioned, and relative Markdown links
  var refs = [], pre = new RegExp(ah.cfg('handovers.path_ref_re'), 'g'), lre = new RegExp(ah.cfg('handovers.md_link_re'), 'g'), ext = hhRe('handovers.external_re', 'i');
  while ((m = pre.exec(text0)) !== null) { var r1 = hhNormRef(root, fileDirRel, m[0]); if (r1) refs.push(r1); }
  while ((m = lre.exec(text0)) !== null) { if (!ext.test(m[1])) { var r2 = hhNormRef(root, fileDirRel, m[1]); if (r2) refs.push(r2); } }
  var prm = null, predRe = hhRe('handovers.predecessor_re', 'i');
  for (var li = 0; li < lines.length && prm === null; li++) { var pm = predRe.exec(lines[li]); if (pm) prm = pm[1]; }
  var fmPred = fmGet('handovers.fm_predecessor_key');
  if (!prm && fmPred) prm = fmPred;
  if (prm) { var pr = hhNormRef(root, fileDirRel, prm); if (pr) { info.predecessor = { target: pr, id: null }; refs.unshift(pr); } }
  info.refs = hhUniq(refs).slice(0, ah.cfgNum('handovers.refs_max')).map(function (t) { return { target: t, ok: null }; });
  return info;
}

// ---- one day ---------------------------------------------------------------------------------------------------------------

function hhClassify(name, sid) {
  var m = hhRe('handovers.handover_re').exec(name);
  var legacy = hhRe('handovers.legacy_dir_re').test(sid);
  if (m) return { kind: legacy ? 'legacy' : 'handover', seq: m[1] ? parseInt(m[1], 10) : 1, name: null };
  m = hhRe('handovers.named_re').exec(name);
  if (m) return { kind: legacy ? 'legacy' : 'named', seq: null, name: m[1] };
  m = hhRe('handovers.snapshot_re').exec(name);
  if (m) return { kind: 'snapshot', seq: parseInt(m[1], 10), name: null };
  var comp = ah.cfg('handovers.companion_kinds');
  if (Object.prototype.hasOwnProperty.call(comp, name)) return { kind: 'companion', companion: comp[name], seq: null, name: null };
  return { kind: 'companion', companion: ah.cfg('handovers.other_kind'), seq: null, name: null };
}

function hhStem(name) { return name.slice(0, name.length - ah.cfg('handovers.md_ext').length); }

function hhBuildEntry(date, sid, f, cls) {
  var rel = date + '/' + sid + '/' + f.name, abs = hh.hdir + '/' + rel, cap = ah.cfgNum('handovers.read_max_bytes');
  var e = {
    id: date + '/' + sid + '/' + hhStem(f.name), uid: 'h-' + ah.sha1(date + '/' + sid + '/' + hhStem(f.name)).slice(0, 12),
    date: date, session: sid, file: f.name, path: rel, kind: cls.kind, seq: cls.seq, name: cls.name,
    title: '', situation: '', next_action: '', summary_source: 'none', front_matter: false,
    decisions: [], open_decisions: [], preferences: [], files: [], commits: [], refs: [], predecessor: null,
    session_prev: null, session_next: null, snapshots: [], companions: [],
    size: f.size, mtimeMs: f.mtimeMs, sha1: '', truncated: false, problems: [],
  };
  var raw = f.size === 0 ? '' : ah.fs.readText(abs, cap);
  if (raw === null) { e.problems.push(hhProblem('unreadable', rel)); e.title = hhStem(f.name); return e; }
  if (f.size === 0 || /^\s*$/.test(raw)) { e.problems.push(hhProblem('empty', rel)); e.title = hhStem(f.name); return e; }
  e.sha1 = ah.sha1(raw);
  if (f.size > cap) { e.truncated = true; e.problems.push(hhProblem('too_large', f.size + ' > ' + cap)); }
  var info = hhParseDoc(raw, sid, hh.root, hh.rel + '/' + date + '/' + sid);
  e.title = info.title || hhStem(f.name);
  e.situation = info.situation; e.next_action = info.next; e.summary_source = info.source; e.front_matter = info.frontMatter;
  e.decisions = info.decisions; e.open_decisions = info.open; e.preferences = info.prefs; e.files = info.files; e.commits = info.commits;
  e.refs = info.refs; e.predecessor = info.predecessor;
  var exempt = ah.cfg('handovers.exempt_kinds'), req = ah.cfg('handovers.required_by_kind')[e.kind] || [];
  if (exempt.indexOf(e.kind) < 0) {
    req.forEach(function (code) {
      if ((code === 'no_front_matter' && !e.front_matter) || (code === 'no_situation' && !e.situation) || (code === 'no_next_action' && !e.next_action)) e.problems.push(hhProblem(code, ''));
    });
  }
  return e;
}

function hhSnapshot(date, sid, f, cls) {
  var rel = date + '/' + sid + '/' + f.name;
  var snap = { file: f.name, path: rel, n: cls.seq, at: null, handover: null };
  var raw = ah.fs.readText(hh.hdir + '/' + rel, Math.min(ah.cfgNum('handovers.read_max_bytes'), ah.cfgNum('handovers.snapshot_head_bytes')));
  if (raw === null) return snap;
  var lines = raw.split(/\r?\n/);
  var st = hhRe('handovers.snapshot_stamp_re').exec(lines[0] || '');
  if (st) snap.at = st[1];
  var head = hhRe('handovers.snapshot_heading_re', 'i'), pathRe = hhRe('handovers.snapshot_handover_re');
  for (var i = 0; i < lines.length; i++) {
    var hm = hhRe('handovers.heading_re').exec(lines[i]);
    if (hm && head.test(hhClean(hm[2]))) {
      for (var j = i + 1; j < lines.length; j++) {
        if (!/\S/.test(lines[j])) continue;
        var pm = pathRe.exec(lines[j].trim());
        if (pm) snap.handover = hhNormRef(hh.root, hh.rel + '/' + date + '/' + sid, pm[1]);
        break;
      }
      break;
    }
  }
  return snap;
}

// {entries, loose, problems} of one day, read from its files.
function hhBuildDay(day) {
  var entries = [], loose = [], dprob = [];
  day.sessions.forEach(function (s) {
    var handovers = [], snaps = [], comps = [];
    s.files.forEach(function (f) {
      var cls = hhClassify(f.name, s.sid);
      if (cls.kind === 'handover' || cls.kind === 'named' || cls.kind === 'legacy') handovers.push(hhBuildEntry(day.date, s.sid, f, cls));
      else if (cls.kind === 'snapshot') snaps.push(hhSnapshot(day.date, s.sid, f, cls));
      else comps.push({ kind: cls.companion, file: f.name, path: day.date + '/' + s.sid + '/' + f.name });
    });
    if (handovers.length === 0) {
      if (snaps.length || comps.length) {
        loose.push({ session: s.sid, snapshots: snaps, companions: comps });
        dprob.push(hhProblem('no_handover', day.date + '/' + s.sid));
      }
      return;
    }
    handovers.sort(function (a, b) { return (a.seq === null ? 1e9 : a.seq) - (b.seq === null ? 1e9 : b.seq) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0); });
    // a snapshot belongs to the handover it names, else to the session's newest handover of that directory
    snaps.forEach(function (sn) {
      var target = null;
      if (sn.handover) handovers.forEach(function (h) { if (hh.rel + '/' + h.path === sn.handover) target = h; });
      if (!target) target = handovers[handovers.length - 1];
      sn.handover = target.path;
      target.snapshots.push({ file: sn.file, path: sn.path, n: sn.n, at: sn.at });
    });
    handovers.forEach(function (h) { h.companions = comps.slice(); entries.push(h); });
  });
  entries.sort(function (a, b) { return a.session < b.session ? -1 : a.session > b.session ? 1 : 0; }); // stable: keeps seq order inside a session
  return { entries: entries, loose: loose, problems: dprob };
}

// ---- links across days (always recomputed; nothing here is read from a cache) ------------------------------------------------

function hhLink2(days, checkRefs) {
  var byPath = {}, bySession = {};
  days.forEach(function (d) { d.entries.forEach(function (e) {
    byPath[hh.rel + '/' + e.path] = e;
    (bySession[e.session] = bySession[e.session] || []).push(e);
  }); });
  days.forEach(function (d) { d.entries.forEach(function (e) {
    e.problems = e.problems.filter(function (p) { return p.src !== 'link'; });
    e.session_prev = null; e.session_next = null;
    if (e.predecessor) {
      var t = byPath[e.predecessor.target];
      e.predecessor.id = t ? t.id : null;
      if (!t && checkRefs && ah.fs.kind(hh.root + '/' + e.predecessor.target) === null) e.problems.push(hhProblem('broken_ref', e.predecessor.target, 'link'));
    }
    e.refs.forEach(function (r) {
      if (byPath[r.target]) r.ok = true;
      else if (checkRefs) r.ok = ah.fs.kind(hh.root + '/' + r.target) !== null;
      if (r.ok === false && !(e.predecessor && e.predecessor.target === r.target)) e.problems.push(hhProblem('broken_ref', r.target, 'link'));
    });
  }); });
  Object.keys(bySession).forEach(function (sid) {
    var list = bySession[sid].slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.seq === null ? 1e9 : a.seq) - (b.seq === null ? 1e9 : b.seq) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    });
    for (var i = 0; i < list.length; i++) {
      if (i > 0) list[i].session_prev = list[i - 1].id;
      if (i + 1 < list.length) list[i].session_next = list[i + 1].id;
      if (i > 0 && list[i].date === list[i - 1].date && list[i].seq !== null && list[i].seq === list[i - 1].seq) list[i].problems.push(hhProblem('duplicate_seq', list[i].path + ' = ' + list[i - 1].file, 'link'));
    }
  });
  var cap = ah.cfgNum('handovers.problems_max');
  days.forEach(function (d) { d.entries.forEach(function (e) { if (e.problems.length > cap) e.problems = e.problems.slice(0, cap); }); });
}

// ---- rendering --------------------------------------------------------------------------------------------------------------

function hhMore(list, render) {
  var max = ah.cfgNum('handovers.list_show_max'), shown = list.slice(0, max).map(render);
  if (list.length > max) shown.push(hhTpl('handovers.msg_more_items', { n: list.length - max }));
  return shown.join(', ');
}
function hhBullets(list) {
  var max = ah.cfgNum('handovers.list_show_max'), out = list.slice(0, max).map(function (x) { return '  - ' + x.replace(/[\r\n]+/g, ' '); });
  if (list.length > max) out.push('  - ' + hhTpl('handovers.msg_more_items', { n: list.length - max }));
  return out;
}
function hhProbText(p) { return hhTpl('handovers.msg_problem_line', { severity: p.severity, code: p.code, where: '', detail: p.detail }).replace(/\s+/g, ' '); }

function hhRenderDay(d, idPath) {
  var L = ah.cfg('handovers.labels'), none = ah.cfg('handovers.none_text'), out = [];
  out.push('# ' + hhTpl('handovers.day_title', { date: d.date }));
  out.push('');
  out.push(hhTpl('handovers.generated_note', { sidecar: ah.cfg('handovers.day_sidecar') }));
  out.push('');
  out.push(hhLink(L.root, '../' + ah.cfg('handovers.root_brief')));
  out.push('');
  var sessions = hhUniq(d.entries.map(function (e) { return e.session; }));
  var pc = hhProblemCounts(d);
  out.push('**' + L.totals + ':** ' + d.entries.length + ' ' + L.handovers.toLowerCase() + ' · ' + sessions.length + ' ' + L.sessions.toLowerCase() + ' · ' + L.problem_count.toLowerCase() + ' ' + pc.error + '/' + pc.warn + '/' + pc.info);
  out.push('');
  out.push('## ' + L.sessions);
  out.push('');
  out.push('| ' + L.session + ' | ' + L.handovers + ' | ' + L.headline + ' |');
  out.push('|---|---|---|');
  sessions.forEach(function (sid) {
    var es = d.entries.filter(function (e) { return e.session === sid; });
    out.push('| `' + hhEsc(sid) + '` | ' + es.map(function (e) { return hhLink(e.file, e.session + '/' + e.file); }).join(', ') + ' | ' + hhEsc(hhCut(es[0].situation || es[0].title, ah.cfgNum('handovers.headline_chars'))) + ' |');
  });
  out.push('');
  out.push('## ' + L.handovers);
  d.entries.forEach(function (e, i) {
    out.push('');
    out.push('### ' + (i + 1) + '. `' + e.session + '`' + (e.seq !== null ? ' · ' + L.seq.toLowerCase() + ' ' + e.seq : (e.name ? ' · ' + e.name : '')) + ' - ' + hhEsc(e.title));
    out.push('');
    out.push('- ' + L.id + ': `' + e.id + '` · ' + L.file + ': ' + hhLink(e.file, e.session + '/' + e.file) + (e.kind !== 'handover' ? ' · ' + e.kind : ''));
    out.push('- ' + L.situation + ': ' + (e.situation || none));
    out.push('- ' + L.next_action + ': ' + (e.next_action || none));
    if (e.decisions.length) { out.push('- ' + L.decisions + ' (' + e.decisions.length + '):'); hhBullets(e.decisions).forEach(function (x) { out.push(x); }); }
    if (e.open_decisions.length) { out.push('- ' + L.open_decisions + ' (' + e.open_decisions.length + '):'); hhBullets(e.open_decisions).forEach(function (x) { out.push(x); }); }
    if (e.preferences.length) { out.push('- ' + L.preferences + ' (' + e.preferences.length + '):'); hhBullets(e.preferences).forEach(function (x) { out.push(x); }); }
    if (e.files.length) out.push('- ' + L.files + ': ' + hhMore(e.files, function (x) { return '`' + x + '`'; }));
    if (e.commits.length) out.push('- ' + L.commits + ': ' + hhMore(e.commits, function (x) { return '`' + x + '`'; }));
    var prev = e.session_prev && idPath[e.session_prev], next = e.session_next && idPath[e.session_next];
    if (e.predecessor && e.predecessor.id && idPath[e.predecessor.id]) out.push('- ' + L.predecessor + ': ' + hhLink(e.predecessor.id, '../' + idPath[e.predecessor.id]));
    else if (prev) out.push('- ' + L.predecessor + ': ' + hhLink(e.session_prev, '../' + prev));
    if (next) out.push('- ' + L.successor + ': ' + hhLink(e.session_next, '../' + next));
    if (e.snapshots.length) out.push('- ' + L.snapshots + ': ' + e.snapshots.map(function (s) { return hhLink(s.file, e.session + '/' + s.file); }).join(', '));
    if (e.companions.length) out.push('- ' + L.companions + ': ' + e.companions.map(function (c) { return hhLink(c.kind + ' (' + c.file + ')', e.session + '/' + c.file); }).join(', '));
    if (e.problems.length) out.push('- ' + L.problems + ': ' + e.problems.map(function (p) { return '`' + p.code + '`' + (p.detail ? ' ' + hhEsc(p.detail) : ''); }).join('; '));
  });
  if (d.loose.length) {
    out.push('');
    out.push('## ' + hhTpl('handovers.msg_loose_title', {}));
    d.loose.forEach(function (l) {
      out.push('- `' + l.session + '`: ' + l.snapshots.concat(l.companions).map(function (x) { return hhLink(x.file, l.session + '/' + x.file); }).join(', '));
    });
  }
  out.push('');
  return out.join('\n');
}

function hhProblemCounts(d) {
  var c = { error: 0, warn: 0, info: 0 };
  d.entries.forEach(function (e) { e.problems.forEach(function (p) { c[p.severity] = (c[p.severity] || 0) + 1; }); });
  d.problems.forEach(function (p) { c[p.severity] = (c[p.severity] || 0) + 1; });
  return c;
}

function hhDaySidecar(d, fp) {
  return JSON.stringify({ schema: ah.cfgNum('handovers.schema'), date: d.date, fp: fp, entries: d.entries, loose: d.loose, problems: d.problems }) + '\n';
}

function hhRootData(days, stray) {
  var sessions = {}, totals = { days: days.length, handovers: 0, sessions: 0, snapshots: 0, problems: { error: 0, warn: 0, info: 0 } };
  var rows = days.map(function (d) {
    var pc = hhProblemCounts(d), sids = hhUniq(d.entries.map(function (e) { return e.session; }));
    totals.handovers += d.entries.length;
    totals.problems.error += pc.error; totals.problems.warn += pc.warn; totals.problems.info += pc.info;
    d.entries.forEach(function (e) {
      totals.snapshots += e.snapshots.length;
      var s = sessions[e.session] = sessions[e.session] || { first: e.id, last: e.id, count: 0, days: [] };
      s.count++; s.last = e.id;
      if (s.days.indexOf(d.date) < 0) s.days.push(d.date);
    });
    var first = d.entries[0];
    return { date: d.date, brief: d.date + '/' + ah.cfg('handovers.day_brief'), sidecar: d.date + '/' + ah.cfg('handovers.day_sidecar'), fp: d.fp, handovers: d.entries.length, sessions: sids, headline: first ? hhCut(first.situation || first.title, ah.cfgNum('handovers.headline_chars')) : '', problems: pc };
  });
  totals.sessions = Object.keys(sessions).length;
  stray.forEach(function (n) { totals.problems.info++; });
  return { schema: ah.cfgNum('handovers.schema'), dir: hh.rel, legacy_index: ah.fs.isFile(hh.hdir + '/' + ah.cfg('handovers.legacy_index')), totals: totals, days: rows, sessions: sessions, stray: stray };
}

function hhRenderRoot(r) {
  var L = ah.cfg('handovers.labels'), out = [];
  out.push('# ' + ah.cfg('handovers.root_title'));
  out.push('');
  out.push(hhTpl('handovers.generated_note', { sidecar: ah.cfg('handovers.root_sidecar') }));
  out.push('');
  out.push('**' + L.totals + ':** ' + r.totals.handovers + ' ' + L.handovers.toLowerCase() + ' · ' + r.totals.days + ' ' + L.days.toLowerCase() + ' · ' + r.totals.sessions + ' ' + L.sessions.toLowerCase() + ' · ' + L.problem_count.toLowerCase() + ' ' + r.totals.problems.error + '/' + r.totals.problems.warn + '/' + r.totals.problems.info);
  out.push('');
  out.push('- ' + L.search_howto + ': ' + ah.cfg('handovers.msg_search_howto'));
  if (r.legacy_index) out.push('- ' + L.index_row_index + ': ' + hhLink(ah.cfg('handovers.legacy_index'), ah.cfg('handovers.legacy_index')));
  out.push('');
  out.push('## ' + L.days);
  out.push('');
  out.push('| ' + L.days + ' | ' + L.handovers + ' | ' + L.sessions + ' | ' + L.problem_count + ' | ' + L.headline + ' |');
  out.push('|---|---|---|---|---|');
  var max = ah.cfgNum('handovers.root_days_max');
  r.days.slice().reverse().slice(0, max).forEach(function (d) {
    out.push('| ' + hhLink(d.date, d.brief) + ' | ' + d.handovers + ' | ' + d.sessions.map(function (s) { return '`' + hhEsc(hhCut(s, 12)) + '`'; }).join(' ') + ' | ' + (d.problems.error + d.problems.warn + d.problems.info) + ' | ' + hhEsc(d.headline) + ' |');
  });
  if (r.days.length > max) out.push('| ' + hhTpl('handovers.msg_more_items', { n: r.days.length - max }) + ' | | | | |');
  out.push('');
  out.push('## ' + L.sessions);
  out.push('');
  out.push('| ' + L.session + ' | ' + L.handovers + ' | ' + L.first + ' | ' + L.last + ' |');
  out.push('|---|---|---|---|');
  Object.keys(r.sessions).sort().forEach(function (sid) {
    var s = r.sessions[sid];
    out.push('| `' + hhEsc(sid) + '` | ' + s.count + ' | ' + hhLink(s.days[0], s.days[0] + '/' + ah.cfg('handovers.day_brief')) + ' | ' + hhLink(s.days[s.days.length - 1], s.days[s.days.length - 1] + '/' + ah.cfg('handovers.day_brief')) + ' |');
  });
  out.push('');
  return out.join('\n');
}

// ---- the plan: what is on disk, what is indexed, what differs -------------------------------------------------------------

function hhReadJson(abs) {
  var raw = ah.fs.readText(abs);
  if (raw === null) return null;
  var v = hhParse(raw);
  return v && typeof v === 'object' && v.schema === ah.cfgNum('handovers.schema') ? v : null;
}

function hhPlan(fast, maxFiles) {
  var scan = hhScan(maxFiles);
  var root = hhReadJson(hh.hdir + '/' + ah.cfg('handovers.root_sidecar'));
  var rootFiles = ah.fs.isFile(hh.hdir + '/' + ah.cfg('handovers.root_brief'));
  var stored = {};
  if (root) root.days.forEach(function (d) { stored[d.date] = d; });
  var plan = { scan: scan, root: root, rootBrief: rootFiles, days: [], orphans: [], dirty: 0, reasons: [] };
  scan.days.forEach(function (day) {
    var fp = hhDayFp(day), st = stored[day.date];
    var briefOk = ah.fs.isFile(hh.hdir + '/' + day.date + '/' + ah.cfg('handovers.day_brief')) && ah.fs.isFile(hh.hdir + '/' + day.date + '/' + ah.cfg('handovers.day_sidecar'));
    var reason = null, sideOk = null;
    if (!st) reason = 'unindexed';
    else if (st.fp !== fp) reason = 'stale';
    else if (!briefOk) reason = 'missing_brief';
    else if (!fast) { // a sidecar that does not parse or belongs to other files is as good as stale
      var side = hhReadJson(hh.hdir + '/' + day.date + '/' + ah.cfg('handovers.day_sidecar'));
      if (!side || side.fp !== fp) reason = 'stale';
      else sideOk = side;
    }
    var p = { day: day, fp: fp, reason: reason, stored: st || null, side: sideOk };
    if (reason) plan.dirty++;
    plan.days.push(p);
  });
  var onDisk = {};
  scan.days.forEach(function (d) { onDisk[d.date] = 1; });
  if (root) root.days.forEach(function (d) { if (!onDisk[d.date]) plan.orphans.push(d.date); });
  if (!root || !rootFiles) { plan.reasons.push('missing_brief'); }
  return plan;
}

// ---- writing ------------------------------------------------------------------------------------------------------------------

function hhWrite(relFromRoot, abs, textOut, result) {
  var cur = ah.fs.readText(abs);
  if (cur === textOut) return;
  var ok = false;
  try { ok = ah.state.op(hh.root, 'write', relFromRoot, textOut); } catch (e) { result.problems.push(hhProblem('write_refused', relFromRoot + ': ' + String(e && e.message || e))); return; }
  if (!ok) { result.problems.push(hhProblem('write_refused', relFromRoot)); return; }
  result.written++;
}

// Build (or reuse) every day, link, render, write what differs. `opts.force` rebuilds every day.
function hhIndex(opts) {
  var started = hhNow(), budget = ah.cfgNum('handovers.run_budget_ms');
  var plan = hhPlan(false, 0);
  var result = { written: 0, rebuilt: 0, partial: false, problems: [] };
  var days = [];
  plan.days.forEach(function (p) {
    var d = null;
    var needs = opts.force || p.reason !== null || !p.stored;
    var sidePath = hh.hdir + '/' + p.day.date + '/' + ah.cfg('handovers.day_sidecar');
    if (!needs) {
      var side = p.side || hhReadJson(sidePath);
      if (side && side.fp === p.fp) d = { date: p.day.date, entries: side.entries, loose: side.loose || [], problems: side.problems || [], fp: p.fp };
      else needs = true;
    }
    if (needs) {
      if (hhNow() - started > budget) { result.partial = true; return; }
      var b = hhBuildDay(p.day);
      d = { date: p.day.date, entries: b.entries, loose: b.loose, problems: b.problems, fp: p.fp };
      result.rebuilt++;
    }
    days.push(d);
  });
  hhLink2(days, true);
  var idPath = {};
  days.forEach(function (d) { d.entries.forEach(function (e) { idPath[e.id] = e.path; }); });
  days.forEach(function (d) {
    var rel = hh.rel + '/' + d.date + '/';
    hhWrite(rel + ah.cfg('handovers.day_sidecar'), hh.hdir + '/' + d.date + '/' + ah.cfg('handovers.day_sidecar'), hhDaySidecar(d, d.fp), result);
    hhWrite(rel + ah.cfg('handovers.day_brief'), hh.hdir + '/' + d.date + '/' + ah.cfg('handovers.day_brief'), hhRenderDay(d, idPath), result);
  });
  var rootData = hhRootData(days, plan.scan.stray);
  hhWrite(hh.rel + '/' + ah.cfg('handovers.root_sidecar'), hh.hdir + '/' + ah.cfg('handovers.root_sidecar'), JSON.stringify(rootData) + '\n', result);
  hhWrite(hh.rel + '/' + ah.cfg('handovers.root_brief'), hh.hdir + '/' + ah.cfg('handovers.root_brief'), hhRenderRoot(rootData), result);
  result.handovers = rootData.totals.handovers;
  result.days = rootData.totals.days;
  result.problemCount = rootData.totals.problems.error + rootData.totals.problems.warn;
  result.totals = rootData.totals;
  result.days_list = days;
  return result;
}

// ---- check: what is wrong, from a fresh read of everything the index would read, without writing -------------------------

function hhCheck(fast) {
  var plan = hhPlan(fast, fast ? ah.cfgNum('handovers.advisory_max_files') : 0);
  var problems = [], staleDays = 0;
  if (!plan.root || !plan.rootBrief) problems.push(Object.assign(hhProblem('missing_brief', hh.rel + '/' + ah.cfg('handovers.root_brief')), { where: hh.rel }));
  plan.days.forEach(function (p) {
    if (p.reason) {
      staleDays++;
      var code = p.reason === 'missing_brief' ? 'missing_brief' : p.reason;
      if (!fast && p.stored === null) {
        // list each unindexed handover by name (nothing of this day is indexed)
        p.day.sessions.forEach(function (s) { s.files.forEach(function (f) { var c = hhClassify(f.name, s.sid); if (c.kind === 'handover' || c.kind === 'named' || c.kind === 'legacy') problems.push(Object.assign(hhProblem('unindexed', p.day.date + '/' + s.sid + '/' + f.name), { where: p.day.date })); }); });
      } else if (!fast && p.reason === 'stale') {
        var side = hhReadJson(hh.hdir + '/' + p.day.date + '/' + ah.cfg('handovers.day_sidecar'));
        var known = {};
        if (side) side.entries.forEach(function (e) { known[e.path] = e; });
        p.day.sessions.forEach(function (s) { s.files.forEach(function (f) {
          var c = hhClassify(f.name, s.sid), rel = p.day.date + '/' + s.sid + '/' + f.name;
          if (c.kind !== 'handover' && c.kind !== 'named' && c.kind !== 'legacy') return;
          if (!known[rel]) problems.push(Object.assign(hhProblem('unindexed', rel), { where: p.day.date }));
          else if (known[rel].size !== f.size || known[rel].mtimeMs !== f.mtimeMs) problems.push(Object.assign(hhProblem('stale', rel), { where: p.day.date }));
        }); });
        if (side) Object.keys(known).forEach(function (rel) {
          var found = false;
          p.day.sessions.forEach(function (s) { s.files.forEach(function (f) { if (p.day.date + '/' + s.sid + '/' + f.name === rel) found = true; }); });
          if (!found) problems.push(Object.assign(hhProblem('orphan', rel), { where: p.day.date }));
        });
      } else {
        problems.push(Object.assign(hhProblem(code, p.day.date), { where: p.day.date }));
      }
    }
  });
  plan.orphans.forEach(function (d) { staleDays++; problems.push(Object.assign(hhProblem('orphan', d), { where: d })); });
  // content problems: recomputed from the files in the full check, taken from the index in the fast one
  if (!fast) {
    var days = [];
    plan.days.forEach(function (p) {
      var b = hhBuildDay(p.day);
      days.push({ date: p.day.date, entries: b.entries, loose: b.loose, problems: b.problems });
    });
    hhLink2(days, true);
    days.forEach(function (d) {
      d.entries.forEach(function (e) { e.problems.forEach(function (pr) { problems.push(Object.assign({}, pr, { where: e.path })); }); });
      d.problems.forEach(function (pr) { problems.push(Object.assign({}, pr, { where: d.date })); });
    });
    plan.scan.stray.forEach(function (n) { problems.push(Object.assign(hhProblem('unrecognized_dir', n), { where: n })); });
  } else if (plan.root) {
    var t = plan.root.totals.problems;
    var n = (t.error || 0) + (t.warn || 0);
    if (n > 0) problems.push(Object.assign(hhProblem('recorded', hhTpl('handovers.msg_recorded', { n: n })), { where: hh.rel, count: n }));
  }
  return { problems: problems, staleDays: staleDays, plan: plan };
}

function hhCountable(problems) {
  var n = 0;
  problems.forEach(function (p) { if (p.severity === 'error' || p.severity === 'warn') n += p.count || 1; });
  return n;
}

function hhProblemLine(p) {
  return hhTpl('handovers.msg_problem_line', { severity: p.severity, code: p.code, where: p.where || '', detail: p.detail || '' }).replace(/\s+/g, ' ').trim();
}

// ---- project registry (the scheduled job's list) -------------------------------------------------------------------------------

function hhRegistry() {
  var raw = ah.fs.readText(ah.home() + '/' + ah.cfg('handovers.registry_file'));
  var v = raw === null ? null : hhParse(raw);
  return v && typeof v === 'object' && v.projects && typeof v.projects === 'object' ? v : { projects: {} };
}
function hhSaveRegistry(reg) {
  var keys = Object.keys(reg.projects), max = ah.cfgNum('handovers.registry_max');
  if (keys.length > max) {
    keys.sort(function (a, b) { return reg.projects[a].seen - reg.projects[b].seen; });
    keys.slice(0, keys.length - max).forEach(function (k) { delete reg.projects[k]; });
  }
  try { ah.state.writeAtomic(ah.cfg('handovers.registry_file'), JSON.stringify(reg) + '\n'); } catch (e) { ah.log('handover-hygiene', 'registry write refused: ' + String(e && e.message || e)); }
}

// Record this project for the scheduled job (a CLI run registers it too).
function hhRemember() {
  var reg = hhRegistry(), ent = reg.projects[hh.root], now = hhNow();
  if (ent && now - ent.seen < ah.cfgNum('handovers.registry_refresh_ms')) return;
  reg.projects[hh.root] = { seen: now, advised: ent ? ent.advised : '' };
  hhSaveRegistry(reg);
}

// The lock timings are the defaults group `handovers` (read by the host through ahHost.lockAcquire): 'handovers.lock_stale_ms',
// 'handovers.lock_wait_ms', 'handovers.lock_step_ms', 'handovers.lock_reclaim_stale_ms', 'handovers.lock_release_tries',
// 'handovers.lock_release_step_ms', 'handovers.lock_boot_slop_s'.
function hhLockName(root) { return ah.cfg('handovers.lock_file_prefix') + ah.fnv(root) + ah.cfg('handovers.lock_file_suffix'); }

// ---- the operations ------------------------------------------------------------------------------------------------------------

function hhOpen(startDir) {
  var root = hhFindRoot(startDir);
  if (!root) return null;
  hh.root = root; hh.rel = ah.cfg('handovers.dir'); hh.hdir = root + '/' + hh.rel;
  return root;
}

function hhFlag(args, name) {
  var i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] === undefined ? '' : args[i + 1]) : null;
}
function hhHas(args, name) { return args.indexOf(name) >= 0; }

function hhIndexOne(startDir, opts) {
  if (!hhOpen(startDir)) return { error: ah.cfg('handovers.msg_no_project') };
  var lock = ah.state.lock(hhLockName(hh.root), 'handovers');
  if (lock === null) return { error: ah.cfg('handovers.msg_busy'), busy: true };
  try {
    var r = hhIndex(opts);
    r.project = hh.root;
    hhRemember();
    return r;
  } finally { ah.state.unlock(lock); }
}

function hhIndexResult(r, json) {
  var summary = hhTpl('handovers.msg_index_done', { project: r.project, handovers: r.handovers, days: r.days, rebuilt: r.rebuilt, written: r.written, problems: r.problemCount });
  if (json) return JSON.stringify({ project: r.project, handovers: r.handovers, days: r.days, rebuilt: r.rebuilt, written: r.written, problems: r.problemCount, partial: r.partial, write_problems: r.problems }) + '\n';
  return summary + '\n';
}

function opIndex(payload) {
  var args = payload.args || [], json = payload.json === true, force = hhHas(args, ah.cfg('handovers.force_flag'));
  if (hhHas(args, ah.cfg('handovers.registered_flag'))) {
    var reg = hhRegistry(), keys = Object.keys(reg.projects).sort(function (a, b) { return reg.projects[b].seen - reg.projects[a].seen; }).slice(0, ah.cfgNum('handovers.job_max_projects'));
    var results = [], failed = 0;
    keys.forEach(function (root) {
      hh = { res: hh.res };
      var r = hhIndexOne(root, { force: force });
      if (r.error) { failed++; results.push({ project: root, error: r.error }); return; }
      results.push({ project: root, handovers: r.handovers, days: r.days, rebuilt: r.rebuilt, written: r.written, problems: r.problemCount, partial: r.partial });
    });
    if (json) return hhOut(0, JSON.stringify({ projects: results }) + '\n');
    return hhOut(0, results.map(function (x) { return x.error ? x.project + ': ' + x.error : hhTpl('handovers.msg_index_done', { project: x.project, handovers: x.handovers, days: x.days, rebuilt: x.rebuilt, written: x.written, problems: x.problems }); }).join('\n') + '\n');
  }
  var start = hhFlag(args, ah.cfg('handovers.project_flag')) || payload.cwd;
  var r1 = hhIndexOne(start, { force: force });
  if (r1.error) return hhOut(r1.busy ? 75 : 1, json ? JSON.stringify({ error: r1.error }) + '\n' : '', json ? '' : r1.error + '\n');
  return hhOut(0, hhIndexResult(r1, json));
}

function opCheck(payload) {
  var args = payload.args || [], json = payload.json === true;
  var start = hhFlag(args, ah.cfg('handovers.project_flag')) || payload.cwd;
  if (!hhOpen(start)) return hhOut(1, json ? JSON.stringify({ error: ah.cfg('handovers.msg_no_project') }) + '\n' : '', json ? '' : ah.cfg('handovers.msg_no_project') + '\n');
  var c = hhCheck(false), n = hhCountable(c.problems);
  var totals = { handovers: 0, days: c.plan.days.length };
  c.plan.days.forEach(function (p) { p.day.sessions.forEach(function (s) { s.files.forEach(function (f) { var k = hhClassify(f.name, s.sid).kind; if (k === 'handover' || k === 'named' || k === 'legacy') totals.handovers++; }); }); });
  if (json) return hhOut(n > 0 || c.staleDays > 0 ? 3 : 0, JSON.stringify({ project: hh.root, handovers: totals.handovers, days: totals.days, stale_days: c.staleDays, problems: c.problems }) + '\n');
  var lines = [];
  if (n === 0 && c.staleDays === 0) lines.push(hhTpl('handovers.msg_check_clean', { project: hh.root, handovers: totals.handovers, days: totals.days }));
  else lines.push(hhTpl('handovers.msg_check_summary', { project: hh.root, problems: n, stale: c.staleDays }));
  c.problems.forEach(function (p) { lines.push(hhProblemLine(p)); });
  return hhOut(n > 0 || c.staleDays > 0 ? 3 : 0, lines.join('\n') + '\n');
}

// ---- search --------------------------------------------------------------------------------------------------------------------

function hhTokens(q) {
  var out = [], re = /"([^"]*)"|(\S+)/g, m;
  while ((m = re.exec(q)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out.filter(function (t) { return t !== ''; });
}
function hhFieldText(e, f) {
  var v = e[f];
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join('\n');
  return String(v);
}
function hhSnippet(e, word) {
  var fields = ['situation', 'next_action', 'decisions', 'preferences', 'open_decisions', 'title'], cap = ah.cfgNum('handovers.search_snippet_chars');
  for (var i = 0; i < fields.length; i++) {
    var t = hhClean(hhFieldText(e, fields[i])), at = word ? t.toLowerCase().indexOf(word) : 0;
    if (at >= 0 && t) { var from = Math.max(0, at - Math.floor(cap / 4)); return hhCut(t.slice(from), cap); }
  }
  return hhCut(hhClean(e.situation || e.title), cap);
}

function opSearch(payload) {
  var args = payload.args || [], json = payload.json === true;
  var start = hhFlag(args, ah.cfg('handovers.project_flag')) || payload.cwd;
  var limitFlag = ah.cfg('handovers.limit_flag'), limitRaw = hhFlag(args, limitFlag);
  var limit = Math.min(ah.cfgNum('handovers.search_limit_max'), limitRaw !== null && /^\d+$/.test(limitRaw) && parseInt(limitRaw, 10) > 0 ? parseInt(limitRaw, 10) : ah.cfgNum('handovers.search_limit'));
  var words = [];
  for (var i = 1; i < args.length; i++) {
    if (args[i] === limitFlag || args[i] === ah.cfg('handovers.project_flag')) { i++; continue; }
    words.push(args[i]);
  }
  var toks = hhTokens(words.join(' ')), terms = [], filters = [], filterMap = ah.cfg('handovers.search_filters');
  toks.forEach(function (t) {
    var m = /^([a-z]+):(.+)$/.exec(t);
    if (m && Object.prototype.hasOwnProperty.call(filterMap, m[1])) filters.push({ op: m[1], field: filterMap[m[1]], value: m[2].toLowerCase() });
    else terms.push(t.toLowerCase());
  });
  var queryText = toks.join(' ');
  if (!hhOpen(start)) return hhOut(1, '', ah.cfg('handovers.msg_no_project') + '\n');
  var root = hhReadJson(hh.hdir + '/' + ah.cfg('handovers.root_sidecar'));
  if (!root) return hhOut(1, '', hhTpl('handovers.msg_not_indexed', { cmd: ah.cfg('handovers.cmd_index') }) + '\n');
  var weights = ah.cfg('handovers.search_weights'), hits = [];
  root.days.forEach(function (rd) {
    var skip = false;
    filters.forEach(function (f) {
      if (f.op === 'date' && rd.date.indexOf(f.value) !== 0) skip = true;
      if (f.op === 'from' && rd.date < f.value) skip = true;
      if (f.op === 'to' && rd.date.slice(0, f.value.length) > f.value) skip = true;
    });
    if (skip) return;
    var side = hhReadJson(hh.hdir + '/' + rd.sidecar);
    if (!side) return;
    side.entries.forEach(function (e) {
      for (var fi = 0; fi < filters.length; fi++) {
        var f = filters[fi];
        if (f.op === 'from' || f.op === 'to' || f.op === 'date') continue;
        var hay = hhFieldText(e, f.field).toLowerCase();
        if (f.field === 'session' || f.field === 'kind') { if (hay.indexOf(f.value) !== 0 && hay !== f.value) return; }
        else if (hay.indexOf(f.value) < 0) return;
      }
      var score = 0, matched = {};
      for (var ti = 0; ti < terms.length; ti++) {
        var t = terms[ti], any = false;
        Object.keys(weights).forEach(function (field) {
          var key = field === 'session' ? 'session' : field;
          if (hhFieldText(e, key).toLowerCase().indexOf(t) >= 0) { score += weights[field]; matched[field] = 1; any = true; }
        });
        if (!any) return;
      }
      if (terms.length === 0 && filters.length === 0) return;
      hits.push({ score: score + filters.length, e: e, matched: Object.keys(matched), first: terms[0] || '' });
    });
  });
  hits.sort(function (a, b) { return b.score - a.score || (a.e.id < b.e.id ? 1 : a.e.id > b.e.id ? -1 : 0); });
  var shown = hits.slice(0, limit);
  if (json) return hhOut(0, JSON.stringify({ query: queryText, total: hits.length, hits: shown.map(function (h) { return { score: h.score, id: h.e.id, uid: h.e.uid, date: h.e.date, session: h.e.session, seq: h.e.seq, title: h.e.title, path: hh.rel + '/' + h.e.path, matched: h.matched, snippet: hhSnippet(h.e, h.first) }; }) }) + '\n');
  if (hits.length === 0) return hhOut(0, hhTpl('handovers.msg_search_none', { query: queryText }) + '\n');
  var lines = [hhTpl('handovers.msg_search_total', { shown: shown.length, total: hits.length })];
  shown.forEach(function (h) { lines.push(hhTpl('handovers.msg_search_hit', { score: h.score, id: h.e.id, title: h.e.title, path: hh.rel + '/' + h.e.path, snippet: hhSnippet(h.e, h.first) })); });
  return hhOut(0, lines.join('\n') + '\n');
}

// ---- the SessionStart advisory ----------------------------------------------------------------------------------------------

function opAdvisory(payload) {
  if (ah.settings.skipped(ah.cfg('handovers.guard_name'))) return 'allow';
  var child = ah.cfg('handovers.child_env');
  if (ah.env.get(child) === ah.cfg('handovers.child_value')) return 'allow';
  if (!ah.settings.bool('handovers.setting')) return 'allow';
  if (!hhOpen(payload.cwd)) return 'allow';
  var now = hhNow(), reg = hhRegistry(), ent = reg.projects[hh.root], dirty = false;
  if (!ent || now - ent.seen >= ah.cfgNum('handovers.registry_refresh_ms')) { ent = reg.projects[hh.root] = { seen: now, advised: ent ? ent.advised : '' }; dirty = true; }
  var c = hhCheck(true), n = hhCountable(c.problems);
  var sig = n === 0 && c.staleDays === 0 ? '' : ah.fnv(c.problems.map(function (p) { return p.code + ':' + (p.where || '') + ':' + (p.count || 1); }).sort().join('|') + '#' + c.staleDays);
  var same = (ent.advised || '') === sig;
  if (!same) { ent.advised = sig; dirty = true; }
  if (dirty) hhSaveRegistry(reg);
  if (sig === '' || same) return 'allow';
  var lines = c.problems.filter(function (p) { return p.severity === 'error' || p.severity === 'warn'; }), max = ah.cfgNum('handovers.advisory_max_lines');
  var extra = lines.slice(0, max).map(hhProblemLine);
  if (lines.length > max) extra.push(hhTpl('handovers.msg_more', { n: lines.length - max }));
  var t = text.message('tip', ah.cfg('handovers.guard_name'), {
    what: hhTpl('handovers.msg_advisory_what', { count: n, days: c.staleDays, project: hh.root }),
    why: ah.cfg('handovers.msg_advisory_why'),
    instead: hhTpl('handovers.msg_advisory_instead', { cmd: ah.cfg('handovers.cmd_index') }),
    extra: extra,
  });
  return { advisory: text.advisoryJson('SessionStart', t) };
}

// ---- entry ------------------------------------------------------------------------------------------------------------------------

function decide(payload, opts, event) {
  hh = { res: {} };
  payload = payload || {};
  if (event === ah.cfg('handovers.cli_event')) {
    var verbs = ah.cfg('handovers.verbs'), args = payload.args || [];
    var verb = args[0];
    if (verbs.indexOf(verb) < 0) return hhOut(64, '', ah.cfg('handovers.msg_usage') + '\n');
    if (verb === 'index') return opIndex(payload);
    if (verb === 'check') return opCheck(payload);
    return opSearch(payload);
  }
  if (ah.cfg('handovers.events').indexOf(event) < 0) return 'allow';
  return opAdvisory(payload);
}
