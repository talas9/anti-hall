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
    return text.message('block', guard, {
      what: what, why: ah.cfg('command.msg_edit_why_orch'),
      instead: text.render(ah.cfg(tierText ? 'command.msg_edit_instead_tier' : 'command.msg_edit_instead'), { sub: SUB }),
      allowed: notes, override: override,
    });
  }
  return text.message('block', guard, { what: what, why: ah.cfg('command.msg_edit_why'), instead: text.render(ah.cfg('command.msg_edit_instead'), { sub: SUB }), override: override });
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
      var open = tk.tasks(tp).filter(function (x) { return tk.isOpen(x) && tk.blockedOnText(x) === ''; });
      // positive proof of zero live workspaces: the app database is present and readable and lists none that is not archived
      var proven = tk.appDbPresent(ah.home()) && tk.appBuilders() !== null && !tk.anyLiveChildren();
      if (open.length > 0 && proven) note = ah.cfg('edit_guard.nudge_note');
    }
  }
  var prune = !gk.pruneMeetsLink(dir, ah.cfg('edit_guard.nudge_prune_prefix'));
  if (!prune) ah.unable('edit-guard:nudge_prune_link'); // a link in the state directory: nothing is pruned
  return { st: st, rel: rel, dir: dir, prune: prune, note: note };
}

function egMain(p) {
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
    if (stop === null) reason = egDelegation(tool, cwd, p);
    else standNote = sd.note(p, stop);
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
