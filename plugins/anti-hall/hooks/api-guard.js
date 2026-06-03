#!/usr/bin/env node
'use strict';
// api-guard.js — PreToolUse hook on Write/Edit/MultiEdit.
//
// THE MECHANICAL ANSWER TO API HALLUCINATION. The eval (eval/) showed that the
// verify-first *prompt* does not reliably stop a model from inventing
// non-existent APIs — the model ignores "go verify" ~95% of the time. So this
// guard does the verification ITSELF, deterministically, on the code the model
// is about to write: it resolves `module.attribute` references against the
// ACTUALLY-INSTALLED runtime (python3 / node) and BLOCKS the write when a real
// stdlib/builtin module is missing the referenced attribute (i.e. the model
// fabricated it). A prompt can be ignored; a blocked Write cannot.
//
// CONTRACT (matches command-guard.js):
//   stdin  : PreToolUse payload JSON
//   stdout : JSON { decision: "block", reason } when blocking, else nothing
//   exit 2 : block ; exit 0 : allow
//   FAIL-OPEN: any error / ambiguity / missing interpreter -> exit 0. A guard
//   that blocks valid code is worse than useless, so we block ONLY when we have
//   POSITIVELY verified (clean import + attribute absent) that the symbol is fake.
//
// SCOPE (v1, high-confidence only):
//   - Python: `mod.attr` where mod is a known stdlib module; and `Name.attr`
//     where Name came from `from mod import Name`. Verified via python3 hasattr.
//   - JS/Node: `require('mod').attr` / `const X = require('mod'); X.attr` for
//     node builtins; and global builtins (Array/String/Object/Promise/Map/Set/
//     Number/Math/JSON/Reflect, incl. `.prototype.attr`). Verified via node.
//   Receiver-typed instance methods (e.g. someStr.removeboth()) are NOT checked
//   in v1 — the receiver type isn't known statically. Fail-open, not false-block.
//
// VERSION SKEW: verification is against the LOCAL runtime. If code legitimately
// targets a NEWER runtime than installed, a real-but-future attr can read as
// missing. That is the one false-positive path; it is rare (local >= target
// usually), the block message says which runtime version it checked, and the
// user can override with `~/.anti-hall/skip.json` (api-guard). Documented, not
// hidden.

const fs = require('fs');
const { spawnSync } = require('child_process');

const MAX_CHECKS = 12;        // bound the number of interpreter spawns
const SPAWN_TIMEOUT_MS = 1500; // worst case MAX_CHECKS*this stays under the hook timeout

// Curated Python stdlib modules safe to introspect (import is cheap + side-effect
// free). Kept conservative: only modules we are confident are stdlib, so a
// missing attr means a fabrication, not a 3rd-party/version surprise.
const PY_STDLIB = new Set([
  'os', 'sys', 'math', 'cmath', 'random', 'json', 're', 'collections', 'itertools',
  'functools', 'pathlib', 'asyncio', 'datetime', 'time', 'statistics', 'heapq',
  'bisect', 'string', 'textwrap', 'shutil', 'glob', 'csv', 'sqlite3', 'decimal',
  'fractions', 'secrets', 'uuid', 'contextlib', 'operator', 'inspect', 'abc',
  'numbers', 'array', 'enum', 'dataclasses', 'typing', 'io', 'struct', 'hashlib',
  'base64', 'binascii', 'copy', 'pprint', 'queue', 'threading', 'socket',
]);

// Node builtin modules safe to require + introspect.
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'crypto', 'util', 'stream', 'buffer', 'events', 'url',
  'querystring', 'http', 'https', 'net', 'dns', 'zlib', 'readline', 'child_process',
  'assert', 'timers', 'string_decoder', 'tls', 'dgram', 'process',
]);

// JS global builtins whose static members we can verify.
const JS_GLOBALS = new Set([
  'Array', 'String', 'Object', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Number', 'Math', 'JSON', 'Reflect', 'Symbol', 'Date', 'RegExp', 'BigInt',
]);

// ---------------------------------------------------------------------------
// Pull the NEW code text out of a Write / Edit / MultiEdit payload.
// ---------------------------------------------------------------------------
function newCodeChunks(payload) {
  const tn = payload && payload.tool_name;
  const ti = (payload && payload.tool_input) || {};
  const fp = ti.file_path || '';
  const out = [];
  if (tn === 'Write') {
    if (typeof ti.content === 'string') out.push({ file_path: fp, code: ti.content });
  } else if (tn === 'Edit') {
    if (typeof ti.new_string === 'string') out.push({ file_path: fp, code: ti.new_string });
  } else if (tn === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    for (const e of edits) {
      if (e && typeof e.new_string === 'string') out.push({ file_path: fp, code: e.new_string });
    }
  }
  return out;
}

