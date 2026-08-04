'use strict';
// anti-hall :: devswarm-store-audit — Task #6 part (b), READ-ONLY leaked-bucket
// classifier for ~/.anti-hall/devswarm/store.
//
// WHY THIS EXISTS: part (a) of this task fixed a latent test-isolation gap (4
// doctor test files defaulted a subprocess's HOME to `undefined`, which
// os.homedir() resolves to the REAL machine home rather than isolating
// anything). Manually inspecting the real store while investigating that bug
// surfaced dozens of buckets whose repoKey slug is unmistakably test-fixture
// shaped (e.g. `anti-hall-lifecycle-repo-reconcile-real-<hex>`, repeated
// several dozen times) sitting alongside genuine production buckets. This
// module's ONLY job is to REPORT that split for a human owner to review —
// it NEVER deletes, moves, renames, or truncates anything, and it is NOT
// wired to any auto-cleanup path.
//
// STRICT READ-ONLY CONTRACT: this module NEVER opens a sqlite `devswarm.db`
// (not even read-only) and NEVER calls devswarm-store.js's openStore /
// openSqlite / openJournal — all three implicitly `fs.mkdirSync` their
// target dir and openSqlite issues WAL/pragma writes on open, which is
// exactly the kind of accidental mutation this task forbids. Every read here
// is a plain fs.readdirSync / fs.readFileSync / fs.statSync against files
// that already exist; classification of a bucket that only has a
// `devswarm.db` (no `journal/registry.ndjson` to read) rests on descriptor
// cross-reference alone, never on opening the db.
//
// CLASSIFICATION (per bucket dir under store/):
//   REAL    — the bucket key is referenced by a live workspace descriptor
//             (~/.anti-hall/devswarm/workspaces/*.json, matched by
//             hashFromWorkspaceId(descriptor.id), descriptor.repoKey, or
//             descriptor.ownerKey), OR its journal/registry.ndjson (when
//             present) names a worktreePath that still exists on disk today.
//   GARBAGE — neither signal is present. In practice this is the same thing
//             as "temp-dir-shaped key with no real worktree": a test fixture
//             worktree lives under an OS temp dir the test itself deletes on
//             cleanup, so by the time this audit runs, a leaked test bucket's
//             worktreePath (if it had one at all) no longer resolves, and it
//             was never a real descriptor's key either.
//
// Pure Node built-ins only. Every I/O point is injectable via opts (home,
// fsi) so tests can exercise this against a synthetic temp-dir store and
// NEVER the real one.

const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('./devswarm-store.js');
const { devswarmRoot } = require('./liveness.js');

function workspacesDir(home) {
  return path.join(devswarmRoot(home), 'workspaces');
}

// readDescriptors(home, fsi) -> array of parsed workspace descriptors.
// Fail-open per-file: a malformed/unreadable descriptor is skipped, never
// thrown — this is a report, not a gate.
function readDescriptors(home, fsi) {
  const F = fsi || fs;
  const dir = workspacesDir(home);
  let names = [];
  try { names = F.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = F.readFileSync(path.join(dir, name), 'utf8');
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') out.push(d);
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

// liveKeysFromDescriptors(descriptors) -> Set<string> of every store key a
// live descriptor could plausibly bucket under: its id's legacy hash, its
// repoKey, and its ownerKey (mesh descriptors carry both; a pre-mesh
// descriptor may only have the id hash).
function liveKeysFromDescriptors(descriptors) {
  const keys = new Set();
  for (const d of descriptors) {
    if (d.id != null) { try { keys.add(store.hashFromWorkspaceId(d.id)); } catch (_) {} }
    if (d.repoKey) keys.add(String(d.repoKey));
    if (d.ownerKey) keys.add(String(d.ownerKey));
  }
  return keys;
}

// worktreePathsFromRegistry(home, bucketHash, fsi) -> Set<string> of distinct
// worktreePath values named in this bucket's journal/registry.ndjson, if
// present. A plain text/JSON-lines read — never opens the sqlite db. Absent
// file (sqlite-backend bucket, or a journal bucket with no registry writes
// yet) yields an empty set, never an error.
function worktreePathsFromRegistry(home, bucketHash, fsi) {
  const F = fsi || fs;
  const registryPath = path.join(store.journalDirForHash(home, bucketHash), 'registry.ndjson');
  let raw;
  try { raw = F.readFileSync(registryPath, 'utf8'); } catch (_) { return new Set(); }
  const paths = new Set();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && row.worktreePath) paths.add(String(row.worktreePath));
    } catch (_) { /* skip malformed line */ }
  }
  return paths;
}

// classifyBucket(bucketHash, home, liveKeys, fsi) -> { hash, class, reason, worktreeCandidates }
function classifyBucket(bucketHash, home, liveKeys, fsi) {
  const F = fsi || fs;
  if (liveKeys.has(bucketHash)) {
    return { hash: bucketHash, class: 'REAL', reason: 'matches a live workspace descriptor (id-hash/repoKey/ownerKey)' };
  }
  const candidates = Array.from(worktreePathsFromRegistry(home, bucketHash, F));
  const resolvable = candidates.filter((p) => {
    try { return F.statSync(p).isDirectory(); } catch (_) { return false; }
  });
  if (resolvable.length > 0) {
    return { hash: bucketHash, class: 'REAL', reason: 'registry names a worktreePath that still resolves on disk', resolvedWorktree: resolvable[0] };
  }
  const hadCandidates = candidates.length > 0;
  return {
    hash: bucketHash,
    class: 'GARBAGE',
    reason: hadCandidates
      ? 'no live descriptor match, and every registry-named worktreePath is gone (temp-dir-shaped, already cleaned up)'
      : 'no live descriptor match, and no registry/worktree evidence at all (sqlite-only bucket or empty journal)',
  };
}

// auditStore({ home, fsi }) -> {
//   total, garbageCount, realCount,
//   garbageSample: [...up to 20], realSample: [...up to 20],
//   garbage: [...all hashes], real: [...all hashes],
// }
// Pure read: enumerates store/ via devswarm-store.js's own listStoreHashes
// (never opens a bucket's db), cross-references descriptors, classifies each.
function auditStore(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = o.fsi || fs;

  const descriptors = readDescriptors(home, F);
  const liveKeys = liveKeysFromDescriptors(descriptors);
  const hashes = store.listStoreHashes(home, F);

  const garbage = [];
  const real = [];
  const details = [];
  for (const hash of hashes) {
    const result = classifyBucket(hash, home, liveKeys, F);
    details.push(result);
    if (result.class === 'GARBAGE') garbage.push(hash); else real.push(hash);
  }

  const SAMPLE_CAP = 20;
  return {
    home,
    total: hashes.length,
    descriptorCount: descriptors.length,
    garbageCount: garbage.length,
    realCount: real.length,
    garbage,
    real,
    garbageSample: details.filter((d) => d.class === 'GARBAGE').slice(0, SAMPLE_CAP),
    realSample: details.filter((d) => d.class === 'REAL').slice(0, SAMPLE_CAP),
  };
}

module.exports = { auditStore, classifyBucket, readDescriptors, liveKeysFromDescriptors, worktreePathsFromRegistry };
