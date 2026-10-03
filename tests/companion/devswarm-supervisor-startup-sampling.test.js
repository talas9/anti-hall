'use strict';
// devswarm-supervisor.js reconcileSweepIfDue -> startup-sampling wiring
// (0.117.0). Verifies the sweep invokes the injected startup-sampling module
// after the active-cache write, gated by devswarm.startupSampling, with fully
// injected deps — no real hivecontrol/git subprocess.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-startupsamp-sweep-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;

const M = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js'));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-startupsamp-sweep-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'workspaces'); }
function writeDescriptor(home, d) {
  const dir = descriptorsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ inboxPath: '/i', cursorPath: '/c', sessionId: 'sess-' + d.id }, d);
  fs.writeFileSync(path.join(dir, d.id + '.json'), JSON.stringify(full));
}

function baseDeps(overrides) {
  return Object.assign({
    repoKeyForWorktree: () => 'proj-key',
    runReconcile: () => ({ ok: true, count: 0, imported: 0, lost: 0 }),
    runFold: () => ({ ok: true }),
    runActiveList: () => ({ ok: true, records: [{ id: 'a', worktreePath: '/wt/a' }] }),
    writeActiveCache: () => {},
  }, overrides || {});
}

test('reconcileSweepIfDue calls the injected startup-sampling module once, with this tick\'s descriptors', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let calledWith = null;
    const stubSampling = { runSamplingPass: (descriptors, opts) => { calledWith = { descriptors, opts }; return { ran: true, probed: 0, captured: 0 }; } };

    const res = M.reconcileSweepIfDue({
      home, env: {},
      deps: baseDeps({ startupSampling: stubSampling }),
    });

    assert.strictEqual(res.ran, true);
    assert.ok(calledWith, 'startup-sampling.runSamplingPass should have been called');
    assert.strictEqual(calledWith.descriptors.length, 1);
    assert.strictEqual(calledWith.descriptors[0].id, 'a');
    assert.strictEqual(calledWith.opts.home, home);
  } finally { cleanup(); }
});

test('reconcileSweepIfDue does NOT call startup-sampling when devswarm.startupSampling=false', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { startupSampling: false } }));

    let called = false;
    const stubSampling = { runSamplingPass: () => { called = true; return { ran: true, probed: 0, captured: 0 }; } };

    M.reconcileSweepIfDue({ home, env: { HOME: home }, deps: baseDeps({ startupSampling: stubSampling }) });
    assert.strictEqual(called, false);
  } finally { cleanup(); }
});

test('a throwing startup-sampling module never breaks the reconcile sweep', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const stubSampling = { runSamplingPass: () => { throw new Error('boom'); } };
    const res = M.reconcileSweepIfDue({ home, env: {}, deps: baseDeps({ startupSampling: stubSampling }) });
    assert.strictEqual(res.ran, true);
  } finally { cleanup(); }
});

test('devswarm.pausedProbeMax is threaded through as opts.maxProbe', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), JSON.stringify({ devswarm: { pausedProbeMax: 2 } }));

    let seenMax = null;
    const stubSampling = { runSamplingPass: (descriptors, opts) => { seenMax = opts.maxProbe; return { ran: true, probed: 0, captured: 0 }; } };
    M.reconcileSweepIfDue({ home, env: { HOME: home }, deps: baseDeps({ startupSampling: stubSampling }) });
    assert.strictEqual(seenMax, 2);
  } finally { cleanup(); }
});
