'use strict';
// devswarm-supervisor: one sweep over published descriptors. Uses a real temp
// HOME for descriptor discovery; computeLiveness/pokeOrEscalate are injected so
// no real process is touched and per-workspace fail-open is provable. The
// AUTOMATIC path never resolves a pid and never kills — it has no findTarget or
// recover dependency at all any more; a `stale` verdict only ever reaches
// pokeOrEscalate. Also covers descriptor sanitization (unsafe id / missing
// sessionId dropped) and the single-flight sweep lock.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-sweep-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'workspaces'); }
// A complete, valid descriptor unless overridden.
function writeDescriptor(home, d, fileName) {
  const dir = descriptorsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ inboxPath: '/i', cursorPath: '/c', sessionId: UUID }, d);
  fs.writeFileSync(path.join(dir, (fileName || d.id) + '.json'), JSON.stringify(full));
}

test('supervisorEnabled: off / hard-kill disable; otherwise enabled', () => {
  assert.strictEqual(M.supervisorEnabled({}), true);
  assert.strictEqual(M.supervisorEnabled({ ANTIHALL_DEVSWARM_SUPERVISOR: 'off' }), false);
  assert.strictEqual(M.supervisorEnabled({ DISABLE_ANTIHALL_DEVSWARM: '1' }), false);
});

test('readDescriptors: reads valid; skips malformed / no-worktree / no-sessionId / unsafe-id', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const dir = descriptorsDir(home);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'nofields.json'), JSON.stringify({ id: 'x', sessionId: UUID })); // no worktreePath
    fs.writeFileSync(path.join(dir, 'nosession.json'), JSON.stringify({ id: 'y', worktreePath: '/wt/y' })); // no sessionId
    fs.writeFileSync(path.join(dir, 'evil.json'), JSON.stringify({ id: '../../x', worktreePath: '/wt/z', sessionId: UUID })); // P1-7
    const ds = M.readDescriptors(home);
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].id, 'a');
  } finally { cleanup(); }
});

test('sweepOnce: alive workspace -> verdict written, no poke/escalate attempted', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let pokeCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'alive', lastOutboundTs: 1, staleSince: null, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        pokeOrEscalate: () => { pokeCalls++; return { action: 'nudged' }; },
      },
    });
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].verdict.status, 'alive');
    assert.strictEqual(res[0].poke, null);
    assert.strictEqual(pokeCalls, 0);
  } finally { cleanup(); }
});

test('sweepOnce: stale workspace -> pokeOrEscalate invoked; NEVER findTarget, NEVER a kill', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const seen = {};
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        // The automatic path has NO findTarget/recover dependency at all any more —
        // sweepOnce cannot possibly call them since they are simply not required.
        pokeOrEscalate: (d, verdict, opts) => { seen.id = d.id; seen.verdictStatus = verdict.status; seen.home = opts.home; return { action: 'nudged' }; },
      },
    });
    assert.strictEqual(seen.id, 'a');
    assert.strictEqual(seen.verdictStatus, 'stale');
    assert.strictEqual(seen.home, home);
    assert.strictEqual(res[0].poke.action, 'nudged');
  } finally { cleanup(); }
});

test('sweepOnce: fail-open — a throwing computeLiveness on one workspace does not stop the rest', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    writeDescriptor(home, { id: 'b', worktreePath: '/wt/b' });
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: (o) => { if (o.descriptor.id === 'a') throw new Error('boom'); return { status: 'alive', nudgeAttempts: 0 }; },
        writeVerdict: () => {},
        pokeOrEscalate: () => ({ action: 'nudged' }),
      },
    });
    assert.strictEqual(res.length, 2);
    const a = res.find((r) => r.id === 'a'); const b = res.find((r) => r.id === 'b');
    assert.ok(a.error, 'workspace a recorded an error');
    assert.strictEqual(b.verdict.status, 'alive', 'workspace b still processed');
  } finally { cleanup(); }
});

test('sweepOnce: disabled -> empty (no work)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const res = M.sweepOnce({ home, env: { ANTIHALL_DEVSWARM_SUPERVISOR: 'off' } });
    assert.deepStrictEqual(res, []);
  } finally { cleanup(); }
});

