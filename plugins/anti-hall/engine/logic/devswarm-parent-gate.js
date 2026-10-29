// check = "devswarm-parent-gate" (Stop): the Primary's Stop gate. A Stop guard is never weaker than Node (D74). The silent exits of the Node
// hook (the judge-child exit, the `devswarm.parentGate` switch, the user skip, a supervisor that is not active, a child workspace, a hook that
// stops again after its own block) are answered first, in Node's order. Past them the gate reads the Primary's own summary, the workspace
// descriptors, the durable inboxes and the mesh store (ah.mesh), classifies the live children (busy, waiting on a human, fresh mail), and
// answers what Node answers: the inert and clean passes (the loop state removed), the busy and grace advisories, and the neglect block with
// its loop state, forced-acknowledgement counter, the one escalation and the quiet tail after it, the stated intent's larger budget, the
// waiting-on-human lines, the mailbox-wake line and the stale-build downgrade, and the questions asked of the Primary (its summary entry's
// pending questions cross-checked against the reply records, retired senders named only, put-away askers dropped, a truncated list, the
// question ceiling and its one escalation), the Primary's own summary count corrected by this reader's own position in the store
// (devswarm-own-reader.js: the delta, the live recheck with its summary refresh, the stale-cache unknown, the urgent prefix) and the
// in-flight drain marker (a fresh one of this session: a stderr notice, the loop state unchanged; a stale one removed). Whatever it
// cannot settle exactly is decided natively and counted (native_unable at devswarm-parent-gate:*), towards the stricter reading where it
// is the evidence of a block (an unreadable count is unknown, a Jev question candidate counts as unread, an unreadable marker leaves an
// asker live, the limit-conservation hold is not applied). Not reproduced here: the Jev trust math of question candidates, parked
// escalation notices, stale/escalated liveness verdicts, the owner's held partitions and the supervisor's active-list cache. Mirrors hooks/devswarm-parent-gate.js (`main`, `readOwnUnread`, `buildReason` and helpers), the companion's
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
// parse the interpreter cannot finish counts as unreadable (counted).
function pgJson(p) {
  var r = jx.read(p);
  if (r.big) { ah.unable('devswarm-parent-gate:json_big'); return null; }
  if (r.text === undefined) return null;
  var j = jx.parse(r.text);
  if (j.unsure) { ah.unable('devswarm-parent-gate:json_unsure'); return null; }
  return j.invalid ? null : j.v;
}

// The sorted names in a directory; null when it is not one. A directory too big to list reads as empty (counted).
function pgNames(dir) {
  var n = ah.fs.readdir(dir);
  if (n === null && ah.fs.isDir(dir)) { ah.unable('devswarm-parent-gate:listing_big'); return []; }
  return n;
}

function pgHasJson(dir) { var n = pgNames(dir); return n !== null && n.some(function (x) { return /\.json$/.test(x); }); }

// A descriptor path field read with JavaScript truthiness: a non-empty string, else null.
function pgPathField(o, k) {
  var v = o[k];
  if (v === undefined || v === null || v === false || v === '' || v === 0 || (typeof v === 'number' && isNaN(v))) return null;
  if (typeof v === 'string') return v;
  ah.unable('devswarm-parent-gate:path_field_shape');
  return String(v);
}

// A numeric setting of the gate: its value along the settings chain (the shipped default when nothing sets it).
function pgSetNum(key) { return ah.settings.num(key); }

