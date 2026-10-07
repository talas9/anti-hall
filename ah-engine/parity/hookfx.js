// Parity machinery for ported hooks whose behaviour is FILE EFFECTS plus an exit code and stdout (task-lifecycle-log,
// task-tracker, dispatch-tier, task-guard, tasklist-guard). The real Node hook is run as a subprocess with an isolated
// HOME (ANTIHALL_TEST_ISOLATION=1, ANTIHALL_INGEST_DRY_RUN=1) in one world directory, the engine's built-in check
// (`ah-engine check <name>`, one process per call) in an identical second world, and the two are compared on exit code,
// stdout and the whole file tree each world holds afterwards (paths made world-relative, ISO timestamps masked).
//
// A scenario is {id, world?, steps:[{payload | raw, env?, before?}]}. World spec: {files:{rel:body}, dirs:[rel],
// links:{rel:target}, gitdirs:[rel], modes:{rel:octal}}; paths are relative to the world root W, with W/home as HOME and
// W/proj as the default working directory. Tokens `$W`, `$HOME`, `$PROJ` in a payload string (any depth) or a link
// target are replaced by the world's paths. `before(worldRoot)` may mutate the world between steps (both worlds).
//
// Engine answers: `AHFALLBACK` on stdout = deferred (the dispatcher would then run the Node hook), so the Node hook is
// run in the engine world too, keeping both worlds in step; deferrals are counted, never hidden. Anything else must
// equal Node exactly: that is a MISMATCH otherwise.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(k);

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function subst(v, W) {
  const home = path.join(W, 'home'), proj = path.join(W, 'proj');
  const f = s => s.split('$HOME').join(home).split('$PROJ').join(proj).split('$W').join(W);
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map(x => subst(x, W));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), subst(x, W)]));
  return v;
}

function build(W, spec) {
  const w = spec || {};
  fs.mkdirSync(path.join(W, 'home', '.anti-hall'), { recursive: true });
  fs.mkdirSync(path.join(W, 'proj'), { recursive: true });
  for (const d of w.dirs || []) fs.mkdirSync(path.join(W, d), { recursive: true });
  for (const g of w.gitdirs || []) fs.mkdirSync(path.join(W, g, '.git'), { recursive: true });
  for (const [rel, body] of Object.entries(w.files || {})) {
    const f = path.join(W, rel); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body === null ? '' : subst(body, W));
  }
  for (const [rel, t] of Object.entries(w.links || {})) {
    const f = path.join(W, rel); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.symlinkSync(subst(t, W), f);
  }
  for (const [rel, m] of Object.entries(w.modes || {})) fs.chmodSync(path.join(W, rel), parseInt(m, 8));
}

const TS = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
// The tree under W as {relpath: content}. Directories are listed as "<dir>"; symlinks as "-> target".
function snapshot(W, skip) {
  const out = {};
  const walk = (d, rel) => {
    let names; try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const n of names.sort()) {
      const p = path.join(d, n), r = rel ? rel + '/' + n : n;
      if (skip && skip(r)) continue;
      let st; try { st = fs.lstatSync(p); } catch (_) { continue; }
      if (st.isSymbolicLink()) out[r] = '-> ' + fs.readlinkSync(p).split(W).join('<W>');
      else if (st.isDirectory()) { out[r] = '<dir>'; walk(p, r); }
      else out[r] = fs.readFileSync(p, 'utf8').split(W).join('<W>').replace(TS, '<TS>').replace(/"lastSweep":\d+/g, '"lastSweep":<N>').replace(/"ts":\d{12,}/g, '"ts":<N>').replace(/"project":"[ne]\d+"/g, '"project":"<W>"');
    }
  };
  walk(W, '');
  return out;
}