test('parseEnvNum: valid override, clamped; invalid/absent/non-positive -> default', () => {
  assert.strictEqual(M.parseEnvNum({ X: '120' }, 'X', 90), 120);
  assert.strictEqual(M.parseEnvNum({ X: '10' }, 'X', 90, { min: 60 }), 60, 'clamped up to min');
  assert.strictEqual(M.parseEnvNum({ X: '999' }, 'X', 90, { max: 100 }), 100, 'clamped down to max');
  assert.strictEqual(M.parseEnvNum({}, 'X', 90), 90, 'absent -> default');
  assert.strictEqual(M.parseEnvNum({ X: '' }, 'X', 90), 90, 'empty -> default');
  assert.strictEqual(M.parseEnvNum({ X: 'abc' }, 'X', 90), 90, 'non-numeric -> default');
  assert.strictEqual(M.parseEnvNum({ X: '0' }, 'X', 90), 90, 'zero -> default');
  assert.strictEqual(M.parseEnvNum({ X: '-5' }, 'X', 90), 90, 'negative -> default');
  assert.strictEqual(M.parseEnvNum({ X: '12.5' }, 'X', 90), 90, 'non-integer -> default');
  // the min/max clamp applies to the default itself too, so an out-of-range
  // default can never slip through unclamped just because the env var is unset.
  assert.strictEqual(M.parseEnvNum({}, 'X', 10, { min: 60 }), 60);
});

test('resolveThresholdsFromEnv: each env var overrides its threshold; absent -> byte-for-byte defaults', () => {
  const defaults = M.resolveThresholdsFromEnv({});
  assert.deepStrictEqual(defaults, {
    idleThresholdMs: 15 * 60 * 1000,
    cooldownMs: 10 * 60 * 1000,
    nudgeMaxAttempts: 2,
    nudgeWindowMs: 3 * 60 * 1000,
    nudgeCooldownMs: 2 * 60 * 1000,
  }, 'no env set -> current module defaults, unchanged');

  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_IDLE_SEC: '120' }).idleThresholdMs, 120 * 1000,
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_COOLDOWN_SEC: '30' }).cooldownMs, 30 * 1000,
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS: '1' }).nudgeMaxAttempts, 1,
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC: '600' }).nudgeWindowMs, 600 * 1000,
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC: '10' }).nudgeCooldownMs, 10 * 1000,
  );

  // clamps
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_IDLE_SEC: '10' }).idleThresholdMs, 60 * 1000, 'idle floored to 60s',
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS: '99' }).nudgeMaxAttempts, 20, 'nudgeMaxAttempts capped at 20',
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_NUDGE_MAX_ATTEMPTS: '0' }).nudgeMaxAttempts, 2, 'invalid -> default (fail-open)',
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC: '0' }).nudgeWindowMs, 3 * 60 * 1000, 'invalid window -> default',
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_NUDGE_COOLDOWN_SEC: 'abc' }).nudgeCooldownMs, 2 * 60 * 1000, 'non-numeric -> default',
  );
});

test('sweepOnce: nudgeMaxAttempts/nudgeCooldownMs are threaded through to pokeOrEscalate for a stale workspace', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let seen;
    M.sweepOnce({
      home, nudgeMaxAttempts: 7, nudgeCooldownMs: 12345,
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        pokeOrEscalate: (d, verdict, opts) => { seen = opts; return { action: 'nudged' }; },
      },
    });
    assert.strictEqual(seen.nudgeMaxAttempts, 7);
    assert.strictEqual(seen.nudgeCooldownMs, 12345);
  } finally { cleanup(); }
});

test('sweepOnce: nudgeWindowMs is threaded through to computeLiveness for every workspace', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let seenWindow;
    M.sweepOnce({
      home, nudgeWindowMs: 54321,
      deps: {
        computeLiveness: (o) => { seenWindow = o.nudgeWindowMs; return { status: 'alive', nudgeAttempts: 0 }; },
        writeVerdict: () => {},
      },
    });
    assert.strictEqual(seenWindow, 54321);
  } finally { cleanup(); }
});

