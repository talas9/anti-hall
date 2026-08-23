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

module.exports = { makeArchivedStrandedTest };
