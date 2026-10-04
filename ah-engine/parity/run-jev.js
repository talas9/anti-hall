#!/usr/bin/env node
// Parity harness for the Jev lane (D31, D34-D38): the Node client (authority: hooks/lib/jev-client.js, jev-assist.js,
// secret-scrub.js) against `ah-engine jev`, over a loopback mock server. No real network, no real HOME.
//
//   node run-jev.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds <cmds.jsonl>] [--scrub-n 12000] [--fuzz-n 20000] [--body-n 150] [--conc 8] [--show 15] [--out mismatches.json]
//
// What is compared, each at 100%:
//   scrub    outbound redaction of real commands (cmds.jsonl rows) and fuzz, byte for byte
//   body     the HTTP request bodies, the Authorization and Content-Type headers, and which vendor path got which key
//   decision the decision returned by ask() (final, jev, confidence, backend, reason, hash, cost) and the log rows it wrote
//            (every field, in the same key order), over modes x trust x server behaviour x fallback x redirect x timeout x cache
//   config   the resolved settings and every integration's mode, over a matrix of settings.json / jev.json / env
//   table    the shipped integration table against hooks/lib/settings-schema.js
//   loopback which test-endpoint URLs may receive a key (WHATWG host forms, credentials, ports); plus an engine-stricter list
// Deliberate deviations (D36, documented in DECISIONS.md) are asserted separately, never silently skipped:
//   relax-block is observe-only, a `true` advisory baseline is never lowered, and an off call writes no log row.
// Mode: the Jev lane is not yet wired into the daemon (the dispatcher lane does that), so only the one-shot CLI path exists.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), cp = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ENGINE = path.resolve(arg('--engine', '../target/release/ah-engine'));
const HOOKS = path.resolve(arg('--hooks'));
const CMDS = arg('--cmds', '');
const SCRUB_N = +arg('--scrub-n', 12000), FUZZ_N = +arg('--fuzz-n', 20000), BODY_N = +arg('--body-n', 150);
const CONC = +arg('--conc', 8), SHOW = +arg('--show', 15);
const OUT = arg('--out', path.join(__dirname, 'last-jev-mismatches.json'));
const NODE_ASK = path.join(__dirname, 'jev-node-ask.js'), NODE_SCRUB = path.join(__dirname, 'jev-node-scrub.js');
const tmp = fs.mkdtempSync(path.join('/tmp', 'ah-jpar-'));
const mism = [];
const traffic = { node: 0, rust: 0 };
const stats = {};
const tally = (k, ok, info) => { const s = stats[k] || (stats[k] = { n: 0, ok: 0 }); s.n++; if (ok) s.ok++; else if (mism.length < 5000) mism.push({ kind: k, ...info }); };
const run = (cmd, args, input, env) => new Promise((res) => {
  const p = cp.spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let o = '', e = ''; p.stdout.on('data', (d) => o += d); p.stderr.on('data', (d) => e += d);
  const to = setTimeout(() => p.kill('SIGKILL'), 120000);
  p.on('close', (code) => { clearTimeout(to); res({ code, out: o, err: e }); });
  p.stdin.on('error', () => {}); p.stdin.end(input);
});
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }
const baseEnv = { PATH: process.env.PATH, ANTIHALL_TEST_ISOLATION: '1' };

// ---------------------------------------------------------------- mock server
// Path: /<side>/<case>/<vendor>. A response spec is {status, body, delay, location}; specs are consumed in order per
// (side, case, vendor); an exhausted script answers 500 so a stray extra call shows up as a mismatch.
const scen = {}, seen = {}, hits = {};
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const [, side, cid, vendor] = req.url.split('/');
    const key = `${side}/${cid}/${vendor}`;
    (seen[key] = seen[key] || []).push({ method: req.method, auth: req.headers.authorization || null, ctype: req.headers['content-type'] || null, body: Buffer.concat(chunks).toString('utf8') });
    if (vendor === 'redirected') { hits[`${side}/${cid}`] = (hits[`${side}/${cid}`] || 0) + 1; res.writeHead(200); return res.end('{}'); }
    const list = (scen[cid] || {})[vendor] || [];
    const n = seen[key].length - 1;
    const spec = list[Math.min(n, list.length - 1)] || { status: 500, body: '' };
    const send = () => {
      const h = { 'content-type': 'application/json' };
      if (spec.location) h.location = spec.location.replace('<side>', side);
      res.writeHead(spec.status || 200, h);
      res.end(typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body));
    };
    spec.delay ? setTimeout(send, spec.delay) : send();
  });
});

