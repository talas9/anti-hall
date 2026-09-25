'use strict';
// companion/lib/devswarm-idle.js — the auto-archive idle gate's transcript
// classifier (0.109.0). SAFETY PRINCIPLE: when in doubt a turn is REAL work —
// an extra reset only delays archiving, a false "ping" archives a child
// mid-work. Pure-function tests; nothing here touches a home directory.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const I = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-idle.js'));

const CLI = '/x/anti-hall/scripts/devswarm.js';
const WATCH = '/x/anti-hall/companion/lib/devswarm-wake-watch.js';
const T0 = Date.parse('2026-09-24T10:00:00Z');
const MIN = 60000;
const iso = (t) => new Date(t).toISOString();
const bash = (command, extra) => ({ type: 'tool_use', name: 'Bash', input: Object.assign({ command }, extra || {}) });
const monitor = (command) => ({ type: 'tool_use', name: 'Monitor', input: { command, description: 'devswarm mailbox wake watcher' } });

// ---------------------------------------------------------------------------
// P2 — isMailboxTool is a strict allowlist.
test('mailbox allowlist: plain `node <path>/devswarm.js <inbox|heartbeat|roster|mesh> <plain args>` only', () => {
  for (const cmd of [
    'node ' + CLI + ' inbox tick c1 --child',
    'node ' + CLI + ' inbox read-primary c1',
    'node ' + CLI + ' heartbeat c1',
    'node ' + CLI + ' heartbeat c1 --summary "done, awaiting auto-archive"',
    'node ' + CLI + ' roster',
    'node ' + CLI + ' mesh read',
    '  node ' + CLI + ' inbox count c1  ',
  ]) assert.strictEqual(I.isMailboxTool(bash(cmd)), true, cmd);
});

test('mailbox allowlist: any shell metacharacter, pipe reader, chain or other verb is REAL work', () => {
  const base = 'node ' + CLI + ' inbox tick c1 --child';
  for (const cmd of [
    base + ' | python3 -c "import os; os.system(\'git push\')"',
    base + ' <(git push)',
    'node ' + CLI + ' inbox tick <(git push)',
    base + ' > /repo/file',
    base + ' >> /repo/file',
    base + ' < /etc/passwd',
    base + ' | sed -e w/x',
    base + ' | sed -n p',
    base + ' | jq .',
    base + ' | sort',
    base + ' 2>/dev/null',
    base + '; make',
    base + ' && git push',
    base + ' || git push',
    base + ' & git push',
    base + '\ngit push',
    base + ' $(git push)',
    base + ' `git push`',
    base + ' (git push)',
    base + ' {a,b}',
    'git push; ' + base,
    'CLI=' + CLI + '; node "$CLI" inbox tick c1',
    'node "$CLI" inbox tick c1',
    'node ' + CLI + ' inbox tick $X',
    'cd /repo && ' + base,
    'node ' + CLI + ' send --to-primary --message-file /tmp/a',
    'node ' + CLI + ' done --summary merged',
    'node ' + CLI + ' gate c1 done',
    'node ' + CLI + ' wake-directive c1',
    'node ' + CLI + ' archive c1',
    'node /x/evil.js inbox tick c1',
    'node ' + CLI + '.bak inbox tick c1',
    'node -e "require(\'child_process\')" ' + CLI + ' inbox',
    'node ' + CLI,
    'python3 ' + CLI + ' inbox tick c1',
    'node ' + CLI + ' inbox tick c1 --summary "$(git push)"',
  ]) assert.strictEqual(I.isMailboxTool(bash(cmd)), false, JSON.stringify(cmd));
  // a backgrounded mailbox command is not a ping either.
  assert.strictEqual(I.isMailboxTool(bash(base, { run_in_background: true })), false);
  assert.strictEqual(I.isMailboxTool(bash(base, { run_in_background: 'true' })), false);
});

test('mailbox allowlist: provably read-only tails — optional `2>&1`, then `| grep|head|tail|wc <plain tokens>` — stay a ping', () => {
  for (const cmd of [
    'node ' + CLI + ' inbox tick c1 --child 2>&1 | grep -oE \'"ok":[^,]*\' | head -3',
    'node ' + CLI + ' inbox tick c1 --child 2>&1',
    'node ' + CLI + ' inbox tick c1 --child | head -1',
    'node ' + CLI + ' inbox tick c1 --child 2>&1 | grep -o -E \'"(ok|unreadTotal)":[a-z0-9]+\' | wc -l',
    'node ' + CLI + ' heartbeat c1 --summary "done; idle && awaiting auto-archive" 2>&1 | tail -2',
    'node ' + CLI + ' inbox read-primary c1 | grep -c unread',
  ]) assert.strictEqual(I.isMailboxTool(bash(cmd)), true, JSON.stringify(cmd));
});

