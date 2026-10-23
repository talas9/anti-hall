// check = "devswarm-child-role" (SessionStart; devswarm-parent-gate.js and devswarm-child-drain.js build on this script). Injects the
// DevSwarm mesh-only messaging directive for a child workspace. The stable launchers are installed (written where absent or different) first; where they are not current the
// script names the launcher targets (dwLaunchersNative, counted). A Primary in a checkout adopts, or on its first run in real DevSwarm
// registers, its seat in the mesh store and gets the seat notices (ah.mesh.adoptSeat). Mirrors `main` of
// hooks/devswarm-child-role.js and the module-level launcher install above it. Keys and texts: devswarm_role.toml (devswarm_role.*).
'use strict';

function dwRealHomeUnderTest(home) {
  var marked = ah.cfg('devswarm_role.test_markers').some(function (m) { var v = ah.env.get(m); return v !== null && v !== ''; });
  var escape = ah.env.get(ah.cfg('devswarm_role.real_home_escape'));
  if (!marked || (escape !== null && escape !== '')) return false;
  var real = ah.env.passwdHome(), strip = function (p) { return posix.normalize(p).replace(/\/+$/, ''); };
  return real === null || strip(real) === strip(home);
}

// The home directory of the settings reads and the file paths, when it is one this script can use exactly as Node does: HOME set,
// absolute, already normalized (Node joins paths lexically), and not the real home under a test marker (where the Node settings reader
// refuses). null otherwise.
function dwUsableHome() {
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null || home.charAt(0) !== '/' || posix.normalize(home) !== home) return null;
  return dwRealHomeUnderTest(home) ? null : home;
}

function dwJudgeChild() { return ah.env.get(ah.cfg('devswarm_role.judge_env')) === '1'; }
function dwNonBlank(name) { var v = ah.env.get(name); return v !== null && v.trim() !== ''; }

// `isDevswarmActive(env)`: the kill switch, then the supervisor mode (`on`, `off` or detect from the environment).
function dwActive() {
  if (ah.env.get(ah.cfg('devswarm_role.kill_env')) === '1') return false;
  var mode = ah.settings.enum('devswarm_role.sw_supervisor_mode');
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return dwNonBlank(ah.cfg('devswarm_role.repo_env'));
}

// The real path of the plugin root's parent of `hooks`, which is where a Node hook's `path.join(__dirname, '..')` points.
function dwNodeRoot(root) {
  var hooks = ah.fs.realpath(root + '/' + ah.cfg('devswarm_role.hooks_dir'));
  return hooks === null ? null : ah.path.resolveAbs(hooks + '/..');
}

// The command agents run for the DevSwarm CLI / the mailbox watcher: the engine shims (devswarm_role.engine_cli / engine_watcher).
function dwEngineCmd(key, home) { return text.render(ah.cfg(key), { home: home }); }

// The source of the CLI (watcher = false) or watcher shim: POSIX sh that execs the engine, no Node.
function dwShimSource(watcher, home) {
  return text.render(ah.cfg(watcher ? 'devswarm_role.shim_watcher' : 'devswarm_role.shim_cli'), { engine: dwEngineCmd('devswarm_role.engine_bin', home) });
}

// The shim file `key` (launcher_cli / launcher_watcher) names under the bin directory.
function dwShimPath(home, key) { return posix.normalize(home + '/' + ah.cfg('devswarm_role.bin_dir') + '/' + ah.cfg(key).name); }

// `installLaunchers`: the two stable shims are written where they are absent or differ (devswarm.stableLauncher on), executable, by the engine.
// A failed write is counted and leaves the command in use (fail-open: the shim path is stable, a later run retries).
function dwInstallLaunchers() {
  var home = dwUsableHome();
  if (home === null || !ah.settings.bool('devswarm_role.sw_stable_launcher')) return;
  var committed = false;
  [['devswarm_role.launcher_cli', false], ['devswarm_role.launcher_watcher', true]].forEach(function (k) {
    var rel = ah.cfg('devswarm_role.bin_dir') + '/' + ah.cfg(k[0]).name, src = dwShimSource(k[1], home);
    if (ah.fs.readText(posix.normalize(home + '/' + rel)) === src) return;
    if (!committed) { ah.commit(); committed = true; }
    if (!ah.state.op(home, 'write', rel, src) || !ah.markExecutable(rel)) ah.unable('devswarm-child-role:launcher_install');
  });
}

