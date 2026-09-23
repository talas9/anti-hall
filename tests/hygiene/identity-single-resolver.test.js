'use strict';
// identity-single-resolver — mesh redesign Phase 2 hygiene ratchet (B0).
// Every "where am I" resolver must live in companion/lib/identity.js (location)
// or companion/lib/reader-identity.js (reader). This test scans plugins/anti-hall
// (Claude + codex/ port) for resolver patterns outside those two files.
// ALLOWLIST = every occurrence present at B0, per file + pattern, EXACT count:
//   - a NEW occurrence (count above the allowlist) fails: route it through identity.js;
//   - a REMOVED occurrence (count below) also fails: shrink the allowlist in the
//     same change, so the ratchet only moves toward empty (B6 target: no entries).
// Comment lines (// ..., /* ..., * ...) are skipped; the flags are named in docs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const EXEMPT = new Set(['companion/lib/identity.js', 'companion/lib/reader-identity.js']);

const PATTERNS = {
  'show-toplevel': /['"]--show-toplevel['"]/g,
  'git-common-dir': /['"]--git-common-dir['"]/g,
  'show-superproject': /['"]--show-superproject-working-tree['"]/g,
  'stat-dotgit': /(?:l?stat|exists)Sync\([^)]*['"]\.git['"]/g,
  'fn-findGitToplevel': /function\s+findGitToplevel\w*\s*\(/g,
  'primaryWorkspaceId-call': /\bprimaryWorkspaceId\(/g,
};

// ALLOWLIST: 'relative/file.js': { pattern: count }. Shrink per batch (B1..B6).
const ALLOWLIST = {
  'companion/devswarm-ingest.js': { 'primaryWorkspaceId-call': 1 },
  'companion/install-devswarm-ingest.js': { 'show-toplevel': 1, 'primaryWorkspaceId-call': 1 },
  'companion/lib/devswarm-repokey.js': { 'git-common-dir': 1, 'show-superproject': 1 },
  'companion/lib/devswarm-store.js': { 'primaryWorkspaceId-call': 1 },
  'companion/lib/devswarm-wake-watch.js': { 'primaryWorkspaceId-call': 2 },
  'companion/lib/liveness.js': { 'primaryWorkspaceId-call': 1 },
  'companion/lib/recovery.js': { 'primaryWorkspaceId-call': 1 },
  'hooks/command-guard.js': { 'fn-findGitToplevel': 1, 'stat-dotgit': 1 },
  'hooks/devswarm-child-gate.js': { 'fn-findGitToplevel': 1, 'stat-dotgit': 1 },
  'hooks/devswarm-child-turn.js': { 'fn-findGitToplevel': 1, 'stat-dotgit': 1 },
  'hooks/devswarm-parent-gate.js': { 'fn-findGitToplevel': 1, 'stat-dotgit': 1, 'primaryWorkspaceId-call': 1 },
  'hooks/devswarm-parent-inbox.js': { 'fn-findGitToplevel': 1, 'stat-dotgit': 1, 'primaryWorkspaceId-call': 2 },
  'hooks/devswarm-parent-reply-tracker.js': { 'fn-findGitToplevel': 1, 'stat-dotgit': 1 },
  'hooks/lib/doctor-repair.js': { 'show-toplevel': 1 },
  'scripts/devswarm.js': { 'fn-findGitToplevel': 1, 'stat-dotgit': 1, 'show-superproject': 1, 'primaryWorkspaceId-call': 17, 'show-toplevel': 1 },
  'statusline/statusline-rich.js': { 'show-toplevel': 1 },
  'statusline/statusline.js': { 'show-toplevel': 1 },
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

function scan() {
  const found = {};
  for (const abs of walk(PLUGIN_ROOT, [])) {
    const rel = path.relative(PLUGIN_ROOT, abs).split(path.sep).join('/');
    if (EXEMPT.has(rel)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
      for (const [name, re] of Object.entries(PATTERNS)) {
        const m = line.match(re);
        if (!m) continue;
        found[rel] = found[rel] || {};
        found[rel][name] = (found[rel][name] || 0) + m.length;
      }
    }
  }
  return found;
}

module.exports = { scan };

if (require.main === module && process.argv.includes('--print')) {
  console.log(JSON.stringify(scan(), null, 2));
} else {
  test('no identity resolver outside identity.js / reader-identity.js beyond the B0 allowlist', () => {
    const found = scan();
    const problems = [];
    const files = new Set([...Object.keys(found), ...Object.keys(ALLOWLIST)]);
    for (const f of [...files].sort()) {
      const pats = new Set([...Object.keys(found[f] || {}), ...Object.keys(ALLOWLIST[f] || {})]);
      for (const p of pats) {
        const have = (found[f] || {})[p] || 0;
        const allowed = (ALLOWLIST[f] || {})[p] || 0;
        if (have > allowed) problems.push(`NEW ${p} in ${f}: ${have} > allowlisted ${allowed} — resolve via companion/lib/identity.js`);
        else if (have < allowed) problems.push(`STALE allowlist ${p} in ${f}: ${have} < ${allowed} — shrink the allowlist`);
      }
    }
    assert.deepStrictEqual(problems, []);
  });

  test('scanner is not vacuous: it sees a planted occurrence and skips comment lines', () => {
    const src = ["const a = spawnSync('git', ['rev-parse', '--show-toplevel']);", "// '--show-toplevel' in a comment"].join('\n');
    const hits = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').match(PATTERNS['show-toplevel']);
    assert.strictEqual(hits.length, 1);
    assert.ok(Object.keys(ALLOWLIST).length > 0);
  });
}
