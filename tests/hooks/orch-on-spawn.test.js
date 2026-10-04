'use strict';
// orch-on-spawn (PreToolUse Agent|Task|Workflow): sends ORCH_FULL once per context epoch on the
// coordinator's first spawn, obeying the marker verify-first-orch.js wrote at SessionStart.
// Clock injected via ANTIHALL_TEST_NOW_MS (honoured only under ANTIHALL_TEST_ISOLATION=1).

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const T = require('../helpers/cost-trim.js');
const { fs, path, CORE, SID } = T;

const MIN = 60 * 1000;
const hook = path.join(T.PLUGIN, 'hooks', 'orch-on-spawn.js');

// Spawn delivery is opt-in (orchFullOn=spawn); arm the marker the way an opted-in session would.
const SPAWN = { env: { ANTIHALL_ORCH_FULL_ON: 'spawn' } };
function arm(h, extra) {
  T.runOrch(h, T.sessionPayload(h), extra || SPAWN);
  const m = T.markerOf(h);
  assert.strictEqual(m && m.decision, 'pending', 'armed');
  return m;
}
function spawnAt(h, nowMs, payloadExtra, envExtra) {
  return T.ctxOf(T.runSpawn(h, T.spawnPayload(h, payloadExtra), { env: Object.assign({ ANTIHALL_TEST_NOW_MS: String(nowMs) }, envExtra) }));
}
// What the harness does with a delivered hook text: a transcript line carrying it.
function recordDelivery(h, text, whenMs) {
  fs.appendFileSync(h.transcript, JSON.stringify({ type: 'attachment', timestamp: new Date(whenMs).toISOString(), attachment: { type: 'hook_additional_context', hookEvent: 'PreToolUse', content: [text] } }) + '\n');
}

test('one emit across 3 spawns 11 minutes apart (delivered copy visible in the transcript)', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    const base = m.sentAt + 1000;
    const first = spawnAt(h, base);
    assert.ok(first.startsWith(CORE.ORCH_FULL), 'ORCH_FULL text');
    assert.ok(first.includes('[anti-hall orch-full:' + m.epochId + ']'), 'epoch token');
    assert.ok(first.length <= CORE.ORCH_FULL.length + 100);
    recordDelivery(h, first, Date.now() + 1000);
    assert.strictEqual(spawnAt(h, base + 11 * MIN), '');
    assert.strictEqual(spawnAt(h, base + 22 * MIN), '');
  } finally { h.cleanup(); }
});

test('5 concurrent invocations -> exactly 1 emit (O_EXCL claim)', async () => {
  const h = T.claudeHome();
  try {
    arm(h);
    const env = { PATH: process.env.PATH, HOME: h.home, ANTIHALL_TEST_ISOLATION: '1' };
    const run = () => new Promise((resolve) => {
      const c = spawn(process.execPath, [hook], { env });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => resolve(out));
      c.stdin.end(JSON.stringify(T.spawnPayload(h)));
    });
    const outs = await Promise.all([run(), run(), run(), run(), run()]);
    assert.strictEqual(outs.filter((o) => o.includes('ORCHESTRATION DISCIPLINE')).length, 1);
  } finally { h.cleanup(); }
});

test('a new SessionStart epoch re-arms: one more emit (also with emitDedupe=false and dedupeWindowMin=0)', () => {
  for (const settings of [null, { guards: { emitDedupe: false }, context: { dedupeWindowMin: 0 } }]) {
    const h = T.claudeHome();
    try {
      if (settings) fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify(settings));
      let m = arm(h);
      const t1 = spawnAt(h, m.sentAt + 1000);
      assert.ok(t1.includes('ORCHESTRATION DISCIPLINE'));
      recordDelivery(h, t1, Date.now() + 1000);
      assert.strictEqual(spawnAt(h, m.sentAt + 5000), '');
      T.runOrch(h, T.sessionPayload(h, { source: 'compact' }), SPAWN);
      const m2 = T.markerOf(h);
      assert.notStrictEqual(m2.epochId, m.epochId);
      const t2 = spawnAt(h, m2.sentAt + 1000);
      assert.ok(t2.includes('[anti-hall orch-full:' + m2.epochId + ']'), 'second epoch delivers once more');
    } finally { h.cleanup(); }
  }
});

test('crash after the claim: a second slot opens after the 2-minute lease when no copy was delivered', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    const base = m.sentAt + 1000;
    assert.ok(spawnAt(h, base).includes('ORCHESTRATION DISCIPLINE'));
    assert.strictEqual(spawnAt(h, base + 30 * 1000), '', 'inside the lease: silent');
    assert.ok(spawnAt(h, base + 3 * MIN).includes('ORCHESTRATION DISCIPLINE'), 'retry slot after the lease');
    assert.strictEqual(spawnAt(h, base + 9 * MIN), '', 'no third slot');
  } finally { h.cleanup(); }
});

