#!/usr/bin/env node
// anti-hall :: RULE-BEHAVIOR dispositional pilot
//
// Measures whether injecting each of 3 anti-hall ORCHESTRATION rules changes the
// model's STATED behavior in a planted one-shot scenario.
//
//   BASELINE arm  : naive coordinator system prompt, NO rule.
//   TREATMENT arm : same naive prompt + the single rule's text (extracted LIVE
//                   from plugins/anti-hall/hooks/verify-first-full.js).
//
// 3 rules tested:
//   verify_delegated  (rule L) — independently re-verify a subagent's report
//   background_default(rule F) — dispatch heavy work to the BACKGROUND/async
//   history_discipline(rule B) — log completed fix (cause+fix) to a ledger
//
// This is a DISPOSITIONAL / STATED-INTENT proxy: `claude -p --tools ""` has no
// real subagents/backgrounding/ledger, so we measure what the model SAYS it
// would do, NOT live tool-use. Expect weak/underpowered signal (small n).
//
// Backend: `claude -p` on subscription via clean plugin-free HOME (no API key;
// OAuth keychain). SEQUENTIAL. Every call bounded by a timeout.
//
// Scoring: ONE blind LLM-judge claude -p per response (judge NOT told the arm),
// strict per-rule rubric -> 1 (did the correct/rule behavior) / 0.
//
// ENV:
//   RB_HOME    clean plugin-free authed HOME (required)
//   RB_MODEL   model under test + judge (default: haiku)
//   RB_OUT     raw results path (default: eval/results-rule-behavior.json)
//   RB_TIMEOUT per-call ms (default 90000)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'plugins', 'anti-hall', 'hooks', 'verify-first-full.js');
const TASKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'rule-behavior-tasks.json'), 'utf8'));

const CLEAN_HOME = process.env.RB_HOME;
if (!CLEAN_HOME) { console.error('RB_HOME required (clean plugin-free authed HOME)'); process.exit(2); }
const MODEL = process.env.RB_MODEL || 'haiku';
const OUT = process.env.RB_OUT || path.join(__dirname, 'results-rule-behavior.json');
const TIMEOUT = parseInt(process.env.RB_TIMEOUT || '90000', 10);

// Naive coordinator baseline — establishes the "you orchestrate subagents" frame
// for ALL arms so the scenarios make sense, WITHOUT stating any of the 3 rules.
const BASELINE_SYSTEM =
  'You are a coding assistant that coordinates work, sometimes by delegating to ' +
  'subagents and running commands. Answer the user\'s question directly and concisely, ' +
  'describing exactly what you would do next.';

// Extract a single ORCHESTRATION rule line (e.g. "  L. ...") from the shipped hook,
// live. Lines are single-quoted JS string literals; unescape \' and \\.
function getRuleLine(letter) {
  const src = fs.readFileSync(HOOK, 'utf8');
  for (const ln of src.split('\n')) {
    const m = ln.match(/^\s*'(.*)',?\s*$/);
    if (!m) continue;
    const text = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    if (new RegExp('^\\s*' + letter + '\\.\\s').test(text)) return text.trim();
  }
  throw new Error('rule line ' + letter + ' not found in hook');
}

// Map each rule -> its source line letter + a sanity substring to confirm extraction.
const RULES = {
  verify_delegated:   { letter: 'L', must: 'VERIFY DELEGATED WORK' },
  background_default: { letter: 'F', must: 'run_in_background' },
  history_discipline: { letter: 'B', must: '.anti-hall-history.md' }
};
for (const k of Object.keys(RULES)) {
  RULES[k].text = getRuleLine(RULES[k].letter);
  if (!RULES[k].text.includes(RULES[k].must)) {
    console.error('FATAL: rule ' + k + ' (line ' + RULES[k].letter + ') missing marker "' + RULES[k].must + '"');
    process.exit(1);
  }
}

