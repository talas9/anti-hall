'use strict';
// anti-hall :: devswarm-orphan-policy — the ONE place that answers
// "is this orphan partition PERMANENTLY unreadable because its workspace was
// deliberately archived and no live identity-family survivor exists?"
//
// WHY THIS FILE EXISTS (field defect, 12 partitions, permanent false positive):
// computeSummary's A2 pass (devswarm-store.js) surfaced `orphans[]` = every
// partition with real unread and no live registry row, and parent-inbox rendered
// that as "⚠ DEVSWARM ORPHANED MESH: N partition(s) with unread but no live
// workspace to read them" on EVERY turn. For an ARCHIVED workspace with no live
// family, that warning is unactionable by construction: healOrphanPartitions
// (scripts/devswarm.js) classifies exactly that shape as
// `unhealable / archived-no-family` and deliberately writes NOTHING — there is no
// survivor to forward the unread into and re-adopting an archived id is forbidden
// (it would recreate the row foldArchivedRegistryRows exists to tombstone). The
// unread can therefore NEVER drain, so the id can never leave the warning set.
//
// NON-DRIFT (the whole point of this module): the classification is NOT
// re-implemented here. It CALLS scripts/devswarm.js's own exported helpers —
// hasArchivedCounterpart / readDescriptorFile / archivedDir / canonicalMeshId /
// groupRegistryByMeshId — i.e. the identical functions healOrphanPartitions'
// archived branch calls, in the identical order. If heal's family/archived policy
// changes, this changes with it because it is the SAME code. The one composition
// this file performs itself (live-descriptor-first, archived-descriptor-fallback)
// mirrors devswarm.js's private `resolveOrphanDescriptor`, which is not exported;
// tests/companion/devswarm-orphan-policy-equivalence.test.js drives BOTH this
// module and `healOrphanPartitions({dryRun:true})` over the same fixtures and
// asserts the two id sets are IDENTICAL, so even that composition cannot drift
// silently.
//
// REQUIRE DIRECTION: devswarm-store.js is required BY scripts/devswarm.js, so a
// top-level require back would close a cycle. The require here is LAZY (inside the
// classifier, on first candidate) — by then both modules are fully initialized, so
// the cycle never materializes — and it is only ever paid when a store actually
// HAS an unread orphan candidate (the exact situation the warning fires in), never
// on a healthy projection.
//
// FAIL-OPEN EVERYWHERE: any failure (module unavailable, helper missing, fs/JSON
// error) yields `false` == "not archived-stranded" == the id stays in `orphans[]`,
// i.e. EXACTLY today's behaviour. This classifier can only ever quiet a warning it
// positively proved is unactionable; it can never hide an orphan it failed to
// classify.

const fs = require('fs');
const path = require('path');
const livenessSelect = require('./devswarm-liveness-select.js');
// isForwardableRow is the ACTUAL function scripts/devswarm.js's isForwardable
// delegates to (`const { isForwardableRow } = require('../companion/lib/devswarm-noise.js')`
// there) — requiring it directly here is not a re-implementation, it is the
// identical shared helper. No cycle: devswarm-noise.js is pure/stateless.
const { isForwardableRow } = require('./devswarm-noise.js');

let devswarmMod = null;
let devswarmTried = false;
function loadDevswarm() {
  if (!devswarmTried) {
    devswarmTried = true;
    try { devswarmMod = require('../../scripts/devswarm.js'); } catch (_) { devswarmMod = null; }
  }
  return devswarmMod;
}

// resolveOrphanDescriptor mirror — live workspaces/<id>.json FIRST (via devswarm.js's
// own exported readDescriptorFile), then archived/<id>.json. Same priority and the
// same fail-closed-to-null posture as devswarm.js's private resolveOrphanDescriptor.
// Kept honest by the equivalence test named in the header.
function resolveOrphanDescriptor(M, home, id) {
  let live = null;
  try { live = M.readDescriptorFile(home, id); } catch (_) { live = null; }
  if (live) return live;
  try {
    const p = path.join(M.archivedDir(home), id + '.json');
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    return d;
  } catch (_) { return null; }
}

