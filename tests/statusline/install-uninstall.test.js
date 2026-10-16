'use strict';
// install-statusline.js / uninstall-statusline.js — the settings installer.
// These scripts WRITE settings files, so isolation is critical: every test runs
// the child with a fake HOME (its ~/.claude and ~/.anti-hall) and a fake cwd
// (its .claude/ + .gitignore). The real ~/.claude is never the target because
// SETTINGS_PATH is derived from os.homedir()/process.cwd(), both overridden.
//
// Coverage: install-statusline is retired/no-op, and uninstall-statusline still
// cleans old installs via restore strategies (A: base, C: key removal) + --purge-base.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSL } = require('./helper.js');

// Build an isolated { home, cwd } pair with ~/.claude present, plus helpers.
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inst-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-instcwd-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return {
    home, cwd,
    userSettings: path.join(home, '.claude', 'settings.json'),
    baseCfg: path.join(home, '.anti-hall', 'base-statusline.json'),
    localSettings: path.join(cwd, '.claude', 'settings.local.json'),
    projectSettings: path.join(cwd, '.claude', 'settings.json'),
    gitignore: path.join(cwd, '.gitignore'),
    writeUser(obj) { fs.writeFileSync(this.userSettings, JSON.stringify(obj), 'utf8'); },
    readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); },
    cleanup() {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

function install(sb, args, env) {
  return runSL('install-statusline.js', { home: sb.home, cwd: sb.cwd, args, env });
}
function uninstall(sb, args) {
  return runSL('uninstall-statusline.js', { home: sb.home, cwd: sb.cwd, args });
}

// --- retired install --------------------------------------------------------

test('install-statusline is retired: exits 0 and writes no statusLine', () => {
  const sb = sandbox();
  try {
    sb.writeUser({ keepme: 1 });
    const r = install(sb, ['--user']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /retired|no statusLine/i);
    assert.deepStrictEqual(sb.readJSON(sb.userSettings), { keepme: 1 });
    assert.ok(!fs.existsSync(sb.localSettings), 'project settings not created');
    assert.ok(!fs.existsSync(sb.gitignore), 'gitignore not touched');
  } finally { sb.cleanup(); }
});

// --- uninstall: strategy A (restore from base) ------------------------------

test('uninstall --user (strategy A) restores the original command from base-statusline.json', () => {
  const sb = sandbox();
  try {
    sb.writeUser({ statusLine: { type: 'command', command: 'node /tmp/anti-hall/statusline.js' }, keepme: 1 });
    fs.mkdirSync(path.dirname(sb.baseCfg), { recursive: true });
    fs.writeFileSync(sb.baseCfg, JSON.stringify({ command: 'echo OLD' }), 'utf8');
    const r = uninstall(sb, ['--user']);
    assert.strictEqual(r.status, 0);
    const s = sb.readJSON(sb.userSettings);
    assert.strictEqual(s.statusLine.command, 'echo OLD', 'original command restored');
    assert.strictEqual(s.keepme, 1, 'unrelated keys preserved');
    assert.ok(fs.existsSync(sb.baseCfg), 'shared base kept by default (other projects may use it)');
  } finally { sb.cleanup(); }
});

test('uninstall --user --purge-base removes the shared base config', () => {
  const sb = sandbox();
  try {
    sb.writeUser({ statusLine: { type: 'command', command: 'node /tmp/anti-hall/statusline.js' } });
    fs.mkdirSync(path.dirname(sb.baseCfg), { recursive: true });
    fs.writeFileSync(sb.baseCfg, JSON.stringify({ command: 'echo OLD' }), 'utf8');
    const r = uninstall(sb, ['--user', '--purge-base']);
    assert.match(r.stdout, /purged/i);
    assert.ok(!fs.existsSync(sb.baseCfg), 'base config deleted with --purge-base');
  } finally { sb.cleanup(); }
});

// --- uninstall: strategy C (no base/backup -> remove key) -------------------

test('uninstall --user (strategy C) removes the statusLine key when no base/backup exists', () => {
  const sb = sandbox();
  try {
    // statusLine present but NO base-statusline.json and NO .bak-antihall.
    sb.writeUser({ statusLine: { command: 'x' }, foo: 9 });
    const r = uninstall(sb, ['--user']);
    assert.strictEqual(r.status, 0);
    const s = sb.readJSON(sb.userSettings);
    assert.ok(!('statusLine' in s), 'statusLine key removed');
    assert.strictEqual(s.foo, 9, 'unrelated keys preserved');
  } finally { sb.cleanup(); }
});

test('uninstall is idempotent when the statusLine key is already absent', () => {
  const sb = sandbox();
  try {
    sb.writeUser({ foo: 1 });
    const r = uninstall(sb, ['--user']);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /nothing to uninstall/i);
  } finally { sb.cleanup(); }
});

