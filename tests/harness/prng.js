'use strict';
// tests/harness/prng.js — deterministic seeded PRNG + op-sequence generator +
// binary-search shrinker for the Phase 1 mesh invariant harness. Pure Node,
// no deps. See .anti-hall/plans/2026-09-23-mesh-redesign.md Phase 1 and the
// implementing spec (scratchpad/phase1-harness-spec.md) §2.

// mulberry32(seed) -> () => float in [0,1). Tiny, well-known, deterministic
// generator — good enough for a shrinking-lite fuzzer, not for cryptography.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
function pickInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }

// genOpSequence(seed, n, readerIds) -> [{op, args}] — weighted toward a
// register -> send -> pull/ack -> archive lifecycle order, so a run does not
// spend most of its budget on ops that never touch real state (register must
// happen before anything else can act on a reader; archive is rare/terminal).
//
// Ops:
//   register(readerId)
//   send(fromId, toId, text)
//   pull(readerId)
//   ack(readerId)            -- descriptor cursor ack-to-current
//   heartbeat(readerId)
//   tick(readerId)
//   archive(readerId)
function genOpSequence(seed, n, readerIds) {
  const rng = mulberry32(seed);
  const ops = [];
  const registered = new Set();
  const archived = new Set();
  let msgSeq = 0;
  for (let i = 0; i < n; i++) {
    const liveReaders = readerIds.filter((r) => registered.has(r) && !archived.has(r));
    // Weighting: always allow register (idempotent-ish, ensures early coverage);
    // once at least 2 readers are live, weight heavily toward send/pull/ack;
    // archive only once a reader has been live a while (tracked via msgSeq as a
    // cheap proxy so archive does not fire in the first few steps every seed).
    const w = [];
    w.push('register');
    if (liveReaders.length >= 1) { w.push('heartbeat', 'heartbeat', 'tick'); }
    if (liveReaders.length >= 2) {
      w.push('send', 'send', 'send', 'pull', 'pull', 'ack');
    }
    if (liveReaders.length >= 2 && msgSeq > 3) { w.push('archive'); }
    const op = pick(rng, w);

    if (op === 'register') {
      const notYet = readerIds.filter((r) => !registered.has(r));
      const target = notYet.length ? pick(rng, notYet) : pick(rng, readerIds);
      registered.add(target);
      ops.push({ op: 'register', args: { readerId: target } });
      continue;
    }
    if (op === 'send') {
      if (liveReaders.length < 2) continue;
      const from = pick(rng, liveReaders);
      let to = pick(rng, liveReaders);
      let guard = 0;
      while (to === from && guard++ < 5) to = pick(rng, liveReaders);
      if (to === from) continue;
      msgSeq++;
      ops.push({ op: 'send', args: { from, to, text: 'm' + msgSeq + '-' + pickInt(rng, 0, 999) } });
      continue;
    }
    if (op === 'pull' || op === 'ack' || op === 'heartbeat' || op === 'tick') {
      if (!liveReaders.length) continue;
      ops.push({ op, args: { readerId: pick(rng, liveReaders) } });
      continue;
    }
    if (op === 'archive') {
      if (!liveReaders.length) continue;
      const target = pick(rng, liveReaders);
      archived.add(target);
      ops.push({ op: 'archive', args: { readerId: target } });
      continue;
    }
  }
  return ops;
}

// shrinkFailingPrefix(ops, runPrefix) -> { seedOps, failIndex } — binary-search
// for the SHORTEST prefix [0..k] that still fails `runPrefix(ops.slice(0,k+1))`
// (runPrefix returns a falsy/no-throw result on success, throws or returns a
// truthy failure marker on failure). Assumes ops[0..n-1] already fails as a
// whole (caller checks that first). Prints SEED/FAILING_PREFIX per spec §2
// before returning; caller does its own assert.fail with the same info.
function shrinkFailingPrefix(seed, ops, runPrefix) {
  function fails(k) {
    try {
      const r = runPrefix(ops.slice(0, k));
      return !!(r && r.failed);
    } catch (_) {
      return true;
    }
  }
  let lo = 1, hi = ops.length;
  // Invariant: fails(hi) === true (caller's responsibility to have observed
  // this already: re-check defensively, fall back to full length on mismatch).
  if (!fails(hi)) hi = ops.length; // full sequence is the fallback witness
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fails(mid)) hi = mid; else lo = mid + 1;
  }
  const shortest = ops.slice(0, hi);
  // eslint-disable-next-line no-console
  console.log('SEED=' + seed + ' FAILING_PREFIX=' + JSON.stringify(shortest));
  return { seedOps: shortest, failIndex: hi };
}

module.exports = { mulberry32, genOpSequence, shrinkFailingPrefix, pick, pickInt };
