'use strict';
// finding-dedup.js — unit tests. Pure-logic pieces (buildPairs, union-find
// grouping, the pair cap) are exercised with a stubbed `askFn` (no network,
// no Jev config at all). The mode-off/error-fail-open behavior is exercised
// end-to-end against the REAL jev-assist.ask() path with an isolated HOME and
// a local mock HTTP server standing in for the gateway (same pattern as
// tests/hooks/jev-assist.test.js) — never the real network.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const MOD = require('../../plugins/anti-hall/scripts/finding-dedup.js');
const { buildPairs, groupPairs, makeUnionFind, dedupe, MAX_PAIRS, CONFIDENCE_FLOOR } = MOD;

// ---------------------------------------------------------------------------
// buildPairs
// ---------------------------------------------------------------------------

test('buildPairs: pairs findings in the same file within +/-40 lines', () => {
  const findings = [
    { id: 'a', file: 'x.js', line: 10, text: 'leak' },
    { id: 'b', file: 'x.js', line: 45, text: 'leak restated' },
    { id: 'c', file: 'x.js', line: 60, text: 'too far' }, // 15 from b, 50 from a
  ];
  const pairs = buildPairs(findings).map(([x, y]) => [x.id, y.id]);
  assert.deepStrictEqual(pairs, [['a', 'b'], ['b', 'c']]);
});

test('buildPairs: pairs the same id recurring across two different rounds', () => {
  const findings = [
    { id: 'p0-1', file: 'a.js', line: 5, round: 1, text: 'still here' },
    { id: 'p0-1', file: 'b.js', line: 500, round: 2, text: 'still here' },
    { id: 'p0-1', file: 'c.js', line: 900, round: 2, text: 'same round as b, not a candidate' },
  ];
  const pairs = buildPairs(findings).map(([x, y]) => [x.round, y.round]);
  // (finding[0], finding[1]) rounds 1/2 differ -> candidate; (finding[0],
  // finding[2]) rounds 1/2 also differ -> candidate; (finding[1], finding[2])
  // both round 2 -> NOT a candidate (same round, excluded).
  assert.deepStrictEqual(pairs, [[1, 2], [1, 2]]);
});

test('buildPairs: no pairing across different files or beyond the line window', () => {
  const findings = [
    { id: 'a', file: 'x.js', line: 10, text: 't1' },
    { id: 'b', file: 'y.js', line: 10, text: 't2' },
    { id: 'c', file: 'x.js', line: 60, text: 't3' },
  ];
  assert.deepStrictEqual(buildPairs(findings), []);
});

// ---------------------------------------------------------------------------
// the pair cap
// ---------------------------------------------------------------------------

test('the pair cap: buildPairs output is sliced to MAX_PAIRS (200), deterministically', () => {
  // 25 findings in the same file, 1 line apart -> C(25,2) = 300 candidate pairs, capped to 200.
  const findings = Array.from({ length: 25 }, (_, i) => ({ id: 'f' + i, file: 'big.js', line: i, text: 't' + i }));
  const all = buildPairs(findings);
  assert.strictEqual(all.length, 300);
  const capped = all.slice(0, MAX_PAIRS);
  assert.strictEqual(capped.length, MAX_PAIRS);

  // dedupe() itself must only ever invoke askFn MAX_PAIRS times, never 300.
  let calls = 0;
  return dedupe(findings, {
    askFn: async () => { calls++; return null; },
  }).then((result) => {
    assert.strictEqual(calls, MAX_PAIRS);
    assert.deepStrictEqual(result.groups, []);
  });
});

// ---------------------------------------------------------------------------
// grouping via union-find
// ---------------------------------------------------------------------------

test('makeUnionFind: union + find collapse a chain into one root', () => {
  const uf = makeUnionFind(['a', 'b', 'c', 'd']);
  uf.union('a', 'b');
  uf.union('b', 'c');
  assert.strictEqual(uf.find('a'), uf.find('c'));
  assert.notStrictEqual(uf.find('a'), uf.find('d'));
});

