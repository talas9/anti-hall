'use strict';
// spawn-hook.js — spawn an anti-hall hook as a child process with a CONTROLLED
// environment and assert on its exit code / stdout / stderr.
//
// CRITICAL ENV ISOLATION: the test process itself runs inside Claude Code, so
// process.env may carry CLAUDE_CODE_ENTRYPOINT / agent markers. If we inherited
// the parent env blindly, coordinator-vs-subagent detection in the hooks would be
// non-deterministic. So the child env is a CONTROLLED base ({ PATH, HOME }) plus
// only what a test explicitly passes via opts.env. Nothing leaks in.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Hooks live in plugins/anti-hall/hooks, resolved absolutely from this file.
const HOOKS_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks');

// isolatedEnv(home) — build the env object that points a child hook at a fake
// HOME, cross-platform. Node's os.homedir() does NOT read $HOME on Windows: it
// reads USERPROFILE first, then HOMEDRIVE+HOMEPATH. So on win32 we must set all
// three or the hook escapes the fixture and hits the real CI home (the bug that
// made the 3 windows matrix legs fail 9/77). PATH is preserved from the parent.
//
// WINDOWS: some hooks (devswarm-child-gate's STRICT native message-count probe)
// spawn a bare command via `shell: win32-only` so cmd.exe can resolve a PATHEXT
// shim (e.g. `hivecontrol.cmd`). cmd.exe needs SystemRoot/ComSpec/PATHEXT/TEMP/
// TMP and friends to even start — a hand-picked allowlist (PATH/HOME only)
// starves it and the shim is silently never invoked. tests/statusline/helper.js
// hit and solved this EXACT problem for statusline's own cmd.exe spawn: inherit
// the FULL parent env so cmd.exe gets what it has in production, instead of a
// stripped-down allowlist. We do the same here, but hook tests additionally rely
// on isolatedEnv NOT leaking the developer's real DEVSWARM_*/ANTIHALL_* vars
// (those drive hook behavior — e.g. a DORMANT-when-absent assertion). So on
// win32 we inherit the full parent env, then strip every DEVSWARM_*/ANTIHALL_*
// key from it, BEFORE the caller's explicit opts.env overrides are merged on
// top by testHook/testHookRaw. POSIX has no cmd.exe dependency, so it keeps the
// original minimal PATH+HOME allowlist unchanged.
function isolatedEnv(home) {
  if (process.platform === 'win32') {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^DEVSWARM_/.test(key) || /^ANTIHALL_/.test(key)) delete env[key];
    }
    const root = path.parse(home).root; // e.g. "C:\\"
    env.HOME = home;
    env.USERPROFILE = home;
    env.HOMEDRIVE = root;
    env.HOMEPATH = home.slice(root.length);
    return env;
  }
  return {
    PATH: process.env.PATH,
    HOME: home,
  };
}

// testHook(hookRelPathOrAbs, payloadObj, opts={}):
//   - hookRelPathOrAbs: a bare hook filename (e.g. 'git-guard.js'), a path under
//     the hooks dir, or an absolute path.
//   - payloadObj: the JSON object piped to the hook on stdin.
//   - opts.home: HOME for the child (fake home). Defaults to process.env.HOME.
//   - opts.env: extra env vars merged onto the controlled base.
//   - opts.expectJson: when true, RE-SPAWN (up to 4 attempts) on the macOS
//     spawnSync empty-stdout flake until stdout parses as JSON (see spawnHook).
//     Only set this for hooks that MUST emit JSON and have no per-run side
//     effects — NOT for stateful/allow-empty hooks.
// Returns { status, stdout, stderr, json } where json is JSON.parse(stdout) or null.
// spawnHook — spawn the hook once. Centralizes the spawnSync call so both
// testHook and testHookRaw share the same flake-resistant invocation.
//
// FLAKE GUARD (macOS node 18/20), OPT-IN via opts.expectJson:
// spawnSync, when given `input` AND a child that writes a multi-KB stdout,
// intermittently returns exit 0 with EMPTY/truncated stdout on slower macOS
// runners (a known stdin/stdout pipe race in older Node; node 22/24 don't exhibit
// it). That surfaced as `r.json === null` on hooks that reliably emit ~10KB of
// valid JSON (verify-first-full, graphify-session inject). When the CALLER knows
// the hook MUST emit JSON (expectJson:true) and we got exit 0 + empty stdout, we
// RE-SPAWN, looping up to MAX_SPAWN_ATTEMPTS times until stdout parses as JSON.
//
// Why a LOOP (not a single retry): real CI run 27042542976 (macos node 18/20)
// failed verify-first-full subtests 245-248 even though they already passed
// expectJson:true — i.e. BOTH the first spawn and the single retry came back
// without parseable JSON. The race can hit consecutive spawns, so one retry is
// not enough. Up to 5 attempts drives the residual probability to negligible.
//
// SIGNATURE CORRECTION (run 27043002569): the prior gate also required
// `res.status === 0 && stdout.trim() === ''` — i.e. it ONLY retried on EMPTY
// stdout. But the underlying defect (process.exit(0) racing an async pipe flush
// in the hook) can truncate stdout to a PARTIAL, non-empty, non-JSON value — for
// which stdout.trim() !== '' and the retry NEVER fired, so subtests 245-248 still
// failed deterministically. The hook itself is now fixed (synchronous fs.writeSync
// in verify-first-full.js), which removes the truncation at the source; this retry
// is kept as defense-in-depth and its gate is corrected to fire whenever JSON is
// mandatory but parsing failed — empty OR partial — regardless of exit status.
//
// This is OPT-IN because many hooks legitimately emit EMPTY stdout on exit 0
// (allow paths) AND mutate state (e.g. swarm-guard appends a spawn-log entry per
// run) — blindly re-spawning those would double their side effects and corrupt
// stateful assertions (a regression a prior agent hit). It is only set by callers
// whose hook MUST emit JSON and is side-effect-free, so a genuinely broken hook
// (deterministically non-JSON) still fails after exhausting attempts; no coverage
// is lost — it just costs a few extra spawns before failing.
const MAX_SPAWN_ATTEMPTS = 5;

