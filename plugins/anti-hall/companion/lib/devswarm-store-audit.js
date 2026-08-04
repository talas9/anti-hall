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
//             descriptor.ownerKey), OR by an ARCHIVED workspace descriptor
//             (~/.anti-hall/devswarm/archived/*.json — same match keys; a
//             workspace that was just archived is retained there and is NOT
//             garbage), OR its journal/registry.ndjson (when present) names a
//             worktreePath that still exists on disk today.
//   UNKNOWN — no REAL signal was found, but classification is not confident:
//             either the workspaces/ or archived/ descriptor directory failed
//             to read/parse at least one entry (so a live/archived match could
//             have been missed), or this bucket's own registry.ndjson read or
//             a candidate worktree stat failed with a real error (not a
//             legitimate "does not exist"). Evidence is incomplete, so the
//             bucket is reported, not silently folded into GARBAGE.
//   GARBAGE — neither REAL signal is present AND no read/stat failure
//             degraded the evidence. In practice this is the same thing as
//             "temp-dir-shaped key with no real worktree": a test fixture
//             worktree lives under an OS temp dir the test itself deletes on
//             cleanup, so by the time this audit runs, a leaked test bucket's
//             worktreePath (if it had one at all) no longer resolves, and it
//             was never a real (or archived) descriptor's key either.
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

// archivedDir(home) — mirrors scripts/devswarm.js's archivedDir(): where
// cmdArchive hardlinks a workspace descriptor when it is archived
// (devswarmRoot/archived/<id>.json, same shape as the active descriptor:
// id, repoKey, ownerKey, worktreePath). A resolvable descriptor here means
// the workspace is an ARCHIVED real workspace, not garbage.
function archivedDir(home) {
  return path.join(devswarmRoot(home), 'archived');
}

// isMissingErr(e) -> true only for "legitimately does not exist" (ENOENT).
// Any OTHER error (EACCES, EIO, a directory where a file was expected, …) is
// a genuine read failure that must NOT be silently treated the same as
// "nothing to see here" — see readDescriptorsFrom / worktreePathsFromRegistry.
function isMissingErr(e) {
  return !!(e && e.code === 'ENOENT');
}

// readDescriptorsFrom(dir, fsi) -> { list, degraded }.
//   list     — parsed descriptor objects found in dir (malformed/unreadable
//              individual files are skipped from the list, same as before).
//   degraded — true when SOME read/parse in this directory failed for a
//              reason other than "dir/file legitimately absent": either the
//              directory read itself failed with a non-ENOENT error, or an
//              individual *.json file failed to read or JSON.parse. A
//              degraded read means the resulting `list` may be missing a
//              descriptor that really exists — callers must NOT treat an
//              unmatched bucket as confidently GARBAGE when this is true.
function readDescriptorsFrom(dir, fsi) {
  const F = fsi || fs;
  let names = [];
  try { names = F.readdirSync(dir); }
  catch (e) {
    if (isMissingErr(e)) return { list: [], degraded: false };
    return { list: [], degraded: true };
  }
  const out = [];
  let degraded = false;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = F.readFileSync(path.join(dir, name), 'utf8');
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        // A descriptor that parses but carries NONE of the matchable keys
        // (id/repoKey/ownerKey) contributes zero entries to liveKeys — it is
        // ambiguous evidence (we can't rule out that it's a real descriptor
        // in some form this reader doesn't recognize), not a confident
        // absence. Still counted in descriptorCount, but degrades the read
        // so an otherwise-unmatched bucket falls to UNKNOWN, not GARBAGE.
        const hasMatchableKey = d.id != null || !!d.repoKey || !!d.ownerKey;
        out.push(d);
        if (!hasMatchableKey) degraded = true;
      } else {
        degraded = true; // parsed but not a descriptor-shaped object
      }
    } catch (_) { degraded = true; }
  }
  return { list: out, degraded };
}

// readDescriptors(home, fsi) -> { list, degraded } of active workspace
// descriptors (~/.anti-hall/devswarm/workspaces/*.json).
function readDescriptors(home, fsi) {
  return readDescriptorsFrom(workspacesDir(home), fsi);
}

