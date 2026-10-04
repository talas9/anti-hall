'use strict';
// Unanswered child QUESTIONS must not nag (inbox) or block (Stop gate) when the
// asker's row is archived, held or archive-ignored, or when its eligibility is
// unknown (no row anywhere). A LIVE asker's question nags and blocks exactly as
// before, alone or mixed with the ineligible ones. All runs use an isolated HOME.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { stateFileFor } = require('../../plugins/anti-hall/companion/lib/devswarm-gate-state.js');

const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const OWN_ID = 'primary-' + installIngest.worktreeHash(REPO_CWD);

function root(home) { return path.join(home, '.anti-hall', 'devswarm'); }
function writeSummary(home, senders, opts) {
  const dir = path.join(root(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const ts = Date.now() - 5 * 60000;
  const base = { total: 0, cursor: 0, unread: 0, directUnread: 0, broadcastUnread: 0, urgencyMax: null, gates: {}, archive_ready: false };
  const workspaces = {
    [OWN_ID]: Object.assign({}, base, {
      worktreePath: REPO_CWD, total: senders.length, cursor: senders.length, unread: 0, directUnread: 0,
      pendingQuestions: senders.map((id, i) => ({ from: id, ts: ts - i * 1000, seq: i + 1 })),
    }),
  };
  const known = (opts && opts.omitRows) ? new Set(opts.omitRows) : new Set();
  for (const id of senders) if (!known.has(id)) workspaces[id] = Object.assign({}, base, { worktreePath: '/wt/' + id, sessionId: 'sess-' + id });
  const summary = { generatedAt: Date.now(), requiredGates: [], workspaces, recent: [] };
  if (!(opts && opts.legacy)) summary.archivedRegistryRows = [];
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify(summary));
}
function mark(home, sub, id) {
  const d = path.join(root(home), sub);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify({ id, worktreePath: '/wt/' + id }));
}
// ~/.claude/sessions/<x>.json maps a sessionId to a pid: a live one (this
// process) proves the session is running, a dead one proves it is not.
function deadPid() { return spawnSync(process.execPath, ['-e', '0']).pid; }
function session(home, id, alive) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ pid: alive ? process.pid : deadPid(), sessionId: 'sess-' + id, cwd: home, startedAt: Date.now() }));
}
function gate(home, env, sid) {
  return testHookRaw('devswarm-parent-gate.js', JSON.stringify({ hook_event_name: 'Stop', session_id: sid || 'sess-q', cwd: REPO_CWD }),
    { home, env: Object.assign({}, PRIMARY_ENV, env || {}) });
}
function inboxText(home, env) {
  const r = testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD },
    { home, env: Object.assign({}, PRIMARY_ENV, env || {}), expectJson: true });
  assert.strictEqual(r.status, 0);
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
const blocked = (r) => !!(r.json && r.json.decision === 'block');
const QUESTION_NAG = /UNANSWERED|unanswered QUESTION|DECIDE|QUESTIONS AWAITING/;

// Each case: how to make the sender 'bad' + the env that goes with it.
const BAD = {
  archived: { prep: (h, id) => { mark(h.home, 'archived', id); session(h.home, id, false); }, env: {} },
  held: { prep: () => {}, env: (id) => ({ ANTIHALL_DEVSWARM_HELD_PARTITIONS: id }) },
  ignored: { prep: (h, id) => mark(h.home, 'archive-ignore', id), env: {} },
};
const envOf = (b, id) => (typeof b.env === 'function' ? b.env(id) : b.env);

for (const kind of Object.keys(BAD)) {
  test(kind + '-only sender: no inbox nag and no Stop block', () => {
    const h = makeHome();
    try {
      writeSummary(h.home, ['bad-c']);
      BAD[kind].prep(h, 'bad-c');
      const env = envOf(BAD[kind], 'bad-c');
      assert.ok(!QUESTION_NAG.test(inboxText(h.home, env)), 'inbox must not nag about the question');
      const r = gate(h.home, env);
      assert.ok(!blocked(r), 'gate must not block: ' + JSON.stringify(r.json));
    } finally { h.cleanup(); }
  });

  test(kind + ' mixed with a LIVE sender: only the live one nags and blocks', () => {
    const h = makeHome();
    try {
      writeSummary(h.home, ['bad-c', 'live-c']);
      BAD[kind].prep(h, 'bad-c');
      const env = envOf(BAD[kind], 'bad-c');
      const c = inboxText(h.home, env);
      assert.match(c, /1 remain UNANSWERED — from live-c\b/, c);
      assert.ok(!/bad-c/.test(c.split('devswarm-own-inbox')[1] || ''), 'archived/held/ignored asker not named in the nag');
      const r = gate(h.home, env);
      assert.ok(blocked(r), JSON.stringify(r.json));
      assert.match(r.json.reason, /live-c/);
      assert.ok(!/bad-c/.test(r.json.reason), r.json.reason);
    } finally { h.cleanup(); }
  });
}

test('unknown-only sender (no row anywhere, FRESH summary): retired -> no nag, no block', () => {
  const h = makeHome();
  try {
    writeSummary(h.home, ['ghost-c'], { omitRows: ['ghost-c'] });
    assert.ok(!QUESTION_NAG.test(inboxText(h.home)));
    assert.ok(!blocked(gate(h.home)));
  } finally { h.cleanup(); }
});

