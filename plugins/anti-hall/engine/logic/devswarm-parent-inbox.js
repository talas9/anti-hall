// check = "devswarm-parent-inbox" (UserPromptSubmit). Mirrors hooks/devswarm-parent-inbox.js. It answers every case where Node prints and
// writes nothing (a Jev judge child, a child workspace, the integration killed or switched off, DevSwarm inactive) and, for an active
// Primary with or without a git checkout, the turn the hook would make: the communication-override reminder through the emit-dedupe store;
// the ingest-daemon fault and stale banners; the summary refresh while that daemon is not running; the mailbox-wake line over the
// workspace descriptors and the DevSwarm app database; the session-drift notice and the maintainer-notice feed; the live workspace table
// of the project's summary (archive markers and the archive gate, the app's verdict, heartbeat/transcript/verdict activity, dormant and
// idle-alive, the finish cell with the step plan, token burn and straying, the app's title, rank, pin, focus and brief markers); the
// urgent and normal unread nudges with grace, trend and the not-draining / stale-build labels; the archive recommendation with its
// cooldown and the supervisor's auto-archive record; the orphaned-mesh, stale-registry and broadcast segments; the Primary's own inbox
// with the questions it was asked (reply records, identity families, retired senders, live askers); the screenshot-sync ask and the
// app-still-open note; and the supervisor escalations parked for this Primary. What this script cannot settle exactly is decided natively
// and counted (native_unable at devswarm-parent-inbox:*, logged with its cause under devswarm_parent.defer_log_kind): a seat conflict
// still owed its repeat, a seat or identity it cannot resolve, a summary that is empty or unreadable, and a mesh answer or setting the host
// cannot give exactly add nothing that turn; the owner's held partitions, a row the supervisor's auto-archive owns, the Jev labels of the
// broadcast feed and the reader-identity correction are not applied. Keys and texts:
// small_guards.toml (devswarm_prompt.*), devswarm_parent.toml, mesh_write.toml (the plan labels).
'use strict';

// ---- shared small readers ----------------------------------------------------------------------------------------------

// The text of the session id, or null (`typeof payload.session_id === 'string' && payload.session_id`).
function dpSession(p) {
  return jx.isObj(p) && typeof p.session_id === 'string' && p.session_id !== '' ? p.session_id : null;
}

// The seat-conflict marker of the session: 'none' (nothing to repeat), or 'repeat' (Node must check the seat again and rewrite it).
function dpSeatMarker(home, sid) {
  var file = home + '/' + ah.cfg('paths.base_dir') + '/' + ah.cfg('devswarm_prompt.seat_dir') + '/' + sid.replace(/[^A-Za-z0-9_-]/g, '') + '.json';
  var raw = ah.fs.readText(file);
  if (raw === null) return 'none';
  var mark;
  try { mark = JSON.parse(raw); } catch (e) { return 'none'; }
  if (!mark) return 'none';
  return Number(mark.shown) < ah.cfgNum('devswarm_prompt.seat_shown_max') ? 'repeat' : 'none';
}

// A turn this script cannot settle exactly adds nothing (an advisory, repeated on the next prompt): counted (native_unable) and logged with its cause.
function piDefer(why) {
  ah.unable('devswarm-parent-inbox:' + String(why).split(':')[0]);
  ah.log(ah.cfg('devswarm_parent.defer_log_kind'), why);
  return 'allow';
}

function piDevswarmDir(home) { return home + '/' + ah.cfg('devswarm_role.pg_devswarm_dir'); }
function piRel(rest) { return ah.cfg('devswarm_role.pg_devswarm_dir') + '/' + rest; }

// `isSafeId` of companion/lib/liveness.js.
function piSafeId(id) {
  return typeof id === 'string' && id !== '' && id !== '.' && id !== '..' && id.indexOf('..') < 0 && /^[A-Za-z0-9._-]+$/.test(id);
}

// `JSON.parse(readFileSync(p))` inside Node's try/catch: null for a file that cannot be read or does not parse; a file over the read cap
// or a parse the interpreter cannot finish counts as unreadable (counted).
function piJson(p) {
  var r = jx.read(p);
  if (r.big) { ah.unable('devswarm-parent-inbox:json_big'); return null; }
  if (r.text === undefined) return null;
  var j = jx.parse(r.text);
  if (j.unsure) { ah.unable('devswarm-parent-inbox:json_unsure'); return null; }
  return j.invalid ? null : j.v;
}

// The sorted names in a directory; null when it is not one. A directory too big to list reads as empty (counted).
function piNames(dir) {
  var n = ah.fs.readdir(dir);
  if (n === null && ah.fs.isDir(dir)) { ah.unable('devswarm-parent-inbox:listing_big'); return []; }
  return n;
}

// Whether a path exists the way `existsSync`-style probes see it: a link that dangles does not.
function piPresent(p) {
  var st = ah.fs.lstat(p);
  return !(st === null || (st.kind === 'link' && ah.fs.realpath(p) === null));
}

// A summary or descriptor field read with JavaScript truthiness as a string: a non-empty string, null for a falsy value; another type is its text (counted).
function piStrField(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0 || (typeof v === 'number' && isNaN(v))) return null;
  if (typeof v === 'string') return v;
  ah.unable('devswarm-parent-inbox:field_shape');
  return String(v);
}

function piFinite(v) { return typeof v === 'number' && isFinite(v); }

// ---- the CLI path and the parked escalations --------------------------------------------------------------------------

// The CLI path the reminders name: the stable launcher when that is switched on and installed, else the plugin's own script (`preferStableLauncher`).
// null when the plugin root cannot be resolved the way Node's `__dirname` would be.
function piCli(opts, home) {
  return dwEngineCmd('devswarm_role.engine_cli', home);
}

// `listEscalationIntents` + `parkedEscalationSegment(home, parentId, cli)`: the supervisor's escalations parked for this Primary, or null.
function piParked(home, primaryId, cli) {
  var dir = piDevswarmDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_escalation');
  var names = piNames(dir);
  if (names === null) return null;
  var mine = [];
  names.forEach(function (n) {
    if (!/\.json$/.test(n)) return;
    var it = piJson(dir + '/' + n);
    if (!it || !it.parentId || !it.row || it.delivered) return;
    if (typeof it.parentId !== 'string') { ah.unable('devswarm-parent-inbox:parent_id_shape'); return; } // another type matches no Primary id
    if (it.parentId === primaryId) mine.push(it);
  });
  if (!mine.length) return null;
  var kids = mine.map(function (i) { return typeof i.childId === 'string' ? i.childId : String(i.childId); }).sort();
  return text.render(ah.cfg('devswarm_parent.escalation_banner'), { count: mine.length, kids: kids.map(function (k) { return JSON.stringify(k); }).join(', '), parent: primaryId, cli: cli });
}

// ---- time and the numbers of the text -----------------------------------------------------------------------------------

// `formatRelative(ts, now)` of the hook: a compact age, the none-word for an unknown time; a future time reads as 0.
function piRelative(ts, now) {
  if (!piFinite(ts) || ts <= 0) return ah.cfg('devswarm_parent.relative_none');
  var delta = now - ts;
  if (delta < 0) delta = 0;
  var s = Math.floor(delta / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

// `names.shortId(id)` and `names.displayName(id, name)`.
function piShortId(id) {
  var s = typeof id === 'string' ? id : String(id == null ? '' : id);
  return s.length > ah.cfgNum('devswarm_role.pg_short_id_len') ? s.slice(0, ah.cfgNum('devswarm_role.pg_short_id_len')) : s;
}
function piDisplayName(id, name) {
  if (typeof name === 'string' && name) return name + ' (' + piShortId(id) + ')';
  return String(id == null ? '' : id);
}
// `names.readName(home, id)`: the cached title of a workspace, or null.
function piReadName(home, id) {
  if (!piSafeId(id)) return null;
  var v = piJson(piDevswarmDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_names') + '/' + id + '.json');
  return v !== null && typeof v === 'object' && typeof v.name === 'string' && v.name ? v.name : null;
}

function piTruncate(s, max) {
  var str = String(s == null ? '' : s);
  var limit = max || ah.cfgNum('devswarm_parent.title_max');
  return str.length > limit ? str.slice(0, limit) + '…' : str;
}

// A setting the hook reads: its value along the settings chain (the shipped default when nothing sets it).
function piSetDefault(key) { return typeof ah.cfg(key).default === 'boolean' ? ah.settings.bool(key) : ah.settings.num(key); }

// ---- labels, the finish cell and the markers ---------------------------------------------------------------------------

function piLabel(name) { return ah.cfg('devswarm_parent.labels')[name]; }

// `displayStatus(archiveReady, status, activityTs, now, dormant, notDraining, idleAlive)`.
function piDisplayStatus(archiveReady, status, activityTs, now, dormant, notDraining, idleAlive, idleMs) {
  if (status === 'escalated' && !idleAlive) return piLabel('escalated');
  if ((status === 'stale' || status === 'nudged') && !idleAlive) return piLabel('stale');
  if (notDraining) return piLabel('not_draining');
  if (archiveReady) return piLabel('archive_ready');
  if (idleAlive) return piLabel('idle_alive');
  if (dormant) return piLabel('dormant');
  if (piFinite(activityTs) && piFinite(now) && (now - activityTs) >= idleMs) return piLabel('idle');
  return piLabel('active');
}

// `doneStateLabel(summary, id, heartbeat)`.
function piDoneState(entry, heartbeat) {
  var gates = entry && entry.gates && typeof entry.gates === 'object' ? entry.gates : {};
  var doneReported = !!(entry && (gates.done === true || entry.archive_ready === true));
  if (doneReported) {
    if (entry && entry.mergedVerified === true) return ah.cfg('devswarm_parent.done_merged');
    if (entry && entry.mergedVerified === false) return ah.cfg('devswarm_parent.done_not_merged');
    return ah.cfg('devswarm_parent.done_unverified');
  }
  var pct = heartbeat && piFinite(heartbeat.progress_pct) ? heartbeat.progress_pct : null;
  return pct !== null ? text.render(ah.cfg('devswarm_parent.working_pct'), { pct: pct }) : ah.cfg('devswarm_parent.working');
}

// `riskMarker(r)`.
function piRisk(r) {
  var parts = [];
  if (r.noUpstream) parts.push(ah.cfg('devswarm_parent.risk_local_only'));
  else if (piFinite(r.unpushed) && r.unpushed > 0) parts.push(text.render(ah.cfg('devswarm_parent.risk_unpushed'), { n: r.unpushed }));
  if (r.label === piLabel('archive_ready').label && r.mergedVerified !== true) parts.push(ah.cfg('devswarm_parent.risk_merged_unverified'));
  return parts.length ? ' ' + parts.join(', ') : '';
}

// `appRowMarkers(ws, brief, focused)`.
function piAppMarks(ws, brief, focused) {
  var parts = [];
  if (ws && ws.isPinned) parts.push(ah.cfg('devswarm_parent.mark_pinned'));
  if (focused) parts.push(ah.cfg('devswarm_parent.mark_on_screen'));
  if (brief === ah.cfg('devswarm_parent.brief_not_delivered')) parts.push(ah.cfg('devswarm_parent.mark_brief_not_delivered'));
  if (brief === ah.cfg('devswarm_parent.brief_withheld')) parts.push(ah.cfg('devswarm_parent.mark_brief_withheld'));
  return parts.length ? ' [' + parts.join(', ') + ']' : '';
}

// `buildWorkspaceTable(rows, now, capped, hidden, hiddenRows, archivedHidden)`.
function piTable(rows, now, capped, hidden, hiddenRows, archivedHidden, maxRows) {
  var lines = [ah.cfg('devswarm_parent.table_head')];
  rows.forEach(function (r) {
    var workspaceCol = piDisplayName(r.id, r.wsName).replace(/\|/g, '\\|') + piRisk(r) + (r.appMarks || '');
    lines.push(text.render(ah.cfg('devswarm_parent.table_row'), { workspace: workspaceCol, label: r.label, finish: r.finish, unread: r.unread, last: piRelative(r.lastActivityTs, now) }));
  });
  if (rows.some(function (r) { return r.label === piLabel('dormant').label; })) lines.push(ah.cfg('devswarm_parent.legend_dormant'));
  if (rows.some(function (r) { return r.label === piLabel('not_draining').label; })) lines.push(ah.cfg('devswarm_parent.legend_not_draining'));
  if (capped) {
    var overflow = text.render(ah.cfg('devswarm_parent.overflow'), { hidden: hidden, max: maxRows });
    if (Array.isArray(hiddenRows) && hiddenRows.length) {
      var named = ah.cfgNum('devswarm_parent.overflow_named_max');
      var ids = hiddenRows.slice(0, named).map(function (r) { return piShortId(r.id); });
      overflow += text.render(ah.cfg('devswarm_parent.overflow_ids'), { ids: ids.join(', ') + (hiddenRows.length > named ? ah.cfg('devswarm_parent.overflow_ids_more') : '') });
    }
    lines.push(overflow);
  }
  if (piFinite(archivedHidden) && archivedHidden > 0) lines.push(text.render(ah.cfg('devswarm_parent.archived_hidden'), { n: archivedHidden }));
  return lines.join('\n');
}

// `normalizeTableAges`: the volatile cells of a table row are dropped before the text is hashed.
function piNormTable(t) {
  // the dormant legend appears with an activity-only label, so it is dropped with the label
  return String(t).split('\n').filter(function (l) { return l !== ah.cfg('devswarm_parent.legend_dormant'); }).map(function (l) {
    return /^\|.*\|\s*$/.test(l)
      ? l.replace(/\|[^|]*\|\s*$/, '| |').replace(/\|\s*\d+\s*\|\s*\|\s*$/, '| | |').replace(/ · \d+[mhd](?= · (?:progress|no progress))/g, '').replace(/ · progress \d+[mhd] ago/g, '')
        .replace(/ · [\d.]+[kM]? tok\b/g, '')
        .replace(new RegExp(ah.cfg('devswarm_parent.re_table_activity_label')), '$1' + ah.cfg('devswarm_parent.table_activity_token') + '$2')
      : l;
  }).join('\n');
}

// `normalizeInboxVolatile`: the oldest age and the trend of the nudge are dropped before the text is hashed.
function piNormInbox(t) {
  return String(t).replace(/, oldest (?:—|\d+[smhd])/g, '').replace(/, (?:rising|flat|falling)\)/g, ')');
}

// ---- the acceptance log and the unread trend ----------------------------------------------------------------------------

// `lastInjectedUnread(home, id)`: the unread count of `id` in the newest 'inject' line of the log, or null.
function piLastInjected(home, id) {
  var p = piDevswarmDir(home) + '/' + ah.cfg('devswarm_parent.file_log');
  var size = ah.fs.size(p);
  if (size === null || size === 0 || size > ah.cfgNum('devswarm_parent.trend_log_max_bytes')) return null;
  var raw = ah.fs.readText(p, size);
  if (raw === null) { ah.unable('devswarm-parent-inbox:trend_log'); return null; }
  var lines = raw.split('\n');
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i];
    if (!line) continue;
    var rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }
    if (!rec || rec.event !== 'inject' || !Array.isArray(rec.workspaces)) continue;
    var w = null;
    for (var j = 0; j < rec.workspaces.length; j++) if (rec.workspaces[j] && rec.workspaces[j].id === id) { w = rec.workspaces[j]; break; }
    if (w && piFinite(w.unread)) return w.unread;
  }
  return null;
}

