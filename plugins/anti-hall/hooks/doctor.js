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
// infol: a neutral "not detected — skipped" note. Deliberately does NOT touch
// pass/fail/warn — an absent optional integration is not a warning, it's the
// expected state for most users, and must not make a healthy machine look
// unhealthy.
function infol(msg){ lines.push(`  ${C.d}i${C.x} ${msg}`); }
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
let hooksConfig = null;
try {
  hooksConfig = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  const cmds = JSON.stringify(hooksConfig).match(/[\w-]+\.js/g) || [];
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

// edit-guard: blocks direct Edit-family tool use in COORDINATOR; allows in SUBAGENT (payload agent_id)
function eg(extra) { return runHook('edit-guard.js', Object.assign({ tool_name: 'Edit', tool_input: { file_path: 'src/x.js', old_string: 'a', new_string: 'b' } }, extra), { CLAUDE_CODE_ENTRYPOINT: 'cli' }); }
BLOCKED(eg()) ? ok('edit-guard blocks coordinator edit') : bad('edit-guard did NOT block coordinator edit');
ALLOWED(eg({ agent_id: 'test-agent', agent_type: 'general-purpose' })) ? ok('edit-guard ALLOWS subagent edit') : bad('edit-guard wrongly blocked a subagent edit — delegation would deadlock');

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

// codex-nudge: Stop-hook advisory that nudges for a Codex second opinion when a
// session shipped >= MIN substantial code-file edits with no Codex review. Build a
// throwaway transcript of 3 Edit tool_uses on .ts files and no codex spawn.
function codexNudgeTest() {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-cx-'));
  const tp = path.join(tdir, 't.jsonl');
  try {
    const lines = [];
    for (const f of ['a.ts', 'b.ts', 'c.ts']) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: 'toolu_' + f, input: { file_path: '/x/' + f } }] },
      }));
    }
    fs.writeFileSync(tp, lines.join('\n') + '\n');
    const r = runHook('codex-nudge.js', { transcript_path: tp, session_id: 'doctor-cx-' + Date.now() });
    return /"decision"\s*:\s*"block"/.test(r.out);
  } finally {
    try { fs.rmSync(tdir, { recursive: true, force: true }); } catch (_) {}
  }
}
codexNudgeTest() ? ok('codex-nudge flags substantial code change with no Codex review') : bad('codex-nudge did NOT flag uncovered code change');

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

