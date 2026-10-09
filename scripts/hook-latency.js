#!/usr/bin/env node
'use strict';
// Hook-latency benchmark. Spawns every command registered in
// plugins/anti-hall/hooks/hooks.json the way Claude Code does (the command string
// through a shell, ${CLAUDE_PLUGIN_ROOT} expanded, node flags kept, JSON payload on
// stdin, project dir as cwd) and reports wall-clock and CPU time per hook plus the
// per-tool-call total for each event.
//
//   node scripts/hook-latency.js [-n 20] [--json] [--only name,name] [--grouped]
//
// --grouped skips the per-hook passes and, per event scenario, starts the whole
// matching hook set together (as Claude Code does) N times, reporting group wall
// and summed CPU (each hook's own getrusage, read in the same run).
//
// Wall: spawn -> close, N runs, first dropped, nearest-rank p50/p95.
// CPU: a second pass with `node --require <probe>` added, where the probe writes
// process.resourceUsage() (user+system CPU, microseconds) at exit. That is the hook
// process's own getrusage, so it needs no /usr/bin/time (whose output differs
// between macOS and GNU and rounds to 10 ms) and works on every platform Node does.
// It excludes grandchildren (a hook that shells out to git): their CPU is not
// counted. Wall is measured in its own pass so the probe never inflates it.
//
// Total per tool call: Claude Code runs all matching hooks in parallel (hooks docs:
// "All matching hooks run in parallel"), so the wall total is the slowest hook, not
// the sum. This script measures that directly (all matching hooks started together,
// N runs) and also prints max-of-hooks and sum-of-hooks, labelled. CPU adds up, so
// the CPU total is the sum.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const PLUGIN_ROOT = path.join(__dirname, '..', 'plugins', 'anti-hall');
const HOOK_TIMEOUT_MS = 10000;
const PARALLEL_SOURCE = 'Claude Code hooks docs (code.claude.com/docs/en/hooks): "All matching hooks run in parallel." docs/KB-claude-codex.md does not state it.';

function parseArgs(argv) {
  const o = { n: 20, json: false, only: null, grouped: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-n') o.n = Math.max(2, parseInt(argv[++i], 10) || 20);
    else if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--grouped') o.grouped = true;
    else if (argv[i] === '--only') o.only = new Set(String(argv[++i] || '').split(',').filter(Boolean));
  }
  return o;
}

function pct(sorted, p) { // nearest-rank
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
function stats(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? { p50: round(pct(s, 50)), p95: round(pct(s, 95)) } : null;
}
function round(x) { return Math.round(x * 100) / 100; }

// Fixture project: a git repo with a source file, HOME isolated to a temp dir.
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-latency-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), "'use strict';\nfunction parse(input) {\n  return input.trim().split(',');\n}\nmodule.exports = { parse };\n");
  const git = (...a) => cp.spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...a], { cwd: proj });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init');
  fs.appendFileSync(path.join(proj, 'src', 'app.js'), '// wip\n');
  const transcript = path.join(root, 'transcript.jsonl');
  const line = (role, text) => JSON.stringify({ type: role, message: { role, content: [{ type: 'text', text }] } });
  fs.writeFileSync(transcript, [
    line('user', 'Fix the parser so it handles empty input.'),
    line('assistant', 'I read src/app.js and changed parse() to return an empty array for empty input. The unit test now passes.'),
    line('user', 'Thanks, anything else?'),
    line('assistant', 'Done. The change is in src/app.js and verified by running the tests.'),
  ].join('\n') + '\n');
  const probe = path.join(root, 'cpu-probe.js');
  fs.writeFileSync(probe, "process.on('exit',()=>{try{const r=process.resourceUsage();require('fs').writeFileSync(process.env.HOOK_BENCH_CPU,String(r.userCPUTime+r.systemCPUTime))}catch(e){}});\n");
  return { root, home, proj, transcript, probe };
}

