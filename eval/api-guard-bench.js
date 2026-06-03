#!/usr/bin/env node
'use strict';
// api-guard-bench.js — reproducible benchmark for the api-guard hook.
//
// Substantiates the README/CHANGELOG "~95% catch / ~0% false-positive" claim
// with a committed, auditable corpus and runner (no hidden subagent runs).
//
//   node eval/api-guard-bench.js
//
// It feeds each case to the REAL hook (plugins/.../api-guard.js) as a Write
// payload and checks the exit code (2 = block, 0 = allow):
//   - CATCH:  in-scope fabricated APIs that SHOULD block.
//   - FALSE POSITIVE: real/valid code that must NOT block — including a sweep of
//     every .js file in plugins/ (real Node code using real builtins).
//   - OUT-OF-SCOPE: fabrications v1 intentionally does not check (receiver-typed
//     instance methods, depth-3 chains) — reported separately, expected to allow.
//
// Exit 0 if catch-rate and FP-rate meet thresholds; non-zero otherwise, so CI
// can gate on it. Zero deps.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'plugins', 'anti-hall', 'hooks', 'api-guard.js');

function runHook(file_path, content) {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path, content }, session_id: 'bench', cwd: '/tmp',
  });
  const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: 'utf8', timeout: 30000 });
  return r.status; // 2 = block, 0 = allow
}

// label: 'catch' (in-scope fake, expect block) | 'real' (expect allow) | 'oos' (out-of-scope fake, expect allow)
const CASES = [
  // ---- in-scope fabricated APIs (expect BLOCK) ----
  ['py', 'catch', 'import os\nos.quantum_fork()\n'],
  ['py', 'catch', 'import asyncio\nasyncio.run_all([a, b])\n'],
  ['py', 'catch', 'import itertools\nitertools.batched_by(xs, key)\n'],
  ['py', 'catch', 'import functools\nfunctools.memoize(f)\n'],
  ['py', 'catch', 'import random\nrandom.shuffled(xs)\n'],
  ['py', 'catch', 'import json\njson.parse(s)\n'],
  ['py', 'catch', 'import array\narray.fancy_index(i)\n'],
  ['py', 'catch', 'from collections import OrderedDict\nOrderedDict.move_to_front(k)\n'],
  ['py', 'catch', 'from datetime import datetime\ndatetime.frobnicate(x)\n'],
  ['py', 'catch', 'from pathlib import Path\nPath.read_json(p)\n'],
  ['js', 'catch', "const crypto = require('crypto');\ncrypto.createHashStream('sha256');\n"],
  ['js', 'catch', "const fs = require('fs');\nfs.readFileSyncUntil(p, d);\n"],
  ['js', 'catch', "const util = require('util');\nutil.promisifyAll(o);\n"],
  ['js', 'catch', 'Promise.allSettledRace([p1, p2]);\n'],
  ['js', 'catch', 'Promise.anyOf([p1]);\n'],
  ['js', 'catch', 'Object.fromList([[1, 2]]);\n'],
  ['js', 'catch', 'Math.clampValue(1, 0, 2);\n'],
  ['js', 'catch', "JSON.parseSafe('{}');\n"],
  ['js', 'catch', "Number.parseIntStrict('5');\n"],
  ['js', 'catch', "const b = Buffer.fromString('x');\n"],
  ['js', 'catch', 'const x = Array.prototype; const y = Array.from2([1]);\n'],

  // ---- real / valid code (expect ALLOW) ----
  ['py', 'real', 'import os\nos.getpid()\n'],
  ['py', 'real', 'import asyncio\nasyncio.gather(a, b)\n'],
  ['py', 'real', 'import itertools\nitertools.batched(xs, 2)\n'],
  ['py', 'real', 'import functools\nfunctools.lru_cache(maxsize=8)\n'],
  ['py', 'real', 'import json\njson.loads("{}")\n'],
  ['py', 'real', 'from collections import OrderedDict\nOrderedDict.move_to_end(k)\n'],
  ['py', 'real', 'from datetime import datetime\ndatetime.fromisoformat("2020-01-01")\n'],
  ['py', 'real', 'from pathlib import Path\nPath.read_text(p)\n'],
  // false-positive regressions: stdlib/global names used as locals
  ['py', 'real', 'array = [1, 2, 3]\narray.append(4)\n'],
  ['py', 'real', 'time = get_elapsed()\ntime.total_seconds()\n'],
  ['py', 'real', 'string = "hi"\nstring.center(10)\n'],
  ['py', 'real', 'copy = data\ncopy.update(x)\n'],
  ['py', 'real', 'from datetime import datetime\ndatetime = wrap()\ndatetime.custom()\n'],
  ['js', 'real', "const crypto = require('crypto');\ncrypto.createHash('sha256');\n"],
  ['js', 'real', "const fs = require('fs');\nfs.readFileSync(p);\n"],
  ['js', 'real', 'Promise.allSettled([p]);\nPromise.any([p]);\n'],
  ['js', 'real', 'Object.fromEntries([[1, 2]]);\n'],
  ['js', 'real', "const b = Buffer.from('x');\n"],
  ['js', 'real', 'const Math = myLib;\nMath.clampValue(1, 0, 2);\n'],
  ['js', 'real', "let fs = require('fs');\nfs = require('fs-extra');\nfs.copySync(a, b);\n"],
  ['js', 'real', 'const Set = MyOrderedSet;\nSet.fromArray([1]);\n'],

  // ---- out-of-scope fabrications (v1 does not check -> expect ALLOW) ----
  ['py', 'oos', 's = "x"\ns.removeboth("a", "b")\n'],            // receiver-typed instance method
  ['py', 'oos', 'xs = [1, 2]\nxs.rotate(1)\n'],                  // instance method on a list
  ['js', 'oos', "const fs = require('fs');\nfs.promises.readJSON(p);\n"], // depth-3 chain
];

