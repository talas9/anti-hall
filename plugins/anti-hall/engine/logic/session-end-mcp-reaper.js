// check = "session-end-mcp-reaper" (SessionEnd): the sweep that terminates orphaned MCP server processes a crashed earlier session left
// behind (reparented to PID 1). It acts only on a real termination (prompt_input_exit, other), only when PID 1 is an init process, and
// only on a process that is parented to PID 1, has an MCP command signature, is not a test runner or excluded by the user, is old enough
// and is not owned by the platform's service manager. It sends the polite signal, waits the grace period, re-checks the whole signature
// against a fresh listing (a recycled pid must qualify again) and sends the forced signal to those that remain; every step is appended
// to the audit log. The selection is decided HERE from the process table (ah.proc.list / ages / managed); the host only lists, probes,
// waits and signals the pids this script names (ah.proc.signal refuses anything its own listing did not show, a forced signal before a
// polite one, the engine itself and its parent, pids below 2). Nothing is written or signalled before the selection is complete. Every
// home is Node's os.homedir() (hookProc.adoptHome: HOME unset adopts the passwd home). What the host cannot read the way Node would
// leaves the state as it was and kills nothing (counted, native_unable, logged under mcp_reaper.unsure_log_kind): no home, the real home
// under a test marker, a process id past the exact range, a probe it cannot read. Mirrors hooks/session-end-mcp-reaper.js and companion/mcp-reaper.js. Keys and texts: mcp_reaper.toml, host_proc.toml.
'use strict';

