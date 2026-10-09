#!/usr/bin/env node
'use strict';
// Runs the benchmark suite with `claude plugin eval`. Pure Node.
//
//   node evals/anti-hall/run.js --arm anti-hall --max-cost-usd 3 [--label smoke] [--keep] -- [extra eval flags]
//   node evals/anti-hall/run.js --arm block-all --max-cost-usd 3 --cases a-v1,b-v2 -- --runs 1
// --cases copies only the named cases (the CLI's --case takes one glob).
//
// `claude plugin eval` only reads cases from an eval dir BELOW the plugin it
// loads, and the suite must stay out of the shipped plugin dir. So this script
// copies the plugin (plugins/anti-hall, or the block-all stub) to a temp dir,
// copies cases/ in as its evals/ dir, and runs the CLI against that copy.
// Results go to evals/anti-hall/results/<label>-<timestamp>/ (gitignored),
// with manifest.json copied beside aggregate-result.json for analyze.js.
//
// Pinned settings (docs/BENCHMARK-METHOD.md §7): --model claude-sonnet-5,
// --judge-model claude-haiku-4-5, --allow-tools Bash Write Edit, --scaffold,
// --no-publish, concurrency 1. --max-cost-usd is REQUIRED (spend guard).
// --tools Write,Edit (smoke/debug only) drops the Bash grant, for machines
// where the eval refuses Bash-granting runs; pre-registered runs use the default.
// The anti-hall arm runs --ablation with-without (paired no-plugin baseline);
// the block-all arm runs --ablation none (its baseline would duplicate it).
//
// Strength studies B0-B4 (docs/BENCHMARK-METHOD.md Amendment 3) add, all optional:
//   --model <id>            main model (default claude-sonnet-5)
//   --suite <name>          cases-<name>/ + manifest-<name>.json instead of cases/ + manifest.json
//   --cases-dir <dir>       cases from a dir OUTSIDE the repo (blind cases that must not be committed):
//                           <dir>/<case>/ or <dir>/<category>/<case>/; uses <dir>/manifest.json when present,
//                           else generates one (category = dir name, family = case name minus -vN,
//                           graders = graders/* basenames) and writes it beside the results
//   --plugin <dir>          plugin dir for the `with` arms (pre/post archives); default plugins/anti-hall
//   --arm-plugin n=<dir>    dir for a named arm, e.g. with@pre=/path/pre (repeatable)
//   --ablation <mode>       override the arm's ablation (none | with-without)
//   --settings <file>       copied to <plugin copy>/settings.json (only after probe P9 shows it reaches hooks)
//   --seed-files <dir>      B3: files scaffolded into each workspace for arms with files (path segment TODAY = date)
//   --arms a,b[,c]          arms for an INTERLEAVED run: one CLI call per (case, arm, rep), arm order alternating
//   --reps K                runs per case and arm (interleaved default 1; single arm default case.runs)
//   --run-reserve-usd R     per-run cost pre-check: launch a run only while spend + R <= the cap.
//                           The CLI checks its ceiling before each run, so it gets (cap - R); spend then
//                           stays <= cap + max(0, costliest run - R) (x --concurrency runs in flight).
//                           Default 0 = overshoot up to one full run per cap.
//   --max-total-usd <usd>   GLOBAL spend cap summed over every run under results/ with this label prefix
//   --dry-run               print the plan and commands, spawn nothing, spend nothing
// Arms: anti-hall, block-all (legacy), without, with, files-present-no-plugin, with-settings, with@<tag>.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveArm, interleave, firstPositionShare, ARM_DEFS } = require('./lib/arms.js');
const { SpendCap, spentUnder, sumAggregate } = require('./lib/spend.js');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const MODEL = 'claude-sonnet-5';
const JUDGE = 'claude-haiku-4-5';

