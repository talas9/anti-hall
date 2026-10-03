'use strict';
// Coordinator-drift Phase 5: the full post-compact log replayed through the
// shipped classifier (command-guard classifyBashWork) and the F1 window
// (lib/coordinator-work.js replay). The fixture is the real 181-call log,
// sanitised (@REPO@, @SCRATCH@, @HOME@, @PROJECT@, @ID@ placeholders). Expectations are
// DETECTION POINTS: after a block, later rows still replay as logged, because
// the recorded session ran unguarded. Defaults: 10-min window, nudge 4, block 7.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const cg = require(path.join(ROOT, 'plugins', 'anti-hall', 'hooks', 'command-guard.js'));
const FIXTURE = require(path.join(ROOT, 'tests', 'fixtures', 'coordinator-drift-replay.json'));
const H = process.env.HOME; // isolated test HOME = @HOME@
delete process.env.S;

const BASE = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'cw-replay-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
const REPO = path.join(BASE, 'repo');
const SCRATCH = path.join(BASE, 'scratch'); // tmp, not a git work tree, not inside HOME

function put(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function git(...args) {
  const r = childProcess.spawnSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
}
fs.mkdirSync(REPO, { recursive: true });
git('init', '-q');
for (const rel of ['.github/workflows/test.yml', 'CHANGELOG.md', 'RELEASING.md', 'tests/hooks/limit-conserve.test.js']) put(path.join(REPO, rel), 'x\n');
git('add', '-A');
git('commit', '-qm', 'init');
for (const s of ['push-dev.sh', 'ruleset.sh', 'push-and-rules.sh', 'topics.sh', 'fullsuite.sh', 'cl-merge.sh', 'og.sh']) {
  put(path.join(SCRATCH, s), '#!/bin/sh\necho x\n');
  fs.chmodSync(path.join(SCRATCH, s), 0o755);
}
put(path.join(H, '.anti-hall', 'bin', 'devswarm.js'), '// launcher\n');

const sub = (s) => s.split('@SCRATCH_ROOT@').join(BASE).split('@SCRATCH@').join(SCRATCH).split('@REPO@').join(REPO).split('@HOME@').join(H);
const rows = FIXTURE.map((r) => Object.assign({}, r, r.command ? { command: sub(r.command), cwd: REPO } : {}));
const DEFAULTS = { tMs: 600000, nudgeAt: 4, blockAt: 7, cap: 50 };

function lib() { return require(path.join(ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'coordinator-work.js')); }
let cached = null;
function enforced() {
  if (!cached) cached = lib().replay(rows, DEFAULTS, cg.classifyBashWork);
  return cached;
}
const byN = () => new Map(enforced().labeled.map((l) => [l.n, l]));
const set = (pred) => enforced().labeled.filter(pred).map((l) => l.n);

test('fixture: 181 rows, 97 Bash, sanitised', () => {
  assert.strictEqual(FIXTURE.length, 181);
  assert.strictEqual(FIXTURE.filter((r) => r.tool === 'Bash').length, 97);
  assert.strictEqual(FIXTURE[0].ts, '2026-10-03T10:35:59.697Z');
  const raw = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'coordinator-drift-replay.json'), 'utf8');
  assert.doesNotMatch(raw, /davila7|hesreallyhim|hashgraph-online|curviate|primary-d7a18d81|@gmail|\/Users\/talas9|talas9|claude-501|skycrew|tf3|toolfox|d0ee4470|44895798/i);
});

test('replay labels: posted and unposted WORK rows', () => {
  assert.deepStrictEqual(set((l) => l.posted && l.work),
    [16, 18, 20, 25, 39, 40, 43, 58, 60, 62, 64, 77, 87, 97, 100, 103, 107, 108, 117, 127, 129, 130, 137, 139, 142, 148, 150, 154]);
  assert.deepStrictEqual(set((l) => !l.posted && l.work), [17, 41, 57, 76, 115, 145, 146]);
});

test('replay labels: launcher rows are not WORK; row 76 limit-conserve segment alone is not script WORK', () => {
  const m = byN();
  for (const n of [3, 4, 11, 12, 13, 14, 80]) assert.strictEqual(m.get(n).work, false, 'row ' + n);
  const r = cg.classifyBashWork('node tests/hooks/limit-conserve.test.js', { cwd: REPO, session_id: 'replay' }, { sessionStartTs: Date.parse(FIXTURE[0].ts) });
  assert.strictEqual(r.work, false);
});

test('replay labels: rows 24/37 (auto-memory writes) are not WORK under a non-tmp HOME either', () => {
  const home = '/nonexistent-cw-home-' + process.pid;
  for (const n of [24, 37]) {
    const c = FIXTURE[n - 1].command.split('@HOME@').join(home);
    const r = cg.classifyBashWork(c, { cwd: REPO, session_id: 'replay' }, { sessionStartTs: Date.parse(FIXTURE[0].ts) });
    assert.strictEqual(r.work, false, 'row ' + n);
    assert.deepStrictEqual(r.editBlocks, [], 'row ' + n);
  }
});

test('replay labels: only row 130 is WORK but not blockable', () => {
  assert.deepStrictEqual(set((l) => l.work && !l.blockable), [130]);
});

test('replay enforced (blockAt 7): crossings, blocks, shares', () => {
  const r = enforced();
  assert.deepStrictEqual(r.crossings, [25, 103, 154]);
  assert.deepStrictEqual(r.blocks, [41, 43, 57, 58, 60, 62, 64, 76, 77, 115, 117, 127, 129, 137, 139, 150]);
  const posted = new Set(FIXTURE.filter((x) => x.posted).map((x) => x.n));
  const onPosted = r.blocks.filter((n) => posted.has(n));
  assert.strictEqual(onPosted[0], 43);
  assert.strictEqual(onPosted.length, 12);
  assert.ok(!r.blocks.includes(130) && !r.blocks.includes(145));
  assert.strictEqual(r.wouldNudge, 3);
  assert.strictEqual(r.wouldBlock, 16);
  assert.strictEqual(r.calls, 89);
  assert.strictEqual(r.work, 28);
  assert.ok(Math.abs(r.share - 28 / 89) < 1e-9, 'share ' + r.share);
  assert.ok(Math.abs(r.share - 0.315) < 0.001);
  assert.ok(Math.abs(r.attemptedShare - 32 / 93) < 1e-9, 'attempted ' + r.attemptedShare);
  assert.ok(Math.abs(r.attemptedShare - 0.344) < 0.001);
});

test('replay with blockAt 0: crossings 25/87/100, no blocks', () => {
  const r = lib().replay(rows, Object.assign({}, DEFAULTS, { blockAt: 0 }), cg.classifyBashWork);
  assert.deepStrictEqual(r.crossings, [25, 87, 100]);
  assert.deepStrictEqual(r.blocks, []);
  assert.strictEqual(r.calls, 89);
  assert.strictEqual(r.work, 28);
  assert.ok(Math.abs(r.attemptedShare - 28 / 89) < 1e-9);
});
