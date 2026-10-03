'use strict';
// FROZEN COPY (test-only) of plugins/anti-hall/companion/lib/devswarm-repokey.js as shipped
// in v0.103.0 (commit de31b7b), BEFORE mesh-redesign Phase 2 B1 routed it through
// companion/lib/identity.js. Kept so the identity equivalence / key-stability proof
// stays meaningful after the live module became a shim (spec 2.1(5): no `git show`
// at test time -- depth-1 CI clones break it). Never edit; never require from plugins/.
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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MAX_NAME_LEN = 40;

// GIT_SPAWN_TIMEOUT_MS — Wave D9: bounds defaultRun's git spawn so a `git`
// stuck on a stale/unmounted worktree (or a fixture dir a test suite pollutes
// the real registry with — the exact SkyCrew defect f3c1bc827d89 root cause)
// can never hang this call forever. `ANTIHALL_REPOKEY_GIT_TIMEOUT_MS` is a
// TEST-ONLY override (never documented/relied on in production) so a test can
// prove the kill-on-timeout behavior against a deliberately-hanging fake `git`
// without waiting out the real 10s production default.
const GIT_SPAWN_TIMEOUT_MS = (() => {
  const n = Number(process.env.ANTIHALL_REPOKEY_GIT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 10000;
})();

// sanitizeRepoName(name) -> a launchd-label / systemd-unit / cron-marker /
// filesystem-safe slug: lowercase, non `[a-z0-9-]` runs collapsed to a single
// `-`, capped at 40 chars. The leading/trailing `-` strip runs AFTER the
// 40-char slice (D28) — stripping BEFORE the cap can leave a trailing/double
// dash when the 40th character lands mid-run-of-dashes; stripping after the cut
// always yields a clean edge. Empty or all-dash input falls back to the literal
// 'repo' so a repoKey is never just a bare hash suffix.
function sanitizeRepoName(name) {
  const raw = name == null ? '' : String(name);
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, MAX_NAME_LEN)
    .replace(/^-+|-+$/g, '');
  return slug || 'repo';
}

// defaultRun(spec) -> { ok, raw }. ONE injectable git spawn (mirrors the
// io.run pattern in devswarm-pull.js's defaultRun / devswarm-ingest.js's
// defaultMonitorRun) so tests can simulate git output without spawning a real
// binary.
function defaultRun(spec) {
  const o = spec || {};
  const args = Array.isArray(o.args) ? o.args : [];
  try {
    // Wave D9: a `git` subprocess stuck on a stale/unmounted worktree (or a
    // fixture dir a test suite pollutes the real registry with — the exact
    // SkyCrew defect f3c1bc827d89 root cause) must never hang this call
    // forever. `timeout` makes spawnSync kill it and set `r.error`/a null
    // `r.status`, which the existing failure check below already treats
    // identically to any other non-zero-exit git failure — no separate
    // timeout branch needed.
    const r = spawnSync('git', args, { encoding: 'utf8', cwd: o.cwd, timeout: GIT_SPAWN_TIMEOUT_MS });
    if (r.error || r.status !== 0) return { ok: false, raw: '' };
    return { ok: true, raw: String(r.stdout || '') };
  } catch (_) {
    return { ok: false, raw: '' };
  }
}

// winCanonicalizeCommonDir(p) -> a STABLE, worktree-independent form of a
// win32 realpath, so any worktree of one repo hashes identically regardless
// of which call path (short-name vs long-name, `\\?\`-prefixed native
// realpath vs not, differing separator/case) produced the string: strips a
// leading `\\?\UNC\` or `\\?\` extended-length-path prefix, normalizes every
// separator to `/`, drops a trailing separator (but keeps a bare drive root's
// slash, e.g. `c:/`), and lowercases the whole string (NTFS is
// case-insensitive). Exported so tests can compute matching expectations
// without duplicating this logic.
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

