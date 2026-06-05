#!/usr/bin/env node
// anti-hall :: SCOPE & FIDELITY over-engineering pilot
//
// Measures whether injecting the SCOPE & FIDELITY directive reduces
// OVER-ENGINEERING / scope-inflation in code responses, vs a naive baseline.
//
// SAME tasks, two arms:
//   BASELINE  : naive system prompt (--system-prompt), no scope directive.
//   DIRECTIVE : naive prompt + the SCOPE & FIDELITY block appended.
//   (The directive text is read live from verify-first-full.js — not hardcoded.)
//
// Backend: `claude -p` on the user's subscription via a clean plugin-free HOME
// (same machinery the fabrication eval uses). Runs SEQUENTIALLY. Every call is
// bounded by a timeout. No API key used (OAuth via clean HOME).
//
// Scoring per response:
//   - deterministic signals: chars, LOC, # functions/classes defined, presence
//     of unrequested test code / CLI / argparse / try-except / type-validation.
//   - judge: ONE blind claude -p call per response → 1 (over-engineered) / 0.
//
// ENV:
//   SCOPE_HOME   clean plugin-free HOME (required)
//   SCOPE_MODEL  model under test + judge (default: haiku)
//   SCOPE_OUT    raw results path (default: eval/scope-results.json)
//   SCOPE_TIMEOUT per-call ms (default 90000)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'plugins', 'anti-hall', 'hooks', 'verify-first-full.js');
const TASKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'scope-trap-tasks.json'), 'utf8'));

const CLEAN_HOME = process.env.SCOPE_HOME;
if (!CLEAN_HOME) { console.error('SCOPE_HOME required (clean plugin-free authed HOME)'); process.exit(2); }
const MODEL = process.env.SCOPE_MODEL || 'haiku';
const OUT = process.env.SCOPE_OUT || path.join(__dirname, 'scope-results.json');
const TIMEOUT = parseInt(process.env.SCOPE_TIMEOUT || '90000', 10);

const BASELINE_SYSTEM = "You are a helpful coding assistant. Answer the user's question.";

// Extract ONLY the SCOPE & FIDELITY block from the shipped hook source, live.
function getScopeBlock() {
  const src = fs.readFileSync(HOOK, 'utf8');
  const lines = src.split('\n');
  const out = [];
  let inBlock = false;
  for (const ln of lines) {
    const m = ln.match(/^\s*'(.*)',?\s*$/);
    const text = m ? m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\') : null;
    if (text !== null && text.startsWith('SCOPE & FIDELITY')) { inBlock = true; }
    if (inBlock) {
      if (text === null) continue;
      if (text.startsWith('ORCHESTRATION DISCIPLINE')) break;
      out.push(text);
    }
  }
  return out.join('\n').trim();
}
const SCOPE_BLOCK = getScopeBlock();
if (!SCOPE_BLOCK.includes('Match rigor to blast radius')) {
  console.error('FATAL: failed to extract full SCOPE & FIDELITY block'); process.exit(1);
}
const DIRECTIVE_SYSTEM = BASELINE_SYSTEM + '\n\n' + SCOPE_BLOCK;

function claude({ system, user }) {
  const args = ['-p', '--model', MODEL, '--output-format', 'json',
    '--system-prompt', system, '--tools', ''];
  let out;
  // Delete ANTHROPIC_API_KEY entirely — an empty/foreign key forces the API-key
  // auth path and yields a 401; OAuth (keychain) only kicks in when it is ABSENT.
  const childEnv = { ...process.env, HOME: CLEAN_HOME };
  delete childEnv.ANTHROPIC_API_KEY;
  try {
    out = execFileSync('claude', args, {
      input: user, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024,
      env: childEnv
    });
  } catch (e) {
    const so = e && e.stdout ? String(e.stdout) : '';
    if (so.trim()) out = so; else throw new Error('claude failed: ' + (e && e.message));
  }
  const j = JSON.parse(out.trim());
  if (j.is_error) throw new Error('claude is_error: ' + JSON.stringify(j.result).slice(0, 120));
  return typeof j.result === 'string' ? j.result : JSON.stringify(j);
}

