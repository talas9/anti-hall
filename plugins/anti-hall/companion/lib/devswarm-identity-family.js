'use strict';
// anti-hall :: devswarm-identity-family — READER-SIDE identity-family collapse.
//
// WHY THIS EXISTS (root cause): `devswarm-parent-gate.js` and
// `devswarm-supervisor.js` both enumerate `readDescriptors(home)` one row per
// descriptor FILE (companion/devswarm-supervisor.js). Two descriptor files can
// legitimately share ONE `worktreePath` (e.g. a builder-id UUID row and a
// slug row for the SAME physical worktree, or the Primary's own synthetic
// self-row alongside a duplicate descriptor for its own worktree) — both
// survive into any one-row-per-descriptor count/list, producing a phantom
// "N workspace(s)" divergence from what the app actually shows.
//
// This module does NOT retire, delete, tombstone, or otherwise mutate ANY
// descriptor/message/state — `retirePhantomWorktreeDuplicates` (hooks/
// devswarm-child-turn.js) and the store-layer fold (scripts/devswarm.js)
// deliberately decline to collapse this case (they protect the legitimate
// "two live tabs on one worktree" scenario), and this module does not
// second-guess that. It is a PURE, READ-TIME grouping applied only at the
// point a caller is about to COUNT or LIST descriptors, so the underlying
// store/descriptor set is completely untouched.
//
// PURITY CONTRACT: no store access, no git spawn of its own — the caller
// injects a `resolve(worktreePath) -> key|null` function. Callers MUST pass
// the EXISTING canonical derivation (scripts/devswarm.js's `canonicalMeshId`
// or `canonicalWorktreeRealPath`, both already exported) rather than this
// module re-implementing realpath/toplevel logic a fourth time. Per
// worktreeRealPath's own header (companion/lib/devswarm-store.js), the
// resolver NEVER throws by construction — it degrades to path.resolve on a
// realpath failure (e.g. a removed worktree), which is exactly the right
// degradation for grouping purposes. This module additionally guards every
// resolver call with try/catch anyway (defense in depth for a caller-supplied
// resolver that does not honor that contract) and falls back to a per-id key
// so a throwing/missing resolver can never OVER-collapse two descriptors —
// at worst it reproduces today's one-row-per-descriptor behavior for the
// entries it could not resolve.
//
// macOS case-insensitive paths are DELIBERATELY NOT case-folded here — that
// would incorrectly fold two distinct case-sensitive paths together on Linux.
// Not handled; noted per spec.

// familyKeyOf(descriptor, { resolve }) -> string. The canonical family key for
// ONE descriptor-shaped object ({ id, worktreePath, ... }). Two descriptors
// belong to the same family iff this returns the same string for both.
function familyKeyOf(descriptor, opts) {
  const resolve = opts && typeof opts.resolve === 'function' ? opts.resolve : null;
  const wt = descriptor && descriptor.worktreePath;
  if (wt && resolve) {
    try {
      const key = resolve(wt);
      if (key) return String(key);
    } catch (_) {
      // fail-open: fall through to the id-keyed fallback below rather than
      // letting a throwing resolver propagate out of a pure grouping helper.
    }
  }
  // No worktreePath, no resolver, or the resolver could not produce a key ->
  // fall back to the descriptor's own id so distinct entries are never
  // over-collapsed (this reproduces today's one-row-per-descriptor grouping
  // for exactly the entries a canonical key could not be found for).
  const id = descriptor && descriptor.id != null ? String(descriptor.id) : '';
  return 'id:' + id;
}

