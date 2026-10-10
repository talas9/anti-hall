#!/usr/bin/env node
'use strict';
// inference-bench.js — offline precision/recall for catching confident,
// unsupported inferences (a cause stated as fact with no hedge word and no tool
// evidence). Corpus: tools/eval/inference-cases.json (84 synthetic labelled cases,
// fixed dev/test split, written before the detector).
//
//   node tools/eval/inference-bench.js                 # deterministic detector, in-process
//   node tools/eval/inference-bench.js --hook          # the real speculation-guard hook, end to end
//   node tools/eval/inference-bench.js --codex         # detector on Codex rollout-shaped transcripts
//   node tools/eval/inference-bench.js --judge-cli     # LIVE: speculation-judge via `claude -p` (uses your
//                                                #   Claude subscription, ~5 s per case)
//   --json                                       # machine-readable summary
//
// Positive = "should be flagged". Precision = TP / (TP + FP); recall = TP / (TP + FN).
// The detector is default-on only while its precision on this corpus stays >= 0.9
// (asserted in tests/hooks/inference-check.test.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOKS = path.join(ROOT, 'plugins', 'anti-hall', 'hooks');
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'inference-cases.json'), 'utf8')).cases;

// ---- transcript builders -------------------------------------------------
function claudeTurn(turn, idBase) {
  const out = [{ type: 'user', message: { role: 'user', content: turn.prompt } }];
  (turn.tools || []).forEach((t, i) => {
    const id = 'toolu_' + idBase + '_' + i;
    out.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: t.name, input: t.input }] } });
    out.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: t.output }] } });
  });
  out.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: turn.reply }] } });
  return out;
}

function codexTurn(turn, idBase) {
  const out = [{ type: 'event_msg', payload: { type: 'user_message', message: turn.prompt } }];
  (turn.tools || []).forEach((t, i) => {
    const call_id = 'call_' + idBase + '_' + i;
    const cmd = t.input && (t.input.command || (t.input.file_path ? 'cat ' + t.input.file_path : JSON.stringify(t.input)));
    out.push({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id, arguments: JSON.stringify({ cmd }) } });
    out.push({ type: 'response_item', payload: { type: 'function_call_output', call_id, output: t.output } });
  });
  out.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.reply }] } });
  return out;
}

function transcriptLines(c, shape) {
  const build = shape === 'codex' ? codexTurn : claudeTurn;
  const lines = [];
  (c.prior || []).forEach((t, i) => lines.push(...build(t, c.id + 'p' + i)));
  lines.push(...build(c, c.id));
  return lines.map((o) => JSON.stringify(o));
}

// ---- scorers ---------------------------------------------------------------
function detectorFlags(c, shape) {
  const { findUnsupportedClaim } = require(path.join(HOOKS, 'lib', 'inference-check.js'));
  const { maskQuotedText } = require(path.join(HOOKS, 'lib', 'quote-mask.js'));
  return !!findUnsupportedClaim(maskQuotedText(c.reply), transcriptLines(c, shape), c.reply);
}

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-infbench-'));
  try { fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true }); return fn(home); }
  finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
}

function hookFlags(c) {
  return withTempHome((home) => {
    const tp = path.join(home, 't.jsonl');
    fs.writeFileSync(tp, transcriptLines(c, 'claude').join('\n') + '\n');
    const payload = { hook_event_name: 'Stop', transcript_path: tp, session_id: 'bench-' + c.id, last_assistant_message: c.reply };
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home, ANTIHALL_JEV: '0', ANTIHALL_INFERENCE_CHECK: 'on' });
    const r = spawnSync(process.execPath, [path.join(HOOKS, 'speculation-guard.js')], { input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 30000 });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch (_) { /* allow */ }
    return !!(j && j.decision === 'block');
  });
}

// LIVE judge via the local `claude -p` CLI, in-process through lib/judge-core.js
// (no hook process, so no anti-hall state is written anywhere).
async function judgeCliFlags(c) {
  const { collectEvidence } = require(path.join(HOOKS, 'lib', 'inference-check.js'));
  const jc = require(path.join(HOOKS, 'lib', 'judge-core.js'));
  const lines = transcriptLines(c, 'claude');
  const { lastUserPrompt } = require(path.join(HOOKS, 'lib', 'inference-check.js'));
  const input = jc.buildJudgeInput(c.reply, collectEvidence(lines, { raw: true }), lastUserPrompt(lines));
  const d = await jc.runCliJudge({ input, model: process.env.ANTIHALL_JUDGE_MODEL || 'claude-haiku-4-5', timeoutMs: 60000 });
  return { flagged: !!(d && d.decision === 'block'), ran: d !== null, claim: d && d.claim };
}

function score(rows) {
  const s = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of rows) {
    if (r.label === 'pos') r.flagged ? s.tp++ : s.fn++;
    else r.flagged ? s.fp++ : s.tn++;
  }
  s.n = rows.length;
  s.precision = s.tp + s.fp ? +(s.tp / (s.tp + s.fp)).toFixed(3) : null;
  s.recall = s.tp + s.fn ? +(s.tp / (s.tp + s.fn)).toFixed(3) : null;
  return s;
}

async function run(mode) {
  const rows = [];
  if (mode === 'judge-cli') {
    // 4 calls in flight; each is a separate `claude -p` process.
    const queue = CASES.slice();
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const r = await judgeCliFlags(c);
        rows.push({ id: c.id, split: c.split, label: c.label, flagged: r.flagged, ran: r.ran });
        process.stderr.write(c.id + ' ' + (r.ran ? (r.flagged ? 'flag: ' + r.claim : 'pass') : 'NO ANSWER') + '\n');
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    rows.sort((a, b) => a.id.localeCompare(b.id));
  } else {
    for (const c of CASES) {
      let flagged;
      if (mode === 'hook') flagged = hookFlags(c);
      else if (mode === 'codex') flagged = detectorFlags(c, 'codex');
      else flagged = detectorFlags(c, 'claude');
      rows.push({ id: c.id, split: c.split, label: c.label, flagged });
    }
  }
  return {
    noAnswer: rows.filter((r) => r.ran === false).map((r) => r.id),
    mode,
    all: score(rows),
    dev: score(rows.filter((r) => r.split === 'dev')),
    test: score(rows.filter((r) => r.split === 'test')),
    falsePositives: rows.filter((r) => r.label === 'neg' && r.flagged).map((r) => r.id),
    misses: rows.filter((r) => r.label === 'pos' && !r.flagged).map((r) => r.id),
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--hook') ? 'hook' : argv.includes('--codex') ? 'codex' : argv.includes('--judge-cli') ? 'judge-cli' : 'detector';
  run(mode).then((res) => {
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    const line = (k, s) => `${k.padEnd(5)} n=${s.n}  TP=${s.tp} FP=${s.fp} FN=${s.fn} TN=${s.tn}  precision=${s.precision}  recall=${s.recall}`;
    console.log('mode: ' + res.mode);
    console.log(line('all', res.all));
    console.log(line('dev', res.dev));
    console.log(line('test', res.test));
    console.log('false positives: ' + (res.falsePositives.join(' ') || 'none'));
    console.log('misses: ' + (res.misses.join(' ') || 'none'));
    if (res.noAnswer && res.noAnswer.length) console.log('no answer (counted as pass): ' + res.noAnswer.join(' '));
  }
  });
}

module.exports = { CASES, transcriptLines, run, score };
