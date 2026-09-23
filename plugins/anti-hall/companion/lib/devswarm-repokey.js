'use strict';
// anti-hall :: devswarm-repokey — the shared per-project store key primitive
// (v0.57 mesh, PLAN-v0.57-mesh.md D1/D2).
//
// repoKeyForWorktree(worktree) =
//   sanitizeRepoName(basename(dirname(realpath(git-common-dir)))) + '-' +
//   sha256(realpath(git-common-dir)).slice(0,6)
//
// WHY `--git-common-dir`, NOT `--show-toplevel`. `--show-toplevel` is PER-WORKTREE
// (a linked worktree's toplevel differs from the Primary's) — that is what today's
// `worktreeHash()`/`resolveWorktree()` (install-devswarm-ingest.js:158-190) key on,
// by design, for PER-WORKTREE units/locks. `--git-common-dir` resolves to the SAME
// main worktree's `.git` for EVERY worktree of a project (Primary and every linked
// worktree) — that project-stable identity is what a SHARED mesh store needs.
// Confirmed live by the Phase-0 probe
// (.anti-hall/progress/2026-07-13/phase0-mesh-probe-report.md): identical resolved
// path and identical parent basename across worktrees, once normalized via
// `path.resolve(cwd, raw)` BEFORE `realpathSync` — git emits a RELATIVE
// common-dir (bare `.git`) from the MAIN worktree but an ABSOLUTE one from a
// LINKED worktree; both forms must collapse to the identical string before
// hashing, or the two worktrees of one project would derive different keys.
//
// WINDOWS P0 (CI run 29240821071): the above collapse is not enough on real
// Windows. Two real problems compound: (1) `fs.realpathSync()` (the DEFAULT,
// JS-implemented realpath Node ships) resolves actual symlinks but otherwise
// PRESERVES whatever casing/short-name form its input string already had —
// unlike `fs.realpathSync.native()` (libuv -> Win32 `GetFinalPathNameByHandleW`),
// it never queries the OS for the on-disk canonical form. (2) GitHub Actions'
// windows-latest runners expose `%TEMP%` in 8.3 SHORT-name form (documented:
// `C:\Users\RUNNER~1\AppData\Local\Temp`, not `...\runneradmin\...`), which is
// what `os.tmpdir()`/`fs.mkdtempSync()` build worktree paths from — while git-
// for-Windows' own MSYS/Cygwin path-translation layer resolves an ABSOLUTE
// `--git-common-dir` (the form a LINKED worktree reports) through its own
// long-name-expanding logic. The Primary's own worktree path and the linked
// worktree's reported common-dir can therefore reach `realpathSync()` as two
// DIFFERENT strings for the identical physical directory (short-name vs
// long-name, and/or differing casing) — and the default realpath doesn't
// correct that, so they hash differently. Fix: on win32, prefer
// `realpathSync.native()` (it DOES expand short names and query true on-disk
// casing via `GetFinalPathNameByHandleW`), then canonicalize its output — strip
// the `\\?\`/`\\?\UNC\` extended-length prefix `.native()` adds, normalize
// separators to `/`, drop a trailing separator, and lowercase the whole string
// (NTFS is case-insensitive, the cheap catch-all for any residual case
// difference) — via `winCanonicalizeCommonDir()` below, BEFORE hashing. POSIX
// is untouched: case-sensitive, no prefix, default `realpathSync()` as before.
//
// The readable-basename prefix satisfies the owner's "use the repo name, don't
// scramble shit up"; the 6-hex realpath-hash suffix defeats basename collisions
// (`~/a/app` vs `~/b/app`) and keeps the key filesystem/launchd-label/systemd-unit/
// cron-marker safe (O-D10).
//
// Fail-open throughout: any failure to resolve (non-git cwd, missing git binary,
// unreadable path) returns null, NEVER throws — callers treat null as "mesh
// dormant" (O-D5), not as an error to propagate.
//
// Pure Node built-ins only, cross-platform. Every spawn/fs call is injectable via
// `io` ({ run, fs }) so unit tests exercise sanitization/stability/collision
// behavior without invoking a real git binary or touching the real filesystem.

