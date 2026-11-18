// check = "edit-guard" (PreToolUse on Edit, Write, MultiEdit, NotebookEdit; apply_patch for Codex). The coordinator delegation gate:
// a write into the launcher directory (~/.anti-hall/bin) is blocked for every agent, literally or through a symlink already on disk;
// every call that is not the main thread passes; on the main thread the verdict on each target is the one of hooks/edit-guard.js
// (`editVerdict`: the coordinator allowlist with its symlink / hard-link honesty walk, the project root, the trusted per-repository
// edit allowlist, the harness plan file, the session scratchpad, handover documents, plan mode), and a Codex patch is parsed with the
// shared apply_patch parser (lib/77-apply-patch.js; a patch it rejects is blocked on the main thread, as in Node).
//
// The verdict code is command-guard's port of the same Node functions (command.js, which this script builds on: script.includes), so
// the Bash edit parity and this guard cannot drift apart. Mirrors hooks/edit-guard.js `main`, hooks/lib/devswarm-role.js
// `isChildWorker` and hooks/lib/inline-work-nudge.js. Keys and texts: small_guards.toml (edit_guard.*), guards_l12.toml, command.toml.
//
// Never weaker than Node: what only the Node hook process could see (its own working directory or home, a layout the file system
// primitives do not classify) is decided natively and counted (native_unable): a relative path resolves against the stand-in
// directory, a home it cannot find protects nothing extra. The DevSwarm Primary inline-work note is decided here too, from the
// transcript's open tasks and the app database's live workspaces (silent whenever the liveness is unknown).
'use strict';

function egIsObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// `value || ''` for a path-like field: the falsy values are '', anything else is its string form (an array or object renders as in JavaScript).
function egStr(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '' || (typeof v === 'number' && v !== v)) return '';
  if (typeof v === 'object') ah.unable('edit-guard:object_path');
  return String(v);
}

function egSlashes(p) { return p.split('\\').join('/'); }
function egInside(real, dir) { return real === dir || (real.indexOf(dir) === 0 && real.slice(dir.length).charAt(0) === '/'); }

// hooks/edit-guard.js resolvesIntoLauncherBinDir: true / false; a home or directory the request lacks comes from the passwd entry or the stand-in directory (counted).
function egIntoLauncher(file, cwd) {
  if (file === '') return false;
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null) { ah.unable('edit-guard:launcher_no_home'); home = ah.env.passwdHome(); if (home === null) return false; }
  if (home === '') return false;
  if (!ah.path.isAbsolute(home)) { ah.unable('edit-guard:launcher_relative_home'); home = ah.path.resolveAbs(hookProc.base() + '/' + home); }
  var abs;
  if (ah.path.isAbsolute(file)) abs = ah.path.resolveAbs(file);
  else if (ah.path.isAbsolute(cwd)) abs = ah.path.resolve(cwd, file);
  else { ah.unable('edit-guard:launcher_relative_cwd'); abs = ah.path.resolveAbs((cwd === '' ? hookProc.base() : hookProc.base() + '/' + cwd) + '/' + file); }
  var binDir = ah.cfg('edit_guard.launcher_dir').reduce(function (acc, part) { return ah.path.resolve(acc, part); }, ah.path.resolveAbs(home));
  var normBin = egSlashes(binDir).replace(/\/+$/, '');
  if (egInside(egSlashes(abs), normBin)) return true;
  // a symlink already on disk: the real target against the real launcher directory (a path that does not exist yet has no real
  // target, and the literal test above stands). fs.realpathSync keeps every component as it was spelled.
  var realAbs;
  try { realAbs = fs.realpathSync(abs); } catch (e) { if (e && e.unsure) throw e; return false; }
  var realBin = normBin;
  try { realBin = egSlashes(fs.realpathSync(binDir)); } catch (e) { if (e && e.unsure) throw e; /* the launcher directory does not exist yet */ }
  return egInside(egSlashes(realAbs), realBin);
}

// hooks/lib/devswarm-role.js isChildWorker (cmdChildWorker in command.js): a DevSwarm child workspace corroborated on disk.
function egChildWorker(cwd) { return cmdChildWorker(cwd); }

