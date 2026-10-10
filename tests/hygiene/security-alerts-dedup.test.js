'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SEC = require('../../.github/scripts/moderation/security-alerts.js');

const cs = (n, sev = 'high') => SEC.normalize('code-scanning', { number: n, html_url: `u/${n}`, rule: { id: 'r', description: 'Rule', security_severity_level: sev }, most_recent_instance: { location: { path: 'a.js', start_line: 3 } } });
const issueFor = (al, extra = {}) => { const r = SEC.render(al); return { number: 100 + al.number, state: 'open', title: r.title, body: r.body, labels: r.labels, ...extra }; };

test('normalize maps severities from each source', () => {
  assert.equal(cs(1, 'critical').level, 'critical');
  assert.equal(SEC.normalize('code-scanning', { number: 2, rule: { severity: 'warning' } }).level, 'medium');
  assert.equal(SEC.normalize('dependabot', { number: 3, security_advisory: { severity: 'moderate', summary: 's' }, dependency: { package: { name: 'p' } } }).level, 'medium');
  assert.equal(SEC.normalize('secret-scanning', { number: 4, secret_type: 'x' }).level, 'high');
});

test('new alerts create one issue each, labelled security + severity', () => {
  const out = SEC.plan([cs(1), cs(2, 'low')], []);
  assert.deepEqual(out.map((o) => o.type), ['create', 'create']);
  assert.deepEqual(out[1].labels, ['security', 'severity:low']);
  assert.ok(out[0].body.includes('<!-- security-alert:code-scanning:1 -->'));
});

test('an alert with an up-to-date open issue produces no action (dedup)', () => {
  const a = cs(1);
  assert.deepEqual(SEC.plan([a, a], [issueFor(a)]), []);
});

test('same number in another source is a different alert', () => {
  const a = cs(1);
  const d = SEC.normalize('dependabot', { number: 1, security_advisory: { severity: 'high', summary: 's' } });
  const out = SEC.plan([a, d], [issueFor(a)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'dependabot:1');
});

test('a closed issue is never duplicated or reopened', () => {
  const a = cs(1);
  assert.deepEqual(SEC.plan([a], [issueFor(a, { state: 'closed' })]), []);
});

test('severity change updates the issue and swaps the severity label', () => {
  const old = cs(1, 'medium');
  const out = SEC.plan([cs(1, 'high')], [issueFor(old)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'update');
  assert.deepEqual(out[0].remove, ['severity:medium']);
});

test('creates are capped per run', () => {
  const alerts = Array.from({ length: 30 }, (_, i) => cs(i + 1));
  assert.equal(SEC.plan(alerts, []).length, 20);
});
