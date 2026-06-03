#!/usr/bin/env node
'use strict';
// api-guard.js — PreToolUse hook on Write/Edit/MultiEdit.
//
// THE MECHANICAL ANSWER TO API HALLUCINATION. The eval (eval/) showed the
// verify-first *prompt* does not reliably stop a model inventing non-existent
// APIs — the model ignores "go verify" ~95% of the time. So this guard does the
// verification ITSELF, deterministically, on the code about to be written: it
// resolves `module.attribute` references against the ACTUALLY-INSTALLED runtime
// (python3 / node) and BLOCKS the write when a real module is missing the
// referenced attribute (i.e. the model fabricated it). A prompt can be ignored;
// a blocked Write cannot.
//
// CONTRACT (matches command-guard.js):
//   stdin  : PreToolUse payload JSON
//   stdout : JSON { decision: "block", reason } when blocking, else nothing
//   exit 2 : block ; exit 0 : allow
//   FAIL-OPEN: any error / ambiguity / not-installed / timeout -> exit 0. A guard
//   that blocks valid code is worse than useless, so we block ONLY when we have
//   POSITIVELY verified (module imports cleanly + attribute absent) that it's fake.
//
// SCOPE (v2):
//   - Python: `mod.attr` for ANY module imported in the chunk, and `Name.attr`
//     where Name came from `from mod import Name` (incl. 3rd-party — pandas,
//     numpy, …). Verified by importing the module and checking hasattr.
//   - JS/Node: `require('mod').attr` / `const X = require('mod'); X.attr` for ANY
//     module (builtin OR an installed node_modules package — lodash, …); and JS
//     global builtins (Array/Promise/Object/…, incl. `.prototype.attr`).
//   A module that does NOT import/require cleanly (not installed, wrong env)
//   yields "unknown" -> allow. Locally-shadowed names and receiver-typed instance
//   methods are NOT checked (fail-open, never false-block).
//
// WHY this is safe even for 3rd-party: if a module imports cleanly it IS installed,
// so hasattr/typeof is authoritative for that exact installed version. Probes are
// BATCHED (one import per module, not per attribute) to bound cost + side effects,
// run under a generous per-spawn timeout (a slow/heavy/cold import just times out
// -> fail-open), and never block on uncertainty.
//
// VERSION SKEW: verified against the LOCAL installed version. Code targeting a
// NEWER version where the attr exists can read as missing (rare; local >= target
// usually). The block message names the runtime; override with the skip-hatch.

const fs = require('fs');
const { spawnSync } = require('child_process');

const MAX_MODULES = 8;        // bound interpreter spawns (one per module group)
// A CEILING, not added latency: a normal spawn returns in <300ms; the generous
// timeout only stops us giving up too early on a COLD or heavy import on a loaded
// runner (the Windows/node flake where the probe timed out -> fail-open -> miss).
const SPAWN_TIMEOUT_MS = 5000;
const MAX_CODE_BYTES = 600000; // skip absurdly large chunks (regex walks are linear, but bound anyway)

// Probe interpreters run with a SANITIZED env: the full parent environment MINUS
// the interpreter-injection vectors, so a poisoned env (NODE_OPTIONS=--require
// evil, PYTHONSTARTUP, PYTHONPATH redirecting imports) cannot influence the
// existence check — while keeping everything Windows needs to spawn at all
// (APPDATA/LOCALAPPDATA/TEMP/SystemRoot/...).
const SAFE_ENV = (() => {
  const e = { ...process.env };
  const DANGER = /^(NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PYTHONINSPECT|PYTHONEXECUTABLE)$/i;
  for (const k of Object.keys(e)) { if (DANGER.test(k)) delete e[k]; }
  return e;
})();

