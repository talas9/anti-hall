// Parity harness for the SessionStart session-maintenance checks (version-alert, devswarm-version, claude-cli-version,
// repo-self-drift, defect-nudge, progress-prune). Unlike the PreToolUse guards these hooks are scripts that read and
// write files, so a scenario is a whole fixture directory (home, project, plugin root) and the comparison covers three
// things, exactly as the port plan asks: exit code, stdout bytes, and the state-file effects.
//
// One scenario = {id, hook, files, env, plugin, payload|raw, git, expectDefer}. It runs twice on the SAME paths, each time
// from a freshly built copy of the fixture: first the real Node hook (a spy preloaded into it records every child process it
// would start and starts none), then `ah-engine check <hook>` with the same environment. Afterwards both directory trees
// are compared. Same paths on purpose: several state keys (the prune throttle key, the gitignore state key) are derived
// from a path, so two different fixture paths would differ for no reason.
//
// A deferral (`AHFALLBACK`, the engine saying "Node decides") is correct when Node would have started a background probe
// (the spy logged it) or the scenario says it expects one; every other deferral is reported as unexplained and counted,
// never silently accepted. When Node started a probe and the engine decided anyway, that is a mismatch.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const HOOKS = {
  'version-alert': 'version-alert.js', 'devswarm-version': 'devswarm-version.js', 'claude-cli-version': 'claude-cli-version.js',
  'repo-self-drift': 'repo-self-drift.js', 'defect-nudge': 'defect-nudge.js', 'progress-prune': 'progress-prune.js',
};

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

// ---- fixtures ---------------------------------------------------------------------------------------------------
const SPY = `'use strict';
// preload: record every child_process.spawn the hook makes and start nothing
const cp = require('child_process'), fs = require('fs');
const real = cp.spawn;
cp.spawn = function (cmd, args, opts) {
  try { fs.appendFileSync(process.env.ANTIHALL_SPY_LOG, JSON.stringify({ cmd: require('path').basename(String(cmd)), script: require('path').basename(String((args || [])[0] || '')), detached: !!(opts && opts.detached), stdio: opts && opts.stdio }) + '\\n'); } catch (_) {}
  return { unref() {}, on() {}, pid: 0 };
};
cp._realSpawn = real;
`;

// Replace {{NOW-ms}} {{NOW+ms}} {{ISO-ms}} {{ISO+ms}} {{HOME}} {{PROJ}} {{BASE}} {{PLUGIN}} in fixture text.
function expand(text, vars) {
  return String(text).replace(/\{\{(NOW|ISO)([-+]\d+)?\}\}|\{\{(HOME|PROJ|BASE|PLUGIN|TODAY)\}\}/g, (m, kind, off, name) => {
    if (name) return vars[name];
    const t = vars.now0 + (off ? Number(off) : 0);
    return kind === 'NOW' ? String(t) : new Date(t).toISOString();
  });
}

function buildTree(base, files, vars) {
  for (const [rel, spec] of Object.entries(files || {})) {
    const full = path.join(base, rel);
    if (rel.endsWith('/')) { fs.mkdirSync(full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (spec && typeof spec === 'object' && spec.link !== undefined) { fs.symlinkSync(expand(spec.link, vars), full); continue; }
    const content = spec && typeof spec === 'object' && !Buffer.isBuffer(spec) ? spec.content : spec;
    fs.writeFileSync(full, Buffer.isBuffer(content) ? content : expand(content, vars));
    if (spec && typeof spec === 'object' && !Buffer.isBuffer(spec)) {
      if (spec.mode !== undefined) fs.chmodSync(full, spec.mode);
      if (spec.mtimeOffset !== undefined) { const t = (vars.now0 + spec.mtimeOffset) / 1000; fs.utimesSync(full, t, t); }
    }
  }
}

// Snapshot a tree: relative path -> {type, text|target}; `.git` internals are left out (the hooks only read them).
function snapshot(base) {
  const out = {};
  const walk = (dir, rel) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names.sort()) {
      const r = (rel ? rel + '/' + n : n).replace(/\.tmp\.\d+$/, '.tmp.<pid>'), full = path.join(dir, n);
      if (n === '.git' && rel.split('/').length <= 2) { out[r] = { type: 'dir' }; continue; }
      let st; try { st = fs.lstatSync(full); } catch (_) { continue; }
      if (st.isSymbolicLink()) out[r] = { type: 'link', target: fs.readlinkSync(full) };
      else if (st.isDirectory()) { out[r] = { type: 'dir' }; walk(full, r); }
      else { let t; try { t = fs.readFileSync(full).toString('utf8'); } catch (_) { t = '<unreadable>'; } out[r] = { type: 'file', text: t }; }
    }
  };
  walk(base, '');
  return out;
}

