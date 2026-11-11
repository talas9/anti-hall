// The waste ledger (#709): `waste.note` counts an advisory or a turn the smarter rules did not send (events and an estimate of the tokens
// of the text left out) and keeps a small per-session record of it; `waste.warning` turns that record into ONE advisory per level change:
// the tokens saved in the last waste.num_window_min minutes per category against the levels waste.level_multipliers x guards.wasteWarnTokens.
// A constant rate warns once, when it first reaches a level, and again only when the level rises; a fall is recorded silently, so a
// relapse warns again (a dip within waste.hysteresis_pct of a threshold is not a fall). A record the disk will not take means no warning. Everything is best effort: a failure reads as no warning and never changes a decision. Keys, texts and limits:
// prompt_emit.toml (waste.*), telemetry.toml (waste_events_total, waste_tokens_total, waste_warnings_total).
'use strict';

var waste = {
  rel: function (sid) {
    return ah.cfg('paths.base_dir') + '/' + ah.cfg('waste.state_dir') + '/' + String(sid).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, ah.cfgNum('waste.session_key_max')) + ah.cfg('waste.state_ext');
  },
  load: function (sid) {
    var raw = ah.state.readText(waste.rel(sid)), st = { cats: {} };
    if (raw === null || raw === undefined) return st;
    try {
      var o = JSON.parse(raw);
      if (o && typeof o === 'object' && o.cats && typeof o.cats === 'object' && !Array.isArray(o.cats)) st.cats = o.cats;
    } catch (e) { /* a damaged record starts afresh */ }
    return st;
  },
  // The tokens an advisory of `bytes` bytes would have cost (waste.bytes_per_token bytes to a token, rounded up); 0 when unknown.
  tokens: function (bytes) {
    var per = ah.cfgNum('waste.bytes_per_token');
    return typeof bytes === 'number' && isFinite(bytes) && bytes > 0 && per > 0 ? Math.ceil(bytes / per) : 0;
  },
  // One event the smarter rule saved: `category` (waste.categories), `source` (the rule), `bytes` (the text not sent, 0 when unknown).
  note: function (sid, category, source, bytes) {
    var tokens = waste.tokens(bytes);
    ah.metric('waste_events_total', ['category', category, 'source', source]);
    if (tokens > 0) ah.metric('waste_tokens_total', ['category', category, 'source', source], tokens);
    if (tokens <= 0 || !sid || !ah.settings.bool('waste.sw_warn')) return;
    try {
      var st = waste.load(sid), c = st.cats[category];
      if (!c || typeof c !== 'object' || !Array.isArray(c.ev)) c = st.cats[category] = { ev: [], level: 0 };
      c.ev.push([ah.clock.now(), tokens]);
      var cap = ah.cfgNum('waste.max_events');
      if (c.ev.length > cap) c.ev = c.ev.slice(c.ev.length - cap);
      ah.state.writeAtomic(waste.rel(sid), JSON.stringify(st));
    } catch (e) { /* a lost record is a lost warning, never a decision */ }
  },
  // The advisory text for the categories whose level rose since the last call, or '' (nothing rose, the switch is off, no record).
  warning: function (sid) {
    if (!sid || !ah.settings.bool('waste.sw_warn')) return '';
    try {
      var st = waste.load(sid), now = ah.clock.now(), win = ah.settings.num('waste.num_window_min') * ah.cfgNum('waste.ms_per_minute');
      var base = ah.settings.num('waste.num_level_tokens'), mult = ah.cfg('waste.level_multipliers'), rose = [], dirty = false;
      var keep = 1 - ah.cfgNum('waste.hysteresis_pct') / 100; // a level is left only once the sum is under this share of its threshold
      Object.keys(st.cats).forEach(function (cat) {
        var c = st.cats[cat];
        if (!c || typeof c !== 'object' || !Array.isArray(c.ev)) { delete st.cats[cat]; dirty = true; return; }
        var kept = c.ev.filter(function (e) { return Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'number' && e[0] <= now && now - e[0] <= win; });
        if (kept.length !== c.ev.length) { c.ev = kept; dirty = true; }
        var sum = kept.reduce(function (a, e) { return a + e[1]; }, 0), level = 0;
        mult.forEach(function (m, i) { if (sum >= m * base) level = i + 1; });
        var was = typeof c.level === 'number' ? c.level : 0;
        // hysteresis: a dip that stays within the margin of the level held keeps it, so a rate flapping around a threshold warns once
        if (level < was && was <= mult.length && sum >= mult[was - 1] * base * keep) level = was;
        if (level > was) rose.push({ cat: cat, sum: sum, level: level, n: kept.length });
        if (level !== was) { c.level = level; dirty = true; }
        if (kept.length === 0 && level === 0) { delete st.cats[cat]; dirty = true; }
      });
      // the record is what stops a repeat: a write the disk refuses would warn every turn, so it says nothing (fail quiet)
      if (dirty && ah.state.writeAtomic(waste.rel(sid), JSON.stringify(st)) === false) return '';
      if (rose.length === 0) return '';
      rose.sort(function (a, b) { return b.sum - a.sum; });
      var top = rose[0];
      ah.metric('waste_warnings_total', ['category', top.cat]);
      var what = text.render(ah.cfg('waste.msg_what'), { tokens: String(top.sum), cat: top.cat, m: String(ah.settings.num('waste.num_window_min')), level: String(top.level), levels: String(mult.length) });
      return text.message('tip', ah.cfg('waste.guard_name'), { what: what, instead: ah.cfg('waste.msg_instead') });
    } catch (e) { return ''; }
  },
};
