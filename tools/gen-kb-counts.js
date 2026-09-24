#!/usr/bin/env node
'use strict';
// tools/gen-kb-counts.js — regenerate the component counts in docs/KB.md's
// "Re-verified against the working tree" note from disk, so they cannot drift
// (a hand-edited "59 hooks" sat next to 61 files on disk):
//   Hooks: **N** `.js` files      <- plugins/anti-hall/hooks/*.js
//   N scripts registered in `hooks.json`, M of them also in `codex/hooks/hooks.json`
//   Claude skills: **N**          <- plugins/anti-hall/skills/*/
//   Codex skills: **N**           <- plugins/anti-hall/codex/skills/*/
// The "Hooks: **N** `.js` files" and "Claude skills: **N**" shapes are what
// hooks/repo-self-drift.js parses at runtime (HOOKS_CLAIM_RE / SKILLS_CLAIM_RE);
// this tool only rewrites the numbers, never the shapes.
// Usage: node tools/gen-kb-counts.js          (rewrite docs/KB.md in place)
//        node tools/gen-kb-counts.js --check  (exit 1 when docs/KB.md is stale)
// tests/hygiene/docs-coverage.test.js runs the --check logic.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const P = (...p) => path.join(REPO, 'plugins', 'anti-hall', ...p);
const KB = path.join(REPO, 'docs', 'KB.md');

function registered(manifest) {
  const j = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const s = new Set();
  for (const groups of Object.values(j.hooks || {})) {
    for (const g of groups) {
      for (const h of g.hooks || []) {
        const m = /hooks\/([\w.-]+\.js)/.exec(h.command || '');
        if (m) s.add(m[1]);
      }
    }
  }
  return s;
}

function counts() {
  const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  const claude = registered(P('hooks', 'hooks.json'));
  const codex = registered(P('codex', 'hooks', 'hooks.json'));
  return {
    hooks: fs.readdirSync(P('hooks')).filter((f) => f.endsWith('.js')).length,
    registered: claude.size,
    alsoCodex: [...claude].filter((f) => codex.has(f)).length,
    claudeSkills: dirs(P('skills')),
    codexSkills: dirs(P('codex', 'skills')),
  };
}

// build(text) -> text with every count replaced; throws when a shape is missing
// (a reworded note must be updated here too, never silently skipped).
function build(text) {
  const c = counts();
  const subs = [
    [/(Hooks:\s*\*\*)\d+(\*\*\s*`\.js`\s*files)/, c.hooks],
    [/(;\s*)\d+(\s+scripts registered in\s*\n?>?\s*`hooks\.json`)/, c.registered],
    [/(,\s*)\d+(\s+of them also in\s*\n?>?\s*`codex\/hooks\/hooks\.json`)/, c.alsoCodex],
    [/(Claude\s*\n?>?\s*skills:\s*\*\*)\d+(\*\*)/, c.claudeSkills],
    [/(Codex\s*\n?>?\s*skills:\s*\*\*)\d+(\*\*)/, c.codexSkills],
  ];
  let out = text;
  for (const [re, n] of subs) {
    if (!re.test(out)) throw new Error('docs/KB.md: count shape not found: ' + re);
    out = out.replace(re, (_m, a, b) => a + n + b);
  }
  return out;
}

module.exports = { counts, build };

if (require.main === module) {
  const cur = fs.readFileSync(KB, 'utf8');
  const next = build(cur);
  if (process.argv.includes('--check')) {
    if (cur !== next) { process.stderr.write('docs/KB.md counts are stale — run node tools/gen-kb-counts.js\n'); process.exit(1); }
    process.exit(0);
  }
  if (cur !== next) fs.writeFileSync(KB, next);
  process.stdout.write(JSON.stringify(counts()) + '\n');
}
