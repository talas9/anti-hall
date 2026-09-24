'use strict';
// v0.108.0 hygiene: anti-hall reads the DevSwarm app's database and data dir,
// but NEVER its credential tables or browser-profile stores. This test greps
// every shipped code file (and every test other than this one) for those names
// and fails on any hit. Docs may mention them (the KB records what exists);
// code may not.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const SELF = path.resolve(__filename);
const DENY = [
  'github_auth', 'jira_auth', 'user_session',
  'Cookies', 'Session Storage', 'WebStorage', 'Trust Tokens', 'SingletonSocket',
];
const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.sh', '.py', '.ts']);

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && CODE_EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

test('no code file names a DevSwarm credential table or browser-profile store', () => {
  const files = [...walk(path.join(REPO, 'plugins'), []), ...walk(path.join(REPO, 'tests'), [])]
    .filter((p) => path.resolve(p) !== SELF);
  assert.ok(files.length > 50, 'scanned the codebase (' + files.length + ' files)');
  const hits = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const d of DENY) if (s.includes(d)) hits.push(path.relative(REPO, f) + ': ' + d);
  }
  assert.deepStrictEqual(hits, []);
});
