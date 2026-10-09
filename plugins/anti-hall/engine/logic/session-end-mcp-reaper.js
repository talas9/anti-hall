// check = "session-end-mcp-reaper" (SessionEnd): the sweep that terminates orphaned MCP server processes a crashed earlier session left
// behind (reparented to PID 1). It acts only on a real termination (prompt_input_exit, other), only when PID 1 is an init process, and
// only on a process that is parented to PID 1, has an MCP command signature, is not a test runner or excluded by the user, is old enough
// and is not owned by the platform's service manager. It sends the polite signal, waits the grace period, re-checks the whole signature
// against a fresh listing (a recycled pid must qualify again) and sends the forced signal to those that remain; every step is appended
// to the audit log. The selection is decided HERE from the process table (ah.proc.list / ages / managed); the host only lists, probes,
// waits and signals the pids this script names (ah.proc.signal refuses anything its own listing did not show, a forced signal before a
// polite one, the engine itself and its parent, pids below 2). Nothing is written or signalled before the selection is complete, and a
// case the host cannot decide the way Node would (a probe it cannot read, an ambiguous local time) leaves the state as it was and
// defers. Mirrors hooks/session-end-mcp-reaper.js and companion/mcp-reaper.js. Keys and texts: mcp_reaper.toml, host_proc.toml.
'use strict';

function mrArgv0(cmd) {
  if (!cmd) return '';
  var argv0 = String(cmd).trim().split(/\s+/)[0] || '';
  return argv0.replace(/^.*\//, '');
}

function mrRe(key, flags) { return jx.re(key, flags); }

// `matchesMcp(cmd, extraRe)`: a real MCP command, never a mere mention of one.
function mrMatchesMcp(cmd, extra) {
  if (!cmd) return false;
  if (mrRe('mcp_reaper.mcp_self_re', 'i').test(cmd)) return false;
  if (mrRe('mcp_reaper.modelctx_re', 'i').test(cmd)) return true;
  var base = mrArgv0(cmd), runtime = mrRe('mcp_reaper.runtime_re', '').test(base), program = ah.cfg('mcp_reaper.start_program');
  if (mrRe('mcp_reaper.token_re', 'i').test(cmd) && (runtime || mrRe('mcp_reaper.token_argv0_re', 'i').test(base))) return true;
  if (mrRe('mcp_reaper.start_re', 'i').test(cmd) && (runtime || base === program)) return true;
  if ((mrRe('mcp_reaper.suffix_re', 'i').test(cmd) || mrRe('mcp_reaper.scoped_re', 'i').test(cmd)) && (runtime || mrRe('mcp_reaper.suffix_argv0_re', 'i').test(base) || base === program)) return true;
  return !!(extra && extra.test(cmd));
}

var mrRunners = { gen: -1, list: [] };
function mrExcludedRunner(cmd) {
  if (!cmd) return false;
  var g = ahHost.cfgGen();
  if (mrRunners.gen !== g) mrRunners = { gen: g, list: ah.cfg('mcp_reaper.runner_exclude_res').map(function (src) { return new RegExp(src, 'i'); }) };
  return mrRunners.list.some(function (re) { return re.test(cmd); });
}

function mrInvariant(p, extra, exclude) {
  if (p.ppid !== ah.cfgNum('mcp_reaper.orphan_ppid')) return false;
  if (!mrMatchesMcp(p.cmd, extra)) return false;
  if (exclude && exclude.test(p.cmd)) return false;
  return !mrExcludedRunner(p.cmd);
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

function decide(p, opts) {
  if (!ah.settings.bool('mcp_reaper.setting')) return 'allow';
  var reason = p && typeof p === 'object' ? mrReason(p) : null;
  if (reason === null || ah.cfg('mcp_reaper.act_reasons').indexOf(reason) === -1) return 'allow';
  // the Node hook does nothing when the companion module it reuses cannot be loaded; act only where it is present
  var root = sess.pluginRoot(opts);
  if (root === null || !ah.fs.isFile(root + '/' + ah.cfg('mcp_reaper.node_module'))) return 'defer';
  var home = spawn.osHome();
  if (home === null) return 'defer';
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
  var raw = rows.filter(function (q) { return mrInvariant(q, extra, exclude); }), kept = [], skipped = [];
  if (raw.length) {
    var exact = ah.cfgNum('hostproc.max_exact_id');
    if (raw.some(function (q) { return !(q.pid >= 0 && q.pid < exact); })) return 'defer';
    var ages = ah.proc.ages(raw.map(function (q) { return q.pid; }));
    if (ages.unsure) return 'defer';
    var aged = raw.filter(function (q) { var a = ages.ages[String(q.pid)]; return typeof a === 'number' && a >= minAge; });
    if (aged.length) {
      var m = ah.proc.managed(aged.map(function (q) { return q.pid; }));
      if (m.unsure) return 'defer';
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
  var again = ah.proc.list(), still = again === null ? [] : again.rows.filter(function (q) { return mrInvariant(q, extra, exclude); }).map(function (q) { return q.pid; });
  candidates.forEach(function (c) {
    if (still.indexOf(c.pid) === -1) return;
    mrLog(logRel, logAbs, mrProc(c, ah.cfg('mcp_reaper.action_kill')));
    ah.proc.signal(c.pid, true);
  });
  return 'allow';
}
