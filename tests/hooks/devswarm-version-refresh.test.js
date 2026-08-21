'use strict';
// devswarm-version-refresh.js (background, detached) — probes the installed
// DevSwarm CLI version and atomically writes ~/.anti-hall/devswarm-version.json.
// Pure unit tests via direct require (require.main !== module here, so main()
// never auto-runs) — spawnSync is fully injectable, so none of this depends on
// a real DevSwarm CLI being installed.

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');

const REFRESH_ABS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-version-refresh.js');
const refresh = require(REFRESH_ABS);
const { DEVSWARM_BASELINE } = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'devswarm-baseline.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-test-refresh-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// ── extractVersion (P2-D: robust, anchored, ambiguity-safe parsing) ───────

test('extractVersion: bare full semver', () => {
  assert.strictEqual(refresh.extractVersion('2.5.1'), '2.5.1');
});

test('extractVersion: full semver embedded in banner text', () => {
  assert.strictEqual(refresh.extractVersion('DevSwarm CLI v2.5.1 (build abc123)'), '2.5.1');
});

test('extractVersion: leading v stripped', () => {
  assert.strictEqual(refresh.extractVersion('v2.5.1'), '2.5.1');
});

test('extractVersion: P2-D regression — an earlier unrelated number-dot-number in the banner must NOT be picked over the real full semver', () => {
  // The exact failure mode described in the review: a banner containing a
  // build/date number ("12.3") ahead of the real version. The OLD unanchored
  // /\d+\.\d+/ regex would have taken "12.3" as the first match and cached it
  // — WRONG. The new logic prefers the full X.Y.Z token regardless of order.
  assert.strictEqual(refresh.extractVersion('Build 12.3\nVersion: 2.5.1'), '2.5.1');
  assert.strictEqual(refresh.extractVersion('Copyright 2026.1 DevSwarm Inc\n2.5.1'), '2.5.1');
});

test('extractVersion: two DIFFERENT full semvers => ambiguous => null (never guess)', () => {
  assert.strictEqual(refresh.extractVersion('v2.5.1 (compiled against 2.5.2)'), null);
});

test('extractVersion: repeated IDENTICAL full semver token is not ambiguous', () => {
  assert.strictEqual(refresh.extractVersion('2.5.1\n2.5.1'), '2.5.1');
});

test('extractVersion: no full semver, single bare X.Y token falls back to partial', () => {
  assert.strictEqual(refresh.extractVersion('DevSwarm 2.5'), '2.5');
});

test('extractVersion: two different partial X.Y tokens and no full token => ambiguous => null', () => {
  assert.strictEqual(refresh.extractVersion('build 12.3 devswarm 2.5'), null);
});

test('extractVersion: no version-shaped token at all => null', () => {
  assert.strictEqual(refresh.extractVersion('command not found'), null);
});

test('extractVersion: empty/non-string input => null, never throws', () => {
  assert.strictEqual(refresh.extractVersion(''), null);
  assert.strictEqual(refresh.extractVersion(null), null);
  assert.strictEqual(refresh.extractVersion(undefined), null);
});

// ── probeVersion (injected spawnFn — hermetic, no real binary needed) ─────

test('probeVersion: stdout hit => returns the parsed version', () => {
  const fakeSpawn = () => ({ stdout: '2.5.1\n', stderr: '' });
  assert.strictEqual(refresh.probeVersion('devswarm', fakeSpawn), '2.5.1');
});

test('probeVersion: stdout PREFERRED over stderr when both present', () => {
  const fakeSpawn = () => ({ stdout: '2.5.1\n', stderr: '9.9.9\n' });
  assert.strictEqual(refresh.probeVersion('devswarm', fakeSpawn), '2.5.1');
});

test('probeVersion: falls back to stderr only when stdout has nothing usable', () => {
  const fakeSpawn = () => ({ stdout: '', stderr: 'devswarm version 2.5.1\n' });
  assert.strictEqual(refresh.probeVersion('devswarm', fakeSpawn), '2.5.1');
});

test('probeVersion: spawnSync r.error (ENOENT: binary absent) => null, never throws', () => {
  const fakeSpawn = () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' });
  assert.strictEqual(refresh.probeVersion('devswarm', fakeSpawn), null);
});