// {home, cli, watcher} when the shims are current (written with exactly the source above); null when they are not. The commands the
// texts name are always devswarm_role.engine_cli / engine_watcher.
function dwLaunchers(root, wantWatcher) {
  var home = dwUsableHome();
  if (home === null || !root) return null;
  var cur = function (watcher, key) { return ah.fs.readText(dwShimPath(home, key)) === dwShimSource(watcher, home); };
  if (ah.settings.bool('devswarm_role.sw_stable_launcher') && (!cur(false, 'devswarm_role.launcher_cli') || (wantWatcher && !cur(true, 'devswarm_role.launcher_watcher')))) return null;
  return { home: home, cli: dwEngineCmd('devswarm_role.engine_cli', home), watcher: dwEngineCmd('devswarm_role.engine_watcher', home) };
}

// `dwLaunchers`, or where the shims are not current (counted; the engine's update stage and the next SessionStart write them) the same commands.
// null only without a usable home or plugin root.
function dwLaunchersNative(root, wantWatcher) {
  var l = dwLaunchers(root, wantWatcher);
  if (l !== null) return l;
  var home = dwUsableHome();
  if (home === null || !root) return null;
  ah.unable('devswarm-launchers:not_current');
  return { home: home, cli: dwEngineCmd('devswarm_role.engine_cli', home), watcher: dwEngineCmd('devswarm_role.engine_watcher', home) };
}

// `dwLaunchers` for the read side of a hook that needs only that the launchers are current.
function dwLaunchersCurrent(root, wantWatcher) {
  var l = dwLaunchers(root, wantWatcher);
  return l === null || (wantWatcher && l.watcher === null) ? null : l;
}

// `wakeCron(env)` of hooks/lib/devswarm-wake.js: the configured schedule when it is exactly the right number of whitespace-separated
// fields made only of cron characters (re-joined with single spaces), else the default.
function dwWakeCron() {
  var dflt = ah.cfg('devswarm_role.sw_wake_cron').default, expr = ah.settings.str('devswarm_role.sw_wake_cron').trim();
  if (expr === '') return dflt;
  var fields = expr.split(/\s+/).filter(function (f) { return f !== ''; }), charset = ah.cfg('devswarm_role.cron_charset');
  if (fields.length !== ah.cfgNum('devswarm_role.cron_fields') || !fields.every(function (f) { return f.split('').every(function (c) { return charset.indexOf(c) >= 0; }); })) return dflt;
  return fields.join(' ');
}

// The Primary seat (primarySeatResult of hooks/devswarm-child-role.js): the seat adopted, or registered for the first time under real
// DevSwarm, and the notices it owes; {notices, id}. A seat the host cannot settle exactly is counted (mesh:seat) and says nothing.
function dwIso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function dwSeatNotices(v, adopted, cli, cur) {
  var out = [], r = function (k, a) { return text.render(ah.cfg(k), a); };
  if (!v || v.state === ah.cfg('devswarm_cli.seat_state_na') || v.unsure === true) return out;
  var unknownHolder = ah.cfg('devswarm_role.seat_holder_unknown');
  if (adopted && v.state === 'none') out.push(r('devswarm_role.seat_notice_registered', { id: v.id }));
  else if (adopted) {
    out.push(r('devswarm_role.seat_notice_adopted', { id: v.id, holder: v.holder || ah.cfg('devswarm_role.seat_holder_unclaimed'),
      handover: v.handover ? r('devswarm_role.seat_handover_found', { path: v.handover.path }) : ah.cfg('devswarm_role.seat_handover_none') }));
  } else if (v.state === 'conflict') out.push(r('devswarm_role.seat_notice_conflict', { holder: v.holder, id: v.id, cli: cli }));
  else if (v.state === 'unknown' && v.reason === 'corrupt-descriptor') {
    out.push(r('devswarm_role.seat_notice_corrupt', { id: v.id, path: v.descriptorPath || 'workspaces/' + v.id + '.json', cli: cli }));
  } else if (v.state === 'unknown') out.push(r('devswarm_role.seat_notice_unknown', { holder: v.holder || unknownHolder, cli: cli }));
  if (v.stale) {
    out.push(r('devswarm_role.seat_notice_stale', { current: cur || ah.cfg('devswarm_role.seat_current_session'), other: v.stale.sessionId, until: dwIso(v.stale.activeUntilMs),
      handover: v.handover ? r('devswarm_role.seat_stale_handover', { path: v.handover.path }) : '' }));
  }
  return out;
}

