'use strict';
// context.codexOrchFullOn=spawn (experimental, opt-in): on a positively identified Codex session
// SessionStart sends the compact core + compact orchestration lines and orch-on-spawn.js sends the
// Codex-worded ORCH_FULL once per epoch on the first spawn_agent. Default (session) is unchanged.

const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../helpers/cost-trim.js');
const { fs, path, CORE, SID } = T;

const SPAWN = { noFlag: true, env: { ANTIHALL_CODEX_ORCH_FULL_ON: 'spawn' } };

function codexHome() {
  const h = T.claudeHome();
  const dir = path.join(h.home, '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  h.rollout = path.join(dir, 'rollout-2026-01-01T00-00-00-' + SID + '.jsonl');
  fs.writeFileSync(h.rollout, '');
  return h;
}
const start = (h) => T.sessionPayload(h, { transcript_path: h.rollout, model: 'placeholder-model' });
const spawnP = (h, extra) => T.spawnPayload(h, Object.assign({ tool_name: 'collaborationspawn_agent', turn_id: 'turn-1', transcript_path: h.rollout }, extra || {}));
const spawnCtx = (h, extra) => T.ctxOf(T.runSpawn(h, spawnP(h, extra)));

test('spawn mode: compact at start, full exactly once on the first spawn_agent, none on the second', () => {
  const h = codexHome();
  try {
    const orch = T.ctxOf(T.runOrch(h, start(h), SPAWN));
    assert.ok(T.isCompact(orch) && !T.isFull(orch), 'compact orchestration at SessionStart');
    assert.ok(orch.includes('sent in full on your first spawn'));
    assert.ok(orch.length < CORE.ORCH_FULL_CODEX.length / 2);
    const m = T.markerOf(h);
    assert.strictEqual(m && m.decision, 'pending');
    const first = spawnCtx(h);
    assert.ok(first.startsWith(CORE.ORCH_FULL_CODEX), 'Codex-worded ORCH_FULL');
    assert.ok(first.includes('[anti-hall orch-full:' + m.epochId + ']'));
    assert.strictEqual(spawnCtx(h), '', 'second spawn is silent');
  } finally { h.cleanup(); }
});

test('spawn mode: a non-spawn tool and a subagent payload stay silent', () => {
  const h = codexHome();
  try {
    T.runOrch(h, start(h), SPAWN);
    assert.strictEqual(spawnCtx(h, { tool_name: 'apply_patch' }), '');
    assert.strictEqual(spawnCtx(h, { tool_name: 'collaborationwait_agent' }), '');
    assert.strictEqual(spawnCtx(h, { agent_id: 'a1', agent_type: 'worker' }), '');
    assert.ok(spawnCtx(h).startsWith(CORE.ORCH_FULL_CODEX), 'the coordinator spawn still gets it');
  } finally { h.cleanup(); }
});

test('default (session) and unset: ORCH_FULL_CODEX inline, no marker, silent spawn', () => {
  const h = codexHome();
  try {
    for (const env of [{}, { ANTIHALL_CODEX_ORCH_FULL_ON: 'session' }]) {
      assert.strictEqual(T.ctxOf(T.runOrch(h, start(h), { noFlag: true, env })), CORE.ORCH_FULL_CODEX);
      assert.strictEqual(T.markerOf(h), null);
      assert.strictEqual(spawnCtx(h), '');
    }
  } finally { h.cleanup(); }
});

test('spawn mode is ignored under protocolLevel=full, orchFullOn=off keeps compact-only, and a non-Codex payload is unaffected', () => {
  const h = codexHome();
  try {
    const full = T.ctxOf(T.runOrch(h, start(h), { noFlag: true, env: { ANTIHALL_CODEX_ORCH_FULL_ON: 'spawn', ANTIHALL_PROTOCOL_LEVEL: 'full' } }));
    assert.strictEqual(full, CORE.ORCH_FULL_CODEX);
    const off = T.ctxOf(T.runOrch(h, start(h), { noFlag: true, env: { ANTIHALL_CODEX_ORCH_FULL_ON: 'spawn', ANTIHALL_ORCH_FULL_ON: 'off' } }));
    assert.ok(T.isCompact(off) && !off.includes('first spawn'));
    // No Codex evidence (Claude-shaped payload, no flag): session text, no marker.
    const plain = T.ctxOf(T.runOrch(h, T.sessionPayload(h), { noFlag: true, env: { ANTIHALL_CODEX_ORCH_FULL_ON: 'spawn' } }));
    assert.strictEqual(plain, CORE.ORCH_FULL);
  } finally { h.cleanup(); }
});

test('a new epoch (compaction/resume) re-arms the marker and delivers once more; Codex rollout developer message counts as seen', () => {
  const h = codexHome();
  try {
    T.runOrch(h, start(h), SPAWN);
    assert.ok(spawnCtx(h).startsWith(CORE.ORCH_FULL_CODEX));
    const m2 = (() => { T.runOrch(h, start(h), SPAWN); return T.markerOf(h); })();
    assert.strictEqual(m2.decision, 'pending');
    assert.ok(spawnCtx(h).startsWith(CORE.ORCH_FULL_CODEX), 'second epoch delivers again');
    const state = require(path.join(T.PLUGIN, 'hooks', 'lib', 'orch-full-state.js'));
    const line = { timestamp: new Date(Date.now() + 1000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x ' + state.tokenFor(m2.epochId) }] } };
    fs.appendFileSync(h.rollout, JSON.stringify(line) + '\n');
    assert.strictEqual(state.seen(h.rollout, m2.epochId, m2.sentAt), true);
  } finally { h.cleanup(); }
});

test('Codex registrations: orch-on-spawn only on the spawn_agent matcher (template + installer)', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(T.PLUGIN, 'codex', 'hooks', 'hooks.registry.json'), 'utf8')).hooks;
  const { ANTI_HALL_HOOKS } = require(path.join(T.PLUGIN, 'codex', 'install-codex.js'));
  for (const groups of [tpl.PreToolUse, ANTI_HALL_HOOKS.PreToolUse]) {
    const hits = groups.filter((g) => g.hooks.some((x) => /orch-on-spawn\.js/.test(x.command)));
    assert.deepStrictEqual(hits.map((g) => g.matcher), ['^(?:collaboration)?spawn_agent$']);
    const re = new RegExp(hits[0].matcher);
    assert.ok(re.test('collaborationspawn_agent') && re.test('spawn_agent') && !re.test('collaborationwait_agent'));
  }
});
