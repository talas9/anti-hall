'use strict';
// R15 item 5 (P3) — the SUPERVISOR sweep must never poke/escalate a row that
// `rowLivenessState` (companion/lib/liveness.js) proves is `idle-alive` —
// consistency with the read-side gate/table, which already suppress
// escalated/stale on this exact axis (defect 699a236129c5). Before this fix,
// `sweepOnce` derived `stale` from `computeLiveness` (activity timestamps
// only) and, on a `stale` verdict, only checked post-spawn-grace and
// archive-ready before invoking `pokeOrEscalate` — the session-sourced pid
// axis was never consulted at all on the WRITE side.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-sweep-idlealive-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'workspaces'); }
function writeDescriptor(home, d) {
  const dir = descriptorsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ inboxPath: '/i', cursorPath: '/c', sessionId: UUID }, d);
  const p = path.join(dir, full.id + '.json');
  fs.writeFileSync(p, JSON.stringify(full));
  const old = (Date.now() - 60 * 60 * 1000) / 1000; // past the post-spawn grace window
  fs.utimesSync(p, old, old);
}

const staleVerdict = () => ({ status: 'stale', lastOutboundTs: 1, staleSince: Date.now() - 1e6, nudgeAttempts: 0 });

test('item 5: a stale verdict is SUPPRESSED (never poked/escalated) when rowLivenessState says idle-alive', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let pokeCalls = 0;
    let sawRow = null;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: staleVerdict,
        writeVerdict: () => {},
        isArchiveReadyForSupervisor: () => false,
        rowLivenessState: (row) => { sawRow = row; return 'idle-alive'; },
        pokeOrEscalate: () => { pokeCalls++; return { action: 'nudged' }; },
      },
    });
    assert.strictEqual(pokeCalls, 0, 'idle-alive must suppress the poke/escalate call entirely');
    assert.strictEqual(res[0].poke.action, 'suppressed');
    assert.strictEqual(res[0].poke.reason, 'idle-alive');
    assert.ok(sawRow, 'rowLivenessState must actually be consulted');
    assert.strictEqual(sawRow.id, 'a');
    assert.strictEqual(sawRow.sessionId, UUID);
  } finally { cleanup(); }
});

test('item 5: a genuinely dormant stale row (rowLivenessState -> dormant) still pokes/escalates', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'b', worktreePath: '/wt/b' });
    let pokeCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: staleVerdict,
        writeVerdict: () => {},
        isArchiveReadyForSupervisor: () => false,
        rowLivenessState: () => 'dormant',
        pokeOrEscalate: () => { pokeCalls++; return { action: 'nudged' }; },
      },
    });
    assert.strictEqual(pokeCalls, 1, 'a genuinely dormant row must still be poked/escalated');
    assert.strictEqual(res[0].poke.action, 'nudged');
  } finally { cleanup(); }
});

test('item 5: idle-alive is skipped once grace/archive-ready already suppressed (cheapest-first)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'c', worktreePath: '/wt/c' });
    let rowLivenessCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: staleVerdict,
        writeVerdict: () => {},
        isArchiveReadyForSupervisor: () => true, // "done" suppresses first
        rowLivenessState: () => { rowLivenessCalls++; return 'idle-alive'; },
        pokeOrEscalate: () => ({ action: 'nudged' }),
      },
    });
    assert.strictEqual(rowLivenessCalls, 0, 'rowLivenessState must not be called once archive-ready already suppressed');
    assert.strictEqual(res[0].poke.reason, 'archive-ready');
  } finally { cleanup(); }
});

test('MUTATION: removing the idleAlive suppression restores poking an idle-alive row', () => {
  const SUPERVISOR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js');
  const src = fs.readFileSync(SUPERVISOR, 'utf8');
  const target = "if (graced || done || idleAlive) {";
  assert.ok(src.includes(target), 'mutant target string not found verbatim');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-supervisor-mutant-'));
  const scratchFile = path.join(scratchDir, 'devswarm-supervisor.js');
  try {
    fs.writeFileSync(scratchFile, src.replace(target, "if (graced || done) {"));
    // Symlink the sibling lib/ dir the module requires, module-identity-preserving.
    fs.symlinkSync(path.join(SUPERVISOR, '..', 'lib'), path.join(scratchDir, 'lib'), 'dir');
    delete require.cache[require.resolve(scratchFile)];
    const mutated = require(scratchFile);
    delete require.cache[require.resolve(scratchFile)];

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-sweep-mutant-'));
    try {
      writeDescriptor(home, { id: 'm', worktreePath: '/wt/m' });
      let pokeCalls = 0;
      const res = mutated.sweepOnce({
        home,
        deps: {
          computeLiveness: staleVerdict,
          writeVerdict: () => {},
          isArchiveReadyForSupervisor: () => false,
          rowLivenessState: () => 'idle-alive',
          pokeOrEscalate: () => { pokeCalls++; return { action: 'nudged' }; },
        },
      });
      assert.strictEqual(pokeCalls, 1,
        'MUTANT must reproduce the field bug — an idle-alive row poked/escalated again');
      assert.strictEqual(res[0].poke.action, 'nudged');
    } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
  } finally { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {} }
});
