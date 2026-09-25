'use strict';
// lock-single-primitive — hygiene ratchet: every cross-process lock file goes
// through companion/lib/lock.js (publish, torn-read guard, atomic reclaim,
// token-checked release). About a dozen hand-written copies each re-derived
// that design and several shipped the same races (blind-unlink reclaim, an
// empty mid-write holder read as stale, blind release). This scans
// plugins/anti-hall (Claude + codex/ port) outside lock.js for lock code:
//   - excl-create:  ANY O_EXCL create ('wx' flag or O_EXCL) — the lock-publish primitive;
//   - link:         ANY linkSync — the write-then-link publish primitive;
//   - unlink-lock:  unlinkSync on a line naming a lock (a hand-written stale
//                   reclaim or blind release deletes the lock file directly).
// Non-lock uses of the first two (exclusive-create markers, atomic moves) are
// allowlisted below with their reason.
// ALLOWLIST = the occurrences that must stay, per file + pattern, EXACT count,
// each with its reason. A NEW occurrence fails (use lock.js); a REMOVED one
// also fails (shrink the allowlist) — the count only goes down.
// Comment lines (// ..., /* ..., * ...) are skipped.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const EXEMPT = new Set(['companion/lib/lock.js']);

const LOCKISH = /lock/i;
// Any O_EXCL create or hard link is a lock-shaped primitive, so EVERY one is
// counted (not only lock-named lines) and the non-lock uses are allowlisted
// with their reason; a direct unlink is only counted on a lock-named line.
const PATTERNS = {
  'excl-create': { re: /['"]wx['"]|\bO_EXCL\b/g, lockOnly: false },
  'link': { re: /\blinkSync\s*\(/g, lockOnly: false },
  'unlink-lock': { re: /\bunlinkSync\s*\(/g, lockOnly: true },
};

// ALLOWLIST: 'relative/file.js': { pattern: { count, reason } }.
const ALLOWLIST = {
  // None of these is a lock: each is a one-shot exclusive create of a DATA file
  // (never overwrite an existing one), or an atomic same-filesystem move. No
  // holder, no staleness, no reclaim, no release — nothing lock.js models.
  'companion/lib/devswarm-read-wal.js': {
    'excl-create': { count: 2, reason: 'read-WAL spill + last-resort spill files: each entry id is unique, O_EXCL only refuses to overwrite a spilled entry' },
  },
  'hooks/lib/defect-store.js': {
    'excl-create': { count: 1, reason: 'defect report files are created once (O_EXCL refuses to clobber an existing report) then appended' },
  },
  'hooks/precompact-snapshot.js': {
    'excl-create': { count: 1, reason: 'PRECOMPACT-<n>.md snapshots are never overwritten; a concurrent run with the same n just skips' },
  },
  'scripts/devswarm-store-leak-report.js': {
    'excl-create': { count: 1, reason: 'report --out file: O_EXCL|O_NOFOLLOW new-file open so a symlink or existing file is never followed or clobbered' },
  },
  'scripts/devswarm.js': {
    'excl-create': { count: 4, reason: 'archived/ tombstone markers (3) and the per-child cursor seed file (1): create-if-absent data files, never locks' },
    link: { count: 4, reason: 'archive/unarchive/heal descriptor moves: linkSync is the exclusive same-filesystem move (fails closed on EEXIST instead of renameSync clobbering)' },
  },
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

function scanSource(src) {
  const found = {};
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    const code = line.replace(/\/\/.*$/, ''); // drop a trailing line comment
    const lockish = LOCKISH.test(code);
    for (const [name, { re, lockOnly }] of Object.entries(PATTERNS)) {
      if (lockOnly && !lockish) continue;
      const m = code.match(re);
      if (m) found[name] = (found[name] || 0) + m.length;
    }
  }
  return found;
}

function scan() {
  const found = {};
  for (const abs of walk(PLUGIN_ROOT, [])) {
    const rel = path.relative(PLUGIN_ROOT, abs).split(path.sep).join('/');
    if (EXEMPT.has(rel)) continue;
    const hits = scanSource(fs.readFileSync(abs, 'utf8'));
    if (Object.keys(hits).length) found[rel] = hits;
  }
  return found;
}

module.exports = { scan, scanSource };

if (require.main === module && process.argv.includes('--print')) {
  console.log(JSON.stringify(scan(), null, 2));
} else {
  test('no hand-written lock code outside companion/lib/lock.js beyond the allowlist', () => {
    const found = scan();
    const problems = [];
    const files = new Set([...Object.keys(found), ...Object.keys(ALLOWLIST)]);
    for (const f of [...files].sort()) {
      const pats = new Set([...Object.keys(found[f] || {}), ...Object.keys(ALLOWLIST[f] || {})]);
      for (const p of pats) {
        const have = (found[f] || {})[p] || 0;
        const allowed = ((ALLOWLIST[f] || {})[p] || {}).count || 0;
        if (have > allowed) problems.push(`NEW ${p} in ${f}: ${have} > allowlisted ${allowed} — use companion/lib/lock.js (acquire/release/withLock/reclaimStale)`);
        else if (have < allowed) problems.push(`STALE allowlist ${p} in ${f}: ${have} < ${allowed} — shrink the allowlist`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });

  test('every allowlist entry carries a reason', () => {
    for (const [f, pats] of Object.entries(ALLOWLIST)) {
      for (const [p, v] of Object.entries(pats)) {
        assert.ok(v && typeof v.reason === 'string' && v.reason.length > 20, `${f} ${p} needs a reason`);
      }
    }
  });

  test('scanner is not vacuous: it sees planted lock code and skips comments and non-lock lines', () => {
    const planted = [
      "const fd = fs.openSync(lockPath, 'wx');",
      "fs.writeFileSync(p + '.lock', body, { flag: 'wx' });",
      'F.linkSync(tmp, lockFile);',
      'try { fs.unlinkSync(LOCK_FILE); } catch (_) {}',
      "// fs.openSync(lockPath, 'wx') in a comment",
      "fs.writeFileSync(marker, body, { flag: 'wx' }); // not a lock",
      'fs.linkSync(activePath, archivedPath);',
    ].join('\n');
    assert.deepStrictEqual(scanSource(planted), { 'excl-create': 3, link: 2, 'unlink-lock': 1 });
    // lock.js itself is the one place these belong.
    const own = scanSource(fs.readFileSync(path.join(PLUGIN_ROOT, 'companion', 'lib', 'lock.js'), 'utf8'));
    assert.ok((own.link || 0) > 0 && (own['excl-create'] || 0) > 0, 'lock.js is exempt, not invisible to the scanner');
  });
}