// makeArchivedStrandedTest(home, registry) -> (id) => boolean.
//
// Returns a CLOSURE so the per-projection work (loading devswarm.js, grouping the
// registry by canonical mesh id, canonicalizing a descriptor's worktreePath — the
// last of which can spawn `git rev-parse`) is done AT MOST ONCE per projection and
// memoized per distinct worktreePath, instead of once per candidate id.
//
// `true` means: this id is archived, its descriptor resolves, and its identity
// family has NO registry row at all — byte-for-byte the condition under which
// healOrphanPartitions records {action:'unhealable', reason:'archived-no-family'}.
function makeArchivedStrandedTest(home, registry) {
  const rows = Array.isArray(registry) ? registry : [];
  let M = null;
  let loaded = false;
  let usable = false;
  let byMesh = null;
  const meshCache = new Map();

  return function isArchivedStranded(id) {
    try {
      if (!loaded) {
        loaded = true;
        M = loadDevswarm();
        usable = !!(M
          && typeof M.hasArchivedCounterpart === 'function'
          && typeof M.readDescriptorFile === 'function'
          && typeof M.archivedDir === 'function'
          && typeof M.canonicalMeshId === 'function'
          && typeof M.groupRegistryByMeshId === 'function');
      }
      if (!usable) return false; // fail-open: nothing excluded, today's behaviour

      // 1. archived counterpart (heal: `const archived = hasArchivedCounterpart(home, id)`)
      if (!M.hasArchivedCounterpart(home, id)) return false;

      // 2. descriptor must RESOLVE. heal bails to unhealable/no-descriptor BEFORE
      //    reaching its archived branch when it does not, and that is a DIFFERENT
      //    class (a descriptor can reappear and be adopted next pass) — so a
      //    no-descriptor id deliberately stays a plain orphan here.
      const desc = resolveOrphanDescriptor(M, home, id);
      if (!desc) return false;

      // 3. identity family (heal: canonicalMeshId(desc.worktreePath) ->
      //    groupRegistryByMeshId(registry).get(key) -> `!group || !group.rows.length`)
      if (!desc.worktreePath) return true; // no family key derivable -> no group -> archived-no-family
      const wt = String(desc.worktreePath);
      let familyKey;
      if (meshCache.has(wt)) familyKey = meshCache.get(wt);
      else { familyKey = M.canonicalMeshId(wt); meshCache.set(wt, familyKey); }
      if (!familyKey) return true; // heal's `familyKey ? byMesh.get(familyKey) : null` -> null group
      if (byMesh === null) byMesh = M.groupRegistryByMeshId(rows);
      const group = byMesh.get(familyKey);
      return !group || !group.rows.length;
    } catch (_) {
      return false; // fail-open
    }
  };
}

// archivedForwardProvenancePrefixMirror(id) — MUST stay byte-identical to
// scripts/devswarm.js's private `archivedForwardProvenancePrefix(id)`
// ('[forwarded from archived ' + id + '] '), which forwardArchivedOrphanUnread
// prepends to every row it forwards. That helper is NOT exported (this file may
// not edit scripts/devswarm.js — see the worktree isolation note this change was
// made under), so unlike every other primitive in this file it cannot be called
// directly and is duplicated here as a literal. Kept honest, not by inspection,
// by tests/companion/devswarm-store-forwarded-drained.test.js's real-forward
// equivalence case: it runs the ACTUAL healOrphanPartitions({dryRun:false})
// against a fixture, lets it really forward rows using devswarm.js's own
// (private) prefix, and then asserts makeForwardedDrainedTest — using THIS
// mirrored prefix — classifies the result correctly. If the two prefixes ever
// diverge, the computed hash below stops matching the real forwarded row's
// hash and that test goes red.
function archivedForwardProvenancePrefixMirror(id) { return '[forwarded from archived ' + id + '] '; }

