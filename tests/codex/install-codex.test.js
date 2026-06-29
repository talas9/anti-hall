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

test('install-codex: writes supported Codex hook subset and enables hooks feature', () => {
  const t = tmpProject();
  try {
    const r = run(t.root);
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);

    const hooksPath = path.join(t.root, '.codex', 'hooks.json');
    const configPath = path.join(t.root, '.codex', 'config.toml');
    const hooks = readJSON(hooksPath).hooks;
    assert.ok(Array.isArray(hooks.SessionStart));
    assert.ok(Array.isArray(hooks.UserPromptSubmit));
    assert.ok(Array.isArray(hooks.PreToolUse));
    assert.ok(Array.isArray(hooks.Stop));

    const preCommands = hooks.PreToolUse.flatMap(g => g.hooks || []).map(h => h.command).join('\n');
    assert.match(preCommands, /git-guard\.js/);
    assert.match(preCommands, /command-guard\.js/);
    assert.doesNotMatch(preCommands, /api-guard\.js/);
    assert.doesNotMatch(preCommands, /ship-it-guard\.js/);

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
    assert.ok(commands.some(c => /[\\/]git-guard\.js$/.test(c.replace(/\"$/, ''))));
  } finally { t.cleanup(); }
});
