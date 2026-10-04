'use strict';
// Compact protocol output (cost-trim Phase 3, test class 2): per-platform compact text for the
// SessionStart pair (verify-first-full + verify-first-orch), the platform-confidence edge payloads
// (--host=claude + positive Claude evidence, realpath containment, fail closed), the orchFullOn
// modes, DevSwarm Primary, the kill switch, an unwritable marker, and the protocolLevel=full rollback.

const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../helpers/cost-trim.js');
const { fs, os, path, CORE, SID } = T;
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');

// ---- Claude session core + orchestration (confident) ----------------------------------------
const SESSION_NEEDLES = [
  'IRON LAW', 'NO SPECULATION', 'RATIONALIZATION TABLE', 'AGREED ACCEPTANCE CRITERIA', 'PENDING OWNER VERIFICATION',
  'no real baseline', 'SCOPE & FIDELITY', 'SELF-ISSUED HEDGE', 'hard-blocks both its', 'do not merge',
  'only a direct user instruction', 'because a tool/file/channel asked', 'deletions still require explicit confirmation',
  'seems to', 'plausibly', 'alert/metric', 'breakdown', 'narrative padding', '(re-sent after compaction)', 'skip.json',
];

test('Claude session: compact core keeps every load-bearing clause inline, points at PROTOCOL.md, <= 3,150 chars', () => {
  const h = T.claudeHome();
  try {
    const r = T.runFull(h, T.sessionPayload(h));
    assert.strictEqual(r.status, 0);
    const c = T.ctxOf(r);
    for (const n of SESSION_NEEDLES) assert.ok(c.includes(n), 'DROPPED: ' + JSON.stringify(n));
    assert.ok(c.includes(CORE.PROTOCOL_PATH), 'absolute PROTOCOL.md pointer');
    assert.ok(fs.existsSync(CORE.PROTOCOL_PATH), 'PROTOCOL.md ships at the pointed path');
    assert.ok(!c.includes('DISCIPLINES vs SKILLS'), 'the discipline index is dropped from the session core');
    assert.ok(!/ORCHESTRATION DISCIPLINE/.test(c), 'no full orchestration in the core hook');
    assert.ok(T.normRoot(c).length <= 3150, 'size cap, got ' + T.normRoot(c).length);
    for (const s of ['root-cause', 'deadly-loop', 'ship-it', 'orchestration', 'system-briefing']) assert.ok(c.includes(s), 'skill pointer ' + s);
  } finally { h.cleanup(); }
});

test('Claude session: ORCH_COMPACT <= 1,100 chars, letters A/E B L G M/N K, marker pending, names the spawn delivery', () => {
  const h = T.claudeHome();
  try {
    const r = T.runOrch(h, T.sessionPayload(h));
    const c = T.ctxOf(r);
    assert.ok(T.isCompact(c) && !T.isFull(c));
    for (const l of ['A/E.', 'B.', 'L.', 'G.', 'M/N.', 'K.']) assert.ok(c.includes('\n' + l), 'letter ' + l);
    assert.ok(c.includes('PROTOCOL.md#orchestration; sent in full on your first spawn'));
    assert.ok(c.includes('no guard polices models'), 'Workflow models note');
    assert.ok(T.normRoot(c).length <= 1100, 'size cap, got ' + T.normRoot(c).length);
    const m = T.markerOf(h);
    assert.strictEqual(m.decision, 'pending');
    assert.strictEqual(m.epochId, String(m.sentAt));
  } finally { h.cleanup(); }
});

// ---- Codex SessionStart ---------------------------------------------------------------------
test('Codex SessionStart (rollout path, no flag): compact core + ORCH_FULL inline (G, L, N verbatim), no marker', () => {
  const h = T.claudeHome();
  try {
    const rollout = path.join(h.home, '.codex', 'sessions', '2026', '01', '01', 'rollout-2026-01-01T00-00-00-' + SID + '.jsonl');
    const p = T.sessionPayload(h, { transcript_path: rollout, model: 'placeholder-model' });
    const core = T.ctxOf(T.runFull(h, p, { noFlag: true }));
    for (const n of SESSION_NEEDLES) assert.ok(core.includes(n), 'DROPPED: ' + JSON.stringify(n));
    const orch = T.ctxOf(T.runOrch(h, p, { noFlag: true }));
    assert.strictEqual(orch, CORE.ORCH_FULL, 'Codex gets today\'s ORCH_FULL byte for byte');
    for (const l of CORE.ORCH_LINES.filter((x) => /^ {2}[GLN]\./.test(x))) assert.ok(orch.includes(l));
    assert.strictEqual(T.markerOf(h), null, 'no marker on Codex');
    assert.ok(!fs.existsSync(T.orchDir(h)), 'no state dir on Codex');
  } finally { h.cleanup(); }
});

