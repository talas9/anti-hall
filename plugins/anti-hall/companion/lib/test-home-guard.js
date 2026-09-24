'use strict';
// anti-hall :: test-home-guard — under `node --test`, refuse to run a
// state-mutating entry point (update.js runUpdate, doctor-repair runRepairs,
// migrations runMigrations) against the REAL user home. Repo rule: tests never
// touch the real home. Several leaks came through exactly this gap (a test
// calling runUpdate()/runRepairs() without an isolated HOME, so a stage fell
// back to os.homedir() and repaired the developer's real ~/.anti-hall).
//
// realHomeUnderTest(home) -> true when NODE_TEST_CONTEXT is set and `home`
// resolves to the passwd home (os.userInfo().homedir — immune to a HOME
// override, so an isolated HOME reads as "not real"). Outside `node --test`
// it is always false: production behaviour is unchanged.
const os = require('os');
const path = require('path');

function realHomeUnderTest(home, env) {
  const e = env || process.env;
  if (!(process.env.NODE_TEST_CONTEXT || e.NODE_TEST_CONTEXT) || !home) return false;
  let real = null;
  try { real = os.userInfo().homedir; } catch (_) { real = null; }
  if (!real) return false;
  try { return path.resolve(String(home)) === path.resolve(real); } catch (_) { return false; }
}

function refusalMessage(label, home) {
  return label + ' refused under node --test: home ' + JSON.stringify(String(home))
    + ' is the REAL user home — isolate HOME (and USERPROFILE) or pass an explicit fixture home';
}

// ---------------------------------------------------------------------------
// Service-registration isolation (0.108.0 launchd leak). A test called
// runRepairs({ env: {} }) and doctor-repair's spawnInstaller handed that `{}`
// straight to spawnSync, which REPLACES the child environment: the installer
// child started with no HOME (os.homedir() fell back to the real passwd home)
// and no NODE_TEST_CONTEXT, so every test guard passed and it ran a real
// `launchctl load`, re-pointing the machine's supervisor at a scratch clone.
//
// TEST_MARKERS: NODE_TEST_CONTEXT is set by `node --test` in every worker;
// ANTIHALL_TEST_ISOLATION is set by tests/helpers for every child they build
// (it survives a test that strips NODE_TEST_CONTEXT to exercise a production
// path). Either one means "running under a test".
const fs = require('fs');
const TEST_MARKERS = ['NODE_TEST_CONTEXT', 'ANTIHALL_TEST_ISOLATION'];

function underTest(env) {
  for (const k of TEST_MARKERS) {
    if (process.env[k] || (env && env[k])) return true;
  }
  return false;
}

// installerChildEnv(env, overrides) -> the env for a spawned installer child.
// The parent's environment is the base (so HOME/USERPROFILE/PATH are never
// dropped), the caller's env is merged on top, overrides last; the test
// markers are always carried from the parent even when the caller's env
// cleared them.
function installerChildEnv(env, overrides) {
  const out = Object.assign({}, process.env, env || {}, overrides || {});
  for (const k of TEST_MARKERS) {
    if (!out[k] && process.env[k]) out[k] = process.env[k];
  }
  return out;
}

// SERVICE_CMDS: the commands that register/unregister/restart user services or
// rewrite the user's crontab. Every installer routes them through
// runServiceCmd, which under a test refuses them outright (the default stub):
// no test may reach the real launchd/systemd/cron, whatever its HOME.
const SERVICE_CMDS = new Set(['launchctl', 'systemctl', 'crontab']);
function refuseServiceCmd(cmd, env) {
  return SERVICE_CMDS.has(path.basename(String(cmd || ''))) && underTest(env);
}
function runServiceCmd(cmd, argv, opts) {
  if (refuseServiceCmd(cmd)) {
    return { status: 0, stdout: '', stderr: '', refused: true, dry: true };
  }
  return require('child_process').spawnSync(cmd, argv, Object.assign({ encoding: 'utf8' }, opts || {}));
}

// pathUnderTmp(p) -> true when p (realpath'd when it exists) sits under a temp
// root: os.tmpdir(), /tmp, /private/tmp, and on macOS /var/folders (a child
// spawned with a stripped env has no TMPDIR, so name the roots directly).
function pathUnderTmp(p) {
  try {
    const roots = [os.tmpdir(), '/tmp', '/private/tmp'].concat(process.platform === 'darwin' ? ['/var/folders', '/private/var/folders'] : []);
    const real = new Set();
    for (const r of roots) { real.add(r); try { real.add(fs.realpathSync(r)); } catch (_) {} }
    const raw = path.resolve(String(p));
    const cands = [raw];
    try { cands.push(fs.realpathSync(raw)); } catch (_) { /* may not exist yet */ }
    for (const h of cands) {
      for (const t of real) {
        const rel = path.relative(t, h);
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
      }
    }
    return false;
  } catch (_) { return false; }
}

// userConfigWriteRefused(target, env) -> true when a test would write user
// config (~/.claude, ~/.codex, a project .claude/.codex) outside a temp dir.
function userConfigWriteRefused(target, env) {
  return underTest(env) && !pathUnderTmp(target);
}

module.exports = {
  realHomeUnderTest, refusalMessage,
  TEST_MARKERS, underTest, installerChildEnv, SERVICE_CMDS, refuseServiceCmd, runServiceCmd, pathUnderTmp, userConfigWriteRefused,
};
