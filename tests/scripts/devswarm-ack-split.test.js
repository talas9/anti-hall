'use strict';
// Phase 5 ACK SPLIT: `inbox read-primary` is read-only and returns a read
// receipt; `inbox ack-primary <id> --receipt <rid>` is the only cursor
// mutation; `inbox drain-primary-legacy` keeps the old same-call drain for one
// release. Fixtures are the harness mesh fixture (isolated HOME, journal
// backend, ANTIHALL_INGEST_DRY_RUN=1).

const { test } = require('node:test');
const assert = require('node:assert');

const ops = require('../harness/ops.js');

const T0 = 1_700_000_000_000;
const READER_A = 'h:4242:1700000000000';
const READER_B = 'h:4343:1700000000000';

function setup(tag) {
  const fx = ops.makeMeshFixture(['r1', 'r2'], 'acksplit-' + tag);
  ops.opRegister(fx, 'r1', T0);
  ops.opRegister(fx, 'r2', T0 + 1);
  return fx;
}
const ctxFor = (fx, now, nonce) => ops.baseCtx(fx, 'r2', now, { instanceNonce: nonce || READER_A });
const peek = (fx, now) => ops.cli.run(['inbox', 'peek-primary', 'r2'], ctxFor(fx, now)).result;

test('read-primary is read-only: returns messages + a read receipt, repeat read returns the same unread set', () => {
  const fx = setup('ro');
  try {
    ops.opSend(fx, 'r1', 'r2', 'one', T0 + 2);
    ops.opSend(fx, 'r1', 'r2', 'two', T0 + 3);
    const a = ops.cli.run(['inbox', 'read-primary', 'r2'], ctxFor(fx, T0 + 4)).result;
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.count, 2);
    assert.equal(a.acked, false);
    assert.match(a.readReceiptId, /^r[a-z0-9]+$/);
    assert.match(a.ackCommand, / inbox ack-primary r2 --receipt r[a-z0-9]+$/);
    const b = ops.cli.run(['inbox', 'read-primary', 'r2'], ctxFor(fx, T0 + 5)).result;
    assert.deepEqual(b.messages.map((m) => m.body), a.messages.map((m) => m.body), 'no ack -> same unread set');
    assert.notEqual(b.readReceiptId, a.readReceiptId);
    assert.equal(peek(fx, T0 + 6).unreadCount, 2, 'nothing acked by reading');
  } finally { fx.cleanup(); }
});

test('ack-primary --receipt advances exactly what the read returned and is idempotent', () => {
  const fx = setup('ack');
  try {
    ops.opSend(fx, 'r1', 'r2', 'one', T0 + 2);
    const read = ops.cli.run(['inbox', 'read-primary', 'r2'], ctxFor(fx, T0 + 3)).result;
    // Mail that lands AFTER the read must survive the ack.
    ops.opSend(fx, 'r1', 'r2', 'late', T0 + 4);
    const ack = ops.cli.run(['inbox', 'ack-primary', 'r2', '--receipt', read.readReceiptId], ctxFor(fx, T0 + 5)).result;
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.equal(ack.alreadyAcked, false);
    const after = ops.cli.run(['inbox', 'read-primary', 'r2'], ctxFor(fx, T0 + 6)).result;
    assert.deepEqual(after.messages.map((m) => m.body), ['late'], 'only the post-read message is still unread');
    const again = ops.cli.run(['inbox', 'ack-primary', 'r2', '--receipt', read.readReceiptId], ctxFor(fx, T0 + 7)).result;
    assert.equal(again.ok, true);
    assert.equal(again.alreadyAcked, true);
    assert.equal(peek(fx, T0 + 8).unreadCount, 1, 're-applying a receipt never acks the late message');
  } finally { fx.cleanup(); }
});

test('ack-primary fails closed (no mutation) for another reader, an unknown receipt, or a missing --receipt', () => {
  const fx = setup('refuse');
  try {
    ops.opSend(fx, 'r1', 'r2', 'one', T0 + 2);
    const read = ops.cli.run(['inbox', 'read-primary', 'r2'], ctxFor(fx, T0 + 3, READER_A)).result;
    const other = ops.cli.run(['inbox', 'ack-primary', 'r2', '--receipt', read.readReceiptId], ctxFor(fx, T0 + 4, READER_B)).result;
    assert.equal(other.ok, false);
    assert.equal(other.reason, 'receipt-owner-mismatch');
    const unknown = ops.cli.run(['inbox', 'ack-primary', 'r2', '--receipt', 'rnope0'], ctxFor(fx, T0 + 5)).result;
    assert.equal(unknown.reason, 'unknown-receipt');
    const missing = ops.cli.run(['inbox', 'ack-primary', 'r2'], ctxFor(fx, T0 + 6)).result;
    assert.equal(missing.reason, 'missing-receipt');
    const expired = ops.cli.run(['inbox', 'ack-primary', 'r2', '--receipt', read.readReceiptId], ctxFor(fx, T0 + 3 + 25 * 3600 * 1000)).result;
    assert.equal(expired.reason, 'receipt-expired');
    assert.equal(peek(fx, T0 + 7).unreadCount, 1, 'no refusal moved a cursor');
  } finally { fx.cleanup(); }
});

test('drain-primary-legacy keeps the one-release same-call read-and-ack', () => {
  const fx = setup('legacy');
  try {
    ops.opSend(fx, 'r1', 'r2', 'one', T0 + 2);
    const r = ops.cli.run(['inbox', 'drain-primary-legacy', 'r2'], ctxFor(fx, T0 + 3)).result;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.count, 1);
    assert.equal(r.readReceiptId, undefined);
    assert.equal(peek(fx, T0 + 4).unreadCount, 0);
  } finally { fx.cleanup(); }
});

test('inbox messages --ack no longer mutates: it returns a receipt', () => {
  const fx = setup('msgack');
  try {
    ops.opSend(fx, 'r1', 'r2', 'one', T0 + 2);
    const r = ops.cli.run(['inbox', 'messages', 'r2', '--ack'], ctxFor(fx, T0 + 3)).result;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.readReceiptId, /^r[a-z0-9]+$/);
    assert.equal(peek(fx, T0 + 4).unreadCount, 1);
  } finally { fx.cleanup(); }
});