test('mailbox allowlist: any other tail is REAL work (writers, file redirects, other filters, grep -f)', () => {
  const base = 'node ' + CLI + ' inbox tick c1 --child';
  for (const cmd of [
    base + ' | grep x > /repo/f',
    base + ' 2>&1 | grep x >> /repo/f',
    base + ' | tee /repo/f',
    base + ' | tee',
    base + ' | awk 1',
    base + ' | xargs rm',
    base + ' | sed -n p',
    base + ' | sort',
    base + ' | jq .',
    base + ' | python3 -c "print(1)"',
    base + ' | grep -f /etc/patterns',
    base + ' | grep -rf /etc/patterns',
    base + ' | grep --file=/etc/patterns',
    base + ' | grep --file /etc/patterns',
    base + ' 2> /tmp/err',
    base + ' 2>/tmp/err',
    base + ' >&2',
    base + ' 2>&1 > /repo/f',
    base + ' | grep x 2>&1',
    base + ' 2>&1 2>&1',
    base + ' |',
    base + ' | | head',
    base + ' || head',
    base + ' | grep $(git push)',
    base + ' | grep "$X"',
    base + ' | grep `x`',
    base + ' | grep x; make',
    base + ' | head -1 & make',
    base + ' | head <(git push)',
    base + ' | grep \'a\'b',
    base + ' | GREP=1 grep x',
    base + ' | /usr/bin/grep x',
    'grep x | ' + base,
    'head -1 /etc/passwd',
  ]) assert.strictEqual(I.isMailboxTool(bash(cmd)), false, JSON.stringify(cmd));
});

test('mailbox allowlist: a Monitor is a ping only when it runs EXACTLY the wake watcher', () => {
  assert.strictEqual(I.isMailboxTool(monitor('node ' + WATCH)), true);
  assert.strictEqual(I.isMailboxTool(monitor('node ' + WATCH + ' --interval 30')), true);
  for (const cmd of [
    'node ' + WATCH + '; make',
    'node ' + WATCH + ' && make',
    'node ' + WATCH + ' | tee /repo/x',
    'node ' + WATCH + ' > /repo/x',
    'make; node ' + WATCH,
    'bash -c "node ' + WATCH + '"',
    'node /x/devswarm-wake-watch.js.evil',
    'node /x/other.js devswarm-wake-watch.js',
    'tail -f /var/log/x # devswarm-wake-watch.js',
    'node "$WATCH"',
    'node ' + WATCH + ' $(git push)',
  ]) assert.strictEqual(I.isMailboxTool(monitor(cmd)), false, JSON.stringify(cmd));
});