test('probeVersion: throwing spawnFn => null, never throws', () => {
  assert.doesNotThrow(() => {
    assert.strictEqual(refresh.probeVersion('devswarm', () => { throw new Error('boom'); }), null);
  });
});

test('probeVersion: unparseable output => null', () => {
  const fakeSpawn = () => ({ stdout: 'no version info\n', stderr: '' });
  assert.strictEqual(refresh.probeVersion('devswarm', fakeSpawn), null);
});

// ── main() fallback chain + writes (T-5: devswarm -> hivecontrol fallback,
//    installed:null on total absence, atomic rename) ──────────────────────

test('main: devswarm succeeds => source:"devswarm", hivecontrol never probed', () => {
  const h = tmpHome();
  try {
    let hivecontrolCalled = false;
    const fakeSpawn = (bin) => {
      if (bin === 'hivecontrol') hivecontrolCalled = true;
      if (bin === 'devswarm') return { stdout: '2.5.1\n', stderr: '' };
      return { error: new Error('unexpected bin') };
    };
    const data = refresh.main({ home: h.home, spawnFn: fakeSpawn });
    assert.strictEqual(data.installed, '2.5.1');
    assert.strictEqual(data.source, 'devswarm');
    assert.strictEqual(hivecontrolCalled, false, 'devswarm succeeded — hivecontrol fallback must not even be attempted');
  } finally { h.cleanup(); }
});

test('main: devswarm absent, hivecontrol succeeds => fallback chain, source:"hivecontrol"', () => {
  const h = tmpHome();
  try {
    const fakeSpawn = (bin) => {
      if (bin === 'devswarm') return { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) };
      if (bin === 'hivecontrol') return { stdout: '2.5.1\n', stderr: '' };
      return { error: new Error('unexpected bin') };
    };
    const data = refresh.main({ home: h.home, spawnFn: fakeSpawn });
    assert.strictEqual(data.installed, '2.5.1');
    assert.strictEqual(data.source, 'hivecontrol');
  } finally { h.cleanup(); }
});

test('main: both devswarm and hivecontrol absent => installed:null, source:null (fail-open)', () => {
  const h = tmpHome();
  try {
    const fakeSpawn = () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
    const data = refresh.main({ home: h.home, spawnFn: fakeSpawn });
    assert.strictEqual(data.installed, null);
    assert.strictEqual(data.source, null);
    assert.strictEqual(data.baseline, DEVSWARM_BASELINE);
  } finally { h.cleanup(); }
});

test('main: writes the cache atomically — no leftover .tmp file, final JSON matches returned data', () => {
  const h = tmpHome();
  try {
    const fakeSpawn = () => ({ stdout: '2.6.0\n', stderr: '' });
    const data = refresh.main({ home: h.home, spawnFn: fakeSpawn });

    const cacheDir = path.join(h.home, '.anti-hall');
    const files = fs.readdirSync(cacheDir);
    assert.ok(files.includes('devswarm-version.json'), `expected cache file; found: ${files.join(',')}`);
    assert.ok(!files.some((f) => f.includes('.tmp.')), `no leftover tmp file; found: ${files.join(',')}`);

    const onDisk = JSON.parse(fs.readFileSync(path.join(cacheDir, 'devswarm-version.json'), 'utf8'));
    assert.deepStrictEqual(onDisk, data);
    assert.strictEqual(onDisk.installed, '2.6.0');
    assert.strictEqual(onDisk.baseline, DEVSWARM_BASELINE);
    assert.ok(Number.isFinite(onDisk.checkedAt));
  } finally { h.cleanup(); }
});

test('main: creates ~/.anti-hall when absent (mkdirSync recursive)', () => {
  const h = tmpHome();
  try {
    // tmpHome() does NOT pre-create .anti-hall — confirm main() does.
    assert.ok(!fs.existsSync(path.join(h.home, '.anti-hall')));
    refresh.main({ home: h.home, spawnFn: () => ({ error: new Error('ENOENT') }) });
    assert.ok(fs.existsSync(path.join(h.home, '.anti-hall', 'devswarm-version.json')));
  } finally { h.cleanup(); }
});

// ── BASELINE (P2-C) ────────────────────────────────────────────────────────

test('refresh script BASELINE is the shared authoritative constant', () => {
  assert.strictEqual(refresh.BASELINE, DEVSWARM_BASELINE);
});