// finalizeCommonDir(resolved, wt, opts) -> the shared realpath + win32
// canonicalization + submodule-shape detection tail shared by BOTH the
// git-spawn resolver (gitCommonDir) and the fs-only resolver
// (gitCommonDirNoSpawn) below, so the two can never drift on how a raw
// (pre-realpath) common-dir string is turned into the final comparable form.
// `resolved` is already an absolute, non-realpath'd path (git-spawn output
// resolved against `wt`, or the fs walk's own resolved gitdir/commondir).
// Returns { canon } on success, or { submodule: true } when the realpath'd
// path lands under a `.git/modules/<name>` segment — the ONE shape this
// shared tail cannot finish alone (the submodule remap needs
// `--show-superproject-working-tree`, a git spawn); callers that cannot spawn
// git return null in that case and let the caller fall back to the full
// git-spawn resolver. Never throws — any fs failure returns null.
function finalizeCommonDir(resolved, wt, opts) {
  const o = opts || {};
  const F = (o.io && o.io.fs) || fs;
  const platform = (o.io && o.io.platform) || process.platform;
  const isWin = platform === 'win32';
  if (!resolved) return null;
  try {
    // On win32, prefer realpathSync.native() — it expands 8.3 short names
    // (GH Actions' %TEMP% is short-name-shaped) and queries the OS for the
    // true canonical casing, unlike the default JS realpath (see header
    // comment). Injected test `fs` doubles rarely carry a `.native`, so this
    // falls back to the plain injected/real realpathSync when absent.
    const nativeRealpath = isWin && F.realpathSync && typeof F.realpathSync.native === 'function'
      ? F.realpathSync.native
      : null;
    const real = nativeRealpath ? nativeRealpath(resolved) : F.realpathSync(resolved);
    if (!real) return null;
    const canon = isWin ? winCanonicalizeCommonDir(real) : real;
    if (/[/\\]\.git[/\\]modules[/\\]/.test(canon)) return { submodule: true, canon };
    return { canon };
  } catch (_) {
    return null;
  }
}

// gitCommonDir(worktree, {io}) -> the absolute, realpath'd `--git-common-dir`
// for `worktree`, or null on ANY failure (fail-open — a non-git cwd, a missing
// git binary, or an unstat-able path must never throw).
function gitCommonDir(worktree, opts) {
  const o = opts || {};
  const run = (o.io && o.io.run) || defaultRun;
  const wt = worktree == null ? '' : String(worktree);
  if (!wt) return null;
  try {
    const r = run({ args: ['-C', wt, 'rev-parse', '--git-common-dir'], cwd: wt });
    if (!r || !r.ok) return null;
    const rawOut = String(r.raw || '').trim();
    if (!rawOut) return null;
    // Resolve against `wt` BEFORE realpath — collapses git's relative form
    // ('.git', from the main worktree) and its absolute form (from a linked
    // worktree) to the identical string (Phase-0 probe finding).
    const resolved = path.resolve(wt, rawOut);
    const fin = finalizeCommonDir(resolved, wt, opts);
    if (!fin) return null;
    if (!fin.submodule) return fin.canon;
    const canon = fin.canon;
    // SUBMODULE FIX (A1a, v0.66 review): git's on-disk submodule layout ALWAYS
    // nests a submodule's own `--git-common-dir` under
    // `<superproject>/.git/modules/<name>` (verified live: a real `git submodule
    // add` reproduces this exactly). `basename(dirname(canon))` then reads as the
    // literal 'modules' — NOT a project name — so a caller running from inside a
    // submodule derived repoKey `modules-<hash>`, silently keying every store
    // operation to the WRONG project. Detect this SPECIFIC on-disk shape (a
    // `/modules/` segment immediately under a `.git` segment) — never guess off
    // the basename alone, since a repo could coincidentally be named 'modules' —
    // then re-resolve against the SUPERPROJECT's own worktree via
    // `--show-superproject-working-tree`, which is verified to report the
    // superproject root from inside ANY submodule and EMPTY from a normal
    // repo/the superproject itself (so recursion terminates: the superproject's
    // own probe returns empty and this branch is skipped on the recursive call).
    // Fail-open: if the probe cannot confirm a superproject, fall through to the
    // pre-fix (submodule-local) resolution rather than losing resolution
    // entirely — matches this function's existing null-on-any-failure contract.
    if (/[/\\]\.git[/\\]modules[/\\]/.test(canon)) {
      try {
        const superR = run({ args: ['-C', wt, 'rev-parse', '--show-superproject-working-tree'], cwd: wt });
        const superWt = superR && superR.ok ? String(superR.raw || '').trim() : '';
        if (superWt && superWt !== wt) {
          const superCd = gitCommonDir(superWt, opts);
          if (superCd) return superCd;
        }
      } catch (_) { /* fall through to the submodule-local resolution below */ }
    }
    return canon;
  } catch (_) {
    return null;
  }
}