// Times the hook wrote itself differ by a few milliseconds between the two runs: epoch-millisecond numbers and ISO
// timestamps near now0 that the fixture did not write are replaced by a token, so that only their presence and place count.
function normalizer(vars, fixtureText) {
  const known = new Set((fixtureText.match(/\b1[67]\d{11}\b/g) || []).concat(fixtureText.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g) || []));
  return text => String(text)
    .replace(/\b1[67]\d{11}\b/g, m => (!known.has(m) && Math.abs(Number(m) - vars.now0) < 120000) ? '<NOW>' : m)
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, m => (!known.has(m) && Math.abs(Date.parse(m) - vars.now0) < 120000) ? '<ISO>' : m);
}

function diffTrees(a, b, norm) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs = [];
  for (const k of [...keys].sort()) {
    const x = a[k], y = b[k];
    if (!x || !y) { diffs.push(`${k}: ${x ? 'only in node' : 'only in engine'}`); continue; }
    if (x.type !== y.type) { diffs.push(`${k}: type ${x.type} vs ${y.type}`); continue; }
    if (x.type === 'file' && norm(x.text) !== norm(y.text)) diffs.push(`${k}: node=${JSON.stringify(norm(x.text)).slice(0, 300)} engine=${JSON.stringify(norm(y.text)).slice(0, 300)}`);
    if (x.type === 'link' && x.target !== y.target) diffs.push(`${k}: link ${x.target} vs ${y.target}`);
  }
  return diffs;
}

// ---- the plugin roots -----------------------------------------------------------------------------------------------
// A plugin root is a real copy (Node resolves symlinks, so a link would read the template's files). `spec` describes the
// variations a hook reads: the running version, the KB text and where it sits, extra hook files and skill directories.
const copyKeep = ['hooks', 'companion', '.claude-plugin'];
function pluginRoot(tmp, repo, spec) {
  const key = JSON.stringify(spec || {});
  pluginRoot.cache = pluginRoot.cache || new Map();
  if (pluginRoot.cache.has(key)) return pluginRoot.cache.get(key);
  const id = pluginRoot.cache.size;
  const top = path.join(tmp, 'plug' + id);                 // the "repo" level: <top>/plugins/anti-hall
  const root = path.join(top, 'plugins', 'anti-hall');
  fs.mkdirSync(root, { recursive: true });
  const src = path.join(repo, 'plugins', 'anti-hall');
  for (const d of copyKeep) cp.execFileSync('cp', ['-R', path.join(src, d), path.join(root, d)]);
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  cp.execFileSync('cp', ['-R', path.join(src, 'skills', 'update'), path.join(root, 'skills', 'update')]);
  const s = spec || {};
  const pj = path.join(root, '.claude-plugin', 'plugin.json');
  if (s.pluginJson !== undefined) { if (s.pluginJson === null) fs.unlinkSync(pj); else fs.writeFileSync(pj, s.pluginJson); }
  else if (s.version !== undefined) { const j = JSON.parse(fs.readFileSync(pj, 'utf8')); j.version = s.version; fs.writeFileSync(pj, JSON.stringify(j)); }
  for (const n of s.extraHooks || []) fs.writeFileSync(path.join(root, 'hooks', n), '');
  for (const n of s.removeHooks || []) fs.rmSync(path.join(root, 'hooks', n), { recursive: true, force: true });
  for (const n of s.skillDirs || []) fs.mkdirSync(path.join(root, 'skills', n), { recursive: true });
  for (const n of s.skillFiles || []) fs.writeFileSync(path.join(root, 'skills', n), '');
  for (const [n, t] of Object.entries(s.skillLinks || {})) fs.symlinkSync(t, path.join(root, 'skills', n));
  if (s.kbInstalled !== undefined) { fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); fs.writeFileSync(path.join(root, 'docs', 'KB.md'), s.kbInstalled); }
  if (s.kbInstalledDir) fs.mkdirSync(path.join(root, 'docs', 'KB.md'), { recursive: true });
  if (s.kbRepo !== undefined) { fs.mkdirSync(path.join(top, 'docs'), { recursive: true }); fs.writeFileSync(path.join(top, 'docs', 'KB.md'), s.kbRepo); }
  pluginRoot.cache.set(key, root);
  return root;
}

