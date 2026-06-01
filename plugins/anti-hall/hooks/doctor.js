#!/usr/bin/env node
// doctor.js — anti-hall health check + live guard self-tests.
//
// Answers the only question that matters for a guardrail plugin: "is it actually
// running, and do the guards actually fire?" Prints a readable report and exits
// non-zero if anything critical fails (so it is scriptable too).
//
//   node hooks/doctor.js          full report
//   node hooks/doctor.js --quiet  summary line only
//
// Pure Node, cross-platform. Behavioral tests spawn the real guards with crafted
// payloads and assert their exit codes — this is the test suite AND the live status.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cp   = require('child_process');

const ROOT  = path.resolve(__dirname, '..');     // plugin root
const HOOKS = __dirname;                           // hooks/
const QUIET = process.argv.includes('--quiet');

const C = process.stdout.isTTY
  ? { g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', d:'\x1b[2m', b:'\x1b[1m', c:'\x1b[36m', x:'\x1b[0m' }
  : { g:'', r:'', y:'', d:'', b:'', c:'', x:'' };

let pass = 0, fail = 0, warn = 0;
const lines = [];
function ok(msg)   { pass++; lines.push(`  ${C.g}✓${C.x} ${msg}`); }
function bad(msg)  { fail++; lines.push(`  ${C.r}✗${C.x} ${msg}`); }
function warnl(msg){ warn++; lines.push(`  ${C.y}!${C.x} ${msg}`); }
function head(t)   { lines.push(`\n${C.b}${t}${C.x}`); }

// --- spawn a hook with a payload + env, return {code, out} -------------------
function runHook(file, payload, env) {
  try {
    const res = cp.spawnSync(process.execPath, [path.join(HOOKS, file)], {
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      timeout: 5000,
      env: Object.assign({}, process.env, env || {}),
    });
    return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
  } catch (e) {
    return { code: -1, out: String(e && e.message) };
  }
}
const BLOCKED = (r) => r.code === 2;     // PreToolUse block contract: exit 2
const ALLOWED = (r) => r.code === 0;

// --- 1. Environment ----------------------------------------------------------
head('Environment');
const nodeMajor = parseInt((process.versions.node || '0').split('.')[0], 10);
if (nodeMajor >= 18) ok(`Node ${process.version} (>= 18) — hooks can run`);
else bad(`Node ${process.version} is < 18 — hooks may silently no-op. Install Node >= 18.`);
ok(`Platform ${process.platform} / ${process.arch}`);
let version = '(unknown)';
try { version = require(path.join(ROOT, '.claude-plugin', 'plugin.json')).version; } catch (e) {}
ok(`anti-hall plugin version ${version}`);

// --- 2. Hooks present + syntax-valid ----------------------------------------
head('Hooks (present + syntax)');
let registered = [];
try {
  const hj = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  const cmds = JSON.stringify(hj).match(/[\w-]+\.js/g) || [];
  registered = [...new Set(cmds)];
  ok(`hooks.json is valid JSON (${registered.length} hook script(s) registered)`);
} catch (e) {
  bad(`hooks.json invalid or unreadable: ${e.message}`);
}
for (const f of registered) {
  const p = path.join(HOOKS, f);
  if (!fs.existsSync(p)) { bad(`${f} — REGISTERED BUT MISSING`); continue; }
  const chk = cp.spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  if (chk.status === 0) ok(`${f} present, syntax valid`);
  else bad(`${f} — SYNTAX ERROR: ${(chk.stderr || '').split('\n')[0]}`);
}

// --- 3. Behavioral self-tests (the guards actually fire) ---------------------
head('Guard behavior (live self-tests)');

// git-guard: blocks force-push + AI self-credit; allows read-only git
function gg(cmd) { return runHook('git-guard.js', { tool_name: 'Bash', tool_input: { command: cmd } }); }
BLOCKED(gg('git push --force origin main')) ? ok('git-guard blocks `git push --force`') : bad('git-guard did NOT block force-push');
BLOCKED(gg('git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"')) ? ok('git-guard blocks AI self-credit trailer') : bad('git-guard did NOT block AI self-credit');
ALLOWED(gg('git status')) ? ok('git-guard allows `git status`') : bad('git-guard wrongly blocked `git status`');

// command-guard: blocks heavy in COORDINATOR; allows in SUBAGENT (payload agent_id)
function cg(cmd, extra) { return runHook('command-guard.js', Object.assign({ tool_name: 'Bash', tool_input: { command: cmd } }, extra), { CLAUDE_CODE_ENTRYPOINT: 'cli' }); }
BLOCKED(cg('npm run build')) ? ok('command-guard blocks heavy cmd in coordinator') : bad('command-guard did NOT block heavy cmd in coordinator');
ALLOWED(cg('npm run build', { agent_id: 'test-agent', agent_type: 'general-purpose' })) ? ok('command-guard ALLOWS heavy cmd in subagent (payload agent_id)') : bad('command-guard wrongly blocked a subagent — delegation would deadlock');
ALLOWED(cg('git status')) ? ok('command-guard allows light cmd in coordinator') : bad('command-guard wrongly blocked a light cmd');

// swarm-guard: must allow a normal spawn on a healthy machine (fail-open, real mem calc)
const sg = runHook('swarm-guard.js', { tool_name: 'Agent', tool_input: {} });
ALLOWED(sg) ? ok('swarm-guard allows a spawn under normal memory') : warnl(`swarm-guard returned exit ${sg.code} (blocked) — check memory pressure`);

// --- 4. Statusline install status -------------------------------------------
head('Statusline');
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
const cwd = process.cwd();
const scopes = [
  ['project-local', path.join(cwd, '.claude', 'settings.local.json')],
  ['project',       path.join(cwd, '.claude', 'settings.json')],
  ['user',          path.join(os.homedir(), '.claude', 'settings.json')],
];
let slFound = false;
for (const [label, p] of scopes) {
  const s = readJSON(p);
  const cmd = s && s.statusLine && s.statusLine.command;
  if (cmd) {
    slFound = true;
    if (cmd.includes('statusline.js')) ok(`statusline installed (${label}) -> anti-hall dispatcher`);
    else ok(`statusline set (${label}) -> ${cmd.slice(0, 48)}…${cmd.length > 48 ? '' : ''}`);
    break;
  }
}
if (!slFound) warnl('no statusLine configured — run the install-statusline skill (then restart)');

// Behavioral: does the statusline actually RENDER? Spawn the dispatcher with a
// sample session payload and assert it produces output (line 1 = rich, line 2 =
// context gauge when idle).
const slScript = path.join(ROOT, 'statusline', 'statusline.js');
if (!fs.existsSync(slScript)) {
  bad('statusline.js dispatcher missing');
} else {
  const sample = JSON.stringify({
    workspace: { current_dir: cwd }, cwd,
    model: { display_name: 'doctor-test' },
    context_window: { used_percentage: 50 },
  });
  const res = cp.spawnSync(process.execPath, [slScript], { input: sample, encoding: 'utf8', timeout: 5000 });
  const out = (res.stdout || '').replace(/\s+$/, '');
  const nlines = out ? out.split('\n').length : 0;
  if (res.status === 0 && nlines >= 1) ok(`statusline renders (${nlines} line${nlines > 1 ? 's' : ''}: line 1 + ${nlines > 1 ? 'live line 2' : 'no line 2'})`);
  else bad(`statusline.js produced no output (exit ${res.status})`);
  // Verify the rich line-1 renderer is present + valid (the own-dispatch default).
  const rich = path.join(ROOT, 'statusline', 'statusline-rich.js');
  if (fs.existsSync(rich) && cp.spawnSync(process.execPath, ['--check', rich], { encoding: 'utf8' }).status === 0) {
    ok('statusline-rich.js (line-1 renderer) present, syntax valid');
  } else {
    warnl('statusline-rich.js missing/invalid — line 1 falls back to the simple renderer');
  }
}

// --- 5. Summary --------------------------------------------------------------
const verdict = fail === 0
  ? `${C.g}${C.b}anti-hall ACTIVE${C.x} — ${pass} checks passed` + (warn ? `, ${warn} warning(s)` : '')
  : `${C.r}${C.b}anti-hall has ${fail} FAILURE(S)${C.x} — ${pass} passed, ${warn} warning(s)`;

if (!QUIET) {
  process.stdout.write(`${C.c}${C.b}anti-hall doctor${C.x} ${C.d}v${version}${C.x}\n`);
  process.stdout.write(lines.join('\n') + '\n\n');
}
process.stdout.write(verdict + '\n');
process.exit(fail === 0 ? 0 : 1);
