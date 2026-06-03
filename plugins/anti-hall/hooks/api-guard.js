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

const MAX_CHECKS = 6;          // bound the number of interpreter spawns (× timeout < hook timeout)
// A CEILING, not added latency: a normal spawn returns in <300ms; this only stops
// us from giving up too early on a COLD python/node start on a loaded CI runner
// (the Windows/node flake where the probe timed out → fail-open → missed block).
const SPAWN_TIMEOUT_MS = 5000;
const MAX_CODE_BYTES = 600000; // skip absurdly large chunks (regex walks are linear, but bound anyway)

// Probe interpreters run with a SANITIZED env: the full parent environment MINUS
// the interpreter-injection vectors, so a poisoned env (NODE_OPTIONS=--require
// evil, PYTHONSTARTUP, PYTHONPATH redirecting imports) cannot influence the
// existence check — while keeping everything Windows needs to spawn Python at all
// (APPDATA/LOCALAPPDATA/TEMP/SystemRoot/...). An earlier PATH-only allowlist was
// secure but broke Python spawning on Windows (→ fail-open → missed catches), so
// we denylist the dangerous keys instead of allowlisting one safe key.
const SAFE_ENV = (() => {
  const e = { ...process.env };
  const DANGER = /^(NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PYTHONINSPECT|PYTHONEXECUTABLE)$/i;
  for (const k of Object.keys(e)) { if (DANGER.test(k)) delete e[k]; }
  return e;
})();

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
  'Buffer',
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
  const PB = pyBin();
  if (!PB) return []; // no Python 3 interpreter -> skip Python checks (fail-open)
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
  const imported = new Set(); // bare `import X` module names actually present in this chunk
  while ((m = reImport.exec(src))) {
    const mod = m[1].split('.')[0];
    if (!PY_STDLIB.has(mod)) continue;
    if (m[2]) aliasToMod[m[2]] = m[1];
    else imported.add(mod);
  }
  // Names bound LOCALLY in this chunk (assignment / def / class / for-target). A
  // locally-bound token is NOT the stdlib module/class, so resolving it as one is
  // the dominant false-positive class: `array = [1,2]; array.append(3)`,
  // `time = elapsed(); time.total_seconds()`, `datetime = wrap()` after a
  // from-import, `def json(): ...`. Any such name is excluded from checking.
  const bound = new Set();
  let b;
  const reAssign = /^[ \t]*([A-Za-z_]\w*)[ \t]*=(?!=)/gm;
  while ((b = reAssign.exec(src))) bound.add(b[1]);
  const reDef = /\b(?:def|class)[ \t]+([A-Za-z_]\w*)/g;
  while ((b = reDef.exec(src))) bound.add(b[1]);
  const reFor = /\bfor[ \t]+([A-Za-z_]\w*)[ \t]+in\b/g;
  while ((b = reFor.exec(src))) bound.add(b[1]);

  // Resolve `recv.attr`. Precedence: from-import binding (the local name IS the
  // imported class/fn — e.g. `from datetime import datetime`) wins over the bare
  // module name; then `import mod as recv`; then a bare stdlib module — but ONLY
  // when an actual `import recv` is present in THIS chunk. Without a visible
  // import we have NOT verified that `recv` is the module (it is far more likely
  // a local variable), so we do not check it — fail-open over false-block.
  const reAttr = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
  while ((m = reAttr.exec(src))) {
    const recv = m[1], attr = m[2];
    if (attr.startsWith('__')) continue;
    if (bound.has(recv)) continue;      // locally rebound/shadowed -> not the module/class
    let expr = null, baseMod = null;
    if (fromImports[recv]) {            // `from mod import recv` -> recv is the bound class/fn
      expr = fromImports[recv]; baseMod = expr.split('.')[0];
    } else if (aliasToMod[recv]) {      // `import mod as recv`
      expr = aliasToMod[recv]; baseMod = expr.split('.')[0];
    } else if (PY_STDLIB.has(recv) && imported.has(recv)) { // bare module, actually imported here
      expr = recv; baseMod = recv;
    }
    if (expr) cands.set(expr + '.' + attr, { importStmt: 'import ' + baseMod, expr, attr });
  }
  return [...cands.entries()].map(([label, c]) => ({
    label,
    argv: ['-c', c.importStmt + '\nimport sys\nsys.exit(0 if hasattr(' + c.expr + ', ' + JSON.stringify(c.attr) + ') else 7)'],
    bin: PB,
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
  // Drop any require-bound var that is REASSIGNED later (more than one `var =`):
  // `let fs = require('fs'); fs = require('fs-extra'); fs.copySync()` must NOT be
  // checked against builtin fs. One assignment == the decl; >1 == rebound.
  for (const v of Object.keys(reqVar)) {
    const re = new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\s*=(?!=)', 'g');
    if ((code.match(re) || []).length > 1) delete reqVar[v];
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

  // Names declared/rebound locally — a global builtin name that is shadowed
  // (`const Math = myLib`, `let JSON = json5`, `Set = MyOrderedSet`) is NOT the
  // builtin, so it must not be checked against it (false-positive class P0-2).
  const jsBound = new Set();
  let g;
  const reDecl = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((g = reDecl.exec(src))) jsBound.add(g[1]);
  const reReassign = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*=(?!=)/gm;
  while ((g = reReassign.exec(src))) jsBound.add(g[1]);

  // global builtins: Glob.attr and Glob.prototype.attr
  // Can match on stripped code (no quoted strings involved).
  const reGlobal = /\b([A-Za-z]\w*)\.(?:(prototype)\.)?([A-Za-z_$][\w$]*)/g;
  while ((m = reGlobal.exec(src))) {
    const obj = m[1], proto = m[2], attr = m[3];
    if (!JS_GLOBALS.has(obj)) continue;
    if (jsBound.has(obj)) continue;     // locally shadowed -> not the builtin
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
    res = spawnSync(cand.bin, cand.argv, { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8', env: SAFE_ENV, maxBuffer: 65536 });
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
    const r = spawnSync(bin, ['--version'], { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8', env: SAFE_ENV, maxBuffer: 65536 });
    return ((r && (r.stdout || r.stderr)) || '').trim().split('\n')[0] || bin;
  } catch (_) { return bin; }
}

// Resolve the Python interpreter LAZILY (only when a .py chunk is seen, so a
// .js-only Write never pays for it). Prefer `python3`; fall back to a `python`
// that is actually 3.x (never python2 — its stdlib differs and would mis-judge).
// Returns the bin name, or null when no Python 3 is available (→ Python checks
// are skipped entirely = fail-open, not false-block). Addresses the Windows /
// `python`-only-distro coverage gap.
let _pyBin; // undefined = unresolved, null = none, string = bin name
function pyBin() {
  if (_pyBin !== undefined) return _pyBin;
  _pyBin = null;
  for (const bin of ['python3', 'python']) {
    try {
      const r = spawnSync(bin, ['--version'], { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8', env: SAFE_ENV, maxBuffer: 65536 });
      if (r && !r.error && r.status === 0 && /Python 3\./.test((r.stdout || '') + (r.stderr || ''))) {
        _pyBin = bin; break;
      }
    } catch (_) { /* try next */ }
  }
  return _pyBin;
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
    if (typeof ch.code !== 'string' || ch.code.length > MAX_CODE_BYTES) continue;
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