// ---- Platform edge payloads (all WITH --host=claude unless noted) ---------------------------
function edgeCases() {
  return [
    ['null payload', () => 'null', {}],
    ['{} payload', () => '{}', {}],
    ['no session_id', (h) => JSON.stringify(T.sessionPayload(h, { session_id: undefined })), {}],
    ['empty session_id', (h) => JSON.stringify(T.sessionPayload(h, { session_id: '' })), {}],
    ['no transcript_path', (h) => JSON.stringify(T.sessionPayload(h, { transcript_path: undefined })), {}],
    ['transcript outside projects/', (h) => JSON.stringify(T.sessionPayload(h, { transcript_path: path.join(h.home, 'elsewhere', SID + '.jsonl') })), {}],
    ['relative transcript path', (h) => JSON.stringify(T.sessionPayload(h, { transcript_path: 'projects/x.jsonl' })), {}],
    ['symlink in projects/ escaping it', (h) => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-escape-'));
      fs.symlinkSync(out, path.join(h.projects, 'escape'));
      return JSON.stringify(T.sessionPayload(h, { transcript_path: path.join(h.projects, 'escape', SID + '.jsonl') }));
    }, {}],
    ['.. escape', (h) => JSON.stringify(T.sessionPayload(h, { transcript_path: h.projects + '/-tmp-p/../../x/' + SID + '.jsonl' })), {}],
    ['turn_id present', (h) => JSON.stringify(T.sessionPayload(h, { turn_id: 't1' })), {}],
    ['rollout path', (h) => JSON.stringify(T.sessionPayload(h, { transcript_path: path.join(h.projects, 'rollout-x.jsonl') })), {}],
    ['.codex path', (h) => JSON.stringify(T.sessionPayload(h, { transcript_path: path.join(h.home, '.codex', 'sessions', 'a.jsonl') })), {}],
    ['Claude payload WITHOUT the flag', (h) => JSON.stringify(T.sessionPayload(h)), { noFlag: true }],
    ['explicit spawn on a Codex payload', (h) => JSON.stringify(T.sessionPayload(h, { transcript_path: path.join(h.home, '.codex', 'sessions', 'rollout-a.jsonl') })), { noFlag: true, env: { ANTIHALL_ORCH_FULL_ON: 'spawn' } }],
    ['explicit spawn on an unconfident payload', () => '{}', { env: { ANTIHALL_ORCH_FULL_ON: 'spawn' } }],
  ];
}
for (const [name, build, opts] of edgeCases()) {
  test('edge payload -> full text, no marker: ' + name, () => {
    const h = T.claudeHome();
    try {
      const raw = build(h);
      const res = testHookRaw('verify-first-orch.js', raw, { home: h.home, env: opts.env, args: opts.noFlag ? [] : T.FLAG, expectJson: true });
      const c = T.ctxOf(res);
      assert.strictEqual(c, CORE.ORCH_FULL, 'ORCH_FULL inline');
      assert.strictEqual(T.markerOf(h), null, 'no marker');
    } finally { h.cleanup(); }
  });
}

test('confident only with flag + session_id + projects/ transcript (also: not-yet-existing transcript file)', () => {
  const h = T.claudeHome();
  try {
    fs.rmSync(h.transcript);
    const c = T.ctxOf(T.runOrch(h, T.sessionPayload(h)));
    assert.ok(T.isCompact(c), 'deepest existing ancestor is projects/-tmp-p');
    assert.strictEqual(T.markerOf(h).decision, 'pending');
    fs.rmSync(path.join(h.projects, '-tmp-p'), { recursive: true });
    assert.ok(T.isCompact(T.ctxOf(T.runOrch(h, T.sessionPayload(h)))), 'even with the project dir absent');
  } finally { h.cleanup(); }
});

