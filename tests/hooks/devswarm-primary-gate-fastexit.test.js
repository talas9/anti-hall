'use strict';
// Hook-latency fast exit: the large role-specific DevSwarm hooks must not load
// their heavy companion libs in a session they cannot act on (non-DevSwarm,
// wrong role, setting off, user skip), and must still run in full when they can.
// Observed through process.mainModule's require.cache dumped by a --require probe.

require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOKS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks');
const GATE = require(path.join(HOOKS, 'lib', 'devswarm-primary-gate.js'));
const lazyNode = require(path.join(HOOKS, 'lib', 'lazy-node.js'));
const HEAVY = path.join('companion', 'lib', 'liveness.js'); // loaded at module scope by every hook below

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-fastexit-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* own temp dir */ } });
const probe = path.join(tmp, 'probe.js');
fs.writeFileSync(probe, "process.on('exit',()=>{try{require('fs').writeFileSync(process.env.PROBE_OUT,Object.keys(require.cache).join('\\n'))}catch(e){}});\n");

const HOOK_CASES = [
  { hook: 'devswarm-parent-gate.js', role: 'primary', event: 'Stop' },
  { hook: 'devswarm-parent-inbox.js', role: 'primary', event: 'UserPromptSubmit' },
  { hook: 'devswarm-child-turn.js', role: 'child', event: 'UserPromptSubmit' },
  { hook: 'devswarm-child-gate.js', role: 'child', event: 'Stop' },
];

function run(hook, event, envExtra, home) {
  const out = path.join(tmp, 'cache-' + Math.random().toString(36).slice(2));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PROBE_OUT: out, ...envExtra };
  const payload = JSON.stringify({ hook_event_name: event, session_id: 's1', cwd: tmp, prompt: 'hi', stop_hook_active: false });
  const r = spawnSync(process.execPath, ['--require', probe, path.join(HOOKS, hook)], { input: payload, env, encoding: 'utf8', cwd: tmp });
  let loaded = [];
  try { loaded = fs.readFileSync(out, 'utf8').split('\n'); } catch (_) { /* probe not written */ }
  return { status: r.status, stdout: r.stdout, loaded };
}
const freshHome = () => fs.mkdtempSync(path.join(tmp, 'home-'));
const hasHeavy = (loaded) => loaded.some((f) => f.endsWith(HEAVY));
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'feat/x', DEVSWARM_BUILDER_ID: 'b1' };

for (const c of HOOK_CASES) {
  test(c.hook + ': non-DevSwarm session exits without loading the heavy libs', () => {
    const r = run(c.hook, c.event, {}, freshHome());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(r.loaded.length > 0, 'probe recorded the require cache');
    assert.ok(!hasHeavy(r.loaded), 'heavy lib must not load for a non-DevSwarm session');
  });
  test(c.hook + ': wrong role exits without loading the heavy libs', () => {
    const r = run(c.hook, c.event, c.role === 'primary' ? CHILD_ENV : PRIMARY_ENV, freshHome());
    assert.strictEqual(r.status, 0);
    assert.ok(!hasHeavy(r.loaded));
  });
  test(c.hook + ': the right role still runs the full hook', () => {
    const r = run(c.hook, c.event, c.role === 'primary' ? PRIMARY_ENV : CHILD_ENV, freshHome());
    assert.strictEqual(r.status, 0);
    assert.ok(hasHeavy(r.loaded), 'heavy lib must load when the hook can act');
  });
}

test('setting off exits early; the skip marker exits early for a guarded hook', () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  fs.writeFileSync(path.join(home, '.anti-hall', 'skip.json'), JSON.stringify({ 'devswarm-parent-gate': Date.now() + 60000 }));
  assert.ok(!hasHeavy(run('devswarm-parent-gate.js', 'Stop', PRIMARY_ENV, home).loaded), 'user skip');
  assert.ok(hasHeavy(run('devswarm-parent-inbox.js', 'UserPromptSubmit', PRIMARY_ENV, home).loaded), 'skip of another guard does not exit');
});

test('inert() unit: role + setting semantics, never throws', () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^DEVSWARM_|^ANTIHALL_/.test(k)) delete process.env[k];
    assert.strictEqual(GATE.inert({ setting: 'parentInbox' }), true, 'non-DevSwarm is inert');
    process.env.DEVSWARM_REPO_ID = 'r';
    assert.strictEqual(GATE.inert({ setting: 'parentInbox' }), false, 'Primary runs primary hooks');
    assert.strictEqual(GATE.inert({ setting: 'childTurn', role: 'child' }), true, 'Primary is inert for child hooks');
    process.env.DEVSWARM_SOURCE_BRANCH = 'b';
    assert.strictEqual(GATE.inert({ setting: 'parentInbox' }), true, 'child is inert for primary hooks');
    assert.strictEqual(GATE.inert({ setting: 'childTurn', role: 'child' }), false, 'child runs child hooks');
    assert.strictEqual(GATE.inert(undefined), true);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('lazy-node: defers the real require to first property access, same API', () => {
  const lz = lazyNode.lazy('crypto');
  assert.strictEqual(lz.createHash('sha1').update('a').digest('hex'), require('node:crypto').createHash('sha1').update('a').digest('hex'));
  assert.ok('randomBytes' in lazyNode.crypto);
  assert.strictEqual(lazyNode.crypto.randomBytes(4).length, 4);
});
