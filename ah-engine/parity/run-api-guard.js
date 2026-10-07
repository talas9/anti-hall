#!/usr/bin/env node
// Parity of the built-in `api-guard` check against hooks/api-guard.js (PreToolUse on Write, Edit, MultiEdit, Bash and
// apply_patch). The Node guard probes the installed python3 / node, so this needs both on PATH.
//   node run-api-guard.js --engine ../target/debug/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--edits real-edits.jsonl] [--cmds real-cmds.jsonl] [--mode oneshot|daemon|both] [--real 400] [--seed 1]
// The engine must never be weaker than Node (D74): wherever Node blocks (a fabricated stdlib or builtin attribute) the
// engine may only defer, and wherever it answers it must print what Node printed. Corpus: (1) fabricated and real
// references in Python and JavaScript through Write, Edit and MultiEdit for every extension, shadowing, strings,
// comments, local and path-like modules, third-party packages; (2) the shell-write shapes Node's shell-writes parser
// covers (redirects, tee, heredocs, echo/printf, sed -i, cp/mv, python -c writes) carrying fabricated references, and
// the shapes it cannot see; (3) apply_patch (Add, Update, Move, Delete); (4) switches (guards.apiGuard,
// guards.shellWriteChecks, guards.apiGuardThirdparty, skip); (5) payload shape fuzz; (6) real edits and commands.
const { arg, runParity, readCmds, rng } = require('./guardlib.js');
const fs = require('fs');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const add = (payload, ctx, id) => scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps: [{ payload }] });
const pl = (tool, input, extra) => Object.assign({ hook_event_name: 'PreToolUse', tool_name: tool, session_id: 's', cwd: '/tmp', tool_input: input }, extra || {});
const DEF = { env: { ANTIHALL_INGEST_DRY_RUN: '1' } };
const mk = (o = {}) => Object.assign({}, DEF, o, { env: Object.assign({}, DEF.env, o.env || {}) });

