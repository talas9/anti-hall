'use strict';
// no-real-home-spawn — Wave D9 hygiene lint.
//
// ROOT CAUSE this guards against (field-confirmed twice, defect f3c1bc827d89):
// a test that spawns a REAL subprocess with `env: { ...process.env, ... }` and
// NO `HOME`/`USERPROFILE` override leaks that subprocess's filesystem writes
// (registry rows, log files) into the DEVELOPER'S REAL `~/.anti-hall` instead
// of the test's own isolated tmp fixture home — confirmed live on this machine
// (88 fixture repoKey store dirs under the real `~/.anti-hall/devswarm/store`,
// each holding a TMPDIR worktree path) and reproduced for
// `tests/scripts/devswarm-lifecycle.test.js` and
// `tests/companion/devswarm-supervisor-reconcile-sweep.test.js` (both fixed in
// this same wave) plus `tests/companion/mcp-reaper.e2e.test.js` (mcp-reaper.js's
// own bookkeeping log, also fixed in this wave).
//
// This test is a lint, not a functional check: it scans every test file's
// SOURCE TEXT for a `spawn`/`spawnSync`/`execFile`/`execFileSync`/`fork` call
// whose `env:` object spreads `process.env` but never sets `HOME` (or
// `USERPROFILE`) inside that same object literal, and fails listing every
// offending `file:line`. Text-scan, not an AST parse (repo convention: pure
// Node built-ins only) — see `findViolations`'s doc comment for the exact
// heuristic and its known limitations.
//
// Whitelist: NONE. If a genuinely new case needs an exception, add it to
// `KNOWN_SAFE` below with a comment proving why HOME cannot leak there —
// don't weaken the scan itself.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_ROOT = path.join(__dirname, '..');

// walk(dir) -> string[] of every *.test.js file under dir, recursively.
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(p));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(p);
    }
  }
  return out;
}

const PROCESS_ENV_SPREAD_RE = /\.\.\.\s*process\s*\.\s*env\b/;
const HOME_KEY_RE = /\b(HOME|USERPROFILE)\s*:/;

// balancedObjectLiteral(src, openBraceIndex) -> the substring from
// openBraceIndex (which MUST point at a '{') to its matching '}', using a
// naive brace-depth count. Not string/regex-literal-aware — acceptable for
// this codebase's actual call sites (no `{`/`}` inside string content at any
// site this scan has needed to handle; a future site that breaks this
// assumption will show up as a scan false-positive/negative, not a silent
// miss of the real defect class, since the whole point is a loud failure).
function balancedObjectLiteral(src, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openBraceIndex, i + 1);
    }
  }
  return src.slice(openBraceIndex); // unbalanced (shouldn't happen in valid JS) — scan what we have
}

// findViolations(src) -> [{ line, snippet }] for every `env: { ...process.env
// ... }` object literal in `src` that spreads `process.env` DIRECTLY (never a
// local variable, however named — deliberate: a test that first builds its own
// env into an intermediate `const e = {...}` and adds HOME there BEFORE
// spreading `...e` into the real spawn call's `env:` is exactly the safe
// pattern this must NOT flag, e.g. tests/hooks/devswarm-child-turn.test.js's
// `spawnHookAsync`) and does not itself set HOME/USERPROFILE anywhere inside
// its own balanced object literal. Deliberately requires the LITERAL key
// `env:` (not just any `{...process.env}` anywhere) so a plain data object
// used only for assertions/mocks — never actually handed to any spawn — is
// not swept in by a bare textual match; every real call site in this codebase
// that hands a real subprocess its environment does so via an `env:` key,
// whether directly on `spawn`/`spawnSync`/`execFile(Sync)`/`fork` or on a
// higher-level wrapper (`cli.run(argv, ctx)`, `reconcileSweepIfDue(opts)`)
// that forwards `ctx.env`/`opts.env` down into one of those — so this
// deliberately does NOT also require a spawn-family call name nearby (an
// earlier version of this scan did, and it was blind to exactly the two
// wrapper-mediated leaks this hygiene test exists to catch — see the PROOF
// note below).
function findViolations(src) {
  const violations = [];
  const envKeyRe = /\benv\s*:\s*\{/g;
  let m;
  while ((m = envKeyRe.exec(src))) {
    const braceOpenIdx = m.index + m[0].length - 1; // index of the '{'
    const literal = balancedObjectLiteral(src, braceOpenIdx);
    if (!PROCESS_ENV_SPREAD_RE.test(literal)) continue;
    if (HOME_KEY_RE.test(literal)) continue; // already overrides HOME/USERPROFILE — safe

    const line = src.slice(0, m.index).split('\n').length;
    const snippet = literal.length > 120 ? literal.slice(0, 120) + '…' : literal;
    violations.push({ line, snippet });
  }
  return violations;
}

test('no test spawns a real subprocess with env:{...process.env} and no HOME/USERPROFILE override', () => {
  const files = walk(TESTS_ROOT).filter((f) => f !== __filename);
  const failures = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const violations = findViolations(src);
    for (const v of violations) {
      failures.push(path.relative(TESTS_ROOT, file) + ':' + v.line + '  ' + v.snippet);
    }
  }
  assert.deepStrictEqual(failures, [],
    'each of these spawns a real subprocess with a full process.env copy and no HOME/USERPROFILE ' +
    'override — it can write registry rows / log files into the REAL ~/.anti-hall instead of a tmp ' +
    'fixture home (defect f3c1bc827d89). Add HOME (and USERPROFILE for win32 parity) to the SAME env ' +
    'object literal, pointed at the test\'s own tmp home:\n' + failures.join('\n'));
});
