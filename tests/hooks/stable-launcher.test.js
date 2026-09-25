'use strict';
// hooks/lib/stable-launcher.js — the version-independent launcher for
// scripts/devswarm.js and companion/lib/devswarm-wake-watch.js. See that
// module's own header for the root problem (a cron/Monitor/handover keeps a
// version-pinned plugin-cache path around across an anti-hall update) and the
// fix (a tiny generated script under ~/.anti-hall/bin/ that re-resolves the
// currently REGISTERED install every time it runs).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'stable-launcher.js');
const stableLauncher = require(MODULE_PATH);

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-stable-launcher-'));
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// Lays out a disposable HOME's ~/.claude/plugins/{installed_plugins.json,
// marketplaces/anti-hall/plugins/anti-hall/...} exactly as update.js's
// resolvePaths()/versionFromInstalledJson() expect real installs to look.
function layoutInstalledJson(home, installPath, scope) {
  const dir = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'anti-hall@anti-hall': [{ scope: scope || 'user', installPath, version: '9.9.9' }] },
  }));
}

function layoutMarketplace(home) {
  const dir = path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall', 'plugins', 'anti-hall');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRealTarget(root, segments, contents) {
  const target = path.join(root, ...segments);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

test('buildLauncherSource embeds segments/fallback as JSON (no unescaped injection)', () => {
  const src = stableLauncher.buildLauncherSource(['scripts', 'devswarm.js'], '/some path/with spaces/devswarm.js');
  assert.match(src, /const SEGMENTS = \["scripts","devswarm\.js"\];/);
  assert.match(src, /const FALLBACK = "\/some path\/with spaces\/devswarm\.js";/);
  // Strip the leading shebang line — valid only as the first line of a real
  // Node SCRIPT file, not inside a `new Function` body — before the syntax check.
  const body = src.replace(/^#!.*\n/, '');
  assert.doesNotThrow(() => new Function(body)); // eslint-disable-line no-new-func
});

test('installLauncher resolves the REGISTERED install (installed_plugins.json wins over marketplace/fallback)', () => {
  const home = tmpHome();
  try {
    const registeredRoot = path.join(home, 'registered-install', 'plugins', 'anti-hall');
    const registeredTarget = writeRealTarget(registeredRoot, ['scripts', 'devswarm.js'], '// registered\nconsole.log("registered");\n');
    layoutInstalledJson(home, registeredRoot, 'user');

    const marketplaceRoot = layoutMarketplace(home);
    writeRealTarget(marketplaceRoot, ['scripts', 'devswarm.js'], '// marketplace\nconsole.log("marketplace");\n');

    const fallbackRoot = path.join(home, 'fallback-install', 'plugins', 'anti-hall');
    const fallbackTarget = writeRealTarget(fallbackRoot, ['scripts', 'devswarm.js'], '// fallback\nconsole.log("fallback");\n');

    const launcher = stableLauncher.installLauncher('devswarm', fallbackTarget, home);
    assert.ok(launcher, 'installLauncher must return a path on success');
    assert.strictEqual(launcher, stableLauncher.launcherPath('devswarm', home));

    const out = execFileSync(process.execPath, [launcher], { env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) }).toString();
    assert.match(out, /registered/, 'must resolve the installed_plugins.json entry, not marketplace or fallback');
  } finally {
    rm(home);
  }
});

test('installLauncher falls back to the marketplace clone when installed_plugins.json is absent', () => {
  const home = tmpHome();
  try {
    const marketplaceRoot = layoutMarketplace(home);
    writeRealTarget(marketplaceRoot, ['scripts', 'devswarm.js'], '// marketplace\nconsole.log("marketplace");\n');

    const fallbackRoot = path.join(home, 'fallback-install', 'plugins', 'anti-hall');
    const fallbackTarget = writeRealTarget(fallbackRoot, ['scripts', 'devswarm.js'], '// fallback\nconsole.log("fallback");\n');

    const launcher = stableLauncher.installLauncher('devswarm', fallbackTarget, home);
    const out = execFileSync(process.execPath, [launcher], { env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) }).toString();
    assert.match(out, /marketplace/, 'must fall back to the marketplace clone when installed_plugins.json is absent');
  } finally {
    rm(home);
  }
});

test('installLauncher falls back to the baked path when neither registered source exists (fail-open)', () => {
  const home = tmpHome();
  try {
    const fallbackRoot = path.join(home, 'fallback-install', 'plugins', 'anti-hall');
    const fallbackTarget = writeRealTarget(fallbackRoot, ['scripts', 'devswarm.js'], '// fallback\nconsole.log("fallback");\n');

    const launcher = stableLauncher.installLauncher('devswarm', fallbackTarget, home);
    const out = execFileSync(process.execPath, [launcher], { env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) }).toString();
    assert.match(out, /fallback/, 'must use the baked fallback when nothing else resolves');
  } finally {
    rm(home);
  }
});

