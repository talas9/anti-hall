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
//   FAIL-OPEN: any error / ambiguity / not-installed / timeout -> exit 0.
//
// SCOPE: by DEFAULT checks `module.attr` for stdlib / builtin modules only
// (os, collections, fs, crypto, …) + JS global builtins — importing these to
// introspect is side-effect-free. Verifying an installed 3rd-PARTY package
// requires importing it, which RUNS its top-level code at edit time (a confirmed
// RCE vector), so 3rd-party checking is OPT-IN: set ANTIHALL_API_GUARD_THIRDPARTY=1
// to also verify installed packages (pandas, lodash, …) — the high-hallucination
// class — accepting that referenced installed packages get imported at edit time.
// A module that imports cleanly IS installed; not installed -> import fails -> allow.
//
// SECURITY (the probe IMPORTS modules, so it can run their top-level code):
//   - Local/relative code is NEVER probed, even in opt-in mode:
//       * JS: path-like specifiers (./x, ../x, /abs, C:\x) are refused.
//       * Python: the probe runs with cwd=<tmp> and scrubs cwd/'' from sys.path,
//         so a bare `import localmodule` cannot resolve to a repo file.
//     This closes the edit-time-RCE-of-project-files surface.
//   - Check-lists pass to the probe as JSON via argv (never string-interpolated),
//     and every identifier is regex-constrained — no probe-source injection.
//   - A global wall-clock DEADLINE bounds total time under the hook timeout.
//   - Shadowed names (locals, params, `with/except as`) are excluded, so a param
//     named like an import (`def f(pd): pd.x`) is never false-blocked.

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const MAX_MODULES = 8;          // bound interpreter spawns (one per module group)
const SPAWN_TIMEOUT_MS = 5000;  // per-spawn CEILING (normal spawn <300ms; headroom for cold/heavy imports)
const TOTAL_DEADLINE_MS = 30000; // global wall-clock budget (< hooks.json 45s timeout, with headroom)
const MAX_CODE_BYTES = 600000;  // skip absurdly large chunks

// Sanitized env: full parent env MINUS interpreter-injection vectors, so a
// poisoned env (NODE_OPTIONS=--require evil, PYTHONSTARTUP, PYTHONPATH) can't
// influence the check — while keeping what Windows needs to spawn at all.
const SAFE_ENV = (() => {
  const e = { ...process.env };
  const DANGER = /^(NODE_OPTIONS|NODE_PATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PYTHONINSPECT|PYTHONEXECUTABLE|PYTHONUSERBASE|PYTHONSAFEPATH)$/i;
  for (const k of Object.keys(e)) { if (DANGER.test(k)) delete e[k]; }
  return e;
})();

// JS global builtins whose static / prototype members we can verify (always safe
// — no import side effects).
const JS_GLOBALS = new Set([
  'Array', 'String', 'Object', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Number', 'Math', 'JSON', 'Reflect', 'Symbol', 'Date', 'RegExp', 'BigInt', 'Buffer',
]);

// DEFAULT SCOPE = stdlib / builtins ONLY. Importing these to introspect is
// side-effect-free, so the probe never runs untrusted code. Verifying a 3rd-party
// package, by contrast, REQUIRES importing it — which runs its top-level code at
// edit time (a confirmed RCE vector). So 3rd-party checking is OPT-IN only:
//   ANTIHALL_API_GUARD_THIRDPARTY=1  -> also check installed 3rd-party packages.
const THIRDPARTY = /^(1|true|yes|on)$/i.test(String(process.env.ANTIHALL_API_GUARD_THIRDPARTY || ''));

