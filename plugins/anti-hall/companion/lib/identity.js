'use strict';
// anti-hall :: identity — the ONE "where am I" (location identity) resolver.
// Mesh redesign Phase 2 (B0): this module has NO callers yet; later batches
// (B1..B6) migrate every legacy resolver onto it. See
// .anti-hall/plans/2026-09-23-mesh-redesign.md "Phase 2 decisions".
//
// resolveContext(cwd) answers, from the filesystem alone for every common
// shape, the same questions git answers with `rev-parse --show-toplevel` /
// `--show-superproject-working-tree` / `--git-common-dir`, and derives the two
// persisted keys from them:
//   repoKey = sanitizeRepoName(basename(mainWorktree)) + '-' + sha256(commonDir)[0:6]
//   meshId  = 'primary-' + sha256(realpath(worktreeRoot))[0:8]
// Both formulas are byte-identical to devswarm-repokey.js repoKeyForWorktree and
// install-devswarm-ingest.js primaryWorkspaceId for every non-submodule shape
// (tests/companion/identity-equivalence.test.js locks this).
//
// DECIDED RULES (owner decisions 1, 2, 5, 6):
//   - Every submodule kind (absorbed, non-absorbed, embedded gitlink, nested; in a
//     main checkout or a linked worktree) keys to the OUTERMOST superproject for
//     BOTH repoKey and meshId.
//   - realpath everywhere (a symlinked cwd resolves to the physical path, as git does).
//   - A path that does not exist is kind 'deleted' with null keys — never walked
//     up onto an enclosing repo.
//   - Windows branches are not carried (Windows support dropped).
//
// Spawn policy: pure fs first. The single git spawn is `rev-parse
// --show-superproject-working-tree`, used only when a nested repo's own `.git`
// cannot be classified from disk (a `.git` DIRECTORY, or an unrecognised `.git`
// FILE layout, below another repo — tracked-vs-untracked lives in the parent's
// index, which is not parsed here). GIT_* location vars are scrubbed so the
// answer derives from cwd alone.
//
// Never throws. Pure Node built-ins.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { sanitizeRepoName, GIT_SPAWN_TIMEOUT_MS } = require('./devswarm-repokey.js');

const SCRUB_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'];
const MAX_SUBMODULE_HOPS = 32;

const memo = new Map(); // cwdReal -> { ctx, dotGitIsDir }
function clearCache() { memo.clear(); }

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// repoKeyForCommonDir(commonDir) — the repoKeyForWorktree formula over an already
// realpath'd common dir (devswarm-repokey.js repoKeyForWorktree body, POSIX).
function repoKeyForCommonDir(commonDir) {
  return `${sanitizeRepoName(path.basename(path.dirname(commonDir)))}-${sha(commonDir).slice(0, 6)}`;
}
// meshIdForRealPath(p) — install-devswarm-ingest.js primaryWorkspaceId(p) for an
// already-realpath'd p (worktreeRealPath is the identity on a realpath).
function meshIdForRealPath(p) { return `primary-${sha(p).slice(0, 8)}`; }

function under(child, parent) { return child === parent || child.startsWith(parent + path.sep); }

// gitdirOf(T) -> { G, isFile, common } | null. G = the realpath'd private gitdir
// of the checkout rooted at T; common = its realpath'd common dir.
function gitdirOf(F, T) {
  const dotGit = path.join(T, '.git');
  let st;
  try { st = F.lstatSync(dotGit); } catch (_) { return null; }
  let G;
  let isFile = false;
  try {
    if (st.isDirectory()) {
      G = F.realpathSync(dotGit);
    } else {
      isFile = true;
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(String(F.readFileSync(dotGit, 'utf8')));
      if (!m || !m[1]) return null;
      G = F.realpathSync(path.resolve(T, m[1]));
      if (!F.statSync(G).isDirectory()) return null;
    }
  } catch (_) { return null; }
  let common = G;
  let hasCommondir = false;
  try {
    const raw = String(F.readFileSync(path.join(G, 'commondir'), 'utf8')).trim();
    if (raw) { common = F.realpathSync(path.resolve(G, raw)); hasCommondir = true; }
  } catch (_) { /* no commondir: G is its own common dir */ }
  return { G, isFile, common, hasCommondir, dotGitIsDir: !isFile };
}

