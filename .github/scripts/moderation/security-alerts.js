'use strict';
// Security alerts -> issues. GitHub Actions cannot trigger on code-scanning, Dependabot or secret-scanning
// alerts, so the scheduled roadmap job lists them and keeps ONE issue per alert (dedup by a hidden
// marker holding source and alert number). Rules only, no model. Never closes anything and never
// prints a secret value.

const L = require('./lib.js');

const SOURCES = ['code-scanning', 'dependabot', 'secret-scanning'];
const LEVELS = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABELS = { critical: 'severity:critical', high: 'severity:high', medium: 'severity:medium', low: 'severity:low' };
const LABEL_COLORS = { 'severity:critical': 'b60205', 'severity:high': 'd93f0b', 'severity:medium': 'fbca04', 'severity:low': '0e8a16', security: 'b60205' };
const MAX_CREATES = 20;

const marker = (source, number) => `<!-- security-alert:${source}:${number} -->`;
const markerRe = /<!-- security-alert:(code-scanning|dependabot|secret-scanning):(\d+) -->/;

function level(raw) {
  const s = String(raw || '').toLowerCase();
  if (LEVELS.includes(s)) return s;
  if (s === 'error') return 'high';
  if (s === 'warning' || s === 'moderate') return 'medium';
  return 'low';
}

// One shape for the three alert APIs.
function normalize(source, a) {
  if (source === 'code-scanning') {
    const loc = (a.most_recent_instance && a.most_recent_instance.location) || {};
    return { source, number: a.number, url: a.html_url, level: level(a.rule && (a.rule.security_severity_level || a.rule.severity)), title: (a.rule && (a.rule.description || a.rule.id)) || 'code-scanning alert', detail: loc.path ? `${loc.path}:${loc.start_line || 1}` : '' };
  }
  if (source === 'dependabot') {
    const adv = a.security_advisory || {};
    const pkg = a.dependency && a.dependency.package && a.dependency.package.name;
    return { source, number: a.number, url: a.html_url, level: level(adv.severity), title: adv.summary || 'dependency alert', detail: pkg || '' };
  }
  return { source, number: a.number, url: a.html_url, level: 'high', title: a.secret_type_display_name || a.secret_type || 'secret-scanning alert', detail: '' };
}

const clip = (s, n) => String(s).replace(/\s+/g, ' ').slice(0, n);

function render(al) {
  return {
    title: `Security alert (${al.source} #${al.number}): ${clip(al.title, 90)}`,
    body: [marker(al.source, al.number), L.botMarker('security-alert'), '',
      `| Source | Alert | Severity | Where |`, `|---|---|---|---|`,
      `| ${al.source} | [#${al.number}](${al.url}) | ${al.level} | ${clip(al.detail, 120) || '-'} |`, '',
      'Opened and kept in sync by the scheduled roadmap job (rules only). The alert stays the source of truth; this issue closes by hand once the alert is fixed or dismissed.'].join('\n'),
    labels: ['security', SEVERITY_LABELS[al.level]],
  };
}

// Pure dedup: alerts + existing issues -> actions. An issue counts for an alert when its body carries the marker.
function plan(alerts, issues, max = MAX_CREATES, now) {
  const byKey = new Map();
  for (const i of issues) {
    const m = markerRe.exec(i.body || '');
    if (!m) continue;
    const k = `${m[1]}:${m[2]}`;
    const prev = byKey.get(k);
    if (!prev || (prev.state !== 'open' && i.state === 'open')) byKey.set(k, i);
  }
  const out = [];
  const seen = new Set();
  let creates = 0;
  for (const al of alerts) {
    const k = `${al.source}:${al.number}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const want = render(al);
    const have = byKey.get(k);
    if (!have) { if (creates < max) { out.push({ type: 'create', key: k, ...want }); creates++; } continue; }
    if (have.state !== 'open') continue; // closed by a person: leave it alone, never duplicate
    const labels = (have.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
    const missing = want.labels.filter((l) => !labels.includes(l));
    // a severity change swaps the severity label; title/body are refreshed only when they differ
    const stale = labels.filter((l) => l.startsWith('severity:') && !want.labels.includes(l));
    if (missing.length || stale.length || have.title !== want.title || L.stripFooter(have.body) !== want.body.trim()) out.push({ type: 'update', key: k, number: have.number, ...want, body: L.withUpdatedFooter(want.body, now), remove: stale });
  }
  return out;
}

async function ensureLabels(github, repo, names) {
  for (const name of names) {
    try { await github.rest.issues.createLabel({ ...repo, name, color: LABEL_COLORS[name] || 'ededed' }); } catch { /* exists or no permission */ }
  }
}

async function list(github, wide, repo, errors) {
  const calls = {
    'code-scanning': () => github.paginate('GET /repos/{owner}/{repo}/code-scanning/alerts', { ...repo, state: 'open', per_page: 100 }),
    dependabot: () => wide.paginate('GET /repos/{owner}/{repo}/dependabot/alerts', { ...repo, state: 'open', per_page: 100 }),
    'secret-scanning': () => wide.paginate('GET /repos/{owner}/{repo}/secret-scanning/alerts', { ...repo, state: 'open', per_page: 100 }),
  };
  const all = [];
  for (const s of SOURCES) {
    try { for (const a of await calls[s]()) all.push(normalize(s, a)); } catch (e) { errors.push(`${s}: ${e.status || e.message}`); }
  }
  return all;
}

// act(desc, fn) is the caller's dry-run/fail-open wrapper.
// `wide` is a client with alert-read scopes for Dependabot and secret scanning (GITHUB_TOKEN cannot read them).
async function sync({ github, wide, repo, act, errors }) {
  const alerts = await list(github, wide || github, repo, errors);
  if (!alerts.length) return { alerts: 0, actions: 0 };
  const issues = (await github.paginate(github.rest.issues.listForRepo, { ...repo, state: 'all', labels: 'security', per_page: 100 })).filter((i) => !i.pull_request);
  const todo = plan(alerts, issues);
  if (todo.length) await ensureLabels(github, repo, ['security', ...LEVELS.map((l) => SEVERITY_LABELS[l])]);
  for (const t of todo) {
    if (t.type === 'create') await act({ type: 'security-issue-create', key: t.key }, () => github.rest.issues.create({ ...repo, title: t.title, body: t.body, labels: t.labels }));
    else {
      await act({ type: 'security-issue-update', key: t.key, number: t.number }, () => github.rest.issues.update({ ...repo, issue_number: t.number, title: t.title, body: t.body }));
      if (t.labels.length) await act({ type: 'security-label', key: t.key }, () => github.rest.issues.addLabels({ ...repo, issue_number: t.number, labels: t.labels }));
      for (const r of t.remove) await act({ type: 'security-label-remove', key: t.key }, () => github.rest.issues.removeLabel({ ...repo, issue_number: t.number, name: r }));
    }
  }
  return { alerts: alerts.length, actions: todo.length };
}

module.exports = { normalize, plan, render, marker, sync, level };
