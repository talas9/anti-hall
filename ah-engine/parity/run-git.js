#!/usr/bin/env node
// Full-outcome parity for the built-in `git` check: the Node git-guard (authority) vs the engine, comparing
// exit code, stdout and stderr exactly (trailing whitespace trimmed).
//   node run-git.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks --corpus c.jsonl
//        [--mode oneshot|daemon|both] [--limit N] [--conc 8] [--show 15] [--out mismatches.json]
// Corpus lines: {"command": "...", "cwd": "/optional/dir", "source": "..."}.
// Node side runs `git-guard.js`; engine side runs `ah-engine check git` (oneshot: the logic in-process) and/or
// `engine hook` against a daemon whose rules file enables `check = "git"` (daemon: the whole path incl. the
// framed reply and exit code). Everything runs under a temp HOME; nothing touches the real home.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ENGINE = path.resolve(arg('--engine', '../target/release/ah-engine'));
const HOOKS = path.resolve(arg('--hooks'));
const MODE = arg('--mode', 'both');
const LIMIT = +arg('--limit', 1e9), SHOW = +arg('--show', 15), CONC = +arg('--conc', 8);
const OUT = arg('--out', path.join(__dirname, 'last-git-mismatches.json'));
const PLUGIN_ROOT = path.resolve(HOOKS, '..');
const tmp = fs.mkdtempSync(path.join('/tmp', 'ah-gpar-'));
const home = path.join(tmp, 'h'); fs.mkdirSync(home);
const payload = (c, cwd) => JSON.stringify({ session_id: 'parity', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c } });
const baseEnv = { PATH: process.env.PATH, HOME: home, ANTIHALL_TEST_ISOLATION: '1' };
const run = (cmd, args, input, env, cwd) => new Promise(res => {
  const p = cp.spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let o = '', e = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
  const to = setTimeout(() => p.kill('SIGKILL'), 60000);
  p.on('close', (code, sig) => { clearTimeout(to); res({ code: code === null ? 'sig:' + sig : code, out: o, err: e }); });
  p.stdin.on('error', () => {}); p.stdin.end(input);
});
const norm = r => ({ code: r.code, out: r.out.trim(), err: r.err.trim() });
const same = (a, b) => a.code === b.code && a.out === b.out && a.err === b.err;
const okCwd = c => { try { return c && fs.statSync(c).isDirectory() ? c : process.cwd(); } catch { return process.cwd(); } };
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

(async () => {
  const corpus = fs.readFileSync(path.resolve(arg('--corpus')), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(c => c && typeof c.command === 'string').slice(0, LIMIT);
  // daemon setup
  const dir = path.join(tmp, 'e'), rf = path.join(tmp, 'rules.json');
  fs.writeFileSync(rf, JSON.stringify({ version: 1, rules: [{ id: 'git-guard', events: ['PreToolUse'], tools: ['Bash'], check: 'git', action: 'deny', options: { plugin_root: PLUGIN_ROOT } }] }));
  const denv = { ...baseEnv, AH_ENGINE_DIR: dir, AH_ENGINE_RULES: rf, AH_ENGINE_SESSION_RPS: '0', AH_ENGINE_PROJECT_RPS: '0', AH_ENGINE_VERSION: 'parity', AH_ENGINE_EVAL_BUDGET_US: '0', AH_ENGINE_DEADLINE_MS: '30000', AH_ENGINE_NODE: 'false', AH_ENGINE_BREAKER_N: '1000000' };
  const oenv = { ...baseEnv, AH_ENGINE_PLUGIN_ROOT: PLUGIN_ROOT };
  if (MODE !== 'oneshot') {
    await run(ENGINE, ['hook'], payload('echo warm', '/tmp'), denv, '/tmp');
    for (let i = 0; i < 100; i++) { const r = await run(ENGINE, ['ctl', 'ping'], '', denv, '/tmp'); if (r.code === 0) break; await new Promise(r => setTimeout(r, 50)); }
  }
  const stats = { n: 0, oneshot: 0, daemon: 0, node_block: 0, node_adv: 0, deferred: 0 };
  const mism = [];
  let nodeMs = 0;
  await pool(corpus, CONC, async c => {
    const cwd = okCwd(c.cwd);
    const p = payload(c.command, cwd);
    const t0 = Date.now();
    const n = norm(await run('node', [path.join(HOOKS, 'git-guard.js')], p, baseEnv, cwd));
    nodeMs += Date.now() - t0;
    stats.n++;
    if (n.code === 2) stats.node_block++; else if (n.out) stats.node_adv++;
    const miss = {};
    if (MODE !== 'daemon') { const e = norm(await run(ENGINE, ['check', 'git'], p, oenv, cwd)); if (e.out === 'AHFALLBACK') { stats.deferred++; stats.oneshot++; } else if (same(n, e)) stats.oneshot++; else miss.oneshot = e; }
    if (MODE !== 'oneshot') { const e = norm(await run(ENGINE, ['hook'], p, denv, cwd)); if (same(n, e)) stats.daemon++; else miss.daemon = e; }
    if (Object.keys(miss).length && mism.length < 5000) mism.push({ command: c.command.slice(0, 600), len: c.command.length, cwd: c.cwd, source: c.source, node: n, ...miss });
  });
  const pc = x => stats.n ? (100 * x / stats.n).toFixed(2) + '%' : '-';
  console.log(`corpus ${arg('--corpus')}: n=${stats.n} node-blocks=${stats.node_block} node-advisories=${stats.node_adv}`);
  if (MODE !== 'daemon') console.log(`  oneshot agreement: ${stats.oneshot}/${stats.n} = ${pc(stats.oneshot)} (${stats.deferred} deferred to Node: the engine answered AHFALLBACK)`);
  if (MODE !== 'oneshot') console.log(`  daemon  agreement: ${stats.daemon}/${stats.n} = ${pc(stats.daemon)}`);
  fs.writeFileSync(OUT, JSON.stringify(mism, null, 1));
  for (const m of mism.slice(0, SHOW)) console.log(JSON.stringify({ c: m.command.slice(0, 200), n: [m.node.code, m.node.err.slice(0, 90), m.node.out.slice(0, 60)], e: (m.oneshot || m.daemon) && [(m.oneshot || m.daemon).code, (m.oneshot || m.daemon).err.slice(0, 90), (m.oneshot || m.daemon).out.slice(0, 60)] }));
  if (MODE !== 'oneshot') await run(ENGINE, ['ctl', 'stop'], '', denv, '/tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
})();
