'use strict';
// gitignore-hint: `.anti-hall/` not git-ignored in the user's repo. Covers the
// shared lib (status + repairExclude), doctor (WARN), runRepairs (explicit
// repair only, idempotent, never touches .gitignore), and the once-per-7-days
// SessionStart reminder carried by progress-prune.js (+ its settings switch).

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const { writeSettings } = require('../helpers/settings-switch.js');

// Isolate git from the developer's global excludes for in-process lib calls.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const REPO_ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(REPO_ROOT, 'plugins', 'anti-hall');
const hint = require(path.join(PLUGIN, 'hooks', 'lib', 'gitignore-hint.js'));
const { runRepairs } = require(path.join(PLUGIN, 'hooks', 'lib', 'doctor-repair.js'));
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-gih-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
function git(cwd, args) {
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, GIT_ENV, {
    GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@x.test', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@x.test' }) });
  assert.strictEqual(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}
// repo(withDir) -> a fresh fixture repo (real path), `.anti-hall/` present by default.
function repo(withDir = true) {
  const d = fs.realpathSync(tmp('repo'));
  git(d, ['init', '-q']);
  if (withDir) fs.mkdirSync(path.join(d, '.anti-hall', 'progress'), { recursive: true });
  return d;
}
const excludeOf = (d) => path.join(d, '.git', 'info', 'exclude');

test('not ignored -> not-ignored (doctor warns)', () => {
  const d = repo();
  try {
    assert.strictEqual(hint.status(d).status, 'not-ignored');
  } finally { rm(d); }
});

test('ignored via .gitignore -> ignored', () => {
  const d = repo();
  try {
    fs.writeFileSync(path.join(d, '.gitignore'), '.anti-hall/\n');
    assert.strictEqual(hint.status(d).status, 'ignored');
  } finally { rm(d); }
});

test('ignored via info/exclude -> ignored', () => {
  const d = repo();
  try {
    fs.appendFileSync(excludeOf(d), '.anti-hall/\n');
    assert.strictEqual(hint.status(d).status, 'ignored');
  } finally { rm(d); }
});

test('non-repo, repo without .anti-hall/ -> skip (silent)', () => {
  const plain = tmp('plain');
  const bare = repo(false);
  try {
    fs.mkdirSync(path.join(plain, '.anti-hall'));
    assert.strictEqual(hint.status(plain).status, 'skip');
    assert.strictEqual(hint.status(bare).status, 'skip');
    assert.strictEqual(hint.status('').status, 'skip');
  } finally { rm(plain); rm(bare); }
});

test('repairExclude: appends once, idempotent, creates info/, never touches .gitignore', () => {
  const d = repo();
  try {
    fs.rmSync(path.join(d, '.git', 'info'), { recursive: true, force: true });
    const r1 = hint.repairExclude(d);
    assert.strictEqual(r1.status, 'fixed', r1.msg);
    const r2 = hint.repairExclude(d);
    assert.strictEqual(r2.status, 'skipped', r2.msg);
    const lines = fs.readFileSync(excludeOf(d), 'utf8').split('\n').filter((l) => l === '.anti-hall/');
    assert.strictEqual(lines.length, 1, 'no duplicate line');
    assert.ok(!fs.existsSync(path.join(d, '.gitignore')), '.gitignore never created/edited');
    assert.strictEqual(hint.status(d).status, 'ignored');
  } finally { rm(d); }
});

test('repairExclude: file without trailing newline keeps prior content on its own line; dry-run writes nothing', () => {
  const d = repo();
  try {
    fs.writeFileSync(excludeOf(d), '*.log');
    assert.strictEqual(hint.repairExclude(d, { dryRun: true }).status, 'skipped');
    assert.strictEqual(fs.readFileSync(excludeOf(d), 'utf8'), '*.log');
    assert.strictEqual(hint.repairExclude(d).status, 'fixed');
    assert.strictEqual(fs.readFileSync(excludeOf(d), 'utf8'), '*.log\n.anti-hall/\n');
  } finally { rm(d); }
});

