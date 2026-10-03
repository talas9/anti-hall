'use strict';
// withReaderCursors(fakeStore) — give an in-memory fake store handle the
// reader_cursors primitives (mesh redesign Phase 3) with the SAME storage rule
// the real backends enforce: value is MAX-only per (partition, ns, reader), and
// retiredLine is replaced only when a put carries the key. Loss-free writers
// (fold/reap) raise this table in one txn and then dual-write the legacy store
// cursor through the fake's own setCursor, so existing setCursor assertions keep
// observing the advance.
function withReaderCursors(fakeS) {
  const rows = new Map();
  const list = (partition) => Array.from(rows.values())
    .filter((r) => r.partition === String(partition)).map((r) => Object.assign({}, r));
  const put = (rec) => {
    const k = rec.partition + '|' + rec.ns + '|' + rec.reader;
    const cur = rows.get(k);
    const next = Object.assign({ retiredLine: null }, cur || {}, {
      partition: String(rec.partition), ns: rec.ns, reader: rec.reader, updatedAt: rec.updatedAt,
    });
    next.value = Math.max(cur ? cur.value : 0, rec.value);
    if (Object.prototype.hasOwnProperty.call(rec, 'retiredLine')) next.retiredLine = rec.retiredLine;
    rows.set(k, next);
  };
  fakeS.readerCursorRows = list;
  fakeS.readerCursorTxn = (fn) => fn({ rows: list, put });
  return fakeS;
}
module.exports = { withReaderCursors };
