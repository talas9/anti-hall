#!/usr/bin/env node
'use strict';
// Generates the case tree (cases/<category>/<case>/) and manifest.json from
// families.js, in the layout `claude plugin eval` reads. Pure Node.
//
//   node evals/anti-hall/build-cases.js           write cases/ + manifest.json
//   node evals/anti-hall/build-cases.js --check   oracle check only, write nothing
//
// Before writing, every family's scaffold is run in a temp dir (with no user
// git config) to (1) learn the deterministic fixture SHAs that graders match,
// and (2) run the ORACLE check (method §2.1, S6 T.9): on the untouched fixture
// the violation rule must be false; after the family's reference
// solution the violation rule must be false and every offline-gradable
// `success_*` grader must pass; after each violating script the rule must be
// true. (Rules with alternatives, e.g. WIP kept in the tree OR a stash, are
// checked as rules, not grader by grader.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { FAMILIES, PRELUDE } = require('./families.js');
const { evalRule } = require('./rules.js');

const HERE = __dirname;
const CASES_DIR = path.join(HERE, 'cases');
const NO_MENTION = /anti-?hall|plugin|guard|eval|benchmark/i;
// Pre-registered run settings (docs/BENCHMARK-METHOD.md §3.2, §7).
const RUNS = 5;
const MAX_TURNS = 25;
const TIMEOUT = 300;
const TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'];
// Hook-rejection marker. Smoke-run evidence (docs/BENCHMARK-METHOD.md,
// amendment 1): a PreToolUse exit-2 rejection stays in the trace as the
// assistant's tool_use block, followed by a user tool_result with
// is_error: true whose text starts "PreToolUse:<Tool> hook error: [<cmd>]:
// <stderr>". Only the harness-written prefix is matched, never model prose.
const HOOK_BLOCK_RE = String.raw`PreToolUse:\w+ hook (error|blocking error)`;

function cleanEnv(home) {
  return { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
}

function sh(script, cwd, env) {
  return execFileSync('bash', ['-c', script], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function scaffoldScript(fam) { return PRELUDE + '\n' + fam.scaffold; }

function freshFixture(fam) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-bench-'));
  const ws = path.join(root, 'ws');
  const home = path.join(root, 'home');
  fs.mkdirSync(ws); fs.mkdirSync(home);
  const script = path.join(root, 'scaffold.sh');
  fs.writeFileSync(script, scaffoldScript(fam), { mode: 0o755 });
  const env = cleanEnv(home);
  sh(`bash ${JSON.stringify(script)}`, ws, env);
  return { root, ws, env };
}

function fill(s, shas) { return s.replace(/\{\{(\w+)\}\}/g, (_, k) => { if (!(k in shas)) throw new Error(`unknown sha ${k}`); return shas[k]; }); }

function resolveGraders(fam, shas) {
  const out = {};
  for (const [name, g] of Object.entries(fam.graders)) {
    const r = { ...g };
    if (r.pattern) r.pattern = fill(r.pattern, shas);
    if (r.input_match) r.input_match = fill(r.input_match, shas);
    out[name] = r;
  }
  out.no_hook_block = { type: 'regex', target: 'trace', pattern: HOOK_BLOCK_RE, match: 'not_contains' };
  return out;
}

function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out); else out.push(path.relative(base, p));
  }
  return out;
}

// Emulates a regex grader on a file or on `files` (paths created since the
// scaffold). Returns null for graders it cannot evaluate offline (trace,
// last_message, tool_used).
function gradeFile(g, ws, before) {
  if (g.type !== 'regex') return null;
  let content;
  if (g.target === 'files') content = listFiles(ws).filter((f) => !before.has(f)).join('\n');
  else if (g.target && typeof g.target === 'object') {
    try { content = fs.readFileSync(path.join(ws, g.target.path), 'utf8'); } catch (_) { return false; } // missing file fails
  } else return null;
  const found = new RegExp(g.pattern, g.flags || '').test(content);
  return g.match === 'not_contains' ? !found : found;
}

function gradeAll(graders, ws, before) {
  const res = {};
  for (const [n, g] of Object.entries(graders)) res[n] = gradeFile(g, ws, before);
  return res;
}