// nearestDotGit(dir) -> nearest ancestor (inclusive) of a realpath'd dir holding a `.git` entry, or null.
function nearestDotGit(F, dir) {
  let d = dir;
  for (;;) {
    try { F.lstatSync(path.join(d, '.git')); return d; } catch (_) { /* keep walking */ }
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function defaultSpawn(cmd, args, options) { return spawnSync(cmd, args, options); }

function freeze(o) { return Object.freeze(o); }

function nullContext(kind, cwdReal) {
  return freeze({
    kind, cwdReal: cwdReal || null, toplevel: null, superproject: null, worktreeRoot: null,
    commonDir: null, mainWorktree: null, repoKey: null, meshId: null, primaryMeshId: null,
    submoduleDepth: 0, spawned: 0,
  });
}

// resolveContext(cwd, { home, fs, spawn, memo }) -> frozen Context. Never throws.
// `spawn` is spawnSync-compatible (cmd, args, options); `spawned` = git spawns this
// resolution cost (a memo hit returns the cached context unchanged).
function resolveContext(cwd, opts) {
  const o = opts || {};
  const F = o.fs || fs;
  const spawn = typeof o.spawn === 'function' ? o.spawn : defaultSpawn;
  const useMemo = o.memo !== false;
  try {
    const raw = cwd == null || cwd === '' ? process.cwd() : String(cwd);
    const abs = path.resolve(raw);
    let cwdReal;
    try { cwdReal = F.realpathSync(abs); } catch (_) { return nullContext('deleted', null); }

    if (useMemo) {
      const hit = memo.get(cwdReal);
      if (hit) {
        if (!hit.ctx.toplevel) return hit.ctx;
        let still = null;
        try { still = F.lstatSync(path.join(hit.ctx.toplevel, '.git')).isDirectory(); } catch (_) { still = null; }
        if (still === hit.dotGitIsDir) return hit.ctx;
        memo.delete(cwdReal);
      }
    }

    const T = nearestDotGit(F, cwdReal);
    let result;
    let dotGitIsDir = null;
    const info = T ? gitdirOf(F, T) : null;
    // cwd inside the gitdir itself (e.g. <repo>/.git/hooks) is not a work tree to git.
    if (!T || !info || under(cwdReal, info.G)) {
      result = nullContext('non-git', cwdReal);
    } else {
      dotGitIsDir = info.dotGitIsDir;
      let spawned = 0;
      const gitSuperproject = (dir) => {
        spawned += 1;
        const env = Object.assign({}, process.env);
        for (const k of SCRUB_ENV) delete env[k];
        try {
          const r = spawn('git', ['-C', dir, 'rev-parse', '--show-superproject-working-tree'],
            { encoding: 'utf8', env, timeout: GIT_SPAWN_TIMEOUT_MS });
          if (!r || r.error || r.status !== 0) return null;
          const s = String(r.stdout || '').trim();
          return s ? F.realpathSync(s) : null;
        } catch (_) { return null; }
      };
      // superOf(root, rootInfo) -> realpath'd superproject toplevel, or null when `root`
      // is itself key-bearing (a main checkout or a linked worktree).
      const superOf = (root, ri) => {
        const P = nearestDotGit(F, path.dirname(root));
        if (!P || P === root) return null;
        if (ri.isFile) {
          const pi = gitdirOf(F, P);
          if (pi && ri.G.startsWith(pi.G + path.sep + 'modules' + path.sep)) return P; // absorbed submodule
          if (ri.hasCommondir) return null; // linked worktree (even when nested in another checkout)
        }
        return gitSuperproject(root); // .git DIR (non-absorbed / embedded / untracked) or unknown file layout
      };

      let root = T;
      let ri = info;
      let depth = 0;
      let superproject = null;
      for (; depth < MAX_SUBMODULE_HOPS; depth++) {
        const sp = superOf(root, ri);
        if (!sp) break;
        const spInfo = gitdirOf(F, sp);
        if (!spInfo) break;
        if (depth === 0) superproject = sp;
        root = sp;
        ri = spInfo;
      }
      const commonDir = ri.common;
      const mainWorktree = path.dirname(commonDir);
      const rootKind = ri.hasCommondir ? 'linked-worktree' : 'main';
      result = freeze({
        kind: depth > 0 ? 'submodule-in-' + rootKind : rootKind,
        cwdReal,
        toplevel: T,
        superproject,
        worktreeRoot: root,
        commonDir,
        mainWorktree,
        repoKey: repoKeyForCommonDir(commonDir),
        meshId: meshIdForRealPath(root),
        primaryMeshId: meshIdForRealPath(realOr(F, mainWorktree)),
        submoduleDepth: depth,
        spawned,
      });
    }
    if (useMemo) memo.set(cwdReal, { ctx: result, dotGitIsDir });
    return result;
  } catch (_) {
    return nullContext('non-git', null);
  }
}

function realOr(F, p) { try { return F.realpathSync(p); } catch (_) { return path.resolve(p); } }

// sessionWorktreeCoherent(sid, worktreePath, { home, fs, kill }) -> { coherent: true|false|null, evidence }
// Detect-only (never writes). Scans <home>/.claude/sessions/*.json for LIVE records
// carrying `sessionId === sid` and compares each record's cwd worktreeRoot with
// worktreePath's worktreeRoot by realpath string equality.
//   true  = some live record matches
//   false = live records exist, none match (the twin/impersonation shape)
//   null  = no live record (unknown — fail open)
function sessionWorktreeCoherent(sessionId, worktreePath, opts) {
  const o = opts || {};
  const F = o.fs || fs;
  const sid = sessionId == null ? '' : String(sessionId);
  const evidence = { live: [], dead: 0, target: null };
  if (!sid || !o.home) return { coherent: null, evidence };
  const target = resolveContext(worktreePath, { fs: F, spawn: o.spawn }).worktreeRoot;
  evidence.target = target;
  const dir = path.join(String(o.home), '.claude', 'sessions');
  let names = [];
  try { names = F.readdirSync(dir); } catch (_) { return { coherent: null, evidence }; }
  let pidIsAlive = null;
  try { pidIsAlive = require('./liveness.js').pidIsAlive; } catch (_) { pidIsAlive = null; }
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    const file = path.join(dir, n);
    let rec = null;
    try { rec = JSON.parse(F.readFileSync(file, 'utf8')); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object' || rec.sessionId == null || String(rec.sessionId) !== sid) continue;
    let sinceMs = null;
    try { const st = F.statSync(file); sinceMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : null; } catch (_) { sinceMs = null; }
    const alive = pidIsAlive ? pidIsAlive(rec.pid, o.kill, Number.isFinite(sinceMs) ? { sinceMs } : undefined) : null;
    if (alive === false) { evidence.dead += 1; continue; }
    const recRoot = rec.cwd ? resolveContext(String(rec.cwd), { fs: F, spawn: o.spawn }).worktreeRoot : null;
    evidence.live.push({ pid: rec.pid, cwd: rec.cwd || null, worktreeRoot: recRoot });
  }
  if (evidence.live.length === 0) return { coherent: null, evidence };
  const coherent = !!target && evidence.live.some((r) => r.worktreeRoot === target);
  return { coherent, evidence };
}

module.exports = {
  resolveContext, clearCache, sessionWorktreeCoherent,
  repoKeyForCommonDir, meshIdForRealPath,
};