// hooks/lib/handover-find.js sessionProjectRoot: the outermost checkout unless that is the real home.
function egProjectRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd) return cwd;
  try {
    var ctx = LIB['../companion/lib/identity.js'].resolveContext(cwd);
    var home = os.homedir(), realHome = home;
    try { realHome = fs.realpathSync(home); } catch (e) { if (e.unsure) throw e; }
    if (ctx && ctx.worktreeRoot && ctx.worktreeRoot !== realHome) return ctx.worktreeRoot;
  } catch (e) { if (cmdFatal(e)) throw e; }
  return cwd;
}

// handoverRedirectPath: <project root>/.anti-hall/handovers/<YYYY-MM-DD>/<session id>/HANDOVER.md
function egHandoverPath(cwd, p) {
  var root = cwd;
  try { root = egProjectRoot(cwd) || cwd; } catch (e) { if (cmdFatal(e)) throw e; root = cwd; }
  var spec = ah.cfg('edit_guard.handover_parts');
  var sid = String((p && p.session_id) || spec.placeholder).replace(new RegExp(ah.cfg('edit_guard.session_id_unsafe'), 'g'), '_');
  var date = ho.localDate();
  if (date === null) { ah.unable('edit-guard:local_date'); date = new Date(ah.clock.now()).toISOString().slice(0, 10); } // a request zone other than the engine's own: the UTC date
  return path.join.apply(null, [root].concat(spec.dir, [date, sid, spec.file]));
}

// The coordinator delegation block text for `tool` (hooks/edit-guard.js delegationReason).
function egDelegation(tool, cwd, p) {
  var HT = LIB['./lib/host-text.js'];
  var codexHost = HT.isCodex(p);
  var SUB = codexHost ? HT.CODEX_SUBAGENT : ah.cfg('command.claude_subagent');
  var devswarmActive = LIB['./lib/devswarm-detect.js'].isDevswarmActive();
  var override = text.render(ah.cfg('command.msg_edit_override'), { skip: LIB['./lib/skip-cmd.js'].skipCommand(ah.cfg('command.edit_guard_name')) });
  var notes = codexHost ? text.render(ah.cfg('command.msg_edit_notes_codex'), { sub: SUB }) : ah.cfg('command.msg_edit_notes');
  var what = text.render(ah.cfg('edit_guard.msg_what'), { tool: tool, who: ah.cfg(devswarmActive ? 'command.msg_edit_who_orch' : 'command.msg_edit_who_coord') });
  var guard = ah.cfg('command.edit_guard_name');
  if (devswarmActive) {
    var childWorkspace = LIB['./lib/devswarm-role.js'].isChildWorkspace();
    var tierText = false;
    try { tierText = !childWorkspace && LIB['./lib/primary-tier.js'].primaryTierTextOn(null, cwd); } catch (e) { if (cmdFatal(e)) throw e; tierText = false; }
    return text.detailsMessage('block', guard, {
      what: what, why: ah.cfg('command.msg_edit_why_orch'),
      instead: text.render(ah.cfg(tierText ? 'command.msg_edit_instead_tier' : 'command.msg_edit_instead'), { sub: SUB }),
      allowed: notes, override: override,
    }, p && p.session_id);
  }
  return text.detailsMessage('block', guard, { what: what, why: ah.cfg('command.msg_edit_why'), instead: text.render(ah.cfg('command.msg_edit_instead'), { sub: SUB }), override: override }, p && p.session_id);
}

// The line count of a text, 0 for no text.
function egLines(t) { return typeof t === 'string' && t !== '' ? t.split('\n').length - (t.charAt(t.length - 1) === '\n' ? 1 : 0) : 0; }

