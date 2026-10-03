'use strict';
// Mesh redesign Phase 4 — doctor maintenance:
//   (1) checkLeakedDaemonUnits: read-only detection of anti-hall scheduler unit
//       files that point at a temp or missing path (#12);
//   (2) bare `doctor` is READ-ONLY (repairs need --repair / --fix).
// Every fixture lives under an isolated tmp HOME; the doctor subprocess gets
// HOME/USERPROFILE pinned to it and ANTIHALL_INGEST_DRY_RUN=1.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const DR = require(path.join(REPO, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js'));
const DOCTOR_JS = path.join(REPO, 'plugins', 'anti-hall', 'hooks', 'doctor.js');

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function plist(label, workingDir, script) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n'
    + '<key>Label</key><string>' + label + '</string>\n'
    + '<key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>' + script + '</string></array>\n'
    + (workingDir ? '<key>WorkingDirectory</key><string>' + workingDir + '</string>\n' : '')
    + '</dict></plist>\n';
}

test('checkLeakedDaemonUnits (darwin): flags tmp workdir, missing workdir and missing script; leaves a healthy unit alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-units-'));
  try {
    const la = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(la, { recursive: true });
    const realScript = __filename; // exists
    const tmpWd = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-units-wt-'));
    fs.writeFileSync(path.join(la, 'com.anti-hall.devswarm-ingest.leak-abc123.plist'), plist('com.anti-hall.devswarm-ingest.leak-abc123', tmpWd, realScript));
    fs.writeFileSync(path.join(la, 'com.anti-hall.devswarm-ingest.gone-def456.plist'), plist('com.anti-hall.devswarm-ingest.gone-def456', '/nonexistent/anti-hall/wt', '/nonexistent/anti-hall/devswarm-ingest.js'));
    fs.writeFileSync(path.join(la, 'com.anti-hall.devswarm-supervisor.plist'), plist('com.anti-hall.devswarm-supervisor', null, '/nonexistent/anti-hall/devswarm-supervisor.js'));
    fs.writeFileSync(path.join(la, 'com.other.vendor.plist'), plist('com.other.vendor', '/nonexistent', '/nonexistent'));
    // Healthy: an existing, non-temp WorkingDirectory and an existing script.
    fs.writeFileSync(path.join(la, 'com.anti-hall.mcp-reaper.plist'), plist('com.anti-hall.mcp-reaper', '/usr', process.execPath));
    const r = DR.checkLeakedDaemonUnits({ home, platform: 'darwin' });
    assert.ok(r, 'something is flagged');
    const by = Object.fromEntries(r.units.map((u) => [u.label, u.findings]));
    assert.deepStrictEqual(by['com.anti-hall.devswarm-ingest.leak-abc123'], ['tmp-workdir']);
    assert.deepStrictEqual(by['com.anti-hall.devswarm-ingest.gone-def456'], ['missing-workdir', 'missing-script']);
    assert.deepStrictEqual(by['com.anti-hall.devswarm-supervisor'], ['missing-script']);
    assert.strictEqual(by['com.other.vendor'], undefined, 'a non-anti-hall unit is never reported');
    for (const u of r.units) assert.match(u.retire, /launchctl bootout gui\/\$\(id -u\)\/.* then `mv .*\.quarantined`/);
    // Report-only: every file is still exactly where it was.
    assert.strictEqual(by['com.anti-hall.mcp-reaper'], undefined, 'a healthy unit is not reported');
    assert.strictEqual(fs.readdirSync(la).length, 5);
    rm(tmpWd);
  } finally { rm(home); }
});

test('checkLeakedDaemonUnits (linux): same classification over systemd .service files; null when all clean', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-units-l-'));
  try {
    const dir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    assert.strictEqual(DR.checkLeakedDaemonUnits({ home, platform: 'linux' }), null, 'no units -> silent');
    fs.writeFileSync(path.join(dir, 'anti-hall-devswarm-ingest-gone-abc123.service'),
      '[Service]\nWorkingDirectory=/nonexistent/anti-hall/wt\nExecStart="/usr/bin/node" "/nonexistent/anti-hall/devswarm-ingest.js"\n');
    const r = DR.checkLeakedDaemonUnits({ home, platform: 'linux' });
    assert.deepStrictEqual(r.units.map((u) => u.findings), [['missing-workdir', 'missing-script']]);
    assert.match(r.units[0].retire, /systemctl --user disable --now anti-hall-devswarm-ingest-gone-abc123\.service/);
    assert.strictEqual(DR.checkLeakedDaemonUnits({ home, platform: 'win32' }), null);
  } finally { rm(home); }
});

function runDoctor(home, args) {
  return cp.spawnSync(process.execPath, [DOCTOR_JS].concat(args || []), {
    encoding: 'utf8', cwd: home, timeout: 120000,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1', ANTIHALL_TEST_ISOLATION: '1' },
  });
}

test('bare doctor runs NO repair pass; --repair runs the registry and stamps its markers once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  try {
    const marker = path.join(home, '.anti-hall', 'update-sweep-state.json');
    const bare = runDoctor(home, []);
    assert.match(bare.stdout, /read-only run — nothing was changed/, bare.stdout.slice(-2000));
    assert.doesNotMatch(bare.stdout, /\[fold-all-stores\]/, 'no repair rows on a bare run');
    assert.strictEqual(fs.existsSync(marker), false, 'a bare doctor writes no migration marker');
    const fixed = runDoctor(home, ['--repair']);
    assert.doesNotMatch(fixed.stdout, /read-only run/);
    assert.match(fixed.stdout, /\[fold-all-stores\] nothing to migrate/, fixed.stdout.slice(-3000));
    const st = JSON.parse(fs.readFileSync(marker, 'utf8'));
    for (const k of ['foldAllStores', 'healOrphanPartitions', 'foldArchivedRows', 'foldArchivedFamilyDescriptors']) {
      assert.ok(st[k] && st[k].completedVersion, k + ' stamped after one clean live scan');
    }
    const again = runDoctor(home, ['--repair']);
    assert.match(again.stdout, /\[fold-all-stores\] already applied for .* \(marker\)/, 'the second run pays no scan');
  } finally { rm(home); }
});
