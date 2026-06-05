'use strict';
// ===========================================================================
// install-reaper RUN-FLOW tests — exercise the main()/install paths via real
// subprocess invocation, WITHOUT mutating the real machine:
//   - --dry-run prints the intended plan and writes NOTHING / runs NO scheduler
//   - missing reaper script -> exit 1 with a clear error
//   - windows no-op path (skip-not-fail off-Windows; message text asserted via
//     the pure builder layer + a real run when actually on win32)
//   - OS-gated linux branches (cron fallback, timer/service text) are asserted
//     at the PURE BUILDER layer, since process.platform cannot be faked in-proc
//     and we must not run real systemctl. The boundary is documented inline.
//
// SAFETY: the only real subprocess runs use `--dry-run` (no fs writes, no
// launchctl/systemctl), or a copied install-reaper.js in a temp dir WITHOUT a
// sibling mcp-reaper.js (to hit the missing-script guard, which exits before any
// scheduler call). No real LaunchAgent/systemd unit/cron line is ever installed.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const COMPANION = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion');
const INSTALL = path.join(COMPANION, 'install-reaper.js');
const m = require(INSTALL);

// Run the real install-reaper.js as a subprocess. HOME is redirected to a temp
// dir as defense-in-depth (so even a non-dry path could not touch the real home).
function runInstall(args, { cwd, home } = {}) {
  const tmpHome = home || fs.mkdtempSync(path.join(os.tmpdir(), 'ahtest-home-'));
  const r = spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: cwd || os.tmpdir(),
    env: { ...process.env, HOME: tmpHome },
  });
  return { ...r, tmpHome };
}

// --------------------------------------------------------------------------
// --dry-run INSTALL plan: prints intended actions, writes nothing, exit 0.
// (darwin: LaunchAgent plan; otherwise: systemd timer/service plan.)
// --------------------------------------------------------------------------
test('install --dry-run prints a plan, writes nothing, runs no scheduler, exit 0', () => {
  const { status, stdout, tmpHome } = runInstall(['--dry-run']);
  assert.strictEqual(status, 0, 'dry-run must exit 0');
  // On win32 the installer short-circuits to the unsupported no-op BEFORE any
  // platform plan (it exits 0 without ever reading --dry-run). Assert that
  // correct behavior here; the LaunchAgent/systemd plan is a Unix-only path.
  if (process.platform === 'win32') {
    assert.match(stdout, /Windows is unsupported/i, 'win32 must print the unsupported message');
    assert.match(stdout, /No scheduler installed/i);
    assert.ok(!/\[dry-run\]/.test(stdout), 'win32 no-ops before any dry-run plan');
    return;
  }
  // Every action is a "[dry-run] would ..." line — proof nothing was executed.
  assert.match(stdout, /\[dry-run\] would (write|run|remove)/,
    'dry-run must announce intended actions');
  // No real "wrote " / "ran: " / "removed " side-effect lines.
  assert.ok(!/^wrote /m.test(stdout), 'dry-run must not actually write');
  assert.ok(!/^ran: /m.test(stdout), 'dry-run must not actually run a scheduler');
  // The temp HOME must be untouched by the dry-run (no LaunchAgents / systemd dirs).
  const wroteLaunchAgent = fs.existsSync(path.join(tmpHome, 'Library', 'LaunchAgents'));
  const wroteSystemd = fs.existsSync(path.join(tmpHome, '.config', 'systemd'));
  assert.ok(!wroteLaunchAgent && !wroteSystemd, 'dry-run must not create scheduler files');
  // Platform-appropriate plan content.
  if (process.platform === 'darwin') {
    assert.match(stdout, /LaunchAgents.*com\.anti-hall\.mcp-reaper\.plist/);
    assert.match(stdout, /would run: launchctl (unload|load)/);
  } else {
    assert.match(stdout, /\.service|\.timer/);
  }
});

// --------------------------------------------------------------------------
// --dry-run UNINSTALL plan: prints removal actions, removes nothing, exit 0.
// --------------------------------------------------------------------------
test('uninstall --dry-run prints a removal plan, removes nothing, exit 0', () => {
  const { status, stdout } = runInstall(['--dry-run', '--uninstall']);
  assert.strictEqual(status, 0, 'dry-run uninstall must exit 0');
  // win32 no-ops before the removal plan (see install dry-run test for rationale).
  if (process.platform === 'win32') {
    assert.match(stdout, /Windows is unsupported/i, 'win32 must print the unsupported message');
    assert.ok(!/\[dry-run\]/.test(stdout), 'win32 no-ops before any dry-run removal plan');
    return;
  }
  assert.match(stdout, /\[dry-run\] would (run|remove)/, 'must announce removal actions');
  assert.match(stdout, /uninstalled/i);
  assert.ok(!/^removed /m.test(stdout), 'dry-run must not actually remove');
  if (process.platform === 'darwin') {
    assert.match(stdout, /\[dry-run\] would remove .*com\.anti-hall\.mcp-reaper\.plist/);
  }
});

