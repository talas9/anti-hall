#!/usr/bin/env node
// Whole-event parity for the per-event dispatcher (D58): for each corpus command, the reference runs every registry (formerly hooks.json)
// entry of the event as its own Node process, all at once (as the host does), and combines their outputs with the
// reference model in dispatch-lib.js; the engine side runs ONE `ah-engine hook --event <E>` call (built-in checks in
// the engine, the rest through Node). Exit code, stdout and stderr must match exactly (no trimming).
//   node run-dispatch.js --engine ../target/release/ah-engine --plugin <repo>/plugins/anti-hall --corpus c.jsonl
//        [--host claude|codex] [--event PreToolUse] [--tool Bash] [--mode oneshot|daemon|both] [--limit N]
//        [--conc 6] [--show 10] [--out mismatches.json] [--fallback-map map.json] [--time]
// Corpus lines: {"command": "..."} (Bash tool_input.command) or {"payload": {...}} (a whole payload). Each side has
// its own temporary HOME and every item its own session id, so stateful hooks see the same state on both sides;
// commands run in a throwaway git repo, never in a real checkout. Nothing touches the real home.
// A conflict (the reference combiner cannot express the outputs as one) expects the outputs one after another
// (lib.sequential); a join over the host's context cap expects exit 75 with the hand-back message on an event that cannot
// block, and the decisions merged (lib.sequential) on a guard event. --time also reports the wall time of the whole event per side.
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const lib = require('./dispatch-lib.js');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ENGINE = path.resolve(arg('--engine', path.join(__dirname, '../target/release/ah-engine')));
const PLUGIN = path.resolve(arg('--plugin'));
const HOST = arg('--host', 'claude'), EVENT = arg('--event', 'PreToolUse'), TOOL = arg('--tool', 'Bash');
const MODE = arg('--mode', 'both'), LIMIT = +arg('--limit', 1e9), CONC = +arg('--conc', 6), SHOW = +arg('--show', 10);
const OUT = arg('--out', path.join(__dirname, 'last-dispatch-mismatches.json'));
const CAP = +arg('--context-cap', 10000);
// the events whose hooks can block: plugins/anti-hall/engine/defaults/dispatch.toml dispatch.guard_events
const GUARD_EVENTS = ['PreToolUse', 'PermissionRequest', 'Stop', 'SubagentStop'];
const MAP = arg('--fallback-map'), TIME = process.argv.includes('--time');
// D87: hooks.json is one thin trigger per event now; the per-hook registry generated from the dispatch table has the old shape
const hooksJson = JSON.parse(fs.readFileSync(path.join(PLUGIN, HOST === 'codex' ? 'codex/hooks/hooks.registry.json' : 'hooks/hooks.registry.json'), 'utf8'));
// a fallback map replaces commands on BOTH sides (the reference runs exactly what the dispatcher would)
const map = MAP ? JSON.parse(fs.readFileSync(MAP, 'utf8')) : null;

