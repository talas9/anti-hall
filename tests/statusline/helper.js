'use strict';
// helper.js — spawn an anti-hall statusline script as a child process with a
// CONTROLLED environment (fake HOME, optional fake cwd) and capture its stdout.
//
// Mirrors tests/helpers/spawn-hook.js: the test process itself runs inside
// Claude Code, so process.env carries markers and a real HOME we must NOT touch.
// The child env is a CONTROLLED base ({ PATH, HOME }) plus only what a test
// explicitly passes via opts.env. The fake HOME is where the statusline reads/
// writes ~/.anti-hall state and ~/.claude settings, so a test can never mutate
// the real machine.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Statusline scripts live in plugins/anti-hall/statusline, resolved absolutely.
const SL_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'statusline');

// isolatedEnv(home) — build the env that points a child at a fake HOME, cross
// platform. os.homedir() reads USERPROFILE/HOMEDRIVE+HOMEPATH on win32, $HOME
// elsewhere — set all of them so the child never escapes the fixture.
function isolatedEnv(home) {
  const env = { PATH: process.env.PATH, HOME: home };
  if (process.platform === 'win32') {
    const root = path.parse(home).root;
    env.USERPROFILE = home;
    env.HOMEDRIVE = root;
    env.HOMEPATH = home.slice(root.length);
  }
  return env;
}

// runSL(scriptName, { stdin, args, home, cwd, env }) -> { status, stdout, stderr }
//   - scriptName: bare filename under the statusline dir (e.g. 'phase.js').
//   - stdin: raw string piped to the child (default '').
//   - args:  argv array (default []).
//   - home:  fake HOME for the child (REQUIRED for state-touching scripts).
//   - cwd:   working dir for the child (default the home dir, never the repo).
//   - env:   extra env vars merged onto the controlled base.
function runSL(scriptName, opts = {}) {
  const scriptAbs = path.join(SL_DIR, scriptName);
  const home = opts.home || process.env.HOME;
  const env = { ...isolatedEnv(home), ...(opts.env || {}) };
  const res = spawnSync(process.execPath, [scriptAbs, ...(opts.args || [])], {
    input: opts.stdin || '',
    encoding: 'utf8',
    env,
    cwd: opts.cwd || home,
    timeout: 10000,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

// stripAnsi(s) — remove SGR/CSI color codes so assertions can target the visible
// text. The statusline emits raw ANSI by design (the harness re-renders it).
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

// makeStatusHome() — a fresh disposable HOME with ~/.anti-hall and ~/.claude.
// Returns helpers to write phase-state / spawn-log / settings and a cleanup.
function makeStatusHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-sl-'));
  const antiHall = path.join(home, '.anti-hall');
  const claude = path.join(home, '.claude');
  fs.mkdirSync(antiHall, { recursive: true });
  fs.mkdirSync(claude, { recursive: true });

  function writePhaseState(obj) {
    const p = path.join(antiHall, 'phase-state.json');
    fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    return p;
  }
  // Touch the phase-state file to a given age (seconds in the past) so the
  // STALE_MS branch in phase-bar.js can be exercised deterministically.
  function agePhaseState(secondsAgo) {
    const p = path.join(antiHall, 'phase-state.json');
    const t = Date.now() / 1000 - secondsAgo;
    fs.utimesSync(p, t, t);
  }
  function writeSpawnLog(timestampsMs) {
    const p = path.join(antiHall, 'agent-spawns.log');
    fs.writeFileSync(p, timestampsMs.join('\n') + '\n', 'utf8');
    return p;
  }
  function writeClaudeSettings(obj) {
    const p = path.join(claude, 'settings.json');
    fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
    return p;
  }
  function readJSON(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  function exists(p) {
    return fs.existsSync(p);
  }
  function cleanup() {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }

  return {
    home, antiHall, claude,
    writePhaseState, agePhaseState, writeSpawnLog, writeClaudeSettings,
    readJSON, exists, cleanup,
  };
}

// makeProjectDir() — a fresh disposable directory tree to act as a project cwd
// (for monorepo / dispatcher detection). Returns { dir, mkPlanningState, cleanup }.
function makeProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-proj-'));
  function mkPlanningState(content) {
    const pd = path.join(dir, '.planning');
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, 'STATE.md'), content, 'utf8');
  }
  function mkDir(rel) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
  }
  function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
  return { dir, mkPlanningState, mkDir, cleanup };
}

module.exports = {
  SL_DIR, runSL, stripAnsi, makeStatusHome, makeProjectDir, isolatedEnv,
};
