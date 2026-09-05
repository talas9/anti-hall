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
const BARE_PROCESS_ENV_RE = /^process\s*\.\s*env$/;

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

// balancedParenCall(src, openParenIndex) -> the substring from openParenIndex
// (which MUST point at the '(' of a call) to its matching ')', via the same
// naive depth count as balancedObjectLiteral (same known limitations).
function balancedParenCall(src, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(openParenIndex, i + 1);
    }
  }
  return src.slice(openParenIndex); // unbalanced (shouldn't happen in valid JS)
}

// splitTopLevelArgs(argListSrc) -> string[] of the comma-separated arguments
// inside a balanced `(...)` call's parens (argListSrc includes the outer
// parens), splitting only at depth 0 so nested `{}`/`()`/`[]` inside an
// argument aren't mistaken for an argument boundary.
function splitTopLevelArgs(argListSrc) {
  const inner = argListSrc.slice(1, -1); // drop outer ( and )
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const last = inner.slice(start);
  if (last.trim().length > 0) args.push(last);
  return args.map((a) => a.trim());
}

// objectAssignSpreadsUnguardedProcessEnv(argListSrc) -> true if a balanced
// `Object.assign(...)` argument list spreads `process.env` as a bare argument
// (the merge-in-a-real-env-copy shape, e.g. `Object.assign({}, process.env, {
// NODE_OPTIONS: ... })`) with no HOME/USERPROFILE override in the SAME call —
// same defect class as the `...process.env` object-literal spread, just via
// Object.assign instead of spread syntax (confirmed live:
// tests/companion/recovery-repokey-failopen.test.js before this fix).
//
// Deliberately mirrors findViolations' variable-indirection exception: if any
// top-level argument is neither `process.env` nor an inline `{...}` object
// literal (e.g. a bare identifier like `envOverrides`, or an expression like
// `(opts && opts.env) || {}`), the call is treated as the safe
// build-then-forward pattern and is NOT flagged — the HOME override may live
// in whatever that argument forwards, exactly as an intermediate `const e =
// {...}` is not flagged for the object-literal case.
function objectAssignSpreadsUnguardedProcessEnv(argListSrc) {
  const args = splitTopLevelArgs(argListSrc);
  let sawProcessEnv = false;
  let sawHome = false;
  for (const arg of args) {
    if (BARE_PROCESS_ENV_RE.test(arg)) {
      sawProcessEnv = true;
      continue;
    }
    if (arg === '{}') continue;
    if (arg.startsWith('{') && arg.endsWith('}')) {
      if (HOME_KEY_RE.test(arg)) sawHome = true;
      continue;
    }
    // Any other shape (identifier, call, ternary, `||` fallback, ...) is the
    // safe indirection escape hatch — bail out entirely, matching the
    // object-literal convention.
    return false;
  }
  return sawProcessEnv && !sawHome;
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
  const seenIndex = new Set(); // dedupe: an env:-keyed Object.assign(...) would otherwise match both scans below

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
    seenIndex.add(m.index);
  }

  // Bare `env: process.env` (no wrapper at all) — inherently unguarded, since
  // there is no object literal in this same construct to carry a HOME
  // override into.
  const bareEnvKeyRe = /\benv\s*:\s*process\s*\.\s*env\s*(?=[,}\)])/g;
  while ((m = bareEnvKeyRe.exec(src))) {
    if (seenIndex.has(m.index)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    violations.push({ line, snippet: m[0].trim() });
    seenIndex.add(m.index);
  }

  // `Object.assign({}, process.env, {...})` (or any argument order) — the
  // same real-env-copy defect class as `{ ...process.env }`, just via
  // Object.assign instead of spread syntax.
  const objectAssignRe = /Object\s*\.\s*assign\s*\(/g;
  while ((m = objectAssignRe.exec(src))) {
    if (seenIndex.has(m.index)) continue;
    const openParenIdx = m.index + m[0].length - 1; // index of the '('
    const callSrc = balancedParenCall(src, openParenIdx);
    if (!objectAssignSpreadsUnguardedProcessEnv(callSrc)) continue;

    const line = src.slice(0, m.index).split('\n').length;
    const full = m[0] + callSrc.slice(1);
    const snippet = full.length > 120 ? full.slice(0, 120) + '…' : full;
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
