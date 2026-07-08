'use strict';
// tests/hooks/capability-scan.test.js — unit tests for capability-scan.js
// (script lives under plugins/anti-hall/scripts/, but its test follows this
// repo's tests/hooks/ convention — see migrate-state.test.js / harvest-debt.test.js
// for the same pattern).
//
// No real launchctl/systemctl/crontab calls and no real HOME is ever touched —
// every fixture uses a temp dir passed explicitly via {home, cwd, root, platform}.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  scanCapabilities,
  discoverCompanions,
  companionActive,
  statuslineCapability,
  migrationsCapability,
} = require('../../plugins/anti-hall/scripts/capability-scan.js');

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'capscan-test-'));
  function write(relPath, contents) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
    return full;
  }
  function cleanup() {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  return { dir, write, cleanup };
}

// A minimal fake install-*.js module: just enough to exercise the real
// LABEL/UNIT/SCRIPT require() contract that companionActive() reads.
function fakeInstallerSource({ label, unit, script }) {
  return [
    "'use strict';",
    `const LABEL = ${JSON.stringify(label)};`,
    `const UNIT = ${JSON.stringify(unit)};`,
    script ? `const SCRIPT = ${JSON.stringify(script)};` : '',
    `module.exports = { LABEL, UNIT${script ? ', SCRIPT' : ''} };`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// discoverCompanions: dynamic derivation from companion/install-*.js on disk
// ---------------------------------------------------------------------------

test('discoverCompanions derives the companion list dynamically from install-*.js files', () => {
  const t = makeTmpDir('capscan-discover-');
  try {
    t.write('companion/install-real.js', fakeInstallerSource({ label: 'com.test.real', unit: 'test-real' }));
    t.write('companion/install-another.js', fakeInstallerSource({ label: 'com.test.another', unit: 'test-another' }));
    t.write('companion/not-an-installer.js', "module.exports = {};"); // must be ignored
    t.write('companion/README.md', '# not js'); // must be ignored

    const found = discoverCompanions(t.dir);
    assert.strictEqual(found.length, 2);
    const names = found.map((c) => c.name).sort();
    assert.deepStrictEqual(names, ['another', 'real']);
    assert.ok(found.every((c) => c.installScript.endsWith('.js')));
  } finally {
    t.cleanup();
  }
});

test('discoverCompanions picks up a brand-new install-foo.js automatically (future companion)', () => {
  const t = makeTmpDir('capscan-discover-future-');
  try {
    t.write('companion/install-foo.js', fakeInstallerSource({ label: 'com.test.foo', unit: 'test-foo' }));
    const found = discoverCompanions(t.dir);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].name, 'foo');
    assert.strictEqual(found[0].file, 'install-foo.js');
  } finally {
    t.cleanup();
  }
});