// ---- code snippets ---------------------------------------------------------------------------------------------
const PY = {
  fakeOs: 'import os\nos.fakefn()\n', fakeOsPath: 'import os\nprint(os.path.nope_join("a"))\n', realOs: 'import os\nprint(os.path.join("a", "b"))\n', fakeAlias: 'import os.path as p\np.fake_thing()\n',
  fakeJson: 'import json\njson.loads_all("x")\n', realJson: 'import json\njson.dumps({})\n', fakeMath: 'import math\nx = math.fake_const\n', fromImport: 'from os import path\npath.fake_fn()\n', fromImportAs: 'from collections import OrderedDict as OD\nOD.fake()\n',
  shadowParam: 'import os\ndef f(os):\n    return os.fake\n', shadowAssign: 'import os\nos = 5\nos.fake\n', shadowWith: 'import io\nwith open("a") as io:\n    io.fake\n',
  inString: 'import os\ns = "os.fakefn()"\n', inComment: 'import os\n# os.fakefn()\n', inDocstring: 'import os\n"""os.fakefn()"""\n', noImport: 'os.fakefn()\n', importInString: 's = "import os"\nos.fakefn()\n',
  dunder: 'import os\nos.__fake__\n', local: 'import mymod\nmymod.fake()\n', relative: 'from . import util\nutil.fake()\n', third: 'import numpy as np\nnp.fake_fn()\n', thirdReal: 'import numpy as np\nnp.array([1])\n',
  multi: 'import os, sys\nsys.fakeattr\nos.fake2\n', asyncio: 'import asyncio\nasyncio.fake_task()\n', typing: 'import typing\ntyping.FakeType\n', crlf: 'import os\r\nos.fakefn()\r\n', tabs: '\timport os\n\tos.fakefn()\n',
  unicodeBefore: 'import os\n\u00e9os.fakefn()\n', unicodeAfter: 'import os\nos\u00e9.fakefn()\n', mixed: 'import os\nimport re\nre.fake_fn()\nos.path.join("a")\n', empty: '', onlyImport: 'import os\n', big: 'import os\n' + 'x = 1\n'.repeat(100000) + 'os.fake\n',
  classAttr: 'import os\nclass A:\n    os = 1\nA.os.fake\n', lambdaParam: 'import os\nf = lambda os: os.fake\n', forVar: 'import os\nfor os in range(3):\n    os.fake\n', exceptAs: 'import os\ntry:\n    pass\nexcept Exception as os:\n    os.fake\n',
  star: 'from os import *\nfake()\n', semi: 'import os; os.fakefn()\n', indentedImport: 'def f():\n    import os\n    os.fakefn()\n',
};
const JS = {
  reqFs: "const fs = require('fs');\nfs.fakeFn('a');\n", reqFsReal: "const fs = require('fs');\nfs.readFileSync('a');\n", reqInline: "require('path').nonsense('a');\n", reqInlineReal: "require('path').join('a');\n", reqPathSpec: "const x = require('./x');\nx.fake();\n",
  reqAbs: "require('/abs/mod').fake;\n", reqDotDot: "require('a/../b').fake;\n", reqBackslash: "require('a\\\\b').fake;\n", reqScoped: "const q = require('@scope/pkg');\nq.fake();\n", thirdLodash: "const _ = require('lodash');\n_.fakeFn();\n",
  gArray: 'Array.fakeStatic(1);\n', gArrayReal: 'Array.isArray(1);\n', gProto: 'Array.prototype.fakeProto.call(1);\n', gProtoReal: 'Array.prototype.map.call([], x => x);\n', gObject: 'Object.nope({});\n', gJson: 'JSON.parse_all("x");\n', gJsonReal: 'JSON.stringify({});\n',
  gMath: 'Math.fakeMath(1);\n', gPromise: 'Promise.fakeAll([]);\n', gDate: 'Date.fakeNow();\n', gBuffer: 'Buffer.fakeFrom("a");\n', gSymbol: 'Symbol.fakeIterator;\n', gReflect: 'Reflect.fake({});\n',
  shadowParam: 'function f(Array) { return Array.fake(); }\n', shadowConst: 'const Math = {};\nMath.fake();\n', shadowAssign: 'Object = {};\nObject.fake();\n', inString: "const s = 'Array.fakeStatic';\n", inComment: '// Array.fakeStatic\n/* Math.fake */\n', inTemplate: 'const s = `Array.fakeStatic`;\n',
  reqInComment: "// const fs = require('fs'); fs.fake\n", assignProp: "const fs = require('fs');\nfs.fake = 1;\n", reassign: "let fs = require('fs');\nfs = other;\nfs.fake;\n", tsImport: "import fs from 'fs';\nfs.fakeFn();\n", tsType: 'const a: Array<string> = [];\nArray.fakeStatic;\n',
  nodeColon: "const fs = require('node:fs');\nfs.fake;\n", dunder: "const fs = require('fs');\nfs.__fake;\n", multi: "const fs = require('fs'), p = require('path');\np.fake;\n", unicode: "Array.fake\u00e9();\n", unicodeBefore: '\u00e9Array.fake();\n', crlf: "const fs = require('fs');\r\nfs.fakeFn();\r\n",
  empty: '', plain: 'const a = 1;\nconsole.log(a);\n', big: 'var a = 1;\n'.repeat(100000) + 'Array.fakeStatic();\n', regexLit: "const r = /Array.fake/;\n", methodChain: 'foo.Array.fake();\n', optional: 'Array?.fake();\n', mathPI: 'Math.PI;\nMath.fakeX;\n',
};
const PYEXT = ['x.py', 'x.pyi', 'X.PY', 'dir/a.b.py', 'a.py.txt', 'a.pyc', 'py', '.py', 'a.pyw', 'a.pyx'];
const JSEXT = ['x.js', 'x.mjs', 'x.cjs', 'x.ts', 'x.tsx', 'x.jsx', 'X.JS', 'a.js.map', 'a.json', 'a.jsx.bak', 'a.d.ts', 'a.mts', 'a.cts', 'js'];
const OTHER = ['README.md', 'a.rs', 'a.sh', 'Makefile', 'a', '', 'a.PY ', 'a.py\n'];