test('repairExclude: linked worktree resolves the shared info/exclude', () => {
  const d = repo(false);
  const wt = path.join(tmp('wt'), 'child');
  try {
    git(d, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(d, ['worktree', 'add', '-q', wt]);
    fs.mkdirSync(path.join(wt, '.anti-hall'));
    const real = fs.realpathSync(wt);
    assert.strictEqual(hint.status(real).status, 'not-ignored');
    assert.strictEqual(hint.repairExclude(real).status, 'fixed');
    assert.ok(fs.readFileSync(excludeOf(d), 'utf8').includes('.anti-hall/'), 'written to the common git dir');
    assert.strictEqual(hint.status(real).status, 'ignored');
  } finally { rm(d); rm(path.dirname(wt)); }
});

test('runRepairs: dry-run previews only; live run fixes; second run is skipped', () => {
  const d = repo();
  const home = makeHome().home;
  const run = (dryRun) => runRepairs({ home, cwd: d, env: {}, dryRun }).find((r) => r.id === 'gitignore-hint');
  try {
    assert.strictEqual(run(true).status, 'skipped');
    assert.ok(!fs.readFileSync(excludeOf(d), 'utf8').includes('.anti-hall/'));
    assert.strictEqual(run(false).status, 'fixed');
    assert.strictEqual(run(false).status, 'skipped');
    assert.strictEqual(fs.readFileSync(excludeOf(d), 'utf8').split('\n').filter((l) => l === '.anti-hall/').length, 1);
  } finally { rm(d); }
});

test('runRepairs: migrationsOnly (automatic pass) never touches info/exclude', () => {
  const d = repo();
  const home = makeHome().home;
  try {
    const rows = runRepairs({ home, cwd: d, env: {}, dryRun: false, migrationsOnly: true });
    assert.ok(!rows.some((r) => r.id === 'gitignore-hint'));
    assert.ok(!fs.readFileSync(excludeOf(d), 'utf8').includes('.anti-hall/'));
  } finally { rm(d); }
});

test('doctor --check: WARNs with the remedy when not ignored; silent when ignored', () => {
  const d = repo();
  const home = makeHome().home || fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const run = () => cp.spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'doctor.js'), '--check'], {
    cwd: d, encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, GIT_ENV, { HOME: home, USERPROFILE: home, ANTIHALL_INGEST_DRY_RUN: '1' }),
  });
  try {
    const out1 = run();
    const t1 = (out1.stdout || '') + (out1.stderr || '');
    assert.match(t1, /\.anti-hall\/ is NOT git-ignored/);
    assert.match(t1, /add `\.anti-hall\/` to \.gitignore, or run `doctor --repair`/);
    fs.appendFileSync(excludeOf(d), '.anti-hall/\n');
    const out2 = run();
    assert.doesNotMatch((out2.stdout || '') + (out2.stderr || ''), /NOT git-ignored/);
  } finally { rm(d); }
});

// ---- SessionStart reminder (progress-prune.js) ----
const runHook = (d, home) => testHook('progress-prune.js', { hook_event_name: 'SessionStart', session_id: 't', cwd: d }, { home, env: GIT_ENV });
const ctx = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch (_) { return null; } };

test('reminder: emitted once, deduplicated within 7 days, re-emitted after', () => {
  const d = repo();
  const h = makeHome();
  try {
    const r1 = runHook(d, h.home);
    assert.strictEqual(r1.status, 0);
    assert.strictEqual(ctx(r1), hint.REMINDER_LINE);
    assert.strictEqual(ctx(runHook(d, h.home)), null, 'second session: deduplicated');
    const sf = path.join(h.home, '.anti-hall', 'gitignore-hint-state.json');
    const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
    st[d] = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(sf, JSON.stringify(st));
    assert.strictEqual(ctx(runHook(d, h.home)), hint.REMINDER_LINE, 're-shown after 7 days');
  } finally { rm(d); }
});

test('reminder: silent when ignored, non-repo, or guards.gitignoreHint=false', () => {
  const ignored = repo();
  const plain = tmp('plain');
  const off = repo();
  const h = makeHome();
  try {
    fs.appendFileSync(excludeOf(ignored), '.anti-hall/\n');
    fs.mkdirSync(path.join(plain, '.anti-hall'));
    assert.strictEqual(ctx(runHook(ignored, h.home)), null);
    assert.strictEqual(ctx(runHook(plain, h.home)), null);
    writeSettings(h.home, { guards: { gitignoreHint: false } });
    const r = runHook(off, h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), null, 'setting off silences the reminder');
  } finally { rm(ignored); rm(plain); rm(off); }
});
