'use strict';
// D11-C, defect 66c7c4e9973e — `inbox ack <id>` on a non-owned row half-acked:
// the NDJSON ack (inboxCursor.ackTo) ran UNGATED, before any ownership check,
// while the ownership check only guarded the STORE-side cursor write — a
// non-owned caller's ack therefore drained the NDJSON channel (the real
// owner never sees those rows again) while ok:true was still returned and the
// store side was silently skipped. Fixed by hoisting ownership resolution
// above BOTH ack channels and refusing the WHOLE verb on a genuine,
// resolvable ownership mismatch (a caller whose own cwd resolves to a REAL,
// DIFFERENT registered row) — scoped narrower than read-primary's own gate,
// which also refuses an unresolvable/unregistered caller; `inbox ack` does
// not, to avoid newly blocking a bare-shell/script caller with no matching
// worktree, a shape this file has always let ack.
//
// MUTATION CHECK: reverting the ownership hoist (only gating the store-side
// write again) must turn the first test below RED — `ok` would read true and
// the NDJSON cursor would have already advanced.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

// derivedId(dir) -> the meshId production derives for a REAL git worktree at
// `dir` — see devswarm-send.test.js's own copy of this helper for the full
// win32 rationale. `callerIdentityDetailed`'s 'resolved' leg (a real git
// worktree cwd) always wins over a DEVSWARM_BUILDER_ID env declaration, so
// the caller identity in a refusal is THIS derived hash, not the raw env id.
function derivedId(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ack-own-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ack-own-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}

test('inbox ack: caller registered as a DIFFERENT id refuses the WHOLE verb — neither the NDJSON nor store cursor moves', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('ackown');
  let wtA = null;
  let wtB = null;
  try {
    wtA = addLinkedWorktree(mainRepo, 'ackownA');
    wtB = addLinkedWorktree(mainRepo, 'ackownB');
    const repoKey = repokey.repoKeyForWorktree(wtA);
    const idA = 'sess-ack-a';
    const idB = 'sess-ack-b';
    seedRegistry(home, repoKey, { id: idA, worktreePath: inst.resolveWorktree(wtA), sessionId: 's-a' });

    const inboxB = path.join(home, 'inbox-b.ndjson');
    const cursorB = path.join(home, 'cursor-b.json');
    fs.writeFileSync(inboxB, 'm1\nm2\n');
    seedRegistry(home, repoKey, {
      id: idB, worktreePath: inst.resolveWorktree(wtB), sessionId: 's-b',
      inboxPath: inboxB, cursorPath: cursorB,
    });
    // register the real descriptor files too (inbox ack reads
    // readDescriptorFile for inboxPath/cursorPath, not the registry row).
    cli.run(['register', idB, '--worktree', wtB, '--session', 's-b', '--inbox', inboxB, '--cursor', cursorB],
      ctx(home, { cwd: wtB }));

    // Caller runs as A (its own cwd), tries to ack B's row.
    const r = cli.run(['inbox', 'ack', idB], ctx(home, { cwd: wtA, env: { DEVSWARM_BUILDER_ID: idA } }));
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.result.ok, false, 'the WHOLE verb must refuse, not just the store side');
    assert.strictEqual(r.result.reason, 'ownership-mismatch');
    assert.match(r.result.error, /^inbox ack refused \(ownership-mismatch\)/);
    assert.deepStrictEqual(r.result.identity, { id: derivedId(wtA), kind: 'resolved' });

    // NDJSON side must NOT have advanced — this is the exact half-ack this
    // defect describes: pre-fix, this file's cursor would already read 2.
    assert.strictEqual(fs.readFileSync(cursorB, 'utf8').trim(), '0');

    // The store side must not have moved either.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { assert.strictEqual(s.cursorValue(idB), 0); } finally { s.close(); }
  } finally {
    rm(home);
    if (wtA) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', wtA]);
    if (wtB) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', wtB]);
    rm(mainRepo);
  }
});

test('inbox ack: the owner acking its own row is unaffected by the hoisted gate', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('ackownself');
  let wtA = null;
  try {
    wtA = addLinkedWorktree(mainRepo, 'ackownselfA');
    const idA = 'sess-ack-self';
    const inboxA = path.join(home, 'inbox-self.ndjson');
    const cursorA = path.join(home, 'cursor-self.json');
    fs.writeFileSync(inboxA, 'm1\nm2\n');
    cli.run(['register', idA, '--worktree', wtA, '--session', 's-a', '--inbox', inboxA, '--cursor', cursorA],
      ctx(home, { cwd: wtA }));

    const r = cli.run(['inbox', 'ack', idA], ctx(home, { cwd: wtA, env: { DEVSWARM_BUILDER_ID: idA } }));
    assert.strictEqual(r.result.ok, true, 'the row owner must still be able to ack its own row');
    assert.strictEqual(r.result.cursor, 2);
  } finally {
    rm(home);
    if (wtA) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', wtA]);
    rm(mainRepo);
  }
});

test('inbox ack: --ack-as-owner still overrides a genuine cross-workspace mismatch', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('ackownoverride');
  let wtA = null;
  let wtB = null;
  try {
    wtA = addLinkedWorktree(mainRepo, 'ackownoverrideA');
    wtB = addLinkedWorktree(mainRepo, 'ackownoverrideB');
    const idA = 'sess-ack-oa';
    const idB = 'sess-ack-ob';
    cli.run(['register', idA, '--worktree', wtA, '--session', 's-a'], ctx(home, { cwd: wtA }));

    const inboxB = path.join(home, 'inbox-ob.ndjson');
    const cursorB = path.join(home, 'cursor-ob.json');
    fs.writeFileSync(inboxB, 'm1\n');
    cli.run(['register', idB, '--worktree', wtB, '--session', 's-b', '--inbox', inboxB, '--cursor', cursorB],
      ctx(home, { cwd: wtB }));

    const r = cli.run(['inbox', 'ack', idB, '--ack-as-owner'], ctx(home, { cwd: wtA, env: { DEVSWARM_BUILDER_ID: idA } }));
    assert.strictEqual(r.result.ok, true, '--ack-as-owner must still override');
    assert.strictEqual(r.result.cursor, 1);
  } finally {
    rm(home);
    if (wtA) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', wtA]);
    if (wtB) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', wtB]);
    rm(mainRepo);
  }
});