// ---------------------------------------------------------------------------
// transcript builder
function tr() {
  const lines = [];
  let n = 0;
  const api = {
    raw(o) { lines.push(o); return api; },
    prompt(t, text, extra) { lines.push(Object.assign({ type: 'user', timestamp: iso(t), message: { role: 'user', content: text } }, extra || {})); return api; },
    cron(t, text) { lines.push({ type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(t) }); return api.prompt(t, text, { isMeta: true }); },
    tool(t, name, input, result) {
      const id = 'toolu_' + (++n);
      lines.push({ type: 'assistant', timestamp: iso(t), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
      lines.push(Object.assign({ type: 'user', timestamp: iso(t + 500), message: { role: 'user', content: [Object.assign({ type: 'tool_result', tool_use_id: id, content: 'ok' }, (result && result.block) || {})] } },
        result && result.toolUseResult ? { toolUseResult: result.toolUseResult } : {}));
      api.lastId = id;
      return api;
    },
    say(t, text) { lines.push({ type: 'assistant', timestamp: iso(t), message: { role: 'assistant', content: [{ type: 'text', text }] } }); return api; },
    stop(t, pending) {
      lines.push({ type: 'system', subtype: 'stop_hook_summary', timestamp: iso(t) });
      const td = { type: 'system', subtype: 'turn_duration', timestamp: iso(t), durationMs: 1000 };
      if (pending !== undefined) td.pendingBackgroundAgentCount = pending;
      lines.push(td);
      return api;
    },
    text() { return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'; },
  };
  return api;
}
function ping(t, at) {
  return t.cron(at, 'Mailbox wake: run `node ' + CLI + ' inbox tick c1 --child`.')
    .tool(at + 1000, 'Bash', { command: 'node ' + CLI + ' inbox tick c1 --child' })
    .say(at + 2000, 'No unread mail.')
    .stop(at + 3000, 0);
}
const notif = (taskId, toolUseId, status) => '<task-notification>\n<task-id>' + taskId + '</task-id>\n'
  + (toolUseId ? '<tool-use-id>' + toolUseId + '</tool-use-id>\n' : '') + '<output-file>/tmp/x.output</output-file>\n'
  + '<status>' + status + '</status>\n<summary>Agent "x" ' + status + '</summary>\n</task-notification>';

test('baseline: a done child whose later turns are only plain pings is idle since its real work', () => {
  const t = tr().prompt(T0, 'Fix it.').tool(T0 + MIN, 'Edit', { file_path: '/wt/x.js' }).say(T0 + 2 * MIN, 'Done.').stop(T0 + 2 * MIN, 0);
  ping(t, T0 + 30 * MIN); ping(t, T0 + 60 * MIN);
  const r = I.classifyTranscript(t.text());
  assert.strictEqual(r.pingTurns, 2);
  assert.strictEqual(r.pendingBackground, false);
  assert.strictEqual(r.realTs, T0 + 2 * MIN);
});

// ---------------------------------------------------------------------------
// P1 — background work the idle clock cannot see.
test('P1: latest real turn ended with pendingBackgroundAgentCount > 0 -> pending, even behind later pings', () => {
  const t = tr().prompt(T0, 'Investigate.').tool(T0 + MIN, 'Read', { file_path: '/wt/x.js' }).say(T0 + 2 * MIN, 'waiting').stop(T0 + 2 * MIN, 1);
  ping(t, T0 + 30 * MIN); ping(t, T0 + 60 * MIN);
  const r = I.classifyTranscript(t.text());
  assert.strictEqual(r.pendingBackground, true, JSON.stringify(r));
});

test('P1: a ping turn reporting pendingBackgroundAgentCount > 0 also counts (pings never hide pending work)', () => {
  const t = tr().prompt(T0, 'Fix.').tool(T0 + MIN, 'Edit', { file_path: '/wt/x.js' }).stop(T0 + 2 * MIN, 0);
  t.cron(T0 + 30 * MIN, 'Mailbox wake').tool(T0 + 30 * MIN, 'Bash', { command: 'node ' + CLI + ' inbox tick c1 --child' }).stop(T0 + 31 * MIN, 2);
  assert.strictEqual(I.classifyTranscript(t.text()).pendingBackground, true);
});

test('P1: the harness omits pendingBackgroundAgentCount when it is 0 — a later turn_duration without it clears an earlier count', () => {
  const t = tr().prompt(T0, 'Investigate.').tool(T0 + MIN, 'Read', { file_path: '/wt/x.js' }).stop(T0 + 2 * MIN, 1)
    .prompt(T0 + 10 * MIN, 'status?').say(T0 + 11 * MIN, 'the audit finished').stop(T0 + 11 * MIN) // field absent
    .cron(T0 + 30 * MIN, 'Mailbox wake').tool(T0 + 30 * MIN, 'Bash', { command: 'node ' + CLI + ' inbox tick c1 --child' }).stop(T0 + 31 * MIN); // field absent
  assert.strictEqual(I.classifyTranscript(t.text()).pendingBackground, false);
});

test('P1: a background Agent launch (run_in_background "true" string, as the harness records it) with no completion -> pending', () => {
  const t = tr().prompt(T0, 'Investigate.')
    .tool(T0 + MIN, 'Agent', { description: 'x', prompt: 'y', run_in_background: 'true' }, { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1b2c3' } })
    .say(T0 + 2 * MIN, 'launched').stop(T0 + 2 * MIN); // no turn_duration count at all
  ping(t, T0 + 30 * MIN); ping(t, T0 + 60 * MIN);
  assert.strictEqual(I.classifyTranscript(t.text()).pendingBackground, true);
});

test('P1: a background Bash launch with no completion -> pending; its completion notification clears it', () => {
  const mk = () => {
    const t = tr().prompt(T0, 'Run the suite.')
      .tool(T0 + MIN, 'Bash', { command: 'npm test', run_in_background: true }, { toolUseResult: { stdout: '', stderr: '', backgroundTaskId: 'bq1x2' } });
    return t.say(T0 + 2 * MIN, 'running').stop(T0 + 2 * MIN);
  };
  const t = mk(); ping(t, T0 + 30 * MIN);
  assert.strictEqual(I.classifyTranscript(t.text()).pendingBackground, true);
  const done = mk();
  done.prompt(T0 + 10 * MIN, notif('bq1x2', null, 'Completed')).say(T0 + 11 * MIN, 'suite green').stop(T0 + 11 * MIN, 0);
  ping(done, T0 + 40 * MIN);
  assert.strictEqual(I.classifyTranscript(done.text()).pendingBackground, false);
});

test('P1: completion matched by task-id or tool-use-id; failed/stopped close it; several notifications in one text leaf', () => {
  const t = tr().prompt(T0, 'Fan out.');
  t.tool(T0 + MIN, 'Agent', { prompt: 'a', run_in_background: true }, { toolUseResult: { agentId: 'agA' } });
  const tuB = (t.tool(T0 + MIN, 'Agent', { prompt: 'b', run_in_background: true }, { toolUseResult: { agentId: 'agB' } }), t.lastId);
  t.tool(T0 + MIN, 'Bash', { command: 'sleep 99', run_in_background: true }, { toolUseResult: { backgroundTaskId: 'bgC' } });
  t.stop(T0 + 2 * MIN);
  // all three close in ONE array-content text leaf, and via the queued-command attachment carrier.
  const closeAll = { type: 'user', timestamp: iso(T0 + 5 * MIN), message: { role: 'user', content: [{ type: 'text', text: notif('agA', null, 'completed') + '\n' + notif('zzz', tuB, 'FAILED') + '\n' + notif('bgC', null, 'stopped') }] } };
  const partial = { type: 'user', timestamp: iso(T0 + 5 * MIN), message: { role: 'user', content: [{ type: 'text', text: notif('agA', null, 'completed') + notif('bgC', null, 'stopped') }] } };
  const base = t.text();
  assert.strictEqual(I.classifyTranscript(base + JSON.stringify(closeAll) + '\n').pendingBackground, false);
  assert.strictEqual(I.classifyTranscript(base + JSON.stringify(partial) + '\n').pendingBackground, true, 'agB still running');
  const att = { type: 'attachment', timestamp: iso(T0 + 5 * MIN), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: notif('agA', null, 'completed') + notif('agB', null, 'completed') + notif('bgC', null, 'completed') } };
  assert.strictEqual(I.classifyTranscript(base + JSON.stringify(att) + '\n').pendingBackground, false);
});

test('P1: a Monitor event notification (no status) and an unrelated id never close a launch', () => {
  const t = tr().prompt(T0, 'Watch.')
    .tool(T0 + MIN, 'Agent', { prompt: 'a', run_in_background: true }, { toolUseResult: { agentId: 'agA' } }).stop(T0 + 2 * MIN)
    .prompt(T0 + 3 * MIN, '<task-notification>\n<task-id>agA</task-id>\n<summary>Monitor event</summary>\n<event>tick</event>\n</task-notification>')
    .say(T0 + 3 * MIN, 'x').stop(T0 + 3 * MIN)
    .prompt(T0 + 4 * MIN, notif('other', 'toolu_999', 'completed')).say(T0 + 4 * MIN, 'x').stop(T0 + 4 * MIN);
  assert.strictEqual(I.classifyTranscript(t.text()).pendingBackground, true);
});

test('P1: a background launch whose tool_result is an error never started -> not pending', () => {
  const t = tr().prompt(T0, 'Try.')
    .tool(T0 + MIN, 'Bash', { command: 'npm test', run_in_background: true }, { block: { is_error: true, content: 'denied' }, toolUseResult: 'Error: denied' })
    .stop(T0 + 2 * MIN, 0);
  assert.strictEqual(I.classifyTranscript(t.text()).pendingBackground, false);
});

// ---------------------------------------------------------------------------
// P2 — a leftover cron flag never turns a human prompt into a wake.
test('P2: a cron fire followed by a human (non-meta) prompt -> that prompt is NOT a wake', () => {
  const t = tr().prompt(T0, 'Fix it.').tool(T0 + MIN, 'Edit', { file_path: '/wt/x.js' }).stop(T0 + 2 * MIN, 0);
  // the fire's own prompt never lands (e.g. dropped), then a human types.
  t.raw({ type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(T0 + 30 * MIN) });
  t.prompt(T0 + 31 * MIN, 'what is the status?')
    .tool(T0 + 32 * MIN, 'Bash', { command: 'node ' + CLI + ' inbox tick c1 --child' })
    .say(T0 + 33 * MIN, 'all quiet').stop(T0 + 33 * MIN, 0);
  const r = I.classifyTranscript(t.text());
  assert.strictEqual(r.realTs, T0 + 33 * MIN, JSON.stringify(r));
  assert.strictEqual(r.pingTurns, 0);
});

test('P2: a human prompt consumes a pending cron flag; a later meta line is not a wake from it', () => {
  const t = tr().prompt(T0, 'Fix it.').stop(T0 + MIN, 0);
  t.raw({ type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(T0 + 30 * MIN) });
  t.prompt(T0 + 31 * MIN, 'quick question: which file?')
    .say(T0 + 31 * MIN, 'x.js').stop(T0 + 31 * MIN, 0)
    .prompt(T0 + 40 * MIN, 'Mailbox wake', { isMeta: true })
    .tool(T0 + 41 * MIN, 'Bash', { command: 'node ' + CLI + ' inbox tick c1 --child' }).stop(T0 + 42 * MIN, 0);
  const r = I.classifyTranscript(t.text());
  assert.strictEqual(r.pingTurns, 0, JSON.stringify(r));
  assert.strictEqual(r.realTs, T0 + 41 * MIN + 500, "the meta wake line joined the human turn (last entry = its tool_result)");
  // the ordinary shape (fire, then bookkeeping lines, then its meta prompt) stays a ping.
  const ok = tr().prompt(T0, 'Fix it.').stop(T0 + MIN, 0);
  ok.raw({ type: 'system', subtype: 'scheduled_task_fire', timestamp: iso(T0 + 30 * MIN) })
    .raw({ type: 'system', subtype: 'stop_hook_summary', timestamp: iso(T0 + 30 * MIN) })
    .raw({ type: 'last-prompt', timestamp: iso(T0 + 30 * MIN) })
    .prompt(T0 + 30 * MIN, 'Mailbox wake', { isMeta: true })
    .tool(T0 + 31 * MIN, 'Bash', { command: 'node ' + CLI + ' inbox tick c1 --child' }).stop(T0 + 32 * MIN, 0);
  assert.strictEqual(I.classifyTranscript(ok.text()).pingTurns, 1);
});

// ---------------------------------------------------------------------------
// Bug 2 part 1 — waiting-on-input. A child's "busy" (fresh heartbeat / live
// pid) is true both while it is ACTIVELY WORKING and while its own session
// is stuck on an unanswered AskUserQuestion. `openWaitingTool` (in
// classifyTranscript) names the last turn's unresolved tool call so the
// caller (waitingOnUserInput) can tell those two apart without a second
// transcript parser.
test('waiting-on-input: last turn open on an AskUserQuestion with no tool_result -> openWaitingTool is AskUserQuestion', () => {
  const t = tr().prompt(T0, 'Ship the migration.')
    .tool(T0 + MIN, 'Read', { file_path: '/wt/x.js' });
  t.raw({
    type: 'assistant', timestamp: iso(T0 + 2 * MIN),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ask1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which env?' }] } }] },
  });
  const r = I.classifyTranscript(t.text());
  assert.strictEqual(r.openRealTurn, true, JSON.stringify(r));
  assert.strictEqual(r.openWaitingTool, 'AskUserQuestion', JSON.stringify(r));
});

test('waiting-on-input: last turn open on a still-running Bash (no tool_result) -> openWaitingTool is Bash, NOT AskUserQuestion (real work, not a human wait)', () => {
  const t = tr().prompt(T0, 'Run the suite.');
  t.raw({
    type: 'assistant', timestamp: iso(T0 + MIN),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'npm test' } }] },
  });
  const r = I.classifyTranscript(t.text());
  assert.strictEqual(r.openRealTurn, true, JSON.stringify(r));
  assert.strictEqual(r.openWaitingTool, 'Bash', JSON.stringify(r));
});