function mrArgv0(cmd) {
  if (!cmd) return '';
  var argv0 = String(cmd).trim().split(/\s+/)[0] || '';
  return argv0.replace(/^.*\//, '');
}

function mrRe(key, flags) { return jx.re(key, flags); }

// The per-call constants of the signature test, read and compiled once per sweep, never per listed row (the listing holds hundreds of
// orphans, and a host call or a pattern lookup per row dominated the sweep). Same keys, same patterns, same order as the row test.
function mrMatcher() {
  return {
    orphan: ah.cfgNum('mcp_reaper.orphan_ppid'), program: ah.cfg('mcp_reaper.start_program'),
    self: mrRe('mcp_reaper.mcp_self_re', 'i'), modelctx: mrRe('mcp_reaper.modelctx_re', 'i'), runtime: mrRe('mcp_reaper.runtime_re', ''),
    token: mrRe('mcp_reaper.token_re', 'i'), tokenA0: mrRe('mcp_reaper.token_argv0_re', 'i'), start: mrRe('mcp_reaper.start_re', 'i'),
    suffix: mrRe('mcp_reaper.suffix_re', 'i'), scoped: mrRe('mcp_reaper.scoped_re', 'i'), suffixA0: mrRe('mcp_reaper.suffix_argv0_re', 'i'),
    runners: ah.cfg('mcp_reaper.runner_exclude_res').map(function (src) { return new RegExp(src, 'i'); })
  };
}

// `matchesMcp(cmd, extraRe)`: a real MCP command, never a mere mention of one.
function mrMatchesMcp(m, cmd, extra) {
  if (!cmd) return false;
  if (m.self.test(cmd)) return false;
  if (m.modelctx.test(cmd)) return true;
  var base = mrArgv0(cmd), runtime = m.runtime.test(base);
  if (m.token.test(cmd) && (runtime || m.tokenA0.test(base))) return true;
  if (m.start.test(cmd) && (runtime || base === m.program)) return true;
  if ((m.suffix.test(cmd) || m.scoped.test(cmd)) && (runtime || m.suffixA0.test(base) || base === m.program)) return true;
  return !!(extra && extra.test(cmd));
}

function mrInvariant(m, p, extra, exclude) {
  if (p.ppid !== m.orphan) return false;
  if (!mrMatchesMcp(m, p.cmd, extra)) return false;
  if (exclude && exclude.test(p.cmd)) return false;
  for (var i = 0; i < m.runners.length; i++) if (m.runners[i].test(p.cmd)) return false;
  return true;
}

function mrInitPid1(rows) {
  var p1 = rows.filter(function (p) { return p.pid === 1; })[0], cmd = p1 ? p1.cmd : null;
  return { cmd: cmd, init: !!cmd && ah.cfg('mcp_reaper.init_names').indexOf(mrArgv0(cmd)) !== -1 };
}

// `buildExtraRe(pattern)`: the user's pattern as `new RegExp(pattern, 'i')`, null when empty or invalid.
function mrUserRe(src) {
  if (!src) return null;
  try { return new RegExp(src, 'i'); } catch (e) { return null; }
}

// `parseEnvInt(raw, fallback)`.
function mrEnvInt(envKey, dfltKey) {
  var raw = ah.env.get(ah.cfg(envKey)), dflt = ah.cfgNum(dfltKey);
  if (raw === null) return dflt;
  var n = Number(raw);
  return isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

function mrReason(p) {
  var f = ah.cfg('mcp_reaper.reason_fields');
  for (var i = 0; i < f.length; i++) if (typeof p[f[i]] === 'string') return p[f[i]];
  return null;
}

// Append one audit line (`ts` first); it stops growing past the size bound, and a failed write changes nothing.
function mrLog(rel, abs, fields) {
  var size = ah.fs.size(abs);
  if (size !== null && size > ah.cfgNum('mcp_reaper.log_max_bytes')) return;
  var o = { ts: new Date(ah.clock.now()).toISOString() };
  Object.keys(fields).forEach(function (k) { o[k] = fields[k]; });
  try { ah.state.appendFile(rel, JSON.stringify(o) + '\n'); } catch (e) { /* best effort, as Node's try/catch */ }
}

function mrProc(p, action) { return { pid: p.pid, ppid: p.ppid, cmd: p.cmd, action: action }; }

// Node's os.homedir() for this call: false when there is none or it is the real home under a test marker (Node's own guard then writes nothing);
// a relative HOME is resolved against the stand-in directory (counted).
function mrAdopt(p) {
  var why = hookProc.adoptHome();
  if (why === null) return true;
  ah.unable('mcp-reaper:' + why);
  if (why !== 'relative_home') return false;
  var h = hookProc.home(p);
  if (h === null) return false;
  ah.useHome(h);
  return true;
}

// A selection the host cannot prove exactly kills nothing (counted and logged).
function mrHold(why) { ah.unable('mcp-reaper:' + why); ah.log(ah.cfg('mcp_reaper.unsure_log_kind'), why); return 'allow'; }

function decide(p) {
  if (!mrAdopt(p)) return 'allow';
  if (!ah.settings.bool('mcp_reaper.setting')) return 'allow';
  var reason = p && typeof p === 'object' ? mrReason(p) : null;
  if (reason === null || ah.cfg('mcp_reaper.act_reasons').indexOf(reason) === -1) return 'allow';
  // The Node hook reuses companion/mcp-reaper.js's signature test and does nothing when that module cannot be loaded. The engine
  // carries the whole selection itself (mrInvariant and the host process probes), so it acts with or without the Node module: the
  // two differ only on an install whose companion file is gone, where the engine still sweeps (the sweep is the feature).
  var home = ah.home();
  var listed = ah.proc.list();
  if (listed === null || listed.rows.length === 0) return 'allow';
  var rows = listed.rows;
  var logRel = ah.cfg('paths.base_dir') + '/' + ah.cfg('mcp_reaper.log_dir') + '/' + ah.cfg('mcp_reaper.log_file'), logAbs = home + '/' + logRel;
  var pid1 = mrInitPid1(rows);
  if (!pid1.init) {
    mrLog(logRel, logAbs, { event: ah.cfg('mcp_reaper.event_skip'), reason: ah.cfg('mcp_reaper.reason_pid1'), pid1Cmd: pid1.cmd || null });
    return 'allow';
  }
  var extra = mrUserRe(ah.settings.str('mcp_reaper.match_setting')), exclude = mrUserRe(ah.settings.str('mcp_reaper.exclude_setting'));
  var minAge = mrEnvInt('mcp_reaper.min_age_env', 'mcp_reaper.min_age_default_s'), max = mrEnvInt('mcp_reaper.max_env', 'mcp_reaper.max_default');
  // ---- the selection: signature, parent PID 1, exclusions; the age floor; the service-manager filter; the cap ----
  var matcher = mrMatcher(), raw = rows.filter(function (q) { return mrInvariant(matcher, q, extra, exclude); }), kept = [], skipped = [];
  if (raw.length) {
    var exact = ah.cfgNum('hostproc.max_exact_id');
    if (raw.some(function (q) { return !(q.pid >= 0 && q.pid < exact); })) return mrHold('pid_range');
    var ages = ah.proc.ages(raw.map(function (q) { return q.pid; }));
    if (ages.unsure) return mrHold('ages');
    var aged = raw.filter(function (q) { var a = ages.ages[String(q.pid)]; return typeof a === 'number' && a >= minAge; });
    if (aged.length) {
      var m = ah.proc.managed(aged.map(function (q) { return q.pid; }));
      if (m.unsure) return mrHold('managed');
      if (m.unverifiable) {
        skipped = aged.map(function (q) { return { proc: q, reason: ah.cfg('mcp_reaper.reason_launchd_unverifiable') }; });
      } else {
        var why = ah.cfg(m.platform === 'launchd' ? 'mcp_reaper.reason_launchd' : 'mcp_reaper.reason_systemd');
        aged.forEach(function (q) {
          if (m.managed.indexOf(q.pid) !== -1) skipped.push({ proc: q, reason: why }); else kept.push(q);
        });
      }
    }
  }
  var candidates = kept.slice(0, max);
  // ---- the selection is final: from here on nothing is handed to Node ----
  skipped.forEach(function (s) {
    var f = mrProc(s.proc, ah.cfg('mcp_reaper.action_skip'));
    f.reason = s.reason;
    mrLog(logRel, logAbs, f);
  });
  mrLog(logRel, logAbs, { event: ah.cfg('mcp_reaper.event_scan'), reason: reason, candidates: candidates.length });
  if (candidates.length === 0) return 'allow';
  candidates.forEach(function (c) { mrLog(logRel, logAbs, mrProc(c, ah.cfg('mcp_reaper.action_term'))); });
  candidates.forEach(function (c) { ah.proc.signal(c.pid, false); });
  ah.sleep(ah.cfgNum('mcp_reaper.grace_ms'));
  // a fresh listing: a pid recycled during the grace period must qualify again on its own signature
  var again = ah.proc.list(), matcher2 = mrMatcher(), still = again === null ? [] : again.rows.filter(function (q) { return mrInvariant(matcher2, q, extra, exclude); }).map(function (q) { return q.pid; });
  candidates.forEach(function (c) {
    if (still.indexOf(c.pid) === -1) return;
    mrLog(logRel, logAbs, mrProc(c, ah.cfg('mcp_reaper.action_kill')));
    ah.proc.signal(c.pid, true);
  });
  return 'allow';
}
