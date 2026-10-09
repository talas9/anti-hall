// check = "fable-availability" (SessionStart): record whether a Fable model is available, from the host's own model cache in
// ~/.claude.json, and tell the session when it is. Writes ~/.anti-hall/fable-availability.json on every run (through the scoped
// atomic write) and speaks only when `available` is true. A config the reader cannot parse, or one larger than a script may
// read, defers to Node, which decides and writes the state itself. Mirrors hooks/fable-availability.js.
// Keys, cache layout and messages: verify_first.toml (fable_availability.*).
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function hasFable(v) { return typeof v === 'string' && v.toLowerCase().indexOf(ah.cfg('fable_availability.needle')) >= 0; }

// `detectAvailability(config)`: {available: true|false|null, source}.
function detect(cfg) {
  var unknown = { available: null, source: ah.cfg('fable_availability.unknown_source') };
  if (!isObj(cfg)) return unknown;
  var access = ah.cfg('fable_availability.access_list'), opts = ah.cfg('fable_availability.options_list');
  var list = cfg[access.key];
  if (Array.isArray(list)) {
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (isObj(e) && hasFable(e[access.name_field])) return { available: e[access.entitled_field] === true, source: access.source };
    }
  }
  list = cfg[opts.key];
  if (Array.isArray(list)) {
    for (var j = 0; j < list.length; j++) {
      var o = list[j];
      if (isObj(o) && opts.name_fields.some(function (f) { return hasFable(o[f]); })) return { available: o[opts.disabled_field] !== true, source: opts.source };
    }
  }
  return unknown;
}

function decide() {
  var judge = ah.cfg('verify_first.judge_child_env');
  if (ah.env.get(judge.name) === judge.on) return 'allow';
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null) home = ah.env.get(ah.cfg('env.home_alt'));
  if (home === null || home === '') return 'defer';
  var file = home + '/' + ah.cfg('fable_availability.config_file'), found;
  var size = ah.fs.size(file);
  if (size !== null && size > ah.cfgNum('script.read_max_bytes')) return 'defer';
  var raw = ah.fs.readText(file);
  if (raw === null) {
    found = { available: null, source: ah.cfg('fable_availability.unknown_source') };
  } else {
    var cfg;
    try { cfg = JSON.parse(raw); } catch (e) { return 'defer'; }
    found = detect(cfg);
  }
  var state = JSON.stringify({ available: found.available, checkedAt: Date.now(), source: found.source });
  var wrote = ah.state.writeAtomic(ah.cfg('fable_availability.state_file'), state);
  if (!wrote || found.available !== true) return 'allow';
  var t = text.message('tip', ah.cfg('fable_availability.guard_name'), {
    what: ah.cfg('fable_availability.msg_what'), why: ah.cfg('fable_availability.msg_why'), instead: ah.cfg('fable_availability.msg_instead'),
  });
  return { advisory: text.advisoryJson('SessionStart', t) };
}