// ---- (1) edits ---------------------------------------------------------------------------------------------------
const tools = (file, code) => [pl('Write', { file_path: file, content: code }), pl('Edit', { file_path: file, old_string: 'x', new_string: code }), pl('MultiEdit', { file_path: file, edits: [{ old_string: 'a', new_string: 'harmless();' }, { old_string: 'b', new_string: code }] })];
for (const [k, code] of Object.entries(PY)) { for (const f of ['x.py', pick(PYEXT)]) for (const p of tools(f, code)) add(p, mk(), `py-${k}-${f}-${p.tool_name}`); }
for (const [k, code] of Object.entries(JS)) { for (const f of ['x.js', pick(JSEXT)]) for (const p of tools(f, code)) add(p, mk(), `js-${k}-${f}-${p.tool_name}`); }
for (const f of PYEXT) for (const p of tools(f, PY.fakeOs)) add(p, mk(), `pyext-${f}-${p.tool_name}`);
for (const f of JSEXT) for (const p of tools(f, JS.gArray)) add(p, mk(), `jsext-${f}-${p.tool_name}`);
for (const f of OTHER) for (const code of [PY.fakeOs, JS.gArray]) for (const p of tools(f, code)) add(p, mk(), `other-${f}-${p.tool_name}`);
for (const [k, code] of Object.entries({ py: PY.fakeOs, js: JS.gArray })) for (const f of ['a.py', 'a.js']) add(pl('Write', { file_path: f, content: code }), mk(), `cross-${k}-${f}`);

// ---- (2) shell writes ---------------------------------------------------------------------------------------------
const FAKEPY = 'import os\\nos.fakefn()\\n', FAKEJS = "Array.fakeStatic(1);\\n";
const SH = [
  "cat > a.py <<'EOF'\nimport os\nos.fakefn()\nEOF", 'cat > a.py <<EOF\nimport os\nos.fakefn()\nEOF', "cat >> a.py <<'EOF'\nimport os\nos.fakefn()\nEOF", "cat <<'EOF' > a.py\nimport os\nos.fakefn()\nEOF", "cat <<'EOF' | tee a.py\nimport os\nos.fakefn()\nEOF",
  'tee a.py <<EOF\nimport os\nos.fakefn()\nEOF', "cat > dir/a.js <<'EOF'\nArray.fakeStatic(1);\nEOF", "cat > a.ts <<'EOF'\nconst fs = require('fs');\nfs.fakeFn();\nEOF", `echo "${FAKEPY}" > a.py`, `echo -e "${FAKEPY}" > a.py`, `printf "${FAKEPY}" > a.py`,
  `printf '${FAKEPY}' >> a.py`, `echo '${FAKEJS}' > a.js`, `echo "import os; os.fakefn()" > a.py`, `echo 'import os; os.fakefn()' | tee a.py`, `echo 'import os; os.fakefn()' | tee -a a.py b.py`, `printf 'import json\\njson.nope\\n' | tee b.py`,
  "sed -i 's/x/os.fakefn()/' a.py", "sed -i '' 's/x/os.fakefn()/' a.py", "perl -pi -e 's/x/os.fakefn()/' a.py", "cp a.py b.py", "mv a.py b.py", "python3 -c \"open('a.py','w').write('import os\\nos.fakefn()')\"", "python -c 'open(\"a.py\", \"a\").write(\"import os; os.fake\")'",
  "python3 - <<'PY'\nopen('a.py','w').write('import os\\nos.fakefn()')\nPY", "node -e \"require('fs').writeFileSync('a.js','Array.fakeStatic()')\"", "bash -c 'cat > a.py <<EOF\nimport os\nos.fake()\nEOF'", "sh -c \"echo 'import os; os.fake' > a.py\"",
  'f=a; echo "import os; os.fake" > $f.py', 'echo "import os; os.fake" > "a b.py"', "echo 'import os; os.fake' > 'a b.py'", 'echo "import os; os.fake" > ./sub/../a.py', 'echo "import os; os.fake" > /tmp/a.py', 'echo "import os; os.fake" > ~/a.py', 'echo "import os; os.fake" > a.PY',
  'echo "import os; os.fake" > a.py && echo done', 'cd src && cat > a.py <<EOF\nimport os\nos.fake()\nEOF', 'ls a.py', 'cat a.py', 'grep fake a.py', 'python3 a.py', 'node a.js', 'git add a.py', 'git commit -m "add a.py"', 'rm a.py', 'echo hi > out.txt', 'echo "import os; os.fake" > out.txt',
  'cat > a.sh <<EOF\nimport os\nos.fake\nEOF', "cat > a.py <<'EOF'\nimport os\nos.path.join('a')\nEOF", "cat > a.js <<'EOF'\nconst a = 1;\nEOF", 'npm test -- a.test.js', 'pytest tests/test_a.py', 'eslint src/a.ts src/b.tsx', 'tsc --noEmit a.ts', 'python3 -m py_compile a.py',
  'echo x > a.pyi', 'echo x > a.mjs', 'echo x > a.cjs', 'echo x > a.jsx', 'echo x > a.tsx', 'echo x > a.pyc', 'echo x > a.json', 'curl -o a.js https://x/y.js', 'wget -O a.py https://x/y.py', 'unzip a.zip', 'echo ".py"', 'echo py', 'a.py', '', '   ',
  'cat > a.py <<EOF\nimport os\nos.fake\n', 'cat <<EOF > a.py\nimport os\r\nos.fake()\r\nEOF', "echo $'import os\\nos.fake()' > a.py", 'echo "import os\u00a0os.fake()" > a.py', 'echo "\u00e9.py"', 'echo x > \u00e9.py', 'echo x > a.\u0070y', 'x=.py; echo "import os; os.fake" > a$x',
];
const SW_OFF = mk({ settings: { guards: { shellWriteChecks: false } } });
for (const c of SH) { add(pl('Bash', { command: c }), mk(), `bash-${c.slice(0, 24).replace(/\s+/g, '_')}`); }
for (const c of SH.slice(0, 12)) add(pl('Bash', { command: c }), SW_OFF, `bash-swoff-${c.slice(0, 20)}`);
for (const c of SH.slice(0, 12)) add(pl('Bash', { command: c }, { cwd: '/' }), mk(), `bash-cwd-${c.slice(0, 20)}`);

