'use strict';
// edit-guard exports its verdict helpers (require must not read stdin or run
// main()), and the skip path in its block texts is a shell-safe absolute command.
require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testHook, editPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'edit-guard.js');
const COORD = { CLAUDE_CODE_ENTRYPOINT: 'cli' };

function blockReason(filePath, cwd) {
  const h = makeHome();
  try {
    return testHook(HOOK, editPayload('Write', { filePath, cwd }), { home: h.home, env: COORD });
  } finally { h.cleanup(); }
}

test('(a) require exports editVerdict, isNotesTarget, delegationReason without reading stdin', () => {
  const r = spawnSync(process.execPath, ['-e',
    `const m=require(${JSON.stringify(HOOK)});process.stdout.write([typeof m.editVerdict,typeof m.isNotesTarget,typeof m.delegationReason].join(','))`],
  { input: '', encoding: 'utf8' });
  assert.strictEqual(r.stdout, 'function,function,function');
});

test('(b) coordinator Write to src/a.js: skip path is an absolute existing script', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'eg-verdict-'));
  try {
    const r = blockReason('src/a.js', dir);
    assert.strictEqual(r.status, 2, r.stdout);
    const m = /node '([^']+)' skip edit-guard/.exec(r.json.reason);
    assert.ok(m, r.json.reason);
    assert.ok(path.isAbsolute(m[1]), m[1]);
    assert.ok(fs.existsSync(m[1]), m[1]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(c) new root HANDOVER-x.md: skip path is an absolute existing script', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'eg-verdict-'));
  try {
    const r = blockReason('HANDOVER-x.md', dir);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.match(r.json.reason, /HANDOVER-LOCATION RULE/);
    const m = /node '([^']+)' skip edit-guard/.exec(r.json.reason);
    assert.ok(m, r.json.reason);
    assert.ok(path.isAbsolute(m[1]), m[1]);
    assert.ok(fs.existsSync(m[1]), m[1]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("(d) shQuote round-trips a path with a space, $ and '", () => {
  const { shQuote } = require('../../plugins/anti-hall/hooks/lib/skip-cmd.js');
  const s = "/tmp/a b/$x/it's";
  const r = spawnSync('sh', ['-c', 'printf %s ' + shQuote(s)]);
  assert.strictEqual(r.stdout.toString(), s);
});

test('(e) isNotesTarget: .claude/push.sh is a notes target, docs/x.sh is not', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'eg-verdict-')));
  try {
    // Child process with closed stdin: a require that read fd 0 must not hang the runner.
    const code = `const m=require(${JSON.stringify(HOOK)});const root=${JSON.stringify(root)};const p={session_id:'t',cwd:root};` +
      "process.stdout.write(JSON.stringify([m.isNotesTarget('.claude/push.sh',root,p),m.isNotesTarget('docs/x.sh',root,p)]))";
    const r = spawnSync(process.execPath, ['-e', code], { input: '', encoding: 'utf8' });
    assert.strictEqual(r.stdout, '[true,false]', r.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