function piTrend(home, id, curr) {
  var prev = piLastInjected(home, id);
  if (!piFinite(prev)) return null;
  if (curr > prev) return ah.cfg('devswarm_parent.rising');
  if (curr < prev) return ah.cfg('devswarm_parent.falling');
  return ah.cfg('devswarm_parent.flat');
}

// ---- the nudge segments -------------------------------------------------------------------------------------------------

function piStuck(status) { return !!status && ah.cfg('devswarm_parent.stuck_statuses').indexOf(status) >= 0; }
function piHigh(u) { return ah.cfg('devswarm_parent.high_urgencies').indexOf(u) >= 0; }

// The heal sweep's dead-row hint for a row (GH #508): true when the hint is set and no live evidence beats it. The hint is a guess from
// repeated "worktree missing" sightings, never an archive: the worktree back, a heartbeat newer than the hint, mail newer than it (the
// row's total grew) or high/urgent mail each win, and are counted (shown_despite_hint). An unreadable hint is no hint (fail visible).
function piDeadHint(home, id, wtPath, total, urgencyMax) {
  if (!piSafeId(id)) return false;
  var dir = piDevswarmDir(home) + '/';
  var h = piJson(dir + ah.cfg('devswarm_parent.dead_hint_dir') + '/' + id + '.json');
  if (!jx.isObj(h) || !piFinite(h.setAt) || (h.clearedAt !== undefined && h.clearedAt !== null)) return false;
  var hb = piJson(dir + ah.cfg('mesh_write.dir_heartbeats') + '/' + id + '.json');
  var live = (wtPath && piPresent(wtPath)) || (jx.isObj(hb) && piFinite(hb.ts) && hb.ts > h.setAt)
    || (piFinite(total) && piFinite(h.totalAtSet) && total > h.totalAtSet) || (urgencyMax !== null && piHigh(urgencyMax));
  if (live) { ah.metric('devswarm_dead_row_hint', ['event', 'shown_despite_hint']); return false; }
  return true;
}

// `tierOf(w)`.
function piTier(w) {
  if (!(w.unread > 0)) return 'normal';
  if (piHigh(w.urgencyMax)) return 'urgent';
  if (piStuck(w.status)) return 'normal';
  if (w.urgencyMax === ah.cfg('devswarm_parent.low_urgency')) return 'low';
  return 'normal';
}

// `buildUnreadSegment(list, home)`.
function piUnreadSegment(list, home, cli, now) {
  var max = ah.cfgNum('devswarm_parent.max_listed');
  var shown = list.slice(0, max).map(function (w) {
    var title = piTruncate(piDisplayName(w.id, w.wsName));
    var parts = [];
    if (w.unread > 0) parts.push(text.render(ah.cfg('devswarm_parent.part_unread'), { n: w.unread }));
    if (piStuck(w.status)) parts.push(w.status);
    if (w.staleAntiHallMessage) parts.push(w.staleAntiHallMessage);
    else if (w.notDraining) parts.push(ah.cfg('devswarm_parent.part_not_draining'));
    if (piFinite(w.oldestUnreadTs)) parts.push(text.render(ah.cfg('devswarm_parent.part_oldest'), { age: piRelative(w.oldestUnreadTs, now) }));
    var trend = piTrend(home, w.id, w.unread);
    if (trend) parts.push(trend);
    return parts.length ? text.render(ah.cfg('devswarm_parent.unread_title_parts'), { title: title, parts: parts.join(ah.cfg('devswarm_parent.part_joiner')) }) : title;
  });
  var extra = list.length > max ? text.render(ah.cfg('devswarm_parent.unread_extra'), { n: list.length - max }) : '';
  var anyUnread = list.some(function (w) { return w.unread > 0; });
  var body = text.render(ah.cfg('devswarm_parent.unread_head'), { count: list.length, shown: shown.join(ah.cfg('devswarm_parent.shown_joiner')), extra: extra });
  body += anyUnread ? text.render(ah.cfg('devswarm_parent.unread_body_drain'), { cli: cli }) : ah.cfg('devswarm_parent.unread_body_read');
  body += ah.cfg('devswarm_parent.unread_tail');
  return body;
}

// `buildUrgentUnreadSegment(list, home)`.
function piUrgentSegment(list, home, cli) {
  var max = ah.cfgNum('devswarm_parent.max_listed');
  var shown = list.slice(0, max).map(function (w) {
    var parts = [text.render(ah.cfg('devswarm_parent.part_unread'), { n: w.unread })];
    if (piStuck(w.status)) parts.push(w.status);
    if (w.staleAntiHallMessage) parts.push(w.staleAntiHallMessage);
    else if (w.notDraining) parts.push(ah.cfg('devswarm_parent.part_not_draining'));
    var trend = piTrend(home, w.id, w.unread);
    if (trend) parts.push(trend);
    return text.render(ah.cfg('devswarm_parent.urgent_part'), { id: w.id, parts: parts.join(ah.cfg('devswarm_parent.part_joiner')) });
  });
  var extra = list.length > max ? text.render(ah.cfg('devswarm_parent.unread_extra'), { n: list.length - max }) : '';
  return text.render(ah.cfg('devswarm_parent.urgent_head'), { count: list.length, shown: shown.join(ah.cfg('devswarm_parent.shown_joiner')), extra: extra, cli: cli });
}

// `buildArchiveSegment(ids)`.
function piArchiveSegment(ids, cli) {
  var max = ah.cfgNum('devswarm_parent.max_listed');
  var extra = ids.length > max ? text.render(ah.cfg('devswarm_parent.archive_extra'), { n: ids.length - max }) : '';
  return text.render(ah.cfg('devswarm_parent.archive_head'), { shown: ids.slice(0, max).join(ah.cfg('devswarm_parent.archive_ids_joiner')), extra: extra, cli: cli });
}

// ---- the ingest-daemon banner -------------------------------------------------------------------------------------------

// `normalizeStaleBanner` / `normalizeMonitorFaultBanner`: the age is bucketed (or masked) before the text is hashed, so a banner that only grew older is a repeat.
function piNormStale(t) {
  return String(t).replace(/last alive (—|\d+)([smhd]?) ago/, function (m, n, u) {
    var tier = 'unknown';
    if (u) {
      var v = Number(n);
      if (u === 's' || (u === 'm' && v < 15)) tier = 't0';
      else if (u === 'm') tier = 't1';
      else if (u === 'h') tier = v < 6 ? 't2' : 't3';
      else tier = 't4';
    }
    return 'last alive ' + tier + ' ago';
  });
}
function piNormFault(t) {
  return String(t).replace(/(—|\d+[smhd]?) ago/g, 'N ago').replace(/\d+x in a row/g, 'Nx in a row');
}

// `formatRelative(ts, now)` of companion/lib/ingest-health.js.
function piIngestRelative(ts, now) {
  if (typeof ts !== 'number' || !isFinite(ts) || ts <= 0) return ah.cfg('devswarm_prompt.relative_none');
  var secs = Math.floor(Math.max(0, now - ts) / 1000);
  if (secs < 60) return secs + 's';
  var mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm';
  var hours = Math.floor(mins / 60);
  return hours < 24 ? hours + 'h' : Math.floor(hours / 24) + 'd';
}

// `launchdDisabledLabel(repoKey)`: the label of this project's ingest job when launchd lists it disabled (macOS only; never under a test).
function piDisabledLabel(key) {
  if (ahHost.platform() !== ah.cfg('devswarm_prompt.launchd_platform') || !key) return null;
  var marks = ah.cfg('devswarm_prompt.test_markers');
  for (var i = 0; i < marks.length; i++) if (ah.env.get(marks[i])) return null;
  var r = ah.exec('launchctl', ah.cfg('devswarm_prompt.launchctl_args').map(function (a) { return a.replace('{uid}', String(ah.uid())); }), { timeoutMs: ah.cfgNum('devswarm_prompt.launchctl_timeout_ms') });
  if (r === null || r.status !== 0 || r.truncated) return null;
  var label = ah.cfg('devswarm_prompt.launchd_label_prefix') + key;
  var esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('"' + esc + '"\\s*=>\\s*(?:disabled|true)\\b').test(r.stdout) ? label : null;
}

// The ingest-daemon banner state of this turn, as the hook's two `*BannerOnce` calls leave it: the dedupe records to consult (`fault`, `stale`)
// and the keys to forget. A hand-over in progress (a fresh heartbeat of a live lock) says nothing.
function piIngest(h, key, now, sid, tp) {
  var res = { fault: null, stale: null, forgetFault: false, forgetStale: false };
  var base = { sessionId: sid, transcriptPath: tp, keepaliveTurns: ah.cfgNum('devswarm_prompt.banner_keepalive') };
  if (h.status === 'failed') {
    var f = h.fault, what;
    var rel = function (t) { return piIngestRelative(t, now); };
    if (f.noOkSinceStart) what = text.render(ah.cfg('devswarm_prompt.fault_no_ok'), { rel: rel(f.startedAtMs) });
    else if (f.okStale) what = text.render(ah.cfg('devswarm_prompt.fault_ok_stale'), { rel: rel(f.lastOkMs) });
    else what = text.render(ah.cfg('devswarm_prompt.fault_failing'), { n: typeof f.consecutive === 'number' && isFinite(f.consecutive) ? f.consecutive : '?' });
    var err = f.error ? text.render(ah.cfg('devswarm_prompt.fault_error'), { error: String(f.error).slice(0, ah.cfgNum('devswarm_prompt.fault_error_max')) }) : '';
    var o = Object.assign({}, base, { key: ah.cfg('devswarm_prompt.fault_key'), normalize: piNormFault });
    o.content = text.render(ah.cfg(f.code ? 'devswarm_prompt.fault_config' : 'devswarm_prompt.fault_banner'), { beat: rel(f.heartbeatTs), what: what, err: err, code: f.code || '' });
    res.fault = o;
    return res;
  }
  res.forgetFault = true;
  if (h.status !== 'stale') { res.forgetStale = true; return res; }
  var beatTs = typeof h.beatTs === 'number' && isFinite(h.beatTs) ? h.beatTs : null;
  if (beatTs !== null && now - beatTs < ah.cfgNum('devswarm_prompt.banner_grace_ms') && h.liveLock) return res;
  var label = piDisabledLabel(key);
  var tail = label ? text.render(ah.cfg('devswarm_prompt.stale_disabled'), { label: label, uid: String(ah.uid()) }) : ah.cfg('devswarm_prompt.stale_doctor');
  var s = Object.assign({}, base, { key: ah.cfg('devswarm_prompt.stale_key'), normalize: piNormStale });
  s.content = text.render(ah.cfg('devswarm_prompt.stale_banner'), { age: piIngestRelative(beatTs, now), tail: tail });
  res.stale = s;
  return res;
}