function parseArgs(argv) {
  const dd = argv.indexOf('--');
  const own = dd === -1 ? argv : argv.slice(0, dd);
  const extra = dd === -1 ? [] : argv.slice(dd + 1);
  const opt = { keep: false, label: 'run', extra, tools: ['Bash', 'Write', 'Edit'], model: MODEL, armPlugins: {}, reps: null, reserve: 0, dryRun: false };
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--arm') opt.arm = own[++i];
    else if (a === '--arms') opt.arms = own[++i].split(',').filter(Boolean);
    else if (a === '--max-cost-usd') opt.maxCost = own[++i];
    else if (a === '--max-total-usd') opt.maxTotal = own[++i];
    else if (a === '--label') opt.label = own[++i];
    else if (a === '--keep') opt.keep = true;
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--cases') opt.cases = own[++i].split(',').filter(Boolean);
    else if (a === '--tools') opt.tools = own[++i].split(',').filter(Boolean);
    else if (a === '--model') opt.model = own[++i];
    else if (a === '--suite') opt.suite = own[++i];
    else if (a === '--cases-dir') opt.casesDir = path.resolve(own[++i]);
    else if (a === '--run-reserve-usd') opt.reserve = Number(own[++i]);
    else if (a === '--plugin') opt.plugin = path.resolve(own[++i]);
    else if (a === '--ablation') opt.ablation = own[++i];
    else if (a === '--settings') opt.settings = path.resolve(own[++i]);
    else if (a === '--seed-files') opt.seedFiles = path.resolve(own[++i]);
    else if (a === '--reps') opt.reps = Number(own[++i]);
    else if (a === '--arm-plugin') {
      const kv = own[++i] || '';
      const eq = kv.indexOf('=');
      if (eq < 1) throw new Error('--arm-plugin needs name=<dir>');
      opt.armPlugins[kv.slice(0, eq)] = path.resolve(kv.slice(eq + 1));
    } else throw new Error(`unknown option ${a}`);
  }
  if (opt.arms && opt.arm) throw new Error('give --arm or --arms, not both');
  const armList = opt.arms || [opt.arm];
  for (const n of armList) {
    if (!n) throw new Error(`--arm must be one of ${Object.keys(ARM_DEFS).join(', ')}, with@<tag>`);
    resolveArm(n, opt); // throws on an unknown arm or a missing --arm-plugin
  }
  if (opt.arms) {
    if (opt.arms.length < 2) throw new Error('--arms needs at least two arms');
    if (opt.ablation) throw new Error('--ablation cannot be combined with an interleaved --arms run (arms run one per call)');
    if (!(Number(opt.maxTotal) > 0)) throw new Error('--max-total-usd <usd> is required for an interleaved run');
  }
  if (!(Number(opt.maxCost) > 0)) throw new Error('--max-cost-usd <usd> is required');
  if (opt.maxTotal != null && !(Number(opt.maxTotal) > 0)) throw new Error('--max-total-usd must be > 0');
  if (!/^[\w.-]+$/.test(opt.label)) throw new Error('--label must be [A-Za-z0-9_.-]');
  if (opt.suite != null && !/^[\w-]+$/.test(opt.suite)) throw new Error('--suite must be [A-Za-z0-9_-]');
  if (opt.reps != null && !(opt.reps >= 1 && Number.isInteger(opt.reps))) throw new Error('--reps must be a positive integer');
  if (opt.suite != null && opt.casesDir) throw new Error('give --suite or --cases-dir, not both');
  if (!(opt.reserve >= 0)) throw new Error('--run-reserve-usd must be >= 0');
  if (opt.reserve >= Number(opt.maxCost)) throw new Error('--run-reserve-usd must be below --max-cost-usd');
  if (opt.ablation && !['none', 'with-without'].includes(opt.ablation)) throw new Error('--ablation must be none or with-without');
  if (extra.includes('--ablation') || extra.includes('--max-cost-usd')) throw new Error('set ablation via --arm/--ablation and cost via --max-cost-usd before --');
  if (extra.includes('--model') || extra.includes('--case') || extra.includes('--runs')) throw new Error('set model/cases/runs via --model/--cases/--reps before --');
  return opt;
}

// Manifest for a --cases-dir without one. Case dirs are found at <dir>/<case>/ or <dir>/<category>/<case>/
// (a case dir holds prompt.md). Tags from prompt.md frontmatter set split: dev-smoke -> dev, headline -> headline.
function generateManifest(dir) {
  const cases = [];
  const addCase = (caseDir, category) => {
    const name = path.basename(caseDir);
    const gdir = path.join(caseDir, 'graders');
    const graders = fs.existsSync(gdir) ? fs.readdirSync(gdir).filter((f) => !f.startsWith('.')).map((f) => f.replace(/\.[^.]+$/, '')).sort() : [];
    const fm = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(caseDir, 'prompt.md'), 'utf8'));
    const tags = (fm && /^tags:\s*(\[.*\])\s*$/m.exec(fm[1])) ? JSON.parse(/^tags:\s*(\[.*\])\s*$/m.exec(fm[1])[1]) : [];
    const split = tags.includes('dev-smoke') ? 'dev' : tags.includes('headline') ? 'headline' : null;
    cases.push({ name, category, family: name.replace(/-v\d+$/, ''), split, graders });
  };
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const d = path.join(dir, e.name);
    if (fs.existsSync(path.join(d, 'prompt.md'))) { addCase(d, path.basename(dir)); continue; }
    for (const c of fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (fs.existsSync(path.join(d, c.name, 'prompt.md'))) addCase(path.join(d, c.name), e.name);
    }
  }
  if (!cases.length) throw new Error(`--cases-dir ${dir}: no case dirs (a case dir holds prompt.md)`);
  return { generatedBy: 'evals/anti-hall/run.js --cases-dir', casesDir: dir, cases };
}