// ---- (3) apply_patch ----------------------------------------------------------------------------------------------
const patch = body => `*** Begin Patch\n${body}\n*** End Patch`;
const PATCHES = [
  patch('*** Add File: a.py\n+import os\n+os.fakefn()'), patch('*** Add File: a.js\n+Array.fakeStatic(1);'), patch('*** Update File: a.py\n@@\n import os\n+os.fakefn()'), patch('*** Update File: a.py\n*** Move to: b.js\n@@\n+Array.fakeStatic(1);'),
  patch('*** Update File: a.txt\n*** Move to: b.py\n@@\n+import os\n+os.fakefn()'), patch('*** Delete File: a.py'), patch('*** Add File: a.md\n+import os\n+os.fakefn()'), patch('*** Add File: a.py\n+import os\n+os.path.join("a")'),
  patch('*** Add File: a.ts\n+const fs = require("fs");\n+fs.fakeFn();'), patch('*** Add File: a.py\n+x = 1\n*** Add File: b.js\n+Array.fakeStatic(1);'), '*** Begin Patch\n*** Add File: a.py\n+import os\n+os.fake()\n', 'not a patch', '', patch(''), patch('*** Add File: a.py'),
  patch('*** Add File: dir/sub/a.py\n+import json\n+json.nope'), patch('*** Add File: a.PY\n+import os\n+os.fake()'), patch('*** Add File: a b.py\n+import os\n+os.fake()'), patch('*** Update File: a.py\n@@ def f():\n-    os.x\n+    os.fakefn()'),
];
for (const [i, c] of PATCHES.entries()) { add(pl('apply_patch', { command: c }), mk(), `patch-${i}`); add(pl('apply_patch', { command: c }, { turn_id: 't', model: 'm' }), mk(), `patchcodex-${i}`); }