const PY_STDLIB = new Set([
  'os', 'sys', 'math', 'cmath', 'random', 'json', 're', 'collections', 'itertools',
  'functools', 'pathlib', 'asyncio', 'datetime', 'time', 'statistics', 'heapq',
  'bisect', 'string', 'textwrap', 'shutil', 'glob', 'csv', 'sqlite3', 'decimal',
  'fractions', 'secrets', 'uuid', 'contextlib', 'operator', 'inspect', 'abc',
  'numbers', 'array', 'enum', 'dataclasses', 'typing', 'io', 'struct', 'hashlib',
  'base64', 'binascii', 'copy', 'pprint', 'queue', 'threading', 'socket',
]);
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'crypto', 'util', 'stream', 'buffer', 'events', 'url',
  'querystring', 'http', 'https', 'net', 'dns', 'zlib', 'readline', 'child_process',
  'assert', 'timers', 'string_decoder', 'tls', 'dgram', 'process',
]);
function pyAllowed(baseMod) { return THIRDPARTY || PY_STDLIB.has(baseMod); }
function jsModAllowed(mod) { return THIRDPARTY || NODE_BUILTINS.has(mod); }

// A module specifier that resolves to a FILE ON DISK (relative/absolute) — never
// probe these: importing them executes project-local code at edit time.
function isPathSpec(mod) {
  // relative (./x ../x), absolute (/abs, C:\x), or any traversal — but ALLOW
  // scoped/subpath packages (@scope/name, lodash/fp) which resolve from node_modules.
  return /^[.\/\\]/.test(mod) || /^[A-Za-z]:[\\/]/.test(mod) || mod.indexOf('..') !== -1 || mod.indexOf('\\') !== -1;
}

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

function stripPy(code) {
  return code
    .replace(/#.*$/gm, '')
    .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ');
}
function stripJsComments(code) {
  return code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ' ');
}
function stripJs(code) {
  return stripJsComments(code)
    .replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ');
}

// Names bound LOCALLY in a Python chunk — excluded from checking so a token that
// merely shares a name with a module/import is never false-blocked. Covers:
// assignment, def/class, for-target, AND function/lambda PARAMETERS and
// `with/except ... as NAME` (a param named like an import — `def f(pd): pd.x` —
// is the confirmed false-positive vector). Import `as` aliases are NOT bound
// (those ARE the module, and are handled separately).
function pyBoundNames(src) {
  const bound = new Set();
  let m;
  const reAssign = /^[ \t]*([A-Za-z_]\w*)[ \t]*=(?!=)/gm;
  while ((m = reAssign.exec(src))) bound.add(m[1]);
  const reDef = /\b(?:def|class)[ \t]+([A-Za-z_]\w*)/g;
  while ((m = reDef.exec(src))) bound.add(m[1]);
  const reFor = /\bfor[ \t]+([A-Za-z_]\w*)[ \t]+in\b/g;
  while ((m = reFor.exec(src))) bound.add(m[1]);
  // function parameters: def f(a, pd, *c): ...
  const reDefParams = /\bdef[ \t]+\w+[ \t]*\(([^)]*)\)/g;
  while ((m = reDefParams.exec(src))) {
    for (const part of m[1].split(',')) {
      const pm = /^[ \t*]*([A-Za-z_]\w*)/.exec(part);
      if (pm) bound.add(pm[1]);
    }
  }
  // lambda parameters: lambda pd, x: ...
  const reLambda = /\blambda[ \t]+([^:\n]*):/g;
  while ((m = reLambda.exec(src))) {
    for (const part of m[1].split(',')) {
      const pm = /^[ \t*]*([A-Za-z_]\w*)/.exec(part);
      if (pm) bound.add(pm[1]);
    }
  }
  // `with ... as NAME` / `except ... as NAME` (NOT import-as: import lines skipped)
  for (const line of src.split('\n')) {
    if (/^[ \t]*(?:import|from)\b/.test(line)) continue;
    let am; const reAs = /\bas[ \t]+([A-Za-z_]\w*)/g;
    while ((am = reAs.exec(line))) bound.add(am[1]);
  }
  return bound;
}

