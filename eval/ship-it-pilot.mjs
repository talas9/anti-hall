#!/usr/bin/env node
// anti-hall :: SHIP-IT dispositional A/B pilot
//
// Tests whether an agent GIVEN the ship-it SKILL.md exhibits ship-it's target
// PLANNING behaviors vs a naive baseline, on the SAME 6 tasks across S/M/L tiers.
//
// HONEST SCOPE: dispositional. `claude -p --tools ""` cannot enter plan mode,
// run a Workflow swarm, or invoke the live deadly-loop; subagents are depth-1.
// We score what the agent STATES it would do (plan/approach), NOT live edits.
// This tests ship-it's DISPOSITION (tier-scaling + mechanics in the stated plan),
// not the swarm mechanism (separately proven). Small n, single judge.
//
//   ARM-BASELINE : naive "helpful coding assistant; plan then implement" prompt.
//   ARM-SHIPIT   : naive prompt + the ship-it SKILL.md BODY (read live from disk).
//
// Each task asks for the agent's plan/approach (build is NOT performed).
//
// Scoring: ONE blind LLM-judge claude -p per response (judge NOT told the arm),
// returning the 5 ship-it target behaviors as 0/1 plus a detected tier:
//   1 tier_sizing       : classified S/M/L (or scaled rigor) AND avoided heavy
//                         ceremony (plan-mode/swarm/deadly-loop) on a SMALL task.
//   2 plan_as_artifact  : concrete plan w/ phases+files, NO TBD/etc placeholders.
//   3 harden_before     : said it would harden/review the plan before/after build
//                         (deadly-loop / pre-code review).
//   4 verify_guard      : fresh-evidence verification AND (for test-bearing tasks)
//                         a vacuous-test guard (confirm test fails before passes).
//   5 planmode_swarm_L  : on LARGE tasks invoked plan-mode + parallel/swarm; on
//                         SMALL tasks correctly did NOT. (tier-appropriate.)
//
// Backend: `claude -p` on subscription via clean plugin-free HOME (no API key;
// OAuth keychain). Max 3 concurrent. Every call bounded by a timeout.
//
// ENV:
//   SI_HOME    clean plugin-free authed HOME (required)
//   SI_MODEL   model under test + judge (default: haiku)
//   SI_OUT     raw results path (default: eval/results-ship-it.json)
//   SI_TIMEOUT per-call ms (default 90000)
//   SI_CONC    max concurrent claude -p (default 3)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'plugins', 'anti-hall', 'skills', 'ship-it', 'SKILL.md');
const TASKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'ship-it-tasks.json'), 'utf8'));

const CLEAN_HOME = process.env.SI_HOME;
if (!CLEAN_HOME) { console.error('SI_HOME required (clean plugin-free authed HOME)'); process.exit(2); }
const MODEL = process.env.SI_MODEL || 'haiku';
const OUT = process.env.SI_OUT || path.join(__dirname, 'results-ship-it.json');
const TIMEOUT = parseInt(process.env.SI_TIMEOUT || '90000', 10);
const CONC = parseInt(process.env.SI_CONC || '3', 10);

const BASELINE_SYSTEM =
  'You are a helpful coding assistant. When given a task, first plan your ' +
  'approach, then implement it. Be practical and concise.';

// Read the ship-it SKILL.md body live (strip YAML frontmatter), inject as system.
function getSkillBody() {
  const src = fs.readFileSync(SKILL, 'utf8');
  const body = src.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  if (!body.includes('Size the change') || !body.includes('deadly-loop')) {
    console.error('FATAL: ship-it SKILL.md body extraction looks wrong'); process.exit(1);
  }
  return body;
}
const SKILL_BODY = getSkillBody();
const SHIPIT_SYSTEM = BASELINE_SYSTEM + '\n\n--- WORKFLOW SKILL (follow this) ---\n\n' + SKILL_BODY;