// Blind judge rubrics — judge is given ONLY the scenario + response, never the arm.
const JUDGE = {
  verify_delegated: `You grade whether an assistant said it would INDEPENDENTLY RE-VERIFY a subagent's self-reported completion before accepting it.
Score DID_VERIFY (1) if the response says it will independently re-run the authoritative check / re-test / dispatch a separate verifier / inspect the real result / confirm against ground truth before marking done.
Score ACCEPTED (0) if it accepts the subagent's report as done, just marks it complete, or moves on without an independent check.`,
  background_default: `You grade whether an assistant said it would run heavy/long/parallel work in the BACKGROUND / asynchronously / off the main thread (so the user is not blocked).
Score BACKGROUNDED (1) if the response says it will background the work, run it async / detached / in parallel subagents off the main thread, or otherwise NOT block the conversation while it runs.
Score INLINE (0) if it would run the work inline/foreground/synchronously, blocking until done, or does not address keeping the main thread free.`,
  history_discipline: `You grade whether an assistant said it would LOG the just-completed fix (its cause and fix) to a persistent history/ledger/record before moving on.
Score LOGGED (1) if the response says it will record/append the completed work — with the cause and the fix — to a persistent ledger, history file, changelog, or notes for later.
Score MOVED_ON (0) if it just moves to the next task, only reports to the user verbally, or does not persist a record of the cause+fix.`
};

