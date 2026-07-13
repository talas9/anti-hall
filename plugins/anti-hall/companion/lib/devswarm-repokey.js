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
    const r = spawnSync('git', args, { encoding: 'utf8', cwd: o.cwd });
    if (r.error || r.status !== 0) return { ok: false, raw: '' };
    return { ok: true, raw: String(r.stdout || '') };
  } catch (_) {
    return { ok: false, raw: '' };
  }
}

// gitCommonDir(worktree, {io}) -> the absolute, realpath'd `--git-common-dir`
// for `worktree`, or null on ANY failure (fail-open — a non-git cwd, a missing
// git binary, or an unstat-able path must never throw).
function gitCommonDir(worktree, opts) {
  const o = opts || {};
  const run = (o.io && o.io.run) || defaultRun;
  const F = (o.io && o.io.fs) || fs;
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
    const real = F.realpathSync(resolved);
    return real || null;
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

module.exports = { sanitizeRepoName, gitCommonDir, repoKeyForWorktree };