// `emit-dedupe.forget`: drop the record of a block that is no longer announced, so its next occurrence is a new episode.
function piForget(sid, key) {
  if (sid === null || dedupe.disabled()) return;
  var rel = dedupe.stateRel(sid), state = dedupe.readState(rel);
  if (!Object.prototype.hasOwnProperty.call(state, key)) return;
  delete state[key];
  ah.state.writeAtomic(rel, JSON.stringify(state));
}

// ---- the roster of the project's summary ----------------------------------------------------------------------------------

// A summary's text as the hook reads it: {absent: true}, {summary} or the cause of a deferral (anything the hook would log, or a shape it
// would read otherwise).
function piParseSummary(raw) {
  var t = raw.trim();
  if (t === '') return { cause: 'summary-empty' };
  var j = jx.parse(t);
  if (j.unsure) return { cause: 'summary-unsure' };
  if (j.invalid) return { cause: 'summary-invalid' };
  if (j.v === null || typeof j.v !== 'object') return { absent: true }; // a scalar reads as no summary
  if (Array.isArray(j.v)) return { cause: 'summary-shape' }; // a list is an object of its own: Node's
  return { summary: j.v };
}

// The project's summary file.
function piReadSummary(home, key) {
  var p = piDevswarmDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_summaries') + '/' + key + '.json';
  if (!piPresent(p)) return { absent: true };
  var r = jx.read(p);
  if (r.big) return { cause: 'summary-big' };
  if (r.text === undefined) return { cause: 'summary-unreadable' };
  return piParseSummary(r.text);
}

// What the Node hook would do with the summary's rows, decided without a write: the rows, the nudges and the archive recommendations,
// or the cause of a deferral. `ctx`: {home, key, top, primaryId, now, sid}.
function piRoster(ctx, summary) {
  var home = ctx.home, key = ctx.key, now = ctx.now;
  var ws = summary.workspaces;
  if (Array.isArray(ws)) { ah.unable('devswarm-parent-inbox:workspaces_array'); ws = null; }
  var summaryWorkspaces = ws !== null && typeof ws === 'object' ? ws : {};
  var ids = Object.keys(summaryWorkspaces);
  var out = { rows: [], attention: [], archiveList: [], ignoredDead: 0, ownExtra: 0, ownExtraUrgency: null, deferral: null, snapUnreadable: false };
  // the DevSwarm app's database, read once
  var focusEnv = ah.env.get(ah.cfg('devswarm_parent.env_focus_ms'));
  var focusRaw = Number(focusEnv === null ? undefined : focusEnv); // Number(undefined) is NaN, Number(null) would be 0
  var windowMs = isFinite(focusRaw) && focusRaw >= 0 ? focusRaw : ah.cfgNum('devswarm_parent.focus_default_ms');
  var snapInfo = JSON.parse(ahHost.piSnap(windowMs, now));
  if (snapInfo.unsure) { ah.unable('devswarm-parent-inbox:app_snapshot'); snapInfo = { unsure: false, readable: false, file: false, focused: null }; } // the app database cannot be read: no focus or app facts
  var focusedId = windowMs > 0 && snapInfo.focused ? snapInfo.focused : null;
  out.snapUnreadable = snapInfo.file && !snapInfo.readable;
  function appWs(id, wt) {
    if (!snapInfo.readable) return null;
    var r = JSON.parse(ahHost.piWs(id, wt, now));
    if (r !== null && r.unsure) { ah.unable('devswarm-parent-inbox:app_workspace'); return null; }
    return r;
  }
  var graceMs = piSetDefault('devswarm_parent.set_grace') * 1000;
  var renagMs = piSetDefault('devswarm_parent.set_renag') * ah.cfgNum('devswarm_parent.ms_per_hour');
  var ignoreV = piJson(piDevswarmDir(home) + '/' + ah.cfg('devswarm_role.pg_ignore_file'));
  var ignoreIds = {};
  if (jx.isObj(ignoreV) && Array.isArray(ignoreV.ids)) ignoreV.ids.forEach(function (x) { if (typeof x === 'string' && x !== '') ignoreIds[x] = true; });
  var noticeIgnoreDead = ah.settings.bool('devswarm_parent.set_notice_ignore_dead') === true;
  var noticeMaxAgeMs = ah.settings.num('devswarm_parent.set_notice_max_age_days') * 24 * 3600 * 1000;
  var present = ids.filter(function (i) { return true; });
  // the ghost rows: a `primary-<hash>` label whose canonical row is also in the summary is that workspace, shown once under it
  var ghostFoldTo = {}, foldedUnread = {};
  ids.forEach(function (id) {
    if (!piSafeId(id) || id === ctx.primaryId || !jx.re('devswarm_cli.rr_ghost_label_re').test(id)) return;
    var entry = summaryWorkspaces[id];
    if (!entry || typeof entry !== 'object') return;
    var wt = entry.worktreePath ? piStrField(entry.worktreePath) : null;
    var w = wt ? appWs(null, wt) : null;
    var appBuilderId = w && w.builderType !== ah.cfg('devswarm_sup.as_primary_type') ? w.id : null;
    var f = JSON.parse(ahHost.piFold(id, JSON.stringify(present), appBuilderId, key, now));
    if (f.unsure) { ah.unable('devswarm-parent-inbox:ghost_fold'); return; }
    if (!f.to) return;
    ghostFoldTo[id] = f.to;
    var gu = piFinite(entry.directUnread) ? entry.directUnread : (piFinite(entry.unread) ? entry.unread : 0);
    if (gu > 0) foldedUnread[f.to] = (foldedUnread[f.to] || 0) + gu;
  });
  for (var n = 0; n < ids.length; n++) {
    var id = ids[n];
    if (!piSafeId(id)) continue;
    if (id === ctx.primaryId) continue; // the Primary's own entry is surfaced through the own-unread path
    var entry = summaryWorkspaces[id];
    if (!entry || typeof entry !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(ghostFoldTo, id)) continue;
    var wtPath = piStrField(entry.worktreePath);
    var sessionId = piStrField(entry.sessionId);
    // a row on this very checkout that the app calls its primary builder is the Primary's own inbox, not a child
    if (wtPath) {
      var bw = appWs(id, null);
      if (bw && bw.builderType === ah.cfg('devswarm_sup.as_primary_type')) {
        var wc = ah.repo.context(wtPath);
        if (wc.unsure) { ah.unable('devswarm-parent-inbox:row_context'); wc = { root: null }; }
        if (wc.root === ctx.top) {
          // the app's own builder row of this checkout is the Primary's inbound mail, shown through the own-inbox segment
          var rowUnread = piFinite(entry.directUnread) ? entry.directUnread : (piFinite(entry.unread) ? entry.unread : 0);
          out.ownExtra += rowUnread + (foldedUnread[id] || 0);
          if (!out.ownExtraUrgency) out.ownExtraUrgency = entry.urgencyMax || null;
          continue;
        }
      }
    }
    var dKey = wtPath ? ah.mesh.repoKey(wtPath) : null;
    if (key && dKey && dKey !== key) continue; // another project's workspace
    var unread = (piFinite(entry.directUnread) ? entry.directUnread : (piFinite(entry.unread) ? entry.unread : 0)) + (foldedUnread[id] || 0);
    var total = piFinite(entry.total) ? entry.total : 0;
    var cursor = piFinite(entry.cursor) ? entry.cursor : 0;
    var urgencyMax = entry.urgencyMax || null;
    var vv = piJson(piDevswarmDir(home) + '/' + ah.cfg('mesh_write.dir_liveness') + '/' + id + '.json');
    var verdict = vv && typeof vv === 'object' ? vv : null;
    var status = entry && typeof entry.status === 'string' ? entry.status : (verdict && typeof verdict.status === 'string' ? verdict.status : null);
    var stuck = status !== null && piStuck(status);
    var notDraining = !!(verdict && verdict.notDraining);
    // a backlog that does not drain on a child running an older build is a build problem, not neglect
    var staleBuild = null;
    if (notDraining) {
      if (!ctx.newest.known) { ctx.newest.value = piNewestVersion(home); ctx.newest.known = true; }
      if (ctx.newest.value) staleBuild = piStaleBuild(home, id, ctx.newest.value);
    }
    var notDrainingForLabel = notDraining && staleBuild === null;
    var archiveReady = entry.archive_ready === true;
    var archiveReadyQuiet = false;
    if (archiveReady && unread > 0 && entry.archive_request_only_unread === true) {
      var liveSession = false;
      if (entry.sessionId) liveSession = ah.mesh.sessionAlive(piStrField(entry.sessionId));
      archiveReadyQuiet = !liveSession;
    }
    var archiveRequestPending = entry.archive_request_only_unread === true;
    var archiveRequestAgeMs = archiveRequestPending && piFinite(entry.oldestDirectUnreadTs) ? now - entry.oldestDirectUnreadTs : null;
    var archiveRequestStale = archiveRequestAgeMs !== null && archiveRequestAgeMs >= renagMs;
    var archiveRequestQuiet = archiveRequestPending && !archiveRequestStale;
    var nagIgnored = ignoreIds[id] === true;
    var oldestForGate = piFinite(entry.oldestDirectUnreadTs) ? entry.oldestDirectUnreadTs : null;
    var senderRaw = entry.oldestDirectUnreadSender;
    var graced = false;
    if (unread > 0 && oldestForGate !== null) {
      var ageMs = now - oldestForGate;
      if (ageMs >= graceMs) graced = false;
      else if (senderRaw != null && ctx.primaryId != null && String(senderRaw) !== String(ctx.primaryId)) graced = false;
      else graced = true;
    }
    var unreadForNag = unread > 0 && !graced;
    var st = JSON.parse(ahHost.piRow(id, wtPath, sessionId, key, now));
    if (st.unsure) { ah.unable('devswarm-parent-inbox:row_state'); st = { unsure: false, marker: false, app: false }; } // taken as not put away
    var archivedRow = st.marker;
    var appArchivedRow = st.app;
    var rowWs = appWs(id, wtPath);
    var ownerFocused = !!(focusedId && rowWs && rowWs.id === focusedId);
    // a row anti-hall's own marker calls archived, whose worktree is gone, or whose oldest unread is past the age limit cannot be acted on
    // (GH #508): it is left out of the nudges and counted once instead (devswarm.nudgeIgnoreDeadRows)
    var deadWhy = null;
    if (noticeIgnoreDead) {
      try {
        if (archivedRow) deadWhy = 'archived';
        else if (wtPath && !piPresent(wtPath)) deadWhy = 'worktree_gone';
        else if (piDeadHint(home, id, wtPath, total, urgencyMax)) deadWhy = 'dead_hint';
        else if (noticeMaxAgeMs > 0 && !piHigh(urgencyMax)) {
          // inactive, not merely holding an old message: judged by the workspace's latest activity (an old unread beside newer mail or a live
          // child never ages the row out, and an urgent backlog is never aged out); with no activity on record, by the oldest unread
          var hbRow = piJson(piDevswarmDir(home) + '/' + ah.cfg('mesh_write.dir_heartbeats') + '/' + id + '.json');
          var lastAct = Math.max(verdict && piFinite(verdict.lastOutboundTs) ? verdict.lastOutboundTs : 0, hbRow && typeof hbRow === 'object' && piFinite(hbRow.ts) ? hbRow.ts : 0);
          if (lastAct > 0 ? now - lastAct > noticeMaxAgeMs : (piFinite(oldestForGate) && now - oldestForGate > noticeMaxAgeMs)) deadWhy = 'too_old';
        }
      } catch (e) { ah.unable('devswarm-parent-inbox:dead_row_decide'); deadWhy = null; } // any doubt shows the row (fail visible)
    }
    var wouldNag = ((unreadForNag && !archiveRequestQuiet) || stuck || (notDraining && !archiveRequestQuiet)) && !archiveReadyQuiet && !nagIgnored && !appArchivedRow && !ownerFocused;
    if (deadWhy !== null && wouldNag) { out.ignoredDead++; ah.metric('devswarm_notice_rows_ignored', ['reason', deadWhy]); }
    if (wouldNag && deadWhy === null) {
      var wsName = (rowWs && rowWs.label) || piReadName(home, id);
      var reportUnread = graced ? 0 : unread;
      out.attention.push({
        id: id, unread: reportUnread, cursor: cursor, total: total, status: status, urgencyMax: graced ? null : urgencyMax, wsName: wsName,
        oldestUnreadTs: graced ? null : oldestForGate, notDraining: notDrainingForLabel, staleAntiHallMessage: staleBuild ? staleBuild.message : null,
      });
    }
    if (archiveReady && !appArchivedRow && !ownerFocused && !st.ignored && piArchiveCooldown(home, id, now) && !piAutoArchiveOwns(home, id, now)
        && !(archiveRequestQuiet && !archiveReadyQuiet)) out.archiveList.push(id);
    // the live-table row
    var archivedSuperseded = !archivedRow && st.superseded;
    if (!archivedRow && appArchivedRow) archivedRow = true;
    var hb = piJson(piDevswarmDir(home) + '/' + ah.cfg('mesh_write.dir_heartbeats') + '/' + id + '.json');
    var heartbeat = hb && typeof hb === 'object' ? hb : null;
    var lastOut = verdict && piFinite(verdict.lastOutboundTs) ? verdict.lastOutboundTs : null;
    var a = (lastOut !== null ? lastOut : 0), b = heartbeat && piFinite(heartbeat.ts) ? heartbeat.ts : 0, best = Math.max(a, b);
    var activityTs = best > 0 ? best : null;
    var dormant = false, idleAlive = false, idleMs = 0;
    if (!archivedRow) {
      var act = JSON.parse(ahHost.piActivity(id, wtPath, sessionId, lastOut, key, now));
      if (act.unsure) { ah.unable('devswarm-parent-inbox:row_activity'); act = { idleMs: 0, ts: null, dormant: false, idleAlive: false }; }
      idleMs = act.idleMs;
      if (act.ts !== null && (!piFinite(activityTs) || act.ts > activityTs)) activityTs = act.ts;
      dormant = act.dormant;
      idleAlive = act.idleAlive;
    }
    var staleLabel = { label: text.render(ah.cfg('devswarm_parent.stale_build_label'), { version: staleBuild ? staleBuild.version : '' }), rank: piLabel('not_draining').rank };
    var ds = (staleBuild && !appArchivedRow) ? staleLabel
      : archivedRow ? (appArchivedRow ? piLabel('archived') : (notDrainingForLabel ? piLabel('not_draining') : piLabel('archived')))
        : archivedSuperseded ? (notDrainingForLabel ? piLabel('not_draining') : piLabel('superseded'))
          : piDisplayStatus(archiveReady, status, activityTs, now, dormant, notDrainingForLabel, idleAlive, idleMs);
    if (archiveReadyQuiet && !archivedRow && !archivedSuperseded && ds.label === piLabel('not_draining').label) {
      ds = piDisplayStatus(archiveReady, status, activityTs, now, dormant, false, idleAlive, idleMs);
    }
    var finishCell = piDoneState(entry, heartbeat);
    if (/^working\b/.test(finishCell) && gates.setting('devswarm_prompt.plan_tracking_setting', true, ctx.pluginRoot) !== false) {
      var pf = JSON.parse(ahHost.piFinish(id, wtPath, now));
      if (pf.unsure) { ah.unable('devswarm-parent-inbox:row_finish'); pf = { label: null }; }
      if (pf.label !== null) finishCell = piPlanCell(home, pf, dormant, finishCell);
    }
    var appMarks = '';
    if (rowWs) {
      if (rowWs.finish) finishCell = finishCell === ah.cfg('devswarm_parent.relative_none') ? rowWs.finish : finishCell + ' · ' + rowWs.finish;
      appMarks = piAppMarks(rowWs, rowWs.brief, !!(focusedId && rowWs.id === focusedId));
    }
    out.rows.push({
      id: id, label: ds.label, rank: ds.rank, finish: finishCell, appRank: rowWs && piFinite(rowWs.rank) ? rowWs.rank : null, appMarks: appMarks,
      unread: unread, lastActivityTs: activityTs, wsName: (rowWs && rowWs.label) || piReadName(home, id),
      unpushed: piFinite(entry.unpushed) ? entry.unpushed : null, noUpstream: entry.noUpstream === true, mergedVerified: entry.mergedVerified,
    });
  }
  return out;
}

