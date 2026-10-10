// check = "edit-guard" (PreToolUse on Edit, Write, MultiEdit, NotebookEdit; apply_patch for Codex). Blocks a write into the
// launcher directory (~/.anti-hall/bin) for every agent, literally or through a symlink already on disk, and answers quietly
// for every call that is not the main thread. A main-thread call defers to Node, which owns the coordinator allowlists and the
// symlink / hard-link honesty checks, and so does any payload whose paths cannot be resolved without the hook's own working
// directory or home. A Codex apply_patch is read through the shared patch parser (lib/77-apply-patch.js): every Add / Update /
// Delete path and Move-to destination is checked against the launcher directory (Codex honors exit 2 only with the reason on
// stderr, so the block carries it there too), a non-main-thread patch is allowed, and a main-thread patch defers. Mirrors hooks/edit-guard.js `main` and
// `resolvesIntoLauncherBinDir`. Keys and messages: small_guards.toml (edit_guard.*).
// Kept on purpose (issue #55): a main-thread write to a file outside any repo (for example a small file in the home directory) is
// still delegated. The main-thread verdict is Node's (this script defers), so an engine-only allow would be weaker than Node, and
// "outside any repo" also covers dotfiles and tool config (~/.claude, ~/.ssh, shell rc files). Revisit once the engine owns the
// main-thread verdict: allow only non-hidden paths under home, outside every git checkout, honesty-checked, behind a setting.
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// `value || ''`; null for an array or object (their string form is not reproduced: Node decides).
function orEmpty(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return '';
  if (typeof v === 'object') return null;
  return String(v);
}

function slashes(p) { return p.split('\\').join('/'); }
function inside(real, dir) { return real === dir || (real.indexOf(dir) === 0 && real.slice(dir.length).charAt(0) === '/'); }

// true / false, or null when the answer depends on the hook's own working directory or home directory.
function resolvesIntoLauncher(file, cwd, home) {
  if (file === '' || home === '') return false;
  if (!ah.path.isAbsolute(home)) return null;
  var abs;
  if (ah.path.isAbsolute(file)) abs = ah.path.resolveAbs(file);
  else if (ah.path.isAbsolute(cwd)) abs = ah.path.resolve(cwd, file);
  else return null;
  var binDir = ah.cfg('edit_guard.launcher_dir').reduce(function (acc, part) { return ah.path.resolve(acc, part); }, ah.path.resolveAbs(home));
  var normBin = slashes(binDir).replace(/\/+$/, '');
  if (inside(slashes(abs), normBin)) return true;
  // a symlink already on disk: the real target against the real launcher directory (a path that does not exist yet has no
  // real target, and the literal test above stands)
  var realAbs = ah.fs.realpath(abs);
  if (realAbs === null) return false;
  var realBin = ah.fs.realpath(binDir);
  return inside(slashes(realAbs), realBin === null ? normBin : slashes(realBin));
}

function decide(p) {
  if (!ah.settings.bool('edit_guard.setting') || ah.settings.skipped(ah.cfg('edit_guard.guard_name'))) return 'allow';
  var tool = isObj(p) ? p.tool_name : undefined;
  if (typeof tool !== 'string') return 'allow';
  var isPatch = tool === ah.cfg('edit_guard.patch_tool');
  if (!isPatch && ah.cfg('edit_guard.edit_tools').indexOf(tool) < 0) return 'allow';
  // Without a home directory the request environment was cut off or the hook has none: neither the launcher directory nor
  // the entry point can be trusted.
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null) return 'defer';
  var ti = isObj(p.tool_input) ? p.tool_input : null;
  var field = tool === ah.cfg('edit_guard.notebook_tool') ? 'notebook_path' : 'file_path';
  var cwd = orEmpty(p.cwd);
  var files;
  if (isPatch) {
    // Node resolves the targets against the payload cwd (the hook's own when there is none): only an absolute one is reproduced
    if (cwd === null || !ah.path.isAbsolute(cwd)) return 'defer';
    var cmd = ti === null ? undefined : ti.command;
    if (typeof cmd !== 'string') return 'defer';
    var parsed = applyPatch.parse(cmd);
    files = parsed.ok ? applyPatch.targetPaths(parsed.files, cwd) : [];
  } else {
    var one = orEmpty(ti === null ? undefined : ti[field]);
    if (one === null || cwd === null) return 'defer';
    files = [one];
  }
  var hit = false;
  for (var i = 0; i < files.length && !hit; i++) {
    var h = resolvesIntoLauncher(files[i], cwd, home);
    if (h === null) return 'defer';
    hit = h;
  }
  if (hit) {
    var reason = text.message('block', ah.cfg('edit_guard.guard_name'), {
      what: text.render(ah.cfg('edit_guard.msg_launcher_what'), { tool: tool }), why: ah.cfg('edit_guard.msg_launcher_why'),
      instead: ah.cfg('edit_guard.msg_launcher_instead'), allowed: ah.cfg('edit_guard.msg_launcher_allowed'),
    });
    // Claude reads the block from stdout alone; Codex honors exit 2 only with the reason on stderr (an apply_patch carries it there)
    return { exact: { code: 2, out: text.blockJson(reason), err: isPatch ? reason + '\n' : '' } };
  }
  return coordinator.isCoordinator(p) ? 'defer' : 'allow';
}