function claude({ system, user }) {
  const args = ['-p', '--model', MODEL, '--output-format', 'json',
    '--system-prompt', system, '--tools', ''];
  let out;
  const childEnv = { ...process.env, HOME: CLEAN_HOME };
  delete childEnv.ANTHROPIC_API_KEY; // OAuth path only when key is ABSENT
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

function judge(rule, task, resp) {
  const system = JUDGE[rule] + `
Judge ONLY the stated intent in the response. Ignore politeness and verbosity.
Respond with ONLY valid JSON, no prose, no fences:
{"correct": 0|1, "reason": "<one short sentence>"}`;
  const user = 'SCENARIO:\n' + task.prompt + '\n\nASSISTANT RESPONSE:\n"""\n' +
    resp.slice(0, 6000) + '\n"""\n\nGrade it.';
  const text = claude({ system, user });
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const p = JSON.parse(cleaned);
  if (p.correct !== 0 && p.correct !== 1) throw new Error('bad judge: ' + cleaned.slice(0, 100));
  return p;
}

const records = [];
let errors = 0, calls = 0;
const totalAnswer = Object.values(TASKS).reduce((a, t) => a + t.length, 0) * 2;
console.error('rule-behavior pilot | model=' + MODEL +
  ' | answer-calls=' + totalAnswer + ' | +judge => ' + (totalAnswer * 2) + ' total claude -p');
for (const k of Object.keys(RULES)) console.error('  rule ' + k + ' (line ' + RULES[k].letter + '): ' + RULES[k].text.length + ' chars');

for (const rule of Object.keys(TASKS)) {
  const treatmentSystem = BASELINE_SYSTEM + '\n\nFOLLOW THIS RULE:\n' + RULES[rule].text;
  const arms = [
    { name: 'baseline', system: BASELINE_SYSTEM },
    { name: 'treatment', system: treatmentSystem }
  ];
  for (const task of TASKS[rule]) {
    for (const arm of arms) {
      const rec = { rule, task_id: task.id, arm: arm.name, prompt: task.prompt };
      try {
        const resp = claude({ system: arm.system, user: task.prompt }); calls++;
        rec.response = resp;
        const g = judge(rule, task, resp); calls++;
        rec.correct = g.correct;
        rec.judge_reason = g.reason;
        process.stderr.write((g.correct ? 'YES ' : 'no  ') + arm.name.padEnd(10) + ' ' +
          rule.padEnd(18) + ' ' + task.id.padEnd(18) + '\n');
      } catch (e) {
        rec.error = String(e && e.message || e); errors++;
        process.stderr.write('ERR  ' + arm.name.padEnd(10) + ' ' + task.id + ' :: ' + rec.error + '\n');
      }
      records.push(rec);
    }
  }
}

// exact two-sided McNemar (binomial on discordant pairs)
function binomTwoSided(k, n) {
  if (n === 0) return 1;
  const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
  const pk = C(n, k) * Math.pow(0.5, n);
  let tail = 0;
  for (let i = 0; i <= n; i++) { const pi = C(n, i) * Math.pow(0.5, n); if (pi <= pk + 1e-12) tail += pi; }
  return Math.min(1, tail);
}

function analyzeRule(rule) {
  const rows = records.filter(r => r.rule === rule && (r.correct === 0 || r.correct === 1));
  const arm = name => rows.filter(r => r.arm === name);
  const rate = name => { const a = arm(name); const c = a.filter(r => r.correct === 1).length; return { n: a.length, correct: c, rate: a.length ? c / a.length : null }; };
  const base = rate('baseline'), treat = rate('treatment');
  // paired McNemar by task_id
  const byTask = {};
  for (const r of rows) { byTask[r.task_id] = byTask[r.task_id] || {}; byTask[r.task_id][r.arm] = r.correct; }
  let b = 0, c = 0, both1 = 0, both0 = 0;
  for (const id of Object.keys(byTask)) {
    const t = byTask[id];
    if (t.baseline === undefined || t.treatment === undefined) continue;
    if (t.baseline === 0 && t.treatment === 1) b++;       // rule turned it ON
    else if (t.baseline === 1 && t.treatment === 0) c++;  // rule turned it OFF
    else if (t.baseline === 1 && t.treatment === 1) both1++;
    else both0++;
  }
  const discordant = b + c;
  const pval = binomTwoSided(Math.min(b, c), discordant);
  return {
    baseline: base, treatment: treat,
    delta_rate: (base.rate !== null && treat.rate !== null) ? treat.rate - base.rate : null,
    mcnemar: { rule_turned_on_b: b, rule_turned_off_c: c, both_yes: both1, both_no: both0, discordant, p_value: pval }
  };
}

const summary = { model: MODEL, errors, calls, rules: {} };
for (const rule of Object.keys(TASKS)) summary.rules[rule] = analyzeRule(rule);
fs.writeFileSync(OUT, JSON.stringify({ summary, rule_texts: RULES, records }, null, 2), 'utf8');

const pct = x => x === null ? 'n/a' : (100 * x).toFixed(1) + '%';
console.log('\n=============== RULE-BEHAVIOR PILOT RESULTS ===============');
console.log('model: ' + MODEL + '   errors: ' + errors + '   claude -p calls: ' + calls);
console.log('(DISPOSITIONAL / stated-intent proxy — NOT live tool-use)\n');
for (const rule of Object.keys(TASKS)) {
  const a = summary.rules[rule];
  console.log('RULE: ' + rule);
  console.log('  BASELINE  correct: ' + a.baseline.correct + '/' + a.baseline.n + '  (' + pct(a.baseline.rate) + ')');
  console.log('  TREATMENT correct: ' + a.treatment.correct + '/' + a.treatment.n + '  (' + pct(a.treatment.rate) + ')');
  console.log('  DELTA            : ' + (a.delta_rate === null ? 'n/a' :
    ((a.delta_rate < 0 ? '' : '+') + (100 * a.delta_rate).toFixed(1) + ' pts')));
  console.log('  McNemar: rule_on=' + a.mcnemar.rule_turned_on_b + ' rule_off=' + a.mcnemar.rule_turned_off_c +
    ' discordant=' + a.mcnemar.discordant + ' both_yes=' + a.mcnemar.both_yes + ' both_no=' + a.mcnemar.both_no +
    '  p=' + a.mcnemar.p_value.toFixed(4));
  console.log('');
}
console.log('raw: ' + OUT);
console.log('==========================================================');
