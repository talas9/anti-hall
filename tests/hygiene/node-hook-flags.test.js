'use strict';
// node-hook-flags: the transcript-heavy hook commands run node with
// --no-concurrent-recompilation --no-concurrent-sparkplug. Without them Node 24+ can deadlock in process.exit()
// (a background Maglev/Sparkplug compile waits for a main-thread GC while the main
// thread waits to join it; nodejs/node#54918, #64274) and the hook hangs until the
// harness timeout. See plugins/anti-hall/hooks/lib/node-hook-flags.js.
//
// The statistical regression check at the bottom is slow (hundreds of hook runs),
// so it only runs with ANTIHALL_SLOW_TESTS=1.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(REPO, 'plugins', 'anti-hall');
const HOOKS = path.join(PLUGIN, 'hooks');
const { NODE_HOOK_FLAGS, EXPOSED_HOOKS } = require(path.join(HOOKS, 'lib', 'node-hook-flags.js'));
const PREFIX = 'node ' + NODE_HOOK_FLAGS.join(' ') + ' ';

function commands(file) {
  const out = [];
  const hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
  for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) out.push(h.command);
  return out;
}

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-node-flags-')); }

function run(flags, hook, payload, home, extraEnv, timeout) {
  return spawnSync(process.execPath, [...flags, path.join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    env: Object.assign({ PATH: process.env.PATH, HOME: home, ANTIHALL_TEST_ISOLATION: '1' }, extraEnv || {}),
    encoding: 'utf8',
    timeout: timeout || 30000,
    killSignal: 'SIGKILL',
  });
}

// Each command is either the plain 0.122.0 form or, for a script in EXPOSED_HOOKS
// only, the same form with the flags inserted after `node`.
function check(cmds, root) {
  const plain = new RegExp('^node "\\$\\{' + root + '\\}/hooks/([\\w-]+\\.js)"( --audit| --post)?$');
  const bad = [];
  const flagged = new Set();
  for (const c of cmds) {
    const isFlagged = c.startsWith(PREFIX);
    const m = (isFlagged ? 'node ' + c.slice(PREFIX.length) : c).match(plain);
    if (!m) { bad.push(c); continue; }
    const exposed = Object.prototype.hasOwnProperty.call(EXPOSED_HOOKS, m[1]);
    if (exposed !== isFlagged) bad.push(c);
    if (isFlagged) flagged.add(m[1]);
  }
  return { bad, flagged };
}

test('exactly the EXPOSED_HOOKS entries carry the flags; every other command keeps the plain form', () => {
  const claudeCmds = commands(path.join(HOOKS, 'hooks.json'));
  const codexCmds = commands(path.join(PLUGIN, 'codex', 'hooks', 'hooks.json'));
  assert.ok(claudeCmds.length > 50 && codexCmds.length > 30, `expected the full hook sets, got ${claudeCmds.length}/${codexCmds.length}`);
  const claude = check(claudeCmds, 'CLAUDE_PLUGIN_ROOT');
  const codex = check(codexCmds, 'PLUGIN_ROOT');
  assert.deepStrictEqual(claude.bad, []);
  assert.deepStrictEqual(codex.bad, []);
  // every exposed script is registered for Claude and flagged there
  assert.deepStrictEqual([...claude.flagged].sort(), Object.keys(EXPOSED_HOOKS).sort());
  assert.ok(claude.flagged.has('silent-agent-nudge.js') && codex.flagged.has('silent-agent-nudge.js'));
  for (const f of Object.keys(EXPOSED_HOOKS)) assert.ok(fs.existsSync(path.join(HOOKS, f)), f);
});

