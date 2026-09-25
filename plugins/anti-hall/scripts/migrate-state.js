#!/usr/bin/env node
'use strict';
// anti-hall :: migrate-state — fold legacy root-level state files into the
// dated .anti-hall/history/ structure that replaced them.
//
// Never deletes or moves the originals: legacy files are read once and their
// full content is copied out, so `.anti-hall-progress.md` / `.anti-hall-history.md`
// stay byte-for-byte untouched forever. Destination writes are read-then-write
// (temp file + rename), never a partial/streaming write.
//
// Destination naming: the leading dot is kept, e.g.
//   .anti-hall-progress.md -> .anti-hall/history/legacy/.anti-hall-progress.md
// so the archived name still matches the legacy root filename at a glance.
//
// USAGE
//   node plugins/anti-hall/scripts/migrate-state.js [dir] [--planning] [--mark-read]
//   node plugins/anti-hall/scripts/migrate-state.js --restore-planning [--dir <wt>]
//   (dir defaults to process.cwd()). --planning = explicit copy-only GSD
//   .planning/ fold; --restore-planning = restore tracked .planning/ files the
//   pre-0.108.5 automatic fold moved out (see restorePlanning).
//
// EXPORT
//   migrateLegacyState({ dir }) -> Array<{ file, dest, action }>
//   action is one of: 'migrated' | 'skipped' | 'not-found'

const fs = require('fs');
const path = require('path');

const LEGACY_FILES = ['.anti-hall-progress.md', '.anti-hall-history.md'];

/**
 * migrateDevswarmStore({ dryRun }) — AUTOMATIC-BUT-SAFE migration of existing
 * on-disk DevSwarm state (JSON workspace registry + legacy NDJSON inboxes) into
 * the Phase-2 store. Wired here so an anti-hall update auto-migrates without a
 * manual step (owner directive: "read current state and migrate automatically").
 *
 * Delegates to companion/devswarm-migrate.js, which is idempotent,
 * NON-DESTRUCTIVE (dual-reads sources, never deletes them), single-consumer
 * locked, and count-verifies before reporting success. This state lives under
 * ~/.anti-hall/devswarm/ (HOME-scoped), not the repo `dir`, so it takes no dir
 * argument. Fail-soft: any error -> a report object, never a throw (an update
 * must never be bricked by a migration hiccup).
 *
 * dryRun — when true, DETECT ONLY (no lock, no writes to any SOURCE file):
 *   reports whether any workspace descriptor has legacy inbox content that is
 *   NOT YET present in its per-project store. Used by capability-scan.js-style
 *   gap reporting AND by doctor-repair.js's migrationFix re-verify loop.
 *
 * markRead — OPT-IN (default false; also settable via env
 *   ANTIHALL_DEVSWARM_MIGRATE_MARK_READ='1', see devswarm-migrate.js's
 *   resolveMarkRead). A legacy source with no consumed-cursor of its own
 *   (e.g. a pre-0.54 shell-loop NDJSON) otherwise imports its whole backlog at
 *   cursor 0, surfacing as a big "unread" wall that can trip the parent
 *   neglect-gate. When true, the JUST-imported backlog's cursor is advanced to
 *   its post-import message count so it reads as already-seen; a message that
 *   arrives after this migration call returns is unaffected and still
 *   surfaces as unread. Ignored when dryRun is true (nothing is written).
 *   DEFAULT behavior (markRead absent/false) is unchanged: the legacy cursor
 *   is preserved exactly as before.
 *
 *   IDEMPOTENT BY DESIGN (this is the fix for a real bug, not just a docstring):
 *   `pending` must NOT merely count descriptors — a migration is
 *   NON-DESTRUCTIVE, so a descriptor (and its legacy inbox) still exists on disk
 *   forever, even after a fully successful migrate. Counting descriptors alone
 *   made `pending` permanently true post-migration, which made doctor's
 *   migrationFix re-verify loop (`!after.pending ? fixed : failed`) report
 *   'failed' on every default run — a false FAILED on an otherwise-healthy
 *   machine. Instead, for each descriptor with a READABLE, non-empty legacy
 *   inbox, run devswarm-migrate's pendingLegacyLines against that workspace's
 *   per-project store — the SAME cross-path body-multiset identity migrateOne
 *   uses to decide which lines to import: only a descriptor with at least one
 *   line NOT YET covered counts as pending. A descriptor whose inbox is
 *   unreadable or empty contributes nothing migratable, so it is never pending
 *   (it can never be resolved by running migrate, so treating it as pending
 *   would reintroduce the same always-pending failure mode for that case).
 *
 *   PRIOR REGRESSION (fixed here too): an earlier version of this check tested
 *   raw legacyLineHash presence in the store. A cross-path dedupe in migrateOne
 *   (colliding a message copied by the global-store split with the SAME message
 *   mirrored in a descriptor's legacy inbox) intentionally skips writing that
 *   line's legacyLineHash once the store already holds an equivalent row under
 *   a different hash namespace (`native:*`/`global-migrate:*`) — so a raw
 *   hash-presence check saw that skipped line as "never migrated" and reported
 *   `pending:true` forever, even immediately after a real, verified migrate.
 *   pendingLegacyLines uses the EXACT identity migrateOne's import loop uses,
 *   so "imported" and "pending" can never disagree about the same line.
 *
 * Returns the migrate report ({ ok, action:'migrate', ... }) or, in dryRun, a
 * lightweight { action:'migrate', dryRun:true, pending, workspaces, pendingWorkspaces }.
 */