// The occurrences of `needle` in the file an Edit targets, or null when they cannot be counted (no path, no file, too big, unreadable,
// empty needle): the caller then treats the edit as large (fail closed).
function egOccurrences(file, needle, cwd) {
  if (typeof file !== 'string' || file === '' || typeof needle !== 'string' || needle === '') return null;
  var abs = ah.path.isAbsolute(file) ? file : (ah.path.isAbsolute(cwd) ? ah.path.resolve(cwd, file) : null);
  if (abs === null) return null;
  var size = ah.fs.size(abs);
  if (size === null || size > ah.cfgNum('script.read_max_bytes')) return null;
  var raw = ah.fs.readText(abs);
  return raw === null ? null : raw.split(needle).length - 1;
}

// The size in lines of this edit (GH #783): the largest text field of one edit, the sum over a list of edits, the changed lines of a patch.
// An edit that replaces every occurrence counts what it replaces in the target file (occurrences x the larger of the old and new text);
// a file that cannot be read counts as cap_edit_unreadable_lines. null when the call carries nothing countable (the delegation block then stands).
function egEditLines(ti, codexPatch, cwd) {
  if (codexPatch) {
    var pre = ah.cfg('edit_guard.cap_edit_patch_prefixes'), hdr = ah.cfg('edit_guard.cap_edit_patch_headers'), n = 0;
    String(ti.command || '').split('\n').forEach(function (l) {
      if (hdr.some(function (h) { return l.indexOf(h) === 0; })) return;
      if (pre.some(function (c) { return l.indexOf(c) === 0; })) n++;
    });
    return n > 0 ? n : null;
  }
  var fields = ah.cfg('edit_guard.cap_edit_text_fields');
  var file = egStr(ti.file_path);
  var one = function (o, inherited) {
    var m = 0;
    if (!egIsObj(o)) return 0;
    fields.forEach(function (f) { m = Math.max(m, egLines(o[f])); });
    if (m > 0 && (o[ah.cfg('edit_guard.cap_replace_all_field')] === true || (o[ah.cfg('edit_guard.cap_replace_all_field')] === undefined && inherited === true))) {
      var occ = egOccurrences(file, o[ah.cfg('edit_guard.cap_replace_all_needle')], cwd);
      m = occ === null ? ah.cfgNum('edit_guard.cap_edit_unreadable_lines') : m * Math.max(1, occ);
    }
    return m;
  };
  var list = ti[ah.cfg('edit_guard.cap_edit_list_field')], total = one(ti, false);
  if (Array.isArray(list)) total += list.reduce(function (a, e) { return a + one(e, false); }, 0);
  return total > 0 ? total : null;
}

// The usage buckets of the cache as [{name, pct, resetsAt}]; pct is null for a reading that cannot be trusted (a stale cache with no
// reset time). A window whose reset has passed counts 0. Model-specific weekly buckets (edit_guard.cap_scoped_*) are included. null: no cache.
function egCapBuckets(home) {
  var file = ah.path.join(home, ah.cfg('ctxbudget.usage_cache')), size = ah.fs.size(file);
  if (size === null || size > ah.cfgNum('script.read_max_bytes')) return null;
  var raw = ah.fs.readText(file), parsed;
  if (raw === null) return null;
  try { parsed = JSON.parse(raw); } catch (e) { return null; }
  if (!egIsObj(parsed) || !egIsObj(parsed.data)) return null;
  var d = parsed.data, ts = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0, now = ah.clock.now();
  var stale = ts > 0 && (now - ts) > ah.cfgNum('ctxbudget.usage_max_stale_ms'), out = [];
  var scopedBucket = false;
  var add = function (name, pct, at) {
    if (typeof pct !== 'number') return;
    var rt = typeof at === 'string' && at !== '' ? new Date(at).getTime() : NaN;
    if (typeof at === 'string' && at !== '') {
      if (isFinite(rt) && rt < now) pct = 0; // that window already reset
    } else if (stale) pct = null; // a stale reading with no reset time proves nothing
    out.push({ name: name, pct: pct, resetsAt: typeof at === 'string' && at !== '' ? at : null, scoped: scopedBucket === true });
  };
  var pcts = ah.cfg('spawn_usage.bucket_pct'), resets = ah.cfg('spawn_usage.bucket_resets'), names = ah.cfg('spawn_usage.bucket_names');
  for (var i = 0; i < pcts.length; i++) add(names[i], d[pcts[i]], d[resets[i]]);
  var scoped = d[ah.cfg('edit_guard.cap_scoped_field')], keys = ah.cfg('edit_guard.cap_scoped_keys');
  scopedBucket = true;
  if (Array.isArray(scoped)) scoped.forEach(function (o, k) {
    if (egIsObj(o)) add(String(o[keys.name] || o[keys.label] || ('scoped' + k)), o[keys.pct], o[keys.resets]);
  });
  return out;
}