test('install-codex flags the same scripts and nothing else', () => {
  const { ANTI_HALL_HOOKS } = require(path.join(PLUGIN, 'codex', 'install-codex.js'));
  const cmds = [];
  for (const groups of Object.values(ANTI_HALL_HOOKS)) for (const g of groups) for (const h of g.hooks) cmds.push(h.command);
  assert.ok(cmds.length > 30);
  const bad = cmds.filter((c) => {
    const file = path.basename(JSON.parse(c.match(/"(?:[^"\\]|\\.)*"/)[0]));
    return c.startsWith(PREFIX + '"') !== Object.prototype.hasOwnProperty.call(EXPOSED_HOOKS, file);
  });
  assert.deepStrictEqual(bad, []);
});

test('this Node accepts the flags (an unknown V8 flag makes node refuse to start)', () => {
  const r = spawnSync(process.execPath, [...NODE_HOOK_FLAGS, '-e', '0'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '');
});

test('the flags leave hook exit code, stdout and stderr unchanged', () => {
  const cases = [
    // exit 2 + stderr reason (blocking PreToolUse guard)
    ['git-guard.js', { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' }, hook_event_name: 'PreToolUse' }],
    // exit 0 + stdout JSON (UserPromptSubmit context injection)
    ['verify-first.js', { prompt: 'fix the bug in foo.js', session_id: 'flags-1', hook_event_name: 'UserPromptSubmit', cwd: os.tmpdir() }],
    // exit 0, silent (allowed command)
    ['git-guard.js', { tool_name: 'Bash', tool_input: { command: 'git status' }, hook_event_name: 'PreToolUse' }],
  ];
  for (const [hook, payload] of cases) {
    const homes = [tmpHome(), tmpHome()];
    try {
      const a = run([], hook, payload, homes[0]);
      const b = run(NODE_HOOK_FLAGS, hook, payload, homes[1]);
      assert.strictEqual(b.status, a.status, hook + ' exit code');
      assert.strictEqual(b.stdout, a.stdout, hook + ' stdout');
      assert.strictEqual(b.stderr, a.stderr, hook + ' stderr');
    } finally {
      for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
    }
  }
});

// writeSessionTranscript(file) — a session-shaped transcript (~15 MB): metadata-rich
// lines, Read results whose body also sits in toolUseResult.file.content, and a few
// background Agent launches that later complete. It makes silent-agent-nudge do a
// full scan, the work that preceded every observed hang.
function writeSessionTranscript(file) {
  const fd = fs.openSync(file, 'w');
  const W = 'lorem ipsum dolor sit amet "q" {x} \n path/a.js 0a1b2c ';
  const fill = (n) => W.repeat(Math.ceil(n / W.length)).slice(0, n);
  let n = 0;
  let prev = null;
  const meta = (type) => {
    const uuid = 'u' + (n++).toString(16).padStart(11, '0');
    const m = { parentUuid: prev, isSidechain: false, type, uuid, timestamp: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(), userType: 'external', entrypoint: 'cli', cwd: '/work/project', sessionId: 'syn-1', version: '2.1.0', gitBranch: 'main' };
    prev = uuid;
    return m;
  };
  const w = (o) => fs.writeSync(fd, JSON.stringify(o) + '\n');
  let agents = 0;
  for (let i = 0; i < 500; i++) {
    for (let h = 0; h < 2; h++) w(Object.assign(meta('attachment'), { attachment: { type: 'hook_success', hookName: 'Stop', content: fill(200 + (i * 37 % 800)) } }));
    const tu = 'toolu_' + i;
    if (i % 30 === 5) {
      const id = 'a' + (agents++).toString(16).padStart(15, '0');
      w(Object.assign(meta('assistant'), { message: { role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Agent', input: { description: 'job ' + i, run_in_background: true, prompt: fill(3000) } }] } }));
      w(Object.assign(meta('user'), { message: { role: 'user', content: [{ tool_use_id: tu, type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: ' + id + ' (internal ID)\noutput_file: /nonexistent/tasks/' + id + '.output\n' }] }] } }));
      w(Object.assign(meta('user'), { message: { role: 'user', content: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>' } }));
      continue;
    }
    const big = i % 20 === 7;
    const read = big || i % 3 === 0;
    w(Object.assign(meta('assistant'), { message: { role: 'assistant', content: [{ type: 'text', text: fill(300) }, { type: 'tool_use', id: tu, name: read ? 'Read' : 'Bash', input: read ? { file_path: '/work/f' + i + '.js' } : { command: fill(150) } }] } }));
    const body = fill(big ? 120000 + (i * 7919 % 360000) : 300 + (i * 131 % 3000));
    w(Object.assign(meta('user'), { message: { role: 'user', content: [{ tool_use_id: tu, type: 'tool_result', content: body }] }, toolUseResult: read ? { type: 'text', file: { filePath: '/work/f' + i + '.js', content: body, numLines: 100, startLine: 1, totalLines: 100 } } : { stdout: body, stderr: '', interrupted: false } }));
  }
  fs.closeSync(fd);
}

// Opt-in: ANTIHALL_SLOW_TESTS=1 [ANTIHALL_EXITHANG_RUNS=600] [ANTIHALL_EXITHANG_TRANSCRIPT=<real .jsonl>].
// Runs silent-agent-nudge with the shipped flags N times, 5 s per run, and requires
// zero hangs. The unflagged hang count is reported, not asserted: it is ~1% on a real
// 14.8 MB transcript under Node 24/26, 0 on Node 22, and the synthetic transcript has
// not reproduced it, so pass ANTIHALL_EXITHANG_TRANSCRIPT to make the baseline meaningful.
test('statistical: no exit-time hang with the shipped flags', { skip: process.env.ANTIHALL_SLOW_TESTS !== '1' && 'set ANTIHALL_SLOW_TESTS=1' }, (t) => {
  const runs = Number(process.env.ANTIHALL_EXITHANG_RUNS) || 600;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-exithang-'));
  try {
    let transcript = process.env.ANTIHALL_EXITHANG_TRANSCRIPT;
    if (!transcript) {
      transcript = path.join(dir, 'syn-1.jsonl');
      writeSessionTranscript(transcript);
    }
    const payload = { session_id: 'syn-1', transcript_path: transcript, cwd: dir, hook_event_name: 'Stop', stop_hook_active: false };
    const env = { ANTIHALL_INGEST_DRY_RUN: '1' };
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const count = (flags) => {
      let hangs = 0;
      for (let i = 0; i < runs; i++) {
        const r = run(flags, 'silent-agent-nudge.js', payload, home, env, 5000);
        if (r.error && r.error.code === 'ETIMEDOUT') hangs++;
        else assert.strictEqual(r.status, 0, r.stderr);
      }
      return hangs;
    };
    const flagged = count(NODE_HOOK_FLAGS);
    const unflagged = count([]);
    t.diagnostic(`node ${process.version}: hangs with flags ${flagged}/${runs}, without ${unflagged}/${runs}, load ${os.loadavg()[0].toFixed(1)}`);
    assert.strictEqual(flagged, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
