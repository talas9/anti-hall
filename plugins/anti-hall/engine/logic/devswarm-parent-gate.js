// check = "devswarm-parent-gate" (Stop): the Primary's Stop gate. A Stop guard is never weaker than Node (D74). The silent exits of the Node
// hook (the judge-child exit, the `devswarm.parentGate` switch, the user skip, a supervisor that is not active, a child workspace, a hook that
// stops again after its own block) are answered first, in Node's order. Past them the gate reads the Primary's own summary, the workspace
// descriptors, the durable inboxes and the mesh store (ah.mesh), classifies the live children (busy, waiting on a human, fresh mail), and
// answers what Node answers: the inert and clean passes (the loop state removed), the busy and grace advisories, and the neglect block with
// its loop state, forced-acknowledgement counter, the one escalation and the quiet tail after it, the stated intent's larger budget, the
// waiting-on-human lines, the mailbox-wake line and the stale-build downgrade. Whatever it cannot settle exactly defers to the Node gate
// before anything is written: own unread in the summary, any pending question, a truncated question list, a parked escalation, a stale or
// escalated verdict, a workspace the app database has no opinion on under the DevSwarm repos root, a straying-plan advisory, a live child
// on the clean pass (the wake-coverage line), an in-flight drain marker, the conservation hold, a non-sqlite store, and any setting of the
// gate that is set anywhere. Mirrors hooks/devswarm-parent-gate.js (`main`, `readOwnUnread`, `buildReason` and helpers), the companion's
// inbox cursor, reader cursors, identity family, row eligibility, archived and live-children readers, hooks/lib/devswarm-wake.js
// `wakeReassert`, hooks/lib/block-message.js `frame`, hooks/lib/skip-cmd.js and hooks/lib/stop-version-gate.js. Builds on
// devswarm-child-role.js (script.includes). Keys and texts: devswarm_role.toml (devswarm_role.pg_*, sw_*), devswarm_cli.toml (rr_tr_*).
'use strict';

function pgDir(home) { return home + '/' + ah.cfg('devswarm_role.pg_devswarm_dir'); }
function pgMin() { return ah.cfgNum('devswarm_role.pg_ms_per_min'); }
function pgExists(p) { return ah.fs.realpath(p) !== null; }

function pgSafeId(id) {
  var extra = ah.cfg('devswarm_role.id_extra_chars');
  return id !== '' && id !== '.' && id.indexOf('..') < 0 && id.split('').every(function (c) { return /[A-Za-z0-9]/.test(c) || extra.indexOf(c) >= 0; });
}

// JSON.parse(readFileSync(p)) inside Node's try/catch: null when the file cannot be read or does not parse; a file over the read cap or a
// parse the interpreter cannot finish defers.
function pgJson(p) {
  var r = jx.read(p);
  if (r.big) throw meshDefer;
  if (r.text === undefined) return null;
  var j = jx.parse(r.text);
  if (j.unsure) throw meshDefer;
  return j.invalid ? null : j.v;
}

// The sorted names in a directory; null when it is not one. A directory too big to list defers.
function pgNames(dir) {
  var n = ah.fs.readdir(dir);
  if (n === null && ah.fs.isDir(dir)) throw meshDefer;
  return n;
}

function pgHasJson(dir) { var n = pgNames(dir); return n !== null && n.some(function (x) { return /\.json$/.test(x); }); }

// A descriptor path field read with JavaScript truthiness: a non-empty string, else null.
function pgPathField(o, k) {
  var v = o[k];
  if (v === undefined || v === null || v === false || v === '' || v === 0 || (typeof v === 'number' && isNaN(v))) return null;
  if (typeof v === 'string') return v;
  throw meshDefer;
}

// A numeric setting of the gate at its shipped default; defers when it is set anywhere.
function pgSetNum(key) {
  if (ah.settings.touched(key)) throw meshDefer;
  return ah.cfg(key).default;
}