function claude({ system, user }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', MODEL, '--output-format', 'json',
      '--system-prompt', system, '--tools', ''];
    const childEnv = { ...process.env, HOME: CLEAN_HOME };
    delete childEnv.ANTHROPIC_API_KEY; // force OAuth keychain path (empty key => 401)
    const child = execFile('claude', args, {
      encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024, env: childEnv
    }, (err, stdout) => {
      let out = stdout;
      if (err && (!out || !out.trim())) return reject(new Error('claude failed: ' + (err && err.message)));
      try {
        const j = JSON.parse(String(out).trim());
        if (j.is_error) return reject(new Error('claude is_error: ' + JSON.stringify(j.result).slice(0, 160)));
        resolve(typeof j.result === 'string' ? j.result : JSON.stringify(j));
      } catch (e) { reject(new Error('parse fail: ' + String(e.message))); }
    });
    child.stdin.write(user); child.stdin.end();
  });
}

const JUDGE_SYSTEM = `You are a strict, neutral grader scoring a software-planning response against a fixed rubric.
You are NOT told which experimental arm produced it; do not speculate about that.
You are given a coding TASK (which states roughly how many files it touches and its risk) and the assistant's PLAN/APPROACH response.

Score these SIX fields. Output ONLY valid JSON, no prose, no fences:
{
 "detected_tier": "S"|"M"|"L",        // YOUR read of how big this task actually is: S=1 file/trivial, M=2-5 files/some design, L=>5 files OR any hard-risk trigger (auth, schema/migration, production data, CI, cross-repo, security)
 "tier_sizing": 0|1,                  // 1 if the response scaled its rigor to task size: it either explicitly classified the size OR matched effort to it, AND did NOT pile heavy ceremony (formal plan-mode gate / parallel swarm / multi-agent review loop) onto a clearly SMALL one-file task. 0 if it over-processed a tiny task or under-processed a large risky one.
 "plan_as_artifact": 1|0,             // 1 if there is a concrete plan with phases/steps and specific files/functions named, with NO unfilled placeholders ("TBD", "handle edge cases", "etc.", "similar to above", "and so on"). 0 if vague or placeholder-laden.
 "harden_before": 1|0,                // 1 if it says it would review/harden/critique the plan or the change before and/or after building (e.g. a review pass, an adversarial/critic review, a deadly-loop, "harden before code"). 0 if no such review step.
 "verify_guard": 1|0,                 // 1 if it commits to verifying with FRESH command output/evidence (run it, read output, check exit code) AND, for tasks that involve tests, mentions confirming a test actually fails before it passes / that tests exercise the change (anti-vacuous-test). For non-test tasks, fresh-evidence verification alone suffices. 0 otherwise.
 "planmode_swarm_L": 1|0              // tier-APPROPRIATE parallelism: 1 if (this is a LARGE/risky task AND the response invokes plan-mode AND parallel/swarm/multi-agent execution) OR (this is a SMALL/medium task AND the response CORRECTLY does NOT invoke a swarm). 0 if a large task lacks plan-mode+swarm, or a small task wrongly invokes a swarm.
}
Judge only what the response actually says. Be strict: absence = 0.`;

function buildJudgeUser(task, resp) {
  return 'TASK (expected size hint for your reference only — judge independently): ' +
    task.prompt + '\n\nASSISTANT PLAN/APPROACH RESPONSE:\n"""\n' + resp.slice(0, 9000) + '\n"""\n\nScore it.';
}

// Pull the first balanced {...} object out of arbitrary model text (handles
// ```json fences, leading notices, and trailing prose after the JSON).
function extractJson(text) {
  const s = text.indexOf('{');
  if (s < 0) throw new Error('no JSON object in judge text: ' + text.slice(0, 120));
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(s, i + 1); }
  }
  throw new Error('unbalanced JSON in judge text: ' + text.slice(0, 120));
}

async function judge(task, resp) {
  const text = await claude({ system: JUDGE_SYSTEM, user: buildJudgeUser(task, resp) });
  const p = JSON.parse(extractJson(text));
  for (const k of ['tier_sizing', 'plan_as_artifact', 'harden_before', 'verify_guard', 'planmode_swarm_L']) {
    if (p[k] !== 0 && p[k] !== 1) throw new Error('bad judge field ' + k + ': ' + cleaned.slice(0, 120));
  }
  return p;
}

