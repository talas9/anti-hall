'use strict';
// update-harness-register — P0 fix (proven live): Claude Code loads this
// plugin from ~/.claude/plugins/installed_plugins.json's
// plugins["anti-hall@anti-hall"][].installPath, a HARNESS-OWNED pointer this
// helper only ever reads. Pulling + mirroring a new version into the
// version-pinned cache does nothing to that pointer, so after a restart a
// session keeps loading the STALE version forever, unless the harness itself
// re-registers it via `claude plugin update anti-hall@anti-hall`.
//
// This suite covers the unit (`harnessRegisterPostUpdate`) and its wiring
// into `runUpdate` (gated on installed_plugins.json's OWN version, not the
// resolveInstalledVersion() fallback chain — which would mask exactly this
// staleness by falling through to the cache dir/marketplace version).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// runUpdate()'s post-pull stages resolve their home via os.homedir(): isolate
// it BEFORE anything runs (repo rule: tests never touch the real home; the
// runUpdate test-home guard refuses otherwise).
{
  const isolated = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'update-test-home-'));
  process.env.HOME = isolated; process.env.USERPROFILE = isolated;
}
const U = require('../../plugins/anti-hall/skills/update/scripts/update.js');

const REAL_PLUGIN_SRC_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

// --- unit: harnessRegisterPostUpdate ---------------------------------------

test('harnessRegisterPostUpdate: no-op when installed_plugins already at latest', () => {
  let called = false;
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.2.3', latest: '1.2.3',
    execFn: () => { called = true; return ''; },
  });
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(called, false, 'must never shell out when already current');
});

test('harnessRegisterPostUpdate: no-op when installed_plugins is ahead (never regress)', () => {
  let called = false;
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '2.0.0', latest: '1.2.3',
    execFn: () => { called = true; return ''; },
  });
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(called, false);
});

test('harnessRegisterPostUpdate: no-op when either version is unknown/non-semver', () => {
  let called = false;
  const out = U.harnessRegisterPostUpdate({
    installedVersion: null, latest: '1.2.3',
    execFn: () => { called = true; return ''; },
  });
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(called, false);
});

test('harnessRegisterPostUpdate: stale installed_plugins -> runs `claude plugin update anti-hall@anti-hall`', () => {
  const calls = [];
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.0.0', latest: '1.1.0',
    execFn: (args) => { calls.push(args); return 'updated\n'; },
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], ['plugin', 'update', 'anti-hall@anti-hall']);
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.ok, true);
  assert.match(out.detail, /RESTART Claude Code/,
    'field-verified: /reload-plugins does not pick up a harness registry update, only a real restart does');
  assert.doesNotMatch(out.detail, /\/reload-plugins is enough|or \/reload-plugins\)/,
    'must never imply /reload-plugins alone is sufficient after a harness registry update');
});

test('harnessRegisterPostUpdate: command failure is fail-open and reports the manual command (never throws)', () => {
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.0.0', latest: '1.1.0',
    execFn: () => { const e = new Error('boom'); e.stderr = 'unknown plugin\n'; throw e; },
  });
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.ok, false);
  assert.match(out.detail, /claude plugin update anti-hall@anti-hall/);
  assert.match(out.detail, /unknown plugin/);
});

test('harnessRegisterPostUpdate: an acceptance/confirmation prompt is NEVER auto-accepted', () => {
  const calls = [];
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.0.0', latest: '1.1.0',
    execFn: (args) => { calls.push(args); return 'requires --accept-command <sha256> to proceed\n'; },
  });
  assert.strictEqual(calls.length, 1, 'exactly one attempt — no automatic retry with --accept-command');
  assert.ok(!calls.some((a) => a.includes('--accept-command')), 'must never pass --accept-command automatically');
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.ok, false);
  assert.match(out.detail, /run manually: claude plugin update anti-hall@anti-hall/);
});

// --- integration: runUpdate wiring -----------------------------------------

function makeMarketplace(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-harnessreg-'));
  const marketplaceDir = path.join(root, 'marketplaces', 'anti-hall');
  const srcDir = path.join(marketplaceDir, 'plugins', 'anti-hall');
  fs.mkdirSync(path.join(srcDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'anti-hall', version }), 'utf8');
  for (const d of ['companion', 'hooks']) {
    fs.symlinkSync(path.join(REAL_PLUGIN_SRC_DIR, d), path.join(srcDir, d), 'dir');
  }
  fs.writeFileSync(path.join(marketplaceDir, 'CHANGELOG.md'), '# Changelog\n\n## ' + version + '\n- x\n', 'utf8');
  return { root, marketplaceDir, srcDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} } };
}

