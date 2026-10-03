'use strict';
// v0.108.0 hygiene: anti-hall reads the DevSwarm app's database and data dir,
// but NEVER its credential tables, browser-profile stores, or the app's
// unauthenticated internal HTTP/WebSocket/MCP surface (port 47836: /api/*,
// /ws, POST /mcp — some routes are destructive). This test greps
// every shipped code file (and every test other than this one) for those names
// and fails on any hit. Docs and comment-only lines may mention them (to say
// "never call"); code may not.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const SELF = path.resolve(__filename);
const HYGIENE_DIR = path.join(REPO, 'tests', 'hygiene') + path.sep;
const DENY = [
  'github_auth', 'jira_auth', 'user_session',
  'Cookies', 'Session Storage', 'WebStorage', 'Trust Tokens', 'SingletonSocket',
  '47836', '47837', '/api/workspace', '/api/builder', '/api/terminal', "'/mcp'", '"/mcp"', "'/ws'", '"/ws"',
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
    // tests/hygiene/* are the other deny-list guards: they must name the
    // forbidden surface in their own patterns.
    .filter((p) => path.resolve(p) !== SELF && !path.resolve(p).startsWith(HYGIENE_DIR));
  assert.ok(files.length > 50, 'scanned the codebase (' + files.length + ' files)');
  const hits = [];
  for (const f of files) {
    // Comment-only lines may DOCUMENT a forbidden surface ("never call …");
    // every other line (code, strings — including URLs) is scanned.
    const code = fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join('\n');
    for (const d of DENY) if (code.includes(d)) hits.push(path.relative(REPO, f) + ': ' + d);
  }
  assert.deepStrictEqual(hits, []);
});