test('launcher passes argv through and forwards the real script\'s exit code', () => {
  const home = tmpHome();
  try {
    const fallbackRoot = path.join(home, 'fallback-install', 'plugins', 'anti-hall');
    const fallbackTarget = writeRealTarget(fallbackRoot, ['scripts', 'devswarm.js'],
      '#!/usr/bin/env node\n' +
      'const args = process.argv.slice(2);\n' +
      'console.log("ARGS:" + JSON.stringify(args));\n' +
      'process.exit(args.includes("--fail") ? 7 : 0);\n');

    const launcher = stableLauncher.installLauncher('devswarm', fallbackTarget, home);
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });

    const out = execFileSync(process.execPath, [launcher, 'inbox', 'tick', 'primary-abc', '--child'], { env }).toString();
    assert.match(out, /ARGS:\["inbox","tick","primary-abc","--child"\]/);

    let threw = null;
    try {
      execFileSync(process.execPath, [launcher, '--fail'], { env });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'a non-zero real-script exit must propagate');
    assert.strictEqual(threw.status, 7);
  } finally {
    rm(home);
  }
});

test('installLauncher is idempotent — a second install does not rewrite unchanged content', () => {
  const home = tmpHome();
  try {
    const fallbackRoot = path.join(home, 'fallback-install', 'plugins', 'anti-hall');
    const fallbackTarget = writeRealTarget(fallbackRoot, ['scripts', 'devswarm.js'], '// fallback\n');

    const launcher = stableLauncher.installLauncher('devswarm', fallbackTarget, home);
    const firstMtime = fs.statSync(launcher).mtimeMs;

    // A second install with the SAME fallback must not touch the file.
    stableLauncher.installLauncher('devswarm', fallbackTarget, home);
    const secondMtime = fs.statSync(launcher).mtimeMs;
    assert.strictEqual(secondMtime, firstMtime, 'unchanged content must not be rewritten');

    // A DIFFERENT fallback (e.g. the next anti-hall version's own __dirname)
    // must actually refresh the generated source.
    const otherFallbackRoot = path.join(home, 'other-fallback-install', 'plugins', 'anti-hall');
    const otherFallbackTarget = writeRealTarget(otherFallbackRoot, ['scripts', 'devswarm.js'], '// other\n');
    stableLauncher.installLauncher('devswarm', otherFallbackTarget, home);
    const content = fs.readFileSync(launcher, 'utf8');
    assert.match(content, new RegExp(JSON.stringify(otherFallbackTarget).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rm(home);
  }
});

test('writeIfDifferent reports whether it actually wrote', () => {
  const home = tmpHome();
  try {
    const file = path.join(home, 'x', 'y.js');
    assert.strictEqual(stableLauncher.writeIfDifferent(file, 'a'), true, 'first write must report true');
    assert.strictEqual(stableLauncher.writeIfDifferent(file, 'a'), false, 'identical content must report false');
    assert.strictEqual(stableLauncher.writeIfDifferent(file, 'b'), true, 'changed content must report true');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'b');
  } finally {
    rm(home);
  }
});

test('installLaunchers returns the fallback directly when the destination directory cannot be created', () => {
  // Point HOME at a path that cannot be a directory (a FILE in its place) so
  // mkdirSync inside installLauncher throws — installLaunchers must still
  // return a usable value (the fallback), never null/throw.
  const home = tmpHome();
  try {
    const blocker = path.join(home, 'blocked-home');
    fs.writeFileSync(blocker, 'not a directory');
    const result = stableLauncher.installLaunchers({
      cliFallback: '/fallback/scripts/devswarm.js',
      watcherFallback: '/fallback/companion/lib/devswarm-wake-watch.js',
      home: blocker, // binDir(blocker) = <blocker>/.anti-hall/bin -> mkdirSync fails, blocker is a file
    });
    assert.strictEqual(result.cli, '/fallback/scripts/devswarm.js');
    assert.strictEqual(result.watcher, '/fallback/companion/lib/devswarm-wake-watch.js');
  } finally {
    rm(home);
  }
});

test('launcherPath/binDir are scoped to ~/.anti-hall/bin', () => {
  const home = '/tmp/some-home';
  assert.strictEqual(stableLauncher.binDir(home), path.join(home, '.anti-hall', 'bin'));
  assert.strictEqual(stableLauncher.launcherPath('devswarm', home), path.join(home, '.anti-hall', 'bin', 'devswarm.js'));
  assert.strictEqual(stableLauncher.launcherPath('wakeWatch', home), path.join(home, '.anti-hall', 'bin', 'wake-watch.js'));
  assert.strictEqual(stableLauncher.launcherPath('nope', home), null);
});