const tmp = fs.mkdtempSync(path.join('/tmp', 'ah-dpar-'));
const mk = d => { fs.mkdirSync(d, { recursive: true }); return d; };
const repo = mk(path.join(tmp, 'repo'));
const gitEnv = { PATH: process.env.PATH, HOME: mk(path.join(tmp, 'gh')), GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@p', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@p' };
cp.execSync('git init -q -b main && git commit -q --allow-empty -m init', { cwd: repo, env: gitEnv });
const envFor = home => ({ PATH: process.env.PATH, HOME: home, ANTIHALL_TEST_ISOLATION: '1', CLAUDE_PLUGIN_ROOT: PLUGIN, PLUGIN_ROOT: PLUGIN });
const refEnv = envFor(mk(path.join(tmp, 'h-ref')));
const engEnv = (mode) => ({
  ...envFor(mk(path.join(tmp, 'h-' + mode))),
  AH_ENGINE_DIR: path.join(tmp, 'e-' + mode), AH_ENGINE_VERSION: 'parity', AH_ENGINE_SESSION_RPS: '0', AH_ENGINE_PROJECT_RPS: '0',
  AH_ENGINE_EVAL_BUDGET_US: '0', AH_ENGINE_DEADLINE_MS: '30000', AH_ENGINE_BREAKER_N: '1000000',
  AH_ENGINE_DISPATCH_IN_PROCESS: mode === 'oneshot' ? '1' : '0', AH_ENGINE_RULES: path.join(tmp, 'rules.json'),
});
fs.writeFileSync(path.join(tmp, 'rules.json'), JSON.stringify({ version: 1, rules: [] }));
const mapFile = path.join(tmp, 'map.json');
if (map) fs.writeFileSync(mapFile, JSON.stringify(map));
const run = (cmd, args, input, env) => new Promise(res => {
  const t0 = process.hrtime.bigint();
  const p = cp.spawn(cmd, args, { env, cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  let o = '', e = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
  const to = setTimeout(() => p.kill('SIGKILL'), 120000);
  p.on('close', (code, sig) => { clearTimeout(to); res({ code: code === null ? 'sig:' + sig : code, out: o, err: e, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); });
  p.stdin.on('error', () => {}); p.stdin.end(input);
});
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }
// the matched entries, with the fallback map applied (the reference runs exactly what the dispatcher would)
const entriesFor = payload => lib.select(hooksJson, HOST, EVENT, payload).map(e => ({ ...e, command: (map && map[EVENT] && map[EVENT][e.id]) || e.command }));

(async () => {
  const corpus = fs.readFileSync(path.resolve(arg('--corpus')), 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(c => c && (typeof c.command === 'string' || c.payload)).slice(0, LIMIT);
  const modes = MODE === 'both' ? ['oneshot', 'daemon'] : [MODE];
  const dargs = ['hook', '--event', EVENT, '--host', HOST, ...(map ? ['--fallback-map', mapFile] : [])];
  if (modes.includes('daemon')) {
    const env = engEnv('daemon');
    await run(ENGINE, ['hook'], JSON.stringify({ hook_event_name: 'Stop', session_id: 'warm' }), env);
    for (let i = 0; i < 100; i++) { const r = await run(ENGINE, ['ctl', 'ping'], '', env); if (r.code === 0) break; await new Promise(r => setTimeout(r, 50)); }
  }
  const stats = { n: 0, blocks: 0, single: 0, merged: 0, conflicts: 0, silent: 0, agree: {}, refMs: [], engMs: {} };
  for (const m of modes) { stats.agree[m] = 0; stats.engMs[m] = []; }
  const mism = [];
  await pool(corpus, CONC, async (c, k) => {
    const payload = c.payload ? { ...c.payload, session_id: 'dpar-' + k } : { session_id: 'dpar-' + k, cwd: repo, hook_event_name: EVENT, tool_name: TOOL, tool_input: { command: c.command } };
    const input = JSON.stringify(payload);
    const es = entriesFor(payload);
    const t0 = process.hrtime.bigint();
    const results = await Promise.all(es.map(e => lib.runHook(e.command, input, refEnv, repo, e.timeout)));
    stats.refMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    let want = lib.combine(results);
    const active = results.filter(r => r.code !== null && (r.code !== 0 || r.out || r.err)).length;
    let handed = false;
    if (want.conflict) { stats.conflicts++; want = lib.sequential(results, undefined, EVENT); }
    else {
      // only a plain answer (exit 0, no JSON block) can be handed back; a guard event never gets exit 75, it delivers the
      // decisions merged (src/dispatch/mod.rs `run`)
      const len = lib.overCap(results, want, CAP);
      const plain = want.code === 0 && !results.some(r => r.code !== null && lib.jsonBlocks(r.out));
      if (len && plain) {
        handed = true;
        want = GUARD_EVENTS.includes(EVENT) ? lib.sequential(results, undefined, EVENT)
          : { code: 75, out: '', err: `anti-hall: the joined ${EVENT} context is ${len} characters, over the ${CAP} the host delivers inline; the hooks must run separately\n` };
      }
    }
    if (handed) { /* counted as merged below */ stats.merged++; }
    else if (want.code === 2 || results.some(r => r.code === 2)) stats.blocks++;
    else if (active === 0) stats.silent++;
    else if (active === 1) stats.single++;
    else stats.merged++;
    stats.n++;
    const miss = {};
    for (const m of modes) {
      const got = await run(ENGINE, dargs, input, engEnv(m));
      stats.engMs[m].push(got.ms);
      if (got.code === want.code && got.out === want.out && got.err === want.err) stats.agree[m]++;
      else miss[m] = { code: got.code, out: got.out.slice(0, 400), err: got.err.slice(0, 400) };
    }
    if (Object.keys(miss).length && mism.length < 2000) mism.push({ input: input.slice(0, 600), source: c.source, want: { code: want.code, out: want.out.slice(0, 400), err: want.err.slice(0, 400) }, per_hook: results.map((r, i) => [es[i].id, r.code, r.out.slice(0, 120), r.err.slice(0, 120)]), ...miss });
  });
  const pc = x => stats.n ? (100 * x / stats.n).toFixed(2) + '%' : '-';
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)].toFixed(1) : '-'; };
  console.log(`corpus ${arg('--corpus')} host=${HOST} event=${EVENT}: n=${stats.n} blocks=${stats.blocks} single-output=${stats.single} merged=${stats.merged} conflicts=${stats.conflicts} silent=${stats.silent}`);
  for (const m of modes) console.log(`  ${m.padEnd(7)} agreement: ${stats.agree[m]}/${stats.n} = ${pc(stats.agree[m])}`);
  if (TIME) {
    console.log(`  wall median (ms, concurrency ${CONC}): reference ${med(stats.refMs)}` + modes.map(m => `, ${m} ${med(stats.engMs[m])}`).join(''));
  }
  fs.writeFileSync(OUT, JSON.stringify(mism, null, 1));
  for (const m of mism.slice(0, SHOW)) console.log(JSON.stringify(m).slice(0, 900));
  if (modes.includes('daemon')) {
    const env = engEnv('daemon');
    await run(ENGINE, ['ctl', 'stop'], '', env);
    for (let i = 0; i < 100; i++) { const r = await run(ENGINE, ['ctl', 'ping'], '', env); if (r.code !== 0) break; await new Promise(r => setTimeout(r, 30)); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = modes.every(m => stats.agree[m] === stats.n) ? 0 : 1;
})();