function langFor(fp) {
  const m = /\.([a-z]+)$/i.exec(fp || '');
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === 'py' || ext === 'pyi') return 'py';
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)) return 'js';
  return null;
}

// Strip the cheap stuff that produces false matches: line comments and string
// literals (best-effort, not a full parser — we only need to reduce noise, and
// any miss just fails open).
function stripPy(code) {
  return code
    .replace(/#.*$/gm, '')
    .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ');
}
function stripJs(code) {
  return code
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ');
}

// ---------------------------------------------------------------------------
// Candidate extraction → list of {probe, label} where probe is a tiny program
// that exits 7 iff the symbol is MISSING (and 0 if present). De-duplicated.
// ---------------------------------------------------------------------------
function pyCandidates(code) {
  const src = stripPy(code);
  const cands = new Map(); // label -> {mod, expr, attr}
  // `from mod import Name [as Alias]` -> Alias/Name bound to mod.Name
  const fromImports = {}; // localName -> "mod.Name"
  let m;
  const reFrom = /^[ \t]*from[ \t]+([a-zA-Z_][\w.]*)[ \t]+import[ \t]+(.+)$/gm;
  while ((m = reFrom.exec(src))) {
    const mod = m[1].split('.')[0];
    if (!PY_STDLIB.has(mod)) continue;
    for (const part of m[2].split(',')) {
      const mm = /([A-Za-z_]\w*)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?/.exec(part.trim());
      if (mm) fromImports[(mm[2] || mm[1])] = m[1] + '.' + mm[1];
    }
  }
  const reImport = /^[ \t]*import[ \t]+([a-zA-Z_][\w.]*)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?/gm;
  const aliasToMod = {};
  while ((m = reImport.exec(src))) {
    const mod = m[1].split('.')[0];
    if (!PY_STDLIB.has(mod)) continue;
    if (m[2]) aliasToMod[m[2]] = m[1];
  }
  // Resolve `recv.attr`. Precedence matters: a token like `datetime` can be BOTH
  // a stdlib module name AND a `from datetime import datetime` class binding. The
  // binding is the linguistically-correct meaning of the LOCAL name, so it WINS —
  // otherwise we'd probe hasattr(<module>, ...) for a method that lives on the
  // class and false-block valid code (the datetime.fromisoformat bug).
  const reAttr = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
  while ((m = reAttr.exec(src))) {
    const recv = m[1], attr = m[2];
    if (attr.startsWith('__')) continue;
    let expr = null, baseMod = null;
    if (fromImports[recv]) {            // `from mod import recv` -> recv is the bound class/fn
      expr = fromImports[recv]; baseMod = expr.split('.')[0];
    } else if (aliasToMod[recv]) {      // `import mod as recv`
      expr = aliasToMod[recv]; baseMod = expr.split('.')[0];
    } else if (PY_STDLIB.has(recv)) {   // bare stdlib module (assume module even if the import is outside this edit chunk)
      expr = recv; baseMod = recv;
    }
    if (expr) cands.set(expr + '.' + attr, { importStmt: 'import ' + baseMod, expr, attr });
  }
  return [...cands.entries()].map(([label, c]) => ({
    label,
    argv: ['-c', c.importStmt + '\nimport sys\nsys.exit(0 if hasattr(' + c.expr + ', ' + JSON.stringify(c.attr) + ') else 7)'],
    bin: 'python3',
  }));
}

function jsCandidates(code) {
  // IMPORTANT: extract require-patterns BEFORE stripping, since stripJs removes
  // the quoted module names that are essential to the require() pattern.
  const cands = new Map();
  let m;

  // const X = require('mod')   /   var X = require("mod")
  // Extract from UNSTRIPPED code to preserve quoted module names.
  const reqVar = {};
  const reReqVar = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reReqVar.exec(code))) {
    if (NODE_BUILTINS.has(m[2])) reqVar[m[1]] = m[2];
  }

  // require('mod').attr  (inline)
  // Extract from UNSTRIPPED code.
  const reReqInline = /require\(\s*['"]([^'"]+)['"]\s*\)\.([A-Za-z_$][\w$]*)/g;
  while ((m = reReqInline.exec(code))) {
    if (!NODE_BUILTINS.has(m[1])) continue;
    const label = "require('" + m[1] + "')." + m[2];
    cands.set(label, { expr: "require(" + JSON.stringify(m[1]) + ")." + m[2] });
  }

  // X.attr where X is a require-bound builtin
  // Can now match on stripped code since X is an identifier.
  const src = stripJs(code);
  for (const [varName, mod] of Object.entries(reqVar)) {
    const re = new RegExp('\\b' + varName.replace(/\$/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)', 'g');
    while ((m = re.exec(src))) {
      if (m[1].startsWith('__')) continue;
      const label = mod + '(' + varName + ').' + m[1];
      cands.set(label, { expr: "require(" + JSON.stringify(mod) + ")." + m[1] });
    }
  }

  // global builtins: Glob.attr and Glob.prototype.attr
  // Can match on stripped code (no quoted strings involved).
  const reGlobal = /\b([A-Za-z]\w*)\.(?:(prototype)\.)?([A-Za-z_$][\w$]*)/g;
  while ((m = reGlobal.exec(src))) {
    const obj = m[1], proto = m[2], attr = m[3];
    if (!JS_GLOBALS.has(obj)) continue;
    if (attr.startsWith('__') || attr === 'prototype') continue;
    const expr = proto ? (obj + '.prototype.' + attr) : (obj + '.' + attr);
    cands.set(expr, { expr });
  }

  return [...cands.entries()].map(([label, c]) => ({
    label,
    argv: ['-e', 'process.exit(typeof (' + c.expr + ') === "undefined" ? 7 : 0)'],
    bin: 'node',
  }));
}

