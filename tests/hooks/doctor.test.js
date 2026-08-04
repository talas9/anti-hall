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

// timeout: generous on purpose. spawnSync's timeout kills the child (SIGTERM) and
// yields status=null on expiry — that is a legitimately-slow subprocess under
// contention, NOT a wrong exit code, and asserting strictEqual(r.code, 0) against a
// null gives a misleading "0 !== null" failure that looks like a real doctor bug
// (see fe0d901's fix to doctor-logs.test.js for the proven root cause: 3 concurrent
// `node --test` full-suite runs pushed this same subprocess past a 15000ms cap).
// 60000ms keeps a real hang/crash catchable while giving generous headroom for CI
// parallelism, without loosening the exit-code assertion itself — a genuine
// non-zero exit from a subprocess that actually ran is still caught.
function runDoctor({ cwd, env }) {
  // --check is doctor's PURE read-only path (v0.55.0): full detection, mutates
  // NOTHING. These env-detection assertions predate repair mode and assert the
  // read-only report/exit, so they run under --check. The auto-fix / gate /
  // dry-run behavior is covered separately in doctor-repair.test.js.
  const callerEnv = env || {};
  // Fully isolate from whatever machine/session this test itself runs under
  // (this repo's own dev loop is frequently DevSwarm/OMC-active). A bare
  // `HOME: undefined` here does NOT isolate anything — os.homedir() falls
  // back through the platform passwd db to the REAL user home when HOME is
  // unset, so a caller that forgets to pass its own HOME would silently
  // point doctor.js at the real ~/.anti-hall/devswarm/store. Every current
  // call site does pass its own isolated HOME, but this default must still
  // be a safe, disposable temp dir — never the real machine home — so a
  // future call site that omits HOME can't leak into the real store.
  const fallbackHome = ('HOME' in callerEnv) ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS, '--check'], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: Object.assign({}, process.env, {
      HOME: fallbackHome, USERPROFILE: fallbackHome, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
    }, callerEnv),
  });
  return {
    code: res.status,
    out: (res.stdout || '') + (res.stderr || '')
      + (res.signal ? `\n[runDoctor: process terminated by signal ${res.signal}]` : ''),
  };
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

// Upgrade-path regression: an EXISTING Codex install with only the OLDER event
// set (missing the newly-added PostToolUse reply-tracker hook) must be
// reported as unwired, not "already wired". A prior version of this
// detection matched a coarse "'/plugins/anti-hall/hooks/' appears ANYWHERE in
// hooks.json" test, which still matched on the surviving older events and
// silently hid the missing PostToolUse event from the user.
test('doctor: Codex hooks.json missing only a newly-added event (PostToolUse) -> reports unwired, not "already wired"', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    const installer = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'codex', 'install-codex.js');
    const install = cp.spawnSync(process.execPath, [installer], { cwd, encoding: 'utf8' });
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);
    const hooksPath = path.join(cwd, '.codex', 'hooks.json');
    const cfg = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(cfg.hooks.PostToolUse, 'fixture sanity: installer must register PostToolUse before we drop it');
    delete cfg.hooks.PostToolUse;
    fs.writeFileSync(hooksPath, JSON.stringify(cfg, null, 2) + '\n');

    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Codex \/ OMX port — detected/);
    assert.match(r.out, /Codex hooks\.json \(project\) present but no anti-hall hooks found — run plugins\/anti-hall\/codex\/install-codex\.js/, r.out);
    assert.doesNotMatch(r.out, /Codex hooks\.json \(project\) has anti-hall hooks registered/, r.out);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

// Regression guard: a fully-current install (every event, including
// PostToolUse) must still report wired -- doctor must not spuriously nag a
// fully-up-to-date install.
test('doctor: Codex hooks.json with the FULL current event set -> reports "has anti-hall hooks registered"', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    const installer = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'codex', 'install-codex.js');
    const install = cp.spawnSync(process.execPath, [installer], { cwd, encoding: 'utf8' });
    assert.strictEqual(install.status, 0, install.stderr || install.stdout);

    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Codex hooks\.json \(project\) has anti-hall hooks registered/, r.out);
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

test('doctor: DevSwarm-active session -> the four Phase-1 hook self-tests all PASS (no FAIL)', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    // Mode ON forces the section to surface even with no descriptors/installed
    // companion, so the always-run behavioral self-tests are printed and can be
    // asserted PASS. The self-tests build their OWN isolated fixture homes, so
    // this env only affects the section-visibility gate.
    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x' } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DevSwarm liveness supervisor/);
    assert.match(r.out, /✓ devswarm-child-turn writes a turn-authored heartbeat/);
    assert.match(r.out, /✓ devswarm-child-gate forces a child to self-report/);
    assert.match(r.out, /✓ devswarm-parent-inbox surfaces a workspace unread backlog/);
    assert.match(r.out, /✓ devswarm-parent-gate blocks the Primary turn while a child inbox is unread/);
    // None of the Phase-1 self-tests may report a FAIL.
    assert.doesNotMatch(r.out, /✗ devswarm-(child|parent)-(turn|gate|inbox)/);
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

test('doctor: Foreign skill/hook conflict scan runs UNCONDITIONALLY — dormant DevSwarm, no other plugins -> INFO "no conflicts", exit 0', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Foreign skill\/hook conflict scan/);
    assert.match(r.out, /no foreign hook\/skill conflicts detected/);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('doctor: Foreign skill/hook conflict scan surfaces a real foreign Stop-hook fixture as a WARN (never a FAIL — third-party config, not an anti-hall defect)', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'anti-hall@anti-hall': true, 'foo@mp': true },
    }));
    const installPath = path.join(home, '.claude', 'plugins', 'cache', 'mp', 'foo', '1.0.0');
    fs.mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(installPath, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/x/foo-stop.js"' }] }] },
    }));
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'foo@mp': [{ scope: 'user', installPath, version: '1.0.0', installedAt: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-01T00:00:00.000Z' }] },
    }));
    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Foreign skill\/hook conflict scan/);
    assert.match(r.out, /foreign Stop hook: plugin "foo" registers foo-stop\.js/);
    assert.doesNotMatch(r.out, /✗ foreign/, 'a foreign plugin\'s own config must never map to a doctor FAIL');
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('doctor: DevSwarm-active session with no installed daemons -> runtime checks 1-4 report INFO "not installed" (no false FAIL)', { skip: process.platform === 'win32' }, () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cwd-'));
  try {
    const r = runDoctor({ cwd, env: { HOME: home, USERPROFILE: home, ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DEVSWARM_REPO_ID: 'repo-x' } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DevSwarm liveness supervisor/);
    assert.match(r.out, /ingest daemon: not installed/);
    assert.match(r.out, /supervisor: not installed/);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});