test('seen-scan ignores copies recorded before sentAt (and other epochs)', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    const base = m.sentAt + 1000;
    const first = spawnAt(h, base);
    recordDelivery(h, first, m.sentAt - 60 * 1000); // pre-sentAt timestamp: must not count
    assert.ok(spawnAt(h, base + 3 * MIN).includes('ORCHESTRATION DISCIPLINE'), 'treated as not delivered');
  } finally { h.cleanup(); }
});

test('silent for a subagent payload (agent_id / agent_type), no claim taken', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    assert.strictEqual(spawnAt(h, m.sentAt + 1000, { agent_id: 'a1', agent_type: 'general-purpose' }), '');
    assert.strictEqual(spawnAt(h, m.sentAt + 1000, { agent_type: 'Explore' }), '');
    assert.deepStrictEqual(fs.readdirSync(T.orchDir(h)).filter((n) => /claim/.test(n)), []);
    assert.ok(spawnAt(h, m.sentAt + 2000).includes('ORCHESTRATION DISCIPLINE'), 'the coordinator still gets it');
  } finally { h.cleanup(); }
});

test('a leaked CLAUDE_CODE_ENTRYPOINT=agent_tool with a main-thread payload still emits', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    assert.ok(spawnAt(h, m.sentAt + 1000, undefined, { CLAUDE_CODE_ENTRYPOINT: 'agent_tool' }).includes('ORCHESTRATION DISCIPLINE'));
  } finally { h.cleanup(); }
});

test('silent when the marker says none, is missing, or is truncated', () => {
  let h = T.claudeHome();
  try {
    T.runOrch(h, T.sessionPayload(h));
    assert.strictEqual(T.markerOf(h).decision, 'none', 'the default (auto) is session: marker none');
    assert.strictEqual(spawnAt(h, Date.now()), '', 'none');
  } finally { h.cleanup(); }
  h = T.claudeHome();
  try {
    assert.strictEqual(spawnAt(h, Date.now()), '', 'missing');
    fs.mkdirSync(T.orchDir(h), { recursive: true });
    fs.writeFileSync(path.join(T.orchDir(h), 'orch-full-' + SID + '.json'), '{"epochId":"17');
    assert.strictEqual(spawnAt(h, Date.now()), '', 'truncated');
    assert.deepStrictEqual(fs.readdirSync(T.orchDir(h)).filter((n) => /claim/.test(n)), []);
  } finally { h.cleanup(); }
});

test('orchestration off: the setting turned off after SessionStart, or off at SessionStart -> no emit', () => {
  let h = T.claudeHome();
  try {
    const m = arm(h);
    fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ context: { verifyFirstOrchestration: false } }));
    assert.strictEqual(spawnAt(h, m.sentAt + 1000), '');
  } finally { h.cleanup(); }
  h = T.claudeHome();
  try {
    fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ context: { verifyFirstOrchestration: false } }));
    testHookOff(h);
    assert.strictEqual(spawnAt(h, Date.now()), '');
  } finally { h.cleanup(); }
});
function testHookOff(h) { T.runOrch(h, T.sessionPayload(h), { expectJson: false }); }

test('skip.json entry for orch-on-spawn -> no emit; expired entry -> emits', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    h.writeSkip({ 'orch-on-spawn': Date.now() + 600000 });
    assert.strictEqual(spawnAt(h, m.sentAt + 1000), '');
    h.writeSkip({ 'orch-on-spawn': Date.now() - 1000 });
    assert.ok(spawnAt(h, m.sentAt + 2000).includes('ORCHESTRATION DISCIPLINE'));
  } finally { h.cleanup(); }
});

test('Workflow spawns count as coordinator spawns; other tools are ignored', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    assert.strictEqual(spawnAt(h, m.sentAt + 1000, { tool_name: 'Bash' }), '');
    assert.ok(spawnAt(h, m.sentAt + 2000, { tool_name: 'Workflow' }).includes('ORCHESTRATION DISCIPLINE'));
  } finally { h.cleanup(); }
});

test('seen-scan: a >12 MB transcript with the delivered copy far outside the window never causes a second send', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    const base = m.sentAt + 1000;
    const first = spawnAt(h, base);
    recordDelivery(h, first, Date.now() + 1000);
    const filler = JSON.stringify({ type: 'user', timestamp: new Date(Date.now() + 2000).toISOString(), message: { role: 'user', content: 'x'.repeat(100000) } }) + '\n';
    for (let i = 0; i < 130; i++) fs.appendFileSync(h.transcript, filler); // ~13 MB after the copy
    assert.ok(fs.statSync(h.transcript).size > 12 * 1024 * 1024);
    assert.strictEqual(spawnAt(h, base + 3 * MIN), '', 'unknown window -> silent, not a retry');
    assert.strictEqual(spawnAt(h, base + 11 * MIN), '');
    assert.deepStrictEqual(fs.readdirSync(T.orchDir(h)).filter((n) => /claim2/.test(n)), [], 'no second slot taken');
  } finally { h.cleanup(); }
});

