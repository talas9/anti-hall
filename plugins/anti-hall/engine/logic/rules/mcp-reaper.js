// rules = "mcp-reaper": the standalone MCP orphan reaper as an engine job (D88; port of companion/mcp-reaper.js main()). The
// scheduled job `mcp_reaper` runs `ah-engine mcp-reaper run`, which calls `reap({dryRun})` through `script::call_fn`. Everything
// it decides is decided here from the process table: whether the reaper is on (maintenance.mcpReaperJob, the carried-over Node
// opt-in, a Node reaper unit still installed), which processes are orphaned MCP servers (the companion's own selection: MCP
// signature, the user's exclusion, a PID 1 or reaper parent, a parent missing from the snapshot is unsure and skipped), and which
// of them still qualify after the grace period. The host only lists, waits and signals the pids this script names
// (ah.proc.signal refuses a pid its own listing did not show, a forced signal before a polite one, the engine and its parent,
// pids below 2). Keys and texts: mcp_reaper.toml, host_proc.toml.
'use strict';

function mjArgv0(cmd) {
  if (!cmd) return '';
  var argv0 = String(cmd).trim().split(/\s+/)[0] || '';
  return argv0.replace(/^.*\//, '');
}

// `matchesMcp(cmd, extraRe)` of the companion: a real MCP command, never a mere mention of one.
function mjMatchesMcp(cmd, extra) {
  if (!cmd) return false;
  if (jx.re('mcp_reaper.mcp_self_re', 'i').test(cmd)) return false;
  if (jx.re('mcp_reaper.modelctx_re', 'i').test(cmd)) return true;
  var base = mjArgv0(cmd), runtime = jx.re('mcp_reaper.runtime_re', '').test(base), program = ah.cfg('mcp_reaper.start_program');
  if (jx.re('mcp_reaper.token_re', 'i').test(cmd) && (runtime || jx.re('mcp_reaper.token_argv0_re', 'i').test(base))) return true;
  if (jx.re('mcp_reaper.start_re', 'i').test(cmd) && (runtime || base === program)) return true;
  if ((jx.re('mcp_reaper.suffix_re', 'i').test(cmd) || jx.re('mcp_reaper.scoped_re', 'i').test(cmd)) && (runtime || jx.re('mcp_reaper.suffix_argv0_re', 'i').test(base) || base === program)) return true;
  return !!(extra && extra.test(cmd));
}

// `isReaperParent(parentPid, parentCmd)`: PID 1, the WSL relay, launchd, or the per-user systemd manager; unsure is false.
function mjReaperParent(ppid, parentCmd) {
  if (ppid === ah.cfgNum('mcp_reaper.orphan_ppid')) return true;
  if (!parentCmd) return false;
  if (jx.re('mcp_reaper.job_relay_re', '').test(parentCmd)) return true;
  var base = mjArgv0(parentCmd);
  if (ah.cfg('mcp_reaper.job_reaper_programs').indexOf(base) !== -1) return true;
  return base === ah.cfg('mcp_reaper.job_user_manager') && jx.re('mcp_reaper.job_user_flag_re', '').test(parentCmd);
}

// `findOrphans(procList, extraRe, excludeRe)`.
function mjOrphans(rows, extra, exclude) {
  var byPid = {}, out = [];
  rows.forEach(function (p) { byPid[String(p.pid)] = p; });
  rows.forEach(function (p) {
    if (!mjMatchesMcp(p.cmd, extra)) return;
    if (exclude && exclude.test(p.cmd)) return;
    if (p.ppid === ah.cfgNum('mcp_reaper.orphan_ppid')) { out.push(p); return; }
    var parent = byPid[String(p.ppid)];
    if (!parent) return;
    if (mjReaperParent(p.ppid, parent.cmd)) out.push(p);
  });
  return out;
}

// `buildExtraRe(pattern)`: the user's pattern as `new RegExp(pattern, 'i')`, null when empty or invalid.
function mjUserRe(src) {
  if (!src) return null;
  try { return new RegExp(src, 'i'); } catch (e) { return null; }
}

// `parseGrace(envVal)` of the companion's MCP_REAP_GRACE (handed in by the command): a finite number of at least zero (an explicit 0 included), else the default. An unset variable is the default.
function mjGrace(raw) {
  var dflt = ah.cfgNum('mcp_reaper.job_grace_default_s');
  if (raw === null || raw === undefined) return dflt;
  var n = Number(raw);
  return isFinite(n) && n >= 0 ? n : dflt;
}

function mjRows() {
  var listed = ah.proc.list();
  return listed === null ? [] : listed.rows;
}

// Append one companion log line; the file stops growing past the size bound, and a failed write changes nothing.
function mjLog(home, msg, args) {
  var rel = ah.cfg('mcp_reaper.job_log_rel'), size = ah.fs.size(home + '/' + rel);
  if (size !== null && size > ah.cfgNum('mcp_reaper.log_max_bytes')) return;
  var line = text.render(ah.cfg('mcp_reaper.job_line'), { ts: new Date(ah.clock.now()).toISOString(), msg: text.render(ah.cfg(msg), args || {}) });
  try { ah.state.appendFile(rel, line); } catch (e) { /* best effort, as the companion's try/catch */ }
}

// Whether the job runs at all, and why not: {on: true} or {on: false, reason}.
function mjSwitch(home) {
  var mode = ah.settings.enum('mcp_reaper.job_setting');
  if (mode === ah.cfg('mcp_reaper.job_word_off')) return { on: false, reason: 'off' };
  if (mode === ah.cfg('mcp_reaper.job_word_auto') && !ah.fs.isFile(home + '/' + ah.cfg('mcp_reaper.job_optin_rel'))) return { on: false, reason: 'not-opted-in' };
  var node = ah.cfg('mcp_reaper.job_node_units').filter(function (rel) { return ah.fs.isFile(home + '/' + rel); });
  if (node.length) return { on: false, reason: 'node-unit-installed', unit: node[0] };
  return { on: true };
}

function mjProc(p) { return { pid: p.pid, ppid: p.ppid, cmd: p.cmd }; }

function reap(args) {
  var home = spawn.osHome();
  if (home === null) return { ran: false, reason: 'no-home' };
  var sw = mjSwitch(home);
  if (!sw.on) return { ran: false, reason: sw.reason, unit: sw.unit || null };
  args = args || {};
  var dry = !!args.dryRun || args.envDry === ah.cfg('mcp_reaper.job_dry_word');
  var extra = mjUserRe(ah.settings.str('mcp_reaper.match_setting')), exclude = mjUserRe(ah.settings.str('mcp_reaper.exclude_setting'));
  var orphans = mjOrphans(mjRows(), extra, exclude);
  if (orphans.length === 0) {
    mjLog(home, 'mcp_reaper.job_msg_none');
    return { ran: true, dryRun: dry, orphans: [], termed: [], killed: [] };
  }
  if (dry) {
    orphans.forEach(function (o) { mjLog(home, 'mcp_reaper.job_msg_dry', o); });
    return { ran: true, dryRun: true, orphans: orphans.map(mjProc), termed: [], killed: [] };
  }
  var termed = [];
  orphans.forEach(function (o) {
    if (!ah.proc.signal(o.pid, false)) return;
    termed.push(o);
    mjLog(home, 'mcp_reaper.job_msg_term', o);
  });
  // the grace period (the host bounds each wait and their total)
  var left = mjGrace(args.envGrace) * 1000, step = ah.cfgNum('hostproc.sleep_max_ms');
  while (left > 0) { var w = Math.min(left, step); ah.sleep(w); left -= w; }
  // a fresh listing with the whole selection applied again: a pid recycled during the grace period must qualify on its own
  var still = {};
  mjOrphans(mjRows(), extra, exclude).forEach(function (p) { still[String(p.pid)] = true; });
  var killed = [];
  termed.forEach(function (o) {
    if (!still[String(o.pid)]) return;
    if (!ah.proc.signal(o.pid, true)) return;
    killed.push(o);
    mjLog(home, 'mcp_reaper.job_msg_kill', o);
  });
  return { ran: true, dryRun: false, orphans: orphans.map(mjProc), termed: termed.map(mjProc), killed: killed.map(mjProc) };
}
