// Parity machinery for the handover and Codex hooks (handover-resume, precompact-snapshot, codex-availability,
// codex-quota-detect, codex-nudge). Each scenario builds a sandbox (a home directory, repositories, transcripts) twice,
// once for the Node hook and once for the engine's built-in check, runs both on the same payload and environment, and
// compares exit code, stdout, stderr and the files each run left behind. Paths and timestamps are normalized.
//
//   node run-b78.js --hook <name> --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks [--show 20]
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(k);

function sh(cmd, args, o) {
  const r = cp.spawnSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 }, o || {}));
  return { code: r.status === null ? 'sig:' + r.signal : r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ---- sandbox helpers (used by the scenario files) ------------------------------------------------------------
const GITENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => sh('git', a, { cwd, env: Object.assign({}, process.env, GITENV) });
function write(root, rel, content, ageSec) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  // one time base per scenario, so the node run and the engine run see the same mtimes
  if (ageSec !== undefined) { const t = exports.BASE - ageSec; fs.utimesSync(f, t, t); }
  return f;
}
function repo(root, rel, files) {
  const d = path.join(root, rel);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  for (const [n, c] of Object.entries(files || { 'a.txt': 'a\n' })) write(d, n, c);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}
const jl = (...entries) => entries.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n';

// ---- normalization and comparison ------------------------------------------------------------------------------
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g;
const VOLATILE = new Set(['checkedAt', 'recordedAt', 'ts', 'lastSweep']);
function normText(s, root) {
  // an ISO time near now is volatile; any other (a file's fixed mtime, a date in the message) is compared exactly
  return String(s).split(root).join('$R').replace(ISO, (m) => (Math.abs(Date.parse(m) - Date.now()) < 600000 ? '<NOW>' : m));
}
// JSON files: volatile keys are compared as "both recent"; everything else exactly, key order included.
function normJson(txt, root, nowMs) {
  let v; try { v = JSON.parse(txt); } catch (_) { return normText(txt, root); }
  const walk = x => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = VOLATILE.has(k) && typeof x[k] === 'number' ? (Math.abs(x[k] - nowMs) < 600000 ? '<NOW>' : x[k]) : (k === 'until' && typeof x[k] === 'number' && Math.abs(x[k] - nowMs - 21600000) < 600000 ? '<NOW+6H>' : walk(x[k])); return o; }
    return x;
  };
  return normText(JSON.stringify(walk(v)), root);
}
function snapshot(root, nowMs) {
  const out = {};
  const walkDir = (d, rel) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.name === '.git') { out[r + '/'] = '<git>'; continue; }
      if (e.isDirectory()) { walkDir(path.join(d, e.name), r); continue; }
      if (e.isSymbolicLink()) { out[r] = '-> ' + normText(fs.readlinkSync(path.join(d, e.name)), root); continue; }
      let txt = ''; try { txt = fs.readFileSync(path.join(d, e.name), 'utf8'); } catch (_) { txt = '<unreadable>'; }
      out[r] = /\.json$/.test(e.name) ? normJson(txt, root, nowMs) : normText(txt, root);
    }
  };
  walkDir(root, '');
  return out;
}
// Jev decision rows of an integration that is off: the engine writes none by default (jev.log_off_rows), as in the Jev lane.
const volatileKeys = rel => /\.tmp$|(^|\/)logs\/jev-assist\.ndjson$/.test(rel);