// --- uninstall --project: round-trip against the file install actually wrote --
// P0-2: install --project writes settings.local.json, but uninstall --project
// used to target settings.json — wrong file, so it never actually removed
// anti-hall AND clobbered an unrelated committed settings.json with no backup.

test('uninstall --project round-trips against settings.local.json (the file install writes), backs it up, and leaves an unrelated settings.json untouched', () => {
  const sb = sandbox();
  try {
    // An UNRELATED committed settings.json already defines its own statusLine —
    // e.g. a team's shared, version-controlled statusline. install --project must
    // never touch this file, and neither must uninstall --project.
    fs.mkdirSync(path.dirname(sb.projectSettings), { recursive: true });
    fs.writeFileSync(sb.projectSettings, JSON.stringify({ statusLine: { command: 'echo TEAM' } }), 'utf8');

    fs.mkdirSync(path.dirname(sb.localSettings), { recursive: true });
    fs.writeFileSync(sb.localSettings, JSON.stringify({ statusLine: { command: 'node /tmp/anti-hall/statusline.js' }, keep: true }), 'utf8');
    assert.ok(fs.existsSync(sb.localSettings), 'install wrote settings.local.json');
    assert.match(sb.readJSON(sb.localSettings).statusLine.command, /statusline\.js/);

    const r = uninstall(sb, ['--project']);
    assert.strictEqual(r.status, 0);

    // The anti-hall statusLine must actually be gone from settings.local.json —
    // NOT left in place while a different file gets clobbered (the P0-2 bug).
    const local = sb.readJSON(sb.localSettings);
    assert.ok(!local.statusLine || !/statusline\.js/.test(local.statusLine.command || ''),
      'anti-hall statusLine removed from settings.local.json');

    // A backup of settings.local.json (the file actually mutated) must exist.
    assert.ok(fs.existsSync(sb.localSettings + '.bak-antihall'), 'backup of settings.local.json exists');

    // The unrelated settings.json must be completely untouched.
    const proj = sb.readJSON(sb.projectSettings);
    assert.strictEqual(proj.statusLine.command, 'echo TEAM', 'unrelated settings.json statusLine left untouched');
  } finally { sb.cleanup(); }
});

test("uninstall --project (strategy A) does not clobber a settings.local.json statusLine that is not anti-hall's", () => {
  const sb = sandbox();
  try {
    // Simulate: base-statusline.json exists (from a prior install elsewhere),
    // but the CURRENT settings.local.json statusLine points at something else
    // entirely (not the anti-hall dispatcher). Strategy A must not overwrite it
    // with the base command. A same-content backup isolates this from strategy
    // C's separate (pre-existing, intentionally unconditional) key-removal path:
    // if A wrongly fired, the file would read back 'echo ORIGINAL'; since it
    // correctly skips, B's restore-from-backup is a same-content no-op.
    fs.mkdirSync(path.dirname(sb.localSettings), { recursive: true });
    const unrelated = { statusLine: { command: 'echo NOT_ANTIHALL' } };
    fs.writeFileSync(sb.localSettings, JSON.stringify(unrelated), 'utf8');
    fs.writeFileSync(sb.localSettings + '.bak-antihall', JSON.stringify(unrelated), 'utf8');
    fs.mkdirSync(path.dirname(sb.baseCfg), { recursive: true });
    fs.writeFileSync(sb.baseCfg, JSON.stringify({ command: 'echo ORIGINAL' }), 'utf8');

    const r = uninstall(sb, ['--project']);
    assert.strictEqual(r.status, 0);
    const local = sb.readJSON(sb.localSettings);
    assert.strictEqual(local.statusLine.command, 'echo NOT_ANTIHALL', 'unrelated statusLine left untouched by strategy A');
  } finally { sb.cleanup(); }
});