// ---------------------------------------------------------------------------
// Verify a candidate. Returns 'missing' | 'present' | 'unknown'. Any spawn
// problem (no interpreter, import error, timeout, signal) -> 'unknown' (open).
// ---------------------------------------------------------------------------
function verify(cand) {
  let res;
  try {
    res = spawnSync(cand.bin, cand.argv, { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8' });
  } catch (_) {
    return 'unknown';
  }
  if (!res || res.error || res.signal) return 'unknown';
  if (res.status === 7) return 'missing';
  if (res.status === 0) return 'present';
  return 'unknown'; // import error, syntax error, anything else -> open
}

function runtimeVersion(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8' });
    return ((r && (r.stdout || r.stderr)) || '').trim().split('\n')[0] || bin;
  } catch (_) { return bin; }
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { process.exit(0); }

  let isSkipped;
  try { ({ isSkipped } = require('./skip-guard.js')); } catch (_) { isSkipped = () => false; }
  if (isSkipped('api-guard')) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch (_) { process.exit(0); }

  const chunks = newCodeChunks(payload);
  if (!chunks.length) process.exit(0);

  const candidates = [];
  for (const ch of chunks) {
    const lang = langFor(ch.file_path);
    if (lang === 'py') candidates.push(...pyCandidates(ch.code));
    else if (lang === 'js') candidates.push(...jsCandidates(ch.code));
  }
  if (!candidates.length) process.exit(0);

  // De-dup by label, cap total checks.
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (seen.has(c.label)) continue;
    seen.add(c.label);
    unique.push(c);
    if (unique.length >= MAX_CHECKS) break;
  }

  const fakes = [];
  for (const c of unique) {
    if (verify(c) === 'missing') fakes.push(c);
  }
  if (!fakes.length) process.exit(0);

  const bins = [...new Set(fakes.map((f) => f.bin))];
  const vers = bins.map((b) => runtimeVersion(b)).join(', ');
  const list = fakes.map((f) => '  • ' + f.label).join('\n');
  const reason =
    'anti-hall api-guard: this code references API(s) that DO NOT EXIST in your ' +
    'installed runtime (' + vers + '):\n' + list + '\n\n' +
    'These attributes are absent from the real module/object — they look like ' +
    'fabrications. Verify the correct name (check the docs / run a quick ' +
    '`hasattr` / `typeof` probe) and fix the reference before writing.\n' +
    'If you are intentionally targeting a NEWER runtime where this exists, ' +
    'override once: write ~/.anti-hall/skip.json {"api-guard": <unix-ms-expiry>}.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

try {
  main();
} catch (_) {
  process.exit(0); // FAIL-OPEN on any internal error
}