// ---- (4) switches --------------------------------------------------------------------------------------------------
const probe = [pl('Write', { file_path: 'a.py', content: PY.fakeOs }), pl('Write', { file_path: 'a.py', content: PY.third }), pl('Write', { file_path: 'a.js', content: JS.thirdLodash }), pl('Write', { file_path: 'a.js', content: JS.gArray }), pl('Bash', { command: SH[0] }), pl('Write', { file_path: 'a.rs', content: PY.fakeOs })];
const ctxs = {
  def: mk(), apiOff: mk({ settings: { guards: { apiGuard: false } } }), apiOffWord: mk({ settings: { guards: { apiGuard: 'off' } } }), apiOpt: mk({ env: { CLAUDE_PLUGIN_OPTION_GUARDS_API_GUARD: 'false' } }), apiOptStored: mk({ claude: { pluginConfigs: { 'anti-hall': { options: { guards_api_guard: false } } } } }),
  apiJunk: mk({ settings: { guards: { apiGuard: 'maybe' } } }), swOff: SW_OFF, swEnv: mk({ env: { ANTIHALL_SHELL_WRITE_CHECKS: '0' } }), swEnvOn: mk({ env: { ANTIHALL_SHELL_WRITE_CHECKS: '1' }, settings: { guards: { shellWriteChecks: false } } }),
  tpOn: mk({ settings: { guards: { apiGuardThirdparty: true } } }), tpEnv: mk({ env: { ANTIHALL_API_GUARD_THIRDPARTY: '1' } }), tpEnvWord: mk({ env: { ANTIHALL_API_GUARD_THIRDPARTY: 'yes' } }), tpOff: mk({ env: { ANTIHALL_API_GUARD_THIRDPARTY: '0' }, settings: { guards: { apiGuardThirdparty: true } } }),
  skip: mk({ skip: { 'api-guard': Date.now() + 3600e3 } }), skipAll: mk({ skip: { all: Date.now() + 3600e3 } }), skipExpired: mk({ skip: { all: Date.now() - 1e3 } }), skipOther: mk({ skip: { 'git-guard': Date.now() + 3600e3 } }),
  badSettings: mk({ settings: '{x' }), badSkip: mk({ skip: '{x' }), spawnTimeout: mk({ env: { ANTIHALL_API_GUARD_SPAWN_TIMEOUT_MS: '1' } }),
};
for (const [k, c] of Object.entries(ctxs)) for (const [i, p] of probe.entries()) add(p, c, `ctx-${k}-${i}`);