function migrateDevswarmStore({ dryRun, markRead } = {}) {
  let mod;
  try {
    mod = require('../companion/devswarm-migrate.js');
  } catch (e) {
    return { ok: false, action: 'migrate', error: 'devswarm-migrate unavailable: ' + (e && e.message) };
  }
  if (dryRun) {
    try {
      const os = require('os');
      const storeLib = require('../companion/lib/devswarm-store.js');
      const { readDescriptors } = require('../companion/devswarm-supervisor.js');
      const home = os.homedir();
      const descriptors = readDescriptors(home);
      let pendingWorkspaces = 0;
      for (const d of descriptors) {
        if (!d || !d.id) continue;
        const inbox = mod.readInbox(d.inboxPath);
        if (!inbox.readable || inbox.lines.length === 0) continue; // nothing this descriptor could contribute
        let stillPending = true; // store unreadable -> treat as not-yet-covered (fail toward pending)
        try {
          // readOnly (Phase 4c, #12): this is the `--dry-run` COUNT-ONLY path
          // (never calls migrateToStore/writes anything) — must not mkdir/CREATE
          // a store just to report how many workspaces are still pending. A
          // never-migrated-yet store (no store dir at all) is correctly still
          // "pending" (stillPending stays true, its initialized default), so a
          // null handle here needs no special case beyond the existing catch.
          const s = storeLib.openStore({ home, workspaceId: d.id, readOnly: true });
          try { stillPending = mod.pendingLegacyLines(s, d.id, inbox.lines).length > 0; }
          finally { try { s.close(); } catch (_) {} }
        } catch (_) { /* keep stillPending true */ }
        if (stillPending) pendingWorkspaces++;
      }
      return {
        action: 'migrate', dryRun: true,
        pending: pendingWorkspaces > 0,
        workspaces: descriptors.length,
        pendingWorkspaces,
      };
    } catch (e) {
      return { action: 'migrate', dryRun: true, pending: false, error: e && e.message };
    }
  }
  try {
    return mod.migrateToStore({ markRead });
  } catch (e) {
    return { ok: false, action: 'migrate', error: e && e.message };
  }
}

function safeWrite(destPath, content) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    '.' + path.basename(destPath) + '.tmp-' + process.pid + '-' + Date.now()
  );
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, destPath);
}

