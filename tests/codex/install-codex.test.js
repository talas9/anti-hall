'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const INSTALLER = path.join(REPO, 'plugins', 'anti-hall', 'codex', 'install-codex.js');

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-codex-install-'));
  return {
    root,
    cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} },
  };
}

function run(cwd, args = []) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('install-codex: dry-run does not write project files', () => {
  const t = tmpProject();
  try {
    const r = run(t.root, ['--dry-run']);
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /would update/);
    assert.ok(!fs.existsSync(path.join(t.root, '.codex', 'hooks.json')));
    assert.ok(!fs.existsSync(path.join(t.root, '.codex', 'config.toml')));
  } finally { t.cleanup(); }
});

test('install-codex: writes the generated thin trigger (one wrapper call per event) and enables hooks feature', () => {
  const t = tmpProject();
  try {
    const r = run(t.root);
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);

    const hooksPath = path.join(t.root, '.codex', 'hooks.json');
    const configPath = path.join(t.root, '.codex', 'config.toml');
    const hooks = readJSON(hooksPath).hooks;
    const thin = readJSON(path.join(REPO, 'plugins', 'anti-hall', 'codex', 'hooks', 'hooks.json')).hooks;
    // Same events, one group each, same timeouts as the generated file; only ${PLUGIN_ROOT} is resolved.
    assert.deepStrictEqual(Object.keys(hooks).sort(), Object.keys(thin).sort());
    const root = path.join(REPO, 'plugins', 'anti-hall');
    for (const ev of Object.keys(thin)) {
      assert.strictEqual(hooks[ev].length, 1, ev);
      assert.strictEqual(hooks[ev][0].matcher, undefined, ev);
      const want = JSON.stringify(thin[ev]).split('${PLUGIN_ROOT}').join(root);
      assert.strictEqual(JSON.stringify(hooks[ev]), want, ev);
      assert.match(hooks[ev][0].hooks[0].command, new RegExp('ah-hook\\.sh" ' + ev + ' --host codex$'));
    }
    assert.doesNotMatch(JSON.stringify(hooks), /\$\{PLUGIN_ROOT\}|\.js/, 'no per-hook node registration is written');

    assert.match(fs.readFileSync(configPath, 'utf8'), /\[features\]\s+hooks = true/s);
  } finally { t.cleanup(); }
});

test('install-codex: preserves non anti-hall hooks and replaces stale anti-hall groups', () => {
  const t = tmpProject();
  try {
    const codexDir = path.join(t.root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep-me', timeout: 1 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/plugins/anti-hall/hooks/old.js', timeout: 1 }] },
        ],
      },
    }, null, 2));

    const r = run(t.root);
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    const pre = readJSON(path.join(codexDir, 'hooks.json')).hooks.PreToolUse;
    const commands = pre.flatMap(g => g.hooks || []).map(h => h.command);
    assert.ok(commands.includes('echo keep-me'));
    assert.ok(!commands.some(c => c.includes('/old.js')));
    assert.ok(commands.some(c => /ah-hook\.sh" PreToolUse --host codex$/.test(c)));
  } finally { t.cleanup(); }
});

test('install-codex: dedups stale anti-hall groups that used backslash (Windows) paths', () => {
  const t = tmpProject();
  try {
    const codexDir = path.join(t.root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep-me', timeout: 1 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "C:\\Users\\dev\\.claude\\plugins\\anti-hall\\hooks\\git-guard.js"', timeout: 10 }] },
        ],
      },
    }, null, 2));

    // Simulate a re-install (e.g. running the installer twice on Windows): the
    // existing backslash-path group above must be recognized as a stale
    // anti-hall group and replaced, not kept alongside the freshly-added one.
    const r = run(t.root);
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    const pre = readJSON(path.join(codexDir, 'hooks.json')).hooks.PreToolUse;
    const commands = pre.flatMap(g => g.hooks || []).map(h => h.command);
    assert.ok(commands.includes('echo keep-me'));
    assert.ok(!commands.some(c => /git-guard\.js/.test(c)), 'the stale per-hook group is gone');
    const wrapperCount = commands.filter(c => /ah-hook\.sh" PreToolUse/.test(c)).length;
    assert.strictEqual(wrapperCount, 1, `expected exactly one PreToolUse trigger after dedup, got ${wrapperCount}: ${JSON.stringify(commands)}`);
  } finally { t.cleanup(); }
});

test('install-codex: a second run is byte-identical (idempotent) and a thin install is not duplicated', () => {
  const t = tmpProject();
  try {
    assert.strictEqual(run(t.root).status, 0);
    const first = fs.readFileSync(path.join(t.root, '.codex', 'hooks.json'), 'utf8');
    assert.strictEqual(run(t.root).status, 0);
    assert.strictEqual(fs.readFileSync(path.join(t.root, '.codex', 'hooks.json'), 'utf8'), first);
  } finally { t.cleanup(); }
});

test('install-codex: migrates a full old per-hook registry install to the thin trigger, keeping user hooks', () => {
  const t = tmpProject();
  try {
    const codexDir = path.join(t.root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const reg = readJSON(path.join(REPO, 'plugins', 'anti-hall', 'codex', 'hooks', 'hooks.registry.json')).hooks;
    const old = JSON.parse(JSON.stringify(reg).split('${PLUGIN_ROOT}').join('/Users/x/.codex/plugins/anti-hall'));
    old.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep-me', timeout: 1 }] });
    fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify({ hooks: old }, null, 2));
    const r = run(t.root);
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    const hooks = readJSON(path.join(codexDir, 'hooks.json')).hooks;
    const all = Object.values(hooks).flat().flatMap(g => g.hooks || []).map(h => h.command);
    assert.ok(all.includes('echo keep-me'));
    assert.ok(!all.some(c => /\/hooks\/[a-z-]+\.js/.test(c)), 'no old per-hook registration survives');
    for (const ev of ['SessionStart', 'PreToolUse', 'Stop']) {
      assert.strictEqual(hooks[ev].filter(g => g.hooks.some(h => /ah-hook\.sh"/.test(h.command))).length, 1, ev);
    }
  } finally { t.cleanup(); }
});
