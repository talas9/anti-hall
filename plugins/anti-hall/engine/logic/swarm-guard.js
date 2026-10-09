// check = "swarm-guard" (PreToolUse on Agent and Task; the anti fork bomb). Two gates in this order: critical memory pressure
// (available memory under a few percent of the total blocks the spawn) and the spawn rate (the cap per rolling window, counted
// in ~/.anti-hall/swarm-spawns.log under the lock file the Node hook shares). An allowed spawn is recorded, a blocked one is not
// (a blocked retry must never extend the window) but is noted in the trip log, which the decision never reads. The shared-tree
// advisory (a write-capable agent started while another runs in the same tree) rides an allowed spawn. Anything this script
// cannot reproduce exactly defers BEFORE the spawn is recorded, so the Node hook counts it once. Any trouble taking the lock,
// reading the memory figures or writing the log allows the spawn. Mirrors hooks/swarm-guard.js and lib/shared-tree-note.js.
// Keys and messages: spawn_guards.toml (swarm_guard.*).
'use strict';

function swgToolList(v) {
  if (Array.isArray(v)) return v.map(function (x) { return String(x).trim().toLowerCase(); }).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return v.split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  return null;
}

// `a || b || c` over the named fields of the spawn input.
function swgFirst(inp, names) {
  for (var i = 0; i < names.length; i++) if (inp[names[i]]) return inp[names[i]];
  return inp[names[names.length - 1]];
}

function swgIsObj(v) { return v !== null && typeof v === 'object'; }

function swgWriteCapable(inp) {
  var i = swgIsObj(inp) ? inp : {};
  var t = typeof i.subagent_type === 'string' ? i.subagent_type.trim().toLowerCase() : '';
  if (t && ah.cfg('swarm_guard.read_only_types').indexOf(t) >= 0) return false;
  var writeTools = ah.cfg('swarm_guard.write_tools');
  var allow = swgToolList(swgFirst(i, ah.cfg('swarm_guard.allow_fields')));
  if (allow && !allow.some(function (x) { return writeTools.indexOf(x) >= 0; })) return false;
  var deny = swgToolList(swgFirst(i, ah.cfg('swarm_guard.deny_fields')));
  if (deny && ah.cfg('swarm_guard.write_tools_every').every(function (x) { return deny.indexOf(x) >= 0; })) return false;
  return true;
}

function swgIsolated(inp) {
  var v = swgIsObj(inp) && typeof inp.isolation === 'string' ? inp.isolation.trim().toLowerCase() : '';
  return ah.cfg('swarm_guard.isolation_values').indexOf(v) >= 0;
}

// The session's working tree: {dirs} (its cwd and git toplevel, lexical and real), null when there is no cwd (the named-tree reading is then off), or 'unsure' (defer).
function swgTree(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  var ctx = ah.repo.context(cwd);
  if (ctx.unsure) return 'unsure';
  var dirs = [ah.path.resolveAbs(cwd)];
  if (ctx.toplevel) dirs.push(ah.path.resolveAbs(ctx.toplevel));
  dirs.slice().forEach(function (d) { var r = ah.fs.realpath(d); if (r && dirs.indexOf(r) < 0) dirs.push(r); });
  return { dirs: dirs };
}

// True when `abs` (or, when it exists, its real path) lies inside one of the session tree's directories (lexical and real).
function swgInTree(abs, tree) {
  var cands = [abs], r = ah.fs.realpath(abs);
  if (r && r !== abs) cands.push(r);
  return cands.some(function (a) { return tree.dirs.some(function (d) { return swgUnder(a, d); }); });
}

function swgUnder(abs, dir) {
  if (!dir) return false;
  var rel = ah.path.relative(dir, abs);
  return rel === '' || (rel !== '..' && rel.indexOf('../') !== 0 && !ah.path.isAbsolute(rel));
}