// `archiveCooldownElapsed(home, id, now)`: no earlier recommendation, or its cooldown is over.
function piArchiveCooldown(home, id, now) {
  var st = piJson(piDevswarmDir(home) + '/' + ah.cfg('devswarm_parent.dir_archive_nudges') + '/' + id + '.json');
  var last = st && piFinite(st.lastNudgedAt) ? st.lastNudgedAt : null;
  if (last === null) return true;
  return (now - last) >= ah.cfgNum('devswarm_parent.archive_cooldown_ms');
}

// `autoArchiveOwnsRow(home, id, now)`: the supervisor's last sweep owns the row. A record that could say yes needs the capability check, which is not made here: the row is not taken as owned (counted).
function piAutoArchiveOwns(home, id, now) {
  if (ah.settings.str('devswarm_parent.set_auto_archive') === 'off') return false; // the supervisor does not archive on its own
  var st = piJson(piDevswarmDir(home) + '/' + ah.cfg('devswarm_parent.file_auto_archive'));
  if (!st || !Array.isArray(st.owned) || !(now - Number(st.at) < ah.cfgNum('devswarm_parent.auto_archive_window_ms'))) return false;
  if (st.owned.indexOf(String(id)) < 0) return false;
  ah.unable('devswarm-parent-inbox:auto_archive_capability');
  return false;
}

// ---- wake coverage --------------------------------------------------------------------------------------------------------

// `readDescriptors(home)` of the supervisor: the workspace descriptors that name a worktree and a session and a safe id.
function piDescriptors(home) {
  var dir = piDevswarmDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_workspaces'), out = [];
  (piNames(dir) || []).forEach(function (n) {
    if (!/\.json$/.test(n)) return;
    var d = piJson(dir + '/' + n);
    if (!d || !d.worktreePath || !d.sessionId || !piSafeId(d.id)) return;
    if (typeof d.worktreePath !== 'string' || typeof d.sessionId !== 'string') { ah.unable('devswarm-parent-inbox:descriptor_shape'); return; }
    out.push(d);
  });
  return out;
}

// The part of `rowEligibility(row, { liveness: true })` the live-child test reads: is the row put away, held, ignored or waiting on a human?
// `marker` and `app` are the archive verdicts the caller asks for; the liveness is read only when nothing else already skips the row.
function piSkipped(ctx, id, wt, sid, marker, appKey) {
  if (marker && JSON.parse(ahHost.piMarker(id, wt, sid)).archived === true) return true;
  if (appKey !== undefined) {
    var a = JSON.parse(ahHost.piApp(id, wt, appKey, ctx.now));
    if (a.unsure) ah.unable('devswarm-parent-inbox:app_verdict');
    else if (a.archived) return true;
  }
  if (ah.settings.touched('devswarm_parent.set_held')) ah.unable('devswarm-parent-inbox:held_partitions'); // the owner's held partitions are not applied here
  if (ahHost.piIgnored(id)) return true;
  var live = sid ? ah.mesh.sessionAlive(sid) : false;
  if (id !== '' && sid && wt) {
    var b = ah.mesh.childBusy(id, wt, sid, ctx.now, ah.cfg('devswarm_role.pg_set_busy_fresh').default * ah.cfgNum('devswarm_role.pg_ms_per_min'));
    if (b.none !== true && b.waiting && live) return true;
  }
  return false;
}

// `liveChildState(home, cwd, { excludeHeldIgnored: true, excludeWaitingOnUser: true })`: {known, live}.
function piLiveChildren(ctx, cwd) {
  var d = { live: false, known: true };
  var descriptors = piDescriptors(ctx.home);
  if (descriptors.length) {
    var selfKey = ah.mesh.repoKey(cwd);
    if (selfKey === null) d = { live: false, known: false };
    else {
      var selfReal = ah.fs.realpath(cwd);
      if (selfReal === null) selfReal = cwd;
      for (var i = 0; i < descriptors.length; i++) {
        var x = descriptors[i];
        if (!x.worktreePath || !x.id) continue;
        var real = ah.fs.realpath(x.worktreePath);
        if ((real === null ? x.worktreePath : real) === selfReal) continue; // this Primary's own row
        var dKey = ah.mesh.repoKey(x.worktreePath);
        if (dKey !== selfKey) continue;
        if (!piSkipped(ctx, x.id, x.worktreePath, x.sessionId, true, dKey)) { d = { live: true, known: true }; break; }
      }
    }
  }
  if (d.known && d.live) return d;
  // a live child no descriptor names, found in the app database
  var ac = JSON.parse(ahHost.piAppChildren(cwd, ctx.now));
  if (ac.unsure) { ah.unable('devswarm-parent-inbox:app_children'); ac = { children: [] }; }
  for (var j = 0; j < ac.children.length; j++) {
    var w = ac.children[j];
    if (!piSkipped(ctx, w.id, w.worktreePath, w.sessionId, true, undefined)) return { live: true, known: true };
  }
  return d;
}

// `watcherLockLive(home, id, now)`: a live Monitor wake-watch holds the lock of `id`.
function piWatcherLock(home, id, now) {
  var lock = piJson(piDevswarmDir(home) + '/' + ah.cfg('devswarm_parent.dir_locks') + '/' + ah.cfg('devswarm_parent.watch_lock_prefix') + id + ah.cfg('devswarm_parent.watch_lock_suffix'));
  if (lock === null) return false;
  var ts = lock && Number(lock.ts);
  var fresh = piFinite(ts) && (now - ts) <= ah.cfgNum('wake_watch.lock_stale_ms');
  var pid = lock && typeof lock.pid === 'number' && isFinite(lock.pid) && Math.floor(lock.pid) === lock.pid ? lock.pid : null;
  var alive = pid !== null ? ahHost.piPid(pid) : null;
  return !!(fresh && alive !== false);
}

// `watcherLiveForWorkspace(home, id, now)`: the id's own lock, or the lock of another row on the same checkout.
function piWatcherLive(home, id, now) {
  if (piWatcherLock(home, id, now)) return true;
  var descriptors = piDescriptors(home), own = null;
  descriptors.forEach(function (d) { if (own === null && String(d.id) === String(id)) own = d; });
  if (!own || !own.worktreePath) return false;
  var forms = function (p) {
    var f = {}, resolved = ah.path.resolveAbs(p);
    f[resolved] = true;
    var r = ah.fs.realpath(resolved);
    if (r !== null) f[r] = true;
    return Object.keys(f);
  };
  var ownForms = forms(own.worktreePath);
  for (var i = 0; i < descriptors.length; i++) {
    var d = descriptors[i];
    if (!d.id || !d.worktreePath || String(d.id) === String(id)) continue;
    if (forms(d.worktreePath).some(function (f) { return ownForms.indexOf(f) >= 0; }) && piWatcherLock(home, d.id, now)) return true;
  }
  return false;
}