// Where a manifest case lives: <casesDir>/<category>/<name>, or flat <casesDir>/<name> (--cases-dir).
function caseSource(casesDir, c) {
  const nested = path.join(casesDir, c.category, c.name);
  return fs.existsSync(nested) ? nested : path.join(casesDir, c.name);
}

// { casesDir, manifest } for the run: --cases-dir (manifest read or generated), else the suite in the repo.
function loadCases(opt) {
  if (opt.casesDir) {
    if (!fs.existsSync(opt.casesDir)) throw new Error(`--cases-dir ${opt.casesDir} does not exist`);
    const m = path.join(opt.casesDir, 'manifest.json');
    return { casesDir: opt.casesDir, manifest: fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : generateManifest(opt.casesDir) };
  }
  const { casesDir, manifest } = suitePaths(opt.suite);
  if (!fs.existsSync(casesDir) || !fs.existsSync(manifest)) throw new Error(`no ${path.basename(casesDir)}/ or ${path.basename(manifest)}: run build-cases.js${opt.suite ? ` --suite ${opt.suite}` : ''} first`);
  return { casesDir, manifest: JSON.parse(fs.readFileSync(manifest, 'utf8')) };
}

function suitePaths(suite) {
  return suite
    ? { casesDir: path.join(HERE, `cases-${suite}`), manifest: path.join(HERE, `manifest-${suite}.json`) }
    : { casesDir: path.join(HERE, 'cases'), manifest: path.join(HERE, 'manifest.json') };
}

// Shell snippet that recreates seed files inside the scaffolded workspace (B3 handover + PRECOMPACT).
// base64 heredocs keep it self-contained; a `TODAY` path segment becomes the scaffold-time date and
// every file's mtime is touched to scaffold time (handover-resume only reads files <= 7 days old; probe P6).
function seedFilesScript(seedDir) {
  const lines = ['', '# --- seed files (benchmark arm with files) ---'];
  const walk = (d, rel = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(path.join(d, e.name), [...rel, e.name]);
      else {
        const segs = [...rel, e.name].map((x) => (x === 'TODAY' ? '$(date +%F)' : JSON.stringify(x).slice(1, -1)));
        const target = segs.join('/');
        const b64 = fs.readFileSync(path.join(d, e.name)).toString('base64');
        lines.push(`mkdir -p "$(dirname "${target}")"`, `base64 -d > "${target}" <<'AH_SEED_B64'`, b64, 'AH_SEED_B64', `touch "${target}"`);
      }
    }
  };
  walk(seedDir);
  return lines.join('\n') + '\n';
}

// Copies the arm's plugin, the wanted cases (+ seed files for arms with files) and the optional settings.
function preparePluginCopy(arm, opt, manifest, casesDir, tmp) {
  const pluginCopy = path.join(tmp, `${arm.name.replace(/[^\w.-]/g, '_')}-${path.basename(arm.pluginDir)}`);
  fs.cpSync(arm.pluginDir, pluginCopy, { recursive: true });
  if (fs.existsSync(path.join(pluginCopy, 'evals'))) throw new Error('plugin copy already has evals/');
  if (arm.settings) {
    if (!opt.settings) throw new Error(`arm ${arm.name} needs --settings <file>`);
    fs.copyFileSync(opt.settings, path.join(pluginCopy, 'settings.json'));
  }
  const wanted = opt.cases ? new Set(opt.cases) : null;
  if (wanted) for (const n of wanted) if (!manifest.cases.some((c) => c.name === n)) throw new Error(`unknown case ${n}`);
  const withFiles = arm.files && opt.seedFiles;
  for (const c of manifest.cases) {
    if (wanted && !wanted.has(c.name)) continue;
    const dest = path.join(pluginCopy, 'evals', c.category, c.name);
    fs.cpSync(caseSource(casesDir, c), dest, { recursive: true });
    if (withFiles) fs.appendFileSync(path.join(dest, 'scaffold.sh'), seedFilesScript(opt.seedFiles));
  }
  return pluginCopy;
}