// True when the brief names its own working tree (a clone, worktree, cd or work-in target) at an absolute or ~ path outside the
// session's tree: that agent works in another checkout, so it shares nothing with this one.
function swgNamesOtherTree(t, tree) {
  if (!tree) return false;
  var hits = ah.re.findAll(ah.cfg('swarm_guard.re_named_tree'), 'i', t), home = ah.home();
  for (var i = 0; i < hits.length; i++) {
    var m = t.slice(hits[i][0], hits[i][1]), at = ah.re.find(ah.cfg('swarm_guard.re_named_tree_path'), '', m);
    if (!at) continue;
    var raw = m.slice(at[0], at[1]), trim = ah.re.find(ah.cfg('swarm_guard.re_named_tree_trim'), '', raw);
    if (trim) raw = raw.slice(0, trim[0]);
    var tilde = ah.re.find(ah.cfg('swarm_guard.re_named_tree_home'), '', raw);
    if (tilde) { if (!home) continue; raw = home + raw.slice(tilde[1]); }
    if (!ah.path.isAbsolute(raw)) continue;
    var abs = ah.path.resolveAbs(raw);
    if (!swgInTree(abs, tree)) return true;
  }
  return false;
}

function swgInScratch(inp, tree) {
  var i = swgIsObj(inp) ? inp : {};
  var t = String(i.prompt || '') + '\n' + String(i.description || '');
  var path = ah.cfg('swarm_guard.scratch_path');
  var scratch = ah.cfg('swarm_guard.scratch_alternatives').map(function (a) { return a.split('{path}').join(path); }).join('|');
  return (ah.re.test(scratch, 'i', t) || swgNamesOtherTree(t, tree)) && !ah.re.test(ah.cfg('swarm_guard.re_scratch_negated'), 'i', t) &&
    !ah.re.test(ah.cfg('swarm_guard.re_in_place'), 'i', t);
}

function swgSharesTree(inp, tree) { return swgWriteCapable(inp) && !swgIsolated(inp) && !swgInScratch(inp, tree); }

function swgDirname(d) { var i = d.lastIndexOf('/'); return i <= 0 ? '/' : d.slice(0, i); }

