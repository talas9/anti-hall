// check = "devswarm-comms-guard" (PreToolUse on SendMessage). While DevSwarm is active, a `SendMessage` whose target is a live peer session
// working inside a DevSwarm workspace is blocked (the mesh is the channel between a Primary and its workspaces); every other target is
// allowed, and the coordinator address and a live non-workspace peer are labelled. The peer is found by reading the host's per-session
// index files, exactly as Node does; a target nothing resolves to is allowed without a word (a background agent's own address is the common
// case). The cases this script cannot decide with the same answer defer to the Node guard: an unreadable home directory, a settings chain
// that depends on a plugin root it does not know, and a session index entry whose directory is relative (Node resolves it against the
// hook's own working directory). Mirrors hooks/devswarm-comms-guard.js `main`. Keys and texts: small_guards.toml (devswarm_comms.*).
'use strict';

function dcT(k) { return ah.cfg('devswarm_comms.' + k); }

// `stripRef`: `name [3fa9c1]` becomes `name`; a bare name stays, trimmed.
function dcStripRef(to) {
  var m = new RegExp(dcT('ref_re'), 'i').exec(to);
  return m ? (m[1] || '').trim() : to.trim();
}

// `settings.get(...)` of an entry under the plugin root: {value} or null when the answer depends on a plugin root the script does not have.
function dcGet(key, dflt, root) {
  var r = ah.settings.get(key, dflt, root);
  return r.status === 'undecidable' ? null : { value: r.status === 'value' ? r.value : undefined };
}

// `isDevswarmActive`: 'defer' when the answer needs a plugin root the caller does not have.
function dcActive(root) {
  if (ah.env.get(dcT('disable_env')) === dcT('disable_value')) return false;
  var m = dcGet('devswarm_comms.supervisor_setting', 'auto', root);
  if (m === null) return 'defer';
  var mode = typeof m.value === 'string' ? m.value.trim().toLowerCase() : '';
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  var repo = ah.env.get(dcT('repo_id_env'));
  return repo !== null && repo.trim() !== '';
}

// `findSessionByName`: the directory of the first session index file (in name order) whose `name` is exactly `name`: {cwd} or null; 'defer'
// when a file the engine cannot parse exactly comes before a match.
function dcFindSession(home, name) {
  var dir = ah.path.join(home, dcT('sessions_dir')), names = ah.fs.readdir(dir), suffix = dcT('session_file_suffix');
  if (names === null) return null;
  for (var i = 0; i < names.length; i++) {
    var f = names[i];
    if (f.length < suffix.length || f.slice(-suffix.length) !== suffix) continue;
    var raw = ah.fs.readText(dir + '/' + f);
    if (raw === null) continue;
    var r = jx.parse(raw);
    if (r.unsure) return 'defer';
    if (r.invalid || !jx.isObj(r.v)) continue;
    if (r.v.name === name) return { cwd: typeof r.v.cwd === 'string' ? r.v.cwd : '' };
  }
  return null;
}

// `isDevswarmWorkspacePath`: 'defer' for a relative directory.
function dcWorkspacePath(home, cwd) {
  if (cwd === '') return false;
  if (!ah.path.isAbsolute(cwd)) return 'defer';
  var root = ah.path.join(home, dcT('repos_root')), resolved = ah.path.resolveAbs(cwd);
  return resolved === root || resolved.indexOf(root + '/') === 0;
}

function dcLabel(kind, what) { return { advisory: text.advisoryJson('PreToolUse', text.message(kind, dcT('label_name'), { what: what })) }; }

function decide(p, opts) {
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null || !ah.path.isAbsolute(home)) return 'defer';
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : (ah.env.get(ah.cfg('env.plugin_root')) || '');
  var en = ah.settings.get('devswarm_comms.setting', undefined, root);
  if (en.status === 'undecidable') return 'defer';
  if (en.status === 'value' && (en.value === false || en.value === 'off')) return 'allow';
  if (ah.settings.skipped(dcT('guard_name'))) return 'allow';
  if (!jx.isObj(p)) return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (tool !== '' && tool !== dcT('tool')) return 'allow';
  var act = dcActive(root);
  if (act === 'defer') return 'defer';
  if (!act) return 'allow';
  var to = jx.isObj(p.tool_input) && typeof p.tool_input.to === 'string' ? p.tool_input.to.trim() : '';
  if (to === '') return 'allow';
  if (to.toLowerCase() === dcT('coordinator_target')) return dcLabel('tip', dcT('msg_main_what'));
  var name = dcStripRef(to), session = dcFindSession(home, name);
  if (session === 'defer') return 'defer';
  if (session !== null) {
    var ws = dcWorkspacePath(home, session.cwd);
    if (ws === 'defer') return 'defer';
    if (ws) {
      var what = text.render(dcT('msg_block_what'), { to: to, cwd: session.cwd });
      var reason = text.message('block', dcT('guard_name'), { what: what, why: dcT('msg_block_why'), instead: dcT('msg_block_instead') });
      return { exact: { code: 2, out: text.blockJson(reason), err: '' } };
    }
  }
  if (new RegExp(dcT('agent_id_re'), 'i').test(to)) return 'allow';
  if (session === null) return 'allow';
  return dcLabel('ok', text.render(dcT('msg_ok_what'), { to: to, cwd: session.cwd }));
}
