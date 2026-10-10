'use strict';
// Phantom unread (SkyCrew Primary report): an app primary-builder row whose last native-drained NDJSON line
// has a store twin the store cursor already passed counted that line "unread" forever (nobody acks that
// partition's NDJSON cursor), while `read-primary` could never show it. A line whose store twin is already
// read is READ: the leading twin-read run is skipped, the tail stays contiguous (ack target = cursor + lines).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { unionUnread } = require('../../plugins/anti-hall/companion/lib/devswarm-unread.js');

function fixture(lines, cursor) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-twin-'));
  const inbox = path.join(dir, 'inbox.ndjson');
  const cur = path.join(dir, 'inbox.cursor');
  fs.writeFileSync(inbox, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(cur, String(cursor));
  return { dir, inbox, cur };
}
// A store handle over rows [{hash, body}] with a store read position `pos` (rows after it are unread).
function store(rows, pos) {
  return {
    cursorValue: () => pos,
    listMessages: (_id, o) => (o && Number.isFinite(o.sinceCursor) ? rows.slice(o.sinceCursor) : rows),
  };
}

test('trailing NDJSON line whose store twin is already read is not unread (cursor moves past it)', () => {
  const f = fixture([{ _h: 'native:a', message: 'one' }, { _h: 'native:b', message: 'two' }], 1);
  try {
    const u = unionUnread({ inboxPath: f.inbox, cursorPath: f.cur, storeHandle: store([{ hash: 'native:a', body: 'one' }, { hash: 'native:b', body: 'two' }], 2), id: 'w', now: 1 });
    assert.strictEqual(u.unread, 0);
    assert.deepStrictEqual(u.ndjsonUnreadLines, []);
    assert.strictEqual(u.cursor, 2, 'ack target cursor+lines.length must equal the total');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a line whose store twin is still UNREAD stays unread (no mail is hidden)', () => {
  const f = fixture([{ _h: 'native:a', message: 'one' }, { _h: 'native:b', message: 'two' }], 1);
  try {
    const u = unionUnread({ inboxPath: f.inbox, cursorPath: f.cur, storeHandle: store([{ hash: 'native:a', body: 'one' }, { hash: 'native:b', body: 'two' }], 1), id: 'w', now: 1 });
    assert.strictEqual(u.unread, 1);
    assert.strictEqual(u.ndjsonUnreadLines.length, 1);
    assert.strictEqual(u.cursor, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('only the LEADING read run is skipped; a genuinely new line after it stays unread and the tail stays contiguous', () => {
  const f = fixture([{ _h: 'native:a' , message: 'one' }, { _h: 'native:b', message: 'two' }, { _h: 'native:c', message: 'three' }], 0);
  try {
    const u = unionUnread({ inboxPath: f.inbox, cursorPath: f.cur, storeHandle: store([{ hash: 'native:a', body: 'one' }, { hash: 'native:b', body: 'two' }], 2), id: 'w', now: 1 });
    assert.strictEqual(u.ndjsonUnreadLines.length, 1);
    assert.strictEqual(JSON.parse(u.ndjsonUnreadLines[0])._h, 'native:c');
    assert.strictEqual(u.cursor + u.ndjsonUnreadLines.length, 3);
    assert.strictEqual(u.unread, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('a line with no store twin at all stays unread', () => {
  const f = fixture([{ _h: 'native:z', message: 'lonely' }], 0);
  try {
    const u = unionUnread({ inboxPath: f.inbox, cursorPath: f.cur, storeHandle: store([], 0), id: 'w', now: 1 });
    assert.strictEqual(u.unread, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