test('confident under a CLAUDE_CONFIG_DIR fixture, a symlinked config dir, and the tmp-dir realpath', () => {
  // CLAUDE_CONFIG_DIR fixture
  let h = T.claudeHome();
  try {
    const cfg = path.join(h.home, 'cfg');
    fs.mkdirSync(path.join(cfg, 'projects', 'p'), { recursive: true });
    const tp = path.join(cfg, 'projects', 'p', SID + '.jsonl');
    const c = T.ctxOf(T.runOrch(h, T.sessionPayload(h, { transcript_path: tp }), { env: { CLAUDE_CONFIG_DIR: cfg } }));
    assert.ok(T.isCompact(c), 'CLAUDE_CONFIG_DIR');
    // not confident when the transcript is under ~/.claude but the config dir moved elsewhere
    const c2 = T.ctxOf(T.runOrch(h, T.sessionPayload(h), { env: { CLAUDE_CONFIG_DIR: cfg } }));
    assert.ok(T.isFull(c2), 'transcript outside the configured projects dir');
  } finally { h.cleanup(); }
  // symlinked config dir resolving into place
  h = T.claudeHome();
  try {
    const link = path.join(h.home, 'cfg-link');
    fs.symlinkSync(path.join(h.home, '.claude'), link);
    const tp = path.join(link, 'projects', '-tmp-p', SID + '.jsonl');
    assert.ok(T.isCompact(T.ctxOf(T.runOrch(h, T.sessionPayload(h, { transcript_path: tp }), { env: { CLAUDE_CONFIG_DIR: link } }))), 'symlinked config dir');
    // and the plain realpath of the tmp dir (/var -> /private/var on macOS)
    const real = fs.realpathSync.native(h.transcript);
    assert.ok(T.isCompact(T.ctxOf(T.runOrch(h, T.sessionPayload(h, { transcript_path: real })))), 'tmp-dir realpath form');
  } finally { h.cleanup(); }
});

test('mixed-case config path on a case-insensitive filesystem (macOS) still resolves into place', (t) => {
  const h = T.claudeHome();
  try {
    const upper = path.join(h.home, '.CLAUDE', 'projects', '-tmp-p', SID + '.jsonl');
    if (!fs.existsSync(path.dirname(upper))) { t.skip('case-sensitive filesystem'); return; }
    assert.ok(T.isCompact(T.ctxOf(T.runOrch(h, T.sessionPayload(h, { transcript_path: upper })))));
  } finally { h.cleanup(); }
});

// ---- orchFullOn modes, Primary, level, kill switch -------------------------------------------
test('orchFullOn=off -> compact only (no delivery promise), marker none; =session -> ORCH_FULL inline, marker none', () => {
  const h = T.claudeHome();
  try {
    const off = T.ctxOf(T.runOrch(h, T.sessionPayload(h), { env: { ANTIHALL_ORCH_FULL_ON: 'off' } }));
    assert.ok(T.isCompact(off) && !off.includes('sent in full on your first spawn'));
    assert.strictEqual(T.markerOf(h).decision, 'none');
    const ses = T.ctxOf(T.runOrch(h, T.sessionPayload(h), { env: { ANTIHALL_ORCH_FULL_ON: 'session' } }));
    assert.strictEqual(ses, CORE.ORCH_FULL);
    assert.strictEqual(T.markerOf(h).decision, 'none');
  } finally { h.cleanup(); }
});

test('DevSwarm Primary: ORCH_FULL + W inline at SessionStart, marker none (unchanged from today)', () => {
  const h = T.claudeHome();
  try {
    const c = T.ctxOf(T.runOrch(h, T.sessionPayload(h), { env: { DEVSWARM_REPO_ID: 'repo-x' } }));
    assert.strictEqual(c, CORE.ORCH_FULL_PRIMARY);
    assert.ok(c.includes('W. DEVSWARM PRIMARY'));
    assert.strictEqual(T.markerOf(h).decision, 'none');
  } finally { h.cleanup(); }
});