/**
 * migrateLegacyState({ dir, dryRun })
 *
 * dir — repo root to look in (default: cwd)
 * dryRun — when true, detect only: no write happens, and a file that would be
 *   migrated is reported as 'pending' instead of 'migrated'. Used by
 *   capability-scan.js to report gap state without mutating anything.
 *
 * Returns Array<{ file, dest, action }>. Idempotent: if the destination
 * already holds identical content, the source is left alone and 'skipped'
 * is reported instead of re-copying.
 */
function migrateLegacyState({ dir, dryRun } = {}) {
  const cwdArg = path.resolve(dir || process.cwd());
  // Resolve to the git toplevel via the ONE canonical resolver (companion/
  // lib/identity.js), not the raw `dir` -- a `dir` already inside
  // .anti-hall/**/... (e.g. a caller that forwards a hook payload's raw cwd)
  // must not double onto itself when joined with '.anti-hall/history/legacy'
  // below (same root cause as the 2026-09-25 PreCompact doubled-path bug;
  // see hooks/lib/handover-find.js). Falls back to the raw resolved `dir`
  // when it isn't a git repo, matching this function's pre-existing behavior.
  let root = cwdArg;
  try {
    const ctx = require('../companion/lib/identity.js').resolveContext(cwdArg, { missingPath: 'ancestor' });
    if (ctx && ctx.toplevel) root = ctx.toplevel;
  } catch (_) { /* fall through to raw resolved dir */ }
  const legacyDir = path.join(root, '.anti-hall', 'history', 'legacy');
  const results = [];

  for (const name of LEGACY_FILES) {
    const srcPath = path.join(root, name);
    const destPath = path.join(legacyDir, name);

    let srcContent;
    try {
      srcContent = fs.readFileSync(srcPath, 'utf8');
    } catch (_) {
      results.push({ file: name, dest: null, action: 'not-found' });
      continue;
    }

    let destContent = null;
    try {
      destContent = fs.readFileSync(destPath, 'utf8');
    } catch (_) {
      destContent = null;
    }

    if (destContent === srcContent) {
      results.push({ file: name, dest: destPath, action: 'skipped' });
      continue;
    }

    if (dryRun) {
      results.push({ file: name, dest: destPath, action: 'pending' });
      continue;
    }

    safeWrite(destPath, srcContent);
    results.push({ file: name, dest: destPath, action: 'migrated' });
  }

  return results;
}

/**
 * migrateGsdPlanning({ dir, dryRun })
 *
 * EXPLICIT, HUMAN-RUN ONLY (`migrate-state.js --planning`). Never wired into
 * doctor --repair, repair-on-reload, update.js or migrations.js: 0.108.5 P0 —
 * the old automatic version moved git-tracked `.planning/` files out of child
 * worktrees and submodules.
 *
 * COPY-ONLY: copies each `.planning/` file into
 * `.anti-hall/history/legacy/planning/` (relative structure kept). The source
 * is NEVER unlinked, renamed or removed, and an existing legacy copy with
 * DIFFERENT content is never overwritten (reported as 'conflict').
 *
 * Skips the whole tree (single 'unsafe-skip' entry with a `reason`) when:
 *   - `dir` is a linked (e.g. DevSwarm child) worktree, not the main checkout;
 *   - `dir` is inside a git submodule;
 *   - any `.planning/` file is tracked by git (already safe in git);
 *   - the location or tracking state cannot be confirmed (fail closed).
 *
 * Returns Array<{ file, dest, action, reason? }>, action one of:
 *   'copied' | 'pending' (dryRun) | 'skipped' (identical copy exists) |
 *   'conflict' | 'verify-failed' | 'not-found' | 'unsafe-skip'
 */
