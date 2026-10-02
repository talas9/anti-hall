'use strict';
// Unanswered child QUESTIONS must not nag (inbox) or block (Stop gate) when the
// asker's row is archived, held or archive-ignored, or when its eligibility is
// unknown (no row anywhere). A LIVE asker's question nags and blocks exactly as
// before, alone or mixed with the ineligible ones. All runs use an isolated HOME.

const { test } = require('node:test');
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
  for (const id of senders) if (!known.has(id)) workspaces[id] = Object.assign({}, base, { worktreePath: '/wt/' + id });
  const summary = { generatedAt: Date.now(), requiredGates: [], workspaces, recent: [] };
  if (!(opts && opts.legacy)) summary.archivedRegistryRows = [];
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify(summary));
}
function mark(home, sub, id) {
  const d = path.join(root(home), sub);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, id + '.json'), JSON.stringify({ id, worktreePath: '/wt/' + id }));
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
  archived: { prep: (h, id) => mark(h.home, 'archived', id), env: {} },
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
      assert.ok(!/bad-c/.test(c.split('DEVSWARM OWN INBOX')[1] || ''), 'archived/held/ignored asker not named in the nag');
      const r = gate(h.home, env);
      assert.ok(blocked(r), JSON.stringify(r.json));
      assert.match(r.json.reason, /live-c/);
      assert.ok(!/bad-c/.test(r.json.reason), r.json.reason);
    } finally { h.cleanup(); }
  });
}

test('unknown-only sender (no row anywhere, legacy summary): no nag, no block', () => {
  const h = makeHome();
  try {
    writeSummary(h.home, ['ghost-c'], { omitRows: ['ghost-c'], legacy: true });
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
    mark(h.home, 'archived', 'live-b'); // archived mid-loop
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
    mark(h.home, 'archived', 'live-a');
    const r = gate(h.home);
    assert.ok(!blocked(r), 'no stale block: ' + JSON.stringify(r.json));
    assert.ok(!fs.existsSync(stateFileFor('sess-q', h.home)), 'loop state cleared');
  } finally { h.cleanup(); }
});
