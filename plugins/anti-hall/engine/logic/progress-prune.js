// check = "progress-prune" (SessionStart). Two jobs, both fail-open. (1) The gitignore reminder: when the project has a .anti-hall/
// directory that git does not ignore, say so once a week per project. (2) The prune: a stale per-session progress file (from a day
// before today, untouched for the safety window) is appended to its history ledger and only then removed; the pass is throttled per
// working directory. Nothing is removed unless its content was appended first (D59: derived state, archived not lost).
// A request without HOME, a relative working directory, a checkout whose git directory the host cannot read exactly, a git that is
// too slow or an environment that carries git's own variables hand the hook back to Node before anything is written.
// Mirrors hooks/progress-prune.js and hooks/lib/gitignore-hint.js. Keys and texts: session.toml (session.*).
'use strict';

function ppCwdKey(cwd) {
  var hash = 0, s = String(cwd || '');
  for (var i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return ah.cfg('session.cwd_key_prefix') + Math.abs(hash).toString(36);
}

function ppState(rel) {
  var raw = ah.state.readText(rel);
  if (raw === null) return {};
  try { var o = JSON.parse(raw); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
}

function ppBlockquote(content) {
  var lines = String(content || '').split(/\r?\n/), q = ah.cfg('session.quote_prefix');
  return lines.map(function (line) { return q + line; }).join('\n') + '\n';
}

// null: defer; else the reminder text or ''.
function ppGitignoreHint(ctx, home, now) {
  if (!ah.settings.bool('session.setting_gitignore_hint')) return '';
  var root = ctx.toplevel;
  if (!root || !ah.fs.isDir(root + '/' + ah.cfg('session.anti_hall_dir'))) return '';
  var scrub = ah.cfg('session.git_scrub_env');
  for (var i = 0; i < scrub.length; i++) if (ah.env.get(scrub[i]) !== null) return null; // Node scrubs these; a script cannot
  var r = ah.exec(ah.cfg('session.git_binary'), ['-C', root].concat(ah.cfg('session.check_ignore_args')), { timeoutMs: ah.cfgNum('session.gitignore_probe_ms') });
  if (r === null) return null; // too slow (or not startable): Node's own probe has a longer limit
  if (r.status !== 1) return '';
  var rel = ah.cfg('session.state_dir') + '/' + ah.cfg('session.gitignore_state_file'), state = ppState(rel);
  var last = typeof state[root] === 'number' && isFinite(state[root]) ? state[root] : 0, age = now - last;
  if (age >= 0 && age < ah.cfgNum('session.gitignore_remind_ms')) return '';
  state[root] = now;
  try { if (!ah.state.writeAtomic(rel, JSON.stringify(state))) return ''; } catch (e) { return ''; } // Node throws before it prints
  return text.message('warn', ah.cfg('session.gitignore_guard'), {
    what: ah.cfg('session.gitignore_what'), why: ah.cfg('session.gitignore_why'), instead: ah.cfg('session.gitignore_instead'),
  });
}

function ppArchiveAndDelete(root, relProgress, relHistory, absProgress, prunedAt) {
  var content = ah.fs.readText(absProgress);
  if (content === null) return;
  var entry = text.render(ah.cfg('session.archive_entry'), { pruned_at: prunedAt, quote: ppBlockquote(content) });
  try {
    if (ah.state.op(root, 'append', relHistory, entry)) ah.state.op(root, 'remove', relProgress);
  } catch (e) { /* fail-safe: nothing is removed before the append succeeded */ }
}

// false when the progress directory cannot be listed (Node throws, so no throttle mark).
function ppPruneProject(root, now) {
  var dirName = ah.cfg('session.anti_hall_dir'), progress = root + '/' + dirName + '/' + ah.cfg('session.progress_dir');
  var all = ah.fs.readdir(progress);
  if (all === null) return false;
  var today = new Date(now).toISOString().slice(0, 10), skip = ah.cfg('session.progress_skip'), prunedAt = new Date(now).toISOString();
  var md = ah.cfg('session.md_ext');
  all.forEach(function (dateDir) {
    if (ah.fs.kind(progress + '/' + dateDir) !== 'dir' || dateDir === today || skip.indexOf(dateDir) >= 0) return;
    var dir = progress + '/' + dateDir, files = ah.fs.readdir(dir);
    if (files === null) return;
    files.forEach(function (name) {
      if (ah.fs.kind(dir + '/' + name) !== 'file' || !name.endsWith(md)) return;
      var mtime = ah.fs.mtimeMs(dir + '/' + name);
      if (mtime === null || now - mtime <= ah.cfgNum('session.prune_safety_ms')) return;
      var session = name.slice(0, name.length - md.length);
      ppArchiveAndDelete(root, dirName + '/' + ah.cfg('session.progress_dir') + '/' + dateDir + '/' + name,
        dirName + '/' + ah.cfg('session.history_dir') + '/' + dateDir + '/' + session + md, dir + '/' + name, prunedAt);
    });
  });
  return true;
}

function decide(p) {
  if (sess.judgeChild()) return 'allow';
  var cwd = p && typeof p.cwd === 'string' ? p.cwd : '';
  if (!cwd) return 'allow';
  var home = spawn.osHome();
  if (home === null || !ah.path.isAbsolute(cwd)) return 'defer';
  var ctx = ho.context(cwd);
  if (ctx.unsure) return 'defer';
  var now = ah.clock.now(), stateRel = ah.cfg('session.state_dir') + '/' + ah.cfg('session.progress_state_file');
  var state = ppState(stateRel);
  var progressDir = (function () { var top = ctx.toplevel, rh = ah.fs.realpath(home) || home; return top && top !== rh ? top : cwd; })();
  var listing = ah.fs.readdir(progressDir + '/' + ah.cfg('session.anti_hall_dir') + '/' + ah.cfg('session.progress_dir'));
  if (listing === null && ah.fs.isDir(progressDir + '/' + ah.cfg('session.anti_hall_dir') + '/' + ah.cfg('session.progress_dir'))) return 'defer'; // too many entries to list exactly
  var hint = ppGitignoreHint(ctx, home, now);
  if (hint === null) return 'defer';
  var out = function () { return hint === '' ? 'allow' : sess.advisory(hint); };
  if (!ah.settings.bool('session.setting_progress_prune')) return out();
  var key = ppCwdKey(cwd), ps = state[key] && typeof state[key] === 'object' ? state[key] : {};
  var lastPrunedAt = typeof ps.lastPrunedAt === 'number' && isFinite(ps.lastPrunedAt) ? ps.lastPrunedAt : 0, age = now - lastPrunedAt;
  if (age >= 0 && age < ah.cfgNum('session.prune_throttle_ms')) return out();
  if (ppPruneProject(progressDir, now)) {
    state[key] = { lastPrunedAt: now };
    try { ah.state.writeAtomic(stateRel, JSON.stringify(state)); } catch (e) { /* best effort */ }
  }
  return out();
}
