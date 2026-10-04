'use strict';
// guard-io writeAll: a non-blocking pipe that is momentarily full throws EAGAIN; the output must be
// retried (bounded), never truncated.

require('../helpers/isolate-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const io = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'guard-io.js'));

function eagain() { const e = new Error('resource temporarily unavailable'); e.code = 'EAGAIN'; return e; }

function withMockedWrite(impl, fn) {
  const real = fs.writeSync;
  fs.writeSync = impl;
  try { return fn(); } finally { fs.writeSync = real; }
}

test('writeAll retries EAGAIN and delivers the whole buffer', () => {
  let eagains = 2; const got = [];
  withMockedWrite((fd, buf, off, len) => {
    if (eagains-- > 0) throw eagain();
    got.push(Buffer.from(buf.subarray(off, off + len)).toString('utf8'));
    return len;
  }, () => io.writeAll(1, 'hello block'));
  assert.deepStrictEqual(got, ['hello block']);
  assert.strictEqual(eagains, -1, 'writeSync was called three times (two EAGAIN, one success)');
});

test('writeAll resumes after a partial write that is followed by EAGAIN', () => {
  const calls = []; let n = 0;
  withMockedWrite((fd, buf, off, len) => {
    n++;
    if (n === 1) { calls.push('partial'); return 4; }
    if (n === 2) throw eagain();
    calls.push(Buffer.from(buf.subarray(off, off + len)).toString('utf8'));
    return len;
  }, () => io.writeAll(2, 'abcdefgh'));
  assert.deepStrictEqual(calls, ['partial', 'efgh']);
});

test('writeAll gives up on a non-EAGAIN error without retrying, and never throws', () => {
  let n = 0;
  withMockedWrite(() => { n++; const e = new Error('broken pipe'); e.code = 'EPIPE'; throw e; }, () => io.writeAll(1, 'x'));
  assert.strictEqual(n, 1);
});

test('writeAll stops retrying EAGAIN after the cap (bounded wait)', () => {
  let n = 0;
  const t0 = Date.now();
  withMockedWrite(() => { n++; throw eagain(); }, () => io.writeAll(1, 'x'));
  const ms = Date.now() - t0;
  assert.ok(n > 2 && n < 2000, 'retried a bounded number of times, got ' + n);
  assert.ok(ms < io.WRITE_RETRY_CAP_MS + 2000, 'finished near the cap, took ' + ms + 'ms');
});

test('writeAll bounds the retry wait by elapsed time even when each sleep oversleeps', () => {
  // A fake monotonic clock that advances 100 ms per 5 ms sleep (a heavily loaded host).
  let now = 0n; let n = 0;
  const realHr = process.hrtime.bigint;
  const realWait = Atomics.wait;
  process.hrtime.bigint = () => now;
  Atomics.wait = () => { now += 100n * 1000000n; return 'timed-out'; };
  try {
    withMockedWrite(() => { n++; throw eagain(); }, () => io.writeAll(1, 'x'));
  } finally { process.hrtime.bigint = realHr; Atomics.wait = realWait; }
  // 3000 ms cap / 100 ms per sleep = 30 sleeps; the nominal-sum bug would retry ~600 times.
  assert.ok(n >= 2 && n <= 32, 'stopped on elapsed time, retried ' + n + ' times');
});
