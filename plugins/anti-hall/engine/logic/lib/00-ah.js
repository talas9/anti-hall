// anti-hall check logic: the `ah` API every check script uses (D88). The engine installs only the raw, generic,
// read-only primitives as `ahHost`; this file shapes them. Editable like every other script here.
'use strict';
var ahCfgMemo = { gen: -1, map: new Map() };
var ah = {
  // Defaults entries, memoized until the engine loads a new defaults snapshot (a file edit or a plugin update).
  cfg: function (key) {
    var g = ahHost.cfgGen();
    if (g !== ahCfgMemo.gen) { ahCfgMemo.gen = g; ahCfgMemo.map = new Map(); }
    var v = ahCfgMemo.map.get(key);
    if (v === undefined) { v = JSON.parse(ahHost.cfg(key)); ahCfgMemo.map.set(key, v); }
    return v;
  },
  cfgNum: function (key) { return ahHost.cfgNum(key); },
  settings: {
    bool: function (key) { return ahHost.settingBool(key); },
    skipped: function (guard) { return ahHost.skipped(guard); },
  },
  fs: {
    isFile: function (p) { return ahHost.isFile(p); },
    readText: function (p, max) { return ahHost.readText(p, max === undefined ? 0 : max); },
  },
  path: {
    isAbsolute: function (p) { return ahHost.pathIsAbsolute(p); },
    basename: function (p) { return ahHost.pathBasename(p); },
    join: function (a, b) { return ahHost.pathJoin(a, b); },
    resolveAbs: function (p) { return ahHost.pathResolveAbs(p); },
    relative: function (a, b) { return ahHost.pathRelative(a, b); },
  },
  // Linear-time regex (no catastrophic backtracking): flags 'i' ignore case, 'r' engine syntax, else JavaScript syntax.
  re: {
    test: function (src, flags, text) { return ahHost.reTest(src, flags || '', text); },
    find: function (src, flags, text) { return ahHost.reFind(src, flags || '', text); },
    findAll: function (src, flags, text) {
      var flat = ahHost.reFindAll(src, flags || '', text), out = [];
      for (var i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
      return out;
    },
  },
  transcript: {
    // null: no readable transcript; {hint:false}: no line can hold `hint`; {unsure:true}: a line JS might read differently;
    // {parts:[...]}: the current turn's assistant text blocks.
    turnText: function (p, maxBytes, hint) { return JSON.parse(ahHost.turnText(p, maxBytes, hint || '')); },
  },
};