// readArchivedDescriptors(home, fsi) -> { list, degraded } of ARCHIVED
// workspace descriptors (~/.anti-hall/devswarm/archived/*.json). Same shape
// and same fail-open-with-degraded-flag contract as readDescriptors.
function readArchivedDescriptors(home, fsi) {
  return readDescriptorsFrom(archivedDir(home), fsi);
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

// worktreePathsFromRegistry(home, bucketHash, fsi) -> { paths, degraded }.
//   paths    — Set<string> of distinct worktreePath values named in this
//              bucket's journal/registry.ndjson, if present. A plain
//              text/JSON-lines read — never opens the sqlite db.
//   degraded — true when the registry file EXISTS but failed to read with a
//              real error (not ENOENT), OR at least one non-empty line in it
//              failed to JSON.parse. An absent file (sqlite-backend bucket,
//              or a journal bucket with no registry writes yet) is the
//              legitimate "no evidence" case: empty paths, degraded false. A
//              malformed line IS treated as degraded — ambiguous/unreadable
//              evidence must never be silently dropped and must never let a
//              bucket fall to a confident GARBAGE it hasn't earned.
function worktreePathsFromRegistry(home, bucketHash, fsi) {
  const F = fsi || fs;
  const registryPath = path.join(store.journalDirForHash(home, bucketHash), 'registry.ndjson');
  let raw;
  try { raw = F.readFileSync(registryPath, 'utf8'); }
  catch (e) {
    if (isMissingErr(e)) return { paths: new Set(), degraded: false };
    return { paths: new Set(), degraded: true };
  }
  const paths = new Set();
  let degraded = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        // A legitimate row without worktreePath (e.g. an `_op: 'remove'`
        // tombstone — see devswarm-store.js's append()) carries no worktree
        // evidence but is NOT malformed; silently contributing nothing to
        // `paths` is correct for it.
        if (row.worktreePath) paths.add(String(row.worktreePath));
      } else {
        // Parsed successfully but is not a usable row object (null / array /
        // a bare primitive) — semantically malformed evidence, not the
        // legitimate "no worktreePath" case above. Treating this the same as
        // a clean absence would let ambiguous evidence silently degrade a
        // bucket straight to a confident GARBAGE it hasn't earned.
        degraded = true;
      }
    } catch (_) { degraded = true; }
  }
  return { paths, degraded };
}

// classifyBucket(bucketHash, home, liveKeys, archivedKeys, fsi)
//   -> { hash, class: 'REAL'|'UNKNOWN'|'GARBAGE', reason, resolvedWorktree? }
function classifyBucket(bucketHash, home, liveKeys, archivedKeys, fsi) {
  const F = fsi || fs;
  if (liveKeys.has(bucketHash)) {
    return { hash: bucketHash, class: 'REAL', reason: 'matches a live workspace descriptor (id-hash/repoKey/ownerKey)' };
  }
  if (archivedKeys && archivedKeys.has(bucketHash)) {
    return {
      hash: bucketHash,
      class: 'REAL',
      reason: 'matches an archived workspace descriptor (id-hash/repoKey/ownerKey) — an archived real workspace is not garbage',
    };
  }
  const registryResult = worktreePathsFromRegistry(home, bucketHash, F);
  const candidates = Array.from(registryResult.paths);
  let statDegraded = false;
  const resolvable = candidates.filter((p) => {
    try { return F.statSync(p).isDirectory(); }
    catch (e) {
      if (!isMissingErr(e)) statDegraded = true;
      return false;
    }
  });
  if (resolvable.length > 0) {
    return { hash: bucketHash, class: 'REAL', reason: 'registry names a worktreePath that still resolves on disk', resolvedWorktree: resolvable[0] };
  }
  if (registryResult.degraded || statDegraded) {
    return {
      hash: bucketHash,
      class: 'UNKNOWN',
      reason: 'no live/archived descriptor match, but reading this bucket\'s registry.ndjson or stat-ing a candidate worktree failed with a real error — evidence incomplete, not confidently garbage',
    };
  }
  const hadCandidates = candidates.length > 0;
  return {
    hash: bucketHash,
    class: 'GARBAGE',
    reason: hadCandidates
      ? 'no live/archived descriptor match, and every registry-named worktreePath is gone (temp-dir-shaped, already cleaned up)'
      : 'no live/archived descriptor match, and no registry/worktree evidence at all (sqlite-only bucket or empty journal)',
  };
}