function pgShQuote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function pgDq(s) { return '"' + s.replace(/["\\$`]/g, function (c) { return '\\' + c; }) + '"'; }

// ---- the Primary's own unread (readOwnUnread) ------------------------------------------------------------------------

function pgReadOwn(home, idn, selfKey) {
  // `pending`, `truncated`, `registryRows` and `archivedKnown` are the entry's question fields and the registry projection Node returns
  // `unread`, `stale`, `source` ('live' | 'cache' | null), `rawZero`, `derive` and `urgency` are the own-reader projection
  var own = { id: null, unknown: false, parsed: false, registryIds: [], pending: [], truncated: null, registryRows: [], archivedKnown: false,
    unread: 0, stale: false, source: null, rawZero: false, derive: false, urgency: null };
  // a work tree the host could not resolve (counted at mesh:ident) may be a Primary's: it blocks as an unreadable own mailbox, never passes
  if (idn.unsure === true) { own.id = ah.cfg('devswarm_role.pg_ident_unsure_id'); own.unknown = true; return own; }
  if (idn.top === null) return own;
  var id = idn.own, prefix = ah.cfg('mesh_write.primary_prefix');
  var hash;
  if (selfKey !== null) hash = selfKey;
  else if (id.indexOf(prefix) === 0) hash = id.slice(prefix.length);
  else { ah.unable('devswarm-parent-gate:own_key'); own.unknown = true; return own; } // no key to read the summary by: unknown (the stricter reading)
  own.id = id;
  var p = pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_summaries') + '/' + hash + '.json';
  var st = ah.fs.lstat(p);
  if (st === null || (st.kind === 'link' && ah.fs.realpath(p) === null)) return own; // absent: not unknown
  var r = jx.read(p);
  if (r.big) { ah.unable('devswarm-parent-gate:own_summary_big'); own.unknown = true; return own; }
  if (r.text === undefined) { own.unknown = true; return own; }
  var trimmed = r.text.trim();
  if (trimmed === '') { own.unknown = true; return own; }
  var j = jx.parse(trimmed);
  if (j.unsure) { ah.unable('devswarm-parent-gate:own_summary_unsure'); own.unknown = true; return own; }
  var summary = j.v;
  if (j.invalid || !jx.isObj(summary)) { own.unknown = true; return own; }
  var ws = summary.workspaces;
  if (!jx.isObj(ws)) { own.unknown = true; return own; }
  var e = ws[id];
  var raw = 0;
  if (jx.isObj(e)) {
    // a Jev-confirmed question candidate is folded in through jev-assist's trust math and its log: Node's
    raw = piFinite(e.unread) && e.unread > 0 ? e.unread : 0;
    // the Jev trust math of these candidates is not run here: each counts as unread (the stricter reading)
    if (Array.isArray(e.jevQuestionCandidates) && e.jevQuestionCandidates.length > 0) { ah.unable('devswarm-parent-gate:jev_question_candidates'); raw += e.jevQuestionCandidates.length; }
  }
  // the entry's count corrected by this reader's own position (devswarm-own-reader.js)
  var c = pgOwnCount(selfKey, id, e, raw);
  own.unread = c.unread;
  own.unknown = c.stale;
  own.stale = c.stale;
  own.source = c.stale ? null : (c.live ? 'live' : 'cache');
  own.rawZero = c.rawZero;
  own.derive = c.derive;
  own.urgency = c.unread > 0 && e.urgencyMax ? e.urgencyMax : null;
  if (e && Array.isArray(e.pendingQuestions)) own.pending = e.pendingQuestions;
  own.truncated = e && e.pendingQuestionsTruncated ? e.pendingQuestionsTruncated : null;
  own.registryIds = Object.keys(ws);
  own.registryRows = own.registryIds.map(function (wid) {
    return { id: wid, worktreePath: (ws[wid] && ws[wid].worktreePath) || null, sessionId: (ws[wid] && ws[wid].sessionId) || null };
  });
  own.archivedKnown = Array.isArray(summary.archivedRegistryRows);
  if (own.archivedKnown) {
    summary.archivedRegistryRows.forEach(function (row) {
      if (jx.isObj(row) && typeof row.id === 'string') own.registryIds.push(row.id);
      if (!row || row.id === null || row.id === undefined) return;
      own.registryRows.push({ id: row.id, worktreePath: row.worktreePath || null, sessionId: row.sessionId || null });
    });
  }
  own.parsed = true;
  return own;
}

// This hook's own reader on the Primary's partition (ah.mesh.ownReader), with the entry's inbox and cursor paths (`|| null`).
function pgOwnReader(selfKey, id, e, count) {
  if (selfKey === null) { ah.unable('devswarm-parent-gate:no_self_key'); return { reader: false }; } // Node opens the store by the work tree's own key: no reader here
  return ah.mesh.ownReader(selfKey, id, pgPathField(e, 'inboxPath'), pgPathField(e, 'cursorPath'), count, ah.clock.now());
}

// The live count of an own reader view read with `count`: `Math.max(countFor, messageCount - own)`.
// With devswarm.parentGateSharedCount on (default), the count is the ONE shared count `mesh inbox peek-primary` reports (`v.shared`:
// own-family sends and wake rows left out); a case where the old projection was higher is counted (count_mismatch), never blocked on.
function pgOwnLive(v, own) {
  if (!pgSharedOn()) {
    // switch off: the old computation, unchanged
    if (v.state !== 'ok' || v.own === null || !piFinite(v.unread) || !piFinite(v.total)) { ah.unable('devswarm-parent-gate:own_live'); return -1; } // not settled: the caller reads it as unknown
    return Math.max(v.unread, Math.max(0, v.total - own));
  }
  if (v.state !== 'ok' || !piFinite(v.shared)) { ah.unable('devswarm-parent-gate:own_live'); return -1; } // not settled: the caller reads it as unknown
  // the old projection, only to count the cases it would have blocked on more than the shared count shows
  if (v.own !== null && piFinite(v.unread) && piFinite(v.total) && Math.max(v.unread, Math.max(0, v.total - own)) > v.shared) pgCountMismatch();
  return v.shared;
}

// The shared-count switch (devswarm.parentGateSharedCount; off restores the old `max(countFor, messageCount - own)` projection).
function pgSharedOn() { return ah.settings.bool('devswarm_role.pg_sw_shared_count') === true; }

// Counters: the registered metrics and the advisory counters of `status`. A lost count never changes a decision.
function pgCountMismatch() {
  ah.metric('devswarm_parent_gate_count_mismatch', []);
  ah.advisory('devswarm_parent_gate', 'count_mismatch');
}
function pgCountFired(kind) {
  ah.metric('devswarm_parent_gate_fired', ['kind', kind]);
  ah.advisory('devswarm_parent_gate', 'fired_' + kind);
}
function pgCountSuppressed(reason) {
  ah.metric('devswarm_parent_gate_suppressed', ['reason', reason]);
  ah.advisory('devswarm_parent_gate', 'suppressed_' + reason);
}

// readOwnUnread's own-instance projection of the summary count `raw` (companion/lib/devswarm-own-reader.js `ownReaderDelta`, then
// `ownReaderLiveUnread` before a cached count may block): {unread, stale, live, rawZero, derive}. `derive`: the live count is 0
// after a positive summary count, so Node refreshes the summary (deriveSummary). A read the engine cannot settle exactly makes the count unknown (the stricter reading).
function pgOwnCount(selfKey, id, e, raw) {
  var r = { unread: 0, stale: false, live: false, rawZero: false, derive: false };
  if (!(raw > 0)) { r.rawZero = true; return r; }
  // ownReaderDelta
  var delta = 0, live = null;
  if (piFinite(e.cursor)) {
    var v = pgOwnReader(selfKey, id, e, false);
    if (v.reader && v.state !== 'ok') r.stale = true; // a summary with a cursor came from a store that is gone now: unknown
    else if (v.reader && v.own !== null && v.own > e.cursor) {
      if (piFinite(e.total) && v.own < e.total) delta = v.own - e.cursor;
      else live = pgOwnLive(pgOwnReader(selfKey, id, e, true), v.own); // the ambiguous branch: one live count settles it
    }
  }
  if (live !== null && live < 0) { r.stale = true; return r; }
  if (live !== null) { r.unread = live; r.live = true; return r; }
  if (r.stale) return r;
  r.unread = delta > 0 ? Math.max(0, raw - delta) : raw;
  if (r.unread > 0) {
    // ownReaderLiveUnread: never block on a cached count when this reader's own row can be read live
    var w = pgOwnReader(selfKey, id, e, true);
    if (w.reader && w.state === 'ok' && (w.own !== null || pgSharedOn())) { // shared count: re-checked live with or without an own row
      var lv = pgOwnLive(w, w.own);
      if (lv < 0) { r.stale = true; r.unread = 0; return r; }
      r.unread = lv;
      r.live = true;
      r.derive = r.unread === 0;
    }
  }
  return r;
}

// The `workspaces` map of a summary text (null when it has none), as pgArchiveReady reads it.
function pgSummaryWs(text) {
  var ws = null, t = text.trim();
  if (t !== '') {
    var j = jx.parse(t);
    if (j.unsure) ah.unable('devswarm-parent-gate:summary_ws_unsure');
    else if (!j.invalid && jx.isObj(j.v) && j.v.workspaces !== null && typeof j.v.workspaces === 'object') ws = j.v.workspaces;
  }
  if (Array.isArray(ws)) { ah.unable('devswarm-parent-gate:summary_ws_array'); ws = null; }
  return ws;
}

// ---- the questions the Primary was asked ---------------------------------------------------------------------------------

// The unanswered questions of the Primary's own entry, as the gate derives them: `familyAwareUnanswered` (the project's reply records,
// the descriptors and the summary's registry rows, families keyed by `canonicalMeshId`, the Primary's own family excluded), then
// `partitionUnanswered` (a sender no row names is informational only) and `filterLiveAskers` with the gate's eligibility context
// (the cross-invocation app cache on, the project key of this Primary). {blocking, informational}.
function pgQuestions(home, own, descriptors, selfKey, fx) {
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  if (own.pending.length === 0) return { blocking: [], informational: [] };
  var replyState = selfKey ? piReplyState(home, selfKey) : Object.create(null);
  var raw = piUnanswered(own.pending, replyState);
  var descRows = descriptors.map(function (d) { return d.raw; }), regRows = own.registryRows;
  // familyAwareUnanswered
  var seen = Object.create(null), rows = [];
  descRows.concat(regRows).forEach(function (r) {
    if (!r || r.id === null || r.id === undefined) return;
    var id = String(r.id);
    if (has(seen, id)) return;
    seen[id] = true;
    rows.push(r);
  });
  var unanswered = raw;
  if (raw.length && rows.length) {
    var meshIds = Object.create(null);
    var resolve = function (wt) {
      if (typeof wt !== 'string') { ah.unable('devswarm-parent-gate:worktree_shape'); return null; }
      if (!has(meshIds, wt)) meshIds[wt] = ah.mesh.canonicalId(wt);
      return meshIds[wt];
    };
    var families = piFamilies(rows, resolve);
    var excluded = piRecipientFamily(own.id, rows);
    var byMember = Object.create(null);
    families.forEach(function (fam) { fam.members.forEach(function (m) { if (m && m.id !== null && m.id !== undefined) byMember[String(m.id)] = fam; }); });
    unanswered = raw.filter(function (q) {
      if (!q || q.from === null || q.from === undefined) return true;
      var fam = has(byMember, String(q.from)) ? byMember[String(q.from)] : null;
      if (fam === null) return true;
      var qTs = piFinite(q.ts) ? q.ts : Infinity;
      for (var i = 0; i < fam.members.length; i++) {
        var m = fam.members[i], mid = m && m.id !== null && m.id !== undefined ? String(m.id) : null;
        if (!mid || has(excluded, mid)) continue;
        var entry = replyState[mid];
        var last = entry && piFinite(entry.lastReplyTs) ? entry.lastReplyTs : 0;
        if (qTs <= last) return false;
      }
      return true;
    });
  }
  // partitionUnanswered
  var blocking = unanswered.slice(), informational = [];
  if ((descRows.length || regRows.length) && own.archivedKnown) {
    var known = Object.create(null);
    descRows.concat(regRows).forEach(function (r) { if (r && r.id !== null && r.id !== undefined) known[String(r.id).trim()] = true; });
    blocking = [];
    unanswered.forEach(function (q) {
      if (!q || q.from === null || q.from === undefined) blocking.push(q);
      else if (has(known, String(q.from).trim())) blocking.push(q);
      else informational.push(q);
    });
  }
  // filterLiveAskers over `rowEligibilityLib.createContext({home, env, now, xcache: true, cache: readActiveCache}).of`
  var byId = Object.create(null);
  var add = function (r) { if (r && r.id !== null && r.id !== undefined && !has(byId, String(r.id))) byId[String(r.id)] = { id: r.id, worktreePath: r.worktreePath || null, sessionId: r.sessionId || null }; };
  regRows.forEach(add);
  descRows.forEach(add);
  var heldAskers = pgHeldIds();
  var live = blocking.filter(function (q) {
    if (!q || q.from === null || q.from === undefined) return true;
    var from = String(q.from);
    var row = has(byId, from) ? byId[from] : null;
    if (row === null) return !own.archivedKnown;
    if (heldAskers.indexOf(from) >= 0) return false; // an owner-held asker's question never blocks
    var wt = piStrField(row.worktreePath), sid = piStrField(row.sessionId);
    var mk = JSON.parse(ahHost.piMarker(from, wt, sid));
    if (mk.unsure) { ah.unable('devswarm-parent-gate:marker_unsure'); mk = { archived: false }; } // an unreadable marker leaves the asker live (the stricter reading)
    var app = ah.mesh.appArchived(from, wt === null ? '' : wt, true);
    if (app.cache !== null) fx.cacheOwed = true;
    var appArchived = false;
    if (app.verdict !== null) appArchived = app.verdict;
    else if (selfKey && from !== '' && wt !== null) {
      // the supervisor's active-list cache, for a worktree the DevSwarm app could own
      if (wt.charAt(0) !== '/') ah.unable('devswarm-parent-gate:asker_worktree_relative');
      else {
        var rp = ah.fs.realpath(wt), marker = ah.cfg('devswarm_role.pg_repos_root_marker');
        if (ah.path.resolveAbs(rp === null ? wt : rp).indexOf(marker) >= 0 || wt.indexOf(marker) >= 0) ah.unable('devswarm-parent-gate:asker_cache'); // the supervisor's active-list cache is not consulted
      }
    }
    if (!pgSafeId(from)) ah.unable('devswarm-parent-gate:asker_unsafe_id');
    else if (pgExists(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_archive_ignore') + '/' + from + '.json')) return false;
    if (!(mk.archived === true || appArchived === true)) return true;
    var st = sid ? JSON.parse(ahHost.piSessionPid(sid)) : { alive: null };
    if (st.unsure) ah.unable('devswarm-parent-gate:session_pid'); // alive unknown: the asker stays live (the stricter reading)
    return st.unsure || st.alive !== false;
  });
  return { blocking: live, informational: informational };
}

// `approxAge(ms)`.
function pgApproxAge(ms) {
  if (!(typeof ms === 'number' && isFinite(ms)) || ms < 0) return ah.cfg('devswarm_role.pg_age_unknown');
  var mins = Math.floor(ms / pgMin()), perHour = ah.cfgNum('devswarm_role.pg_min_per_hour'), perDay = ah.cfgNum('devswarm_role.pg_hour_per_day');
  if (mins < 1) return ah.cfg('devswarm_role.pg_age_under_min');
  if (mins < perHour) return text.render(ah.cfg('devswarm_role.pg_age_min'), { n: String(mins) });
  var hours = Math.floor(mins / perHour);
  if (hours < perDay) return text.render(ah.cfg('devswarm_role.pg_age_hour'), { n: String(hours) });
  return text.render(ah.cfg('devswarm_role.pg_age_day'), { n: String(Math.floor(hours / perDay)) });
}

function pgSender(q) { return q && q.from !== null && q.from !== undefined ? String(q.from) : ah.cfg('devswarm_role.pg_q_unknown_sender'); }

function pgQMore(list) {
  var max = ah.cfgNum('devswarm_role.pg_q_max_shown');
  return list.length > max ? text.render(ah.cfg('devswarm_role.pg_and_more'), { n: String(list.length - max) }) : '';
}

// `buildUnansweredSegment(unanswered)`.
function pgUnansweredSeg(list) {
  var now = ah.clock.now();
  var items = list.slice(0, ah.cfgNum('devswarm_role.pg_q_max_shown')).map(function (q) {
    var ts = q && piFinite(q.ts) ? q.ts : NaN;
    return text.render(ah.cfg('devswarm_role.pg_q_item'), { from: pgSender(q), age: pgApproxAge(now - ts) });
  }).join(ah.cfg('devswarm_role.pg_q_sep'));
  return text.render(ah.cfg('devswarm_role.pg_q_unanswered'), { s: list.length > 1 ? ah.cfg('devswarm_role.pg_q_plural') : '', items: items, more: pgQMore(list) });
}

// `buildTruncatedSegment(truncated)`.
function pgTruncatedSeg(t) {
  var fig = function (k) { var v = t && t[k]; return piFinite(v) ? String(v) : ah.cfg('devswarm_role.pg_q_truncated_unknown'); };
  return text.render(ah.cfg('devswarm_role.pg_q_truncated'), { kept: fig('kept'), dropped: fig('dropped'), cap: fig('cap') });
}

// `buildInformationalSegment(informational)`: each retired sender once, in first-seen order.
function pgInformationalSeg(list) {
  if (!list.length) return '';
  var ids = [];
  list.forEach(function (q) { var s = pgSender(q); if (ids.indexOf(s) < 0) ids.push(s); });
  return text.render(ah.cfg('devswarm_role.pg_q_informational'), { ids: ids.join(ah.cfg('devswarm_role.pg_q_informational_sep')) });
}

// ---- descriptors -------------------------------------------------------------------------------------------------------

function pgDescriptors(home) {
  var dir = pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_workspaces'), out = [];
  (pgNames(dir) || []).forEach(function (n) {
    if (!/\.json$/.test(n)) return;
    var d = pgJson(dir + '/' + n);
    if (!d || !d.worktreePath || !d.sessionId || typeof d.id !== 'string' || !pgSafeId(d.id)) return;
    if (typeof d.worktreePath !== 'string' || typeof d.sessionId !== 'string') { ah.unable('devswarm-parent-gate:descriptor_shape'); return; }
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
  if (r.big) { ah.unable('devswarm-parent-gate:backlog_big'); return { bad: { unknown: unreadable, path: p, errno: 'EFBIG' } }; }
  if (r.text === undefined) { ah.unable('devswarm-parent-gate:backlog_read'); return { bad: { unknown: unreadable, path: p, errno: 'EIO' } }; } // an error code this script cannot name exactly
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
    if (j.unsure) { ah.unable('devswarm-parent-gate:cursor_unsure'); return { unknown: 'cursor-unreadable', path: cursor, errno: null }; }
    if (j.invalid || j.v === null) return { unknown: 'cursor-unreadable', path: cursor, errno: null };
    var line = jx.isObj(j.v) ? j.v.line : undefined;
    if (line === undefined) c = NaN;
    else if (line === null) c = 0;
    else if (typeof line === 'number') c = line;
    else c = Number(line); // a string, boolean or object: JavaScript's coercions, the same here
  }
  if (!isFinite(c) || c < 0) return { unknown: 'cursor-invalid', path: cursor, errno: null };
  var rows = lines.slice(c).map(function (l) {
    var q = jx.parse(l);
    if (q.unsure) { ah.unable('devswarm-parent-gate:backlog_line_unsure'); return null; }
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
    var r = jx.read(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_summaries') + '/' + repoKey + '.json');
    if (r.big) ah.unable('devswarm-parent-gate:archive_summary_big');
    memo[repoKey] = r.big ? null : r.text !== undefined ? pgSummaryWs(r.text) : null;
  }
  var w = memo[repoKey];
  return w !== null && jx.isObj(w[id]) && w[id].archive_ready === true;
}

// The summary's `gates.done` flag for `id` (read after pgArchiveReady has filled the memo of `repoKey`).
function pgGateDone(memo, repoKey, id) {
  var w = repoKey === null || !Object.prototype.hasOwnProperty.call(memo, repoKey) ? null : memo[repoKey];
  return w !== null && jx.isObj(w[id]) && jx.isObj(w[id].gates) && w[id].gates.done === true;
}

function pgIgnoreIds(home) {
  var v = pgJson(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_ignore_file'));
  var out = Object.create(null);
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
  var cache = Object.create(null), order = [], groups = Object.create(null);
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
    stateSkipped: false, foreign: false, hadStoreOnly: false, urgency: null, idleKnown: false, doneGate: false, soe: false, status: '', verdictPending: false };
}

function pgGate(p, root, l) {
  var home = l.home, fx = { err: '', out: '', unlink: null, write: null, extra: [], cacheOwed: false, drainClear: null };
  var sidRaw = p.session_id, sid;
  if (sidRaw === undefined || sidRaw === null || sidRaw === false || sidRaw === '') sid = ah.cfg('devswarm_role.pg_no_session');
  else if (typeof sidRaw === 'string') sid = sidRaw;
  else { ah.unable('devswarm-parent-gate:session_shape'); sid = String(sidRaw); }
  var cwd = p.cwd;
  if (typeof cwd !== 'string' || cwd === '' || cwd.charAt(0) !== '/') { ah.unable('devswarm-parent-gate:cwd_stand_in'); cwd = hookProc.cwd(p); } // Node falls back to its own working directory: the stand-in
  var idn = ah.mesh.ident(cwd), selfKey = idn.key;
  var own = pgReadOwn(home, idn, selfKey);
  // the live count is 0 after a positive summary count: Node refreshes the summary from the store (deriveSummary), before any
  // later read of it
  var derived = null;
  if (own.derive) {
    var dr = JSON.parse(ahHost.piDerive(selfKey, ah.clock.now()));
    if (dr.unsure || typeof dr.text !== 'string') ah.unable('devswarm-parent-gate:derive_summary'); // the summary is not refreshed this Stop
    else {
    derived = dr.text;
    fx.extra.push({ rel: ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_role.pg_dir_summaries') + '/' + selfKey + '.json', body: derived });
    }
  }
  var descriptors = pgDescriptors(home);
  var qs = pgQuestions(home, own, descriptors, selfKey, fx);
  var unanswered = qs.blocking, informational = qs.informational, truncated = own.truncated;
  var parked = pgParkedSegment(home, own.id, l.cli); // escalation notices the supervisor could not deliver to this Primary block like unread mail
  var stateRel = ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_role.pg_dir_gate') + '/' + sid.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json';
  var stateFile = home + '/' + stateRel;
  if (descriptors.length === 0 && own.unread === 0 && !own.unknown && unanswered.length === 0 && !truncated && parked === null) { fx.unlink = stateRel; return fx; }

  var entries = [];
  if (own.id !== null) {
    var oe = pgNewEntry(own.id, cwd, null);
    oe.realUnread = own.unread;
    oe.unknown = own.unknown;
    oe.reason = own.stale ? 'own-cache-stale' : (own.unknown ? 'own-summary-unreadable' : null);
    oe.urgency = own.urgency;
    entries.push(oe);
  }
  var now = ah.clock.now();
  var held = pgHeldIds(); // the owner's held partitions (devswarm.heldPartitions): exempt from the gate
  var ignore = pgIgnoreIds(home), keyMemo = Object.create(null), readyMemo = Object.create(null), goneMemo = Object.create(null);
  keyMemo[cwd] = selfKey;
  if (derived !== null) readyMemo[selfKey] = pgSummaryWs(derived);
  function keyOf(wt) {
    if (!Object.prototype.hasOwnProperty.call(keyMemo, wt)) keyMemo[wt] = ah.mesh.repoKey(wt);
    return keyMemo[wt];
  }
  descriptors.forEach(function (d) {
    var isOwn = own.id === d.id;
    // the own descriptor is the own row's, except when the summary's own count was 0 (not checked at all): then it is counted here
    if (isOwn && !(own.parsed && own.rawZero)) return;
    var fresh = selfKey !== null ? keyOf(d.worktree) : null;
    if (selfKey !== null && fresh !== null && selfKey !== fresh) return;
    var registered = selfKey !== null && fresh === null ? ah.mesh.registeredKey(d.raw, d.id) : fresh;
    var foreign = selfKey !== null && fresh === null && registered !== null && registered !== selfKey;
    if (ignore[d.id] === true) return;
    var done = !isOwn && pgArchiveReady(home, d.id, fresh, readyMemo);
    var e = pgNewEntry(d.id, d.worktree, d.session);
    e.done = done;
    e.doneGate = !isOwn && pgGateDone(readyMemo, fresh, d.id);
    e.foreign = foreign;
    var ndOldest = null, ownNoInbox = false, ownStoreCounted = false, dead = false, ndSenders = [];
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
        var snd = row[ah.cfg('mesh_write.ndjson_sender_field')];
        ndSenders.push(typeof snd === 'string' ? snd : null);
      });
    }
    var unionKey = fresh !== null ? fresh : (dead ? registered : null);
    if (!e.unknown && unionKey !== null && !foreign) {
      var u = ah.mesh.union(unionKey, d.id, d.inbox, d.cursor, isOwn, now);
      if (u.state === 'unsure') { e.unknown = true; e.reason = 'store-unreadable'; e.reasonPath = null; e.reasonErrno = null; } // the store cannot be counted: unknown (the stricter reading)
      else if (u.state === 'ok') {
        ownStoreCounted = true;
        var allOwn = true, real = 0;
        // the partition's own identity family sent these: not inbound mail (the shared count of peek leaves them out too)
        var fam = pgSharedOn() && Array.isArray(u.family) ? u.family : [];
        var famHas = function (s) { return typeof s === 'string' && fam.indexOf(s) >= 0; };
        ndSenders.forEach(function (s) { if (famHas(s)) { e.realUnread -= 1; pgCountSuppressed('own_send'); } });
        u.storeOnly.forEach(function (row) {
          if (typeof row.body === 'string' && row.body.replace(/^\s+/, '').indexOf(ah.cfg('devswarm_role.pg_poke_prefix')) === 0) return;
          if (done && pgBroadcast(row)) return;
          if (famHas(row.sender)) { pgCountSuppressed('own_send'); return; }
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
    // the liveness verdict (readVerdict): its status and its own `pending` flag; a row of another project has none
    var verdictStatus = '';
    if (!foreign) {
      var lv = pgJson(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_liveness') + '/' + d.id + '.json');
      if (lv !== null && typeof lv === 'object' && typeof lv.status === 'string') { verdictStatus = lv.status; e.verdictPending = lv.pending === true; }
    }
    // the eligibility projection (row-eligibility.js `of`, liveness on, the cross-invocation app cache on)
    e.archived = pgMarkerArchived(home, d);
    var app = ah.mesh.appArchived(d.id, d.worktree, true);
    if (app.cache !== null) fx.cacheOwed = true;
    if (app.verdict !== null) e.appArchived = app.verdict;
    else {
      var rp = ah.fs.realpath(d.worktree);
      if (fresh !== null && ah.path.resolveAbs(rp === null ? d.worktree : rp).indexOf(ah.cfg('devswarm_role.pg_repos_root_marker')) >= 0) ah.unable('devswarm-parent-gate:active_cache'); // the supervisor's active-list cache is not consulted
      else if (fresh !== null && d.worktree.indexOf(ah.cfg('devswarm_role.pg_repos_root_marker')) >= 0) ah.unable('devswarm-parent-gate:active_cache');
      e.appArchived = false;
    }
    e.ignored = pgExists(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_archive_ignore') + '/' + d.id + '.json');
    if (d.session !== '') e.live = ah.mesh.sessionAlive(d.session); // unknown: taken as alive
    e.held = !isOwn && held.indexOf(d.id) >= 0;
    if (e.archived || e.appArchived || e.ignored) e.stateSkipped = true; // only a member of the Primary's own family could still need it (checked there)
    else if (d.id !== '' && d.session !== '' && d.worktree !== '') {
      var fresh_ms = pgSetNum('devswarm_role.pg_set_busy_fresh') * pgMin();
      var b = ah.mesh.childBusy(d.id, d.worktree, d.session, now, fresh_ms);
      if (b.none !== true) {
        e.waiting = b.waiting && e.live;
        e.waitingQ = e.waiting ? b.question : null;
        e.busy = b.busy && !e.waiting;
        e.idleKnown = b.seen === true && !b.busy && !b.waiting; // the transcript shows no turn in progress: nothing is left to send mail
      }
    }
    // a stale or escalated verdict drives a block only for a workspace with no proof of life: a fresh heartbeat, a done ruling, a running
    // session or an archive each clear the liveness axis alone (the mail axes are untouched)
    if (verdictStatus === ah.cfg('devswarm_role.pg_status_stale') || verdictStatus === ah.cfg('devswarm_role.pg_status_escalated')) {
      e.soe = !(pgFreshBeat(home, d.id, now) || done || e.live === true || e.archived || e.appArchived);
      e.status = e.soe ? verdictStatus : '';
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
    var unknownMembers = [], contributors = [], foreignAll = fam.members.length > 0, gone = false, allDoneOrIdle = true, allDone = true, guardBlocked = false;
    if (!famChild && fam.members.some(function (mi) { return entries[mi].stateSkipped; })) ah.unable('devswarm-parent-gate:archived_twin'); // an archived twin of the Primary's own row: listed with the family
    var famBusy = false, famWaiting = false, famAgeUnknown = false, famStoreOnly = false, famOldest = null, famUrgency = null;
    var famSoe = false, famStatus = '', famPending = false;
    for (var mj = 0; mj < fam.members.length; mj++) {
      var mi = fam.members[mj], m = entries[mi];
      if (m.held || (famChild && (m.archived || m.appArchived || m.ignored))) {
        if (m.realUnread > 0) archivedMemberUnread += m.realUnread;
        continue;
      }
      liveMembers += 1;
      if (!(m.done || (m.live && !m.busy && !m.waiting))) allDoneOrIdle = false;
      if (!m.done) allDone = false; // only the gate-proven done state (default: done, merged, tests_passed) makes a child safe to archive; idle proves nothing
      if (!m.done && m.session && pgGuardBlocked(home, m.session, now)) guardBlocked = true;
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
      if (m.soe) { famSoe = true; if (m.status !== '') famStatus = m.status; }
      if (m.verdictPending) famPending = true;
      if (m.urgency !== null && m.urgency !== undefined) famUrgency = m.urgency;
    }
    if (famChild && liveMembers === 0) {
      if (archivedMemberUnread > 0) archivedUnreadFamilies += 1;
      continue;
    }
    // a stale or escalated verdict is a block only when corroborated: the verdict's own pending flag, real unread mail, an unreadable
    // mailbox, or an unanswered question from a member of the family (never the status alone)
    if (famSoe) {
      var memberIds = fam.members.map(function (x) { return entries[x].id; });
      var askedByMember = unanswered.some(function (q) { return q && q.from !== null && q.from !== undefined && memberIds.indexOf(String(q.from)) >= 0; });
      if (!(famPending || union > 0 || unknown || askedByMember)) {
        fx.err += text.render(ah.cfg('devswarm_role.pg_err_uncorroborated'), { id: entries[fam.survivor].id, status: famStatus });
        famSoe = false;
        famStatus = '';
      }
    }
    // the busy downgrade and the fresh-mail grace window: a child family whose only reason to report is a plain backlog
    var busyStaleAgeMin = null;
    if (famChild && !unknown && !famSoe && union > 0) {
      if (fam.members.some(function (x) { return entries[x].ageOdd; })) ah.unable('devswarm-parent-gate:age_odd'); // a time only V8 reads: taken as the engine reads it
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
    if (!(unknown || union > 0 || famSoe)) continue;
    if (famWaiting && fam.members.some(function (x) { return entries[x].stateSkipped; })) ah.unable('devswarm-parent-gate:waiting_archived'); // the waiting members are listed by id, archived ones included
    blocking.push({
      id: entries[fam.survivor].id, unread: union, unknown: unknown, unknownMembers: unknownMembers, contributors: contributors,
      notOwnCountOnly: contributors.some(function (c) { return own.id !== c[0]; }), foreign: foreignAll, worktreeGone: gone,
      doneOrIdle: liveMembers > 0 && famChild && allDoneOrIdle, allDone: liveMembers > 0 && famChild && allDone, guardBlocked: famChild && guardBlocked, mergedTwins: fam.mergedTwins, waitingOnInput: famWaiting,
      waiting: fam.members.map(function (x) { return entries[x]; }).filter(function (x) { return x.waiting; }).map(function (x) { return [x.id, x.waitingQ]; }),
      busyStaleAgeMin: busyStaleAgeMin, urgency: famUrgency, status: famSoe ? famStatus : '',
    });
  }
  if (archivedUnreadFamilies > 0) fx.err += text.render(ah.cfg('devswarm_role.pg_err_archived_unread'), { n: String(archivedUnreadFamilies) });
  pgStray(home, sidRaw, selfKey, keyOf, now, fx);

  if (blocking.length === 0 && unanswered.length === 0 && !truncated && parked === null) {
    // a pass that only deferred unread mail keeps the loop state and skips the wake-coverage line; only a clean pass clears the state,
    // after the wake-coverage line (which needs a live child of this project) is known to be silent
    if (!busyAdvisoryHeld) {
      if (own.id !== null && pgWakeBlock(home, cwd, own.id, now, l, stateFile, stateRel, fx, entries)) return fx;
      fx.unlink = stateRel;
    }
    return fx;
  }

  // ---- the block: loop state, cap, escalation -----------------------------------------------------------------------
  var kinds = blocking.map(function (b) { return own.id === b.id ? ah.cfg('devswarm_role.pg_kind_mailbox') : ah.cfg('devswarm_role.pg_kind_children'); });
  if (parked !== null) kinds.push(ah.cfg('devswarm_role.pg_kind_parked')); // its arrival opens a fresh budget; its text never enters the signature
  kinds.sort();
  kinds = kinds.filter(function (k, i) { return i === 0 || k !== kinds[i - 1]; });
  var sig = ah.sha1(ah.cfg('devswarm_role.pg_sig_prefix') + kinds.join(','));
  var qField = String.fromCharCode(ah.cfgNum('devswarm_role.pg_q_sig_field_sep')), qRow = String.fromCharCode(ah.cfgNum('devswarm_role.pg_q_sig_row_sep'));
  var qSig = ah.sha1(unanswered.map(function (q) {
    return (q && q.from !== null && q.from !== undefined ? String(q.from) : '') + qField + (q && piFinite(q.ts) ? q.ts : '');
  }).sort().join(qRow));
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
  // the in-flight drain marker of this Primary (devswarm-drain-marker.js): a fresh one of this session turns the block into a stderr
  // notice and keeps the loop state unchanged; a stale one is removed and the gate goes on
  var drain = own.id !== null ? pgDrainMarker(home, own.id) : null;
  if (drain !== null && drain.stale) fx.drainClear = pgDrainRel(own.id);
  else if (drain !== null && drain.session !== '' && drain.session === (sidRaw === undefined || sidRaw === null ? '' : String(sidRaw))) {
    var keepQ = qSig === lastQSig;
    fx.write = { rel: stateRel, body: JSON.stringify({ sig: sig, blocks: effBlocks, escalated: effEscalated, qSig: qSig, qBlocks: keepQ ? qBlocks : 0,
      qEscalated: keepQ && qEscalated, intents: hasIntent ? pgOneKey(sig, intents[sig]) : {}, intentAcks: effAcks }) };
    var first = pgReason(blocking, own, null, hasIntent,
      { unanswered: unanswered, informational: informational, truncated: truncated, qEscalate: null, waiting: pgWaitingSeg(home, blocking) }).split('\n')[0];
    fx.err += (first.indexOf(ah.cfg('devswarm_role.pg_drain_tag')) >= 0 ? '' : ah.cfg('devswarm_role.pg_drain_prefix')) + first + ah.cfg('devswarm_role.pg_drain_suffix');
    pgCountSuppressed('drain');
    return fx;
  }
  // an unanswered question or a truncated question list bypasses the neglect cap; the question set has its own ceiling
  var bypassCap = unanswered.length > 0 || !!truncated;
  if (!bypassCap && effEscalated) { pgCountSuppressed('escalated_quiet'); return fx; } // already escalated once: quiet
  // every flagged child is held by anti-hall's own guard, not neglected by the Primary: a notice, no block, and nothing counted toward the
  // forced-acknowledgement cap or the escalation (the loop state is left as it is)
  if (!bypassCap && blocking.length > 0 && blocking.every(function (b) { return b.guardBlocked && own.id !== b.id; })) {
    fx.err += text.render(ah.cfg('devswarm_role.pg_guard_held'), { ids: pgListMore(blocking.map(function (b) { return b.id; }), ah.cfgNum('devswarm_role.pg_max_shown')) });
    pgCountSuppressed('guard_held');
    return fx;
  }
  var cap = ah.settings.num('devswarm_role.pg_set_cap');
  var nextBlocks = effBlocks + 1, nextEscalated = effEscalated, nextAcks = effAcks;
  var effQBlocks = qSig === lastQSig ? qBlocks : 0, effQEscalated = qSig === lastQSig && qEscalated;
  var nextQBlocks = effQBlocks, nextQEscalated = effQEscalated;
  var escalateTimes = null, qEscalateTimes = null;
  var nextIntents = hasIntent ? pgOneKey(sig, intents[sig]) : {};
  var stateBody = function (qb, qe) {
    return JSON.stringify({ sig: sig, blocks: nextBlocks, escalated: nextEscalated, qSig: qSig, qBlocks: qb, qEscalated: qe, intents: nextIntents, intentAcks: nextAcks });
  };
  if (!bypassCap) {
    var effCap = hasIntent ? cap * ah.cfgNum('devswarm_role.pg_intent_multiplier') : cap;
    if (hasIntent) nextAcks = effAcks + 1;
    if (effBlocks >= effCap) {
      if (own.id !== null && blocking.every(function (b) { return own.id === b.id; })) ah.unable('devswarm-parent-gate:conservation_hold'); // the limit-conservation hold is not applied: the escalation goes ahead (the stricter reading)
      escalateTimes = nextBlocks;
      nextEscalated = true;
    }
  } else if (!truncated && unanswered.length > 0) {
    if (effQEscalated) {
      // the question set already escalated once: quiet, the state kept
      fx.write = { rel: stateRel, body: stateBody(effQBlocks, true) };
      pgCountSuppressed('escalated_quiet');
      return fx;
    }
    nextQBlocks = effQBlocks + 1;
    if (effQBlocks >= cap) {
      qEscalateTimes = nextQBlocks;
      nextQEscalated = true;
    }
  }
  fx.write = { rel: stateRel, body: stateBody(nextQBlocks, nextQEscalated) };

  // the stale-build downgrade: a plain neglect block is dropped while the host registered a newer version
  if (blocking.length > 0 && !bypassCap && escalateTimes === null && qEscalateTimes === null && pgVersionStale(root)) { pgCountSuppressed('version_stale'); return fx; }
  var wake = pgWakeLine(own.id, l);
  var base = (blocking.length > 0 || unanswered.length > 0 || truncated)
    ? pgReason(blocking, own, escalateTimes, hasIntent,
      { unanswered: unanswered, informational: informational, truncated: truncated, qEscalate: qEscalateTimes, waiting: pgWaitingSeg(home, blocking) })
    : ah.cfg('devswarm_role.pg_reason_parked_only');
  var cli = dwEngineCmd('devswarm_role.engine_cli', ah.env.get(ah.cfg('env.home')) || '');
  var skip = text.render(ah.cfg('devswarm_role.pg_skip_cmd'), { cli: pgShQuote(cli), guard: ah.cfg('devswarm_role.gate_guard') });
  fx.out = JSON.stringify({ decision: ah.cfg('devswarm_role.pg_decision_block'), reason: pgFrame(base + (parked !== null ? ah.cfg('devswarm_role.pg_parked_joiner') + parked : '') + wake, skip) }) + '\n';
  pgCountFired(escalateTimes !== null || qEscalateTimes !== null ? 'escalation' : 'block');
  return fx;
}

// True when the child's session was last stopped by anti-hall's own coordinator-work-guard within pg_guard_block_window_ms (its window file
// keeps lastBlockAt): the child is held by the guard, not neglected by the Primary.
function pgGuardBlocked(home, sid, now) {
  if (typeof sid !== 'string' || sid === '') return false;
  var safe = sid.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfgNum('coordinator_work.session_id_max'));
  var f = pgJson(home + '/' + ah.cfg('script.write_root') + '/' + ah.cfg('coordinator_work.session_file_prefix') + safe + ah.cfg('guardkit.state_ext'));
  return jx.isObj(f) && piFinite(f.lastBlockAt) && f.lastBlockAt > 0 && now - f.lastBlockAt <= ah.cfgNum('devswarm_role.pg_guard_block_window_ms');
}

// `heldPartitionIdsFrom(env)`: the ids of `devswarm.heldPartitions` (comma separated, trimmed, empty parts dropped).
function pgHeldIds() {
  var v = ah.settings.str('devswarm_role.pg_set_held');
  if (typeof v !== 'string') return [];
  return v.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; });
}

// `hasFreshHeartbeat(id, home)`: the workspace's heartbeat (its `ts`, else the file's mtime) is positive, not in the future and within the
// freshness window: definitive proof of life.
function pgFreshBeat(home, id, now) {
  if (!pgSafeId(id)) return false;
  var file = pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_heartbeats') + '/' + id + '.json', ts = null;
  var beat = pgJson(file);
  if (beat !== null && typeof beat === 'object' && piFinite(beat.ts)) ts = beat.ts;
  else ts = ah.fs.mtimeMs(file);
  if (ts === null || !isFinite(ts) || ts <= 0 || ts > now) return false;
  return now - ts <= ah.cfgNum('devswarm_sup.lv_heartbeat_fresh_ms');
}

// `parkedEscalationSegment(home, parentId, cliPath)`: the escalation notices the supervisor could not deliver to this Primary (recovery.js
// escalation-pending/, one JSON file per child with `parentId` and `row`, `delivered` once it reached the mesh store), as one text; null
// when there are none for it.
function pgParkedSegment(home, parentId, cliPath) {
  if (parentId === null || parentId === undefined || parentId === '' || parentId === false || parentId === 0) return null;
  var dir = pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_escalation'), mine = [];
  (pgNames(dir) || []).forEach(function (n) {
    if (!/\.json$/.test(n)) return;
    var it = pgJson(dir + '/' + n);
    if (it && it.parentId && it.row && !it.delivered && String(it.parentId) === String(parentId)) mine.push(it);
  });
  if (mine.length === 0) return null;
  var kids = mine.map(function (i) { return i.childId; }).sort();
  return text.render(ah.cfg('devswarm_role.pg_parked_segment'), {
    n: String(mine.length), kids: kids.map(function (k) { return JSON.stringify(k); }).join(ah.cfg('devswarm_role.pg_parked_kid_sep')), id: String(parentId), cli: cliPath,
  });
}

// The waiting-on-input and busy-but-stale lines of the blocking families, as buildReason places them.
function pgWaitingSeg(home, blocking) {
  var seg = '';
  blocking.forEach(function (b) {
    if (b.waitingOnInput) {
      if (b.waiting.length === 0) seg += text.render(ah.cfg('devswarm_role.pg_waiting_line'), { title: pgTitle(home, b.id), q: '' });
      b.waiting.forEach(function (w) {
        var qs = w[1] !== null ? text.render(ah.cfg('devswarm_role.pg_waiting_q'), { q: w[1] }) : '';
        seg += text.render(ah.cfg('devswarm_role.pg_waiting_line'), { title: pgTitle(home, w[0]), q: qs });
      });
    }
    if (b.busyStaleAgeMin !== null) seg += text.render(ah.cfg('devswarm_role.pg_busy_stale_line'), { title: pgTitle(home, b.id), m: String(b.busyStaleAgeMin) });
  });
  return seg;
}

// `{ [k]: v }`.
function pgOneKey(k, v) { var o = {}; o[k] = v; return o; }

function pgDrainRel(id) { return ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_role.pg_dir_drain') + '/' + id + '.json'; }

// `readDrainMarker(home, id, { now })`: {stale, session} (session '' when the marker names none), or null (an unsafe id, a marker
// that cannot be read or parsed, or one without a finite start time).
function pgDrainMarker(home, id) {
  if (!pgSafeId(id)) return null;
  var m = pgJson(home + '/' + pgDrainRel(id));
  if (m === null || typeof m !== 'object' || !piFinite(m.startedAt)) return null;
  var age = ah.clock.now() - m.startedAt, ttl = pgSetNum('devswarm_role.pg_set_drain_ttl');
  return { stale: !(age >= 0 && age <= ttl), session: m.sessionId !== null && m.sessionId !== undefined ? String(m.sessionId) : '' };
}

// `emitStrayingAdvisory(home, sessionId, repoKeyOf, selfKey)`: the straying warnings of this project's children (devswarm-plan.js
// listStray) this Primary session was not shown yet, as one capped stderr line (devswarm-supervision.js strayingLine), and the shown
// set (stray-seen/<sha1(session)>.json, bounded) written once the gate settles. Advisory only: it never blocks.
function pgStray(home, sidRaw, selfKey, keyOf, now, fx) {
  if (!ah.settings.bool('devswarm_prompt.plan_tracking_setting')) return;
  var dir = pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_stray'), entries = [];
  (pgNames(dir) || []).forEach(function (n) {
    if (!/\.json$/.test(n)) return;
    var key = n.slice(0, -5);
    if (!pgSafeId(key)) return;
    var state = pgJson(dir + '/' + n);
    if (!jx.isObj(state) || !Array.isArray(state.active) || !state.active.length) return;
    // another project's child is skipped; an unresolvable worktree (null key) is kept
    var childKey = state.worktreePath ? keyOf(state.worktreePath) : null;
    if (selfKey && childKey && childKey !== selfKey) return;
    state.active.forEach(function (a) {
      var jevSeen = Array.isArray(a.jev) && a.jev.length ? ah.cfg('devswarm_role.pg_stray_seen_jev') : '';
      entries.push({ id: state.id, seenKey: a.key + ah.cfg('devswarm_role.pg_stray_seen_sep') + a.n + jevSeen, step: a.step, reason: a.reason, jev: a.jev });
    });
  });
  if (!entries.length) return;
  var sidText = String(sidRaw || ah.cfg('devswarm_role.pg_stray_no_session'));
  var rel = ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + ah.cfg('devswarm_role.pg_dir_stray_seen') + '/' + ah.sha1(sidText).slice(0, ah.cfgNum('devswarm_role.pg_stray_seen_hash_len')) + '.json';
  var seen = {}, sr = jx.read(home + '/' + rel);
  if (sr.big) ah.unable('devswarm-parent-gate:stray_seen_big'); // read as nothing seen
  if (sr.text !== undefined && !sr.big) {
    var j = jx.parse(sr.text);
    if (j.unsure) ah.unable('devswarm-parent-gate:stray_seen_unsure');
    else if (!j.invalid) seen = j.v || {};
  }
  var fresh = entries.filter(function (e) { return !seen[e.seenKey]; });
  if (!fresh.length) return;
  var max = ah.cfgNum('devswarm_role.pg_stray_line_max');
  var parts = fresh.slice(0, max).map(function (e) {
    var title = pgRawName(home, e.id) || e.id;
    var jevText = Array.isArray(e.jev) && e.jev.length
      ? ah.cfg('devswarm_role.pg_stray_jev_open') + e.jev.map(function (x) { return x.verdict + ' ' + Number(x.confidence).toFixed(2); }).join(ah.cfg('devswarm_role.pg_stray_join')) + ah.cfg('devswarm_role.pg_stray_jev_close')
      : '';
    return title + ah.cfg('devswarm_role.pg_stray_step') + e.step + ' ' + e.reason + jevText;
  });
  var more = fresh.length > max ? ah.cfg('devswarm_role.pg_stray_more_open') + (fresh.length - max) + ah.cfg('devswarm_role.pg_stray_more_close') : '';
  fx.err += ah.cfg('devswarm_role.pg_stray_head') + parts.join(ah.cfg('devswarm_role.pg_stray_join')) + more + ah.cfg('devswarm_role.pg_stray_tail') + '\n';
  // Node assigns into the parsed value in strict mode: a JSON primitive throws there, after the line, and nothing is written
  if (typeof seen !== 'object') return;
  var shownAt = ah.clock.now(); // Node reads the clock after printing the line
  fresh.forEach(function (e) { seen[e.seenKey] = shownAt; });
  var keys = Object.keys(seen), keep = ah.cfgNum('devswarm_role.pg_stray_seen_max');
  if (keys.length > keep) {
    keys.sort(function (a, b) { return seen[a] - seen[b]; });
    keys.slice(0, keys.length - keep).forEach(function (k) { delete seen[k]; });
  }
  fx.extra.push({ rel: rel, body: JSON.stringify(seen) });
}

// `readName(home, id)`: the cached display name of a workspace, or null.
function pgRawName(home, id) {
  if (typeof id !== 'string' || !pgSafeId(id)) return null;
  var v = pgJson(pgDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_names') + '/' + id + '.json');
  return v && typeof v.name === 'string' && v.name ? v.name : null;
}

// The clean pass's mailbox-wake block (`wakeCoverage` + `noWakePathLine`): a Claude Primary with a live child of this project, no live
// watcher and no recent cron tick is told to arm both, under its own loop-state signature and the same forced-acknowledgement cap,
// then quiet. True when it decided (a block written to `fx`, or the spent cap's quiet pass); false when nothing is missing.
function pgWakeBlock(home, cwd, ownId, now, l, stateFile, stateRel, fx, entries) {
  if (!pgSafeId(ownId)) return false; // wakeCoverage: an id it cannot use is "unknown"
  var raw = ah.env.get(ah.cfg('devswarm_role.agent_env'));
  if ((raw === null ? '' : raw.trim().toLowerCase()) !== ah.cfg('devswarm_role.claude_agent')) return false;
  var ctx = { home: home, now: now };
  var lc = piLiveChildren(ctx, cwd);
  if (!lc.known || !lc.live) return false;
  // only a child that can still send mail needs a wake path: a done (archive-ready) workspace, a waiting-on-human one and an idle one
  // (live session, not busy) do not count. A live child no descriptor names (found in the app database) stands when no row is known.
  var rows = (entries || []).filter(function (e) { return e.id !== ownId && !e.stateSkipped && !e.held; });
  if (rows.length > 0 && !rows.some(function (e) { return !e.done && !e.doneGate && !e.waiting && !e.idleKnown; })) return false;
  var tick = piJson(pgDir(home) + '/' + ah.cfg('devswarm_parent.dir_wake_tick') + '/' + ownId + '.json');
  var ageMin = tick && piFinite(tick.ts) ? Math.max(0, Math.floor((now - tick.ts) / ah.cfgNum('devswarm_prompt.ms_per_minute'))) : null;
  var warn = piSetDefault('devswarm_parent.set_cron_warn');
  if (!(ageMin === null || ageMin > warn)) return false;
  if (ah.settings.bool('wake_watch.set_enabled') === false) return false;
  if (piWatcherLive(home, ownId, now)) return false;
  var cron = text.render(ah.cfg('devswarm_parent.wake_cron_part'), { cron: dwWakeCron(), cli: l.cli, id: ownId });
  var wakeText = text.render(ah.cfg('devswarm_parent.wake_both'), { mon: text.render(ah.cfg('devswarm_parent.wake_monitor'), { watcher: l.watcher }), cron: cron });
  var wsig = ah.sha1(ah.cfg('devswarm_role.pg_sig_prefix') + ah.cfg('devswarm_role.pg_kind_wakepath'));
  var wblocks = 0, prevState = {};
  var prev = pgJson(stateFile);
  if (prev && typeof prev === 'object') prevState = prev;
  if (prev && prev.sig === wsig && Number.isFinite(prev.blocks)) wblocks = prev.blocks;
  if (wblocks >= ah.settings.num('devswarm_role.pg_set_cap')) return true; // the budget of this unchanged condition is spent: quiet
  var next = Object.assign({ qSig: '', qBlocks: 0, qEscalated: false, intents: {}, intentAcks: 0 }, prevState, { sig: wsig, blocks: wblocks + 1, escalated: false });
  fx.write = { rel: stateRel, body: JSON.stringify(next) };
  fx.out = JSON.stringify({ decision: ah.cfg('devswarm_role.pg_decision_block'), reason: wakeText }) + '\n';
  return true;
}

// `isStale(pluginRoot)` of hooks/lib/stop-version-gate.js.
function pgVersionStale(root) {
  var guard = ah.homeGuard();
  if (guard.status !== 'ok') { ah.unable('devswarm-parent-gate:version_home'); return false; } // no usable home: no newer build is known
  if (!ah.settings.bool('silent_nudge.version_gate_setting')) return false;
  var v = ah.plugin.versions(root);
  if (v.unsure) { ah.unable('devswarm-parent-gate:version_unsure'); return false; }
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
  return text.message('block', ah.cfg('devswarm_role.gate_guard'), {
    what: ah.cfg('devswarm_role.pg_headline'),
    instead: ah.cfg('devswarm_role.pg_short_instead'),
    override: skip + ah.cfg('devswarm_role.pg_skip_ttl'),
    extra: [body], details: true,
  });
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

// `buildReason` for the shapes the gate answers (no stale verdict). `q`: the unanswered and informational questions, the truncation
// record, the question escalation count (or null) and the waiting-on-input lines, placed as buildReason places them.
function pgReason(blocking, own, escalate, hasIntent, q) {
  var ownId = own.id;
  if (q.qEscalate !== null) {
    var who = q.unanswered.slice(0, ah.cfgNum('devswarm_role.pg_q_max_shown')).map(pgSender).join(ah.cfg('devswarm_role.pg_q_sep'));
    var what = q.truncated ? ah.cfg('devswarm_role.pg_q_escalation_truncated') : text.render(ah.cfg('devswarm_role.pg_q_escalation_from'), { who: who, more: pgQMore(q.unanswered) });
    return text.render(ah.cfg('devswarm_role.pg_q_escalation'), { what: what, times: String(q.qEscalate) });
  }
  var lead = (q.truncated ? pgTruncatedSeg(q.truncated) : '') + (q.unanswered.length > 0 ? pgUnansweredSeg(q.unanswered) : '') + pgInformationalSeg(q.informational) + q.waiting;
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
    if (b.status !== '') bits.push(b.status);
    // the provenance of the Primary's own count: re-read live, or the summary cache
    if (isOwn(b.id) && own.source !== null && !b.notOwnCountOnly) bits.push(ah.cfg(own.source === 'live' ? 'devswarm_role.pg_live_resolved' : 'devswarm_role.pg_cached'));
    return b.id + (isOwn(b.id) ? you : '') + ' (' + bits.join(', ') + ')';
  }).join('; ');
  var more = blocking.length > max ? text.render(ah.cfg('devswarm_role.pg_and_more'), { n: String(blocking.length - max) }) : '';
  var stable = blocking.slice(0, max).map(function (b) { return b.id + (isOwn(b.id) ? you : ''); }).join('; ');
  var flagged = blocking.filter(function (b) { return !isOwn(b.id) && !b.foreign; });
  if (escalate !== null) {
    return lead + text.render(ah.cfg('devswarm_role.pg_escalation'), {
      shown: stable + more, times: String(escalate), intent: hasIntent ? ah.cfg('devswarm_role.pg_escalation_intent') : '',
      archive: flagged.length > 0 && flagged.every(function (b) { return b.allDone; }) ? ah.cfg('devswarm_role.pg_escalation_archive')
        : flagged.some(function (b) { return b.doneOrIdle && !b.allDone; }) ? ah.cfg('devswarm_role.pg_escalation_idle') : '',
    });
  }
  var ownEntry = null;
  for (var i = 0; i < blocking.length; i++) if (isOwn(blocking[i].id) && (blocking[i].unread > 0 || blocking[i].unknown)) { ownEntry = blocking[i]; break; }
  var anyChild = blocking.some(function (b) { return (b.unread > 0 || b.unknown) && !isOwn(b.id) && !b.foreign; });
  var body = lead + (blocking.length > 0 ? text.render(ah.cfg('devswarm_role.pg_neglect'), { n: String(blocking.length), shown: shown, more: more }) : '');
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
  if (own.unknown) body += text.render(ah.cfg(own.stale ? 'devswarm_role.pg_own_stale' : 'devswarm_role.pg_own_unknown'), { id: ownId === null ? '' : ownId });
  // the Primary's own mail, with the urgent prefix for an urgent or high summary urgency
  else if (ownEntry !== null && ownEntry.unread > 0) {
    var urgent = ah.cfg('devswarm_role.pg_urgent_levels').indexOf(ownEntry.urgency) >= 0;
    body += (urgent ? ah.cfg('devswarm_role.pg_urgent_prefix') : '') + text.render(ah.cfg('devswarm_role.pg_own_unread'), { n: String(ownEntry.unread), id: ownId });
  }
  if (ownEntry !== null && ownEntry.mergedTwins.length > 0) {
    var tw = ownEntry.mergedTwins;
    var list = tw.slice(0, max).join('; '), moreT = tw.length > max ? text.render(ah.cfg('devswarm_role.pg_twin_more'), { n: String(tw.length - max) }) : '';
    body += text.render(ah.cfg('devswarm_role.pg_twins'), { n: String(tw.length), s: tw.length === 1 ? '' : ah.cfg('devswarm_role.pg_plural_s'), list: list + moreT });
  }
  var foreign = blocking.filter(function (b) { return b.foreign && !isOwn(b.id); }).map(function (b) { return b.id; });
  if (foreign.length > 0) body += text.render(ah.cfg('devswarm_role.pg_foreign'), { ids: pgListMore(foreign, max), verb: foreign.length === 1 ? ah.cfg('devswarm_role.pg_verb_is') : ah.cfg('devswarm_role.pg_verb_are') });
  var gone = blocking.filter(function (b) { return b.worktreeGone && !b.foreign; }).map(function (b) { return b.id; });
  if (gone.length > 0) body += text.render(ah.cfg('devswarm_role.pg_gone'), { ids: pgListMore(gone, max), verb: gone.length === 1 ? ah.cfg('devswarm_role.pg_verb_has') : ah.cfg('devswarm_role.pg_verb_have') });
  var heldByGuard = blocking.filter(function (b) { return b.guardBlocked && !isOwn(b.id); }).map(function (b) { return b.id; });
  if (heldByGuard.length > 0) body += text.render(ah.cfg('devswarm_role.pg_guard_held'), { ids: pgListMore(heldByGuard, max) });
  if (anyChild) body += ah.cfg('devswarm_role.pg_inspect');
  if (blocking.some(function (b) { return b.status === ah.cfg('devswarm_role.pg_status_stale') || b.status === ah.cfg('devswarm_role.pg_status_escalated'); })) body += ah.cfg('devswarm_role.pg_stale_note');
  return body + ah.cfg('devswarm_role.pg_tail');
}

// ---- the entry ---------------------------------------------------------------------------------------------------------

// Apply what the gate decided.
function pgApply(fx) {
  if (fx.err) fx.err = text.message('warn', ah.cfg('devswarm_role.gate_guard'), {
    what: ah.cfg('devswarm_role.pg_warning_what'), instead: ah.cfg('devswarm_role.pg_warning_instead'),
    extra: [fx.err], details: true,
  }, 'warnings') + '\n';
  if (fx.unlink !== null || fx.write !== null || fx.extra.length || fx.cacheOwed || fx.drainClear !== null) ah.commit();
  if (fx.drainClear !== null) ah.state.remove(fx.drainClear); // clearDrainMarker, best-effort
  // the advisory writes are best-effort, as Node's (a failed write shows the line again next Stop)
  fx.extra.forEach(function (w) { ah.state.writeAtomic(w.rel, w.body); });
  if (fx.unlink !== null) ah.state.remove(fx.unlink);
  if (fx.write !== null && !ah.state.writeAtomic(fx.write.rel, fx.write.body)) {
    // Node: `catch (_) { return; }` -- nothing printed on stdout
    return fx.err === '' ? 'allow' : { exact: { code: 0, out: '', err: fx.err } };
  }
  if (fx.cacheOwed) ah.mesh.performCache();
  return fx.out === '' && fx.err === '' ? 'allow' : { exact: { code: 0, out: fx.out, err: fx.err } };
}

function decide(p, opts, event) {
  if (event !== 'Stop') return 'allow'; // this gate answers Stop only
  if (dwJudgeChild()) return 'allow';
  if (dwUsableHome() !== null) {
    if (!ah.settings.bool('devswarm_role.sw_parent_gate')) return 'allow';
    if (ah.settings.skipped(ah.cfg('devswarm_role.gate_guard'))) return 'allow';
    if (!dwActive() || dwNonBlank(ah.cfg('devswarm_role.branch_env'))) return 'allow';
  }
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
  var l = dwLaunchersNative(root, true);
  if (l === null) { ah.unable('devswarm-parent-gate:no_launchers', 'abandoned'); return 'allow'; } // no usable home or plugin root: no launcher can be named
  if (!jx.isObj(p)) { ah.unable('devswarm-parent-gate:payload_shape'); p = {}; }
  if (p[ah.cfg('devswarm_gates.readside_stop_field')] === true) return 'allow';
  return pgApply(pgGate(p, root, l));
}
