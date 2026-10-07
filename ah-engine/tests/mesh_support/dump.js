'use strict';
// Node side of the D45 S0 parity harness (P1). Reads one store the way the hooks do (devswarm-store.js, readOnly, the sqlite
// backend) and prints the canonical dump: the same one-JSON-line-per-record, sorted-keys form `ah-engine mesh dump` prints.
// usage: node dump.js <home> <storeKey>      (store at <home>/.anti-hall/devswarm/store/<storeKey>/devswarm.db)
const path = require('path');
const store = require(path.join(__dirname, '..', '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js'));

function canon(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const out = [];
const emit = (o) => out.push(canon(o) + '\n');

const [home, key] = process.argv.slice(2);
let s = null;
try { s = store.openStore({ home, hash: key, readOnly: true }); } catch (e) { process.stdout.write('OPEN-ERROR\n'); process.exit(0); }
if (!s) { process.stdout.write('OPEN-NULL\n'); process.exit(0); }

try { emit({ k: 'registry', v: s.listRegistry() }); } catch (_) { emit({ k: 'registry', error: true }); }
let ids = [];
try { ids = s.listWorkspaceIds().sort(cmp); } catch (_) { ids = []; }
for (const id of ids) {
  let rows = null;
  try {
    const cursor = s.cursorValue(id);
    const count = s.messageCount(id);
    const unread = s.listMessages(id, { sinceCursor: cursor }).length;
    const nr = s.listNeedsReply(id);
    const all = s.listMessages(id);
    const lastRow = all.length ? all[all.length - 1] : null;
    const seqs = nr.map((x) => x.storeSeq).filter((x) => Number.isFinite(x));
    const g = s.currentGates(id);
    emit({
      k: 'ws', id,
      unread: {
        id, count, cursor, unread, needsReply: nr.length,
        last: lastRow ? { ts: lastRow.ts, seq: lastRow.seq, sender: lastRow.sender, recipient: lastRow.recipient, mtype: lastRow.mtype } : null,
        readers: s.readerCursorRows(id),
      },
      hasCursorRow: s.hasCursorRow(id), broadcastCursor: s.broadcastCursorValue(id),
      gates: g, gateSetBy: s.currentGateSetBy(id), needsReply: nr, previews: s.needsReplyPreviews(id, seqs),
      last3: all.slice(-3),
    });
    rows = all;
  } catch (_) { emit({ k: 'ws', id, error: true }); }
  if (rows) for (const m of rows) emit({ k: 'msg', id, v: m });
}
s.close();
process.stdout.write(out.join(''));
