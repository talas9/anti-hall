// anti-hall check logic: the `ah` API every check script uses (D88). The engine installs only the raw, generic,
// read-only primitives as `ahHost`; this file shapes them. Editable like every other script here.
'use strict';
// The engine returns `undefined` for an absent optional value; the API gives `null`.
function ahNull(v) { return v === undefined ? null : v; }
// Node turns a lone surrogate into U+FFFD when it encodes a string to UTF-8 (a hash, a file write); the host cannot take one.
var ahWfRe = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function ahWf(t) { return typeof t === 'string' ? t.replace(ahWfRe, '\ufffd') : t; }
// Count a case this script could not model exactly (at `site`, a short stable name such as `task-tracker.state_unsure`): a stand-in (stand_in: the script went on with a stand-in value) or, with `kind` 'abandoned', a dropped decision (abandoned). The caller applies the native decision.
function ahUnableCount(site, kind) { try { if (kind === undefined) ahHost.unable(site); else ahHost.unable(site, kind); } catch (e) { /* a lost count never changes a decision */ } }
// `req`: the `ah.request` object the memo was last checked under. The engine installs a fresh one before EVERY check call, so a new
// call re-reads `cfgGen` once (a defaults reload between calls is seen) and the rest of the call costs no host call.
var ahCfgMemo = { gen: -1, map: new Map(), req: null };
// Memo hits and misses of this call's `ah.cfg` / `ah.settings` reads: handed to the host with the next call's one `cfgGen` read (no host call of their own).
var ahCfgTally = { hit: 0, miss: 0 };
// Settings values read in this call, by kind + key: the settings chain and the request's home/env are fixed for a call (`useHome` drops them).
var ahSetMemo = { req: null, map: new Map() };
function ahSet(kind, key, read) {
  ah.cfgGen();
  if (ahSetMemo.req !== ah.request) { ahSetMemo.req = ah.request; ahSetMemo.map = new Map(); }
  var k = kind + '\u0000' + key, m = ahSetMemo.map;
  if (m.has(k)) { ahCfgTally.hit++; return m.get(k); }
  ahCfgTally.miss++;
  var v = read(key);
  m.set(k, v);
  return v;
}
var ah = {
  // Replaced before EVERY check call: authoritative dispatcher options, including --host. Never daemon-global state.
  request: {},
  // The defaults generation, read from the host once per check call (a defaults reload between calls is seen by the next one). Every memo keyed on it uses this.
  cfgGen: function () {
    var r = ah.request;
    if (ahCfgMemo.req !== r || r === undefined || r === null) {
      var h = ahCfgTally.hit, mi = ahCfgTally.miss;
      ahCfgTally.hit = 0; ahCfgTally.miss = 0;
      var g = ahHost.cfgGen(h, mi);
      if (g !== ahCfgMemo.gen) { ahCfgMemo.gen = g; ahCfgMemo.map = new Map(); }
      ahCfgMemo.req = r;
    }
    return ahCfgMemo.gen;
  },
  // Defaults entries, memoized until the engine loads a new defaults snapshot (a file edit or a plugin update).
  cfg: function (key) {
    ah.cfgGen();
    var v = ahCfgMemo.map.get(key);
    if (v === undefined) { ahCfgTally.miss++; v = JSON.parse(ahHost.cfg(key)); ahCfgMemo.map.set(key, v); } else ahCfgTally.hit++;
    return v;
  },
  cfgNum: function (key) { return ahHost.cfgNum(key); },
  unable: function (site, kind) { ahUnableCount(site, kind); },
  // Add `by` (default 1) to the registered counter `name` ([metric.<name>] in a defaults file); `labels` = {label: value} or
  // [label, value, ...]. A lost count never changes a decision.
  metric: function (name, labels, by) {
    try {
      var o = labels || {};
      if (Array.isArray(o)) { o = {}; for (var i = 0; i + 1 < labels.length; i += 2) o[String(labels[i])] = String(labels[i + 1]); }
      ahHost.metric(name, JSON.stringify(o), by === undefined ? 1 : by);
    } catch (e) { /* telemetry only */ }
  },
  // One advisory event of `kind` (flagged, asked, confirmed, injected, suppressed, jev_error) under `metric`; a lost count never changes a decision.
  advisory: function (kind, metric) { try { ahHost.advisory(kind, metric); } catch (e) { /* telemetry only */ } },
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
    // `o.leaveTemp`: a failed rename leaves the temporary file behind, as the Node writers do (for a writer whose parity suite compares the directory).
    writeAtomic: function (rel, t, o) { return ahHost.writeAtomic(rel, ahWf(t), !!(o && o.leaveTemp)); },
    // The SCOPED append, same path rules; one O_APPEND write. false when the disk refuses.
    appendFile: function (rel, t) { return ahHost.appendFile(rel, ahWf(t)); },
    // The cross-process lock file `rel` (Node lock protocol) with the timings of the defaults group `group`: a handle, or null
    // when it could not be taken. A lock still held when the call ends is released by the engine.
    // `waitMs` (optional) replaces the group's wait (never past script.lock_wait_max_ms). Up to script.lock_max_held at once; take nested ones in a fixed order.
    lock: function (rel, group, waitMs) { return ahNull(ahHost.lockAcquire(rel, group, waitMs === undefined ? null : waitMs)); },
    unlock: function (h) { return ahHost.lockRelease(h); },
    // The fenced commit of a file guarded by the lock `h` taken in this call: `fenceSweep` (right after taking the lock, before
    // reading `rel`) removes earlier holders' staged copies `<rel><infix>*`; `writeFenced` stages, re-checks that `h` is still
    // ours, then renames; false when the lock was taken over (nothing of ours lands over the new holder's write).
    fenceSweep: function (rel, infix) { return ahHost.fenceSweep(rel, infix); },
    // `guard` (optional): [[rel, key, max], ...]; the commit is discarded when a watched number is above its bound at the rename.
    writeFenced: function (rel, t, h, infix, guard) { return ahHost.writeFenced(rel, ahWf(t), h, infix, guard === undefined || guard === null ? null : JSON.stringify(guard)); },
    // The retention sweep of the state files of one writer prefix (stale ones go; `keep` stays).
    // Scoped read of a file under the state directory (null when absent, unreadable or over the cap).
    readText: function (rel) { return ahNull(ahHost.stateRead(rel)); },
    // Delete ONE regular file under the state directory; true when removed.
    remove: function (rel) { return ahHost.stateRemove(rel); },
    // Delete up to `max` regular files of a state sub-directory whose name starts with `prefix` and that are older than `ageMs` (oldest
    // first, capped by script.sweep_max_remove). Returns the number removed.
    sweep: function (dirRel, prefix, ageMs, max) { return ahHost.stateSweep(dirRel, prefix, ageMs, max); },
    // The scoped operations under any absolute `root` (the home directory, or a project root): `rel` must start with the state
    // directory. op: 'write', 'after_reply' (atomic, landing only once the reply was delivered), 'append', 'mkdir', 'remove', 'rename' (the text is the destination, relative like `rel`).
    op: function (root, op, rel, t) { return ahHost.fileOp(root, rel, t === undefined ? '' : ahWf(t), op); },
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
  // Mark a file under the write root (a stable launcher) executable; false when it is not a plain file there.
  markExecutable: function (rel) { return ahHost.fileExec(rel) === true; },
  // Make absolute directory `h` the home of the rest of this call (settings, skips and the scoped state reads and writes), as a Node
  // hook whose os.homedir() falls back to the passwd home sees it. false (nothing changed) for a path that is not absolute.
  useHome: function (h) { ahSetMemo.req = null; return ahHost.useHome(h); },
  pid: function () { return ahHost.pid(); },
  fnv: function (t) { return ahHost.fnv(t); },
  contentHash: function (parts) { return ahHost.contentHash(parts); },
  settings: {
    bool: function (key) { return ahSet('b', key, ahHost.settingBool); },
    enum: function (key) { return ahSet('e', key, ahHost.settingEnum); },
    str: function (key) { return ahSet('s', key, ahHost.settingStr); },
    num: function (key) { return ahSet('n', key, ahHost.settingNum); },
    // Like `num`, but a value below the entry's minimum is dropped (the next source is asked), the way the Node `settings.get` does.
    numStrict: function (key) { return ahSet('m', key, ahHost.settingNumStrict); },
    // The effective value of a free-text setting (its default when unset).
    str: function (key) { return ahSet('s', key, ahHost.settingStr); },
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
    // Lowercase hex SHA-256 of the UTF-8 bytes of a text (hash exactly the text that was read and is compared).
    sha256Text: function (t) { return ahHost.textSha256(String(t)); },
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
  sha1: function (t) { return ahHost.sha1(ahWf(t)); },
  // The engine's outbound secret scrubber (the `jev.scrub_rules` of the plugin's jev.toml).
  scrub: function (t) { return ahHost.scrubSecrets(t); },
  log: function (kind, t) { ahHost.log(kind, t); },
  // Milliseconds left of the request being answered (null outside a daemon). The Jev ask itself is in lib/60-b3.js.
  jev: {
    deadlineLeftMs: function () { return ahNull(ahHost.deadlineLeftMs()); },
    // The shadow reviews due: [[id, wholeDays, decisions]] (the review state is updated as Node updates it), or null when the state cannot be worked on.
    reviewDue: function (afterDays, minDecisions) { var r = ahHost.jevReviewDue(afterDays, minDecisions); return r === null || r === undefined ? null : JSON.parse(r); },
    // Record that the review reminder named these integration ids.
    reviewShown: function (ids) { ahHost.jevReviewShown(JSON.stringify(ids)); },
    // The one-time legacy-key notice: {notice: string|null}, or {unsure: true} when only Node can say.
    // The 7-day verdict scorecard {generatedAt, integrations: [{id, calls, suggestion, reason, mode}], transports} (the jev-report data), or null
    // when it could not be built. Read-only.
    weeklyScorecard: function () { var r = ahHost.jevWeeklyScorecard(); return r === null || r === undefined ? null : JSON.parse(r); },
    keyNotice: function (jevOn, judgeOn, allowAnthropic) { return JSON.parse(ahHost.jevKeyNotice(!!jevOn, !!judgeOn, !!allowAnthropic)); },
  },
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
    // The engine walks the evidence of the last windowBytes (what `evidence` lists, merged and joined as a reply check needs) and keeps
    // the two big texts: null (unreadable), {unsure: true}, {truncated, walked: false} (no reply and no payloadText), or
    // {truncated, walked: true, lastText, toolsThisTurn, toolsAtEnd, evidenceChars, withLastChars} (lengths in UTF-16 units).
    // payloadText (a string or null): replies it already holds (NFC, white space collapsed) are left out of the evidence, and a window
    // with no reply still walks. The next two questions are about the walk this call made.
    evidenceWalk: function (p, windowBytes, payloadText) { var r = ahHost.transcriptEvidenceWalk(p, windowBytes || 0, payloadText === undefined ? null : payloadText); return r === null || r === undefined ? null : JSON.parse(r); },
    // `which` is 'evidence' or 'withLast' (the evidence and the last reply): is `needle` in that text (indexOf >= 0)?
    walkHas: function (which, needle) { return ahHost.transcriptWalkHas(which, needle); },
    // The same sorted array `ah.re.numbers(src, flags, text, strip)` gives on that text.
    walkNumbers: function (which, src, flags, strip) { return JSON.parse(ahHost.transcriptWalkNumbers(which, src, flags || '', strip || '')); },
    // The tool uses of the lines of the last windowBytes that hold one of `needles`, read in the engine (the tasklist guard's work count):
    // null (unreadable) or, in order, ['u'] (a line only JavaScript reads exactly: stop, defer), ['n'] (a line that is JSON null: stop) and
    // [timestamp (a string, else null), [[name, file_path|null, command|null]]] per entry with a string timestamp or a tool use
    // (found through the `keys` of nested objects; a non-string name is ''). Blank and invalid lines are left out.
    toolUseScan: function (p, windowBytes, needles, keys) { var r = ahHost.toolUseScan(p, windowBytes || 0, needles, keys); return r === null || r === undefined ? null : JSON.parse(r); },
    // Finished-but-not-stopped named teammates of a Claude transcript tail: null, {unsure: true} or {teammates: [{name, idleSinceMs}]}.
    teammates: function (p, tailBytes) { var r = ahHost.transcriptTeammates(p, tailBytes || 0); return r === null || r === undefined ? null : JSON.parse(r); },
    // Finished-but-not-closed agents of a Codex rollout tail: null, {unsure: true} or {agents: [{id, label, idleSinceMs}]}.
    codexAgents: function (p, tailBytes) { var r = ahHost.transcriptCodexAgents(p, tailBytes || 0); return r === null || r === undefined ? null : JSON.parse(r); },
    // The running agents of a transcript: null (unreadable), {unsure: true}, or {rows: [{id, description, spawnInput}]}.
    agents: function (p) { return JSON.parse(ahHost.agents(p)); },
    // The same completion/liveness rules as the agent tracker, refreshed read-only.
    trackedAgents: function (p) { return JSON.parse(ahHost.trackedAgents(p.session_id || '', p.transcript_path || '', p.cwd || '')); },
    trackedLiveness: function (id, rows) {
      var matches = rows.filter(function (r) { return r.id === id; });
      if (!matches.length) matches = rows.filter(function (r) { return r.name === id; });
      if (!matches.length) return null;
      if (matches.some(function (r) { return r.known && ah.cfg('agent_tracker.guard_live_states').indexOf(r.state) >= 0; })) return true;
      return matches.every(function (r) { return ah.cfg('agent_tracker.guard_inactive_states').indexOf(r.state) >= 0; }) ? false : null;
    },
    // Like `agents`, but only the default window (the Node `runningAgents`): no widening, and an empty window is an empty list.
    agentsWindow: function (p) { return JSON.parse(ahHost.agentsWindow(p)); },
    // The last lines of a file with their byte offsets: {lines: [[offset, text|null]]} (text null: over lineMax, or not UTF-8), or null.
    tailLines: function (p, windowBytes, lineMax) { var r = ahHost.tailLines(p, windowBytes || 0, lineMax || 0); return r === null || r === undefined ? null : JSON.parse(r); },
    // The newest maxLines lines parsed by the engine and cut down to the `keep` paths (lists of keys, '*' = every array element):
    // {lines: [[offset, value]], dropped, droppedUnread} (older lines left out; of them over lineMax or not UTF-8), value null (over lineMax or not UTF-8), 0 (blank, or not a JSON object), the cut-down object,
    // or the line's text when the engine's parser refused it (parse it yourself); null when unreadable.
    tailEntries: function (p, windowBytes, lineMax, keep, maxLines) { var r = ahHost.tailEntries(p, windowBytes || 0, lineMax || 0, JSON.stringify(keep), maxLines || 0); return r === null || r === undefined ? null : JSON.parse(r); },
    // null: no readable transcript; {hint:false}: no line can hold `hint`; {unsure:true}: a line JS might read differently;
    // {parts:[...]}: the current turn's assistant text blocks.
    turnText: function (p, maxBytes, hint) { return JSON.parse(ahHost.turnText(p, maxBytes, hint || '')); },
  },
};
