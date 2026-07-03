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
}

module.exports = { migrateLegacyState };