test('groupPairs: A~B and B~C confirmed duplicates merge into one 3-member group; D stays out', () => {
  const edges = [
    { a: 'A', b: 'B', confidence: 0.9 },
    { a: 'B', b: 'C', confidence: 0.87 },
  ];
  const groups = groupPairs(edges, ['A', 'B', 'C', 'D']);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].ids.sort(), ['A', 'B', 'C']);
  assert.strictEqual(groups[0].pairs.length, 2);
});

test('groupPairs: no confirmed edges -> no groups at all (singletons are dropped)', () => {
  assert.deepStrictEqual(groupPairs([], ['A', 'B', 'C']), []);
});

test('dedupe(): end-to-end with a stubbed askFn produces the same grouped shape', async () => {
  const findings = [
    { id: 'r1-1', file: 'x.js', line: 10, round: 1, text: 'null deref on user.id' },
    { id: 'r2-3', file: 'x.js', line: 12, round: 2, text: 'user.id can be null here too' },
    { id: 'r1-2', file: 'y.js', line: 100, round: 1, text: 'unrelated off-by-one' },
  ];
  const result = await dedupe(findings, {
    askFn: async (a, b) => (a.id === 'r1-1' && b.id === 'r2-3' ? { a: a.id, b: b.id, confidence: 0.93 } : null),
  });
  assert.strictEqual(result.groups.length, 1);
  assert.deepStrictEqual(result.groups[0].ids.sort(), ['r1-1', 'r2-3']);
  assert.strictEqual(result.groups[0].pairs[0].confidence, 0.93);
});

test('dedupe(): the same id in two rounds with NO confirmed edge forms no group (allIds deduped, never a [X, X] group)', async () => {
  const findings = [
    { id: 'reviewer-1', file: 'x.js', line: 10, round: 1, text: 'leak' },
    { id: 'reviewer-1', file: 'y.js', line: 900, round: 2, text: 'different bug, same id' },
    { id: 'reviewer-1', file: 'y.js', line: 900, round: 2, text: 'exact repeat of the row above' },
  ];
  const result = await dedupe(findings, { askFn: async () => null });
  assert.deepStrictEqual(result.groups, []);
});

test('dedupe(): findings are keyed by id+round — a confirmed cross-round pair names both rounds, and a finding is never paired with itself', async () => {
  const seen = [];
  const findings = [
    { id: 'p0-1', file: 'a.js', line: 5, round: 1, text: 'race' },
    { id: 'p0-1', file: 'a.js', line: 6, round: 2, text: 'race again' },
    { id: 'p0-1', file: 'a.js', line: 6, round: 2, text: 'race again' }, // exact repeat -> dropped
    { id: 'other', file: 'z.js', line: 1, round: 1, text: 'unrelated' },
  ];
  const result = await dedupe(findings, {
    askFn: async (a, b) => { seen.push([a.id + '/' + a.round, b.id + '/' + b.round]); return { a: a.id, b: b.id, confidence: 0.95 }; },
  });
  assert.deepStrictEqual(seen, [['p0-1/1', 'p0-1/2']], 'one candidate pair, never self, never the repeat');
  assert.strictEqual(result.groups.length, 1);
  assert.deepStrictEqual(result.groups[0].ids.sort(), ['p0-1@round1', 'p0-1@round2']);
  assert.deepStrictEqual(result.groups[0].pairs, [{ a: 'p0-1@round1', b: 'p0-1@round2', confidence: 0.95 }]);
});

test('buildPairs: an exact repeat (same id AND round) is never paired with itself', () => {
  const f = { id: 'a', file: 'x.js', line: 1, round: 1, text: 't' };
  assert.deepStrictEqual(buildPairs([f, Object.assign({}, f)]), []);
});

// ---------------------------------------------------------------------------
// the 0.85 confidence threshold (askPair's own extra floor, via the real
// jev-assist.ask() path — noul confidence = |noul-0.5|*2, see jev-client.js)
// ---------------------------------------------------------------------------

