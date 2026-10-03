'use strict';
// Meeseeks plan-file writes are LOCKED (0.117.0). The supervisor sweep (Jev
// devswarmStepMap, straying state) and the child's own verbs (`heartbeat
// --step`, `scope add`, `plan set`, `done`) and the Primary's `correct` /
// `respawn` all read-modify-write plans/<key>.json. Unlocked, a write that
// lands between another writer's read and its rename is silently lost. Pins:
//   - two writers in two processes, interleaved INSIDE the first writer's
//     read-modify-write window: neither update is lost;
//   - no production file writes a plan outside planLib.updatePlan;
//   - the roster's plan.tokens / plan.straying fields (fixture).
// Isolated HOME everywhere.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plock-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const REPO = path.join(__dirname, '..', '..');
const ROOT = path.join(REPO, 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const planLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-plan.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));

function tmpHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plock-home-')));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ENV = { ANTIHALL_DEVSWARM_APP_DB: 'off', ANTIHALL_JEV: '0' };
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitFor(file, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fs.existsSync(file)) return true; sleepSync(10); }
  return fs.existsSync(file);
}

test('race: a second process writing the plan inside a heartbeat --step read-modify-write loses nothing', async () => {
  const home = tmpHome();
  const key = 'ch-race';
  const mark = path.join(home, 'b');
  const script = path.join(home, 'writer-b.js');
  fs.writeFileSync(script, [
    "'use strict';",
    'const fs = require("fs"); const os = require("os");',
    'const [root, home, key, mark] = process.argv.slice(2);',
    'const cli = require(root + "/scripts/devswarm.js");',
    'fs.writeFileSync(mark + ".start", "");',
    'const r = cli.run(["scope", "add", key, "--glob", "docs/**", "--note", "user asked for docs"],',
    '  { home, env: ' + JSON.stringify(ENV) + ', cwd: os.tmpdir() });',
    'fs.writeFileSync(mark + ".done", JSON.stringify(r.result));',
  ].join('\n'));
  const origRename = fs.renameSync;
  let child = null;
  try {
    const now = Date.now();
    planLib.savePlan(home, key, planLib.newPlan({ key, id: key, steps: ['read', 'fix', 'test'], now: now - 60000 }));
    const target = planLib.planPath(home, key);
    let fired = false;
    // Writer A (this process) is between its read and its rename of the plan
    // file: start writer B (another process) and give it every chance to
    // finish. Unlocked, B writes now and A's rename then drops B's extra.
    fs.renameSync = function patched(src, dst) {
      if (!fired && dst === target) {
        fired = true;
        child = cp.spawn(process.execPath, [script, ROOT, home, key, mark], {
          env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }), stdio: 'ignore',
        });
        assert.ok(waitFor(mark + '.start', 30000), 'writer B started');
        waitFor(mark + '.done', 1500);
      }
      return origRename.apply(fs, arguments);
    };
    const a = cli.run(['heartbeat', key, '--step', '1', '--status', 'doing'], { home, env: ENV, cwd: os.tmpdir(), now });
    fs.renameSync = origRename;
    assert.ok(fired, 'the interleave hook fired');
    assert.strictEqual(a.result.plan.changed, true, JSON.stringify(a.result.plan));
    await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.on('exit', resolve); });
    const b = JSON.parse(fs.readFileSync(mark + '.done', 'utf8'));
    assert.strictEqual(b.ok, true, JSON.stringify(b));
    const plan = planLib.findPlan(home, { id: key }).plan;
    assert.strictEqual(plan.steps[0].status, 'doing', 'writer A (heartbeat --step) kept');
    assert.deepStrictEqual((plan.extras || []).map((e) => e.glob), ['docs/**'], 'writer B (scope add) kept');
  } finally {
    fs.renameSync = origRename;
    if (child && child.exitCode === null) { try { child.kill(); } catch (_) {} }
    rm(home);
  }
});

test('ratchet: production code writes plan files only through planLib.updatePlan', () => {
  const r = cp.spawnSync('git', ['-C', REPO, 'grep', '-n', 'savePlan', '--', 'plugins/anti-hall'], { encoding: 'utf8' });
  const hits = String(r.stdout || '').split('\n').filter(Boolean)
    .filter((l) => !l.startsWith('plugins/anti-hall/companion/lib/devswarm-plan.js:'));
  assert.deepStrictEqual(hits, [], 'unlocked plan writes outside devswarm-plan.js');
});

test('roster fixture: plan.tokens and plan.straying appear once the supervisor has state', () => {
  const home = tmpHome();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plock-repo-')));
  try {
    const repo = path.join(base, 'main');
    cp.spawnSync('git', ['init', '-q', repo]);
    cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = path.join(base, 'feat-x');
    cp.spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', wt, '-b', 'feat-x']);
    const env = Object.assign({ PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter) }, ENV);
    const reg = cli.run(['register-primary'], { home, env: Object.assign({ CLAUDE_CODE_SESSION_ID: 'sess-p' }, env), cwd: repo });
    assert.strictEqual(reg.result.ok, true, JSON.stringify(reg.result));
    const rk = repokey.repoKeyForWorktree(repo);
    const CHILD = '5a5a5a5a-1111-4222-8333-444455556666';
    const s = storeLib.openStore({ home, hash: rk });
    try { s.upsertRegistry({ id: CHILD, worktreePath: wt, sessionId: 'sess-c' }); } finally { s.close(); }
    const desc = path.join(home, '.anti-hall', 'devswarm', 'workspaces', CHILD + '.json');
    fs.mkdirSync(path.dirname(desc), { recursive: true });
    fs.writeFileSync(desc, JSON.stringify({ id: CHILD, worktreePath: wt, sessionId: 'sess-c', ownerKey: rk, repoKey: rk }));
    const key = planLib.planKeyForWorktree(wt);
    const now = Date.now();
    planLib.savePlan(home, key, planLib.newPlan({ key, id: CHILD, worktreePath: wt, steps: ['read', 'fix'], now: now - 3600000 }));

    const row0 = cli.run(['roster'], { home, env, cwd: repo }).result.workspaces.find((w) => w.id === CHILD);
    assert.ok(row0 && row0.plan, 'row carries the P1 plan field');
    assert.ok(!('tokens' in row0.plan) && !('straying' in row0.plan), 'no supervisor state -> P1 shape only');

    const tokFile = require(path.join(ROOT, 'companion', 'lib', 'devswarm-token-usage.js')).statePath(home, key);
    fs.mkdirSync(path.dirname(tokFile), { recursive: true });
    fs.writeFileSync(tokFile, JSON.stringify({ total: 1834567.4, sinceStep: 420000.6 }));
    planLib.saveStray(home, key, { active: [{ signal: 'stall', step: 1, reason: 'no step progress for 45m',
      jev: [{ integration: 'devswarmWaitKind', verdict: 'stuck', confidence: 0.91, supports: true }] }] });

    const row = cli.run(['roster'], { home, env, cwd: repo }).result.workspaces.find((w) => w.id === CHILD);
    assert.deepStrictEqual(row.plan.tokens, { total: 1834567, sinceStep: 420001 });
    assert.match(row.plan.label, / · 1\.8M tok$/);
    assert.deepStrictEqual(row.plan.straying, [{ signal: 'stall', step: 1, reason: 'no step progress for 45m',
      jev: [{ integration: 'devswarmWaitKind', verdict: 'stuck', confidence: 0.91 }] }]);
  } finally { rm(home); rm(base); }
});
