// Shared helpers of the emit-dedupe store (mirror hooks/lib/emit-dedupe.js): the per-session state file the UserPromptSubmit hooks
// share and the context-loss marker. Files, limits and switches: prompt_emit.toml (emit_dedupe.*).
'use strict';
var dedupe = {
  // `disabled()`: guards.emitDedupe is off, or context.dedupeWindowMin is 0.
  disabled: function () { return !ah.settings.bool('emit_dedupe.sw_enabled') || ah.settings.num('emit_dedupe.num_window_min') === 0; },
  stateRel: function (sessionId) {
    var safe = String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfgNum('emit_dedupe.session_safe_max'));
    return ah.cfg('emit_dedupe.state_dir') + '/' + ah.cfg('emit_dedupe.file_prefix') + '-' + safe + '.json';
  },
  readState: function (rel) {
    var raw = ah.state.readText(rel);
    if (raw === null) return {};
    try { var o = JSON.parse(raw); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
  },
  // Merge one key into the session file (re-read right before the write), drop keys unseen for the TTL, write atomically.
  // false when the file could not be written.
  writeEntry: function (sessionId, key, entry, now) {
    var rel = dedupe.stateRel(sessionId), state = dedupe.readState(rel);
    state[key] = entry;
    Object.keys(state).forEach(function (k) {
      var e = state[k], seen = e && typeof e.lastSeenAt === 'number' && isFinite(e.lastSeenAt) ? e.lastSeenAt : 0;
      if (now - seen > ah.cfgNum('emit_dedupe.key_ttl_ms')) delete state[k];
    });
    var ok = false;
    try { ok = ah.state.writeAtomic(rel, JSON.stringify(state), { leaveTemp: true }); } catch (e) { return false; }
    if (ok) gk.pruneStale(rel.slice(0, rel.lastIndexOf('/')), ah.cfg('emit_dedupe.file_prefix'));
    return ok;
  },
  // `resetSession`: mark a context loss, so every record emitted before now counts as absent.
  reset: function (sessionId) {
    if (dedupe.disabled() || !sessionId) return;
    var now = ah.clock.now();
    dedupe.writeEntry(sessionId, ah.cfg('emit_dedupe.reset_key'), { resetAt: now, lastSeenAt: now }, now);
  },
  // `exactId(content)`: the hash of the exact emitted text and its segment count.
  exactId: function (content) {
    var t = String(content == null ? '' : content);
    return { ch: ah.sha1(t), k: t.split(ah.cfg('emit_dedupe.segment_sep')).length };
  },
  tpId: function (tp) { return tp && typeof tp === 'string' ? ah.sha1(tp).slice(0, 16) : null; },
  // Some attachment content element IS the emitted string, or holds it as a run of k whole separator-delimited segments.
  matchesExact: function (els, ch, k) {
    var sep = ah.cfg('emit_dedupe.segment_sep');
    for (var i = 0; i < els.length; i++) {
      if (ah.sha1(els[i]) === ch) return true;
      var pieces = els[i].split(sep);
      for (var j = 0; j + k <= pieces.length; j++) if (ah.sha1(pieces.slice(j, j + k).join(sep)) === ch) return true;
    }
    return false;
  },
  // The UserPromptSubmit hook_additional_context attachments in the last `bytes` of the transcript: {atts, size}, null when the tail cannot
  // be used (missing, empty, or no timestamp anywhere in it), or {unsure: true} when an attachment's timestamp is in a form only V8 reads
  // exactly (the decision then defers). Memoized per call.
  scanMemo: {},
  scanTail: function (tp, bytes) {
    var mk = tp + '\0' + bytes;
    if (Object.prototype.hasOwnProperty.call(dedupe.scanMemo, mk)) return dedupe.scanMemo[mk];
    // The host reads the window and returns the delivered attachments (a 4 MB window is far past the script's CPU limit line by line).
    var raw = ahHost.transcriptDedupeTail(tp, bytes), result = raw === null || raw === undefined ? null : JSON.parse(raw);
    dedupe.scanMemo[mk] = result;
    return result;
  },
  // true / false, null (unknown), or 'unsure' (a timestamp only V8 reads exactly): does some attachment in the tail (widened once to the
  // wide window) satisfy `pred`?
  findInTail: function (tp, pred) {
    if (!tp || typeof tp !== 'string') return null;
    var small = ah.cfgNum('emit_dedupe.tail_bytes'), t = dedupe.scanTail(tp, small);
    if (!t) return null;
    if (t.unsure) return 'unsure';
    if (t.atts.some(pred)) return true;
    var any = t.atts.length > 0;
    if (t.size > small) {
      var w = dedupe.scanTail(tp, ah.cfgNum('emit_dedupe.tail_bytes_wide'));
      if (w && w.unsure) return 'unsure';
      if (w) { if (w.atts.some(pred)) return true; any = any || w.atts.length > 0; }
    }
    return any ? false : null;
  },
  // guards.keepaliveCountsScheduled: true restores the old rule (a scheduled turn counts toward the keepalive like any other).
  countsScheduled: function () { return ah.settings.bool('emit_dedupe.sw_counts_scheduled'); },
  // The turns of the transcript newer than `afterTs` that count toward a keepalive: {n, sched, maxTs}, or null when the tail holds no user turn
  // that names its origin (or cannot be read), so the caller counts the old way. Scheduled turns (emit_dedupe.uncounted_origins) are
  // passed over: they advance `maxTs` and are counted in `sched`, but not in `n`.
  countedTurns: function (tp, afterTs) {
    if (!tp || typeof tp !== 'string') return null;
    var r = ah.transcript.grep(tp, ah.cfgNum('emit_dedupe.tail_bytes_wide'), ah.cfg('emit_dedupe.origin_needles'), '', '');
    if (!r || r.unsure || !Array.isArray(r.lines)) return null;
    var field = ah.cfg('emit_dedupe.origin_field'), skip = ah.cfg('emit_dedupe.uncounted_origins');
    var n = 0, sched = 0, maxTs = afterTs, seen = false;
    r.lines.forEach(function (line) {
      var rec;
      try { rec = JSON.parse(line); } catch (e) { return; }
      if (!rec || rec.type !== ah.cfg('emit_dedupe.origin_record_type') || typeof rec[field] !== 'string') return;
      seen = true;
      var ts = Date.parse(rec[ah.cfg('emit_dedupe.origin_ts_field')]);
      if (!isFinite(ts) || ts <= afterTs) return;
      if (skip.indexOf(rec[field]) < 0) n += 1; else sched += 1;
      if (ts > maxTs) maxTs = ts;
    });
    return seen ? { n: n, sched: sched, maxTs: maxTs } : null;
  },
  // Whether the prompt now submitted is a turn the host scheduler delivered: the newest user turn of the transcript names a scheduled origin
  // (emit_dedupe.uncounted_origins) and its text is this prompt. A person's prompt differs from the cron's text, so it never reads as scheduled;
  // a transcript that cannot be read, shows no origin, or does not yet hold this turn reads as not scheduled (the caller then acts as before).
  scheduledTurn: function (tp, prompt) {
    if (!tp || typeof tp !== 'string' || typeof prompt !== 'string' || prompt.trim() === '') return false;
    var r = ah.transcript.grep(tp, ah.cfgNum('emit_dedupe.tail_bytes_wide'), ah.cfg('emit_dedupe.origin_needles'), '', '');
    if (!r || r.unsure || !Array.isArray(r.lines)) return false;
    var field = ah.cfg('emit_dedupe.origin_field'), last = null;
    r.lines.forEach(function (line) {
      var rec;
      try { rec = JSON.parse(line); } catch (e) { return; }
      if (rec && rec.type === ah.cfg('emit_dedupe.origin_record_type') && typeof rec[field] === 'string') last = rec;
    });
    if (last === null || ah.cfg('emit_dedupe.uncounted_origins').indexOf(last[field]) < 0) return false;
    var c = last.message ? last.message.content : null;
    var body = typeof c === 'string' ? c : Array.isArray(c) ? c.map(function (b) { return b && typeof b.text === 'string' ? b.text : ''; }).join('') : '';
    return body.trim() === prompt.trim();
  },
  windowMs: function () {
    var mins = ah.settings.num('emit_dedupe.num_window_min');
    return isFinite(mins) && mins > 0 ? mins * ah.cfgNum('emit_dedupe.ms_per_minute') : ah.cfgNum('emit_dedupe.window_default_ms');
  },
  // `shouldEmit({sessionId, key, content, transcriptPath, keepaliveTurns, readPath})`: false when the block is a repeat the model
  // already holds. Anything that cannot be persisted emits. `readPath` (optional) is the path the transcript is opened at when the
  // payload's is relative (hookProc.open); the record still names the payload's own path, as Node's does.
  shouldEmit: function (o) {
    var r = dedupe.evaluate(o, true);
    if (r === 'unsure') throw new Error('emit-dedupe: a transcript timestamp only JavaScript reads exactly');
    return r;
  },
  // Whether the store can decide this block exactly (false: a transcript timestamp only V8 reads exactly, so the caller defers). Writes nothing.
  canDecide: function (o) { return dedupe.evaluate(o, false) !== 'unsure'; },
  // The decision of `shouldEmit` (true / false, or 'unsure'); with `commit` false nothing is written.
  evaluate: function (o, commit) {
    dedupe.scanMemo = {}; // the memo lives for one decision: the context outlives the request, and a transcript grows between requests
    if (dedupe.disabled()) return true;
    if (!o.sessionId || !o.key) return true;
    var now = ah.clock.now(), windowMs = dedupe.windowMs(), maxPending = ah.cfgNum('emit_dedupe.max_pending_ms'), tol = ah.cfgNum('emit_dedupe.ts_tolerance_ms');
    var keepalive = typeof o.keepaliveTurns === 'number' && isFinite(o.keepaliveTurns) && o.keepaliveTurns > 0 ? o.keepaliveTurns : 0;
    var content = o.content == null ? '' : String(o.content), hash = ah.sha1(typeof o.normalize === 'function' ? String(o.normalize(content)) : content), key = String(o.key);
    var tp = dedupe.tpId(o.transcriptPath), rel = dedupe.stateRel(o.sessionId), state = dedupe.readState(rel), prev = state[key];
    var rk = ah.cfg('emit_dedupe.reset_key');
    var resetAt = state[rk] && typeof state[rk].resetAt === 'number' && isFinite(state[rk].resetAt) ? state[rk].resetAt : 0;
    var fin = function (v) { return typeof v === 'number' && isFinite(v); };
    var prevOk = prev && typeof prev.hash === 'string' && fin(prev.lastEmittedAt) && prev.lastEmittedAt <= now && prev.lastEmittedAt >= resetAt && (prev.tp || null) === tp;
    var same = prevOk && prev.hash === hash, lastSeen = prevOk && fin(prev.lastSeenAt) ? prev.lastSeenAt : 0, turns = prevOk && fin(prev.turnsSinceEmit) ? prev.turnsSinceEmit : 0;
    var emit = true, nextTurns = 0, ctNext = null;
    if (same) {
      var since = prev.lastEmittedAt - tol, ch = typeof prev.ch === 'string' ? prev.ch : '', k = fin(prev.k) && prev.k > 0 ? prev.k : 1;
      var consumed = dedupe.findInTail(o.readPath || o.transcriptPath, function (a) { return a.ts >= since && !!ch && dedupe.matchesExact(a.els, ch, k); });
      if (consumed === 'unsure') return 'unsure';
      if (consumed === null) {
        if ((now - prev.lastEmittedAt) < windowMs) { emit = false; nextTurns = turns; }
        else if (keepalive > 0) {
          var newTurn = (now - lastSeen) >= ah.cfgNum('emit_dedupe.window_default_ms');
          if (!(newTurn && turns >= keepalive)) { emit = false; nextTurns = turns + (newTurn ? 1 : 0); }
        }
      } else if (!consumed) {
        if ((now - prev.lastEmittedAt) < maxPending) { emit = false; nextTurns = turns; }
      } else if (keepalive > 0) {
        // #709: a cron-delivered (scheduled) turn is not a turn the model needs a reminder for. Unless guards.keepaliveCountsScheduled is
        // on, count the user turns of the transcript that are not scheduled and are newer than the last one counted (`ct`, absent until the first count: then the emit time); a wall-clock
        // floor (guards.injectionRepeatMinS) still re-shows the block in a session that only ever sees scheduled turns. A transcript
        // that shows no turn origin (another host, an old file) counts as before: one turn per call that finds a delivery.
        var counted = dedupe.countsScheduled() ? null : dedupe.countedTurns(o.readPath || o.transcriptPath, fin(prev.ct) ? prev.ct : lastSeen);
        var t;
        if (counted !== null) { t = turns + counted.n; ctNext = counted.maxTs; }
        else {
          var nt = dedupe.findInTail(o.readPath || o.transcriptPath, function (a) { return a.ts >= lastSeen - tol; });
          if (nt === 'unsure') return 'unsure';
          t = turns + (nt === true ? 1 : 0);
        }
        var floorS = ah.settings.num('emit_dedupe.num_repeat_min_s');
        var floorHit = counted !== null && isFinite(floorS) && floorS > 0 && (now - prev.lastEmittedAt) >= floorS * ah.cfgNum('emit_dedupe.ms_per_second');
        if (t > keepalive || floorHit) emit = true; else {
          emit = false; nextTurns = t;
          // each evaluation that passed over a scheduled turn and still suppressed the block is one repeat of an unchanged advisory that
          // the old rule (every delivered turn counts) moved toward re-sending: counted once, whatever the keepalive length
          if (commit && counted !== null && counted.sched > 0) waste.note(o.sessionId, 'repeated_advisory', 'keepalive_scheduled', content.length);
        }
      }
    }
    var entry = emit
      ? Object.assign({ hash: hash, tp: tp, lastEmittedAt: now, lastSeenAt: now, turnsSinceEmit: 0 }, dedupe.exactId(content))
      : { hash: prev.hash, tp: prev.tp || null, ch: prev.ch, k: prev.k, lastEmittedAt: prev.lastEmittedAt, lastSeenAt: now, turnsSinceEmit: nextTurns, ct: ctNext !== null ? ctNext : prev.ct };
    if (!commit) return emit;
    if (!dedupe.writeEntry(o.sessionId, key, entry, now)) return true;
    if (!emit) dedupe.bumpSuppressed(o.sessionId, now);
    return emit;
  },
  // `record(opts)`: record an emit the caller makes regardless, so that later lookalikes still pending are suppressed. A write that fails
  // is lost silently, as in Node.
  record: function (o) {
    if (dedupe.disabled() || !o.sessionId || !o.key) return;
    var now = ah.clock.now(), content = o.content == null ? '' : String(o.content);
    var hash = ah.sha1(typeof o.normalize === 'function' ? String(o.normalize(content)) : content);
    dedupe.writeEntry(o.sessionId, String(o.key), Object.assign({ hash: hash, tp: dedupe.tpId(o.transcriptPath), lastEmittedAt: now, lastSeenAt: now, turnsSinceEmit: 0 }, dedupe.exactId(content)), now);
  },
  bumpSuppressed: function (sessionId, now) {
    var state = dedupe.readState(dedupe.stateRel(sessionId)), sk = ah.cfg('emit_dedupe.stats_key'), prev = state[sk];
    var count = prev && typeof prev.suppressed === 'number' && isFinite(prev.suppressed) ? prev.suppressed : 0;
    dedupe.writeEntry(sessionId, sk, { suppressed: count + 1, lastSeenAt: now, lastSuppressedAt: now }, now);
  },
};
