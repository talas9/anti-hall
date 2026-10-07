#!/usr/bin/env node
// Parity of the built-in `dispatch-tier` check against hooks/dispatch-tier.js (PostToolUse on TaskCreate|TaskUpdate).
//   node run-dispatch-tier.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks [--fuzz 120]
// While the Jev dispatchTier integration is off the Node hook does nothing, so the engine must do nothing too: compared on
// exit code, stdout, stderr and the whole file tree. While it is on or in shadow the Node hook asks Jev detached and writes
// state; the engine must defer there (never answer for it), and only that deferral is checked.
const { arg, rng, runFx } = require('./hookfx.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const post = (tool, input, extra) => Object.assign({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, session_id: 's1', cwd: '$PROJ', transcript_path: '$HOME/t.jsonl' }, extra || {});
const add = (id, payload, world, more) => scenarios.push(Object.assign({ id, world, steps: [{ payload }] }, more || {}));
const T = [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'TaskCreate', input: { subject: 'first task', description: 'do it' } }] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Task #1 created successfully: first task' }] } })].join('\n');
const W = { files: { 'home/t.jsonl': T }, gitdirs: ['proj'] };
const JEV_ON = { files: Object.assign({}, W.files, { 'home/.anti-hall/settings.json': JSON.stringify({ jev: { enabled: true } }) }), gitdirs: ['proj'] };
const INPUTS = [{ subject: 'write tests', description: 'cover it' }, { subject: '' }, {}, { title: 't' }, { content: 'c' }, { description: 'only' }, { subject: 'x', metadata: { blockedOn: 'owner' } }, { subject: 'OWNER: decide' },
  { taskId: '1', subject: 'renamed' }, { taskId: 1, description: 'new desc' }, { id: '1', subject: 'x' }, { taskId: '9', status: 'completed' }, { taskId: '1' }, null, 'str', 5, [1]];
for (const tool of ['TaskCreate', 'TaskUpdate']) for (const [i, inp] of INPUTS.entries()) add(`off-${tool}-${i}`, post(tool, inp), W);
for (const tool of ['Bash', 'Task', 'TaskGet', 'TaskList', 'taskcreate', 'TaskCreate ', '', null, 5, 'Agent']) add(`off-tool-${JSON.stringify(tool)}`, post(tool, { subject: 's' }), W);
add('off-no-transcript', post('TaskUpdate', { taskId: '1', subject: 'x' }, { transcript_path: undefined }), W);
add('off-missing-transcript', post('TaskUpdate', { taskId: '1', subject: 'x' }, { transcript_path: '$HOME/none.jsonl' }), W);
add('off-bad-cwd', post('TaskCreate', { subject: 'x' }, { cwd: 5 }), W);
add('off-no-session', post('TaskCreate', { subject: 'x' }, { session_id: undefined }), W);
add('off-not-object', [1], W); add('off-null-payload', null, W);
scenarios.push({ id: 'off-raw-garbage', world: W, steps: [{ raw: 'not json' }] });
// switches that keep it off
for (const [id, settings] of [['file-enabled-false', { jev: { enabled: false } }], ['file-integration-off', { jev: { enabled: true }, jevIntegrations: { dispatchTier: 'off' } }], ['file-integration-bad', { jev: { enabled: 'maybe' } }]])
  add(`switch-${id}`, post('TaskCreate', { subject: 'x' }), { files: { 'home/.anti-hall/settings.json': JSON.stringify(settings) } });
add('switch-legacy-jev-json-off', post('TaskCreate', { subject: 'x' }), { files: { 'home/.anti-hall/jev.json': JSON.stringify({ enabled: true, integrations: { dispatchTier: 'off' } }) } });
add('switch-garbage-settings', post('TaskCreate', { subject: 'x' }), { files: { 'home/.anti-hall/settings.json': '{nope' } });
scenarios.push({ id: 'switch-env-off', world: JEV_ON, steps: [{ payload: post('TaskCreate', { subject: 'x' }), env: { ANTIHALL_JEV: '0' } }] });
scenarios.push({ id: 'switch-env-integration-off', world: JEV_ON, steps: [{ payload: post('TaskCreate', { subject: 'x' }), env: { ANTIHALL_JEV_DISPATCH_TIER: '0' } }] });
scenarios.push({ id: 'switch-option-off', world: JEV_ON, steps: [{ payload: post('TaskCreate', { subject: 'x' }), env: { CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DISPATCH_TIER: 'off' } }] });
// on / shadow: the engine must defer
for (const tool of ['TaskCreate', 'TaskUpdate']) for (const [i, inp] of INPUTS.slice(0, 9).entries()) add(`on-${tool}-${i}`, post(tool, inp), JEV_ON, { expectDefer: true });
scenarios.push({ id: 'on-env', world: W, expectDefer: true, steps: [{ payload: post('TaskCreate', { subject: 'x' }), env: { ANTIHALL_JEV: '1' } }] });
scenarios.push({ id: 'on-shadow', world: JEV_ON, expectDefer: true, steps: [{ payload: post('TaskCreate', { subject: 'x' }), env: { ANTIHALL_JEV_DISPATCH_TIER: 'shadow' } }] });
add('on-file-shadow', post('TaskCreate', { subject: 'x' }), { files: { 'home/.anti-hall/settings.json': JSON.stringify({ jev: { enabled: true }, jevIntegrations: { dispatchTier: 'shadow' } }) } }, { expectDefer: true });
// fuzz (off)
const VALS = ['', 'x', 'owner', 5, null, true, [], {}, 'é', 'x'.repeat(2000)];
for (let i = 0; i < +arg('--fuzz', 120); i++) add(`fuzz-${i}`, post(pick(['TaskCreate', 'TaskUpdate', 'Bash']), { subject: pick(VALS), description: pick(VALS), taskId: pick(VALS), metadata: pick([undefined, { blockedOn: pick(VALS) }, 5]) }, { session_id: pick(VALS), cwd: pick(['$PROJ', 5, '']) }), pick([W, {}]));
console.error(`scenarios=${scenarios.length}`);
runFx({ name: 'dispatch-tier', hookFile: 'dispatch-tier.js', check: 'dispatch-tier', engine: ENGINE, hooks: HOOKS, scenarios, conc: +arg('--conc', 6), mayDefer: sc => sc.id === 'off-raw-garbage' });