// makeForwardedDrainedTest(home, registry, store, meshMessageHashFn) -> (id) => boolean.
//
// Companion to makeArchivedStrandedTest, for the DIFFERENT unhealable shape B2
// targets: an archived orphan whose identity family DOES still have a live
// registry row (so makeArchivedStrandedTest returns false for it — heal would
// FORWARD, not give up), but healOrphanPartitions' forward is FORWARD-ONLY
// (scripts/devswarm.js: "the source row is always LEFT in place") and cursor
// reconciliation is MIN-only (never raises a cursor) — so once every unread row
// has actually been forwarded into the live survivor, the source partition's
// `unread` count never decrements and `orphans[]` nags about it forever with
// nothing left for a human or a heal pass to do.
//
// `true` means: archived, descriptor resolves, identity family has a live
// survivor (pickFreshestLive — the SAME selection healOrphanPartitions'
// pickSurvivor uses), AND every one of this id's CURRENTLY UNREAD rows has a
// row with the IDENTICAL hash already present in the survivor's partition —
// proof checked PER ROW BY HASH, never inferred from a count. A single unread
// row that cannot be matched (never forwarded, age-capped and skipped, or
// structurally non-forwardable) fails the whole id back to false, i.e. it
// stays in orphans[] — this can only ever move an id OUT of orphans[] on
// positive per-row proof, never on an aggregate or an assumption.
//
// meshMessageHashFn is passed in (devswarm-store.js's own meshMessageHash)
// rather than required — devswarm-store.js is this module's own caller/parent
// (see the REQUIRE DIRECTION note above), so requiring it back here would close
// a cycle; it is the SAME function reference already in scope at the one call
// site, not a re-implementation.
function makeForwardedDrainedTest(home, registry, store, meshMessageHashFn) {
  const rows = Array.isArray(registry) ? registry : [];
  let M = null;
  let loaded = false;
  let usable = false;
  let byMesh = null;
  const meshCache = new Map();
  const survivorHashCache = new Map(); // survivorId -> Set<hash>, computed at most once per projection

  function survivorHashes(survivorId) {
    if (survivorHashCache.has(survivorId)) return survivorHashCache.get(survivorId);
    let set = new Set();
    try {
      const msgs = store.listMessages(survivorId);
      for (const m of msgs) { if (m && m.hash != null) set.add(String(m.hash)); }
    } catch (_) { set = new Set(); }
    survivorHashCache.set(survivorId, set);
    return set;
  }

  return function isForwardedDrained(id) {
    try {
      if (!loaded) {
        loaded = true;
        M = loadDevswarm();
        usable = !!(M
          && typeof M.hasArchivedCounterpart === 'function'
          && typeof M.readDescriptorFile === 'function'
          && typeof M.archivedDir === 'function'
          && typeof M.canonicalMeshId === 'function'
          && typeof M.groupRegistryByMeshId === 'function'
          && typeof M.meshRowCopy === 'function')
          && typeof meshMessageHashFn === 'function'
          && store && typeof store.listMessages === 'function'
          && typeof store.cursorValue === 'function';
      }
      if (!usable) return false; // fail-open: nothing excluded, today's behaviour

      // 1. archived counterpart — same gate makeArchivedStrandedTest uses.
      if (!M.hasArchivedCounterpart(home, id)) return false;

      // 2. descriptor must resolve (no-descriptor is a different, adoptable class).
      const desc = resolveOrphanDescriptor(M, home, id);
      if (!desc || !desc.worktreePath) return false;

      // 3. identity family MUST have a live registry row — the opposite gate from
      //    makeArchivedStrandedTest (a no-family id belongs to archivedStranded,
      //    never to this test; the two are mutually exclusive by construction).
      const wt = String(desc.worktreePath);
      let familyKey;
      if (meshCache.has(wt)) familyKey = meshCache.get(wt);
      else { familyKey = M.canonicalMeshId(wt); meshCache.set(wt, familyKey); }
      if (!familyKey) return false;
      if (byMesh === null) byMesh = M.groupRegistryByMeshId(rows);
      const group = byMesh.get(familyKey);
      if (!group || !group.rows.length) return false;

      // 4. the SAME survivor selection healOrphanPartitions' pickSurvivor uses
      //    (livenessSelect.pickFreshestLive — the shared primitive, not a
      //    re-derivation of the ranking rule).
      const survivor = livenessSelect.pickFreshestLive(group.rows, { storeHandle: store, home });
      if (!survivor || survivor.id == null) return false;
      const survivorId = String(survivor.id);
      if (survivorId === String(id)) return false; // defensive: never itself

      // 5. every CURRENTLY UNREAD row must PROVE it already landed in the
      //    survivor — proof is an exact hash match against the hash
      //    forwardArchivedOrphanUnread would have computed for that exact row.
      let cursor = 0;
      try { cursor = store.cursorValue(id); } catch (_) { cursor = 0; }
      let unreadRows = [];
      try { unreadRows = store.listMessages(id, { sinceCursor: cursor }); } catch (_) { return false; }
      if (!unreadRows.length) return false; // nothing to prove (caller already gates unread>0; stay defensive)

      const hashes = survivorHashes(survivorId);
      for (const m of unreadRows) {
        // A row forwardArchivedOrphanUnread would never even attempt (not a
        // structurally-forwardable direct) can never be proven forwarded —
        // fail the WHOLE id back to orphans[] rather than silently ignoring it.
        if (!isForwardableRow(m)) return false;
        const fields = M.meshRowCopy(m, 'message', {
          to: survivorId,
          type: 'direct',
          urgency: m.urgency || 'normal',
          message: archivedForwardProvenancePrefixMirror(id) + (m.body != null ? m.body : ''),
        });
        const hash = meshMessageHashFn(fields);
        if (!hash || !hashes.has(String(hash))) return false; // this exact row not proven forwarded
      }
      return true;
    } catch (_) {
      return false; // fail-open
    }
  };
}

module.exports = { makeArchivedStrandedTest, makeForwardedDrainedTest };