// version-alert: SessionStart advisory that nudges when a cached "latest"
// version is newer than the running one. It reads its cache from a FIXED path
// under the user's home dir (~/.anti-hall/version-check.json), not from cwd or
// the payload — so this test overrides HOME (and USERPROFILE for Windows,
// since os.homedir() resolves from that var there) to a throwaway temp dir
// rather than touching the real cache file. Two cases against the SAME
// fresh-cache contract: a newer cached version must alert, an equal one must
// stay silent (ANTIHALL_VERSION_ALERT is force-cleared so an inherited
// off-switch can't fake a false negative).
function versionAlertTest() {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-va-'));
  try {
    const cacheDir = path.join(tdir, '.anti-hall');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, 'version-check.json');
    const fakeEnv = { HOME: tdir, USERPROFILE: tdir, ANTIHALL_VERSION_ALERT: '' };

    // Case 1: fresh cache, latest > running -> must emit the update nudge.
    fs.writeFileSync(cachePath, JSON.stringify({ latest: '999.0.0', checkedAt: Date.now() }));
    const stale = runHook('version-alert.js', { hook_event_name: 'SessionStart', session_id: 'doctor-va-stale-' + Date.now() }, fakeEnv);
    const staleAlerted = /"additionalContext"\s*:\s*"anti-hall v999\.0\.0 available \(running v/.test(stale.out);

    // Case 2: fresh cache, latest === running -> must stay silent (no stdout).
    fs.writeFileSync(cachePath, JSON.stringify({ latest: version, checkedAt: Date.now() }));
    const current = runHook('version-alert.js', { hook_event_name: 'SessionStart', session_id: 'doctor-va-current-' + Date.now() }, fakeEnv);
    const currentSilent = current.out.trim() === '';

    return staleAlerted && currentSilent;
  } finally {
    try { fs.rmSync(tdir, { recursive: true, force: true }); } catch (_) {}
  }
}
versionAlertTest() ? ok('version-alert nudges on a stale cached version and stays silent when current') : bad('version-alert did NOT behave correctly for stale-vs-current cache');

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
const graphPresent = isDir(graphOut);
if (graphPresent) {
  ok(`knowledge graph present in cwd (${graphOut})`);
} else {
  warnl('no knowledge graph in cwd (graphify-out/) — graph-first guards are silent no-ops here');
}
// Are the graphify hooks registered in hooks.json?
for (const h of ['graphify-guard.js', 'graphify-session.js', 'graphify-reminder.js']) {
  if (registered.includes(h)) ok(`${h} registered in hooks.json`);
  else warnl(`${h} NOT registered in hooks.json`);
}
warnl('graphify staleness is NOT auto-detected — re-run `graphify update .` after significant edits to keep the graph current');

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
// SessionStart one-time cost = SUM across every hook actually registered on
// SessionStart in hooks.json (verify-first-full is only one of several — e.g.
// graphify-session, version-alert, and fable-availability ALSO inject
// additionalContext on the same event per hooks.json). Derive the list from
// hooks.json itself rather than hardcoding it, so a future hooks.json edit is
// picked up automatically instead of silently under-reporting.
function sessionStartHookFiles(cfg) {
  const groups = (cfg && cfg.hooks && Array.isArray(cfg.hooks.SessionStart)) ? cfg.hooks.SessionStart : [];
  const files = [];
  for (const group of groups) {
    const hs = Array.isArray(group.hooks) ? group.hooks : [];
    for (const h of hs) {
      const m = String((h && h.command) || '').match(/[\w-]+\.js/);
      if (m) files.push(m[0]);
    }
  }
  return [...new Set(files)];
}
// Fallback to the single known SessionStart script ONLY if hooks.json itself
// failed to parse (section 2 above already reported that failure as a FAIL).
const ssFiles = sessionStartHookFiles(hooksConfig);
const ssPayload = { hook_event_name: 'SessionStart', source: 'startup' };
let ssB = 0;
const ssParts = [];
for (const f of (ssFiles.length ? ssFiles : ['verify-first-full.js'])) {
  const b = ctxBytes(f, ssPayload);
  ssB += b;
  ssParts.push(`${f} ${b} B`);
}
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
ok(`SessionStart (one-time): ${ssB} B ~${tok(ssB)} tok  (${ssParts.join(' + ')})`);
ok(`Per-TURN (every UserPromptSubmit): ${perTurnB} B ~${tok(perTurnB)} tok  (verify-first ${vfB} B + task-tracker ${ttB} B; task-tracker throttles to a short line after the first turn)`);
ok(`Per-STOP (block reason, when it fires): ${stopB} B ~${tok(stopB)} tok`);

// --- 6b. flutter-debug (CONDITIONAL: Flutter cwd or skill/agent in use) -------
// ONE implementation, two entry points: preflight.js EXPORTS its checks; doctor
// require()s and CALLS them IN-PROCESS (not a subprocess spawn) as a read-only
// section. Runs ONLY when a pubspec.yaml is in cwd or the flutter-debug skill/
// agent is present — silent in a non-Flutter repo. skipRegistration:true keeps
// it read-only (no MCP add, no marionette auto-provision).
(function flutterDebugSection() {
  const hasPubspec = (() => { try { return fs.statSync(path.join(cwd, 'pubspec.yaml')).isFile(); } catch (_) { return false; } })();
  const skillPath = path.join(ROOT, 'skills', 'flutter-debug', 'scripts', 'preflight.js');
  const skillPresent = fs.existsSync(skillPath);
  // Condition: a Flutter project in cwd, OR the user explicitly invoked it.
  const inUse = /flutter-debug/i.test((process.env.ANTIHALL_DOCTOR_CONTEXT || '') + ' ' + process.argv.join(' '));
  if (!hasPubspec && !inUse) return; // not a Flutter context → stay silent
  head('flutter-debug (Flutter project detected)');
  if (!skillPresent) { warnl('flutter-debug preflight.js not found — skill not installed?'); return; }
  let preflight;
  try { preflight = require(skillPath); }
  catch (e) { bad('flutter-debug preflight.js present but failed to load: ' + (e && e.message)); return; }
  try {
    const report = preflight.runAllChecks({ projectDir: cwd, skipRegistration: true });
    for (const r of report.results) {
      const msg = '[' + r.id + '] ' + String(r.message).split('\n')[0];
      if (r.status === preflight.FAIL) bad(msg);
      else if (r.status === preflight.WARN) warnl(msg);
      else ok(msg);
    }
    ok('capability tier: ' + report.tier.tier + ' — ' + report.tier.summary);
  } catch (e) {
    warnl('flutter-debug checks raised (fail-open): ' + (e && e.message));
  }
})();