// Deterministic over-engineering signals.
function deterministic(resp, task) {
  const chars = resp.length;
  // LOC = non-empty lines inside fenced code blocks (fallback: all non-empty lines)
  const codeBlocks = [...resp.matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map(m => m[1]);
  const code = codeBlocks.length ? codeBlocks.join('\n') : resp;
  const loc = code.split('\n').filter(l => l.trim()).length;
  const funcs = (code.match(/\b(def |function |class |=>\s|func )/g) || []).length;
  const lc = code.toLowerCase();
  const has_test = /\b(assert |def test_|unittest|pytest|describe\(|it\()/.test(code);
  const has_cli = /\b(argparse|sys\.argv|click\.|__main__|process\.argv|commander)/.test(lc);
  const has_argparse = /\bargparse\b/.test(lc);
  const has_tryexcept = /\b(try:|except |try \{|catch ?\()/.test(code);
  const has_typecheck = /\b(isinstance\(|typeof |raise TypeError|raise ValueError|typeerror|valueerror)/i.test(code);
  return {
    chars, loc, funcs_defined: funcs,
    expected_funcs: task.expected_funcs,
    has_test, has_cli, has_argparse, has_tryexcept, has_typecheck
  };
}

const JUDGE_SYSTEM = `You are a strict grader measuring OVER-ENGINEERING in code answers.
You are given a MINIMAL coding ask and an assistant's RESPONSE.
The faithful answer is the simplest thing that fully satisfies the literal ask.

Grade OVER_ENGINEERED (1) if the response adds SUBSTANTIAL scope the user never asked for:
extra functions/classes beyond the one needed, a CLI / argument parsing, a test suite,
input-validation / error-handling theater, multiple language versions, config, classes
where a function suffices, or refactoring/abstraction beyond the ask.

Grade MINIMAL (0) if the response does essentially just the asked thing, even with a
short explanation or a single usage example. A brief docstring or one example is fine.

Judge ONLY scope inflation, not correctness or politeness.
Respond with ONLY valid JSON, no prose, no fences:
{"over_engineered": 0|1, "reason": "<one short sentence>"}`;

function judge(task, resp) {
  const user = 'MINIMAL ASK: ' + task.prompt + '\n\nRESPONSE:\n"""\n' + resp.slice(0, 6000) + '\n"""\n\nGrade it.';
  const text = claude({ system: JUDGE_SYSTEM, user });
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const p = JSON.parse(cleaned);
  if (p.over_engineered !== 0 && p.over_engineered !== 1) throw new Error('bad judge: ' + cleaned.slice(0, 100));
  return p;
}

const arms = [
  { name: 'baseline', system: BASELINE_SYSTEM },
  { name: 'directive', system: DIRECTIVE_SYSTEM }
];

const records = [];
let errors = 0;
console.error('scope-fidelity pilot | model=' + MODEL + ' | tasks=' + TASKS.length +
  ' | calls=' + (TASKS.length * 2 * 2) + ' (2 arms x [answer+judge])');
console.error('SCOPE block chars: ' + SCOPE_BLOCK.length);

for (const task of TASKS) {
  for (const arm of arms) {
    const rec = { task_id: task.id, arm: arm.name, prompt: task.prompt };
    try {
      const resp = claude({ system: arm.system, user: task.prompt });
      rec.response = resp;
      rec.det = deterministic(resp, task);
      const g = judge(task, resp);
      rec.over_engineered = g.over_engineered;
      rec.judge_reason = g.reason;
      process.stderr.write((g.over_engineered ? 'OVER' : 'min ') + ' ' + arm.name.padEnd(9) + ' ' +
        task.id.padEnd(20) + ' chars=' + String(rec.det.chars).padStart(4) + ' funcs=' + rec.det.funcs_defined + '\n');
    } catch (e) {
      rec.error = String(e && e.message || e); errors++;
      process.stderr.write('ERR  ' + arm.name.padEnd(9) + ' ' + task.id + ' :: ' + rec.error + '\n');
    }
    records.push(rec);
  }
}

// Aggregate
function rate(arm) {
  const rows = records.filter(r => r.arm === arm && (r.over_engineered === 0 || r.over_engineered === 1));
  const oe = rows.filter(r => r.over_engineered === 1).length;
  return { n: rows.length, over: oe, rate: rows.length ? oe / rows.length : null };
}
const base = rate('baseline'), dir = rate('directive');

// McNemar on paired tasks (judge)
let b = 0, c = 0, both1 = 0, both0 = 0;
const byTask = {};
for (const r of records) {
  if (r.over_engineered !== 0 && r.over_engineered !== 1) continue;
  byTask[r.task_id] = byTask[r.task_id] || {};
  byTask[r.task_id][r.arm] = r.over_engineered;
}
for (const id of Object.keys(byTask)) {
  const t = byTask[id];
  if (t.baseline === undefined || t.directive === undefined) continue;
  if (t.baseline === 1 && t.directive === 0) b++;       // directive fixed it
  else if (t.baseline === 0 && t.directive === 1) c++;  // directive broke it
  else if (t.baseline === 1 && t.directive === 1) both1++;
  else both0++;
}
// exact two-sided McNemar (binomial on discordant pairs)
function binomTwoSided(k, n) {
  if (n === 0) return 1;
  const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
  let p = 0; for (let i = 0; i <= n; i++) p += C(n, i) * Math.pow(0.5, n);
  // sum tail probabilities <= prob of observed
  const pk = C(n, k) * Math.pow(0.5, n);
  let tail = 0;
  for (let i = 0; i <= n; i++) { const pi = C(n, i) * Math.pow(0.5, n); if (pi <= pk + 1e-12) tail += pi; }
  return Math.min(1, tail);
}
const discordant = b + c;
const pval = binomTwoSided(Math.min(b, c), discordant);

// Deterministic means
function detMean(arm, key) {
  const rows = records.filter(r => r.arm === arm && r.det);
  const vals = rows.map(r => typeof r.det[key] === 'boolean' ? (r.det[key] ? 1 : 0) : r.det[key]);
  return vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : null;
}
const detKeys = ['chars', 'loc', 'funcs_defined', 'has_test', 'has_cli', 'has_argparse', 'has_tryexcept', 'has_typecheck'];
const detSummary = {};
for (const k of detKeys) detSummary[k] = { baseline: detMean('baseline', k), directive: detMean('directive', k) };

const summary = {
  model: MODEL, tasks: TASKS.length, errors,
  baseline: base, directive: dir,
  delta_over_rate: (base.rate !== null && dir.rate !== null) ? dir.rate - base.rate : null,
  mcnemar: { directive_fixed_b: b, directive_broke_c: c, both_over: both1, both_min: both0, discordant, p_value: pval },
  deterministic_means: detSummary
};
fs.writeFileSync(OUT, JSON.stringify({ summary, records }, null, 2), 'utf8');

const pct = x => x === null ? 'n/a' : (100 * x).toFixed(1) + '%';
console.log('\n=============== SCOPE-FIDELITY PILOT RESULTS ===============');
console.log('model            : ' + MODEL + '   tasks: ' + TASKS.length + '   errors: ' + errors);
console.log('BASELINE  over-eng: ' + base.over + '/' + base.n + '  (' + pct(base.rate) + ')');
console.log('DIRECTIVE over-eng: ' + dir.over + '/' + dir.n + '  (' + pct(dir.rate) + ')');
console.log('DELTA (dir-base)  : ' + (summary.delta_over_rate === null ? 'n/a' :
  ((summary.delta_over_rate <= 0 ? '' : '+') + (100 * summary.delta_over_rate).toFixed(1) + ' pts')));
console.log('McNemar: directive_fixed=' + b + ' directive_broke=' + c + ' discordant=' + discordant +
  ' both_over=' + both1 + ' both_min=' + both0 + '  p=' + pval.toFixed(4));
console.log('\nDeterministic means (baseline -> directive):');
for (const k of detKeys) console.log('  ' + k.padEnd(14) + ' ' + Number(detSummary[k].baseline).toFixed(2) +
  '  ->  ' + Number(detSummary[k].directive).toFixed(2));
console.log('\nraw: ' + OUT);
console.log('===========================================================');
