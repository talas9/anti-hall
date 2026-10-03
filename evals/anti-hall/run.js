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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const ARMS = {
  'anti-hall': { plugin: path.join(REPO, 'plugins', 'anti-hall'), ablation: 'with-without' },
  'block-all': { plugin: path.join(HERE, 'stub-block-all'), ablation: 'none' },
};
const MODEL = 'claude-sonnet-5';
const JUDGE = 'claude-haiku-4-5';

function parseArgs(argv) {
  const dd = argv.indexOf('--');
  const own = dd === -1 ? argv : argv.slice(0, dd);
  const extra = dd === -1 ? [] : argv.slice(dd + 1);
  const opt = { keep: false, label: 'run', extra, tools: ['Bash', 'Write', 'Edit'] };
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--arm') opt.arm = own[++i];
    else if (a === '--max-cost-usd') opt.maxCost = own[++i];
    else if (a === '--label') opt.label = own[++i];
    else if (a === '--keep') opt.keep = true;
    else if (a === '--cases') opt.cases = own[++i].split(',').filter(Boolean);
    else if (a === '--tools') opt.tools = own[++i].split(',').filter(Boolean);
    else throw new Error(`unknown option ${a}`);
  }
  if (!ARMS[opt.arm]) throw new Error(`--arm must be one of ${Object.keys(ARMS).join(', ')}`);
  if (!(Number(opt.maxCost) > 0)) throw new Error('--max-cost-usd <usd> is required');
  if (!/^[\w.-]+$/.test(opt.label)) throw new Error('--label must be [A-Za-z0-9_.-]');
  if (extra.includes('--ablation') || extra.includes('--max-cost-usd')) throw new Error('set ablation via --arm and cost via --max-cost-usd before --');
  return opt;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const arm = ARMS[opt.arm];
  const casesDir = path.join(HERE, 'cases');
  if (!fs.existsSync(casesDir)) throw new Error('no cases/ — run build-cases.js first');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-bench-run-'));
  const pluginCopy = path.join(tmp, path.basename(arm.plugin));
  fs.cpSync(arm.plugin, pluginCopy, { recursive: true });
  if (fs.existsSync(path.join(pluginCopy, 'evals'))) throw new Error('plugin copy already has evals/');
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
  const wanted = opt.cases ? new Set(opt.cases) : null;
  if (wanted) for (const n of wanted) if (!manifest.cases.some((c) => c.name === n)) throw new Error(`unknown case ${n}`);
  for (const c of manifest.cases) {
    if (wanted && !wanted.has(c.name)) continue;
    fs.cpSync(path.join(casesDir, c.category, c.name), path.join(pluginCopy, 'evals', c.category, c.name), { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(HERE, 'results', `${opt.label}-${opt.arm}-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'manifest.json'), path.join(outDir, 'manifest.json'));
  const args = ['plugin', 'eval', pluginCopy,
    '--trust-plugin', '--scaffold', '--no-publish',
    '--model', MODEL, '--judge-model', JUDGE,
    '--ablation', arm.ablation, '--max-cost-usd', String(opt.maxCost),
    '--output-dir', outDir,
    ...opt.extra,
    '--allow-tools', ...opt.tools];
  fs.writeFileSync(path.join(outDir, 'command.json'), JSON.stringify({ arm: opt.arm, tools: opt.tools, args: ['claude', ...args] }, null, 2) + '\n');
  console.error(`[run] arm=${opt.arm} out=${path.relative(REPO, outDir)}`);
  const r = spawnSync('claude', args, { stdio: 'inherit' });
  if (opt.keep) console.error(`[run] kept ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(r.status == null ? 1 : r.status);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`run.js: ${e.message}`); process.exit(1); }
}
module.exports = { parseArgs };