// The mailbox-wake line of this turn (`noWakePathLine(wakeCoverage(...))`), or null: only a Claude Primary with a live child and no recent tick is told.
function piWakeLine(ctx, cwd, cli, opts) {
  var raw = ah.env.get(ah.cfg('devswarm_role.agent_env'));
  var agent = raw === null ? '' : raw.trim().toLowerCase();
  if (agent !== ah.cfg('devswarm_role.claude_agent')) return null;
  var lc = piLiveChildren(ctx, cwd);
  if (!lc.known || !lc.live) return null;
  var tick = piJson(piDevswarmDir(ctx.home) + '/' + ah.cfg('devswarm_parent.dir_wake_tick') + '/' + ctx.primaryId + '.json');
  var ageMin = tick && piFinite(tick.ts) ? Math.max(0, Math.floor((ctx.now - tick.ts) / ah.cfgNum('devswarm_prompt.ms_per_minute'))) : null;
  var warn = piSetDefault('devswarm_parent.set_cron_warn');
  if (!(ageMin === null || ageMin > warn)) return null;
  var wanted = ah.settings.bool('wake_watch.set_enabled') !== false;
  var noWatcher = wanted && !piWatcherLive(ctx.home, ctx.primaryId, ctx.now);
  var cron = text.render(ah.cfg('devswarm_parent.wake_cron_part'), { cron: dwWakeCron(), cli: cli, id: ctx.primaryId });
  if (noWatcher) {
    var watcher = piWatcherPath(opts, ctx.home);
    if (watcher === null) { ah.unable('devswarm-parent-inbox:watcher_path'); return null; } // no watcher path to name: no wake line
    return text.render(ah.cfg('devswarm_parent.wake_both'), { mon: text.render(ah.cfg('devswarm_parent.wake_monitor'), { watcher: watcher }), cron: cron });
  }
  return text.render(ah.cfg('devswarm_parent.wake_tick'), { cron: cron });
}

// The mailbox watcher path the line names (`preferStableLauncher('wakeWatch', RAW_WATCHER)`).
function piWatcherPath(opts, home) {
  return dwEngineCmd('devswarm_role.engine_watcher', home);
}

// ---- the maintainer notices and the session drift -----------------------------------------------------------------------

// `buildMaintainerNoticeSegment(home, repoKey, now)`: null for a feed with nothing unseen, else {text, lastId}: the unseen notices of
// this project, shown once and marked seen (the caller writes the cursor `lastSeenId` after the turn is settled).
function piNotices(home, key, now) {
  var file = piDevswarmDir(home) + '/' + ah.cfg('devswarm_parent.notices_file');
  if (!piPresent(file)) return null;
  if (!ah.settings.bool('devswarm_parent.set_notice_show')) return null;
  var size = ah.fs.size(file);
  if (size !== null && size > ah.cfgNum('script.read_max_bytes')) { ah.unable('devswarm-parent-inbox:notices_big'); return null; }
  var raw = size === null ? null : ah.fs.readText(file);
  var rows = [];
  if (raw !== null) raw.split('\n').forEach(function (line) {
    var t = line.trim();
    if (!t) return;
    var row;
    try { row = JSON.parse(t); } catch (e) { return; }
    if (row && typeof row === 'object' && row.id) rows.push(row);
  });
  var live = rows.filter(function (r) { return !(piFinite(r.expiresAt) && r.expiresAt <= now); });
  live.sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0); });
  var shown = live.slice(Math.max(0, live.length - ah.cfgNum('devswarm_parent.notice_max_shown')));
  if (!shown.length) return null;
  var cursor = null;
  if (/^[A-Za-z0-9._-]+$/.test(key)) {
    var cv = piJson(piDevswarmDir(home) + '/' + ah.cfg('devswarm_parent.dir_notice_cursor') + '/' + key + '.json');
    cursor = cv && typeof cv.lastSeenId === 'string' ? cv.lastSeenId : null;
  }
  var unseen = shown;
  if (cursor) {
    var idx = -1;
    for (var i = 0; i < shown.length; i++) if (shown[i].id === cursor) { idx = i; break; }
    unseen = idx === -1 ? shown : shown.slice(idx + 1);
  }
  if (!unseen.length) return null;
  var lines = unseen.map(function (n) { return text.render(ah.cfg('devswarm_parent.notice_text'), { text: n.text }); });
  return { text: lines.join('\n') + '\n' + ah.cfg('devswarm_parent.notice_relay'), lastId: unseen[unseen.length - 1].id };
}

// The session-drift notice (`driftNotice(anchorSessionDrift(...))`), or null: a newer session of this worktree is active than the Primary's anchor.
function piDriftNotice(home, top, primaryId, sid, tp) {
  var desc = piJson(piDevswarmDir(home) + '/' + ah.cfg('devswarm_role.pg_dir_workspaces') + '/' + primaryId + '.json');
  var anchorRaw = desc && desc.sessionId;
  var anchor = anchorRaw != null ? String(anchorRaw) : '';
  var d = JSON.parse(ahHost.piDrift(top, anchor, sid != null ? String(sid) : '', tp));
  if (d !== null && d.unsure) { ah.unable('devswarm-parent-inbox:drift'); return null; }
  if (d === null) return null;
  if (sid && String(sid) === d.newest) return null;
  return text.render(ah.cfg('devswarm_parent.drift_notice'), { newest: d.newest, anchor: d.anchor });
}

// ---- orphaned partitions, stale registry rows and the broadcast feed ---------------------------------------------------------

// `buildOrphansSegment(list)` / `buildStaleRegistrySegment(list)`: partitions or rows named by id with their unread count, null for none.
function piIssueSegment(list, headKey) {
  var safe = list.filter(function (o) { return o && o.id != null && piSafeId(String(o.id)); });
  if (!safe.length) return null;
  safe.sort(function (a, b) { return (Number(b.unread) || 0) - (Number(a.unread) || 0); });
  var max = ah.cfgNum('devswarm_parent.max_mesh_issues');
  var shown = safe.slice(0, max).map(function (o) { return text.render(ah.cfg('devswarm_parent.issue_part'), { id: o.id, unread: piFinite(o.unread) ? o.unread : 0 }); });
  var extra = safe.length > max ? text.render(ah.cfg('devswarm_parent.issue_extra'), { n: safe.length - max }) : '';
  return text.render(ah.cfg(headKey), { count: safe.length, shown: shown.join(ah.cfg('devswarm_parent.issue_joiner')), extra: extra });
}

// `broadcastKey(r)`.
function piBroadcastKey(r) {
  var who = r && r.fromLabel != null ? r.fromLabel : (r && r.from != null ? r.from : '?');
  return who + '\0' + (r && r.ts != null ? r.ts : '') + '\0' + (r && r.summary != null ? r.summary : '');
}

// The once-per-session record of the orphaned-mesh warning (devswarm.orphanWarningOnce, GH #419): the warning is shown again only
// when the SET of orphaned partition ids changes, never because an unread count moved or the keepalive ran out.
function piOrphansSeenRel(sessionRaw) {
  var safe = String(sessionRaw || ah.cfg('devswarm_parent.broadcast_no_session')).replace(/[^A-Za-z0-9_.-]/g, '_');
  return piRel(ah.cfg('devswarm_parent.dir_orphans_seen') + '/' + safe + '.json');
}
function piOrphansSig(list) {
  return ah.sha1(list.filter(function (o) { return o && o.id != null; }).map(function (o) { return String(o.id); }).sort().join(','));
}
function piOrphansSeen(sessionRaw, sig) {
  var raw = ah.state.readText(piOrphansSeenRel(sessionRaw));
  if (raw === null) return false;
  try { var j = JSON.parse(raw); return !!j && j.sig === sig; } catch (e) { return false; }
}

function piBroadcastSeenRel(sessionRaw) {
  var safe = String(sessionRaw || ah.cfg('devswarm_parent.broadcast_no_session')).replace(/[^A-Za-z0-9_.-]/g, '_');
  return piRel(ah.cfg('devswarm_parent.dir_broadcast_seen') + '/' + safe + '.json');
}

// `visibleBroadcastRows(rows, home, sessionId, now, env)` up to the write: {rows: the unseen ones, seen: the keys to remember (null for no write)}.
function piBroadcastRows(rows, home, sessionRaw, now) {
  var maxEnv = ah.env.get(ah.cfg('devswarm_parent.env_broadcast_max_age'));
  var n = Number(maxEnv === null ? undefined : maxEnv);
  var maxAge = isFinite(n) && n >= 0 ? n : ah.cfgNum('devswarm_parent.broadcast_max_age_ms');
  var fresh = rows.filter(function (r) { return !isFinite(now) || !r || !piFinite(r.ts) || (now - r.ts) <= maxAge; });
  var seen = [];
  var raw = ah.state.readText(piBroadcastSeenRel(sessionRaw));
  if (raw !== null) { try { var j = JSON.parse(raw); if (j && Array.isArray(j.keys)) seen = j.keys; } catch (e) { seen = []; } }
  var seenSet = {};
  seen.forEach(function (k) { seenSet[k] = true; });
  var unseen = fresh.filter(function (r) { return !Object.prototype.hasOwnProperty.call(seenSet, piBroadcastKey(r)); });
  return { rows: unseen, seen: unseen.length ? Array.from(new Set(seen)).concat(unseen.map(piBroadcastKey)) : null };
}

// `buildBroadcastSegment(rows, home)` with no Jev labels.
function piBroadcastSegment(rows) {
  var capped = rows.slice(-ah.cfgNum('devswarm_parent.max_listed'));
  var shown = capped.map(function (r) {
    var who = r.from != null ? r.from : ah.cfg('devswarm_parent.broadcast_no_sender');
    var max = ah.cfgNum('devswarm_parent.broadcast_body_max');
    var body = r.summary != null && r.summary !== '' ? (String(r.summary).length > max ? String(r.summary).slice(0, max) + '…' : String(r.summary)) : ah.cfg('devswarm_parent.broadcast_no_summary');
    return text.render(ah.cfg('devswarm_parent.broadcast_line'), { urgent: piHigh(r.urgency) ? ah.cfg('devswarm_parent.broadcast_urgent_tag') : '', kind: '', who: who, body: body });
  });
  return ah.cfg('devswarm_parent.broadcast_head') + shown.join('\n');
}

// ---- the newest anti-hall build on the machine ------------------------------------------------------------------------------

function piSemver(v) { return typeof v === 'string' && jx.isSemver(v); }

// `readJsonBounded(file)` of update.js: null for a file over the cap, unreadable or not JSON.
function piJsonBounded(p) {
  var size = ah.fs.size(p);
  if (size === null || size > ah.cfgNum('devswarm_parent.version_read_max')) return null;
  return piJson(p);
}

// `newestKnownAntiHallVersion({ env, home })`: the highest of the registered, the cached and the marketplace version, or null.
function piNewestVersion(home) {
  var owner = ah.plugin.install(), marketplace = owner && owner.marketplace ? owner.marketplace : home + '/' + ah.cfg('devswarm_parent.marketplace_default');
  var override = ah.env.get(ah.cfg('devswarm_parent.env_marketplace_dir'));
  if (override && ah.path.isAbsolute(override) && ah.fs.isDir(override)) marketplace = override;
  var root = ah.path.resolveAbs(marketplace + '/../..');
  var installed = null;
  var data = piJsonBounded(owner ? owner.registry : root + '/' + ah.cfg('devswarm_parent.installed_rel'));
  if (data && typeof data === 'object') {
    var reg = data.plugins && typeof data.plugins === 'object' ? data.plugins : data;
    var entry = reg[owner ? owner.key : ah.cfg('devswarm_parent.plugin_registry_key')];
    if (Array.isArray(entry)) {
      var valid = entry.filter(function (e) { return e && typeof e === 'object' && piSemver(e.version); });
      var pick = null;
      ah.cfg('devswarm_parent.registry_scopes').forEach(function (scope) { if (pick === null) valid.forEach(function (e) { if (pick === null && e.scope === scope) pick = e; }); });
      if (pick === null) pick = valid[0] || null;
      installed = pick ? pick.version : null;
    } else if (typeof entry === 'string') installed = piSemver(entry) ? entry : null;
    else if (entry && typeof entry === 'object' && piSemver(entry.version)) installed = entry.version;
  }
  var cacheRoot = owner ? owner.cache : root + '/' + ah.cfg('devswarm_parent.cache_rel');
  var cached = null;
  var names = ah.fs.readdir(cacheRoot);
  if (names !== null) {
    var versions = names.filter(function (n) { return ah.fs.kind(cacheRoot + '/' + n) === 'dir' && piSemver(n); });
    if (versions.length) cached = versions.sort(jx.cmpVersions).pop();
  }
  var manifest = piJsonBounded(marketplace + '/' + ah.cfg('devswarm_parent.plugin_json_rel'));
  var fromMarketplace = manifest && piSemver(manifest.version) ? manifest.version : null;
  var newest = null;
  [installed, cached, fromMarketplace].forEach(function (v) { if (piSemver(v) && (!newest || jx.cmpVersions(v, newest) > 0)) newest = v; });
  return newest === null ? null : { version: newest, cacheRoot: cacheRoot };
}

