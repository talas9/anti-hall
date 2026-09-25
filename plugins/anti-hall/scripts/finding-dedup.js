#!/usr/bin/env node
'use strict';
// anti-hall :: finding-dedup — ADVISORY duplicate-finding detector for the
// deadly-loop TRIO (Reviewer/Auditor/Critic). Groups findings that Jev judges
// to describe the SAME underlying issue, via `jev-assist.js`'s `ask()` path
// (id 'findingDedup', trust 'advisory'). This NEVER auto-collapses anything —
// the agent running deadly-loop reads the groups and still decides; see the
// deadly-loop / deadly-loop-multi SKILL.md wiring.
//
// USAGE
//   node plugins/anti-hall/scripts/finding-dedup.js --file findings.json
//   cat findings.json | node plugins/anti-hall/scripts/finding-dedup.js
//
// INPUT (stdin or --file): a JSON array of findings:
//   {id, severity, file, line, text, round?, seat?}
//
// OUTPUT: JSON on stdout — {groups: [{ids: [...], pairs: [{a, b, confidence}]}]}
// (one entry per connected component of >=2 findings Jev judged duplicate).
// Human-readable lines, one per Jev-confirmed pair — "possible duplicates: A ~
// B (conf 0.93)" — are printed to STDERR so stdout stays pure JSON.
//
// CANDIDATE PAIRS: same `file` within +/-40 lines, OR the same `id` recurring
// across two different `round`s. Capped at 200 pairs per run (deterministic:
// input order, i<j), asked with concurrency 4.
//
// FAIL-OPEN: `getMode('findingDedup')` off (or Jev disabled/unconfigured
// entirely) -> jev-assist's ask() makes no network call for any pair (see its
// `prepare()`/skip logic) -> no groups, exit 0. Any per-pair error (thrown,
// timeout, bad response) drops just that pair's edge -- never the whole run.
// Malformed/missing input -> {groups: []}, exit 0. This script never throws
// out of main() and never exits non-zero for a Jev-side failure.
//
// EVIDENCE: offline benchmark (2026-09, 3 projects, 30 days of real deadly-
// loop reviews) -- Jev answered this exact "same underlying issue?" question
// 65/65 correct at confidence >= 0.85, vs 45% precision for a same-file
// +/-10-lines heuristic baseline. See CHANGELOG.md 0.108.4.

const fs = require('fs');

const MAX_PAIRS = 200;
const CONCURRENCY = 4;
const SAME_FILE_LINE_WINDOW = 40;
const CONFIDENCE_FLOOR = 0.85;

// Exact question wording from the benchmark harness that scored 65/65 (see
// CHANGELOG.md 0.108.4) -- reused verbatim, not re-paraphrased.
const QUESTION = {
  type: 'noul',
  instructions: 'Do finding A and finding B describe the SAME underlying root-cause issue (even if worded differently, restated, or found at slightly different code lines)? Answer false if they are different bugs/mechanisms even if in the same area of code.',
  criteria: { true: 'same underlying issue', false: 'different issues' },
};

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.file = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

// loadFindings(opts) -> array (possibly empty). Never throws — malformed
// input degrades to [] (fail-open: no groups, not a crash).
function loadFindings(opts) {
  try {
    const raw = opts.file ? fs.readFileSync(opts.file, 'utf8') : readStdin();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f) => f && typeof f === 'object' && f.id != null) : [];
  } catch (_) {
    return [];
  }
}

// buildPairs(findings) -> [[a,b], ...] candidate pairs: same file within
// +/-40 lines, OR the same id carried across two different rounds. Every
// finding is compared against every other exactly once (i<j), in input
// order, so a MAX_PAIRS cap always drops the SAME pairs for the same input.
function buildPairs(findings) {
  const pairs = [];
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const a = findings[i];
      const b = findings[j];
      const sameFile = typeof a.file === 'string' && a.file && a.file === b.file &&
        Number.isFinite(a.line) && Number.isFinite(b.line) &&
        Math.abs(a.line - b.line) <= SAME_FILE_LINE_WINDOW;
      const sameIdAcrossRounds = a.id != null && a.id === b.id && a.round !== b.round;
      if (sameFile || sameIdAcrossRounds) pairs.push([a, b]);
    }
  }
  return pairs;
}