const arms = [
  { name: 'baseline', system: BASELINE_SYSTEM },
  { name: 'shipit', system: SHIPIT_SYSTEM }
];

const BEHAVIORS = ['tier_sizing', 'plan_as_artifact', 'harden_before', 'verify_guard', 'planmode_swarm_L'];

// Build the full job list (answer+judge are sequential within a job; jobs run with bounded concurrency).
const jobs = [];
for (const task of TASKS) for (const arm of arms) jobs.push({ task, arm });

const records = [];
let errors = 0;
console.error('ship-it pilot | model=' + MODEL + ' | tasks=' + TASKS.length +
  ' | arms=2 | calls=' + (TASKS.length * 2 * 2) + ' (answer+judge) | conc=' + CONC);
console.error('SKILL body chars: ' + SKILL_BODY.length);

async function runJob({ task, arm }) {
  const rec = { task_id: task.id, expected_tier: task.expected_tier, arm: arm.name, prompt: task.prompt };
  try {
    const resp = await claude({ system: arm.system, user: task.prompt });
    rec.response = resp;
    const g = await judge(task, resp);
    rec.detected_tier = g.detected_tier;
    for (const b of BEHAVIORS) rec[b] = g[b];
    process.stderr.write('OK   ' + arm.name.padEnd(9) + ' ' + task.id.padEnd(22) +
      ' tier=' + String(g.detected_tier).padEnd(2) + ' ' +
      BEHAVIORS.map(b => b[0] + (g[b] ? '1' : '0')).join(' ') + '\n');
  } catch (e) {
    rec.error = String(e && e.message || e); errors++;
    process.stderr.write('ERR  ' + arm.name.padEnd(9) + ' ' + task.id + ' :: ' + rec.error + '\n');
  }
  records.push(rec);
}

// bounded-concurrency pool
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

await pool(jobs, CONC, runJob);

// Aggregate per-behavior x/N per arm
function tally(arm, behavior) {
  const rows = records.filter(r => r.arm === arm && (r[behavior] === 0 || r[behavior] === 1));
  const yes = rows.filter(r => r[behavior] === 1).length;
  return { yes, n: rows.length };
}

const summary = { model: MODEL, tasks: TASKS.length, errors, behaviors: {} };
for (const b of BEHAVIORS) {
  const base = tally('baseline', b), ship = tally('shipit', b);
  summary.behaviors[b] = {
    baseline: base, shipit: ship,
    delta: (base.n && ship.n) ? (ship.yes / ship.n - base.yes / base.n) : null
  };
}

// Tier-classification accuracy (did detected tier match expected) per arm
function tierAcc(arm) {
  const rows = records.filter(r => r.arm === arm && r.detected_tier);
  const hit = rows.filter(r => r.detected_tier === r.expected_tier).length;
  return { hit, n: rows.length };
}
summary.tier_match = { baseline: tierAcc('baseline'), shipit: tierAcc('shipit') };

fs.writeFileSync(OUT, JSON.stringify({ summary, records }, null, 2), 'utf8');

console.log('\n=============== SHIP-IT DISPOSITIONAL PILOT RESULTS ===============');
console.log('model: ' + MODEL + '   tasks: ' + TASKS.length + '   errors: ' + errors);
console.log('\nPer-behavior  BASELINE  ->  SHIPIT   (delta)');
for (const b of BEHAVIORS) {
  const s = summary.behaviors[b];
  const d = s.delta === null ? 'n/a' : ((s.delta >= 0 ? '+' : '') + (s.delta * 6).toFixed(0) + '/6');
  console.log('  ' + b.padEnd(18) + s.baseline.yes + '/' + s.baseline.n +
    '  ->  ' + s.shipit.yes + '/' + s.shipit.n + '   (' + d + ')');
}
console.log('\ntier match (detected==expected): baseline ' +
  summary.tier_match.baseline.hit + '/' + summary.tier_match.baseline.n +
  '  shipit ' + summary.tier_match.shipit.hit + '/' + summary.tier_match.shipit.n);
console.log('\nraw: ' + OUT);
console.log('==================================================================');