test('end-to-end: ANTIHALL_DEVSWARM_IDLE_SEC moves the stale cutoff seen by computeLiveness', () => {
  const { computeLiveness, projectDirFor } = require(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
  ));
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    const projectDir = projectDirFor(worktreePath, home);
    fs.mkdirSync(projectDir, { recursive: true });
    const tp = path.join(projectDir, UUID + '.jsonl');
    fs.writeFileSync(tp, '{}\n');
    const ageMs = 20 * 60 * 1000; // 20 minutes idle
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(tp, t, t);
    const inboxPath = path.join(worktreePath, 'i'); const cursorPath = path.join(worktreePath, 'c');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(inboxPath, JSON.stringify({ m: 1 }) + '\n');
    fs.writeFileSync(cursorPath, '0');
    const descriptor = { id: 'w1', worktreePath, inboxPath, cursorPath, sessionId: UUID };

    // default idle (15m) -> 20m-idle workspace classifies stale.
    const withDefault = M.resolveThresholdsFromEnv({});
    const v1 = computeLiveness({ descriptor, home, idleThresholdMs: withDefault.idleThresholdMs, runners: { gitCommitTs: () => Date.now() - ageMs } });
    assert.strictEqual(v1.status, 'stale');

    // ANTIHALL_DEVSWARM_IDLE_SEC=1800 (30m) -> the SAME 20m-idle workspace is now alive.
    const withOverride = M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_IDLE_SEC: '1800' });
    const v2 = computeLiveness({ descriptor, home, idleThresholdMs: withOverride.idleThresholdMs, runners: { gitCommitTs: () => Date.now() - ageMs } });
    assert.strictEqual(v2.status, 'alive');
  } finally { cleanup(); }
});