const execStub = () => (args) => (args[0] === 'pull' ? 'Already up to date.\n' : '');

test('runUpdate: stale installed_plugins.json (older than freshly-pulled latest) -> harnessRegistered attempted', () => {
  const t = makeMarketplace('1.1.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessreg-home-'));
  try {
    fs.writeFileSync(path.join(t.root, 'installed_plugins.json'),
      JSON.stringify({ 'anti-hall@anti-hall': '1.0.0' }), 'utf8');
    const paths = U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: t.marketplaceDir }, t.root);
    const calls = [];
    const out = U.runUpdate({
      paths,
      exec: execStub(),
      env: {},
      home,
      harnessExecFn: (args) => { calls.push(args); return 'updated\n'; },
    });
    assert.strictEqual(out.status.installed, '1.0.0');
    assert.strictEqual(out.status.latest, '1.1.0');
    assert.ok(out.status.harnessRegistered, 'harnessRegistered must be present on the status object');
    assert.strictEqual(out.status.harnessRegistered.attempted, true);
    assert.strictEqual(out.status.harnessRegistered.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], ['plugin', 'update', 'anti-hall@anti-hall']);
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runUpdate: installed_plugins.json already current -> harnessRegistered not attempted, never shells out', () => {
  const t = makeMarketplace('1.1.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessreg-home-'));
  try {
    fs.writeFileSync(path.join(t.root, 'installed_plugins.json'),
      JSON.stringify({ 'anti-hall@anti-hall': '1.1.0' }), 'utf8');
    const paths = U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: t.marketplaceDir }, t.root);
    const calls = [];
    const out = U.runUpdate({
      paths,
      exec: execStub(),
      env: {},
      home,
      harnessExecFn: (args) => { calls.push(args); return ''; },
    });
    assert.strictEqual(out.status.harnessRegistered.attempted, false);
    assert.strictEqual(calls.length, 0);
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runUpdate: never writes installed_plugins.json directly (harness-owned contract preserved)', () => {
  const t = makeMarketplace('1.1.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessreg-home-'));
  try {
    fs.writeFileSync(path.join(t.root, 'installed_plugins.json'),
      JSON.stringify({ 'anti-hall@anti-hall': '1.0.0' }), 'utf8');
    const before = fs.readFileSync(path.join(t.root, 'installed_plugins.json'), 'utf8');
    const paths = U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: t.marketplaceDir }, t.root);
    U.runUpdate({
      paths, exec: execStub(), env: {}, home,
      harnessExecFn: () => 'updated\n',
    });
    const after = fs.readFileSync(path.join(t.root, 'installed_plugins.json'), 'utf8');
    assert.strictEqual(after, before, 'installed_plugins.json must be byte-identical — only the harness CLI writes it');
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- v0.108.0 integration: harness registration x post-pull re-exec ----
function reexecFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-reg-reexec-'));
  const src = path.join(root, 'plugins', 'anti-hall');
  const f = path.join(src, 'skills', 'update', 'scripts', 'update.js');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '// placeholder; spawnReexec is injected\n');
  return { root, paths: { pluginSrcDir: src, marketplaceDir: root } };
}
function fakeChild(status) { return () => ({ status: 0, stdout: JSON.stringify({ status }) + '\n' }); }

