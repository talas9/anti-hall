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
// Per-segment fix: a heavy verb after a light-exception segment / non-heavy first
// verb must still block (the old code only inspected the first whole-string verb).
BLOCKED(cg('git status && npm run build')) ? ok('command-guard blocks heavy SECOND segment (`git status && npm run build`)') : bad('command-guard MISSED heavy second segment — per-segment fix regressed');
BLOCKED(cg('cd app && npm test')) ? ok('command-guard blocks heavy cmd after `cd` (`cd app && npm test`)') : bad('command-guard MISSED heavy cmd after cd — per-segment fix regressed');
// Recursive shell parsing (v0.12.0): heavy commands hidden in command
// substitution and in `bash -c '...'` payloads must also block in coordinator.
BLOCKED(cg('echo "$(npm run build)"')) ? ok('command-guard blocks heavy cmd in $(...) substitution (`echo "$(npm run build)"`)') : bad('command-guard MISSED heavy cmd in command substitution — recursive-parse fix regressed');
BLOCKED(cg('bash -c "npm run build"')) ? ok('command-guard blocks heavy `bash -c "npm run build"` payload') : bad('command-guard MISSED heavy bash -c payload — recursive-parse fix regressed');
ALLOWED(cg('echo "$(date)"')) ? ok('command-guard allows benign substitution (`echo "$(date)"` — date is not heavy)') : bad('command-guard wrongly blocked benign `echo "$(date)"` — over-blocking substitutions');

// speculation-guard: a Stop-hook block on hedged-without-evidence text. Build a
// throwaway transcript whose last assistant message says "should be fine".
function specTest() {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-'));
  const tp = path.join(tdir, 't.jsonl');
  try {
    fs.writeFileSync(tp, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'That change should be fine.' }] },
    }) + '\n');
    const r = runHook('speculation-guard.js', { transcript_path: tp, session_id: 'doctor-spec-' + Date.now() });
    // Stop-hook block is signalled by the decision field (exit 0), not exit 2.
    return /"decision"\s*:\s*"block"/.test(r.out);
  } finally {
    try { fs.rmSync(tdir, { recursive: true, force: true }); } catch (_) {}
  }
}
specTest() ? ok('speculation-guard flags "should be fine" (hedge w/o evidence)') : bad('speculation-guard did NOT flag "should be fine"');

// tasklist-guard: blocks at Stop when >= threshold file-mutating actions were
// done with NO task activity and no fresh progress file. Build a throwaway
// transcript of 4 Edit tool_uses, point cwd at a dir with no progress file.
function tasklistTest() {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-tl-'));
  const tp = path.join(tdir, 't.jsonl');
  try {
    const edits = [];
    for (let i = 0; i < 4; i++) {
      edits.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: 'toolu_e' + i, input: { file_path: '/x/f' + i } }] },
      }));
    }
    fs.writeFileSync(tp, edits.join('\n') + '\n');
    const r = runHook('tasklist-guard.js', { transcript_path: tp, cwd: tdir, session_id: 'doctor-tl-' + Date.now() });
    return /"decision"\s*:\s*"block"/.test(r.out);
  } finally {
    try { fs.rmSync(tdir, { recursive: true, force: true }); } catch (_) {}
  }
}
tasklistTest() ? ok('tasklist-guard blocks untracked work (4 edits, no tasks, no progress file)') : bad('tasklist-guard did NOT block untracked work');

// model-routing-guard: blocks a mechanical task pinned to a flagship model (row 1);
// allows a benign spawn with no model specified and no mechanical signals (row 5).
function mrg(payload) {
  return runHook('model-routing-guard.js', Object.assign({ tool_name: 'Agent' }, payload));
}
const mrgBlock = mrg({ tool_input: {
  model: 'opus',
  subagent_type: 'general-purpose',
  description: 'fetch and download the build artifacts',
  prompt: 'fetch and download the build artifacts from the CI bucket',
} });
const mrgAllow = mrg({ tool_input: {
  description: 'summarise the findings from the last round',
  prompt: 'summarise the findings from the last round',
} });
BLOCKED(mrgBlock) ? ok('model-routing-guard blocks mechanical task pinned to flagship model (opus + fetch/download)') : bad('model-routing-guard did NOT block mechanical+flagship spawn — routing guard not firing');
ALLOWED(mrgAllow) ? ok('model-routing-guard allows benign spawn with no model and no mechanical signals') : bad('model-routing-guard wrongly blocked a benign spawn');

