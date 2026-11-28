// check = "devswarm-comms-guard" (PreToolUse on SendMessage). While DevSwarm is active, a `SendMessage` whose target is a live peer session
// working inside a DevSwarm workspace is blocked (the mesh is the channel between a Primary and its workspaces); every other target is
// allowed, and the coordinator address and a live non-workspace peer are labelled. The peer is found by reading the host's per-session
// index files, exactly as Node does; a target nothing resolves to is allowed without a word (a background agent's own address is the common
// case). The cases this script cannot decide with the same answer are decided natively and counted (native_unable): a home that is not
// absolute resolves against the stand-in directory, a settings chain that depends on a plugin root it does not know counts as unset (the
// guard stays on), a session index file the interpreter cannot parse exactly is skipped, and a session entry whose directory is relative
// resolves against the stand-in for the hook's working directory. Mirrors hooks/devswarm-comms-guard.js `main`. Keys and texts: spawn_guards.toml (devswarm_comms.*).
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
  if (r.status === 'undecidable') { ah.unable('devswarm-comms-guard:setting_undecidable'); return { value: undefined }; } // counts as unset: the default applies
  return { value: r.status === 'value' ? r.value : undefined };
}

// `isDevswarmActive`: a setting that needs a plugin root the caller does not have counts as unset (counted).
function dcActive(root) {
  if (ah.env.get(dcT('disable_env')) === dcT('disable_value')) return false;
  var m = dcGet('devswarm_comms.supervisor_setting', 'auto', root);
  var mode = typeof m.value === 'string' ? m.value.trim().toLowerCase() : '';
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  var repo = ah.env.get(dcT('repo_id_env'));
  return repo !== null && repo.trim() !== '';
}

// `findSessionByName`: the directory of the first session index file (in name order) whose `name` is exactly `name`: {cwd} or null.
// A file the engine cannot parse exactly is skipped (counted).
function dcFindSession(home, name) {
  var dir = ah.path.join(home, dcT('sessions_dir')), names = ah.fs.readdir(dir), suffix = dcT('session_file_suffix');
  if (names === null) return null;
  for (var i = 0; i < names.length; i++) {
    var f = names[i];
    if (f.length < suffix.length || f.slice(-suffix.length) !== suffix) continue;
    var raw = ah.fs.readText(dir + '/' + f);
    if (raw === null) continue;
    var r = jx.parse(raw);
    if (r.unsure) { ah.unable('devswarm-comms-guard:session_file_unsure'); continue; }
    if (r.invalid || !jx.isObj(r.v)) continue;
    if (r.v.name === name) return { cwd: typeof r.v.cwd === 'string' ? r.v.cwd : '' };
  }
  return null;
}

// `isDevswarmWorkspacePath`: a relative directory resolves against the stand-in directory (counted).
function dcWorkspacePath(home, cwd) {
  if (cwd === '') return false;
  if (!ah.path.isAbsolute(cwd)) { ah.unable('devswarm-comms-guard:relative_session_cwd'); cwd = hookProc.base() + '/' + cwd; }
  var root = ah.path.join(home, dcT('repos_root')), resolved = ah.path.resolveAbs(cwd);
  return resolved === root || resolved.indexOf(root + '/') === 0;
}

// A label is shown once per session (and agent) and target (#972 wave 2: the coordinator label repeated on every message to "main"). The targets
// already labelled live in a small per-session state file; a state the script cannot read or write counts as not labelled (the label
// shows), so a broken state file never hides a label for good. A block is never deduplicated.
function dcLabelState(session) {
  var rel = dcT('label_state_dir') + '/' + dcT('label_state_prefix') + '-' + String(session).replace(/[^A-Za-z0-9_.-]/g, '_') + ah.cfg('guardkit.state_ext');
  var seen = [], raw = null;
  try { raw = ah.state.readText(rel); } catch (e) { raw = null; }
  if (raw !== null && raw.trim() !== '') {
    var r = jx.parse(raw.trim());
    if (!r.unsure && !r.invalid && jx.isObj(r.v) && Array.isArray(r.v.targets)) seen = r.v.targets.filter(function (t) { return typeof t === 'string'; });
  }
  return { rel: rel, seen: seen };
}

function dcLabel(p, target, what) {
  // a teammate's hooks carry its lead's session id plus its own agent id: each agent of the session gets the label once
  var session = jx.isObj(p) && typeof p.session_id === 'string' ? p.session_id : '';
  if (session !== '' && typeof p.agent_id === 'string' && p.agent_id !== '') session += '-' + p.agent_id;
  if (session !== '') {
    var st = dcLabelState(session), key = target.toLowerCase();
    if (st.seen.indexOf(key) !== -1) return 'allow';
    var next = st.seen.concat([key]), max = ah.cfgNum('devswarm_comms.label_state_max');
    if (next.length > max) next = next.slice(next.length - max);
    var ok = false;
    try { ok = ah.state.writeAtomic(st.rel, JSON.stringify({ targets: next })); } catch (e) { ok = false; }
    if (ok) gk.pruneStale(dcT('label_state_dir'), dcT('label_state_prefix'));
  }
  return { advisory: text.advisoryJson('PreToolUse', text.message(dcT('label_kind'), dcT('label_name'), { what: what })) };
}

function decide(p, opts) {
  var home = hookProc.home(p);
  if (home === null) { ah.unable('devswarm-comms-guard:no_home', 'abandoned'); return 'allow'; } // no home at all: no session index to read
  if (!ah.path.isAbsolute(ah.env.get(ah.cfg('env.home')) || '')) ah.unable('devswarm-comms-guard:home_resolved');
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : (ah.env.get(ah.cfg('env.plugin_root')) || '');
  var en = ah.settings.get('devswarm_comms.setting', undefined, root);
  if (en.status === 'undecidable') { ah.unable('devswarm-comms-guard:enable_undecidable'); en = { status: 'unset' }; } // counts as unset: the guard stays on
  if (en.status === 'value' && (en.value === false || en.value === 'off')) return 'allow';
  if (ah.settings.skipped(dcT('guard_name'))) return 'allow';
  if (!jx.isObj(p)) return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (tool !== '' && tool !== dcT('tool')) return 'allow';
  var act = dcActive(root);
  if (!act) return 'allow';
  var to = jx.isObj(p.tool_input) && typeof p.tool_input.to === 'string' ? p.tool_input.to.trim() : '';
  if (to === '') return 'allow';
  if (to.toLowerCase() === dcT('coordinator_target')) return dcLabel(p, to, dcT('msg_main_what'));
  var name = dcStripRef(to), session = dcFindSession(home, name);
  if (session !== null) {
    var ws = dcWorkspacePath(home, session.cwd);
    if (ws) {
      var what = text.render(dcT('msg_block_what'), { to: to, cwd: session.cwd });
      var reason = text.message('block', dcT('guard_name'), { what: what, why: dcT('msg_block_why'), instead: dcT('msg_block_instead') });
      return { exact: { code: 2, out: text.blockJson(reason), err: '' } };
    }
  }
  if (new RegExp(dcT('agent_id_re'), 'i').test(to)) return 'allow';
  if (session === null) return 'allow';
  return dcLabel(p, name, text.render(dcT('msg_ok_what'), { to: to, cwd: session.cwd }));
}
