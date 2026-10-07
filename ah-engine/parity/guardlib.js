// Shared parity machinery for the small Bash guards (merge-side-pick, ship-it-guard, scan-throttle,
// coordinator-work-guard, compact-declaration-guard). Each parity/run-<guard>.js builds its scenarios and calls
// run(). The Node guard's evaluate(payload, env, {argv}) (hooks/lib/guard-io.js, #136) is the authority; the engine is
// compared on exit code, stdout and stderr (trailing whitespace trimmed), exactly as run-git.js does.
//
// A scenario is {id, ctx?, steps: [{payload, argv?}]}. Steps of one scenario run in order against ONE session, because
// these guards keep per-session state; scenarios run in parallel. `ctx` = {settings?, skip?, claude?, env?} describes
// the home directory and environment the guard sees; scenarios with the same ctx share a home and a daemon.
//
// Outcomes per step:
//   same      the engine printed exactly what Node did
//   deferred  the engine answered AHFALLBACK (oneshot) or the sentinel fallback ran (daemon): Node decides, never a
//             silent allow (D11). Reported separately, with how many of them Node would have allowed with no output
//             ("unneeded"), because a deferral that Node allows is a missed offload, not a parity problem.
//   MISMATCH  anything else: a Rust bug.
// After a step is deferred the rest of that scenario is not compared (the engine's session state is then incomplete,
// which is the expected consequence of Node having answered that step, not a parity error).
// Oneshot mode has no state between processes, so it only runs the FIRST step of each scenario.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(k);

const norm = r => ({ code: r.code, out: String(r.out || '').trim(), err: String(r.err || '').trim() });
const same = (a, b) => a.code === b.code && a.out === b.out && a.err === b.err;

const run = (cmd, args, input, env, cwd) => new Promise(res => {
  const p = cp.spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let o = '', e = '';
  p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
  const to = setTimeout(() => p.kill('SIGKILL'), 60000);
  p.on('close', (code, sig) => { clearTimeout(to); res({ code: code === null ? 'sig:' + sig : code, out: o, err: e }); });
  p.stdin.on('error', () => {}); p.stdin.end(input);
});

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// Replace the token $HOME in every string of a payload with the ctx home (so a scenario can name files it created).
const subst = (v, home) => typeof v === 'string' ? v.split('$HOME').join(home) : Array.isArray(v) ? v.map(x => subst(x, home)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, home)])) : v;