function spawnHook(hookAbs, input, env, expectJson) {
  let res = spawnSync(process.execPath, [hookAbs], {
    input, encoding: 'utf8', env, timeout: 10000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) { json = null; }

  // Re-spawn whenever the caller asserts JSON is mandatory but we did NOT get
  // parseable JSON (empty OR partial/truncated stdout — the truncation defect can
  // produce either). Each iteration re-checks the condition so we stop the instant
  // a spawn yields parseable JSON.
  let attempts = 1;
  while (
    expectJson &&
    json === null &&
    attempts < MAX_SPAWN_ATTEMPTS
  ) {
    attempts += 1;
    const next = spawnSync(process.execPath, [hookAbs], {
      input, encoding: 'utf8', env, timeout: 10000,
    });
    let nextJson = null;
    try { nextJson = JSON.parse(next.stdout); } catch (_) { nextJson = null; }
    res = next;
    json = nextJson;
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', json };
}

function testHook(hookRelPathOrAbs, payloadObj, opts = {}) {
  const hookAbs = path.isAbsolute(hookRelPathOrAbs)
    ? hookRelPathOrAbs
    : path.join(HOOKS_DIR, hookRelPathOrAbs);

  const env = {
    ...isolatedEnv(opts.home || process.env.HOME),
    ...(opts.env || {}),
  };

  return spawnHook(hookAbs, JSON.stringify(payloadObj), env, opts.expectJson === true);
}

// testHookRaw(hookRelPathOrAbs, rawStdin, opts={}): like testHook but pipes a
// RAW string to stdin (for fail-open tests: '' empty stdin, '{bad' malformed JSON).
function testHookRaw(hookRelPathOrAbs, rawStdin, opts = {}) {
  const hookAbs = path.isAbsolute(hookRelPathOrAbs)
    ? hookRelPathOrAbs
    : path.join(HOOKS_DIR, hookRelPathOrAbs);
  const env = {
    ...isolatedEnv(opts.home || process.env.HOME),
    ...(opts.env || {}),
  };
  return spawnHook(hookAbs, rawStdin, env, opts.expectJson === true);
}

// Build a PreToolUse Bash payload. When agentId is supplied it lands in the
// PAYLOAD (the cmux-reliable subagent discriminator the hooks read first).
function bashPayload(command, { agentId } = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 't',
    cwd: process.cwd(),
    ...(agentId ? { agent_id: agentId } : {}),
  };
}

// Build a PreToolUse Edit-family payload (Edit, Write, MultiEdit, NotebookEdit).
// When agentId is supplied it lands in the PAYLOAD (the cmux-reliable subagent
// discriminator the hooks read first). For NotebookEdit, opts.filePath is used
// as the notebook_path instead of file_path.
function editPayload(tool, { filePath, agentId, cwd } = {}) {
  const inputPath = tool === 'NotebookEdit'
    ? { notebook_path: filePath }
    : { file_path: filePath };
  return {
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { ...inputPath, old_string: 'x', new_string: 'y' },
    session_id: 't',
    cwd: cwd || process.cwd(),
    ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}),
  };
}

module.exports = { testHook, testHookRaw, bashPayload, editPayload, HOOKS_DIR };
