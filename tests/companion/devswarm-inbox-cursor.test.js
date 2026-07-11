'use strict';
// devswarm-inbox-cursor: the minimal inbox read/ack cursor-advance primitive
// (audit P1-A). Verifies its cursor arithmetic stays byte-for-byte compatible with
// liveness.js unreadBacklog() (same non-empty-line filter), that acks are atomic
// bare-integer writes, and that over-ack / bad-input are clamped fail-safe.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-inbox-cursor.js',
));
const { unreadBacklog } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-cursor-'));
  return { d, cleanup: () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };
}
// Seed an NDJSON inbox with n messages plus optional blank/whitespace lines mixed
// in, to prove the non-empty filter matches unreadBacklog exactly.
function seedInbox(dir, lines) {
  const p = path.join(dir, 'inbox.ndjson');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('countMessages: counts only non-empty lines (matches unreadBacklog filter)', () => {
  const { d, cleanup } = tmp();
  try {
    const inbox = seedInbox(d, ['{"m":1}', '', '  ', '{"m":2}', '{"m":3}']);
    assert.strictEqual(C.countMessages(inbox), 3);
    // parity: with a zero cursor unreadBacklog yields the same count.
    const cur = path.join(d, 'cursor');
    fs.writeFileSync(cur, '0');
    assert.strictEqual(unreadBacklog(inbox, cur).lines.length, 3);
  } finally { cleanup(); }
});

test('countMessages: absent inbox -> 0 (fail-safe)', () => {
  const { d, cleanup } = tmp();
  try {
    assert.strictEqual(C.countMessages(path.join(d, 'nope.ndjson')), 0);
  } finally { cleanup(); }
});

test('readCursor: bare int, {line:n}, and fail-safe defaults', () => {
  const { d, cleanup } = tmp();
  try {
    const p = path.join(d, 'cursor');
    fs.writeFileSync(p, '4'); assert.strictEqual(C.readCursor(p), 4);
    fs.writeFileSync(p, '{"line":7}'); assert.strictEqual(C.readCursor(p), 7);
    fs.writeFileSync(p, 'garbage'); assert.strictEqual(C.readCursor(p), 0);
    fs.writeFileSync(p, '-3'); assert.strictEqual(C.readCursor(p), 0);
    assert.strictEqual(C.readCursor(path.join(d, 'absent')), 0);
  } finally { cleanup(); }
});

test('readUnread: returns the unread slice with count/cursor/total, matching unreadBacklog', () => {
  const { d, cleanup } = tmp();
  try {
    const inbox = seedInbox(d, ['{"m":1}', '{"m":2}', '{"m":3}', '{"m":4}']);
    const cur = path.join(d, 'cursor');
    fs.writeFileSync(cur, '2');
    const r = C.readUnread(inbox, cur);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.cursor, 2);
    assert.strictEqual(r.total, 4);
    assert.strictEqual(r.known, true);
    assert.deepStrictEqual(r.lines, unreadBacklog(inbox, cur).lines);
  } finally { cleanup(); }
});

test('readUnread: unreadable cursor -> known:false, empty (fail-safe, never throws)', () => {
  const { d, cleanup } = tmp();
  try {
    const inbox = seedInbox(d, ['{"m":1}']);
    const cur = path.join(d, 'cursor');
    fs.writeFileSync(cur, 'not-a-number');
    const r = C.readUnread(inbox, cur);
    assert.strictEqual(r.known, false);
    assert.strictEqual(r.count, 0);
  } finally { cleanup(); }
});

test('advanceCursor: marks all present messages read -> unreadBacklog goes empty', () => {
  const { d, cleanup } = tmp();
  try {
    const inbox = seedInbox(d, ['{"m":1}', '{"m":2}', '{"m":3}']);
    const cur = path.join(d, 'cursor');
    const n = C.advanceCursor(inbox, cur);
    assert.strictEqual(n, 3);
    assert.strictEqual(fs.readFileSync(cur, 'utf8'), '3'); // bare integer written
    const after = unreadBacklog(inbox, cur);
    assert.strictEqual(after.known, true);
    assert.strictEqual(after.lines.length, 0);
  } finally { cleanup(); }
});

test('advanceCursor: newly appended messages become unread again', () => {
  const { d, cleanup } = tmp();
  try {
    const inbox = seedInbox(d, ['{"m":1}', '{"m":2}']);
    const cur = path.join(d, 'cursor');
    C.advanceCursor(inbox, cur);
    assert.strictEqual(unreadBacklog(inbox, cur).lines.length, 0);
    fs.appendFileSync(inbox, '{"m":3}\n');
    assert.strictEqual(unreadBacklog(inbox, cur).lines.length, 1);
    C.advanceCursor(inbox, cur);
    assert.strictEqual(unreadBacklog(inbox, cur).lines.length, 0);
  } finally { cleanup(); }
});

test('ackTo: partial ack advances cursor to an absolute consumed-count', () => {
  const { d, cleanup } = tmp();
  try {
    const inbox = seedInbox(d, ['{"m":1}', '{"m":2}', '{"m":3}', '{"m":4}']);
    const cur = path.join(d, 'cursor');
    const n = C.ackTo(cur, 2, undefined, inbox);
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(unreadBacklog(inbox, cur).lines, ['{"m":3}', '{"m":4}']);
  } finally { cleanup(); }
});

test('ackTo: over-ack (n > total) clamps to total so later messages are not swallowed', () => {
  const { d, cleanup } = tmp();
  try {
    const inbox = seedInbox(d, ['{"m":1}', '{"m":2}']);
    const cur = path.join(d, 'cursor');
    const n = C.ackTo(cur, 99, undefined, inbox);
    assert.strictEqual(n, 2); // clamped to total, not 99
    fs.appendFileSync(inbox, '{"m":3}\n');
    assert.strictEqual(unreadBacklog(inbox, cur).lines.length, 1); // the new one is unread
  } finally { cleanup(); }
});

test('ackTo: negative / non-numeric input clamps to 0 (fail-safe)', () => {
  const { d, cleanup } = tmp();
  try {
    const inbox = seedInbox(d, ['{"m":1}']);
    const cur = path.join(d, 'cursor');
    assert.strictEqual(C.ackTo(cur, -5, undefined, inbox), 0);
    assert.strictEqual(C.ackTo(cur, 'abc', undefined, inbox), 0);
    assert.strictEqual(fs.readFileSync(cur, 'utf8'), '0');
  } finally { cleanup(); }
});

test('ackTo: write is atomic and leaves no .tmp behind', () => {
  const { d, cleanup } = tmp();
  try {
    const inbox = seedInbox(d, ['{"m":1}', '{"m":2}']);
    const cur = path.join(d, 'sub', 'cursor'); // nested dir created via mkdirSync recursive
    C.ackTo(cur, 1, undefined, inbox);
    assert.strictEqual(fs.readFileSync(cur, 'utf8'), '1');
    assert.strictEqual(fs.existsSync(cur + '.tmp'), false);
  } finally { cleanup(); }
});
