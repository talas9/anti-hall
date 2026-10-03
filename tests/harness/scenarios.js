'use strict';
// tests/harness/scenarios.js — targeted, DEFECT-NAMING scenarios for the known-
// failing invariants (I2/I3/I4), added on top of the seeded op-sweep so strict
// mode is not vacuous: each function below is built to reproduce ONE specific,
// plan-cited defect and FAIL against current HEAD. tests/ only; no production
// file is modified; every crash/queue injection is an in-process monkeypatch
// via the SUT's own `io`/`ctx` injection points (never a test-only env hook
// baked into production code — see phase1-harness-spec.md §1's crash-injection
// "open decision", resolved here as pure in-process injection, no env gate).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ops = require('./ops.js');
const pullLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-pull.js'));
const cursorLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-inbox-cursor.js'));
const storeLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js'));

// ---------------------------------------------------------------------------
// Scenario 1 — I4 identity: submodule-in-linked-worktree (plan D1, phase2-
// identity-spec.md §0 D1 / §2.1). Fixture: a superproject with a submodule
// (file:// remote, protocol.file.allow=always), a LINKED worktree of the
// superproject, and the submodule initialized inside that linked worktree.
// Register from the worktree ROOT (the real production identity a child
// registers under), then compute repoKeyForWorktree from `<wt>/<sub>` (what a
// caller cd'd into the submodule resolves) and assert it equals the
// REGISTERED repoKey. Today (HEAD, no companion/lib/identity.js yet) this
// fails: repoKeyForWorktree's `.git/modules/` regex misses
// `.git/worktrees/<wt>/modules/`, so the submodule cwd hashes to a phantom
// `<submoduleBasename>-xxxxxx` key instead of the worktree's real project key.
// ---------------------------------------------------------------------------
function buildSubmoduleLinkedWorktreeFixture(tag) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-i4-submod-' + (tag || 'x') + '-'));
  const env = Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Harness', GIT_AUTHOR_EMAIL: 'harness@anti-hall.test',
    GIT_COMMITTER_NAME: 'Harness', GIT_COMMITTER_EMAIL: 'harness@anti-hall.test',
  });
  function git(args, cwd) {
    const r = cp.spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ': ' + r.stderr);
    return r;
  }
  const subDir = path.join(scratch, 'sub');
  fs.mkdirSync(subDir, { recursive: true });
  git(['init', '-q', '-b', 'main', subDir], subDir);
  fs.writeFileSync(path.join(subDir, 'README.md'), 'sub');
  git(['add', '.'], subDir);
  git(['commit', '-q', '-m', 'init'], subDir);

  const mainDir = path.join(scratch, 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  git(['init', '-q', '-b', 'main', mainDir], mainDir);
  fs.writeFileSync(path.join(mainDir, 'README.md'), 'main');
  git(['add', '.'], mainDir);
  git(['commit', '-q', '-m', 'init'], mainDir);
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', 'file://' + subDir, 'libs/sub'], mainDir);
  git(['commit', '-q', '-m', 'add submodule'], mainDir);

  const wt = path.join(scratch, 'wt');
  git(['worktree', 'add', wt, '-b', 'wtb'], mainDir);
  git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'], wt);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-i4-submod-home-' + (tag || 'x') + '-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm'), { recursive: true });

  function cleanup() {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
  }
  return { scratch, mainDir, subDir, wt, submodulePath: path.join(wt, 'libs', 'sub'), home, cleanup };
}

