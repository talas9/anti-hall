'use strict';
// codexGraphifyHooksMigratePostUpdate — forward migration for graphify's
// retirement (2026-09-18). `codex/install-codex.js` writes hook registrations
// into the USER'S OWN Codex config (global `~/.codex/hooks.json` or
// project-local `<cwd>/.codex/hooks.json`) — a PERSISTED shape, distinct from
// this plugin's own shipped `codex/hooks/hooks.json` template. An existing
// install may still carry graphify-session.js/graphify-guard.js/
// graphify-reminder.js registrations pointing at files this change deletes.
// This migration strips ONLY those groups, leaving everything else untouched.
//
// Isolated HOME/cwd per fixture (repo rule: tests never touch the real home) —
// codexGraphifyHooksMigratePostUpdate takes `home`/`cwd` explicitly and never
// falls back to os.homedir()/process.cwd() when they're passed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { codexGraphifyHooksMigratePostUpdate } = require('../../plugins/anti-hall/skills/update/scripts/update.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PATHS = { pluginSrcDir: path.join(REPO_ROOT, 'plugins', 'anti-hall') };

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-codexmigrate-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-codexmigrate-cwd-'));
  function cleanup() {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return { home, cwd, cleanup };
}

function writeHooksJson(dir, json) {
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify(json, null, 2));
}

function readHooksJson(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.codex', 'hooks.json'), 'utf8'));
}

const STALE_CONFIG = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'node /some/path/plugins/anti-hall/hooks/graphify-session.js', timeout: 10 }] },
      { hooks: [{ type: 'command', command: 'node /some/path/plugins/anti-hall/hooks/version-alert.js', timeout: 10 }] },
    ],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /some/path/plugins/anti-hall/hooks/graphify-guard.js', timeout: 10 }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /some/path/plugins/anti-hall/hooks/git-guard.js', timeout: 10 }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: 'node /some/path/plugins/anti-hall/hooks/graphify-reminder.js', timeout: 30 }] },
      { hooks: [{ type: 'command', command: 'node /some/path/plugins/anti-hall/hooks/task-guard.js', timeout: 30 }] },
    ],
  },
};

test('codex-graphify-hooks-migrate: strips all three graphify groups from a stale global config', () => {
  const f = makeFixture();
  try {
    writeHooksJson(f.home, STALE_CONFIG);
    const r = codexGraphifyHooksMigratePostUpdate({ paths: PATHS, cwd: f.cwd, home: f.home });
    assert.strictEqual(r.attempted, true);
    assert.strictEqual(r.changed, 1);
    assert.strictEqual(r.removed, 3);

    const after = readHooksJson(f.home);
    assert.strictEqual(after.hooks.SessionStart.length, 1);
    assert.strictEqual(after.hooks.PreToolUse.length, 1);
    assert.strictEqual(after.hooks.Stop.length, 1);
    assert.ok(!JSON.stringify(after).includes('graphify'), 'no graphify reference should survive');
  } finally {
    f.cleanup();
  }
});

test('codex-graphify-hooks-migrate: unrelated registrations survive byte-identical', () => {
  const f = makeFixture();
  try {
    writeHooksJson(f.home, STALE_CONFIG);
    codexGraphifyHooksMigratePostUpdate({ paths: PATHS, cwd: f.cwd, home: f.home });
    const after = readHooksJson(f.home);
    assert.deepStrictEqual(after.hooks.SessionStart[0], STALE_CONFIG.hooks.SessionStart[1]);
    assert.deepStrictEqual(after.hooks.PreToolUse[0], STALE_CONFIG.hooks.PreToolUse[1]);
    assert.deepStrictEqual(after.hooks.Stop[0], STALE_CONFIG.hooks.Stop[1]);
  } finally {
    f.cleanup();
  }
});

