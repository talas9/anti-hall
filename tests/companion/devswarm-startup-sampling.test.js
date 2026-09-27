'use strict';
// companion/lib/devswarm-startup-sampling.js — paused-workspace DATA CAPTURE
// ONLY (no suppression, no status change). Every test uses an isolated tmp
// HOME and a STUBBED hivecontrol run function — never spawns the real binary.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const sampling = require(path.join(ROOT, 'companion', 'lib', 'devswarm-startup-sampling.js'));
const { livenessPathFor, devswarmRoot } = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-startupsamp-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function writeVerdict(home, id, verdict) {
  const p = livenessPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(verdict));
}

function desc(id) { return { id, worktreePath: '/tmp/wt-' + id, sessionId: 'sess-' + id }; }

test('selectCandidates: stale or notDraining rows qualify; a normal row does not', () => {
  const home = tmpHome();
  try {
    writeVerdict(home, 'a', { status: 'stale', notDraining: false });
    writeVerdict(home, 'b', { status: 'alive', notDraining: true });
    writeVerdict(home, 'c', { status: 'alive', notDraining: false });
    // 'd' has no verdict at all -> excluded
    const out = sampling.selectCandidates([desc('a'), desc('b'), desc('c'), desc('d')], { home });
    assert.deepStrictEqual(out.map((d) => d.id).sort(), ['a', 'b']);
  } finally { rm(home); }
});

test('selectCandidates: capped at maxProbe', () => {
  const home = tmpHome();
  try {
    const descs = [];
    for (let i = 0; i < 20; i++) {
      writeVerdict(home, 'w' + i, { status: 'stale' });
      descs.push(desc('w' + i));
    }
    const out = sampling.selectCandidates(descs, { home, maxProbe: 3 });
    assert.strictEqual(out.length, 3);
  } finally { rm(home); }
});

test('worthCapturing: non-null startup or a terminalId change is worth capturing', () => {
  assert.strictEqual(sampling.worthCapturing({ startup: null, terminalId: 't1' }, 't1'), false);
  assert.strictEqual(sampling.worthCapturing({ startup: 'paused', terminalId: 't1' }, 't1'), true);
  assert.strictEqual(sampling.worthCapturing({ startup: null, terminalId: 't2' }, 't1'), true);
  assert.strictEqual(sampling.worthCapturing(null, 't1'), false);
});

test('runSamplingPass: appends a capture for a non-null startup field, using a stubbed run()', () => {
  const home = tmpHome();
  try {
    writeVerdict(home, 'ws1', { status: 'stale' });
    const stubRun = (id) => ({ ok: true, raw: JSON.stringify({ id, startup: 'paused', terminalId: 'term-1' }) });
    const r = sampling.runSamplingPass([desc('ws1')], { home, now: 1000, run: stubRun });
    assert.strictEqual(r.probed, 1);
    assert.strictEqual(r.captured, 1);
    assert.strictEqual(sampling.countSamples(home), 1);
    const raw = fs.readFileSync(sampling.samplesPath(home), 'utf8').trim();
    const row = JSON.parse(raw);
    assert.strictEqual(row.id, 'ws1');
    assert.strictEqual(row.ts, 1000);
    assert.strictEqual(row.raw.startup, 'paused');
  } finally { rm(home); }
});

test('runSamplingPass: startup stays null and terminalId unchanged -> nothing captured', () => {
  const home = tmpHome();
  try {
    writeVerdict(home, 'ws2', { status: 'stale' });
    // seed prior state with the SAME terminalId the probe will report
    sampling.writeState(home, { ws2: { terminalId: 'term-x', lastProbedAt: 0 } });
    const stubRun = () => ({ ok: true, raw: JSON.stringify({ startup: null, terminalId: 'term-x' }) });
    const r = sampling.runSamplingPass([desc('ws2')], { home, now: 2000, run: stubRun });
    assert.strictEqual(r.probed, 1);
    assert.strictEqual(r.captured, 0);
    assert.strictEqual(sampling.countSamples(home), 0);
  } finally { rm(home); }
});

test('runSamplingPass: a terminalId CHANGE from the prior probe is captured even with startup:null', () => {
  const home = tmpHome();
  try {
    writeVerdict(home, 'ws3', { status: 'stale' });
    sampling.writeState(home, { ws3: { terminalId: 'term-old', lastProbedAt: 0 } });
    const stubRun = () => ({ ok: true, raw: JSON.stringify({ startup: null, terminalId: 'term-new' }) });
    const r = sampling.runSamplingPass([desc('ws3')], { home, now: 3000, run: stubRun });
    assert.strictEqual(r.captured, 1);
    // state advances to the new terminalId
    const state = sampling.readState(home);
    assert.strictEqual(state.ws3.terminalId, 'term-new');
  } finally { rm(home); }
});

test('runSamplingPass: a probe failure (non-ok / unparseable) is skipped, never throws', () => {
  const home = tmpHome();
  try {
    writeVerdict(home, 'ws4', { status: 'stale' });
    writeVerdict(home, 'ws5', { status: 'stale' });
    const stubRun = (id) => (id === 'ws4' ? { ok: false, error: 'boom' } : { ok: true, raw: 'not json' });
    const r = sampling.runSamplingPass([desc('ws4'), desc('ws5')], { home, now: 4000, run: stubRun });
    assert.strictEqual(r.captured, 0);
    assert.strictEqual(sampling.countSamples(home), 0);
  } finally { rm(home); }
});

test('runSamplingPass respects opts.maxProbe end to end', () => {
  const home = tmpHome();
  try {
    const descs = [];
    for (let i = 0; i < 12; i++) {
      writeVerdict(home, 'x' + i, { status: 'stale' });
      descs.push(desc('x' + i));
    }
    let calls = 0;
    const stubRun = () => { calls++; return { ok: true, raw: JSON.stringify({ startup: 'paused' }) }; };
    const r = sampling.runSamplingPass(descs, { home, now: 5000, run: stubRun, maxProbe: 4 });
    assert.strictEqual(calls, 4);
    assert.strictEqual(r.probed, 4);
    assert.strictEqual(r.captured, 4);
  } finally { rm(home); }
});

test('log rotation: an oversized active log rotates to .1 before the next append', () => {
  const home = tmpHome();
  try {
    fs.mkdirSync(path.dirname(sampling.samplesPath(home)), { recursive: true });
    // Write a big row directly, past MAX_LOG_BYTES, to force rotation on next append.
    fs.writeFileSync(sampling.samplesPath(home), 'x'.repeat(sampling.MAX_LOG_BYTES + 10) + '\n');
    sampling.appendSample(home, { id: 'y', ts: 1, raw: { startup: 'paused' } });
    assert.ok(fs.existsSync(sampling.samplesPath(home) + '.1'), 'rotated generation should exist');
    const active = fs.readFileSync(sampling.samplesPath(home), 'utf8').trim();
    const row = JSON.parse(active);
    assert.strictEqual(row.id, 'y');
  } finally { rm(home); }
});

test('countSamples: 0 when no log file exists yet', () => {
  const home = tmpHome();
  try {
    assert.strictEqual(sampling.countSamples(home), 0);
  } finally { rm(home); }
});
