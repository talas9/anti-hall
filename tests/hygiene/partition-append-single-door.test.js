'use strict';
// Hygiene: every row written into a partition goes through ONE door —
// scripts/devswarm.js appendIntoPartition (the destination's per-id lock — held
// by this process, VERIFIED, or acquired — plus a "destination still registered
// here" recheck; busy/gone -> PENDING) — or through a writer on the allowlist
// below. An allowlist entry is not an assertion: each one names the test file
// that PROVES its claim with a `proves: <file>#<function>` marker (measured with
// tests/helpers/partition-lock-probe.js). A new direct appendMeshMessage /
// appendMeshRow / appendMessage call site fails this test until it is routed
// through the helper or given a proven entry here.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const PLUGIN = 'plugins/anti-hall/';
const PROOFS = 'tests/scripts/devswarm-partition-lock-proofs.test.js';

// file -> { function (or '*'): { claim, proof: [test files] } }
const ALLOWED = {
  'plugins/anti-hall/scripts/devswarm.js': {
    appendIntoPartition: { claim: 'THE door itself', proof: ['tests/scripts/devswarm-partition-append.test.js', PROOFS] },
    cmdSend: { claim: 'writes the recipient partition only under its lock', proof: [PROOFS] },
    cmdArchiveRequest: { claim: 'writes the child partition only under its lock', proof: [PROOFS] },
    cmdHeartbeat: { claim: 'writes ONLY the shared broadcast partition', proof: [PROOFS] },
    cmdMergeVerb: { claim: 'writes ONLY the shared broadcast partition', proof: [PROOFS] },
  },
  'plugins/anti-hall/companion/lib/devswarm-store.js': {
    '*': { claim: 'the store API itself writes exactly where it is told', proof: [PROOFS] },
  },
  'plugins/anti-hall/companion/devswarm-migrate.js': {
    '*': { claim: 'one-time migration: same-id copy — rows land in the partition they came from', proof: ['tests/companion/devswarm-migrate.test.js', 'tests/companion/devswarm-migrate-repokey.test.js'] },
  },
};
const CALL = /\b(appendMeshMessage|appendMeshRow|appendMessage)\s*\(/;

function productionFiles() {
  const r = cp.spawnSync('git', ['ls-files', '-co', '--exclude-standard', PLUGIN], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'git ls-files failed: ' + r.stderr);
  return r.stdout.split('\n').filter((f) => f.endsWith('.js') && fs.existsSync(path.join(REPO, f)));
}

test('no direct partition write outside appendIntoPartition or a PROVEN allowlist entry', () => {
  const v = [];
  for (const f of productionFiles()) {
    const lines = fs.readFileSync(path.join(REPO, f), 'utf8').split('\n');
    let fn = null;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      const m = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(t);
      if (m) fn = m[1];
      if (/^\s*(\/\/|\*|\/\*)/.test(t) || !CALL.test(t)) continue;
      const allow = ALLOWED[f];
      if (allow && (allow['*'] || (fn && allow[fn]))) continue;
      v.push(f + ':' + (i + 1) + ' in ' + (fn || '<top>') + ': ' + t.trim().slice(0, 110));
    }
  }
  assert.deepStrictEqual(v, [], 'route these through appendIntoPartition (or add an allowlist entry WITH a proof test)');
});

test('every allowlist entry is PROVEN by a named test carrying its `proves:` marker', () => {
  const missing = [];
  for (const [file, fns] of Object.entries(ALLOWED)) {
    for (const [fn, e] of Object.entries(fns)) {
      assert.ok(Array.isArray(e.proof) && e.proof.length, file + '#' + fn + ' names no proof test');
      const marker = 'proves: ' + file + '#' + fn;
      for (const p of e.proof) {
        let src = '';
        try { src = fs.readFileSync(path.join(REPO, p), 'utf8'); } catch (_) { src = ''; }
        if (!src.includes(marker)) missing.push(p + ' lacks "' + marker + '"');
      }
    }
  }
  assert.deepStrictEqual(missing, []);
  // The ingest writer goes through the door (see below) AND runs behind the
  // delivery WAL (fsynced before ingestPayload, replayed until closed), so a
  // door refusal (busy/gone) leaves the batch pending instead of dropping it.
  const ingest = fs.readFileSync(path.join(REPO, 'plugins/anti-hall/companion/devswarm-ingest.js'), 'utf8');
  assert.match(ingest, /require\('\.\/lib\/devswarm-read-wal\.js'\)/, 'ingest must load the delivery WAL');
  assert.match(ingest, /readWal\.closeBatch\(/, 'ingest must close WAL batches only after ingestPayload');
});

test('appendIntoPartition: verified lock (never a caller claim), registration recheck, archived only on request', () => {
  const src = fs.readFileSync(path.join(REPO, 'plugins/anti-hall/scripts/devswarm.js'), 'utf8');
  const at = src.indexOf('function appendIntoPartition(');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /withIdLockHeld\(dest, home,/);
  assert.match(body, /listRegistry\(\)/);
  assert.match(body, /status: 'gone'/);
  assert.match(body, /status: 'busy'/);
  assert.match(body, /o\.allowArchivedDest && isArchivedOnlyWorkspace\(home, dest\)/);
  assert.doesNotMatch(src, /alreadyLocked|survivorLocked/, 'no caller-claimed lock opt-out exists');
  // Every cross-partition mover routes through it.
  for (const [file, fn] of [
    ['plugins/anti-hall/scripts/devswarm.js', 'forwardArchivedOrphanUnread'],
    ['plugins/anti-hall/scripts/devswarm.js', 'foldGroupIntoSurvivor'],
    ['plugins/anti-hall/scripts/devswarm.js', 'rehomeAcrossStores'],
    ['plugins/anti-hall/companion/lib/recovery.js', 'deliverEscalation'],
    ['plugins/anti-hall/companion/devswarm-ingest.js', 'ingestPayload'],
  ]) {
    const s = fs.readFileSync(path.join(REPO, file), 'utf8');
    const i = s.indexOf('function ' + fn + '(');
    assert.ok(i >= 0, fn + ' exists');
    const next = s.indexOf('\nfunction ', i + 1);
    assert.match(s.slice(i, next), /appendIntoPartition\(/, fn + ' must use appendIntoPartition');
  }
});