// Build the home directory a ctx describes.
function mkHome(tmp, n, ctx) {
  const home = path.join(tmp, 'h' + n);
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  if (ctx.settings) fs.writeFileSync(path.join(home, '.anti-hall', 'settings.json'), typeof ctx.settings === 'string' ? ctx.settings : JSON.stringify(ctx.settings));
  if (ctx.skip) fs.writeFileSync(path.join(home, '.anti-hall', 'skip.json'), typeof ctx.skip === 'string' ? ctx.skip : JSON.stringify(ctx.skip));
  if (ctx.claude) { fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.writeFileSync(path.join(home, '.claude', 'settings.json'), typeof ctx.claude === 'string' ? ctx.claude : JSON.stringify(ctx.claude)); }
  for (const [rel, body] of Object.entries(ctx.files || {})) { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
  if (ctx.setup) ctx.setup(home);
  return home;
}

// Compare the state files (names matching `re`) of the node home and the engine home. Session-scoped files are compared
// after every step; `norm(name, text)` removes what legitimately differs (clock values). Returns null when equal.
function stateDiff(homeN, homeE, re, norm, sid) {
  const ls = (h, sub) => { try { return fs.readdirSync(path.join(h, '.anti-hall', sub)).map(f => path.join(sub, f)); } catch { return []; } };
  const list = h => [...ls(h, ''), ...ls(h, 'turn-gate')].filter(f => re.test(f)).sort();
  const read = (h, f) => { try { return fs.readFileSync(path.join(h, '.anti-hall', f), 'utf8'); } catch { return null; } };
  const nrm = (f, t) => (t === null ? null : norm ? norm(f, t) : t);
  const a = list(homeN), b = list(homeE);
  const names = [...new Set([...a, ...b])].sort();
  for (const f of names) {
    const x = nrm(f, read(homeN, f)), y = nrm(f, read(homeE, f));
    if (x !== y) return { name: f, node: String(x), engine: String(y) };
  }
  return null;
}

// opts: {name, check, hookFile, scenarios, engine, hooks, mode, conc, show, out, rule?, nodeArgv?(step)->[...],
//        engineRule?: extra rule fields}
async function runParity(o) {
  const ENGINE = path.resolve(o.engine), HOOKS = path.resolve(o.hooks), PLUGIN_ROOT = path.resolve(HOOKS, '..');
  const MODE = o.mode || 'both', CONC = o.conc || 8, SHOW = o.show === undefined ? 15 : o.show;
  const tmp = fs.mkdtempSync(path.join('/tmp', `ah-par-${o.name}-`));
  // a hook that is only a script (no evaluate export) runs as a child process: o.nodeCli
  const guard = o.nodeCli ? null : require(path.join(HOOKS, o.hookFile));
  const sentinel = path.join(tmp, 'defer.js');
  fs.writeFileSync(sentinel, "process.stdout.write('AHDEFERRED\\n');\n");
  // o.fallbackReal: a deferral runs the REAL Node hook (as the dispatcher does) in the engine's home, so a stateful guard is
  // compared end to end: engine-with-Node-fallback against Node alone. The fallback logs each run to AH_PARITY_DEFER_LOG.
  const realFb = path.join(tmp, 'real-fallback.js');
  if (o.fallbackReal) {
    fs.writeFileSync(realFb, `const fs=require('fs'),cp=require('child_process');
const raw=fs.readFileSync(0,'utf8');let ev='';try{ev=JSON.parse(raw).hook_event_name}catch(e){}
const ARGV=${JSON.stringify(o.fallbackArgv || {})};
if(process.env.AH_PARITY_DEFER_LOG)fs.appendFileSync(process.env.AH_PARITY_DEFER_LOG,ev+'\\n');
const r=cp.spawnSync(process.execPath,[${JSON.stringify(path.join(HOOKS, o.hookFile))},...(ARGV[ev]||[])],{input:raw,env:process.env,encoding:'utf8'});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status===2?2:0);
`);
  }
  const fb = o.fallbackReal ? realFb : sentinel;
  const basePath = process.env.PATH;
  const stats = { postSteps: 0, scenarios: 0, steps: 0, compared: 0, same: 0, deferred: 0, unneeded: 0, skipped: 0, mismatch: 0, nodeBlocks: 0, nodeAdvisories: 0 };
  const mism = [];
  const nodeEnv = (home, ctx) => Object.assign({ PATH: basePath, HOME: home, USERPROFILE: home, ANTIHALL_TEST_ISOLATION: '1' }, ctx.env || {});
  const nodeStep = (payload, step, home, ctx) => {
    if (o.nodeCli) {
      const r = cp.spawnSync(process.execPath, [path.join(HOOKS, o.hookFile), ...(step.argv || (o.nodeArgv ? o.nodeArgv(step) : []))], { input: step.raw !== undefined ? step.raw : JSON.stringify(payload), env: nodeEnv(home, ctx), cwd: '/tmp', encoding: 'utf8', timeout: 60000 });
      return norm({ code: r.status === null ? 'sig:' + r.signal : r.status, out: r.stdout, err: r.stderr });
    }
    const d = guard.evaluate(JSON.parse(JSON.stringify(payload)), nodeEnv(home, ctx), { argv: step.argv || (o.nodeArgv ? o.nodeArgv(step) : []) });
    return norm({ code: d.exitCode === 2 ? 2 : 0, out: d.stdout, err: d.stderr });
  };
  // group scenarios by ctx
  const groups = new Map();
  const NOCTX = {};
  // grouped by object identity (a ctx can be large); scenarios sharing one ctx object share a home and a daemon
  for (const sc of o.scenarios) { const k = sc.ctx || NOCTX; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(sc); }
  let gi = 0;
  for (const [k, list] of groups) {
    const ctx = k, home = mkHome(tmp, gi++, ctx);
    // dual: the engine gets its OWN home (same settings), so state files the guards write can be compared instead of shared
    const homeE = o.dual ? mkHome(tmp, 'e' + gi, ctx) : home;
    const dir = path.join(tmp, 'e' + gi), rf = path.join(tmp, `rules${gi}.json`);
    const events = o.events || ['PreToolUse', 'PostToolUse'];
    fs.writeFileSync(rf, JSON.stringify({ version: 1, rules: [Object.assign({ id: o.name, events, tools: o.tools || ['Bash'], check: o.check, action: 'deny', options: { plugin_root: PLUGIN_ROOT } }, o.engineRule || {})] }));
    const eenv = Object.assign({ PATH: basePath, HOME: homeE, USERPROFILE: homeE, ANTIHALL_TEST_ISOLATION: '1' }, ctx.env || {});
    const deferLog = path.join(tmp, 'defer' + gi + '.log');
    const denv = Object.assign({}, eenv, { AH_PARITY_DEFER_LOG: deferLog, AH_ENGINE_DIR: dir, AH_ENGINE_RULES: rf, AH_ENGINE_SESSION_RPS: '0', AH_ENGINE_PROJECT_RPS: '0', AH_ENGINE_VERSION: 'parity', AH_ENGINE_EVAL_BUDGET_US: '0', AH_ENGINE_DEADLINE_MS: '30000', AH_ENGINE_NODE: process.execPath, AH_ENGINE_BREAKER_N: '1000000' });
    const oenv = Object.assign({}, eenv, { AH_ENGINE_PLUGIN_ROOT: PLUGIN_ROOT });
    const warm = JSON.stringify({ session_id: 'warm', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo warm' } });
    if (MODE !== 'oneshot') {
      // a cold start answers through the fallback, so warm the daemon first and wait until it is up
      await run(ENGINE, ['hook', '--fallback', sentinel], warm, denv, '/tmp');
      for (let i = 0; i < 200; i++) { const r = await run(ENGINE, ['ctl', 'ping'], '', denv, '/tmp'); if (r.code === 0) break; await new Promise(r => setTimeout(r, 50)); }
    }
    await pool(list, CONC, async sc => {
      stats.scenarios++;
      let stopped = false;
      for (let si = 0; si < sc.steps.length; si++) {
        const step = sc.steps[si];
        stats.steps++;
        if (step.payload && step.payload.hook_event_name === 'PostToolUse') stats.postSteps++;
        const payload = subst(step.payload, home);
        const payloadE = o.dual ? subst(step.payload, homeE) : payload;
        const n = nodeStep(payload, step, home, ctx);
        if (n.code === 2) stats.nodeBlocks++; else if (n.out) stats.nodeAdvisories++;
        if (n.err && n.code !== 2) stats.nodeStderr = (stats.nodeStderr || 0) + 1;
        if (stopped) { stats.skipped++; continue; }
        const input = step.raw !== undefined ? step.raw : JSON.stringify(payloadE);
        const cwd = '/tmp';
        const results = {};
        if ((MODE === 'oneshot' || MODE === 'both') && si === 0) {
          const e = norm(await run(ENGINE, ['check', o.check], input, oenv, cwd));
          results.oneshot = e.out === 'AHFALLBACK' ? 'deferred' : same(n, e) ? 'same' : e;
        }
        if (MODE === 'daemon' || MODE === 'both') {
          const e = norm(await run(ENGINE, ['hook', '--fallback', fb], input, denv, cwd));
          results.daemon = e.out === 'AHDEFERRED' ? 'deferred' : same(n, e) ? 'same' : e;
        }
        if (o.dual && o.stateFiles && !stopped && Object.keys(results).length) {
          const d = stateDiff(home, homeE, typeof o.stateFiles === 'function' ? o.stateFiles(step.payload) : o.stateFiles, o.stateNorm, sc.id);
          if (d && !Object.values(results).includes('deferred')) { stats.compared++; stats.stateMismatch = (stats.stateMismatch || 0) + 1; stats.mismatch++; if (mism.length < 2000) mism.push({ scenario: sc.id, step: si, mode: 'state', payload, node: { code: 0, out: d.node, err: '' }, engine: { code: 0, out: d.engine, err: d.name } }); }
          else if (!d) { stats.compared++; stats.same++; stats.stateSame = (stats.stateSame || 0) + 1; }
        }
        for (const [mode, r] of Object.entries(results)) {
          stats.compared++;
          if (r === 'same') stats.same++;
          else if (r === 'deferred' && o.strictDeferPrefix && String(sc.id).startsWith(o.strictDeferPrefix) && !n.out && n.code === 0) { stats.mismatch++; if (mism.length < 2000) mism.push({ scenario: sc.id, step: si, mode, payload, node: n, engine: { code: 'deferred', out: 'AHDEFER', err: 'engine deferred where Node allowed (classification divergence)' } }); }
          else if (r === 'deferred') { stats.deferred++; (stats.deferredIds = stats.deferredIds || new Set()).add(sc.id); if (!n.out && n.code === 0) stats.unneeded++; if (mode === 'daemon' || MODE === 'oneshot') stopped = true; }
          else { stats.mismatch++; if (mism.length < 2000) mism.push({ scenario: sc.id, step: si, mode, payload, node: n, engine: r }); }
        }
      }
    });
    if (o.fallbackReal) { stats.nodeRunsBy = stats.nodeRunsBy || {}; try { for (const l of fs.readFileSync(deferLog, 'utf8').split('\n').filter(Boolean)) { stats.nodeRunsBy[l] = (stats.nodeRunsBy[l] || 0) + 1; stats.nodeRuns = (stats.nodeRuns || 0) + 1; } } catch {} }
    if (o.dual && o.sharedFiles) {
      const d = stateDiff(home, homeE, o.sharedFiles, o.stateNorm, 'group-end');
      stats.compared++;
      if (d) { stats.mismatch++; if (mism.length < 2000) mism.push({ scenario: 'group-end', step: 0, mode: 'shared-state', payload: {}, node: { code: 0, out: d.node, err: '' }, engine: { code: 0, out: d.engine, err: d.name } }); }
      else stats.same++;
    }
    if (MODE !== 'oneshot') {
      await run(ENGINE, ['ctl', 'stop'], '', denv, '/tmp');
      for (let i = 0; i < 200; i++) { const r = await run(ENGINE, ['ctl', 'ping'], '', denv, '/tmp'); if (r.code !== 0) break; await new Promise(r => setTimeout(r, 30)); }
    }
  }
  const pc = x => stats.compared ? (100 * x / stats.compared).toFixed(2) + '%' : '-';
  console.log(`${o.name}: scenarios=${stats.scenarios} steps=${stats.steps} node-blocks=${stats.nodeBlocks} node-advisories=${stats.nodeAdvisories} mode=${MODE}`);
  if (o.fallbackReal) console.log(`  PostToolUse steps: ${stats.postSteps}`);
  if (o.fallbackReal) console.log(`  engine-side Node fallback runs (deferrals the engine could not decide): ${stats.nodeRuns || 0} ${JSON.stringify(stats.nodeRunsBy || {})}`);
  console.log(`  compared=${stats.compared} same=${stats.same} (${pc(stats.same)}) deferred=${stats.deferred} (${pc(stats.deferred)}; unneeded: Node allowed silently = ${stats.unneeded}) skipped-after-defer=${stats.skipped} MISMATCH=${stats.mismatch}`);
  if (stats.deferredIds) {
    const by = {};
    for (const id of stats.deferredIds) { const k = String(id).split('-')[0]; by[k] = (by[k] || 0) + 1; }
    console.log('  deferred scenarios by group: ' + JSON.stringify(by));
    if (flag('--show-defer')) console.log('  deferred scenarios: ' + [...stats.deferredIds].slice(0, 60).join(' | '));
  }
  fs.writeFileSync(o.out || path.join(os.tmpdir(), `ah-parity-${o.name}-mismatches.json`), JSON.stringify(mism, null, 1));
  for (const m of mism.slice(0, SHOW)) console.log(JSON.stringify({ s: m.scenario, step: m.step, mode: m.mode, cmd: (m.payload && m.payload.tool_input && (m.payload.tool_input.command || m.payload.tool_input.file_path) || '').slice(0, 160), n: [m.node.code, m.node.out.slice(0, 120), m.node.err.slice(0, 120)], e: [m.engine.code, m.engine.out.slice(0, 120), m.engine.err.slice(0, 120)] }));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = stats.mismatch ? 1 : 0;
  return stats;
}

// Read a JSONL file of Bash commands with their session ids: {cmd, session, cwd, ts, sub}.
function readCmds(file, limit) {
  const out = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (typeof j.cmd === 'string') out.push(j);
    if (out.length >= (limit || 1e9)) break;
  }
  return out;
}

const bash = (event, sid, command, extra) => Object.assign({ hook_event_name: event, tool_name: 'Bash', session_id: sid, cwd: '/tmp', tool_input: { command } }, extra || {});

// Deterministic PRNG so a failing corpus is reproducible.
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// The file-name part of a session id as the guards build it (letters, digits, . _ - kept; the rest _; cut to `max` UTF-16 units).
const safeSid = (sid, max) => String(sid || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, max);

module.exports = { safeSid, arg, flag, runParity, readCmds, bash, rng, norm, same, run, pool };
