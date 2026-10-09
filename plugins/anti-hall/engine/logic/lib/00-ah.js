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
    // The SCOPED append, same path rules; one O_APPEND write. false when the disk refuses.
    appendFile: function (rel, t) { return ahHost.appendFile(rel, t); },
    // The cross-process lock file `rel` (Node lock protocol) with the timings of the defaults group `group`: a handle, or null
    // when it could not be taken. A few at once (script.lock_max_held), taken in the script's fixed order; a lock still held when the call ends is released by the engine.
    // `waitMs` (optional) replaces the group's wait.
    lock: function (rel, group, waitMs) { return ahNull(ahHost.lockAcquire(rel, group, waitMs === undefined ? null : waitMs)); },
    unlock: function (h) { return ahHost.lockRelease(h); },
    // The retention sweep of the state files of one writer prefix (stale ones go; `keep` stays).
    // Scoped read of a file under the state directory (null when absent, unreadable or over the cap).
    readText: function (rel) { return ahNull(ahHost.stateRead(rel)); },
    // Delete ONE regular file under the state directory; true when removed.
    remove: function (rel) { return ahHost.stateRemove(rel); },
    // Delete up to `max` regular files of a state sub-directory whose name starts with `prefix` and that are older than `ageMs` (oldest
    // first, capped by script.sweep_max_remove). Returns the number removed.
    sweep: function (dirRel, prefix, ageMs, max) { return ahHost.stateSweep(dirRel, prefix, ageMs, max); },
    // The scoped operations under any absolute `root` (the home directory, or a project root): `rel` must start with the state
    // directory. op: 'write', 'after_reply' (atomic, landing only once the reply was delivered), 'append', 'mkdir', 'remove'.
    op: function (root, op, rel, t) { return ahHost.fileOp(root, rel, t === undefined ? '' : t, op); },
    prune: function (prefix, keep) { ahHost.pruneState(prefix, keep === undefined ? null : keep); },
  },
  // One allow-listed program (script.exec_programs), bounded in time, output and number of runs per call, with the request's
  // environment plus `env` (an object) on top. Returns {status, stdout, stderr, truncated}, or null when it was not allowed, could
  // not start, timed out, or its output was incomplete.
  exec: function (prog, args, opts) {
    opts = opts || {};
    var pairs = [];
    if (opts.env) for (var k in opts.env) if (Object.prototype.hasOwnProperty.call(opts.env, k)) pairs.push(k, String(opts.env[k]));
    var r = ahHost.exec(prog, args || [], opts.cwd === undefined ? null : opts.cwd, pairs, opts.timeoutMs === undefined ? 0 : opts.timeoutMs);
    return r === null ? null : JSON.parse(r);
  },
  // The engine's one clock: milliseconds since the epoch (tests pin it).
  clock: {
    now: function () { return ahHost.now(); },
    // Local calendar fields of an instant: {year, month (1-12), day, hour, minute, second, weekday (0 = Sunday), offsetMinutes}.
    local: function (ms) { var r = ahHost.localTime(ms === undefined ? ahHost.now() : ms); return JSON.parse(r); },
  },
  // Call right before the first change to shared state: the time limit is lifted for the rest of the call (an interrupt after the
  // change would defer the call, and the Node hook would apply the change again).
  commit: function () { ahHost.commit(); },
  home: function () { return ahHost.home(); },
  pid: function () { return ahHost.pid(); },
  fnv: function (t) { return ahHost.fnv(t); },
  contentHash: function (parts) { return ahHost.contentHash(parts); },
  settings: {
    bool: function (key) { return ahHost.settingBool(key); },
    enum: function (key) { return ahHost.settingEnum(key); },
    num: function (key) { return ahHost.settingNum(key); },
    // Like `num`, but a value below the entry's minimum is dropped (the next source is asked), the way the Node `settings.get` does.
    numStrict: function (key) { return ahHost.settingNumStrict(key); },
    // The effective value of a free-text setting (its default when unset).
    str: function (key) { return ahHost.settingStr(key); },
    skipped: function (guard) { return ahHost.skipped(guard); },
    // `get(section, key, dflt)` of the settings chain for the described entry; `dflt` undefined: the entry's own default.
    // Returns {status: 'value'|'none'|'undecidable', value}.
    get: function (key, dflt, root) {
      var r = JSON.parse(ahHost.settingGet(key, dflt === undefined ? '' : JSON.stringify(dflt), root || ''));
      return { status: ['value', 'none', 'undecidable'][r[0]], value: r[1] };
    },
  },
  fs: {
    isFile: function (p) { return ahHost.isFile(p); },
    size: function (p) { return ahNull(ahHost.fileSize(p)); },
    realpath: function (p) { return ahNull(ahHost.realpath(p)); },
    // {kind: 'file'|'dir'|'link'|'other', size, mtimeMs, mode} of the path itself (links not followed), or null.
    // {kind: 'error', code} when it exists but cannot be examined; null when it does not exist.
    lstat: function (p) { return JSON.parse(ahHost.lstat(p)); },
    // {path} or {error: 'NotFound' | <other io error kind>}: the canonical path, or why there is none.
    realpathEx: function (p) { return JSON.parse(ahHost.realpathEx(p)); },
    isDir: function (p) { return ahHost.isDir(p); },
    // 'file' | 'dir' | 'link' (not followed) | null
    kind: function (p) { return ahNull(ahHost.kind(p)); },
    mtimeMs: function (p) { return ahNull(ahHost.mtimeMs(p)); },
    // File names sorted by bytes, or null.
    listDir: function (p) { return ahNull(ahHost.listDir(p)); },
    // Sorted entry names, or null (not a directory, or over the listing cap).
    readdir: function (p) { return ahNull(ahHost.readdir(p)); },
    // The target text of a symbolic link, or null.
    readlink: function (p) { return ahNull(ahHost.readlink(p)); },
    readText: function (p, max) { return ahNull(ahHost.readText(p, max === undefined ? 0 : max)); },
    // Lowercase hex SHA-256 of a regular file (links not followed), or null.
    sha256File: function (p) { return ahNull(ahHost.fileSha256(p)); },
    // The first `n` bytes of a regular file as lowercase hex, or null.
    readHeadHex: function (p, n) { return ahNull(ahHost.readHeadHex(p, n)); },
  },
  // The numeric user id of the engine's process (the hook runs as the same user).
  uid: function () { return ahHost.uid(); },
  path: {
    isAbsolute: function (p) { return ahHost.pathIsAbsolute(p); },
    basename: function (p) { return ahHost.pathBasename(p); },
    join: function (a, b) { return ahHost.pathJoin(a, b); },
    resolveAbs: function (p) { return ahHost.pathResolveAbs(p); },
    relative: function (a, b) { return ahHost.pathRelative(a, b); },
    resolve: function (a, b) { return ahHost.pathResolve(a, b); },
  },
  // Linear-time regex (no catastrophic backtracking): flags 'i' ignore case, 'm' multiline, 'r' engine syntax, else JavaScript syntax.
  re: {
    test: function (src, flags, text) { return ahHost.reTest(src, flags || '', text); },
    find: function (src, flags, text) { return ahHost.reFind(src, flags || '', text); },
    findAll: function (src, flags, text) {
      var flat = ahHost.reFindAll(src, flags || '', text), out = [];
      for (var i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
      return out;
    },
    // The distinct finite numbers the matches of a regex spell in `text` (characters of `strip` removed from each match first), sorted
    // ascending: one native pass over megabytes of text, then a list to bisect.
    numbers: function (src, flags, text, strip) { return JSON.parse(ahHost.reNumbers(src, flags || '', text, strip || '')); },
  },
  // The effective value of a defaults key through the owner's editable layers (settings.json, config.toml, shipped default).
  cfgLive: function (key) { return JSON.parse(ahHost.cfgLive(key)); },
  sha1: function (t) { return ahHost.sha1(t); },
  // The engine's outbound secret scrubber (the `jev.scrub_rules` of the plugin's jev.toml).
  scrub: function (t) { return ahHost.scrubSecrets(t); },
  log: function (kind, t) { ahHost.log(kind, t); },
  // Milliseconds left of the request being answered (null outside a daemon). The Jev ask itself is in lib/60-b3.js.
  jev: { deadlineLeftMs: function () { return ahNull(ahHost.deadlineLeftMs()); } },
  sys: {
    // {available: bytes|null, total: bytes} of this machine; available counts reclaimable cache.
    memory: function () { return JSON.parse(ahHost.memory()); },
  },
  repo: {
    // {unsure, toplevel, root}: the checkout around a directory (root: the outermost superproject); unsure when the answer
    // depends on something the engine does not reproduce.
    // `ancestor` (default true) is the Node `missingPath: 'ancestor'` option of `resolveContext`.
    context: function (dir, ancestor) { return JSON.parse(ahHost.repoContext(dir, ancestor === undefined ? true : !!ancestor)); },
  },
  // Sleep `ms` (bounded per call and in total by hostproc.sleep_max_ms / sleep_total_max_ms; the wait is not script time).
  sleep: function (ms) { ahHost.sleep(ms); },
  // Processes (ahHost proc primitives; bounded, no rule about which process).
  proc: {
    // {rows: [{pid, ppid, cmd}]} of the process table, or null when the listing failed; the pids shown can be signalled in this call.
    list: function () { var r = ahHost.procList(); return r === null || r === undefined ? null : JSON.parse(r); },
    // {ages: {"<pid>": seconds}} (an unknown age is left out) or {unsure: true}.
    ages: function (pids) { return JSON.parse(ahHost.procAges(JSON.stringify(pids))); },
    // {platform, managed: [pids], unverifiable} (the pids the platform's service manager owns) or {unsure: true}.
    managed: function (pids) { return JSON.parse(ahHost.procManaged(JSON.stringify(pids))); },
    // Send the polite (forced false) or the forced signal to ONE pid; true when sent. Refused for a pid below hostproc.min_signal_pid,
    // the engine itself or its parent, a pid this call's own list() did not show, a forced signal not preceded by a polite one in
    // this call, and anything past hostproc.signal_max_per_call.
    signal: function (pid, forced) { return ahHost.procSignal(pid, !!forced); },
  },
  transcript: {
    // The text evidence of the last windowBytes of a transcript: null (unreadable), {unsure: true}, or {truncated, items: [[kind, text, id?]]}
    // with kind p (a user prompt), r (a tool result), a (an attachment), i (a tool call's input), t (assistant text, with the message id).
    evidence: function (p, windowBytes) { var r = ahHost.transcriptEvidence(p, windowBytes || 0); return r === null || r === undefined ? null : JSON.parse(r); },
    // Finished-but-not-stopped named teammates of a Claude transcript tail: null, {unsure: true} or {teammates: [{name, idleSinceMs}]}.
    teammates: function (p, tailBytes) { var r = ahHost.transcriptTeammates(p, tailBytes || 0); return r === null || r === undefined ? null : JSON.parse(r); },
    // Finished-but-not-closed agents of a Codex rollout tail: null, {unsure: true} or {agents: [{id, label, idleSinceMs}]}.
    codexAgents: function (p, tailBytes) { var r = ahHost.transcriptCodexAgents(p, tailBytes || 0); return r === null || r === undefined ? null : JSON.parse(r); },
    // The running agents of a transcript: null (unreadable), {unsure: true}, or {rows: [{id, description, spawnInput}]}.
    agents: function (p) { return JSON.parse(ahHost.agents(p)); },
    // The last lines of a file with their byte offsets: {lines: [[offset, text|null]]} (text null: over lineMax, or not UTF-8), or null.
    tailLines: function (p, windowBytes, lineMax) { var r = ahHost.tailLines(p, windowBytes || 0, lineMax || 0); return r === null || r === undefined ? null : JSON.parse(r); },
    // null: no readable transcript; {hint:false}: no line can hold `hint`; {unsure:true}: a line JS might read differently;
    // {parts:[...]}: the current turn's assistant text blocks.
    turnText: function (p, maxBytes, hint) { return JSON.parse(ahHost.turnText(p, maxBytes, hint || '')); },
  },
};