test('re-exec: the parent already re-registered -> the child\'s "nothing to do" never hides it; RESTART action kept', () => {
  const fx = reexecFixture();
  try {
    const parentReg = { attempted: true, ok: true, detail: 'harness re-registered to 0.109.0 — RESTART' };
    const local = { installed: '0.108.0', latest: '0.109.0', updated: true, harnessRegistered: parentReg, action: 'RESTART Claude Code …' };
    const { status } = U.runPostPullReexec({
      paths: fx.paths, status: local, env: {}, cwd: fx.root,
      spawnReexec: fakeChild({ harnessRegistered: { attempted: false, ok: false, detail: 'nothing to do' }, newStage: { ran: true }, action: 'already up to date' }),
    });
    assert.deepStrictEqual(status.harnessRegistered, parentReg);
    assert.strictEqual(status.action, 'RESTART Claude Code …');
    assert.deepStrictEqual(status.newStage, { ran: true });
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('re-exec: an older parent without registration -> the NEW update.js registers and its RESTART action wins', () => {
  const fx = reexecFixture();
  try {
    const local = { installed: '0.107.1', latest: '0.108.0', updated: true, action: 'run /reload-plugins' };
    const childReg = { attempted: true, ok: true, detail: 'harness re-registered to 0.108.0 — RESTART' };
    const { status } = U.runPostPullReexec({
      paths: fx.paths, status: local, env: {}, cwd: fx.root,
      spawnReexec: fakeChild({ harnessRegistered: childReg, action: 'RESTART Claude Code (exit and resume the session) — the harness now registers 0.108.0; /reload-plugins is not enough' }),
    });
    assert.deepStrictEqual(status.harnessRegistered, childReg);
    assert.match(status.action, /^RESTART Claude Code/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('under node --test with no injected execFn the real claude CLI is never spawned', () => {
  const r = U.harnessRegisterPostUpdate({ installedVersion: '0.1.0', latest: '9.9.9' });
  assert.strictEqual(r.attempted, false);
  assert.match(r.detail, /node --test/);
});

// --- P2a: `claude` not on PATH -> CLAUDE_CODE_EXECPATH; failure -> manual command + restart
function enoent() { const e = new Error('spawn claude ENOENT'); e.code = 'ENOENT'; return e; }

test('P2a: `claude` not on PATH -> retries with CLAUDE_CODE_EXECPATH', () => {
  const calls = [];
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.0.0', latest: '1.1.0', env: { CLAUDE_CODE_EXECPATH: '/opt/claude/bin/claude-x' },
    execFileFn: (bin, args) => { calls.push([bin, args.join(' ')]); if (bin === 'claude') throw enoent(); return 'updated\n'; },
  });
  assert.deepStrictEqual(calls, [['claude', 'plugin update anti-hall@anti-hall'], ['/opt/claude/bin/claude-x', 'plugin update anti-hall@anti-hall']]);
  assert.strictEqual(out.ok, true);
});

test('P2a: no `claude` and no CLAUDE_CODE_EXECPATH -> failure whose action is the manual command + RESTART, never /reload-plugins', () => {
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.0.0', latest: '1.1.0', env: {},
    execFileFn: () => { throw enoent(); },
  });
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.ok, false);
  assert.match(out.detail, /claude plugin update anti-hall@anti-hall, then RESTART/);
  const action = U.harnessAction(out, true, '1.1.0');
  assert.match(action, /^run manually: claude plugin update anti-hall@anti-hall — then RESTART Claude Code/);
  assert.doesNotMatch(action, /^run \/reload-plugins/);
  // A needed-and-succeeded registration says RESTART; nothing attempted keeps the reload action.
  assert.match(U.harnessAction({ attempted: true, ok: true }, true, '1.1.0'), /^RESTART Claude Code/);
  assert.strictEqual(U.harnessAction({ attempted: false, ok: false }, true, '1.1.0'), 'run /reload-plugins');
});

test('P2a: a registration that FAILED in the re-exec child -> its manual-command action replaces the parent reload action', () => {
  const fx = reexecFixture();
  try {
    const local = { installed: '0.108.0', latest: '0.109.0', updated: true, action: 'run /reload-plugins' };
    const childReg = { attempted: true, ok: false, detail: 'harness update failed — run manually: claude plugin update anti-hall@anti-hall, then RESTART Claude Code (x)' };
    const { status } = U.runPostPullReexec({
      paths: fx.paths, status: local, env: {}, cwd: fx.root,
      spawnReexec: fakeChild({ harnessRegistered: childReg, action: U.harnessAction(childReg, true, '0.109.0') }),
    });
    assert.match(status.action, /^run manually: claude plugin update anti-hall@anti-hall/);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

// --- P2b: the re-exec child timeout covers the post-pull budget + registration
test('P2b: re-exec child timeout = post-pull budget + registration timeout + margin (and is what the spawn gets)', () => {
  const env = { ANTIHALL_UPDATE_POSTPULL_BUDGET_MS: '90000' };
  const t = U.reexecTimeoutMs(env);
  assert.ok(t >= 90000 + 20000 + 30000, 'timeout ' + t + ' must exceed the 90 s budget + 20 s registration with a margin');
  const fx = reexecFixture();
  try {
    let seen = null;
    U.runPostPullReexec({
      paths: fx.paths, status: { installed: '0.108.0', latest: '0.109.0', updated: true, action: 'run /reload-plugins' }, env, cwd: fx.root,
      spawnReexec: (_bin, _args, opts) => { seen = opts.timeout; return { status: 0, stdout: JSON.stringify({ status: {} }) + '\n' }; },
    });
    assert.strictEqual(seen, t);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});
