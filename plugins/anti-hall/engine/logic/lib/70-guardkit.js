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
    var tail = ah.fs.readTail(transcriptPath, ah.cfgNum('turn_gate.tail_bytes'));
    if (tail === null) return null;
    var lines = tail.split('\n'), injected = gk.re('turn_gate.injected_re');
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