test('seen-scan counts only the delivered hook_additional_context form, not a hook_success stdout record', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    const base = m.sentAt + 1000;
    const first = spawnAt(h, base);
    fs.appendFileSync(h.transcript, JSON.stringify({ type: 'attachment', timestamp: new Date(Date.now() + 1000).toISOString(), attachment: { type: 'hook_success', hookName: 'PreToolUse', stdout: first } }) + '\n');
    assert.ok(spawnAt(h, base + 3 * MIN).includes('ORCHESTRATION DISCIPLINE'), 'emitted-but-not-delivered -> retry slot');
  } finally { h.cleanup(); }
});

test('protocolLevel=full set mid-epoch: orch-on-spawn stays silent (full adds no channel)', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    assert.strictEqual(spawnAt(h, m.sentAt + 1000, undefined, { ANTIHALL_PROTOCOL_LEVEL: 'full' }), '');
  } finally { h.cleanup(); }
});

test('a stale pending marker is cleared by a later NOT-confident SessionStart of the same session id', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    T.runOrch(h, T.sessionPayload(h), { noFlag: true });
    assert.strictEqual(T.markerOf(h).decision, 'none');
    assert.strictEqual(spawnAt(h, m.sentAt + 1000), '');
  } finally { h.cleanup(); }
});

test('spawn read touches the marker (a live session is not pruned) and tmp files are prunable names', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    const f = path.join(T.orchDir(h), 'orch-full-' + SID + '.json');
    const old = Date.now() / 1000 - 6 * 24 * 3600;
    fs.utimesSync(f, old, old);
    spawnAt(h, m.sentAt + 1000);
    assert.ok(Date.now() - fs.statSync(f).mtimeMs < 60000, 'mtime refreshed');
    const tmpName = 'orch-full-' + SID + '.123.abcd.tmp.json'; // the writeMarker temp name shape
    assert.ok(/^orch-full-/.test(tmpName) && tmpName.endsWith('.json'), 'prunable by pruneStale');
  } finally { h.cleanup(); }
});

test('a PostToolUse-shaped call echoes its own event name (registration-agnostic)', () => {
  const h = T.claudeHome();
  try {
    const m = arm(h);
    const r = T.runSpawn(h, T.spawnPayload(h, { hook_event_name: 'PostToolUse', tool_response: {} }), { env: { ANTIHALL_TEST_NOW_MS: String(m.sentAt + 1000) } });
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  } finally { h.cleanup(); }
});

test('fail-open: empty / malformed stdin exits 0 silently', () => {
  const h = T.claudeHome();
  try {
    const { testHookRaw } = require('../helpers/spawn-hook.js');
    for (const raw of ['', '{bad', 'null']) {
      const r = testHookRaw('orch-on-spawn.js', raw, { home: h.home });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout, '');
    }
  } finally { h.cleanup(); }
});

test('state-prune: SessionStart prunes old orch-full markers and claims, keeps its own', () => {
  const h = T.claudeHome();
  try {
    const dir = T.orchDir(h);
    fs.mkdirSync(dir, { recursive: true });
    const old = ['orch-full-other.json', 'orch-full-other-1700000000000-claim.json', 'orch-full-other-1700000000000-claim2.json'];
    const stale = Date.now() / 1000 - 8 * 24 * 3600;
    for (const n of old) { fs.writeFileSync(path.join(dir, n), '{}'); fs.utimesSync(path.join(dir, n), stale, stale); }
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');
    T.runOrch(h, T.sessionPayload(h));
    const left = fs.readdirSync(dir);
    for (const n of old) assert.ok(!left.includes(n), n + ' pruned');
    assert.ok(left.includes('orch-full-' + SID + '.json'), 'own marker kept');
    assert.ok(left.includes('unrelated.txt'), 'foreign files untouched');
  } finally { h.cleanup(); }
});

test('hooks.json: matcher resolves Agent, Task and Workflow (and not Bash) on the PreToolUse event; node flags present', () => {
  const j = JSON.parse(fs.readFileSync(path.join(T.PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const found = [];
  for (const [ev, groups] of Object.entries(j)) for (const g of groups) for (const x of g.hooks) if (/orch-on-spawn\.js/.test(x.command)) found.push({ ev, matcher: g.matcher, command: x.command });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].ev, 'PreToolUse');
  const re = new RegExp('^(?:' + found[0].matcher + ')$');
  for (const n of ['Agent', 'Task', 'Workflow']) assert.ok(re.test(n), n);
  assert.ok(!re.test('Bash'));
  assert.ok(/--no-concurrent-recompilation --no-concurrent-sparkplug/.test(found[0].command));
});
