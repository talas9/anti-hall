'use strict';
// 0.112: `devswarm.js send --to <id1>,<id2>[,…]` (or a repeated --to) sends one
// body to several recipients without a shell `for` loop. Every recipient is
// attempted even when one fails; the verb exits non-zero if ANY failed.
// In-process via cli.run with an isolated tmp HOME, the journal backend and a
// real git repo + linked worktrees as the fixture.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-send-multi-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const main = path.join(base, 'main');
  cp.spawnSync('git', ['init', '-q', main]);
  cp.spawnSync('git', ['-C', main, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', main, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(main, 'README.md'), 'x');
  cp.spawnSync('git', ['-C', main, 'add', '.']);
  cp.spawnSync('git', ['-C', main, 'commit', '-q', '-m', 'init']);
  const repoKey = repokey.repoKeyForWorktree(main);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const tag of ['a', 'b']) {
      const wt = path.join(base, 'wt-' + tag);
      cp.spawnSync('git', ['-C', main, 'worktree', 'add', '-q', wt, '-b', 'branch-' + tag]);
      s.upsertRegistry({ id: 'child-' + tag, worktreePath: wt, sessionId: 's-' + tag });
    }
  } finally { s.close(); }
  const msgFile = path.join(base, 'msg.txt');
  fs.writeFileSync(msgFile, 'hello — both of you\n');
  const run = (argv, env) => cli.run(['send'].concat(argv), { home, backend: 'journal', env: env || {}, cwd: main });
  const messages = (id) => {
    const st = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { return st.listMessages(id) || []; } finally { st.close(); }
  };
  return { base, home, main, msgFile, run, messages };
}

test('two recipients (comma list) both receive the message; per-recipient ok/seq/bytes', () => {
  const f = fixture();
  try {
    const r = f.run(['--to', 'child-a,child-b', '--message-file', f.msgFile]);
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.strictEqual(r.result.ok, true);
    assert.deepStrictEqual(r.result.recipients.map((x) => x.to), ['child-a', 'child-b']);
    for (const x of r.result.recipients) {
      assert.strictEqual(x.ok, true);
      assert.ok(Number.isFinite(x.seq), 'seq present');
      assert.strictEqual(x.bytes, Buffer.byteLength('hello — both of you\n'));
    }
    assert.strictEqual(f.messages('child-a').length, 1);
    assert.strictEqual(f.messages('child-b').length, 1);
    assert.strictEqual(f.messages('child-b')[0].body, 'hello — both of you\n');
  } finally { rm(f.base); }
});

test('a repeated --to works the same as a comma list', () => {
  const f = fixture();
  try {
    const r = f.run(['--to', 'child-a', '--to', 'child-b', '--message', 'hi']);
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.strictEqual(f.messages('child-a').length, 1);
    assert.strictEqual(f.messages('child-b').length, 1);
  } finally { rm(f.base); }
});

test('one failing recipient never stops the others; the verb exits non-zero', () => {
  const f = fixture();
  try {
    const r = f.run(['--to', 'ghost,child-a', '--message-file', f.msgFile]);
    assert.strictEqual(r.code, 2);
    assert.strictEqual(r.result.ok, false);
    assert.strictEqual(r.result.failed, 1);
    assert.strictEqual(r.result.sent, 1);
    const [ghost, a] = r.result.recipients;
    assert.strictEqual(ghost.ok, false);
    assert.match(ghost.error, /not a registered mesh workspace/);
    assert.strictEqual(a.ok, true);
    assert.strictEqual(f.messages('child-a').length, 1, 'the recipient after the failure still got the message');
  } finally { rm(f.base); }
});

test('duplicate ids are deduped (one message each)', () => {
  const f = fixture();
  try {
    let r = f.run(['--to', 'child-a,child-b,child-a', '--to', 'child-b', '--message', 'x']);
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.deepStrictEqual(r.result.recipients.map((x) => x.to), ['child-a', 'child-b']);
    // a list that dedupes to ONE id takes the ordinary single-send path
    r = f.run(['--to', 'child-a,child-a', '--message', 'y']);
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.strictEqual(r.result.recipients, undefined);
    assert.strictEqual(r.result.to, 'child-a');
    assert.strictEqual(f.messages('child-a').length, 2);
    assert.strictEqual(f.messages('child-b').length, 1);
  } finally { rm(f.base); }
});

test('several recipients refuse --broadcast / --to-primary / --cc-primary before sending anything', () => {
  const f = fixture();
  try {
    for (const extra of [['--broadcast'], ['--to-primary'], ['--cc-primary']]) {
      const r = f.run(['--to', 'child-a,child-b', '--message', 'z'].concat(extra));
      assert.strictEqual(r.code, 2, extra.join(' '));
    }
    assert.strictEqual(f.messages('child-a').length, 0);
  } finally { rm(f.base); }
});

test('--quiet renders one line per recipient', () => {
  const line = cli.sendQuietLine({
    ok: false, recipients: [
      { to: 'child-a', ok: true, seq: 3, bytes: 5 },
      { to: 'ghost', ok: false, error: 'not registered' },
    ],
  });
  assert.strictEqual(line, 'sent seq 3 -> child-a, 5 bytes, ok\nok:false -> ghost: not registered');
});

test('devswarm.sendMultiRecipient=false keeps the old single-recipient parsing (last --to wins)', () => {
  const f = fixture();
  try {
    const r = f.run(['--to', 'child-a', '--to', 'child-b', '--message', 'old'], { ANTIHALL_DEVSWARM_SEND_MULTI_RECIPIENT: 'false' });
    assert.strictEqual(r.code, 0, JSON.stringify(r.result));
    assert.strictEqual(f.messages('child-a').length, 0);
    assert.strictEqual(f.messages('child-b').length, 1);
  } finally { rm(f.base); }
});