// repoKeyForWorktree(worktree, {io}) -> 'sanitized-repo-basename-<6hex>', or
// null when `worktree` is not inside a resolvable git worktree (gitCommonDir
// returned null; fail-open — callers treat this as "mesh dormant", O-D5).
// Deterministic and stable: identical input always yields the identical key,
// and every linked worktree of ONE project resolves to the SAME common-dir and
// therefore the SAME key. Two different repos that happen to share a basename
// still diverge because their common-dir realpaths differ, so the 6-hex
// suffix disambiguates them.
function repoKeyForWorktree(worktree, opts) {
  const cd = gitCommonDir(worktree, opts);
  if (!cd) return null;
  const base = sanitizeRepoName(path.basename(path.dirname(cd)));
  const suffix = crypto.createHash('sha256').update(cd).digest('hex').slice(0, 6);
  return `${base}-${suffix}`;
}

// gitCommonDirNoSpawn(worktree, {io}) -> the SAME absolute, realpath'd
// `--git-common-dir` gitCommonDir() would produce, WITHOUT spawning `git` —
// read straight off the on-disk worktree metadata git itself writes:
//   - `<worktree>/.git` is a DIRECTORY for a main checkout — that directory
//     itself IS the common dir.
//   - `<worktree>/.git` is a FILE ('gitdir: <path>') for a linked worktree
//     (or a submodule) — `<path>` (resolved against `worktree` when relative)
//     is that worktree's PRIVATE git dir, e.g.
//     `<main>/.git/worktrees/<name>`. If `<gitdir>/commondir` exists, its
//     content (itself resolved against `<gitdir>`, typically the relative
//     `../..`) IS the common dir; when it does NOT exist (the on-disk shape
//     a submodule's own gitdir has, verified live below), `<gitdir>` itself
//     IS the common dir (matches git's own `--git-common-dir` output for a
//     submodule with no further linked worktrees of its own).
// Verified live against real repos/worktrees/submodules on this machine
// (2026-09-18, ToolFox3 linked worktrees + skycrew submodules) to produce
// BYTE-IDENTICAL output to `git rev-parse --git-common-dir` for every shape
// above.
// Returns null (fail-open) for: a nonexistent worktree path (no spawn at
// all — `fs.existsSync` short-circuits), an unreadable/malformed `.git`
// entry, or the submodule-under-`.git/modules` shape once realpath'd — that
// last case needs `--show-superproject-working-tree` to remap correctly,
// which this function cannot do without a spawn, so it defers to the caller
// to fall back to the full git-spawn `gitCommonDir`/`repoKeyForWorktree`.
function gitCommonDirNoSpawn(worktree, opts) {
  const o = opts || {};
  const F = (o.io && o.io.fs) || fs;
  const wt = worktree == null ? '' : String(worktree);
  if (!wt) return null;
  try {
    if (!F.existsSync(wt)) return null; // gone worktree: zero spawns, zero fs reads beyond this
    const dotGit = path.join(wt, '.git');
    let st;
    try { st = F.lstatSync(dotGit); } catch (_) { return null; }
    let gitdirPath;
    if (st.isDirectory()) {
      gitdirPath = dotGit;
    } else {
      let raw;
      try { raw = String(F.readFileSync(dotGit, 'utf8')); } catch (_) { return null; }
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(raw);
      if (!m || !m[1]) return null;
      gitdirPath = path.resolve(wt, m[1]);
    }
    let resolved = gitdirPath;
    const commondirFile = path.join(gitdirPath, 'commondir');
    if (F.existsSync(commondirFile)) {
      let cdRaw;
      try { cdRaw = String(F.readFileSync(commondirFile, 'utf8')).trim(); } catch (_) { cdRaw = ''; }
      if (cdRaw) resolved = path.resolve(gitdirPath, cdRaw);
    }
    const fin = finalizeCommonDir(resolved, wt, opts);
    if (!fin || fin.submodule) return null; // defer the submodule remap to the git-spawn resolver
    return fin.canon;
  } catch (_) {
    return null;
  }
}

