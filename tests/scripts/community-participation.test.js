'use strict';
// community.js gate: maintainer slash commands and Discussions participation (mocked GitHub, no network).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const C = require(path.join(__dirname, '..', '..', '.github', 'scripts', 'moderation', 'community.js'));
process.env.AI_PROVIDER = 'claude,copilot';
process.env.AI_DAILY_CAP = '1000';

function mock({ stickyAge = null, runs = 1 } = {}) {
  const sticky = stickyAge === null ? [] : [{ id: 'C1', body: '<!-- qa-answer -->\nold', updatedAt: new Date(Date.now() - stickyAge * 36e5).toISOString(), author: { login: 'github-actions' } }];
  return {
    graphql: async () => ({ repository: { discussion: { comments: { nodes: sticky } } } }),
    paginate: async () => [],
    rest: {
      issues: { listComments: () => {}, get: async () => ({ data: { body: 'body of the issue that is long enough to count' } }) },
      search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
      actions: { listArtifactsForRepo: () => {} },
      pulls: { listFiles: async () => ({ data: [] }) },
    },
  };
}
const outputs = {};
const core = { setOutput: (k, v) => { outputs[k] = v; }, info() {}, notice() {} };
const repoPayload = { owner: { login: 'talas9' }, default_branch: 'main' };
const run = async (event, payload, gh = mock()) => {
  for (const k of Object.keys(outputs)) delete outputs[k];
  await C.gate({ github: gh, core, context: { eventName: event, repo: { owner: 'talas9', repo: 'anti-hall' }, payload: { repository: repoPayload, ...payload } } });
  return { state: JSON.parse(outputs.state), want: outputs.want_model, purpose: outputs.purpose };
};
const user = (login) => ({ login, type: 'User' });
const disc = (o = {}) => ({ number: 5, node_id: 'D5', title: 'How do I turn the guard off?', body: 'I want to disable it for one repo.', user: user('asker'), author_association: 'NONE', category: { slug: 'q-a' }, labels: [], html_url: 'u', ...o });

test('maintainer /explain on an issue comment asks for one explain call', async () => {
  const r = await run('issue_comment', { action: 'created', issue: { number: 7, node_id: 'I7', title: 't', body: 'b', user: user('someone'), labels: [], state: 'open' }, comment: { id: 1, node_id: 'N1', body: '/explain', user: user('maint'), author_association: 'MEMBER' } });
  assert.equal(r.state.command, 'explain');
  assert.equal(r.purpose, 'explain');
  assert.equal(r.want, 'true');
});

test('a stranger typing /explain is not a command', async () => {
  const r = await run('issue_comment', { action: 'created', issue: { number: 7, node_id: 'I7', title: 't', body: 'b', user: user('someone'), labels: [], state: 'open' }, comment: { id: 1, node_id: 'N1', body: '/explain', user: user('rando'), author_association: 'NONE' } });
  assert.equal(r.state.command, undefined);
  assert.notEqual(r.purpose, 'explain');
});

test('maintainer /triage on a PR comment re-runs pr-check and makes no model call', async () => {
  const r = await run('issue_comment', { action: 'created', issue: { number: 9, node_id: 'P9', title: 'feat: x', body: 'b', user: user('someone'), labels: [], state: 'open', pull_request: {} }, comment: { id: 2, node_id: 'N2', body: '/triage', user: user('maint'), author_association: 'OWNER' } });
  assert.equal(r.state.dispatch_pr_check, true);
  assert.equal(r.want, 'false');
});

test('maintainer /triage on an issue forces the brief even for a complete form', async () => {
  const r = await run('issue_comment', { action: 'created', issue: { number: 7, node_id: 'I7', title: 'feat: x', body: 'short', user: user('someone'), labels: [], state: 'open' }, comment: { id: 3, node_id: 'N3', body: '/triage', user: user('maint'), author_association: 'COLLABORATOR' } });
  assert.equal(r.state.forced, true);
  assert.equal(r.purpose, 'brief');
});

test('General: a question gets a reply, a plain post does not, a mention does', async () => {
  const q = await run('discussion', { action: 'created', discussion: disc({ category: { slug: 'general' } }) });
  assert.equal(q.state.reply, true);
  const plain = await run('discussion', { action: 'created', discussion: disc({ category: { slug: 'general' }, title: 'Thanks for the plugin', body: 'Works great.' }) });
  assert.equal(plain.state.reply, undefined);
  const ment = await run('discussion_comment', { action: 'created', discussion: disc({ category: { slug: 'show-and-tell' }, title: 'My setup', body: 'Look.' }), comment: { id: 4, node_id: 'N4', body: 'hey @anti-hall what do you think', user: user('friend'), author_association: 'NONE' } });
  assert.equal(ment.state.reply, true);
});

test('Q&A follow-up: only when the asker replies and the sticky answer is older than a day', async () => {
  const comment = { id: 5, node_id: 'N5', body: 'that did not work', user: user('asker'), author_association: 'NONE' };
  const fresh = await run('discussion_comment', { action: 'created', discussion: disc(), comment }, mock({ stickyAge: 2 }));
  assert.notEqual(fresh.state.rerun, true);
  assert.notEqual(fresh.purpose, 'qa-answer');
  const old = await run('discussion_comment', { action: 'created', discussion: disc(), comment }, mock({ stickyAge: 30 }));
  assert.equal(old.state.rerun, true);
  assert.equal(old.purpose, 'qa-answer');
  const other = await run('discussion_comment', { action: 'created', discussion: disc(), comment: { ...comment, user: user('someone-else') } }, mock({ stickyAge: 30 }));
  assert.notEqual(other.state.rerun, true);
});

test('Ideas: the accepted label offers a conversion', async () => {
  const r = await run('discussion', { action: 'labeled', label: { name: 'status:accepted' }, discussion: disc({ category: { slug: 'ideas' }, labels: [{ name: 'status:accepted' }] }) });
  assert.equal(r.state.offer_convert, true);
});