// rm -rf of a world: restore write permission first (scenarios chmod directories read-only on purpose).
function rmWorld(p) {
  const walk = d => { let st; try { st = fs.lstatSync(d); } catch (_) { return; } if (st.isSymbolicLink()) return; try { fs.chmodSync(d, 0o755); } catch (_) {} if (st.isDirectory()) for (const n of fs.readdirSync(d)) walk(path.join(d, n)); };
  walk(p); fs.rmSync(p, { recursive: true, force: true });
}

const run = (cmd, args, input, env, cwd, timeout) => new Promise(res => {
  const p = cp.spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let o = '', e = '';
  p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
  const to = setTimeout(() => p.kill('SIGKILL'), timeout || 60000);
  p.on('close', (code, sig) => { clearTimeout(to); res({ code: code === null ? 'sig:' + sig : code, out: o, err: e }); });
  p.stdin.on('error', () => {}); p.stdin.end(input);
});

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

const diffTrees = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const d = [];
  for (const k of [...keys].sort()) if (a[k] !== b[k]) d.push({ path: k, node: a[k] === undefined ? '(absent)' : a[k].slice(0, 300), engine: b[k] === undefined ? '(absent)' : b[k].slice(0, 300) });
  return d;
};

// o: {name, hookFile, check, engine, hooks, scenarios, conc, show, nodeArgs?, extraEnv?, skip?(rel), maskOut?(s),
//     mayDefer?(scenario, step) -> bool: when given, a deferral it does not allow is a MISMATCH (the engine must answer)}
async function runFx(o) {
  const ENGINE = path.resolve(o.engine), HOOKS = path.resolve(o.hooks), PLUGIN_ROOT = path.resolve(HOOKS, '..');
  const HOOK = path.join(HOOKS, o.hookFile);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ah-fx-${o.name}-`));
  const stats = { scenarios: 0, steps: 0, same: 0, deferred: 0, unneeded: 0, mismatch: 0, nodeOut: 0, nodeBlocks: 0, effects: 0 };
  const mism = [];
  const mask = o.maskOut || (s => s);
  const baseEnv = (home, extra) => Object.assign({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, ANTIHALL_TEST_ISOLATION: '1', ANTIHALL_INGEST_DRY_RUN: '1' }, o.extraEnv || {}, extra || {});
  let n = 0;
  const only = arg('--only') ? new RegExp(arg('--only')) : null;
  await pool(only ? o.scenarios.filter(sc => only.test(sc.id)) : o.scenarios, o.conc || 6, async sc => {
    const id = n++;
    const WN = path.join(tmp, 'n' + id), WE = path.join(tmp, 'e' + id);
    for (const W of [WN, WE]) { fs.mkdirSync(W, { recursive: true }); build(W, sc.world); }
    stats.scenarios++;
    for (let si = 0; si < sc.steps.length; si++) {
      const step = sc.steps[si];
      stats.steps++;
      if (step.before) { step.before(WN); step.before(WE); }
      const input = W => step.raw !== undefined ? subst(step.raw, W) : JSON.stringify(subst(step.payload, W));
      const nodeRun = async W => {
        const r = await run('node', [HOOK, ...(o.nodeArgs || [])], input(W), baseEnv(path.join(W, 'home'), step.env), W);
        return { code: r.code, out: mask(r.out.split(W).join('<W>')), err: r.err.split(W).join('<W>') };
      };
      const n1 = await nodeRun(WN);
      if (n1.out.trim()) stats.nodeOut++;
      if (n1.code === 2) stats.nodeBlocks++;
      const er = await run(ENGINE, ['check', o.check], input(WE), Object.assign(baseEnv(path.join(WE, 'home'), step.env), { AH_ENGINE_PLUGIN_ROOT: PLUGIN_ROOT }), WE);
      let e1 = { code: er.code, out: mask(er.out.split(WE).join('<W>')), err: er.err.split(WE).join('<W>') };
      let deferred = false;
      if (e1.out.trim() === 'AHFALLBACK') { deferred = true; e1 = await nodeRun(WE); }
      if (deferred && sc.answerWhenSilent && n1.code === 0 && !n1.out.trim()) {
        stats.mismatch++; mism.push({ scenario: sc.id, step: si, node: n1, engine: e1, treeDiff: [], note: 'engine deferred where Node allowed silently', payload: step.payload !== undefined ? step.payload : step.raw });
        continue;
      }
      if (deferred && sc.answerWhenNoBlock && n1.code === 0 && !/"decision"\s*:\s*"block"/.test(n1.out)) {
        stats.mismatch++; mism.push({ scenario: sc.id, step: si, node: n1, engine: e1, treeDiff: [], note: 'engine deferred where Node did not block', payload: step.payload !== undefined ? step.payload : step.raw });
        continue;
      }
      if (deferred && o.mayDefer && !sc.expectDefer && !o.mayDefer(sc, step)) {
        stats.mismatch++; mism.push({ scenario: sc.id, step: si, node: n1, engine: e1, treeDiff: [], note: 'engine deferred where it must answer', payload: step.payload !== undefined ? step.payload : step.raw });
        continue;
      }
      if (sc.expectDefer) {
        // The Node hook starts detached workers whose files land asynchronously: only the deferral itself is checked.
        if (deferred) stats.deferred++; else { stats.mismatch++; mism.push({ scenario: sc.id, step: si, node: n1, engine: e1, treeDiff: [], note: 'expected a deferral' }); }
        continue;
      }
      const tn = snapshot(WN, o.skip), te = snapshot(WE, o.skip);
      const fx = diffTrees(tn, te);
      const sameIo = n1.code === e1.code && n1.out.trim() === e1.out.trim() && n1.err.trim() === e1.err.trim();
      if (deferred) { stats.deferred++; (stats.dids = stats.dids || []).push(sc.id + '#' + si); if (!n1.out.trim() && n1.code === 0 && Object.keys(tn).length === 0) stats.unneeded++; }
      else if (sameIo && fx.length === 0) { stats.same++; if (Object.keys(tn).filter(k => !k.startsWith('home')).length) stats.effects++; }
      else { stats.mismatch++; if (mism.length < 500) mism.push({ scenario: sc.id, step: si, node: n1, engine: e1, treeDiff: fx.slice(0, 6), payload: step.payload !== undefined ? step.payload : step.raw }); }
      if (deferred && (sameIo && fx.length)) { stats.mismatch++; mism.push({ scenario: sc.id, step: si, node: n1, engine: e1, treeDiff: fx.slice(0, 6), note: 'tree differs after a deferral round', payload: step.payload }); }
    }
    if (!flag('--keep')) { rmWorld(WN); rmWorld(WE); }
  });
  console.log(`${o.name}: scenarios=${stats.scenarios} steps=${stats.steps} same=${stats.same} (with file effects: ${stats.effects}) deferred=${stats.deferred} (Node did nothing: ${stats.unneeded}) MISMATCH=${stats.mismatch} node-stdout=${stats.nodeOut} node-blocks=${stats.nodeBlocks}`);
  if (flag('--show-defer')) console.log('deferred: ' + (stats.dids || []).join(' | '));
  const out = path.join(os.tmpdir(), `ah-fx-${o.name}-mismatches.json`);
  fs.writeFileSync(out, JSON.stringify(mism, null, 1));
  for (const m of mism.slice(0, +(arg('--show', 12)))) console.log(JSON.stringify({ s: m.scenario, step: m.step, node: [m.node.code, m.node.out.slice(0, 160), m.node.err.slice(0, 160)], engine: [m.engine.code, m.engine.out.slice(0, 160), m.engine.err.slice(0, 160)], diff: m.treeDiff }));
  if (!flag('--keep')) rmWorld(tmp);
  process.exitCode = stats.mismatch ? 1 : 0;
  return stats;
}

module.exports = { arg, flag, rng, runFx, snapshot, run, subst };
