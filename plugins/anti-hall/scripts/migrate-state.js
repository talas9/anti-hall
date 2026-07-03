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
 * migrateLegacyState({ dir })
 *
 * dir — repo root to look in (default: cwd)
 *
 * Returns Array<{ file, dest, action }>. Idempotent: if the destination
 * already holds identical content, the source is left alone and 'skipped'
 * is reported instead of re-copying.
 */
function migrateLegacyState({ dir } = {}) {
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
 *
 * Returns Array<{ file, dest, action }>, action one of:
 *   'migrated'      — copied, verified, source file deleted
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

function migrateGsdPlanning({ dir } = {}) {
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
  const dir = process.argv[2] || process.cwd();
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
}

module.exports = { migrateLegacyState, migrateGsdPlanning };