// --- 6c. DevSwarm liveness supervisor (CONDITIONAL: active session or descriptors) ---
// ONE implementation, two entry points: companion/lib/doctor-devswarm.js EXPORTS
// runChecks; doctor requires it and CALLS it IN-PROCESS. Silent unless a DevSwarm
// session is active OR the consumer has published workspace descriptors — EXCEPT a
// syntax error in any supervisor lib is always surfaced (P2-12). Workaround for
// claude-code#39755.
(function devswarmSection() {
  const libDir = path.join(ROOT, 'companion', 'lib');
  const supervisorFiles = [
    path.join(HOOKS, 'lib', 'devswarm-detect.js'),
    path.join(libDir, 'target-session.js'),
    path.join(libDir, 'liveness.js'),
    path.join(libDir, 'recovery.js'),
    path.join(libDir, 'doctor-devswarm.js'),
    path.join(ROOT, 'companion', 'devswarm-supervisor.js'),
    path.join(ROOT, 'companion', 'install-devswarm-supervisor.js'),
  ];
  // P2-12: node --check each PRESENT file so a broken file FAILS (loudly) instead
  // of vanishing behind the require()-fail-open below.
  const syntaxErrors = [];
  for (const f of supervisorFiles) {
    if (!fs.existsSync(f)) continue; // optional / older build
    const chk = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (chk.status !== 0) syntaxErrors.push({ f, err: (chk.stderr || '').split('\n')[0] });
  }

  const modPath = path.join(libDir, 'doctor-devswarm.js');
  let dsd = null, report = null;
  if (fs.existsSync(modPath)) {
    try { dsd = require(modPath); } catch (_) { dsd = null; } // fail-open: a broken check never breaks doctor
    if (dsd) { try { report = dsd.runChecks({ home: os.homedir(), env: process.env }); } catch (_) { report = null; } }
  }
  const active = !!(report && report.active);

  // Supervisor companion (launchd/systemd background job) INSTALLED vs merely
  // available on disk — always checked against the REAL os.homedir(), never the
  // `home` used above for report/descriptors (those may be a test fixture; the
  // scheduler artifact is always per-real-user). Read-only existence check,
  // never spawns launchctl/systemctl. LABEL/UNIT live in
  // install-devswarm-supervisor.js (NOT devswarm-supervisor.js, which doesn't
  // export them) — require that module separately so this can't drift from
  // what install actually writes.
  let installed = false;
  const installPath = path.join(ROOT, 'companion', 'install-devswarm-supervisor.js');
  if (fs.existsSync(installPath)) {
    try {
      const inst = require(installPath);
      const realHome = os.homedir();
      if (process.platform === 'darwin') {
        installed = fs.existsSync(path.join(realHome, 'Library', 'LaunchAgents', `${inst.LABEL}.plist`));
      } else if (process.platform === 'linux') {
        installed = fs.existsSync(path.join(realHome, '.config', 'systemd', 'user', `${inst.UNIT}.timer`));
      }
      // win32: recovery is a documented no-op (see install-devswarm-supervisor.js) — never installed.
    } catch (_) { installed = false; } // fail-open: unknown = not installed
  }

  // Fully silent ONLY when dormant, not installed, AND every lib parses.
  if (!active && !installed && syntaxErrors.length === 0) return;
  head('DevSwarm liveness supervisor (optional)');
  for (const se of syntaxErrors) bad('supervisor lib SYNTAX ERROR: ' + path.basename(se.f) + ' — ' + se.err);
  if (installed) ok(`supervisor companion INSTALLED (${process.platform === 'darwin' ? 'launchd' : 'systemd'} background sweep)`);
  else infol('supervisor companion not installed — background auto-recovery is off; the in-session checks below (if any) still run');
  if (active && report && dsd) {
    for (const r of report.results) {
      if (r.status === dsd.FAIL) bad(r.message);
      else if (r.status === dsd.WARN) warnl(r.message);
      else ok(r.message);
    }
  }
})();

