'use strict';
// archived-predicates-single-projection — hygiene ratchet for the recurring
// "archived rows still counted / blocking / resurrected" class (v0.110).
// Every ROW-level "is this archived / held / ignored?" question must go through
// companion/lib/row-eligibility.js, which combines every source at once. A
// consumer that calls one predicate directly filters one axis and forgets the
// others — the shape of the 7457a05 -> c81dc46 -> 9d04dc8 -> fabad95 chain.
// This test scans plugins/anti-hall (Claude + codex/ port) for direct calls to
// the archived predicates outside the projection and the helper modules it
// wraps. ALLOWLIST = the remaining legitimate call sites, per file + pattern,
// EXACT count, each with its reason:
//   - a NEW call (count above the allowlist) fails: use row-eligibility.js;
//   - a REMOVED call (count below) also fails: shrink the allowlist in the same
//     change, so the ratchet only moves toward empty.
// Comment lines (// ..., /* ..., * ...) and `function name(` definitions are
// skipped.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
// The projection and the helper modules it wraps (the predicates' own homes).
const EXEMPT = new Set([
  'companion/lib/row-eligibility.js',
  'companion/lib/row-state.js',
  'companion/lib/devswarm-archived.js',
  'companion/lib/devswarm-archived-cache.js',
  'companion/lib/devswarm-app-db.js',
]);

const call = (name) => new RegExp('(?<!function\\s)(?<![\\w$])' + name + '\\s*\\(', 'g');
const PATTERNS = {
  rowState: call('rowState'),
  isRowArchived: call('isRowArchived'),
  isArchivedWorkspace: call('isArchivedWorkspace'),
  isAppArchived: call('isAppArchived'),
  appArchivedVerdict: call('appArchivedVerdict'),
  isArchivedStranded: call('isArchivedStranded'),
  makeArchivedStrandedTest: call('makeArchivedStrandedTest'),
  archivedOnlyIds: call('archivedOnlyIds'),
  isArchiveComplete: call('isArchiveComplete'),
  archiveCompleteIds: call('archiveCompleteIds'),
  heldPartitionIdsFrom: call('heldPartitionIdsFrom'),
  // a hand-built archive-ignore/<id>.json path (the marker row-eligibility reads)
  'archive-ignore-path': /join\(.*['"]archive-ignore['"]/g,
};

// ALLOWLIST: 'relative/file.js': { pattern: count } — every entry carries its reason.
const ALLOWLIST = {
  // PARTITION-level store projection (computeSummary / orphans), not a workspace
  // row: archived-only tombstones, archived-stranded orphans and owner-held
  // partitions are bucketed per mesh partition id.
  'companion/lib/devswarm-store.js': {
    archivedOnlyIds: 1, // computeSummary's registry filter (definition wraps archiveCompleteIds)
    archiveCompleteIds: 1, // archivedOnlyIds' body
    makeArchivedStrandedTest: 1, // orphans[] projection
    isArchivedStranded: 1, // orphans[] projection
    heldPartitionIdsFrom: 1, // orphans[] -> heldPartitions[]
  },
  'scripts/devswarm.js': {
    // WRITE guards that must consult the app DB ONLY (ground truth), never the
    // anti-hall marker or the active-list cache: sync-ui's archive/delete
    // mirror, cmdRegister's and cmdHeartbeat's archived-workspace refusals,
    // reconcile-active's candidate scan.
    appArchivedVerdict: 4,
    // isArchivedOnlyWorkspace: the STRICTER "archive finished" demote test
    // (marker present AND active descriptor gone) the roster and move paths use.
    isArchiveComplete: 1,
    // reap-orphans: partition-level defense-in-depth (see devswarm-store.js).
    heldPartitionIdsFrom: 1,
    // archiveIgnoreDir: the `archive-ignore` verb's own writer/remover of the marker.
    'archive-ignore-path': 1,
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

function scanText(text) {
  const found = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    for (const [name, re] of Object.entries(PATTERNS)) {
      const m = line.match(re);
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
    const f = scanText(fs.readFileSync(abs, 'utf8'));
    if (Object.keys(f).length) found[rel] = f;
  }
  return found;
}

module.exports = { scan };

if (require.main === module && process.argv.includes('--print')) {
  console.log(JSON.stringify(scan(), null, 2));
} else {
  test('no direct archived-predicate call outside row-eligibility.js beyond the allowlist', () => {
    const found = scan();
    const problems = [];
    const files = new Set([...Object.keys(found), ...Object.keys(ALLOWLIST)]);
    for (const f of [...files].sort()) {
      const pats = new Set([...Object.keys(found[f] || {}), ...Object.keys(ALLOWLIST[f] || {})]);
      for (const p of pats) {
        const have = (found[f] || {})[p] || 0;
        const allowed = (ALLOWLIST[f] || {})[p] || 0;
        if (have > allowed) problems.push(`NEW ${p} in ${f}: ${have} > allowlisted ${allowed} — use companion/lib/row-eligibility.js`);
        else if (have < allowed) problems.push(`STALE allowlist ${p} in ${f}: ${have} < ${allowed} — shrink the allowlist`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });

  test('scanner is not vacuous: it sees planted calls, skips comments and definitions', () => {
    const src = [
      'const a = rowStateLib.isRowArchived({ home, id });',
      '// isRowArchived(opts) in a comment',
      'function isRowArchived(opts) {',
      "fs.statSync(path.join(root, 'archive-ignore', id + '.json'));",
      'const b = myisAppArchivedX(1);',
    ].join('\n');
    const f = scanText(src);
    assert.strictEqual(f.isRowArchived, 1);
    assert.strictEqual(f['archive-ignore-path'], 1);
    assert.strictEqual(f.isAppArchived, undefined, 'identifier boundaries respected');
  });
}
