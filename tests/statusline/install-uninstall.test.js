'use strict';
// install-statusline.js / uninstall-statusline.js — the settings installer.
// These scripts WRITE settings files, so isolation is critical: every test runs
// the child with a fake HOME (its ~/.claude and ~/.anti-hall) and a fake cwd
// (its .claude/ + .gitignore). The real ~/.claude is never the target because
// SETTINGS_PATH is derived from os.homedir()/process.cwd(), both overridden.
//
// Coverage: --user wrapping of an existing statusLine into base-statusline.json,
// --project writing settings.local.json + .gitignore + backup, idempotency, and
// the three uninstall restore strategies (A: base, C: key removal) + --purge-base.

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

function install(sb, args) {
  return runSL('install-statusline.js', { home: sb.home, cwd: sb.cwd, args });
}
function uninstall(sb, args) {
  return runSL('uninstall-statusline.js', { home: sb.home, cwd: sb.cwd, args });
}

// --- install --user ---------------------------------------------------------

test('install --user wraps the existing statusLine into base-statusline.json and preserves other keys', () => {
  const sb = sandbox();
  try {
    sb.writeUser({ statusLine: { type: 'command', command: 'echo OLD' }, keepme: 1 });
    const r = install(sb, ['--user']);
    assert.strictEqual(r.status, 0);
    // Existing command saved as the global base wrapper.
    assert.ok(fs.existsSync(sb.baseCfg), 'base-statusline.json written');
    assert.strictEqual(sb.readJSON(sb.baseCfg).command, 'echo OLD');
    // statusLine now points at the dispatcher; other keys untouched.
    const s = sb.readJSON(sb.userSettings);
    assert.match(s.statusLine.command, /statusline\.js/);
    assert.strictEqual(s.keepme, 1, 'unrelated keys preserved');
  } finally { sb.cleanup(); }
});

test('install --user is idempotent (re-run detects already-installed, no change)', () => {
  const sb = sandbox();
  try {
    sb.writeUser({ statusLine: { type: 'command', command: 'echo OLD' } });
    install(sb, ['--user']);
    const after1 = fs.readFileSync(sb.userSettings, 'utf8');
    const r2 = install(sb, ['--user']);
    assert.match(r2.stdout, /already installed/i);
    assert.strictEqual(fs.readFileSync(sb.userSettings, 'utf8'), after1, 'second run made no change');
  } finally { sb.cleanup(); }
});

test('install --user errors out when ~/.claude/settings.json is absent', () => {
  const sb = sandbox();
  try {
    // No settings.json written.
    const r = install(sb, ['--user']);
    assert.notStrictEqual(r.status, 0, 'non-zero exit when user settings missing');
    assert.match(r.stderr, /not found/i);
  } finally { sb.cleanup(); }
});

// --- install --project ------------------------------------------------------

test('install --project writes settings.local.json, a backup, and a .gitignore entry', () => {
  const sb = sandbox();
  try {
    const r = install(sb, ['--project']);
    assert.strictEqual(r.status, 0);
    // settings.local.json created and points at the dispatcher.
    assert.ok(fs.existsSync(sb.localSettings), 'settings.local.json created');
    assert.match(sb.readJSON(sb.localSettings).statusLine.command, /statusline\.js/);
    // .gitignore now ignores the local settings file.
    const gi = fs.readFileSync(sb.gitignore, 'utf8');
    assert.match(gi, /\.claude\/settings\.local\.json/);
    // A backup of the (freshly created) settings.local.json exists.
    assert.ok(fs.existsSync(sb.localSettings + '.bak-antihall'), 'backup created');
  } finally { sb.cleanup(); }
});

test('install --project does not duplicate the .gitignore entry on re-run', () => {
  const sb = sandbox();
  try {
    install(sb, ['--project']);
    install(sb, ['--project']);
    const lines = fs.readFileSync(sb.gitignore, 'utf8').split('\n')
      .filter(l => l.trim() === '.claude/settings.local.json');
    assert.strictEqual(lines.length, 1, 'gitignore entry present exactly once');
  } finally { sb.cleanup(); }
});

// --- uninstall: strategy A (restore from base) ------------------------------

test('uninstall --user (strategy A) restores the original command from base-statusline.json', () => {
  const sb = sandbox();
  try {
    sb.writeUser({ statusLine: { type: 'command', command: 'echo OLD' }, keepme: 1 });
    install(sb, ['--user']);     // creates base-statusline.json = echo OLD
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
    sb.writeUser({ statusLine: { type: 'command', command: 'echo OLD' } });
    install(sb, ['--user']);
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