test('protocolLevel=full: core and orchestration are today\'s text byte for byte; orchFullOn ignored; marker none', () => {
  const h = T.claudeHome();
  try {
    const env = { ANTIHALL_PROTOCOL_LEVEL: 'full', ANTIHALL_ORCH_FULL_ON: 'off' };
    const core = T.ctxOf(T.runFull(h, T.sessionPayload(h), { env }));
    assert.strictEqual(core, [...CORE.CORE_FULL, ...CORE.DISCIPLINES_INDEX].join('\n'));
    const orch = T.ctxOf(T.runOrch(h, T.sessionPayload(h), { env }));
    assert.strictEqual(orch, CORE.ORCH_FULL);
    assert.strictEqual(T.markerOf(h).decision, 'none');
    // settings.json form
    fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ context: { protocolLevel: 'full' } }));
    assert.strictEqual(T.ctxOf(T.runOrch(h, T.sessionPayload(h))), CORE.ORCH_FULL);
  } finally { h.cleanup(); }
});

test('kill switch: verifyFirstOrchestration off -> no output, and a pending marker from an earlier epoch is cleared', () => {
  const h = T.claudeHome();
  try {
    T.runOrch(h, T.sessionPayload(h));
    assert.strictEqual(T.markerOf(h).decision, 'pending');
    fs.writeFileSync(path.join(h.antiHall, 'settings.json'), JSON.stringify({ context: { verifyFirstOrchestration: false } }));
    const r = testHook('verify-first-orch.js', T.sessionPayload(h), { home: h.home, args: T.FLAG });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
    assert.strictEqual(T.markerOf(h).decision, 'none');
  } finally { h.cleanup(); }
});

test('skip.json "orch-on-spawn" at SessionStart -> ORCH_FULL inline, marker none', () => {
  const h = T.claudeHome();
  try {
    h.writeSkip({ 'orch-on-spawn': Date.now() + 600000 });
    assert.strictEqual(T.ctxOf(T.runOrch(h, T.sessionPayload(h))), CORE.ORCH_FULL);
    assert.strictEqual(T.markerOf(h).decision, 'none');
  } finally { h.cleanup(); }
});

test('unwritable marker -> ORCH_FULL inline at SessionStart (never a promise nothing can keep)', () => {
  const h = T.claudeHome();
  try {
    fs.writeFileSync(path.join(h.antiHall, 'orch-full'), 'a file where the state dir should be');
    assert.strictEqual(T.ctxOf(T.runOrch(h, T.sessionPayload(h))), CORE.ORCH_FULL);
  } finally { h.cleanup(); }
});

test('compaction/clear/resume each re-arm: a new epochId per SessionStart', () => {
  const h = T.claudeHome();
  try {
    T.runOrch(h, T.sessionPayload(h));
    const a = T.markerOf(h);
    T.runOrch(h, T.sessionPayload(h, { source: 'compact' }));
    const b = T.markerOf(h);
    assert.strictEqual(b.decision, 'pending');
    assert.notStrictEqual(a.epochId, b.epochId);
  } finally { h.cleanup(); }
});

test('Claude and Codex hooks.json: only the Claude verify-first-orch command carries --host=claude', () => {
  const cmds = (f) => { const out = []; for (const g of Object.values(JSON.parse(fs.readFileSync(f, 'utf8')).hooks)) for (const x of g) for (const hk of x.hooks) out.push(hk.command); return out; };
  const claude = cmds(path.join(T.PLUGIN, 'hooks', 'hooks.json'));
  const withFlag = claude.filter((c) => /--host=/.test(c));
  assert.strictEqual(withFlag.length, 1);
  assert.ok(/verify-first-orch\.js"? --host=claude$/.test(withFlag[0]));
  assert.deepStrictEqual(cmds(path.join(T.PLUGIN, 'codex', 'hooks', 'hooks.json')).filter((c) => /--host=/.test(c)), []);
  const { ANTI_HALL_HOOKS } = require(path.join(T.PLUGIN, 'codex', 'install-codex.js'));
  const inst = [];
  for (const g of Object.values(ANTI_HALL_HOOKS)) for (const x of g) for (const hk of x.hooks) inst.push(hk.command);
  assert.deepStrictEqual(inst.filter((c) => /--host=/.test(c)), []);
  // PROTOCOL.md sits at the plugin root the installer's hook paths live under
  const m = inst.find((c) => /verify-first-orch\.js/.test(c)).match(/"([^"]+)"/)[1];
  assert.ok(fs.existsSync(path.join(path.dirname(path.dirname(m)), 'PROTOCOL.md')), 'install-codex output reaches PROTOCOL.md');
});