// One `claude plugin eval` invocation.
function buildEvalArgs({ opt, arm, pluginCopy, outDir, ceilingUsd, caseName, runs }) {
  const ablation = opt.ablation || arm.ablation;
  return ['plugin', 'eval', pluginCopy,
    '--trust-plugin', '--scaffold', '--no-publish',
    '--model', opt.model, '--judge-model', JUDGE,
    '--ablation', ablation, '--max-cost-usd', String(Number(ceilingUsd.toFixed(4))),
    '--output-dir', outDir,
    ...(caseName ? ['--case', caseName] : []),
    ...(runs ? ['--runs', String(runs)] : []),
    ...opt.extra,
    '--allow-tools', ...opt.tools];
}

function runOne({ opt, arm, tmpState, manifest, casesDir, tmp, outDir, ceilingUsd, caseName, runs, spawn }) {
  if (!tmpState.copies[arm.name]) tmpState.copies[arm.name] = opt.dryRun ? `<plugin copy: ${arm.name}>` : preparePluginCopy(arm, opt, manifest, casesDir, tmp);
  const args = buildEvalArgs({ opt, arm, pluginCopy: tmpState.copies[arm.name], outDir, ceilingUsd, caseName, runs });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'command.json'), JSON.stringify({ arm: arm.name, model: opt.model, suite: opt.suite || null, casesDir: opt.casesDir || null, reserveUsd: opt.reserve, plugin: arm.pluginDir, files: !!(arm.files && opt.seedFiles), settings: arm.settings ? opt.settings : null, ablation: opt.ablation || arm.ablation, tools: opt.tools, args: ['claude', ...args] }, null, 2) + '\n');
  if (opt.dryRun) return { status: 0, dry: true, args };
  const r = spawn('claude', args, { stdio: 'inherit' });
  if (opt.extra.includes('--keep-temp')) { try { keepRunDirs(outDir); } catch (e) { console.error(`[run] keeping temp dirs failed: ${e.message}`); } }
  return { status: r.status == null ? 1 : r.status, args };
}

// --keep-temp keeps each run's temp dir (scaffold + out/trace.jsonl) under os.tmpdir(). That dir
// dies with a --rm container, and an absolute tracePath does not resolve on another machine. So copy
// it into <outDir>/kept/ and rewrite tracePath relative to outDir (analyze.js resolves it there).
// copyFileSync per file, not fs.cpSync: cpSync fails with EACCES onto a virtiofs mount (container /work).
// Unreadable dirs are skipped: the CLI seals plugin-written home/ and tmp/ in <run>/sealed (mode 000).
function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) { fs.symlinkSync(fs.readlinkSync(src), dst); return; }
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    let entries;
    try { entries = fs.readdirSync(src); } catch (e) { if (e.code === 'EACCES') return; throw e; }
    for (const e of entries) copyTree(path.join(src, e), path.join(dst, e));
    return;
  }
  if (st.isFile()) fs.copyFileSync(src, dst);
}

