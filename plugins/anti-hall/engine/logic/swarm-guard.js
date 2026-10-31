// check = "swarm-guard" (PreToolUse on Agent and Task; the anti fork bomb). Two gates in this order: critical memory pressure
// (available memory under a few percent of the total blocks the spawn) and the spawn rate (the cap per rolling window, counted
// in ~/.anti-hall/swarm-spawns.log under the lock file the Node hook shares). An allowed spawn is recorded, a blocked one is not
// (a blocked retry must never extend the window) but is noted in the trip log, which the decision never reads. The shared-tree
// advisory (a write-capable agent started while another runs in the same tree) rides an allowed spawn. What this script cannot
// reproduce exactly is decided natively and counted (native_unable): a log over the read cap is read from its tail (entries ascend,
// so the window is at the end), a shared-tree note it cannot settle says nothing, and the rate cap still applies. Any trouble taking the lock,
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

// The session's working tree: {dirs} (its cwd and git toplevel, lexical and real), null when there is no cwd (the named-tree reading is then off), or 'unsure' (counted).
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

// true when a rule in the owner's memory files (the project's memory folder, listed in swarm_guard.memory_sources) forbids worktrees.
function swgMemoryNoWorktrees(cwd) {
  var home = ah.home();
  if (!home) return false;
  var slug = ah.path.resolveAbs(cwd).replace(new RegExp(ah.cfg('swarm_guard.memory_slug_re'), 'g'), '-'), cap = ah.cfgNum('script.read_max_bytes');
  var dirs = ah.cfg('swarm_guard.memory_sources').map(function (d) { return ah.path.join(home, d.split('{slug}').join(slug)); });
  var re = ah.cfg('swarm_guard.re_no_worktrees');
  for (var i = 0; i < dirs.length; i++) {
    var names = ah.fs.readdir(dirs[i]);
    if (names === null) continue;
    for (var j = 0; j < names.length && j < ah.cfgNum('swarm_guard.memory_files_max'); j++) {
      if (!/\.md$/.test(names[j])) continue;
      var f = ah.path.join(dirs[i], names[j]), size = ah.fs.size(f);
      if (size === null || size > cap) continue;
      var t = ah.fs.readText(f, cap);
      if (t !== null && ah.re.test(re, 'i', t)) return true;
    }
  }
  return false;
}

function swgInScratch(inp, tree) {
  var i = swgIsObj(inp) ? inp : {};
  var t = String(i.prompt || '') + '\n' + String(i.description || '');
  var path = ah.cfg('swarm_guard.scratch_path');
  var scratch = ah.cfg('swarm_guard.scratch_alternatives').map(function (a) { return a.split('{path}').join(path); }).join('|');
  // A prohibition names the same objects as an affirmative write. Remove only those negated
  // spans; an independent affirmative clause still cancels the exemption.
  var place = ah.cfg('swarm_guard.re_in_place');
  var negated = ah.cfg('swarm_guard.re_negated_in_place').split('{place}').join(place);
  var affirmative = t.replace(new RegExp(negated, 'gi'), ' ');
  // an agent that only writes a report or results under the scratch location touches no checkout, unless it also says it edits repo files
  var scratchOnly = ah.settings.bool('swarm_guard.scratch_only_setting') &&
    ah.re.test(ah.cfg('swarm_guard.re_scratch_only').split('{path}').join(path), 'i', t) && !ah.re.test(ah.cfg('swarm_guard.re_repo_write'), 'i', t);
  return (scratchOnly || ah.re.test(scratch, 'i', t) || ah.re.test(ah.cfg('swarm_guard.re_api_only'), 'i', t) || swgNamesOtherTree(t, tree)) && !ah.re.test(ah.cfg('swarm_guard.re_scratch_negated'), 'i', t) &&
    !ah.re.test(place, 'i', affirmative);
}

function swgSharesTree(inp, tree) { return swgWriteCapable(inp) && !swgIsolated(inp) && !swgInScratch(inp, tree); }

function swgDirname(d) { var i = d.lastIndexOf('/'); return i <= 0 ? '/' : d.slice(0, i); }

// true / false, or null when the answer needs something this script cannot reproduce (counted by the caller).
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

