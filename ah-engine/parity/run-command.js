#!/usr/bin/env node
// Full-outcome parity for the built-in `command` check: the Node command-guard (authority) vs the engine, comparing
// exit code, stdout and stderr exactly (trailing whitespace trimmed).
//   node run-command.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks --corpus c.jsonl
//        [--profiles coord,sub,plain,devswarm] [--mode oneshot|daemon|both] [--limit N] [--conc 8] [--show 15]
//        [--out mismatches.json]
// Corpus lines: {"command": "...", "cwd": "/optional/dir", "sub": false, "source": "..."} (a field command, run once
// per profile) or {"raw": "<stdin text>", "env": {...}, "source": "..."} (a recorded Node test payload, run once with
// its own environment). Profiles: coord = main thread (CLAUDE_CODE_ENTRYPOINT=cli, no agent markers); sub = the same
// with agent_id in the payload; plain = no entrypoint; devswarm = coord plus DEVSWARM_REPO_ID. Marker variants: subempty
// (agent_id ""), subtype (agent_type only), subnull (agent_id null), agenttool (entrypoint agent_tool, no marker), codexmain,
// codexsub, codexsubnull, codexcli (Codex payload shapes).
// Node side runs `command-guard.js`; engine side runs `ah-engine check command` (oneshot: the logic in-process; an
// AHFALLBACK answer is a deferral) and/or `ah-engine hook --fallback command-guard.js` against a daemon whose rules
// file enables `check = "command"` (daemon: the production path, D74: a deferral runs the Node hook through a wrapper
// that records it, so deferrals are counted and the reply must still equal Node's). Everything runs under a temp HOME;
// nothing touches the real home.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ENGINE = path.resolve(arg('--engine', '../target/release/ah-engine'));
const HOOKS = path.resolve(arg('--hooks'));
const GUARD = path.join(HOOKS, 'command-guard.js');
const MODE = arg('--mode', 'both');
const PROFILES = arg('--profiles', 'coord').split(',');
const LIMIT = +arg('--limit', 1e9), SHOW = +arg('--show', 15), CONC = +arg('--conc', 8);
const OUT = arg('--out', path.join(__dirname, 'last-command-mismatches.json'));
const tmp = fs.mkdtempSync(path.join('/tmp', 'ah-cpar-'));
const home = path.join(tmp, 'h'); fs.mkdirSync(home);
const deferLog = path.join(tmp, 'deferred.log');
const wrapper = path.join(tmp, 'node-wrap.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$PARITY_TAG" >> '${deferLog}'\nexec node "$@"\n`, { mode: 0o755 });
const PROFILE_ENV = { coord: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, sub: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, plain: {}, devswarm: { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'parity' },
  subempty: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, subtype: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, subnull: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, agenttool: { CLAUDE_CODE_ENTRYPOINT: 'agent_tool' },
  'devswarm-sub': { CLAUDE_CODE_ENTRYPOINT: 'cli', DEVSWARM_REPO_ID: 'parity' }, 'stash-sub': { CLAUDE_CODE_ENTRYPOINT: 'cli', ANTIHALL_STASH_GUARD: '1' },
  codexmain: {}, codexsub: {}, codexsubnull: {}, codexcli: { CLAUDE_CODE_ENTRYPOINT: 'cli' } };
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
  const lines = fs.readFileSync(path.resolve(arg('--corpus')), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(0, LIMIT);
  const cases = [];
  for (const c of lines) {
    if (typeof c.raw === 'string') { cases.push({ input: c.raw, env: c.env || {}, cwd: (() => { try { return JSON.parse(c.raw).cwd; } catch { return undefined; } })(), source: c.source, profile: 'recorded' }); continue; }
    if (typeof c.command !== 'string') continue;
    for (const pr of PROFILES) {
      const cwd = okCwd(c.cwd);
      const p = { session_id: 'parity', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c.command } };
      if (pr === 'sub' || pr === 'devswarm-sub' || pr === 'stash-sub') p.agent_id = 'parity-agent';
      if (pr === 'subempty') p.agent_id = '';
      if (pr === 'subtype') p.agent_type = 'general-purpose';
      if (pr === 'subnull') p.agent_id = null;
      if (pr.startsWith('codex')) { p.turn_id = 't1'; p.model = 'gpt-5'; }
      if (pr === 'codexsub') p.agent_id = 'parity-agent';
      if (pr === 'codexsubnull') { p.agent_id = ''; p.agent_type = null; }
      cases.push({ input: JSON.stringify(p), env: PROFILE_ENV[pr] || {}, cwd, source: c.source, profile: pr, command: c.command });
    }
  }
  const dir = path.join(tmp, 'e'), rf = path.join(tmp, 'rules.json');
  fs.writeFileSync(rf, JSON.stringify({ version: 1, rules: [{ id: 'command-guard', events: ['PreToolUse'], tools: ['Bash'], check: 'command', action: 'deny' }] }));
  const denv = { ...baseEnv, AH_ENGINE_DIR: dir, AH_ENGINE_RULES: rf, AH_ENGINE_SESSION_RPS: '0', AH_ENGINE_PROJECT_RPS: '0', AH_ENGINE_VERSION: 'parity', AH_ENGINE_EVAL_BUDGET_US: '0', AH_ENGINE_DEADLINE_MS: '30000', AH_ENGINE_NODE: wrapper, AH_ENGINE_BREAKER_N: '1000000' };
  if (MODE !== 'oneshot') {
    await run(ENGINE, ['hook'], JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo warm' }, cwd: '/tmp' }), denv, '/tmp');
    for (let i = 0; i < 100; i++) { const r = await run(ENGINE, ['ctl', 'ping'], '', denv, '/tmp'); if (r.code === 0) break; await new Promise(r => setTimeout(r, 50)); }
  }
  const stats = { n: 0, oneshot: 0, daemon: 0, node_block: 0, node_out: 0, os_deferred: 0, os_allowed: 0 };
  const byProfile = {};
  const mism = [];
  await pool(cases, CONC, async (c, k) => {
    const cwd = okCwd(c.cwd);
    const env = { ...baseEnv, ...c.env };
    const n = norm(await run('node', [GUARD], c.input, env, cwd));
    stats.n++;
    const bp = byProfile[c.profile] || (byProfile[c.profile] = { n: 0, oneshot_deferred: 0, daemon_deferred: 0, node_block: 0 });
    bp.n++;
    if (n.code === 2) { stats.node_block++; bp.node_block++; } else if (n.out) stats.node_out++;
    const miss = {};
    if (MODE !== 'daemon') {
      const e = norm(await run(ENGINE, ['check', 'command'], c.input, { ...env, AH_ENGINE_PLUGIN_ROOT: path.resolve(HOOKS, '..') }, cwd));
      if (e.out === 'AHFALLBACK' && e.code === 0 && !e.err) { stats.os_deferred++; bp.oneshot_deferred++; stats.oneshot++; }
      else if (same(n, e)) { stats.oneshot++; stats.os_allowed++; }
      else miss.oneshot = e;
    }
    if (MODE !== 'oneshot') {
      const tag = 'c' + k;
      const e = norm(await run(ENGINE, ['hook', '--fallback', GUARD], c.input, { ...denv, ...c.env, PARITY_TAG: tag }, cwd));
      if (same(n, e)) stats.daemon++; else miss.daemon = e;
    }
    if (Object.keys(miss).length && mism.length < 5000) mism.push({ input: c.input.slice(0, 800), env: c.env, profile: c.profile, source: c.source, node: n, ...miss });
  });
  let dDeferred = 0;
  if (MODE !== 'oneshot') {
    const tags = fs.existsSync(deferLog) ? fs.readFileSync(deferLog, 'utf8').split('\n').filter(Boolean) : [];
    dDeferred = tags.length;
    for (const t of tags) { const c = cases[+t.slice(1)]; if (c) byProfile[c.profile].daemon_deferred++; }
  }
  const pc = x => stats.n ? (100 * x / stats.n).toFixed(2) + '%' : '-';
  console.log(`corpus ${arg('--corpus')}: cases=${stats.n} (profiles ${[...new Set(cases.map(c => c.profile))].join(',')}) node-blocks=${stats.node_block} node-stdout=${stats.node_out}`);
  if (MODE !== 'daemon') console.log(`  oneshot agreement: ${stats.oneshot}/${stats.n} = ${pc(stats.oneshot)} (engine answered ${stats.os_allowed}, deferred ${stats.os_deferred} = ${pc(stats.os_deferred)})`);
  if (MODE !== 'oneshot') console.log(`  daemon  agreement: ${stats.daemon}/${stats.n} = ${pc(stats.daemon)} (deferred to Node via --fallback: ${dDeferred} = ${pc(dDeferred)})`);
  for (const [p, b] of Object.entries(byProfile)) console.log(`  profile ${p}: n=${b.n} node-blocks=${b.node_block} oneshot-deferred=${b.oneshot_deferred} daemon-deferred=${b.daemon_deferred}`);
  fs.writeFileSync(OUT, JSON.stringify(mism, null, 1));
  for (const m of mism.slice(0, SHOW)) console.log(JSON.stringify({ i: m.input.slice(0, 200), p: m.profile, n: [m.node.code, m.node.err.slice(0, 90)], e: (m.oneshot || m.daemon) && [(m.oneshot || m.daemon).code, (m.oneshot || m.daemon).err.slice(0, 90), (m.oneshot || m.daemon).out.slice(0, 60)] }));
  if (MODE !== 'oneshot') {
    await run(ENGINE, ['ctl', 'stop'], '', denv, '/tmp');
    for (let i = 0; i < 100; i++) { const r = await run(ENGINE, ['ctl', 'ping'], '', denv, '/tmp'); if (r.code !== 0) break; await new Promise(r => setTimeout(r, 30)); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = mism.length ? 1 : 0;
})();