function keepRunDirs(outDir, tmpRoot = os.tmpdir()) {
  const f = path.join(outDir, 'aggregate-result.json');
  let agg;
  try { agg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return 0; }
  let kept = 0;
  for (const c of agg.cases || []) for (const runs of Object.values(c.arms || {})) for (const r of runs || []) {
    if (!r || typeof r.tracePath !== 'string' || !path.isAbsolute(r.tracePath)) continue;
    const rel = path.relative(tmpRoot, r.tracePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const top = rel.split(path.sep)[0];
    const src = path.join(tmpRoot, top);
    if (!fs.existsSync(r.tracePath)) continue;
    const dst = path.join(outDir, 'kept', top);
    if (!fs.existsSync(dst)) copyTree(src, dst);
    r.tracePathOriginal = r.tracePath;
    r.tracePath = path.join('kept', rel);
    kept++;
  }
  if (kept) fs.writeFileSync(f, JSON.stringify(agg, null, 2) + '\n');
  return kept;
}

function readCost(outDir) {
  const f = path.join(outDir, 'aggregate-result.json');
  try { return sumAggregate(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (_) { return 0; }
}

// Plans and (unless --dry-run) executes the run. `spawn` is injectable for tests.
function execute(opt, { spawn = (cmd, args, o) => spawnSync(cmd, args, o), resultsRoot = path.join(HERE, 'results'), log = (m) => console.error(m) } = {}) {
  const { casesDir, manifest } = loadCases(opt);
  const names = (opt.cases || manifest.cases.map((c) => c.name));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-bench-run-'));
  const tmpState = { copies: {} };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const perBatch = Number(opt.maxCost);
  const prior = opt.maxTotal ? spentUnder(resultsRoot, `${opt.label}-`) : { total: 0, dirs: 0 };
  const cap = opt.maxTotal ? new SpendCap(Number(opt.maxTotal), prior.total) : null;
  const reserve = opt.reserve || 0;
  const summary = { jobs: 0, launched: 0, stopped: null, spentUsd: 0, outDirs: [] };
  try {
    if (!opt.arms) {
      const arm = resolveArm(opt.arm, opt);
      const ceiling = cap ? cap.nextCeiling(perBatch, reserve) : perBatch;
      if (ceiling == null) throw new Error(`global spend cap reached ($${prior.total.toFixed(2)} of $${opt.maxTotal} under label ${opt.label}-*)`);
      const outDir = path.join(resultsRoot, `${opt.label}-${opt.arm}-${stamp}`);
      log(`[run] arm=${opt.arm} out=${path.relative(REPO, outDir)}${opt.dryRun ? ' (dry-run)' : ''}`);
      // The CLI checks its ceiling before each run; (ceiling - reserve) makes that a per-run pre-check.
      const r = runOne({ opt, arm, tmpState, manifest, casesDir, tmp, outDir, ceilingUsd: ceiling - reserve, runs: opt.reps, spawn });
      summary.jobs = 1; summary.launched = opt.dryRun ? 0 : 1; summary.status = r.status; summary.args = r.args; summary.outDirs.push(outDir);
      if (!opt.dryRun) { summary.spentUsd = readCost(outDir); if (cap) cap.record(summary.spentUsd); }
      return summary;
    }
    const arms = opt.arms.map((n) => resolveArm(n, opt));
    const jobs = interleave(names, opt.arms, opt.reps || 1);
    summary.jobs = jobs.length;
    summary.firstPosition = firstPositionShare(jobs, opt.arms);
    const root = path.join(resultsRoot, `${opt.label}-interleaved-${stamp}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify({ arms: opt.arms, reps: opt.reps || 1, model: opt.model, maxTotalUsd: Number(opt.maxTotal), perBatchUsd: perBatch, jobs: jobs.map((j) => `${j.case}|${j.arm}|r${j.rep}`) }, null, 2) + '\n');
    for (const j of jobs) {
      const ceiling = cap.nextCeiling(perBatch, reserve); // each job is one run: launch only if spend + reserve fits
      if (ceiling == null) { summary.stopped = `global spend cap $${opt.maxTotal} reached after ${summary.launched} of ${jobs.length} jobs`; break; }
      const arm = arms.find((a) => a.name === j.arm);
      const outDir = path.join(root, j.arm, `${j.case}-r${j.rep}`);
      const r = runOne({ opt, arm, tmpState, manifest, casesDir, tmp, outDir, ceilingUsd: ceiling, caseName: j.case, runs: 1, spawn });
      summary.outDirs.push(outDir);
      if (opt.dryRun) continue;
      summary.launched++;
      const cost = readCost(outDir);
      cap.record(cost);
      summary.spentUsd += cost;
      if (r.status !== 0 && r.status !== 1) { summary.stopped = `claude exited ${r.status} on ${j.case}|${j.arm}|r${j.rep}`; break; } // exit 1 = score below threshold, keep going
    }
    fs.writeFileSync(path.join(root, 'spend.json'), JSON.stringify({ maxTotalUsd: Number(opt.maxTotal), priorUsd: prior.total, thisRunUsd: summary.spentUsd, launched: summary.launched, planned: jobs.length, stopped: summary.stopped }, null, 2) + '\n');
    summary.root = root;
    return summary;
  } finally {
    if (opt.keep) log(`[run] kept ${tmp}`); else fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const s = execute(opt);
  if (s.stopped) console.error(`[run] stopped: ${s.stopped}`);
  if (opt.dryRun) console.error(`[run] dry-run: ${s.jobs} job(s), nothing spawned`);
  process.exit(s.status != null ? s.status : s.stopped ? 2 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`run.js: ${e.message}`); process.exit(1); }
}
module.exports = { parseArgs, suitePaths, generateManifest, loadCases, seedFilesScript, buildEvalArgs, keepRunDirs, execute };