// The last readings at or above the hard stop, by bucket name: {name: {pct, resetsAt, seen}}. {} when none or unreadable.
function egCapState() {
  var sh = spawn.stateHome();
  if (sh.unknown) { ah.unable('edit-guard:cap_no_home'); return { rel: null, st: {} }; }
  if (sh.guarded) return { rel: null, st: {} };
  var rel = ah.cfg('spawn_ctx.state_root') + '/' + ah.cfg('edit_guard.cap_state_file'), st = {};
  var size = ah.fs.size(sh.ok + '/' + rel);
  if (size !== null && size <= ah.cfgNum('script.read_max_bytes')) {
    var raw = ah.fs.readText(sh.ok + '/' + rel);
    try { var o = raw === null ? null : JSON.parse(raw); if (egIsObj(o)) st = o; } catch (e) { st = {}; }
  }
  return { rel: rel, st: st };
}

// The fullest usage bucket {name, pct, resetsAt, hard} when it has reached edit_guard.cap_edit_pct and the relief is on, else null.
// Every weekly bucket counts, the model-specific ones too. A reading at the hard stop (spawn_usage.block_pct) is remembered, and while
// the cache is missing, stale or has lost the reset time, it still counts until its reset provably passed (a reading with no reset time:
// until cap_state_max_age_ms), so the main thread is never left with neither a helper to hand the edit to nor the right to make it.
function egCapUsage(p) {
  if (!ah.settings.bool('edit_guard.cap_edit_setting')) return null;
  var home = hookProc.home(p);
  if (home === null) return null;
  var now = ah.clock.now(), hard = ah.cfgNum('spawn_usage.block_pct'), spawnNames = ah.cfg('spawn_usage.bucket_names');
  var cur = egCapBuckets(home) || [], mem = egCapState(), st = mem.st, dirty = false, seen = {}, cand = [];
  cur.forEach(function (b) {
    if (b.pct === null) return;
    seen[b.name] = true;
    cand.push(b);
    if (b.pct >= hard) { st[b.name] = { pct: b.pct, resetsAt: b.resetsAt, seen: now, scoped: b.scoped }; dirty = true; }
    else if (st[b.name] !== undefined) { delete st[b.name]; dirty = true; }
  });
  Object.keys(st).forEach(function (name) {
    if (seen[name]) return;
    var r = st[name], rt = r && typeof r.resetsAt === 'string' ? new Date(r.resetsAt).getTime() : NaN;
    // a remembered reading is bounded by cap_state_max_age_ms whatever its reset time says (a far-future reset must not outlive the cache)
    var live = egIsObj(r) && typeof r.pct === 'number' && typeof r.seen === 'number' && now - r.seen < ah.cfgNum('edit_guard.cap_state_max_age_ms') && (!isFinite(rt) || rt > now);
    if (live) cand.push({ name: name, pct: r.pct, resetsAt: r.resetsAt, scoped: r.scoped === true });
    else { delete st[name]; dirty = true; }
  });
  if (dirty && mem.rel !== null) {
    ah.commit();
    try { ah.state.writeAtomic(mem.rel, JSON.stringify(st)); } catch (e) { /* best effort: the next call reads the cache again */ }
  }
  var full = swgFullest(cand);
  if (full === null || full.pct < ah.cfgNum('edit_guard.cap_edit_pct')) return null;
  // spawning is stopped only by the buckets the spawn guard counts (spawn_usage.bucket_names); a model-specific bucket never stops it
  var stop = swgFullest(cand.filter(function (b) { return b.scoped !== true && spawnNames.indexOf(b.name) >= 0; }));
  var isHard = stop !== null && stop.pct >= hard;
  var shown = isHard ? stop : full;
  return { name: shown.name, pct: shown.pct, resetsAt: shown.resetsAt, hard: isHard };
}

