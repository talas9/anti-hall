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
function isolatedEnv(home) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
  };
  if (process.platform === 'win32') {
    const root = path.parse(home).root; // e.g. "C:\\"
    env.USERPROFILE = home;
    env.HOMEDRIVE = root;
    env.HOMEPATH = home.slice(root.length);
  }
  return env;
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
// empty. The race can hit consecutive spawns, so one retry is not enough. Up to
// 4 attempts drives the residual all-empty probability to negligible (p^4 for a
// per-spawn empty rate p; even a pessimistic p=0.05 gives ~6e-6).
//
// This is OPT-IN because many hooks legitimately emit EMPTY stdout on exit 0
// (allow paths) AND mutate state (e.g. swarm-guard appends a spawn-log entry per
// run) — blindly re-spawning those would double their side effects and corrupt
// stateful assertions (a regression a prior agent hit). We ONLY re-spawn on the
// empty+exit0 signature, so a genuinely broken JSON-emitting hook (non-empty
// non-JSON, or a non-zero exit) is NOT retried and still fails deterministically;
// no coverage is lost.
const MAX_SPAWN_ATTEMPTS = 4;

function spawnHook(hookAbs, input, env, expectJson) {
  let res = spawnSync(process.execPath, [hookAbs], {
    input, encoding: 'utf8', env, timeout: 10000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) { json = null; }

  // Re-spawn ONLY on the empty-stdout+exit0 flake signature, when the caller
  // asserts JSON is mandatory. Each iteration re-checks the same signature so we
  // stop the instant a spawn yields parseable JSON (or hits a real failure).
  let attempts = 1;
  while (
    expectJson &&
    json === null &&
    res.status === 0 &&
    (res.stdout || '').trim() === '' &&
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

module.exports = { testHook, testHookRaw, bashPayload, HOOKS_DIR };
