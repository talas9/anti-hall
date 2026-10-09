'use strict';
// GitHub closes "Closes #n" issues only for PRs merged into the default branch (main). Work merges
// into dev first, so the roadmap job closes those issues once the PR is merged into dev.
// Idempotent: the comment is an upsert (ah-bot:delivered-on-dev) and the issue state stops repeats.

const L = require('./lib.js');

const KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+([\w.-]+\/[\w.-]+)?#(\d+)/gi;

const marker = (pr) => `<!-- delivered-on-dev:#${pr} -->`;

// Issue numbers a PR body closes (same-repo only; deduped).
function closes(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(KEYWORD)) if (!m[1]) out.add(Number(m[2])); // same-repo only
  return [...out];
}

const comment = (pr, sha) => `Delivered on dev in #${pr} (${String(sha).slice(0, 8)}); ships to main with the next release.`;

// prs: [{number, body, merge_commit_sha}] merged into dev. issueState(n) -> {state, comments:[bodies]} | null
function plan(prs, issueState) {
  const out = [], seen = new Set();
  for (const pr of prs) {
    for (const n of closes(pr.body)) {
      if (seen.has(n) || n === pr.number) continue;
      const st = issueState(n);
      if (!st || st.state !== 'open' || st.pull_request) continue;
      if ((st.comments || []).some((c) => c.includes(marker(pr.number)) || (L.hasMarker('delivered-on-dev', c) && c.includes(`in #${pr.number} (`)))) continue;
      seen.add(n);
      out.push({ issue: n, pr: pr.number, body: comment(pr.number, pr.merge_commit_sha) });
    }
  }
  return out;
}

// Merged-into-dev PRs from the last `days` days, closing at most `max` issues per run.
async function run({ github, repo, act, days = 7, max = 20, base = 'dev' }) {
  const since = Date.now() - days * 864e5;
  const prs = (await github.rest.pulls.list({ ...repo, state: 'closed', base, sort: 'updated', direction: 'desc', per_page: 50 })).data
    .filter((p) => p.merged_at && new Date(p.merged_at) > since);
  const cache = new Map();
  const todo = [];
  for (const n of new Set(prs.flatMap((p) => closes(p.body)))) {
    try {
      const i = (await github.rest.issues.get({ ...repo, issue_number: n })).data;
      const cs = i.state === 'open' ? (await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: n, per_page: 100 })).map((c) => c.body || '') : [];
      cache.set(n, { state: i.state, pull_request: !!i.pull_request, comments: cs });
    } catch { /* missing or foreign issue */ }
  }
  for (const t of plan(prs, (n) => cache.get(n) || null).slice(0, max)) {
    await act({ type: 'deliver-close', issue: t.issue, pr: t.pr }, async () => {
      await L.upsertSticky({ io: L.restSticky(github, repo, t.issue), purpose: 'delivered-on-dev', body: t.body });
      await github.rest.issues.update({ ...repo, issue_number: t.issue, state: 'closed', state_reason: 'completed' });
    });
    todo.push(t.issue);
  }
  return todo;
}

module.exports = { closes, plan, run, marker };