// omc-detect: presence and syntax check (shared helper, not a hook).
const omcDetectPath = path.join(HOOKS, 'omc-detect.js');
if (fs.existsSync(omcDetectPath)) {
  const omcChk = cp.spawnSync(process.execPath, ['--check', omcDetectPath], { encoding: 'utf8' });
  omcChk.status === 0 ? ok('omc-detect.js present and syntax-valid') : bad('omc-detect.js present but SYNTAX ERROR: ' + (omcChk.stderr || '').trim());
} else {
  bad('omc-detect.js MISSING — OMC-deference will not work in task-guard / tasklist-guard');
}

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
  // The product is a TWO-line statusline. The sample payload carries
  // context_window, so line 2 (the live context gauge) MUST render. Require >= 2
  // lines — a single line means line 2 (the context gauge) failed to render.
  if (res.status === 0 && nlines >= 2) ok(`statusline renders ${nlines} lines (line 1 + live context gauge on line 2)`);
  else if (res.status === 0 && nlines === 1) bad('statusline rendered only 1 line — line 2 (context gauge) did NOT render despite context_window in the payload');
  else bad(`statusline.js produced no output (exit ${res.status})`);
  // Verify the rich line-1 renderer is present + valid (the own-dispatch default).
  const rich = path.join(ROOT, 'statusline', 'statusline-rich.js');
  if (fs.existsSync(rich) && cp.spawnSync(process.execPath, ['--check', rich], { encoding: 'utf8' }).status === 0) {
    ok('statusline-rich.js (line-1 renderer) present, syntax valid');
  } else {
    warnl('statusline-rich.js missing/invalid — line 1 falls back to the simple renderer');
  }
}

// --- 5. Graphify -------------------------------------------------------------
head('Graphify');
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
const graphOut = path.join(cwd, 'graphify-out');
const graphPlanning = path.join(cwd, '.planning', 'graphs');
const graphPresent = isDir(graphOut) || isDir(graphPlanning);
if (graphPresent) {
  const where = isDir(graphOut) ? graphOut : graphPlanning;
  ok(`knowledge graph present in cwd (${where})`);
} else {
  warnl('no knowledge graph in cwd (graphify-out/ or .planning/graphs/) — graph-first guards are silent no-ops here');
}
// Are the graphify hooks registered in hooks.json?
for (const h of ['graphify-guard.js', 'graphify-session.js', 'graphify-reminder.js']) {
  if (registered.includes(h)) ok(`${h} registered in hooks.json`);
  else warnl(`${h} NOT registered in hooks.json`);
}
warnl('graphify staleness is NOT auto-detected — re-run `/graphify --obsidian` after significant edits to keep the graph current');

// --- 6. Context footprint ----------------------------------------------------
// The plugin injects text into the model's context. Measure it so the cost of
// the guardrail is visible (bloated context is the exact failure it warns of).
head('Context footprint (injected text)');
function ctxBytes(file, payload, picker) {
  const r = runHook(file, payload || {});
  let txt = '';
  try {
    const o = JSON.parse((r.out || '').split('\n').find(Boolean) || '{}');
    txt = (picker ? picker(o) : (o.hookSpecificOutput && o.hookSpecificOutput.additionalContext)) || '';
  } catch (_) { txt = ''; }
  return Buffer.byteLength(String(txt), 'utf8');
}
const tok = (b) => Math.round(b / 4);
// SessionStart one-time cost.
const ssB = ctxBytes('verify-first-full.js', { hook_event_name: 'SessionStart', source: 'startup' });
// Per-turn cost = sum of UserPromptSubmit injections (verify-first + task-tracker).
const upPayload = { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 'doctor-ctx', cwd };
const vfB = ctxBytes('verify-first.js', upPayload);
// task-tracker is throttled: measure its FULL (first-turn) injection by using a
// fresh session id so state has not been written yet this run.
const ttPayload = { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 'doctor-ctx-' + Date.now(), cwd };
const ttB = ctxBytes('task-tracker.js', ttPayload);
const perTurnB = vfB + ttB;
// Per-Stop cost: the block reason text a Stop hook surfaces (decision.reason).
function stopReasonBytes(file, payload) {
  const r = runHook(file, payload || {});
  let txt = '';
  try {
    const o = JSON.parse((r.out || '').split('\n').find(Boolean) || '{}');
    txt = (o.decision === 'block' && o.reason) || '';
  } catch (_) { txt = ''; }
  return Buffer.byteLength(String(txt), 'utf8');
}
let stopB = 0;
try {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-ctx-'));
  const tp = path.join(tdir, 't.jsonl');
  fs.writeFileSync(tp, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'That change should be fine.' }] },
  }) + '\n');
  stopB = stopReasonBytes('speculation-guard.js', { transcript_path: tp, session_id: 'doctor-ctx-stop-' + Date.now() });
  try { fs.rmSync(tdir, { recursive: true, force: true }); } catch (_) {}
} catch (_) { stopB = 0; }
ok(`SessionStart (one-time): ${ssB} B ~${tok(ssB)} tok`);
ok(`Per-TURN (every UserPromptSubmit): ${perTurnB} B ~${tok(perTurnB)} tok  (verify-first ${vfB} B + task-tracker ${ttB} B; task-tracker throttles to a short line after the first turn)`);
ok(`Per-STOP (block reason, when it fires): ${stopB} B ~${tok(stopB)} tok`);

// --- 7. Summary --------------------------------------------------------------
const verdict = fail === 0
  ? `${C.g}${C.b}anti-hall ACTIVE${C.x} — ${pass} checks passed` + (warn ? `, ${warn} warning(s)` : '')
  : `${C.r}${C.b}anti-hall has ${fail} FAILURE(S)${C.x} — ${pass} passed, ${warn} warning(s)`;

if (!QUIET) {
  process.stdout.write(`${C.c}${C.b}anti-hall doctor${C.x} ${C.d}v${version}${C.x}\n`);
  process.stdout.write(lines.join('\n') + '\n\n');
}
process.stdout.write(verdict + '\n');
process.exit(fail === 0 ? 0 : 1);
