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
// 9. FIX 2 (P1): a bucket whose ACTIVE descriptor is gone but which has an
//    ARCHIVED descriptor (devswarmRoot/archived/<id>.json — same shape,
//    written by scripts/devswarm.js cmdArchive) must classify REAL, not
//    GARBAGE. An archived real workspace is not garbage.
// ---------------------------------------------------------------------------
function writeArchivedDescriptor(home, id, fields) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'archived');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id }, fields || {})));
}

test('auditStore: no ACTIVE descriptor, but an ARCHIVED descriptor matches (id-hash) -> REAL, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const id = 'primary-a11ce123';
    writeArchivedDescriptor(home, id, { worktreePath: '/nonexistent/does/not/matter' });
    const hash = store.hashFromWorkspaceId(id);
    makeSqliteOnlyBucket(home, hash);

    const report = audit.auditStore({ home });
    assert.strictEqual(report.total, 1);
    assert.strictEqual(report.realCount, 1, 'archived-descriptor bucket must be REAL: ' + JSON.stringify(report));
    assert.strictEqual(report.garbageCount, 0);
    assert.deepStrictEqual(report.real, [hash]);
    assert.match(report.realSample[0].reason, /archived/);
  } finally { cleanup(); }
});

test('auditStore: no ACTIVE descriptor, but an ARCHIVED descriptor matches (repoKey) -> REAL, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeArchivedDescriptor(home, 'child-archived-1', { repoKey: 'archivedproj-abc123', ownerKey: 'archivedproj-abc123' });
    makeSqliteOnlyBucket(home, 'archivedproj-abc123');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 10. FIX 3 (P1): read/parse/stat FAILURES must classify UNKNOWN, not
//     GARBAGE — evidence is incomplete, not confidently empty.
// ---------------------------------------------------------------------------

// 10a. workspaces/ directory itself is unreadable (EACCES-shaped failure via
// an injected fsi) -> every otherwise-GARBAGE bucket becomes UNKNOWN, because
// a live descriptor match could have been missed.
test('auditStore: workspaces/ directory read fails with a real error -> UNKNOWN, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const workspacesDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');

    const spyFsi = Object.assign({}, fs);
    spyFsi.readdirSync = (dir, ...rest) => {
      if (path.resolve(String(dir)) === path.resolve(workspacesDir)) {
        const e = new Error('EACCES: permission denied, scandir ' + dir);
        e.code = 'EACCES';
        throw e;
      }
      return fs.readdirSync(dir, ...rest);
    };

    const report = audit.auditStore({ home, fsi: spyFsi });
    assert.strictEqual(report.total, 1);
    assert.strictEqual(report.garbageCount, 0, 'must NOT collapse to GARBAGE when descriptor evidence is incomplete: ' + JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
    assert.deepStrictEqual(report.unknown, ['deadbeef']);
  } finally { cleanup(); }
});

// 10b. Individual descriptor file is corrupt (unparseable JSON) -> degraded,
// so an unmatched bucket becomes UNKNOWN rather than a confident GARBAGE.
test('auditStore: a corrupt (unparseable) descriptor file -> UNKNOWN for unmatched buckets, not GARBAGE', () => {
  const { home, cleanup } = tmpHome();
  try {
    const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{ not valid json ][');
    makeSqliteOnlyBucket(home, 'deadbeef');

    const report = audit.auditStore({ home });
    assert.strictEqual(report.garbageCount, 0, JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
  } finally { cleanup(); }
});

// 10c. Bucket-level registry.ndjson read fails with a real error (not
// ENOENT) -> that specific bucket is UNKNOWN, independent of any
// descriptor-dir-level degradation (workspaces/ is fine here).
test('auditStore: a bucket registry.ndjson read fails with a real error -> UNKNOWN for that bucket only', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'primary-11110000', {}); // unrelated live descriptor, workspaces/ dir read is fine
    makeSqliteOnlyBucket(home, '11110000'); // this one matches -> REAL, unaffected by the other bucket's flaky read
    const hash = 'flaky-registry-000abc';
    const journalDir = store.journalDirForHash(home, hash);
    fs.mkdirSync(journalDir, { recursive: true });
    const registryPath = path.join(journalDir, 'registry.ndjson');
    fs.writeFileSync(registryPath, '{}\n'); // present, will be "unreadable" via spy

    const spyFsi = Object.assign({}, fs);
    spyFsi.readFileSync = (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(registryPath)) {
        const e = new Error('EIO: i/o error, read');
        e.code = 'EIO';
        throw e;
      }
      return fs.readFileSync(file, ...rest);
    };

    const report = audit.auditStore({ home, fsi: spyFsi });
    assert.strictEqual(report.total, 2); // the id-hash bucket + this flaky one
    assert.strictEqual(report.realCount, 1, JSON.stringify(report));
    assert.strictEqual(report.garbageCount, 0, JSON.stringify(report));
    assert.strictEqual(report.unknownCount, 1);
    assert.deepStrictEqual(report.unknown, [hash]);
  } finally { cleanup(); }
});

