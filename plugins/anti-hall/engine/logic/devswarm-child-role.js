// check = "devswarm-child-role" (SessionStart; devswarm-parent-gate.js and devswarm-child-drain.js build on this script). Injects the
// DevSwarm mesh-only messaging directive for a child workspace. The Node hook installs the stable launchers when it is loaded, before it
// looks at its switch, the supervisor or the role, so this script may answer (silent or not) only when that install would change nothing:
// the switch is off, or both launchers already hold exactly what Node would write. Otherwise Node runs, installs them, and the next
// session is answered here. A Primary (it adopts or registers its seat through the DevSwarm CLI) defers. Mirrors `main` of
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

// The source `buildLauncherSource(segments, fallback)` generates for the script at `target` whose absolute path at generation time is `fallback`.
function dwLauncherSource(target, fallback) {
  return text.render(ah.cfg('devswarm_role.launcher_src'), { segments: JSON.stringify(target.split('/')), fallback: JSON.stringify(fallback) });
}

// The path of a launcher the Node hook would install, when it is already there with exactly the content Node would write; null otherwise.
function dwCurrentLauncher(home, root, key) {
  var l = ah.cfg(key), dest = posix.normalize(home + '/' + ah.cfg('devswarm_role.bin_dir') + '/' + l.name);
  var have = ah.fs.readText(dest);
  return have !== null && have === dwLauncherSource(l.target, posix.normalize(root + '/' + l.target)) ? dest : null;
}

// {home, cli, watcher} when the launchers Node would install are current (or its stable-launcher switch is off, when they are the
// plugin's own scripts); null when Node would have to install them or the answer is not exact.
function dwLaunchers(root, wantWatcher) {
  var home = dwUsableHome();
  if (home === null || !root) return null;
  var nr = dwNodeRoot(root);
  if (nr === null) return null;
  if (!ah.settings.bool('devswarm_role.sw_stable_launcher')) {
    return { home: home, cli: posix.normalize(nr + '/' + ah.cfg('devswarm_role.launcher_cli').target), watcher: posix.normalize(nr + '/' + ah.cfg('devswarm_role.launcher_watcher').target) };
  }
  var cli = dwCurrentLauncher(home, nr, 'devswarm_role.launcher_cli');
  if (cli === null) return null;
  var watcher = dwCurrentLauncher(home, nr, 'devswarm_role.launcher_watcher');
  if (watcher === null && wantWatcher) return null;
  return { home: home, cli: cli, watcher: watcher };
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

function dwChildContext(cli, watcher, agent, id, cron, tickOnly) {
  var out = text.render(ah.cfg('devswarm_role.msg_base'), { cli: cli });
  if (agent === '') return out;
  if (agent === ah.cfg('devswarm_role.claude_agent')) {
    var expiry = ah.cfg(tickOnly ? 'devswarm_role.msg_expiry_tick' : 'devswarm_role.msg_expiry_inline');
    return out + text.render(ah.cfg('devswarm_role.msg_wake_claude'), { cli: cli, watcher: watcher, id: id, cron: cron, expiry: expiry });
  }
  return out + text.render(ah.cfg('devswarm_role.msg_wake_other'), { cli: cli, id: id, agent: agent });
}

function decide(p, opts, event) {
  if (event !== 'SessionStart') return 'defer';
  if (dwJudgeChild()) return 'allow';
  var root = jx.isObj(opts) && typeof opts.plugin_root === 'string' ? opts.plugin_root : ah.env.get(ah.cfg('env.plugin_root'));
  var l = dwLaunchers(root, true);
  if (l === null) return 'defer';
  if (!ah.settings.bool('devswarm_role.sw_child_role') || !dwActive()) return 'allow';
  if (!dwNonBlank(ah.cfg('devswarm_role.branch_env'))) return 'defer'; // a Primary adopts or registers its seat through the DevSwarm CLI
  var agentRaw = ah.env.get(ah.cfg('devswarm_role.agent_env')) || '';
  if (/[^\x00-\x7f]/.test(agentRaw)) return 'defer'; // JavaScript and Rust lower-case some non-ASCII letters differently
  var agent = agentRaw.trim().replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
  var rawId = ah.env.get(ah.cfg('devswarm_role.builder_env')), extra = ah.cfg('devswarm_role.id_extra_chars');
  var id = rawId !== null && rawId !== '' && rawId.split('').every(function (c) { return /[A-Za-z0-9]/.test(c) || extra.indexOf(c) >= 0; }) ? rawId : ah.cfg('devswarm_role.id_placeholder');
  var ctx = dwChildContext(l.cli, l.watcher, agent, id, dwWakeCron(), ah.settings.bool('devswarm_role.sw_rearm'));
  return { exact: { code: 0, out: ah.cfg('devswarm_role.out_prefix') + JSON.stringify(ctx) + ah.cfg('devswarm_role.out_suffix') + '\n', err: '' } };
}