function pgShQuote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function pgDq(s) { return '"' + s.replace(/["\\$`]/g, function (c) { return '\\' + c; }) + '"'; }

// ---- the Primary's own unread (readOwnUnread) ------------------------------------------------------------------------

function pgReadOwn(home, idn, selfKey) {
  var own = { id: null, unknown: false, parsed: false, registryIds: [] };
  if (idn.top === null) return own;
  var id = idn.own, prefix = ah.cfg('mesh_write.primary_prefix');
  var hash;
  if (selfKey !== null) hash = selfKey;
  else if (id.indexOf(prefix) === 0) hash = id.slice(prefix.length);
  else throw meshDefer;
  own.id = id;
  var p = pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_summaries') + '/' + hash + '.json';
  var st = ah.fs.lstat(p);
  if (st === null || (st.kind === 'link' && ah.fs.realpath(p) === null)) return own; // absent: not unknown
  var r = jx.read(p);
  if (r.big) throw meshDefer;
  if (r.text === undefined) { own.unknown = true; return own; }
  var trimmed = r.text.trim();
  if (trimmed === '') { own.unknown = true; return own; }
  var j = jx.parse(trimmed);
  if (j.unsure) throw meshDefer;
  var summary = j.v;
  if (j.invalid || !jx.isObj(summary)) { own.unknown = true; return own; }
  var ws = summary.workspaces;
  if (Array.isArray(ws)) throw meshDefer;
  if (!jx.isObj(ws)) { own.unknown = true; return own; }
  var e = ws[id];
  if (jx.isObj(e)) {
    if (typeof e.unread === 'number' && isFinite(e.unread) && e.unread > 0) throw meshDefer; // the live own-reader recheck
    if (Array.isArray(e.pendingQuestions) && e.pendingQuestions.length > 0) throw meshDefer;
    if (e.pendingQuestionsTruncated) throw meshDefer;
    if (Array.isArray(e.jevQuestionCandidates) && e.jevQuestionCandidates.length > 0) throw meshDefer;
  }
  own.registryIds = Object.keys(ws);
  if (Array.isArray(summary.archivedRegistryRows)) {
    summary.archivedRegistryRows.forEach(function (row) { if (jx.isObj(row) && typeof row.id === 'string') own.registryIds.push(row.id); });
  }
  own.parsed = true;
  return own;
}

// ---- descriptors -------------------------------------------------------------------------------------------------------

function pgDescriptors(home) {
  var dir = pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_workspaces'), out = [];
  (pgNames(dir) || []).forEach(function (n) {
    if (!/\.json$/.test(n)) return;
    var d = pgJson(dir + '/' + n);
    if (!d || !d.worktreePath || !d.sessionId || typeof d.id !== 'string' || !pgSafeId(d.id)) return;
    if (typeof d.worktreePath !== 'string' || typeof d.sessionId !== 'string') throw meshDefer;
    out.push({ id: d.id, worktree: d.worktreePath, session: d.sessionId, inbox: pgPathField(d, 'inboxPath'), cursor: pgPathField(d, 'cursorPath'), raw: d });
  });
  return out;
}

// `readUnreadMessages(inboxPath, cursorPath)`: {rows} (the unread inbox lines parsed; null for a line that is not an object or an array) or
// {unknown: reason, path, errno}.
function pgReadFile(p, missing, unreadable) {
  var st = ah.fs.lstat(p);
  if (st === null || (st.kind === 'link' && ah.fs.realpath(p) === null)) return { bad: { unknown: missing, path: p, errno: 'ENOENT' } };
  if (st.kind === 'dir') return { bad: { unknown: unreadable, path: p, errno: 'EISDIR' } };
  var r = jx.read(p);
  if (r.big) throw meshDefer;
  if (r.text === undefined) throw meshDefer; // an error code this script cannot name exactly
  return { text: r.text };
}

function pgBacklog(inbox, cursor) {
  if (inbox === null) return { unknown: 'no-inbox-path', path: null, errno: null };
  var a = pgReadFile(inbox, 'inbox-missing', 'inbox-unreadable');
  if (a.bad) return a.bad;
  var lines = a.text.split('\n').filter(function (l) { return l.trim() !== ''; });
  if (cursor === null) return { unknown: 'no-cursor-path', path: null, errno: null };
  var b = pgReadFile(cursor, 'cursor-missing', 'cursor-unreadable');
  if (b.bad) return b.bad;
  var raw = b.text.trim(), c;
  if (raw !== '' && /^[0-9]+$/.test(raw)) c = Number(raw);
  else {
    var j = jx.parse(raw);
    if (j.unsure) throw meshDefer;
    if (j.invalid || j.v === null) return { unknown: 'cursor-unreadable', path: cursor, errno: null };
    var line = jx.isObj(j.v) ? j.v.line : undefined;
    if (line === undefined) c = NaN;
    else if (line === null) c = 0;
    else if (typeof line === 'number') c = line;
    else throw meshDefer; // Number() of a string, boolean or object: JavaScript's coercions
  }
  if (!isFinite(c) || c < 0) return { unknown: 'cursor-invalid', path: cursor, errno: null };
  if (c !== Math.floor(c)) throw meshDefer;
  var rows = lines.slice(c).map(function (l) {
    var q = jx.parse(l);
    if (q.unsure) throw meshDefer;
    return !q.invalid && q.v !== null && typeof q.v === 'object' ? q.v : null;
  });
  return { rows: rows };
}

function pgNoise(v) { return typeof v === 'string' && v.replace(/^\s+/, '').indexOf(ah.cfg('devswarm_role.pg_poke_prefix')) === 0; }
function pgBroadcast(row) { return ah.cfg('devswarm_role.pg_broadcast_fields').some(function (k) { return row[k] === ah.cfg('devswarm_role.pg_broadcast'); }); }

// `unreadRowTs(row)`: {at} | {none} | {odd} (a string time only V8 could read).
function pgRowTs(row) {
  var keys = [ah.cfg('mesh_write.ndjson_ts_field'), ah.cfg('mesh_write.ndjson_created_field')];
  for (var i = 0; i < keys.length; i++) {
    var v = row[keys[i]];
    if (typeof v === 'number' && isFinite(v)) return { at: v };
    if (typeof v === 'string' && v !== '') {
      var dp = ah.date.parse(v);
      if (dp.unsure) return { odd: true };
      if (dp.ms !== undefined && isFinite(dp.ms)) return { at: dp.ms };
    }
  }
  return { none: true };
}

// The summary projection's `archive_ready` flag for `id` under `repoKey`.
function pgArchiveReady(home, id, repoKey, memo) {
  if (repoKey === null) return false;
  if (!Object.prototype.hasOwnProperty.call(memo, repoKey)) {
    var ws = null, r = jx.read(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_summaries') + '/' + repoKey + '.json');
    if (r.big) throw meshDefer;
    if (r.text !== undefined) {
      var t = r.text.trim();
      if (t !== '') {
        var j = jx.parse(t);
        if (j.unsure) throw meshDefer;
        if (!j.invalid && jx.isObj(j.v) && j.v.workspaces !== null && typeof j.v.workspaces === 'object') ws = j.v.workspaces;
      }
    }
    if (Array.isArray(ws)) throw meshDefer;
    memo[repoKey] = ws;
  }
  var w = memo[repoKey];
  return w !== null && jx.isObj(w[id]) && w[id].archive_ready === true;
}

function pgIgnoreIds(home) {
  var v = pgJson(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_ignore_file'));
  var out = {};
  if (jx.isObj(v) && Array.isArray(v.ids)) v.ids.forEach(function (x) { if (typeof x === 'string' && x !== '') out[x] = true; });
  return out;
}

// `isArchivedWorkspace(home, id, worktreePath, { sessionId })`: the anti-hall archived marker.
function pgMarkerArchived(home, d) {
  var v = pgJson(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_archived') + '/' + d.id + '.json');
  if (v === null || typeof v !== 'object') return false;
  if (typeof v.worktreePath === 'string' && v.worktreePath !== '') {
    var x = ah.fs.realpath(v.worktreePath), y = ah.fs.realpath(d.worktree);
    if ((x === null ? v.worktreePath : x) !== (y === null ? d.worktree : y)) return false;
  }
  var m = v.sessionId;
  if (m !== undefined && m !== null && typeof m !== 'string') throw meshDefer;
  return !(typeof m === 'string' && m !== '' && d.session !== m);
}

function pgTitle(home, id) {
  if (pgSafeId(id)) {
    var v = pgJson(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_names') + '/' + id + '.json');
    if (v !== null && typeof v === 'object' && typeof v.name === 'string' && v.name !== '') {
      var n = ah.cfgNum('devswarm_role.pg_short_id_len');
      return text.render(ah.cfg('devswarm_role.pg_title_fmt'), { name: v.name, short: id.length > n ? id.slice(0, n) : id });
    }
  }
  return id;
}

function pgWorktreeGone(p, memo) {
  if (!Object.prototype.hasOwnProperty.call(memo, p)) memo[p] = p.charAt(0) === '/' && ah.fs.lstat(p) === null;
  return memo[p];
}

// ---- families ----------------------------------------------------------------------------------------------------------

function pgCrossLinked(a, b) {
  if (a.id === '' || b.id === '' || a.id === b.id) return false;
  return (a.session !== null && a.session !== '' && a.session === b.id) || (b.session !== null && b.session !== '' && b.session === a.id);
}

function pgCollapse(entries) {
  var cache = {}, order = [], groups = {};
  entries.forEach(function (e, i) {
    var key = null;
    if (e.worktree !== '') {
      if (!Object.prototype.hasOwnProperty.call(cache, e.worktree)) cache[e.worktree] = ah.mesh.canonicalId(e.worktree);
      key = cache[e.worktree];
    }
    if (key === null) key = ah.cfg('devswarm_role.pg_id_key_prefix') + e.id;
    if (!Object.prototype.hasOwnProperty.call(groups, key)) { order.push(key); groups[key] = []; }
    groups[key].push(i);
  });
  return order.map(function (key) {
    var members = groups[key], survivor = null;
    for (var i = 0; i < members.length; i++) if (entries[members[i]].id === key) { survivor = members[i]; break; }
    if (survivor === null) survivor = members.slice().sort(function (a, b) { var x = entries[a].id, y = entries[b].id; return x < y ? -1 : x > y ? 1 : 0; })[0];
    return { members: members, survivor: survivor, mergedTwins: [] };
  });
}

// ---- the decision ------------------------------------------------------------------------------------------------------

function pgNewEntry(id, wt, session) {
  return { id: id, worktree: wt, session: session, realUnread: 0, unknown: false, reason: null, reasonPath: null, reasonErrno: null, done: false, archived: false,
    appArchived: false, ignored: false, held: false, live: false, busy: false, waiting: false, waitingQ: null, oldestAge: null, ageUnknown: false, ageOdd: false,
    stateSkipped: false, foreign: false, hadStoreOnly: false };
}

function pgGate(p, root, l) {
  var home = l.home, fx = { err: '', out: '', unlink: null, write: null, cacheOwed: false };
  var sidRaw = p.session_id, sid;
  if (sidRaw === undefined || sidRaw === null || sidRaw === false || sidRaw === '') sid = ah.cfg('devswarm_role.pg_no_session');
  else if (typeof sidRaw === 'string') sid = sidRaw;
  else throw meshDefer;
  var cwd = p.cwd;
  if (typeof cwd !== 'string' || cwd === '' || cwd.charAt(0) !== '/') throw meshDefer; // Node falls back to its own working directory
  var idn = ah.mesh.ident(cwd), selfKey = idn.key;
  var own = pgReadOwn(home, idn, selfKey);
  var descriptors = pgDescriptors(home);
  if (own.id !== null && pgHasJson(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_escalation'))) throw meshDefer; // a parked escalation notice
  var stateRel = ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_role.pg_dir_gate') + '/' + sid.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json';
  var stateFile = home + '/' + stateRel;
  if (descriptors.length === 0 && !own.unknown) { fx.unlink = stateRel; return fx; }

  var entries = [];
  if (own.id !== null) {
    var oe = pgNewEntry(own.id, cwd, null);
    oe.unknown = own.unknown;
    oe.reason = own.unknown ? 'own-summary-unreadable' : null;
    entries.push(oe);
  }
  var now = ah.clock.now();
  if (ah.settings.touched('devswarm_role.pg_set_held')) throw meshDefer; // the owner's held partitions
  var ignore = pgIgnoreIds(home), keyMemo = {}, readyMemo = {}, goneMemo = {};
  keyMemo[cwd] = selfKey;
  function keyOf(wt) {
    if (!Object.prototype.hasOwnProperty.call(keyMemo, wt)) keyMemo[wt] = ah.mesh.repoKey(wt);
    return keyMemo[wt];
  }
  descriptors.forEach(function (d) {
    var isOwn = own.id === d.id;
    if (isOwn && !own.parsed) return;
    var fresh = selfKey !== null ? keyOf(d.worktree) : null;
    if (selfKey !== null && fresh !== null && selfKey !== fresh) return;
    var registered = selfKey !== null && fresh === null ? ah.mesh.registeredKey(d.raw, d.id) : fresh;
    var foreign = selfKey !== null && fresh === null && registered !== null && registered !== selfKey;
    if (ignore[d.id] === true) return;
    var done = !isOwn && pgArchiveReady(home, d.id, fresh, readyMemo);
    var e = pgNewEntry(d.id, d.worktree, d.session);
    e.done = done;
    e.foreign = foreign;
    var ndOldest = null, ownNoInbox = false, ownStoreCounted = false, dead = false;
    var bl = pgBacklog(d.inbox, d.cursor);
    if (bl.unknown !== undefined) {
      if (isOwn && bl.unknown === 'no-inbox-path') ownNoInbox = true;
      else if (bl.unknown === 'inbox-missing' && pgWorktreeGone(d.worktree, goneMemo)) dead = true;
      else if (bl.unknown === 'inbox-missing' && !foreign) {
        var conclusive = false;
        if (fresh !== null) { var mc = ah.mesh.messageCount(fresh, d.id); conclusive = mc.state === 'ok' && mc.count > 0; }
        if (!conclusive) { e.unknown = true; e.reason = bl.unknown; e.reasonPath = bl.path; e.reasonErrno = bl.errno; }
      } else { e.unknown = true; e.reason = bl.unknown; e.reasonPath = bl.path; e.reasonErrno = bl.errno; }
    } else {
      bl.rows.forEach(function (row) {
        if (row === null) { e.realUnread += 1; e.ageUnknown = true; return; }
        if (pgNoise(row.message) || (done && pgBroadcast(row))) return;
        var ts = pgRowTs(row);
        if (ts.at !== undefined) ndOldest = ndOldest === null ? ts.at : Math.min(ndOldest, ts.at);
        else if (ts.none) e.ageUnknown = true;
        else e.ageOdd = true;
        e.realUnread += 1;
      });
    }
    var unionKey = fresh !== null ? fresh : (dead ? registered : null);
    if (!e.unknown && unionKey !== null && !foreign) {
      var u = ah.mesh.union(unionKey, d.id, d.inbox, d.cursor, isOwn, now);
      if (u.state === 'ok') {
        ownStoreCounted = true;
        var allOwn = true, real = 0;
        u.storeOnly.forEach(function (row) {
          if (typeof row.body === 'string' && row.body.replace(/^\s+/, '').indexOf(ah.cfg('devswarm_role.pg_poke_prefix')) === 0) return;
          if (done && pgBroadcast(row)) return;
          real += 1;
          e.realUnread += 1;
          if (!(own.id !== null && typeof row.sender === 'string' && row.sender === own.id)) allOwn = false;
        });
        if (real > 0 && !allOwn) e.hadStoreOnly = true;
        if (u.age !== null) e.oldestAge = u.age;
        else if (real > 0) e.ageUnknown = true;
      }
    }
    if (ndOldest !== null) {
      var age = ah.clock.now() - ndOldest;
      if (isFinite(age) && (e.oldestAge === null || age > e.oldestAge)) e.oldestAge = Math.max(age, 0);
    }
    if (e.realUnread > 0 && e.oldestAge === null) e.ageUnknown = true;
    if (ownNoInbox && !ownStoreCounted && !e.unknown) fx.err += text.render(ah.cfg('devswarm_role.pg_err_own_no_key'), { id: d.id });
    if (!foreign) {
      var lv = pgJson(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_liveness') + '/' + d.id + '.json');
      if (lv !== null && typeof lv === 'object' && (lv.status === ah.cfg('devswarm_role.pg_status_stale') || lv.status === ah.cfg('devswarm_role.pg_status_escalated'))) throw meshDefer;
    }
    // the eligibility projection (row-eligibility.js `of`, liveness on, the cross-invocation app cache on)
    e.archived = pgMarkerArchived(home, d);
    var app = ah.mesh.appArchived(d.id, d.worktree, true);
    if (app.cache !== null) fx.cacheOwed = true;
    if (app.verdict !== null) e.appArchived = app.verdict;
    else {
      var rp = ah.fs.realpath(d.worktree);
      if (fresh !== null && ah.path.resolveAbs(rp === null ? d.worktree : rp).indexOf(ah.cfg('devswarm_role.pg_repos_root_marker')) >= 0) throw meshDefer; // the supervisor's active-list cache
      if (fresh !== null && d.worktree.indexOf(ah.cfg('devswarm_role.pg_repos_root_marker')) >= 0) throw meshDefer;
      e.appArchived = false;
    }
    e.ignored = pgExists(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_archive_ignore') + '/' + d.id + '.json');
    if (d.session !== '') e.live = ah.mesh.sessionAlive(d.session);
    if (e.archived || e.appArchived || e.ignored) e.stateSkipped = true; // only a member of the Primary's own family could still need it (checked there)
    else if (d.id !== '' && d.session !== '' && d.worktree !== '') {
      var fresh_ms = pgSetNum('devswarm_role.pg_set_busy_fresh') * pgMin();
      var b = ah.mesh.childBusy(d.id, d.worktree, d.session, now, fresh_ms);
      if (b.none !== true) {
        e.waiting = b.waiting && e.live;
        e.waitingQ = e.waiting ? b.question : null;
        e.busy = b.busy && !e.waiting;
      }
    }
    entries.push(e);
  });

  // identity families, with the Primary's twins merged into its own family
  var families = pgCollapse(entries);
  if (own.id !== null) {
    var selfIdx = -1;
    entries.forEach(function (e, i) { if (selfIdx < 0 && e.id === own.id) selfIdx = i; });
    var fi = -1;
    if (selfIdx >= 0) families.forEach(function (f, i) { if (fi < 0 && f.members.indexOf(selfIdx) >= 0) fi = i; });
    if (fi >= 0) {
      var kept = [], merged = [], twins = [], selfFam = null;
      families.forEach(function (f, i) {
        if (i === fi) { selfFam = f; return; }
        if (f.members.some(function (m) { return pgCrossLinked(entries[selfIdx], entries[m]); })) {
          f.members.forEach(function (m) { merged.push(m); if (m !== selfIdx) twins.push(entries[m].id); });
        } else kept.push(f);
      });
      merged.forEach(function (m) { if (selfFam.members.indexOf(m) < 0) selfFam.members.push(m); });
      selfFam.mergedTwins = twins;
      if (own.registryIds.indexOf(own.id) >= 0) selfFam.survivor = selfIdx;
      families = [selfFam].concat(kept);
    }
  }

  var blocking = [], archivedUnreadFamilies = 0, busyAdvisoryHeld = false;
  var minMs = pgMin();
  for (var fidx = 0; fidx < families.length; fidx++) {
    var fam = families[fidx];
    var famChild = own.id !== entries[fam.survivor].id;
    var union = 0, unknown = false, archivedMemberUnread = 0, liveMembers = 0;
    var unknownMembers = [], contributors = [], foreignAll = fam.members.length > 0, gone = false, allDoneOrIdle = true;
    if (!famChild && fam.members.some(function (mi) { return entries[mi].stateSkipped; })) throw meshDefer; // an archived twin of the Primary's own row
    var famBusy = false, famWaiting = false, famAgeUnknown = false, famStoreOnly = false, famOldest = null;
    for (var mj = 0; mj < fam.members.length; mj++) {
      var mi = fam.members[mj], m = entries[mi];
      if (m.held || (famChild && (m.archived || m.appArchived || m.ignored))) {
        if (m.realUnread > 0) archivedMemberUnread += m.realUnread;
        continue;
      }
      liveMembers += 1;
      if (!(m.done || (m.live && !m.busy && !m.waiting))) allDoneOrIdle = false;
      famAgeUnknown = famAgeUnknown || m.ageUnknown;
      famBusy = famBusy || m.busy;
      famWaiting = famWaiting || m.waiting;
      famStoreOnly = famStoreOnly || m.hadStoreOnly;
      if (m.oldestAge !== null && (famOldest === null || m.oldestAge > famOldest)) famOldest = m.oldestAge;
      union += m.realUnread;
      var mg = pgWorktreeGone(m.worktree, goneMemo);
      if (mg) gone = true;
      if (m.realUnread > 0) contributors.push([m.id, m.realUnread, m.archived, m.appArchived, mg]);
      if (m.unknown) { unknown = true; unknownMembers.push([m.id, m.reason === null ? 'unknown' : m.reason, m.reasonPath, m.reasonErrno]); }
      if (!m.foreign) foreignAll = false;
    }
    if (famChild && liveMembers === 0) {
      if (archivedMemberUnread > 0) archivedUnreadFamilies += 1;
      continue;
    }
    // the busy downgrade and the fresh-mail grace window: a child family whose only reason to report is a plain backlog
    var busyStaleAgeMin = null;
    if (famChild && !unknown && union > 0) {
      if (fam.members.some(function (x) { return entries[x].ageOdd; })) throw meshDefer;
      var survId = entries[fam.survivor].id, ageKnown = !famAgeUnknown && famOldest !== null;
      if (famBusy && !famWaiting) {
        if (ageKnown) {
          if (famOldest <= pgSetNum('devswarm_role.pg_set_busy_max_age') * minMs) {
            var ageTxt = text.render(ah.cfg('devswarm_role.pg_err_busy_age'), { m: String(Math.max(Math.round(famOldest / minMs), 1)) });
            fx.err += text.render(ah.cfg('devswarm_role.pg_err_busy'), { id: survId, n: String(union), age: ageTxt });
            busyAdvisoryHeld = true;
            continue;
          }
          busyStaleAgeMin = Math.max(Math.round(famOldest / minMs), 1);
        }
      } else if (!famWaiting) {
        if (!famStoreOnly && ageKnown && famOldest <= pgSetNum('devswarm_role.pg_set_grace') * minMs) {
          fx.err += text.render(ah.cfg('devswarm_role.pg_err_grace'), { id: survId, n: String(union), s: String(Math.max(Math.round(famOldest / 1000), 1)) });
          busyAdvisoryHeld = true;
          continue;
        }
        if (union <= pgSetNum('devswarm_role.pg_set_neglect_min')) continue;
      }
    }
    if (!(unknown || union > 0)) continue;
    if (famWaiting && fam.members.some(function (x) { return entries[x].stateSkipped; })) throw meshDefer; // the waiting members are listed by id, archived ones included
    blocking.push({
      id: entries[fam.survivor].id, unread: union, unknown: unknown, unknownMembers: unknownMembers, contributors: contributors,
      notOwnCountOnly: contributors.some(function (c) { return own.id !== c[0]; }), foreign: foreignAll, worktreeGone: gone,
      doneOrIdle: liveMembers > 0 && famChild && allDoneOrIdle, mergedTwins: fam.mergedTwins, waitingOnInput: famWaiting,
      waiting: fam.members.map(function (x) { return entries[x]; }).filter(function (x) { return x.waiting; }).map(function (x) { return [x.id, x.waitingQ]; }),
      busyStaleAgeMin: busyStaleAgeMin,
    });
  }
  if (archivedUnreadFamilies > 0) fx.err += text.render(ah.cfg('devswarm_role.pg_err_archived_unread'), { n: String(archivedUnreadFamilies) });
  // emitStrayingAdvisory: any stray plan state is Node's
  if (pgHasJson(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_stray'))) throw meshDefer;

  if (blocking.length === 0) {
    // a pass that only deferred unread mail keeps the loop state and skips the wake-coverage line; only a clean pass clears the state,
    // after the wake-coverage line (which needs a live child of this project) is known to be silent
    if (!busyAdvisoryHeld) {
      if (own.id !== null && selfKey !== null && pgLiveChild(home, cwd, selfKey, descriptors)) throw meshDefer;
      fx.unlink = stateRel;
    }
    return fx;
  }

  // ---- the block: loop state, cap, escalation -----------------------------------------------------------------------
  var kinds = blocking.map(function (b) { return own.id === b.id ? ah.cfg('devswarm_role.pg_kind_mailbox') : ah.cfg('devswarm_role.pg_kind_children'); }).sort();
  kinds = kinds.filter(function (k, i) { return i === 0 || k !== kinds[i - 1]; });
  var sig = ah.sha1(ah.cfg('devswarm_role.pg_sig_prefix') + kinds.join(',')), qSig = ah.sha1('');
  var prev = pgJson(stateFile);
  var has = function (k) { return prev !== null && typeof prev === 'object' ? prev[k] : undefined; };
  var lastSig = typeof has('sig') === 'string' ? has('sig') : '';
  var num = function (k) { var v = has(k); return typeof v === 'number' && isFinite(v) ? v : 0; };
  var blocks = num('blocks'), qBlocks = num('qBlocks'), intentAcks = num('intentAcks');
  var escalated = has('escalated') === true, qEscalated = has('qEscalated') === true;
  var lastQSig = typeof has('qSig') === 'string' ? has('qSig') : '';
  var intents = jx.isObj(has('intents')) ? has('intents') : null;
  var hasIntent = intents !== null && Object.prototype.hasOwnProperty.call(intents, sig);
  var same = sig === lastSig;
  var effBlocks = same ? blocks : 0, effEscalated = same && escalated, effAcks = same ? intentAcks : 0;
  // the drain marker of this Primary
  if (own.id !== null && pgExists(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_drain') + '/' + own.id + '.json')) throw meshDefer;
  if (effEscalated) return fx; // already escalated once: quiet
  if (ah.settings.touched('devswarm_role.pg_set_cap')) throw meshDefer;
  var cap = ah.cfg('devswarm_role.pg_set_cap').default;
  var nextBlocks = effBlocks + 1;
  var effCap = hasIntent ? cap * ah.cfgNum('devswarm_role.pg_intent_multiplier') : cap;
  var nextAcks = hasIntent ? effAcks + 1 : effAcks;
  var escalateTimes = null;
  if (effBlocks >= effCap) {
    if (own.id !== null && blocking.every(function (b) { return own.id === b.id; })) throw meshDefer; // the conservation hold
    escalateTimes = nextBlocks;
  }
  var nextQBlocks = qSig === lastQSig ? qBlocks : 0, nextQEscalated = qSig === lastQSig && qEscalated;
  var nextIntents = {};
  if (hasIntent) nextIntents[sig] = intents[sig];
  fx.write = { rel: stateRel, body: JSON.stringify({ sig: sig, blocks: nextBlocks, escalated: escalateTimes !== null, qSig: qSig, qBlocks: nextQBlocks, qEscalated: nextQEscalated, intents: nextIntents, intentAcks: nextAcks }) };

  // the stale-build downgrade: a plain neglect block is dropped while the host registered a newer version
  if (escalateTimes === null && pgVersionStale(root)) return fx;
  var wake = pgWakeLine(own.id, l);
  var waitingSeg = '';
  blocking.forEach(function (b) {
    if (b.waitingOnInput) {
      if (b.waiting.length === 0) waitingSeg += text.render(ah.cfg('devswarm_role.pg_waiting_line'), { title: pgTitle(home, b.id), q: '' });
      b.waiting.forEach(function (w) {
        var qs = w[1] !== null ? text.render(ah.cfg('devswarm_role.pg_waiting_q'), { q: w[1] }) : '';
        waitingSeg += text.render(ah.cfg('devswarm_role.pg_waiting_line'), { title: pgTitle(home, w[0]), q: qs });
      });
    }
    if (b.busyStaleAgeMin !== null) waitingSeg += text.render(ah.cfg('devswarm_role.pg_busy_stale_line'), { title: pgTitle(home, b.id), m: String(b.busyStaleAgeMin) });
  });
  var base = waitingSeg + pgReason(blocking, own.id, escalateTimes, hasIntent, own.unknown, own.parsed);
  var cli = root + '/' + ah.cfg('devswarm_role.launcher_cli').target;
  var skip = text.render(ah.cfg('devswarm_role.pg_skip_cmd'), { cli: pgShQuote(ah.path.resolveAbs(cli)), guard: ah.cfg('devswarm_role.gate_guard') });
  fx.out = JSON.stringify({ decision: ah.cfg('devswarm_role.pg_decision_block'), reason: pgFrame(base + wake, skip) }) + '\n';
  return fx;
}

// `liveChildState(home, cwd, { excludeHeldIgnored: true }).live` for the clean pass: a descriptor of this project (not this worktree) that
// is neither archived, held nor ignored. Fails toward "live" (defer) wherever the projection is not reproduced.
function pgLiveChild(home, cwd, selfKey, descriptors) {
  var sr = ah.fs.realpath(cwd), selfReal = sr === null ? cwd : sr;
  for (var i = 0; i < descriptors.length; i++) {
    var d = descriptors[i], rr = ah.fs.realpath(d.worktree), real = rr === null ? d.worktree : rr;
    if (real === selfReal) continue;
    if (ah.mesh.repoKey(d.worktree) !== selfKey) continue;
    if (pgMarkerArchived(home, d)) continue;
    var app = ah.mesh.appArchived(d.id, d.worktree, false).verdict;
    if (app === true) continue;
    if (app === null && d.worktree.indexOf(ah.cfg('devswarm_role.pg_repos_root_marker')) >= 0) throw meshDefer;
    if (pgExists(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_archive_ignore') + '/' + d.id + '.json')) continue;
    return true;
  }
  return false;
}

// `isStale(pluginRoot)` of hooks/lib/stop-version-gate.js.
function pgVersionStale(root) {
  var guard = ah.homeGuard();
  if (guard.status !== 'ok') throw meshDefer;
  if (!ah.settings.bool('silent_nudge.version_gate_setting')) return false;
  var v = ah.plugin.versions(root);
  if (v.unsure) throw meshDefer;
  if (!v.registered || !v.running || !jx.isSemver(v.registered) || !jx.isSemver(v.running)) return false;
  return jx.cmpVersions(v.running, v.registered) < 0;
}

// ---- texts -------------------------------------------------------------------------------------------------------------

// `wakeReassertLine(env, false, ownId)`: the Primary's mailbox-wake re-verify line (Claude only).
function pgWakeLine(ownId, l) {
  var raw = ah.env.get(ah.cfg('devswarm_role.agent_env'));
  var agent = raw === null ? '' : raw.trim().toLowerCase();
  if (agent !== ah.cfg('devswarm_role.claude_agent')) return '';
  var extra = ah.cfg('devswarm_role.id_extra_chars');
  var valid = function (v) { return typeof v === 'string' && v !== '' && v.split('').every(function (c) { return /[A-Za-z0-9]/.test(c) || extra.indexOf(c) >= 0; }); };
  var id;
  if (ownId !== null && valid(ownId)) id = ownId;
  else { var b = ah.env.get(ah.cfg('devswarm_role.builder_env')); id = valid(b) ? b : ah.cfg('devswarm_role.id_placeholder'); }
  var tick = text.render(ah.cfg('devswarm_role.pg_wake_tick'), { id: id }), watch = text.render(ah.cfg('devswarm_role.pg_wake_watch'), { watcher: pgDq(l.watcher) });
  return text.render(ah.cfg('devswarm_role.pg_wake_line'), { cli: pgDq(l.cli), cron: dwWakeCron(), tick: tick, watch: watch, id: id });
}

// `frame({ guard, headline, why, override, body })` of hooks/lib/block-message.js.
function pgFrame(body, skip) {
  var clean = text.clean;
  var lines = [text.render(ah.cfg('devswarm_role.pg_frame_head'), { guard: clean(ah.cfg('devswarm_role.gate_guard')), headline: clean(ah.cfg('devswarm_role.pg_headline')) })];
  lines.push(ah.cfg('devswarm_role.pg_frame_why') + clean(ah.cfg('devswarm_role.pg_why')));
  var paras = body.split(/\n{2,}/).map(clean).filter(function (x) { return x !== ''; });
  if (paras.length > 0) {
    lines.push(ah.cfg('devswarm_role.pg_frame_instead') + paras[0]);
    paras.slice(1).forEach(function (x) { lines.push(ah.cfg('devswarm_role.pg_frame_indent') + x); });
  }
  lines.push(ah.cfg('devswarm_role.pg_frame_override') + clean(skip + ah.cfg('devswarm_role.pg_skip_ttl')));
  return lines.join('\n');
}

function pgReasonLabel(reason, path, errno) {
  var suffix = path ? ' (' + path + (errno ? ', ' + errno : '') + ')' : '';
  var labels = ah.cfg('devswarm_role.pg_reason_labels');
  return (Object.prototype.hasOwnProperty.call(labels, reason) ? labels[reason] : ah.cfg('devswarm_role.pg_reason_default')) + suffix;
}

function pgListMore(ids, max) {
  var s = ids.slice(0, max).join('; ');
  if (ids.length > max) s += text.render(ah.cfg('devswarm_role.pg_and_more'), { n: String(ids.length - max) });
  return s;
}

// `buildReason` for the shapes the gate answers (no question, no truncation, no stale verdict).
function pgReason(blocking, ownId, escalate, hasIntent, ownUnknown, ownParsed) {
  var isOwn = function (id) { return ownId === id; };
  var max = ah.cfgNum('devswarm_role.pg_max_shown'), maxUnknown = ah.cfgNum('devswarm_role.pg_max_unknown_shown'), you = ah.cfg('devswarm_role.pg_you');
  var shown = blocking.slice(0, max).map(function (b) {
    var bits = [];
    if (b.unread > 0) bits.push(text.render(ah.cfg('devswarm_role.pg_bit_unread'), { n: String(b.unread) }));
    if (b.unknown) {
      var ms = b.unknownMembers;
      if (ms.length === 0) bits.push(ah.cfg('devswarm_role.pg_inbox_unreadable'));
      else {
        var s = ms.slice(0, maxUnknown).map(function (u) { return (u[0] !== '' && u[0] !== b.id ? u[0] + ': ' : '') + pgReasonLabel(u[1], u[2], u[3]); }).join('; ');
        if (ms.length > maxUnknown) s += text.render(ah.cfg('devswarm_role.pg_more_unknown'), { n: String(ms.length - maxUnknown) });
        bits.push(s);
      }
    }
    if (isOwn(b.id) && ownParsed && !b.notOwnCountOnly) bits.push(ah.cfg('devswarm_role.pg_cached'));
    return b.id + (isOwn(b.id) ? you : '') + ' (' + bits.join(', ') + ')';
  }).join('; ');
  var more = blocking.length > max ? text.render(ah.cfg('devswarm_role.pg_and_more'), { n: String(blocking.length - max) }) : '';
  var stable = blocking.slice(0, max).map(function (b) { return b.id + (isOwn(b.id) ? you : ''); }).join('; ');
  var flagged = blocking.filter(function (b) { return !isOwn(b.id) && !b.foreign; });
  if (escalate !== null) {
    return text.render(ah.cfg('devswarm_role.pg_escalation'), {
      shown: stable + more, times: String(escalate), intent: hasIntent ? ah.cfg('devswarm_role.pg_escalation_intent') : '',
      archive: flagged.length > 0 && flagged.every(function (b) { return b.doneOrIdle; }) ? ah.cfg('devswarm_role.pg_escalation_archive') : '',
    });
  }
  var ownEntry = null;
  for (var i = 0; i < blocking.length; i++) if (isOwn(blocking[i].id) && (blocking[i].unread > 0 || blocking[i].unknown)) { ownEntry = blocking[i]; break; }
  var anyChild = blocking.some(function (b) { return (b.unread > 0 || b.unknown) && !isOwn(b.id) && !b.foreign; });
  var body = text.render(ah.cfg('devswarm_role.pg_neglect'), { n: String(blocking.length), shown: shown, more: more });
  blocking.forEach(function (b) {
    if (b.contributors.length <= 1) return;
    var parts = b.contributors.map(function (c) {
      var flags = [];
      if (c[2]) flags.push(ah.cfg('devswarm_role.pg_flag_archived'));
      if (c[3]) flags.push(ah.cfg('devswarm_role.pg_flag_app_archived'));
      if (c[4]) flags.push(ah.cfg('devswarm_role.pg_flag_gone'));
      var flag = flags.length === 0 ? '' : ' [' + flags.join(', ') + ']';
      var who = isOwn(c[0]) ? c[0] + you : c[0];
      var drain = isOwn(c[0]) ? '' : text.render(ah.cfg('devswarm_role.pg_attr_drain'), { id: c[0] });
      return who + ': ' + String(c[1]) + flag + drain;
    }).join('; ');
    body += text.render(ah.cfg('devswarm_role.pg_attribution'), { id: b.id, n: String(b.unread), parts: parts });
  });
  if (ownUnknown) body += text.render(ah.cfg('devswarm_role.pg_own_unknown'), { id: ownId === null ? '' : ownId });
  if (ownEntry !== null && ownEntry.mergedTwins.length > 0) {
    var tw = ownEntry.mergedTwins;
    var list = tw.slice(0, max).join('; '), moreT = tw.length > max ? text.render(ah.cfg('devswarm_role.pg_twin_more'), { n: String(tw.length - max) }) : '';
    body += text.render(ah.cfg('devswarm_role.pg_twins'), { n: String(tw.length), s: tw.length === 1 ? '' : ah.cfg('devswarm_role.pg_plural_s'), list: list + moreT });
  }
  var foreign = blocking.filter(function (b) { return b.foreign && !isOwn(b.id); }).map(function (b) { return b.id; });
  if (foreign.length > 0) body += text.render(ah.cfg('devswarm_role.pg_foreign'), { ids: pgListMore(foreign, max), verb: foreign.length === 1 ? ah.cfg('devswarm_role.pg_verb_is') : ah.cfg('devswarm_role.pg_verb_are') });
  var gone = blocking.filter(function (b) { return b.worktreeGone && !b.foreign; }).map(function (b) { return b.id; });
  if (gone.length > 0) body += text.render(ah.cfg('devswarm_role.pg_gone'), { ids: pgListMore(gone, max), verb: gone.length === 1 ? ah.cfg('devswarm_role.pg_verb_has') : ah.cfg('devswarm_role.pg_verb_have') });
  if (anyChild) body += ah.cfg('devswarm_role.pg_inspect');
  return body + ah.cfg('devswarm_role.pg_tail');
}

// ---- the entry ---------------------------------------------------------------------------------------------------------

// Apply what the gate decided, only once nothing can defer any more.
function pgApply(fx) {
  if (fx.unlink !== null || fx.write !== null || fx.cacheOwed) ah.commit();
  if (fx.unlink !== null) ah.state.remove(fx.unlink);
  if (fx.write !== null && !ah.state.writeAtomic(fx.write.rel, fx.write.body)) {
    // Node: `catch (_) { return; }` -- nothing printed on stdout
    return fx.err === '' ? 'allow' : { exact: { code: 0, out: '', err: fx.err } };
  }
  if (fx.cacheOwed) ah.mesh.performCache();
  return fx.out === '' && fx.err === '' ? 'allow' : { exact: { code: 0, out: fx.out, err: fx.err } };
}

function decide(p, opts, event) {
  if (event !== 'Stop') return 'defer';
  if (dwJudgeChild()) return 'allow';
  if (dwUsableHome() !== null) {
    if (!ah.settings.bool('devswarm_role.sw_parent_gate')) return 'allow';
    if (ah.settings.skipped(ah.cfg('devswarm_role.gate_guard'))) return 'allow';
    if (!dwActive() || dwNonBlank(ah.cfg('devswarm_role.branch_env'))) return 'allow';
  }
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
  var l = dwLaunchersCurrent(root, true);
  if (l === null || !jx.isObj(p)) return 'defer';
  if (p[ah.cfg('devswarm_gates.readside_stop_field')] === true) return 'allow';
  var fx;
  try { fx = pgGate(p, root, l); } catch (e) { if (e === meshDefer) return 'defer'; throw e; }
  return pgApply(fx);
}
