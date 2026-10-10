'use strict';
// Unit tests for the sticky bot-comment helper in .github/scripts/moderation/lib.js: create once,
// then edit in place, never a duplicate; legacy markers are migrated; no network.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const DIR = path.resolve(__dirname, '..', '..', '.github', 'scripts', 'moderation');
const L = require(path.join(DIR, 'lib.js'));
const SEC = require(path.join(DIR, 'security-alerts.js'));
const DELIVERED = require(path.join(DIR, 'delivered.js'));

// In-memory thread behind the same io contract the REST and discussion adapters implement.
function thread(initial = []) {
  const comments = initial.map((body, i) => ({ id: i + 1, body, updated_at: '2026-01-01T00:00:00Z' }));
  const calls = { create: 0, update: 0 };
  return {
    comments, calls,
    list: async () => comments.map((c) => ({ ...c })),
    create: async (body) => { calls.create++; comments.push({ id: comments.length + 1, body, updated_at: 'now' }); },
    update: async (id, body) => { calls.update++; comments.find((c) => c.id === id).body = body; },
  };
}

test('first call creates one comment carrying the ah-bot marker', async () => {
  const io = thread();
  const r = await L.upsertSticky({ io, purpose: 'triage-brief', body: 'hello' });
  assert.equal(r.action, 'created');
  assert.equal(io.comments.length, 1);
  assert.ok(io.comments[0].body.startsWith('<!-- ah-bot:triage-brief -->\n'));
  assert.ok(!/Updated/.test(io.comments[0].body), 'no footer on the first post');
});

test('second call with new content edits the same comment and adds an Updated footer', async () => {
  const io = thread();
  await L.upsertSticky({ io, purpose: 'pr-check', body: 'v1', now: Date.parse('2026-10-10T00:00:00Z') });
  const r = await L.upsertSticky({ io, purpose: 'pr-check', body: 'v2', now: Date.parse('2026-10-11T12:00:00Z') });
  assert.equal(r.action, 'updated');
  assert.equal(io.comments.length, 1);
  assert.deepEqual(io.calls, { create: 1, update: 1 });
  assert.match(io.comments[0].body, /v2/);
  assert.match(io.comments[0].body, /<sub>Updated 2026-10-11<\/sub>\s*$/);
});

test('same content again is a no-op (no write, footer from an earlier edit is not content)', async () => {
  const io = thread();
  await L.upsertSticky({ io, purpose: 'qa-answer', body: 'a' });
  await L.upsertSticky({ io, purpose: 'qa-answer', body: 'b', now: Date.parse('2026-10-11T00:00:00Z') });
  const r = await L.upsertSticky({ io, purpose: 'qa-answer', body: 'b', now: Date.parse('2026-10-12T00:00:00Z') });
  assert.equal(r.action, 'unchanged');
  assert.deepEqual(io.calls, { create: 1, update: 1 });
  assert.equal(io.comments[0].body.match(/Updated/g).length, 1, 'footer never stacks');
});

test('many runs never produce a second comment', async () => {
  const io = thread();
  for (let i = 0; i < 6; i++) await L.upsertSticky({ io, purpose: 'stale-nudge', body: `run ${i}` });
  assert.equal(io.comments.length, 1);
  assert.equal(io.calls.create, 1);
});

test('purposes are independent: each gets its own comment', async () => {
  const io = thread();
  await L.upsertSticky({ io, purpose: 'triage-brief', body: 'brief' });
  await L.upsertSticky({ io, purpose: 'moderation-request', body: 'please edit' });
  await L.upsertSticky({ io, purpose: 'triage-brief', body: 'brief 2' });
  assert.equal(io.comments.length, 2);
});

test('a comment written by the earlier automation (legacy marker) is migrated in place', async () => {
  const io = thread(['<!-- ai-pr-triage -->\nold pr summary']);
  const r = await L.upsertSticky({ io, purpose: 'pr-check', body: 'new pr summary' });
  assert.equal(r.action, 'updated');
  assert.equal(io.comments.length, 1);
  assert.ok(io.comments[0].body.startsWith('<!-- ah-bot:pr-check -->'));
  assert.ok(!io.comments[0].body.includes('ai-pr-triage'));
});

test('if an earlier bug left duplicates, the oldest is edited and nothing new is posted', async () => {
  const io = thread(['<!-- ah-bot:qa-answer -->\none', '<!-- ah-bot:qa-answer -->\ntwo']);
  await L.upsertSticky({ io, purpose: 'qa-answer', body: 'fresh' });
  assert.equal(io.calls.create, 0);
  assert.match(io.comments[0].body, /fresh/);
  assert.match(io.comments[1].body, /two/);
});

