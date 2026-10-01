'use strict';
// command-guard.js — field reports (0.120.8/0.120.9):
//  (1) `cd <sub> && npx vitest run <files> | tail` must resolve the test files against the tracked cd target;
//  (2) a chain of individually-allowed segments is allowed; one heavy segment anywhere still blocks;
//  (3) a pipeline ending in a bounded sink is bounded regardless of read-only filters before it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';

function run(command, cwd) {
  const h = makeHome();
  try {
    return testHook(HOOK, {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
      session_id: 't', cwd,
    }, { home: h.home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  } finally { h.cleanup(); }
}
const blocked = (c, cwd) => run(c, cwd).status === 2;

function makeProj() {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-chain-')));
  fs.mkdirSync(path.join(proj, 'webui/test/unit'), { recursive: true });
  for (const f of ['x.test.ts', 'y.test.ts']) fs.writeFileSync(path.join(proj, 'webui/test/unit', f), '\n');
  fs.mkdirSync(path.join(proj, 'tests/tools'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'tests/tools/test_a.py'), '\n');
  return proj;
}

test('report 1: cd <sub> && npx vitest run <2 existing files> 2>&1 | tail is allowed; non-existent / flags stay blocked', () => {
  const proj = makeProj();
  try {
    const b = (c) => blocked(c, proj);
    assert.strictEqual(b('cd webui && npx vitest run test/unit/x.test.ts test/unit/y.test.ts 2>&1 | tail -4'), false);
    assert.strictEqual(b('cd webui && npx vitest run test/unit/x.test.ts 2>&1 | tail -4'), false);
    assert.ok(b('cd webui && npx vitest run test/unit/nope.test.ts 2>&1 | tail -4'));
    assert.ok(b('cd webui ; npx vitest run test/unit/x.test.ts 2>&1 | tail -4'));
    assert.ok(b('npx vitest run test/unit/x.test.ts 2>&1 | tail -4')); // no cd: file is not under the hook cwd
    assert.ok(b('cd webui && npx vitest run --root .. test/unit/x.test.ts | tail -4'));
    assert.ok(b('cd webui && npx vitest run --prefix . test/unit/x.test.ts | tail -4'));
    assert.ok(b('cd webui && npx vitest run test/unit/x.test.ts test/unit/y.test.ts test/unit/x.test.ts | tail -4'));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('report 2: chain of individually-allowed segments is allowed; a heavy segment anywhere blocks', () => {
  const proj = makeProj();
  try {
    const b = (c) => blocked(c, proj);
    const chain = 'python3 -m pytest -q tests/tools/test_a.py 2>&1 | tail -1; git check-ignore -v a b | head; git check-ignore -q c && echo X || echo Y';
    assert.strictEqual(b(chain), false);
    assert.ok(b(chain + '; npm test'));
    assert.ok(b('npm test; ' + chain));
    assert.ok(b('python3 -m pytest -q tests/tools/test_a.py 2>&1 | tail -1; pytest -q | tail -1'));
    assert.ok(b('python3 -m pytest -q tests/tools/test_a.py 2>&1 | tail -1 && npm run build | tail -1'));
    assert.ok(b('python3 -m pytest -q tests/tools/test_a.py; echo $(npm test)'));
    assert.ok(b('python3 -m pytest -q tests/tools/test_a.py 2>&1 | tail -1; for i in 1; do npm test; done'));
    assert.ok(b('python3 -m pytest -q tests/tools/test_a.py'));
    assert.ok(b('python3 -m pytest -q tests/tools/test_a.py 2>&1 | tail -1; (npm test)'));
    assert.ok(b('python3 -m pytest -q tests/tools/test_a.py 2>&1 | tail -1; echo `npm test`'));
    assert.ok(b('python3 -m pytest -q tests/tools/test_a.py 2>&1 | tail -1; git status | xargs npm test'));
    assert.ok(b('git status; bash -c "npm test"'));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('addendum: pipeline ending in a bounded sink is bounded through read-only filters; others keep blocking', () => {
  const proj = makeProj();
  try {
    const b = (c) => blocked(c, proj);
    const t = 'npx vitest run webui/test/unit/x.test.ts';
    assert.strictEqual(b(`${t} 2>&1 | grep -E "Tests|Test Files|FAIL" | head -5`), false);
    assert.strictEqual(b(`${t} 2>&1 | sed -n '1,5p' | tail -3`), false);
    assert.strictEqual(b(`${t} 2>&1 | sort | uniq -c | head -5`), false);
    assert.strictEqual(b(`${t} 2>&1 | cut -c1-80 | tr a b | wc -l`), false);
    assert.strictEqual(b(`${t} 2>&1 | awk '{print $1}' | head -3`), false);
    assert.ok(b(`${t} 2>&1 | grep FAIL`)); // last stage not a bounded sink
    assert.ok(b(`${t} 2>&1 | tee out.txt | head -5`));
    assert.ok(b(`${t} 2>&1 | xargs rm | head -5`));
    assert.ok(b(`${t} 2>&1 | sh | head -5`));
    assert.ok(b(`${t} 2>&1 | grep FAIL > out.txt | head -5`));
    assert.ok(b(`${t} 2>&1 | awk '{system("rm x")}' | head -5`));
    assert.ok(b(`${t} 2>&1 | awk '{print > "f"}' | head -5`));
    assert.ok(b(`${t} 2>&1 | sed -i s/a/b/ f | head -5`));
    assert.ok(b(`${t} 2>&1 | sort -o out.txt | head -5`));
    assert.ok(b(`${t} 2>&1 | sed -n 'w out.txt' | head -5`));
    assert.ok(b(`${t} 2>&1 | uniq - out.txt | head -5`));
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});