test('LIVE sender alone: nags and blocks exactly as before', () => {
  const h = makeHome();
  try {
    writeSummary(h.home, ['live-c']);
    const c = inboxText(h.home);
    assert.match(c, /1 remain UNANSWERED — from live-c\b/, c);
    assert.match(c, /QUESTIONS AWAITING YOUR REPLY: 1/);
    const r = gate(h.home);
    assert.ok(blocked(r));
    assert.match(r.json.reason, /UNANSWERED QUESTION/);
    assert.match(r.json.reason, /live-c/);
  } finally { h.cleanup(); }
});

test('gate cap/signature: a sender archived mid-loop shrinks the set; blocking stays bounded and ends with no stale block', () => {
  const h = makeHome();
  try {
    writeSummary(h.home, ['live-a', 'live-b']);
    assert.ok(blocked(gate(h.home)), 'pass 1 blocks on both');
    const s1 = JSON.parse(fs.readFileSync(stateFileFor('sess-q', h.home), 'utf8'));
    mark(h.home, 'archived', 'live-b'); session(h.home, 'live-b', false); // archived mid-loop
    let n = 0; let last = null;
    for (let i = 0; i < 14; i++) {
      last = gate(h.home);
      if (!blocked(last)) break;
      assert.match(last.json.reason, /live-a/);
      assert.ok(!/live-b/.test(last.json.reason), 'archived sender no longer named');
      n++;
    }
    assert.ok(n >= 1, 'live-a still blocks after live-b is archived');
    assert.ok(n <= 12, 'blocking is bounded by the existing ceiling, got ' + n);
    const s2 = JSON.parse(fs.readFileSync(stateFileFor('sess-q', h.home), 'utf8'));
    assert.notStrictEqual(s2.qSig, s1.qSig, 'signature follows the filtered set');
    // last live sender archived too -> nothing blocks, loop-state cleared
    mark(h.home, 'archived', 'live-a'); session(h.home, 'live-a', false);
    const r = gate(h.home);
    assert.ok(!blocked(r), 'no stale block: ' + JSON.stringify(r.json));
    assert.ok(!fs.existsSync(stateFileFor('sess-q', h.home)), 'loop state cleared');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Case table: ONE question from child c1, judged by the Stop gate, the per-turn
// nag and the "QUESTIONS AWAITING YOUR REPLY" line. Every row must give the
// SAME answer on all three, a live asker is always kept (archived-but-live
// included), and archived-and-dead / held / ignored are always dropped.
// ---------------------------------------------------------------------------
function descriptor(home, id) {
  const d = path.join(root(home), 'workspaces');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify({ id, worktreePath: '/wt/' + id, sessionId: 'sess-' + id }));
}
const CASES = [
  { name: 'row live', keep: true, prep: (h) => { writeSummary(h.home, ['c1']); session(h.home, 'c1', true); } },
  { name: 'row archived (not live)', keep: false, prep: (h) => { writeSummary(h.home, ['c1']); mark(h.home, 'archived', 'c1'); session(h.home, 'c1', false); } },
  { name: 'row archived + live (archived-but-live)', keep: true, prep: (h) => { writeSummary(h.home, ['c1']); mark(h.home, 'archived', 'c1'); session(h.home, 'c1', true); } },
  { name: 'row held (live)', keep: false, env: { ANTIHALL_DEVSWARM_HELD_PARTITIONS: 'c1' }, prep: (h) => { writeSummary(h.home, ['c1']); session(h.home, 'c1', true); } },
  { name: 'row ignored (live)', keep: false, prep: (h) => { writeSummary(h.home, ['c1']); mark(h.home, 'archive-ignore', 'c1'); session(h.home, 'c1', true); } },
  { name: 'no row + active descriptor', keep: true, prep: (h) => { writeSummary(h.home, ['c1'], { omitRows: ['c1'] }); descriptor(h.home, 'c1'); session(h.home, 'c1', true); } },
  { name: 'no row + active descriptor + legacy summary', keep: true, prep: (h) => { writeSummary(h.home, ['c1'], { omitRows: ['c1'], legacy: true }); descriptor(h.home, 'c1'); session(h.home, 'c1', true); } },
  { name: 'no row, no descriptor, fresh summary', keep: false, prep: (h) => writeSummary(h.home, ['c1'], { omitRows: ['c1'] }) },
  { name: 'no row, no descriptor, legacy summary', keep: true, prep: (h) => writeSummary(h.home, ['c1'], { omitRows: ['c1'], legacy: true }) },
  { name: 'store unreadable (question not visible)', keep: false, prep: (h) => { writeSummary(h.home, ['c1']); fs.writeFileSync(path.join(root(h.home), 'summaries', REPO_KEY + '.json'), '{not json'); } },
];
for (const c of CASES) {
  test('case table: ' + c.name + ' -> ' + (c.keep ? 'KEEP' : 'DROP') + ' on gate, nag and awaiting line alike', () => {
    const h = makeHome();
    try {
      c.prep(h);
      const text = inboxText(h.home, c.env);
      const g = gate(h.home, c.env);
      const gateQ = blocked(g) && /UNANSWERED QUESTION/.test(g.json.reason) && /c1\b/.test(g.json.reason);
      const nag = /1 remain UNANSWERED — from c1\b/.test(text);
      const awaiting = /QUESTIONS AWAITING YOUR REPLY: 1/.test(text);
      const got = { gateQ, nag, awaiting };
      assert.deepStrictEqual(got, { gateQ: c.keep, nag: c.keep, awaiting: c.keep }, JSON.stringify(got) + '\n' + text + '\n' + JSON.stringify(g.json));
    } finally { h.cleanup(); }
  });
}