// Python candidates: [{baseMod, receiverPath, attr, label}] for ANY non-local,
// non-path module imported in the chunk.
function pyCandidates(code) {
  const src = stripPy(code);
  const cands = new Map();

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
  const aliasToMod = {};
  const imported = new Set();
  const reImport = /^[ \t]*import[ \t]+([a-zA-Z_][\w.]*)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?/gm;
  while ((m = reImport.exec(src))) {
    if (m[2]) aliasToMod[m[2]] = m[1];
    else imported.add(m[1]);
  }
  const bound = pyBoundNames(src);

  const reAttr = /\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g;
  while ((m = reAttr.exec(src))) {
    const recv = m[1], attr = m[2];
    if (attr.startsWith('__')) continue;
    if (bound.has(recv)) continue;
    let receiverPath = null;
    if (fromImports[recv]) receiverPath = fromImports[recv];
    else if (aliasToMod[recv]) receiverPath = aliasToMod[recv];
    else if (imported.has(recv)) receiverPath = recv;
    else if ([...imported].some((mod) => mod.split('.')[0] === recv)) receiverPath = recv;
    if (!receiverPath) continue;
    const baseMod = receiverPath.split('.')[0];
    if (!pyAllowed(baseMod)) continue; // 3rd-party only with ANTIHALL_API_GUARD_THIRDPARTY=1
    cands.set(receiverPath + '.' + attr, { baseMod, receiverPath, attr });
  }
  return [...cands.entries()].map(([label, c]) => ({ ...c, label }));
}

// JS candidates: require-based (any INSTALLED package, never a path spec) +
// global builtins. Require names are taken from COMMENT-STRIPPED code so an
// inert `require('./x')` in a comment is not probed.
function jsCandidates(code) {
  const out = [];
  const seen = new Set();
  const push = (o) => { if (!seen.has(o.label)) { seen.add(o.label); out.push(o); } };
  const noComments = stripJsComments(code);
  let m;

  const reqVar = {};
  const reReqVar = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reReqVar.exec(noComments))) { if (!isPathSpec(m[2]) && jsModAllowed(m[2])) reqVar[m[1]] = m[2]; }
  for (const v of Object.keys(reqVar)) {
    const re = new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\s*=(?!=)', 'g');
    if ((noComments.match(re) || []).length > 1) delete reqVar[v];
  }
  const reReqInline = /require\(\s*['"]([^'"]+)['"]\s*\)\.([A-Za-z_$][\w$]*)/g;
  while ((m = reReqInline.exec(noComments))) {
    if (isPathSpec(m[1]) || !jsModAllowed(m[1]) || m[2].startsWith('__')) continue;
    push({ kind: 'require', mod: m[1], attr: m[2], label: "require('" + m[1] + "')." + m[2] });
  }

  const src = stripJs(code);
  for (const [varName, mod] of Object.entries(reqVar)) {
    const re = new RegExp('\\b' + varName.replace(/\$/g, '\\$') + '\\.([A-Za-z_$][\\w$]*)', 'g');
    while ((m = re.exec(src))) {
      if (m[1].startsWith('__')) continue;
      push({ kind: 'require', mod, attr: m[1], label: mod + '(' + varName + ').' + m[1] });
    }
  }

  const jsBound = new Set();
  let g;
  const reDecl = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((g = reDecl.exec(src))) jsBound.add(g[1]);
  const reReassign = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*=(?!=)/gm;
  while ((g = reReassign.exec(src))) jsBound.add(g[1]);
  const reFnParams = /\bfunction[ \t]*\*?[ \t]*[A-Za-z_$]?[\w$]*[ \t]*\(([^)]*)\)/g;
  while ((g = reFnParams.exec(src))) {
    for (const part of g[1].split(',')) { const pm = /([A-Za-z_$][\w$]*)/.exec(part); if (pm) jsBound.add(pm[1]); }
  }

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
function spawnJSON(bin, argv, cwd) {
  let res;
  try {
    res = spawnSync(bin, argv, { timeout: SPAWN_TIMEOUT_MS, encoding: 'utf8', env: SAFE_ENV, maxBuffer: 262144, cwd: cwd || undefined });
  } catch (_) { return null; }
  if (!res || res.error || res.signal || res.status !== 0) return null;
  try { return JSON.parse((res.stdout || '').trim()); } catch (_) { return null; }
}