// The advisory text, '' when silent, null when the answer cannot be reproduced (counted; no note).
function swgSharedTreeNote(p) {
  if (!ah.settings.bool('swarm_guard.shared_tree_setting')) return '';
  var inp = swgIsObj(p.tool_input) ? p.tool_input : null;
  var tree = swgTree(p.cwd);
  if (tree === 'unsure') return null;
  if (!inp || !swgSharesTree(inp, tree)) return '';
  var tp = p.transcript_path;
  if (!tp || typeof tp !== 'string') return '';
  var scan = ah.transcript.agentsWindow(tp); // Node's runningAgents: the default window only
  if (scan === null) return '';
  if (scan.unsure) return null;
  // Another agent counts only when its own spawn input is known, write-capable and not isolated.
  if (!scan.rows.some(function (a) { return a.spawnInput && swgSharesTree(a.spawnInput, tree); })) return '';
  // `String(payload.cwd || process.cwd())`: the daemon cannot know the hook process's directory
  if (!p.cwd) return null;
  var noWt = swgRepoDocsMatch(String(p.cwd), ah.cfg('swarm_guard.re_no_worktrees'));
  if (noWt === null) return null;
  if (ah.settings.bool('swarm_guard.quiet_no_worktrees_setting')) { // a rule that says main-only / no worktrees makes the hint moot
    if (noWt || swgMemoryNoWorktrees(String(p.cwd))) return '';
  }
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


// ---- usage-aware dispatch and the fan-out ceiling (GH #270). Both read what the engine already has: the usage cache the limit-conserve
// check reads (ctxbudget.usage_cache) and the running agents of the session transcript (the tracker's scan). Tokens against outcome is the
// metric; parallelism itself is fine, so the ceiling is a generous safety net that shrinks only when the 5-hour or weekly limit is near.

// The owner's concurrent-agent cap (guards.maxConcurrentAgents): a block reason, or null with the allowed spawn's slot reserved. The
// whole decision (the running agents, the reservations, the count, the new reservation) is taken under the reservation lock, never a
// snapshot read before it, so overlapping checks cannot pass the cap however launches interleave (GH #494). A reservation (keyed by the
// tool call id) counts until a tool result of its call shows in the transcript (an async launch or a foreground answer, running or
// finished) or it is older than spawn_ceiling.reservation_ttl_ms. Only a background call reserves (spawn_ceiling.background_field);
// an agent type of guards.cap_excluded_agent_types is outside the cap. Lock busy: the same count, read unlocked, decides and nothing
// is reserved; a lock left by a dead or hung check is taken over (the spawn_reservation lock group).
function swgCapGate(p, home) {
  var cap = ah.settings.num('spawn_ceiling.max_concurrent_setting');
  if (!(cap > 0) || typeof p.transcript_path !== 'string' || p.transcript_path === '') return null; // no transcript: nothing to count against, as before
  var inp = swgIsObj(p.tool_input) ? p.tool_input : {};
  if (swgCapExcluded(swgAgentType(inp))) { ah.metric('spawn_reservations', ['outcome', 'excluded_type']); return null; }
  var bgv = inp[ah.cfg('spawn_ceiling.background_field')];
  var bg = typeof bgv === 'boolean' ? bgv : ah.cfg('spawn_ceiling.reserve_unflagged');
  var session = typeof p.session_id === 'string' ? p.session_id : '', dir = ah.cfg('swarm_guard.state_dir');
  var rel = dir + '/' + ah.cfg('spawn_ceiling.reservation_file');
  var lock = ah.state.lock(dir + '/' + ah.cfg('spawn_ceiling.reservation_lock'), ah.cfg('spawn_ceiling.reservation_lock_group'));
  if (lock === null) { ah.unable('swarm-guard:cap_lock_busy'); ah.metric('spawn_reservations', ['outcome', 'lock_busy']); }
  var all = swgCapRunning(p), now = Date.now(), ttl = ah.cfgNum('spawn_ceiling.reservation_ttl_ms');
  var rows = [], raw = ah.fs.readText(ah.path.join(home, rel)), doc = null;
  if (raw !== null) { try { doc = JSON.parse(raw); } catch (e) { doc = null; } }
  if (doc && Array.isArray(doc.rows)) rows = doc.rows.filter(function (r) {
    return r && typeof r.id === 'string' && typeof r.at === 'number' && now - r.at < ttl && !(r.session === session && all.toolUseIds[r.id]);
  });
  // A counted tracker child with no launch id in its meta is still the launch of one reservation: the oldest open reservation of this
  // session with its agent type (an unknown type on either side matches) is released, one to one. The children already matched are
  // kept in the file (doc.matched), so a child releases one reservation once, not one on every later check.
  var matched = {}, nowMatched = {};
  if (doc && doc.matched && typeof doc.matched === 'object') Object.keys(doc.matched).forEach(function (k) { if (doc.matched[k] === true) matched[k] = true; });
  all.children.forEach(function (c) {
    if (c.toolUseId !== '') return;
    nowMatched[c.id] = true;
    if (matched[c.id]) return;
    var best = -1;
    rows.forEach(function (r, i) {
      if (r.session !== session) return;
      var rt = typeof r.type === 'string' ? r.type : '';
      if (rt !== '' && c.agentType !== '' && rt !== c.agentType) return;
      if (best < 0 || r.at < rows[best].at) best = i;
    });
    if (best >= 0) rows.splice(best, 1);
  });
  var open = {};
  rows.forEach(function (r) { if (r.session === session) open[r.id] = true; });
  var answered = swgAnsweredIds(p.transcript_path, open);
  rows = rows.filter(function (r) { return !(r.session === session && answered[r.id]); });
  var mine = rows.filter(function (r) { return r.session === session; }).length, n = all.n + mine;
  if (n >= cap) {
    if (lock !== null) ah.state.unlock(lock);
    ah.advisory('flagged', 'spawn_cap_block');
    ah.metric('spawns_denied_over_cap', []);
    return text.message('block', ah.cfg('spawn_ceiling.guard_name'), {
      what: text.render(ah.cfg('spawn_ceiling.msg_cap_what'), { n: n, cap: cap, names: all.names.join(ah.cfg('spawn_ceiling.join')), more: n > all.names.length ? text.render(ah.cfg('spawn_ceiling.msg_more'), { n: n - all.names.length }) : '' }),
      why: ah.cfg('spawn_ceiling.msg_why'), instead: ah.cfg('spawn_ceiling.msg_cap_instead'),
    });
  }
  if (lock === null) return null;
  if (bg) {
    var id = typeof p.tool_use_id === 'string' && p.tool_use_id !== '' ? p.tool_use_id : now + '-' + Math.random().toString(36).slice(2);
    rows.push({ id: id, session: session, at: now, type: swgAgentType(inp) });
  }
  var ok = ah.state.writeAtomic(rel, JSON.stringify({ rows: rows, matched: nowMatched }));
  ah.state.unlock(lock);
  if (!ok) ah.unable('swarm-guard:cap_reserve_write');
  ah.metric('spawn_reservations', ['outcome', !ok ? 'write_failed' : bg ? 'reserved' : 'foreground']);
  return null;
}

// A block reason, an advisory line to ride an allowed spawn ('' for none).
function swgBudgetGates(p, home) {
  var full = null, usageOn = ah.settings.bool('spawn_usage.setting') && !ah.settings.skipped(ah.cfg('spawn_usage.guard_name'));
  var ceilOn = ah.settings.bool('spawn_ceiling.setting') && !ah.settings.skipped(ah.cfg('spawn_ceiling.guard_name'));
  if (!usageOn && !ceilOn) return { block: null, note: '' };
  full = swgFullest(swgUsageBuckets(home));
  var note = '';
  if (usageOn && full) {
    if (full.pct >= ah.cfgNum('spawn_usage.block_pct')) {
      ah.advisory('flagged', 'spawn_usage_block');
      return { block: text.message('block', ah.cfg('spawn_usage.guard_name'), {
        what: text.render(ah.cfg('spawn_usage.msg_block_what'), { limit: full.name, pct: Math.round(full.pct), cap: ah.cfgNum('spawn_usage.block_pct'), resets: swgResetText(full) }),
        why: ah.cfg('spawn_usage.msg_block_why'), instead: ah.cfg('spawn_usage.msg_block_instead'),
      }), note: '' };
    }
    if (full.pct >= ah.cfgNum('spawn_usage.soft_pct')) {
      ah.advisory('injected', 'spawn_usage_soft');
      note = text.message('warn', ah.cfg('spawn_usage.guard_name'), {
        what: text.render(ah.cfg('spawn_usage.msg_soft_what'), { limit: full.name, pct: Math.round(full.pct), resets: swgResetText(full) }),
        why: ah.cfg('spawn_usage.msg_soft_why'), instead: ah.cfg('spawn_usage.msg_soft_instead'),
      });
    }
  }
  if (ceilOn) {
    var capBlock = swgCapGate(p, home);
    if (capBlock !== null) return { block: capBlock, note: '' };
    var run = swgRunning(p), ceil = swgCeiling(full);
    if (run !== null && run.n >= ceil) {
      ah.advisory('flagged', 'spawn_ceiling_block');
      return { block: text.message('block', ah.cfg('spawn_ceiling.guard_name'), {
        what: text.render(ah.cfg('spawn_ceiling.msg_what'), { n: run.n, ceiling: ceil, names: run.names.join(ah.cfg('spawn_ceiling.join')), more: run.n > run.names.length ? text.render(ah.cfg('spawn_ceiling.msg_more'), { n: run.n - run.names.length }) : '' }),
        why: ah.cfg('spawn_ceiling.msg_why'), instead: ah.cfg('spawn_ceiling.msg_instead'),
      }), note: '' };
    }
  }
  return { block: null, note: note };
}

function swgBlock(reason) { return { exact: { code: 2, out: text.blockJson(reason), err: '' } }; }

function decide(p) {
  if (p === null || typeof p !== 'object') p = {};
  var home = hookProc.home(p);
  if (home === null) { ah.unable('swarm-guard:no_home', 'abandoned'); return 'allow'; } // no home at all: no log to count in (Node's own fail-open)
  if (!ah.path.isAbsolute(ah.env.get(ah.cfg('env.home')) || '')) ah.unable('swarm-guard:home_resolved'); // HOME unset or relative: the passwd/stand-in home is used
  // nested spawn: a worker (subagent or teammate) starting agents of its own; independent of the swarm-guard switch
  if (!ah.settings.bool('nested_spawn.setting') && !ah.settings.skipped(ah.cfg('nested_spawn.guard_name')) && coordinator.subagentByPayload(p)) {
    ah.advisory('flagged', 'nested_spawn_block');
    var nested = text.message('block', ah.cfg('nested_spawn.guard_name'), {
      what: ah.cfg('nested_spawn.msg_what'), why: ah.cfg('nested_spawn.msg_why'), instead: ah.cfg('nested_spawn.msg_instead'),
    });
    // Codex reads the reason from stderr on exit 2; Claude's block keeps its empty stderr
    return coordinator.isCodexPayload(p) ? { exact: { code: 2, out: text.blockJson(nested), err: nested + '\n' } } : swgBlock(nested);
  }
  if (coordinator.isCodexPayload(p)) return 'allow'; // the rate and budget gates below count Claude's Agent and Task spawns
  if (!ah.settings.bool('swarm_guard.setting')) return 'allow';
  if (ah.settings.skipped(ah.cfg('swarm_guard.guard_name'))) return 'allow';
  var now = Date.now(), label = swgDescribe(p);

  var mem = ah.sys.memory();
  if (mem.available !== null && mem.total > 0 && mem.available / mem.total < ah.cfgNum('swarm_guard.mem_floor_percent') / 100) {
    var mb = function (b) { return Math.round(b / 1024 / 1024); };
    return swgBlock(text.render(ah.cfg('swarm_guard.msg_mem'), { avail: mb(mem.available), total: mb(mem.total) }));
  }

  var gates = swgBudgetGates(p, home);
  if (gates.block !== null) return swgBlock(gates.block);

  var note = swgSharedTreeNote(p);
  if (note === null) { ah.unable('swarm-guard:shared_tree_note_unsure'); note = ''; }
  if (gates.note) note = note ? gates.note + '\n' + note : gates.note;

  var dir = ah.cfg('swarm_guard.state_dir');
  var logRel = dir + '/' + ah.cfg('swarm_guard.log_file');
  // Could not lock: allow without recording, and without the advisory, exactly as Node does.
  var lock = ah.state.lock(dir + '/' + ah.cfg('swarm_guard.lock_file'), 'swarm_guard');
  if (lock === null) return 'allow';

  var cutoff = now - ah.cfgNum('swarm_guard.window_ms'), cap = ah.cfgNum('swarm_guard.spawn_cap');
  var recent = [], logPath = ah.path.join(home, logRel);
  var raw = null, size = ah.fs.size(logPath);
  if (size !== null && size > ah.cfgNum('script.read_max_bytes')) {
    ah.unable('swarm-guard:log_big'); // the window is at the end of the log: read its tail, without the partly cut first line
    raw = ah.fs.readEnd(logPath, ah.cfgNum('script.read_max_bytes'));
    if (raw !== null) raw = raw.slice(raw.indexOf('\n') + 1);
  } else if (size !== null) raw = ah.fs.readText(logPath, size + 1);
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
  } else {
    if (recent.some(function (t) { return t > ah.cfgNum('swarm_guard.exact_int_limit'); })) ah.unable('swarm-guard:int_past_exact'); // kept in the window as they are
    recent.push(now);
    ah.state.writeAtomic(logRel, recent.join('\n') + '\n'); // a failed write allows the spawn unrecorded, as Node
  }
  ah.state.unlock(lock);
  if (reason === null) return note ? { advisory: text.advisoryJson('PreToolUse', note) } : 'allow';
  // telemetry only, after the lock: a trip is observable but never feeds the rate window
  ah.state.appendFile(dir + '/' + ah.cfg('swarm_guard.trip_file'), new Date(now).toISOString() + '\t' + tripped + '\t' + label + '\n');
  return swgBlock(reason);
}