// resolveWorktreeNoSpawn(startDir, {io}) -> absolute worktree/toplevel path |
// null. A pure-fs, SUBMODULE-AWARE analogue of the plain `findGitToplevel`
// walk-up (hooks/devswarm-parent-gate.js, scripts/devswarm.js) — WITHOUT
// spawning git (v0.102.2, defect: the submodule-identity gate fix originally
// shipped with a `resolveCallerWorktree` git-spawn call on this path; this is
// the zero-spawn primitive that removes it for the common case).
//
// WHY THE PLAIN WALK-UP IS WRONG INSIDE A SUBMODULE: `findGitToplevel` stops
// at the FIRST `.git` entry it finds — `fs.statSync`/`lstatSync` succeeds on
// a FILE exactly as on a directory, so it cannot tell "a linked worktree's
// own toplevel" (correct to stop here — same project) apart from "a
// submodule's own toplevel" (WRONG to stop here — a submodule is a
// logically DIFFERENT, nested project; the walk must continue up to the
// ENCLOSING superproject, exactly what `git rev-parse
// --show-superproject-working-tree` resolves via a spawn).
//
// THE FS-ONLY ANSWER: a submodule is ALWAYS nested inside its superproject's
// own working tree (that is what "submodule" means on disk), so the
// superproject's own `.git` is always some ANCESTOR directory of the
// submodule's working tree — reachable by the SAME directory walk-up,
// simply by not stopping at the submodule's own `.git` FILE. The one thing
// needed to know NOT to stop is exactly what `gitCommonDirNoSpawn`'s
// `finalizeCommonDir` already detects with zero spawns: the submodule's own
// gitdir (`.git`'s `gitdir: <path>` target, resolved) contains a
// `.git/modules/<name>` segment (verified live, 2026-09-20: a real `git
// submodule add`'s `.git` file already names this path DIRECTLY — no
// `commondir` indirection needed to see it). A plain LINKED WORKTREE's `.git`
// file does NOT match that shape (its gitdir is `.git/worktrees/<name>`) —
// it stops there exactly as `findGitToplevel` always has, so an ordinary
// linked worktree's own identity is completely unchanged by this function.
//
// Verified against a real `git submodule add` fixture (both from the
// submodule's own root AND a nested subdirectory inside it) and against a
// real `git worktree add` linked worktree (proving it is NOT walked past) —
// see tests/companion/devswarm-repokey-nospawn-submodule.test.js.
//
// Returns null (fail-open) when no `.git` is found walking up to the
// filesystem root, OR when a `.git` FILE's target cannot be read/parsed at
// all (matches `findGitToplevel`'s own fail-open contract for a malformed
// entry) — callers fall back to the git-spawning `resolveCallerWorktree`.
function resolveWorktreeNoSpawn(startDir, opts) {
  const o = opts || {};
  const F = (o.io && o.io.fs) || fs;
  try {
    let dir = path.resolve(String(startDir || ''));
    if (!dir) return null;
    for (;;) {
      const dotGit = path.join(dir, '.git');
      let st = null;
      try { st = F.lstatSync(dotGit); } catch (_) { st = null; }
      if (st) {
        if (st.isDirectory()) return dir; // ordinary toplevel (own OR the superproject reached by a prior submodule hop)
        let raw = null;
        try { raw = String(F.readFileSync(dotGit, 'utf8')); } catch (_) { raw = null; }
        const m = raw && /^\s*gitdir:\s*(.+?)\s*$/m.exec(raw);
        const gitdirPath = (m && m[1]) ? path.resolve(dir, m[1]) : null;
        const isSubmodule = !!(gitdirPath && /[/\\]\.git[/\\]modules[/\\]/.test(gitdirPath));
        if (!isSubmodule) return dir; // linked worktree (or an unparseable '.git' file) -> stop here, same as findGitToplevel
        // submodule boundary detected -> do NOT stop; keep walking up toward the superproject.
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root, no .git found
      dir = parent;
    }
  } catch (_) {
    return null;
  }
}

// repoKeyForWorktreeFast(worktree, {io}) -> the SAME value repoKeyForWorktree
// would return, but tries the zero-spawn `gitCommonDirNoSpawn` resolution
// FIRST and only falls back to the git-spawning `repoKeyForWorktree` when the
// fs-only path could not resolve (missing/malformed `.git` shape, or the rare
// submodule-remap case) — see gitCommonDirNoSpawn's own doc comment for the
// exact shapes it covers. This is the primitive hot-path callers (e.g.
// devswarm-parent-inbox.js's per-row #36 structural filter) should call
// instead of repoKeyForWorktree, since a hook running on every prompt must
// not spawn one `git` process per row it needs to classify.
function repoKeyForWorktreeFast(worktree, opts) {
  const o = opts || {};
  const F = (o.io && o.io.fs) || fs;
  const wt = worktree == null ? '' : String(worktree);
  // A worktree path that no longer exists on disk must spawn NOTHING — not
  // even the git-spawn fallback below. This check must happen HERE (not only
  // inside gitCommonDirNoSpawn) because that function's null return is
  // ambiguous between "gone" and "exists but unresolvable" and this caller
  // must never conflate the two: only the latter is worth a spawn.
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