test('sweepOnce (real computeLiveness + pokeOrEscalate): escalation appends ONE parent-store notice; repeated sweeps do not duplicate it (#19)', () => {
  const { projectDirFor, livenessPathFor } = require(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
  ));
  const inst = require(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js',
  ));
  const storeLib = require(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js',
  ));
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    fs.mkdirSync(worktreePath, { recursive: true });
    const projectDir = projectDirFor(worktreePath, home);
    fs.mkdirSync(projectDir, { recursive: true });
    const tp = path.join(projectDir, UUID + '.jsonl');
    fs.writeFileSync(tp, '{}\n');
    const ageMs = 20 * 60 * 1000; // 20 minutes idle -> past the default 15m threshold
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(tp, t, t);
    const inboxPath = path.join(worktreePath, 'i'); const cursorPath = path.join(worktreePath, 'c');
    fs.writeFileSync(inboxPath, JSON.stringify({ m: 1 }) + '\n');
    fs.writeFileSync(cursorPath, '0');
    writeDescriptor(home, { id: 'w1', worktreePath, inboxPath, cursorPath }, 'w1'); // NO nudgeCommand -> escalate on first stale sweep

    const runners = { gitCommitTs: () => Date.now() - ageMs };
    // Sweep 1: real computeLiveness classifies stale (no nudgeCommand) -> real
    // pokeOrEscalate escalates immediately and notifies the parent store. The
    // returned `verdict` here is the FRESH computeLiveness result (pre-escalate,
    // 'stale') — pokeOrEscalate mutates the PERSISTED liveness file separately, so
    // assert that on disk, not on this in-memory snapshot.
    const res1 = M.sweepOnce({ home, deps: { runners } });
    assert.strictEqual(res1.length, 1);
    assert.strictEqual(res1[0].verdict.status, 'stale');
    assert.strictEqual(res1[0].poke.action, 'escalate');
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');

    // Sweeps 2 and 3: liveness.js's terminal short-circuit returns 'escalated'
    // without recompute, so sweepOnce's `verdict.status === 'stale'` gate never
    // re-invokes pokeOrEscalate for this workspace again.
    const res2 = M.sweepOnce({ home, deps: { runners } });
    const res3 = M.sweepOnce({ home, deps: { runners } });
    assert.strictEqual(res2[0].verdict.status, 'escalated');
    assert.strictEqual(res2[0].poke, null, 'no re-poke on an already-escalated workspace');
    assert.strictEqual(res3[0].poke, null);

    const parentId = inst.primaryWorkspaceId(worktreePath);
    const s = storeLib.openStore({ home, workspaceId: parentId }); // parent's own per-project store
    let msgs;
    try { msgs = s.listMessages(parentId, {}); } finally { s.close(); }
    assert.strictEqual(msgs.length, 1, 'exactly one parent notice survives three sweeps');
    assert.match(msgs[0].body, /child w1 idle/);
    assert.match(msgs[0].body, /reassign or archive/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Mesh-urgency escalation (v0.58 "mesh-only messaging" — additive Tier 0 wake).
// readMeshUrgency reads this project's `summaries/<repoKey>.json` (the SAME
// projection file the hooks read, deriveSummary-written) and looks up THIS
// descriptor's own row; sweepOnce forces a parent-store escalate notice
// (notifyParentEscalation — never a kill, never a resolved pid) when that row's
// urgencyMax is high/urgent AND the workspace is stale, independent of the
// pre-existing pokeOrEscalate nudge/escalate cadence.
// ---------------------------------------------------------------------------

test('readMeshUrgency: resolves repoKey + reads summary, returns this descriptor\'s urgency row', () => {
  const d = { id: 'w1', worktreePath: '/wt/w1' };
  const seen = {};
  const urgency = M.readMeshUrgency(d, '/home', {
    repoKeyForWorktree: (wt) => { seen.wt = wt; return 'myrepo-abc123'; },
    readSummaryForHash: (home, hash) => {
      seen.home = home; seen.hash = hash;
      return { workspaces: { w1: { urgencyMax: 'urgent', directUnread: 3, broadcastUnread: 1 } } };
    },
  });
  assert.strictEqual(seen.wt, '/wt/w1');
  assert.strictEqual(seen.home, '/home');
  assert.strictEqual(seen.hash, 'myrepo-abc123');
  assert.deepStrictEqual(urgency, { urgencyMax: 'urgent', directUnread: 3, broadcastUnread: 1 });
});

test('readMeshUrgency: fail-open — unresolvable repoKey (non-git worktree) -> null, never throws', () => {
  const urgency = M.readMeshUrgency({ id: 'w1', worktreePath: '/not/git' }, '/home', {
    repoKeyForWorktree: () => null,
    readSummaryForHash: () => { throw new Error('must not be called when repoKey is null'); },
  });
  assert.strictEqual(urgency, null);
});

test('readMeshUrgency: fail-open — missing/unreadable summary file -> null, never throws (item 3)', () => {
  const urgency = M.readMeshUrgency({ id: 'w1', worktreePath: '/wt/w1' }, '/home', {
    repoKeyForWorktree: () => 'myrepo-abc123',
    readSummaryForHash: () => null, // mirrors the real readSummaryForHash's tolerant-null on ENOENT/bad JSON
  });
  assert.strictEqual(urgency, null);
});

test('readMeshUrgency: fail-open — descriptor id absent from summary.workspaces -> null', () => {
  const urgency = M.readMeshUrgency({ id: 'w1', worktreePath: '/wt/w1' }, '/home', {
    repoKeyForWorktree: () => 'myrepo-abc123',
    readSummaryForHash: () => ({ workspaces: { someOtherId: { urgencyMax: 'urgent' } } }),
  });
  assert.strictEqual(urgency, null);
});

test('readMeshUrgency: fail-open — a throwing repoKeyForWorktree/readSummaryForHash never propagates', () => {
  assert.strictEqual(
    M.readMeshUrgency({ id: 'w1', worktreePath: '/wt/w1' }, '/home', {
      repoKeyForWorktree: () => { throw new Error('boom'); },
    }),
    null,
  );
});

test('isUrgentMesh: only high/urgent qualify; low/normal/absent/null do not', () => {
  assert.strictEqual(M.isUrgentMesh({ urgencyMax: 'urgent' }), true);
  assert.strictEqual(M.isUrgentMesh({ urgencyMax: 'high' }), true);
  assert.strictEqual(M.isUrgentMesh({ urgencyMax: 'normal' }), false);
  assert.strictEqual(M.isUrgentMesh({ urgencyMax: 'low' }), false);
  assert.strictEqual(M.isUrgentMesh({ urgencyMax: null }), false);
  assert.strictEqual(M.isUrgentMesh(null), false);
  assert.strictEqual(M.isUrgentMesh(undefined), false);
});

test('sweepOnce: stale descriptor WITH urgent unread in its mesh summary -> escalation notice produced, even though the base poke only nudged', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let notifyCalls = 0; let seenDescriptor = null; let seenVerdict = null;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        // base poke only NUDGES (attempts remain) -> proves the urgency escalate is
        // an INDEPENDENT path, not a side effect of pokeOrEscalate's own exhaustion.
        pokeOrEscalate: () => ({ action: 'nudged' }),
        readMeshUrgency: () => ({ urgencyMax: 'urgent', directUnread: 2, broadcastUnread: 0 }),
        notifyParentEscalation: (d, verdict) => { notifyCalls++; seenDescriptor = d; seenVerdict = verdict; },
      },
    });
    assert.strictEqual(notifyCalls, 1, 'urgent unread forces exactly one escalation notice');
    assert.strictEqual(seenDescriptor.id, 'a');
    assert.strictEqual(seenVerdict.status, 'stale');
    assert.strictEqual(res[0].poke.action, 'nudged', 'the base poke result is untouched by the urgency escalate');
  } finally { cleanup(); }
});