function langPath(lang) { return lang === 'py' ? '/tmp/bench.py' : '/tmp/bench.js'; }

const results = { catch: { ok: 0, n: 0, miss: [] }, real: { ok: 0, n: 0, fp: [] }, oos: { ok: 0, n: 0 } };
for (const [lang, label, code] of CASES) {
  const status = runHook(langPath(lang), code);
  const blocked = status === 2;
  if (label === 'catch') {
    results.catch.n++;
    if (blocked) results.catch.ok++; else results.catch.miss.push(code.trim().replace(/\n/g, ' ⏎ '));
  } else if (label === 'real') {
    results.real.n++;
    if (!blocked) results.real.ok++; else results.real.fp.push(code.trim().replace(/\n/g, ' ⏎ '));
  } else {
    results.oos.n++;
    if (!blocked) results.oos.ok++;
  }
}

// Real-code FP sweep: every .js under plugins/ must ALLOW.
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const sweep = { ok: 0, n: 0, fp: [] };
const pluginsDir = path.join(__dirname, '..', 'plugins');
for (const f of walk(pluginsDir, [])) {
  let content;
  try { content = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  sweep.n++;
  if (runHook(f, content) !== 2) sweep.ok++; else sweep.fp.push(f);
}

const catchRate = results.catch.n ? results.catch.ok / results.catch.n : 0;
const realFP = results.real.n ? (results.real.n - results.real.ok) / results.real.n : 0;
const sweepFP = sweep.n ? (sweep.n - sweep.ok) / sweep.n : 0;

const pct = (x) => (100 * x).toFixed(1) + '%';
console.log('================ api-guard bench ================');
console.log('python: ' + (spawnSync('python3', ['--version']).status === 0 ? 'python3' : '(python3 missing — Python cases will be skipped/allow)'));
console.log('');
console.log('CATCH (in-scope fabricated APIs that should block): ' + results.catch.ok + '/' + results.catch.n + '  (' + pct(catchRate) + ')');
if (results.catch.miss.length) results.catch.miss.forEach((m) => console.log('  MISS: ' + m));
console.log('FALSE POSITIVE (curated real code): ' + (results.real.n - results.real.ok) + '/' + results.real.n + '  (' + pct(realFP) + ')');
if (results.real.fp.length) results.real.fp.forEach((m) => console.log('  FP: ' + m));
console.log('FALSE POSITIVE (real .js sweep of plugins/): ' + (sweep.n - sweep.ok) + '/' + sweep.n + '  (' + pct(sweepFP) + ')');
if (sweep.fp.length) sweep.fp.forEach((m) => console.log('  FP: ' + m));
console.log('OUT-OF-SCOPE fabrications (expected allow in v1): ' + results.oos.ok + '/' + results.oos.n + ' allowed');
console.log('');

// Gate: catch >= 90% (in-scope), zero false positives anywhere.
const totalFP = (results.real.n - results.real.ok) + (sweep.n - sweep.ok);
const passed = catchRate >= 0.90 && totalFP === 0;
console.log(passed ? '✓ PASS — catch >= 90% in-scope, 0 false positives' : '✗ FAIL — see above');
console.log('================================================');
process.exit(passed ? 0 : 1);