test('waiting-on-input: a CLOSED last turn (stop_hook_summary/turn_duration present) -> openWaitingTool is null even with an earlier unresolved tool', () => {
  const t = tr().prompt(T0, 'Fix it.').tool(T0 + MIN, 'Edit', { file_path: '/wt/x.js' }).say(T0 + 2 * MIN, 'Done.').stop(T0 + 2 * MIN, 0);
  const r = I.classifyTranscript(t.text());
  assert.strictEqual(r.openWaitingTool, null, JSON.stringify(r));
});

test('waiting-on-input: the AskUserQuestion already got its tool_result (answered), then a later unresolved Bash is what is actually open', () => {
  const t = tr().prompt(T0, 'Ship it.')
    .tool(T0 + MIN, 'AskUserQuestion', { questions: [{ question: 'Which env?' }] }) // answered — .tool() writes the tool_result
    .prompt(T0 + 2 * MIN, 'staging'); // human answered, new turn opens
  t.raw({
    type: 'assistant', timestamp: iso(T0 + 3 * MIN),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash2', name: 'Bash', input: { command: 'deploy staging' } }] },
  });
  const r = I.classifyTranscript(t.text());
  assert.strictEqual(r.openWaitingTool, 'Bash', JSON.stringify(r));
});

// waitingOnUserInput(desc, home, opts) — the realActivity-backed wrapper
// devswarm-parent-gate.js calls. Isolated fixture HOME per the repo's own
// "tests never touch the real home" rule; nothing here writes outside its
// own mkdtemp dir.
function isoHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-idle-test-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function writeTranscriptFor(home, worktreePath, sessionId, text) {
  const liveness = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js'));
  const dir = liveness.projectDirFor(worktreePath, home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), text);
}

