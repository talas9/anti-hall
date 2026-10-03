'use strict';
// 0.108.5 P0 — anti-hall must never delete or move user data automatically.
// The pre-0.108.5 GSD fold ran from doctor's repair pass (and so from every
// repair-on-reload) and MOVED git-tracked .planning/ files out of child
// worktrees and submodules. These tests pin: no automatic path touches
// .planning/, the explicit fold is copy-only and refuses unsafe locations,
// doctor reports existing damage, and --restore-planning restores only
// byte-identical tracked files.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(REPO_ROOT, 'plugins', 'anti-hall');
const DOCTOR_JS = path.join(PLUGIN, 'hooks', 'doctor.js');
const MIGRATE_JS = path.join(PLUGIN, 'scripts', 'migrate-state.js');
const { migrateGsdPlanning } = require(MIGRATE_JS);

function mkTmp(tag) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-planning-' + tag + '-'))); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function gitEnv(home) {
  const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  return env;
}
function git(home, dir, args) {
  const r = cp.spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main', '-C', dir].concat(args),
  { encoding: 'utf8', env: gitEnv(home) });
  assert.strictEqual(r.status, 0, 'git ' + args.join(' ') + ' failed: ' + r.stderr);
  return r.stdout;
}
function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
function initRepo(home, tag) {
  const dir = mkTmp(tag);
  git(home, dir, ['init', '-q']);
  write(dir, 'README.md', 'x\n');
  git(home, dir, ['add', '-A']);
  git(home, dir, ['commit', '-q', '-m', 'init']);
  return dir;
}
function run(home, cwd, script, args) {
  const env = gitEnv(home);
  delete env.GIT_CONFIG_GLOBAL; delete env.GIT_CONFIG_NOSYSTEM;
  Object.assign(env, { DEVSWARM_REPO_ID: '', ANTIHALL_REPAIR_ON_RELOAD: 'off' });
  const r = cp.spawnSync(process.execPath, [script].concat(args || []), { cwd, encoding: 'utf8', env, timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const legacy = (dir, rel) => path.join(dir, '.anti-hall', 'history', 'legacy', 'planning', rel);

// Damage exactly as the old automatic fold left it: legacy copy written, source unlinked.
function damage(dir, rel, legacyContent) {
  const src = path.join(dir, '.planning', rel);
  write(dir, path.join('.anti-hall', 'history', 'legacy', 'planning', rel), legacyContent != null ? legacyContent : fs.readFileSync(src));
  fs.unlinkSync(src);
}

test('automatic repair (repair-on-reload\'s doctor --repair --migrations-only, and doctor --fix) never moves tracked .planning/', () => {
  const home = mkTmp('home');
  const repo = initRepo(home, 'tracked');
  try {
    write(repo, '.planning/ROADMAP.md', '# roadmap\n');
    write(repo, '.planning/phases/1.md', '# p1\n');
    git(home, repo, ['add', '-A']);
    git(home, repo, ['commit', '-q', '-m', 'planning']);

    run(home, repo, DOCTOR_JS, ['--repair', '--migrations-only', '--quiet']);
    run(home, repo, DOCTOR_JS, ['--fix']);

    assert.strictEqual(fs.readFileSync(path.join(repo, '.planning', 'ROADMAP.md'), 'utf8'), '# roadmap\n');
    assert.strictEqual(fs.readFileSync(path.join(repo, '.planning', 'phases', '1.md'), 'utf8'), '# p1\n');
    assert.strictEqual(git(home, repo, ['status', '--porcelain', '--', '.planning']), '', 'tracked .planning/ must be untouched');
    assert.ok(!fs.existsSync(legacy(repo, 'ROADMAP.md')), 'no automatic copy either');
  } finally { rm(repo); rm(home); }
});

test('automatic repair never touches even an UNTRACKED .planning/ in the main checkout', () => {
  const home = mkTmp('home');
  const repo = initRepo(home, 'untracked-auto');
  try {
    write(repo, '.planning/STATE.md', '# state\n');
    run(home, repo, DOCTOR_JS, ['--repair', '--migrations-only', '--quiet']);
    assert.strictEqual(fs.readFileSync(path.join(repo, '.planning', 'STATE.md'), 'utf8'), '# state\n');
    assert.ok(!fs.existsSync(legacy(repo, 'STATE.md')));
  } finally { rm(repo); rm(home); }
});

test('explicit fold in a linked (child) worktree is skipped with a reason; nothing copied or moved', () => {
  const home = mkTmp('home');
  const repo = initRepo(home, 'main');
  const wt = path.join(mkTmp('wtparent'), 'child');
  try {
    git(home, repo, ['worktree', 'add', '-q', '-b', 'child', wt]);
    write(wt, '.planning/STATE.md', '# child state\n');
    const r = migrateGsdPlanning({ dir: wt });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].action, 'unsafe-skip');
    assert.match(r[0].reason, /worktree/);
    assert.strictEqual(fs.readFileSync(path.join(wt, '.planning', 'STATE.md'), 'utf8'), '# child state\n');
    assert.ok(!fs.existsSync(legacy(wt, 'STATE.md')));
  } finally { rm(repo); rm(path.dirname(wt)); rm(home); }
});

test('explicit fold inside a git submodule is skipped with a reason; nothing copied or moved', () => {
  const home = mkTmp('home');
  const sub = initRepo(home, 'subsrc');
  const sup = initRepo(home, 'super');
  try {
    git(home, sup, ['submodule', 'add', '-q', sub, 'mod']);
    git(home, sup, ['commit', '-q', '-m', 'add sub']);
    const modDir = path.join(sup, 'mod');
    write(modDir, '.planning/NOTES.md', '# sub notes\n');
    const r = migrateGsdPlanning({ dir: modDir });
    assert.strictEqual(r[0].action, 'unsafe-skip');
    assert.match(r[0].reason, /submodule/);
    assert.strictEqual(fs.readFileSync(path.join(modDir, '.planning', 'NOTES.md'), 'utf8'), '# sub notes\n');
    assert.ok(!fs.existsSync(legacy(modDir, 'NOTES.md')));
  } finally { rm(sub); rm(sup); rm(home); }
});

test('explicit fold is skipped when .planning/ is git-tracked', () => {
  const home = mkTmp('home');
  const repo = initRepo(home, 'tracked-explicit');
  try {
    write(repo, '.planning/ROADMAP.md', '# r\n');
    git(home, repo, ['add', '-A']);
    git(home, repo, ['commit', '-q', '-m', 'p']);
    const r = migrateGsdPlanning({ dir: repo });
    assert.strictEqual(r[0].action, 'unsafe-skip');
    assert.match(r[0].reason, /tracked by git/);
    assert.ok(fs.existsSync(path.join(repo, '.planning', 'ROADMAP.md')));
    assert.ok(!fs.existsSync(legacy(repo, 'ROADMAP.md')));
  } finally { rm(repo); rm(home); }
});

test('explicit --planning on untracked .planning/ in the main checkout copies only; the default CLI does not fold .planning/', () => {
  const home = mkTmp('home');
  const repo = initRepo(home, 'untracked-explicit');
  try {
    write(repo, '.planning/STATE.md', '# state\n');
    const def = run(home, repo, MIGRATE_JS, [repo]);
    assert.ok(!fs.existsSync(legacy(repo, 'STATE.md')), 'default run must not touch .planning/:\n' + def.out);
    assert.ok(fs.existsSync(path.join(repo, '.planning', 'STATE.md')));

    const r = run(home, repo, MIGRATE_JS, ['--planning', repo]);
    assert.match(r.out, /1 file\(s\) copied/, r.out);
    assert.strictEqual(fs.readFileSync(legacy(repo, 'STATE.md'), 'utf8'), '# state\n');
    assert.strictEqual(fs.readFileSync(path.join(repo, '.planning', 'STATE.md'), 'utf8'), '# state\n', 'source must still exist');
    assert.strictEqual(migrateGsdPlanning({ dir: repo })[0].action, 'skipped');
    assert.ok(fs.existsSync(path.join(repo, '.planning', 'STATE.md')));
  } finally { rm(repo); rm(home); }
});

test('doctor reports moved tracked .planning/ files (main + child worktree) with the restore command, and restores nothing', () => {
  const home = mkTmp('home');
  const repo = initRepo(home, 'damaged');
  const wt = path.join(mkTmp('wtparent'), 'child');
  try {
    write(repo, '.planning/A.md', 'a\n');
    write(repo, '.planning/B.md', 'b\n');
    git(home, repo, ['add', '-A']);
    git(home, repo, ['commit', '-q', '-m', 'p']);
    git(home, repo, ['worktree', 'add', '-q', '-b', 'child', wt]);
    damage(repo, 'A.md');
    damage(repo, 'B.md');
    damage(wt, 'A.md');

    const r = run(home, repo, DOCTOR_JS, []);
    assert.match(r.out, /moved \.planning\/ files/, r.out);
    assert.ok(r.out.includes('git -C "' + repo + '" checkout -- .planning'), r.out);
    assert.ok(r.out.includes('git -C "' + wt + '" checkout -- .planning'), r.out);
    assert.match(r.out, /2 tracked \.planning\/ file\(s\) missing.*2 byte-identical to HEAD/, r.out);
    assert.ok(!fs.existsSync(path.join(repo, '.planning', 'A.md')), 'doctor must not restore anything');
    assert.ok(!fs.existsSync(path.join(wt, '.planning', 'A.md')));
  } finally { rm(repo); rm(path.dirname(wt)); rm(home); }
});

test('--restore-planning restores only missing tracked files whose legacy copy is byte-identical to HEAD; legacy copies kept', () => {
  const home = mkTmp('home');
  const repo = initRepo(home, 'restore');
  try {
    write(repo, '.planning/SAME.md', 'same\n');
    write(repo, '.planning/DIFF.md', 'committed\n');
    write(repo, '.planning/NOCOPY.md', 'n\n');
    write(repo, '.planning/PRESENT.md', 'present\n');
    git(home, repo, ['add', '-A']);
    git(home, repo, ['commit', '-q', '-m', 'p']);
    damage(repo, 'SAME.md');
    damage(repo, 'DIFF.md', 'edited later\n');
    fs.unlinkSync(path.join(repo, '.planning', 'NOCOPY.md'));
    write(repo, '.planning/PRESENT.md', 'local edit\n');
    write(repo, '.anti-hall/history/legacy/planning/PRESENT.md', 'present\n');

    const r = run(home, repo, MIGRATE_JS, ['--restore-planning', '--dir', repo]);
    assert.match(r.out, /restored 1 file\(s\)/, r.out);
    assert.strictEqual(fs.readFileSync(path.join(repo, '.planning', 'SAME.md'), 'utf8'), 'same\n');
    assert.ok(!fs.existsSync(path.join(repo, '.planning', 'DIFF.md')), 'non-identical legacy copy must not be restored');
    assert.ok(!fs.existsSync(path.join(repo, '.planning', 'NOCOPY.md')));
    assert.strictEqual(fs.readFileSync(path.join(repo, '.planning', 'PRESENT.md'), 'utf8'), 'local edit\n', 'present file never overwritten');
    for (const f of ['SAME.md', 'DIFF.md', 'PRESENT.md']) assert.ok(fs.existsSync(legacy(repo, f)), 'legacy copy kept: ' + f);
    assert.strictEqual(git(home, repo, ['status', '--porcelain', '--', '.planning/SAME.md']), '');
  } finally { rm(repo); rm(home); }
});