function walkFiles(root, rel) {
  const abs = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  let out = [];
  for (const e of entries) {
    const childRel = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      out = out.concat(walkFiles(root, childRel));
    } else if (e.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

const GIT_SCRUB_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'];

// git(dir, args, opts) -> { ok, stdout } — Buffer stdout when opts.buffer.
function git(dir, args, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env);
  for (const k of GIT_SCRUB_ENV) delete env[k];
  env.GIT_LITERAL_PATHSPECS = '1';
  try {
    const r = require('child_process').spawnSync('git', ['-C', dir].concat(args), {
      encoding: o.buffer ? 'buffer' : 'utf8', env, timeout: 30000, maxBuffer: 256 * 1024 * 1024,
      input: o.input,
    });
    if (!r || r.error || r.status !== 0) return { ok: false, stdout: null };
    return { ok: true, stdout: r.stdout };
  } catch (_) {
    return { ok: false, stdout: null };
  }
}

// planningUnsafeReason(root) -> null when an explicit copy is allowed, else why not.
function planningUnsafeReason(root) {
  let ctx;
  try {
    ctx = require('../companion/lib/identity.js').resolveContext(root, { memo: false });
  } catch (e) {
    return 'could not resolve the git location (' + (e && e.message) + ')';
  }
  if (!ctx || ctx.kind === 'deleted') return 'directory does not exist';
  if (ctx.uncertain) return 'git location could not be confirmed';
  if (String(ctx.kind).startsWith('submodule')) return 'inside a git submodule';
  if (ctx.kind === 'linked-worktree') return 'a linked (child) worktree, not the main checkout';
  if (ctx.kind === 'non-git') return null;
  if (ctx.kind !== 'main') return 'unrecognised git location kind ' + ctx.kind;
  const r = git(root, ['ls-files', '-z', '--', '.planning']);
  if (!r.ok) return 'could not check git tracking of .planning/';
  const tracked = r.stdout.split('\0').filter(Boolean).length;
  if (tracked > 0) return '.planning/ is tracked by git (' + tracked + ' file(s)) — already safe in git, nothing to fold';
  return null;
}

function migrateGsdPlanning({ dir, dryRun } = {}) {
  const root = path.resolve(dir || process.cwd());
  const planningDir = path.join(root, '.planning');
  const legacyDir = path.join(root, '.anti-hall', 'history', 'legacy', 'planning');

  let relFiles;
  try {
    relFiles = fs.statSync(planningDir).isDirectory() ? walkFiles(root, '.planning') : null;
  } catch (_) {
    relFiles = null;
  }

  if (relFiles == null) {
    return [{ file: '.planning', dest: null, action: 'not-found' }];
  }

  const reason = planningUnsafeReason(root);
  if (reason) return [{ file: '.planning', dest: null, action: 'unsafe-skip', reason }];

  const results = [];
  for (const rel of relFiles) {
    const srcPath = path.join(root, rel);
    const destRel = rel.slice('.planning/'.length);
    const destPath = path.join(legacyDir, destRel);

    let srcContent;
    try {
      srcContent = fs.readFileSync(srcPath);
    } catch (_) {
      continue; // unreadable — skip, never fail the whole run
    }

    let destContent = null;
    try {
      destContent = fs.readFileSync(destPath);
    } catch (_) {
      destContent = null;
    }

    if (destContent && destContent.equals(srcContent)) {
      results.push({ file: rel, dest: destPath, action: 'skipped' });
      continue;
    }
    if (destContent) {
      // Never overwrite an existing legacy copy — it may be the only copy.
      results.push({ file: rel, dest: destPath, action: 'conflict' });
      continue;
    }

    if (dryRun) {
      results.push({ file: rel, dest: destPath, action: 'pending' });
      continue;
    }

    safeWrite(destPath, srcContent);
    let verifyContent = null;
    try { verifyContent = fs.readFileSync(destPath); } catch (_) { verifyContent = null; }
    results.push({ file: rel, dest: destPath, action: verifyContent && verifyContent.equals(srcContent) ? 'copied' : 'verify-failed' });
  }

  return results;
}

// gitBlobId(buf, hexLen) -> the git object id of `buf` as a blob (sha1 or sha256 repo).
function gitBlobId(buf, hexLen) {
  const algo = hexLen === 64 ? 'sha256' : 'sha1';
  return require('crypto').createHash(algo)
    .update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex');
}

/**
 * findPlanningDamage({ dir }) -> { worktree, missing, safe: [{ file, legacy }] } | null
 *
 * READ-ONLY. Damage left by the pre-0.108.5 automatic fold: tracked
 * `.planning/` files missing from the work tree (git status " D") whose copy
 * under `<prefix>/.anti-hall/history/legacy/planning/` exists. `missing` counts
 * every missing tracked `.planning/` file (all restorable from git); `safe`
 * lists the ones whose legacy copy is byte-identical to HEAD. null when `dir`
 * is not a git work tree or nothing tracked under `.planning/` is missing.
 */
function findPlanningDamage({ dir } = {}) {
  let wt = null;
  try {
    wt = require('../companion/lib/identity.js').resolveContext(path.resolve(dir || process.cwd()), { memo: false }).toplevel;
  } catch (_) { wt = null; }
  if (!wt) return null;
  const del = git(wt, ['ls-files', '--deleted', '-z']);
  if (!del.ok) return null;
  const re = /^((?:[^/]+\/)*?)\.planning\/(.+)$/;
  const missing = [];
  for (const f of del.stdout.split('\0').filter(Boolean)) {
    const m = re.exec(f);
    if (m) missing.push({ file: f, legacy: path.join(wt, m[1], '.anti-hall', 'history', 'legacy', 'planning', m[2]) });
  }
  if (missing.length === 0) return null;
  const withCopy = missing.filter((x) => { try { return fs.statSync(x.legacy).isFile(); } catch (_) { return false; } });
  const head = new Map();
  if (withCopy.length) {
    const lt = git(wt, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--'].concat(withCopy.map((x) => x.file)));
    if (lt.ok) {
      for (const rec of lt.stdout.split('\0').filter(Boolean)) {
        const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(rec);
        if (m) head.set(m[2], m[1]);
      }
    }
  }
  const safe = withCopy.filter((x) => {
    const id = head.get(x.file);
    if (!id) return false;
    try { return gitBlobId(fs.readFileSync(x.legacy), id.length) === id; } catch (_) { return false; }
  });
  return { worktree: wt, missing: missing.length, withCopy: withCopy.length, safe };
}

/**
 * restorePlanning({ dir }) -> { worktree, restored: [file], skipped: n } | null
 *
 * EXPLICIT, HUMAN-RUN ONLY (`migrate-state.js --restore-planning`). Writes back
 * ONLY the files findPlanningDamage marks safe (missing, tracked, legacy copy
 * byte-identical to HEAD), and only when the path is still absent at write
 * time. The legacy copies are never deleted.
 */
function restorePlanning({ dir } = {}) {
  const d = findPlanningDamage({ dir });
  if (!d) return null;
  const restored = [];
  for (const x of d.safe) {
    const dest = path.join(d.worktree, x.file);
    try {
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(x.legacy, dest, fs.constants.COPYFILE_EXCL);
      restored.push(x.file);
    } catch (_) { /* left missing; git checkout remains the fallback */ }
  }
  return { worktree: d.worktree, restored, skipped: d.missing - restored.length };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  // Flags (all opt-in): --mark-read (see migrateDevswarmStore), --planning
  // (copy-only GSD fold), --restore-planning [--dir <wt>]. The positional
  // `dir` skips flags, so `node migrate-state.js --mark-read` defaults to cwd.
  const argv = process.argv.slice(2);
  const markReadFlag = argv.includes('--mark-read');
  const planningFlag = argv.includes('--planning');
  const restoreFlag = argv.includes('--restore-planning');
  const dirIdx = argv.indexOf('--dir');
  const dir = (dirIdx >= 0 && argv[dirIdx + 1])
    || argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--dir') || process.cwd();

  if (restoreFlag) {
    const r = restorePlanning({ dir });
    if (!r) {
      console.log('no missing tracked .planning/ files in ' + path.resolve(dir));
    } else {
      for (const f of r.restored) console.log('restored ' + f);
      console.log('restored ' + r.restored.length + ' file(s) in ' + r.worktree +
        (r.skipped ? '; ' + r.skipped + ' missing file(s) had no byte-identical legacy copy — restore them from git: git -C "' + r.worktree + '" checkout -- .planning' : '') +
        '. Legacy copies under .anti-hall/history/legacy/planning/ were left in place.');
    }
    process.exit(0);
  }

  const results = migrateLegacyState({ dir });

  const anyFound = results.some((r) => r.action !== 'not-found');
  if (!anyFound) {
    console.log('no legacy files found');
  } else {
    for (const r of results) {
      if (r.action === 'migrated') {
        console.log('migrated ' + r.file + ' -> ' + path.relative(dir, r.dest));
      } else if (r.action === 'skipped') {
        console.log('already migrated, skipping: ' + r.file);
      }
    }
  }

  if (planningFlag) {
    const gsdResults = migrateGsdPlanning({ dir });
    const count = (a) => gsdResults.filter((r) => r.action === a).length;
    if (gsdResults[0] && gsdResults[0].action === 'not-found') {
      console.log('no .planning/ (GSD) directory found');
    } else if (gsdResults[0] && gsdResults[0].action === 'unsafe-skip') {
      console.log('GSD .planning/ fold skipped: ' + gsdResults[0].reason + '. Nothing was copied or changed.');
    } else {
      console.log('GSD .planning/ -> .anti-hall/history/legacy/planning/: ' +
        count('copied') + ' file(s) copied, ' + count('skipped') + ' already up to date' +
        (count('conflict') ? ', ' + count('conflict') + ' CONFLICT (a different legacy copy exists; left untouched)' : '') +
        (count('verify-failed') ? ', ' + count('verify-failed') + ' FAILED VERIFICATION' : '') +
        '. Copy-only: the .planning/ files are never deleted or moved.');
    }
  }

  // DevSwarm store auto-migration (HOME-scoped, idempotent + non-destructive).
  // markReadFlag: true forces the opt-in on; otherwise undefined so the
  // ANTIHALL_DEVSWARM_MIGRATE_MARK_READ env var (if set) still applies.
  const ds = migrateDevswarmStore({ markRead: markReadFlag ? true : undefined });
  if (ds && ds.ok && ds.action === 'migrate') {
    if (!ds.workspaces) {
      console.log('DevSwarm store: no on-disk workspace registry to migrate');
    } else {
      console.log('DevSwarm store: migrated ' + ds.workspaces + ' workspace(s) into the ' +
        ds.backend + ' backend' + (ds.verifiedAll ? ' (all counts verified)' : ' (SOME COUNTS UNVERIFIED — sources kept)') +
        (ds.markRead ? ' [--mark-read: imported backlog marked as already-read]' : ''));
    }
  } else if (ds && ds.locked === false) {
    console.log('DevSwarm store: another migration/consumer holds the lock — skipped this run');
  } else if (ds && ds.error) {
    console.log('DevSwarm store: migration skipped (' + ds.error + ')');
  }
}

/**
 * migrateReplyState({ dryRun, home }) — forward-migration for the DevSwarm
 * parent-gate reply-state files (Task #4): converts every existing
 * ~/.anti-hall/devswarm/parent-gate/*-replies.json from the legacy single-
 * merged-object shape to the new append-only JSONL shape, losslessly.
 * Delegates ENTIRELY to devswarm-reply-state.js's own migrateReplyState (one
 * code path for BOTH the doctor-repair migrationFix here and update.js's
 * post-update pass, and for the dry-run detect + the apply). Idempotent,
 * fail-open (never throws — a missing module or any error yields a zeroed
 * report), NO-DELETE (the fold preserves every sender's max lastReplyTs).
 *
 * Returns the reply-state module's report ({ scanned, migrated,
 * alreadyAppendOnly, pending, errors }).
 */
function migrateReplyState({ dryRun, home } = {}) {
  const empty = { scanned: 0, migrated: 0, alreadyAppendOnly: 0, pending: 0, errors: 0 };
  try {
    const mod = require('../companion/lib/devswarm-reply-state.js');
    if (!mod || typeof mod.migrateReplyState !== 'function') return empty;
    const h = home || require('os').homedir();
    return mod.migrateReplyState(h, { dryRun: !!dryRun }) || empty;
  } catch (_) {
    return empty;
  }
}

/**
 * migrateGateIntents({ dryRun, home }) — forward-migration for the
 * devswarm-parent-gate.js stated-intent persisted-shape change: every
 * existing ~/.anti-hall/devswarm/parent-gate/<session>.json gate-loop-state
 * file (NOT the `*-replies.json` reply-state files migrateReplyState above
 * handles) gets `intents: {}` / `intentAcks: 0` added if either key is
 * missing, with every other field preserved byte-for-byte. Delegates
 * ENTIRELY to devswarm-gate-state.js's own migrateGateIntentsShape (one code
 * path for BOTH the doctor-repair migrationFix and update.js's post-update
 * pass, and for the dry-run detect + the apply). Idempotent, fail-open
 * (never throws — a missing module or any error yields a zeroed report),
 * NO-DELETE. This is a courtesy normalization, not a correctness
 * prerequisite: the hook itself already defaults a missing
 * `intents`/`intentAcks` to `{}`/`0` on read, so a pre-migration file keeps
 * working unchanged even if this migration never runs.
 *
 * Returns the gate-state module's report ({ scanned, migrated,
 * alreadyCurrent, pending, errors }).
 */
function migrateGateIntents({ dryRun, home } = {}) {
  const empty = { scanned: 0, migrated: 0, alreadyCurrent: 0, pending: 0, errors: 0 };
  try {
    const mod = require('../companion/lib/devswarm-gate-state.js');
    if (!mod || typeof mod.migrateGateIntentsShape !== 'function') return empty;
    const h = home || require('os').homedir();
    return mod.migrateGateIntentsShape(h, { dryRun: !!dryRun }) || empty;
  } catch (_) {
    return empty;
  }
}

/**
 * migrateAutoArchivedState({ dryRun, home }) — forward-migration seeding the
 * durable gate-(h) state file (<home>/.anti-hall/devswarm/auto-archived.json)
 * from any successful `auto-archive` records already in
 * devswarm-auto-archive.ndjson that predate it. Delegates ENTIRELY to
 * companion/lib/devswarm-lifecycle.js's own migrateAutoArchivedState (one
 * code path for BOTH the doctor-repair migrationFix and update.js's post-
 * update pass, and for the dry-run detect + the apply). Idempotent (a
 * (id, doneHead) pair already in the durable file is never re-added),
 * fail-open (a missing/unreadable log yields an all-zero report), NO-DELETE
 * (the ndjson log itself is never touched — this only ever ADDS to the
 * durable file). Not a correctness prerequisite: autoArchivedAt() already
 * falls back to reading the ndjson log directly for anything this migration
 * has not (yet) backfilled, so gate (h) keeps working even if this migration
 * never runs.
 *
 * Returns { scanned, migrated, pending, errors }.
 */
function migrateAutoArchivedState({ dryRun, home } = {}) {
  const empty = { scanned: 0, migrated: 0, pending: 0, errors: 0 };
  try {
    const mod = require('../companion/lib/devswarm-lifecycle.js');
    if (!mod || typeof mod.migrateAutoArchivedState !== 'function') return empty;
    const h = home || require('os').homedir();
    return mod.migrateAutoArchivedState(h, { dryRun: !!dryRun }) || empty;
  } catch (_) {
    return empty;
  }
}

module.exports = {
  migrateLegacyState, migrateGsdPlanning, migrateDevswarmStore, migrateReplyState, migrateGateIntents,
  migrateAutoArchivedState, findPlanningDamage, restorePlanning,
};