test('sweepOnce: SAME stale descriptor with only low/normal unread -> NO escalation (rely on the agent\'s next turn)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let notifyCalls = 0;
    for (const tier of ['low', 'normal']) {
      const res = M.sweepOnce({
        home,
        deps: {
          computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
          writeVerdict: () => {},
          pokeOrEscalate: () => ({ action: 'nudged' }),
          readMeshUrgency: () => ({ urgencyMax: tier, directUnread: 1, broadcastUnread: 0 }),
          notifyParentEscalation: () => { notifyCalls++; },
        },
      });
      assert.strictEqual(res[0].poke.action, 'nudged');
    }
    assert.strictEqual(notifyCalls, 0, 'low/normal urgency never forces an escalation notice');
  } finally { cleanup(); }
});

test('sweepOnce: no mesh summary at all (dormant mesh / real readMeshUrgency) -> no throw, no escalation', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let notifyCalls = 0;
    // readMeshUrgency is left UNMOCKED (real) — deps.repoKeyForWorktree resolves a
    // repoKey, but no summaries/<repoKey>.json was ever written for it, so the
    // real readSummaryForHash reads through to null (ENOENT) -> fail-open null.
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        pokeOrEscalate: () => ({ action: 'nudged' }),
        repoKeyForWorktree: () => 'myrepo-abc123',
        notifyParentEscalation: () => { notifyCalls++; },
      },
    });
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].error, undefined, 'a missing summary file must never throw out of the sweep');
    assert.strictEqual(res[0].poke.action, 'nudged');
    assert.strictEqual(notifyCalls, 0);
  } finally { cleanup(); }
});

test('sweepOnce: mesh-urgency path NEVER resolves a pid / never kills — recover/findTarget/kill spies present but never invoked', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let recoverCalls = 0; let findTargetCalls = 0; let killCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        pokeOrEscalate: () => ({ action: 'nudged' }),
        readMeshUrgency: () => ({ urgencyMax: 'urgent', directUnread: 5, broadcastUnread: 0 }),
        notifyParentEscalation: () => {},
        // sweepOnce has no code path that reads these deps at all — proves it
        // structurally cannot resolve a pid or kill, even under an urgent verdict.
        recover: () => { recoverCalls++; },
        findTarget: () => { findTargetCalls++; },
        kill: () => { killCalls++; },
      },
    });
    assert.strictEqual(recoverCalls, 0);
    assert.strictEqual(findTargetCalls, 0);
    assert.strictEqual(killCalls, 0);
    assert.strictEqual(res[0].poke.action, 'nudged');
  } finally { cleanup(); }
});

test('sweepOnce (real notifyParentEscalation + real store): urgent mesh unread on a stale-but-nudged workspace still appends a parent-store escalate notice', () => {
  const inst = require(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js',
  ));
  const storeLib = require(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js',
  ));
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    fs.mkdirSync(worktreePath, { recursive: true });
    writeDescriptor(home, { id: 'w1', worktreePath }, 'w1');

    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0 }),
        writeVerdict: () => {},
        // base poke only nudges (a nudgeCommand-bearing / not-yet-exhausted case) --
        // the escalate below can ONLY come from the urgency path.
        pokeOrEscalate: () => ({ action: 'nudged' }),
        readMeshUrgency: () => ({ urgencyMax: 'high', directUnread: 4, broadcastUnread: 0 }),
      },
    });
    assert.strictEqual(res[0].poke.action, 'nudged');

    const parentId = inst.primaryWorkspaceId(worktreePath);
    const s = storeLib.openStore({ home, workspaceId: parentId });
    let msgs;
    try { msgs = s.listMessages(parentId, {}); } finally { s.close(); }
    assert.strictEqual(msgs.length, 1, 'exactly one parent notice from the urgency-forced escalate');
    assert.match(msgs[0].body, /child w1 idle/);
    assert.match(msgs[0].body, /reassign or archive/);
  } finally { cleanup(); }
});

test('single-flight: a live-holder sweep lock blocks a second acquire; a dead holder is stolen', () => {
  const { home, cleanup } = makeHome();
  try {
    const held = M.acquireSweepLock(home, { fs });
    assert.ok(held, 'first sweep lock must succeed');
    assert.strictEqual(M.acquireSweepLock(home, { fs, isAlive: () => true }), null, 'a live holder blocks overlap');
    held();
    // Pre-write a dead-holder lock -> stealable so a crashed sweep cannot wedge cron forever.
    fs.writeFileSync(M.sweepLockPath(home), JSON.stringify({ pid: 4242, ts: Date.now() }));
    const stolen = M.acquireSweepLock(home, { fs, isAlive: () => false });
    assert.ok(stolen, 'dead-holder sweep lock must be stealable');
    stolen();
  } finally { cleanup(); }
});