// B1 (mesh redesign Phase 2): every RESOLVER below is now a thin shim over
// companion/lib/identity.js resolveContext — the ONE location resolver. Exported
// names/signatures are unchanged, and for every non-submodule shape the output is
// byte-identical (tests/companion/identity-equivalence.test.js vs the frozen
// v0.103.0 copy in tests/helpers/legacy-repokey-0.103.0.js). What changes is ONLY
// the submodule kinds, which now key to the OUTERMOST superproject: a submodule in a
// LINKED worktree (the old `/.git/modules/` regex missed `.git/worktrees/<wt>/
// modules/`), a non-absorbed / embedded submodule (`.git` DIR), and nested ones.
// Persisted keys that flip are forward-migrated by identity-rekey-v1
// (scripts/devswarm.js migrateIdentityRekey, run from update.js and doctor).
//
// Test seam: when a caller injects `io.run` (a fake git), gitCommonDir resolves
// from that fake `--git-common-dir` output exactly as before (realpath + win32
// canonicalization), so unit tests can simulate git without a real repo. No
// production caller injects `io.run`.
//
// The identity calls use memo:false: this module had no cache before, and long-
// lived daemons call it (a cached non-git answer must never go stale there).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const identity = require('./identity.js');

const { sanitizeRepoName, GIT_SPAWN_TIMEOUT_MS } = identity;

// defaultRun(spec) -> { ok, raw }. ONE injectable git spawn (mirrors the
// io.run pattern in devswarm-pull.js's defaultRun / devswarm-ingest.js's
// defaultMonitorRun). Bounded by GIT_SPAWN_TIMEOUT_MS (Wave D9): a killed
// (timed-out) spawn reports ok:false like any other git failure.
function defaultRun(spec) {
  const o = spec || {};
  const args = Array.isArray(o.args) ? o.args : [];
  try {
    const r = spawnSync('git', args, { encoding: 'utf8', cwd: o.cwd, timeout: GIT_SPAWN_TIMEOUT_MS });
    if (r.error || r.status !== 0) return { ok: false, raw: '' };
    return { ok: true, raw: String(r.stdout || '') };
  } catch (_) {
    return { ok: false, raw: '' };
  }
}

// winCanonicalizeCommonDir(p) -> a STABLE, worktree-independent form of a
// win32 realpath: strips a leading `\\?\UNC\` or `\\?\` extended-length-path
// prefix, normalizes every separator to `/`, drops a trailing separator (but
// keeps a bare drive root's slash, e.g. `c:/`), and lowercases the whole string
// (NTFS is case-insensitive). Kept for the injected-io seam and
// install-devswarm-ingest.js worktreeRealPath.
function winCanonicalizeCommonDir(p) {
  let s = String(p == null ? '' : p);
  if (s.slice(0, 8).toUpperCase() === '\\\\?\\UNC\\') {
    s = '\\\\' + s.slice(8);
  } else if (s.slice(0, 4) === '\\\\?\\') {
    s = s.slice(4);
  }
  s = s.replace(/\\/g, '/');
  if (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1);
  return s.toLowerCase();
}

function injectedRun(o) { return o && o.io && typeof o.io.run === 'function' ? o.io.run : null; }

// contextFor(worktree, opts, extra) -> identity.resolveContext with the caller's
// injected fs (if any), memo off (see header).
function contextFor(worktree, o, extra) {
  const F = o && o.io && o.io.fs;
  // superCache: memo stays off, but the nested-repo git answer (5-min TTL) is shared
  // so a hot hook pays at most one spawn per nested repo (identity.js superCache).
  return identity.resolveContext(worktree, Object.assign({ memo: false, superCache: !F }, F ? { fs: F } : {}, extra || {}));
}

// noSpawnContext(worktree, opts) -> { ctx, deferred }. Resolves with a spawn stub:
// `deferred` is true when identity would have needed its one git spawn (a nested
// `.git` DIRECTORY — non-absorbed/embedded/untracked repo). NoSpawn callers must
// then return null and let their caller fall back to the spawning resolver.
function noSpawnContext(worktree, o) {
  let deferred = false;
  // superCache (set by contextFor): a nested-repo answer this process already paid a
  // spawn for is reused, so only the FIRST row under an untracked/non-absorbed repo defers.
  const ctx = contextFor(worktree, o, { spawn: () => { deferred = true; return { status: 1, stdout: '' }; } });
  return { ctx, deferred };
}