// Python probe: scrub cwd/'' from sys.path (so a bare `import localmod` cannot
// resolve to a project file — installed site-packages stay on path), import the
// base module once, traverse receiverPath, hasattr. 1=present, 0=missing, 2=unknown.
const PY_PROBE =
  'import sys, json, os\n' +
  'cwd = os.getcwd()\n' +
  'sys.path[:] = [p for p in sys.path if p not in ("", ".", cwd)]\n' +
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

function verifyPython(cands, bin, deadline) {
  const byMod = new Map();
  for (const c of cands) {
    if (!byMod.has(c.baseMod)) byMod.set(c.baseMod, []);
    byMod.get(c.baseMod).push(c);
  }
  const tmp = os.tmpdir(); // probe cwd: NOT the repo, so local modules can't resolve
  const fakes = [];
  let spawns = 0;
  for (const [, group] of byMod) {
    if (spawns++ >= MAX_MODULES || Date.now() > deadline) break;
    const checks = group.map((c) => [c.receiverPath, c.attr]);
    // -s: ignore the user site-packages dir (and its .pth files) — closes the
    // PYTHONUSERBASE/.pth startup-exec vector. Main site-packages still resolve.
    const codes = spawnJSON(bin, ['-s', '-c', PY_PROBE, JSON.stringify(checks)], tmp);
    if (!Array.isArray(codes)) continue;
    group.forEach((c, i) => { if (codes[i] === 0) fakes.push(c); });
  }
  return fakes;
}

// Node probe: require(mod) once (resolved from the repo so installed packages are
// found — path specs were already refused in extraction), typeof m[attr]; plus
// globals walked from globalThis. 1=present, 0=missing, 2=unknown.
const JS_PROBE =
  'const mods = JSON.parse(process.argv[1]);\n' +
  'const globals = JSON.parse(process.argv[2]);\n' +
  'const res = { req: {}, glob: [] };\n' +
  'for (const mod of Object.keys(mods)) {\n' +
  '  let m; try { m = require(mod); } catch (e) { res.req[mod] = mods[mod].map(() => 2); continue; }\n' +
  '  res.req[mod] = mods[mod].map((a) => { try { return typeof m[a] === "undefined" ? 0 : 1; } catch (e) { return 2; } });\n' +
  '}\n' +
  'function resolve(p) { let o = globalThis; for (const k of p.split(".")) { if (o == null) return undefined; o = o[k]; } return o; }\n' +
  'res.glob = globals.map((p) => { try { return typeof resolve(p) === "undefined" ? 0 : 1; } catch (e) { return 2; } });\n' +
  'process.stdout.write(JSON.stringify(res));\n';

function verifyJs(cands, deadline) {
  if (Date.now() > deadline) return [];
  const reqByMod = new Map();
  const globals = [];
  for (const c of cands) {
    if (c.kind === 'require') {
      if (!reqByMod.has(c.mod)) reqByMod.set(c.mod, []);
      reqByMod.get(c.mod).push(c);
    } else { globals.push(c); }
  }
  const modsObj = {};
  const groups = [];
  let n = 0;
  for (const [mod, group] of reqByMod) {
    if (n++ >= MAX_MODULES) break;
    modsObj[mod] = group.map((c) => c.attr);
    groups.push([mod, group]);
  }
  const res = spawnJSON('node', ['-e', JS_PROBE, JSON.stringify(modsObj), JSON.stringify(globals.map((c) => c.path))]);
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
  const deadline = Date.now() + TOTAL_DEADLINE_MS;
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
    if (PB) { binsUsed.add(PB); fakes.push(...verifyPython(pyCands, PB, deadline)); }
  }
  if (jsCands.length) { binsUsed.add('node'); fakes.push(...verifyJs(jsCands, deadline)); }

  if (!fakes.length) process.exit(0);

  const seen = new Set();
  const uniq = fakes.filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true)));

  const vers = (Date.now() > deadline ? [...binsUsed] : [...binsUsed].map((b) => runtimeVersion(b))).join(', ');
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