// ---- the runner ----------------------------------------------------------------------------------------------------------
async function runParity(o) {
  const ENGINE = path.resolve(o.engine), REPO = path.resolve(o.repo);
  const tmp = fs.mkdtempSync(path.join(o.tmpdir || os.tmpdir(), `ah-par-${o.name}-`));
  fs.writeFileSync(path.join(tmp, 'spy.js'), SPY);
  const stats = { scenarios: 0, same: 0, sameOut: 0, sameState: 0, deferExplained: 0, deferUnexplained: 0, unneeded: 0, mismatch: 0, nodeOut: 0, nodeState: 0, spawned: 0 };
  const mism = [], unexplained = [];
  const basePath = process.env.PATH;
  let counter = 0;
  const scenarios = o.scenarios;
  // plugin roots are built up front (serial), so scenarios only read them
  for (const sc of scenarios) sc._root = pluginRoot(tmp, REPO, sc.plugin);
  await pool(scenarios, o.conc || 6, async sc => {
    const n = counter++;
    const base = path.join(tmp, 'sc' + n);
    const vars = { now0: Date.now(), HOME: path.join(base, 'home'), PROJ: path.join(base, 'proj'), BASE: base, PLUGIN: sc._root, TODAY: new Date().toISOString().slice(0, 10) };
    const build = () => {
      fs.mkdirSync(vars.HOME, { recursive: true });
      if (!sc.bare) fs.mkdirSync(path.join(vars.HOME, '.anti-hall'), { recursive: true });
      buildTree(base, sc.files, vars);
      for (const g of sc.git || []) { fs.mkdirSync(path.join(base, g), { recursive: true }); cp.execFileSync('git', ['init', '-q', path.join(base, g)], { stdio: 'ignore' }); }
      for (const [rel, text] of Object.entries(sc.afterGit || {})) { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, expand(text, vars)); }
    };
    const payloadText = sc.raw !== undefined ? expand(sc.raw, vars) : JSON.stringify(Object.assign({ hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: vars.PROJ }, sc.payload || {}), (k, v) => typeof v === 'string' ? expand(v, vars) : v);
    const env = Object.assign({ PATH: basePath, HOME: vars.HOME, USERPROFILE: vars.HOME, ANTIHALL_TEST_ISOLATION: '1' }, sc.env || {});
    for (const [k, v] of Object.entries(env)) if (v === null) delete env[k]; else env[k] = expand(v, vars);
    const fixtureText = JSON.stringify([sc.files, sc.afterGit, sc.payload, sc.raw]) + payloadText;
    const norm = normalizer(vars, fixtureText);
    stats.scenarios++;
    // 1. Node
    build();
    const initTree = snapshot(base);
    const spyLog = path.join(tmp, `spy${n}.log`);
    const nodeRes = await run(process.execPath, ['-r', path.join(tmp, 'spy.js'), path.join(sc._root, 'hooks', HOOKS[sc.hook])], payloadText, Object.assign({}, env, { ANTIHALL_SPY_LOG: spyLog }), '/tmp');
    const spawned = fs.existsSync(spyLog) ? fs.readFileSync(spyLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    const nodeTree = snapshot(base);
    fs.rmSync(base, { recursive: true, force: true });
    // 2. the engine, on a fresh copy of the same fixture
    build();
    const engRes = await run(ENGINE, ['check', sc.hook], payloadText, Object.assign({}, env, { AH_ENGINE_PLUGIN_ROOT: sc._root }), '/tmp');
    const engTree = snapshot(base);
    fs.rmSync(base, { recursive: true, force: true });
    if (nodeRes.out) stats.nodeOut++;
    if (spawned.length) stats.spawned++;
    const nodeChanged = diffTrees(initTree, nodeTree, norm).length > 0;
    if (nodeChanged) stats.nodeState++;
    if (engRes.out.trim() === 'AHFALLBACK') {
      const touched = diffTrees(initTree, engTree, norm);
      if (touched.length) { stats.mismatch++; mism.push({ id: sc.id, hook: sc.hook, problems: ['the engine deferred AND changed state: ' + touched.join(' ; ')], payload: payloadText.slice(0, 300) }); return; }
      if (spawned.length || sc.expectDefer) stats.deferExplained++;
      else {
        stats.deferUnexplained++;
        if (!nodeRes.out && !nodeChanged) stats.unneeded++;
        unexplained.push(sc.id);
      }
      return;
    }
    if (o.verbose) console.log(`  ${sc.id}: node=${JSON.stringify(nodeRes.out).slice(0, 300)} engine=${JSON.stringify(engRes.out).slice(0, 300)}`);
    const problems = [];
    if (String(nodeRes.code) !== String(engRes.code)) problems.push(`exit node=${nodeRes.code} engine=${engRes.code}`);
    if (nodeRes.out !== engRes.out) problems.push(`stdout node=${JSON.stringify(nodeRes.out).slice(0, 400)} engine=${JSON.stringify(engRes.out).slice(0, 400)}`);
    if (spawned.length) problems.push(`node started a background process (${spawned.join('; ').slice(0, 200)}) but the engine decided`);
    problems.push(...diffTrees(nodeTree, engTree, norm));
    if (problems.length) { stats.mismatch++; mism.push({ id: sc.id, hook: sc.hook, problems, payload: payloadText.slice(0, 300) }); }
    else { stats.same++; if (nodeRes.out) stats.sameOut++; if (nodeChanged) stats.sameState++; }
  });
  console.log(`${o.name}: scenarios=${stats.scenarios} same=${stats.same} (with advisory: ${stats.sameOut}, with state change: ${stats.sameState}) deferred(explained)=${stats.deferExplained} deferred(unexplained)=${stats.deferUnexplained} (node silent&unchanged: ${stats.unneeded}) MISMATCH=${stats.mismatch}`);
  console.log(`  node: with-output=${stats.nodeOut} state-changed=${stats.nodeState} started-a-probe=${stats.spawned}`);
  if (unexplained.length) console.log('  unexplained deferrals: ' + unexplained.slice(0, 40).join(' | '));
  for (const m of mism.slice(0, o.show === undefined ? 25 : o.show)) console.log(JSON.stringify(m));
  fs.writeFileSync(o.out || path.join(tmp, 'mismatches.json'), JSON.stringify(mism, null, 1));
  if (!o.keep) fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = stats.mismatch ? 1 : 0;
  return stats;
}

module.exports = { runParity, HOOKS };