function egBlock(reason, codexPatch) { return { exact: { code: 2, out: text.blockJson(reason), err: codexPatch ? reason + '\n' : '' } }; }

// hooks/lib/inline-work-nudge.js evaluate. Returns null when Node writes nothing, else {st, rel, dir, prune, note}: the counter of this
// session to write once the verdict is known and the note to say (once per session, when it is past the threshold, an open task is
// pending and the app database proves no live workspace; any doubt stays silent).
function egNudge(p, tool, cwd) {
  if (ah.cfg('edit_guard.edit_tools').indexOf(tool) < 0 || !p.session_id) return null;
  if (!ah.settings.bool('edit_guard.nudge_setting')) return null;
  if (!LIB['./lib/devswarm-detect.js'].isDevswarmActive() || LIB['./lib/devswarm-role.js'].isChildWorkspace()) return null;
  if (noWorkspaceRepo(p.cwd || process.cwd())) return null;
  var sh = spawn.stateHome();
  if (sh.unknown) { ah.unable('edit-guard:nudge_no_home'); return null; }
  if (sh.guarded) return null; // resolveHome throws under a test run on the real home: Node's evaluate gives up
  var safe = String(p.session_id).replace(new RegExp(ah.cfg('edit_guard.nudge_sid_unsafe'), 'g'), '_').slice(0, ah.cfgNum('edit_guard.nudge_sid_max'));
  var dir = ah.cfg('spawn_ctx.state_root');
  var rel = dir + '/' + ah.cfg('edit_guard.nudge_state_prefix') + safe + ah.cfg('edit_guard.nudge_state_ext');
  var abs = sh.ok + '/' + rel;
  var st = { count: 0, nudged: false };
  var size = ah.fs.size(abs);
  if (size !== null && size > ah.cfgNum('script.read_max_bytes')) { ah.unable('edit-guard:nudge_state_big'); return null; }
  var raw = size === null ? null : ah.fs.readText(abs);
  if (raw !== null) {
    if (raw.indexOf('\ufffd') >= 0) ah.unable('edit-guard:nudge_state_utf8'); // not valid UTF-8: decoded as the host does
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') st = { count: Number(parsed.count) || 0, nudged: !!parsed.nudged };
    } catch (e) { /* a first call */ }
  }
  if (st.nudged) return null;
  st.count += 1;
  var t = Number(ah.settings.numStrict('edit_guard.nudge_threshold_setting'));
  var threshold = isFinite(t) && t >= 1 ? t : ah.cfgNum('edit_guard.nudge_default_threshold');
  var note = null;
  if (st.count > threshold) {
    var tp = p.transcript_path;
    if (tp && typeof tp === 'string' && ah.fs.kind(tp) !== null) {
      var open = tk.tasks(tp, ah.home(), p.session_id).filter(function (x) { return tk.isOpen(x) && tk.blockedOnText(x) === ''; });
      // positive proof of zero live workspaces: the app database is present and readable and lists none that is not archived
      var proven = tk.appDbPresent(ah.home()) && tk.appBuilders() !== null && !tk.anyLiveChildren();
      if (open.length > 0 && proven) note = ah.cfg('edit_guard.nudge_note');
    }
  }
  var prune = !gk.pruneMeetsLink(dir, ah.cfg('edit_guard.nudge_prune_prefix'));
  if (!prune) ah.unable('edit-guard:nudge_prune_link'); // a link in the state directory: nothing is pruned
  return { st: st, rel: rel, dir: dir, prune: prune, note: note };
}