function dwPrimarySeat(p, cli, real) {
  var none = { notices: [], id: null };
  var sid = jx.isObj(p) && typeof p.session_id === 'string' ? p.session_id : '';
  if (sid === '') return none;
  var cwd = jx.isObj(p) && typeof p.cwd === 'string' && p.cwd !== '' ? p.cwd : hookProc.cwd(p); // Node's own working directory: the stand-in
  if (cwd.charAt(0) !== '/') { ah.unable('devswarm-child-role:relative_cwd'); cwd = hookProc.cwd(p); }
  ah.commit(); // the adoption writes the Primary's descriptor and registry row
  var res = ah.mesh.adoptSeat(cwd, sid, ah.clock.now(), real), v = res.verdict;
  if (res.unsure === true || !v || v.state === ah.cfg('devswarm_cli.seat_state_na')) return none;
  if (res.why) ah.unable('devswarm-child-role:seat_register_deferred');
  if (v.evidence && v.evidence.sessionsDir === false) ah.unable('devswarm-child-role:seat_app_terminals'); // the app's active terminals are not consulted: heartbeat age decides
  if (v.state === 'conflict') {
    var marker = ah.cfg('paths.base_dir') + '/' + ah.cfg('devswarm_prompt.seat_dir') + '/' + sid.replace(/[^A-Za-z0-9_-]/g, '') + '.json';
    ah.state.writeAtomic(marker, JSON.stringify({ holder: v.holder, id: v.id, shown: ah.cfgNum('devswarm_role.seat_marker_shown'), at: Date.now() })); // best effort
  }
  return { notices: dwSeatNotices(v, res.adopted === true, cli, sid), id: v.id || null };
}

function dwChildContext(cli, watcher, agent, id, cron, tickOnly) {
  return dwContext(true, cli, watcher, agent, id, cron, tickOnly);
}

// The directive of a child workspace (`child`) or of a Primary: the same wake text but for the drain command it names.
function dwContext(child, cli, watcher, agent, id, cron, tickOnly) {
  var out = text.render(ah.cfg(child ? 'devswarm_role.msg_base' : 'devswarm_role.msg_base_parent'), { cli: cli });
  if (agent === '') return out;
  if (agent === ah.cfg('devswarm_role.claude_agent')) {
    var expiry = ah.cfg(tickOnly ? 'devswarm_role.msg_expiry_tick' : 'devswarm_role.msg_expiry_inline');
    return out + text.render(ah.cfg(child ? 'devswarm_role.msg_wake_claude' : 'devswarm_role.msg_wake_claude_parent'), { cli: cli, watcher: watcher, id: id, cron: cron, expiry: expiry });
  }
  return out + text.render(ah.cfg(child ? 'devswarm_role.msg_wake_other' : 'devswarm_role.msg_wake_other_parent'), { cli: cli, id: id, agent: agent });
}

function decide(p, opts, event) {
  if (event !== 'SessionStart') return 'allow'; // this script answers SessionStart only
  if (dwJudgeChild()) return 'allow';
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
  dwInstallLaunchers(); // as the Node hook did when it was loaded, before anything else it does
  var l = dwLaunchersNative(root, true);
  if (l === null) { ah.unable('devswarm-child-role:no_home_or_root', 'abandoned'); return 'allow'; } // no usable home or plugin root: no launcher can be named
  if (!ah.settings.bool('devswarm_role.sw_child_role') || !dwActive()) return 'allow';
  var child = dwNonBlank(ah.cfg('devswarm_role.branch_env'));
  var seat = child ? { notices: [], id: null } : dwPrimarySeat(p, l.cli, dwNonBlank(ah.cfg('devswarm_role.repo_env')));
  var agentRaw = ah.env.get(ah.cfg('devswarm_role.agent_env')) || '';
  if (/[^\x00-\x7f]/.test(agentRaw)) ah.unable('devswarm-child-role:agent_non_ascii'); // only the ASCII letters are lower-cased: the agent name is matched as given
  var agent = agentRaw.trim().replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
  var rawId = ah.env.get(ah.cfg('devswarm_role.builder_env')), extra = ah.cfg('devswarm_role.id_extra_chars');
  var id = rawId !== null && rawId !== '' && rawId.split('').every(function (c) { return /[A-Za-z0-9]/.test(c) || extra.indexOf(c) >= 0; }) ? rawId : ah.cfg('devswarm_role.id_placeholder');
  // a Primary names its registered `primary-<hash>` id in the wake commands (the one the store and the watcher key on)
  if (seat.id !== null && /^[A-Za-z0-9._-]+$/.test(seat.id)) id = seat.id;
  var ctx = dwContext(child, l.cli, l.watcher, agent, id, dwWakeCron(), ah.settings.bool('devswarm_role.sw_rearm'));
  if (seat.notices.length) ctx = seat.notices.join(ah.cfg('devswarm_role.seat_notice_joiner')) + ah.cfg('devswarm_role.seat_notice_joiner') + ctx;
  return { exact: { code: 0, out: ah.cfg('devswarm_role.out_prefix') + JSON.stringify(ctx) + ah.cfg('devswarm_role.out_suffix') + '\n', err: '' } };
}
