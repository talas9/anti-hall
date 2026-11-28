// Shared helpers of the guard-kit checks (mirror hooks/lib/turn-gate.js and hooks/lib/state-prune.js): the "already shown this
// turn?" gate and the throttled retention sweep of a state sub-directory. Rules and limits: small_guards.toml (turn_gate.*,
// guardkit.prune_*).
'use strict';
var gk = {
  // A regular expression from a defaults entry (JavaScript syntax), compiled once per context.
  reMemo: {},
  re: function (key, flags) {
    var id = key + '/' + (flags || '');
    if (!gk.reMemo[id]) gk.reMemo[id] = new RegExp(ah.cfg(key), flags || '');
    return gk.reMemo[id];
  },
  // `pruneStale`: at most once per throttle window, drop the state files `<prefix>-*` of a sub-directory (relative to the home
  // directory) that are older than the TTL. The live session's file is the newest, so it never goes.
  // Whether the next `pruneStale(dirRel, prefix)` would meet a stale `<prefix>-*` entry that is a symbolic link. Node's sweep
  // (`fs.statSync` + `fs.unlinkSync`) ages a link by its target and unlinks it; the host never removes a link (`stateRemove`
  // refuses one), so a caller defers to Node before writing anything when this is true.
  pruneMeetsLink: function (dirRel, prefix) {
    try {
      var now = ah.clock.now(), stamp = dirRel + '/' + text.render(ah.cfg('guardkit.prune_stamp'), { prefix: prefix });
      var raw = ah.state.readText(stamp);
      if (raw !== null && raw.trim() !== '') {
        try {
          var last = JSON.parse(raw.trim())[ah.cfg('guardkit.prune_stamp_key')];
          if (typeof last === 'number' && isFinite(last) && last <= now && (now - last) < ah.cfgNum('guardkit.prune_throttle_ms')) return false;
        } catch (e) { /* corrupt stamp: the sweep runs */ }
      }
      var names = ah.fs.listDir(ah.home() + '/' + dirRel), ttl = ah.cfgNum('guardkit.prune_ttl_ms'), ext = ah.cfg('guardkit.state_ext');
      for (var i = 0; names && i < names.length; i++) {
        var n = names[i], full = ah.home() + '/' + dirRel + '/' + n;
        if (n.indexOf(prefix + '-') !== 0 || n.slice(-ext.length) !== ext) continue;
        var m = ah.fs.mtimeMs(full), st = ah.fs.lstat(full);
        if (m !== null && (now - m) > ttl && st !== null && st.kind === 'link') return true;
      }
    } catch (e) { return true; }
    return false;
  },
  pruneStale: function (dirRel, prefix) {
    try {
      var now = ah.clock.now(), stamp = dirRel + '/' + text.render(ah.cfg('guardkit.prune_stamp'), { prefix: prefix });
      var raw = ah.state.readText(stamp);
      if (raw !== null && raw.trim() !== '') {
        try {
          var last = JSON.parse(raw.trim())[ah.cfg('guardkit.prune_stamp_key')];
          if (typeof last === 'number' && isFinite(last) && last <= now && (now - last) < ah.cfgNum('guardkit.prune_throttle_ms')) return;
        } catch (e) { /* corrupt stamp: sweep */ }
      }
      var body = {}; body[ah.cfg('guardkit.prune_stamp_key')] = Math.floor(now);
      ah.state.writeAtomic(stamp, JSON.stringify(body));
      // the files `<prefix>-*.json` older than the TTL (the live session's own file is the newest, so it stays)
      var names = ah.fs.listDir(ah.home() + '/' + dirRel), ttl = ah.cfgNum('guardkit.prune_ttl_ms'), left = ah.cfgNum('script.sweep_max_remove'), ext = ah.cfg('guardkit.state_ext');
      for (var i = 0; names && i < names.length && left > 0; i++) {
        var n = names[i];
        if (n.indexOf(prefix + '-') !== 0 || n.slice(-ext.length) !== ext) continue;
        var m = ah.fs.mtimeMs(ah.home() + '/' + dirRel + '/' + n);
        if (m !== null && (now - m) > ttl && ah.state.remove(dirRel + '/' + n)) left--;
      }
    } catch (e) { /* best effort, as in Node */ }
  },
};