// GH #802: an edit tool's target (or an apply_patch file) that is a session transcript: every agent, whatever the edit-guard switch says.
function egTranscript(p) {
  if (!egIsObj(p) || !ah.settings.bool('transcript_protect.sw')) return null;
  var tool = p.tool_name;
  if (typeof tool !== 'string') return null;
  var ti = egIsObj(p.tool_input) ? p.tool_input : {}, files = [], codexPatch = tool === ah.cfg('edit_guard.patch_tool');
  if (codexPatch) {
    var parsed = applyPatch.parse(ti.command);
    if (parsed.ok) parsed.files.forEach(function (f) { files.push(f.path); if (f.moveTo !== null && f.moveTo !== undefined) files.push(f.moveTo); });
  } else if (ah.cfg('edit_guard.edit_tools').indexOf(tool) >= 0) {
    files.push(tool === ah.cfg('edit_guard.notebook_tool') ? ti.notebook_path : ti.file_path);
  } else return null;
  for (var i = 0; i < files.length; i++) {
    if (tp.editHit(egStr(files[i]), p)) {
      ah.metric('transcript_write_blocked', ['kind', ah.cfg('transcript_protect.kinds').edit]);
      return egBlock(text.message('block', ah.cfg('edit_guard.guard_name'), { what: ah.cfg('transcript_protect.msg_what') }), codexPatch);
    }
  }
  return null;
}