const ENV_KEYS = ['HOME', 'ANTIHALL_JEV', 'AI_GATEWAY_API_KEY', 'ANTIHALL_JEV_TEST_ENDPOINT', 'ANTIHALL_JEV_FINDING_DEDUP'];

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, overrides);
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function withMockServer(handler, fn) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      Promise.resolve(fn(`http://127.0.0.1:${port}/mock`))
        .then((v) => server.close(() => resolve(v)))
        .catch((e) => server.close(() => reject(e)));
    });
  });
}

function noulHandler(n, hits) {
  return (req, res) => {
    if (hits) hits.count++;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answers: { decision: { noul: n } } }));
    });
  };
}

function freshAskPair() {
  const LIB = require.resolve('../../plugins/anti-hall/scripts/finding-dedup.js');
  const ASSIST = require.resolve('../../plugins/anti-hall/hooks/lib/jev-assist.js');
  const CLIENT = require.resolve('../../plugins/anti-hall/hooks/lib/jev-client.js');
  delete require.cache[LIB];
  delete require.cache[ASSIST];
  delete require.cache[CLIENT];
  return require(LIB);
}

test('the 0.85 threshold: noul=1.0 (confidence 1.0) IS grouped, noul=0.9 (confidence 0.8) is NOT', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000, integrations: { findingDedup: 'on' } });
    // Distinct id pairs per sub-case -- jev-assist caches by content hash
    // (id + cacheKey), and both sub-cases share the same isolated HOME/cache
    // file, so reusing the same a/b ids would silently serve the FIRST
    // call's cached answer to the second.
    const a1 = { id: 'a1', file: 'x.js', line: 1, text: 'leak' };
    const b1 = { id: 'b1', file: 'x.js', line: 2, text: 'leak restated' };
    const a2 = { id: 'a2', file: 'y.js', line: 1, text: 'leak' };
    const b2 = { id: 'b2', file: 'y.js', line: 2, text: 'leak restated' };

    await withMockServer(noulHandler(1.0), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { askPair } = freshAskPair();
        const edge = await askPair(a1, b1, { home: h.home });
        assert.deepStrictEqual(edge, { a: 'a1', b: 'b1', confidence: 1 });
      });
    });

    await withMockServer(noulHandler(0.9), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { askPair } = freshAskPair();
        const edge = await askPair(a2, b2, { home: h.home });
        assert.strictEqual(edge, null, 'confidence 0.8 is below the 0.85 floor');
      });
    });
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// mode off gives no calls
// ---------------------------------------------------------------------------

test('mode off: getMode(findingDedup) !== on -> jev-assist never hits the network', async () => {
  const h = makeHome();
  try {
    // Jev enabled overall, but findingDedup explicitly off.
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000, integrations: { findingDedup: 'off' } });
    const hits = { count: 0 };
    const a = { id: 'a', file: 'x.js', line: 1, text: 'leak' };
    const b = { id: 'b', file: 'x.js', line: 2, text: 'leak restated' };

    await withMockServer(noulHandler(1.0, hits), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { askPair } = freshAskPair();
        const edge = await askPair(a, b, { home: h.home });
        assert.strictEqual(edge, null);
      });
    });
    assert.strictEqual(hits.count, 0, 'no HTTP request should have been made');
  } finally {
    h.cleanup();
  }
});

test('mode off (Jev disabled entirely, default jev.json): dedupe() over a real pair yields zero groups, zero network calls', async () => {
  const h = makeHome();
  try {
    // No jev.json at all -> Jev disabled by default -> getMode() returns 'off'.
    const hits = { count: 0 };
    const findings = [
      { id: 'a', file: 'x.js', line: 1, text: 'leak' },
      { id: 'b', file: 'x.js', line: 2, text: 'leak restated' },
    ];
    await withMockServer(noulHandler(1.0, hits), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { dedupe: freshDedupe } = freshAskPair();
        const result = await freshDedupe(findings, { home: h.home });
        assert.deepStrictEqual(result.groups, []);
      });
    });
    assert.strictEqual(hits.count, 0);
  } finally {
    h.cleanup();
  }
});

