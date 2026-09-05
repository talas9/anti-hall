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

// D12 (v0.96.1, false-positive escalation) — rowLivenessState's dormancy gate
// is 30 min (DEFAULT_DORMANT_MS) while the stale gate above is 15 min
// (DEFAULT_IDLE_MS): a row idle 15-30 min with a transcript is 'active' by
// that state machine (never 'idle-alive'), so sessionPidAlive was never
// consulted and a live-but-idle session could be escalated outright. Fix:
// isSessionAliveRow is now consulted DIRECTLY as a second, one-directional
// suppressor alongside rowLivenessState.
test('D12 item 1: rowLivenessState says active (15-30min gap) but isSessionAliveRow proves a live pid -> still suppressed', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'd12a', worktreePath: '/wt/d12a' }); // no nudgeCommand
    let pokeCalls = 0;
    let sawRow = null;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: staleVerdict,
        writeVerdict: () => {},
        isArchiveReadyForSupervisor: () => false,
        rowLivenessState: () => 'active', // the 15-30min gap: NOT idle-alive
        isSessionAliveRow: (row) => { sawRow = row; return true; }, // but a live pid IS proven
        pokeOrEscalate: () => { pokeCalls++; return { action: 'escalate' }; },
      },
    });
    assert.strictEqual(pokeCalls, 0, 'a proven-live session pid must suppress the poke/escalate call entirely');
    assert.strictEqual(res[0].poke.action, 'suppressed');
    assert.strictEqual(res[0].poke.reason, 'idle-alive');
    assert.ok(sawRow, 'isSessionAliveRow must actually be consulted');
    assert.strictEqual(sawRow.id, 'd12a');
  } finally { cleanup(); }
});

test('D12 item 1: rowLivenessState active AND isSessionAliveRow false (dead pid) -> still escalates (no regression)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'd12c', worktreePath: '/wt/d12c' }); // no nudgeCommand
    let pokeCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: staleVerdict,
        writeVerdict: () => {},
        isArchiveReadyForSupervisor: () => false,
        rowLivenessState: () => 'active',
        isSessionAliveRow: () => false, // dead pid, or no session evidence at all
        pokeOrEscalate: () => { pokeCalls++; return { action: 'escalate', reason: 'poke-exhausted' }; },
      },
    });
    assert.strictEqual(pokeCalls, 1, 'a dead/unproven pid must still be poked/escalated exactly as before');
    assert.strictEqual(res[0].poke.action, 'escalate');
  } finally { cleanup(); }
});

test('D12 item 1: isSessionAliveRow is skipped once grace/archive-ready already suppressed (cheapest-first)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'd12g', worktreePath: '/wt/d12g' });
    let isSessionAliveCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: staleVerdict,
        writeVerdict: () => {},
        isArchiveReadyForSupervisor: () => true, // "done" suppresses first
        rowLivenessState: () => 'active',
        isSessionAliveRow: () => { isSessionAliveCalls++; return true; },
        pokeOrEscalate: () => ({ action: 'escalate' }),
      },
    });
    assert.strictEqual(isSessionAliveCalls, 0, 'isSessionAliveRow must not be called once archive-ready already suppressed');
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

// D12 RED-PROOF (item 1): a scratch copy with the isSessionAliveRow OR-clause
// reverted reproduces the exact pre-fix field bug — a row idle 15-30 min
// (rowLivenessState -> 'active', never consulted past that) with a live pid
// and no nudgeCommand gets escalated on the first stale tick. This is the
// mechanism confirmed on the reporting machine for the false-positive
// escalation of a Primary anchor. Un-reverted (the CURRENT source, exercised
// by the 'D12 item 1' tests above), the same fixture is suppressed instead.
test('D12 RED-PROOF: pre-fix source (isSessionAliveRow clause reverted) escalates a live-pid row idle 15-30min', () => {
  const SUPERVISOR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js');
  const src = fs.readFileSync(SUPERVISOR, 'utf8');
  const target = "const idleAlive = !graced && !done\n          && (\n            (deps.rowLivenessState || rowLivenessState)(rowForLiveness, home, { now: nowTs }) === 'idle-alive'\n            || (deps.isSessionAliveRow || isSessionAliveRow)(rowForLiveness, home, { now: nowTs })\n          );";
  assert.ok(src.includes(target), 'D12 mutant target string not found verbatim — supervisor.js shape changed');
  const preFix = "const idleAlive = !graced && !done\n          && (deps.rowLivenessState || rowLivenessState)(rowForLiveness, home, { now: nowTs }) === 'idle-alive';";
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-supervisor-d12-mutant-'));
  const scratchFile = path.join(scratchDir, 'devswarm-supervisor.js');
  try {
    fs.writeFileSync(scratchFile, src.replace(target, preFix));
    fs.symlinkSync(path.join(SUPERVISOR, '..', 'lib'), path.join(scratchDir, 'lib'), 'dir');
    delete require.cache[require.resolve(scratchFile)];
    const mutated = require(scratchFile);
    delete require.cache[require.resolve(scratchFile)];

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-sweep-d12mutant-'));
    try {
      writeDescriptor(home, { id: 'd12red', worktreePath: '/wt/d12red' }); // no nudgeCommand
      let pokeCalls = 0;
      let sawSessionAlive = false;
      const res = mutated.sweepOnce({
        home,
        deps: {
          computeLiveness: staleVerdict,
          writeVerdict: () => {},
          isArchiveReadyForSupervisor: () => false,
          rowLivenessState: () => 'active', // the 15-30min gap, never 'idle-alive'
          isSessionAliveRow: () => { sawSessionAlive = true; return true; }, // proven-live pid
          pokeOrEscalate: () => { pokeCalls++; return { action: 'escalate', reason: 'poke-exhausted' }; },
        },
      });
      assert.strictEqual(pokeCalls, 1,
        'RED-PROOF: pre-fix source must reproduce the false-positive escalation of a live-pid row');
      assert.strictEqual(res[0].poke.action, 'escalate');
      assert.strictEqual(sawSessionAlive, false,
        'pre-fix source never consults isSessionAliveRow at all — confirms the exact confirmed root cause');
    } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
  } finally { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {} }
});
