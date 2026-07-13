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
//   node plugins/anti-hall/scripts/migrate-state.js [dir]
//   (dir defaults to process.cwd())
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
          const s = storeLib.openStore({ home, workspaceId: d.id });
          try { stillPending = mod.pendingLegacyLines(s, d.id, inbox.lines).length > 0; }
          finally { s.close(); }
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
  const root = path.resolve(dir || process.cwd());
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
 * migrateGsdPlanning({ dir })
 *
 * Folds a GSD (Get-Shit-Done) `.planning/` tree into
 * `.anti-hall/history/legacy/planning/`, preserving relative structure.
 * Owner decision (2026-07-03): GSD is discontinued, and anti-hall's
 * `.anti-hall/` convention supersedes `.planning/` going forward.
 *
 * DELETE POLICY (owner-confirmed, 2026-07-03): once a file's copy is
 * VERIFIED byte-identical at the destination, the SOURCE FILE is deleted —
 * but the `.planning/` directory itself (and any subdirectory) is NEVER
 * removed, only the individual files inside it, one at a time, each only
 * after its own copy is confirmed. A file whose copy cannot be verified is
 * left in place (never deleted) and reported as 'verify-failed', not
 * silently swallowed. This is deliberately narrower than "rm -rf .planning/":
 * no directory is ever unlinked, so a partial run (crash, permission error
 * partway through) can never leave `.planning/` missing — only progressively
 * emptied of files that are safely duplicated elsewhere.
 *
 * dir — repo root to look in (default: cwd)
 * dryRun — when true, detect only: no write/delete happens, and a file that
 *   would be migrated is reported as 'pending' instead of 'migrated'.
 *
 * Returns Array<{ file, dest, action }>, action one of:
 *   'migrated'      — copied, verified, source file deleted
 *   'pending'       — (dryRun only) would migrate; nothing written
 *   'skipped'       — destination already holds identical content (idempotent
 *                     re-run); source is NOT deleted here (a prior run already
 *                     deleted it, or this is a second independent source with
 *                     the same content — never delete on a 'skipped' path)
 *   'verify-failed' — copy written but re-read didn't match; source kept
 *   'not-found'     — `.planning/` does not exist (single entry, whole-run)
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

  const results = [];
  for (const rel of relFiles) {
    const srcPath = path.join(root, rel);
    const destRel = rel.slice('.planning/'.length);
    const destPath = path.join(legacyDir, destRel);

    let srcContent;
    try {
      srcContent = fs.readFileSync(srcPath, 'utf8');
    } catch (_) {
      continue; // unreadable (e.g. binary/permission) — skip, never fail the whole run
    }

    let destContent = null;
    try {
      destContent = fs.readFileSync(destPath, 'utf8');
    } catch (_) {
      destContent = null;
    }

    if (destContent === srcContent) {
      // Destination already matches — a prior run already migrated (and
      // deleted) this file, or a different source produced identical
      // content. Either way, never delete on this path: we did not just
      // write+verify a fresh copy in THIS call.
      results.push({ file: rel, dest: destPath, action: 'skipped' });
      continue;
    }

    if (dryRun) {
      results.push({ file: rel, dest: destPath, action: 'pending' });
      continue;
    }

    safeWrite(destPath, srcContent);

    // Verify before deleting: re-read the just-written destination and
    // require an exact match to what was read from source. Only a
    // confirmed-identical copy authorizes deleting the source file.
    let verifyContent;
    try {
      verifyContent = fs.readFileSync(destPath, 'utf8');
    } catch (_) {
      verifyContent = null;
    }

    if (verifyContent !== srcContent) {
      results.push({ file: rel, dest: destPath, action: 'verify-failed' });
      continue; // never delete an unverified copy
    }

    try {
      fs.unlinkSync(srcPath); // delete ONLY this file — never the containing directory
      results.push({ file: rel, dest: destPath, action: 'migrated' });
    } catch (_) {
      // Copy is verified-good even though the source delete failed (e.g.
      // permission error) — report as migrated (the data is safely
      // duplicated), the leftover source file is harmless and can be
      // cleaned up on a later run.
      results.push({ file: rel, dest: destPath, action: 'migrated' });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  // --mark-read is an opt-in flag (see migrateDevswarmStore's markRead doc
  // above) — strip it from argv before reading the positional `dir` arg so
  // `node migrate-state.js --mark-read` (no dir) still defaults dir to cwd.
  const argv = process.argv.slice(2);
  const markReadFlag = argv.includes('--mark-read');
  const dir = argv.find((a) => a !== '--mark-read') || process.cwd();
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

  const gsdResults = migrateGsdPlanning({ dir });
  const gsdFound = gsdResults.some((r) => r.action !== 'not-found');
  if (!gsdFound) {
    console.log('no .planning/ (GSD) directory found');
  } else {
    const migrated = gsdResults.filter((r) => r.action === 'migrated').length;
    const skipped = gsdResults.filter((r) => r.action === 'skipped').length;
    const verifyFailed = gsdResults.filter((r) => r.action === 'verify-failed').length;
    console.log('GSD .planning/ -> .anti-hall/history/legacy/planning/: ' +
      migrated + ' file(s) migrated (copy verified, source deleted), ' +
      skipped + ' already up to date' +
      (verifyFailed ? ', ' + verifyFailed + ' FAILED VERIFICATION (source kept, not deleted)' : '') +
      '. The .planning/ directory itself is never removed.');
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

module.exports = { migrateLegacyState, migrateGsdPlanning, migrateDevswarmStore };