// `staleAntiHallMessage(recorded, newest, cliPath)` for a child whose heartbeat records an older build, else null.
function piStaleBuild(home, id, newest) {
  var hb = piJson(piDevswarmDir(home) + '/' + ah.cfg('mesh_write.dir_heartbeats') + '/' + id + '.json');
  var rec = hb && typeof hb.version === 'string' ? hb.version : null;
  if (!(piSemver(rec) && jx.cmpVersions(rec, newest.version) < 0)) return null;
  var cmd = ah.cfg('devswarm_parent.stale_build_cmd'); // the native thin client drains it; no per-version script path
  return { version: rec, message: text.render(ah.cfg('devswarm_parent.stale_build_message'), { version: rec, cmd: cmd }) };
}

// `tokenUsage.fmt(n)`.
function piTokens(n) {
  var v = Number(n) || 0;
  if (v >= ah.cfgNum('devswarm_parent.tokens_million_at')) return text.render(ah.cfg('devswarm_parent.tokens_million'), { v: Math.round(v / (ah.cfgNum('devswarm_parent.tokens_million_at') / 10)) / 10 });
  if (v >= ah.cfgNum('devswarm_parent.tokens_thousand_at')) return text.render(ah.cfg('devswarm_parent.tokens_thousand'), { v: Math.round(v / ah.cfgNum('devswarm_parent.tokens_thousand_at')) });
  return String(Math.round(v));
}

// The finish cell of a working row whose workspace has a step plan: the label with the token burn, the tagged extras and a straying warning.
// An error in the add-ons leaves the plain cell, as Node's try/catch does.
function piPlanCell(home, pf, dormant, plain) {
  var label = pf.label;
  if (piSafeId(pf.key)) {
    var tok = piJson(piDevswarmDir(home) + '/' + ah.cfg('devswarm_parent.dir_token_usage') + '/' + pf.key + '.json');
    if (tok && typeof tok === 'object' && piFinite(tok.total) && tok.total > 0) label += text.render(ah.cfg('devswarm_parent.plan_tokens'), { tokens: piTokens(tok.total) });
  }
  if (pf.extras) label += text.render(ah.cfg('devswarm_parent.plan_extras'), { n: pf.extras, s: pf.extras === 1 ? '' : 's' });
  var stray = piJson(piDevswarmDir(home) + '/' + ah.cfg('devswarm_parent.dir_stray') + '/' + pf.key + '.json');
  var active = stray && Array.isArray(stray.active) ? stray.active : [];
  if (active.length && !dormant) {
    try { label += text.render(ah.cfg('devswarm_parent.plan_straying'), { signals: Array.from(new Set(active.map(function (a) { return a.signal; }))).join('+') }); } catch (e) { return plain; }
  }
  return label;
}

// ---- the screenshot-sync ask and the app-still-open note -------------------------------------------------------------------

// `uiSyncAskPath` relative to the home: the once-per-session-per-set marker.
function piAskRel(sessionRaw, ids) {
  var h = ah.sha1(String(sessionRaw || '') + '\u0000' + ids.slice().sort().join(',')).slice(0, ah.cfgNum('devswarm_parent.ask_hash_len'));
  return piRel(ah.cfg('devswarm_parent.dir_ui_sync') + '/' + h + '.json');
}

// `uiSyncAsk(...)` and `appLiveArchivedNote(...)`: {texts: [...], writes: [{rel, ids}]} for a turn with rows. A marker that exists says it was asked.
function piSyncNotes(ctx, rows, unreadable, sessionRaw) {
  var out = { texts: [], writes: [] };
  var conflicts = [];
  var as = piJson(piDevswarmDir(ctx.home) + '/' + ah.cfg('devswarm_parent.app_state_file'));
  if (as && Array.isArray(as.openButMarkedArchived)) {
    conflicts = as.openButMarkedArchived.filter(function (c) {
      if (!(c && c.worktreePath)) return false;
      return ah.mesh.repoKey(String(c.worktreePath)) === ctx.key;
    });
  }
  var ids = [], why = '';
  if (unreadable && conflicts.length) {
    ids = conflicts.map(function (c) { return String(c.id); });
    why = text.render(ah.cfg('devswarm_parent.ask_conflict'), { labels: conflicts.map(function (c) { return text.render(ah.cfg('devswarm_parent.ask_label'), { label: c.label || c.id }); }).join(', ') });
  } else if (unreadable && rows.length) {
    ids = rows.map(function (r) { return String(r.id); });
    why = ah.cfg('devswarm_parent.ask_unreadable');
  }
  if (ids.length) {
    var rel = piAskRel(sessionRaw, ids);
    if (!piPresent(ctx.home + '/' + rel)) {
      out.texts.push({ rank: 70, text: text.render(ah.cfg('devswarm_parent.ask_text'), { why: why }) });
      out.writes.push({ rel: rel, ids: ids });
    }
  }
  var live = conflicts.filter(function (c) { return c && c.localArchive === true && c.cmd; });
  if (live.length) {
    var lids = live.map(function (c) { return String(c.id); });
    var lrel = piAskRel(ah.cfg('devswarm_parent.ask_prefix_live') + String(sessionRaw || ''), lids);
    if (!piPresent(ctx.home + '/' + lrel)) {
      out.texts.push({ rank: 71, text: text.render(ah.cfg('devswarm_parent.app_live_text'), { n: live.length, cmds: live.map(function (c) { return c.cmd; }).join(ah.cfg('devswarm_parent.app_live_joiner')) }) });
      out.writes.push({ rel: lrel, ids: lids });
    }
  }
  return out;
}

// ---- the questions the Primary was asked ---------------------------------------------------------------------------------------

