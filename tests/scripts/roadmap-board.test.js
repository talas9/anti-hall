'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', '.github', 'scripts', 'moderation');
const L = require(path.join(DIR, 'lib.js'));
const B = require(path.join(DIR, 'board.js'));
const REL = require(path.join(DIR, 'release.js'));
const { touched } = require(path.join(DIR, 'roadmap.js'));
const cfg = L.loadConfig();

test('deriveStatus: closed is Done; blocked beats in-progress beats accepted beats triage', () => {
  const d = (labels, state = 'OPEN', extra = {}) => B.deriveStatus({ labels, state, ...extra }, cfg);
  assert.equal(d(['status:triage'], 'CLOSED').status, 'Done');
  assert.equal(d([], 'OPEN', { merged: true, pr: true }).status, 'Done');
  assert.equal(d(['status:triage', 'status:in-progress']).status, 'In progress');
  assert.equal(d(['status:in-progress', 'status:blocked']).status, 'Blocked');
  assert.equal(d(['status:accepted', 'status:triage']).status, 'Accepted');
});

test('deriveStatus: an open issue with no status label is Triage and flagged; an open PR is left alone', () => {
  assert.deepEqual(B.deriveStatus({ labels: ['type:bug'], state: 'OPEN' }, cfg), { status: 'Triage', labelMissing: true });
  assert.deepEqual(B.deriveStatus({ labels: [], state: 'OPEN', pr: true }, cfg), { status: null, labelMissing: false });
});

test('progressFrom: newest trusted Done:/Left: comment, joined, capped at 80 chars, no mentions or links', () => {
  const c = (createdAt, body, association = 'OWNER', login = 'x') => ({ createdAt, body, association, login });
  const r = B.progressFrom([
    c('2026-10-01T00:00:00Z', 'Done: old'),
    c('2026-10-09T00:00:00Z', 'Some text\n**Done:** wired [the board](https://example.com/x) cc @someone\nLeft: tests'),
    c('2026-10-10T00:00:00Z', 'Done: attacker text', 'NONE', 'outsider'),
  ], cfg);
  assert.equal(r.text, 'Done: wired the board cc someone | Left: tests');
  const long = B.progressFrom([c('2026-10-09T00:00:00Z', 'Done: ' + 'x'.repeat(200))], cfg);
  assert.ok(long.text.length <= cfg.project.progress_max_chars);
  assert.equal(B.progressFrom([c('2026-10-09T00:00:00Z', 'no markers here')], cfg), null);
});

test('lastUpdate takes the latest of creation, comments, references and commits', () => {
  assert.equal(B.lastUpdate({ createdAt: '2026-10-01T00:00:00Z', comments: [{ createdAt: '2026-10-05T00:00:00Z' }], refs: ['2026-10-07T00:00:00Z'], commitDate: '2026-10-03T00:00:00Z' }), '2026-10-07T00:00:00Z');
  assert.equal(B.day('2026-10-07T12:00:00Z'), '2026-10-07');
  assert.ok(B.hoursSince('2026-10-01T00:00:00Z', Date.parse('2026-10-03T00:00:00Z')) === 48);
});

test('touched: event runs touch only their item; schedule and plain dispatch reconcile everything', () => {
  assert.deepEqual([...touched({ eventName: 'issues', payload: { issue: { number: 7 } } })], [7]);
  assert.deepEqual([...touched({ eventName: 'issue_comment', payload: { issue: { number: 8 } } })], [8]);
  assert.equal(touched({ eventName: 'schedule', payload: {} }), null);
  assert.equal(touched({ eventName: 'workflow_dispatch', payload: { inputs: { 'item-number': '' } } }), null);
  assert.deepEqual([...touched({ eventName: 'push', payload: { commits: [{ message: 'fix: a (#12)' }, { message: 'x #12 and #13' }] } })].sort(), [12, 13]);
});

test('prRules: docs drift only for a PR to main with user-facing code and no docs change', () => {
  const f = (...n) => n.map((filename) => ({ filename, additions: 1, deletions: 0 }));
  const r = (files, baseRef) => L.prRules({ title: 'feat: x', body: '', files, headRef: 'dev', sameRepo: true, baseRef }, cfg);
  assert.equal(r(f('plugins/anti-hall/hooks/guard.js'), 'main').docs_drift, true);
  assert.equal(r(f('plugins/anti-hall/hooks/guard.js'), 'dev').docs_drift, false);
  assert.equal(r(f('plugins/anti-hall/hooks/guard.js', 'CHANGELOG.md'), 'main').docs_drift, false);
  assert.equal(r(f('plugins/anti-hall/skills/x/SKILL.md', 'plugins/anti-hall/hooks/a.js'), 'main').docs_drift, false);
  assert.equal(r(f('tests/a.test.js'), 'main').docs_drift, false);
});

test('modelResult failure reason names the shape, never the text', () => {
  const r = L.modelResult({ MODEL_PROVIDER: 'copilot', MODEL_RESULT: 'Sure! here you go' }, 'digest');
  assert.equal(r.provider, 'none');
  assert.match(r.reason, /copilot output failed validation: not parseable as JSON/);
  assert.ok(!r.reason.includes('Sure'));
});

test('release docs review: rules-only drift opens one issue; an existing open one is updated in place', async () => {
  const calls = [];
  const gh = (existing) => ({
    rest: {
      search: { issuesAndPullRequests: async () => ({ data: { items: existing ? [existing] : [] } }) },
      issues: {
        listMilestones: async () => ({ data: [] }),
        create: async (a) => { calls.push(['create', a.title, a.labels]); return { data: { number: 50 } }; },
        update: async (a) => { calls.push(['update', a.issue_number]); return {}; },
      },
    },
  });
  const act = async (_d, fn) => fn();
  const state = { item: { tag: 'v1.2.3', url: 'https://github.com/talas9/anti-hall/releases/tag/v1.2.3' }, prev: 'v1.2.2', drift: { rule: true, user: ['plugins/anti-hall/hooks/a.js'], user_count: 1, docs_count: 0 } };
  const noModel = { provider: 'none', reason: 'AI_PROVIDER=none', data: null };
  const repo = { owner: 'talas9', repo: 'anti-hall' };
  assert.deepEqual(await REL.docsReview({ github: gh(null), repo, cfg, state, model: noModel, act }), { issue: 50 });
  assert.equal(calls[0][1], 'Docs review: v1.2.3');
  assert.deepEqual(await REL.docsReview({ github: gh({ number: 9, state: 'open', title: 'Docs review: v1.2.3' }), repo, cfg, state, model: noModel, act }), { issue: 9, updated: true });
  const none = await REL.docsReview({ github: gh(null), repo, cfg, state: { ...state, drift: { ...state.drift, rule: false } }, model: noModel, act });
  assert.equal(none.issue, null);
});