var turnGate = {
  humanText: function (msg) {
    if (!msg) return null;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      if (msg.content.some(function (c) { return c && c.type === 'tool_result'; })) return null;
      var t = msg.content.filter(function (c) { return c && c.type === 'text'; }).map(function (c) { return c.text || ''; }).join('\n');
      return t || null;
    }
    return null;
  },
  // The id of the newest human prompt in the capped transcript tail; null when none can be found.
  currentTurnId: function (transcriptPath) {
    if (!transcriptPath || typeof transcriptPath !== 'string') return null;
    // only the lines that name a user entry are read below, so only those are fetched
    var lines = ah.fs.tailLines(transcriptPath, ah.cfgNum('turn_gate.tail_bytes'), false, ['"user"']);
    if (lines === null) return null;
    var injected = gk.re('turn_gate.injected_re');
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i];
      if (!line || line.indexOf('"user"') === -1) continue;
      var o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      if (!o || o.type !== 'user' || o.isMeta || o.isSidechain) continue;
      var t = turnGate.humanText(o.message);
      if (!t || injected.test(t)) continue;
      return String(o.uuid || o.timestamp || '') || null;
    }
    return null;
  },
  stateRel: function (sessionId) {
    var safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, ah.cfgNum('turn_gate.session_max'));
    return ah.cfg('script.write_root') + '/' + ah.cfg('turn_gate.dir') + '/' + ah.cfg('turn_gate.prefix') + '-' + safe + ah.cfg('guardkit.state_ext');
  },
  // true: show the advisory (first time this turn, or the turn cannot be told); false: already shown. `o.home` is required.
  firstThisTurn: function (o) {
    try {
      if (!o.sessionId || !o.key) return true;
      var turn = o.agentId ? ah.cfg('turn_gate.agent_prefix') + o.agentId : turnGate.currentTurnId(o.transcriptPath);
      if (!turn) return true;
      var slot = String(o.key) + '|' + (o.agentId || ah.cfg('turn_gate.main_label'));
      var sig = o.sig === undefined ? '' : String(o.sig).slice(0, ah.cfgNum('turn_gate.sig_max'));
      var rel = turnGate.stateRel(o.sessionId), state = {};
      var raw = ah.state.readText(rel);
      try { state = JSON.parse(raw === null ? '' : raw) || {}; } catch (e) { state = {}; }
      var prev = state[slot];
      if (prev && prev.turn === turn && Array.isArray(prev.sigs) && prev.sigs.indexOf(sig) !== -1) return false;
      var sigs = prev && prev.turn === turn && Array.isArray(prev.sigs) ? prev.sigs.slice(-(ah.cfgNum('turn_gate.max_sigs') - 1)) : [];
      sigs.push(sig);
      state[slot] = { turn: turn, sigs: sigs };
      try {
        if (!ah.state.writeAtomic(rel, JSON.stringify(state))) return true; // cannot persist -> show it
        gk.pruneStale(ah.cfg('script.write_root') + '/' + ah.cfg('turn_gate.dir'), ah.cfg('turn_gate.prefix'));
      } catch (e) { return true; }
      return true;
    } catch (e) {
      return true;
    }
  },
};

