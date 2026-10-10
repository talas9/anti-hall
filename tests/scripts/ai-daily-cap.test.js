'use strict';
// lib.budget counts model calls (ai-call marker artifacts), not workflow runs.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const L = require(path.join(__dirname, '..', '..', '.github', 'scripts', 'moderation', 'lib.js'));

const today = new Date().toISOString();
const yesterday = new Date(Date.now() - 36e5 * 48).toISOString();
const ctx = { repo: { owner: 'o', repo: 'r' } };
const gh = (arts, boom) => ({
  paginate: async () => { if (boom) throw Object.assign(new Error('x'), { status: 500 }); return arts; },
  rest: { actions: { listArtifactsForRepo: () => {}, listWorkflowRuns: () => { throw new Error('runs must not be counted'); } } },
});

test('budget counts only today\'s model-call markers for this workflow', async () => {
  const arts = [
    { name: 'ai-call-community.yml-1-1', created_at: today },
    { name: 'ai-call-community.yml-2-1', created_at: today },
    { name: 'ai-call-community.yml-3-1', created_at: yesterday },
    { name: 'ai-call-community.yml-4-1', created_at: today, expired: true },
    { name: 'ai-call-roadmap.yml-5-1', created_at: today },
    { name: 'unrelated', created_at: today },
  ];
  assert.deepStrictEqual(await L.budget(gh(arts), ctx, 'community.yml', 3), { ok: true, used: 2, cap: 3 });
  assert.strictEqual((await L.budget(gh(arts), ctx, 'community.yml', 2)).ok, false);
});

test('budget fails closed on an API error', async () => {
  const b = await L.budget(gh([], true), ctx, 'community.yml', 5);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.used, -1);
});

test('ai-model.yml records a marker only when a slot answered', () => {
  const y = require('node:fs').readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'ai-model.yml'), 'utf8');
  assert.match(y, /provider != 'none'/);
  assert.match(y, /ai-call-\$\{wf\}-/);
});