// finalizeInjected(resolved, opts) -> realpath (+ win32 canonicalization) of a
// fake-git common-dir, or null. Injected-io seam only.
function finalizeInjected(resolved, o) {
  const F = (o.io && o.io.fs) || fs;
  const isWin = ((o.io && o.io.platform) || process.platform) === 'win32';
  try {
    const nativeRealpath = isWin && F.realpathSync && typeof F.realpathSync.native === 'function'
      ? F.realpathSync.native
      : null;
    const real = nativeRealpath ? nativeRealpath(resolved) : F.realpathSync(resolved);
    if (!real) return null;
    return isWin ? winCanonicalizeCommonDir(real) : real;
  } catch (_) {
    return null;
  }
}

// gitCommonDir(worktree, {io}) -> the absolute, realpath'd common dir of the
// project `worktree` belongs to (for a submodule: its outermost superproject's),
// or null on ANY failure (non-git, deleted, unreadable — fail-open, never throws).
function gitCommonDir(worktree, opts) {
  const o = opts || {};
  const wt = worktree == null ? '' : String(worktree);
  if (!wt) return null;
  const run = injectedRun(o);
  try {
    if (!run) return contextFor(wt, o).commonDir || null;
    const r = run({ args: ['-C', wt, 'rev-parse', '--git-common-dir'], cwd: wt });
    if (!r || !r.ok) return null;
    const rawOut = String(r.raw || '').trim();
    if (!rawOut) return null;
    // Resolve against `wt` BEFORE realpath: git prints a relative '.git' from a
    // main worktree and an absolute path from a linked one.
    return finalizeInjected(path.resolve(wt, rawOut), o);
  } catch (_) {
    return null;
  }
}

// repoKeyForWorktree(worktree, {io}) -> 'sanitized-repo-basename-<6hex>', or
// null when `worktree` is not inside a resolvable git worktree (fail-open —
// callers treat this as "mesh dormant", O-D5). Every worktree and every
// submodule of ONE project resolves to the SAME key.
function repoKeyForWorktree(worktree, opts) {
  const cd = gitCommonDir(worktree, opts);
  if (!cd) return null;
  const base = sanitizeRepoName(path.basename(path.dirname(cd)));
  const suffix = crypto.createHash('sha256').update(cd).digest('hex').slice(0, 6);
  return `${base}-${suffix}`;
}

// gitCommonDirNoSpawn(worktree, {io}) -> the common dir of the checkout ROOTED at
// `worktree` (a main checkout or a linked worktree), resolved WITHOUT spawning.
// Returns null (the caller falls back to a spawning resolver) when `worktree` is:
// gone, not itself a checkout root (the legacy contract: it read `<wt>/.git`
// only), a submodule of ANY kind (callers use this null as their "not a
// key-bearing root" signal — parent-inbox resolveMeshId), or a nested `.git`
// directory whose superproject cannot be decided from disk.
function gitCommonDirNoSpawn(worktree, opts) {
  const o = opts || {};
  const F = (o.io && o.io.fs) || fs;
  const wt = worktree == null ? '' : String(worktree);
  if (!wt) return null;
  try {
    if (!F.existsSync(wt)) return null; // gone worktree: zero spawns
    const { ctx, deferred } = noSpawnContext(wt, o);
    if (deferred || !ctx.commonDir || ctx.submoduleDepth > 0) return null;
    if (ctx.toplevel !== F.realpathSync(path.resolve(wt))) return null;
    return ctx.commonDir;
  } catch (_) {
    return null;
  }
}

// resolveWorktreeNoSpawn(startDir, {io}) -> the key-bearing worktree root
// for `startDir` (in the caller's logical spelling, as before): its own checkout, or — from inside a submodule of
// any depth, in a main checkout or a linked worktree — the outermost
// superproject. Zero spawns; null (fail-open, the caller falls back to the
// spawning resolveCallerWorktree) when no checkout encloses `startDir`, the path
// is gone, or a nested `.git` directory needs git to classify.
function resolveWorktreeNoSpawn(startDir, opts) {
  const o = opts || {};
  try {
    const start = path.resolve(String(startDir || ''));
    const { ctx, deferred } = noSpawnContext(start, o);
    if (deferred || !ctx.worktreeRoot) return null;
    // Return the caller's own (logical) spelling of that root, exactly as the
    // pre-B1 walk did: the nearest ancestor of `start` whose realpath is the root.
    const F = (o.io && o.io.fs) || fs;
    for (let d = start; ; d = path.dirname(d)) {
      let real = null;
      try { real = F.realpathSync(d); } catch (_) { real = null; }
      if (real === ctx.worktreeRoot) return d;
      if (path.dirname(d) === d) return ctx.worktreeRoot;
    }
  } catch (_) {
    return null;
  }
}