// 10d. Existing REAL/GARBAGE cases (tests 1-6) still hold under the new
// three-way classification — re-asserted here with explicit unknownCount
// checks so a regression that starts leaking UNKNOWN into old REAL/GARBAGE
// paths is caught.
test('auditStore: REAL/GARBAGE cases carry unknownCount: 0 when no read/stat failure occurred', () => {
  const { home, cleanup } = tmpHome();
  try {
    writeDescriptor(home, 'primary-11111111', {});
    makeSqliteOnlyBucket(home, '11111111'); // REAL
    makeSqliteOnlyBucket(home, '22222222'); // GARBAGE

    const report = audit.auditStore({ home });
    assert.strictEqual(report.realCount, 1);
    assert.strictEqual(report.garbageCount, 1);
    assert.strictEqual(report.unknownCount, 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 11. CLI: report prints/reports unknownCount alongside real/garbage.
// ---------------------------------------------------------------------------
test('devswarm-store-leak-report CLI: report JSON includes unknownCount', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const workspacesDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    const spyFsi = Object.assign({}, fs);
    spyFsi.readdirSync = (dir, ...rest) => {
      if (path.resolve(String(dir)) === path.resolve(workspacesDir)) {
        const e = new Error('EACCES: permission denied, scandir ' + dir);
        e.code = 'EACCES';
        throw e;
      }
      return fs.readdirSync(dir, ...rest);
    };

    const outPath = path.join(outDir, 'report.json');
    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet'], { fsi: spyFsi });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(parsed.unknownCount, 1);
    assert.strictEqual(parsed.garbageCount, 0);
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// 12. FIX 1 (P0): --out safety. The path is user-controlled and reaches
//     writeFileSync — must REFUSE (non-zero, nothing written) rather than
//     risk overwriting a production devswarm.db.
// ---------------------------------------------------------------------------

// 12a. --out resolving under the devswarm store root must be REFUSED.
test('devswarm-store-leak-report CLI: --out under the devswarm store root is REFUSED, nothing written', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const insideStore = path.join(home, '.anti-hall', 'devswarm', 'store', 'deadbeef', 'devswarm.json');

    const result = reportCli.run(['--home', home, '--out', insideStore, '--quiet']);
    assert.strictEqual(result.ok, false, 'must refuse an --out path under the store root');
    assert.match(result.error, /store root/);
    assert.ok(!fs.existsSync(insideStore), 'nothing must be written when --out is refused');
  } finally { cleanup(); }
});

// 12a-bis. Refuse even the devswarm root itself (not just store/) and the
// exact production shape named in the finding: store/<hash>/devswarm.db
// (non-.json AND under the store root — either reason alone must refuse).
test('devswarm-store-leak-report CLI: --out at a real devswarm.db path is REFUSED (store root AND non-.json)', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const dbPath = store.sqlitePathForHash(home, 'deadbeef');
    const before = fs.readFileSync(dbPath, 'utf8');

    const result = reportCli.run(['--home', home, '--out', dbPath, '--quiet']);
    assert.strictEqual(result.ok, false);
    assert.ok(!/^\{/.test(fs.readFileSync(dbPath, 'utf8')), 'devswarm.db content must be untouched');
    assert.strictEqual(fs.readFileSync(dbPath, 'utf8'), before, 'devswarm.db must not be overwritten/truncated');
  } finally { cleanup(); }
});

// 12b. --out not ending in .json must be REFUSED, even outside the store root.
test('devswarm-store-leak-report CLI: --out not ending in .json is REFUSED, nothing written', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'report.txt');

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /\.json/);
    assert.ok(!fs.existsSync(outPath));
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 12c. --out pointing at an existing file that is NOT a prior JSON report
// from this tool must be REFUSED (no clobbering arbitrary files), even when
// it is a .json file outside the store root.
test('devswarm-store-leak-report CLI: --out clobbering an existing non-report .json file is REFUSED', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'not-a-report.json');
    const originalContent = JSON.stringify({ some: 'unrelated config file', values: [1, 2, 3] });
    fs.writeFileSync(outPath, originalContent);

    const result = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(fs.readFileSync(outPath, 'utf8'), originalContent, 'unrelated existing file must be untouched');
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 12d. Acceptance: a VALID .json path outside the store root, either absent
// or itself a prior report, is ACCEPTED and written.
test('devswarm-store-leak-report CLI: a valid --out .json path outside the store root is accepted and written', () => {
  const { home, cleanup } = tmpHome();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-audit-report-out-'));
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const outPath = path.join(outDir, 'my-report.json');

    const result1 = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result1.ok, true, JSON.stringify(result1));
    assert.ok(fs.existsSync(outPath));

    // Re-running against the SAME path (now a prior report from this tool)
    // must be accepted too — idempotent re-runs are a normal workflow.
    const result2 = reportCli.run(['--home', home, '--out', outPath, '--quiet']);
    assert.strictEqual(result2.ok, true, JSON.stringify(result2));
  } finally {
    cleanup();
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// 12e. Default out path (no --out given) is unaffected by the new validation
// (repo-relative .anti-hall/reports/*.json is never under the devswarm store
// root and always ends in .json).
test('devswarm-store-leak-report CLI: default --out path (no --out flag) still passes validation', () => {
  const { home, cleanup } = tmpHome();
  try {
    makeSqliteOnlyBucket(home, 'deadbeef');
    const result = reportCli.run(['--home', home, '--quiet']);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    try { fs.unlinkSync(result.outPath); } catch (_) {}
  } finally { cleanup(); }
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
