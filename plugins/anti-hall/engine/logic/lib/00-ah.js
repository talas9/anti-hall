// anti-hall check logic: the `ah` API every check script uses (D88). The engine installs only the raw, generic,
// read-only primitives as `ahHost`; this file shapes them. Editable like every other script here.
'use strict';
// The engine returns `undefined` for an absent optional value; the API gives `null`.
function ahNull(v) { return v === undefined ? null : v; }
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
  // The hook's own environment (the request's, never the daemon's); null when a variable is unset.
  env: {
    get: function (name) { return ahNull(ahHost.env(name)); },
    passwdHome: function () { return ahNull(ahHost.passwdHome()); },
  },
  // The SCOPED write: an atomic write of `text` to `rel`, a path relative to the home directory that lies under the state
  // directory (~/.anti-hall). Throws
  // for a path outside it, a link below it or a text over the cap (the check then takes its failure policy); returns false
  // when the disk refuses.
  state: {
    writeAtomic: function (rel, t) { return ahHost.writeAtomic(rel, t); },
  },
  settings: {
    bool: function (key) { return ahHost.settingBool(key); },
    enum: function (key) { return ahHost.settingEnum(key); },
    num: function (key) { return ahHost.settingNum(key); },
    skipped: function (guard) { return ahHost.skipped(guard); },
  },
  fs: {
    isFile: function (p) { return ahHost.isFile(p); },
    size: function (p) { return ahNull(ahHost.fileSize(p)); },
    realpath: function (p) { return ahNull(ahHost.realpath(p)); },
    readText: function (p, max) { return ahNull(ahHost.readText(p, max === undefined ? 0 : max)); },
  },
  path: {
    isAbsolute: function (p) { return ahHost.pathIsAbsolute(p); },
    basename: function (p) { return ahHost.pathBasename(p); },
    join: function (a, b) { return ahHost.pathJoin(a, b); },
    resolveAbs: function (p) { return ahHost.pathResolveAbs(p); },
    relative: function (a, b) { return ahHost.pathRelative(a, b); },
    resolve: function (a, b) { return ahHost.pathResolve(a, b); },
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