// A Stop retry and injected user-role content do not open a new block-cap window. Both hosts use this helper;
// Codex's user_message event is the owner record, not its duplicate response_item. Rules: small_guards.toml (block_cap.*).
var blockCap = {
  ownerTurn: function (path) {
    if (typeof path !== 'string' || !path) return null;
    var types = ah.cfg('block_cap.record_types');
    var lines = ah.fs.tailLines(path, ah.cfgNum('turn_gate.tail_bytes'), true, [types.claude_user, types.codex_event, '\\u']);
    if (lines === null) return null;
    var flags = ah.cfg('block_cap.non_owner_flags'), origins = ah.cfg('block_cap.owner_origins');
    for (var i = lines.length - 1; i >= 0; i--) {
      var r = jx.parse(lines[i]);
      if (r.unsure) return null;
      if (r.invalid || !jx.isObj(r.v)) continue;
      var e = r.v, msg = e.message, content;
      if (e.type === types.claude_user && jx.isObj(msg)) content = msg.content;
      else if (e.type === types.codex_event && jx.isObj(e.payload) && e.payload.type === types.codex_user) {
        msg = e.payload;
        content = msg.message;
      } else continue;
      if ([e, msg].some(function (o) {
        if (flags.some(function (f) { return !!o[f]; })) return true;
        var origin = o.origin;
        return !!origin && origins.indexOf(jx.isObj(origin) ? origin.kind : origin) < 0;
      })) continue;
      var t = '';
      if (typeof content === 'string') t = content;
      else if (Array.isArray(content)) {
        if (content.some(function (b) { return b && b.type === types.tool_result; })) continue;
        t = content.filter(function (b) { return b && b.type === types.text && typeof b.text === 'string'; })
          .map(function (b) { return b.text; }).join('\n');
      }
      t = t.replace(jx.re('block_cap.leading_reminders_re', 'i'), '');
      if (!t.trim() || jx.re('block_cap.injected_re', 'i').test(t)) continue;
      var ids = ah.cfg('block_cap.owner_id_fields');
      var at = jx.isoMs(e.timestamp);
      if (typeof at !== 'number' || !isFinite(at)) at = null;
      for (var j = 0; j < ids.length; j++) {
        if (typeof e[ids[j]] === 'string' && e[ids[j]]) return { id: e[ids[j]], at: at };
      }
      return { id: ah.sha1(lines[i]), at: at };
    }
    return null;
  },
  // Missing metadata repairs a legacy, exhausted session counter once. Unknown turns retain the current window;
  // only a positively identified different owner turn reopens it. The last blocked hash is never cleared.
  open: function (prior, transcript, scopeKey, home, rel) {
    var scope = ah.cfg(scopeKey), ownerScope = ah.cfg('block_cap.owner_turn_scope');
    var migrate = !Object.prototype.hasOwnProperty.call(prior, 'capScope') || !Object.prototype.hasOwnProperty.call(prior, 'capTurn');
    var owner = scope === ownerScope ? blockCap.ownerTurn(transcript) : null;
    var turn = owner === null ? null : owner.id;
    var newer = turn !== null && turn !== prior.capTurn;
    // A transcript becoming readable again can reveal the SAME prompt that preceded an unidentified block.
    // Its timestamp must be newer than that block; when both ids are known, a changed id identifies the new turn.
    if (newer && prior.capTurn === null) {
      newer = owner.at !== null && typeof prior.capBlockedAt === 'number' && isFinite(prior.capBlockedAt) && owner.at > prior.capBlockedAt;
    }
    var state = Object.assign({}, prior);
    if (scope === ownerScope && (migrate || prior.capScope !== scope || newer)) state.blocks = 0;
    state.capScope = scope;
    state.capTurn = turn === null && !migrate ? prior.capTurn : turn;
    return {
      state: state,
      blocked: function () { return Object.assign({}, state, { capBlockedAt: ah.clock.now() }); },
      // Keep the original bytes (including a bare legacy hash or unknown fields) before the first migration write.
      // Never replace an existing backup. A refused backup makes the caller allow without rewriting the state.
      backup: function () {
        if (!migrate) return true;
        try {
          var full = home + '/' + rel, saved = rel + ah.cfg('block_cap.backup_suffix');
          var f = jx.read(full);
          if (f.big) return false;
          if (f.text === undefined) return ah.fs.lstat(full) === null;
          var originalHash = ah.fs.sha256File(full);
          if (originalHash === null) return false;
          var backupPath = home + '/' + saved, st = ah.fs.lstat(backupPath);
          if (st === null) ah.state.op(home, 'create', saved, f.text);
          st = ah.fs.lstat(backupPath);
          if (st === null || st.kind !== 'file' || ah.fs.sha256File(backupPath) !== originalHash) return false;
          migrate = false;
          return true;
        } catch (e) { return false; }
      },
    };
  },
};
