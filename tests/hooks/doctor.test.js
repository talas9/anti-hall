'use strict';
// doctor — env-aware integration detection (OMC / Codex-OMX / DevSwarm).
//
// doctor.js is a script, not a library, so these tests spawn it as a real
// subprocess with a controlled HOME/cwd/env and read its stdout — the same
// black-box contract the plugin's own users rely on. Never touches the real
// machine's HOME.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DOCTOR_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'doctor.js');
const INSTALL_SUPERVISOR_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-supervisor.js');

function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-home-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

function runDoctor({ cwd, env }) {
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: Object.assign({}, process.env, {
      // Fully isolate from whatever machine/session this test itself runs
      // under (this repo's own dev loop is frequently DevSwarm/OMC-active).
      HOME: undefined, USERPROFILE: undefined, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
    }, env || {}),
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

test('doctor: OMC + DevSwarm absent -> exits 0, no crash, prints "not detected" INFOs, no false FAIL', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, 'doctor must exit 0 when optional integrations are absent:\n' + r.out);
    assert.match(r.out, /OMC \(oh-my-claudecode\) not detected — skipped/);
    assert.match(r.out, /Codex \/ OMX not detected — no <cwd>\/\.codex or ~\/\.codex config\.toml — skipped/);
    // A dormant DevSwarm (no descriptors, no supervisor installed) stays fully
    // silent — no head, no FAIL, matching the pre-existing conditional gate.
    assert.doesNotMatch(r.out, /DevSwarm liveness supervisor/);
    assert.doesNotMatch(r.out, /✗/, 'no FAIL lines for a plain machine with nothing installed');
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('doctor: OMC enabled in cwd settings -> reports detected, no active loop', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    const claudeDir = path.join(cwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'oh-my-claudecode@omc': true } }));
    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /OMC \(oh-my-claudecode\) — detected/);
    assert.match(r.out, /OMC plugin enabled in settings/);
    assert.match(r.out, /no active OMC autonomous loop detected/);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('doctor: Codex config.toml present in cwd -> reports detected, flags missing hooks.json', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    const codexDir = path.join(cwd, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[features]\nhooks = true\n');
    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Codex \/ OMX port — detected/);
    assert.match(r.out, /Codex config\.toml \(project\) has the hooks feature enabled/);
    assert.match(r.out, /Codex hooks\.json \(project\) missing — run plugins\/anti-hall\/codex\/install-codex\.js/);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('doctor: DevSwarm workspace descriptor with a caught-up inbox -> listener-presence PASS line appears', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
    const worktreePath = path.join(home, 'wt');
    fs.mkdirSync(worktreePath, { recursive: true });
    const inboxPath = path.join(worktreePath, 'inbox.ndjson');
    const cursorPath = path.join(worktreePath, 'cursor');
    fs.writeFileSync(inboxPath, JSON.stringify({ m: 1 }) + '\n');
    fs.writeFileSync(cursorPath, '1'); // cursor caught up with the single inbox line
    fs.writeFileSync(path.join(wsDir, 'doctor-fixture.json'), JSON.stringify({
      id: 'doctor-fixture', worktreePath, inboxPath, cursorPath, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }));
    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DevSwarm liveness supervisor/);
    assert.match(r.out, /workspace doctor-fixture listener: present \(inbox caught up, no backlog\)/);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('doctor: real supervisor companion artifact present -> reports INSTALLED', { skip: process.platform === 'win32' }, () => {
  // Regression guard for a bug where doctor read LABEL/UNIT off the WRONG
  // module (devswarm-supervisor.js, which exports neither) instead of
  // install-devswarm-supervisor.js (which does) — the installed-artifact
  // check always evaluated `${undefined}.plist` / `${undefined}.timer` and so
  // reported "not installed" even on a machine with the real LaunchAgent/timer
  // in place. LABEL/UNIT are read from the install module here, not
  // hardcoded, so this can't drift from what it actually exports.
  const { LABEL, UNIT } = require(INSTALL_SUPERVISOR_JS);
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    if (process.platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${LABEL}.plist`), '<plist></plist>');
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${UNIT}.timer`), '[Timer]\n');
    }
    // doctor checks the REAL os.homedir(), which Node resolves from
    // HOME/USERPROFILE — set both so the child process's os.homedir() reads
    // the fake home the artifact was just written under.
    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DevSwarm liveness supervisor/);
    assert.match(r.out, /supervisor companion INSTALLED/);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});