// `readReplyState(repoKey, home)`: sender id -> {lastReplyTs}, folded from the project's reply log (a snapshot or appended records).
function piReplyState(home, key) {
  var out = Object.create(null);
  var p = piDevswarmDir(home) + '/' + ah.cfg('devswarm_parent.dir_reply_state') + '/' + String(key).replace(/[^A-Za-z0-9_.-]/g, '_') + ah.cfg('devswarm_parent.reply_state_suffix');
  var size = ah.fs.size(p);
  if (size === null) return out;
  if (size > ah.cfgNum('script.read_max_bytes')) { ah.unable('devswarm-parent-inbox:reply_state_big'); return out; }
  var raw = ah.fs.readText(p);
  if (raw === null) return out;
  var bump = function (meshId, ts) {
    if (typeof meshId !== 'string' || !meshId || !piFinite(ts)) return;
    var prior = out[meshId] && piFinite(out[meshId].lastReplyTs) ? out[meshId].lastReplyTs : -Infinity;
    if (ts > prior) out[meshId] = { lastReplyTs: ts };
    else if (!out[meshId]) out[meshId] = { lastReplyTs: ts };
  };
  raw.split('\n').forEach(function (line) {
    var t = line.trim();
    if (!t) return;
    var o;
    try { o = JSON.parse(t); } catch (e) { return; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    if (typeof o.m === 'string' && piFinite(o.t)) bump(o.m, o.t);
    else Object.keys(o).forEach(function (k) { var v = o[k]; if (v && typeof v === 'object' && piFinite(v.lastReplyTs)) bump(k, v.lastReplyTs); });
  });
  return out;
}

// `unansweredQuestions(pendingQuestions, replyState)`.
function piUnanswered(pending, state) {
  return pending.filter(function (q) {
    try {
      if (!q || typeof q !== 'object') return true;
      var entry = state[q.from];
      var last = entry && piFinite(entry.lastReplyTs) ? entry.lastReplyTs : 0;
      var ts = piFinite(q.ts) ? q.ts : Infinity;
      return ts > last;
    } catch (e) { return true; }
  });
}

// `crossLinkedIdentity(a, b)`.
function piCrossLinked(a, b) {
  if (!a || !b) return false;
  var aId = a.id != null ? String(a.id) : '', bId = b.id != null ? String(b.id) : '';
  if (!aId || !bId || aId === bId) return false;
  var aSess = a.sessionId != null ? String(a.sessionId) : '', bSess = b.sessionId != null ? String(b.sessionId) : '';
  if (aSess && aSess === bId) return true;
  if (bSess && bSess === aId) return true;
  return false;
}

// `recipientFamilyIds(recipientId, rows)`.
function piRecipientFamily(recipientId, rows) {
  var out = Object.create(null);
  if (recipientId == null || String(recipientId) === '') return out;
  var rid = String(recipientId);
  out[rid] = true;
  var self = null;
  rows.forEach(function (r) { if (self === null && r && r.id != null && String(r.id) === rid) self = r; });
  var target = self || { id: rid };
  rows.forEach(function (c) { if (c && c.id != null && piCrossLinked(target, c)) out[String(c.id)] = true; });
  return out;
}

// `collapseFamilies(descriptors, { resolve })`.
function piFamilies(rows, resolve) {
  var cache = Object.create(null), groups = Object.create(null), order = [];
  rows.forEach(function (d) {
    if (!d) return;
    var key = null, wt = d.worktreePath;
    if (wt) {
      if (!Object.prototype.hasOwnProperty.call(cache, wt)) cache[wt] = resolve(wt);
      if (cache[wt]) key = cache[wt];
    }
    if (key === null) key = 'id:' + (d.id != null ? String(d.id) : '');
    if (!Object.prototype.hasOwnProperty.call(groups, key)) { groups[key] = []; order.push(key); }
    groups[key].push(d);
  });
  return order.map(function (key) { return { key: key, members: groups[key] }; });
}

// The unanswered questions of the Primary's own entry, split into the ones it can reply to and the ones from retired senders:
// {blocking, informational}. `familyAwareUnanswered`, `partitionUnanswered` and `filterLiveAskers` over the summary, the descriptors and the app.
function piQuestions(ctx, summary, pending) {
  var home = ctx.home, key = ctx.key;
  var replyState = piReplyState(home, key);
  var descriptors = piDescriptors(home);
  var meshIds = {};
  var resolve = function (wt) {
    if (!Object.prototype.hasOwnProperty.call(meshIds, wt)) {
      var r = JSON.parse(ahHost.piMeshId(wt));
      if (r.unsure) { ah.unable('devswarm-parent-inbox:mesh_id'); r = { id: null }; }
      meshIds[wt] = r.id;
    }
    return meshIds[wt];
  };
  var registryRows = [], archivedKnown = false;
  var ws = (summary && summary.workspaces) || {};
  Object.keys(ws).forEach(function (wid) { registryRows.push({ id: wid, worktreePath: (ws[wid] && ws[wid].worktreePath) || null, sessionId: (ws[wid] && ws[wid].sessionId) || null }); });
  archivedKnown = Array.isArray(summary && summary.archivedRegistryRows);
  if (archivedKnown) summary.archivedRegistryRows.forEach(function (r) { if (r && r.id != null) registryRows.push({ id: r.id, worktreePath: r.worktreePath || null, sessionId: r.sessionId || null }); });
  // familyAwareUnanswered
  var raw = piUnanswered(pending, replyState);
  var seen = {}, rows = [];
  descriptors.concat(registryRows).forEach(function (r) {
    if (!r || r.id == null) return;
    var id = String(r.id);
    if (Object.prototype.hasOwnProperty.call(seen, id)) return;
    seen[id] = true;
    rows.push(r);
  });
  var unanswered = raw;
  if (raw.length && rows.length) {
    var families = piFamilies(rows, resolve);
    var excluded = piRecipientFamily(ctx.primaryId || null, rows);
    var familyByMember = {};
    families.forEach(function (fam) { fam.members.forEach(function (m) { if (m && m.id != null) familyByMember[String(m.id)] = fam; }); });
    unanswered = raw.filter(function (q) {
      if (!q || q.from == null) return true;
      var fam = Object.prototype.hasOwnProperty.call(familyByMember, String(q.from)) ? familyByMember[String(q.from)] : null;
      if (!fam) return true;
      var qTs = piFinite(q.ts) ? q.ts : Infinity;
      for (var i = 0; i < fam.members.length; i++) {
        var m = fam.members[i], mid = m && m.id != null ? String(m.id) : null;
        if (!mid) continue;
        if (Object.prototype.hasOwnProperty.call(excluded, mid)) continue;
        var entry = replyState[mid];
        var last = entry && piFinite(entry.lastReplyTs) ? entry.lastReplyTs : 0;
        if (qTs <= last) return false;
      }
      return true;
    });
  }
  // partitionUnanswered
  var blocking = unanswered.slice(), informational = [];
  if ((descriptors.length || registryRows.length) && archivedKnown) {
    var known = {};
    descriptors.forEach(function (r) { if (r && r.id != null) known[String(r.id).trim()] = true; });
    registryRows.forEach(function (r) { if (r && r.id != null) known[String(r.id).trim()] = true; });
    blocking = []; informational = [];
    unanswered.forEach(function (q) {
      if (!q || q.from == null) { blocking.push(q); return; }
      if (Object.prototype.hasOwnProperty.call(known, String(q.from).trim())) blocking.push(q); else informational.push(q);
    });
  }
  // filterLiveAskers
  var byId = {};
  var add = function (r) { if (r && r.id != null && !Object.prototype.hasOwnProperty.call(byId, String(r.id))) byId[String(r.id)] = { id: r.id, worktreePath: r.worktreePath || null, sessionId: r.sessionId || null }; };
  registryRows.forEach(add);
  descriptors.forEach(add);
  var live = blocking.filter(function (q) {
    if (!q || q.from == null) return true;
    var from = String(q.from);
    var row = Object.prototype.hasOwnProperty.call(byId, from) ? byId[from] : null;
    if (!row) return !archivedKnown;
    var wt = piStrField(row.worktreePath), sid = piStrField(row.sessionId);
    if (ah.settings.touched('devswarm_parent.set_held')) ah.unable('devswarm-parent-inbox:held_partitions');
    if (piSafeId(from) && ahHost.piIgnored(from)) return false;
    var archived = false;
    if (wt || true) {
      var mk = JSON.parse(ahHost.piMarker(from, wt, sid));
      if (mk.unsure) ah.unable('devswarm-parent-inbox:marker_unsure'); // an unreadable marker leaves the asker live
      archived = mk.archived === true;
    }
    if (!archived) {
      var a = JSON.parse(ahHost.piApp(from, wt, key, ctx.now));
      if (a.unsure) ah.unable('devswarm-parent-inbox:app_verdict');
      archived = a.archived === true;
    }
    if (!archived) return true;
    var st = sid ? JSON.parse(ahHost.piSessionPid(sid)) : { alive: null };
    if (st.unsure) ah.unable('devswarm-parent-inbox:session_pid');
    return st.unsure || st.alive !== false;
  });
  return { blocking: live, informational: informational };
}

// `buildAwaitingLine(unanswered, titleFor, now, previews)`.
function piAwaitingLine(list, titleFor, now, previews) {
  if (!list.length) return '';
  var oldest = null;
  list.forEach(function (q) { if (q && piFinite(q.ts) && (oldest === null || q.ts < oldest.ts)) oldest = q; });
  if (oldest === null) oldest = list[0];
  var line = text.render(ah.cfg('devswarm_parent.awaiting_head'), { count: list.length });
  if (oldest && piFinite(oldest.ts)) line += text.render(ah.cfg('devswarm_parent.awaiting_oldest'), { m: Math.max(0, Math.floor((now - oldest.ts) / ah.cfgNum('devswarm_prompt.ms_per_minute'))) });
  var who = '';
  var from = oldest && oldest.from != null ? String(oldest.from) : '';
  var t = titleFor(from);
  who = (typeof t === 'string' && t.trim()) ? piTruncate(t.replace(/\s+/g, ' ').trim()) : (from ? piShortId(from) : '');
  var preview = '';
  var rawp = oldest && previews && piFinite(oldest.seq) ? previews[oldest.seq] : null;
  if (typeof rawp === 'string') {
    var clean = rawp.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (jx.loneSurrogate(clean)) { ah.unable('devswarm-parent-inbox:preview_surrogate'); clean = hookProc.usv(clean); }
    preview = ahHost.scrubSecrets(clean).slice(0, ah.cfgNum('devswarm_parent.preview_max'));
  }
  if (who || preview) line += text.render(ah.cfg('devswarm_parent.awaiting_who'), { who: who, sep: preview ? (who ? ah.cfg('devswarm_parent.awaiting_sep') : '') : '', preview: preview });
  return line + '\n';
}

// `buildInformationalNote(informational, cli)`.
function piInfoNote(list, cli) {
  if (!list.length) return '';
  var unknown = ah.cfg('devswarm_parent.unknown_sender');
  var ids = [];
  list.forEach(function (q) {
    var v = (q && q.from != null && String(q.from).trim() !== '') ? String(q.from) : unknown;
    if (ids.indexOf(v) < 0) ids.push(v);
  });
  var runnable = ids.filter(function (x) { return x !== unknown; });
  var tail = runnable.length ? text.render(ah.cfg('devswarm_parent.info_tail_runnable'), { cli: cli, id: runnable[0] }) : ah.cfg('devswarm_parent.info_tail_none');
  return text.render(ah.cfg('devswarm_parent.info_note'), { ids: ids.join(', '), tail: tail });
}

// `buildOwnUnreadSegmentBody(...)` with the awaiting line in front.
function piOwnSegment(count, id, urgency, unanswered, informational, titleFor, previews, cli, now) {
  var prefix = ah.cfg(piHigh(urgency) ? 'devswarm_parent.own_prefix_urgent' : 'devswarm_parent.own_prefix');
  var info = piInfoNote(informational, cli);
  var max = ah.cfgNum('devswarm_parent.max_listed');
  var askers = unanswered.slice(0, max).map(function (q) { return (q && q.from != null) ? String(q.from) : ah.cfg('devswarm_parent.asker_unknown'); }).join(', ');
  var extra = unanswered.length > max ? text.render(ah.cfg('devswarm_parent.unread_extra'), { n: unanswered.length - max }) : '';
  var body;
  if (count > 0) {
    body = text.render(ah.cfg('devswarm_parent.own_unread'), { prefix: prefix, count: count, cli: cli, id: id });
    if (unanswered.length > 0) {
      var n = unanswered.length;
      var clause = n <= count
        ? (n === 1 ? ah.cfg('devswarm_parent.q_of_these_one') : text.render(ah.cfg('devswarm_parent.q_of_these_many'), { n: n }))
        : (n === 1 ? ah.cfg('devswarm_parent.q_remain_one') : text.render(ah.cfg('devswarm_parent.q_remain_many'), { n: n }));
      body += text.render(ah.cfg('devswarm_parent.own_reply_clause'), { text: clause, askers: askers, extra: extra, cli: cli });
    }
    body += info;
  } else if (unanswered.length > 0) {
    body = text.render(ah.cfg('devswarm_parent.own_read_unanswered'), { prefix: prefix, n: unanswered.length, askers: askers, extra: extra, cli: cli }) + info;
  } else {
    body = text.render(ah.cfg('devswarm_parent.own_read_all'), { prefix: prefix }) + info;
  }
  return piAwaitingLine(unanswered, titleFor, now, previews) + body;
}

// ---- the project of a Primary in a checkout ---------------------------------------------------------------------------------

// The cause of a deferral for everything the hook would show or do that the engine does not reproduce yet, or null. Everything it reads is
// read before the first write of the turn.
function piDecide(p, opts) {
  if (devswarmGate.silent(false, 'devswarm_prompt.parent_setting')) return 'allow';
  // An active Primary. With a working directory the hook resolves the checkout around it; with none it has no project identity either.
  var cwd = jx.isObj(p) && typeof p.cwd === 'string' && p.cwd !== '' ? p.cwd : null;
  var top = null, primaryId = null;
  if (cwd !== null) {
    if (cwd.charAt(0) !== '/') { ah.unable('devswarm-parent-inbox:relative_cwd'); cwd = hookProc.cwd(p); } // resolved against the stand-in directory
    var c = ah.repo.context(cwd);
    if (c.unsure) return piDefer('repo-context');
    if (c.root !== null) {
      var idn = ah.mesh.ident(cwd);
      if (idn.top === null || idn.own === null) return piDefer('identity');
      top = idn.top;
      primaryId = idn.own;
    }
  }
  var home = spawn.osHome();
  if (home === null) return piDefer('home');
  var sid = dpSession(p);
  var tp = jx.isObj(p) && typeof p.transcript_path === 'string' ? p.transcript_path : null;
  if (tp !== null && tp !== '' && tp.charAt(0) !== '/') { ah.unable('devswarm-parent-inbox:relative_transcript'); tp = hookProc.open(p, tp); } // opened against the stand-in directory
  // the seat marker is read before anything is written: a marker still owed a repeat is Node's
  if (sid !== null && dpSeatMarker(home, sid) === 'repeat') return piDefer('seat-marker');
  var now = ah.clock.now();
  var every = ah.settings.num('verify_first.num_repeat_every');
  var repeat = isFinite(every) && every > 0 ? every : 0;
  var noticeSeg = null, summaryForTitle = null, ownUnanswered = [], ownInfo = [], ownPreviews = {}, syncNotes = null, ownUnread = 0, ownUrgency = null, orphansSeg = null, orphansSig = null, staleRegSeg = null, broadcastRows = null, parked = null, roster = null, key = null, health = null, banner = null, wakeLine = null, driftNotice = null, derived = null;
  if (top !== null) {
    var cli = piCli(opts, home);
    if (cli === null) return piDefer('cli');
    key = ah.mesh.repoKey(top);
    if (key === null) return piDefer('repo-key');
    var dev = piDevswarmDir(home);
    // the ingest daemon: when it is not healthy the hook refreshes the summary from the store (a write), which the engine leaves to Node
    health = JSON.parse(ahHost.ctIngest(key));
    if (health.unsure) { ah.unable('devswarm-parent-inbox:ingest_health'); health = { unsure: false, status: 'healthy' }; } // no ingest banner when the health is unsure
    // when it is not healthy the hook refreshes the summary from the store first; the refresh is written once the turn is settled
    if (health.status !== 'healthy') {
      var dr = JSON.parse(ahHost.piDerive(key, now));
      if (dr.unsure) ah.unable('devswarm-parent-inbox:summary_refresh'); // the summary is not refreshed this turn
      else derived = dr.text;
    }
    var sm = derived !== null ? piParseSummary(derived) : piReadSummary(home, key);
    if (sm.cause) { ah.unable('devswarm-parent-inbox:' + sm.cause.replace(/-/g, '_')); ah.log(ah.cfg('devswarm_parent.defer_log_kind'), sm.cause); sm = {}; } // an empty, invalid or unreadable summary is no summary
    var summary = sm.summary || null;
    summaryForTitle = summary;
    if (summary !== null) {
      if (Array.isArray(summary)) return piDefer('summary-shape'); // a list is not a summary: nothing to show
      var ctx = { home: home, key: key, top: top, primaryId: primaryId, now: now, sid: sid, pluginRoot: gates.pluginRoot(opts), newest: { known: false, value: null } };
      roster = piRoster(ctx, summary);
      // the Primary's own inbound mail, the questions it was asked, and what the summary lists beside the rows
      var own = summary.workspaces && summary.workspaces[primaryId] ? summary.workspaces[primaryId] : summary[primaryId];
      if (own && typeof own === 'object') {
        if (piFinite(own.unread) && own.unread > 0) {
          // the unread count is corrected by this reader's own cursor, found from the hook's process ancestry, which the daemon does not share
          var rd = JSON.parse(ahHost.ctReaders(key, primaryId));
          if (rd.unsure || rd.declared) ah.unable('devswarm-parent-inbox:own_reader'); // the reader-identity correction is not made: the summary count is shown as it is
          ownUnread = own.unread;
          ownUrgency = own.urgencyMax || null;
        }
        if (Array.isArray(own.pendingQuestions)) {
          ownPreviews = own.pendingQuestionPreviews && typeof own.pendingQuestionPreviews === 'object' ? own.pendingQuestionPreviews : {};
          if (own.pendingQuestions.length) {
            var qs = piQuestions({ home: home, key: key, primaryId: primaryId, now: now }, summary, own.pendingQuestions);
            ownUnanswered = qs.blocking;
            ownInfo = qs.informational;
          }
        }
      }
      if (roster.ownExtra > 0) { ownUnread += roster.ownExtra; if (!ownUrgency) ownUrgency = roster.ownExtraUrgency; }
      if (Array.isArray(summary.recent) && summary.recent.length && ahHost.piJev()) ah.unable('devswarm-parent-inbox:broadcast_jev'); // Jev may label the feed: shown unlabelled
      if (roster.rows.length) syncNotes = piSyncNotes({ home: home, key: key }, roster.rows, roster.snapUnreadable, jx.isObj(p) ? p.session_id : undefined);
    }
    noticeSeg = /^[A-Za-z0-9._-]+$/.test(key) ? piNotices(home, key, now) : null;
    if (summary !== null) {
      if (Array.isArray(summary.orphans) && summary.orphans.length) {
        orphansSeg = piIssueSegment(summary.orphans, 'devswarm_parent.orphans_head');
        if (orphansSeg !== null && ah.settings.bool('devswarm_parent.sw_orphans_once') === true) {
          orphansSig = piOrphansSig(summary.orphans);
          if (piOrphansSeen(jx.isObj(p) ? p.session_id : undefined, orphansSig)) {
            orphansSeg = null;
            orphansSig = null;
            ah.metric('devswarm_orphans_warning_suppressed', ['reason', 'seen_this_session']);
            ah.advisory('devswarm_parent_inbox', 'orphans_suppressed_seen');
          }
        }
      }
      if (Array.isArray(summary.staleRegistryPartitions) && summary.staleRegistryPartitions.length) {
        var visible = summary.staleRegistryPartitions.filter(function (row) {
          if (!row || row.id == null) return true;
          var a = JSON.parse(ahHost.piApp(String(row.id), piStrField(row.worktreePath), key, now));
          if (a.unsure) { ah.unable('devswarm-parent-inbox:stale_reg_app'); return true; } // not provably archived: still listed
          if (!a.archived && ah.settings.bool('devswarm_parent.set_notice_ignore_dead') === true && piSafeId(String(row.id))) {
            var why = null;
            try {
              if (piPresent(piDevswarmDir(home) + '/' + ah.cfg('mesh_write.dir_archived') + '/' + row.id + '.json')) why = 'archived'; // anti-hall's own archive marker
              else if (piDeadHint(home, String(row.id), piStrField(row.worktreePath), null, null)) why = 'dead_hint'; // a hint no live evidence beats
            } catch (e) { ah.unable('devswarm-parent-inbox:dead_row_decide'); why = null; }
            if (why !== null) { ah.metric('devswarm_notice_rows_ignored', ['reason', why]); return false; } // put away, not actionable (GH #508)
          }
          return !a.archived;
        });
        if (visible.length) staleRegSeg = piIssueSegment(visible, 'devswarm_parent.stale_registry_head');
      }
      if (Array.isArray(summary.recent) && summary.recent.length) {
        var br = piBroadcastRows(summary.recent, home, jx.isObj(p) ? p.session_id : undefined, now);
        if (br.rows.length) broadcastRows = br;
      }
    }
    if (roster !== null && roster.rows.length) banner = piIngest(health, key, now, sid, tp);
    wakeLine = piWakeLine({ home: home, primaryId: primaryId, now: now }, cwd, cli, opts);
    driftNotice = piDriftNotice(home, top, primaryId, sid, tp);
    parked = piParked(home, primaryId, cli);
  }
  // The dedupe records are consulted in the order the hook does (the ingest banners come before the override reminder), and the answer
  // is assembled in the order of its segments (`rank`).
  var text0 = ah.cfg('devswarm_prompt.override_reassert');
  var overrideOpts = { sessionId: sid, key: ah.cfg('devswarm_prompt.override_key'), content: text0, transcriptPath: tp, keepaliveTurns: repeat };
  var pending = []; // {kind, rank, o?, text}
  if (noticeSeg !== null) pending.push({ kind: 'plain', rank: ah.cfgNum('devswarm_parent.notice_rank'), text: noticeSeg.text });
  if (banner !== null) {
    if (banner.fault) {
      pending.push({ kind: 'dedupe', rank: 10, o: banner.fault, text: banner.fault.content, onSuppress: function () { piForget(sid, ah.cfg('devswarm_prompt.stale_key')); } });
    } else {
      pending.push({ kind: 'forget', key: ah.cfg('devswarm_prompt.fault_key') });
      if (banner.stale) pending.push({ kind: 'dedupe', rank: 10, o: banner.stale, text: banner.stale.content });
      else pending.push({ kind: 'forget', key: ah.cfg('devswarm_prompt.stale_key') });
    }
  }
  pending.push({ kind: 'dedupe', rank: 0, o: overrideOpts, text: text0 });
  if (wakeLine !== null) pending.push({ kind: 'dedupe', rank: 20, o: { sessionId: sid, key: ah.cfg('devswarm_parent.key_wake'), content: wakeLine, transcriptPath: tp, keepaliveTurns: repeat }, text: wakeLine });
  if (driftNotice !== null) pending.push({ kind: 'dedupe', rank: 50, o: { sessionId: sid, key: ah.cfg('devswarm_parent.key_drift'), content: driftNotice, transcriptPath: tp, keepaliveTurns: ah.cfgNum('devswarm_parent.drift_keepalive') }, text: driftNotice });
  var tableText = null, attention = [], archiveList = [], rows = [];
  if (roster !== null) {
    rows = roster.rows;
    attention = roster.attention;
    archiveList = roster.archiveList;
  }
  var maxRows = ah.cfgNum('devswarm_parent.max_table_rows');
  var tableWrites = [];
  if (rows.length) {
    var appRankOf = function (r) { return piFinite(r.appRank) ? r.appRank : Infinity; };
    rows.sort(function (a, b) {
      return (a.rank - b.rank) || (b.unread - a.unread) || ((appRankOf(a) - appRankOf(b)) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    var archivedHidden = 0;
    var hide = String(ah.env.get(ah.cfg('devswarm_parent.env_roster_hide')) || '') !== ah.cfg('devswarm_parent.roster_hide_off');
    var archivedWord = piLabel('archived').label;
    var activeRows = hide ? rows.filter(function (r) { if (r.label === archivedWord) { archivedHidden += 1; return false; } return true; }) : rows;
    var capEnv = ah.env.get(ah.cfg('devswarm_parent.env_roster_max'));
    var capRaw = Number(capEnv === null ? undefined : capEnv);
    var cap = isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : maxRows;
    var capped = activeRows.length > cap;
    var shownRows = capped ? activeRows.slice(0, cap) : activeRows;
    var evicted = capped ? activeRows.slice(cap) : [];
    if (capped) tableWrites.push({ event: 'table-cap', total: activeRows.length, shown: shownRows.length, hidden: activeRows.length - shownRows.length });
    if (shownRows.length) { // no live row: nothing to show (a table of only "+N archived" is not sent)
      tableText = piTable(shownRows, now, capped, activeRows.length - shownRows.length, evicted, archivedHidden, maxRows); // the text names the default cap, as Node's does
      pending.push({ kind: 'dedupe', rank: 60, o: { sessionId: sid, key: 'parent-inbox-table', content: tableText, transcriptPath: tp, keepaliveTurns: repeat, normalize: piNormTable }, text: tableText, after: ah.cfg('devswarm_parent.title_instruction') });
    }
  }
  if (syncNotes !== null) syncNotes.texts.forEach(function (n) { pending.push({ kind: 'plain', rank: n.rank, text: n.text }); });
  var urgentList = attention.filter(function (w) { return piTier(w) === 'urgent'; });
  var normalList = attention.filter(function (w) { return piTier(w) === 'normal'; });
  if (orphansSeg !== null) pending.push({ kind: 'dedupe', rank: 80, o: { sessionId: sid, key: ah.cfg('devswarm_parent.key_orphans'), content: orphansSeg, transcriptPath: tp, keepaliveTurns: ah.cfgNum('devswarm_parent.mesh_issue_keepalive') }, text: orphansSeg });
  if (staleRegSeg !== null) pending.push({ kind: 'dedupe', rank: 90, o: { sessionId: sid, key: ah.cfg('devswarm_parent.key_stale_registry'), content: staleRegSeg, transcriptPath: tp, keepaliveTurns: ah.cfgNum('devswarm_parent.mesh_issue_keepalive') }, text: staleRegSeg });
  if (broadcastRows !== null) pending.push({ kind: 'plain', rank: 100, text: piBroadcastSegment(broadcastRows.rows) });
  var cliPath = top !== null ? piCli(opts, home) : null;
  if ((ownUnread > 0 || ownUnanswered.length > 0 || ownInfo.length > 0) && primaryId) {
    var titleFor = function (wid) {
      var row = summaryForTitle && summaryForTitle.workspaces && summaryForTitle.workspaces[wid];
      return (row && row.label) || piReadName(home, wid);
    };
    pending.push({ kind: 'plain', rank: 110, text: piOwnSegment(ownUnread, primaryId, ownUrgency, ownUnanswered, ownInfo, titleFor, ownPreviews, cliPath, ah.clock.now()) });
  }
  if (parked !== null) pending.push({ kind: 'plain', rank: 120, text: parked });
  if (urgentList.length) {
    var us = piUrgentSegment(urgentList, home, cliPath);
    pending.push({ kind: 'dedupe', rank: 130, o: { sessionId: sid, key: 'parent-inbox-urgent', content: us, transcriptPath: tp, keepaliveTurns: 10 }, text: us });
  }
  if (normalList.length) {
    var ns = piUnreadSegment(normalList, home, cliPath, now);
    pending.push({ kind: 'dedupe', rank: 140, o: { sessionId: sid, key: 'parent-inbox-nudge', content: ns, transcriptPath: tp, normalize: piNormInbox, keepaliveTurns: 2 }, text: ns, suppressedLog: normalList.some(function (w) { return w.notDraining; }) });
  }
  if (archiveList.length) pending.push({ kind: 'plain', rank: 150, text: piArchiveSegment(archiveList, cliPath) });
  // every dedupe record must be decidable before the first write
  var dedupeOn = sid !== null && !dedupe.disabled();
  for (var i = 0; i < pending.length; i++) {
    if (pending[i].kind === 'dedupe' && dedupeOn && !dedupe.canDecide(pending[i].o)) ah.unable('devswarm-parent-inbox:dedupe_undecidable'); // decided on what the engine reads
  }
  ah.commit();
  if (syncNotes !== null) syncNotes.writes.forEach(function (w) { ah.state.writeAtomic(w.rel, JSON.stringify({ at: now, ids: w.ids })); });
  if (broadcastRows !== null && broadcastRows.seen !== null) ah.state.writeAtomic(piBroadcastSeenRel(jx.isObj(p) ? p.session_id : undefined), JSON.stringify({ keys: broadcastRows.seen.slice(-ah.cfgNum('devswarm_parent.broadcast_seen_max')) }));
  if (derived !== null) ah.state.writeAtomic(piRel(ah.cfg('devswarm_role.pg_dir_summaries') + '/' + key + '.json'), derived);
  if (orphansSig !== null) ah.state.writeAtomic(piOrphansSeenRel(jx.isObj(p) ? p.session_id : undefined), JSON.stringify({ sig: orphansSig, at: now })); // shown once per id set per session
  if (noticeSeg !== null) ah.state.writeAtomic(piRel(ah.cfg('devswarm_parent.dir_notice_cursor') + '/' + key + '.json'), JSON.stringify({ lastSeenId: noticeSeg.lastId })); // shown once, marked seen
  var emitted = [];
  pending.forEach(function (s) {
    if (s.kind === 'forget') { piForget(sid, s.key); return; }
    if (s.kind === 'plain') { emitted.push({ rank: s.rank, text: s.text }); return; }
    var emit = !dedupeOn || dedupe.shouldEmit(s.o);
    if (emit) { emitted.push({ rank: s.rank, text: s.text }); if (s.after) emitted.push({ rank: s.rank, text: s.after }); } else if (s.onSuppress) s.onSuppress();
  });
  var segments = emitted.map(function (e, i) { return { r: e.rank, i: i, t: e.text }; }).sort(function (a, b) { return (a.r - b.r) || (a.i - b.i); }).map(function (e) { return e.t; });
  // the acceptance telemetry and the archive-recommendation records
  tableWrites.forEach(function (w) { ah.state.appendFile(piRel(ah.cfg('devswarm_parent.file_log')), JSON.stringify({ ts: Math.floor(ah.clock.now()), event: w.event, total: w.total, shown: w.shown, hidden: w.hidden }) + '\n'); });
  var totalUnread = attention.reduce(function (s, w) { return s + w.unread; }, 0);
  if (attention.length && totalUnread > 0) {
    var inj = attention.filter(function (w) { return w.unread > 0; }).map(function (w) { return { id: w.id, unread: w.unread, cursor: w.cursor, total: w.total, status: w.status || null }; });
    ah.state.appendFile(piRel(ah.cfg('devswarm_parent.file_log')), JSON.stringify({ ts: Math.floor(ah.clock.now()), event: 'inject', workspaces: inj }) + '\n');
  }
  archiveList.forEach(function (id) { ah.state.writeAtomic(piRel(ah.cfg('devswarm_parent.dir_archive_nudges') + '/' + id + '.json'), JSON.stringify({ lastNudgedAt: now })); });
  if (!segments.length) return 'allow';
  return { advisory: text.advisoryJson(ah.cfg('devswarm_prompt.event'), segments.join(ah.cfg('devswarm_parent.segment_joiner'))) };
}

function decide(p, opts) {
  return piDecide(p, opts);
}