function scenarios(fx) {
  const base = { session_id: 'bench-session', transcript_path: fx.transcript, cwd: fx.proj, permission_mode: 'default' };
  const pre = (tool_name, tool_input) => ({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'toolu_bench' });
  const post = (tool_name, tool_input, tool_response) => ({ ...base, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, tool_use_id: 'toolu_bench' });
  const agent = { description: 'Fix parser bug', prompt: 'Read src/app.js, make parse() return [] for empty input, run the tests and report.', subagent_type: 'general-purpose', model: 'sonnet' };
  const status = { command: 'git status --short', description: 'Show working tree status' };
  const commit = { command: 'git commit -am "fix: handle empty input in parse"', description: 'Commit the fix' };
  const out = { stdout: ' M src/app.js\n', stderr: '', interrupted: false };
  return [
    { event: 'SessionStart', scenario: 'startup', tool: null, payload: { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5-5' } },
    { event: 'UserPromptSubmit', scenario: 'prompt', tool: null, payload: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the parser so it handles empty input, then run the tests.' } },
    { event: 'PreToolUse', scenario: 'Bash: git status', tool: 'Bash', payload: pre('Bash', status) },
    { event: 'PreToolUse', scenario: 'Bash: git commit', tool: 'Bash', payload: pre('Bash', commit) },
    { event: 'PreToolUse', scenario: 'Edit: src file', tool: 'Edit', payload: pre('Edit', { file_path: path.join(fx.proj, 'src', 'app.js'), old_string: 'return input.trim().split(\',\');', new_string: "return input ? input.trim().split(',') : [];" }) },
    { event: 'PreToolUse', scenario: 'Write: src file', tool: 'Write', payload: pre('Write', { file_path: path.join(fx.proj, 'src', 'util.js'), content: "'use strict';\nmodule.exports = { noop() {} };\n" }) },
    { event: 'PreToolUse', scenario: 'Agent: spawn', tool: 'Agent', payload: pre('Agent', agent) },
    { event: 'PostToolUse', scenario: 'Bash: git status', tool: 'Bash', payload: post('Bash', status, out) },
    { event: 'PostToolUse', scenario: 'Agent: spawn', tool: 'Agent', payload: post('Agent', agent, { content: [{ type: 'text', text: 'Fixed parse() and the tests pass.' }] }) },
    { event: 'Stop', scenario: 'short transcript', tool: null, payload: { ...base, hook_event_name: 'Stop', stop_hook_active: false } },
  ];
}

function hooksFor(hooksJson, sc, only) {
  const seen = new Set();
  const out = [];
  for (const group of hooksJson.hooks[sc.event] || []) {
    if (sc.tool !== null && group.matcher && group.matcher !== '*' && !new RegExp('^(?:' + group.matcher + ')$').test(sc.tool)) continue;
    for (const h of group.hooks) {
      if (h.type !== 'command' || seen.has(h.command)) continue; // Claude Code runs an identical handler once
      seen.add(h.command);
      const m = h.command.match(/hooks\/([\w.-]+?)\.js"?\s*(.*)$/);
      const name = m ? m[1] + (m[2] ? ' ' + m[2] : '') : h.command;
      if (only && !only.has(m ? m[1] : name)) continue;
      out.push({ name, command: h.command.split('${CLAUDE_PLUGIN_ROOT}').join(PLUGIN_ROOT) });
    }
  }
  return out;
}

function runOnce(command, payload, fx, cpu) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: fx.home, USERPROFILE: fx.home, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: fx.proj };
    let cmd = command;
    let cpuFile = null;
    if (cpu) {
      cpuFile = path.join(fx.root, 'cpu-' + process.hrtime.bigint());
      env.HOOK_BENCH_CPU = cpuFile;
      cmd = command.replace(/^node /, 'node --require "' + fx.probe + '" ');
    }
    const t0 = process.hrtime.bigint();
    const child = cp.spawn(cmd, { shell: true, cwd: fx.proj, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: HOOK_TIMEOUT_MS });
    child.stdout.resume(); child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.on('close', (code) => {
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      let cpuMs = null;
      if (cpuFile) { try { cpuMs = Number(fs.readFileSync(cpuFile, 'utf8')) / 1000; fs.unlinkSync(cpuFile); } catch (_) { /* probe did not run */ } }
      resolve({ wall, cpu: cpuMs, code });
    });
  });
}

async function sample(n, fn) { // n runs, first dropped
  const xs = [];
  for (let i = 0; i < n; i++) { const r = await fn(); if (i > 0) xs.push(r); }
  return xs;
}

