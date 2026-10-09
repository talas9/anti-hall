// check = "gh-rt-advisory" (UserPromptSubmit, ENGINE-ONLY). Tells a session about GitHub edges in the repo it works in: CI went red
// or green, the pull request was merged, changes were requested. The poller (`ah-engine gh_poll`, github_rt.toml) records the
// edges in <state dir>/ghrt/edges.json and marks the kinds github_rt.advisory_kinds names with advisory:true; this script only
// delivers them, once per session (a cursor file per session), inside github_rt.advisory_max_age_ms, at most
// github_rt.advisory_max_per_prompt per prompt, for the repo that holds the session's cwd. No repo, no edge, no cursor write
// that works, or an unreadable file: it says nothing.
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function readJson(path, max) {
  var t = ah.fs.readText(path, max);
  if (t === null) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}

function inside(root, cwd) {
  return typeof root === 'string' && root !== '' && (cwd === root || cwd.indexOf(root.replace(/\/+$/, '') + '/') === 0);
}

function decide(p) {
  if (!isObj(p) || typeof p.session_id !== 'string' || p.session_id === '' || typeof p.cwd !== 'string' || p.cwd === '') return 'allow';
  var home = spawn.osHome();
  if (home === null) return 'allow';
  var files = ah.cfg('github_rt.files');
  var rel = ah.cfg('paths.base_dir') + '/' + ah.cfg('paths.state_dir') + '/' + files.dir;
  var doc = readJson(ah.path.join(home, rel + '/' + files.edges), ah.cfgNum('github_rt.edges_read_bytes'));
  if (!isObj(doc) || !Array.isArray(doc.edges)) return 'allow';
  var mine = doc.edges.filter(function (e) { return isObj(e) && typeof e.seq === 'number' && inside(e.root, p.cwd); });
  if (mine.length === 0) return 'allow';
  var curRel = rel + '/' + files.cursor_dir + '/' + p.session_id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.json';
  var cur = readJson(ah.path.join(home, curRel), 4096);
  var seen = isObj(cur) && typeof cur.seq === 'number' ? cur.seq : 0;
  var top = mine.reduce(function (m, e) { return Math.max(m, e.seq); }, seen);
  if (top === seen) return 'allow';
  var now = Date.now(), maxAge = ah.cfgNum('github_rt.advisory_max_age_ms');
  var fresh = mine.filter(function (e) { return e.seq > seen && e.advisory === true && typeof e.text === 'string' && typeof e.ts === 'number' && now - e.ts <= maxAge; });
  // the cursor moves first: when it cannot be written the session is told nothing, rather than the same thing at every prompt
  if (ah.state.writeAtomic(curRel, JSON.stringify({ seq: top })) !== true) return 'allow';
  if (fresh.length === 0) return 'allow';
  fresh = fresh.slice(-ah.cfgNum('github_rt.advisory_max_per_prompt'));
  var lines = fresh.map(function (e) { return text.clean(e.text); });
  return { advisory: text.advisoryJson('UserPromptSubmit', ah.cfg('github_rt.words').advisory_head + '\n' + lines.join('\n')) };
}