async function runParity(o) {
  const ENGINE = path.resolve(o.engine), HOOKS = path.resolve(o.hooks), hook = path.join(HOOKS, o.hookFile);
  const tmp = fs.mkdtempSync(path.join('/tmp', `ah-b78-${o.name}-`));
  const stats = { n: 0, same: 0, deferred: 0, mismatch: 0, nodeOut: 0, nodeFiles: 0, deferredIds: [] };
  const mism = [];
  const only = arg('--only', null);
  for (const sc of o.scenarios) {
    if (only && !String(sc.id).includes(only)) continue;
    stats.n++;
    exports.BASE = Math.floor(Date.now() / 1000);
    const sides = {};
    for (const side of ['node', 'engine']) {
      // both sides run at the SAME absolute path (one after the other) so paths in outputs and encoded directory names agree
      const root = path.join(tmp, `${stats.n}`);
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'home', '.anti-hall'), { recursive: true });
      const built = sc.setup ? sc.setup(root) : {};
      const payload = built.payload !== undefined ? built.payload : sc.payload;
      const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const env = Object.assign({ PATH: process.env.PATH, HOME: path.join(root, 'home'), ANTIHALL_TEST_ISOLATION: '1', ANTIHALL_INGEST_DRY_RUN: '1', TMPDIR: path.join(root, 'tmp'), TZ: 'UTC' }, GITENV, sc.env || {}, built.env || {});
      for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
      const cwd = built.runCwd || root;
      const t0 = Date.now();
      const r = side === 'node' ? sh(process.execPath, [hook], { input, env, cwd }) : sh(ENGINE, ['check', o.check], { input, env, cwd });
      const t1 = Date.now();
      sides[side] = { root, r, snap: snapshot(root, (t0 + t1) / 2) };
      if (side === 'node') fs.renameSync(root, root + '.node');
    }
    const n = sides.node, e = sides.engine;
    const nr = { code: n.r.code, out: normText(n.r.out, n.root), err: normText(n.r.err, n.root) };
    const er = { code: e.r.code, out: normText(e.r.out, e.root), err: normText(e.r.err, e.root) };
    if (nr.out) stats.nodeOut++;
    if (Object.keys(n.snap).filter(k => !volatileKeys(k) && !/^home\/\.anti-hall\/(settings|skip)\.json$/.test(k)).length > 0 && sc.expectFiles !== false) stats.nodeFiles++;
    if (er.out.trim() === 'AHFALLBACK') { stats.deferred++; stats.deferredIds.push(sc.id); continue; }
    const strip = s => { const c = {}; for (const [k, v] of Object.entries(s)) if (!volatileKeys(k)) c[k] = v; return c; };
    const ns = strip(n.snap), es = strip(e.snap);
    const same = nr.code === er.code && nr.out === er.out && nr.err === er.err && JSON.stringify(ns) === JSON.stringify(es);
    if (same) stats.same++;
    else { stats.mismatch++; if (mism.length < 500) mism.push({ id: sc.id, node: nr, engine: er, nodeFiles: ns, engineFiles: es }); }
    if (!flag('--keep')) { fs.rmSync(n.root + '.node', { recursive: true, force: true }); fs.rmSync(e.root, { recursive: true, force: true }); }
  }
  console.log(`${o.name}: scenarios=${stats.n} same=${stats.same} deferred=${stats.deferred} MISMATCH=${stats.mismatch} (node printed output in ${stats.nodeOut}, left files in ${stats.nodeFiles})`);
  if (stats.deferred) console.log('  deferred: ' + stats.deferredIds.slice(0, +arg('--show-defer', 12)).join(' | '));
  fs.writeFileSync(path.join(os.tmpdir(), `ah-b78-${o.name}-mismatches.json`), JSON.stringify(mism, null, 1));
  for (const m of mism.slice(0, +arg('--show', 10))) {
    console.log('--- ' + m.id);
    console.log('  node  : ' + JSON.stringify([m.node.code, m.node.out.slice(0, 400), m.node.err.slice(0, 200)]));
    console.log('  engine: ' + JSON.stringify([m.engine.code, m.engine.out.slice(0, 400), m.engine.err.slice(0, 200)]));
    const ks = new Set([...Object.keys(m.nodeFiles), ...Object.keys(m.engineFiles)]);
    for (const k of ks) if (m.nodeFiles[k] !== m.engineFiles[k]) console.log(`  file ${k}\n    node  : ${String(m.nodeFiles[k]).slice(0, 300)}\n    engine: ${String(m.engineFiles[k]).slice(0, 300)}`);
  }
  if (!flag('--keep')) fs.rmSync(tmp, { recursive: true, force: true }); else console.log('kept ' + tmp);
  process.exitCode = stats.mismatch ? 1 : 0;
  return stats;
}

exports.BASE = Math.floor(Date.now() / 1000);
Object.assign(exports, { arg, flag, sh, git, write, repo, jl, runParity, GITENV });