// collapseFamilies(descriptors, { resolve }) -> [{ key, members, survivor }]
//   - key: the family key (see familyKeyOf)
//   - members: every descriptor-shaped object grouped under `key`, in input order
//   - survivor: the ONE member to treat as canonical/registered for this family.
//     Preference: a member whose `id` already EQUALS the resolved family key
//     (i.e. it IS the canonical id) wins outright. Otherwise the first member
//     after a stable sort by `String(id)` — deterministic, no invented ranking.
//
// The resolver is memoized per DISTINCT worktreePath within one call (never
// re-invoked for the same path twice), so N descriptors sharing one worktree
// never cost N resolver calls (mirrors the memoization idiom already used at
// the devswarm-parent-gate.js call site for repoKeyForWorktree).
function collapseFamilies(descriptors, opts) {
  const resolve = opts && typeof opts.resolve === 'function' ? opts.resolve : null;
  const list = Array.isArray(descriptors) ? descriptors : [];

  const resolvedCache = new Map(); // worktreePath -> resolved key string | null
  function keyFor(d) {
    const wt = d && d.worktreePath;
    if (wt && resolve) {
      if (resolvedCache.has(wt)) {
        const cached = resolvedCache.get(wt);
        if (cached) return cached;
      } else {
        let k = null;
        try { k = resolve(wt); } catch (_) { k = null; }
        const cachedKey = k ? String(k) : null;
        resolvedCache.set(wt, cachedKey);
        if (cachedKey) return cachedKey;
      }
    }
    const id = d && d.id != null ? String(d.id) : '';
    return 'id:' + id;
  }

  const groups = new Map(); // key -> members[]
  const order = [];
  for (const d of list) {
    if (!d) continue;
    const key = keyFor(d);
    let members = groups.get(key);
    if (!members) { members = []; groups.set(key, members); order.push(key); }
    members.push(d);
  }

  return order.map((key) => {
    const members = groups.get(key);
    let survivor = null;
    for (const m of members) {
      if (m && m.id != null && String(m.id) === key) { survivor = m; break; }
    }
    if (!survivor) {
      const sorted = members.slice().sort((a, b) => {
        const ai = a && a.id != null ? String(a.id) : '';
        const bi = b && b.id != null ? String(b.id) : '';
        if (ai < bi) return -1;
        if (ai > bi) return 1;
        return 0;
      });
      survivor = sorted[0];
    }
    return { key, members, survivor };
  });
}

// ---------------------------------------------------------------------------
// MUTATING-SIDE grouping (archive). Everything above is READ-TIME only; the two
// helpers below are the SAME module's answer to the strictly different question
// `cmdArchive` (scripts/devswarm.js) asks: "which OTHER descriptor FILES name the
// same identity as the one I am retiring, such that leaving them live would keep
// a workspace the user just archived alive?"
//
// WHY THIS LIVES HERE and not in scripts/devswarm.js: identity grouping already
// has exactly ONE owner (this module). A second, parallel grouping rule written
// at the archive call site is precisely the drift this repo has shipped twice.
// So the rule lives beside familyKeyOf/collapseFamilies even though the archive
// path needs a STRICTER predicate than they do — see next paragraph.
//
// WHY THE PREDICATE IS STRICTER THAN familyKeyOf: familyKeyOf groups by resolved
// worktree, which is correct for COUNTING (two rows on one worktree are one
// workspace in a list) but NOT sufficient to justify a WRITE. This module's own
// header records the reason: two legitimately-live tabs can share one worktree,
// and retirePhantomWorktreeDuplicates / the store-layer fold deliberately
// decline to collapse that case. Retiring a descriptor on worktree equality
// alone would archive a workspace nobody asked to archive. So the mutating
// predicate uses only the STRONGEST, unambiguous link: one row's `sessionId` IS
// the other row's `id`. That is the builder-id-UUID-row / slug-row pair named in
// this file's header — the SAME identity registered twice, never two live tabs
// (two live tabs have distinct ids AND distinct sessionIds, with no cross-link).
//
// PURITY CONTRACT (unchanged): no fs, no store, no git. The caller supplies the
// candidate descriptors and performs every write itself.

// crossLinkedIdentity(a, b) -> boolean. True iff a and b are the SAME identity
// registered under two descriptor ids: either a.sessionId === b.id or
// b.sessionId === a.id. Deliberately NOT true for a row cross-linked to itself
// (a.sessionId === a.id would otherwise make every self-registered row its own
// twin), and never true on empty/missing fields.
function crossLinkedIdentity(a, b) {
  if (!a || !b) return false;
  const aId = a.id != null ? String(a.id) : '';
  const bId = b.id != null ? String(b.id) : '';
  if (!aId || !bId || aId === bId) return false;
  const aSess = a.sessionId != null ? String(a.sessionId) : '';
  const bSess = b.sessionId != null ? String(b.sessionId) : '';
  if (aSess && aSess === bId) return true;
  if (bSess && bSess === aId) return true;
  return false;
}

// identityFamilyTwins(target, candidates) -> [candidate, ...]
// Every candidate cross-linked to `target` (crossLinkedIdentity), in input
// order, excluding target itself. Pure: returns a filtered view, mutates
// nothing. An empty/absent candidate list yields [].
function identityFamilyTwins(target, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const out = [];
  for (const c of list) {
    if (!crossLinkedIdentity(target, c)) continue;
    out.push(c);
  }
  return out;
}

module.exports = { familyKeyOf, collapseFamilies, crossLinkedIdentity, identityFamilyTwins };