async function bench(opts) {
  const hooksJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.registry.json'), 'utf8'));
  const fx = makeFixture();
  const meta = {
    date: new Date().toISOString(), platform: process.platform + ' ' + os.release(), cpu: os.cpus()[0].model, node: process.version,
    n: opts.n, samples_per_hook: opts.n - 1, loadavg: os.loadavg().map(round), loadavg_end: null,
    percentile: 'nearest-rank over the runs after dropping the first', parallel: PARALLEL_SOURCE,
    cpu_method: 'process.resourceUsage() of the hook process via a --require probe (excludes grandchildren)',
  };
  const hooks = []; const totals = [];
  try {
    for (const sc of scenarios(fx)) {
      const list = hooksFor(hooksJson, sc, opts.only);
      if (!list.length) continue;
      const wallSets = [];
      for (const h of list) {
        const wall = await sample(opts.n, () => runOnce(h.command, sc.payload, fx, false));
        const cpu = await sample(opts.n, () => runOnce(h.command, sc.payload, fx, true));
        const cpuVals = cpu.map((r) => r.cpu).filter((v) => v !== null);
        const w = stats(wall.map((r) => r.wall));
        wallSets.push(w);
        hooks.push({ event: sc.event, scenario: sc.scenario, hook: h.name, samples: wall.length, wall: w, cpu: cpuVals.length ? stats(cpuVals) : null, exit_codes: [...new Set(wall.map((r) => r.code))], loadavg: os.loadavg().map(round) });
      }
      const par = await sample(opts.n, async () => {
        const t0 = process.hrtime.bigint();
        await Promise.all(list.map((h) => runOnce(h.command, sc.payload, fx, false)));
        return { wall: Number(process.hrtime.bigint() - t0) / 1e6 };
      });
      const pw = stats(par.map((r) => r.wall));
      const mine = hooks.filter((r) => r.event === sc.event && r.scenario === sc.scenario);
      const cpus = mine.map((r) => r.cpu && r.cpu.p50);
      totals.push({
        event: sc.event, scenario: sc.scenario, hooks: list.length,
        wall_parallel_p50: pw.p50, wall_parallel_p95: pw.p95,
        wall_max_p50: round(Math.max(...wallSets.map((w) => w.p50))), wall_max_p95: round(Math.max(...wallSets.map((w) => w.p95))),
        wall_sum_p50: round(wallSets.reduce((a, w) => a + w.p50, 0)), wall_sum_p95: round(wallSets.reduce((a, w) => a + w.p95, 0)),
        cpu_sum_p50: cpus.every((c) => c !== null) ? round(cpus.reduce((a, c) => a + c, 0)) : null,
        loadavg: os.loadavg().map(round),
      });
    }
  } finally {
    meta.loadavg_end = os.loadavg().map(round);
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
  return { meta, hooks, totals };
}

// Grouped mode: one parallel group per event scenario, no per-hook passes. Each run
// starts every matching hook together with the CPU probe on; wall is the group's
// spawn-to-last-exit time, CPU is the sum of the hooks' own CPU in that run.
async function benchGrouped(opts) {
  const hooksJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.registry.json'), 'utf8'));
  const fx = makeFixture();
  const meta = {
    date: new Date().toISOString(), platform: process.platform + ' ' + os.release(), cpu: os.cpus()[0].model, node: process.version,
    n: opts.n, samples_per_group: opts.n - 1, loadavg: os.loadavg().map(round), loadavg_end: null,
    percentile: 'nearest-rank over the runs after dropping the first', parallel: PARALLEL_SOURCE,
    cpu_method: 'sum of process.resourceUsage() of each hook process in the group (excludes grandchildren)',
  };
  const groups = [];
  try {
    for (const sc of scenarios(fx)) {
      const list = hooksFor(hooksJson, sc, opts.only);
      if (!list.length) continue;
      const runs = await sample(opts.n, async () => {
        const t0 = process.hrtime.bigint();
        const rs = await Promise.all(list.map((h) => runOnce(h.command, sc.payload, fx, true)));
        const wall = Number(process.hrtime.bigint() - t0) / 1e6;
        return { wall, cpu: rs.every((r) => r.cpu !== null) ? rs.reduce((a, r) => a + r.cpu, 0) : null };
      });
      const cpus = runs.map((r) => r.cpu).filter((v) => v !== null);
      groups.push({
        event: sc.event, scenario: sc.scenario, hooks: list.length, samples: runs.length,
        wall: stats(runs.map((r) => r.wall)), cpu: cpus.length ? stats(cpus) : null, loadavg: os.loadavg().map(round),
      });
    }
  } finally {
    meta.loadavg_end = os.loadavg().map(round);
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
  return { meta, groups };
}

const f = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(1));
function markdown(rep) {
  const m = rep.meta;
  const L = [];
  L.push(`Date: ${m.date}  `, `Machine: ${m.cpu}, ${m.platform}, Node ${m.node}  `,
    `Load average (1/5/15 min) at start: ${m.loadavg.join(' / ')}; at end: ${m.loadavg_end.join(' / ')}  `,
    `N=${m.n} runs per hook, first dropped (${m.samples_per_hook} samples), nearest-rank percentiles. All times in ms.`, '');
  L.push('| Event | Scenario | Hook | Wall p50 | Wall p95 | CPU p50 | CPU p95 | Load (1 min) |', '|---|---|---|---:|---:|---:|---:|---:|');
  for (const h of rep.hooks) L.push(`| ${h.event} | ${h.scenario} | ${h.hook} | ${f(h.wall.p50)} | ${f(h.wall.p95)} | ${f(h.cpu && h.cpu.p50)} | ${f(h.cpu && h.cpu.p95)} | ${h.loadavg[0]} |`);
  L.push('', 'Per-tool-call totals. Wall (parallel, measured) starts every matching hook together and times the group, which is what Claude Code does. Wall (max) and Wall (sum) are derived from the per-hook numbers: max is the parallel lower bound, sum is what a sequential runner would cost. CPU (sum) is the work all hooks do together.', '');
  L.push('| Event | Scenario | Hooks | Wall parallel p50 | Wall parallel p95 | Wall max p50 | Wall max p95 | Wall sum p50 | CPU sum p50 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const t of rep.totals) L.push(`| ${t.event} | ${t.scenario} | ${t.hooks} | ${f(t.wall_parallel_p50)} | ${f(t.wall_parallel_p95)} | ${f(t.wall_max_p50)} | ${f(t.wall_max_p95)} | ${f(t.wall_sum_p50)} | ${f(t.cpu_sum_p50)} |`);
  L.push('', `Parallel vs sequential: ${m.parallel}`, `CPU method: ${m.cpu_method}.`);
  return L.join('\n') + '\n';
}

function markdownGrouped(rep) {
  const m = rep.meta;
  const L = [`Date: ${m.date}  `, `Machine: ${m.cpu}, ${m.platform}, Node ${m.node}  `,
    `Load average (1/5/15 min) at start: ${m.loadavg.join(' / ')}; at end: ${m.loadavg_end.join(' / ')}  `,
    `N=${m.n} runs per group, first dropped (${m.samples_per_group} samples), nearest-rank percentiles. All times in ms.`, '',
    'Each row starts the event\'s whole matching hook set together, as Claude Code does. Wall is the group\'s spawn to last exit; CPU is the sum of the hooks\' own CPU.', '',
    '| Event | Scenario | Hooks | Wall p50 | Wall p95 | CPU sum p50 | CPU sum p95 | Load (1 min) |', '|---|---|---:|---:|---:|---:|---:|---:|'];
  for (const g of rep.groups) L.push(`| ${g.event} | ${g.scenario} | ${g.hooks} | ${f(g.wall.p50)} | ${f(g.wall.p95)} | ${f(g.cpu && g.cpu.p50)} | ${f(g.cpu && g.cpu.p95)} | ${g.loadavg[0]} |`);
  L.push('', `Parallel vs sequential: ${m.parallel}`, `CPU method: ${m.cpu_method}.`);
  return L.join('\n') + '\n';
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  (opts.grouped ? benchGrouped(opts) : bench(opts)).then((rep) => {
    fs.writeSync(1, opts.json ? JSON.stringify(rep, null, 2) + '\n' : (opts.grouped ? markdownGrouped(rep) : markdown(rep)));
  }).catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
}

module.exports = { bench, markdown, benchGrouped, markdownGrouped, parseArgs };
