'use strict';
// hooks/lib/codex-apply-patch.js — parser for the Codex `apply_patch` tool's
// PreToolUse payload (tool_input.command = the raw patch text). Fixtures mirror
// the grammar in openai/codex codex-rs/core/assets/tools/apply_patch.lark and the
// lenient parser in codex-rs/apply-patch/src/{parser,streaming_parser}.rs
// (rust-v0.160.0). The first two fixtures are verbatim captured payloads.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const lib = require('../../plugins/anti-hall/hooks/lib/codex-apply-patch.js');
const { parseApplyPatch, patchTargetPaths, isCodexApplyPatch } = lib;

test('captured payload: Add File with a space in the path', () => {
  const r = parseApplyPatch('*** Begin Patch\n*** Add File: my file.txt\n+hi\n*** End Patch');
  assert.deepStrictEqual(r, { ok: true, files: [{ op: 'add', path: 'my file.txt', moveTo: null, addedLines: ['hi'] }] });
});

test('captured payload: Update File + Move to', () => {
  const r = parseApplyPatch('*** Begin Patch\n*** Update File: my file.txt\n*** Move to: sub/renamed.txt\n@@\n-hi\n+hello\n*** End Patch');
  assert.deepStrictEqual(r, { ok: true, files: [{ op: 'update', path: 'my file.txt', moveTo: 'sub/renamed.txt', addedLines: ['hello'] }] });
});

test('captured payload: trailing newline after End Patch', () => {
  const r = parseApplyPatch('*** Begin Patch\n*** Add File: sub.txt\n+from-sub\n*** End Patch\n');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files.map((f) => f.path), ['sub.txt']);
});

test('multiple files: add, delete, update; context and removed lines are not "added"', () => {
  const r = parseApplyPatch([
    '*** Begin Patch',
    '*** Add File: path/add.py',
    '+abc',
    '+def',
    '*** Delete File: path/delete.py',
    '*** Update File: path/update.py',
    '@@ def f():',
    ' ctx',
    '-    pass',
    '+    return 123',
    '*** End of File',
    '*** End Patch',
  ].join('\n'));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files, [
    { op: 'add', path: 'path/add.py', moveTo: null, addedLines: ['abc', 'def'] },
    { op: 'delete', path: 'path/delete.py', moveTo: null, addedLines: [] },
    { op: 'update', path: 'path/update.py', moveTo: null, addedLines: ['    return 123'] },
  ]);
});

test('traversal and absolute paths are reported verbatim (resolution is the caller\'s job)', () => {
  const r = parseApplyPatch('*** Begin Patch\n*** Add File: ../../etc/x.js\n+1\n*** Update File: /abs/y.js\n@@\n+2\n*** End Patch');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files.map((f) => f.path), ['../../etc/x.js', '/abs/y.js']);
  const cwd = path.resolve('/work/repo');
  assert.deepStrictEqual(patchTargetPaths(r.files, cwd), [path.resolve(cwd, '../../etc/x.js'), path.resolve('/abs/y.js')]);
});

test('patchTargetPaths includes both the source and the Move to destination', () => {
  const r = parseApplyPatch('*** Begin Patch\n*** Update File: a.js\n*** Move to: ../out/b.js\n@@\n+x\n*** End Patch');
  const cwd = path.resolve('/w/r');
  assert.deepStrictEqual(patchTargetPaths(r.files, cwd), [path.resolve(cwd, 'a.js'), path.resolve(cwd, '../out/b.js')]);
});

test('header lines are whitespace-trimmed like Codex (leading/trailing spaces around markers)', () => {
  const r = parseApplyPatch('  *** Begin Patch  \n  *** Add File: a b.txt  \n+x\n *** End Patch ');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files.map((f) => f.path), ['a b.txt']);
});

test('heredoc-wrapped patch is accepted (Codex lenient mode)', () => {
  const r = parseApplyPatch("<<'EOF'\n*** Begin Patch\n*** Add File: h.txt\n+x\n*** End Patch\nEOF");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files.map((f) => f.path), ['h.txt']);
});

test('CRLF line endings parse', () => {
  const r = parseApplyPatch('*** Begin Patch\r\n*** Add File: c.txt\r\n+x\r\n*** End Patch\r\n');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files, [{ op: 'add', path: 'c.txt', moveTo: null, addedLines: ['x'] }]);
});

test('Environment ID header is accepted and not reported as a file', () => {
  const r = parseApplyPatch('*** Begin Patch\n*** Environment ID: env1\n*** Add File: e.txt\n+x\n*** End Patch');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files.map((f) => f.path), ['e.txt']);
});

test('an indented header inside an Update hunk is a context line, not a new file (Codex trims only the end there)', () => {
  const r = parseApplyPatch('*** Begin Patch\n*** Update File: a.txt\n@@\n *** Add File: not-a-file.txt\n+y\n*** End Patch');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.files.map((f) => f.path), ['a.txt']);
});

for (const [name, text] of [
  ['empty string', ''],
  ['not a patch', 'echo hi > x'],
  ['missing End Patch', '*** Begin Patch\n*** Add File: a.txt\n+x'],
  ['missing Begin Patch', '*** Add File: a.txt\n+x\n*** End Patch'],
  ['invalid hunk header', '*** Begin Patch\n*** Frobnicate File: a.txt\n*** End Patch'],
  ['empty update hunk', '*** Begin Patch\n*** Update File: a.txt\n*** End Patch'],
  ['bare-marker add with no path', '*** Begin Patch\n*** Add File: \n+x\n*** End Patch'],
  ['junk after End Patch', '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\nmore'],
  ['add line without +', '*** Begin Patch\n*** Add File: a.txt\nx\n*** End Patch'],
  ['non-string input', null],
]) {
  test(`malformed: ${name} -> ok:false`, () => {
    const r = parseApplyPatch(text);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(typeof r.error, 'string');
  });
}

test('isCodexApplyPatch: only tool_name apply_patch with a string command', () => {
  assert.strictEqual(isCodexApplyPatch({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch' } }), true);
  assert.strictEqual(isCodexApplyPatch({ tool_name: 'apply_patch', tool_input: {} }), true);
  assert.strictEqual(isCodexApplyPatch({ tool_name: 'Edit', tool_input: { file_path: 'a' } }), false);
  assert.strictEqual(isCodexApplyPatch(null), false);
});