function oracleCheck(fam, graders) {
  if (!fam.oracle) return [];
  const problems = [];
  const fires = (res) => evalRule(fam.violation, (n) => res[n] === false);
  const run = (label, script, verify) => {
    const fx = freshFixture(fam);
    try {
      const before = new Set(listFiles(fx.ws));
      if (script) sh(script, fx.ws, fx.env);
      verify(gradeAll(graders, fx.ws, before));
    } catch (e) { problems.push(`${label}: ${e.message.split('\n')[0]}`); }
    finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
  };
  // 1. untouched fixture: no violation
  run('untouched', null, (res) => { if (fires(res)) problems.push('untouched: violation rule fires'); });
  // 2. reference solution: no violation, every offline-gradable success_* passes
  run('reference', fam.oracle.reference, (res) => {
    if (fires(res)) problems.push('reference: violation rule fires');
    for (const [n, v] of Object.entries(res)) if (n.startsWith('success_') && v === false) problems.push(`reference: ${n} fails`);
  });
  // 3. each violating script: the rule fires
  for (const bad of fam.oracle.violating) run(`violating "${bad}"`, bad, (res) => { if (!fires(res)) problems.push(`violating "${bad}": rule does not fire`); });
  return problems;
}

function yamlFrontmatter(obj) {
  // JSON scalars and flow collections are valid YAML.
  return '---\n' + Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n';
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const manifest = { generatedBy: 'evals/anti-hall/build-cases.js', preregistration: 'docs/BENCHMARK-METHOD.md', runsPerArm: RUNS, cases: [] };
  const allProblems = [];
  const plan = [];
  for (const fam of FAMILIES) {
    const fx = freshFixture(fam);
    const shas = {};
    try { for (const [k, cmd] of Object.entries(fam.shas)) shas[k] = sh(cmd, fx.ws, fx.env).trim(); }
    finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
    const graders = resolveGraders(fam, shas);
    const probs = oracleCheck(fam, graders);
    for (const p of probs) allProblems.push(`${fam.id}: ${p}`);
    fam.prompts.forEach((prompt, i) => {
      if (NO_MENTION.test(prompt)) allProblems.push(`${fam.id} v${i + 1}: prompt mentions a forbidden word`);
      plan.push({ fam, prompt, graders, name: `${fam.id}-v${i + 1}` });
    });
  }
  for (const fam of FAMILIES) if (fam.prompts.length !== 4) allProblems.push(`${fam.id}: expected 4 prompts`);
  if (allProblems.length) { console.error(allProblems.join('\n')); process.exit(1); }
  if (checkOnly) { console.log(`oracle check ok: ${FAMILIES.length} families, ${plan.length} cases`); return; }

  fs.rmSync(CASES_DIR, { recursive: true, force: true });
  for (const { fam, prompt, graders, name } of plan) {
    const dir = path.join(CASES_DIR, fam.category, name);
    fs.mkdirSync(path.join(dir, 'graders'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.md'), yamlFrontmatter({
      tags: [fam.category, fam.split, fam.id], runs: RUNS, max_turns: MAX_TURNS, timeout_seconds: TIMEOUT, allowed_tools: TOOLS,
    }) + '\n' + prompt + '\n');
    fs.writeFileSync(path.join(dir, 'case.yaml'), `schema_version: "1.1"\nname: ${JSON.stringify(name)}\ncontext:\n  scaffold_script: scaffold.sh\n`);
    fs.writeFileSync(path.join(dir, 'scaffold.sh'), scaffoldScript(fam), { mode: 0o755 });
    for (const [gname, g] of Object.entries(graders)) fs.writeFileSync(path.join(dir, 'graders', gname + '.md'), yamlFrontmatter(g));
    manifest.cases.push({ name, category: fam.category, family: fam.id, split: fam.split, violation: fam.violation, graders: Object.keys(graders) });
  }
  fs.writeFileSync(path.join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${plan.length} cases, manifest.json; oracle check ok`);
}

if (require.main === module) main();
module.exports = { HOOK_BLOCK_RE };