// auditStore({ home, fsi }) -> {
//   total, garbageCount, realCount, unknownCount,
//   garbageSample: [...up to 20], realSample: [...up to 20], unknownSample: [...up to 20],
//   garbage: [...all hashes], real: [...all hashes], unknown: [...all hashes],
// }
// Pure read: enumerates store/ via devswarm-store.js's own listStoreHashes
// (never opens a bucket's db), cross-references active + archived
// descriptors, classifies each bucket REAL / UNKNOWN / GARBAGE. If reading
// either descriptor directory was degraded (a read/parse failure, not a
// legitimate absence), a bucket that would otherwise classify GARBAGE is
// downgraded to UNKNOWN — a degraded read means a real/archived match could
// have been missed, so "no match found" is no longer confident evidence.
function auditStore(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = o.fsi || fs;

  const descResult = readDescriptors(home, F);
  const archivedResult = readArchivedDescriptors(home, F);
  const liveKeys = liveKeysFromDescriptors(descResult.list);
  const archivedKeys = liveKeysFromDescriptors(archivedResult.list);
  const descriptorReadDegraded = !!descResult.degraded || !!archivedResult.degraded;
  // store.listStoreHashes() fail-opens to [] on ANY readdirSync error
  // (by design — doctor/migration callers want a harmless empty list on a
  // fresh/never-used home). That silent [] is indistinguishable from "store/
  // legitimately doesn't exist yet" vs "store/ exists but couldn't be read"
  // (EACCES/EIO/etc) — the latter must NOT collapse into a misleading
  // zero-bucket report. Probe the same directory ourselves (same fsi, so a
  // spy that fails consistently fails identically here) to tell them apart.
  let storeEnumerationError = null;
  try { F.readdirSync(store.storeRootDir(home)); }
  catch (e) {
    if (!isMissingErr(e)) storeEnumerationError = (e && e.message) || String(e);
  }
  const hashes = store.listStoreHashes(home, F);

  const garbage = [];
  const real = [];
  const unknown = [];
  const details = [];
  for (const hash of hashes) {
    let result = classifyBucket(hash, home, liveKeys, archivedKeys, F);
    if (descriptorReadDegraded && result.class === 'GARBAGE') {
      result = {
        hash,
        class: 'UNKNOWN',
        reason: 'descriptor/archived-descriptor directory read was degraded (a read/parse failure occurred) — cannot confidently rule out a missed match: ' + result.reason,
      };
    }
    details.push(result);
    if (result.class === 'GARBAGE') garbage.push(hash);
    else if (result.class === 'UNKNOWN') unknown.push(hash);
    else real.push(hash);
  }

  const SAMPLE_CAP = 20;
  return {
    home,
    total: hashes.length,
    descriptorCount: descResult.list.length,
    archivedDescriptorCount: archivedResult.list.length,
    garbageCount: garbage.length,
    realCount: real.length,
    unknownCount: unknown.length,
    garbage,
    real,
    unknown,
    garbageSample: details.filter((d) => d.class === 'GARBAGE').slice(0, SAMPLE_CAP),
    realSample: details.filter((d) => d.class === 'REAL').slice(0, SAMPLE_CAP),
    unknownSample: details.filter((d) => d.class === 'UNKNOWN').slice(0, SAMPLE_CAP),
    // null when store/ enumerated cleanly (including the legitimate "doesn't
    // exist yet" case); a message string when the enumeration itself failed
    // with a real error — a caller must treat total:0 alongside this as
    // "unknown", never as a confident "no leaked buckets".
    storeEnumerationError,
  };
}

module.exports = {
  auditStore,
  classifyBucket,
  readDescriptors,
  readArchivedDescriptors,
  liveKeysFromDescriptors,
  worktreePathsFromRegistry,
  archivedDir,
};