test('waitingOnUserInput: an open AskUserQuestion in the child\'s own transcript -> true', () => {
  const h = isoHome();
  try {
    const wt = path.join(h.home, 'wt', 'c1');
    const t = tr().prompt(T0, 'Ship the migration.').tool(T0 + MIN, 'Read', { file_path: '/wt/x.js' });
    t.raw({
      type: 'assistant', timestamp: iso(T0 + 2 * MIN),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ask2', name: 'AskUserQuestion', input: { questions: [{ question: 'Which env?' }] } }] },
    });
    writeTranscriptFor(h.home, wt, 'sess-c1', t.text());
    assert.strictEqual(I.waitingOnUserInput({ id: 'c1', sessionId: 'sess-c1', worktreePath: wt }, h.home), true);
  } finally { h.cleanup(); }
});

test('waitingOnUserInput: an open, still-running Bash (genuinely working) -> false', () => {
  const h = isoHome();
  try {
    const wt = path.join(h.home, 'wt', 'c2');
    const t = tr().prompt(T0, 'Run the suite.');
    t.raw({
      type: 'assistant', timestamp: iso(T0 + MIN),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash3', name: 'Bash', input: { command: 'npm test' } }] },
    });
    writeTranscriptFor(h.home, wt, 'sess-c2', t.text());
    assert.strictEqual(I.waitingOnUserInput({ id: 'c2', sessionId: 'sess-c2', worktreePath: wt }, h.home), false);
  } finally { h.cleanup(); }
});

test('waitingOnUserInput: a closed (finished) turn -> false', () => {
  const h = isoHome();
  try {
    const wt = path.join(h.home, 'wt', 'c3');
    const t = tr().prompt(T0, 'Fix it.').tool(T0 + MIN, 'Edit', { file_path: '/wt/x.js' }).say(T0 + 2 * MIN, 'Done.').stop(T0 + 2 * MIN, 0);
    writeTranscriptFor(h.home, wt, 'sess-c3', t.text());
    assert.strictEqual(I.waitingOnUserInput({ id: 'c3', sessionId: 'sess-c3', worktreePath: wt }, h.home), false);
  } finally { h.cleanup(); }
});

test('waitingOnUserInput: no transcript at all -> false (caller falls back to its own pre-existing busy check)', () => {
  const h = isoHome();
  try {
    assert.strictEqual(I.waitingOnUserInput({ id: 'c4', sessionId: 'sess-c4', worktreePath: path.join(h.home, 'wt', 'c4') }, h.home), false);
  } finally { h.cleanup(); }
});