test('Jev off: dedupe() over findings whose id recurs across rounds yields zero groups and zero network calls', async () => {
  const h = makeHome();
  try {
    const hits = { count: 0 };
    const findings = [
      { id: 'reviewer-1', file: 'x.js', line: 1, round: 1, text: 'leak' },
      { id: 'reviewer-1', file: 'x.js', line: 2, round: 2, text: 'leak restated' },
    ];
    await withMockServer(noulHandler(1.0, hits), async (endpoint) => {
      await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: endpoint }, async () => {
        const { dedupe: freshDedupe } = freshAskPair();
        const result = await freshDedupe(findings, { home: h.home });
        assert.deepStrictEqual(result.groups, []);
      });
    });
    assert.strictEqual(hits.count, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// errors fail open
// ---------------------------------------------------------------------------

test('errors fail open: askFn throwing for one pair drops only that edge, never the whole run', async () => {
  const findings = [
    { id: 'a', file: 'x.js', line: 1, text: 't1' },
    { id: 'b', file: 'x.js', line: 2, text: 't2' },
    { id: 'c', file: 'x.js', line: 3, text: 't3' },
  ];
  const result = await dedupe(findings, {
    askFn: async (x, y) => {
      if (x.id === 'a') throw new Error('boom');
      return { a: x.id, b: y.id, confidence: 0.9 };
    },
  });
  // a-b and a-c throw (dropped); b-c succeeds -> one group of {b, c}.
  assert.strictEqual(result.groups.length, 1);
  assert.deepStrictEqual(result.groups[0].ids.sort(), ['b', 'c']);
});

test('errors fail open: askPair itself never throws even when jev-assist.ask rejects', async () => {
  const h = makeHome();
  try {
    h.writeState('jev.json', { enabled: true, timeoutMs: 3000, integrations: { findingDedup: 'on' } });
    const a = { id: 'a', file: 'x.js', line: 1, text: 'leak' };
    const b = { id: 'b', file: 'x.js', line: 2, text: 'leak restated' };
    // No mock server listening at this endpoint -> the network call itself fails.
    await withEnv({ HOME: h.home, AI_GATEWAY_API_KEY: 'k', ANTIHALL_JEV_TEST_ENDPOINT: 'http://127.0.0.1:1/unreachable' }, async () => {
      const { askPair } = freshAskPair();
      const edge = await askPair(a, b, { home: h.home });
      assert.strictEqual(edge, null);
    });
  } finally {
    h.cleanup();
  }
});

test('malformed/missing input -> loadFindings degrades to [] rather than throwing', () => {
  const { loadFindings } = MOD;
  assert.deepStrictEqual(loadFindings({ file: '/does/not/exist-finding-dedup.json' }), []);
});

// ---------------------------------------------------------------------------
// docs: the Codex mirror mentions it
// ---------------------------------------------------------------------------

test('the Codex mirror (anti-hall-deadly-loop SKILL.md) mentions finding-dedup.js', () => {
  const p = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'codex', 'skills', 'anti-hall-deadly-loop', 'SKILL.md');
  const content = fs.readFileSync(p, 'utf8');
  assert.match(content, /finding-dedup\.js/);
  assert.match(content, /findingDedup/);
});

test('the Claude-side deadly-loop and deadly-loop-multi SKILL.md files mention finding-dedup.js', () => {
  const base = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'skills');
  const dl = fs.readFileSync(path.join(base, 'deadly-loop', 'SKILL.md'), 'utf8');
  const dlm = fs.readFileSync(path.join(base, 'deadly-loop-multi', 'SKILL.md'), 'utf8');
  assert.match(dl, /finding-dedup\.js/);
  assert.match(dlm, /finding-dedup\.js/);
});