test('the dry-run wrapper sees the write and nothing is written when it declines', async () => {
  const io = thread();
  const seen = [];
  await L.upsertSticky({ io, purpose: 'delivered-on-dev', body: 'x', act: async (d) => { seen.push(d); return null; } });
  assert.deepEqual(seen, [{ type: 'comment', purpose: 'delivered-on-dev' }]);
  assert.equal(io.comments.length, 0);
});

test('unknown purposes are rejected; a marker in the body is not doubled', async () => {
  await assert.rejects(L.upsertSticky({ io: thread(), purpose: 'chatter', body: 'x' }), /unknown bot comment purpose/);
  assert.equal(L.stickyCore('pr-check', '<!-- ah-bot:pr-check -->\nbody').match(/ah-bot:pr-check/g).length, 1);
});

test('every purpose named by the owner rules exists', () => {
  for (const p of ['triage-brief', 'qa-answer', 'pr-check', 'stale-nudge', 'security-alert', 'delivered-on-dev', 'docs-review', 'moderation-request']) {
    assert.ok(L.PURPOSES.includes(p), p);
  }
});

test('REST adapter lists only the Actions bot comments and writes through createComment/updateComment', async () => {
  const store = [
    { id: 1, user: { login: 'someone' }, body: '<!-- ah-bot:qa-answer -->\nfake', updated_at: 't' },
    { id: 2, user: { login: 'github-actions[bot]' }, body: '<!-- ah-bot:qa-answer -->\nreal', updated_at: 't' },
  ];
  const log = [];
  const github = { paginate: async () => store, rest: { issues: {
    listComments: {},
    createComment: async (a) => log.push(['create', a]),
    updateComment: async (a) => log.push(['update', a]),
  } } };
  const io = L.restSticky(github, { owner: 'o', repo: 'r' }, 7);
  await L.upsertSticky({ io, purpose: 'qa-answer', body: 'newer' });
  assert.equal(log.length, 1);
  assert.equal(log[0][0], 'update');
  assert.equal(log[0][1].comment_id, 2, 'a stranger cannot hijack the sticky with the marker');
});

test('security alert issue body: marker present, unchanged body is not re-edited, changes carry the footer', () => {
  const al = { source: 'code-scanning', number: 5, url: 'u', level: 'high', title: 'T', detail: 'a:1' };
  const want = SEC.render(al);
  assert.ok(want.body.includes('<!-- ah-bot:security-alert -->'));
  const have = { number: 9, state: 'open', title: want.title, body: want.body, labels: want.labels };
  assert.deepEqual(SEC.plan([al], [have]), []);
  const footed = { ...have, body: L.withUpdatedFooter(want.body, Date.parse('2026-10-10T00:00:00Z')) };
  assert.deepEqual(SEC.plan([al], [footed]), [], 'footer is not content');
  const out = SEC.plan([{ ...al, detail: 'b:2' }], [footed], 20, Date.parse('2026-10-11T00:00:00Z'));
  assert.equal(out.length, 1);
  assert.match(out[0].body, /<sub>Updated 2026-10-11<\/sub>/);
});

test('delivered-on-dev: a comment with the new marker for the same PR stops a repeat', () => {
  const pr = [{ number: 88, body: 'Closes #5', merge_commit_sha: 'abcdef1234567' }];
  const body = DELIVERED.plan(pr, () => ({ state: 'open', comments: [] }))[0].body;
  assert.ok(!body.includes('<!--'), 'marker is added by the upsert, not the text');
  const posted = L.stickyCore('delivered-on-dev', body);
  assert.deepEqual(DELIVERED.plan(pr, () => ({ state: 'open', comments: [posted] })), []);
});

test('no moderation script or workflow posts a comment except through the upsert helpers', () => {
  const fs = require('node:fs');
  const gh = path.resolve(__dirname, '..', '..', '.github');
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== 'lib.js').map((f) => path.join(DIR, f))
    .concat(fs.readdirSync(path.join(gh, 'workflows')).filter((f) => f.endsWith('.yml') && f !== 'dependabot-merge.yml').map((f) => path.join(gh, 'workflows', f)));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/createComment|addDiscussionComment|gh issue comment|gh pr comment/.test(src.replace(/addDiscussionComment\(input:\{discussionId/g, '')), `${path.basename(f)} posts a comment outside the upsert`);
  }
});