// true / false, or null when the answer needs something this script cannot reproduce (the caller defers).
function swgRepoDocsMatch(dir0, re) {
  var ctx = ah.repo.context(dir0);
  if (ctx.unsure) return null;
  if (dir0 !== '/' && dir0.split('/').slice(1).some(function (s) { return s === '' || s === '.' || s === '..'; })) return null;
  var dir = dir0, cap = ah.cfgNum('script.read_max_bytes'), docs = ah.cfg('swarm_guard.repo_docs');
  for (var n = 0, levels = ah.cfgNum('swarm_guard.repo_docs_levels'); n < levels; n++) {
    for (var i = 0; i < docs.length; i++) {
      var f = ah.path.join(dir, docs[i]), size = ah.fs.size(f);
      if (size === null) continue;
      if (size > cap) return null;
      var t = ah.fs.readText(f, cap);
      if (t !== null && ah.re.test(re, 'i', t)) return true;
    }
    if (ctx.root === dir) break;
    var up = swgDirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

// The advisory text, '' when silent, null when the answer cannot be reproduced (defer).
function swgSharedTreeNote(p) {
  if (!ah.settings.bool('swarm_guard.shared_tree_setting')) return '';
  var inp = swgIsObj(p.tool_input) ? p.tool_input : null;
  var tree = swgTree(p.cwd);
  if (tree === 'unsure') return null;
  if (!inp || !swgSharesTree(inp, tree)) return '';
  var tp = p.transcript_path;
  if (!tp || typeof tp !== 'string') return '';
  var scan = ah.transcript.agents(tp);
  if (scan === null) return '';
  if (scan.unsure) return null;
  // Another agent counts only when its own spawn input is known, write-capable and not isolated.
  if (!scan.rows.some(function (a) { return a.spawnInput && swgSharesTree(a.spawnInput, tree); })) return '';
  // `String(payload.cwd || process.cwd())`: the daemon cannot know the hook process's directory
  if (!p.cwd) return null;
  var noWt = swgRepoDocsMatch(String(p.cwd), ah.cfg('swarm_guard.re_no_worktrees'));
  if (noWt === null) return null;
  return text.message('warn', ah.cfg('swarm_guard.shared_tree_label'), {
    what: ah.cfg('swarm_guard.msg_shared_what'), why: ah.cfg('swarm_guard.msg_shared_why'),
    instead: ah.cfg(noWt ? 'swarm_guard.msg_shared_instead_no_worktrees' : 'swarm_guard.msg_shared_instead'),
  });
}

function swgDescribe(p) {
  var tool = (p && typeof p.tool_name === 'string' && p.tool_name) || ah.cfg('swarm_guard.unknown_label');
  var inp = p && p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  var fields = ah.cfg('swarm_guard.agent_type_fields'), atype = '';
  for (var i = 0; i < fields.length && !atype; i++) if (typeof inp[fields[i]] === 'string' && inp[fields[i]]) atype = inp[fields[i]];
  return atype ? tool + ':' + atype : tool;
}

function swgBlock(reason) { return { exact: { code: 2, out: text.blockJson(reason), err: '' } }; }

function decide(p) {
  if (p === null || typeof p !== 'object') p = {};
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null || !ah.path.isAbsolute(home)) return 'defer';
  if (!ah.settings.bool('swarm_guard.setting')) return 'allow';
  if (ah.settings.skipped(ah.cfg('swarm_guard.guard_name'))) return 'allow';
  var now = Date.now(), label = swgDescribe(p);

  var mem = ah.sys.memory();
  if (mem.available !== null && mem.total > 0 && mem.available / mem.total < ah.cfgNum('swarm_guard.mem_floor_percent') / 100) {
    var mb = function (b) { return Math.round(b / 1024 / 1024); };
    return swgBlock(text.render(ah.cfg('swarm_guard.msg_mem'), { avail: mb(mem.available), total: mb(mem.total) }));
  }

  // Decided before the spawn is recorded: a deferral then leaves the count to the Node hook.
  var note = swgSharedTreeNote(p);
  if (note === null) return 'defer';

  var dir = ah.cfg('swarm_guard.state_dir');
  var logRel = dir + '/' + ah.cfg('swarm_guard.log_file');
  // Could not lock: allow without recording, and without the advisory, exactly as Node does.
  var lock = ah.state.lock(dir + '/' + ah.cfg('swarm_guard.lock_file'), 'swarm_guard');
  if (lock === null) return 'allow';

  var cutoff = now - ah.cfgNum('swarm_guard.window_ms'), cap = ah.cfgNum('swarm_guard.spawn_cap');
  var recent = [], logPath = ah.path.join(home, logRel);
  var raw = null, size = ah.fs.size(logPath);
  if (size !== null && size > ah.cfgNum('script.read_max_bytes')) { ah.state.unlock(lock); return 'defer'; }
  if (size !== null) raw = ah.fs.readText(logPath, size + 1);
  if (raw !== null) {
    recent = raw.trim().split(/\r?\n/).map(function (l) { return parseInt(l.trim(), 10); })
      .filter(function (n) { return isFinite(n) && n > 0; }).filter(function (t) { return t > cutoff; });
  }
  var tripped = -1, reason = null;
  if (recent.length >= cap) {
    tripped = recent.length;
    reason = text.message('block', ah.cfg('swarm_guard.guard_name'), {
      what: text.render(ah.cfg('swarm_guard.msg_rate_what'), { count: recent.length, cap: cap }),
      why: ah.cfg('swarm_guard.msg_rate_why'), instead: ah.cfg('swarm_guard.msg_rate_instead'),
    });
  } else if (recent.some(function (t) { return t > ah.cfgNum('swarm_guard.exact_int_limit'); })) {
    ah.state.unlock(lock);
    return 'defer';
  } else {
    recent.push(now);
    ah.state.writeAtomic(logRel, recent.join('\n') + '\n'); // a failed write allows the spawn unrecorded, as Node
  }
  ah.state.unlock(lock);
  if (reason === null) return note ? { advisory: text.advisoryJson('PreToolUse', note) } : 'allow';
  // telemetry only, after the lock: a trip is observable but never feeds the rate window
  ah.state.appendFile(dir + '/' + ah.cfg('swarm_guard.trip_file'), new Date(now).toISOString() + '\t' + tripped + '\t' + label + '\n');
  return swgBlock(reason);
}