function egMain(p) {
  var transcript = egTranscript(p);
  if (transcript !== null) return transcript;
  if (!ah.settings.bool('edit_guard.setting') || ah.settings.skipped(ah.cfg('edit_guard.guard_name'))) return 'allow';
  var tool = egIsObj(p) ? p.tool_name : undefined;
  if (typeof tool !== 'string') return 'allow';
  var codexPatch = tool === ah.cfg('edit_guard.patch_tool');
  if (!codexPatch && ah.cfg('edit_guard.edit_tools').indexOf(tool) < 0) return 'allow';

  var ti = p.tool_input || {};
  var cwd = egStr(p.cwd);
  var paths, patchError = null;
  if (codexPatch) {
    var parsed = applyPatch.parse(ti.command);
    paths = [];
    if (parsed.ok) {
      var base = cwd ? String(cwd) : process.cwd();
      parsed.files.forEach(function (f) {
        paths.push(path.resolve(base, f.path));
        if (f.moveTo !== null && f.moveTo !== undefined) paths.push(path.resolve(base, f.moveTo));
      });
    } else patchError = parsed.error;
  } else {
    paths = [egStr(tool === ah.cfg('edit_guard.notebook_tool') ? ti.notebook_path : ti.file_path)];
  }

  // the launcher directory: every agent
  if (paths.some(function (fp) { return egIntoLauncher(fp, cwd); })) {
    return egBlock(text.message('block', ah.cfg('edit_guard.guard_name'), {
      what: text.render(ah.cfg('edit_guard.msg_launcher_what'), { tool: tool }), why: ah.cfg('edit_guard.msg_launcher_why'),
      instead: ah.cfg('edit_guard.msg_launcher_instead'), allowed: ah.cfg('edit_guard.msg_launcher_allowed'),
    }), codexPatch);
  }

  if (!coordinator.isCoordinator(p)) return 'allow';
  // a DevSwarm child workspace is a worker on its own branch: its edits are its job
  if (egChildWorker(cwd)) return 'allow';

  var guard = ah.cfg('edit_guard.guard_name');
  var sub = function () { return LIB['./lib/host-text.js'].isCodex(p) ? LIB['./lib/host-text.js'].CODEX_SUBAGENT : ah.cfg('command.claude_subagent'); };
  if (patchError !== null) {
    return egBlock(text.message('block', guard, {
      what: text.render(ah.cfg('edit_guard.msg_patch_what'), { error: patchError }), why: ah.cfg('edit_guard.msg_patch_why'),
      instead: text.render(ah.cfg('edit_guard.msg_patch_instead'), { sub: sub() }),
    }), codexPatch);
  }

  // the first target that is not allowed decides; the nudge counter is written after the verdict is known, never before a deferral
  var verdict = 'allow', at = '';
  for (var i = 0; i < paths.length && verdict === 'allow'; i++) {
    verdict = LIB['./edit-guard.js'].editVerdict(paths[i], cwd, p);
    at = paths[i];
  }
  var nudge = egNudge(p, tool, cwd);
  var reason = null, standNote = '';
  if (verdict === 'block-self-edit') {
    reason = text.message('block', guard, {
      what: text.render(ah.cfg('edit_guard.msg_self_edit_what'), { tool: tool }), why: ah.cfg('edit_guard.msg_self_edit_why'),
      instead: text.render(ah.cfg('edit_guard.msg_self_edit_instead'), { sub: sub() }),
    });
  } else if (verdict === 'block-handover-outside') {
    var right = egHandoverPath(cwd, p);
    reason = text.message('block', guard, {
      what: text.render(ah.cfg('edit_guard.msg_outside_what'), { tool: tool }), why: ah.cfg('edit_guard.msg_outside_why'),
      instead: text.render(ah.cfg('edit_guard.msg_outside_instead'), { path: right }), allowed: right,
    });
  } else if (verdict === 'block-handover') {
    reason = text.message('block', guard, {
      what: text.render(ah.cfg('edit_guard.msg_new_what'), { tool: tool }), why: ah.cfg('edit_guard.msg_new_why'),
      instead: ah.cfg('edit_guard.msg_new_instead'), allowed: ah.cfg('edit_guard.msg_new_allowed'),
      override: text.render(ah.cfg('edit_guard.msg_new_override'), { skip: LIB['./lib/skip-cmd.js'].skipCommand(ah.cfg('command.edit_guard_name')) }),
    });
  } else if (verdict !== 'allow') {
    // while spawning is stopped there is nobody to delegate to: the edit is allowed inline, with a one-time note
    var stop = sd.applies(p, guard);
    if (stop === null) {
      // near the usage cap a small edit is made here: the delegation block would send the main thread to a helper the usage rule asks it not to start
      var cap = egCapUsage(p), size = cap === null || cap.hard ? null : egEditLines(ti, codexPatch, cwd), lim = ah.cfgNum('edit_guard.cap_edit_max_lines');
      var pct = cap === null ? 0 : Math.round(cap.pct);
      // at the hard stop spawning is stopped (the stand-down's own case, here proven from the remembered reading): every edit is allowed
      if (cap !== null && cap.hard) standNote = text.render(ah.cfg('edit_guard.msg_cap_hard_note'), { pct: pct, name: cap.name, resets: swgResetText(cap) });
      else if (cap === null || size === null) reason = egDelegation(tool, cwd, p);
      else if (size <= lim) standNote = text.render(ah.cfg('edit_guard.msg_cap_note'), { pct: pct, lines: size, max: lim });
      else reason = text.message('block', guard, {
        what: text.render(ah.cfg('edit_guard.msg_cap_what'), { tool: tool, lines: size, max: lim, pct: pct }), why: ah.cfg('edit_guard.msg_cap_why'),
        instead: text.render(ah.cfg('edit_guard.msg_cap_instead'), { max: lim, resets: swgResetText(cap) }),
      });
    } else standNote = sd.note(p, stop);
  }
  var say = null;
  if (nudge !== null) {
    if (reason === null && nudge.note !== null) { nudge.st.nudged = true; say = nudge.note; } // a blocked call never uses up the once-per-session note
    ah.commit();
    try {
      ah.state.writeAtomic(nudge.rel, JSON.stringify(nudge.st));
      if (nudge.prune) gk.pruneStale(nudge.dir, ah.cfg('edit_guard.nudge_prune_prefix'));
    } catch (e) { /* best effort, as in Node */ }
  }
  if (reason !== null) return egBlock(reason, codexPatch);
  if (standNote !== '') say = say === null ? standNote : say + '\n' + standNote;
  return say === null ? 'allow' : { advisory: text.advisoryJson('PreToolUse', say) };
}

function decide(p, opts, event) {
  cmdBegin(opts);
  var v;
  try { v = egMain(p); } finally { cmdEnd(); } // a fatal exception (stack, memory, time) reaches the engine's own failure policy
  return v === null || v === undefined ? 'allow' : v;
}