// JS global builtins whose static / prototype members we can verify.
const JS_GLOBALS = new Set([
  'Array', 'String', 'Object', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Number', 'Math', 'JSON', 'Reflect', 'Symbol', 'Date', 'RegExp', 'BigInt', 'Buffer',
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

// Strip line comments + string literals (best-effort, not a full parser — any
// miss just fails open).
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

// Names bound LOCALLY in a Python chunk (assignment / def / class / for-target).
// A locally-bound token is NOT the module/class it shares a name with, so
// resolving it as one is the dominant false-positive class
// (`array = [1,2]; array.append(3)`, `datetime = wrap()` after a from-import).
function pyBoundNames(src) {
  const bound = new Set();
  let b;
  const reAssign = /^[ \t]*([A-Za-z_]\w*)[ \t]*=(?!=)/gm;
  while ((b = reAssign.exec(src))) bound.add(b[1]);
  const reDef = /\b(?:def|class)[ \t]+([A-Za-z_]\w*)/g;
  while ((b = reDef.exec(src))) bound.add(b[1]);
  const reFor = /\bfor[ \t]+([A-Za-z_]\w*)[ \t]+in\b/g;
  while ((b = reFor.exec(src))) bound.add(b[1]);
  return bound;
}

// ---------------------------------------------------------------------------
// Python candidate extraction. Returns [{baseMod, receiverPath, attr, label}].
//   baseMod      : the top-level module to import (e.g. "pandas", "collections")
//   receiverPath : dotted path to the object to hasattr on, rooted at baseMod
//                  (e.g. "pandas" or "collections.OrderedDict")
// Covers ANY module imported in the chunk (stdlib AND 3rd-party); a module that
// is not installed will fail to import in the probe -> unknown -> allow.
// ---------------------------------------------------------------------------
function pyCandidates(code) {
  const src = stripPy(code);
  const cands = new Map(); // label -> {baseMod, receiverPath, attr}

  // `from mod import Name [as Alias]` -> local name bound to "mod.Name"
  const fromImports = {};
  let m;
  const reFrom = /^[ \t]*from[ \t]+([a-zA-Z_][\w.]*)[ \t]+import[ \t]+(.+)$/gm;
  while ((m = reFrom.exec(src))) {
    const mod = m[1];
    for (const part of m[2].split(',')) {
      const mm = /([A-Za-z_]\w*)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?/.exec(part.trim());
      if (mm && mm[1] !== '*') fromImports[(mm[2] || mm[1])] = mod + '.' + mm[1];
    }
  }
  // `import mod [as alias]` (any module)
  const aliasToMod = {};
  const imported = new Set();
  const reImport = /^[ \t]*import[ \t]+([a-zA-Z_][\w.]*)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?/gm;
  while ((m = reImport.exec(src))) {
    if (m[2]) aliasToMod[m[2]] = m[1];
    else imported.add(m[1]); // bare `import a.b.c` -> local name is `a`
  }
  const bound = pyBoundNames(src);

  // Resolve `recv.attr`. Precedence: from-import binding (the local name IS the
  // imported class/fn) > `import mod as recv` alias > bare imported module.
  // ONLY check names that were actually imported in THIS chunk — without a
  // visible import, recv is far more likely a local variable (fail-open).
  const reAttr = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
  while ((m = reAttr.exec(src))) {
    const recv = m[1], attr = m[2];
    if (attr.startsWith('__')) continue;
    if (bound.has(recv)) continue; // locally rebound/shadowed -> not the module/class
    let receiverPath = null;
    if (fromImports[recv]) receiverPath = fromImports[recv];        // e.g. collections.OrderedDict
    else if (aliasToMod[recv]) receiverPath = aliasToMod[recv];     // import mod as recv
    else if (imported.has(recv)) receiverPath = recv;               // bare `import recv`
    else if ([...imported].some((mod) => mod.split('.')[0] === recv)) receiverPath = recv; // `import a.b` -> `a`
    if (!receiverPath) continue;
    const baseMod = receiverPath.split('.')[0];
    cands.set(receiverPath + '.' + attr, { baseMod, receiverPath, attr });
  }
  return [...cands.entries()].map(([label, c]) => ({ ...c, label }));
}

// ---------------------------------------------------------------------------
// JS candidate extraction. Two kinds:
//   require-based: {kind:'require', mod, attr, label}  (any builtin or pkg)
//   global:        {kind:'global', path, label}        (Array.prototype.x, …)
// ---------------------------------------------------------------------------
function jsCandidates(code) {
  const out = [];
  const seen = new Set();
  const push = (o) => { if (!seen.has(o.label)) { seen.add(o.label); out.push(o); } };
  let m;

  // require bindings (from UNSTRIPPED code — stripJs removes quoted module names)
  const reqVar = {};
  const reReqVar = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reReqVar.exec(code))) reqVar[m[1]] = m[2];
  // drop any require-bound var reassigned later (`fs = require('fs-extra')`)
  for (const v of Object.keys(reqVar)) {
    const re = new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\s*=(?!=)', 'g');
    if ((code.match(re) || []).length > 1) delete reqVar[v];
  }
  // inline require('mod').attr
  const reReqInline = /require\(\s*['"]([^'"]+)['"]\s*\)\.([A-Za-z_$][\w$]*)/g;
  while ((m = reReqInline.exec(code))) {
    if (m[2].startsWith('__')) continue;
    push({ kind: 'require', mod: m[1], attr: m[2], label: "require('" + m[1] + "')." + m[2] });
  }

  const src = stripJs(code);
  // X.attr where X is a require-bound module var
  for (const [varName, mod] of Object.entries(reqVar)) {
    const re = new RegExp('\\b' + varName.replace(/\$/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)', 'g');
    while ((m = re.exec(src))) {
      if (m[1].startsWith('__')) continue;
      push({ kind: 'require', mod, attr: m[1], label: mod + '(' + varName + ').' + m[1] });
    }
  }

  // locally declared / rebound names — a global builtin name shadowed locally
  // (`const Math = myLib`) is NOT the builtin.
  const jsBound = new Set();
  let g;
  const reDecl = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((g = reDecl.exec(src))) jsBound.add(g[1]);
  const reReassign = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*=(?!=)/gm;
  while ((g = reReassign.exec(src))) jsBound.add(g[1]);

  // global builtins: Glob.attr and Glob.prototype.attr
  const reGlobal = /\b([A-Za-z]\w*)\.(?:(prototype)\.)?([A-Za-z_$][\w$]*)/g;
  while ((m = reGlobal.exec(src))) {
    const obj = m[1], proto = m[2], attr = m[3];
    if (!JS_GLOBALS.has(obj)) continue;
    if (jsBound.has(obj)) continue;
    if (attr.startsWith('__') || attr === 'prototype') continue;
    const path = proto ? (obj + '.prototype.' + attr) : (obj + '.' + attr);
    push({ kind: 'global', path, label: path });
  }
  return out;
}

// ---------------------------------------------------------------------------
// BATCHED verification. One interpreter spawn per MODULE (not per attribute),
// so a heavy 3rd-party import happens at most once. Returns the subset of the
// given candidates that are POSITIVELY missing (present/unknown -> not returned,
// i.e. fail-open). `bin` problems / timeouts / non-zero exit -> [] (all open).
// ---------------------------------------------------------------------------
function spawnJSON(bin, argv) {
  let res;
  try {
    res = spawnSync(bin, argv, { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8', env: SAFE_ENV, maxBuffer: 262144 });
  } catch (_) { return null; }
  if (!res || res.error || res.signal || res.status !== 0) return null;
  try { return JSON.parse((res.stdout || '').trim()); } catch (_) { return null; }
}

// Python: import baseMod once, traverse receiverPath, hasattr(obj, attr).
// codes: 1=present, 0=missing, 2=unknown(any error). Only 0 -> fake.
const PY_PROBE =
  'import sys, json\n' +
  'checks = json.loads(sys.argv[1])\n' +
  'out = []\n' +
  'for r, a in checks:\n' +
  '    try:\n' +
  '        parts = r.split(".")\n' +
  '        obj = __import__(parts[0])\n' +
  '        for p in parts[1:]:\n' +
  '            obj = getattr(obj, p)\n' +
  '        out.append(0 if not hasattr(obj, a) else 1)\n' +
  '    except Exception:\n' +
  '        out.append(2)\n' +
  'sys.stdout.write(json.dumps(out))\n';

function verifyPython(cands, bin) {
  const byMod = new Map();
  for (const c of cands) {
    if (!byMod.has(c.baseMod)) byMod.set(c.baseMod, []);
    byMod.get(c.baseMod).push(c);
  }
  const fakes = [];
  let spawns = 0;
  for (const [, group] of byMod) {
    if (spawns++ >= MAX_MODULES) break;
    const checks = group.map((c) => [c.receiverPath, c.attr]);
    const codes = spawnJSON(bin, ['-c', PY_PROBE, JSON.stringify(checks)]);
    if (!Array.isArray(codes)) continue; // probe failed -> fail-open for this module
    group.forEach((c, i) => { if (codes[i] === 0) fakes.push(c); });
  }
  return fakes;
}

// Node require: require(mod) once, typeof m[attr]. Plus globals in one pass.
const JS_PROBE =
  'const mods = JSON.parse(process.argv[1]);\n' +     // { "<mod>": ["attr", ...], ... }
  'const globals = JSON.parse(process.argv[2]);\n' +  // ["Array.prototype.x", ...]
  'const res = { req: {}, glob: [] };\n' +
  'for (const mod of Object.keys(mods)) {\n' +
  '  let m; try { m = require(mod); } catch (e) { res.req[mod] = mods[mod].map(() => 2); continue; }\n' +
  '  res.req[mod] = mods[mod].map((a) => { try { return typeof m[a] === "undefined" ? 0 : 1; } catch (e) { return 2; } });\n' +
  '}\n' +
  'function resolve(p) { let o = globalThis; for (const k of p.split(".")) { if (o == null) return undefined; o = o[k]; } return o; }\n' +
  'res.glob = globals.map((p) => { try { return typeof resolve(p) === "undefined" ? 0 : 1; } catch (e) { return 2; } });\n' +
  'process.stdout.write(JSON.stringify(res));\n';

function verifyJs(cands) {
  const reqByMod = new Map();
  const globals = [];
  for (const c of cands) {
    if (c.kind === 'require') {
      if (!reqByMod.has(c.mod)) reqByMod.set(c.mod, []);
      reqByMod.get(c.mod).push(c);
    } else { globals.push(c); }
  }
  // bound the number of modules
  const modsObj = {};
  const groups = [];
  let n = 0;
  for (const [mod, group] of reqByMod) {
    if (n++ >= MAX_MODULES) break;
    modsObj[mod] = group.map((c) => c.attr);
    groups.push([mod, group]);
  }
  const globalPaths = globals.map((c) => c.path);
  const res = spawnJSON('node', ['-e', JS_PROBE, JSON.stringify(modsObj), JSON.stringify(globalPaths)]);
  if (!res || typeof res !== 'object') return [];
  const fakes = [];
  for (const [mod, group] of groups) {
    const codes = res.req && res.req[mod];
    if (Array.isArray(codes)) group.forEach((c, i) => { if (codes[i] === 0) fakes.push(c); });
  }
  if (Array.isArray(res.glob)) globals.forEach((c, i) => { if (res.glob[i] === 0) fakes.push(c); });
  return fakes;
}

function runtimeVersion(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8', env: SAFE_ENV, maxBuffer: 65536 });
    return ((r && (r.stdout || r.stderr)) || '').trim().split('\n')[0] || bin;
  } catch (_) { return bin; }
}

// Resolve the Python interpreter LAZILY (only when a .py chunk is seen). Prefer
// `python3`; fall back to a `python` that is actually 3.x (never python2). null
// when no Python 3 -> Python checks skipped entirely (fail-open).
let _pyBin;
function pyBin() {
  if (_pyBin !== undefined) return _pyBin;
  _pyBin = null;
  for (const bin of ['python3', 'python']) {
    try {
      const r = spawnSync(bin, ['--version'], { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8', env: SAFE_ENV, maxBuffer: 65536 });
      if (r && !r.error && r.status === 0 && /Python 3\./.test((r.stdout || '') + (r.stderr || ''))) { _pyBin = bin; break; }
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

  const pyCands = [];
  const jsCands = [];
  for (const ch of chunks) {
    if (typeof ch.code !== 'string' || ch.code.length > MAX_CODE_BYTES) continue;
    const lang = langFor(ch.file_path);
    if (lang === 'py') pyCands.push(...pyCandidates(ch.code));
    else if (lang === 'js') jsCands.push(...jsCandidates(ch.code));
  }
  if (!pyCands.length && !jsCands.length) process.exit(0);

  const fakes = [];
  const binsUsed = new Set();
  if (pyCands.length) {
    const PB = pyBin();
    if (PB) { binsUsed.add(PB); fakes.push(...verifyPython(pyCands, PB)); }
  }
  if (jsCands.length) { binsUsed.add('node'); fakes.push(...verifyJs(jsCands)); }

  if (!fakes.length) process.exit(0);

  // de-dup by label
  const seen = new Set();
  const uniq = fakes.filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true)));

  const vers = [...binsUsed].map((b) => runtimeVersion(b)).join(', ');
  const list = uniq.map((f) => '  • ' + f.label).join('\n');
  const reason =
    'anti-hall api-guard: this code references API(s) that DO NOT EXIST in your ' +
    'installed runtime (' + vers + '):\n' + list + '\n\n' +
    'These attributes are absent from the real (installed) module/object — they ' +
    'look like fabrications. Verify the correct name (check the docs / run a quick ' +
    '`hasattr` / `typeof` probe) and fix the reference before writing.\n' +
    'If you are intentionally targeting a NEWER version where this exists, ' +
    'override once: write ~/.anti-hall/skip.json {"api-guard": <unix-ms-expiry>}.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  process.exit(2);
}

try {
  main();
} catch (_) {
  process.exit(0); // FAIL-OPEN on any internal error
}