// ---- (5) payload shape fuzz --------------------------------------------------------------------------------------------
const shapes = {
  'no-tool-input': { hook_event_name: 'PreToolUse', tool_name: 'Write' }, 'null-input': pl('Write', null), 'str-input': pl('Write', 'x'), 'arr-input': pl('Write', [1]), 'num-input': pl('Write', 5),
  'content-num': pl('Write', { file_path: 'a.py', content: 5 }), 'content-null': pl('Write', { file_path: 'a.py', content: null }), 'content-arr': pl('Write', { file_path: 'a.py', content: [PY.fakeOs] }), 'content-obj': pl('Write', { file_path: 'a.py', content: { a: 1 } }),
  'path-num': pl('Write', { file_path: 5, content: PY.fakeOs }), 'path-arr': pl('Write', { file_path: ['a.py'], content: PY.fakeOs }), 'path-obj': pl('Write', { file_path: { toString: 1 }, content: PY.fakeOs }), 'path-true': pl('Write', { file_path: true, content: PY.fakeOs }),
  'path-null': pl('Write', { file_path: null, content: PY.fakeOs }), 'path-empty': pl('Write', { file_path: '', content: PY.fakeOs }), 'path-missing': pl('Write', { content: PY.fakeOs }), 'path-zero': pl('Write', { file_path: 0, content: PY.fakeOs }),
  'edit-newstring-missing': pl('Edit', { file_path: 'a.py', old_string: 'x' }), 'edit-newstring-num': pl('Edit', { file_path: 'a.py', new_string: 5 }), 'multi-no-edits': pl('MultiEdit', { file_path: 'a.py' }), 'multi-edits-str': pl('MultiEdit', { file_path: 'a.py', edits: 'x' }),
  'multi-edits-null-entry': pl('MultiEdit', { file_path: 'a.py', edits: [null, 5, { new_string: PY.fakeOs }, {}] }), 'multi-edits-fake-first': pl('MultiEdit', { file_path: 'a.py', edits: [{ new_string: PY.fakeOs }] }),
  'notebook': pl('NotebookEdit', { notebook_path: 'a.ipynb', new_source: PY.fakeOs }), 'read-tool': pl('Read', { file_path: 'a.py' }), 'no-tool': { hook_event_name: 'PreToolUse', tool_input: { file_path: 'a.py', content: PY.fakeOs } }, 'tool-num': pl(5, { file_path: 'a.py', content: PY.fakeOs }),
  'bash-cmd-num': pl('Bash', { command: 5 }), 'bash-cmd-arr': pl('Bash', { command: ['cat > a.py'] }), 'bash-cmd-null': pl('Bash', { command: null }), 'bash-no-cmd': pl('Bash', {}), 'bash-no-input': pl('Bash', undefined),
  'patch-cmd-num': pl('apply_patch', { command: 5 }), 'patch-no-cmd': pl('apply_patch', {}), 'patch-arr': pl('apply_patch', { command: [PATCHES[0]] }),
  'huge-code': pl('Write', { file_path: 'a.py', content: 'import os\n' + 'x'.repeat(700000) + '\nos.fake\n' }), 'unicode-path': pl('Write', { file_path: 'd\u00e9/\u00e9.py', content: PY.fakeOs }), 'nul-path': pl('Write', { file_path: 'a\u0000.py', content: PY.fakeOs }),
  'agent-fields': pl('Write', { file_path: 'a.py', content: PY.fakeOs }, { agent_id: 'a', agent_type: 'x' }), 'codex-fields': pl('Write', { file_path: 'a.py', content: PY.fakeOs }, { turn_id: 't', model: 'm' }),
};
for (const [id, p] of Object.entries(shapes)) add(p, mk(), `shape-${id}`);

// ---- (6) real edits and commands --------------------------------------------------------------------------------------
const want = +arg('--real', 400);
let edits = [], cmds = [];
try { edits = fs.readFileSync(arg('--edits', '../../../port-b13.real-edits.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* optional */ }
try { cmds = readCmds(arg('--cmds', '../../../port-b13.real-cmds.jsonl')); } catch { /* optional */ }
for (let i = 0; i < Math.min(want, edits.length); i++) {
  const e = pick(edits);
  const input = e.tool === 'Write' ? { file_path: e.file, content: e.code } : e.tool === 'Edit' ? { file_path: e.file, old_string: 'x', new_string: e.code } : { file_path: e.file, edits: [{ old_string: 'x', new_string: e.code }] };
  add(pl(e.tool, input), mk(), `real-edit-${i}`);
}
// real code written under a code file name (the file name decides, so retarget real non-code edits too)
for (let i = 0; i < Math.min(want, edits.length); i++) { const e = pick(edits); add(pl('Write', { file_path: pick([...PYEXT.slice(0, 3), ...JSEXT.slice(0, 6)]), content: e.code }), mk(), `real-retarget-${i}`); }
for (let i = 0; i < Math.min(want, cmds.length * 2); i++) add(pl('Bash', { command: pick(cmds).cmd }), mk(), `real-cmd-${i}`);
console.error(`scenarios=${scenarios.length} edits=${edits.length} cmds=${cmds.length}`);
runParity({ name: 'api-guard', check: 'api-guard', hookFile: 'api-guard.js', scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'both'), conc: +arg('--conc', 8), show: +arg('--show', 15), events: ['PreToolUse'], tools: ['*'] });
