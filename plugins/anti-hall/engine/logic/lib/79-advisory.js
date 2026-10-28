// The advisory layer shared by the task and reply scripts (GitHub #225): fixed text once per session (again after a number of calls),
// state tables once per content change, a per-session soft and hard cap per kind, and the per-kind counters (flagged, asked,
// confirmed, injected, suppressed, jev_error, over_soft_cap) the engine reports under `advisory`. Blocks never pass through here.
// All limits and names: advisory.toml. State: one small file per session; any read problem starts a fresh state (fail-open).
'use strict';
var adv = {
  // Count one event of advisory kind `kind`; `name` is a key of advisory.metric_*.
  metric: function (kind, name) { try { ahHost.advisory(kind, ah.cfg('advisory.metric_names')[name]); } catch (e) { /* a lost count never changes a decision */ } },
  fileName: function (session) {
    var safe = String(session === undefined || session === null || session === '' ? 'nosession' : session).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfgNum('advisory.session_safe_max'));
    return ah.cfg('advisory.state_prefix') + '-' + safe + ah.cfg('advisory.state_ext');
  },
  rel: function (session) { return ah.cfg('paths.base_dir') + '/' + adv.fileName(session); },
  by: function (table, kind, dflt) {
    var t = ah.cfg(table);
    return t !== null && typeof t === 'object' && typeof t[kind] === 'number' && isFinite(t[kind]) && t[kind] > 0 ? t[kind] : ah.cfgNum(dflt);
  },
  // The session's state: {kinds: {kind: {n, seen, hash, t, fb}}}. Anything unreadable or of another shape is a fresh state.
  load: function (session) {
    var raw = null;
    try { raw = ah.state.readText(adv.rel(session)); } catch (e) { raw = null; }
    if (raw !== null) {
      var r = jx.parse(raw);
      if (!r.unsure && !r.invalid && jx.isObj(r.v) && jx.isObj(r.v.kinds)) return r.v;
      ah.unable('advisory:state_shape');
    }
    return { kinds: {} };
  },
  entry: function (st, kind) {
    var e = st.kinds[kind];
    if (!jx.isObj(e)) e = st.kinds[kind] = {};
    ['n', 'seen', 't', 'fb'].forEach(function (k) { if (typeof e[k] !== 'number' || !isFinite(e[k]) || e[k] < 0) e[k] = 0; });
    if (typeof e.hash !== 'string') e.hash = '';
    return e;
  },
  // The decision for one candidate, with nothing written: `content` null is a fixed text, a string is a state table.
  // {emit, why, overSoft, st, e, hash}
  // `shared` (optional): a state from `adv.load`, so several kinds decided together write one consistent file.
  decide: function (kind, session, content, shared) {
    var st = shared || adv.load(session), e = adv.entry(st, kind), hash = content === null ? '' : ah.sha1(content).slice(0, ah.cfgNum('advisory.hash_len'));
    var out = { emit: true, why: '', overSoft: false, st: st, e: e, hash: hash, kind: kind, session: session };
    if (e.n >= adv.by('advisory.cap_hard_by_kind', kind, 'advisory.cap_hard_default')) { out.emit = false; out.why = 'cap'; return out; }
    if (content !== null) {
      if (e.n > 0 && e.hash === hash) { out.emit = false; out.why = 'unchanged'; return out; }
    } else if (e.n > 0 && e.seen + 1 < adv.by('advisory.repeat_turns_by_kind', kind, 'advisory.repeat_turns_default')) {
      out.emit = false; out.why = 'repeat'; return out;
    }
    out.overSoft = e.n + 1 > adv.by('advisory.cap_soft_by_kind', kind, 'advisory.cap_soft_default');
    return out;
  },
  save: function (d) {
    var kinds = d.st.kinds, names = Object.keys(kinds), max = ah.cfgNum('advisory.max_kinds');
    if (names.length > max) {
      names.sort(function (a, b) { return (kinds[a].t || 0) - (kinds[b].t || 0); });
      names.slice(0, names.length - max).forEach(function (k) { delete kinds[k]; });
    }
    try {
      if (ah.state.writeAtomic(adv.rel(d.session), JSON.stringify(d.st))) ah.state.prune(ah.cfg('advisory.state_prefix'), adv.fileName(d.session));
    } catch (e) { /* the state is best effort: a lost write only means a repeat */ }
  },
  // Record a decision from `decide`: counts it, updates and writes the state. Returns d.emit.
  commit: function (d) {
    adv.metric(d.kind, 'flagged');
    var e = d.e;
    e.t = ah.clock.now();
    if (d.emit) {
      e.n++; e.seen = 0; if (d.hash !== '') e.hash = d.hash;
      adv.metric(d.kind, 'injected');
      if (d.overSoft) adv.metric(d.kind, 'over_soft');
    } else {
      e.seen++;
      adv.metric(d.kind, 'suppressed');
    }
    adv.save(d);
    return d.emit;
  },
  // decide + commit: should this fixed text / state table reach the model now?
  gate: function (kind, session, content) { return adv.commit(adv.decide(kind, session, content === undefined ? null : content)); },
  // decide only (no count, no write): would `gate` let it through?
  peek: function (kind, session, content) { return adv.decide(kind, session, content === undefined ? null : content).emit; },
  // The rate-limited rule fallback of a judgment advisory whose Jev question failed: true at most advisory.fallback_per_session times a session.
  fallback: function (kind, session) {
    var st = adv.load(session), e = adv.entry(st, kind);
    adv.metric(kind, 'jev_error');
    if (e.fb >= ah.cfgNum('advisory.fallback_per_session')) { adv.metric(kind, 'suppressed'); return false; }
    e.fb++; e.t = ah.clock.now();
    adv.save({ st: st, session: session });
    return true;
  },
};