test('codex-graphify-hooks-migrate: running twice is a no-op the second time', () => {
  const f = makeFixture();
  try {
    writeHooksJson(f.home, STALE_CONFIG);
    const r1 = codexGraphifyHooksMigratePostUpdate({ paths: PATHS, cwd: f.cwd, home: f.home });
    assert.strictEqual(r1.changed, 1);
    const afterFirst = fs.readFileSync(path.join(f.home, '.codex', 'hooks.json'), 'utf8');

    const r2 = codexGraphifyHooksMigratePostUpdate({ paths: PATHS, cwd: f.cwd, home: f.home });
    assert.strictEqual(r2.attempted, true);
    assert.strictEqual(r2.changed, 0);
    assert.strictEqual(r2.removed, 0);
    const afterSecond = fs.readFileSync(path.join(f.home, '.codex', 'hooks.json'), 'utf8');
    assert.strictEqual(afterSecond, afterFirst, 'second run must not rewrite the file');
  } finally {
    f.cleanup();
  }
});

test('codex-graphify-hooks-migrate: a config with no graphify groups is left untouched', () => {
  const f = makeFixture();
  try {
    const clean = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node x/version-alert.js', timeout: 10 }] }] } };
    writeHooksJson(f.home, clean);
    const before = fs.readFileSync(path.join(f.home, '.codex', 'hooks.json'), 'utf8');
    const r = codexGraphifyHooksMigratePostUpdate({ paths: PATHS, cwd: f.cwd, home: f.home });
    assert.strictEqual(r.changed, 0);
    const after = fs.readFileSync(path.join(f.home, '.codex', 'hooks.json'), 'utf8');
    assert.strictEqual(after, before);
  } finally {
    f.cleanup();
  }
});

test('codex-graphify-hooks-migrate: a malformed config is left alone without throwing', () => {
  const f = makeFixture();
  try {
    fs.mkdirSync(path.join(f.home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(f.home, '.codex', 'hooks.json'), '{not valid json');
    const before = fs.readFileSync(path.join(f.home, '.codex', 'hooks.json'), 'utf8');
    const r = codexGraphifyHooksMigratePostUpdate({ paths: PATHS, cwd: f.cwd, home: f.home });
    assert.strictEqual(r.attempted, true);
    assert.strictEqual(r.errors, 0, 'a malformed config is silently skipped, not counted as an error');
    const after = fs.readFileSync(path.join(f.home, '.codex', 'hooks.json'), 'utf8');
    assert.strictEqual(after, before, 'malformed config must be byte-identical after a fail-open skip');
  } finally {
    f.cleanup();
  }
});

test('codex-graphify-hooks-migrate: a missing config on both targets is a clean no-op', () => {
  const f = makeFixture();
  try {
    const r = codexGraphifyHooksMigratePostUpdate({ paths: PATHS, cwd: f.cwd, home: f.home });
    assert.strictEqual(r.attempted, true);
    assert.strictEqual(r.changed, 0);
    assert.strictEqual(r.errors, 0);
  } finally {
    f.cleanup();
  }
});

test('codex-graphify-hooks-migrate: both global AND project-local configs are migrated independently', () => {
  const f = makeFixture();
  try {
    writeHooksJson(f.home, STALE_CONFIG);
    writeHooksJson(f.cwd, STALE_CONFIG);
    const r = codexGraphifyHooksMigratePostUpdate({ paths: PATHS, cwd: f.cwd, home: f.home });
    assert.strictEqual(r.changed, 2);
    assert.strictEqual(r.removed, 6);
    assert.ok(!JSON.stringify(readHooksJson(f.home)).includes('graphify'));
    assert.ok(!JSON.stringify(readHooksJson(f.cwd)).includes('graphify'));
  } finally {
    f.cleanup();
  }
});

test('codex-graphify-hooks-migrate: never deletes the config file itself', () => {
  const f = makeFixture();
  try {
    writeHooksJson(f.home, STALE_CONFIG);
    codexGraphifyHooksMigratePostUpdate({ paths: PATHS, cwd: f.cwd, home: f.home });
    assert.ok(fs.existsSync(path.join(f.home, '.codex', 'hooks.json')), 'config file must still exist');
  } finally {
    f.cleanup();
  }
});