test('discoverCompanions returns [] when the companion dir does not exist (fail-open)', () => {
  const t = makeTmpDir('capscan-discover-missing-');
  try {
    assert.deepStrictEqual(discoverCompanions(path.join(t.dir, 'nope')), []);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// companionActive: reads the real scheduler artifact per platform
// ---------------------------------------------------------------------------

test('companionActive: darwin reports active=true when the LaunchAgent plist exists', () => {
  const t = makeTmpDir('capscan-active-darwin-');
  try {
    const installScript = t.write('companion/install-x.js', fakeInstallerSource({ label: 'com.test.x', unit: 'test-x' }));
    fs.mkdirSync(path.join(t.dir, 'home', 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(t.dir, 'home', 'Library', 'LaunchAgents', 'com.test.x.plist'), '<plist/>');

    const active = companionActive({ installScript, home: path.join(t.dir, 'home'), platform: 'darwin' });
    assert.strictEqual(active, true);
  } finally {
    t.cleanup();
  }
});

test('companionActive: darwin reports active=false when the plist is absent', () => {
  const t = makeTmpDir('capscan-inactive-darwin-');
  try {
    const installScript = t.write('companion/install-x.js', fakeInstallerSource({ label: 'com.test.x', unit: 'test-x' }));
    const active = companionActive({ installScript, home: path.join(t.dir, 'home-empty'), platform: 'darwin' });
    assert.strictEqual(active, false);
  } finally {
    t.cleanup();
  }
});

test('companionActive: linux reports active=true when the systemd --user timer file exists', () => {
  const t = makeTmpDir('capscan-active-linux-');
  try {
    const installScript = t.write('companion/install-x.js', fakeInstallerSource({ label: 'com.test.x', unit: 'test-x' }));
    const unitDir = path.join(t.dir, 'home', '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'test-x.timer'), '[Timer]');

    const active = companionActive({ installScript, home: path.join(t.dir, 'home'), platform: 'linux' });
    assert.strictEqual(active, true);
  } finally {
    t.cleanup();
  }
});

test('companionActive: linux reports active=false when neither timer file nor cron entry exists', () => {
  const t = makeTmpDir('capscan-inactive-linux-');
  try {
    const installScript = t.write('companion/install-x.js', fakeInstallerSource({ label: 'com.test.x', unit: 'test-x' }));
    const active = companionActive({ installScript, home: path.join(t.dir, 'home-empty'), platform: 'linux' });
    assert.strictEqual(active, false);
  } finally {
    t.cleanup();
  }
});

test('companionActive: win32 is detection-only -> "unknown" (no scheduler artifact to check)', () => {
  const t = makeTmpDir('capscan-win32-');
  try {
    const installScript = t.write('companion/install-x.js', fakeInstallerSource({ label: 'com.test.x', unit: 'test-x' }));
    const active = companionActive({ installScript, home: path.join(t.dir, 'home'), platform: 'win32' });
    assert.strictEqual(active, 'unknown');
  } finally {
    t.cleanup();
  }
});

test('companionActive: fail-open -> "unknown" when the installer fails to require() (bad syntax)', () => {
  const t = makeTmpDir('capscan-badreq-');
  try {
    const installScript = t.write('companion/install-broken.js', 'this is not valid javascript {{{');
    const active = companionActive({ installScript, home: path.join(t.dir, 'home'), platform: 'darwin' });
    assert.strictEqual(active, 'unknown');
  } finally {
    t.cleanup();
  }
});

test('companionActive: fail-open -> "unknown" when the installer exports no LABEL on darwin', () => {
  const t = makeTmpDir('capscan-nolabel-');
  try {
    const installScript = t.write('companion/install-nolabel.js', "module.exports = {};");
    const active = companionActive({ installScript, home: path.join(t.dir, 'home'), platform: 'darwin' });
    assert.strictEqual(active, 'unknown');
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// statuslineCapability
// ---------------------------------------------------------------------------

test('statuslineCapability: active=true when a scope statusLine points at statusline.js', () => {
  const t = makeTmpDir('capscan-sl-active-');
  try {
    t.write('.claude/settings.json', JSON.stringify({ statusLine: { command: 'node /somewhere/statusline.js' } }));
    const cap = statuslineCapability({ cwd: t.dir, home: path.join(t.dir, 'home-empty') });
    assert.strictEqual(cap.name, 'statusline');
    assert.strictEqual(cap.available, true);
    assert.strictEqual(cap.active, true);
  } finally {
    t.cleanup();
  }
});

test('statuslineCapability: active=false when no scope has a statusLine configured', () => {
  const t = makeTmpDir('capscan-sl-inactive-');
  try {
    const cap = statuslineCapability({ cwd: t.dir, home: path.join(t.dir, 'home-empty') });
    assert.strictEqual(cap.active, false);
  } finally {
    t.cleanup();
  }
});

test('statuslineCapability: active=false when the effective statusLine is a different (non-anti-hall) command', () => {
  const t = makeTmpDir('capscan-sl-other-');
  try {
    t.write('.claude/settings.local.json', JSON.stringify({ statusLine: { command: 'node /somewhere/else/foo.js' } }));
    const cap = statuslineCapability({ cwd: t.dir, home: path.join(t.dir, 'home-empty') });
    assert.strictEqual(cap.active, false);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// migrationsCapability — delegates to migrate-state.js's dryRun mode
// ---------------------------------------------------------------------------

test('migrationsCapability: active=false (pending) when a legacy file differs from its destination', () => {
  const t = makeTmpDir('capscan-migr-pending-');
  try {
    t.write('.anti-hall-progress.md', '# progress\n- did stuff\n');
    const cap = migrationsCapability({ dir: t.dir });
    assert.strictEqual(cap.name, 'state-migrations');
    assert.strictEqual(cap.active, false);
    // dryRun must not have written anything.
    assert.ok(!fs.existsSync(path.join(t.dir, '.anti-hall', 'history', 'legacy', '.anti-hall-progress.md')));
  } finally {
    t.cleanup();
  }
});

test('migrationsCapability: active=true when there is nothing pending (no legacy files)', () => {
  const t = makeTmpDir('capscan-migr-clean-');
  try {
    const cap = migrationsCapability({ dir: t.dir });
    assert.strictEqual(cap.active, true);
  } finally {
    t.cleanup();
  }
});

test('migrationsCapability: active=true when the legacy file is already migrated (idempotent)', () => {
  const t = makeTmpDir('capscan-migr-done-');
  try {
    const content = '# progress\n- did stuff\n';
    t.write('.anti-hall-progress.md', content);
    t.write('.anti-hall/history/legacy/.anti-hall-progress.md', content);
    const cap = migrationsCapability({ dir: t.dir });
    assert.strictEqual(cap.active, true);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// scanCapabilities: end-to-end shape + fail-open on a hostile root
// ---------------------------------------------------------------------------

test('scanCapabilities returns a flat array covering companions + statusline + migrations', () => {
  const t = makeTmpDir('capscan-e2e-');
  try {
    t.write('companion/install-thing.js', fakeInstallerSource({ label: 'com.test.thing', unit: 'test-thing' }));
    const report = scanCapabilities({ root: t.dir, home: path.join(t.dir, 'home-empty'), cwd: t.dir, platform: 'darwin' });
    assert.ok(Array.isArray(report.capabilities));
    const names = report.capabilities.map((c) => c.name);
    assert.ok(names.includes('thing'));
    assert.ok(names.includes('statusline'));
    assert.ok(names.includes('state-migrations'));
    for (const c of report.capabilities) {
      assert.ok('name' in c && 'available' in c && 'active' in c && 'how' in c);
    }
  } finally {
    t.cleanup();
  }
});

test('scanCapabilities never throws even when root does not exist (fail-open)', () => {
  const t = makeTmpDir('capscan-hostile-');
  try {
    assert.doesNotThrow(() => {
      const report = scanCapabilities({ root: path.join(t.dir, 'does-not-exist'), home: t.dir, cwd: t.dir });
      assert.ok(Array.isArray(report.capabilities));
    });
  } finally {
    t.cleanup();
  }
});
