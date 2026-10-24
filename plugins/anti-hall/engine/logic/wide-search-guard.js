// check = "wide-search-guard" (PreToolUse on Bash, EVERY agent: subagents and the main thread; engine-only, no Node twin; GH #174).
// Blocks a whole-disk search: find, bfs, fd, rg, grep -r and the like rooted at /, ~, $HOME, /Users or /Volumes (named, or implied
// by a `cd` or the working directory when no path is given), and mdfind without -onlyin. Such a search wakes Spotlight and the
// network volumes and pushed the load to 170 once. A search rooted at a project directory stays allowed. Reads simple commands
// through the shared parser (compound commands, cd &&, env prefixes, pipes, sh -c). Every list, pattern and text is in
// lane_waste.toml (wide_search.*). A failure of this script allows (script.failure_mode_by_check): the guard never blocks by breaking.
'use strict';

// `p` made absolute against `cwd` with . and .. folded and no trailing slash ('/' stays), or null when it cannot be resolved
// (a relative path with no known cwd, or a word with a glob or a variable the guard cannot expand).
function wsResolve(p, cwd, home) {
  var aliases = ah.cfg('wide_search.home_aliases'), i, w = p;
  for (i = 0; i < aliases.length; i++) {
    if (w === aliases[i]) { w = home; break; }
    if (w.indexOf(aliases[i] + '/') === 0) { w = home + w.slice(aliases[i].length); break; }
  }
  if (w === '' || ah.re.test(ah.cfg('wide_search.unresolvable_re'), 'r', w)) return null;
  if (w.charAt(0) !== '/') { if (!cwd) return null; w = cwd + '/' + w; }
  var parts = w.split('/'), out = [];
  for (i = 0; i < parts.length; i++) {
    if (parts[i] === '' || parts[i] === '.') continue;
    if (parts[i] === '..') { out.pop(); continue; }
    out.push(parts[i]);
  }
  return '/' + out.join('/');
}

// The path words `words` (a search command line, words[0] the command) searches, as written; [] when none is named (the search
// then covers the working directory). `null` when the command is not a search to judge (grep without a recursive flag).
function wsPaths(words, spec) {
  var args = words.slice(1), i, out = [];
  if (spec.style === 'spotlight') {
    for (i = 0; i < args.length; i++) if (args[i] === spec.scope_flag && i + 1 < args.length) { out.push(args[i + 1]); i++; }
    return out.length > 0 ? out : [ah.cfg('wide_search.whole_disk')];
  }
  if (spec.style === 'paths-first') {
    var skip = spec.skip_flags || [];
    i = 0;
    while (i < args.length && skip.indexOf(args[i]) >= 0) i++;
    for (; i < args.length; i++) {
      if (args[i].charAt(0) === '-' && args[i].length > 1) break;
      if (ah.cfg('wide_search.expr_start').indexOf(args[i]) >= 0) break;
      out.push(args[i]);
    }
    return out;
  }
  // pattern-first: flags, then a pattern (unless a flag supplied it), then paths
  var values = spec.value_flags || [], patFlags = spec.pattern_flags || [], noPat = spec.no_pattern_flags || [];
  var havePattern = false, recursive = !spec.needs_recursive, afterDash = false;
  var recRe = spec.recursive_re;
  for (i = 0; i < args.length; i++) {
    var w = args[i];
    if (!afterDash && w === '--') { afterDash = true; continue; }
    if (!afterDash && w.charAt(0) === '-' && w.length > 1) {
      if (recRe && ah.re.test(recRe, 'r', w)) recursive = true;
      if (patFlags.indexOf(w) >= 0) { havePattern = true; i++; continue; }
      if (noPat.indexOf(w) >= 0) { havePattern = true; continue; }
      if (values.indexOf(w) >= 0) i++;
      continue;
    }
    if (!havePattern) { havePattern = true; continue; }
    out.push(w);
  }
  return recursive ? out : null;
}

function wsBlock(what, instead) {
  var reason = text.message('block', ah.cfg('wide_search.guard_name'), {
    what: what, why: ah.cfg('wide_search.msg_why'), instead: instead, override: ah.cfg('wide_search.msg_override'),
  });
  // exit 2 with the reason on stdout as a decision and on stderr: Claude reads the decision, Codex honors exit 2 only with the reason on stderr
  return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
}

function decide(p, opts) {
  if (ah.settings.bool('wide_search.sw_allow') || ah.settings.skipped(ah.cfg('wide_search.guard_name'))) return 'allow';
  var input = p && p.tool_input;
  var cmd = input && typeof input.command === 'string' ? input.command : '';
  if (cmd === '') return 'allow';
  var home = spawn.osHome();
  if (home === null) return 'allow';
  var sessionCwd = typeof p.cwd === 'string' && p.cwd.charAt(0) === '/' ? p.cwd : null;
  var cwd = sessionCwd, i;
  var forbidden = [], allowed = [];
  var fr = ah.cfg('wide_search.forbidden_roots'), ar = ah.cfg('wide_search.allow_paths');
  for (i = 0; i < fr.length; i++) { var f = wsResolve(fr[i], null, home); if (f !== null) forbidden.push(f); }
  for (i = 0; i < ar.length; i++) { var a = wsResolve(ar[i], null, home); if (a !== null) allowed.push(a); }
  var specs = ah.cfg('wide_search.commands'), cdCmds = ah.cfg('wide_search.cd_commands');
  var cmds = laneWaste.commands(cmd, 0);
  for (var c = 0; c < cmds.length; c++) {
    var words = cmds[c].words, base = shellScan.basename(words[0]);
    if (cdCmds.indexOf(base) >= 0) {
      var dest = null;
      for (i = 1; i < words.length; i++) if (words[i].charAt(0) !== '-' || words[i] === '-') { dest = words[i]; break; }
      cwd = wsResolve(dest === null ? '~' : dest, cwd, home);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(specs, base)) continue;
    var paths = wsPaths(words, specs[base]);
    if (paths === null) continue;
    if (paths.length === 0) paths = ['.'];
    for (i = 0; i < paths.length; i++) {
      var root = wsResolve(paths[i], cwd, home);
      if (root === null || forbidden.indexOf(root) < 0 || allowed.indexOf(root) >= 0) continue;
      var repo = sessionCwd !== null ? wsResolve(sessionCwd, null, home) : null;
      var instead = repo !== null && forbidden.indexOf(repo) < 0
        ? text.render(ah.cfg('wide_search.msg_instead'), { repo: repo })
        : ah.cfg('wide_search.msg_instead_no_repo');
      return wsBlock(text.render(ah.cfg('wide_search.msg_what'), { cmd: laneWaste.shown(words), root: root }), instead);
    }
  }
  return 'allow';
}
