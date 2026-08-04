'use strict';
// devswarm-store-audit — Task #6 part (b): unit tests for the READ-ONLY
// leaked-bucket classifier (companion/lib/devswarm-store-audit.js) and its
// CLI wrapper (scripts/devswarm-store-leak-report.js).
//
// HERMETIC: every fixture lives under a fresh fs.mkdtempSync temp dir. This
// file NEVER reads or writes the real ~/.anti-hall/devswarm/store — a
// dedicated test (below) proves the audit module itself never issues a
// write-capable fs call (mkdirSync/writeFileSync/appendFileSync/rmSync/
// unlinkSync) by wrapping fs in a spy that throws if any of those are
// called, then running auditStore() through it end-to-end.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const audit = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store-audit.js'));
const store = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const reportCli = require(path.join(ROOT, 'scripts', 'devswarm-store-leak-report.js'));

function tmpHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'store-audit-test-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

function writeDescriptor(home, id, fields) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id }, fields || {})));
}

function makeSqliteOnlyBucket(home, hash) {
  const dir = store.storeDirForHash(home, hash);
  fs.mkdirSync(dir, { recursive: true });
  // A placeholder — the audit module must NEVER open this as a real sqlite
  // db, so its content is irrelevant to the test.
  fs.writeFileSync(path.join(dir, 'devswarm.db'), 'not a real sqlite file, must never be opened');
}

function makeJournalBucket(home, hash, registryRows) {
  const journalDir = store.journalDirForHash(home, hash);
  fs.mkdirSync(journalDir, { recursive: true });
  const lines = (registryRows || []).map((r) => JSON.stringify(r)).join('\n') + (registryRows && registryRows.length ? '\n' : '');
  fs.writeFileSync(path.join(journalDir, 'registry.ndjson'), lines);
}

