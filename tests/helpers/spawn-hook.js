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

// testHook(hookRelPathOrAbs, payloadObj, opts={}):
//   - hookRelPathOrAbs: a bare hook filename (e.g. 'git-guard.js'), a path under
//     the hooks dir, or an absolute path.
//   - payloadObj: the JSON object piped to the hook on stdin.
//   - opts.home: HOME for the child (fake home). Defaults to process.env.HOME.
//   - opts.env: extra env vars merged onto the controlled base.
// Returns { status, stdout, stderr, json } where json is JSON.parse(stdout) or null.
function testHook(hookRelPathOrAbs, payloadObj, opts = {}) {
  const hookAbs = path.isAbsolute(hookRelPathOrAbs)
    ? hookRelPathOrAbs
    : path.join(HOOKS_DIR, hookRelPathOrAbs);

  const env = {
    PATH: process.env.PATH,
    HOME: opts.home || process.env.HOME,
    ...(opts.env || {}),
  };

  const res = spawnSync(process.execPath, [hookAbs], {
    input: JSON.stringify(payloadObj),
    encoding: 'utf8',
    env,
    timeout: 10000,
  });

  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch (_) {
    json = null;
  }

  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    json,
  };
}

// testHookRaw(hookRelPathOrAbs, rawStdin, opts={}): like testHook but pipes a
// RAW string to stdin (for fail-open tests: '' empty stdin, '{bad' malformed JSON).
function testHookRaw(hookRelPathOrAbs, rawStdin, opts = {}) {
  const hookAbs = path.isAbsolute(hookRelPathOrAbs)
    ? hookRelPathOrAbs
    : path.join(HOOKS_DIR, hookRelPathOrAbs);
  const env = {
    PATH: process.env.PATH,
    HOME: opts.home || process.env.HOME,
    ...(opts.env || {}),
  };
  const res = spawnSync(process.execPath, [hookAbs], {
    input: rawStdin,
    encoding: 'utf8',
    env,
    timeout: 10000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch (_) { json = null; }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', json };
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
