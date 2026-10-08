'use strict';
// Concurrency harness, Node side (D45 stage 2): in ONE scratch home, run `n` real devswarm.js sends (direct to child-1,
// every third a broadcast) through the CLI's own run() — per-id lock, INSERT OR IGNORE, readback — interleaved with
// reader-cursor acks (readerCursorTxn, BEGIN IMMEDIATE) and broadcast-cursor advances, while the engine does the same
// from other processes. Prints one JSON line per operation: {op, ok, sent, seq, body} or {op, reader, value}.
// usage: node conc_node.js <tag> <n>     (HOME is the scratch home; cwd the repo)
const path = require('path');
const os = require('os');
const plugin = path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(plugin, 'scripts', 'devswarm.js'));
const store = require(path.join(plugin, 'companion', 'lib', 'devswarm-store.js'));
const repokey = require(path.join(plugin, 'companion', 'lib', 'devswarm-repokey.js'));
if (os.homedir() === os.userInfo().homedir) { process.stderr.write('refusing: HOME is the real home\n'); process.exit(2); }
const [tag, nRaw] = process.argv.slice(2);
const n = Number(nRaw);
const key = repokey.repoKeyForWorktree(process.cwd());
const out = [];
for (let i = 0; i < n; i++) {
  const body = tag + '-' + i;
  const argv = i % 3 === 2 ? ['send', '--broadcast', '--message', body] : ['send', '--to', 'child-1', '--message', body];
  const { result } = cli.run(argv, {});
  out.push({ op: 'send', ok: !!result.ok, sent: !!result.sent, seq: result.seq, body, error: result.error || null });
  const s = store.openStore({ home: os.homedir(), hash: key });
  try {
    const shared = Math.floor(Math.random() * 1000);
    s.readerCursorTxn((tx) => {
      tx.put({ partition: 'child-1', ns: 'store', reader: 'r-shared', value: shared, updatedAt: Date.now() });
      tx.put({ partition: 'child-1', ns: 'store', reader: 'r-node-' + tag, value: i, updatedAt: Date.now() });
    });
    out.push({ op: 'ack', reader: 'r-shared', value: shared });
    out.push({ op: 'ack', reader: 'r-node-' + tag, value: i });
    if (i % 4 === 0) s.advanceBroadcastCursor('child-1');
  } finally { s.close(); }
}
process.stdout.write(out.map((o) => JSON.stringify(o)).join('\n') + '\n');