// repoKeyForWorktreeFast(worktree, {io}) -> the SAME value repoKeyForWorktree
// returns; tries the zero-spawn gitCommonDirNoSpawn first and falls back to
// repoKeyForWorktree otherwise. A worktree path that no longer exists returns
// null with ZERO spawns.
function repoKeyForWorktreeFast(worktree, opts) {
  const o = opts || {};
  const F = (o.io && o.io.fs) || fs;
  const wt = worktree == null ? '' : String(worktree);
  if (!wt || !(function () { try { return F.existsSync(wt); } catch (_) { return false; } })()) return null;
  const cd = gitCommonDirNoSpawn(worktree, opts);
  if (cd) {
    const base = sanitizeRepoName(path.basename(path.dirname(cd)));
    const suffix = crypto.createHash('sha256').update(cd).digest('hex').slice(0, 6);
    return `${base}-${suffix}`;
  }
  return repoKeyForWorktree(worktree, opts);
}

// registeredRepoKey(desc, id, opts) -> repoKey | null (defect e586afdaa968).
// THE ONE definition of "which PROJECT is this workspace id registered under",
// shared by scripts/devswarm.js (descriptorRegisteredRepoKey) and
// hooks/devswarm-parent-gate.js so the two can never drift. Before this lived
// here the two files disagreed: devswarm.js fell back repoKey -> ownerKey while
// the hook fell back to repoKey ONLY, so a legacy descriptor carrying only an
// `ownerKey` (exactly the shape rehomeCore emits: ownerKey=<repoKey>,
// repoKey absent) read as "names no project" to the hook and as "names project
// X" to the CLI — the hook then failed open and printed a remediation command
// the CLI refuses.
//
// PRECEDENCE (fixed, in this order):
//   1. the worktree-DERIVED key, when `desc.worktreePath` still resolves —
//      always the fresher truth (a repo split/move changes it without the
//      persisted field being updated), and the only form backed by a live,
//      independently-verifiable filesystem fact;
//   2. else the PERSISTED `repoKey` — written only when the worktree's own
//      fresh key equalled the registering session's project key, so it is a
//      provably worktree-derived project key, not a caller-cwd artifact;
//   3. else the persisted `ownerKey` — the physical partition the workspace's
//      rows actually live in (rehomeCore writes this and leaves repoKey unset).
//
// The legacy per-id HASH bucket is deliberately NOT a project key: a workspace
// registered outside any git repo persists that hash as its ownerKey, and
// treating it as a registered project would refuse that workspace's OWN reads
// and disable the sanctioned re-home heal. Excluded explicitly.
//
// Returns null for "names no project at all" — every caller treats null as
// FAIL-OPEN (proceed as before), never as a refusal.
//
// opts.resolveFresh — inject an already-memoized worktree->key resolver (the
// parent-gate resolves each worktreePath at most once per Stop invocation and
// must not re-spawn git here). opts.hashKey — inject the already-computed
// per-id hash bucket. Both optional; both default to the real thing.
function registeredRepoKey(desc, id, opts) {
  if (!desc || typeof desc !== 'object') return null;
  const o = opts || {};
  const resolveFresh = typeof o.resolveFresh === 'function' ? o.resolveFresh : repoKeyForWorktree;
  let fresh = null;
  try { fresh = desc.worktreePath ? resolveFresh(desc.worktreePath) : null; } catch (_) { fresh = null; }
  if (fresh) return fresh;
  const persisted = (typeof desc.repoKey === 'string' && desc.repoKey)
    ? desc.repoKey
    : ((typeof desc.ownerKey === 'string' && desc.ownerKey) ? desc.ownerKey : null);
  if (!persisted) return null;
  let hashKey = null;
  if (typeof o.hashKey === 'string' && o.hashKey) hashKey = o.hashKey;
  else {
    // Lazy require: keeps this module's own load cost (a hook-path primitive)
    // unchanged for every consumer that never calls this function.
    try { hashKey = require('./devswarm-store.js').hashFromWorkspaceId(id); } catch (_) { hashKey = null; }
  }
  if (hashKey && persisted === hashKey) return null; // legacy hash bucket, not a project
  return persisted;
}

module.exports = { sanitizeRepoName, gitCommonDir, gitCommonDirNoSpawn, resolveWorktreeNoSpawn, repoKeyForWorktree, repoKeyForWorktreeFast, winCanonicalizeCommonDir, registeredRepoKey, defaultRun, GIT_SPAWN_TIMEOUT_MS };
