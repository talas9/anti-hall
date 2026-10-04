'use strict';
// Multi-turn / follow-up message driver for B4 (and the B3 seed script). The pinned
// harness runs one prompt per case, so a mid-task "oh, and also..." message is sent as a
// resumed `claude -p --resume <session>` step. Spend is checked before every step.
//
// runner(cmd, args, opts) -> { status, stdout, stderr }; stdout is stream-json (one event
// per line) with a final {type:'result', session_id, total_cost_usd, result}.
// ASSUMPTION [unverified -> probe]: each step's total_cost_usd covers that step only, so
// run cost = sum of steps. If a resumed result reports a cumulative total, the sum
// overcounts; the per-step values are kept in steps[] so the first real smoke can settle it.
const { parseTrace } = require('./trace.js');

function buildStepArgs({ model, pluginDir, sessionId, text, ceilingUsd, extra = [] }) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model];
  if (pluginDir) a.push('--plugin-dir', pluginDir);
  if (sessionId) a.push('--resume', sessionId);
  if (ceilingUsd > 0) a.push('--max-budget-usd', ceilingUsd.toFixed(4));
  a.push(...extra, text);
  return a;
}

// followUps: [{ text }] sent in order after the first prompt. Returns steps, merged events, totals.
function runConversation({ runner, prompt, followUps = [], model = 'claude-sonnet-5', pluginDir, cwd, env, cap, perStepUsd = 0, extra }) {
  const texts = [prompt, ...followUps.map((f) => (typeof f === 'string' ? f : f.text))];
  const steps = [];
  const events = [];
  let sessionId = null, total = 0, stopped = null;
  for (let i = 0; i < texts.length; i++) {
    const ceiling = cap ? cap.nextCeiling(perStepUsd) : perStepUsd;
    if (cap && ceiling == null) { stopped = `spend cap reached before step ${i + 1}`; break; }
    const r = runner('claude', buildStepArgs({ model, pluginDir, sessionId, text: texts[i], ceilingUsd: ceiling, extra }), { cwd, env });
    const ev = parseTrace(r.stdout);
    const res = ev.filter((e) => e.type === 'result').pop() || {};
    const cost = typeof res.total_cost_usd === 'number' ? res.total_cost_usd : 0;
    if (cap) cap.record(cost);
    total += cost;
    sessionId = res.session_id || sessionId;
    steps.push({ step: i + 1, status: r.status, costUsd: cost, sessionId, error: r.status === 0 ? null : (r.stderr || '').slice(0, 300) });
    events.push(...ev);
    if (r.status !== 0) { stopped = `step ${i + 1} exited ${r.status}`; break; }
  }
  const last = events.filter((e) => e.type === 'result').pop();
  return { steps, events, sessionId, totalCostUsd: total, finalMessage: last && typeof last.result === 'string' ? last.result : null, stopped, complete: !stopped && steps.length === texts.length };
}

module.exports = { runConversation, buildStepArgs };