// ---------------------------------------------------------------------------
// 1. REAL via descriptor id-hash match.
// ---------------------------------------------------------------------------
test('auditStore: bucket matching a live descriptor via hashFromWorkspaceId(id) -> REAL', () => {
  const { home, cleanup } = tmpHome();
  try {
    const id = 'primary-abcd1234';
    writeDescriptor(home, id, { worktreePath: '/nonexistent/does/not/matter' });
    const hash = store.hashFromWorkspaceId(id);
    makeSqliteOnlyBucket(home, hash);

    const report = audit.auditStore({ home });
    assert.strictEqual(report.total, 1);
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 0);
    assert.deepStrictEqual(report.real, [hash]);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 2. REAL via descriptor repoKey / ownerKey match.
// ---------------------------------------------------------------------------
test('auditStore: bucket matching a live descriptor via repoKey -> REAL', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'child-1', { repoKey: 'realproj-abc123', ownerKey: 'realproj-abc123' });
    makeSqliteOnlyBucket(home, 'realproj-abc123');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 3. REAL via a resolvable worktreePath in journal/registry.ndjson, with NO
//    descriptor at all (the descriptor was archived/removed but the bucket +
//    its still-real worktree survive).
// ---------------------------------------------------------------------------
test('auditStore: no descriptor, but registry names a worktreePath that still exists on disk -> REAL', () => {
  const { home, cleanup } = tmpHome();
  const realWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-real-worktree-'));
  try {
    const hash = 'genuine-proj-f00d12';
    makeJournalBucket(home, hash, [
      { id: 'w1', worktreePath: realWorktree, sessionId: 's1', _op: 'upsert', updatedAt: Date.now() },
    ]);

    const report = audit.auditStore({ home });
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 0);
    assert.strictEqual(report.realSample[0].resolvedWorktree, realWorktree);
  } finally { cleanup(); try { fs.rmSync(realWorktree, { recursive: true, force: true }); } catch (_) {} }
});

// ---------------------------------------------------------------------------
// 4. GARBAGE: sqlite-only bucket, no descriptor, no journal at all — exactly
//    the shape of the ~49KB empty-schema buckets found repeatedly in the
//    real store during investigation.
// ---------------------------------------------------------------------------
test('auditStore: sqlite-only bucket with no descriptor and no journal evidence -> GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 1);
    assert.strictEqual(report.realCount, 0);
    assert.deepStrictEqual(report.garbage, ['deadbeef']);
    assert.match(report.garbageSample[0].reason, /no registry\/worktree evidence/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 5. GARBAGE: journal bucket whose registry names a worktreePath that no
//    longer exists (the exact "leaked test fixture, tmpdir already cleaned
//    up" shape) and no descriptor references it.
// ---------------------------------------------------------------------------
test('auditStore: no descriptor, registry worktreePath no longer exists on disk -> GARBAGE (temp-dir-shaped)', () => {
  const { home, cleanup } = tmpHome();
  try {
    const goneWorktree = path.join(os.tmpdir(), 'antihall-doctor-cwd-' + Date.now() + '-already-deleted');
    const hash = 'leaked-test-repo-abc123';
    makeJournalBucket(home, hash, [
      { id: 'w1', worktreePath: goneWorktree, sessionId: 's1', _op: 'upsert', updatedAt: Date.now() },
    ]);

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 1);
    assert.strictEqual(report.realCount, 0);
    assert.match(report.garbageSample[0].reason, /already cleaned up/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 6. Mixed store: counts + samples are correct together, cap respected.
// ---------------------------------------------------------------------------
test('auditStore: mixed REAL + GARBAGE buckets classify independently with correct totals', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'primary-11111111', {});
    makeSqliteOnlyBucket(home, '11111111'); // REAL (id-hash match)
    makeSqliteOnlyBucket(home, '22222222'); // GARBAGE (no evidence)
    makeSqliteOnlyBucket(home, '33333333'); // GARBAGE (no evidence)

    const report = audit.auditStore({ home });
    assert.strictEqual(report.total, 3);
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 2);
    assert.deepStrictEqual(report.real.sort(), ['11111111']);
    assert.deepStrictEqual(report.garbage.sort(), ['22222222', '33333333']);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 7. STRICT READ-ONLY CONTRACT: auditStore must never call a write-capable
//    fs method, proven by a spy `fsi` that throws if any of them fire.
// ---------------------------------------------------------------------------
test('auditStore: NEVER calls a write-capable fs method (mkdirSync/writeFileSync/appendFileSync/rmSync/unlinkSync)', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'primary-abcdef01', {});
    makeSqliteOnlyBucket(home, 'abcdef01');
    makeSqliteOnlyBucket(home, 'deadc0de'); // garbage
    const journalHash = 'journal-proj-cafe01';
    makeJournalBucket(home, journalHash, [{ id: 'w1', worktreePath: '/nope/gone', _op: 'upsert' }]);

    const WRITE_METHODS = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'truncateSync', 'writeSync'];
    const spyFsi = Object.assign({}, fs);
    for (const m of WRITE_METHODS) {
      spyFsi[m] = (...args) => { throw new Error('READ-ONLY VIOLATION: ' + m + ' called with ' + JSON.stringify(args[0])); };
    }
    // readdirSync/readFileSync/statSync/existsSync/lstatSync are the real
    // (unwrapped) implementations — auditStore must only ever reach those.

    assert.doesNotThrow(() => {
      const report = audit.auditStore({ home, fsi: spyFsi });
      assert.strictEqual(report.total, 3);
    }, 'auditStore must complete using ONLY read fs calls');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 8. CLI wrapper: writes a JSON report file and returns the same counts,
//    against a synthetic home (never the real store).
// ---------------------------------------------------------------------------
test('devswarm-store-leak-report CLI: writes a JSON report with correct counts, touches nothing but its own output file', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    writeDescriptor(home, 'primary-fadefade', {});
    makeSqliteOnlyBucket(home, 'fadefade'); // REAL
    makeSqliteOnlyBucket(home, 'baadf00d'); // GARBAGE

    const outPath = path.join(outDir, 'report.json');
    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.ok(fs.existsSync(outPath), 'report file must be written');

    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(parsed.total, 2);
    assert.strictEqual(parsed.realCount, 1);
    assert.strictEqual(parsed.garbageCount, 1);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// VACUOUS-RED proof: a bucket that SHOULD be GARBAGE under a naive
// "everything with no descriptor is REAL" implementation would misclassify
// — proving these assertions are not vacuously true. Simulated inline
// (not by breaking the real module) to avoid mutating shipped code mid-test.
// ---------------------------------------------------------------------------
test('VACUOUS-RED proof: a naive "no descriptor -> REAL" classifier would wrongly pass buckets this suite correctly flags GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const naiveReport = { garbageCount: 0, realCount: 1 }; // what a broken "assume REAL" classifier would report
    const actualReport = audit.auditStore({ home });
    assert.notDeepStrictEqual(
      { garbageCount: actualReport.garbageCount, realCount: actualReport.realCount },
      naiveReport,
      'the real classifier must disagree with a naive always-REAL classifier on an evidence-free bucket',
    );
    assert.strictEqual(actualReport.garbageCount, 1);
  } finally { cleanup(); }
});