// --- 6d. OMC (oh-my-claudecode) detection (CONDITIONAL) ----------------------
// Reuses hooks/omc-detect.js's OWN gates (enabledPlugins + .omc/state/) so this
// can never drift from what task-guard/tasklist-guard actually check to decide
// deference. omc-detect.js's presence/syntax was already verified in section 3
// above — if it's missing/broken, stay silent here rather than double-report.
(function omcSection() {
  if (!fs.existsSync(omcDetectPath)) return;
  let mod;
  try { mod = require(omcDetectPath); } catch (_) { return; }
  let enabled = false;
  try { enabled = !!(mod.isOmcEnabled && mod.isOmcEnabled(cwd)); } catch (_) { enabled = false; }
  if (!enabled) { infol('OMC (oh-my-claudecode) not detected — skipped'); return; }
  head('OMC (oh-my-claudecode) — detected');
  ok('OMC plugin enabled in settings (enabledPlugins["oh-my-claudecode@omc"])');
  let loopActive = false;
  try { loopActive = !!mod.isOmcLoopActive({ cwd, sessionId: 'doctor-omc-probe' }); } catch (_) { loopActive = false; }
  if (loopActive) ok('an OMC autonomous loop is ACTIVE right now — anti-hall task-guard/tasklist-guard defer to it (no double-block)');
  else ok('no active OMC autonomous loop detected — anti-hall Stop-hook guards run normally');
})();

// --- 6e. Codex / OMX port detection (CONDITIONAL) -----------------------------
// Detects a Codex install by the same artifacts codex/install-codex.js writes:
// <scope>/.codex/config.toml (+ [features] hooks = true) and <scope>/.codex/
// hooks.json with anti-hall's own hook commands merged in (matched the same way
// install-codex.js's own isAntiHallGroup() does — by the /plugins/anti-hall/
// hooks/ path fragment in the command string). Read-only; never writes.
(function codexSection() {
  function hasAntiHallHooks(hooksJsonPath) {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8')); } catch (_) { return null; } // null = file absent/unreadable
    try {
      return JSON.stringify(cfg).replace(/\\\\/g, '/').includes('/plugins/anti-hall/hooks/');
    } catch (_) { return false;
    }
  }
  const scopesX = [
    ['project', path.join(cwd, '.codex')],
    ['global', path.join(os.homedir(), '.codex')],
  ];
  const found = [];
  for (const [label, dir] of scopesX) {
    let hasConfig = false;
    try { hasConfig = fs.statSync(path.join(dir, 'config.toml')).isFile(); } catch (_) {}
    if (!hasConfig) continue;
    let hooksEnabled = false;
    try {
      const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
      hooksEnabled = /\[features\][\s\S]*?^\s*hooks\s*=\s*true/m.test(toml);
    } catch (_) {}
    found.push({ label, hooksEnabled, wired: hasAntiHallHooks(path.join(dir, 'hooks.json')) });
  }
  if (found.length === 0) { infol('Codex / OMX not detected — no <cwd>/.codex or ~/.codex config.toml — skipped'); return; }
  head('Codex / OMX port — detected');
  for (const s of found) {
    if (s.hooksEnabled) ok(`Codex config.toml (${s.label}) has the hooks feature enabled`);
    else warnl(`Codex config.toml (${s.label}) found but [features] hooks is not enabled`);
    if (s.wired === true) ok(`Codex hooks.json (${s.label}) has anti-hall hooks registered`);
    else if (s.wired === false) warnl(`Codex hooks.json (${s.label}) present but no anti-hall hooks found — run plugins/anti-hall/codex/install-codex.js`);
    else warnl(`Codex hooks.json (${s.label}) missing — run plugins/anti-hall/codex/install-codex.js`);
  }
})();

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
