#!/usr/bin/env node
// Parity of the built-in `coordinator-work-guard` check against hooks/coordinator-work-guard.js (PreToolUse and
// PostToolUse, Bash). The engine decides only what the payload proves (not Bash, no session id, subagent marker);
// everything else must defer, because the window needs the command classifier and the hook environment. So the
// result to look for is: MISMATCH=0 (whenever the engine answers, Node answered the same), and a defer rate that is
// the share of main-thread calls.
//   node run-coordinator-work-guard.js --engine ../target/release/ah-engine --hooks <repo>/plugins/anti-hall/hooks
//        [--cmds fpr/cmds.jsonl] [--mode oneshot|daemon|both] [--main 1200] [--sub 5000] [--seed 1]
// Corpus: (1) hand-written payload shapes under several CLAUDE_CODE_ENTRYPOINT values, (2) real commands from the field
// data with their real subagent flag, (3) fuzzed markers and session ids. A real main-thread command runs the full
// Node classifier, so those rows are capped.
const { arg, runParity, readCmds, rng } = require('./guardlib.js');
const ENGINE = arg('--engine', '../target/release/ah-engine'), HOOKS = arg('--hooks');
const R = rng(+arg('--seed', 1));
const pick = a => a[Math.floor(R() * a.length)];
const scenarios = [];
const mk = (event, cmd, extra) => Object.assign({ hook_event_name: event, tool_name: 'Bash', session_id: 's1', cwd: '/tmp', tool_input: { command: cmd } }, extra || {});
const both = (cmd, extra) => [{ payload: mk('PreToolUse', cmd, extra) }, { payload: mk('PostToolUse', cmd, extra) }];
const add = (steps, ctx, id) => scenarios.push({ id: id || `s${scenarios.length}`, ctx, steps });
const ENTRY = { unset: undefined, cli: 'cli', agent_tool: 'agent_tool', vscode: 'vscode', weird: 'x' };
const ctxs = {};
for (const [k, v] of Object.entries(ENTRY)) ctxs[k] = { env: v === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: v } };
ctxs.cliOff = { env: { CLAUDE_CODE_ENTRYPOINT: 'cli', ANTIHALL_COMMAND_GUARD: '0' } };
ctxs.cliWindow0 = { env: { CLAUDE_CODE_ENTRYPOINT: 'cli', ANTIHALL_COORDINATOR_WORK_WINDOW_MINUTES: '0' } };
ctxs.cliSkip = { env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, skip: { 'command-guard': Date.now() + 3600e3 } };

// ---- (1) hand-written ----------------------------------------------------------------------------------------
const SHAPES = {
  main: {}, agentId: { agent_id: 'a1' }, agentType: { agent_type: 'Explore' }, both: { agent_id: 'a1', agent_type: 'x' }, emptyId: { agent_id: '' }, zeroId: { agent_id: 0 }, nullId: { agent_id: null }, falseType: { agent_type: false },
  numId: { agent_id: 7 }, objId: { agent_id: {} }, arrId: { agent_id: [] }, emptyIdTypeSet: { agent_id: '', agent_type: 't' },
  codex: { turn_id: 't', model: 'gpt-5.5' }, codexSub: { turn_id: 't', model: 'gpt-5.5', agent_id: 'a', agent_type: 'worker' }, codexEmptyId: { turn_id: 't', model: 'gpt-5.5', agent_id: '' }, codexNullId: { turn_id: 't', model: 'gpt-5.5', agent_id: null },
  codexZeroType: { turn_id: 't', model: 'gpt-5.5', agent_type: 0 }, codexNoModel: { turn_id: 't', agent_id: '' }, codexEmptyTurn: { turn_id: '', model: 'm', agent_id: '' }, codexNumTurn: { turn_id: 5, model: 'm', agent_id: '' },
  noSid: { session_id: undefined }, blankSid: { session_id: '  ' }, numSid: { session_id: 5 }, otherTool: { tool_name: 'Edit' }, noTool: { tool_name: undefined }, patchTool: { tool_name: 'apply_patch' },
};
for (const [ek, ctx] of Object.entries(ctxs)) for (const [sk, extra] of Object.entries(SHAPES)) for (const cmd of ['git status', 'git commit -am x', 'node build.js && npm test']) add(both(cmd, extra), ctx, `shape-${ek}-${sk}-${cmd.slice(0, 8)}`);
add([{ payload: [1] }], ctxs.cli, 'shape-array'); add([{ payload: null }], ctxs.cli, 'shape-null'); add([{ payload: 'x' }], ctxs.cli, 'shape-string');

// ---- (2) real commands -------------------------------------------------------------------------------------
const cmds = readCmds(arg('--cmds', '../../fpr/cmds.jsonl'));
const subs = cmds.filter(c => c.sub), mains = cmds.filter(c => !c.sub);
for (let i = 0; i < +arg('--sub', 5000); i++) { const c = pick(subs); add(both(c.cmd, { session_id: c.session, cwd: c.cwd || '/tmp', agent_id: c.agentId, agent_type: pick(['general-purpose', 'Explore', 'worker']) }), ctxs[pick(['cli', 'unset', 'agent_tool'])], `real-sub-${i}`); }
for (let i = 0; i < +arg('--main', 1200); i++) { const c = pick(mains); add(both(c.cmd, { session_id: c.session, cwd: '/tmp' }), ctxs[pick(['cli', 'unset', 'agent_tool', 'vscode', 'cliOff'])], `real-main-${i}`); }
// ---- (3) fuzz ---------------------------------------------------------------------------------------------
const VALS = ['', 0, 1, false, true, null, 'a', [], {}, [0], { a: 1 }, 'a b', '0', 'false'];
for (let i = 0; i < 1500; i++) {
  const extra = {};
  for (const k of ['agent_id', 'agent_type', 'turn_id', 'model', 'session_id']) if (R() < 0.5) extra[k] = pick(VALS);
  add(both(pick(['ls', 'git push', 'echo x']), extra), ctxs[pick(Object.keys(ctxs))], `fuzz-${i}`);
}
console.error(`scenarios=${scenarios.length}`);
runParity({ name: 'coordinator-work-guard', check: 'coordinator-work-guard', hookFile: 'coordinator-work-guard.js', scenarios, engine: ENGINE, hooks: HOOKS, mode: arg('--mode', 'both'), conc: +arg('--conc', 8), show: +arg('--show', 15), tools: ['*'], nodeArgv: s => (s.payload && s.payload.hook_event_name === 'PostToolUse' ? ['--post'] : []) });