function scenarioI4SubmoduleInLinkedWorktree() {
  const fx = buildSubmoduleLinkedWorktreeFixture('s1');
  try {
    const readerId = 'wtreader';
    const ctx = { home: fx.home, backend: 'journal', env: { ANTIHALL_INGEST_DRY_RUN: '1' }, cwd: fx.wt, now: 1_700_000_000_000 };
    const reg = ops.cli.run([
      'register', readerId, '--worktree', fx.wt, '--session', 'sess-' + readerId,
      '--inbox', path.join(fx.home, '.anti-hall', 'devswarm', 'inbox', readerId + '.ndjson'),
      '--cursor', path.join(fx.home, '.anti-hall', 'devswarm', 'cursor', readerId + '.json'),
    ], ctx);
    if (!reg || !reg.result || !reg.result.ok) {
      return { ok: false, detail: { reason: 'register failed', result: reg && reg.result } };
    }
    const registeredRepoKey = reg.result.descriptor && reg.result.descriptor.repoKey;
    const worktreeRootKey = repokey.repoKeyForWorktree(fx.wt);
    const submoduleCwdKey = repokey.repoKeyForWorktree(fx.submodulePath);
    if (registeredRepoKey !== worktreeRootKey) {
      return {
        ok: false,
        detail: {
          reason: 'harness precondition violated: registered repoKey does not even match the worktree root key',
          registeredRepoKey, worktreeRootKey,
        },
      };
    }
    if (submoduleCwdKey !== registeredRepoKey) {
      return {
        ok: false,
        detail: {
          defect: 'I4 D1 project-context-mismatch (phase2-identity-spec.md D1)',
          reason: 'repoKeyForWorktree(<wt>/<submodule>) does not equal the registered repoKey — '
            + 'a caller inside the submodule of a linked worktree resolves to a phantom key '
            + '(devswarm-repokey.js .git/modules/ regex misses .git/worktrees/<wt>/modules/)',
          registeredRepoKey, submoduleCwdKey, worktreeRoot: fx.wt, submodulePath: fx.submodulePath,
        },
      };
    }
    return { ok: true };
  } finally {
    fx.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — I3 loss, pull crash (plan §Evidence "Delivery": devswarm-pull.js
// ~21-28, destructive native read before the durable NDJSON append). In-process
// injection ONLY: a fake native "hivecontrol" queue (io.run) that behaves like
// the real destructive message-count/read-messages pair, plus a crashing
// io.fs.appendFileSync that throws on the FIRST durable append — simulating a
// process death in the exact crash window devswarm-pull.js's own header
// documents. After 'recovery' (re-running pull with a NORMAL io), every
// message that was ever sent must be either durably delivered or still
// reported unread by the native side. Today it is neither: read-messages
// already popped it (matching real hivecontrol semantics) and the durable
// append never landed — genuine, silent loss.
// ---------------------------------------------------------------------------
function scenarioI3PullCrash() {
  const fixture = ops.makeMeshFixture(['r1'], 'i3-crash');
  try {
    const readerId = 'r1';
    ops.opRegister(fixture, readerId, 1_700_000_000_000);
    const messages = [
      { message: 'm1', fromBranch: 'sender' },
      { message: 'm2', fromBranch: 'sender' },
      { message: 'm3', fromBranch: 'sender' },
    ];
    let pending = messages.slice();
    let crashedOnce = false;
    const inboxPath = ops.inboxPath(fixture, readerId);

    const crashIo = {
      run(spec) {
        const args = (spec && spec.args) || [];
        if (args[0] === 'workspace' && args[1] === 'message-count') {
          return { ok: true, raw: String(pending.length) };
        }
        if (args[0] === 'workspace' && args[1] === 'read-messages') {
          // DESTRUCTIVE, exactly like the real native queue: pop everything now.
          const drained = pending;
          pending = [];
          return { ok: true, raw: JSON.stringify(drained) };
        }
        return { ok: false, error: 'scenarioI3PullCrash: unexpected native call ' + JSON.stringify(args) };
      },
      fs: Object.assign({}, fs, {
        appendFileSync(p, data) {
          if (!crashedOnce && p === inboxPath) {
            crashedOnce = true;
            throw new Error('SIMULATED CRASH: process died between the destructive native read and the durable NDJSON append');
          }
          return fs.appendFileSync(p, data);
        },
      }),
    };

    const ctxCrash = ops.baseCtx(fixture, readerId, 1_700_000_000_001, { io: crashIo });
    const crashResult = ops.cli.run(['inbox', 'pull', readerId], ctxCrash);

    // "Recovery": re-run pull with a NORMAL (non-crashing, real-fs) io, but the
    // SAME native queue state (pending is now empty, exactly as the real
    // native side would be after a genuinely destructive read-messages call).
    const recoveryIo = {
      run(spec) {
        const args = (spec && spec.args) || [];
        if (args[0] === 'workspace' && args[1] === 'message-count') return { ok: true, raw: String(pending.length) };
        if (args[0] === 'workspace' && args[1] === 'read-messages') { const d = pending; pending = []; return { ok: true, raw: JSON.stringify(d) }; }
        return { ok: false, error: 'unexpected native call' };
      },
    };
    const ctxRecover = ops.baseCtx(fixture, readerId, 1_700_000_000_002, { io: recoveryIo });
    ops.cli.run(['inbox', 'pull', readerId], ctxRecover);

    const durablyDelivered = cursorLib.countMessages(inboxPath, fs);
    const stillPendingNative = pending.length;
    const totalSent = messages.length;

    if (durablyDelivered + stillPendingNative !== totalSent) {
      return {
        ok: false,
        detail: {
          defect: 'I3 loss (devswarm-pull.js ~21-28 destructive-read-before-append)',
          reason: 'after a crash between the destructive native read and the durable append, followed by '
            + 'recovery (re-running pull), every message must be delivered-or-still-unread; some are neither',
          totalSent, durablyDelivered, stillPendingNative,
          crashResultOk: crashResult && crashResult.result && crashResult.result.ok,
        },
      };
    }
    return { ok: true };
  } finally {
    fixture.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 — I2/I3 cursor, one-shot transient readers (plan: 5 cursor-file
// kinds + 1 SQLite row for one "read position"; the shared/floor cursor is
// `Math.max(baseline, MIN across #inst- instance cursor files)` —
// devswarm.js instanceFloor). Simulates N distinct one-shot CLI invocations —
// the `self:<parentPid>` / `anc:<pid>:<startedAt>` headless-nonce fallback a
// transient reader (a one-off shell, a Monitor turn) gets when it has no
// stable harness ancestor — each of which reads/acks EARLY (when little mail
// exists) via a distinct injected ctx.instanceNonce, then never returns. A
// persistent "real reader" (its own stable nonce) later reads everything.
// Today the SHARED/summary unread count stays pinned at the abandoned
// one-shot readers' MIN floor instead of converging toward the real reader's
// own (0) unread.
// ---------------------------------------------------------------------------
// readThenAck(id, ctx) — the Phase 5 drain: read-only `read-primary`, then
// the explicit `ack-primary --receipt` it hands back (same reader ctx).
function readThenAck(id, ctx) {
  const r = ops.cli.run(['inbox', 'read-primary', id], ctx);
  const rid = r && r.result && r.result.readReceiptId;
  if (rid) ops.cli.run(['inbox', 'ack-primary', id, '--receipt', rid], ctx);
  return r;
}

function scenarioI2I3CursorConvergence() {
  const fixture = ops.makeMeshFixture(['r1', 'sender'], 'i2i3-cursor');
  try {
    const readerId = 'r1';
    let t = 1_700_000_000_000;
    ops.opRegister(fixture, readerId, t++);

    // One message exists before the one-shot readers show up.
    ops.opSend(fixture, 'sender', readerId, 'early-1', t++);

    // N one-shot, transient readers: each a DISTINCT injected instance nonce
    // (mirroring N distinct one-shot CLI invocations / self:<pid> fallbacks),
    // each reads-and-acks the one early message, then vanishes forever (their
    // #inst- cursor file is never advanced or GC'd again within this run).
    const N = 3;
    for (let i = 0; i < N; i++) {
      const ctxOneShot = ops.baseCtx(fixture, readerId, t++, { instanceNonce: 'oneshot-' + i + ':' + t });
      readThenAck(readerId, ctxOneShot);
    }

    // More mail arrives after the one-shot readers are gone.
    for (let i = 0; i < 4; i++) ops.opSend(fixture, 'sender', readerId, 'late-' + i, t++);

    // The REAL, persistent reader reads everything (its own stable instance).
    const ctxReal = ops.baseCtx(fixture, readerId, t++, { instanceNonce: 'real-reader-stable' });
    const realResult = readThenAck(readerId, ctxReal);

    // Shared/summary-projected unread for this workspace (store.cursorValue(id)
    // is the floor — see devswarm-store.js computeSummary's own comment: "the
    // shared cursor — a projection of the MIN across instances").
    const store = ops.storeLib.openStore({ home: fixture.home, hash: fixture.repoKey, backend: 'journal', env: { ANTIHALL_INGEST_DRY_RUN: '1' } });
    let sharedUnread;
    try {
      const summary = ops.storeLib.computeSummary(store, { home: fixture.home, env: { ANTIHALL_INGEST_DRY_RUN: '1' }, now: t });
      sharedUnread = summary && summary.workspaces && summary.workspaces[readerId] ? summary.workspaces[readerId].unread : null;
    } finally {
      store.close();
    }

    if (sharedUnread !== 0) {
      return {
        ok: false,
        detail: {
          defect: 'I2/I3 shared cursor pinned at abandoned one-shot readers\' MIN floor (devswarm.js instanceFloor)',
          reason: 'the real, persistent reader has acked every message, but the shared/summary unread count '
            + 'stays pinned above 0 because N transient one-shot instance cursors were never raised past their '
            + 'first (early, partial) read',
          sharedUnread, oneShotReaders: N, realReaderAckOk: realResult && realResult.result && realResult.result.ok,
        },
      };
    }
    return { ok: true };
  } finally {
    fixture.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Scenario — I5 row state (mesh redesign Phase 4). The seeded sweep rarely
// archives (archive is terminal and weighted late), so this drives the one
// transition I5 exists for: register two readers, send, archive ONE through the
// real `archive` verb. Every archive source and the row-state reducer must
// agree for BOTH readers at every step — the archived reader reads archived on
// every surface, its sibling reads active on every surface. A vacuity guard
// asserts the tracker actually scored the archived reader as tombstoned.
// ---------------------------------------------------------------------------
function scenarioI5ArchiveAgreement(inv) {
  const fixture = ops.makeMeshFixture(['r1', 'r2'], 'i5-archive');
  const env = { ANTIHALL_INGEST_DRY_RUN: '1' };
  try {
    let t = 1_700_000_000_000;
    const i5 = inv.createI5Tracker();
    const failures = [];
    const checkAll = (step) => {
      for (const id of ['r1', 'r2']) {
        const r = i5.check(fixture, id, env);
        if (!r.ok) failures.push({ step, id, detail: r.detail });
      }
    };
    ops.opRegister(fixture, 'r1', t++);
    ops.opRegister(fixture, 'r2', t++);
    checkAll('registered');
    ops.opSend(fixture, 'r2', 'r1', 'before-archive', t++);
    checkAll('sent');
    const arch = ops.opArchive(fixture, 'r1', t++);
    if (!(arch && arch.result && arch.result.ok && arch.result.descriptorArchived)) {
      return { ok: false, detail: { reason: 'archive op did not complete', result: arch && arch.result } };
    }
    checkAll('archived');
    const after = i5.check(fixture, 'r1', env);
    if (!(after.detail && after.detail.registryTombstoned && after.detail.status === 'archived')) {
      return { ok: false, detail: { reason: 'vacuity: the archived reader was not scored archived', after } };
    }
    const sibling = i5.check(fixture, 'r2', env);
    if (!(sibling.detail && sibling.detail.status === 'active')) {
      return { ok: false, detail: { reason: 'the un-archived sibling must stay active', sibling } };
    }
    return failures.length ? { ok: false, detail: failures } : { ok: true };
  } finally {
    fixture.cleanup();
  }
}

module.exports = {
  scenarioI5ArchiveAgreement,
  buildSubmoduleLinkedWorktreeFixture,
  scenarioI4SubmoduleInLinkedWorktree,
  scenarioI3PullCrash,
  scenarioI2I3CursorConvergence,
};