// describe(finding) -> a compact, judge-facing snippet: location + round +
// severity + the finding's own text. Never includes anything beyond the
// caller-supplied fields.
function describe(f) {
  const loc = (typeof f.file === 'string' && f.file ? f.file : 'unknown') +
    (Number.isFinite(f.line) ? ':' + f.line : '');
  const round = f.round != null ? ' round ' + f.round : '';
  const severity = f.severity ? ' [' + f.severity + ']' : '';
  const text = typeof f.text === 'string' ? f.text : '';
  return loc + round + severity + ': ' + text;
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  if (items.length === 0) return results;
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return results;
}

// --- union-find --------------------------------------------------------

function makeUnionFind(ids) {
  const parent = new Map();
  for (const id of ids) parent.set(id, id);
  function find(x) {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  return { find, union };
}

// groupPairs(edges, allIds) -> [{ids, pairs}] — one entry per connected
// component of >=2 findings over the Jev-confirmed-duplicate edges. A
// finding with no confirmed duplicate never appears in the output (it is its
// own singleton component, dropped).
function groupPairs(edges, allIds) {
  const uf = makeUnionFind(allIds);
  for (const e of edges) uf.union(e.a, e.b);
  const byRoot = new Map();
  for (const id of allIds) {
    const root = uf.find(id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(id);
  }
  const groups = [];
  for (const ids of byRoot.values()) {
    if (ids.length < 2) continue;
    const idSet = new Set(ids);
    const pairs = edges
      .filter((e) => idSet.has(e.a) && idSet.has(e.b))
      .map((e) => ({ a: e.a, b: e.b, confidence: e.confidence }));
    groups.push({ ids, pairs });
  }
  return groups;
}

// askPair(a, b, opts) -> {a, b, confidence} | null. The real jev-assist path
// — fail-open: any Jev failure, low confidence, or `getMode('findingDedup')`
// !== 'on' -> null (no edge), never throws. `opts.home`/`opts.project` are
// forwarded to jev-assist.ask() (test-fixture HOME support).
async function askPair(a, b, opts) {
  const o = opts || {};
  try {
    const jevAssist = require('../hooks/lib/jev-assist.js');
    const state = 'Finding A: ' + describe(a) + '\n\nFinding B: ' + describe(b);
    const r = await jevAssist.ask({
      id: 'findingDedup',
      question: QUESTION,
      state,
      trust: 'advisory',
      baseline: null,
      cacheKey: [a.id, b.id].join('\u0001'),
      home: o.home,
      project: o.project,
    });
    // r.final is already gated by mode ('shadow'/'off' never surface a
    // non-baseline value) AND by the caller-configured confidenceThreshold;
    // CONFIDENCE_FLOOR is an independent, hardcoded floor matching the
    // benchmark this feature shipped on, regardless of what confidenceThreshold
    // an owner has configured globally.
    if (r.final === true && Number.isFinite(r.confidence) && r.confidence >= CONFIDENCE_FLOOR) {
      return { a: a.id, b: b.id, confidence: r.confidence };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// dedupe(findings, opts) -> {groups}. The whole pipeline, exported for tests.
// `opts.askFn` lets tests substitute a stub with no network/no Jev config
// (defaults to askPair, the real jev-assist path). `opts.home`/`opts.project`
// are forwarded to the real askPair only.
async function dedupe(findings, opts) {
  const o = opts || {};
  const askFn = o.askFn || askPair;
  const pairs = buildPairs(findings).slice(0, MAX_PAIRS);
  // Fail-open at this level too: a caller-supplied askFn (test DI, or a future
  // caller) that throws must drop only its own edge, never the whole run —
  // askPair() already guards the real jev-assist path with its own try/catch,
  // but that guarantee should hold for ANY askFn, not just the default one.
  const edgeResults = await pool(pairs, CONCURRENCY, async ([a, b]) => {
    try {
      return await askFn(a, b, o);
    } catch (_) {
      return null;
    }
  });
  const edges = edgeResults.filter(Boolean);
  const allIds = findings.map((f) => f.id);
  const groups = groupPairs(edges, allIds);
  return { groups };
}

function printHuman(groups) {
  for (const g of groups) {
    for (const p of g.pairs) {
      console.error(`possible duplicates: ${p.a} ~ ${p.b} (conf ${p.confidence.toFixed(2)})`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const findings = loadFindings(opts);
  let result;
  try {
    result = await dedupe(findings, {});
  } catch (_) {
    result = { groups: [] };
  }
  printHuman(result.groups);
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = {
  buildPairs,
  groupPairs,
  makeUnionFind,
  dedupe,
  askPair,
  describe,
  loadFindings,
  MAX_PAIRS,
  CONCURRENCY,
  SAME_FILE_LINE_WINDOW,
  CONFIDENCE_FLOOR,
  QUESTION,
};

if (require.main === module) {
  main();
}