// --------------------------------------------------------------------------
// Missing reaper script -> exit 1. Copy ONLY install-reaper.js into a temp dir
// (no sibling mcp-reaper.js); its SCRIPT (path.join(__dirname,'mcp-reaper.js'))
// then points at a non-existent file, tripping the existsSync guard. This exits
// BEFORE any scheduler call, so it is safe to run for real (no --dry-run needed).
// --------------------------------------------------------------------------
test('missing reaper script -> exit 1 with a clear error (no scheduler touched)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtest-noscript-'));
  const lone = path.join(dir, 'install-reaper.js');
  fs.copyFileSync(INSTALL, lone);
  // sanity: the sibling reaper must NOT exist here
  assert.ok(!fs.existsSync(path.join(dir, 'mcp-reaper.js')));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ahtest-home-'));
  const r = spawnSync(process.execPath, [lone], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: tmpHome },
  });
  // On win32 the windows-noop short-circuits before the script check (exit 0);
  // gate that platform out — the missing-script guard is the Unix/darwin path.
  if (process.platform === 'win32') {
    assert.strictEqual(r.status, 0);
    return;
  }
  assert.strictEqual(r.status, 1, 'missing reaper script must exit 1');
  assert.match(r.stdout, /reaper script not found at .*mcp-reaper\.js/);
  // Nothing installed into the temp home.
  assert.ok(!fs.existsSync(path.join(tmpHome, 'Library', 'LaunchAgents')));
  assert.ok(!fs.existsSync(path.join(tmpHome, '.config', 'systemd')));
});

// --------------------------------------------------------------------------
// Windows no-op: real run only when actually on win32 (skip-not-fail elsewhere).
// process.platform cannot be faked in-process, and windowsNoop() is not exported,
// so off-Windows we assert nothing here and rely on the e2e Windows path + the
// builder layer below. ON win32, a real run must exit 0 and print the no-op msg.
// --------------------------------------------------------------------------
test('windows no-op: exit 0 + unsupported message',
  { skip: process.platform !== 'win32' }, () => {
    const { status, stdout } = runInstall([]);
    assert.strictEqual(status, 0, 'windows must no-op with exit 0');
    assert.match(stdout, /Windows is unsupported/i);
    assert.match(stdout, /No scheduler installed/i);
  });

// --------------------------------------------------------------------------
// OS-GATED BUILDER LAYER (boundary doc):
// The linux cron-fallback line, the systemd timer, and the service unit are
// emitted only when process.platform is linux AND (for cron) systemctl is
// absent. We cannot reach those run branches on this host without faking the
// platform or running real systemctl. We therefore assert the exact TEXT each
// branch would emit, at the exported pure-builder layer. The branch WIRING
// (linuxInstall picking cronLine when !hasSystemctl) is covered structurally by
// the dry-run plan, which prints both the systemctl command and the cron line.
// --------------------------------------------------------------------------

test('timerContents: 60s OnUnitActiveSec timer text, WantedBy=timers.target', () => {
  const t = m.timerContents();
  assert.match(t, /OnUnitActiveSec=60/);
  assert.match(t, /OnBootSec=60/);
  assert.match(t, /Persistent=true/);
  assert.match(t, /\[Install\]\nWantedBy=timers\.target/);
});

test('serviceContents: oneshot service text with execpath + script', () => {
  const s = m.serviceContents();
  assert.match(s, /Type=oneshot/);
  assert.match(s, /ExecStart="[^"]+" "[^"]*mcp-reaper\.js"/);
});

test('cronLine: every-minute crontab line, quoted paths, discards output', () => {
  const line = m.cronLine();
  assert.match(line, /^\* \* \* \* \* "/);
  assert.match(line, /mcp-reaper\.js" >\/dev\/null 2>&1$/);
});

test('linux dry-run plan surfaces BOTH the systemctl enable AND the cron fallback line', () => {
  // On darwin this asserts at the builder layer; on linux the dry-run prints them.
  if (process.platform === 'linux') {
    const { status, stdout } = runInstall(['--dry-run']);
    assert.strictEqual(status, 0);
    assert.match(stdout, /systemctl --user enable --now .*\.timer/);
    assert.match(stdout, /cron fallback line:/);
    assert.ok(stdout.includes(m.cronLine().trim().slice(0, 12)));
  } else {
    // boundary: linux branch unreachable here; assert the would-be cron text exists.
    assert.match(m.cronLine(), /\* \* \* \* \*/);
  }
});

test('exported constants: LABEL + UNIT are the agnostic anti-hall identifiers', () => {
  assert.strictEqual(m.LABEL, 'com.anti-hall.mcp-reaper');
  assert.strictEqual(m.UNIT, 'anti-hall-mcp-reaper');
});