// ---------------------------------------------------------------- corpora
const rows = [];
if (CMDS && fs.existsSync(CMDS)) {
  for (const l of fs.readFileSync(CMDS, 'utf8').split('\n')) {
    if (!l) continue;
    try { const c = JSON.parse(l).cmd; if (typeof c === 'string' && c.length <= 6000) rows.push(c); } catch { /* skip */ }
  }
}
const SECRETY = /(token|secret|passw|key|bearer|authorization|@|:\/\/|eyJ|AKIA|ghp_|gho_|sk-|sk_|xox|glpat|npm_|-----BEGIN)/i;
function pick(arr, n, seed) { // deterministic spread
  const out = []; if (!arr.length) return out; const step = Math.max(1, Math.floor(arr.length / n));
  for (let i = seed % step; i < arr.length && out.length < n; i += step) out.push(arr[i]);
  return out;
}
const secretRows = rows.filter((r) => SECRETY.test(r)), plainRows = rows.filter((r) => !SECRETY.test(r));
let s = 12345; const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
const FRAG = ['token=', 'Token: ', 'Bearer ', 'bearer ', 'Authorization: Basic ', 'Authorization="Bearer ', '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----', '-----BEGIN CERTIFICATE-----',
  'sk_live_', 'rk_test_', 'ghp_', 'gho_', 'xoxb-', 'AKIA', 'ASIA', 'AIza', 'glpat-', 'npm_', 'sk-', 'pk-', 'eyJ', '.', 'a.b.c', '@', '.com', '://', 'https://', 'user:pass@', 'u:p@', '"', "'", '=', ':', ' ', '\n', '\t', '\r', ' ', '\u0085', '﻿', ' ', 'K', 'ſ', 'é', '日本', '😀', '\u0000', '\u0001', '\u007f',
  'secret', 'SECRET', 'Password', 'passwd', 'apikey', 'api_key', 'API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'key', 'KEY', ',', '}', '{', '[', ']', '-', '_', '+', '/', 'a', 'Z', '0', '9'];
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function fuzzString() {
  let out = ''; const n = 1 + rnd(14);
  for (let i = 0; i < n; i++) {
    if (rnd(5) === 0) { let r = ''; const L = 1 + rnd(48); for (let j = 0; j < L; j++) r += ALNUM[rnd(ALNUM.length)]; out += r; } else out += FRAG[rnd(FRAG.length)];
  }
  return out;
}

// ---------------------------------------------------------------- scrub parity
async function scrubParity() {
  const texts = [...pick(secretRows, Math.ceil(SCRUB_N * 0.7), 1), ...pick(plainRows, Math.floor(SCRUB_N * 0.3), 2)];
  for (let i = 0; i < FUZZ_N; i++) texts.push(fuzzString());
  texts.push('', ' ', 'plain text', 'x'.repeat(100000), 'a'.repeat(40) + '=' + 'b'.repeat(40));
  const input = texts.map((t) => JSON.stringify(t)).join('\n') + '\n';
  const env = { ...baseEnv, HOME: path.join(tmp, 'scrub-home') };
  fs.mkdirSync(env.HOME, { recursive: true });
  const [n, r] = await Promise.all([run('node', [NODE_SCRUB, HOOKS], input, env), run(ENGINE, ['jev', 'scrub'], input, env)]);
  const nl = n.out.split('\n').filter((l) => l !== ''), rl = r.out.split('\n').filter((l) => l !== '');
  if (nl.length !== texts.length || rl.length !== texts.length) { tally('scrub', false, { why: 'line counts', node: nl.length, rust: rl.length, want: texts.length, err: r.err.slice(0, 300) }); return; }
  for (let i = 0; i < texts.length; i++) tally('scrub', nl[i] === rl[i], { text: texts[i].slice(0, 300), node: nl[i].slice(0, 300), rust: rl[i].slice(0, 300) });
  stats.scrub.corpus = { real_secrety: Math.min(secretRows.length, Math.ceil(SCRUB_N * 0.7)), real_plain: Math.min(plainRows.length, Math.floor(SCRUB_N * 0.3)), fuzz: FUZZ_N, rows_available: rows.length };
}

// ---------------------------------------------------------------- decision / body parity
const NOUL = (p, extra) => ({ status: 200, body: { answers: { decision: { noul: p } }, ...(extra || {}) } });
const CHOICE = (l, c, extra) => ({ status: 200, body: { answers: { decision: { choice: l, confidence: c } }, ...(extra || {}) } });
const HTTP = (status, body) => ({ status, body: body === undefined ? '' : body });
const Q_NOUL = { type: 'noul', instructions: 'Is this claim unsupported speculation?', criteria: { true: 'unsupported', false: 'supported' } };
const Q_CHOICE = { type: 'choice', instructions: 'Which one?', criteria: { alpha: 'first', beta: 'second' } };
const baseReq = (o) => ({ id: 'speculation', question: Q_NOUL, state: 'The build probably passes on CI.', trust: 'add-block', baseline: false, project: 'proj', ...o });
const cases = [];
const add = (name, c) => cases.push({ name, settings: {}, legacy: {}, env: {}, ignore: [], server: {}, requests: [baseReq()], ...c });

// A: modes x trust x baselines x server answers
const ANSWERS = { 'noul .99': NOUL(0.99), 'noul .01': NOUL(0.01), 'noul .5': NOUL(0.5), 'noul .6': NOUL(0.6), 'http 500': HTTP(500, 'boom'), 'http 429': HTTP(429), 'junk': { status: 200, body: 'not json' }, 'bad shape': { status: 200, body: { answers: {} } }, 'usage': NOUL(0.97, { usage: { input_tokens: 1234, output_tokens: 7 }, model: 'jev-x' }), 'gateway cost': NOUL(0.97, { provider_metadata: { gateway: { cost: '0.00042', marketCost: '0.0005' } } }) };
for (const id of ['speculation', 'modelRouting', 'postHandoverGate', 'someFutureThing', 'triage'])
  for (const trust of ['add-block', 'advisory', 'relax-block'])
    for (const baseline of [false, true, null])
      for (const [an, resp] of Object.entries(ANSWERS)) {
        const ignore = [];
        const mode = { speculation: 'on', modelRouting: 'shadow', postHandoverGate: 'off', someFutureThing: 'shadow', triage: 'on' }[id];
        if (trust === 'relax-block' && mode === 'on') ignore.push('final', 'changed', 'wouldChange', 'mode');
        if (trust === 'advisory' && baseline === true) ignore.push('final', 'changed', 'wouldChange');
        add(`A ${id} ${trust} base=${baseline} ${an}`, { server: { vercel: [resp] }, requests: [baseReq({ id, trust, baseline })], ignore, mode, deviation: ignore.length > 0 });
      }
// B: choice questions with a judge-less label (advisory) and numeric-key ordering
add('B choice', { server: { vercel: [CHOICE('beta', 0.95)] }, requests: [baseReq({ id: 'newRequest', question: Q_CHOICE, trust: 'advisory', baseline: null })], settings: { jevIntegrations: { newRequest: 'on' } } });
add('B choice int keys', { server: { vercel: [CHOICE('2', 0.95)] }, requests: [baseReq({ id: 'devswarmStepMap', question: { type: 'choice', instructions: 'Which step?', criteria: { b: 'x', 10: 'ten', 2: 'two', '01': 'z', 1: 'one', a: 'y' } }, trust: 'advisory', baseline: null })] });
add('B choice low conf', { server: { vercel: [CHOICE('beta', 0.3)] }, requests: [baseReq({ id: 'newRequest', question: Q_CHOICE, trust: 'advisory', baseline: 'followup' })], settings: { jevIntegrations: { newRequest: 'on' } } });
// C: fallback, breaker, redirect, timeout, cache
const FB = { jev: { fallbackTransport: 'typesafe' } };
add('C fb 503 -> ok', { settings: FB, server: { vercel: [HTTP(503)], typesafe: [NOUL(0.99)] } });
add('C fb 401 not masked', { settings: FB, server: { vercel: [HTTP(401)], typesafe: [NOUL(0.99)] } });
add('C fb 400 balance', { settings: FB, server: { vercel: [HTTP(400, 'Insufficient credits')], typesafe: [NOUL(0.99)] } });
add('C fb 403 plain', { settings: FB, server: { vercel: [HTTP(403, 'forbidden')], typesafe: [NOUL(0.99)] } });
add('C fb 402', { settings: FB, server: { vercel: [HTTP(402)], typesafe: [NOUL(0.99)] } });
add('C fb 429', { settings: FB, server: { vercel: [HTTP(429)], typesafe: [NOUL(0.99)] } });
add('C fb both fail', { settings: FB, server: { vercel: [HTTP(500)], typesafe: [HTTP(502)] } });
add('C fb typesafe primary', { settings: { jev: { transport: 'typesafe', fallbackTransport: 'vercel' } }, server: { typesafe: [HTTP(500)], vercel: [NOUL(0.99)] } });
add('C typesafe only', { settings: { jev: { transport: 'typesafe' } }, server: { typesafe: [NOUL(0.99, { usage: { input_tokens: 10, output_tokens: 1 }, model: 'jev-latest' })] } });
add('C breaker x5', { settings: FB, server: { vercel: [HTTP(500)], typesafe: [NOUL(0.99)] }, requests: [1, 2, 3, 4, 5].map((i) => baseReq({ state: `claim ${i} probably` })) });
add('C breaker both', { settings: FB, server: { vercel: [HTTP(500)], typesafe: [HTTP(500)] }, requests: [1, 2, 3, 4, 5].map((i) => baseReq({ state: `claim ${i} probably` })) });
add('C redirect', { server: { vercel: [{ status: 302, location: '/<side>/__CID__/redirected', body: '' }] } });
add('C redirect 307 fb', { settings: FB, server: { vercel: [{ status: 307, location: '/<side>/__CID__/redirected', body: '' }], typesafe: [NOUL(0.99)] } });
add('C timeout', { server: { vercel: [{ ...NOUL(0.99), delay: 1500 }] }, requests: [baseReq({ budgetMs: 300 })] });
add('C timeout -> fb', { settings: FB, server: { vercel: [{ ...NOUL(0.99), delay: 1400 }], typesafe: [NOUL(0.99)] }, requests: [baseReq({ budgetMs: 1500 })] });
add('C cache hit', { server: { vercel: [NOUL(0.99, { provider_metadata: { gateway: { cost: '0.0004' } } })] }, requests: [baseReq(), baseReq(), baseReq({ state: 'another claim' })] });
add('C cacheKey', { server: { vercel: [NOUL(0.99)] }, requests: [baseReq({ cacheKey: 'k1' }), baseReq({ cacheKey: 'k1', state: 'different text' })] });
add('C failure not cached', { server: { vercel: [HTTP(500), NOUL(0.99)] }, requests: [baseReq(), baseReq()] });
add('C no key', { env: { CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY: '' } });
add('C generic key bound to vercel', { expectKey: { vercel: 'generic-key' }, env: { CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY: '', CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'generic-key' }, server: { vercel: [NOUL(0.99)] } });
add('C generic key not sent to typesafe', { expectNoRequests: true, settings: { jev: { transport: 'typesafe' } }, env: { CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY: '', CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'generic-key' }, server: { typesafe: [NOUL(0.99)] } });
add('C meta fields', { server: { vercel: [NOUL(0.99)] }, requests: [baseReq({ sessionId: 'sess-1', turnRef: 'L12', compare: true })] });
add('C record disagreement', { server: { vercel: [NOUL(0.99)] }, requests: [baseReq({ id: 'modelRouting', baseline: true, recordDisagreement: true })] });
// D: off paths
add('D jev disabled env', { env: { ANTIHALL_JEV: '0' }, offRow: true });
add('D integration kill switch', { env: { ANTIHALL_JEV_SPECULATION: '0' }, offRow: true });
add('D integration off in settings', { settings: { jevIntegrations: { speculation: 'off' } }, offRow: true });
add('D settings enable', { env: { ANTIHALL_JEV: '' }, settings: { jev: { enabled: true } }, server: { vercel: [NOUL(0.99)] } });
add('D legacy jev.json', { env: { ANTIHALL_JEV: '' }, legacy: { enabled: true, integrations: { speculation: 'shadow' } }, server: { vercel: [NOUL(0.99)] } });
add('D legacy threshold wins', { env: { ANTIHALL_JEV: '' }, legacy: { enabled: true, confidenceThreshold: 0.2 }, settings: { jev: { confidenceThreshold: 0.99 } }, server: { vercel: [NOUL(0.7)] } });
add('D triage false legacy', { legacy: { enabled: true, triage: false }, requests: [baseReq({ id: 'triage' })], offRow: true });
add('D settings threshold', { settings: { jev: { confidenceThreshold: 0.99 } }, server: { vercel: [NOUL(0.97)] } });
add('D bad state', { requests: [baseReq({ state: '  ﻿\n ' })] });
// E: bodies: questions and states
const NASTY = ['quote " and \\ backslash', 'line1\nline2\r\n\ttabbed', 'ctl \u0001\u0002\u001f del \u007f', 'unicode é 日本語 😀    end', 'lone brace {"a":[1,2]} and <tag> & &amp;', 'x'.repeat(8000), '\u0085next-line K kelvin ſ long-s'];
NASTY.forEach((st, i) => add(`E state ${i}`, { server: { vercel: [NOUL(0.99)] }, requests: [baseReq({ state: st, question: { type: 'noul', instructions: st.slice(0, 60), criteria: { true: st.slice(0, 20), false: 'no' } } })] }));
const SECRETS = ['password=hunter2 and token: abc', 'AWS_SECRET_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP end', 'Authorization: Bearer abc.def.ghi', '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----', 'mail me@example.com about sk_live_abcdefghij12', 'https://user:pw@host.example/path?x=1', '{"apiKey": "a b c", "n": 1}'];
SECRETS.forEach((st, i) => add(`E secrets ${i}`, { server: { vercel: [NOUL(0.99)] }, requests: [baseReq({ state: st })] }));
pick(secretRows, BODY_N, 3).forEach((st, i) => add(`E real ${i}`, { server: { vercel: [NOUL(0.99)] }, requests: [baseReq({ state: st })] }));
pick(plainRows, Math.floor(BODY_N / 3), 4).forEach((st, i) => add(`E real-plain ${i}`, { server: { vercel: [NOUL(0.99)] }, requests: [baseReq({ state: st })] }));

const mkHome = (name, c) => {
  const h = path.join(tmp, name); const dir = path.join(h, '.anti-hall'); fs.mkdirSync(dir, { recursive: true });
  if (Object.keys(c.settings).length) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(c.settings));
  if (Object.keys(c.legacy).length) fs.writeFileSync(path.join(dir, 'jev.json'), JSON.stringify(c.legacy));
  return h;
};
const readRows = (h) => { try { return fs.readFileSync(path.join(h, '.anti-hall', 'logs', 'jev-assist.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const strip = (o, drop) => { const c = { ...o }; for (const k of ['ts', 'ms', ...drop]) delete c[k]; return c; };
const nullish = (o) => { const c = {}; for (const [k, v] of Object.entries(o)) c[k] = v === undefined ? null : v; return c; };

async function decisionCase(c, idx) {
  const cid = `c${idx}`;
  const spec = JSON.parse(JSON.stringify(c.server).replace(/__CID__/g, cid));
  scen[cid] = spec;
  const base = `http://127.0.0.1:${server.address().port}`;
  const homes = { node: mkHome(`n${idx}`, c), rust: mkHome(`r${idx}`, c) };
  const envFor = (side) => {
    const e = { ...baseEnv, HOME: homes[side], ANTIHALL_JEV: '1', CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY: 'key-vercel', CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY: 'key-typesafe',
      ANTIHALL_JEV_TEST_ENDPOINT_VERCEL: `${base}/${side}/${cid}/vercel`, ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE: `${base}/${side}/${cid}/typesafe`, ...c.env };
    for (const k of Object.keys(e)) if (e[k] === '') delete e[k];
    return e;
  };
  const input = c.requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const [n, r] = await Promise.all([run('node', [NODE_ASK, HOOKS], input, envFor('node')), run(ENGINE, ['jev', 'ask', '--json'], input, envFor('rust'))]);
  const info = { name: c.name };
  const nd = n.out.split('\n').filter(Boolean).map((l) => JSON.parse(l)), rd = r.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (n.code !== 0 || r.code !== 0 || nd.length !== c.requests.length || rd.length !== c.requests.length) return tally('decision', false, { ...info, why: 'run failed', nodeCode: n.code, rustCode: r.code, nodeErr: n.err.slice(0, 300), rustErr: r.err.slice(0, 300), nd: nd.length, rd: rd.length });
  const off = c.mode === 'off' || c.offRow;
  // Deviation (security): this harness points every call at a test endpoint override, and the engine never caches an answer
  // obtained through one (the cache is shared by every session, so a mock's answer must not reach a session without the
  // override). Where Node serves a cache hit the engine therefore asks again: assert exactly that instead of comparing.
  const nodeHits = nd.filter((d) => d.backend === 'cache').length;
  if (nodeHits) {
    const rr = readRows(homes.rust);
    const sent = (side) => ['vercel', 'typesafe'].reduce((t, v) => t + (seen[`${side}/${cid}/${v}`] || []).length, 0);
    const keyed = ['vercel', 'typesafe'].every((v) => (seen[`rust/${cid}/${v}`] || []).every((x) => x.auth === `Bearer ${(c.expectKey || {})[v] || 'key-' + v}`));
    tally('deviation-override-never-cached', rd.every((d) => d.backend !== 'cache') && rr.every((x) => x.cached !== true) && sent('rust') === sent('node') + nodeHits && keyed,
      { ...info, node: nd.map((d) => d.backend), rust: rd.map((d) => d.backend), nodeSent: sent('node'), rustSent: sent('rust'), nodeHits });
    return;
  }
  // decisions
  const DKEYS = ['final', 'jev', 'baseline', 'confidence', 'confident', 'backend', 'reason', 'h', 'costUsd', 'costSource'];
  const dropD = (c.ignore || []).includes('final') ? ['final'] : [];
  for (let i = 0; i < nd.length; i++) {
    const skipH = off || c.mode === 'off' || nd[i].backend === 'baseline-only' && nd[i].reason === 'disabled';
    const a = {}, b = {};
    for (const k of DKEYS) { if (dropD.includes(k) || (k === 'h' && skipH)) continue; a[k] = nd[i][k]; b[k] = rd[i][k]; }
    tally('decision', JSON.stringify(a) === JSON.stringify(b), { ...info, i, node: a, rust: b });
  }
  // bodies and headers
  for (const vendor of ['vercel', 'typesafe']) {
    const a = seen[`node/${cid}/${vendor}`] || [], b = seen[`rust/${cid}/${vendor}`] || [];
    const same = a.length === b.length && a.every((x, k) => x.body === b[k].body && x.auth === b[k].auth && x.ctype === b[k].ctype && x.method === b[k].method);
    tally('body', same, { ...info, vendor, node: a.map((x) => x.body.slice(0, 400)), rust: b.map((x) => x.body.slice(0, 400)), nodeAuth: a.map((x) => x.auth), rustAuth: b.map((x) => x.auth) });
    for (const x of b) tally('key-binding', x.auth === `Bearer ${(c.expectKey || {})[vendor] || 'key-' + vendor}`, { ...info, vendor, auth: x.auth });
    traffic.node += a.length; traffic.rust += b.length;
  }
  if (c.expectNoRequests) tally('no-request-without-a-bound-key', ['vercel', 'typesafe'].every((v) => !(seen[`rust/${cid}/${v}`] || []).length), { ...info });
  tally('redirect-not-followed', !hits[`node/${cid}`] && !hits[`rust/${cid}`], { ...info, node: hits[`node/${cid}`], rust: hits[`rust/${cid}`] });
  // log rows
  const nr = readRows(homes.node), rr = readRows(homes.rust);
  if (off) {
    tally('row', rr.length === 0 && nr.every((x) => x.mode === 'off'), { ...info, why: 'an off call must write no row in the engine', node: nr.length, rust: rr.length });
  } else {
    const drop = c.ignore || [];
    const ok = nr.length === rr.length && nr.every((x, k) => {
      const A = nullish(strip(x, drop)), B = nullish(strip(rr[k], drop));
      return JSON.stringify(A) === JSON.stringify(B);
    });
    tally('row', ok, { ...info, node: nr.map((x) => strip(x, drop)), rust: rr.map((x) => strip(x, drop)) });
  }
  // deviation invariants (D36)
  if (c.deviation) {
    const rq = c.requests[0];
    if (rq.trust === 'relax-block') tally('deviation-relax', rd.every((d) => JSON.stringify(d.final) === JSON.stringify(rq.baseline)), { ...info, rust: rd });
    if (rq.trust === 'advisory' && rq.baseline === true) tally('deviation-advisory', rd.every((d) => d.final === true), { ...info, rust: rd });
  }
  // a block is never removed, whatever Jev says (D36)
  for (let i = 0; i < rd.length; i++) if (c.requests[i].baseline === true && c.requests[i].trust !== 'relax-block') tally('never-removes-a-block', rd[i].final === true, { ...info, i, rust: rd[i] });
}

// ---------------------------------------------------------------- config parity
async function configParity() {
  const NODE_CFG = path.join(tmp, 'node-cfg.js');
  fs.writeFileSync(NODE_CFG, `
const path = require('path');
const hooks = ${JSON.stringify(HOOKS)};
const assist = require(path.join(hooks, 'lib', 'jev-assist.js'));
const client = require(path.join(hooks, 'lib', 'jev-client.js'));
const ids = JSON.parse(process.argv[2]);
const cfg = client.loadJevConfig();
const home = process.env.HOME;
const modes = {};
for (const id of ids) modes[id] = assist.getMode(id, assist.readJevJson(home), home, { assumeEnabled: true });
const live = {};
for (const id of ids) live[id] = assist.getMode(id, assist.readJevJson(home), home, {});
process.stdout.write(JSON.stringify({ enabled: cfg.enabled, transport: cfg.transport, fallback: cfg.fallbackTransport === 'none' ? null : cfg.fallbackTransport, timeout_ms: cfg.timeoutMs, confidence_threshold: cfg.confidenceThreshold, modes, live }));
`);
  const schemaIds = JSON.parse((await run('node', ['-e', `const s=require(${JSON.stringify(path.join(HOOKS, 'lib', 'settings-schema.js'))});console.log(JSON.stringify(s.SECTIONS.find(x=>x.key==='jevIntegrations').settings.map(x=>[x.key,x.default,x.pluginOption])))`], '', baseEnv)).out);
  const ids = schemaIds.map((x) => x[0]).concat(['someFutureThing']);
  const matrix = [
    { name: 'empty', settings: {}, legacy: {}, env: {} },
    { name: 'enabled env', settings: {}, legacy: {}, env: { ANTIHALL_JEV: '1' } },
    { name: 'enabled settings', settings: { jev: { enabled: true } }, legacy: {}, env: {} },
    { name: 'enabled true token', settings: {}, legacy: {}, env: { ANTIHALL_JEV: 'true' } },
    { name: 'killed', settings: { jev: { enabled: true } }, legacy: { enabled: true }, env: { ANTIHALL_JEV: '0' } },
    { name: 'settings modes', settings: { jev: { enabled: true }, jevIntegrations: { modelRouting: 'on', speculation: 'off', newRequest: 'ON ', claimLedger: 'bogus' } }, legacy: {}, env: {} },
    { name: 'legacy modes', settings: { jev: { enabled: true } }, legacy: { integrations: { modelRouting: 'on', someFutureThing: 'on', speculation: 'shadow' } }, env: {} },
    { name: 'settings beats legacy', settings: { jev: { enabled: true }, jevIntegrations: { modelRouting: 'shadow' } }, legacy: { integrations: { modelRouting: 'on' } }, env: {} },
    { name: 'kill switch', settings: { jev: { enabled: true } }, legacy: {}, env: { ANTIHALL_JEV_MODEL_ROUTING: '0', ANTIHALL_JEV_DEVSWARM_STEP_MAP: '0' } },
    { name: 'plugin option mode', settings: { jev: { enabled: true } }, legacy: {}, env: { CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_MODEL_ROUTING: 'on' } },
    { name: 'legacy triage false', settings: { jev: { enabled: true } }, legacy: { triage: false }, env: {} },
    { name: 'transport typesafe + fb', settings: { jev: { enabled: true, transport: 'typesafe', fallbackTransport: 'vercel', timeoutMs: 800, confidenceThreshold: 0.5 } }, legacy: {}, env: {} },
    { name: 'fb equals primary', settings: { jev: { transport: 'vercel', fallbackTransport: 'vercel' } }, legacy: {}, env: {} },
    { name: 'clamps', settings: { jev: { timeoutMs: 99999, confidenceThreshold: 7 } }, legacy: {}, env: {} },
    { name: 'clamps low', settings: { jev: { timeoutMs: 0, confidenceThreshold: -3 } }, legacy: {}, env: {} },
    { name: 'string numbers', settings: { jev: { timeoutMs: '900', confidenceThreshold: '0.6' } }, legacy: {}, env: {} },
    { name: 'nested legacy', settings: {}, legacy: { enabled: true, transport: 'typesafe', timeoutMs: 700 }, env: {} },
    { name: 'plugin option transport', settings: {}, legacy: {}, env: { CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT: 'typesafe', CLAUDE_PLUGIN_OPTION_JEV_ENABLED: 'true' } },
    { name: 'corrupt settings', settings: null, legacy: {}, env: { ANTIHALL_JEV: '1' }, raw: '{not json' },
  ];
  let i = 0;
  for (const c of matrix) {
    const h = path.join(tmp, `cfg${i++}`); const dir = path.join(h, '.anti-hall'); fs.mkdirSync(dir, { recursive: true });
    if (c.raw) fs.writeFileSync(path.join(dir, 'settings.json'), c.raw); else if (Object.keys(c.settings).length) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(c.settings));
    if (Object.keys(c.legacy).length) fs.writeFileSync(path.join(dir, 'jev.json'), JSON.stringify(c.legacy));
    const env = { ...baseEnv, HOME: h, ...c.env };
    const n = JSON.parse((await run('node', [NODE_CFG, JSON.stringify(ids)], '', env)).out);
    const r = JSON.parse((await run(ENGINE, ['jev', 'status', '--json'], '', env)).out);
    // the engine's status lists the shipped table's ids only; compare those, plus the scalar settings
    const a = { enabled: n.enabled, transport: n.transport, fallback: n.fallback, timeout_ms: n.timeout_ms, confidence_threshold: n.confidence_threshold };
    const b = { enabled: r.enabled, transport: r.transport, fallback: r.fallback, timeout_ms: r.timeout_ms, confidence_threshold: r.confidence_threshold };
    tally('config-scalars', JSON.stringify(a) === JSON.stringify(b), { name: c.name, node: a, rust: b });
    for (const id of Object.keys(r.integrations)) tally('config-modes', n.modes[id] === r.integrations[id], { name: c.name, id, node: n.modes[id], rust: r.integrations[id] });
  }
  // the shipped table against the Node schema
  const st = JSON.parse((await run(ENGINE, ['jev', 'status', '--json'], '', { ...baseEnv, HOME: path.join(tmp, 'cfg0') })).out).integrations;
  tally('table-ids', JSON.stringify(Object.keys(st).sort()) === JSON.stringify(schemaIds.map((x) => x[0]).sort()), { node: schemaIds.map((x) => x[0]).sort(), rust: Object.keys(st).sort() });
  for (const [id, dflt] of schemaIds) tally('table-defaults', st[id] === dflt, { id, node: dflt, rust: st[id] });
  const snake = (id) => id.replace(/([A-Z])/g, '_$1').toLowerCase();
  for (const [id, , opt] of schemaIds) tally('table-option-names', opt === 'jev_integration_' + snake(id), { id, schema: opt, derived: 'jev_integration_' + snake(id) });
}

// ---------------------------------------------------------------- loopback endpoint rule
// Which ANTIHALL_JEV_TEST_ENDPOINT values may receive a key: Node's loopbackEndpointOrNull (the WHATWG URL parser, then an
// exact hostname check) against the engine's own URL rules. The engine canonicalises what it accepts and refuses anything it
// cannot prove loopback, so the two must agree on every case below except the engine-stricter list, which Node may accept
// but the engine must refuse.
async function loopbackParity() {
  const hosts = ['127.0.0.1', 'localhost', 'LOCALHOST', 'LocalHost', '127.1', '127.0.1', '2130706433', '0x7f.1', '0x7f000001', '0177.0.0.1', '0177.1', '127.0.0.1.',
    'localhost.', '[::1]', '[0:0:0:0:0:0:0:1]', '[::0001]', '[0::1]', '[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '[::2]', '[::]', '127.0.0.2', '127.0.0.1.evil.com',
    'localhost.evil.com', 'evil.localhost', '0.0.0.0', '%31%32%37.0.0.1', '%6cocalhost', '127.0.0.0x1', '127.0.0.256', '4294967297', '0x7f.0.0.0x1', '1.2.3.4',
    'evil.com', '127.0.0.01', '127.0.0.1e0', '127.0.0.1.0', '256.1', '0x7f.0x0.0x0.0x1', '1.1', '017700000001', '0X7F.1', '127..1', ''];
  const pre = ['http://', 'https://', 'HTTP://', 'http://@', 'http://:@', 'http://u:p@', 'http://127.0.0.1@', 'ftp://', 'ws://'];
  const suf = ['', '/', '/x?y=1', ':9000/', ':099/', ':99999', ':80x', '/a@b', '\\x'];
  const urls = [];
  for (const p of pre) for (const h of hosts) for (const x of suf) urls.push(p + h + x);
  urls.push(' http://127.0.0.1/ ', '\thttp://127.0.0.1/', 'http://127.0.0.1\n/x', 'ht\ttp://127.0.0.1/', '127.0.0.1', '//127.0.0.1', 'http://127.0.0.1:80@evil.com/',
    'http://evil.com\\@127.0.0.1/', 'http://evil.com#@127.0.0.1/', 'http://evil.com?@127.0.0.1/', 'http://127.0.0.1\\@evil.com/', 'javascript:http://127.0.0.1/');
  // Node refuses these and so must the engine; Node ACCEPTS the next group (IDNA maps full-width characters) and the engine refuses it on purpose.
  const stricter = ['http://\uff11\uff12\uff17.0.0.1/', 'http://\uff4c\uff4f\uff43\uff41\uff4c\uff48\uff4f\uff53\uff54/', 'http:127.0.0.1:9/x', 'http:///127.0.0.1/x', 'http:\\\\127.0.0.1/x'];
  const NODE_LB = path.join(tmp, 'node-lb.js');
  fs.writeFileSync(NODE_LB, `
const path = require('path');
const client = require(path.join(${JSON.stringify(HOOKS)}, 'lib', 'jev-client.js'));
process.stderr.write = () => true;
const out = JSON.parse(process.argv[2]).map((u) => { process.env.ANTIHALL_JEV_TEST_ENDPOINT = u; return client.loadJevConfig().endpointOverride !== null; });
process.stdout.write(JSON.stringify(out));
`);
  const nodeAll = urls.concat(stricter);
  const nodeRes = JSON.parse((await run('node', [NODE_LB, JSON.stringify(nodeAll)], '', { ...baseEnv, HOME: path.join(tmp, 'cfg0') })).out);
  const strictSet = new Set(stricter);
  await pool(nodeAll, CONC, async (u, i) => {
    const r = JSON.parse((await run(ENGINE, ['jev', 'status', '--json'], '', { ...baseEnv, HOME: path.join(tmp, 'cfg0'), ANTIHALL_JEV_TEST_ENDPOINT: u })).out);
    if (strictSet.has(u)) tally('loopback-stricter', r.endpoint_override === false, { url: u, node: nodeRes[i], rust: r.endpoint_override });
    else tally('loopback-rule', r.endpoint_override === nodeRes[i], { url: u, node: nodeRes[i], rust: r.endpoint_override });
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  await scrubParity();
  await pool(cases, CONC, (c, i) => decisionCase(c, i));
  await configParity();
  await loopbackParity();
  server.close();
  console.log(`jev parity: engine ${ENGINE}\n  cases ${cases.length}, requests ${cases.reduce((a, c) => a + c.requests.length, 0)}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  let allOk = true;
  for (const [k, v] of Object.entries(stats)) {
    const pc = (100 * v.ok / v.n).toFixed(2);
    if (v.ok !== v.n) allOk = false;
    console.log(`  ${k.padEnd(24)} ${v.ok}/${v.n} = ${pc}%${v.corpus ? '  ' + JSON.stringify(v.corpus) : ''}`);
  }
  console.log(`  requests seen by the mock server: node ${traffic.node}, rust ${traffic.rust}`);
  if (!traffic.node || traffic.node !== traffic.rust) allOk = false;
  fs.writeFileSync(OUT, JSON.stringify(mism, null, 1));
  for (const m of mism.slice(0, SHOW)) console.log('MISMATCH ' + JSON.stringify(m).slice(0, 700));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(allOk ? 0 : 1);
})();
